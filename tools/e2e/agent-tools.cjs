/* agent-tools.cjs —— 灵框助手的「动作」（片 3：只读即执行 / 写入变提议卡片 / 三档权限）
 *
 * 不变量（这份套件守的就是这四条）：
 *   ① 只读动作**立刻执行**，结果作为下一轮喂回模型（不是显示给你看就完了）；
 *   ② 写入动作**不直接落盘** —— 变成一张提议卡片，你点「应用」才改数据；
 *   ③ 权限档位说了算：只读档不执行、逐项确认档出卡片、YOLO 直接执行（写入路径只有一条）；
 *   ④ 不像动作的回复（工具名不认识 / 前面有散文）**当聊天**，不许悄悄执行。
 *
 * ⭐ 最要紧的几条断言：
 *   ★2 —— 只读结果真的进了**下一轮**喂给模型的 messages（而不是只画在屏幕上）；
 *   ★7 —— 点「应用」之前，数据一点没动（这才是「提议」的意义）；
 *   ★15 —— 「工具名当键」`{"set_field":{…}}` 也要认（用户 2026-09-15 实测踩到的形状，
 *          当时的解析器只认 `{"tool":…,"args":…}` ⇒ 整坨 JSON 被当聊天画到脸上、什么都没发生）；
 *   ★12 —— 认不出的裸 JSON 不再糊到脸上，而是回头纠正模型一次；
 *   ★19 —— ⭐**一次吐一串动作**（多个 JSON 连写）也要全部执行（用户 2026-10-10：「有时候工具
 *          打出来了但是无法调用，卡住了吗」：老解析器 `JSON.parse` 整段抛错 ⇒ 整坨当聊天画出来）；
 *   ★20/★21 —— ⭐**长的非正文块折起来**、点一下才摊平（用户 2026-10-10：「有时候非正文内容无法折叠」）。
 *
 * 假引擎：`window.__lkAgentMock`（见 src/ui/agent-model.ts）——本套件用**函数形态**
 * 顺手把喂进去的 messages 存进 `window.__lkSeen`，好断言提示词里到底有什么。
 *
 * 前置（同一 pwsh 调用里做，再重启实例）：
 *   $env:LINGKUANG_TEST_DATA=<lk-evault2>\worldbuilding.json; $env:LINGKUANG_VAULT=<lk-evault2>\vault
 *   $env:LINGKUANG_TEST_USERDATA=<lk-evault2>\userdata
 *   node tools\e2e\reset-entity-vault.cjs; node tools\e2e\seed-node.cjs; node tools\e2e\seed-agent-memory.cjs
 * 跑：$env:LK_CDP_PORT=9346; node tools\e2e\agent-tools.cjs
 */
const path = require('path');
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
  await ev(`document.querySelector('#cx-list [data-cx-id="e-e2e-1"]').click(); true`);
  await sleep(600);

  /* 自己把起点摆正：上一份套件（如 agent-memory）可能把助手面板留着开着 ——
     那样下面 Ctrl+K 反而会把它关掉、后面整串假挂。 */
  await ev(`(function () { const b = document.getElementById('lk-agent-close'); if (b) b.click(); return true; })()`);
  await sleep(400);

  const pre = await ev(`({
    tools: [...document.querySelectorAll('#lk-toolbar .lk-tool-btn')].map((b) => b.dataset.tool),
    panel: !!document.getElementById('lk-agent-panel'),
    rows: document.querySelectorAll('#cx-list [data-cx-id]').length,
    focus: (document.getElementById('lk-agent-focus') || {}).textContent || '',
  })`);
  check('★0 前置：工作台与设定库开着、助手按钮在、面板还没开', pre.tools.includes('agent') && pre.panel === false && pre.rows === 1, pre);

  /* ---------- 开面板（Ctrl+K）---------- */
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
  await sleep(500);

  /* 函数形态的假引擎：把每次喂进去的 messages 存起来，回复按队列取 */
  const setMock = async (queue) => ev(`window.__lkSeen = []; window.__lkMockQ = ${JSON.stringify(queue)}; window.__lkAgentMock = (m) => { window.__lkSeen.push(m); return window.__lkMockQ.length ? window.__lkMockQ.shift() : '好的。'; }; true`);
  const ask = async (text) => {
    await ev(`(function () { const t = document.getElementById('lk-agent-input'); t.value = ${JSON.stringify(text)}; document.getElementById('lk-agent-send').click(); return true; })()`);
    await sleep(1000);
  };
  /* 摆权限两旋钮（范围 × 询问）。⚠️ 顺序：先派 scope 的 change（处理器会把 ask 下拉重置成已存值），
     再写 ask.value 并派它的 change —— 反过来写会被 renderPerm() 覆盖掉。 */
  const setPerm = async (scope, ask) => {
    await ev(`(function () {
      const s = document.getElementById('lk-agent-scope');
      const a = document.getElementById('lk-agent-ask');
      s.value = ${JSON.stringify(scope)}; s.dispatchEvent(new Event('change', { bubbles: true }));
      a.value = ${JSON.stringify(ask)}; a.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(250);
  };
  const rows = () => ev(`document.querySelectorAll('#cx-list [data-cx-id]').length`);
  const calls = () => ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__call').length`);
  const callTexts = () => ev(`[...document.querySelectorAll('#lk-agent-msgs .lk-agent__call')].map((c) => c.textContent)`);
  const props = () => ev(`[...document.querySelectorAll('#lk-agent-msgs .lk-agent__prop')].map((p) => ({ settled: p.classList.contains('is-settled'), h: (p.querySelector('.lk-agent__prop-h') || {}).textContent || '', note: (p.querySelector('.lk-agent__prop-note') || {}).textContent || '' }))`);
  const noteText = () => ev(`(document.getElementById('lk-agent-note') || {}).textContent || ''`);
  /* 动作结果那一块（回执）—— 卡片退场之后，落盘的结果就靠它认 */
  const toolText = () => ev(`(function () { const t = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__tool')]; return t.length ? t[t.length - 1].textContent : ''; })()`);
  const lastBubble = () => ev(`(function () { const b = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')]; return b.length ? b[b.length - 1].textContent : ''; })()`);

  check('★1 面板开出来了（Ctrl+K）', (await ev(`!!document.getElementById('lk-agent-panel')`)) === true);

  /* ⭐ 模式（片 4，2026-09-26）：本套件测的是 **Agent 模式** 的行为（动作协议 / 提议卡片 / 闸门）。
     面板**默认是聊天模式**（平常聊天不注入协议、也不解析动作，见 `agent-mode.cjs`），
     所以这里必须先显式切过去 —— 否则下面每条都会因为"没有协议"而挂。 */
  await ev(`document.getElementById('lk-agent-mode-agent').click(); true`);
  await sleep(300);

  /* 权限档也自己摆正（同样防串跑：上一份套件可能停在 YOLO 档）。
     「默认档就是逐项确认」那条不变量由 agent-memory.cjs ★1 在干净实例上守。 */
  await setPerm('workspace', 'always');

  /* ---------- ① 只读动作立刻执行 ---------- */
  await setMock(['{"tool":"list_entities","args":{}}', '列表我看过了，设定不多。']);
  await ask('现在都有哪些设定？');
  const readRun = await ev(`({
    calls: document.querySelectorAll('#lk-agent-msgs .lk-agent__call').length,
    callText: (document.querySelector('#lk-agent-msgs .lk-agent__call') || {}).textContent || '',
    toolText: (document.querySelector('#lk-agent-msgs .lk-agent__tool') || {}).textContent || '',
    props: document.querySelectorAll('#lk-agent-msgs .lk-agent__prop').length,
  })`);
  check('★2 只读动作自动跑掉了、结果画出来了，而且没出提议卡片',
    readRun.calls === 1 && readRun.callText.indexOf('list_entities') >= 0 && readRun.toolText.indexOf('银发少女') >= 0 && readRun.props === 0, readRun);

  const seen = await ev(`({
    n: window.__lkSeen.length,
    second: window.__lkSeen.length > 1 ? JSON.stringify(window.__lkSeen[1]) : '',
    first: window.__lkSeen.length ? String(window.__lkSeen[0][0].content) : '',
  })`);
  check('★3 ⭐只读结果真的喂回了下一轮（模型看得见，不是只给你看）',
    seen.n === 2 && seen.second.indexOf('【动作结果：list_entities】') >= 0 && seen.second.indexOf('银发少女') >= 0,
    { n: seen.n, hasResult: seen.second.indexOf('【动作结果') >= 0, hasName: seen.second.indexOf('银发少女') >= 0 });
  check('★4 动作协议写进了系统提示（模型才知道能调什么，反面教材也在）',
    seen.first.indexOf('【你能用的动作】') >= 0 && seen.first.indexOf('{"tool":"read_entity"') >= 0 && seen.first.indexOf('不要写成') >= 0,
    { chars: seen.first.length, hasTools: seen.first.indexOf('【你能用的动作】') >= 0, hasExample: seen.first.indexOf('{"tool":"read_entity"') >= 0, hasWarn: seen.first.indexOf('不要写成') >= 0 });
  check('★5 只读动作结束后模型接着用普通话回答', (await lastBubble()).indexOf('列表我看过了') >= 0);

  /* ---------- ② 写入动作在「逐项确认」档 ⇒ 提议卡片 ---------- */
  const gate0 = await ev(`document.getElementById('lk-agent-panel').dataset.gate`);
  await setMock(['{"tool":"create_entity","args":{"name":"测试新条目","type":"角色"}}']);
  await ask('帮我建一条叫「测试新条目」的设定。');
  const card1 = await props();
  check('★6 写入动作在默认档变成了提议卡片（gate=' + gate0 + '）',
    gate0 === 'propose' && card1.length === 1 && card1[0].h.indexOf('测试新条目') >= 0 && (await noteText()).indexOf('应用') >= 0,
    { gate: gate0, cards: card1, note: await noteText() });

  check('★7 ⭐点「应用」之前，数据一点没动', (await rows()) === 1, { rows: await rows() });

  /* ---------- ③ 点「应用」才落盘 ---------- */
  await ev(`document.querySelector('#lk-agent-msgs [data-prop-ok="0"]').click(); true`);
  await sleep(800);
  const card1b = await props();
  /* ⭐ 用户 2026-10-10：「确认窗口在确认后不会消失，会随着 AI 的下一条回答出现」⇒ 点完「应用」卡片**当场退场**。
     判据从"卡片留在原地标 is-settled"改成"卡片没了 + 落盘的结果进了回执（`.lk-agent__tool`）"。 */
  check('★8 点「应用」之后才真落盘（设定树多一行 + 卡片当场退场 + 回执说清建了什么）',
    (await rows()) === 2 && card1b.length === 0 && (await toolText()).indexOf('测试新条目') >= 0,
    { rows: await rows(), cards: card1b.length, tool: await toolText() });

  /* ---------- ④「忽略」什么都不做 ---------- */
  await setMock(['{"tool":"create_entity","args":{"name":"测试被忽略","type":"角色"}}']);
  await ask('再建一条叫「测试被忽略」的。');
  const card2 = await props();
  await ev(`document.querySelector('#lk-agent-msgs [data-prop-no="1"]').click(); true`);
  await sleep(500);
  const card2b = await props();
  check('★9 点「忽略」= 什么都不做（树不动 + 被忽略那张也当场退场）',
    card2.length === 1 && (await rows()) === 2 && card2b.length === 0,
    { before: card2.length, after: card2b.length, rows: await rows() });

  /* ---------- ⑤ 只读档：不给执行 ---------- */
  await setPerm('readonly', 'always');
  const gateRo = await ev(`document.getElementById('lk-agent-panel').dataset.gate`);
  await setMock(['{"tool":"create_entity","args":{"name":"测试只读档","type":"角色"}}']);
  await ask('建一条叫「测试只读档」的。');
  /* ⚠️ 判据读**回执**（`.lk-agent__tool`）不读底部提示：第八十八轮起"写动作不再结束整轮"
     （写完接着往下做），底部那行会被下一轮的收尾提示顶掉 —— 留在消息区里的回执才是实话。 */
  const ro = { gate: gateRo, cards: (await props()).length, rows: await rows(), receipt: await toolText(), note: await noteText() };
  check('★10 只读档：不出卡片、不落盘、明白告诉你没执行',
    ro.gate === 'deny' && ro.cards === 0 && ro.rows === 2 && ro.receipt.indexOf('只读') >= 0, ro);

  /* ---------- ⑥ 直接执行档：不问，直接落盘 ---------- */
  await setPerm('workspace', 'never');
  const gateYolo = await ev(`document.getElementById('lk-agent-panel').dataset.gate`);
  await setMock(['{"tool":"create_entity","args":{"name":"测试自动","type":"角色"}}']);
  await ask('建一条叫「测试自动」的。');
  const yolo = {
    gate: gateYolo, cards: (await props()).length, rows: await rows(),
    stored: await ev(`(function () { const s = JSON.parse(localStorage.getItem('lingkuang-settings') || '{}'); return String(s.agentScope || '') + '+' + String(s.agentAsk || ''); })()`),
    receipt: await toolText(),
    note: await noteText(),
    seen: await ev(`(window.__lkSeen || []).length`),
  };
  check('★11 直接执行档（可写 + 不询问）：不用点，直接就落盘了（两旋钮也存进了设置）',
    yolo.gate === 'allow' && yolo.cards === 0 && yolo.rows === 3 && yolo.stored === 'workspace+never' && yolo.receipt.indexOf('已新建设定') >= 0, yolo);
  /* ⭐ 第八十八轮（用户 2026-10-16：「**有时候会断**」）：写动作**不再结束整轮** ——
     真机会话取证：最后两条就是【动作结果：read_many】+【动作结果：create_timeline】，
     模型自己说要"读完一批立刻建条目"，可写完这一步整轮就结束了，创作者得再催一句才动。
     ⇒ 现在「自动」档写完接着跑下一轮（模型下一轮会读到刚才那条回执）。旧构建这里只有 1 次请求。 */
  check('★11b ⭐写完之后**接着跑**（不再停在落盘那一步等创作者催）：模型被再叫了一轮',
    yolo.seen >= 2, { seen: yolo.seen });

  /* ---------- ⑦ 认不出的裸 JSON ⇒ 回头纠正一次（不糊到创作者脸上）---------- */
  const callsBefore = await calls();
  await setMock(['{"tool":"fly_to_moon","args":{}}', '我在。']);
  await ask('随便试试。');
  const unknown = {
    before: callsBefore,
    calls: await calls(),
    texts: await callTexts(),
    cards: (await props()).length, rows: await rows(),
    note: await noteText(),
    /* ⭐ 裸 JSON 不许出现在任何气泡里（用户实测就是被这坨 JSON 糊了一脸） */
    dumped: await ev(`[...document.querySelectorAll('#lk-agent-msgs .lk-agent__bubble')].some((b) => b.textContent.indexOf('fly_to_moon') >= 0)`),
    seen: await ev(`window.__lkSeen.length > 1 ? String(window.__lkSeen[1][window.__lkSeen[1].length - 1].content) : ''`),
    last: await lastBubble(),
  };
  check('★12 认不出的裸 JSON：回头纠正一次，不冒卡片、不落盘、也不把 JSON 当回答画出来',
    unknown.calls === callsBefore && unknown.cards === 0 && unknown.rows === 3 && unknown.dumped === false &&
    unknown.seen.indexOf('【格式提醒】') >= 0 && unknown.last.indexOf('我在。') >= 0,
    unknown);

  /* ---------- ⑧ 名字当键（用户 2026-09-15 实测的形状）也要认 ---------- */
  await setPerm('workspace', 'always');
  await setMock(['{"set_field":{"entity":"银发少女","field":"发色","value":"墨黑"}}']);
  await ask('把银发少女的发色改成墨黑。');
  const keyed = await props();
  check('★15 ⭐「工具名当键」的形状也认下来了（这次真的出卡片而不是一坨 JSON）',
    keyed.length === 1 && keyed[0].h.indexOf('改字段：银发少女 · 发色') >= 0 && (await rows()) === 3,
    { cards: keyed.length, card: keyed[0], note: await noteText() });

  /* 点它：`data-prop-ok="2"` 是 **cards 里的原下标**（前面两张已处理过、DOM 里已经没有了，
     但下标不许重排 —— 这正是 ★16 顺带守的那条）。 */
  await ev(`document.querySelector('#lk-agent-msgs [data-prop-ok="2"]').click(); true`);
  await sleep(700);
  const keyedGone = await props();
  await setMock(['{"tool":"read_entity","args":{"name":"银发少女"}}', '好，我记住了。']);
  await ask('再看一眼她的发色。');
  const afterApply = {
    cardsAfterApply: keyedGone.length,
    /* ⭐ 用户 2026-10-10 报的那条：**AI 下一条回答来了之后**，处理过的卡片不许再被端上来 */
    cardsAfterNext: (await props()).length,
    tool: await toolText(),
  };
  check('★16 应用之后字段真的变了（再读一次：发色=墨黑）；⭐ 卡片当场退场，下一条回答来了也不再端上来（用户 2026-10-10：「确认窗口在确认后不会消失，会随着AI的下一条回答出现」）',
    keyedGone.length === 0 && afterApply.cardsAfterNext === 0 && afterApply.tool.indexOf('发色=墨黑') >= 0,
    afterApply);

  /* ---------- ⑨ 参数写成裸值（{"search":"银发"}）也要认 ---------- */
  const c17 = await calls();
  await setMock(['{"search":"银发"}', '找到了。']);
  await ask('搜一下「银发」。');
  const bare = {
    before: c17, calls: await calls(),
    tool: await ev(`(function () { const t = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__tool')]; return t.length ? t[t.length - 1].textContent : ''; })()`),
  };
  check('★17 参数写成裸值也认（search 的主参数兜成 q）',
    bare.calls === c17 + 1 && bare.tool.indexOf('银发少女') >= 0, bare);

  /* ---------- ⑩ 纠正之后模型照办了 ⇒ 动作真的跑起来 ---------- */
  const c18 = await calls();
  await setMock(['{"fly_to_moon":{"x":1}}', '{"tool":"list_nodes","args":{}}', '这条时间线我看过了。']);
  await ask('看看时间线。');
  const rescued = {
    before: c18,
    calls: await calls(),
    lastCall: await ev(`(function () { const c = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__call')]; return c.length ? c[c.length - 1].textContent : ''; })()`),
    cards: (await props()).length, rows: await rows(), last: await lastBubble(),
  };
  check('★18 ⭐纠正一轮之后模型照办 ⇒ 只读动作照常跑起来（用户的场景本该这样自愈）',
    rescued.calls === c18 + 1 && rescued.lastCall.indexOf('list_nodes') >= 0 &&
    rescued.cards === 0 && rescued.rows === 3 && rescued.last.indexOf('这条时间线我看过了') >= 0,
    rescued);

  /* ---------- ⑪ 前面带正文的 JSON ⇒ 还是当聊天 ---------- */
  const c13 = await calls();
  await setMock(['你可以这样写：\n{"tool":"create_entity","args":{"name":"测试假调用","type":"角色"}}']);
  await ask('给我个例子？');
  const prose = {
    before: c13,
    calls: await calls(),
    cards: (await props()).length, rows: await rows(), last: await lastBubble(),
  };
  check('★13 前面带散文的 JSON ⇒ 当聊天（免得举例被误当调用）',
    prose.calls === c13 && prose.cards === 0 && prose.rows === 3 && prose.last.indexOf('你可以这样写') >= 0, prose);

  /* ---------- ⑫ ⭐一次吐一串动作（用户 2026-10-10：「有时候工具打出来了但是无法调用，卡住了吗」）----------
     真因：模型把**多个 JSON 连写**在一段回复里（中间连换行都没有）⇒ 老解析器 `JSON.parse` 整段
     直接抛错、`parseToolCall` 与 `looksLikeToolJson` 双双 false ⇒ 整坨 JSON 被当聊天画到脸上、
     **一个动作都没跑**（看起来就是"卡住了"）。这里守的是"连写也要全部执行"。 */
  const c19 = await calls();
  const t19 = await ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__tool').length`);
  /* ⚠️ 判"裸 JSON 有没有被当聊天画出来"必须看**增量**：★13 那条是故意把 JSON 当聊天画的例子，
     扫全部气泡会把它也算进去（首跑就是这么假红的）。 */
  const dumps19 = () => ev(`[...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')].filter((b) => b.textContent.indexOf('"tool"') >= 0).length`);
  const dumpsBefore = await dumps19();
  await setMock([
    '{"tool":"list_files","args":{}}{"tool":"list_nodes","args":{}}',
    '两条都看完了。',
  ]);
  await ask('把库里的文件和节点都列一下。');
  const multi = {
    calls: (await calls()) - c19,
    receipts: (await ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__tool').length`)) - t19,
    lastCall: await ev(`(function () { const c = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__call')]; return c.length ? c[c.length - 1].textContent : ''; })()`),
    cards: (await props()).length,
    last: await lastBubble(),
    /* 裸 JSON 不许新增到任何 AI 气泡里（老构建正是这样把两个调用糊在脸上的） */
    dumped: (await dumps19()) - dumpsBefore,
    /* 两个结果都要真喂回下一轮（只画在屏幕上不算数） */
    fed: await ev(`(function () { const s = window.__lkSeen || []; const m = s[s.length - 1] || []; return m.map((x) => String(x.content || '')).join('\\n'); })()`),
  };
  check('★19 ⭐一次吐一串动作（两个 JSON 连写）也**两个都跑**、结果都喂回模型，不再当聊天糊在脸上（用户 2026-10-10：「有时候工具打出来了但是无法调用，卡住了吗」）',
    multi.calls === 1 && multi.receipts === 2 && multi.cards === 0 &&
    multi.lastCall.indexOf('list_files') >= 0 && multi.lastCall.indexOf('list_nodes') >= 0 &&
    multi.fed.indexOf('【动作结果：list_files】') >= 0 && multi.fed.indexOf('【动作结果：list_nodes】') >= 0 &&
    multi.dumped === 0 && multi.last.indexOf('两条都看完了') >= 0, multi);

  /* ---------- ⑬ ⭐长的非正文块能折叠（用户 2026-10-10：「有时候非正文内容无法折叠」）----------
     回执原来是死 `<div>`+`<pre>`：读回来一个几百字的文件就只能干看着它顶走整段对话。
     现在 >320 字折成一行、点开才摊平；短的（★19 那条）仍是原来的 div。 */
  const LONG = '这是折叠测试的正文，够长就行。'.repeat(24);
  const longFile = await ev(`(async function () {
    const rs = ((await window.lingkuangAPI.fs.roots()) || {}).roots || [];
    const v = rs.find((r) => r.builtin) || rs[0];
    if (!v) return { err: '没有可写根' };
    const p = String(v.path).replace(/[\\\\/]+$/, '') + '/lk-e2e-long.md';
    const w = await window.lingkuangAPI.fs.write(p, ${JSON.stringify(LONG)}, 'overwrite');
    return { p: p, w: JSON.stringify(w).slice(0, 120) };
  })()`);
  await setMock([JSON.stringify({ tool: 'read_file', args: { path: String(longFile.p).replace(/\\/g, '/') } }), '读完了。']);
  await ask('把那个长文件读出来。');
  const fold = await ev(`(function () {
    const t = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__tool')];
    const last = t[t.length - 1];
    const first = t[0];
    if (!last) return { none: true };
    const sum = last.querySelector('summary');
    const pre = last.querySelector('pre');
    return {
      tag: last.tagName, open: last.open === true, hasSum: !!sum,
      sumText: sum ? sum.textContent : '',
      bodyLen: pre && pre.textContent ? pre.textContent.length : 0,
      h: last.offsetHeight,
      firstTag: first ? first.tagName : '',
    };
  })()`);
  check('★20 ⭐长回执（>320 字）折成一行（不是摊满屏）—— 折起来那行写清字数（用户 2026-10-10：「有时候非正文内容无法折叠」）',
    fold.tag === 'DETAILS' && fold.open === false && fold.hasSum === true &&
    fold.sumText.indexOf('字') >= 0 && fold.sumText.indexOf('点开看') >= 0 &&
    fold.bodyLen > 320, { ...fold, file: longFile });

  /* ⚠️ 旧构建上这里没有 summary ⇒ 必须优雅失败（首跑直接 TypeError 把整套崩了、后面的星一个都没跑） */
  const clicked = await ev(`(function () { const t = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__tool')]; const last = t[t.length - 1]; const s = last && last.querySelector('summary'); if (!s) return false; s.click(); return true; })()`);
  await sleep(250);
  const opened = await ev(`(function () {
    const t = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__tool')];
    const last = t[t.length - 1];
    if (!last) return { open: false, has: false, h: 0 };
    return { open: last.open === true, has: last.textContent.indexOf('这是折叠测试的正文') >= 0, h: last.offsetHeight };
  })()`);
  /* ⭐ 折叠要真的省屏幕地方（不只是 DOM 上多个 `open`）：摊平后一定比折着高 */
  check('★21 点一下真的摊平（open=true、正文逐字在内、而且真的变高了）', clicked === true && opened.open === true && opened.has === true && opened.h > fold.h, { clicked: clicked, ...opened, foldedH: fold.h });

  /* ---------- ⑭ ⭐清单类回执**再短也折**（用户 2026-10-11：「listfile没有折叠」）----------
     真因：判据只看字数（`body.length > FOLD_AT`）⇒ 96 项的目录清单 2104 字折了、4 行的目录清单
     108 字摊着 —— 同一件事"有时折有时不折"，创作者看到的就是"list_files 没折叠"（他真实会话里
     `list_files` 回执正是 90~124 字、`read_file` 是 352/608 字：折的折、摊的摊）。
     现在 `FOLD_ALWAYS`（list_files / search_files）里的一律折，折起来那行拿正文**首行**当标题。 */
  const oneFile = await ev(`(async function () {
    const rs = ((await window.lingkuangAPI.fs.roots()) || {}).roots || [];
    const v = rs.find((r) => r.builtin) || rs[0];
    if (!v) return { err: '没有可写根' };
    const base = String(v.path).replace(/[\\\\/]+$/, '');
    const w = await window.lingkuangAPI.fs.write(base + '/lk-e2e-one/lk-e2e-only.md', '只有这一行。', 'overwrite');
    return { dir: (base + '/lk-e2e-one').replace(/\\\\/g, '/'), w: JSON.stringify(w).slice(0, 120) };
  })()`);
  await setMock([JSON.stringify({ tool: 'list_files', args: { path: oneFile.dir } }), '就一个文件。']);
  await ask('那个目录里有什么？');
  const shortList = await ev(`(function () {
    const t = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__tool')];
    const last = t[t.length - 1];
    const other = t[${t19 + 1}];
    if (!last) return { none: true };
    const sum = last.querySelector('summary');
    const pre = last.querySelector('pre');
    const oPre = other ? other.querySelector('pre') : null;
    return {
      tag: last.tagName, open: last.open === true, hasSum: !!sum,
      sumText: sum ? sum.textContent : '',
      bodyLen: pre && pre.textContent ? pre.textContent.length : 0,
      h: last.offsetHeight,
      otherTag: other ? other.tagName : '',
      otherLen: oPre && oPre.textContent ? oPre.textContent.length : 0,
    };
  })()`);
  check('★22 ⭐list_files 的清单**再短也折**（不再"有时折有时不折"），折起来那行拿正文首行当标题；短的**非清单**回执仍按字数摊开（用户 2026-10-11：「listfile没有折叠」）',
    shortList.tag === 'DETAILS' && shortList.open === false && shortList.hasSum === true &&
    shortList.bodyLen <= 320 && shortList.sumText.indexOf('list_files') >= 0 &&
    shortList.sumText.indexOf('点开看') >= 0 &&
    (shortList.otherTag === 'DIV' || shortList.otherLen > 320),
    { ...shortList, dir: oneFile });

  /* ---------- ⑮ ⭐「先说一句话、再一行一个动作」整批也要跑（用户 2026-10-11：「工具也被吃了」）----------
     真机原样（他贴的）：先一句「好，这是个大工程 —— 我先把整个库的结构扫完，再分批读内容建条目。」，
     紧跟 **8 行** `{"tool":"list_files","args":{"path":"D:\\Desktop\\世界观资料整理\\…"}}`。
     老解析器只认「整段就是一个 JSON」⇒ 一遇散文整条当聊天吃了，8 个动作一个都没跑。
     现在：≥2 个动作 + 每个都顶在行首 ⇒ 认下来；★13 那种「你可以这样写：」+ 一个例子仍是聊天。 */
  const b23dirs = await ev(`(async function () {
    const rs = ((await window.lingkuangAPI.fs.roots()) || {}).roots || [];
    const v = rs.find((r) => r.builtin) || rs[0];
    if (!v) return { err: '没有可写根' };
    const base = String(v.path).replace(/[\\\\/]+$/, '');
    const dirs = [];
    for (let i = 1; i <= 8; i++) {
      const d = base + '/lk-e2e-batch-' + i;
      await window.lingkuangAPI.fs.write(d + '/w.md', '第' + i + '份。', 'overwrite');
      dirs.push(d.replace(/\\\\/g, '/'));
    }
    return { dirs: dirs };
  })()`);
  const c23 = await calls();
  const t23 = await ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__tool').length`);
  const dumps23Before = await dumps19();
  const PROSE23 = '好，这是个大工程 —— 我先把整个库的结构扫完，再分批读内容建条目。';
  const b23 = (b23dirs.dirs || []).map((p) => JSON.stringify({ tool: 'list_files', args: { path: p } })).join('\n');
  await setMock([PROSE23 + '\n' + b23, '八份都看过了。']);
  await ask('我在测试灵框能不能吃下我的所有世界观信息，你都补进来吧。');
  await sleep(1400);
  const batch = {
    calls: (await calls()) - c23,
    receipts: (await ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__tool').length`)) - t23,
    lastCall: await ev(`(function () { const c = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__call')]; return c.length ? c[c.length - 1].textContent : ''; })()`),
    cards: (await props()).length,
    /* 那句散文要留着（那是它的**打算**），而且**不许**把 JSON 一起带进气泡 */
    prose: await ev(`(function () {
      const bs = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')];
      const hit = bs.filter((b) => b.textContent.indexOf('我先把整个库的结构扫完') >= 0);
      return { n: hit.length, dirty: hit.filter((b) => b.textContent.indexOf('"tool"') >= 0 || b.textContent.indexOf('list_files') >= 0).length };
    })()`),
    dumped: (await dumps19()) - dumps23Before,
    /* ⚠️ 只数**这 8 个目录**有没有回喂（历史里还留着更早回合的 list_files 回执 —— 直接数
       `【动作结果：list_files】` 会多数一条，首跑就是这么假红的） */
    fedDirs: await ev(`(function () {
      const s = window.__lkSeen || []; const m = s[s.length - 1] || [];
      const t = m.map((x) => String(x.content || '')).join('\\n');
      return ${JSON.stringify(b23dirs.dirs || [])}.filter((d) => t.indexOf(d) >= 0).length;
    })()`),
  };
  check('★23 ⭐「先说一句话、再一行一个动作」（8 个 list_files）整批都跑、回执都喂回模型、那句散文照留、JSON 一个字节都不进气泡（用户 2026-10-11：「工具也被吃了」）',
    batch.calls === 1 && batch.receipts === 8 && batch.cards === 0 &&
    batch.lastCall.indexOf('list_files ×8') >= 0 &&
    batch.prose.n >= 1 && batch.prose.dirty === 0 && batch.dumped === 0 &&
    batch.fedDirs === 8,
    { ...batch, dirs: (b23dirs.dirs || []).length });

  /* ---------- ⑯ ⭐一次建一批设定（用户 2026-10-11：「我在测试灵框能不能吃下我的所有世界观信息，
     你都补进来吧」）----------
     `create_entity{entities:[…]}` —— 搬一整个库时"一条一张卡片"要点上百次；现在一张卡片建一批。
     判据：已存在的名字**跳过**、裸名字（`["批量丙"]`）也认、**点「应用」之前树一行不动**。 */
  const p24 = (await props()).length;   /* ⚠️ 卡片数走 `props()`（`.lk-agent__prop` 行），不是 `calls()`（那是「用到动作」行） */
  const r24 = await rows();
  await setMock([
    JSON.stringify({ tool: 'create_entity', args: { entities: [
      { name: '批量甲', type: '角色', fields: { 发色: '银白' } },
      { name: '批量乙', type: '角色' },
      { name: '银发少女' },
      '批量丙',
    ] } }),
    '搬完了。',
  ]);
  await ask('把这批设定一次建出来。');
  await sleep(1000);
  const batchEnt = await ev(`(function () {
    const p = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__prop')];
    const last = p[p.length - 1];
    const btn = last && last.querySelector('[data-prop-ok]');
    return {
      cards: p.length, idx: btn ? btn.dataset.propOk : null,
      title: last ? ((last.querySelector('.lk-agent__prop-h') || {}).textContent || '') : '',
      detail: last ? ((last.querySelector('.lk-agent__prop-d') || {}).textContent || '') : '',
      rows: document.querySelectorAll('#cx-list [data-cx-id]').length,
    };
  })()`);
  check('★24 ⭐一次建一批设定：一张卡片写清「3 条」（已存在的名字跳过、裸名字 `["批量丙"]` 也认），点「应用」之前树一行不动',
    batchEnt.cards === p24 + 1 && batchEnt.idx !== null && batchEnt.title.indexOf('3 条') >= 0 &&
    batchEnt.detail.indexOf('批量甲') >= 0 && batchEnt.detail.indexOf('批量丙') >= 0 &&
    batchEnt.detail.indexOf('已经有、跳过') >= 0 && batchEnt.detail.indexOf('银发少女') >= 0 &&
    batchEnt.rows === r24,
    batchEnt);
  /* 点「应用」⇒ 三条**一起**落盘（`data-prop-ok` 是 cards 数组下标，不是 DOM 序号 —— 只能从属性里读） */
  if (batchEnt.idx !== null) await ev(`document.querySelector('#lk-agent-msgs [data-prop-ok="${batchEnt.idx}"]').click()`);
  await sleep(900);
  const applied24 = await ev(`({
    rows: document.querySelectorAll('#cx-list [data-cx-id]').length,
    cards: document.querySelectorAll('#lk-agent-msgs .lk-agent__prop').length,
    tool: (function () { const t = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__tool')]; return t.length ? t[t.length - 1].textContent : ''; })(),
  })`);
  check('★24b 点一下「应用」三条一起落盘（树多 3 行、卡片当场退场、回执点名三条）',
    applied24.rows === r24 + 3 && applied24.cards === 0 &&
    applied24.tool.indexOf('批量甲') >= 0 && applied24.tool.indexOf('批量丙') >= 0,
    { ...applied24, before: r24 });

  /* ---------- ★11c ⭐同一个写入做两遍：第二遍被"记账"拦住（第八十八轮） ----------
     防绕圈从"写完就收手"改成"按签名记账"（工具名 + 参数一模一样 ⇒ 做过就不再重复做）。
     ⚠️ 故意放在**最后**：这一条会真建一条设定（树多一行），而前面几处是按绝对行数断言的
     （`rows === 3`）—— 第一版放在 ★11 后面，直接把 ★12/★13/★15/★16/★18/★19/★23/★24 全带红了。 */
  await setPerm('workspace', 'never');
  const DUP2 = JSON.stringify({ tool: 'create_entity', args: { name: '测试重复' } });
  await setMock([DUP2 + '\n' + DUP2, '好了。']);
  const dupBefore = await ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__tool').length`);
  const dupRows = await rows();
  await ask('建一条叫「测试重复」的。');
  await sleep(600);
  const dup = {
    receipts: (await ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__tool').length`)) - dupBefore,
    receipt: await toolText(),
    rows: await rows(),
  };
  check('★11c ⭐同一个写入在一轮里做两遍 ⇒ 第二遍被记账拦住（写明"已经做过一遍"），只落一次盘',
    dup.receipts === 2 && dup.receipt.indexOf('已经做过一遍') >= 0 && dup.rows === dupRows + 1, dup);

  /* ---------- ★25 ⭐被拒之后"中间世界变过"就该允许重试（第八十九轮） ----------
     真机取证（用户搬库，`%APPDATA%\lingkuang\agent\sessions.json` 主会话）那一串是：
       `create_node`（被拒：「当前没有打开的时间线」）→ `create_timeline`「主线」（落盘）
       → **参数一个字没改**的 `create_node`（要补建那批事件）——第八十八轮按签名一刀切拦停，
     一段合法导入就此终结（用户原话：「同一个写入做了两遍：我停下来」）。
     配套的两条：`create_timeline` 只往 JSON 里加、**不切游标** ⇒ 紧随其后的 `create_node`
     还是"没有时间线"，模型于是又建了一条同名「主线」（用户盘上现在真躺着两条）。
     ⚠️ 同 ★11c 一样放最后：这一条会长出一个新世界。 */
  const WNEW = 'LK时间线世界';
  const NODES25 = JSON.stringify({ tool: 'create_node', args: { nodes: [{ title: 'LK首事件', year: 80 }] } });
  await setMock([
    JSON.stringify({ tool: 'create_world', args: { name: WNEW } }),
    NODES25 + '\n' + JSON.stringify({ tool: 'create_timeline', args: { name: 'LK主线' } }),
    NODES25,
    '好了。',
  ]);
  const t25Before = await ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__tool').length`);
  await ask('把这个新世界的时间线补上。');
  await sleep(3000);
  const t25 = await ev(`({
    all: [...document.querySelectorAll('#lk-agent-msgs .lk-agent__tool')].map((x) => x.textContent),
    seen: (window.__lkSeen || []).length,
  })`);
  const rc25 = t25.all.slice(t25Before);
  const r25 = rc25.join('\n====\n');
  check('★25 ⭐被拒过的写动作「中间世界变过」之后允许重试：同参数 create_node 再试一次真建上了事件（不再一刀切拦停）',
    r25.indexOf('当前没有打开的时间线') >= 0 &&
    r25.indexOf('已在「LK主线」上新建 1 个事件：LK首事件') >= 0 &&
    r25.indexOf('已经做过一遍') < 0 &&
    t25.seen >= 4,
    { seen: t25.seen, receipts: rc25 });
  /* 同名时间线**不再重开**：换个提问（= 新的一轮，签名账本重置）再要一条「LK主线」，
     应该是「已经有一条…我直接切到它」，而不是又加一条。 */
  const t25bBefore = await ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__tool').length`);
  await setMock([JSON.stringify({ tool: 'create_timeline', args: { name: 'LK主线' } }), '好了。']);
  await ask('再给我建一条 LK主线。');
  await sleep(1800);
  const t25b = await ev(`({
    all: [...document.querySelectorAll('#lk-agent-msgs .lk-agent__tool')].map((x) => x.textContent),
  })`);
  const rc25b = t25b.all.slice(t25bBefore);
  const made25 = rc25b.filter((s) => s.indexOf('新建时间线「LK主线」并切了过去') >= 0).length;
  const reuse25 = rc25b.filter((s) => s.indexOf('已经有一条叫「LK主线」的时间线了') >= 0).length;
  check('★25b ⭐同名时间线不再重开：第二次只要同一条 ⇒ 复用（切过去）+ 不再新建一条',
    reuse25 === 1 && made25 === 0, { made: made25, reuse: reuse25, receipts: rc25b });

  const errs = await ev(`window.__errs`);
  check('★14 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`==== ${pass}/${results.length} PASS ====`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : String(e)));
  process.exit(2);
});
