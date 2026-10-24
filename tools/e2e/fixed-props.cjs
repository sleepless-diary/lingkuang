/* 结构体管理 ·「节点固定属性」（2026-10-24 第一百一十二轮）
 *
 * 用户原话：「结构体管理里面应该对内置字段也能进行修改（但是事件节点等触及底层的字段需要保护）」。
 * 这条守卫断言的是四件事：
 *   ① 每个种类都有 6 行固定属性（标题 / 时间 / 精度 / 类型 / 种类 / 描述）；
 *   ② 四行底层（时间 / 精度 / 种类 / 类型）标着「底层」、**没有隐藏按钮**；标题与描述有「隐藏」；
 *   ③ 数据里有、模板里没有的种类（真实库：历史 / 人物）在左边以「无模板」列出来，点一下能配；
 *   ④ 改名 → 保存 → 回设定库点一个该种类的节点，属性面板的第一行显示新名字。
 *
 * ⚠️ 会写用户数据（改名 + 保存），所以**只在隔离实例上跑**，而且跑完会把名字**改回原样**：
 *   起实例（`LINGKUANG_TEST_DATA` / `LINGKUANG_VAULT` / `LINGKUANG_TEST_USERDATA` 都指向副本，
 *   端口 9355），`LK_CDP_PORT=9355 node tools/e2e/fixed-props.cjs`。
 */
const PORT = process.env.LK_CDP_PORT || '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }

async function main() {
  let target = null;
  for (let i = 0; i < 120; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch {}
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

  /* 打开结构体管理（2026-10-24 起它在「实验室」抽屉里） */
  await ev(`document.getElementById('lk-lab-btn')?.click()`);
  await sleep(250);
  await ev(`document.querySelector('#lk-lab [data-tool="schema"]')?.click()`);
  await sleep(1200);

  const cfg = await ev(`(() => {
    const rows = [...document.querySelectorAll('[data-prow]')];
    return {
      rows: rows.length,
      labels: rows.map((r) => r.querySelector('[data-plabel]')?.value),
      locked: rows.filter((r) => /底层/.test(r.textContent)).length,
      hideBtns: rows.filter((r) => r.querySelector('[data-phide]')).length,
      extras: [...document.querySelectorAll('[data-kind-extra]')].map((b) => b.dataset.kindExtra),
    };
  })()`);
  check('★1 固定属性 6 行、顺序为 标题/时间/精度/类型/种类/描述',
    cfg.rows === 6 && (cfg.labels || []).join(',') === '标题,时间,精度,类型,种类,描述', cfg.labels);
  check('★2 四行底层只有「底层」标、没有隐藏按钮；标题与描述可隐藏',
    cfg.locked === 4 && cfg.hideBtns === 2, { locked: cfg.locked, hideBtns: cfg.hideBtns });
  check('★3 数据里有、模板里没有的种类以「无模板」列出（历史 / 人物）',
    (cfg.extras || []).includes('历史') && (cfg.extras || []).includes('人物'), cfg.extras);

  /* 找一个真实在用的种类来验（优先 历史），记下原名字以便恢复 */
  const kind = (cfg.extras || []).includes('历史') ? '历史' : (cfg.extras || [])[0];
  if (!kind) { check('★4 找不到可用于验证的「无模板种类」', false); process.exit(1); }
  await ev(`document.querySelector('[data-kind-extra="${kind}"]').click()`);
  await sleep(450);
  const before = await ev(`document.querySelector('[data-plabel="0"]')?.value`);
  const NEW = '事件名';
  await ev(`(() => {
    const inp = document.querySelector('[data-plabel="0"]');
    inp.value = ${JSON.stringify(NEW)};
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('blur'));
    return inp.value;
  })()`);
  await sleep(300);
  await ev(`document.getElementById('sc-save').click()`);
  await sleep(900);
  const saved = await ev(`document.getElementById('sc-msg')?.textContent ?? ''`);
  check('★4 改名后保存成功（回执「已保存」）', String(saved).includes('已保存'), saved);

  /* 回设定库：点一个该种类的节点，属性面板第一行应是新名字 */
  await ev(`document.querySelector('[data-tool="codex"]').click()`);
  await sleep(900);
  await ev(`(() => { const rows = [...document.querySelectorAll('#cx-list [data-act="node"]')]; rows[0]?.click(); return rows.length; })()`);
  await sleep(900);
  const firstKey = await ev(`document.querySelector('#cx-body .ed-props > div > span')?.textContent ?? null`);
  check(`★5 节点属性面板第一行 = 「${NEW}」（结构体管理的改名生效）`, firstKey === NEW, firstKey);

  /* 改回原样（这条守卫不该在别人的库上留下改名） */
  await ev(`document.getElementById('lk-lab-btn')?.click()`);
  await sleep(200);
  await ev(`document.querySelector('#lk-lab [data-tool="schema"]')?.click()`);
  await sleep(1000);
  await ev(`document.querySelector('[data-kind="${kind}"]')?.click()`);
  await sleep(400);
  await ev(`(() => {
    const inp = document.querySelector('[data-plabel="0"]');
    if (!inp) return false;
    inp.value = ${JSON.stringify(before || '标题')};
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('blur'));
    return true;
  })()`);
  await sleep(300);
  await ev(`document.getElementById('sc-save')?.click()`);
  await sleep(700);
  const restored = await ev(`document.querySelector('[data-plabel="0"]')?.value`);
  check('★6 跑完把名字改回原样（不污染数据）', restored === (before || '标题'), { before, restored });

  const errs = await ev(`window.__errs`);
  check('★7 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const n = results.filter(Boolean).length;
  console.log(`\n==== ${n}/${results.length} PASS ====`);
  process.exit(n === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack || e)); process.exit(2); });
