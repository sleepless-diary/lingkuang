/* 探针：打印标尺（`.tl-scale`）与聚焦下拉的当下状态。
   用途 = 在动手改 renderScale（第 ⑤ 片：刻度出入场）之前，先确认"页面里到底有什么"：
   有没有 `#lk-line-sel`（没有剧情线时它可能压根不渲染 ⇒「切全览」那条路走不通）、
   主/小刻度/断口各几条、wrap 有多宽、当前标签是什么档。
   用法：LK_CDP_PORT=9346 node tools/e2e/probe-scale.cjs [额外表达式] */
const PORT = process.env.LK_CDP_PORT || '9346';
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

  await sleep(1200);
  await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`);
  await sleep(1200);

  const info = await ev(`(() => {
    const pane = document.querySelector('#lk-pane-timeline');
    const scale = pane?.querySelector('.tl-scale');
    const wrap = pane?.querySelector('.tl-wrap') || pane;
    const sel = document.getElementById('lk-line-sel');
    const majors = [...(scale?.querySelectorAll('.tl__axis-tick--major') ?? [])];
    return {
      hasSel: !!sel,
      selOptions: sel ? [...sel.options].map((o) => o.value + '|' + o.textContent) : null,
      hasScale: !!scale,
      scaleChildren: scale ? scale.children.length : null,
      major: majors.length,
      minor: scale ? scale.querySelectorAll('.tl__axis-tick--minor').length : null,
      cuts: scale ? scale.querySelectorAll('.tl__axis-cut').length : null,
      labels: majors.map((el) => el.querySelector('.tl__axis-label')?.textContent ?? ''),
      lefts: majors.map((el) => Math.round(parseFloat(el.style.left) || 0)),
      wrapW: wrap ? wrap.clientWidth : null,
      nonlinear: !!document.querySelector('#lk-nonlinear.is-on') || !!document.querySelector('#lk-nonlinear'),
      stateHtml: (document.getElementById('lk-state')?.textContent ?? '').slice(0, 80),
      focus: document.hasFocus(), vis: document.visibilityState,
    };
  })()`);
  console.log(JSON.stringify(info, null, 2));

  const extra = process.argv[2];
  if (extra) console.log('extra =', JSON.stringify(await ev(extra)));
  w.close();
  process.exit(0);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
