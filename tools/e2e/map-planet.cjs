/* 地图「形态」= 星球（第九十八轮）：球面无缝生成 + 球体预览。
 *
 *  用户 2026-10-16：「我们的算法不是能放在真实球体上的地图」→ ask_user_question 选定
 *  「A 灵框自己出星球图：球面无缝生成 + 球体预览」+「与现内核（mapgen4 局部地形）并存」。
 *
 *  这套件钉的是**"能贴到球上"这件事本身**，不靠肉眼看图：
 *    ① 形态两档齐全（地图栏 `#map-form` + 工作室 `#ms-form`），采用后随地图落盘；
 *    ② ⭐ **经度无缝**：等距圆柱图**首列与末列**在球上真挨着 ⇒ 逐像素差必须远小于"隔半个地球"的两列；
 *    ③ ⭐ **极点收敛**：最上一行是纬度 ±89.8° 那一圈，球上收到一点 ⇒ 整行几乎同色
 *       （横向起伏远小于赤道行）。**平面采样的实现过不了这一条** —— 这正是"真的在球面采样"的判据；
 *    ④ ⭐ 球体视图真出像素、拖动之后画面真的变了（`#map-globe`）；
 *    ⑤ 形态并存：切回「局部」地形参数一个字没变、画布回到局部那套；
 *    ⑥ 只存参数（磁盘上 terrain 里没有像素/base64），刷新后形态还在；
 *    ⑦ 助手 `generate_map` 靠**描述**（「一整颗星球」）也能切到星球形态。
 *
 *  用法：LINGKUANG_TEST_* 指到临时目录起一个隔离实例（先跑 reset-entity-vault.cjs + seed-node.cjs），
 *        LK_CDP_PORT=9500 node tools/e2e/map-planet.cjs */
const fs = require('fs');
const DATA = process.env.LINGKUANG_TEST_DATA;
const PORT = process.env.LK_CDP_PORT || '9500';
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
function diskSize() {
  try { return fs.statSync(DATA).size; } catch { return 0; }
}

/* ⭐ 像素证据：直接读地图栏那块 2D 画布（星球图是 2D 画的 ⇒ getImageData 可读）。
   两列差 / 一行起伏 —— 经度无缝与极点收敛都靠这两个量。 */
const PIX = `(function () {
  const c = document.querySelector('#map-terrain-canvas');
  if (!c || !c.getContext) return { ok: false };
  const g = c.getContext('2d');
  if (!g || !c.width || !c.height) return { ok: false };
  const W = c.width, H = c.height;
  let d;
  try { d = g.getImageData(0, 0, W, H).data; } catch (e) { return { ok: false, err: String(e && e.message) }; }
  const px = (x, y, k) => d[((y * W + x) * 4) + k];
  const colDiff = (a, b) => {
    let s = 0, n = 0;
    for (let y = 0; y < H; y += 2) for (let k = 0; k < 3; k++) { s += Math.abs(px(a, y, k) - px(b, y, k)); n++; }
    return s / n;
  };
  const rowVar = (y) => {
    let s = 0;
    for (let x = 0; x < W; x++) for (let k = 0; k < 3; k++) s += Math.abs(px(x, y, k) - px((x + 1) % W, y, k));
    return s / (W * 3);
  };
  /* 一行里有多少种颜色（**稳的判据**）：极地在球上是"一个点附近那一圈"，整行几乎同色；
     而平面采样时极地那一行会跟中纬度一样花。
     ⚠️ 别用"逐列色差的均值"（第一版就是这么写的，假红）：极地行常有河/海岸线穿过，
     几个尖刺像素就能把均值抬到跟赤道一个量级 —— 而**地形数据本身是平的**
     （离线量过：整行海拔只差 0.07 km，中纬度同一行差 2.9 km）。 */
  const rowColors = (y) => {
    const set = new Set();
    for (let x = 0; x < W; x++) set.add((px(x, y, 0) << 16) | (px(x, y, 1) << 8) | px(x, y, 2));
    return set.size;
  };
  return { ok: true, w: W, h: H,
    seam: +colDiff(0, W - 1).toFixed(2), far: +colDiff(0, (W / 2) | 0).toFixed(2),
    pole: +rowVar(0).toFixed(2), pole2: +rowVar(H - 1).toFixed(2), equator: +rowVar((H / 2) | 0).toFixed(2),
    poleColors: rowColors(0), poleSColors: rowColors(H - 1), midColors: rowColors((H / 4) | 0) };
})()`;

/* 拖动球体（合成 PointerEvent；globe.ts 里对 setPointerCapture 有兜底）*/
const DRAG = `(function () {
  const c = document.querySelector('#map-terrain-canvas');
  if (!c) return false;
  const r = c.getBoundingClientRect();
  const opt = (x, y) => ({ clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 });
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  c.dispatchEvent(new PointerEvent('pointerdown', opt(cx, cy)));
  for (let i = 1; i <= 6; i++) c.dispatchEvent(new PointerEvent('pointermove', opt(cx + i * 14, cy)));
  c.dispatchEvent(new PointerEvent('pointerup', opt(cx + 84, cy)));
  return true;
})()`;

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
  const ev = async (expr, ms = 30000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
      sleep(ms).then(() => ({ timedOut: true })),
    ]);
    if (r.timedOut) throw new Error('eval 超时 ' + ms + 'ms');
    if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  const evSoft = async (expr, tries = 20) => {
    for (let i = 0; i < tries; i++) {
      try { const v = await ev(expr, 4000); if (v !== undefined && v !== null) return v; } catch { /* 上下文还没就绪 */ }
      await sleep(400);
    }
    throw new Error('evSoft 一直取不到值: ' + expr.slice(0, 60));
  };
  const ready = () => ev(`!!document.getElementById('map-gen') && !!document.getElementById('map-form') && !!document.getElementById('map-globe')`);
  const click = (sel) => ev(`(function () { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`);
  const setSel = (sel, v) => ev(`(function () {
    const s = document.querySelector(${JSON.stringify(sel)});
    if (!s) return null;
    s.value = ${JSON.stringify(v)};
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return s.value;
  })()`);
  const box = (sel) => ev(`(function () {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
  })()`);
  const shotSum = async (sel) => {
    const rect = await box(sel);
    if (!rect || rect.width < 20) return 0;
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } });
    const data = r.result?.data || '';
    let x = 0;
    for (let i = 0; i < data.length; i += 97) x = (x * 31 + data.charCodeAt(i)) >>> 0;
    return x;
  };
  const opts = (sel) => ev(`(function () {
    const s = document.querySelector(${JSON.stringify(sel)});
    return s ? { n: s.options.length, ids: [...s.options].map((o) => o.value), value: s.value,
                 labels: [...s.options].map((o) => o.textContent) } : null;
  })()`);
  const pane = () => ev(`(function () {
    const c = document.querySelector('#map-terrain-canvas');
    const f = document.getElementById('map-form');
    const g = document.getElementById('map-globe');
    return { canvas: !!c, form: f ? f.value : null, formDisabled: f ? f.disabled : null,
             globeShown: g ? g.style.display !== 'none' : false,
             planetKind: c ? c.getAttribute('data-planet') : null,
             w: c ? c.width : 0, h: c ? c.height : 0,
             note: (document.getElementById('map-gen-note') || {}).textContent || '' };
  })()`);
  const previewSum = () => ev(`(function () {
    const img = document.getElementById('ms-img');
    if (!img || !img.naturalWidth) return 0;
    const s = img.src || '';
    let x = 0; for (let i = 0; i < s.length; i += 97) x = (x * 31 + s.charCodeAt(i)) >>> 0;
    return x;
  })()`);

  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await send('Page.enable');

  /* ★0 前置（第一百零九轮改口径）：地图栏在、**形态控件已退场**（底图 = 星球总图）、
     等高线方式四档 / 手绘海陆入口在、区域精细化**已删除**、球体按钮藏着、工作室没开、磁盘没地形。 */
  const contour0 = await opts('#map-contour');
  const p0 = await pane();
  const hasTerrain0 = !!diskMap()?.terrain;
  const pre0 = {
    genBtn: (await ev(`!!document.getElementById('map-gen')`)) === true,
    globeBtn: (await ev(`!!document.getElementById('map-globe')`)) === true,
    noFormSel: (await ev(`!document.getElementById('map-form')`)) === true,
    noStudioFormSel: (await ev(`!document.getElementById('ms-form')`)) === true,
    contour4: !!contour0 && contour0.ids.join(',') === 'auto,all,half,fifth',
    editorBtn: (await ev(`!!document.getElementById('map-editor')`)) === true,
    noRefineMode: (await ev(`!document.querySelector('[data-mode="refine"]')`)) === true,
    /* 球体按钮的显隐跟着「有没有星球地形」走（守卫可能跑在已有地图的世界里） */
    globeFollowsData: p0.globeShown === hasTerrain0,
    studioClosed: (await ev(`!!document.getElementById('lk-map-studio')`)) === false,
  };
  check('★0 前置：形态控件已退场、等高线四档、手绘入口在、区域精细化已删、球体按钮不显示、面板没开',
    Object.values(pre0).every(Boolean),
    { ...pre0, contour: contour0 && contour0.ids });

  /* ★1 工作室：等高线四档 + 说明在；形态控件已退场 */
  await click('#map-gen');
  await sleep(2500);
  const c1 = await opts('#ms-contour');
  const hint1 = await ev(`(document.getElementById('ms-contour-hint') || {}).textContent || ''`);
  check('★1 工作室也有「等高线」四档、说明在、形态控件已退场',
    !!c1 && c1.n === 4 && c1.ids.join(',') === 'auto,all,half,fifth' && /跳线|只换画法/.test(hint1)
    && (await ev(`!document.getElementById('ms-form')`)) === true,
    { ids: c1 && c1.ids, hint: hint1.slice(0, 24) });

  /* ★2 工作室「采用到地图」⇒ 落盘 form=planet、画布 2:1、状态行写「星球」、球体按钮出现 */
  const prev2 = await previewSum();
  await click('#ms-apply');
  await sleep(3400);
  const p2 = await pane();
  const t2 = diskMap()?.terrain ?? {};
  check('★2 采用到地图 ⇒ 落盘 form=planet、画布 2:1、状态行写「星球」、球体按钮出现',
    prev2 !== 0 && t2.form === 'planet' && p2.planetKind === 'equirect'
    && p2.w === 2 * p2.h && p2.w > 0 && /星球/.test(p2.note) && p2.globeShown === true,
    { form: t2.form, w: p2.w, h: p2.h, kind: p2.planetKind, note: p2.note.slice(0, 40) });

  /* ★3 等高线方式：切到「每五条」⇒ 落盘 contour='fifth'、画布真的重画了一张 */
  await click('#ms-close');
  await sleep(800);
  /* 先把「看的方式」切到地形图（只有带等高线的档位才看得出抽稀的效果），
     再切「全部」→「每五条」：守卫可能跑在已经设过第五档的数据上，
     同值 change 不会触发重画（否则 ★3 假红）。 */
  await setSel('#map-view', 'topo');
  await sleep(3000);
  await setSel('#map-contour', 'all');
  await sleep(2400);
  const shot3a = await shotSum('#map-terrain');
  await setSel('#map-contour', 'fifth');
  await sleep(2800);
  const t3 = diskMap()?.terrain ?? {};
  const shot3b = await shotSum('#map-terrain');
  check('★3 等高线方式切换 ⇒ 落盘 contour=fifth、画布重画（截图哈希变了）',
    t3.contour === 'fifth' && shot3a !== 0 && shot3b !== 0 && shot3a !== shot3b,
    { contour: t3.contour, before: shot3a, after: shot3b });

  /* ★4 大图走高清（第一百零八轮）：点地图空白处 ⇒ 全窗口查看器，星球图 2304×1152 */
  await click('[data-mode="move"]');
  await sleep(500);
  const svg4 = await box('#map-svg');
  if (svg4) {
    const cx = svg4.x + Math.round(svg4.width * 0.5);
    const cy = svg4.y + Math.round(svg4.height * 0.5);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(80);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1 });
  }
  let hd = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    hd = await ev(`(function () { const i = document.querySelector('.lk-lb__img'); return i ? { w: i.naturalWidth, h: i.naturalHeight } : null; })()`);
    if (hd) break;
  }
  check('★4 点地图 ⇒ 全窗口高清图（星球 2304×1152）',
    !!hd && hd.w === 2304 && hd.h === 1152, hd);
  await ev(`document.querySelector('.lk-lb') && document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
  await sleep(600);

  /* ★5 ⭐经度无缝：首尾列差 ≪ 隔半个地球的两列差。
     ⚠️ 先切回「自然」再量：★3 已经切到「地形图 + 每五条」，那画法上有 1px 宽的等高线，
     相邻两列的均值差本来就有 ~10（一个像素的横向错位就够）⇒ 会误判成"没有接缝"。
     接缝是数据属性，与画法无关。 */
  await setSel('#map-view', 'natural');
  await sleep(2200);
  const px5 = await ev(PIX);
  check('★5 ⭐经度无缝：首尾列（球上相邻）的像素差远小于对面列',
    px5?.ok === true && px5.seam < px5.far * 0.5,
    px5);

  /* ★6 ⭐极点收敛：极地整行几乎是同一个颜色，中纬度那一行则五颜六色。 */
  check('★6 ⭐极点收敛：极地行几乎同色、中纬度行五颜六色',
    px5?.ok === true && px5.midColors >= px5.poleColors * 2 + 8 && px5.midColors >= px5.poleSColors * 2 + 8,
    { poleColors: px5?.poleColors, poleSColors: px5?.poleSColors, midColors: px5?.midColors, poleVar: px5?.pole, equatorVar: px5?.equator });

  /* ★7 ⭐球体视图：真出像素，拖动之后画面真的变了 */
  const shotFlat = await shotSum('#map-terrain');
  await click('#map-globe');
  await sleep(1600);
  const gKind = await ev(`(function () { const c = document.querySelector('#map-terrain-canvas'); return c ? c.getAttribute('data-planet') : null; })()`);
  const shotGlobe = await shotSum('#map-terrain');
  await ev(DRAG);
  await sleep(900);
  const shotDragged = await shotSum('#map-terrain');
  check('★7 ⭐球体看：贴到真球上出画面、拖动后画面变了',
    gKind === 'globe' && shotGlobe !== 0 && shotGlobe !== shotFlat && shotDragged !== 0 && shotDragged !== shotGlobe,
    { kind: gKind, flat: shotFlat, globe: shotGlobe, dragged: shotDragged });
  await click('#map-globe');
  await sleep(1200);

  /* ★8 只存参数：terrain 里没有任何 data:（图不落盘），且等高线/形态都在 */
  const t8 = diskMap()?.terrain ?? {};
  const blob = JSON.stringify(t8);
  check('★8 只存参数（terrain 里没有 base64 图）、形态与等高线都在',
    !blob.includes('data:') && t8.form === 'planet' && t8.contour === 'fifth' && diskSize() < 400000,
    { keys: Object.keys(t8).sort(), size: diskSize() });

  /* ★9 ⭐助手不写 form，只在描述里说「一整颗星球」⇒ 也切到星球形态 */
  await ev(`window.__lkSeen = []; window.__lkAgentMock = (m) => { window.__lkSeen.push(m); return '{"tool":"generate_map","args":{"description":"一整颗星球，一片群岛"}}'; }; true`);
  await ev(`document.querySelector('#lk-toolbar [data-tool="codex"]').click(); true`);
  await sleep(500);
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true })); true`);
  await sleep(900);
  await ev(`(function () {
    const s = document.getElementById('lk-agent-scope');
    const a = document.getElementById('lk-agent-ask');
    if (s) { s.value = 'workspace'; s.dispatchEvent(new Event('change', { bubbles: true })); }
    if (a) { a.value = 'always'; a.dispatchEvent(new Event('change', { bubbles: true })); }
    return true;
  })()`);
  await sleep(300);
  await ev(`(function () { const t = document.getElementById('lk-agent-input'); t.value = '给我一整颗星球'; document.getElementById('lk-agent-send').click(); return true; })()`);
  await sleep(3000);
  await ev(`(function () { const b = document.querySelector('#lk-agent-msgs [data-prop-ok]'); if (b) b.click(); return true; })()`);
  await sleep(3200);
  const t9 = diskMap()?.terrain ?? {};
  check('★9 助手只说「一整颗星球」（不带 form 参数）也能切到星球形态',
    t9.form === 'planet',
    { form: t9.form, seed: t9.seed });

  /* ★10 刷新后形态 / 等高线方式都还在（存的是数据，不是内存里的临时状态） */
  await ev(`window.location.reload(); true`);
  await sleep(2800);
  await evSoft(`!!document.getElementById('map-contour')`);
  const t10 = diskMap()?.terrain ?? {};
  const p10 = await pane();
  check('★10 刷新后仍是「星球」形态 + 等高线「每五条」、球体按钮还在',
    t10.form === 'planet' && t10.contour === 'fifth' && p10.globeShown === true,
    { form: t10.form, contour: t10.contour, globe: p10.globeShown });

  /* ★12 无未捕获异常 */
  const errs = await ev(`(window.__errs || []).slice(0, 8)`);
  check('★12 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} PASS`);
  w.close();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.message)); process.exit(2); });
