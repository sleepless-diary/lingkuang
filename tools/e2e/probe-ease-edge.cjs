/* 逐帧探针（用户 2026-09-26 报：「在缩放尺度边缘时标尺缩放的缓动没生效好像」）：
   目的 = 钉死「连滚很多格（缩放到 1e8 上限）时缓动到底有没有跑完」，三条证据：
     ① 每帧读**时间指针的 left**（`src/ui/timeline.ts:602` 每帧 `cursorEl.style.left = timeToX(t)`）
        ⇒ 它是当前视图的纯函数（identity 稳定、单元素），拿它算每帧位移 d，看是"连续衰减到 0"
        还是"某一帧突然跳一大步"（= 直接落值）。
     ② 给 `setTimeout` / `clearTimeout` / `cancelAnimationFrame` 打点：
        `kickEase()` 每次启动缓动会 `setTimeout(..., 600)` 兜底（`src/ui/timeline.ts:105-109`），
        正常跑完走 `clearTimeout(easeTimer)`；**兜底真的响了**则走 `cancelAnimationFrame(easeRaf)`
        + `snapView()` ⇒ 日志里出现 `caf`。
     ③ 首帧前先 CDP `Emulation.setFocusEmulationEnabled {enabled:true}` —— 测试实例带
        `LINGKUANG_TEST_WINDOW_NOFOCUS=1`，不这么做 `noSmooth()` 为真、滚轮当帧落值（根本没缓动可看）。
   用法：LK_CDP_PORT=9346 node tools/e2e/probe-ease-edge.cjs [步数] [间隔ms]  （缺省 100 步 / 10ms） */
const PORT = process.env.LK_CDP_PORT || '9346';
const STEPS = Number(process.argv[2] || 100);
const GAP = Number(process.argv[3] || 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let target = null;
  for (let i = 0; i < 120; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (target) break; } catch {}
    await sleep(200);
  }
  if (!target) { console.log('no cdp'); process.exit(1); }
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

  const onSandbox = await ev(`!!document.querySelector('#lk-pane-timeline .tl-scale')`);
  if (!onSandbox) { await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`); await sleep(1800); }

  /* 让页面内 document.hasFocus() 为真 ⇒ 走 rAF 缓动（**不抢用户 OS 焦点**） */
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  console.log('hasFocus =', await ev('document.hasFocus()'), '| steps =', STEPS, '| gap =', GAP);

  const out = await ev(`(async () => {
    const wrap = document.querySelector('#lk-pane-timeline .tl-wrap');
    const cur = document.querySelector('#lk-pane-timeline .tl-cursor');
    if (!wrap || !cur) return { fatal: 'no wrap/cursor' };
    const readX = () => parseFloat(cur.style.left);
    const origTO = window.setTimeout.bind(window);
    const origCT = window.clearTimeout.bind(window);
    const origCAF = window.cancelAnimationFrame.bind(window);
    const log = [];
    const t0 = performance.now();
    window.setTimeout = function (fn, ms) {
      if (ms === 600) log.push({ k: 'arm600', t: Math.round(performance.now() - t0) });
      return origTO.apply(null, arguments);
    };
    window.clearTimeout = function (id2) { log.push({ k: 'clear600', t: Math.round(performance.now() - t0) }); return origCT(id2); };
    window.cancelAnimationFrame = function (id2) { log.push({ k: 'caf', t: Math.round(performance.now() - t0) }); return origCAF(id2); };

    const frames = [];
    let stop = false, prev = NaN;
    const sample = () => {
      const x = readX();
      const d = isFinite(prev) && isFinite(x) ? Math.round((x - prev) * 100) / 100 : null;
      frames.push({ t: Math.round(performance.now() - t0), x: isFinite(x) ? Math.round(x * 10) / 10 : null, d: d,
                    n: document.querySelectorAll('#lk-pane-timeline .tl__axis-tick').length });
      prev = x;
      if (!stop) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    await new Promise((r) => origTO(r, 60));
    const rr = wrap.getBoundingClientRect();
    const opts = { deltaY: -100, altKey: true, clientX: rr.left + Math.round(rr.width / 2), clientY: rr.top + 40, bubbles: true, cancelable: true };
    const STEPS = ${JSON.stringify(STEPS)}, GAP = ${JSON.stringify(GAP)};
    for (let i = 0; i < STEPS; i++) {
      wrap.dispatchEvent(new WheelEvent('wheel', opts));
      await new Promise((r) => origTO(r, GAP));
    }
    const burstEnd = Math.round(performance.now() - t0);
    await new Promise((r) => origTO(r, 1400));
    stop = true;
    await new Promise((r) => origTO(r, 40));
    window.setTimeout = origTO; window.clearTimeout = origCT; window.cancelAnimationFrame = origCAF;
    let maxD = 0, maxAt = -1;
    for (const f of frames) { if (f.d !== null && Math.abs(f.d) > Math.abs(maxD)) { maxD = f.d; maxAt = f.t; } }
    /* 运动真正停下来的时刻：最后一个 |d| > 0.5 的帧 */
    let lastMove = -1;
    for (const f of frames) { if (f.d !== null && Math.abs(f.d) > 0.5) lastMove = f.t; }
    return { frames: frames, log: log, burstEnd: burstEnd, maxD: maxD, maxAt: maxAt, lastMove: lastMove };
  })()`);

  if (out.fatal) { console.log(out.fatal); process.exit(1); }
  const fr = out.frames;
  console.log('frames =', fr.length, '| burstEnd =', out.burstEnd, 'ms | lastMove =', out.lastMove, 'ms');
  console.log('max single-frame delta =', out.maxD, 'px @ t =', out.maxAt, 'ms');
  console.log('--- 打点（arm600 = 启动 600ms 兜底；clear600 = 缓动正常跑完；caf = **兜底真的响了**）---');
  for (const e of out.log) console.log('  ' + String(e.t).padStart(5) + 'ms  ' + e.k);
  console.log('--- 每个 caf 前 6 帧 / 后 3 帧（看它有没有把 view 一步落值）---');
  const cafs = out.log.filter((e) => e.k === 'caf').map((e) => e.t);
  for (const c of cafs) {
    const idx = fr.findIndex((f) => f.t >= c);
    if (idx < 0) continue;
    for (let i = Math.max(0, idx - 6); i < Math.min(fr.length, idx + 3); i++) {
      const f = fr[i];
      console.log('   ' + (i === idx ? '>>' : '  ') + ' t=' + String(f.t).padStart(5) + ' x=' + String(f.x).padStart(12) + ' d=' + String(f.d).padStart(10) + ' n=' + f.n);
    }
  }
  console.log('--- 起步 25 帧 + 收尾 25 帧 ---');
  const head = fr.slice(0, 25), tail = fr.slice(-25);
  for (const f of head) console.log('   t=' + String(f.t).padStart(5) + ' x=' + String(f.x).padStart(12) + ' d=' + String(f.d).padStart(10) + ' n=' + f.n);
  console.log('   ······');
  for (const f of tail) console.log('   t=' + String(f.t).padStart(5) + ' x=' + String(f.x).padStart(12) + ' d=' + String(f.d).padStart(10) + ' n=' + f.n);
  w.close();
}
main().catch((e) => { console.log('probe 异常 ' + (e && e.stack ? e.stack : e)); process.exit(2); });
