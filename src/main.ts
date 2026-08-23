/** 灵框 · 入口（Vite） */
import createStore, { emptyData } from './store/store';
import { renderShell } from './ui/shell';
import './style.css';

/** 数据加载：优先 vault(.md 文件为源)；无 vault 则回退 JSON/空数据 */
async function loadData() {
  const api = (window as any).lingkuangAPI;
  /* ① vault 为源：扫描 .md 文件生成 store 数据 */
  if (api && api.vaultScan) {
    try {
      const vres = await api.vaultScan();
      if (vres && vres.ok && vres.worlds) {
        const data = vaultToWorldData(vres.worlds);
        if (Object.keys(data.worldsets).length) return data;
      }
    } catch (e) { /* vault 失败则回退 */ }
  }
  /* ② 回退 JSON（旧数据/首次） */
  if (api && api.loadData) {
    const res = await api.loadData();
    if (res && res.ok && res.data) return res.data;
  }
  return emptyData();
}

/** vault 扫描结果 {世界观:{时间线:[节点]}} → WorldData */
function vaultToWorldData(worlds: Record<string, Record<string, any[]>>) {
  const worldsets: Record<string, any> = {};
  for (const [wsName, tls] of Object.entries(worlds || {})) {
    const timelines: Record<string, any> = {};
    const order: string[] = [];
    for (const [tlName, nodes] of Object.entries(tls || {})) {
      const id = 'tl-' + tlName;
      timelines[id] = { id, name: tlName, absOffset: 0, nodes, loops: [], storylines: [] };
      order.push(id);
    }
    worldsets[wsName] = { name: wsName, timelines, order, docs: {}, timeCursor: null };
  }
  return { worldsets };
}

async function main() {
  const data = await loadData();
  const store = createStore(data);
  /* 自动落盘：任何 store 变化 → 防抖 400ms → 写 vault(.md 为源) + JSON 缓存 */
  let saveTimer: number | undefined;
  let suppressWrite = false;   /* 外部 vault 改动重载时设为 true，避免写回造成循环 */
  store.subscribe(() => {
    if (suppressWrite) return;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      const api = (window as any).lingkuangAPI;
      if (!api) return;
      /* ① 写 vault：遍历所有节点 → 各自 .md 文件 */
      if (api.vaultWrite) {
        for (const [wsName, ws] of Object.entries(store.data.worldsets)) {
          for (const tlId of (ws.order ?? [])) {
            const tl = ws.timelines[tlId];
            if (!tl) continue;
            for (const node of tl.nodes) {
              try { await api.vaultWrite(wsName, tl.name, node); } catch (e) { /* 单节点失败忽略 */ }
            }
          }
        }
      }
      /* ② 写 JSON 缓存（保留旧流程，作备份） */
      if (api.saveData) api.saveData(store.data);
    }, 400);
  });
  const host = document.getElementById('app')!;
  renderShell(store, host);

  /* 同步刷新：监听外部 Obsidian 改 vault .md → 重新 scan → 替换 store（文件为源，不写回） */
  const api = (window as any).lingkuangAPI;
  if (api?.vaultWatch) api.vaultWatch().catch(() => {});
  if (api?.onVaultChanged) {
    api.onVaultChanged(async () => {
      try {
        const vres = await api.vaultScan();
        if (vres && vres.ok && vres.worlds) {
          suppressWrite = true;
          store.update((d) => { d.worldsets = vaultToWorldData(vres.worlds).worldsets; });
          suppressWrite = false;
        }
      } catch (e) { /* ignore */ }
    });
  }

  /* 撤销/重做快捷键（避开输入框焦点） */
  window.addEventListener('keydown', (e) => {
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      store.redo();
    }
  });
}

main();
