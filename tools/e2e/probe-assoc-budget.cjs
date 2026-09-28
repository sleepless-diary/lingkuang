/* probe-assoc-budget.cjs —— 用**真供应商**量「输出预算被思考吃掉」这件事（用户 2026-09-28：
 * 「为什么我灵感触发器的语义联想用不了了」）。
 *
 * 为什么要有它：`assoc-reasoning.cjs` 用回放的假响应证明"我们这一侧接得住"；用户报的却是
 * **真端点**的形状 —— 得拿他当前在用的那家真打一次，看 200 个 token 是怎么被 `reasoning_content` 吃光的。
 * 它从 `%APPDATA%\lingkuang\Local Storage\leveldb` 读**当前在用**的供应商（与 App 同一份配置），
 * 打四个变体并排比较：写死 200 / 放大到 2000 / 不发上限 / 不发上限+stream。
 *   · **key 只在内存里用，一律不打印**（只露末 4 位）。
 *   · 会真消耗几次 API 调用（每次 200~2000 token）。
 *
 * 跑：node tools\e2e\probe-assoc-budget.cjs [输入词]
 * 判据：`max_tokens 200` 那一行应当是 `finish=length · content=0 字 · 0 词`；不发上限那两行应当是 7 词。 */
const fs = require('fs');
const path = require('path');

/* 从字符串 s 的第一个 '{' 起做括号配对，取出完整的 JSON 对象（值后面跟着 leveldb 的 META 垃圾） */
function jsonSlice(s) {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let k = start; k < s.length; k++) {
    const c = s[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(start, k + 1); }
  }
  return null;
}

/* ── 1. 从 leveldb 里读当前在用的供应商（不打码打印，只在内存里用） ── */
function readActiveProvider() {
  const dir = path.join(process.env.APPDATA, 'lingkuang', 'Local Storage', 'leveldb');
  let last = null;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(log|ldb)$/.test(f)) continue;
    const buf = fs.readFileSync(path.join(dir, f));
    const needle = Buffer.from('{"providers"', 'utf16le');
    let i = -1;
    while ((i = buf.indexOf(needle, i + 1)) !== -1) {
      const js = jsonSlice(buf.slice(i, i + 6000).toString('utf16le'));
      if (!js) continue;
      try { last = JSON.parse(js); } catch { /* 半截记录，跳过 */ }
    }
  }
  if (!last) throw new Error('没读到 lingkuang-settings');
  const p = last.providers.find((x) => x.id === last.activeProvider) || last.providers[0];
  return p;
}

/* ── 2. 与 assoc.ts 逐字相同的一套解析（cleanWords 从 assoc.ts:315 抄的） ── */
function cleanWords(raw) {
  const strip = /^[\s\d\-—.*•·、，。！？、:：;；()（）\[\]【】"'“”‘’]+|[\s\d\-—.*•·、，。！？、:：;；()（）\[\]【】"'“”‘’]+$/g;
  return raw.split('\n').map((x) => x.trim()).map((x) => x.replace(strip, ''))
    .filter((x) => x.length >= 1 && x.length <= 8)
    .filter((x) => /[\u4e00-\u9fa5a-zA-Z0-9]/.test(x)).slice(0, 7);
}
const PROMPT = (w) => '你是词义联想引擎。给定一个词，生成 5-7 个不同的发散联想词。\n规则：1. 后一个词由前一个词自然联想而来 2. 词要具体、有画面感，2-4字中文名词为主 3. 输出格式：每行一个词，不要序号解释\n\n输入词：\n' + w;

(async () => {
  const w = process.argv[2] || '雪原';
  const p = readActiveProvider();
  console.log(`供应商 = ${p.name} · kind=${p.kind} · model=${p.model} · key=${p.apiKey ? '***' + p.apiKey.slice(-4) : '(空)'}`);
  const url = p.baseUrl.replace(/\/+$/, '') + (p.kind === 'openai' ? '/chat/completions' : '/api/chat');

  /* 逐个变体打一次，看 content / reasoning / finish_reason 的分配 */
  const variants = [
    { name: 'assoc.ts 现状（max_tokens 200）', body: { model: p.model, messages: [{ role: 'user', content: PROMPT(w) }], temperature: 0.8, max_tokens: 200 } },
    { name: '放大预算（max_tokens 2000）', body: { model: p.model, messages: [{ role: 'user', content: PROMPT(w) }], temperature: 0.8, max_tokens: 2000 } },
    { name: '不给上限（不发 max_tokens）', body: { model: p.model, messages: [{ role: 'user', content: PROMPT(w) }], temperature: 0.8 } },
    { name: '放大预算 + stream:true', body: { model: p.model, messages: [{ role: 'user', content: PROMPT(w) }], temperature: 0.8, max_tokens: 2000, stream: true } },
  ];

  for (const v of variants) {
    let r, raw;
    try { r = await fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, p.kind === 'openai' ? { Authorization: 'Bearer ' + p.apiKey } : {}), body: JSON.stringify(v.body) }); }
    catch (e) { console.log(`\n[${v.name}] FAIL 连不上 ${p.baseUrl}：${e.message}`); continue; }
    raw = await r.text();
    if (!r.ok) { console.log(`\n[${v.name}] HTTP ${r.status}：${raw.slice(0, 200)}`); continue; }

    let content = '', reasoning = '', finish = '';
    if (v.body.stream) {                     /* SSE：逐块拼 */
      for (const line of raw.split('\n')) {
        const d = line.trim().replace(/^data:\s*/, '');
        if (!d || d === '[DONE]') continue;
        let o; try { o = JSON.parse(d); } catch { continue; }
        const ch = o.choices?.[0] ?? {};
        if (typeof ch.delta?.content === 'string') content += ch.delta.content;
        if (typeof ch.delta?.reasoning_content === 'string') reasoning += ch.delta.reasoning_content;
        if (ch.finish_reason) finish = ch.finish_reason;
      }
    } else {
      const j = JSON.parse(raw);
      const m = j.choices?.[0]?.message ?? {};
      content = typeof m.content === 'string' ? m.content : '';
      reasoning = [m.reasoning_content, m.reasoning].find((x) => typeof x === 'string' && x) || '';
      finish = j.choices?.[0]?.finish_reason ?? j.done_reason ?? '';
    }
    const oldWords = cleanWords(content || '');            /* assoc.ts:531 */
    const newWords = cleanWords(content || reasoning || '');  /* ai.ts:146 的兜底 */
    console.log(`\n[${v.name}] HTTP ${r.status} · finish=${finish} · content=${content.length} 字 · reasoning=${reasoning.length} 字`);
    console.log(`   content 原文：${JSON.stringify(content.slice(0, 120))}`);
    console.log(`   旧解析（content 才算）   → ${oldWords.length} 词 ${JSON.stringify(oldWords)}`);
    console.log(`   新解析（reasoning 兜底） → ${newWords.length} 词 ${JSON.stringify(newWords)}`);
  }
})();
