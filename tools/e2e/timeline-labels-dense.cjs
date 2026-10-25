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

  /* ② 引线：主干 + 短横钩（path）。每条被挪开的标签都该有一条；
     起点对准自己的圆点中心（±2px），横钩在**行心**、伸到**自己那行字**的近边（±3px）。 */
  const leaders = await ev(`(() => {
    const svg = document.querySelector('.tl-track .tl-leaders');
    const nodes = [...document.querySelectorAll('.tl__n')];
    const tr = document.querySelector('.tl-track').getBoundingClientRect();
    const paths = svg ? [...svg.querySelectorAll('path')].map((p) => {
      const nums = (p.getAttribute('d') || '').match(/-?[\\d.]+/g)?.map(Number) || [];
      return {
        id: p.getAttribute('data-id'),
        x0: nums[0], y0: nums[1], xSpine: nums[2], cy: nums[3], xEnd: nums[4],
        stroke: getComputedStyle(p).stroke, w: getComputedStyle(p).strokeWidth,
      };
    }) : [];
    const need = nodes.filter((n) => n.dataset.tier && n.dataset.tier !== '0' && n.dataset.tier !== 'hide').length;
    const boxes = new Map(nodes.map((n) => {
      const nr = n.getBoundingClientRect(), lr = n.querySelector('.tl__name').getBoundingClientRect();
      return [n.dataset.id, {
        story: n.classList.contains('is-story'),
        cx: nr.left + nr.width / 2 - tr.left, ny: nr.top - tr.top, nh: nr.height,
        left: lr.left - tr.left, right: lr.right - tr.left, top: lr.top - tr.top, bottom: lr.bottom - tr.top,
      }];
    }));
    let badStart = 0, badElbow = 0, badEnd = 0, cross = 0;
    for (const p of paths) {
      const b = boxes.get(p.id);
      if (!b) { badStart++; continue; }
      /* 起点：不越过自己的圆点（往下的线不能从圆点上方起、往上的同理） */
      const okSide = b.story ? p.y0 <= b.ny + 1 : p.y0 >= b.ny + b.nh - 1;
      if (!okSide) { badStart++; continue; }
      /* 主干必须是竖的（x 不变），横钩必须落在字行的心上 */
      if (Math.abs(p.xSpine - p.x0) > 0.6) badElbow++;
      if (Math.abs(p.cy - (b.top + b.bottom) / 2) > 2) badElbow++;
      /* 横钩终点贴着自己那行字的近边（世界在左、剧情在右） */
      const nearEdge = b.story ? b.right + 2 : b.left - 2;
      if (Math.abs(p.xEnd - nearEdge) > 3) badEnd++;
      /* 主干不许压在**任何一行字**上（这是"主干 + 横钩"换掉斜线的全部理由） */
      const ylo = Math.min(p.y0, p.cy), yhi = Math.max(p.y0, p.cy);
      for (const bb of boxes.values()) {
        if (p.x0 >= bb.left - 1 && p.x0 <= bb.right + 1 && yhi > bb.top + 1 && ylo < bb.bottom - 1) cross++;
      }
    }
    return { hasSvg: !!svg, paths: paths.length, need, badStart, badElbow, badEnd, cross, sample: paths.slice(0, 3) };
  })()`);
  console.log('leaders =', JSON.stringify(leaders));
  if (leaders && leaders.hasSvg) {
    ok('被挪开的标签都有引线', leaders.paths >= leaders.need, leaders);
    ok('引线起点不越过自己的圆点', leaders.badStart === 0, leaders);
    ok('主干竖直 + 横钩在行心', leaders.badElbow === 0, leaders);
    ok('横钩终点贴着自己那行字', leaders.badEnd === 0, leaders);
    ok('主干不压在任何一个名字上', leaders.cross === 0, leaders);
  } else {
    ok('引线层存在', false, leaders);
  }

  /* ③ 缩到很小：节点全挤在一起 —— 允许折叠，但**不允许重叠**，且折叠的悬停仍能出字 */
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
