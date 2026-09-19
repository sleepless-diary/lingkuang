/* 不变量：**世界沙盘的标尺刻度和时间绑定，不随平移变**。
 *
 * 用户 2026-09-18 实测：「时间线上的标尺，问题很大，**标尺会随着左右移动改变显示的数字**」。
 * 病根：`src/ui/timeline.ts` 的 `renderScale()` 年档用 `start + i * stepSec` 推进，
 * 而 `stepSec = n × 365.25 天` ⇒ 每加一格就漂一点（漂出 1月1日），于是**同一个视觉位置**
 * 在不同平移量下被算成不同年份。现在主刻度逐个走历法（年档按整年进位、月档按月进位、
 * 日档按天进位、时/分走均匀秒网格），小刻度改在相邻主刻度之间等分。
 *
 * ⚠️ 本套件**不依赖「怎么拖动画布」的实现细节**：它只断言「标签与时间的绑定性」
 * （年份等差、像素间距相等、平移前后同一标签跟着整体位移）。
 *
 * 用法：起干净实例（reset-entity-vault + seed-node，端口 9346），
 *   LK_CDP_PORT=9346 node tools/e2e/timeline-scale.cjs
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
  /** 主刻度：[{label, x}]（x 用 left 像素，和 DOM 里写的一致） */
  const ticksExpr = `[...document.querySelectorAll('#lk-pane-timeline .tl__axis-tick--major')].map((el) => ({ label: el.querySelector('.tl__axis-label')?.textContent ?? '', x: Math.round(parseFloat(el.style.left) || 0) })).filter((t) => t.label)`;

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`);
  for (let i = 0; i < 20; i++) { if (await ev(`document.querySelectorAll('#lk-pane-timeline .tl__axis-tick--major').length > 0`)) break; await sleep(300); }

  /** 等刻度稳定下来（两次读数一致）——平滑视图的断言不能在固定 sleep 上做 */
  const stableTicks = async (ms = 4000) => {
    let prev = null;
    const t0 = Date.now();
    for (;;) {
      const cur = await ev(ticksExpr);
      const sig = JSON.stringify(cur.map((k) => k.label + '@' + k.x));
      if (prev === sig) return cur;
      prev = sig;
      if (Date.now() - t0 > ms) return cur;
      await sleep(150);
    }
  };

  const before = await stableTicks();
  check('★0 前置：世界沙盘的标尺上有主刻度（带文字）', Array.isArray(before) && before.length >= 2, { n: before?.length, first3: before?.slice(0, 3) });

  /* ── ①a ⭐ 标尺与节点必须对得上（用户 2026-09-18：「现在标尺应该和节点能对上了吧」）——
     节点和刻度都走同一个 timeToX()，所以「节点所在年份那根刻度」应当与节点 x 重合。
     ⚠️ 节点 DOM 里没有年份，所以这里用夹具约定：tools/e2e/seed-node.cjs 播种的事件在 312 年。 ── */
  const SEED_NODE_YEAR = 312;
  const align = await ev(`(() => {
    const n = document.querySelector('#lk-pane-timeline .tl__n[data-id]');
    if (!n) return { has: false };
    const nx = Math.round(parseFloat(n.style.left) || 0);
    const ticks = [...document.querySelectorAll('#lk-pane-timeline .tl__axis-tick--major')];
    const hit = ticks.find((el) => (el.querySelector('.tl__axis-label')?.textContent ?? '') === '${SEED_NODE_YEAR}年');
    return { has: true, node: nx, tick: hit ? Math.round(parseFloat(hit.style.left) || 0) : null, d: hit ? Math.abs(Math.round(parseFloat(hit.style.left) || 0) - nx) : null };
  })()`);
  check('★0b 标尺刻度与节点对得上（' + SEED_NODE_YEAR + ' 年那根刻度的 x ≈ 节点 x，±1px）',
    align.has === true && align.d !== null && align.d <= 1, align);
  /* ── ① 年档：标签里的年份必须**等差**（旧代码每格漂 0.25 天，累起来就跳年） ── */
  const years = before.map((t) => { const m = /^(-?\d+)年$/.exec(t.label); return m ? Number(m[1]) : null; });
  const allYear = years.every((y) => y !== null);
  const diffs = [];
  for (let i = 1; i < years.length; i++) if (years[i] !== null && years[i - 1] !== null) diffs.push(years[i] - years[i - 1]);
  const uniq = [...new Set(diffs)];
  check('★1 年档刻度的年份是等差（同一个步长，不跳年）', allYear === false ? false : uniq.length === 1 && uniq[0] > 0, { years, diffs, uniq });

  /* ── ①b ⭐ 用户的原话：「省略的区域不固定，有时候是 182 有时候变成 186」——
     刻度网格必须锚在**全局原点**上，相位只由 step 决定；旧代码锚在视窗左边缘，平移一格相位就翻。 ── */
  const step = uniq.length === 1 ? uniq[0] : 0;
  const phaseOk = step > 0 && years.every((y) => y !== null && ((y % step) + step) % step === 0);
  check('★1b 刻度落在全局网格上（年份 ≡ 0 mod 步长）—— 省略的年份不该随平移/视窗改变',
    phaseOk, { step, years, phases: years.map((y) => (y === null ? null : ((y % step) + step) % step)) });
  /* ── ② 像素上也要等距（历法进位正确 ⇒ 整年之间是等宽的） ── */
  const gaps = [];
  for (let i = 1; i < before.length; i++) gaps.push(before[i].x - before[i - 1].x);
  const gapSpread = gaps.length ? Math.max(...gaps) - Math.min(...gaps) : 0;
  check('★2 主刻度在像素上等距（间距浮动 ≤ 2px）', gaps.length >= 1 && gapSpread <= 2, { gaps, gapSpread });

  /* ── ①c ⭐ 用户 2026-09-18：「**缩放时标尺会左右横移**，应该是标尺缩放的中点和缓动中点不一致」——
     缩放必须**钉住鼠标下那一刻的时间**：小步缩放（3 格，仍在年档）前后，anchorX 处插值出的年份不许变。 ── */
  const anchorYear = (ticks, x) => {
    const pts = ticks
      .map((k) => ({ y: Number((k.label.match(/^(-?\d+)年$/) || [])[1]), x: k.x }))
      .filter((q) => Number.isFinite(q.y))
      .sort((a2, b2) => a2.x - b2.x);
    for (let i = 1; i < pts.length; i++) {
      if (x >= pts[i - 1].x && x <= pts[i].x) {
        const r = (x - pts[i - 1].x) / ((pts[i].x - pts[i - 1].x) || 1);
        return pts[i - 1].y + (pts[i].y - pts[i - 1].y) * r;
      }
    }
    return null;
  };
  const ANCHOR_X = 300;                    /* 锚点：wrap 左边向右 300px 处 */
  const y0 = anchorYear(before, ANCHOR_X);
  await ev(`(() => {
    for (let i = 0; i < 3; i++) {
      const el = document.querySelector('#lk-pane-timeline .tl-wrap') || document.querySelector('#lk-pane-timeline');
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, altKey: true, clientX: r.left + ${ANCHOR_X}, bubbles: true, cancelable: true }));
    }
    return true;
  })()`);
  const afterSmallZoom = await stableTicks();
  const y1 = anchorYear(afterSmallZoom, ANCHOR_X);
  check('★1c 缩放钉住鼠标下的时间（锚点处插值出的年份前后不变，±0.15 年）',
    y0 !== null && y1 !== null && Math.abs(y1 - y0) < 0.15,
    { anchorX: ANCHOR_X, before: y0, after: y1, d: y0 !== null && y1 !== null ? +(y1 - y0).toFixed(3) : null, ticks: afterSmallZoom.slice(0, 4) });
  /* ── ②b ⭐ 用户 2026-09-18：「**缩放到时和分时会突然变得密集**」——
     时/分档必须按算出来的 stepSec 铺网格（旧代码写死 1 小时/1 分钟，等于无视步长）。 ── */
  await ev(`(() => {
    /* ⚠️ 每格**重新取元素**：视图一变就重画 DOM，循环外只取一次的话，第一格之后那个引用已脱离文档，
       事件不再冒泡到 wrap 的 wheel 监听 ⇒ 60 格只有 1 格生效（这一片踩了两次）。 */
    for (let i = 0; i < 60; i++) {
      const el = document.querySelector('#lk-pane-timeline .tl__axis-tick--major') || document.querySelector('#lk-pane-timeline');
      const r = el.getBoundingClientRect();
      /* Alt+滚轮 = 缩放（factor 1.2/格，见 timeline.ts:497-503） */
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, altKey: true, clientX: r.left + 40, bubbles: true, cancelable: true }));
    }
    return true;
  })()`);
  const zoomed = await stableTicks();
  const zLabels = zoomed.map((t) => t.label);
  const isHM = zLabels.some((l) => /时$/.test(l) || /分$/.test(l));
  const zGaps = [];
  for (let i = 1; i < zoomed.length; i++) zGaps.push(zoomed[i].x - zoomed[i - 1].x);
  const zMin = zGaps.length ? Math.min(...zGaps) : 0;
  check('★2b 缩到「时/分」档时不会突然变密（真进到该档 + 主刻度 ≤ 60 条 + 最小间距 ≥ 12px）',
    isHM === true && zoomed.length <= 60 && zMin >= 12,
    { sample: zLabels.slice(0, 4), n: zoomed.length, minGap: zMin });
  /* ── ③ 同一屏里不许出现重复标签 ── */
  const labels = before.map((t) => t.label);
  check('★3 一屏内没有重复的刻度标签', new Set(labels).size === labels.length, { n: labels.length, uniq: new Set(labels).size });

  /* ── ④ 平移之后：同一标签必须跟着整体位移（这就是用户报的「数字会变」） ── */
  /* 平移 = 普通滚轮（timeline.ts:505 `view.panX -= e.deltaY`）⇒ deltaY -180 让整条标尺右移 180px */
  const panned = await ev(`(() => {
    const el = document.querySelector('#lk-pane-timeline .tl__axis-tick--major') || document.querySelector('#lk-pane-timeline');
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -180, bubbles: true, cancelable: true }));
    return true;
  })()`);
  const PAN_PX = 180;
  const after = await stableTicks();
  const mapA = new Map(before.map((t) => [t.label, t.x]));
  const common = after.filter((t) => mapA.has(t.label)).map((t) => ({ label: t.label, dx: t.x - mapA.get(t.label) }));
  const deltas = [...new Set(common.map((c) => c.dx))];
  const panDelta = (after[0]?.x ?? 0) - (before[0]?.x ?? 0);
  check('★4 平移后同一标签整体位移一致（标签绑的是时间，不是屏幕位置）',
    panned === true && panDelta === PAN_PX && common.length >= 2 && deltas.length === 1 && deltas[0] === PAN_PX,
    { panDelta, expect: PAN_PX, common: common.slice(0, 5), deltas });

  const errs = await ev(`window.__errs`);
  check('★5 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n==== ${pass}/${results.length} PASS ====`);
  w.close();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
