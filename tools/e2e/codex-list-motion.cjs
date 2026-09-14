/* 不变量：**左树的增删改重排都要"演"出来，而不是硬切换**（用户 2026-09-13 原话：
 * 「新建实体和节点时不是硬切换，而是从左侧滑入（就像正文的入场一样），其下的所有节点都向下平滑移动
 *  （删除时也一样），展开文件夹时文件向下弹出」）。
 *
 * 为什么必须自己量（不能只看"有没有动画"）：左树每次重画都是 `innerHTML` 整块换掉 ⇒ 元素是**新建**的，
 * CSS transition 表达不了"从旧位置滑到新位置"。`src/ui/motion.ts` 里那三个原语各管一件事：
 *   · `rowSlideIn`  → 新出现的行：`translateX(-24px)/opacity 0` → `none/1`（从**左侧**滑入，逐行错峰 30ms）
 *   · `flipRows`    → 其余那些位置变了的行：`translateY(旧-新)` → `none`（向下让位 / 向上补位）
 *   · `rowsDropIn`  → 展开文件夹露出来的行：`translateY(-8px)/0` → `none/1`（向下弹出，错峰 22ms）
 * 删除时被删的那一行还会留一个 `position:fixed` 的**幽灵**在原位演退场（`#cx-list` 马上会被清空，
 * 所以幽灵挂在 `document.body` 上，演完自己摘掉）。
 *
 * 用法：先 `node tools/e2e/reset-entity-vault.cjs && node tools/e2e/seed-node.cjs`，起应用，再跑本脚本。
 * ⚠️ 本套件会**建 3 个实体、删 1 个**（落到 vault 里）⇒ 重跑请重新播种并重启实例。
 */
const PORT = process.env.LK_CDP_PORT || '9334';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }

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
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  const waitFor = async (fn, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(120); }
    return false;
  };
  /* 隐藏窗口里动画不推进（README 铁律 6）—— 要真的跑一遍事件循环就得出帧 */
  const forceFrames = async (n = 3) => { for (let i = 0; i < n; i++) await send('Page.captureScreenshot', { format: 'jpeg', quality: 10 }); };

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  /* 页面内的读数工具：把某个元素身上的 WAAPI 动画读成「关键帧 + 延迟 + 时长」。
     ⚠️ 动画只在**点下去那个 tick** 里抓得到（`autoRelease` 会在 dur+800ms 后取消）⇒
     点击与读数必须写在**同一个 eval** 里。 */
  await ev(`window.__anim = (el) => {
    if (!el || !el.getAnimations) return [];
    return el.getAnimations().map((a) => {
      const k = a.effect.getKeyframes(); const t = a.effect.getTiming();
      return { from: (k[0] && (k[0].transform || '') + '/' + (k[0].opacity ?? '')) || '',
               to: (k[k.length - 1] && (k[k.length - 1].transform || '') + '/' + (k[k.length - 1].opacity ?? '')) || '',
               delay: t.delay, dur: t.duration, fill: t.fill };
    });
  };
  window.__rows = () => [...document.querySelectorAll('#cx-list .ed-tnode-item')];
  true`);

  /* 起点自足：这个 fixture 里可能有上一次跑出来的「新实体 2」之类残留（文件为源 ⇒ 会回扫回来），
     所以断言都用"相对变化"，不写死条数。 */
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  const ready = await waitFor(() => ev(`!!document.querySelector('#cx-list .ed-tnode-item')`), 8000);
  /* 等工具打开那一次错峰收手（否则它的行内延迟会污染这一套的读数） */
  await waitFor(() => ev(`(() => { const r = document.querySelector('#cx-root');
    return !!r && !r.classList.contains('lk-enter-stagger') && [...r.children].every((c) => !c.style.animationDelay); })()`), 8000);
  await forceFrames(3);
  const base = await ev(`window.__rows().length`);
  check('★0 前置：工作台打开、左树里有实体行（这一套要拿它们做增删）', !!ready && base >= 1, { rows: base, base });

  /* ── ★1/★2 新建 3 个实体：新行从左侧滑入 + 其余行向下让位（FLIP）──────────── */
  const t1 = await ev(`(() => {
    const before = window.__rows().map((e) => e.getAttribute('data-cx-key'));
    const n = document.querySelector('#cx-new-count'); if (n) n.value = '3';
    document.querySelector('#cx-new').click();
    const rows = window.__rows();
    const born = rows.filter((e) => !before.includes(e.getAttribute('data-cx-key')));
    const kept = rows.filter((e) => before.includes(e.getAttribute('data-cx-key')));
    return { born: born.map((e) => ({ key: e.getAttribute('data-cx-key'), a: window.__anim(e) })),
      kept: kept.map((e) => ({ key: e.getAttribute('data-cx-key'), a: window.__anim(e) })).filter((x) => x.a.length),
      total: rows.length };
  })()`);
  const slide = (t1.born ?? []).map((b) => b.a[0]).filter(Boolean);
  check('★1 新建出来的那几行**从左侧滑入**（translateX(-24px) → 原位 + 渐显），不是硬出现',
    slide.length >= 2 && slide.every((a) => a.from === 'translateX(-24px)/0' && a.to === 'none/1'),
    { born: t1.born.map((b) => ({ key: b.key, a: b.a })) });
  check('★1b 这一批新行**逐行错峰**（一行比一行晚 30ms，不是一坨同时冒出来）',
    slide.length >= 2 && slide[0].delay === 0 && slide[1].delay === 30,
    { delays: slide.map((a) => a.delay) });
  const flips = (t1.kept ?? []).map((k) => k.a[0]).filter(Boolean);
  /* 方向不写死：新行插在这一行**上面**就是向下让位、插在下面就是向上让位 —— 两种都对。
     不变量是"它从**旧位置**起步滑到新位置"，而不是"一定往下"。 */
  check('★2 其下的行**平滑让位**（FLIP：从旧位置 translateY(±) 滑到新位置），不是啪地跳过去',
    flips.length >= 1 && flips.every((a) => /^translateY\(-?[0-9.]+px\)\/$/.test(a.from) && a.to === 'none/' && a.dur === 320),
    { kept: t1.kept.map((k) => ({ key: k.key, a: k.a })) });

  /* ── ★3/★4 展开 / 收起文件夹：露出来的行向下弹出，下面/上面的行让位 ─────────
     ⚠️ 用**种类**那一层（事件）收起再展开：它下面还挂着 `_設定` 与各类型，
     实体行的位置会真的变（用最后一枝「种族」的话它下面啥都没有，量不到让位）。 */
  const t2 = await ev(`(() => {
    const kind = () => [...document.querySelectorAll('#cx-list .ed-tkind')].find((e) => e.textContent.includes('事件'));
    const type = () => [...document.querySelectorAll('#cx-list .ed-tset-type')].find((e) => e.textContent.includes('角色'));
    const grab = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.getAnimations().length)
      .map((e) => ({ key: e.getAttribute('data-cx-key'), a: window.__anim(e) }));
    kind().click();                                   /* 收起「事件」⇒ 节点行消失，下面的行上移 */
    const close1 = grab('#cx-list .ed-tnode-item');
    kind().click();                                   /* 再展开 ⇒ 节点行向下弹出，下面的行下移 */
    const open1 = grab('#cx-list .ed-tnode-item');
    type().click();                                   /* 收起「角色」 */
    const close2 = grab('#cx-list .ed-tnode-item');
    const shown = [];                                 /* 展开「角色」⇒ 里面那些实体行弹出来 */
    type().click();
    for (const e of document.querySelectorAll('#cx-list .ed-tnode-item')) {
      const a = window.__anim(e); if (a.length) shown.push({ key: e.getAttribute('data-cx-key'), a });
    }
    return { close1, open1, close2, shown };
  })()`);
  const drop = (t2.shown ?? []).map((s) => s.a[0]).filter(Boolean);
  check('★3 展开「角色」文件夹：被展开出来的行**向下弹出**（translateY(-8px) → 原位 + 渐显）',
    drop.length >= 2 && drop.every((a) => a.from === 'translateY(-8px)/0' && a.to === 'none/1'),
    { shown: t2.shown });
  check('★3b 弹出来的行也逐行错峰（22ms 一档）', drop.length >= 2 && drop[1].delay === 22, { delays: drop.map((a) => a.delay) });
  check('★4 收起种类时，下面那些行**向上补位**（同一套 FLIP，方向与展开相反）',
    (t2.close1 ?? []).length >= 1 && t2.close1.every((x) => /^translateY\([0-9.]+px\)\/$/.test(x.a[0].from)),
    { close1: t2.close1 });
  check('★4b 再展开时它们**向下让位**（负位移起步），展开露出来的那一行同时下弹',
    (t2.open1 ?? []).length >= 1 && t2.open1.some((x) => /^translateY\(-[0-9.]+px\)\/$/.test(x.a[0].from))
      && t2.open1.some((x) => x.a[0].from === 'translateY(-8px)/0'),
    { open1: t2.open1 });

  /* ── ★4c 收起时**里面那些行不是"啪"地消失** ─────────────────────────────
     用户 2026-09-14：「设定文件夹收起时无动画，收起时下面的文件直接消失」，
     随后又定：「**文件出场动画改成入场的反向就行了**」。
     收起 = 这一枝的行会被 `innerHTML` 整块换掉（元素是**当场没的**，没有旧位置可演），
     所以退场只能演在**克隆出来的幽灵层**上：`ghostRows()` 把它们钉在原位，
     `rowsLeaveAndRemove()` 播完再摘掉（与删除时的幽灵同一套，只是 z-index 860）。
     退场姿势 = **展开入场 `rowsDropIn` 的倒放**（从上方 -8px 落下来 ⇒ 往上方 -8px 升走，
     `none/1 → translateY(-8px)/0`，260ms、错峰 22ms、曲线也倒过来 = 慢→快）。
     ★4c2 因此**直接拿 ★4b 记下来的入场关键帧来比**（出场的终点 = 入场的起点、出场的起点 = 入场的终点），
     而不是各写各的字面量 —— 这样"两边必须互为反向"是被断言的，不是靠注释。 */
  const t4c = await ev(`(() => {
    const nodeRows = () => [...document.querySelectorAll('#cx-list .ed-tnode-item[data-act="node"]')];
    const kind = () => [...document.querySelectorAll('#cx-list .ed-tkind')].find((e) => e.textContent.includes('事件'));
    const before = nodeRows().length;
    /* ⚠️ 幽灵必须**长在原位**：树里那些缩进是各层类的 padding-left（条目 36px / 种类 27px / 时间线 18px）。
       克隆时若把它清零，整行内容会当场**往左跳**几十像素（用户 2026-09-14：「收起文件时文件会先向左移」）。 */
    const geoBefore = nodeRows().map((e) => ({ padL: getComputedStyle(e).paddingLeft, left: Math.round(e.getBoundingClientRect().left) }));
    /* ⚠️ 只认**这一次点击刚造出来**的幽灵：同一时刻页面上可能还挂着上一批（收起 A 没演完又收起 B，
       兜底定时器要 680ms 才摘），按数量直接数会数进别人的。 */
    const pre = new Set([...document.body.children]);
    kind().click();                                   /* 收起「事件」 */
    const ghosts = [...document.body.children].filter((e) => !pre.has(e) && e.classList.contains('lk-list-ghost'));
    /* 「事件」这一枝下面还挂着 _設定 那一大枝 ⇒ 它们要**等退场走完**才往上补位
       （★4f：用户 2026-09-14「应该是文件先消失，下面的文件夹再移上来，现在反了」）。 */
    const below = [...document.querySelectorAll('#cx-list [data-cx-key]')]
      .map((e) => ({ key: e.getAttribute('data-cx-key'), a: window.__anim(e) })).filter((x) => x.a.length);
    /* 再收起**行数最多**的那一枝（_設定：5 个类型 + 里面的实体）来量错峰的**顺序与总量** ——
       「事件」底下只有 1~2 行，量不出"一行比一行晚"。（测完由调用方展开回来。） */
    const setRow = [...document.querySelectorAll('#cx-list .ed-tset')][0];
    const pre2 = new Set([...document.body.children]);
    if (setRow) setRow.click();
    const big = [...document.body.children].filter((e) => !pre2.has(e) && e.classList.contains('lk-list-ghost'));
    return { before, ghosts: ghosts.length,
      ghostText: ghosts.map((g) => (g.textContent || '').trim().slice(0, 12)),
      ghostAnim: ghosts.map((g) => window.__anim(g)),
      geoBefore,
      geoGhost: ghosts.map((g) => ({ padL: getComputedStyle(g).paddingLeft, left: Math.round(g.getBoundingClientRect().left) })),
      bigDelays: big.map((g) => { const a = window.__anim(g)[0]; return a ? a.delay : -1; }),
      bigPad: big.map((g) => getComputedStyle(g).paddingLeft),
      bigCount: big.length,
      below,
      rowsLeft: nodeRows().length };
  })()`);
  check('★4c 收起「事件」文件夹：里面那些行变成**钉在原位的幽灵**演退场，不是直接消失',
    t4c.before >= 1 && t4c.ghosts === t4c.before && t4c.rowsLeft === 0
      && t4c.ghostText.every((t) => t.startsWith('王国的建立'))
      && t4c.ghostAnim.every((a) => a.length === 1),
    t4c);
  /* ★4d 幽灵不许"往左跳"：缩进（padding-left）与水平位置都得跟原行一模一样。
     用户 2026-09-14 第二轮：「收起文件时文件会**先向左移**，然后再上隐」—— 真因是克隆体上写了 `padding:0`，
     把各层类的缩进（世界 8px / 时间线 18px / 种类 27px / 条目 36px）当场清零。 */
  check('★4d 幽灵**长在原位**：缩进与水平位置跟原行逐项相同（不往左跳）',
    t4c.geoGhost.length >= 1 && t4c.geoGhost.length === t4c.geoBefore.length
      && t4c.geoGhost.every((g, i) => g.padL === t4c.geoBefore[i].padL && g.left === t4c.geoBefore[i].left)
      && parseFloat(t4c.geoGhost[0].padL) > 0 && t4c.bigPad.every((p) => parseFloat(p) > 0),
    { geoBefore: t4c.geoBefore, geoGhost: t4c.geoGhost, bigPad: t4c.bigPad });
  /* ★4e 退场错峰的**顺序与入场一致**（从上往下一行行走，不是倒着播），而且总量有上限 ——
     第一版用了 `[...ghosts].reverse()` 且不限量：44 行时第一行要等 946ms 才动，看着就是"卡住然后整片消失"
     （用户：「没有像入场一样的错分」）。 */
  const gDelays = t4c.bigDelays ?? [];
  check('★4e 退场错峰与入场同序（0/22/44…，按 DOM 从上往下）且总量 ≤240ms',
    gDelays.length >= 4 && gDelays[0] === 0 && gDelays[1] === 22
      && gDelays.every((d, i) => d >= 0 && (i === 0 || d >= gDelays[i - 1]))
      && Math.max(...gDelays) <= 240,
    { delays: gDelays, bigCount: t4c.bigCount });
  /* ★4f 顺序：**里面的文件先消失，下面的行再移上来**（不是同时）。
     用户 2026-09-14：「应该是文件先消失，下面的文件夹再移上来，现在反了，下面的移上来后文件再消失」。
     做法 = 把这一次重画的 FLIP 推迟"退场总时长"这么多毫秒，且必须 `fill:'both'`
     （延迟期间冻在旧位置上；`fill:'none'` 的话那一行会先瞬移到新位置、等延迟过完再跳回旧位置演一遍）。
     ★4f 自己算"退场总时长"（这一枝幽灵里最晚的 delay + 单行时长），再去比下面那些行的 FLIP 延迟 ——
     两边都是量出来的，不写死数字。 */
  const c1Delays = (t4c.ghostAnim ?? []).map((a) => a[0]?.delay ?? 0);
  const c1Dur = t4c.ghostAnim?.[0]?.[0]?.dur ?? 0;
  const c1Total = c1Delays.length ? Math.max(...c1Delays) + c1Dur : 0;
  const below = t4c.below ?? [];
  check('★4f 收起时"下面的行补位"**等这一枝退场走完**（FLIP delay = 退场总时长，fill:both 冻在旧位置）',
    below.length >= 1 && c1Total > 0
      && below.every((x) => x.a[0].delay === c1Total && x.a[0].fill === 'both'
        && /^translateY\([0-9.]+px\)\/$/.test(x.a[0].from)),
    { exitTotal: c1Total, exitDelays: c1Delays, below: below.map((x) => ({ key: x.key, a: x.a[0] })) });
  /* ⚠️ `open1` 里混着两类动画：**展开露出来的行**（下弹，`translateY(-8px)/0 → none/1`）与
     **让位的行**（FLIP，`translateY(±)/  → none/`）。只拿前者来比，不然 FLIP 的位移会把交叉断言搅黄。 */
  const inFrom = (t2.open1 ?? []).map((x) => x.a[0]).filter((a) => a && a.to === 'none/1').map((a) => a.from);
  const inTo = (t2.open1 ?? []).map((x) => x.a[0]).filter((a) => a && a.from === 'translateY(-8px)/0').map((a) => a.to);
  check('★4c2 幽灵演的是**入场（向下弹出）的倒放**：none/1 → translateY(-8px)/0，260ms',
    t4c.ghostAnim.length >= 1
      && inFrom.length >= 1
      && t4c.ghostAnim.every((a) => a[0].from === 'none/1' && a[0].to === 'translateY(-8px)/0' && a[0].dur === 260)
      /* 逐项互为反向：出场的终点 = 入场的起点（-8px/0）、出场的起点 = 入场的终点（none/1） */
      && inFrom.every((f) => t4c.ghostAnim.every((a) => a[0].to === f))
      && inTo.every((t) => t4c.ghostAnim.every((a) => a[0].from === t)),
    { ghostAnim: t4c.ghostAnim, inFrom, inTo });
  const ghostGone = await waitFor(() => ev(`[...document.body.children].filter((e) => e.style.zIndex === '860').length === 0`), 3000);
  check('★4c3 退场演完幽灵自己摘掉（不留一个看不见的浮层压在页面上）', ghostGone);
  await ev(`(() => {
    const k = [...document.querySelectorAll('#cx-list .ed-tkind')].find((e) => e.textContent.includes('事件')); if (k) k.click();
    const s = [...document.querySelectorAll('#cx-list .ed-tset')][0]; if (s) s.click();   /* _設定 也展开回来（★5 要点里面的实体行） */
    return true; })()`);
  await sleep(400); await forceFrames(2);

  /* ── ★5 删除：被删的那一行留一个钉在原位的幽灵演退场 + 下面的行补位 ──────── */
  await ev(`document.querySelectorAll('#cx-list [data-cx-id]')[0].click(); true`);
  await sleep(600); await forceFrames(2);
  const victim = await ev(`(() => { const r = document.querySelectorAll('#cx-list [data-cx-id]')[0];
    return r ? { key: r.getAttribute('data-cx-key'), name: (r.querySelector('.ed-tlabel') || {}).textContent || '' } : null; })()`);
  const rowsBefore = await ev(`(() => { const n = window.__rows().length; document.querySelector('#cx-del').click(); return n; })()`);
  await sleep(150);
  const confirmed = await ev(`(() => {
    const b = [...document.querySelectorAll('.lk-pop-in button')].find((x) => (x.textContent || '').trim() === '删除');
    if (!b) return false; b.click(); return true;
  })()`);
  await sleep(150);
  const t5 = await ev(`(() => {
    const ghosts = [...document.body.children].filter((e) => e.style.position === 'fixed' && e.style.zIndex === '900');
    return { ghosts: ghosts.length, ghostText: ghosts.map((g) => (g.textContent || '').trim().slice(0, 10)),
      ghostAnim: ghosts.map((g) => window.__anim(g)),
      flip: window.__rows().filter((e) => e.getAnimations().length).map((e) => ({ key: e.getAttribute('data-cx-key'), a: window.__anim(e) })),
      rows: window.__rows().length };
  })()`);
  check('★5 删除确认后，被删的那一行留了一个**钉在原位**的幽灵在演退场（它自己已经被移出列表了）',
    confirmed && t5.ghosts === 1 && !!victim && t5.ghostText[0].startsWith(victim.name),
    { confirmed, victim, ghosts: t5.ghosts, ghostText: t5.ghostText });
  check('★5b 幽灵演的是「往左退场」（none/1 → translateX(-24px)/0，慢→快）',
    (t5.ghostAnim[0] ?? []).length === 1 && t5.ghostAnim[0][0].from === 'none/1' && t5.ghostAnim[0][0].to === 'translateX(-24px)/0',
    { ghostAnim: t5.ghostAnim });
  check('★5c 同时下面的行平滑补位（FLIP 向上），行数 -1',
    t5.rows === rowsBefore - 1 && t5.flip.length >= 1 && t5.flip.every((x) => /^translateY\([0-9.]+px\)\/$/.test(x.a[0].from)),
    { rows: t5.rows, rowsBefore, flip: t5.flip.map((x) => x.key) });
  const gone = await waitFor(() => ev(`[...document.body.children].filter((e) => e.style.zIndex === '900').length === 0`), 3000);
  check('★5d 幽灵演完自己摘掉（不留一个看不见的浮层压在页面上）', gone);

  /* ── ★6 减少动效：系统偏好「减少动态效果」时这一套整段跳过 ─────────────── */
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(200);
  const t6 = await ev(`(() => {
    const rows0 = window.__rows().length;
    const n = document.querySelector('#cx-new-count'); if (n) n.value = '2';
    document.querySelector('#cx-new').click();
    const born = window.__rows().filter((e) => e.getAnimations().length);
    return { animated: born.length, rows: window.__rows().length, rows0 };
  })()`);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  check('★6 系统「减少动态效果」时新建照样完成，但**不演任何动画**（偏好优先于观感）',
    t6.rows === t6.rows0 + 2 && t6.animated === 0, t6);

  const errs = await ev(`window.__errs || []`);
  check('★7 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  /* 收尾：把这一轮建出来的那几个删掉，别把测试数据留成"看起来像用户数据"的样子 */
  const left = await ev(`window.__rows().filter((e) => (e.querySelector('.ed-tlabel') || {}).textContent.startsWith('新实体')).length`);
  console.log(`（本轮建了 5 个占位实体，还剩 ${left} 个 —— 重跑本套件请先重新播种）`);

  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} PASS`);
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.message)); process.exit(1); });
