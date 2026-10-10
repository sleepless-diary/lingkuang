/* agent-fs.cjs —— 灵框助手的「文件夹手」（片 1，2026-09-28）：灵框**外**文件的读写
 *
 * 不变量（这份套件守的就是这五条）：
 *   ① 只读三件（list_files / read_file / search_files）随问随走，结果真的喂回**下一轮**；
 *   ② 白名单**外**一律碰不到 —— 包括 `..` 绕路（realpath 之后比前缀，判在主进程）；
 *   ③ 标「只读」的文件夹写不进去（主进程是最后一道门，绕过 UI 也写不进去）；
 *   ④ 灵框库**以外**的写：即便权限是「直接执行」也仍然出一张提议卡片，点「应用」才落盘；
 *   ⑤ 灵框库**里面**的写按平常闸门走（「直接执行」= 不点也落盘）—— needsConfirm 只管灵框库外。
 *
 * ⭐ 最要紧的几条断言：
 *   ★7  —— `..\outside\secret.txt` 照样被拒（前缀比较之前先 realpath）；
 *   ★13 —— 「直接执行」档下灵框外的写**仍然**出卡片（用户选的档：写灵框外一律逐次确认）；
 *   ★9b —— 白名单真的进了系统提示（模型知道它能碰哪些文件夹）；
 *   ★17 —— **拦下来必须给模型一条出路**（动作结果里带 `allow_folder`）—— 用户 2026-09-29 实测：
 *          助手被拦下只会说「请确认路径是否正确」，他因此以为"这 AI 读写不了灵框外"；
 *   ★19 —— 助手自己提的 `allow_folder` 卡片，点「应用」才真加进白名单，而且是**只读**（默认档）。
 *
 * 前置（同一 pwsh 调用里做，再重启实例）：
 *   $env:LINGKUANG_TEST_DATA=<lk-fs>\worldbuilding.json; $env:LINGKUANG_VAULT=<lk-fs>\vault
 *   $env:LINGKUANG_TEST_USERDATA=<lk-fs>\userdata
 * 夹具（readonly/ 素材 + outside/ 白名单外的秘密文件）由本套件自己造；白名单靠 `fs:add-root` 带 path
 * 加进来。⭐ 带 path 的加目录**现在正式运行也认**（走的是"助手提卡片、创作者点「应用」"那条路，
 * 人还在环里，见 main.js 那段注释）；不给 path 的那条（系统对话框）永远是 UI 的正路。
 * 跑：$env:LK_CDP_PORT=9500; node tools\e2e\agent-fs.cjs
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

/* ---------- 夹具：白名单里的只读素材 + 白名单外的"秘密" ---------- */
const TEST_DATA = process.env.LINGKUANG_TEST_DATA;
const VAULT = process.env.LINGKUANG_VAULT;
const USERDATA = process.env.LINGKUANG_TEST_USERDATA;
if (!TEST_DATA || !VAULT || !USERDATA) {
  console.log('FAIL 缺环境变量：需要 LINGKUANG_TEST_DATA / LINGKUANG_VAULT / LINGKUANG_TEST_USERDATA（见文件头"前置"）');
  process.exit(1);
}
const ROOT = path.dirname(TEST_DATA);                 /* %TEMP%\lk-fs */
const RO = path.join(ROOT, 'readonly');               /* 白名单里、只读 */
const OUT = path.join(ROOT, 'outside');               /* 白名单外 */
const VAULT_FILE = path.join(VAULT, 'lk-e2e-hand.md');
const SECRET = '这是一份没交给助手的秘密素材。';
const RO_WRITE = path.join(RO, 'ro-write.md');
const RO_TEXT = '第一行：北境雪原的设定草稿。\n第二行：霜精灵住在冻原。\n第三行：雪原上有一座断桥。\n';

function makeFixtures() {
  fs.mkdirSync(path.join(RO, 'sub'), { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(RO, 'note.md'), RO_TEXT, 'utf8');
  fs.writeFileSync(path.join(RO, 'list.txt'), '角色表\n霜精灵\n雪原猎人\n', 'utf8');
  fs.writeFileSync(path.join(RO, 'sub', 'deep.md'), '# 深层素材：雪原上断桥的另一端\n', 'utf8');
  fs.writeFileSync(path.join(OUT, 'secret.txt'), SECRET, 'utf8');
  for (const p of [RO_WRITE, VAULT_FILE]) { try { fs.unlinkSync(p); } catch { /* 本来就没有 */ } }
}

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
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const ex = r.result && r.result.exceptionDetails;
    if (ex) throw new Error('eval: ' + ((ex.exception && ex.exception.description) || ex.text));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  /* 渲染层直调文件通道（断言主进程那三道门用；UI 只负责画与增删）。
     ⚠️ 旧构建没有 `lingkuangAPI.fs` ⇒ 这里抛异常会被咽掉、返回一条失败 —— 这样 A/B 跑旧构建时
     是"一条条 FAIL"而不是脚本当场崩在第 3 行（★0 负责把那件事说出来）。 */
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

  /* ---------- ★0 前置：通道在、白名单先清干净再只加一个只读文件夹 ---------- */
  const hasApi = await ev(`!!(window.lingkuangAPI && window.lingkuangAPI.fs && window.lingkuangAPI.fs.roots)`);
  check('★0 前置：preload 暴露了 fs 通道（旧构建这里就是 false）', hasApi === true);

  const before = await api('roots()');
  for (const r of (before.roots || []).filter((r) => !r.builtin)) await api(`removeRoot(${json(r.path)})`);
  const added = await api(`addRoot({ path: ${json(RO)} })`);
  const addedRo = (added.roots || []).find((r) => r.path.toLowerCase() === RO.toLowerCase());
  const vaultRoot = (added.roots || []).find((r) => r.builtin);
  check('★1 加进来的是**只读**、内置那条 vault 是可写',
    added.ok === true && !!addedRo && addedRo.write === false && !!vaultRoot && vaultRoot.write === true,
    { ro: addedRo, vault: vaultRoot });

  /* ---------- ★2 面板上画出来了（与权限并排那块「文件夹」） ---------- */
  await ev(`document.querySelector('#lk-toolbar [data-tool="codex"]')?.click(); true`);
  await sleep(900);
  /* 上一份套件可能把面板留着开着 —— 先关掉，保证下面 Ctrl+K 是**开** */
  await ev(`(function () { const b = document.getElementById('lk-agent-close'); if (b) b.click(); return true; })()`);
  await sleep(400);
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
  await sleep(700);
  /* 面板默认聊天模式；本套件测 Agent 模式的动作（与 agent-tools.cjs 一样的理由） */
  await ev(`document.getElementById('lk-agent-mode-agent')?.click(); true`);
  await sleep(300);

  const panel = await ev(`({
    open: !!document.getElementById('lk-agent-panel'),
    summary: (document.getElementById('lk-agent-fs-summary') || {}).textContent || '',
    rows: [...document.querySelectorAll('#lk-agent-fs-list .lk-agent__fs-item')].map((r) => ({
      name: (r.querySelector('.lk-agent__fs-name') || {}).textContent || '',
      tags: [...r.querySelectorAll('.lk-agent__fs-tag')].map((t) => t.textContent),
      btn: (r.querySelector('.lk-agent__fs-btn') || {}).textContent || '',
      hasX: !!r.querySelector('[data-fs-del]'),
    })),
  })`);
  check('★2 面板「文件夹」块列出两条：内置 vault（带「灵框库」标签、没有 ×）+ 只读那条（按钮写「只读」、有 ×）',
    panel.open === true && panel.rows.length === 2 &&
    panel.rows[0].tags.indexOf('灵框库') >= 0 && panel.rows[0].hasX === false &&
    panel.rows[1].btn === '只读' && panel.rows[1].hasX === true &&
    panel.summary.indexOf('2 个') >= 0,
    panel);

  /* ---------- ★3 / ★4 / ★5 只读三件在真磁盘上做真事 ---------- */
  const listing = await api(`list(${json(RO)})`);
  const names = (listing.entries || []).map((e) => e.name);
  const sub = (listing.entries || []).find((e) => e.name === 'sub');
  const noteEntry = (listing.entries || []).find((e) => e.name === 'note.md');
  check('★3 list_files：真列出素材（含子目录 sub 与 note.md，大小 > 0）',
    listing.ok === true && names.indexOf('note.md') >= 0 && names.indexOf('list.txt') >= 0 &&
    !!sub && sub.dir === true && !!noteEntry && noteEntry.size > 0,
    { names, root: listing.root });

  const read = await api(`read(${json(path.join(RO, 'list.txt'))})`);
  check('★4 read_file：读到的是磁盘上的原文',
    read.ok === true && String(read.text).indexOf('雪原猎人') >= 0 && read.size > 0,
    { size: read.size, text: read.text });

  const search = await api(`search(${json(RO)}, '雪原')`);
  const hit = (search.hits || [])[0];
  check('★5 search_files：给「文件:行号:那一行」，含子目录里的文件',
    search.ok === true && (search.hits || []).length >= 3 && !!hit &&
    typeof hit.file === 'string' && hit.line >= 1 && String(hit.text).indexOf('雪原') >= 0 &&
    (search.hits || []).some((h) => h.file.indexOf('sub') >= 0),
    { hits: search.hits, scanned: search.scanned });

  /* ---------- ★6 / ★7 白名单以外的路一律堵死（★7 = `..` 绕路） ---------- */
  const outside = await api(`read(${json(path.join(OUT, 'secret.txt'))})`);
  check('★6 白名单外的文件读不到（主进程拒，不是 UI 拦）',
    outside.ok === false && String(outside.error).indexOf('不在助手能看的文件夹里') >= 0, outside);

  const traversal = await api(`read(${json(path.join(RO, '..', 'outside', 'secret.txt'))})`);
  const traverseList = await api(`list(${json(path.join(RO, '..'))})`);
  check('★7 ⭐ `..` 绕路也读不到（realpath 之后比前缀 ⇒ 归一化挡在前面）',
    traversal.ok === false && String(traversal.error).indexOf('不在助手能看的文件夹里') >= 0 &&
    traverseList.ok === false,
    { traversal, traverseList });

  /* ---------- ★8 只读文件夹写不进去（主进程最后一道门，绕过 UI 也一样） ---------- */
  const roWrite = await api(`write(${json(RO_WRITE)}, '不该写进去的一行', 'overwrite')`);
  check('★8 只读文件夹写不进去，且提示里说清了"只读"',
    roWrite.ok === false && String(roWrite.error).indexOf('只读') >= 0 && !fs.existsSync(RO_WRITE), roWrite);

  /* ---------- ★9 助手真调只读文件动作：结果喂回下一轮、不出卡片 ---------- */
  const setMock = async (queue) => ev(`window.__lkSeen = []; window.__lkMockQ = ${json(queue)}; window.__lkAgentMock = (m) => { window.__lkSeen.push(m); return window.__lkMockQ.length ? window.__lkMockQ.shift() : '好的。'; }; true`);
  const ask = async (text) => {
    await ev(`(function () { const t = document.getElementById('lk-agent-input'); t.value = ${json(text)}; document.getElementById('lk-agent-send').click(); return true; })()`);
    await sleep(1100);
  };
  const cards = () => ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__prop').length`);
  const noteText = () => ev(`(document.getElementById('lk-agent-note') || {}).textContent || ''`);
  const lastTool = () => ev(`(function () { const t = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__tool')]; return t.length ? t[t.length - 1].textContent : ''; })()`);

  const cards0 = await cards();
  await setMock([`{"tool":"read_file","args":{"path":${json(path.join(RO, 'note.md'))}}}`, '第 1 行是北境雪原的设定草稿。']);
  await ask('把那份草稿读给我听。');
  const readRun = { tool: await lastTool(), cards: await cards() };
  check('★9 只读文件动作真跑起来（结果进了【动作结果】），且**不出**提议卡片',
    String(readRun.tool).indexOf('北境雪原') >= 0 && readRun.cards === cards0, { ...readRun, before: cards0 });

  const sysHasFs = await ev(`(function () {
    const seen = window.__lkSeen || [];
    const sys = seen.length && seen[seen.length - 1][0] ? String(seen[seen.length - 1][0].content) : '';
    return { hasBlock: sys.indexOf('【你能碰的文件夹】') >= 0, hasRo: sys.indexOf(${json(RO)}) >= 0, hasVault: sys.indexOf(${json(VAULT)}) >= 0, readonlyWord: sys.indexOf('只读') >= 0,
             canOutside: sys.indexOf('文件你照样能读能写') >= 0, escape: sys.indexOf('allow_folder') >= 0 };
  })()`);
  check('★9b ⭐ 白名单真的进了系统提示（清单 + 只读标记 + "你不是只能动灵框里的数据" + 清单外走 allow_folder）',
    sysHasFs.hasBlock && sysHasFs.hasRo && sysHasFs.hasVault && sysHasFs.readonlyWord && sysHasFs.canOutside && sysHasFs.escape, sysHasFs);

  /* ---------- ★10 助手往只读文件夹写：拒绝、不出版卡片 ---------- */
  const cardsA = await cards();
  await setMock([`{"tool":"write_file","args":{"path":${json(RO_WRITE)},"text":"助手想往里写"}}`, '那我先不写。']);
  await ask('把这段记到 readonly 里。');
  const denied = { note: await noteText(), cards: await cards(), exists: fs.existsSync(RO_WRITE) };
  check('★10 写只读文件夹被拒（提示里说「只读」）、不出版卡片、磁盘上什么都没多',
    denied.note.indexOf('只读') >= 0 && denied.cards === cardsA && denied.exists === false,
    { ...denied, before: cardsA });

  /* ---------- ★11 面板上把它点成「可写」（UI 那条路） ---------- */
  await ev(`document.querySelector('#lk-agent-fs-list [data-fs-w="1"]')?.click(); true`);
  await sleep(500);
  const afterToggle = await ev(`({
    roots: null,
    btn: (document.querySelector('#lk-agent-fs-list [data-fs-w]') || {}).textContent || '',
    note: (document.getElementById('lk-agent-note') || {}).textContent || '',
  })`);
  const rootsNow = await api('roots()');
  const ro2 = (rootsNow.roots || []).find((r) => r.path.toLowerCase() === RO.toLowerCase());
  check('★11 面板点一下就能把文件夹改成「可写」（主进程真存下了）',
    !!ro2 && ro2.write === true && afterToggle.btn === '可写' && afterToggle.note.indexOf('可写') >= 0,
    { ro: ro2, ...afterToggle });

  /* ---------- ★13 / ★12 「直接执行」档：灵框库外的写**仍然**要点头 ---------- */
  await ev(`(function () {
    const s = document.getElementById('lk-agent-scope');
    const a = document.getElementById('lk-agent-ask');
    s.value = 'workspace'; s.dispatchEvent(new Event('change', { bubbles: true }));
    a.value = 'never'; a.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  const gate = await ev(`document.getElementById('lk-agent-panel').dataset.gate`);

  const cardsB = await cards();
  await setMock([`{"tool":"write_file","args":{"path":${json(RO_WRITE)},"text":"断桥的另一端是一座灯塔。"}}`, '写好了。']);
  await ask('把这条记到 readonly 里的 ro-write.md。');
  const outsideCard = {
    gate, cards: await cards(), exists: fs.existsSync(RO_WRITE),
    title: await ev(`(function () { const p = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__prop-h')]; return p.length ? p[p.length - 1].textContent : ''; })()`),
    detail: await ev(`(function () { const p = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__prop-d')]; return p.length ? p[p.length - 1].textContent : ''; })()`),
  };
  check('★13 ⭐「直接执行」档下，灵框库外的写**仍然**出提议卡片（点应用之前磁盘上没有这个文件）',
    outsideCard.gate === 'allow' && outsideCard.cards === cardsB + 1 && outsideCard.exists === false &&
    outsideCard.title.indexOf('ro-write.md') >= 0 && outsideCard.detail.indexOf('灵框库外') >= 0,
    { ...outsideCard, before: cardsB });

  await ev(`(function () { const b = [...document.querySelectorAll('#lk-agent-msgs [data-prop-ok]')]; if (b.length) b[b.length - 1].click(); return true; })()`);
  await sleep(900);
  const applied = {
    exists: fs.existsSync(RO_WRITE),
    text: fs.existsSync(RO_WRITE) ? fs.readFileSync(RO_WRITE, 'utf8') : '',
    /* ⭐ 用户 2026-10-10：「确认窗口在确认后不会消失，会随着AI的下一条回答出现」⇒ 卡片点完就退场，
       不再留在原地标 `is-settled`（判据 = 计数回到点它之前）。 */
    cards: await cards(),
    note: await noteText(),
  };
  check('★12 点「应用」之后才真落盘（内容逐字一致 + 卡片当场退场 + 回执说清写到哪儿）',
    applied.exists === true && applied.text === '断桥的另一端是一座灯塔。' &&
    applied.cards === cardsB && applied.note.indexOf('已写入') >= 0,
    { ...applied, before: cardsB });

  /* ---------- ★14 灵框库**里面**的写按平常闸门走：直接执行 = 不点也落盘 ---------- */
  const cardsC = await cards();
  await setMock([`{"tool":"write_file","args":{"path":${json(VAULT_FILE)},"text":"# 灵框库里的手记\\n"}}`, '记在灵框库里了。']);
  await ask('在灵框库里记一条手记。');
  const inVault = { cards: await cards(), exists: fs.existsSync(VAULT_FILE), text: fs.existsSync(VAULT_FILE) ? fs.readFileSync(VAULT_FILE, 'utf8') : '' };
  check('★14 灵框库里的写不受"逐次确认"管（needsConfirm 只管灵框库外）',
    inVault.cards === cardsC && inVault.exists === true && inVault.text.indexOf('灵框库里的手记') >= 0,
    { ...inVault, before: cardsC });

  /* ---------- ★15 面板上移除文件夹 ---------- */
  await ev(`document.querySelector('#lk-agent-fs-list [data-fs-del]')?.click(); true`);
  await sleep(500);
  const removed = await ev(`({
    rows: document.querySelectorAll('#lk-agent-fs-list .lk-agent__fs-item').length,
    summary: (document.getElementById('lk-agent-fs-summary') || {}).textContent || '',
  })`);
  const rootsEnd = await api('roots()');
  check('★15 面板上能去掉那个文件夹（清单回到只剩内置 vault）',
    removed.rows === 1 && (rootsEnd.roots || []).length === 1 && !!rootsEnd.roots[0].builtin &&
    removed.summary.indexOf('1 个') >= 0,
    { ...removed, roots: rootsEnd.roots });

  /* ---------- ★17 拦下来必须给**出路**（allow_folder） ----------
     用户 2026-09-29 实测踩到的坑：他把桌面文件夹路径丢给助手，助手被白名单拦下之后只会说
     「请确认路径是否正确」，他因此以为"这 AI 读写不了灵框外"。⇒ 动作结果里必须有那条路。 */
  const cardsD = await cards();
  await setMock([`{"tool":"list_files","args":{"path":${json(OUT)}}}`, '那我先问问你愿不愿意把它交给我。']);
  await ask('看看 outside 里有什么。');
  const hint = await ev(`(function () {
    const seen = window.__lkSeen || [];
    /* ⚠️ 要看的是**喂回给模型的那条动作结果**（最后一次调用里 messages 的**最后一条**），
       不是 messages[0]（那是系统提示 —— 里面也有 'allow_folder' 字样，会把这条件变成假绿）。 */
    const arr = seen.length ? seen[seen.length - 1] : [];
    const lastMsg = arr.length ? String(arr[arr.length - 1].content || '') : '';
    return { hasAsk: lastMsg.indexOf('allow_folder') >= 0, hasWhy: lastMsg.indexOf('不在助手能看的文件夹里') >= 0, cards: document.querySelectorAll('#lk-agent-msgs .lk-agent__prop').length };
  })()`);
  check('★17 ⭐ 白名单外的读被拦下时，动作结果给了模型一条出路（让创作者点一张 allow_folder 卡片）',
    hint.hasAsk && hint.hasWhy && hint.cards === cardsD, { ...hint, before: cardsD });

  /* ---------- ★18 助手**自己**要一个文件夹 ⇒ 出一张卡片，点之前不生效 ----------
     ⚠️ 这里**故意递一个文件路径**（模型被 `read_file` 拦下时多半就这么递）：授权的粒度是文件夹，
     所以卡片上出现的必须是它**所在的文件夹**，并写明"你要的是文件、交出来的是文件夹"。 */
  await setMock([`{"tool":"allow_folder","args":{"path":${json(path.join(OUT, 'secret.txt'))}}}`, '那我等你点一下。']);
  await ask('把 outside 交给我吧。');
  const askCard = await ev(`(function () {
    const cards = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__prop')];
    const c = cards[cards.length - 1];
    return c ? { title: (c.querySelector('.lk-agent__prop-h') || {}).textContent || '', text: c.textContent || '', ok: !!c.querySelector('[data-prop-ok]') } : null;
  })()`);
  const rootsAsk = await api('roots()');
  check('★18 `allow_folder` 出一张「把文件夹交给助手」的卡片（**递文件路径也会退到它所在的文件夹**）、点「应用」之前白名单一点没变',
    !!askCard && askCard.title.indexOf('把文件夹交给助手') >= 0 && askCard.text.indexOf('只读') >= 0 &&
    askCard.text.indexOf(OUT) >= 0 && askCard.text.indexOf('secret.txt') >= 0 &&
    (rootsAsk.roots || []).length === 1,
    { card: askCard, roots: rootsAsk.roots });

  /* ---------- ★19 点「应用」⇒ 真加进白名单（**默认只读**）、面板那块当场重画 ---------- */
  await ev(`(function () { const b = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__prop [data-prop-ok]')].pop(); if (b) b.click(); return true; })()`);
  await sleep(700);
  const rootsGranted = await api('roots()');
  const granted = (rootsGranted.roots || []).find((r) => r.path.toLowerCase() === OUT.toLowerCase());
  const panelAfterGrant = await ev(`({
    rows: document.querySelectorAll('#lk-agent-fs-list .lk-agent__fs-item').length,
    summary: (document.getElementById('lk-agent-fs-summary') || {}).textContent || '',
    cards: document.querySelectorAll('#lk-agent-msgs .lk-agent__prop').length,
  })`);
  check('★19 ⭐ 点「应用」才真加进来，而且是**只读**（默认档）；面板的「文件夹」块跟着重画、卡片当场退场',
    !!granted && granted.write === false && granted.builtin !== true &&
    panelAfterGrant.rows === 2 && panelAfterGrant.summary.indexOf('2 个') >= 0 &&
    panelAfterGrant.cards === cardsD,
    { granted, ...panelAfterGrant, before: cardsD });

  /* ---------- ★20 已经交过的文件夹不再重复要（幂等，且**不出**卡片） ---------- */
  const cardsE = await cards();
  await setMock([`{"tool":"allow_folder","args":{"path":${json(OUT)}}}`, '哦对，它已经在了。']);
  await ask('再把 outside 交给我。');
  const againNote = await noteText();
  const rootsAgain = await api('roots()');
  check('★20 已经交给助手的文件夹不会再要一张卡片（提示里说清"早就交给你了"）',
    (await cards()) === cardsE && againNote.indexOf('早就交给你了') >= 0 && (rootsAgain.roots || []).length === 2,
    { note: againNote, cards: await cards(), before: cardsE });

  /* ---------- ★16 收尾 ---------- */
  const errs = await ev(`window.__errs`);
  check('★16 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`==== ${pass}/${results.length} PASS ====`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : String(e)));
  process.exit(2);
});
