/* 像素级取证（第 ⑤ 片 · 用户报「入场时标尺的文字会闪一下」）：
   在**入场动画期间**按 2x 缩放截取标尺条（scale 元素的矩形），存成一串 PNG，
   用来肉眼比对「动画中」与「落定后」的文字栅格化是否一致（糊/抖/跳）。
   用法：LK_CDP_PORT=9346 node tools/e2e/probe-scale-enter-shot.cjs [pan|zoom]
   产物：%TEMP%\lk-scale-shots\<mode>-NN-<ms>.png */
const fs = require('fs');
const path = require('path');
const os = require('os');
const PORT = process.env.LK_CDP_PORT || '9346';
const MODE = process.argv[2] || 'pan';
const OUT = path.join(os.tmpdir(), 'lk-scale-shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let target = null;
  for (let i = 0; i < 120; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (target) break; } catch {}
    await sleep(200);
  }
  if (!target) { console.log('FAIL 无法连接 CDP ' + PORT); process.exit(1); }
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
  const shot = async (tag, ms) => {
    const rect = await ev(`(() => { const s = document.querySelector('#lk-pane-timeline .tl-scale'); const r = s.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const clip = { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.min(560, rect.w), height: Math.max(28, rect.h), scale: 2 };
    const r = await send('Page.captureScreenshot', { format: 'png', clip });
    const file = path.join(OUT, `${MODE}-${tag}-${ms}ms.png`);
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return file;
  };

  const onSandbox = await ev(`!!document.querySelector('#lk-pane-timeline .tl-scale')`);
  if (!onSandbox) { await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`); await sleep(1800); }
  await sleep(400);

  console.log('before →', await shot('00', 0));
  /* 派滚轮：pan = 普通滚轮 deltaY -180；zoom = alt+滚轮 ×3（换档/批量入场） */
  const fire = `
    (() => {
      const s = document.querySelector('#lk-pane-timeline .tl-scale');
      const wrap = s.parentElement;
      const r = wrap.getBoundingClientRect();
      const MODE = ${JSON.stringify(MODE)};
      if (MODE === 'zoom') {
        for (let i = 0; i < 3; i++) wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, altKey: true, clientX: r.left + Math.round(r.width / 2), clientY: r.top + 40, bubbles: true, cancelable: true }));
      } else {
        wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: -180, bubbles: true, cancelable: true }));
      }
      return true;
    })()`;
  await ev(fire);
  const marks = [20, 45, 70, 100, 140, 190, 260, 420];
  let prev = 0;
  for (const m of marks) { await sleep(m - prev); prev = m; console.log('t+' + m + 'ms →', await shot(String(m), m)); }
  w.close();
  process.exit(0);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
