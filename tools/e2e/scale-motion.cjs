/* 不变量：**标尺刻度是"在的留下、新来的入场、走掉的后退场"**，不是每次重画整条标尺。
 *
 * 用户 2026-09-19 原话：「年月日等刻度的**出入场用不透明度和缩放尺度**计算」。
 * 病根（旧实现）：`src/ui/timeline.ts` 的 `renderScale()` 结尾是 `scaleEl.innerHTML = html + subHtml`
 * —— 每帧（平移/缩放/缓动都在调 render）把 180 来个刻度元素**整体重建**，
 * 于是：① 元素对象每帧都换新的（"整条标尺重画"的闪动）；② 没有任何出入场（当场消失、当场出现）。
 *
 * 判据（三条各盯一种"没做"）：
 *   ★1 平移后仍在屏上的刻度**元素身份不变**（旧实现 = 0 个存活）；
 *   ★2 新进场的刻度**带入场动画**，且关键帧是不透明度 + 缩放尺度（用户点名的两样）；
 *   ★3 离场的刻度**不是当场消失**：先退场（有动画）、至少 80ms 后才被摘掉（旧实现 = 同一帧删掉、0 动画）；
 *   ★4 守 `fill:'both'` 的坑：稳定后刻度上不许残留动画（否则被钉在动画值上）；
 *   ★6 换档那一下**两批动画的时间区间不相交**（2026-09-26 一轮：不许出现两把尺子）；
 *   ★7 换档时**"名字没变"的数字复用同一元素**（2026-09-26 二轮：数字不许整批重建 ⇒ 不闪）；
 *   ★5 全程没有未捕获异常。
 *
 * ⚠️ 环境前提两条（都是实测踩出来的）：
 *   ① 窗口**必须可见**（`LINGKUANG_TEST_WINDOW_POS="1920,0"` 开副屏）：窗口 hidden 时 rAF 不跑，
 *      启动 fit（`src/ui/timeline.ts:653`）与切聚焦的 fit（`:845`）都挂在 rAF 上 ⇒ 视图停在默认档。
 *   ② 不聚焦没关系（`LINGKUANG_TEST_WINDOW_NOFOCUS=1`）：`noSmooth()` 为真 ⇒ 滚轮当帧落值，
 *      平移的几何是确定的（正合本套件"同步读 DOM"的读法）。
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
  await sleep(800);   /* 让启动 fit 与入场动画落地 */

  const report = await ev(`(async () => {
    const scale = document.querySelector('#lk-pane-timeline .tl-scale');
    if (!scale) return { fatal: 'no .tl-scale' };
    const majors = () => [...scale.querySelectorAll('.tl__axis-tick--major')];
    const before = majors();
    const beforeSet = new Set(before);
    const added = [], removed = [];
    let addedAnimated = 0, removedAnimated = 0, sampleAddedFrames = null, sampleAddedName = null, sampleRemovedPlay = null;
    const t0 = performance.now();
    const removalDelays = [];
    /* ⚠️ 一次 insertBefore 会把节点记成**一加一删**（这是"移动"，不是"进出"）：
       不排掉的话，20 个真新元素会被记成 92 个"新增"，而"摘除延迟"也被移动记录污染成 4ms。
       判据 = **同一次回调里既出现在 addedNodes 又出现在 removedNodes** ⇒ 移动。
       （⚠️ 这段住在模板字符串里：注释里不许出现反引号或美元花括号。） */
    const mo = new MutationObserver((recs) => {
      const addSet = new Set(), remSet = new Set(), adds = [], rems = [];
      for (const rec of recs) {
        for (const n of rec.addedNodes) if (n.nodeType === 1) { adds.push(n); addSet.add(n); }
        for (const n of rec.removedNodes) if (n.nodeType === 1) { rems.push(n); remSet.add(n); }
      }
      for (const n of adds) {
        if (remSet.has(n)) continue;          /* 移动，不是新来的 */
        added.push(n);
        const an = n.getAnimations ? n.getAnimations() : [];
        if (an.length) {
          addedAnimated++;
          if (!sampleAddedFrames) {
            const eff = an[0].effect;
            sampleAddedFrames = eff && eff.getKeyframes ? eff.getKeyframes().map((k) => ({ opacity: k.opacity, transform: k.transform })) : null;
            sampleAddedName = n.className;
          }
        }
      }
      for (const n of rems) {
        if (addSet.has(n)) continue;          /* 移动，不是走掉的 */
        removed.push(n);
        const an = n.getAnimations ? n.getAnimations() : [];
        if (an.length) { removedAnimated++; if (!sampleRemovedPlay) sampleRemovedPlay = an[0].playState; }
        removalDelays.push(Math.round(performance.now() - t0));
      }
    });
    mo.observe(scale, { childList: true });
    /* 平移 180px（普通滚轮；不聚焦的测试窗口里 noSmooth() 真 ⇒ 当帧落值，几何是确定的） */
    const anchor = scale.querySelector('.tl__axis-tick--major') || scale.parentElement;
    anchor.dispatchEvent(new WheelEvent('wheel', { deltaY: -180, bubbles: true, cancelable: true }));
    /* 先让 MutationObserver 的微任务把"同一次重画"记完，再等退场动画走完 */
    await new Promise((r) => setTimeout(r, 0));
    const syncAdded = added.length, syncRemoved = removed.length, syncAddedAnimated = addedAnimated, syncRemovedAnimated = removedAnimated;
    /* 退场窗口内**采样**：正在退场的刻度此刻还在 DOM 里、且身上挂着动画。
       （不在"被摘掉的那一刻"读：remove() 与 cancel() 在同一个任务里，MutationObserver 的回调是
        微任务、跑的时候动画已经取消了 —— 那会儿读永远是 0，测不出东西。） */
    let midAnimatedMax = 0, midAliveMax = 0;
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 40));
      const kids = [...scale.children];
      const anim = kids.filter((el) => el.getAnimations && el.getAnimations().length).length;
      if (anim > midAnimatedMax) midAnimatedMax = anim;
      if (kids.length > midAliveMax) midAliveMax = kids.length;
    }
    await new Promise((r) => setTimeout(r, 1200));
    mo.disconnect();
    const after = majors();
    const keep = after.filter((el) => beforeSet.has(el)).length;
    const lingering = after.filter((el) => el.getAnimations && el.getAnimations().length).length;
    return {
      reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      before: before.length, after: after.length, keep,
      added: added.length, removed: removed.length,
      syncAdded, syncRemoved, syncAddedAnimated, syncRemovedAnimated,
      addedAnimated, removedAnimated, sampleAddedFrames, sampleAddedName, sampleRemovedPlay,
      midAnimatedMax, midAliveMax,
      minRemovalDelayMs: removalDelays.length ? Math.min(...removalDelays) : null,
      lingering,
      labels: after.slice(0, 4).map((el) => el.querySelector('.tl__axis-label')?.textContent ?? ''),
    };
  })()`);
  console.log('report =', JSON.stringify({ ...report, sampleAddedFrames: report.sampleAddedFrames ? report.sampleAddedFrames.slice(0, 2) : null }));

  check('★0 前置：标尺有主刻度、没开「减少动态效果」（否则出入场按设计不播）',
    !report.fatal && report.reduced === false && report.before >= 5, { before: report.before, after: report.after, reduced: report.reduced });

  /* ★1 不重画：平移后仍在屏上的刻度必须是**同一批 DOM 对象**（旧实现每帧 innerHTML ⇒ keep = 0） */
  check('★1 平移不重画标尺：留在屏上的刻度元素身份不变（keep ≥ 一半）',
    report.keep >= Math.max(1, Math.round(report.before * 0.5)),
    { before: report.before, after: report.after, keep: report.keep });

  /* ★2 入场：新出现的刻度带入场动画，关键帧是不透明度 + 缩放尺度（用户点名的两样） */
  const frames = report.sampleAddedFrames || [];
  const f0 = frames[0] || {}, f1 = frames[frames.length - 1] || {};
  const hasFade = f0.opacity === '0' || f0.opacity === 0;
  const hasEndOpaque = f1.opacity === '1' || f1.opacity === 1 || f1.opacity === undefined;
  const hasScale = !!(f0.transform && /scale/.test(f0.transform));
  check('★2 新进场的刻度有入场动画（不透明度 0→1 + 缩放尺度），且每个新刻度都带',
    report.syncAdded > 0 && report.syncAddedAnimated === report.syncAdded && hasFade && hasEndOpaque && hasScale,
    { added: report.syncAdded, animated: report.syncAddedAnimated, frames, hasFade, hasScale });

  /* ★3 退场：离场的刻度**不在同一次重画里删掉** —— 它先播退场动画（窗口内采样到"身上有动画的刻度"），
     并且至少 80ms 后才被摘掉。旧实现的 `innerHTML =` 是同一帧删旧建新（摘除延迟 ≈ 2ms、动画 0 个）。 */
  check('★3 离场的刻度先退场再摘掉（退场窗口内有刻度在演 + 摘除延迟 ≥ 80ms）',
    report.removed > 0 && report.midAnimatedMax >= 3 && report.minRemovalDelayMs !== null && report.minRemovalDelayMs >= 80,
    { removed: report.removed, midAnimatedMax: report.midAnimatedMax, midAliveMax: report.midAliveMax, minRemovalDelayMs: report.minRemovalDelayMs });

  /* ★4 守 `fill:'both'`：稳定后刻度上不许残留动画（残留 = 被钉在动画值上 / 空转） */
  check('★4 稳定后没有残留动画（fill:both 的动画都收干净了）',
    report.lingering === 0, { lingering: report.lingering, after: report.after });

  /* ★6 换档不许出现"两把尺子"（用户 2026-09-26 实测报的）：
     「有入场，但是会暂时出现两个重叠的标尺」—— 整批换刻度时如果出入场**并行**，
     旧刻度淡出的那 220ms 里新刻度已经在淡入，屏上同时两套刻度 = 两把尺子。
     判据落在"时间区间"上（与帧率无关）：把此刻挂着动画的刻度按「落定后还在不在 DOM 里」
     分成入场/退场两批，读各自的 [delay, delay+duration]，断言两批区间**不相交**（≤20ms 容差）。 */
  const sw = await ev(`(async () => {
    const scale = document.querySelector('#lk-pane-timeline .tl-scale');
    if (!scale) return { fatal: 'no .tl-scale' };
    /* 起始状态**自带干净 fit**（2026-09-26 补）：本套件连跑两次时，上一轮会把视图留在"缩放到极限"
       的位置上，再往外缩会被夹住 ⇒ 12 步里一次换档都没发生 ⇒ 假 FAIL（实测 hitAt: -1）。
       切一次「— 全览 —」拿回干净 fit（下拉的处理器里带 rAF fitAll），与首次运行等价。 */
    const sel0 = document.getElementById('lk-line-sel');
    if (sel0) { sel0.value = ''; sel0.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((r) => setTimeout(r, 900)); }
    const majors = () => [...scale.querySelectorAll('.tl__axis-tick--major')];
    const labelsOf = (els) => els.map((el) => { const s = el.querySelector('.tl__axis-label'); return s ? s.textContent : ''; });
    const spanOf = (el) => { const a = el.getAnimations ? el.getAnimations()[0] : null; if (!a || !a.effect || !a.effect.getTiming) return null; const t = a.effect.getTiming(); return [t.delay, t.delay + t.duration]; };
    let prev = majors(), prevLabels = labelsOf(prev);
    for (let k = 1; k <= 12; k++) {
      const wrap = scale.parentElement;
      const r = wrap.getBoundingClientRect();
      wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, altKey: true, clientX: r.left + Math.round(r.width / 2), clientY: r.top + 40, bubbles: true, cancelable: true }));
      /* ⚠️ 先抓动画，再等落定：这一帧 DOM 里同时有"正在退场的旧刻度"和"刚入场的新刻度"，
         直接比标签会把新旧混在一起读（实测 common 一直偏高 ⇒ 整批判不出来）。 */
      const anim = [];
      for (const el of [...scale.children]) { const s = spanOf(el); if (s) anim.push({ el: el, span: s }); }
      await new Promise((res) => setTimeout(res, 700));
      const now = majors(), nowLabels = labelsOf(now);
      const common = nowLabels.filter((l) => prevLabels.indexOf(l) >= 0).length;
      const wholesale = prevLabels.length >= 3 && nowLabels.length >= 3 && common <= Math.floor(nowLabels.length / 2);
      if (wholesale) {
        const alive = new Set([...scale.children]);   /* 落定后还在 = 入场批；不在 = 退场批（已演完摘掉） */
        const enter = [], leave = [];
        for (const x of anim) (alive.has(x.el) ? enter : leave).push(x.span);
        return { hitAt: k, prevCount: prev.length, nowCount: now.length, common: common, animCount: anim.length, enterCount: enter.length, leaveCount: leave.length, enter: enter, leave: leave };
      }
      prev = now; prevLabels = nowLabels;
    }
    return { hitAt: -1, prevCount: prev.length, nowCount: 0, common: null, animCount: 0, enterCount: 0, leaveCount: 0, enter: [], leave: [] };
  })()`);
  const spanStarts = (a) => (a.length ? Math.min(...a.map((s) => s[0])) : null);
  const spanEnds = (a) => (a.length ? Math.max(...a.map((s) => s[1])) : null);
  const gapMs = sw && sw.enterCount && sw.leaveCount
    ? Math.max(spanStarts(sw.enter) - spanEnds(sw.leave), spanStarts(sw.leave) - spanEnds(sw.enter))
    : null;
  check('★6 换档（整批换刻度）时退场与入场**时间上不重叠**（两批 [delay, delay+duration] 不相交，容差 20ms）',
    !!sw && !sw.fatal && sw.hitAt > 0 && sw.enterCount >= 3 && sw.leaveCount >= 3 && gapMs !== null && gapMs >= -20,
    sw ? { hitAt: sw.hitAt, prev: sw.prevCount, now: sw.nowCount, common: sw.common, anim: sw.animCount, enter: sw.enterCount, leave: sw.leaveCount, gapMs,
      enterSpans: sw.enter.slice(0, 3), leaveSpans: sw.leave.slice(0, 3) } : sw);

  /* ★7 换档时**名字没变的那些数字必须复用同一元素**。
     旧实现的 key 里带了 `stepSec` ⇒ 缩放每跨过一次档位（`quantStep()` 在 1/2/5/10×10^k 之间跳）
     每根刻度的 key 就全变 ⇒ 整批判成"换档" ⇒ 数字先淡掉 100ms 再淡回来 =
     用户 2026-09-26 实测报的「入场时标尺的文字会闪一下」（线落在原来那些位置上，所以"只有字在闪"）。
     判据：两次落定之间**同名标签**的元素必须是同一个对象（旧实现 keep = 0）。
     ⚠️ 样本必须真的是**换档**：判据不能只看"有同名标签"（同档位缩放本来就有 17/20 同名、
     元素也本来就会复用 ⇒ 假绿）。年档的档位可以用标签自身的年份差读出来 ⇒ **中位年差变了**
     才认。找样本的法子 = 交替方向逐格缩放，取第一个「前后都是纯年份标签且中位年差变了」的点。 */
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
  check('★7 换档时"名字没变"的数字复用同一元素（不整批重建 ⇒ 数字不闪）',
    !!idrep && !idrep.fatal && idrep.hitAt > 0 && idrep.common >= 2 && idrep.keep === idrep.common,
    idrep);

  const errs = await ev(`window.__errs`);
  check('★5 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n==== ${pass}/${results.length} PASS ====`);
  w.close();
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
