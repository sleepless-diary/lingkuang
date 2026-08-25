/* 灵框 v3 · preload —— 渲染进程与主进程的安全桥 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lingkuangAPI', {
  /* load the worldbuilding data (timelines + docs + people/places) */
  loadData: () => ipcRenderer.invoke('data:load'),
  /* persist the whole data file */
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  /* user settings (glide speed, sensitivity, ruler density) */
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  /* 格式/结构体定义（kind → 应填字段集合） */
  loadFormats: () => ipcRenderer.invoke('formats:load'),
  saveFormats: (formats) => ipcRenderer.invoke('formats:save', formats),
  /* character generator word bank (data/character_lib.json) */
  loadCharLib: () => ipcRenderer.invoke('lib:load'),
  /* word association via local Ollama (qwen2.5:7b) */
  associate: (word) => ipcRenderer.invoke('ai:associate', word),
  /* write character lib (staged words export) */
  saveCharLib: (data) => ipcRenderer.invoke('lib:save', data),
  /* batch classify words via Ollama */
  classifyWords: (words) => ipcRenderer.invoke('ai:classify', words),
  /* vault：每个节点 = 外部 .md 文件（Obsidian 可编辑，文件为源） */
  vaultScan: () => ipcRenderer.invoke('vault:scan'),
  vaultWrite: (wsName, tlName, node) => ipcRenderer.invoke('vault:write', { wsName, tlName, node }),
  vaultWatch: () => ipcRenderer.invoke('vault:watch'),
  vaultUnwatch: () => ipcRenderer.invoke('vault:unwatch'),
  onVaultChanged: (cb) => ipcRenderer.on('vault-changed', () => cb()),
  /* 读单个节点原始 .md 文本（检测 #正文： 标签缺失用） */
  readNodeText: (wsName, tlName, nodeId) => ipcRenderer.invoke('vault:readNode', { wsName, tlName, nodeId }),
  /* 导入图片到 vault assets（返回相对路径） */
  importImage: () => ipcRenderer.invoke('vault:importImage')
});
