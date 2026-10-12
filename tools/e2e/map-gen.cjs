/* 地图生成（混合方案）—— 世界沙盘右边那格地图栏的「描述 + 生成地形」。
 *
 * 2026-10-13 用户三条（按时间）：
 *   ①「我建议先做一个基础的，看起来像的地图生成，真实模拟是额外附件」
 *   ②「确定不同地形的生成逻辑和形态，然后随机分区再生成…不生成等高线，而是直接生成真实地形」
 *   ③「地形主要是拿来看，文化分区什么的主要是拿来动手」⇒ 定下**混合方案**：
 *      栅格地形位图（看）+ 矢量海岸线/湖岸/河（描边、放大不糊）+ 手绘 `regions`（动手层）。
 *
 * 2026-10-14 用户：「生成做成一个独立的面板吧，两种，创作者自己一个个调参数或者 AI 直出，可以抽卡」
 *   ⇒ 控件搬进 `#lk-map-studio`（`src/ui/map-studio.ts`）。**本套件只管"生成出来的地形对不对"**，
 *   所以只借面板「自己调」那一页当输入口（开面板 → 填参数 → 采用）；面板本身的行为
 *   （三页签 / 抽卡 / AI 直出 / 防抖）在 `tools/e2e/map-studio.cjs`。
 *
 * 本套件钉住的：
 *   · 生成真画出地形（不是只改了数据）；矢量层真画出来且**不落盘**（派生自同一份参数）；
 *   · 提示行的数字与图上真画出来的**对得上**（湖数 === 湖岸条数；岸线条数 ≈ 陆块数）；
 *   · 岸线绝不贴画布边缘（"最外一圈是海"—— 否则等值线会首尾一连连出斜穿海面的线）；
 *   · 同档位同种子 ⇒ 同一张图；面板里改档位/数量真生效；
 *   · 生成完照样能拖拽画区域（「生成作底稿、手绘精修」），且**分区在岸线之下**（层序）；
 *   · 助手的 `generate_map` 在图上已有地形时一定出卡片（不许悄悄换掉）。
 *
 * 用法（见 tools/e2e/README.md）：起一个隔离实例（LINGKUANG_TEST_* 指到临时目录），
 * LK_CDP_PORT=9500 node tools/e2e/map-gen.cjs
 * 断言以**磁盘上的 worldbuilding.json** 为真相（store 不暴露给页面），DOM 只用来驱动与看渲染。 */
const fs = require('fs');
const DATA = process.env.LINGKUANG_TEST_DATA;
const PORT = process.env.LK_CDP_PORT || '9500';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);
}

/* 磁盘上的地图 = 真相。⚠️ store 是渲染进程私有的，页面里读不到 ⇒ 一律读文件。
   写盘有 400ms 防抖，读之前先等一等。 */
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
  const setMock = (queue) => ev(`window.__lkSeen = []; window.__lkMockQ = ${JSON.stringify(queue)}; window.__lkAgentMock = (m) => { window.__lkSeen.push(m); return window.__lkMockQ.length ? window.__lkMockQ.shift() : '好的。'; }; true`);
  const ask = async (text, wait = 1500) => {
    await ev(`(function () { const t = document.getElementById('lk-agent-input'); t.value = ${JSON.stringify(text)}; document.getElementById('lk-agent-send').click(); return true; })()`);
    await sleep(wait);
  };
  const gen = async (style, seed, counts) => {
    /* ⚠️ 2026-10-14 起生成控件**搬进了悬浮面板** `#lk-map-studio`（用户：「生成做成一个独立的面板吧」）：
       这里按**「自己调」那一页**驱动（开面板 → 填档位/种子/数量 → 等 300ms 防抖 → 「采用到地图」）。
       面板本身的行为（三页签、抽卡、AI 直出）在 `tools/e2e/map-studio.cjs`；本套件只管
       "生成出来的地形对不对"，所以只借面板当输入口。
       ⚠️ 旧构建上 `#lk-map-studio` 根本不存在 —— 这里必须**优雅判假**（不许 null.click() 把整套崩掉），
       否则 A/B 只能看到"脚本异常"，看不出差在哪一条。 */
    const ok1 = await ev(`(function () {
      const g = document.getElementById('map-gen'); if (!g) return false;
      g.click();
      const card = document.getElementById('lk-map-studio'); if (!card) return false;
      const st = card.querySelector('#ms-style'); if (!st) return false;
      st.value = ${JSON.stringify(style)};
      st.dispatchEvent(new Event('change', { bubbles: true }));
      const sd = card.querySelector('#ms-seed');
      if (sd) { sd.value = ${JSON.stringify(seed ?? '')}; sd.dispatchEvent(new Event('input', { bubbles: true })); }
      const c = ${JSON.stringify(counts ?? {})};
      Object.keys(c).forEach(function (k) {
        const el = card.querySelector('#' + k);
        if (el) { el.value = String(c[k]); el.dispatchEvent(new Event('input', { bubbles: true })); }
      });
      return true;
    })()`);
    await sleep(700);   /* 300ms 防抖 + 生成 ~100ms */
    const ok2 = await ev(`(function () {
      const card = document.getElementById('lk-map-studio'); if (!card) return false;
      const b = card.querySelector('#ms-apply'); if (!b) return false; b.click(); return true;
    })()`);
    await sleep(900);   /* 生成 ~100ms + store.update + 400ms 防抖落盘 */
    return ok1 === true && ok2 === true;
  };
  const dom = () => ev(`(function () {
    const q = (s) => document.querySelectorAll(s).length;
    const note = document.getElementById('map-gen-note');
    const svg = document.getElementById('map-svg');
    const img = svg ? svg.querySelector('image[data-terrain]') : null;
    const coastD = [...(svg ? svg.querySelectorAll('path[data-coast]') : [])].map((p) => p.getAttribute('d'));
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const d of coastD) {
      const nums = (d.match(/-?\\d+(?:\\.\\d+)?/g) || []).map(Number);
      for (let i = 0; i + 1 < nums.length; i += 2) {
        minX = Math.min(minX, nums[i]); maxX = Math.max(maxX, nums[i]);
        minY = Math.min(minY, nums[i + 1]); maxY = Math.max(maxY, nums[i + 1]);
      }
    }
    const html = svg ? svg.innerHTML : '';
    return {
      hasSvg: !!svg,
      terrHref: img ? img.getAttribute('href') : '',
      coast: q('#map-svg path[data-coast]'),
      lake: q('#map-svg path[data-lake]'),
      river: q('#map-svg path[data-river]'),
      coastClosed: coastD.length > 0 && coastD.every((d) => d.trim().endsWith('Z')),
      coastBox: coastD.length ? { minX: Math.round(minX), minY: Math.round(minY), maxX: Math.round(maxX), maxY: Math.round(maxY) } : null,
      regions: q('#map-svg path[data-region]'),
      order: { region: html.indexOf('data-region'), coast: html.indexOf('data-coast') },
      note: note ? note.textContent : '',
      controls: ['map-gen', 'map-gen-note'].filter((x) => !!document.getElementById(x)),
      gone: ['map-prompt', 'map-seed', 'map-style', 'map-reseed'].filter((x) => !!document.getElementById(x)),
      studio: !!document.getElementById('lk-map-studio'),
      hint: (document.getElementById('map-hint') || {}).textContent || '',
    };
  })()`);
  const sig = () => ev(`(function () {
    const svg = document.getElementById('map-svg');
    const img = svg && svg.querySelector('image[data-terrain]');
    const coast = [...(svg ? svg.querySelectorAll('path[data-coast]') : [])].map((p) => p.getAttribute('d')).join('|');
    return (img ? img.getAttribute('href').length : 0) + '#' + coast.length + '#' + coast.slice(0, 300);
  })()`);
  const numsIn = (note) => ({
    lands: Number((note.match(/(\d+) 块陆地/) || [])[1]),
    islands: Number((note.match(/(\d+) 座岛/) || [])[1]),
    rivers: Number((note.match(/(\d+) 条河/) || [])[1]),
    lakes: Number((note.match(/(\d+) 个湖/) || [])[1]),
  });

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);

  /* ⭐ 0 前置：这一格真在、生成入口在（**地图栏只剩一个按钮** —— 控件都搬进面板了） */
  const d0 = await dom();
  check('★0 前置：地图那格在、生成入口在地图栏（旧控件已搬走，还没开面板）',
    d0.hasSvg && d0.controls.length === 2 && d0.gone.length === 0 && d0.studio === false,
    { controls: d0.controls, gone: d0.gone, studio: d0.studio });

  /* ⭐ 1 点「生成地形…」→ 面板里按一下「采用到地图」⇒ DOM 上真画出一张地形图 */
  await gen('continent', '测试甲');
  const d1 = await dom();
  const m1 = diskMap();
  check('★1 生成后真画出地形（底图 image 是 PNG dataURL）',
    d1.terrHref.startsWith('data:image/png') && d1.terrHref.length > 20000, { href: d1.terrHref.length, png: d1.terrHref.slice(0, 22) });
  check('★1b 地图栏那行如实报数（块陆地·座岛·个湖·条河·种子）',
    /块陆地/.test(d1.note) && /座岛/.test(d1.note) && /个湖/.test(d1.note) && /条河/.test(d1.note) && /种子「测试甲」/.test(d1.note),
    { note: d1.note.slice(0, 130) });

  /* ⭐ 2 矢量层（混合方案的"另一半"）：岸线/河是**描边**，不是等高带 */
  check('★2 矢量层真画出来：海岸线是闭合路径、河流是折线',
    d1.coast >= 1 && d1.coastClosed && d1.river >= 1, { coast: d1.coast, closed: d1.coastClosed, rivers: d1.river });
  check('★2b 岸线不贴画布边缘（最外一圈是海 ⇒ 环才闭合，旧版会连出斜穿海面的线）',
    !!d1.coastBox && d1.coastBox.minX >= 6 && d1.coastBox.minY >= 6 && d1.coastBox.maxX <= 894 && d1.coastBox.maxY <= 494,
    { box: d1.coastBox });
  check('★2c 矢量层**不落盘**（只存参数：terrain.seed/style，lines 为空 —— 派生自同一份参数）',
    !!m1?.terrain && m1.terrain.seed === '测试甲' && !('coast' in (m1.terrain || {})) && (m1.lines || []).length === 0,
    { terrain: m1?.terrain, lines: (m1?.lines || []).length });

  /* ⭐ 3 提示行的数字与图上画出来的必须对得上（否则就是"数据在说一套、图在画另一套"） */
  const n1 = numsIn(d1.note);
  check('★3 岸线条数与提示行的陆块数对得上（同一块地走出两条环 = 这里红）',
    d1.coast >= 1 && d1.coast <= 4 && n1.lands >= 1 && d1.coast <= n1.lands + 4, { coast: d1.coast, lands: n1.lands });
  check('★3b 湖：提示行说几个，图上就有几条湖岸（早先参数报数、岸线却画不出来）',
    d1.lake === n1.lakes, { lakes: n1.lakes, lakePaths: d1.lake });

  /* ⭐ 4 同一颗种子永远同一张图；换一颗就换一张 */
  const sigA = await sig();
  await gen('continent', '测试甲');
  const sigB = await sig();
  await gen('continent', '测试乙');
  const sigC = await sig();
  check('★4 同种子逐字节一样 / 换种子不一样（确定性：可复现的地图）',
    sigA !== '' && sigA === sigB && sigA !== sigC, { same: sigA === sigB, differs: sigA !== sigC, len: sigA.length });

  /* ⭐ 5 面板里改档位 ⇒ 真按那一档生成（`#ms-style` 的 change 走同一条 planGeneration） */
  const okGen5 = await gen('archipelago', '测试丙');
  const d5 = await dom();
  const m5 = diskMap();
  check('★5 面板里选「群岛」⇒ 这一档真生效，种子也按填的存下来',
    okGen5 === true && m5?.terrain?.style === 'archipelago' && m5?.terrain?.seed === '测试丙' && d5.note.includes('种子「测试丙」'),
    { style: m5?.terrain?.style, seed: m5?.terrain?.seed, note: d5.note.slice(0, 110) });
  check('★5b 同一档同一颗种子再采用一次 ⇒ 一模一样（换种子才换图）',
    (await sig()) === (await sig()), {});

  /* ⭐ 6 数量也听（收敛回路）：填「陆地 2」⇒ 提示行报 2 块陆地，岸线条数跟着在 2~6 之间 */
  await gen('continent', '测试丁', { 'ms-lands': 2 });
  const d6 = await dom();
  const n6 = numsIn(d6.note);
  check('★6 面板里填「陆地 2」⇒ 提示行就报 2 块陆地，岸线条数也跟着在 2~6 之间',
    n6.lands === 2 && d6.coast >= 2 && d6.coast <= 6, { lands: n6.lands, coast: d6.coast, note: d6.note.slice(0, 90) });

  /* 生成这一段查完了：把面板收起来，后面的手绘 / 助手那两条在**干净的主区**上做 */
  await ev(`(function () { const b = document.getElementById('ms-close'); if (b) b.click(); return true; })()`);
  await sleep(300);

  /* ⭐ 7 「生成作底稿、手绘精修」：生成完照样能拖拽画区域（文化分区 = 动手层） */
  const before = (diskMap()?.regions || []).length;
  await ev(`document.querySelector('.map-mode[data-mode="region"]').click(); true`);
  await sleep(200);
  const drew = await ev(`(function () {
    const svg = document.getElementById('map-svg');
    const r = svg.getBoundingClientRect();
    const pt = (t, x, y, btn) => new PointerEvent(t, { clientX: r.left + x, clientY: r.top + y, button: btn ?? 0, buttons: btn === undefined ? 1 : 0, bubbles: true });
    svg.dispatchEvent(pt('pointerdown', 40, 40));
    window.dispatchEvent(pt('pointermove', 120, 60));
    window.dispatchEvent(pt('pointermove', 90, 130));
    window.dispatchEvent(pt('pointerup', 90, 130, 0));
    return true;
  })()`);
  await sleep(900);
  const m7 = diskMap();
  const drawn = (m7?.regions || []).filter((r) => /^区域 \d+$/.test(r.name));
  const d7 = await dom();
  check('★7 生成之后手绘照样能用：拖一笔就多一个「区域 N」（生成物不锁死）',
    drew === true && (m7?.regions || []).length === before + 1 && drawn.length === 1,
    { before, after: m7?.regions?.length, drawn: drawn.map((r) => r.name) });
  check('★7b 层序：文化分区在**岸线之下**（色块盖住底图，但岸线压在最上面才清晰）',
    d7.order.region >= 0 && d7.order.coast >= 0 && d7.order.region < d7.order.coast, { order: d7.order });

  /* ⭐ 8 助手的入口（用户第二条：「向助手描述然后生成」）：
     ⚠️ 这一步图上已经有地形 ⇒ 哪怕权限是「直接执行」也必须出卡片 */
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
  await sleep(600);
  await ev(`(function () {
    const el = document.getElementById('lk-agent-mode-agent'); if (el) el.click();
    const sc = document.getElementById('lk-agent-scope'); if (sc) { sc.value = 'workspace'; sc.dispatchEvent(new Event('change', { bubbles: true })); }
    const ak = document.getElementById('lk-agent-ask'); if (ak) { ak.value = 'never'; ak.dispatchEvent(new Event('change', { bubbles: true })); }
    return true;
  })()`);
  await sleep(200);
  await setMock(['{"tool":"generate_map","args":{"description":"盘古式超级大陆，两条大河"}}', '画好了。']);
  const sigBefore8 = await sig();
  await ask('帮我画一张地图：盘古式超级大陆，两条大河。');
  const card = await ev(`(function () {
    const c = document.querySelector('#lk-agent-msgs .lk-agent__prop');
    return { has: !!c, title: c ? (c.querySelector('.lk-agent__prop-t') || c).textContent : '', isSettled: c ? c.classList.contains('is-settled') : false };
  })()`);
  check('★8 图上已有地形时，助手的 generate_map 一定出提议卡片（「直接执行」档也不例外）',
    card.has === true && card.isSettled === false && (await sig()) === sigBefore8,
    { card: card.title.slice(0, 90), unchangedBeforeApply: (await sig()) === sigBefore8 });

  const applied = await ev(`(function () { const b = document.querySelector('#lk-agent-msgs [data-prop-ok]'); if (!b) return null; b.click(); return true; })()`);
  await sleep(1400);
  const m8 = diskMap();
  const tool8 = await ev(`(function () { const t = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__tool')]; return t.length ? t[t.length - 1].textContent : ''; })()`);
  const d8 = await dom();
  check('★8b 点「应用」才真换掉：档位变盘古、种子是那句描述、回执点名生成、矢量层跟着换',
    applied === true && m8?.terrain?.style === 'pangaea' && m8?.terrain?.seed === '盘古式超级大陆，两条大河'
      && tool8.includes('生成地形') && d8.coast >= 1 && d8.terrHref.startsWith('data:image/png'),
    { style: m8?.terrain?.style, seed: m8?.terrain?.seed, coast: d8.coast, tool: tool8.slice(0, 100) });

  const errs = await ev(`window.__errs || []`);
  check('★9 全程无未捕获异常', Array.isArray(errs) && errs.length === 0, { errs });

  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} PASS`);
  process.exit(pass === results.length ? 0 : 2);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack || e)); process.exit(2); });
