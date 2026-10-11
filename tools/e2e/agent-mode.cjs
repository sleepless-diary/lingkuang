/* agent-mode.cjs —— 灵框助手的**两种档位**（片 4 的「聊天 / Agent」；2026-10-11 改叫「自动 / 一轮」）
 *
 * 用户原话（2026-09-26）：「我想让灵框平常是正常的聊天及工作，但是少数情况下有 agent 工作能力。」
 * 当天第二次改口：「**聊天模式也留一点灵框内部的工具吧，agent 模式是在灵框外工作用的**」
 * 2026-10-11 又一次改口（这份套件跟着改）：**「还有使用工具时能不能直接切换到 agent 模式
 * （话说聊天模式真的有必要吗）」** ⇒ 两个档的能力早就一样了，差的只是步子多少：
 *   ① 面板**默认就是「自动」档**（data-mode=agent）—— "这一问该拨哪个档"不该由创作者猜；
 *   ② 模式**落盘**（`lingkuang-settings.agentMode`，用户选了「记着」）⇒ 关掉再打开**保持**上次那个档，
 *      不再像上一版那样回落成「聊天」；
 *   ③ 「一轮」档：sys 里有全部动作协议与权限段，但写明「一次提问只提一个动作」；
 *      「自动」档换个说法：「可以连着提多个动作」；
 *   ④ 两个档的回复**都解析动作**：读动作当场执行、写动作只出卡片不落盘；
 *   ⑤ 自我提权（`set_mode` → agent）**永远**要创作者亲手点「应用」，哪怕权限是"直接执行"档。
 *
 * ⭐ 最要紧的四条：
 *   ★1 —— 默认开局就是「自动」（分段控件 agent 亮、data-mode=agent）；
 *   ★2 —— 「一轮」档的 sys 里**有** `【你能用的动作】` 且写了"一次只做一个动作"；
 *   ★3 —— 「一轮」档下模型吐动作 JSON 会被**真执行**（旧版把它当文字，是片 4 的规矩，已推翻）；
 *   ★6b —— 直接执行档下 `set_mode agent` 仍然只出卡片、模式没变；
 *   ★7 —— 关开一次**保持**上次那个档（落盘），而且 localStorage 里真的写着它。
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
  /** ⭐ `location.reload()` 期间执行上下文会被换掉（读会抛、也可能拿到 null）⇒ 带重试的读法
   *  （★7b 要跨一次真·重载证明模式是落盘的；典例见 `session-restore.cjs`）。 */
  const evSoft = async (expr, tries = 20) => {
    for (let i = 0; i < tries; i++) {
      try {
        const v = await ev(expr);
        if (v !== undefined && v !== null) return v;
      } catch { /* 上下文还没回来 */ }
      await sleep(250);
    }
    return undefined;
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
      hasChatNote: s.indexOf('【你现在是「一轮」模式】') >= 0,
      hasAgentNote: s.indexOf('【你现在是「自动」模式】') >= 0,
      oneStep: s.indexOf('一次提问只提一个动作') >= 0,
      multiStep: s.indexOf('可以连着提多个动作') >= 0,
      stepsFree: s.indexOf('步数不限') >= 0,
      stepsEight: s.indexOf('我最多放你连着走 8 步') >= 0,
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

  /* ---------- ① 默认 = 自动档（2026-10-11：用户「使用工具时能不能直接切换到 agent 模式」）---------- */
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
  await sleep(700);
  const opened = await modeSnap();
  check('★1 ⭐打开面板**默认就是「自动」档**：data-mode=agent、分段控件 agent 亮、权限两把旋钮两个档都可用（"该拨哪个档"不用创作者猜）',
    opened.exists === true && opened.mode === 'agent' && opened.agentClass === true
      && opened.segs.join(',') === 'chat:off,agent:on' && opened.permOff === false && opened.permDisabled === false
      && ['readonly', 'workspace'].indexOf(opened.permScope) >= 0 && ['always', 'never'].indexOf(opened.permAsk) >= 0
      && opened.modeHint.indexOf('自动') >= 0 && opened.permHint.indexOf('逐项确认') >= 0,
    opened);

  /* ---------- ①b 显式切到「一轮」档（下面 ②③ 测的就是这个档的克制语义）---------- */
  await ev(`document.getElementById('lk-agent-mode-chat').click(); true`);
  await sleep(400);
  const oneRound = await modeSnap();
  check('★1b 切成「一轮」档：data-mode=chat、焦点文案写「一轮」、而且**立刻落盘**（`lingkuang-settings.agentMode`）',
    oneRound.mode === 'chat' && oneRound.agentClass === false
      && oneRound.segs.join(',') === 'chat:on,agent:off' && oneRound.modeHint.indexOf('一轮') >= 0
      && String(await ev(`JSON.parse(localStorage.getItem('lingkuang-settings') || '{}').agentMode`)) === 'chat',
    { mode: oneRound.mode, segs: oneRound.segs, hint: oneRound.modeHint.slice(0, 30), stored: await ev(`JSON.parse(localStorage.getItem('lingkuang-settings') || '{}').agentMode`) });

  /* ---------- ② 「一轮」档的系统提示：**也有**全部动作（用户当天改口）---------- */
  await setMock(['我在，你想聊点什么？']);
  await ask('随便聊聊。');
  const chatSys = await sysOf();
  check('★2 ⭐「一轮」档的 sys 里**有**动作协议与权限段（"也留一点灵框内部的工具"），且写明"一次提问只提一个动作"',
    chatSys.role === 'system' && chatSys.hasHead === true && chatSys.hasCtx === true
      && chatSys.hasChatNote === true && chatSys.hasAgentNote === false
      && chatSys.hasTools === true && chatSys.hasToolExample === true && chatSys.hasWarn === true
      && chatSys.hasPerm === true && chatSys.oneStep === true && chatSys.multiStep === false
      && chatSys.n === 1 && chatSys.last === '随便聊聊。',
    chatSys);

  /* ---------- ③ 「一轮」档**照旧解析动作**：读动作当场执行；写动作只出卡片、不落盘 ---------- */
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
  check('★3 ⭐「一轮」档也解析动作：读动作当场执行（出「用到动作」+ 回执），写动作只出卡片、不落盘',
    chatRead.calls === calls0 + 1 && chatRead.receipts >= 1 && chatRead.rows === rows0
      && chatWrite.cards === cards0 + 1 && chatWrite.rows === rows0,
    { calls0, chatRead, rows0, cards0, chatWrite });

  /* ---------- ④ 切到「自动」：协议与闸门都回来 ---------- */
  await ev(`document.getElementById('lk-agent-mode-agent').click(); true`);
  await sleep(400);
  const agentUi = await modeSnap();
  check('★4 切到「自动」：data-mode=agent、面板根带 .is-agent、权限下拉可用、闸门有值',
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
  check('★5 ⭐「自动」档的 sys 里动作协议、格式警告、权限段都在，且写明"可以连着提多个动作"（多步自主）',
    agentSys.hasTools === true && agentSys.hasToolExample === true && agentSys.hasWarn === true
      && agentSys.hasPerm === true && agentSys.hasCtx === true && agentSys.hasChatNote === false
      && agentSys.hasAgentNote === true && agentSys.multiStep === true && agentSys.oneStep === false,
    agentSys);

  /* ---------- ⑤ 「自动」档：写动作照旧出提议卡片（回归） ---------- */
  const gate = await ev(`document.getElementById('lk-agent-panel').dataset.gate`);
  await setMock(['{"tool":"create_entity","args":{"name":"模式回归条目","type":"角色"}}']);
  await ask('建一条叫「模式回归条目」的。');
  const props = await ev(`[...document.querySelectorAll('#lk-agent-msgs .lk-agent__prop')].map((p) => (p.querySelector('.lk-agent__prop-h') || {}).textContent || '')`);
  const propsLast = props.length ? props[props.length - 1] : '';
  check('★6 「自动」档 + 默认权限档：写动作变成提议卡片（点应用前不落盘）',
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

  /* ---------- ⑥ 关掉再打开 = **保持**上次那个档（2026-10-11：模式落盘，用户选「记着」） ---------- */
  await ev(`document.getElementById('lk-agent-close').click(); true`);
  await sleep(700);
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
  await sleep(700);
  const reopened = await modeSnap();
  const kept = await ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__msg').length`);
  check('★7 ⭐关掉再打开**保持**上次那个档（上一版是"授权不残留"⇒回聊天；现在用户选了「记着」）：这一刻是 agent（⑥c 刚切过去的），对话历史还在',
    reopened.exists === true && reopened.mode === 'agent' && reopened.agentClass === true
      && reopened.segs.join(',') === 'chat:off,agent:on' && reopened.permDisabled === false && kept >= 4,
    { mode: reopened.mode, segs: reopened.segs, msgs: kept, permDisabled: reopened.permDisabled });

  /* ---------- ⑦ 步数可设、默认**不限**（用户 2026-10-11：「**不能设置无上限吗**」）----------
     不限 ⇒ 不再每 8 步打断一次；提示词里也**不许**再写「我最多放你走 8 步」（写了模型会自己收手，
     正好把"不限"废掉）。 */
  const stepSel = await ev(`(function () {
    const s = document.getElementById('lk-agent-steps');
    return s ? { exists: true, value: s.value, opts: [...s.options].map((o) => o.value), label: s.options[s.selectedIndex].textContent } : { exists: false };
  })()`);
  await setMock(['明白了。']);
  await ask('步数这条问一句。');
  const sysFree = await sysOf();
  check('★15 ⭐步数默认**不限**：面板上有这个旋钮（值是 0、选项 0/8/20/50），系统提示里写「步数不限」而不是「最多 8 步」（用户 2026-10-11：「不能设置无上限吗」）',
    stepSel.exists === true && stepSel.value === '0' && stepSel.opts.join(',') === '0,8,20,50' &&
    stepSel.label.indexOf('不限') >= 0 && sysFree.stepsFree === true && sysFree.stepsEight === false,
    { sel: stepSel, free: sysFree.stepsFree, eight: sysFree.stepsEight });

  /* 改成 8 ⇒ 当场生效（提示词改口）+ 落盘（关掉重开还是它）。⚠️ 元素不在就优雅判假（旧构建上要能跑完剩下的星） */
  await ev(`(function () { const s = document.getElementById('lk-agent-steps'); if (!s) return false; s.value = '8'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(300);
  const stored8 = await ev(`JSON.parse(localStorage.getItem('lingkuang-settings') || '{}').agentSteps`);
  await setMock(['好。']);
  await ask('再问一句。');
  const sys8 = await sysOf();
  check('★15b 改成 8 步：提示词当场改口，而且写进了 `localStorage.lingkuang-settings.agentSteps`',
    stored8 === 8 && sys8.stepsEight === true && sys8.stepsFree === false,
    { stored: stored8, eight: sys8.stepsEight, free: sys8.stepsFree });

  /* ---------- ⑧ ⭐「停」：跑起来「停」按钮显形，点一下这一步做完就收手 ----------
     步数默认不限 ⇒ 必须有个随时能掐的地方。假引擎每 400ms 吐一个只读动作（不限档 200 步封顶），
     点「停」之后**只有**停这条路会写「已停下」（跑到封顶写的是另一句）—— 所以这里拿它当判据。
     ⚠️ 发送键**不许**兼职当"停"：套件的 `ask()` 都是盲点它，兼职会让"提问"变成"打断"
     （`agent-dsml` ★4/★5 当场连挂就是这么来的）—— 所以这里同时断言发送键文案始终是「发送」。 */
  const stopBtn = () => ev(`(function () {
    const s = document.getElementById('lk-agent-stop');
    const g = document.getElementById('lk-agent-send');
    return { has: !!s, hidden: !s || s.hidden === true, send: g ? g.textContent : '' };
  })()`);
  const stopIdle = await stopBtn();
  await ev(`(function () { const s = document.getElementById('lk-agent-steps'); if (!s) return false; s.value = '0'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await ev(`window.__lkSeen = []; window.__lkAgentMock = (m) => new Promise((r) => setTimeout(() => { window.__lkSeen.push(m); r('{"tool":"list_entities","args":{}}'); }, 400)); true`);
  await ev(`(function () { const t = document.getElementById('lk-agent-input'); t.value = '让它转起来。'; document.getElementById('lk-agent-send').click(); return true; })()`);
  await sleep(1400);
  const running = await stopBtn();
  await ev(`(function () { const s = document.getElementById('lk-agent-stop'); if (s) s.click(); return true; })()`);
  await sleep(1600);
  const afterStop = await ev(`(function () {
    const s = document.getElementById('lk-agent-stop');
    const g = document.getElementById('lk-agent-send');
    return {
      hidden: !s || s.hidden === true, send: g ? g.textContent : '',
      calls: window.__lkSeen.length,
      note: (document.getElementById('lk-agent-note') || {}).textContent || '',
    };
  })()`);
  await sleep(1300);
  const later = await ev(`window.__lkSeen.length`);
  check('★16 ⭐步数不限时有「停」：跑起来它才显形、点一下这一步做完就收手（步数不再增长、它收回、底部写「已停下」）；发送键始终只写「发送」（不兼职打断）',
    stopIdle.has === true && stopIdle.hidden === true &&
    running.hidden === false && running.send === '发送' &&
    afterStop.hidden === true && afterStop.send === '发送' &&
    afterStop.note.indexOf('已停下') >= 0 && later === afterStop.calls,
    { idle: stopIdle, running: running, after: afterStop, later: later });

  /* ---------- ⑥b ⭐落盘是真的：把 localStorage 写成 chat ⇒ 重载后开局就是「一轮」 ---------- */
  await ev(`(function () {
    const k = 'lingkuang-settings';
    const s = JSON.parse(localStorage.getItem(k) || '{}');
    s.agentMode = 'chat';
    localStorage.setItem(k, JSON.stringify(s));
    return s.agentMode;
  })()`);
  await ev(`document.getElementById('lk-agent-close').click(); true`);
  await sleep(600);
  try { await ev(`window.location.reload()`); } catch { /* 导航期间读不到回执是正常的 */ }
  await sleep(2500);
  /* ⚠️ 重载会把套件自己装的错误钩子一起冲掉（文件开头那次 `window.__errs = []`）—— 装回去，
     否则 ★8 读到 undefined（首跑就是这么红的）。 */
  await evSoft(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  /* 重载后应用是全新一份（面板一般不会再开着）⇒ 先按 Ctrl+K 开出来，再读那两段按钮 */
  await evSoft(`(function () {
    if (!document.getElementById('lk-agent-panel')) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    }
    return true;
  })()`);
  const reloaded = await evSoft(`(function () {
    const p = document.getElementById('lk-agent-panel');
    if (!p) return null;
    const seg = [...p.querySelectorAll('#lk-agent-mode .lk-agent__seg-btn')];
    return {
      exists: true, mode: p.dataset.mode || '', agentClass: p.classList.contains('is-agent'),
      segs: seg.map((b) => b.dataset.mode + (b.classList.contains('is-on') ? ':on' : ':off')),
    };
  })()`);
  check('★7b ⭐模式是**落盘**的：localStorage 里写着 chat ⇒ 整个应用重载后面板开局就是「一轮」（不是硬编码的默认档）',
    !!reloaded && reloaded.exists === true && reloaded.mode === 'chat' && reloaded.agentClass === false
      && reloaded.segs.join(',') === 'chat:on,agent:off',
    { snap: reloaded || null });

  const errs = await ev(`window.__errs || []`);
  check('★8 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`==== ${pass}/${results.length} PASS ====`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : String(e)));
  process.exit(2);
});
