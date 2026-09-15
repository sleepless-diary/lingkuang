/* 不变量：**站在一个事件节点上，看得见它改动了哪些设定**（演变的反向视图），
 * 并且点一下就能跳到"这条设定在这个事件之后的样子"。
 *
 * 用户 2026-09-13 选了「你先去写新功能吧」之后定下的方向：帧条把演变竖着列成一条线
 * （站在设定上看它经历过什么），这里**倒过来** —— 站在事件上看它改变了谁。
 * 数据本来就在（`Entity.frames[].nodeId`），所以这一块不新增存储，只是"读 + 跳"。
 *
 * 盯六件事：
 *   ① 节点面板里有「这件事改变了谁」这块，列出的**只有真有帧的**设定（没帧的实体不许出现）；
 *   ② 每行写着 名字 / 类型 / 第几版 / 改动摘要；
 *   ③ 点一行 = 跳到那条设定，而且**直接站在这个事件那一版上**（不是"离指针最近的一版"）；
 *   ④ 帧条跟着停在那一格（`.is-on` + `data-rail`）；
 *   ⑤ 没有任何帧的事件给一句人话，而不是空白；
 *   ⑥ 全程没有未捕获异常。
 *
 * 用法：`node tools/e2e/seed-node-changed.cjs` → 起应用 →
 *       `LK_CDP_PORT=NNNN node tools/e2e/node-changed-by.cjs`
 *      （在 %TEMP%\lk-changed 那套目录上跑；数据是自足的，见 seed 脚本头部注释）。 */
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
  const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(250); } return false; };
  const clkText = (sel, text) => ev(`(() => { const el=[...document.querySelectorAll(${JSON.stringify(sel)})].find((x)=>(x.textContent||'').includes(${JSON.stringify(text)})); if(!el) return false; el.click(); return true; })()`);
  const FIELDEL = (k) => `[...document.querySelectorAll('#cx-fields > div')].find((r) => r.firstElementChild?.textContent === ${JSON.stringify(k)})?.querySelector('input,textarea,select')?.value`;
  /** 「这件事改变了谁」那块的整体读数 */
  const CHANGED = `(() => {
    const box = document.querySelector('#cx-changed');
    if (!box) return null;
    const rows = [...box.querySelectorAll('[data-cx-goto]')];
    return {
      head: (box.firstElementChild?.textContent || '').trim(),
      n: rows.length,
      ids: rows.map((r) => r.dataset.cxGoto),
      names: rows.map((r) => (r.children[0]?.textContent || '').trim()),
      types: rows.map((r) => (r.children[1]?.textContent || '').trim()),
      versions: rows.map((r) => (r.children[2]?.textContent || '').trim()),
      notes: rows.map((r) => (r.children[3]?.textContent || '').trim()),
      text: (box.textContent || '').replace(/\\s+/g, ' ').trim(),
    };
  })()`;

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej:' + String(e.reason))); true`);
  /* 自足：复位设置（手动模式 + 无锁定），别吃上一轮套件留下的 localStorage */
  await ev(`(() => { const k='lingkuang-settings'; let s={}; try { s = JSON.parse(localStorage.getItem(k)||'{}'); } catch {} s.evolveMode='manual'; s.evolveLock=null; localStorage.setItem(k, JSON.stringify(s)); return true; })()`);
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  const up = await waitFor(async () => !!(await ev(`!!document.querySelector('#cx-list .ed-tnode-item[data-act="node"]')`)));
  check('★0 工作台起来了（左树有节点行）', up);

  /* ── ① 站在「第一次魔潮」上：两条设定都在这件事上改过 ─────────────────── */
  const clicked = await clkText('#cx-list .ed-tnode-item[data-act="node"]', '第一次魔潮');
  await sleep(700);
  const c1 = await ev(CHANGED);
  check('★1 节点面板里有「这件事改变了谁」', clicked === true && !!c1 && c1.head.includes('这件事改变了谁'), { clicked, head: c1?.head });
  check('★2 列出两条设定（银发少女 / 霜纹剑）', !!c1 && c1.n === 2 && c1.names.includes('银发少女') && c1.names.includes('霜纹剑'), c1 && { n: c1.n, names: c1.names });
  /* 银发少女在这个事件上是**第 2 版**（n-evo-1 上还有一帧），霜纹剑是第 1 版 —— 版本号必须按各自的历史算 */
  const va = (c1?.versions ?? [])[c1 ? c1.names.indexOf('银发少女') : 0];
  const vb = (c1?.versions ?? [])[c1 ? c1.names.indexOf('霜纹剑') : 0];
  check('★3 版本号按各自的帧算（银发少女第 2 版 / 霜纹剑第 1 版）', String(va).includes('第 2 版') && String(vb).includes('第 1 版'), { 银发少女: va, 霜纹剑: vb });
  check('★4 每行有类型名与改动摘要（摘要里点出改了哪个字段）',
    (c1?.types ?? []).includes('角色') && (c1?.types ?? []).includes('物品')
    && (c1?.notes ?? []).every((x) => (x || '').length > 0)
    && String(c1?.notes?.[c1.names.indexOf('银发少女')] ?? '').includes('年龄'),
    c1 && { types: c1.types, notes: c1.notes });
  check('★5 没有帧的设定**不在**列表里（守夜人队长）', !!c1 && !c1.names.includes('守夜人队长') && !c1.text.includes('守夜人队长'), c1?.names);

  /* ── ② 点一行 = 跳到那条设定，且直接站在这个事件那一版上 ────────────── */
  await clkText('#cx-changed [data-cx-goto]', '银发少女');
  await sleep(800);
  const jump = await ev(`(() => {
    const name = document.querySelector('#cx-name')?.value ?? null;
    const vn = (document.querySelector('#cx-vnote')?.textContent || '').trim();
    const on = document.querySelector('.lk-rail__row.is-on');
    const rail = document.querySelector('#cx-rail');
    return {
      name, vn, age: ${FIELDEL('年龄')}, hair: ${FIELDEL('发色')},
      on: on ? on.dataset.rail ?? null : null,
      railOff: rail ? rail.classList.contains('is-off') : null,
      entOn: [...document.querySelectorAll('#cx-list .ed-tnode-item[data-act="entity"].is-on')].map((x) => (x.textContent || '').trim()).slice(0, 3),
    };
  })()`);
  check('★6 跳到那条设定（中栏名字 = 银发少女）', jump?.name === '银发少女', jump && { name: jump.name, on: jump.on });
  check('★7 中栏显示的是**这一版**的样子（年龄 21 / 发色 雪白，不是初稿的 17 / 银白）',
    jump?.age === '21' && jump?.hair === '雪白', jump && { age: jump.age, hair: jump.hair });
  check('★8 面板写着"正在看：第 2 版"', String(jump?.vn ?? '').includes('第 2 版'), jump?.vn);
  check('★9 帧条停在「第一次魔潮」那一格且是可见的',
    jump?.on === 'n-evo-2' && jump?.railOff === false, jump && { on: jump.on, railOff: jump.railOff });
  check('★9b 左树高亮跟着换到实体行（节点行不再高亮）',
    (jump?.entOn ?? []).some((t) => t.includes('银发少女')) && (await ev(`[...document.querySelectorAll('#cx-list .ed-tnode-item[data-act="node"].is-on')].length`)) === 0,
    jump?.entOn);

  /* ── ③ 没有帧的事件：给一句人话，不是空白 ──────────────────────────── */
  await clkText('#cx-list .ed-tnode-item[data-act="node"]', '霜冠加冕');
  await sleep(700);
  const c3 = await ev(CHANGED);
  check('★10 没有帧的事件：0 行 + 一句人话',
    !!c3 && c3.n === 0 && c3.text.includes('还没有改变任何设定') && c3.text.includes('记一帧'), c3 && { n: c3.n, text: c3.text.slice(0, 80) });

  /* ── ④ 只改过一次的事件：1 条设定、第 1 版 ─────────────────────────── */
  await clkText('#cx-list .ed-tnode-item[data-act="node"]', '王国的建立');
  await sleep(700);
  const c2 = await ev(CHANGED);
  check('★11 「王国的建立」只改了 1 条设定、且是第 1 版',
    !!c2 && c2.n === 1 && c2.names[0] === '银发少女' && String(c2.versions[0]).includes('第 1 版'), c2 && { n: c2.n, names: c2.names, versions: c2.versions });

  /* ── ⑤ 来回进出不叠内容（监听只挂一次 / 只重填内容） ───────────────── */
  await clkText('#cx-list .ed-tnode-item[data-act="node"]', '第一次魔潮');
  await sleep(600);
  await clkText('#cx-changed [data-cx-goto]', '霜纹剑');
  await sleep(700);
  const back = await ev(`(() => ({ name: document.querySelector('#cx-name')?.value ?? null, holder: ${FIELDEL('持有者')} }))()`);
  await clkText('#cx-list .ed-tnode-item[data-act="node"]', '第一次魔潮');
  await sleep(700);
  const c4 = await ev(CHANGED);
  check('★12 换到霜纹剑再回来：内容照旧 2 行（没有叠成 4 行）', c4?.n === 2 && !!back && back.name === '霜纹剑' && back.holder === '北境女王', { n: c4?.n, back });

  const errs = await ev(`window.__errs`);
  check('★13 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const ok = results.filter(Boolean).length;
  console.log(`\n==== ${ok}/${results.length} ====`);
  w.close();
  process.exit(ok === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常 ' + (e && e.stack ? e.stack : e)); process.exit(1); });
