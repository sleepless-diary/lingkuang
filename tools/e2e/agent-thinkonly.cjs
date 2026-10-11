/* agent-thinkonly.cjs —— 助手：**只有思考、没有正文**的那种回复不许当正文发出来
 *
 * 用户 2026-10-12 原话：「思考又被当成正文了」。
 * 真机证据（只读 `%APPDATA%\lingkuang\agent\sessions.json`，主会话 `#119`）：
 *   assistant content = 2465 字英文思考（"I was in the middle of exploring the folder structure…
 *   Let me plan: list the remaining subfolders…"）、reasoning = **0**。
 * 真因：`src/ui/ai.ts` 文件尾那条兜底 `text: text || thinking`（本来是给本机 qwen3「答案放在 thinking」
 * 用的）在推理模型"整轮预算花在思考上、正文为空"时把**思考**塞进了正文；同一行使 `reasoning` 变空 ⇒
 * 那段思考既当正文显示、又不在思考块里。云端 DeepSeek 实测（本套件对真端点做过形状探测）：
 * 思考走 `reasoning_content`、正文走 `content`、`tool_calls` 为 none ⇒ 正文为空就是真的空。
 *
 * 这份套件用 **`window.fetch` 回放**（不是 `__lkAgentMock` —— 那个绕过了 ai.ts，压根测不到这条兜底）
 * 喂 SSE：第一轮只给 `delta.reasoning_content`、不给 content。守四件事：
 *   ① 那段思考**一个字都不许进 AI 气泡**，但要在思考块里（折叠，翻得回来）；
 *   ② 助手要**自动催一次**（模型下一轮就正常了），催的话写进喂回去的消息里；
 *   ③ 「只想了没答」最多催一次，不许无限来回；
 *   ④ 模型走厂商原生 `tool_calls`（我们收不到那套）时，催的话换成「格式提醒」。
 *
 * 前置（同一 pwsh 调用里做，再重启实例）：
 *   $env:LINGKUANG_TEST_DATA=<root>\worldbuilding.json; $env:LINGKUANG_VAULT=<root>\vault
 *   $env:LINGKUANG_TEST_USERDATA=<root>\userdata
 *   node tools\e2e\reset-entity-vault.cjs; node tools\e2e\seed-node.cjs
 * 跑：$env:LK_CDP_PORT=9500; node tools\e2e\agent-thinkonly.cjs
 */
const PORT = process.env.LK_CDP_PORT || '9500';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(n, ok, extra) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);
}

const SENT_A = '【思考哨兵-A】我得先弄清创作者要什么，让我列个计划：先读角色，再读地理，最后汇总。';
const SENT_B = '【思考哨兵-B】这次我直接调 read_file 吧，一次读三个。';
const SENT_C = '【思考哨兵-C】我再想想，还是先不写正文。';
const SENT_D = '【思考哨兵-D】继续想，还是不动手。';
const ANSWER_A = '第一世界的角色我接着往下看：夕颜、星言、雅缇娜，再看地理。';
const ANSWER_B = '好，我改成一行一个 JSON 的动作。';

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
  /* ⚠️ 每个 eval 都带超时：渲染进程里那句 `await` 万一永不落定，整套会静静吊死 */
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

  /* ---------- 回放引擎：**替换 window.fetch**（不走 `__lkAgentMock` —— 那个绕过 ai.ts，测不到兜底） ---------- */
  await ev(`(function () {
    window.__lkOrigFetch = window.__lkOrigFetch || window.fetch;
    window.__lkFetchLog = [];
    window.__lkFixQ = [];
    window.fetch = function (url, init) {
      const u = String(url);
      /* 只截聊天端点，别的一律放行（设置面板探测模型清单也走 fetch） */
      if (u.indexOf('chat/completions') < 0 && u.indexOf('/api/chat') < 0) return window.__lkOrigFetch.apply(this, arguments);
      let msgs = [];
      try { msgs = (JSON.parse(init.body).messages) || []; } catch (e) { /* 不是我们关心的 */ }
      window.__lkFetchLog.push({ url: u, msgs: msgs });
      const fx = window.__lkFixQ.length ? window.__lkFixQ.shift() : { content: '（夹具用完了）' };
      /* ⚠️ 一行里同时带 message（Ollama 原生 NDJSON）与 choices（OpenAI SSE）两种形状 ——
         测试实例的默认供应商是**本机 Ollama**（agent-model.ts 走 aiChatStream，按 kind 选分支），
         这份夹具不该依赖"当前配的是哪一家"。两条分支各读各的字段，互不干扰。 */
      const chunk = {
        model: 'lk-e2e',
        message: { role: 'assistant', content: fx.content || '', thinking: fx.reasoning || '' },
        choices: [{ index: 0, delta: { content: fx.content || '', reasoning_content: fx.reasoning || '' }, finish_reason: null }],
        done: false,
      };
      if (fx.toolName) {
        chunk.message.tool_calls = [{ function: { name: fx.toolName, arguments: '{}' } }];
        chunk.choices[0].delta.tool_calls = [{ index: 0, id: 'call_1', function: { name: fx.toolName, arguments: '{}' } }];
      }
      const lines = [
        JSON.stringify(chunk) + '\\n',
        JSON.stringify({ model: 'lk-e2e', done: true, done_reason: 'stop', message: { role: 'assistant', content: '' }, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\\n',
      ];
      const enc = new TextEncoder();
      return Promise.resolve(new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(lines.join(''))); c.close(); } }), { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }));
    };
    return true;
  })()`);
  const setFix = async (q) => ev(`window.__lkFixQ = ${JSON.stringify(q)}; window.__lkFetchLog = []; true`);
  const reqs = () => ev(`window.__lkFetchLog.length`);
  const lastFed = () => ev(`(function () { const l = window.__lkFetchLog; if (!l.length) return ''; const m = l[l.length - 1].msgs; return String((m[m.length - 1] || {}).content || ''); })()`);
  const allFed = () => ev(`(function () { return (window.__lkFetchLog || []).map(function (x, i) { return '#' + i + ' ' + x.msgs.map(function (m) { return m.role + ':' + String(m.content || '').length; }).join(' '); }).join(' | '); })()`);
  const ask = async (text, wait = 1800) => {
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
  /* ⭐ 关键判据：思考原文**一个字都不许进 AI 气泡**（用户报的就是它被画成正文） */
  const sentInBubbles = (needle) => ev(`(function () {
    const bad = [];
    [...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')].forEach(function (b) {
      const t = b.textContent || '';
      if (t.indexOf(${JSON.stringify(needle)}) >= 0) bad.push(t.slice(0, 120));
    });
    return { n: bad.length, sample: bad[0] || '' };
  })()`);
  const thinkText = (needle) => ev(`(function () {
    let hit = 0, n = 0;
    [...document.querySelectorAll('#lk-agent-msgs details.lk-think .lk-think__body')].forEach(function (d) {
      n++;
      if ((d.textContent || '').indexOf(${JSON.stringify(needle)}) >= 0) hit++;
    });
    return { blocks: n, hit: hit };
  })()`);
  const lastBubble = () => ev(`(function () { const b = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')]; return b.length ? b[b.length - 1].textContent : ''; })()`);
  const bubblesWith = (needle) => ev(`[...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')].filter(function (b) { return (b.textContent || '').indexOf(${JSON.stringify(needle)}) >= 0; }).length`);

  check('★1 面板开出来了（Ctrl+K）', (await ev(`!!document.getElementById('lk-agent-panel')`)) === true);
  await ev(`document.getElementById('lk-agent-mode-agent').click(); true`);
  await sleep(300);
  await setPerm('workspace', 'always');

  /* ---------- ① ⭐ 真机形状：第一轮只有思考、没有正文 ---------- */
  await setFix([{ reasoning: SENT_A }, { content: ANSWER_A }]);
  await ask('第一世界的角色都有谁？');
  const a = {
    reqs: await reqs(),
    lastFed: (await lastFed()).slice(0, 120),
    inBubble: await sentInBubbles('思考哨兵-A'),
    inThink: await thinkText('思考哨兵-A'),
    echo: await bubblesWith('没写正文'),
    last: (await lastBubble()).slice(0, 120),
    fed: await allFed(),
  };
  check('★2 ⭐那段思考**一个字都没进 AI 气泡**（用户 2026-10-12：「思考又被当成正文了」）',
    a.inBubble.n === 0, a.inBubble);
  check('★3 ⭐思考全文在思考块里（折叠着，翻得回来）',
    a.inThink.hit >= 1, a.inThink);
  check('★4 ⭐助手自动催了一次（模型下一轮就正常了：请求数 2）',
    a.reqs === 2, { reqs: a.reqs, fed: a.fed });
  check('★5 催的话是真的喂回去了（末条 user 消息 = 「只有思考过程，正文是空的」）',
    a.lastFed.indexOf('只有思考过程，正文是空的') >= 0, { lastFed: a.lastFed });
  check('★6 那一轮的助手气泡写的是实话（「没写正文」）＋ 最后一条气泡是第二轮的正文',
    a.echo === 1 && a.last.indexOf('第一世界的角色我接着往下看') >= 0, { echo: a.echo, last: a.last });

  /* ---------- ② 只催一次：两轮都只想了没答 ⇒ 停在 2 次请求 ---------- */
  await setFix([{ reasoning: SENT_C }, { reasoning: SENT_D }]);
  await ask('继续说。');
  const b = {
    reqs: await reqs(),
    inBubble: await sentInBubbles('思考哨兵'),
    lastFed: (await lastFed()).slice(0, 80),
  };
  check('★7 ⭐「只想了没答」最多催一次（两轮都是空正文 ⇒ 停在 2 次请求，不来回拉锯）',
    b.reqs === 2, { reqs: b.reqs, fed: b.lastFed });
  check('★8 两轮的思考都没进气泡（D 那份也在思考块里）',
    b.inBubble.n === 0, b.inBubble);

  /* ---------- ③ 厂商原生 tool_calls：动作丢了 ⇒ 催的话换成「格式提醒」 ---------- */
  await setFix([{ reasoning: SENT_B, toolName: 'read_file' }, { content: ANSWER_B }]);
  await ask('把三个角色文件都读了。');
  const c = {
    reqs: await reqs(),
    lastFed: (await lastFed()).slice(0, 140),
    inBubble: await sentInBubbles('思考哨兵-B'),
    last: (await lastBubble()).slice(0, 80),
  };
  check('★9 ⭐模型走厂商原生 tool_calls（我们收不到）时，催的话是「格式提醒」（叫它写成一行一个 JSON）',
    c.reqs === 2 && c.lastFed.indexOf('格式提醒') >= 0, { reqs: c.reqs, lastFed: c.lastFed });
  check('★10 那一轮的思考同样没进气泡，第二轮正文照常显示',
    c.inBubble.n === 0 && c.last.indexOf('改成一行一个 JSON') >= 0, { inBubble: c.inBubble, last: c.last });

  /* ---------- ④ 无未捕获异常 ---------- */
  const errs = await ev(`window.__errs || []`);
  check('★11 全过程无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`\n== agent-thinkonly: ${pass}/${results.length} PASS`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
