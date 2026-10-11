/* agent-dsml.cjs —— 助手：**DeepSeek 的原生函数调用标记（DSML）**也要认，不许当正文发出来
 *
 * 用户 2026-10-11 原话：「又被当正文发出来了」。
 * 真因：云端 `deepseek-flash` 不看我们那套「整条回复只写一行 JSON」的协议，按它训练时的格式吐
 * （下面是从他真实会话 `%APPDATA%\lingkuang\agent\sessions.json` 里抓到的原样，竖线是**全角 U+FF5C**）：
 *
 *   ＜｜｜DSML｜｜ calls＞
 *   ＜｜｜DSML｜｜ invoke name="read_file"＞
 *   ＜｜｜DSML｜｜ parameter name="args" string="false"＞{"path":"…"}＜/｜｜DSML｜｜ parameter＞
 *   ＜/｜｜DSML｜｜ invoke＞          ……（★一次连吐好几个 invoke）
 *
 * 老解析器只认 `{…}` ⇒ **一个动作都没跑**，整坨标记还被当正文画到创作者脸上。
 * 这份套件守三件事：
 *   ① 这种标记里的动作要**真跑**（read_file ×3 全执行、结果喂回下一轮）；
 *   ② 标记**不许出现在任何 AI 气泡里**（历史里画成「用到动作：…」那一行）—— 流式途中也不许闪；
 *   ③ 认不出的标记仍走「回头纠正一次」，不糊到脸上。
 *
 * 前置（同一 pwsh 调用里做，再重启实例）：
 *   $env:LINGKUANG_TEST_DATA=<root>\worldbuilding.json; $env:LINGKUANG_VAULT=<root>\vault
 *   $env:LINGKUANG_TEST_USERDATA=<root>\userdata
 *   node tools\e2e\reset-entity-vault.cjs; node tools\e2e\seed-node.cjs
 * 跑：$env:LK_CDP_PORT=9500; node tools\e2e\agent-dsml.cjs
 */
const PORT = process.env.LK_CDP_PORT || '9500';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(n, ok, extra) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);
}

/* DSML 标记生成器：`｜｜DSML｜｜` 用 \uFF5C\uFF5C 拼出来（全角竖线，真机就是它；
   源码里直接写全角字符容易在别处被转成半角，用转义更稳）。 */
const BAR = '\uFF5C\uFF5CDSML\uFF5C\uFF5C';
const tag = (s) => '<' + BAR + ' ' + s + '>';
const ctag = (s) => '</' + BAR + ' ' + s + '>';
/** 一次吐一串调用（真机形状）：每个 invoke 里一个 `parameter name="args"` 装着整个 JSON */
function dsmlBlock(calls) {
  return tag('calls') + '\n' + calls.map((c) =>
    tag('invoke name=' + JSON.stringify(c.name)) + '\n' +
    tag('parameter name="args" string="false"') + JSON.stringify(c.args) + ctag('parameter') + '\n' +
    ctag('invoke')).join('\n') + '\n';
}
/** 摊平形态（`parameter name="path"` 直接给主参数）—— 顺带证明参数形状也容错 */
function dsmlFlat(name, params) {
  return tag('invoke name=' + JSON.stringify(name)) + '\n' +
    Object.keys(params).map((k) =>
      tag('parameter name=' + JSON.stringify(k) + ' string="true"') + params[k] + ctag('parameter')).join('\n') + '\n' +
    ctag('invoke');
}

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
  /* ⚠️ 每个 eval 都带超时：渲染进程里那句 `await` 万一永不落定（比如某个 IPC 卡住），
     整套会静静吊死、一个字都看不到（这一轮真踩到了 —— 加超时至少能看见卡在哪一步）。 */
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
  check('★0 前置：设定库与助手按钮在、面板还没开', pre.tools.includes('agent') && pre.panel === false && pre.rows === 1, pre);

  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
  await sleep(500);

  /* 假引擎（函数形态，顺手把喂进去的 messages 存进 `window.__lkSeen`）。
     ⚠️ 函数**返回** `{chunks:[…], gap}` 也能走流式（见 `src/ui/agent-model.ts`）。 */
  const setMock = async (queue) => ev(`window.__lkSeen = []; window.__lkMockQ = ${JSON.stringify(queue)}; window.__lkAgentMock = (m) => { window.__lkSeen.push(m); return window.__lkMockQ.length ? window.__lkMockQ.shift() : '好的。'; }; true`);
  const ask = async (text, wait = 1400) => {
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
  const noteText = () => ev(`(document.getElementById('lk-agent-note') || {}).textContent || ''`);
  const lastBubble = () => ev(`(function () { const b = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')]; return b.length ? b[b.length - 1].textContent : ''; })()`);
  /* ⭐ 关键判据：**任何 AI 气泡里都不许出现这坨标记**（历史里它该被画成「用到动作」那一行） */
  const markupInBubbles = () => ev(`(function () {
    const bad = [];
    [...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')].forEach(function (b) {
      const t = b.textContent || '';
      if (t.indexOf('DSML') >= 0 || t.indexOf('invoke') >= 0 || t.indexOf('parameter') >= 0) bad.push(t.slice(0, 160));
    });
    return { n: bad.length, sample: bad[0] || '' };
  })()`);
  const fed = () => ev(`(function () { const s = window.__lkSeen || []; const m = s[s.length - 1] || []; return m.map((x) => String(x.content || '')).join('\\n'); })()`);

  check('★1 面板开出来了（Ctrl+K）', (await ev(`!!document.getElementById('lk-agent-panel')`)) === true);
  await ev(`document.getElementById('lk-agent-mode-agent').click(); true`);
  await sleep(300);
  await setPerm('workspace', 'always');

  /* ---------- ① ⭐ 真机原样的 DSML：一串 read_file 要全跑、不许进气泡 ---------- */
  const made = await ev(`(async function () {
    const rs = ((await window.lingkuangAPI.fs.roots()) || {}).roots || [];
    const v = rs.find((r) => r.builtin) || rs[0];
    if (!v) return { err: '没有可写根' };
    const base = String(v.path).replace(/[\\\\/]+$/, '');
    const out = [];
    for (let i = 1; i <= 3; i++) {
      const p = base + '/lk-e2e-dsml-' + i + '.md';
      await window.lingkuangAPI.fs.write(p, '第 ' + i + ' 份材料：这一份是给 DSML 套件用的。', 'overwrite');
      out.push(p.replace(/\\\\/g, '/'));
    }
    return { files: out };
  })()`);
  const files = made.files || [];
  const vaultDir = String(files[0] || '').replace(/\/[^/]+$/, '');
  const outerDir = vaultDir.replace(/\/[^/]+$/, '');

  const block3 = dsmlBlock([
    { name: 'read_file', args: { path: files[0] } },
    { name: 'read_file', args: { path: files[1] } },
  ]) + dsmlFlat('read_file', { path: files[2] }); /* 第三个用摊平形态 */
  await setMock([block3, '三份材料我都看过了。']);
  const tBefore = await toolCount();
  await ask('把桌面那三份材料读一下。');
  const r2 = {
    calls: await callTexts(),
    receipts: (await toolCount()) - tBefore,
    bubbles: await markupInBubbles(),
    last: await lastBubble(),
    prop: (await props()).length,
  };
  /* 真机上这一个 invoke 序列本来是"0 个动作 + 整坨标记糊脸"。现在：三个动作真跑、气泡干净 */
  check('★2 ⭐DSML 标记里的动作**真跑**（read_file ×3 全执行，参数带 args 与摊平两种形状）',
    r2.receipts === 3 && r2.calls.some((c) => c.indexOf('read_file ×3') >= 0) && r2.prop === 0,
    { receipts: r2.receipts, calls: r2.calls, prop: r2.prop });
  check('★2b ⭐那坨标记**一个字都没进 AI 气泡**（用户 2026-10-11：「又被当正文发出来了」）',
    r2.bubbles.n === 0, r2.bubbles);

  /* ---------- ② 结果要真喂回下一轮（只画在屏幕上不算数） ---------- */
  const f3 = await fed();
  check('★3 三个结果都作为「动作结果」喂回了下一轮（模型据此作答）',
    (f3.match(/【动作结果：read_file】/g) || []).length === 3 && r2.last.indexOf('三份材料我都看过了') >= 0,
    { fed: f3.slice(-260), last: r2.last });

  /* ---------- ③ ⭐ 流式途中也不许闪出来（第一片只到 `＜｜｜DSML｜｜ cal`） ---------- */
  const stream = dsmlFlat('read_file', { path: files[0] });
  const parts = [stream.slice(0, 9), stream.slice(9, 40), stream.slice(40)];
  await setMock([{ chunks: parts, gap: 120 }, '看完了。']);
  /* ⭐ 快照带上"这是谁的气泡 / 第几张 / 是不是活气泡" —— 漏了一张时才知道该修哪儿，而不是只看到一个数字 */
  await ev(`(function () {
    window.__lkSnaps = []; window.__lkSnapT0 = Date.now();
    window.__lkSnapT = setInterval(function () {
      const all = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__bubble')];
      all.forEach(function (b, i) {
        window.__lkSnaps.push({
          live: b.classList.contains('is-live'), idx: i, n: all.length,
          dt: Date.now() - window.__lkSnapT0,
          cls: (b.parentElement && b.parentElement.className) || '?',
          t: b.textContent || '', h: (b.innerHTML || '').slice(0, 150),
        });
      });
    }, 70);
    return true;
  })()`);
  const t4 = await toolCount();
  await ask('再看一眼第一份。', 2600);
  await ev(`(function () { clearInterval(window.__lkSnapT); return true; })()`);
  const s4 = {
    first: parts[0],
    leaks: await ev(`(window.__lkSnaps || []).filter(function (x) { return /DSML|invoke|parameter/.test(x.t); }).length`),
    bad: await ev(`(window.__lkSnaps || []).filter(function (x) { return /DSML|invoke|parameter/.test(x.t); }).slice(0, 3)`),
    snaps: await ev(`(window.__lkSnaps || []).length`),
    placeholder: await ev(`(window.__lkSnaps || []).filter(function (x) { return x.t.indexOf('正在整理成动作') >= 0; }).length`),
    receipts: (await toolCount()) - t4,
    bubbles: await markupInBubbles(),
  };
  check('★4 ⭐流式吐标记时气泡改说「正在整理成动作…」—— 途中一次都没把标记画出来',
    s4.leaks === 0 && s4.snaps > 4 && s4.receipts === 1 && s4.bubbles.n === 0,
    { firstChunk: s4.first, leaks: s4.leaks, bad: s4.bad, snaps: s4.snaps, placeholder: s4.placeholder, receipts: s4.receipts });

  /* ---------- ④ 写入动作（DSML 形态）照样出提议卡片，点之前不许落盘 ---------- */
  /* ⚠️ `fs.add-root` 的正规形状是 `{path}`（`preload.js` 直接把 payload 递过去、主进程读 `payload.path`）。
     早先这里递的是裸字符串 ⇒ 主进程当成"没给 path"、去弹系统文件对话框 ⇒ 隐藏窗口里那个对话框永远挂着、
     这个 await 永不落定（首跑就是卡死在这儿、被 15s eval 超时逮住）。 */
  await ev(`(async function () {
    await window.lingkuangAPI.fs.addRoot({ path: ${JSON.stringify(outerDir)} });
    await window.lingkuangAPI.fs.setRootWrite(${JSON.stringify(outerDir)}, true);
    return true;
  })()`);
  const outPath = outerDir + '/lk-e2e-dsml-out.md';
  await setMock([dsmlBlock([{ name: 'write_file', args: { path: outPath, text: '这是 DSML 套件写下来的。' } }]), '写好了。']);
  await ask('把结论写到那个文件里。');
  const readOut = () => ev(`(async function () {
    const r = await window.lingkuangAPI.fs.read(${JSON.stringify(outPath)});
    return { ok: r && r.ok === true, err: r && r.error ? String(r.error).slice(0, 80) : '' };
  })()`);
  const s5 = {
    props: await props(),
    before: await readOut(),
    bubbles: await markupInBubbles(),
  };
  check('★5 DSML 形态的写入照样是**卡片**（不是直接落盘、也不是一段文字）',
    s5.props.length === 1 && s5.props[0].settled === false && s5.before.ok === false && s5.bubbles.n === 0,
    s5);
  await ev(`document.querySelector('#lk-agent-msgs [data-prop-ok="0"]').click(); true`);
  await sleep(1200);
  const after = await readOut();
  check('★5b 点「应用」才真落盘（灵框库外的写仍要创作者点头）', after.ok === true, { after: after, path: outPath });

  /* ---------- ⑤ 认不出的 DSML ⇒ 仍走「回头纠正一次」，不糊到脸上 ---------- */
  await setMock([dsmlBlock([{ name: 'fly_to_moon', args: { x: 1 } }]), '我直接说人话：这个我做不到。']);
  await ask('帮我飞到月亮上。');
  /* ⚠️ 别拿底部那行提示当判据：纠正那一轮的 `host.note('…格式不对…')` 会被**紧接着**的收尾
     `host.note(r.model === 'mock' ? '' : …)` 冲成空串（首跑就是这么假红的）。
     真凭据是**喂回去的那条** `【格式提醒】` —— 它进历史、进下一轮的 messages。 */
  const s6 = {
    fed: await fed(),
    note: await noteText(),
    last: await lastBubble(),
    bubbles: await markupInBubbles(),
    calls: await callTexts(),
  };
  check('★6 认不出的标记（工具名不认识）走「格式提醒」纠正一次，标记同样不进气泡',
    s6.fed.indexOf('【格式提醒】') >= 0 && s6.last.indexOf('我直接说人话') >= 0 && s6.bubbles.n === 0 &&
    !s6.calls.some((c) => c.indexOf('fly_to_moon') >= 0),
    { fed: s6.fed.slice(-200), last: s6.last, bubbles: s6.bubbles.n, calls: s6.calls });

  /* 收尾：把这一套件自己加的根撤掉（免得住进隔离 userdata 里影响下一套件） */
  await ev(`(async function () { await window.lingkuangAPI.fs.removeRoot(${JSON.stringify(outerDir)}); return true; })()`);
  await sleep(300);
  const errs = await ev(`window.__errs`);
  check('★7 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`==== ${pass}/${results.length} PASS ====`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : String(e)));
  process.exit(2);
});
