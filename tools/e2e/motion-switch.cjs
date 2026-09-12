/* 动效（切换类）：切工具 / 开面板 / 弹窗 / 页签 —— 每一处都要**证明动画真的在跑**，
 * 而不是「看起来有」。所以断言读的是元素自己 `getAnimations()` 的 animationName + 时长 + 延迟
 * （CDP 里能直接读到 CSS 动画对象），外加「动画收尾不残留」（opacity=1 / transform=none
 * —— 停在半透明或偏移的动画比没有动画更糟，界面会像坏了）。
 *
 * 规格来源：design-system/DESIGN.md 第 7 节（慢、呼吸感、不 snappy）与 design-system/tokens.css
 * 的 --motion-* 令牌（入场 640ms = DESIGN.md:157 Waking fade 自己的时长，错峰 100ms/项）。
 * **prefers-reduced-motion 降级**也在这里验（DESIGN.md:159：关掉错峰，只留短淡入）——
 * 用 CDP 的 Emulation.setEmulatedMedia 模拟系统偏好。
 *
 * ⚠️ 入场挂在哪（用户 2026-09-12 反馈「切工具闪一下 + 元素没错开」后定的）：**整块容器不播动画**
 * （实测抓帧：容器半透明那一帧整片面板发灰 = 用户说的"闪"），改由工具根部的顶层块用
 * `cascadeIn()` 一次性错峰；因此本脚本既验「子项在错峰」也验「容器上没有动画」（★2/★6/★8）。
 *
 * 用法：先跑 seed-motion.cjs，起应用，再跑本脚本（见 tools/e2e/README.md）。
 *
 * ⚠️ **环境事实（踩过）**：测试实例用 `LINGKUANG_TEST_WINDOW_NOFOCUS=1`（showInactive）起，
 * 渲染进程的 `document.visibilityState` 是 `hidden` ⇒ **CSS 动画不推进**：`playState` 是
 * `running`，但 `currentTime` 永远是 0、计算样式停在起点（opacity 0 / translateY 8px）。
 * 所以「等 700ms 再读计算样式要求 opacity=1」这种断言在这个环境里**天然不可靠**
 * （偶尔被截图强制出帧才会推进，表现为随机挂）。本脚本因此分三步断言，都不依赖墙钟：
 *   ① 参数对不对：animationName / 时长 / 延迟 / playState（点击的同一个同步块里读）
 *   ② 真的会动：`Page.captureScreenshot` 出一帧，然后要 **animationend 事件**（动画播到结尾才会触发）。
 *      ⚠️ 不能读 `currentTime > 0`：实测这一帧往往**直接把动画推到结尾**（读完是"已播完"），
 *      中途态根本抓不到（早期版本就是这么随机挂的）。
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
  /** 读某容器**所有子项**身上的动画（错峰是按子项给的，所以要逐个看）。注意
   *  `element.getAnimations()` 默认**不含**后代（subtree 默认 false），所以容器自己的动画
   *  与子项的动画能分开验 —— 「容器不许播（会闪）」和「子项要错峰播」都要能证明。 */
  const childAnims = (parentSel) => ev(`(() => {
    const p = document.querySelector(${JSON.stringify(parentSel)});
    if (!p) return null;
    return [...p.children].map((el) => el.getAnimations().map((a) => ({ name: a.animationName, dur: a.effect.getTiming().duration, delay: a.effect.getTiming().delay, state: a.playState })));
  })()`);
  /** 子项终态：逐个 finish() 后读计算样式（每个块都必须回到不透明 + 无偏移） */
  const settledKids = (parentSel) => ev(`(() => {
    const p = document.querySelector(${JSON.stringify(parentSel)});
    if (!p) return null;
    return [...p.children].map((el) => {
      el.getAnimations().forEach((a) => { try { a.finish(); } catch (e) {} });
      const cs = getComputedStyle(el);
      return { opacity: cs.opacity, transform: cs.transform };
    });
  })()`);
  /** 强制出几帧：`Page.captureScreenshot` 会让渲染进程真的产生帧，动画的 currentTime 才会前进 */
  const forceFrames = async (n = 6) => {
    for (let i = 0; i < n; i++) { await send('Page.captureScreenshot', { format: 'jpeg', quality: 10 }); await sleep(60); }
  };
  /** 动画已经推进了多少毫秒（证明它不只是"被声明了"，而是真的在动）。
   *  ⚠️ 这个环境里**读中间态不可靠**：hidden 页面下动画不自己推进，而**第一帧往往直接把动画
   *  推到结尾**（实测：出一帧后 currentTime 不是 0 而是"已播完"、类也已被清）。
   *  所以正式断言不靠它，改用 `window.__ends`（animationend 事件）当"真的跑过"的证据。 */
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
  /* 记下每一次 animationend（动画名 / 目标 / 目标的父元素）：这是"动画真的播到结尾"的硬证据。
     隐藏窗口里动画不推进，帧被吞掉或动画从未启动时都不会有事件 —— 所以它比读中间态可靠。 */
  await ev(`(() => {
    window.__ends = [];
    document.addEventListener('animationend', (e) => {
      const el = e.target;
      window.__ends.push([e.animationName, el.id || el.className || el.tagName,
        el.parentElement ? (el.parentElement.id || el.parentElement.className) : null]);
    }, true);
    return true;
  })()`);

  /* ── ① 切工具：设定库 ───────────────────────────────────────────── */
  /* 工具是动态 import 的，DOM 建好之后 registry 才给它的顶层块挂上**一次性错峰**，所以这里
     没法跟点击写在同一个同步块里（那一刻 #cx-root 还不存在）——「点完 → 等它出现 → 再读子项」。
     窗口隐藏时动画不自己推进（见文件头），晚一点读到的仍是起点状态，读数反而稳定。 */
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  const okRender = await waitFor(`!!document.querySelector('#cx-root')`);
  const a1 = await childAnims('#cx-root');
  const hostAnim = await anims('#lk-module-view');
  check('★1 切工具：工具的顶层块逐个错峰入场（lk-wake / 640ms / 延迟 0·100·200ms）',
    Array.isArray(a1) && a1.length >= 3 && a1[0]?.[0]?.name === 'lk-wake' && a1[0]?.[0]?.dur === 640
      && a1[0]?.[0]?.state === 'running' && a1[1]?.[0]?.delay === 100 && a1[2]?.[0]?.delay === 200, a1);
  check('★2 主区容器上**没有**动画（整块淡入正是"闪一下"的来源，也盖掉了元素错峰）',
    Array.isArray(hostAnim) && hostAnim.length === 0, hostAnim);

  const listCount = await ev(`document.querySelectorAll('#cx-list [data-cx-id]').length`);
  check('★3 动画不影响渲染：工具内容真的出来了（设定库 + 左列条目）', okRender && listCount >= 1, { okRender, listCount });

  /* ★4 真的在动：这个环境里 CSS 动画不自己推进（见文件头），而且**出一帧就可能把它直接推到
     结尾**（实测：截图后 currentTime 已是"播完"、类也被清），所以不赌"读到中间态"。
     改成要 animationend 事件：动画真的播到结尾才会触发；帧被吞掉、动画从未启动都不会来。
     ⚠️ **只打一帧是不够的**（实测：单张 `Page.captureScreenshot` 后 `__ends` 仍然是空的 —— 隐藏页面
     要连续几帧才走完动画生命周期），所以按铁律 6 的姿势用 `forceFrames()` 连打。
     顺便这一条也证明了错峰收手是**靠动画播完**触发的，不是靠那个 2500ms 兜底定时器。 */
  await forceFrames(6);
  await sleep(200);
  const ends = await ev(`window.__ends`);
  check('★4 出一帧后入场动画真的播完了（收到 lk-wake 的 animationend，目标是工具的一级块）',
    Array.isArray(ends) && ends.some((x) => x[0] === 'lk-wake' && x[2] === 'cx-root'), ends);

  /* ★5 终态不残留：finish() 把动画推到结尾 → 每个块都必须回到 opacity=1 / transform=none
     （停在半透明或偏移的动画比没有动画更糟，界面看着像坏了） */
  const s1 = await settledKids('#cx-root');
  check('★5 动画终态不残留（finish 后每个块 opacity=1 且 transform=none）',
    Array.isArray(s1) && s1.length >= 3 && s1.every((x) => x.opacity === '1' && (x.transform === 'none' || x.transform === 'matrix(1, 0, 0, 1, 0, 0)')), s1);

  /* ★6 一次性错峰必须**自己收手**：播完把类与行内延迟都清掉。不清的话工具下次整块重渲染
     （codex 是 `host.innerHTML = …` 全重来）时，新建的子项会带着旧延迟再播一遍 = 改个字段闪一下。 */
  await forceFrames(8);
  await sleep(300);
  const cleaned = await ev(`(() => {
    const p = document.querySelector('#cx-root');
    if (!p) return null;
    return {
      cls: p.classList.contains('lk-enter-stagger'),
      delays: [...p.children].map((el) => el.style.animationDelay),
      anims: [...p.children].reduce((n, el) => n + el.getAnimations().length, 0),
    };
  })()`);
  check('★6 错峰播完自动收手（类与行内延迟都已清掉、动画对象归零）',
    cleaned && cleaned.cls === false && cleaned.delays.every((d) => d === '') && cleaned.anims === 0, cleaned);

  /* ── ② 换个工具：容器一样不许播（每个工具都不闪） ── */
  const a2 = await clickAnims(`document.querySelector('[data-tool="settings"]').click();`, '#lk-module-view');
  check('★7 换工具时主区容器依然无动画（设置面板也不会闪）', Array.isArray(a2) && a2.length === 0, a2);

  /* ── ③ 切回设定库：错峰要能**重播**（同一处连续切换最容易只播一次）。
     顺带守着「慢工具在切走之后才渲染完 → 把新工具盖掉」那条竞态：这里的 settings 是"刚点完
     立刻就切走"，正是它的触发条件（修复见 registry.ts 的 openTool 里那段说明）。 ── */
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  await waitFor(`!!document.querySelector('#cx-root')`);
  const a2b = await childAnims('#cx-root');
  check('★8 切回设定库：错峰入场能重播（第 1 块仍是 lk-wake / running）',
    Array.isArray(a2b) && a2b[0]?.[0]?.name === 'lk-wake' && a2b[0]?.[0]?.state === 'running' && a2b[1]?.[0]?.delay === 100, a2b);

  /* ── ④ 回沙盘：**不再整块淡入**（大块淡入与工具那边同病），沙盘只要求正常显示 ── */
  await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`);
  const a3 = await anims('#lk-sandbox');
  check('★9 回沙盘不再整块淡入（#lk-sandbox 上无动画）+ 模块视图已隐藏',
    Array.isArray(a3) && a3.length === 0
      && (await ev(`document.querySelector('#lk-module-view').style.display === 'none'`)), a3);

  /* ── ⑤ 页签错峰：两个时间线页签的延迟必须是 0 / 100ms ── */
  const t1 = await tabAnims();
  const delays = (t1 || []).map((x) => x[0]?.delay);
  check('★10 时间线页签错峰（延迟 0 / 100ms，动画 lk-wake）',
    (t1 || []).length === 2 && delays[0] === 0 && delays[1] === 100 && t1.every((x) => x[0]?.name === 'lk-wake'),
    t1);

  /* ── ⑤ 弹窗：遮罩淡入（快）+ 卡片上浮（--motion-base） ── */
  const a5 = await clickAnims(
    `document.querySelector('.lk-tl-tabs > .lk-tl-tab').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));`,
    '.lk-pop-in'
  );
  const ov = await anims('.lk-overlay-in');
  check('★11 弹窗入场：卡片 lk-pop 320ms + 遮罩 lk-fade 180ms',
    Array.isArray(a5) && a5.some((a) => a.name === 'lk-pop' && a.dur === 320 && a.state === 'running')
      && Array.isArray(ov) && ov.some((a) => a.name === 'lk-fade' && a.dur === 180), { card: a5, overlay: ov });

  await sleep(700);   /* 卡片动画 320ms，等它真的收尾再读计算样式 */
  const s5 = await settled('.lk-pop-in');
  const cancelOk = await ev(`(() => { const b=[...document.querySelectorAll('.lk-pop-in button')].find((x)=>x.textContent==='取消'); if(!b) return false; b.click(); return true; })()`);
  await sleep(150);
  check('★12 弹窗动画终态后可正常操作（finish 后 opacity=1；点取消后遮罩消失）',
    s5 && s5.opacity === '1' && cancelOk && !(await ev(`!!document.querySelector('.lk-pop-in')`)), { s5, cancelOk });

  /* ── ⑥ 设定库页签切换 + 换条目：内容块入场 ── */
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  await waitFor(`!!document.querySelector('#cx-tab-node')`);
  await sleep(700);
  const a6 = await clickChildAnims(`document.querySelector('#cx-tab-node').click();`, '#cx-root');
  check('★13 换页签后内容块**逐块错峰**浮现（第 1 块 lk-wake/640ms/0ms、第 2 块 100ms、第 3 块 200ms）',
    Array.isArray(a6) && a6[0]?.[0]?.name === 'lk-wake' && a6[0]?.[0]?.state === 'running' && a6[0]?.[0]?.dur === 640
      && a6[1]?.[0]?.delay === 100 && a6[2]?.[0]?.delay === 200, a6);

  await sleep(700);
  const a7 = await clickChildAnims(`document.querySelector('#cx-tab-entity').click();`, '#cx-root');
  const list7 = await childAnims('#cx-list');
  const okBack = await waitFor(`document.querySelectorAll('#cx-list [data-cx-id]').length >= 1`);
  check('★14 换回实体页签：再播一次错峰，左列条目还有**第二级**错峰（等 200ms 后逐条 60ms）',
    Array.isArray(a7) && a7[0]?.[0]?.name === 'lk-wake' && a7[0]?.[0]?.state === 'running' && okBack
      && Array.isArray(list7) && list7.length >= 1 && list7[0]?.[0]?.delay === 200
      && (list7.length < 2 || list7[1]?.[0]?.delay === 260), { a7, list7 });

  /* ── ⑦ 减少动效降级：DESIGN.md:159（关掉错峰，只留短淡入） ── */
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const reduced = await ev(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
  /* 这里顺带守住一个坑：`cascadeIn()` 写的是**行内** animation-delay，行内值压得过媒体查询，
     所以它必须自己读 motionReduced() 把延迟清零（只靠 CSS 降级块是不够的）。 */
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  await waitFor(`!!document.querySelector('#cx-root')`);
  const a8 = await childAnims('#cx-root');
  await sleep(300);
  await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`);
  await sleep(400);
  /* 点第二个**真页签**（`＋` 也在 .lk-tl-tabs 里，必须按 data-tl 挑，别按下标） */
  await ev(`[...document.querySelectorAll('.lk-tl-tabs > .lk-tl-tab[data-tl]')].find((b) => b.textContent.includes('支线'))?.click(); true`);
  await sleep(500);
  const t2 = await tabAnims();
  const delays2 = (t2 || []).map((x) => x[0]?.delay);
  check('★15 减少动效：入场降级为 lk-fade/200ms，且错峰延迟全部为 0（含行内延迟）',
    reduced === true
      && Array.isArray(a8) && a8.length >= 3 && a8.every((x) => x[0]?.name === 'lk-fade' && x[0]?.dur === 200 && x[0]?.delay === 0)
      && delays2.length === 2 && delays2.every((d) => d === 0) && (t2 || []).every((x) => x[0]?.name === 'lk-fade'),
    { reduced, tool: a8, tabs: t2 });

  /* 卡片级错峰也必须自己吃降级：cascadeIn 写的是**行内**延迟，媒体查询压不住（motion.ts 里那条注释） */
  await ev(`document.querySelector('[data-tool="inspire"]').click(); true`);
  await waitFor(`document.querySelectorAll('#insp-result > .tool-card').length >= 5`);
  const cardsR = await childAnims('#insp-result');
  check('★21 减少动效：卡片错峰同样归零（lk-fade/200ms、延迟全 0 —— 含行内延迟）',
    Array.isArray(cardsR) && cardsR.length >= 5
      && cardsR.every((c) => c[0]?.name === 'lk-fade' && c[0]?.dur === 200 && c[0]?.delay === 0),
    cardsR?.slice(0, 3));
  /* ⚠️ 这一块把主区切到了灵感触发器，而下一节 ★16 的前提是「沙盘可见」⇒ 必须切回去。
     （第一版就漏了这一步，★16 直接挂在 sandboxVisible=false 上。） */
  await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`);
  await sleep(400);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

  /* ── ⑧ 回归：动效没有把功能弄坏（页签真的切走了） ── */
  const activeTl = await ev(`document.querySelector('.lk-tl-tabs > .lk-tl-tab.is-active')?.textContent`);
  const sandboxVisible = await ev(`document.querySelector('#lk-sandbox').style.display !== 'none' && document.querySelector('#lk-module-view').style.display === 'none'`);
  check('★16 回归：点第二个时间线页签真的切过去了，沙盘仍然可见', String(activeTl ?? '').includes('支线') && sandboxVisible, { activeTl, sandboxVisible });

  /* ── ⑩ 卡片级错峰（灵感触发器）：块**里面**的元素也要一个个出来 ──
     用户的问法：「卡片算同一个元素吗」—— **不算**：卡片在块里面，registry 那趟顶层错峰只到
     「标题栏 / 卡片区 / 联想画布」三块，13 张卡（CHAR_GROUPS 13 组）原本跟着卡片区一起整块出来。
     现在卡片区带 `.lk-own-cascade`（父级**不许**给它整块淡入 —— 又是"洗白 + 错峰被盖"那个病，
     只是下沉一层），由 renderChar 里的 `cascadeIn(卡片区, 50ms, 封顶 720, 起 120)` 给每张卡排阶梯。
     注意 ★18 里父级那三块的延迟是 0 / 100，**跳过的不占序号**（卡片区被跳过 ⇒ 画布仍是 100ms）。 */
  await ev(`document.querySelector('[data-tool="inspire"]').click(); true`);
  const cardsOk = await waitFor(`document.querySelectorAll('#insp-result > .tool-card').length >= 5
    && !!document.querySelector('#insp-scroll')?.classList.contains('lk-enter-stagger')`);
  const cards = await childAnims('#insp-result');
  const gridSelf = await anims('#insp-result');
  const blocks10 = await childAnims('#insp-scroll');
  check('★18 灵感触发器的卡片逐个错峰入场（lk-wake/640ms、阶梯 120·170·220…），卡片区自己不整块淡入',
    cardsOk && Array.isArray(cards) && cards.length >= 5
      && cards.every((c, i) => c[0]?.name === 'lk-wake' && c[0]?.dur === 640 && c[0]?.delay === Math.min(120 + i * 50, 720))
      && Array.isArray(gridSelf) && gridSelf.length === 0
      && Array.isArray(blocks10) && blocks10.length === 3 && blocks10[1]?.length === 0
      && blocks10[0]?.[0]?.delay === 0 && blocks10[2]?.[0]?.delay === 100,
    { cardsOk, n: cards?.length, head: cards?.slice(0, 4), gridSelf, blocks10 });

  /* ★19 **反转**（用户 2026-09-12 二次要求：「重新生成改成无错分的，只有初次进入时才有错分」）。
     理由：点「重新生成」是在盯着卡片等新词，再排 13 张队只会碍事；只有"初次进入"才值得演一次。
     这里必须**同时**断言容器上那个错峰类被摘掉 —— 类只在最后一张动画结束（或 2.5s 兜底）时才清，
     而 ★18 刚打开工具，它多半还挂着；若不清，新卡片会从父类继承 `.lk-enter-stagger > *` 又错峰一遍。
     所以 renderChar 的非动画分支会显式调 stopCascade(卡片区)（见 src/ui/inspire.ts）。 */
  const rollRes = await ev(`(() => {
    document.querySelector('#insp-roll').click();
    const box = document.querySelector('#insp-result');
    const cards = [...box.children];
    return { n: cards.length, cls: box.classList.contains('lk-enter-stagger'),
      anims: cards.reduce((a, el) => a + el.getAnimations().length, 0),
      inline: cards.filter((el) => el.style.animationDelay).length,
      opacity: cards.length ? getComputedStyle(cards[0]).opacity : null };
  })()`);
  check('★19 点「重新生成」：卡片**无错峰**、直接可见（容器错峰类已摘、零动画、零行内延迟、opacity 1）',
    rollRes && rollRes.n >= 5 && rollRes.cls === false && rollRes.anims === 0 && rollRes.inline === 0 && rollRes.opacity === '1',
    rollRes);

  /* ★20 锁定词条**不重建**卡片（既有设计：只改颜色/高亮）⇒ 元素身份不变 = 不会重播错峰。
     localStorage 里的锁会跨次运行留下，所以断言写的是"高亮状态**变了**"，不假定初始方向。 */
  const lockRes = await ev(`(() => {
    const before = document.querySelector('#insp-result > .tool-card');
    if (!before) return null;
    const row = before.querySelector('.insp-lock').closest('.insp-row');
    const bg0 = row.style.background;
    before.querySelector('.insp-lock').click();
    return { sameEl: before === document.querySelector('#insp-result > .tool-card'), bgChanged: row.style.background !== bg0 };
  })()`);
  check('★20 锁定条目：卡片不重建（元素身份不变 ⇒ 不重播），行高亮照常切换',
    lockRes && lockRes.sameEl === true && lockRes.bgChanged === true, lockRes);

  /* ── ⑨ 竞态守卫：慢工具不许在切走之后把新工具盖掉 ──
     工具是「先渲染进**自己那一格**（`.lk-tool-slot`）、再把清理函数交回来」，所以**未缓存**的
     工具完全可能在**已缓存**的 codex 渲染完之后才落地。这里挑 `schema`（本套件从没点过 ⇒
     import 一定没缓存）+ codex（早就缓存了），并把两次点击放进**同一个同步块**，中间一点空档
     都不留 —— 最狠的触发方式。
     修复前实测：2.5 秒后主区仍停在慢工具（工具栏却亮着 codex）；修复见 `src/tools/registry.ts`。 */
  await ev(`document.querySelector('[data-tool="schema"]').click(); document.querySelector('[data-tool="codex"]').click(); true`);
  await sleep(700);
  const race = await ev(`(() => {
    const mv = document.querySelector('#lk-module-view');
    const first = mv.firstElementChild;
    return { slots: mv.querySelectorAll('.lk-tool-slot').length, first: first ? (first.id || first.className) : null,
      cxRoot: !!document.querySelector('#cx-root'), active: document.querySelector('.lk-tool-btn.is-active')?.getAttribute('data-tool') };
  })()`);
  check('★17 同 tick 连点两个工具：主区最终显示的是**后点**的那个（慢工具只剩一格、且已被摘掉）',
    race && race.cxRoot === true && race.active === 'codex' && race.slots === 1 && race.first === 'lk-tool-slot', race);

  const errs = await ev(`window.__errs`);
  check('★22 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const n = results.filter(Boolean).length;
  console.log(`\n==== ${n}/${results.length} PASS ====`);
  process.exit(n === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack || e)); process.exit(2); });
