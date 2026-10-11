/* agent-import.cjs —— 灵框助手的「批量导入手」（片 4，2026-10-15）：一次读一批 + 导入进度
 *
 * 用户原话：「**话说为什么他干活了这么久但是我一个节点都没看到**」。
 * 只读取证（`%APPDATA%\lingkuang\agent\sessions.json` 主会话 120 条）：模型要求过的动作 =
 * list_files **60** / read_file **29** / list_nodes 3 / list_entities 1，**写入类一次都没有**；
 * 它自己的计划是「先把内容全摸清，再一次性建条目」——而真能发给模型的只有最近十几条消息
 * ⇒ 读完后面的忘了前面的、回头重读，永远到不了"建"。
 *
 * 这份套件守的就是"搬库"这条路：
 *   ★2  一次 read_many 就把库里 5 个文本文件全读了（点文件与 node_modules 不算），并报进度
 *   ★2b 再读一次**不会重复读**（已读清单落盘 `userData/agent-imports.json`）
 *   ★3  超大文件按 6000 字截断，并明说"全文 N 字，只给了前 N 字"
 *   ★4  白名单**外**的路径读不到（请求里给的也不行），而且**给出路**（动作结果里带 allow_folder）
 *   ★5  import_status 报得出总数 / 已读 / 还剩
 *   ★6  助手真调 read_many：结果喂回**下一轮**、回执折起来（`FOLD_ALWAYS`）
 *   ★7  系统提示里有"读一批、建一批"的纪律（历次教训的沉淀）
 *   ★8  ⭐**读一批 → 立刻建一批**：条目真落进设定库（这才是用户要的东西）
 *
 * 前置（同一 pwsh 调用里做，再重启实例）：
 *   $env:LINGKUANG_TEST_DATA=<lk86>\worldbuilding.json; $env:LINGKUANG_VAULT=<lk86>\vault
 *   $env:LINGKUANG_TEST_USERDATA=<lk86>\userdata
 *   播种：node tools\e2e\reset-entity-vault.cjs（要一个带类型模板的世界，★8 用）+ seed-node.cjs
 * 夹具（library/ 素材库 + outside/ 白名单外的秘密文件）由本套件自己造；白名单靠 `fs:add-root` 带 path 加。
 * 跑：$env:LK_CDP_PORT=9500; node tools\e2e\agent-import.cjs
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

/* ---------- 夹具：白名单里的素材库 + 白名单外的"秘密" ---------- */
const TEST_DATA = process.env.LINGKUANG_TEST_DATA;
const VAULT = process.env.LINGKUANG_VAULT;
const USERDATA = process.env.LINGKUANG_TEST_USERDATA;
if (!TEST_DATA || !VAULT || !USERDATA) {
  console.log('FAIL 缺环境变量：需要 LINGKUANG_TEST_DATA / LINGKUANG_VAULT / LINGKUANG_TEST_USERDATA（见文件头"前置"）');
  process.exit(1);
}
const ROOT = path.dirname(TEST_DATA);
const LIB = path.join(ROOT, 'library');
const LIB2 = path.join(ROOT, 'library2');   /* 给"助手真调"那段用：一份**还没读过**的新素材库 */
const OUT = path.join(ROOT, 'outside');
const BIG_LINE = '北境冻原的素材行：雪原、断桥、霜精灵、白色的王。\n';
const BIG = '# 大文件\n' + BIG_LINE.repeat(300);      /* ≈ 8000+ 字，用来验截断 */
const BIG_MARK = '北境冻原的素材行';
const LIB_FILES = ['总览.md', '设定/第一世界/角色.md', '设定/第一世界/城市.md', '大文件.md', '笔记.txt'];
const LIB2_TEXT = '第二世界的第一份材料：浮空群岛与风之民。\n';
const LIB2_FILES = ['第二世界/索引.md', '第二世界/浮空群岛.md', '第二世界/风之民.md'];

function makeFixtures() {
  for (const f of LIB_FILES) {
    const p = path.join(LIB, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f === '大文件.md' ? BIG : `# ${f}\n这一份是素材库里的一份材料。\n`, 'utf8');
  }
  fs.writeFileSync(path.join(LIB, '.隐藏.md'), '点文件不该被算成素材。\n', 'utf8');
  fs.mkdirSync(path.join(LIB, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(LIB, 'node_modules', 'skip.md'), '依赖目录里的东西不该被算成素材。\n', 'utf8');
  fs.mkdirSync(path.join(LIB2, '第二世界'), { recursive: true });
  for (const f of LIB2_FILES) fs.writeFileSync(path.join(LIB2, f), `# ${f}\n` + LIB2_TEXT, 'utf8');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'secret.md'), '这是一份没交给助手的秘密素材。\n', 'utf8');
}

/* vault 里按名字找一份 .md（★8 验"条目真落盘"） */
function findVaultFile(name, depth = 0, dir = VAULT) {
  if (depth > 5) return false;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const d of items) {
    if (d.name === '.trash') continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) { if (findVaultFile(name, depth + 1, full)) return true; }
    else if (d.name === name) return true;
  }
  return false;
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
  /* ⚠️ 带超时：渲染进程里某句 await 永不落定（旧构建缺通道就是这种）时，
     宁可"这条 FAIL"也不要整套静静吊死在那儿。 */
  const ev = (expr) => Promise.race([
    send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => {
      const ex = r.result && r.result.exceptionDetails;
      if (ex) throw new Error('eval: ' + ((ex.exception && ex.exception.description) || ex.text));
      return r.result && r.result.result ? r.result.result.value : undefined;
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('eval 超时 15000ms: ' + String(expr).slice(0, 120))), 15000)),
  ]);
  /* 旧构建没有 readMany/importStatus ⇒ 抛异常会被咽掉、返回一条失败（A/B 跑旧构建时是一条条 FAIL，
     而不是脚本当场崩在第 3 行；★0 负责把那件事说出来） */
  const api = async (expr) => {
    try { return await ev(`window.lingkuangAPI.fs.${expr}`); }
    catch (e) { return { ok: false, error: '没有这个通道（旧构建）：' + (e && e.message ? e.message : String(e)) }; }
  };
  const json = (v) => JSON.stringify(v);
  /* ⚠️ 旧构建上没有这两个通道（★0 就是去说这件事的）：这里给"安全默认值"，
     让每一条断言各自 FAIL，而不是脚本在半路崩掉（A/B 跑旧构建时要能跑到最后一行）。 */
  const many = async (o) => {
    const r = await api(`readMany(${json(o)})`);
    return (r && r.ok) ? r : { ok: false, files: [], outside: [], already: [], total: 0, read: 0, remaining: 0, next: [], stopped: false };
  };
  const status = async (o) => {
    const r = await api(`importStatus(${json(o)})`);
    return (r && r.ok) ? r : { ok: false, total: 0, read: 0, remaining: 0, next: [] };
  };

  await sleep(1600);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);

  /* ---------- ★0 / ★1 通道与白名单 ---------- */
  const hasApi = await ev(`!!(window.lingkuangAPI && window.lingkuangAPI.fs && window.lingkuangAPI.fs.readMany && window.lingkuangAPI.fs.importStatus)`);
  check('★0 前置：preload 暴露了 readMany / importStatus（旧构建这里就是 false）', hasApi === true);

  const before = await api('roots()');
  for (const r of (before.roots || []).filter((r) => !r.builtin)) await api(`removeRoot(${json(r.path)})`);
  const added = await api(`addRoot({ path: ${json(LIB)} })`);
  await api(`addRoot({ path: ${json(LIB2)} })`);
  const libRoot = (added.roots || []).find((r) => r.path.toLowerCase() === LIB.toLowerCase());
  check('★1 素材库加进白名单了（默认只读）', added.ok === true && !!libRoot && libRoot.write === false,
    { ok: added.ok, write: libRoot && libRoot.write });

  /* ---------- ★2 一次读一批：5 个文本文件全读到，进度也报了 ---------- */
  const m1 = await many({ dir: LIB });
  const f1 = (m1 && m1.files) || [];
  check('★2 read_many 一次把库里 5 个文本文件全读了（点文件 / node_modules 不算），并报出进度',
    m1.ok === true && f1.length === 5 && m1.total === 5 && m1.read === 5 && m1.remaining === 0 && !!m1.next,
    { files: f1.length, total: m1.total, read: m1.read, remaining: m1.remaining });
  const names = f1.map((f) => f.name);
  check('★2a 每一份都给了相对路径（模型好认）与正文',
    f1.every((f) => !!f.rel && !!f.path) && names.indexOf('总览.md') >= 0 && names.indexOf('角色.md') >= 0,
    { names });
  const m2 = await many({ dir: LIB });
  check('★2b ⭐再读一次**不重复读**（已读清单落盘 agent-imports.json ⇒ 无限重读从机制上没了）',
    m1.ok === true && m2.files.length === 0, { second: m2.files.length });
  const m3 = await many({ dir: LIB, again: true });
  check('★2c again:true 才强制重读', m1.ok === true && m3.files.length === 5, { again: m3.files.length });

  /* ---------- ★3 超大文件截断 ---------- */
  const bigRes = await many({ dir: LIB, again: true, paths: [path.join(LIB, '大文件.md')] });
  const big = (bigRes.files || [])[0] || {};
  check('★3 超大文件按 6000 字截断、并标出全文多少字（别让模型以为读完了）',
    big.truncated === true && !!big.text && big.text.length === 6000 && big.chars > 7000,
    { truncated: big.truncated, gave: big.text && big.text.length, chars: big.chars });

  /* ---------- ★3b 字数预算：一批读不完就停下（下一批接着读） ---------- */
  const small = await many({ dir: LIB, again: true, chars: 3000 });
  const smallSum = (small.files || []).reduce((a, f) => a + f.text.length, 0);
  check('★3b chars 预算生效（一批没读完就停，标 stopped）',
    small.ok === true && small.files.length > 0 && small.files.length < 5 && smallSum <= 3000 && small.stopped === true,
    { files: small.files.length, sum: smallSum, stopped: small.stopped });

  /* ---------- ★4 白名单外：读不到，而且给出路 ---------- */
  const secPath = path.join(OUT, 'secret.md');
  const outp = await many({ paths: [secPath] });
  const leaked = JSON.stringify(outp || {}).indexOf('秘密素材') >= 0;
  check('★4 ⭐白名单外的路径读不到（请求里指名也不行），且不泄漏内容',
    outp.ok === true && outp.files.length === 0 && (outp.outside || []).length === 1 && leaked === false,
    { files: outp.files.length, outside: outp.outside, leaked });

  /* ---------- ★5 import_status ---------- */
  const st = await status({ path: LIB });
  check('★5 import_status 报得出总数 / 已读 / 还剩（不读正文）',
    st.ok === true && st.total === 5 && st.remaining === 0 && Array.isArray(st.next),
    { total: st.total, read: st.read, remaining: st.remaining });

  /* ---------- 面板 + 假引擎 ---------- */
  await ev(`document.querySelector('#lk-toolbar [data-tool="codex"]')?.click(); true`);
  await sleep(600);
  await ev(`(function () { const p = document.getElementById('lk-agent-panel'); if (p) document.getElementById('lk-agent-close')?.click(); return true; })()`);
  await sleep(300);
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
  await sleep(600);
  const setMock = async (queue) => ev(`window.__lkSeen = []; window.__lkMockQ = ${json(queue)}; window.__lkAgentMock = (m) => { window.__lkSeen.push(m); return window.__lkMockQ.length ? window.__lkMockQ.shift() : '好的。'; }; true`);
  const ask = async (text, wait = 2200) => {
    await ev(`(function () { const t = document.getElementById('lk-agent-input'); t.value = ${json(text)}; document.getElementById('lk-agent-send').click(); return true; })()`);
    await sleep(wait);
  };
  const setPerm = async (scope, ask2) => {
    await ev(`(function () {
      const s = document.getElementById('lk-agent-scope');
      const a = document.getElementById('lk-agent-ask');
      s.value = ${json(scope)}; s.dispatchEvent(new Event('change', { bubbles: true }));
      a.value = ${json(ask2)}; a.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(250);
  };
  const toolCount = () => ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__tool').length`);
  const lastTool = () => ev(`(function () { const t = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__tool')]; if (!t.length) return null; const e = t[t.length - 1]; return { tag: e.tagName, open: e.open === true, sum: (e.querySelector('summary') || {}).textContent || '', body: e.textContent.slice(0, 400) }; })()`);
  const fed = () => ev(`(function () { const s = window.__lkSeen || []; const m = s[s.length - 1] || []; return m.map((x) => String(x.content || '')).join('\\n'); })()`);
  const sysPrompt = () => ev(`(function () { const s = window.__lkSeen || []; const m = s[0] || []; return m.map((x) => String(x.content || '')).join('\\n'); })()`);

  check('★6 前置：助手面板开出来了', (await ev(`!!document.getElementById('lk-agent-panel')`)) === true);
  await ev(`document.getElementById('lk-agent-mode-agent').click(); true`);
  await sleep(300);
  await setPerm('workspace', 'never');   /* 直接执行档：★8 要看"条目真落盘" */

  /* ---------- ★6 助手真调 read_many + 结果喂回下一轮 ----------
     ⚠️ 这里换用 LIB2（一份**还没读过**的素材库）：LIB 在前面那段直调里已经全读进已读清单了，
     拿它测"读到内容"只会读到"已经全读过了"（第一版就是这么假红的）。 */
  const rmArg = JSON.stringify({ tool: 'read_many', args: { dir: LIB2 } });
  await setMock([rmArg, '素材我拿到手了。']);
  const tBefore = await toolCount();
  await ask('把那个素材库读进来。');
  const r6 = {
    receipts: (await toolCount()) - tBefore,
    body: ((await lastTool()) || {}).body || '',
    sum: ((await lastTool()) || {}).sum || '',
    tag: ((await lastTool()) || {}).tag || '',
    fedAll: await fed(),
  };
  check('★6 ⭐助手真调 read_many，回执里带进度（这一批几个 / 还剩多少）',
    r6.receipts >= 1 && r6.body.indexOf('批量读取') >= 0 && r6.body.indexOf('还剩') >= 0,
    { receipts: r6.receipts, head: r6.body.slice(0, 90) });
  check('★6b read_many 的回执**折起来**了（清单/批量类一律折）',
    r6.tag === 'DETAILS' && r6.sum.indexOf('read_many') >= 0, { tag: r6.tag, sum: r6.sum.slice(0, 80) });
  check('★6c 动作结果真喂回**下一轮**（素材正文出现在喂给模型的消息里）',
    r6.fedAll.indexOf('浮空群岛与风之民') >= 0 && r6.fedAll.indexOf('【动作结果：read_many】') >= 0,
    { len: r6.fedAll.length, hasWord: r6.fedAll.indexOf('浮空群岛与风之民') >= 0 });
  check('★6d 回执末尾给的是"立刻建条目"的下一步（不是"继续读"）',
    r6.body.indexOf('立刻建条目') >= 0 || r6.body.indexOf('create_entity') >= 0, { tail: r6.body.slice(-90) });
  const st2 = await status({ path: LIB2 });
  check('★6e 助手读过的那一批立刻进了已读清单（下次不会再读它）',
    st2.ok === true && st2.total === 3 && st2.read === 3 && st2.remaining === 0,
    { total: st2.total, read: st2.read, remaining: st2.remaining });

  /* ---------- ★7 系统提示里的纪律 ---------- */
  const sys = await sysPrompt();
  check('★7 ⭐系统提示里有"读一批、建一批"的纪律（历次"读半天不建一条"的教训沉淀）',
    sys.indexOf('read_many') >= 0 && sys.indexOf('import_status') >= 0 &&
    sys.indexOf('绝不要') >= 0 && sys.indexOf('读一批') >= 0,
    { hasReadMany: sys.indexOf('read_many') >= 0, hasRule: sys.indexOf('绝不要') >= 0 });
  check('★7b 系统提示里列了白名单文件夹（模型知道能碰哪儿）',
    sys.indexOf('【你能碰的文件夹】') >= 0 && sys.indexOf(LIB) >= 0,
    { hasBlock: sys.indexOf('【你能碰的文件夹】') >= 0, hasLib: sys.indexOf(LIB) >= 0 });

  /* ---------- ★8 ⭐读一批 → 立刻建一批：条目真落盘 ---------- */
  const NAME_A = '导入测试甲';
  const NAME_B = '导入测试乙';
  await setMock([
    rmArg,
    JSON.stringify({ tool: 'create_entity', args: { entities: [{ name: NAME_A }, { name: NAME_B }] } }),
    '这两条条目建好了。',
  ]);
  const t8 = await toolCount();
  await ask('读进来之后立刻把里面的设定建条目。', 3200);
  /* ⚠️ 判据读 **DOM 里最后那条回执**，不读底部提示（第七十七轮踩过：拿喂回去的消息当判据，
     读到的是创作者那句原话）。⭐ 第八十八轮起落盘之后**会**再叫一轮，那条【动作结果】确实进了
     发送窗口 —— 但判据留在 DOM 上更稳：它不随"这一轮跑了几次请求"变化。 */
  const t8last = (await lastTool()) || {};
  const r8 = { receipts: (await toolCount()) - t8, body: t8last.body || '' };
  let onDisk = false;
  for (let i = 0; i < 20 && !onDisk; i++) { onDisk = findVaultFile(NAME_A + '.md') && findVaultFile(NAME_B + '.md'); if (!onDisk) await sleep(200); }
  /* ⭐ 第八十八轮（用户 2026-10-16：「有时候会断」）：写动作**不再结束整轮** —— 从前这里写完
     `create_entity` 就收手（整轮结束、模型再没被叫过），于是"读完一批立刻建条目"这种循环
     每一步都要创作者再催一句；真机会话就是停在一条 `【动作结果：create_timeline】` 上。
     ⇒ 旧构建这条只有 2 次请求（第 3 条回复白排在队列里没人取）。 */
  const r8b = {
    seen: await ev(`(window.__lkSeen || []).length`),
    fed: await fed(),
    last: await ev(`(function () { const b = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')]; return b.length ? b[b.length - 1].textContent : ''; })()`),
  };
  check('★8 ⭐「读一批 → 立刻建一批」走通了：条目真落进设定库（这是用户要的结果）',
    r8.receipts >= 2 && r8.body.indexOf('已新建') >= 0 && onDisk === true,
    { receipts: r8.receipts, disk: onDisk, hasNote: r8.body.indexOf('已新建') >= 0, tail: r8.body.slice(-80) });
  /* ⭐ 落盘之后**接着跑**：模型被再叫了一轮，且那一轮真的读到了【动作结果：create_entity】 */
  check('★8b ⭐写完接着跑（不再等他催）：落盘那一步的回执真喂回了**下一轮**，模型的下一句也照常显示',
    r8b.seen >= 3 && r8b.fed.indexOf('【动作结果：create_entity】') >= 0 && r8b.last.indexOf('这两条条目建好了') >= 0,
    { seen: r8b.seen, hasReceipt: r8b.fed.indexOf('【动作结果：create_entity】') >= 0, last: r8b.last.slice(0, 40) });

  /* ---------- ★9 import_status 动作也走通 ---------- */
  await setMock([JSON.stringify({ tool: 'import_status', args: { dir: LIB } }), '进度看过了。']);
  const t9 = await toolCount();
  await ask('还剩多少没读？');
  const r9 = { receipts: (await toolCount()) - t9, body: ((await lastTool()) || {}).body || '' };
  check('★9 助手真调 import_status，回执报出进度',
    r9.receipts >= 1 && r9.body.indexOf('导入进度') >= 0, { receipts: r9.receipts, head: r9.body.slice(0, 80) });

  /* ---------- ★5b ⭐「正在导入的那个文件夹」会粘住（第八十八轮，用户 2026-10-16：「有时候会断」）----------
     真机取证：他给助手加了 `D:\Desktop` 之后，**不给 dir 的 read_many** 把整个桌面的文本都算进范围
     （144 → 199），连高数作业和分数表都当成素材读了进来。范围该跟着"他正在搬的那个库"走。
     ⚠️ 这条**故意放在最后**：旧构建下它会把 LIB2 也读进已读清单，连带把前面的 ★6/★6c 带红
     （第一版放在 ★5 后面就是 19/23，多出来的 2 条是连带红，不是真的坏了）。 */
  const bareStatus = await status({});
  const bareMany = await many({});
  const scopeNow = String((bareStatus && bareStatus.scope) || '').toLowerCase();
  check('★5b ⭐不给 dir 也留在"正在导入的那个文件夹"里（不会把整个桌面都算进范围）',
    st.ok === true && bareStatus.ok === true && bareStatus.total === st.total &&
    scopeNow.indexOf('library') >= 0 && scopeNow.indexOf('library2') < 0 && (bareMany.files || []).length === 0,
    { scope: bareStatus.scope, bareTotal: bareStatus.total, libTotal: st.total, bareFiles: (bareMany.files || []).length });

  /* ---------- ★10 无异常 ---------- */
  const errs = await ev(`window.__errs || []`);
  check('★10 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, { errs });

  try { w.close(); } catch { /* 无所谓 */ }
  const okN = results.filter(Boolean).length;
  console.log(`\n${okN}/${results.length} PASS`);
  process.exit(okN === results.length ? 0 : 2);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
