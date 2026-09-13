/* 启动补写：升级前就存在的 JSON-only 实体，启动后（**不点任何东西**）应当被写成 vault 文件。
   回归目标：writeAll 只在 store 有改动时才触发 —— 少了启动这一趟，用户升级后打开应用
   在 Obsidian 里看不到任何实体文件（而这条链路的目的正是「实体在 Obsidian 里看得到」）。
   用法：先跑 seed-json-only-entity.cjs，再起应用，再跑本脚本。 */
const fs = require('fs');
const path = require('path');
const VAULT = process.env.LINGKUANG_VAULT;
const PORT = process.env.LK_CDP_PORT || '9334';
const WS = '测试世界观';
const ENT = path.join(VAULT, WS, '_设定', '角色', '只存在 JSON 的实体.md');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }
function walk(dir, rel = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, rel + e.name + '/'));
    else out.push(rel + e.name);
  }
  return out;
}
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
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);

  /* ★ 不点任何界面元素，只等它自己写出来 */
  let ok = false;
  for (let i = 0; i < 50 && !ok; i++) { ok = fs.existsSync(ENT); if (!ok) await sleep(200); }
  const text = ok ? fs.readFileSync(ENT, 'utf8') : '';
  check('★1 启动后自动写出 `_设定/角色/<名字>.md`（用户没点任何东西）', ok, ok ? text.split('\n').slice(0, 5) : walk(path.join(VAULT, WS)));
  check('2 frontmatter 保住了 id/name/type 与字段值', /^id: e-upgrade-1$/m.test(text) && /^name: 只存在 JSON 的实体$/m.test(text) && /^type: 角色$/m.test(text) && /^发色: 银白$/m.test(text), text.split('\n').slice(0, 6));
  check('3 正文（JSON 里的 doc）也搬进了文件', /#正文：/.test(text) && text.includes('我是升级前就有的实体'), text.slice(-40));

  /* 再等一轮重扫：自己写出来的文件不该被当成「外部改动」弹提示或把类型打回 */
  await sleep(3000);
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  await sleep(1200);
  const list = await ev(`[...document.querySelectorAll('[data-cx-id]')].map((b) => ({ name: b.children[0]?.textContent, type: b.dataset.cxType ?? b.children[1]?.textContent }))`);
  check('★5 设定库里实体在、类型是「角色」（回扫没把它打回去）', Array.isArray(list) && list.length === 1 && list[0].type === '角色', list);
  check('6 文件没有被重复写成第二份', walk(path.join(VAULT, WS, '_设定')).length === 1, walk(path.join(VAULT, WS, '_设定')));
  const errs = await ev(`window.__errs`);
  check('7 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const n = results.filter(Boolean).length;
  console.log(`\n==== ${n}/${results.length} PASS ====`);
  process.exit(n === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack || e)); process.exit(2); });
