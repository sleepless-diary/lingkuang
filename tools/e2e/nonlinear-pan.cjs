/* 不变量：**非线性模式下画布也能平移/缩放**（节点不再钉死在屏幕上）。
 *
 * 用户 2026-09-19：「非线性下节点固定在屏幕上了」。
 * 病根：`src/ui/timeline.ts` 的 `renderNonlinear()` 里 x = `50 + i * pitch` —— pitch 只由窗口宽度
 * 算、x 里没有 `view.panX`，那一支也完全不响应滚轮 ⇒ 节点真的钉在屏幕上；节点比屏宽时
 * 尾巴既看不到也够不着。修法：非线性模式有**自己那套**视图游标 `nlPan / nlZoom`
 * （不共用 `view.panX/spacing`：那一支的 x 是序列序、与时间无关，共用会让两种模式互相踩），
 * 滚轮平移 / Alt+滚轮缩放 / 空格拖动都接上它，双击＝回到"刚好铺满"。
 *
 * 夹具用 `seed-storyline-focus.cjs`（6 个节点，年份跨度大 —— 正好也顺带看着"节点数不变"）。
 * ⚠️ 本套件与「默认全览」那条不冲突：非线性渲染不看剧情线聚焦（它按序列排全部节点）。
 *
 * 用法：干净实例（seed-storyline-focus，端口 9355）
 *   LK_CDP_PORT=9355 node tools/e2e/nonlinear-pan.cjs
 */
const PORT = process.env.LK_CDP_PORT || '9355';
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

  const view = () => ev(`(() => {
    const xs = [...document.querySelectorAll('#lk-pane-timeline .tl__n[data-id]')]
      .map((el) => Math.round(parseFloat(el.style.left) || 0));
    return {
      xs,
      n: xs.length,
      gaps: xs.slice(1).map((x, i) => x - xs[i]),
      nonlinear: !!document.getElementById('lk-nonlinear')?.classList.contains('is-active'),
      majors: document.querySelectorAll('#lk-pane-timeline .tl__axis-tick--major').length,
    };
  })()`);
  /** 滚轮：deltaY<0 = 向右推（见 timeline.ts 里两个分支的方向约定）；给 wrap 上派发 */
  const wheel = (deltaY, alt = false) => ev(`(() => {
    const el = document.querySelector('#lk-pane-timeline .tl-wrap') || document.querySelector('#lk-pane-timeline');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: ${deltaY}, altKey: ${alt}, clientX: r.left + 300, bubbles: true, cancelable: true }));
    return true;
  })()`);
  const clickNonlinear = () => ev(`document.getElementById('lk-nonlinear')?.click(); true`);

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`);
  await sleep(700);

  /* 前置：显式切回「— 全览 —」。本套件量的「6 个节点」＝全览下的全部节点，而聚态下
     非线性只排线内节点（`renderNonlinear` 现在会按聚焦过滤）——上一份套件
     （storyline-focus）的收尾状态正是"聚焦中"，不重置的话这里会只看到 4 个（套件顺序耦合）。 */
  await ev(`(() => {
    const s = document.getElementById('lk-line-sel');
    if (s && s.value !== '') { s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); }
    return s ? s.value : null;
  })()`);
  await sleep(700);

  const lin = await view();
  check('★0 前置：线性视图下 6 个节点都在、有标尺刻度',
    lin.n === 6 && lin.majors >= 2 && lin.nonlinear === false, { n: lin.n, majors: lin.majors });

  await clickNonlinear();
  await sleep(500);
  const nl = await view();
  check('★1 打开非线性：节点按**序列**等距排列（相邻间距一致 ±2px）',
    nl.nonlinear === true && nl.n === 6 && nl.gaps.length >= 3
    && Math.max(...nl.gaps) - Math.min(...nl.gaps) <= 2, { xs: nl.xs, gaps: nl.gaps });

  /* ── 核心回归：平移必须让**所有**节点一起走（旧代码这里一动不动） ── */
  await wheel(-180);
  await sleep(400);
  const panned = await view();
  const deltas = panned.xs.map((x, i) => x - nl.xs[i]);
  check('★2 平移（滚轮）→ 所有节点同步右移 180px（不再钉死在屏幕上）',
    deltas.length === 6 && deltas.every((d) => d === 180), { deltas });

  /* ── 缩放：Alt+滚轮，间距按 1.2× 变大（锚点在鼠标处，所以位置不是简单平移） ── */
  await wheel(-100, true);
  await sleep(400);
  const zoomed = await view();
  check('★3 Alt+滚轮缩放 → 节点间距变大（1.2×，±1px）',
    zoomed.gaps.length >= 3 && Math.abs(zoomed.gaps[1] - panned.gaps[1] * 1.2) <= 1,
    { before: panned.gaps[1], after: zoomed.gaps[1] });

  /* ── 双击 = 回到"刚好铺满"（游标归零） ── */
  await ev(`(() => {
    const el = document.querySelector('#lk-pane-timeline .tl-wrap') || document.querySelector('#lk-pane-timeline');
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  const reset = await view();
  check('★4 双击回到"刚好铺满"（与刚进非线性时逐项相同）',
    JSON.stringify(reset.xs) === JSON.stringify(nl.xs), { before: nl.xs, after: reset.xs });

  /* ── 关掉非线性：回到线性渲染（标尺回来） ── */
  await clickNonlinear();
  await sleep(600);
  const back = await view();
  check('★5 关掉非线性 → 回到线性视图（标尺刻度回来，6 个节点仍在）',
    back.nonlinear === false && back.n === 6 && back.majors >= 2, { n: back.n, majors: back.majors, nonlinear: back.nonlinear });

  const errs = await ev(`window.__errs`);
  check('★6 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n==== ${pass}/${results.length} PASS ====`);
  w.close();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
