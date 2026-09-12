/* 不变量：**演变帧冷启动后还在，并且物化出来的样子对**（文件是源）。
 *
 * 为什么单独一条：帧数据是新的持久化路径（实体 .md 的 `#演变：` 段），
 * 「写入成功」≠「下次启动读得回来」—— JSON 缓存、vault 扫描、mergeEntities 三道都可能把它吃掉。
 *
 * ⚠️ 断言**不写死期望值**，而是：从 .md 里读出「初稿 + 帧」，用一份**独立的**物化实现
 * （本文件里的 `materialize()`，十几行）算出应有的样子，再和界面比对。
 * 理由：上一个套件结尾会删掉一帧（★14），写死 "2 帧 / 能力=霜、冰晶" 就会随上游变化而挂 ——
 * 那是断言太脆，不是产品坏了（实测踩到：改完 ★14 后本条从 8/8 掉到 5/8）。
 *
 * 用法：跑完 entity-evolution.cjs → 重启实例 → node tools/e2e/cold-start-evolution.cjs
 */
const fs = require('fs');
const path = require('path');
const VAULT = process.env.LINGKUANG_VAULT;
const PORT = process.env.LK_CDP_PORT || '9334';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }
const MD_A = path.join(VAULT, '测试世界观', '_设定', '角色', '银发少女.md');
const md = () => { try { return fs.readFileSync(MD_A, 'utf8'); } catch { return ''; } };

/** 从 .md 读出「初稿 + 帧」，**独立地**物化一遍（不复用产品代码 —— 这样才是交叉验证） */
function materialize(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const fmLines = (m ? m[1] : '').split('\n');
  const fields = {};
  for (const l of fmLines) {
    const mm = l.match(/^(.+?):\s*(.*)$/);
    if (!mm) continue;
    const k = mm[1].replace(/^"|"$/g, '');
    let v = mm[2].trim().replace(/^"|"$/g, '');
    fields[k] = v;
  }
  const body = (m ? m[2] : text);
  const bi = body.indexOf('#正文：');
  let doc = bi === -1 ? '' : body.slice(bi + 4);
  const ev = doc.indexOf('#演变：');
  const framesText = ev === -1 ? '' : doc.slice(ev);
  doc = (ev === -1 ? doc : doc.slice(0, ev)).trim();
  const jm = framesText.match(/```json\s*\n([\s\S]*?)\n```/);
  let frames = [];
  if (jm) { try { frames = JSON.parse(jm[1]); } catch { frames = []; } }
  const states = [{ ...fields, doc }];
  for (const f of frames) {
    const prev = states[states.length - 1];
    const st = { ...prev, __doc: undefined };
    if (f.patch?.name) st.name = f.patch.name;
    if (f.patch?.set) for (const [k, v] of Object.entries(f.patch.set)) st[k] = v;
    if (f.patch?.del) for (const k of f.patch.del) delete st[k];
    let d = prev.doc;
    if (typeof f.patch?.doc?.full === 'string') d = f.patch.doc.full;
    else {
      const lines = d === '' ? [] : d.split('\n');
      for (const h of f.patch?.doc?.hunks ?? []) {
        const at = Math.max(0, Math.min(lines.length, h.at));
        lines.splice(at, Math.min(lines.length - at, h.del.length), ...h.ins);
      }
      d = lines.join('\n');
    }
    st.doc = d;
    delete st.__doc;
    states.push(st);
  }
  return { fields, doc, frames, states };
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
  const waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(120); } return false; };
  const forceFrames = async (n = 3) => { for (let i = 0; i < n; i++) await send('Page.captureScreenshot', { format: 'jpeg', quality: 10 }); };
  const FIELD = (k) => `[...document.querySelectorAll('#cx-fields > div')].find((r) => r.firstElementChild?.textContent === ${JSON.stringify(k)})?.querySelector('input,textarea,select')?.value`;

  const base = materialize(md());   /* 文件里的真相 */
  const last = base.states[base.states.length - 1];
  const lastFrame = base.frames[base.frames.length - 1];

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  await waitFor(() => ev(`!!document.querySelector('#cx-rail .lk-rail__row')`), 8000);
  await forceFrames(3);
  await ev(`(() => { const b = [...document.querySelectorAll('[data-cx-id]')].find((x) => x.children[0]?.textContent === '银发少女'); b.click(); return true; })()`);
  await sleep(700); await forceFrames(2);

  check('★0 前置：.md 里有帧（上一轮跑出来的）', base.frames.length >= 1, { frames: base.frames.length, nodes: base.frames.map((f) => f.nodeId) });

  const rail = await ev(`(() => {
    const rows = [...document.querySelectorAll('#cx-rail .lk-rail__row')].map((r) => ({
      id: r.dataset.rail || '', on: r.classList.contains('is-on'), frame: r.classList.contains('is-frame'),
      n: (r.querySelector('.lk-rail__n') || {}).textContent || '', s: (r.querySelector('.lk-rail__s') || {}).textContent || '' }));
    return { rows, lit: rows.filter((r) => r.frame).length };
  })()`);
  check('★1 冷启动后右栏还原出帧（亮格数 = 文件里的帧数）', rail.lit === base.frames.length,
    { lit: rail.lit, frames: base.frames.length, rows: rail.rows.map((r) => r.n + '|' + r.s) });
  check('★2 帧条上显示的是**差异摘要**（不是空）', rail.rows.filter((r) => r.frame).every((r) => r.s && r.s !== '（还没有版本）'),
    rail.rows.filter((r) => r.frame).map((r) => r.s));

  /* 默认落点：指针在所有节点之后 ⇒ 应落在**最后一帧**那一格 */
  const onRow = rail.rows.find((r) => r.on);
  const note = await ev(`[...document.querySelectorAll('#cx-body > div')].map((d) => d.textContent || '').find((t) => t.startsWith('正在看')) || ''`);
  check('★3 冷启动后默认落在"离指针最近的那一帧"（最后那一帧）',
    onRow?.id === lastFrame.nodeId && note.includes(`第 ${base.frames.length} 版`),
    { onId: onRow?.id, expect: lastFrame.nodeId, note });

  /* 物化对不对：拿**独立算出来**的末版比界面 */
  const keys = ['发色', '年龄', '能力', '瞳色'].filter((k) => last[k] !== undefined);
  const atLast = {};
  for (const k of keys) atLast[k] = await ev(FIELD(k));
  const expectLast = Object.fromEntries(keys.map((k) => [k, last[k]]));
  check('★4 物化正确：界面上的末版 = 初稿 + 全部帧（与独立算法逐字段一致）',
    JSON.stringify(atLast) === JSON.stringify(expectLast), { 界面: atLast, 独立算: expectLast });

  const docLast = await ev(`document.querySelector('#cx-doc .ProseMirror').textContent || ''`);
  const flat = (s) => String(s).replace(/\s+/g, '');
  check('★5 正文的物化也按版本取（与独立算法算出的末版正文一致）',
    flat(docLast) === flat(last.doc), { 界面前24字: docLast.slice(0, 24), 独立算前24字: last.doc.slice(0, 24) });

  /* 切到初稿：只剩初稿的值 */
  await ev(`document.querySelectorAll('#cx-rail .lk-rail__row')[0].click(); true`);
  await sleep(600); await forceFrames(2);
  const atBase = {};
  for (const k of keys) atBase[k] = await ev(FIELD(k));
  const expectBase = Object.fromEntries(keys.map((k) => [k, base.fields[k]]));
  check('★6 切到初稿：字段回到 frontmatter 里的初稿值（帧的改动不复现）',
    JSON.stringify(atBase) === JSON.stringify(expectBase), { 界面: atBase, 文件初稿: expectBase });
  const docBase = await ev(`document.querySelector('#cx-doc .ProseMirror').textContent || ''`);
  check('★6b 初稿的正文也与独立算法一致（帧里的正文改动不复现）', flat(docBase) === flat(base.doc),
    { 界面前24字: docBase.slice(0, 24), 独立算前24字: base.doc.slice(0, 24) });

  const errs = await ev(`window.__errs || []`);
  check('★7 冷启动全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} PASS`);
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.message)); process.exit(1); });
