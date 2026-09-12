/** 灵框 · actions（通过 store.update 修改数据——视图不直接碰 data） */
import type { Store } from './store';
import { currentWorld } from './store';
import type { Timeline, TimelineNode, Entity, Worldset, WorldData } from './types';

export function addTimeline(store: Store, name: string): string {
  const id = 'tl' + Date.now();
  store.update((d) => {
    const ws = d.worldsets[store.activeWorld];
    if (!ws) return;
    ws.timelines[id] = { id, name, absOffset: 0, nodes: [], loops: [], storylines: [] };
    ws.order.push(id);
  });
  return id;
}

export function addNode(store: Store, tlId: string, node: Partial<TimelineNode>): string {
  const id = 'n' + Date.now();
  store.update((d) => {
    const tl = d.worldsets[store.activeWorld]?.timelines[tlId];
    if (!tl) return;
    /* 先展开调用方字段、再补默认值。以前是逐字段白名单，未列出的字段被静默吃掉
       （`desc` 就在其中——node-form 一直传 `desc`，落库时消失，面板永远空着）。 */
    tl.nodes.push({
      ...node,
      id,
      title: node.title ?? '新节点',
      year: node.year ?? 0,
      precision: node.precision ?? 'year',
      type: node.type ?? 'world_event',
      doc: node.doc ?? '',
    });
  });
  return id;
}

/** 写回节点正文。opts.world 用于「编辑非活动世界的节点」——
    编辑器侧栏会列出所有世界，若一律按 store.activeWorld 解析，点开别的世界的节点
    再编辑会被静默丢弃（`if (n)` 直接 no-op），状态栏却仍显示「已保存 ✓」。 */
export function saveNodeDoc(store: Store, tlId: string, nodeId: string, doc: string, opts?: { undo?: boolean; world?: string; keepRedo?: boolean }) {
  store.update(
    (d) => {
      const n = d.worldsets[opts?.world ?? store.activeWorld]?.timelines[tlId]?.nodes.find((x) => x.id === nodeId);
      if (n) n.doc = doc;
    },
    opts
  );
}

export function addEntity(store: Store, entity: Partial<Entity>): string {
  const id = 'e' + Date.now();
  store.update((d) => {
    const ws = d.worldsets[store.activeWorld];
    if (!ws) return;
    if (!ws.entities) ws.entities = {};
    ws.entities[id] = { id, typeId: entity.typeId ?? 'default', name: entity.name ?? '新实体', doc: entity.doc ?? '' };
  });
  return id;
}

export function addMap(store: Store, name: string): string {
  const id = 'm' + Date.now();
  store.update((d) => {
    const ws = d.worldsets[store.activeWorld];
    if (!ws) return;
    if (!ws.maps) ws.maps = [];
    ws.maps.push({ id, name, width: 800, height: 500, regions: [], markers: [], paths: [] });
  });
  return id;
}

export function setTimeCursor(store: Store, t: number | null) {
  store.update(
    (d) => {
      const ws = d.worldsets[store.activeWorld];
      if (ws) ws.timeCursor = t;
    },
    /* 指针拖动高频 → 不占撤销格（一次拖动会触发几十次）。但它**仍是持久化的用户改动**
       （时间指针是「这个世界此刻的时间」，不是滚动位置），所以按 store 的新规则
       它会作废重做分支 —— 故意**不**传 keepRedo。 */
    { undo: false }
  );
}

export function getTimeline(store: Store, tlId: string): Timeline | undefined {
  return currentWorld(store).timelines?.[tlId];
}

/* ── 循环（轮回）────────────────────────────────────────────────
   这些写操作必须走 store.update：`timeline()` 返回的是 store.data 里的**活引用**，
   直接改它既不 notify（tab 节点计数停在旧值）、也不进撤销栈，更不会触发落盘
   （main.ts 的防抖写盘挂在 store 通知上）→ 改完直接关窗就丢。 */
export function addLoop(store: Store, tlId: string, loop: { name: string; startId?: string; endId?: string; count?: number }): string {
  const id = 'lp' + Date.now();
  store.update((d) => {
    const tl = d.worldsets[store.activeWorld]?.timelines[tlId];
    if (!tl) return;
    if (!tl.loops) tl.loops = [];
    tl.loops.push({ id, name: loop.name, startId: loop.startId, endId: loop.endId, count: loop.count ?? 2 });
  });
  return id;
}

export function setLoopCount(store: Store, tlId: string, loopId: string, count: number) {
  store.update((d) => {
    const l = d.worldsets[store.activeWorld]?.timelines[tlId]?.loops?.find((x) => x.id === loopId);
    if (l) l.count = count;
  });
}

export function removeLoop(store: Store, tlId: string, loopId: string) {
  store.update((d) => {
    const tl = d.worldsets[store.activeWorld]?.timelines[tlId];
    if (tl) tl.loops = (tl.loops ?? []).filter((x) => x.id !== loopId);
  });
}

/** 复制节点（带新 id；失败返回 undefined） */
export function copyNode(store: Store, tlId: string, nodeId: string): string | undefined {
  const newId = 'n' + Date.now();
  let ok = false;
  store.update((d) => {
    const tl = d.worldsets[store.activeWorld]?.timelines[tlId];
    const n = tl?.nodes.find((x) => x.id === nodeId);
    if (!tl || !n) return;
    tl.nodes.push({ ...n, id: newId, title: n.title + ' 副本' });
    ok = true;
  });
  return ok ? newId : undefined;
}

/** 删除节点：先从 store 移除，再把 vault 里对应的 .md 移到 vault/.trash/。
 *
 *  为什么动作层要碰 vault：`.md` 是「文件为源」，只从 store 删而文件还在的话，
 *  下次启动扫描会把它读回来 —— 节点复活，用户会以为删除没生效。
 *  这里是唯一的删除入口（时间线右键菜单 + 详情面板「删除」都走它），
 *  放在动作里才不会漏掉某条调用路径。移文件是异步的，失败也不该挡住 UI
 *  （JSON 缓存里已经删掉了，最坏情况是下次启动多一个待删节点）。 */
export function removeNode(store: Store, tlId: string, nodeId: string) {
  const tl = currentWorld(store).timelines?.[tlId];
  const node = tl?.nodes.find((x) => x.id === nodeId);
  const tlName = tl?.name;
  store.update((d) => {
    const t = d.worldsets[store.activeWorld]?.timelines[tlId];
    if (t) t.nodes = t.nodes.filter((x) => x.id !== nodeId);
  });
  const api = (window as unknown as { lingkuangAPI?: { vaultDelete?: (ws: string, tl: string, n: unknown) => Promise<unknown> } }).lingkuangAPI;
  if (api?.vaultDelete && node && tlName) {
    api.vaultDelete(store.activeWorld, tlName, node).catch(() => { /* 文件删除失败不阻断 */ });
  }
}

/* ── 世界观 / 时间线（增删与回收站配套）───────────────────────────────
   为什么这些动作也要碰 vault：`.md` 是「文件为源」。只从 store 删而文件还在，
   下次扫描会把整条时间线 / 整个世界读回来 —— 删除等于没生效。 */

/** 新建世界观。重名自动加序号（避免覆盖已有世界）。 */
export function addWorld(store: Store, name: string): string {
  const base = name.trim() || '新世界';
  let finalName = base;
  let i = 2;
  while (store.data.worldsets[finalName]) finalName = `${base} ${i++}`;
  store.update((d) => {
    d.worldsets[finalName] = { name: finalName, timelines: {}, order: [], docs: {} };
  });
  store.setActiveWorld(finalName);
  return finalName;
}

/** 删除整条时间线：store 移除 + vault 对应目录移进回收站（可恢复）。
 *  删的是当前时间线时切到剩下的第一条，否则 activeTimeline 悬空、沙盘空白。 */
export function removeTimeline(store: Store, tlId: string): void {
  const ws0 = currentWorld(store);
  const tlName = ws0.timelines?.[tlId]?.name;
  const wsName = store.activeWorld;
  const rest = (ws0.order ?? []).filter((id) => id !== tlId && ws0.timelines[id]);
  store.update((d) => {
    const ws = d.worldsets[wsName];
    if (!ws) return;
    delete ws.timelines[tlId];
    ws.order = (ws.order ?? []).filter((x) => x !== tlId);
  });
  if (store.activeTimeline === tlId && rest[0]) store.setActiveTimeline(rest[0]);
  const api = (window as unknown as { lingkuangAPI?: { vaultDeleteTimeline?: (ws: string, tl: string) => Promise<unknown> } }).lingkuangAPI;
  if (api?.vaultDeleteTimeline && tlName) api.vaultDeleteTimeline(wsName, tlName).catch(() => { /* 文件移动失败不阻断 UI */ });
}

/** 删除整个世界观：store 移除 + vault 目录移进回收站（可恢复）。
 *  删的是当前世界时切到剩下的第一个；一个都不剩就补一个空世界 ——
 *  否则 activeWorld 悬空，且灵框内没有别的「新建世界」入口，会走进死路。 */
export function removeWorld(store: Store, wsName: string): void {
  const rest = Object.keys(store.data.worldsets).filter((n) => n !== wsName);
  store.update((d) => { delete d.worldsets[wsName]; });
  if (store.activeWorld === wsName) {
    if (rest.length) store.setActiveWorld(rest[0]);
    else addWorld(store, '新世界');
  }
  const api = (window as unknown as { lingkuangAPI?: { vaultDeleteWorld?: (ws: string) => Promise<unknown> } }).lingkuangAPI;
  if (api?.vaultDeleteWorld) api.vaultDeleteWorld(wsName).catch(() => { /* 文件移动失败不阻断 UI */ });
}

/** vault 里的时间线是**按名字**分目录，而 store 里 timelines 是**按 id** 索引 —— 恢复时要对回名字。 */
function ensureTimelineByName(ws: Worldset, name: string): Timeline {
  const found = Object.values(ws.timelines ?? {}).find((t) => t.name === name);
  if (found) return found;
  const id = 'tl' + Date.now() + Math.floor(Math.random() * 1000);
  const tl: Timeline = { id, name, absOffset: 0, nodes: [], loops: [], storylines: [] };
  ws.timelines[id] = tl;
  ws.order = ws.order ?? [];
  if (!ws.order.includes(id)) ws.order.push(id);
  return tl;
}

/** 主进程 `vault:trash-restore` 的返回值（见 main.js 同名 handler） */
export interface TrashRestored {
  relPath: string;
  kind: string;
  world?: string;
  timeline?: string;
  node?: TimelineNode | null;
  nodes?: TimelineNode[];
  timelines?: Record<string, TimelineNode[]>;
}

/** 把回收站恢复出来的数据插回 store。
 *  只把文件移回 vault 是不够的：界面要等下次扫描才看得到，用户会以为恢复失败。
 *  按 id 幂等（vault 文件监听可能同时触发一次全量重扫，重复插入不会产生副本）。
 *  用 `{ undo: false }`：恢复是「找回已有文件」，不该占用撤销格。 */
export function applyTrashRestore(store: Store, restored: TrashRestored[]): { nodes: number; timelines: number; worlds: number } {
  let nNodes = 0;
  let nTls = 0;
  let nWs = 0;
  store.update((d) => {
    for (const r of restored) {
      if (r.kind === 'world' && r.world) {
        if (!d.worldsets[r.world]) {
          d.worldsets[r.world] = { name: r.world, timelines: {}, order: [], docs: {} };
          nWs++;
        }
        const ws = d.worldsets[r.world];
        for (const [tlName, nodes] of Object.entries(r.timelines ?? {})) {
          const tl = ensureTimelineByName(ws, tlName);
          for (const n of nodes) if (!tl.nodes.some((x) => x.id === n.id)) { tl.nodes.push(n); nNodes++; }
        }
      } else if (r.kind === 'timeline' && r.world && r.timeline) {
        if (!d.worldsets[r.world]) { d.worldsets[r.world] = { name: r.world, timelines: {}, order: [], docs: {} }; nWs++; }
        const ws = d.worldsets[r.world];
        const existed = Object.values(ws.timelines ?? {}).some((t) => t.name === r.timeline);
        const tl = ensureTimelineByName(ws, r.timeline);
        if (!existed) nTls++;
        for (const n of r.nodes ?? []) if (!tl.nodes.some((x) => x.id === n.id)) { tl.nodes.push(n); nNodes++; }
      } else if (r.node && r.world && r.timeline) {
        const ws = d.worldsets[r.world];
        if (!ws) continue;
        const tl = ensureTimelineByName(ws, r.timeline);
        if (!tl.nodes.some((x) => x.id === r.node!.id)) { tl.nodes.push(r.node); nNodes++; }
      }
    }
  }, { undo: false });
  return { nodes: nNodes, timelines: nTls, worlds: nWs };
}

/* ── 撤销/重做（带 vault 同步）─────────────────────────────────────
   节点以 vault 的 .md 为**源**（`vaultToWorldData` 拿文件重建节点），而撤销/重做只改内存。
   于是撤销「建节点」后：节点从内存消失、.md 却还在 vault 里 → 下一次 vault 重扫
   （我们自己写盘也会触发 watcher，主进程防抖 400ms）就把它从文件里拉回来。
   实测（真实 Electron + CDP，每 100ms 采样画布节点数）：Ctrl+Z 后序列是
   `[0,1,1,1,…]` —— 节点消失约 100ms 又出现。用户看到的就是「撤销按了没反应」，
   而撤销栈本身完全正常（本轮之前已修的拖动入栈也一并被它掩盖）。
   反向同理：重做让节点回到内存，但它的 .md 已经进了回收站，不补写就又被重扫抹掉。
   所以这里在撤销/重做前后各取一次节点索引：消失的移进回收站、回来的写回 vault。
   只处理「前后差集」里的节点 id —— 外部（Obsidian）新建的文件不在索引里，不会被误删。 */
type NodeRef = { wsName: string; tlName: string; node: TimelineNode };

function indexNodes(data: WorldData): Map<string, NodeRef> {
  const map = new Map<string, NodeRef>();
  for (const [wsName, ws] of Object.entries(data.worldsets ?? {})) {
    for (const tlId of ws.order ?? []) {
      const tl = ws.timelines?.[tlId];
      if (!tl) continue;
      for (const node of tl.nodes ?? []) map.set(`${wsName}\u0000${tl.name}\u0000${node.id}`, { wsName, tlName: tl.name, node });
    }
  }
  return map;
}

type VaultBridge = {
  vaultDelete?: (ws: string, tl: string, n: unknown) => Promise<unknown>;
  vaultWrite?: (ws: string, tl: string, n: unknown) => Promise<unknown>;
};

function syncVaultAfterHistory(store: Store, run: () => void): void {
  const before = indexNodes(store.data);
  run();
  const after = indexNodes(store.data);
  const api = (window as unknown as { lingkuangAPI?: VaultBridge }).lingkuangAPI;
  if (!api) return;
  /* 先移走后补写：时间线改名会让同一个节点在前后索引里键不同，写回要赢过移除 */
  for (const [key, ref] of before) {
    if (after.has(key)) continue;
    void api.vaultDelete?.(ref.wsName, ref.tlName, ref.node)?.catch(() => {});
  }
  for (const [key, ref] of after) {
    if (before.has(key)) continue;
    void api.vaultWrite?.(ref.wsName, ref.tlName, ref.node)?.catch(() => {});
  }
}

/** 撤销（并把 vault 文件同步到撤销后的状态，见上） */
export function undoWithVault(store: Store): void {
  syncVaultAfterHistory(store, () => store.undo());
}

/** 重做（并把 vault 文件同步到重做后的状态，见上） */
export function redoWithVault(store: Store): void {
  syncVaultAfterHistory(store, () => store.redo());
}
