/* 不变量：**同页签内换条目只换内容，不重建骨架**（用户 2026-09-13：「设定库中点击实体会刷新界面，
 * 我希望变成平滑切换（点击其他实体时）」）。
 *
 * 「刷新界面」在旧实现里是三件事叠在一起，这条套件逐条钉住它们：
 *   ① 整个面板 `host.innerHTML = …` 重造 ⇒ 骨架元素（#cx-root / #cx-search / 正文编辑器）**换了新元素**；
 *   ② 每次重建都播整块错峰入场 ⇒ 点开的东西又一个个冒出来（#cx-root 上挂 .lk-enter-stagger、子项有 lk-wake）；
 *   ③ #cx-root 就是滚动容器，被换掉 ⇒ **滚动位置回到顶部**。
 * 修法：同页签内换条目走 `swapBody()` —— 保住骨架，只换「名字/类型 + 字段行 + 正文」，内容区播一次
 * `.lk-swap-in`（从 .5 不透明度落位，不是从透明）。
 * **换类别**（时间线节点 ↔ 设定条目，中栏结构真的不同）原本仍走整块重建；用户 2026-09-13 又报
 * 「从事件节点切换到实体节点时，事件节点保持选中状态，且面板刷新」⇒ 两条都改掉了：换类别也只重造
 * `#cx-body` 那一块（`mountBody()`，骨架/左树/滚动位置都留着），并且**节点行的高亮要看 mode**
 * （原来只比 nodeTarget，切到实体后那一行还亮着）。★13 / ★14b / ★14c 钉住这两条。
 *
 * 用法：先 `node tools/e2e/seed-smooth-switch.cjs`，起应用，再跑本脚本。
 * ⚠️ 本套件在★11 会往「霜纹剑」的正文里打一行字（落到 vault 里），收尾停在「银发少女」上；
 *   重跑请重新播种并重启实例（★0 要求面板可滚，那是靠 seed 里那批配角撑出来的）。
 */
const fs = require('fs');
const path = require('path');
const VAULT = process.env.LINGKUANG_VAULT;
const PORT = process.env.LK_CDP_PORT || '9334';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const ENT = (type, name) => path.join(VAULT, '测试世界观', '_设定', type, name + '.md');

/* 字段行/属性行的选择器片段：**必须当模板插值**（`${ROW('标题')}`），
   不能写成 `(${ROW.toString()})('标题')` —— 那是把"选择器源码字符串"当函数调用，
   求值结果是那个字符串本身，`?.value` 恒为 undefined ⇒ 全部误报为 null（踩过，见 README）。 */
const FIELD = (k) => `[...document.querySelectorAll('#cx-fields > div')].find((r) => r.firstElementChild?.textContent === ${JSON.stringify(k)})?.querySelector('input,textarea,select')`;
const ROW = (k) => `[...document.querySelectorAll('#cx-props .ed-props > div')].find((r) => r.firstElementChild?.textContent === ${JSON.stringify(k)})?.querySelector('input,textarea,select')`;
const ANIMS = `(el) => (el && el.getAnimations ? el.getAnimations() : []).map((a) => ({ name: a.animationName || a.transitionProperty || '', play: a.playState, dur: a.effect.getTiming().duration }))`;

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

  /** 记下当前这几个元素（后面用身份比对判断"骨架有没有被重建"）。
   *  顺带在页面里装一个 `window.__geoNow()`：量"**框**在哪儿"（左树 / 帧条 / 中右栏 / 顶栏那组控件的
   *  top 与高）。★13 只管"元素有没有被换掉"，量不到"位置有没有变"—— 用户报的 y 跳 7px 就是后者。 */
  const mark = () => ev(`(() => {
    window.__s = { root: document.querySelector('#cx-root'), search: document.querySelector('#cx-search'),
      list: document.querySelector('#cx-list'), doc: document.querySelector('#cx-doc .ProseMirror'),
      props: document.querySelector('#cx-props'), rail: document.querySelector('#cx-rail') };
    /* ⚠️ #cx-root 自己就是滚动容器：直接读 getBoundingClientRect().top 会把**滚动位置**算进来
       （★6 刚滚过 260px，基线就整体高 260 ⇒ 回程时对不上，实测假挂一次）。
       所以换算成「面板内容原点」里的坐标：top 减去 rootRect.top 再加上 root.scrollTop ⇒ 与滚动无关。
       ⚠️ 帧条自 2026-09-13 起是**过渡**出场（宽/高/位移/透明度），而隐藏窗口里过渡不会自己走完
       ⇒ 量之前先把过渡推到终态（finish()），否则量到的是起点（"收起了却还是 176px 宽"）。 */
    window.__geoNow = () => {
      const root = document.querySelector('#cx-root');
      const rr = root ? root.getBoundingClientRect() : { top: 0 };
      const st = root ? root.scrollTop : 0;
      const g = (sel) => { const el = document.querySelector(sel); if (!el) return null;
        void el.getBoundingClientRect();                  /* 先强制重算 ⇒ 过渡对象才存在 */
        el.getAnimations().forEach((a) => a.finish());
        const r = el.getBoundingClientRect();
        return { t: Math.round(r.top - rr.top + st), h: Math.round(r.height), w: Math.round(r.width),
          off: el.classList.contains('is-off'),
          vis: getComputedStyle(el).display === 'none' ? 'none' : getComputedStyle(el).visibility }; };
      return { list: g('#cx-list'), rail: g('#cx-rail'), body: g('#cx-body'), newbox: g('#cx-newbox') };
    };
    /* 帧条那次出入场动画的**规格**（过渡属性 / 时长 / 起点与终态）—— 见 ★13c。 */
    window.__railProbe = () => {
      const r = document.querySelector('#cx-rail');
      if (!r) return { missing: true };
      const cs = getComputedStyle(r);
      const trans = cs.transitionProperty;
      const anims = r.getAnimations();
      const tr = anims.map((a) => ({ prop: a.transitionProperty || null, dur: Math.round(a.effect.getTiming().duration) }));
      const off = r.classList.contains('is-off');
      const w0 = Math.round(r.getBoundingClientRect().width);
      const o0 = Number(cs.opacity);
      anims.forEach((a) => a.finish());
      return { off, trans, tr, w0, o0,
        collapsed: r.classList.contains('is-collapsed'),   /* 高度"演完才收"用的类，见 ★13c */
        w1: Math.round(r.getBoundingClientRect().width), h1: Math.round(r.getBoundingClientRect().height),
        o1: Number(getComputedStyle(r).opacity), inDom: r.isConnected };
    };
    return Object.fromEntries(Object.entries(window.__s).map(([k, v]) => [k, !!v]));
  })()`);
  const same = (key) => ev(`document.querySelector(${JSON.stringify({ root: '#cx-root', search: '#cx-search', list: '#cx-list', doc: '#cx-doc .ProseMirror', props: '#cx-props', rail: '#cx-rail' }[key])}) === window.__s.${key}`);

  /** 点左列某一行的实体，并在**同一个同步块**里把动画状态读出来（隐藏窗口只读得到参数，
   *  见 README 铁律 6：出帧与否会让 currentTime 有/无，参数才是确定的）。
   *  换内容的动效自 2026-09-13 起是**行级转场**（做法 P）：旧内容做成一层幽灵往左退场、
   *  新内容延后从右淡入，逐行错峰 —— 参数（关键帧/时长/延迟/曲线）都由 `el.animate()` 给，
   *  CSS 那边一条动画都没有（`animationName` 为空就是"不是 CSS 动画"）。 */
  const clickEntity = (name) => ev(`(() => {
    const b = [...document.querySelectorAll('#cx-list [data-cx-id]')].find((x) => x.querySelector('.ed-tlabel')?.textContent === ${JSON.stringify(name)});
    if (!b) return { err: 'no row ' + ${JSON.stringify(name)} };
    b.click();
    const anims = ${ANIMS};
    const root = document.querySelector('#cx-root');
    const body = document.querySelector('#cx-body');
    const subs = [...root.children].flatMap((c) => anims(c));
    const ghost = body ? body.querySelector('.lk-cx-ghost') : null;
    const info = (el) => (el ? el.getAnimations().filter((a) => !a.animationName).map((a) => ({
      kf: a.effect.getKeyframes().map((k) => ({ o: k.opacity, t: k.transform })),
      dur: a.effect.getTiming().duration, delay: a.effect.getTiming().delay, ease: a.effect.getTiming().easing,
    })) : []);
    return {
      stagger: root.classList.contains('lk-enter-stagger'),
      listStagger: (document.querySelector('#cx-list') || {}).classList?.contains?.('lk-enter-stagger') ?? null,
      wake: subs.filter((a) => a.name === 'lk-wake').length,
      delayed: [...root.children].filter((c) => c.style && c.style.animationDelay).length,
      bodyCss: body ? anims(body).filter((a) => a.name) : [],
      ghost: !!ghost,
      ghostIds: ghost ? ghost.querySelectorAll('[id]').length : 0,
      out: info(ghost ? ghost.querySelector('[data-cx-row]') : null),
      in: info(body ? [...body.querySelectorAll('[data-cx-row]')].find((el) => !el.closest('.lk-cx-ghost')) : null),
    };
  })()`);

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  /* ⚠️ 必须等**工具打开那一次**错峰自己收手（cascadeIn 的兜底定时器 = maxDelay 500 + 2000ms）。
     隐藏窗口里动画不推进 ⇒ animationend 不会来，类只能等这个定时器摘；
     等不到的话 #cx-root 上会残留 .lk-enter-stagger 与子项行内延迟，
     ★8「换条目不再重播错峰」就会被上一次工具打开污染（实测踩到，白查一轮）。
     用**轮询**而不是固定 sleep：工具是动态 import 的，错峰起点比点击晚几百毫秒，
     固定等待正好压在边界上（2800ms 时有时还没收手，A/B 里就翻车过一次）。 */
  const clean = `(() => { const r = document.querySelector('#cx-root');
    return !!r && !r.classList.contains('lk-enter-stagger') && [...r.children].every((c) => !c.style.animationDelay); })()`;
  for (let i = 0; i < 32; i++) { if (await ev(clean)) break; await sleep(250); }

  /* ── 前置 ── */
  const pre = await ev(`(() => {
    const root = document.querySelector('#cx-root');
    return {
      rows: [...document.querySelectorAll('#cx-list [data-cx-id]')].map((b) => b.querySelector('.ed-tlabel')?.textContent),
      fields: [...document.querySelectorAll('#cx-fields > div')].map((r) => r.firstElementChild?.textContent),
      name: document.querySelector('#cx-name')?.value,
      scrollable: !!root && root.scrollHeight > root.clientHeight + 40,
      rootOverflow: root ? getComputedStyle(root).overflow : null,
      baselineClean: !!root && !root.classList.contains('lk-enter-stagger')
        && [...root.children].every((c) => !c.style.animationDelay),
    };
  })()`);
  const rowsOk = Array.isArray(pre.rows) && ['银发少女', '霜纹剑', '雪原驿站'].every((n) => pre.rows.includes(n));
  check('★0 前置：面板已开、三个实体都在、面板可滚、上一次错峰已收手（干净的基线）',
    rowsOk && pre.scrollable && pre.rootOverflow === 'auto' && pre.baselineClean, pre);

  /* ── ① 换实体：骨架必须留在原地 ── */
  await mark();
  const r1 = await clickEntity('雪原驿站');
  await sleep(400);
  check('★1 换实体后 #cx-root 还是同一个元素（旧实现是 host.innerHTML 换新元素）', await same('root'), r1);
  check('★2 搜索框还是同一个元素（旧实现连它一起重造，正在输入就会丢焦点）', await same('search'), null);
  check('★3 正文编辑器实例没被销毁重建（.ProseMirror 是同一个元素）', await same('doc'), null);

  /* ── ② 换的**内容**对不对 ── */
  const c1 = await ev(`(() => ({
    name: document.querySelector('#cx-name')?.value,
    climate: ${FIELD('气候')}?.value,
    hasHair: !!${FIELD('发色')},
    fields: [...document.querySelectorAll('#cx-fields > div')].map((r) => r.firstElementChild?.textContent),
    doc: document.querySelector('#cx-doc .ProseMirror')?.textContent ?? null,
  }))()`);
  check('★4 名字与字段换成新实体的（发色 那一行应当整行消失 = 字段集合真的换了）',
    c1.name === '雪原驿站' && c1.climate === '常年风雪' && c1.hasHair === false, c1);
  check('★5 正文跟着换成新实体的（既要有新的、也不能残留上一条的）',
    String(c1.doc ?? '').includes('驿站里只有一盏灯还亮着') && !String(c1.doc ?? '').includes('雪原独行'), c1.doc);

  /* ── ③ 滚动位置不能回到顶部 ── */
  const s0 = await ev(`(() => { const r = document.querySelector('#cx-root'); r.scrollTop = 260; return r.scrollTop; })()`);
  const r2 = await clickEntity('霜纹剑');
  await sleep(300);
  const s1 = await ev(`document.querySelector('#cx-root').scrollTop`);
  check('★6 换实体后滚动位置没回到顶部（旧实现换了滚动容器 ⇒ 恒为 0）', s0 > 100 && s1 >= s0 - 8, { 点前: s0, 点后: s1, anim: r2 });

  /* ── ④ 左列高亮跟过去（新 UI 用 `.is-on` 类高亮，不再是行内背景色） ── */
  const hl = await ev(`(() => {
    const on = [...document.querySelectorAll('#cx-list [data-cx-id]')].filter((b) => b.classList.contains('is-on'));
    return { on: on.map((b) => b.querySelector('.ed-tlabel')?.textContent ?? ''), n: on.length };
  })()`);
  check('★7 左列选中高亮只落在新条目上', hl.n === 1 && hl.on[0] === '霜纹剑', hl);

  /* ── ⑤ 没有整块错峰重播，改成行级转场（旧内容往左退 → 新内容从右入） ── */
  check('★8 换实体**不再**重播整块错峰（无 .lk-enter-stagger、子项无 lk-wake、无行内延迟）',
    r1.stagger === false && r1.listStagger === false && r1.wake === 0 && r1.delayed === 0, r1);
  /* ⚠️ `getKeyframes()` 里的数值是**字符串**（'1'/'0'），别用严格相等 —— 会假挂 */
  check('★9 内容区改播行级转场：旧内容做了一层幽灵、新内容从右淡入（同同步块读到参数）',
    r1.bodyCss.length === 0 && r1.ghost === true
      && r1.out.length === 1 && String(r1.out[0].kf?.[0]?.o) === '1' && String(r1.out[0].kf?.[1]?.t ?? '').includes('-32px')
      && r1.in.length === 1 && String(r1.in[0].kf?.[0]?.o) === '0' && String(r1.in[0].kf?.[0]?.t ?? '').includes('32px')
      && r1.in[0].delay >= 300, { out: r1.out, in: r1.in, ghost: r1.ghost, bodyCss: r1.bodyCss });

  /* ── ⑥ 转场终态：行落到原位、幽灵层自己消失（推到结尾再读计算样式） ── */
  const end = await ev(`(() => {
    const b = document.querySelector('#cx-body');
    if (!b) return null;   /* 修复前的骨架里根本没有这个元素 → 直接判 FAIL，别让脚本崩在这里 */
    const rows = [...b.querySelectorAll('[data-cx-row]')].filter((el) => !el.closest('.lk-cx-ghost'));
    rows.forEach((el) => el.getAnimations().forEach((a) => a.finish()));
    const cs = getComputedStyle(rows[0] ?? b);
    return { rows: rows.length, opacity: cs.opacity, transform: cs.transform };
  })()`);
  const ghostGone = await (async () => {
    for (let i = 0; i < 20; i++) { if (!(await ev(`!!document.querySelector('#cx-body .lk-cx-ghost')`))) return true; await sleep(200); }
    return false;
  })();
  check('★10 转场终态：行落回原位（不透明无位移），且幽灵层演完自己消失',
    !!end && end.rows > 0 && end.opacity === '1' && (end.transform === 'none' || end.transform === 'matrix(1, 0, 0, 1, 0, 0)') && ghostGone,
    { end, ghostGone });

  /* ── ⑦ 编辑器复用之后，正文归属仍然不能串（这是复用带来的新风险） ── */
  const typeNoBlur = async (text) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      for (let i = 0; i < 20; i++) { if (await ev(`!!document.querySelector('#cx-doc .ProseMirror')`)) break; await sleep(150); }
      const focused = await ev(`(() => { const el = document.querySelector('#cx-doc .ProseMirror'); if (!el) return false; el.focus(); return el.contains(document.activeElement); })()`);
      if (focused) await send('Input.insertText', { text });
      for (let i = 0; i < 10; i++) {
        if (String(await ev(`document.querySelector('#cx-doc .ProseMirror')?.textContent ?? ''`)).includes(text)) return true;
        await sleep(150);
      }
    }
    return false;
  };
  const typed = await typeNoBlur('霜纹剑补记。');
  await clickEntity('银发少女');   /* 程序化点击 = 不触发 blur，正文仍是"脏"的 */
  const fileOk = await (async () => {
    for (let i = 0; i < 60; i++) { if (read(ENT('物品', '霜纹剑')).includes('霜纹剑补记')) return true; await sleep(250); }
    return false;
  })();
  const after = await ev(`document.querySelector('#cx-doc .ProseMirror')?.textContent ?? null`);
  check('★11 打字后不失焦直接换条目：字落在**原来那条**的 .md 里，且没串进新条目',
    typed && fileOk && !read(ENT('角色', '银发少女')).includes('霜纹剑补记'), { typed, fileOk, 角色: read(ENT('角色', '银发少女')).slice(-40) });
  check('★12 换过去之后正文框显示的是新条目自己的正文',
    String(after ?? '').includes('雪原独行') && !String(after ?? '').includes('霜纹剑补记'), after);

  /* ── ⑧ 换**类别**（实体 → 节点）也**就地**换 —— 骨架不用动：左树装着两类条目、顶栏只需显隐、
     帧条元素常驻。这里逐条断言"没有整块重建"的三个症状（换新元素 / 重播错峰 / 内容区动画）。 */
  await mark();
  /* 换类别之前的"框位置"基线（此刻是实体态）。下面 ★13b / ★14d 都拿它比。 */
  const geo = { before: await ev(`window.__geoNow()`) };
  const tab = await ev(`(() => {
    const row = document.querySelector('#cx-list .ed-tnode-item[data-act="node"]');
    if (!row) return { missing: '#cx-list [data-act=node]' };
    row.click();
    const anims = ${ANIMS};
    const root = document.querySelector('#cx-root');
    const body = document.querySelector('#cx-body');
    const rows = body ? [...body.querySelectorAll('[data-cx-row]')].filter((el) => !el.closest('.lk-cx-ghost')) : [];
    return {
      sameRoot: document.querySelector('#cx-root') === window.__s.root,
      stagger: root.classList.contains('lk-enter-stagger'),
      wake: [...root.children].flatMap((c) => anims(c)).filter((a) => a.name === 'lk-wake').length,
      delayed: [...root.children].filter((c) => c.style && c.style.animationDelay).length,
      bodyCss: body ? anims(body).filter((a) => a.name).map((a) => a.name) : [],
      ghost: !!(body && body.querySelector('.lk-cx-ghost')),
      rowAnims: rows.reduce((n, el) => n + el.getAnimations().filter((a) => !a.animationName).length, 0),
      entOnAfter: [...document.querySelectorAll('#cx-list [data-cx-id]')].filter((b) => b.classList.contains('is-on')).length,
      nodeOnAfter: [...document.querySelectorAll('#cx-list .ed-tnode-item[data-act="node"]')].filter((b) => b.classList.contains('is-on')).length,
      /* ⚠️ 顺序有讲究：geoNow() 会把过渡 finish() 到终态 ⇒ 必须先读 railProbe()
         （它要抓"过渡正在飞"的那一刻：属性名/时长/起点）。反过来读就永远拿到空数组、宽度已经是 0。 */
      rail: window.__railProbe(),
      railSame: document.querySelector('#cx-rail') === window.__s.rail,
      geo: window.__geoNow(),
      newbox: (() => {
        const box = document.querySelector('#cx-newbox');
        const ent = document.querySelector('#cx-new-entity');
        const nod = document.querySelector('#cx-new-node');
        const btn = document.querySelector('#cx-new');
        const t = btn ? btn.querySelector('.lk-roll__t') : null;
        const prevRoll = btn ? btn.querySelector('.lk-roll__prev') : null;
        const vis = (el) => (el ? getComputedStyle(el).display !== 'none' : null);
        const off = (sel) => [...document.querySelectorAll(sel)].map((el) => el.disabled);
        /* 滚字那一对动画的关键帧（用户 2026-09-14：「新建实体按钮里面实体和节点文字的切换
           做成类似老虎机的上下切换」）—— 必须在点击的**同一个同步块**里读。 */
        const kf = (el) => (el ? el.getAnimations().filter((a) => !a.animationName).map((a) => a.effect.getKeyframes().map((k) => String(k.transform))) : []);
        /* 那一对动画的时长/延迟也要（判"两段错开播"用）—— 同样得在这个同步块里读。 */
        const timing = (el) => (el ? el.getAnimations().filter((a) => !a.animationName).map((a) => {
          const t2 = a.effect.getTiming(); return { dur: t2.duration, delay: t2.delay };
        }) : []);
        const rollBox = btn ? btn.querySelector('.lk-roll') : null;   /* 裁切盒（别看错：box 是 #cx-newbox） */
        return { h: box ? Math.round(box.getBoundingClientRect().height) : null,
          entVis: vis(ent), nodeVis: vis(nod),
          entOff: off('#cx-new-entity select, #cx-new-entity input'), nodeOff: off('#cx-new-node select, #cx-new-node input'),
          labels: box ? [...box.querySelectorAll('.lk-newlbl')].map((el) => el.textContent) : [],
          /* 用户 2026-09-14：「我希望滚动的只有实体和节点两个字」⇒ 不动的「＋新建」放在裁切盒**外面**，
             盒里只有那两个字（字段名 label）；text = 前缀 + 那个字 = 用户在按钮上看到的整句。
             ⚠️ 不能直接读 btn.textContent：这一刻盒子里还挂着克隆的旧字（lk-roll__prev），
             会读成「＋新建节点实体」（第一版就是这么假挂的）。 */
          fix: btn && btn.firstChild ? (btn.firstChild.textContent || '') : null,
          text: btn && btn.firstChild ? ((btn.firstChild.textContent || '') + (t ? (t.textContent || '') : '')).trim() : null,
          boxH: rollBox ? Math.round(rollBox.getBoundingClientRect().height) : null,
          boxOvf: rollBox ? getComputedStyle(rollBox).overflow : null,
          wordH: t ? Math.round(t.getBoundingClientRect().height) : null,
          label: t ? (t.textContent || '').trim() : null,
          rollOut: prevRoll ? kf(prevRoll)[0] : null, rollIn: t ? kf(t)[0] : null,
          rollOutT: prevRoll ? timing(prevRoll)[0] : null, rollInT: t ? timing(t)[0] : null };
      })(),
    };
  })()`);
  await sleep(500);
  check('★13 换类别（实体 → 时间线节点）也**就地**换：骨架同一元素、不重播整块错峰、改播行级转场',
    tab.sameRoot === true && tab.stagger === false && tab.wake === 0 && tab.delayed === 0
      && tab.bodyCss.length === 0 && tab.ghost === true && tab.rowAnims > 0
      && tab.entOnAfter === 0 && tab.nodeOnAfter === 1, tab);
  /* 用户 2026-09-13 深夜：「事件节点和设定实体切换时，元素 y 坐标会变，**应该是增加实体按钮的出现与
     消失导致的**」—— 正是它：那个按钮高 28px、头行文字只有 21px，整组 `display:none` 之后头行矮 7px，
     下面所有元素跟着上下跳。修法 = 两组控件都在骨架里，只切**组自身**的显隐（都是「下拉 + 按钮」，
     高度一样）。这条钉住"框不动"，与 ★13 的"骨架不重建"是两件事：**重建没发生 ≠ 位置没变**。
     同日用户又提：「添加实体按钮在事件节点中其实可以改成添加节点的」⇒ 节点态显示的是「＋新建节点」。 */
  check('★13b 换类别时框的位置与高度一律不动，且顶栏换成了「＋新建节点」那组（另一组藏起来并禁用）',
    !!geo.before && !!tab.geo
      && tab.geo.list.t === geo.before.list.t && tab.geo.body.t === geo.before.body.t
      && tab.geo.newbox.t === geo.before.newbox.t && tab.geo.newbox.h === geo.before.newbox.h
      && tab.newbox.h === geo.before.newbox.h
      && tab.geo.rail.t === geo.before.rail.t
      && geo.before.rail.off === false && geo.before.rail.w > 100
      && tab.newbox.entVis === false && tab.newbox.nodeVis === true
      && tab.newbox.entOff.length > 0 && tab.newbox.entOff.every((d) => d === true)
      && tab.newbox.nodeOff.length > 0 && tab.newbox.nodeOff.every((d) => d === false)
      && String(tab.newbox.text).includes('新建节点'),
    { before: geo.before, after: tab.geo, newbox: tab.newbox });

  /* ── 顶栏那两个控件的说明性小标签 ──
     用户 2026-09-14：「新建实体左边两个按钮有什么用」—— 它们长得像按钮、也没说清是干什么的
     （一个是「新条目属于哪个类型」的下拉，一个是「一次建几个」的数量框）。
     现在各挂一个 `.lk-newlbl`（类型 / 时间线 / 数量），两组各两个。 */
  check('★13g 顶栏两个控件各有一句说明（实体态：类型 + 数量；节点态：时间线 + 数量）',
    Array.isArray(tab.newbox.labels) && tab.newbox.labels.length === 4
      && tab.newbox.labels.join('|') === '类型|数量|时间线|数量',
    tab.newbox.labels);

  /* ── 「＋新建实体 ↔ ＋新建节点」是**滚**着换字的 ──
     用户 2026-09-14：「新建实体按钮里面实体和节点文字的切换做成类似老虎机的上下切换」。
     原来两个按钮交替显隐 —— 换的是元素，滚字无从谈起；现在只有一个按钮 `#cx-new`，
     换类别时把旧字克隆一份（`.lk-roll__prev`）往上滚出、真标签从下滚入。
     同日用户报「**新建实体按钮文字会重叠**」+「**我希望滚动的只有实体和节点两个字**」⇒ 两条：
     ① 不动的「＋新建」放在裁切盒外面，盒里只有那两个字（整串一起滚的话，前缀那半截也留在盒里）；
     ② **滚一格的距离 = 裁切盒自己的高度**（旧写法写死 13px < 一行字高 16px ⇒ 旧字新字在盒里
        始终叠着 3px，看着就是"文字重叠"）。这条把"滚动距离 ≥ 一行的字高"钉死。 */
  const rollNum = (kf) => (Array.isArray(kf) ? kf.map((s) => { const m = /translateY\((-?[\d.]+)px\)/.exec(String(s)); return m ? Number(m[1]) : null; }) : null);
  const outN = rollNum(tab.newbox.rollOut);
  const inN = rollNum(tab.newbox.rollIn);
  check('★13d 换类别时只有按钮上那两个字滚一格（旧字往上滚出、新字从下滚入），「＋新建」不动',
    tab.newbox.fix === '＋新建' && tab.newbox.label === '节点' && tab.newbox.text === '＋新建节点'
      && Array.isArray(outN) && outN.length === 2 && outN[0] === 0 && outN[1] < 0
      && Array.isArray(inN) && inN.length === 2 && inN[0] > 0
      && String(tab.newbox.rollIn[1]) === 'none' && String(tab.newbox.rollOut[0]) === 'translateY(0px)',
    { fix: tab.newbox.fix, label: tab.newbox.label, text: tab.newbox.text, out: tab.newbox.rollOut, in: tab.newbox.rollIn, outN, inN });

  /* 滚一格的距离必须**不小于一行字高**，否则旧字与新字在裁切盒里叠着（用户报的"文字重叠"）。 */
  check('★13d3 滚动距离 = 裁切盒高度（≥ 一行字高），所以旧字新字永不叠在一起',
    tab.newbox.boxOvf === 'hidden'
      && tab.newbox.boxH > 0 && tab.newbox.boxH === tab.newbox.wordH
      && outN[1] === -tab.newbox.boxH && inN[0] === tab.newbox.boxH,
    { boxH: tab.newbox.boxH, wordH: tab.newbox.wordH, ovf: tab.newbox.boxOvf, outN, inN });

  /* ★13d4 两段**错开播**，不同时：几何上首尾相接到"刚好不叠"还不够 —— 同时播时两行字各露半截、
     又都半透明，看上去仍是两层笔画糊在一起（用户第二轮反馈的「节点和实体两个文字会重叠」）。
     新字入场必须等旧字走完（`in.delay === out.dur`）。 */
  check('★13d4 旧字先走、新字后到（新字延迟 = 旧字时长 ⇒ 任何一帧只有一行字在身上）',
    !!tab.newbox.rollOutT && !!tab.newbox.rollInT
      && tab.newbox.rollOutT.delay === 0
      && tab.newbox.rollOutT.dur === tab.newbox.rollInT.dur
      && tab.newbox.rollInT.delay === tab.newbox.rollOutT.dur,
    { out: tab.newbox.rollOutT, in: tab.newbox.rollInT });

  /* ── 帧条（演变）的**出入场动画** ──
     用户 2026-09-13：「演变窗口消失时编辑页的切换很生硬，顺便再给演变做一下出入场动画」。
     旧写法是 `rail.style.display = 'none' | ''` 硬切 ⇒ 面板宽度瞬间变化。现在帧条**常驻**，
     只加 `.is-off`（宽/高/位移/透明度过渡），元素绝不离开 DOM。 */
  check('★13c 帧条是**演**着收起来的，不是硬切：元素常驻 + `.is-off` + 宽/位移/透明度过渡（176px→0、不透明→透明）',
    tab.railSame === true && tab.rail.inDom === true
      && tab.rail.off === true
      && String(tab.rail.trans).includes('width')
      && tab.rail.tr.some((x) => x.prop === 'width') && tab.rail.tr.some((x) => x.prop === 'margin-left')
      && tab.rail.tr.every((x) => x.dur > 0) && tab.rail.tr.length >= 3
      && tab.rail.w0 > 100 && tab.rail.o0 === 1
      && tab.rail.w1 === 0 && tab.rail.o1 === 0
      /* ⚠️ 同一 tick 里**高度必须还撑着**：`height: auto → 0` 不是可插值长度，写在 `.is-off` 里会
         **瞬时**生效，`overflow: hidden` 当场把内容裁没 —— 用户 2026-09-13 报的
         「从设定文件切换到节点文件演变面板会直接消失」就是这个（实测 h 从 271 变 1，而宽度才刚起步）。 */
      && tab.rail.h1 > 0 && !tab.rail.collapsed,
    { rail: tab.rail, trans: tab.rail.trans });

  /* 演完之后高度才收（`.is-collapsed` 由 JS 在 420ms 后加）—— 收的这一刻整条已经透明，看不出来 */
  await sleep(700);
  const railLate = await ev(`(() => { const r = document.querySelector('#cx-rail');
    return { collapsed: r.classList.contains('is-collapsed'), h: Math.round(r.getBoundingClientRect().height),
      w: Math.round(r.getBoundingClientRect().width) }; })()`);
  check('★13c2 收起演完才把高度收掉（`.is-collapsed` + 宽高都 0），那 320ms 因此是**看得见**的收起',
    railLate.collapsed === true && railLate.h === 0 && railLate.w === 0, railLate);

  /* 滚字也得收干净：克隆出来的旧字要摘掉、动画要取消（留着会让"换类别后不许有动画"那几条守卫失灵）。
     ⚠️ 用**轮询**等它收干净，别用固定 sleep：隐藏窗口里 `finished` 不一定 resolve，真正的收手靠
     `rollText` 的兜底定时器（`dur*2 + 600` = 960ms）—— 固定等 700ms 会压在边界上假挂。 */
  const rollLateOf = async () => ev(`(() => { const btn = document.querySelector('#cx-new');
    const t = btn ? btn.querySelector('.lk-roll__t') : null;
    const fix = btn && btn.firstChild ? (btn.firstChild.textContent || '') : '';
    return { prev: btn ? btn.querySelectorAll('.lk-roll__prev').length : -1,
      anims: t ? t.getAnimations().length : -1,
      text: fix + (t ? (t.textContent || '') : '') }; })()`);
  const rollGone = await (async () => {
    for (let i = 0; i < 30; i++) { const r = await rollLateOf(); if (r.prev === 0 && r.anims === 0) return true; await sleep(120); }
    return false;
  })();
  const rollLate = await rollLateOf();
  check('★13d2 滚字收干净：旧字克隆摘掉、标签上没有残留动画（兜底定时器兜住隐藏窗口里不推进的动画）',
    rollGone && rollLate.prev === 0 && rollLate.anims === 0 && rollLate.text === '＋新建节点', rollLate);

  /* ── ⑨ 节点→节点也要就地换 ──
     左栏重做后列表形态**直接摊平**了节点行（不再需要先展开 世界→时间线→种类），
     所以这里不用再点开树，`[data-act="node"]` 就在列表里。 */
  const pickNode = (title) => ev(`(() => {
    const el = [...document.querySelectorAll('[data-act="node"]')].find((r) => r.querySelector('.ed-tlabel')?.textContent === ${JSON.stringify(title)});
    if (!el) return false; el.click(); return true;
  })()`);
  const picked1 = await pickNode('王国的建立');
  await sleep(400);
  const node1 = await ev(`(() => ({ title: ${ROW('标题')}?.value ?? null, keys: [...document.querySelectorAll('#cx-props .ed-props > div')].map((r) => r.firstElementChild?.textContent).filter(Boolean) }))()`);
  await mark();
  const picked2 = await pickNode('第一次魔潮');
  await sleep(400);
  const node2 = await ev(`(() => ({
    title: ${ROW('标题')}?.value ?? null,
    desc: ${ROW('描述')}?.value ?? null,
    doc: document.querySelector('#cx-doc .ProseMirror')?.textContent ?? null,
    path: document.querySelector('#cx-nodepath')?.textContent ?? null,
  }))()`);
  const sameRoot = await same('root');
  const sameProps = await same('props');
  check('★14 换节点：中栏属性面板与右栏正文都换成新节点，且骨架/面板宿主元素没被重建',
    picked1 && picked2 && node1.title === '王国的建立' && node2.title === '第一次魔潮'
      && String(node2.desc ?? '').includes('魔潮') && String(node2.doc ?? '').includes('森林被冻住')
      && !String(node2.doc ?? '').includes('基石落地') && sameRoot && sameProps,
    { node1, node2, sameRoot, sameProps });

  /* ── ⑨b 换回实体（节点 → 实体）：**用户 2026-09-13 报的那一条** ──
     「从事件节点切换到实体节点时，事件节点保持选中状态，且面板刷新」：
       · 高亮：节点行的 `is-on` 只比 nodeTarget、没看 mode ⇒ 切到实体后那一行还亮着；
       · 刷新：跨类别走整块 render ⇒ 左树重播错峰 + 滚动回顶 + tiptap 重建。 */
  const nodeOnBefore = await ev(`[...document.querySelectorAll('#cx-list .ed-tnode-item[data-act="node"]')].filter((b) => b.classList.contains('is-on')).length`);
  const sBefore = await ev(`(() => { const r = document.querySelector('#cx-root'); r.scrollTop = 0; return r.scrollHeight > r.clientHeight + 40; })()`);
  await mark();
  const back = await ev(`(() => {
    const b = [...document.querySelectorAll('#cx-list [data-cx-id]')].find((x) => x.querySelector('.ed-tlabel')?.textContent === '银发少女');
    if (!b) return { err: 'no entity row 银发少女' };
    b.click();
    const anims = ${ANIMS};
    const root = document.querySelector('#cx-root');
    const body = document.querySelector('#cx-body');
    const rows = body ? [...body.querySelectorAll('[data-cx-row]')].filter((el) => !el.closest('.lk-cx-ghost')) : [];
    return {
      sameRoot: document.querySelector('#cx-root') === window.__s.root,
      stagger: root.classList.contains('lk-enter-stagger'),
      delayed: [...root.children].filter((c) => c.style && c.style.animationDelay).length,
      bodyCss: body ? anims(body).filter((a) => a.name).map((a) => a.name) : [],
      ghost: !!(body && body.querySelector('.lk-cx-ghost')),
      rowAnims: rows.reduce((n, el) => n + el.getAnimations().filter((a) => !a.animationName).length, 0),
      geo: window.__geoNow(),
    };
  })()`);
  await sleep(400);
  const st2 = await ev(`(() => ({
    name: document.querySelector('#cx-name')?.value ?? null,
    nodeOn: [...document.querySelectorAll('#cx-list .ed-tnode-item[data-act="node"]')].filter((b) => b.classList.contains('is-on')).map((b) => b.querySelector('.ed-tlabel')?.textContent ?? ''),
    entOn: [...document.querySelectorAll('#cx-list [data-cx-id]')].filter((b) => b.classList.contains('is-on')).map((b) => b.querySelector('.ed-tlabel')?.textContent ?? ''),
    rail: (() => { const r = document.querySelector('#cx-rail'); return r ? { off: r.classList.contains('is-off'), w: (() => { r.getAnimations().forEach((a) => a.finish()); return Math.round(r.getBoundingClientRect().width); })() } : null; })(),
    doc: document.querySelector('#cx-doc .ProseMirror')?.textContent ?? null,
    fields: [...document.querySelectorAll('#cx-fields > div')].length,
  }))()`);
  check('★14b 换回实体：骨架同一元素、不重播整块错峰、改播行级转场（旧实现整块重建）',
    back.sameRoot === true && back.stagger === false && back.delayed === 0
      && back.bodyCss.length === 0 && back.ghost === true && back.rowAnims > 0, back);
  check('★14c 换回实体后**节点行的高亮必须消失**，高亮落到实体行、帧条回来、中右栏换成该实体',
    nodeOnBefore > 0 && st2.nodeOn.length === 0 && st2.name === '银发少女'
      && st2.entOn.length === 1 && st2.entOn[0] === '银发少女'
      && st2.rail && st2.rail.off === false && st2.rail.w > 100
      && st2.fields > 0 && String(st2.doc ?? '').includes('雪原独行'),
    { nodeOnBefore, scrollableBefore: sBefore, ...st2 });
  check('★14d 绕一圈回来（实体 → 节点 → 实体）框的位置与高度与出发时**逐项相同**（帧条也回到原宽原高）',
    !!geo.before && !!back.geo
      && back.geo.list.t === geo.before.list.t && back.geo.body.t === geo.before.body.t
      && back.geo.newbox.t === geo.before.newbox.t && back.geo.newbox.h === geo.before.newbox.h
      && back.geo.rail.t === geo.before.rail.t && back.geo.rail.w === geo.before.rail.w
      && back.geo.rail.h === geo.before.rail.h && back.geo.rail.off === false,
    { before: geo.before, after: back.geo });

  const errs = await ev(`window.__errs`);
  check('★15 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const n = results.filter(Boolean).length;
  console.log(`\n==== ${n}/${results.length} PASS ====`);
  process.exit(n === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack || e)); process.exit(2); });
