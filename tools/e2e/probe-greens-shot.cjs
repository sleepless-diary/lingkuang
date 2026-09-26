/* probe-greens-shot.cjs —— 把某一屏**截下来看**，并打印所有 accent（荧光绿）元素的几何/颜色
 *
 * 用户 2026-09-26 两次都指向"荧光绿太多、分不清"：
 *   ① 助手面板生成中：「两个都是高亮度我有点难分辨」⇒ 三颗小绿点（报告里的 `panel` 目标）
 *   ② AI 页那一头：「主会话 / 模式 聊天 Agent / 聊天：能查也能改…」这里面有三处荧光绿
 *
 * 用法：
 *   node tools\e2e\probe-greens-shot.cjs            # 默认：助手面板"生成中"那一屏
 *   node tools\e2e\probe-greens-shot.cjs ai         # AI 页那一头（#ai-head）
 *
 * ⚠️ 判据基准色**从页面上取**（AI 页 = `#ai-send` 发送按钮的颜色，面板 = 流式光标），
 *    不写死 —— 主题/令牌一改，探针自己跟着走。
 * ⚠️ 本文件在 Node 侧，随意用反引号；被 `ev()` 求值的那段字符串里不许出现反引号或 ${。
 */
const PORT = process.env.LK_CDP_PORT || '9346';
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TARGET = (process.argv[2] || 'panel') === 'ai' ? 'ai' : 'panel';

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
  w.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params) => new Promise((res) => { const id = ++seq; pending.set(id, res); w.send(JSON.stringify({ id, method, params: params || {} })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const ex = r.result && r.result.exceptionDetails;
    if (ex) throw new Error('eval: ' + ((ex.exception && ex.exception.description) || ex.text));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Page.enable', {});
  await sleep(1500);

  const shot = async (file, clip) => {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: clip });
    const b = r.result && r.result.data;
    if (!b) { console.log('FAIL 截图没数据'); return; }
    fs.writeFileSync(file, Buffer.from(b, 'base64'));
    console.log('截图: ' + file);
  };
  const outPng = path.join(process.env.TEMP || '.', 'lk-greens-' + TARGET + '.png');

  if (TARGET === 'ai') {
    /* ── AI 页那一头：数 #ai-head 里所有"颜色/边框/底色 = 基准绿"的元素 ───────────── */
    await ev('(function () { const b = document.querySelector("#lk-toolbar [data-tool=\\"ai\\"]"); if (b) b.click(); return !!b; })()');
    await sleep(1600);
    const g = await ev(`(function () {
      const head = document.getElementById('ai-head');
      if (!head) return { has: false };
      const send = document.getElementById('ai-send');
      const ref = send ? getComputedStyle(send).color : 'rgb(158, 194, 98)';
      const items = [];
      const all = head.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const cs = getComputedStyle(el);
        const hit = [];
        if (cs.color === ref) hit.push('文字');
        if (cs.borderTopColor === ref || cs.borderLeftColor === ref) hit.push('边框');
        if (cs.backgroundColor === ref) hit.push('底色');
        if (!hit.length) continue;
        const r = el.getBoundingClientRect();
        items.push({
          tag: el.tagName.toLowerCase(), id: el.id || null,
          txt: (el.textContent || '').replace(/\\s+/g, ' ').slice(0, 22),
          hit: hit.join('+'), w: Math.round(r.width), h: Math.round(r.height),
        });
      }
      const hr = head.getBoundingClientRect();
      return { has: true, ref: ref, n: items.length, items: items,
        clip: { x: Math.max(0, hr.left - 6), y: Math.max(0, hr.top - 6), width: hr.width + 12, height: hr.height + 12 } };
    })()`);
    console.log('== AI 页 #ai-head 里的荧光绿（基准 = 发送按钮颜色 ' + (g && g.ref) + '）==');
    if (g && g.items) { for (const it of g.items) console.log('  ' + JSON.stringify(it)); }
    console.log('合计: ' + (g ? g.n : '?') + ' 处');
    if (g && g.clip) await shot(outPng, { x: g.clip.x, y: g.clip.y, width: g.clip.width, height: g.clip.height, scale: 2 });
    process.exit(0);
  }

  /* ── 助手面板"生成中"那一屏 ─────────────────────────────────────────────── */
  await ev('(function () { const b = document.querySelector("#lk-toolbar [data-tool=\\"codex\\"]"); if (b) b.click(); return true; })()');
  await sleep(1500);
  await ev('(function () { const r = document.querySelector("#cx-list [data-cx-id]"); if (r) r.click(); return true; })()');
  await sleep(400);
  await ev('window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })); true');
  await sleep(900);
  /* 切到 Agent 模式：这时标题前那颗静态绿点才会出现（与思考的闪烁绿点同屏） */
  await ev('(function () { const b = document.getElementById("lk-agent-mode-agent"); if (b) b.click(); return !!b; })()');
  await sleep(400);

  const greens = () => ev(`(function () {
    const out = [];
    const push = (name, el, pseudo) => {
      if (!el) { out.push({ name: name, absent: true }); return; }
      const cs = getComputedStyle(el, pseudo || null);
      const r = el.getBoundingClientRect();
      out.push({
        name: name,
        bg: cs.backgroundColor, color: cs.color, border: cs.borderLeftColor,
        w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
        x: Math.round(r.left), y: Math.round(r.top),
        visible: r.width > 0 && r.height > 0 && cs.display !== 'none',
      });
    };
    const panel = document.getElementById('lk-agent-panel');
    push('1 标题模式圆点 ::before', panel && panel.querySelector('.lk-agent__title'), '::before');
    const live = panel && panel.querySelector('.lk-think.is-live');
    push('2 思考中闪点 ::after', live && live.querySelector('.lk-think__sum'), '::after');
    push('3 流式光标', panel && panel.querySelector('.lk-md__caret'));
    push('.. 模式按钮(agent)', panel && panel.querySelector('#lk-agent-mode-agent'));
    push('.. 左边缘(面板)', panel);
    return out;
  })()`);

  const LONG = '这是一段用来撑高度的正文。'.repeat(12);
  console.log('== ① 先灌 3 条历史，让列表有内容 ==');
  for (let i = 1; i <= 3; i++) {
    await ev('window.__lkAgentMock = ' + JSON.stringify('[灌历史 ' + i + '] ' + LONG) + '; true');
    await ev('(function () { const t = document.getElementById("lk-agent-input"); t.value = "灌历史 ' + i + '"; document.getElementById("lk-agent-send").click(); return true; })()');
    await sleep(700);
  }

  console.log('== ② 发一条「边想边写」（假引擎 12 片思考 + 1 片正文，gap 500）==');
  const piece = '让我把这件事想清楚：先看用户要什么，再看手里有哪些线索，然后一条条对起来。';
  const RSN = [];
  for (let i = 0; i < 12; i++) RSN.push(piece);
  await ev('window.__lkAgentMock = { chunks: ["结论如下。"], reasoning: ' + JSON.stringify(RSN) + ', gap: 500 }; true');
  await ev('(function () { const t = document.getElementById("lk-agent-input"); t.value = "带长思考再说一次。"; document.getElementById("lk-agent-send").click(); return true; })()');
  await sleep(2200);

  const g = await greens();
  console.log('== ③ 生成中：accent 绿元素 ==');
  for (const it of g) console.log('  ' + JSON.stringify(it));

  const rect = await ev('(function () { const p = document.getElementById("lk-agent-panel"); if (!p) return null; const r = p.getBoundingClientRect(); return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8), width: r.width + 16, height: r.height + 16 }; })()');
  if (rect) await shot(outPng, { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 2 });
  console.log('生成中读数: ' + JSON.stringify({ ok: true, png: outPng, greens: g.length }));
  process.exit(0);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : String(e))); process.exit(2); });
