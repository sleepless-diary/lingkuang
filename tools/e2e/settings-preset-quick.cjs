/* 设置 · 预设供应商**「选一家 → 粘 Key → 就能用」** 回归 12 项
 *（用户 2026-09-28：「我们把预设做一下吧，到时候直接选供应商再填 key，尽量简化」）
 *
 * 目的（用户原话）＝把"加一家云端供应商"从 **5 个字段 + 刷探测 + 挑模型 + 回来点使用 + 底部点保存**
 *   压成 **选一家 → 粘 Key → 点「保存并启用」**。
 * 落地（`src/ui/settings.ts`）：
 *   · 编辑卡分两态：`create`（刚从菜单点了一家预设）只让人看见 **Key** 与**模型**，
 *     名字/协议/端点折进「高级」；`edit`/自定义仍是老样子（字段都在）。
 *   · `saveAndEnable()` = 拿 Key 问端点 ⇒ `recommendModel()` 自动挑一个对话模型 ⇒ 设为当前在用
 *     ⇒ **立刻落盘 + 广播**（不等底部那次「保存设置」——按钮就叫「保存并启用」）。
 *   · 失败不装成功：报端点原话、Key 留在框里、自动展开高级，**不落盘**。
 *
 * 本套件把 `window.fetch` 换成**只截 `/api/tags` 与 `/models` 的 stub**（一个"Key 不对"开关，
 * 返回 401），不连任何真端点。A/B：旧构建没有 `#set-prov-save-add` / `#set-prov-advbox`
 * ⇒ ★0 gate 直接判红（其余按 FAIL 记），新构建全绿。
 *
 * 用法（见 tools/e2e/README.md）：
 *   $env:LINGKUANG_* 指向测试目录 → 起应用（--remote-debugging-port=9500）→
 *   node tools/e2e/settings-preset-quick.cjs
 * ⚠️ `#set-prov-name/kind/baseurl/apikey` 这几个 id **两态共用**（只是折叠显隐）——
 *   `settings-model-picker.cjs` 的 ★3/★9/★12/★14 按 `.value` 读，折叠不影响它们。
 * ⚠️ 收尾会清 `lingkuang-settings` / `lingkuang-model-cache` 并重载（同 settings-local-templates）。
 */
const PORT = process.env.LK_CDP_PORT || '9500';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 旧构建上的占位标题：只为让 A/B 全红时看得清"哪几条"没过 */
const REST_TITLES = [
  '★1 点预设 ⇒ 只让人看见 Key（名字/协议/端点折进高级）', '★2 粘 Key + 保存并启用 ⇒ 不等底部保存就已落盘',
  '★3 模型由电脑替你挑（偏好在清单里就用偏好，否则挑一个像对话的）', '★4 问 /models 且带上这把 Key',
  '★7 「高级」能展开、名字/端点回填正确', '★5 Key 不对 ⇒ 不装成功、展开高级、Key 不丢、不落盘',
  '★5b 没配成的那家草稿能删掉', '★6 不用 Key 的本地预设也能一键启用', '★6b 本地那条不因缺 Key 被拦',
  '★8 自定义供应商不受这套简化影响（高级默认展开、没有一键）',
];
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }

/* 端点 stub：只截 /api/tags 与 /models，其余原样放过去。
   ⚠️ 住在模板串里 —— 里面不许出现反引号或 ${。 */
const stub = (badKey, clear) => `(() => {
  window.__origFetch = window.__origFetch || window.fetch;
  window.__badKey = ${badKey ? 'true' : 'false'};
  window.__fetchLog = [];
  window.__authLog = [];
  window.__tagsAsked = 0;
  window.fetch = function (url, init) {
    var u = String(url);
    var isTags = u.indexOf('/api/tags') >= 0;
    var isModels = u.indexOf('/models') >= 0;
    if (!isTags && !isModels) return window.__origFetch(url, init);
    window.__fetchLog.push(u);
    window.__authLog.push(String((init && init.headers && init.headers.Authorization) || ''));
    if (isTags) window.__tagsAsked++;
    if (window.__badKey && isModels) {
      return Promise.resolve(new Response('{"error":{"message":"Authentication Fails"}}', { status: 401, headers: { 'Content-Type': 'application/json' } }));
    }
    var tags = '{"models":[' +
      '{"name":"qwen3:32b","size":20000000000,"details":{"parameter_size":"32.8B","quantization_level":"Q4_K_M"}},' +
      '{"name":"qwen2.5:7b","size":4660000000,"details":{"parameter_size":"7.6B","quantization_level":"Q4_K_M"}}]}';
    var models = '{"data":[{"id":"deepseek-v4-pro","owned_by":"deepseek"},{"id":"deepseek-flash","owned_by":"deepseek"}]}';
    return Promise.resolve(new Response(isTags ? tags : models, { status: 200, headers: { 'Content-Type': 'application/json' } }));
  };
  ${clear ? "try { localStorage.removeItem('lingkuang-model-cache'); } catch (e) {}" : ''}
  return true;
})()`;

const SNAP = `(() => {
  var g = function (id) { return document.getElementById(id); };
  var shown = function (id) { var e = g(id); return e ? getComputedStyle(e).display !== 'none' : null; };
  var store = {};
  try { store = JSON.parse(localStorage.getItem('lingkuang-settings') || '{}') || {}; } catch (e) { store = {}; }
  return {
    hasQuick: !!g('set-prov-save-add'),
    editorShown: shown('set-prov-editor'),
    advShown: shown('set-prov-advbox'),
    saveAddShown: shown('set-prov-save-add'),
    advBtnText: g('set-prov-adv-toggle') ? g('set-prov-adv-toggle').textContent : null,
    sum: g('set-prov-sum') ? g('set-prov-sum').textContent : null,
    title: g('set-prov-title') ? g('set-prov-title').textContent : null,
    edName: g('set-prov-name') ? g('set-prov-name').value : null,
    edBase: g('set-prov-baseurl') ? g('set-prov-baseurl').value : null,
    edKey: g('set-prov-apikey') ? g('set-prov-apikey').value : null,
    focused: (document.activeElement && document.activeElement.id) || '',
    cur: g('set-model-cur') ? g('set-model-cur').textContent : null,
    hint: g('set-model-hint') ? g('set-model-hint').textContent : null,
    msg: g('set-msg') ? g('set-msg').textContent : null,
    rows: [].slice.call(document.querySelectorAll('#set-prov-list > div')).map(function (r) {
      return { id: r.dataset.prov, text: r.textContent };
    }),
    presets: [].slice.call(document.querySelectorAll('#set-prov-add-menu [data-preset]')).map(function (b) { return b.dataset.preset; }),
    providers: Array.isArray(store.providers) ? store.providers.map(function (p) {
      return { id: p.id, name: p.name, preset: p.preset, kind: p.kind, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model };
    }) : null,
    active: store.activeProvider || ''
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
  const setInput = (sel, val) => ev(`(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.value=${JSON.stringify(val)};e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  const openPanel = () => clickSel('#lk-toolbar .lk-tool-btn[data-tool="settings"]');
  const clickPreset = (pid) => clickSel(`#set-prov-add-menu [data-preset="${pid}"]`);
  const clickProv = (pid, act) => ev(`(function(){var r=document.querySelector('#set-prov-list [data-prov="${pid}"]');if(!r)return false;var b=r.querySelector('[data-act="${act}"]');if(!b)return false;b.click();return true;})()`);
  async function waitFor(pred, ms = 3000, step = 120) {
    const t0 = Date.now();
    for (;;) { const s = await evSoft(SNAP); if (s && pred(s)) return s; if (Date.now() - t0 > ms) return s; await sleep(step); }
  }
  async function openAddMenu() {
    const s = await snap();
    const menu = await evSoft("(function(){var m=document.getElementById('set-prov-add-menu');return m?getComputedStyle(m).display!=='none':null;})()");
    if (menu !== true) { await clickSel('#set-prov-add'); await sleep(260); }
    return s;
  }
  const ready = async () => { for (let i = 0; i < 80; i++) { if (await evSoft(`!!document.querySelector('#lk-toolbar .lk-tool-btn[data-tool="settings"]')`)) return true; await sleep(200); } return false; };

  /* ── 起手：清成出厂状态（一家本地 Ollama），重载让设置层重新读一遍 ── */
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
  if (s0.hasQuick !== true) {
    check('★0 前置：编辑卡有「保存并启用」与「高级」折叠（旧构建没有这套简化）', false, { reason: '旧构建：没有 #set-prov-save-add' });
    for (const t of REST_TITLES) check(t, false, { reason: '旧构建：加供应商仍是"5 个字段自己填"' });
    const errs0 = await evSoft('window.__errs');
    check('★9 全程无未捕获异常', Array.isArray(errs0) && errs0.length === 0, { errs: errs0 });
    await evSoft('window.fetch = window.__origFetch || window.fetch; true');
    console.log('\n' + results.filter(Boolean).length + '/' + results.length + ' PASS（旧构建：其余按 FAIL 记）');
    process.exit(1);
  }
  check('★0 前置：编辑卡有「保存并启用」与「高级」折叠（旧构建没有这套简化）', true, { rows: s0.rows.map((r) => r.id) });

  /* ── ★1 点「DeepSeek」预设 ⇒ 编辑卡开在"添加"态：只看见 Key（端点写在一行小字里） ── */
  await openAddMenu();
  await clickPreset('deepseek');
  await sleep(350);
  const s1 = await snap();
  check('★1 点「DeepSeek」⇒ 多一家 + 编辑卡自动开：**只让人看见 Key**（名字/协议/端点折进高级），'
    + '端点与说明写在「端点已经填好：…」那行小字里，主按钮是「保存并启用」',
    s1.rows.length === 2 && s1.rows.some((r) => r.id === 'deepseek')
      && s1.editorShown === true && s1.advShown === false && s1.saveAddShown === true
      && (s1.sum || '').indexOf('https://api.deepseek.com/v1') >= 0 && (s1.sum || '').indexOf('按量付费') >= 0
      && (s1.title || '').indexOf('添加') >= 0 && (s1.title || '').indexOf('DeepSeek') >= 0
      && s1.cur === '（还没选模型）' && s1.edKey === ''
      /* ⚠️ 判据用 `ollama`（出厂那家）而不是 `deepseek`：菜单是"打开时画一次、加完就收起"的，
         收起后 DOM 里那几行还是旧内容（重建要等下次打开）⇒ 拿"刚点过的那条已经不在"当判据是错的，
         该看的是"打开那一刻 taken 过滤生效了没有"（出厂那条不在 = 生效了）。 */
      && s1.presets.indexOf('ollama') < 0 && s1.presets.indexOf('custom') >= 0,
    { rows: s1.rows.map((r) => r.id), adv: s1.advShown, sum: s1.sum, title: s1.title, cur: s1.cur, presets: s1.presets });

  /* ── ★2 粘 Key + 点「保存并启用」⇒ **不等底部「保存设置」就已落盘**（这就是"填 Key 就能用"） ── */
  await setInput('#set-prov-apikey', 'sk-quick');
  await clickSel('#set-prov-save-add');
  const s2 = await waitFor((x) => x.providers !== null && x.providers.some((p) => p.id === 'deepseek'), 5000);
  const ds = (s2.providers || []).find((p) => p.id === 'deepseek');
  check('★2 粘上 Key、点「保存并启用」⇒ **不用再点底部「保存设置」**：localStorage 里已经是这家（Key 落上、'
    + '模型非空、activeProvider 指向它），提示里点名「已启用…现在就能用了」',
    !!ds && ds.apiKey === 'sk-quick' && ds.baseUrl === 'https://api.deepseek.com/v1' && !!ds.model
      && s2.active === 'deepseek' && (s2.msg || '').indexOf('已启用') >= 0 && (s2.msg || '').indexOf('就能用') >= 0,
    { saved: ds, active: s2.active, msg: s2.msg });

  /* ── ★3 模型是电脑替你挑的：偏好（deepseek-chat）不在清单里 ⇒ 挑一个像对话的（deepseek-flash） ── */
  check('★3 模型由电脑替你挑（预设偏好不在清单里就挑一个像对话模型的）：挑到 `deepseek-flash` 而不是空着，'
    + '挑完还能在卡片里换（模型那一行照常显示）',
    ds && ds.model === 'deepseek-flash' && s2.cur === 'deepseek-flash' && (s2.hint || '').indexOf('个模型') >= 0,
    { model: ds && ds.model, cur: s2.cur, hint: s2.hint });

  /* ── ★4 问的是端点自己的 /models 且带上这把 Key ── */
  const asked = await evSoft('window.__fetchLog');
  const auth = await evSoft('window.__authLog');
  check('★4 一键那一下问的是 `https://api.deepseek.com/v1/models` 且带 `Bearer sk-quick`（不是空手问）',
    Array.isArray(asked) && asked.indexOf('https://api.deepseek.com/v1/models') >= 0
      && Array.isArray(auth) && auth.indexOf('Bearer sk-quick') >= 0,
    { asked: asked, auth: auth });

  /* ── ★7 「高级」能展开、名字/端点回填正确（简化不该把能力藏没） ── */
  await clickSel('#set-prov-adv-toggle');
  await sleep(200);
  const s7 = await snap();
  await clickSel('#set-prov-adv-toggle');
  await sleep(150);
  const s7b = await snap();
  check('★7 「高级」点开能看见名字/协议/端点且回填的就是预设值，再点一下收起来（能力没被藏没）',
    s7.advShown === true && s7.edName === 'DeepSeek' && s7.edBase === 'https://api.deepseek.com/v1'
      && (s7.advBtnText || '').indexOf('收起') >= 0 && s7b.advShown === false,
    { adv: s7.advShown, name: s7.edName, base: s7.edBase, btn: s7.advBtnText, back: s7b.advShown });

  /* ── ★5 Key 不对（401）⇒ 不装成功：报端点原话、自动展开高级、Key 留在框里、不落盘 ── */
  await ev(stub(true, false));
  await openAddMenu();
  await clickPreset('openai');
  await sleep(300);
  await setInput('#set-prov-apikey', 'sk-wrong');
  await clickSel('#set-prov-save-add');
  const s5 = await waitFor((x) => (x.msg || '').indexOf('401') >= 0, 5000);
  const stillSaved = await snap();
  check('★5 Key 不对（401）⇒ **不装成功**：报端点原话（点名 401 / Key 不对）、自动展开「高级」、'
    + 'Key 留在框里（不白填）、前一家与 activeProvider 都没被这次失败动过、localStorage 里没有这家',
    (s5.msg || '').indexOf('401') >= 0 && (s5.msg || '').indexOf('Key') >= 0
      && s5.advShown === true && s5.edKey === 'sk-wrong'
      && stillSaved.active === 'deepseek'
      && (stillSaved.providers || []).every((p) => p.id !== 'openai')
      && (stillSaved.providers || []).some((p) => p.id === 'deepseek' && p.model === 'deepseek-flash'),
    { msg: s5.msg, adv: s5.advShown, key: s5.edKey, active: stillSaved.active, providers: (stillSaved.providers || []).map((p) => p.id) });

  /* ── ★5b 那家没配成的草稿删掉（不留半成品在列表里） ── */
  await clickSel('#set-prov-del');
  await sleep(250);
  const s5b = await snap();
  await ev(stub(false, false));   /* 恢复成"端点正常" */
  check('★5b 没配成的那家草稿可以删掉：列表回到两家（本地 Ollama + DeepSeek），不落半成品',
    s5b.rows.length === 2 && !s5b.rows.some((r) => r.id === 'openai') && s5b.rows.some((r) => r.id === 'deepseek'),
    { rows: s5b.rows.map((r) => r.id) });

  /* ── ★6 不用 Key 的预设（本地 Ollama）也能一键：删掉出厂那条再加一次，直接「保存并启用」 ── */
  await clickProv('ollama', 'edit');
  await sleep(250);
  await clickSel('#set-prov-del');       /* 删掉出厂那条（此时列表里还有 DeepSeek，不会撞"至少要留一家"） */
  await sleep(250);
  await openAddMenu();
  await clickPreset('ollama');
  await sleep(300);
  const s6pre = await snap();
  await clickSel('#set-prov-save-add');
  const s6 = await waitFor((x) => x.active === 'ollama', 5000);
  check('★6 不用 Key 的本地预设也能一键：点「本地 Ollama」⇒ 直接「保存并启用」（不填 Key）⇒ 问 /api/tags、'
    + '挑到 `qwen2.5:7b`、设为当前在用并落盘',
    s6pre.edKey === '' && s6pre.saveAddShown === true
      && s6.active === 'ollama'
      && (s6.providers || []).some((p) => p.id === 'ollama' && p.model === 'qwen2.5:7b' && p.baseUrl === 'http://localhost:11434')
      && (s6.msg || '').indexOf('已启用') >= 0,
    { pre: { key: s6pre.edKey, saveAdd: s6pre.saveAddShown }, active: s6.active, msg: s6.msg, providers: (s6.providers || []).map((p) => p.id + ':' + p.model) });

  /* ── ★6b "缺 Key" 的判据只对 OpenAI 兼容那条生效，别把本地那条也拦了 ── */
  check('★6b 本地那条不因"没填 Key"被拦（提示里没有「把 API Key 粘进去」），照常启用',
    (s6.msg || '').indexOf('API Key') < 0 && (s6.msg || '').indexOf('已启用') >= 0,
    { msg: s6.msg });

  /* ── ★8 自定义供应商不受这套简化影响：高级默认展开、没有「保存并启用」（端点得自己填） ── */
  await openAddMenu();
  await clickPreset('custom');
  await sleep(300);
  const s8 = await snap();
  check('★8 自定义供应商照旧：高级**默认展开**（端点/协议/名字都在）、没有「保存并启用」（端点还是空的，一键无从谈起）',
    s8.advShown === true && s8.saveAddShown === false && s8.edBase === '' && s8.edName === '自定义供应商'
      && s8.editorShown === true,
    { adv: s8.advShown, saveAdd: s8.saveAddShown, base: s8.edBase, name: s8.edName });

  const errs = await evSoft('window.__errs');
  check('★9 全程无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  /* 收尾：本套件改过 localStorage 里的供应商 ⇒ 清干净 + 重载（否则下一个设置套件会看到残留，
     同 settings-local-templates.cjs 的理由）。 */
  await evSoft('window.fetch = window.__origFetch || window.fetch; true');
  await evSoft(`try { localStorage.removeItem('lingkuang-settings'); localStorage.removeItem('lingkuang-model-cache'); } catch (e) {} true`);
  await send('Page.reload', {});
  await ready();

  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} PASS`);
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.log('套件崩了：' + (e && e.stack || e)); process.exit(2); });
