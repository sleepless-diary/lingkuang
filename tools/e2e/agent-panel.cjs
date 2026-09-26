/* 不变量：**灵框助手是右侧停靠的悬浮面板**（Ctrl+K 呼出），而且它真的知道你在编什么。
 *
 * 用户 2026-09-17 的原话：「我想让我们灵框的 ai 真的工作，类 agent，但是主要工作还是在灵框内，
 * 有一个自己的对话框，有记忆，能总结创作者的偏好等，还有一个灵框内全局快捷键，按下就能呼出 ai」。
 * 片 1 落地的是这里测的四件事：
 *   ① 悬浮对话框：`#lk-agent-panel` 挂在 body 上、`position: fixed`、**贴右停靠**（不是设置那种全屏遮罩
 *      —— 用户要「主要工作还是在灵框内」，聊天时得能一边看着设定改）；主区一动不动；
 *   ② 上下文注入：`src/ui/agent-context.ts` 的 `buildContext()` 把「世界 / 当前时间线 / 设定 / 正在编」
 *      整理成文本（ROADMAP §5 的原则：应用层查好再塞），面板上那份预览就是它；
 *   ③ 对话历史落盘：走主进程 `agent:load` / `agent:save`（`<userData>/agent/chat.json`，**裸数组**）
 *      —— 是创作者资产，要能备份/查看/手改，所以不放 localStorage；
 *   ④ Ctrl+K：应用内快捷键（不走 Electron `globalShortcut`，免抢系统按键）。
 *
 * ⭐ 最要紧的一条断言是 ★6：「换条目 → 助手的焦点跟着换」。光有 chip 不够 —— 「正在编」是
 *    **UI 状态、不一定动数据**（点左树另一行不会触发 store 通知），所以 `setAgentFocus()` 自己广播
 *    `lingkuang-agent-focus`。改这一层时先跑本套件：★6 挂了就是它。
 * ⭐ ★5 是**产品 bug 的第一现场**：`buildContext()` 里时间线那一块曾经整段消失 ——
 *    `createStore` 把 `activeTimeline` 初始化成空串、只有换世界/撤销才会落位，助手直取它。
 *    修在 `src/store/store.ts` 的 `pickTimeline()`（建店时就落位）。
 *
 * 用法（`%TEMP%\lk-evault2` 那套 codex 夹具）：
 *   node tools/e2e/reset-entity-vault.cjs; node tools/e2e/seed-node.cjs; node tools/e2e/seed-agent-chat.cjs
 *   → 起应用 → LK_CDP_PORT=NNNN node tools/e2e/agent-panel.cjs
 */
const fs = require('fs');
const path = require('path');
const PORT = process.env.LK_CDP_PORT || '9346';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }

/** agent/chat.json 的位置 = `main.js` 的 `AGENT_DIR()`（测试时跟着 LINGKUANG_TEST_DATA 走） */
function agentDir() {
  if (process.env.LK_AGENT_DIR) return process.env.LK_AGENT_DIR;
  if (process.env.LINGKUANG_TEST_DATA) return path.join(path.dirname(process.env.LINGKUANG_TEST_DATA), 'agent');
  return path.join(require('os').tmpdir(), 'lk-evault2', 'agent');
}

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
  const agentBtn = `[...document.querySelectorAll('#lk-toolbar .lk-tool-btn')].find((b) => b.dataset.tool === 'agent')`;
  /** 面板关闭是**演着走**的（先右滑 320ms 再 remove，见 `src/ui/agent.ts` 的 `closeAgentPanel()`）——
   *  断言「它没了」必须轮询。测试窗口 `LINGKUANG_TEST_WINDOW_NOFOCUS=1` ⇒ hidden ⇒ 定时器被节流到
   *  ~1s，固定 sleep(300) 会假挂（2026-09-18 实测 ★9/★10/★11 三条一起挂）。 */
  const waitGone = async (sel, ms = 3000) => {
    const t0 = Date.now();
    for (;;) {
      if (!(await ev(`!!document.getElementById(${JSON.stringify(sel)})`))) return true;
      if (Date.now() - t0 > ms) return false;
      await sleep(200);
    }
  };
  const ctrlK = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`;
  const escKey = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`;

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  /* 前置：打开工作台，并点中那条种子实体（助手该知道"创作者正在编银发少女"） */
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  await sleep(1200);
  await ev(`document.querySelector('#cx-list [data-cx-id="e-e2e-1"]')?.click(); true`);
  await sleep(600);

  const pre = await ev(`(() => {
    window.__cx = document.querySelector('#cx-root');
    window.__mvLen = document.getElementById('lk-module-view').innerHTML.length;
    const tools = [...document.querySelectorAll('#lk-toolbar .lk-tool-btn')].map((b) => b.dataset.tool);
    return {
      cx: !!window.__cx,
      btn: !!${agentBtn},
      tools: tools.join(','),
      aiIdx: tools.indexOf('agent'), setIdx: tools.indexOf('settings'),
      panel: !!document.getElementById('lk-agent-panel'),
      focusChip: document.querySelector('#lk-agent-focus')?.textContent ?? null,
      mvLen: window.__mvLen,
    };
  })()`);
  check('★0 前置：工作台开着、左栏有「助手」按钮（排在「设置」之前）、此刻没有面板',
    pre.cx === true && pre.btn === true && pre.aiIdx >= 0 && pre.aiIdx < pre.setIdx && pre.panel === false,
    { tools: pre.tools, panel: pre.panel });

  /* ── ① Ctrl+K 开出一层**贴右停靠**的悬浮面板，主区一动不动 ── */
  await ev(ctrlK);
  await sleep(300);
  const opened = await ev(`(() => {
    const p = document.getElementById('lk-agent-panel');
    if (!p) return { exists: false };
    const cs = getComputedStyle(p);
    /* ⭐ 入场是"从右往左滑"（用户 2026-09-18：从右侧平滑入场）：先读**入场前**的几何 ——
       .lk-agent 本体是 transform: translateX(100%)，加 .is-in 才回到 0。
       ⚠️ 测试窗口 hidden ⇒ CSS 过渡不推进（currentTime 恒 0）⇒ 光 sleep 永远量到 -380，
       必须 getAnimations().forEach(a => a.finish()) 手动推到终态再量。 */
    const r0 = p.getBoundingClientRect();
    const offscreen = Math.round(window.innerWidth - r0.right);
    const trans = cs.transitionProperty + ' ' + cs.transitionDuration;
    /* ⭐ 「入场前整块在视口外」不能靠量实时几何 —— 窗口可见时 320ms 里它就滑到位了（offscreen=0），
       窗口被遮住时又永远停在 100%（offscreen=-380）。所以去读 **CSS 里声明的**基础位移：
       .lk-agent 本体是 transform: translateX(100%)，加 .is-in 才回到 0。 */
    const baseX = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
      .filter((r) => r.selectorText === '.lk-agent').map((r) => r.style.transform)[0] ?? null;
    p.getAnimations().forEach((a) => a.finish());
    const r = p.getBoundingClientRect();
    return {
      exists: true, pos: cs.position, inBody: p.parentElement === document.body,
      right: Math.round(window.innerWidth - r.right), offscreen, trans, base: baseX,
      width: Math.round(r.width), height: Math.round(r.height),
      z: cs.zIndex,
      sameRoot: document.querySelector('#cx-root') === window.__cx,
      mvLen: document.getElementById('lk-module-view').innerHTML.length,
      mvShown: document.getElementById('lk-module-view').style.display !== 'none',
      active: ${agentBtn}.classList.contains('is-active'),
      head: p.querySelector('.lk-agent__title')?.textContent ?? null,
      input: !!p.querySelector('#lk-agent-input'), send: !!p.querySelector('#lk-agent-send'),
    };
  })()`);
  check('★1 Ctrl+K 呼出助手：悬浮（fixed、挂 body 上）、**贴右停靠**（右边距 0、宽 380、通高）、且是**从右侧滑入**（入场前整块在视口外）',
    opened.exists === true && opened.pos === 'fixed' && opened.inBody === true
      && opened.right === 0 && (opened.base === 'translateX(100%)' || opened.base === 'translate(100%)')
      && opened.trans.indexOf('transform') === 0
      && opened.width === 380 && opened.height > 400,
    opened);
  check('★2 主区**一动不动**：`#cx-root` 是同一个元素、主区 HTML 没被换、模块视图仍显示、按钮亮着',
    opened.sameRoot === true && opened.mvLen === pre.mvLen && opened.mvShown === true && opened.active === true,
    { sameRoot: opened.sameRoot, mvLen: opened.mvLen, 之前: pre.mvLen, active: opened.active });
  check('★3 面板头是「灵框助手」、输入框与发送键都在', opened.head === '灵框助手' && opened.input === true && opened.send === true);

  /* ── ② 上下文注入：「正在编」是那条种子实体（字段与正文都进去） ── */
  const ctx1 = await ev(`(() => {
    const chip = document.querySelector('#lk-agent-focus')?.textContent ?? '';
    const model = document.querySelector('#lk-agent-model')?.textContent ?? '';
    const t = document.querySelector('#lk-agent-ctx')?.textContent ?? '';
    return {
      chip, model, len: t.length,
      world: t.includes('【工作区】当前世界「测试世界观」'),
      timeline: t.includes('【当前时间线】') && t.includes('个事件）'),
      node: t.includes('312 王国的建立'),
      setting: t.includes('【设定】共 1 条') && t.includes('银发少女'),
      focusEnt: t.includes('【创作者此刻打开的那一条】设定「银发少女」'),
      /* ⭐ 2026-09-18：创作者问「主要是哪个文件」⇒ 上下文里得真有文件路径可报 */
      focusFile: t.includes('文件：测试世界观/_设定/角色/银发少女.md'),
      /* ⭐ 焦点块必须排在【设置】/【当前时间线】**前面**（小模型读到后面就不看了） */
      focusFirst: t.indexOf('【创作者此刻打开的那一条】') < t.indexOf('【设定】共'),
      fields: t.includes('发色=银白'),
      doc: t.includes('正文：实体自己的正文。'),
    };
  })()`);
  /* ⚠️ 2026-09-26：chip 从「本地 / API · 模型名」改成了**供应商名 · 模型名**
     （用户要求「做成可选供应商和自定义供应商的版本」⇒ 见 `src/ui/ai-providers.ts`）；
     这个夹具用的是干净 userdata，所以默认那一家就是「本地 Ollama」。 */
  check('★4 焦点小标签 + 模型标签（供应商 · 模型名）',
    ctx1.chip === '正在编：银发少女' && ctx1.model === '本地 Ollama · qwen2.5:7b', { chip: ctx1.chip, model: ctx1.model });
  check('★5 上下文打包到了世界 / 时间线 / 设定清单 / **正在编那一条**（字段 + 正文 + 文件路径，且排在设定清单前）',
    ctx1.world && ctx1.timeline && ctx1.node && ctx1.setting && ctx1.focusEnt && ctx1.focusFile && ctx1.focusFirst && ctx1.fields && ctx1.doc && ctx1.len > 80,
    { world: ctx1.world, timeline: ctx1.timeline, node: ctx1.node, setting: ctx1.setting, focusEnt: ctx1.focusEnt, focusFile: ctx1.focusFile, focusFirst: ctx1.focusFirst, fields: ctx1.fields, doc: ctx1.doc, len: ctx1.len });

  /* ── ③ ⭐ 换条目：「正在编」跟着换（UI 状态不动数据，靠 lingkuang-agent-focus 事件） ── */
  const nodeClk = await ev(`(() => {
    const row = document.querySelector('#cx-list [data-act="node"]');
    if (!row) return { clicked: false };
    row.click();
    return { clicked: true, title: row.textContent.trim() };
  })()`);
  await sleep(700);
  const ctx2 = await ev(`(() => {
    const chip = document.querySelector('#lk-agent-focus')?.textContent ?? '';
    const t = document.querySelector('#lk-agent-ctx')?.textContent ?? '';
    return { chip, focusNode: t.includes('【创作者此刻打开的那一条】事件「312 年 王国的建立」'), ent: t.includes('【创作者此刻打开的那一条】设定「银发少女」') };
  })()`);
  check('★6 ⭐ 换到时间线节点：助手的「正在编」与上下文**当场跟着换**（不需要任何数据改动）',
    nodeClk.clicked === true && ctx2.chip === '正在编事件：王国的建立' && ctx2.focusNode === true && ctx2.ent === false,
    { row: nodeClk.title, chip: ctx2.chip, focusNode: ctx2.focusNode, ent: ctx2.ent });

  /* ── ③b ⭐⭐ 2026-09-18 用户实测：「这个 ai 看不到我此时打开的文件」——
     切到别的工具（去看一眼沙盘）之后，焦点**不许被清空**，只降级成「最近在看」，
     那条的文件路径仍要留在上下文里；切回工作台再升回「正在编」。 ── */
  await ev(escKey);
  await sleep(200);
  await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`);
  await sleep(900);
  await ev(ctrlK);
  await sleep(400);
  const away = await ev(`(() => {
    const chip = document.querySelector('#lk-agent-focus')?.textContent ?? '';
    const t = document.querySelector('#lk-agent-ctx')?.textContent ?? '';
    return {
      chip,
      /* ⭐ 2026-09-18 用户实测：「这个 ai 说我一直停留在同一个文件」——
         降级之后标题**不许再自称「此刻打开的那一条」**，改称「最近打开过的那一条」；
         并且上下文里必须有一行说清他此刻人在哪个界面（★6b-view）。 */
      keep: t.includes('【创作者最近打开过的那一条】事件「312 年 王国的建立」'),
      file: t.includes('文件：测试世界观/主线/事件/王国的建立.md'),
      note: t.includes('他刚才看过'),
      view: t.includes('【创作者此刻在哪】界面：世界沙盘'),
      noFocus: t.includes('（没有：他没打开任何条目'),
    };
  })()`);
  check('★6b ⭐切到别的工具：焦点**只降级不清空**（chip 变「最近在看」、标题改「最近打开过的那一条」、那条与文件路径仍在、并标明他此刻在沙盘）',
    away.chip === '最近在看：王国的建立' && away.keep === true && away.file === true && away.note === true
      && away.view === true && away.noFocus === false,
    away);

  /* ── ③b-2 ⭐⭐ 2026-09-18 用户第二条：「时间轴面板也要让它能看到我在哪个文件」
     —— 沙盘上点开一个事件，助手那边得认，而且要标明这是**沙盘的时间线**（不是设定库工作台）。 ── */
  const tlClk = await ev(`(() => {
    const el = document.querySelector('#lk-pane-timeline .tl__n[data-id]');
    if (!el) return { clicked: false };
    /* ⭐ 沙盘选中**不是 click**：src/ui/timeline.ts:357 在 wrap 上听 pointerdown（只记 nodeDragId），
       真正置 selectedId + 调 onSelect 的是 src/ui/timeline.ts:440 **window 上的 pointerup**
       （nodeDragId && !nodeDragMoved 才算点击）—— 只派发 click 一辈子选不中。
       这里照真实鼠标补这两个事件；**不派 pointermove**，否则 nodeDragMoved 置真、被当成拖动。 */
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, base, { buttons: 1 })));
    window.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, base, { buttons: 0 })));
    return { clicked: true, id: el.dataset.id, title: el.textContent.trim() };
  })()`);
  await sleep(700);
  const sandboxFocus = await ev(`(() => {
    const chip = document.querySelector('#lk-agent-focus')?.textContent ?? '';
    const t = document.querySelector('#lk-agent-ctx')?.textContent ?? '';
    return {
      chip,
      focusNode: t.includes('【创作者此刻打开的那一条】事件「312 年 王国的建立」'),
      file: t.includes('文件：测试世界观/主线/事件/王国的建立.md'),
      place: t.includes('在哪：世界沙盘的时间线上'),
      note: t.includes('他刚才看过'),
      view: t.includes('【创作者此刻在哪】界面：世界沙盘'),
    };
  })()`);
  check('★6d ⭐沙盘上点开一个事件：助手也认（chip 升回「正在编事件」、上下文标「在哪：世界沙盘的时间线上」、界面行也说沙盘、降级标记消失）',
    tlClk.clicked === true && sandboxFocus.chip === '正在编事件：王国的建立' && sandboxFocus.focusNode === true
      && sandboxFocus.file === true && sandboxFocus.place === true && sandboxFocus.view === true && sandboxFocus.note === false,
    { id: tlClk.id, ...sandboxFocus });

  await ev(escKey);
  await sleep(200);
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  await sleep(1200);
  await ev(ctrlK);
  await sleep(400);
  const back = await ev(`(() => {
    const chip = document.querySelector('#lk-agent-focus')?.textContent ?? '';
    const t = document.querySelector('#lk-agent-ctx')?.textContent ?? '';
    return { chip, backLive: chip.indexOf('正在编') === 0, keep: t.includes('【创作者此刻打开的那一条】'), note: t.includes('他刚才看过'), place: t.includes('在哪：设定库工作台'), view: t.includes('【创作者此刻在哪】界面：设定库') };
  })()`);
  check('★6c 切回工作台 ⇒ 升回「正在编」（降级标记消失、位置说回「设定库工作台」、界面行说回设定库）',
    back.backLive === true && back.keep === true && back.note === false && back.place === true && back.view === true, back);
  await ev(escKey);
  await sleep(200);
  /* ⭐ ★12 的「主区没被重建」判据要拿**当前**的工作台根比 —— ★6b/★6c 刚切过工具，
     `#cx-root` 本来就是新元素了（换工具会重建工具宿主）。这里重新采一次基线。 */
  await ev(`(function () { window.__cx = document.querySelector('#cx-root'); return !!window.__cx; })()`);

  /* ── ④ 对话历史：从盘上进对话框（seed-agent-chat.cjs 播的两条） ── */
  /* ⭐ ★6b/★6c 会开关面板，这里先把面板重新呼出来再读（否则读到的是已被移除的容器 ⇒ 假 FAIL） */
  await ev(ctrlK);
  await sleep(500);
  const hist = await ev(`(() => {
    const box = document.getElementById('lk-agent-msgs');
    const msgs = [...(box?.querySelectorAll('.lk-agent__msg') ?? [])];
    return {
      n: msgs.length,
      user: msgs.filter((m) => m.classList.contains('is-user')).map((m) => m.textContent).join('|'),
      ai: msgs.filter((m) => m.classList.contains('is-ai')).map((m) => m.textContent).join('|'),
    };
  })()`);
  check('★7 打开面板就把**盘上**的历史读回对话框（seed 的两条，user/assistant 各一条）',
    hist.n === 2 && hist.user.includes('种子提问') && hist.ai.includes('种子回答'), hist);

  /* ── ⑤ 落盘 round-trip（IPC：写盘 → 读回 → 磁盘上真的是裸数组） ── */
  const rt = await ev(`(async () => {
    const api = window.lingkuangAPI;
    const saved = await api.agentSave({ chat: [{ role: 'user', content: 'E2E-A' }, { role: 'assistant', content: 'E2E-B' }] });
    const back = await api.agentLoad();
    return { saved, n: back?.chat?.length ?? -1, first: back?.chat?.[0]?.content ?? null, memory: Array.isArray(back?.memory) };
  })()`);
  const diskFile = path.join(agentDir(), 'chat.json');
  let disk = null;
  try { disk = JSON.parse(fs.readFileSync(diskFile, 'utf8')); } catch (e) { disk = null; }
  check('★8 对话历史落盘走主进程（agent:save → agent:load 读回同两条，磁盘上是**裸数组**）',
    rt.saved?.ok === true && rt.n === 2 && rt.first === 'E2E-A' && rt.memory === true
      && Array.isArray(disk) && disk.length === 2 && disk[1]?.content === 'E2E-B',
    { saved: rt.saved, n: rt.n, first: rt.first, diskAt: diskFile, disk: disk && disk.length });

  /* ── ⑥ 三种开关：Esc / Ctrl+K / 左栏按钮 ── */
  await ev(escKey);
  const escGone = await waitGone('lk-agent-panel');
  const byEsc = await ev(`({ panel: !!document.getElementById('lk-agent-panel'), active: ${agentBtn}.classList.contains('is-active') })`);
  check('★9 Esc 关闭面板（滑出后摘掉 DOM），左栏按钮高亮同步熄灭', escGone === true && byEsc.panel === false && byEsc.active === false, byEsc);

  await ev(ctrlK);
  await sleep(300);
  const again = await ev(`!!document.getElementById('lk-agent-panel')`);
  await ev(ctrlK);
  const kGone = await waitGone('lk-agent-panel');
  const toggled = await ev(`!!document.getElementById('lk-agent-panel')`);
  check('★10 Ctrl+K 是开关（再按一次关掉，不是"再开一层"）', again === true && kGone === true && toggled === false, { again, kGone, toggled });

  await ev(`${agentBtn}.click(); true`);
  await sleep(300);
  const byBtn = await ev(`!!document.getElementById('lk-agent-panel')`);
  await ev(`${agentBtn}.click(); true`);
  const btnGone = await waitGone('lk-agent-panel');
  check('★11 左栏「助手」按钮同样能开关（面板型工具，与设置同一套机制）',
    byBtn === true && btnGone === true && (await ev(`!!document.getElementById('lk-agent-panel')`)) === false, { byBtn, btnGone });

  /* ── ⑦ 同屏只有一个面板：`src/tools/registry.ts` 只有一格 `disposePanel`，开第二个会 dispose 掉第一个
     （面板型工具的既有设计 —— 设置本来就是全屏遮罩，不该跟别的挤在一起）。
     所以这里断言的是**真实不变量**：开设置 ⇒ 助手让位；关设置 ⇒ 主区仍在原地、助手还能再被呼出。 */
  await ev(ctrlK);
  await sleep(300);
  const agentFirst = await ev(`!!document.getElementById('lk-agent-panel')`);
  await ev(`document.querySelector('[data-tool="settings"]').click(); true`);
  /* ⭐ 助手让位是**演着走**的（右滑 320ms 才 remove DOM）⇒ 必须轮询等它真没了，
     否则这里会读到"助手还在"而假挂（同 ★9/★10/★11）。 */
  const agentGone = await waitGone('lk-agent-panel');
  await sleep(400);
  const swapped = await ev(`({
    agent: !!document.getElementById('lk-agent-panel'),
    settings: !!document.getElementById('lk-settings-panel'),
    sameRoot: document.querySelector('#cx-root') === window.__cx,
  })`);
  await ev(`document.getElementById('lk-set-close')?.click(); true`);
  await sleep(300);
  await ev(ctrlK);
  await sleep(300);
  const reOpen = await ev(`({
    agent: !!document.getElementById('lk-agent-panel'),
    settings: !!document.getElementById('lk-settings-panel'),
    sameRoot: document.querySelector('#cx-root') === window.__cx,
  })`);
  check('★12 面板只有一格：开设置 ⇒ 助手让位（滑出后 DOM 也摘掉）；关设置后主区没动、助手还能再呼出',
    agentFirst === true && agentGone === true && swapped.agent === false && swapped.settings === true && swapped.sameRoot === true
      && reOpen.agent === true && reOpen.settings === false && reOpen.sameRoot === true,
    { agentFirst, agentGone, swapped, reOpen });

  /* ── ⑧ 助手读得到「他最近做过的事」（操作流水：`src/ui/agent-activity.ts`）──
     用户 2026-09-18：「能不能让这个 ai 能读到我的过去操作行为」。
     它是**差分**不是埋点：全仓写入都走 `store.update`，但它只有 mutator、没有语义标签
     （工作台直改字段 / tiptap 失焦提交 / 回收站恢复全在里面），埋点必漏 ⇒ 只认「数据真的变了」。
     这里模拟的就是最普通的一条路径：在工作台里改一个字段。 */
  await ev(escKey);
  await sleep(300);
  /* 先删掉上一次跑留下的流水：★15 靠「文件里有 发色」当同步点，残留会让我们在写盘之前就通过 */
  try { fs.unlinkSync(path.join(agentDir(), 'activity.json')); } catch (e) { /* 没有就算了 */ }
  await ev(`document.querySelector('#cx-list [data-cx-id="e-e2e-1"]')?.click(); true`);
  await sleep(700);
  const setHair = await ev(`(() => {
    const el = [...document.querySelectorAll('#cx-fields > div')].find((r) => r.firstElementChild?.textContent === '发色')?.querySelector('input,textarea,select');
    if (!el) return null;
    el.value = '墨黑';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`);
  /* 差分防抖 BATCH_MS=500 + 流水落盘节流 SAVE_MS=1500 ⇒ 等够再开面板读上下文。
     ⚠️ 测试窗口 `LINGKUANG_TEST_WINDOW_NOFOCUS=1` ⇒ 页面 hidden ⇒ 定时器被节流，
     实际落盘时刻会晚于「500+1500ms」的纸面值（实测晚了几秒）⇒ **轮询而不是死等**，
     并把「文件到了」当同步点：push() 先于 scheduleSave()，文件里有这条 ⇒ 内存里必然也有。 */
  let actDisk = null;
  for (let i = 0; i < 14; i++) {
    await sleep(700);
    try { actDisk = JSON.parse(fs.readFileSync(path.join(agentDir(), 'activity.json'), 'utf8')); } catch (e) { actDisk = null; }
    if (Array.isArray(actDisk) && actDisk.some((a) => a && typeof a.text === 'string' && a.text.indexOf('发色') >= 0)) break;
  }
  await ev(ctrlK);
  await sleep(400);
  const act = await ev(`(() => {
    const t = document.querySelector('#lk-agent-ctx')?.textContent ?? '';
    return {
      hasBlock: t.includes('【他最近做过的事】'),
      hasLine: t.includes('改了设定「银发少女」的字段「发色」'),
      hasTail: t.includes('（这些是他自己动手改的；标着「灵框助手代劳」的才是你改的。）'),
      line: (t.split('\\n').find((l) => l.includes('发色')) ?? '').trim(),
    };
  })()`);
  check('★14 ⭐助手看得到创作者过去的操作（改一个字段 ⇒ 上下文里冒出【他最近做过的事】+ 那句人话）',
    setHair === '墨黑' && act.hasBlock === true && act.hasLine === true && act.hasTail === true, act);

  let chatDisk = null;
  try { chatDisk = JSON.parse(fs.readFileSync(path.join(agentDir(), 'chat.json'), 'utf8')); } catch (e) { chatDisk = null; }
  check('★15 流水自己落盘，且**只带 activity 的那次保存不会把对话历史抹掉**（`agent:save` 是「给了才写」）',
    Array.isArray(actDisk) && actDisk.some((a) => a && typeof a.text === 'string' && a.text.indexOf('发色') >= 0)
      && Array.isArray(chatDisk) && chatDisk.length === 2 && chatDisk[0]?.content === 'E2E-A',
    {
      actN: Array.isArray(actDisk) ? actDisk.length : actDisk,
      actLast: Array.isArray(actDisk) ? (actDisk[actDisk.length - 1]?.text ?? null) : null,
      chatN: Array.isArray(chatDisk) ? chatDisk.length : chatDisk,
      chatFirst: Array.isArray(chatDisk) ? (chatDisk[0]?.content ?? null) : null,
    });

  /* ── ⑨ 上下文分割（第 3.6 片）：把上面的对话切出上下文，系统提示词与长期记忆照常 ──
     用户 2026-09-18：「加一个分割上下文的功能，可分开之前的上下文但是保留系统提示词和记忆」。 ── */
  /* Ctrl+K 是开关：前面几步可能已把面板开着或关掉了 ⇒ 先确保它是开的（否则按钮找不到） */
  for (let i = 0; i < 6; i++) {
    if (await ev(`!!document.getElementById('lk-agent-panel')`)) break;
    await ev(ctrlK);
    await sleep(400);
  }
  const preSplit = await ev(`(() => {
    const btn = document.querySelector('#lk-agent-split');
    const t = document.querySelector('#lk-agent-ctx')?.textContent ?? '';
    return {
      hasBtn: !!btn, label: btn?.textContent ?? '',
      ctxWork: t.indexOf('【工作区】') >= 0,
      mem: !!document.querySelector('#lk-agent-mem-summary'),
      wraps: document.querySelectorAll('#lk-agent-msgs .lk-agent__cutwrap').length,
    };
  })()`);
  await ev(`document.getElementById('lk-agent-split')?.click(); true`);
  await sleep(300);
  const split = await ev(`(() => {
    const cut = document.querySelector('#lk-agent-msgs .lk-agent__cut');
    const wraps = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__cutwrap')];
    const t = document.querySelector('#lk-agent-ctx')?.textContent ?? '';
    return {
      label: document.querySelector('#lk-agent-split')?.textContent ?? '',
      cutText: cut?.textContent ?? '',
      cutX: !!document.querySelector('.lk-agent__cut .lk-agent__cut-x'),
      cutN: wraps.filter((w) => w.classList.contains('is-cut')).length,
      allN: wraps.length,
      ctxWork: t.indexOf('【工作区】') >= 0,
      note: document.querySelector('#lk-agent-note')?.textContent ?? '',
    };
  })()`);
  check('★16 「分割上下文」：插入分割线、线以上全部标成「不再发给模型」并写明条数，按钮变「取消分割」；系统提示词与记忆区照旧',
    preSplit.hasBtn === true && preSplit.label === '分割上下文' && preSplit.wraps > 0 && preSplit.ctxWork === true && preSplit.mem === true
      && split.label === '分割上下文' && split.cutX === true && split.cutText.indexOf('不再发给模型') > 0
      && split.cutN === split.allN && split.cutN === preSplit.wraps
      && split.cutText.indexOf('以上 ' + split.allN + ' 条') > 0 && split.ctxWork === true,
    { pre: preSplit, after: split });
  /* 落盘是异步的（persist 走 agent:save）⇒ 轮询 chat.json，别死等 */
  /* 分割按钮有 350ms 去抖（防重复接线双触发）⇒ 真人也要隔一下再点「取消分割」 */
  await sleep(500);
  const diskDiv = await (async () => {
    const rd = () => { try { const v = JSON.parse(fs.readFileSync(path.join(agentDir(), 'chat.json'), 'utf8')); return Array.isArray(v) ? v : null; } catch { return null; } };
    for (let i = 0; i < 14; i++) { const v = rd(); if (v && v.some((m) => m && m.div === true)) return v; await sleep(500); }
    return rd();
  })();
  /* 重新接上是在**分割线本身**上（鼠标移上去才显形的那个叉），不在面板头 */
  await ev(`document.querySelector('.lk-agent__cut .lk-agent__cut-x')?.click(); true`);
  await sleep(300);
  const unSplit = await ev(`(() => ({ cut: !!document.querySelector('#lk-agent-msgs .lk-agent__cut'), label: document.querySelector('#lk-agent-split')?.textContent ?? '', marked: document.querySelectorAll('#lk-agent-msgs .lk-agent__cutwrap.is-cut').length }))()`);
  check('★17 分割会落盘（chat.json 里多一条 div:true，重开面板仍在）＋点线上的叉能重新接上（线与压暗都消失、按钮不变）',
    Array.isArray(diskDiv) && diskDiv.filter((m) => m && m.div === true).length === 1
      && unSplit.cut === false && unSplit.label === '分割上下文' && unSplit.marked === 0,
    { divN: Array.isArray(diskDiv) ? diskDiv.filter((m) => m && m.div === true).length : null, unSplit });
  const errs = await ev(`window.__errs`);
  check('★13 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const n = results.filter(Boolean).length;
  console.log(`\n==== ${n}/${results.length} PASS ====`);
  process.exit(n === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack || e)); process.exit(2); });
