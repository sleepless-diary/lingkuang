/* 第一百零九轮：手绘面板 + 高清大图缓存 + 大图查看器关闭。
 * 第一百三十五轮：面板重写成**五层 1024×512 原型**（海陆 / 地形 / 气候 / 噪声 / 边缘）。
 *
 *  用户原话（第一百零九轮）：「高清大图下右上角的关闭按钮没有用，区域精细化的功能删了吧，
 *  地形工具加入手绘面板吧，这个手绘面板精细度不够，而且不能放大或者拖动，笔刷大小用滑块调整吧，
 *  还有高清大图怎么每次都要重新算，不能保存吗，手绘地形里面的橡皮定位不清晰，海洋不就是橡皮的功能吗」
 *  用户原话（第一百三十五轮）：「我想要更高精度的手绘原型，以及能对原型进行区域噪声叠加（手动添加），
 *  以及在绘制原型时就能预设定高山等地形的位置」。
 *
 *  这套件钉的是**能被量出来的那几件事**：
 *    ★0 前置：地图栏「地形 · 手绘…」在、区域精细化按钮已删、等高线四档、旧画笔条已删；
 *    ★1 面板骨架：五层、海陆层陆地/海洋两档（无橡皮）、笔刷滑块 1~40、缩放三键、双画布（画布 + 光标环）；
 *    ★2 画一笔：陆地% 上升（原型 1024×512 ⇒ 画的是"真有格子"的东西）；
 *    ★3 滚轮缩放：以指针为锚，`#ed-zoom` 从 100% 变大，画面签名跟着变；
 *    ★4 中键平移：画面签名变（能拖动看别处）；
 *    ★5 滑块改笔刷：`#ed-brush-n` 变、光标环半径跟着变（用户报的"定位不清晰"）；
 *    ★5b 换层：地形/噪声各有自己的笔刷，强度滑块只在噪声/边缘出现；
 *    ★5c 地形层画高山、噪声层画加噪：两层各自的状态行都报出来；
 *    ★5d 地形/气候**常显**：切回海陆层，地形层画的高山仍然看得见（像素 r ≥ g）；
 *    ★5e 边缘**画下即时生效**：画一块陆地 → 沿北岸刷边缘 → 切回海陆层，包围盒立刻被推开；
 *    ★6 按原型生成：disk 上 `proto` = 1024×512 且海陆/地形/噪声层都在、form = planet、画布挂上；
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
      layers: [...el.querySelectorAll('[data-layer]')].map((b) => b.dataset.layer).join(','),
      slider: !!s && s.type === 'range' && s.min === '1' && s.max === '40' && s.value === '8',
      zoomBtns: !!document.getElementById('ed-zoom-in') && !!document.getElementById('ed-zoom-out') && !!document.getElementById('ed-zoom-fit'),
      canvases: !!c && !!document.getElementById('ed-cursor'),
      cursorPE: getComputedStyle(document.getElementById('ed-cursor')).pointerEvents,
      fills: Math.abs(r.width - st.width) <= 2 && Math.abs(r.height - st.height) <= 2,
      size: { w: Math.round(r.width), h: Math.round(r.height) },
      zoom: (document.getElementById('ed-zoom') || {}).textContent,
    };
  })()`);
  await shot();
  check('★1 面板：五层、海陆层陆地/海洋两档（无橡皮）、笔刷滑块 1~40、缩放三键、双画布铺满、光标层不挡指针',
    panel.open === true && panel.tools === 'land,sea' && panel.erase === false && panel.slider === true
    && panel.layers === 'land,zone,climate,noise,edge'
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
  /* 图层 / 笔刷 / 笔宽（★5b 之后新加的几项用） */
  const pickLayer = (n) => ev(`(function () { const b = document.querySelector('[data-layer="${n}"]'); if (b) b.click(); return !!b; })()`);
  const pickTool = (n) => ev(`(function () { const b = document.querySelector('[data-tool="${n}"]'); if (b) b.click(); return !!b; })()`);
  const setBrush = (v) => ev(`(function () { const s = document.getElementById('ed-brush'); s.value = '${v}'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
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

  /* ★5b 五层：换层只换第二行的笔刷 + 强度滑块只在噪声/边缘出现 */
  const layerUi = await ev(`(function () {
    const el = document.querySelector('.lk-ed');
    const strBox = document.getElementById('ed-strength-box');
    const tools = () => [...el.querySelectorAll('[data-tool]')].map((b) => b.dataset.tool).join(',');
    const before = { tools: tools(), strength: getComputedStyle(strBox).display };
    el.querySelector('[data-layer="zone"]').click();
    const zone = { tools: tools(), strength: getComputedStyle(strBox).display };
    el.querySelector('[data-layer="noise"]').click();
    const noise = { tools: tools(), strength: getComputedStyle(strBox).display };
    el.querySelector('[data-layer="edge"]').click();
    const edge = { tools: tools() };
    return { before, zone, noise, edge };
  })()`);
  check('★5b 换层：地形/噪声各有自己的笔刷，强度滑块只在噪声与边缘出现',
    layerUi.before.tools === 'land,sea' && layerUi.before.strength === 'none'
    && layerUi.zone.tools === 'mountain,hill,plateau,basin,lake,erase' && layerUi.zone.strength === 'none'
    && layerUi.noise.tools === 'noise-up,noise-down,erase' && layerUi.noise.strength !== 'none'
    && layerUi.edge.tools === 'edge-add,erase', layerUi);

  /* ★5c 地形层画一块高山、噪声层画一笔加噪（生成时两层都要进 proto） */
  await ev(`(function () {
    const el = document.querySelector('.lk-ed');
    el.querySelector('[data-layer="zone"]').click();
    el.querySelector('[data-tool="mountain"]').click();
    return true;
  })()`);
  await ev(DRAW(0.30, 0.42, 0.52, 0.42));
  /* 状态行只报**当前层**的明细 ⇒ 在切走之前把地形那句读下来 */
  const zoneStat = await ev(`(document.getElementById('ed-stat') || {}).textContent || ''`);
  await ev(`(function () {
    const el = document.querySelector('.lk-ed');
    el.querySelector('[data-layer="noise"]').click();
    el.querySelector('[data-tool="noise-up"]').click();
    const s = document.getElementById('ed-strength');
    s.value = '8'; s.dispatchEvent(new Event('input', { bubbles: true }));
    return { strength: (document.getElementById('ed-strength-n') || {}).textContent };
  })()`);
  await ev(DRAW(0.30, 0.60, 0.58, 0.60));
  const noiseStat = await ev(`(document.getElementById('ed-stat') || {}).textContent || ''`);
  const paintedLayers = {
    zoneStat,
    noiseStat,
    mountain: /高山 \d+%/.test(zoneStat),
    noise: /加噪 [1-9]\d*%/.test(noiseStat),
  };
  check('★5c 地形层画高山、噪声层画加噪：两层各自的状态行都报出来',
    paintedLayers.mountain === true && paintedLayers.noise === true, paintedLayers);

  /* ★5d 常显：切回「海陆」层，地形层画过的高山仍然看得见
     （陆地基色是绿：g > r；叠了高山棕之后 r ≥ g） */
  const alwaysOn = await ev(`(function () {
    const el = document.querySelector('.lk-ed');
    el.querySelector('[data-layer="land"]').click();
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    const g = c.getContext('2d');
    const px = g.getImageData(Math.round(r.width * 0.40), Math.round(r.height * 0.42), 1, 1).data;
    const tab = document.querySelector('[data-layer="land"]').classList.contains('is-on');
    return { r: px[0], g: px[1], b: px[2], landTab: tab };
  })()`);
  check('★5d 地形常显：在海陆层上看得到地形层画的高山（r ≥ g，不再只是绿色底）',
    alwaysOn.landTab === true && alwaysOn.r >= alwaysOn.g - 2 && alwaysOn.r > 60, alwaysOn);

  /* ★5e 边缘写下去**当场**生效（不用按生成）：画一块陆地 → 记下陆地的包围盒 →
     在海岸上刷边缘 → 切回海陆层，包围盒必须被推开/啃掉 */
  await setBrush(30);
  await ev(DRAW(0.30, 0.62, 0.62, 0.62));
  await ev(DRAW(0.30, 0.68, 0.62, 0.68));
  await ev(DRAW(0.30, 0.74, 0.62, 0.74));
  const BBOX = `(function () {
    const c = document.getElementById('ed-canvas');
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, n = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const o = (y * c.width + x) * 4;
      const r = d[o], gg = d[o + 1], b = d[o + 2];
      if (gg > r + 8 && gg > b + 20 && gg > 90) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    return { minX, minY, maxX, maxY, n };
  })()`;
  const bb0 = await ev(BBOX);
  await pickLayer('edge'); await pickTool('edge-add'); await setBrush(10);
  await ev(`(function () { const s = document.getElementById('ed-strength'); s.value = '8'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await ev(DRAW(0.30, 0.50, 0.62, 0.50));   /* 沿着这块地的北岸刷一笔 */
  await pickLayer('land');
  await sleep(200);
  const bb1 = await ev(BBOX);
  check('★5e 边缘写下去当场生效：陆地包围盒被湍流置换推开/啃掉（不等生成）',
    bb0.n > 100 && (bb1.minY < bb0.minY - 1 || bb1.maxY > bb0.maxY + 1 || Math.abs(bb1.n - bb0.n) > bb0.n * 0.01),
    { before: bb0, after: bb1 });

  /* ★6 按这幅原型生成星球 */
  await ev(`(function () { const b = document.getElementById('ed-go'); if (b) b.click(); return true; })()`);
  const genT = await waitFor(`!document.querySelector('.lk-ed')`, 90000, 400);
  const map6 = diskMap();
  const proto6 = map6?.terrain?.proto ?? null;
  const mask6 = map6?.terrain?.mask ?? null;
  const canvas6 = await waitFor(`!!document.getElementById('map-terrain-canvas')`, 60000, 400);
  const tm6 = map6?.terrain ?? {};
  const protoBytes = proto6 ? JSON.stringify(proto6).length : 0;
  check('★6 按原型生成：proto 1024×512（海陆 + 地形 + 噪声层都在）、form=planet、星球画布挂上',
    !!proto6 && proto6.w === 1024 && proto6.h === 512
    && typeof proto6.land === 'string' && proto6.land.length > 100
    && typeof proto6.zone === 'string' && proto6.zone.length > 0
    && typeof proto6.noise === 'string' && proto6.noise.length > 0
    && mask6 === null && protoBytes < 60000
    && tm6.form === 'planet' && canvas6 >= 0,
    { genT, proto: proto6 && { w: proto6.w, h: proto6.h, layers: Object.keys(proto6).join(','), bytes: protoBytes }, mask: mask6, form: tm6.form, canvas6 });

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
