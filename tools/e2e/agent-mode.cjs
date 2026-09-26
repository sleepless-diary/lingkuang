/* agent-mode.cjs —— 灵框助手的**两种模式**（片 4：聊天 / Agent）
 *
 * 用户原话（2026-09-26）：「我想让灵框平常是正常的聊天及工作，但是少数情况下有 agent 工作能力。」
 * ⇒ 这份套件守的就是这个目的，四条不变量：
 *   ① 面板**每次打开都是聊天模式**（模式不落盘、不进设置）——「少数情况」不许变成"忘了切回来"；
 *   ② 聊天模式的系统提示里**没有**动作协议与权限段（本地小模型看了协议就爱吐 JSON，
 *      平常聊天不该被带偏），但长期记忆与工作区现状照旧都在（只是少了那两段）；
 *   ③ 聊天模式的回复**不解析动作**：模型偶尔吐 JSON 也只当文字画出来，不出卡片、不落盘；
 *   ④ 切到 Agent 才拿到协议与闸门；关掉面板再打开 = 授权收回（回聊天）。
 *
 * ⭐ 最要紧的三条：
 *   ★2 —— 聊天模式的 sys 里**没有** `【你能用的动作】`（这是"平常是聊天"的机械判据）；
 *   ★5 —— Agent 模式的 sys 里**有**协议与权限段；
 *   ★7 —— 关开一次回到聊天（授权不残留）。
 *
 * 假引擎：`window.__lkAgentMock`（见 src/ui/agent-model.ts）——用**函数形态**顺手把喂进去的
 * messages 存进 `window.__lkSeen`，好断言提示词里到底有什么。
 *
 * 前置（同一 pwsh 调用里做，再起实例）：
 *   $env:LINGKUANG_TEST_DATA=<lk-evault2>\worldbuilding.json; $env:LINGKUANG_VAULT=<lk-evault2>\vault
 *   $env:LINGKUANG_TEST_USERDATA=<lk-evault2>\userdata
 *   node tools\e2e\reset-entity-vault.cjs; node tools\e2e\seed-node.cjs; node tools\e2e\seed-agent-memory.cjs
 * 跑：$env:LK_CDP_PORT=9346; node tools\e2e\agent-mode.cjs
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

  /* ---------- 打开工作台（设定库里要有东西，才量得出"没落盘"） ---------- */
  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(`document.querySelector('#lk-toolbar [data-tool="codex"]').click(); true`);
  await sleep(1200);
  await ev(`(function () { const r = document.querySelector('#cx-list [data-cx-id]'); if (r) r.click(); return true; })()`);
  await sleep(600);
  /* 起点摆正：上一份套件可能把面板留着开着，Ctrl+K 反而会把它关掉 */
  await ev(`(function () { const b = document.getElementById('lk-agent-close'); if (b) b.click(); return true; })()`);
  await sleep(400);

  const rows = () => ev(`document.querySelectorAll('#cx-list [data-cx-id]').length`);
  const cards = () => ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__prop').length`);
  const bubbles = () => ev(`[...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')].map((b) => b.textContent)`);
  const modeSnap = () => ev(`(() => {
    const p = document.getElementById('lk-agent-panel');
    if (!p) return { exists: false };
    const sel = p.querySelector('#lk-agent-perm');
    const seg = [...p.querySelectorAll('.lk-agent__seg-btn')];
    return {
      exists: true,
      mode: p.dataset.mode || '',
      agentClass: p.classList.contains('is-agent'),
      segs: seg.map((b) => b.dataset.mode + (b.classList.contains('is-on') ? ':on' : ':off')),
      permOff: !!(p.querySelector('.lk-agent__perm') || {}).classList.contains && p.querySelector('.lk-agent__perm').classList.contains('is-off'),
      permDisabled: sel ? sel.disabled : null,
      gate: p.dataset.gate || '',
      modeHint: (p.querySelector('#lk-agent-mode-hint') || {}).textContent || '',
    };
  })()`);
  const sysOf = () => ev(`(() => {
    /* __lkSeen 是「每次调用一条」的数组（每条 = 喂进去的 messages）；取最近一次 */
    const calls = window.__lkSeen || [];
    const m = calls.length ? calls[calls.length - 1] : [];
    const s = (m[0] && m[0].content) || '';
    return {
      n: calls.length, role: m[0] && m[0].role, chars: s.length,
      hasTools: s.indexOf('【你能用的动作】') >= 0,
      hasToolExample: s.indexOf('{"tool":"read_entity"') >= 0,
      hasWarn: s.indexOf('不要写成') >= 0,
      hasPerm: s.indexOf('【你的权限') >= 0,
      hasChatNote: s.indexOf('【你现在是「聊天」模式】') >= 0,
      hasCtx: s.indexOf('【工作区现状】') >= 0,
      hasHead: s.indexOf('你是「灵框」里的创作助手') >= 0,
      last: (m[m.length - 1] && m[m.length - 1].content) || '',
    };
  })()`);
  const ask = async (text) => {
    await ev(`(function () { const t = document.getElementById('lk-agent-input'); t.value = ${JSON.stringify(text)}; document.getElementById('lk-agent-send').click(); return true; })()`);
    await sleep(1000);
  };
  const setMock = async (queue) => ev(`window.__lkSeen = []; window.__lkMockQ = ${JSON.stringify(queue)}; window.__lkAgentMock = (m) => { window.__lkSeen.push(m); return window.__lkMockQ.length ? window.__lkMockQ.shift() : '好的。'; }; true`);

  const pre = await ev(`({
    tools: [...document.querySelectorAll('#lk-toolbar .lk-tool-btn')].map((b) => b.dataset.tool),
    panel: !!document.getElementById('lk-agent-panel'),
  })`);
  check('★0 前置：工作台开着、助手按钮在、此刻没有面板（也没有 data-mode 可读）',
    pre.tools.includes('agent') === true && pre.panel === false, pre);

  /* ---------- ① 默认 = 聊天模式 ---------- */
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
  await sleep(700);
  const opened = await modeSnap();
  check('★1 ⭐打开面板默认是「聊天」：data-mode=chat、分段控件 chat 亮、权限那行压暗且下拉禁用',
    opened.exists === true && opened.mode === 'chat' && opened.agentClass === false
      && opened.segs.join(',') === 'chat:on,agent:off' && opened.permOff === true && opened.permDisabled === true
      && opened.modeHint.indexOf('聊天') >= 0,
    opened);

  /* ---------- ② 聊天模式的系统提示：没有协议，但上下文照旧 ---------- */
  await setMock(['我在，你想聊点什么？']);
  await ask('随便聊聊。');
  const chatSys = await sysOf();
  check('★2 ⭐聊天模式的 sys 里**没有**动作协议 / 权限段 / 格式警告，而且只调用模型一轮（平常聊天不该被 JSON 协议带偏）',
    chatSys.role === 'system' && chatSys.hasHead === true && chatSys.hasCtx === true
      && chatSys.hasChatNote === true && chatSys.hasTools === false && chatSys.hasToolExample === false
      && chatSys.hasWarn === false && chatSys.hasPerm === false
      && chatSys.n === 1 && chatSys.last === '随便聊聊。',
    chatSys);

  /* ---------- ③ 聊天模式不解析动作：模型吐 JSON 也只当文字 ---------- */
  const rows0 = await rows();
  const cards0 = await cards();
  await setMock(['{"tool":"create_entity","args":{"name":"聊天模式不该建的东西","type":"角色"}}']);
  await ask('帮我建一条「聊天模式不该建的东西」。');
  const chatJson = { cards: await cards(), rows: await rows(), bubbles: await bubbles() };
  check('★3 聊天模式下模型吐 JSON：不出卡片、不落盘，只当普通文字画出来（不解析）',
    cards0 === 0 && chatJson.cards === 0 && chatJson.rows === rows0
      && chatJson.bubbles.some((b) => b.indexOf('create_entity') >= 0),
    { rows0, cards0, cards: chatJson.cards, rows: chatJson.rows, nBub: chatJson.bubbles.length });

  /* ---------- ④ 切到 Agent：协议与闸门都回来 ---------- */
  await ev(`document.getElementById('lk-agent-mode-agent').click(); true`);
  await sleep(400);
  const agentUi = await modeSnap();
  check('★4 切到 Agent：data-mode=agent、面板根带 .is-agent、权限下拉恢复可用、闸门有值',
    agentUi.mode === 'agent' && agentUi.agentClass === true
      && agentUi.segs.join(',') === 'chat:off,agent:on' && agentUi.permOff === false
      && agentUi.permDisabled === false && ['deny', 'propose', 'allow'].indexOf(agentUi.gate) >= 0,
    agentUi);

  await setMock(['我先看看有什么设定。']);
  await ask('现在都有哪些设定？');
  const agentSys = await sysOf();
  check('★5 ⭐Agent 模式的 sys 里动作协议、格式警告、权限段都在（这是"能动手"的说明书）',
    agentSys.hasTools === true && agentSys.hasToolExample === true && agentSys.hasWarn === true
      && agentSys.hasPerm === true && agentSys.hasCtx === true && agentSys.hasChatNote === false,
    agentSys);

  /* ---------- ⑤ Agent 模式：写动作照旧出提议卡片（回归） ---------- */
  const gate = await ev(`document.getElementById('lk-agent-panel').dataset.gate`);
  await setMock(['{"tool":"create_entity","args":{"name":"模式回归条目","type":"角色"}}']);
  await ask('建一条叫「模式回归条目」的。');
  const props = await ev(`[...document.querySelectorAll('#lk-agent-msgs .lk-agent__prop')].map((p) => (p.querySelector('.lk-agent__prop-h') || {}).textContent || '')`);
  check('★6 Agent 模式 + 默认权限档：写动作变成提议卡片（点应用前不落盘）',
    gate === 'propose' && props.length === 1 && props[0].indexOf('模式回归条目') >= 0 && (await rows()) === rows0,
    { gate, props, rows: await rows(), rows0 });

  /* ---------- ⑥ 关掉再打开 = 授权收回 ---------- */
  await ev(`document.getElementById('lk-agent-close').click(); true`);
  await sleep(700);
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
  await sleep(700);
  const reopened = await modeSnap();
  const kept = await ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__msg').length`);
  check('★7 ⭐关掉再打开回到聊天模式（"动手"的授权不残留），但对话历史还在',
    reopened.exists === true && reopened.mode === 'chat' && reopened.agentClass === false
      && reopened.permDisabled === true && kept >= 4,
    { mode: reopened.mode, msgs: kept, permDisabled: reopened.permDisabled });

  const errs = await ev(`window.__errs`);
  check('★8 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`==== ${pass}/${results.length} PASS ====`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : String(e)));
  process.exit(2);
});
