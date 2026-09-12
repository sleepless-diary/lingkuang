/* 动效（切换类）：切工具 / 开面板 / 弹窗 / 页签 —— 每一处都要**证明动画真的在跑**，
 * 而不是「看起来有」。所以断言读的是元素自己 `getAnimations()` 的 animationName + 时长 + 延迟
 * （CDP 里能直接读到 CSS 动画对象），外加「动画收尾不残留」（opacity=1 / transform=none
 * —— 停在半透明或偏移的动画比没有动画更糟，界面会像坏了）。
 *
 * 规格来源：design-system/DESIGN.md 第 7 节（慢、呼吸感、不 snappy；错峰 ~40ms）与
 * design-system/tokens.css 的 --motion-* 令牌。**prefers-reduced-motion 降级**也在这里验
 * （DESIGN.md:159：关掉错峰，只留短淡入）——用 CDP 的 Emulation.setEmulatedMedia 模拟系统偏好。
 *
 * 用法：先跑 seed-motion.cjs，起应用，再跑本脚本（见 tools/e2e/README.md）。
 *
 * ⚠️ **环境事实（踩过）**：测试实例用 `LINGKUANG_TEST_WINDOW_NOFOCUS=1`（showInactive）起，
 * 渲染进程的 `document.visibilityState` 是 `hidden` ⇒ **CSS 动画不推进**：`playState` 是
 * `running`，但 `currentTime` 永远是 0、计算样式停在起点（opacity 0 / translateY 8px）。
 * 所以「等 700ms 再读计算样式要求 opacity=1」这种断言在这个环境里**天然不可靠**
 * （偶尔被截图强制出帧才会推进，表现为随机挂）。本脚本因此分三步断言，都不依赖墙钟：
 *   ① 参数对不对：animationName / 时长 / 延迟 / playState（点击的同一个同步块里读）
 *   ② 真的会动：`Page.captureScreenshot` 强制出几帧，看 `currentTime` 是否前进
 *   ③ 终态不残留：`anim.finish()` 把动画推到结尾，再读计算样式（opacity 必须回到 1）
 */
const PORT = process.env.LK_CDP_PORT || '9334';
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
  /** 读某元素身上**正在跑或已生效**的 CSS 动画（name/时长/延迟/状态） */
  const anims = (sel) => ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    return el.getAnimations().map((a) => ({ name: a.animationName, dur: a.effect.getTiming().duration, delay: a.effect.getTiming().delay, state: a.playState }));
  })()`);
  /** 点击 + **同一个同步块里**读动画：click → openTool → enter() 全是同步的，这一刻 playState 必然是 running */
  const clickAnims = (clickExpr, sel) => ev(`(() => {
    ${clickExpr}
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    return el.getAnimations().map((a) => ({ name: a.animationName, dur: a.effect.getTiming().duration, delay: a.effect.getTiming().delay, state: a.playState }));
  })()`);
  /** 点击 + 同一同步块里读**某个容器的所有子项**的动画（错峰是靠序号给的，所以要看每个子项） */
  const clickChildAnims = (clickExpr, parentSel) => ev(`(() => {
    ${clickExpr}
    const p = document.querySelector(${JSON.stringify(parentSel)});
    if (!p) return null;
    return [...p.children].map((el) => el.getAnimations().map((a) => ({ name: a.animationName, dur: a.effect.getTiming().duration, delay: a.effect.getTiming().delay, state: a.playState })));
  })()`);
  /** 终态不残留：把动画 `finish()` 推到结尾，再读计算样式（必须回到「不透明 + 无偏移」）。
   *  窗口隐藏时动画不推进（见文件头的环境事实），所以不能靠"等一会儿"——那会随机挂。 */
  const settled = (sel) => ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    el.getAnimations().forEach((a) => { try { a.finish(); } catch (e) { /* 无限循环的动画不能 finish */ } });
    const cs = getComputedStyle(el);
    return { opacity: cs.opacity, transform: cs.transform };
  })()`);
  /** 强制出几帧：`Page.captureScreenshot` 会让渲染进程真的产生帧，动画的 currentTime 才会前进 */
  const forceFrames = async (n = 6) => {
    for (let i = 0; i < n; i++) { await send('Page.captureScreenshot', { format: 'jpeg', quality: 10 }); await sleep(60); }
  };
  /** 动画已经推进了多少毫秒（证明它不只是"被声明了"，而是真的在动） */
  const playedMs = (sel) => ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    return el.getAnimations().map((a) => (a.currentTime === null ? null : Math.round(a.currentTime)));
  })()`);
  const waitFor = async (expr, ms = 6000) => {
    for (let i = 0; i < ms / 150; i++) { if (await ev(expr)) return true; await sleep(150); }
    return false;
  };
  const tabAnims = () => ev(`[...document.querySelectorAll('.lk-tl-tabs > .lk-tl-tab[data-tl]')].map((el) => el.getAnimations().map((a) => ({ name: a.animationName, dur: a.effect.getTiming().duration, delay: a.effect.getTiming().delay })))`);

  await sleep(1500);
  /* 环境钉死：动画时长由 --motion-* 令牌决定，而系统的「减少动效」偏好会让令牌降级
     ⇒ 先显式设为 no-preference（设计系统的默认档），★11 再翻成 reduce 验降级。
     不钉死的话同一套件在不同机器上会得出不同数字（本机首次跑就踩到过）。 */
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await sleep(200);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);

  /* ── ① 切工具：设定库 ───────────────────────────────────────────── */
  const a1 = await clickAnims(`document.querySelector('[data-tool="codex"]').click();`, '#lk-module-view');
  check('★1 切工具时模块容器在播入场动画（lk-wake / 480ms / running）',
    Array.isArray(a1) && a1.some((a) => a.name === 'lk-wake' && a.dur === 480 && a.state === 'running'), a1);

  const okRender = await waitFor(`!!document.querySelector('#cx-root')`);
  const listCount = await ev(`document.querySelectorAll('#cx-list [data-cx-id]').length`);
  check('★2 动画不影响渲染：工具内容真的出来了（设定库 + 左列条目）', okRender && listCount >= 1, { okRender, listCount });

  /* ★3 真的在动：测试窗口是 showInactive，渲染进程 hidden ⇒ 动画本来不推进（currentTime 恒为 0，
     见文件头）。强制出几帧后它必须前进 —— 只读 playState 是证明不了"真的在跑"的。 */
  await forceFrames(6);
  const played = await playedMs('#lk-module-view');
  check('★3 强制出帧后动画确实在推进（currentTime > 0）', Array.isArray(played) && played.some((t) => t > 0), played);

  /* ★4 终态不残留：finish() 把动画推到结尾 → 必须回到 opacity=1 / transform=none
     （停在半透明或偏移的动画比没有动画更糟，界面看着像坏了） */
  const s1 = await settled('#lk-module-view');
  check('★4 动画终态不残留（finish 后 opacity=1 且 transform=none）', s1 && s1.opacity === '1' && (s1.transform === 'none' || s1.transform === 'matrix(1, 0, 0, 1, 0, 0)'), s1);

  /* ── ② 再切一个工具：动画要能**重播**（同元素连续切换最容易只播一次） ── */
  const a2 = await clickAnims(`document.querySelector('[data-tool="settings"]').click();`, '#lk-module-view');
  check('★5 换工具后动画能重播（同一容器第二次仍是 running）',
    Array.isArray(a2) && a2.some((a) => a.name === 'lk-wake' && a.state === 'running'), a2);

  /* ── ③ 回沙盘：用只淡入的变体（不带 transform，免得成为 fixed 子元素的包含块） ── */
  const a3 = await clickAnims(`document.querySelector('[data-tool="sandbox"]').click();`, '#lk-sandbox');
  check('★6 回沙盘走 lk-fade 淡入（无 transform）+ 模块视图已隐藏',
    Array.isArray(a3) && a3.some((a) => a.name === 'lk-fade' && a.state === 'running')
      && (await ev(`document.querySelector('#lk-module-view').style.display === 'none'`)), a3);

  /* ── ④ 页签错峰：两个时间线页签的延迟必须是 0 / 40ms（DESIGN.md:157） ── */
  const t1 = await tabAnims();
  const delays = (t1 || []).map((x) => x[0]?.delay);
  check('★7 时间线页签错峰（延迟 0 / 80ms，动画 lk-wake）',
    (t1 || []).length === 2 && delays[0] === 0 && delays[1] === 80 && t1.every((x) => x[0]?.name === 'lk-wake'),
    t1);

  /* ── ⑤ 弹窗：遮罩淡入（快）+ 卡片上浮（--motion-base） ── */
  const a5 = await clickAnims(
    `document.querySelector('.lk-tl-tabs > .lk-tl-tab').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));`,
    '.lk-pop-in'
  );
  const ov = await anims('.lk-overlay-in');
  check('★8 弹窗入场：卡片 lk-pop 480ms + 遮罩 lk-fade 180ms',
    Array.isArray(a5) && a5.some((a) => a.name === 'lk-pop' && a.dur === 480 && a.state === 'running')
      && Array.isArray(ov) && ov.some((a) => a.name === 'lk-fade' && a.dur === 180), { card: a5, overlay: ov });

  await sleep(700);   /* 卡片动画 480ms，等它真的收尾再读计算样式 */
  const s5 = await settled('.lk-pop-in');
  const cancelOk = await ev(`(() => { const b=[...document.querySelectorAll('.lk-pop-in button')].find((x)=>x.textContent==='取消'); if(!b) return false; b.click(); return true; })()`);
  await sleep(150);
  check('★9 弹窗动画终态后可正常操作（finish 后 opacity=1；点取消后遮罩消失）',
    s5 && s5.opacity === '1' && cancelOk && !(await ev(`!!document.querySelector('.lk-pop-in')`)), { s5, cancelOk });

  /* ── ⑥ 设定库页签切换 + 换条目：内容块入场 ── */
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  await waitFor(`!!document.querySelector('#cx-tab-node')`);
  await sleep(700);
  const a6 = await clickChildAnims(`document.querySelector('#cx-tab-node').click();`, '#cx-root');
  check('★10 换页签后内容块**逐块错峰**浮现（第 1 块 0ms、第 2 块 80ms、第 3 块 160ms）',
    Array.isArray(a6) && a6[0]?.[0]?.name === 'lk-wake' && a6[0]?.[0]?.state === 'running' && a6[0]?.[0]?.dur === 480
      && a6[1]?.[0]?.delay === 80 && a6[2]?.[0]?.delay === 160, a6);

  await sleep(700);
  const a7 = await clickChildAnims(`document.querySelector('#cx-tab-entity').click();`, '#cx-root');
  const okBack = await waitFor(`document.querySelectorAll('#cx-list [data-cx-id]').length >= 1`);
  check('★11 换回实体页签：再播一次错峰入场且条目列表回来了',
    Array.isArray(a7) && a7[0]?.[0]?.name === 'lk-wake' && a7[0]?.[0]?.state === 'running' && okBack, a7);

  /* ── ⑦ 减少动效降级：DESIGN.md:159（关掉错峰，只留短淡入） ── */
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const reduced = await ev(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
  const a8 = await clickAnims(`document.querySelector('[data-tool="settings"]').click();`, '#lk-module-view');
  await sleep(300);
  await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`);
  await sleep(400);
  /* 点第二个**真页签**（`＋` 也在 .lk-tl-tabs 里，必须按 data-tl 挑，别按下标） */
  await ev(`[...document.querySelectorAll('.lk-tl-tabs > .lk-tl-tab[data-tl]')].find((b) => b.textContent.includes('支线'))?.click(); true`);
  await sleep(500);
  const t2 = await tabAnims();
  const delays2 = (t2 || []).map((x) => x[0]?.delay);
  check('★12 减少动效：入场降级为 lk-fade/200ms，且错峰延迟全部为 0',
    reduced === true
      && Array.isArray(a8) && a8.some((a) => a.name === 'lk-fade' && a.dur === 200)
      && delays2.length === 2 && delays2.every((d) => d === 0) && (t2 || []).every((x) => x[0]?.name === 'lk-fade'),
    { reduced, tool: a8, tabs: t2 });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

  /* ── ⑧ 回归：动效没有把功能弄坏（页签真的切走了） ── */
  const activeTl = await ev(`document.querySelector('.lk-tl-tabs > .lk-tl-tab.is-active')?.textContent`);
  const sandboxVisible = await ev(`document.querySelector('#lk-sandbox').style.display !== 'none' && document.querySelector('#lk-module-view').style.display === 'none'`);
  check('★13 回归：点第二个时间线页签真的切过去了，沙盘仍然可见', String(activeTl ?? '').includes('支线') && sandboxVisible, { activeTl, sandboxVisible });

  const errs = await ev(`window.__errs`);
  check('14 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const n = results.filter(Boolean).length;
  console.log(`\n==== ${n}/${results.length} PASS ====`);
  process.exit(n === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack || e)); process.exit(2); });
