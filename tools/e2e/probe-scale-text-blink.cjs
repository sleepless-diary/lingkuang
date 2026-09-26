/* 用户视角量化（第 ⑤ 片二轮 · 「入场时标尺的文字会闪一下」）：
   跨一次**真换档**（年档步长变了）时，逐帧盯住换档前已有的那些数字：
     · 元素有没有被摘掉（isConnected 变 false = 那个字消失过）
     · computed opacity 有没有掉下去（退场动画 = 变暗）
   输出 beforeN / kept(既不消失也没暗过) / blinked。
   跑法：LK_CDP_PORT=9346 node tools/e2e/probe-scale-text-blink.cjs */
const PORT = process.env.LK_CDP_PORT || '9346';
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

  const onSandbox = await ev(`!!document.querySelector('#lk-pane-timeline .tl-scale')`);
  if (!onSandbox) { await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`); await sleep(1800); }

  const out = await ev(`(async () => {
    const scale = document.querySelector('#lk-pane-timeline .tl-scale');
    if (!scale) return { fatal: 'no .tl-scale' };
    const sel = document.getElementById('lk-line-sel');
    if (sel) { sel.value = ''; sel.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((r) => setTimeout(r, 900)); }
    const majors = () => [...scale.querySelectorAll('.tl__axis-tick--major')];
    const yearsOf = (els) => { const out = []; for (const el of els) { const s = el.querySelector('.tl__axis-label'); if (!s) return null; const m = /^([0-9]+)年$/.exec(s.textContent); if (!m) return null; out.push(Number(m[1])); } out.sort((a, b) => a - b); return out; };
    const gapOf = (ys) => { if (!ys || ys.length < 4) return null; const d = []; for (let i = 1; i < ys.length; i++) d.push(ys[i] - ys[i - 1]); d.sort((a, b) => a - b); return d[Math.floor(d.length / 2)]; };
    let prevGap = gapOf(yearsOf(majors()));
    for (const dir of [-100, 100]) {
      for (let k = 1; k <= 12; k++) {
        const before = majors();
        const beforeLabels = before.map((el) => { const s = el.querySelector('.tl__axis-label'); return s ? s.textContent : ''; });
        const mins = before.map(() => 1);
        let sampling = true;
        const tick = () => {
          for (let i = 0; i < before.length; i++) {
            const el = before[i];
            const op = el.isConnected ? parseFloat(getComputedStyle(el).opacity) : 0;
            if (op < mins[i]) mins[i] = op;
          }
          if (sampling) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        const wrap = scale.parentElement;
        const r = wrap.getBoundingClientRect();
        wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: dir, altKey: true, clientX: r.left + Math.round(r.width / 2), clientY: r.top + 40, bubbles: true, cancelable: true }));
        await new Promise((res) => setTimeout(res, 800));
        sampling = false;
        const nowGap = gapOf(yearsOf(majors()));
        if (prevGap !== null && nowGap !== null && prevGap !== nowGap) {
          const kept = [];
          const blinked = [];
          for (let i = 0; i < before.length; i++) {
            const rec = { txt: beforeLabels[i], minOp: Math.round(mins[i] * 100) / 100, alive: before[i].isConnected };
            (rec.alive && rec.minOp >= 0.8 ? kept : blinked).push(rec);
          }
          return { hitAt: k, dir: dir, gapFrom: prevGap, gapTo: nowGap, beforeN: before.length, keptN: kept.length, blinkedN: blinked.length, kept: kept.slice(0, 4), blinked: blinked.slice(0, 4) };
        }
        prevGap = nowGap;
      }
    }
    return { hitAt: -1, beforeN: 0, keptN: 0, blinkedN: 0 };
  })()`);
  console.log(out.fatal ? out.fatal : JSON.stringify(out, null, 1));
  w.close();
  process.exit(0);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
