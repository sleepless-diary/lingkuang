/* probe-think-deepseek.cjs —— 用**用户正式应用里那把 DeepSeek key** 在隔离实例上真复现
 * 「只用 DeepSeek 时看不到思考过程」（用户 2026-09-26 报的第二轮）。
 *
 * key 来源：`process.env.LK_KEY`，没给就从用户正式应用的 localStorage 里读**最新一份**设置
 * （`%APPDATA%\lingkuang\Local Storage\leveldb`，Chromium 的值是 UTF-16；同一条键在 .log 里
 *  会有多份历史值 ⇒ 必须取最后一份）。**任何输出都不打印 key。** key 只写进测试实例的隔离 userdata，
 * 跑完由 runner 清掉。
 *
 * 逐帧看的是**屏幕上真的长什么样**：思考块在不在/摊没摊开/有没有在长、AI 气泡此刻是"正在思考…"
 * 占位还是正文、底部 note 说了什么。用法：
 *   $env:LK_CDP_PORT=9346; node tools\e2e\probe-think-deepseek.cjs
 */
const fs = require('fs');
const PORT = process.env.LK_CDP_PORT || '9346';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function braceMatch(text, start) {
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start, j + 1); }
  }
  return null;
}
function readUserSettings() {
  const dir = process.env.APPDATA + '\\lingkuang\\Local Storage\\leveldb';
  const files = fs.readdirSync(dir).filter((f) => /\.(log|ldb)$/.test(f))
    .map((f) => ({ f, m: fs.statSync(dir + '\\' + f).mtimeMs })).sort((a, b) => a.m - b.m);
  const found = [];
  for (const { f } of files) {
    const buf = fs.readFileSync(dir + '\\' + f);
    for (const t of [buf.toString('utf16le'), Buffer.concat([Buffer.from([0]), buf]).toString('utf16le'), buf.toString('latin1')]) {
      let from = 0;
      for (;;) {
        const i = t.indexOf('"providers"', from);
        if (i < 0) break;
        from = i + 1;
        for (let s = i; s > Math.max(0, i - 4000); s--) {
          if (t[s] !== '{') continue;
          const cand = braceMatch(t, s);
          if (!cand) continue;
          try { const o = JSON.parse(cand); if (o && Array.isArray(o.providers)) { found.push(o); break; } } catch { /* next */ }
        }
      }
    }
  }
  if (!found.length) return null;
  const cfg = found[found.length - 1];
  return cfg.providers.find((p) => p.id === cfg.activeProvider) || cfg.providers.find((p) => p.kind === 'openai') || cfg.providers[0];
}

async function main() {
  let prov = null;
  if (process.env.LK_KEY) {
    prov = { id: 'pv-probe', name: 'DeepSeek', preset: 'custom', kind: 'openai', baseUrl: process.env.LK_BASE || 'https://api.deepseek.com/v1', apiKey: process.env.LK_KEY, model: process.env.LK_MODEL || 'deepseek-flash' };
  } else {
    prov = readUserSettings();
    if (!prov) { console.log('FAIL 取不到供应商（也没有 LK_KEY）'); process.exit(1); }
    prov = { id: 'pv-probe', name: prov.name, preset: 'custom', kind: prov.kind, baseUrl: prov.baseUrl, apiKey: prov.apiKey, model: prov.model };
  }
  console.log('用供应商: ' + prov.name + ' / ' + prov.model + ' / ' + prov.baseUrl + ' / kind=' + prov.kind + ' / key=' + (prov.apiKey ? '已读到（len ' + prov.apiKey.length + '，不打印）' : '（空）'));

  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* 还没起来 */ }
    if (!target) await sleep(200);
  }
  if (!target) { console.log('FAIL 无法连接 CDP ' + PORT); process.exit(1); }
  const w = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  w.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  const send = (method, params) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    w.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const ex = r.result && r.result.exceptionDetails;
    if (ex) throw new Error('eval: ' + ((ex.exception && ex.exception.description) || ex.text));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  const CFG = { providers: [prov], activeProvider: 'pv-probe' };
  await sleep(1500);
  await ev('localStorage.setItem("lingkuang-settings", ' + JSON.stringify(JSON.stringify(CFG)) + '); true');
  await ev('location.reload(); true');
  await sleep(3500);
  await ev('(function () { const b = document.querySelector("#lk-toolbar [data-tool=\\"codex\\"]"); if (b) b.click(); return true; })()');
  await sleep(1500);
  await ev('(function () { const r = document.querySelector("#cx-list [data-cx-id]"); if (r) r.click(); return true; })()');
  await sleep(500);
  await ev('(function () { const b = document.getElementById("lk-agent-close"); if (b) b.click(); return true; })()');
  await sleep(400);
  await ev('window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })); true');
  await sleep(900);
  const up = await ev('({ panel: !!document.getElementById("lk-agent-msgs"), chip: (function () { const c = document.getElementById("lk-agent-model"); return c ? c.textContent : ""; })() })');
  console.log('实例就绪: ' + JSON.stringify(up));

  const snap = () => ev(`(function () {
    const ts = [...document.querySelectorAll('#lk-agent-msgs .lk-think')];
    const t = ts.length ? ts[ts.length - 1] : null;
    const body = t ? t.querySelector('.lk-think__body') : null;
    const sum = t ? t.querySelector('.lk-think__sum') : null;
    const txt = body ? (body.textContent || '') : '';
    const bs = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')];
    const b = bs.length ? bs[bs.length - 1] : null;
    const n = document.getElementById('lk-agent-note');
    return {
      thinkN: ts.length, has: !!t, open: t ? t.open : null, live: t ? t.classList.contains('is-live') : null,
      tlen: txt.length, thead: txt.slice(0, 60), sum: sum ? sum.textContent : '',
      bubLen: b ? (b.textContent || '').length : -1,
      wait: b ? !!b.querySelector('.lk-md__wait') : null,
      bubHead: b ? (b.textContent || '').slice(0, 40) : '',
      note: n ? n.textContent : '',
    };
  })()`);

  await ev('(function () { const t = document.getElementById("lk-agent-input"); t.value = "算一下 12×13，一步步说。"; document.getElementById("lk-agent-send").click(); return true; })()');
  let last = null, sawThinkLive = false, maxT = 0, sawWait = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    last = await snap();
    if (last.live === true && last.tlen > 0) sawThinkLive = true;
    if (last.wait === true) sawWait = true;
    maxT = Math.max(maxT, last.tlen);
    if (i % 2 === 0 || last.tlen > 0) console.log(`  t+${i + 1}s ` + JSON.stringify(last));
    if (last.note && last.note.indexOf('出错') >= 0) break;
    if (last.has && last.live === false && last.tlen > 0) break;
    if (i > 8 && last.wait === false && last.bubLen > 40 && !last.live) break;
  }
  console.log('---- 结论 ----');
  console.log('思考块最终长度 ' + maxT + ' / 生成中见过它在长 ' + sawThinkLive + ' / 见过占位「正在思考…」 ' + sawWait);
  console.log(JSON.stringify(last));
  const ok = maxT > 20;
  console.log(ok ? 'PASS 真端点（' + prov.model + '）的思考显示在屏幕上' : 'FAIL 思考没显示出来');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : String(e)));
  process.exit(2);
});
