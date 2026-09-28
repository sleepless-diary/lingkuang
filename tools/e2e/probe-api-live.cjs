/* probe-api-live.cjs —— 端到端确认「API 那条路」在真界面上是通的（真端点、真 key、真模型）。
 *
 * 为什么要有它：`assoc-reasoning.cjs` 的 fetch 是回放的，`probe-assoc-live.cjs` 用的是**用户档案里那把**
 * key。要验证一把**新的** key（比如用户换了 key 之后）就得能把 key 直接喂进来 —— 这一支就是干这个的：
 *   ① 灵感触发器：点一个词 ⇒ 真实联想出词（走 `src/ui/ai.ts` 的统一出口）
 *   ② 灵框助手：Ctrl+K 发一句 ⇒ 真拿到回复（同一条出口，另一条 UI 路）
 *
 * key 来源（**绝不落进仓库、也不打印**）：
 *   · 环境变量 `LK_TEST_KEY`，或
 *   · `%TEMP%\lk-test-key.txt`（一行，纯 key）
 * 只写**隔离测试实例**（LINGKUANG_TEST_USERDATA）的 localStorage，不碰正式实例与真实数据。
 *
 * 跑（测试实例须在 `--remote-debugging-port=9500` 上跑着）：
 *   node tools\e2e\probe-api-live.cjs [模型名] [联想词]
 * 判据：末行 `API LIVE OK`，且两段各自报出真结果。 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.LK_CDP_PORT || '9500';
const MODEL = process.argv[2] || 'deepseek-flash';
const WORD = process.argv[3] || '雪原';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readKey() {
  if (process.env.LK_TEST_KEY) return process.env.LK_TEST_KEY.trim();
  const f = path.join(os.tmpdir(), 'lk-test-key.txt');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  throw new Error('没拿到 key：设 $env:LK_TEST_KEY 或写 ' + f);
}

(async () => {
  const key = readKey();
  console.log(`用一把新 key（***${key.slice(-4)}）打真端点：https://api.deepseek.com/v1 · ${MODEL}`);

  let target = null;
  for (let i = 0; i < 60; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (target) break; } catch {}
    await sleep(200);
  }
  if (!target) throw new Error('CDP 没上（' + PORT + '）');
  const w = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; });
  let id = 0; const pending = new Map();
  w.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (m, params) => new Promise((res) => { const i = ++id; pending.set(i, res); w.send(JSON.stringify({ id: i, method: m, params })); });
  const evSoft = async (expr) => { try { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; } catch { return undefined; } };
  const waitFor = async (expr, tries = 80) => { for (let i = 0; i < tries; i++) { if (await evSoft(expr)) return true; await sleep(250); } return false; };

  /* ── 把这份供应商灌进隔离实例 ── */
  const provider = { id: 'e2e-api', name: 'DeepSeek', preset: 'deepseek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: key, model: MODEL };
  await send('Page.enable', {});
  await evSoft(`(() => { const s = JSON.parse(localStorage.getItem('lingkuang-settings') || '{}');
    s.providers = [${JSON.stringify(provider)}]; s.activeProvider = 'e2e-api';
    localStorage.setItem('lingkuang-settings', JSON.stringify(s)); return true; })()`);
  await send('Page.reload', {});
  await waitFor(`!!document.querySelector('[data-tool="inspire"]')`);
  await evSoft(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);

  /* ── ① 灵感触发器 · 语义联想 ── */
  await evSoft(`document.querySelector('[data-tool="inspire"]').click(); true`);
  await waitFor(`!!document.querySelector('#assoc-stage')`, 60);
  await sleep(400);
  await evSoft(`document.querySelector('#insp-assoc').assocSetRoot(${JSON.stringify(WORD)}); true`);
  let status = '';
  for (let i = 0; i < 160; i++) {
    status = (await evSoft(`(document.querySelector('#assoc-status') || {}).textContent || ''`)) || '';
    if (/联想 [0-9]+ 词|联想失败|还没配/.test(status)) break;
    await sleep(500);
  }
  await sleep(800);
  const assoc = await evSoft(`(() => { const els = [...document.querySelectorAll('#assoc-world .assoc__node')];
    return { status: (document.querySelector('#assoc-status') || {}).textContent, nodes: els.length, words: els.map((e) => e.textContent) }; })()`);
  console.log(`① 灵感触发器 · 语义联想 → 状态行 ${JSON.stringify(assoc.status)} · 子词 ${assoc.nodes} 个 ${JSON.stringify(assoc.words)}`);

  /* ── ② 灵框助手 · 真发一句（同一条 AI 出口的另一条 UI 路） ── */
  await evSoft(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
  const panelUp = await waitFor(`!!document.querySelector('#lk-agent-input')`, 40);
  const chip = await evSoft(`(document.querySelector('#lk-agent-model') || {}).textContent || ''`);
  console.log(`② 助手面板 ${panelUp ? '开了' : '没开'} · 模型 chip = ${JSON.stringify(chip)}`);
  let chat = null;
  if (panelUp) {
    await evSoft(`(() => { const t = document.querySelector('#lk-agent-input'); t.value = '用一句话说说「${WORD}」给人的感觉';
      t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await evSoft(`document.querySelector('#lk-agent-send').click(); true`);
    /* 等**落定**：推理模型先挂一块「正在思考…」，那不算回复 —— 必须等到它不再是思考占位、且正文有实质内容。
       （第一版就在这儿假绿：`last.length > 4` 把「正在思考…」也算过了。） */
    for (let i = 0; i < 240; i++) {
      chat = await evSoft(`(() => { const ms = [...document.querySelectorAll('#lk-agent-msgs > *')];
        const note = (document.querySelector('#lk-agent-note') || {}).textContent || '';
        const text = ms.map((m) => m.textContent).join('\\n');
        const last = ms.length ? ms[ms.length - 1].textContent : '';
        const thinking = /正在思考|生成中/.test(note) || /正在思考…?$/.test(last);
        return { count: ms.length, last: last, note: note, thinking: thinking, text: text }; })()`);
      if (chat && !chat.thinking && chat.count >= 2 && chat.last && chat.last.replace(/\s/g, '').length > 8) break;
      await sleep(500);
    }
    console.log(`② 助手回复 = ${chat && chat.count ? chat.count + ' 段 · 末段 ' + JSON.stringify((chat.last || '').slice(0, 120)) : '(没等到)'}` + (chat && chat.note ? ` · note ${JSON.stringify(chat.note.slice(0, 80))}` : ''));
  }

  const errs = await evSoft(`window.__errs || []`);
  const chatOk = !!(chat && !chat.thinking && chat.count >= 2 && chat.last && chat.last.replace(/\s/g, '').length > 8);
  const ok = !!(assoc && assoc.nodes > 0) && chatOk && (!errs || !errs.length);
  console.log('未捕获异常 = ' + JSON.stringify(errs));
  console.log(ok ? 'API LIVE OK：这把 key 下「语义联想 + 助手对话」两条 UI 路都通了' : 'API LIVE FAIL：有一路没通（见上面两行）');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.log('探针异常：' + (e && e.stack ? e.stack : e)); process.exit(1); });
