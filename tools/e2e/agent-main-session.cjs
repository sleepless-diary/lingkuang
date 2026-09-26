/* 不变量：**AI 页的「主会话」与 Ctrl+K 的灵框助手是同一格会话**。
 *
 * 用户 2026-09-26 的原话：「**其实我最开始的想法是主会话和助手指向的是同一个会话**」
 * （前一句是「输入框上怎么还是本地模型」那个话题的延伸；拍板「只主会话能动手，角色/视角/主控保持纯演」）。
 * 落地的是三件事，这里各有用牙的断言：
 *   ① **一份历史**：两处写入都落在 `<agent>/sessions.json` 的主会话上，助手**不再写** `chat.json`；
 *   ② **老数据一次性迁移**：老 `chat.json` 的对话（含分割线与动作回执）并进主会话，且只并一次；
 *   ③ **一套上下文**：从 AI 页发的那一轮也守分割线（线之上的对话不发给模型），
 *      而线之下的动作回执照发（它是模型该知道的事实）。
 *   ④ **一套能力（2C，2026-09-26）**：主会话与助手共用 `runTurn()` ⇒ 从 AI 页也**真调动作**
 *      （只读当场执行、写动作出同一张提议卡片、点「应用」照旧落 vault）；
 *      模式开关（聊天 / Agent）两个入口共享一份状态。
 *
 * ⚠️ 断言里的「同一份」靠**元素/条数**证明，不靠"看起来一样"：
 *   助手说完 ⇒ AI 页主会话里的条数当场就多 2；AI 页说完 ⇒ 助手面板关开一次（读的是同一份内存数组）
 *   也看得到。仅同步副本的实现在这两条上必挂。
 *
 * 用法（`%TEMP%\lk-evault2` 那套夹具；主会话起点必须用**这个专用 seed**）：
 *   node tools/e2e/reset-entity-vault.cjs; node tools/e2e/seed-node.cjs; node tools/e2e/seed-agent-main-session.cjs
 *   → 起应用 → LK_CDP_PORT=NNNN node tools/e2e/agent-main-session.cjs
 * ⚠️ 本套件会 `location.reload()`（验"只迁一次"），reload 后要重新装错误监听、重新点开工具。
 */
const fs = require('fs');
const path = require('path');
const PORT = process.env.LK_CDP_PORT || '9346';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }

/** agent/ 的位置 = `main.js` 的 `AGENT_DIR()`（测试时跟着 LINGKUANG_TEST_DATA 走） */
function agentDir() {
  if (process.env.LK_AGENT_DIR) return process.env.LK_AGENT_DIR;
  if (process.env.LINGKUANG_TEST_DATA) return path.join(path.dirname(process.env.LINGKUANG_TEST_DATA), 'agent');
  return path.join(require('os').tmpdir(), 'lk-evault2', 'agent');
}
function readAgent(name) {
  try { return JSON.parse(fs.readFileSync(path.join(agentDir(), name), 'utf8')); } catch { return null; }
}
/** 磁盘上主会话的历史（`sessions.json` 里 `role === 'main'` 那条） */
function mainHist() {
  const s = readAgent('sessions.json');
  if (!Array.isArray(s)) return null;
  const m = s.find((x) => x && x.role === 'main');
  return m && Array.isArray(m.history) ? m.history : null;
}

/** vault 里所有 .md 的文本 —— ★11 用它证明「从 AI 页的写动作真落盘了」（只看界面不算数） */
function vaultText() {
  const root = process.env.LINGKUANG_VAULT || '';
  let out = '';
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.md$/i.test(e.name)) { try { out += fs.readFileSync(p, 'utf8'); } catch { /* 略过读不到的 */ } }
    }
  };
  if (root) walk(root);
  return out;
}
async function waitVault(needle, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (vaultText().indexOf(needle) >= 0) return true;
    await sleep(200);
  }
  return false;
}

/** seed 里 chat.json 的条数（★8 用它证明"助手不再写 chat.json"） */
const SEED_CHAT_N = 4;

async function main() {
  let target = null;
  for (let i = 0; i < 120; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (target) break; } catch { /* 还没起来 */ }
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

  const ctrlK = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`;
  const openTool = (tid) => `document.querySelector('[data-tool="${tid}"]').click(); true`;
  const agentBtn = `[...document.querySelectorAll('#lk-toolbar .lk-tool-btn')].find((b) => b.dataset.tool === 'agent')`;
  const watchErrs = `window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`;
  /** 点某一格会话（AI 页左栏按名字找；点了就会重画右栏，读到的才是当下） */
  const pickSession = (name) => `(() => { const r = [...document.querySelectorAll('#ai-sess [data-s]')].find((x) => (x.querySelector('span')?.textContent ?? '') === ${JSON.stringify(name)}); if (r) { r.click(); return true; } return false; })()`;
  /** 助手面板消息区快照：分割线（.lk-agent__cut）、消息（.lk-agent__cutwrap）、系统回执（.lk-agent__tool）分开数 */
  const panelSnap = `(() => {
    const box = document.querySelector('#lk-agent-msgs');
    if (!box) return null;
    return { n: box.children.length, cut: box.querySelectorAll('.lk-agent__cut').length, cutwrap: box.querySelectorAll('.lk-agent__cutwrap').length, tool: box.querySelectorAll('.lk-agent__tool').length, text: box.textContent };
  })()`;
  /** AI 页右栏快照：分割点与回执块带 data-k，用户气泡是纯 div */
  const aiSnap = `(() => {
    const log = document.getElementById('ai-log');
    if (!log) return null;
    return { n: log.children.length, div: log.querySelectorAll('[data-k="div"]').length, receipt: log.querySelectorAll('[data-k="receipt"]').length, head: document.getElementById('ai-head')?.textContent ?? '', text: log.textContent };
  })()`;
  const panelOpen = () => ev(`!!document.getElementById('lk-agent-panel')`);
  /** 面板是浮层、切工具时会被关掉，所以进出都走这里（幂等） */
  async function ensurePanel(open) {
    const isOpen = await panelOpen();
    if (open && !isOpen) { await ev(ctrlK); await sleep(900); }
    if (!open && isOpen) { await ev(ctrlK); await sleep(300); }
  }

  await sleep(1500);
  await ev(watchErrs);
  await ev(openTool('codex'));
  await sleep(1300);

  const pre = await ev(`(() => ({ works: !!document.querySelector('#cx-root'), btn: !!${agentBtn}, panel: !!document.getElementById('lk-agent-panel') }))()`);
  const seedMain = mainHist();
  const seedChat = readAgent('chat.json');
  check('★0 前置：设定库开着、工具栏有「助手」、此刻没有面板；主会话起点是**空历史**、chat.json 有 4 条（迁移才有得做）',
    pre.works === true && pre.btn === true && pre.panel === false
      && Array.isArray(seedMain) && seedMain.length === 0
      && Array.isArray(seedChat) && seedChat.length === SEED_CHAT_N,
    { works: pre.works, btn: pre.btn, panel: pre.panel, seedMain: seedMain ? seedMain.length : null, seedChat: seedChat ? seedChat.length : null });

  /* ── ① 一次性迁移：老 chat.json 并进主会话（含分割线与动作回执） ── */
  await ensurePanel(true);
  const p1 = await ev(panelSnap);
  await sleep(600);                                  /* 落盘节流 400ms（此刻 AI 页没挂载 ⇒ 走 ai-sessions 的兜底写） */
  const disk1 = mainHist();
  const chat1 = readAgent('chat.json');
  check('★1 老 chat.json 一次性并进主会话（4 条：话/答/分割线/回执），面板看得见、磁盘也落了',
    !!p1 && p1.n === 4 && p1.cut === 1 && p1.tool === 1
      && p1.text.indexOf('老助手说过的一句') >= 0 && p1.text.indexOf('老助手答过的一句') >= 0
      && Array.isArray(disk1) && disk1.length === 4
      && disk1[2].div === true && disk1[2].content === ''
      && String(disk1[3].content).indexOf('【动作结果：') === 0
      && Array.isArray(chat1) && chat1.length === SEED_CHAT_N,
    { panel: p1 ? { n: p1.n, cut: p1.cut, tool: p1.tool } : null, disk: disk1 ? disk1.length : null, chat: chat1 ? chat1.length : null });

  /* ── ② 只迁一次（重载后不重复追加） ── */
  await ev(`location.reload(); true`);
  await sleep(2600);
  await ev(watchErrs);
  await ev(openTool('codex'));
  await sleep(1300);
  await ensurePanel(true);
  const p2 = await ev(panelSnap);
  const disk2 = mainHist();
  check('★2 重载后再开面板仍是那 4 条（磁盘没长成 8 条）——迁移只发生一次',
    !!p2 && p2.n === 4 && p2.cut === 1 && Array.isArray(disk2) && disk2.length === 4,
    { panel: p2 ? p2.n : null, disk: disk2 ? disk2.length : null });

  /* ── ③ AI 页：主会话 = 那 4 条（含分割点与回执块）；角色会话仍各自独立 ── */
  await ensurePanel(false);
  await ev(openTool('ai'));
  await sleep(1400);
  const rows = await ev(`[...document.querySelectorAll('#ai-sess [data-s]')].map((r) => ({ id: r.dataset.s, name: (r.querySelector('span')?.textContent ?? '') }))`);
  await ev(pickSession('主会话'));
  await sleep(400);
  const a1 = await ev(aiSnap);
  await ev(pickSession('艾德温'));
  await sleep(400);
  const a2 = await ev(aiSnap);
  check('★3 AI 页的主会话就是助手那一份（4 条，其中分割点 1、回执块 1）；角色会话仍是自己的 2 条',
    Array.isArray(rows) && rows.some((r) => r.name === '主会话') && rows.some((r) => r.name === '艾德温')
      && !!a1 && a1.n === 4 && a1.div === 1 && a1.receipt === 1 && a1.text.indexOf('老助手说过的一句') >= 0
      && !!a2 && a2.n === 2 && a2.text.indexOf('角色会话自己的一句') >= 0 && a2.text.indexOf('老助手说过的一句') < 0,
    { rows: rows, main: a1 ? { n: a1.n, div: a1.div, receipt: a1.receipt } : null, role: a2 ? { n: a2.n } : null });

  check('★4 主会话在 AI 页头上写着「＝ Ctrl+K 的灵框助手」（免得创作者以为是两格会话）',
    !!a1 && a1.head.indexOf('灵框助手') >= 0, { head: a1 ? a1.head.slice(0, 48) : null });

  /* ── ④ 助手说一句 ⇒ AI 页主会话当场多 2 条（同一份数组，不是同步副本） ── */
  await ev(pickSession('主会话'));
  await sleep(300);
  const before4 = await ev(aiSnap);
  await ensurePanel(true);
  await ev(`window.__lkAgentMock = '助手刚说的一句'; true`);
  await ev(`(function () { const t = document.getElementById('lk-agent-input'); t.value = '主会话共享测试一'; document.getElementById('lk-agent-send').click(); return true; })()`);
  await sleep(1500);
  const p3 = await ev(panelSnap);
  await ev(openTool('ai'));                          /* 重开 AI 页 = 从同一份会话重画（切工具会顺手关掉面板） */
  await sleep(900);
  await ev(pickSession('主会话'));
  await sleep(400);
  const a3 = await ev(aiSnap);
  check('★5 助手说的一句立刻出现在 AI 页主会话里（4 条 → 6 条，两边文本都含这两句）',
    !!before4 && before4.n === 4
      && !!p3 && p3.text.indexOf('主会话共享测试一') >= 0 && p3.text.indexOf('助手刚说的一句') >= 0
      && !!a3 && a3.n === 6 && a3.text.indexOf('主会话共享测试一') >= 0 && a3.text.indexOf('助手刚说的一句') >= 0,
    { before: before4 ? before4.n : null, panel: p3 ? p3.n : null, ai: a3 ? a3.n : null });

  /* ── ⑤ AI 页说一句 ⇒ 助手面板里也有（关开面板读的还是那一份内存历史） ── */
  /* ⭐ 2C：主会话现在走助手的 `runTurn()`（它会先看假引擎后门 `__lkAgentMock`）⇒ ★5 留下的假应答
     必须清掉，否则这一轮根本不发请求，★7 的请求体断言就没东西可看。 */
  await ev(`delete window.__lkAgentMock; true`);
  await ev(`(() => {
    window.__reqLog = [];
    if (!window.__origFetch) window.__origFetch = window.fetch;
    window.fetch = async (url, init) => {
      window.__reqLog.push({ url: String(url), body: String((init && init.body) || '') });
      const payload = { message: { content: 'AI 页刚说的一句' }, choices: [{ delta: { content: 'AI 页刚说的一句' }, finish_reason: 'stop' }], done: true, done_reason: 'stop' };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    return true;
  })()`);
  await ev(`(function () { const t = document.getElementById('ai-input'); t.value = '主会话共享测试二'; document.getElementById('ai-send').click(); return true; })()`);
  await sleep(1700);
  const a4 = await ev(aiSnap);
  await ev(openTool('codex'));
  await sleep(900);
  await ensurePanel(true);
  const p4 = await ev(panelSnap);
  check('★6 AI 页说的一句立刻出现在助手面板里（6 条 → 8 条；关开面板读的就是同一份历史）',
    !!a4 && a4.n === 8 && a4.text.indexOf('主会话共享测试二') >= 0 && a4.text.indexOf('AI 页刚说的一句') >= 0
      && !!p4 && p4.n === 8 && p4.text.indexOf('主会话共享测试二') >= 0 && p4.text.indexOf('AI 页刚说的一句') >= 0,
    { ai: a4 ? a4.n : null, panel: p4 ? p4.n : null });

  /* ── ⑥ 从 AI 页发的那一轮也守分割线：线之上的不发给模型，线之下的回执照发 ── */
  const req = await ev(`(() => {
    const l = window.__reqLog || [];
    const last = l.length ? JSON.parse(l[l.length - 1].body) : null;
    return {
      n: l.length,
      url: l.length ? l[l.length - 1].url : '',
      msgs: last ? last.messages.map((m) => ({ role: m.role, len: String(m.content).length })) : null,
      sysLen: last ? String(last.messages[0].content).length : 0,
      sysHasCtx: last ? String(last.messages[0].content).indexOf('【工作区现状】') >= 0 : false,
      sysChatMode: last ? String(last.messages[0].content).indexOf('【你现在是「聊天」模式】') >= 0 : false,
      sysToolsOn: last ? String(last.messages[0].content).indexOf('create_entity') >= 0 : false,
      joined: last ? last.messages.map((m) => m.content).join(' ') : '',
    };
  })()`);
  /* ⭐ 2C 翻转：主会话与助手共用系统提示 ⇒ 动作协议**也在**（旧版这里断言 `sysToolsOff === true`，
     那是"AI 页还没有提议卡片界面"时的权宜；现在卡片也在这一页了，协议必须注入）。 */
  check('★7 从 AI 页发的这一轮：系统提示是**助手那一份**（聊天档 + 工作区现状 + 动作协议），分割线之上的对话没发给模型、回执照发',
    !!req && req.n === 1 && req.msgs && req.msgs[0].role === 'system' && req.sysHasCtx === true
      && req.sysChatMode === true && req.sysToolsOn === true
      && /\/api\/chat$|\/chat\/completions$/.test(String(req.url || ''))
      && req.joined.indexOf('老助手说过的一句') < 0 && req.joined.indexOf('【动作结果：') >= 0
      && req.joined.indexOf('主会话共享测试二') >= 0,
    { n: req ? req.n : null, url: req ? req.url : null, msgs: req ? req.msgs : null, sysLen: req ? req.sysLen : null, hasCtx: req ? req.sysHasCtx : null, chatMode: req ? req.sysChatMode : null, toolsOn: req ? req.sysToolsOn : null });

  /* ── ⑦ 助手不再写 chat.json（这是"历史只有一个家"的磁盘证据） ── */
  await sleep(700);                                  /* AI 页挂着 ⇒ 走 sink 的 400ms 节流 */
  const chat2 = readAgent('chat.json');
  const disk3 = mainHist();
  check('★8 磁盘上 chat.json 还是播种的 4 条（助手不再往里写），主会话一路长到 8 条',
    Array.isArray(chat2) && chat2.length === SEED_CHAT_N && String(chat2[3].content).indexOf('【动作结果：') === 0
      && Array.isArray(disk3) && disk3.length === 8,
    { chat: chat2 ? chat2.length : null, main: disk3 ? disk3.length : null });

  /* ── ⑧ 2C：从 AI 页也能真动手（同一套 `runTurn`、同一张卡片、同一份落盘） ── */
  const setMock = async (queue) => ev(`window.__lkSeen = []; window.__lkMockQ = ${JSON.stringify(queue)}; window.__lkAgentMock = (m) => { window.__lkSeen.push(m); return window.__lkMockQ.length ? window.__lkMockQ.shift() : '好的。'; }; true`);
  const aiSay = async (text) => {
    await ev(`(function () { const t = document.getElementById('ai-input'); t.value = ${JSON.stringify(text)}; document.getElementById('ai-send').click(); return true; })()`);
    await sleep(1600);
  };
  await ev(openTool('ai'));
  await sleep(700);
  await ev(pickSession('主会话'));
  await sleep(400);

  await setMock(['{"tool":"list_entities","args":{}}', '列表我看过了，设定不多。']);
  await aiSay('AI 页试一个只读动作');
  const r10 = await ev(`(() => {
    const log = document.getElementById('ai-log');
    return {
      call: log.querySelectorAll('[data-k="call"]').length,
      callText: (log.querySelector('[data-k="call"]') || {}).textContent || '',
      receipt: [...log.querySelectorAll('[data-k="receipt"]')].map((x) => x.textContent).join(' | '),
      rawJson: log.textContent.indexOf('"tool"') >= 0,
    };
  })()`);
  check('★10 从 AI 页发的**只读动作**真执行了（画成「用到动作」一行 + 回执块里有结果，没有把裸 JSON 当聊天字）',
    !!r10 && r10.call === 1 && r10.callText.indexOf('list_entities') >= 0
      && r10.receipt.indexOf('银发少女') >= 0 && r10.rawJson === false,
    r10);

  await setMock(['{"tool":"create_entity","args":{"name":"AI页建的条目","type":"角色"}}']);
  await aiSay('AI 页建一条设定');
  const w1 = await ev(`(() => {
    const log = document.getElementById('ai-log');
    const card = log.querySelector('.lk-agent__prop');
    return {
      cards: log.querySelectorAll('.lk-agent__prop').length,
      title: card ? ((card.querySelector('.lk-agent__prop-h') || {}).textContent || '') : '',
      ok: !!log.querySelector('[data-prop-ok]'),
      settled: !!log.querySelector('.lk-agent__prop.is-settled'),
    };
  })()`);
  const applied = await ev(`(function () { const b = document.querySelector('#ai-log [data-prop-ok]'); if (!b) return false; b.click(); return true; })()`);
  await sleep(700);
  const w2 = await ev(`(() => {
    const log = document.getElementById('ai-log');
    return {
      settled: !!log.querySelector('.lk-agent__prop.is-settled'),
      note: (document.getElementById('ai-note') || {}).textContent || '',
      receipt: [...log.querySelectorAll('[data-k="receipt"]')].map((x) => x.textContent).join(' | '),
    };
  })()`);
  const inVault = await waitVault('AI页建的条目');
  check('★11 从 AI 页发的**写动作**出同一张提议卡片，点「应用」真落 vault（界面说改了不算数）',
    !!w1 && w1.cards === 1 && w1.title.indexOf('AI页建的条目') >= 0 && w1.ok === true && w1.settled === false
      && applied === true && !!w2 && w2.settled === true && w2.receipt.indexOf('create_entity') >= 0 && inVault === true,
    { cards: w1 ? w1.cards : null, title: w1 ? w1.title : null, applied, settled: w2 ? w2.settled : null, note: w2 ? w2.note : null, inVault });

  /* ── ⑨ 模式开关两个入口共享一份状态（在哪儿切都算数） ── */
  const dom12 = await ev(`(() => {
    const head = document.getElementById('ai-head');
    const on = document.querySelector('#lk-toolbar .lk-tool-btn.is-on');
    return {
      aiMounted: !!document.getElementById('ai-log'),
      btn: !!document.getElementById('lk-ai-mode-agent'),
      head: head ? head.textContent : '',
      toolOn: on && on.dataset ? (on.dataset.tool || '') : '',
    };
  })()`);
  let m1 = '';
  let m2 = null;
  let m3 = '';
  if (dom12 && dom12.btn) {
    await ev(`document.getElementById('lk-ai-mode-agent').click(); true`);
    await sleep(400);
    m1 = await ev(`(document.getElementById('ai-head') || {}).textContent || ''`);
    await ensurePanel(true);                           /* 幂等：面板已经开着就不动它 */
    await sleep(300);
    m2 = await ev(`(() => { const p = document.getElementById('lk-agent-panel'); return { mode: p ? p.dataset.mode : null, on: !!document.querySelector('#lk-agent-mode-agent.is-on') }; })()`);
    await ev(`(function () { const b = document.getElementById('lk-agent-mode-chat'); if (!b) return false; b.click(); return true; })()`);
    await sleep(400);
    m3 = await ev(`(document.getElementById('ai-head') || {}).textContent || ''`);
    await ev(ctrlK);
    await sleep(400);
  }
  check('★12 模式开关两个入口共享一份状态（AI 页切 Agent ⇒ 助手面板就是 agent；面板切回聊天 ⇒ AI 页当场跟上）',
    m1.indexOf('Agent：能连着走多步') >= 0 && !!m2 && m2.mode === 'agent' && m2.on === true && m3.indexOf('聊天：能查也能改') >= 0,
    { dom: dom12, aiAgent: m1.indexOf('Agent：能连着走多步') >= 0, panel: m2, aiBackToChat: m3.indexOf('聊天：能查也能改') >= 0 });

  const errs = await ev(`window.__errs || []`);
  check('★9 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, { errs });

  const pass = results.filter(Boolean).length;
  console.log(`==== ${pass}/${results.length} PASS ====`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + ((e && e.stack) || e)); process.exit(2); });
