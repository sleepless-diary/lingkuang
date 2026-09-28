/* 灵感触发器 · 语义联想：**推理模型的"思考吃光输出预算"**回归 5 项
 *（用户 2026-09-28：「为什么我灵感触发器的语义联想用不了了」）
 *
 * 现象与真因（实测，2026-09-28 拿用户当前供应商 DeepSeek · deepseek-flash 打真请求）：
 *   `src/ui/assoc.ts` 的 `callAssociate()` 原来**自己拼 fetch**，写死 `max_tokens: 200`（Ollama 线 `num_predict: 200`），
 *   且正文只认 `message.content`。推理模型先吐一大段 `reasoning_content` 再吐正文 ⇒ 200 个 token 全被思考吃掉：
 *     参数                 finish_reason   content   reasoning   能解析出的词
 *     max_tokens 200       length          0 字      296 字      0 词   ← 用户看到的
 *     max_tokens 2000      stop            20 字     1342 字     7 词
 *     不发上限             stop            20 字     2100 字     7 词
 *   ⇒「联想 0 词」、画布上一个新词都不长 = 用户说的"用不了了"。
 *   修法：这一段改走 `src/ui/ai.ts` 的统一出口 `aiChat`（不传 numPredict ⇒ 一个输出上限都不发；
 *   正文空时那边拿思考兜底 `text || thinking`，见 `src/ui/ai.ts` 的 aiChatStream/146）。
 *
 * 本套件把 `window.fetch` 换成一个**回放**（不是真连模型）：录下请求体，回一个
 * 「content 空 + reasoning_content 有词 + finish_reason: length」的整包 JSON —— 就是真机抓到的那个形状。
 *   A/B：旧构建 ★1（不发 max_tokens）与 ★3（拿思考兜底长出节点）都红，新构建全绿。
 *
 * 用法（见 tools/e2e/README.md）：
 *   $env:LINGKUANG_* 指向测试目录 → 起应用（--remote-debugging-port=9500）→ node tools/e2e/assoc-reasoning.cjs
 * ⚠️ 测试实例是 showInactive ⇒ rAF 不自己推进，力导向出帧靠 forceFrames()。
 * ⚠️ 夹具自己往 localStorage 塞一份 openai 协议的供应商（假的 key —— fetch 已被换掉，不会真发出去），
 *    为的是走与用户同一条线（OpenAI 线才发 `max_tokens`，Ollama 线走 options）。 */
const PORT = process.env.LK_CDP_PORT || '9500';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }

async function main() {
  let target = null;
  for (let i = 0; i < 120; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (target) break; } catch {}
    await sleep(200);
  }
  if (!target) { console.log(`FAIL 无法连接 CDP ${PORT}`); process.exit(1); }
  const w = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; });
  let id = 0; const pending = new Map();
  w.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); w.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  const forceFrames = async (n = 20) => {
    for (let i = 0; i < n; i++) { await send('Page.captureScreenshot', { format: 'jpeg', quality: 10 }); await sleep(25); }
  };
  const WORDS = ['驯鹿', '雪橇', '铃铛', '木屋', '炉火', '热茶', '毛毯'];

  /* 先整页重载：本套件会被反复跑（A/B 时要跑两遍），而画布的 `assocSetRoot` 遇到"同词根"只聚焦不重建 ⇒
     不重载的话第二次跑不会发请求，`window.__seen.body` 永远是 null（假 FAIL）。
     重载期间 CDP 的执行上下文会被换掉（读数抛异常）⇒ 用容错的 evSoft 轮询。 */
  const evSoft = async (expr) => { try { return await ev(expr); } catch { return undefined; } };
  await send('Page.enable', {});
  await send('Page.reload', {});
  for (let i = 0; i < 60 && !(await evSoft(`!!document.querySelector('[data-tool="inspire"]')`)); i++) await sleep(200);

  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);

  /* ── ★0 前置：一份 openai 协议的供应商（真机形状；key 是假的，fetch 已被换掉） ── */
  await ev(`(() => {
    const s = JSON.parse(localStorage.getItem('lingkuang-settings') || '{}');
    s.providers = [{ id: 'probe', name: '回放供应商', preset: 'custom', kind: 'openai', baseUrl: 'https://example.invalid/v1', apiKey: 'sk-probe', model: 'reasoner-probe' }];
    s.activeProvider = 'probe';
    localStorage.setItem('lingkuang-settings', JSON.stringify(s));
    return true; })()`);
  const seeded = await ev(`(() => { const s = JSON.parse(localStorage.getItem('lingkuang-settings')); return { n: s.providers.length, active: s.activeProvider, kind: s.providers[0].kind }; })()`);
  check('★0 前置：当前在用 = 一条 openai 协议的供应商', seeded && seeded.n === 1 && seeded.active === 'probe' && seeded.kind === 'openai', seeded);

  /* ── 回放：录请求体 + 回「content 空 / reasoning 有词 / finish_reason length」 ── */
  await ev(`(() => {
    window.__seen = { body: null };
    const reply = { choices: [{ message: { role: 'assistant', content: '', reasoning_content: ${JSON.stringify(WORDS.join('\n'))} }, finish_reason: 'length' }] };
    window.fetch = async (url, init) => {
      window.__seen.body = init && init.body ? String(init.body) : null;
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    return true; })()`);

  /* 壳的左栏是渲染之后才挂上去的：点之前再轮询一次（重载后偶发还没挂上 → 旧写法会直接抛 null.click） */
  const waitFor = async (expr, tries = 60) => { for (let i = 0; i < tries; i++) { if (await evSoft(expr)) return true; await sleep(200); } return false; };
  const shellReady = await waitFor(`!!document.querySelector('[data-tool="inspire"]')`);
  check('★0c 前置：左栏的「灵感触发器」按钮在', shellReady === true, shellReady);
  await ev(`document.querySelector('[data-tool="inspire"]').click(); true`);
  await waitFor(`!!document.querySelector('#assoc-stage')`, 40);
  const hasStage = await ev(`!!document.querySelector('#assoc-stage')`);
  check('★0b 前置：灵感触发器的联想画布挂上了', hasStage === true, hasStage);

  await ev(`document.querySelector('#insp-assoc').assocSetRoot('雪原'); true`);
  for (let i = 0; i < 40 && !(await ev(`(window.__seen || {}).body !== null`)); i++) await sleep(150);
  await forceFrames(30);

  const seen = await ev(`(() => { const b = window.__seen.body; if (!b) return null; const j = JSON.parse(b); return { keys: Object.keys(j), max_tokens: j.max_tokens, stream: j.stream, model: j.model, user: j.messages && j.messages[0] && j.messages[0].role }; })()`);

  /* ★1 用户那条 bug 的直接指纹：输出上限不许再写死（旧构建 = 200） */
  check('★1 请求体里**没有**写死的输出上限 max_tokens（旧构建 200）',
    seen && seen.max_tokens === undefined, seen && { max_tokens: seen.max_tokens, keys: seen.keys });
  /* ★2 走统一出口（流式那条路）——自己拼 fetch 的旧写法没有 stream 键 */
  check('★2 请求体带 stream: true（＝走 src/ui/ai.ts 的 aiChatStream，不再自己拼 fetch）',
    seen && seen.stream === true, seen && { stream: seen.stream });

  const st = await ev(`(() => {
    const els = [...document.querySelectorAll('#assoc-world .assoc__node')];
    return { status: (document.querySelector('#assoc-status') || {}).textContent || '', nodes: els.length,
      words: els.map((e) => e.textContent), reasoningShown: els.length > 0 }; })()`);

  /* ★3 content 空、词在 reasoning 里 ⇒ 仍然要长出节点（旧构建 0 个） */
  check('★3 正文为空、词在思考里 ⇒ 画布仍长出联想词（旧构建 0 个）',
    st && st.nodes >= 5 && st.words.some((x) => x.includes('驯鹿')), st && { nodes: st.nodes, words: st.words });
  /* ★4 状态行说得出数量，不是「联想 0 词」 */
  check('★4 状态行报得出「联想 N 词」（旧构建「联想 0 词」）',
    st && /联想 [1-9]\d* 词/.test(st.status), st && { status: st.status });

  const errs = await ev(`window.__errs`);
  check('★5 全程无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const bad = results.filter((x) => !x).length;
  console.log(`\n${results.length - bad}/${results.length} PASS`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.log('FAIL 套件异常：' + (e && e.stack ? e.stack : e)); process.exit(1); });
