/* 不变量：**助手的焦点不会凭空消失** —— 「这个 / 这条」永远有落点，或者最多回一句「是哪一条」。
 *
 * 用户 2026-09-26 原话：「ai：另外你说的「这个／这条」我这边看不到你打开了哪个条目——你此刻没有
 * 选中任何条目（界面停在 AI ...）要怎么避免 ai 出现这种回答」。
 *
 * 三层病根（★1~★3 钉第一层、★6 钉第二层、★4/★5 钉第三层）：
 *   ① 焦点只有设定库 / 沙盘**渲染时**才上报（`src/ui/codex.ts:730` 的 reportAgentFocus、
 *      `src/ui/shell.ts:53` 的沙盘点选），而 `src/ui/session.ts` 明明记着「上次在编的那一条」却没交给助手
 *      ⇒ 重启后落点若是 AI 工作台 / 助手，助手只能答「你没打开任何条目」。
 *      修：`src/ui/agent-context.ts` 新增 seedAgentFocus()，`src/ui/session.ts` 的 restoreSession() 里种。
 *   ② `src/ui/agent-context.ts` 的 focusBlock() 在 `f.world !== ws.name` 时直接 return ''
 *      ⇒ 焦点在**另一个世界**（他切了世界没换条目）也被当成「没打开任何条目」。修：照常渲染 + 说明在哪个世界。
 *   ③ 提示词**教它念局限**：NO_FOCUS「（没有：他没打开任何条目…直接问他指的是哪一条）」＋
 *      SYS_HEAD 第 5 条「若那一栏写着「没有」，就直接问他现在开的是哪一条」⇒ 模型逐字照做。
 *      修：改成「别解释你看不到什么 —— 挑最可能的那一条一句话确认，挑不出来就一句话问是哪一条」。
 *
 * 用法（`%TEMP%\lk-evault2` 那套 codex 夹具）：
 *   node tools/e2e/reset-entity-vault.cjs; node tools/e2e/seed-node.cjs
 *   → 起应用 → LK_CDP_PORT=9346 node tools/e2e/agent-focus.cjs
 *
 * ⚠️ 本套件要**新建一个世界**（「焦点探针世界」）来验②，断言完就删掉（右键 → 删除）：
 *    残留世界会让 localStorage 的 session 指着它，别的套件启动时落在空世界 ⇒ 假 FAIL。
 * ⚠️ 套件里多次 location.reload()：reload 后 WebSocket 不断，但执行上下文换了，
 *    轮询期间 Runtime.evaluate 可能返回 undefined —— 全部包在 try 里按「还没起来」处理。
 */
const PORT = process.env.LK_CDP_PORT || '9346';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }

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
  const ctrlK = "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true";
  const readSess = () => ev("(() => { try { return JSON.parse(localStorage.getItem('lingkuang-session') || 'null'); } catch (e) { return null; } })()");
  const writeSess = (o) => ev('localStorage.setItem("lingkuang-session", ' + JSON.stringify(JSON.stringify(o)) + '); true');
  /** reload 之后等壳回来（工具栏出现即算启动完；期间 evaluate 可能拿不到值） */
  const waitBoot = async (ms = 20000) => {
    const t0 = Date.now();
    for (;;) {
      let ok = false;
      try { ok = await ev("!!document.getElementById('lk-toolbar')"); } catch {}
      if (ok) { await sleep(900); return true; }
      if (Date.now() - t0 > ms) return false;
      await sleep(250);
    }
  };
  const reload = async () => { await ev('location.reload(); true'); await sleep(300); return waitBoot(); };
  /** 面板读数：chip（三态）+ 上下文预览全文 + 设定库是否挂载 */
  const panelSnap = () => ev(`(() => {
    const chip = document.getElementById('lk-agent-focus');
    const ctx = document.getElementById('lk-agent-ctx');
    return {
      panel: !!document.getElementById('lk-agent-panel'),
      chip: chip ? chip.textContent : null,
      ctx: ctx ? ctx.textContent : null,
      cx: !!document.getElementById('cx-root'),
    };
  })()`);
  const closePanel = async () => { await ev("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true"); await sleep(600); };
  /** 系统提示词（假引擎把每次喂进去的 messages 存进 window.__lkSeen；第 0 条是 system） */
  const sysOf = () => ev("(() => { const c = window.__lkSeen || []; const m = c[c.length - 1]; return m && m[0] ? m[0].content : ''; })()");
  /** 清掉上次跑残留的探针世界（addWorld 会去重成「名字 2」之类的，先清才认得出） */
  const clearProbeWorlds = () => ev("(() => { const n = [...document.querySelectorAll('.lk-world-tab[data-world]')].filter((b) => (b.dataset.world || '').indexOf('焦点探针世界') === 0).length; return n; })()");

  await sleep(1500);
  await ev("window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true");
  const leftover = await clearProbeWorlds();

  /* ── 准备：让设定库记下「上次在编的那一条」（session.target），这是「重启后助手该知道什么」的原料 ── */
  await ev("document.querySelector('[data-tool=\"codex\"]').click(); true");
  await sleep(1400);
  await ev("document.querySelector('#cx-list [data-cx-id=\"e-e2e-1\"]')?.click(); true");
  await sleep(900);
  const sess = await readSess();
  check('★0 前置：设定库里那条种子实体已被会话记住（session.target 指向它）',
    !!sess && !!sess.target && sess.target.kind === 'entity' && sess.target.id === 'e-e2e-1' && !!sess.world,
    { target: sess && sess.target, world: sess && sess.world, leftoverProbeWorlds: leftover });

  /* ── ① 重启后落点是 AI 工作台（设定库没挂载）—— 这正是用户报的那一幕 ── */
  await writeSess(Object.assign({}, sess, { tool: 'ai' }));
  const booted = await reload();
  const boot = await ev("({ toolbar: !!document.getElementById('lk-toolbar'), cx: !!document.getElementById('cx-root') })");
  check('★0b 重启（reload）后落在 AI 工作台：设定库**没有**挂载（没有任何东西会主动上报焦点）',
    booted === true && boot.cx === false, boot);

  await ev(ctrlK);
  await sleep(900);
  const a = await panelSnap();
  const chipTitle = (a.chip || '').replace(/^最近在看：/, '').replace(/^正在编(事件)?：/, '');
  check('★1 面板开出来了，且设定库确实没挂载（焦点无人上报）',
    a.panel === true && a.cx === false, { panel: a.panel, cx: a.cx });
  check('★2 chip 是「最近在看：<上次那条>」而不是「没打开条目」（A/B：旧构建读作「没打开条目」）',
    typeof a.chip === 'string' && a.chip.indexOf('最近在看') === 0 && chipTitle.length > 0 && a.chip.indexOf('没打开条目') < 0,
    { chip: a.chip });
  check('★3 上下文里**有那一条**（名字 + 文件路径），且没有「没打开任何条目」这句自述',
    !!a.ctx && a.ctx.indexOf('设定「' + chipTitle + '」') >= 0 && a.ctx.indexOf('_设定/') >= 0 && a.ctx.indexOf('没打开任何条目') < 0,
    { title: chipTitle, hasBlock: !!a.ctx && a.ctx.indexOf('设定「' + chipTitle + '」') >= 0, hasNoFocusLine: !!a.ctx && a.ctx.indexOf('没打开任何条目') >= 0 });

  /* ── ③ 提示词：不许再教它「念局限」 ── */
  await ev("window.__lkSeen = []; window.__lkAgentMock = (m) => { window.__lkSeen.push(m); return '好的，我按这条来。'; }; true");
  await ev("(function () { const t = document.getElementById('lk-agent-input'); t.value = '这条帮我写细一点'; document.getElementById('lk-agent-send').click(); return true; })()");
  await sleep(1500);
  const sys = await sysOf();
  const hasNewRule = sys.indexOf('更不要解释你看不到什么') >= 0;
  const hasOldRule = sys.indexOf('就直接问他现在开的是哪一条') >= 0;
  check('★4 系统提示词已改口径：有「不要解释你看不到什么」、没有旧那句「就直接问他现在开的是哪一条」',
    hasNewRule && !hasOldRule, { newRule: hasNewRule, oldRule: hasOldRule, sysLen: sys.length });

  /* ── ③b 真的没有焦点时（他这次什么都没打开）：给候选 / 一句话问，不许念局限 ── */
  await closePanel();
  await writeSess(Object.assign({}, sess, { tool: 'ai', target: null }));
  await reload();
  await ev(ctrlK);
  await sleep(900);
  const b = await panelSnap();
  /* ⚠️ 文案必须逐字对（第一版断言写漏了「向他」二字 ⇒ 假 FAIL）：
     NO_FOCUS 现在是「（没有：这会儿没有正在编的条目。**不要向他解释你看不到什么** —— …一句话跟他确认…）」 */
  const bNew = !!b.ctx && b.ctx.indexOf('不要向他解释你看不到什么') >= 0;
  const bAsk = !!b.ctx && b.ctx.indexOf('一句话跟他确认') >= 0;
  check('★5 无焦点时上下文里的规矩也换了：有「不要向他解释你看不到什么」+「一句话跟他确认」、没有「他没打开任何条目」',
    bNew && bAsk && b.ctx.indexOf('他没打开任何条目') < 0,
    { chip: b.chip, newLine: bNew, askLine: bAsk, oldLine: !!b.ctx && b.ctx.indexOf('他没打开任何条目') >= 0 });
  check('★5b 无焦点时 chip 如实写「没打开条目」（不谎报「正在编」）',
    b.chip === '没打开条目', { chip: b.chip });

  /* ── ② 焦点在**另一个世界**里也不许丢（他切了世界、没换条目） ── */
  await closePanel();
  await writeSess(Object.assign({}, sess, { tool: 'ai' }));
  await reload();
  await ev(ctrlK);
  await sleep(900);
  const c0 = await panelSnap();
  const title2 = (c0.chip || '').replace(/^最近在看：/, '');
  /* 新建一个世界：`src/store/actions.ts` 的 addWorld() 会顺手 setActiveWorld(新世界)，
     而设定库没挂载 ⇒ 焦点仍停在原世界那一条（正是要验的场面） */
  await ev("document.getElementById('lk-world-new').click(); true");
  await sleep(600);
  const made = await ev(`(() => {
    const inp = [...document.querySelectorAll('input')].find((i) => i.placeholder === '世界名');
    const ok = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '创建');
    if (!inp || !ok) return { ok: false };
    inp.value = '焦点探针世界';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    ok.click();
    return { ok: true };
  })()`);
  await sleep(1200);
  await closePanel();
  await ev(ctrlK);
  await sleep(900);
  const c = await panelSnap();
  check('★6 焦点在另一个世界时不丢：上下文仍有那一条，并说明它在「另一个世界」',
    made.ok === true && !!c.ctx && c.ctx.indexOf(title2) >= 0 && c.ctx.indexOf('另一个世界') >= 0 && c.ctx.indexOf('没打开任何条目') < 0,
    { made: made.ok, chip: c.chip, kept: !!c.ctx && c.ctx.indexOf(title2) >= 0, worldNote: !!c.ctx && c.ctx.indexOf('另一个世界') >= 0 });

  /* ── 收尾：切回原世界 + 删掉探针世界（不给别的套件留污染） ── */
  await closePanel();
  const back = await ev("(function () { const t = document.querySelector('.lk-world-tab[data-world=\"测试世界观\"]'); if (!t) return false; t.click(); return true; })()");
  await sleep(900);
  await ev("(function () { const t = document.querySelector('.lk-world-tab[data-world=\"焦点探针世界\"]'); if (!t) return false; t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return true; })()");
  await sleep(700);
  await ev("(function () { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '删除'); if (!b) return false; b.click(); return true; })()");
  await sleep(1500);
  const cleaned = await ev("!document.querySelector('.lk-world-tab[data-world=\"焦点探针世界\"]')");
  check('★7 探针世界已清掉、当前世界切回原世界（session 不指着空世界）',
    cleaned === true && back === true, { cleaned: cleaned, back: back });

  const errs = await ev('window.__errs || []');
  check('★8 全程无未捕获异常', Array.isArray(errs) && errs.length === 0, { errs: errs });

  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} PASS`);
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 套件自身出错：' + (e && e.stack ? e.stack : e)); process.exit(2); });
