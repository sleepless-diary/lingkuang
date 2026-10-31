/* 第一百零九轮：手绘面板 + 高清大图缓存 + 大图查看器关闭。
 * 第一百三十五~三十七轮：面板重写成**图层列表**（1024×512；五类层可多张）+ 每层湍流参数 + 变换 + 液化。
 *
 *  这套件钉的是**能被量出来的那几件事**：
 *    ★0 前置：地图栏「地形 · 原型…」在、区域精细化已删、等高线四档、旧画笔条已删；
 *    ★1 面板骨架：5 行图层（land/zone/climate/noise/turb）、海陆层 陆地/海洋、笔刷 1~40、缩放三键、双画布；
 *    ★2 画一笔：陆地% 上升；
 *    ★3 滚轮缩放；★4 中键平移；★5 滑块改笔刷 + 圆环半径；
 *    ★5b 点图层行：地形层有自己的笔刷；湍流层有强度滑块；
 *    ★5c 地形层画高山、噪声层画加噪：状态行各自报数；
 *    ★5d 地形/气候常显：切回海陆层仍看得到高山（像素 r ≥ g）；
 *    ★5e 湍流层画下即时生效：陆地包围盒当场被推开；
 *    ★6 新建层：＋新建「湍流」⇒ 图层 6 行、属性面板出现 6 个湍流参数；
 *    ★7 变换：拖动框内 ⇒ 陆地包围盒平移，撤销能回去；
 *    ★8 液化：推挤一笔 ⇒ 画面签名变；
 *    ★9 按原型生成：proto.layers ≥ 6（两张湍流 + 留白海层）、form=planet、画布挂上；
 *    ★10 高清大图 2304×1152 + 保存；★11 拖过之后 × 能关；★12 命中缓存；★13 无异常。
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
  await sleep(800);
  const panel = await ev(`(function () {
    const el = document.querySelector('.lk-ed');
    if (!el) return { open: false };
    const s = document.getElementById('ed-brush');
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    const st = document.getElementById('ed-stage').getBoundingClientRect();
    return {
      open: true,
      layers: [...el.querySelectorAll('[data-kind]')].map((b) => b.dataset.kind).join(','),
      tools: [...el.querySelectorAll('[data-tool]')].map((b) => b.dataset.tool).join(','),
      slider: !!s && s.type === 'range' && s.min === '1' && s.max === '40' && s.value === '8',
      zoomBtns: !!document.getElementById('ed-zoom-in') && !!document.getElementById('ed-zoom-out') && !!document.getElementById('ed-zoom-fit'),
      canvases: !!c && !!document.getElementById('ed-cursor'),
      cursorPE: getComputedStyle(document.getElementById('ed-cursor')).pointerEvents,
      side: !!document.getElementById('ed-layers') && !!document.getElementById('ed-props'),
      fills: Math.abs(r.width - st.width) <= 2 && Math.abs(r.height - st.height) <= 2,
      zoom: (document.getElementById('ed-zoom') || {}).textContent,
    };
  })()`);
  await shot();
  check('★1 面板：5 行图层、海陆层陆地/海洋、笔刷 1~40、缩放三键、双画布、图层面板',
    panel.open === true && panel.layers === 'land,zone,climate,noise,turb'
    && panel.tools === 'land,sea' && panel.slider === true && panel.zoomBtns === true
    && panel.canvases === true && panel.cursorPE === 'none' && panel.side === true
    && panel.zoom === '100%' && panel.fills === true, panel);

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
  const pickKind = (k) => ev(`(function () { const b = document.querySelector('[data-kind="${k}"]'); if (b) b.click(); return !!b; })()`);
  /** 把所有湍流层显示/隐藏（变换/液化的包围盒要按"裸海陆层"算，湍流会把它推走） */
  const setTurbOn = async (want) => {
    const cnt = await ev(`document.querySelectorAll('[data-kind="turb"]').length`);
    for (let i = 0; i < cnt; i++) {
      await ev(`document.querySelectorAll('[data-kind="turb"]')[${i}].click(); true`);
      const on = await ev(`!!(document.querySelector('#ed-props [data-prop="on"]') || {}).checked`);
      if (on !== want) await ev(`document.querySelector('#ed-props [data-prop="on"]').click(); true`);
    }
  };
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
    const rect = c.getBoundingClientRect();
    return { minX, minY, maxX, maxY, n, cx: rect.left + (minX + maxX) / 2, cy: rect.top + (minY + maxY) / 2 };
  })()`;

  const painted = await ev(DRAW(0.35, 0.5, 0.65, 0.5));
  await sleep(200);
  check('★2 画一笔 ⇒ 陆地% 上升（原型真的有格子、落点准）', painted.land >= 1, painted);

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
  check('★5 滑块改笔刷：数值变、光标环跟着变大',
    ring.value === '18' && ring.label === '18' && ring.big > ring.small * 2 && ring.small > 0, ring);

  /* ★5b 点图层行：换层只换调色板；湍流层才有强度滑块 */
  const layerUi = await ev(`(function () {
    const el = document.querySelector('.lk-ed');
    const tools = () => [...el.querySelectorAll('[data-tool]')].map((b) => b.dataset.tool).join(',');
    const strength = () => getComputedStyle(document.getElementById('ed-strength-box')).display;
    const land = { tools: tools(), strength: strength() };
    el.querySelector('[data-kind="zone"]').click();
    const zone = { tools: tools(), strength: strength() };
    el.querySelector('[data-kind="turb"]').click();
    const turb = { tools: tools(), strength: strength() };
    el.querySelector('[data-kind="land"]').click();
    return { land, zone, turb };
  })()`);
  check('★5b 图层行切换：地形层有自己的笔刷；湍流层有强度滑块',
    layerUi.land.tools === 'land,sea' && layerUi.land.strength === 'none'
    && layerUi.zone.tools === 'mountain,hill,plateau,basin,lake,erase'
    && layerUi.turb.tools === 'turb,erase' && layerUi.turb.strength !== 'none', layerUi);

  /* ★5c 地形层画高山、噪声层画加噪 */
  await pickKind('zone'); await pickTool('mountain');
  await ev(DRAW(0.30, 0.42, 0.52, 0.42));
  const zoneStat = await ev(`(document.getElementById('ed-stat') || {}).textContent || ''`);
  await pickKind('noise'); await pickTool('noise-up');
  await ev(`(function () { const s = document.getElementById('ed-strength'); s.value = '8'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await ev(DRAW(0.30, 0.60, 0.58, 0.60));
  const noiseStat = await ev(`(document.getElementById('ed-stat') || {}).textContent || ''`);
  check('★5c 地形层画高山、噪声层画加噪：图层状态行各自报数',
    /高山 \d+%/.test(zoneStat) && /当前「地形/.test(zoneStat)
    && /当前「噪声/.test(noiseStat), { zoneStat, noiseStat });

  /* ★5d 地形常显：切回海陆层，高山像素还在（r ≥ g） */
  const alwaysOn = await ev(`(function () {
    document.querySelector('[data-kind="land"]').click();
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    const g = c.getContext('2d');
    const px = g.getImageData(Math.round(r.width * 0.40), Math.round(r.height * 0.42), 1, 1).data;
    return { r: px[0], g: px[1], b: px[2] };
  })()`);
  check('★5d 地形常显：在海陆层上看得到地形层画的高山（r ≥ g）',
    alwaysOn.r >= alwaysOn.g - 2 && alwaysOn.r > 60, alwaysOn);

  /* ★5e 湍流层画下即时生效：陆地包围盒当场被推开 */
  const bb0 = await ev(BBOX);
  await pickKind('turb'); await pickTool('turb'); await setBrush(10);
  await ev(`(function () { const s = document.getElementById('ed-strength'); s.value = '8'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await ev(DRAW(0.34, 0.49, 0.66, 0.49));
  await pickKind('land');
  await sleep(200);
  const bb1 = await ev(BBOX);
  check('★5e 湍流写下去当场生效：陆地包围盒/像素数被推开（不等生成）',
    bb0.n > 100 && (bb1.minY < bb0.minY - 1 || bb1.maxY > bb0.maxY + 1 || Math.abs(bb1.n - bb0.n) > bb0.n * 0.01),
    { before: bb0, after: bb1 });

  /* ★6 新建一层（湍流）：图层数 +1、属性面板出现 6 个湍流参数 */
  const addLayer = await ev(`(function () {
    const sel = document.getElementById('ed-add-kind');
    sel.value = 'turb';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('ed-add').click();
    const props = [...document.querySelectorAll('#ed-props [data-prop]')].map((e) => e.dataset.prop);
    return {
      layers: document.querySelectorAll('[data-kind]').length,
      activeTurb: !!document.querySelector('.lk-ed__layer.is-on [data-kind="turb"], .lk-ed__layer.is-on[data-kind="turb"]'),
      props,
    };
  })()`);
  await sleep(300);
  const propsNow = await ev(`[...document.querySelectorAll('#ed-props [data-prop]')].map((e) => e.dataset.prop)`);
  check('★6 新建「湍流」层：图层 6 行、自动选中、属性面板有尺度/幅度/细节/种子/混合/扩散',
    addLayer.layers === 6
    && ['scale', 'amp', 'octaves', 'seed', 'blend', 'diffusion'].every((k) => propsNow.includes(k)),
    { layers: addLayer.layers, props: propsNow });

  /* ★7 变换：拖动框内 ⇒ 陆地包围盒平移；撤销回去
     ⚠️ 先临时隐藏所有湍流层：湍流会把「显示出来的陆地」推走，绿色包围盒就不再等于
     海陆层自己的数据包围盒（变换框是按数据算的，点会落在框外）。 */
  await setTurbOn(false);
  const tf = await ev(`(function () {
    document.querySelector('[data-kind="land"]').click();
    document.querySelector('[data-mode="transform"]').click();
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const o = (y * c.width + x) * 4;
      if (d[o + 1] > d[o] + 8 && d[o + 1] > d[o + 2] + 20 && d[o + 1] > 90) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    const px = (minX + maxX) / 2 + r.left, py = (minY + maxY) / 2 + r.top;
    const mk = (t, x, y) => new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, pointerId: 21, pointerType: 'mouse', button: 0, buttons: 1 });
    c.dispatchEvent(mk('pointerdown', px, py));
    for (let i = 1; i <= 8; i++) c.dispatchEvent(mk('pointermove', px + i * 7, py));
    c.dispatchEvent(mk('pointerup', px + 56, py));
    const d2 = g.getImageData(0, 0, c.width, c.height).data;
    let minX2 = 1e9, maxX2 = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const o = (y * c.width + x) * 4;
      if (d2[o + 1] > d2[o] + 8 && d2[o + 1] > d2[o + 2] + 20 && d2[o + 1] > 90) { if (x < minX2) minX2 = x; if (x > maxX2) maxX2 = x; }
    }
    return { before: { minX, maxX, minY, maxY }, after: { minX: minX2, maxX: maxX2 } };
  })()`);
  await sleep(300);
  const tfShift = await ev(`(function () {
    const c = document.getElementById('ed-canvas');
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let minX = 1e9;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const o = (y * c.width + x) * 4;
      if (d[o + 1] > d[o] + 8 && d[o + 1] > d[o + 2] + 20 && d[o + 1] > 90 && x < minX) minX = x;
    }
    return minX;
  })()`);
  check('★7 变换：拖动框内 ⇒ 整层陆地右移（包围盒跟着走）',
    tf.after.minX > tf.before.minX + 5 && tf.after.maxX > tf.before.maxX + 5,
    { before: tf.before, after: tf.after, minXAfter: tfShift });
  await click('#ed-undo');
  await sleep(300);
  const tfUndone = await ev(BBOX);
  check('★7b 撤销变换：陆地包围盒回到拖动之前（±3px）',
    Math.abs(tfUndone.minX - tf.before.minX) <= 3, { before: tf.before.minX, undone: tfUndone.minX });
  /* 把湍流层重新显示回来（★9 生成时要有两层的效果） */
  await setTurbOn(true);

  /* ★8 液化：膨胀一笔 ⇒ 轮廓真的被撑开（先隐藏湍流，包围盒才是裸海陆层） */
  await setTurbOn(false);
  await ev(`(function () {
    document.querySelector('[data-kind="land"]').click();
    document.querySelector('[data-mode="liquify"]').click();
    document.querySelector('[data-liq="bulge"]').click();
    return true;
  })()`);
  await ev(`(function () { const s = document.getElementById('ed-strength'); s.value = '8'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await setBrush(26);
  const liq = await ev(`(function () {
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    const g = c.getContext('2d');
    const scan = () => {
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, n = 0;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const o = (y * c.width + x) * 4;
        if (d[o + 1] > d[o] + 8 && d[o + 1] > d[o + 2] + 20 && d[o + 1] > 90) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      }
      return { minX, minY, maxX, maxY, n };
    };
    const before = scan();
    const mk = (t, x, y) => new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, pointerId: 31, pointerType: 'mouse', button: 0, buttons: 1 });
    /* 从北岸边缘开始膨胀：轮廓会被撑出去（推动一笔只会让色块内部滑动，轮廓不变） */
    const x = r.left + (before.minX + before.maxX) / 2;
    const y = r.top + before.minY + 4;
    c.dispatchEvent(mk('pointerdown', x, y));
    for (let i = 1; i <= 6; i++) c.dispatchEvent(mk('pointermove', x + i * 3, y));
    c.dispatchEvent(mk('pointerup', x + 18, y));
    return { before, after: scan() };
  })()`);
  check('★8 液化：膨胀一笔 ⇒ 轮廓被撑开（minY 上移或陆地像素数变多）',
    liq.after.minY < liq.before.minY - 1 || liq.after.n > liq.before.n * 1.02,
    liq);
  await setTurbOn(true);

  /* ★9 按这幅原型生成 */
  await ev(`(function () { const b = document.getElementById('ed-go'); if (b) b.click(); return true; })()`);
  const genT = await waitFor(`!document.querySelector('.lk-ed')`, 90000, 400);
  const map6 = diskMap();
  const proto6 = map6?.terrain?.proto ?? null;
  const canvas6 = await waitFor(`!!document.getElementById('map-terrain-canvas')`, 60000, 400);
  const tm6 = map6?.terrain ?? {};
  const layers6 = proto6?.layers ?? [];
  const kinds6 = layers6.map((l) => l.kind);
  const protoBytes = proto6 ? JSON.stringify(proto6).length : 0;
  check('★9 按原型生成：proto.layers ≥ 6（≥2 张湍流 + 一张留白海）、form=planet、星球画布挂上',
    layers6.length >= 6 && kinds6.filter((k) => k === 'turb').length >= 2
    && kinds6.includes('land') && protoBytes < 80000
    && tm6.form === 'planet' && canvas6 >= 0,
    { genT, layers: layers6.length, kinds: kinds6.join(','), bytes: protoBytes, form: tm6.form, canvas6 });

  /* ★10 第一次点地图 → 全窗口大图（要算）*/
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
  check('★10 点地图出全窗口高清大图（2304×1152、带「保存」）',
    lb7.open === true && lb7.w === 2304 && lb7.h === 1152 && lb7.save === true, { t7, ...lb7 });

  /* ★11 拖过之后点右上角 × 能关 */
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
  check('★11 大图里拖动过之后，点右上角 × 仍然能关',
    stillOpen === true && t8 >= 0, { stillOpen, closeMs: t8 });

  /* ★12 同一张地形再点开 → 命中缓存 */
  const t9a = Date.now();
  await openBig();
  const t9b = await waitFor(`!!document.querySelector('.lk-lb')`, 6000, 80);
  const elapsed = Date.now() - t9a;
  const busy9 = await ev(`!!document.querySelector('.lk-busy')`);
  check('★12 同一张地形再开 = 命中缓存：瞬时打开、没出遮罩',
    t9b >= 0 && elapsed < 1500 && busy9 === false, { startMs: t9b, elapsed, busy: busy9 });
  await click('.lk-lb__close');
  await waitFor(`!document.querySelector('.lk-lb')`, 4000, 120);

  /* ★13 无异常 */
  const errs = await ev(`window.__errs || []`);
  check('★13 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  await shot();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} PASS`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.log('FAIL 套件异常：' + (e && e.stack || e)); process.exit(1); });
