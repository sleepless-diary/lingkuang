/* 灵感触发器 · 词义联想画布：① 画布不许被 sticky 工具条遮住（看不全）
 * ② 画布上的滚轮要真的能滚页面 ③ 拖节点贴边（或拖出视窗）时视窗要跟着推、节点要一直贴在鼠标下
 * ④ 松手后推力要停。
 *
 * 用法（见 tools/e2e/README.md）：
 *   $env:LINGKUANG_* 指向测试目录 → 起应用（--remote-debugging-port=9500）→ node tools/e2e/assoc-canvas.cjs
 *
 * ⚠️ 测试实例是 showInactive（窗口 hidden）⇒ rAF 与 CSS 动画都不会自己推进，
 *    只有"出帧"（Page.captureScreenshot）才会走一帧。自动推视窗是 rAF 驱动的，
 *    所以断言前必须 forceFrames()，否则推不动、看起来像"没实现"。
 * ⚠️ 指针事件用 PointerEvent 合成：pointerdown 要打在**节点元素**上（stage 的监听靠冒泡），
 *    pointermove/pointerup 打在 window 上（画布把这两个挂在 window，指针移出画布也要收得到）。 */
const PORT = process.env.LK_CDP_PORT || '9500';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }

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
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  const forceFrames = async (n = 6) => {
    for (let i = 0; i < n; i++) { await send('Page.captureScreenshot', { format: 'jpeg', quality: 10 }); await sleep(40); }
  };
  const waitFor = async (expr, ms = 6000) => {
    for (let i = 0; i < ms / 150; i++) { if (await ev(expr)) return true; await sleep(150); }
    return false;
  };
  /** 视窗平移量（从 #assoc-world 的行内 transform 里抠 translate 的 x/y） */
  const pan = () => ev(`(() => {
    const m = /translate\\(([-0-9.]+)px,\\s*([-0-9.]+)px\\)/.exec(document.querySelector('#assoc-world').style.transform);
    return m ? { x: Math.round(parseFloat(m[1])), y: Math.round(parseFloat(m[2])) } : null;
  })()`);

  await sleep(800);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(`document.querySelector('[data-tool="inspire"]').click(); true`);
  const hasStage = await waitFor(`!!document.querySelector('#assoc-stage')`);
  if (!hasStage) { console.log('FAIL 画布没挂上'); process.exit(1); }
  await ev(`document.querySelector('#insp-assoc').assocSetRoot('雪原'); true`);
  await sleep(900);
  const hasNode = await waitFor(`!!document.querySelector('.assoc__root, .assoc__node')`);
  check('★0 前置：画布挂上了、有节点可拖（根词「雪原」）', hasStage && hasNode, { hasStage, hasNode });

  /* ── ① 画布不许被 sticky 工具条遮住 ──
     用户原话：「联想画布内节点会被一块地方挡住，看不全」。
     实测根因：那条工具条 sticky 在视口 y=8..62，而画布是页面最后一块、原来高 100vh ⇒
     滚到底时画布顶部正好落在工具条底下，最上面 54px 里的节点怎么滚都看不全。
     现在画布高度 = 100vh − 工具条实测底边 ⇒ 滚到底时它从工具条下沿开始、铺满剩余窗口。 */
  await ev(`(() => {
    const st = document.querySelector('#assoc-stage');
    let el = st.parentElement, target = null;
    while (el && el !== document.documentElement) { if (el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'visible') { target = el; break; } el = el.parentElement; }
    if (target) target.scrollTop = target.scrollHeight;
  })()`);
  await sleep(600);
  const fit = await ev(`(() => {
    const bar = document.querySelector('#insp-scroll > div').getBoundingClientRect();
    const st = document.querySelector('#assoc-stage').getBoundingClientRect();
    const box = document.querySelector('#insp-assoc').getBoundingClientRect();
    return { barBottom: Math.round(bar.bottom), stageTop: Math.round(st.top), stageBottom: Math.round(st.bottom),
      stageH: Math.round(st.height), vh: innerHeight,
      /* 画布可见区里最靠上的那个点，最上层元素必须仍属于画布（＝没被工具条盖住） */
      topOwner: (() => { const t = document.elementFromPoint(Math.round(st.left + st.width / 2), Math.round(st.top + 4)); return t ? (t.id ? '#' + t.id : t.className || t.tagName) : null; })(),
      topOwnedByStage: (() => { const t = document.elementFromPoint(Math.round(st.left + st.width / 2), Math.round(st.top + 4)); return t ? !!t.closest('#assoc-stage') : false; })(),
      boxH: Math.round(box.height) };
  })()`);
  check('★1 滚到底时画布完整落在工具条下沿以下、且铺满剩余窗口（顶部那一圈不再被工具条盖住）',
    fit.stageTop >= fit.barBottom - 1 && fit.stageBottom <= fit.vh + 1 && fit.topOwnedByStage === true && fit.stageH >= fit.vh * 0.7,
    fit);

  /* ── ② 画布上的滚轮要真的能滚页面 ──
     原来写死 `stage.closest('.lk-module-view')`，而工具宿主改成一格一工具之后真正在滚的是
     `.lk-tool-slot`（`#lk-module-view` 自己 scrollHeight === clientHeight，根本不会滚）
     ⇒ 鼠标停在画布上滚滚轮毫无反应。 */
  await ev(`(() => {
    const st = document.querySelector('#assoc-stage');
    let el = st.parentElement, target = null;
    while (el && el !== document.documentElement) { if (el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'visible') { target = el; break; } el = el.parentElement; }
    if (target) target.scrollTop = 0;
    return !!target;
  })()`);
  await sleep(400);
  const wheel = await ev(`(() => {
    const st = document.querySelector('#assoc-stage');
    const before = (() => { let el = st.parentElement; while (el && el !== document.documentElement) { if (el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'visible') return el.scrollTop; el = el.parentElement; } return null; })();
    const r = st.getBoundingClientRect();
    st.dispatchEvent(new WheelEvent('wheel', { deltaY: 260, clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + 40), bubbles: true, cancelable: true }));
    const after = (() => { let el = st.parentElement; while (el && el !== document.documentElement) { if (el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'visible') return el.scrollTop; el = el.parentElement; } return null; })();
    return { before, after };
  })()`);
  check('★2 鼠标停在画布上滚滚轮 → 页面真的滚了（找的是真正能滚的那个祖先，不是写死的类名）',
    wheel && wheel.before !== null && wheel.after !== null && wheel.after > wheel.before, wheel);

  /* ── ③ 拖节点贴右边：视窗要顺着推，且节点一直贴在鼠标下 ── */
  await ev(`(() => {
    const st = document.querySelector('#assoc-stage');
    let el = st.parentElement, target = null;
    while (el && el !== document.documentElement) { if (el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'visible') { target = el; break; } el = el.parentElement; }
    if (target) target.scrollTop = target.scrollHeight;
  })()`);
  await sleep(500);
  const start = await ev(`(() => {
    const stage = document.querySelector('#assoc-stage');
    const node = document.querySelector('.assoc__root, .assoc__node');
    const sR = stage.getBoundingClientRect(), nR = node.getBoundingClientRect();
    const gx = Math.round(nR.left + nR.width / 2), gy = Math.round(nR.top + nR.height / 2);
    const fire = (type, x, y, buttons) => {
      const t = type === 'pointerdown' ? node : window;
      t.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, buttons, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    };
    window.__lkFire = fire;   /* 后续几步还要用 */
    fire('pointerdown', gx, gy, 1);
    /* 先动几下脱离"未拖动"死区，再顶到右边缘（留 8px）按住不放 */
    fire('pointermove', gx + 12, gy, 1);
    fire('pointermove', gx + 40, gy, 1);
    fire('pointermove', Math.round(sR.right - 8), gy, 1);
    return { gx, gy, edgeX: Math.round(sR.right - 8), edgeY: gy, nodeRect: [Math.round(nR.left), Math.round(nR.top), Math.round(nR.width), Math.round(nR.height)] };
  })()`);
  const panBefore = await pan();
  await forceFrames(3);    /* rAF 要出帧才走（隐藏窗口）⇒ 这一步就是"按住不放等它推"。
                              只出 3 帧是刻意的：这时被拖节点还没撞到世界右墙，
                              所以"贴在鼠标下"这条才检得出来（撞墙后它就该停下、不该贴了）。 */
  const pushed = await ev(`(() => {
    const node = document.querySelector('.assoc__root, .assoc__node');
    const nR = node.getBoundingClientRect();
    const cx = ${start.edgeX}, cy = ${start.edgeY};
    return { underCursor: cx >= nR.left && cx <= nR.right && cy >= nR.top && cy <= nR.bottom,
      nodeCenter: [Math.round(nR.left + nR.width / 2), Math.round(nR.top + nR.height / 2)] };
  })()`);
  const panAfter = await pan();
  check('★3 拖节点顶到右边缘按住不放 → 视窗自动往右推（panX 变小），且节点仍**贴在鼠标下**',
    panBefore && panAfter && panAfter.x < panBefore.x - 20 && pushed.underCursor === true,
    { panBefore, panAfter, pushed, start: { gx: start.gx, gy: start.gy, edgeX: start.edgeX } });

  /* ── ③b 推到头要停在世界边界（不许推出空白，也不许把节点甩在鼠标后面） ── */
  await forceFrames(60);
  const panWall = await pan();
  await forceFrames(10);
  const panWall2 = await pan();
  const wall = await ev(`(() => {
    const stage = document.querySelector('#assoc-stage').getBoundingClientRect();
    const node = document.querySelector('.assoc__root, .assoc__node');
    return { stageW: Math.round(stage.width), nodeLeft: Math.round(node.getBoundingClientRect().left) };
  })()`);
  check('★3b 推到头停在世界右边界（panX 夹在 视口宽−2000 上、不再继续往空白里推）',
    panWall && panWall2 && panWall2.x === panWall.x && Math.abs(panWall.x - (wall.stageW - 2000)) <= 1,
    { panWall, panWall2, ...wall });

  /* ── ④ 松手 → 推力必须停（不能松了手还在自己跑） ── */
  await ev(`window.__lkFire('pointerup', ${start.edgeX}, ${start.edgeY}, 0); true`);
  const panUp = await pan();
  await forceFrames(8);
  const panIdle = await pan();
  check('★4 松手后推力停住（再出 8 帧视窗纹丝不动）', panUp && panIdle && panIdle.x === panUp.x && panIdle.y === panUp.y,
    { panUp, panIdle });

  /* ── ⑤ 反向：拖到左边缘 → 视窗往回推（panX 变大） ── */
  await ev(`(() => {
    const stage = document.querySelector('#assoc-stage');
    const node = document.querySelector('.assoc__root, .assoc__node');
    const sR = stage.getBoundingClientRect(), nR = node.getBoundingClientRect();
    const gx = Math.round(nR.left + nR.width / 2), gy = Math.round(nR.top + nR.height / 2);
    window.__lkFire('pointerdown', gx, gy, 1);
    window.__lkFire('pointermove', gx - 40, gy, 1);
    window.__lkFire('pointermove', Math.round(sR.left + 8), gy, 1);
    window.__lkEdge = Math.round(sR.left + 8);
    window.__lkEdgeY = gy;
    return true;
  })()`);
  const panL0 = await pan();
  await forceFrames(60);
  const panL1 = await pan();
  const panL2 = await pan();
  await ev(`window.__lkFire('pointerup', window.__lkEdge, window.__lkEdgeY, 0); true`);
  check('★5 拖到左边缘 → 视窗反向推、推到头停在世界左边界（panX 夹在 0，不再往空白里推）',
    panL0 && panL1 && panL1.x > panL0.x + 20 && panL1.x === 0 && panL2.x === panL1.x, { panL0, panL1, panL2 });

  const errs = await ev(`window.__errs`);
  check('★6 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n==== ${pass}/${results.length} PASS ====`);
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.log('ERROR', e.message); process.exit(1); });
