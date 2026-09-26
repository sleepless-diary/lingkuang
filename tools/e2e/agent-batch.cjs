/* agent-batch.cjs —— 助手的**批量形态**（阶段 2B）
 *
 * 用户 2026-09-26 拍板：Agent 模式 = **多步自主 + 批量改**（「agent 模式是在灵框外工作用的」那轮问答里选的）。
 * 这份套件守四条：
 *   ① 批量改字段：`set_field{entities:[名字…], field, value}` ⇒ **一张**卡片、一次落盘改掉一批；
 *   ② 批量建事件：`create_node{nodes:[{title,year}…]}` ⇒ 一张卡片、一次建一串；
 *   ③ **只在 Agent 模式认**：聊天模式收到批量形态 ⇒ 不出卡片、回执一句话（要批量请切 Agent）、数据没动；
 *   ④ 落盘真假以 **vault 里的 .md** 为准（不看界面自述：界面说改了不等于文件真改了）。
 *
 * 前置：同一 pwsh 调用里设好 LINGKUANG_TEST_* 环境变量并起实例（见 tools/e2e 的跑法），
 *       夹具 = node tools\e2e\reset-entity-vault.cjs + node tools\e2e\seed-node.cjs
 *       （播种实体「银发少女」，发色=墨黑）
 * 跑：$env:LK_CDP_PORT=9346; node tools\e2e\agent-batch.cjs
 */
const fs = require('fs');
const path = require('path');
const PORT = process.env.LK_CDP_PORT || '9346';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(n, ok, extra) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);
}

const VAULT = path.join(process.env.TEMP || '.', 'lk-evault2', 'vault');
/** vault 里全部 .md 的内容拼起来 —— 「真落盘了吗」以它为准 */
function vaultText() {
  let out = '';
  let files = [];
  try { files = fs.readdirSync(VAULT, { recursive: true }); } catch { return ''; }
  for (const f of files) {
    const p = path.join(VAULT, String(f));
    if (!String(f).toLowerCase().endsWith('.md')) continue;
    try { out += fs.readFileSync(p, 'utf8') + '\n'; } catch { /* 正被写 */ }
  }
  return out;
}
async function waitVault(needle, tries = 24) {
  for (let i = 0; i < tries; i++) {
    if (vaultText().indexOf(needle) >= 0) return true;
    await sleep(150);
  }
  return false;
}

async function main() {
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

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(`document.querySelector('#lk-toolbar [data-tool="codex"]').click(); true`);
  await sleep(1200);
  await ev(`(function () { const r = document.querySelector('#cx-list [data-cx-id]'); if (r) r.click(); return true; })()`);
  await sleep(600);
  await ev(`(function () { const b = document.getElementById('lk-agent-close'); if (b) b.click(); return true; })()`);
  await sleep(400);

  const rows = () => ev(`document.querySelectorAll('#cx-list [data-cx-id]').length`);
  const cards = () => ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__prop').length`);
  const cardTitles = () => ev(`[...document.querySelectorAll('#lk-agent-msgs .lk-agent__prop-h')].map((h) => h.textContent)`);
  const lastBubble = () => ev(`(() => { const b = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')]; return b.length ? b[b.length - 1].textContent : ''; })()`);
  const lastTool = () => ev(`(() => { const t = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__tool')]; return t.length ? t[t.length - 1].textContent : ''; })()`);
  const setMock = (queue) => ev(`window.__lkSeen = []; window.__lkMockQ = ${JSON.stringify(queue)}; window.__lkAgentMock = (m) => { window.__lkSeen.push(m); return window.__lkMockQ.length ? window.__lkMockQ.shift() : '好的。'; }; true`);
  const ask = async (text) => {
    await ev(`(function () { const t = document.getElementById('lk-agent-input'); t.value = ${JSON.stringify(text)}; document.getElementById('lk-agent-send').click(); return true; })()`);
    await sleep(1100);
  };
  const applyLast = async () => {
    const ok = await ev(`(function () {
      const btns = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__prop [data-prop-ok]')];
      if (!btns.length) return false;
      btns[btns.length - 1].click();
      return true;
    })()`);
    await sleep(700);
    return ok;
  };

  const pre = await ev(`({
    tools: [...document.querySelectorAll('#lk-toolbar .lk-tool-btn')].map((b) => b.dataset.tool),
    panel: !!document.getElementById('lk-agent-panel'),
    rows: document.querySelectorAll('#cx-list [data-cx-id]').length,
  })`);
  check('★0 前置：工作台开着、助手按钮在、此刻没有面板、设定库里有播种的那条设定',
    pre.tools.indexOf('agent') >= 0 && pre.panel === false && pre.rows === 1, pre);

  /* ---------- ① 切到 Agent，先建出第二条设定（批量要有两条可改） ---------- */
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
  await sleep(700);
  const mode0 = await ev(`(document.getElementById('lk-agent-panel') || {}).dataset ? document.getElementById('lk-agent-panel').dataset.mode : ''`);
  /* ⚠️ 批量形态只在 Agent 模式认（用户 2026-09-26 的分工），所以下面每一步前都确认模式是 agent */
  await ev(`document.getElementById('lk-agent-mode-agent').click(); true`);
  await sleep(400);
  const modeAgent = await ev(`document.getElementById('lk-agent-panel').dataset.mode`);
  await setMock(['{"tool":"create_entity","args":{"name":"批量第二条","type":"角色","fields":{"发色":"墨黑"}}}']);
  await ask('建一条叫「批量第二条」的设定。');
  const applyOk = await applyLast();
  const afterCreate = await rows();
  check('★1 起点：面板默认聊天 ⇒ 切到 Agent 后建出第二条设定（批量改才有两条可改）',
    mode0 === 'chat' && modeAgent === 'agent' && applyOk === true && afterCreate === 2,
    { mode0, modeAgent, applyOk, rows: afterCreate });

  /* ---------- ② 批量改字段：一张卡片改两条 ---------- */
  const cards0 = await cards();
  await setMock(['{"tool":"set_field","args":{"entities":["银发少女","批量第二条"],"field":"发色","value":"银白"}}']);
  await ask('把「银发少女」和「批量第二条」的发色都改成银白。');
  const titles2 = await cardTitles();
  const lastTitle2 = titles2.length ? titles2[titles2.length - 1] : '';
  const newCards2 = (await cards()) - cards0;
  const detail2 = await ev(`(() => { const d = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__prop-d')]; return d.length ? d[d.length - 1].textContent : ''; })()`);
  await applyLast();
  const wrote2 = await waitVault('银白');
  const note2 = await lastTool();
  check('★2 ⭐批量改字段：一条动作 ⇒ **一张**卡片（标题写明几条），点「应用」后**两条**都改了、且真的写进 vault 的 .md',
    newCards2 === 1 && lastTitle2.indexOf('2 条设定') >= 0 && detail2.indexOf('银发少女') >= 0 && detail2.indexOf('批量第二条') >= 0
      && wrote2 === true && note2.indexOf('2 条设定') >= 0,
    { newCards2, lastTitle2, detail2: detail2.slice(0, 60), wrote2, note2: note2.slice(0, 60) });

  /* ---------- ③ 批量建事件：一张卡片建一串 ---------- */
  const cards1 = await cards();
  await setMock(['{"tool":"create_node","args":{"nodes":[{"title":"批量事件甲","year":100},{"title":"批量事件乙","year":200,"kind":"战争"}]}}']);
  await ask('在时间线上一次建两个事件：批量事件甲（100 年）、批量事件乙（200 年 · 战争）。');
  const titles3 = await cardTitles();
  const lastTitle3 = titles3.length ? titles3[titles3.length - 1] : '';
  const newCards3 = (await cards()) - cards1;
  await applyLast();
  const wrote3a = await waitVault('批量事件甲');
  const wrote3b = await waitVault('批量事件乙');
  check('★3 ⭐批量建事件：一条动作 ⇒ 一张卡片（标题写明几个），点「应用」后**两个事件**都建出来、真的落进 vault',
    newCards3 === 1 && lastTitle3.indexOf('2 个') >= 0 && wrote3a === true && wrote3b === true,
    { newCards3, lastTitle3, wrote3a, wrote3b });

  /* ---------- ④ 聊天模式不认批量形态（用户的分工：批量归 Agent） ---------- */
  await ev(`document.getElementById('lk-agent-mode-chat').click(); true`);
  await sleep(400);
  const cards2 = await cards();
  await setMock(['{"tool":"set_field","args":{"entities":["银发少女","批量第二条"],"field":"发色","value":"墨绿"}}']);
  await ask('把这两条的发色都改成墨绿。');
  const after4 = { mode: await ev(`document.getElementById('lk-agent-panel').dataset.mode`), cards: await cards(), tool: await lastTool() };
  const leaked = await waitVault('墨绿', 6);
  check('★4 ⭐聊天模式收到批量形态：**不出卡片**、一句话让它切 Agent，数据一个字没动',
    after4.mode === 'chat' && after4.cards === cards2 && after4.tool.indexOf('Agent') >= 0 && leaked === false,
    { mode: after4.mode, cardsBefore: cards2, cards: after4.cards, tool: after4.tool.slice(0, 70), leaked });

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
