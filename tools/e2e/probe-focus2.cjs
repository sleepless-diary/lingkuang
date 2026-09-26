/* probe-focus2.cjs —— 用真实模型复现用户那句「主要是哪个文件」（不改数据，只问） */
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
  const bubbles = () => ev(`[...document.querySelectorAll('#lk-agent-msgs .lk-agent__bubble')].map((b) => b.textContent)`);
  const ask = async (text, waitMs) => {
    await ev(`(function () { const t = document.getElementById('lk-agent-input'); t.value = ${JSON.stringify(text)}; document.getElementById('lk-agent-send').click(); return true; })()`);
    const t0 = Date.now();
    let last = '';
    while (Date.now() - t0 < waitMs) {
      await sleep(1000);
      const b = await bubbles();
      const tail = b.length ? b[b.length - 1] : '';
      if (tail && tail === last && (await ev(`(document.getElementById('lk-agent-note') || {}).textContent || ''`)).indexOf('正在思考') < 0) return tail;
      last = tail;
    }
    return '(超时) ' + last;
  };

  await sleep(1500);
  console.log('引擎：' + await ev(`(document.getElementById('lk-agent-model') || {}).textContent || '(面板未开)'`));
  await ev(`document.querySelector('#lk-toolbar [data-tool="codex"]').click(); true`);
  await sleep(1500);
  await ev(`document.querySelector('#cx-list [data-cx-id]').click(); true`);
  await sleep(900);
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
  await sleep(500);
  console.log('焦点 chip = ' + JSON.stringify(await ev(`(document.getElementById('lk-agent-focus') || {}).textContent || ''`)));
  const ctx = await ev(`(document.getElementById('lk-agent-ctx') || {}).textContent || ''`);
  console.log('上下文预览里有没有「这一刻打开的那一条」= ' + (ctx.indexOf('【创作者此刻打开的那一条') >= 0));
  console.log('上下文预览 = ' + ctx.slice(0, 400));
  console.log('---- 问：修改当前面板的文件 ----');
  console.log(await ask('修改当前面板的文件', 90000));
  console.log('---- 问：主要是哪个文件 ----');
  console.log(await ask('主要是哪个文件', 90000));
  process.exit(0);
}
main().catch((e) => { console.log('探针异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
