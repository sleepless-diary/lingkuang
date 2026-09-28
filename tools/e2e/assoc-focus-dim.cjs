/* 灵感触发器 · 联想画布：**「已选过的词也会虚化」**回归 6 项
 *（用户 2026-09-28：「还有一件事，为什么已选过的词也会虚化显示」）
 *
 * 真因（`src/ui/assoc.ts` 两套状态没打通）：
 *   · `is-dim` 只看**当前焦点路径** —— `assoc.ts:499` 的判据是
 *     `n.id !== focusedId && !isOnFocusPath(n.id)`，而 `isOnFocusPath()`（assoc.ts:598-613）只认三样：
 *     焦点自己、焦点的**祖先链**（一路上溯到根）、焦点**当前展开的子层**（`f.children.includes(id)`）。
 *   · `selected`（点子词时置真、此后永不清除 —— 见 `onNodeClick` 的 `node.selected = true`）**完全没参与**淡化判定。
 *   ⇒ 只要你把焦点换到别的分支，刚才走出来的那串思维链就掉出焦点路径，整串立刻挂上 `is-dim`；
 *     而 `is-dim` 是 `opacity: .25`（src/style.css:338），**乘性**地盖在 `is-selected` 的绿底（style.css:322）上
 *     ⇒ 视觉上「选过」这件事被整个擦掉 = 用户看到的"已选过的词也虚化"。
 *   修法（1 行）：`is-dim` 判据里加 `!n.selected` —— 自己走过的路不参与降噪；
 *   没走的那些分支照旧淡化（降噪的目的没废）。
 *
 * 本套件把 `window.fetch` 换成**按次回放的固定词表**（不连模型）：
 *   第 1 次（根展开）→ 4 个词；第 2 次（点子词 1）→ 4 个新词；第 3 次（点子词 2）→ 4 个新词。
 *   A/B：旧构建 ★2（掉出焦点路径的已选词不淡化）红，新构建全绿。
 *
 * 用法（见 tools/e2e/README.md）：
 *   $env:LINGKUANG_* 指向测试目录 → 起应用（--remote-debugging-port=9500）→ node tools/e2e/assoc-focus-dim.cjs
 * ⚠️ 测试实例是 showInactive ⇒ rAF 不自己推进，出帧靠 forceFrames()。
 * ⚠️ 开头整页 reload（`assocSetRoot` 遇同词根只聚焦不重建，不重载第二遍就不发请求 ⇒ 假 FAIL）。
 */
const PORT = process.env.LK_CDP_PORT || '9500';
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
  const forceFrames = async (n = 20) => {
    for (let i = 0; i < n; i++) { await send('Page.captureScreenshot', { format: 'jpeg', quality: 10 }); await sleep(25); }
  };
  const evSoft = async (expr) => { try { return await ev(expr); } catch { return undefined; } };
  const waitFor = async (expr, tries = 60) => { for (let i = 0; i < tries; i++) { if (await evSoft(expr)) return true; await sleep(150); } return false; };

  /* 每个节点此刻的四个类（判据只用这四个，不看坐标/像素） */
  const READ = `(() => [...document.querySelectorAll('#assoc-world .assoc__node, #assoc-world .assoc__root')]
      .map((e) => ({ id: Number(e.dataset.id), word: e.textContent, dim: e.classList.contains('is-dim'),
                     sel: e.classList.contains('is-selected'), focus: e.classList.contains('is-focus') })))()`;
  const byId = (list, n) => (list || []).find((x) => x.id === n) || {};
  const clickNode = async (n) => { await ev(`document.querySelector('#assoc-world [data-id="${n}"]').click(); true`); await sleep(500); await forceFrames(12); };

  await send('Page.enable', {});
  await send('Page.reload', {});
  await waitFor(`!!document.querySelector('[data-tool="inspire"]')`, 80);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);

  /* ── ★0 前置：openai 协议的供应商（真机形状；key 是假的，fetch 已被换掉） ── */
  await ev(`(() => {
    const s = JSON.parse(localStorage.getItem('lingkuang-settings') || '{}');
    s.providers = [{ id: 'probe', name: '回放供应商', preset: 'custom', kind: 'openai', baseUrl: 'https://example.invalid/v1', apiKey: 'sk-probe', model: 'probe-model' }];
    s.activeProvider = 'probe';
    localStorage.setItem('lingkuang-settings', JSON.stringify(s));
    return true; })()`);

  /* ── 回放：按次给不同的词表（第 2/3 次要**新词**，否则只会把已有节点接到新父下、不给新节点） ── */
  const SETS = [['驯鹿', '雪橇', '铃铛', '木屋'], ['冻湖', '极光', '松林', '猎户'], ['号角', '篝火', '皮靴', '熊皮']];
  await ev(`(() => {
    window.__calls = 0;
    const SETS = ${JSON.stringify(SETS)};
    window.fetch = async () => {
      const words = SETS[Math.min(window.__calls, SETS.length - 1)];
      window.__calls++;
      const reply = { choices: [{ message: { role: 'assistant', content: words.join('\\n') }, finish_reason: 'stop' }] };
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    return true; })()`);

  await ev(`document.querySelector('[data-tool="inspire"]').click(); true`);
  await waitFor(`!!document.querySelector('#assoc-stage')`, 40);
  await ev(`document.querySelector('#insp-assoc').assocSetRoot('雪原'); true`);
  await waitFor(`document.querySelectorAll('#assoc-world .assoc__node').length >= 4`, 40);
  await forceFrames(20);

  const first = await ev(READ);
  check('★0 前置：根「雪原」长出 4 个子词（回放的第一份词表）',
    first.length >= 5 && first.some((x) => x.word === '驯鹿'), { n: first.length, words: first.map((x) => x.word) });

  /* ── ★1 焦点在子词 1 上：它自己、它的祖先、它展开的子层都不淡化；没走的兄弟淡化 ── */
  await clickNode(1);
  const s1 = await ev(READ);
  const n1a = byId(s1, 1), sibA = byId(s1, 3), childA = byId(s1, 5);
  check('★1 点子词后：它带 is-focus + is-selected 且**不淡化**，焦点子层也不淡化',
    n1a.focus === true && n1a.sel === true && n1a.dim === false && childA.dim === false,
    { n1: n1a, child5: childA });
  check('★1b 降噪仍在：这一支**没走过**的兄弟照旧 is-dim',
    sibA.dim === true && sibA.sel !== true, { n3: sibA });

  /* ── ★2 换到另一支：刚才那个已选词掉出焦点路径 —— 用户那条 bug 的直接指纹 ── */
  await clickNode(2);
  const s2 = await ev(READ);
  const n1b = byId(s2, 1), n2b = byId(s2, 2), sibB = byId(s2, 3);
  check('★2 换到另一支后：**已选过的词不再虚化**（旧构建 is-dim）',
    n1b.dim === false, { n1: n1b });
  check('★2b 已选过的词还留着 is-selected（绿底没被 opacity 擦掉；旧构建是 is-selected + is-dim 同时挂）',
    n1b.sel === true, { n1: n1b });
  check('★2c 新焦点自己照常 is-focus + is-selected，且没选过的兄弟仍然 is-dim（降噪没被废掉）',
    n2b.focus === true && n2b.sel === true && n2b.dim === false && sibB.dim === true,
    { n2: n2b, n3: sibB });

  const errs = await ev(`window.__errs`);
  check('★3 全程无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const bad = results.filter((x) => !x).length;
  console.log(`\n${results.length - bad}/${results.length} PASS`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.log('FAIL 套件异常：' + (e && e.stack ? e.stack : e)); process.exit(1); });
