/* agent-supplement.cjs —— 「补发」：跑的过程中点发送，那句话直接进**正在跑的**那条流
 *
 * 用户原话（2026-10-12）：「**加一下补发的功能（点发送该信息直接加入正在执行的数据流）**」。
 * 从前跑的时候点发送是**静默空点**（第 75 轮刻意如此：`send()` 第一行 `if (busy || …) return;`，
 * 消息留在输入框里、什么也不发生 —— 那时是为了不把发送键变成"打断"）。
 * 现在：那句立刻进主会话历史，工具循环**每一轮都重新从历史拼 msgs** ⇒ 下一次请求就带上它。
 *
 * 量的东西（⚠️ 旧构建会红在哪一眼能看出来）：
 *   ★1  ⭐跑着的时候发送**收走了输入框、屏幕上多了一条用户气泡**（旧构建：文字还原封不动留在框里）
 *   ★1b    跑着的时候输入框提示换成了「补发」（旧构建：还是"问点什么…"）
 *   ★2  ⭐**下一次请求的 messages 里逐字有补发那句话**（这正是"加入正在执行的数据流"；
 *          旧构建：请求次数 1、永远看不见这句）
 *   ★2b    没有另起一轮（请求次数 == 2：原问 1 + 补发 1）
 *   ★3     模型**据此作答**：它只在看到补发时才回的那句话，落进了最后一个 AI 气泡
 *   ★4     跑完（空闲）时点发送 = 正常新提问（请求 +1、气泡 +1）
 *   ★5  ⭐可以反复补：第二轮跑着的时候再补第二句 ⇒ 第三轮请求里 A、B **都在**
 *   ★6     全程没有提议卡片（补发不是写动作）、没有未捕获异常
 *
 * 假引擎用函数形态（顺手把喂进去的 messages 存 `window.__lkSeen`，见 `src/ui/agent-model.ts`），
 * 分片形态 `{ chunks, gap }` 才有"跑着的这一段时间"可插话（gap 太小补发就落在跑完之后了）。
 *
 * 前置（同一 pwsh 调用里做，再起实例）：
 *   $env:LINGKUANG_TEST_DATA=<lk-supp>\worldbuilding.json; $env:LINGKUANG_VAULT=<lk-supp>\vault
 *   $env:LINGKUANG_TEST_USERDATA=<lk-supp>\userdata
 *   node tools\e2e\reset-entity-vault.cjs; node tools\e2e\seed-node.cjs
 * 跑：$env:LK_CDP_PORT=9500; node tools\e2e\agent-supplement.cjs
 */
const PORT = process.env.LK_CDP_PORT || '9500';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(n, ok, extra) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);
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
  /* ⚠️ 每个 eval 都带超时：渲染进程里那句 `await` 万一永不落定，整套会静静吊死、一个字都看不到 */
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
  check('★0 前置：设定库与助手按钮在、面板还没开、有可编的设定库条目',
    pre.tools.includes('agent') && pre.panel === false && pre.rows >= 1, pre);

  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
  await sleep(500);
  check('★0b 助手面板开出来了（Ctrl+K）', (await ev(`!!document.getElementById('lk-agent-panel')`)) === true);
  await ev(`document.getElementById('lk-agent-mode-agent').click(); true`);
  await sleep(250);

  /* ---------- 工具 ---------- */
  /* 假引擎（函数形态）：把每次请求的 messages 存下来，按队列回话；队列里放 `{chunks, gap}` 就是慢流式 */
  const setMock = async (queue) => ev(`window.__lkSeen = []; window.__lkMockQ = ${JSON.stringify(queue)}; window.__lkAgentMock = (m) => { window.__lkSeen.push(m); return window.__lkMockQ.length ? window.__lkMockQ.shift() : '好的。'; }; true`);
  const type = async (text) => ev(`(function () { const t = document.getElementById('lk-agent-input'); t.value = ${JSON.stringify(text)}; return true; })()`);
  const clickSend = async () => ev(`document.getElementById('lk-agent-send').click(); true`);
  /* 发一句（不等它跑完 —— 补发要的就是"跑着的那段时间"） */
  const askNow = async (text) => { await type(text); await clickSend(); };
  const seen = () => ev(`(window.__lkSeen || []).map(function (m) { return m.map(function (x) { return String(x.content || ''); }).join('\\n'); })`);
  const userBubbles = () => ev(`[...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-user .lk-agent__bubble')].map((b) => b.textContent)`);
  const aiBubbles = () => ev(`[...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')].map((b) => b.textContent)`);
  const inputVal = () => ev(`(document.getElementById('lk-agent-input') || {}).value || ''`);
  const inputHint = () => ev(`(document.getElementById('lk-agent-input') || {}).placeholder || ''`);
  const props = () => ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__prop').length`);

  /* ================= ① 跑着的时候补一句 ================= */
  const ASK1 = '先把设定库结构扫一遍。';
  const SUP1 = '顺便也看一下时间线里有没有「第三纪元」这段。';
  const MARK2 = '（看到补发了）好，我把它一起看了。';
  const CHUNKS1 = Array.from({ length: 20 }, (_, i) => '第一轮第' + (i + 1) + '片。');
  await setMock([
    { chunks: CHUNKS1, gap: 120 },  /* ① 慢流式：约 2.4s 的窗口 */
    MARK2,                          /* ② 补发那一轮的回答（只有读到补发才会出现这句话） */
    '好。',                         /* ③ 兜底 */
  ]);
  await askNow(ASK1);
  await sleep(900); /* 这时候第一轮请求早就发出去了，但流还没吐完 */
  const midRun = await ev(`!document.getElementById('lk-agent-stop').hidden`);
  const hintMid = await inputHint();
  await askNow(SUP1); /* ⭐ 跑着的时候点发送 = 补发 */
  await sleep(300);
  const afterSup = { input: await inputVal(), users: await userBubbles() };

  check('★1 ⭐跑着的时候发送不是空点：输入框收走了、屏幕上多了一条用户气泡',
    afterSup.input === '' && afterSup.users.some((u) => u.indexOf(SUP1) >= 0),
    { running: midRun, input: afterSup.input, users: afterSup.users.length });
  check('★1b ⭐跑着的时候输入框提示换成了「补发」（跑完要换回来）',
    hintMid.indexOf('补发') >= 0, { hint: hintMid });

  await sleep(3600); /* 等②那一轮跑完（补发读过就结束） */
  const s2 = { seen: await seen(), ai: await aiBubbles(), props: await props(), input: await inputVal(), hint: await inputHint() };
  check('★2 ⭐⭐补发那句话进了**下一次请求**、而且是最后一条（"直接加入正在执行的数据流"）',
    s2.seen.length >= 2 && String(s2.seen[1] || '').trim().endsWith(SUP1)
    && String(s2.seen[1] || '').indexOf(SUP1) >= 0,
    { calls: s2.seen.length, tail: String(s2.seen[1] || '').slice(-90) });
  check('★2b 没有另起一轮：一共 2 次请求（原问 1 + 补发 1）', s2.seen.length === 2, { calls: s2.seen.length });
  check('★3 ⭐模型**据此作答**：只有看到补发才回的那句话落进了最后一个 AI 气泡',
    s2.ai.length > 0 && String(s2.ai[s2.ai.length - 1]).indexOf('看到补发了') >= 0,
    { last: String(s2.ai[s2.ai.length - 1] || '').slice(0, 60), ai: s2.ai.length });
  check('★3b 跑完提示换回了常态（不再是「补发」那句）；补发没有重复画气泡（用户消息 2 条）',
    s2.hint.indexOf('补发') < 0 && (await userBubbles()).length === 2 && s2.input === '',
    { hint: s2.hint, users: (await userBubbles()).length });

  /* ================= ② 空闲时点发送 = 正常新提问 ================= */
  const ASK3 = '那再给我列一下有哪几个世界。';
  await setMock(['列好了。', '兜底']);
  await askNow(ASK3);
  await sleep(1200);
  const s3 = { seen: await seen(), users: await userBubbles(), ai: await aiBubbles() };
  check('★4 空闲时点发送仍是**正常提问**（请求里最后一条就是这一问、气泡各 +1）',
    s3.seen.length === 1 && String(s3.seen[0]).trim().endsWith(ASK3)
    && s3.users.length === 3 && String(s3.ai[s3.ai.length - 1]).indexOf('列好了') >= 0,
    { calls: s3.seen.length, users: s3.users.length, tail: String(s3.seen[0]).slice(-60) });

  /* ================= ③ 可以反复补（两轮里各补一句） ================= */
  const ASK4 = '开始整理第一世界的设定。';
  const SUPA = '先只整理「角色」那一类。';
  const SUPB = '名字统一用两到三个字。';
  await setMock([
    { chunks: Array.from({ length: 14 }, (_, i) => 'A轮第' + (i + 1) + '片。'), gap: 120 },
    { chunks: Array.from({ length: 10 }, (_, i) => 'B轮第' + (i + 1) + '片。'), gap: 120 },
    '都记下了。',
  ]);
  await askNow(ASK4);
  await sleep(900);
  await askNow(SUPA);          /* 第一轮里补 A */
  await sleep(1800);           /* 到这里 A 那一轮已经开跑（慢流式） */
  await askNow(SUPB);          /* A 那一轮里补 B */
  await sleep(3200);
  const s4 = { seen: await seen(), last: String((await aiBubbles()).slice(-1)[0] || ''), props: await props(), errs: await ev(`window.__errs.length`) };
  check('★5 ⭐反复补也认：第三轮请求里 A、B 两句都在（B 在最后）',
    s4.seen.length >= 3 && String(s4.seen[2]).indexOf(SUPA) >= 0 && String(s4.seen[2]).indexOf(SUPB) >= 0
    && String(s4.seen[2]).lastIndexOf(SUPB) > String(s4.seen[2]).lastIndexOf(SUPA),
    { calls: s4.seen.length });
  check('★6 全程没有提议卡片（补发不是写动作）', s4.props === 0, { props: s4.props });
  check('★7 全程没有未捕获异常', s4.errs === 0, { errs: s4.errs });

  const passed = results.filter(Boolean).length;
  console.log(`==== ${passed}/${results.length} PASS ====`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e));
  console.log(`==== ${results.filter(Boolean).length}/${results.length} PASS ====`);
  process.exit(2);
});
