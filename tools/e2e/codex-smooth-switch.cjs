/* 不变量：**同页签内换条目只换内容，不重建骨架**（用户 2026-09-13：「设定库中点击实体会刷新界面，
 * 我希望变成平滑切换（点击其他实体时）」）。
 *
 * 「刷新界面」在旧实现里是三件事叠在一起，这条套件逐条钉住它们：
 *   ① 整个面板 `host.innerHTML = …` 重造 ⇒ 骨架元素（#cx-root / #cx-search / 正文编辑器）**换了新元素**；
 *   ② 每次重建都播整块错峰入场 ⇒ 点开的东西又一个个冒出来（#cx-root 上挂 .lk-enter-stagger、子项有 lk-wake）；
 *   ③ #cx-root 就是滚动容器，被换掉 ⇒ **滚动位置回到顶部**。
 * 修法：同页签内换条目走 `swapBody()` —— 保住骨架，只换「名字/类型 + 字段行 + 正文」，内容区播一次
 * `.lk-swap-in`（从 .5 不透明度落位，不是从透明）。换页签（结构真的变了）仍然整块重建 + 错峰，
 * 这条也断言（★11）—— 免得以后有人把"就地换内容"扩到不该扩的地方。
 *
 * 用法：先 `node tools/e2e/seed-smooth-switch.cjs`，起应用，再跑本脚本。
 * ⚠️ 换页签之后本套件会一路在节点页签上收尾；重跑请重启实例（或重新播种）。
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

  /** 记下当前这几个元素（后面用身份比对判断"骨架有没有被重建"） */
  const mark = () => ev(`(() => {
    window.__s = { root: document.querySelector('#cx-root'), search: document.querySelector('#cx-search'),
      list: document.querySelector('#cx-list'), doc: document.querySelector('#cx-doc .ProseMirror'),
      props: document.querySelector('#cx-props') };
    return Object.fromEntries(Object.entries(window.__s).map(([k, v]) => [k, !!v]));
  })()`);
  const same = (key) => ev(`document.querySelector(${JSON.stringify({ root: '#cx-root', search: '#cx-search', list: '#cx-list', doc: '#cx-doc .ProseMirror', props: '#cx-props' }[key])}) === window.__s.${key}`);

  /** 点左列某一行的实体，并在**同一个同步块**里把动画状态读出来（隐藏窗口只读得到参数，
   *  见 README 铁律 6：出帧与否会让 currentTime 有/无，参数才是确定的） */
  const clickEntity = (name) => ev(`(() => {
    const b = [...document.querySelectorAll('[data-cx-id]')].find((x) => x.children[0]?.textContent === ${JSON.stringify(name)});
    if (!b) return { err: 'no row ' + ${JSON.stringify(name)} };
    b.click();
    const anims = ${ANIMS};
    const root = document.querySelector('#cx-root');
    const subs = [...root.children].flatMap((c) => anims(c));
    return {
      stagger: root.classList.contains('lk-enter-stagger'),
      listStagger: (document.querySelector('#cx-list') || {}).classList?.contains?.('lk-enter-stagger') ?? null,
      wake: subs.filter((a) => a.name === 'lk-wake').length,
      delayed: [...root.children].filter((c) => c.style && c.style.animationDelay).length,
      body: anims(document.querySelector('#cx-body')).filter((a) => a.name),
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
      rows: [...document.querySelectorAll('[data-cx-id]')].map((b) => b.children[0]?.textContent),
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

  /* ── ④ 左列高亮跟过去 ── */
  const hl = await ev(`(() => {
    const on = [...document.querySelectorAll('[data-cx-id]')].filter((b) => (b.getAttribute('style') || '').includes('var(--surface-2)'));
    return { on: on.map((b) => b.children[0]?.textContent), n: on.length };
  })()`);
  check('★7 左列选中高亮只落在新条目上', hl.n === 1 && hl.on[0] === '霜纹剑', hl);

  /* ── ⑤ 没有整块错峰重播，但内容区有一次轻淡入 ── */
  check('★8 换实体**不再**重播整块错峰（无 .lk-enter-stagger、子项无 lk-wake、无行内延迟）',
    r1.stagger === false && r1.listStagger === false && r1.wake === 0 && r1.delayed === 0, r1);
  check('★9 内容区播了一次 lk-swap 淡入（同同步块读到 running）',
    r1.body.length > 0 && r1.body[0].name === 'lk-swap' && r1.body[0].play === 'running', r1.body);

  /* ── ⑥ 淡入的终态（推到结尾再读计算样式） ── */
  const end = await ev(`(() => {
    const b = document.querySelector('#cx-body');
    if (!b) return null;   /* 修复前的骨架里根本没有这个元素 → 直接判 FAIL，别让脚本崩在这里 */
    b.getAnimations().forEach((a) => a.finish());
    const cs = getComputedStyle(b);
    return { opacity: cs.opacity, transform: cs.transform };
  })()`);
  check('★10 淡入终态是不透明且无位移', !!end && end.opacity === '1' && (end.transform === 'none' || end.transform === 'matrix(1, 0, 0, 1, 0, 0)'), end);

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

  /* ── ⑧ 换页签（结构真的变了）仍然整块重建 + 错峰：别把"就地换内容"扩到这里 ── */
  await mark();
  const tab = await ev(`(() => {
    document.querySelector('#cx-tab-node').click();
    const anims = ${ANIMS};
    const root = document.querySelector('#cx-root');
    return {
      sameRoot: document.querySelector('#cx-root') === window.__s.root,
      stagger: root.classList.contains('lk-enter-stagger'),
      wake: [...root.children].flatMap((c) => anims(c)).filter((a) => a.name === 'lk-wake').length,
    };
  })()`);
  await sleep(500);
  check('★13 换页签仍然是整块重建 + 错峰（结构变了，不该就地换）',
    tab.sameRoot === false && tab.stagger === true && tab.wake > 0, tab);

  /* ── ⑨ 节点→节点也要就地换 ── */
  const expand = async () => {
    await ev(`(() => {
      const click = (sel) => { const el = document.querySelector(sel); if (el) el.click(); };
      click('[data-act="world"]'); return true;
    })()`);
    await sleep(150);
    await ev(`(() => { const el = document.querySelector('[data-act="tl"]'); if (el) el.click(); return true; })()`);
    await sleep(150);
    await ev(`(() => { const el = document.querySelector('[data-act="tkind"]'); if (el) el.click(); return true; })()`);
    await sleep(250);
  };
  const pickNode = (title) => ev(`(() => {
    const el = [...document.querySelectorAll('[data-act="node"]')].find((r) => r.querySelector('.ed-tlabel')?.textContent === ${JSON.stringify(title)});
    if (!el) return false; el.click(); return true;
  })()`);
  await expand();
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

  const errs = await ev(`window.__errs`);
  check('★15 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const n = results.filter(Boolean).length;
  console.log(`\n==== ${n}/${results.length} PASS ====`);
  process.exit(n === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack || e)); process.exit(2); });
