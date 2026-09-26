/* 换档交叉淡化的逐格探针（2026-09-26 第 ⑥ 轮：用户「整体文字的出入场」+ 拍板选 A 交叉淡化）。
   从干净 fit 起，逐格 alt+滚轮放大，每一格采一次：
     · 屏幕上**有几套档位**的刻度（按数字文本判：`N年`/`N月`/`N号`/`N时`/`N分`）+ 每套的不透明度 min/max
       —— 换档交接点上应该是**两套同时在、各约 0.5**（用户选的 A），区间中部只有一套、恒 1；
     · 总刻度数 / 带 `.tl__axis-tick--ghost`（线隐身）的刻度数 / 在播动画的刻度数（必须恒 0）。
   测试实例带 NOFOCUS ⇒ `noSmooth()` 为真、滚轮当帧落值，所以每一格都是确定状态（不需要 focus 模拟）。
   用法：LK_CDP_PORT=9346 node tools/e2e/probe-scale-handover.cjs [格数] */
const PORT = process.env.LK_CDP_PORT || '9346';
const STEPS = Number(process.argv[2] || 60);
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

  const out = await ev(`(async () => {
    const wrap = document.querySelector('#lk-pane-timeline .tl-wrap');
    if (!wrap) return { fatal: 'no wrap' };
    const rr = wrap.getBoundingClientRect();
    const opts = { deltaY: -100, altKey: true, clientX: rr.left + Math.round(rr.width * 0.45), clientY: rr.top + 40, bubbles: true, cancelable: true };
    const unitOf = (t) => {
      if (/年$/.test(t)) return '年';
      if (/月$/.test(t)) return '月';
      if (/号$/.test(t)) return '日';
      if (/时$/.test(t)) return '时';
      if (/分$/.test(t)) return '分';
      return '?';
    };
    const sample = () => {
      const ticks = [...document.querySelectorAll('#lk-pane-timeline .tl__axis-tick--major')];
      const byUnit = {}; let anim = 0, ghost = 0, withLabel = 0;
      for (const el of ticks) {
        const sp = el.querySelector('.tl__axis-label');
        if (el.getAnimations && el.getAnimations().length) anim++;
        if (el.classList.contains('tl__axis-tick--ghost')) ghost++;
        if (!sp) continue;
        withLabel++;
        const u = unitOf(sp.textContent);
        const op = Math.round(parseFloat(getComputedStyle(sp).opacity) * 1000) / 1000;
        (byUnit[u] = byUnit[u] || []).push(op);
      }
      const units = {};
      for (const u of Object.keys(byUnit)) {
        const a = byUnit[u];
        units[u] = { n: a.length, min: Math.min.apply(null, a), max: Math.max.apply(null, a) };
      }
      return { units: units, nUnits: Object.keys(byUnit).length, ticks: ticks.length, withLabel: withLabel, anim: anim, ghost: ghost };
    };
    const steps = [{ i: 0, s: sample() }];
    for (let i = 1; i <= ${JSON.stringify(STEPS)}; i++) {
      wrap.dispatchEvent(new WheelEvent('wheel', opts));
      await new Promise((r) => setTimeout(r, 90));
      steps.push({ i: i, s: sample() });
    }
    return { steps: steps };
  })()`);

  if (out.fatal) { console.log(out.fatal); process.exit(1); }
  let two = 0;
  for (const st of out.steps) {
    const s = st.s;
    const parts = Object.keys(s.units).map((u) => u + ':n=' + s.units[u].n + ' op=' + s.units[u].min + '..' + s.units[u].max);
    if (s.nUnits >= 2) two++;
    console.log(String(st.i).padStart(3) + '  套数=' + s.nUnits + '  ticks=' + String(s.ticks).padStart(3) +
      '  ghost=' + String(s.ghost).padStart(3) + '  anim=' + s.anim + '   ' + parts.join('   '));
  }
  console.log('--- 出现"两套同时在"的格数 =', two, '/', out.steps.length, '（交叉淡化窗口）');
  w.close();
}
main().catch((e) => { console.log('probe 异常 ' + (e && e.stack ? e.stack : e)); process.exit(2); });
