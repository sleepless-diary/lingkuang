/* 逐帧探针（第 ⑤ 片 · 用户报「入场时标尺的文字会闪一下」）：
   在**入场动画期间**逐帧记录 —— 每帧的：
     · 正在演动画的刻度中取第一根：它的 className / 父级 computed opacity 与 transform（矩阵）/
       inline left / 动画个数，以及它里面 `.tl__axis-label` 的 computed opacity、font-size、
       getBoundingClientRect 的 left 与 width（width 反映"文字被缩放到多少"）
     · 全屏刻度数 n / 在演的刻度数 animN / **同屏重复的标签文本数 dup**（同一段文字同时出现两份 = 文字闪）
   用法：LK_CDP_PORT=9346 node tools/e2e/probe-scale-enter-frames.cjs [pan|zoom] */
const PORT = process.env.LK_CDP_PORT || '9346';
const MODE = process.argv[2] || 'pan';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let target = null;
  for (let i = 0; i < 120; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (target) break; } catch {}
    await sleep(200);
  }
  if (!target) { console.log('no cdp'); process.exit(1); }
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

  /* 已经在沙盘里就别再点（工具按钮是开/关切换的，再点会把它关掉） */
  const onSandbox = await ev(`!!document.querySelector('#lk-pane-timeline .tl-scale')`);
  if (!onSandbox) { await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`); await sleep(1800); }

  const out = await ev(`(async () => {
    const scale = document.querySelector('#lk-pane-timeline .tl-scale');
    if (!scale) return { fatal: 'no .tl-scale' };
    const frames = [];
    const t0 = performance.now();
    let stop = false;
    const sample = () => {
      const kids = [...scale.children];
      const texts = [];
      for (const el of kids) { const s = el.querySelector('.tl__axis-label'); if (s) texts.push(s.textContent); }
      const dup = texts.length - new Set(texts).size;
      const anim = kids.filter((el) => el.getAnimations && el.getAnimations().length);
      let rec = null;
      const first = anim.find((el) => el.classList.contains('tl__axis-tick--major')) || anim[0];
      if (first) {
        const s = first.querySelector('.tl__axis-label');
        const cs = getComputedStyle(first);
        const ls = s ? getComputedStyle(s) : null;
        const r = s ? s.getBoundingClientRect() : null;
        rec = {
          cls: first.className.replace('tl__axis-tick ', ''),
          op: Number(cs.opacity), tf: cs.transform === 'none' ? 'none' : cs.transform.replace(/matrix\\(|\\)/g, ''),
          left: first.style.left, an: first.getAnimations().length,
          txt: s ? s.textContent : null, lFont: ls ? ls.fontSize : null,
          lX: r ? Math.round(r.left * 10) / 10 : null, lW: r ? Math.round(r.width * 10) / 10 : null,
          lTop: r ? Math.round(r.top * 10) / 10 : null,
          timing: (() => { const a = first.getAnimations()[0]; if (!a || !a.effect) return null; const t = a.effect.getTiming(); return [t.delay, t.duration]; })()
        };
      }
      frames.push({ t: Math.round(performance.now() - t0), n: kids.length, animN: anim.length, dup: dup, rec: rec });
      if (!stop) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    await new Promise((r) => setTimeout(r, 60));
    const wrap = scale.parentElement;
    const rr = wrap.getBoundingClientRect();
    const MODE = ${JSON.stringify(MODE)};
    if (MODE === 'zoom') {
      for (let i = 0; i < 3; i++) {
        wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, altKey: true, clientX: rr.left + Math.round(rr.width / 2), clientY: rr.top + 40, bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 260));
      }
    } else {
      wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: -180, bubbles: true, cancelable: true }));
    }
    await new Promise((r) => setTimeout(r, 900));
    stop = true;
    await new Promise((r) => setTimeout(r, 40));
    return { frames: frames.filter((f) => f.animN > 0).slice(0, 26), total: frames.length };
  })()`);

  if (out.fatal) { console.log(out.fatal); process.exit(1); }
  console.log('mode =', MODE, '| frames with animation =', out.frames.length, '/', out.total);
  for (const f of out.frames) {
    const r = f.rec;
    console.log(
      `t=${String(f.t).padStart(4)}  n=${String(f.n).padStart(3)} anim=${String(f.animN).padStart(3)} dup=${f.dup}` +
      (r ? `  | ${r.cls} txt=${r.txt} op=${r.op.toFixed(2)} tf=${r.tf} left=${r.left} an=${r.an} delay/dur=${JSON.stringify(r.timing)}` +
           ` | label f=${r.lFont} x=${r.lX} w=${r.lW} top=${r.lTop}` : '')
    );
  }
  w.close();
}
main().catch((e) => { console.log('probe 异常 ' + (e && e.stack ? e.stack : e)); process.exit(2); });
