/* 灵框 v3 · preload —— 渲染进程与主进程的安全桥 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('lingkuangAPI', {
  /* load the worldbuilding data (timelines + docs + people/places) */
  loadData: () => ipcRenderer.invoke('data:load'),
  /* persist the whole data file */
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  /* 数据文件判损状态 / 解锁：data:load 回 corrupt:true 后，写盘被主进程上锁挡住，
     这两个是渲染层询问状态与「继续用新数据」的通道（见 main.js 的 dataWriteLock） */
  dataCorruptState: () => ipcRenderer.invoke('data:corrupt-state'),
  allowDataWrite: () => ipcRenderer.invoke('data:allow-write'),
  /* user settings (glide speed, sensitivity, ruler density) */
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  /* 格式/结构体定义（kind → 应填字段集合） */
  loadFormats: () => ipcRenderer.invoke('formats:load'),
  saveFormats: (formats) => ipcRenderer.invoke('formats:save', formats),
  /* character generator word bank (data/character_lib.json) */
  loadCharLib: () => ipcRenderer.invoke('lib:load'),
  /* 灵框助手：对话历史 + 长期记忆（主进程写 userData/agent/*.json，与 vault 一样是可备份的资产） */
  agentLoad: () => ipcRenderer.invoke('agent:load'),
  agentSave: (payload) => ipcRenderer.invoke('agent:save', payload),
  /* word association via local Ollama (qwen2.5:7b) */
  associate: (word) => ipcRenderer.invoke('ai:associate', word),
  /* write character lib (staged words export) */
  saveCharLib: (data) => ipcRenderer.invoke('lib:save', data),
  /* batch classify words via the AI engine (cfg = 渲染进程「当前在用」的供应商，可选) */
  classifyWords: (words, cfg) => ipcRenderer.invoke('ai:classify', words, cfg),
  /* vault：每个节点 = 外部 .md 文件（Obsidian 可编辑，文件为源） */
  vaultScan: () => ipcRenderer.invoke('vault:scan'),
  vaultWrite: (wsName, tlName, node) => ipcRenderer.invoke('vault:write', { wsName, tlName, node }),
  vaultWriteEntity: (wsName, typeName, entity) => ipcRenderer.invoke('vault:write-entity', { wsName, typeName, entity }),
  vaultDeleteEntity: (wsName, entity) => ipcRenderer.invoke('vault:delete-entity', { wsName, entity }),
  /* 删节点时把 vault 里对应 .md 移到 .trash（不删文件的话下次启动会复活） */
  vaultDelete: (wsName, tlName, node) => ipcRenderer.invoke('vault:delete', { wsName, tlName, node }),
  /* 删除整条时间线 / 整个世界观：目录整体移进回收站 */
  vaultDeleteTimeline: (wsName, tlName) => ipcRenderer.invoke('vault:delete-timeline', { wsName, tlName }),
  vaultDeleteWorld: (wsName) => ipcRenderer.invoke('vault:delete-world', { wsName }),
  /* 建世界时**把 vault 目录一起建出来**（否则下一次 vault 回扫这个世界就没了，见 main.js 那条注释） */
  vaultEnsureWorld: (name) => ipcRenderer.invoke('vault:ensure-world', { name }),
  /* 改名 = 改目录名（只在 store 里改名会让旧目录变成"另一个世界/时间线"，见 main.js 的注释） */
  vaultRenameWorld: (from, to) => ipcRenderer.invoke('vault:rename-world', { from, to }),
  vaultRenameTimeline: (wsName, from, to) => ipcRenderer.invoke('vault:rename-timeline', { wsName, from, to }),
  /* 「帮助」面板：打开使用手册 / 打开数据目录 / 版本信息 */
  openExternal: (url) => ipcRenderer.invoke('app:open-external', { url }),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  /* 回收站（vault/.trash + index.json）：列表 / 恢复 / 彻底删除 */
  trashList: () => ipcRenderer.invoke('vault:trash-list'),
  trashRestore: (items) => ipcRenderer.invoke('vault:trash-restore', { items }),
  trashPurge: (names) => ipcRenderer.invoke('vault:trash-purge', { names }),
  trashPurgeAll: () => ipcRenderer.invoke('vault:trash-purge', { all: true }),
  vaultWatch: () => ipcRenderer.invoke('vault:watch'),
  vaultUnwatch: () => ipcRenderer.invoke('vault:unwatch'),
  onVaultChanged: (cb) => ipcRenderer.on('vault-changed', () => cb()),
  /* 读单个节点原始 .md 文本（检测 #正文： 标签缺失用） */
  readNodeText: (wsName, tlName, nodeId) => ipcRenderer.invoke('vault:readNode', { wsName, tlName, nodeId }),
  /* 导入图片到 vault assets（返回相对路径） */
  importImage: () => ipcRenderer.invoke('vault:importImage'),
  /* 灵框助手的「文件夹手」：灵框**外**文件的读写（片 1）。
     ⭐ 白名单与路径校验都在主进程（`userData/agent-roots.json` + realpath 前缀比较），
     这里只是把 `fs:*` 通道摆出来；本层拿不到任何通用 fs —— 想加通道先改 main.js。 */
  fs: {
    roots: () => ipcRenderer.invoke('fs:roots'),
    addRoot: (payload) => ipcRenderer.invoke('fs:add-root', payload),
    removeRoot: (p) => ipcRenderer.invoke('fs:remove-root', p),
    setRootWrite: (p, write) => ipcRenderer.invoke('fs:set-root-write', { path: p, write }),
    list: (p) => ipcRenderer.invoke('fs:list', { path: p }),
    read: (p) => ipcRenderer.invoke('fs:read', { path: p }),
    search: (p, q) => ipcRenderer.invoke('fs:search', { path: p, q }),
    write: (p, text, mode) => ipcRenderer.invoke('fs:write', { path: p, text, mode }),
    /* 删一个文件 —— 主进程走系统回收站（`shell.trashItem`），只认可写白名单里的**文件** */
    remove: (p) => ipcRenderer.invoke('fs:delete', { path: p }),
    /* ⭐ 片 4（2026-10-15）：一次读**一批** + 导入进度 —— 用户问「为什么他干活了这么久但是我一个节点都没看到」。
       `readMany` 默认读"还没读过的下一批"（已读清单在主进程 `userData/agent-imports.json`），
       `importStatus` 报"整库 N 个文本文件 / 已读 M / 还剩 K"。两者都只读、都过同一份白名单。 */
    readMany: (payload) => ipcRenderer.invoke('fs:read-many', payload),
    importStatus: (payload) => ipcRenderer.invoke('fs:import-status', payload)
  },
  /* 灵框助手的「联网手」：搜索 + 抓网页（片 2，2026-09-29）。
     ⭐ 只有主进程能出手（渲染进程直连第三方会被 CORS 拦），且由主进程把关"只认 http/https、不碰本机内网"。 */
  web: {
    search: (q, limit) => ipcRenderer.invoke('web:search', { q, limit }),
    fetch: (url) => ipcRenderer.invoke('web:fetch', { url })
  },
  /* ⭐ 拖进会话的文件要拿到**磁盘路径**（Electron 30 起 `File.path` 没了，官方给的这条：
     渲染层的 File 对象交给 preload，由 `webUtils.getPathForFile()` 换路径）。拿不到就返回空串 ——
     内容照样能靠 FileReader 读（见 `src/ui/agent-attach.ts`），只是"灵框外 ⇒ 要授权"那句提示会少一点信息。 */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch (e) { return ''; }
  },
  /* 退出前同步落盘：beforeunload 里用，异步 IPC 在窗口销毁后不保证跑完 */
  flushSync: (payload) => ipcRenderer.sendSync('app:flush-sync', payload),
  /* 备份管理（target: 'data' = 世界观数据 | 'lib' = 角色词库）
     每个数据文件都有：自动轮换 .backup-0/1/2、损坏存档 .bak-corrupt-*、
     手动备份 .bak-manual-*、恢复前快照 .bak-prerestore-* */
  backupList: (target) => ipcRenderer.invoke('backup:list', { target }),
  backupCreate: (target) => ipcRenderer.invoke('backup:create', { target }),
  backupRestore: (target, path) => ipcRenderer.invoke('backup:restore', { target, path }),
  backupExport: (target) => ipcRenderer.invoke('backup:export', { target }),
  backupImport: (target) => ipcRenderer.invoke('backup:import', { target })
});
