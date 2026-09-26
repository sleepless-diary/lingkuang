/* 探针：**从"点开沙盘"那一刻起**采样标尺（刻度数/标签/档位），看它是"一直很少"还是"先少后多"。
   用途：排查非线性模式套件 ★0（进沙盘后 ~2.9s 读 majors 只有 1 条）到底是
   ① 视图真没 fit（rAF 没跑）还是 ② 我这一版 diff 把刻度数画少了。
   用法：LK_CDP_PORT=9346 node tools/e2e/probe-scale-boot.cjs */
const PORT = process.env.LK_CDP_PORT || '9346';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const snap = () => ev(`(() => {
    const pane = document.querySelector('#lk-pane-timeline');
    const scale = pane?.querySelector('.tl-scale');
    const majors = [...(scale?.querySelectorAll('.tl__axis-tick--major') ?? [])];
    const sel = document.getElementById('lk-line-sel');
    return {
      majors: majors.length,
      minors: scale ? scale.querySelectorAll('.tl__axis-tick--minor').length : null,
      kids: scale ? scale.children.length : null,
      lbl: majors.slice(0, 3).map((el) => el.querySelector('.tl__axis-label')?.textContent ?? ''),
      lefts: majors.slice(0, 3).map((el) => Math.round(parseFloat(el.style.left) || 0)),
      wrapW: (pane?.querySelector('.tl-wrap') || pane)?.clientWidth ?? null,
      selVal: sel ? sel.value : null,
      nl: !!document.getElementById('lk-nonlinear')?.classList.contains('is-active'),
      tool: document.querySelector('.lk-tool-btn.is-active')?.dataset.tool ?? null,
      hasPane: !!pane,
      nodes: document.querySelectorAll('#lk-pane-timeline .tl__n[data-id]').length,
      nodeXs: [...document.querySelectorAll('#lk-pane-timeline .tl__n[data-id]')].slice(0, 3).map((el) => Math.round(parseFloat(el.style.left) || 0)),
      session: localStorage.getItem('lingkuang-session'),
      errs: window.__errs ? window.__errs.slice(0, 3) : null,
    };
  })()`);

  await sleep(1000);

  /* 特殊模式：只把「上次打开的工具」写进会话存档就退出（用于构造初始状态，见下面那段 A/B 说明）。
     ⚠️ 会话落盘有 400ms 防抖（`src/ui/session.ts` 的 SAVE_MS）—— 写完必须等一会儿再杀应用，
     否则这一笔根本没落盘（这正是套件之间状态"看着随机"的来源之一）。 */
  const setMode = process.argv[2] || '';
  if (setMode.startsWith('--set-session=')) {
    const tool = setMode.slice('--set-session='.length);
    const out = await ev(`(() => {
      const cur = JSON.parse(localStorage.getItem('lingkuang-session') || '{}');
      const next = { v: 1, world: cur.world || '测试世界观', timeline: cur.timeline || 'tl-主线', tool: ${JSON.stringify(tool)}, target: cur.target || null };
      localStorage.setItem('lingkuang-session', JSON.stringify(next));
      return localStorage.getItem('lingkuang-session');
    })()`);
    await sleep(600);
    console.log('session set =', out);
    w.close(); process.exit(0);
  }

  /* ⚠️ 错误监听必须**在点开沙盘之前**装上：挂载那一刻的渲染就是我们怀疑抛异常的那一次 */
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); window.addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + String(e.reason && e.reason.message || e.reason))); true`);
  console.log('boot   ', JSON.stringify(await snap()));
  await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`);
  for (let i = 0; i < 22; i++) { await sleep(150); console.log(`+${String((i + 1) * 150).padStart(4)}ms`, JSON.stringify(await snap())); }
  w.close();
  process.exit(0);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
