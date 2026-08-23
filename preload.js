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
  vaultWrite: (wsName, tlName, node) => ipcRenderer.invoke('vault:write', { wsName, tlName, node })
});
