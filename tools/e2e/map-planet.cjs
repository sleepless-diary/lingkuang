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

  /* ★0 前置：地图栏在、形态控件在（没地形时置灰）、球体按钮藏着、工作室没开、磁盘没地形 */
  const o0 = await opts('#map-form');
  const p0 = await pane();
  check('★0 前置：地图栏形态控件在、没地形时置灰、球体按钮不显示、面板没开',
    (await ready()) === true && !!o0 && o0.n === 2 && p0.formDisabled === true && p0.globeShown === false
    && (await ev(`!!document.getElementById('lk-map-studio')`)) === false && !(diskMap()?.terrain),
    { opts: o0 && o0.ids, disabled: p0.formDisabled, globe: p0.globeShown });

  /* ★1 形态两档 = 局部 / 星球 */
  check('★1 形态两档 = 局部 / 星球',
    !!o0 && o0.ids.join(',') === 'local,planet' && o0.labels.join(',') === '局部,星球',
    { ids: o0 && o0.ids, labels: o0 && o0.labels });

  /* ★2 工作室「自己调」页也有形态控件，说明随档位换 */
  await click('#map-gen');
  await sleep(2500);
  const o1 = await opts('#ms-form');
  const h0 = await ev(`(document.getElementById('ms-form-hint') || {}).textContent || ''`);
  await setSel('#ms-form', 'planet');
  await sleep(600);
  const h1 = await ev(`(document.getElementById('ms-form-hint') || {}).textContent || ''`);
  check('★2 工作室也有形态控件、说明随档换',
    !!o1 && o1.n === 2 && o1.ids.join(',') === 'local,planet' && o1.value === 'local'
    && /高一点|一片地区|方图/.test(h0) && /星球|经度/.test(h1) && h0 !== h1,
    { ids: o1 && o1.ids, h0: h0.slice(0, 20), h1: h1.slice(0, 20) });

  /* ★3 切到星球 ⇒ 预览真的换了一张（与局部那张不同），统计行仍有数字 */
  await sleep(2600);
  const prevPlanet = await previewSum();
  const notePlanet = await ev(`(document.getElementById('ms-note') || {}).textContent || ''`);
  await setSel('#ms-form', 'local');
  await sleep(2600);
  const prevLocal = await previewSum();
  check('★3 换形态 = 换一张预览（局部 ⇄ 星球两张不同）',
    prevPlanet !== 0 && prevLocal !== 0 && prevPlanet !== prevLocal && /块陆地/.test(notePlanet),
    { planet: prevPlanet, local: prevLocal, note: notePlanet.slice(0, 40) });

  /* ★4 星球形态「采用到地图」⇒ 落盘 form=planet、画布是 2:1、状态行写「星球」 */
  await setSel('#ms-form', 'planet');
  await sleep(1400);
  await click('#ms-apply');
  await sleep(3200);
  const p4 = await pane();
  const t4 = diskMap()?.terrain ?? {};
  check('★4 采用后落盘 form=planet、画布 2:1、状态行写「星球」',
    t4.form === 'planet' && p4.planetKind === 'equirect' && p4.w === 2 * p4.h && p4.w > 0 && /星球/.test(p4.note) && p4.globeShown === true,
    { form: t4.form, w: p4.w, h: p4.h, kind: p4.planetKind, note: p4.note.slice(0, 40) });

  /* ★5 ⭐经度无缝：首尾列差 ≪ 隔半个地球的两列差 */
  const px5 = await ev(PIX);
  check('★5 ⭐经度无缝：首尾列（球上相邻）的像素差远小于对面列',
    px5?.ok === true && px5.seam < px5.far * 0.5,
    px5);

  /* ★6 ⭐极点收敛：极地整行几乎是同一个颜色，中纬度那一行则五颜六色。
     实测（5 个种子，h=256）：极地行 1~22 种色、45° 行 26~64 种色；地形数据上极地整行的
     海拔只差 0.07 km（中纬度 2.9 km）⇒ 球面采样在极点天然"塌成一点"。
     平面采样的实现过不了这一条（每一行的花色都差不多）。 */
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

  /* ★8 形态并存：切回「局部」⇒ 画布回到局部那套、地形参数一个字没变 */
  const before8 = JSON.stringify({ seed: t4.seed, style: t4.style, spec: t4.spec ?? {} });
  await setSel('#map-form', 'local');
  await sleep(2600);
  const p8 = await pane();
  const t8 = diskMap()?.terrain ?? {};
  check('★8 切回「局部」：画布回到局部那套、种子/档位/数量一个字没变',
    p8.form === 'local' && p8.planetKind === null && p8.w !== 2 * p8.h && p8.globeShown === false
    && JSON.stringify({ seed: t8.seed, style: t8.style, spec: t8.spec ?? {} }) === before8 && t8.form === 'local',
    { form: t8.form, w: p8.w, h: p8.h, kind: p8.planetKind, globe: p8.globeShown });

  /* ★9 只存参数：terrain 的键就是那五个，数据文件没被图撑大 */
  const keys = Object.keys(t8).sort();
  check('★9 只存参数（terrain 里没有像素/base64）',
    JSON.stringify(keys) === JSON.stringify(['form', 'seed', 'spec', 'style', 'view']) && diskSize() < 400000,
    { keys, size: diskSize() });

  /* ★10 ⭐助手不写 form，只在描述里说「一整颗星球」⇒ 也切到星球形态 */
  await ev(`window.__lkSeen = []; window.__lkAgentMock = (m) => { window.__lkSeen.push(m); return '{"tool":"generate_map","args":{"description":"一整颗星球，一片群岛"}}'; }; true`);
  await ev(`document.querySelector('#lk-toolbar [data-tool="codex"]').click(); true`);
  await sleep(500);
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
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
  const t10 = diskMap()?.terrain ?? {};
  check('★10 助手只说「一整颗星球」（不带 form 参数）也能切到星球形态',
    t10.form === 'planet',
    { form: t10.form, seed: t10.seed });

  /* ★11 刷新后形态还在（存的是数据，不是内存里的临时状态）+ 球体按钮还在 */
  await ev(`window.location.reload(); true`);
  await sleep(2600);
  await evSoft(`!!document.getElementById('map-form')`);
  const p11 = await pane();
  check('★11 刷新后仍是「星球」形态、球体按钮还在',
    p11.form === 'planet' && p11.globeShown === true && diskMap()?.terrain?.form === 'planet',
    { form: p11.form, globe: p11.globeShown });

  /* ★12 无未捕获异常 */
  const errs = await ev(`(window.__errs || []).slice(0, 8)`);
  check('★12 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} PASS`);
  w.close();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.message)); process.exit(2); });
