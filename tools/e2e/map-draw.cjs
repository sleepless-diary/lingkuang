/* 第一百零九轮：手绘面板 + 高清大图缓存 + 大图查看器关闭。
 * 第一百三十五~三十七轮：面板重写成**图层列表**（1024×512；五类层可多张）+ 每层湍流参数 + 变换 + 液化。
 *
 *  这套件钉的是**能被量出来的那几件事**：
 *    ★0 前置：地图栏「地形 · 原型…」在、区域精细化已删、等高线四档、旧画笔条已删；
 *    ★1 面板骨架：生成层/效果层两组、4 行默认图层（land/zone/climate/turb；噪声已并入地形强度）、
 *        新建层下拉无 noise、draggable、海陆层 陆地/海洋、笔刷 1~40、缩放三键、双画布；
 *    ★2 画一笔：陆地% 上升；
 *    ★3 滚轮缩放；★4 中键平移；★5 滑块改笔刷 + 圆环半径；
 *    ★5b 点图层行：地形层有 7 支笔刷 + 强度滑块；湍流层也有强度；
 *    ★5c 地形逐格强度：强度 2 画山 ⇒ 状态行「强度均 2.0」；
 *    ★5h 同一层里强度 2 与 8 两片并存 ⇒ 平均值落在中间；
 *    ★5d 地形/气候常显：切回海陆层仍看得到高山（像素 r ≥ g）；
 *    ★5e 湍流层画下即时生效：陆地包围盒当场被推开；
 *    ★5f 切类别换回该类笔刷（erase 撞名回归）；★5g 刷完再算（笔画中 0 次重建、松手 1 次）；
 *    ★6 新建层：＋新建「湍流」⇒ 图层 5 行、属性面板出现 6 个湍流参数；★6b 拖动排序；
 *    ★7 变换：拖动框内 ⇒ 陆地包围盒平移，撤销能回去；
 *    ★8 液化：膨胀一笔 ⇒ 轮廓被撑开；
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
      addKinds: [...el.querySelectorAll('#ed-add-kind option')].map((o) => o.value).join(','),
      groups: [...el.querySelectorAll('.lk-ed__grouphead')].map((g) => (g.textContent || '').replace(/\\d+/g, '').trim()).join(','),
      draggable: [...el.querySelectorAll('[data-kind]')].every((r) => r.getAttribute('draggable') === 'true'),
      tools: [...el.querySelectorAll('[data-tool]')].map((b) => b.dataset.tool).join(','),
      slider: !!s && s.type === 'range' && s.min === '1' && s.max === '160' && s.value === '8',
      /* 第一百四十轮：笔刷/强度/粘性搬到**单独一行**属性栏（.lk-ed__tools） */
      toolsRow: !!el.querySelector('.lk-ed__tools #ed-brush')
        && !!el.querySelector('.lk-ed__tools #ed-strength')
        && !!el.querySelector('.lk-ed__tools #ed-visc'),
      barHasSliders: !!el.querySelector('.lk-ed__bar input[type="range"]'),
      zoomBtns: !!document.getElementById('ed-zoom-in') && !!document.getElementById('ed-zoom-out') && !!document.getElementById('ed-zoom-fit'),
      canvases: !!c && !!document.getElementById('ed-cursor'),
      cursorPE: getComputedStyle(document.getElementById('ed-cursor')).pointerEvents,
      side: !!document.getElementById('ed-layers') && !!document.getElementById('ed-props'),
      fills: Math.abs(r.width - st.width) <= 2 && Math.abs(r.height - st.height) <= 2,
      zoom: (document.getElementById('ed-zoom') || {}).textContent,
    };
  })()`);
  await shot();
  check('★1 面板：生成层/效果层两组、4 行图层（噪声已并进地形）、海陆层陆地/海洋、笔刷 1~160、属性栏单开一行',
    panel.open === true && panel.layers === 'land,zone,climate,turb'
    && panel.addKinds === 'land,zone,climate,turb'
    && panel.groups === '生成层,效果层' && panel.draggable === true
    && panel.tools === 'land,sea' && panel.slider === true && panel.zoomBtns === true
    && panel.toolsRow === true && panel.barHasSliders === false
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

  /* ★5b 点图层行：换层只换调色板；地形/湍流都有强度滑块 */
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
  check('★5b 图层行切换：地形层有 7 种地形笔刷 + 强度滑块；湍流层也有强度',
    layerUi.land.tools === 'land,sea' && layerUi.land.strength === 'none'
    && layerUi.zone.tools === 'mountain,hill,plateau,basin,plain,peak,lake,erase'
    && layerUi.zone.strength !== 'none'
    && layerUi.turb.tools === 'turb,erase' && layerUi.turb.strength !== 'none', layerUi);

  /* ★5c 地形强度：强度 2 画高山 ⇒ 状态行报「强度均 2.0」
     ⚠️ 第一百四十二轮起**地形只能画在陆地上**：先把这片刷成陆地，否则会被正确地跳掉。 */
  await pickKind('land'); await pickTool('land');
  await setBrush(40);
  await ev(DRAW(0.28, 0.30, 0.54, 0.30));
  await ev(DRAW(0.28, 0.36, 0.54, 0.36));
  await ev(DRAW(0.28, 0.42, 0.54, 0.42));
  await setBrush(18);
  await pickKind('zone'); await pickTool('mountain');
  await ev(`(function () { const s = document.getElementById('ed-strength'); s.value = '2'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await ev(DRAW(0.30, 0.42, 0.52, 0.42));
  const zoneStat = await ev(`(document.getElementById('ed-stat') || {}).textContent || ''`);
  const avg2 = Number((zoneStat.match(/强度均 ([\d.]+)/) || [])[1] || 0);
  check('★5c 地形逐格强度：强度 2 画出来的高山，状态行报平均强度 ≈ 2',
    /高山 \d+%/.test(zoneStat) && /当前「地形/.test(zoneStat) && avg2 > 1.5 && avg2 < 2.5,
    { zoneStat, avg2 });

  /* ★5h 改成强度 8 再画一片 ⇒ 平均强度被拉高（但不是 8，两片混合） */
  await ev(`(function () { const s = document.getElementById('ed-strength'); s.value = '8'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await ev(DRAW(0.30, 0.30, 0.52, 0.30));
  const zoneStat2 = await ev(`(document.getElementById('ed-stat') || {}).textContent || ''`);
  const avg8 = Number((zoneStat2.match(/强度均 ([\d.]+)/) || [])[1] || 0);
  check('★5h 强度可混用：同一张地形层里 2 和 8 两片并存，平均值落在两者之间',
    avg8 > avg2 + 0.8 && avg8 < 8, { avg2, avg8, zoneStat2 });

  /* ★5d 地形常显：切回海陆层，高山像素还在（r ≥ g） */
  const alwaysOn = await ev(`(function () {
    document.querySelector('[data-kind="land"]').click();
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    const g = c.getContext('2d');
    /* 取一个**强度 8** 的高山格（★5h 那条在 y≈0.30）：强度 2 那片太淡，绿色仍然占主导 */
    const px = g.getImageData(Math.round(r.width * 0.40), Math.round(r.height * 0.31), 1, 1).data;
    return { r: px[0], g: px[1], b: px[2] };
  })()`);
  check('★5d 地形常显：在海陆层上看得到地形层画的高山（r ≥ g）',
    alwaysOn.r >= alwaysOn.g - 2 && alwaysOn.r > 60, alwaysOn);

  /* ★15 地形只在陆地上生效（第一百四十二轮）：海上刷高山 → 跳过并提示；湖泊/内海仍可画在水上 */
  const zoneLand = await ev(`(function () {
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    const g = c.getContext('2d');
    const px = (fx, fy) => { const d = g.getImageData(Math.round(r.width * fx), Math.round(r.height * fy), 1, 1).data; return [d[0], d[1], d[2]]; };
    document.querySelector('[data-kind="zone"]').click();
    const mt = document.querySelector('[data-tool="mountain"]'); if (mt) mt.click();
    const s = document.getElementById('ed-strength'); s.value = '8'; s.dispatchEvent(new Event('input', { bubbles: true }));
    const bs = document.getElementById('ed-brush'); bs.value = '30'; bs.dispatchEvent(new Event('input', { bubbles: true }));
    const before = px(0.5, 0.85);
    const mk = (ty, fx, fy) => new PointerEvent(ty, { clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, bubbles: true, pointerId: 81, pointerType: 'mouse', button: 0, buttons: 1 });
    c.dispatchEvent(mk('pointerdown', 0.5, 0.85));
    c.dispatchEvent(mk('pointerup', 0.5, 0.85));
    const note = (document.getElementById('ed-note') || {}).textContent || '';
    const after = px(0.5, 0.85);
    /* 湖泊笔刷：同一个点（海面）应该能画 */
    const lk = document.querySelector('[data-tool="lake"]'); if (lk) lk.click();
    c.dispatchEvent(mk('pointerdown', 0.5, 0.85));
    c.dispatchEvent(mk('pointerup', 0.5, 0.85));
    const lake = px(0.5, 0.85);
    return { before, after, lake, note };
  })()`);
  check('★15 地形只在陆地上：海上刷高山被跳过并提示；湖泊仍能画在水上',
    !!zoneLand
    && Math.abs(zoneLand.after[1] - zoneLand.before[1]) <= 2 && Math.abs(zoneLand.after[2] - zoneLand.before[2]) <= 2
    && String(zoneLand.note).includes('已跳过')
    && Math.abs(zoneLand.lake[2] - zoneLand.before[2]) > 8, zoneLand);

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

  /* ★5f 换类别换回该类别自己的笔刷（zone 用过「擦除」后切到湍流，不能还是擦除） */
  await pickKind('zone'); await pickTool('erase');
  await pickKind('turb');
  const toolAfterSwitch = await ev(`(function () {
    const b = document.querySelector('.lk-ed [data-tool].is-on');
    return b ? b.dataset.tool : null;
  })()`);
  check('★5f 切类别会换回该类自己的笔刷（不会把 zone 的"擦除"带到湍流层）',
    toolAfterSwitch === 'turb', { tool: toolAfterSwitch });

  /* ★5g 刷完再算：笔画期间不重建预览，松手才重建一次 */
  const defer = await ev(`(function () {
    document.querySelector('[data-kind="turb"]').click();
    document.querySelector('[data-tool="turb"]').click();
    const bs = document.getElementById('ed-brush'); bs.value = '12'; bs.dispatchEvent(new Event('input', { bubbles: true }));
    const st = document.getElementById('ed-strength'); st.value = '8'; st.dispatchEvent(new Event('input', { bubbles: true }));
    window.__lkPrevBuilds = 0;
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    const mk = (t, x, y) => new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, pointerId: 51, pointerType: 'mouse', button: 0, buttons: 1 });
    const y = r.top + r.height * 0.52;
    const a = { x: r.left + r.width * 0.30, y }, b = { x: r.left + r.width * 0.70, y };
    c.dispatchEvent(mk('pointerdown', a.x, a.y));
    for (let i = 1; i <= 10; i++) c.dispatchEvent(mk('pointermove', a.x + (b.x - a.x) * i / 10, a.y));
    const during = window.__lkPrevBuilds || 0;
    c.dispatchEvent(mk('pointerup', b.x, b.y));
    const after = window.__lkPrevBuilds || 0;
    return { during, after };
  })()`);
  check('★5g 刷完再算：笔画中不重建预览（0 次），松手才重建（≥1 次）',
    defer.during === 0 && defer.after >= 1, defer);

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
  check('★6 新建「湍流」层：图层 5 行（4 默认 + 1 新建）、自动选中、属性面板有尺度/幅度/细节/种子/混合/扩散',
    addLayer.layers === 5
    && ['scale', 'amp', 'octaves', 'seed', 'blend', 'diffusion'].every((k) => propsNow.includes(k)),
    { layers: addLayer.layers, props: propsNow });

  /* ★6b 拖动排序（不再有 ↑↓ 按钮）：把「地形」拖到「海陆」上面 */
  const dragRes = await ev(`(function () {
    const rows = [...document.querySelectorAll('#ed-layers [data-kind]')];
    const land = rows.find((r) => r.dataset.kind === 'land');
    const zone = rows.find((r) => r.dataset.kind === 'zone');
    const dt = new DataTransfer();
    const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    fire(zone, 'dragstart');
    fire(land, 'dragover');
    fire(land, 'drop');
    fire(zone, 'dragend');
    return {
      order: [...document.querySelectorAll('#ed-layers [data-kind]')].map((r) => r.dataset.kind).join(','),
      upDownButtons: document.querySelectorAll('#ed-props [data-act="up"], #ed-props [data-act="down"]').length,
    };
  })()`);
  check('★6b 拖动排序：把地形拖到海陆之上（顺序真的换），且没有 ↑↓ 按钮',
    dragRes.order.split(',').slice(0, 2).join(',') === 'zone,land' && dragRes.upDownButtons === 0,
    dragRes);

  /* ★7 变换：拖动框内 ⇒ 陆地包围盒平移；撤销回去
     ⚠️ 先临时隐藏所有湍流层：湍流会把「显示出来的陆地」推走，绿色包围盒就不再等于
     海陆层自己的数据包围盒（变换框是按数据算的，点会落在框外）。
     ⚠️ 先把缩放复位：★3 把画面放大到 261%，那时画布只显示一部分，像素计数会随内容移出视口变化。 */
  await click('#ed-zoom-fit');
  await sleep(250);
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

  /* ★7c 变换轴心冻结（第一百四十轮）：旋转 8 步，**变换框**（也就是轴心）不许动。
     直接读窗口暴露的只读钩子 `__lkTfBox()` —— 老实现每步都按数据重算框，这里会漂几十像素。 */
  const pivot = await ev(`(async function () {
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    const g = c.getContext('2d');
    const scan = () => {
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const o = (y * c.width + x) * 4;
        if (d[o + 1] > d[o] + 8 && d[o + 1] > d[o + 2] + 20 && d[o + 1] > 90) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      }
      return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
    };
    document.querySelector('[data-kind="land"]').click();
    document.querySelector('[data-mode="transform"]').click();
    await new Promise((res) => requestAnimationFrame(res));
    const box0 = window.__lkTfBox();
    if (!box0) return { error: 'no tfBox' };
    const b0 = scan();
    const mx = (b0.minX + b0.maxX) / 2;
    const R = Math.max(40, Math.abs(b0.minY - 30 - b0.cy));
    const mk = (t, x, y) => new PointerEvent(t, { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 51, pointerType: 'mouse', button: 0, buttons: 1 });
    c.dispatchEvent(mk('pointerdown', mx, b0.minY - 30));
    const boxes = [];
    for (let i = 1; i <= 8; i++) {
      const ang = -Math.PI / 2 + (i * 8) * Math.PI / 180;
      c.dispatchEvent(mk('pointermove', b0.cx + Math.cos(ang) * R, b0.cy + Math.sin(ang) * R));
      await new Promise((res) => requestAnimationFrame(res));
      const b = window.__lkTfBox();
      boxes.push({ cx: +((b.x0 + b.x1) / 2).toFixed(2), cy: +((b.y0 + b.y1) / 2).toFixed(2), w: +(b.x1 - b.x0).toFixed(2) });
    }
    c.dispatchEvent(mk('pointerup', b0.cx, b0.cy - R));
    const c0 = { cx: (box0.x0 + box0.x1) / 2, cy: (box0.y0 + box0.y1) / 2 };
    const drift = boxes.reduce((m, p) => Math.max(m, Math.hypot(p.cx - c0.cx, p.cy - c0.cy)), 0);
    const after = scan();
    const contentMoved = Math.abs(after.maxX - b0.maxX) + Math.abs(after.minY - b0.minY) > 2;
    return { box0: { cx: +c0.cx.toFixed(2), cy: +c0.cy.toFixed(2) }, boxes, drift: +drift.toFixed(3), contentMoved };
  })()`);
  check('★7c 变换轴心冻结：旋转 8 步，变换框中心一动不动（轴心 = 按下那一刻）',
    !!pivot && !pivot.error && pivot.drift <= 0.5 && pivot.contentMoved === true, pivot);
  await click('#ed-undo');
  await sleep(250);

  /* ★7d 变换是「一一对应」的：连续旋转 3 次，陆地像素数不许涨、也不许崩。
     老 bug：极点用镜像（相位 π）采样 ⇒ 同一格内容映射到两个落点 ⇒ 每转一次多复制一份，
     6% 的陆地几次之后变成 17% 的满地碎片（用户 2026-10-31 报的"变换几次就全消失/散架"）。 */
  const tfArea = await ev(`(async function () {
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    const g = c.getContext('2d');
    const count = () => {
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 1] > d[i] + 8 && d[i + 1] > d[i + 2] + 20 && d[i + 1] > 90) n++;
      return n;
    };
    const boxOf = () => window.__lkTfBox();
    /* 坐标一律用编辑器自己的视图（pan / cellPx）换算 —— 别拿画布像素猜，
       缩放不是 100% 时猜出来的 cp 全错，拖了等于没拖（★7e 一开始就被这个坑骗过）。 */
    const view = () => window.__lkView();
    const toX = (v) => view().panX + v * view().cellPx;
    const toY = (v) => view().panY + v * view().cellPx;
    document.querySelector('[data-mode="transform"]').click();
    await new Promise((res) => requestAnimationFrame(res));
    const before = count();
    const boxStart = boxOf();
    const mk = (t, x, y) => new PointerEvent(t, { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 53, pointerType: 'mouse', button: 0, buttons: 1 });
    for (let round = 0; round < 3; round++) {
      const box = boxOf();
      if (!box) return { before, error: 'no tfBox', round };
      const mx = (box.x0 + box.x1) / 2;
      const cx = toX(mx), cy = toY((box.y0 + box.y1) / 2);
      const px0 = cx, py0 = toY(box.y0) - 30;
      const R = Math.hypot(px0 - cx, py0 - cy);
      c.dispatchEvent(mk('pointerdown', px0, py0));
      for (let i = 1; i <= 6; i++) {
        const a = -Math.PI / 2 + (i * 30) * Math.PI / 180;
        c.dispatchEvent(mk('pointermove', cx + Math.cos(a) * R, cy + Math.sin(a) * R));
      }
      c.dispatchEvent(mk('pointerup', px0, py0));
      await new Promise((res) => requestAnimationFrame(res));
    }
    const after = count();
    const boxEnd = boxOf();
    /* 旋转不改轴对齐框的尺寸/中心，所以用「有没有待烘焙变换」判断真的转过了 */
    const moved = window.__lkTfDebug().hasBase === true;
    return { before, after, moved, boxEnd, ratio: +(after / Math.max(1, before)).toFixed(3) };
  })()`);
  check('★7d 连续旋转 3 次：真的转了、陆地像素数不复制不崩（0.8 ≤ 比例 ≤ 1.25）',
    !!tfArea && !tfArea.error && tfArea.moved === true
    && tfArea.ratio >= 0.8 && tfArea.ratio <= 1.25, tfArea);
  await click('#ed-undo');
  await sleep(250);

  /* ★7e 变换默认「松手不烘焙」：拖完只是预览（按钮亮着），按「烘焙」才定稿；面积全程不变。
     老行为是每次松手就写死进数据（反复拖 = 反复最近邻重采样，越拖越糊）。 */
  const bakeUi = await ev(`(async function () {
    document.querySelector('[data-mode="transform"]').click();
    await new Promise((res) => requestAnimationFrame(res));
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    const g = c.getContext('2d');
    const count = () => {
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 1] > d[i] + 8 && d[i + 1] > d[i + 2] + 20 && d[i + 1] > 90) n++;
      return n;
    };
    const bake = document.getElementById('ed-tf-bake');
    const cancel = document.getElementById('ed-tf-reset');
    const before = count();
    const box = window.__lkTfBox();
    const diag = {
      box, landPixels: before,
      modeOn: [...document.querySelectorAll('.lk-ed [data-mode].is-on')].map((b) => b.dataset.mode).join(','),
    };
    if (!box) return { before, error: 'no tfBox', diag };
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let minX = 1e9, maxX = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3] > 0) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
    }
    const view = window.__lkView();
    const toX = (v) => view.panX + v * view.cellPx;
    const toY = (v) => view.panY + v * view.cellPx;
    /* 抓「旋转手柄」（框顶部那个圆点）：中心拖动在薄条上容易点空，手柄更稳 */
    const mx = (box.x0 + box.x1) / 2;
    const cxS = toX(mx), cyS = toY((box.y0 + box.y1) / 2);
    const px0 = cxS, py0 = toY(box.y0) - 30;
    const R = Math.hypot(px0 - cxS, py0 - cyS);
    const mk = (t, x, y) => new PointerEvent(t, { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 55, pointerType: 'mouse', button: 0, buttons: 1 });
    c.dispatchEvent(mk('pointerdown', px0, py0));
    const afterDown = window.__lkTfDebug();
    for (let i = 1; i <= 6; i++) {
      const a = -Math.PI / 2 + (i * 6) * Math.PI / 180;
      c.dispatchEvent(mk('pointermove', cxS + Math.cos(a) * R, cyS + Math.sin(a) * R));
    }
    c.dispatchEvent(mk('pointerup', cxS, cyS - R));
    diag.afterDown = afterDown;
    diag.pressAt = { px0, py0, R, cxS, cyS, view };
    await new Promise((res) => requestAnimationFrame(res));
    const afterDrag = count();
    const pendingAfterDrag = { bakeDisabled: bake.disabled, cancelDisabled: cancel.disabled };
    bake.click();
    await new Promise((res) => requestAnimationFrame(res));
    const afterBake = count();
    return {
      before, afterDrag, afterBake, pendingAfterDrag, diag,
      afterBakeState: { bakeDisabled: bake.disabled, cancelDisabled: cancel.disabled },
      ratio_drag: +(afterDrag / Math.max(1, before)).toFixed(3),
      ratio_bake: +(afterBake / Math.max(1, before)).toFixed(3),
    };
  })()`);
  check('★7e 默认「松手不烘焙」：拖完仍在待烘焙态（按钮亮），点「烘焙」才定稿、面积不变',
    !!bakeUi && !bakeUi.error && bakeUi.pendingAfterDrag?.bakeDisabled === false
    && bakeUi.afterBakeState?.bakeDisabled === true
    && bakeUi.ratio_drag >= 0.8 && bakeUi.ratio_drag <= 1.25
    && bakeUi.ratio_bake >= 0.8 && bakeUi.ratio_bake <= 1.25, bakeUi);

  /* ★7f 勾上「松手烘焙」⇒ 松手就是定稿（等于老行为），松手后没有待烘焙内容 */
  const bakeOnRelease = await ev(`(async function () {
    const chk = document.getElementById('ed-bake-release');
    chk.checked = true;
    chk.dispatchEvent(new Event('change', { bubbles: true }));
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    const g = c.getContext('2d');
    const box = window.__lkTfBox();
    if (!box) return { error: 'no tfBox' };
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let minX = 1e9, minY = 1e9, maxX = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3] > 0) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; }
    }
    const cp = (maxX - minX + 1) / 1024;
    const view = window.__lkView();
    const sx = view.panX + ((box.x0 + box.x1) / 2) * view.cellPx;
    const sy = view.panY + ((box.y0 + box.y1) / 2) * view.cellPx;
    const mk = (t, x, y) => new PointerEvent(t, { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 56, pointerType: 'mouse', button: 0, buttons: 1 });
    c.dispatchEvent(mk('pointerdown', sx, sy));
    const started = window.__lkTfDebug().hasDrag;
    for (let i = 1; i <= 4; i++) c.dispatchEvent(mk('pointermove', sx + i * 8, sy));
    c.dispatchEvent(mk('pointerup', sx + 32, sy));
    await new Promise((res) => requestAnimationFrame(res));
    const baked = document.getElementById('ed-tf-bake').disabled;
    chk.checked = false;
    chk.dispatchEvent(new Event('change', { bubbles: true }));
    return { started, bakeDisabledAfterRelease: baked };
  })()`);
  check('★7f 勾「松手烘焙」⇒ 一松手就定稿（无待烘焙内容）',
    !!bakeOnRelease && !bakeOnRelease.error && bakeOnRelease.bakeDisabledAfterRelease === true, bakeOnRelease);

  /* ★7g 变换「纵向不补」：把内容往下推一大截，**顶上一段必须是空的**（不能由底部补上来）。
     用户 2026-10-31 18:12：「上面缺失的部分不需要从底部补」。 */
  const tfNoFill = await ev(`(async function () {
    const bake = document.getElementById('ed-tf-bake');
    if (bake && !bake.disabled) bake.click();
    document.querySelector('[data-mode="transform"]').click();
    await new Promise((res) => requestAnimationFrame(res));
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    const g = c.getContext('2d');
    const box = window.__lkTfBox();
    if (!box) return { error: 'no tfBox' };
    const view = window.__lkView();
    const landIn = (y0cell, y1cell) => {
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      const ya = Math.max(0, Math.round(view.panY + y0cell * view.cellPx));
      const yb = Math.min(c.height - 1, Math.round(view.panY + y1cell * view.cellPx));
      for (let y = ya; y <= yb; y++) for (let x = 0; x < c.width; x++) {
        const o = (y * c.width + x) * 4;
        if (d[o + 1] > d[o] + 8 && d[o + 1] > d[o + 2] + 20 && d[o + 1] > 90) n++;
      }
      return n;
    };
    const topBefore = landIn(0, 60);
    const boxBefore = window.__lkTfBox();
    const sx = view.panX + ((box.x0 + box.x1) / 2) * view.cellPx;
    const sy = view.panY + ((box.y0 + box.y1) / 2) * view.cellPx;
    const mk = (t, x, y) => new PointerEvent(t, { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 57, pointerType: 'mouse', button: 0, buttons: 1 });
    c.dispatchEvent(mk('pointerdown', sx, sy));
    /* 往下推 300 格：内容会被推出下边界；老实现（双轴取模）会把越界那段**从顶上补回来** */
    c.dispatchEvent(mk('pointermove', sx, sy + 150 * view.cellPx));
    c.dispatchEvent(mk('pointermove', sx, sy + 300 * view.cellPx));
    c.dispatchEvent(mk('pointerup', sx, sy + 300 * view.cellPx));
    await new Promise((res) => requestAnimationFrame(res));
    const topAfter = landIn(0, 60);
    const boxAfter = window.__lkTfBox();
    const moved = !!boxAfter && !!boxBefore && boxAfter.y0 - boxBefore.y0 > 150;
    return { topBefore, topAfter, moved, boxBefore, boxAfter, cellPx: +view.cellPx.toFixed(3) };
  })()`);
  check('★7g 变换纵向「留空」：内容往下推 300 格后，顶上 60 格不再有陆地（没有从底部补上来）',
    !!tfNoFill && !tfNoFill.error && tfNoFill.moved === true && tfNoFill.topAfter === 0, tfNoFill);
  await click('#ed-undo');
  await sleep(250);
  /* ★14 自动识别海岸（第一百四十一轮终版）：点一条边缘 ⇒ 立刻选中那一条；
     再点取消；搬走 200 格仍跟着；手绘 / 自动识别二选一。 */
  const NOTE_SEL = `[...document.querySelectorAll('#ed-props .lk-ed__subnote')].map((n) => n.textContent).join(' | ')`;
  const COUNT_LAND = `(function () {
    const c = document.getElementById('ed-canvas');
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 1] > d[i] + 8 && d[i + 1] > d[i + 2] + 20 && d[i + 1] > 90) n++;
    return n;
  })()`;
  /** 选中第 i 条湍流层并设可见性（顺带把它变成当前层） */
  const pickTurb = async (i, visible) => {
    await ev(`document.querySelectorAll('#ed-layers [data-kind="turb"]')[${i}].click(); true`);
    const on = await ev(`!!(document.querySelector('#ed-props [data-prop="on"]') || {}).checked`);
    if (visible !== undefined && on !== visible) {
      await ev(`document.querySelector('#ed-props [data-prop="on"]').click(); true`);
    }
  };
  /** 点最靠上的那条海岸线 */
  const clickTopCoast = () => ev(`(function () {
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let px = -1, py = 1e9;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const o = (y * c.width + x) * 4;
      if (d[o + 1] > d[o] + 8 && d[o + 1] > d[o + 2] + 20 && d[o + 1] > 90) { if (y < py) { py = y; px = x; } }
    }
    if (px < 0) return { error: 'no land' };
    const mk = (t, x, y) => new PointerEvent(t, { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 63, pointerType: 'mouse', button: 0, buttons: 1 });
    c.dispatchEvent(mk('pointerdown', px, py - 1));
    c.dispatchEvent(mk('pointerup', px, py - 1));
    return { note: ${NOTE_SEL}, at: { px, py } };
  })()`);

  await setTurbOn(false);          /* 其它湍流层先关掉，只测第 0 条 */
  await pickTurb(0, false);
  const bandSetup = await ev(`(function () {
    document.querySelector('[data-mode="brush"]').click();
    const sel = document.querySelector('#ed-props [data-prop="band"]');
    if (!sel) return { error: 'no mode select' };
    sel.value = '1';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      hasWidth: !!document.querySelector('#ed-props [data-prop="bandWidth"]'),
      hasFalloff: !!document.querySelector('#ed-props [data-prop="bandFalloff"]'),
      note: ${NOTE_SEL},
    };
  })()`);
  const bandClick = await clickTopCoast();

  /* 开/关这条沿岸带层，量"效果"的像素差 */
  const measureBand = async () => {
    await pickTurb(0, true);
    await sleep(200);
    const on = await ev(COUNT_LAND);
    await pickTurb(0, false);
    await sleep(200);
    const off = await ev(COUNT_LAND);
    return { on, off, d: Math.abs(on - off) };
  };
  const m1 = await measureBand();

  /* 再点一下同一条海岸 ⇒ 取消 */
  const bandDeselect = await clickTopCoast();
  const m2 = await measureBand();

  /* 再选一次，然后把海陆搬走 200 格并烘焙 ⇒ 效果要跟到新海岸 */
  const bandReselect = await clickTopCoast();
  const bandMoved = await ev(`(async function () {
    document.querySelector('[data-kind="land"]').click();
    document.querySelector('[data-mode="transform"]').click();
    await new Promise((res) => requestAnimationFrame(res));
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    const box = window.__lkTfBox();
    if (!box) return { error: 'no tfBox' };
    const view = window.__lkView();
    const sx = view.panX + ((box.x0 + box.x1) / 2) * view.cellPx;
    const sy = view.panY + ((box.y0 + box.y1) / 2) * view.cellPx;
    const mk = (t, x, y) => new PointerEvent(t, { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 62, pointerType: 'mouse', button: 0, buttons: 1 });
    c.dispatchEvent(mk('pointerdown', sx, sy));
    c.dispatchEvent(mk('pointermove', sx + 200 * view.cellPx, sy));
    c.dispatchEvent(mk('pointerup', sx + 200 * view.cellPx, sy));
    const bake = document.getElementById('ed-tf-bake');
    if (bake && !bake.disabled) bake.click();
    await new Promise((res) => requestAnimationFrame(res));
    return { baked: true };
  })()`);
  const m3 = await measureBand();

  /* 二选一：切回「手绘强度」⇒ 自动识别的参数/选择整块消失（并把闸门清空） */
  await pickTurb(0, true);
  const exclusivity = await ev(`(function () {
    const sel = document.querySelector('#ed-props [data-prop="band"]');
    if (!sel) return { error: 'no select' };
    sel.value = '0';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      widthGone: !document.querySelector('#ed-props [data-prop="bandWidth"]'),
      noteGone: !(${NOTE_SEL}).includes('已选'),
    };
  })()`);
  check('★14 自动识别海岸：点一条边缘立刻生效、可取消、搬走 200 格仍跟着；手绘/自动二选一',
    !!bandSetup && !bandSetup.error && bandSetup.hasWidth && bandSetup.hasFalloff
    && String(bandSetup.note).includes('已选 0 条')
    && String(bandClick?.note || '').includes('已选 1 条')
    && m1.d > 300
    && String(bandDeselect?.note || '').includes('已选 0 条') && m2.d < m1.d * 0.4
    && String(bandReselect?.note || '').includes('已选 1 条')
    && !!bandMoved && !bandMoved.error && m3.d > 300
    && !!exclusivity && exclusivity.widthGone === true && exclusivity.noteGone === true,
    { bandSetup, bandClick, bandDeselect, bandReselect, bandMoved, exclusivity, m1, m2, m3 });

  /* 把湍流层重新显示回来（★9 生成时要有两层的效果） */
  await setTurbOn(true);

  /* ★8 液化：膨胀 / 推挤（第一百四十轮：**逐帧连续**，所以这里必须真的跨帧按住）
     ⚠️ 前面几轮把陆地搬/转过，形状已经不适合"从北岸撑开"了 —— 先落实现有变换、重画一块干净的陆地，
     否则这一段测的不是液化，而是"上一段留下的形状恰不恰好"。 */
  await setTurbOn(false);
  await ev(`(function () {
    const bake = document.getElementById('ed-tf-bake');
    if (bake && !bake.disabled) bake.click();
    document.getElementById('ed-zoom-fit').click();
    document.querySelector('[data-mode="brush"]').click();
    document.querySelector('[data-kind="land"]').click();
    const t = document.querySelector('[data-tool="land"]'); if (t) t.click();
    /* 先把海陆层清空：前面几轮搬来转去，剩下的形状会让"从北岸撑开"量到别处去 */
    const clear = document.querySelector('#ed-props [data-act="clear"]');
    if (clear) clear.click();
    const bs = document.getElementById('ed-brush'); bs.value = '60'; bs.dispatchEvent(new Event('input', { bubbles: true }));
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    const mk = (ty, fx, fy) => new PointerEvent(ty, { clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, bubbles: true, pointerId: 45, pointerType: 'mouse', button: 0, buttons: 1 });
    c.dispatchEvent(mk('pointerdown', 0.35, 0.45));
    for (let i = 1; i <= 5; i++) c.dispatchEvent(mk('pointermove', 0.35 + i * 0.03, 0.45 + (i % 2) * 0.02));
    c.dispatchEvent(mk('pointerup', 0.5, 0.45));
    return true;
  })()`);
  await sleep(300);
  await ev(`(function () {
    document.querySelector('[data-kind="land"]').click();
    document.querySelector('[data-mode="liquify"]').click();
    document.querySelector('[data-liq="bulge"]').click();
    return true;
  })()`);
  await ev(`(function () { const s = document.getElementById('ed-strength'); s.value = '8'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await setBrush(26);
  const LIQ_SCAN = `(function () {
    const c = document.getElementById('ed-canvas');
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, n = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const o = (y * c.width + x) * 4;
      if (d[o + 1] > d[o] + 8 && d[o + 1] > d[o + 2] + 20 && d[o + 1] > 90) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    return { minX, minY, maxX, maxY, n };
  })()`;
  const liqBefore = await ev(LIQ_SCAN);
  /* 从北岸边缘按下：轮廓会被撑出去（推动一笔只会让色块内部滑动，轮廓不变） */
  await ev(`(function () {
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    const before = ${JSON.stringify(liqBefore)};
    const x = r.left + (before.minX + before.maxX) / 2;
    const y = r.top + before.minY + 4;
    window.__lkLiqAt = { x, y };
    c.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, pointerId: 31, pointerType: 'mouse', button: 0, buttons: 1 }));
    return true;
  })()`);
  /* ⭐ 按住不动 400ms：老实现这一步什么都不发生，新实现要一直往外胀 */
  await sleep(400);
  const liqHeld = await ev(LIQ_SCAN);
  /* 再慢慢横推 6 步（每步 3px，远小于一格）：老实现被 Math.round 舍成 0 */
  for (let i = 1; i <= 6; i++) {
    await ev(`(function () {
      const p = window.__lkLiqAt;
      const c = document.getElementById('ed-canvas');
      c.dispatchEvent(new PointerEvent('pointermove', { clientX: p.x + ${i * 3}, clientY: p.y, bubbles: true, pointerId: 31, pointerType: 'mouse', button: 0, buttons: 1 }));
      return true;
    })()`);
    await sleep(60);
  }
  await ev(`(function () {
    const p = window.__lkLiqAt;
    const c = document.getElementById('ed-canvas');
    c.dispatchEvent(new PointerEvent('pointerup', { clientX: p.x + 18, clientY: p.y, bubbles: true, pointerId: 31, pointerType: 'mouse', button: 0, buttons: 1 }));
    return true;
  })()`);
  await sleep(200);
  const liqAfter = await ev(LIQ_SCAN);
  check('★8 液化（按住不动）：膨胀一笔持续生效 ⇒ 轮廓被撑开',
    liqHeld.minY < liqBefore.minY - 1 || liqHeld.n > liqBefore.n * 1.02,
    { before: liqBefore, held: liqHeld });
  check('★8b 液化（慢慢横拖）：亚格位移会累积 ⇒ 还在继续变',
    liqAfter.n !== liqHeld.n || liqAfter.maxX !== liqHeld.maxX,
    { held: liqHeld, after: liqAfter });

  /* ★8c 推挤（慢拖 3px/步）：老实现「位移 × 强度」<半格，被 Math.round 舍成 0 ⇒ 拖了像没拖。
     现在位移场是浮点、逐帧累加 ⇒ 画面签名一定会变。 */
  await ev(`(function () { const b = document.querySelector('[data-liq="push"]'); if (b) b.click(); return !!b; })()`);
  const pushSlow = await ev(`(async function () {
    const c = document.getElementById('ed-canvas');
    const r = c.getBoundingClientRect();
    const g = c.getContext('2d');
    const sig = () => {
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s = (s * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) % 1000000007;
      return s;
    };
    const before = sig();
    const at = window.__lkLiqAt || { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const mk = (t, cx, cy) => new PointerEvent(t, { clientX: cx, clientY: cy, bubbles: true, pointerId: 33, pointerType: 'mouse', button: 0, buttons: 1 });
    c.dispatchEvent(mk('pointerdown', at.x, at.y));
    for (let i = 1; i <= 6; i++) {
      c.dispatchEvent(mk('pointermove', at.x + i * 3, at.y));
      await new Promise((res) => requestAnimationFrame(res));
      await new Promise((res) => requestAnimationFrame(res));
    }
    c.dispatchEvent(mk('pointerup', at.x + 18, at.y));
    await new Promise((res) => requestAnimationFrame(res));
    return { before, after: sig() };
  })()`);
  check('★8c 推挤（慢拖 3px/步）：亚格位移累积 ⇒ 画面真的变了',
    !!pushSlow && pushSlow.before !== pushSlow.after, pushSlow);
  await setTurbOn(true);

  /* ★11 经度环绕（第一百四十轮）：最左一列点一笔，最右**同一高度**也变陆地。
     原理：横向取模 —— 原型 x=0 与 x=1023 是同一根经线，笔刷在接缝处应该接着画。
     ⚠️ 先隐藏湍流层：湍流会把糊开的海陆场重新判成海，接缝那点小笔迹会被它吃掉（同 ★7/★8）。 */
  await setTurbOn(false);
  await ev(`(function () {
    document.querySelector('[data-mode="brush"]').click();
    document.querySelector('[data-kind="land"]').click();
    const t = document.querySelector('[data-tool="land"]'); if (t) t.click();
    return true;
  })()`);
  /* 先把缩放/平移复位（★3/★4 把它推到 261% 了，那样整张图画布铺满，找不到"接缝"） */
  await click('#ed-zoom-fit');
  await sleep(300);
  await setBrush(14);
  const seam = await ev(`(function () {
    const c = document.getElementById('ed-canvas');
    const g = c.getContext('2d');
    const w = c.width, h = c.height;
    const before = g.getImageData(0, 0, w, h).data;
    /* 图片在画布上的真实边界：画布外是透明的（ctx.clearRect 之后只画了那张图） */
    let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (before[(y * w + x) * 4 + 3] > 0) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    const r = c.getBoundingClientRect();
    const midY = Math.round((minY + maxY) / 2);
    const mk = (t) => new PointerEvent(t, { clientX: r.left + minX + 2, clientY: r.top + midY, bubbles: true, pointerId: 41, pointerType: 'mouse', button: 0, buttons: 1 });
    c.dispatchEvent(mk('pointerdown'));
    c.dispatchEvent(mk('pointerup'));
    const after = g.getImageData(0, 0, w, h).data;
    const at = (x, y) => { const o = ((y * w + x) | 0) * 4; return [after[o], after[o + 1], after[o + 2], after[o + 3]]; };
    return {
      bounds: { minX, maxX, minY, maxY, midY },
      leftEdge: at(minX + 2, midY),
      rightEdge: at(maxX - 2, midY),
      control: at(maxX - 2, midY - 80),
    };
  })()`);
  check('★11 经度环绕：左边点一笔，右边同一高度也变陆地（接缝接得上）',
    seam.bounds.maxX - seam.bounds.minX > 100
    && (seam.leftEdge[1] > seam.leftEdge[0] + 8)
    && (seam.rightEdge[1] > seam.rightEdge[0] + 8 && seam.rightEdge[1] > seam.rightEdge[2] + 20),
    seam);

  /* ★11b 纵向球面（跨极点，口径 A）：把画笔挪到画布**上边界之外**点一下，
     落点应该在「对面经线（x + W/2）+ 上下镜像」的位置 —— 就像沿大圆穿过北极。
     判据：目标格变陆地，而同一列（不加相位）那格没变。 */
  const polar = await ev(`(function () {
    const c = document.getElementById('ed-canvas');
    const g = c.getContext('2d');
    const w = c.width, h = c.height;
    const d = g.getImageData(0, 0, w, h).data;
    let minX = 1e9, maxX = -1, minY = 1e9;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 0) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; }
    }
    const cp = (maxX - minX + 1) / 1024;
    const W = 1024, H = 512;
    const X0 = 300, OFF = 20;                   /* 从 x=300 那列、**整个笔刷都在上边外**（笔刷半径 13 < 20） */
    const r = c.getBoundingClientRect();
    const at = (cx, cy) => ({ clientX: r.left + minX + (cx + 0.5) * cp, clientY: r.top + minY + (cy + 0.5) * cp });
    const mk = (t, p) => new PointerEvent(t, { clientX: p.clientX, clientY: p.clientY, bubbles: true, pointerId: 43, pointerType: 'mouse', button: 0, buttons: 1 });
    const above = at(X0, -OFF);
    c.dispatchEvent(mk('pointerdown', above));
    c.dispatchEvent(mk('pointerup', above));
    const after = g.getImageData(0, 0, w, h).data;
    const px = (cx, cy) => {
      const p = at(cx, cy);
      const sx = Math.round(p.clientX - r.left), sy = Math.round(p.clientY - r.top);
      const o = (sy * w + sx) * 4;
      return [after[o], after[o + 1], after[o + 2]];
    };
    const isLand = (v) => v[1] > v[0] + 8 && v[1] > v[2] + 20 && v[1] > 90;
    const mirrored = px((X0 + W / 2) % W, OFF);   /* 对面经线 + 镜像 ⇒ 这里应该被画到 */
    const sameCol = px(X0, OFF);                  /* 不加相位 ⇒ 这里不该变 */
    return { cp: +cp.toFixed(3), X0, OFF, mirrored, sameCol, okMirror: isLand(mirrored), okSameCol: isLand(sameCol) };
  })()`);
  check('★11b 纵向球面：上边界外一笔 ⇒ 落到对面经线 + 镜像（x+512, y 取反）',
    !!polar && polar.okMirror === true && polar.okSameCol === false, polar);

  /* ★9 按这幅原型生成 */
  await ev(`(function () { const b = document.getElementById('ed-go'); if (b) b.click(); return true; })()`);
  const genT = await waitFor(`!document.querySelector('.lk-ed')`, 90000, 400);
  /* 落盘是异步的（生成完 → 写盘 → 再画星球）。以前这里读得太早，proto 还是 null 就判了 FAIL；
     现在轮询到盘上真有 proto 为止。 */
  let map6 = diskMap();
  for (let i = 0; i < 150 && !map6?.terrain?.proto; i++) {
    await sleep(400);
    map6 = diskMap();
  }
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
