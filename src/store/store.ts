/** 灵框 · store（单一数据源 + 订阅通知）——数据层与视图解耦 */
import type { WorldData, Worldset } from './types';

export interface Store {
  data: WorldData;
  activeWorld: string;
  activeTimeline: string;
  subscribe(fn: (store: Store) => void): () => void;
  setActiveWorld(name: string): void;
  setActiveTimeline(id: string): void;
  update(fn: (data: WorldData) => void, opts?: { undo?: boolean }): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}

function createStore(initial: WorldData): Store {
  let data: WorldData = initial;
  let activeWorld = Object.keys(initial.worldsets)[0] ?? '';
  let activeTimeline = '';
  const listeners = new Set<(s: Store) => void>();
  /* 撤销/重做：JSON 快照栈（上限 100） */
  const undoStack: WorldData[] = [];
  const redoStack: WorldData[] = [];
  const clone = (d: WorldData): WorldData => JSON.parse(JSON.stringify(d)) as WorldData;

  /* 通知订阅者。**单个订阅者抛异常不能中断整轮通知**：视图渲染 bug 会让排在它后面的
     订阅者收不到这次变化，而更新操作本身是**先改数据、后通知**——异常还会一路穿出
     store.update() 打断调用方的后续语句（曾实测：src/ui/map.ts 在 maps 瞬时缺失时抛一次
     TypeError → src/main.ts 的 suppressWrite 卡在 true、自动落盘订阅者被跳过 → 此后永久
     不再保存，静默丢数据）。这里隔离异常并 console.error，保留可诊断性。 */
  const notify = (): void => {
    listeners.forEach((fn) => {
      try { fn(store); } catch (e) { console.error('[lingkuang] store 订阅者抛异常：', e); }
    });
  };

  const store: Store = {
    get data() { return data; },
    get activeWorld() { return activeWorld; },
    get activeTimeline() { return activeTimeline; },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setActiveWorld(name) {
      if (!data.worldsets[name]) return;
      activeWorld = name;
      const ws = data.worldsets[name];
      activeTimeline = (ws.order ?? []).find((id) => ws.timelines[id]) || Object.keys(ws.timelines)[0] || '';
      notify();
    },
    setActiveTimeline(id) {
      const ws = data.worldsets[activeWorld];
      if (!ws || !ws.timelines[id]) return;
      activeTimeline = id;
      notify();
    },
    update(fn, opts) {
      if (opts?.undo !== false) {
        undoStack.push(clone(data));
        if (undoStack.length > 100) undoStack.shift();
        redoStack.length = 0;
      }
      fn(data);
      notify();
    },
    undo() {
      if (!undoStack.length) return;
      redoStack.push(clone(data));
      data = undoStack.pop()!;
      notify();
    },
    redo() {
      if (!redoStack.length) return;
      undoStack.push(clone(data));
      data = redoStack.pop()!;
      notify();
    },
    canUndo() { return undoStack.length > 0; },
    canRedo() { return redoStack.length > 0; },
  };
  return store;
}

export function currentWorld(store: Store): Worldset {
  return store.data.worldsets[store.activeWorld] ?? { name: '', timelines: {}, order: [], docs: {} };
}

/** 空数据（首次启动） */
export function emptyData(): WorldData {
  return {
    worldsets: {
      新世界: { name: '新世界', timelines: {}, order: [], docs: {} },
    },
  };
}

export default createStore;
