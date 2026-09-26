/* probe-greens-shot.cjs —— 把助手面板「生成中」那一屏**截下来看**，并打印所有 accent 绿元素的几何/颜色
 *
 * 目的（用户 2026-09-26）：「怎么又用到了荧光绿的颜色，两个都是高亮度我有点难分辨」——
 * 这一屏上同时活着的 accent 绿候选有三个：
 *   ① `.lk-agent.is-agent .lk-agent__title::before`   6px 静态圆点（标题前，= Agent 模式）
 *   ② `.lk-think.is-live > .lk-think__sum::after`     5px 闪烁圆点（思考标题后，= 还在想）
 *   ③ `.lk-md__caret`                                 2px 闪烁竖条（流式正文末尾）
 * 光读 CSS 分不清他说的是哪两个 ⇒ 截一屏 2x 图看清它们**同时**在场时的样子。
 *
 * 跑：$env:LK_CDP_PORT=9346; node tools\e2e\probe-greens-shot.cjs   （假引擎，不花钱）
 */
const PORT = process.env.LK_CDP_PORT || '9346';
const fs = require('fs');
const path = require('path');
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
  await send('Page.enable', {});

  await sleep(1500);
  await ev('(function () { const b = document.querySelector("#lk-toolbar [data-tool=\\"codex\\"]"); if (b) b.click(); return true; })()');
  await sleep(1500);
  await ev('(function () { const r = document.querySelector("#cx-list [data-cx-id]"); if (r) r.click(); return true; })()');
  await sleep(400);
  await ev('window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })); true');
  await sleep(900);
  /* 切到 Agent 模式：这时标题前那颗静态绿点才会出现（与思考的闪烁绿点同屏） */
  await ev('(function () { const b = document.getElementById("lk-agent-mode-agent"); if (b) b.click(); return !!b; })()');
  await sleep(400);

  /* 三个候选绿元素的**实际**颜色与几何（伪元素也要问 computed style） */
  const greens = () => ev(`(function () {
    const out = [];
    const push = (name, el, pseudo) => {
      if (!el) { out.push({ name: name, absent: true }); return; }
      const cs = getComputedStyle(el, pseudo || null);
      const r = el.getBoundingClientRect();
      out.push({
        name: name,
        bg: cs.backgroundColor, color: cs.color, border: cs.borderLeftColor,
        w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
        x: Math.round(r.left), y: Math.round(r.top),
        visible: r.width > 0 && r.height > 0 && cs.display !== 'none',
      });
    };
    const panel = document.getElementById('lk-agent-panel');
    push('1 标题模式圆点 ::before', panel && panel.querySelector('.lk-agent__title'), '::before');
    const live = panel && panel.querySelector('.lk-think.is-live');
    push('2 思考中闪点 ::after', live && live.querySelector('.lk-think__sum'), '::after');
    push('3 流式光标', panel && panel.querySelector('.lk-md__caret'));
    push('.. 模式按钮(agent)', panel && panel.querySelector('#lk-agent-mode-agent'));
    push('.. 左边缘(面板)', panel);
    return out;
  })()`);

  const shot = async (file, clip) => {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: clip });
    const b = r.result && r.result.data;
    if (!b) { console.log('FAIL 截图没数据'); return; }
    fs.writeFileSync(file, Buffer.from(b, 'base64'));
    console.log('截图: ' + file);
  };

  const LONG = '这是一段用来撑高度的正文。'.repeat(12);
  console.log('== ① 先灌 3 条历史，让列表有内容 ==');
  for (let i = 1; i <= 3; i++) {
    await ev('window.__lkAgentMock = ' + JSON.stringify('[灌历史 ' + i + '] ' + LONG) + '; true');
    await ev('(function () { const t = document.getElementById("lk-agent-input"); t.value = "灌历史 ' + i + '"; document.getElementById("lk-agent-send").click(); return true; })()');
    await sleep(700);
  }

  console.log('== ② 发一条「边想边写」（假引擎 12 片思考 + 1 片正文，gap 500）==');
  const piece = '让我把这件事想清楚：先看用户要什么，再看手里有哪些线索，然后一条条对起来。';
  const RSN = [];
  for (let i = 0; i < 12; i++) RSN.push(piece);
  await ev('window.__lkAgentMock = { chunks: ["结论如下。"], reasoning: ' + JSON.stringify(RSN) + ', gap: 500 }; true');
  await ev('(function () { const t = document.getElementById("lk-agent-input"); t.value = "带长思考再说一次。"; document.getElementById("lk-agent-send").click(); return true; })()');
  await sleep(2200);

  const g = await greens();
  console.log('== ③ 生成中：accent 绿元素 ==');
  for (const it of g) console.log('  ' + JSON.stringify(it));

  const rect = await ev('(function () { const p = document.getElementById("lk-agent-panel"); if (!p) return null; const r = p.getBoundingClientRect(); return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8), width: r.width + 16, height: r.height + 16 }; })()');
  const out = path.join(process.env.TEMP || '.', 'lk-greens-live.png');
  if (rect) await shot(out, { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 2 });
  console.log('生成中读数: ' + JSON.stringify({ ok: true, png: out, greens: g.length }));
  process.exit(0);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : String(e))); process.exit(2); });
