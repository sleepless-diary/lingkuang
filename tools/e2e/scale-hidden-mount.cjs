/* 不变量：**宿主被藏起来时（宽度 0）画出来的标尺，等它重新露出来必须自己纠正**。
 *
 * 由来（2026-09-26，第 ⑤ 片收尾时顺带发现的既有缺陷）：
 *   `src/ui/timeline.ts` 的 `renderScale()` 按 `wrap.clientWidth` 算刻度范围，宿主隐藏时它是 0
 *   ⇒ 只画得出**一根**刻度（实测 `majors: 1, minors: 0`），`fitAll()` 也会按 0 宽算出
 *   `spacing = 下限 0.05`（等于没 fit）。而"切回沙盘"那条路（`src/ui/shell.ts` 里
 *   `id === 'sandbox'` 的分支）只恢复显示、**不重画** ⇒ 那根孤零零的刻度会一直挂着。
 *   触发场景是现成的：会话恢复（`src/ui/session.ts`）让应用开局停在设定库，
 *   沙盘宿主就是"隐藏着挂载"的 —— 用户第一次切回沙盘会看到一根刻度 + 没 fit 的视图。
 *   （套件 `nonlinear-pan.cjs` 的 ★0 曾经偶发 `majors: 1` 就是这个，不是它自己的问题。）
 *
 * 修法：`mountTimeline()` 末尾挂一个 `ResizeObserver` —— 宽度**变了**就重画；
 *   "从 0 变成真宽度"那一次额外补 `fitAll()`。
 *
 * ⚠️ 本套件**不去构造会话恢复的竞态**（那条路要不要复现取决于启动时序，跑不稳），
 *   而是直接造出同一个几何状态：隐藏 `.lk-right` → 派一次滚轮（逼出一帧"宽度 0 的重画"）→ 再显示。
 *
 * 用法：干净实例（reset-entity-vault + seed-node，端口 9346），
 *   LK_CDP_PORT=9346 node tools/e2e/scale-hidden-mount.cjs
 */
const PORT = process.env.LK_CDP_PORT || '9346';
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
  const state = () => ev(`(() => {
    const pane = document.querySelector('#lk-pane-timeline');
    const scale = pane?.querySelector('.tl-scale');
    const wrap = pane?.querySelector('.tl-wrap');
    const majors = [...(scale?.querySelectorAll('.tl__axis-tick--major') ?? [])];
    const xs = majors.map((el) => Math.round(parseFloat(el.style.left) || 0));
    const gaps = xs.slice(1).map((x, i) => x - xs[i]);
    return {
      w: wrap ? wrap.clientWidth : null,
      majors: majors.length,
      minGap: gaps.length ? Math.min(...gaps) : null,
      labels: majors.slice(0, 3).map((el) => el.querySelector('.tl__axis-label')?.textContent ?? ''),
    };
  })()`);

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`);
  for (let i = 0; i < 20; i++) { if (await ev(`document.querySelectorAll('#lk-pane-timeline .tl__axis-tick--major').length > 0`)) break; await sleep(300); }
  await sleep(900);

  /* ── ★0 前置：可见状态下标尺是正常的（有刻度、间距是"一格 72px 上下"的量级） ── */
  const shown = await state();
  check('★0 前置：可见时标尺正常（宽度 > 0、主刻度 ≥ 5 条、最小间距 ≥ 40px）',
    shown.w > 0 && shown.majors >= 5 && shown.minGap !== null && shown.minGap >= 40, shown);

  /* ── 造状态：把沙盘那半边藏起来（宽度变 0），并逼出一帧"宽度 0 时的重画" ── */
  const hidden = await ev(`(() => {
    const right = document.querySelector('.lk-right') || document.getElementById('lk-sandbox');
    if (!right) return { ok: false };
    right.style.display = 'none';
    const wrap = document.querySelector('#lk-pane-timeline .tl-wrap');
    wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
    return { ok: true, w: wrap.clientWidth };
  })()`);
  await sleep(400);
  const deg = await state();
  check('★1 隐藏宿主后重画：宽度是 0 ⇒ 标尺只剩极少数刻度（这就是"没纠正"的起点）',
    hidden.ok === true && deg.w === 0 && deg.majors <= 2, { hidden, deg });

  /* ── ★2 露出来之后必须自己纠正（修复前：一直是一根刻度） ── */
  await ev(`(() => {
    const right = document.querySelector('.lk-right') || document.getElementById('lk-sandbox');
    if (right) right.style.display = '';
    return true;
  })()`);
  await sleep(900);
  const back = await state();
  check('★2 重新显示后标尺自己回来（主刻度 ≥ 5 条、最小间距 ≥ 40px）',
    back.w > 0 && back.majors >= 5 && back.minGap !== null && back.minGap >= 40, { was: deg.majors, now: back.majors, back });

  /* ── ★3 而且视图要**重新 fit**（藏起来那次的 fit 是按 0 宽算的，等于没 fit） ── */
  check('★3 重新显示后视图补了一次 fit（刻度铺到"一格 72px 上下"的档，不是下限 0.05 的荒档）',
    back.majors >= 5 && back.majors <= 40, { majors: back.majors, labels: back.labels });

  const errs = await ev(`window.__errs`);
  check('★4 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n==== ${pass}/${results.length} PASS ====`);
  w.close();
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
