/* 不变量：**聚焦一条剧情线 = 线外截断 + 多段拼接**（第 4.0 片 C）。
 *
 * 用户原话：「我想要的剧情线其实是**剧情线之外的内容（包括时间线）全部截断**，
 * 如果剧情线之间是多段时间则**连接两段时间**（剔除中间的节点和时间线）」。
 *
 * 实现见 `src/ui/timeline.ts` 的「分段映射」一节：真实年 ↔ **压缩年** 的单调映射
 * （`rebuildWarp` / `year2w` / `w2year` / `inWarpSeg`），段按原长保留、段间空隙长度归零；
 * `timeToX / xToTime` 是时间↔屏幕的唯一通道 ⇒ 节点、标尺、指针、色带全跟着走，
 * 段外节点由 `render` 包装器里的 `inLine()` 过滤掉。
 *
 * 判据（交接单给的）：
 *   ① 聚焦一条两段式的线 → 屏幕上两段**直接相邻**、中间节点不出现；
 *   ② 标尺数字与该映射一致（段内仍然等距、被截断的区间里一个刻度都没有）；
 *   ③ 切回「— 全览 —」**完全还原**。
 * 夹具：`seed-storyline-focus.cjs`（段 A = 100~200、段 B = 4000~4100；线内 4 节点、线外 2 节点）。
 *
 * 用法：干净实例（reset-entity-vault + seed-storyline-focus，端口 9354）
 *   LK_CDP_PORT=9354 node tools/e2e/storyline-focus.cjs
 */
const PORT = process.env.LK_CDP_PORT || '9354';
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

  /** 画布现状：节点（标题 + 屏幕 x）、主刻度（标签 + x）、断口数 */
  const view = () => ev(`(() => {
    const nodes = [...document.querySelectorAll('#lk-pane-timeline .tl__n[data-id]')].map((el) => ({
      title: el.querySelector('.tl__name')?.textContent ?? '',
      x: Math.round(parseFloat(el.style.left) || 0),
    }));
    const ticks = [...document.querySelectorAll('#lk-pane-timeline .tl__axis-tick--major')].map((el) => ({
      label: el.querySelector('.tl__axis-label')?.textContent ?? '',
      x: Math.round(parseFloat(el.style.left) || 0),
    })).filter((t) => t.label);
    return {
      nodes, ticks,
      cuts: document.querySelectorAll('#lk-pane-timeline .tl__axis-cut').length,
      sel: document.getElementById('lk-line-sel')?.value ?? null,
      nLines: document.querySelectorAll('#lk-line-sel option').length - 1,
      years: ticks.map((t) => { const m = /^(-?\\d+)年$/.exec(t.label); return m ? Number(m[1]) : null; }).filter((y) => y !== null),
    };
  })()`);
  /** 视图是缓动的（kickEase 600ms）⇒ 连续两次读数一致才算稳定 */
  const stableView = async (ms = 6000) => {
    let prev = null, same = 0, cur = null;
    const t0 = Date.now();
    for (;;) {
      cur = await view();
      const sig = JSON.stringify(cur.nodes.map((n) => n.title + '@' + n.x)) + '|' + JSON.stringify(cur.ticks.map((t) => t.label + '@' + t.x));
      same = prev === sig ? same + 1 : 0;
      prev = sig;
      if (same >= 1) return cur;
      if (Date.now() - t0 > ms) return cur;
      await sleep(260);
    }
  };
  const setLine = (v) => ev(`(() => {
    const s = document.getElementById('lk-line-sel');
    if (!s) return false;
    s.value = ${JSON.stringify(v)};
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const at = (v, title) => (v.nodes.find((n) => n.title === title) || {}).x;

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`);
  await sleep(700);

  /* ── ① 全览：六个节点都在，标尺没有断口（对照组） ── */
  await setLine('');
  const full = await stableView();
  check('★0 前置「— 全览 —」：下拉可用、两段线在选项里，6 个节点全在、标尺无断口',
    full.sel === '' && full.nLines >= 1 && full.nodes.length === 6 && full.cuts === 0 && full.years.length >= 2,
    { sel: full.sel, lines: full.nLines, nodes: full.nodes.length, cuts: full.cuts, ticks: full.years.length });

  /* 同一个算式（屏幕距离 ÷ 段内 px/年）在两边的对比 —— 全览下必须算出**真实**的 3850 年。
     ⚠️ 定标基准要**足够长**：`left` 是整数像素，拿「甲段起点→甲段中点」那 50 年（全览下约 10px）
     当基准，取整误差就有 10%（实测算出 3760）。用 100→5000 那 4900 年（约 960px）定标，误差 ≪1%。 */
  const pxPerYearFull = (at(full, '末段之后') - at(full, '甲段起点')) / 4900;
  const realSpan = (at(full, '乙段起点') - at(full, '甲段中点')) / pxPerYearFull;
  check('★0b 对照：全览下「甲段中点 → 乙段起点」按屏幕距离换算 = 真实的 ~3850 年',
    pxPerYearFull > 0 && Math.abs(realSpan - 3850) < 80, { pxPerYearFull: +pxPerYearFull.toFixed(4), realSpan: +realSpan.toFixed(1) });

  /* ── ② 聚焦两段线：线外节点消失，线内 4 个都在 ── */
  await setLine('sl-1');
  const foc = await stableView();
  const titles = foc.nodes.map((n) => n.title);
  const hasAll = ['甲段起点', '甲段中点', '乙段起点', '乙段中点'].every((t) => titles.includes(t));
  check('★1 聚焦后**线外节点不出现**（2000 年的「空隙里的事件」、5000 年的「末段之后」都没有），线内 4 个都在',
    foc.sel === 'sl-1' && foc.nodes.length === 4 && hasAll
    && !titles.includes('空隙里的事件') && !titles.includes('末段之后'),
    { sel: foc.sel, titles });

  /* ── ③ 两段**直接相邻**：同一算式的答案从 3850 年变成 50 年 ── */
  const pxPerYear = (at(foc, '甲段中点') - at(foc, '甲段起点')) / 50;
  const warpedSpan = (at(foc, '乙段起点') - at(foc, '甲段中点')) / pxPerYear;
  check('★2 两段直接相邻（段间空隙被压掉）：屏幕上「甲段中点 → 乙段起点」只剩 ~50 年，不是 3850 年',
    pxPerYear > 0 && Math.abs(warpedSpan - 50) < 8,
    { pxPerYear: +pxPerYear.toFixed(4), warpedSpan: +warpedSpan.toFixed(1), x: { a1: at(foc, '甲段起点'), a2: at(foc, '甲段中点'), b1: at(foc, '乙段起点') } });

  /* ── ④ 标尺与映射一致：被截断的区间里一个刻度都没有，接缝有断口标记 ── */
  const inGap = foc.years.filter((y) => y > 200 && y < 4000);
  check('★3 标尺只画线内：区间 (200, 4000) 里没有任何刻度，接缝处有断口标记',
    inGap.length === 0 && foc.cuts >= 1 && foc.years.some((y) => y <= 200) && foc.years.some((y) => y >= 4000),
    { inGap, cuts: foc.cuts, minYear: Math.min(...foc.years), maxYear: Math.max(...foc.years) });
  /* 段内比例不许被压缩轴动过：段 A 里相邻主刻度的像素间距要一致 */
  const aTicks = foc.ticks.filter((t) => t.x < at(foc, '乙段起点')).map((t) => t.x);
  const gaps = aTicks.slice(1).map((x, i) => x - aTicks[i]);
  check('★4 段内刻度仍然等距（间距浮动 ≤ 2px）—— 压缩只吃空隙，不动段内比例',
    gaps.length >= 2 && Math.max(...gaps) - Math.min(...gaps) <= 2, { gaps });

  /* ── ⑤ 切回「— 全览 —」：完全还原 ── */
  await setLine('');
  const back = await stableView();
  check('★5 切回「— 全览 —」完全还原：6 个节点都回来、断口消失、标尺重新覆盖被截断的区间',
    back.sel === '' && back.nodes.length === 6 && back.cuts === 0 && back.years.some((y) => y > 200 && y < 4000),
    { sel: back.sel, nodes: back.nodes.length, cuts: back.cuts, hasGapTick: back.years.some((y) => y > 200 && y < 4000) });

  const errs = await ev(`window.__errs`);
  check('★6 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n==== ${pass}/${results.length} PASS ====`);
  w.close();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
