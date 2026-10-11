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

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** 助手的**上下文分割线**（落盘 { role:'system', content:'', div:true }）：它自己不是消息，只是
   *  「从这里往上不再发给模型」的界碑。⚠️ 2026-09-26 起 AI 页的「主会话」与 Ctrl+K 助手是**同一格
   *  会话**（同一份历史），所以这个标记必须住在共用类型上，两边都认得。 */
  div?: boolean;
  /** 模型的**思考过程**（DeepSeek `reasoning_content` / Ollama `thinking`）。用户 2026-09-26
   *  「看不到他的思考诶」—— 这些增量一直在收，却只当"content 空时的兜底"，界面上从不显示；
   *  现在跟着消息一起落盘，由 `thinkBlockHtml()` 画成可折叠的一块（历史里也翻得回来）。 */
  reasoning?: string;
}
export interface AiReply {
  text: string;
  model: string;
  /** 模型因为输出上限被截断（`finish_reason`/`done_reason === 'length'`） */
  truncated?: boolean;
  /** 模型的思考过程（不思考的模型 = 空串；content 为空时 thinking 已经是正文，就不再重复回传） */
  reasoning?: string;
  /** ⭐ 2026-10-12（用户：「思考又被当成正文了」）：正文**一个字都没有**、只有思考。
   *  推理模型（DeepSeek `reasoning_content`）把整轮预算全花在思考上时就是这个形状。
   *  ⚠️ 这时 `text` 里塞的是**思考**（见文件尾那条兜底，那是给"只要一段字"的调用方如联想/起名用的），
   *  但**它不是模型说的话** —— 要画给创作者看的界面必须判这一位，别把思考当正文端出去。 */
  thinkingOnly?: boolean;
  /** 厂商**原生函数调用**的名字（非空 = 模型走了厂商那套 tool_calls）。我们这套协议收不到它，
   *  所以它非空时这一轮的动作是**丢了**的 —— 界面要据此走「纠正一次」，别当无事发生。 */
  toolCalls?: string[];
}
export interface AiOpts {
  /** 覆盖当前供应商选中的模型（留空 = 用这一家选中的那个） */
  model?: string;
  temperature?: number;
  /** 输出上限。**不传 = 不设上限**；工具类短回答（联想/起名/总结）才该显式给。 */
  numPredict?: number;
  /** 流式回调：拿到一块就调一次（`aiChat()` 不传它 ⇒ 行为与从前一致） */
  onDelta?: (delta: string) => void;
  /** 思考增量回调：模型吐 `reasoning_content` / `thinking` 时一块一次（不思考的模型不会被调） */
  onReasoning?: (delta: string) => void;
}

/** 取第一个非空字符串（思考的字段名各家不一，见 `eat()`） */
function firstStr(...vals: unknown[]): string {
  for (const v of vals) if (typeof v === 'string' && v) return v;
  return '';
}

/** 消息**上行**的净化：只留 `role`/`content`。
 *  ⚠️ 历史里的消息现在挂着 `reasoning`（思考过程，见 `ChatMsg`）—— 那是给界面看的，
 *  原样塞进请求体会让严格一点的端点直接 400（未知字段），所以这里一律剥掉。 */
function wire(messages: ChatMsg[]): { role: string; content: string }[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
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
  const onReasoning = opts.onReasoning;
  const openai = p.kind === 'openai';

  const payload: Record<string, unknown> = openai
    ? { model, messages: wire(messages), temperature, stream: true }
    : { model, messages: wire(messages), stream: true, options: { temperature, num_predict: numPredict ?? -1 } };
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
  const toolCalls: string[] = [];
  const eat = (obj: unknown): void => {
    if (!obj || typeof obj !== 'object') return;
    const o = obj as Record<string, any>;
    if (openai) {
      const ch = o.choices?.[0];
      const piece = ch?.delta?.content;
      if (typeof piece === 'string' && piece) { text += piece; onDelta?.(piece); }
      else if (typeof ch?.message?.content === 'string' && !text) { text = ch.message.content; }   /* 整包兜底 */
      /* 思考的字段名各家不一（DeepSeek/OpenAI 兼容 = `reasoning_content`，也有只叫 `reasoning` 的；
         有些中转还把它抬到 choices 外面；端点不理会 stream、直接回一整包时它在 `message` 上而不是 `delta` 上）
         —— 都收，不挑。`message.reasoning_content` 这一支是 2026-09-28 补的：只认 delta 的话，
         「整包 + 正文空 + 思考里有答案」那种响应会解析出 0 个词（联想画布那边就栽在这个形状上）。 */
      const th = firstStr(ch?.delta?.reasoning_content, ch?.delta?.reasoning, ch?.message?.reasoning_content, ch?.message?.reasoning, o.reasoning_content, o.reasoning);
      if (th) { thinking += th; onReasoning?.(th); }
      /* 厂商原生函数调用（`tool_calls`）：我们这套"一行一个 JSON"的协议收不到它 ——
         但**必须知道它发生过**，否则模型那一轮正文为空、动作也没了，界面看着就是"卡住"
         （用户 2026-10-11「工具也被吃了」/ 2026-10-12「思考又被当成正文了」都撞在这附近）。 */
      const tc = Array.isArray(ch?.delta?.tool_calls) ? ch.delta.tool_calls
        : Array.isArray(ch?.message?.tool_calls) ? ch.message.tool_calls : null;
      if (tc) for (const t of tc) {
        const n = (t as { function?: { name?: unknown } })?.function?.name;
        if (typeof n === 'string' && n && !toolCalls.includes(n)) toolCalls.push(n);
      }
      if (ch?.finish_reason === 'length') truncated = true;
    } else {
      const m = o.message ?? {};
      if (typeof m.content === 'string' && m.content) { text += m.content; onDelta?.(m.content); }
      const th = firstStr(m.thinking, m.reasoning_content, m.reasoning, o.thinking);
      if (th) { thinking += th; onReasoning?.(th); }
      /* 原生函数调用（Ollama 原生线也有一套）—— 同上：**收不到，但得知道它发生过** */
      if (Array.isArray(m.tool_calls)) for (const t of m.tool_calls) {
        const n = (t as { function?: { name?: unknown } })?.function?.name;
        if (typeof n === 'string' && n && !toolCalls.includes(n)) toolCalls.push(n);
      }
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

  /* qwen3 内容可能放 thinking（content 空）——兜底成正文；那种情况下 thinking **就是答案本身**，
     不再当"思考"重复画一遍 ⇒ `reasoning` 只在真有正文时回传（用户 2026-09-26：「看不到他的思考」）。
     ⚠️ 2026-10-12（用户：「思考又被当成正文了」）：这条兜底对**推理模型**是错的 ——
     它把整轮预算花在思考上、正文一个字都没写时（真机 `%APPDATA%\lingkuang\agent\sessions.json`
     实测：一条 assistant 的 content = 2465 字英文思考、reasoning = 0），兜底把**思考**端到了创作者脸上。
     兜底照旧（联想/起名/分类那几个"只要一段字"的调用方靠它），但把 `thinkingOnly` 一起交出去 ——
     要画给创作者看的界面用 `splitReply()` 拆，别把思考当正文。 */
  const thinkingOnly = !text && !!thinking;
  return { text: text || thinking, model, truncated, reasoning: text ? thinking : '', thinkingOnly, toolCalls };
}

/** 一次性调用（不关心增量时用它；内部就是 `aiChatStream` 不传 `onDelta`） */
export async function aiChat(messages: ChatMsg[], opts?: AiOpts): Promise<AiReply> {
  return aiChatStream(messages, opts);
}

/** 界面收尾用：把回复拆成「正文画什么 / 思考画什么」。
 *  ⭐ 2026-10-12（用户：「思考又被当成正文了」）：`thinkingOnly` 时 `r.text` 里装的是**思考**，
 *  一个字的正文都没有 ⇒ 正文那边给一句实话，思考那边收下全文（折叠块里还翻得到）。 */
export function splitReply(r: AiReply): { body: string; think: string } {
  if (r.thinkingOnly) return { body: '（这一轮它只出了思考、没写正文 —— 说「接着说」让它继续）', think: r.text };
  return { body: r.text, think: r.reasoning || '' };
}

/** 从触发的一个词生成 N 个联想词（联想专用，干净分隔）
 *  ⚠️ **别在这儿加 `numPredict`**：推理模型（DeepSeek 的 `reasoning_content`）会先把预算花在思考上，
 *  上限一小就只剩 `finish_reason: "length"` + 空正文（用户 2026-09-28 报的「语义联想用不了了」就是这个
 *  形状 —— 当时 `src/ui/assoc.ts` 自己拼 fetch 写了 `max_tokens: 200`）。上限只在调用方真的要时再发。 */
export async function aiAssociate(word: string, count = 7, opts?: { model?: string }): Promise<string[]> {
  const prompt = `你是词义联想引擎。给定一个词，生成 ${count} 个不同的发散联想词。\n规则：1. 后一个词由前一个词自然联想而来 2. 词要具体、有画面感，2-4字中文名词为主 3. 输出格式：每行一个词，不要序号解释\n\n输入词：\n${word}`;
  const reply = await aiChat([{ role: 'user', content: prompt }], { model: opts?.model, temperature: 0.8 });
  return cleanWords(reply.text);
}

function cleanWords(raw: string): string[] {
  const strip = /^[\s\d\-—.*•·、，。！？、:：;；()（）\[\]【】"'“”‘’]+|[\s\d\-—.*•·、，。！？、:：;；()（）\[\]【】"'“”‘’]+$/g;
  return raw.split('\n').map((x) => x.trim()).map((x) => x.replace(strip, ''))
    .filter((x) => x.length >= 1 && x.length <= 8)
    .filter((x) => /[\u4e00-\u9fa5a-zA-Z0-9]/.test(x))
    .slice(0, 8);
}
