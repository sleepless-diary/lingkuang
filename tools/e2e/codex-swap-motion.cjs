/* 不变量：**换条目的转场**（用户 2026-09-13 在演示页 `docs/motion-demo/doc-slide.html` 里逐轮定稿的
 * 「做法 P」，落地到 `src/ui/codex.ts` 的 `playSwap()`）。
 *
 * 规格（用户原话逐步攒出来的）：
 *   · 两个关键帧：a = 不透明度 0 + 位置在终点**右边** dx，b = 不透明度 1 + 原位；入场曲线**快→慢**；
 *   · 出场是同一条反过来（1/原位 → 0/往左 dx），曲线**慢→快**；
 *   · 「一行比一行慢一点（错峰）」，默认 10ms；
 *   · 「应该先出场再入场」⇒ 入场的延迟 = 出场时长（默认 300ms）；
 *   · 「我指的是从右向左入场时要错分，不是入场后左右弹动一下」⇒ **只走左右**，关键帧里没有 translateY；
 *   · 三个旋钮（速度 / 错峰 / 入场距离）+ 一个开关写在设置面板里，改完立刻生效。
 *
 * 本套件在**同一个同步块**里点行 + 读参数（隐藏窗口里动画不推进，只有参数是确定的，见 README 铁律 6）。
 * 用法：`node tools/e2e/seed-smooth-switch.cjs` → 起应用 → `LK_CDP_PORT=NNNN node tools/e2e/codex-swap-motion.cjs`
 */
const PORT = process.env.LK_CDP_PORT || '9334';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }

/** 读出「某一组行」上由 `el.animate()` 建的动画参数（`animationName` 为空 = 不是 CSS 类动画）。
 *  `pick` = `'in'`（`#cx-body` 里除幽灵外的行）或 `'out'`（幽灵层里的行）。 */
const READ = (pick) => `(pick => {
  const body = document.querySelector('#cx-body');
  if (!body) return null;
  const sel = '[data-cx-row], #cx-props .ed-props > *';
  const rows = pick === 'out'
    ? [...(body.querySelector('.lk-cx-ghost')?.querySelectorAll(sel) ?? [])]
    : [...body.querySelectorAll(sel)].filter((el) => !el.closest('.lk-cx-ghost'));
  const one = (el) => el.getAnimations().filter((a) => !a.animationName).map((a) => ({
    kf: a.effect.getKeyframes().map((k) => ({ o: k.opacity, t: k.transform, off: k.offset })),
    dur: a.effect.getTiming().duration, delay: a.effect.getTiming().delay, ease: a.effect.getTiming().easing,
  }));
  const ghost = body.querySelector('.lk-cx-ghost');
  return {
    n: rows.length,
    anims: rows.map(one),
    ghost: !!ghost,
    ghostIds: ghost ? ghost.querySelectorAll('[id]').length : 0,
    bodyCss: body.getAnimations().filter((a) => a.animationName).map((a) => a.animationName),
  };
})(${JSON.stringify(pick)})`;

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
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, () => res()); w.send(JSON.stringify({ id: i, method, params })); });
  const raw = async (method, params) => {
    const i = ++id;
    const p = new Promise((res) => pending.set(i, (m) => res(m)));
    w.send(JSON.stringify({ id: i, method, params }));
    return p;
  };
  const ev = async (expr) => {
    const r = await raw('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  /** 把设置面板里那三个旋钮写成新值并广播（等于用户在设置里拖动滑块） */
  const setKnobs = (patch) => ev(`(() => {
    const k = 'lingkuang-settings';
    const s = JSON.parse(localStorage.getItem(k) || '{}');
    Object.assign(s, ${JSON.stringify(patch)});
    localStorage.setItem(k, JSON.stringify(s));
    window.dispatchEvent(new CustomEvent('lingkuang-settings'));
    return JSON.parse(localStorage.getItem(k));
  })()`);
  const clickEntity = (name) => ev(`(() => {
    const b = [...document.querySelectorAll('#cx-list [data-cx-id]')].find((x) => x.querySelector('.ed-tlabel')?.textContent === ${JSON.stringify(name)});
    if (!b) return { err: 'no row' };
    b.click();
    return true;
  })()`);

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  /* 系统「减少动效」会让整条转场降级成一次短淡入 ⇒ 先钉死偏好（README 铁律：别把环境当默认） */
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  await sleep(1200);

  /* ── 前置 ── */
  const pre = await ev(`({
    rows: [...document.querySelectorAll('#cx-list [data-cx-id]')].map((b) => b.querySelector('.ed-tlabel')?.textContent),
    fields: [...document.querySelectorAll('#cx-fields > div')].length,
    bodyRows: document.querySelectorAll('#cx-body [data-cx-row]').length,
    s: JSON.parse(localStorage.getItem('lingkuang-settings') || '{}'),
  })`);
  const rowsOk = Array.isArray(pre.rows) && pre.rows.length >= 3;
  check('★0 前置：三条实体都在、中栏有字段行、设置是默认值（开 / 1× / 10ms / 32px）',
    rowsOk && pre.fields > 0 && pre.bodyRows > 0
      && pre.s.motionSwap !== false && (pre.s.motionSpeed ?? 1) === 1
      && (pre.s.motionStagger ?? 10) === 10 && (pre.s.motionEnterDx ?? 32) === 32, pre);

  /* ── ① 换实体：旧内容做幽灵往左退、新内容延后从右入 ── */
  await ev(`window.__prevFields = [...document.querySelectorAll('#cx-fields > div')].map((r) => r.firstElementChild?.textContent); true`);
  await clickEntity('霜纹剑');
  const out = await ev(READ('out'));
  const inn = await ev(READ('in'));
  check('★1 换实体时旧内容被做成一层幽灵（`#cx-body` 里的 .lk-cx-ghost），新内容在同一个框里',
    !!out && out.ghost === true && out.n > 0 && !!inn && inn.n > 0, { ghost: out?.ghost, outN: out?.n, inN: inn?.n });
  check('★2 幽灵里**没有 id**（克隆出来的 #cx-doc / #cx-fields 会把 querySelector 引到幽灵里去）',
    !!out && out.ghost === true && out.ghostIds === 0, { ghost: out?.ghost, ghostIds: out?.ghostIds });

  /* 出场：1/原位 → 0/往左 dx，慢→快，逐行 +10ms
     ⚠️ `getKeyframes()` 里的数值是**字符串**（'1'/'0' 而不是 1/0）—— 严格相等会假挂，统一转字符串比 */
  const o0 = out?.anims?.[0]?.[0];
  const o1 = out?.anims?.[1]?.[0];
  check('★3 出场关键帧 = 不透明度 1 → 0 且往**左** 32px（只有 X，没有 Y），曲线慢→快',
    !!o0 && String(o0.kf?.[0]?.o) === '1' && String(o0.kf?.[0]?.t) === 'none'
      && String(o0.kf?.[1]?.o) === '0' && String(o0.kf?.[1]?.t) === 'translateX(-32px)'
      && o0.ease === 'cubic-bezier(0.7, 0, 0.84, 0)' && o0.dur === 300, o0);

  /* 入场：0/从右 dx → 1/原位，快→慢，整体延后一个出场时长（先出后进） */
  const i0 = inn?.anims?.[0]?.[0];
  const i1 = inn?.anims?.[1]?.[0];
  check('★4 入场关键帧 = 不透明度 0 + 从右 32px → 不透明度 1 + 原位，曲线快→慢，时长 300',
    !!i0 && String(i0.kf?.[0]?.o) === '0' && String(i0.kf?.[0]?.t) === 'translateX(32px)'
      && String(i0.kf?.[1]?.o) === '1' && String(i0.kf?.[1]?.t) === 'none'
      && i0.ease === 'cubic-bezier(0.16, 1, 0.3, 1)' && i0.dur === 300, i0);
  check('★5 逐行错峰 10ms，且入场整体排在出场之后（delay = 300 + i*10）',
    !!o1 && o1.delay === 10 && !!i0 && i0.delay === 300 && !!i1 && i1.delay === 310,
    { 出场首行: o0?.delay, 出场次行: o1?.delay, 入场首行: i0?.delay, 入场次行: i1?.delay });
  check('★6 整块容器自己**没有**动画（框不动 —— 动的是框里的行）',
    !!inn && inn.bodyCss.length === 0, inn?.bodyCss);

  /* ── ② 终态：行落回原位、幽灵自己收手 ── */
  const end = await ev(`(() => {
    const body = document.querySelector('#cx-body');
    if (!body) return { n: -1 };
    const rows = [...body.querySelectorAll('[data-cx-row]')].filter((el) => !el.closest('.lk-cx-ghost'));
    if (!rows.length) return { n: 0 };   /* 旧实现没有转场 ⇒ 一行都没有，判 FAIL 而不是让脚本崩 */
    rows.forEach((el) => el.getAnimations().forEach((a) => a.finish()));
    const cs = getComputedStyle(rows[0]);
    return { n: rows.length, opacity: cs.opacity, transform: cs.transform };
  })()`);
  let ghostGone = false;
  for (let i = 0; i < 20; i++) { if (!(await ev(`!!document.querySelector('#cx-body .lk-cx-ghost')`))) { ghostGone = true; break; } await sleep(200); }
  const switched = await ev(`({ name: document.querySelector('#cx-name')?.value, fields: [...document.querySelectorAll('#cx-fields > div')].map((r) => r.firstElementChild?.textContent) })`);
  check('★7 终态：行不透明、无位移、幽灵消失，而且内容真的换成了新条目',
    end.n > 0 && end.opacity === '1' && (end.transform === 'none' || end.transform === 'matrix(1, 0, 0, 1, 0, 0)')
      && ghostGone && switched.name === '霜纹剑', { end, ghostGone, name: switched.name });
  /* ── ③ 关掉开关：立刻换，不做任何动画 ── */
  await setKnobs({ motionSwap: false });
  await sleep(300);
  await clickEntity('银发少女');
  const off = await ev(READ('in'));
  const offOut = await ev(READ('out'));
  check('★8 设置里关掉转场 → 换条目时没有幽灵层、行上一个动画都没有（瞬时换）',
    !!off && off.ghost === false && off.anims.every((x) => x.length === 0)
      && !!offOut && offOut.ghost === false, { ghost: off?.ghost, anims: off?.anims?.map((x) => x.length) });
  check('8b 关掉之后内容仍然换过去了（动画开关不该影响功能）',
    (await ev(`document.querySelector('#cx-name')?.value`)) === '银发少女');

  /* ── ④ 三个旋钮都要真的生效 ── */
  await setKnobs({ motionSwap: true, motionStagger: 30, motionEnterDx: 60, motionSpeed: 0.5 });
  await sleep(300);
  await clickEntity('雪原驿站');
  const tuned = await ev(READ('in'));
  const a0 = tuned?.anims?.[0]?.[0];
  const a1 = tuned?.anims?.[1]?.[0];
  check('★9 错峰 30ms → 行延迟变成 0 / 30 / 60…；入场距离 60px → 关键帧跟着变成 60px',
    !!a0 && !!a1 && a0.delay === 600 && a1.delay === 630
      && String(a0.kf?.[0]?.t) === 'translateX(60px)', { a0, a1 });
  check('★10 速度 0.5× → 时长翻倍到 600ms（出场同样翻倍）',
    !!a0 && a0.dur === 600 && !!tuned?.anims?.[2]?.[0] && tuned.anims[2][0].delay === 660,
    { dur: a0?.dur, 第三行: tuned?.anims?.[2]?.[0]?.delay });

  /* 复位成默认值，别把旋钮留给同一实例上后面跑的套件 */
  await setKnobs({ motionSwap: true, motionStagger: 10, motionEnterDx: 32, motionSpeed: 1 });
  await sleep(300);

  /* ── ⑤ 快速连点：一轮一套，不留残骸 ── */
  const rapid = await ev(`(async () => {
    const pick = (n) => [...document.querySelectorAll('#cx-list [data-cx-id]')].find((x) => x.querySelector('.ed-tlabel')?.textContent === n);
    pick('银发少女').click(); pick('霜纹剑').click(); pick('雪原驿站').click();
    return {
      ghosts: document.querySelectorAll('#cx-body .lk-cx-ghost').length,
      name: document.querySelector('#cx-name')?.value,
    };
  })()`);
  check('★11 同一个同步块里连点三下：幽灵层最多只有一层（不会堆起来），终态 = 最后点的那条',
    rapid.ghosts <= 1 && ['银发少女', '霜纹剑', '雪原驿站'].includes(rapid.name), rapid);

  const errs = await ev(`window.__errs`);
  check('★12 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const n = results.filter(Boolean).length;
  console.log(`\n==== ${n}/${results.length} PASS ====`);
  process.exit(n === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack || e)); process.exit(2); });
