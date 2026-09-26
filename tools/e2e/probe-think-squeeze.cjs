/* probe-think-squeeze.cjs（第二版）—— 用**长思考**把「只看得见标题」的量出来
 *
 * 机制：`#lk-agent-msgs`（`.lk-agent__msgs`）= `display:flex; flex-direction:column; overflow-y:auto`，
 * 而 `.lk-think__body` 带 `max-height:240px; overflow-y:auto` —— 弹性项里 `overflow !== visible` 的
 * 自动最小尺寸退化成 0 ⇒ 列表一长，`details.lk-think` 被压到只剩标题高度，正文（240px）**溢出到盒外**，
 * 被后面画的正文气泡盖住 ⇒ 屏幕上只剩一行「思考 · N 字」。用户的面板有 21 条历史，我的第一版探针
 * 只有 1 条（不溢出）所以看着正常。全程假引擎（不花钱）。
 *
 * 跑：$env:LK_CDP_PORT=9346; node tools\e2e\probe-think-squeeze.cjs
 */
const PORT = process.env.LK_CDP_PORT || '9346';
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
  w.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params) => new Promise((res) => { const id = ++seq; pending.set(id, res); w.send(JSON.stringify({ id, method, params: params || {} })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const ex = r.result && r.result.exceptionDetails;
    if (ex) throw new Error('eval: ' + ((ex.exception && ex.exception.description) || ex.text));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await sleep(1500);
  await ev('(function () { const b = document.querySelector("#lk-toolbar [data-tool=\\"codex\\"]"); if (b) b.click(); return true; })()');
  await sleep(1500);
  await ev('(function () { const r = document.querySelector("#cx-list [data-cx-id]"); if (r) r.click(); return true; })()');
  await sleep(500);
  await ev('window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })); true');
  await sleep(900);
  const ask = async (text) => {
    await ev('(function () { const t = document.getElementById("lk-agent-input"); t.value = ' + JSON.stringify(text) + '; document.getElementById("lk-agent-send").click(); return true; })()');
  };

  const geom = () => ev(`(function () {
    const box = document.getElementById('lk-agent-msgs');
    const ts = [...document.querySelectorAll('#lk-agent-msgs .lk-think')];
    const t = ts.length ? ts[ts.length - 1] : null;
    const boxR = box ? box.getBoundingClientRect() : null;
    if (!t) return { thinkN: ts.length, overflow: box ? (box.scrollHeight > box.clientHeight + 1) : null, thinkH: -1 };
    const det = t.getBoundingClientRect();
    const body = t.querySelector('.lk-think__body');
    const br = body ? body.getBoundingClientRect() : null;
    const sum = t.querySelector('.lk-think__sum');
    const sr = sum ? sum.getBoundingClientRect() : null;
    /* 紧跟其后的正文气泡：它若压住 body 的矩形 ⇒ 思考过程被盖住（后画的元素在上面） */
    const next = t.nextElementSibling;
    const nr = next ? next.getBoundingClientRect() : null;
    const overlap = (br && nr) ? Math.max(0, Math.round(Math.min(br.bottom, nr.bottom) - Math.max(br.top, nr.top))) : 0;
    return {
      thinkN: ts.length, overflow: box ? (box.scrollHeight > box.clientHeight + 1) : null,
      boxH: box ? Math.round(boxR.height) : -1,
      thinkH: Math.round(det.height), sumH: sr ? Math.round(sr.height) : -1,
      bodyH: br ? Math.round(br.height) : -1,
      bodyClientH: body ? body.clientHeight : -1, bodyScrollH: body ? body.scrollHeight : -1,
      bodyTxtLen: body ? (body.textContent || '').length : -1,
      nextTag: next ? (next.className || next.tagName) : '(无)',
      nextTop: nr ? Math.round(nr.top - det.top) : -1,
      overlapPx: overlap,
      /* 正文矩形有没有溢出 details 的盒子（有 = 被压塌） */
      spillPx: br ? Math.round(br.bottom - det.bottom) : -1,
    };
  })()`);

  console.log('== ① 灌 6 条长消息把列表撑溢出 ==');
  const LONG = '这是一段用来撑高度的正文。'.repeat(40);
  for (let i = 1; i <= 6; i++) {
    await ev('window.__lkAgentMock = ' + JSON.stringify('[灌历史 ' + i + '] ' + LONG) + '; true');
    await ask('灌历史 ' + i);
    await sleep(700);
  }
  console.log('溢出后: ' + JSON.stringify(await geom()));

  console.log('== ② 发一条「长思考」（假引擎，约 2400 字，分 8 片）==');
  const piece = '让我把这件事想清楚：先看用户到底要什么，再看手里有哪些线索，然后把它们一条条对起来。';
  const RSN = [];
  for (let i = 0; i < 8; i++) RSN.push(piece);
  await ev('window.__lkAgentMock = { chunks: ["结论如下。"], reasoning: ' + JSON.stringify(RSN) + ', gap: 260 }; true');
  await ask('带长思考再说一次。');
  for (let i = 0; i < 12; i++) {
    await sleep(400);
    const g = await geom();
    console.log('  t+' + ((i + 1) * 0.4).toFixed(1) + 's ' + JSON.stringify(g));
    if (g.bodyTxtLen > 1200) break;
  }
  await sleep(1600);
  const fin = await geom();
  console.log('== ③ 落定后 ==');
  console.log(JSON.stringify(fin));
  const squeezed = fin.thinkH > 0 && fin.sumH > 0 && fin.thinkH <= fin.sumH + 6;
  console.log(squeezed
    ? 'REPRO 复现：details 高 ' + fin.thinkH + 'px ≈ 只有标题（' + fin.sumH + 'px），正文 ' + fin.bodyH + 'px 溢出 '
      + fin.spillPx + 'px、与下一个气泡重叠 ' + fin.overlapPx + 'px ⇒ 过程被盖住，屏幕上只剩标题'
    : 'OK 没复现：details 高 ' + fin.thinkH + 'px、正文 ' + fin.bodyH + 'px、溢出 ' + fin.spillPx + 'px');
  process.exit(0);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : String(e))); process.exit(2); });
