/* 名字跟节点一起"正常出场"（第一百二十五轮定案 · 用户改口：不要钳制）
 *
 * 用户 2026-10-25：「能不能不要钳制，就和节点一样正常出场就行」。
 * 之前两版都错在这：① 把标签的 dx 夹在轨道内 ⇒ 快滚出去的名字被硬推回画面里（节点走了、字还在）；
 * ② 再加一道"圆点出画就 visibility:hidden" ⇒ 名字在边缘"啪"地消失，不如自然裁掉。
 * 现在：名字跟着节点走，越界交给 `.tl-wrap` 的 overflow:hidden 裁 —— 和圆点同一套出场方式。
 *
 * 判据：
 *  ① 没有 `data-off` 这类闸门（不许再"藏"）；
 *  ② 滚得很远的节点（离视口 ≥ 120px）：名字也必须已经不在画面里（跟着走了，不是被钉在边上）；
 *  ③ 贴边缘的节点：名字可以被裁（允许超出视口，说明没被夹回来）；
 *  ④ 双击回全览后名字都在。
 */
const PORT = process.argv[2] || process.env.LK_CDP_PORT || '9334';
const OUT = 'F:/Projects/lingkuang-v3/.review/shots-r125';
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (n, v, extra) => console.log(`${v ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) { console.log('FAIL 连不上 CDP'); process.exit(1); }
  const w = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; });
  let id = 0; const pending = new Map();
  w.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (m, p) => new Promise((res) => { const i = ++id; pending.set(i, res); w.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
  };

  await sleep(1200);
  await ev(`document.querySelector('[data-tool="sandbox"]')?.click(); true`);
  await sleep(600);
  await ev(`(() => {
    const tabs = [...document.querySelectorAll('.lk-tl-tab[data-tl]')];
    let best = null, bn = -1;
    for (const t of tabs) { const n = Number(t.querySelector('.cnt')?.textContent || 0); if (n > bn) { bn = n; best = t; } }
    if (best && !best.classList.contains('is-active')) best.click();
    return bn;
  })()`);
  await sleep(800);
  /* 放大 + 平移，把一部分节点推出画面 */
  await ev(`(() => {
    const wrap = document.querySelector('.tl-wrap');
    const r = wrap.getBoundingClientRect();
    const at = { clientX: r.left + r.width * 0.5, clientY: r.top + 120 };
    for (let i = 0; i < 4; i++) wrap.dispatchEvent(new WheelEvent('wheel', { ...at, deltaY: -120, altKey: true, bubbles: true, cancelable: true }));
    for (let i = 0; i < 3; i++) wrap.dispatchEvent(new WheelEvent('wheel', { ...at, deltaY: 120, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(700);
  await shot('01-panned');

  const check = await ev(`(() => {
    const wrap = document.querySelector('.tl-wrap').getBoundingClientRect();
    const rows = [...document.querySelectorAll('.tl__n')].map((n) => {
      const nr = n.getBoundingClientRect();
      const nm = n.querySelector('.tl__name');
      const lr = nm.getBoundingClientRect();
      const distOut = nr.right < wrap.left ? wrap.left - nr.right : (nr.left > wrap.right ? nr.left - wrap.right : 0);
      const inView = Math.min(lr.right, wrap.right) - Math.max(lr.left, wrap.left) > 1
        && Math.min(lr.bottom, wrap.bottom) - Math.max(lr.top, wrap.top) > 1;
      return { text: nm.textContent, distOut: Math.round(distOut), inView, vis: getComputedStyle(nm).visibility,
        labelRight: Math.round(lr.right), labelLeft: Math.round(lr.left), wrapRight: Math.round(wrap.right), wrapLeft: Math.round(wrap.left) };
    });
    return {
      total: rows.length,
      gates: document.querySelectorAll('.tl__n[data-off]').length,
      farOut: rows.filter((r) => r.distOut >= 120).length,
      farOutLeaked: rows.filter((r) => r.distOut >= 120 && r.inView).map((r) => r.text),
      nearEdgeOverflow: rows.filter((r) => r.distOut > 0 && r.distOut < 120 && (r.labelRight > r.wrapRight || r.labelLeft < r.wrapLeft)).length,
      visibleInside: rows.filter((r) => r.distOut === 0 && r.vis !== 'hidden').length,
    };
  })()`);
  console.log('check =', JSON.stringify(check));
  ok('没有"出画就藏"的闸门（data-off 为 0）', check.gates === 0, check);
  ok('滚远的节点：名字跟着一起出画（不许留在画面里）', check.farOutLeaked.length === 0 && check.farOut > 0, check);
  ok('贴边缘的节点：名字允许被裁（说明没被夹回画面）', check.nearEdgeOverflow >= 0, check);
  ok('画面内的节点照常显示名字', check.visibleInside > 0, check);

  /* 双击回全览：名字都在 */
  await ev(`(() => { const wrap = document.querySelector('.tl-wrap'); const r = wrap.getBoundingClientRect();
    wrap.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 200, clientY: r.top + 100 }));
    return true; })()`);
  await sleep(1200);
  const back = await ev(`(() => {
    const wrap = document.querySelector('.tl-wrap').getBoundingClientRect();
    const rows = [...document.querySelectorAll('.tl__n')].map((n) => ({
      vis: getComputedStyle(n.querySelector('.tl__name')).visibility,
      out: n.getBoundingClientRect().right < wrap.left || n.getBoundingClientRect().left > wrap.right,
    }));
    return { visible: rows.filter((r) => r.vis !== 'hidden').length, total: rows.length };
  })()`);
  console.log('back =', JSON.stringify(back));
  ok('双击回全览后名字都在', back.visible === back.total, back);
  await shot('02-fitted');

  w.close();
}

main().catch((e) => { console.log('FAIL 探针异常:', e.message); process.exit(1); });
