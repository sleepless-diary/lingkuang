/* 不变量：**创建节点有自己的面板**（名字 / 年份 / 种类 / 模板字段 + 创建 / 取消），
 *  且**建节点不许让时间线页签弹一下**。
 *
 * 用户 2026-09-19 原话：「给创建节点做专门适配（创建面板要有名字/年份/种类/模板字段 + 创建/取消，
 * 不要复用节点信息面板，现在连创建按钮都没有）；另外点创建节点时主线页签会上下弹动，修一下。」
 *
 * 两条病根（都在 `src/` 里）：
 *  ① 曾经把「＋节点」改成「先 `addNode()` 建一个叫『新节点』的节点、再打开 `renderNodeDetail()`
 *     的**节点信息面板**」——于是没有「创建」这个动作可点（节点已经建出来了），名字是占位的、
 *     种类没得选、该种类的模板字段也来不及填。现在「＋节点」开的是 `src/ui/node-form.ts` 的
 *     **专用创建面板**，它跟信息面板（`src/ui/detail.ts`）刻意是两套 UI。
 *  ② `src/ui/shell.ts` 的 `renderTimelineTabs()` 过去用 (id,name,count,active) 当签名，
 *     **节点数**一变就重建整条页签栏并 `staggerIn(tabs)` ⇒ 容器上常驻的 `.lk-enter-stagger`
 *     给每个子项重播 `lk-wake`（上浮 8px + 逐个错峰）＝用户看到的「页签上下弹动」。
 *     现在只在**页签集合**变了时重建；计数/名字/选中态就地改（`★4` 用元素身份证明没重建）。
 *
 * 用法（干净实例，端口 9350）：
 *   $env:LINGKUANG_TEST_DATA / LINGKUANG_VAULT / LINGKUANG_TEST_USERDATA = 临时目录
 *   node tools/e2e/reset-entity-vault.cjs && node tools/e2e/seed-node.cjs
 *   LK_CDP_PORT=9350 node tools/e2e/create-node-panel.cjs
 */
const fs = require('fs');
const path = require('path');
const PORT = process.env.LK_CDP_PORT || '9350';
const VAULT = process.env.LINGKUANG_VAULT;
const WS = '测试世界观';
const TL = '主线';
const KIND = '事件';
const NEW_TITLE = '霜落之战';
const NEW_YEAR = 320;
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

  await sleep(1500);
  /* 动画时长/名字由 --motion-* 令牌与 prefers-reduced-motion 决定 ⇒ 显式钉在「不减少动效」档，
     否则同一套件在不同机器上读到 lk-fade 而不是 lk-wake（motion-switch.cjs ★15 同款做法）。 */
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await sleep(200);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`);
  await sleep(600);

  /** 页签栏现状：元素身份 / 名字 / 计数 / 每个页签身上挂着的动画 */
  const tabsNow = () => ev(`(() => {
    const list = [...document.querySelectorAll('.lk-tl-tabs > .lk-tl-tab[data-tl]')];
    return {
      n: list.length,
      ids: list.map((b) => b.dataset.tl),
      names: list.map((b) => b.querySelector('.nm')?.textContent ?? b.textContent),
      counts: list.map((b) => b.querySelector('.cnt')?.textContent ?? null),
      active: document.querySelector('.lk-tl-tabs > .lk-tl-tab.is-active')?.querySelector('.nm')?.textContent ?? null,
      anims: list.map((b) => b.getAnimations().map((a) => a.animationName)),
      tops: list.map((b) => Math.round(b.getBoundingClientRect().top)),
    };
  })()`);

  const t0 = await tabsNow();
  check('★0 前置：沙盘在、有「＋节点」按钮、主线页签计数 = 1（seed-node 播的那个节点）',
    t0.n === 1 && t0.names[0] === TL && t0.counts[0] === '1' && !!(await ev(`!!document.getElementById('lk-node-new')`)),
    t0);
  const nodes0 = await ev(`document.querySelectorAll('#lk-pane-timeline .tl__n[data-id]').length`);

  /* ── ① 点「＋节点」开的是**创建面板**，不是节点信息面板 ── */
  const opened = await ev(`(() => {
    document.getElementById('lk-node-new').click();
    return {
      title: !!document.getElementById('nf-title'),
      year: !!document.getElementById('nf-time'),
      kind: !!document.getElementById('nf-kind'),
      props: !!document.getElementById('nf-props'),
      ok: document.getElementById('nf-ok')?.textContent ?? null,
      cancel: document.getElementById('nf-cancel')?.textContent ?? null,
      infoPanel: !!document.getElementById('d-view'),   /* 信息面板的根（detail.ts） */
      label: document.querySelector('#lk-tool-host label[for="nf-title"]')?.textContent ?? null,
      kindOptions: [...document.querySelectorAll('#nf-kind option')].map((o) => o.value),
    };
  })()`);
  const afterOpen = await tabsNow();
  const nodesAfterOpen = await ev(`document.querySelectorAll('#lk-pane-timeline .tl__n[data-id]').length`);
  check('★1 「＋节点」开的是**创建面板**（名字/年份/种类 三栏 + 「创建」「取消」两个按钮），且**不是**节点信息面板',
    opened.title === true && opened.year === true && opened.kind === true && opened.props === true
    && opened.ok === '创建' && opened.cancel === '取消' && opened.infoPanel === false && opened.label === '名字',
    opened);
  check('★1b 开面板**不建节点**（过去是点一下就先建一个占位「新节点」再开信息面板）',
    nodesAfterOpen === nodes0 && afterOpen.counts[0] === '1', { before: nodes0, after: nodesAfterOpen, cnt: afterOpen.counts[0] });

  /* ── ② 模板字段跟着「种类」渲染（值来自 formats.json 的模板声明） ── */
  const fields = await ev(`[...document.querySelectorAll('#nf-props > div')].map((row) => ({
    label: row.querySelector('span')?.textContent ?? null,
    tag: row.querySelector('input,textarea')?.tagName ?? null,
  }))`);
  check('★2 面板里渲染出该种类的**模板字段**（事件 → 地点 / 规模，控件是 fieldRow 那一套）',
    Array.isArray(fields) && ['地点', '规模'].every((k) => fields.some((f) => f.label === k && f.tag === 'INPUT')),
    fields);

  /* ── ③ 「取消」＝关掉面板、什么都不建 ── */
  const cancelled = await ev(`(() => {
    document.getElementById('nf-cancel').click();
    return { gone: !document.getElementById('nf-ok'), host: (document.getElementById('lk-tool-host')?.textContent ?? '').trim() };
  })()`);
  await sleep(300);
  const nodesAfterCancel = await ev(`document.querySelectorAll('#lk-pane-timeline .tl__n[data-id]').length`);
  check('★3 「取消」关掉面板且没建节点', cancelled.gone === true && nodesAfterCancel === nodes0 && cancelled.host === '', { ...cancelled, nodes: nodesAfterCancel });

  /* ── ④ 填名字/年份/模板字段（先不提交，量一次「点之前」的页签状态） ── */
  const pre = await ev(`(() => {
    document.getElementById('lk-node-new').click();
    const setField = (label, val) => {
      const row = [...document.querySelectorAll('#nf-props > div')].find((d) => d.querySelector('span')?.textContent === label);
      const ctrl = row && row.querySelector('input,textarea');
      if (!ctrl) return false;
      ctrl.value = val;
      ctrl.dispatchEvent(new Event('change', { bubbles: true }));   /* fieldRow 只在 change 提交 */
      return true;
    };
    document.getElementById('nf-title').value = ${JSON.stringify(NEW_TITLE)};
    document.getElementById('nf-time').value = ${JSON.stringify(String(NEW_YEAR))};
    const filled = [setField('地点', '北境'), setField('规模', '大战')];
    const tab = document.querySelector('.lk-tl-tabs > .lk-tl-tab[data-tl]');
    /* 记下三样：页签元素本身、它身上那**一个** lk-wake 动画对象、它的纵向位置。
       ⚠️ 光看「有没有动画」判不出病：CSS 动画带 fill:both，跑完仍留在 getAnimations() 里
       （开局那次错峰留下的那个动画一直挂到现在）。要比的是**对象身份**：重播会取消旧动画、
       生成新的 Animation 对象；而重建 DOM 会连元素一起换掉。
       ⚠️ 这段注释不许出现反引号 —— 它在 JS 模板串里面，会把模板串提前截断。 */
    window.__nfTab = tab;
    window.__nfAnim = tab.getAnimations().find((a) => a.animationName === 'lk-wake') ?? null;
    window.__nfTop = Math.round(tab.getBoundingClientRect().top);
    return { filled, open: !!document.getElementById('nf-ok'), hadAnim: !!window.__nfAnim, top: window.__nfTop };
  })()`);

  const created = await ev(`(() => {
    document.getElementById('nf-ok').click();   /* 点击 → store.update → 订阅者**同步**重画页签 */
    const list = [...document.querySelectorAll('.lk-tl-tabs > .lk-tl-tab[data-tl]')];
    const waking = list.map((b) => b.getAnimations().find((a) => a.animationName === 'lk-wake') ?? null);
    return {
      panelGone: !document.getElementById('nf-ok'),
      infoPanel: !!document.getElementById('d-view'),
      sameTab: window.__nfTab === list[0],
      connected: !!window.__nfTab && window.__nfTab.isConnected,
      sameAnim: waking[0] === window.__nfAnim,
      top: Math.round(list[0].getBoundingClientRect().top),
      name: list[0]?.querySelector('.nm')?.textContent ?? null,
      cnt: list[0]?.querySelector('.cnt')?.textContent ?? null,
    };
  })()`);
  await sleep(700);
  const t1 = await tabsNow();
  const nodes1 = await ev(`document.querySelectorAll('#lk-pane-timeline .tl__n[data-id]').length`);
  check('★4 「创建」把节点建出来并关掉面板（不跳去信息面板）',
    pre.filled.every(Boolean) && created.panelGone === true && created.infoPanel === false,
    { ...pre, ...created });
  check('★4b 页签计数**就地**更新（2）而页签**没被重建**（同一个元素、仍连着 DOM、名字没变）—— 这就是「弹动」的根治点',
    created.sameTab === true && created.connected === true && created.name === TL && created.cnt === '2'
    && t1.counts[0] === '2' && t1.n === 1,
    { sameTab: created.sameTab, connected: created.connected, name: created.name, cnt: created.cnt, now: t1.counts });
  check('★4c 画布上多了一个节点', nodes1 === nodes0 + 1, { before: nodes0, after: nodes1 });

  /* ── ⑤ 建节点**不许**让页签弹一下（用户原话：「点创建节点时主线页签会上下弹动」）——
      三条证据缺一不可：元素没换、动画对象没换（没重播）、像素位置没动。
      旧实现（签名含节点数 ⇒ 计数一变就重建 + staggerIn）三条全破。 ── */
  check('★5 点「创建」那一刻页签一动不动（同一元素 + 同一动画对象 + top 不变 + 700ms 后仍不变）',
    created.sameAnim === true && created.top === pre.top && pre.hadAnim === true && t1.tops[0] === pre.top,
    { hadAnim: pre.hadAnim, sameAnim: created.sameAnim, topBefore: pre.top, topAtClick: created.top, topLater: t1.tops });

  /* ── ⑥ 落盘：模板字段进 frontmatter（`main.js` nodeToMd 把 properties 写成裸键值） ── */
  const mdPath = path.join(VAULT, WS, TL, KIND, `${NEW_TITLE}.md`);
  const md = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
  check('★6 节点的 .md 落在「' + KIND + '」文件夹里，年份与**模板字段值**都写进了 frontmatter',
    md.length > 0 && md.includes(`year: ${NEW_YEAR}`) && md.includes('地点: 北境') && md.includes('规模: 大战'),
    { mdPath, head: md.split('\n').slice(0, 12) });

  /* ── ⑦ 回归：**换页签仍然播错峰**（这是设计要的入场；motion-switch.cjs ★15 盯着它） ── */
  const added = await ev(`(() => {
    const before = document.querySelector('.lk-tl-tabs > .lk-tl-tab[data-tl]');
    document.getElementById('lk-tl-new').click();   /* 页签集合变了 ⇒ 应当重建 */
    return { sameTab: before === document.querySelector('.lk-tl-tabs > .lk-tl-tab[data-tl]') };
  })()`);
  await sleep(400);
  const t2 = await tabsNow();
  const switched = await ev(`(() => {
    const list = [...document.querySelectorAll('.lk-tl-tabs > .lk-tl-tab[data-tl]')];
    list[1].click();
    return {
      active: document.querySelector('.lk-tl-tabs > .lk-tl-tab.is-active')?.querySelector('.nm')?.textContent ?? null,
      /* ⚠️ 只挑 CSS 动画：点页签会顺带触发 hover/选中变色的 **CSS transition**，
          它们也在 getAnimations() 里、但 animationName 是 undefined（motion-switch 同款坑）。
          ⚠️ 注释里不许出现反引号（这一段在 JS 模板串里）。 */
      anims: list.map((b) => b.getAnimations().filter((a) => a.animationName === 'lk-wake')
        .map((a) => ({ name: a.animationName, delay: a.effect.getTiming().delay }))),
    };
  })()`);
  check('★7 新增时间线＝页签**集合**变了 ⇒ 重建（只有这条路允许播入场）',
    t2.n === 2 && added.sameTab === false, { ...t2, rebuilt: added.sameTab === false });
  check('★7b 换页签仍然播错峰入场（2 个页签都有 lk-wake，延迟 0 / 100ms：显式切换不是"数据变化"）',
    switched.active === '新时间线' && switched.anims.length === 2
    && switched.anims.every((a) => a[0]?.name === 'lk-wake')
    && switched.anims[0][0].delay === 0 && switched.anims[1][0].delay === 100,
    switched);

  const errs = await ev(`window.__errs`);
  check('★8 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n==== ${pass}/${results.length} PASS ====`);
  w.close();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
