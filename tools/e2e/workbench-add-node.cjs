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
    const btn = document.querySelector('#cx-new-node-btn');
    const entBtn = document.querySelector('#cx-new');
    return { picked: ${picked}, entVis: vis('#cx-new-entity'), nodeVis: vis('#cx-new-node'),
      tlText: tlSel ? tlSel.options[tlSel.selectedIndex]?.textContent : null, tlValue: tlSel ? tlSel.value : null,
      btnOff: btn ? btn.disabled : null, entOff: entBtn ? entBtn.disabled : null,
      label: btn ? btn.textContent.trim() : null, boxH: Math.round(document.querySelector('#cx-newbox').getBoundingClientRect().height) };
  })()`);
  check('★0 前置：进节点态后顶栏换成「时间线 ▾ + ＋新建节点」（另一组藏起来且禁用）',
    ctl.picked === true && ctl.nodeVis === true && ctl.entVis === false
      && ctl.btnOff === false && ctl.entOff === true
      && ctl.tlText === TL && String(ctl.label).includes('新建节点'), ctl);

  /* 点一下**直接建** —— 不弹表单（用户：「就像添加实体一样」） */
  const before = await ev(nodeRows);
  await clk('#cx-new-node-btn');
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

  const errs = await ev(`window.__errs`);
  check('★7 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const n = results.filter(Boolean).length;
  console.log(`\n==== ${n}/${results.length} PASS ====`);
  process.exit(n === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack || e)); process.exit(2); });
