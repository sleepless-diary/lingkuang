/* 不变量：设置面板**分页**（左导航 + 分区）+ AI **供应商档案**（预设 / 自定义 / 当前在用）。
 *
 * 用户 2026-09-26：「做成可选供应商和自定义供应商的版本吧，再把设置分页做一下，就像 dsh」。
 * 两件事的判据分开写：
 *   · 分页：四个导航项与四个分区**同屏都在 DOM 里**，只切 display（不重建 ⇒ 切回来草稿还在）；
 *   · 供应商：预设一键加（已存在的路由不许再加一次）、自定义自己填、行上看得见「配好了没」、
 *     「当前在用」决定 activeProvider 落盘、**老格式（aiMode + baseUrl/apiKey/model）要能原地迁过来
 *     且不丢配置**（这是"换实现不丢用户数据"的核心守卫）。
 * 模型清单那几条沿用上一版（问端点 / 可搜索 / 失败不死路）—— 但现在它是**每家供应商各自的**。
 *
 * A/B：旧构建上 ★0/★1 起全 FAIL（旧面板是 4 张卡片平铺、没有 `#lk-set-nav`、没有 `#set-prov-list`）。
 *
 * 用法：`node tools/e2e/reset-entity-vault.cjs` + `node tools/e2e/seed-node.cjs` → 起应用 →
 * `LK_CDP_PORT=9346 node tools/e2e/settings-model-picker.cjs`
 */
const PORT = process.env.LK_CDP_PORT || '9346';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 旧构建上的占位标题：与下面的真实检查一一对应，只为让 A/B 全红时看得清"哪几条"没过 */
const REST_TITLES = [
  '★1 分页是切显隐不是重建', '★2 出厂就有一家供应商', '★3 编辑卡字段回填', '★4 模型清单问这一家的端点',
  '★5 搜索 / 点选 / 手填', '★6 保存设置才落盘', '★7 端点报错不是死路', '★8 添加供应商菜单',
  '★9 点预设加一条', '★10 OpenAI 兼容问 /models 带 Bearer', '★11 当前在用落盘', '★12 自定义供应商',
  '★13 删除一家', '★14 老格式原地迁移', '★14b 老键清掉',
];
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }

/* 端点 stub：只截 /api/tags 与 /models，其余（真发模型请求那些）原样放过去。
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
  var nav = [].slice.call(document.querySelectorAll('#lk-set-nav .lk-set-nav-btn')).map(function (b) {
    return { page: b.dataset.page, on: b.classList.contains('is-on'), text: b.textContent };
  });
  var pages = [].slice.call(document.querySelectorAll('.lk-set-page')).map(function (s) {
    return { id: s.id, shown: getComputedStyle(s).display !== 'none' };
  });
  var rows = [].slice.call(document.querySelectorAll('#set-prov-list > div')).map(function (r) {
    var dot = r.querySelector('span');
    return {
      id: r.dataset.prov,
      text: r.textContent,
      ready: dot ? dot.style.background.indexOf('accent') >= 0 : null,
      acts: [].slice.call(r.querySelectorAll('[data-act]')).map(function (b) { return b.dataset.act; })
    };
  });
  var mrows = [].slice.call(document.querySelectorAll('#set-model-list .lk-set-model-row')).map(function (el) {
    var sp = el.querySelectorAll('span');
    return { id: el.dataset.model, meta: sp.length ? sp[sp.length - 1].textContent : '' };
  });
  var addMenu = document.getElementById('set-prov-add-menu');
  var ed = document.getElementById('set-prov-editor');
  var mm = document.getElementById('set-model-menu');
  var g = function (id) { return document.getElementById(id); };
  var store = {};
  try { store = JSON.parse(localStorage.getItem('lingkuang-settings') || '{}') || {}; } catch (e) { store = {}; }
  return {
    nav: nav, pages: pages, rows: rows,
    pagesInDom: pages.length,
    allTitles: ['联想引擎', '画布偏好', '换条目转场', '设定演变（版本历史）'].every(function (k) {
      return (document.getElementById('lk-settings-panel') || {}).textContent ? document.getElementById('lk-settings-panel').textContent.indexOf(k) >= 0 : false;
    }),
    addShown: addMenu ? getComputedStyle(addMenu).display !== 'none' : null,
    addMenu: [].slice.call(document.querySelectorAll('#set-prov-add-menu [data-preset]')).map(function (b) { return b.dataset.preset; }),
    editorShown: ed ? getComputedStyle(ed).display !== 'none' : null,
    edTitle: g('set-prov-title') ? g('set-prov-title').textContent : null,
    edName: g('set-prov-name') ? g('set-prov-name').value : null,
    edKind: g('set-prov-kind') ? g('set-prov-kind').value : null,
    edBase: g('set-prov-baseurl') ? g('set-prov-baseurl').value : null,
    edKey: g('set-prov-apikey') ? g('set-prov-apikey').value : null,
    delOff: g('set-prov-del') ? g('set-prov-del').disabled : null,
    cur: g('set-model-cur') ? g('set-model-cur').textContent : null,
    hint: g('set-model-hint') ? g('set-model-hint').textContent : null,
    menuShown: mm ? getComputedStyle(mm).display !== 'none' : null,
    ids: mrows.map(function (r) { return r.id; }),
    metas: mrows,
    msg: g('set-msg') ? g('set-msg').textContent : null,
    providers: Array.isArray(store.providers) ? store.providers.map(function (p) {
      return { id: p.id, name: p.name, preset: p.preset, kind: p.kind, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model };
    }) : null,
    active: store.activeProvider || '',
    legacyKeys: ['aiMode', 'baseUrl', 'apiKey', 'model'].filter(function (k) { return k in store; }),
    glide: store.glide,
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
  const clickSel = (sel) => ev("(function(){var e=document.querySelector('" + sel + "');if(!e)return false;e.click();return true;})()");
  const setInput = (sel, val) => ev("(function(){var e=document.querySelector('" + sel + "');if(!e)return false;e.value=" + JSON.stringify(val) + ";e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
  const setSelect = (sel, val) => ev("(function(){var e=document.querySelector('" + sel + "');if(!e)return false;e.value=" + JSON.stringify(val) + ";e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");
  const clickProv = (pid, act) => ev("(function(){var r=document.querySelector('#set-prov-list [data-prov=\"" + pid + "\"]');if(!r)return false;var b=r.querySelector('[data-act=\"" + act + "\"]');if(!b)return false;b.click();return true;})()");
  const clickModel = (mid) => ev("(function(){var b=document.querySelector('#set-model-list .lk-set-model-row[data-model=\"" + mid + "\"]');if(!b)return false;b.click();return true;})()");
  const openPanel = () => ev("(function(){var b=[].slice.call(document.querySelectorAll('#lk-toolbar .lk-tool-btn')).filter(function(x){return x.dataset.tool==='settings';})[0];if(!b)return false;b.click();return true;})()");
  const closePanel = () => ev("(function(){var b=document.getElementById('lk-set-close');if(b)b.click();return true;})()");

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  await ev(INSTALL_STUB);
  await openPanel();
  await sleep(500);

  /* ⚠️ A/B 守卫：旧构建（四张卡片平铺、没有分页导航与供应商清单）上要**体面地全红**，
     而不是崩在 `undefined.shown` 上（那样只看得到一行报错，看不出"哪几条"没过）。 */
  const hasNav = await ev("!!document.querySelector('#lk-set-nav') && !!document.querySelector('#set-prov-list')");
  if (hasNav !== true) {
    check('★0 前置：设置面板开出来，左侧有导航、右侧有四个分区（四个标题同屏都在）', false, { reason: '旧构建：设置面板没有分页导航 / 供应商清单' });
    for (const t of REST_TITLES) check(t, false, { reason: '旧构建：没有供应商档案与分页导航' });
    const errs0 = await ev('window.__errs');
    check('★15 全程无未捕获异常', Array.isArray(errs0) && errs0.length === 0, { errs: errs0 });
    await ev('window.fetch = window.__origFetch; true');
    console.log('\n' + results.filter(Boolean).length + '/' + results.length + ' PASS（旧构建：其余按 FAIL 记）');
    process.exit(1);
  }

  /* ── ★0 前置 ── */
  let s = await snap();
  check('★0 前置：设置面板开出来，左侧有导航、右侧有四个分区（四个标题同屏都在）',
    s.nav.length === 4 && s.pagesInDom === 4 && s.allTitles === true && s.nav.map((n) => n.page).join(',') === 'model,canvas,motion,evolve',
    { nav: s.nav, pages: s.pages, allTitles: s.allTitles });

  /* ── ★1 分页：只切显隐，不重建（切回来草稿还在） ── */
  const pageBefore = await ev("(function(){window.__ole=document.getElementById('lk-set-page-canvas');return !!window.__ole;})()");
  await clickSel('#lk-set-nav [data-page="canvas"]');
  await sleep(120);
  const onCanvas = await snap();
  await clickSel('#lk-set-nav [data-page="motion"]');
  await sleep(120);
  const onMotion = await snap();
  await clickSel('#lk-set-nav [data-page="model"]');
  await sleep(120);
  const backModel = await snap();
  const sameEl = await ev("(function(){return document.getElementById('lk-set-page-canvas') === window.__ole;})()");
  check('★1 分页是「切显隐」不是「重建」：点画布 ⇒ 只有画布区可见；切回来仍是同一个 DOM 元素',
    pageBefore === true && onCanvas.pages.find((p) => p.id === 'lk-set-page-canvas').shown === true
      && onCanvas.pages.find((p) => p.id === 'lk-set-page-model').shown === false
      && onMotion.pages.find((p) => p.id === 'lk-set-page-motion').shown === true
      && backModel.pages.find((p) => p.id === 'lk-set-page-model').shown === true
      && backModel.nav.find((n) => n.page === 'model').on === true && sameEl === true,
    { onCanvas: onCanvas.pages.filter((p) => p.shown).map((p) => p.id), onMotion: onMotion.pages.filter((p) => p.shown).map((p) => p.id), sameEl });

  /* ── ★2 默认一家供应商：本地 Ollama（当前在用），配好了（不需要 Key） ── */
  check('★2 出厂就有一家供应商（本地 Ollama · 当前在用 · 行上有模型/端点/协议），且只有一家时不给删',
    s.rows.length === 1 && s.rows[0].id === 'ollama' && s.rows[0].text.indexOf('当前在用') >= 0
      && s.rows[0].text.indexOf('qwen2.5:7b') >= 0 && s.rows[0].text.indexOf('localhost:11434') >= 0
      && s.rows[0].text.indexOf('原生 Ollama') >= 0 && s.rows[0].ready === true && s.rows[0].acts.indexOf('use') < 0,
    { rows: s.rows });

  /* 打开它的编辑器：字段回填 + 只有一家时「删除」是禁用的 */
  await clickProv('ollama', 'edit');
  await sleep(200);
  s = await snap();
  check('★3 点「编辑」开出编辑卡：名字/协议/端点/模型都回填成这一家的值；只有一家时删除按钮禁用',
    s.editorShown === true && s.edName === '本地 Ollama' && s.edKind === 'ollama'
      && s.edBase === 'http://localhost:11434' && s.cur === 'qwen2.5:7b' && s.delOff === true,
    { edName: s.edName, edKind: s.edKind, edBase: s.edBase, cur: s.cur, delOff: s.delOff });

  /* ── ★4 模型清单还是「从端点问来的」（现在是这一家自己的清单） ── */
  await clickSel('#set-model-btn');
  const listed = await waitFor((x) => x.ids.indexOf('qwen2.5:3b') >= 0 && x.ids.indexOf('llama3.2:latest') >= 0);
  const asked = await ev("window.__fetchLog.filter(function(u){return u.indexOf('/api/tags')>=0;})");
  check('★4 点开模型选择器 ⇒ 问这一家的端点（/api/tags）并渲染成可点的行（带参数量小字 + 当前在用在单子上）',
    listed.menuShown === true && listed.ids.indexOf('qwen2.5:3b') >= 0 && listed.ids.indexOf('qwen2.5:7b') >= 0
      && listed.ids.indexOf('llama3.2:latest') >= 0 && asked.length >= 1
      && listed.metas.some((r) => r.id === 'qwen2.5:3b' && r.meta.indexOf('3B') >= 0)
      && listed.metas.some((r) => r.meta === '当前在用'),
    { asked: asked, ids: listed.ids, metas: listed.metas.map((r) => r.id + '=' + r.meta) });

  /* ── ★5 搜索过滤 + 点选 + 手填兜底 ── */
  await setInput('#set-model-search', '3b');
  await sleep(150);
  const filtered = await snap();
  await clickModel('qwen2.5:3b');
  await sleep(150);
  const picked = await snap();
  await clickSel('#set-model-btn');
  await sleep(120);
  await setInput('#set-model-search', '');
  await setInput('#set-model-manual', 'my-own-model');
  await clickSel('#set-model-manual-ok');
  await sleep(150);
  const manual = await snap();
  check('★5 搜索按名字过滤；点一行 / 手填一个名字都能成为「当前在用」（菜单收起）',
    filtered.ids.length === 1 && filtered.ids[0] === 'qwen2.5:3b'
      && picked.cur === 'qwen2.5:3b' && picked.menuShown === false && manual.cur === 'my-own-model',
    { filtered: filtered.ids, picked: picked.cur, manual: manual.cur });

  /* ── ★6 「保存设置」才落盘（与以往 AI 那一栏一致） ── */
  await clickSel('#set-model-btn');
  await sleep(120);
  await clickModel('qwen2.5:3b');
  await sleep(120);
  await clickSel('#set-save');
  await sleep(200);
  const saved = await snap();
  check('★6 不点「保存设置」不落盘；点了之后 providers[0].model 就是选中的那个',
    saved.providers && saved.providers.length === 1 && saved.providers[0].model === 'qwen2.5:3b' && saved.active === 'ollama',
    { providers: saved.providers, active: saved.active });

  /* ── ★7 端点报错不是死路：写出原因，上次那份清单还在 ── */
  await ev('window.__stubFail = true; true');
  await clickSel('#set-model-btn');
  await sleep(120);
  await clickSel('#set-model-refresh');
  const failed = await waitFor((x) => x.hint.indexOf('拉取失败') >= 0, 3000);
  check('★7 端点报 500 ⇒ 把原因写在旁边，缓存里那份清单不消失（还能挑）',
    failed.hint.indexOf('拉取失败') >= 0 && failed.hint.indexOf('500') >= 0
      && failed.ids.indexOf('qwen2.5:7b') >= 0 && failed.ids.indexOf('llama3.2:latest') >= 0 && failed.cached === true,
    { hint: failed.hint, ids: failed.ids });
  await ev('window.__stubFail = false; true');
  await clickSel('#set-prov-close');
  await sleep(150);

  /* ── ★8「添加供应商」菜单：预设里还没加的那几家 + 自定义（加过的 Ollama 不再出现） ── */
  await clickSel('#set-prov-add');
  await sleep(150);
  const addOpen = await snap();
  check('★8 添加菜单列出「还没加过」的预设（DeepSeek / OpenAI / 硅基流动）+ 永远在的自定义供应商；已加过的 Ollama 不再出现',
    addOpen.addShown === true && addOpen.addMenu.indexOf('deepseek') >= 0 && addOpen.addMenu.indexOf('openai') >= 0
      && addOpen.addMenu.indexOf('siliconflow') >= 0 && addOpen.addMenu.indexOf('custom') >= 0 && addOpen.addMenu.indexOf('ollama') < 0,
    { addMenu: addOpen.addMenu });

  /* ── ★9 点预设 ⇒ 直接加一条并把端点/协议填好（预设只产候选，Key 还得自己填） ── */
  await clickSel('#set-prov-add-menu [data-preset="deepseek"]');
  await sleep(250);
  const added = await snap();
  check('★9 点「DeepSeek」⇒ 多一行、编辑卡自动打开、协议/端点已按预设填好（模型与 Key 仍空，等你自己填）',
    added.rows.length === 2 && added.rows.filter((r) => r.id === 'deepseek').length === 1
      && added.editorShown === true && added.edKind === 'openai' && added.edBase === 'https://api.deepseek.com/v1'
      && added.cur === '（还没选模型）' && added.delOff === false,
    { rows: added.rows.map((r) => r.id), edKind: added.edKind, edBase: added.edBase, delOff: added.delOff });

  /* ── ★10 换成 OpenAI 兼容协议 ⇒ 问的是 /models 且带上 Key ── */
  await setInput('#set-prov-apikey', 'sk-test');
  await clickSel('#set-model-refresh');
  const apiList = await waitFor((x) => x.ids.indexOf('gpt-4o-mini') >= 0, 3000);
  const apiAsked = await ev("window.__fetchLog.filter(function(u){return u.indexOf('/models')>=0;})");
  const apiAuth = await ev('window.__authLog');
  check('★10 OpenAI 兼容那条问的是 /models 且带 Bearer（清单按 data[].id 渲染）',
    apiList.ids.indexOf('gpt-4o-mini') >= 0 && apiList.ids.indexOf('deepseek-chat') >= 0
      && apiAsked.indexOf('https://api.deepseek.com/v1/models') >= 0 && apiAuth.indexOf('Bearer sk-test') >= 0,
    { ids: apiList.ids, asked: apiAsked, auth: apiAuth });

  /* ── ★11「设为当前在用」+ 保存 ⇒ activeProvider 跟着换（换供应商 = 换端点/Key/模型） ── */
  await setInput('#set-model-manual', 'deepseek-chat');
  await clickSel('#set-model-manual-ok');
  await sleep(150);
  await clickSel('#set-prov-use');
  await sleep(150);
  const useDraft = await snap();
  await clickSel('#set-save');
  await sleep(200);
  const useSaved = await snap();
  check('★11 草稿里切「当前在用」不算数，点「保存设置」后 activeProvider 才变成它',
    useDraft.active === 'ollama' && useSaved.active === 'deepseek'
      && useSaved.providers.filter((p) => p.id === 'deepseek')[0].model === 'deepseek-chat'
      && useSaved.providers.length === 2,
    { draftActive: useDraft.active, savedActive: useSaved.active, providers: useSaved.providers.map((p) => p.id + ':' + p.model) });

  /* ── ★12 自定义供应商：自己填名字与端点 ── */
  await clickSel('#set-prov-add');
  await sleep(120);
  await clickSel('#set-prov-add-menu [data-preset="custom"]');
  await sleep(200);
  const customAdded = await snap();
  await setInput('#set-prov-name', '局域网里的中转');
  await setInput('#set-prov-baseurl', 'http://192.168.1.9:8000/v1');
  await sleep(150);
  const customEdited = await snap();
  check('★12 自定义供应商：加出来是空端点等你填，名字与端点改完立刻反映在行上',
    customAdded.rows.length === 3 && customAdded.edBase === '' && customAdded.edName === '自定义供应商'
      && customEdited.rows.some((r) => r.text.indexOf('局域网里的中转') >= 0 && r.text.indexOf('192.168.1.9:8000') >= 0),
    { rows: customAdded.rows.map((r) => r.id), text: customEdited.rows.map((r) => r.text) });

  /* ── ★13 删除：多家里删掉自定义那条 ⇒ 行数回落，且当前在用不会悬空 ── */
  await clickSel('#set-prov-del');
  await sleep(150);
  await clickSel('#set-save');
  await sleep(200);
  const afterDel = await snap();
  check('★13 删掉一家后行数回落，且 activeProvider 不会指向一个已经没了的 id',
    afterDel.rows.length === 2 && afterDel.rows.filter((r) => r.text.indexOf('局域网里的中转') >= 0).length === 0
      && afterDel.providers.length === 2 && afterDel.providers.some((p) => p.id === afterDel.active),
    { rows: afterDel.rows.map((r) => r.id), providers: afterDel.providers.map((p) => p.id), active: afterDel.active });

  /* ── ★14 老格式原地迁移：不丢用户已经填好的端点 / Key / 模型 ── */
  await closePanel();
  await sleep(200);
  await ev("(function(){var s={aiMode:'api',baseUrl:'https://old.example/v1',apiKey:'sk-old',model:'old-model',glide:0.42};localStorage.setItem('lingkuang-settings',JSON.stringify(s));return true;})()");
  await openPanel();
  await sleep(400);
  const migrated = await snap();
  await clickProv('pv-custom', 'edit');
  await sleep(250);
  const migratedEd = await snap();
  check('★14 老格式（aiMode + baseUrl/apiKey/model）打开面板就折成一条自定义供应商：行上是它，编辑卡里端点/Key/模型一个不丢',
    migrated.rows.length === 1 && migrated.rows[0].id === 'pv-custom' && migrated.rows[0].text.indexOf('当前在用') >= 0
      && migratedEd.editorShown === true && migratedEd.edName === '自定义供应商' && migratedEd.edKind === 'openai'
      && migratedEd.edBase === 'https://old.example/v1' && migratedEd.edKey === 'sk-old' && migratedEd.cur === 'old-model',
    { rows: migrated.rows.map((r) => r.id), ed: { name: migratedEd.edName, kind: migratedEd.edKind, base: migratedEd.edBase, key: migratedEd.edKey, cur: migratedEd.cur } });
  await clickSel('#set-save');
  await sleep(250);
  const migratedSaved = await snap();
  check('★14b 保存一次之后落盘就是新格式：一条供应商 + activeProvider，四个老键清掉，其它偏好（滑杆）原样保留',
    migratedSaved.legacyKeys.length === 0 && migratedSaved.providers.length === 1
      && migratedSaved.providers[0].model === 'old-model' && migratedSaved.providers[0].baseUrl === 'https://old.example/v1'
      && migratedSaved.active === 'pv-custom' && migratedSaved.glide === 0.42,
    { legacyKeys: migratedSaved.legacyKeys, providers: migratedSaved.providers.map((p) => p.id), active: migratedSaved.active, glide: migratedSaved.glide });

  /* ── ★15 无异常 ── */
  const errs = await ev('window.__errs');
  check('★15 全程无未捕获异常', Array.isArray(errs) && errs.length === 0, { errs: errs });

  await ev('window.fetch = window.__origFetch; true');
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} PASS`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.log('套件崩了：' + (e && e.stack || e)); process.exit(2); });
