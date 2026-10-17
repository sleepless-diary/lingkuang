/* 地图生成**工作室面板**（`#lk-map-studio`）的行为：自己调 / AI 直出 / 抽卡三条路。
 *
 *  ⭐ 2026-10-15：内核换成 vendored mapgen4（`src/mapgen/`）⇒ 本套件跟着重写。
 *  与「生成出来的地形对不对」分开：那部分在 `tools/e2e/map-gen.cjs`（地图栏那条路）+
 *  `tools/e2e/mapgen-engine.mjs`（无头跑内核数字）。
 *  这里只管**面板自己**：三页签、三个旋钮、防抖、抽卡、AI 直出与两条兜底、关面板。
 *
 *  ⚠️ AI 那三条用 **`window.fetch` 回放**（不碰真端点）：夹具一行里同时带 `message`（Ollama 原生
 *  NDJSON）与 `choices`（OpenAI SSE）两种形状 ⇒ 不依赖测试实例默认配的是哪一家。
 *
 *  用法：LINGKUANG_TEST_* 指到临时目录起一个隔离实例，LK_CDP_PORT=9500 node tools/e2e/map-studio.cjs */
const fs = require('fs');
const DATA = process.env.LINGKUANG_TEST_DATA;
const PORT = process.env.LK_CDP_PORT || '9500';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);
}
const FIX_JUNK = '这张图我想表达的是风暴之后的破碎海岸，但我一时说不清具体要几个大陆。';

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
  const ev = async (expr, ms = 20000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
      sleep(ms).then(() => ({ timedOut: true })),
    ]);
    if (r.timedOut) throw new Error('eval 超时 ' + ms + 'ms');
    if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  /* ⚠️ 面板不存在（旧构建/已关掉）时也要返回**同形状空值** —— 否则一条断言就把整脚本崩成
     「脚本异常」，A/B 只剩一行报错（第九十二轮踩过）。 */
  const EMPTY = { open: false, tabs: 0, imgLen: 0, note: '', cards: 0, withImg: 0, state: '', limits: '', visible: {} };
  const panel = async () => {
    const v = await ev(`(function () {
      const el = document.getElementById('lk-map-studio');
      if (!el) return null;
      const img = document.getElementById('ms-img');
      const cs = [...document.querySelectorAll('#ms-grid [data-cand]')];
      const vis = {};
      for (const s of el.querySelectorAll('.lk-ms__sec')) vis[s.dataset.sec] = s.style.display !== 'none';
      return {
        open: true,
        tabs: el.querySelectorAll('.lk-ms__tab').length,
        imgLen: img ? (img.src || '').length : 0,
        note: (document.getElementById('ms-note') || {}).textContent || '',
        cards: cs.length,
        withImg: cs.filter((c) => { const i = c.querySelector('img'); return i && (i.src || '').length > 5000; }).length,
        state: (document.getElementById('ms-state') || {}).textContent || '',
        limits: (document.getElementById('ms-limits') || {}).textContent || '',
        visible: vis,
      };
    })()`);
    return v ?? EMPTY;
  };
  const click = (sel) => ev(`(function () { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`);
  const setKnob = (sel, v) => ev(`(function () {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.value = ${JSON.stringify(String(v))};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej: ' + String(e.reason))); true`);

  check('★0 前置：面板没开、地图栏有入口', (await panel()).open === false
    && (await ev(`!!document.getElementById('map-gen')`)) === true);

  /* ★1 开门 */
  await click('#map-gen');
  await sleep(2500);
  const p1 = await panel();
  check('★1 面板开出来了：三页签 + 默认在「自己调」', p1.open && p1.tabs === 3
    && p1.visible.tune === true && p1.visible.ai === false && p1.visible.draw === false,
    { tabs: p1.tabs, visible: p1.visible });

  check('★2 开门就出一张预览 + 状态行报统计', p1.imgLen > 5000 && /块陆地/.test(p1.note),
    { imgLen: p1.imgLen, note: p1.note.slice(0, 60) });

  const knobs = await ev(`({
    ridges: !!document.getElementById('ms-ridges'),
    rivers: !!document.getElementById('ms-rivers'),
    ratio: !!document.getElementById('ms-ratio'),
    old: ['ms-lands', 'ms-islands', 'ms-lakes'].filter((i) => !!document.getElementById(i)),
  })`);
  check('★3 旋钮换成内核真能做到的三项（旧的陆/岛/湖已移除）',
    knobs.ridges && knobs.rivers && knobs.ratio && knobs.old.length === 0, knobs);

  check('★4 面板如实写出"做不到的事"', /陆块数|岛数/.test(p1.limits) && /湖/.test(p1.limits),
    { limits: p1.limits.slice(0, 60) });

  /* ★5 防抖：立刻读还是旧的，等一下才换；而且**此刻没落盘**（预览不写数据） */
  const diskBefore = JSON.stringify(diskMap()?.terrain ?? null);
  await setKnob('#ms-ratio', 52);
  const immediate = (await panel()).note;
  await sleep(1600);
  const settled = (await panel()).note;
  check('★5 改参数先防抖、随后出预览；预览阶段不落盘',
    immediate !== settled && /52%/.test(settled) && JSON.stringify(diskMap()?.terrain ?? null) === diskBefore,
    { changed: immediate !== settled, settled: settled.slice(0, 50), diskUnchanged: JSON.stringify(diskMap()?.terrain ?? null) === diskBefore });

  /* ★6 页签切换 */
  await click('.lk-ms__tab[data-tab="ai"]');
  await sleep(200);
  const tabAi = (await panel()).visible;
  await click('.lk-ms__tab[data-tab="draw"]');
  await sleep(200);
  const tabDraw = (await panel()).visible;
  check('★6 页签真切页（ai / draw）', tabAi.ai === true && tabAi.tune === false && tabDraw.draw === true && tabDraw.ai === false,
    { tabAi, tabDraw });

  /* ★7 抽卡：6 张，一张一张出图 */
  const stageH0 = await ev(`(function () { const el = document.querySelector('.lk-ms__stage'); return el ? Math.round(el.getBoundingClientRect().height) : 0; })()`);
  await click('#ms-roll-same');
  await sleep(1000);
  const mid = await panel();
  await sleep(12000);
  const rolled = await panel();
  check('★7 抽卡出 6 张、全部真出图（先占位再一张张填）',
    mid.cards === 6 && rolled.cards === 6 && rolled.withImg === 6,
    { mid: { n: mid.cards, withImg: mid.withImg }, done: { n: rolled.cards, withImg: rolled.withImg } });

  /* ★7b（2026-10-13 用户「**抽卡会把顶部的主视图给顶矮**」）：卡片区撑高之后，
     预览那一格必须一点不缩 —— `.lk-ms__stage` 少了 `flex: 0 0 auto` 就会被压扁。 */
  const stageH1 = await ev(`(function () { const el = document.querySelector('.lk-ms__stage'); return el ? Math.round(el.getBoundingClientRect().height) : 0; })()`);
  check('★7b 抽卡之后预览没被顶矮（卡片区自己滚）',
    stageH0 > 40 && stageH1 === stageH0, { before: stageH0, after: stageH1 });

  /* ★8 点第 2 张 → 大图换成那张 */
  const before2 = (await panel()).imgLen;
  await ev(`(function () { const c = document.querySelectorAll('#ms-grid [data-cand]')[1]; if (!c) return false; c.click(); return true; })()`);
  await sleep(900);
  const picked = await panel();
  const sel = await ev(`document.querySelectorAll('#ms-grid [data-cand].is-on').length`);
  check('★8 点一张卡看大图（选中态 + 大图重出）', sel === 1 && picked.imgLen > 5000,
    { sel, sameLen: picked.imgLen === before2 });

  /* ★9 采用到地图：落盘的应该是**当前选中那张卡**（种子来自卡）+ 表单的档位 */
  const form = await ev(`({ style: (document.getElementById('ms-style') || {}).value || '' })`);
  const pickedSeed = await ev(`(function () {
    const c = document.querySelector('#ms-grid [data-cand].is-on');
    const s = c ? c.querySelector('.lk-ms__card-meta span') : null;
    return s ? s.textContent : '';
  })()`);
  await click('#ms-apply');
  await sleep(1200);
  const t = diskMap()?.terrain;
  const applied = (await panel()).state;
  check('★9 「采用到地图」真落盘（落的是选中那张卡的种子 + 表单档位，只有参数）',
    !!t && pickedSeed !== '' && t.seed === pickedSeed && t.style === form.style && typeof t.spec === 'object'
    && JSON.stringify(diskMap()).length < 4000 && /生成地形|已/.test(applied),
    { terrain: t, pickedSeed, state: applied.slice(0, 50) });

  /* ---------- AI 直出：真调模型（fetch 回放；一行同时带两种协议形状）---------- */
  await ev(`(function () {
    window.__lkOrigFetch = window.__lkOrigFetch || window.fetch;
    window.__msFix = [];
    window.__msReq = [];
    window.fetch = function (url, init) {
      const u = String(url);
      if (u.indexOf('chat/completions') < 0 && u.indexOf('/api/chat') < 0) return window.__lkOrigFetch.apply(this, arguments);
      const fx = window.__msFix.length ? window.__msFix.shift() : { mode: 'junk', content: ${JSON.stringify(FIX_JUNK)} };
      let body = '';
      try { body = String((init && init.body) || ''); } catch (e) { /* 无所谓 */ }
      window.__msReq.push({ url: u, body: body.slice(0, 2500) });
      if (fx.mode === 'throw') return Promise.reject(new Error('LK-E2E 假装断网'));
      const content = fx.content || '';
      const chunk = { model: 'lk-e2e', message: { role: 'assistant', content }, choices: [{ index: 0, delta: { content }, finish_reason: null }], done: false };
      const lines = [
        JSON.stringify(chunk) + '\\n',
        JSON.stringify({ model: 'lk-e2e', done: true, done_reason: 'stop', message: { role: 'assistant', content: '' }, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\\n',
      ];
      const enc = new TextEncoder();
      return Promise.resolve(new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(lines.join(''))); c.close(); } }), { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }));
    };
    return true;
  })()`);
  const setFix = async (q) => ev(`window.__msFix = ${JSON.stringify(q)}; window.__msReq = []; true`);
  const aiGo = async (desc, wait = 2500) => {
    await ev(`(function () { const el = document.getElementById('ms-desc'); if (el) el.value = ${JSON.stringify(desc)}; return true; })()`);
    await click('#ms-ai-go');
    await sleep(wait);
    return { state: (await panel()).state, seed: await ev(`(document.getElementById('ms-seed') || {}).value || ''`),
             style: await ev(`(document.getElementById('ms-style') || {}).value || ''`) };
  };

  await click('.lk-ms__tab[data-tab="ai"]');
  await sleep(200);
  await setFix([{ content: '{"style":"archipelago","rivers":3,"landRatio":0.28}' }]);
  const ai1 = await aiGo('一片被风暴撕碎的群岛，河网密');
  check('★10 AI 直出真调了模型（请求体里有我们的提示词）并把参数填进表单',
    /AI 给的参数/.test(ai1.state) && ai1.seed === '一片被风暴撕碎的群岛，河网密' && ai1.style === 'archipelago'
    && (await ev(`(window.__msReq || []).length`)) >= 1
    && (await ev(`(window.__msReq || []).some((r) => r.body.indexOf('地图生成参数') >= 0)`)) === true,
    { state: ai1.state.slice(0, 60), style: ai1.style });

  await setFix([{ mode: 'junk', content: FIX_JUNK }]);
  const ai2 = await aiGo('这里应该是一片群岛');
  check('★11 AI 没回出参数 ⇒ 退回关键词解析（认得出「群岛」）',
    ai2.style === 'archipelago' && /关键词解析|没回出参数/.test(ai2.state), { state: ai2.state.slice(0, 70), style: ai2.style });

  await setFix([{ mode: 'throw' }]);
  const ai3 = await aiGo('一整块超级大陆');
  check('★12 断网也不炸：按关键词解析「盘古」',
    ai3.style === 'pangaea' && /没连上|关键词解析/.test(ai3.state), { state: ai3.state.slice(0, 70), style: ai3.style });

  await ev(`window.__lkOrigFetch && (window.fetch = window.__lkOrigFetch); true`);   /* 收回回放 */

  /* ★13 关面板：DOM 真摘掉（离屏视图与 GL 上下文随之释放） */
  await click('#ms-close');
  await sleep(600);
  const closed = await ev(`({ panel: !!document.getElementById('lk-map-studio'), img: !!document.getElementById('ms-img') })`);
  check('★13 关面板真摘 DOM', closed.panel === false && closed.img === false, closed);

  /* ★14 无未捕获异常 */
  const errs = await ev(`(window.__errs || []).slice(0, 8)`);
  check('★14 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} PASS`);
  w.close();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.message)); process.exit(2); });
