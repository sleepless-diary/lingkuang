/* 不变量：**标尺刻度只做 DOM diff（在的留下、新来的当场出现、走掉的当场摘掉），不播任何出入场动画。**
 *
 * 这条判据是用户两次改口之后定下来的最终态：
 *   用户 2026-09-19：「年月日等刻度的**出入场用不透明度和缩放尺度**计算」→ 09-26 上午做了；
 *   同日下午：「**要不标尺动画去了吧，感觉有点，emm不符合我的预期**」⇒ 整套出入场撤掉。
 * 标尺是**量具**：缩放/平移时该「纹丝不动地换值」，不表演。
 *
 * ⚠️ 撤掉的是动画，**不是** DOM diff —— 后者是「整条标尺重画」那个闪的解药（`src/ui/timeline.ts` 的
 * `paintScale()`：key = 种类|unit|时刻，元素复用 + `scaleHtml` 按需重写）。所以本套件盯这两件事：
 *   ★1 平移后仍在屏上的刻度**元素身份不变**（旧 `scaleEl.innerHTML = html + subHtml` 实现 = keep 0）；
 *   ★2 全程**没有任何刻度在播动画**（A/B 陷阱：上一版有 220ms 的 opacity+scale 出入场 ⇒ FAIL）；
 *   ★3 换档时**"名字没变"的数字复用同一元素**（key 曾含 `stepSec` ⇒ 每跨一次档位全批重建 ⇒ 数字闪）；
 *   ★4 走掉的刻度**当帧就摘**、不在 DOM 里多留一拍（"还在退场中的旧尺子"就是"两把尺子"的来源；
 *      A/B 陷阱：上一版退场要 220ms，滚完当帧读到的是"旧+新"两套 ⇒ FAIL）；
 *   ★5 全程没有未捕获异常。
 *
 * ⚠️ 环境前提三条（都是实测踩出来的，★0 一起断言）：
 *   ① 窗口**必须可见**（`LINGKUANG_TEST_WINDOW_POS="1920,0"` 开副屏）：窗口 hidden 时 rAF 不跑，
 *      启动 fit（`src/ui/timeline.ts`）与切聚焦的 fit 都挂在 rAF 上 ⇒ 视图停在默认档，采样器也不跑。
 *   ② 窗口**必须不聚焦**（`LINGKUANG_TEST_WINDOW_NOFOCUS=1`）：`noSmooth()` 为真 ⇒ 滚轮当帧落值。
 *      **★4 依赖这条** —— 聚焦时视图是平滑逼近的（~250ms），刻度本来就该在这期间进出，
 *      "当帧子元素数 == 落定后子元素数"不成立，会假 FAIL。
 *   ③ 没开「减少动态效果」（否则上一版的出入场按设计不播，★2 的 A/B 陷阱失效）。
 *
 * 📌 一条**踩过的错判据**（别再写回去）：不能拿"同屏有没有重复的**标签文本**"当"两把尺子"的判据 ——
 *   月档的标签就是 `1月 / 2月 …`，跨年的两个刻度天然文字相同（实测 maxDup 7，全是月名）。
 *   真要按文字判，必须比 **(文字, left) 对**（叠在一起才是两把尺子）；这里只把它当诊断读数打印。
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
    let maxAnim = 0, frames = 0;
    /* 诊断读数（不是判据）：**(文字, left) 相同的对**才算"两把尺子叠在一起"；
       只比文字会误判 —— 月档标签就是 1月/2月…，跨年天然重复。 */
    let maxDupPair = 0, dupPairs = null;
    const sample = () => {
      frames++;
      const ks = kids();
      let anim = 0;
      for (const el of ks) if (el.getAnimations && el.getAnimations().length) anim++;
      if (anim > maxAnim) maxAnim = anim;
      const seen = new Set(), dup = [];
      for (const el of ks) {
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
    /* ① 平移 180px（普通滚轮）：读"元素身份不变" */
    const before = majors();
    const beforeSet = new Set(before);
    wheel(-180, false);
    sample();
    await new Promise((r) => setTimeout(r, 700));
    const afterPan = majors();
    const keep = afterPan.filter((el) => beforeSet.has(el)).length;
    sample();
    /* ② 缩放扫过若干档位（交替方向）：每一格都读两次子元素数 ——
       **滚完当帧** 与 **落定 500ms 后**（期间没有任何输入）必须一样；不一样就说明有元素在"退场中"多留着
       （上一版就是旧刻度淡出 220ms 里新旧两套同时在屏上 = 用户说的"两个重叠的标尺"）。 */
    let maxLinger = 0, lingerSteps = 0, lingerAt = null;
    for (const d of [-100, 100, -100, 100]) {
      for (let k = 1; k <= 5; k++) {
        wheel(d, true);
        sample();
        const nowN = kids().length;
        await new Promise((r) => setTimeout(r, 500));
        sample();
        const settledN = kids().length;
        lingerSteps++;
        const gap = Math.abs(nowN - settledN);
        if (gap > maxLinger) { maxLinger = gap; lingerAt = { dir: d, step: k, nowN, settledN }; }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
    raf = false;
    sample();
    return {
      before: before.length, afterPan: afterPan.length, keep,
      maxAnim, frames, maxLinger, lingerSteps, lingerAt, maxDupPair, dupPairs, totalKids: kids().length,
      focused: document.hasFocus(), visible: document.visibilityState,
      labels: afterPan.slice(0, 4).map((el) => el.querySelector('.tl__axis-label')?.textContent ?? ''),
      reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  })()`);
  console.log('report =', JSON.stringify(report));

  check('★0 前置：标尺有主刻度、窗口可见且**不聚焦**（noSmooth 前提）、没开「减少动态效果」',
    !report.fatal && report.reduced === false && report.before >= 5 && report.focused === false && report.visible === 'visible',
    { before: report.before, afterPan: report.afterPan, reduced: report.reduced, focused: report.focused, visible: report.visible });

  /* ★1 diff：平移后仍在屏上的刻度必须是**同一批 DOM 对象**（旧 innerHTML 实现每帧重建 ⇒ keep = 0） */
  check('★1 平移不重画标尺：留在屏上的刻度元素身份不变（keep ≥ 一半）',
    report.keep >= Math.max(1, Math.round(report.before * 0.5)),
    { before: report.before, afterPan: report.afterPan, keep: report.keep });

  /* ★2 **标尺不播动画**（用户 2026-09-26 把 09-19 那条推翻）：
     A/B 陷阱 = 上一版每个新/旧刻度都有 220ms 的 opacity+scale，采样必然读到非 0。 */
  check('★2 标尺全程没有任何刻度在播动画（平移 + 反复换档都不许，maxAnim === 0）',
    report.maxAnim === 0, { maxAnim: report.maxAnim, frames: report.frames });

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

  /* ★4 走掉的刻度**当帧就摘**：撤掉退场动画之后，DOM 与账本任何时刻一一对应，
     滚完当帧的子元素数必须等于落定后的子元素数（上一版退场 220ms ⇒ 读到"旧+新"两套 = 两把尺子）。 */
  check('★4 走掉的刻度当帧就摘（滚完当帧的子元素数 == 落定后，全程无"退场中"的残留）',
    report.lingerSteps > 0 && report.maxLinger === 0,
    { lingerSteps: report.lingerSteps, maxLinger: report.maxLinger, lingerAt: report.lingerAt, maxDupPair: report.maxDupPair, dupPairs: report.dupPairs });

  const errs = await ev(`window.__errs`);
  check('★5 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n==== ${pass}/${results.length} PASS ====`);
  w.close();
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
