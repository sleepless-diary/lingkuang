/* 探针（第 ⑤ 片 · 标尺换档）：逐格 alt+滚轮缩小，把每一档的「主刻度数 / 子元素数 / 前 5 个标签 /
   前 3 个 left」打出来。用途：① 看清"步长什么时候换"（标签整批变）② 看清"同一次重画的瞬间
   DOM 里其实是**新旧两批同时在**"（退场中的刻度还没摘 —— `paintScale()` 的整批分支要 100~420ms）。
   ⚠️ 它读的是**派完事件当帧**的状态，所以"标签混着两批"是正常的、不是 bug。
   用法：LK_CDP_PORT=9346 node tools/e2e/probe-scale-zoom.cjs */
const PORT = process.env.LK_CDP_PORT || '9346';
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

  await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`);
  await sleep(1500);
  console.log('chain =', JSON.stringify(await ev(`(() => {
    const scale = document.querySelector('#lk-pane-timeline .tl-scale');
    const out = [];
    let n = scale;
    for (let i = 0; i < 5 && n; i++) { out.push(n.tagName + '.' + (n.className || '')); n = n.parentElement; }
    return out;
  })()`)));

  const zoom = await ev(`(async () => {
    const scale = document.querySelector('#lk-pane-timeline .tl-scale');
    const step = () => {
      const wrap = scale.parentElement;
      const r = wrap.getBoundingClientRect();
      wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, altKey: true, clientX: r.left + Math.round(r.width / 2), clientY: r.top + 40, bubbles: true, cancelable: true }));
      const majors = [...scale.querySelectorAll('.tl__axis-tick--major')];
      return { majors: majors.length, kids: scale.children.length,
        labels: majors.slice(0, 5).map((el) => el.querySelector('.tl__axis-label')?.textContent ?? ''),
        lefts: majors.slice(0, 3).map((el) => el.style.left) };
    };
    const rows = [step()];
    for (let i = 0; i < 9; i++) { await new Promise((r) => setTimeout(r, 260)); rows.push(step()); }
    return rows;
  })()`);
  console.log('zoom-out notches:');
  for (const r of zoom) console.log('  ', JSON.stringify(r));
  w.close();
}
main().catch((e) => { console.log('probe 异常 ' + (e && e.stack ? e.stack : e)); process.exit(2); });
