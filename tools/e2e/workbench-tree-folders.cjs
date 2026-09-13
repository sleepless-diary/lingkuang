/* 工作台左栏「文件夹树」的**文件夹语义** —— 从原 `editor-tree.cjs` 搬过来的那批断言
   （编辑器工具下线后，它是这套语义唯一的守卫）。用户 2026-09-13 的两条原话：
     「就是编辑器的树现在只能显示事件节点，其他结构体的文件夹没有在树里面」
     「我指的是角色，地点，物品等文件夹同时存在于主线与设定文件夹下，是bug」

   钉住的是**两类"空"的不同待遇**（别顺手统一，见 `src/ui/codex.ts` 的 renderTreeList）：
     ① 节点**种类**只列真有节点的（= 硬盘上真有这个目录）—— 定义了但没节点的「战斗」「角色」不许画出来；
     ② 实体**类型**列全部（含一个实体都没有的「地点」），置灰 + 展开给一句人话；
     ③ `_設定` 与时间线**平级同缩进**（不跟世界平级），点实体行就地换目标、**树不许被换掉**。

   用法：reset + seed-editor-tree.cjs → **重启应用**（formats.json 是启动时读的）→ 跑本脚本。
         `LK_CDP_PORT=xxxx node tools/e2e/workbench-tree-folders.cjs`
   ⚠️ 左栏**只有这一棵树**且**默认全展开**（用户 2026-09-13：「把全部改成文件树的形式，这样子也方便看」）
      ⇒ 这里不再有"点开某一层"的步骤（点了反而会收起）；形态也与设置无关，不用复位 localStorage。 */
const PORT = process.env.LK_CDP_PORT || '9334';
const WS = '测试世界观';
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
  const clickText = (sel, text) => ev(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => (x.textContent || '').includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`);
  /* 点树里的一行（按 data-act + 可见标签；每点一次树会重建，所以每次都得重新查） */
  const clickRow = (act, label) => ev(`(() => {
    const el = [...document.querySelectorAll('#cx-list .ed-tnode')]
      .filter((e) => e.dataset.act === ${JSON.stringify(act)})
      .find((e) => (e.querySelector('.ed-tlabel')?.textContent ?? '') === ${JSON.stringify(label)});
    if (!el) return false; el.click(); return true; })()`);
  const rowsOf = (sel) => ev(`[...document.querySelectorAll('#cx-list ${sel}')].map((e) => ({
      act: e.dataset.act ?? '', nid: e.dataset.nid ?? '', label: e.querySelector('.ed-tlabel')?.textContent ?? '',
      count: e.querySelector('.ed-tcount')?.textContent ?? '', empty: e.classList.contains('is-empty'),
      on: e.classList.contains('is-on'), open: e.classList.contains('is-open') }))`);
  /** 某一行现在是不是展开着（默认全展开 ⇒ 点一下是**收起**，别瞎点） */
  const rowOpen = (act, label) => ev(`(() => {
    const el = [...document.querySelectorAll('#cx-list .ed-tnode')]
      .filter((e) => e.dataset.act === ${JSON.stringify(act)})
      .find((e) => (e.querySelector('.ed-tlabel')?.textContent ?? '') === ${JSON.stringify(label)});
    return el ? el.classList.contains('is-open') : null; })()`);
  const empties = () => ev(`[...document.querySelectorAll('#cx-list .ed-tempty')].map((e) => e.textContent)`);

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await click('[data-tool="codex"]');
  await sleep(1200);
  const opened = await ev(`({ worlds: document.querySelectorAll('#cx-list .ed-tworld').length, chips: document.querySelectorAll('#cx-chips button').length })`);
  check('0 工作台打开就是文件夹树（左树有世界层、类型 chips 不在）', opened.worlds === 1 && opened.chips === 0, opened);

  /* 世界/时间线**默认就是展开的**（点一下反而是收起） */
  check('1 世界默认展开（一次点击都不用）', (await rowOpen('world', WS)) === true, await rowOpen('world', WS));
  const tls = await rowsOf('.ed-ttl');
  check('2 时间线下有这条时间线', tls.some((r) => r.label === '主线'), tls);
  check('3 时间线也默认展开（种类层已经在）', tls.every((r) => r.open === true), tls);

  /* ── ① 时间线下只列**真的有节点**的种类（= 硬盘上真有的文件夹） ────── */
  const kinds = await rowsOf('.ed-tkind');
  const ev1 = kinds.find((r) => r.label === '事件');
  check('★4 「事件」在树里且计数 2', !!ev1 && ev1.count === '2', kinds);
  check('★5 「战斗」（有定义、没节点）**不在**时间线下', !kinds.some((r) => r.label === '战斗'), kinds);
  check('★5b 「角色」（有定义、没节点，且与实体类型重名）**不在**时间线下', !kinds.some((r) => r.label === '角色'), kinds);
  check('★5c 时间线下的种类**只有**真有节点的那些', kinds.length === 1 && kinds[0].label === '事件', kinds);

  /* ── ② `_設定` 分支（实体） ─────────────────────────────────── */
  const setRow = (await rowsOf('.ed-tset'))[0];
  check('★10 同一棵树里有 `_设定`（实体）分支', !!setRow && setRow.label === '_设定', setRow);
  check('★11 `_設定` 计数 = 实体数 1', !!setRow && setRow.count === '1', setRow);
  /* `_設定` 是**世界下面的一层**（跟时间线平级）—— 用户 2026-09-13：「设定文件夹和世界观文件夹处于同一缩进」 */
  const indent = await ev(`(() => {
    const px = (el) => (el ? getComputedStyle(el).paddingLeft : null);
    return { set: px(document.querySelector('#cx-list .ed-tset')),
             tl: px(document.querySelector('#cx-list .ed-ttl')),
             world: px(document.querySelector('#cx-list .ed-tworld')) }; })()`);
  check('★11b `_設定` 与时间线同一缩进（不跟世界平级）', indent.set === indent.tl && indent.set !== indent.world, indent);
  check('12 `_設定` 默认展开（类型层已经在）', (await rowOpen('wset', '_设定')) === true, await rowOpen('wset', '_设定'));
  const etypes = await rowsOf('.ed-tset-type');
  const role = etypes.find((r) => r.label === '角色');
  const place = etypes.find((r) => r.label === '地点');
  check('★13 实体类型都列出来：「角色」计数 1', !!role && role.count === '1', etypes);
  check('★14 空的「地点」也在（计数 0 + 置灰）', !!place && place.count === '0' && place.empty === true, etypes);
  /* 用户报的「同名文件夹挂在两处」：整棵树里「角色」只许出现一次，且必须是在 `_设定` 那边 */
  const roleEverywhere = await ev(`(() => {
    const hit = [...document.querySelectorAll('#cx-list .ed-tnode')]
      .filter((el) => el.querySelector('.ed-tlabel')?.textContent === '角色');
    return hit.map((el) => el.className);
  })()`);
  check('★15 全树里「角色」只出现一次，且在 `_設定` 下（不是时间线下的种类）',
    roleEverywhere.length === 1 && roleEverywhere[0].includes('ed-tset-type'), roleEverywhere);
  /* 空类型**默认就是展开的** ⇒ 那句人话本来就在（点一下反而会把它收起来） */
  const es2 = await empties();
  check('★17 空的类型展开后给一句人话', es2.some((t) => String(t).includes('这个类型还没有实体')), es2);
  const ents = await rowsOf('[data-act="entity"]');
  check('★19 「角色」下有实体行（e-tree-a 银发少女）', ents.some((r) => r.nid === 'e-tree-a' && r.label === '银发少女'), ents);

  /* ── ③ 在树里点实体 = **就地**选中，树不许被换掉 ─────────────────── */
  check('20 点实体行', await ev(`(() => { const el = document.querySelector('#cx-list [data-act="entity"][data-nid="e-tree-a"]'); if (!el) return false; el.click(); return true; })()`));
  await sleep(800);
  const after = await ev(`({ name: document.querySelector('#cx-name')?.value ?? '',
      doc: document.querySelector('#cx-doc .ProseMirror')?.textContent ?? '',
      fields: [...document.querySelectorAll('#cx-fields > div')].map((r) => r.firstElementChild?.textContent).filter(Boolean),
      roles: [...document.querySelectorAll('#cx-list [data-act="world"]')].map((e) => e.dataset.nw),
      tlRows: [...document.querySelectorAll('#cx-list .ed-ttl')].map((e) => e.querySelector('.ed-tlabel')?.textContent ?? ''),
      kindRows: [...document.querySelectorAll('#cx-list .ed-tkind')].map((e) => e.querySelector('.ed-tlabel')?.textContent ?? ''),
      setRows: [...document.querySelectorAll('#cx-list .ed-tset')].map((e) => e.querySelector('.ed-tlabel')?.textContent ?? ''),
      setOpen: !!document.querySelector('#cx-list .ed-tset')?.classList.contains('is-open'),
      entitiesOpen: !!document.querySelector('#cx-list [data-act="etype"].is-open'),
      entOn: !!document.querySelector('#cx-list [data-act="entity"][data-nid="e-tree-a"]')?.classList.contains('is-on'),
      chips: document.querySelectorAll('#cx-chips button').length })`);
  check('★22 树没被换掉（还在文件夹树里，不是切成了列表）', after.chips === 0 && after.setRows.length === 1, { chips: after.chips, setRows: after.setRows });
  check('★23 世界文件夹还在（测试世界观）', after.roles.includes(WS), after.roles);
  check('★23b 时间线还在（主线）', after.tlRows.includes('主线'), after.tlRows);
  check('★23c 种类文件夹还在（真有节点的「事件」），空的「战斗/角色」仍不出现',
    after.kindRows.includes('事件') && !after.kindRows.includes('战斗') && !after.kindRows.includes('角色'), after.kindRows);
  check('★23d `_設定` 仍是展开的（展开态没被重置）', after.setOpen === true && after.entitiesOpen === true, { setOpen: after.setOpen, entitiesOpen: after.entitiesOpen });
  check('★23e 树里这个实体行已高亮', after.entOn === true, after.entOn);
  check('★24 中栏是这个实体（名字 = 银发少女）', after.name === '银发少女', after.name);
  check('★25 正文换成实体自己的正文', String(after.doc).includes('雪原独行'), after.doc);
  check('★26 中栏是实体字段（发色）', after.fields.includes('发色'), after.fields);
  /* 收起 `_設定` 再展开：正在编辑的实体与它的高亮都不该被弄丢。
     （原来这里是「切一次视图形态」；左栏 2026-09-13 只剩一棵树后，换成"收放一枝"这个等价守卫。） */
  await clickRow('wset', '_设定');
  await sleep(400);
  const closed = await ev(`({ name: document.querySelector('#cx-name')?.value ?? '',
      etype: document.querySelectorAll('#cx-list .ed-ttype').length })`);
  await clickRow('wset', '_设定');
  await sleep(400);
  const still = await ev(`({ name: document.querySelector('#cx-name')?.value ?? '',
      on: !!document.querySelector('#cx-list [data-act="entity"][data-nid="e-tree-a"]')?.classList.contains('is-on'),
      setOpen: !!document.querySelector('#cx-list .ed-tset')?.classList.contains('is-open') })`);
  check('★26b 收起再展开 `_設定` 后，还在编辑这个实体、高亮与展开态都回来',
    closed.name === '银发少女' && closed.etype === 0
      && still.name === '银发少女' && still.on === true && still.setOpen === true, { closed, still });

  const errs = await ev(`window.__errs`);
  check('27 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const n = results.filter(Boolean).length;
  console.log(`\n==== ${n}/${results.length} PASS ====`);
  process.exit(n === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack || e)); process.exit(2); });
