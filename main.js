/* 灵框 v3 · Electron 主进程
 * 职责：创建窗口 + 提供 user-data 文件读写（IPC）。
 * 渲染进程通过 preload 暴露的 window.lingkuangAPI 调用，数据落盘到
 * user-data/worldbuilding.json —— 世界观数据真正物理存储。
 */
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
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
/* vault 根目录（节点 .md 文件存储，Obsidian 可打开编辑）。测试后门 LINGKUANG_VAULT。 */
const VAULT_DIR = () => process.env.LINGKUANG_VAULT
  ? process.env.LINGKUANG_VAULT
  : path.join('F:/', 'lingkuang-vault');
/* 主窗口引用（vault 文件变化推送用） */
let mainWin = null;

/* ── vault 序列化：TimelineNode <-> .md（YAML frontmatter + #字段：值 正文，无 yaml 依赖）── */
function nodeToMd(n) {
  const meta = ['id', 'title', 'year', 'precision', 'type'].filter((k) => n[k] !== undefined && n[k] !== null)
    .map((k) => `${k}: ${n[k]}`).join('\n');
  let body = '';
  body += `#描述：\n${n.desc || ''}\n\n`;   /* 总是带描述字段，Obsidian 可见可填 */
  if (n.doc) body += n.doc;
  return `---\n${meta}\n---\n${body}`.replace(/\r\n/g, '\n');
}
function mdToNode(text) {
  let fm = {}, rest = String(text || '');
  if (rest.startsWith('---')) {
    const end = rest.indexOf('\n---', 3);
    if (end !== -1) {
      rest.slice(3, end).split('\n').forEach((line) => {
        const m = line.match(/^(\w+):\s*(.*)$/);
        if (m) fm[m[1].trim()] = m[2].trim();
      });
      rest = rest.slice(end + 4);
    }
  }
  const node = {};
  ['id', 'title', 'precision', 'type'].forEach((k) => { if (fm[k] !== undefined) node[k] = fm[k]; });
  if (fm.year !== undefined) node.year = parseFloat(fm.year);
  /* 解析：#字段：值 行（desc 单独，值到第一个空行为止）；空行后的自由正文收集为 doc */
  const allLines = rest.split('\n');
  let desc = '', docParts = [];
  let cur = null, buf = [];
  const flush = () => { if (cur) { if (cur === '描述') desc = buf.join('\n').trim(); else docParts.push(`#${cur}：\n${buf.join('\n')}`); } };
  allLines.forEach((line, i) => {
    const m = line.match(/^#([^：:]+)[：:]\s*(.*)$/);
    if (m) { flush(); cur = m[1].trim(); buf = [m[2]]; return; }
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
  return node;
}
function nodePath(wsName, tlName, n) {
  const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_');
  return path.join(VAULT_DIR(), safe(wsName), safe(tlName), safe(n.title) + '.md');
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
        const nodes = [];
        for (const f of fs.readdirSync(tlDir)) {
          if (!f.endsWith('.md')) continue;
          const text = fs.readFileSync(path.join(tlDir, f), 'utf8');
          const n = mdToNode(text);
          if (n && n.id) { if (!n.title) n.title = f.replace(/\.md$/, ''); nodes.push(n); }
        }
        if (nodes.length) tls[tl.name] = nodes;
      }
      if (Object.keys(tls).length) worlds[ws.name] = tls;
    }
    return { ok: true, worlds };
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
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
