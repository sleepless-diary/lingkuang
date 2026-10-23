/* 地图「区域精细化 + 手绘海陆 + 等高线方式 + 高清大图」（第一百零八轮）。
 *
 *  用户原话：「有些地方因为地形陡峭导致等高线有点密集，能不能加一个等高线绘制方式，是全部显示
 *  还是省略部分，你再做一个简易的编辑器，能让用户自行绘制大陆和地形，并在此之上生成对应地形，
 *  以及能不能加一个精细化生成的功能，把局部类型删了，改成能在地图上选一个区域进行精细化生成
 *  （也能重复生成和抽卡），生成结果留档，作为该地区的样本，以及进入全窗口预览时能不能渲染一下
 *  更高的分辨率」。
 *
 *  这套件钉四件事：
 *    ① 等高线方式（auto / all / half / fifth）在地图栏与工作室都有，切了会落盘、会重画；
 *    ② 区域精细化：拖框 → 抽 6 张 → 采用 → 地图上叠样本图 → 刷新后还在（样本 = 参数 + 小图）；
 *    ③ 手绘海陆：全屏画板能开、能画、按剪影生成 ⇒ terrain.mask 落盘且陆地占比跟着剪影走；
 *    ④ 全窗口大图是**高清**的（局部 3072² / 星球 2304×1152）。
 *
 *  用法：干净临时目录起隔离实例（不给现成 worldbuilding.json，地图栏会自建默认地图），
 *        LK_CDP_PORT=9501 node tools/e2e/map-refine.cjs */
const fs = require('fs');
const DATA = process.env.LINGKUANG_TEST_DATA;
const PORT = process.env.LK_CDP_PORT || '9501';
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
function diskSize() { try { return fs.statSync(DATA).size; } catch { return 0; } }

const LAND_PIX = `(function () {
  const c = document.querySelector('#map-terrain-canvas');
  if (!c || !c.getContext) return { ok: false };
  const g = c.getContext('2d');
  if (!g || !c.width || !c.height) return { ok: false };
  const W = c.width, H = c.height;
  let d;
  try { d = g.getImageData(0, 0, W, H).data; } catch (e) { return { ok: false, err: String(e && e.message) }; }
  /* 星球图的陆地是绿/黄褐（r≥g>b 或 g 明显压过 b），海是蓝（b>g）。按这个粗判读陆地占比。 */
  let land = 0, n = 0;
  for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) {
    const i = (y * W + x) * 4, r = d[i], gg = d[i + 1], bb = d[i + 2];
    n++;
    if (gg > bb + 12 && r > bb) land++;
  }
  return { ok: true, ratio: +(land / n).toFixed(3) };
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
    const r = await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }), sleep(ms).then(() => ({ timedOut: true }))]);
    if (r.timedOut) throw new Error('eval 超时 ' + ms + 'ms');
    if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  const evSoft = async (expr, tries = 25) => {
    for (let i = 0; i < tries; i++) {
      try { const v = await ev(expr, 4000); if (v !== undefined && v !== null) return v; } catch { /* 上下文还没就绪 */ }
      await sleep(400);
    }
    throw new Error('evSoft 取不到: ' + expr.slice(0, 60));
  };
  const click = (sel) => ev(`(function () { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`);
  const setSel = (sel, v) => ev(`(function () {
    const s = document.querySelector(${JSON.stringify(sel)});
    if (!s) return null;
    s.value = ${JSON.stringify(v)};
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return s.value;
  })()`);
  const opts = (sel) => ev(`(function () {
    const s = document.querySelector(${JSON.stringify(sel)});
    return s ? { n: s.options.length, ids: [...s.options].map((o) => o.value) } : null;
  })()`);
  const box = (sel) => ev(`(function () {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
  })()`);
  const mouse = (type, x, y, extra) => send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', buttons: 1, clickCount: 1 }, extra || {}));
  const drag = async (x0, y0, x1, y1, steps = 8) => {
    await mouse('mousePressed', x0, y0);
    for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps); await sleep(24); }
    await mouse('mouseReleased', x1, y1, { buttons: 0 });
  };

  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await send('Page.enable');

  /* ★0 前置：进沙盘 → 地图栏；三个新入口在，形态控件已退场；磁盘上还没有地形 */
  await evSoft(`!!document.querySelector('#lk-toolbar')`);
  await click('[data-tool="sandbox"]');
  await sleep(2200);
  const c0 = await opts('#map-contour');
  check('★0 前置：等高线四档 / 手绘海陆 / 细化区域 三个入口在，形态控件已退场',
    !!c0 && c0.ids.join(',') === 'auto,all,half,fifth'
    && (await ev(`!!document.getElementById('map-editor')`)) === true
    && (await ev(`!!document.querySelector('[data-mode="refine"]')`)) === true
    && (await ev(`!document.getElementById('map-form')`)) === true
    && !(diskMap()?.terrain),
    { contour: c0 && c0.ids });

  /* ★1 先用工作室「采用到地图」出一张星球底图（后面区域样本才有地方挂） */
  await click('#map-gen');
  await sleep(2600);
  await click('#ms-apply');
  await sleep(3600);
  await click('#ms-close');
  await sleep(800);
  const t1 = diskMap()?.terrain ?? {};
  check('★1 采用到地图 ⇒ 底图是星球（form=planet、画布 2:1）',
    t1.form === 'planet' && (await ev(`(function () { const c = document.querySelector('#map-terrain-canvas'); return !!c && c.width === 2 * c.height; })()`)) === true,
    { form: t1.form });

  /* ★2 等高线方式：切「每五条」⇒ 落盘 */
  const c2 = await setSel('#map-contour', 'fifth');
  await sleep(2600);
  check('★2 等高线方式切到「每五条」⇒ 落盘 terrain.contour=fifth',
    c2 === 'fifth' && (diskMap()?.terrain?.contour === 'fifth'), { contour: diskMap()?.terrain?.contour });

  /* ★3 细化区域：切模式 → 拖框 ⇒ 落盘一块区域、面板打开 */
  await click('[data-mode="refine"]');
  await sleep(400);
  const b3 = await box('#map-svg');
  await drag(b3.x + b3.width * 0.26, b3.y + b3.height * 0.30, b3.x + b3.width * 0.60, b3.y + b3.height * 0.68);
  await sleep(1400);
  const r3 = (diskMap()?.refined || [])[0];
  check('★3 拖框 ⇒ 建出一块区域（rect 有值）、面板打开',
    !!r3 && r3.rect.w >= 24 && r3.rect.h >= 16 && (await ev(`!!document.getElementById('lk-map-refine')`)) === true,
    { rect: r3 && r3.rect, samples: r3 && r3.samples.length });

  /* ★4 抽 6 张：样本数 6、每张都有 JPEG 缩略图、单张 < 60KB（不写真图，只存小图）*/
  await click('#rf-roll');
  for (let i = 0; i < 50; i++) { await sleep(500); if ((diskMap()?.refined?.[0]?.samples || []).length >= 6) break; }
  const s4 = diskMap()?.refined?.[0]?.samples || [];
  const thumbLens = s4.map((s) => (s.thumb || '').length);
  check('★4 抽 6 张 ⇒ 6 个样本、每张带 JPEG 小图、单张 < 60KB',
    s4.length === 6 && s4.every((s) => String(s.thumb || '').startsWith('data:image/jpeg'))
    && thumbLens.every((n) => n > 1000 && n < 60 * 1024),
    { n: s4.length, kb: thumbLens.map((n) => Math.round(n / 1024)) });

  /* ★5 采用第一张 ⇒ active 落盘、地图上叠出那张图、SVG 有虚线框 */
  await click('#lk-map-refine [data-use]');
  await sleep(1200);
  const r5 = diskMap()?.refined?.[0] ?? {};
  const dom5 = await ev(`({ overlay: document.querySelectorAll('#map-refined img').length, rects: document.querySelectorAll('#map-svg [data-refined]').length })`);
  check('★5 采用某一版 ⇒ active 落盘、地图上叠图、框在',
    !!r5.active && r5.samples.some((s) => s.id === r5.active) && dom5.overlay === 1 && dom5.rects === 1,
    { active: !!r5.active, ...dom5 });

  /* ★6 全窗口看高清：区域样本是 3072² 的地形图 */
  await click('#rf-hd');
  let hd6 = null;
  for (let i = 0; i < 70; i++) {
    await sleep(500);
    hd6 = await ev(`(function () { const i = document.querySelector('.lk-lb__img'); return i ? { w: i.naturalWidth, h: i.naturalHeight } : null; })()`);
    if (hd6) break;
  }
  check('★6 全窗口看高清 ⇒ 局部地形 3072×3072', !!hd6 && hd6.w === 3072 && hd6.h === 3072, hd6);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
  await sleep(600);
  await click('#lk-map-refine #rf-close');
  await sleep(600);

  /* ★7 刷新之后区域 / 样本 / 采用都还在（落盘，不是内存态）*/
  await ev(`window.location.reload(); true`);
  await sleep(3000);
  await evSoft(`!!document.querySelector('#lk-toolbar')`);
  await click('[data-tool="sandbox"]');
  await sleep(2000);
  const r7 = diskMap()?.refined?.[0] ?? {};
  const dom7 = await ev(`({ overlay: document.querySelectorAll('#map-refined img').length, rects: document.querySelectorAll('#map-svg [data-refined]').length })`);
  check('★7 刷新后区域与「当前采用」都还在、地图上仍叠着',
    !!r7.id && r7.samples.length === 6 && !!r7.active && dom7.overlay === 1 && dom7.rects === 1,
    { samples: r7.samples && r7.samples.length, ...dom7 });

  /* ★8 手绘海陆：画板能开、画一笔、按剪影生成 ⇒ mask 落盘、陆地占比跟着剪影走 */
  const landBefore = await ev(LAND_PIX);
  await click('#map-editor');
  await sleep(1000);
  const ed8 = await box('#ed-canvas');
  const opened = await ev(`!!document.querySelector('.lk-ed')`);
  /* 只在左上角画一小块陆地（其余留白 = 海洋，默认勾上）*/
  await drag(ed8.x + ed8.width * 0.16, ed8.y + ed8.height * 0.38, ed8.x + ed8.width * 0.32, ed8.y + ed8.height * 0.38, 10);
  await sleep(300);
  const stat8 = await ev(`(document.querySelector('#ed-stat') || {}).textContent || ''`);
  await click('#ed-go');
  for (let i = 0; i < 60; i++) { await sleep(600); if ((await ev(`!document.querySelector('.lk-ed')`)) === true) break; }
  await sleep(3200);
  const t8 = diskMap()?.terrain ?? {};
  const landAfter = await ev(LAND_PIX);
  check('★8 手绘海陆 ⇒ 画板能开、按剪影生成、mask 落盘、陆地占比大幅变小',
    opened === true && /陆地/.test(stat8) && !!t8.mask && t8.mask.w === 160 && t8.mask.h === 80
    && typeof t8.mask.bits === 'string' && t8.mask.bits.length > 1000
    && landAfter.ok === true && landAfter.ratio < 0.25 && landBefore.ok === true,
    { stat: stat8, before: landBefore.ratio, after: landAfter && landAfter.ratio, maskLen: t8.mask && t8.mask.bits.length });

  /* ★9 mask 是 2bit/base64 文本（不是图），文件也没被撑大 */
  check('★9 mask 只有 base64 文本（4~6KB）、数据文件 < 500KB',
    t8.mask.bits.startsWith('data:') === false && t8.mask.bits.length < 8000 && diskSize() < 500000,
    { maskLen: t8.mask.bits.length, size: diskSize() });

  /* ★10 无未捕获异常 */
  const errs = await ev(`(window.__errs || []).slice(0, 8)`);
  check('★10 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} PASS`);
  w.close();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
