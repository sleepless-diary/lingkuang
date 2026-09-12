/* 灵感触发器 · 词义联想画布：**连线上的"拉力"**（用户 2026-09-13 报「拉太远时拉力会失效」）
 *
 * 现象与真因（实测，见 docs/BUGS.md 第二十轮十二）：
 *   A. `forceStep` 里跨过"手里那一格"的受力是**两边一起跳过**的：
 *        if (dragGroup && (dragGroup.has(a.id) !== dragGroup.has(b.id))) continue / return;
 *      于是拖一个词的**全程**，与它相连的词纹丝不动 —— 实测（A/B 同一套断言）：
 *        修复前  拖 144px → 根词位移 1px、间距被拉成 291（静止长度 140）  ⇒ ★1 FAIL
 *        修复后  拖 150px → 根词位移 146px、间距仍是 146                    ⇒ ★1 PASS
 *      看着就是「线还在、线上没有力」，拖得越远越明显（不是数据溢出：力的数值全程有限且随距离线性增长，
 *      1e6 px 时弹簧力 10998/帧，`assoc-pull` ★4 还专门把节点丢到 40 万像素外验证不出 NaN/Infinity）。
 *   B. 「钉住」（`_pinned`，手动摆过的节点不许被力导向挪动）原来没有上限：**两端都被手工摆过**时，
 *      线被拉得再长也回不来 —— 这是"拉力失效"的最后一种形态。现在给它加了上限 `PIN_YIELD = 420`：
 *      被拉太远就松钉、让弹簧把线收回来。
 *
 * 用法（见 tools/e2e/README.md）：
 *   $env:LINGKUANG_* 指向测试目录 → 起应用（--remote-debugging-port=9500）→ node tools/e2e/assoc-pull.cjs
 *
 * ⚠️ 联想是 LLM 调用：本套件把 `window.fetch` 换成固定 5 个词，保证"根 + 5 个子词"的图**确定复现**
 *    （否则本机没跑 ollama 时图里只有根词、根本没有边，拉力无从断言）。
 * ⚠️ 测试实例是 showInactive（窗口 hidden）⇒ rAF 不自己推进，力导向必须靠 forceFrames() 出帧才走。
 * ⚠️ 拖拽落点要**夹在画布内**（否则贴边自动推视窗会把节点推飞几千像素，测的就不是弹簧而是推视窗）；
 *    判 ★1 时还要**沿着"根 → 被拖词"的方向往外拖**（乱拖可能带上"朝根靠"的分量，原地不动也能让间距变小）。 */
const PORT = process.env.LK_CDP_PORT || '9500';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }

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
  const forceFrames = async (n = 6) => {
    for (let i = 0; i < n; i++) { await send('Page.captureScreenshot', { format: 'jpeg', quality: 10 }); await sleep(25); }
  };
  /** 根节点的世界坐标、被拖那个子节点的世界坐标、以及它俩的间距（静止长度 140） */
  const stat = () => ev(`(() => {
    const els = [...document.querySelectorAll('#assoc-world .assoc__root, #assoc-world .assoc__node')];
    const ns = els.map((el) => { const m = /translate\\(([-0-9.e+]+)px,\\s*([-0-9.e+]+)px\\)/.exec(el.style.transform) || [];
      return { t: el.textContent, x: +m[1], y: +m[2], root: el.classList.contains('assoc__root') }; });
    const root = ns.find((n) => n.root);
    const kid = ns.find((n) => !n.root);
    const dists = ns.filter((n) => n !== root).map((n) => Math.round(Math.hypot(n.x - root.x, n.y - root.y)));
    return { n: ns.length, root: [Math.round(root.x), Math.round(root.y)], kid: kid ? [Math.round(kid.x), Math.round(kid.y)] : null,
      min: dists.length ? Math.min(...dists) : null, max: dists.length ? Math.max(...dists) : null, dists,
      gap: dists.length ? dists[0] : null,   /* 被拖那个词 ↔ 根 的间距（静止长度 140） */
      bad: ns.some((n) => !isFinite(n.x) || !isFinite(n.y)) };
  })()`);
  /** 指针手势：pointerdown 打在节点元素上（stage 的监听靠冒泡），move/up 打在 window 上 */
  const fire = (type, x, y, buttons, sel) => ev(`(() => {
    const t = ${sel ? `document.querySelector('${sel}')` : 'window'};
    t.dispatchEvent(new PointerEvent('${type}', { clientX: ${x}, clientY: ${y}, buttons: ${buttons}, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    return true; })()`);
  const centerOf = (sel) => ev(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect();
    return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
  const KID = '#assoc-world .assoc__node', ROOT = '#assoc-world .assoc__root';

  await sleep(800);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  /* LLM 联想换成固定词：图必须是"根 + 5 个子词"才有边可拉 */
  await ev(`(() => { const words = ['雪狼','冻湖','松林','极光','猎户'];
    window.fetch = async () => ({ ok: true, json: async () => ({ message: { content: words.join('\\n') },
      choices: [{ message: { content: words.join('\\n') } }] }) });
    return true; })()`);
  await ev(`document.querySelector('[data-tool="inspire"]').click(); true`);
  for (let i = 0; i < 40 && !(await ev(`!!document.querySelector('#assoc-stage')`)); i++) await sleep(150);
  await ev(`document.querySelector('#insp-assoc').assocSetRoot('雪原'); true`);
  await sleep(1200);
  await forceFrames(60);
  const base = await stat();
  check('★0 前置：图里是"根 + 子词"且有连线（根与子词距离在静止长度 140 附近）',
    base.n >= 3 && base.min !== null && base.min >= 120 && base.max <= 175 && !base.bad, base);

  const stage = await ev(`(() => { const r = document.querySelector('#assoc-stage').getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; })()`);
  const clampToStage = (x, y) => [Math.min(Math.max(x, stage[0] + 80), stage[2] - 80),
                                  Math.min(Math.max(y, stage[1] + 80), stage[3] - 80)];

  /* ── ① 用户报的正题：**还按着不松手**的时候，连线就该把相邻的词拉过来 ──
     修复前：跨过"手里那一格"的受力整对被跳过 ⇒ 被拖的词一个人走，间距拉成 140+位移（实测 291）。
     修复后：邻居跟过来，间距停在静止长度附近（实测 146）。 */
  const geo = await ev(`(() => {
    const r = document.querySelector('${ROOT}').getBoundingClientRect();
    const k = document.querySelector('${KID}').getBoundingClientRect();
    const rc = [r.left + r.width / 2, r.top + r.height / 2], kc = [k.left + k.width / 2, k.top + k.height / 2];
    const dx = kc[0] - rc[0], dy = kc[1] - rc[1], len = Math.hypot(dx, dy) || 1;
    return { kid: [Math.round(kc[0]), Math.round(kc[1])], dir: [dx / len, dy / len] };
  })()`);
  const [tx, ty] = clampToStage(geo.kid[0] + geo.dir[0] * 150, geo.kid[1] + geo.dir[1] * 150);
  await fire('pointerdown', geo.kid[0], geo.kid[1], 1, KID);
  await fire('pointermove', geo.kid[0] + 6, geo.kid[1] + 6, 1);
  const before = await stat();
  await fire('pointermove', tx, ty, 1);
  await forceFrames(30);
  const during = await stat();
  const pulled = Math.round(Math.hypot(during.root[0] - before.root[0], during.root[1] - before.root[1]));
  const kidMoved = Math.round(Math.hypot(during.kid[0] - before.kid[0], during.kid[1] - before.kid[1]));
  check('★1 拖动全程（还没松手）线就被拉住了：往"离开根"的方向拖，间距不许被拉长（修复前会拉成 140+位移）',
    kidMoved > 80 && during.gap < before.gap + 60,
    { kidMoved, rootMoved: pulled, gapBefore: before.gap, gapDuring: during.gap, push: [geo.kid[0] - tx, geo.kid[1] - ty] });
  await fire('pointerup', tx, ty, 0);
  await forceFrames(40);

  /* ── ② 拖得不算远（< PIN_YIELD 420）：松手后**它自己留在被放下的地方**（钉子有效，不会被拖回去），
        而线由**邻居过来**收成静止长度（拉力是双向的：近处钉住、远处收线） ── */
  const c = await centerOf(KID);
  const kidBefore = (await stat()).kid;
  const [nx, ny] = clampToStage(c[0] - 140, c[1] + 90);
  await fire('pointerdown', c[0], c[1], 1, KID);
  await fire('pointermove', c[0] + 5, c[1] + 5, 1);
  await fire('pointermove', nx, ny, 1);
  await forceFrames(8);
  await fire('pointerup', nx, ny, 0);
  const near0 = await stat();
  await forceFrames(80);
  const near1 = await stat();
  const movedByDrag = Math.round(Math.hypot(near0.kid[0] - kidBefore[0], near0.kid[1] - kidBefore[1]));
  const selfDrift = Math.round(Math.hypot(near1.kid[0] - near0.kid[0], near1.kid[1] - near0.kid[1]));
  check('★2 拖得不算远（与根 < 420px）→ 松手后它自己留在被放下的地方（自身漂移 < 40px），线由邻居收成静止长度',
    movedByDrag > 40 && selfDrift < 40 && near1.gap < 260,
    { movedByDrag, selfDrift, gap: near1.gap, kidBefore, kidAtDrop: near0.kid, kidAfter80: near1.kid });

  /* ── ③ 拉太远 + **两端都被手工摆过**：钉子必须失效、弹簧把线收回来 ──
     只钉一头的情况 ★2 已覆盖；两头都钉住时，没有 PIN_YIELD 就永远回不来（拉力在这条路上是死的）。
     先把根也拖一下（⇒ 根也变"手工摆过"），再把子节点甩到很远处。 */
  const rc = await centerOf(ROOT);
  const [rx, ry] = clampToStage(rc[0] + 90, rc[1] - 70);
  await fire('pointerdown', rc[0], rc[1], 1, ROOT);
  await fire('pointermove', rc[0] + 5, rc[1] - 5, 1);
  await fire('pointermove', rx, ry, 1);
  await forceFrames(6);
  await fire('pointerup', rx, ry, 0);
  await forceFrames(30);
  const c2 = await centerOf(KID);
  await fire('pointerdown', c2[0], c2[1], 1, KID);
  await fire('pointermove', c2[0] + 5, c2[1] + 5, 1);
  await fire('pointermove', stage[0] + 4, stage[1] + 4, 1);   /* 顶到画布左上角外 ⇒ 贴边推视窗把它送远 */
  await forceFrames(20);
  await fire('pointerup', stage[0] + 4, stage[1] + 4, 0);
  const far0 = await stat();
  await forceFrames(120);
  const far1 = await stat();
  check('★3 拉太远（> 420px）且两端都被手工摆过 → 钉子失效、间距被弹簧收回静止长度（修复前两头都焊死、永远回不来）',
    far0.gap > 420 && far1.gap < 260, { released: far0.gap, after120: far1.gap, all: far1.dists });

  /* ── ④ 数值健康：极远距离下不许出现 NaN/Infinity（用户猜"是不是数据溢出"）── */
  const c3 = await centerOf(KID);
  await fire('pointerdown', c3[0], c3[1], 1, KID);
  await fire('pointermove', c3[0] + 5, c3[1] + 5, 1);
  await fire('pointermove', c3[0] - 400000, c3[1] - 250000, 1);   /* 一口气丢到 40 万像素外 */
  await forceFrames(4);
  const huge0 = await stat();
  await fire('pointerup', c3[0] - 400000, c3[1] - 250000, 0);
  await forceFrames(60);
  const huge1 = await stat();
  check('★4 丢到 40 万像素外也不出 NaN/Infinity，且弹簧仍在把它往回拉（距离确实在变小）',
    !huge0.bad && !huge1.bad && huge1.max < huge0.max, { flung: huge0.max, after60: huge1.max, bad: huge1.bad });

  const errs = await ev(`window.__errs`);
  check('★5 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} PASS`);
  w.close();
  process.exit(results.every(Boolean) ? 0 : 1);
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
