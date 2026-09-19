/* 不变量：**进入灵框（renderer 重启）时默认回到上次关闭时的状态**。
 *
 * 用户 2026-09-19：「我希望进入灵框时默认是上次关闭时的状态」。范围（用户选定）：
 *   ① 上次的世界 + 时间线；② 上次打开的工具；③ 设定库正在编的那一条（实体 / 时间线节点）。
 * 不记：沙盘缩放平移/全览聚焦/非线性/剧情线、面板开合、窗口大小位置。
 *
 * 实现见 `src/ui/session.ts`（存 localStorage `lingkuang-session`；**不写进 worldbuilding.json**）：
 *   · 写：`src/ui/shell.ts` 的工具栏点击处理记工具（面板型不记）；`watchSession(store)` 记世界/时间线；
 *     `src/ui/codex.ts` 的 `switchTarget()` 记「正在编哪一条」。
 *   · 读：`src/main.ts` 在 `renderShell()` **之后**、`watchSession()` **之前**调 `restoreSession(store)`
 *     （先恢复后开记，否则启动默认值会先把存档盖掉）；工作台的选择在 `renderCodex()` 挂载时落位。
 *
 * 「重新进入灵框」在本套件里用 `location.reload()` 模拟：它会把整个 `main()` 重跑一遍
 * （重新 loadData/vault 扫描 → createStore → renderShell → 恢复），跟重开应用同一条路，
 * 而且不用起第二个 Electron（冷启动版的真·重启见 tools/e2e/README.md 的两段式套件惯例）。
 *
 * 用法：干净实例（reset-entity-vault + seed-node，端口 9352）：
 *   LK_CDP_PORT=9352 node tools/e2e/session-restore.cjs
 */
const PORT = process.env.LK_CDP_PORT || '9352';
const WS = '测试世界观';
const TL = 'tl-主线';
const ENTITY = 'e-e2e-1';      /* seed-node：银发少女 */
const NODE = 'n-e2e-1';        /* seed-node：王国的建立（year 312，y 正文「王国在灰烬上建立起来。」） */
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
  /** reload 期间执行上下文会被换掉，读一次可能抛 —— 统一吞掉重试 */
  const evSoft = async (expr) => { for (let i = 0; i < 20; i++) { try { return await ev(expr); } catch { await sleep(250); } } return undefined; };

  /** 存档（写盘有 400ms 防抖，读之前先等一会儿） */
  const session = () => ev(`JSON.parse(localStorage.getItem('lingkuang-session') || 'null')`);
  const sessionWhen = async (pred, ms = 4000) => {
    for (let i = 0; i < ms / 200; i++) { const s = await evSoft(`JSON.parse(localStorage.getItem('lingkuang-session') || 'null')`); if (s && pred(s)) return s; await sleep(200); }
    return await session();
  };
  /** 视图现状：哪个工具、模块视图/沙盘谁在台前、工作台在编哪一条 */
  const view = () => ev(`(() => {
    const mv = document.getElementById('lk-module-view');
    const right = document.querySelector('.lk-right');
    return {
      active: document.querySelector('.lk-tool-btn.is-active')?.dataset.tool ?? null,
      moduleShown: !!mv && mv.style.display !== 'none',
      sandboxShown: !!right && right.style.display !== 'none',
      codex: !!document.querySelector('#cx-root'),
      inspire: !!document.querySelector('#insp-scroll'),
      name: document.querySelector('#cx-name')?.value ?? null,
      nodePath: document.querySelector('#cx-nodepath')?.textContent ?? null,
      /* ⚠️ 节点行没有 data-cx-id（那是实体行的历史约定，十几条老套件按它找实体行）——
         节点行按 data-act="node" 找，选中高亮是行上的 .is-on。
         ⚠️ 这段在 JS 模板串里，注释不许出现反引号。 */
      onRows: [...document.querySelectorAll('#cx-list .is-on')].map((x) => (x.textContent ?? '').trim().slice(0, 24)),
      entityOn: !!document.querySelector('#cx-list [data-cx-id="${ENTITY}"]')?.classList.contains('is-on'),
      bodyTxt: (document.querySelector('#cx-body')?.textContent ?? '').slice(0, 200),
      /* 节点态：中栏那块公共属性面板的**标题**是个 input（value 不进 textContent，别拿文本断言），
         正文是 tiptap 那棵树 */
      propTitle: document.querySelector('#cx-props input')?.value ?? null,
      docTxt: (document.querySelector('#cx-doc')?.textContent ?? ''),
      activeTab: document.querySelector('.lk-tl-tabs > .lk-tl-tab.is-active')?.querySelector('.nm')?.textContent ?? null,
    };
  })()`);

  const errs = [];
  const installErrs = () => evSoft(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  const collectErrs = async () => { const e = await evSoft(`window.__errs`); if (Array.isArray(e)) errs.push(...e); };

  /** 重新进入灵框：整份 main() 重跑（= 重开应用那条路） */
  const reenter = async (expectTool) => {
    await collectErrs();
    await evSoft(`location.reload(); true`);
    await sleep(1500);
    for (let i = 0; i < 60; i++) {                       /* 等壳 + 工具（工具是动态 import，晚一拍） */
      const v = await evSoft(`(() => ({
        bar: !!document.querySelector('#lk-toolbar .lk-tool-btn'),
        ready: ${expectTool === 'codex' ? `!!document.querySelector('#cx-root')` : expectTool === 'inspire' ? `!!document.querySelector('#insp-scroll')` : 'true'},
      }))()`);
      if (v && v.bar && v.ready) break;
      await sleep(300);
    }
    await sleep(400);
    await installErrs();
  };

  await sleep(1500);
  await installErrs();

  /* ── ① 启动默认：世界沙盘（没有存档时不许"莫名其妙"停在别的工具上） ── */
  const v0 = await view();
  check('★0 没有存档时启动 = 世界沙盘（模块视图关着、右区在台前、没有工具高亮）',
    v0.sandboxShown === true && v0.moduleShown === false && v0.codex === false, v0);

  /* ── ② 打开设定库、点一条实体：这三样都要写进存档 ── */
  await ev(`document.querySelector('.lk-tool-btn[data-tool="codex"]').click(); true`);
  await sleep(900);
  await ev(`document.querySelector('#cx-list [data-cx-id="${ENTITY}"]')?.click(); true`);
  await sleep(400);
  const v1 = await view();
  check('★1 打开设定库并点中实体「银发少女」（中栏名字 + 该行高亮）',
    v1.codex === true && v1.name === '银发少女' && v1.entityOn === true, { name: v1.name, entityOn: v1.entityOn });

  const s1 = await sessionWhen((s) => s.target && s.target.id === ENTITY);
  check('★2 存档记下了 工具 + 世界 + 时间线 + 正在编的实体',
    s1 && s1.v === 1 && s1.tool === 'codex' && s1.world === WS && s1.timeline === TL
    && s1.target && s1.target.kind === 'entity' && s1.target.id === ENTITY, s1);

  /* ── ③ 重新进入灵框：工具与正在编的那一条都要回来 ── */
  await reenter('codex');
  const v2 = await view();
  check('★3 重进后自己回到设定库，且还停在「银发少女」上（工具 + 正在编的那一条）',
    v2.active === 'codex' && v2.moduleShown === true && v2.sandboxShown === false
    && v2.codex === true && v2.name === '银发少女' && v2.entityOn === true,
    { active: v2.active, moduleShown: v2.moduleShown, name: v2.name, entityOn: v2.entityOn });

  /* ── ④ 换到时间线节点（跨类别）：存档要跟着换成节点身份（带 tlId） ── */
  const clickedNode = await ev(`(() => {
    /* ⚠️ 节点行按 data-act="node" 找（data-cx-id 只挂在实体行上）。注释里不许有反引号。 */
    const r = [...document.querySelectorAll('#cx-list [data-act="node"]')].find((x) => (x.textContent ?? '').includes('王国的建立'));
    if (!r) return false;
    r.click();
    return true;
  })()`);
  await sleep(400);
  const s2 = await sessionWhen((s) => s.target && s.target.kind === 'node');
  check('★4 换到时间线节点后，存档里是**节点**身份（kind/tlId/nodeId 三样齐全）',
    clickedNode === true && s2 && s2.target && s2.target.kind === 'node' && s2.target.tlId === TL && s2.target.nodeId === NODE,
    { clicked: clickedNode, saved: s2 });

  await reenter('codex');
  const v3 = await view();
  check('★5 重进后仍停在那个**时间线节点**上（面包屑走到主线那一枝 + 该节点行高亮 + 中栏标题是它 + 正文是它的）',
    v3.codex === true && v3.entityOn === false
    && Array.isArray(v3.onRows) && v3.onRows.some((t) => t.includes('王国的建立'))
    && String(v3.nodePath ?? '').includes('主线') && v3.propTitle === '王国的建立'
    && String(v3.docTxt ?? '').includes('王国在灰烬上建立起来'),
    { onRows: v3.onRows, entityOn: v3.entityOn, nodePath: v3.nodePath, propTitle: v3.propTitle, docTxt: String(v3.docTxt ?? '').slice(0, 40) });

  /* ── ⑤ 换工具（灵感触发器）：工具也要记 ── */
  await ev(`document.querySelector('.lk-tool-btn[data-tool="inspire"]').click(); true`);
  await sleep(900);
  const s3 = await sessionWhen((s) => s.tool === 'inspire');
  await reenter('inspire');
  const v4 = await view();
  check('★6 上次打开的是灵感触发器 ⇒ 重进后还是灵感触发器（不再是沙盘）',
    s3 && s3.tool === 'inspire' && v4.active === 'inspire' && v4.inspire === true && v4.moduleShown === true,
    { saved: s3?.tool, active: v4.active, inspire: v4.inspire });

  /* ── ⑥ 回到沙盘：存档要记成 sandbox（否则下次会把上一个工具又拉回来） ── */
  await ev(`document.querySelector('.lk-tool-btn[data-tool="sandbox"]').click(); true`);
  await sleep(600);
  const s4 = await sessionWhen((s) => s.tool === 'sandbox');
  await reenter('sandbox');
  const v5 = await view();
  check('★7 上次回到的是世界沙盘 ⇒ 重进后仍是沙盘（右区在台前、模块视图关着）',
    /* 沙盘是启动默认视图，恢复时**不需要点**它（点了也只是白跑一趟）⇒ 按钮不高亮、active 为 null 也算对 */
    s4 && s4.tool === 'sandbox' && (v5.active === 'sandbox' || v5.active === null)
    && v5.sandboxShown === true && v5.moduleShown === false,
    { saved: s4?.tool, active: v5.active, sandboxShown: v5.sandboxShown });

  /* ── ⑦ 时间线：新建一条并切过去，重进后仍是**它**（启动默认永远是 order 里第一条，
        所以这条只在"存档真的被用上"时才会过） ── */
  await ev(`document.getElementById('lk-tl-new').click(); true`);
  await sleep(800);
  /* ⚠️ 「＋新建时间线」只**建**、不切过去（`addTimeline()` 不动选择游标）—— 得像真人那样再点一下它 */
  const switchedTl = await ev(`(() => {
    const b = [...document.querySelectorAll('.lk-tl-tabs > .lk-tl-tab[data-tl]')]
      .find((x) => (x.querySelector('.nm')?.textContent ?? '') === '新时间线');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(400);
  const s5 = await sessionWhen((s) => !!s.timeline && s.timeline !== TL);
  await reenter('sandbox');
  const v6 = await view();
  check('★8 上次选的是新建的那条时间线 ⇒ 重进后选中态仍是它（不是 order 第一条「主线」）',
    switchedTl === true && s5 && s5.timeline !== TL && v6.activeTab === '新时间线',
    { saved: s5?.timeline, activeTab: v6.activeTab });

  /* ── ⑧ 存档坏掉 / 认不出来：当没有处理，回到默认且不炸（手改坏了不该让应用打不开） ── */
  await ev(`localStorage.setItem('lingkuang-session', '{ 这不是 JSON'); true`);
  await reenter('sandbox');
  const v7 = await view();
  check('★9 存档坏掉时安静地回到默认（沙盘 + 模块视图关着，不抛异常）',
    v7.sandboxShown === true && v7.moduleShown === false, { sandboxShown: v7.sandboxShown, moduleShown: v7.moduleShown });

  await collectErrs();
  check('★10 全程没有未捕获异常（含 5 次重新进入灵框）', errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n==== ${pass}/${results.length} PASS ====`);
  w.close();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
