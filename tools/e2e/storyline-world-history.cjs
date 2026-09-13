/* 不变量：世界沙盒顶部那个「剧情线 / 世界历史」下拉，选完之后**不许被下一次重画改回去**。
 *
 * 用户原话（2026-09-13）：「**世界沙盒中从剧情线切换到世界历史再移动指针时会导致跳回剧情线**」。
 * 根因（`src/ui/timeline.ts` 的 `renderStoryUI()`）：下拉里"世界历史"那一项的值是 `null`，
 * 而旧代码 `activeLineId && lines.some(...) ? activeLineId : lines[0]?.id ?? null` 把**用户显式选的
 * null**当成"还没选"，下一次重画就落位到第一条剧情线；而 change 处理器紧接着就调一次
 * `renderStoryUI()`（`src/ui/timeline.ts:575-581`）⇒ **选完当场就被改回去**（不必移动指针）。
 * 修法：`linePinned` —— 只有"用户还没选过"或"聚焦的那条线被删了"才自动落位。
 *
 * A/B（2026-09-13）：修复后 8/8；把 `src/ui/timeline.ts` 退回 HEAD 重新 `vite build` 后
 * ★1/★2/★3/★5 四条 FAIL（4/8）⇒ 断言确实盯住了这个 bug（见 e2e README 铁律 9）。
 *
 * 用法：对着**有剧情线的数据**跑（`%TEMP%\lk-story` 是真实数据的副本），起应用后
 * `LK_CDP_PORT=9700 node tools/e2e/storyline-world-history.cjs`
 */
const PORT = process.env.LK_CDP_PORT || '9334';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }

async function main() {
  let target = null;
  for (let i = 0; i < 40; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (target) break; } catch {}
    await sleep(400);
  }
  if (!target) { console.log(`FAIL 无法连接 CDP ${PORT}`); process.exit(1); }
  const w = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { w.onopen = res; w.onerror = () => rej(new Error('WS 打不开')); });
  let id = 0; const pending = new Map();
  w.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); w.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  const forceFrames = async (n = 3) => { for (let i = 0; i < n; i++) await send('Page.captureScreenshot', { format: 'jpeg', quality: 10 }); };

  await sleep(1500);
  await ev(`window.__pErr = []; window.addEventListener('error', (e) => window.__pErr.push(String(e.message))); true`);
  /* 下拉状态：值 / 全部选项 / 聚焦遮罩里有几段（世界历史 = 不聚焦 = 0 段） */
  const state = () => ev(`(() => {
    const s = document.querySelector('#lk-line-sel');
    const mask = document.querySelector('#lk-story-mask');
    return { val: s ? s.value : null, opts: s ? [...s.options].map((o) => o.value) : [], maskKids: mask ? mask.children.length : -1 };
  })()`);
  const setSel = (v) => ev(`(() => { const s = document.querySelector('#lk-line-sel'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);

  const s0 = await state();
  const lineId = (s0.opts || []).find((v) => v);   /* 第一条剧情线的 id（不写死，换个目录也能跑） */
  check('★0 前置：剧情线下拉存在，且至少有一条剧情线', !!lineId && s0.opts.includes(''), { opts: s0.opts });
  if (!lineId) { console.log('\n⚠️ 这份数据里没有剧情线 —— 请对着有剧情线的目录跑（如 %TEMP%\\lk-story）'); w.close(); process.exit(1); }

  /* ★1 切到「世界历史」要真的生效（不是当场被打回） */
  await setSel('');
  await sleep(350);
  const s1 = await state();
  check('★1 选「世界历史」后保持为空（不被当场打回剧情线）', s1.val === '', s1);

  /* ★2 移动时间指针后仍然是世界历史（用户报的那一条） */
  await ev(`(() => {
    const el = document.querySelector('.tl-wrap');
    const r = el.getBoundingClientRect();
    const mk = (t, x, b) => new PointerEvent(t, { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: b, clientX: x, clientY: r.top + 60 });
    el.dispatchEvent(mk('pointerdown', r.left + 120, 1));
    el.dispatchEvent(mk('pointermove', r.left + 200, 1));
    el.dispatchEvent(mk('pointerup', r.left + 200, 0));
    return 1;
  })()`);
  await forceFrames(2); await sleep(400);
  const s2 = await state();
  check('★2 移动时间指针后仍是「世界历史」', s2.val === '', s2);
  check('★3 世界历史 = 不聚焦：画布上没有剧情线遮罩', s2.maskKids === 0, { maskKids: s2.maskKids });

  /* ★4 切回剧情线，聚焦要照常生效（别修坏正常路径） */
  await setSel(lineId);
  await sleep(350);
  const s4 = await state();
  check('★4 切回剧情线后选项生效', s4.val === lineId, s4);
  check('★4b 切回后聚焦遮罩回来（段外区域 ≥1 段）', s4.maskKids >= 1, { maskKids: s4.maskKids });

  /* ★5 再切世界历史 + 点笔刷（另一条会重画下拉的路径）——选择同样不能被改掉 */
  await setSel('');
  await sleep(250);
  await ev(`(() => { const b = document.querySelector('#lk-brush'); if (b) b.click(); return !!b; })()`);
  await sleep(350);
  const s5 = await state();
  check('★5 点笔刷（重画下拉的那条路）之后仍是「世界历史」', s5.val === '', s5);

  check('★6 无未捕获异常', JSON.stringify(await ev(`window.__pErr || []`)) === '[]', await ev(`window.__pErr || []`));

  const passed = results.filter(Boolean).length;
  console.log(`\n共 ${results.length} 项，通过 ${passed}，失败 ${results.length - passed}`);
  w.close();
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 异常：' + (e && e.stack || e)); process.exit(1); });
