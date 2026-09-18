/* 不变量：**AI 工具是多会话的**（第 3.4 片）。
 *
 * 用户 2026-09-18 的原话：「**有会话管理的那种，选定一个主会话，其他会话可以作为角色或者不同视角，
 * 酒馆就是连接不同的会话，剧情推演就是加一个主控会话**」。它要同时满足两件事：
 *   ① 会话列表能用（新建 / 重命名 / 删除 / 选中），且**主会话删不掉**（它是「总在那儿」的那一格）；
 *   ② 「连接」把别的会话连进当前会话（`links`），落盘 `agent/sessions.json`（裸数组、能手看手改）。
 *
 * ⚠️ 本套件**不发消息**：`aiChat()` 要连本地 Ollama，测试机上没有模型；断言只覆盖会话管理与落盘。
 *    「历史各自独立」「连接只带尾巴」两条是 `src/ui/ai-sessions.ts` 的纯逻辑（`pushMsg` / `sessionPrompt`），
 *    靠 `LINK_TAIL = 8` 与每会话自己的 `history` 保证，将来发消息那条路要用真模型另配一套。
 *
 * ⚠️ `window.confirm` 在 Electron 里是**真模态框**：不 stub 掉，CDP 的 Runtime.evaluate 会一直挂着。
 *
 * 用法：起干净实例（`LINGKUANG_TEST_DATA` 指 `%TEMP%\lk-evault2\worldbuilding.json`，删 `agent\sessions.json`），
 *   LK_CDP_PORT=9346 node tools/e2e/ai-sessions.cjs
 */
const fs = require('fs');
const path = require('path');
const PORT = process.env.LK_CDP_PORT || '9346';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }

/** agent 目录 = `main.js` 的 `AGENT_DIR()`（测试时跟着 LINGKUANG_TEST_DATA 走） */
function agentDir() {
  if (process.env.LK_AGENT_DIR) return process.env.LK_AGENT_DIR;
  if (process.env.LINGKUANG_TEST_DATA) return path.join(path.dirname(process.env.LINGKUANG_TEST_DATA), 'agent');
  return path.join(require('os').tmpdir(), 'lk-evault2', 'agent');
}
function readSessions() {
  try { const v = JSON.parse(fs.readFileSync(path.join(agentDir(), 'sessions.json'), 'utf8')); return Array.isArray(v) ? v : null; } catch { return null; }
}
/** 落盘是节流的（`setSessionSink` 400ms）⇒ 断言磁盘必须轮询，不能死等 */
async function waitSessions(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = readSessions();
    if (v && fn(v)) return v;
    if (Date.now() - t0 > ms) return v;
    await sleep(400);
  }
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
  /** 轮询某个表达式直到为真（同 agent-panel：动画/异步完成后才知道的事不许死等） */
  const waitTrue = async (expr, ms = 4000) => {
    const t0 = Date.now();
    for (;;) { if (await ev(expr)) return true; if (Date.now() - t0 > ms) return false; await sleep(200); }
  };
  /** 左栏每一行的 {name, role}（名字在第一个 span 里） */
  const rowsExpr = `[...document.querySelectorAll('#ai-sess [data-s]')].map((r) => ({ id: r.dataset.s, name: r.querySelector('span')?.textContent ?? '', role: r.querySelectorAll('span')[1]?.textContent ?? '' }))`;

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  /* 进 AI 工具（它是注册表里的 `ai`，见 src/tools/register.ts） */
  await ev(`document.querySelector('[data-tool="ai"]').click(); true`);
  await waitTrue(`!!document.querySelector('#ai-sess')`);

  /* ── ① 默认就有一个「主会话」并被选中 ── */
  const boot = await ev(`(() => {
    const t = document.querySelector('#ai-head')?.textContent ?? '';
    return { rows: ${rowsExpr}, head: t, hasNew: !!document.querySelector('#ai-new'), hasSend: !!document.querySelector('#ai-send') };
  })()`);
  check('★0 前置：AI 工具是多会话界面（左栏会话列表 + 右栏对话 + 新建/发送都在）',
    boot.hasNew === true && boot.hasSend === true && boot.rows.length === 1, boot);
  check('★1 默认有一个「主会话」且被选中（head 显示名字 + 主）',
    boot.rows[0] && boot.rows[0].name === '主会话' && boot.rows[0].role === '主' && boot.head.indexOf('主会话') >= 0, boot.rows[0]);

  /* ── ② 新建一个「角色」会话，右栏跟着切过去 ── */
  await ev(`(() => {
    const n = document.querySelector('#ai-new-name'); n.value = '艾德温';
    const r = document.querySelector('#ai-new-role'); r.value = 'character';
    document.querySelector('#ai-new').click(); return true;
  })()`);
  const made = await ev(`(() => ({ rows: ${rowsExpr}, head: document.querySelector('#ai-head')?.textContent ?? '' }))()`);
  check('★2 新建「角色」会话：左栏多一行、右栏当场切到新会话（名字 + 角）',
    made.rows.length === 2 && made.rows.some((r) => r.name === '艾德温' && r.role === '角') && made.head.indexOf('艾德温') >= 0, made.head);

  /* ── ③ 选中主会话 → 把「艾德温」连进来（连接 = 把它的尾巴拼进当前会话的上下文） ── */
  const linked = await ev(`(() => {
    const rows = [...document.querySelectorAll('#ai-sess [data-s]')];
    const main = rows.find((r) => r.querySelector('span')?.textContent === '主会话');
    main.click();
    return true;
  })()`);
  await sleep(200);
  await ev(`(() => {
    const rows = [...document.querySelectorAll('#ai-sess [data-s]')];
    const r = rows.find((x) => x.querySelector('span')?.textContent === '艾德温');
    r.querySelector('[data-act="link"]').click();
    return true;
  })()`);
  const afterLink = await ev(`(() => ({
    rows: ${rowsExpr},
    head: document.querySelector('#ai-head')?.textContent ?? '',
    note: document.querySelector('#ai-note')?.textContent ?? '',
  }))()`);
  check('★3 「连接」把别的会话连进当前会话：head 说得出连了谁、提示也说了',
    linked === true && afterLink.head.indexOf('连着：艾德温') >= 0 && afterLink.note.indexOf('已把') === 0, { head: afterLink.head, note: afterLink.note });

  /* ── ④ 落盘：两个会话都在 sessions.json 里，且主会话的 links 里有艾德温 ── */
  const disk1 = await waitSessions((v) => v.length === 2 && (v.find((s) => s.role === 'main')?.links ?? []).length === 1);
  const mainS = (disk1 ?? []).find((s) => s.role === 'main');
  const charS = (disk1 ?? []) .find((s) => s.role === 'character');
  check('★4 会话落盘到 agent/sessions.json（裸数组；主会话的 links 里就是那个角色会话的 id）',
    !!mainS && !!charS && Array.isArray(mainS.links) && mainS.links[0] === charS.id && charS.name === '艾德温',
    { n: (disk1 ?? []).length, links: mainS?.links, charId: charS?.id });

  /* ── ④b 人设 = **设定库里的一条**（用户 2026-09-18：「人设直接复用我们的角色系统，
     修改人设去设定库里面，会话直接选择人设进行聊天」）：会话只记人设 id，正文每次现取。 ── */
  const persona = await ev(`(() => {
    const sel = document.querySelector('#ai-persona');
    if (!sel) return { has: false };
    const opts = [...sel.options].map((o) => o.textContent);
    const target = [...sel.options].find((o) => o.textContent.indexOf('银发少女') === 0);
    sel.value = target ? target.value : '';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { has: true, opts, picked: target ? target.textContent : '' };
  })()`);
  const diskP = await waitSessions((v) => v.some((s) => !!s.personaId));
  const withP = (diskP ?? []).find((s) => !!s.personaId);
  check('★4b 人设来自**设定库**（下拉列出设定库条目、第一项是「不选人设」；选中后会话里只记人设 id，旧的自填文本字段已消失）',
    persona.has === true && persona.opts[0] === '不选人设' && persona.opts.some((o) => o.indexOf('银发少女') === 0)
      && !!withP && typeof withP.personaId === 'string' && withP.personaId.length > 2 && !('persona' in withP),
    { opts: persona.opts, picked: persona.picked, personaId: withP?.personaId });
  /* ── ⑤ 双击重命名（Electron 没有 window.prompt，所以是就地输入框） ── */
  await ev(`(() => {
    const rows = [...document.querySelectorAll('#ai-sess [data-s]')];
    const r = rows.find((x) => x.querySelector('span')?.textContent === '艾德温');
    r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  })()`);
  await waitTrue(`!!document.querySelector('#ai-sess [data-s] input')`);
  await ev(`(() => {
    const inp = document.querySelector('#ai-sess [data-s] input');
    inp.value = '霜冠';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    inp.blur();
    return true;
  })()`);
  const disk2 = await waitSessions((v) => v.some((s) => s.name === '霜冠'));
  const rows2 = await ev(rowsExpr);
  check('★5 重命名（双击 → 就地改 → Enter）：左栏与磁盘都改了',
    rows2.some((r) => r.name === '霜冠') && (disk2 ?? []).some((s) => s.name === '霜冠'),
    { rows: rows2.map((r) => r.name), disk: (disk2 ?? []).map((s) => s.name) });

  /* ── ⑥ 删除：主会话删不掉；点角色会话的 × 才真删（stub 掉 confirm，否则模态框会挂住 CDP） ── */
  await ev(`window.confirm = () => true; true`);
  await ev(`(() => {
    const rows = [...document.querySelectorAll('#ai-sess [data-s]')];
    const main = rows.find((r) => r.querySelector('span')?.textContent === '主会话');
    return { del: !!main.querySelector('[data-act="del"]') };
  })()`);
  const mainNoDel = await ev(`(() => {
    const rows = [...document.querySelectorAll('#ai-sess [data-s]')];
    const main = rows.find((r) => r.querySelector('span')?.textContent === '主会话');
    return !main.querySelector('[data-act="del"]');
  })()`);
  await ev(`(() => {
    const rows = [...document.querySelectorAll('#ai-sess [data-s]')];
    const r = rows.find((x) => x.querySelector('span')?.textContent === '霜冠');
    r.querySelector('[data-act="del"]').click();
    return true;
  })()`);
  const disk3 = await waitSessions((v) => v.length === 1);
  const rows3 = await ev(rowsExpr);
  check('★6 删除：主会话没有删除键（它是「总在那儿」的那一格）；角色会话删掉后左栏与磁盘都少了它',
    mainNoDel === true && rows3.length === 1 && rows3[0].name === '主会话' && (disk3 ?? []).length === 1,
    { mainNoDel, rows: rows3.map((r) => r.name), disk: (disk3 ?? []).length });

  /* ── ⑦ 重开也能读回来（磁盘是真相；界面每次都是从 `agent:load` 重建的） ── */
  const reload = await ev(`(async () => {
    const r = await window.lingkuangAPI.agentLoad();
    return { ok: r?.ok === true, n: Array.isArray(r?.sessions) ? r.sessions.length : -1, first: r?.sessions?.[0]?.name ?? '' };
  })()`);
  check('★7 `agent:load` 会把 sessions 一起给渲染层（重开时会话从磁盘恢复）',
    reload.ok === true && reload.n === 1 && reload.first === '主会话', reload);

  const errs = await ev(`window.__errs`);
  check('★8 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n==== ${pass}/${results.length} PASS ====`);
  w.close();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
