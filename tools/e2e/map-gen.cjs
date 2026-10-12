/* 地图生成（内核 = vendored mapgen4）—— 从**地图栏 + 生成面板**这条真路走一遍，
 *  断言以**磁盘上的 worldbuilding.json** 为真相（store 不暴露给页面）。
 *
 *  ⭐ 2026-10-15（用户：「好丑，有没有现成的轮子，我们生成的地图好假」→ 选定 A2「整包搬 mapgen4」）：
 *  地形从"我们自己画的栅格图 + 矢量岸线"换成**内核渲染的 WebGL 画布**（`src/mapgen/`）。
 *  本套件跟着重写，钉住的是**接进界面之后的契约**（内核那层的数字由
 *  `tools/e2e/mapgen-engine.mjs` 无头钉，不用开实例）：
 *    · 生成真画出来（`#map-terrain-canvas` 2048²），且**不落盘**（数据里只有参数，几百字节）；
 *    · 画布与 SVG 一起被 `#map-stage` 缩放 ⇒ 两者尺寸一致（手绘落点才不会偏）；
 *    · 状态行的数字与内核报的一致；
 *    · 同种子同参数 ⇒ 同一份统计；换种子 ⇒ 不一样；
 *    · 生成完照样能拖拽画区域（「生成作底稿、手绘精修」）；
 *    · 助手的 `generate_map` 在图上已有地形时一定出卡片（不许悄悄换掉）。
 *
 *  用法（见 tools/e2e/README.md）：起一个隔离实例（LINGKUANG_TEST_* 指到临时目录），
 *  LK_CDP_PORT=9500 node tools/e2e/map-gen.cjs */
const fs = require('fs');
const DATA = process.env.LINGKUANG_TEST_DATA;
const PORT = process.env.LK_CDP_PORT || '9500';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);
}

/* 磁盘上的地图 = 真相。⚠️ 写盘有 400ms 防抖，读之前先等一等。 */
function diskMap() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    const ws = d.worldsets[Object.keys(d.worldsets)[0]];
    return (ws.maps || [])[0] || null;
  } catch { return null; }
}

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
  /* ⚠️ ev 一定带超时：渲染进程里某句 await 永不落定的话，套件会静静吊死 */
  const ev = async (expr, ms = 20000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
      sleep(ms).then(() => ({ timedOut: true })),
    ]);
    if (r.timedOut) throw new Error('eval 超时 ' + ms + 'ms');
    if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  const setMock = (queue) => ev(`window.__lkSeen = []; window.__lkMockQ = ${JSON.stringify(queue)}; window.__lkAgentMock = (m) => { window.__lkSeen.push(m); return window.__lkMockQ.length ? window.__lkMockQ.shift() : '好的。'; }; true`);
  const ask = async (text, wait = 1800) => {
    await ev(`(function () { const t = document.getElementById('lk-agent-input'); if (!t) return false; t.value = ${JSON.stringify(text)}; document.getElementById('lk-agent-send').click(); return true; })()`);
    await sleep(wait);
  };
  /* 面板上「自己调」那一页：填三个旋钮（空 = 交给档位）再采用 */
  const gen = async (style, seed, knobs) => {
    await ev(`(function () { const b = document.getElementById('map-gen'); if (b) b.click(); return true; })()`);
    await sleep(400);
    await ev(`(function () {
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
      set('ms-style', ${JSON.stringify(style)});
      set('ms-seed', ${JSON.stringify(seed)});
      set('ms-ridges', ${JSON.stringify(knobs?.ridges ?? '')});
      set('ms-rivers', ${JSON.stringify(knobs?.rivers ?? '')});
      set('ms-ratio', ${JSON.stringify(knobs?.ratio ?? '')});
      const s = document.getElementById('ms-style'); if (s) s.dispatchEvent(new Event('change', { bubbles: true }));
      for (const id of ['ms-ridges', 'ms-rivers', 'ms-ratio']) {
        const el = document.getElementById(id); if (el) el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    })()`);
    await sleep(1600);   /* 防抖 300ms + 生成 + 渲染一帧 */
    const note = await ev(`(document.getElementById('ms-note') || {}).textContent || ''`);
    const url = await ev(`(function () { const i = document.getElementById('ms-img'); return i ? (i.src || '').length : 0; })()`);
    await ev(`(function () { const b = document.getElementById('ms-apply'); if (b) b.click(); return true; })()`);
    await sleep(1200);   /* 落盘防抖 400ms */
    return { note, url };
  };
  const pane = () => ev(`(function () {
    const c = document.getElementById('map-terrain-canvas');
    const box = document.getElementById('map-terrain');
    const stage = document.getElementById('map-stage');
    const svg = document.getElementById('map-svg');
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
    return {
      hasCanvas: !!c, cw: c ? c.width : 0, ch: c ? c.height : 0,
      css: c ? { w: Math.round(parseFloat(c.style.width)), top: Math.round(parseFloat(c.style.top)) } : null,
      box: box ? { w: box.style.width, h: box.style.height } : null,
      stage: stage ? stage.style.transform : '', svg: r(svg), canvas: r(c),
      note: (document.getElementById('map-gen-note') || {}).textContent || '',
    };
  })()`);

  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej: ' + String(e.reason))); true`);

  /* ★0 前置：地图栏在，还没地形 ⇒ 不该有画布 */
  const p0 = await pane();
  check('★0 前置：地图栏在，没地形时不出地形画布', !p0.hasCanvas && /还没有地形/.test(p0.note), { hasCanvas: p0.hasCanvas, note: p0.note });

  /* ★1 生成（走面板）→ 磁盘只多"参数" */
  const g1 = await gen('continent', 'e2e大陆', { ridges: 7, rivers: 3, ratio: 45 });
  await sleep(300);
  const disk1 = diskMap();
  const spec1 = disk1?.terrain?.spec ?? {};
  check('★1 生成真出预览（dataURL）且状态行报数', g1.url > 5000 && /块陆地/.test(g1.note), { url: g1.url, note: g1.note.slice(0, 70) });
  check('★2 落盘只有参数（种子/档位/三个数），不含任何图片',
    disk1?.terrain?.seed === 'e2e大陆' && disk1?.terrain?.style === 'continent'
    && spec1.ridges === 7 && spec1.rivers === 3 && Math.abs((spec1.landRatio ?? 0) - 0.45) < 1e-6
    && JSON.stringify(disk1).length < 4000,
    { terrain: disk1?.terrain, mapJsonLen: JSON.stringify(disk1).length });

  /* ★3 地图栏出画布：2048²，且铺满地图格子（裁带 ⇒ 画布比格子高，四周不拉伸） */
  const p1 = await pane();
  check('★3 地图栏出 2048² 画布 + 格子尺寸 = 地图尺寸',
    p1.hasCanvas && p1.cw === 2048 && p1.ch === 2048 && p1.box.w === '900px' && p1.box.h === '500px',
    { cw: p1.cw, box: p1.box, css: p1.css });
  check('★4 裁带映射：画布 CSS 是正方形（不拉扁）、宽度略大于地图宽、上移为负',
    p1.css && Math.abs(p1.css.w - p1.css.w) === 0 && p1.css.w > 880 && p1.css.w < 940 && p1.css.top < -180 && p1.css.top > -220,
    p1.css);
  check('★5 画布与 SVG 一起被缩放（同一层 ⇒ 手绘落点不偏）',
    p1.svg && p1.canvas && Math.abs(p1.svg.w / p1.svg.h - 1.8) < 0.05 && /scale\(/.test(p1.stage),
    { stage: p1.stage, svg: p1.svg });

  /* ★6 同种子同参数 ⇒ 统计逐字一致 */
  const g2 = await gen('continent', 'e2e大陆', { ridges: 7, rivers: 3, ratio: 45 });
  check('★6 同种子同参数 ⇒ 状态行逐字一致（确定性）', g2.note === g1.note, { a: g1.note.slice(0, 60), b: g2.note.slice(0, 60) });

  /* ★7 换种子 ⇒ 不一样 */
  const g3 = await gen('continent', 'e2e换一颗', { ridges: 7, rivers: 3, ratio: 45 });
  check('★7 换种子 ⇒ 统计不同', g3.note !== g1.note, { b: g2.note.slice(0, 40), c: g3.note.slice(0, 40) });

  /* ★8 档位分化：群岛的岛应多于盘古（同一颗种子、同一目标占比） */
  const gArch = await gen('archipelago', 'e2e档位', { ridges: 4, rivers: 2, ratio: 34 });
  const gPan = await gen('pangaea', 'e2e档位', { ridges: 4, rivers: 2, ratio: 34 });
  const num = (s, re) => Number((String(s).match(re) ?? [])[1] ?? NaN);
  const archipelago = num(gArch.note, /(\d+) 座岛/);
  const pangaea = num(gPan.note, /(\d+) 座岛/);
  check('★8 群岛的岛比盘古多（档位真起作用）', archipelago > pangaea, { archipelago, pangaea });

  /* ★9 生成完照样能手绘（「生成作底稿、手绘精修」） */
  const before = (diskMap()?.regions ?? []).length;
  const drew = await ev(`(function () {
    const svg = document.getElementById('map-svg');
    const b = svg.getBoundingClientRect();
    const at = (fx, fy) => ({ clientX: b.left + b.width * fx, clientY: b.top + b.height * fy });
    const mk = (t, p) => new PointerEvent(t, { clientX: p.clientX, clientY: p.clientY, bubbles: true, button: 0, buttons: 1, pointerId: 1 });
    const m = document.querySelector('.map-mode[data-mode="region"]'); if (m) m.click();
    svg.dispatchEvent(mk('pointerdown', at(0.3, 0.3)));
    svg.dispatchEvent(mk('pointermove', at(0.6, 0.3)));
    svg.dispatchEvent(mk('pointermove', at(0.6, 0.6)));
    svg.dispatchEvent(mk('pointermove', at(0.3, 0.6)));
    window.dispatchEvent(mk('pointerup', at(0.3, 0.6)));
    return true;
  })()`);
  await sleep(1200);
  const afterRegions = (diskMap()?.regions ?? []).length;
  const p2 = await pane();
  check('★9 生成之后照样能画区域（且地形画布还在）', drew && afterRegions === before + 1 && p2.hasCanvas,
    { before, after: afterRegions, canvas: p2.hasCanvas });

  /* ★10 层序：地形画布在 SVG 之下（DOM 顺序）—— 区域/标记必须盖在地形上 */
  const order = await ev(`(function () {
    const stage = document.getElementById('map-stage');
    const kids = [...stage.children].map((e) => e.id);
    return kids;
  })()`);
  check('★10 层序：地形层在 SVG 之前（画在底下）', Array.isArray(order) && order.indexOf('map-terrain') < order.indexOf('map-svg'), order);

  /* ★11 助手的 generate_map：图上已有地形 ⇒ 必须出卡片（不许悄悄换掉） */
  await ev(`document.querySelector('#lk-toolbar [data-tool="codex"]').click(); true`);
  await sleep(500);
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
  await sleep(700);
  const panelOpen = await ev(`!!document.getElementById('lk-agent-panel')`);
  /* 权限：范围 = 灵框库，询问 = 逐项确认（顺序不能反，见 agent-tools.cjs 的注释） */
  await ev(`(function () {
    const s = document.getElementById('lk-agent-scope');
    const a = document.getElementById('lk-agent-ask');
    s.value = 'workspace'; s.dispatchEvent(new Event('change', { bubbles: true }));
    a.value = 'always'; a.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  await setMock(['{"tool":"generate_map","args":{"description":"一片被风暴撕碎的群岛"}}']);
  const sigBefore = JSON.stringify(diskMap()?.terrain ?? {});
  await ask('换一张群岛', 2200);
  const card = await ev(`(function () {
    const c = document.querySelector('#lk-agent-msgs [data-prop-ok]');
    const t = document.querySelector('#lk-agent-msgs .lk-agent__prop-t, #lk-agent-msgs .lk-agent__prop-h');
    return { hasCard: !!c, title: t ? t.textContent : '' };
  })()`);
  await sleep(300);
  const sigAfter = JSON.stringify(diskMap()?.terrain ?? {});
  check('★11 已有地形时 generate_map 出提议卡片、点之前数据没动',
    panelOpen && card.hasCard && sigAfter === sigBefore,
    { panelOpen, title: card.title, unchanged: sigAfter === sigBefore });

  /* ★12 无未捕获异常 */
  const errs = await ev(`(window.__errs || []).slice(0, 8)`);
  check('★12 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} PASS`);
  w.close();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.message)); process.exit(2); });
