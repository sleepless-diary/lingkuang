/* 探针：**连续细密缩放**，逐帧记录每条因果线的端点与两端圆点，抓"圆点几乎没动、端点却跳"的帧。
   假设（待证）：`src/ui/timeline.ts` 的 drawCauses() 里那条**退化分支**
     if ((x2 - x1) * dir <= 0) { x1 = a.x + dir*2; x2 = b.x - dir*2; … }
   在 |Δx| = 2·r·cosθ（r=7、θ=atan2(.25,.4)≈32° ⇒ ≈11.87px）处**硬切**：
   切前端点贴在圆周上（y = c.y - r·sinθ ≈ c.y-3.7），切后落在圆心的水平极点上（y = c.y）
   ⇒ 端点在**一帧内**横跳 ~3.9px、竖跳 ~3.7px，且弧线从"残段"变成"外凸小环"。
   用法：LK_CDP_PORT=9346 node tools/e2e/probe-causes-threshold.cjs [事件数] [步长] */
const PORT = process.env.LK_CDP_PORT || '9346';
const N = Number(process.argv[2] || 90);
const DY = Number(process.argv[3] || 18);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  let target = null;
  for (let i = 0; i < 120; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (target) break; } catch {}
    await sleep(200);
  }
  if (!target) { console.log('FAIL 无法连接 CDP ' + PORT); process.exit(1); }
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
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await sleep(1500);
  await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`);
  for (let i = 0; i < 30; i++) { if ((await ev(`document.querySelectorAll('#lk-pane-timeline .tl__n').length`)) >= 2) break; await sleep(300); }
  await sleep(900);
  const rep = await ev(`(async () => {
    const pane = document.querySelector('#lk-pane-timeline');
    const scale = pane.querySelector('.tl-scale');
    const track = pane.querySelector('.tl-track');
    const svg = pane.querySelector('.tl-causes');
    const sel0 = document.getElementById('lk-line-sel');
    if (sel0) { sel0.value = ''; sel0.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((r) => setTimeout(r, 900)); }
    const nodeEls = () => [...track.querySelectorAll('[data-id]')];
    const parseD = (d) => { const m = /M\\s*([-0-9.eE]+)\\s+([-0-9.eE]+)\\s*C\\s*([-0-9.eE]+)\\s+([-0-9.eE]+)[ ,]+([-0-9.eE]+)\\s+([-0-9.eE]+)[ ,]+([-0-9.eE]+)\\s+([-0-9.eE]+)/.exec(d || ''); return m ? { x1: +m[1], y1: +m[2], c1x: +m[3], c1y: +m[4], c2x: +m[5], c2y: +m[6], x2: +m[7], y2: +m[8] } : null; };
    const frames = [];
    let raf = true;
    const sample = () => {
      const sr = svg.getBoundingClientRect();
      const caps = nodeEls().map((el) => { const dot = el.querySelector('.cap') || el; const r = dot.getBoundingClientRect(); return { id: el.dataset.id, x: r.left + r.width / 2 - sr.left, y: r.top + r.height / 2 - sr.top, rr: r.width / 2 }; });
      const near = (x, y) => { let b = null, bd = 1e9; for (const c of caps) { const d = Math.hypot(c.x - x, c.y - y); if (d < bd) { bd = d; b = c; } } return b; };
      const ends = [...svg.querySelectorAll('path[marker-end]')].map((p, i) => { const d = parseD(p.getAttribute('d')); if (!d) return null; const A = near(d.x1, d.y1), B = near(d.x2, d.y2); const dir = B.x >= A.x ? 1 : -1; return { i: i, src: A.id, dst: B.id, x1: Math.round(d.x1 * 100) / 100, y1: Math.round(d.y1 * 100) / 100, x2: Math.round(d.x2 * 100) / 100, y2: Math.round(d.y2 * 100) / 100, c2x: Math.round(d.c2x * 100) / 100, c2y: Math.round(d.c2y * 100) / 100, ax: Math.round(A.x * 100) / 100, ay: Math.round(A.y * 100) / 100, bx: Math.round(B.x * 100) / 100, by: Math.round(B.y * 100) / 100, rr: B.rr, dir: dir, dx: Math.round(Math.abs(B.x - A.x) * 100) / 100, back: (d.x2 - d.x1) * (B.x - A.x) <= 0 }; });
      frames.push({ t: Math.round(performance.now()), ends: ends });
      requestAnimationFrame(loop);
    };
    const loop = () => { if (!raf) return; sample(); };
    requestAnimationFrame(loop);
    await new Promise((r) => setTimeout(r, 120));
    const wrapEl = scale.parentElement;
    for (let k = 0; k < ${N}; k++) {
      const r = wrapEl.getBoundingClientRect();
      wrapEl.dispatchEvent(new WheelEvent('wheel', { deltaY: -${DY}, altKey: true, clientX: r.left + Math.round(r.width / 2), clientY: r.top + 40, bubbles: true, cancelable: true }));
      await new Promise((res) => setTimeout(res, 16));
    }
    await new Promise((r) => setTimeout(r, 500));
    raf = false;
    return { frames: frames };
  })()`);
  const F = rep.frames;
  console.log('帧数=' + F.length + ' 边数=' + (F[0].ends.length));
  /* 每条边：找"圆点位移 < 1.5px 但端点位移 > 2px"的帧 = 端点自己跳（不是跟着圆点走） */
  const worst = [];
  const byI = new Map();
  for (const f of F) for (const e of f.ends) { if (!e) continue; if (!byI.has(e.i)) byI.set(e.i, []); byI.get(e.i).push({ t: f.t, e: e }); }
  for (const [i, seq] of byI) {
    for (let k = 1; k < seq.length; k++) {
      const p = seq[k - 1].e, q = seq[k].e;
      if (p.src !== q.src || p.dst !== q.dst) continue;
      const dCap = Math.max(Math.abs(q.ax - p.ax), Math.abs(q.bx - p.bx));
      const dTip = Math.hypot(q.x2 - p.x2, q.y2 - p.y2);
      if (dCap < 1.5 && dTip > 2) worst.push({ t: seq[k].t, edge: i, src: q.src, dst: q.dst, dCap: Math.round(dCap * 100) / 100, dTip: Math.round(dTip * 100) / 100, dxFrom: p.dx, dxTo: q.dx, tipFrom: p.y2 + '/' + p.x2, tipTo: q.y2 + '/' + q.x2, backFrom: p.back, backTo: q.back });
    }
  }
  worst.sort((a, b) => b.dTip - a.dTip);
  console.log('"圆点几乎没动、端点却跳 >2px"的帧数 = ' + worst.length);
  for (const x of worst.slice(0, 10)) console.log('  ' + JSON.stringify(x));
  /* 阈值扫描：把每条边的 (间距Δx, 端点相对圆心的偏移) 打出来看有没有硬切 */
  const edges = [...byI.keys()].sort((a, b) => a - b);
  for (const i of edges.slice(0, 4)) {
    const seq = byI.get(i);
    const rows = [];
    for (const s of seq) if (s.e.dx < 40) rows.push([Math.round(s.e.dx * 10) / 10, Math.round((s.e.by - s.e.y2) * 100) / 100, Math.round((s.e.bx - s.e.x2) * 100) / 100, s.e.back ? 'B' : '-'].join(':'));
    const uniq = [...new Set(rows)];
    console.log('[edge ' + i + '] Δx:圆心到端点的 dy:dx:back（Δx<40 的采样，去重）= ' + JSON.stringify(uniq.slice(0, 26)));
  }
  w.close();
  process.exit(0);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
