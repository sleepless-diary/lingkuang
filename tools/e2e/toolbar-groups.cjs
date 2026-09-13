/* 左栏分组（用户 2026-09-12：「设置放到左侧栏最底下」）—— 布局类断言，防有人无意改回去。
 *
 * 为什么单开一条：这不是"好看不好看"，是**信息架构**的决定，而且很容易被顺手改掉
 * （比如往 register.ts 里加一个工具、或重排登记顺序）。排序由 `src/ui/shell.ts` 的 `renderToolbar`
 * 按 `Tool.group` 过滤决定，**不靠注册顺序** —— 所以这条套件断言的是 DOM 里的最终结果：
 *   ① 两组、顺序固定（上段创作：sandbox/inspire/ai/codex/library；
 *      下段管理：schema/trash/backup/settings）
 *   ② 管理组**贴底**（`margin-top:auto` 生效）且与上段之间留出空隙
 *   ③ 「设置」在最底下那一个，点了真的能打开设置面板（分组改动没把点击/高亮弄坏）
 *
 * 用法：随便哪个已播种的测试目录都行（本套件不依赖世界数据），起应用后跑：
 *   node tools\e2e\toolbar-groups.cjs      # 4 项
 */
const PORT = process.env.LK_CDP_PORT || '9334';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }

/* 「编辑器」已并入「设定库」工作台（2026-09-13 用户批准：一个工具两种形态，设置里切），
   所以创作组从 6 个变 5 个 —— 少一个图标是本轮刻意付的代价。 */
const CREATE = ['sandbox', 'inspire', 'ai', 'codex', 'library'];
const MANAGE = ['schema', 'trash', 'backup', 'settings'];

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

  await sleep(1200);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);

  const geo = await ev(`(() => {
    const bar = document.getElementById('lk-toolbar');
    const b = bar.getBoundingClientRect();
    const groups = [...bar.querySelectorAll('.lk-tool-group')].map((g) => {
      const r = g.getBoundingClientRect();
      return { cls: g.className, top: Math.round(r.top), bottom: Math.round(r.bottom),
        tools: [...g.querySelectorAll('.lk-tool-btn')].map((x) => x.dataset.tool) };
    });
    return { bar: { bottom: Math.round(b.bottom) }, groups,
      order: [...bar.querySelectorAll('.lk-tool-btn')].map((x) => x.dataset.tool) };
  })()`);

  const flat = (geo.order || []).join(',');
  check('★1 左栏两组、顺序固定：创作 5 个在上、管理 4 个在下（设置排最底）',
    (geo.groups || []).length === 2
      && (geo.groups[0].tools || []).join(',') === CREATE.join(',')
      && (geo.groups[1].tools || []).join(',') === MANAGE.join(',')
      && flat === [...CREATE, ...MANAGE].join(','), geo.groups?.map((g) => g.tools));

  const g0 = geo.groups?.[0], g1 = geo.groups?.[1];
  check('★2 管理组贴底（离左栏底 ≤ 10px）且与上段之间留出空隙（> 40px）',
    !!g1 && geo.bar.bottom - g1.bottom <= 10 && geo.bar.bottom - g1.bottom >= 0 && g1.top - g0.bottom > 40,
    { gapToBottom: geo.bar?.bottom - (g1?.bottom ?? 0), gapBetween: (g1?.top ?? 0) - (g0?.bottom ?? 0) });

  /* 最底下那个 = 设置：点了要真的**开出一层悬浮面板**（分组改了 DOM 结构，别把点击/高亮一起弄坏）。
     自 2026-09-13 起设置是**面板型工具**（`src/ui/settings-panel.ts`）：它**不接管主区**
     ——`#lk-module-view` 里原来是什么就还是什么，面板挂在 document.body 上。 */
  const opened = await ev(`(() => {
    const btn = [...document.querySelectorAll('#lk-toolbar .lk-tool-btn')].pop();
    const id = btn.dataset.tool;
    const before = document.getElementById('lk-module-view')?.innerHTML ?? '';
    window.__mvBefore = before;
    btn.click();
    return { id, active: btn.classList.contains('is-active') };
  })()`);
  await sleep(900);
  const panel = await ev(`(() => {
    const p = document.getElementById('lk-settings-panel');
    const card = p?.querySelector('.lk-set-card');
    const txt = (p?.textContent || '').slice(0, 300);
    const mv = document.getElementById('lk-module-view');
    return {
      exists: !!p, floating: p ? getComputedStyle(p).position : null,
      inBody: p ? p.parentElement === document.body : false,
      hasSettingsWord: /设置/.test(txt),
      hasMotionCard: !!document.querySelector('#set-motion-on'),
      cardDur: card ? (card.getAnimations()[0]?.effect.getTiming().duration ?? null) : null,
      moduleUntouched: (mv?.innerHTML ?? '') === window.__mvBefore,
      head: txt.slice(0, 60),
    };
  })()`);
  check('★3 最底下那个按钮就是「设置」：点它开出一层**悬浮**面板（固定定位挂 body、主区一动不动）',
    opened?.id === 'settings' && opened.active === true && panel.exists === true && panel.floating === 'fixed'
      && panel.inBody === true && panel.hasSettingsWord === true && panel.hasMotionCard === true
      && panel.moduleUntouched === true, { opened, panel });

  /* 再点一次 = 关掉（按钮是开关），高亮也跟着灭 */
  const closed = await ev(`(() => {
    const btn = [...document.querySelectorAll('#lk-toolbar .lk-tool-btn')].pop();
    btn.click();
    return { panel: !!document.getElementById('lk-settings-panel'), active: btn.classList.contains('is-active') };
  })()`);
  check('★3b 再点一次设置按钮 = 关掉面板，高亮同步熄灭',
    closed.panel === false && closed.active === false, closed);

  const errs = await ev(`window.__errs`);
  check('★4 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const n = results.filter(Boolean).length;
  console.log(`\n==== ${n}/${results.length} PASS ====`);
  process.exit(n === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack || e)); process.exit(2); });
