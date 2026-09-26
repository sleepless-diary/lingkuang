/* 不变量：**标尺只做 DOM diff；「线」永不播动画；只有里面的「文字」随缩放淡进淡出。**
 *
 * 这条判据是用户三次改口之后定下来的最终态（每一版都留下了守卫，别再翻回去）：
 *   2026-09-19：「年月日等刻度的**出入场用不透明度和缩放尺度**计算」→ 09-26 上午做了；
 *   09-26 下午：「**要不标尺动画去了吧，感觉有点，emm不符合我的预期**」⇒ 整套撤掉；
 *   09-26 再一轮：「**标尺上的文字能不能随缩放比例稍微做一点不透明度的出入场**」⇒ 折中：
 *   **只淡文字、只由缩放驱动、不做 scale**（标尺是量具：线与网格位置纹丝不动，数字柔和进出）。
 * 所以本套件盯这五件事：
 *   ★1 平移后仍在屏上的刻度**元素身份不变**（旧 `scaleEl.innerHTML = html + subHtml` 实现 = keep 0）；
 *   ★2 刻度**元素本身**（那根线）全程零动画（A/B 陷阱：09-26 上午那版给刻度元素挂 opacity+scale ⇒ FAIL）；
 *   ★3 换档时**"名字没变"的数字复用同一元素**（key 曾含 `stepSec` ⇒ 每跨一次档位全批重建 ⇒ 数字闪）；
 *   ★4 退场中的刻度**线当帧隐身**（带 is-out 类、border 透明）⇒ 屏上"看得见的线"任何时刻只有一套
 *      （A/B 陷阱：09-26 上午那版新旧两套线同时在屏上淡出 = 用户说的「两个重叠的标尺」⇒ FAIL）；
 *   ★6 缩放/平移时**文字**确实在淡（入场 `maxLabelAnim ≥ 1` + 退场 `outFading ≥ 1`）且**只有 opacity**
 *      （`maxLabelMove === 0`）（A/B 陷阱：09-26 下午"全撤"那版没有任何文字动画 ⇒ FAIL；
 *      若有人手滑把 `scale()` 写回来，`maxLabelMove` 抓住它）；
 *   ★5 全程没有未捕获异常。
 *
 * ⚠️ 环境前提三条（都是实测踩出来的，★0 一起断言）：
 *   ① 窗口**必须可见**（`LINGKUANG_TEST_WINDOW_POS="1920,0"` 开副屏）：窗口 hidden 时 rAF 不跑，
 *      启动 fit（`src/ui/timeline.ts`）与切聚焦的 fit 都挂在 rAF 上 ⇒ 视图停在默认档，采样器也不跑。
 *   ② 窗口**必须不聚焦**（`LINGKUANG_TEST_WINDOW_NOFOCUS=1`）：`noSmooth()` 为真 ⇒ 滚轮当帧落值。
 *      **★4 依赖这条** —— 聚焦时视图是平滑逼近的（~250ms），新旧刻度本来就该在这期间进出，
 *      "当帧就对得上"不成立，会假 FAIL。
 *   ③ 没开「减少动态效果」（否则按设计整段跳过动画，★6 的 A/B 陷阱失效）。
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
    /* maxAnim = **刻度元素本身**在播动画的个数（必须恒 0：线与网格不许动）；
       maxLabelAnim / maxLabelMove = 刻度里那些 span（.tl__axis-label / .tl__axis-prev）在播动画的个数、
       以及它们的动画里出现过非 none 的 transform 的个数（判"只淡透明度、不做 scale"）。 */
    let maxAnim = 0, maxLabelAnim = 0, maxLabelMove = 0, frames = 0;
    /* 诊断读数（不是判据）：**(文字, left) 相同的对**才算"两把尺子叠在一起"；
       只比文字会误判 —— 月档标签就是 1月/2月…，跨年天然重复。 */
    let maxDupPair = 0, dupPairs = null;
    const labelsIn = (el) => [...el.querySelectorAll('.tl__axis-label, .tl__axis-prev')];
    const isTransparent = (el) => {
      const c = getComputedStyle(el).borderLeftColor || '';
      return c === 'transparent' || /rgba\\(0,\\s*0,\\s*0,\\s*0\\)/.test(c);
    };
    const sample = () => {
      frames++;
      const ks = kids();
      let anim = 0, labAnim = 0, labMove = 0;
      for (const el of ks) {
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
    /* ② 缩放扫过若干档位（交替方向）：每滚一格，**连续 400ms 每帧盯带 is-out 类的元素**
       —— 那就是"退场中的刻度"。判据不看集合差分（差分量到的大多是**没有文字的小刻度**：
       小刻度没有可淡的东西，一律当场摘掉、根本不进退场路径，实测 set-diff 读到 exitSeen 80 / exitHidden 0 全是它），
       而是直接量这条不变量：**任何时刻退场元素的线都是隐身的**（is-out + border 透明）。
       同时记"退场中的文字正在播动画"的峰值 —— 证明退场走的确实是"留一拍淡文字"。 */
    let outSeen = 0, outVisible = 0, outFading = 0, lingerUnhidden = 0, lingerAt = null, lingerSteps = 0;
    const pollOut = async (ms) => {
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        let seen = 0, vis = 0, fad = 0;
        for (const el of kids()) {
          if (!el.classList.contains('is-out')) continue;
          seen++;
          if (!isTransparent(el)) vis++;
          for (const s of labelsIn(el)) if (s.getAnimations && s.getAnimations().length) fad++;
        }
        if (seen > outSeen) outSeen = seen;
        if (fad > outFading) outFading = fad;
        if (vis > outVisible) {
          outVisible = vis;
          lingerAt = { vis: vis, at: Math.round(performance.now() - t0) };
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
    };
    for (const d of [-100, 100, -100, 100]) {
      for (let k = 1; k <= 5; k++) {
        wheel(d, true);
        sample();
        await pollOut(400);
        lingerSteps++;
      }
    }
    lingerUnhidden = outVisible;
    await new Promise((r) => setTimeout(r, 900));
    sample();
    /* 落定后不许留下任何"退场中"的残留（说明淡完就摘、没泄漏），也不许还有动画在跑 */
    const residualOut = kids().filter((el) => el.classList.contains('is-out')).length;
    const idleLabelAnim = kids().reduce((n, el) => n + labelsIn(el).filter((s) => s.getAnimations && s.getAnimations().length).length, 0);
    raf = false;
    sample();
    return {
      before: before.length, afterPan: afterPan.length, keep,
      maxAnim, maxLabelAnim, maxLabelMove, frames,
      outSeen, outFading, outVisible, lingerSteps, lingerAt, residualOut, idleLabelAnim,
      maxDupPair, dupPairs, totalKids: kids().length,
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

  /* ★2 **刻度元素本身（那根线）不许播动画**（用户 09-26 下午把"线 + 文字一起做"那版否掉了）：
     A/B 陷阱 = 09-26 上午那版给每个新/旧刻度元素挂 220ms 的 opacity+scale，采样必然读到非 0。 */
  check('★2 刻度元素本身（那根线）全程零动画（尺子纹丝不动；只有里面的文字可以淡，maxAnim === 0）',
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

  /* ★4 退场中的刻度**线当帧隐身**：文字可以留一拍淡出（`zoom.dur` 90~170ms），但那根线必须当帧透明
     ⇒ 屏上"看得见的线"任何时刻只有一套。A/B：09-26 上午那版新旧两套线一起淡出（用户：两个重叠的标尺）。
     ⚠️ 判据必须**直接盯 is-out 元素**（每帧采样），不能拿"500ms 前后的 DOM 集合差分"当退场集 ——
     差分量到的大多是没有文字的小刻度（它们没有可淡的东西、一律当场摘，根本不进退场路径：
     实测 set-diff 版读到 exitSeen 80 / exitHidden 0，全是它 ⇒ 假 FAIL）。 */
  check('★4 退场中的刻度线当帧隐身（is-out 元素的 border 任何时刻都不可见 ⇒ 看不到两套线）',
    report.lingerSteps > 0 && report.outVisible === 0 && report.maxDupPair === 0,
    { lingerSteps: report.lingerSteps, outSeen: report.outSeen, outFading: report.outFading, outVisible: report.outVisible, lingerAt: report.lingerAt, maxDupPair: report.maxDupPair, dupPairs: report.dupPairs });

  /* ★4b 淡完就摘：落定后不许留下"退场中"的残留、也不许还有动画在跑（否则就是泄漏 / 常驻空转）。 */
  check('★4b 退场元素淡完即摘（落定后无 .is-out 残留、无仍在跑的动画）',
    report.residualOut === 0 && report.idleLabelAnim === 0,
    { residualOut: report.residualOut, idleLabelAnim: report.idleLabelAnim, totalKids: report.totalKids });

  const errs = await ev(`window.__errs`);
  check('★5 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  /* ★6 用户 2026-09-26：「标尺上的文字能不能**随缩放比例**稍微做一点**不透明度**的出入场」——
     缩放/平移期间文字确实在淡（A/B 陷阱：09-26 下午"全撤"那版 maxLabelAnim === 0 ⇒ FAIL），
     **入场与退场两半都在跑**（`maxLabelAnim` = 新来的文字淡入 / `outFading` = 退场刻度上正在淡的文字），
     而且**只有 opacity**：任何一帧里出现过非 none 的 transform 就说明有人把 `scale()` 写回来了
     （那次用户报的「文字会闪一下」正是 9px 等宽字被缩放重新栅格化）。 */
  check('★6 缩放时标尺文字有透明度出入场（入 + 出两半），且只动 opacity（不做 scale）',
    report.maxLabelAnim >= 1 && report.outFading >= 1 && report.maxLabelMove === 0,
    { maxLabelAnim: report.maxLabelAnim, outFading: report.outFading, maxLabelMove: report.maxLabelMove, outSeen: report.outSeen });

  const pass = results.filter(Boolean).length;
  console.log(`\n==== ${pass}/${results.length} PASS ====`);
  w.close();
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
