/* 不变量：**换条目不能把上一条的正文写进下一条**（正文归属按 .md 文件断言，文件为源）。
 *
 * 背景：`src/ui/codex.ts` 旧写法是「先把 activeId 改成新条目，再 render()」，而 render() 开头
 * 才去 `docEditor.flush()`；flush 回调走 `patchEntity`（用**当时**的 activeId）。
 * 真实鼠标点击会先 blur（blur 早于 click）→ flush 时 activeId 还没变 → **常规路径侥幸没事**；
 * 但只要出现「正文还是脏的、目标已经变了」的路径（程序化切换、外部回扫把 activeId 重置成
 * list[0]、快速建立新条目…）就会把上一条的正文写进下一条。
 * 修法：换目标一律走 switchTarget()（先 flush 再改选择），且正文写回**创建时捕获的目标**。
 * 本脚本走的就是「不失焦就切」这条危险路径（`.click()` 是程序化点击，不会触发 blur）。
 *
 * 用法：先跑 reset-entity-vault.cjs，起应用，再跑本脚本。 */
const fs = require('fs');
const path = require('path');
const VAULT = process.env.LINGKUANG_VAULT;
const PORT = process.env.LK_CDP_PORT || '9334';
const ENT = (name) => path.join(VAULT, '测试世界观', '_设定', '角色', name + '.md');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }
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
  const DOC = `document.querySelector('#cx-doc .ProseMirror')?.textContent ?? null`;
  /** 程序化点击：**不会**触发 blur —— 这正是要测的危险路径 */
  const clickRow = (name) => ev(`(() => { const b=[...document.querySelectorAll('[data-cx-id]')].find((x)=>x.children[0]?.textContent===${JSON.stringify(name)}); if(!b) return false; b.click(); return true; })()`);
  const rename = (name) => ev(`(() => { const i=document.querySelector('#cx-name'); i.value=${JSON.stringify(name)}; i.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
  /** 打字但**不失焦** —— 让正文保持「脏」。带重试：条目切换/落盘回扫都会重建编辑器，
   *  重建恰好落在「聚焦之后、打字之前」时输入会落空；这里先确认字**真的进了编辑器**，
   *  后面才谈得上「切走时有没有存住」。 */
  const typeNoBlur = async (text) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      for (let i = 0; i < 20; i++) { if (await ev(`!!document.querySelector('#cx-doc .ProseMirror')`)) break; await sleep(200); }
      const focused = await ev(`(() => { const el=document.querySelector('#cx-doc .ProseMirror'); if(!el) return false; el.focus(); return el.contains(document.activeElement); })()`);
      if (focused) await send('Input.insertText', { text });
      for (let i = 0; i < 10; i++) {
        if (String(await ev(DOC) ?? '').includes(text)) return;
        await sleep(150);
      }
    }
    throw new Error('正文输入没进编辑器（重试 8 次仍为空）');
  };
  const newEntity = async (name) => {
    await ev(`(() => { const s=document.querySelector('#cx-new-type'); if(s) s.value='角色'; document.querySelector('#cx-new').click(); return true; })()`);
    for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('#cx-name')`)) break; await sleep(200); }
    await rename(name);
    await sleep(500);
  };
  const waitFile = async (name, needle) => {
    for (let i = 0; i < 60; i++) { if (read(ENT(name)).includes(needle)) return true; await sleep(250); }
    return false;
  };

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  await sleep(900);

  /* ① 甲：写正文，**不失焦**（正文处于脏状态） */
  await newEntity('甲');
  await typeNoBlur('甲甲的正文。');
  check('1 甲：正文已输入（未失焦）', String(await ev(DOC) ?? '').includes('甲甲'), await ev(DOC));

  /* ② 脏着就去建乙 —— 旧实现在这一步把甲的正文写进乙 */
  await newEntity('乙');
  const okA = await waitFile('甲', '甲甲的正文');
  check('★2 「甲的正文」落在甲的 .md 里', okA, { 甲: read(ENT('甲')).split('\n').slice(-2).join(''), 乙: read(ENT('乙')).split('\n').slice(-2).join('') });
  check('★3 新建的「乙」没有被塞进甲的正文', !read(ENT('乙')).includes('甲甲'), read(ENT('乙')).slice(-60));

  /* ③ 乙写正文（不失焦）→ 程序化切回甲 */
  await typeNoBlur('乙乙的正文。');
  await clickRow('甲');
  await sleep(600);
  const okB = await waitFile('乙', '乙乙的正文');
  check('★4 「乙的正文」落在乙的 .md 里', okB, read(ENT('乙')).slice(-60));
  check('★5 切回甲后，甲的 .md 里没有被写进乙的正文', !read(ENT('甲')).includes('乙乙'), read(ENT('甲')).slice(-60));
  const docA = await ev(DOC);
  check('6 切回甲后正文框显示的是甲自己的正文', String(docA ?? '').includes('甲甲') && !String(docA ?? '').includes('乙乙'), docA);

  const errs = await ev(`window.__errs`);
  check('7 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const n = results.filter(Boolean).length;
  console.log(`\n==== ${n}/${results.length} PASS ====`);
  process.exit(n === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack || e)); process.exit(2); });
