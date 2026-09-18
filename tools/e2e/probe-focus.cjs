/* probe-focus.cjs —— 助手「看得到你正在编的那一条吗」实测（只读探针，不改数据） */
const PORT = process.env.LK_CDP_PORT || '9346';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* wait */ }
    if (!target) await sleep(200);
  }
  if (!target) { console.log('无法连接 CDP'); process.exit(1); }
  const w = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; });
  let seq = 0; const pending = new Map();
  w.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params) => new Promise((res) => { const id = ++seq; pending.set(id, res); w.send(JSON.stringify({ id, method, params: params || {} })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return 'ERR ' + r.result.exceptionDetails.text;
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const snap = () => ev(`(function () {
    const p = document.getElementById('lk-agent-panel');
    if (!p) return { open: false };
    const ctx = (document.getElementById('lk-agent-ctx') || {}).textContent || '';
    return {
      open: true,
      chip: (document.getElementById('lk-agent-focus') || {}).textContent || '',
      ctxLen: ctx.length,
      hasFocusBlock: ctx.indexOf('【创作者此刻打开的那一条') >= 0,
      focusLine: (ctx.split('\\n').find((l) => l.indexOf('【创作者此刻打开的那一条') >= 0) || ''),
      hasTimeline: ctx.indexOf('【当前时间线】') >= 0,
      hasEntities: ctx.indexOf('【设定】') >= 0,
    };
  })()`);
  const ctrlK = () => ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
  const tool = async (id) => { await ev(`document.querySelector('#lk-toolbar [data-tool="${id}"]').click(); true`); await sleep(1200); };

  await sleep(1500);
  console.log('--- A. 刚进工作台（还没点任何条目）---');
  await tool('codex');
  await ctrlK(); await sleep(400);
  console.log(JSON.stringify(await snap()));
  await ctrlK(); await sleep(300);

  console.log('--- B. 点中左树里的一条设定，再看 ---');
  console.log('clicked=' + await ev(`(function () { const r = document.querySelector('#cx-list [data-cx-id="e-e2e-1"]'); if (!r) return 'no-row'; r.click(); return 'ok'; })()`));
  await sleep(800);
  await ctrlK(); await sleep(400);
  console.log(JSON.stringify(await snap()));
  await ctrlK(); await sleep(300);

  console.log('--- C. 点中一条事件节点，再看 ---');
  console.log('clicked=' + await ev(`(function () { const r = document.querySelector('#cx-list [data-act="node"]'); if (!r) return 'no-node-row'; r.click(); return 'ok'; })()`));
  await sleep(900);
  await ctrlK(); await sleep(400);
  console.log(JSON.stringify(await snap()));
  await ctrlK(); await sleep(300);

  console.log('--- D. 切到别的工具（沙盘）后再问：还看得到吗 ---');
  await ev(`document.getElementById('lk-agent-close')?.click(); true`); await sleep(300);
  await tool('sandbox');
  await ctrlK(); await sleep(400);
  console.log(JSON.stringify(await snap()));
  await ctrlK(); await sleep(300);

  console.log('--- E. 切回工作台（不点任何条目）---');
  await tool('codex');
  await ctrlK(); await sleep(400);
  console.log(JSON.stringify(await snap()));

  process.exit(0);
}
main().catch((e) => { console.log('探针异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
