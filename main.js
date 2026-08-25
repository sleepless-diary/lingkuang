/* 灵框 v3 · Electron 主进程
 * 职责：创建窗口 + 提供 user-data 文件读写（IPC）。
 * 渲染进程通过 preload 暴露的 window.lingkuangAPI 调用，数据落盘到
 * user-data/worldbuilding.json —— 世界观数据真正物理存储。
 */
const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

/* proper app identity → userData goes to %APPDATA%\lingkuang, not Electron。
   setName 在 Electron 偶发时序 bug（Cannot read properties of undefined (reading 'setName')），
   用显式 setPath 兜底保证 userData 路径正确。 */
try { app.setName('lingkuang'); } catch (e) { /* 偶发时序 bug，setPath 保证路径 */ }
try { app.setPath('userData', path.join(app.getPath('appData'), 'lingkuang')); } catch (e) {}

/* remove the application menu entirely — Alt must NOT summon a menu bar */
Menu.setApplicationMenu(null);

/* 数据文件路径。测试后门：LINGKUANG_TEST_DATA 环境变量指向测试数据文件时，
   读写都走它（不碰 %APPDATA% 真实数据）——用于测试新功能/调试损坏数据。 */
const DATA_FILE = () => process.env.LINGKUANG_TEST_DATA
  ? process.env.LINGKUANG_TEST_DATA
  : path.join(app.getPath('userData'), 'worldbuilding.json');
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
/* 格式/结构体定义文件：kind → 应填字段集合（权威参考，autoFix 对照它补缺失字段） */
const FORMATS_FILE = () => path.join(app.getPath('userData'), 'formats.json');
/* vault 根目录（节点 .md 文件存储，Obsidian 可打开编辑）。测试后门 LINGKUANG_VAULT。 */
const VAULT_DIR = () => process.env.LINGKUANG_VAULT
  ? process.env.LINGKUANG_VAULT
  : path.join('F:/', 'lingkuang-vault');
/* 主窗口引用（vault 文件变化推送用） */
let mainWin = null;

/* ── vault 序列化：TimelineNode <-> .md（YAML frontmatter + #字段：值 正文，无 yaml 依赖）── */
/* 小数年份 ↔ YYYY-MM-DD（存储层互转；内部计算仍用小数值）。年可负/超大（Obsidian 日期待受限于标准公元年，否则退化为字符串但仍可读） */
function yearToDateStr(n) {
  const year = n.year;
  if (year === undefined || year === null || Number.isNaN(+year)) return '';
  const yr = Math.floor(+year + 1e-9);
  const month = n.month || 1;
  const day = n.day || 1;
  const pad = (x) => String(Math.abs(x)).padStart(2, '0');
  const sign = yr < 0 ? '-' : '';
  return `${sign}${Math.abs(yr)}-${pad(month)}-${pad(day)}`;
}
/* 解析 frontmatter year 字符串（"312" / "312-07-15"）→ {year, month, day}，未拆出时 month/day 缺省 */
function dateStrToYear(str) {
  const m = /^(-?\d+)-(\d{1,2})-(\d{1,2})$/.exec(String(str).trim());
  if (!m) return { year: parseFloat(str) || 0 };
  const yr = +m[1], month = +m[2], day = +m[3];
  return { year: yr, month, day };
}

/* frontmatter 属性值 → YAML 字符串（Obsidian 兼容：数值/布尔/列表/日期格式） */
function fmtProp(v) {  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return '[' + v.map((x) => fmtProp(typeof x === 'string' ? x : String(x))).join(', ') + ']';
  /* 字符串：含特殊字符（冒号/井号/引号/方括号）或需要定义时加双引号；日期 YYYY-MM-DD 原样（Obsidian 当 date） */
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) || /^[\w\u4e00-\u9fa5.\-/ ]*$/.test(s) && s !== '' && !s.includes(':')) return s;
  return '"' + s.replace(/"/g, '\\"') + '"';
}
/* frontmatter 属性字符串 → JS 值（按 Obsidian 格式推断类型） */
function parseProp(s) {
  const str = String(s).trim();
  if (str === 'true' || str === 'false') return str === 'true';
  if (/^-?\d+(\.\d+)?$/.test(str)) return Number(str);
  if (str.startsWith('[') && str.endsWith(']')) {
    const inner = str.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(/[，,]\s*/).map((x) => parseProp(x));
  }
  if (str.startsWith('"') && str.endsWith('"')) return str.slice(1, -1).replace(/\\"/g, '"');
  return str;
}

function nodeToMd(n) {
  const meta = ['id', 'title', 'year', 'precision', 'type'].filter((k) => n[k] !== undefined && n[k] !== null)
    .map((k) => k === 'year' ? `year: ${yearToDateStr(n)}` : `${k}: ${n[k]}`).join('\n');
  /* 因果线：本节点由哪些节点导致（目标节点 id 列表，Obsidian 行内数组，双向可读） */
  const causesLine = Array.isArray(n.causes) && n.causes.length ? `causes: [${n.causes.join(', ')}]` : '';
  /* 自定义笔记属性：frontmatter 里的任意 key/value（Obsidian 双向可读） */
  const props = n.properties || {};
  const propsMeta = Object.entries(props)
    .filter(([k, v]) => v !== undefined && v !== null && !['id', 'title', 'year', 'precision', 'type', 'kind', 'causes'].includes(k))
    .map(([k, v]) => `${k}: ${fmtProp(v)}`).join('\n');
  let body = '';
  body += `#描述：\n${n.desc || ''}\n`;   /* 描述独立 tag */
  if (n.doc) body += `\n#正文：\n${n.doc}\n`;   /* 正文独立 tag */
  return `---\n${meta}${causesLine ? '\n' + causesLine : ''}${propsMeta ? '\n' + propsMeta : ''}\n---\n${body}`.replace(/\r\n/g, '\n');
}
function mdToNode(text) {
  let fm = {}, rest = String(text || '');
  if (rest.startsWith('---')) {
    const end = rest.indexOf('\n---', 3);
    if (end !== -1) {
      rest.slice(3, end).split('\n').forEach((line) => {
        const m = line.match(/^([\w\u4e00-\u9fa5]+):\s*(.*)$/);  /* 键支持中文（如 性别/身高） */
        if (m) fm[m[1].trim()] = m[2].trim();
      });
      rest = rest.slice(end + 4);
    }
  }
  const node = {};
  ['id', 'title', 'precision', 'type'].forEach((k) => { if (fm[k] !== undefined) node[k] = fm[k]; });
  if (fm.year !== undefined) { const dt = dateStrToYear(fm.year); node.year = dt.year; if (dt.month !== undefined) node.month = dt.month; if (dt.day !== undefined) node.day = dt.day; }
  /* 因果线：causes 存目标节点 id 数组（Obsidian 行内数组格式 [id1, id2]） */
  if (fm.causes !== undefined) { const c = parseProp(fm.causes); node.causes = Array.isArray(c) ? c.map(String) : []; }
  /* 自定义笔记属性：frontmatter 里非固定 key 的任意键值 → properties（Obsidian 加的能读回） */
  const FIXED = ['id', 'title', 'year', 'precision', 'type', 'kind', 'causes'];
  const props = {};
  Object.entries(fm).forEach(([k, v]) => { if (!FIXED.includes(k) && v !== undefined && v !== null) props[k] = parseProp(v); });
  if (Object.keys(props).length) node.properties = props;
  /* 解析：#字段：值 行（desc 单独，值到第一个空行为止）；空行后的自由正文收集为 doc */
  const allLines = rest.split('\n');
  let desc = '', docParts = [];
  let cur = null, buf = [];
  let hadBodyTag = false;
  const flush = () => { if (cur) { const v = buf.join('\n').trim(); if (cur === '描述') desc = v; else if (cur === '正文') docParts.push(v); else docParts.push(`#${cur}：\n${v}`); } };
  allLines.forEach((line, i) => {
    const m = line.match(/^#([^：:]+)[：:]\s*(.*)$/);
    if (m) { if (m[1].trim() === '正文') hadBodyTag = true; flush(); cur = m[1].trim(); buf = [m[2]]; return; }
    if (cur !== null) {
      if (line.trim() === '') { flush(); cur = null; buf = []; }   /* 空行结束当前字段值 */
      else buf.push(line);
    } else if (line.trim()) {
      docParts.push(line);   /* 字段外的自由正文行 → 正文 */
    }
  });
  flush();
  if (desc) node.desc = desc;
  if (docParts.length) node.doc = docParts.join('\n');
  node._hasBodyTag = hadBodyTag;   /* 标记原始 .md 是否含 #正文： 标签（nodeToMd 不会把它写入 frontmatter） */
  return node;
}
function nodePath(wsName, tlName, n) {
  const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_');
  /* kind 文件夹层：世界观/时间线/kind文件夹/节点.md（kind 缺省归「事件」） */
  const kindDir = n && n.kind ? safe(n.kind) : '事件';
  return path.join(VAULT_DIR(), safe(wsName), safe(tlName), kindDir, safe(n.title) + '.md');
}

/* 清理旧的两层残留：删除「时间线直接层」中、同 id 已在类型文件夹（事件/角色/...）有副本的旧 .md，保留类型文件夹版。
   这是迁移到「文件夹=格式」结构后的历史遗留清理，只在确有重复副本时删除，绝不误删唯一文件。 */
function cleanupStaleVaultFiles() {
  try {
    const root = VAULT_DIR();
    if (!fs.existsSync(root)) return;
    for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue;
      const wsDir = path.join(root, ws.name);
      for (const tl of fs.readdirSync(wsDir, { withFileTypes: true })) {
        if (!tl.isDirectory()) continue;
        const tlDir = path.join(wsDir, tl.name);
        /* 收集类型文件夹内所有节点 id，及其所在文件 */
        const idsInKinds = new Set();
        const fileById = new Map();
        for (const sub of fs.readdirSync(tlDir, { withFileTypes: true })) {
          if (!sub.isDirectory()) continue;
          for (const f of fs.readdirSync(path.join(tlDir, sub.name))) {
            if (!f.endsWith('.md')) continue;
            const p = path.join(tlDir, sub.name, f);
            const n = mdToNode(fs.readFileSync(p, 'utf8'));
            if (n && n.id) { idsInKinds.add(n.id); fileById.set(n.id, p); }
          }
        }
        /* 时间线直接层的旧 .md：若 id 已在类型文件夹有副本 → 删除（保留文件夹版） */
        for (const f of fs.readdirSync(tlDir)) {
          if (!f.endsWith('.md')) continue;
          const stalePath = path.join(tlDir, f);
          const n = mdToNode(fs.readFileSync(stalePath, 'utf8'));
          if (n && n.id && idsInKinds.has(n.id) && fileById.get(n.id) !== stalePath) {
            fs.rmSync(stalePath, { force: true });
          }
        }
        /* 清除旧的 kind 行：kind 由所在文件夹名决定，frontmatter 不再存 kind（Obsidian 重写也会保留旧 kind，灵框主动清一次） */
        const stripKind = (dir) => {
          for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.md')) continue;
            const p = path.join(dir, f);
            const raw = fs.readFileSync(p, 'utf8');
            if (!/^kind:(\s|$)/m.test(raw)) continue;
            const node = mdToNode(raw);
            if (node) fs.writeFileSync(p, nodeToMd(node), 'utf8');
          }
        };
        for (const sub of fs.readdirSync(tlDir, { withFileTypes: true })) {
          if (sub.isDirectory()) stripKind(path.join(tlDir, sub.name));
          else if (sub.name.endsWith('.md')) stripKind(tlDir);
        }
      }
    }
  } catch (e) { /* 清理失败不影响启动 */ }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#c5c2ba',
    title: '灵框 LingKuang v3',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWin = win;
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
  /* F12 toggles DevTools — handy for dragging/eyeballing element positions
     (menu bar was removed, so the default accelerator is gone) */
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
}

/* ── IPC: read the worldbuilding data file ─────────────────── */
ipcMain.handle('data:load', () => {
  try {
    const raw = fs.readFileSync(DATA_FILE(), 'utf8');
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) {
    /* file missing = first run: return nothing, front-end falls back to seed */
    return { ok: false, error: e.code || String(e) };
  }
});

/* ── IPC: write the worldbuilding data file ────────────────── */
ipcMain.handle('data:save', (e, payload) => {
  try {
    const dir = path.dirname(DATA_FILE());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    /* 自动备份：写前把现有文件轮换备份，保留 3 份（防误操作/崩溃丢数据） */
    const backup = (n) => DATA_FILE().replace(/\.json$/, `.backup-${n}.json`);
    if (fs.existsSync(DATA_FILE())) {
      /* 轮换：3→2, 2→1, 1→0；当前内容备份到 -1 */
      if (fs.existsSync(backup(2))) fs.rmSync(backup(2), { force: true });
      if (fs.existsSync(backup(1))) fs.copyFileSync(backup(1), backup(2));
      if (fs.existsSync(backup(0))) fs.copyFileSync(backup(0), backup(1));
      fs.copyFileSync(DATA_FILE(), backup(0));
    }
    fs.writeFileSync(DATA_FILE(), JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/* ── IPC: 扫描 vault 全部节点 .md（frontmatter + 正文）→ 按世界观/时间线分组 ── */
ipcMain.handle('vault:scan', () => {
  try {
    const root = VAULT_DIR();
    if (!fs.existsSync(root)) return { ok: true, worlds: [] };
    const worlds = {};
    for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue;
      const wsDir = path.join(root, ws.name);
      const tls = {};
      for (const tl of fs.readdirSync(wsDir, { withFileTypes: true })) {
        if (!tl.isDirectory()) continue;
        const tlDir = path.join(wsDir, tl.name);
        /* 按 id 去重：先收直连 .md（旧两层，默认事件），再收类型文件夹内（优先覆盖，即优先文件夹版） */
        const nodesById = new Map();
        for (const f of fs.readdirSync(tlDir)) {
          if (!f.endsWith('.md')) continue;
          const text = fs.readFileSync(path.join(tlDir, f), 'utf8');
          const n = mdToNode(text);
          if (n && n.id) { if (!n.title) n.title = f.replace(/\.md$/, ''); if (!n.kind) n.kind = '事件'; nodesById.set(n.id, n); }
        }
        /* 类型文件夹层：每个 sub（如 事件/角色/地点）是一个格式文件夹，kind = 文件夹名；同 id 覆盖直连版 */
        for (const sub of fs.readdirSync(tlDir, { withFileTypes: true })) {
          if (!sub.isDirectory()) continue;
          const subDir = path.join(tlDir, sub.name);
          for (const f of fs.readdirSync(subDir)) {
            if (!f.endsWith('.md')) continue;
            const text = fs.readFileSync(path.join(subDir, f), 'utf8');
            const n = mdToNode(text);
            if (n && n.id) { if (!n.title) n.title = f.replace(/\.md$/, ''); n.kind = sub.name; nodesById.set(n.id, n); }
          }
        }
        const nodes = [...nodesById.values()];
        if (nodes.length) tls[tl.name] = nodes;
      }
      if (Object.keys(tls).length) worlds[ws.name] = tls;
    }
    return { ok: true, worlds };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/* ── IPC: 读取单个节点原始 .md 文本（检测 #正文： 标签是否缺失用）── */
ipcMain.handle('vault:readNode', (e, { wsName, tlName, nodeId }) => {
  try {
    const root = VAULT_DIR();
    const wsDir = path.join(root, String(wsName || '').replace(/[\\/:*?"<>|]/g, '_'));
    if (!fs.existsSync(wsDir)) return { ok: false, error: '世界不存在' };
    for (const tl of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!tl.isDirectory()) continue;
      const tlDir = path.join(wsDir, tl.name);
      const scanDir = (dir) => {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.md')) continue;
          const text = fs.readFileSync(path.join(dir, f), 'utf8');
          const n = mdToNode(text);
          if (n && n.id === nodeId) return text;
        }
        return null;
      };
      /* 类型文件夹层 + 时间线直接 .md 都找 */
      for (const sub of fs.readdirSync(tlDir, { withFileTypes: true })) {
        const p = path.join(tlDir, sub.name);
        if (sub.isDirectory()) { const found = scanDir(p); if (found) return { ok: true, text: found }; }
        else if (sub.name.endsWith('.md')) { const found = scanDir(tlDir); if (found) return { ok: true, text: found }; }
      }
    }
    return { ok: false, error: '节点未找到' };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/* ── IPC: 写入单个节点 .md（frontmatter + 正文）── */
ipcMain.handle('vault:write', (e, { wsName, tlName, node }) => {
  try {
    const dir = path.dirname(nodePath(wsName, tlName, node));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    /* 改名去重：同 id 但 title 不同的旧 .md 残留 → 删除（避免名改后文件成双） */
    const target = nodePath(wsName, tlName, node);
    fs.readdirSync(dir).forEach((f) => {
      if (!f.endsWith('.md') || path.join(dir, f) === target) return;
      try {
        const old = mdToNode(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (old.id === node.id) fs.rmSync(path.join(dir, f), { force: true });
      } catch (e) { /* 读不了的旧文件忽略 */ }
    });
    fs.writeFileSync(target, nodeToMd(node), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/* ── IPC: 导入图片到 vault assets（弹文件框 → 复制到 VAULT_DIR/assets → 返回相对路径，供 markdown `![alt](path)`）── */
ipcMain.handle('vault:importImage', async () => {
  try {
    const res = await dialog.showOpenDialog(mainWin, {
      title: '选择要插入的图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const src = res.filePaths[0];
    const ext = path.extname(src).toLowerCase();
    const assetsDir = path.join(VAULT_DIR(), 'assets');
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
    /* 唯一文件名：时间戳+原文件名，避免跨节点同名覆盖 */
    const base = path.basename(src, ext).replace(/[\\/:*?"<>|]/g, '_');
    const name = `${Date.now()}_${base}${ext}`;
    const dst = path.join(assetsDir, name);
    fs.copyFileSync(src, dst);
    /* 返回 vault 相对路径（assets/name），markdown 用相对路径存，外部 Obsidian 可读 */
    return { ok: true, path: `assets/${name}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/* ── IPC: 监听 vault 目录变化（外部 Obsidian 改 .md → 推送 vault-changed，供前端重新读文件为源）── */
let vaultWatcher = null, watchTimer = null;
ipcMain.handle('vault:watch', () => {
  try {
    const root = VAULT_DIR();
    if (!fs.existsSync(root)) return { ok: false, error: 'vault not exist' };
    if (vaultWatcher) return { ok: true };
    vaultWatcher = fs.watch(root, { recursive: true }, (ev, file) => {
      if (!file || !file.endsWith('.md')) return;
      /* 防抖：连续改动合并为一次推送 */
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        if (mainWin && mainWin.webContents) mainWin.webContents.send('vault-changed', { ev, file });
      }, 400);
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});
ipcMain.handle('vault:unwatch', () => {
  if (vaultWatcher) { vaultWatcher.close(); vaultWatcher = null; }
  clearTimeout(watchTimer);
  return { ok: true };
});

/* ── IPC: read the character lib (bundled resource, project dir) ─ */
const LIB_FILE = () => path.join(__dirname, 'data', 'character_lib.json');
ipcMain.handle('lib:load', () => {
  try {
    const raw = fs.readFileSync(LIB_FILE(), 'utf8');
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: e.code || String(e) };
  }
});

/* ── IPC: read the user settings file ──────────────────────── */
ipcMain.handle('settings:load', () => {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), 'utf8');
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: e.code || String(e) };
  }
});

/* ── 内建默认格式定义（kind 直接对应格式；用户可在 formats.json 增改）── */
const DEFAULT_FORMATS = {
  角色: { id: '角色', name: '角色', fields: [
    { name: '性别', type: 'text' }, { name: '种族', type: 'text' }, { name: '发色', type: 'text' },
    { name: '瞳色', type: 'text' }, { name: '身高', type: 'number' }, { name: '性格', type: 'longtext' },
  ] },
  地点: { id: '地点', name: '地点', fields: [
    { name: '所属区域', type: 'text' }, { name: '规模', type: 'text' }, { name: '描述', type: 'longtext' },
  ] },
  物品: { id: '物品', name: '物品', fields: [
    { name: '种类', type: 'text' }, { name: '持有者', type: 'text' }, { name: '说明', type: 'longtext' },
  ] },
  组织: { id: '组织', name: '组织', fields: [
    { name: '性质', type: 'text' }, { name: '首领', type: 'text' }, { name: '简介', type: 'longtext' },
  ] },
  事件: { id: '事件', name: '事件', fields: [
    { name: '起因', type: 'longtext' }, { name: '影响', type: 'longtext' },
  ] },
};

/* 读取格式定义：优先用户自定义 FORMATS_FILE，缺失则用内建默认 */
function loadFormatsRaw() {
  try {
    const raw = fs.readFileSync(FORMATS_FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    /* 用户部分覆盖：缺失的 kind 用内建兜底，全部为空则全用内建 */
    const merged = {};
    for (const [k, v] of Object.entries(DEFAULT_FORMATS)) merged[k] = { ...v, ...(parsed && parsed[k]) };
    if (parsed) for (const [k, v] of Object.entries(parsed)) if (!(k in DEFAULT_FORMATS)) merged[k] = v;
    return merged;
  } catch (e) {
    return { ...DEFAULT_FORMATS };
  }
}

ipcMain.handle('formats:load', () => {
  try {
    return { ok: true, data: loadFormatsRaw() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/* ── IPC: write the formats definition file ────────────────── */
ipcMain.handle('formats:save', (e, payload) => {
  try {
    const dir = path.dirname(FORMATS_FILE());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FORMATS_FILE(), JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/* ── IPC: write the user settings file ─────────────────────── */
ipcMain.handle('settings:save', (e, payload) => {
  try {
    const dir = path.dirname(SETTINGS_FILE());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/* ── AI 引擎：本地 Ollama / OpenAI 兼容 API 双模式 ────────── */
const AI_DEFAULTS = { mode: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen2.5:7b', apiKey: '' };

/* 从 settings.json 读 AI 配置，env 变量可兜底覆盖：
   LINGKUANG_AI_MODE=ollama|api  LINGKUANG_AI_BASE_URL  LINGKUANG_AI_MODEL  LINGKUANG_AI_API_KEY */
function aiConfig() {
  const cfg = Object.assign({}, AI_DEFAULTS);
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), 'utf8');
    const s = JSON.parse(raw);
    if (s && s.ai) Object.assign(cfg, s.ai);
  } catch (e) { /* first run: defaults */ }
  if (process.env.LINGKUANG_AI_MODE) cfg.mode = process.env.LINGKUANG_AI_MODE;
  if (process.env.LINGKUANG_AI_BASE_URL) cfg.baseUrl = process.env.LINGKUANG_AI_BASE_URL;
  if (process.env.LINGKUANG_AI_MODEL) cfg.model = process.env.LINGKUANG_AI_MODEL;
  if (process.env.LINGKUANG_AI_API_KEY) cfg.apiKey = process.env.LINGKUANG_AI_API_KEY;
  return cfg;
}

/* 统一聊天调用：按 mode 分发到本地 Ollama 或 OpenAI 兼容端点 */
async function aiChat(messages, temperature, numPredict) {
  const cfg = aiConfig();
  if (cfg.mode === 'api') {
    if (!cfg.apiKey) throw new Error('API 模式需要配置 API Key（设置 → 联想引擎）');
    const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({ model: cfg.model, messages, temperature, max_tokens: numPredict, stream: false })
    });
    if (!resp.ok) throw new Error('api http ' + resp.status);
    const data = await resp.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  }
  /* 本地 Ollama */
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/api/chat';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, messages, stream: false, options: { temperature, num_predict: numPredict } })
  });
  if (!resp.ok) throw new Error('ollama http ' + resp.status);
  const data = await resp.json();
  return (data.message && data.message.content) || '';
}

const ASSOC_PROMPT = `你是词义联想引擎。给定一个词，生成 5 个与其直接相关的联想词（一级联想，不嵌套链条）。
规则：
1. 每个词都直接由输入词联想而来，词之间互相独立
2. 联想方向多样（物品/场景/人物/意象/象征等不同角度）
3. 词要具体、有画面感，2-4 字中文名词为主，不要抽象形容词
4. 输出格式：每行一个词，不要序号、不要解释

输入词：
`;

ipcMain.handle('ai:associate', async (e, word) => {
  if (!word || typeof word !== 'string') return { ok: false, error: 'empty word' };
  try {
    const text = await aiChat([{ role: 'user', content: ASSOC_PROMPT + word }], 0.7, 300);
    const words = text.split('\n')
      .map(line => line.trim().replace(/^\d+[.．、]\s*/, ''))
      .filter(w => w && w.length >= 2)
      .slice(0, 5);
    return words.length ? { ok: true, words } : { ok: false, error: 'no words parsed' };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/* ── IPC: write character lib（暂存词导出）────────────── */
ipcMain.handle('lib:save', (e, data) => {
  try {
    const dir = path.dirname(LIB_FILE());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LIB_FILE(), JSON.stringify(data, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/* ── IPC: batch classify words via local Ollama（暂存词分类）── */
const CLASSIFY_PROMPT = `你是角色设定词库管理员。词库分类如下（分类名：示例）：
发色：黑发｜发型：双马尾｜瞳色：蓝瞳｜肤色：白皮肤｜角：恶魔角｜瞳：三白眼｜耳：兽耳｜尾：猫尾｜翅：羽翼｜其他身体特征：伤疤、獠牙、鳞片｜上衣：衬衫｜下装：短裙｜连体衣：连衣裙｜套装：水手服｜鞋：靴子｜袜：过膝袜｜内衣：文胸｜特殊服装：女仆装、婚纱｜武器：剑、枪｜法器：法杖｜道具：钥匙、怀表、门锁、路灯｜随身物：扇子、钱包｜坐骑：马、龙｜头饰：发箍、王冠｜面饰：面纱｜颈饰：项链｜肩饰：披肩｜臂饰：臂环｜手饰：戒指｜腰饰：腰带｜腿饰：腿环｜脚链：脚铃｜背部装饰：披风｜发饰：发夹｜眼镜：圆框眼镜｜表层性格：开朗、冷淡｜深层性格：腹黑｜癖好：收集癖｜恐惧：恐高｜执念：复仇｜气质：高贵、神秘｜职业：剑士、医生｜种族：人类、精灵｜身份地位：王子、流浪者｜背景经历：孤儿｜秘密：隐藏身份｜目标：征服世界｜能力：飞行、读心｜弱点：怕火｜关系：师徒、宿敌｜主题意象：月亮、锁链、囚牢、铁窗、庭院｜代表色：红色、金色｜名字含义：寓意光明｜服装：哥特风、和风｜食物：苹果｜气味：花香｜体型：娇小｜萌属性：傲娇、天然呆

请把下列每个词条归类到其中最合适的 1 个分类。严格规则：
1. 只能从上面分类名里选，禁止发明新分类
2. 词条以某分类名结尾时优先归该类（四角裤→下装）
3. 抽象/意象类词（囚牢、铁窗、庭院、月光这类有画面感但不是实体物品的）归「主题意象」
4. 「其他身体特征」只放身体部位相关词条（伤疤、獠牙、鳞片、触手），普通物品严禁放进去
5. 输出格式：每行一个「词条: 分类」，词条原文照抄，不要序号、不要解释

词条：
`;

ipcMain.handle('ai:classify', async (e, words) => {
  if (!Array.isArray(words) || !words.length) return { ok: false, error: 'empty words' };
  const list = words.slice(0, 60);
  try {
    const text = await aiChat([{ role: 'user', content: CLASSIFY_PROMPT + list.join('\n') }], 0.1, 2000);
    const validCats = CLASSIFY_PROMPT.match(/[\u4e00-\u9fff]+(?=：)/g) || [];
    const map = {};
    text.split('\n').forEach(line => {
      const m = line.trim().match(/^(.+?)[:：]\s*(.+)$/);
      if (!m) return;
      const w = m[1].trim().replace(/^\d+[.．、]\s*/, '');
      const c = m[2].trim();
      if (words.includes(w) && validCats.includes(c)) map[w] = c;
    });
    return { ok: true, map };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/* 单实例：第二次启动时关掉旧窗口，重新开一个（避免多窗口叠加） */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    BrowserWindow.getAllWindows().forEach(function (w) { w.destroy(); });
    createWindow();
  });
}

app.whenReady().then(() => {
  cleanupStaleVaultFiles();   /* 迁移到「文件夹=格式」后，清理旧的两层重复残留 */
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
