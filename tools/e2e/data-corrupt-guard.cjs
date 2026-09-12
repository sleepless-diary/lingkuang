/* 数据文件判损护栏（主进程 dataWriteLock + 壳级横幅）。
 *
 * 守的是 docs/BUGS.md 记的那条数据损失路径：解析失败的 worldbuilding.json 会被
 * 空数据静默覆盖（截断文件启动 → 400ms 防抖 → 文件变成「新世界」、零提示零报错）。
 *
 * 断言分四组：
 * ① 判损前**先重读**（attempts > 1）：竞态读到的半截不该被当成真损坏；
 * ② 判损即**上锁**：data:save 与退出前 flush 都得碰不到那个文件（writeDataFileSync 是唯一写入口）；
 * ③ **横幅**必须让用户看见，并给出「恢复」/「继续用新数据」两条明路；
 * ④ 点「继续用新数据」= 解锁 + 立刻落盘（自愈，下次启动不再弹）。
 *
 * 前置：node tools/e2e/seed-corrupt-data.cjs（同一次 pwsh 里先设好 LINGKUANG_TEST_DATA/VAULT）。 */
const fs = require('fs');
const path = require('path');

const DATA = process.env.LINGKUANG_TEST_DATA;
const PORT = process.env.LK_CDP_PORT || '9334';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, extra) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);
}
const readFile = () => fs.readFileSync(DATA, 'utf8');
const corruptCopies = () => {
  const dir = path.dirname(DATA);
  return fs.readdirSync(dir).filter((f) => f.startsWith('worldbuilding.bak-corrupt-')).map((f) => path.join(dir, f));
};

async function main() {
  if (!DATA) { console.log('FAIL 需要 LINGKUANG_TEST_DATA'); process.exit(1); }
  const before = readFile();   /* 播种时写进去的「半截」字节，全程拿它当基准 */

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
  async function waitFor(fn, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch { /* 读不到继续等 */ } await sleep(150); } return false; }

  await sleep(1200);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);

  /* ① 核心：原文件不得被覆盖。
     判损要重读 4 次（≈600ms）+ 落盘防抖 400ms，所以等 6 秒足够覆盖所有旧行为会写盘的时机。 */
  await sleep(6000);
  const after = readFile();
  check('★1 原数据文件未被覆盖（字节完全一致）', after === before, { before: Buffer.byteLength(before), after: Buffer.byteLength(after) });

  const copies = corruptCopies();
  check('★2 已隔离损坏副本（bak-corrupt）', copies.length === 1, copies.map((p) => path.basename(p)));
  check('★3 副本内容 == 原文件（逐字节）', copies.length === 1 && fs.readFileSync(copies[0], 'utf8') === before);

  /* ② 重读 + 上锁（直接问主进程，不靠差文件推断） */
  const st = await ev(`window.lingkuangAPI.dataCorruptState()`);
  check('★4 主进程已上锁（data:corrupt-state.locked）', st?.locked === true, { locked: st?.locked, bytes: st?.bytes, attempts: st?.attempts });
  check('★5 判损前重读过（attempts > 1）', (st?.attempts ?? 0) > 1, { attempts: st?.attempts, error: String(st?.error || '').slice(0, 60) });

  const saveRes = await ev(`window.lingkuangAPI.saveData({ worldsets: { 恶意覆盖: { name: '恶意覆盖' } } })`);
  check('★6 上锁期间 data:save 被拒且标明 locked', saveRes?.ok === false && saveRes?.locked === true, saveRes);
  check('★7 被拒之后文件依然没变', readFile() === before);

  /* ③ 横幅（壳级，任何工具下都在） */
  const banner = await ev(`(() => {
    const el = document.querySelector('#lk-alerts [data-alert="data-corrupt"]');
    if (!el) return null;
    const btns = [...el.querySelectorAll('.lk-alert-btn')];
    return {
      visible: getComputedStyle(document.getElementById('lk-alerts')).display !== 'none',
      title: el.querySelector('.lk-alert-title')?.textContent || '',
      body: el.querySelector('.lk-alert-body')?.textContent || '',
      buttons: btns.map((b) => b.textContent),
      primary: btns.filter((b) => b.classList.contains('is-primary')).map((b) => b.textContent),
    };
  })()`);
  check('★8 壳级横幅出现且可见', !!banner && banner.visible === true, banner && { title: banner.title, visible: banner.visible });
  check('★9 横幅有两个出口，主按钮是「去备份管理恢复」', banner?.buttons?.length === 2 && (banner?.primary?.[0] || '').includes('备份管理'), banner?.buttons);
  check('★10 横幅正文带上副本路径（用户能自己去找）', !!banner && banner.body.includes('bak-corrupt-'), (banner?.body || '').slice(-60));

  /* ④ 「继续用新数据」= 解锁 + 立刻落盘（自愈） */
  await ev(`[...document.querySelectorAll('#lk-alerts [data-alert="data-corrupt"] .lk-alert-btn')].find((b) => b.textContent.includes('继续用新数据')).click(); true`);
  const gone = await waitFor(() => ev(`document.querySelector('#lk-alerts [data-alert="data-corrupt"]') === null`));
  check('11 点「继续用新数据」后横幅消失', gone);
  const st2 = await ev(`window.lingkuangAPI.dataCorruptState()`);
  check('12 已解锁', st2?.locked === false, { locked: st2?.locked });
  const healed = await waitFor(() => { try { JSON.parse(readFile()); return true; } catch { return false; } });
  check('★13 解锁后文件被换成合法 JSON（自愈，下次启动不再弹）', healed, { bytes: Buffer.byteLength(readFile()) });
  const goodBytes = readFile();

  /* ⑤ 重读救援：文件「正在被写」时读到半截，不该判成损坏。
     手法：截断文件 → 在页面里**不 await** 地发起一次 loadData → 立刻把文件恢复完整。
     判损要等到第 4 次读（≈600ms）才下结论，所以中途恢复必然被后续重读捞到。
     跑三轮取一次成功的观测，避免 IPC 抖动导致首读就落在恢复之后（那时 attempts 会等于 1）。 */
  let recovery = null;
  for (let round = 0; round < 3 && !(recovery && recovery.ok && recovery.attempts > 1); round++) {
    fs.writeFileSync(DATA, goodBytes.slice(0, Math.floor(goodBytes.length * 0.5)), 'utf8');
    await ev(`window.__loadP = window.lingkuangAPI.loadData(); true`);
    await sleep(60);                       /* 让它先读到半截 */
    fs.writeFileSync(DATA, goodBytes, 'utf8');   /* 再补齐（模拟写入方完成） */
    recovery = await ev(`window.__loadP`);
  }
  check('★14 中途补全的文件能被重读捞回（不再误判损坏）', recovery?.ok === true && recovery?.attempts > 1, { ok: recovery?.ok, attempts: recovery?.attempts });
  check('15 救援后文件内容仍完整', (() => { try { return Object.keys(JSON.parse(readFile()).worldsets).length === 1; } catch { return false; } })());

  const errs = await ev(`window.__errs`);
  check('16 全程无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const ok = results.filter(Boolean).length;
  console.log(`\n==== ${ok}/${results.length} PASS ====`);
  process.exit(ok === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.message)); process.exit(2); });
