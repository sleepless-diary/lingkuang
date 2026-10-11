/* agent-toolfold.cjs —— 助手：**「一行一个动作 + 尾巴上还有一句话」不许被当正文** + 连续多条结果收成一块
 *
 * 用户 2026-10-13 原话：「**依旧被当成正文了，对了，还有连续多条工具调用做一下折叠吧**」。
 * 他贴回的是真机上那一条回复（从 `%APPDATA%\lingkuang\agent\sessions.json` 主会话 `#119` 取的，1095 字）：
 *
 *   {"tool":"list_files","args":{"path":"D:/Desktop/世界观资料整理/设定/第一世界"}}
 *   {"tool":"read_file","args":{"path":"…/科技/科技.md"}}      ……共 14 行
 *
 *   接下来先读其他几批文件，先把内容全摸清，再一次性建条目。      ← ⭐ 尾巴上这一句
 *
 * 真因：`parseToolCalls()` 走的是「以 `{` 开头」那条主路，`JSON.parse` 整段失败、切到最后一个 `}` 也失败，
 * 落到 `splitJsonSpans()` —— 它遇散文一律 `null`，于是**整批 14 个动作一个都没跑**，
 * 而 `renderMsgs()` 按 `isCallMsg()`（= `parseToolCalls().length > 0`）判它"不是动作消息" ⇒
 * 整坨 JSON 当正文画到创作者脸上。
 * 修法：`splitJsonSpansLoose()` —— 头尾各允许一段散文，中间仍是「一行一个动作」（`src/ui/agent-tools.ts`）。
 *
 * 折叠（用户选的形态 A、默认收起）：一条动作消息 + 紧跟其后的 **≥2** 条回执 ⇒ 一块
 * `<details class="lk-agent__tools">`，一行「read_file ×3 · 3 个结果（点开看）」；
 * ⚠️ 块里每条仍是 `.lk-agent__tool`（一大票套件按它数回执、取最后一条）。
 *
 * 前置（同一 pwsh 调用里做，再重启实例）：
 *   $env:LINGKUANG_TEST_DATA=<root>\worldbuilding.json; $env:LINGKUANG_VAULT=<root>\vault
 *   $env:LINGKUANG_TEST_USERDATA=<root>\userdata
 *   node tools\e2e\reset-entity-vault.cjs; node tools\e2e\seed-node.cjs
 * 跑：$env:LK_CDP_PORT=9500; node tools\e2e\agent-toolfold.cjs
 *
 * ⭐ 2026-10-14（第八十三轮，用户原话「**还是被当成正文发出来了**」）又加一节 ★7/★7b：
 * 真机 `#119` 那条的形状是**动作 → 中间一大段回声与散文 → 又是动作**（17 个动作夹着 26 行非 JSON）。
 * 旧 `splitJsonSpansLoose()` 只许散文挂在头/尾各一段（`if (tailProse) return null`）⇒ 中间一回声
 * 就整批作废。现在**对象之间的非 JSON 行一律放行**；另加 `toolProse()` 的**回声剥离**
 * （`【动作结果：…】` 起、到空行为止整块丢掉 —— 那是模型抄历史，不是它说的话）。 */
const PORT = process.env.LK_CDP_PORT || '9500';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(n, ok, extra) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);
}

/** 真机形状：一行一个动作（连换行都没有别的散文），尾巴上再挂一句话 */
const callLines = (paths) => paths.map((p) => JSON.stringify({ tool: 'read_file', args: { path: p } })).join('\n');

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
  const groupCount = () => ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__tools').length`);
  const fed = () => ev(`(function () { const s = window.__lkSeen || []; const m = s[s.length - 1] || []; return m.map((x) => String(x.content || '')).join('\\n'); })()`);
  const lastBubble = () => ev(`(function () { const b = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')]; return b.length ? b[b.length - 1].textContent : ''; })()`);
  /* ⚠️ 别拿「最后一条 AI 气泡」当散文的判据：动作跑完之后模型还会再说一句（那一句才是最后一条）。
     动作消息里那句散文在它**前面** —— 要扫所有 AI 气泡。 */
  const aiBubbleText = () => ev(`[...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')].map((b) => b.textContent || '').join('\\n')`);
  /* ⭐ 关键判据：动作 JSON 一个字都不许进 AI 气泡（用户 2026-10-13：「依旧被当成正文了」） */
  const jsonInBubbles = () => ev(`(function () {
    const bad = [];
    [...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')].forEach(function (b) {
      const t = b.textContent || '';
      if (t.indexOf('"tool"') >= 0 || t.indexOf('read_file') >= 0) bad.push(t.slice(0, 120));
    });
    return { n: bad.length, sample: bad[0] || '' };
  })()`);

  check('★1 面板开出来了（Ctrl+K）', (await ev(`!!document.getElementById('lk-agent-panel')`)) === true);
  await ev(`document.getElementById('lk-agent-mode-agent').click(); true`);
  await sleep(300);
  await setPerm('workspace', 'always');

  /* ---------- 夹具：三份材料（写在灵框库里，read_file 一定读得到） ---------- */
  const made = await ev(`(async function () {
    const rs = ((await window.lingkuangAPI.fs.roots()) || {}).roots || [];
    const v = rs.find((r) => r.builtin) || rs[0];
    if (!v) return { err: '没有可写根' };
    const base = String(v.path).replace(/[\\\\/]+$/, '');
    const out = [];
    for (let i = 1; i <= 3; i++) {
      const p = base + '/lk-e2e-fold-' + i + '.md';
      await window.lingkuangAPI.fs.write(p, '第 ' + i + ' 份材料：这一份是给折叠套件用的。', 'overwrite');
      out.push(p.replace(/\\\\/g, '/'));
    }
    return { files: out };
  })()`);
  const files = made.files || [];
  if (files.length !== 3) { console.log('FAIL 夹具没造出来 ' + JSON.stringify(made)); process.exit(2); }

  /* ---------- ① ⭐ 真机原样：3 行动作 + 尾巴上一句话 ⇒ 三个动作全跑、那句话留住、JSON 不进气泡 ---------- */
  const TAIL = '接下来先读其他几批文件，先把内容全摸清，再一次性建条目。';
  const text1 = callLines(files) + '\n\n' + TAIL;
  await setMock([text1, '三份材料我都看过了。']);
  const tBefore = await toolCount();
  await ask('把这三份材料读一下。');
  const r2 = {
    calls: await callTexts(),
    receipts: (await toolCount()) - tBefore,
    groups: await groupCount(),
    bubbles: await jsonInBubbles(),
    bubbleText: await aiBubbleText(),
    last: await lastBubble(),
  };
  check('★2 ⭐「一行一个动作 + 末尾还有一句话」的整批动作**真跑**（read_file ×3）',
    r2.receipts === 3 && r2.calls.some((c) => c.indexOf('read_file ×3') >= 0),
    { receipts: r2.receipts, calls: r2.calls });
  check('★2b ⭐动作 JSON **一个字都没进 AI 气泡**，尾巴上那句话照旧留着（用户：「依旧被当成正文了」）',
    r2.bubbles.n === 0 && r2.bubbleText.indexOf(TAIL) >= 0 && r2.last.indexOf('三份材料我都看过了') >= 0,
    { bubbles: r2.bubbles, hasTail: r2.bubbleText.indexOf(TAIL) >= 0, last: r2.last.slice(0, 40) });

  /* ---------- ② ⭐ 连续多条结果收成**一块**（用户选的形态 A：默认收起） ---------- */
  const g3 = await ev(`(function () {
    const g = document.querySelectorAll('#lk-agent-msgs .lk-agent__tools');
    if (!g.length) return { n: 0 };
    const last = g[g.length - 1];
    return {
      n: g.length,
      open: last.open === true,
      sum: (last.querySelector('.lk-agent__tools-h') || {}).textContent || '',
      inner: last.querySelectorAll('.lk-agent__tool').length,
      call: (last.querySelector('.lk-agent__call') || {}).textContent || '',
      h: last.offsetHeight,
    };
  })()`);
  check('★3 ⭐三条结果收成一块（一行「read_file ×3 · 3 个结果（点开看）」、默认收起）',
    g3.n === 1 && g3.open === false && g3.inner === 3 &&
    g3.sum.indexOf('3 个结果') >= 0 && g3.sum.indexOf('点开看') >= 0 && g3.sum.indexOf('read_file ×3') >= 0,
    g3);
  check('★3b 块里那三条仍是 `.lk-agent__tool`（一大票套件按它数回执 —— 收进折叠块不许把它收没）',
    g3.inner === 3 && (await toolCount()) === 3, { inner: g3.inner, tools: await toolCount() });

  const clickRes = await ev(`(function () {
    const g = document.querySelectorAll('#lk-agent-msgs .lk-agent__tools');
    const last = g[g.length - 1];
    const s = last && last.querySelector('.lk-agent__tools-h');
    if (!s) return { clicked: false };
    s.click();
    return { clicked: true, open: last.open === true, h: last.offsetHeight, t: last.textContent || '' };
  })()`);
  check('★4 点一下才展开（展开后三份材料正文都在、块真的变高）',
    clickRes.clicked === true && clickRes.open === true && clickRes.h > g3.h &&
    clickRes.t.indexOf('第 1 份材料') >= 0 && clickRes.t.indexOf('第 3 份材料') >= 0,
    { open: clickRes.open, hBefore: g3.h, hAfter: clickRes.h });

  /* ---------- ③ 结果真喂回下一轮 ---------- */
  const f4 = await fed();
  check('★5 三条结果都作为「动作结果」喂回了下一轮（模型据此作答）',
    (f4.match(/【动作结果：read_file】/g) || []).length === 3 && r2.last.indexOf('三份材料我都看过了') >= 0,
    { fed: f4.slice(-200), last: r2.last });

  /* ---------- ④ 只跑了一个动作的那轮**不收**（别为它多一层点击） ---------- */
  /* ⚠️ 这一轮必须是**纯 JSON**：单个对象 + 前置散文按老规矩仍当聊天（`agent-tools.cjs` ★13 钉住的
     「举例说明」形状）—— 拿它来测"不收"会测成"动作根本没跑"（首跑就是这么假红的，★6 读到 grew:0）。 */
  const text2 = JSON.stringify({ tool: 'read_file', args: { path: files[0] } });
  await setMock([text2, '看过了。']);
  const t5 = await toolCount();
  await ask('再看一眼第一份。');
  const r5 = await ev(`(function () {
    const t = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__tool')];
    const last = t[t.length - 1];
    return {
      groups: document.querySelectorAll('#lk-agent-msgs .lk-agent__tools').length,
      inGroup: !!(last && last.closest('.lk-agent__tools')),
      receipts: t.length,
    };
  })()`);
  check('★6 只跑了一个动作的那轮**不收**（「用到动作」行 + 一条回执照旧）',
    r5.groups === 1 && r5.inGroup === false && r5.receipts - t5 === 1,
    { groups: r5.groups, inGroup: r5.inGroup, grew: r5.receipts - t5 });
  const r6 = { bubbles: await jsonInBubbles(), calls: await callTexts() };
  check('★6b 单动作那轮的纯 JSON 也没进气泡（画成「用到动作」一行）',
    r6.bubbles.n === 0 && r6.calls.length >= 2,
    { bubbles: r6.bubbles, calls: r6.calls });

  /* ---------- ⑥ ⭐ 真机第三次实测（用户 2026-10-14「还是被当成正文发出来了」）：
     动作 → **中间一大段回声 + 散文** → 又是动作。
     他真实那条（`%APPDATA%\lingkuang\agent\sessions.json` 主会话 `#119`，1931 字、49 行）=
     4 行动作 + 模型把前几轮的历史回执原样抄了一遍（`【动作结果：list_files】` ×3，连"里 8 项"
     都抄串了、实际列了 14 行）+ 两句英文散文 + 13 行动作，一共 17 个动作。
     旧规矩只许散文挂在头/尾各一段 ⇒ 中间一回声就整批作废、17 个动作一个没跑。 */
  const ECHO_HEAD = '【动作结果：list_files】';
  const MID_PROSE = 'Hmm, the results are a bit garbled. Let me re-list properly.';
  const text3 = [
    JSON.stringify({ tool: 'read_file', args: { path: files[0] } }),
    JSON.stringify({ tool: 'read_file', args: { path: files[1] } }),
    '',
    ECHO_HEAD,
    '「D:/Desktop/世界观资料整理/设定/第一世界」（Desktop · 只读）里 8 项：',
    '地理/（目录）',
    '（大概 14 个目录，我按上面列的继续读）',
    '',
    MID_PROSE,
    '',
    JSON.stringify({ tool: 'read_file', args: { path: files[2] } }),
    JSON.stringify({ tool: 'read_file', args: { path: files[0] } }),
  ].join('\n');
  await setMock([text3, '四份都过了一遍。']);
  const t7 = await toolCount();
  await ask('把材料都过一遍。');
  const r7 = {
    calls: await callTexts(),
    receipts: (await toolCount()) - t7,
    bubbles: await jsonInBubbles(),
    bubbleText: await aiBubbleText(),
  };
  check('★7 ⭐「动作 + 中间夹回声/散文 + 又是动作」整批**真跑**（前 2 个 + 后 2 个 = 4 个）',
    r7.receipts === 4 && r7.calls.some((c) => c.indexOf('read_file ×4') >= 0),
    { receipts: r7.receipts, calls: r7.calls });
  check('★7b ⭐回声（`【动作结果：…】`连同它下面那块）不许画进气泡，中间那句真散文要留着',
    r7.bubbles.n === 0 && r7.bubbleText.indexOf(MID_PROSE) >= 0 &&
    r7.bubbleText.indexOf('里 8 项') < 0 && r7.bubbleText.indexOf('地理/（目录）') < 0,
    {
      bubbles: r7.bubbles,
      hasProse: r7.bubbleText.indexOf(MID_PROSE) >= 0,
      echoLeak: r7.bubbleText.indexOf('里 8 项') >= 0,
      sample: r7.bubbleText.slice(-200),
    });

  /* ---------- ⑦ ⭐ 真机第四次实测（用户 2026-10-15「工具调用又被当成正文了」）：
     一批 37 行动作里**只有一行**是坏的（第 24 行写成 `{"tool":"tool":"read_file",…}`，键名重了
     一遍）—— 老规矩「有一段认不出就整段作废」把 **36 个好动作全扔了**，整坨 JSON 又被当正文画到
     脸上。现在的规矩：能修的（键名写重）就地修好照跑，修不好的**跳过并通报一声**。 */
  const DUP = '{"tool":"tool":"read_file","args":{"path":' + JSON.stringify(files[1]) + '}}';
  const BROKEN = '{"tool":"read_file","args":{"path":' + files[2] + '}}'; /* 值没引号 ⇒ 修不好 */
  const text4 = [
    JSON.stringify({ tool: 'read_file', args: { path: files[0] } }),
    DUP,
    BROKEN,
    JSON.stringify({ tool: 'read_file', args: { path: files[2] } }),
  ].join('\n');
  await setMock([text4, '三份材料过了一遍。']);
  const t9 = await toolCount();
  await ask('把这几份连那行坏的也一起读。');
  const r9 = {
    receipts: (await toolCount()) - t9,
    calls: await callTexts(),
    bubbles: await jsonInBubbles(),
    fed: await fed(),
  };
  /* 四条回执 = 三份真读到的材料（第 2 行是**修好**的那条）+ 一条「未执行」通报 */
  check('★9 ⭐一批里只有一行坏了 ⇒ 其余照跑（键名写重的那行就地修好，也当成一个动作跑）',
    r9.receipts === 4 && r9.calls.some((c) => c.indexOf('read_file ×3') >= 0),
    { receipts: r9.receipts, calls: r9.calls });
  check('★9b ⭐修不好的那行**跳过并通报**（既不静默吞掉，也不因此把整批丢掉）',
    r9.fed.indexOf('未执行') >= 0 && r9.fed.indexOf('没认出来') >= 0 && r9.fed.indexOf(files[2]) >= 0,
    { fed: r9.fed.slice(-300) });
  check('★9c 坏行也没把整坨 JSON 顶进气泡', r9.bubbles.n === 0, r9.bubbles);

  /* ---------- ⑤ ⭐⭐ 用户 2026-10-16 第四次报同一件事，真机原样：**一句打算 + 一个动作** ----------
     真机 `%APPDATA%\lingkuang\agent\sessions.json` 主会话 `#119`（78 字 / 3 行）。老规矩
     「单对象 + 前置散文 ⇒ 当聊天」（★13 为了防"举例"）把这条**真调用**也吃了：一个动作都没跑、
     JSON 又被当正文画到脸上。这次改成**按那句散文的样子分流** —— 像在说打算 ⇒ 干；像在举例 ⇒ 聊天。 */
  const P1 = '我先看一眼 D:\\Desktop 里有什么可导的。';
  await setMock([P1 + '\n\n' + JSON.stringify({ tool: 'read_file', args: { path: files[0] } }), '看过了。']);
  const t11 = await toolCount();
  await ask('先看一眼那第一份。');
  const r11 = { receipts: (await toolCount()) - t11, bubbles: await jsonInBubbles(), bubbleText: await aiBubbleText() };
  check('★11 ⭐「一句打算 + 一个动作」真跑（用户 2026-10-16：「又被当成正文了」的原样）',
    r11.receipts === 1 && r11.bubbles.n === 0 && r11.bubbleText.indexOf(P1) >= 0, r11);

  /* 反面一：冒号收尾 = 在把那行当例子递出来 ⇒ 仍然是聊天（★13 的口径一个字没松） */
  const P2 = '你可以这样写：';
  await setMock([P2 + '\n' + JSON.stringify({ tool: 'read_file', args: { path: files[1] } }), '好的。']);
  const t11b = await toolCount();
  await ask('格式是什么样的？');
  const r11b = { receipts: (await toolCount()) - t11b, bubbleText: await aiBubbleText() };
  check('★11b 「你可以这样写：」+ 一个例子 ⇒ 仍然当聊天（不许跑）',
    r11b.receipts === 0 && r11b.bubbleText.indexOf(P2) >= 0, r11b);

  /* 反面二：散文里带"比如 / 例如"这类词 ⇒ 也是举例，不许跑（判据的第二条） */
  const P3 = '比如要读第二份，就可以这样写';
  await setMock([P3 + '\n' + JSON.stringify({ tool: 'read_file', args: { path: files[2] } }), '好的。']);
  const t11c = await toolCount();
  await ask('举个例子？');
  const r11c = { receipts: (await toolCount()) - t11c };
  check('★11c 散文里带「比如」⇒ 也算举例、不跑（宁可让人再催一次，也不把例子当命令）',
    r11c.receipts === 0, r11c);

  const errs = await ev(`window.__errs`);
  check('★10 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`==== ${pass}/${results.length} PASS ====`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : String(e)));
  process.exit(2);
});
