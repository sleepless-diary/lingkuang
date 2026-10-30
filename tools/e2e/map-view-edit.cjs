/* 地图栏 = 展示器 / 全屏编辑（第一百三十四轮）。
 *
 *  用户 2026-10-31：「能不能底下的地图只是一个展示器，点一下才能进入地图编辑模式，
 *  包括划区域什么的」。追问确认的目的 = **先看大图，真要动手再进编辑器**。
 *
 *  这一轮钉住的契约：
 *    · 展示态：没有工具条、不接指针（**拖一笔不会留下区域**）、点一下 = 看大图；
 *    · 编辑态：点「编辑…」⇒ 这一格升成全屏（尺寸 ≈ 窗口），工具条出现，能划区域；
 *    · 「完成」/Esc 回到展示态，区域照旧画在图上；
 *    · 大图查看器里那颗「编辑」⇒ 关掉大图 + 直接进编辑态。
 *
 *  用法：隔离实例（LINGKUANG_TEST_DATA / VAULT / USERDATA 都指临时目录），
 *        LK_CDP_PORT=9556 node tools/e2e/map-view-edit.cjs
 */
const fs = require('fs');
const DATA = process.env.LINGKUANG_TEST_DATA;
const PORT = process.env.LK_CDP_PORT || '9556';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);
}

/* 磁盘是真相：区域只认 worldbuilding.json 里那份（渲染层可能只是画了一笔没落盘） */
function diskRegions() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    const ws = d.worldsets[Object.keys(d.worldsets)[0]];
    return ((ws.maps || [])[0]?.regions || []).length;
  } catch { return -1; }
}

async function main() {
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
  const waitFor = async (expr, ms = 30000, step = 250) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await ev(expr)) return true; } catch { /* 重绘中 */ }
      await sleep(step);
    }
    return false;
  };

  const pane = () => ev(`(function () {
    const host = document.querySelector('.lk-pane-body.lk-map-edit') || document.querySelector('#lk-pane-map .lk-pane-body');
    const tb = document.getElementById('map-toolbar');
    const eb = document.getElementById('map-edit');
    const r = host ? host.getBoundingClientRect() : null;
    return {
      editing: !!(host && host.classList.contains('lk-map-edit')),
      toolbar: tb ? getComputedStyle(tb).display !== 'none' : null,
      editBtn: eb ? getComputedStyle(eb).display !== 'none' : null,
      rect: r ? { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) } : null,
      canvas: !!document.getElementById('map-terrain-canvas'),
      regions: document.querySelectorAll('#map-svg [data-region]').length,
      note: (document.getElementById('map-gen-note') || {}).textContent || '',
      win: { w: innerWidth, h: innerHeight },
    };
  })()`);

  /* 在 SVG 上拖一笔（合成 pointer 事件，与 map-gen/map-draw 同一种手势） */
  const dragOnce = () => ev(`(function () {
    const svg = document.getElementById('map-svg');
    if (!svg) return false;
    const b = svg.getBoundingClientRect();
    const at = (fx, fy) => ({ clientX: b.left + b.width * fx, clientY: b.top + b.height * fy });
    const mk = (t, p) => new PointerEvent(t, { clientX: p.clientX, clientY: p.clientY, bubbles: true, button: 0, buttons: 1, pointerId: 1 });
    svg.dispatchEvent(mk('pointerdown', at(0.3, 0.3)));
    for (const [fx, fy] of [[0.6, 0.3], [0.65, 0.55], [0.5, 0.7], [0.3, 0.55]]) svg.dispatchEvent(mk('pointermove', at(fx, fy)));
    window.dispatchEvent(mk('pointerup', at(0.3, 0.55)));
    return true;
  })()`);

  const click = (sel) => ev(`(function () { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`);

  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej: ' + String(e.reason))); true`);

  /* ★0 前置：展示态（工具条不在、编辑按钮在、没升全屏） */
  const p0 = await pane();
  check('★0 前置：展示态 —— 没有工具条、有「编辑…」、没升全屏',
    p0.editing === false && p0.toolbar === false && p0.editBtn === true,
    { toolbar: p0.toolbar, editBtn: p0.editBtn, editing: p0.editing, note: p0.note });

  /* ★1 先进编辑态生成一张星球（生成的入口现在在编辑态工具条里） */
  await click('#map-edit');
  await sleep(400);
  const p1 = await pane();
  const full = p1.rect && p1.editing && p1.rect.w >= p1.win.w - 2 && p1.rect.h >= p1.win.h - 2;
  check('★1 点「编辑…」⇒ 这一格升成全屏、工具条出现', full && p1.toolbar === true,
    { rect: p1.rect, win: p1.win, toolbar: p1.toolbar });
  await click('#map-gen');
  await sleep(500);
  await ev(`(function () {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('ms-style', 'continent'); set('ms-seed', 'e2e出图');
    const s = document.getElementById('ms-style'); if (s) s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(1600);
  await click('#ms-apply');
  const hasCanvas = await waitFor(`(function () { const c = document.getElementById('map-terrain-canvas'); return !!c && c.width > 1000; })()`, 60000, 300);
  await sleep(600);
  check('★2 编辑态里照样能生成地形（画布出图、状态行报数）', hasCanvas && /块陆地/.test((await pane()).note),
    { canvas: hasCanvas, note: (await pane()).note.slice(0, 50) });

  /* ★3 「完成」⇒ 回到展示态：工具条收起、全屏解除、图还在 */
  await click('#map-done');
  await sleep(500);
  const p3 = await pane();
  check('★3 「完成」回到展示态（工具条收起、不再是全屏、画布还在）',
    p3.editing === false && p3.toolbar === false && p3.canvas === true
    && p3.rect.w <= p3.win.w - 40 && p3.rect.h < p3.win.h - 100,
    { editing: p3.editing, toolbar: p3.toolbar, rect: p3.rect, win: p3.win });

  /* ★4 展示态**不能画**：拖一笔不许留下区域（这就是"只是展示器"那条规矩） */
  const before4 = diskRegions();
  await dragOnce();
  await sleep(900);
  const p4 = await pane();
  check('★4 展示态拖一笔不会画出区域（磁盘与画面都没多）',
    diskRegions() === before4 && p4.regions === 0,
    { disk: diskRegions(), dom: p4.regions });

  /* ★5 编辑态能划区域：先切「区域」再拖一笔 ⇒ 磁盘 +1、画面上多一条 path */
  await click('#map-edit');
  await sleep(400);
  await click('.map-mode[data-mode="region"]');
  await sleep(200);
  await dragOnce();
  await sleep(1200);
  const p5 = await pane();
  check('★5 编辑态划区域：落盘一条、画面上画出来',
    diskRegions() === before4 + 1 && p5.regions === 1,
    { disk: diskRegions(), dom: p5.regions });

  /* ★6 退出编辑：区域仍画在图上（它属于这张地图，不属于编辑态） */
  await click('#map-done');
  await sleep(500);
  const p6 = await pane();
  check('★6 「完成」之后区域还在画面上、工具条又收起来了',
    p6.editing === false && p6.toolbar === false && p6.regions === 1,
    { editing: p6.editing, regions: p6.regions });

  /* ★7 展示态点一下 ⇒ 大图查看器（第一次要算高清，给足时间） */
  await ev(`(function () {
    const svg = document.getElementById('map-svg') || document.querySelector('#map-stage');
    const r = svg.getBoundingClientRect();
    const x = r.left + r.width * 0.5, y = r.top + r.height * 0.5;
    const o = { clientX: x, clientY: y, bubbles: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons: 1 };
    svg.dispatchEvent(new PointerEvent('pointerdown', o));
    window.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
    return true;
  })()`);
  const lbOpen = await waitFor(`!!document.querySelector('.lk-lb')`, 45000, 300);
  const lb = await ev(`(function () {
    const i = document.querySelector('.lk-lb__img');
    const a = document.querySelector('.lk-lb__act');
    return { w: i ? i.naturalWidth : 0, h: i ? i.naturalHeight : 0, act: a ? a.textContent : '' };
  })()`);
  check('★7 展示态点一下 ⇒ 大图查看器（高清图 + 「编辑」按钮）',
    lbOpen && lb.w === 2304 && lb.h === 1152 && lb.act === '编辑',
    { lbOpen, ...lb });

  /* ★8 大图里的「编辑」⇒ 关掉大图、直接进编辑态 */
  await click('.lk-lb__act');
  await sleep(600);
  const p8 = await pane();
  const lbGone = (await ev(`!document.querySelector('.lk-lb')`)) === true;
  check('★8 大图里点「编辑」⇒ 查看器关掉 + 进全屏编辑',
    lbGone && p8.editing === true && p8.toolbar === true,
    { lbGone, editing: p8.editing, toolbar: p8.toolbar });

  /* ★9 Esc 退出编辑（不用鼠标也能出来） */
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(400);
  const p9 = await pane();
  check('★9 Esc 退出编辑态', p9.editing === false && p9.toolbar === false,
    { editing: p9.editing, toolbar: p9.toolbar });

  /* ★10 无未捕获异常 */
  const errs = await ev(`(window.__errs || []).slice(0, 8)`);
  check('★10 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} PASS`);
  w.close();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.message)); process.exit(2); });
