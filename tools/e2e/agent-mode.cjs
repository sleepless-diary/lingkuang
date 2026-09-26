/* agent-mode.cjs —— 灵框助手的**两种模式**（片 4：聊天 / Agent）
 *
 * 用户原话（2026-09-26）：「我想让灵框平常是正常的聊天及工作，但是少数情况下有 agent 工作能力。」
 * 当天第二次改口：「**聊天模式也留一点灵框内部的工具吧，agent 模式是在灵框外工作用的**」
 * ⇒ 这份套件守的就是这个目的，五条不变量：
 *   ① 面板**每次打开都是聊天模式**（模式不落盘、不进设置）——「少数情况」不许变成"忘了切回来"；
 *   ② 聊天模式的系统提示里**有**灵框内部的动作协议与权限段（"也留一点内部工具"），
 *      但写明「一次提问只提一个动作」；Agent 模式换个说法：「可以连着提多个动作」；
 *   ③ 聊天模式的回复**照旧解析动作**：读动作当场执行、写动作只出卡片不落盘；
 *   ④ 切到 Agent 才拿到多步自主；关掉面板再打开 = 授权收回（回聊天）；
 *   ⑤ 自我提权（`set_mode` → agent）**永远**要创作者亲手点「应用」，哪怕权限是"直接执行"档。
 *
 * ⭐ 最要紧的四条：
 *   ★2 —— 聊天模式的 sys 里**有** `【你能用的动作】` 且写了"一次只做一个动作"；
 *   ★3 —— 聊天模式下模型吐动作 JSON 会被**真执行**（旧版把它当文字，是片 4 的规矩，已推翻）；
 *   ★6b —— 直接执行档下 `set_mode agent` 仍然只出卡片、模式没变；
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
    const sSel = p.querySelector('#lk-agent-scope');
    const aSel = p.querySelector('#lk-agent-ask');
    const seg = [...p.querySelectorAll('.lk-agent__seg-btn')];
    return {
      exists: true,
      mode: p.dataset.mode || '',
      agentClass: p.classList.contains('is-agent'),
      segs: seg.map((b) => b.dataset.mode + (b.classList.contains('is-on') ? ':on' : ':off')),
      permOff: !!(p.querySelector('.lk-agent__perm') || {}).classList.contains && p.querySelector('.lk-agent__perm').classList.contains('is-off'),
      permDisabled: (sSel && aSel) ? (sSel.disabled && aSel.disabled) : null,
      permScope: sSel ? sSel.value : '',
      permAsk: aSel ? aSel.value : '',
      permHint: (p.querySelector('#lk-agent-perm-hint') || {}).textContent || '',
      gate: p.dataset.gate || '',
      modeHint: (p.querySelector('#lk-agent-mode-hint') || {}).textContent || '',
    };
  })()`);
  /* 摆权限两旋钮（范围 × 询问）。⚠️ 顺序：先派 scope 的 change（处理器会把 ask 下拉重置成已存值），
     再写 ask.value 并派它的 change —— 反过来写会被 renderPerm() 覆盖掉。 */
  const setKnobs = async (scope, ask) => {
    await ev(`(function () {
      const s = document.getElementById('lk-agent-scope');
      const a = document.getElementById('lk-agent-ask');
      if (!s || !a) return false;   /* 旧构建（单档权限）没有这两个下拉 ⇒ 让断言去 FAIL，别把套件崩掉 */
      s.value = ${JSON.stringify(scope)}; s.dispatchEvent(new Event('change', { bubbles: true }));
      a.value = ${JSON.stringify(ask)}; a.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(250);
  };
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
      hasAgentNote: s.indexOf('【你现在是「Agent」模式】') >= 0,
      oneStep: s.indexOf('一次提问只提一个动作') >= 0,
      multiStep: s.indexOf('可以连着提多个动作') >= 0,
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
  check('★1 ⭐打开面板默认是「聊天」：data-mode=chat、分段控件 chat 亮、权限两把旋钮在**两个模式都可用**（聊天也能动手，只是按下面那档走）',
    opened.exists === true && opened.mode === 'chat' && opened.agentClass === false
      && opened.segs.join(',') === 'chat:on,agent:off' && opened.permOff === false && opened.permDisabled === false
      && ['readonly', 'workspace'].indexOf(opened.permScope) >= 0 && ['always', 'never'].indexOf(opened.permAsk) >= 0
      && opened.modeHint.indexOf('聊天') >= 0 && opened.permHint.indexOf('逐项确认') >= 0,
    opened);

  /* ---------- ② 聊天模式的系统提示：**也有**灵框内部的动作（用户当天改口）---------- */
  await setMock(['我在，你想聊点什么？']);
  await ask('随便聊聊。');
  const chatSys = await sysOf();
  check('★2 ⭐聊天模式的 sys 里**有**动作协议与权限段（"聊天模式也留一点灵框内部的工具"），且写明"一次提问只提一个动作"',
    chatSys.role === 'system' && chatSys.hasHead === true && chatSys.hasCtx === true
      && chatSys.hasChatNote === true && chatSys.hasAgentNote === false
      && chatSys.hasTools === true && chatSys.hasToolExample === true && chatSys.hasWarn === true
      && chatSys.hasPerm === true && chatSys.oneStep === true && chatSys.multiStep === false
      && chatSys.n === 1 && chatSys.last === '随便聊聊。',
    chatSys);

  /* ---------- ③ 聊天模式**照旧解析动作**：读动作当场执行；写动作只出卡片、不落盘 ---------- */
  const rows0 = await rows();
  const cards0 = await cards();
  const calls0 = await ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__call').length`);
  await setMock(['{"tool":"list_entities","args":{}}', '我看了一下。']);
  await ask('现在都有哪些设定？');
  const chatRead = await ev(`({
    calls: document.querySelectorAll('#lk-agent-msgs .lk-agent__call').length,
    receipts: document.querySelectorAll('#lk-agent-msgs .lk-agent__tool').length,
    rows: document.querySelectorAll('#cx-list [data-cx-id]').length,
  })`);
  await setMock(['{"tool":"create_entity","args":{"name":"聊天模式下的卡片条目","type":"角色"}}']);
  await ask('建一条叫「聊天模式下的卡片条目」的。');
  const chatWrite = { cards: await cards(), rows: await rows() };
  check('★3 ⭐聊天模式也解析动作：读动作当场执行（出「用到动作」+ 回执），写动作只出卡片、不落盘',
    chatRead.calls === calls0 + 1 && chatRead.receipts >= 1 && chatRead.rows === rows0
      && chatWrite.cards === cards0 + 1 && chatWrite.rows === rows0,
    { calls0, chatRead, rows0, cards0, chatWrite });

  /* ---------- ④ 切到 Agent：协议与闸门都回来 ---------- */
  await ev(`document.getElementById('lk-agent-mode-agent').click(); true`);
  await sleep(400);
  const agentUi = await modeSnap();
  check('★4 切到 Agent：data-mode=agent、面板根带 .is-agent、权限下拉恢复可用、闸门有值',
    agentUi.mode === 'agent' && agentUi.agentClass === true
      && agentUi.segs.join(',') === 'chat:off,agent:on' && agentUi.permOff === false
      && agentUi.permDisabled === false && ['deny', 'propose', 'allow'].indexOf(agentUi.gate) >= 0,
    agentUi);

  /* ---------- ④b 权限是**两个正交旋钮**（范围 × 询问）---------- */
  await setKnobs('readonly', 'never');
  const knobRO = await modeSnap();
  await setKnobs('workspace', 'never');
  const knobYOLO = await modeSnap();
  await setKnobs('workspace', 'always');
  const knobOK = await modeSnap();
  check('★4b ⭐权限 = 范围 × 询问两个旋钮：只读+直接执行 仍然不许写（范围优先），可写+直接执行 放行，可写+每次确认 出卡片',
    knobRO.gate === 'deny' && knobRO.permScope === 'readonly' && knobRO.permAsk === 'never'
      && knobYOLO.gate === 'allow' && knobYOLO.permAsk === 'never'
      && knobOK.gate === 'propose' && knobOK.permHint.indexOf('逐项确认') >= 0,
    { ro: knobRO.gate, yolo: knobYOLO.gate, ok: knobOK.gate, hint: knobOK.permHint.slice(0, 28) });

  await setMock(['我先看看有什么设定。']);
  await ask('现在都有哪些设定？');
  const agentSys = await sysOf();
  check('★5 ⭐Agent 模式的 sys 里动作协议、格式警告、权限段都在，且写明"可以连着提多个动作"（多步自主）',
    agentSys.hasTools === true && agentSys.hasToolExample === true && agentSys.hasWarn === true
      && agentSys.hasPerm === true && agentSys.hasCtx === true && agentSys.hasChatNote === false
      && agentSys.hasAgentNote === true && agentSys.multiStep === true && agentSys.oneStep === false,
    agentSys);

  /* ---------- ⑤ Agent 模式：写动作照旧出提议卡片（回归） ---------- */
  const gate = await ev(`document.getElementById('lk-agent-panel').dataset.gate`);
  await setMock(['{"tool":"create_entity","args":{"name":"模式回归条目","type":"角色"}}']);
  await ask('建一条叫「模式回归条目」的。');
  const props = await ev(`[...document.querySelectorAll('#lk-agent-msgs .lk-agent__prop')].map((p) => (p.querySelector('.lk-agent__prop-h') || {}).textContent || '')`);
  const propsLast = props.length ? props[props.length - 1] : '';
  check('★6 Agent 模式 + 默认权限档：写动作变成提议卡片（点应用前不落盘）',
    gate === 'propose' && propsLast.indexOf('模式回归条目') >= 0 && (await rows()) === rows0,
    { gate, props, rows: await rows(), rows0 });

  /* ---------- ⑥b 自我提权永远要创作者点头（哪怕权限是"直接执行"档） ---------- */
  await setKnobs('workspace', 'never');       /* 直接执行档：平常的写入不再问 */
  const yoloGate = await ev(`document.getElementById('lk-agent-panel').dataset.gate`);
  await ev(`document.getElementById('lk-agent-mode-chat').click(); true`);
  await sleep(400);
  await setMock(['{"tool":"set_mode","args":{"mode":"agent"}}']);
  await ask('你自己切到 Agent 模式吧。');
  const widen = await ev(`({
    mode: document.getElementById('lk-agent-panel').dataset.mode,
    titles: [...document.querySelectorAll('#lk-agent-msgs .lk-agent__prop-h')].map((h) => h.textContent),
  })`);
  const lastTitle = widen.titles.length ? widen.titles[widen.titles.length - 1] : '';
  check('★6b ⭐"直接执行"档下自我提权（set_mode → agent）**仍然**只出一张卡片、模式没变（这一步必须他亲手点）',
    yoloGate === 'allow' && widen.mode === 'chat' && lastTitle.indexOf('助手模式') >= 0,
    { yoloGate, mode: widen.mode, lastTitle, titles: widen.titles });

  /* ---------- ⑥c 点了「应用」之后模式才真的切过去 ---------- */
  await ev(`(function () {
    const btns = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__prop [data-prop-ok]')];
    if (!btns.length) return false;
    btns[btns.length - 1].click();
    return true;
  })()`);
  await sleep(600);
  const applied = await modeSnap();
  check('★6c 点了「应用」之后模式才切到 agent（自我提权那一步由创作者亲手点）',
    applied.mode === 'agent' && applied.agentClass === true && applied.segs.join(',') === 'chat:off,agent:on',
    { mode: applied.mode, agentClass: applied.agentClass, segs: applied.segs });

  /* ---------- ⑥ 关掉再打开 = 授权收回 ---------- */
  await ev(`document.getElementById('lk-agent-close').click(); true`);
  await sleep(700);
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
  await sleep(700);
  const reopened = await modeSnap();
  const kept = await ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__msg').length`);
  check('★7 ⭐关掉再打开回到聊天模式（"多步自主"的授权不残留），但对话历史还在',
    reopened.exists === true && reopened.mode === 'chat' && reopened.agentClass === false
      && reopened.permDisabled === false && kept >= 4,
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
