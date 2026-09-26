/** 灵框 · 统一 AI 引擎（供 AI 模块 / 角色扮演 / 酒馆推演 / 联想复用）
 * 读设置的**当前供应商档案**（`src/ui/ai-providers.ts`）：协议（原生 Ollama / OpenAI 兼容）、
 * 端点、Key、模型全从那一份来 —— 换供应商 = 所有 AI 功能一起换（用户 2026-09-26：「做成可选供应商
 * 和自定义供应商的版本吧」；在那之前这里是 `aiMode + baseUrl + apiKey + model` 四个平铺字段）。
 * qwen3 可能把内容放 thinking，统一 content||thinking 兜底。
 */
import { activeProviderProfile } from './settings';
import { providerProblem } from './ai-providers';

export interface ChatMsg { role: 'system' | 'user' | 'assistant'; content: string; }
export interface AiReply { text: string; model: string; }

/** 单轮对话：messages → 回复文本。model 可选覆盖当前供应商的模型
 *  （留空 = 用这一家选中的那个；设置里换模型，这里就跟着换）。 */
export async function aiChat(messages: ChatMsg[], opts?: { model?: string; temperature?: number; numPredict?: number }): Promise<AiReply> {
  const p = activeProviderProfile();
  const bad = providerProblem(p);
  if (bad || !p) throw new Error(bad || '还没配 AI 供应商（设置 → 模型）');
  const model = opts?.model || p.model;
  const url = p.baseUrl.replace(/\/+$/, '');
  const temperature = opts?.temperature ?? 0.8;
  const numPredict = opts?.numPredict ?? 600;
  if (p.kind === 'openai') {
    const r = await fetch(url + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.apiKey },
      body: JSON.stringify({ model, messages, temperature, max_tokens: numPredict, stream: false }),
    });
    if (!r.ok) throw new Error('api http ' + r.status);
    const data = await r.json();
    return { text: data.choices?.[0]?.message?.content || '', model };
  }
  /* 本地 Ollama（原生协议） */
  const r = await fetch(url + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, options: { temperature, num_predict: numPredict } }),
  });
  if (!r.ok) throw new Error('ollama http ' + r.status);
  const data = await r.json();
  const msg = data.message || {};
  /* qwen3 内容可能放 thinking（content 空）——兜底 */
  return { text: msg.content || msg.thinking || '', model };
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
