/* 设置 · 「本机模型」模版：**换本地模型不再绕圈** 回归 8 项
 *（用户 2026-09-28：「**我本地的所有模型都做成模版放在设置里面**」）
 *
 * 目的（用户选定）＝「换本地模型太麻烦」：原来 `qwen3:32b` ↔ `qwen2.5:7b` 要走
 *   「＋ 添加供应商 → 本地 Ollama → 打开编辑器 → 点模型 → 刷新探测 / 手填」一大圈。
 * 形态（用户选定 A）＝「＋ 添加供应商」菜单里**每个本机模型一条**（`data-local`），
 *   点一下 = 加一家「本地 Ollama · qwen3:32b」并切过去，模型已经选好（`src/ui/settings.ts` 的 `addLocalModel`）。
 * 清单来源 = 问本机 Ollama（`probeModels` → GET `/api/tags`）：打开菜单先吃缓存（端点没开也能选），再后台刷一次。
 *
 * 本套件把 `window.fetch` 换成一个**只截 `/api/tags` 的 stub**（4 个假模型 + 一个"端点坏了"开关），
 * 不连真 Ollama；`lingkuang-model-cache` 每次重装 stub 时清掉，避免上一轮的缓存冒充这一轮的结果。
 *   A/B：旧构建没有 `[data-local]`（菜单里只有静态预设 + 自定义）⇒ ★1~★5 红，新构建全绿。
 *
 * 用法（见 tools/e2e/README.md）：
 *   $env:LINGKUANG_* 指向测试目录 → 起应用（--remote-debugging-port=9500）→ node tools/e2e/settings-local-templates.cjs
 * ⚠️ `data-preset` 是"静态预设清单"的判据（tools/e2e/settings-model-picker.cjs:87 与 ★8/★9）——
 *   本机模版必须走 `data-local`，本套件 ★1 专门盯这条，免得把预设清单污染成"本机模型也算预设"。
 */
const PORT = process.env.LK_CDP_PORT || '9500';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }

/* 端点 stub：只截 /api/tags，其余原样放过去。⚠️ 住在模板串里 —— 里面不许出现反引号或 ${。 */
const stub = (fail, clear) => `(() => {
  window.__origFetch = window.__origFetch || window.fetch;
  window.__stubFail = ${fail ? 'true' : 'false'};
  window.__tagsAsked = 0;
  window.fetch = function (url, init) {
    var u = String(url);
    if (u.indexOf('/api/tags') < 0) return window.__origFetch(url, init);
    window.__tagsAsked++;
    if (window.__stubFail) return Promise.resolve(new Response('{"error":"boom"}', { status: 500, headers: { 'Content-Type': 'application/json' } }));
    var tags = '{"models":[' +
      '{"name":"qwen3:32b","size":20000000000,"details":{"parameter_size":"32.8B","quantization_level":"Q4_K_M"}},' +
      '{"name":"qwen3:14b","size":9200000000,"details":{"parameter_size":"14.8B","quantization_level":"Q4_K_M"}},' +
      '{"name":"qwen2.5:7b","size":4660000000,"details":{"parameter_size":"7.6B","quantization_level":"Q4_K_M"}},' +
      '{"name":"bge-m3:latest","size":1200000000,"details":{"parameter_size":"567M","quantization_level":"F16"}}]}';
    return Promise.resolve(new Response(tags, { status: 200, headers: { 'Content-Type': 'application/json' } }));
  };
  ${clear ? "try { localStorage.removeItem('lingkuang-model-cache'); } catch (e) {}" : ''}
  return true;
})()`;

const SNAP = `(() => {
  var g = function (id) { return document.getElementById(id); };
  var store = {};
  try { store = JSON.parse(localStorage.getItem('lingkuang-settings') || '{}') || {}; } catch (e) { store = {}; }
  var menu = g('set-prov-add-menu');
  return {
    addShown: menu ? getComputedStyle(menu).display !== 'none' : null,
    presets: [].slice.call(document.querySelectorAll('#set-prov-add-menu [data-preset]')).map(function (b) { return b.dataset.preset; }),
    presetsHave: [].slice.call(document.querySelectorAll('#set-prov-add-menu [data-preset]')).map(function (b) {
      return { id: b.dataset.preset, have: b.dataset.have || '', text: b.textContent };
    }),
    locals: [].slice.call(document.querySelectorAll('#set-prov-add-menu [data-local]')).map(function (b) { return { id: b.dataset.local, text: b.textContent }; }),
    rows: [].slice.call(document.querySelectorAll('#set-prov-list > div')).map(function (r) { return { id: r.dataset.prov, text: r.textContent }; }),
    edName: g('set-prov-name') ? g('set-prov-name').value : null,
    edKind: g('set-prov-kind') ? g('set-prov-kind').value : null,
    edBase: g('set-prov-baseurl') ? g('set-prov-baseurl').value : null,
    edKey: g('set-prov-apikey') ? g('set-prov-apikey').value : null,
    cur: g('set-model-cur') ? g('set-model-cur').textContent : null,
    msg: g('set-msg') ? g('set-msg').textContent : null,
    providers: Array.isArray(store.providers) ? store.providers.map(function (p) {
      return { id: p.id, name: p.name, preset: p.preset, kind: p.kind, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model };
    }) : null,
    active: store.activeProvider || '',
    cached: !!localStorage.getItem('lingkuang-model-cache')
  };
})()`;

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
  const evSoft = async (expr) => { try { return await ev(expr); } catch { return undefined; } };
  const snap = () => ev(SNAP);
  const clickSel = (sel) => ev(`(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true;})()`);
  const openPanel = () => clickSel('#lk-toolbar .lk-tool-btn[data-tool="settings"]');
  async function waitFor(pred, ms = 3000, step = 120) {
    const t0 = Date.now();
    for (;;) { const s = await evSoft(SNAP); if (s && pred(s)) return s; if (Date.now() - t0 > ms) return s; await sleep(step); }
  }
  /** 菜单开着就别再点（那一下是"关"） */
  async function openAddMenu() {
    const s = await snap();
    if (s.addShown !== true) { await clickSel('#set-prov-add'); await sleep(250); }
  }
  const clickLocal = (mid) => clickSel(`#set-prov-add-menu [data-local="${mid}"]`);
  const ready = async () => { for (let i = 0; i < 80; i++) { if (await evSoft(`!!document.querySelector('#lk-toolbar .lk-tool-btn[data-tool="settings"]')`)) return true; await sleep(200); } return false; };

  /* ── 起手：清成出厂状态（一家本地 Ollama / 当前在用），重载让设置层重新读一遍 ── */
  await send('Page.enable', {});
  await ev(`try { localStorage.removeItem('lingkuang-settings'); localStorage.removeItem('lingkuang-model-cache'); } catch (e) {} true`);
  await send('Page.reload', {});
  await ready();
  await sleep(800);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(stub(false, true));
  await openPanel();
  await sleep(500);

  const s0 = await snap();
  /* ⚠️ 出厂状态是"默认值"而不是"已落盘"：清掉 `lingkuang-settings` 后要**点过保存**才有 providers 键，
     所以这里看 DOM 那几行，不看 localStorage。 */
  const fresh = s0.rows.length === 1 && s0.rows[0].text.indexOf('本地 Ollama') >= 0
    && s0.rows[0].text.indexOf('qwen2.5:7b') >= 0 && s0.cached === false && s0.providers === null;
  check('★0 前置：出厂就一家「本地 Ollama」（还没落盘）、缓存已清空（这一轮的本机清单只能来自 stub）',
    fresh === true, { rows: s0.rows.map((r) => r.text), cached: s0.cached, providers: s0.providers });

  /* ── ★1 菜单里长出「本机模型」那一段（一行一个本机模型） ── */
  await openAddMenu();
  const s1 = await waitFor((x) => x.locals.length >= 4, 4000);
  const tagsAsked = await evSoft('window.__tagsAsked');
  check('★1 点「＋ 添加供应商」⇒ 问本机 Ollama（/api/tags）并列出 4 个本机模型模版（旧构建没有这一段）',
    s1.locals.length === 4 && s1.locals.some((l) => l.id === 'qwen3:32b') && s1.locals.some((l) => l.id === 'bge-m3:latest')
      && s1.locals.every((l) => l.text.indexOf('本地 Ollama · ') === 0) && (tagsAsked || 0) >= 1,
    { locals: s1.locals, tagsAsked: tagsAsked });
  /* ★1b：本机模版**不许污染静态预设清单**（tests 里 [data-preset] 是预设的判据）。
     ⚠️ 2026-09-28 起预设菜单改成"五家全列"（已加过的标「已有」）⇒ 不能再拿"预设里没有 ollama"当判据，
     该看的是：`[data-preset]` 里出现的 id 只来自 PRESETS —— 本机模版的模型名一个都不许混进去。 */
  check('★1b 本机模版走 data-local，`[data-preset]` 里只有静态预设的 id（本机模版的模型名没混进去）；'
    + '出厂那条 Ollama 在预设里标着「已有」',
    s1.presets.indexOf('deepseek') >= 0 && s1.presets.indexOf('custom') >= 0
      && s1.presets.indexOf('qwen3:32b') < 0 && s1.presets.indexOf('bge-m3:latest') < 0
      && s1.presets.every((pid) => ['ollama', 'deepseek', 'openai', 'siliconflow', 'custom'].indexOf(pid) >= 0)
      && (s1.presetsHave.filter((r) => r.id === 'ollama')[0] || {}).have === 'ollama'
      && s1.locals.some((l) => l.text.indexOf('32.8B') >= 0),
    { presets: s1.presets, presetsHave: s1.presetsHave });

  /* ── ★2 点一行 ⇒ 加一家"模型已选好"的档案并切过去；没点保存就不落盘（草稿语义） ── */
  await clickLocal('qwen3:32b');
  await sleep(400);
  const s2 = await snap();
  const added = s2.rows.filter((r) => r.text.indexOf('qwen3:32b') >= 0);
  check('★2 点「本地 Ollama · qwen3:32b」⇒ 多一家（协议 ollama / 端点 localhost:11434 / 模型 qwen3:32b / 不用 Key）并设为当前在用，编辑卡自动打开',
    s2.rows.length === 2 && added.length === 1 && added[0].text.indexOf('当前在用') >= 0
      && s2.edName === '本地 Ollama · qwen3:32b' && s2.edKind === 'ollama' && s2.edBase === 'http://localhost:11434'
      && s2.edKey === '' && s2.cur === 'qwen3:32b',
    { rows: s2.rows.map((r) => r.text), ed: { name: s2.edName, kind: s2.edKind, base: s2.edBase, key: s2.edKey, cur: s2.cur } });
  check('★2b 没点「保存设置」之前不落盘（localStorage 里还没有这家新供应商）',
    !s2.providers || s2.providers.every((p) => p.model !== 'qwen3:32b'),
    { providers: s2.providers });

  /* ── ★3 保存 ⇒ 落盘（记住 id，后面还要用） ── */
  await clickSel('#set-save');
  await sleep(300);
  const s3 = await snap();
  const saved = (s3.providers || []).find((p) => p.model === 'qwen3:32b');
  check('★3 点「保存设置」⇒ 落盘：这一家 name/preset/kind/baseUrl/model 都对，activeProvider 指向它',
    !!saved && saved.name === '本地 Ollama · qwen3:32b' && saved.preset === 'ollama' && saved.kind === 'ollama'
      && saved.baseUrl === 'http://localhost:11434' && saved.apiKey === '' && s3.active === saved.id,
    { saved: saved, active: s3.active });

  /* ── ★4 同一个模型再点一次：不重复加，只切过去（行数不变） ── */
  await openAddMenu();
  const s4menu = await waitFor((x) => x.locals.some((l) => l.text.indexOf('已有') >= 0), 4000);
  await clickLocal('qwen3:32b');
  await sleep(350);
  const s4 = await snap();
  check('★4 已经加过的那个再点一次 ⇒ **不重复加**（还是那一家）、提示「已经在清单里」，行上的小字先说「已有」',
    s4.rows.length === 2 && s4.providers.length === 2 && (s4.msg || '').indexOf('已经在清单里') >= 0
      && s4menu.locals.some((l) => l.id === 'qwen3:32b' && l.text.indexOf('已有 · 点一下设为当前在用') >= 0),
    { rows: s4.rows.map((r) => r.text), msg: s4.msg, menu: s4menu.locals.map((l) => l.id + '=' + l.text) });

  /* ── ★5 这就是用户要的"换本地模型"：再加一个 14b，两家并排，直接切过去 ── */
  await openAddMenu();
  await waitFor((x) => x.locals.length >= 2, 3000);
  await clickLocal('qwen3:14b');
  await sleep(350);
  await clickSel('#set-save');
  await sleep(300);
  const s5 = await snap();
  const both = (s5.providers || []).filter((p) => p.kind === 'ollama');
  const active14 = (s5.providers || []).find((p) => p.id === s5.active);
  check('★5 再点「qwen3:14b」⇒ 又一家（出厂 7b + 32b + 14b 三行并排，各自记着自己的模型），当前在用切到 14b —— 换本地模型＝点一行',
    s5.rows.length === 3 && both.length === 3 && active14 && active14.model === 'qwen3:14b',
    { rows: s5.rows.map((r) => r.text), active: active14 && active14.model });

  /* ── ★6 端点坏了 + 重载：缓存那份清单还在，离线照样能选（"Ollama 没开也能选"） ── */
  await send('Page.reload', {});
  await ready();
  await sleep(800);
  /* ⚠️ 重载把 window 上的东西全洗掉了 ⇒ 错误收割器与 stub 都得重装一遍 */
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(stub(true, false));   /* ⚠️ 这次**不许清缓存** —— 要考的正是"从缓存列出来" */
  await openPanel();
  await sleep(400);
  await openAddMenu();
  const s6 = await waitFor((x) => x.locals.length >= 4, 4000);
  const asked6 = await evSoft('window.__tagsAsked');
  check('★6 端点打不通（http 500）时，本机模型那一段仍从上次那份缓存列出来（照样能点）',
    s6.locals.length >= 4 && s6.cached === true && (asked6 || 0) >= 1,
    { locals: s6.locals.map((l) => l.id), cached: s6.cached, tagsAsked: asked6 });

  const errs = await evSoft('window.__errs');
  check('★7 全程无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  /* 收尾：本套件改过 localStorage 里的供应商与模型缓存、还把设置面板留着开着 ⇒ 清干净 + 重载。
     ⚠️ 不这么做，下一个套件（`settings-model-picker.cjs` 的 ★2「出厂就一家供应商」）会看到残留，
     两个套件就不敢在同一个实例里连着跑（实测：连着跑时它撞进"旧构建"兜底分支，1/18）。 */
  await evSoft('window.fetch = window.__origFetch || window.fetch; true');
  await evSoft(`try { localStorage.removeItem('lingkuang-settings'); localStorage.removeItem('lingkuang-model-cache'); } catch (e) {} true`);
  await send('Page.reload', {});
  await ready();

  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} PASS`);
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.log('套件崩了：' + (e && e.stack || e)); process.exit(2); });
