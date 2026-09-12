/* 冷启动复核：重启后空时间线还在不在（原始症状就是"重启后消失"）。
 *
 * 承接 timeline-persist.cjs 的收尾状态：主线目录被外部删掉（应保持消失），
 * 副线 / 支线（0 节点） / 第四条（0 节点）都应还在。
 *
 * 用法：跑完 timeline-persist.cjs → 重启应用 → 跑本脚本。
 */
const fs = require('fs');
const DATA = process.env.LINGKUANG_TEST_DATA;
const WS = '测试世界观';
const PORT = process.env.LK_CDP_PORT || '9334';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }

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
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const tabs = () => ev(`[...document.querySelectorAll('.lk-tl-tabs > .lk-tl-tab[data-tl]')].map((b) => b.textContent)`);

  await sleep(2000);
  const t = await tabs();
  check('★1 重启后两条**空时间线**（支线 / 新时间线）都还在', Array.isArray(t) && t.some((x) => x.includes('支线')) && t.some((x) => x.includes('新时间线')), t);
  check('★2 对照：有节点的「副线」在，被外部删掉目录的「主线」不在（不复活）',
    Array.isArray(t) && t.some((x) => x.includes('副线')) && !t.some((x) => x.includes('主线')), t);

  const disk = (() => { try { return JSON.parse(fs.readFileSync(DATA, 'utf8')).worldsets[WS]; } catch { return null; } })();
  const names = Object.values(disk?.timelines ?? {}).map((x) => x.name);
  /* 注：JSON 里可能还留着「主线」—— 文件是缓存，只有发生写盘才收敛；界面已经按 vault 把它去掉了（★2）。
     保留着反而是好事：用户从回收站恢复那个目录时，时间线级的 loops/storylines 还能一起回来。 */
  check('★3 盘上文件里两条空时间线都在（没被反复抹）', names.includes('支线') && names.includes('新时间线'), names);

  const n = results.filter(Boolean).length;
  console.log(`\n==== ${n}/${results.length} PASS ====`);
  process.exit(n === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack || e)); process.exit(2); });
