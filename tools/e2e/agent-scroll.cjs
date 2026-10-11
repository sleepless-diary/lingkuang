/* agent-scroll.cjs —— 流式输出时的**滚动纪律** + 「这一轮的提问不许丢」
 *
 * 用户原话（2026-10-11）：「**输出的时候划不动对话列表**」「**流式输出的时候只能看到最顶部，
 * 底下的新内容被截断了**」「**部分思考内容被当成正文了**」。
 *
 * 前两条的本体在 `src/ui/chat-live.ts`：
 *   ① 每来一片增量就 `scrollTop = scrollHeight` ⇒ 创作者往回翻的每一帧都被拽回底部（＝划不动）；
 *   ② 思考块自己那个 `max-height:240px; overflow-y:auto` 的滚动盒（`.lk-think__body`）从来没被滚过
 *      ⇒ 思考超过 240px 就只能看见最顶部，底下新长出来的全在裁剪区外。
 *   修法是「**贴底才跟**」＋「思考块内外一起跟」。
 *
 * 第三条的真因不在渲染而在**发送窗口**（`src/ui/agent.ts` 的 `sentHistory()`）：
 *   工具循环每跑一个动作都往历史里推一条 `user` 角色的【动作结果】，`HISTORY_SEND = 16` 条的窗口
 *   尾部因此可能一条人话都没有 —— 真机会话里模型面对一屏"我自己的动作"只能猜"创作者想干什么"，
 *   于是把这段自言自语当正文答了出来（`%APPDATA%\lingkuang\agent\sessions.json` 那条 812 字的 content）。
 *   修法：窗口里没有创作者的话时，把最近那句提问补回最前面（runTurn 再用本轮原文兜一层）。
 *
 * 假引擎：`window.__lkAgentMock`（见 `src/ui/agent-model.ts`）。流式那一段用**分片形态**
 *   `{ reasoning: [...], chunks: [...], gap }`（思考先喂完、再喂正文），采样期间读 DOM 实测值。
 *
 * 前置（同一 pwsh 调用里做，再重启实例）：
 *   $env:LINGKUANG_TEST_DATA=<root>\worldbuilding.json; $env:LINGKUANG_VAULT=<root>\vault
 *   $env:LINGKUANG_TEST_USERDATA=<root>\userdata
 *   node tools\e2e\reset-entity-vault.cjs; node tools\e2e\seed-node.cjs
 * 跑：$env:LK_CDP_PORT=9500; node tools\e2e\agent-scroll.cjs
 */
const PORT = process.env.LK_CDP_PORT || '9500';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(n, ok, extra) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);
}

/* 采样时读的那一格：消息列 / 思考块（details + 它自己的滚动盒）/ 最后一条 AI 气泡的正文长度 */
const SAMPLE = `(function () {
  const m = document.getElementById('lk-agent-msgs');
  const d = document.querySelector('#lk-agent-msgs details.lk-think');
  const b = d ? d.querySelector('.lk-think__body') : null;
  const bb = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')];
  return {
    st: m.scrollTop, sh: m.scrollHeight, ch: m.clientHeight,
    hasThink: !!d, live: d ? d.classList.contains('is-live') : null,
    bst: b ? b.scrollTop : -1, bsh: b ? b.scrollHeight : -1, bch: b ? b.clientHeight : -1,
    blen: bb.length ? bb[bb.length - 1].textContent.length : -1,
  };
})()`;

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
  /* ⚠️ 15s 超时：渲染进程某句 await 永不落定时，宁可这套件红一次，也别静静吊死 */
  const ev = async (expr, timeout = 15000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
      sleep(timeout).then(() => { throw new Error('eval 超时 ' + timeout + 'ms'); }),
    ]);
    const ex = r.result && r.result.exceptionDetails;
    if (ex) throw new Error('eval: ' + ((ex.exception && ex.exception.description) || ex.text));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  try {
    await sleep(1500);
    await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
    /* 起点摆正：上一份套件可能把面板留着开着（那样 Ctrl+K 反而会关掉它） */
    await ev(`(function () { const b = document.getElementById('lk-agent-close'); if (b) b.click(); return true; })()`);
    await sleep(400);
    const pre = await ev(`({
      tools: [...document.querySelectorAll('#lk-toolbar .lk-tool-btn')].map((b) => b.dataset.tool),
      panel: !!document.getElementById('lk-agent-panel'),
      msgs: !!document.getElementById('lk-agent-msgs'),
    })`);
    check('★0 前置：工具栏有「助手」、面板还没开、消息区在 DOM 里',
      pre.tools.includes('agent') && pre.panel === false && pre.msgs === false, pre);

    await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
    await sleep(500);

    const ask = async (text) => {
      await ev(`(function () { const t = document.getElementById('lk-agent-input'); t.value = ${JSON.stringify(text)}; document.getElementById('lk-agent-send').click(); return true; })()`);
    };

    /* ── 长流式：思考 40 片（2400 字，远超 240px 的帽）+ 正文 40 片（2400 字，把消息列撑到溢出）── */
    const rChunks = Array.from({ length: 40 }, (_, i) => `第${i}段思考：他在想这件事的来龙去脉，反复权衡要不要先扫目录。\n`);
    const cChunks = Array.from({ length: 40 }, (_, i) => `第${i}段正文：这里是被答出来的话，一个字一个字地长出来。\n`);
    await ev(`window.__lkSeen = []; window.__lkAgentMock = ${JSON.stringify({ reasoning: rChunks, chunks: cChunks, gap: 40 })}; true`);
    await ask('lk-e2e-滚动-2026 请慢慢说');
    await sleep(120);

    /* 采样：每 100ms 读一次 DOM。正文长起来、消息列真的溢出之后，手动往回滚一次（st = 0）——
       这一下就是用户那句「划不动」的动作；修好后它必须**停在那儿**，不许被下一片增量拽回底部。 */
    const samples = [];
    let scrollIdx = -1;
    for (let i = 0; i < 50; i++) {
      const s = await ev(SAMPLE);
      samples.push(s);
      if (scrollIdx < 0 && s.blen > 400 && s.sh - s.ch > 200) {
        await ev(`(function () { document.getElementById('lk-agent-msgs').scrollTop = 0; return true; })()`);
        scrollIdx = samples.length - 1;
      }
      if (!s.live && s.hasThink && s.blen > 400 && samples.length > scrollIdx + 3) break;   /* 落定了 */
      await sleep(100);
    }
    await sleep(600);   /* 落定后的整块重画 */

    const overInner = samples.filter((s) => s.hasThink && s.live === true && s.bsh > s.bch + 40);
    check('★1 长思考真的超过了 240px 的帽（不然 ★2 无从谈起）', overInner.length >= 3,
      { 溢出样本: overInner.length, 总样本: samples.length, 帽: overInner.length ? overInner[0].bch : -1 });
    /* 思考块自己的滚动盒：最后一张"还在长且已经溢出"的采样应当贴着它自己的底部 */
    const lastOver = overInner[overInner.length - 1] || null;
    check('★2 ⭐思考块自己跟着长（旧构建恒为 0＝只能看见最顶部）',
      !!lastOver && lastOver.bst >= lastOver.bsh - lastOver.bch - 24,
      lastOver ? { bst: lastOver.bst, 底部: lastOver.bsh - lastOver.bch, bsh: lastOver.bsh, bch: lastOver.bch } : '没有溢出样本');

    const before = scrollIdx > 0 ? samples[scrollIdx] : null;
    check('★3 往回滚之前，消息列本来贴在底部（★4 的前提）',
      !!before && before.st >= before.sh - before.ch - 24,
      before ? { st: before.st, 底部: before.sh - before.ch, sh: before.sh, ch: before.ch, blen: before.blen } : '没找到回滚点');
    const after = scrollIdx >= 0 && scrollIdx + 2 < samples.length ? samples[scrollIdx + 2] : null;
    check('★4 ⭐往回滚之后不被拽回底部（旧构建：下一帧就回到底部＝划不动）',
      !!after && after.st <= 40,
      after ? { 回滚后st: after.st, 下一帧st: samples[scrollIdx + 1] ? samples[scrollIdx + 1].st : -1, blen: after.blen } : '样本不够');

    /* 落定：思考折叠成一行、正文落在气泡里 */
    const done = await ev(`(function () {
      const d = document.querySelector('#lk-agent-msgs details.lk-think');
      const bb = [...document.querySelectorAll('#lk-agent-msgs .lk-agent__msg.is-ai .lk-agent__bubble')];
      const t = bb.length ? bb[bb.length - 1].textContent : '';
      return { hasThink: !!d, open: d ? d.open : null, live: d ? d.classList.contains('is-live') : null,
               sum: d ? d.querySelector('.lk-think__sum').textContent : '', 含末段: t.indexOf('第39段正文') >= 0,
               含首段: t.indexOf('第0段正文') >= 0, 正文长: t.length };
    })()`);
    check('★5 落定后思考折叠成一行、正文完整落在气泡里',
      done.hasThink && done.open === false && done.live === false && /思考 · \d+ 字/.test(done.sum) &&
      done.正文长 > 900 && done.含首段 && done.含末段, done);

    /* ── ★6：动作结果把 16 条的发送窗口塞满之后，**这一轮的提问仍在**喂给模型的 messages 里 ── */
    const Q = 'lk-e2e-窗口提问-2026 把整个库扫一遍';
    const q = ['{"tool":"list_entities","args":{}}'];
    for (let i = 0; i < 13; i++) q.push('{"tool":"list_entities","args":{}}');
    q.push('扫完了。');
    await ev(`window.__lkSeen = []; window.__lkMockQ = ${JSON.stringify(q)}; window.__lkAgentMock = (m) => { window.__lkSeen.push(m); return window.__lkMockQ.length ? window.__lkMockQ.shift() : '好的。'; }; true`);
    await ask(Q);
    /* 每轮 2 条消息（助手那条动作 + 一条【动作结果】）⇒ 13 轮之后窗口尾部全是机器消息 */
    for (let i = 0; i < 90; i++) {
      await sleep(200);
      const n = await ev(`window.__lkSeen.length`);
      if (n >= 15) break;
    }
    await sleep(1500);
    const win = await ev(`(function () {
      const seen = window.__lkSeen;
      const last = seen[seen.length - 1] || [];
      const machines = last.filter((m) => m.role === 'user' && /^【(动作结果|格式提醒)/.test(String(m.content))).length;
      const at = last.findIndex((m) => m.role === 'user' && String(m.content) === ${JSON.stringify(Q)});
      return { 调用次数: seen.length, 末次条数: last.length, 机器消息: machines, 提问位置: at, 系统: last.filter((m) => m.role === 'system').length,
               角色序: last.map((m) => m.role[0]).join('') };
    })()`);
    /* 窗口本身就是 16 条（`HISTORY_SEND`）⇒ 末次里最多看得到 8 条机器消息；关键是**提问还在不在**：
       跑了十几轮之后它早就掉出 16 条窗口了（旧构建这里恒为 -1）。 */
    check('★6 ⭐动作结果塞满窗口后，创作者那句提问仍然发给了模型（旧构建：窗口里一条人话都没有）',
      win.调用次数 >= 12 && win.机器消息 >= 8 && win.提问位置 === 1, win);

    const errs = await ev(`window.__errs`);
    check('★7 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

    const bad = results.filter((x) => !x).length;
    console.log(`\n${results.length - bad}/${results.length} PASS`);
    process.exit(bad ? 1 : 0);
  } catch (e) {
    check('脚本异常: ' + (e && e.message), false);
    console.log(`\n${results.filter((x) => x).length}/${results.length} PASS`);
    process.exit(2);
  }
}

main();
