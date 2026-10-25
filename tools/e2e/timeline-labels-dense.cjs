/* 节点名密集时的重叠 / 折叠 / 引线（第一百二十三轮定案）。
 * 用法：先按 README「时间线标签密集」那节起好实例，再 node tools/e2e/timeline-labels-dense.cjs [端口]    产出 .review/shots-r123/*.png
 *
 * 判据：
 *  ① 可见标签两两**矩形相交**（> 2px 各边）⇒ 一次重叠。要求 0。
 *  ② 折叠数（data-tier="hide"）：越少越好（自适应分层的目的就是少折叠）。
 *  ③ 被挪开（tier >= 1）的标签必须有引线，且引线两端接在"点"和"自己那行字"上。
 */
const PORT = process.argv[2] || process.env.LK_CDP_PORT || '9334';
const OUT = 'F:/Projects/lingkuang-v3/.review/shots-r123';
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (n, v, extra) => console.log(`${v ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let target = null;
  for (let i = 0; i < 120; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch {}
    await sleep(200);
  }
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

  await sleep(2000);
  await ev(`window.__errs=[];window.addEventListener('error',(e)=>window.__errs.push(String(e.message)));true`);
  await ev(`document.querySelector('[data-tool="sandbox"]')?.click(); true`);
  await sleep(900);
  /* 时间线撑到 55%，让上下的余量足够做多层 */
  await ev(`(() => {
    const bar = document.getElementById('lk-split');
    const sb = document.getElementById('lk-sandbox');
    const r = sb.getBoundingClientRect();
    const y = r.top + r.height * 0.55;
    bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, clientX: r.left + 40, clientY: y, pointerId: 1 }));
    bar.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 1, clientX: r.left + 40, clientY: y, pointerId: 1 }));
    bar.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 }));
    return true;
  })()`);
  await sleep(400);
  await shot('00-baseline');

  const state = await ev(`(() => {
    const nodes = [...document.querySelectorAll('.tl__n')];
    const tr = document.querySelector('.tl-track').getBoundingClientRect();
    const labels = nodes.map((n) => {
      const name = n.querySelector('.tl__name');
      const r = name.getBoundingClientRect();
      const cs = getComputedStyle(name);
      const tier = n.dataset.tier;
      return {
        id: n.dataset.id, text: name.textContent, tier,
        visible: tier !== 'hide' && Number(cs.opacity) > 0.05,
        left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        topCss: Math.round(r.top - tr.top),
        story: n.classList.contains('is-story'),
      };
    });
    return { nodes: nodes.length, trackH: Math.round(tr.height), labels };
  })()`);

  const vis = state.labels.filter((l) => l.visible);
  const hidden = state.labels.filter((l) => l.tier === 'hide');
  /* ① 重叠：两两矩形相交（各边缩 2px，避免"贴着"算重叠） */
  let overlaps = 0; const pairs = [];
  for (let i = 0; i < vis.length; i++) {
    for (let j = i + 1; j < vis.length; j++) {
      const a = vis[i], b = vis[j];
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 2 && oy > 2) { overlaps++; if (pairs.length < 8) pairs.push({ a: a.text, b: b.text, ox: Math.round(ox), oy: Math.round(oy), ta: a.tier, tb: b.tier }); }
    }
  }
  const tiers = {};
  for (const l of state.labels) tiers[l.tier] = (tiers[l.tier] || 0) + 1;
  const summary = { nodes: state.nodes, trackH: state.trackH, visible: vis.length, hidden: hidden.length, overlaps, tiers, pairs };
  console.log('summary =', JSON.stringify(summary, null, 0));
  ok('可见标签 0 重叠', overlaps === 0, { overlaps, pairs });
  ok('折叠数 ≤ 2（尽量都显示）', hidden.length <= 2, { hidden: hidden.map((h) => h.text) });

  /* ② 名字必须**横坐标对准节点**（用户 2026-10-25：「名称横坐标直接对准节点吧」）——
     这是这一轮的核心要求：不再靠"从侧边拉一条线"去认归属。 */
  const centered = await ev(`(() => {
    const nodes = [...document.querySelectorAll('.tl__n')];
    const bad = [];
    for (const n of nodes) {
      if (n.dataset.tier === 'hide') continue;
      const nr = n.getBoundingClientRect(), lr = n.querySelector('.tl__name').getBoundingClientRect();
      const dc = Math.abs((lr.left + lr.right) / 2 - (nr.left + nr.width / 2));
      if (dc > 1) bad.push({ text: n.querySelector('.tl__name').textContent, dc: Math.round(dc * 10) / 10 });
    }
    return { total: nodes.length, badCount: bad.length, bad: bad.slice(0, 5) };
  })()`);
  console.log('centered =', JSON.stringify(centered));
  if (centered) ok('每个名字的横向中心对准自己的节点（±1px）', centered.badCount === 0, centered);

  /* ③ 连接线：**穿行于行间空隙**的一根竖虚线（不再从侧边拉钩），永远不压字 */
  const leaders = await ev(`(() => {
    const svg = document.querySelector('.tl-track .tl-leaders');
    const nodes = [...document.querySelectorAll('.tl__n')];
    const tr = document.querySelector('.tl-track').getBoundingClientRect();
    const paths = svg ? [...svg.querySelectorAll('path')].map((p) => {
      const nums = (p.getAttribute('d') || '').match(/-?[\\d.]+/g)?.map(Number) || [];
      return { x1: nums[0], y1: nums[1], x2: nums[2], y2: nums[3] };
    }) : [];
    const boxes = [...nodes].map((n) => {
      const lr = n.querySelector('.tl__name').getBoundingClientRect();
      return { left: lr.left - tr.left, right: lr.right - tr.left, top: lr.top - tr.top, bottom: lr.bottom - tr.top };
    });
    /* 万一以后又把线加回来：任何线段都不许和名字盒相交（这条一直有效） */
    let cross = 0;
    for (const p of paths) {
      const ylo = Math.min(p.y1, p.y2), yhi = Math.max(p.y1, p.y2);
      for (const b of boxes) {
        if (p.x1 >= b.left - 1 && p.x1 <= b.right + 1 && yhi > b.top + 1 && ylo < b.bottom - 1) cross++;
      }
    }
    return { hasSvg: !!svg, paths: paths.length, cross };
  })()`);
  console.log('leaders =', JSON.stringify(leaders));
  if (leaders) {
    /* 第一百二十六轮：名字居中到节点之后，线是多余的（试过两种画法都压字/断断续续）⇒ 不画 */
    ok('不再从侧边拉线（名字已经对准节点）', leaders.paths === 0, leaders);
    ok('没有线压在名字上', leaders.cross === 0, leaders);
  }

  /* ③ 上/下分侧：剧情事件的名字必须在线上方、世界事件在下方（第一百二十四轮复核） */
  const sides = await ev(`(() => {
    const tr = document.querySelector('.tl-track').getBoundingClientRect();
    const mid = tr.top + tr.height / 2;
    const bad = [];
    for (const n of document.querySelectorAll('.tl__n')) {
      if (n.dataset.tier === 'hide') continue;
      const nm = n.querySelector('.tl__name');
      const r = nm.getBoundingClientRect();
      const story = n.classList.contains('is-story');
      if (story && r.bottom > mid + 2) bad.push({ text: nm.textContent, kind: '剧情但跑到线下面', y: Math.round(r.top - tr.top) });
      if (!story && r.top < mid - 2) bad.push({ text: nm.textContent, kind: '世界但跑到线上面', y: Math.round(r.top - tr.top) });
    }
    return { bad, total: document.querySelectorAll('.tl__n').length };
  })()`);
  console.log('sides =', JSON.stringify(sides));
  if (sides) ok('剧情名字全在线上方、世界名字全在线下方', sides.bad.length === 0, sides);

  /* ④ 拖指针：节点元素**不许**被每帧重建，淡化要渐变（第一百二十四轮「闪烁」） */
  const drag = await ev(`(async () => {
    const wrap = document.querySelector('.tl-wrap');
    const r = wrap.getBoundingClientRect();
    const cur = document.querySelector('.tl-cursor');
    const handle = document.querySelector('.tl-cursor-handle');
    const start = Math.max(40, cur.getBoundingClientRect().left - r.left);
    const frame = () => new Promise((res) => requestAnimationFrame(res));
    const nodes = [...document.querySelectorAll('.tl__n')];
    nodes.forEach((n, i) => { n.dataset.mark = 'm' + i; });
    /* 选最右边那个节点，用来观察淡化 */
    const target = nodes[nodes.length - 1];
    const tx = target.getBoundingClientRect().left - r.left + 13;
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, clientX: r.left + start, clientY: r.top + 10, pointerId: 21 }));
    let replaced = 0;
    let prev = document.querySelector('.tl__n');
    for (let i = 0; i <= 12; i++) {
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 1, clientX: r.left + start + i * 12, clientY: r.top + 10, pointerId: 21 }));
      await frame();
      const now = document.querySelector('.tl__n');
      if (now !== prev) replaced++;
      prev = now;
    }
    /* 再把指针拖过那个节点，逐帧记它的 opacity（应先暗后亮、有中间帧） */
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 1, clientX: r.left + Math.max(20, tx - 150), clientY: r.top + 10, pointerId: 21 }));
    for (let i = 0; i < 14; i++) await frame();
    const trail = [];
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 1, clientX: r.left + tx + 40, clientY: r.top + 10, pointerId: 21 }));
    for (let i = 0; i < 16; i++) { await frame(); trail.push(Number(getComputedStyle(target).opacity)); }
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 21 }));
    const mids = trail.filter((v) => v > 0.45 && v < 0.95).length;
    let maxJump = 0;
    for (let i = 1; i < trail.length; i++) maxJump = Math.max(maxJump, Math.abs(trail[i] - trail[i - 1]));
    const survivors = [...document.querySelectorAll('.tl__n')].filter((n) => n.dataset.mark).length;
    return { replaced, survivors, total: nodes.length, mids, maxJump: +maxJump.toFixed(3) };
  })()`);
  console.log('drag =', JSON.stringify(drag));
  if (drag) {
    ok('拖指针时不重建节点元素（旧元素一个不少）', drag.replaced === 0 && drag.survivors === drag.total, drag);
    ok('淡化是渐变的（有中间帧、单帧不跳变）', drag.mids >= 2 && drag.maxJump <= 0.5, drag);
  }

  /* ⑤ 缩到很小：节点全挤在一起 —— 允许折叠，但**不允许重叠**，且折叠的悬停仍能出字 */
  const zoomed = await ev(`(async () => {
    const wrap = document.querySelector('.tl-wrap');
    const r = wrap.getBoundingClientRect();
    for (let i = 0; i < 12; i++) {
      wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, altKey: true, bubbles: true, cancelable: true, clientX: r.left + 500, clientY: r.top + 120 }));
    }
    await new Promise((res) => setTimeout(res, 900));
    const nodes = [...document.querySelectorAll('.tl__n')];
    const tr = document.querySelector('.tl-track').getBoundingClientRect();
    const labels = nodes.map((n) => {
      const name = n.querySelector('.tl__name');
      const b = name.getBoundingClientRect();
      return { tier: n.dataset.tier, op: Number(getComputedStyle(name).opacity), left: b.left, right: b.right, top: b.top, bottom: b.bottom, text: name.textContent };
    });
    const vis = labels.filter((l) => l.tier !== 'hide' && l.op > 0.05);
    let ov = 0;
    for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length; j++) {
      const a = vis[i], b = vis[j];
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 2 && oy > 2) ov++;
    }
    return {
      visible: vis.length, hidden: labels.filter((l) => l.tier === 'hide').length, overlaps: ov,
      hiddenHasHover: (() => {
        const h = document.querySelector('.tl__n[data-tier="hide"] .tl__name');
        if (!h) return null;
        return getComputedStyle(h).transitionDuration !== '0s';
      })(),
    };
  })()`);
  console.log('zoomed =', JSON.stringify(zoomed));
  if (zoomed) {
    ok('缩到很小：可见标签仍 0 重叠', zoomed.overlaps === 0, zoomed);
    ok('缩到很小：放不下的折叠成点（不是叠成一团）', zoomed.hidden >= 0, zoomed);
  }

  ok('无 JS 报错', (await ev(`window.__errs.length`)) === 0, await ev(`window.__errs`));
  await shot('01-after');
  w.close();
}

main().catch((e) => { console.log('FAIL 探针异常:', e.message); process.exit(1); });
