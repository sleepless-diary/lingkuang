/* 不变量：**标尺只做 DOM diff；「线」永不播动画，文字的透明度由「位置」算（纯函数，没有动画）。**
 *
 * 用户四次改口之后定下来的最终态（每一版的守卫都留着，别再翻回去）：
 *   2026-09-19：「年月日等刻度的**出入场用不透明度和缩放尺度**计算」→ 09-26 上午做了（opacity + scale 挂刻度元素）；
 *   09-26 下午：「**要不标尺动画去了吧，感觉有点，emm不符合我的预期**」⇒ 整套撤掉；
 *   09-26 再一轮：「**标尺上的文字能不能随缩放比例稍微做一点不透明度的出入场**」⇒ 只淡文字、按时间淡入淡出；
 *   09-26 用户看完报「**有了，但是文字会闪烁**」，并给出新规格：「**把整个缩放尺度当成一个 x 轴，在轴上时，
 *   文字的不透明度图像类似于一个正态分布的图像（100% 不透明度的占比要长一点），每个文字依照对应的 x
 *   计算当前的不透明度**」⇒ **动画与"什么时候播"这个判断一并消失**：不透明度 = 位置的纯函数
 *   （`src/ui/timeline.ts` 的 `labelWindow()` / `LABEL_PLATEAU`：中间 68% 平台恒 1，两头 `exp(-4t^2)` 尾巴）。
 *
 * 所以本套件盯这八件事：
 *   ★0 前置（有主刻度 / 窗口可见且不聚焦 / 没开「减少动态效果」）；
 *   ★1 平移后留在屏上的刻度**元素身份不变**（旧 `scaleEl.innerHTML = html + subHtml` ⇒ keep 0）；
 *   ★2 **全程零动画**（刻度元素与文字 span 都不许有 Animation）—— A/B 陷阱：上一版按时间淡入淡出，
 *      缩放期间 `maxLabelAnim >= 1` ⇒ FAIL；
 *   ★3 换档时"名字没变"的数字**复用同一元素**（key 曾含 `stepSec` ⇒ 每跨一次档位全批重建 ⇒ 数字闪）；
 *   ★4 文字的 opacity 是**位置的纯函数**：中间平台恒 1、越靠边越暗且单调 —— A/B 陷阱：上一版静止时
 *      屏上每个数字都是 1（没有"按位置变暗"这回事）⇒ FAIL；
 *   ★4b 连续缩放过程中**不透明度不许跳**（逐帧 `|dOp| / max(|dX|, 0.3) <= 0.08`，且必须有 >= 5 帧真在动）
 *      —— 这一条就是「不闪烁」本身：上一版在位置几乎没动的情况下把 op 从 0 拉到 1，比例远超上限；
 *   ★5 走掉的刻度**当帧就摘**（滚完当帧的子元素数 == 落定后、且落定后没有任何动画残留）；
 *   ★6 全程没有未捕获异常。
 *
 * ⚠️ 环境前提三条（都是实测踩出来的，★0 一起断言）：
 *   ① 窗口**必须可见**（`LINGKUANG_TEST_WINDOW_POS="1920,0"` 开副屏）：窗口 hidden 时 rAF 不跑，
 *      启动 fit 与切聚焦的 fit 都挂在 rAF 上 ⇒ 视图停在默认档、采样器也不跑。
 *   ② ★1/★5 要在**不聚焦**的实例上跑（`LINGKUANG_TEST_WINDOW_NOFOCUS=1`）：`noSmooth()` 为真 ⇒
 *      滚轮当帧落值，"当帧就摘"这条才量得准。
 *   ③ ★4b 反过来**必须在平滑路径上**量（连续运动才有"跳没跳"可言）⇒ 用 CDP 的
 *      `Emulation.setFocusEmulationEnabled {enabled:true}` 让页面内 `document.hasFocus()` 为真
 *      （**不抢用户 OS 焦点**，实测有效），这样 `kickEase()` 才走 rAF 缓动。
 *
 * 📌 一条**踩过的错判据**（别再写回去）：不能拿"同屏有没有重复的**标签文本**"当"两把尺子"的判据 ——
 *   月档的标签就是 `1月 / 2月 …`，跨年的两个刻度天然文字相同（实测 maxDup 7，全是月名）。
 *   真要按文字判，必须比 **(文字, left) 对**（叠在一起才是两把尺子）；这里只当诊断读数打印。
 *
 * 用法：起干净实例（reset-entity-vault + seed-node，端口 9346），
 *   LK_CDP_PORT=9346 node tools/e2e/scale-motion.cjs
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
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`);
  for (let i = 0; i < 20; i++) { if (await ev(`document.querySelectorAll('#lk-pane-timeline .tl-scale .tl__axis-tick--major').length > 0`)) break; await sleep(300); }
  await sleep(800);   /* 让启动 fit 落地 */

  /* ── 第一段（不聚焦 / 当帧落值）：★1 身份、★2 零动画、★4 位置形状、★5 当帧就摘 ───────────── */
  const report = await ev(`(async () => {
    const scale = document.querySelector('#lk-pane-timeline .tl-scale');
    if (!scale) return { fatal: 'no .tl-scale' };
    /* 起始状态**自带干净 fit**：连跑两次时上一轮会把视图留在"缩放到极限"处，再往外缩会被夹住
       ⇒ 一次换档都不发生 ⇒ 假 FAIL。切一次「— 全览 —」拿回干净 fit（处理器里带 rAF fitAll）。 */
    const sel0 = document.getElementById('lk-line-sel');
    if (sel0) { sel0.value = ''; sel0.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((r) => setTimeout(r, 900)); }
    const majors = () => [...scale.querySelectorAll('.tl__axis-tick--major')];
    const kids = () => [...scale.children];
    /* ⚠️ 这段住在模板字符串里：注释与代码里都不许出现反引号或美元花括号。 */
    const labelsIn = (el) => [...el.querySelectorAll('.tl__axis-label, .tl__axis-prev')];
    const opOf = (el) => { const s = el.querySelector('.tl__axis-label'); return s ? Number(getComputedStyle(s).opacity) : null; };
    const xOf = (el) => parseFloat(el.style.left) || 0;
    /* maxAnim = 刻度元素本身在播动画的个数；maxLabelAnim = 里面文字 span 在播动画的个数；
       maxLabelMove = 文字动画里出现过非 none 的 transform 的次数（防有人把 scale() 写回来）。
       新契约下**三个都必须恒为 0**（不透明度是位置算出来的，没有任何动画）。 */
    let maxAnim = 0, maxLabelAnim = 0, maxLabelMove = 0, frames = 0;
    /* 诊断读数：(文字, left) 相同的对 == "两把尺子叠在一起"（只比文字会误判：月档跨年天然重复）。 */
    let maxDupPair = 0, dupPairs = null;
    const sample = () => {
      frames++;
      let anim = 0, labAnim = 0, labMove = 0;
      for (const el of kids()) {
        if (el.getAnimations && el.getAnimations().length) anim++;
        for (const s of labelsIn(el)) {
          const as = s.getAnimations ? s.getAnimations() : [];
          if (as.length) labAnim++;
          for (const a of as) {
            const kf = a.effect && a.effect.getKeyframes ? a.effect.getKeyframes() : [];
            for (const k of kf) if (k.transform && k.transform !== 'none') labMove++;
          }
        }
      }
      if (anim > maxAnim) maxAnim = anim;
      if (labAnim > maxLabelAnim) maxLabelAnim = labAnim;
      if (labMove > maxLabelMove) maxLabelMove = labMove;
      const seen = new Set(), dup = [];
      for (const el of kids()) {
        const s = el.querySelector('.tl__axis-label');
        if (!s) continue;
        const k = s.textContent + '@' + el.style.left;
        if (seen.has(k)) dup.push(k); else seen.add(k);
      }
      if (dup.length > maxDupPair) { maxDupPair = dup.length; dupPairs = dup; }
    };
    let raf = true;
    const loop = () => { if (!raf) return; sample(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    const wheel = (dy, alt) => {
      const wrap = scale.parentElement;
      const r = wrap.getBoundingClientRect();
      wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, altKey: !!alt, clientX: r.left + Math.round(r.width / 2), clientY: r.top + 40, bubbles: true, cancelable: true }));
    };
    /* ① 平移 180px（普通滚轮）：读"元素身份不变"（旧 innerHTML 实现每帧整批重建 ⇒ keep = 0） */
    const before = majors();
    const beforeSet = new Set(before);
    wheel(-180, false);
    sample();
    await new Promise((r) => setTimeout(r, 700));
    const afterPan = majors();
    const keep = afterPan.filter((el) => beforeSet.has(el)).length;
    sample();
    /* ② 缩放扫过若干档位（交替方向，逐格）：每滚一格就采一帧，并量"当帧子元素数 vs 落定后"。
       ★5 判据 = 走掉的刻度**当帧就摘** ⇒ 两个数必须相等（旧版留一拍淡出 ⇒ 差 > 0）。 */
    let linger = 0, lingerAt = null, lingerSteps = 0;
    for (const d of [-100, 100, -100, 100]) {
      for (let k = 1; k <= 5; k++) {
        wheel(d, true);
        const nowN = kids().length;
        sample();
        await new Promise((r) => setTimeout(r, 450));
        const laterN = kids().length;
        const diff = Math.abs(nowN - laterN);
        if (diff > linger) { linger = diff; lingerAt = { dir: d, step: k, nowN: nowN, laterN: laterN }; }
        lingerSteps++;
      }
    }
    await new Promise((r) => setTimeout(r, 900));
    sample();
    /* ③ 回到全览 fit 之后再读一次**位置 ↔ 不透明度**（形状判据：平台恒 1、越靠边越暗且单调） */
    if (sel0) { sel0.value = ''; sel0.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((r) => setTimeout(r, 900)); }
    const wpx = scale.clientWidth;
    const rows = [];
    for (const el of majors()) {
      const op = opOf(el);
      if (op === null) continue;
      rows.push({ x: Math.round(xOf(el)), op: op });
    }
    const cx = wpx / 2;
    const mid = rows.filter((r) => Math.abs(r.x - cx) <= 0.15 * wpx);
    const edge = rows.filter((r) => Math.abs(r.x - cx) >= 0.40 * wpx);
    const sorted = rows.slice().sort((a, b) => Math.abs(a.x - cx) - Math.abs(b.x - cx));
    let monotone = true, monoAt = null;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].op > sorted[i - 1].op + 0.001) { monotone = false; monoAt = { i: i, prev: sorted[i - 1], now: sorted[i] }; break; }
    }
    const idleAnim = kids().reduce((n, el) => {
      let c = el.getAnimations && el.getAnimations().length ? 1 : 0;
      for (const s of labelsIn(el)) if (s.getAnimations && s.getAnimations().length) c++;
      return n + c;
    }, 0);
    raf = false;
    const midOps = mid.map((r) => r.op);
    const edgeOps = edge.map((r) => r.op);
    return {
      before: before.length, afterPan: afterPan.length, keep,
      maxAnim, maxLabelAnim, maxLabelMove, frames,
      linger, lingerAt, lingerSteps, idleAnim,
      maxDupPair, dupPairs,
      wpx, rowN: rows.length,
      midN: mid.length, midMin: midOps.length ? Math.min(...midOps) : null,
      edgeN: edge.length, edgeMin: edgeOps.length ? Math.min(...edgeOps) : null,
      edgeMax: edgeOps.length ? Math.max(...edgeOps) : null,
      monotone, monoAt,
      sampleRows: sorted.slice(0, 3).concat(sorted.slice(-3)),
      focused: document.hasFocus(), visible: document.visibilityState,
      reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  })()`);
  console.log('report =', JSON.stringify(report));

  check('★0 前置：标尺有主刻度、窗口可见且**不聚焦**（当帧落值前提）、没开「减少动态效果」',
    !report.fatal && report.reduced === false && report.before >= 5 && report.focused === false && report.visible === 'visible',
    { before: report.before, afterPan: report.afterPan, reduced: report.reduced, focused: report.focused, visible: report.visible });

  /* ★1 diff：平移后仍在屏上的刻度必须是**同一批 DOM 对象**（旧 innerHTML 实现每帧重建 ⇒ keep = 0） */
  check('★1 平移不重画标尺：留在屏上的刻度元素身份不变（keep ≥ 一半）',
    report.keep >= Math.max(1, Math.round(report.before * 0.5)),
    { before: report.before, afterPan: report.afterPan, keep: report.keep });

  /* ★2 新契约下**一点动画都不许有**（线不许动，文字也不再由时间驱动）。A/B 陷阱 = 上一版"按时间淡"
     那版：缩放期间文字 span 上挂着动画（实测 maxLabelAnim 29）⇒ 这条直接 FAIL。 */
  check('★2 全程零动画（刻度元素与文字 span 都没有 Animation：不透明度是算出来的，不是演出来的）',
    report.maxAnim === 0 && report.maxLabelAnim === 0 && report.maxLabelMove === 0,
    { maxAnim: report.maxAnim, maxLabelAnim: report.maxLabelAnim, maxLabelMove: report.maxLabelMove, frames: report.frames });

  /* ★3 换档时"名字没变"的数字复用同一元素（key 曾含 stepSec ⇒ 全批重建 ⇒ 用户看到的"字在闪"）。
     ⚠️ 样本必须真的是**换档**：判据不能只看"有同名标签"（同档位缩放本来就有 17/20 同名 ⇒ 假绿）。
     年档的档位能从标签自身的年份差读出来 ⇒ **中位年差变了**才认；
     找样本的法子 = 交替方向逐格缩放，取第一个「前后都是纯年份标签且中位年差变了」的点。 */
  const idrep = await ev(`(async () => {
    const scale = document.querySelector('#lk-pane-timeline .tl-scale');
    if (!scale) return { fatal: 'no .tl-scale' };
    const sel0 = document.getElementById('lk-line-sel');
    if (sel0) { sel0.value = ''; sel0.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((r) => setTimeout(r, 900)); }
    const majors = () => [...scale.querySelectorAll('.tl__axis-tick--major')];
    const mapOf = (els) => { const m = new Map(); for (const el of els) { const s = el.querySelector('.tl__axis-label'); if (s) m.set(s.textContent, el); } return m; };
    const yearsOf = (m) => { const out = []; for (const lab of m.keys()) { const mm = /^([0-9]+)年$/.exec(lab); if (!mm) return null; out.push(Number(mm[1])); } out.sort((a, b) => a - b); return out; };
    const gapOf = (ys) => { if (!ys || ys.length < 4) return null; const d = []; for (let i = 1; i < ys.length; i++) d.push(ys[i] - ys[i - 1]); d.sort((a, b) => a - b); return d[Math.floor(d.length / 2)]; };
    const shot = () => { const m = mapOf(majors()); return { map: m, n: m.size, gap: gapOf(yearsOf(m)) }; };
    let prev = shot();
    for (const d of [-100, 100]) {
      for (let k = 1; k <= 12; k++) {
        const wrap = scale.parentElement;
        const r = wrap.getBoundingClientRect();
        wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: d, altKey: true, clientX: r.left + Math.round(r.width / 2), clientY: r.top + 40, bubbles: true, cancelable: true }));
        await new Promise((res) => setTimeout(res, 700));
        const now = shot();
        let common = 0, keep = 0;
        for (const kv of now.map) { const was = prev.map.get(kv[0]); if (was) { common++; if (was === kv[1]) keep++; } }
        const switched = prev.gap !== null && now.gap !== null && prev.gap !== now.gap;
        if (switched && common >= 2) return { hitAt: k, dir: d, prevN: prev.n, nowN: now.n, prevGap: prev.gap, nowGap: now.gap, common: common, keep: keep };
        prev = now;
      }
    }
    return { hitAt: -1, prevN: prev.n, nowN: 0, prevGap: prev.gap, nowGap: null, common: 0, keep: 0 };
  })()`);
  check('★3 换档时"名字没变"的数字复用同一元素（不整批重建 ⇒ 数字不闪）',
    !!idrep && !idrep.fatal && idrep.hitAt > 0 && idrep.common >= 2 && idrep.keep === idrep.common,
    idrep);

  /* ★4 文字的不透明度 = **位置的纯函数**（用户 2026-09-26 的新规格）：
     中间平台（标尺半宽的 34%）恒 1，两头按 `exp(-4t^2)` 尾巴降下去，且**越靠边越暗（单调）**。
     A/B 陷阱：上一版（按时间淡入淡出）在静止视图里每个数字都是 1 —— 屏上没有"按位置变暗"这回事。 */
  check('★4 文字透明度 = 位置的纯函数（中间平台恒 1、两端变暗、整体单调）',
    report.midN >= 1 && report.midMin === 1 && report.edgeN >= 1 && report.edgeMin <= 0.6 && report.monotone === true,
    { wpx: report.wpx, rowN: report.rowN, midN: report.midN, midMin: report.midMin, edgeN: report.edgeN, edgeMin: report.edgeMin, edgeMax: report.edgeMax, monotone: report.monotone, monoAt: report.monoAt, sampleRows: report.sampleRows });

  /* ★5 走掉的刻度**当帧就摘**（DOM 与账本一一对应 ⇒ 屏上任何时刻只有一把尺子）。
     A/B 陷阱 = 上一版：走掉的元素留一拍（90~420ms）淡文字，当帧子元素数必然大于落定后（实测差 121）。 */
  check('★5 走掉的刻度当帧就摘（滚完当帧的子元素数 == 落定后；落定后无残留动画）',
    report.lingerSteps > 0 && report.linger === 0 && report.idleAnim === 0,
    { lingerSteps: report.lingerSteps, linger: report.linger, lingerAt: report.lingerAt, idleAnim: report.idleAnim, maxDupPair: report.maxDupPair, dupPairs: report.dupPairs });

  /* ── 第二段（开焦点仿真 ⇒ 走 rAF 缓动，才有"连续运动"）：★4b 不透明度不许跳 ────────────────
     ⚠️ 必须先 `Emulation.setFocusEmulationEnabled`：实例带 NOFOCUS 时 `noSmooth()` 为真、滚轮当帧落值，
     根本没有"连续缩放"可言（上一轮就是靠这条才量到硬切那 5.4px 的跳）。 */
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await sleep(200);
  const cont = await ev(`(async () => {
    const scale = document.querySelector('#lk-pane-timeline .tl-scale');
    if (!scale) return { fatal: 'no .tl-scale' };
    const sel0 = document.getElementById('lk-line-sel');
    if (sel0) { sel0.value = ''; sel0.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((r) => setTimeout(r, 900)); }
    const majors = () => [...scale.querySelectorAll('.tl__axis-tick--major')];
    const track = new Map();
    const LIM = 0.3;            /* dX 的下限（px）：元素几乎没动却变了 opacity 时，比值必须爆表 */
    let maxRatio = 0, ratioAt = null, maxDx = 0, movedFrames = 0, samples = 0;
    let raf = true;
    const step = () => {
      if (!raf) return;
      samples++;
      for (const el of majors()) {
        const s = el.querySelector('.tl__axis-label');
        if (!s) continue;
        const x = parseFloat(el.style.left) || 0;
        const op = Number(getComputedStyle(s).opacity);
        const prev = track.get(el);
        if (prev) {
          const dx = Math.abs(x - prev.x), dop = Math.abs(op - prev.op);
          if (dx > 0.02) movedFrames++;
          if (dx > maxDx) maxDx = dx;
          const ratio = dop / Math.max(dx, LIM);
          if (ratio > maxRatio) { maxRatio = ratio; ratioAt = { dx: Math.round(dx * 100) / 100, dop: Math.round(dop * 1000) / 1000, x: Math.round(x), op: op, prevOp: prev.op }; }
        }
        track.set(el, { x: x, op: op });
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    const wheel = (dy) => {
      const wrap = scale.parentElement;
      const r = wrap.getBoundingClientRect();
      wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, altKey: true, clientX: r.left + Math.round(r.width / 2), clientY: r.top + 40, bubbles: true, cancelable: true }));
    };
    /* 8 格 × 120ms：每格缓动约 250ms，互相重叠 ⇒ 全程连续运动（不是一格一格地跳）。 */
    for (let i = 0; i < 8; i++) { wheel(-60); await new Promise((r) => setTimeout(r, 120)); }
    await new Promise((r) => setTimeout(r, 400));
    /* 反向再来一轮：进出两个方向都要覆盖（上一轮的教训：对称 ± 会正好回到起点、一次都不跨）。 */
    for (let i = 0; i < 8; i++) { wheel(60); await new Promise((r) => setTimeout(r, 120)); }
    await new Promise((r) => setTimeout(r, 500));
    raf = false;
    return { maxRatio: Math.round(maxRatio * 10000) / 10000, ratioAt, maxDx: Math.round(maxDx * 100) / 100, movedFrames, samples, focused: document.hasFocus() };
  })()`);
  console.log('cont =', JSON.stringify(cont));
  await send('Emulation.setFocusEmulationEnabled', { enabled: false });

  check('★4b 连续缩放时文字不透明度连续（逐帧 |dOp|/max(|dX|,0.3) ≤ 0.08，且真的在连续动）',
    !!cont && !cont.fatal && cont.focused === true && cont.movedFrames >= 5 && cont.maxRatio <= 0.08,
    { maxRatio: cont.maxRatio, ratioAt: cont.ratioAt, maxDx: cont.maxDx, movedFrames: cont.movedFrames, samples: cont.samples, focused: cont.focused });

  const errs = await ev(`window.__errs`);
  check('★6 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n==== ${pass}/${results.length} PASS ====`);
  w.close();
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
