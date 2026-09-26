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
 *   ★6~★9 思考（2026-09-26 用户：「看不到他的思考诶，怎么办」）：推理模型的
 *      `reasoning_content` / `thinking` 得**看得见** —— 生成中摊开且在长、排在正文上面（★6），
 *      落定折叠成一行「思考 · N 字」且不思考的回合不留空块（★7），跟着消息落进
 *      `sessions.json` 的主会话（★8），重开面板能从历史里重画出来（★9）。
 *
 * 假引擎四种写法见 src/ui/agent-model.ts；本套件用其中两种：
 *   字符串        （旧构建也认，保证 ★1 能在旧构建上跑到"渲染"这一步再 FAIL）
 *   { chunks, gap, truncated, reasoning }  （只有新构建认 ⇒ 旧构建会落到假端点，从而 ★3/★4/★6~★9 FAIL）
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

  /* ---------- ①b 模型不吐思考时必须说明原因（用户 2026-09-26 实测在用 qwen2.5:7b ⇒ 一个字都没有，
     界面上分不清「功能没做」还是「这个模型没有」） ---------- */
  const noteOf = () => ev(`(function () { const n = document.getElementById('lk-agent-note'); return { text: n ? n.textContent : '', err: n ? n.classList.contains('is-err') : false }; })()`);
  const n1 = await noteOf();
  check('★1b ⭐模型不吐思考时，底部说明一次原因（旧构建：屏幕上一点痕迹都没有）',
    String(n1.text).indexOf('不吐思考过程') >= 0 && n1.err === false, n1);

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

  const n3 = await noteOf();
  check('★3b 这条说明只出现一次 —— 后面不吐思考的回合不再重复念它（不然每轮都在吵）',
    String(n3.text).indexOf('不吐思考过程') < 0, n3);

  /* ---------- ④ 被截断要如实说 ---------- */
  await ev(`window.__lkAgentMock = { chunks: ['这是一段被模型输出上限切掉的'], gap: 30, truncated: true }; true`);
  await ask('说个会被截断的。');
  await sleep(1200);
  const note = await ev(`(function () { const n = document.getElementById('lk-agent-note'); return { text: n ? n.textContent : '', err: n ? n.classList.contains('is-err') : false }; })()`);
  check('★4 ⭐模型真的被输出上限切了时，底部如实说「被截断了」（旧构建闷声给半句话，界面上什么都没有）',
    note.text.indexOf('截断') >= 0 && note.err === true, note);

  /* ---------- ⑥ 思考流式可见（用户 2026-09-26：「看不到他的思考诶，怎么办」） ----------
     旧构建：`reasoning_content`（DeepSeek 兼容）/ `thinking`（Ollama）**收了却只当"正文为空时的兜底"**
     （`ai.ts` 的 `text || thinking`）⇒ 屏幕上一个字都没有。这一段用 mock 的 `reasoning` 分片喂
     `onReasoning`，量的仍是**屏幕上真的长什么样**：块在不在、摊没摊开、在不在长、是不是排在正文上面。 */
  const RSN = ['第一段思考：', '先看用户问的是不是三件事。', '答案是三件事。', '先给结论，', '再补理由，', '最后收尾。'];
  const CH2 = ['结论一。', '结论二。', '结论三。'];
  const RSN_ALL = RSN.join('');
  const thinkWalk = () => ev(`(function () {
    const ts = [...document.querySelectorAll('#lk-agent-msgs .lk-think')];
    const t = ts.length ? ts[ts.length - 1] : null;
    if (!t) return { has: false, n: ts.length };
    const body = t.querySelector('.lk-think__body');
    const sum = t.querySelector('.lk-think__sum');
    const bs = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')];
    const b = bs.length ? bs[bs.length - 1] : null;
    return {
      has: true, n: ts.length, live: t.classList.contains('is-live'), open: t.open,
      len: body ? (body.textContent || '').length : -1,
      text: body ? (body.textContent || '') : '',
      sum: sum ? (sum.textContent || '') : '',
      above: !!(b && (t.compareDocumentPosition(b) & 4)),
    };
  })()`);
  await ev('window.__lkAgentMock = { chunks: ' + JSON.stringify(CH2) + ', reasoning: ' + JSON.stringify(RSN) + ', gap: 260 }; true');
  await ask('带上你的思考再说一次。');
  let tLive = null;
  for (let i = 0; i < 10 && !(tLive && tLive.has); i++) { await sleep(80); tLive = await thinkWalk(); }
  await sleep(400);
  const tMid = await thinkWalk();
  await sleep(2600);
  const tEnd = await thinkWalk();
  check('★6 ⭐思考看得见：生成中挂着一块摊开的「思考」（.is-live + open、排在气泡**上面**）且文字还在长',
    !!(tLive && tLive.has === true && tLive.live === true && tLive.open === true && tLive.above === true
      && tLive.len > 0 && tLive.len < RSN_ALL.length) && tMid.len >= tLive.len,
    { tLive, tMid });
  check('★7 ⭐落定后思考折叠成一行「思考 · N 字」、正文照常；不思考的那些回合不留空块（n === 1）',
    tEnd.has === true && tEnd.live === false && tEnd.open === false && tEnd.text === RSN_ALL
      && tEnd.sum.indexOf('思考') === 0 && tEnd.n === 1,
    tEnd);

  /* ---------- ⑦ 思考跟着消息落盘 + 重开面板还能翻出来 ---------- */
  await sleep(900);   /* agentSave 有 400ms 防抖 */
  const disk = await ev(`(async function () {
    const d = await window.lingkuangAPI.agentLoad();
    const ss = (d && d.sessions) || [];
    const m = ss.find((s) => s.role === 'main');
    const h = (m && m.history) || [];
    const last = h.slice().reverse().find((x) => x.role === 'assistant') || null;
    return { n: ss.length, hasMain: !!m, cnt: h.length, reason: last ? String(last.reasoning || '') : '' };
  })()`);
  check('★8 ⭐思考过程跟着消息落进 sessions.json 的主会话（旧构建根本没这个字段）',
    !!disk && disk.hasMain === true && disk.reason === RSN_ALL, disk);

  await ev(`(function () { const b = document.getElementById('lk-agent-close'); if (b) b.click(); return true; })()`);
  await sleep(700);
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
  await sleep(1100);
  const tRe = await thinkWalk();
  check('★9 ⭐重开面板：思考是从历史里重画出来的（折叠着、文字仍是原来那段）',
    tRe.has === true && tRe.live === false && tRe.open === false && tRe.text === RSN_ALL && tRe.n === 1, tRe);

  /* ---------- ⑧ ⭐**生成中**的思考块自己不许被压扁（用户 2026-09-26 第二轮：「用 deepseek 只能显示思考中」） ----------
     病根：生成中那一块是 `#lk-agent-msgs` 的**直接**子元素，而消息列是
     `display:flex; flex-direction:column; overflow-y:auto`；`.lk-think` 自带 `overflow:hidden`（体内还叠
     `overflow-y:auto`）⇒ flex 项的**自动最小尺寸退化成 0** ⇒ 列表一长就被压到 **2px**，标题（20px）与
     正文（~240px）被自己裁掉 ⇒ 屏幕上只剩气泡里那句「正在思考…」（用户看到的正是这个）。
     落定后 `renderMsgs()` 把它挪进消息内部、不再是弹性项 ⇒ **点开历史那一条一直是好的**。
     ⇒ 必须在**生成中**量（量折叠态/落定态都量不出这个坑，第一版守卫就是这么白跑的）。
     先灌 5 条长消息把列表撑到确定溢出（负数空闲空间才会触发收缩）。 */
  const LONG10 = '这一段用来把消息列表撑到溢出。'.repeat(40);
  for (let i = 0; i < 5; i++) {
    await ev('window.__lkAgentMock = ' + JSON.stringify('[撑高度 ' + i + '] ' + LONG10) + '; true');
    await ask('撑高度 ' + i);
    await sleep(700);
  }
  const RSN2 = [];
  for (let i = 0; i < 8; i++) RSN2.push('把这件事想清楚：先看用户要什么，再看手里有哪些线索，然后一条条对起来。');
  await ev('window.__lkAgentMock = { chunks: ["结论如下。"], reasoning: ' + JSON.stringify(RSN2) + ', gap: 400 }; true');
  await ask('带一段长思考再说一次。');
  const liveGeom = () => ev(`(function () {
    const box = document.getElementById('lk-agent-msgs');
    if (!box) return { has: false };
    const t = box.querySelector(':scope > .lk-think');   /* 生成中那一块是盒子的直接子元素 */
    if (!t) return { has: false };
    const det = t.getBoundingClientRect();
    const body = t.querySelector('.lk-think__body');
    const br = body ? body.getBoundingClientRect() : null;
    const sum = t.querySelector('.lk-think__sum');
    const sr = sum ? sum.getBoundingClientRect() : null;
    return {
      has: true, live: t.classList.contains('is-live'), open: t.open,
      overflow: box.scrollHeight > box.clientHeight + 1,
      thinkH: Math.round(det.height), sumH: sr ? Math.round(sr.height) : -1,
      bodyH: br ? Math.round(br.height) : -1,
      bodyLen: body ? (body.textContent || '').length : -1,
      spillPx: br ? Math.round(br.bottom - det.bottom) : -1,
      sumSpillPx: sr ? Math.round(sr.bottom - det.bottom) : -1,
    };
  })()`);
  let g10 = null;
  for (let i = 0; i < 25; i++) {
    await sleep(160);
    const g = await liveGeom();
    if (g && g.has === true && g.live === true && g.bodyLen > 120) { g10 = g; break; }
  }
  check('★10 ⭐生成中的思考块自己不被压扁：盒子高度容得下标题 + 正文（旧 CSS 实测 details 只有 2px、标题 20px/正文 100px 全被 overflow:hidden 裁掉 ⇒ 屏幕上只剩气泡里那句「正在思考…」）',
    !!g10 && g10.live === true && g10.overflow === true && g10.bodyLen > 120
      && g10.thinkH >= g10.sumH + Math.min(g10.bodyH, 60) - 6
      && g10.spillPx <= 2 && g10.sumSpillPx <= 2, g10);
  /* ★11 ⭐屏幕上的「活的荧光绿」只许一处（用户 2026-09-26：「怎么又用到了荧光绿的颜色，
     两个都是高亮度我有点难分辨」）。生成中同屏本来有两个：流式光标（正文末尾，accent）与
     「思考 · N 字」后面那颗闪点 —— 同色（#9ec262）+ 同一支 `lk-md-blink` 同时起步 ⇒ 完全同步地闪，
     却在说两件事（一个"正在写"、一个"还在想"）⇒ 分不清。
     判据：拿**光标自己的**颜色当基准（不写死色值），要求除它以外没有任何同色的活指示器。
     旧构建读数 others:["think-dot"] ⇒ FAIL；修后 others:[] ⇒ PASS。 */
  const greens = await ev(`(function () {
    const panel = document.getElementById('lk-agent-panel');
    if (!panel) return { has: false };
    const caret = panel.querySelector('.lk-md__caret');
    if (!caret) return { has: true, caret: false };
    const ref = getComputedStyle(caret).backgroundColor;
    const others = [];
    const title = panel.querySelector('.lk-agent__title');
    if (title) {
      const cs = getComputedStyle(title, '::before');
      if (cs.content !== 'none' && cs.backgroundColor === ref) others.push('title-dot');
    }
    const think = panel.querySelector('.lk-think.is-live');
    let thinkBg = null;
    if (think) {
      const sum = think.querySelector('.lk-think__sum');
      const cs = sum ? getComputedStyle(sum, '::after') : null;
      if (cs) {
        thinkBg = cs.backgroundColor;
        if (cs.content !== 'none' && cs.backgroundColor === ref) others.push('think-dot');
      }
    }
    return { has: true, caret: true, ref: ref, others: others, n: others.length, live: !!think, thinkBg: thinkBg };
  })()`);
  /* 两道判据缺一不可：① 不能和光标同色（分不清）；② 它自己**必须在场**（非透明）——
     第二道是防"假绿"：`var(--muted)` 当时在 `src/style.css` 里**没定义**，
     `background` 拿到非法值就是 `transparent` ⇒ 点直接消失，而"不是 accent"这条照样满足。
     实测踩到：只查颜色时 14/14 全绿，截图里那颗点已经没影了。 */
  const thinkSolid = !!greens && typeof greens.thinkBg === 'string'
    && greens.thinkBg !== 'rgba(0, 0, 0, 0)' && greens.thinkBg !== 'transparent';
  check('★11 ⭐同屏只有一处「活的荧光绿」：生成中光标在、思考那块的闪点与它**不同色且真的看得见**（旧构建两个同色同节奏 ⇒ 分不清；只查颜色会漏掉"令牌没定义 ⇒ 点变透明"）',
    !!greens && greens.caret === true && greens.live === true && greens.n === 0 && thinkSolid, greens);

  await sleep(2600);   /* 让它跑完再去看异常列表 */

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
