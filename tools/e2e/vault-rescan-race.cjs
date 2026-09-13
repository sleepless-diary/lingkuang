/* 不变量：**写盘正在飞的时候来的那次「外部改动回扫」，不许拿旧快照把刚做的改动打回去。**
 *
 * 现场（2026-09-13，`entity-evolution.cjs` 偶发 34/38 两次）：在设定库里改了「年龄」→ 中栏
 * 立刻显示 19，`#演变：` 那一帧的 patch 还是 `{}`，**450ms 后中栏自己变回 17**、`.md` 始终没拿到 19
 * （逐 150ms 采样：t+0/150/300 = 19、t+450 = 17）。⇒ 不是"没写下去"，是**内存里的改动被人拿旧快照盖掉了**。
 *
 * 机制（`src/main.ts`）：自动落盘有 400ms 防抖，写一整个 vault 要时间；`writeAll()` 在**开头**就把
 * `pendingWrite = false`（`src/main.ts:396`），于是**写盘在飞的那段时间里，防抖标志是 false**。
 * 而 vault 监听回调（`src/main.ts:472-495`）判断"能不能用这份扫描快照覆盖内存"只看 `pendingWrite`：
 * 写盘途中到达的 watcher 事件 → `scan enter pending=false` → 不 flush、直接扫 → 主进程里这次扫描
 * 读到的实体 `.md` 还是**改动前**的样子（节点先写、实体后写）→ 扫完 `pendingWrite` 仍是 false
 * → `scan APPLY` 用旧快照整片替换 `worldsets` ⇒ 实体按文件重建 ⇒ 帧的 patch 变回 `{}`。
 * 紧接着同一轮 writeAll 才轮到写实体 —— 它读到的是已经被打回去的内存 ⇒ 文件永远是旧值。
 *
 * 本套件是**确定性复现**：改一个字段（400ms 后开始写盘），在写盘窗口里（+380~+480ms）往**另一个**
 * 实体的 .md 里连写几笔，逼 watcher 事件落在写盘飞行中。修复前必挂，修复后必须绿——
 * 同时还要证明"外部改动照样能回扫进来"（不能靠"永不回扫"来换绿）。
 *
 * 用法：`node tools/e2e/seed-evolution.cjs` → 起应用 → `node tools/e2e/vault-rescan-race.cjs`
 */
const fs = require('fs');
const path = require('path');
const VAULT = process.env.LINGKUANG_VAULT;
const PORT = process.env.LK_CDP_PORT || '9334';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const write = (p, t) => fs.writeFileSync(p, t, 'utf8');
const ENT = (type, name) => path.join(VAULT, '测试世界观', '_设定', type, name + '.md');
function mdFrames(text) {
  const i = text.indexOf('#演变：');
  if (i === -1) return null;
  const m = text.slice(i).match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) return 'BROKEN';
  try { return JSON.parse(m[1]); } catch { return 'BAD_JSON'; }
}

const FIELDEL = (k) => `[...document.querySelectorAll('#cx-fields > div')].find((r) => r.firstElementChild?.textContent === ${JSON.stringify(k)})?.querySelector('input,textarea,select')`;
const FIELD = (k) => `${FIELDEL(k)}?.value`;
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
  const waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };
  const forceFrames = async (n = 3) => { for (let i = 0; i < n; i++) await send('Page.captureScreenshot', { format: 'jpeg', quality: 10 }); };

  const MD_A = ENT('角色', '银发少女');     /* 我们改的实体 */
  const MD_B = ENT('物品', '霜纹剑');       /* 外部改动的实体（只用来逼出 watcher 事件） */
  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  /* 起点自足：模式/锁定复位（设置存在 localStorage，套件跑完不复位会跨运行累积） */
  await ev(`(() => { const s = JSON.parse(localStorage.getItem('lingkuang-settings') || '{}');
    s.evolveMode = 'manual'; s.evolveLock = null; localStorage.setItem('lingkuang-settings', JSON.stringify(s));
    window.dispatchEvent(new CustomEvent('lingkuang-settings')); return true; })()`);
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  const clean = `(() => { const r = document.querySelector('#cx-root');
    return !!r && !r.classList.contains('lk-enter-stagger') && [...r.children].every((c) => !c.style.animationDelay); })()`;
  await waitFor(() => ev(clean), 8000);
  await forceFrames(3);
  await ev(`(() => { const b = [...document.querySelectorAll('[data-cx-id]')].find((x) => x.children[0]?.textContent === '银发少女'); if (b) b.click(); return !!b; })()`);
  await sleep(600); await forceFrames(2);

  /* ── 前置：在这一帧上编辑（先把版本建出来，锚在 n-evo-2） ─────────────── */
  await ev(`(() => { const s = document.querySelector('#cx-anchor'); s.value = 'n-evo-2'; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
  await sleep(200);
  await ev(`(() => { const b = document.querySelector('[data-rail-add]'); if (b) b.click(); return !!b; })()`);
  const hasFrame = await waitFor(() => { const f = mdFrames(read(MD_A)); return Array.isArray(f) && f.length === 1; }, 6000);
  check('★0 前置：这一版已经建好（.md 里有一帧）', hasFrame, { frames: mdFrames(read(MD_A)) });

  /* ── 前置 ②：给世界塞一批实体，把「写盘窗口」拉长到几十毫秒（否则窗口太窄、逼不出竞态） ── */
  const TYPE_DIR = path.join(VAULT, '测试世界观', '_设定', '角色');
  for (let i = 1; i <= 30; i++) {
    const p = path.join(TYPE_DIR, `陪跑实体 ${i}.md`);
    if (!fs.existsSync(p)) write(p, `---\nid: e-race-${i}\nname: 陪跑实体 ${i}\ntype: 角色\n年龄: ${20 + i}\n别名: []\n---\n\n#正文：\n陪跑。\n`);
  }
  await sleep(1600); await forceFrames(2);   /* 等回扫把它们收进 store */
  const railCount = await ev(`document.querySelectorAll('#cx-rail .lk-rail__row').length`);
  check('★0b 前置：世界里已有一批实体（写盘窗口够长）', typeof railCount === 'number', { 帧条行数: railCount });
  /* 一个**节点**文件（writeAll 先写节点、后写实体）：盯它的 mtime 变化 = 抓到"写盘刚开始"的时刻 */
  const NODE_PROBE = path.join(VAULT, '测试世界观', '主线', '事件', '王国的建立.md');
  const nodeMtime = () => { try { return fs.statSync(NODE_PROBE).mtimeMs; } catch { return 0; } };

  /* ── ★1 写盘在飞的时候来一次外部改动：内存里的改动不许被打回去 ────────── */
  const before = await ev(FIELD('年龄'));
  const bText0 = read(MD_B);
  const mt0 = nodeMtime();
  await ev(setField('年龄', '19'));
  const rightAfter = await ev(FIELD('年龄'));
  /* 死等"写盘真的开始了"（节点文件被改写）→ 那一刻立刻改**别的实体**的 .md，
     让 watcher 事件正好落在写盘飞行途中 —— 这是竞态的确定性触发方式，不靠 sleep 撞运气 */
  let fired = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 2500 && fired < 3) {
    if (nodeMtime() !== mt0) {
      fired++;
      write(MD_B, bText0.replace(/\n+$/, '') + `\n\n外部改动 ${fired}\n`);
      await sleep(6);   /* 连着来几笔，只要有一笔落进窗口即可 */
    }
    await sleep(4);
  }
  /* 采样 2.2s：看中栏有没有自己变回去、以及 .md 有没有拿到 19 */
  const trace = [];
  let landed = false;
  for (let i = 0; i < 22; i++) {
    const v = await ev(FIELD('年龄'));
    const f = mdFrames(read(MD_A));
    const patch = Array.isArray(f) ? JSON.stringify(f[0]?.patch) : String(f);
    if (patch.includes('19')) landed = true;
    trace.push(`${i * 100}ms:${v}/${patch}`);
    await sleep(100);
  }
  const after = await ev(FIELD('年龄'));
  const fA = mdFrames(read(MD_A));
  check('★1 外部改动回扫期间，刚改的字段**不许自己变回去**（中栏始终是 19）',
    fired > 0 && rightAfter === '19' && after === '19' && !trace.some((t, i) => i > 0 && !t.includes(':19/')),
    { 触发了: fired, before, rightAfter, after, 变回去过: trace.filter((t, i) => i > 0 && !t.includes(':19/')).slice(0, 3) });
  check('★1b 这一帧的 patch 落进 .md（差异记在这一版上）', landed,
    { frames: Array.isArray(fA) ? fA[0]?.patch : fA });

  /* ── ★2 但外部改动本身必须照样回扫进来（不能靠"永不回扫"换绿） ────────── */
  const mark = `外部改动 ${fired}`;
  const sawExternal = await waitFor(() => new RegExp(mark).test(read(MD_B)), 3000);
  await sleep(800); await forceFrames(2);
  /* 切到「霜纹剑」看正文里有没有那几笔外部改动（回扫真的生效了） */
  await ev(`(() => { const b = [...document.querySelectorAll('[data-cx-id]')].find((x) => x.children[0]?.textContent === '霜纹剑'); if (b) b.click(); return !!b; })()`);
  await sleep(900); await forceFrames(2);
  const docB = await ev(`(document.querySelector('#cx-doc .ProseMirror') || {}).textContent || ''`);
  check('★2 外部对 .md 的改动**仍然**会被回扫进界面（回扫没被一刀砍掉）',
    sawExternal && new RegExp(mark).test(String(docB)), { 文件里有: new RegExp(mark).test(read(MD_B)), 界面正文: String(docB).slice(0, 60) });

  check('★3 全程没有未捕获异常', JSON.stringify(await ev(`window.__errs || []`)) === '[]', await ev(`window.__errs || []`));

  const passed = results.filter(Boolean).length;
  console.log(`\n共 ${results.length} 项，通过 ${passed}，失败 ${results.length - passed}`);
  console.log('采样：' + trace.join(' | ').slice(0, 600));
  w.close();
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 异常：' + (e && e.stack || e)); process.exit(1); });
