/** 灵框 · 工具注册表（工具栏）——模块 = 大视图（灵感/编辑器/AI…） */
import type { Store } from '../store/store';
import { cascadeIn } from '../ui/motion';
export interface Tool {
  id: string;
  name: string;
  icon: string;                 // Lucide SVG（内联）
  desc?: string;
  placeholder?: boolean;        // true = 占位（功能未做）
  /** 左栏分组（缺省 `'create'`）：`'create'` = 干活用的创作工具（沙盘 / 灵感 / 编辑器 / AI / 设定库…），
   *  排在上段；`'manage'` = 低频管理项（结构体 / 回收站 / 备份 / 设置），排在下段并**贴着左栏底部**。
   *  用户 2026-09-12 的整理要求：「设置放到左侧栏最底下」+ 干活的和管理别混着排。
   *  只在左栏（`src/ui/shell.ts` 的 `renderToolbar`）生效，世界栏那排 `.lk-tool-btn` 不受影响。 */
  group?: 'create' | 'manage';
  /** `true` = **面板型**工具：点它**不接管主区**（不隐藏右区、不建工具格），由它自己挂一层
   *  悬浮面板（见 `src/ui/settings-panel.ts`）。用户 2026-09-13：「我希望设置面板是悬浮面板，
   *  而不是单开一个标签页」—— 判定标准是「用它的时候需要**同时看着**主区内容吗」：
   *  设置要边看边调，所以是面板；设定库/沙盘那种要占满主区的仍是普通工具。 */
  panel?: boolean;
  /** 面板型：此刻开着没开着（左栏按钮据此显示高亮）。普通工具不用实现。 */
  isOpen?: () => boolean;
  /** 面板型：关掉它（再点一次按钮＝关）。普通工具不用实现。 */
  close?: () => void;
  /** 打开工具。可返回清理函数（或它的 Promise，因为各工具用动态 import 懒加载）：
   *  收到的 host 是**本次打开专属的工具格**（`.lk-tool-slot`，长生命周期容器的子元素）——
   *  往它里面写就好，切走时整格连 DOM 一起摘掉，所以**晚到的渲染不会盖掉后来打开的工具**。
   *  不返回清理函数的话，切走时只摘格子，tiptap 实例 / window 监听 / store 订阅会残留
   *  （每点一次工具多积一份）。 */
  open?: (host: HTMLElement, store?: Store) => void | (() => void) | Promise<void | (() => void)>;
}

const tools = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  tools.set(tool.id, tool);
}

export function listTools(): Tool[] {
  return [...tools.values()];
}

/** 当前工具的清理函数；以及打开序号（动态 import 是异步的，用它丢弃过期回调） */
let disposeCurrent: (() => void) | null = null;
/** 当前**面板型**工具的关闭函数（与 disposeCurrent 分开：开设置面板不该把主区的工具关掉） */
let disposePanel: (() => void) | null = null;
let openSeq = 0;

/** ⚠️ 为什么每个工具都要有自己的**工具格**（踩过的坑，务必别退回去）：
 *  各工具的 open 是 `import(...).then((m) => m.openX(host, store))`，而且像 settings 那样
 *  **函数内部还有自己的一层异步渲染** —— 函数把清理函数交回来时 DOM 未必已经写完。
 *  于是「打开 A → 立刻打开 B」时，慢的 A 完全可能在 B 渲染完之后才落地，把 B 盖掉：
 *  工具栏亮着 B、主区却是 A（实测：同一个同步块里连点 settings + codex，2.5 秒后主区仍停在
 *  settings，而按钮已经亮 codex）。
 *  只要「写哪儿」在**打开那一刻**就定下（自己那一格），晚到多久都无害 —— 它写的是已被摘掉的格子。 */
export function openTool(id: string, host: HTMLElement, store?: Store): void {
  const tool = tools.get(id);
  if (!tool) return;
  /* 面板型（设置）：**主区一动不动** —— 不结算当前工具（你正在编的东西要留在后面）、
     不摘格子、不写 `#lk-module-view`。它自己往 document.body 挂悬浮层，返回的清理函数是"关面板"。 */
  if (tool.panel) {
    disposePanel?.();
    disposePanel = null;
    const ret = tool.open ? tool.open(host, store) : undefined;
    if (typeof ret === 'function') disposePanel = ret;
    return;
  }
  disposeCurrent?.();
  disposeCurrent = null;
  host.innerHTML = '';               /* 摘掉上一格（连同那个工具的 DOM） */
  const seq = ++openSeq;
  const slot = document.createElement('div');
  slot.className = 'lk-tool-slot';
  host.appendChild(slot);
  const ret = tool.open ? tool.open(slot, store) : (renderPlaceholder(slot, tool), undefined);
  /* 切工具/开面板的入场：**不再对整块容器做淡入**（那会让整个主区"洗白一下"，还会盖掉
     每个元素自己的错峰 —— 实测抓帧确认），改成让工具根部的顶层块依次浮现（一次性错峰）。
     工具可能是动态 import 的，渲染完才算数，所以同步/异步两条路径都要调。 */
  const cascade = (): void => {
    if (seq !== openSeq) return;   /* 期间又切走了：别给已经过期的工具加动画 */
    const root = slot.children.length >= 2 ? slot : (slot.firstElementChild as HTMLElement | null);
    cascadeIn(root);
  };
  const retire = (d: void | (() => void)): void => {
    slot.remove();                 /* 它晚到的渲染都落进这一格，随格子一起消失 */
    if (typeof d === 'function') d();
  };
  if (ret && typeof (ret as Promise<void | (() => void)>).then === 'function') {
    (ret as Promise<void | (() => void)>)
      .then((d) => {
        /* 期间又切走了：摘掉自己那一格 + 就地清理，不接管 */
        if (seq !== openSeq) { retire(d); return; }
        cascade();
        if (typeof d === 'function') disposeCurrent = d;
      })
      .catch((e: unknown) => {
        /* 以前这里静默吞掉，结果"点了没反应"排查半天（本会话踩过）：至少要留个痕 */
        console.warn(`[openTool] 工具 ${id} 打开失败：`, e);
      });
  } else {
    if (typeof ret === 'function') disposeCurrent = ret;
    cascade();
  }
}

/** 立即跑掉当前工具的清理函数（退出前 flush 之类需要先结算时用） */
export function disposeCurrentTool(): void {
  disposeCurrent?.();
  disposeCurrent = null;
  disposePanel?.();   /* 悬浮面板也一起收（切到世界沙盘 / 退出前不该留一层遮罩） */
  disposePanel = null;
  openSeq++;   /* 让还在飞的动态 import 回调作废 */
}
function renderPlaceholder(host: HTMLElement, tool: Tool): void {
  host.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;color:var(--fg-2);">
      <div style="font-size:28px;opacity:.5;">${tool.icon}</div>
      <div style="font-size:var(--text-sm);">${tool.name}</div>
      <div style="font-size:var(--text-xs);opacity:.6;">占位 · 功能开发中</div>
    </div>`;
}
