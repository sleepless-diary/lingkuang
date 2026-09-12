/* 空时间线不该被 vault 重建抹掉（docs/BUGS.md 第二十轮之四）。
 *
 * 背景：vault 里「一条时间线 = 一个目录」，而**还没放节点的时间线没有目录**。
 * `src/main.ts` 的 `vaultToWorldData()` 原来是「只遍历 vault 扫描结果」重建 timelines，
 * 于是空时间线被整条丢掉：新建一条时间线 → 重启（或任何一次 vault 回扫）后它从界面消失；
 * 而时间线级的 loops / storylines / absOffset / calendar **只有 JSON 一份**，
 * 所以它的循环与剧情线会一起消失，紧接着被 writeAll 写成永久丢失。
 *
 * 修复判据（与 entities 的例外同构）：base 里**本身就是 0 节点**的时间线 ⇒ 保留（纯 JSON 容器）；
 * base 里有节点却扫不到目录 ⇒ 用户从外部删了目录 ⇒ 继续按「文件为源」丢掉（不能复活）。
 * 本脚本后半段就是来钉死后半句的 —— 顺手删掉主线的目录，它必须消失、且不能把别的带回来。
 *
 * 用法：先跑 seed-empty-timeline.cjs，起应用，再跑本脚本；跑完按 README 重启跑冷启动那条。
 */
const fs = require('fs');
const path = require('path');
const DATA = process.env.LINGKUANG_TEST_DATA;
const VAULT = process.env.LINGKUANG_VAULT;
const WS = '测试世界观';
const PORT = process.env.LK_CDP_PORT || '9334';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }
const onDisk = () => { try { return JSON.parse(fs.readFileSync(DATA, 'utf8')).worldsets[WS]; } catch { return null; } };

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
  /** 只数**真页签**：`＋`（新建）也在同一个容器里，必须按 data-tl 挑 */
  const tabs = () => ev(`[...document.querySelectorAll('.lk-tl-tabs > .lk-tl-tab[data-tl]')].map((b) => b.textContent)`);

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);

  /* ── ① 启动后三条都在（修复前「支线」在这里就已经不见了） ── */
  const t1 = await tabs();
  check('★1 启动后三条时间线页签都在，含 0 节点的「支线」',
    Array.isArray(t1) && t1.length === 3 && t1.some((x) => x.includes('支线')) && t1.some((x) => x.includes('主线')) && t1.some((x) => x.includes('副线')), t1);

  /* ── ② 空时间线可以被选中（它不是"幽灵"：沙盘得能正常切过去） ── */
  await ev(`[...document.querySelectorAll('.lk-tl-tabs > .lk-tl-tab[data-tl]')].find((b) => b.textContent.includes('支线'))?.click(); true`);
  await sleep(400);
  const active = await ev(`document.querySelector('.lk-tl-tabs > .lk-tl-tab.is-active')?.textContent`);
  const canvasOk = await ev(`!!document.querySelector('.tl-wrap, .tl-track, #lk-pane-timeline .lk-pane-body')`);
  check('★2 空时间线能选中、沙盘照常渲染', String(active ?? '').includes('支线') && canvasOk, { active, canvasOk });

  /* ── ③ 让它落一次盘：新建第四条时间线（沙盘的 `＋` 是**直接建**、默认名「新时间线」，不走弹层） ── */
  const before = (await tabs()).length;
  await ev(`document.querySelector('#lk-tl-new').click(); true`);
  await sleep(1800);   /* 等 400ms 防抖落盘 */
  const after = await tabs();
  const disk = onDisk();
  const keys = Object.keys(disk?.timelines ?? {});
  const names = Object.values(disk?.timelines ?? {}).map((t) => t.name);
  check('★3 点＋能新建一条时间线（直接建，默认名「新时间线」）', after.length === before + 1 && after.some((x) => x.includes('新时间线')), { before, after });
  check('★4 落盘后**空时间线还在文件里**（修复前会被 writeAll 永久抹掉）',
    keys.includes('tl-side') && names.includes('支线') && names.includes('新时间线'),
    { 时间线: Object.values(disk?.timelines ?? {}).map((t) => `${t.name}(${t.nodes.length})`), order: disk?.order });

  /* ── ⑤ 回扫一轮（落盘会触发 vault 监听 → 重扫）后界面里四条都还在 ── */
  await sleep(800);
  const t2 = await tabs();
  check('★5 回扫后界面里空时间线仍在（四条）', Array.isArray(t2) && t2.length === 4 && t2.some((x) => x.includes('支线')), t2);

  /* ── ⑥ 反面：外部删掉「主线」的 vault 目录 → 它必须消失（文件为源，不复活） ── */
  fs.rmSync(path.join(VAULT, WS, '主线'), { recursive: true, force: true });
  let t3 = null;
  for (let i = 0; i < 40; i++) {   /* 监听有防抖，轮询等它回扫 */
    await sleep(300);
    t3 = await tabs();
    if (Array.isArray(t3) && !t3.some((x) => x.includes('主线'))) break;
  }
  check('★6 外部删掉目录后「主线」从界面消失（文件为源，旧数据不复活）',
    Array.isArray(t3) && !t3.some((x) => x.includes('主线')), t3);
  check('★7 对照组「副线」与两条空时间线都没被牵连',
    Array.isArray(t3) && t3.some((x) => x.includes('副线')) && t3.some((x) => x.includes('支线')) && t3.some((x) => x.includes('新时间线')), t3);

  const errs = await ev(`window.__errs`);
  check('8 无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const n = results.filter(Boolean).length;
  console.log(`\n==== ${n}/${results.length} PASS ====`);
  process.exit(n === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack || e)); process.exit(2); });
