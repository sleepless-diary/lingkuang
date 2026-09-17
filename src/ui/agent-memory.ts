/** 灵框 · 助手的长期记忆（偏好，用户 2026-09-15：「有记忆，能总结创作者的偏好等」）
 *
 *  存哪儿：`%APPDATA%\lingkuang\agent\memory.json`（测试跟着 `LINGKUANG_TEST_DATA` 走），
 *  一个**裸数组** `[{ id, text, at, src }]` —— 与 chat.json 同一层。
 *  为什么不用 localStorage：这是创作者资产（"助手记住了我什么"），要能像 vault 一样备份、查看、手改。
 *
 *  记忆怎么来的：① 创作者手动加 / 手改（`src === 'manual'`）；② 点「从对话里总结」，
 *  让模型读最近的对话、吐出几条稳定偏好（`src === 'auto'`）。两条路都会去重（按去掉空白标点的正文比）。
 *
 *  ⚠️ 记忆是**喂进系统提示**的（`memoryPrompt()`），不是塞进对话历史 ——
 *  历史会被 `HISTORY_SEND` 截断，而偏好必须每一次提问都在。
 */
import { uid } from '../store/ids';
import type { ChatMsg } from './ai';
import { agentAsk } from './agent-model';

export interface MemoryItem {
  id: string;
  text: string;
  at: number;
  /** manual = 人手写/手改；auto = 从对话里总结出来的 */
  src: 'auto' | 'manual';
}

/** 最多记多少条（再多就成了一份没人看的笔记，反而稀释提示词） */
const MEM_MAX = 60;
/** 单条最长（一句话偏好，不是一段话） */
const TEXT_MAX = 90;
/** 一次总结最多收几条 */
const SUM_MAX = 8;
/** 总结时回看多少条对话 */
const SUM_LOOKBACK = 24;

let items: MemoryItem[] = [];
let sink: (() => void) | null = null;

export function getMemory(): MemoryItem[] {
  return items;
}

/** 落盘回调：记忆模块自己不碰 IPC —— `chat` 与 `memory` 是**同一次整包写**（`agent:save`），
 *  由 `src/ui/agent.ts` 注册，它手里才有完整的历史。 */
export function setMemorySink(fn: (() => void) | null): void {
  sink = fn;
}

/** 去空白与标点后的正文，用来判重（「不要用现代词」与「不要 用现代词。」算同一条） */
export function normText(s: string): string {
  return s.replace(/[\s，。、,.;；:：!！?？"'“”‘’()（）【】[\]—-]/g, '').toLowerCase();
}

function clean(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX) : '';
}

function asItem(raw: any): MemoryItem | null {
  const text = clean(raw?.text);
  if (!text) return null;
  return {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : uid('m'),
    text,
    at: typeof raw?.at === 'number' ? raw.at : Date.now(),
    src: raw?.src === 'auto' ? 'auto' : 'manual',
  };
}

/** 把磁盘上的内容（可能被人手改坏了）收成一份能用的记忆；返回收好的列表。 */
export function adoptFromDisk(raw: unknown): MemoryItem[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: MemoryItem[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    const it = asItem(r);
    if (!it) continue;
    const k = normText(it.text);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
    if (out.length >= MEM_MAX) break;
  }
  items = out;
  return items;
}

/** 记一条。已经记过（正文同）返回 null。 */
export function addMemory(text: string, src: 'auto' | 'manual' = 'manual'): MemoryItem | null {
  const t = clean(text);
  if (!t) return null;
  const k = normText(t);
  if (items.some((i) => normText(i.text) === k)) return null;
  if (items.length >= MEM_MAX) items.shift();
  const it: MemoryItem = { id: uid('m'), text: t, at: Date.now(), src };
  items.push(it);
  sink?.();
  return it;
}

/** 手改一条。清空＝删掉；改过之后它算「人写的」，之后总结不会再当成自动条目反复覆盖。 */
export function updateMemory(id: string, text: string): void {
  const it = items.find((i) => i.id === id);
  if (!it) return;
  const t = clean(text);
  if (!t) {
    removeMemory(id);
    return;
  }
  if (it.text === t) return;
  it.text = t;
  it.src = 'manual';
  sink?.();
}

export function removeMemory(id: string): void {
  const n = items.length;
  items = items.filter((i) => i.id !== id);
  if (items.length !== n) sink?.();
}

/* ── 从对话里总结偏好 ─────────────────────────────────────────────── */
const SUM_SYS = [
  '你在帮「灵框」（世界观创作工作台）的创作者整理**长期偏好**。下面是你俩最近的对话。',
  '请读出创作者**反复表现出的稳定偏好**：想要什么、不要什么、习惯怎么命名、在意哪些细节、讨厌哪种写法。',
  '不要记这一次的具体请求（那是一次性的），也不要把助手说的话当成创作者的偏好。',
  '只输出一个 JSON 字符串数组，每项是一句不超过 20 字的短句（如「人名偏好两三个字」「不喜欢大段解释」），最多 8 项；',
  '看不出稳定偏好就输出 []。除了这个数组不要输出任何别的字。',
].join('\n');

/** 从模型输出里抠出偏好条目：能容忍代码栏、前后废话、多余空格。 */
export function parsePrefs(raw: string): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  const s = raw.replace(/```[a-zA-Z]*/g, '');
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(s.slice(a, b + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    const t = clean(v);
    if (!t) continue;
    const k = normText(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= SUM_MAX) break;
  }
  return out;
}

/** 让模型读最近的对话，吐出候选偏好（**不落盘**，由调用方决定收哪几条） */
export async function summarizePrefs(history: ChatMsg[]): Promise<string[]> {
  const recent = history.filter((m) => m.role !== 'system').slice(-SUM_LOOKBACK);
  if (!recent.length) return [];
  const lines = recent.map((m) => (m.role === 'user' ? '创作者：' : '助手：') + m.content).join('\n');
  const r = await agentAsk(
    [{ role: 'system', content: SUM_SYS }, { role: 'user', content: lines }],
    { temperature: 0.2, numPredict: 400 },
  );
  return parsePrefs(r.text);
}

/** 拼进系统提示的那一段（空记忆返回空串）。**每次提问都带**，不靠对话历史。 */
export function memoryPrompt(): string {
  if (!items.length) return '';
  return '【创作者偏好（长期记忆）】\n' + items.map((i) => '- ' + i.text).join('\n');
}
