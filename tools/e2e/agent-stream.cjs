/* agent-stream.cjs —— 灵框 AI 输出的三件事：**不截断 / 流式 / markdown 渲染**
 *
 * 用户原话（2026-09-26）：「ai的输出被截断了，还有我想要流式输出，以及ai的回答没被渲染，
 * 如**文字**这种」⇒ 三条都是"看得见"的问题，所以这份套件量的也是**屏幕上真的长什么样**：
 *
 *   ★1 markdown 真被渲染：气泡里是 <strong>/<code>/<li>/<h*>，而不是字面的 `**粗体**`
 *      （旧代码 = escapeHtml(整段) ⇒ 星号原样可见）；
 *   ★2 不截断：发出去的请求体里**没有**输出上限（旧代码固定 max_tokens / num_predict 900）
 *      —— 这条用假端点（stub window.fetch）抓请求体，不真联网；顺带验证
 *      "端点不理会 stream、直接回整包 JSON"也吃得下；
 *   ★3 流式：分片假引擎逐片喂增量 ⇒ (a) 过程里真的挂着一个"活气泡"（.is-live + 光标），
 *      (b) 气泡文本随分片**单调增长**（测试埋点 window.__lkStreamLog），(c) 落定后光标不残留；
 *   ★4 截断表态：模型真的被输出上限切了（finish_reason/done_reason = length）时，
 *      底部要如实说「被截断了」，而不是闷声给半句话。
 *
 * 假引擎四种写法见 src/ui/agent-model.ts；本套件用其中两种：
 *   字符串        （旧构建也认，保证 ★1 能在旧构建上跑到"渲染"这一步再 FAIL）
 *   { chunks, gap, truncated }  （只有新构建认 ⇒ 旧构建会落到假端点，从而 ★3/★4 FAIL）
 *
 * 前置（同一 pwsh 调用里做，再起实例）：
 *   $env:LINGKUANG_TEST_DATA=<lk-evault2>\worldbuilding.json; $env:LINGKUANG_VAULT=<lk-evault2>\vault
 *   $env:LINGKUANG_TEST_USERDATA=<lk-evault2>\userdata
 *   node tools\e2e\reset-entity-vault.cjs; node tools\e2e\seed-node.cjs
 * 跑：$env:LK_CDP_PORT=9346; node tools\e2e\agent-stream.cjs
 */
const PORT = process.env.LK_CDP_PORT || '9346';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(n, ok, extra) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);
}

async function main() {
  /* ---------- 连 CDP ---------- */
  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* 还没起来 */ }
    if (!target) await sleep(200);
  }
  if (!target) { console.log('FAIL 无法连接 CDP ' + PORT); process.exit(1); }
  const w = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  w.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  const send = (method, params) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    w.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const ex = r.result && r.result.exceptionDetails;
    if (ex) throw new Error('eval: ' + ((ex.exception && ex.exception.description) || ex.text));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  /* ---------- 打开工作台 + 助手面板 ---------- */
  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(`document.querySelector('#lk-toolbar [data-tool="codex"]').click(); true`);
  await sleep(1200);
  await ev(`(function () { const r = document.querySelector('#cx-list [data-cx-id]'); if (r) r.click(); return true; })()`);
  await sleep(600);
  await ev(`(function () { const b = document.getElementById('lk-agent-close'); if (b) b.click(); return true; })()`);
  await sleep(400);

  const ask = async (text) => {
    await ev(`(function () { const t = document.getElementById('lk-agent-input'); t.value = ${JSON.stringify(text)}; document.getElementById('lk-agent-send').click(); return true; })()`);
  };
  /* 假端点：只记请求体、立刻回一整包（**不理会 stream 的中转**）。
     ⚠️ 早早就装上：旧构建不认分片假引擎，会落到真实通道 —— 有它兜着就不会去连本机 Ollama（可能一等等十秒）。*/
  await ev(`(function () {
    window.__reqLog = [];
    if (!window.__fetchReal) window.__fetchReal = window.fetch;
    window.fetch = function (url, init) {
      let body = null;
      try { body = JSON.parse((init && init.body) || '{}'); } catch (e) { body = null; }
      window.__reqLog.push({ url: String(url), body: body });
      return Promise.resolve(new Response(JSON.stringify({ message: { content: '来自假端点的回复' }, done: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }));
    };
    return true;
  })()`);

  const pre = await ev(`({
    tools: [...document.querySelectorAll('#lk-toolbar .lk-tool-btn')].map((b) => b.dataset.tool),
    panel: !!document.getElementById('lk-agent-panel'),
  })`);
  check('★0 前置：工作台开着、助手按钮在、此刻没有面板',
    pre.tools.includes('agent') === true && pre.panel === false, pre);

  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
  await sleep(700);
  const shell = await ev(`({
    msgs: !!document.getElementById('lk-agent-msgs'),
    input: !!document.getElementById('lk-agent-input'),
    sendBtn: !!document.getElementById('lk-agent-send'),
    note: !!document.getElementById('lk-agent-note'),
  })`);
  if (!shell.msgs || !shell.sendBtn || !shell.note) {
    check('★0b 助手面板骨架就位（#lk-agent-msgs / #lk-agent-input / #lk-agent-send / #lk-agent-note）', false, shell);
    console.log(`==== ${results.filter(Boolean).length}/${results.length} PASS ====`);
    process.exit(1);
  }

  /* ---------- ① markdown 真被渲染 ---------- */
  /* ⭐ 反引号不能出现在模板字符串里（e2e 页面代码住在模板串里），所以样例里用 String.fromCharCode(96) 拼行内码 */
  const BT = String.fromCharCode(96);
  const MD = '# 三件事\n第一件是**粗体**，第二件是' + BT + '行内码' + BT + '。\n\n- 甲项\n- 乙项\n\n> 引用一行';
  await ev('window.__lkAgentMock = ' + JSON.stringify(MD) + '; true');
  await ask('渲染一下格式。');
  await sleep(1200);
  const md = await ev(`(function () {
    const bs = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')];
    const b = bs.length ? bs[bs.length - 1] : null;
    if (!b) return null;
    return {
      n: bs.length,
      mdClass: b.classList.contains('lk-md'),
      strong: b.querySelectorAll('strong').length,
      code: b.querySelectorAll('code').length,
      li: b.querySelectorAll('li').length,
      head: b.querySelectorAll('h1,h2,h3').length,
      bq: b.querySelectorAll('blockquote').length,
      hasAsterisk: (b.textContent || '').indexOf('**') >= 0,
      text: (b.textContent || '').slice(0, 40),
    };
  })()`);
  check('★1 ⭐AI 的气泡里 markdown 真被渲染（strong / code / li / 标题 / 引用都在），屏幕上再也看不到字面的星号',
    !!md && md.mdClass === true && md.strong >= 1 && md.code >= 1 && md.li >= 2 && md.head >= 1 && md.bq >= 1 && md.hasAsterisk === false,
    md);

  /* ---------- ② 不截断：发出去的请求体里没有输出上限 ---------- */
  await ev(`window.__lkAgentMock = undefined; window.__reqLog = []; true`);
  await ask('这一句走真实通道，看看请求体。');
  await sleep(1200);
  const req = await ev(`window.__reqLog`);
  const body = (Array.isArray(req) && req.length) ? req[0].body : null;
  const opts = (body && body.options) || {};
  const hasCap = !!(body && (body.max_tokens !== undefined || opts.num_predict !== undefined && opts.num_predict !== -1));
  const settled = await ev(`(function () {
    const bs = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')];
    const b = bs.length ? bs[bs.length - 1] : null;
    return b ? (b.textContent || '') : '';
  })()`);
  check('★2 ⭐请求体里没有输出上限（旧代码固定 900 ⇒ 长回答被切）；端点回整包 JSON 也吃得下',
    Array.isArray(req) && req.length === 1 && !!body && body.stream === true && hasCap === false
      && String(settled).indexOf('来自假端点的回复') >= 0,
    { url: req && req[0] && req[0].url, stream: body && body.stream, max_tokens: body && body.max_tokens, num_predict: opts.num_predict, settled: String(settled).slice(0, 24) });

  /* ---------- ③ 流式：过程里挂着活气泡、文本单调增长、落定不残留光标 ---------- */
  const CHUNKS = ['第一段：先说结论。', '第二段：接着说理由。', '第三段：收尾。'];
  const walk = (o) => ev(`(function () {
    const bs = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')];
    const b = bs.length ? bs[bs.length - 1] : null;
    return { n: bs.length, live: !!(b && b.classList.contains('is-live')), caret: !!document.querySelector('#lk-agent-msgs .lk-md__caret'), len: b ? (b.textContent || '').length : -1 };
  })()`);
  await ev(`window.__lkStreamLog = []; window.__lkAgentMock = { chunks: ${JSON.stringify(CHUNKS)}, gap: 150 }; true`);
  await ask('流式说三段。');
  const mid = await walk();
  await sleep(1600);
  const log = await ev(`window.__lkStreamLog`);
  const after = await walk();
  const lens = Array.isArray(log) ? log.map((x) => x.len) : [];
  let rising = lens.length >= 3;
  for (let i = 1; i < lens.length; i++) if (!(lens[i] > lens[i - 1])) rising = false;
  const finalBubble = await ev(`(function () {
    const bs = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')];
    const b = bs.length ? bs[bs.length - 1] : null;
    return b ? (b.textContent || '') : '';
  })()`);
  check('★3 ⭐流式：过程里真的挂着一个活气泡（.is-live + 光标）、文本随分片单调增长、落定后光标摘掉且文本等于全部分片',
    mid.live === true && mid.caret === true && mid.len > 0 && mid.len < String(finalBubble).length
      && rising === true && after.live === false && after.caret === false
      && String(finalBubble).indexOf(CHUNKS[0]) >= 0 && String(finalBubble).indexOf(CHUNKS[2]) >= 0,
    { mid, lens, after, settledLen: String(finalBubble).length, rising });

  /* ---------- ④ 被截断要如实说 ---------- */
  await ev(`window.__lkAgentMock = { chunks: ['这是一段被模型输出上限切掉的'], gap: 30, truncated: true }; true`);
  await ask('说个会被截断的。');
  await sleep(1200);
  const note = await ev(`(function () { const n = document.getElementById('lk-agent-note'); return { text: n ? n.textContent : '', err: n ? n.classList.contains('is-err') : false }; })()`);
  check('★4 ⭐模型真的被输出上限切了时，底部如实说「被截断了」（旧构建闷声给半句话，界面上什么都没有）',
    note.text.indexOf('截断') >= 0 && note.err === true, note);

  const errs = await ev(`window.__errs`);
  check('★5 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`==== ${pass}/${results.length} PASS ====`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : String(e)));
  process.exit(2);
});
