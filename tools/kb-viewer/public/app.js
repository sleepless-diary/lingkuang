/* 灵框 · 知识库查看器 — 前端逻辑 v0.1.0
 * 无框架、无构建；hash 路由；移动优先
 */
'use strict';
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

const state = { tree: null, path: null, view: 'recent', fs: 0 };
const FS_STEPS = [15, 16, 18, 20];

/* ── 工具 ── */
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 1800);
}
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}
function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms), now = Date.now(), diff = now - ms;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  if (diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + ' 天前';
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/* ── 视图切换 ── */
function showView(name) {
  state.view = name;
  ['recent', 'search', 'file'].forEach((v) => {
    const el = $('#view-' + v);
    if (el) el.classList.toggle('hidden', v !== name);
  });
  $$('.tab').forEach((b) => {
    const t = b.dataset.tab;
    b.classList.toggle('active', t === name || (t === 'drawer' && false));
  });
}
function openDrawer(open) {
  $('#drawer').classList.toggle('open', open);
  $('#scrim').classList.toggle('show', open);
}

/* ── 统计 / 最近 ── */
async function loadStats() {
  try {
    const s = await api('/api/stats');
    $('#stats').innerHTML =
      '<div class="stat"><b>' + s.files + '</b><span>文件</span></div>' +
      '<div class="stat"><b>' + fmtSize(s.bytes) + '</b><span>总计</span></div>' +
      '<div class="stat"><b>' + Object.keys(s.byTop).length + '</b><span>分区</span></div>';
    const dirs = Object.entries(s.byTop).sort((a, b) => b[1] - a[1]).slice(0, 14);
    $('#top-dirs').innerHTML = dirs.map(([d, c]) =>
      '<button class="chip" data-dir="' + esc(d) + '">' + esc(d) + '<b>' + c + '</b></button>').join('');
  } catch (e) { $('#stats').innerHTML = '<div class="empty">统计失败</div>'; }
}
async function loadRecent(dir) {
  const box = $('#recent-list');
  box.innerHTML = '<div class="loading">加载中…</div>';
  try {
    const list = await api('/api/recent?limit=30' + (dir ? '&dir=' + encodeURIComponent(dir) : ''));
    if (!list.length) return (box.innerHTML = '<div class="empty">空</div>');
    box.innerHTML = list.map((f) =>
      '<button class="item" data-path="' + esc(f.path) + '">' +
        '<div class="it"><span class="iname">' + esc(f.name) + '</span>' +
        '<span class="itime">' + fmtTime(f.mtime) + '</span></div>' +
        '<div class="ipath">' + esc(f.path) + ' · ' + fmtSize(f.size) + '</div>' +
      '</button>').join('');
  } catch (e) { box.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'; }
}

/* ── 目录树 ── */
function renderTree(nodes, container, depth) {
  container.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const n of nodes) {
    if (n.type === 'dir') {
      const box = document.createElement('div');
      box.className = 'tnode';
      const row = document.createElement('div');
      row.className = 'trow dir' + (depth === 0 ? '' : '');
      row.innerHTML = '<span class="tw">▸</span><span class="tn">' + esc(n.name) + '</span>';
      const kids = document.createElement('div');
      kids.className = 'tchildren hidden';
      if (n.children && n.children.length) renderTree(n.children, kids, depth + 1);
      row.addEventListener('click', () => {
        const willOpen = kids.classList.contains('hidden');
        kids.classList.toggle('hidden', !willOpen);
        row.classList.toggle('open', willOpen);
      });
      box.appendChild(row); box.appendChild(kids); frag.appendChild(box);
      if (depth === 0) { /* 顶层默认展开 */ kids.classList.remove('hidden'); row.classList.add('open'); }
    } else {
      const row = document.createElement('div');
      row.className = 'trow file';
      row.dataset.path = n.path;
      row.innerHTML = '<span class="tw"></span><span class="tn">' + esc(n.name) + '</span>' +
        '<span class="tc">' + (n.size ? fmtSize(n.size) : '') + '</span>';
      row.addEventListener('click', () => { openFile(n.path); openDrawer(false); });
      frag.appendChild(row);
    }
  }
  container.appendChild(frag);
}
async function loadTree() {
  try {
    const d = await api('/api/tree?depth=3');
    renderTree(d.nodes || [], $('#tree'), 0);
  } catch (e) { $('#tree').innerHTML = '<div class="empty">目录加载失败</div>'; }
}
function markTree(path) {
  $$('#tree .trow.file').forEach((el) => el.classList.toggle('active', el.dataset.path === path));
}

/* ── 打开文件 ── */
async function openFile(path, push) {
  showView('file');
  $('#doc').innerHTML = '<div class="loading">读取 ' + esc(path) + ' …</div>';
  $('#crumb-path').textContent = path;
  if (push !== false) location.hash = 'f=' + encodeURIComponent(path);
  try {
    const d = await api('/api/file?path=' + encodeURIComponent(path));
    state.path = d.path;
    markTree(d.path);
    const head =
      '<div class="meta-line" style="margin:0 0 10px">' + esc(d.path) + ' · ' + fmtSize(d.size) + ' · 改于 ' + fmtTime(d.mtime) + '</div>';
    $('#doc').innerHTML = head + d.html;
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  } catch (e) {
    $('#doc').innerHTML = '<div class="empty">读取失败：' + esc(e.message) + '</div>';
  }
}

/* ── 搜索 ── */
async function doSearch() {
  const q = $('#q').value.trim();
  if (!q) return;
  showView('search');
  $('#search-meta').textContent = '搜索：' + q;
  $('#search-list').innerHTML = '<div class="loading">搜索中…</div>';
  try {
    const d = await api('/api/search?q=' + encodeURIComponent(q) + '&limit=60');
    const hits = d.hits || [];
    $('#search-meta').textContent = hits.length + ' 条结果 · ' + q;
    if (!hits.length) return ($('#search-list').innerHTML = '<div class="empty">没有匹配</div>');
    const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    $('#search-list').innerHTML = hits.map((h) =>
      '<button class="item" data-path="' + esc(h.path) + '">' +
        '<div class="it"><span class="iname">' + esc(h.path.split('/').pop()) + '</span>' +
        '<span class="itime">' + (h.line ? 'L' + h.line : '') + '</span></div>' +
        '<div class="ipath">' + esc(h.path) + '</div>' +
        (h.text ? '<div class="ihit">' + esc(h.text).replace(re, '<mark>$1</mark>') + '</div>' : '') +
      '</button>').join('');
  } catch (e) { $('#search-list').innerHTML = '<div class="empty">搜索失败：' + esc(e.message) + '</div>'; }
}

/* ── 字号 ── */
function applyFs() {
  document.documentElement.style.setProperty('--fs', FS_STEPS[state.fs] + 'px');
  try { localStorage.setItem('kb-fs', String(state.fs)); } catch (e) {}
}

/* ── 路由 ── */
function route() {
  const h = location.hash.replace(/^#/, '');
  const m = /^f=(.*)$/.exec(h);
  if (m) { openFile(decodeURIComponent(m[1]), false); return; }
  if (state.path) state.path = null;
  showView('recent');
  $('#crumb-path').textContent = '';
}

/* ── 事件绑定 ── */
function bind() {
  $('#btn-drawer').addEventListener('click', () => openDrawer(true));
  $('#btn-drawer-close').addEventListener('click', () => openDrawer(false));
  $('#scrim').addEventListener('click', () => openDrawer(false));
  $('#crumb-root').addEventListener('click', () => { location.hash = ''; route(); loadRecent(); });
  $('#btn-refresh').addEventListener('click', () => {
    if (state.view === 'file' && state.path) openFile(state.path, false);
    else { loadStats(); loadRecent(); }
    toast('已刷新');
  });
  $('#btn-font').addEventListener('click', () => {
    state.fs = (state.fs + 1) % FS_STEPS.length;
    applyFs(); toast('字号 ' + FS_STEPS[state.fs] + 'px');
  });
  $('#btn-search').addEventListener('click', doSearch);
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); $('#q').blur(); } });

  document.addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (item && item.dataset.path) { openFile(item.dataset.path); return; }
    const chip = e.target.closest('.chip');
    if (chip && chip.dataset.dir) { loadRecent(chip.dataset.dir); toast('只看 ' + chip.dataset.dir); return; }
    const tab = e.target.closest('.tab');
    if (tab) {
      const t = tab.dataset.tab;
      if (t === 'drawer') openDrawer(true);
      else { showView(t); if (t === 'recent') loadRecent(); }
    }
  });
  window.addEventListener('hashchange', route);
}

/* ── 启动 ── */
(function init() {
  try {
    const s = localStorage.getItem('kb-fs');
    if (s !== null) state.fs = Math.max(0, Math.min(FS_STEPS.length - 1, parseInt(s, 10) || 0));
  } catch (e) {}
  applyFs();
  bind();
  route();
  loadStats();
  if (!/^#f=/.test(location.hash)) loadRecent();
  loadTree();
  if ('serviceWorker' in navigator && location.protocol === 'https:' || location.hostname === 'localhost') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
