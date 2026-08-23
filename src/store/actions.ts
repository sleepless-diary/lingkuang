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
      type: node.type ?? 'world_event', doc: node.doc ?? '',
    });
  });
  return id;
}

export function saveNodeDoc(store: Store, tlId: string, nodeId: string, doc: string, opts?: { undo?: boolean }) {
  store.update(
    (d) => {
      const n = d.worldsets[store.activeWorld]?.timelines[tlId]?.nodes.find((x) => x.id === nodeId);
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
