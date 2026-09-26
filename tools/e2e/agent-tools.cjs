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
 *   ★12 —— 认不出的裸 JSON 不再糊到脸上，而是回头纠正模型一次。
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
  /* 卡片上只留一句短文案「已应用」：那句长说明下面已经有一块【动作结果】在显示了（2026-09-18 改） */
  check('★8 点「应用」之后才真落盘（设定树里多了一行）',
    (await rows()) === 2 && card1b[0].settled === true && card1b[0].note.indexOf('已应用') >= 0,
    { rows: await rows(), card: card1b[0] });

  /* ---------- ④「忽略」什么都不做 ---------- */
  await setMock(['{"tool":"create_entity","args":{"name":"测试被忽略","type":"角色"}}']);
  await ask('再建一条叫「测试被忽略」的。');
  const card2 = await props();
  await ev(`document.querySelector('#lk-agent-msgs [data-prop-no="1"]').click(); true`);
  await sleep(500);
  const card2b = await props();
  check('★9 点「忽略」= 什么都不做（树不动、卡片标已忽略）',
    card2.length === 2 && (await rows()) === 2 && card2b[1].settled === true && card2b[1].note.indexOf('已忽略') >= 0,
    { cards: card2.length, rows: await rows(), note: card2b[1].note });

  /* ---------- ⑤ 只读档：不给执行 ---------- */
  await setPerm('readonly', 'always');
  const gateRo = await ev(`document.getElementById('lk-agent-panel').dataset.gate`);
  await setMock(['{"tool":"create_entity","args":{"name":"测试只读档","type":"角色"}}']);
  await ask('建一条叫「测试只读档」的。');
  const ro = { gate: gateRo, cards: (await props()).length, rows: await rows(), note: await noteText() };
  check('★10 只读档：不出卡片、不落盘、明白告诉你没执行',
    ro.gate === 'deny' && ro.cards === 2 && ro.rows === 2 && ro.note.indexOf('只读') >= 0, ro);

  /* ---------- ⑥ 直接执行档：不问，直接落盘 ---------- */
  await setPerm('workspace', 'never');
  const gateYolo = await ev(`document.getElementById('lk-agent-panel').dataset.gate`);
  await setMock(['{"tool":"create_entity","args":{"name":"测试自动","type":"角色"}}']);
  await ask('建一条叫「测试自动」的。');
  const yolo = {
    gate: gateYolo, cards: (await props()).length, rows: await rows(),
    stored: await ev(`(function () { const s = JSON.parse(localStorage.getItem('lingkuang-settings') || '{}'); return String(s.agentScope || '') + '+' + String(s.agentAsk || ''); })()`),
    note: await noteText(),
  };
  check('★11 直接执行档（可写 + 不询问）：不用点，直接就落盘了（两旋钮也存进了设置）',
    yolo.gate === 'allow' && yolo.cards === 2 && yolo.rows === 3 && yolo.stored === 'workspace+never' && yolo.note.indexOf('已新建设定') >= 0, yolo);

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
    unknown.calls === callsBefore && unknown.cards === 2 && unknown.rows === 3 && unknown.dumped === false &&
    unknown.seen.indexOf('【格式提醒】') >= 0 && unknown.last.indexOf('我在。') >= 0,
    unknown);

  /* ---------- ⑧ 名字当键（用户 2026-09-15 实测的形状）也要认 ---------- */
  await setPerm('workspace', 'always');
  await setMock(['{"set_field":{"entity":"银发少女","field":"发色","value":"墨黑"}}']);
  await ask('把银发少女的发色改成墨黑。');
  const keyed = await props();
  check('★15 ⭐「工具名当键」的形状也认下来了（这次真的出卡片而不是一坨 JSON）',
    keyed.length === 3 && keyed[2].h.indexOf('改字段：银发少女 · 发色') >= 0 && (await rows()) === 3,
    { cards: keyed.length, card: keyed[2], note: await noteText() });

  await ev(`document.querySelector('#lk-agent-msgs [data-prop-ok="2"]').click(); true`);
  await sleep(700);
  const keyedDone = await props();
  await setMock(['{"tool":"read_entity","args":{"name":"银发少女"}}', '好，我记住了。']);
  await ask('再看一眼她的发色。');
  const afterApply = {
    note: keyedDone[2].note,
    tool: await ev(`(function () { const t = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__tool')]; return t.length ? t[t.length - 1].textContent : ''; })()`),
  };
  check('★16 应用之后字段真的变了（再读一次：发色=墨黑）',
    keyedDone[2].settled === true && afterApply.note.indexOf('已应用') >= 0 && afterApply.tool.indexOf('发色=墨黑') >= 0,
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
    rescued.cards === 3 && rescued.rows === 3 && rescued.last.indexOf('这条时间线我看过了') >= 0,
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
    prose.calls === c13 && prose.cards === 3 && prose.rows === 3 && prose.last.indexOf('你可以这样写') >= 0, prose);

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
