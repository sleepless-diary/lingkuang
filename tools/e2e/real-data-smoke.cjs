/* 真实数据（**副本**）冒烟 8 项：新构建能不能正常加载用户自己的世界、右栏能不能用，
 * 以及**有没有乱改文件**（改一条实体的一个字段，比对整座 vault 的 .md 哈希：只许动那一个文件）。
 *
 * ⚠️ 永远不要对着真实 vault 跑：本脚本会改数据。必须先把 `%APPDATA%\lingkuang\worldbuilding.json`
 * 与真实 vault **复制**到临时目录，再用 `LINGKUANG_TEST_DATA` / `LINGKUANG_VAULT` / `LINGKUANG_TEST_USERDATA`
 * 指向副本启动应用。跑法与用途见 `tools/e2e/README.md`「真实数据副本冒烟」一节。
 *
 * 用法：node tools/e2e/real-data-smoke.cjs <副本目录>   （应用需已用该目录起好）
 */
const fs = require('fs');
const path = require('path');
const DIR = process.argv[2];
const PORT = process.env.LK_CDP_PORT || '9440';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }
function hashes() {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out[path.relative(DIR, p)] = require('crypto').createHash('md5').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(path.join(DIR, 'vault'));
  return out;
}
async function main() {
  if (!DIR) { console.log('FAIL 需要副本目录参数'); process.exit(1); }
  const before = hashes();
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
  const send = (m2, p2) => new Promise((res) => { const i = ++id; pending.set(i, res); w.send(JSON.stringify({ id: i, method: m2, params: p2 })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  const waitFor = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(120); } return false; };
  const forceFrames = async (n = 3) => { for (let i = 0; i < n; i++) await send('Page.captureScreenshot', { format: 'jpeg', quality: 10 }); };
  const FIELDEL = (k) => `[...document.querySelectorAll('#cx-fields > div')].find((r) => r.firstElementChild?.textContent === ${JSON.stringify(k)})?.querySelector('input,textarea,select')`;

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  const worldName = await ev(`document.querySelector('.lk-world-tab, [data-world]')?.textContent || ''`);
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  await waitFor(() => ev(`!!document.querySelector('#cx-rail .lk-rail__row')`), 8000);
  await forceFrames(3);

  const rows = await ev(`[...document.querySelectorAll('[data-cx-id]')].map((b) => b.children[0]?.textContent)`);
  check('★1 真实世界的条目都列出来了（10 条）', rows.length >= 9, { 世界: worldName, 条目数: rows.length, 前几条: rows.slice(0, 4) });
  const railRows = await ev(`(() => [...document.querySelectorAll('#cx-rail .lk-rail__row')].map((r) => (r.querySelector('.lk-rail__n') || {}).textContent + '|' + (r.querySelector('.lk-rail__s') || {}).textContent))()`);
  check('★2 右栏帧条按真实节点画出来（1 列初稿 + 7 个事件，全部"还没有版本"）',
    railRows.length === 8 && railRows.slice(1).every((x) => x.includes('还没有版本')),
    { 格数: railRows.length, 头几格: railRows.slice(0, 3) });

  /* 选一条实体 → 点第 3 格 → 改一个字段（不改回来，用的是**副本**） */
  await ev(`(() => { const b = [...document.querySelectorAll('[data-cx-id]')].find((x) => x.children[0]?.textContent === '艾德温·霜冠'); if (b) b.click(); return true; })()`);
  await sleep(600); await forceFrames(2);
  const note0 = await ev(`[...document.querySelectorAll('#cx-body > div')].map((d) => d.textContent || '').find((t) => t.startsWith('正在看')) || ''`);
  check('★3 选中实体后能看到"正在看"哪一版（没有帧 ⇒ 初稿）', note0.includes('初稿'), note0);
  await ev(`document.querySelectorAll('#cx-rail .lk-rail__row')[2].click(); true`);
  await sleep(500); await forceFrames(2);
  const hint = await ev(`[...document.querySelectorAll('.lk-rail__hint')].map((h) => h.textContent).filter(Boolean).join(' / ')`);
  check('★4 点一个还没有版本的格子：底部写明"改动会改到初稿上"', hint.includes('改动会改到初稿上'), hint);
  const fieldKey = await ev(`(() => { const r = document.querySelector('#cx-fields > div'); return r ? r.firstElementChild?.textContent : null; })()`);
  const old = await ev(`${FIELDEL(fieldKey)}?.value`);
  await ev(`(() => { const el = ${FIELDEL(fieldKey)}; el.value = '冒烟测试值'; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(900); await forceFrames(3);
  const mid = hashes();
  const changed = Object.keys(mid).filter((k) => mid[k] !== before[k]);
  check('★5 在副本上改一个字段：确实写进了那一条实体的 .md（其余文件一个都没动）',
    changed.length === 1 && changed[0].includes('艾德温'),
    { 改了: changed, 字段: fieldKey, 原值: old });
  const text = fs.readFileSync(path.join(DIR, changed[0] || 'x'), 'utf8');
  check('★5b 写回时没有凭空加 `#演变：` 段（没有帧就不该有这个段）', !text.includes('#演变：'), text.slice(0, 60));
  check('★5c 正文段仍在（改字段不会伤正文）', text.includes('#正文：'), null);

  const errs = await ev(`window.__errs || []`);
  check('★6 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} PASS`);
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.message)); process.exit(1); });
