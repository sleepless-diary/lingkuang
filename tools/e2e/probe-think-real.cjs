/* probe-think-real.cjs —— 用**真端点**验证「思考」这块（不是假引擎）
 *
 * 为什么要有它：`agent-stream.cjs` 的 ★6~★9 用的是假引擎分片（`__lkAgentMock.reasoning`），
 * 那只证明"我们这一侧接得住"。用户报的是「看不到他的思考」⇒ 还得证明**真端点的字段名/流式形状**
 * 被认出来了。本地 Ollama 的 qwen3 是**真会思考**的模型（`message.thinking` 一路流式吐），
 * 所以拿它做一次端到端：把测试实例的供应商指到 `localhost:11434` + `qwen3:14b`，真发一句，
 * 看屏幕上那块「思考」有没有真的被 reasoning 填满。
 *
 * 跑（干净实例 + 工作台）：
 *   $env:LK_CDP_PORT=9346; node tools\e2e\probe-think-real.cjs [模型名]
 * 输出：逐次采样的 { has, open, live, len, head }，最后一行是结论。
 * ⚠️ 14B 模型第一次要加载权重，可能等 30~60 秒（这里等到 150 秒）。
 */
const PORT = process.env.LK_CDP_PORT || '9346';
const MODEL = process.argv[2] || 'qwen3:14b';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
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

  /* 供应商指到本地 Ollama（设置住在 localStorage；写完 reload 让它生效） */
  const CFG = {
    providers: [{ id: 'pv-probe', name: '本地 Ollama', preset: 'ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', apiKey: '', model: MODEL }],
    activeProvider: 'pv-probe',
  };
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
  console.log('实例就绪:', JSON.stringify(up));

  const snap = () => ev(`(function () {
    const ts = [...document.querySelectorAll('#lk-agent-msgs .lk-think')];
    const t = ts.length ? ts[ts.length - 1] : null;
    const n = document.getElementById('lk-agent-note');
    const body = t ? t.querySelector('.lk-think__body') : null;
    const txt = body ? (body.textContent || '') : '';
    return {
      has: !!t, n: ts.length, open: t ? t.open : null, live: t ? t.classList.contains('is-live') : null,
      len: txt.length, head: txt.slice(0, 100),
      note: n ? n.textContent : '',
    };
  })()`);

  await ev('(function () { const t = document.getElementById("lk-agent-input"); t.value = "用一句话说明：为什么天空是蓝的？"; document.getElementById("lk-agent-send").click(); return true; })()');
  let last = null;
  let sawLive = false;
  for (let i = 0; i < 75; i++) {
    await sleep(2000);
    last = await snap();
    if (last.live === true) sawLive = true;
    if (i % 3 === 0 || last.len > 0) console.log(`  t+${(i + 1) * 2}s`, JSON.stringify(last));
    if (last.has && last.live === false && last.len > 0) break;
    if (last.note && last.note.indexOf('出错') >= 0) break;
  }
  const ok = !!last && last.has === true && last.len > 20;
  console.log(ok ? 'PASS 真端点的思考已经显示在屏幕上（' + last.len + ' 字）' : 'FAIL 没看到思考: ' + JSON.stringify(last));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : String(e)));
  process.exit(2);
});
