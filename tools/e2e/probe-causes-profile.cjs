/* 探针：**缩放期间的 CPU 采样剖析**，回答"每帧那几毫秒花在哪个函数上"。
   动机：150 节点 / 294 条因果线的加压夹具上，逐帧脚本成本 ~4.4ms（4 节点时只 0.3ms）、
   258 帧里 11 帧 >20ms —— 但总量不告诉你该改哪儿。`drawCauses()` 每帧对每条边做
   2 次 `track.querySelector('[data-id=...]')`（294 边 = 588 次查询）、重建 294 个 <marker>、
   150 个节点整块 innerHTML —— 三者都在这条链上，需要**按自耗时排序**才能定。

   用法：LK_CDP_PORT=9346 node tools/e2e/probe-causes-profile.cjs [步数] */
const PORT = process.env.LK_CDP_PORT || '9346';
const STEPS = Number(process.argv[2] || 10);
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
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Profiler.enable', {});
  await sleep(1500);
  await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`);
  for (let i = 0; i < 30; i++) { if ((await ev(`document.querySelectorAll('#lk-pane-timeline .tl__n').length`)) >= 1) break; await sleep(300); }
  await sleep(900);
  /* 逐帧脚本耗时的独立量法：包一层 requestAnimationFrame 计时（含 render 全链） */
  const perFrame = await ev(`(async () => {
    const pane = document.querySelector('#lk-pane-timeline');
    const scale = pane.querySelector('.tl-scale');
    const sel0 = document.getElementById('lk-line-sel');
    if (sel0) { sel0.value = ''; sel0.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((r) => setTimeout(r, 900)); }
    const samples = [];
    let raf = true, last = performance.now();
    const tick = (t) => { samples.push(Math.round((t - last) * 100) / 100); last = t; if (raf) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    for (let k = 0; k < ${STEPS}; k++) {
      const r = scale.parentElement.getBoundingClientRect();
      scale.parentElement.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, altKey: true, clientX: r.left + Math.round(r.width / 2), clientY: r.top + 40, bubbles: true, cancelable: true }));
      await new Promise((res) => setTimeout(res, 140));
    }
    raf = false;
    const s = samples.slice().sort((a, b) => a - b);
    return { frames: samples.length, max: Math.max(...samples), p50: s[Math.floor(s.length * 0.5)], p95: s[Math.floor(s.length * 0.95)], over20: samples.filter((x) => x > 20).length, over33: samples.filter((x) => x > 33).length };
  })()`);
  console.log('帧间隔（缓动期间）=', JSON.stringify(perFrame));
  /* 采样剖析：同一段缩放，看自耗时排行 */
  await send('Profiler.setSamplingInterval', { interval: 200 });
  await send('Profiler.start', {});
  await ev(`(async () => {
    const scale = document.querySelector('#lk-pane-timeline .tl-scale');
    for (let k = 0; k < ${STEPS}; k++) {
      const r = scale.parentElement.getBoundingClientRect();
      scale.parentElement.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, altKey: true, clientX: r.left + Math.round(r.width / 2), clientY: r.top + 40, bubbles: true, cancelable: true }));
      await new Promise((res) => setTimeout(res, 140));
    }
    return true;
  })()`);
  const prof = await send('Profiler.stop', {});
  const p = prof.result.profile;
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const rows = p.nodes
    .filter((n) => n.hitCount)
    .map((n) => {
      const cf = n.callFrame;
      const url = (cf.url || '').split('/').slice(-1)[0] || '(native)';
      return { name: cf.functionName || '(anonymous)', at: url + ':' + (cf.lineNumber + 1), self: Math.round(n.hitCount * 0.2 * 10) / 10 };
    })
    .sort((a, b) => b.self - a.self).slice(0, 18);
  console.log('自耗时排行（ms，采样 0.2ms）= ');
  for (const r of rows) console.log('  ' + String(r.self).padStart(7) + 'ms  ' + r.name + '  ' + r.at);
  /* 顺带数一数每帧的 querySelector 调用次数（最可疑的那条） */
  const counts = await ev(`(async () => {
    const proto = Element.prototype;
    const orig = proto.querySelector;
    let q = 0, all = 0;
    proto.querySelector = function (s) { q++; return orig.call(this, s); };
    const origAll = proto.querySelectorAll;
    proto.querySelectorAll = function (s) { all++; return origAll.call(this, s); };
    const scale = document.querySelector('#lk-pane-timeline .tl-scale');
    const t0 = performance.now(), f0 = window.__f || 0;
    const r = scale.parentElement.getBoundingClientRect();
    for (let k = 0; k < 3; k++) {
      scale.parentElement.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, altKey: true, clientX: r.left + Math.round(r.width / 2), clientY: r.top + 40, bubbles: true, cancelable: true }));
      await new Promise((res) => setTimeout(res, 200));
    }
    proto.querySelector = orig; proto.querySelectorAll = origAll;
    return { querySelector: q, querySelectorAll: all, ms: Math.round(performance.now() - t0) };
  })()`);
  console.log('3 格缩放的 DOM 查询调用 =', JSON.stringify(counts));
  w.close();
  process.exit(0);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
