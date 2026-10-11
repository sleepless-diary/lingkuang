/* 灵框助手 · 「原生 function calling」套件（2026-10-15，第八十五轮）
 *
 * 用户原话：「**工具调用又被当成正文了，有没有现成的轮子可以用啊**」——
 * 问过之后用户选定：**上原生 function calling**（不再只靠手写文本解析器）。
 *
 * 这个套件用 **`window.fetch` 回放**（不走 `__lkAgentMock`：那个在进 `aiChatSrc` 之前就短路了，
 * 测不到 `src/ui/ai.ts` 的请求体与 tool_calls 累加）分别验：
 *   ★2  OpenAI 兼容线：`delta.tool_calls` **分片**（`index` 定位、`arguments` 一片一段）也要攒得起来
 *   ★2b 请求体里真的带了 `tools`（结构化清单，含 read_file / list_files）
 *   ★2c 落进历史的是**文本协议**（一行一个纯 JSON）—— sessions.json 的格式因此一个字都不用改
 *   ★3  Ollama 原生线：整包 `message.tool_calls`、`function.arguments` 是**对象**而不是字符串
 *   ★4  端点不认 `tools`（400）⇒ `ai.ts` 自动**去掉清单重试一次**（退回文本协议，整轮不能死）
 *   ★5  原生调用来的名字一条都认不出 ⇒ 通报 + 「格式提醒」纠正一次（不许静默吞）
 *   ★6  无未捕获异常
 *
 * 前置：`reset-entity-vault.cjs` + `seed-node.cjs`（本套件自己造要读的文件）。
 */
const PORT = process.env.LK_CDP_PORT || '9500';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(n, ok, extra) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);
}

async function main() {
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
  check('★1 面板开出来了（Ctrl+K）', (await ev(`!!document.getElementById('lk-agent-panel')`)) === true);

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
  await setPerm('workspace', 'always');

  /* ---------- 夹具：两份材料（写在灵框库里，read_file 一定读得到） ---------- */
  const made = await ev(`(async function () {
    const dir = (await window.lingkuangAPI.fs.roots()).roots[0].path;
    const out = [];
    for (let i = 1; i <= 2; i++) {
      const p = dir + '/lk-e2e-native-' + i + '.md';
      await window.lingkuangAPI.fs.write(p, '第 ' + i + ' 份材料：给原生 function calling 套件用的。', 'overwrite');
      out.push(p);
    }
    return { files: out, dir: dir };
  })()`);
  const files = made.files || [];
  if (files.length !== 2) { console.log('FAIL 夹具没造出来 ' + JSON.stringify(made)); process.exit(2); }

  /* ---------- 回放引擎：替换 window.fetch（只截聊天端点） ----------
     ⚠️ 夹具一律按 **OpenAI 形状**（`choices[0].delta`）写；页面里按**请求 URL**翻译成该线的形状 ——
     测试实例默认配的是本机 Ollama（走 `/api/chat`），两种形状混着喂会互相污染
     （`message.tool_calls` 是整包、`delta.tool_calls` 是分片，一起喂会把参数拼成乱码）。 */
  await ev(`(function () {
    window.__lkOrigFetch = window.__lkOrigFetch || window.fetch;
    window.__lkFetchLog = [];
    window.__lkFixQ = [];
    /* OpenAI 形状 → Ollama 形状：正文累积、tool_calls 按 index 攒成**整包**（arguments 是对象） */
    function toOllama(chunks) {
      let content = '';
      const slots = {};
      let reason = 'stop';
      chunks.forEach(function (c) {
        const ch = c.choices && c.choices[0];
        if (!ch) return;
        const d = ch.delta || {};
        if (typeof d.content === 'string') content += d.content;
        if (Array.isArray(d.tool_calls)) d.tool_calls.forEach(function (t) {
          const i = typeof t.index === 'number' ? t.index : 0;
          const s = slots[i] || { name: '', args: '' };
          if (t.function && t.function.name) s.name = t.function.name;
          if (t.function && typeof t.function.arguments === 'string') s.args += t.function.arguments;
          slots[i] = s;
        });
        if (ch.finish_reason) reason = ch.finish_reason;
      });
      const calls = Object.keys(slots).sort(function (a, b) { return a - b; }).map(function (i) {
        const s = slots[i];
        let argObj = {};
        try { argObj = s.args ? JSON.parse(s.args) : {}; } catch (e) { argObj = {}; }
        return { function: { name: s.name, arguments: argObj } };
      });
      const msg = { role: 'assistant', content: content };
      if (calls.length) msg.tool_calls = calls;
      return [{ model: 'lk-e2e', done: false, message: msg },
        { model: 'lk-e2e', done: true, done_reason: reason === 'length' ? 'length' : 'stop', message: { role: 'assistant', content: '' } }];
    }
    /* Ollama 形状 → OpenAI 形状（SSE 分片） */
    function toOpenai(chunks) {
      return chunks.map(function (c) {
        const m = c.message || {};
        const delta = { content: m.content || '' };
        if (Array.isArray(m.tool_calls)) delta.tool_calls = m.tool_calls.map(function (t, i) {
          return { index: i, id: 'call_' + i, type: 'function',
            function: { name: t.function && t.function.name, arguments: JSON.stringify((t.function && t.function.arguments) || {}) } };
        });
        return { model: 'lk-e2e', choices: [{ index: 0, delta: delta, finish_reason: c.done ? 'stop' : null }], done: !!c.done };
      });
    }
    window.fetch = function (url, init) {
      const u = String(url);
      if (u.indexOf('chat/completions') < 0 && u.indexOf('/api/chat') < 0) return window.__lkOrigFetch.apply(this, arguments);
      const isOllama = u.indexOf('/api/chat') >= 0;
      let body = {};
      try { body = JSON.parse(init.body) || {}; } catch (e) { /* 不是 JSON 就别管 */ }
      window.__lkFetchLog.push({ url: u, body: body, tools: body.tools ? body.tools.length : 0,
        toolsSample: body.tools ? body.tools.map(function (t) { return t.function && t.function.name; }).join(',') : '',
        msgs: body.messages || [] });
      const fx = window.__lkFixQ.length ? window.__lkFixQ.shift() : { chunks: [] };
      if (fx.status && fx.status !== 200) {
        return Promise.resolve(new Response(JSON.stringify({ error: { message: 'Tools are not supported' } }),
          { status: fx.status, headers: { 'Content-Type': 'application/json' } }));
      }
      const src = fx.chunks || [];
      const allOpenai = src.length > 0 && src.every(function (c) { return !!c.choices; });
      const allOllama = src.length > 0 && src.every(function (c) { return !c.choices; });
      const out = isOllama ? (allOpenai ? toOllama(src) : src) : (allOllama ? toOpenai(src) : src);
      const enc = new TextEncoder();
      const lines = out.map(function (c) { return JSON.stringify(c) + '\\n'; }).join('');
      return Promise.resolve(new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(lines)); c.close(); } }),
        { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }));
    };
    return true;
  })()`);
  const setFix = async (q) => ev(`window.__lkFixQ = ${JSON.stringify(q)}; window.__lkFetchLog = []; true`);
  const reqs = () => ev(`window.__lkFetchLog.length`);
  const reqAt = (i) => ev(`(function () { const x = window.__lkFetchLog[${i}]; if (!x) return null; return { tools: x.tools, toolsSample: x.toolsSample, msgs: x.msgs.map(function (m) { return { role: m.role, content: String(m.content || '') }; }) }; })()`);
  const ask = async (text, wait = 1800) => {
    await ev(`(function () { const t = document.getElementById('lk-agent-input'); t.value = ${JSON.stringify(text)}; document.getElementById('lk-agent-send').click(); return true; })()`);
    await sleep(wait);
  };
  const toolCount = () => ev(`document.querySelectorAll('#lk-agent-msgs .lk-agent__tool').length`);
  const callTexts = () => ev(`[...document.querySelectorAll('#lk-agent-msgs .lk-agent__call')].map((c) => c.textContent)`);
  const jsonInBubbles = () => ev(`(function () {
    const bad = [];
    [...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')].forEach(function (b) {
      const t = b.textContent || '';
      if (t.indexOf('"tool"') >= 0 || t.indexOf('read_file') >= 0 || t.indexOf('tool_calls') >= 0) bad.push(t.slice(0, 120));
    });
    return { n: bad.length, sample: bad[0] || '' };
  })()`);
  const bubbles = () => ev(`[...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')].map(function (b) { return b.textContent || ''; }).join(' | ')`);
  const propCount = () => ev(`document.querySelectorAll('#lk-agent-msgs [data-prop-ok]').length`);
  const toolTexts = () => ev(`[...document.querySelectorAll('#lk-agent-msgs .lk-agent__tool')].map(function (t) { return t.textContent || ''; }).join('\\n')`);

  /* ---------- ② OpenAI 兼容线：delta.tool_calls **分片** ---------- */
  /* ⚠️ 参数文本必须用 `JSON.stringify(路径)` 拼 —— Windows 路径里全是反斜杠，
     直接 `'{"path":"' + files[0] + '"}'` 拼出来的是**非法 JSON**（`\U` 不是合法转义），
     页面里 `toOllama` 的 `JSON.parse` 会静默落到 `{}`（args 变空、动作照跑但读不到文件 ——
     第一版就是这么假绿的：★2 只数了回执条数，没看回执里到底读到了什么）。 */
  const full0 = '{"path":' + JSON.stringify(files[0]) + '}';
  const full1 = '{"path":' + JSON.stringify(files[1]) + '}';
  const cut = Math.floor(full0.length / 2);
  const call0 = { index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: full0.slice(0, cut) } };
  const call0b = { index: 0, function: { arguments: full0.slice(cut) } };
  const call1 = { index: 1, id: 'call_b', type: 'function', function: { name: 'read_file', arguments: full1 } };
  await setFix([
    { chunks: [
      { model: 'lk-e2e', choices: [{ index: 0, delta: { tool_calls: [call0, call1] }, finish_reason: null }], done: false },
      { model: 'lk-e2e', choices: [{ index: 0, delta: { tool_calls: [call0b] }, finish_reason: 'tool_calls' }], done: false },
      { model: 'lk-e2e', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], done: true },
    ] },
    { chunks: [
      { model: 'lk-e2e', choices: [{ index: 0, delta: { content: '两份材料我都读过了。' }, finish_reason: null }], done: false },
      { model: 'lk-e2e', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], done: true },
    ] },
  ]);
  const t2 = await toolCount();
  await ask('读那两份材料。');
  const r2 = {
    receipts: (await toolCount()) - t2,
    calls: await callTexts(),
    bubbles: await jsonInBubbles(),
    bubbleText: await bubbles(),
    props: await propCount(),
    tools: await toolTexts(),
  };
  check('★2 ⭐OpenAI 兼容线的原生调用（`delta.tool_calls` 分片 + 两个 index）**真跑**：两条回执、一个「用到动作」行',
    r2.receipts === 2 && r2.calls.some((c) => c.indexOf('read_file ×2') >= 0),
    { receipts: r2.receipts, calls: r2.calls });
  /* ⭐ 分片攒起来的参数必须**真管用**（回执里得有文件正文）—— 只数回执条数会把"args 拼成空"放过去 */
  check('★2e ⭐分片拼出来的 `arguments` 真读到了那两份文件（回执里有正文，不是"缺参数"的报错）',
    r2.tools.indexOf('第 1 份材料') >= 0 && r2.tools.indexOf('第 2 份材料') >= 0,
    { tail: r2.tools.slice(-200) });
  check('★2b ⭐请求体里真带了 `tools`（结构化清单：read_file / list_files 都在）',
    ((await reqAt(0)) || { tools: 0, toolsSample: '' }).tools >= 10
      && ((await reqAt(0)) || { toolsSample: '' }).toolsSample.indexOf('read_file') >= 0
      && ((await reqAt(0)) || { toolsSample: '' }).toolsSample.indexOf('list_files') >= 0,
    { n: ((await reqAt(0)) || { tools: 0 }).tools, sample: ((await reqAt(0)) || { toolsSample: '' }).toolsSample.slice(0, 90) });
  /* 落进历史的那条助手消息仍是**文本协议**：一行一个纯 JSON（渲染/折叠/回执/下一轮全不用改） */
  const nilReq = { msgs: [], tools: 0, toolsSample: '' };
  const req1 = (await reqAt(1)) || nilReq;
  const hist2 = req1.msgs.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
  check('★2c ⭐历史仍按文本协议存（助手那条 = 一行一个纯 JSON）—— sessions.json 格式一个字没改',
    hist2.indexOf('{"tool":"read_file"') >= 0 && hist2.split('\n').filter((l) => l.trim().startsWith('{')).length === 2,
    { hist: hist2.slice(0, 200) });
  check('★2d 原生调用一个字都没进 AI 气泡（气泡里只有它真说的那句话）',
    r2.bubbles.n === 0 && r2.bubbleText.indexOf('两份材料我都读过了') >= 0 && r2.props === 0,
    { bubbles: r2.bubbles, text: r2.bubbleText.slice(-120), props: r2.props });

  /* ---------- ③ Ollama 原生线：整包 `message.tool_calls`、arguments 是**对象** ---------- */
  await setFix([
    { chunks: [
      { model: 'lk-e2e', done: false, message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: files[1] } } }] } },
      { model: 'lk-e2e', done: true, done_reason: 'stop', message: { role: 'assistant', content: '' } },
    ] },
    { chunks: [
      { model: 'lk-e2e', done: false, message: { role: 'assistant', content: '又看了一遍第二份。' } },
      { model: 'lk-e2e', done: true, done_reason: 'stop', message: { role: 'assistant', content: '' } },
    ] },
  ]);
  const t3 = await toolCount();
  await ask('再看一眼第二份。');
  const r3 = { receipts: (await toolCount()) - t3, bubbles: await jsonInBubbles(), bubbleText: await bubbles(), tools: await toolTexts() };
  check('★3 ⭐Ollama 原生线（整包 tool_calls、`arguments` 是对象）也真跑',
    r3.receipts === 1 && r3.bubbles.n === 0 && r3.bubbleText.indexOf('又看了一遍第二份') >= 0
      && r3.tools.indexOf('第 2 份材料') >= 0,
    r3);

  /* ---------- ④ 端点不认 `tools`（400）⇒ 去掉清单重试一次，退回文本协议 ---------- */
  const textJson = JSON.stringify({ tool: 'read_file', args: { path: files[0] } });
  await setFix([
    { status: 400, chunks: [] },
    { chunks: [
      { model: 'lk-e2e', choices: [{ index: 0, delta: { content: textJson }, finish_reason: null }], done: false },
      { model: 'lk-e2e', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], done: true },
    ] },
    { chunks: [
      { model: 'lk-e2e', choices: [{ index: 0, delta: { content: '退回文本协议也读到了。' }, finish_reason: null }], done: false },
      { model: 'lk-e2e', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], done: true },
    ] },
  ]);
  const t4 = await toolCount();
  await ask('再读一次第一份。', 2400);
  const r4 = { receipts: (await toolCount()) - t4, reqs: await reqs(),
    first: (await reqAt(0)) || nilReq, second: (await reqAt(1)) || nilReq, tools: await toolTexts() };
  check('★4 ⭐端点 400 不认 `tools` ⇒ 去掉清单**重试一次**（第二次请求体里没有 tools）',
    r4.reqs >= 3 && r4.first.tools >= 10 && r4.second.tools === 0,
    { reqs: r4.reqs, firstTools: r4.first.tools, secondTools: r4.second.tools });
  check('★4b 重试之后的**文本协议**照样跑（回执 +1 且真读到文件）',
    r4.receipts === 1 && r4.tools.indexOf('第 1 份材料') >= 0, { receipts: r4.receipts });

  /* ---------- ⑤ 原生调用认不出（工具名写错）⇒ 通报 + 纠正一次 ---------- */
  await setFix([
    { chunks: [
      { model: 'lk-e2e', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c9', function: { name: 'fly_to_moon', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], done: false },
      { model: 'lk-e2e', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], done: true },
    ] },
    { chunks: [
      { model: 'lk-e2e', choices: [{ index: 0, delta: { content: '好，我用 JSON 行重说。' }, finish_reason: null }], done: false },
      { model: 'lk-e2e', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], done: true },
    ] },
  ]);
  await ask('你随便做点什么。', 2400);
  const r5 = await ev(`(function () {
    const t = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__tool')];
    const last = t[t.length - 1];
    return { lastTool: last ? (last.textContent || '').slice(0, 160) : '', props: document.querySelectorAll('#lk-agent-msgs [data-prop-ok]').length };
  })()`);
  const fed5 = await ev(`(function () { const l = window.__lkFetchLog; const m = (l[l.length - 1] || {}).msgs || []; return m.map(function (x) { return String(x.content || ''); }).join('\\n'); })()`);
  check('★5 ⭐原生调用一条都认不出 ⇒ 通报「未执行」+ 一次「格式提醒」纠正（不许静默吞）',
    r5.lastTool.indexOf('未执行') >= 0 && r5.lastTool.indexOf('fly_to_moon') >= 0 && fed5.indexOf('fly_to_moon') >= 0,
    { lastTool: r5.lastTool, fed: fed5.slice(-200) });
  check('★5b 认不出的原生调用不出提议卡片（没执行就是没执行）', r5.props === 0, { props: r5.props });

  const errs = await ev(`window.__errs`);
  check('★6 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const pass = results.filter(Boolean).length;
  console.log(`==== ${pass}/${results.length} PASS ====`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
