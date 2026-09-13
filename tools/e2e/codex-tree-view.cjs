/* 工作台（设定库）左栏的**形态守卫** —— 左栏只有一棵树，没有第二种长相。
   用户 2026-09-13 的三句话把形态定下来的全过程：
     ① 「设定库和编辑器是不是可以做成同一工具的两种不同形式啊（在设置里面切换）」
     ② 「时间线节点和实体这两个按钮，列表和文件夹树的功能有点混乱」⇒ 重做成「筛选 pills + 一个视图按钮」
     ③ 「**要不这样，把全部改成文件树的形式，这样子也方便看**」⇒ 列表形态整个撤掉，
        筛选也没了（树的形状本身就是筛选）；树**默认全展开**，打开就看得到全部条目。

   本套件钉住：
     ① 左栏**只有一棵树**：没有类别页签、没有形态开关、也没有筛选 pills（守着"别再长出第二套控件"）；
     ② 树**默认全展开**（时间线/种类/节点/`_设定`/类型/实体 一次点击都不用就都在）；
     ③ 形态与 `localStorage` 的旧键 `workbenchView` **无关**（设置面板里那组单选已经删掉）；
     ④ 空类型列出来（置灰 + 一句人话）；**没有节点的种类不列**（用户报过的重名文件夹）；
     ⑤ 点实体行/节点行都能直接换中栏+右栏，且左树不被换掉；
     ⑥ 搜索跨类别（节点 + 实体一起命中），非空时摊平、清空后回到树；
     ⑦ 收起的枝在重画之后**仍然收着**（collapsed 语义），全程无未捕获异常。

   用法：先 reset-entity-vault.cjs + seed-node.cjs，起应用（--remote-debugging-port），
        再 `LK_CDP_PORT=xxxx node tools/e2e/codex-tree-view.cjs`。
   ⚠️ 它需要**有空类型**的前置（`角色` 有 1 个实体，其余类型 0 个）—— 跑到别的目录上会挂 ★5/★6。
   ⚠️ 套件自己是自足的：开头故意往 localStorage 写 `workbenchView='list'`（旧版的"列表形态"），
      断言左栏**照样**是那棵树 —— 形态不再由设置决定。 */
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
  const click = (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  /** 点树里那一行：按 data-act 挑（每点一次树会重建，所以每次都得重新查） */
  const clickRow = (act, label) => ev(`(() => {
    const el = [...document.querySelectorAll('#cx-list .ed-tnode')]
      .filter((e) => e.dataset.act === ${JSON.stringify(act)})
      .find((e) => (e.querySelector('.ed-tlabel')?.textContent ?? '') === ${JSON.stringify(label)});
    if (!el) return false; el.click(); return true; })()`);
  const rows = (sel) => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => ({
    act: e.dataset.act ?? '', label: e.querySelector('.ed-tlabel')?.textContent ?? '',
    count: e.querySelector('.ed-tcount')?.textContent ?? '', empty: e.classList.contains('is-empty'),
    open: e.classList.contains('is-open'), on: e.classList.contains('is-on') }))`);
  const setSearch = (v) => ev(`(() => {
    const el = document.querySelector('#cx-search');
    el.value = ${JSON.stringify(v)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true; })()`);
  /** 整个左栏的形状（一次问全，免得为了几个数字来好几趟） */
  const shape = () => ev(`({
    worlds: document.querySelectorAll('#cx-list .ed-tworld').length,
    tl: document.querySelectorAll('#cx-list .ed-ttl').length,
    kind: document.querySelectorAll('#cx-list .ed-tkind').length,
    node: document.querySelectorAll('#cx-list [data-act="node"]').length,
    setRow: document.querySelectorAll('#cx-list .ed-tset').length,
    etype: document.querySelectorAll('#cx-list .ed-ttype').length,
    ent: document.querySelectorAll('#cx-list [data-act="entity"]').length,
    chips: document.querySelectorAll('#cx-chips,[data-cx-chip]').length,
    view: document.querySelectorAll('#cx-view,[data-cx-view]').length,
    tabs: document.querySelectorAll('#cx-tab-entity,#cx-tab-node').length,
    wbView: (() => { try { return JSON.parse(localStorage.getItem('lingkuang-settings') || '{}').workbenchView ?? null; } catch { return 'ERR'; } })() })`);

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  /* 自足：故意把旧版的"默认形态"写成 list —— 断言左栏照样是那棵树（形态不再由设置决定） */
  await ev(`(() => { const k = 'lingkuang-settings'; const s = JSON.parse(localStorage.getItem(k) || '{}'); s.workbenchView = 'list'; localStorage.setItem(k, JSON.stringify(s)); return true; })()`);
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  await sleep(1200);

  /* ① 左栏只有一棵树 —— 第二套控件一个都不许有 */
  const s0 = await shape();
  check('1 左栏只有一棵树：没有类别页签 / 形态开关 / 筛选 pills，世界层 = 1',
    s0.worlds === 1 && s0.chips === 0 && s0.view === 0 && s0.tabs === 0, s0);

  /* ② 默认全展开：一次点击都不用，各层就都在 */
  check('2 默认全展开（时间线/种类/节点/_设定/类型/实体 都在，无需点击）',
    s0.tl > 0 && s0.kind > 0 && s0.node > 0 && s0.setRow === 1 && s0.etype > 0 && s0.ent > 0, s0);
  check('★2b 形态与设置里的旧键 `workbenchView` 无关（写的 list，看到的还是树）',
    s0.wbView === 'list' && s0.worlds === 1, { wbView: s0.wbView, worlds: s0.worlds });

  /* ③ 层级与顺序 = 硬盘目录（世界 → 时间线 → 种类 → 节点，然后 世界 → _设定 → 类型 → 实体） */
  const order = await ev(`[...document.querySelectorAll('#cx-list .ed-tree > .ed-tnode')].map((x)=>({cls:x.className, t:(x.querySelector('.ed-tlabel')?.textContent||'')}))`);
  const at = (pred) => (order || []).findIndex(pred);
  const iTl = at((r) => r.cls.includes('ed-ttl'));
  const iKind = at((r) => r.cls.includes('ed-tkind'));
  const iNode = at((r) => r.cls.includes('ed-tnode-item') && r.t === '王国的建立');
  const iSet = at((r) => r.cls.includes('ed-tset'));
  const iType = at((r) => r.cls.includes('ed-ttype'));
  const iEnt = at((r) => r.cls.includes('ed-tnode-item') && r.t === '银发少女');
  check('3 时间线分支与 `_设定` 分支同框，顺序 = 硬盘目录',
    iTl > 0 && iTl < iKind && iKind < iNode && iNode < iSet && iSet < iType && iType < iEnt,
    { iTl, iKind, iNode, iSet, iType, iEnt, rows: (order || []).map((r) => r.t) });

  /* ④ 种类只列真有节点的；类型列全部（含空的、置灰） */
  const kinds = await rows('#cx-list .ed-tkind');
  check('★4 种类层只有真有节点的「事件」（没有节点的种类不列 —— 用户报过的重名文件夹）',
    kinds.length === 1 && kinds[0].label === '事件' && kinds[0].count === '1', kinds);
  const types = await rows('#cx-list .ed-tset-type');
  const role = types.find((r) => r.label === '角色');
  const empty = types.find((r) => r.count === '0');
  check('★5 类型层：有实体的「角色」与空类型都在，空的置灰',
    !!role && role.count === '1' && !!empty && empty.empty === true, types);

  /* ⑤ 空类型展开 → 一句人话（默认展开，所以它本来就展开着；这里只查那句话在不在） */
  const hint = await ev(`[...document.querySelectorAll('#cx-list .ed-tempty')].map((e) => e.textContent)`);
  check('★6 空类型展开后给一句人话', (hint || []).some((t) => String(t).includes('这个类型还没有实体')), hint);

  /* ⑥ 点实体行 = 换中栏/右栏目标，且左树没被换掉 */
  check('7 点实体行「银发少女」', await clickRow('entity', '银发少女'));
  await sleep(900);
  const picked = await ev(`({ name: document.querySelector('#cx-name')?.value ?? '',
      fields: [...document.querySelectorAll('#cx-fields > div')].map((r) => r.firstElementChild?.textContent).filter(Boolean),
      rail: !!document.querySelector('#cx-rail'),
      worlds: document.querySelectorAll('#cx-list .ed-tworld').length })`);
  check('★8 中栏换成该实体（名字 / 字段 / 右栏帧条都在），左树还在（没被换掉）',
    picked.name === '银发少女' && picked.fields.includes('发色') && picked.rail === true && picked.worlds === 1, picked);
  const onRow = await rows('#cx-list [data-act="entity"]');
  check('★9 树里那一行被高亮（is-on）', onRow.some((r) => r.label === '银发少女' && r.on === true), onRow);

  /* ⑦ 点节点行 = 换到节点，左树同样留着 */
  check('10 点节点行「王国的建立」', await clickRow('node', '王国的建立'));
  await sleep(900);
  const nodePicked = await ev(`({ path: document.querySelector('#cx-nodepath')?.textContent ?? '',
      props: document.querySelectorAll('#cx-props .ed-props > div').length,
      setRow: document.querySelectorAll('#cx-list .ed-tset').length })`);
  check('★11 中栏换成该节点（面包屑 + 公共属性面板），左树没有被换掉',
    nodePicked.path.includes('主线') && nodePicked.path.includes('事件') && nodePicked.props > 0 && nodePicked.setRow === 1, nodePicked);

  /* ⑧ 搜索：跨类别命中，非空时摊平（没有世界层），清空后回到树 */
  await setSearch('银发');
  await sleep(500);
  const hits = await rows('#cx-list .ed-tnode');
  const flat = await ev(`document.querySelectorAll('#cx-list .ed-tworld').length`);
  check('★12 搜索同时搜节点与实体（命中实体行），且摊平成命中列表（没有世界层）',
    hits.some((r) => r.act === 'entity' && r.label === '银发少女') && flat === 0, { hits, worlds: flat });
  await setSearch('');
  await sleep(400);
  check('13 清空搜索 → 回到那棵树', (await shape()).worlds === 1, await shape());

  /* ⑨ 收起的枝在重画之后仍然收着（collapsed 语义：用户收起过的不该被别人的重画撑开） */
  check('14 收起 `_设定` 那一枝', await clickRow('wset', '_设定'));
  await sleep(350);
  const afterClose = await ev(`document.querySelectorAll('#cx-list .ed-ttype').length`);
  await setSearch('银');
  await sleep(400);
  await setSearch('');
  await sleep(400);
  const afterRedraw = await ev(`({ etype: document.querySelectorAll('#cx-list .ed-ttype').length,
      setOpen: !!document.querySelector('#cx-list .ed-tset.is-open') })`);
  check('★15 收起的那一枝在左列重画之后仍然收着',
    afterClose === 0 && afterRedraw.etype === 0 && afterRedraw.setOpen === false, { afterClose, afterRedraw });
  check('16 再点一次展开回来（收放两个方向都还在）', await clickRow('wset', '_设定'));
  await sleep(350);
  check('★17 展开后类型行回来', (await ev(`document.querySelectorAll('#cx-list .ed-ttype').length`)) > 0);

  /* ⑩ 设置面板里**没有**形态单选（形态之争结束后那组控件应该彻底消失） */
  await click('[data-tool="settings"]');
  await sleep(800);
  const wbRadios = await ev(`document.querySelectorAll('input[name="wbView"]').length`);
  const wbText = await ev(`!!document.querySelector('#set-body') && (document.querySelector('#lk-module-view')?.textContent || '').includes('设定库（工作台）')`);
  check('★18 设置面板里不再有「工作台默认形态」那组单选', wbRadios === 0 && wbText === false, { wbRadios, wbText });
  await click('[data-tool="codex"]');
  await sleep(1000);
  check('19 重开工作台 → 还是那棵树（全展开）', (await shape()).worlds === 1 && (await shape()).etype > 0, await shape());
  /* 把 `_设定` 恢复成展开，别把收起态留给同一实例上后面跑的套件 */
  await clickRow('wset', '_设定');
  await sleep(300);

  const errs = await ev(`window.__errs`);
  check('20 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n==== ${pass}/${results.length} PASS ====`);
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 异常：' + (e && e.stack ? e.stack : e)); process.exit(1); });
