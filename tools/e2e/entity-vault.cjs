/* 验证「实体（设定库）也写 vault .md」这一刀的端到端行为。
   关键点：回扫是 **文件为源、只进内存不回写 JSON**（src/main.ts 的 suppressWrite），
   所以「外部改 .md 有没有生效」必须读 **活 UI**（DOM），不能读 worldbuilding.json。
   用例：① 落盘 ② `_设定` 不算时间线 ③ 外部改字段/正文回扫 ④ 换类型不残留旧文件、回扫后不被打回
        ⑤ 删除进回收站且不复活 ⑥ 回收站恢复能回到 store 与文件原位 ⑦ 全程无未捕获异常 */
const fs = require('fs');
const path = require('path');
const DATA = process.env.LINGKUANG_TEST_DATA;
const VAULT = process.env.LINGKUANG_VAULT;
const PORT = process.env.LK_CDP_PORT || '9334';
const WS = '测试世界观';
const ENT = (type, name) => path.join(VAULT, WS, '_设定', type, name + '.md');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }
const readEnt = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
/** 读 JSON 缓存。**只用于「不该出现的键」这类断言** —— 回扫按设计只进内存不回写 JSON，
 *  「外部改动有没有生效」必须看活 UI，不能看这里。 */
const wsJson = () => { try { return JSON.parse(fs.readFileSync(DATA, 'utf8')).worldsets[WS] ?? {}; } catch { return {}; } };
const tls = () => wsJson().timelines ?? {};
/** 递归列文件（相对某根） */
function walk(dir, rel = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, rel + e.name + '/'));
    else out.push(rel + e.name);
  }
  return out;
}

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
  async function waitFor(fn, ms = 9000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(200); } return false; }

  /* 页面内表达式片段（注意：这些是**字符串**，用 ${} 插进表达式里求值；
     不要把它写成函数再在页面里调用 —— 那样得到的是函数源码字符串） */
  const SEL = (n) => `[...document.querySelectorAll('#cx-fields > div')].find((r) => r.firstElementChild?.textContent === ${JSON.stringify(n)})?.querySelector('input,textarea')`;
  const LIST = `[...document.querySelectorAll('[data-cx-id]')].map((b) => ({ id: b.dataset.cxId, name: b.children[0]?.textContent, type: b.children[1]?.textContent }))`;
  const DOC = `document.querySelector('#cx-doc .ProseMirror')?.textContent ?? null`;
  const clickTool = (t) => `document.querySelector('[data-tool=${JSON.stringify(t)}]').click(); true`;
  const confirmDanger = `(() => { const rows=[...document.body.children].filter((el)=>/position:\\s*fixed/.test(el.getAttribute?.('style')||'')); const d=rows[rows.length-1]; const bs=[...d.querySelectorAll('button')]; bs[bs.length-1].click(); return true; })()`;
  const setVal = (sel, v) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`;

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);

  /* ── ① 建实体 + 填字段 + 写正文 → 落盘 ─────────────────────────── */
  await ev(clickTool('codex'));
  await sleep(900);
  await ev(setVal('#cx-new-type', '角色'));
  await ev(`document.querySelector('#cx-new').click(); true`);
  await waitFor(async () => (await ev(LIST)).length === 1);
  await ev(setVal('#cx-name', '银发少女'));
  await sleep(600);
  await ev(`(() => { const el = ${SEL('发色')}; el.value = '银白'; el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
  await sleep(600);
  await ev(`document.querySelector('#cx-doc .ProseMirror').focus(); true`);
  await send('Input.insertText', { text: '旧都陷落后的第三年，她第一次出现在石桥上。' });
  await sleep(400);
  await ev(`document.querySelector('#cx-name').focus(); true`);   /* 失焦 → flush 正文 */

  const ok1 = await waitFor(() => fs.existsSync(ENT('角色', '银发少女')) && /#正文：/.test(readEnt(ENT('角色', '银发少女'))));
  const t1 = readEnt(ENT('角色', '银发少女'));
  check('1 实体写成了 vault 文件 `_设定/角色/银发少女.md`', ok1, ok1 ? t1.split('\n').slice(0, 6) : walk(path.join(VAULT, WS)));
  check('2 frontmatter 有 id/name/type 与字段', /^id: e\w+$/m.test(t1) && /^name: 银发少女$/m.test(t1) && /^type: 角色$/m.test(t1) && /^发色: 银白$/m.test(t1), t1.split('\n').slice(0, 8));
  check('3 正文写在 `#正文：` 标签之后', /#正文：/.test(t1) && t1.includes('石桥上'), t1.slice(-50));
  check('4 `_设定` 没被当成一条时间线', !Object.keys(tls()).some((k) => k.includes('_设定')) && (await ev(LIST)).length === 1, { timelines: Object.keys(tls()), list: await ev(LIST) });

  /* ── ② 外部改 .md → 回扫（读活 UI，不读 JSON）───────────────────── */
  await sleep(3000);   /* 等应用的待写盘排空，否则它的写盘会盖掉外部改动 */
  const before = readEnt(ENT('角色', '银发少女'));
  fs.writeFileSync(ENT('角色', '银发少女'), before.replace('发色: 银白', '发色: 墨黑').replace('她第一次出现在石桥上', '她在雪里站了很久'), 'utf8');
  const ok5 = await waitFor(async () => (await ev(`(${SEL('发色')})?.value`)) === '墨黑');
  check('★5 外部改 .md 字段回扫进活 UI（发色→墨黑）', ok5, await ev(`(${SEL('发色')})?.value`));
  const ok6 = await waitFor(async () => String(await ev(DOC) ?? '').includes('雪里'));
  check('★6 外部改正文也回扫（正文含「雪里」）', ok6, String(await ev(DOC) ?? '').slice(0, 40));

  /* ── ③ 换类型：旧目录不留残file，回扫后不被打回 ──────────────────── */
  await ev(setVal('#cx-type', '地点'));
  await sleep(1200);
  let ok7 = await waitFor(() => fs.existsSync(ENT('地点', '银发少女')) && !fs.existsSync(ENT('角色', '银发少女')));
  check('★7 换类型后文件搬到 `_设定/地点/`，旧目录不残留', ok7,
    { 地点: walk(path.join(VAULT, WS, '_设定', '地点')), 角色: walk(path.join(VAULT, WS, '_设定', '角色')) });
  /* 触发一轮重扫（外部 touch 实体自己的 .md）→ 看类型会不会被残留旧文件打回 */
  const cur = readEnt(ENT('地点', '银发少女'));
  fs.writeFileSync(ENT('地点', '银发少女'), cur, 'utf8');
  await sleep(4000);
  const stillOk = fs.existsSync(ENT('地点', '银发少女')) && !fs.existsSync(ENT('角色', '银发少女'));
  const listAfter = await ev(LIST);
  check('★8 回扫后类型仍是「地点」（残留旧文件没把它打回「角色」）', stillOk && listAfter[0]?.type === '地点',
    { files: stillOk, list: listAfter });

  /* ── ④ 删除 → 进回收站、不复活 ──────────────────────────────── */
  await ev(`document.querySelector('#cx-del').click(); true`);
  await sleep(600);
  await ev(confirmDanger);
  await waitFor(async () => (await ev(LIST)).length === 0);
  check('9 删除后 store 里没有实体了', (await ev(LIST)).length === 0, await ev(LIST));
  const trashFiles = walk(path.join(VAULT, '.trash'));
  check('★10 文件被移进回收站（不是直接删掉）', trashFiles.some((p) => p.includes('银发少女')), trashFiles);
  check('11 原位置文件已不在', !fs.existsSync(ENT('地点', '银发少女')));
  await sleep(2500);   /* 等一轮重扫 */
  check('★12 重扫后实体没有复活', (await ev(LIST)).length === 0, await ev(LIST));

  /* ── ⑤ 回收站恢复 → 文件回原位 + store 里回来 ───────────────────── */
  await ev(clickTool('trash'));
  await sleep(1200);
  const kindLabels = await ev(`[...document.querySelectorAll('button')].filter((b)=>b.textContent==='恢复').map((b)=>b.parentElement?.textContent)`);
  check('13 回收站里实体项显示中文「实体」（不是 raw ' +
    "'entity'" + '）', Array.isArray(kindLabels) && kindLabels.some((s) => String(s).includes('实体') && String(s).includes('银发少女')), kindLabels);
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find((x)=>x.textContent==='恢复' && (x.parentElement?.textContent||'').includes('银发少女')); if(!b) return false; b.click(); return true; })()`);
  const okRestore = await waitFor(() => fs.existsSync(ENT('地点', '银发少女')), 9000);
  check('★14 恢复后文件回到原位 `_设定/地点/银发少女.md`', okRestore, walk(path.join(VAULT, WS, '_设定')));
  await ev(clickTool('codex'));
  await sleep(1000);
  const restored = await waitFor(async () => (await ev(LIST)).length === 1 && (await ev(LIST))[0].type === '地点', 9000);
  check('★15 恢复后实体回到 store 且类型是「地点」', !!restored, await ev(LIST));
  const docBack = await ev(DOC);
  check('16 恢复后正文还在', String(docBack ?? '').includes('雪里'), String(docBack ?? '').slice(0, 40));

  const errs = await ev(`window.__errs`);
  check('17 全程无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const ok = results.filter(Boolean).length;
  console.log(`\n==== ${ok}/${results.length} PASS ====`);
  process.exit(ok === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack || e)); process.exit(2); });
