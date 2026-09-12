/* 不变量：**设定库右侧那条「演变」竖线 + 版本帧**
 *  （用户 2026-09-13：「我想在设定库右侧加一条竖着的等距的时间线，用来储存不同节点，
 *   当选中实例时，默认进入离当前指针最近的 git」+「都做吧，把模式放到设置里面」）。
 *
 * 这条套件钉住的四件事：
 *   ① 右栏是**等距**的格子（每格 = 一个事件节点，顶上第一格 = 初稿），选格即换版本；
 *   ② 三种模式真的不一样：**手动**改的是"你现在看的那一版"（不产生历史）；
 *      **自动**在选中格上没有版本时自动开一个；**锁定**永远记到锁定的那一格；
 *   ③ 一帧只存**与上一帧的区别**（字段与正文都按行），且初稿（.md 的 frontmatter）不被改写；
 *   ④ 换一条实体不串台；帧写进 .md 的 `#演变：` 段，冷启动后还在（文件是源）。
 *
 * 用法：`node tools/e2e/seed-evolution.cjs` → 起应用 → `node tools/e2e/entity-evolution.cjs`
 * ⚠️ 会改测试数据（新增帧）。重跑请重新播种并重启实例。
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
  /** 帧条：每格 { id, t, n, on, frame } + 底部按钮/提示 */
  const rail = () => ev(`(() => {
    const rows = [...document.querySelectorAll('#cx-rail .lk-rail__row')].map((r) => ({
      id: r.dataset.rail || '', on: r.classList.contains('is-on'), frame: r.classList.contains('is-frame'),
      t: (r.querySelector('.lk-rail__t') || {}).textContent || '', n: (r.querySelector('.lk-rail__n') || {}).textContent || '',
      s: (r.querySelector('.lk-rail__s') || {}).textContent || '',
    }));
    const add = document.querySelector('[data-rail-add]');
    const del = document.querySelector('[data-rail-del]');
    return { n: rows.length, rows, add: add ? add.dataset.railAdd : null, del: del ? del.dataset.railDel : null,
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

  /* ── ★0 前置：帧条在、等距、两格 ─────────────────────────────────── */
  await pickEntity('银发少女');
  await sleep(500); await forceFrames(2);
  const r0 = await rail();
  check('★0 前置：右栏帧条存在（1 格初稿 + 3 个事件节点，等高）', r0.n === 4 && r0.rows[0].n === '初稿' && r0.rows.slice(1).every((x) => x.n),
    { n: r0.n, rows: r0.rows.map((x) => x.t + '/' + x.n) });
  const heights = await ev(`[...document.querySelectorAll('#cx-rail .lk-rail__row')].map((r) => Math.round(r.getBoundingClientRect().height))`);
  check('★0b 等距：每格高度相同（用户要的"等距时间线"，不按时间比例）', Array.isArray(heights) && new Set(heights).size === 1, heights);

  /* ── ★1 还没有版本时默认落在初稿 ─────────────────────────────────── */
  check('★1 一条版本都没有时，默认落在「初稿」那一格', r0.rows[0].on && (await versionNote()).includes('初稿'),
    { on: r0.rows.findIndex((x) => x.on), note: await versionNote() });

  /* ── ★2 点一个没有版本的格子：看到的是它之前的那一版（floor），并有提示 ── */
  await clickRow(2);   /* 索引 2 = 第 2 个节点（第一次魔潮） */
  await sleep(400); await forceFrames(2);
  const r2 = await rail();
  check('★2 点没有版本的格子：看到的是"上一版"，并在帧条上写明改动会记到哪里', r2.rows[2].on && r2.hints.some((h) => h.includes('这一格没有版本')),
    { on: r2.rows.findIndex((x) => x.on), hints: r2.hints });

  /* ── ★3 手动模式：改动落到"你现在看的那一版"（这里是初稿），不产生历史 ── */
  await ev(setField('发色', '墨黑'));
  await waitMd(MD_A, (t) => fmValue(t, '发色') === '墨黑');
  let mdA = read(MD_A);
  check('★3 手动模式：在没版本的格子上改字段 → 改的是初稿（frontmatter 变），且**没有产生帧**',
    fmValue(mdA, '发色') === '墨黑' && mdFrames(mdA) === null,
    { 发色: fmValue(mdA, '发色'), frames: mdFrames(mdA) });

  /* ── ★4 在这一格记一帧 ───────────────────────────────────────────── */
  await clickAdd();
  await waitMd(MD_A, (t) => Array.isArray(mdFrames(t)) && mdFrames(t).length === 1);
  mdA = read(MD_A);
  const f4 = mdFrames(mdA);
  check('★4 点「＋ 在这一格记一帧」→ .md 里出现 #演变： 段，帧锚在「第一次魔潮」上',
    Array.isArray(f4) && f4.length === 1 && f4[0].nodeId === 'n-evo-2',
    { frames: Array.isArray(f4) ? f4.map((f) => ({ node: f.nodeId, patch: f.patch })) : f4 });
  const r4 = await rail();
  check('★4b 帧条上这一格被点亮（是版本了），底部按钮变成"删掉这一帧"', r4.rows[2].frame && r4.del === 'n-evo-2', { del: r4.del, frame: r4.rows[2].frame });

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
  await clickRow(2);
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
  check('★9 切回有版本的实体：默认落在**离沙盘指针最近的那一帧**（指针在最后 → 落在第 2 格那一帧）',
    r9.rows[2].on && r9.rows[2].frame && (await versionNote()).includes('第 1 版'),
    { on: r9.rows.findIndex((x) => x.on), note: await versionNote() });

  /* ── ★10 自动模式：在没版本的格子上改动会自动开一帧 ─────────────── */
  check('★10 设置里切成「自动」模式（帧条上显示模式）', (await setMode('auto')) === 'auto');
  await sleep(300); await forceFrames(2);
  const r10a = await rail();
  check('★10b 帧条上的模式标签跟着变', r10a.mode === '自动', r10a.mode);
  await clickRow(3);   /* 第 3 个节点：霜冠加冕，还没有版本 */
  await sleep(400); await forceFrames(2);
  await ev(setField('能力', '霜、冰晶'));
  await waitMd(MD_A, (t) => (mdFrames(t)?.length ?? 0) === 2);
  mdA = read(MD_A);
  const f10 = mdFrames(mdA);
  check('★10c 自动模式：改动自动在这一格开了一帧，差异 = 它与上一帧的区别',
    Array.isArray(f10) && f10.length === 2 && f10[1].nodeId === 'n-evo-3' && f10[1].patch?.set?.能力 === '霜、冰晶'
      && f10[1].patch?.set?.年龄 === undefined,
    { frames: Array.isArray(f10) ? f10.map((f) => ({ node: f.nodeId, set: Object.keys(f.patch?.set ?? {}) })) : f10 });
  check('★10d 新帧是**增量**（不含上一帧已有的年龄），上一帧原样', Array.isArray(f10) && f10[0].patch?.set?.年龄 === '19', null);

  /* ── ★11 站在最早那一格：看到的是初稿（floor），不是后来的版本 ───── */
  await clickRow(1);   /* 王国的建立（315，最早） */
  await sleep(400); await forceFrames(2);
  check('★11 站在最早的格子（没有版本）→ 看到的是初稿那一版（年龄 17，不是第 1 版的 19）',
    (await fieldVal(ev, '年龄')) === '17', await fieldVal(ev, '年龄'));

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
  check('★12 锁定模式：视图钉在锁定的那一格上（选中 = 第一次魔潮）', r12.rows[2].on && r12.mode === '锁定',
    { on: r12.rows.findIndex((x) => x.on), mode: r12.mode, hints: r12.hints });
  await clickRow(3);
  await sleep(300); await forceFrames(2);
  const r12b = await rail();
  check('★12b 锁定模式下点别的格子也不换视图（免得"看到的"和"改到的"不是同一版）',
    r12b.rows[2].on && !r12b.rows[3].on, { on: r12b.rows.findIndex((x) => x.on) });
  await ev(setField('瞳色', '霜白'));
  await waitMd(MD_A, (t) => mdFrames(t)?.[0]?.patch?.set?.瞳色 === '霜白');
  mdA = read(MD_A);
  const f12 = mdFrames(mdA);
  check('★12c 锁定模式：改动一律记到锁定的那一帧上（第 1 帧拿到瞳色，没有多出帧）',
    Array.isArray(f12) && f12[0].patch?.set?.瞳色 === '霜白' && f12.length === 2,
    { frames: Array.isArray(f12) ? f12.map((f) => ({ node: f.nodeId, set: Object.keys(f.patch?.set ?? {}) })) : f12 });

  /* ── ★14 删掉一帧（带确认弹层）：只删那一帧，别的还在 ─────────────── */
  await setMode('manual');
  await clickRow(3);   /* 霜冠加冕：自动模式建的那一帧 */
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

  /* ── ★13 无未捕获异常 ───────────────────────────────────────────── */
  const errs = await ev(`window.__errs || []`);
  check('★13 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} PASS`);
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.message)); process.exit(1); });
