/* 不变量：帧条（演变）**展开/收起时的错峰顺序**与"最外面那个框"的高度切换时机。
 *
 * 用户 2026-09-14 的原话（三条一次说完）：
 *   「文件夹收起后其下文件上移错分方向反了，应该是**越高的越先移**，现在是越下面的越先移」← 见 codex-list-motion.cjs
 *   「展开帧面板时文字会先正常显示（100 不透明度），然后再虚化」
 *   「我希望展开面板时，也有错分，**离已有帧节点越近的节点越先出现**，出场也是一样，
 *     **离已有帧越远的帧越先退场**，最后再**平滑切换最外层框的高度**」
 *
 * 本套件盯后者那三条（都在 `src/ui/evolution-rail.ts` + `src/ui/motion.ts`）：
 *   ① 入场：虚化行按"离最近的一版隔了几行"升序出现（近的先动）；
 *   ② 退场：同一个序列**倒过来**（远的先走）；
 *   ③ 两种动画的**不透明度终点/起点 = 这一行自己该有的值**（虚化行是 0.4，不是 1）——
 *      写死 1 就会出现"先全亮、再落回半透明"的那一下闪；
 *   ④ `.lk-rail__rows`（最外层那个框）的高度变化**带延迟**（`fill:'both'` 先冻在旧高度），
 *      行先动、框后缩/后长。
 *
 * 用法：`node tools/e2e/seed-rail-order.cjs` → 起应用 →
 *       `LK_CDP_PORT=NNNN node tools/e2e/rail-order.cjs`
 *      （测试目录：一份自己的干净目录，别和别的套件共用 —— 帧分布就是本套件的被测对象；
 *        数据自足，见 seed 脚本头部注释） */
const PORT = process.env.LK_CDP_PORT || '9334';
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
  const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(250); } return false; };

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej:' + String(e.reason))); true`);
  /* 自足：复位设置（手动模式 + 无锁定），别吃上一轮套件留下的 localStorage */
  await ev(`(() => { const k='lingkuang-settings'; let s={}; try { s = JSON.parse(localStorage.getItem(k)||'{}'); } catch {} s.evolveMode='manual'; s.evolveLock=null; localStorage.setItem(k, JSON.stringify(s)); return true; })()`);
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  const up = await waitFor(async () => !!(await ev(`!!document.querySelector('#cx-list .ed-tnode-item[data-act="entity"]')`)));
  check('★0 工作台起来了（左树有实体行）', up);

  /* 选中那条设定 —— 帧条只在实体态出现 */
  await ev(`(() => { const r = document.querySelector('#cx-list .ed-tnode-item[data-act="entity"]'); if (r) r.click(); return !!r; })()`);
  const ready = await waitFor(async () => !!(await ev(`!!document.querySelector('.lk-rail__more') && document.querySelectorAll('#cx-rail .lk-rail__row.is-frame').length >= 2`)));
  check('★0b 帧条上有两格**有版本**的 + 顶上那格「初稿」', ready);

  /* 等工具打开的那两级错峰收干净（README 铁律 10：别在脏基线上断言） */
  const clean = await waitFor(async () => !(await ev(`document.querySelectorAll('#cx-root .lk-enter-stagger, #cx-list .lk-enter-stagger').length`)), 6000);
  check('★0c 基线干净（错峰类已收手）', clean);

  /* ── ① 展开：虚化行按"离最近的一版有多远"升序出现 ─────────────────────────── */
  const exp = await ev(`(() => {
    const more = document.querySelector('.lk-rail__more');
    if (!more) return { err: 'no more row' };
    /* ⚠️ 铁律 14：点之前先读状态，别盲点（已有虚化行时点一下 = 收起） */
    if (document.querySelector('.lk-rail__rows .lk-rail__row.is-ghost')) return { err: 'already expanded' };
    const box = document.querySelector('.lk-rail__rows');
    const before = Math.round(box.getBoundingClientRect().height);
    const pre = new Set([...document.querySelectorAll('.lk-rail__row')].map((r) => r.dataset.rail ?? ''));
    more.click();                                   /* 动画只在点下去那一 tick 抓得到 ⇒ 同一次 eval 里读 */
    const fresh = [...document.querySelectorAll('.lk-rail__row')].filter((r) => !pre.has(r.dataset.rail ?? ''));
    const info = fresh.map((r) => {
      const a = r.getAnimations()[0];
      const kf = a ? a.effect.getKeyframes() : null; const t = a ? a.effect.getTiming() : null;
      return { id: r.dataset.rail, d: t ? t.delay : null, dur: t ? t.duration : null,
        opFrom: kf ? kf[0].opacity : null, opTo: kf ? kf[kf.length - 1].opacity : null,
        tfFrom: kf ? kf[0].transform : null, tfTo: kf ? kf[kf.length - 1].transform : null };
    });
    const box2 = document.querySelector('.lk-rail__rows');
    const ba = box2.getAnimations();
    const bt = ba[0] ? ba[0].effect.getTiming() : null; const bk = ba[0] ? ba[0].effect.getKeyframes() : null;
    return { before, after: Math.round(box2.getBoundingClientRect().height), info,
      boxAnimN: ba.length, boxDelay: bt ? bt.delay : null, boxFill: bt ? bt.fill : null, boxDur: bt ? bt.duration : null,
      boxFrom: bk ? bk[0].height : null, boxTo: bk ? bk[bk.length - 1].height : null,
      order: [...document.querySelectorAll('.lk-rail__row')].map((r) => ({ id: r.dataset.rail || 'base',
        frame: r.classList.contains('is-frame'), base: r.classList.contains('lk-rail__row--base'), ghost: r.classList.contains('is-ghost') })) };
  })()`);
  const byDelay = (info) => (info || []).slice().sort((a, b) => a.d - b.d).map((x) => x.id);
  const delays = (info) => (info || []).slice().sort((a, b) => a.d - b.d).map((x) => x.d);
  /* 「离最近的一版隔了几行」——**从 DOM 现算**（帧条是等距的，行号差就是距离）。
     不写死数字：种子的行数/哪两格有版本改了，这里也不会跟着错（第一版就是写死算错了）。
     锚点 = 有版本的行 + 顶上永远的「初稿」。 */
  const distOf = (order, id) => {
    const anchors = order.map((r, i) => (r.frame || r.base ? i : -1)).filter((i) => i >= 0);
    const i = order.findIndex((r) => r.id === id);
    return i < 0 || !anchors.length ? 0 : Math.min(...anchors.map((j) => Math.abs(i - j)));
  };
  /** 按延迟升序取出各行的"距离"序列，断言它**单调**（入场递增 = 近的先；出场递减 = 远的先） */
  const distSeq = (order, info, dir) => (info || []).slice().sort((a, b) => a.d - b.d).map((x) => distOf(order, x.id));
  const monotone = (xs, dir) => xs.every((v, i) => i === 0 || (dir > 0 ? v >= xs[i - 1] : v <= xs[i - 1]));
  /* ⚠️ 铁律 15：WAAPI 关键帧里的数值**可能是字符串也可能是数字**（同一个 `{opacity: 0}` 在不同
     属性上读出来不一样）⇒ 一律 `String()` 之后比。 */
  const S = (v) => String(v);
  check('★1 展开时虚化行**逐行**出现（4 格 · 单行 180ms · 逐行晚 14ms）',
    (exp.info || []).length === 4 && JSON.stringify(delays(exp.info)) === JSON.stringify([0, 14, 28, 42])
      && (exp.info || []).every((x) => x.dur === 180), exp.info);
  check('★2 顺序 = **离最近的一版越近越先出现**（距离序列单调递增；种子两端都有版本 ⇒ 与 DOM 顺序不同）',
    JSON.stringify(byDelay(exp.info)) === JSON.stringify(['n-ro-2', 'n-ro-5', 'n-ro-3', 'n-ro-4'])
      && monotone(distSeq(exp.order, exp.info, 1), 1)
      && distSeq(exp.order, exp.info, 1)[0] < distSeq(exp.order, exp.info, 1).slice(-1)[0],
    { order: byDelay(exp.info), dist: distSeq(exp.order, exp.info, 1) });
  check('★3 入场**不许亮到 100%**：不透明度 0 → 这一行自己该有的 0.4（否则会先亮一下再变虚）',
    (exp.info || []).length === 4 && (exp.info || []).every((x) => S(x.opFrom) === '0' && S(x.opTo) === '0.4')
      && (exp.info || []).every((x) => x.tfFrom === 'translateY(-8px)' && x.tfTo === 'none'), (exp.info || []).map((x) => [S(x.opFrom), S(x.opTo)]));
  check('★4 最外层那个框的高度**也演**，而且**晚一步**（delay > 0 · fill both 先冻在旧高度）',
    exp.boxAnimN === 1 && exp.boxDelay > 0 && exp.boxFill === 'both'
      && Math.abs(parseFloat(exp.boxFrom) - exp.before) <= 2 && parseFloat(exp.boxTo) > exp.before + 40,
    { before: exp.before, boxFrom: exp.boxFrom, boxTo: exp.boxTo, boxDelay: exp.boxDelay, boxDur: exp.boxDur });
  check('★4b 展开的那一 tick 里框还没长高（冻在旧高度上，尺寸靠动画给）', exp.after === exp.before, { before: exp.before, after: exp.after });

  /* 收干净：等动画走完，框落回自然高度。
     ⚠️ 铁律 19：**轮询**，别固定 sleep —— 隐藏窗口里定时器会被合并到秒级，
     兜底回调（`dur + delay + 400`）实测要 1s 以上才轮到。 */
  const settledOk = await waitFor(async () => await ev(`(() => { const b = document.querySelector('.lk-rail__rows');
    return b.getAnimations().length === 0 && b.style.height === '' && b.style.overflow === ''; })()`), 6000);
  const settled = await ev(`(() => { const b = document.querySelector('.lk-rail__rows'); return { h: Math.round(b.getBoundingClientRect().height), styleH: b.style.height, anims: b.getAnimations().length, ovf: b.style.overflow }; })()`);
  check('★5 演完之后：框回到自然高度、行内高度/裁剪都还回去、不留动画',
    settledOk && settled.h > exp.before + 40 && settled.styleH === '' && settled.anims === 0 && settled.ovf === '', settled);

  /* ── ② 收起：同一个序列倒过来（越远的越先退场）──────────────────────────── */
  const col = await ev(`(() => {
    const more = document.querySelector('.lk-rail__more');
    if (!more) return { err: 'no more row' };
    if (!document.querySelector('.lk-rail__rows .lk-rail__row.is-ghost')) return { err: 'not expanded' };
    const boxBefore = Math.round(document.querySelector('.lk-rail__rows').getBoundingClientRect().height);
    /* ⚠️ 距离必须在**点击之前**算：收起之后那些虚化行就不在 DOM 里了（只活在裁切层的克隆里） */
    const orderPre = [...document.querySelectorAll('.lk-rail__row')].map((r) => ({ id: r.dataset.rail || 'base',
      frame: r.classList.contains('is-frame'), base: r.classList.contains('lk-rail__row--base'), ghost: r.classList.contains('is-ghost') }));
    const pre = new Set([...document.querySelectorAll('.lk-ghost-layer')]);
    more.click();
    const layers = [...document.querySelectorAll('.lk-ghost-layer')].filter((l) => !pre.has(l));
    const lay = layers[layers.length - 1];
    const ghosts = lay ? [...lay.querySelectorAll('.lk-list-ghost')] : [];
    const info = ghosts.map((g) => {
      const a = g.getAnimations()[0];
      const kf = a ? a.effect.getKeyframes() : null; const t = a ? a.effect.getTiming() : null;
      return { id: g.dataset.rail, d: t ? t.delay : null, dur: t ? t.duration : null,
        opFrom: kf ? kf[0].opacity : null, opTo: kf ? kf[kf.length - 1].opacity : null, tfTo: kf ? kf[kf.length - 1].transform : null };
    });
    const box2 = document.querySelector('.lk-rail__rows');
    const ba = box2.getAnimations(); const bt = ba[0] ? ba[0].effect.getTiming() : null; const bk = ba[0] ? ba[0].effect.getKeyframes() : null;
    return { boxBefore, boxAfter: Math.round(box2.getBoundingClientRect().height),
      layerN: layers.length, layerOvf: lay ? getComputedStyle(lay).overflow : null,
      layerH: lay ? Math.round(lay.getBoundingClientRect().height) : null,
      /* ⚠️ 隐藏窗口里动画不推进（铁律 6）⇒ 层的高度只能看**目标值**（行内写死的那个） */
      layerStyleH: lay ? lay.style.height : null,
      rows: document.querySelectorAll('.lk-rail__rows .lk-rail__row').length,
      info, boxAnimN: ba.length, boxDelay: bt ? bt.delay : null, boxFill: bt ? bt.fill : null,
      boxFrom: bk ? bk[0].height : null, boxTo: bk ? bk[bk.length - 1].height : null,
      boxStyleH: box2.style.height, order: orderPre };
  })()`);
  check('★6 收起时那 4 格先化成幽灵（住在贴着帧条滚动盒的裁切层里）当场从帧条上消失',
    col.layerN === 1 && (col.info || []).length === 4 && col.rows === 3 && col.layerOvf === 'hidden',
    { layerN: col.layerN, ghosts: (col.info || []).length, rows: col.rows });
  check('★7 退场顺序 = 入场的**倒过来**（离最近的一版越远越先走；距离序列单调递减）',
    JSON.stringify(byDelay(col.info)) === JSON.stringify(['n-ro-3', 'n-ro-4', 'n-ro-2', 'n-ro-5'])
      && JSON.stringify(delays(col.info)) === JSON.stringify([0, 14, 28, 42])
      && monotone(distSeq(col.order, col.info, -1), -1)
      && distSeq(col.order, col.info, -1)[0] > distSeq(col.order, col.info, -1).slice(-1)[0],
    { order: byDelay(col.info), dist: distSeq(col.order, col.info, -1) });
  check('★8 退场**不透明度起点 = 0.4**（不是 1 —— 写死 1 就是"先正常显示、再虚化"的那一下闪）',
    (col.info || []).length === 4 && (col.info || []).every((x) => S(x.opFrom) === '0.4' && S(x.opTo) === '0')
      && (col.info || []).every((x) => x.tfTo === 'translateY(-8px)'), (col.info || []).map((x) => [S(x.opFrom), S(x.opTo)]));
  check('★9 裁切层**停在旧高度**（否则退场中的虚化行会被裁没）· 而框的目标高度已经变矮了',
    Math.abs((col.layerH ?? 0) - col.boxBefore) <= 2 && parseFloat(col.boxTo) < col.boxBefore - 40
      && col.boxAnimN === 1 && col.boxDelay > 0 && col.boxFill === 'both'
      && Math.abs(parseFloat(col.boxFrom) - col.boxBefore) <= 2,
    { boxBefore: col.boxBefore, boxFrom: col.boxFrom, boxTo: col.boxTo, layerH: col.layerH, layerStyleH: col.layerStyleH, boxDelay: col.boxDelay });

  const gone = await waitFor(async () => await ev(`document.querySelectorAll('.lk-ghost-layer').length === 0`), 4000);
  const cleanBox = await waitFor(async () => await ev(`document.querySelector('.lk-rail__rows').getAnimations().length === 0`), 6000);
  const after = await ev(`(() => { const b = document.querySelector('.lk-rail__rows');
    return { h: Math.round(b.getBoundingClientRect().height), styleH: b.style.height, anims: b.getAnimations().length,
      ghosts: document.querySelectorAll('.lk-rail__rows .lk-rail__row.is-ghost').length,
      frames: document.querySelectorAll('#cx-rail .lk-rail__row.is-frame').length }; })()`);
  check('★10 演完就收干净：裁切层摘掉、帧条只剩「初稿 + 两格有版本」、框缩回展开前的高度',
    gone && cleanBox && after.ghosts === 0 && after.frames === 2 && after.styleH === '' && after.anims === 0
      && Math.abs(after.h - exp.before) <= 2, { gone, cleanBox, after, expBefore: exp.before });

  const errs = await ev(`JSON.stringify(window.__errs)`);
  check('★11 全程没有未捕获异常', errs === '[]', errs);

  const passed = results.filter(Boolean).length;
  console.log(`\n==== ${passed}/${results.length} ====`);
  w.close();
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
