/* agent-vendor.cjs —— 助手：**厂商塞进来的 `<system_warning>` 噪音**要剥掉、里面的动作要照跑
 *
 * 用户 2026-10-12 原话（贴的就是这一坨，问的是「不能兼容一次多个动作执行吗」）：
 *
 *   <system_warning>工具调用被拒绝：一次只能输出一个动作。</system_warning>
 *
 *   {"tool":"list_files","args":{"path":"D:\\Desktop\\世界观资料整理\\设定\\第一世界\\角色"}}
 *
 * 真因（从 `%APPDATA%\lingkuang\agent\sessions.json` 主会话 #119 取的原样，全史只此一条）：
 *   ① **那句话不是灵框写的**（全仓 grep `system_warning` 零命中）—— 云端 `deepseek-flash` 想一次提
 *      多个动作时走了它自己那套**原生**函数调用，厂商接口一次只放一个 ⇒ 当场拒掉、把警告塞进
 *      `message.content`；模型于是退化成"一次一个"，创作者看着就是"says 一次只能一个、然后卡住"。
 *   ② 旧代码里这段被 `toolProse()` 当正文画进气泡，而后面**那一条正经 JSON 反而没被认**
 *      （`splitJsonSpansAfterProse()` 要求"散文 + ≥2 个对象"，只有一个 ⇒ 当聊天，动作被静默吃掉）。
 *
 * 这份套件守四件事：
 *   ① 警告 + **1 个**动作 ⇒ 动作照跑、警告一个字不进气泡；
 *   ② 警告 + **N 个**动作 ⇒ **N 个全跑**（这就是「一次多个动作」的正规写法，也是用户那句疑问的答案）；
 *   ③ 只剩警告、没有动作 ⇒ 走「格式提醒」纠正一次，同样不糊到脸上；
 *   ④ 流式途中警告不许闪；系统提示里不再有"整条回复只写一行 JSON"这种自相矛盾的话。
 *
 * 前置（同一 pwsh 调用里做，再重启实例）：
 *   $env:LINGKUANG_TEST_DATA=<root>\worldbuilding.json; $env:LINGKUANG_VAULT=<root>\vault
 *   $env:LINGKUANG_TEST_USERDATA=<root>\userdata
 *   node tools\e2e\reset-entity-vault.cjs; node tools\e2e\seed-node.cjs
 * 跑：$env:LK_CDP_PORT=9500; node tools\e2e\agent-vendor.cjs
 */
const PORT = process.env.LK_CDP_PORT || '9500';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(n, ok, extra) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);
}

/* 真机原样（竖线是全角也只是它自带的花样；这里只有这一句是关键字） */
const WARN = '<system_warning>工具调用被拒绝：一次只能输出一个动作。</system_warning>';
const J = (tool, args) => JSON.stringify({ tool, args });

async function main() {
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
  /* ⚠️ 每个 eval 都带超时：渲染进程里那句 `await` 万一永不落定，整套会静静吊死（第七十三轮踩过） */
  const ev = async (expr, ms = 15000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
      sleep(ms).then(() => { throw new Error('eval 超时 ' + ms + 'ms: ' + String(expr).slice(0, 70)); }),
    ]);
    const ex = r.result && r.result.exceptionDetails;
    if (ex) throw new Error('eval: ' + ((ex.exception && ex.exception.description) || ex.text));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  /* ---------- 打开工作台 + 助手面板 ---------- */
  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(`document.querySelector('#lk-toolbar [data-tool="codex"]').click(); true`);
  await sleep(1200);
  await ev(`document.querySelector('#cx-list [data-cx-id]').click(); true`);
  await sleep(600);
  /* 自己把起点摆正：上一份套件可能把助手面板留着开着 —— 那样下面 Ctrl+K 反而会把它关掉 */
  await ev(`(function () { const b = document.getElementById('lk-agent-close'); if (b) b.click(); return true; })()`);
  await sleep(400);

  const pre = await ev(`({
    tools: [...document.querySelectorAll('#lk-toolbar .lk-tool-btn')].map((b) => b.dataset.tool),
    panel: !!document.getElementById('lk-agent-panel'),
    rows: document.querySelectorAll('#cx-list [data-cx-id]').length,
  })`);
  check('★0 前置：设定库与助手按钮在、面板还没开', pre.tools.includes('agent') && pre.panel === false && pre.rows >= 1, pre);

  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
  await sleep(500);

  /* 假引擎（函数形态，顺手把喂进去的 messages 存进 `window.__lkSeen`）。
     ⚠️ 函数**返回** `{chunks:[…], gap}` 也能走流式（见 `src/ui/agent-model.ts`）。 */
  const setMock = async (queue) => ev(`window.__lkSeen = []; window.__lkMockQ = ${JSON.stringify(queue)}; window.__lkAgentMock = (m) => { window.__lkSeen.push(m); return window.__lkMockQ.length ? window.__lkMockQ.shift() : '好的。'; }; true`);
  const ask = async (text, wait = 1500) => {
    await ev(`(function () { const t = document.getElementById('lk-agent-input'); t.value = ${JSON.stringify(text)}; document.getElementById('lk-agent-send').click(); return true; })()`);
    await sleep(wait);
  };
  const setPerm = async (scope, ask2) => {
    await ev(`(function () {
      const s = document.getElementById('lk-agent-scope');
      const a = document.getElementById('lk-agent-ask');
      s.value = ${JSON.stringify(scope)}; s.dispatchEvent(new Event('change', { bubbles: true }));
      a.value = ${JSON.stringify(ask2)}; a.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(250);
  };
  const callTexts = () => ev(`[...document.querySelectorAll('#lk-agent-msgs .lk-agent__call')].map((c) => c.textContent)`);
  const toolCount = () => ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__tool').length`);
  const props = () => ev(`[...document.querySelectorAll('#lk-agent-msgs .lk-agent__prop')].map((p) => ({ settled: p.classList.contains('is-settled'), h: (p.querySelector('.lk-agent__prop-h') || {}).textContent || '' }))`);
  const lastBubble = () => ev(`(function () { const b = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')]; return b.length ? b[b.length - 1].textContent : ''; })()`);
  /* ⭐ 关键判据：**任何 AI 气泡里都不许出现那句厂商警告**。
     ⚠️ `【格式提醒】`（我们**自己**发给模型的那条纠正）里可以提到这类字样 —— 它是给人看的说明，
     不是模型吐出来的噪音 ⇒ 扫的时候把机器消息摘掉（首跑就是这么假红了 37 张）。 */
  const noiseInBubbles = () => ev(`(function () {
    const bad = [];
    [...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')].forEach(function (b) {
      const t = b.textContent || '';
      if (t.indexOf('【格式提醒】') >= 0 || t.indexOf('【动作结果') >= 0) return;
      if (t.indexOf('system_warning') >= 0 || t.indexOf('工具调用被拒绝') >= 0 || t.indexOf('一次只能输出一个动作') >= 0) bad.push(t.slice(0, 160));
    });
    return { n: bad.length, sample: bad[0] || '' };
  })()`);
  const fed = () => ev(`(function () { const s = window.__lkSeen || []; const m = s[s.length - 1] || []; return m.map((x) => String(x.content || '')).join('\\n'); })()`);
  /* 系统提示 = 假引擎收到的第一条 system 消息（`runTurn` 每轮现拼） */
  const sysOf = () => ev(`(function () { const m = (window.__lkSeen || [])[0] || []; return m.filter(function (x) { return x.role === 'system'; }).map(function (x) { return String(x.content || ''); }).join('\\n'); })()`);

  check('★1 面板开出来了（Ctrl+K）', (await ev(`!!document.getElementById('lk-agent-panel')`)) === true);
  await ev(`document.getElementById('lk-agent-mode-agent').click(); true`);
  await sleep(300);
  await setPerm('workspace', 'always');

  /* ---------- 材料：灵框库里造三个目录 + 三份文件 ---------- */
  const made = await ev(`(async function () {
    const rs = ((await window.lingkuangAPI.fs.roots()) || {}).roots || [];
    const v = rs.find((r) => r.builtin) || rs[0];
    if (!v) return { err: '没有可写根' };
    const base = String(v.path).replace(/[\\\\/]+$/, '');
    const dirs = [];
    for (let i = 1; i <= 3; i++) {
      const p = base + '/lk-e2e-vendor/d' + i + '/f' + i + '.md';
      await window.lingkuangAPI.fs.write(p, '第 ' + i + ' 份材料。', 'overwrite');
      dirs.push(p.replace(/\\\\/g, '/').replace(/\\/f\\d\\.md$/, ''));
    }
    return { dirs: dirs, f1: base.replace(/\\\\/g, '/') + '/lk-e2e-vendor/d1/f1.md', base: base.replace(/\\\\/g, '/') };
  })()`);
  const dirs = made.dirs || [];
  const outPath = String(made.base || '') + '/lk-e2e-vendor/out.md';

  /* ---------- ① 警告 + **1 个**动作：动作照跑、警告不进气泡 ---------- */
  await setMock([WARN + '\n\n' + J('read_file', { path: made.f1 }), '第一份我看过了。']);
  const t2 = await toolCount();
  await ask('读一下第一份材料。');
  const r2 = {
    receipts: (await toolCount()) - t2,
    calls: await callTexts(),
    bubbles: await noiseInBubbles(),
    last: await lastBubble(),
  };
  check('★2 ⭐警告后面那一条 JSON **照跑**（旧代码里它被静默吃掉：卡片都没有、动作一个没执行）',
    r2.receipts === 1 && r2.calls.some((c) => c.indexOf('read_file') >= 0) && r2.last.indexOf('第一份我看过了') >= 0,
    { receipts: r2.receipts, calls: r2.calls, last: r2.last });
  check('★2b ⭐那句 `<system_warning>…</system_warning>` **一个字都没进 AI 气泡**（用户 2026-10-12 看到的正是它）',
    r2.bubbles.n === 0, r2.bubbles);

  /* ---------- ② ⭐警告 + **3 个**动作：三个全跑（＝「不能兼容一次多个动作执行吗」的正面回答） ---------- */
  const three = WARN + '\n' + dirs.map((d) => J('list_files', { path: d })).join('\n');
  await setMock([three, '三个目录都看过了。']);
  const t3 = await toolCount();
  await ask('把这三个目录一次列出来。', 2200);
  const r3 = {
    receipts: (await toolCount()) - t3,
    calls: await callTexts(),
    bubbles: await noiseInBubbles(),
    fed: await fed(),
  };
  check('★3 ⭐同一条回复里**三个动作全跑**（`用到动作：list_files ×3` + 三条回执，灵框本来就支持一次多个）',
    r3.receipts === 3 && r3.calls.some((c) => c.indexOf('list_files ×3') >= 0) && (r3.fed.match(/【动作结果：list_files】/g) || []).length === 3,
    { receipts: r3.receipts, calls: r3.calls, fedReceipts: (r3.fed.match(/【动作结果：list_files】/g) || []).length });
  check('★3b 三个动作的结果都喂回了下一轮（模型据此作答，且警告没进气泡）',
    (await lastBubble()).indexOf('三个目录都看过了') >= 0 && r3.bubbles.n === 0, { bubbles: r3.bubbles, last: await lastBubble() });

  /* ---------- ③ 只剩警告、没有动作 ⇒ 走「格式提醒」纠正一次，同样不糊到脸上 ---------- */
  await setMock([WARN, J('read_file', { path: made.f1 }), '重发好了，第一份我看过了。']);
  const t4 = await toolCount();
  await ask('随便做点什么。', 2000);
  const r4 = {
    receipts: (await toolCount()) - t4,
    fed: await fed(),
    bubbles: await noiseInBubbles(),
  };
  /* ⚠️ 别拿底部那行提示当判据（它会被收尾的 `host.note('')` 冲掉）——真凭据是喂回去的 `【格式提醒】` */
  check('★4 只剩警告（没有可跑动作）⇒ 走「格式提醒」纠正一次，纠正后那个动作跑起来了、警告仍不进气泡',
    r4.fed.indexOf('【格式提醒】') >= 0 && r4.receipts >= 1 && r4.bubbles.n === 0,
    { fed: r4.fed.slice(-200), receipts: r4.receipts, bubbles: r4.bubbles });

  /* ---------- ④ ⭐流式途中也不许闪（第一片只到 `<system_wa`） ---------- */
  const stream = WARN + '\n\n' + J('read_file', { path: made.f1 });
  const parts = [stream.slice(0, 10), stream.slice(10, 40), stream.slice(40)];
  await setMock([{ chunks: parts, gap: 120 }, '看完了。']);
  await ev(`(function () {
    window.__lkSnaps = []; window.__lkSnapT0 = Date.now();
    window.__lkSnapT = setInterval(function () {
      const all = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__bubble')];
      all.forEach(function (b) {
        window.__lkSnaps.push({ live: b.classList.contains('is-live'), dt: Date.now() - window.__lkSnapT0, t: b.textContent || '' });
      });
    }, 70);
    return true;
  })()`);
  const t5 = await toolCount();
  await ask('再看一眼第一份。', 2600);
  await ev(`(function () { clearInterval(window.__lkSnapT); return true; })()`);
  const s5 = {
    first: parts[0],
    leaks: await ev(`(window.__lkSnaps || []).filter(function (x) { return !/【格式提醒】|【动作结果/.test(x.t) && /system_warning|工具调用被拒绝|一次只能输出一个动作/.test(x.t); }).length`),
    bad: await ev(`(window.__lkSnaps || []).filter(function (x) { return !/【格式提醒】|【动作结果/.test(x.t) && /system_warning/.test(x.t); }).slice(0, 3)`),
    snaps: await ev(`(window.__lkSnaps || []).length`),
    placeholder: await ev(`(window.__lkSnaps || []).filter(function (x) { return x.t.indexOf('正在整理成动作') >= 0; }).length`),
    receipts: (await toolCount()) - t5,
    bubbles: await noiseInBubbles(),
  };
  check('★5 ⭐流式吐警告时气泡改说「正在整理成动作…」—— 途中一次都没把警告画出来',
    s5.leaks === 0 && s5.snaps > 4 && s5.receipts === 1 && s5.bubbles.n === 0,
    { firstChunk: s5.first, leaks: s5.leaks, bad: s5.bad, snaps: s5.snaps, placeholder: s5.placeholder, receipts: s5.receipts });

  /* ---------- ⑤ 写入（警告形态）照样是提议卡片：点之前磁盘上没有 ---------- */
  await setMock([WARN + '\n' + J('write_file', { path: outPath, text: '这是厂商噪音套件写下来的。' }), '写好了。']);
  await ask('把结论写到那个文件里。');
  const readOut = () => ev(`(async function () {
    const r = await window.lingkuangAPI.fs.read(${JSON.stringify(outPath)});
    return { ok: r && r.ok === true, err: r && r.error ? String(r.error).slice(0, 80) : '' };
  })()`);
  const s6 = { props: await props(), before: await readOut(), bubbles: await noiseInBubbles() };
  check('★6 警告形态的写入照样是**卡片**（不是直接落盘、也不是一段文字）',
    s6.props.length === 1 && s6.props[0].settled === false && s6.before.ok === false && s6.bubbles.n === 0, s6);
  await ev(`document.querySelector('#lk-agent-msgs [data-prop-ok="0"]').click(); true`);
  await sleep(1200);
  check('★6b 点「应用」才真落盘', (await readOut()).ok === true, { path: outPath });

  /* ---------- ⑥ ⭐系统提示：不再自相矛盾（旧版写着"整条回复只写一行 JSON"，模型真机为此纠结过） ---------- */
  const sys = await sysOf();
  const s7 = {
    oneLine: sys.indexOf('整条回复只写一行 JSON') >= 0,
    multiLine: sys.indexOf('一行一个 JSON') >= 0 || sys.indexOf('一行一个纯 JSON') >= 0,
    multiWord: sys.indexOf('一次多个动作') >= 0,
    counterExample: sys.indexOf('不要写成') >= 0,
    nativeWarn: sys.indexOf('别用你厂商那套原生函数调用') >= 0,
    len: sys.length,
  };
  check('★7 ⭐系统提示不再自相矛盾：写明"一次多个动作 = 一行一个 JSON"，且不再有"整条回复只写一行 JSON"',
    s7.oneLine === false && s7.multiLine === true && s7.multiWord === true && s7.counterExample === true && s7.nativeWarn === true,
    s7);

  const errs = await ev(`window.__errs`);
  check('★8 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`==== ${pass}/${results.length} PASS ====`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : String(e)));
  process.exit(2);
});
