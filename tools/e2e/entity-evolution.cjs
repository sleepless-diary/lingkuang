/* 不变量：**设定库右侧那条「演变」竖线 + 版本帧**
 *  （用户 2026-09-13：「我想在设定库右侧加一条竖着的等距的时间线，用来储存不同节点，
 *   当选中实例时，默认进入离当前指针最近的 git」+「都做吧，把模式放到设置里面」）。
 *
 * 这条套件钉住的五件事：
 *   ① 右栏是**等距**的格子（每格 = 一个有版本的事件节点，顶上第一格 = 初稿），选格即换版本；
 *      ⚠️ 2026-09-13 上午用户改口：「**我希望没有版本的节点就不显示**」⇒ 帧条只列有版本的节点，
 *      建版本的入口变成底部那个「记到 [事件 ▾] + ＋记一帧」（帧条上再也点不到空格子）。
 *   ② 三种模式真的不一样：**手动**改的是"你现在看的那一版"（不产生历史）；
 *      **自动**把改动记到「记到」那个事件上（它没有版本就先建一版）；**锁定**永远记到锁定的那一格；
 *   ③ 一帧只存**与上一帧的区别**（字段与正文都按行），且初稿（.md 的 frontmatter）不被改写；
 *   ④ 换一条实体不串台；帧写进 .md 的 `#演变：` 段，冷启动后还在（文件是源）；
 *   ⑤ 面板不该出现"没什么可滚却挂着滚动条"（用户 2026-09-13 上午：「默认创建了一个滚动条，去掉吧」，
 *      实测 1440×900 下内容比可用高度多 3px —— 见 src/ui/codex.ts 的「高度预算」注释）。
 *
 * 用法：`node tools/e2e/seed-evolution.cjs` → 起应用 → `node tools/e2e/entity-evolution.cjs`
 * ⚠️ 会改测试数据（新增帧）。重跑请重新播种并重启实例。
 * ⚠️ **已知偶发**（2026-09-13，约 2/10 次）：★5/★5b/★10d/★14b 会一起挂 —— 逐 150ms 采样可见
 *   「中栏 t+0/150/300 = 19、t+450 变回 17，而 .md 从头到尾没拿到 19」＝ **内存里的改动被一次
 *   旧快照回扫盖掉了**（不是本套件的问题、也不是虚化块引起的：同场景的独立探针 3/3 通过）。
 *   机制与调查见 `docs/BUGS.md` 第二十一轮「七」；重跑前请重新播种 + 重启实例，别拿脏目录复跑。
 */
const fs = require('fs');
const path = require('path');
const VAULT = process.env.LINGKUANG_VAULT;
const PORT = process.env.LK_CDP_PORT || '9334';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const ENT = (type, name) => path.join(VAULT, '测试世界观', '_设定', type, name + '.md');
/** 从 .md 里抠出 `#演变：` 段的 JSON（没有就是 null） */
function mdFrames(text) {
  const i = text.indexOf('#演变：');
  if (i === -1) return null;
  const m = text.slice(i).match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) return 'BROKEN';
  try { return JSON.parse(m[1]); } catch { return 'BAD_JSON'; }
}
const fmValue = (text, key) => {
  const m = text.match(new RegExp('^' + key + ': (.*)$', 'm'));
  return m ? m[1].trim() : null;
};

/* 字段行选择器片段：**必须模板插值**（`${FIELD('发色')}`），不能当函数调用（README 铁律） */
const FIELDEL = (k) => `[...document.querySelectorAll('#cx-fields > div')].find((r) => r.firstElementChild?.textContent === ${JSON.stringify(k)})?.querySelector('input,textarea,select')`;
const FIELD = (k) => `${FIELDEL(k)}?.value`;
const fieldVal = async (ev, k) => ev(FIELD(k));
const setField = (k, v) => `(() => { const el = ${FIELDEL(k)}; if (!el) return 'no field'; el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`;

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
  /** 隐藏窗口里动画/定时器不推进 —— 要真的跑一遍事件循环就得出帧（README 铁律 6） */
  const forceFrames = async (n = 3) => {
    for (let i = 0; i < n; i++) await send('Page.captureScreenshot', { format: 'jpeg', quality: 10 });
  };

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  /* ── 起点必须自足：设置存在 localStorage 里，而 ★12 会把模式改成「锁定」且从不复位 ⇒
     同一个 userdata 跑第二遍时开局就不是手动模式（README 铁律 2 / SKILL seed-must-be-self-contained）。
     在**打开工具之前**复位，保证「改动落到哪一版」这条主线从头到尾确定。 ── */
  await ev(`(() => { const s = JSON.parse(localStorage.getItem('lingkuang-settings') || '{}');
    s.evolveMode = 'manual'; s.evolveLock = null;
    localStorage.setItem('lingkuang-settings', JSON.stringify(s));
    window.dispatchEvent(new CustomEvent('lingkuang-settings')); return s.evolveMode; })()`);
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  /* 等工具打开那一次错峰收手（否则后面点格子的判断会被上一次的行内延迟污染） */
  const clean = `(() => { const r = document.querySelector('#cx-root');
    return !!r && !r.classList.contains('lk-enter-stagger') && [...r.children].every((c) => !c.style.animationDelay); })()`;
  await waitFor(() => ev(clean), 8000);
  await forceFrames(3);

  /* ── 工具：选实体 / 读帧条 / 点格子 / 改模式 ───────────────────────── */
  const MD_A = ENT('角色', '银发少女');
  const MD_B = ENT('物品', '霜纹剑');
  const pickEntity = (name) => ev(`(() => {
    const b = [...document.querySelectorAll('[data-cx-id]')].find((x) => x.children[0]?.textContent === ${JSON.stringify(name)});
    if (!b) return 'no row';
    b.click(); return 'ok';
  })()`);
  /** 帧条：每格 { id, t, n, on, frame, ghost, anchor, write } + 底部按钮/提示 + 展开行文字 */
  const rail = () => ev(`(() => {
    const rows = [...document.querySelectorAll('#cx-rail .lk-rail__row')].map((r) => ({
      id: r.dataset.rail || '', on: r.classList.contains('is-on'), frame: r.classList.contains('is-frame'),
      ghost: r.classList.contains('is-ghost'), anchor: r.classList.contains('is-anchor'),
      /* 写目标（用户 2026-09-13：「切换帧时直接高亮要写到的地方」）：亮的那一格 + 「改这里」标签 */
      write: r.classList.contains('is-write'),
      wtag: !!r.querySelector('.lk-rail__tag--write'),
      t: (r.querySelector('.lk-rail__t') || {}).textContent || '', n: (r.querySelector('.lk-rail__n') || {}).textContent || '',
      s: (r.querySelector('.lk-rail__s') || {}).textContent || '',
    }));
    const add = document.querySelector('[data-rail-add]');
    const del = document.querySelector('[data-rail-del]');
    const more = document.querySelector('.lk-rail__more');
    return { n: rows.length, rows, add: add ? add.dataset.railAdd : null, del: del ? del.dataset.railDel : null,
      more: more ? more.textContent.trim() : null,
      mode: (document.querySelector('.lk-rail__mode') || {}).textContent || '',
      hints: [...document.querySelectorAll('.lk-rail__hint')].map((h) => h.textContent).filter(Boolean) };
  })()`);
  const clickRow = (idx) => ev(`(() => {
    const rows = [...document.querySelectorAll('#cx-rail .lk-rail__row')];
    const r = rows[${idx}];
    if (!r) return 'no row ' + ${idx};
    r.click(); return 'ok';
  })()`);
  const clickAdd = () => ev(`(() => { const b = document.querySelector('[data-rail-add]'); if (!b) return 'no button'; b.click(); return 'ok'; })()`);
  /* 「记到」下拉：帧条只列有版本的节点之后，这是**唯一**指定"新版本记在哪个事件上"的入口 */
  const anchorInfo = () => ev(`(() => { const s = document.querySelector('#cx-anchor');
    return s ? { val: s.value, opts: [...s.options].map((o) => o.value), labels: [...s.options].map((o) => o.textContent) } : null; })()`);
  const setAnchor = (nodeId) => ev(`(() => { const s = document.querySelector('#cx-anchor'); if (!s) return 'no select';
    s.value = ${JSON.stringify(nodeId)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
  /* ⚠️ 读 .md 必须**等它写下去**：store 变化后有 400ms 防抖（src/main.ts:417）再 IPC 写盘，
     固定 sleep 会压在边界上（第一版就是这么误报的：★3/★4/★7/★10c/★12b 全挂，其实都没问题）。 */
  const waitMd = (p, pred, ms = 6000) => waitFor(() => { try { return pred(read(p)); } catch { return false; } }, ms);
  /** "正在看：…" 那行小字（在 #cx-body 里，是正文那行的兄弟节点） */
  const versionNote = () => ev(`[...document.querySelectorAll('#cx-body > div')].map((d) => d.textContent || '').find((t) => t.startsWith('正在看')) || ''`);
  const setMode = (m) => ev(`(() => {
    const s = JSON.parse(localStorage.getItem('lingkuang-settings') || '{}');
    s.evolveMode = ${JSON.stringify(m)};
    localStorage.setItem('lingkuang-settings', JSON.stringify(s));
    window.dispatchEvent(new CustomEvent('lingkuang-settings'));
    return s.evolveMode;
  })()`);

  /* ── ★0 前置：帧条在、等距、没有版本的节点不列出来 ───────────────── */
  await pickEntity('银发少女');
  await sleep(500); await forceFrames(2);
  const r0 = await rail();
  check('★0 前置：一条版本都没有时，帧条上只有「初稿」那一格（没有版本的节点不列出来）',
    /* 名字后面可能跟着「改这里」标签（写目标高亮，见 ★15）⇒ 用 startsWith 比 */
    r0.n === 1 && r0.rows[0].n.startsWith('初稿'), { n: r0.n, rows: r0.rows.map((x) => x.t + '/' + x.n) });
  const a0 = await anchorInfo();
  check('★0b 「记到」下拉里三个事件节点都在（不列出来 ≠ 记不到），默认 = 离沙盘指针最近的那个事件',
    !!a0 && a0.opts.length === 3 && a0.opts.includes('n-evo-2') && a0.val === 'n-evo-3',
    a0 && { val: a0.val, label: a0.labels[a0.opts.indexOf(a0.val)], opts: a0.opts });
  const heights = await ev(`[...document.querySelectorAll('#cx-rail .lk-rail__row')].map((r) => Math.round(r.getBoundingClientRect().height))`);
  check('★0c 等距：每格高度相同（用户要的"等距时间线"，不按时间比例）', Array.isArray(heights) && new Set(heights).size === 1, heights);
  /* ★0d 面板的「外壳开销」要有预算。用户报「默认创建了一个滚动条」，实测（1440×900、真实数据
     11 字段 + 一篇正文）：`#cx-root` 内容 864px vs 可用 861px —— 只差 3px，于是**什么都没超出**
     却挂了一条滚动条。差的这 3px 来自"给一句空话预留的消息行 + 松掉的内边距/间距"。
     ⚠️ 不能断言"1440×900 下没有滚动条"：那取决于正文有多长（正文长了本来就该滚）。
     能断言的是**外壳开销**（标题行 + 页签行 + 内边距 + 间距 + 消息行 = 面板总高 − 三栏那一行）——
     它与内容长短、窗口大小都无关。修完实测 94px（1408×822）/ 112px（1424×861）；
     修之前是 155px（多出 27px 空消息行 + 16px 松内边距 + 差 3px 溢出），故上限取 130px。 */
  const budget = await ev(`(() => {
    const r = document.querySelector('#cx-root');
    const row = [...r.children].find((c) => c.querySelector('#cx-body'));
    const msg = document.querySelector('#cx-msg');
    return { chrome: Math.round(r.scrollHeight - row.getBoundingClientRect().height),
      msgDisplay: getComputedStyle(msg).display, msgH: msg.offsetHeight, win: [innerWidth, innerHeight] };
  })()`);
  check('★0d 面板外壳开销 ≤130px（用户那条"凭空出现的滚动条"就是这里多占了 27px 空行 + 16px 松内边距）',
    budget.chrome <= 130 && budget.msgDisplay === 'none' && budget.msgH === 0, budget);

  /* ══════════ ★0e~★0h 展开：把"还没版本的事件"虚化列出来 ══════════════
     用户 2026-09-13 下午原话：「我希望在右侧时间线加一个展开的功能，能展开未创建 git 的节点，
     但虚化显示」→ 随后补一句：「我那个展开时间线其实就是【记到】后面的下拉选框，
     不过和时间线一起显示，更直观一点」。
     所以这一段的语义是：**虚化行 = 下拉选框长在时间线上**，点它换「记到」，
     它没有版本可看 ⇒ **不动正在看的版本**。 */
  const ghostInfo = () => ev(`(() => {
    const rows = [...document.querySelectorAll('#cx-rail .lk-rail__row')];
    return { ghosts: rows.filter((r) => r.classList.contains('is-ghost')).map((r) => r.dataset.rail),
      ghostTexts: rows.filter((r) => r.classList.contains('is-ghost')).map((r) => (r.querySelector('.lk-rail__t') || {}).textContent),
      frames: rows.filter((r) => r.classList.contains('is-frame')).length,
      more: (document.querySelector('.lk-rail__more') || {}).textContent || null,
      opacity: rows.filter((r) => r.classList.contains('is-ghost')).map((r) => getComputedStyle(r).opacity) };
  })()`);
  const clickMore = () => ev(`(() => { const m = document.querySelector('.lk-rail__more'); if (!m) return 'no more row'; m.click(); return 'ok'; })()`);
  const clickGhost = (id) => ev(`(() => {
    const r = [...document.querySelectorAll('#cx-rail .lk-rail__row.is-ghost')].find((x) => x.dataset.rail === ${JSON.stringify(id)});
    if (!r) return 'no ghost row';
    r.click(); return 'ok';
  })()`);

  const g0 = await ghostInfo();
  check('★0e 默认收起：帧条上没有虚化行，底部写着「还有 N 个没版本」（上午那句"没有版本的不显示"没有被推翻）',
    g0.ghosts.length === 0 && /还有 3 个没版本/.test(g0.more || ''), g0);

  await clickMore();
  await sleep(300);
  const g1 = await ghostInfo();
  check('★0f 点展开 → 3 个没版本的事件**按时间**插进帧条（315/327/350），且都不是"有版本"的格子',
    g1.ghosts.length === 3 && g1.ghosts.join(',') === 'n-evo-1,n-evo-2,n-evo-3' && g1.frames === 0
      && JSON.stringify(g1.ghostTexts) === JSON.stringify(['315', '327', '350']),
    { ghosts: g1.ghosts, texts: g1.ghostTexts, frames: g1.frames, more: (g1.more || '').trim() });
  check('★0f2 虚化是**真的**虚化（整格半透明，不是只是换个颜色/点点）',
    g1.opacity.length === 3 && g1.opacity.every((o) => Number(o) < 0.6), g1.opacity);

  /* 点虚化行 = 换「记到」。先把锚点挪到 n-evo-1，再点 n-evo-3 那一行：
     这样既证明"点得动"，又让锚点**回到**原值 n-evo-3（后面 ★2 还要断言它）。 */
  const noteBefore = await versionNote();
  await setAnchor('n-evo-1');
  await sleep(200);
  await clickGhost('n-evo-3');
  await sleep(300);
  const aG = await anchorInfo();
  const gOn = await ev(`(() => { const r = [...document.querySelectorAll('#cx-rail .lk-rail__row')].find((x) => x.dataset.rail === 'n-evo-3');
    return { anchor: !!r && r.classList.contains('is-anchor'), tag: r ? (r.querySelector('.lk-rail__tag') || {}).textContent : null }; })()`);
  check('★0g 点虚化行 = 换「记到」（下拉跟着变），那一行标上「记到」',
    aG.val === 'n-evo-3' && gOn.anchor === true && gOn.tag === '记到', { val: aG.val, ...gOn });
  check('★0g2 点虚化行**不动正在看的版本**（它没有版本可看：版本行小字一字未变）',
    (await versionNote()) === noteBefore, { before: noteBefore, after: await versionNote() });

  await clickMore();
  await sleep(300);
  const g2 = await ghostInfo();
  check('★0h 再点一次收起：虚化行消失，锚点照旧（n-evo-3）',
    g2.ghosts.length === 0 && (await anchorInfo()).val === 'n-evo-3' && /展开全部事件/.test(g2.more || ''), g2);

  /* ── ★1 还没有版本时默认落在初稿 ─────────────────────────────────── */
  check('★1 一条版本都没有时，默认落在「初稿」那一格', r0.rows[0].on && (await versionNote()).includes('初稿'),
    { on: r0.rows.findIndex((x) => x.on), note: await versionNote() });

  /* ── ★2 没有版本的节点不上帧条，但能从「记到」下拉里选中它 ───────── */
  check('★2 默认站在初稿上，"记到"指向的是离指针最近的事件（n-evo-3）',
    (await anchorInfo())?.val === 'n-evo-3', await anchorInfo());
  const r2 = await rail();
  check('★2b 帧条上仍然只有初稿（没有版本的节点不显示）', r2.n === 1 && r2.rows[0].on && r2.hints.some((h) => h.includes('初稿')),
    { n: r2.n, on: r2.rows.findIndex((x) => x.on), hints: r2.hints });

  /* ── ★3 手动模式：改动落到"你现在看的那一版"（初稿），不产生历史 ── */
  await ev(setField('发色', '墨黑'));
  await waitMd(MD_A, (t) => fmValue(t, '发色') === '墨黑');
  let mdA = read(MD_A);
  check('★3 手动模式：站在初稿上改字段 → 改的是初稿（frontmatter 变），且**没有产生帧**',
    fmValue(mdA, '发色') === '墨黑' && mdFrames(mdA) === null,
    { 发色: fmValue(mdA, '发色'), frames: mdFrames(mdA) });

  /* ── ★4 选好「记到」再按 ＋：在这一格记一帧 ──────────────────────── */
  await setAnchor('n-evo-2');   /* 第一次魔潮：还没有版本 */
  await sleep(200);
  await clickAdd();
  await waitMd(MD_A, (t) => Array.isArray(mdFrames(t)) && mdFrames(t).length === 1);
  mdA = read(MD_A);
  const f4 = mdFrames(mdA);
  check('★4 「记到 第一次魔潮」+ 点「＋ 记一帧」→ .md 里出现 #演变： 段，帧锚在 n-evo-2 上',
    Array.isArray(f4) && f4.length === 1 && f4[0].nodeId === 'n-evo-2',
    { frames: Array.isArray(f4) ? f4.map((f) => ({ node: f.nodeId, patch: f.patch })) : f4 });
  const r4 = await rail();
  check('★4b 记完帧条多出一格（锚在第一次魔潮）、并跳到这一版上；底部同时给了「删掉这一帧」',
    r4.n === 2 && r4.rows[1].frame && r4.rows[1].on && r4.del === 'n-evo-2',
    { n: r4.n, rows: r4.rows.map((x) => x.t + '/' + x.n), on: r4.rows.findIndex((x) => x.on), del: r4.del });

  /* ── ★5 有版本之后改动落进那一帧，初稿不动 ───────────────────────── */
  await ev(setField('年龄', '19'));
  await waitMd(MD_A, (t) => mdFrames(t)?.[0]?.patch?.set?.年龄 === '19');
  mdA = read(MD_A);
  const f5 = mdFrames(mdA);
  check('★5 在这一帧上改字段 → 差异记进**这一帧的 patch**，初稿（frontmatter）不动',
    Array.isArray(f5) && f5[0]?.patch?.set?.年龄 === '19' && fmValue(mdA, '年龄') === '17',
    { patch: Array.isArray(f5) ? f5[0]?.patch : f5, fm年龄: fmValue(mdA, '年龄') });
  check('★5b 中栏显示的是"这一版"的值（19），不是初稿的 17', (await fieldVal(ev, '年龄')) === '19', await fieldVal(ev, '年龄'));

  /* ── ★6 切回初稿：同一格里看到的是另一版 ─────────────────────────── */
  await clickRow(0);
  await sleep(400); await forceFrames(2);
  check('★6 切回「初稿」那一格 → 值变回初稿（年龄 17），提示写明"正在看初稿"',
    (await fieldVal(ev, '年龄')) === '17' && (await versionNote()).includes('初稿'),
    { 年龄: await fieldVal(ev, '年龄'), note: await versionNote() });
  check('★6b 切回初稿时，发色仍是初稿里的墨黑（★3 改的就是初稿）', (await fieldVal(ev, '发色')) === '墨黑', await fieldVal(ev, '发色'));

  /* ── ★7 正文差异按行存：在某一版里改一行 ─────────────────────────── */
  await clickRow(1);   /* 第 1 格 = 第一次魔潮那一帧 */
  await sleep(400); await forceFrames(2);
  await ev(`(() => { const el = document.querySelector('#cx-doc .ProseMirror'); el.focus(); return true; })()`);
  await send('Input.insertText', { text: '【第一帧补写】' });
  await ev(`document.querySelector('#cx-doc .ProseMirror').blur(); true`);
  await waitMd(MD_A, (t) => (mdFrames(t)?.[0]?.patch?.doc?.hunks?.length ?? 0) > 0);
  mdA = read(MD_A);
  const f7 = mdFrames(mdA);
  const patch7 = Array.isArray(f7) ? f7[0]?.patch : null;
  const hunks = patch7?.doc?.hunks ?? [];
  check('★7 在这一帧里改正文 → 差异是**行级 hunks**（不是整段）',
    hunks.length > 0 && hunks.every((h) => Array.isArray(h.ins) && Array.isArray(h.del)) && !patch7?.doc?.full,
    { hunks: hunks.map((h) => ({ at: h.at, del: h.del.length, ins: h.ins.length })), full: !!patch7?.doc?.full });
  const bodySection = mdA.slice(0, mdA.indexOf('#演变：'));
  check('★7b 初稿的正文（frontmatter 之后 `#正文：` 段）里**没有**这帧的补写', !bodySection.includes('【第一帧补写】'), bodySection.length);
  /* 跳回初稿：正文里不该有这一帧的改动（物化按版本取） */
  await clickRow(0);
  await sleep(400); await forceFrames(2);
  const doc0 = await ev(`document.querySelector('#cx-doc .ProseMirror').textContent || ''`);
  check('★7c 切回初稿：正文里看不到那一帧的补写（物化按版本取，不是同一份）', !doc0.includes('【第一帧补写】'), doc0.slice(0, 40));

  /* ── ★8 另一条实体不串台 ─────────────────────────────────────────── */
  await pickEntity('霜纹剑');
  await sleep(500); await forceFrames(2);
  const r8 = await rail();
  check('★8 换到另一条实体：它没有版本，默认回到初稿（历史是每条实体自己的）',
    r8.rows.every((x) => !x.frame) && r8.rows[0].on && !read(MD_B).includes('#演变'),
    { rows: r8.rows.map((x) => x.frame), on: r8.rows.findIndex((x) => x.on) });

  /* ── ★9 默认进入"离指针最近的那一帧"（timeCursor 在所有节点之后 ⇒ 应落在最后一帧） ── */
  await pickEntity('银发少女');
  await sleep(500); await forceFrames(2);
  const r9 = await rail();
  check('★9 切回有版本的实体：默认落在**离沙盘指针最近的那一帧**（指针在最后 ⇒ 只剩的那一帧）',
    r9.n === 2 && r9.rows[1].on && r9.rows[1].frame && (await versionNote()).includes('第 1 版'),
    { n: r9.n, on: r9.rows.findIndex((x) => x.on), note: await versionNote() });

  /* ── ★10 自动模式：改动记到「记到」那个事件上（没版本就先建一版） ── */
  check('★10 设置里切成「自动」模式（帧条上显示模式）', (await setMode('auto')) === 'auto');
  await sleep(300); await forceFrames(2);
  const r10a = await rail();
  check('★10b 帧条上的模式标签跟着变', r10a.mode === '自动', r10a.mode);
  await setAnchor('n-evo-3');   /* 霜冠加冕：还没有版本 */
  await sleep(400); await forceFrames(2);
  await ev(setField('能力', '霜、冰晶'));
  await waitMd(MD_A, (t) => (mdFrames(t)?.length ?? 0) === 2);
  mdA = read(MD_A);
  const f10 = mdFrames(mdA);
  check('★10c 自动模式：改动自动在「记到」那个事件上开了一帧，差异 = 它与上一帧的区别',
    Array.isArray(f10) && f10.length === 2 && f10[1].nodeId === 'n-evo-3' && f10[1].patch?.set?.能力 === '霜、冰晶'
      && f10[1].patch?.set?.年龄 === undefined,
    { frames: Array.isArray(f10) ? f10.map((f) => ({ node: f.nodeId, set: Object.keys(f.patch?.set ?? {}) })) : f10 });
  check('★10d 新帧是**增量**（不含上一帧已有的年龄），上一帧原样', Array.isArray(f10) && f10[0].patch?.set?.年龄 === '19', null);
  await forceFrames(2);
  const r10 = await rail();
  check('★10e 自动建的那一版也上了帧条，并且视图跟到它上面',
    r10.n === 3 && r10.rows[2].frame && r10.rows[2].on, { n: r10.n, on: r10.rows.findIndex((x) => x.on) });

  /* ── ★11 站在初稿那一格：看到的是初稿，不是后来的版本 ───────────── */
  await clickRow(0);
  await sleep(400); await forceFrames(2);
  check('★11 点最上面那一格（初稿）→ 看到初稿那一版（年龄 17，不是第 1 版的 19）',
    (await fieldVal(ev, '年龄')) === '17' && (await versionNote()).includes('初稿'),
    { 年龄: await fieldVal(ev, '年龄'), note: await versionNote() });

  /* ── ★12 锁定模式：改动永远记到锁定的那一格 ─────────────────────── */
  await ev(`(() => {
    const s = JSON.parse(localStorage.getItem('lingkuang-settings') || '{}');
    s.evolveMode = 'locked'; s.evolveLock = { world: '测试世界观', tlId: 'tl-主线', nodeId: 'n-evo-2' };
    localStorage.setItem('lingkuang-settings', JSON.stringify(s));
    window.dispatchEvent(new CustomEvent('lingkuang-settings'));
    return true;
  })()`);
  await sleep(400); await forceFrames(2);
  const r12 = await rail();
  check('★12 锁定模式：视图钉在锁定的那一格上（选中 = 第一次魔潮那一帧）', r12.rows[1].on && r12.mode === '锁定',
    { on: r12.rows.findIndex((x) => x.on), mode: r12.mode, hints: r12.hints });
  await clickRow(2);
  await sleep(300); await forceFrames(2);
  const r12b = await rail();
  check('★12b 锁定模式下点别的格子也不换视图（免得"看到的"和"改到的"不是同一版）',
    r12b.rows[1].on && !r12b.rows[2].on, { on: r12b.rows.findIndex((x) => x.on) });
  await ev(setField('瞳色', '霜白'));
  await waitMd(MD_A, (t) => mdFrames(t)?.[0]?.patch?.set?.瞳色 === '霜白');
  mdA = read(MD_A);
  const f12 = mdFrames(mdA);
  check('★12c 锁定模式：改动一律记到锁定的那一帧上（第 1 帧拿到瞳色，没有多出帧）',
    Array.isArray(f12) && f12[0].patch?.set?.瞳色 === '霜白' && f12.length === 2,
    { frames: Array.isArray(f12) ? f12.map((f) => ({ node: f.nodeId, set: Object.keys(f.patch?.set ?? {}) })) : f12 });

  /* ── ★14 删掉一帧（带确认弹层）：只删那一帧，别的还在 ─────────────── */
  await setMode('manual');
  await clickRow(2);   /* 霜冠加冕：自动模式建的那一帧 */
  await sleep(400); await forceFrames(2);
  await ev(`(() => { const b = document.querySelector('[data-rail-del]'); if (!b) return 'no del'; b.click(); return 'ok'; })()`);
  await sleep(300); await forceFrames(2);
  const dlg = await ev(`(() => { const c = document.querySelector('.lk-pop-in'); return c ? c.textContent : ''; })()`);
  const picked = await ev(`(() => {
    const b = [...document.querySelectorAll('.lk-pop-in button')].find((x) => (x.textContent || '').includes('删掉这一帧'));
    if (!b) return false; b.click(); return true;
  })()`);
  check('★14 点「删掉这一帧」先弹确认（说清删的是什么）', !!dlg && dlg.includes('霜冠加冕') && picked, { dlg: String(dlg).slice(0, 60) });
  await waitMd(MD_A, (t) => (mdFrames(t)?.length ?? 9) === 1);
  const after = mdFrames(read(MD_A));
  check('★14b 确认后：那一帧从 .md 里消失，另一帧原样（历史是一帧一帧删的）',
    Array.isArray(after) && after.length === 1 && after[0].nodeId === 'n-evo-2' && after[0].patch?.set?.年龄 === '19',
    Array.isArray(after) ? after.map((f) => ({ node: f.nodeId, set: Object.keys(f.patch?.set ?? {}) })) : after);
  /* 删掉的正是"现在站着的那一格" ⇒ 视图与帧条都得退到它还剩下的那一版（不能停在一个不存在的版本上，
     否则那一行会连行一起从帧条上消失，看着像"点了没反应还丢了东西"） */
  await sleep(400); await forceFrames(2);
  const r14 = await rail();
  check('★14c 删掉当前这一版之后：帧条退回还剩的那些版本，视图落在第 1 版（不是空的）',
    r14.n === 2 && r14.rows[1].on && (await versionNote()).includes('第 1 版'),
    { n: r14.n, on: r14.rows.findIndex((x) => x.on), note: await versionNote() });

  /* ── ★15 写目标高亮：一眼看出「改动会写进哪一格」（用户 2026-09-13 原话：
     「我希望切换帧时直接高亮要写到的地方」）──────────────────────────────── */
  await sleep(300); await forceFrames(2);
  const r15 = await rail();
  check('★15 手动模式：亮着的是「正在看的那一版」（手动模式下它就是改动会写进去的那一格）',
    r15.rows[1]?.write === true && r15.rows[1]?.wtag === true && r15.rows[0]?.write === false
      && r15.rows[1].n.includes('改这里'),
    { write: r15.rows.map((x) => x.write), tags: r15.rows.map((x) => x.wtag), n: r15.rows.map((x) => x.n) });

  await clickRow(0);                     /* 切到「初稿」那一格 */
  await sleep(350); await forceFrames(2);
  const r15b = await rail();
  check('★15b 切到初稿那一格 → 写目标跟着挪到初稿（不是刚才那一版）',
    r15b.rows[0].write === true && r15b.rows[0].wtag === true && r15b.rows[1].write === false,
    { write: r15b.rows.map((x) => x.write), n: r15b.rows.map((x) => x.n) });

  await setMode('auto');
  await sleep(450); await forceFrames(2);
  const r15c = await rail();
  const aIdx = r15c.rows.findIndex((x) => x.anchor);
  check('★15c 自动模式：亮的是「记到」那一格（自动的改动就记到它上面）；它还没版本时也得**被拉进帧条**来（否则高亮无处可挂）',
    aIdx >= 0 && r15c.rows[aIdx].write === true && r15c.rows[aIdx].ghost === true
      && (r15c.rows[aIdx].n.match(/改这里|记到/g) || []).length === 1,
    { write: r15c.rows.map((x) => x.write), ghost: r15c.rows.map((x) => x.ghost), aIdx, n: r15c.rows[aIdx]?.n });
  check('★15d 自动模式：底部那个「＋ 记一帧」收起来了（改动本来就会自动记一版，留着只会让人以为要手动点）',
    r15c.add === null && r15c.mode === '自动',
    { add: r15c.add, mode: r15c.mode, hints: r15c.hints });

  await ev(`(() => {
    const s = JSON.parse(localStorage.getItem('lingkuang-settings') || '{}');
    s.evolveMode = 'locked'; s.evolveLock = { world: '测试世界观', tlId: 'tl-主线', nodeId: 'n-evo-2' };
    localStorage.setItem('lingkuang-settings', JSON.stringify(s));
    window.dispatchEvent(new CustomEvent('lingkuang-settings'));
    return true;
  })()`);
  await sleep(450); await forceFrames(2);
  const r15e = await rail();
  const lIdx = r15e.rows.findIndex((x) => x.id === 'n-evo-2');
  check('★15e 锁定模式：亮的是锁定的那一格（改动都记到它上面，与"正在看哪一版"无关）',
    lIdx >= 0 && r15e.rows[lIdx].write === true && r15e.rows.filter((x) => x.write).length === 1,
    { write: r15e.rows.map((x) => x.write), lIdx, mode: r15e.mode });
  await setMode('manual');   /* 复位（下一条断言看的是"没出错"，但别把状态留给同实例的下一个套件） */

  /* ── ★13 无未捕获异常 ───────────────────────────────────────────── */
  const errs = await ev(`window.__errs || []`);
  check('★13 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} PASS`);
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.message)); process.exit(1); });
