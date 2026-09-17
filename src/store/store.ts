/** 灵框 · store（单一数据源 + 订阅通知）——数据层与视图解耦 */
import type { WorldData, Worldset } from './types';

export interface Store {
  data: WorldData;
  activeWorld: string;
  activeTimeline: string;
  subscribe(fn: (store: Store) => void): () => void;
  setActiveWorld(name: string): void;
  setActiveTimeline(id: string): void;
  update(fn: (data: WorldData) => void, opts?: { undo?: boolean; keepRedo?: boolean }): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}

/** 时间线游标落位规则（建店时 / 换世界时 / 撤销重做后三处共用）：
 *  优先 `order` 里第一条真实存在的时间线，否则第一条，都没有则空串。
 *  ⚠️ 建店时**必须**用它初始化 `activeTimeline`：以前初始化成空串、只有 `setActiveWorld`
 *  与撤销/重做才会落位（`update()` 不碰游标），于是「启动后没点过世界页签」的实例里
 *  `store.activeTimeline === ''` —— 沙盘和工作台各自写了兜底（`src/ui/timeline.ts:89`
 *  / `src/ui/shell.ts:139`）所以没露馅，但 `src/ui/agent-context.ts` 的 `buildContext()`
 *  是直取的 ⇒ 助手第一次开口时**整段时间线块凭空消失**（E2E `agent-panel` ★5 抓到）。 */
function pickTimeline(ws: Worldset | undefined): string {
  const tls = ws?.timelines;
  if (!tls) return '';
  return (ws.order ?? []).find((id) => tls[id]) || Object.keys(tls)[0] || '';
}

function createStore(initial: WorldData): Store {
  let data: WorldData = initial;
  let activeWorld = Object.keys(initial.worldsets)[0] ?? '';
  let activeTimeline = pickTimeline(initial.worldsets[activeWorld]);
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

  /* 撤销/重做是整份替换 data，而 activeWorld / activeTimeline 是**独立的**两个游标，
     不在快照里。于是新建世界观 B → 切到 B → Ctrl+Z 时，B 随快照一起消失，游标却仍指向 B：
     `currentWorld()` 只能返回兜底空对象 → 界面变成「一个没有名字的空世界」，
     世界页签一个都不高亮，看起来像撤销把数据毁掉了（其实是游标悬空）。
     这里按 setActiveWorld / setActiveTimeline 同样的规则重新落位到仍然存在的项。 */
  const reseatSelection = (): void => {
    if (!data.worldsets[activeWorld]) activeWorld = Object.keys(data.worldsets)[0] ?? '';
    const ws = data.worldsets[activeWorld];
    if (!ws) { activeTimeline = ''; return; }
    if (!ws.timelines[activeTimeline]) activeTimeline = pickTimeline(ws);
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
      activeTimeline = pickTimeline(ws);
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
      }
      /* 重做分支的作废规则：**任何用户造成的持久化改动**都要作废它。
         以前只在推快照时清空，于是 `{undo:false}` 的写入口（时间指针拖动、回收站恢复）
         改了数据却不清重做栈 —— 「撤销 → 在旧状态又改了点东西 → 重做」还能跳回后面那个
         状态，把刚才的改动悄悄吃掉（用户实测反馈的现象）。
         `keepRedo` 只给**应用自己的记账**用，不是用户编辑：
           - vault 重扫（src/main.ts）必须豁免，否则撤销/重做触发的文件同步会在 400ms 后
             把重做栈清掉，重做就永远用不了；
           - 其余：格式字段补全 / formats 载入 / 外部改动的自动修复 / 挂载时建默认地图 /
             拖动中间的逐帧帧（拖动自己的提交那一步已经清过了）。 */
      if (!opts?.keepRedo) redoStack.length = 0;
      fn(data);
      notify();
    },
    undo() {
      if (!undoStack.length) return;
      redoStack.push(clone(data));
      data = undoStack.pop()!;
      reseatSelection();
      notify();
    },
    redo() {
      if (!redoStack.length) return;
      undoStack.push(clone(data));
      data = redoStack.pop()!;
      reseatSelection();
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
