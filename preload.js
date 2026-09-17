/* 灵框 v3 · preload —— 渲染进程与主进程的安全桥 */
const { contextBridge, ipcRenderer } = require('electron');

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
  /* batch classify words via Ollama */
  classifyWords: (words) => ipcRenderer.invoke('ai:classify', words),
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
