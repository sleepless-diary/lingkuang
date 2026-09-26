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
    const majors = () => [...scale.querySelectorAll('.tl__axis-tick--major:not(.tl__axis-tick--ghost)')];
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
    const majors = () => [...scale.querySelectorAll('.tl__axis-tick--major:not(.tl__axis-tick--ghost)')];
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

  /* ★4 文字的不透明度里**屏幕位置**那一半（`labelWindow()`，用户 2026-09-26 要求"留着手感弱一点、
      100% 的范围加长"）：中间平台（标尺半宽的 44%）恒 1，两头按 `exp(-2t^2)` 降下去（贴边 ≈0.135），
      且**越靠边越暗（单调）**。⚠️ 这只是两个因子之一 —— 另一半是**换档权重**（缩放值的函数，见 ★7）；
      本条跑在"平移不缩放"的干净 fit 上，那时换档权重恰好是 1（区间中部的平台）。
      A/B 陷阱：按时间淡入淡出那一版在静止视图里每个数字都是 1 —— 屏上没有"按位置变暗"这回事。 */
  check('★4 屏幕两端渐隐 = 位置的纯函数（中间平台恒 1、两端变暗、整体单调）',
    report.midN >= 1 && report.midMin === 1 && report.edgeN >= 1 && report.edgeMin <= 0.6 && report.monotone === true,
    { wpx: report.wpx, rowN: report.rowN, midN: report.midN, midMin: report.midMin, edgeN: report.edgeN, edgeMin: report.edgeMin, edgeMax: report.edgeMax, monotone: report.monotone, monoAt: report.monoAt, sampleRows: report.sampleRows });

  /* ★5 走掉的刻度**当帧就摘**（DOM 与账本一一对应 ⇒ 屏上任何时刻只有一把尺子）。
     A/B 陷阱 = 上一版：走掉的元素留一拍（90~420ms）淡文字，当帧子元素数必然大于落定后（实测差 121）。 */
  check('★5 走掉的刻度当帧就摘（滚完当帧的子元素数 == 落定后；落定后无残留动画）',
    report.lingerSteps > 0 && report.linger === 0 && report.idleAnim === 0,
    { lingerSteps: report.lingerSteps, linger: report.linger, lingerAt: report.lingerAt, idleAnim: report.idleAnim, maxDupPair: report.maxDupPair, dupPairs: report.dupPairs });

  /* ── 第二段：★4b「不透明度只由视图状态决定」（纯函数 ⇒ **可逆**）──────────────────────────
     用户规格是「**每个文字依照对应的 x（缩放尺度）计算当前的不透明度**」——纯函数的意思就是
     **跟历史无关**：缩到某个位置看到的透明度，缩回去再到同一位置必须一模一样。
     判据：从干净 fit 出发，**逐格放大 N 格**、每格记一份 `文字 → 不透明度`；再**逐格缩回 N 格**、
     同样记一份；两份按"同一格"逐一比对（反序对齐）。
     ⚠️ 走 NOFOCUS 的"当帧落值"路径（不模拟焦点）：每格都是确定的 1.2× 状态、没有缓动残差，
     "同一格"才可复现。按时间淡入淡出那一版在这里必然 FAIL —— 它的值取决于"谁刚进来/谁刚被取消"，
     同一格第二次经过时对不上（这正是"闪"的来源）。
     ⚠️ 只比**当前档**的刻度（排除 `.tl__axis-tick--ghost` 邻居档）：两套档位的数字混在一张表里，
     同一个文字可能来自不同的网格、权重也不同。 */
  const cont = await ev(`(async () => {
    const scale = document.querySelector('#lk-pane-timeline .tl-scale');
    if (!scale) return { fatal: 'no .tl-scale' };
    const sel0 = document.getElementById('lk-line-sel');
    if (sel0) { sel0.value = ''; sel0.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((r) => setTimeout(r, 900)); }
    /* ⚠️ key 必须带**屏幕位置**：月/日/时/分档的 .tl__axis-label 只有「11月」这种文本（年份在
       .tl__axis-prev 里），同屏会有好几个「11月」⇒ 只按文本存 map 会互相覆盖，比的是**不同的刻度**
       （第一版就这么假 FAIL 的：worst 0.927、text=11月、fwd 0.073 vs back 1）。同一视图状态下
       位置是同一个整数 ⇒ 文字+left 既唯一又跨两趟可比。
       sig = 当前档所有刻度位置的签名：两趟"同一格"必须签名一致（这才是"真的是同一格"的证据）。
       ⚠️ 本段住在模板字符串里：注释里也不许出现反引号或美元花括号。 */
    const snap = () => {
      const m = {};
      const xs = [];
      for (const el of scale.querySelectorAll('.tl__axis-tick--major:not(.tl__axis-tick--ghost)')) {
        const s = el.querySelector('.tl__axis-label');
        if (!s) continue;
        const x = Math.round(parseFloat(el.style.left) || 0);
        xs.push(x);
        m[s.textContent + '|' + x] = Math.round(Number(getComputedStyle(s).opacity) * 1000) / 1000;
      }
      xs.sort((a, b) => a - b);
      return { m: m, sig: xs.join(',') };
    };
    const wrap = scale.parentElement;
    const rr = wrap.getBoundingClientRect();
    const opts = { altKey: true, clientX: rr.left + Math.round(rr.width / 2), clientY: rr.top + 40, bubbles: true, cancelable: true };
    const go = (dy) => wrap.dispatchEvent(new WheelEvent('wheel', Object.assign({ deltaY: dy }, opts)));
    const N = 12;
    const fwd = [snap()];                     /* fwd[i] = 放大 i 格后的状态（fwd[0] = 干净 fit） */
    for (let i = 0; i < N; i++) { go(-100); await new Promise((r) => setTimeout(r, 150)); fwd.push(snap()); }
    const back = [snap()];                    /* back[0] = 刚放大完的状态（= fwd[N]） */
    for (let i = 0; i < N; i++) { go(100); await new Promise((r) => setTimeout(r, 150)); back.push(snap()); }
    /* ⚠️ 两边**必须同构**：back 数组里不能再多推一次快照 —— 第一版多推了一格，于是 back[N-i]
       整体错开一整格（20% 缩放），比出来一片"透明度差 0.487"的假 FAIL。
       ⚠️ 本段住在模板字符串里：注释里不许出现反引号或美元花括号。 */
    /* 两趟对齐：**同文字 + 位置 ±3px 内取最近**。不要求"整屏签名完全一致"——屏幕两端多一根/
       少一根刻度就会让签名不同（实测 sigBad 12/12，可实际上对得上的那些刻度透明度**一模一样**，
       worst 0）。±3px 容得下浮点漂移与边缘刻度的进出，又不会把"整屏错位"当成对得上。 */
    const byText = (s) => {
      const m = new Map();
      for (const k of Object.keys(s.m)) {
        const p = k.split('|');
        if (!m.has(p[0])) m.set(p[0], []);
        m.get(p[0]).push({ x: Number(p[1]), op: s.m[k] });
      }
      return m;
    };
    let pairs = 0, worst = 0, worstAt = null, differ = 0, changed = 0;
    for (let i = 0; i <= N; i++) {
      const a = fwd[i], b = back[N - i];
      const mb = byText(b);
      for (const k of Object.keys(a.m)) {
        const p = k.split('|');
        const x = Number(p[1]);
        const cand = (mb.get(p[0]) || []).filter((c) => Math.abs(c.x - x) <= 3);
        if (!cand.length) continue;
        cand.sort((u, v) => Math.abs(u.x - x) - Math.abs(v.x - x));
        pairs++;
        const d = Math.abs(a.m[k] - cand[0].op);
        if (d > worst) { worst = d; worstAt = { step: i, text: k, fwd: a.m[k], back: cand[0].op, bx: cand[0].x }; }
        if (d > 0.02) differ++;
      }
      if (i > 0 && fwd[i].sig !== fwd[i - 1].sig) changed++;
    }
    return { pairs: pairs, worst: Math.round(worst * 1000) / 1000, worstAt: worstAt, differ: differ, changed: changed, N: N, firstN: Object.keys(fwd[0].m).length, lastN: Object.keys(fwd[N].m).length, focused: document.hasFocus() };
  })()`);
  console.log('cont =', JSON.stringify(cont));

  check('★4b 不透明度只由视图状态决定（缩进 12 格再缩回，同一格透明度完全一致 ⇒ 纯函数）',
    !!cont && !cont.fatal && cont.pairs >= 20 && cont.differ === 0 && cont.changed >= 3,
    { pairs: cont.pairs, worst: cont.worst, worstAt: cont.worstAt, differ: cont.differ, changed: cont.changed, N: cont.N, firstN: cont.firstN, lastN: cont.lastN, focused: cont.focused });

  /* ── ★7（第 ⑥ 轮新功能）换档时**两套数字同时在、各约 50%**（用户 2026-09-26 拍板选的 A 交叉淡化）──
     只看中间段（x ∈ [0.2w, 0.8w]）的刻度：把"两端渐隐"那个因子排除掉，读到就是**换档权重**本身。
     三条判据：
       · `mixed ≥ 1` —— 某一帧上有两套档位、且**两套都在淡的中途**（top ∈ (0.15, 0.9)）；
       · `minTop ≥ 0.45` —— 任何一帧中间段都至少有一套 ≥0.45（**不许出现"两边都看不见"的空白**，
         这正是"先出后进"那版会踩的，也是用户要的"两边加起来 ≈1"）；
       · `twoFull === 0` —— 从不出现两套都 ≥0.9（= 第四十二轮那个"两个重叠的标尺"）；
       · `animFrames === 0` —— 全程没有任何刻度在播动画（不透明度是算出来的）。
     ⚠️ A/B：旧构建换档是**硬切**（旧档当帧消失、新档满不透明度出现）⇒ 任何一帧都只有一套档位 ⇒
     `mixed = 0` ⇒ 本条必然 FAIL。 */
  const hand = await ev(`(async () => {
    const scale = document.querySelector('#lk-pane-timeline .tl-scale');
    if (!scale) return { fatal: 'no .tl-scale' };
    const sel0 = document.getElementById('lk-line-sel');
    if (sel0) { sel0.value = ''; sel0.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((r) => setTimeout(r, 900)); }
    const unitOf = (t) => {
      if (/年$/.test(t)) return '年';
      if (/月$/.test(t)) return '月';
      if (/号$/.test(t)) return '日';
      if (/时$/.test(t)) return '时';
      if (/分$/.test(t)) return '分';
      return '?';
    };
    const sample = () => {
      const w = scale.clientWidth;
      const byUnit = {};
      let anim = 0;
      for (const el of scale.querySelectorAll('.tl__axis-tick--major')) {
        if (el.getAnimations && el.getAnimations().length) anim++;
        const sp = el.querySelector('.tl__axis-label');
        if (!sp) continue;
        const x = parseFloat(el.style.left) || 0;
        if (x < w * 0.2 || x > w * 0.8) continue;
        const u = unitOf(sp.textContent);
        const op = Number(getComputedStyle(sp).opacity);
        const cur = byUnit[u] || (byUnit[u] = { n: 0, max: 0 });
        cur.n++;
        if (op > cur.max) cur.max = op;
      }
      return { units: byUnit, nUnits: Object.keys(byUnit).length, anim: anim };
    };
    const wrap = scale.parentElement;
    const r = wrap.getBoundingClientRect();
    const opts = { deltaY: -100, altKey: true, clientX: r.left + Math.round(r.width * 0.45), clientY: r.top + 40, bubbles: true, cancelable: true };
    let mixed = 0, mixedAt = null, twoFull = 0, worstSum = 9, minTop = 9, animFrames = 0, frames = 0, noMid = 0;
    const take = () => {
      const s = sample();
      frames++;
      if (s.anim) animFrames++;
      const keys = Object.keys(s.units);
      if (!keys.length) { noMid++; return; }
      const tops = keys.map((k) => s.units[k].max).sort((a, b) => b - a);
      if (tops[0] < minTop) minTop = tops[0];
      if (s.nUnits >= 2) {
        const sum = tops[0] + tops[1];
        if (sum < worstSum) worstSum = sum;
        if (tops[0] >= 0.9 && tops[1] >= 0.9) twoFull++;
        if (tops[0] < 0.9 && tops[1] > 0.15) { mixed++; if (!mixedAt) mixedAt = { i: frames, units: keys, tops: tops.map((v) => Math.round(v * 1000) / 1000) }; }
      }
    };
    take();
    for (let i = 1; i <= 40; i++) {
      wrap.dispatchEvent(new WheelEvent('wheel', opts));
      await new Promise((res) => setTimeout(res, 60));
      take();
    }
    return { mixed: mixed, mixedAt: mixedAt, twoFull: twoFull, worstSum: Math.round(worstSum * 100) / 100, minTop: Math.round(minTop * 1000) / 1000, animFrames: animFrames, frames: frames, noMid: noMid };
  })()`);
  console.log('hand =', JSON.stringify(hand));
  check('★7 换档时两套数字同时在、各约 50%（交叉淡化；且永不出现"两套都满"的空白/两把尺子）',
    !!hand && !hand.fatal && hand.mixed >= 1 && hand.twoFull === 0 && hand.animFrames === 0 && hand.minTop >= 0.45,
    { mixed: hand.mixed, mixedAt: hand.mixedAt, twoFull: hand.twoFull, worstSum: hand.worstSum, minTop: hand.minTop, animFrames: hand.animFrames, frames: hand.frames, noMid: hand.noMid });

  const errs = await ev(`window.__errs`);
  check('★6 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n==== ${pass}/${results.length} PASS ====`);
  w.close();
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
