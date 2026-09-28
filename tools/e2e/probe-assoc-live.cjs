/* probe-assoc-live.cjs —— 端到端确认：把**真实的**当前供应商灌进隔离测试实例的 localStorage，
 * 在真界面里点一次「语义联想」，读真实状态行与画布上的词（不是回放假响应）。
 *
 * 为什么要有它：`assoc-reasoning.cjs` 的 `fetch` 是回放的 —— 证明得了"接得住"，证明不了"用户那台配置真的好使"。
 * 这一支不打桩：真端点、真模型，看状态行是不是「联想 N 词」。
 *   · key 从 leveldb 读进内存就发出去，**一律不打印**（只露末 4 位）。
 *   · 只写测试实例（隔离 userdata）的 localStorage，不碰用户的正式实例与数据。
 *
 * 跑（测试实例须在 `--remote-debugging-port=9500` 上跑着，见 tools/e2e/README.md）：
 *   node tools\e2e\probe-assoc-live.cjs [输入词]
 * 判据：末行 `LIVE OK`，状态行 `「X」联想 N 词`、画布子词 ≥1。 */
const fs = require('fs');
const path = require('path');
const PORT = '9500';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jsonSlice(s) {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let k = start; k < s.length; k++) {
    const c = s[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(start, k + 1); }
  }
  return null;
}
function readSettings() {
  const dir = path.join(process.env.APPDATA, 'lingkuang', 'Local Storage', 'leveldb');
  let last = null;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(log|ldb)$/.test(f)) continue;
    const buf = fs.readFileSync(path.join(dir, f));
    const needle = Buffer.from('{"providers"', 'utf16le');
    let i = -1;
    while ((i = buf.indexOf(needle, i + 1)) !== -1) {
      const js = jsonSlice(buf.slice(i, i + 6000).toString('utf16le'));
      if (js) { try { last = JSON.parse(js); } catch { /* 半截，跳过 */ } }
    }
  }
  if (!last) throw new Error('没读到真实 lingkuang-settings');
  return last;
}

(async () => {
  const word = process.argv[2] || '雪原';
  const settings = readSettings();
  const p = settings.providers.find((x) => x.id === settings.activeProvider);
  console.log(`把真实供应商灌进测试实例：${p.name} · ${p.kind} · ${p.model} · key=${p.apiKey ? '***' + p.apiKey.slice(-4) : '(空)'}`);

  let target = null;
  for (let i = 0; i < 60; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (target) break; } catch {}
    await sleep(200);
  }
  if (!target) throw new Error('CDP 没上');
  const w = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; });
  let id = 0; const pending = new Map();
  w.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (m, params) => new Promise((res) => { const i = ++id; pending.set(i, res); w.send(JSON.stringify({ id: i, method: m, params })); });
  const evSoft = async (expr) => { try { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; } catch { return undefined; } };

  await send('Page.enable', {});
  await evSoft(`localStorage.setItem('lingkuang-settings', ${JSON.stringify(JSON.stringify(settings))}); true`);
  await send('Page.reload', {});
  for (let i = 0; i < 80 && !(await evSoft(`!!document.querySelector('[data-tool="inspire"]')`)); i++) await sleep(200);
  await evSoft(`document.querySelector('[data-tool="inspire"]').click(); true`);
  for (let i = 0; i < 60 && !(await evSoft(`!!document.querySelector('#assoc-stage')`)); i++) await sleep(200);

  await evSoft(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await evSoft(`document.querySelector('#insp-assoc').assocSetRoot(${JSON.stringify(word)}); true`);
  console.log('已在真界面里点了「' + word + '」，等真实模型回话…');
  let status = '';
  for (let i = 0; i < 120; i++) {
    status = (await evSoft(`(document.querySelector('#assoc-status') || {}).textContent || ''`)) || '';
    if (/联想 [0-9]+ 词|失败|还没配|请先输入/.test(status)) break;
    await sleep(500);
  }
  await sleep(1200);
  const st = await evSoft(`(() => { const els = [...document.querySelectorAll('#assoc-world .assoc__node')];
    return { status: (document.querySelector('#assoc-status') || {}).textContent, nodes: els.length,
      words: els.map((e) => e.textContent), errs: window.__errs || [] }; })()`);
  console.log('状态行 = ' + JSON.stringify(st.status));
  console.log('画布子词 = ' + st.nodes + ' 个 ' + JSON.stringify(st.words));
  console.log('未捕获异常 = ' + JSON.stringify(st.errs));
  console.log(st.nodes > 0 ? 'LIVE OK：真配置下语义联想已经能出词' : 'LIVE FAIL：还是没词');
  process.exit(0);
})().catch((e) => { console.log('探针异常：' + (e && e.stack ? e.stack : e)); process.exit(1); });
