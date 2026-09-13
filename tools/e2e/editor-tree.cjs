/* 编辑器文件树：树的文件夹要跟**硬盘上的文件夹**一一对应。
 *
 * 用户 2026-09-13 原话：「就是编辑器的树现在只能显示事件节点，其他结构体的文件夹没有在树里面」
 * 旧行为：种类文件夹是从「这条时间线已有的节点」反推出来的 ⇒ 一个节点都没有的结构体
 * （战斗 / 地点 / 组织…）在树里**根本不存在**；`_设定`（实体）也完全不在「时间线」页签的树里。
 *
 * 本套件钉住的四件事：
 *   ① 空的结构体文件夹**也在树里**（置灰 + 计数 0，展开给一句人话）；
 *   ② `_设定` 分支列出**全部实体类型**（包括一个实体都没有的），空的同样置灰；
 *   ③ 在「时间线」页签的树里点实体行 = **切到「实体」页签再选中它**（两个页签各记自己那份文档，
 *      就地换会把节点正文写进实体文件）；
 *   ④ 全程无未捕获异常。
 *
 * 用法：先 `node tools/e2e/seed-editor-tree.cjs`（配 LINGKUANG_TEST_DATA / LINGKUANG_VAULT），
 *       起应用（带 --remote-debugging-port），再 `LK_CDP_PORT=xxxx node tools/e2e/editor-tree.cjs`。
 */
const PORT = process.env.LK_CDP_PORT || '9704';
const WS = process.env.LK_WS || '测试世界观';
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
  const click = (sel) => ev(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return false; el.click(); return true; })()`);
  /* 按 data-kind + data-path 点树里的一行（每点一次树会重建，所以每次都得重新查） */
  const clickRow = (kind, p) => ev(`(() => {
    const el = [...document.querySelectorAll('#ed-sidebar .ed-tnode')]
      .find((e) => e.dataset.kind === ${JSON.stringify(kind)} && e.dataset.path === ${JSON.stringify(p)});
    if (!el) return false; el.click(); return true; })()`);
  const rowInfo = (kind, p) => ev(`(() => {
    const el = [...document.querySelectorAll('#ed-sidebar .ed-tnode')]
      .find((e) => e.dataset.kind === ${JSON.stringify(kind)} && e.dataset.path === ${JSON.stringify(p)});
    if (!el) return null;
    const label = el.querySelector('.ed-tlabel');
    return { label: label?.textContent ?? '', count: el.querySelector('.ed-tcount')?.textContent ?? '',
             empty: el.classList.contains('is-empty'), opacity: label ? getComputedStyle(label).opacity : null }; })()`);
  /* 树里某种行（按 class 限定层次，避免与「实体」页签的同名 data-kind 混） */
  const listRows = (cls) => ev(`[...document.querySelectorAll('#ed-sidebar ${cls}')].map((e) => ({
      kind: e.dataset.kind, path: e.dataset.path ?? '', label: e.querySelector('.ed-tlabel')?.textContent ?? '',
      count: e.querySelector('.ed-tcount')?.textContent ?? '', empty: e.classList.contains('is-empty') }))`);
  const empties = () => ev(`[...document.querySelectorAll('#ed-sidebar .ed-tempty')].map((e) => e.textContent)`);

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await click('[data-tool="editor"]');
  await sleep(1200);
  check('0 编辑器打开、左树有时间线页签的树', await ev(`!!document.querySelector('#ed-sidebar .ed-tworld')`));

  /* 展开 世界 → 时间线 */
  check('1 展开世界', await clickRow('world', WS));
  await sleep(300);
  const tls = await listRows('.ed-ttl');
  check('2 时间线下有这条时间线', tls.some((r) => r.path === 'tl-主线'), tls);
  check('3 展开时间线', await clickRow('tl', 'tl-主线'));
  await sleep(300);

  /* ── ① 空的结构体文件夹也在树里 ─────────────────────────────── */
  const kinds = await listRows('.ed-tkind');
  const ev1 = kinds.find((r) => r.path === '事件');
  const bt = kinds.find((r) => r.path === '战斗');
  check('★4 「事件」在树里且计数 2', !!ev1 && ev1.count === '2', kinds);
  check('★5 「战斗」也在树里（一个节点都没有，但仍要出现）', !!bt, kinds);
  check('★6 「战斗」计数 0 且置灰（is-empty）', !!bt && bt.count === '0' && bt.empty === true, bt);
  const btInfo = await rowInfo('tkind', '战斗');
  check('★7 置灰是真的半透明（label opacity .45）', !!btInfo && btInfo.opacity === '0.45', btInfo);
  check('8 展开空的「战斗」', await clickRow('tkind', '战斗'));
  await sleep(250);
  const es1 = await empties();
  check('★9 空的种类展开后给一句人话（不是一片空白）', es1.some((t) => String(t).includes('这个结构体还没有节点')), es1);

  /* ── ② `_设定` 分支（实体） ─────────────────────────────────── */
  const setRow = await rowInfo('set', '_设定');
  check('★10 时间线页签的树里有 `_设定`（实体）分支', !!setRow && setRow.label === '_设定', setRow);
  check('★11 `_设定` 计数 = 实体数 1', !!setRow && setRow.count === '1', setRow);
  check('12 展开 `_设定`', await clickRow('set', '_设定'));
  await sleep(300);
  const etypes = await listRows('.ed-tset-type');
  const role = etypes.find((r) => r.path === '角色');
  const place = etypes.find((r) => r.path === '地点');
  check('★13 实体类型都列出来：「角色」计数 1', !!role && role.count === '1', etypes);
  check('★14 空的「地点」也在（计数 0 + 置灰）', !!place && place.count === '0', etypes);
  const placeInfo = await rowInfo('etype', '地点');
  check('★15 「地点」置灰（is-empty）', !!placeInfo && placeInfo.empty === true, placeInfo);
  check('16 展开空的「地点」', await clickRow('etype', '地点'));
  await sleep(250);
  const es2 = await empties();
  check('★17 空的类型展开后给一句人话', es2.some((t) => String(t).includes('这个类型还没有实体')), es2);
  check('18 展开「角色」', await clickRow('etype', '角色'));
  await sleep(250);
  const ents = await listRows('[data-kind="entity"]');
  check('★19 「角色」下有实体行（e-tree-a 银发少女）', ents.some((r) => r.path === 'e-tree-a' && r.label === '银发少女'), ents);

  /* ── ③ 在时间线页签的树里点实体 = 切页签 + 选中 ─────────────── */
  const before = await ev(`document.querySelector('#ed-tab-entity')?.style.background ?? ''`);
  check('20 点之前还停在「时间线」页签', before === 'none' || before === '', before);
  check('21 点实体行', await clickRow('entity', 'e-tree-a'));
  await sleep(700);
  const after = await ev(`({ bg: document.querySelector('#ed-tab-entity')?.style.background ?? '',
      title: document.querySelector('#ed-title')?.textContent ?? '',
      doc: document.querySelector('#ed-doc .ProseMirror')?.textContent ?? '',
      fields: [...document.querySelectorAll('#ed-props .ed-props > div')].map((r) => r.firstElementChild?.textContent).filter(Boolean),
      inEntityTab: !!document.querySelector('#ed-sidebar #ed-entity-list'),
      onRow: !!document.querySelector('#ed-sidebar #ed-entity-list [data-kind="entity"][data-path="e-tree-a"].is-on') })`);
  check('★22 页签切到了「实体」', after.bg !== 'none' && after.bg !== '', after.bg);
  check('★23 标题是实体名（银发少女）', after.title === '银发少女', after.title);
  check('★24 正文换成实体自己的正文', String(after.doc).includes('雪原独行'), after.doc);
  check('★25 中栏是实体字段（发色）', after.fields.includes('发色'), after.fields);
  check('★26 实体页签的树里该行已选中（is-on）', after.inEntityTab === true && after.onRow === true, { inEntityTab: after.inEntityTab, onRow: after.onRow });

  const errs = await ev(`window.__errs`);
  check('27 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const n = results.filter(Boolean).length;
  console.log(`\n==== ${n}/${results.length} PASS ====`);
  process.exit(n === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack || e)); process.exit(2); });
