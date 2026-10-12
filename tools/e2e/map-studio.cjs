/* map-studio.cjs —— 地图生成**工作室面板**（`src/ui/map-studio.ts`）
 *
 * 用户 2026-10-14 原话：「生成做成一个独立的面板吧，两种，创作者自己一个个调参数或者 AI 直出，
 * 可以抽卡（毕竟是随机生成的）」；下面三个选择也是用户当场定的：
 *   · 面板形态 = **A 悬浮面板**（不接管主区、不盖遮罩 —— 边看沙盘上的地图边调）
 *   · AI 直出 = **真调模型 + 关键词兜底**（没配 AI / 没回出参数 ⇒ 退回 `parseMapPrompt`，离线也能用）
 *   · 抽卡 = **一次 6 张**（点一张看大图、「用这张」或底下「采用到地图」才落盘、单张可「换」、
 *     抽过的保留 12 张翻得回去）
 *
 * 本套件钉住的（`tools/e2e/map-gen.cjs` 只管"生成出来的地形对不对"，用面板当输入口）：
 *   · 面板真开得起来（地图栏一个入口 + 左栏一个面板型工具按钮，再点一次关）；
 *   · 「自己调」是**预览不落盘**（300ms 防抖，改参数先画图，按「采用到地图」才写）；
 *   · 「抽卡」一次 6 张、单张能换、选中的那张才进大图、「用这张」写的就是那张的种子；
 *   · 「AI 直出」真调模型（请求体里有我们的提示词）、AI 给的参数填进表单；AI 回废话 / 断网
 *     都退回关键词解析（**不许抛异常、不许什么都不发生**）；
 *   · 面板型工具只有一格（开设置面板再开它会收起设置）—— 注册表既有约定。
 *
 * 用法（见 tools/e2e/README.md）：起一个隔离实例（LINGKUANG_TEST_* 指到临时目录），
 *   node tools/e2e/reset-entity-vault.cjs; node tools/e2e/seed-node.cjs
 *   $env:LK_CDP_PORT=9500; node tools/e2e/map-studio.cjs
 * 断言以**磁盘上的 worldbuilding.json** 为真相（store 不暴露给页面），DOM 只用来驱动与看渲染。
 * ⚠️ AI 那两条用 **`window.fetch` 回放**（不碰真端点）：夹具一行里同时带 `message`（Ollama 原生
 * NDJSON）与 `choices`（OpenAI SSE）两种形状 ⇒ 不依赖测试实例默认配的是哪一家。 */
const fs = require('fs');
const DATA = process.env.LINGKUANG_TEST_DATA;
const PORT = process.env.LK_CDP_PORT || '9500';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);
}

const DESC = '一片被风暴撕碎的群岛，只有两条大河';
const FIX_AI = '{"style":"archipelago","islands":8,"rivers":4,"lakes":2,"landRatio":0.28}';
const FIX_JUNK = '嗯……我想想，大概是海和陆地的感觉吧，具体说不上来。';

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
  const ev = async (expr, ms = 15000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
      sleep(ms).then(() => ({ timedOut: true })),
    ]);
    if (r.timedOut) throw new Error('eval 超时 ' + ms + 'ms');
    if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };

  /* ── 面板现状 + 抽卡区的读法 ─────────────────────────────────────────── */
  const panel = () => ev(`(function () {
    const card = document.getElementById('lk-map-studio');
    /* ⚠️ 面板不存在（**旧构建**）时给一份同形状的空值：不然下面每个属性访问都要单独判，
        而且 p4.seeds.every(...) 这种会直接把整套崩成"脚本异常"，A/B 只剩一行报错。 */
    const empty = { open: false, tabs: [], onTab: '', src: '', srcLen: 0, note: '', state: '', style: '', lands: '', islands: '', seed: '', desc: '', n: 0, withImg: 0, picked: -1, seeds: [], cardSrc: [] };
    if (!card) return empty;
    const img = card.querySelector('#ms-img');
    const cards = [...card.querySelectorAll('#ms-grid [data-cand]')];
    return {
      open: true,
      tabs: [...card.querySelectorAll('.lk-ms__tab')].map((b) => b.dataset.tab),
      onTab: (card.querySelector('.lk-ms__tab.is-on') || {}).dataset ? card.querySelector('.lk-ms__tab.is-on').dataset.tab : '',
      src: img ? img.src : '',
      srcLen: img && img.src ? img.src.length : 0,
      note: (card.querySelector('#ms-note') || {}).textContent || '',
      state: (card.querySelector('#ms-state') || {}).textContent || '',
      style: (card.querySelector('#ms-style') || {}).value || '',
      lands: (card.querySelector('#ms-lands') || {}).value || '',
      islands: (card.querySelector('#ms-islands') || {}).value || '',
      seed: (card.querySelector('#ms-seed') || {}).value || '',
      desc: (card.querySelector('#ms-desc') || {}).value || '',
      n: cards.length,
      withImg: cards.filter((c) => !!c.querySelector('img')).length,
      picked: cards.findIndex((c) => c.classList.contains('is-on')),
      seeds: cards.map((c) => { const s = c.querySelector('.lk-ms__card-meta span'); return s ? s.textContent : ''; }),
      cardSrc: cards.map((c) => { const i = c.querySelector('img'); return i ? i.src.length : 0; }),
    };
  })()`);
  const mapBar = () => ev(`(function () {
    const note = document.getElementById('map-gen-note');
    const svg = document.getElementById('map-svg');
    return {
      note: note ? note.textContent : '',
      terr: !!(svg && svg.querySelector('image[data-terrain]')),
      coast: svg ? svg.querySelectorAll('path[data-coast]').length : 0,
    };
  })()`);
  const clickIn = (sel) => ev(`(function () { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`);

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);

  /* ---------- ★0 前置 ---------- */
  const pre = await ev(`({
    svg: !!document.getElementById('map-svg'),
    gen: !!document.getElementById('map-gen'),
    tools: [...document.querySelectorAll('#lk-toolbar .lk-tool-btn')].map((b) => b.dataset.tool),
    open: !!document.getElementById('lk-map-studio'),
  })`);
  check('★0 前置：地图那格在、地图栏有生成入口、左栏有「地图生成」、面板还没开',
    pre.svg && pre.gen && pre.tools.includes('mapgen') && pre.open === false, pre);

  /* ---------- ★1 地图栏那个按钮开面板（默认停「自己调」，开局就有一张预览） ---------- */
  await clickIn('#map-gen');
  await sleep(900);
  const p1 = await panel();
  check('★1 点「生成地形…」⇒ 面板开、三个页签齐、默认「自己调」、开局已有一张预览',
    p1.open === true && p1.tabs.join(',') === 'tune,ai,draw' && p1.onTab === 'tune' && p1.src.startsWith('data:image/png') && p1.srcLen > 20000,
    { tabs: p1.tabs, onTab: p1.onTab, srcLen: p1.srcLen });

  /* ---------- ★2 自己调：改动**先出预览**（300ms 防抖），落盘等「采用」 ---------- */
  const before2 = await panel();
  const disk2a = diskMap();
  await ev(`(function () {
    const card = document.getElementById('lk-map-studio');
    if (!card) return false;                 /* 旧构建：面板根本不存在 —— 优雅判假，别让整套崩掉 */
    const el = card.querySelector('#ms-lands');
    if (!el) return false;
    el.value = '2';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const now2 = await panel();          /* 防抖窗口内：还没重画 */
  await sleep(700);
  const after2 = await panel();
  check('★2 改参数先出预览（300ms 防抖：立刻读还是旧的、等一下才换），此刻没落盘',
    after2.src !== before2.src && after2.srcLen > 20000 && /2 块陆地/.test(after2.note)
      && (disk2a?.terrain?.seed || '') === (diskMap()?.terrain?.seed || ''),
    { debounced: now2.src === before2.src, note: after2.note.slice(0, 80), lands: after2.lands });

  /* ---------- ★3 「采用到地图」才落盘（一步 Ctrl+Z） ---------- */
  await clickIn('#ms-apply');
  await sleep(900);
  const m3 = diskMap();
  const p3 = await panel();
  const bar3 = await mapBar();
  check('★3 「采用到地图」⇒ 磁盘上的 terrain 就是预览那一份（种子/档位/数量），地图栏与地图上跟着变',
    !!m3?.terrain && m3.terrain.spec?.lands === 2 && /Ctrl\+Z 可撤销/.test(p3.state)
      && bar3.terr === true && bar3.coast >= 1 && bar3.note.includes(`种子「${m3.terrain.seed}」`),
    { terrain: m3?.terrain, state: p3.state.slice(0, 60), note: bar3.note.slice(0, 80), coast: bar3.coast });

  /* ---------- ★4 抽卡：一次 6 张、一张一张地翻、点一张看大图 ---------- */
  await clickIn('.lk-ms__tab[data-tab="draw"]');
  await sleep(300);
  await clickIn('#ms-roll-same');
  await sleep(2500);                    /* 6 张串行出图（每张 60~150ms） */
  const p4 = await panel();
  const srcBefore4 = p4.src;
  await clickIn('#ms-grid [data-cand="2"]');
  await sleep(400);
  const p4b = await panel();
  check('★4 抽卡一次 6 张（每张都出了图、各有各的种子），点第 3 张 ⇒ 大图换成它',
    p4.n === 6 && p4.withImg === 6 && p4.seeds.every((s) => !!s)
      && p4b.picked === 2 && p4b.src !== srcBefore4,
    { n: p4.n, withImg: p4.withImg, picked: p4b.picked, changed: p4b.src !== srcBefore4 });
  /* 上面那条的"大图真是那张卡"要靠 src 比对：单独算一次，避免把表达式塞进 check 里 */
  const same4 = await ev(`(function () {
    const card = document.getElementById('lk-map-studio');
    if (!card) return { same: false, cardLen: 0, bigLen: 0 };
    const c = card.querySelector('#ms-grid [data-cand="2"] img');
    const img = card.querySelector('#ms-img');
    return { same: !!c && !!img && c.src === img.src, cardLen: c ? c.src.length : 0, bigLen: img ? img.src.length : 0 };
  })()`);
  check('★4b 选中的那张就是大图那张（同一份 dataURL，不是"看着像"）',
    same4.same === true && same4.cardLen > 20000, same4);

  /* ---------- ★4c「连参数一起随机」：抽到的参数要写回表单（否则卡上的参数与表单对不上） ---------- */
  await clickIn('#ms-roll-rand');
  await sleep(2500);
  const p4c = await panel();
  const rand4 = await ev(`(function () {
    const card = document.getElementById('lk-map-studio');
    if (!card) return { st: '', lands: '', ratio: '' };
    const st = card.querySelector('#ms-style').value;
    const lands = card.querySelector('#ms-lands').value;
    const ratio = card.querySelector('#ms-ratio').value;
    return { st: st, lands: lands, ratio: ratio };
  })()`);
  check('★4c 「连参数一起随机」：又抽 6 张（上一批保留着 ⇒ 一共 12 张），抽到的档位/数量写回表单（不是只在卡上）',
    p4c.n === 12 && p4c.withImg === 12 && p4c.picked === 0
      && ['continent', 'archipelago', 'pangaea'].includes(rand4.st)
      && (rand4.lands === '' || (Number(rand4.lands) >= 1 && Number(rand4.lands) <= 4))
      && Number(rand4.ratio) >= 15 && Number(rand4.ratio) <= 45,
    { n: p4c.n, withImg: p4c.withImg, picked: p4c.picked, rand: rand4 });

  /* ---------- ★5 单张「换」：只换那一张的种子（张数不变） ---------- */
  const before5 = await panel();
  const seedsBefore5 = before5.seeds;
  await clickIn('#ms-grid [data-reroll="0"]');
  await sleep(900);
  const p5 = await panel();
  check('★5 单张「换」⇒ 只有那一张换种子，其余不动、张数不变',
    p5.n === before5.n && p5.n >= 6 && p5.seeds[0] !== seedsBefore5[0] && p5.seeds[1] === seedsBefore5[1] && p5.withImg === p5.n,
    { n: p5.n, was: seedsBefore5[0], now: p5.seeds[0], keep: p5.seeds[1] === seedsBefore5[1] });

  /* ---------- ★6 「用这张」写进地图的就是那张的种子 ---------- */
  const seed6 = (await panel()).seeds[1];
  await clickIn('#ms-grid [data-use="1"]');
  await sleep(400);
  await clickIn('#ms-apply');
  await sleep(900);
  const m6 = diskMap();
  check('★6 「用这张」+「采用到地图」⇒ 落盘的就是那张卡的种子',
    !!seed6 && m6?.terrain?.seed === seed6, { card: seed6, disk: m6?.terrain?.seed });

  /* ⚠️ 这批卡的数量要**趁面板还开着**记下来（★11 会把面板关掉 ⇒ 那时 panel() 只剩空形状）；
     ★7~★11 都不动抽卡区，所以这里记的数就是关面板前那一批。 */
  const nCards = (await panel()).n;

  /* ---------- AI 直出：真调模型（fetch 回放） ---------- */
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
      /* 一行里同时带 message（Ollama 原生 NDJSON）与 choices（OpenAI SSE）两种形状 */
      const chunk = {
        model: 'lk-e2e',
        message: { role: 'assistant', content },
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
        done: false,
      };
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

  await clickIn('.lk-ms__tab[data-tab="ai"]');
  await sleep(250);
  await ev(`(function () {
    const card = document.getElementById('lk-map-studio');
    if (!card) return false;
    const d = card.querySelector('#ms-desc');
    if (!d) return false;
    d.value = ${JSON.stringify(DESC)};
    return true;
  })()`);
  await setFix([{ mode: 'json', content: FIX_AI }]);
  await clickIn('#ms-ai-go');
  await sleep(1200);
  const p7 = await panel();
  const req7 = await ev(`(function () { const r = window.__msReq || []; return r.length ? r[r.length - 1].body : ''; })()`);
  check('★7 AI 直出真调了模型（请求体里有我们的提示词与那句话），回来的参数填进表单',
    req7.includes('地图生成参数') && req7.includes(DESC)
      && p7.style === 'archipelago' && p7.islands === '8' && p7.seed === DESC && /AI 给的参数/.test(p7.state),
    { style: p7.style, islands: p7.islands, state: p7.state.slice(0, 60), reqLen: req7.length });

  /* ---------- ★8 AI 回废话 ⇒ 退回关键词解析（离线可用，不许什么都不发生） ---------- */
  await setFix([{ mode: 'junk', content: FIX_JUNK }]);
  await ev(`(function () {
    const card = document.getElementById('lk-map-studio');
    if (!card) return false;
    const st = card.querySelector('#ms-style'); if (!st) return false;
    st.value = 'continent'; st.dispatchEvent(new Event('change', { bubbles: true }));
    const d = card.querySelector('#ms-desc'); if (!d) return false;
    d.value = '一片群岛，三条大河';
    return true;
  })()`);
  await clickIn('#ms-ai-go');
  await sleep(1200);
  const p8 = await panel();
  check('★8 AI 没回出参数 ⇒ 关键词解析接手（说「一片群岛」就是群岛档，并如实说明走了这条路）',
    p8.style === 'archipelago' && /关键词解析/.test(p8.state) && p8.seed === '一片群岛，三条大河',
    { style: p8.style, state: p8.state.slice(0, 70), seed: p8.seed });

  /* ---------- ★9 AI 断网 ⇒ 也退回关键词解析，且不许抛异常 ---------- */
  await setFix([{ mode: 'throw' }]);
  await clickIn('#ms-ai-go');
  await sleep(1200);
  const p9 = await panel();
  check('★9 端点连不上 ⇒ 面板照样给出一张图（退回关键词解析 + 如实报"没连上"），不抛异常',
    /没连上 AI/.test(p9.state) && p9.src.startsWith('data:image/png') && p9.seed === '一片群岛，三条大河',
    { state: p9.state.slice(0, 80), srcLen: p9.srcLen });

  /* ---------- ★10 面板型工具只有一格：开设置面板会收起它 ---------- */
  await ev(`window.__lkOrigFetch && (window.fetch = window.__lkOrigFetch); true`);   /* 收回回放，别影响设置面板 */
  await clickIn('#lk-toolbar [data-tool="settings"]');
  await sleep(800);
  const both = await ev(`({ settings: !!document.getElementById('lk-settings-panel'), studio: !!document.getElementById('lk-map-studio') })`);
  check('★10 面板型工具只有一格：开设置面板后地图生成那层收起来了（注册表既有约定）',
    both.settings === true && both.studio === false, both);
  await clickIn('#lk-set-close');
  await sleep(400);

  /* ---------- ★11 左栏按钮：点开、再点一次关 ---------- */
  await clickIn('#lk-toolbar [data-tool="mapgen"]');
  await sleep(900);
  const open11 = !!(await panel()).open;
  const active11 = await ev(`(function () { const b = document.querySelector('#lk-toolbar [data-tool="mapgen"]'); return !!b && b.classList.contains('is-active'); })()`);
  await clickIn('#lk-toolbar [data-tool="mapgen"]');
  await sleep(500);
  const closed11 = !(await panel()).open;
  check('★11 左栏「地图生成」按钮：点开（按钮高亮）→ 再点一次关',
    open11 === true && active11 === true && closed11 === true, { open: open11, active: active11, closed: closed11 });

  /* ---------- ★12 抽过的卡不丢：关掉再开还在（模块级状态，保留上限 12 张） ---------- */
  await clickIn('#map-gen');
  await sleep(900);
  await clickIn('.lk-ms__tab[data-tab="draw"]');
  await sleep(300);
  const p12 = await panel();
  check('★12 关掉再开：抽过的那批卡还在（不用重新抽）',
    p12.open === true && p12.n === nCards && nCards >= 6 && p12.withImg === p12.n, { n: p12.n, was: nCards, withImg: p12.withImg });

  const errs = await ev(`window.__errs || []`);
  check('★13 全程无未捕获异常', Array.isArray(errs) && errs.length === 0, { errs });

  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} PASS`);
  process.exit(pass === results.length ? 0 : 2);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + ((e && e.stack) || e)); process.exit(2); });
