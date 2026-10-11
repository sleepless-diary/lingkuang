/* agent-delete.cjs —— 灵框助手的「删除手 + 世界/时间线创建」（片 3，2026-10-12）
 *
 * 起因（用户原话）：「**你没给AI配置删除和创建的工具吗**」——
 * 查证：创建早有（create_entity / create_node / write_file / append_file），但
 *   ① **删除一条都没有**（`src/ui/agent-tools.ts` grep `delete|remove|删除|trash` 零命中）；
 *   ② **世界 / 时间线这两层没有创建入口**（只有 create_entity / create_node 那种"一条条内容"级的）。
 * 用户当场拍板（ask_user_question，多选全勾 + 安全档）：三类删除全要
 *   （设定/事件、整条时间线/整个世界、灵框库外的文件），且**「直接执行」档下删除直接生效**。
 *
 * 本套件守的不变量：
 *   ① 删除**一律走 `src/store/actions.ts`**（removeEntity/removeNode/removeTimeline/removeWorld）——
 *      它们是"store 移除 + .md 移进 vault 回收站"两件事的唯一实现（灵框是"文件为源"，只删内存会复活）；
 *      灵框**外**的文件删走主进程 `shell.trashItem()` ⇒ **Windows 回收站**。
 *   ② 找不到目标 ⇒ **什么都不删**、不出卡片，动作结果里给候选名单（模型下一轮能改对名字）。
 *   ③ 逐次确认档 ⇒ 一张卡片，点之前磁盘/数据一点没动；直接执行档 ⇒ 删掉（用户亲口选的档）。
 *   ④ 两条兜底护栏（不靠权限档）：**最后一个世界 / 最后一条时间线不删**。
 *   ⑤ 灵框库（vault）里的文件**不能**用 delete_file（会让 store 与文件对不上）⇒ 提示改用 delete_entity / delete_node。
 *
 * ⚠️ 两条写这套件时踩到、值得记下来的坑：
 *   · **拒绝类动作没有下一轮模型调用** ⇒ 那条 `【动作结果】` 永远不会出现在 `window.__lkSeen`
 *     的最后一次调用里（它是"这轮结束之后"才 push 进历史的）。断言要看 **DOM 里最后那条 `.lk-agent__tool`
 *     回执**（`lastTool()`），别看喂回的消息 —— 否则读到的会是创作者自己那句话（假红）。
 *   · `create_world` 会把**活动世界切到新世界**（新世界里没有任何实体类型模板）⇒ 后面所有
 *     「建设定 / 用类型」的检查都会失去意义。所以世界/时间线那一段必须排在最后。
 *
 * 前置（同一 pwsh 调用里做，再重启实例）：
 *   $env:LINGKUANG_TEST_DATA=<lk-del>\worldbuilding.json; $env:LINGKUANG_VAULT=<lk-del>\vault
 *   $env:LINGKUANG_TEST_USERDATA=<lk-del>\userdata
 *   夹具（readonly/ 两个待删文件 + outside/ 白名单外的秘密）由本套件自己造；白名单靠 `fs:add-root` 带 path 加。
 * 跑：$env:LK_CDP_PORT=9500; node tools\e2e\agent-delete.cjs
 */
const fs = require('fs');
const path = require('path');
const PORT = process.env.LK_CDP_PORT || '9500';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(n, ok, extra) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);
}

/* ---------- 夹具 ---------- */
const TEST_DATA = process.env.LINGKUANG_TEST_DATA;
const VAULT = process.env.LINGKUANG_VAULT;
const USERDATA = process.env.LINGKUANG_TEST_USERDATA;
if (!TEST_DATA || !VAULT || !USERDATA) {
  console.log('FAIL 缺环境变量：需要 LINGKUANG_TEST_DATA / LINGKUANG_VAULT / LINGKUANG_TEST_USERDATA（见文件头"前置"）');
  process.exit(1);
}
const ROOT = path.dirname(TEST_DATA);
const RO = path.join(ROOT, 'readonly');            /* 助手能碰、一开始只读 */
const OUT = path.join(ROOT, 'outside');            /* 白名单外 */
const DEL_FILE = path.join(RO, 'lk-e2e-del.md');   /* 待删的文件（灵框库外） */
const DEL_FILE2 = path.join(RO, 'lk-e2e-del2.md');
const SECRET = path.join(OUT, 'secret.txt');

function makeFixtures() {
  fs.mkdirSync(RO, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(DEL_FILE, '第一行：这一份是要被删掉的草稿。\n', 'utf8');
  fs.writeFileSync(SECRET, '这是一份没交给助手的秘密素材。', 'utf8');
  try { fs.unlinkSync(DEL_FILE2); } catch { /* 本来就没有 */ }
}

/* ---------- 磁盘侧探针（不信 DOM、只看盘） ---------- */
function walk(dir, out, skipTrash) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of items) {
    if (d.name === '.trash') { if (!skipTrash && d.isDirectory()) walk(path.join(dir, d.name), out, false); continue; }
    const full = path.join(dir, d.name);
    if (d.isDirectory()) walk(full, out, skipTrash);
    else out.push(full);
  }
  return out;
}
const vaultFiles = () => walk(VAULT, [], true);                                     /* 不含 .trash */
const trashFiles = () => walk(path.join(VAULT, '.trash'), [], false);
const hasVault = (name) => vaultFiles().some((p) => path.basename(p).toLowerCase().includes(name.toLowerCase()));
const hasTrash = (name) => trashFiles().some((p) => path.basename(p).toLowerCase().includes(name.toLowerCase()));
const waitFor = async (fn, want, ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn() === want) return true; await sleep(150); }
  return fn() === want;
};
const baseNames = (list) => list.map((p) => path.basename(p));

async function main() {
  makeFixtures();

  /* ---------- 连 CDP ---------- */
  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* 还没起来 */ }
    if (!target) await sleep(200);
  }
  if (!target) { console.log('FAIL 无法连接 CDP ' + PORT); process.exit(1); }
  const w = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  w.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  const send = (method, params) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    w.send(JSON.stringify({ id, method, params: params || {} }));
  });
  /* ⚠️ 带超时的 eval：渲染进程里某句 `await` 永不落定（比如主进程某个 IPC 挂着）时，
     不带超时的版本会**静静吊死**整套（片 1 就被 `fs:add-root` 的对话框分支逮到过一次）。 */
  const ev = async (expr) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
      sleep(15000).then(() => ({ result: { exceptionDetails: { text: 'eval 超时 15000ms: ' + String(expr).slice(0, 120) } } })),
    ]);
    const ex = r.result && r.result.exceptionDetails;
    if (ex) throw new Error('eval: ' + ((ex.exception && ex.exception.description) || ex.text));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const api = async (expr) => {
    try {
      return await ev(`window.lingkuangAPI.fs.${expr}`);
    } catch (e) {
      return { ok: false, error: '没有 fs 通道（旧构建）：' + (e && e.message ? e.message : String(e)) };
    }
  };
  const json = (v) => JSON.stringify(v);

  await sleep(1600);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);

  /* ---------- ★0 前置 ---------- */
  const hasApi = await ev(`!!(window.lingkuangAPI && window.lingkuangAPI.fs && window.lingkuangAPI.fs.roots)`);
  check('★0 前置：preload 暴露了 fs 通道（旧构建这里就是 false）', hasApi === true);

  const before = await api('roots()');
  for (const r of (before.roots || []).filter((r) => !r.builtin)) await api(`removeRoot(${json(r.path)})`);
  await api(`addRoot({ path: ${json(RO)} })`);

  /* ---------- 面板：codex + 助手面板 + 「自动」档 ---------- */
  await ev(`document.querySelector('#lk-toolbar [data-tool="codex"]')?.click(); true`);
  await sleep(900);
  await ev(`(function () { const b = document.getElementById('lk-agent-close'); if (b) b.click(); return true; })()`);
  await sleep(400);
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
  await sleep(700);
  await ev(`document.getElementById('lk-agent-mode-agent')?.click(); true`);
  await sleep(300);

  const setMock = async (queue) => ev(`window.__lkSeen = []; window.__lkMockQ = ${json(queue)}; window.__lkAgentMock = (m) => { window.__lkSeen.push(m); return window.__lkMockQ.length ? window.__lkMockQ.shift() : '好的。'; }; true`);
  const ask = async (text) => {
    await ev(`(function () { const t = document.getElementById('lk-agent-input'); t.value = ${json(text)}; document.getElementById('lk-agent-send').click(); return true; })()`);
    await sleep(1200);
  };
  const cards = () => ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__prop').length`);
  const noteText = () => ev(`(document.getElementById('lk-agent-note') || {}).textContent || ''`);
  /* ⭐ 断言一律看**最后那条动作结果**（DOM 里 `.lk-agent__tool`）：拒绝类动作之后模型不会再被调一次，
     那条消息不会出现在 `__lkSeen` 里（见文件头那条坑）。 */
  const lastTool = () => ev(`(function () { const t = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__tool')]; return t.length ? t[t.length - 1].textContent : ''; })()`);
  const lastTitle = () => ev(`(function () { const p = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__prop-h')]; return p.length ? p[p.length - 1].textContent : ''; })()`);
  const applyLast = () => ev(`(function () { const b = [...document.querySelectorAll('#lk-agent-msgs [data-prop-ok]')].pop(); if (b) b.click(); return true; })()`);
  const setGate = async (scope, ask2) => {
    await ev(`(function () {
      const s = document.getElementById('lk-agent-scope');
      const a = document.getElementById('lk-agent-ask');
      s.value = ${json(scope)}; s.dispatchEvent(new Event('change', { bubbles: true }));
      a.value = ${json(ask2)}; a.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    return ev(`document.getElementById('lk-agent-panel').dataset.gate`);
  };
  /* 一次"提动作 + 说一句"的完整往返，返回**最后那条动作结果** */
  const round = async (toolJson, text) => { await setMock([toolJson, '好。']); await ask(text); return lastTool(); };

  /* ================= 阶段 1：逐次确认档（默认） ================= */
  const gateDefault = await ev(`document.getElementById('lk-agent-panel').dataset.gate`);

  const E1 = 'lk-e2e-删甲';
  const cards0 = await cards();
  await setMock([`{"tool":"create_entity","args":{"name":${json(E1)}}}`, '建好了。']);
  await ask('建一条设定 ' + E1 + '。');
  const sysOK = await ev(`(function () {
    const s = window.__lkSeen || [];
    const sys = s.length && s[s.length - 1][0] ? String(s[s.length - 1][0].content) : '';
    const need = ['delete_entity', 'delete_node', 'delete_timeline', 'delete_world', 'delete_file', 'create_world', 'create_timeline'];
    return { missing: need.filter((n) => sys.indexOf(n) < 0), discipline: sys.indexOf('只有创作者明说要删时才用') >= 0, trash: sys.indexOf('回收站') >= 0 };
  })()`);
  check('★1 七个新动作（5 删除 + 世界/时间线创建）都在系统提示里，且带着「只有创作者明说要删时才用」那条纪律',
    sysOK.missing.length === 0 && sysOK.discipline === true && sysOK.trash === true, sysOK);

  /* ★2 先建一条设定（后面 ★3 靠它验"点「应用」之前东西还在"） */
  const cardCreated = { cards: await cards(), title: await lastTitle() };
  await applyLast();
  const madeFile = await waitFor(() => hasVault(E1), true);
  check('★2 先建一条设定（提议卡片 → 点「应用」）⇒ vault 里真出现它的 .md',
    cardCreated.cards === cards0 + 1 && cardCreated.title.indexOf(E1) >= 0 && madeFile === true,
    { card: cardCreated, files: baseNames(vaultFiles()).slice(0, 10) });

  /* ★3 delete_entity：卡片 → 点之前 .md 还在 → 点之后离开库、进 .trash */
  const cards1 = await cards();
  const delE1 = await round(`{"tool":"delete_entity","args":{"name":${json(E1)}}}`, '把刚才那条设定删掉。');
  const delCard = { cards: await cards(), title: await lastTitle(), still: hasVault(E1), hint: delE1 };
  await applyLast();
  const goneE1 = await waitFor(() => hasVault(E1), false);
  const trashE1 = hasTrash(E1);
  const receiptE1 = await lastTool();
  check('★3 delete_entity：默认档出一张卡片、点「应用」之前 .md 还在；点完文件离开库、**进了 .trash 回收站**、回执说清可恢复',
    delCard.cards === cards1 + 1 && delCard.title.indexOf('删除设定') >= 0 && delCard.still === true &&
    goneE1 === true && trashE1 === true && receiptE1.indexOf('回收站') >= 0,
    { ...delCard, goneE1, trashE1, receipt: receiptE1, trash: baseNames(trashFiles()).slice(0, 6) });

  /* ★4 找不到目标 ⇒ 什么都不删（不出卡片 + 候选名单） */
  const cards2 = await cards();
  const missE = await round('{"tool":"delete_entity","args":{"name":"绝对不存在的条目名"}}', '把「绝对不存在的条目名」删掉。');
  check('★4 找不到那条设定 ⇒ **什么都没删**：不出卡片、动作结果里带「没找到叫」与人话说明',
    (await cards()) === cards2 && missE.indexOf('没找到叫') >= 0 && missE.indexOf('什么都没删') >= 0,
    { fed: missE, cards: await cards(), before: cards2 });

  /* ★5 create_node → 落盘 */
  const N1 = 'lk-e2e-删事件';
  await setMock([`{"tool":"create_node","args":{"title":${json(N1)},"year":999}}`, '建好了。']);
  await ask('在时间线上建一个事件 ' + N1 + '，年份 999。');
  const nodeCard0 = { cards: await cards(), title: await lastTitle() };
  await applyLast();
  const nodeMade = await waitFor(() => hasVault(N1), true);
  check('★5 create_node 走卡片真落盘（.md 出现）',
    nodeCard0.cards === cards2 + 1 && nodeCard0.title.indexOf(N1) >= 0 && nodeMade === true,
    { card: nodeCard0, has: hasVault(N1) });

  /* ★6 删事件：没那个标题 ⇒ 候选名单（含刚建的那个）
     ⚠️ 这条同时守着一个**真 bug**（首跑逮到的）：`num('')` 恰好返回 0 ⇒ 模型只说标题、不给年份时
     会被当成"年份 0"去过滤 ⇒ 明明有这个事件却回「没有叫…」。判据必须看**原始字符串**。 */
  const cards3 = await cards();
  const missN = await round('{"tool":"delete_node","args":{"title":"根本没有这个事件"}}', '删掉事件「根本没有这个事件」。');
  check('★6 时间线上没那个事件 ⇒ 什么都不删，且候选名单里列出它上面真有的（含刚建的 ' + N1 + '）',
    (await cards()) === cards3 && missN.indexOf('没有叫') >= 0 && missN.indexOf(N1) >= 0,
    { fed: missN, cards: await cards(), before: cards3 });

  /* ★7 delete_node：**只给标题、不给年份**也必须能找到（用户/模型最常见的写法） */
  const cardsN = await cards();
  const nodeHint = await round(`{"tool":"delete_node","args":{"title":${json(N1)}}}`, '把事件 ' + N1 + ' 删掉。');
  const nodeCard = { cards: await cards(), title: await lastTitle(), still: hasVault(N1), hint: nodeHint };
  await applyLast();
  const goneN = await waitFor(() => hasVault(N1), false);
  check('★7 delete_node：只给标题也能对上（★6 前面那个真 bug 的回归）、卡片写「删除事件：999 …」、点「应用」前 .md 还在、点完进回收站',
    nodeCard.cards === cardsN + 1 && nodeCard.title.indexOf('删除事件') >= 0 && nodeCard.still === true &&
    goneN === true && hasTrash(N1) === true && (await lastTool()).indexOf('回收站') >= 0,
    { ...nodeCard, goneN, trash: hasTrash(N1) });

  /* ★8 探路：不存在的时间线 ⇒ 列出这个世界真有的那几条 */
  const cardsT = await cards();
  const missT = await round('{"tool":"delete_timeline","args":{"name":"lk-e2e-不存在的时间线"}}', '删掉时间线 lk-e2e-不存在的时间线。');
  const tlList = (function () { const m = /它有的时间线：([^\n。]+)/.exec(missT); return m ? m[1].split('、').map((s) => s.trim()).filter(Boolean) : []; })();
  check('★8 没有那条时间线 ⇒ 什么都不删 + 把这个世界真有的时间线列出来',
    (await cards()) === cardsT && missT.indexOf('没有叫') >= 0 && tlList.length >= 1,
    { fed: missT, list: tlList, cards: await cards(), before: cardsT });

  /* ================= 阶段 2：「直接执行」档（用户 2026-10-12 亲口选的：删除直接生效） ================= */
  const gateAllow = await setGate('workspace', 'never');

  const E2 = 'lk-e2e-删乙';
  const cardsD = await cards();
  await round(`{"tool":"create_entity","args":{"name":${json(E2)}}}`, '建一条设定 ' + E2 + '。');
  const hasE2 = await waitFor(() => hasVault(E2), true);
  const delFed = await round(`{"tool":"delete_entity","args":{"name":${json(E2)}}}`, '删掉 ' + E2 + '。');
  const goneE2 = await waitFor(() => hasVault(E2), false);
  check('★9 ⭐「直接执行」档下删除**直接生效**（不出卡片；建也直接建）—— 这就是用户选的档',
    gateAllow === 'allow' && (await cards()) === cardsD && hasE2 === true && goneE2 === true &&
    delFed.indexOf('已删除设定') >= 0,
    { gateAllow, fed: delFed, note: await noteText(), cards: await cards(), before: cardsD });

  /* ================= 阶段 3：灵框库外的文件删（delete_file） ================= */
  const cardsF = await cards();
  const inVault = await round(`{"tool":"delete_file","args":{"path":${json(path.join(VAULT, 'lk-e2e-x.md'))}}}`, '把灵框库里的 lk-e2e-x.md 删掉。');
  check('★10 灵框库里的文件不能用 delete_file 删（会 store 与文件对不上）⇒ 拒绝并指路 delete_entity / delete_node',
    (await cards()) === cardsF && inVault.indexOf('不能') >= 0 && inVault.indexOf('delete_entity') >= 0,
    { fed: inVault, cards: await cards(), before: cardsF });

  const roDel = await round(`{"tool":"delete_file","args":{"path":${json(DEL_FILE)}}}`, '把 readonly 里的 lk-e2e-del.md 删掉。');
  check('★11 只读文件夹里的文件删不了 ⇒ 拒绝里说清「只读」、磁盘上文件还在',
    roDel.indexOf('只读') >= 0 && fs.existsSync(DEL_FILE) === true, { fed: roDel, exists: fs.existsSync(DEL_FILE) });

  const outDel = await round(`{"tool":"delete_file","args":{"path":${json(SECRET)}}}`, '把 outside 里的 secret.txt 删掉。');
  check('★12 白名单外的文件碰不到 ⇒ 拒绝 + 给出路（allow_folder 带 write:true）',
    outDel.indexOf('不在助手能碰的文件夹里') >= 0 && outDel.indexOf('allow_folder') >= 0 && fs.existsSync(SECRET) === true,
    { fed: outDel, exists: fs.existsSync(SECRET) });

  /* ★13 面板点成「可写」⇒ 直接执行档下 delete_file 真把文件移进**系统回收站** */
  await ev(`document.querySelector('#lk-agent-fs-list [data-fs-w="1"]')?.click(); true`);
  await sleep(500);
  const rootsNow = await api('roots()');
  const ro2 = (rootsNow.roots || []).find((r) => r.path.toLowerCase() === RO.toLowerCase());
  const cardsG2 = await cards();
  const fileFed = await round(`{"tool":"delete_file","args":{"path":${json(DEL_FILE)}}}`, '现在删掉 readonly 里的 lk-e2e-del.md。');
  const fileGone = await waitFor(() => fs.existsSync(DEL_FILE), false);
  check('★13 文件夹点成「可写」之后 delete_file 真删（主进程 `shell.trashItem` ⇒ **系统回收站**、可恢复），直接执行档下不出卡片',
    !!ro2 && ro2.write === true && (await cards()) === cardsG2 && fileGone === true && fileFed.indexOf('系统回收站') >= 0,
    { ro: ro2, fed: fileFed, exists: fs.existsSync(DEL_FILE) });

  /* ★14 目录一律不删（⚠️ 必须排在"改成可写"**之后**：只读那道门会先拦下来，看不到目录这条判据） */
  const dirDel = await round(`{"tool":"delete_file","args":{"path":${json(RO)}}}`, '把 readonly 这个文件夹删掉。');
  check('★14 目录一律不删 ⇒ 人话说清「只删文件」、目录还在',
    dirDel.indexOf('只删文件') >= 0 && fs.existsSync(RO) === true, { fed: dirDel });

  /* ★15 切回逐次确认档 ⇒ delete_file 出卡片，点「应用」之前文件还在 */
  const gateBack = await setGate('workspace', 'always');
  fs.writeFileSync(DEL_FILE2, '第二份待删草稿。\n', 'utf8');
  const cardsH = await cards();
  await round(`{"tool":"delete_file","args":{"path":${json(DEL_FILE2)}}}`, '把 lk-e2e-del2.md 删掉。');
  const del2Card = { cards: await cards(), title: await lastTitle(), still: fs.existsSync(DEL_FILE2) };
  await applyLast();
  const del2Gone = await waitFor(() => fs.existsSync(DEL_FILE2), false);
  const del2Fed = await lastTool();
  check('★15 逐次确认档下 delete_file 出卡片、点「应用」之前文件还在；点完才真删（回执说系统回收站）',
    gateBack === 'propose' && del2Card.cards === cardsH + 1 && del2Card.title.indexOf('删除文件') >= 0 &&
    del2Card.still === true && del2Gone === true && del2Fed.indexOf('系统回收站') >= 0,
    { ...del2Card, gateBack, gone: del2Gone, fed: del2Fed });

  /* ================= 阶段 4：世界 / 时间线（⚠️ 放最后：`create_world` 会把活动世界切走） ================= */
  const W2 = 'lk-e2e-世界';
  await setGate('workspace', 'never');   /* 直接执行档，省掉点击 */
  await setMock([`{"tool":"create_world","args":{"name":${json(W2)}}}`, '建好了。']);
  await ask('建一个新世界 ' + W2 + '。');
  const worldFed = await lastTool();
  await setMock([`{"tool":"create_timeline","args":{"name":"lk-e2e-线"}}`, '建好了。']);
  await ask('在这个新世界里建一条时间线 lk-e2e-线。');
  const tlFed = await lastTool();
  const cardsG = await cards();
  const guardT = await round('{"tool":"delete_timeline","args":{"name":"lk-e2e-线"}}', '把 lk-e2e-线 删掉。');
  check('★16 `create_world` / `create_timeline` 真能用（回执说清建在哪个世界），且**唯一那条时间线不许删**（护栏拦下、不出卡片）',
    worldFed.indexOf('已新建世界') >= 0 && worldFed.indexOf(W2) >= 0 && tlFed.indexOf('已') >= 0 &&
    tlFed.indexOf('lk-e2e-线') >= 0 && (await cards()) === cardsG && guardT.indexOf('唯一') >= 0,
    { worldFed, tlFed, fed: guardT, cards: await cards(), before: cardsG, gateDefault });

  /* ★17 直接执行档：删世界（连同它的时间线）⇒ 回执里说清删了哪个、几条时间线、可恢复 */
  const delW = await round(`{"tool":"delete_world","args":{"name":${json(W2)}}}`, '把世界 ' + W2 + ' 删掉。');
  check('★17 delete_world 真删（回执写明连同几条时间线 + 已进回收站）',
    delW.indexOf('已删除世界') >= 0 && delW.indexOf(W2) >= 0 && delW.indexOf('回收站') >= 0, { fed: delW });

  /* ★18 护栏：最后一个世界不删（先把多余的删掉，只剩一个时再删它 ⇒ 必须被拦） */
  let worlds = [];
  for (let i = 0; i < 4; i++) {
    const probe = await round('{"tool":"delete_world","args":{"name":"lk-e2e-没有这个世界"}}', '删掉世界 lk-e2e-没有这个世界。');
    const m = /现有的世界：([^\n。]+)/.exec(probe);
    worlds = m ? m[1].split('、').map((s) => s.trim()).filter(Boolean) : [];
    if (worlds.length <= 1) break;
    for (const n of worlds.slice(1)) await round(`{"tool":"delete_world","args":{"name":${json(n)}}}`, '删掉世界 ' + n + '。');
  }
  const cardsW = await cards();
  const guardW = worlds.length === 1
    ? await round(`{"tool":"delete_world","args":{"name":${json(worlds[0])}}}`, '把世界 ' + worlds[0] + ' 删掉。')
    : '（没能造出"只剩一个世界"的局面）';
  check('★18 ⭐兜底护栏：**最后一个世界不许删**（直接执行档也拦，卡片都不出）',
    worlds.length === 1 && (await cards()) === cardsW && guardW.indexOf('唯一') >= 0,
    { worlds, fed: guardW, cards: await cards(), before: cardsW });

  /* ⭐ 18d 拦下来必须给一条**出路**（片 1.1 的不变量）：光说"这条我不做"，模型下一轮只会回去跟创作者
     说"请你自己删" —— 拒绝的理由里得带着**照抄得出来**的下一步动作。
     （真机那次它自己猜出了"先建新世界再删"，但那是运气；现在这条 JSON 就写在回执里。） */
  check('★18d 「唯一世界 / 唯一时间线」的拒绝里带着出路（照抄得出来的 create_world / create_timeline）',
    guardW.indexOf('create_world') >= 0 && guardT.indexOf('create_timeline') >= 0,
    { world: guardW.slice(-90), tl: guardT.slice(-90) });

  /* ⭐ 18b **同一批里被护栏拒掉的写，不许吞掉后面的读** —— 用户 2026-10-11 实测的「怎么卡住了」：
     他一批提了 `delete_world`（唯一世界 ⇒ 被拒）+ `list_files` + `read_file`，同批的读从前被静默丢掉，
     界面上一点动静都没有；模型自己也把它解释成"整批跟着停"。 */
  const receipts = () => ev(`[...document.querySelectorAll('#lk-agent-msgs .lk-agent__tool')].map((b) => b.textContent)`);
  const before18b = (await receipts()).length;
  await setMock([`{"tool":"delete_world","args":{"name":${json(worlds[0])}}}\n{"tool":"list_nodes","args":{}}`, '好。']);
  await ask('把这个世界删掉，然后把事件列一遍。');
  const all18b = await receipts();
  const grow18b = all18b.length - before18b;
  const seenN18b = await ev(`(window.__lkSeen || []).length`);
  const last18b = all18b[all18b.length - 1] || '';
  check('★18b ⭐同批里被拒的写**不吞掉后面的读**（两个回执都在、读真跑出结果、不报「未执行」；写动作照旧"一轮就结束"）',
    worlds.length === 1 && grow18b === 2 && all18b.some((t) => t.indexOf('唯一') >= 0) &&
    last18b.indexOf('list_nodes') >= 0 && last18b.indexOf('时间线') >= 0 &&
    all18b.every((t) => t.indexOf('未执行') < 0) && seenN18b === 1,
    { grow18b, rounds: seenN18b, tail: all18b.slice(-2) });

  /* ⭐ 18c 真出了一张卡片时才必须收手（那一步还在等创作者点「应用」，数据没变，
     后面的动作等于建在沙上）—— 但要**留痕**，不是静默：一条「未执行」回执说清还剩哪几个动作，
     它进消息区也进历史（模型下一轮才知道自己还有活儿没干）。 */
  await setGate('workspace', 'always');   /* 逐次确认档：写动作一律先出卡片 */
  const cards18c = await cards();
  const before18c = (await receipts()).length;
  await setMock([`{"tool":"create_entity","args":{"name":"lk-e2e-未执行"}}\n{"tool":"list_nodes","args":{}}`, '好。']);
  await ask('建一条设定 lk-e2e-未执行，再把事件列一遍。');
  const all18c = await receipts();
  const trace18c = all18c[all18c.length - 1] || '';
  const ran18c = all18c.slice(before18c).some((t) => t.indexOf('list_nodes') >= 0 && t.indexOf('未执行') < 0);
  check('★18c 出卡片时后面的动作**不跑**（数据还没变），但留一条「未执行」回执说清还剩哪几个',
    (await cards()) === cards18c + 1 && all18c.length === before18c + 1 &&
    trace18c.indexOf('未执行') >= 0 && trace18c.indexOf('list_nodes') >= 0 && ran18c === false,
    { before: before18c, after: all18c.length, trace: trace18c, cards: await cards() });

  /* ---------- ★19 收尾 ---------- */
  const errs = await ev(`window.__errs`);
  check('★19 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`==== ${pass}/${results.length} PASS ====`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : String(e)));
  process.exit(2);
});
