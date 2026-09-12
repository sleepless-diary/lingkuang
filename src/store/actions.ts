/** 灵框 · actions（通过 store.update 修改数据——视图不直接碰 data） */
import type { Store } from './store';
import { currentWorld } from './store';
import type { Timeline, TimelineNode, Entity } from './types';

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
    tl.nodes.push({
      id, title: node.title ?? '新节点', year: node.year ?? 0, precision: node.precision ?? 'year',
      month: node.month, day: node.day, hour: node.hour, minute: node.minute, second: node.second,
      type: node.type ?? 'world_event', doc: node.doc ?? '',
    });
  });
  return id;
}

/** 写回节点正文。opts.world 用于「编辑非活动世界的节点」——
    编辑器侧栏会列出所有世界，若一律按 store.activeWorld 解析，点开别的世界的节点
    再编辑会被静默丢弃（`if (n)` 直接 no-op），状态栏却仍显示「已保存 ✓」。 */
export function saveNodeDoc(store: Store, tlId: string, nodeId: string, doc: string, opts?: { undo?: boolean; world?: string }) {
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
    { undo: false }   /* 指针拖动高频，不进撤销栈 */
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
