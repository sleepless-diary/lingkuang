/* 工作台（设定库）左栏的「文件夹树」形态 —— 用户 2026-09-13：
   「设定库和编辑器是不是可以做成同一工具的两种不同形式啊（在设置里面切换）」。

   形态一「列表」= 两个页签（实体 / 时间线节点）+ 类型 chips + 搜索（原来的设定库）。
   形态二「文件夹树」= 一棵树同时装下两类条目，跟硬盘目录一一对应：
     世界 → 时间线 → 种类 → 节点   ／   世界 → `_设定` → 类型 → 实体

   本套件钉住：
     ① 开关在左栏、切换不重建骨架；
     ② 树里 `_设定` 分支与时间线分支**同框**（这棵树原来只长在「编辑器」工具里）；
     ③ 点实体行 / 点节点行都能直接换中栏+右栏的目标；
     ④ 空类型列出来（置灰 + 一句人话），但**没有节点的种类不列**（用户报过的重名文件夹）；
     ⑤ 开关会把选择记成"下次打开的默认形态"，设置面板里那组单选跟着显示；
     ⑥ 全程无未捕获异常。

   用法：先 reset-entity-vault.cjs + seed-node.cjs，起应用（--remote-debugging-port），
        再 `LK_CDP_PORT=xxxx node tools/e2e/codex-tree-view.cjs`。
   ⚠️ 本套件用的测试世界里只有一条时间线（codex-node-tab 同款前置）。
   ⚠️ 套件自己是自足的：开头先把 localStorage 里的形态复位成 list（不然上一次跑剩的 tree 会让断言错位）。 */
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
  const waitFor = async (fn, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(200); } return false; };
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
    on: e.classList.contains('is-on') }))`);
  const setSearch = (v) => ev(`(() => {
    const el = document.querySelector('#cx-search');
    el.value = ${JSON.stringify(v)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true; })()`);
  const setting = () => ev(`(() => { try { return JSON.parse(localStorage.getItem('lingkuang-settings') || '{}').workbenchView ?? null; } catch { return 'ERR'; } })()`);

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  /* 自足：先把形态复位成 list，再打开工具（renderCodex 是在打开那一刻读设置的） */
  await ev(`(() => { const k = 'lingkuang-settings'; const s = JSON.parse(localStorage.getItem(k) || '{}'); s.workbenchView = 'list'; localStorage.setItem(k, JSON.stringify(s)); return true; })()`);
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  await sleep(1200);

  /* ① 默认形态 = 列表（页签 + chips 都在，没有 `_设定` 行） */
  const listState = await ev(`({ tabs: document.querySelectorAll('#cx-tab-entity,#cx-tab-node').length,
      chips: document.querySelectorAll('#cx-chips button').length,
      setRow: document.querySelectorAll('#cx-list .ed-tset').length,
      toggle: [...document.querySelectorAll('[data-cx-view]')].map((b) => b.textContent.trim()) })`);
  check('1 左栏有「列表 / 文件夹树」开关，开机默认是列表形态',
    listState.toggle.join(',') === '列表,文件夹树' && listState.tabs === 2 && listState.chips > 0 && listState.setRow === 0, listState);

  /* ② 切到文件夹树 → `_设定` 行出现、chips 清空、页签仍在（页签说明中栏在看哪一类） */
  check('2 点「文件夹树」', await ev(`(() => { const b = [...document.querySelectorAll('[data-cx-view]')].find((x) => x.textContent.trim() === '文件夹树'); if (!b) return false; b.click(); return true; })()`));
  await sleep(600);
  const treeState = await ev(`({ worlds: document.querySelectorAll('#cx-list .ed-tworld').length,
      chips: document.querySelectorAll('#cx-chips button').length,
      tabs: document.querySelectorAll('#cx-tab-entity,#cx-tab-node').length,
      ph: document.querySelector('#cx-search')?.placeholder ?? '' })`);
  /* 注意：`_设定` 行要**展开世界**之后才出现（树的展开态是各层自己的），所以这里只断言"换成了树"，
     同框与 `_设定` 行交给 ★5（展开世界之后）。 */
  check('★3 换成文件夹树：类型 chips 让位、改出世界层（页签仍在，说明中栏还在看实体/节点）',
    treeState.worlds >= 1 && treeState.chips === 0 && treeState.tabs === 2, treeState);
  check('★3b 搜索框的提示跟着换（搜索条目…）', treeState.ph.includes('条目'), treeState.ph);

  /* ③ 展开世界 → 时间线分支与 `_设定` 分支**同框** */
  check('4 展开世界', await clickRow('world', '测试世界观'));
  await sleep(400);
  const worlds = await rows('#cx-list .ed-tnode');
  check('★5 同一个世界下：时间线 + `_设定` 都在',
    worlds.some((r) => r.act === 'tl') && worlds.some((r) => r.act === 'wset'), worlds);

  /* ④ `_设定` → 类型行（有实体的 + 一个实体都没有的） */
  check('6 展开 `_设定`', await clickRow('wset', '_设定'));
  await sleep(400);
  const types = await rows('#cx-list .ed-tset-type');
  const role = types.find((r) => r.label === '角色');
  const empty = types.find((r) => r.count === '0');
  check('★7 类型层：有实体的「角色」与空类型都在，空的置灰', !!role && role.count === '1' && !!empty && empty.empty === true, types);

  /* ⑤ 空类型展开 → 一句人话（不是一片空白） */
  check('8 展开空类型', await clickRow('etype', empty?.label ?? ''));
  await sleep(350);
  const hint = await ev(`[...document.querySelectorAll('#cx-list .ed-tempty')].map((e) => e.textContent)`);
  check('★9 空类型展开后给一句人话', hint.some((t) => String(t).includes('这个类型还没有实体')), hint);

  /* ⑥ 展开「角色」→ 实体行 → 点它 = 换中栏/右栏目标 */
  /* ⚠️ 用 `empty?.label ?? ''`：没有类型行时（例如 A/B 跑在没这功能的旧代码上）
     应当是「后面这些断言 FAIL」，不能让脚本自己抛异常中断 —— 那样后半段的结论就全丢了。 */
  check('10 展开「角色」', await clickRow('etype', '角色'));
  await sleep(400);
  const ents = await rows('#cx-list [data-act="entity"]');
  check('★11 「角色」下有实体行', ents.some((r) => r.label === '银发少女'), ents);
  check('12 点这个实体行', await clickRow('entity', '银发少女'));
  await sleep(900);
  const picked = await ev(`({ name: document.querySelector('#cx-name')?.value ?? '',
      fields: [...document.querySelectorAll('#cx-fields > div')].map((r) => r.firstElementChild?.textContent).filter(Boolean),
      rail: !!document.querySelector('#cx-rail'),
      tabEnt: (document.querySelector('#cx-tab-entity')?.textContent ?? '') })`);
  check('★13 中栏换成该实体（名字 / 字段 / 右栏帧条都在）',
    picked.name === '银发少女' && picked.fields.includes('发色') && picked.rail === true, picked);
  const onRow = await rows('#cx-list [data-act="entity"]');
  check('★14 树里那一行被高亮（is-on）', onRow.some((r) => r.label === '银发少女' && r.on === true), onRow);

  /* ⑦ 时间线分支：种类 → 节点 → 点它 = 换到节点 */
  check('15 时间线分支展开', await clickRow('tl', '主线'));
  await sleep(400);
  const kinds = await rows('#cx-list .ed-tkind');
  check('★16 种类层只有真有节点的「事件」', kinds.length === 1 && kinds[0].label === '事件' && kinds[0].count === '1', kinds);
  check('17 展开「事件」', await clickRow('tkind', '事件'));
  await sleep(400);
  const nodes = await rows('#cx-list [data-act="node"]');
  check('★18 节点行在树里', nodes.some((r) => r.label === '王国的建立'), nodes);
  check('19 点这个节点行', await clickRow('node', '王国的建立'));
  await sleep(900);
  const nodePicked = await ev(`({ path: document.querySelector('#cx-nodepath')?.textContent ?? '',
      props: document.querySelectorAll('#cx-props .ed-props > div').length,
      treeStill: document.querySelectorAll('#cx-list .ed-tset').length })`);
  check('★20 中栏换成该节点（面包屑 + 公共属性面板），左树没有被换掉',
    nodePicked.path.includes('主线') && nodePicked.path.includes('事件') && nodePicked.props > 0 && nodePicked.treeStill === 1, nodePicked);

  /* ⑧ 搜索：树视图里节点与实体一起搜 */
  await setSearch('银发');
  await sleep(500);
  const hits = await rows('#cx-list .ed-tnode');
  check('★21 搜索在树视图里同时搜节点与实体（命中实体行）', hits.some((r) => r.act === 'entity' && r.label === '银发少女'), hits);
  await setSearch('');
  await sleep(400);
  const back = await ev(`document.querySelectorAll('#cx-list .ed-tset').length`);
  check('22 清空搜索 → 回到树', back === 1, back);

  /* ⑨ 开关记成"下次打开的默认形态"，设置面板那组单选跟着显示 */
  check('★23 localStorage 里的默认形态已写入 tree', (await setting()) === 'tree', await setting());
  await click('[data-tool="settings"]');
  await sleep(800);
  const radio = await ev(`(() => { const el = document.querySelector('input[name="wbView"]:checked'); return el ? el.value : null; })()`);
  check('★24 设置面板里「工作台默认形态」显示成文件夹树', radio === 'tree', radio);
  await click('[data-tool="codex"]');
  await sleep(1000);
  const reopened = await ev(`({ worlds: document.querySelectorAll('#cx-list .ed-tworld').length,
      chips: document.querySelectorAll('#cx-chips button').length,
      setting: (() => { try { return JSON.parse(localStorage.getItem('lingkuang-settings') || '{}').workbenchView; } catch { return 'ERR'; } })() })`);
  check('★25 重开工作台 → 直接就是上次选的文件夹树形态（展开态是新一轮，所以只看形态）',
    reopened.chips === 0 && reopened.worlds >= 1 && reopened.setting === 'tree', reopened);

  /* ⑩ 切回列表并复位（别污染后面在同一实例上跑的套件） */
  check('26 切回列表', await ev(`(() => { const b = [...document.querySelectorAll('[data-cx-view]')].find((x) => x.textContent.trim() === '列表'); if (!b) return false; b.click(); return true; })()`));
  await sleep(600);
  const backList = await ev(`({ setRow: document.querySelectorAll('#cx-list .ed-tset').length, chips: document.querySelectorAll('#cx-chips button').length })`);
  check('★27 回到列表形态（chips 回来、`_设定` 行消失）+ 默认形态也改回 list',
    backList.setRow === 0 && backList.chips > 0 && (await setting()) === 'list', { ...backList, setting: await setting() });

  const errs = await ev(`window.__errs`);
  check('28 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n==== ${pass}/${results.length} PASS ====`);
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 异常：' + (e && e.stack ? e.stack : e)); process.exit(1); });
