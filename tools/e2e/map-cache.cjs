/* 地图底图缓存（第一百三十三轮）—— 用户 2026-10-31：「为什么每次进入灵框时都要重新渲染一次地图」。
 *
 *  地形是参数的纯函数，图以前每次启动都现算（星球 ~1.9s、局部 ~130ms + 遮罩）。
 *  这一轮把**渲染好的那一帧**按参数签名存进 `userData/mapcache/`，参数没变就直接贴图。
 *  本套件钉住的是接进界面之后的契约（内核那层不用开实例）：
 *    · 参数没变 ⇒ 重载后**不重算、不挂遮罩**，图在（尺寸/形态/状态行数字都对得上）；
 *    · 统计一起缓存 ⇒ 状态行逐字一致（不是"先空着再补"）；
 *    · 换「看的方式」= 换键 ⇒ 另存一张（缓存键里有 view，少一项就会贴错图）；
 *    · 盘上条数被 LRU 压到 8 以内（否则换档位/换世界会越攒越多）；
 *    · 全程无未捕获异常。
 *
 *  用法（同其它套件）：
 *    $env:LINGKUANG_TEST_DATA=...; $env:LINGKUANG_VAULT=...; $env:LINGKUANG_TEST_USERDATA=...
 *    LK_CDP_PORT=9555 node tools/e2e/map-cache.cjs
 *  ⚠️ **必须**带 `LINGKUANG_TEST_USERDATA`：缓存就落在 `userData/mapcache/`，
 *     没有它这套会写进真实的 `%APPDATA%\lingkuang\`（见 AGENTS.md 的测试后门）。
 */
const fs = require('fs');
const path = require('path');
const USERDATA = process.env.LINGKUANG_TEST_USERDATA;
const PORT = process.env.LK_CDP_PORT || '9555';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);
}

const CACHE_DIR = USERDATA ? path.join(USERDATA, 'mapcache') : '';
function cacheFiles() {
  try { return fs.readdirSync(CACHE_DIR).filter((f) => /\.(webp|png)$/i.test(f)); } catch { return []; }
}
function cacheIndex() {
  try { return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'index.json'), 'utf8')); } catch { return []; }
}
function biggestCacheFile() {
  let best = 0;
  for (const f of cacheFiles()) {
    try { best = Math.max(best, fs.statSync(path.join(CACHE_DIR, f)).size); } catch { /* ignore */ }
  }
  return best;
}

async function main() {
  if (!USERDATA) { console.log('FAIL 需要 LINGKUANG_TEST_USERDATA（别在真实数据目录上跑）'); process.exit(2); }

  let target = null;
  for (let i = 0; i < 150; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  if (!target) { console.log(`FAIL 无法连接 CDP ${PORT}`); process.exit(1); }

  const w = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; });
  let id = 0; const pending = new Map();
  /* 重载要等**新文档的 load 事件**：`Page.reload` 是异步的，立刻去 evaluate 会打在旧文档上
     （第一版就是这么假绿的：旧页面有画布 ⇒ 轮询马上返回，随后量到的是空文档）。 */
  let loadWaiters = [];
  w.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Page.loadEventFired') { const ws = loadWaiters; loadWaiters = []; ws.forEach((f) => f()); }
  };
  const nextLoad = () => new Promise((res) => loadWaiters.push(res));
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); w.send(JSON.stringify({ id: i, method, params })); });
  /* ⚠️ 每条 ev 都带超时：渲染进程里某句 await 永不落定的话，套件会静静吊死 */
  const ev = async (expr, ms = 20000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
      sleep(ms).then(() => ({ timedOut: true })),
    ]);
    if (r.timedOut) throw new Error('eval 超时 ' + ms + 'ms');
    if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  const waitFor = async (expr, ms = 30000, step = 300) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await ev(expr, Math.min(8000, ms))) return true; } catch { /* 重载中上下文会短暂失效 */ }
      await sleep(step);
    }
    return false;
  };
  const pane = () => ev(`(function () {
    const c = document.getElementById('map-terrain-canvas');
    return {
      hasCanvas: !!c, cw: c ? c.width : 0, ch: c ? c.height : 0,
      planet: c ? c.getAttribute('data-planet') : null,
      note: (document.getElementById('map-gen-note') || {}).textContent || '',
      busy: !!document.querySelector('.lk-busy'),
    };
  })()`);

  /* 重载后要在**新文档的第一时间**埋两样东西：
     `__t0`（量"多久出图"）与 `__busyCount`（量遮罩出现过几次 —— 缓存命中必须为 0）。 */
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__t0 = performance.now();
      window.__busyCount = 0;
      window.__errs = [];
      window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
      window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej: ' + String(e.reason)));
      document.addEventListener('DOMContentLoaded', () => {
        new MutationObserver((ms) => {
          for (const m of ms) for (const n of m.addedNodes) {
            if (n.nodeType === 1 && (n.classList && n.classList.contains('lk-busy'))) window.__busyCount++;
          }
        }).observe(document.body, { childList: true, subtree: true });
      });
    `,
  });

  /* ★0 前置：干净起点（没有地形、也没有缓存） */
  const p0 = await pane();
  const clean = !p0.hasCanvas && cacheFiles().length === 0;
  check('★0 前置：干净实例（没地形画布、mapcache 目录为空）', clean,
    { hasCanvas: p0.hasCanvas, files: cacheFiles().length, note: p0.note });

  /* ★1 生成一张星球图（走工作室面板，与用户那条路一致），并量"现算"要多久 */
  const t0 = Date.now();
  await ev(`(function () { const b = document.getElementById('map-gen'); if (b) b.click(); return true; })()`);
  await sleep(400);
  await ev(`(function () {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('ms-style', 'continent');
    set('ms-seed', 'e2e缓存');
    const s = document.getElementById('ms-style'); if (s) s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(1600);
  await ev(`(function () { const b = document.getElementById('ms-apply'); if (b) b.click(); return true; })()`);
  const appeared = await waitFor(`(function () { const c = document.getElementById('map-terrain-canvas'); return !!c && c.width > 1000; })()`, 60000, 250);
  const computeMs = Date.now() - t0;
  const p1 = await pane();
  check('★1 生成后画布在（星球 1536×768、等距圆柱、状态行报数）',
    appeared && p1.cw === 1536 && p1.ch === 768 && p1.planet === 'equirect' && /块陆地/.test(p1.note),
    { computeMs, cw: p1.cw, ch: p1.ch, planet: p1.planet, note: p1.note.slice(0, 60) });

  /* ★2 底图真的落盘了（一张 WebP，不是几百字节的壳） */
  let files = [];
  for (let i = 0; i < 30 && files.length === 0; i++) { await sleep(300); files = cacheFiles(); }
  const idx1 = cacheIndex();
  check('★2 底图落盘：mapcache 里一张 WebP + 索引一条（键含参数）',
    files.length === 1 && /\.webp$/.test(files[0]) && idx1.length === 1
    /* 键以 `v<版本>` 开头（第一百三十五轮把 MAP_CACHE_VERSION 抬到 2 ⇒ 别在这里钉死数字） */
    && typeof idx1[0].key === 'string' && /^v\d+\u0001/.test(idx1[0].key) && biggestCacheFile() > 20000,
    { files, indexLen: idx1.length, key: String(idx1[0] && idx1[0].key).slice(0, 40), bytes: biggestCacheFile() });

  /* 重载 + 量"多久出图 / 遮罩出现过几次"。`__t0` 的注释见上面那段注入的脚本。 */
  const reloadAndMeasure = async () => {
    const lp = nextLoad();
    await send('Page.reload', { ignoreCache: true });
    await Promise.race([lp, sleep(20000)]);
    const ok = await waitFor(`(function () { const c = document.getElementById('map-terrain-canvas'); return !!c && c.width > 1000; })()`, 30000, 150);
    const info = await ev(`(function () {
      const c = document.getElementById('map-terrain-canvas');
      const g = document.getElementById('map-gen-note');
      return {
        ms: Math.round(performance.now() - (window.__t0 || 0)),
        busy: window.__busyCount | 0,
        cw: c ? c.width : 0, ch: c ? c.height : 0,
        planet: c ? c.getAttribute('data-planet') : null,
        note: g ? g.textContent : '',
      };
    })()`);
    return { ok, ...info };
  };

  /* ★3 重载 = 第二次"进入灵框"：必须**不挂遮罩**、图在、数字逐字一致 */
  const after = await reloadAndMeasure();
  check('★3 重载后直接贴图：无遮罩、画布尺寸/形态不变、状态行逐字一致',
    after.ok && after.busy === 0 && after.cw === 1536 && after.ch === 768 && after.planet === 'equirect'
    && after.note === p1.note,
    { reloadMs: after.ms, computeMs, busy: after.busy, noteSame: after.note === p1.note, note: after.note.slice(0, 60) });
  check('★4 贴图比现算快（启动那一下不再等星球生成）', after.ms < computeMs,
    { reloadMs: after.ms, computeMs });

  /* ★5 换「看的方式」= 换键 ⇒ 另存一张（命中旧键会把地形图/着色画错） */
  await ev(`(function () {
    const s = document.getElementById('map-view');
    if (!s) return false;
    s.value = 'topo';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const styled = await waitFor(`(function () {
    const g = document.getElementById('map-gen-note');
    return !!g && /地形图/.test(g.textContent);
  })()`, 60000, 300);
  let files2 = [];
  for (let i = 0; i < 30 && files2.length < 2; i++) { await sleep(300); files2 = cacheFiles(); }
  const note2 = (await pane()).note;
  check('★5 换「看的方式」重出一条并另存一张缓存（键里有 view）',
    styled && note2 !== p1.note && files2.length === 2 && cacheIndex().length === 2,
    { styled, files: files2.length, index: cacheIndex().length, note: note2.slice(0, 60) });

  /* ★6 再重载：新那一档也是瞬开 + 无遮罩 + 数字一致 */
  const after2 = await reloadAndMeasure();
  check('★6 第二档也命中缓存（无遮罩、状态行逐字一致）',
    after2.ok && after2.busy === 0 && after2.note === note2,
    { reloadMs: after2.ms, busy: after2.busy, noteSame: after2.note === note2 });

  /* ★7 LRU：往盘上塞 10 条假键，条数必须被压回 8（真图会被挤掉，所以放最后一步做） */
  await ev(`(async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    for (let i = 0; i < 10; i++) await window.lingkuangAPI.mapCachePut('probe-lru-' + i, png, { lands: 1 });
    return true;
  })()`);
  await sleep(500);
  check('★7 LRU：盘上条数压到 8 以内（换档位/换世界不会越攒越多）',
    cacheFiles().length <= 8 && cacheIndex().length <= 8,
    { files: cacheFiles().length, index: cacheIndex().length });

  /* ★8 无未捕获异常（含重载前那条 doc；重载后 `__errs` 是新的） */
  const errs = await ev(`(window.__errs || []).slice(0, 8)`);
  check('★8 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} PASS`);
  w.close();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.message)); process.exit(2); });
