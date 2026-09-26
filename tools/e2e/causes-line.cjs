/* 不变量：**因果线在缩放时既不许跳位置，也不许每帧整块重建。**
 *
 * 用户 2026-09-26：「**缩放时标尺有轻微卡顿，而且渲染出的因果线会跳位置**」——两条各有一条判据：
 *   ★1 **端点连续**：连续细密缩放下，箭头尖端的位移不许超过它所连节点自身的位移（容差 2px）。
 *      A/B 陷阱（修复前实测）：两圆点靠近到「贴边量互相越过」时，`drawCauses()` 的退化分支
 *      `if ((x2 - x1) * dir <= 0)` 把端点**硬切**到水平极点 —— Δx=10.6px 时尖端落在圆心
 *      （dy 0 / dx -2）、Δx=11.9px 时一帧跳到圆周（dy 3.71 / dx -5.93）⇒ 尖端一帧跳
 *      **4.68px，而节点只动了 1.09px**；完全重合时端点还会反向（箭头指向自己）。
 *      修法 = `k = min(1, gap / need)` 连续收缩（`need = (a.r + b.r) * cos(RIM_ANGLE)`）。
 *   ★2 / ★4 **DOM 复用**：`<path>` / `<marker>` 按序号常驻，连续缩放期间必须是**同一批对象**。
 *      A/B 陷阱：修复前每帧 `causesSvg.innerHTML = defs + 294 条 path`（294 个 marker 全新建）
 *      ⇒ keepP / keepM 都是 0。
 *   ★3 **每帧 DOM 查询量**：修复前**每条边各查一次** `track.querySelector('[data-id=…]')`
 *      （294 边 × 2 = 588 次，每次都扫 track 的 150 个子元素；加压夹具实测 ~800 次/帧、
 *      单次缩放 3 格 58,950 次 ≈ 631ms）⇒ 判据 = 每帧查询数 ≤ 边数 + 节点数 + 20。
 *      现在是每帧**一次**集体查询 `track.querySelectorAll('[data-id]')` + 每个圆点一次
 *      `el.querySelector('.cap')`（≈ 边数/2 + 1 次/帧，实测 ~155），留了 3 倍余量。
 *
 * ⚠️ 环境前提（★0 一起断言，沿用 `scale-motion.cjs` 那三条）：
 *   ① 窗口**必须可见**（`LINGKUANG_TEST_WINDOW_POS="1920,0"`）：hidden 时 rAF 不跑、采样停摆；
 *   ② 窗口**必须不聚焦**（`LINGKUANG_TEST_WINDOW_NOFOCUS=1`）：`noSmooth()` 为真 ⇒ 滚轮当帧落值，
 *      帧与帧之间才有确定的几何（聚焦时视图是 ~250ms 平滑逼近，"一帧的位移"没有可比性）；
 *   ③ 没开「减少动态效果」。
 *
 * 夹具：`node tools/e2e/reset-entity-vault.cjs` + `node tools/e2e/seed-causes.cjs`
 *   （轻夹具 4 节点 / 4 条边；`LK_SEED_N=150` 是加压夹具 ≈ 150 节点 / 294 条边，
 *    ★3 的每帧查询量只有加压夹具才现形）。
 * 用法：LK_CDP_PORT=9346 node tools/e2e/causes-line.cjs
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

  await sleep(1500);
  /* ⚠️ 焦点仿真：实例带 `LINGKUANG_TEST_WINDOW_NOFOCUS=1` 起（不抢用户 OS 焦点），
     但那样 `noSmooth()` 为真 ⇒ 滚轮**当帧落值**，一个滚轮步只渲一帧、每帧跳 ~1.3px，
     正好会**跨过**「贴边量互相越过」那一帧（实测修复前就是这么漏判的）。
     让页面内 `document.hasFocus()` 为真 ⇒ `kickEase()` 走 rAF 缓动（~250ms），
     每帧只走 ~0.1px ⇒ 逐帧采样才看得见那个硬切（这才是用户眼里的平滑缩放）。 */
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`);
  for (let i = 0; i < 20; i++) { if (await ev(`document.querySelectorAll('#lk-pane-timeline .tl-track [data-id]').length > 0`)) break; await sleep(300); }
  await sleep(800);   /* 让启动 fit 落地 */

  /* ⚠️ 下面这段住在模板字符串里：代码与注释里都不许出现反引号或美元花括号。 */
  const report = await ev(`(async () => {
    const pane = document.querySelector('#lk-pane-timeline');
    const svg = pane && pane.querySelector('.tl-causes');
    const track = pane && pane.querySelector('.tl-track');
    const scale = pane && pane.querySelector('.tl-scale');
    if (!svg || !track || !scale) return { fatal: 'no pane/svg/track' };
    const wrap = pane.querySelector('.tl-wrap');
    /* 起始状态**自带干净 fit**（连跑两次时上一轮会把视图留在缩放态 ⇒ 采样点全是细档） */
    const sel0 = document.getElementById('lk-line-sel');
    if (sel0) { sel0.value = ''; sel0.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((r) => setTimeout(r, 900)); }
    const pathsOf = () => Array.from(svg.querySelectorAll(':scope > path'));
    const markersOf = () => Array.from(svg.querySelectorAll('defs marker'));
    const numsOf = (d) => (d || '').split(/[ ,]+/).filter((s) => s !== '');
    const tipsOf = (p) => { const t = numsOf(p.getAttribute('d')); return { x1: Number(t[1]), y1: Number(t[2]), x2: Number(t[t.length - 2]), y2: Number(t[t.length - 1]) }; };
    const sample = () => {
      const sr = svg.getBoundingClientRect();
      const caps = [];
      for (const el of track.querySelectorAll('[data-id]')) {
        const dot = el.querySelector('.cap') || el;
        const r = dot.getBoundingClientRect();
        caps.push({ id: el.dataset.id, x: r.left + r.width / 2 - sr.left, y: r.top + r.height / 2 - sr.top, r: r.width / 2 });
      }
      return { caps: caps, tips: pathsOf().map(tipsOf) };
    };
    const near = (caps, t) => {
      let best = null, bd = 1e9;
      for (const c of caps) { const d = Math.hypot(c.x - t.x, c.y - t.y); if (d < bd) { bd = d; best = c; } }
      return best;
    };
    /* 近邻 + 次近邻：**判歧义用**。密集画布（150 节点 / fit 档圆心只隔 8.7px、圆点直径 14px）
       上，一根因果线的尖端贴在自己目标圆点边缘时，会正好落进**邻居**的圆点里 ⇒ 最近圆点认错人，
       于是"尖端在圆内、弧还很长"是测量歧义而不是产品缺陷（实测加压夹具这样误报 87725 帧）。
       只在"最近圆点比次近邻至少近 6px"（指向明确）时才做退化判据。 */
    const near2 = (caps, t) => {
      let b1 = null, d1 = 1e9, d2 = 1e9;
      for (const c of caps) { const d = Math.hypot(c.x - t.x, c.y - t.y); if (d < d1) { d2 = d1; d1 = d; b1 = c; } else if (d < d2) { d2 = d; } }
      return { near: b1, d1: d1, d2: d2 };
    };
    const settle = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const wheel = async (dy, alt) => {
      const r = wrap.getBoundingClientRect();
      wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, altKey: !!alt, clientX: r.left + Math.round(r.width / 2), clientY: r.top + 40, bubbles: true, cancelable: true }));
      await settle();
      return sample();
    };

    const pathN = pathsOf().length, nodeN = track.querySelectorAll('[data-id]').length, markerN = markersOf().length;
    const pBefore = pathsOf(), mBefore = markersOf();

    /* ── 查询计数器（★3）：只统计缩放这一段 ── */
    const cnt = { q: 0, frames: 0 };
    const oEq = Element.prototype.querySelector, oEqa = Element.prototype.querySelectorAll;
    const oDq = Document.prototype.querySelector, oDqa = Document.prototype.querySelectorAll;
    Element.prototype.querySelector = function (s) { cnt.q++; return oEq.call(this, s); };
    Element.prototype.querySelectorAll = function (s) { cnt.q++; return oEqa.call(this, s); };
    Document.prototype.querySelector = function (s) { cnt.q++; return oDq.call(this, s); };
    Document.prototype.querySelectorAll = function (s) { cnt.q++; return oDqa.call(this, s); };
    const tick = () => { cnt.frames++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);

    /* ── 连续缩放 + **逐帧**采样（★1）────────────────────────────────────────────
       那个硬切只发生在**一帧**里（尖端 5.4px、而节点只动 1.09px），一个滚轮步只取一个样本会
       正正跨过它 —— 实测因此假绿两次。所以：开一个 rAF 采样器一路记（caps + tips），
       同时按间隔派滚轮（先放大 45 步、再缩小 45 步，两个方向都扫，见下），记完再逐帧比对。
       ⚠️ 采样器自己也要读 DOM：一律走**补丁之前**存下来的那个原生 querySelectorAll，
       不把自己算进 ★3 的查询计数。 */
    const frames = [];
    let sampling = true;
    const pump = () => {
      if (!sampling) return;
      const sr = svg.getBoundingClientRect();
      const caps = [];
      oEqa.call(track, '[data-id]').forEach((el) => {
        const dot = oEq.call(el, '.cap') || el;
        const r = dot.getBoundingClientRect();
        caps.push({ id: el.dataset.id, x: r.left + r.width / 2 - sr.left, y: r.top + r.height / 2 - sr.top, r: r.width / 2 });
      });
      frames.push({ caps: caps, tips: pathsOf().map(tipsOf) });
      requestAnimationFrame(pump);
    };
    requestAnimationFrame(pump);
    /* ⚠️ **两个方向都要扫，而且不能对称**：轻夹具（4 节点 / 100 年跨度）fit 档间距 ≈ 14.8px/年
       > 阈值 11.87px ⇒ 阈值在**缩小**方向；加压夹具（2535 年跨度）fit 档 ≈ 0.58px/年 < 阈值
       ⇒ 阈值在**放大**方向。先缩 40 步、再放 80 步（放大那半程会越过起点继续往里）⇒ 两种夹具
       都能踩到那个硬切。⚠️ 对称的 ±45 会**正好回到起点**、一次都不跨（实测因此假绿一轮）。 */
    let steps = 0;
    for (let k = 0; k < 120; k++) {
      const r = wrap.getBoundingClientRect();
      wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: k < 40 ? 18 : -18, altKey: false, clientX: r.left + Math.round(r.width / 2), clientY: r.top + 40, bubbles: true, cancelable: true }));
      steps++;
      await new Promise((res) => setTimeout(res, 70));
    }
    sampling = false;
    /* 逐帧比对。两条判据：
       ① **尖端位移连续**：尖端位移 − 它所连圆点的位移 > 2px 就是"跳"。
          ⚠️ 光有这条会**假绿**（实测三轮）：配对靠"离尖端最近的圆点"，而两圆点挨到重叠时
          "最近"可能换人 ⇒ 恰好把要抓的那一帧跳过。
       ② **退化不许再画长弧**（真正的鉴别判据，不依赖有没有恰好采样到那一帧）：
          尖端落进目标圆点**内部**时，弧线必须已经缩成一点（尖端与起点重合）。
          修复前那个退化分支（(x2 - x1) * dir <= 0 那一支）恰恰相反 —— 尖端被搬到离圆心 2px 处
          （深深钻进圆点里），却还画着一条 (gap - 4) 长的弧（实测 Δx=10.6px 时 dy 0 / dx -2，
          而弧长还有 6.6px）⇒ 一越过阈值就"啪"地弹到圆周上，这就是用户看到的跳。
          修复后 k = min(1, gap/need)：gap < need ⇒ 弧长恒为 0（尖端与起点重合），不会再有
          "点在里面、线在外面"的帧。 */
    let worstJump = 0, worstAt = null, worstFrame = 0, lenMismatch = 0, samples = 0;
    let insideLong = 0, insideLongAt = null, insideFrames = 0, arcFrames = 0, collapsedFrames = 0, ambiguous = 0, evaluated = 0;
    for (let f = 1; f < frames.length; f++) {
      const prev = frames[f - 1], now = frames[f];
      if (now.tips.length !== prev.tips.length) { lenMismatch++; continue; }
      for (let i = 0; i < now.tips.length; i++) {
        const capP = near(prev.caps, { x: prev.tips[i].x2, y: prev.tips[i].y2 });
        const capN = near(now.caps, { x: now.tips[i].x2, y: now.tips[i].y2 });
        if (capP && capN && capP.id === capN.id) {
          samples++;
          const dTip = Math.hypot(now.tips[i].x2 - prev.tips[i].x2, now.tips[i].y2 - prev.tips[i].y2);
          const dPrev = Math.hypot(capN.x - capP.x, capN.y - capP.y);
          const jump = dTip - dPrev;
          if (jump > worstJump) { worstJump = jump; worstFrame = f; worstAt = { i: i, id: capN.id, dTip: Math.round(dTip * 100) / 100, dCap: Math.round(dPrev * 100) / 100 }; }
        }
        /* ② 结构性判据（逐帧、逐边）。
           ⚠️ 弧长要在**配对守卫之前**数：退化区里两尖端重合到两圆心之间，"离尖端最近的圆点"
           对起点和终点会指到**同一个**圆点 ⇒ 下面那条 src.id === dst.id 守卫会把它们全跳过
           （实测修复后 insideFrames 因此恒 0）。所以"进过退化区"用 collapsedFrames 数。 */
        const arc = Math.hypot(now.tips[i].x2 - now.tips[i].x1, now.tips[i].y2 - now.tips[i].y1);
        if (arc > 0.5) arcFrames++; else collapsedFrames++;
        const p2 = near2(now.caps, { x: now.tips[i].x2, y: now.tips[i].y2 });
        if (!p2.near || !p2.near.r) continue;
        if (p2.d1 + 6 > p2.d2) { ambiguous++; continue; }   /* 指向不明确 ⇒ 不做退化判据 */
        evaluated++;
        const dst = p2.near;
        const off = Math.hypot(now.tips[i].x2 - dst.x, now.tips[i].y2 - dst.y);
        if (off < dst.r - 0.5) {
          insideFrames++;
          if (arc > 0.5) {
            insideLong++;
            if (!insideLongAt) insideLongAt = { f: f, i: i, dst: dst.id, off: Math.round(off * 100) / 100, r: Math.round(dst.r * 100) / 100, arc: Math.round(arc * 100) / 100 };
          }
        }
      }
    }
    const frameN = frames.length;
    const qPerFrame = cnt.frames ? Math.round(cnt.q / cnt.frames) : -1;

    /* ── 身份（★2 / ★4）：缩放跑完之后还是不是原来那批对象 ── */
    const pAfter = pathsOf(), mAfter = markersOf();
    let keepP = 0; for (let i = 0; i < pAfter.length; i++) if (pAfter[i] === pBefore[i]) keepP++;
    let keepM = 0; for (let i = 0; i < mAfter.length; i++) if (mAfter[i] === mBefore[i]) keepM++;

    Element.prototype.querySelector = oEq; Element.prototype.querySelectorAll = oEqa;
    Document.prototype.querySelector = oDq; Document.prototype.querySelectorAll = oDqa;

    return {
      pathN: pathN, nodeN: nodeN, markerN: markerN,
      pathNAfter: pAfter.length, markerNAfter: mAfter.length,
      keepP: keepP, keepM: keepM,
      steps: steps, lenMismatch: lenMismatch, samples: samples, frameN: frameN,
      insideLong: insideLong, insideLongAt: insideLongAt, insideFrames: insideFrames, arcFrames: arcFrames, collapsedFrames: collapsedFrames, ambiguous: ambiguous, evaluated: evaluated,
      worstJump: Math.round(worstJump * 100) / 100, worstFrame: worstFrame, worstAt: worstAt,
      q: cnt.q, frames: cnt.frames, qPerFrame: qPerFrame,
      visible: document.visibilityState === 'visible', focused: document.hasFocus(),
      motionReduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  })()`);

  if (!report || report.fatal) {
    check('★0 前置：沙盘已挂载、因果线（path/marker）都已画出、采样环境合规', false, report);
    console.log('\n==== 0/1 PASS ====');
    w.close(); process.exit(1);
  }

  /* ★0 前置：得有东西可测（轻夹具 4 节点/4 边；加压夹具 150/294） */
  check('★0 前置：有节点 + 有因果线 arc（path 数 == marker 数 == 边数 ≥ 3），窗口可见、焦点已仿真、未开减少动效',
    report.pathN >= 3 && report.pathN === report.markerN && report.nodeN >= 4
      && report.visible === true && report.focused === true && report.motionReduced === false,
    { pathN: report.pathN, markerN: report.markerN, nodeN: report.nodeN, visible: report.visible, focused: report.focused, motionReduced: report.motionReduced });

  /* ★1 端点连续（用户报的「因果线会跳位置」）：
     A/B 修复前 worstJump ≈ 4.68px（dTip 4.68 / dCap 1.09）⇒ FAIL；修复后应 ≤ 2px。
     ⚠️ `samples` 是防**空跑假绿**的：只画得出 1 条弧线时"最近圆点"每帧都可能换人 ⇒ 一个可比样本
     都没有，worstJump 恒 0（第一版就栽在这儿 —— 顺带查出一个真 bug：替换 `idx++` 时把它删了）。 */
  check('★1 连续缩放下箭头尖端连续：尖端位移 − 所连节点位移 ≤ 2px（不许出现"圆点没动、尖端跳走"）',
    report.worstJump <= 2 && report.steps === 120 && report.lenMismatch === 0 && report.samples >= 30,
    { worstJump: report.worstJump, worstFrame: report.worstFrame, worstAt: report.worstAt, samples: report.samples, frameN: report.frameN, steps: report.steps, lenMismatch: report.lenMismatch });

  /* ★1b 退化判据（★1 的"有牙"版）：尖端钻进圆点内部时，弧线必须已经缩成一点。
     A/B 修复前：`insideLong` 非 0（实测轻夹具第一帧就是「离圆心 2px、弧长 7.19px」）⇒ FAIL；
     修复后：gap < need ⇒ 弧长恒 0 ⇒ insideLong === 0，而那 2000 多帧记在 collapsedFrames 里。
     📌 **有牙的前提是稀疏画布**：判据靠"离尖端最近的圆点"，而加压夹具（150 节点 / fit 档圆心只隔
       8.7px、圆点直径 14px）上最近圆点天然歧义（`ambiguous` 178752 帧 / `evaluated` 0）——
       所以加压夹具跑本套件只为 ★3（每帧查询量），退化判据以轻夹具为准。 */
  check('★1b 退化不许再画长弧：尖端落进目标圆点内部时弧线必须已缩成一点（insideLong === 0）',
    report.insideLong === 0 && report.collapsedFrames > 0 && report.arcFrames > 0 && (report.evaluated + report.ambiguous) > 0,
    { insideLong: report.insideLong, insideLongAt: report.insideLongAt, insideFrames: report.insideFrames, arcFrames: report.arcFrames, collapsedFrames: report.collapsedFrames, evaluated: report.evaluated, ambiguous: report.ambiguous });

  /* ★2 <path> 复用：A/B 修复前每帧 innerHTML 重建 ⇒ keepP = 0 */
  check('★2 连续缩放后 <path> 仍是同一批元素（keepP == path 数；旧 innerHTML 实现 = 0）',
    report.pathN >= 3 && report.keepP === report.pathN && report.pathNAfter === report.pathN,
    { pathN: report.pathN, keepP: report.keepP, pathNAfter: report.pathNAfter });

  /* ★3 每帧 DOM 查询量：A/B 修复前 ≈ 800 次/帧（每条边 2 次 querySelector）⇒ FAIL */
  check('★3 每帧 DOM 查询次数 ≤ 边数 + 节点数 + 20（不再"每条边各查一次"）',
    report.qPerFrame >= 0 && report.qPerFrame <= report.pathN + report.nodeN + 20,
    { q: report.q, frames: report.frames, qPerFrame: report.qPerFrame, bound: report.pathN + report.nodeN + 20 });

  /* ★4 <marker> 复用 + 不泄漏（池子只许原地复用，数量不许随帧增长） */
  check('★4 连续缩放后 <marker> 仍是同一批元素、数量不增长（keepM == marker 数）',
    report.markerN >= 3 && report.keepM === report.markerN && report.markerNAfter === report.markerN,
    { markerN: report.markerN, keepM: report.keepM, markerNAfter: report.markerNAfter });

  const errs = await ev(`window.__errs`);
  check('★5 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n==== ${pass}/${results.length} PASS ====`);
  w.close();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.log('FAIL 异常：' + (e && e.message)); process.exit(1); });
