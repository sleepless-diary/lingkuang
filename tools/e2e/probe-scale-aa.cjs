/* 像素取证 2（第 ⑤ 片 · 用户报「入场时标尺的文字会闪一下」）：
   同一个标尺条在两个时刻各截一张 3x 放大图，用来判断"闪"是不是**动画起止那一瞬的重新栅格化/
   抗锯齿切换**（文字在合成层里走灰度 AA ⇒ 动画一结束恢复次像素 AA ⇒ 只有字会跳一下）：
     A = 完全静止（没有任何动画）
     B = 入场动画**跑完但 fill 还挂着**（此时元素仍在合成层里）
     C = `autoRelease` 取消之后（层被撤掉）
   若 A≈C 而 B 的字明显更细/更糊 ⇒ 就是它。
   用法：LK_CDP_PORT=9346 node tools/e2e/probe-scale-aa.cjs
   产物：%TEMP%\lk-scale-shots\aa-<A|B|C>-<ms>.png */
const fs = require('fs');
const path = require('path');
const os = require('os');
const PORT = process.env.LK_CDP_PORT || '9346';
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
  /** 截**同一段文字**（按标签文本找那一根主刻度），3x 放大 —— 不同时刻必须是同一个字符串才可比 */
  const shot = async (tag, ms, pick) => {
    const geo = await ev(`(() => {
      const s = document.querySelector('#lk-pane-timeline .tl-scale');
      const r = s.getBoundingClientRect();
      const majors = [...s.querySelectorAll('.tl__axis-tick--major')].filter((el) => el.querySelector('.tl__axis-label'));
      const PICK = ${JSON.stringify(pick)};
      const byText = PICK ? majors.find((el) => el.querySelector('.tl__axis-label').textContent === PICK) : null;
      const el = byText || majors[1] || majors[0];
      const lab = el ? el.querySelector('.tl__axis-label') : null;
      const lr = lab ? lab.getBoundingClientRect() : null;
      return { x: r.left, y: r.top, w: r.width, h: r.height, lx: lr ? lr.left : r.left + 60, ly: lr ? lr.top : r.top, txt: lab ? lab.textContent : null };
    })()`);
    console.log(`   ${tag} 用的是标签「${geo.txt}」`);
    const clip = { x: Math.max(0, geo.lx - 14), y: Math.max(0, geo.ly - 4), width: 210, height: 20, scale: 3 };
    const r = await send('Page.captureScreenshot', { format: 'png', clip });
    const file = path.join(OUT, `aa-${tag}-${ms}ms.png`);
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return file + '  clip=' + JSON.stringify(clip);
  };

  const onSandbox = await ev(`!!document.querySelector('#lk-pane-timeline .tl-scale')`);
  if (!onSandbox) { await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`); await sleep(1800); }
  await sleep(1500);                                   /* 让挂载期那批整批入场彻底走完 + autoRelease 收干净 */

  /* A：完全静止（先确认此刻没有动画在跑），并把这一段文字定成基准 */
  const anim0 = await ev(`(() => { const s = document.querySelector('#lk-pane-timeline .tl-scale'); return [...s.children].filter((el) => el.getAnimations().length).length; })()`);
  console.log('A 之前的在演刻度数 =', anim0);
  const baseText = await ev(`(() => { const s = document.querySelector('#lk-pane-timeline .tl-scale'); const m = [...s.querySelectorAll('.tl__axis-tick--major')].filter((el) => el.querySelector('.tl__axis-label')); const el = m[1] || m[0]; return el ? el.querySelector('.tl__axis-label').textContent : null; })()`);
  console.log('基准文字 =', baseText);
  console.log('A 静止     →', await shot('A', 0, baseText));

  /* 派一次滚轮（会有一批刻度入场），随后在两个时刻各截一张 */
  await ev(`(() => {
    const s = document.querySelector('#lk-pane-timeline .tl-scale');
    const wrap = s.parentElement;
    wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: -180, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(700);
  const animB = await ev(`(() => { const s = document.querySelector('#lk-pane-timeline .tl-scale'); const a = [...s.children].filter((el) => el.getAnimations().length); return { running: a.length, first: a[0] ? JSON.stringify((() => { const t = a[0].getAnimations()[0].effect.getTiming(); return [t.delay, t.duration]; })()) : null, state: a[0] ? a[0].getAnimations()[0].playState : null }; })()`);
  console.log('B 时刻动画 =', JSON.stringify(animB));
  console.log('B 动画挂满 →', await shot('B', 700, baseText));
  await sleep(900);
  const animC = await ev(`(() => { const s = document.querySelector('#lk-pane-timeline .tl-scale'); return [...s.children].filter((el) => el.getAnimations().length).length; })()`);
  console.log('C 时刻在演刻度数 =', animC);
  console.log('C 取消之后 →', await shot('C', 1600, baseText));
  w.close();
  process.exit(0);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
