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
/* 小数年份 ↔ YYYY[-MM[-DD[ HH[:MM[:SS]]]]]（存储层互转；内部计算仍用小数值）。年可负/超大（Obsidian 日期待受限于标准公元年，否则退化为字符串但仍可读）
   每一级都是「有才写」：precision 为 year 的节点只写 `year: 312`。旧实现一律补 -01-01，
   读回来凭空多出 month/day，详情面板的「312年」就显示成了「312年1月1日」。 */
function yearToDateStr(n) {
  const year = n.year;
  if (year === undefined || year === null || Number.isNaN(+year)) return '';
  const yr = Math.floor(+year + 1e-9);
  const pad = (x) => String(Math.abs(x)).padStart(2, '0');
  const sign = yr < 0 ? '-' : '';
  let s = `${sign}${Math.abs(yr)}`;
  const hasMonth = n.month !== undefined && n.month !== null;
  const hasDay = n.day !== undefined && n.day !== null;
  if (hasMonth || hasDay) {
    s += `-${pad(hasMonth ? n.month : 1)}`;
    if (hasDay) s += `-${pad(n.day)}`;
  }
  /* 时/分/秒：precision 为 hour/minute/second 的节点才写 */
  if (n.hour !== undefined && n.hour !== null) {
    let t = pad(n.hour);
    if (n.minute !== undefined && n.minute !== null) {
      t += ':' + pad(n.minute);
      if (n.second !== undefined && n.second !== null) t += ':' + pad(n.second);
    }
    s += ' ' + t;
  }
  return s;
}
/* 解析 frontmatter year 字符串（"312" / "312-07" / "312-07-15" / "312-07-15 13:30:05"）→ 已拆出的部件，缺省的不出现 */
function dateStrToYear(str) {
  const s = String(str).trim();
  const m = /^(-?\d+)(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:[ T](\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?)?$/.exec(s);
  if (!m) return { year: parseFloat(s) || 0 };   /* "312.5" 之类的小数年份：整串交给 parseFloat */
  const out = { year: +m[1] };
  if (m[2] !== undefined) out.month = +m[2];
  if (m[3] !== undefined) out.day = +m[3];
  if (m[4] !== undefined) {
    out.hour = +m[4];
    if (m[5] !== undefined) { out.minute = +m[5]; if (m[6] !== undefined) out.second = +m[6]; }
  }
  return out;
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
/* frontmatter 键：含 ASCII 冒号 / 首尾空白 / 空键时用双引号包裹（读取端 parseKey 对称去引号）。
   写入端原本对键名零校验，若读取端收窄键字符类，灵框自己写出的 `身高(cm)` / `所属 阵营`
   就会「写完读不回」——属性面板手打的字段下次打开静默消失，等于自毁数据。 */
function fmtKey(k) {
  const s = String(k);
  return s === '' || /:/.test(s) || s !== s.trim() ? '"' + s.replace(/"/g, '\\"') + '"' : s;
}
/* frontmatter 键 → 原键名（与 fmtKey 对称）。
   键用**非贪婪** `(.+?)`：`year: 312-07-15 13:30:05` 若贪婪匹配会把键吃成
   `year: 312-07-15 13`、值只剩 `30:05`。 */
function parseKey(s) {
  const k = String(s).trim();
  if (k.startsWith('"') && k.endsWith('"')) return k.slice(1, -1).replace(/\\"/g, '"');
  return k;
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
    .map(([k, v]) => `${fmtKey(k)}: ${fmtProp(v)}`).join('\n');
  let body = '';
  body += `#描述：\n${n.desc || ''}\n`;   /* 描述独立 tag */
  if (n.doc) body += `\n#正文：\n${n.doc}\n`;   /* 正文独立 tag */
  return `---\n${meta}${causesLine ? '\n' + causesLine : ''}${propsMeta ? '\n' + propsMeta : ''}\n---\n${body}`.replace(/\r\n/g, '\n');
}
function mdToNode(text) {
  let fm = {}, rest = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (rest.startsWith('---')) {
    const end = rest.indexOf('\n---', 3);
    if (end !== -1) {
      rest.slice(3, end).split('\n').forEach((line) => {
        /* 键 = 该行冒号前的任意字符（非贪婪），交给 parseKey 去引号。
           写入端（nodeToMd）对键名零校验，读取端若收窄（原 `[\w\u4e00-\u9fa5]+`）就会
           「写完读不回」——用户在属性面板手打 `身高(cm)` / `所属-阵营` 会静默消失。
           注意：灵框外（Obsidian）任意增删字段不是受支持的流程，这里只保证自家写出的键能读回。 */
        /* 先试「带引号的键」（写入端 fmtKey 只在键含冒号/首尾空白/为空时加引号），
           再退回非贪婪裸键。顺序不能反：反了 `"a:b": v` 会被裸键分支吃成键 `"a`。 */
        const m = line.match(/^("(?:[^"\\]|\\.)*")\s*:\s*(.*)$/) || line.match(/^(.+?):\s*(.*)$/);
        if (m) fm[parseKey(m[1])] = m[2].trim();
      });
      rest = rest.slice(end + 4);
    }
  }
  const node = {};
  ['id', 'title', 'precision', 'type'].forEach((k) => { if (fm[k] !== undefined) node[k] = fm[k]; });
  if (fm.year !== undefined) {
    const dt = dateStrToYear(fm.year);
    node.year = dt.year;
    /* month/day/hour/minute/second 都藏在 year 字符串里（year: 312-07-15 13:30:05），缺省的部件不补 */
    ['month', 'day', 'hour', 'minute', 'second'].forEach((k) => { if (dt[k] !== undefined) node[k] = dt[k]; });
  }
  /* 因果线：causes 存目标节点 id 数组（Obsidian 行内数组格式 [id1, id2]） */
  if (fm.causes !== undefined) { const c = parseProp(fm.causes); node.causes = Array.isArray(c) ? c.map(String) : []; }
  /* 自定义笔记属性：frontmatter 里非固定 key 的任意键值 → properties（Obsidian 加的能读回） */
  const FIXED = ['id', 'title', 'year', 'precision', 'type', 'kind', 'causes'];
  const props = {};
  Object.entries(fm).forEach(([k, v]) => { if (!FIXED.includes(k) && v !== undefined && v !== null) props[k] = parseProp(v); });
  if (Object.keys(props).length) node.properties = props;
  /* 解析：#字段：值 行（描述/正文 为结构标记）；空行后的自由正文收集为 doc。
     三条护栏，都是为了避免「本应用自己写出的文件再读回来就损坏」：
     1) ``` / ~~~ 围栏内的 #xxx： 一律当内容，不当标记；
     2) 已出现过的结构标记（描述/正文）再出现时算内容 —— 否则正文里写一行
        `#描述：xx` 会被当成真的描述标记，把正文顶进描述、正文被截断；
     3) 描述/正文 值内的空行是内容（markdown 段落靠空行分隔），不当字段终止符。
     未知 `#字段：` 行沿用旧行为（空行终止），保持手写 .md 的既有解释不变。 */
  const allLines = rest.split('\n');
  let desc = '', docParts = [];
  let cur = null, buf = [];
  let hadBodyTag = false;
  let inFence = false;
  const KNOWN_TAGS = ['描述', '正文'];
  const seenTags = new Set();
  const flush = () => { if (cur) { const v = buf.join('\n').trim(); if (cur === '描述') desc = v; else if (cur === '正文') docParts.push(v); else docParts.push(`#${cur}：\n${v}`); } };
  allLines.forEach((line) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = inFence ? null : line.match(/^#([^：:]+)[：:]\s*(.*)$/);
    const tag = m ? m[1].trim() : '';
    const isRepeatMarker = !!tag && KNOWN_TAGS.includes(tag) && seenTags.has(tag);
    if (m && !isRepeatMarker) {
      if (tag === '正文') hadBodyTag = true;
      if (KNOWN_TAGS.includes(tag)) seenTags.add(tag);
      flush(); cur = tag; buf = [m[2]]; return;
    }
    if (cur === null) { if (line.trim()) docParts.push(line); return; }   /* 字段外的自由正文行 → 正文 */
    if (line.trim() === '' && !KNOWN_TAGS.includes(cur)) { flush(); cur = null; buf = []; return; }
    buf.push(line);   /* 已识别的 描述/正文：空行也是内容，保留段落分隔 */
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
      if (!ws.isDirectory() || ws.name.startsWith('.')) continue;   /* 跳过 .trash 等隐藏目录 */
      const wsDir = path.join(root, ws.name);
      for (const tl of fs.readdirSync(wsDir, { withFileTypes: true })) {
        if (!tl.isDirectory() || tl.name.startsWith('.')) continue;
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
    win.loadFile(path.join(__dirname, 'app-dist', 'index.html'));
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

/* ── 落盘实现（同步版，供 IPC 与退出前 flush 共用）──────────────
   退出前的 flush 走 ipcRenderer.sendSync，必须同步写完再返回：
   异步 IPC 在 beforeunload 之后不保证跑得完，编辑器里没失焦的内容
   和 400ms 防抖还没触发的 store 变化都会随窗口一起消失。 */
function writeDataFileSync(payload) {
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
}
function writeVaultNodeSync(wsName, tlName, node) {
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
}

/* ── IPC: write the worldbuilding data file ────────────────── */
ipcMain.handle('data:save', (e, payload) => {
  try {
    writeDataFileSync(payload);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/** 路径安全化：vault 的目录/文件名不能含 Windows 非法字符（与 nodePath 的规则一致）。 */
function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_');
}

/* vault 根目录下**不属于世界观**的保留目录：.trash（回收站）、assets（导入的图片）。
   扫描必须跳过，否则它们会被列成空世界（.trash 靠 startswith('.') 挡，assets 要靠这张表）。 */
const VAULT_RESERVED = new Set(['.trash', 'assets']);
const isReservedDir = (name) => name.startsWith('.') || VAULT_RESERVED.has(name);

/** 扫描一个时间线目录 → 节点数组（按 id 去重）。
 *  节点可能落在两处：时间线直接层（旧两层结构，kind 缺省「事件」）与类型文件夹层（kind = 文件夹名）；
 *  同 id 以类型文件夹版为准。vault:scan 与回收站恢复共用这一份遍历逻辑。 */
function scanTimelineDir(tlDir) {
  const nodesById = new Map();
  for (const f of fs.readdirSync(tlDir)) {
    if (!f.endsWith('.md')) continue;
    const n = mdToNode(fs.readFileSync(path.join(tlDir, f), 'utf8'));
    if (n && n.id) { if (!n.title) n.title = f.replace(/\.md$/, ''); if (!n.kind) n.kind = '事件'; nodesById.set(n.id, n); }
  }
  for (const sub of fs.readdirSync(tlDir, { withFileTypes: true })) {
    if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
    const subDir = path.join(tlDir, sub.name);
    for (const f of fs.readdirSync(subDir)) {
      if (!f.endsWith('.md')) continue;
      const n = mdToNode(fs.readFileSync(path.join(subDir, f), 'utf8'));
      if (n && n.id) { if (!n.title) n.title = f.replace(/\.md$/, ''); n.kind = sub.name; nodesById.set(n.id, n); }
    }
  }
  return [...nodesById.values()];
}

/** 扫描一个世界观目录 → { 时间线名: 节点[] }（跳过隐藏目录）。
 *  **空的时间线也要收（nodes: []）**：vault 的目录结构才是「这个世界有几条时间线」的依据，
 *  节点只是内容。过去只收「有节点的」时间线/世界，后果是：删掉一条时间线里的最后一个节点后，
 *  重扫结果里连这条时间线、这个世界都不存在了 —— 而渲染层是 `d.worldsets = 扫描结果` 整体替换，
 *  于是整个世界（地图/实体/循环/剧情线/自定义历法）当场从界面消失，并被随后的自动落盘写进 JSON。 */
function scanWorldDir(wsDir) {
  const tls = {};
  for (const tl of fs.readdirSync(wsDir, { withFileTypes: true })) {
    if (!tl.isDirectory() || tl.name.startsWith('.')) continue;
    tls[tl.name] = scanTimelineDir(path.join(wsDir, tl.name));
  }
  return tls;
}

/* ── IPC: 扫描 vault 全部节点 .md（frontmatter + 正文）→ 按世界观/时间线分组 ── */
ipcMain.handle('vault:scan', () => {
  try {
    const root = VAULT_DIR();
    if (!fs.existsSync(root)) return { ok: true, worlds: [] };
    const worlds = {};
    for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ws.isDirectory() || isReservedDir(ws.name)) continue;   /* .trash / assets 不是世界观 */
      /* 空世界也要收：世界目录存在 = 这个世界存在（见 scanWorldDir 注释） */
      worlds[ws.name] = scanWorldDir(path.join(root, ws.name));
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
    writeVaultNodeSync(wsName, tlName, node);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/* ══ 回收站（vault/.trash）══════════════════════════════════════════════
   为什么需要：删除不可逆，而 .md 是「文件为源」——只从 store 删不清文件，下次扫描节点就复活。
   所以「删除」= 把 vault 内的文件/目录**移进** .trash（同盘 rename，瞬时且可恢复）。

   结构：.trash/ 下**平铺**存放实体文件，另有一份 index.json 记录每一项的原始相对路径。
   为什么要有索引：文件名带时间戳前缀只能避免重名，还原不出「哪个世界/哪条时间线/哪个类型文件夹」，
   而恢复要的正是那一条路径。
   index.json 里没有的项 = 「孤儿」（早期版本删除留下的平铺文件），恢复时定位不了原位，
   由用户在回收站里指定目标世界/时间线，按 md 内容里的 kind/title 拼回路径。 */
const TRASH_DIR = () => path.join(VAULT_DIR(), '.trash');
const TRASH_INDEX = () => path.join(TRASH_DIR(), 'index.json');

function readTrashIndex() {
  try {
    const a = JSON.parse(fs.readFileSync(TRASH_INDEX(), 'utf8'));
    return Array.isArray(a) ? a.filter((x) => x && x.trashName) : [];
  } catch (err) { return []; }   /* 索引缺失/损坏 → 全部按孤儿处理，不阻塞回收站 */
}
function writeTrashIndex(arr) {
  const d = TRASH_DIR();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(TRASH_INDEX(), JSON.stringify(arr, null, 2), 'utf8');
}
/** 回收站里已不存在的项 → 从索引摘掉（恢复/清空后自愈，不需要各自维护） */
function pruneTrashIndex() {
  const d = TRASH_DIR();
  writeTrashIndex(readTrashIndex().filter((x) => fs.existsSync(path.join(d, x.trashName))));
}

/** 把 vault 内的相对路径（文件或目录）移进 .trash 并登记。源不存在返回 null。 */
function moveToTrash(relPath, meta) {
  const src = path.join(VAULT_DIR(), relPath);
  if (!fs.existsSync(src)) return null;
  const d = TRASH_DIR();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  const ts = Date.now();
  const base = path.basename(relPath) || 'item';
  let n = 0;
  let name = `${ts}-${base}`;
  while (fs.existsSync(path.join(d, name))) { n++; name = `${ts}-${n}-${base}`; }
  fs.renameSync(src, path.join(d, name));
  const entry = {
    id: `${ts}-${n}-${Math.random().toString(36).slice(2, 8)}`,
    kind: (meta && meta.kind) || 'node',        /* node | timeline | world */
    relPath,                                     /* vault 内原始相对路径 —— 恢复就靠它 */
    trashName: name,
    ts,
    title: (meta && meta.title) || base,
    world: (meta && meta.world) || undefined,
    timeline: (meta && meta.timeline) || undefined,
    nodeId: (meta && meta.nodeId) || undefined,
  };
  const idx = readTrashIndex();
  idx.push(entry);
  writeTrashIndex(idx);
  return entry;
}

/** 目录项占用（文件取字节，目录递归累加）：回收站列表显示用 */
function pathSize(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    let sum = 0;
    for (const ent of fs.readdirSync(p, { withFileTypes: true })) sum += pathSize(path.join(p, ent.name));
    return sum;
  } catch (err) { return 0; }
}

/* ── IPC: 删除节点的 .md（移到 vault/.trash/，回收站可恢复）──
   为什么必须动文件：.md 是「文件为源」，store 里删掉节点但文件还在的话，
   下次启动 vault 扫描会把它读回来 —— 节点复活。
   按 id 在时间线目录下递归找，而不是用 nodePath 直接算：
   title 改过或 kind 换过文件夹时，算出来的路径已经不是文件实际所在位置。 */
ipcMain.handle('vault:delete', (e, { wsName, tlName, node }) => {
  try {
    if (!node || !node.id) return { ok: false, error: 'missing node id' };
    const tlDir = path.join(VAULT_DIR(), safeName(wsName), safeName(tlName));
    const found = [];
    const collect = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { collect(p); continue; }
        if (!ent.name.endsWith('.md')) continue;
        try {
          const n = mdToNode(fs.readFileSync(p, 'utf8'));
          if (n && n.id === node.id) found.push(p);
        } catch (err) { /* 读不了的跳过 */ }
      }
    };
    collect(tlDir);
    if (!found.length) return { ok: true, moved: 0 };   /* 从没落过盘，也算删成功 */
    let moved = 0;
    for (const p of found) {
      const ent = moveToTrash(path.relative(VAULT_DIR(), p), {
        kind: 'node', title: node.title || path.basename(p),
        world: wsName, timeline: tlName, nodeId: node.id,
      });
      if (ent) moved++;
    }
    return { ok: true, moved };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/* ── IPC: 删除整条时间线 / 整个世界观（目录整体移进回收站，可恢复）── */
ipcMain.handle('vault:delete-timeline', (e, { wsName, tlName }) => {
  try {
    const ent = moveToTrash(path.join(safeName(wsName), safeName(tlName)), {
      kind: 'timeline', title: tlName, world: wsName, timeline: tlName,
    });
    return { ok: true, moved: ent ? 1 : 0, entry: ent };
  } catch (err) { return { ok: false, error: String(err) }; }
});
ipcMain.handle('vault:delete-world', (e, { wsName }) => {
  try {
    const ent = moveToTrash(safeName(wsName), { kind: 'world', title: wsName, world: wsName });
    return { ok: true, moved: ent ? 1 : 0, entry: ent };
  } catch (err) { return { ok: false, error: String(err) }; }
});

/* ── IPC: 回收站列表 = 索引登记项 + 孤儿项 ── */
ipcMain.handle('vault:trash-list', () => {
  try {
    const d = TRASH_DIR();
    if (!fs.existsSync(d)) return { ok: true, entries: [], orphans: [] };
    const idx = readTrashIndex();
    const known = new Set(idx.map((x) => x.trashName));
    known.add('index.json');
    const entries = idx.map((x) => {
      const p = path.join(d, x.trashName);
      const exists = fs.existsSync(p);
      let preview = '';
      try {
        if (exists && fs.statSync(p).isFile()) {
          const n = mdToNode(fs.readFileSync(p, 'utf8'));
          if (n) preview = `${n.title || ''}${n.year !== undefined ? ' · ' + n.year : ''}`;
        }
      } catch (err) { /* 预览失败不影响列表 */ }
      return { ...x, exists, size: exists ? pathSize(p) : 0, preview };
    });
    const orphans = fs.readdirSync(d, { withFileTypes: true })
      .filter((ent) => !known.has(ent.name))
      .map((ent) => ({
        id: 'orphan:' + ent.name, kind: 'orphan', trashName: ent.name, title: ent.name,
        ts: 0, exists: true, size: pathSize(path.join(d, ent.name)), preview: '',
      }))
      .sort((a, b) => a.trashName.localeCompare(b.trashName));
    entries.sort((a, b) => b.ts - a.ts);
    return { ok: true, entries, orphans };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/* ── IPC: 从回收站恢复 ──
   items = [{ trashName, world?, timeline? }]（孤儿项必须带 world/timeline —— 它没有原路径）。
   恢复 = 移回 vault 原位；并把恢复出来的数据一并返回，渲染层据此直接插回 store，
   不必重启或整库重扫（节点级恢复即时可见）。 */
ipcMain.handle('vault:trash-restore', (e, payload) => {
  try {
    const d = TRASH_DIR();
    const items = (payload && payload.items) || [];
    const idx = readTrashIndex();
    const restored = [];
    const failed = [];
    for (const it of items) {
      const name = String(it.trashName || '');
      if (!name || name === 'index.json' || name.includes('..') || name.includes('/') || name.includes('\\')) {
        failed.push({ name, error: '非法项名' }); continue;
      }
      const src = path.join(d, name);
      if (!fs.existsSync(src)) { failed.push({ name, error: '回收站里已不存在该文件' }); continue; }
      const rec = idx.find((x) => x.trashName === name);
      let relPath = rec && rec.relPath ? rec.relPath : '';
      let nodeData = null;
      if (!relPath) {
        /* 孤儿：位置未知，用 md 内容里的 kind/title 拼回指定时间线下的正确类型文件夹。
           注意 nodeToMd 的 frontmatter **不写 kind**（kind 由「文件夹名」承载，vault:scan 才用
           sub.name 回填），所以孤儿文件里通常没有 kind —— 由调用方（回收站 UI）让用户选，
           否则会静默落到「事件/」把角色/地点错位。 */
        if (!it.world || !it.timeline) { failed.push({ name, error: '缺少原始位置，需指定恢复到哪个世界/时间线' }); continue; }
        try { if (fs.statSync(src).isFile()) nodeData = mdToNode(fs.readFileSync(src, 'utf8')); } catch (err) { nodeData = null; }
        if (!nodeData) { failed.push({ name, error: '无法解析为节点文件，请手工处理' }); continue; }
        relPath = path.join(safeName(it.world), safeName(it.timeline),
          safeName(it.nodeKind || nodeData.kind || '事件'), safeName(nodeData.title || nodeData.id) + '.md');
      }
      const dest = path.join(VAULT_DIR(), relPath);
      const destDir = path.dirname(dest);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      let finalDest = dest;
      if (fs.existsSync(finalDest)) {   /* 原位已有同名文件：不覆盖，加后缀并存 */
        const parsed = path.parse(dest);
        finalDest = path.join(parsed.dir, `${parsed.name}-恢复${Date.now() % 100000}${parsed.ext}`);
      }
      fs.renameSync(src, finalDest);
      const kind = (rec && rec.kind) || 'node';
      const out = { relPath: path.relative(VAULT_DIR(), finalDest), kind };
      if (kind === 'world') {
        out.world = path.basename(finalDest);
        out.timelines = scanWorldDir(finalDest);
      } else if (kind === 'timeline') {
        out.world = path.relative(VAULT_DIR(), path.dirname(finalDest));
        out.timeline = path.basename(finalDest);
        out.nodes = scanTimelineDir(finalDest);
      } else {
        let n = nodeData;
        if (!n) { try { n = mdToNode(fs.readFileSync(finalDest, 'utf8')); } catch (err) { n = null; } }
        out.node = n;
        out.world = (rec && rec.world) || it.world;
        out.timeline = (rec && rec.timeline) || it.timeline;
      }
      restored.push(out);
    }
    pruneTrashIndex();
    return { ok: true, restored, failed };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/* ── IPC: 彻底删除回收站项（不可恢复）。payload.all=true 清空 ── */
ipcMain.handle('vault:trash-purge', (e, payload) => {
  try {
    const d = TRASH_DIR();
    if (!fs.existsSync(d)) return { ok: true, purged: 0 };
    let purged = 0;
    if (payload && payload.all) {
      for (const ent of fs.readdirSync(d)) {
        if (ent === 'index.json') continue;
        fs.rmSync(path.join(d, ent), { recursive: true, force: true });
        purged++;
      }
      writeTrashIndex([]);
    } else {
      for (const n of (payload && payload.names) || []) {
        const s = String(n || '');
        if (!s || s === 'index.json' || s.includes('..') || s.includes('/') || s.includes('\\')) continue;
        fs.rmSync(path.join(d, s), { recursive: true, force: true });
        purged++;
      }
      pruneTrashIndex();
    }
    return { ok: true, purged };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});


/* ── IPC: 退出前同步落盘（渲染进程在 beforeunload 里 sendSync）──
   payload = { data?: WorldData, nodes?: [{wsName, tlName, node}] }
   同步通道，主进程写完才让渲染进程继续销毁。 */
ipcMain.on('app:flush-sync', (e, payload) => {
  const out = { ok: true, wrote: 0, failed: 0 };
  try {
    if (payload && payload.data) {
      try { writeDataFileSync(payload.data); out.wrote++; } catch (err) { out.failed++; out.error = String(err); }
    }
    for (const it of (payload && payload.nodes) || []) {
      try { writeVaultNodeSync(it.wsName, it.tlName, it.node); out.wrote++; } catch (err) { out.failed++; out.error = String(err); }
    }
  } catch (err) {
    out.ok = false;
    out.error = String(err);
  }
  if (out.failed) out.ok = false;
  e.returnValue = out;
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
    /* 唯一文件名：时间戳+原文件名，避免跨节点同名覆盖。
       空白也换成下划线：markdown 图片目标在空白处会被截断，
       `![](assets/1_my pic.png)` 会退化成普通文本（Windows 截图名常带空格）。 */
    const base = path.basename(src, ext).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
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

/* ── IPC: read the character lib ───────────────────────────── */
/* 词库有两个位置：
   - LIB_SEED：随包分发的只读种子（__dirname/data/character_lib.json）。
   - LIB_FILE：用户可写副本（userData/character_lib.json）。
   打包后 __dirname 位于 app.asar 内部，asar 是只读归档，往里写会失败；
   而项目约定「数据写 %APPDATA%\lingkuang\，不写项目目录」。所以读优先用户副本、
   缺失时回落到种子，写一律写用户副本。 */
const LIB_SEED = () => path.join(__dirname, 'data', 'character_lib.json');
const LIB_FILE = () => path.join(app.getPath('userData'), 'character_lib.json');
ipcMain.handle('lib:load', () => {
  try {
    const f = fs.existsSync(LIB_FILE()) ? LIB_FILE() : LIB_SEED();
    const raw = fs.readFileSync(f, 'utf8');
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

/* ── IPC: write character lib（暂存词导出，写 userData 副本）────── */
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
发色：黑发｜发型：双马尾｜瞳色：蓝瞳｜肤色：白皮肤｜角：恶魔角｜瞳：三白眼｜耳：兽耳｜尾：猫尾｜翅：羽翼｜其他身体特征：伤疤、獠牙、鳞片｜上衣：衬衫｜下装：短裙｜连体衣：连衣裙｜套装：水手服｜鞋：靴子｜袜：过膝袜｜内衣：文胸｜特殊服装：女仆装、婚纱｜武器：剑、枪｜法器：法杖｜道具：钥匙、怀表、门锁、路灯｜随身物：扇子、钱包｜坐骑：马、龙｜头饰：发箍、王冠｜面饰：面纱｜颈饰：项链｜肩饰：披肩｜臂饰：臂环｜手饰：戒指｜腰饰：腰带｜腿饰：腿环｜脚链：脚铃｜背部装饰：披风｜发饰：发夹｜眼镜：圆框眼镜｜表层性格：开朗、冷淡｜深层性格：腹黑｜癖好：收集癖｜恐惧：恐高｜执念：复仇｜气质：高贵、神秘｜职业：剑士、医生｜种族：人类、精灵｜身份地位：王子、流浪者｜背景经历：孤儿｜秘密：隐藏身份｜目标：征服世界｜能力：飞行、读心｜弱点：怕火｜关系：师徒、宿敌｜主题意象：月亮、锁链、囚牢、铁窗、庭院｜代表色：红色、金色｜名字含义：寓意光明｜服装：哥特风、和风｜食物：苹果｜气味：花香｜体型：娇小｜萌属性：傲娇、天然呆｜声响：噼啪作响、铃声、沙沙（拟声与声音）｜抽象概念：根本、因果、宿命（非实体的抽象名词）｜自然意象：月光、雪花、晚霞（自然景物、气象、时光）

请把下列每个词条归类到其中最合适的 1 个分类。严格规则：
1. 只能从上面分类名里选，禁止发明新分类
2. 词条以某分类名结尾时优先归该类（四角裤→下装）
3. 联想词优先归类：
   - 拟声词/声音（噼啪作响、掌声、歌声、铃声、脚步声、呼啸）→「声响」
   - 抽象的、看不见具体形象的名词（根本、因果、宿命、边界、循环）→「抽象概念」
   - 自然景物/气象/时光（月亮、雪花、晚霞、雾气、寒冷的风、湖泊、水晶）→「自然意象」
   - 其他有画面感但不是具体物品的意象（囚牢、铁窗、庭院、符纸焦痕）→「主题意象」
4. 「其他身体特征」只放身体部位相关词条（伤疤、獠牙、鳞片、触手）；「上衣/下装/连体衣/套装/鞋/袜/内衣/特殊服装/装备/法器/道具/随身物/武器」与一切物品类分类严禁放入抽象词、意象词、声响词或非该类的实体
5. 输出格式：每行一个「词条: 分类」，词条原文照抄，不要序号、不要解释

词条：
`;

ipcMain.handle('ai:classify', async (e, words) => {
  if (!Array.isArray(words) || !words.length) return { ok: false, error: 'empty words' };
  const list = words.slice(0, 60);
  try {
    const text = await aiChat([{ role: 'user', content: CLASSIFY_PROMPT + list.join('\n') }], 0.1, 2000);
    const validCats = (CLASSIFY_PROMPT.split('\n')[1].match(/[\u4e00-\u9fff]+(?=：)/g) || [])
      .filter((c) => c !== '分类名');
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
