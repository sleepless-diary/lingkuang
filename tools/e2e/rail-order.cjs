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
  const ready = await waitFor(async () => !!(await ev(`!!document.querySelector('#cx-rail [data-rail-toggle]') && document.querySelectorAll('#cx-rail .lk-rail__row.is-frame').length >= 2`)));
  check('★0b 帧条上有两格**有版本**的 + 顶上那格「初稿」', ready);

  /* 等工具打开的那两级错峰收干净（README 铁律 10：别在脏基线上断言） */
  const clean = await waitFor(async () => !(await ev(`document.querySelectorAll('#cx-root .lk-enter-stagger, #cx-list .lk-enter-stagger').length`)), 6000);
  check('★0c 基线干净（错峰类已收手）', clean);

  /* 开关本身：用户 2026-09-14「帧面板的展开和收起做成按钮放演化标题右边吧」——
     它原来在列表最底下（得滚到底才点得到），而且自己还在"等距"的列表里占一块。
     这里盯三件事：位置在标题那一行、是个按钮、列表里再没有那一行。 */
  const tglInfo = await ev(`(() => {
    const head = document.querySelector('#cx-rail .lk-rail__head');
    const t = document.querySelector('#cx-rail [data-rail-toggle]');
    const title = document.querySelector('#cx-rail .lk-rail__title');
    if (!head || !t) return { err: 'no toggle' };
    const rb = t.getBoundingClientRect(); const rTitle = title.getBoundingClientRect();
    return { tag: t.tagName, inHead: head.contains(t), text: t.textContent.trim(), title: t.title,
      rightOfTitle: rb.left >= rTitle.right - 1,
      /* 按钮与右边缘的模式胶囊不许叠、也不许被挤出行外 */
      railRight: Math.round(document.querySelector('#cx-rail').getBoundingClientRect().right),
      tglRight: Math.round(rb.right), headH: Math.round(head.getBoundingClientRect().height),
      inRows: !!document.querySelector('#cx-rail .lk-rail__rows [data-rail-toggle]'),
      oldRow: !!document.querySelector('#cx-rail .lk-rail__more') };
  })()`);
  check('★0d 展开/收起是**标题右边的一个按钮**（不再是列表底下那一行）',
    tglInfo.tag === 'BUTTON' && tglInfo.inHead && tglInfo.rightOfTitle && !tglInfo.inRows && !tglInfo.oldRow
      && tglInfo.tglRight <= tglInfo.railRight && tglInfo.headH <= 40, tglInfo);

  /* ── ① 展开：虚化行按"离最近的一版有多远"升序出现 ─────────────────────────── */
  const exp = await ev(`(() => {
    const tgl = document.querySelector('#cx-rail [data-rail-toggle]');
    if (!tgl) return { err: 'no toggle' };
    /* ⚠️ 铁律 14：点之前先读状态，别盲点（已有虚化行时点一下 = 收起） */
    if (document.querySelector('.lk-rail__rows .lk-rail__row.is-ghost')) return { err: 'already expanded' };
    const box = document.querySelector('.lk-rail__rows');
    const before = Math.round(box.getBoundingClientRect().height);
    /* ⚠️ 横向溢出必须在**点之前**读：点了之后 smoothBoxHeight 会往这个盒子写行内 overflow:hidden
       ⇒ 那一刻的 computed 值是行内的，问不出样式表里到底怎么写的（见 ★4d）。 */
    const ovx = getComputedStyle(box).overflowX;
    const pre = new Set([...document.querySelectorAll('.lk-rail__row')].map((r) => r.dataset.rail ?? ''));
    tgl.click();                                    /* 动画只在点下去那一 tick 抓得到 ⇒ 同一次 eval 里读 */
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
    /* 被**挤下去**的行（让位 / FLIP）：用户 2026-09-14「已有的帧节点的位置变化也要平滑」——
       帧条是个能滚的盒子，一次展开真能把下面的格子推下去几百像素，以前是瞬间跳的。
       只认"上下位移"的那种动画（transform 以 translateY 开头）；入场/退场那两批走的是 translateX。 */
    const moving = [...box2.querySelectorAll('.lk-rail__row')].flatMap((r) => r.getAnimations().map((a) => {
      const kf = a.effect.getKeyframes(); const t = a.effect.getTiming();
      return { id: r.dataset.rail || 'base', d: t.delay, dur: t.duration, fill: t.fill,
        tfFrom: kf[0].transform, tfTo: kf[kf.length - 1].transform };
    }).filter((x) => String(x.tfFrom).indexOf('translateY') === 0 || String(x.tfTo).indexOf('translateY') === 0));
    return { before, after: Math.round(box2.getBoundingClientRect().height), info, ovx, moving,
      /* 框"想要多高"：内容高度（scrollHeight，不含滚动条）与 max-height 里小的那个。
         ⚠️ 别用 getBoundingClientRect() 当自然高度 —— 入场行还在 translateX(32px) 上时，
         那个值会**多算一条横向滚动条**（见 ★4c）。 */
      boxScrollH: box2.scrollHeight, boxMaxH: parseFloat(getComputedStyle(box2).maxHeight) || Infinity,
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
  check('★1 展开时虚化行**逐行**出现（4 格 · 单行 200ms · 逐行晚 12ms）',
    (exp.info || []).length === 4 && JSON.stringify(delays(exp.info)) === JSON.stringify([0, 12, 24, 36])
      && (exp.info || []).every((x) => x.dur === 200), exp.info);
  check('★2 顺序 = **离最近的一版越近越先出现**（距离序列单调递增；种子两端都有版本 ⇒ 与 DOM 顺序不同）',
    JSON.stringify(byDelay(exp.info)) === JSON.stringify(['n-ro-2', 'n-ro-5', 'n-ro-3', 'n-ro-4'])
      && monotone(distSeq(exp.order, exp.info, 1), 1)
      && distSeq(exp.order, exp.info, 1)[0] < distSeq(exp.order, exp.info, 1).slice(-1)[0],
    { order: byDelay(exp.info), dist: distSeq(exp.order, exp.info, 1) });
  check('★3 入场 = **从右边滑进来**（`translateX(+32px)` → 原位），不是上下弹（用户 2026-09-14：「帧面板节点的出入场换成左右移动（就像正文面板一样）」）',
    (exp.info || []).length === 4 && (exp.info || []).every((x) => S(x.opFrom) === '0' && S(x.opTo) === '0.4')
      && (exp.info || []).every((x) => x.tfFrom === 'translateX(32px)' && x.tfTo === 'none'), (exp.info || []).map((x) => [S(x.opFrom), S(x.opTo)]));
  check('★3b 入场的 `start` 必须是 **0**（`rowsEnter` 默认是 `dur`，那是给"先出后进"的正文转场用的 —— 帧条只有入场，等一个 dur 才动就白等）',
    Math.min(...delays(exp.info)) === 0, delays(exp.info));
  check('★4 最外层那个框的高度**也演**，而且**晚一步**（delay > 0 · fill both 先冻在旧高度）',
    exp.boxAnimN === 1 && exp.boxDelay > 0 && exp.boxFill === 'both'
      && Math.abs(parseFloat(exp.boxFrom) - exp.before) <= 2 && parseFloat(exp.boxTo) > exp.before + 40,
    { before: exp.before, boxFrom: exp.boxFrom, boxTo: exp.boxTo, boxDelay: exp.boxDelay, boxDur: exp.boxDur });
  check('★4b 展开的那一 tick 里框还没长高（冻在旧高度上，尺寸靠动画给）', exp.after === exp.before, { before: exp.before, after: exp.after });
  /* ⚠️ 用户 2026-09-14：「**展开后外面的框高度会闪**」—— 根因就是这一条盯的东西：
     量目标高度那一刻，入场行还在 `translateX(32px)` 上（位移会撑出**横向**可滚动溢出）
     ⇒ `overflow:auto` 的盒子当场长出一条 15px 的横向滚动条 ⇒ 动画终点 = 内容 + 滚动条；
     等行们落定、滚动条一走，框就"闪"矮一下（修前实测终点 363.333px vs 自然 348px）。 */
  check('★4c 框的动画终点 = **它真正想要的高度**（不含滚动条；否则演完会闪一下）',
    Math.abs(parseFloat(exp.boxTo) - Math.min(exp.boxScrollH, exp.boxMaxH)) <= 1.5,
    { boxTo: exp.boxTo, scrollH: exp.boxScrollH, maxH: exp.boxMaxH });
  check('★4d 帧条滚动盒**不许出现横向滚动条**（`overflow-x: hidden` —— 入场行的位移会撑出横向溢出）',
    exp.ovx === 'hidden', { overflowX: exp.ovx });
  /* 展开时**被挤下去**的那一格（`n-ro-6` 是有版本的最后一行，四个虚化行插在它前面 ⇒ 它要往下让 4 格）
     ⚠️ 展开这条路上让位是**立刻**的（`rowDelay: 0`）：虚化行从右边滑进来、下面的格子同时被推下去。 */
  check('★4e 展开时被挤下去的行**当下就让位**（FLIP：`translateY(-184px)` → 原位 · delay 0 · 一行的位移 = 4 格 × 46px）',
    exp.moving.length === 1 && exp.moving[0].id === 'n-ro-6' && exp.moving[0].d === 0
      && /^translateY\(-18[0-9](\.\d+)?px\)$/.test(String(exp.moving[0].tfFrom)) && exp.moving[0].tfTo === 'none',
    exp.moving);

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
    const tgl = document.querySelector('#cx-rail [data-rail-toggle]');
    if (!tgl) return { err: 'no toggle' };
    if (!document.querySelector('.lk-rail__rows .lk-rail__row.is-ghost')) return { err: 'not expanded' };
    const boxBefore = Math.round(document.querySelector('.lk-rail__rows').getBoundingClientRect().height);
    /* ⚠️ 距离必须在**点击之前**算：收起之后那些虚化行就不在 DOM 里了（只活在裁切层的克隆里） */
    const orderPre = [...document.querySelectorAll('.lk-rail__row')].map((r) => ({ id: r.dataset.rail || 'base',
      frame: r.classList.contains('is-frame'), base: r.classList.contains('lk-rail__row--base'), ghost: r.classList.contains('is-ghost') }));
    const pre = new Set([...document.querySelectorAll('.lk-ghost-layer')]);
    tgl.click();
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
    /* 被**抽上来**的行（让位 / FLIP）：与展开那条路同一件事，只是这次要**等虚化行退完**才动
       （rowDelay = 退场总时长）—— 否则虚化行还没淡走、下面的格子已经补上来，同一处两份内容。 */
    const moving = [...box2.querySelectorAll('.lk-rail__row')].flatMap((r) => r.getAnimations().map((a) => {
      const kf = a.effect.getKeyframes(); const t = a.effect.getTiming();
      return { id: r.dataset.rail || 'base', d: t.delay, dur: t.duration, fill: t.fill,
        tfFrom: kf[0].transform, tfTo: kf[kf.length - 1].transform };
    }).filter((x) => String(x.tfFrom).indexOf('translateY') === 0 || String(x.tfTo).indexOf('translateY') === 0));
    const allAnims = [...box2.querySelectorAll('.lk-rail__row')].flatMap((r) => r.getAnimations().map((a) => {
      const kf = a.effect.getKeyframes(); const t = a.effect.getTiming();
      return { id: r.dataset.rail || 'base', d: t.delay, tfFrom: kf[0].transform };
    }));
    return { boxBefore, boxAfter: Math.round(box2.getBoundingClientRect().height), moving, allAnims,
      rowsNow: [...box2.querySelectorAll('.lk-rail__row')].map((r) => r.dataset.cxKey || '?'),
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
      && JSON.stringify(delays(col.info)) === JSON.stringify([0, 12, 24, 36])
      && monotone(distSeq(col.order, col.info, -1), -1)
      && distSeq(col.order, col.info, -1)[0] > distSeq(col.order, col.info, -1).slice(-1)[0],
    { order: byDelay(col.info), dist: distSeq(col.order, col.info, -1) });
  check('★8 退场 = **往左滑走**（不透明度起点 0.4；`translateX(-32px)` 收尾 —— 与入场同一根轴，方向相反）',
    (col.info || []).length === 4 && (col.info || []).every((x) => S(x.opFrom) === '0.4' && S(x.opTo) === '0')
      && (col.info || []).every((x) => x.tfTo === 'translateX(-32px)'), (col.info || []).map((x) => [S(x.opFrom), S(x.opTo)]));
  check('★9 裁切层**停在旧高度**（否则退场中的虚化行会被裁没）· 而框的目标高度已经变矮了',
    Math.abs((col.layerH ?? 0) - col.boxBefore) <= 2 && parseFloat(col.boxTo) < col.boxBefore - 40
      && col.boxAnimN === 1 && col.boxDelay > 0 && col.boxFill === 'both'
      && Math.abs(parseFloat(col.boxFrom) - col.boxBefore) <= 2,
    { boxBefore: col.boxBefore, boxFrom: col.boxFrom, boxTo: col.boxTo, layerH: col.layerH, layerStyleH: col.layerStyleH, boxDelay: col.boxDelay });

  /* ⚠️ 用户 2026-09-14：「**收起时节点要先出场，外面的框再收起**」——
     原来框是"退场走到六成就开始缩"（`× 0.6` = 142ms），缩下去的那一段里行还没走完，
     看上去像框把行啃掉半截。现在必须**等最后一行走完**（单行 dur + 最大 delay）才动。 */
  check('★9b 收框**等退场全走完**才开始（delay ≥ 最后一行的 `delay + dur`）',
    col.boxDelay >= Math.max(...(col.info || []).map((x) => x.d + x.dur)) && col.boxDelay > 0,
    { boxDelay: col.boxDelay, exitEnd: Math.max(...(col.info || []).map((x) => x.d + x.dur)) });
  /* 收起时**被抽上来**的那一格（`n-ro-6`）：它下面没有别的格子了，四个虚化行的位置空出来 ⇒ 它往上补 4 格。
     ⚠️ 与展开那侧最大的不同：**等退场走完才动**（`rowDelay` = 退场总时长 = 236ms）。 */
  check('★9c 收起时被抽上来的行**等虚化行退完**才补位（`translateY(+184px)` → 原位 · delay = 退场总时长）',
    col.moving.length === 1 && col.moving[0].id === 'n-ro-6' && col.moving[0].d === col.boxDelay
      && /^translateY\(18[0-9](\.\d+)?px\)$/.test(String(col.moving[0].tfFrom)) && col.moving[0].tfTo === 'none',
    { moving: col.moving, allAnims: col.allAnims, rowsNow: col.rowsNow, boxDelay: col.boxDelay });

  const gone = await waitFor(async () => await ev(`document.querySelectorAll('.lk-ghost-layer').length === 0`), 4000);
  const cleanBox = await waitFor(async () => await ev(`document.querySelector('.lk-rail__rows').getAnimations().length === 0`), 6000);
  const after = await ev(`(() => { const b = document.querySelector('.lk-rail__rows');
    return { h: Math.round(b.getBoundingClientRect().height), styleH: b.style.height, anims: b.getAnimations().length,
      ghosts: document.querySelectorAll('.lk-rail__rows .lk-rail__row.is-ghost').length,
      frames: document.querySelectorAll('#cx-rail .lk-rail__row.is-frame').length }; })()`);
  check('★10 演完就收干净：裁切层摘掉、帧条只剩「初稿 + 两格有版本」、框缩回展开前的高度',
    gone && cleanBox && after.ghosts === 0 && after.frames === 2 && after.styleH === '' && after.anims === 0
      && Math.abs(after.h - exp.before) <= 2, { gone, cleanBox, after, expBefore: exp.before });

  /* ── ③ 「记一帧」那条路：新格子入场 + 已有的格子让位 + 整条时间线高度一起演 ────────────
     用户 2026-09-14 深夜：「**已有的帧节点的位置变化也要平滑，时间线长度也一样**」——
     这条路上以前三件事全是瞬间跳的（只有"展开/收起"那条路在演）。
     先通过底部「记到」下拉把锚点换成一个**还没有版本**的节点（`n-ro-2`），再点「＋ 记一帧」：
     它会成为新的一格 ⇒ 它入场、它下面的 `n-ro-6` 让位、框长高 —— 三件事都要有动画。 */
  const addFrame = await ev(`(async () => {
    const sel = document.querySelector('#cx-rail #cx-anchor');
    if (!sel) return { err: 'no anchor' };
    const before = Math.round(document.querySelector('.lk-rail__rows').getBoundingClientRect().height);
    const pre = new Set([...document.querySelectorAll('.lk-rail__rows .lk-rail__row')].map((r) => r.dataset.cxKey || ''));
    sel.value = 'n-ro-2';                                   /* 还没版本的事件 */
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    /* ⚠️ 换锚点会**重画**帧条（innerHTML 换掉）⇒ 按钮必须**重新查**：换之前抓到的那个已经脱离文档，
       点它什么都不发生（第一版就是这么白点的：frames 一直是 2）。 */
    const add = document.querySelector('#cx-rail [data-rail-add]');
    if (!add) return { err: 'no add button' };
    add.click();
    /* 这一路的动画可能在 store 通知之后的几个微任务/定时器里才挂上 ⇒ 给一小段时间再读。
       （隐藏窗口里动画**不推进**，所以等几百毫秒读到的是"定格的起点参数"，不是演完的终态） */
    await new Promise((r) => setTimeout(r, 260));
    const box = document.querySelector('.lk-rail__rows');
    const rows = [...box.querySelectorAll('.lk-rail__row')];
    const anims = rows.flatMap((r) => r.getAnimations().map((a) => {
      const kf = a.effect.getKeyframes(); const t = a.effect.getTiming();
      return { id: r.dataset.rail || 'base', d: t.delay, dur: t.duration,
        tfFrom: kf[0].transform, tfTo: kf[kf.length - 1].transform };
    }));
    const ba = box.getAnimations(); const bt = ba[0] ? ba[0].effect.getTiming() : null; const bk = ba[0] ? ba[0].effect.getKeyframes() : null;
    return { before, after: Math.round(box.getBoundingClientRect().height), pre: [...pre],
      fresh: rows.filter((r) => !pre.has(r.dataset.cxKey || '')).map((r) => r.dataset.rail),
      anims, boxAnimN: ba.length, boxDelay: bt ? bt.delay : null, boxFill: bt ? bt.fill : null,
      boxFrom: bk ? bk[0].height : null, boxTo: bk ? bk[bk.length - 1].height : null,
      frames: document.querySelectorAll('#cx-rail .lk-rail__row.is-frame').length };
  })()`);
  const enterAnim = (addFrame.anims || []).find((x) => x.id === 'n-ro-2' && String(x.tfFrom).indexOf('translateX') === 0);
  const shiftAnim = (addFrame.anims || []).find((x) => x.id === 'n-ro-6' && String(x.tfFrom).indexOf('translateY') === 0);
  check('★10b 记一帧：**新格子从右边滑进来**（`translateX(32px)` → 原位，与展开时那批虚化行同一套姿势）',
    !!enterAnim && enterAnim.tfTo === 'none' && addFrame.fresh.includes('n-ro-2'), addFrame);
  check('★10c 记一帧：**它下面的格子让位**（FLIP `translateY(-46px)` → 原位 · delay 0 —— 一行 = 一格 46px）',
    !!shiftAnim && shiftAnim.d === 0 && shiftAnim.tfFrom === 'translateY(-46px)' && shiftAnim.tfTo === 'none', shiftAnim);
  check('★10d 记一帧：**整条时间线的高度也演**（框从旧高度长一格，不再是瞬间跳）',
    addFrame.boxAnimN >= 1 && Math.abs(parseFloat(addFrame.boxFrom) - addFrame.before) <= 2
      && parseFloat(addFrame.boxTo) > addFrame.before + 30 && addFrame.frames === 3,
    { before: addFrame.before, after: addFrame.after, boxFrom: addFrame.boxFrom, boxTo: addFrame.boxTo, frames: addFrame.frames });

  const errs = await ev(`JSON.stringify(window.__errs)`);
  check('★11 全程没有未捕获异常', errs === '[]', errs);

  const passed = results.filter(Boolean).length;
  console.log(`\n==== ${passed}/${results.length} ====`);
  w.close();
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
