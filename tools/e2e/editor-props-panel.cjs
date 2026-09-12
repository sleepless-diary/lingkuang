/* 编辑器这一侧也要守住「公共属性面板」（`src/ui/props-panel.ts` 是节点/实体/编辑器/设定库共用的
   那一份实现）。抽模块时最容易悄悄坏掉的是三条硬指标，这里逐条钉住：
     ① 固定行齐全（标题/时间/精度/类型/种类/描述）+ 种类模板字段；
     ② 提交后**不重渲染整个面板**（否则会销毁正在拖拽的 scrub 控件）—— 用「元素身份没变」判定；
     ③ 时间仍是 scrub（历法推进），描述是 textarea。
   用法：先 reset-entity-vault.cjs + seed-node.cjs，起应用，再跑本脚本。 */
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
  const click = (sel) => ev(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return false; el.click(); return true; })()`);
  const ROWS = `[...document.querySelectorAll('#ed-props .ed-props > div')]`;
  const KEYS = `${ROWS}.map((r) => r.firstElementChild?.textContent).filter(Boolean)`;

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await click('[data-tool="editor"]');
  await sleep(1200);
  check('1 编辑器打开后有左树', await ev(`!!document.querySelector('#ed-sidebar .ed-tworld')`));
  await click('#ed-sidebar .ed-tworld');
  await sleep(300);
  await click('#ed-sidebar .ed-ttl');
  await sleep(300);
  await click('#ed-sidebar .ed-tkind');
  await sleep(300);
  await click('#ed-sidebar .ed-tnode-item');
  await sleep(900);

  const keys = await ev(KEYS);
  const need = ['标题', '时间', '精度', '类型', '种类', '描述'];
  check('★2 属性面板固定行齐全', need.every((k) => (keys || []).includes(k)), keys);
  check('3 种类模板字段也在（地点/规模）', (keys || []).includes('地点') && (keys || []).includes('规模'), keys);
  check('4 时间仍是 scrub（不是输入框）', await ev(`${ROWS}.find((r)=>r.firstElementChild?.textContent==='时间')?.children[1]?.tagName === 'SPAN'`));
  check('5 描述是 textarea', await ev(`${ROWS}.find((r)=>r.firstElementChild?.textContent==='描述')?.querySelector('textarea')?.tagName === 'TEXTAREA'`));
  check('6 正文框载入了节点正文', String(await ev(`document.querySelector('#ed-doc .ProseMirror')?.textContent ?? ''`)).includes('灰烬'));

  /* ★ 提交后不重渲染面板：元素身份不变（这是「拖拽中的 scrub 不被销毁」的前提） */
  const sameEl = await ev(`(() => {
    const row = ${ROWS}.find((r)=>r.firstElementChild?.textContent==='标题');
    const inp = row?.querySelector('input');
    if (!inp) return null;
    window.__probeInput = inp;
    inp.value = '王国的建立（改）';
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    const still = document.querySelector('#ed-props .ed-props')?.contains(window.__probeInput);
    return { sameEl: still === true, status: document.querySelector('#ed-status')?.textContent ?? '' };
  })()`);
  check('★7 提交后面板没被重建（输入框元素身份不变）', !!sameEl && sameEl.sameEl === true, sameEl);
  check('8 状态栏给出「已保存 ✓」', !!sameEl && String(sameEl.status).includes('已保存'), sameEl && sameEl.status);

  const errs = await ev(`window.__errs`);
  check('9 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const n = results.filter(Boolean).length;
  console.log(`\n==== ${n}/${results.length} PASS ====`);
  process.exit(n === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack || e)); process.exit(2); });
