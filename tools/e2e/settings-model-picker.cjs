/* 不变量：设置里的「模型」是**从端点问来的清单里挑**，不再手打模型名
 * （用户 2026-09-26：「设置里面的 ai 选择能不能改成像 dsh 里面的模型选择一样」）。
 *
 * 参考实现是 DSH 的 ModelListEditor（`@deepseek-ai/dsh-client-ui-settings-models`）那套分寸：
 *   ① 去问端点「你到底提供哪些模型」（Ollama `/api/tags` / OpenAI 兼容 `/models`）；
 *   ② 拿回来的是**候选**，点一下才成为配置 —— 探测绝不背着你写配置；
 *   ③ 端点问不出来**不是死路**：把失败原因显示在还能手填的那一行旁边。
 * 本套件用 stub 掉 `window.fetch` 的方式把①的结果端到端喂进去（不依赖本机真装着 Ollama）。
 *
 * A/B：旧构建上 ★1 起全 FAIL（`hasOldInput: true`、没有 `#set-model-btn`）—— 那时这里是个手打文本框。
 *
 * 用法：`node tools/e2e/reset-entity-vault.cjs` + `node tools/e2e/seed-node.cjs` → 起应用 →
 * `LK_CDP_PORT=9346 node tools/e2e/settings-model-picker.cjs`
 */
const PORT = process.env.LK_CDP_PORT || '9346';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }

/* 清单端点 stub：只截 /api/tags，其余（真发模型请求那些）原样放过去。
   ⚠️ 下面的页面代码住在模板串里 —— 里面不许出现反引号或 ${。 */
const INSTALL_STUB = `(() => {
  window.__origFetch = window.fetch;
  window.__fetchLog = [];
  window.__authLog = [];
  window.__stubFail = false;
  window.fetch = function (url, init) {
    var u = String(url);
    window.__fetchLog.push(u);
    var isTags = u.indexOf('/api/tags') >= 0;
    var isModels = u.indexOf('/models') >= 0;
    if (!isTags && !isModels) return window.__origFetch(url, init);
    window.__authLog.push(String((init && init.headers && init.headers.Authorization) || ''));
    if (window.__stubFail) return Promise.resolve(new Response('{"error":"boom"}', { status: 500, headers: { 'Content-Type': 'application/json' } }));
    var tags = '{"models":[' +
      '{"name":"qwen2.5:3b","size":1932735283,"details":{"parameter_size":"3B","quantization_level":"Q4_K_M"}},' +
      '{"name":"qwen2.5:7b","size":4660000000,"details":{"parameter_size":"7B","quantization_level":"Q4_K_M"}},' +
      '{"name":"llama3.2:latest","size":2000000000,"details":{"parameter_size":"3B","quantization_level":"Q4_0"}}]}';
    var models = '{"data":[{"id":"gpt-4o-mini","owned_by":"openai"},{"id":"deepseek-chat","owned_by":"deepseek"}]}';
    return Promise.resolve(new Response(isTags ? tags : models, { status: 200, headers: { 'Content-Type': 'application/json' } }));
  };
  try { localStorage.removeItem('lingkuang-model-cache'); } catch (e) {}
  return true;
})()`;

const SNAP = `(() => {
  const rows = [...document.querySelectorAll('#set-model-list .lk-set-model-row')].map(function (el) {
    var spans = el.querySelectorAll('span');
    return { id: el.dataset.model, meta: spans.length ? spans[spans.length - 1].textContent : '' };
  });
  const menu = document.getElementById('set-model-menu');
  const cur = document.getElementById('set-model-cur');
  const hint = document.getElementById('set-model-hint');
  return {
    hasBtn: !!document.getElementById('set-model-btn'),
    hasOldInput: !!document.getElementById('set-model'),
    hasRefresh: !!document.getElementById('set-model-refresh'),
    hasSearch: !!document.getElementById('set-model-search'),
    hasManual: !!document.getElementById('set-model-manual'),
    hasManualOk: !!document.getElementById('set-model-manual-ok'),
    menuShown: menu ? getComputedStyle(menu).display !== 'none' : null,
    cur: cur ? cur.textContent : '',
    hint: hint ? hint.textContent : '',
    rows: rows,
    ids: rows.map(function (r) { return r.id; }),
    saved: (function () { try { return JSON.parse(localStorage.getItem('lingkuang-settings') || '{}').model || ''; } catch (e) { return ''; } })(),
    cache: !!localStorage.getItem('lingkuang-model-cache'),
  };
})()`;

const T2 = '★2 点开催端点（/api/tags）并把清单渲染成可点的行（端点报的 3 个都在，带参数量那些小字）';
const T3 = '★3 搜索框按名字过滤（输入 3b 只剩那一行）';
const T4 = '★4 点一行 ⇒ 触发器换成它、菜单收起；点「保存设置」后 localStorage 里就是它';
const T5 = '★5 端点报错（http 500）⇒ 把失败原因写在旁边，清单不消失（缓存里那 3 个还在）';
const T6 = '★6 手填兜底：端点连不上也能用手填的名字（「用这个」⇒ 成为当前模型）';
const T7 = '★7 换成 OpenAI 兼容模式后问的是 /models（不是 /api/tags）且带上 API Key，清单按 data[].id 渲染';

async function main() {
  let target = null;
  for (let i = 0; i < 120; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (target) break; } catch {}
    await sleep(200);
  }
  if (!target) { console.log(`FAIL 无法连接 CDP ${PORT}`); process.exit(1); }
  const w = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; });
  let id = 0; const pending = new Map();
  w.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); w.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  const snap = () => ev(SNAP);
  async function waitFor(pred, ms = 2500) {
    const t0 = Date.now();
    for (;;) {
      const s = await snap();
      if (pred(s)) return s;
      if (Date.now() - t0 > ms) return s;
      await sleep(120);
    }
  }

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(INSTALL_STUB);

  /* ── 前置：设置面板开出来 ── */
  const opened = await ev(`(() => {
    const b = [...document.querySelectorAll('#lk-toolbar .lk-tool-btn')].find((x) => x.dataset.tool === 'settings');
    if (b) b.click();
    return { btn: !!b, panel: !!document.getElementById('lk-settings-panel'), body: !!document.getElementById('lk-set-body') };
  })()`);
  await sleep(500);
  const pre = await snap();
  check('★0 前置：设置面板开出来了，「模型」那一栏在面板里',
    opened.btn === true && opened.panel === true && opened.body === true && pre.hasBtn === true, { opened, hasBtn: pre.hasBtn });

  /* ── ① 结构：不是手打文本框，而是「触发按钮 + 刷新 + 菜单（搜索/清单/手填）」 ── */
  check('★1 「模型」不再是手打文本框，而是选择器（触发器 + 刷新；菜单里有搜索与手填兜底）',
    pre.hasBtn === true && pre.hasOldInput === false && pre.hasRefresh === true
      && pre.hasSearch === true && pre.hasManual === true && pre.hasManualOk === true && pre.menuShown === false,
    { hasBtn: pre.hasBtn, hasOldInput: pre.hasOldInput, hasRefresh: pre.hasRefresh, hasSearch: pre.hasSearch, hasManual: pre.hasManual, menuShown: pre.menuShown });

  /* 旧构建（手打文本框）上没有选择器：剩下的一律记 FAIL 并跳过 ——
     别让套件崩在 null.click 上（那样只有一行报错，看不出"哪几条"没过）。 */
  if (pre.hasBtn !== true) {
    for (const t of [T2, T3, T4, T5, T6, T7]) check(t, false, { reason: '旧构建：没有模型选择器（那时是个手打文本框）' });
  } else {
    /* ── ② 点开 ⇒ 去问端点，清单按端点返回渲染出来 ── */
    await ev(`document.getElementById('set-model-btn').click(); true`);
    const listed = await waitFor((s) => s.ids.indexOf('qwen2.5:3b') >= 0 && s.ids.indexOf('llama3.2:latest') >= 0);
    const asked = await ev(`window.__fetchLog.filter((u) => u.indexOf('/api/tags') >= 0)`);
    check(T2,
      listed.menuShown === true && listed.ids.indexOf('qwen2.5:3b') >= 0 && listed.ids.indexOf('qwen2.5:7b') >= 0
        && listed.ids.indexOf('llama3.2:latest') >= 0 && asked.length >= 1
        && listed.rows.some((r) => r.id === 'qwen2.5:3b' && r.meta.indexOf('3B') >= 0)
        && listed.rows.some((r) => r.meta === '当前在用'),
      { asked: asked, ids: listed.ids, metas: listed.rows.map((r) => r.id + '=' + r.meta), hint: listed.hint });

    /* ── ③ 搜索过滤 ── */
    await ev(`(() => { const s = document.getElementById('set-model-search'); s.value = '3b'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(150);
    const filtered = await snap();
    check(T3, filtered.ids.length === 1 && filtered.ids[0] === 'qwen2.5:3b', { ids: filtered.ids });

    /* ── ④ 点一行 ⇒ 成为当前模型；「保存设置」后落盘 ── */
    await ev(`(() => { const r = [...document.querySelectorAll('#set-model-list .lk-set-model-row')].find((x) => x.dataset.model === 'qwen2.5:3b'); if (r) r.click(); return !!r; })()`);
    await sleep(200);
    const picked = await snap();
    await ev(`document.getElementById('set-save').click(); true`);
    await sleep(200);
    const afterSave = await snap();
    check(T4,
      picked.cur === 'qwen2.5:3b' && picked.menuShown === false && afterSave.saved === 'qwen2.5:3b',
      { cur: picked.cur, menuShown: picked.menuShown, saved: afterSave.saved });

    /* ── ⑤ 端点连不上 ⇒ 显示原因，且上次那份清单不消失（缓存兜底） ──
       ⚠️ 先把 ★3 那个搜索词清掉：不清的话单子仍被 '3b' 过滤着，看着像"清单没了"（假 FAIL）。 */
    await ev(`window.__stubFail = true; true`);
    await ev(`document.getElementById('set-model-btn').click(); true`);
    await ev(`(() => { const s = document.getElementById('set-model-search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await ev(`document.getElementById('set-model-refresh').click(); true`);
    const failed = await waitFor((s) => s.hint.indexOf('拉取失败') >= 0, 3000);
    check(T5,
      failed.hint.indexOf('拉取失败') >= 0 && failed.hint.indexOf('500') >= 0
        && failed.ids.indexOf('qwen2.5:7b') >= 0 && failed.ids.indexOf('llama3.2:latest') >= 0,
      { hint: failed.hint, ids: failed.ids });

    /* ── ⑥ 手填兜底：端点问不出来也照样能用一个外面的模型名 ── */
    await ev(`(() => { const m = document.getElementById('set-model-manual'); m.value = 'my-own-model'; document.getElementById('set-model-manual-ok').click(); return true; })()`);
    await sleep(150);
    const manual = await snap();
    await ev(`document.getElementById('set-save').click(); true`);
    await sleep(200);
    const manualSaved = await snap();
    /* 再点开一次：手填的那个名字应当作为「当前在用」留在单子上
       （点选的瞬间菜单会收起，所以不能在点完当帧读单子） */
    await ev(`document.getElementById('set-model-btn').click(); true`);
    await sleep(200);
    const manualList = await snap();
    check(T6,
      manual.cur === 'my-own-model' && manualSaved.saved === 'my-own-model' && manualList.ids.indexOf('my-own-model') >= 0,
      { cur: manual.cur, saved: manualSaved.saved, ids: manualList.ids });

    /* ── ⑦ 换成 OpenAI 兼容模式：问的端点与解析方式都跟着换（/models + Bearer） ── */
    await ev(`(() => {
      window.__stubFail = false;
      const api = document.querySelector('input[name="aiMode"][value="api"]');
      api.checked = true; api.dispatchEvent(new Event('change', { bubbles: true }));
      const bu = document.getElementById('set-baseurl'); bu.value = 'https://example.test/v1'; bu.dispatchEvent(new Event('input', { bubbles: true }));
      const ak = document.getElementById('set-apikey'); ak.value = 'sk-test'; ak.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await ev(`document.getElementById('set-model-refresh').click(); true`);
    const apiList = await waitFor((s) => s.ids.indexOf('gpt-4o-mini') >= 0, 3000);
    const apiAsked = await ev(`window.__fetchLog.filter((u) => u.indexOf('/models') >= 0)`);
    const apiAuth = await ev(`window.__authLog`);
    check(T7,
      apiList.ids.indexOf('gpt-4o-mini') >= 0 && apiList.ids.indexOf('deepseek-chat') >= 0
        && apiAsked.indexOf('https://example.test/v1/models') >= 0 && apiAuth.indexOf('Bearer sk-test') >= 0,
      { ids: apiList.ids, asked: apiAsked, auth: apiAuth });
  }

  /* ── ⑧ 无异常 ── */
  const errs = await ev(`window.__errs`);
  check('★8 全程无未捕获异常', Array.isArray(errs) && errs.length === 0, { errs: errs });

  await ev(`window.fetch = window.__origFetch; true`);
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} PASS`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.log('套件崩了：' + (e && e.stack || e)); process.exit(2); });
