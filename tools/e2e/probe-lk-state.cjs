/* 通用探针：**一眼看清渲染进程此刻的沙盘状态**（排查"节点没出来/在哪个视图"这类问题）。
   打印：世界与时间线页签、状态区文案、剧情线下拉、刻度标签范围、节点数、因果线数、
         各宿主元素的存在与子元素数、当前会话存档。
   用法：LK_CDP_PORT=9346 node tools/e2e/probe-lk-state.cjs */
const PORT = process.env.LK_CDP_PORT || '9346';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  let target = null;
  for (let i = 0; i < 60; i++) {
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
    if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description || '') };
    return r.result?.result?.value;
  };
  const out = await ev(`(() => {
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];
    const pane = q('#lk-pane-timeline');
    const tickLabs = qa('#lk-pane-timeline .tl__axis-tick--major .tl__axis-label').map((e) => e.textContent);
    return {
      tool: qa('.lk-tool-btn.is-active, [data-tool].is-active').map((e) => e.dataset.tool || e.textContent.trim()),
      paneExists: !!pane,
      paneShown: pane ? getComputedStyle(pane).display : null,
      stateArea: q('#lk-state') ? q('#lk-state').textContent.trim() : null,
      lineSel: q('#lk-line-sel') ? { exists: true, value: q('#lk-line-sel').value, text: q('#lk-line-sel').selectedOptions?.[0]?.textContent } : { exists: false },
      tabs: qa('#lk-tabs > *').map((e) => e.textContent.trim()),
      worlds: qa('.lk-world').map((e) => e.textContent.trim()),
      trackKids: pane ? qa('#lk-pane-timeline .tl-track > *').length : null,
      trackIds: qa('#lk-pane-timeline .tl-track [data-id]').map((e) => e.dataset.id + '@' + e.style.left),
      nodesAll: document.querySelectorAll('.tl__n').length,
      paths: qa('#lk-pane-timeline .tl-causes path').length,
      pathMarkers: qa('#lk-pane-timeline .tl-causes path[marker-end]').length,
      ticks: qa('#lk-pane-timeline .tl-scale .tl__axis-tick').length,
      major: tickLabs.length, tickLabs: tickLabs.slice(0, 12),
      wrapRect: q('#lk-pane-timeline .tl-wrap') ? JSON.stringify(q('#lk-pane-timeline .tl-wrap').getBoundingClientRect()) : null,
      session: (() => { try { return localStorage.getItem('lingkuang-session'); } catch (e) { return 'err'; } })(),
      errs: window.__errs || null,
    };
  })()`);
  console.log(JSON.stringify(out, null, 2));
  w.close();
  process.exit(0);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
