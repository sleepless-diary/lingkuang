/* 灵框助手的「动作」（片 3）。
 *
 * ⭐ 为什么不用 function calling：本地跑的是 7B 级模型，工具调用基本不可用
 *    （不是格式崩就是参数编造）。所以协议退回到**文本 JSON 指令** ——
 *    模型只要把整条消息写成一行 `{"tool":"名字","args":{…}}` 就行，
 *    解析失败就当普通聊天，不会把对话卡死。
 *
 * ⭐ 只读与写入走两条完全不同的路：
 *    - 只读（list_entities / read_entity / …）：立刻执行，结果作为下一轮喂回模型；
 *    - 写入（set_field / create_node / …）：**不直接落盘** ——
 *      先做成一张 `Proposal`（提议卡片），由 `src/ui/agent.ts` 按
 *      `src/ui/agent-perm.ts` 的 `gateWrite()` 决定：拒绝 / 等创作者点「应用」/ 自动执行。
 *      这样「YOLO」只是把「等点一下」去掉，写入路径始终只有一条。
 *
 * 数据改动一律走 `src/store/actions.ts`（`addEntity`/`addNode` 会按类型模板补全字段、
 * id 走单调时钟），不自己手写 id、不直接改 `data`。
 */

import { addEntity, addNode } from '../store/actions';
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import type { Entity, PropValue, TimelineNode, Worldset } from '../store/types';
import { fsAddRoot, fsAvailable, fsDefaultPath, fsList, fsPrompt, fsRead, fsRootOf, fsRootsCached, fsSearch, fsSetRootWrite, fsWrite } from './agent-fs';
import { webAvailable, webFetch, webPrompt, webSearch } from './agent-web';
import { setAgentAsk, setAgentScope } from './agent-perm';
import type { AgentMode } from './agent-mode';
import type { AgentAsk, AgentScope } from './settings';

export type ToolArgs = Record<string, unknown>;

/** 模型要求调用某个动作 —— 从它的回复里解析出来的东西 */
export interface ToolCall {
  tool: string;
  args: ToolArgs;
}

/** 一条待批准的写入：卡片上显示什么、点了「应用」做什么 */
export interface Proposal {
  tool: string;
  /** 卡片标题，如「改字段：银发少女 · 发色」 */
  title: string;
  /** 卡片正文，人话描述这次要改什么 */
  detail: string;
  /** 应用时真正落盘的函数。⭐ 允许是 async：灵框外的文件写要走主进程 IPC（`src/ui/agent-fs.ts`），
   *  两个调度方（`src/ui/agent.ts` 的 `handleWrite()` / `agentCardClick()`）一律 `await` 它。 */
  apply: () => { ok: boolean; note: string } | Promise<{ ok: boolean; note: string }>;
  /** ⭐ 这一条**永远**只出卡片、不许自动执行（创作者把询问关成「直接执行」也一样）。
   *  用在"自我提权"这类动作上：`set_mode` 切到 Agent、把权限范围放宽 —— 那一步必须他亲手点。 */
  needsConfirm?: boolean;
}

interface ToolSpec {
  name: string;
  title: string;
  desc: string;
  /** 参数说明（进提示词，让模型知道该给什么键） */
  args: string;
  /** 灵框**外**的文件动作：只在文件通道可用时列进提示词（旧版主进程没有 `fs:*` 通道） */
  needsFs?: boolean;
  /** 联网动作：只在主进程有 `web:*` 通道时列出（片 2） */
  needsWeb?: boolean;
}

/* ---------------- 只读动作 ---------------- */

const READ_TOOLS: ToolSpec[] = [
  { name: 'list_entities', title: '列出设定', desc: '按类型列出这个世界里已有的设定条目名字', args: '{ type?: 类型名 }' },
  { name: 'read_entity', title: '看一条设定', desc: '读出某条设定的类型、全部字段与正文', args: '{ name: 名字 }' },
  { name: 'list_nodes', title: '列出事件', desc: '列出当前时间线上的事件（年份 + 标题 + 种类）', args: '{}' },
  { name: 'search', title: '搜一搜', desc: '在世界里按关键词搜设定与事件，给名字和年份', args: '{ q: 关键词 }' },
  /* ⭐ 片 1（2026-09-28）：灵框**外**的文件 —— 只读三件，白名单由主进程把关（`src/ui/agent-fs.ts`） */
  { name: 'list_files', title: '列文件夹', desc: '列出某个文件夹里有什么（目录 / 名字 / 大小 / 改动时间）', args: '{ path: 文件夹绝对路径 }', needsFs: true },
  { name: 'read_file', title: '读文件', desc: '读一个文本文件的内容（2 MB 以内）', args: '{ path: 文件绝对路径 }', needsFs: true },
  { name: 'search_files', title: '搜文件', desc: '在一个文件夹里按关键词找内容，给「文件:行号:那一行」', args: '{ q: 关键词, path?: 文件夹绝对路径 }', needsFs: true },
  /* ⭐ 片 2（2026-09-29）：联网 —— 只读两件（搜 + 抓网页），主进程 `web:*` 通道把关（见 `src/ui/agent-web.ts`）。
     用户原话：「把能做的东西都写了吧…联网搜索还有拖入文件到会话什么的」。 */
  { name: 'web_search', title: '联网搜', desc: '在互联网上搜关键词，给标题 / 网址 / 摘要（要用它核实资料、找参考资料时先搜）', args: '{ q: 关键词, limit?: 条数 }', needsWeb: true },
  { name: 'web_fetch', title: '开网页', desc: '抓一个网页，读它正文的文字（去掉标签与脚本）', args: '{ url: 完整网址(http/https) }', needsWeb: true },
];

/* ---------------- 写入动作 ---------------- */

const WRITE_TOOLS: ToolSpec[] = [
  { name: 'create_entity', title: '新建设定', desc: '新建一条设定条目（会给它补上该类型的空字段）', args: '{ name: 名字, type?: 类型名, fields?: { 字段: 值 } }' },
  { name: 'set_field', title: '改字段', desc: '改某条设定的一个字段值；也可以一次改一批（同一个字段、同一个值，仅 Agent 模式）', args: '{ entity: 名字, field: 字段名, value: 值 } 或 { entities: [名字…], field, value }' },
  { name: 'append_doc', title: '续写正文', desc: '在某条设定或某个事件的正文末尾追加一段', args: '{ target: "entity"|"node", name: 名字, text: 正文 }' },
  { name: 'create_node', title: '新建事件', desc: '在当前时间线上建一个事件节点；也可以一次建一批（仅 Agent 模式）', args: '{ title: 标题, year: 年份, kind?: 种类, desc?: 一句简述 } 或 { nodes: [{ title, year, kind?, desc? }…] }' },
  { name: 'rename_entity', title: '改名', desc: '给一条设定改名', args: '{ entity: 旧名字, name: 新名字 }' },
  /* ⭐ 灵框自己的设置（用户 2026-09-26：「给 AI 留一条改灵框设置的通道（包括聊天/Agent）」）。
     ⚠️ 只认白名单三个键 —— 不给模型碰"数据目录 / 界面布局 / 供应商密钥"这类东西的口子
     （apiKey 一概不认：那是密钥，只该由创作者自己在设置面板里填）。 */
  { name: 'set_setting', title: '改设置', desc: '改助手自己的设置：权限范围 / 是否每次询问 / 模式', args: '{ key: "agentScope"|"agentAsk"|"agentMode", value: 新值 }' },
  { name: 'set_mode', title: '切模式', desc: '把助手切到「聊天」或「Agent」模式（切到 Agent 永远要创作者点一下）', args: '{ mode: "chat"|"agent" }' },
  /* ⭐ 片 1：写文件。`needsConfirm` 在 `planWrite()` 里按"是不是灵框库外"逐条决定（见那一节）。 */
  { name: 'write_file', title: '写文件', desc: '新建或整篇覆盖一个文本文件（灵框库以外每次都要创作者点「应用」）', args: '{ path: 文件绝对路径, text: 内容 }', needsFs: true },
  { name: 'append_file', title: '追加到文件', desc: '在一个文本文件末尾追加一段（文件不存在就建）', args: '{ path: 文件绝对路径, text: 内容 }', needsFs: true },
  /* ⭐ 2026-09-29：创作者让你看/写一个还没交给你的文件夹时，**别直接说做不到** —— 提这个动作，
     他会看到一张「把某文件夹交给助手」的卡片（默认只读；要写就 write:true）。永远要人点头（needsConfirm）。 */
  { name: 'allow_folder', title: '要一个文件夹', desc: '请创作者把一个文件夹交给助手（他点「应用」才生效；默认只读，write:true 才可写）', args: '{ path: 文件夹绝对路径, write?: true }', needsFs: true },
];

export function findTool(name: string): ToolSpec | undefined {
  return READ_TOOLS.concat(WRITE_TOOLS).find((t) => t.name === name);
}

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.some((t) => t.name === name);
}

/** 给系统提示用：把能用的动作列出来 + 说清怎么调。
 *  ⭐ 2026-09-26 用户改口后**两个模式都注入**这份协议（「聊天模式也留一点灵框内部的工具」），
 *  差别只在最后那句"一次能做几步"：聊天一次一个、Agent 可以连着走多步（见 `agent-mode.ts`）。
 *  ⭐ 2026-09-28（片 1）：灵框**外**的**文件**动作加进来了 —— `needsFs` 标着的那些只在主进程真有
 *  `fs:*` 通道时列出（否则模型会对着不存在的工具空转）；后面再跟一段 `fsPrompt()`，说清"你能碰哪些
 *  文件夹、规矩是什么"。⚠️ 命令 / 联网 / 抓网页**仍然一条都没有**（这一轮用户只批了文件读写）。 */
export function toolsPrompt(mode: AgentMode = 'agent'): string {
  const live = (t: ToolSpec): boolean => (!t.needsFs || fsAvailable()) && (!t.needsWeb || webAvailable());
  const rows = READ_TOOLS.filter(live).map((t) => `- ${t.name} ${t.args} —— ${t.desc}`)
    .concat(WRITE_TOOLS.filter(live).map((t) => `- ${t.name}（要创作者点头）${t.args} —— ${t.desc}`));
  return [
    '【你能用的动作】',
    '只读的可以随时用，我会立刻把结果给你；写入的不会直接生效，会先变成一张要创作者点「应用」的提议卡片。',
    ...rows,
    fsPrompt(),
    webPrompt(),
    '要动用某个动作时，**整条回复只写一行 JSON**，别夹散文、别加解释。两个键的名字必须是 tool 和 args：',
    '{"tool":"read_entity","args":{"name":"安德希亚城"}}',
    '{"tool":"set_field","args":{"entity":"霜精灵","field":"描述","value":"霜精灵是生活在北境冻原的种族。"}}',
    '⚠️ 不要写成 {"动作名":{…}}（例如 {"set_field":{…}}），也不要写成 {"name":…,"arguments":…} —— 那样我认不出来。',
    '要放开权限（切到 Agent 模式、把权限改宽）时，那张卡片**永远**要创作者点「应用」才会生效 —— 别催他。',
    mode === 'agent'
      ? '不需要用动作时就用平常的话回答。**一次提问里可以连着提多个动作**（我最多放你走 8 步）；批量活（一次建好几个事件、给一批设定加同一个字段）**一次规划好再动手**：`set_field{entities:[…]}` 与 `create_node{nodes:[…]}` 两种批量形态只有在这个模式里认。'
      : '不需要用动作时就用平常的话回答。**一次提问只提一个动作**（这是「聊天」模式的规矩），做完把结果说给他、等他决定下一步；**也不要用批量形态**（`entities`/`nodes` 两个键这个模式不认，要用得先切到 Agent）。',
  ].join('\n');
}

/* ---------------- 解析模型回复 ---------------- */

/* ⭐ 各家的模型写法五花八门（用户 2026-09-15 实测：模型把动作写成了
 *   `{"set_field":{"entity":"霜精灵","field":"描述","value":"…"}}` —— 工具名当键，
 *   那时解析器只认正统 `{"tool":…,"args":…}` ⇒ 整坨 JSON 被当聊天画到脸上、什么也没发生）。
 *   所以这里把「名字」的写法全认下来，参数位置也容错；实在认不出才返回 null。 */
const ARG_KEYS = ['args', 'arguments', 'parameters', 'params', 'input'];
/** 参数写成裸值（`{"search":"雪"}`）时，这个动作的主参数叫什么 */
const PRIMARY: Record<string, string> = {
  list_entities: 'type',
  read_entity: 'name',
  list_nodes: '',
  search: 'q',
  create_entity: 'name',
  set_field: 'value',
  append_doc: 'text',
  create_node: 'title',
  rename_entity: 'name',
  set_setting: 'value',
  set_mode: 'mode',
  list_files: 'path',
  read_file: 'path',
  search_files: 'q',
  write_file: 'text',
  append_file: 'text',
  allow_folder: 'path',
  web_search: 'q',
  web_fetch: 'url',
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
/** 字段值的显示形态（数组用 / 连起来）—— 卡片与回执共用一个写法 */
const fmtVal = (v: PropValue): string => (Array.isArray(v) ? v.join('/') : String(v));
const knownTool = (v: unknown): string | null => {
  const n = str(v);
  return n && findTool(n) ? n : null;
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** 把各种形状掰成参数对象；掰不动就退到该动作的主参数名 */
function toArgs(tool: string, v: unknown): ToolArgs {
  let raw = v;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw); /* 值本身是 JSON 字符串 */
    } catch {
      raw = v;
    }
  }
  if (isObj(raw)) return raw as ToolArgs;
  const key = PRIMARY[tool];
  return key ? ({ [key]: raw } as ToolArgs) : {};
}

/** 认出来的动作名 + 参数；认不出返回 null */
export function normalizeCall(obj: unknown): ToolCall | null {
  if (!isObj(obj)) return null;
  const o = obj as Record<string, unknown>;
  /* ① 正统 {tool|name|action|act, args|arguments|…}；名字认得出就顺便收参数 */
  const direct = knownTool(o.tool) ?? knownTool(o.name) ?? knownTool(o.action) ?? knownTool(o.act);
  if (direct) {
    for (const k of ARG_KEYS) if (k in o) return { tool: direct, args: toArgs(direct, o[k]) };
    const rest: ToolArgs = {}; /* 参数摊平在顶层 */
    for (const [k, v] of Object.entries(o)) if (!['tool', 'name', 'action', 'act'].includes(k)) rest[k] = v;
    return { tool: direct, args: rest };
  }
  /* ② 工具名当键 —— {"set_field":{…}}（本地小模型很爱这么写） */
  const keys = Object.keys(o);
  if (keys.length === 1) {
    const t = knownTool(keys[0]);
    if (t) return { tool: t, args: toArgs(t, o[keys[0]]) };
  }
  /* ③ 工具名当键 + 同级还夹了别的键（{"set_field":{…},"说明":"…"}）：取第一个认识的那个 */
  for (const k of keys) {
    const t = knownTool(k);
    if (t) return { tool: t, args: toArgs(t, o[k]) };
  }
  return null;
}

/** 把一段「连在一起的多个 JSON 对象」切成一个个对象文本；夹了散文就返回 null。
 *  ⚠️ 必须**字符串感知**地数大括号：参数里带 `{` / `}`（`write_file` 的正文、`set_field` 的值）
 *     时，按字符数大括号会当场切错。 */
function splitJsonSpans(text: string): string[] | null {
  const spans: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /[\s,;]/.test(text[i])) i++; /* 分隔符：换行 / 逗号 / 分号 / 空格 */
    if (i >= text.length) break;
    if (text[i] !== '{') return null; /* 夹了散文 ⇒ 不当动作看 */
    const start = i;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    if (depth !== 0) return null; /* 括号没配平 */
    spans.push(text.slice(start, i));
  }
  return spans.length ? spans : null;
}

/** 从模型回复里抠出**全部**工具调用；不是调用就返回空数组（当普通聊天处理）。
 *
 *  ⭐ 用户 2026-10-10 实测报的这个坑：「有时候工具打出来了但是无法调用，卡住了吗」——
 *  模型把 **4 个 JSON 连写**在一段回复里（中间连换行都没有），老解析器 `JSON.parse` 整段直接抛错
 *  ⇒ `parseToolCall` 与 `looksLikeToolJson` 双双 false ⇒ 整坨 JSON 被当聊天原文画到创作者脸上、
 *  **一个动作都没跑**，这一轮就此结束（看起来就是"卡住了"）。现在这种连写按顺序全认。 */
export function parseToolCalls(raw: string): ToolCall[] {
  const text = String(raw ?? '').replace(/```[a-zA-Z]*/g, '').trim();
  /* 整段就是一个 JSON 才认 —— 免得回答里提到例子被误当成调用 */
  if (!text.startsWith('{')) return [];
  let obj: unknown;
  let parsed = false;
  try {
    obj = JSON.parse(text);
    parsed = true;
  } catch {
    const end = text.lastIndexOf('}');
    if (end >= 0) {
      try {
        obj = JSON.parse(text.slice(0, end + 1)); /* 后面还挂着一句话，切到最后一个 } 再试 */
        parsed = true;
      } catch { /* 落到下面「一串」那条路 */ }
    }
  }
  if (parsed) {
    const one = normalizeCall(obj);
    return one ? [one] : [];
  }
  const spans = splitJsonSpans(text);
  if (!spans) return [];
  const out: ToolCall[] = [];
  for (const s of spans) {
    let o: unknown;
    try {
      o = JSON.parse(s);
    } catch {
      return [];
    }
    const call = normalizeCall(o);
    if (!call) return []; /* 有一段认不出 ⇒ 整段当聊天（宁可不动，也不猜着执行） */
    out.push(call);
  }
  return out;
}

/** 单个调用（渲染层画「用到动作」那一行、只读判定都用它） */
export function parseToolCall(raw: string): ToolCall | null {
  return parseToolCalls(raw)[0] ?? null;
}

/** 整条回复是一个（或**一串**）JSON 对象、但没能映射到动作 —— 多半是格式写歪了 */
export function looksLikeToolJson(raw: string): boolean {
  const text = String(raw ?? '').replace(/```[a-zA-Z]*/g, '').trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return false;
  try {
    if (isObj(JSON.parse(text))) return true;
  } catch { /* 可能是一串对象 */ }
  const spans = splitJsonSpans(text);
  if (!spans) return false;
  return spans.every((s) => {
    try {
      return isObj(JSON.parse(s));
    } catch {
      return false;
    }
  });
}

/* ---------------- 小工具 ---------------- */

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(str(v));
  return Number.isFinite(n) ? n : null;
};
const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
};

function findEntity(ws: Worldset | undefined, name: string): Entity | undefined {
  const list = Object.values(ws?.entities ?? {});
  const want = name.trim();
  return (
    list.find((e) => e.name === want) ||
    list.find((e) => e.name.toLowerCase() === want.toLowerCase()) ||
    list.find((e) => e.name.includes(want) || want.includes(e.name))
  );
}

function typeName(ws: Worldset | undefined, e: Entity): string {
  return ws?.entityTypes?.[e.typeId]?.name ?? e.typeId;
}

function fieldsLine(e: Entity, max = 12): string {
  const rows = Object.entries(e.properties ?? {}).slice(0, max);
  if (!rows.length) return '（还没有字段）';
  return rows.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : String(v)}`).join('；');
}

/* ---------------- 只读：立刻执行 ---------------- */

const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const fmtSize = (n: number): string => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
/** 一次读给模型看的字数上限（全文另说 —— 超过就明说"只给了前 N 字"，别让它以为读完了） */
const FILE_READ_CAP = 6000;

/** 白名单挡下来时给模型的**出路**：提一张 `allow_folder` 卡片，创作者点一下「应用」文件夹就到手了。
 *  ⭐ 为什么非要有这句（用户 2026-09-29 实测）：他把桌面文件夹路径丢给助手，助手被白名单拦下之后
 *  只会说「请确认路径是否正确」—— 用户看到的结论是"这 AI 读写不了灵框外"。**拦下来必须给出路**，
 *  否则模型会绕着说、创作者以为功能不存在。`isDir` 决定要不要去掉最后一段（文件夹取自己，文件取父目录）。 */
function withFolderHint(err: string, path: string, isDir: boolean): string {
  if (!/不在助手能(看|写)的文件夹里|还没接上文件通道/.test(err)) return err;
  const dir = isDir ? path : (path.replace(/[\\/][^\\/]*$/, '') || path);
  return `${err}\n（要够到这儿得先让创作者把这个文件夹交给你：提一个 {"tool":"allow_folder","args":{"path":"${dir}"}} —— 他会看到一张卡片，点「应用」就交给你了（默认只读，要写加 "write":true）。**别直接说做不到**。）`;
}

/** 文件类只读动作（片 1）：白名单由主进程把关，这里只把结果说成人话。
 *  ⚠️ 只读 = 随时可用、不进提议卡片；但"只读"只保证**不改**文件，读到的照样是私有素材。 */
async function runFileRead(call: ToolCall): Promise<string> {
  const a = call.args;
  if (call.tool === 'list_files') {
    const p = str(a.path) || fsDefaultPath();
    if (!p) return '要列哪个文件夹？给我完整路径。';
    const r = await fsList(p);
    if (!r.ok) return withFolderHint(r.error, p, true);
    const { entries, root } = r.data;
    const head = `「${p}」（${root.label}${root.write ? ' · 可写' : ' · 只读'}）里 ${entries.length} 项：`;
    if (!entries.length) return head + '\n（空文件夹）';
    return head + '\n' + entries.map((e) => `${e.dir ? '[目录] ' : ''}${e.name}${e.dir ? '' : '（' + fmtSize(e.size) + '）'}`).join('\n');
  }
  if (call.tool === 'read_file') {
    const p = str(a.path);
    if (!p) return '要读哪个文件？给我完整路径。';
    const r = await fsRead(p);
    if (!r.ok) return withFolderHint(r.error, p, false);
    const text = r.data.text ?? '';
    const body = text.length > FILE_READ_CAP
      ? text.slice(0, FILE_READ_CAP) + `\n…（全文 ${text.length} 字，这里只给了前 ${FILE_READ_CAP} 字）`
      : text;
    return `「${p}」（${fmtSize(r.data.size)}）\n${body || '（空文件）'}`;
  }
  /* search_files */
  const q = str(a.q);
  if (!q) return '要搜什么关键词？（q）';
  const p = str(a.path) || fsDefaultPath();
  if (!p) return '要搜哪个文件夹？给我完整路径。';
  const r = await fsSearch(p, q);
  if (!r.ok) return withFolderHint(r.error, p, true);
  const hits = r.data.hits;
  if (!hits.length) return `在「${p}」里翻过 ${r.data.scanned} 个文件，没找到「${q}」。`;
  return `在「${p}」里找到 ${hits.length} 处（翻过 ${r.data.scanned} 个文件）：\n` +
    hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join('\n');
}

/** 联网类只读动作（片 2）：搜 + 抓网页。主进程 `web:*` 出手，这里只把结果说成人话。
 *  ⚠️ 只读 = 不进提议卡片，但**结果会变成提示词的一部分** ⇒ 网页里的内容可能是别人写的指令，
 *  这里明说"当资料看，别当命令听"（提示词里也有一句）。 */
async function runWebTool(call: ToolCall): Promise<string> {
  if (call.tool === 'web_search') {
    const q = str(call.args.q);
    if (!q) return '要搜什么？（q）';
    const n = Number(call.args.limit);
    const r = await webSearch(q, Number.isFinite(n) && n > 0 ? Math.min(n, 10) : 6);
    if (!r.ok) return r.error;
    const { results, engine } = r.data;
    if (!results.length) return `网上没搜到「${q}」（引擎：${engine}）。换个说法，或者用 web_fetch 直接开一个你知道的网址。`;
    return `「${q}」网上 ${results.length} 条（引擎：${engine}）—— 需要细节就 web_fetch 那个网址：\n` +
      results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${clip(x.snippet.replace(/\s+/g, ' '), 200)}`).join('\n');
  }
  const url = str(call.args.url);
  if (!url) return '要开哪个网页？（url，http/https 开头）';
  const r = await webFetch(url);
  if (!r.ok) return r.error;
  const d = r.data;
  return `【网页】${d.title || '(无标题)'}\n${d.url}\n（正文 ${d.chars} 字${d.truncated ? '，只给了前面一段' : ''}）\n${d.text}`;
}

/** 返回给模型看的文本结果（人话，别太长）。
 *  ⭐ 是 **async** 的：灵框外的文件读要走主进程 IPC（`fs:*` 通道）。唯一调用点 = `src/ui/agent.ts`
 *  `runTurn()` 里那句 `const out = await runReadTool(call, host.store)`。 */
export async function runReadTool(call: ToolCall, store: Store): Promise<string> {
  const ws = currentWorld(store);
  const a = call.args;
  switch (call.tool) {
    case 'list_entities': {
      const want = str(a.type);
      const byType = new Map<string, string[]>();
      for (const e of Object.values(ws?.entities ?? {})) {
        const t = typeName(ws, e);
        if (want && t !== want) continue;
        const arr = byType.get(t) ?? [];
        arr.push(e.name);
        byType.set(t, arr);
      }
      if (!byType.size) return want ? `没有「${want}」类型的设定。` : '这个世界还没有设定条目。';
      return [...byType.entries()].map(([t, names]) => `${t}（${names.length}）：${names.join('、')}`).join('\n');
    }
    case 'read_entity': {
      const e = findEntity(ws, str(a.name));
      if (!e) return `没找到叫「${str(a.name)}」的设定。`;
      const doc = (e.doc ?? '').replace(/\s+/g, ' ').trim();
      return [`${e.name}（${typeName(ws, e)}）`, `字段：${fieldsLine(e)}`, doc ? `正文：${clip(doc, 600)}` : '正文：（空）'].join('\n');
    }
    case 'list_nodes': {
      const tl = ws?.timelines?.[store.activeTimeline];
      if (!tl) return '当前没有打开的时间线。';
      if (!tl.nodes.length) return `时间线「${tl.name}」上还没有事件。`;
      const rows = [...tl.nodes].sort((x, y) => x.year - y.year).slice(0, 20);
      return `时间线「${tl.name}」（${tl.nodes.length} 个事件）\n` + rows.map((n) => `${n.year} ${n.title}${n.kind ? '·' + n.kind : ''}`).join('\n');
    }
    case 'search': {
      const q = str(a.q).toLowerCase();
      if (!q) return '要搜什么？给我个关键词。';
      const hits: string[] = [];
      for (const e of Object.values(ws?.entities ?? {})) {
        if (e.name.toLowerCase().includes(q) || JSON.stringify(e.properties ?? {}).toLowerCase().includes(q)) {
          hits.push(`设定：${e.name}（${typeName(ws, e)}）`);
        }
      }
      for (const tl of Object.values(ws?.timelines ?? {})) {
        for (const n of tl.nodes) {
          if (n.title.toLowerCase().includes(q) || (n.desc ?? '').toLowerCase().includes(q)) hits.push(`事件：${n.year} ${n.title}（${tl.name}）`);
        }
      }
      return hits.length ? hits.slice(0, 20).join('\n') : `没搜到和「${str(a.q)}」有关的东西。`;
    }
    case 'list_files':
    case 'read_file':
    case 'search_files':
      return await runFileRead(call);
    case 'web_search':
    case 'web_fetch':
      return await runWebTool(call);
    default:
      return `不认识的动作：${call.tool}`;
  }
}

/* ---------------- 写入：先做成提议 ---------------- */

/** 失败时返回一段人话错误（给模型看，让它改参数重试）。
 *  ⭐ `mode` 只用来卡**批量形态**（`set_field{entities}` / `create_node{nodes}`）——
 *  用户 2026-09-26 拍板：那种"一次动一批"的活只在 Agent 模式放行，聊天模式一次只做一个动作。 */
export function planWrite(call: ToolCall, store: Store, mode: AgentMode = 'agent'): { ok: true; proposal: Proposal } | { ok: false; note: string } {
  const ws = currentWorld(store);
  const a = call.args;
  switch (call.tool) {
    case 'create_entity': {
      const name = str(a.name);
      if (!name) return { ok: false, note: '新建设定要给我名字（args.name）。' };
      const types = Object.values(ws?.entityTypes ?? {});
      const want = str(a.type);
      const type = types.find((t) => t.name === want || t.id === want) ?? types[0];
      if (!type) return { ok: false, note: '这个世界还没有类型模板，先在结构体管理里建一个。' };
      const fields = (a.fields && typeof a.fields === 'object' ? a.fields : {}) as unknown as Record<string, PropValue>;
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `新建设定：${name}（${type.name}）`,
          detail: Object.keys(fields).length ? `字段：${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('；')}` : '先建出来，字段留空',
          apply: () => {
            addEntity(store, { name, typeId: type.id, properties: fields });
            return { ok: true, note: `已新建设定「${name}」` };
          },
        },
      };
    }
    case 'set_field': {
      const field = str(a.field);
      if (!field) return { ok: false, note: '要改哪个字段？（args.field）' };
      const raw = a.value;
      const value: PropValue = Array.isArray(raw)
        ? (raw as (string | number)[])
        : typeof raw === 'boolean' || typeof raw === 'number'
          ? raw
          : str(raw);
      /* ⭐ 批量形态（阶段 2B）：`entities: [名字…]` —— 同一个字段、同一个值，一次改一批。
         只在 Agent 模式放行；找不到的名字**跳过并写在卡片上**（不因为一条写错就整批不动）。 */
      const many = Array.isArray(a.entities) ? (a.entities as unknown[]).map((n) => str(n)).filter(Boolean) : [];
      if (many.length) {
        if (mode !== 'agent') return { ok: false, note: '聊天模式一次只改一条 —— 要批量改请先切到 Agent 模式，或者一条一条说。' };
        const hits = many.map((n) => findEntity(ws, n)).filter((e): e is Entity => !!e);
        const miss = many.filter((n) => !findEntity(ws, n));
        if (!hits.length) return { ok: false, note: `没找到这些设定：${miss.join('、')}。` };
        const ids = hits.map((e) => e.id);
        return {
          ok: true,
          proposal: {
            tool: call.tool,
            title: `改字段：${hits.length} 条设定 · ${field}`,
            detail:
              `都改成：${fmtVal(value)}\n` +
              hits.map((e) => e.name).join('、') +
              (miss.length ? `\n（没找到、跳过：${miss.join('、')}）` : ''),
            apply: () => {
              store.update((d) => {
                for (const id of ids) {
                  const ent = d.worldsets[store.activeWorld]?.entities?.[id];
                  if (!ent) continue;
                  if (!ent.properties) ent.properties = {};
                  ent.properties[field] = value;
                }
              });
              return { ok: true, note: `已把 ${hits.length} 条设定的 ${field} 改成 ${fmtVal(value)}（${hits.map((e) => e.name).join('、')}）` };
            },
          },
        };
      }
      const e = findEntity(ws, str(a.entity));
      if (!e) return { ok: false, note: `没找到叫「${str(a.entity)}」的设定。` };
      const old = e.properties?.[field];
      const id = e.id;
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `改字段：${e.name} · ${field}`,
          detail: `${old === undefined ? '（原本没有这个字段）' : String(old)} → ${fmtVal(value)}`,
          apply: () => {
            store.update((d) => {
              const ent = d.worldsets[store.activeWorld]?.entities?.[id];
              if (!ent) return;
              if (!ent.properties) ent.properties = {};
              ent.properties[field] = value;
            });
            return { ok: true, note: `已把「${e.name}」的 ${field} 改成 ${fmtVal(value)}` };
          },
        },
      };
    }
    case 'append_doc': {
      const kind = str(a.target) === 'node' ? 'node' : 'entity';
      const text = str(a.text);
      if (!text) return { ok: false, note: '要续写什么？（args.text）' };
      const name = str(a.name);
      if (kind === 'entity') {
        const e = findEntity(ws, name);
        if (!e) return { ok: false, note: `没找到叫「${name}」的设定。` };
        const id = e.id;
        const next = [e.doc ?? '', text].filter(Boolean).join('\n\n');
        return {
          ok: true,
          proposal: {
            tool: call.tool,
            title: `续写正文：${e.name}`,
            detail: clip(text, 200),
            apply: () => {
              store.update((d) => {
                const ent = d.worldsets[store.activeWorld]?.entities?.[id];
                if (ent) ent.doc = next;
              });
              return { ok: true, note: `已把这段接到「${e.name}」正文末尾` };
            },
          },
        };
      }
      const tl = ws?.timelines?.[store.activeTimeline];
      const node = tl?.nodes.find((n) => n.title === name) ?? tl?.nodes.find((n) => n.title.includes(name) && name.length > 0);
      if (!tl || !node) return { ok: false, note: `当前时间线上没找到事件「${name}」。` };
      const tlId = tl.id;
      const nodeId = node.id;
      const next = [node.doc ?? '', text].filter(Boolean).join('\n\n');
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `续写正文：${node.year} ${node.title}`,
          detail: clip(text, 200),
          apply: () => {
            store.update((d) => {
              const n = d.worldsets[store.activeWorld]?.timelines?.[tlId]?.nodes.find((x) => x.id === nodeId);
              if (n) n.doc = next;
            });
            return { ok: true, note: `已把这段接到事件「${node.title}」正文末尾` };
          },
        },
      };
    }
    case 'create_node': {
      /* ⭐ 批量形态（阶段 2B）：`nodes: [{title, year, kind?, desc?}…]` —— 一次建一串事件。
         只在 Agent 模式放行；没有 title 的项直接丢掉（不整批失败）。 */
      const manyNodes = Array.isArray(a.nodes) ? (a.nodes as unknown[]) : null;
      if (manyNodes) {
        if (mode !== 'agent') return { ok: false, note: '聊天模式一次只建一个 —— 要批量建请先切到 Agent 模式，或者一个一个说。' };
        const tl0 = ws?.timelines?.[store.activeTimeline];
        if (!tl0) return { ok: false, note: '当前没有打开的时间线，先在沙盘里选一条。' };
        const items = manyNodes
          .map((o) => (isObj(o) ? o : ({ title: o } as ToolArgs)))
          .map((o) => ({ title: str(o.title), year: num(o.year) ?? 0, kind: str(o.kind), desc: str(o.desc) }))
          .filter((it) => it.title);
        if (!items.length) return { ok: false, note: '批量建事件要给我 nodes: [{ title, year }, …]（每一项都得有 title）。' };
        const tlId0 = tl0.id;
        const tlName = tl0.name;
        return {
          ok: true,
          proposal: {
            tool: call.tool,
            title: `新建事件：${items.length} 个（${tlName}）`,
            detail: items.map((it) => `${it.year} ${it.title}${it.kind ? ' · ' + it.kind : ''}`).join('\n'),
            apply: () => {
              for (const it of items) {
                const partial: Partial<TimelineNode> = { title: it.title, year: it.year, type: 'story_event' };
                if (it.kind) partial.kind = it.kind;
                if (it.desc) partial.desc = it.desc;
                addNode(store, tlId0, partial);
              }
              return { ok: true, note: `已在「${tlName}」上新建 ${items.length} 个事件：${items.map((it) => it.title).join('、')}` };
            },
          },
        };
      }
      const title = str(a.title);
      if (!title) return { ok: false, note: '新建事件要给我标题（args.title）。' };
      const tl = ws?.timelines?.[store.activeTimeline];
      if (!tl) return { ok: false, note: '当前没有打开的时间线，先在沙盘里选一条。' };
      const year = num(a.year) ?? 0;
      const kind = str(a.kind);
      const desc = str(a.desc);
      const tlId = tl.id;
      const partial: Partial<TimelineNode> = { title, year, type: 'story_event' };
      if (kind) partial.kind = kind;
      if (desc) partial.desc = desc;
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `新建事件：${title}`,
          detail: `${year} 年${kind ? ' · ' + kind : ''}（落在时间线「${tl.name}」上）${desc ? '\n' + clip(desc, 160) : ''}`,
          apply: () => {
            addNode(store, tlId, partial);
            return { ok: true, note: `已在「${tl.name}」上新建事件「${title}」（${year} 年）` };
          },
        },
      };
    }
    case 'rename_entity': {
      const e = findEntity(ws, str(a.entity));
      if (!e) return { ok: false, note: `没找到叫「${str(a.entity)}」的设定。` };
      const next = str(a.name);
      if (!next) return { ok: false, note: '要改成什么名字？（args.name）' };
      const id = e.id;
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `改名：${e.name} → ${next}`,
          detail: 'vault 里的 .md 文件会跟着改名',
          apply: () => {
            store.update((d) => {
              const ent = d.worldsets[store.activeWorld]?.entities?.[id];
              if (ent) ent.name = next;
            });
            return { ok: true, note: `已把「${e.name}」改名为「${next}」` };
          },
        },
      };
    }
    /* ⭐ 灵框自己的设置（用户 2026-09-26：「给 AI 留一条改灵框设置的通道（包括聊天/Agent）」）。
       ⚠️ 白名单三个键；**放宽**（切 Agent / 范围改可写 / 关掉询问）一律 `needsConfirm: true`：
       即便创作者把询问关成「直接执行」，自我提权这一步也必须他亲手点一下。收窄随时生效。 */
    case 'set_setting':
    case 'set_mode': {
      const key = call.tool === 'set_mode' ? 'agentMode' : str(a.key);
      const value = call.tool === 'set_mode' ? str(a.mode) : str(a.value);
      const ALLOWED: Record<string, string[]> = {
        agentScope: ['readonly', 'workspace'],
        agentAsk: ['always', 'never'],
        agentMode: ['chat', 'agent'],
      };
      const KEY_CN: Record<string, string> = { agentScope: '权限范围', agentAsk: '写入要不要先问', agentMode: '助手模式' };
      if (!ALLOWED[key]) {
        return { ok: false, note: '能改的设置只有 agentScope（readonly|workspace）、agentAsk（always|never）、agentMode（chat|agent）。' };
      }
      if (ALLOWED[key].indexOf(value) < 0) {
        return { ok: false, note: `「${key}」只能是 ${ALLOWED[key].join(' 或 ')}，我收到的是「${value}」。` };
      }
      const widen = value === 'agent' || value === 'workspace' || value === 'never';
      const what = key === 'agentMode'
        ? (value === 'agent' ? '它能连着走多步、批量改' : '回到平常：一次只做一个动作')
        : key === 'agentScope'
          ? (value === 'workspace' ? '允许它改你的数据（写入仍走提议卡片）' : '只读：写入一律不执行')
          : (value === 'never' ? '写入不再问你，直接落盘' : '每次写入都先出卡片等你点「应用」');
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `改设置：${KEY_CN[key]} → ${value}`,
          detail: what + (widen ? '（这一步放开了更大的权限，必须你点「应用」）' : ''),
          needsConfirm: widen,
          apply: () => {
            if (key === 'agentScope') {
              setAgentScope(value as AgentScope);
              return { ok: true, note: `权限范围已改成「${value}」` };
            }
            if (key === 'agentAsk') {
              setAgentAsk(value as AgentAsk);
              return { ok: true, note: `写入询问方式已改成「${value}」` };
            }
            /* 模式住在 `src/ui/agent.ts` 的模块变量里 —— 动作层直接改它会成 import 环，
               所以广播一条事件，由那边收（与 `lingkuang-agent-perm` / `lingkuang-sessions` 同一套做法）。 */
            window.dispatchEvent(new CustomEvent('lingkuang-agent-mode', { detail: { mode: value } }));
            return { ok: true, note: value === 'agent' ? '已切到 Agent 模式（能连着走多步）' : '已切回聊天模式（一次只做一个动作）' };
          },
        },
      };
    }
    /* ⭐ 片 1（2026-09-28）：灵框**外**的文件写。
       三道门在这里各就各位：① 认不出在哪个白名单文件夹里 ⇒ 直接拒绝（人话告诉它该请创作者加进来）；
       ② 那个文件夹是只读 ⇒ 拒绝；③ **灵框库以外** ⇒ `needsConfirm: true`（即便权限是「直接执行」，
       也必须创作者亲手点「应用」—— 这是他选的档："写灵框外一律逐次确认"）。
       ⚠️ 这里的前缀判断只为了**出卡片**；真正拦人的是主进程 `main.js` 的 `fsMatchRoot()`（realpath）。 */
    case 'write_file':
    case 'append_file': {
      const p = str(a.path);
      const text = str(a.text);
      if (!p) return { ok: false, note: '要写哪个文件？给我完整绝对路径（args.path）。' };
      if (!text) return { ok: false, note: '要写什么内容？（args.text）' };
      const root = fsRootOf(p);
      if (!root) {
        const allowed = fsRootsCached().map((r) => r.path).join('、') || '（还没接过文件夹）';
        const dir = p.replace(/[\\/][^\\/]*$/, '') || p;
        return { ok: false, note: `「${p}」不在助手能碰的文件夹里（能碰的只有：${allowed}）。要么写到灵框库里，要么提一个 allow_folder 动作（{"tool":"allow_folder","args":{"path":"${dir}","write":true}}）让创作者决定要不要把它交给你 —— **不要**反复试同一个路径。` };
      }
      if (!root.write) {
        return { ok: false, note: `「${root.label}」是**只读**的，写不进去。要写就提一个 allow_folder 动作（{"tool":"allow_folder","args":{"path":"${root.path}","write":true}}）让创作者点一下放开，或者写到灵框库里。` };
      }
      const outside = !root.builtin;
      const append = call.tool === 'append_file';
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `${append ? '追加到文件' : '写文件'}：${baseName(p)}`,
          detail: `路径：${p}\n${outside ? `（**灵框库外** —— ${root.label}${root.write ? ' · 可写' : ''}，只有你点「应用」才会落盘）\n` : ''}${clip(text, 300)}`,
          needsConfirm: outside,
          apply: async () => {
            const r = await fsWrite(p, text, append ? 'append' : 'overwrite');
            return r.ok
              ? { ok: true, note: `已${append ? '追加到' : '写入'} ${r.data.path}（${r.data.bytes} 字节）` }
              : { ok: false, note: `没写成：${r.error}` };
          },
        },
      };
    }
    /* ⭐ 2026-09-29（用户实测踩到的坑）：助手**自己**要一个文件夹。
       他把桌面文件夹路径丢给助手 ⇒ 被白名单拦下 ⇒ 模型只会说「请确认路径是否正确」，
       他因此以为"这 AI 读写不了灵框外"。现在拦下来必须给这条出路：提一张卡片，他点一下就成了。
       三条纪律：① 永远 `needsConfirm: true`（放开白名单 = 扩大权限，和 set_mode 同一类：只有创作者点「应用」才算）；
       ② 卡片上明说这是灵框库外、默认只读；③ 落地走 `fsAddRoot()`，要可写再补一次 `fsSetRootWrite()`。 */
    case 'allow_folder': {
      const raw = str(a.path);
      if (!raw) return { ok: false, note: '要哪个文件夹？给我完整绝对路径（args.path）。' };
      /* ⚠️ 模型很可能递一个**文件**路径过来（它刚被 `read_file` 拦下）—— 而授权的粒度是**文件夹**，
         所以这里退到父目录，并在卡片上写明"交出来的是它所在的文件夹"（别让它以为只给了一个文件）。 */
      const looksFile = /[\\/][^\\/]*\.[a-z0-9]{1,8}$/i.test(raw);
      const p = looksFile ? (raw.replace(/[\\/][^\\/]*$/, '') || raw) : raw;
      const want = a.write === true || a.write === 1 || /^(true|1|yes)$/i.test(str(a.write));
      const known = fsRootOf(p);
      if (known) {
        return { ok: false, note: `「${known.label}」创作者早就交给你了（${known.write ? '可写' : '只读'}）—— 直接用 list_files / read_file${known.write ? ' / write_file' : ''} 就行，别再要一次。` };
      }
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `把文件夹交给助手：${baseName(p)}`,
          detail: `路径：${p}\n${looksFile ? `（你要的是文件「${baseName(raw)}」，助手授权的粒度是**文件夹** —— 交出来的是它所在的这个）\n` : ''}（**灵框库外**的文件夹 —— 交给我之后${want ? '**可写**：我能往里写，但每一次写仍然要你亲手点「应用」' : '**只读**：我能看，不能写'}；不点就不会加，随时能在助手的「文件夹」里撤掉）`,
          needsConfirm: true,
          apply: async () => {
            const r = await fsAddRoot(p);
            if (!r.ok) return { ok: false, note: `没加成：${r.error}` };
            const got = fsRootOf(p);   /* fsAddRoot 成功后模块缓存已更新 ⇒ 这里一定能认出来 */
            const label = got ? got.label : baseName(p);
            if (want && got) {
              const w = await fsSetRootWrite(got.path, true);
              if (!w.ok) return { ok: true, note: `已经把「${label}」（只读）交给助手了，但改成可写那步没成：${w.error}` };
            }
            return { ok: true, note: `已经把「${label}」交给助手了（${want ? '可写' : '只读'}）—— 现在可以让我看${want ? '、写' : ''}那个文件夹里的文件了` };
          },
        },
      };
    }
    default:
      return { ok: false, note: `不认识的动作：${call.tool}` };
  }
}
