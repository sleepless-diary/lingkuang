/* 第一百零九轮：手绘海陆面板 + 高清大图缓存 + 大图查看器关闭。
 *
 *  用户原话：「高清大图下右上角的关闭按钮没有用，区域精细化的功能删了吧，地形工具加入手绘面板吧，
 *  这个手绘面板精细度不够，而且不能放大或者拖动，笔刷大小用滑块调整吧，还有高清大图怎么每次都要
 *  重新算，不能保存吗，手绘地形里面的橡皮定位不清晰，海洋不就是橡皮的功能吗」
 *
 *  这套件钉的是**能被量出来的那几件事**：
 *    ★0 前置：地图栏「地形 · 手绘…」在、区域精细化按钮已删、等高线四档、旧画笔条已删；
 *    ★1 面板骨架：陆地/海洋两档（无橡皮）、笔刷滑块 1~20、缩放三键、双画布（画布 + 光标环）；
 *    ★2 画一笔：陆地% 上升（掩膜 320×160 ⇒ 画的是"真有格子"的东西）；
 *    ★3 滚轮缩放：以指针为锚，`#ed-zoom` 从 100% 变大，画面签名跟着变；
 *    ★4 中键平移：画面签名变（能拖动看别处）；
 *    ★5 滑块改笔刷：`#ed-brush-n` 变、光标环半径跟着变（用户报的"定位不清晰"）；
 *    ★6 按剪影生成：disk 上 mask = 320×160、form = planet、画布挂上；
 *    ★7 高清大图：点地图 → 全窗口大图出来（第一次要算）；
 *    ★8 大图里拖过之后点右上角 × 能关（第一百零九轮的关闭 bug 回归）；
 *    ★9 同一张地形再点开 → **命中缓存**：极快、且中途没有出「正在出高清大图」遮罩。
 *
 *  用法：干净临时目录起隔离实例（不给 worldbuilding.json），
 *        LINGKUANG_TEST_DATA=... LINGKUANG_TEST_USERDATA=... LK_CDP_PORT=9503 node tools/e2e/map-draw.cjs */
const fs = require('fs');
const DATA = process.env.LINGKUANG_TEST_DATA;
const PORT = process.env.LK_CDP_PORT || '9503';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);
}

function diskMap() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    const ws = d.worldsets[Object.keys(d.worldsets)[0]];
    return (ws.maps || [])[0] || null;
  } catch { return null; }
}

async function main() {
  let target = null;
  for (let i = 0; i < 150; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (target) break; } catch {}
    await sleep(200);
  }
  if (!target) { console.log(`FAIL 无法连接 CDP ${PORT}`); process.exit(1); }
  const w = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; });
  let id = 0; const pending = new Map();
  w.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); w.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr, ms = 40000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
      sleep(ms).then(() => ({ timedOut: true })),
    ]);
    if (r.timedOut) throw new Error('eval 超时 ' + ms + 'ms');
    if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  const waitFor = async (expr, ms = 20000, step = 250) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await ev(expr, 5000)) return Date.now() - t0; } catch { /* 上下文还没就绪 */ }
      await sleep(step);
    }
    return -1;
  };
  const click = (sel) => ev(`(function () { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`);
  const shot = async () => { try { await send('Page.captureScreenshot', { format: 'png' }); } catch { /* 截图只是留证 */ } };

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);

  /* 会话会恢复上次的工具 ⇒ 先切回沙盘（地图栏只在那儿）*/
  const ready = await waitFor(`!!document.querySelector('#lk-toolbar [data-tool="sandbox"]')`, 30000);
  await click('#lk-toolbar [data-tool="sandbox"]');
  await waitFor(`!!document.getElementById('map-editor')`, 20000);
  await sleep(400);
  await ev(`(function () { const p = document.getElementById('lk-pane-map'); if (p) p.scrollIntoView({ block: 'center' }); return true; })()`);

  /* ★0 前置 */
  const pre = await ev(`(function () {
    return {
      editor: !!document.getElementById('map-editor'),
      noRefine: !document.querySelector('[data-mode="refine"]'),
      noPaintBar: !document.getElementById('map-paint-bar'),
      noBrush: document.querySelectorAll('.map-brush').length === 0,
      contour: [...document.querySelectorAll('#map-contour option')].map((o) => o.value).join(','),
    };
  })()`);
  check('★0 前置：地形=手绘入口、区域精细化已删、旧画笔条已删、等高线四档',
    pre.editor === true && pre.noRefine === true && pre.noPaintBar === true && pre.noBrush === true
    && pre.contour === 'auto,all,half,fifth', { ...pre, ready });

  /* ★1 面板骨架 */
  await click('#map-editor');
  await sleep(700);
  const panel = await ev(`(function () {
    const el = document.querySelector('.lk-ed');
    if (!el) return { open: false };
    const s = document.getElementById('ed-brush');
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    const st = document.getElementById('ed-stage').getBoundingClientRect();
    return {
      open: true,
      tools: [...el.querySelectorAll('[data-tool]')].map((b) => b.dataset.tool).join(','),
      erase: !!el.querySelector('[data-tool="erase"]'),
      slider: !!s && s.type === 'range' && s.min === '1' && s.max === '20' && s.value === '4',
      zoomBtns: !!document.getElementById('ed-zoom-in') && !!document.getElementById('ed-zoom-out') && !!document.getElementById('ed-zoom-fit'),
      canvases: !!c && !!document.getElementById('ed-cursor'),
      cursorPE: getComputedStyle(document.getElementById('ed-cursor')).pointerEvents,
      fills: Math.abs(r.width - st.width) <= 2 && Math.abs(r.height - st.height) <= 2,
      size: { w: Math.round(r.width), h: Math.round(r.height) },
      zoom: (document.getElementById('ed-zoom') || {}).textContent,
    };
  })()`);
  await shot();
  check('★1 面板：陆地/海洋两档（无橡皮）、笔刷滑块 1~20、缩放三键、双画布铺满、光标层不挡指针',
    panel.open === true && panel.tools === 'land,sea' && panel.erase === false && panel.slider === true
    && panel.zoomBtns === true && panel.canvases === true && panel.zoom === '100%'
    && panel.cursorPE === 'none' && panel.fills === true
    && panel.size.w > 600 && panel.size.h > 300, panel);

  /* 画一笔：在画布中间横着涂一段陆地 */
  const DRAW = (fx0, fy0, fx1, fy1) => `(function () {
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    const at = (fx, fy) => ({ clientX: r.left + r.width * fx, clientY: r.top + r.height * fy });
    const mk = (t, p) => new PointerEvent(t, { clientX: p.clientX, clientY: p.clientY, bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 });
    const a = at(${fx0}, ${fy0}), b = at(${fx1}, ${fy1});
    c.dispatchEvent(mk('pointerdown', a));
    for (let i = 1; i <= 8; i++) c.dispatchEvent(mk('pointermove', { clientX: a.clientX + (b.clientX - a.clientX) * i / 8, clientY: a.clientY + (b.clientY - a.clientY) * i / 8 }));
    c.dispatchEvent(mk('pointerup', b));
    const stat = (document.getElementById('ed-stat') || {}).textContent || '';
    return { stat, land: Number((stat.match(/陆地 (\\d+)%/) || [])[1] || 0) };
  })()`;
  const sig = `(function () {
    const c = document.getElementById('ed-canvas');
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let h = 0;
    for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i] + d[i + 1] * 7) >>> 0;
    return h;
  })()`;

  const painted = await ev(DRAW(0.35, 0.5, 0.65, 0.5));
  await sleep(200);
  check('★2 画一笔 ⇒ 陆地% 上升（掩膜真的有格子、落点准）', painted.land >= 1, painted);

  /* ★3 滚轮缩放 */
  const beforeZoom = await ev(sig);
  await ev(`(function () {
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new WheelEvent('wheel', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, deltaY: -600, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(300);
  const z1 = await ev(`(function () { return { zoom: (document.getElementById('ed-zoom') || {}).textContent, sig: ${sig} }; })()`);
  check('★3 滚轮缩放：以指针为锚放大、画面签名变',
    z1.zoom !== '100%' && parseInt(z1.zoom, 10) > 100 && z1.sig !== beforeZoom, { from: beforeZoom, ...z1 });

  /* ★4 中键拖动平移 */
  const beforePan = await ev(sig);
  await ev(`(function () {
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const mk = (t, cx, cy, b) => new PointerEvent(t, { clientX: cx, clientY: cy, bubbles: true, pointerId: 3, pointerType: 'mouse', button: b, buttons: b === 1 ? 4 : 1 });
    c.dispatchEvent(mk('pointerdown', x, y, 1));
    for (let i = 1; i <= 5; i++) c.dispatchEvent(mk('pointermove', x + i * 16, y + i * 10, 1));
    c.dispatchEvent(mk('pointerup', x + 80, y + 50, 1));
    return true;
  })()`);
  await sleep(300);
  const afterPan = await ev(sig);
  check('★4 中键拖动可以平移（画面签名变）', afterPan !== beforePan, { before: beforePan, after: afterPan });

  /* ★5 滑块改笔刷 + 光标环半径 */
  const ring = await ev(`(function () {
    const c = document.getElementById('ed-canvas');
    const cur = document.getElementById('ed-cursor');
    const s = document.getElementById('ed-brush');
    const set = (v) => { s.value = String(v); s.dispatchEvent(new Event('input', { bubbles: true })); };
    const r = c.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const probe = () => {
      c.dispatchEvent(new PointerEvent('pointermove', { clientX: at.clientX, clientY: at.clientY, bubbles: true, pointerId: 5, pointerType: 'mouse' }));
      const g = cur.getContext('2d');
      const d = g.getImageData(0, 0, cur.width, cur.height).data;
      let minX = 1e9, maxX = -1;
      for (let y = 0; y < cur.height; y += 2) {
        for (let x = 0; x < cur.width; x++) {
          if (d[(y * cur.width + x) * 4 + 3] > 32) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
        }
      }
      return maxX >= minX ? maxX - minX : 0;
    };
    set(2); const small = probe();
    set(18); const big = probe();
    return { small, big, label: (document.getElementById('ed-brush-n') || {}).textContent, value: s.value };
  })()`);
  await shot();
  check('★5 滑块改笔刷：数值变、光标环跟着变大（定位不再靠猜）',
    ring.value === '18' && ring.label === '18' && ring.big > ring.small * 2 && ring.small > 0, ring);

  /* ★6 按这幅剪影生成星球 */
  await ev(`(function () { const b = document.getElementById('ed-go'); if (b) b.click(); return true; })()`);
  const genT = await waitFor(`!document.querySelector('.lk-ed')`, 90000, 400);
  const map6 = diskMap();
  const mask6 = map6?.terrain?.mask ?? null;
  const canvas6 = await waitFor(`!!document.getElementById('map-terrain-canvas')`, 60000, 400);
  const tm6 = map6?.terrain ?? {};
  check('★6 按剪影生成：mask 320×160 落盘、form=planet、星球画布挂上',
    !!mask6 && mask6.w === 320 && mask6.h === 160 && String(mask6.bits || '').length > 1000
    && tm6.form === 'planet' && canvas6 >= 0, { genT, mask: mask6 && { w: mask6.w, h: mask6.h, bits: (mask6.bits || '').length }, form: tm6.form, canvas6 });

  /* ★7 第一次点地图 → 全窗口大图（要算）*/
  await click('.map-mode[data-mode="move"]');
  await sleep(300);
  const openBig = () => ev(`(function () {
    const svg = document.getElementById('map-svg');
    const r = svg.getBoundingClientRect();
    const x = r.left + r.width * 0.5, y = r.top + r.height * 0.5;
    const o = { clientX: x, clientY: y, bubbles: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons: 1 };
    svg.dispatchEvent(new PointerEvent('pointerdown', o));
    window.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
    return true;
  })()`);
  await openBig();
  const t7 = await waitFor(`!!document.querySelector('.lk-lb')`, 40000, 300);
  const lb7 = await ev(`(function () {
    const el = document.querySelector('.lk-lb');
    const img = document.querySelector('.lk-lb__img');
    const save = document.querySelector('.lk-lb__save');
    return el ? { open: true, w: img ? img.naturalWidth : 0, h: img ? img.naturalHeight : 0,
      save: !!save && !save.hidden } : { open: false };
  })()`);
  await shot();
  check('★7 点地图出全窗口高清大图（2304×1152、带「保存」）',
    lb7.open === true && lb7.w === 2304 && lb7.h === 1152 && lb7.save === true, { t7, ...lb7 });

  /* ★8 拖过之后点右上角 × 能关（第一百零九轮回归）*/
  await ev(`(function () {
    const el = document.querySelector('.lk-lb');
    const mk = (t, x, y, b) => new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, pointerId: 9, pointerType: 'mouse', button: b, buttons: b === 1 ? 0 : 1 });
    el.dispatchEvent(mk('pointerdown', 400, 400, 0));
    for (let i = 1; i <= 6; i++) el.dispatchEvent(new PointerEvent('pointermove', { clientX: 400 + i * 20, clientY: 400 + i * 12, bubbles: true, pointerId: 9, pointerType: 'mouse', button: 0, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', { clientX: 520, clientY: 472, bubbles: true, pointerId: 9, pointerType: 'mouse', button: 0, buttons: 0 }));
    return true;
  })()`);
  await sleep(400);
  const stillOpen = await ev(`!!document.querySelector('.lk-lb')`);
  await click('.lk-lb__close');
  const t8 = await waitFor(`!document.querySelector('.lk-lb')`, 5000, 120);
  check('★8 大图里拖动过之后，点右上角 × 仍然能关（关闭按钮回归）',
    stillOpen === true && t8 >= 0, { stillOpen, closeMs: t8 });

  /* ★9 同一张地形再点开 → 命中缓存（快、不出遮罩）*/
  const t9a = Date.now();
  await openBig();
  const t9b = await waitFor(`!!document.querySelector('.lk-lb')`, 6000, 80);
  const elapsed = Date.now() - t9a;
  const busy9 = await ev(`!!document.querySelector('.lk-busy')`);
  check('★9 同一张地形再开 = 命中缓存：瞬时打开、没出「正在出高清大图」遮罩',
    t9b >= 0 && elapsed < 1500 && busy9 === false, { startMs: t9b, elapsed, busy: busy9 });
  await click('.lk-lb__close');
  await waitFor(`!document.querySelector('.lk-lb')`, 4000, 120);

  /* ★10 无异常 */
  const errs = await ev(`window.__errs || []`);
  check('★10 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  await shot();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} PASS`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.log('FAIL 套件异常：' + (e && e.stack || e)); process.exit(1); });
