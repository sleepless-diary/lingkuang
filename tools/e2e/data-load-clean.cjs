/* 误报守卫：**正常**数据文件启动时，判损护栏一步都不该动。
 *
 * 为什么值得单列一条：护栏的全部价值建立在「只在真损坏时触发」上。判损会暂停写盘、
 * 弹原生对话框、在顶部压一条横幅 —— 一次误报就等于让用户在一个半只读的应用里工作。
 * 这里断言的就是那三件事都没发生，且写盘通路照常。
 *
 * 前置：一个合法的 worldbuilding.json（跑 tools/e2e/seed-node.cjs 即可，它会写这份文件）。 */
const fs = require('fs');

const DATA = process.env.LINGKUANG_TEST_DATA;
const PORT = process.env.LK_CDP_PORT || '9334';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, extra) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);
}

async function main() {
  if (!DATA) { console.log('FAIL 需要 LINGKUANG_TEST_DATA'); process.exit(1); }
  const before = fs.readFileSync(DATA, 'utf8');

  let target = null;
  for (let i = 0; i < 120; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  if (!target) { console.log('FAIL 无法连接 CDP'); process.exit(1); }
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

  await sleep(2500);

  const st = await ev(`window.lingkuangAPI.dataCorruptState()`);
  check('★1 干净数据未被判损（locked=false）', st?.locked === false, { locked: st?.locked, corruptPath: st?.corruptPath });

  const ld = await ev(`window.lingkuangAPI.loadData()`);
  check('★2 一次就读通（attempts === 1，没有多余重读）', ld?.ok === true && ld?.attempts === 1, { ok: ld?.ok, attempts: ld?.attempts });

  const banner = await ev(`document.querySelector('#lk-alerts [data-alert="data-corrupt"]') === null && getComputedStyle(document.getElementById('lk-alerts')).display === 'none'`);
  check('★3 没有判损横幅（#lk-alerts 保持隐藏）', banner === true);

  const copies = fs.readdirSync(require('path').dirname(DATA)).filter((f) => f.startsWith('worldbuilding.bak-corrupt-'));
  check('★4 没有凭空生成损坏副本', copies.length === 0, copies);

  /* 写盘通路照常：把刚读到的数据原样存回去 —— 既证明锁没拦住写，又不动坏任何东西
     （不改内容，所以这条可以随时跑，不影响同一实例里其它测试的前置）。 */
  const saved = await ev(`window.lingkuangAPI.saveData(${JSON.stringify(ld.data)})`);
  check('★5 干净数据下 data:save 正常放行', saved?.ok === true, saved);
  const after = fs.readFileSync(DATA, 'utf8');
  let stillOk = false;
  try { stillOk = !!JSON.parse(after).worldsets?.['测试世界观']; } catch { stillOk = false; }
  check('★6 存回去的还是合法 JSON 且没丢世界', stillOk, { before: before.length, bytes: after.length });

  const ok = results.filter(Boolean).length;
  console.log(`\n==== ${ok}/${results.length} PASS ====`);
  process.exit(ok === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.message)); process.exit(2); });
