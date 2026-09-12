/* 灵框 v3 · Electron 主进程
 * 职责：创建窗口 + 提供 user-data 文件读写（IPC）。
 * 渲染进程通过 preload 暴露的 window.lingkuangAPI 调用，数据落盘到
 * user-data/worldbuilding.json —— 世界观数据真正物理存储。
 */
const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

/* proper app identity → userData goes to %APPDATA%\lingkuang, not Electron。
   setName 在 Electron 偶发时序 bug（Cannot read properties of undefined (reading 'setName')），
   用显式 setPath 兜底保证 userData 路径正确。 */
try { app.setName('lingkuang'); } catch (e) { /* 偶发时序 bug，setPath 保证路径 */ }
try { app.setPath('userData', path.join(app.getPath('appData'), 'lingkuang')); } catch (e) {}

/* 测试后门（与下面 LINGKUANG_TEST_DATA 同一族）：LINGKUANG_TEST_USERDATA=<目录> 把 userData
   （localStorage / settings.json / 词库副本）也一并隔离。**为什么必须有**：用户常常正开着正式应用，
   而两个实例共用一份 Chromium profile（Local Storage 是 LevelDB）会互相踩；更糟的是下面的单实例锁
   会让测试实例抢不到锁自杀，还顺手触发正式实例的 `second-instance` —— 把用户正在用的窗口关掉重开。 */
try {
  if (process.env.LINGKUANG_TEST_USERDATA) app.setPath('userData', process.env.LINGKUANG_TEST_USERDATA);
} catch (e) { /* 拿不到就退回正式目录，测试脚本会因脏起点而失败（可见，不会静默） */ }

/* remove the application menu entirely — Alt must NOT summon a menu bar */
Menu.setApplicationMenu(null);

/* 数据文件路径。测试后门：LINGKUANG_TEST_DATA 环境变量指向测试数据文件时，
   读写都走它（不碰 %APPDATA% 真实数据）——用于测试新功能/调试损坏数据。 */
const DATA_FILE = () => process.env.LINGKUANG_TEST_DATA
  ? process.env.LINGKUANG_TEST_DATA
  : path.join(app.getPath('userData'), 'worldbuilding.json');
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
/* 格式/结构体定义文件：kind → 应填字段集合（权威参考，autoFix 对照它补缺失字段）。
   测试后门：设了 LINGKUANG_TEST_DATA 就把它放在**同一个临时目录**里 —— 否则跑自动化测试时
   「结构体管理」面板会写进真实的 %APPDATA%\lingkuang\formats.json，改掉用户自己的模板。 */
const FORMATS_FILE = () => process.env.LINGKUANG_TEST_DATA
  ? path.join(path.dirname(process.env.LINGKUANG_TEST_DATA), 'formats.json')
  : path.join(app.getPath('userData'), 'formats.json');
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

/** 解析 .md 的 YAML frontmatter → { fm, rest }（节点与实体共用，避免两处逻辑漂移）。
 *  键的解析规则见下面注释：先试「带引号的键」再退回非贪婪裸键 —— 顺序不能反。 */
function parseFm(text) {
  const fm = {};
  let rest = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (rest.startsWith('---')) {
    const end = rest.indexOf('\n---', 3);
    if (end !== -1) {
      rest.slice(3, end).split('\n').forEach((line) => {
        /* 键 = 该行冒号前的任意字符（非贪婪），交给 parseKey 去引号。
           写入端对键名零校验，读取端若收窄（原 `[\w\u4e00-\u9fa5]+`）就会「写完读不回」——
           用户在属性面板手打 `身高(cm)` / `所属-阵营` 会静默消失。
           注意：灵框外（Obsidian）任意增删字段不是受支持的流程，这里只保证自家写出的键能读回。 */
        const m = line.match(/^("(?:[^"\\]|\\.)*")\s*:\s*(.*)$/) || line.match(/^(.+?):\s*(.*)$/);
        if (m) fm[parseKey(m[1])] = m[2].trim();
      });
      rest = rest.slice(end + 4);
    }
  }
  return { fm, rest };
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
  const { fm, rest: rest0 } = parseFm(text);
  let rest = rest0;
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
/* 实体（设定库）在 vault 里的根目录名。以 `_` 开头表示「灵框的系统目录，不是一条时间线」——
   `scanWorldDir` / `vault:scan` 会把它单独当实体读，不会把它算成时间线。 */
const ENTITY_DIR = '_设定';

/* ── 实体序列化：Entity <-> .md（frontmatter 存 id/name/type + 全部字段，正文用 #正文： 标签）──
   与节点同构：字段写进 frontmatter（Obsidian 双向可读），正文写进 body。 */
function entityToMd(e, typeName) {
  const meta = ['id', 'name', 'type'].filter((k) => k === 'type' ? (typeName || e[k]) : (e[k] !== undefined && e[k] !== null))
    .map((k) => (k === 'type' ? `type: ${typeName || e[k]}` : `${k}: ${e[k]}`)).join('\n');
  const props = e.properties || {};
  const propsMeta = Object.entries(props)
    .filter(([k, v]) => v !== undefined && v !== null && !['id', 'name', 'type'].includes(k))
    .map(([k, v]) => `${fmtKey(k)}: ${fmtProp(v)}`).join('\n');
  const body = e.doc ? `#正文：\n${e.doc}\n` : '';
  return `---\n${meta}${propsMeta ? '\n' + propsMeta : ''}\n---\n${body}`.replace(/\r\n/g, '\n');
}
function mdToEntity(text) {
  const { fm, rest } = parseFm(text);
  const e = {};
  if (fm.id !== undefined) e.id = fm.id;
  if (fm.name !== undefined) e.name = fm.name;
  if (fm.type !== undefined) e.type = fm.type;
  const FIXED = ['id', 'name', 'type'];
  const props = {};
  Object.entries(fm).forEach(([k, v]) => { if (!FIXED.includes(k) && v !== undefined && v !== null) props[k] = parseProp(v); });
  if (Object.keys(props).length) e.properties = props;
  /* 正文：只认 `#正文：` 标签后的内容（没有标签就把整段当正文，兼容手写的 .md） */
  const lines = rest.split('\n');
  const idx = lines.findIndex((l) => /^#\s*正文\s*[：:]\s*$/.test(l.trim()));
  e.doc = (idx === -1 ? lines : lines.slice(idx + 1)).join('\n').trim();
  return e;
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
  /* 测试后门（与 LINGKUANG_TEST_DATA 同性质，只认环境变量、不影响正常启动）：
     LINGKUANG_TEST_WINDOW_POS="1920,0"  把窗口开在指定屏幕/位置（如在副屏做验证，主屏不受扰）
     LINGKUANG_TEST_WINDOW_SIZE="1100,700" 指定窗口尺寸
     LINGKUANG_TEST_WINDOW_NOFOCUS=1       不抢焦点（showInactive，主屏看视频时不被切走） */
  const parsePair = (s) => String(s || '').split(',').map((v) => parseInt(v, 10));
  const pos = parsePair(process.env.LINGKUANG_TEST_WINDOW_POS);
  const size = parsePair(process.env.LINGKUANG_TEST_WINDOW_SIZE);
  const hasPos = pos.length === 2 && pos.every(Number.isFinite);
  const hasSize = size.length === 2 && size.every(Number.isFinite);
  const noFocus = !!process.env.LINGKUANG_TEST_WINDOW_NOFOCUS;
  const win = new BrowserWindow({
    width: hasSize ? size[0] : 1440,
    height: hasSize ? size[1] : 900,
    ...(hasPos ? { x: pos[0], y: pos[1] } : {}),
    ...(noFocus ? { show: false } : {}),
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
  if (noFocus) win.showInactive();
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

/* ══════════ 备份 / 恢复基础设施 ═══════════════════════════════
   两个受管数据文件：
     data → worldbuilding.json（世界观，DATA_FILE()）
     lib  → character_lib.json（角色词库，LIB_FILE()；缺省回落到随包只读种子 LIB_SEED()）
   每个文件在同一目录下有三类可恢复副本：
     <base>.backup-0/1/2.json        自动轮换：每次保存前把现有文件推进去
     <base>.bak-corrupt-<ts>.json    解析失败时逐字节另存（绝不覆盖，保命用）
     <base>.bak-manual-<ts>.json     用户手动「立即备份」
     <base>.bak-prerestore-<ts>.json 恢复/导入前给「当前文件」留的快照
   备份失败一律不挡正常保存——为了备份把保存搞挂是本末倒置。 */
const BACKUP_KEEP = 3;
const BACKUP_TARGETS = {
  data: { label: '世界观数据', file: () => DATA_FILE() },
  lib: { label: '角色词库', file: () => LIB_FILE(), seed: () => LIB_SEED() },
};
const backupBase = (file) => path.basename(file).replace(/\.json$/, '');
/** 时间戳沿用机器上已有副本的命名：YYYYMMDD-HHMMSS */
function backupStamp(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}
/** 不覆盖的落点：同秒重名自动加 -2 / -3 … */
function uniqueBackupPath(dir, base, kind) {
  const stamp = backupStamp();
  let dest = path.join(dir, `${base}.bak-${kind}-${stamp}.json`);
  for (let i = 2; fs.existsSync(dest) && i < 1000; i++) {
    dest = path.join(dir, `${base}.bak-${kind}-${stamp}-${i}.json`);
  }
  return dest;
}
/** 把现有文件逐字节另存为副本（kind: corrupt | manual | prerestore），返回落点；无源/失败 → '' */
function preserveFile(file, kind) {
  try {
    if (!file || !fs.existsSync(file)) return '';
    const dest = uniqueBackupPath(path.dirname(file), backupBase(file), kind);
    fs.copyFileSync(file, dest);
    return dest;
  } catch (e) { return ''; }
}
/** 自动轮换：现有文件 → .backup-0，旧 0/1 依次后移，最老的丢弃 */
function rotateBackups(file) {
  try {
    if (!file || !fs.existsSync(file)) return;
    const dir = path.dirname(file);
    const slot = (n) => path.join(dir, `${backupBase(file)}.backup-${n}.json`);
    if (fs.existsSync(slot(BACKUP_KEEP - 1))) fs.rmSync(slot(BACKUP_KEEP - 1), { force: true });
    for (let i = BACKUP_KEEP - 2; i >= 0; i--) {
      if (fs.existsSync(slot(i))) fs.copyFileSync(slot(i), slot(i + 1));
    }
    fs.copyFileSync(file, slot(0));
  } catch (e) { /* 备份失败不挡保存 */ }
}
/** 列出某个受管文件的全部可恢复项（当前 / 自动轮换 / 损坏存档 / 手动 / 恢复前快照 / 出厂种子） */
function listBackups(target) {
  const t = BACKUP_TARGETS[target];
  if (!t) return { ok: false, error: '未知目标' };
  const file = t.file();
  const dir = path.dirname(file);
  const base = backupBase(file);
  const entries = [];
  const push = (kind, label, p, restorable) => {
    try {
      const st = fs.statSync(p);
      entries.push({ kind, label, path: p, name: path.basename(p), bytes: st.size, mtime: st.mtimeMs, restorable });
    } catch (e) { /* 列不到的项跳过 */ }
  };
  if (fs.existsSync(file)) push('current', '当前', file, false);
  for (let i = 0; i < BACKUP_KEEP; i++) {
    const p = path.join(dir, `${base}.backup-${i}.json`);
    if (fs.existsSync(p)) push('auto', `自动备份 ${i + 1}`, p, true);
  }
  try {
    const KINDS = [['corrupt', '损坏存档'], ['manual', '手动备份'], ['prerestore', '恢复前快照']];
    for (const n of fs.readdirSync(dir)) {
      for (const [kind, label] of KINDS) {
        if (n.startsWith(`${base}.bak-${kind}-`)) push(kind, label, path.join(dir, n), true);
      }
    }
  } catch (e) { /* 目录读不了就只列已知项 */ }
  if (t.seed && fs.existsSync(t.seed())) push('builtin', '出厂词库（随包）', t.seed(), true);
  entries.sort((a, b) => b.mtime - a.mtime);
  return { ok: true, target, label: t.label, file: fs.existsSync(file) ? file : '', entries };
}

/** 数据文件损坏 → 原生对话框（这种事不该被错过）。带「打开所在文件夹」，
    省得用户自己去翻 %APPDATA%。 */
function notifyCorruptData(label, fileName, corruptPath, bytes, err) {
  try {
    const opts = {
      type: 'error',
      title: '数据文件损坏',
      message: `${fileName} 读不出来（${bytes} 字节）`,
      detail: [
        `（${label}）原因：${err && err.message ? err.message : String(err)}`,
        corruptPath ? `为避免被覆盖，损坏内容已原样另存为：\n${corruptPath}` : '另外保存失败——请立刻手动备份该文件，否则会被覆盖。',
        '本次运行已暂停自动保存（灵框窗口顶部有常驻提示），所以在你去恢复之前，原文件不会再被写一次。',
        '你原来的内容没有被删除，就在上面那个副本里。也可以开灵框的「备份管理」，从副本一键恢复。'
      ].join('\n\n'),
      buttons: corruptPath ? ['打开所在文件夹', '知道了'] : ['知道了'],
      defaultId: 0,
      noLink: true
    };
    const p = mainWin ? dialog.showMessageBox(mainWin, opts) : dialog.showMessageBox(opts);
    p.then((r) => { if (r.response === 0 && corruptPath) shell.showItemInFolder(corruptPath); }).catch(() => {});
  } catch (e) { /* 提示失败不能挡启动 */ }
}

/* ══ 损坏锁定（dataWriteLock）══════════════════════════════════════════
   解析不了的 worldbuilding.json 绝不能被空数据静默覆盖。
   旧行为：解析失败只回 ok:false → 渲染层 jsonData=null → emptyData() 顶上 →
   400ms 防抖自动落盘把整个文件写成「新世界」。实测：造一个截断的 worldbuilding.json
   启动、不做任何操作，文件就从 296B 变成 369B 的空世界观，界面变成「新世界」、
   零提示零报错；而 .backup-0/1/2 三格轮换会在 3 次保存内把最后一份原文件也挤掉。

   两层护栏：
   ① 先重读再判损 —— 读到的字节解析不了，可能是真损坏，也可能是「恰好读到别人正在写的
      半截文件」（本应用自己的 writeFileSync 就是先截断再写，读它的人会看到中间态）。
      而 preserveFile 拷的是失败那次读**之后**的磁盘现状：2026-08-23 那份 290KB 的
      .bak-corrupt 至今能正常 JSON.parse（见 docs/BUGS.md 第十八轮「一、判损护栏」），
      所以「判损瞬间的字节」和「拷下来的字节」可以不是同一份东西。判损前重读 3 次、
      每次隔 200ms：真损坏必然次次失败，竞态读到的半截几乎必然在下一次就完整了。
   ② 判损即上锁 —— 锁挂在 writeDataFileSync 里，那是 data:save 与 app:flush-sync
      （退出前落盘）**唯一的共用写入口**，所以两条路径同时失效，不存在漏一条的可能。
      上锁期间用户的资产只多不少：损坏文件原样留在原地、副本也在，等他决定。
      两个出口都是显式的：点顶部横幅「继续用新数据」→ data:allow-write 解锁；
      或走「备份管理」恢复（backup:restore / backup:import 不经 writeDataFileSync，
      上锁不影响它们——这正是留给用户的救援通道）。
      读到一份能解析的文件 = 损坏已解决 → 自动解锁，不必让用户记着去点。 */
let dataWriteLock = null;     /* { corruptPath, bytes, error, attempts, at } | null */
const READ_ATTEMPTS = 4;      /* 首次 + 3 次重读 */
const READ_RETRY_MS = 200;

/* ── IPC: read the worldbuilding data file ─────────────────── */
ipcMain.handle('data:load', async () => {
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE(), 'utf8');
  } catch (e) {
    /* file missing = first run: return nothing, front-end falls back to seed */
    return { ok: false, error: e.code || String(e) };
  }
  let attempts = 0;
  let err = null;
  while (attempts < READ_ATTEMPTS) {
    attempts++;
    try {
      const data = JSON.parse(raw);
      if (dataWriteLock) dataWriteLock = null;   /* 能读 = 损坏已解决（换了文件/已恢复）→ 解锁 */
      return { ok: true, data, attempts };
    } catch (e) {
      err = e;
    }
    if (attempts >= READ_ATTEMPTS) break;
    await new Promise((r) => setTimeout(r, READ_RETRY_MS));
    /* 重读失败（文件被删/被独占）就拿着上一份 raw 继续重试，不把「读不到」当成「没损坏」 */
    try { raw = fs.readFileSync(DATA_FILE(), 'utf8'); } catch (e) { /* 保持上一份 */ }
  }
  const corruptPath = preserveFile(DATA_FILE(), 'corrupt');
  /* 用 Buffer.byteLength 而不是 raw.length：raw.length 是 JS 字符串长度（UTF-16 码元数），
     中文一个字只算 1，和文件真实字节数对不上（曾把 296 字节的文件报成 264 字节）。 */
  const bytes = Buffer.byteLength(raw, 'utf8');
  dataWriteLock = { corruptPath, bytes, error: err && err.message ? err.message : String(err), attempts, at: Date.now() };
  notifyCorruptData('世界观数据', 'worldbuilding.json', corruptPath, bytes, err);
  return { ok: false, error: 'JSON 解析失败：' + (err && err.message ? err.message : String(err)), corruptPath, corrupt: true, locked: true, attempts, bytes };
});

/* 判损状态查询：渲染层顶栏横幅用；也让自动化能断言「确实上了锁」而不是靠差文件推断 */
ipcMain.handle('data:corrupt-state', () => ({ ok: true, locked: !!dataWriteLock, ...(dataWriteLock || {}) }));

/* 「继续用新数据」：用户显式放弃损坏文件里的内容 → 解锁，之后照常落盘 */
ipcMain.handle('data:allow-write', () => {
  const wasLocked = !!dataWriteLock;
  dataWriteLock = null;
  return { ok: true, unlocked: wasLocked };
});

/* ── IPC: 备份管理（列表 / 立即备份 / 恢复 / 导出到文件 / 从文件导入）── */
const showSave = (opts) => (mainWin ? dialog.showSaveDialog(mainWin, opts) : dialog.showSaveDialog(opts));
const showOpen = (opts) => (mainWin ? dialog.showOpenDialog(mainWin, opts) : dialog.showOpenDialog(opts));

ipcMain.handle('backup:list', (e, { target } = {}) => listBackups(target));

ipcMain.handle('backup:create', (e, { target } = {}) => {
  const t = BACKUP_TARGETS[target];
  if (!t) return { ok: false, error: '未知目标' };
  if (!fs.existsSync(t.file())) return { ok: false, error: '还没有可备份的文件' };
  const dest = preserveFile(t.file(), 'manual');
  return dest ? { ok: true, path: dest } : { ok: false, error: '备份失败' };
});

ipcMain.handle('backup:restore', (e, { target, path: src } = {}) => {
  const t = BACKUP_TARGETS[target];
  if (!t) return { ok: false, error: '未知目标' };
  if (typeof src !== 'string' || !src || !fs.existsSync(src)) return { ok: false, error: '来源文件不存在' };
  const file = t.file();
  /* 只接受「同一数据目录下的备份」，不接受任意路径——避免被诱导去覆盖别处的文件 */
  if (path.dirname(path.resolve(src)) !== path.dirname(path.resolve(file))) {
    return { ok: false, error: '只支持从同一数据目录下的备份恢复' };
  }
  const safety = preserveFile(file, 'prerestore');   /* 恢复错了还能回头 */
  rotateBackups(file);
  try {
    fs.copyFileSync(src, file);
    return { ok: true, from: src, safety, bytes: fs.statSync(file).size };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('backup:export', async (e, { target } = {}) => {
  const t = BACKUP_TARGETS[target];
  if (!t) return { ok: false, error: '未知目标' };
  const file = t.file();
  if (!fs.existsSync(file)) return { ok: false, error: '还没有可导出的文件' };
  const r = await showSave({
    title: `导出${t.label}`,
    defaultPath: path.join(app.getPath('documents'), `${backupBase(file)}-${backupStamp()}.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.copyFileSync(file, r.filePath);
    return { ok: true, path: r.filePath };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('backup:import', async (e, { target } = {}) => {
  const t = BACKUP_TARGETS[target];
  if (!t) return { ok: false, error: '未知目标' };
  const r = await showOpen({
    title: `从文件导入${t.label}`,
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
  const src = r.filePaths[0];
  /* 先校验是合法 JSON 再动现有文件——不能让「导入一个坏文件」反过来把数据毁了 */
  let raw;
  try { raw = fs.readFileSync(src, 'utf8'); } catch (err) { return { ok: false, error: '读不了该文件：' + err.message }; }
  try { JSON.parse(raw); } catch (err) { return { ok: false, error: '不是合法 JSON：' + err.message }; }
  const file = t.file();
  const safety = preserveFile(file, 'prerestore');
  rotateBackups(file);
  try {
    fs.writeFileSync(file, raw, 'utf8');
    return { ok: true, from: src, safety, bytes: Buffer.byteLength(raw, 'utf8') };
  } catch (err) { return { ok: false, error: String(err) }; }
});

/* ── 落盘实现（同步版，供 IPC 与退出前 flush 共用）──────────────
   退出前的 flush 走 ipcRenderer.sendSync，必须同步写完再返回：
   异步 IPC 在 beforeunload 之后不保证跑得完，编辑器里没失焦的内容
   和 400ms 防抖还没触发的 store 变化都会随窗口一起消失。 */
function writeDataFileSync(payload) {
  /* 损坏锁定：这里是唯一写入口，锁在这里 = data:save 与 app:flush-sync 一起守住（见 dataWriteLock 注释 ②）。
     抛错而不是静默 return：静默会把「没保存」伪装成「保存成功」，用户以为存上了。 */
  if (dataWriteLock) {
    const e = new Error('数据文件被判为损坏，已暂停写入以免覆盖它——请到「备份管理」恢复，或点窗口顶部横幅的「继续用新数据」放弃它');
    e.locked = true;
    throw e;
  }
  const dir = path.dirname(DATA_FILE());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  /* 自动备份：写前把现有文件轮换备份，保留 3 份（防误操作/崩溃丢数据） */
  rotateBackups(DATA_FILE());
  fs.writeFileSync(DATA_FILE(), JSON.stringify(payload, null, 2), 'utf8');
}
/* ── 「这个 id 的 .md 在哪儿」索引 ──────────────────────────────
   扫描（`vault:scan`）本来就把每个 `.md` 读了一遍，顺手记下 **id → 它见过的那几个文件路径**，
   零额外 I/O。写盘时按 id 直接找到旧文件删掉，**不必再把目录里每个 .md 读一遍比对** ——
   那是 O(节点数²) 次读盘：`writeAll` 每次自动落盘都会遍历全部节点，几百个节点就是每次落盘几万次读盘。
   值里**含同 id 的全部文件**（不只扫描的赢家）：那些败者同样要清掉，正是「同 id 只留一份」。
   键 = `世界\u0000范围\u0000id`，范围 = 时间线名（节点）或 `_设定`（实体）。
   ⚠️ 索引只是**线索**不是真相：删之前会再解析一遍确认 id（见 `dropVaultFileIfSameId`），
   所以索引半张、过期都不会误删别人的文件（`vault:scan` 开头清空重建）。 */
const vaultFileIndex = new Map();
const vaultIdxKey = (wsName, scope, id) => `${wsName}\u0000${scope}\u0000${id}`;
/** 扫描期登记：这个 id 在这个文件里出现过（同 id 的败者也登记）。wsName 缺省 = 这一趟不登记。 */
function indexVaultFile(wsName, scope, id, p) {
  if (!wsName) return;
  const k = vaultIdxKey(wsName, scope, id);
  const arr = vaultFileIndex.get(k);
  if (!arr) vaultFileIndex.set(k, [p]);
  else if (!arr.includes(p)) arr.push(p);
}

/** 删掉一份「同 id 的旧文件」（`keepPath` 那份留着）。
 *  **必须自己再解析一遍确认 id**：索引与兜底都可能过期，或者那个路径已被用户换成别的节点。
 *  也只删**当前 vault 根目录里**的文件 —— 免得换了 vault 之后拿旧索引去删上一个 vault 的东西。 */
function dropVaultFileIfSameId(p, keepPath, id, parse) {
  if (path.resolve(p) === path.resolve(keepPath)) return false;
  if (!path.resolve(p).startsWith(path.resolve(VAULT_DIR()) + path.sep)) return false;
  let old = null;
  try { old = parse(fs.readFileSync(p, 'utf8')); } catch (e) { return false; }   /* 读不了的旧文件忽略 */
  if (!old || old.id !== id) return false;
  try { fs.rmSync(p, { force: true }); return true; } catch (e) { return false; }   /* 删不掉就算了，下次写盘再试 */
}

/** 删掉这条时间线下**同 id 的旧节点 .md**（`keepPath` 那份留着）。
 *
 *  为什么非要删：节点的「种类」= 它所在的文件夹名（见 nodePath / scanTimelineDir），
 *  所以在应用里换种类 = 把文件搬到另一个文件夹。旧文件夹里那份不走，重扫时同 id 是
 *  **后来者覆盖**（`scanTimelineDir` 里 `nodesById.set(n.id, n)`），readdir 顺序一不合适，
 *  旧文件就会把种类连同字段一起打回旧值 —— 用户看到的是「我改的东西自己变回去了」。
 *
 *  两层（从一次解析起步，不再扫目录）：
 *    ① **索引**：扫描时见过这个 id 的每个文件 —— 改名 / 换种类 / 同 id 两份，全覆盖，O(1)。
 *    ② **兜底**：这条时间线的**其它种类文件夹里同名**的那份。索引冷或过期时（例如刚从回收站恢复、
 *       或重复是扫描之后才在外部冒出来的）还能兜住最常见的那种形状；只 stat，不读内容。
 *  「改名 + 换种类同时发生」也在 ① 的覆盖里，所以不再需要全树扫。 */
function dropStaleNodeFiles(wsName, tlName, node, keepPath) {
  const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_');
  /* ① 索引 */
  for (const p of vaultFileIndex.get(vaultIdxKey(wsName, tlName, node.id)) ?? []) {
    dropVaultFileIfSameId(p, keepPath, node.id, mdToNode);
  }
  /* ② 兜底：别的种类文件夹 / 时间线直接层（旧两层结构）里的同名文件 */
  const tlDir = path.join(VAULT_DIR(), safe(wsName), safe(tlName));
  const fileName = safe(node.title) + '.md';
  const elsewhere = [path.join(tlDir, fileName)];
  try {
    for (const e of fs.readdirSync(tlDir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.')) elsewhere.push(path.join(tlDir, e.name, fileName));
    }
  } catch (e) { /* 时间线目录还不存在：没有旧文件可清 */ }
  for (const p of elsewhere) if (fs.existsSync(p)) dropVaultFileIfSameId(p, keepPath, node.id, mdToNode);
}

function writeVaultNodeSync(wsName, tlName, node) {
  const target = nodePath(wsName, tlName, node);
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  dropStaleNodeFiles(wsName, tlName, node, target);
  fs.writeFileSync(target, nodeToMd(node), 'utf8');
  /* 写完了：这个 id 现在住在这儿（收窄到一份；扫描期仍会登记同 id 的全部文件） */
  vaultFileIndex.set(vaultIdxKey(wsName, tlName, node.id), [target]);
}

/** 实体的 .md 路径：<世界>/_设定/<类型>/<名字>.md */
function entityPath(wsName, typeName, e) {
  return path.join(VAULT_DIR(), safeName(wsName), ENTITY_DIR, safeName(typeName || '未分类'), safeName(e.name) + '.md');
}
/** 实体根目录里的全部 .md 路径（`.trash` 等隐藏目录不算）。 */
function entityFiles(wsName) {
  const root = path.join(VAULT_DIR(), safeName(wsName), ENTITY_DIR);
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const t of fs.readdirSync(root, { withFileTypes: true })) {
    if (!t.isDirectory() || t.name.startsWith('.')) continue;
    const tDir = path.join(root, t.name);
    for (const f of fs.readdirSync(tDir)) if (f.endsWith('.md')) out.push(path.join(tDir, f));
  }
  return out;
}
/** 删掉这个世界里**同 id 的旧实体 .md**（`keepPath` 那份留着）。结构与理由同 dropStaleNodeFiles
 *  （实体侧「换类型」= 搬到另一个类型文件夹，残留会让 typeId 每次回扫被打回原值）：
 *  ① **索引**按 id：改名 / 换类型 / 同 id 两份全覆盖，O(1)；
 *  ② **兜底**：**别的类型文件夹里同名**的那份（索引冷或过期时兜住换类型这一种形状）。 */
function dropStaleEntityFiles(wsName, entity, keepPath) {
  /* ① 索引 */
  for (const p of vaultFileIndex.get(vaultIdxKey(wsName, ENTITY_DIR, entity.id)) ?? []) {
    dropVaultFileIfSameId(p, keepPath, entity.id, mdToEntity);
  }
  /* ② 兜底：别的类型文件夹里的同名文件（同类型目录那份由索引负责，这里不重复读） */
  const fileName = safeName(entity.name) + '.md';
  const dir = path.dirname(keepPath);
  for (const p of entityFiles(wsName)) {
    if (path.dirname(p) === dir || path.basename(p) !== fileName) continue;
    dropVaultFileIfSameId(p, keepPath, entity.id, mdToEntity);
  }
}

function writeVaultEntitySync(wsName, typeName, entity) {
  const target = entityPath(wsName, typeName, entity);
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  dropStaleEntityFiles(wsName, entity, target);
  fs.writeFileSync(target, entityToMd(entity, typeName), 'utf8');
  vaultFileIndex.set(vaultIdxKey(wsName, ENTITY_DIR, entity.id), [target]);
}

/* ── IPC: write the worldbuilding data file ────────────────── */
ipcMain.handle('data:save', (e, payload) => {
  try {
    writeDataFileSync(payload);
    return { ok: true };
  } catch (err) {
    /* 上锁不是故障而是有意为之：单列 locked 让渲染层/自动化能区分「写失败」与「故意不写」 */
    if (err && err.locked) return { ok: false, locked: true, error: String(err.message) };
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
/** 扫描一个时间线目录 → 节点数组（按 id 去重）。
 *  节点可能落在两处：时间线直接层（旧两层结构，kind 缺省「事件」）与类型文件夹层（kind = 文件夹名）；
 *  同 id 以类型文件夹版为准。vault:scan 与回收站恢复共用这一份遍历逻辑（恢复那趟不传 wsName = 不登记索引）。
 *  顺带把**每个**解析到的 (id → 文件路径) 登记进 `vaultFileIndex`（含同 id 的败者），
 *  写盘时才能按 id O(1) 找旧文件删 —— 见该索引入口的注释。 */
function scanTimelineDir(tlDir, wsName, tlName) {
  const nodesById = new Map();
  for (const f of fs.readdirSync(tlDir)) {
    if (!f.endsWith('.md')) continue;
    const p = path.join(tlDir, f);
    const n = mdToNode(fs.readFileSync(p, 'utf8'));
    if (n && n.id) {
      indexVaultFile(wsName, tlName, n.id, p);
      if (!n.title) n.title = f.replace(/\.md$/, '');
      if (!n.kind) n.kind = '事件';
      nodesById.set(n.id, n);
    }
  }
  for (const sub of fs.readdirSync(tlDir, { withFileTypes: true })) {
    if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
    const subDir = path.join(tlDir, sub.name);
    for (const f of fs.readdirSync(subDir)) {
      if (!f.endsWith('.md')) continue;
      const p = path.join(subDir, f);
      const n = mdToNode(fs.readFileSync(p, 'utf8'));
      if (n && n.id) {
        indexVaultFile(wsName, tlName, n.id, p);
        if (!n.title) n.title = f.replace(/\.md$/, '');
        n.kind = sub.name;
        nodesById.set(n.id, n);
      }
    }
  }
  return [...nodesById.values()];
}

/** 扫描一个世界观目录 → { 时间线名: 节点[] }（跳过隐藏目录与实体根目录 `_设定`）。
 *  **空的时间线也要收（nodes: []）**：vault 的目录结构才是「这个世界有几条时间线」的依据，
 *  节点只是内容。过去只收「有节点的」时间线/世界，后果是：删掉一条时间线里的最后一个节点后，
 *  重扫结果里连这条时间线、这个世界都不存在了 —— 而渲染层是 `d.worldsets = 扫描结果` 整体替换，
 *  于是整个世界（地图/实体/循环/剧情线/自定义历法）当场从界面消失，并被随后的自动落盘写进 JSON。 */
function scanWorldDir(wsDir, wsName) {
  const tls = {};
  for (const tl of fs.readdirSync(wsDir, { withFileTypes: true })) {
    if (!tl.isDirectory() || tl.name.startsWith('.')) continue;
    if (tl.name === ENTITY_DIR) continue;   /* 实体根目录不是一条时间线 */
    tls[tl.name] = scanTimelineDir(path.join(wsDir, tl.name), wsName, tl.name);
  }
  return tls;
}

/** 扫描一个世界的实体根目录 `_设定/<类型>/*.md` → { 类型名: 实体[] }（按 id 去重）。
 *  实体不存在时间线层级（它们属于整个世界），所以单独一趟。 */
function scanEntityDir(wsDir, wsName) {
  const root = path.join(wsDir, ENTITY_DIR);
  const out = {};
  if (!fs.existsSync(root)) return out;
  for (const t of fs.readdirSync(root, { withFileTypes: true })) {
    if (!t.isDirectory() || t.name.startsWith('.')) continue;
    const tDir = path.join(root, t.name);
    const list = [];
    const seen = new Set();
    for (const f of fs.readdirSync(tDir)) {
      if (!f.endsWith('.md')) continue;
      const p = path.join(tDir, f);
      const e = mdToEntity(fs.readFileSync(p, 'utf8'));
      if (e && e.id) {
        indexVaultFile(wsName, ENTITY_DIR, e.id, p);   /* 同 id 的败者也登记（写盘时要清掉） */
        if (!seen.has(e.id)) {
          if (!e.name) e.name = f.replace(/\.md$/, '');
          e.type = t.name;
          seen.add(e.id);
          list.push(e);
        }
      }
    }
    out[t.name] = list;
  }
  return out;
}

/* ── IPC: 扫描 vault 全部节点 .md（frontmatter + 正文）→ 按世界观/时间线分组；实体另开一路 ── */
ipcMain.handle('vault:scan', () => {
  try {
    const root = VAULT_DIR();
    /* 索引 = 「上一次扫描看到的样子」，所以每次整张重建：不然删掉/挪走的旧条目会越积越多。
       清空是安全的 —— 每一条都只是**线索**，真删之前还会再解析一遍确认 id（dropVaultFileIfSameId）。 */
    vaultFileIndex.clear();
    if (!fs.existsSync(root)) return { ok: true, worlds: {}, entities: {} };
    const worlds = {};
    const entities = {};
    for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ws.isDirectory() || isReservedDir(ws.name)) continue;   /* .trash / assets 不是世界观 */
      /* 空世界也要收：世界目录存在 = 这个世界存在（见 scanWorldDir 注释） */
      const wsDir = path.join(root, ws.name);
      worlds[ws.name] = scanWorldDir(wsDir, ws.name);
      entities[ws.name] = scanEntityDir(wsDir, ws.name);
    }
    return { ok: true, worlds, entities };
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

/* ── IPC: 写入单个实体 .md（<世界>/_设定/<类型>/<名字>.md）── */
ipcMain.handle('vault:write-entity', (e, { wsName, typeName, entity }) => {
  try {
    writeVaultEntitySync(wsName, typeName, entity);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/** 删除实体：把它的 .md 移进回收站（按 id 在 `<世界>/_设定/**` 里找，而不是按名字 ——
 *  用户可能刚改过名字，文件名已经变了）。不移走文件的话，下次重扫会把它从文件里拉回来
 *  （与节点删除同一个坑，见上面 vault:delete 的说明）。 */
ipcMain.handle('vault:delete-entity', (e, { wsName, entity }) => {
  try {
    const root = VAULT_DIR();
    const entRoot = path.join(root, safeName(wsName), ENTITY_DIR);
    if (!fs.existsSync(entRoot)) return { ok: true, moved: 0 };
    let moved = 0;
    for (const t of fs.readdirSync(entRoot, { withFileTypes: true })) {
      if (!t.isDirectory() || t.name.startsWith('.')) continue;
      const tDir = path.join(entRoot, t.name);
      for (const f of fs.readdirSync(tDir)) {
        if (!f.endsWith('.md')) continue;
        const p = path.join(tDir, f);
        let old = null;
        try { old = mdToEntity(fs.readFileSync(p, 'utf8')); } catch (err) { continue; }
        if (!old || old.id !== entity.id) continue;
        moveToTrash(path.relative(root, p), { kind: 'entity', title: old.name || f, world: wsName, type: t.name, entityId: entity.id });
        moved++;
      }
    }
    return { ok: true, moved };
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
    kind: (meta && meta.kind) || 'node',        /* node | timeline | world | entity */
    relPath,                                     /* vault 内原始相对路径 —— 恢复就靠它 */
    trashName: name,
    ts,
    title: (meta && meta.title) || base,
    world: (meta && meta.world) || undefined,
    timeline: (meta && meta.timeline) || undefined,
    nodeId: (meta && meta.nodeId) || undefined,
    /* 实体专用：type = 类型 id（恢复到 store 时要还原成 typeId），entityId = 被删实体的 id。
       以前这两项收了却没登记 —— 恢复时只能靠 .md frontmatter 里的 `type:` 兜底，
       而 frontmatter 的 type 来自文件夹名，用户改过类型后就对不上。 */
    type: (meta && meta.type) || undefined,
    entityId: (meta && meta.entityId) || undefined,
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
          if (x.kind === 'entity') {
            const e = mdToEntity(fs.readFileSync(p, 'utf8'));
            preview = `${e.name || ''}${e.type ? ' · ' + e.type : ''}`;
          } else {
            const n = mdToNode(fs.readFileSync(p, 'utf8'));
            if (n) preview = `${n.title || ''}${n.year !== undefined ? ' · ' + n.year : ''}`;
          }
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
      } else if (kind === 'entity') {
        /* 实体恢复：文件已按索引里的 relPath 移回 `_设定/<类型>/<名字>.md`，
           这里把解析出来的实体一并返回，渲染层据此直接插回 store（不必重扫）。 */
        let en = null;
        try { en = mdToEntity(fs.readFileSync(finalDest, 'utf8')); } catch (err) { en = null; }
        out.world = (rec && rec.world) || it.world;
        out.type = (rec && rec.type) || it.entityType;
        out.entity = en;
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
      /* 上锁时跳过 JSON 但不计入 failed：节点/实体仍要写进 vault，退出不该因此报错 */
      try { writeDataFileSync(payload.data); out.wrote++; }
      catch (err) { if (err && err.locked) out.locked = true; else out.failed++; out.error = String(err); }
    }
    for (const it of (payload && payload.nodes) || []) {
      try { writeVaultNodeSync(it.wsName, it.tlName, it.node); out.wrote++; } catch (err) { out.failed++; out.error = String(err); }
    }
    for (const it of (payload && payload.entities) || []) {
      try { writeVaultEntitySync(it.wsName, it.typeName, it.entity); out.wrote++; } catch (err) { out.failed++; out.error = String(err); }
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
    /* vault 根不存在时**先建再监听**，不能直接失败退出。
       首次启动、或用户把 LINGKUANG_VAULT 指到一个还没建的目录时，它必然不存在；
       而「应用自己把 vault 建出来」是常态（第一次保存节点/实体就 mkdir）。
       以前这里直接 return ok:false，渲染层那句 `vaultWatch().catch(() => {})` 只接 reject、
       接不住 ok:false —— 于是**整个会话都不会有监听**，外部改的 .md 一律不回扫，
       直到下次重启才恢复（界面上没有任何提示）。
       实测：空目录起步的实例跑 tools/e2e/entity-vault.cjs 必挂 ★5/★6（外部改字段/正文
       回扫进活 UI），而 vault 目录已存在的实例全过 —— 差别就在这一行。 */
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
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
  /* 用户副本存在但解析不了时，和世界观数据同样处理：先逐字节另存再回 ok:false，
     绝不让损坏的词库被下一次 lib:save 直接覆盖掉。种子解析失败没得救（只读、随包）。 */
  const mine = LIB_FILE();
  const useMine = fs.existsSync(mine);
  const f = useMine ? mine : LIB_SEED();
  let raw;
  try {
    raw = fs.readFileSync(f, 'utf8');
  } catch (e) {
    return { ok: false, error: e.code || String(e) };
  }
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) {
    if (!useMine) return { ok: false, error: '种子词库解析失败：' + (e && e.message ? e.message : String(e)) };
    const corruptPath = preserveFile(mine, 'corrupt');
    notifyCorruptData('角色词库', 'character_lib.json', corruptPath, Buffer.byteLength(raw, 'utf8'), e);
    return { ok: false, error: 'JSON 解析失败：' + (e && e.message ? e.message : String(e)), corruptPath };
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
/* 字段允许的类型（与 src/store/types.ts 的 FieldType 对齐）。
   'list' 的值是数组，补默认值时必须给 [] 而不是 ''，否则编辑器按字符串渲染出空输入框。 */
const FORMAT_TYPES = ['text', 'longtext', 'number', 'boolean', 'list'];
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

/* 读取格式定义：有用户文件就以**用户文件为准**，没有才用内建默认。
   旧实现是「内建 5 个 kind + 用户浅合并」（`merged[k] = { ...v, ...parsed[k] }`）——
   后果是**内建种类删不掉**：用户在「结构体管理」里删了「角色」，下次读又冒出来，
   而 formats.json 是整份写出的，本来就不需要兜底合并。
   现在：文件存在且能解析成对象 → 直接用（只做字段级规整）；否则回退内建默认。 */
function loadFormatsRaw() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FORMATS_FILE(), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length) {
      const out = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (!v || typeof v !== 'object') continue;
        const fields = Array.isArray(v.fields) ? v.fields : [];
        out[k] = {
          id: String(v.id ?? k),
          name: String(v.name ?? k),
          /* 只保留认识的结构，顺手过滤空字段名（手改文件写出 `{name:''}` 会让面板出现空行） */
          fields: fields
            .filter((f) => f && typeof f.name === 'string' && f.name.trim())
            .map((f) => ({ name: String(f.name).trim(), type: FORMAT_TYPES.includes(f.type) ? f.type : 'text' })),
        };
      }
      return out;
    }
    return { ...DEFAULT_FORMATS };
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
    const file = LIB_FILE();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    /* 和世界观数据一样先轮换备份。词库此前是完全裸奔的：lib:save 直接覆写，
       写坏或误导出一次就再也找不回来（它是用户在联想图里一点点攒出来的）。 */
    rotateBackups(file);
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
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

/* 单实例：第二次启动时关掉旧窗口，重新开一个（避免多窗口叠加）。
   ⚠️ 测试实例（已用 LINGKUANG_TEST_USERDATA 隔离了数据目录）**不参与**这把锁：
   否则它抢不到锁会自杀，而正式实例收到 second-instance 会把用户正在用的窗口销毁重建。 */
const gotLock = process.env.LINGKUANG_TEST_USERDATA ? true : app.requestSingleInstanceLock();
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
