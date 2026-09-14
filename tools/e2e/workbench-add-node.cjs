/* 不变量：**在工作台里也能直接建节点**（不必先知道"新建节点要去世界沙盘"）。
 *
 * 用户 2026-09-13：「说实话，添加实体按钮在事件节点中其实可以改成添加节点的，
 * 毕竟万一用户不知道添加事件节点要在世界沙盒怎么办」→ 又说「添加节点就直接添加节点吧，
 * 就像添加实体一样」。
 * 于是顶栏那组控件按类别换：实体态 = 「类型 ▾ + ＋新建实体」，节点态 = 「时间线 ▾ + ＋新建节点」，
 * 点一下**直接建**（和新建实体同一套手感），建完在工作台里选中它 —— 名字/时间/字段就在中栏改。
 *
 * 本脚本盯四件事：
 *   ① 节点态顶栏真的换成了那一组（且另一组藏起来、禁用 —— 隐藏元素仍吃程序化 click）；
 *   ② 点一下树里多一行、工作台选中它、中栏是它的字段；
 *   ③ 它落进 vault 的 `<世界>/<时间线>/<种类>/新节点.md`（种类跟着"正在看的那条"）；
 *   ④ 在中栏改名 ⇒ 文件跟着改名（同 id 的旧文件不留第二份）。
 *
 * 用法：`node tools/e2e/reset-entity-vault.cjs && node tools/e2e/seed-node.cjs` → 起应用 →
 *       `LK_CDP_PORT=NNNN node tools/e2e/workbench-add-node.cjs`（在 %TEMP%\lk-evault2 那套目录上跑）。 */
const fs = require('fs');
const path = require('path');
const VAULT = process.env.LINGKUANG_VAULT;
const PORT = process.env.LK_CDP_PORT || '9334';
const WS = '测试世界观';
const TL = '主线';
const KIND = '事件';
const NODE_DIR = path.join(VAULT, WS, TL, KIND);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

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
  const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(250); } return false; };
  const clk = (sel) => ev(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return false; el.click(); return true; })()`);
  const clkText = (sel, text) => ev(`(() => { const el=[...document.querySelectorAll(${JSON.stringify(sel)})].find((x)=>(x.textContent||'').includes(${JSON.stringify(text)})); if(!el) return false; el.click(); return true; })()`);
  /** 公共属性面板里某一行的控件（键名 span 的文本就是 '标题'/'描述'…） */
  const ROW = (k) => `[...document.querySelectorAll('#cx-props .ed-props > div')].find((r) => r.firstElementChild?.textContent === ${JSON.stringify(k)})?.querySelector('input,textarea,select')`;
  const nodeRows = `document.querySelectorAll('#cx-list .ed-tnode-item[data-act="node"]').length`;
  const nodeLabels = `[...document.querySelectorAll('#cx-list .ed-tnode-item[data-act="node"]')].map((x)=>(x.querySelector('.ed-tlabel')?.textContent||''))`;

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  await sleep(1200);

  /* 先进节点态：点树里的节点行 —— 顶栏那组控件就是这一刻该换的 */
  const picked = await clkText('#cx-list .ed-tnode-item[data-act="node"]', '王国的建立');
  await sleep(600);
  const ctl = await ev(`(() => {
    const vis = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).display !== 'none' : null; };
    const tlSel = document.querySelector('#cx-new-tl');
    const btn = document.querySelector('#cx-new');   /* 顶栏只有**一个**按钮（标签会滚字） */
    const t = btn ? btn.querySelector('.lk-roll__t') : null;
    const off = (sel) => [...document.querySelectorAll(sel)].map((el) => el.disabled);
    return { picked: ${picked}, entVis: vis('#cx-new-entity'), nodeVis: vis('#cx-new-node'),
      tlText: tlSel ? tlSel.options[tlSel.selectedIndex]?.textContent : null, tlValue: tlSel ? tlSel.value : null,
      btnOff: btn ? btn.disabled : null, entCtlOff: off('#cx-new-entity select, #cx-new-entity input'),
      /* 滚动盒里只有「实体 / 节点」两个字，不动的「＋新建」在盒外（用户 2026-09-14）。
         ⚠️ 别直接读 btn.textContent：这一刻盒里可能还挂着克隆的旧字（lk-roll__prev）。 */
      label: t ? (t.textContent || '').trim() : null,
      btnText: btn ? (((btn.firstChild && btn.firstChild.textContent) || '') + (t ? (t.textContent || '') : '')).trim() : null,
      labels: [...document.querySelectorAll('#cx-newbox .lk-newlbl')].map((e) => e.textContent),
      boxH: Math.round(document.querySelector('#cx-newbox').getBoundingClientRect().height) };
  })()`);
  check('★0 前置：进节点态后顶栏换成「时间线 ▾ + 数量」，按钮上的字变成＋新建节点（另一组藏起来且禁用）',
    ctl.picked === true && ctl.nodeVis === true && ctl.entVis === false
      && ctl.btnOff === false && ctl.entCtlOff.length > 0 && ctl.entCtlOff.every((d) => d === true)
      && ctl.tlText === TL && ctl.label === '节点' && ctl.btnText === '＋新建节点', ctl);
  /* 用户 2026-09-14：「新建实体左边两个按钮有什么用」—— 它们长得像按钮又没说清用途，
     现在每个控件前面挂一句小字（实体态：类型/数量；节点态：时间线/数量）。 */
  check('★0b 顶栏那两个控件各有一句说明小字（类型/时间线 + 数量）',
    Array.isArray(ctl.labels) && ctl.labels.join('|') === '类型|数量|时间线|数量', ctl.labels);

  /* 点一下**直接建** —— 不弹表单（用户：「就像添加实体一样」） */
  const before = await ev(nodeRows);
  await clk('#cx-new');
  await sleep(700);
  const after = await ev(`({ n: ${nodeRows}, labels: ${nodeLabels},
    path: document.querySelector('#cx-nodepath')?.textContent ?? null,
    title: ${ROW('标题')}?.value ?? null,
    panelOpen: !!document.querySelector('#lk-node-panel'),
    on: [...document.querySelectorAll('#cx-list .ed-tnode-item[data-act="node"]')].filter((x)=>x.classList.contains('is-on')).map((x)=>(x.querySelector('.ed-tlabel')?.textContent||'')) })`);
  check('★1 点一下树里就多一行「新节点」（不是弹表单）',
    after.n === before + 1 && after.labels.includes('新节点') && after.panelOpen === false,
    { before, after: after.labels });
  check('★2 而且工作台**选中了它**：面包屑是中栏那行、标题字段是「新节点」、左树高亮在它身上',
    String(after.path ?? '').includes(TL) && String(after.path ?? '').includes(KIND)
      && after.title === '新节点' && after.on.length === 1 && after.on[0] === '新节点', after);

  /* 落盘：`<世界>/<时间线>/<种类>/新节点.md`（种类跟着"正在看的那条"= 事件） */
  const file = path.join(NODE_DIR, '新节点.md');
  const landed = await waitFor(() => read(file).includes('title: 新节点'));
  check('★3 它落进 vault：' + path.join(TL, KIND, '新节点.md') + '（种类跟着正在看的那条）',
    landed && exists(file), { file, body: read(file).slice(0, 120) });
  const idBefore = (read(file).match(/^id:\s*(.+)$/m) || [])[1] || null;

  /* 中栏改名 ⇒ 文件跟着改名（同 id 的旧文件不留第二份） */
  await ev(`(() => { const i = ${ROW('标题')}; if (!i) return false; i.value = '雪原之夜'; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const renamed = path.join(NODE_DIR, '雪原之夜.md');
  const renamedOk = await waitFor(() => exists(renamed) && !exists(file));
  check('★4 中栏改个名字，文件跟着改名（旧的「新节点.md」不留第二份）',
    renamedOk, { 新: exists(renamed), 旧: exists(file), id: (read(renamed).match(/^id:\s*(.+)$/m) || [])[1] || null });
  check('★5 改名后还是同一个节点（id 没变 ⇒ 是改名不是新建）',
    !!idBefore && (read(renamed).match(/^id:\s*(.+)$/m) || [])[1] === idBefore, { idBefore });
  const treeNow = await ev(nodeLabels);
  check('★6 左树那行也跟着改成新名字', treeNow.includes('雪原之夜') && !treeNow.includes('新节点'), treeNow);

  /* ── 2026-09-13 四条新需求里的三条（类型跟随 / 批量新建 / 「待填」强调）───────────────
     用户原话：「我想要当前选中的是哪个分类就自动在当前分类下创建实体，还有我希望能同时创建
     多个未填数据的实体或者节点（强调显示一下就行）」。第四条（帧条出入场动画）在
     `codex-smooth-switch.cjs` ★13c 里断言。 */
  const entLabels = `[...document.querySelectorAll('#cx-list .ed-tnode-item[data-act="entity"]')].map((x)=>(x.querySelector('.ed-tlabel')?.textContent||''))`;
  const stubRows = `[...document.querySelectorAll('#cx-list .ed-tnode-item.is-stub')].map((x)=>(x.querySelector('.ed-tlabel')?.textContent||''))`;
  const typeSel = `document.querySelector('#cx-new-type')?.value ?? null`;
  const firstType = `[...document.querySelectorAll('#cx-new-type option')].map((o)=>o.value)[0] ?? null`;
  const setCount = (sel, n) => ev(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); if (!i) return false; i.value = ${JSON.stringify(String(n))}; return true; })()`);
  const setType = (v) => ev(`(() => { const s = document.querySelector('#cx-new-type'); if (!s) return false; s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);

  /* ① 类型跟随：把**正在编的那条**的类型改掉（中栏 `#cx-type`）⇒ 顶栏新建的类型要跟着变。
     判别力在于：跟随到的类型**不是**下拉的第一个选项（否则"没跟随"也读得到第一项）。 */
  await clkText('#cx-list .ed-tnode-item[data-act="entity"]', '银发少女');
  await sleep(700);
  const firstOpt = await ev(firstType);
  const itsType = await ev(`(() => { const s = document.querySelector('#cx-type'); return s ? s.value : null; })()`);
  const otherType = await ev(`[...document.querySelectorAll('#cx-type option')].map((o)=>o.value).find((v)=>v !== ${JSON.stringify(itsType)}) ?? null`);
  await ev(`(() => { const s = document.querySelector('#cx-type'); if (!s) return false; s.value = ${JSON.stringify(otherType)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(900);
  const followed = await ev(typeSel);
  check('★8 顶栏的新建类型**跟着正在编的那条走**（那条的类型是「' + otherType + '」，下拉就跟到它；而第一个选项是「' + firstOpt + '」）',
    !!otherType && followed === otherType && followed !== firstOpt, { firstOpt, itsType, otherType, followed });

  /* ② 批量新建：「一次建几个」填 3 ⇒ 树里多 3 行，名字自动唯一（同名会撞同一个 .md 路径） */
  const entBefore = await ev(entLabels);
  await setCount('#cx-new-count', 3);
  await clk('#cx-new');
  await sleep(900);
  const batch = await ev(`({ labels: ${entLabels}, stubs: ${stubRows},
    tags: [...document.querySelectorAll('#cx-list .ed-tnode-item.is-stub')].map((x)=>(x.querySelector('.ed-ttag')?.textContent||'')),
    on: [...document.querySelectorAll('#cx-list .ed-tnode-item[data-act="entity"]')].filter((x)=>x.classList.contains('is-on')).map((x)=>(x.querySelector('.ed-tlabel')?.textContent||'')),
    newType: ${typeSel} })`);
  const added = batch.labels.filter((x) => !entBefore.includes(x));
  check('★9 一次建 3 个：树里多 3 行、名字各不相同（新实体 / 新实体 2 / 新实体 3）',
    added.length === 3 && new Set(added).size === 3 && added.includes('新实体') && added.includes('新实体 2') && added.includes('新实体 3'),
    { added });
  check('★10 这 3 条都带「待填」强调（is-stub 类 + 名字后面的小药丸）',
    batch.stubs.length === 3 && batch.tags.length === 3 && batch.tags.every((t) => t === '待填') && batch.on.length === 1 && batch.on[0] === '新实体',
    { stubs: batch.stubs, tags: batch.tags, on: batch.on });

  const EDIR = path.join(VAULT, WS, '_设定', String(otherType));
  const entFiles = ['新实体.md', '新实体 2.md', '新实体 3.md'];
  const landedAll = await waitFor(() => entFiles.every((f) => read(path.join(EDIR, f)).includes('name:')));
  check('★11 三条都真的落进 vault：_设定/' + otherType + '/新实体{ ,2,3}.md',
    landedAll, { EDIR, files: entFiles.map((f) => exists(path.join(EDIR, f))) });

  /* ③ 跟随也发生在**换条目**时：手动把下拉拨到别的类型，再点回「银发少女」⇒ 要跟回它自己的类型 */
  const manual = await setType(String(otherType === '角色' ? '物品' : '角色'));
  await clkText('#cx-list .ed-tnode-item[data-act="entity"]', '银发少女');
  await sleep(900);
  const back = await ev(`({ type: ${typeSel}, its: (() => { const s = document.querySelector('#cx-type'); return s ? s.value : null; })() })`);
  check('★12 换条目时也跟上：手动把下拉拨到「' + manual + '」，点回「银发少女」⇒ 下拉回到它自己的类型',
    back.type === back.its && back.type === otherType && manual !== otherType, { manual, back });

  /* ④ 改了名字 ⇒ 「待填」自动消失（这条不是新条目了） */
  await ev(`(() => { const r=[...document.querySelectorAll('#cx-list .ed-tnode-item[data-act="entity"]')].find((x)=>(x.querySelector('.ed-tlabel')?.textContent||'')==='新实体'); if(!r) return false; r.click(); return true; })()`);
  await sleep(700);
  await ev(`(() => { const i = document.querySelector('#cx-name'); if (!i) return false; i.value = '待填守卫'; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(900);
  const afterRename = await ev(`({ stubs: ${stubRows}, labels: ${entLabels} })`);
  check('★13 改过名之后就不算「待填」了（小药丸消失，另外两条还在）',
    afterRename.labels.includes('待填守卫') && !afterRename.stubs.includes('待填守卫') && afterRename.stubs.length === 2,
    { stubs: afterRename.stubs });

  /* ⑤ 节点侧也能量产（「一次建几个」是两套顶栏各一个框） */
  await clkText('#cx-list .ed-tnode-item[data-act="node"]', '王国的建立');
  await sleep(700);
  const nodeBefore = await ev(nodeLabels);
  await setCount('#cx-new-node-count', 2);
  await clk('#cx-new');
  await sleep(900);
  const nodeBatch = await ev(`({ labels: ${nodeLabels}, stubs: ${stubRows},
    path: document.querySelector('#cx-nodepath')?.textContent ?? null })`);
  const nodeAdded = nodeBatch.labels.filter((x) => !nodeBefore.includes(x));
  const nodeLanded = await waitFor(() => exists(path.join(NODE_DIR, '新节点.md')) && exists(path.join(NODE_DIR, '新节点 2.md')));
  check('★14 节点侧一次建 2 个：树里多 2 行、名字唯一、都落进 ' + path.join(TL, KIND),
    nodeAdded.length === 2 && nodeAdded.includes('新节点') && nodeAdded.includes('新节点 2')
      && nodeBatch.stubs.filter((x) => x.startsWith('新节点')).length === 2 && nodeLanded,
    { nodeAdded, stubs: nodeBatch.stubs, nodeLanded });

  /* ── ⑥ 左树按**时间**排 + 新节点一建出来就在"对应的位置" ────────────────────
     用户 2026-09-14：「新建节点时直接插入尾部然后移到正确的顺序，能不能直接插入到对应的位置」。
     两处机制：
       · `tlGroups()` 按 epoch 排节点（与沙盘从左到右一致），不再按数组顺序 ——
         数组顺序会随 vault 回扫变成"文件夹 + 文件名"顺序；
       · 新建节点时 `year` 取**时间指针**那一年（`cursorYear`），所以它出生就在时间轴上的位置。
     前置（跑本套件时要给）：`LK_SEED_ORDER=1 node tools/e2e/seed-node.cjs` ——
     它会多播一个 year:1 的「上古」，并把指针设在 year 200（夹在 1 与 312 之间）。 */
  const ordered = await ev(nodeLabels);
  const at = (t) => ordered.indexOf(t);
  check('★15 左树按**时间**排：year 1 的「上古」排在 year 312 的「王国的建立」前面（不是按数组/文件名顺序）',
    at('上古') === 0 && at('王国的建立') > 0, ordered);
  const appliedYear = (read(path.join(NODE_DIR, '新节点.md')).match(/^year:\s*(.+)$/m) || [])[1] || null;
  check('★16 工作台建的节点，年份取的是**时间指针那一年**（year 200，不是旧默认的 0）',
    Number(appliedYear) === 200, { appliedYear });
  check('★17 于是它一建出来就落在**对应的位置**上：上古(1) < 新节点(200) < 王国的建立(312)，而不是挂在末尾',
    at('新节点') > at('上古') && at('新节点') < at('王国的建立'), ordered);

  const errs = await ev(`window.__errs`);
  check('★20 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const n = results.filter(Boolean).length;
  console.log(`\n==== ${n}/${results.length} PASS ====`);
  process.exit(n === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack || e)); process.exit(2); });
