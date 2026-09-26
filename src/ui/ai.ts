/** 灵框 · 统一 AI 引擎（供 AI 模块 / 角色扮演 / 酒馆推演 / 联想复用）
 * 读设置的**当前供应商档案**（`src/ui/ai-providers.ts`）：协议（原生 Ollama / OpenAI 兼容）、
 * 端点、Key、模型全从那一份来 —— 换供应商 = 所有 AI 功能一起换（用户 2026-09-26：「做成可选供应商
 * 和自定义供应商的版本吧」；在那之前这里是 `aiMode + baseUrl + apiKey + model` 四个平铺字段）。
 * qwen3 可能把内容放 thinking，统一 content||thinking 兜底。
 *
 * 2026-09-26（第二版，用户三条反馈）：
 *  · 「ai 的输出被截断了」⇒ **不传上限就是没有上限**：调用方给了 `numPredict` 才发 `max_tokens`
 *    （OpenAI 兼容）/ `num_predict`（Ollama），不给则整键不发（Ollama 明确发 `-1` = 不限）；
 *    同时认 `finish_reason`/`done_reason === 'length'` ⇒ 回复带 `truncated` 标记，界面能如实说。
 *  · 「我想要流式输出」⇒ `aiChatStream()`：`stream: true` + 逐块吃增量（OpenAI = SSE `data: {…}`，
 *    Ollama = NDJSON 一行一个 `{…}`），每块回调 `onDelta`；`aiChat()` 变成它的薄封装。
 *    ⚠️ 兼容面：不理会 `stream: true` 的中转会直接回**整包 JSON** —— 逐行解析天然也吃得下那种形状。
 *  · 失败要**点名是哪个端点**（与 `main.js` 的 `aiChat` 同一套口径）：`连不上 <端点>：<原因>`。
 */
import { activeProviderProfile } from './settings';
import { providerProblem } from './ai-providers';

export interface ChatMsg { role: 'system' | 'user' | 'assistant'; content: string; }
export interface AiReply {
  text: string;
  model: string;
  /** 模型因为输出上限被截断（`finish_reason`/`done_reason === 'length'`） */
  truncated?: boolean;
}
export interface AiOpts {
  /** 覆盖当前供应商选中的模型（留空 = 用这一家选中的那个） */
  model?: string;
  temperature?: number;
  /** 输出上限。**不传 = 不设上限**；工具类短回答（联想/起名/总结）才该显式给。 */
  numPredict?: number;
  /** 流式回调：拿到一块就调一次（`aiChat()` 不传它 ⇒ 行为与从前一致） */
  onDelta?: (delta: string) => void;
}

/** 单轮对话：messages → 回复文本 + 模型名。流式与一次性走同一条路（一个解析器）。 */
export async function aiChatStream(messages: ChatMsg[], opts: AiOpts = {}): Promise<AiReply> {
  const p = activeProviderProfile();
  const bad = providerProblem(p);
  if (bad || !p) throw new Error(bad || '还没配 AI 供应商（设置 → 模型）');
  const model = opts.model || p.model;
  const base = p.baseUrl.replace(/\/+$/, '');
  const temperature = opts.temperature ?? 0.8;
  const numPredict = opts.numPredict;
  const onDelta = opts.onDelta;
  const openai = p.kind === 'openai';

  const payload: Record<string, unknown> = openai
    ? { model, messages, temperature, stream: true }
    : { model, messages, stream: true, options: { temperature, num_predict: numPredict ?? -1 } };
  if (openai && numPredict) payload.max_tokens = numPredict;

  const url = base + (openai ? '/chat/completions' : '/api/chat');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (openai) headers.Authorization = 'Bearer ' + p.apiKey;
  let r: Response;
  try {
    r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  } catch (err) {
    throw new Error('连不上 ' + p.baseUrl + '：' + (err instanceof Error ? err.message : String(err)));
  }
  if (!r.ok) throw new Error((openai ? 'api' : 'ollama') + ' http ' + r.status + '（' + p.baseUrl + '）');

  let text = '';
  let thinking = '';
  let truncated = false;
  const eat = (obj: unknown): void => {
    if (!obj || typeof obj !== 'object') return;
    const o = obj as Record<string, any>;
    if (openai) {
      const ch = o.choices?.[0];
      const piece = ch?.delta?.content;
      if (typeof piece === 'string' && piece) { text += piece; onDelta?.(piece); }
      else if (typeof ch?.message?.content === 'string' && !text) { text = ch.message.content; }   /* 整包兜底 */
      const th = ch?.delta?.reasoning_content;
      if (typeof th === 'string') thinking += th;
      if (ch?.finish_reason === 'length') truncated = true;
    } else {
      const m = o.message ?? {};
      if (typeof m.content === 'string' && m.content) { text += m.content; onDelta?.(m.content); }
      if (typeof m.thinking === 'string') thinking += m.thinking;
      if (o.done_reason === 'length') truncated = true;
    }
  };

  const body = r.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const eatLine = (raw: string): void => {
      const line = raw.trim();
      if (!line || line.startsWith(':') || line.startsWith('event:')) return;   /* 心跳/注释/事件名 */
      const data = (line.startsWith('data:') ? line.slice(5) : line).trim();
      if (!data || data === '[DONE]') return;
      try { eat(JSON.parse(data)); } catch { /* 半截行或非 JSON，跳过 */ }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) eatLine(line);
    }
    buf += dec.decode();
    if (buf.trim()) eatLine(buf);
  } else {
    eat(await r.json());
  }

  /* qwen3 内容可能放 thinking（content 空）——兜底 */
  return { text: text || thinking, model, truncated };
}

/** 一次性调用（不关心增量时用它；内部就是 `aiChatStream` 不传 `onDelta`） */
export async function aiChat(messages: ChatMsg[], opts?: AiOpts): Promise<AiReply> {
  return aiChatStream(messages, opts);
}

/** 从触发的一个词生成 N 个联想词（联想专用，干净分隔） */
export async function aiAssociate(word: string, count = 7, opts?: { model?: string }): Promise<string[]> {
  const prompt = `你是词义联想引擎。给定一个词，生成 ${count} 个不同的发散联想词。\n规则：1. 后一个词由前一个词自然联想而来 2. 词要具体、有画面感，2-4字中文名词为主 3. 输出格式：每行一个词，不要序号解释\n\n输入词：\n${word}`;
  const reply = await aiChat([{ role: 'user', content: prompt }], { model: opts?.model, temperature: 0.8, numPredict: 200 });
  return cleanWords(reply.text);
}

function cleanWords(raw: string): string[] {
  const strip = /^[\s\d\-—.*•·、，。！？、:：;；()（）\[\]【】"'“”‘’]+|[\s\d\-—.*•·、，。！？、:：;；()（）\[\]【】"'“”‘’]+$/g;
  return raw.split('\n').map((x) => x.trim()).map((x) => x.replace(strip, ''))
    .filter((x) => x.length >= 1 && x.length <= 8)
    .filter((x) => /[\u4e00-\u9fa5a-zA-Z0-9]/.test(x))
    .slice(0, 8);
}
