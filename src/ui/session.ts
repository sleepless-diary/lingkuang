/** 灵框 · 会话状态 —— 「进入灵框时默认是上次关闭时的状态」
 *
 *  用户 2026-09-19：「我希望进入灵框时默认是上次关闭时的状态」。
 *  按用户选定的范围，**只记「接着干活」用得上的三样**：
 *    ① 上次的世界 + 时间线；② 上次打开的那个工具；③ 设定库正在编的那一条（实体 / 时间线节点）。
 *  沙盘的缩放平移、全览·聚焦、非线性、剧情线选中、面板开合、窗口大小位置**故意不记** ——
 *  那些要么是随手调的（进来先看一眼全貌更合理，沙盘本来就 fitAll），要么是"当时顺手开着"
 *  （下次启动还把助手面板糊在脸上反而更烦）。
 *
 *  ⚠️ 存 localStorage（`lingkuang-session`，与 `lingkuang-settings` 同源），
 *  **不写进 `worldbuilding.json`**：
 *    · 这是"界面状态"不是"世界观数据" —— 写进数据文件会占撤销格、被备份/恢复搬来搬去、
 *      还会在冷启动（vault 为源重建）时被当成数据差异；
 *    · 换一份 userData 就等于换一个人的界面习惯，正合语义。
 *  删掉这个键 = 回到默认状态，没有任何副作用（认不出来的旧存档一律当没有，见 `read()`）。
 *
 *  ⚠️ **活动世界也得自己记**：`src/main.ts` 的 `vaultToWorldData()` 只返回 `{ worldsets }`
 *  （顶层 `active` 根本不在返回里），而 `src/store/store.ts:33` 固定取
 *  `Object.keys(initial.worldsets)[0]` —— 所以「上次的世界」在启动时本来是**必丢**的；
 *  时间线同理，`store.activeTimeline` 只活在内存里。
 */
import type { Store } from '../store/store';
import { seedAgentFocus } from './agent-context';

/** 正在编的那一条。⚠️ 节点的身份必须带上 `tlId`：实体 id 全局唯一，节点 id 得先知道在哪条时间线里
 *  （`vault` 里也是 `<世界>/<时间线>/<种类>/<名字>.md`）。 */
export type SessionTarget = { kind: 'entity'; id: string } | { kind: 'node'; tlId: string; nodeId: string };

export interface SessionState {
  /** 存档格式版本：以后结构变了就把版本号加一，老存档自动作废（不是迁移，界面状态不值得迁移）。 */
  v: 1;
  world: string;
  timeline: string;
  /** 工具 id（`src/tools/register.ts` 里注册的那个），`'sandbox'` = 世界沙盘。 */
  tool: string;
  target: SessionTarget | null;
}

export const SESSION_KEY = 'lingkuang-session';
/** 写盘防抖：换世界/换时间线可能连着来（点页签、拖时间指针……），不必每次都写。 */
const SAVE_MS = 400;

const EMPTY: SessionState = { v: 1, world: '', timeline: '', tool: '', target: null };

/** 读存档。**宽进**但**认不出就当没有**：手改坏、旧版本、别的应用写的同名键都不该让启动炸掉。 */
function read(): SessionState {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') as unknown;
    if (!raw || typeof raw !== 'object') return { ...EMPTY };
    const o = raw as Record<string, unknown>;
    if (o.v !== 1) return { ...EMPTY };
    const str = (x: unknown): string => (typeof x === 'string' ? x : '');
    let target: SessionTarget | null = null;
    const t = o.target as Record<string, unknown> | null | undefined;
    if (t && typeof t === 'object') {
      if (t.kind === 'entity' && typeof t.id === 'string') target = { kind: 'entity', id: t.id };
      else if (t.kind === 'node' && typeof t.tlId === 'string' && typeof t.nodeId === 'string') {
        target = { kind: 'node', tlId: t.tlId, nodeId: t.nodeId };
      }
    }
    return { v: 1, world: str(o.world), timeline: str(o.timeline), tool: str(o.tool), target };
  } catch {
    return { ...EMPTY };
  }
}

/** 内存里的存档（每次启动读一次；之后以它为准增量合并） */
let cache: SessionState = read();
let timer: number | undefined;

function flush(): void {
  timer = undefined;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(cache));
  } catch { /* 隐私模式 / 配额满：界面状态存不下不算错，静默即可 */ }
}

/** 合并式更新 + 防抖落盘。**没变就不写**（`patchSession` 会被高频调用，见 `watchSession`）。 */
export function patchSession(p: Partial<Omit<SessionState, 'v'>>): void {
  const next: SessionState = { ...cache, ...p, v: 1 };
  if (next.world === cache.world && next.timeline === cache.timeline && next.tool === cache.tool
    && JSON.stringify(next.target) === JSON.stringify(cache.target)) return;
  cache = next;
  if (timer !== undefined) window.clearTimeout(timer);
  timer = window.setTimeout(flush, SAVE_MS);
}

export function loadSession(): SessionState {
  return { ...cache, target: cache.target ? { ...cache.target } : null };
}

/** 记「上次打开的工具」（由 `src/ui/shell.ts` 的工具栏点击处理调用；面板型工具不记，它不接管主区）。 */
export function rememberTool(id: string): void {
  patchSession({ tool: id });
}

/** 记「设定库正在编的那一条」（由 `src/ui/codex.ts` 的 `switchTarget()` 调用，那里是所有换目标的唯一出口）。 */
export function rememberTarget(t: SessionTarget | null): void {
  patchSession({ target: t });
}

/** 上次在编哪一条（`renderCodex` 挂载时取，用来把选择落位；找不到那条就按没有处理）。 */
export function lastTarget(): SessionTarget | null {
  return cache.target ? { ...cache.target } : null;
}

/** 启动时把「上次的世界 / 时间线 / 工具」落位。
 *
 *  ⚠️ 必须在 `renderShell()` **之后**调（工具栏按钮那时才存在），且在 `watchSession()` **之前**
 *  （否则启动时的默认值会先把存档盖掉）。
 *  ⚠️ 工具走**工具栏按钮的点击**而不是直接 `openTool()`：沙盘那条路根本不走 openTool
 *  （见 `src/ui/shell.ts` 的工具栏点击处理），而且点击那套还负责按钮高亮与「结算上一个工具」。
 *  ⚠️ 世界/时间线在存档里已经不存在了就**什么都不做**（用户删过它 / 换了数据目录）——
 *  绝不能"顺手新建一个"，那是在替用户改数据。 */
export function restoreSession(store: Store): void {
  const s = cache;
  if (s.world && store.data.worldsets[s.world]) store.setActiveWorld(s.world);
  /* 时间线要在**世界落位之后**再判：`setActiveWorld()` 会把游标重挑成那条世界的第一条 */
  const ws = store.data.worldsets[store.activeWorld];
  if (s.timeline && ws?.timelines?.[s.timeline]) store.setActiveTimeline(s.timeline);
  /* 把「上次在编的那一条」也交给助手（`src/ui/agent-context.ts`）——**和工具落点无关**，所以放在下面那个
     early return 之前：落点若不是设定库（助手 / AI 工作台 / 沙盘），工作台不会挂载、也就**永远不会上报焦点**，
     助手只能答「你没打开任何条目」，而事实是他上次在编那一条（用户 2026-09-26 报的这句）。
     ⚠️ 走 `seedAgentFocus`（非 live）：「最近在看」才是真的 —— 工作台并没有在屏幕上。 */
  const t = s.target;
  if (t?.kind === 'entity' && ws?.entities?.[t.id]) {
    const e = ws.entities[t.id];
    seedAgentFocus({ kind: 'entity', world: store.activeWorld, id: e.id, title: e.name });
  } else if (t?.kind === 'node') {
    const n = ws?.timelines?.[t.tlId]?.nodes.find((x) => x.id === t.nodeId);
    if (n) seedAgentFocus({ kind: 'node', world: store.activeWorld, id: n.id, title: n.title });
  }
  if (!s.tool || s.tool === 'sandbox') return;   /* 沙盘是默认视图，不用点 */
  const btn = Array.from(document.querySelectorAll<HTMLElement>('.lk-tool-btn'))
    .find((b) => b.dataset.tool === s.tool);
  /* 工具可能已经下线（版本升级后存档里留着旧 id）⇒ 找不到就维持默认视图，不报错 */
  btn?.click();
}

/** 开始记「上次的世界 / 时间线」：订 store，只在**真的变了**的时候写（`patchSession` 自己再去重一次）。
 *  这一句也让存档在"用户什么都没改就关掉"的情况下仍然存在。 */
export function watchSession(store: Store): void {
  let last = '';
  const push = (): void => {
    const key = `${store.activeWorld}\u0000${store.activeTimeline}`;
    if (key === last) return;
    last = key;
    patchSession({ world: store.activeWorld, timeline: store.activeTimeline });
  };
  push();
  store.subscribe(push);
}
