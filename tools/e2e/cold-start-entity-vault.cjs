/* 冷启动检查：重启后实体还在、类型还是「地点」、文件在 `_设定/地点/`。
   （修复前 writeVaultEntitySync 只清目标目录，旧文件残留 → 每次回扫把 typeId 打回旧类型） */
const fs = require('fs');
const path = require('path');
const VAULT = process.env.LINGKUANG_VAULT;
const PORT = process.env.LK_CDP_PORT || '9334';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  let target = null;
  for (let i = 0; i < 120; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (target) break; } catch {}
    await sleep(200);
  }
  if (!target) { console.log('FAIL 无法连接 CDP'); process.exit(1); }
  const w = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; });
  let id = 0; const pending = new Map();
  w.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); w.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
  await sleep(2500);
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  await sleep(1500);
  const list = await ev(`[...document.querySelectorAll('[data-cx-id]')].map((b) => ({ name: b.children[0]?.textContent, type: b.children[1]?.textContent }))`);
  const files = [];
  const walk = (d, rel = '') => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, rel + e.name + '/'); else files.push(rel + e.name); } };
  walk(path.join(VAULT, '测试世界观', '_设定'));
  const pass = Array.isArray(list) && list.length === 1 && list[0].type === '地点' && files.length === 1 && files[0] === '地点/银发少女.md';
  console.log(`${pass ? 'PASS' : 'FAIL'}  冷启动后实体=地点、文件在 _设定/地点/`);
  console.log('  UI:', JSON.stringify(list));
  console.log('  files:', JSON.stringify(files));
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(2); });
