/* 探针：**平滑缩放期间逐帧对齐「圆点几何 / 画出来的因果线 / 每帧耗时」**，给两条症状定机制：
     ① 「缩放时标尺有轻微卡顿」；② 「渲染出的因果线会跳位置」。
   核心手段 = **按几何反推每条 path 连的是谁**：把 path 的起点/终点各配到最近的圆点，
   于是"弧线换了目标节点""箭头翻向""退化成 4px 残段""端点滞后一帧"都能直接读出来 ——
   （上一版把 paths[0] 当成甲→乙 去比，而它是丁→甲，残差全假。）
   同时读 `getBoundingClientRect()`（含 transform）与 `offsetLeft/Top`（纯布局）以区分"跳"是布局还是动画。

   用法（窗口必须可见、无 .cdp 焦点抢占）：
     LK_CDP_PORT=9346 node tools/e2e/probe-causes-zoom.cjs [zoom|pan] [步数]
   ⚠️ 住在模板字符串里：正文不许出现反引号或美元花括号。 */
const PORT = process.env.LK_CDP_PORT || '9346';
const MODE = ['pan', 'out'].includes(process.argv[2]) ? process.argv[2] : 'zoom';
const STEPS = Number(process.argv[3] || 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });   /* hasFocus 真 ⇒ 走缓动（用户看到的路径） */
  await send('Performance.enable', {});
  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`);
  for (let i = 0; i < 30; i++) { if ((await ev(`document.querySelectorAll('#lk-pane-timeline .tl__n').length`)) >= 1) break; await sleep(300); }
  await sleep(900);

  const before = await send('Performance.getMetrics', {});
  const report = await ev(`(async () => {
    const pane = document.querySelector('#lk-pane-timeline');
    if (!pane) return { fatal: 'no pane' };
    const scale = pane.querySelector('.tl-scale');
    const track = pane.querySelector('.tl-track');
    const svg = pane.querySelector('.tl-causes');
    if (!scale || !track || !svg) return { fatal: 'no scale/track/svg' };
    const sel0 = document.getElementById('lk-line-sel');
    if (sel0) { sel0.value = ''; sel0.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((r) => setTimeout(r, 900)); }

    const nodeEls = () => [...track.querySelectorAll('[data-id]')];
    const paths = () => [...svg.querySelectorAll('path[marker-end]')];
    const parseD = (d) => {
      const m = /M\\s*([-0-9.eE]+)\\s+([-0-9.eE]+)\\s*C\\s*([-0-9.eE]+)\\s+([-0-9.eE]+)[ ,]+([-0-9.eE]+)\\s+([-0-9.eE]+)[ ,]+([-0-9.eE]+)\\s+([-0-9.eE]+)/.exec(d || '');
      if (!m) return null;
      return { x1: +m[1], y1: +m[2], c1x: +m[3], c1y: +m[4], c2x: +m[5], c2y: +m[6], x2: +m[7], y2: +m[8] };
    };
    const frames = [];
    let raf = true;
    const sample = () => {
      const svgRect = svg.getBoundingClientRect();
      const caps = nodeEls().map((el) => {
        const dot = el.querySelector('.cap') || el;
        const r = dot.getBoundingClientRect();
        return { id: el.dataset.id, x: r.left + r.width / 2 - svgRect.left, y: r.top + r.height / 2 - svgRect.top, rr: r.width / 2, ox: el.offsetLeft, oy: el.offsetTop, left: el.style.left, anims: (el.getAnimations ? el.getAnimations().length : 0) };
      });
      const ps = paths().map((p) => parseD(p.getAttribute('d')));
      const near = (x, y) => { let best = null, bd = 1e9; for (const c of caps) { const d = Math.hypot(c.x - x, c.y - y); if (d < bd) { bd = d; best = c; } } return { c: best, d: bd }; };
      const edges = ps.map((p, i) => {
        if (!p) return { i: i, bad: true };
        const A = near(p.x1, p.y1), B = near(p.x2, p.y2);
        return {
          i: i, src: A.c.id, dst: B.c.id, rErrA: Math.round((A.d - A.c.rr) * 10) / 10, rErrB: Math.round((B.d - B.c.rr) * 10) / 10,
          x1: Math.round(p.x1 * 10) / 10, x2: Math.round(p.x2 * 10) / 10, y1: Math.round(p.y1 * 10) / 10, y2: Math.round(p.y2 * 10) / 10,
          back: (p.x2 - p.x1) * (B.c.x - A.c.x) <= 0, seg: Math.round(Math.abs(p.x2 - p.x1)),
        };
      });
      frames.push({
        t: Math.round(performance.now()), n: caps.length, paths: ps.length, ticks: scale.children.length,
        trackH: track.clientHeight, svgTop: Math.round(svgRect.top), caps: caps.map((c) => ({ id: c.id, x: Math.round(c.x * 100) / 100, y: Math.round(c.y * 100) / 100, ox: c.ox, oy: c.oy, anims: c.anims })),
        edges: edges,
      });
      requestAnimationFrame(loop);
    };
    const loop = () => { if (!raf) return; sample(); };
    requestAnimationFrame(loop);
    await new Promise((r) => setTimeout(r, 150));
    for (let k = 0; k < ${STEPS}; k++) {
      const wrap = scale.parentElement;
      const r = wrap.getBoundingClientRect();
      wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: ${MODE === 'pan' ? '-90' : MODE === 'out' ? '100' : '-100'}, altKey: ${MODE === 'pan' ? 'false' : 'true'}, clientX: r.left + Math.round(r.width / 2), clientY: r.top + 40, bubbles: true, cancelable: true }));
      await new Promise((res) => setTimeout(res, 140));
    }
    await new Promise((r) => setTimeout(r, 700));
    raf = false;
    return { frames: frames, focused: document.hasFocus(), visible: document.visibilityState };
  })()`);
  const after = await send('Performance.getMetrics', {});
  const pick = (m) => Object.fromEntries(m.result.metrics.map((x) => [x.name, x.value]));
  const b4 = pick(before), af = pick(after);
  const d = {};
  for (const k of Object.keys(af)) if (typeof af[k] === 'number' && typeof b4[k] === 'number') d[k] = Math.round((af[k] - b4[k]) * 1000) / 1000;
  console.log('perf delta =', JSON.stringify({ Script_s: d.ScriptDuration, Layout_s: d.LayoutDuration, Style_s: d.RecalcStyleDuration, LayoutCount: d.LayoutCount, StyleCount: d.RecalcStyleCount, Task_s: d.TaskDuration }));
  if (!report || report.fatal) { console.log('FAIL', JSON.stringify(report)); process.exit(1); }
  const F = report.frames;
  console.log('frames=' + F.length, 'focused=' + report.focused, 'visible=' + report.visible, 'nodes=' + F[F.length - 1].n, 'paths=' + F[F.length - 1].paths);
  const dts = [];
  for (let i = 1; i < F.length; i++) dts.push(F[i].t - F[i - 1].t);
  const s = dts.slice().sort((x, y) => x - y);
  const pct = (p) => s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0;
  console.log('帧间隔 ms: max=' + Math.max(0, ...dts) + ' p95=' + pct(0.95) + ' p50=' + pct(0.5) + ' >20ms=' + dts.filter((x) => x > 20).length + '/' + dts.length);

  /* ① 连线"配对"逐帧追踪：同一条弧线换了目标节点 / 后退成残段 / 箭头翻向 = 用户说的"跳位置" */
  const byIdx = new Map();
  for (const f of F) for (const e of f.edges) { if (e.bad) continue; if (!byIdx.has(e.i)) byIdx.set(e.i, []); byIdx.get(e.i).push({ t: f.t, src: e.src, dst: e.dst, rErrA: e.rErrA, rErrB: e.rErrB, seg: e.seg, back: e.back, x1: e.x1, x2: e.x2, y1: e.y1, y2: e.y2 }); }
  for (const [i, seq] of byIdx) {
    const changes = [];
    const errSteps = [];
    for (let k = 1; k < seq.length; k++) {
      if (seq[k].src !== seq[k - 1].src || seq[k].dst !== seq[k - 1].dst) changes.push({ t: seq[k].t, from: seq[k - 1].src + '->' + seq[k - 1].dst, to: seq[k].src + '->' + seq[k].dst });
      const dA = seq[k].rErrA - seq[k - 1].rErrA, dB = seq[k].rErrB - seq[k - 1].rErrB;
      if (Math.abs(dA) > 2 || Math.abs(dB) > 2) errSteps.push({ t: seq[k].t, dA: Math.round(dA * 10) / 10, dB: Math.round(dB * 10) / 10, from: seq[k - 1].rErrA + '/' + seq[k - 1].rErrB, to: seq[k].rErrA + '/' + seq[k].rErrB, seg: seq[k].seg });
    }
    const maxErr = Math.max(...seq.map((x) => Math.max(Math.abs(x.rErrA), Math.abs(x.rErrB))));
    const backs = seq.filter((x) => x.back).length;
    if (changes.length || maxErr > 2.5 || backs || errSteps.length) console.log('[edge ' + i + '] 配对变化=' + JSON.stringify(changes.slice(0, 6)) + ' 次数=' + changes.length + ' 端点离圆周最大偏差=' + maxErr + 'px 后退段帧=' + backs + '/' + seq.length + ' 偏差单帧跳变(>2px)=' + JSON.stringify(errSteps.slice(0, 6)) + ' 共' + errSteps.length);
  }
  /* ② 端点"击穿"检测：弧线端点相对圆心的位移 vs 圆点自身位移（滞后/跳 = 两者不等） */
  const spikes = [];
  for (let k = 1; k < F.length; k++) {
    const p0 = F[k - 1], p1 = F[k];
    const cm = new Map(p1.caps.map((c) => [c.id, c]));
    const cm0 = new Map(p0.caps.map((c) => [c.id, c]));
    for (const e of p1.edges) {
      if (e.bad) continue;
      const e0 = p0.edges.find((x) => x.i === e.i);
      if (!e0 || e0.bad || e.src !== e0.src) continue;
      const c1 = cm.get(e.dst), c0 = cm0.get(e0.dst);
      if (!c1 || !c0) continue;
      const dCap = Math.hypot(c1.x - c0.x, c1.y - c0.y);
      const dTip = Math.hypot(e.x2 - e0.x2, e.y2 - e0.y2);
      const resid = Math.hypot(e.rErrA, e.rErrB);
      if (Math.abs(dTip - dCap) > 3 || resid > 3) spikes.push({ t: p1.t, edge: e.i, src: e.src, dst: e.dst, dCap: Math.round(dCap * 10) / 10, dTip: Math.round(dTip * 10) / 10, rErrA: e.rErrA, rErrB: e.rErrB, seg: e.seg, back: e.back, anims: cm.get(e.dst).anims });
    }
  }
  console.log('端点异常帧（|dTip-dCap|>3 或 端点离圆周>3px）总数=' + spikes.length);
  console.log('  样本(最多 8) =', JSON.stringify(spikes.slice(0, 8)));
  /* ③ 标尺：刻度数逐帧变化 + 有没有"一帧进出很多根"（读作卡顿） */
  const dtick = [];
  for (let k = 1; k < F.length; k++) dtick.push(Math.abs(F[k].ticks - F[k - 1].ticks));
  const bulk = dtick.map((v, i) => ({ v, t: F[i + 1].t })).filter((x) => x.v >= 8);
  console.log('刻度数单帧变化: max=' + Math.max(0, ...dtick) + ' 单帧进出≥8根的帧数=' + bulk.length + '/' + dtick.length + ' 样本=' + JSON.stringify(bulk.slice(0, 6)));
  console.log('节点上带动画的帧数 =', F.filter((f) => f.caps.some((c) => c.anims)).length + '/' + F.length);
  console.log('track 子元素数集合 =', JSON.stringify([...new Set(F.map((f) => f.n))]), 'path 数集合 =', JSON.stringify([...new Set(F.map((f) => f.paths))]), 'trackH 集合 =', JSON.stringify([...new Set(F.map((f) => f.trackH))]));
  const errs = await ev(`window.__errs`);
  console.log('未捕获异常 =', JSON.stringify(errs));
  w.close();
  process.exit(0);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
