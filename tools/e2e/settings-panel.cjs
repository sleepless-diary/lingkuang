/* 不变量：**设置是悬浮面板，不是单开一个标签页**（用户 2026-09-13：「我希望设置面板是悬浮面板，
 * 而不是单开一个标签页」）。
 *
 * 以前「设置」注册成普通工具：点它＝工具宿主 `#lk-module-view` 把主区整个换掉（世界沙盘/设定库都被顶走），
 * 改完还得再切回来。现在它是**面板型工具**（`Tool.panel = true`，见 `src/tools/registry.ts` 的
 * `openTool` 里那一支 + `src/ui/settings-panel.ts`），要点是：
 *   ① 面板挂在 `document.body` 上、`position: fixed`，**主区一动不动**（正在编的条目、左树展开态、
 *      `#cx-root` 的滚动位置全留着）；
 *   ② 关法三种：右上角 ×、Esc、点遮罩空白；关掉时广播 `lingkuang-panel`，左栏按钮的高亮跟着灭；
 *   ③ 再点一次按钮 = 关（按钮是开关，不是"切过去"）。
 *
 * 用法：`node tools/e2e/reset-entity-vault.cjs` + `node tools/e2e/seed-node.cjs` → 起应用 →
 * `LK_CDP_PORT=NNNN node tools/e2e/settings-panel.cjs`
 */
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
  const openBtn = `[...document.querySelectorAll('#lk-toolbar .lk-tool-btn')].find((b) => b.dataset.tool === 'settings')`;

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  await sleep(1200);

  /* ── 前置：主区里有一个"正在编的东西"，后面要证明它一动不动 ── */
  const pre = await ev(`(() => {
    window.__cx = document.querySelector('#cx-root');
    window.__mvHtml = document.getElementById('lk-module-view').innerHTML.length;
    return {
      cx: !!window.__cx,
      mvHtml: window.__mvHtml,
      btn: !!${openBtn},
      isBottom: [...document.querySelectorAll('#lk-toolbar .lk-tool-btn')].pop()?.dataset.tool === 'settings',
      panel: !!document.getElementById('lk-settings-panel'),
    };
  })()`);
  check('★0 前置：设定库开着、设置按钮在左栏最底下、此刻没有面板',
    pre.cx === true && pre.btn === true && pre.isBottom === true && pre.panel === false, pre);

  /* ── ① 点设置：开出一层悬浮面板，主区一动不动 ── */
  const opened = await ev(`(() => {
    const b = ${openBtn};
    b.click();
    const p = document.getElementById('lk-settings-panel');
    const card = p?.querySelector('.lk-set-card');
    const scrim = p;
    const anims = (el) => (el ? el.getAnimations().map((a) => ({ name: a.animationName, dur: a.effect.getTiming().duration })) : []);
    return {
      exists: !!p,
      pos: p ? getComputedStyle(p).position : null,
      inBody: p ? p.parentElement === document.body : false,
      card: anims(card), scrim: anims(scrim),
      sameRoot: document.querySelector('#cx-root') === window.__cx,
      mvLen: document.getElementById('lk-module-view').innerHTML.length,
      mvShown: document.getElementById('lk-module-view').style.display !== 'none',
      active: b.classList.contains('is-active'),
      title: card?.querySelector('div')?.textContent ?? null,
    };
  })()`);
  await sleep(600);
  check('★1 点设置开出一层**悬浮**面板（fixed、挂在 body 上、卡片有入场动画）',
    opened.exists === true && opened.pos === 'fixed' && opened.inBody === true
      && opened.card.some((a) => a.name === 'lk-pop' && a.dur === 320)
      && opened.scrim.some((a) => a.name === 'lk-fade' && a.dur === 180), opened);
  check('★2 主区**一动不动**：`#cx-root` 是同一个元素、主区 HTML 没被换、模块视图仍显示、按钮亮着',
    opened.sameRoot === true && opened.mvLen === pre.mvHtml && opened.mvShown === true && opened.active === true,
    { sameRoot: opened.sameRoot, mvLen: opened.mvLen, 之前: pre.mvHtml, active: opened.active });
  check('★3 面板头是「设置」，内容里旧卡片还在（联想引擎 / 画布偏好 / 设定演变）',
    String(opened.title ?? '').startsWith('设置')
      && (await ev(`(() => { const t = document.getElementById('lk-settings-panel').textContent;
        return ['联想引擎', '画布偏好', '设定演变（版本历史）', '换条目转场'].every((k) => t.includes(k)); })()`)) === true,
    { title: opened.title });

  /* ── ② 旋钮真的写进设置（换条目转场那四个） ── */
  const knob = await ev(`(() => {
    const has = ['#set-motion-on', '#set-motion-speed', '#set-motion-stagger', '#set-motion-dx'].every((s) => !!document.querySelector(s));
    const r = document.querySelector('#set-motion-stagger');
    if (!r) return { has, saved: null, label: null };   /* 旧实现里没有这张卡片 ⇒ 判 FAIL，别让脚本崩 */
    r.value = '25';
    r.dispatchEvent(new Event('input', { bubbles: true }));
    const s = JSON.parse(localStorage.getItem('lingkuang-settings') || '{}');
    const v = document.querySelector('#set-motion-stagger-v')?.textContent;
    return { has, saved: s.motionStagger, label: v };
  })()`);
  check('★4 面板里的转场旋钮齐全，拖一下**立刻**存进 localStorage（不用点保存）',
    knob.has === true && knob.saved === 25 && knob.label === '25ms', knob);
  await ev(`(() => { const k = 'lingkuang-settings'; const s = JSON.parse(localStorage.getItem(k) || '{}'); s.motionStagger = 10; localStorage.setItem(k, JSON.stringify(s)); window.dispatchEvent(new CustomEvent('lingkuang-settings')); return true; })()`);

  /* ── ③ 三种关法 ── */
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`);
  await sleep(300);
  const esc = await ev(`({ panel: !!document.getElementById('lk-settings-panel'), active: ${openBtn}.classList.contains('is-active') })`);
  check('★5 Esc 关闭面板，左栏按钮高亮同步熄灭', esc.panel === false && esc.active === false, esc);

  await ev(`${openBtn}.click(); true`);
  await sleep(400);
  /* 点遮罩**空白处**（面板根元素自己）关；点卡片内部不关 */
  const inside = await ev(`(() => {
    const card = document.querySelector('.lk-set-card');
    card?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return !!document.getElementById('lk-settings-panel');
  })()`);
  check('★6 点卡片内部**不会**误关（拖滑块手抖出界不该把面板关掉）', inside === true);
  await ev(`(() => { const p = document.getElementById('lk-settings-panel');
    p?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()`);
  await sleep(300);
  check('★7 点遮罩空白处关闭（面板与高亮一起收）',
    (await ev(`({ panel: !!document.getElementById('lk-settings-panel'), active: ${openBtn}.classList.contains('is-active') })`)).panel === false);

  /* ── ④ × 关闭 + 再点按钮 = 开关 ── */
  await ev(`${openBtn}.click(); true`);
  await sleep(400);
  const openedAgain = await ev(`!!document.getElementById('lk-settings-panel')`);
  await ev(`document.getElementById('lk-set-close')?.click(); true`);
  await sleep(300);
  const byX = await ev(`({ panel: !!document.getElementById('lk-settings-panel'), active: ${openBtn}.classList.contains('is-active') })`);
  check('★8 × 关闭（再开会重新读当前设置值 —— 单实例，不会叠出第二层）',
    openedAgain === true && byX.panel === false && byX.active === false, { openedAgain, byX });
  await ev(`${openBtn}.click(); true`);
  await sleep(300);
  await ev(`${openBtn}.click(); true`);
  await sleep(300);
  check('★9 再点一次按钮 = 关（按钮是开关，不是"切过去"）',
    (await ev(`!!document.getElementById('lk-settings-panel')`)) === false);

  /* ── ⑤ 关掉之后主区还在原地，而且中途改过设置也没把它弄丢 ── */
  const after = await ev(`({ sameRoot: document.querySelector('#cx-root') === window.__cx,
    tree: document.querySelectorAll('#cx-list .ed-tnode-item').length,
    btnActive: ${openBtn}.classList.contains('is-active') })`);
  check('★10 用过设置之后回到原处：工作台还是那个元素、树还在、按钮不亮',
    after.sameRoot === true && after.tree > 0 && after.btnActive === false, after);

  const errs = await ev(`window.__errs`);
  check('★11 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const n = results.filter(Boolean).length;
  console.log(`\n==== ${n}/${results.length} PASS ====`);
  process.exit(n === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack || e)); process.exit(2); });
