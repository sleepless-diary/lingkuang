/* 地形「风格」开关（第九十七轮）：立体 / 等高线 / 平面。
 *
 *  用户 2026-10-14：「这个山怎么是立体的，不应该是等高线那一种的吗」→ 选了「做成开关，三档都留着」。
 *  这套件钉三件事：
 *    ① 两个入口都有这个控件（地图栏 `#map-view` + 工作室「自己调」`#ms-view`），三档齐全；
 *    ② **换风格只换画法**：地形统计逐字不变、不重新生成地形（同一片地，三张不同的图）；
 *    ③ 这条偏好**随地图落盘**（`MapData.terrain.view`），刷新后还在；助手换地形时**不会被重置**。
 *
 *  ⭐ 像素证据：把预览图画进 2D 画布读像素，量「亮度均值 / 局部对比 sd」——
 *     「平面」档 sd 必须明显小于「立体」档（阴影真关掉了），而不是只看按钮文字变了没有。
 *
 *  用法：LINGKUANG_TEST_* 指到临时目录起一个隔离实例（先跑 reset-entity-vault.cjs + seed-node.cjs），
 *        LK_CDP_PORT=9500 node tools/e2e/map-style.cjs */
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

/* 预览的量化指纹：dataURL 长度 + 稀疏校验和 + 亮度均值/跨度/局部对比 sd */
const PREVIEW = `(function () {
  const hs = (s) => { let x = 0; for (let i = 0; i < s.length; i += 97) x = (x * 31 + s.charCodeAt(i)) >>> 0; return x; };
  const img = document.getElementById('ms-img');
  if (!img || !img.naturalWidth) return { ok: false, len: 0, sum: 0, mean: 0, span: 0, sd: 0, note: '' };
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let sum = 0, mn = 255, mx = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114;
    sum += l; if (l < mn) mn = l; if (l > mx) mx = l; n++;
  }
  const mean = sum / n;
  let sq = 0, k = 0;
  for (let i = 0; i < d.length; i += 4 * 37) {
    const l = d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114;
    sq += (l - mean) * (l - mean); k++;
  }
  return { ok: true, len: (img.src || '').length, sum: hs(img.src || ''), mean: +mean.toFixed(1),
           span: +(mx - mn).toFixed(0), sd: +Math.sqrt(sq / k).toFixed(1),
           note: (document.getElementById('ms-note') || {}).textContent || '' };
})()`;
const EMPTY_PREVIEW = { ok: false, len: 0, sum: 0, mean: 0, span: 0, sd: 0, note: '' };

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
  const ev = async (expr, ms = 20000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
      sleep(ms).then(() => ({ timedOut: true })),
    ]);
    if (r.timedOut) throw new Error('eval 超时 ' + ms + 'ms');
    if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  /* 重载页面会换掉执行上下文 ⇒ 之后的 eval 要能重试（照 session-restore.cjs） */
  const evSoft = async (expr, tries = 20) => {
    for (let i = 0; i < tries; i++) {
      try { const v = await ev(expr, 4000); if (v !== undefined && v !== null) return v; } catch { /* 上下文还没就绪 */ }
      await sleep(400);
    }
    throw new Error('evSoft 一直取不到值: ' + expr.slice(0, 60));
  };
  const ready = () => ev(`!!document.getElementById('map-gen') && !!document.getElementById('map-view')`);
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
  const preview = async () => (await ev(PREVIEW)) ?? EMPTY_PREVIEW;
  const views = (sel) => ev(`(function () {
    const s = document.querySelector(${JSON.stringify(sel)});
    return s ? { n: s.options.length, ids: [...s.options].map((o) => o.value), value: s.value,
                 labels: [...s.options].map((o) => o.textContent) } : null;
  })()`);

  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await send('Page.enable');

  /* ★0 前置：地图栏在、风格控件在、此刻没地形（置灰）、工作室没开、磁盘也没有地形 */
  const v0 = await views('#map-view');
  const v0disabled = await ev(`(function () { const s = document.getElementById('map-view'); return s ? s.disabled : null; })()`);
  check('★0 前置：地图栏风格控件在、没地形时置灰、面板没开',
    (await ready()) === true && !!v0 && v0disabled === true
    && (await ev(`!!document.getElementById('lk-map-studio')`)) === false
    && !(diskMap()?.terrain),
    { views: v0 && v0.ids, disabled: v0disabled, terrain: diskMap()?.terrain ?? null });
  /* ★1 三档齐全（两个入口同一套 id / 文案）*/
  check('★1 风格三档 = 立体 / 等高线 / 平面（地图栏）',
    !!v0 && v0.n === 3 && v0.ids.join(',') === 'relief,contour,flat'
    && v0.labels.join(',') === '立体,等高线,平面',
    { ids: v0 && v0.ids, labels: v0 && v0.labels });

  /* ★2 工作室「自己调」页也有这个控件 + 悬停说明跟着换 */
  await click('#map-gen');
  await sleep(3000);
  const v1 = await views('#ms-view');
  const hint0 = await ev(`(document.getElementById('ms-view-hint') || {}).textContent || ''`);
  await setSel('#ms-view', 'contour');
  await sleep(600);
  const hint1 = await ev(`(document.getElementById('ms-view-hint') || {}).textContent || ''`);
  check('★2 工作室也有风格控件，且说明文字随档位换',
    !!v1 && v1.n === 3 && v1.ids.join(',') === 'relief,contour,flat' && v1.value === 'relief'
    && /山体阴影/.test(hint0) && /等高线/.test(hint1) && hint0 !== hint1,
    { ids: v1 && v1.ids, value0: v1 && v1.value, hint0: hint0.slice(0, 24), hint1: hint1.slice(0, 24) });

  /* ★3 开局有一张预览 + 统计行 */
  await sleep(2200);
  const p0 = await preview();
  check('★3 开局出一张预览 + 统计行报数字', p0.ok && p0.len > 5000 && /块陆地/.test(p0.note),
    { len: p0.len, note: p0.note.slice(0, 50) });

  /* ★4 ⭐同一片地，三档出三张**不同**的图（像素哈希两两不等）*/
  const sig = {};
  for (const v of ['relief', 'contour', 'flat']) {
    await setSel('#ms-view', v);
    await sleep(2600);                        /* 一张一张出图：换档要重新渲染一次 */
    sig[v] = await preview();
  }
  const uniq = new Set([sig.relief.sum, sig.contour.sum, sig.flat.sum]);
  check('★4 三档 = 三张不同的图（同一片地，只换画法）',
    sig.relief.ok && sig.contour.ok && sig.flat.ok && uniq.size === 3,
    { relief: sig.relief.sum, contour: sig.contour.sum, flat: sig.flat.sum });

  /* ★5 ⭐量化证据：平面档「局部对比 sd」明显小于立体档（阴影真被关掉了，不是只换了个按钮文字）*/
  const drop = sig.relief.sd > 0 ? 1 - sig.flat.sd / sig.relief.sd : 0;
  check('★5 平面档的阴影真关掉了（局部对比 sd 明显下降）',
    drop > 0.05 && sig.contour.sd > 0 && sig.contour.sd !== sig.relief.sd,
    { reliefSd: sig.relief.sd, flatSd: sig.flat.sd, contourSd: sig.contour.sd, drop: +drop.toFixed(3) });

  /* ★6 ⭐换风格**不重算地形**：统计行逐字不变（三档之间），且此刻磁盘一个字节没动 */
  const note = sig.relief.note;
  const stat = (s) => s.replace(/ · 种子.*$/, '');   /* 去掉可能带风格字样的尾巴，只比地形数字 */
  const sigBefore = JSON.stringify(diskMap()?.terrain ?? null);
  check('★6 换风格不重算地形：三档的统计数字逐字相同、且预览阶段不落盘',
    stat(sig.contour.note) === stat(note) && stat(sig.flat.note) === stat(note)
    && JSON.stringify(diskMap()?.terrain ?? null) === sigBefore,
    { note: note.slice(0, 60), same: stat(sig.contour.note) === stat(note) });

  /* ★7 「采用到地图」把这一档写进数据（顺便：地图栏控件跟着走）*/
  await setSel('#ms-view', 'contour');
  await sleep(1200);
  await click('#ms-apply');
  await sleep(2600);
  const pane = await ev(`(function () {
    const sel = document.getElementById('map-view');
    return { view: sel ? sel.value : null,
             disabled: sel ? sel.disabled : null,
             canvas: !!document.querySelector('#map-terrain-canvas'),
             note: (document.getElementById('map-gen-note') || {}).textContent || '' };
  })()`);
  check('★7 采用后落盘 terrain.view=contour、地图栏控件同步、画布真建起来了',
    diskMap()?.terrain?.view === 'contour' && pane.view === 'contour' && pane.disabled === false && pane.canvas,
    { disk: diskMap()?.terrain?.view, pane });

  /* ★8 ⭐地图栏那条路也是三档三张图（截屏哈希；面板先关掉，别挡住地图）*/
  await click('#ms-close');
  await sleep(1200);
  const paneShots = {};
  for (const v of ['relief', 'contour', 'flat']) {
    await setSel('#map-view', v);
    await sleep(2600);
    paneShots[v] = await shotSum('#map-terrain');
  }
  check('★8 地图栏里三档也各是一张不同的图（换档立刻重画）',
    new Set([paneShots.relief, paneShots.contour, paneShots.flat]).size === 3 && paneShots.relief !== 0,
    paneShots);

  /* ★9 这条偏好随地图持久化：只调这一档 ⇒ 地形参数一个都没变 */
  const t9 = diskMap()?.terrain ?? {};
  check('★9 只改了「看的方式」：种子/档位/数量一个都没动',
    !!t9.seed && !!t9.style && JSON.stringify(Object.keys(t9).sort()) === JSON.stringify(['seed', 'spec', 'style', 'view']),
    { keys: Object.keys(t9).sort(), view: t9.view, seed: t9.seed });

  /* ★10 刷新后还是那一档（存的是数据，不是内存里的临时状态）*/
  await ev(`window.location.reload(); true`);
  await sleep(2500);
  await evSoft(`!!document.getElementById('map-view')`);
  const after = await evSoft(`(function () { const s = document.getElementById('map-view'); return s ? s.value : 'none'; })()`);
  check('★10 刷新后仍是「平面」那一档', after === 'flat' && diskMap()?.terrain?.view === 'flat',
    { sel: after, disk: diskMap()?.terrain?.view });

  /* ★11 ⭐助手换地形时**不重置**创作者选的这一档（generate_map 不带 view ⇒ 沿用）*/
  await evSoft(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(`window.__lkSeen = []; window.__lkAgentMock = (m) => { window.__lkSeen.push(m); return '{"tool":"generate_map","args":{"description":"一片被风暴撕碎的群岛"}}'; }; true`);
  await ev(`document.querySelector('#lk-toolbar [data-tool="codex"]').click(); true`);
  await sleep(500);
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
  await sleep(800);
  await ev(`(function () {
    const s = document.getElementById('lk-agent-scope');
    const a = document.getElementById('lk-agent-ask');
    if (s) { s.value = 'workspace'; s.dispatchEvent(new Event('change', { bubbles: true })); }
    if (a) { a.value = 'always'; a.dispatchEvent(new Event('change', { bubbles: true })); }
    return true;
  })()`);
  await sleep(300);
  const seedBefore = diskMap()?.terrain?.seed;
  await ev(`(function () { const t = document.getElementById('lk-agent-input'); t.value = '换一张群岛'; document.getElementById('lk-agent-send').click(); return true; })()`);
  await sleep(2600);
  await ev(`(function () { const b = document.querySelector('#lk-agent-msgs [data-prop-ok]'); if (b) b.click(); return true; })()`);
  await sleep(2200);
  const afterAgent = diskMap()?.terrain ?? {};
  check('★11 助手换地形后，看的方式仍是「平面」（不带 view ⇒ 沿用创作者的选择）',
    afterAgent.seed !== seedBefore && afterAgent.view === 'flat',
    { seedBefore, seedAfter: afterAgent.seed, view: afterAgent.view });

  /* ★12 无未捕获异常 */
  const errs = await ev(`(window.__errs || []).slice(0, 8)`);
  check('★12 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} PASS`);
  w.close();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.message)); process.exit(2); });
