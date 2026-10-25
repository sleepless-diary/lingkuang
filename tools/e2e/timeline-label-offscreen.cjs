/* 节点在画面外时，名字不许留在画面内（第一百二十五轮定案）。
 * 用法：先起隔离实例，再 node tools/e2e/timeline-label-offscreen.cjs [端口]
 *
 * 判据：
 *  ① 圆点整个在时间线可视区外的节点：名字 `visibility: hidden`，且**可见像素**不落在视口里。
 *  ② 反证：把视图拉回来之后，同一个节点的名字必须重新出现（不是永久藏掉）。
 *  ③ 视口内的节点：名字照常可见（别把整片都藏了）。
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
  /* 放大 + 往右平移，把一部分节点推出画面（用滚轮，和真人一样） */
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
      const cs = getComputedStyle(nm);
      const dotOut = nr.right < wrap.left - 1 || nr.left > wrap.right + 1;
      /* 名字的可见像素是否落在视口里（视口裁剪后还有面积） */
      const inView = Math.min(lr.right, wrap.right) - Math.max(lr.left, wrap.left) > 1
        && Math.min(lr.bottom, wrap.bottom) - Math.max(lr.top, wrap.top) > 1;
      return { id: n.dataset.id, text: nm.textContent, dotOut, vis: cs.visibility, inView, off: n.dataset.off || '', tier: n.dataset.tier || '' };
    });
    return {
      total: rows.length,
      offscreen: rows.filter((r) => r.dotOut).length,
      leaked: rows.filter((r) => r.dotOut && r.vis !== 'hidden' && r.inView).map((r) => r.text),
      insideVisible: rows.filter((r) => !r.dotOut && r.tier !== 'hide' && r.vis !== 'hidden').length,
      hiddenByTier: rows.filter((r) => r.tier === 'hide').length,
    };
  })()`);
  console.log('check =', JSON.stringify(check));
  ok('画面外的节点名字不留在画面里', check.leaked.length === 0, check);
  ok('画面内的节点仍照常显示名字', check.insideVisible > 0, check);

  /* 反证：双击画布 = fit（回到能看到全部节点）—— 那些名字要回来 */
  await ev(`(() => { const wrap = document.querySelector('.tl-wrap'); const r = wrap.getBoundingClientRect();
    wrap.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 200, clientY: r.top + 100 }));
    return true; })()`);
  await sleep(1200);
  const back = await ev(`(() => {
    const wrap = document.querySelector('.tl-wrap').getBoundingClientRect();
    const rows = [...document.querySelectorAll('.tl__n')].map((n) => ({ off: n.dataset.off || '', vis: getComputedStyle(n.querySelector('.tl__name')).visibility, out: n.getBoundingClientRect().right < wrap.left || n.getBoundingClientRect().left > wrap.right }));
    return { offN: rows.filter((r) => r.off === '1').length, outN: rows.filter((r) => r.out).length, visibleLabels: rows.filter((r) => r.vis !== 'hidden').length };
  })()`);
  console.log('back =', JSON.stringify(back));
  ok('双击回全览后名字重新出现（不是永久藏掉）', back.offN === back.outN && back.visibleLabels > 0, back);
  await shot('02-fitted');

  w.close();
}

main().catch((e) => { console.log('FAIL 探针异常:', e.message); process.exit(1); });
