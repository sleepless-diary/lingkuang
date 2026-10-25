/* 时间指针与画布是否同一帧（「甩尾」）/ 面板头分簇 / 上下分割（第一百二十二轮定案）。
 * 用法：先起隔离实例（--remote-debugging-port=9334），再 `node tools/e2e/timeline-cursor-split.cjs`
 * 产出：.review/shots-r122/*.png + 控制台断言
 *
 * 判据（指针）：归一化的相对时间位置 p = (指针 x − A 节点中心) / (B 节点中心 − A 节点中心)。
 *   p 与缩放无关（时间轴是线性的），平移/缩放时 p 必须纹丝不动；
 *   p 抖一下就是「指针和画布不在同一帧」——旧版 `.tl-cursor{transition:left 70ms}` 时
 *   实测抖动 0.15~0.2（≈ 数百 px），现在应 ≤ 0.002。
 */
const PORT = process.env.LK_CDP_PORT || '9334';
const OUT = 'F:/Projects/lingkuang-v3/.review/shots-r122';
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (n, v, extra) => console.log(`${v ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let target = null;
  for (let i = 0; i < 150; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch {}
    await sleep(200);
  }
  if (!target) { console.log('FAIL 连不上 CDP'); process.exit(1); }
  const w = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; });
  let id = 0; const pending = new Map();
  w.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (m, p) => new Promise((res) => { const i = ++id; pending.set(i, res); w.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
  };

  await sleep(2000);
  await ev(`window.__errs=[];window.addEventListener('error',(e)=>window.__errs.push(String(e.message)));true`);
  await ev(`document.querySelector('[data-tool="sandbox"]')?.click(); true`);
  await sleep(700);
  /* 会话会记住上次那条时间线；探针固定挑「节点最多的那条」（＝夹具里的主线，25 个节点） */
  await ev(`(() => {
    const tabs = [...document.querySelectorAll('.lk-tl-tab[data-tl]')];
    let best = null, bestN = -1;
    for (const t of tabs) { const n = Number(t.querySelector('.cnt')?.textContent || 0); if (n > bestN) { bestN = n; best = t; } }
    if (best && !best.classList.contains('is-active')) best.click();
    return bestN;
  })()`);
  await sleep(900);
  /* 点一下画布，把时间指针落到画面中间（否则可能是 lastCursorT=0 的默认位置） */
  await ev(`(() => { const w = document.querySelector('.tl-wrap'); const r = w.getBoundingClientRect();
    w.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: r.left + r.width * 0.5, clientY: r.top + r.height * 0.5 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    return true; })()`);
  await sleep(600);

  const info = await ev(`(() => {
    const t = document.getElementById('lk-pane-timeline');
    const m = document.getElementById('lk-pane-map');
    const cur = document.querySelector('.tl-cursor');
    const tools = document.getElementById('lk-tools');
    const state = document.getElementById('lk-state');
    return {
      paneT: t && Math.round(t.getBoundingClientRect().height),
      paneM: m && Math.round(m.getBoundingClientRect().height),
      tools: tools ? [...tools.children].map((el) => el.id || el.className || el.tagName) : null,
      state: state ? [...state.children].map((el) => el.id || el.className || el.tagName) : null,
      cursorTransition: cur ? getComputedStyle(cur).transitionProperty + ' ' + getComputedStyle(cur).transitionDuration : null,
      nodes: document.querySelectorAll('.tl__n').length,
    };
  })()`);
  console.log('info =', JSON.stringify(info));
  await shot('00-before');

  /* ── 判据自检：把旧 CSS（transition: left 70ms）临时加回去，抖动必须**报警** ──
     否则这条判据是空转的（量了个永远成立的东西）。跑完立刻摘掉。 */
  const selfCheck = await ev(`(async () => {
    const st = document.createElement('style');
    st.id = 'r122-selfcheck';
    st.textContent = '.tl-cursor{transition:left 70ms linear!important}';
    document.head.appendChild(st);
    const wrap = document.querySelector('.tl-wrap');
    const cur = document.querySelector('.tl-cursor');
    const els = [...document.querySelectorAll('.tl__n')];
    const A = els[0].dataset.id, B = els[els.length - 1].dataset.id;
    const rect = wrap.getBoundingClientRect();
    const p = () => {
      const a = document.querySelector('.tl__n[data-id="' + A + '"]'), b = document.querySelector('.tl__n[data-id="' + B + '"]');
      if (!a || !b) return null;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const ax = ra.left + ra.width / 2, bx = rb.left + rb.width / 2;
      if (Math.abs(bx - ax) < 1) return null;
      return (cur.getBoundingClientRect().left - ax) / (bx - ax);
    };
    const p0 = p();
    for (let i = 0; i < 6; i++) wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true, clientX: rect.left + 400, clientY: rect.top + 120 }));
    let worst = 0;
    await new Promise((done) => { const t0 = performance.now(); const loop = () => { const v = p(); if (v !== null) worst = Math.max(worst, Math.abs(v - p0)); if (performance.now() - t0 < 400) requestAnimationFrame(loop); else done(); }; requestAnimationFrame(loop); });
    st.remove();
    return { worst: +worst.toFixed(4) };
  })()`);
  console.log('selfCheck(旧 CSS) =', JSON.stringify(selfCheck));
  ok('判据自检：旧 CSS 下抖动明显（> 0.01）', selfCheck && selfCheck.worst > 0.01, selfCheck);

  /* ── 指针 vs 节点：滚轮平移时逐帧量归一化相对位置 ── */
  const drift = await ev(`(async () => {
    const wrap = document.querySelector('.tl-wrap');
    const cur = document.querySelector('.tl-cursor');
    const els = [...document.querySelectorAll('.tl__n')];
    if (!wrap || !cur || els.length < 2) return null;
    const A = els[0].dataset.id, B = els[els.length - 1].dataset.id;
    const rect = wrap.getBoundingClientRect();
    const samples = [];
    /* ⚠️ renderBase 每帧重建 innerHTML ⇒ 元素会被换掉，必须**每帧按 id 重新查**；
       而且要用**中心**而不是 left：节点的 left 带 -13px 的外扩（26px 盒 + margin -13），
       缩放时那个常数位移会让比值漂 —— 第一版判据就这么误报过 1%。 */
    const p = () => {
      const a = document.querySelector('.tl__n[data-id="' + A + '"]');
      const b = document.querySelector('.tl__n[data-id="' + B + '"]');
      if (!a || !b) return null;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const ax = ra.left + ra.width / 2, bx = rb.left + rb.width / 2;
      if (Math.abs(bx - ax) < 1) return null;
      return Math.round(((cur.getBoundingClientRect().left - ax) / (bx - ax)) * 1e4) / 1e4;
    };
    const p0 = p();
    for (let i = 0; i < 6; i++) {
      wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, deltaX: 0, bubbles: true, cancelable: true, clientX: rect.left + 400, clientY: rect.top + 120 }));
    }
    const t0 = performance.now();
    await new Promise((done) => {
      const loop = () => {
        const v = p();
        if (v !== null) samples.push({ t: Math.round(performance.now() - t0), d: v });
        if (performance.now() - t0 < 700) requestAnimationFrame(loop); else done();
      };
      requestAnimationFrame(loop);
    });
    let maxDev = 0, at = 0;
    for (const s of samples) { const dev = Math.abs(s.d - p0); if (dev > maxDev) { maxDev = dev; at = s.t; } }
    return { p0, maxDev, at, frames: samples.length, head: samples.slice(0, 3), tail: samples.slice(-2) };
  })()`);
  console.log('drift =', JSON.stringify(drift));
  if (drift) ok('平移：指针与节点同帧（抖动 ≤ 0.002）', drift.maxDev <= 0.002, drift);

  /* ── 缩放（Alt+滚轮）：同一个判据 ── */
  const driftZoom = await ev(`(async () => {
    const wrap = document.querySelector('.tl-wrap');
    const cur = document.querySelector('.tl-cursor');
    const els = [...document.querySelectorAll('.tl__n')];
    if (els.length < 2) return null;
    const A = els[0].dataset.id, B = els[els.length - 1].dataset.id;
    const rect = wrap.getBoundingClientRect();
    const p = () => {
      const a = document.querySelector('.tl__n[data-id="' + A + '"]');
      const b = document.querySelector('.tl__n[data-id="' + B + '"]');
      if (!a || !b) return null;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const ax = ra.left + ra.width / 2, bx = rb.left + rb.width / 2;
      if (Math.abs(bx - ax) < 1) return null;
      return Math.round(((cur.getBoundingClientRect().left - ax) / (bx - ax)) * 1e4) / 1e4;
    };
    const p0 = p();
    for (let i = 0; i < 4; i++) {
      wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, altKey: true, bubbles: true, cancelable: true, clientX: rect.left + 500, clientY: rect.top + 120 }));
    }
    const t0 = performance.now(); const samples = [];
    await new Promise((done) => { const loop = () => { const v = p(); if (v !== null) samples.push({ t: Math.round(performance.now() - t0), d: v }); if (performance.now() - t0 < 800) requestAnimationFrame(loop); else done(); }; requestAnimationFrame(loop); });
    let maxDev = 0, at = 0;
    for (const s of samples) { const dev = Math.abs(s.d - p0); if (dev > maxDev) { maxDev = dev; at = s.t; } }
    return { p0, maxDev, at, frames: samples.length, head: samples.slice(0, 3) };
  })()`);
  console.log('driftZoom =', JSON.stringify(driftZoom));
  if (driftZoom) ok('缩放：指针与节点同帧（抖动 ≤ 0.002）', driftZoom.maxDev <= 0.002, driftZoom);

  /* ── 点画布：指针必须**落在点击处**（±1px），且与节点同一帧 ──
     不做缓动：拖指针/点画布要跟手，缓动会拖在鼠标后面（缓动只给"别处把时间改了"那种跳变）。 */
  const click = await ev(`(async () => {
    const wrap = document.querySelector('.tl-wrap');
    const r = wrap.getBoundingClientRect();
    const cur = document.querySelector('.tl-cursor');
    const x = 400, y = 150;
    wrap.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: r.left + x, clientY: r.top + y }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    const frames = [];
    await new Promise((done) => { const t0 = performance.now(); const loop = () => { frames.push(+(cur.getBoundingClientRect().left - r.left).toFixed(2)); if (performance.now() - t0 < 200) requestAnimationFrame(loop); else done(); }; requestAnimationFrame(loop); });
    const got = frames[frames.length - 1];
    return { want: x, got, delta: +(got - x).toFixed(2), firstFrame: frames[0], n: frames.length };
  })()`);
  console.log('click =', JSON.stringify(click));
  if (click) ok('点画布：指针落在点击处（±1px）', Math.abs(click.delta) <= 1, click);

  /* ── 拖指针手柄：整段跟手（没有任何一步落后 > 2px） ──
     ⚠️ 读位置要**等两帧**：setTimeCursor → store 通知 → render 是下一帧才落，
     派发完立刻读只能读到上一帧的位置（第一版就这么误报过 94px 落后）。 */
  const drag = await ev(`(async () => {
    const wrap = document.querySelector('.tl-wrap');
    const r = wrap.getBoundingClientRect();
    const handle = document.querySelector('.tl-cursor-handle');
    const cur = document.querySelector('.tl-cursor');
    const start = cur.getBoundingClientRect().left - r.left;
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, clientX: r.left + start, clientY: r.top + 10 }));
    const want = [];
    const got = [];
    const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    for (let i = 1; i <= 8; i++) {
      const x = start + i * 18;
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 1, clientX: r.left + x, clientY: r.top + 10 }));
      want.push(x);
      await frame();
      got.push(+(cur.getBoundingClientRect().left - r.left).toFixed(2));
    }
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    const worst = Math.max(...want.map((w, i) => Math.abs(w - got[i])));
    return { worst: +worst.toFixed(2), got: got.slice(-2), want: want.slice(-2) };
  })()`);
  console.log('drag =', JSON.stringify(drag));
  if (drag) ok('拖指针：跟手（最大落后 ≤ 2px）', drag.worst <= 2, drag);

  /* ── 工具栏分组：左簇 = 视图状态，右簇 = 新建 ── */
  const bar = await ev(`(() => {
    const head = document.querySelector('#lk-pane-timeline .lk-pane-head');
    const st = document.getElementById('lk-state');
    const tools = document.getElementById('lk-tools');
    return {
      seps: head ? head.querySelectorAll('.lk-tl-sep').length : 0,
      state: st ? [...st.children].map((e) => e.id || e.className) : null,
      tools: tools ? [...tools.querySelectorAll('button')].map((e) => e.id || e.className) : null,
      order: head ? [...head.children].map((e) => e.id || e.className || e.tagName) : null,
    };
  })()`);
  console.log('bar =', JSON.stringify(bar));
  if (bar) {
    ok('面板头分成四簇（三条分组线）', bar.seps === 3, bar);
    ok('视图状态区有「非线性」', !!bar.state && bar.state.includes('lk-nonlinear'), bar.state);
    ok('新建区有「＋循环」且不含非线性', !!bar.tools && bar.tools.includes('lk-loop-new') && !bar.tools.includes('lk-nonlinear'), bar.tools);
  }

  /* 「非线性」搬进新容器后要还能用：点一下进非线性（节点按序列重排、指针隐藏），再点回来。
     ⚠️ 每次都要**重新按 id 取**按钮：以前 renderExtraTools 每次 render 都重建按钮，
     旧引用会变成脱离文档的节点（监听还在，点一下等于点两次）。 */
  const nl = await ev(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const cur = document.querySelector('.tl-cursor');
    const before = document.querySelectorAll('.tl__n').length;
    document.getElementById('lk-nonlinear').click(); await sleep(150);
    const btnA = document.getElementById('lk-nonlinear');
    const on = { active: btnA.classList.contains('is-active'), sameNode: true, cursorHidden: cur.style.display === 'none', nodes: document.querySelectorAll('.tl__n').length };
    const btnA2 = document.getElementById('lk-nonlinear');
    on.sameNode = btnA === btnA2;
    btnA2.click(); await sleep(150);
    const btnB = document.getElementById('lk-nonlinear');
    const off = { active: btnB.classList.contains('is-active'), cursorShown: cur.style.display !== 'none', nodes: document.querySelectorAll('.tl__n').length };
    return { before, on, off };
  })()`);
  console.log('nl =', JSON.stringify(nl));
  if (nl) ok('「非线性」搬家后仍能切换（两次切回原样、按钮不再被重建）',
    nl.on.active && nl.on.cursorHidden && nl.on.nodes === nl.before && !nl.off.active && nl.off.cursorShown && nl.off.nodes === nl.before, nl);

  /* ── 上下分割：可拖 / 比例记忆 / 地图可收起 ── */
  const split = await ev(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const bar = document.getElementById('lk-split');
    const sb = document.getElementById('lk-sandbox');
    const tl = document.getElementById('lk-pane-timeline');
    const map = document.getElementById('lk-pane-map');
    if (!bar || !sb) return { exists: false };
    const r = sb.getBoundingClientRect();
    /* 目标比例**每次换一个**（上次跑完会存下 0.7 或 0.3）：否则「拖到同一处」量不出变化，
       第一次跑就误报过 FAIL（h0 289 → h1 289）。 */
    const cur = tl.getBoundingClientRect().height / r.height;
    const want = cur > 0.5 ? 0.3 : 0.7;
    const y = r.top + r.height * want;
    bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, clientX: r.left + 40, clientY: y, pointerId: 1 }));
    bar.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 1, clientX: r.left + 40, clientY: y, pointerId: 1 }));
    await sleep(80);
    const h1 = tl.getBoundingClientRect().height;
    bar.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 }));
    const stored = Number(localStorage.getItem('lingkuang-split'));
    /* 收起 / 展开 */
    document.getElementById('lk-map-toggle').click();
    await sleep(120);
    const collapsed = { body: map.querySelector('.lk-pane-body').offsetParent === null || getComputedStyle(map.querySelector('.lk-pane-body')).display === 'none',
      hMap: Math.round(map.getBoundingClientRect().height), hTl: Math.round(tl.getBoundingClientRect().height) };
    document.getElementById('lk-map-toggle').click();
    await sleep(200);
    const expanded = { hMap: Math.round(map.getBoundingClientRect().height), hTl: Math.round(tl.getBoundingClientRect().height),
      hMapBody: Math.round(map.querySelector('.lk-pane-body').getBoundingClientRect().height),
      stageH: Math.round(map.querySelector('.lk-pane-body > div')?.getBoundingClientRect().height ?? 0),
      svg: !!map.querySelector('svg') };
    return { exists: true, cursor: getComputedStyle(bar).cursor, want, got: +(h1 / r.height).toFixed(3), stored, collapsed, expanded };
  })()`);
  console.log('split =', JSON.stringify(split));
  if (split && split.exists) {
    ok('分割条存在且是 row-resize', split.cursor === 'row-resize', { cursor: split.cursor });
    ok('拖动改到目标比例（±0.03）', Math.abs(split.got - split.want) <= 0.03, split);
    ok('比例写进 localStorage', Math.abs(split.stored - split.want) <= 0.01, { stored: split.stored, want: split.want });
    ok('收起：地图只剩标题栏（body 藏起、时间线变高）', split.collapsed.body && split.collapsed.hMap < 60 && split.collapsed.hTl > split.expanded.hTl, split.collapsed);
    ok('展开：地图 body 回来且有高度，地图本身也在', split.expanded.hMapBody > 60 && split.expanded.stageH > 60 && split.expanded.svg, split.expanded);
  } else {
    ok('分割条存在', false, split);
  }

  /* ── 刷新后比例还在（会话态持久化）── */
  await send('Page.reload', {});
  await sleep(3500);
  await ev(`document.querySelector('[data-tool="sandbox"]')?.click(); true`);
  await sleep(800);
  const restored = await ev(`(() => {
    const sb = document.getElementById('lk-sandbox');
    const tl = document.getElementById('lk-pane-timeline');
    if (!sb || !tl) return null;
    return { ratio: +(tl.getBoundingClientRect().height / sb.getBoundingClientRect().height).toFixed(3),
      stored: localStorage.getItem('lingkuang-split'), nodes: document.querySelectorAll('.tl__n').length };
  })()`);
  console.log('restored =', JSON.stringify(restored));
  if (restored) ok('刷新后上下比例仍是刚才那个（±0.03）', Math.abs(restored.ratio - Number(restored.stored)) <= 0.03, restored);

  ok('无 JS 报错', (await ev(`window.__errs?.length ?? 0`)) === 0, await ev(`window.__errs`));
  await shot('01-after');
  w.close();
}

main().catch((e) => { console.log('FAIL 探针异常:', e.message); process.exit(1); });
