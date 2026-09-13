/* 工作台里编辑**时间线节点**（合并方案 A 第 3 步；文件名是历史遗留 —— 左栏那两个页签已在
   2026-09-13 的左栏重做里撤掉，现在是「筛选 pills + 一个视图按钮」）：
   左列筛选/文件夹树 + 搜索、中栏用**公共属性面板**（与编辑器同一份实现）、右栏正文编辑器，
   并且编辑结果要落到节点的 vault `.md`（`#描述：` / `#正文：` 两个 tag）。
   用法：先 reset-entity-vault.cjs + seed-node.cjs，起应用，再跑本脚本。 */
const fs = require('fs');
const path = require('path');
const VAULT = process.env.LINGKUANG_VAULT;
const PORT = process.env.LK_CDP_PORT || '9334';
const NODE_MD = path.join(VAULT, '测试世界观', '主线', '事件', '王国的建立.md');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }
const read = () => { try { return fs.readFileSync(NODE_MD, 'utf8'); } catch { return ''; } };

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
  const clickText = (sel, text) => ev(`(() => { const el=[...document.querySelectorAll(${JSON.stringify(sel)})].find((x)=>(x.textContent||'').includes(${JSON.stringify(text)})); if(!el) return false; el.click(); return true; })()`);
  /** 公共属性面板里某一行的控件（键名 span 的文本就是 '标题'/'描述'…） */
  const ROW = (k) => `[...document.querySelectorAll('#cx-props .ed-props > div')].find((r) => r.firstElementChild?.textContent === ${JSON.stringify(k)})?.querySelector('input,textarea,select')`;
  const ROW_KEYS = `[...document.querySelectorAll('#cx-props .ed-props > div')].map((r) => r.firstElementChild?.textContent).filter(Boolean)`;
  const DOC = `document.querySelector('#cx-doc .ProseMirror')?.textContent ?? null`;
  const LIST_TEXTS = `[...document.querySelectorAll('#cx-list .ed-tnode, #cx-list > div')].map((x) => (x.textContent||'').trim())`;

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  await sleep(1200);

  /* ① 左栏**只有一棵树** —— 没有类别页签、没有形态开关、也没有筛选 pills。
        形态之争到此结束（用户 2026-09-13 的两句话）：
          「时间线节点和实体这两个按钮，列表和文件夹树的功能有点混乱」→ 重做成「筛选 + 一个视图开关」
          → 又说「把全部改成文件树的形式，这样子也方便看」。
        这条断言守着"别再长出第二套控件 / 第二种长相"。 */
  const ctl = await ev(`({ chips: document.querySelectorAll('#cx-chips,[data-cx-chip]').length,
                            view: document.querySelectorAll('#cx-view').length,
                            tabs: document.querySelectorAll('#cx-tab-entity,#cx-tab-node').length,
                            worlds: document.querySelectorAll('#cx-list .ed-tworld').length })`);
  check('1 左栏只有一棵树（没有类别页签 / 形态开关 / 筛选 pills）',
    ctl.chips === 0 && ctl.view === 0 && ctl.tabs === 0 && ctl.worlds === 1, ctl);

  /* ② 树**默认全展开**：一次点击都不用，各层就都在（"方便看"就是这个意思） */
  const open0 = await ev(`({ tl: document.querySelectorAll('#cx-list .ed-ttl').length,
                              kind: document.querySelectorAll('#cx-list .ed-tkind').length,
                              node: document.querySelectorAll('#cx-list .ed-tnode-item[data-act="node"]').length,
                              set: document.querySelectorAll('#cx-list .ed-tset').length,
                              etype: document.querySelectorAll('#cx-list .ed-ttype').length,
                              ent: document.querySelectorAll('#cx-list .ed-tnode-item[data-act="entity"]').length,
                              worldOpen: !!document.querySelector('#cx-list .ed-tworld.is-open') })`);
  check('2 打开就是全展开（时间线/种类/节点/设定/类型/实体 都在，无需点击）',
    open0.worldOpen && open0.tl > 0 && open0.kind > 0 && open0.node > 0 && open0.set > 0 && open0.etype > 0 && open0.ent > 0, open0);

  /* ③ 收放都还在：点世界行收起它这一枝，再点展开回来 */
  await click('#cx-list .ed-tworld');
  await sleep(300);
  const closed = await ev(`({ tl: document.querySelectorAll('#cx-list .ed-ttl').length,
                               set: document.querySelectorAll('#cx-list .ed-tset').length })`);
  await click('#cx-list .ed-tworld');
  await sleep(300);
  const reopened = await ev(`({ tl: document.querySelectorAll('#cx-list .ed-ttl').length,
                                set: document.querySelectorAll('#cx-list .ed-tset').length })`);
  check('3 点世界行收起、再点展开（默认展开 ≠ 不能收）',
    closed.tl === 0 && closed.set === 0 && reopened.tl > 0 && reopened.set > 0, { closed, reopened });

  /* ④ 层级与顺序 = 硬盘目录：世界 → 时间线 → 种类 → 节点，然后 世界 → _设定 → 类型 → 实体 */
  const order = await ev(`[...document.querySelectorAll('#cx-list .ed-tree > .ed-tnode')].map((x)=>({cls:x.className, t:(x.querySelector('.ed-tlabel')?.textContent||'')}))`);
  const at = (pred) => (order || []).findIndex(pred);
  const iTl = at((r) => r.cls.includes('ed-ttl'));
  const iKind = at((r) => r.cls.includes('ed-tkind'));
  const iNode = at((r) => r.cls.includes('ed-tnode-item') && r.t === '王国的建立');
  const iSet = at((r) => r.cls.includes('ed-tset'));
  const iType = at((r) => r.cls.includes('ed-ttype'));
  const iEnt = at((r) => r.cls.includes('ed-tnode-item') && r.t === '银发少女');
  check('4 层级顺序 = 硬盘目录（时间线 → 种类 → 节点，然后 _设定 → 类型 → 实体）',
    iTl > 0 && iTl < iKind && iKind < iNode && iNode < iSet && iSet < iType && iType < iEnt,
    { iTl, iKind, iNode, iSet, iType, iEnt, rows: (order || []).map((r) => r.t) });
  check('5 种类层是「事件」（节点种类只列真有节点的，跟实体类型不撞名）',
    (order || []).some((r) => r.cls.includes('ed-tkind') && r.t === '事件'), (order || []).map((r) => r.t));
  check('5b 节点条目就在树里（不用展开也能点）',
    (order || []).some((r) => r.cls.includes('ed-tnode-item') && r.t === '王国的建立'), (order || []).map((r) => r.t));

  /* ③ 选中节点 → 中栏是**公共属性面板**、右栏是正文编辑器 */
  await clickText('#cx-list .ed-tnode-item', '王国的建立');
  await sleep(900);
  const keys = await ev(ROW_KEYS);
  const need = ['标题', '时间', '精度', '类型', '种类', '描述'];
  check('★6 中栏用公共属性面板（标题/时间/精度/类型/种类/描述 都在）', need.every((k) => (keys || []).includes(k)), keys);
  check('7 属性区带上了种类模板的字段（地点/规模）', (keys || []).includes('地点') && (keys || []).includes('规模'), keys);
  const doc0 = await ev(DOC);
  check('8 右栏正文编辑器载入了节点正文', String(doc0 ?? '').includes('灰烬'), String(doc0 ?? '').slice(0, 40));
  check('9 顶部显示面包屑（世界 · 时间线 · 种类）', String(await ev(`document.querySelector('#cx-root')?.textContent ?? ''`)).includes('测试世界观 · 主线 · 事件'));

  /* ③b 提交字段后**面板不重建**（元素身份不变）—— 这是「拖拽中的 scrub 控件不被销毁」的前提，
     也就是 `props-panel` 那条 `quiet` 提交路径唯一的守卫。
     （原来在 `editor-props-panel.cjs` 里；编辑器工具并进工作台后搬到这里。
       探针用种类模板字段「地点」，不动标题 —— 标题会改 .md 文件名，本套件后面按固定路径读文件。） */
  const sameEl = await ev(`(() => {
    const row = [...document.querySelectorAll('#cx-props .ed-props > div')].find((r) => r.firstElementChild?.textContent === '地点');
    const inp = row?.querySelector('input');
    if (!inp) return null;
    window.__probeInput = inp;
    inp.value = '安德希亚';
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    const still = document.querySelector('#cx-props .ed-props')?.contains(window.__probeInput);
    return { sameEl: still === true };
  })()`);
  check('★9b 提交后面板没被重建（输入框元素身份不变）', !!sameEl && sameEl.sameEl === true, sameEl);
  const probed = await waitFor(() => read().includes('安德希亚'));
  check('★9c 这一次提交确实落进了 .md（不是"什么都没发生"式的假绿）', probed, read().slice(0, 200));

  /* ④ 改描述 → 落到 .md 的 `#描述：` 段 */
  await ev(`(() => { const el = ${ROW('描述')}; el.value='改写后的描述：基石落地。'; el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
  const descOk = await waitFor(() => /#描述：\n改写后的描述/.test(read()));
  check('★10 改「描述」落进 .md 的 #描述： 段', descOk, read().slice(-90));

  /* ⑤ 改正文 → 落到 .md 的 `#正文：` 段 */
  const bodyOk = await waitFor(() => ev(`!!document.querySelector('#cx-doc .ProseMirror')`));
  if (bodyOk) {
    await ev(`document.querySelector('#cx-doc .ProseMirror').focus(); true`);
    await send('Input.insertText', { text: '（页签测试补写）' });
    await sleep(300);
    await ev(`document.querySelector('#cx-search').focus(); true`);   /* 失焦 → flush */
  }
  const bodySaved = await waitFor(() => read().includes('（页签测试补写）'));
  check('★11 改正文落进 .md 的 #正文： 段', bodySaved, read().slice(-120));

  /* ⑥ 搜索：非空时把树摊平成命中列表 */
  await ev(`(() => { const s=document.querySelector('#cx-search'); s.value='王国'; s.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  await sleep(500);
  const hit = await ev(LIST_TEXTS);
  check('12 搜索「王国」命中该节点（树摊平成列表）', Array.isArray(hit) && hit.some((t) => t.includes('王国的建立')) && !hit.some((t) => t.includes('测试世界观')), hit);
  await ev(`(() => { const s=document.querySelector('#cx-search'); s.value='不存在的标题zzz'; s.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  await sleep(500);
  check('13 搜不到时给出空提示', String(await ev(`document.querySelector('#cx-list')?.textContent ?? ''`)).includes('没有匹配的条目'), await ev(`document.querySelector('#cx-list')?.textContent`));

  /* ⑦ 切回看设定 → 正文框要换成实体的正文，不能留着节点的（跨类别不串文档） */
  await ev(`(() => { const s=document.querySelector('#cx-search'); s.value=''; s.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  await sleep(400);
  await ev(`document.querySelector('#cx-list .ed-tnode-item[data-act="entity"]').click(); true`);
  await sleep(900);
  const entView = await ev(`!!document.querySelector('#cx-name')`);
  const docE = await ev(DOC);
  check('★14 切回设定条目后正文框显示的是实体的正文（没有留给节点的正文）',
    entView && String(docE ?? '').includes('实体自己的正文')
    && !String(docE ?? '').includes('灰烬') && !String(docE ?? '').includes('页签测试补写'),
    { ent: entView, doc: String(docE ?? '').slice(0, 40) });

  const errs = await ev(`window.__errs`);
  check('15 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const n = results.filter(Boolean).length;
  console.log(`\n==== ${n}/${results.length} PASS ====`);
  process.exit(n === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack || e)); process.exit(2); });
