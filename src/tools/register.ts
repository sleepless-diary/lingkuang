/** 灵框 · 工具栏工具注册（全功能占位，功能逐个填） */
import { registerTool } from './registry';
import { isSettingsPanelOpen, closeSettingsPanel, openSettingsPanel } from '../ui/settings-panel';
import { isAgentPanelOpen, closeAgentPanel, openAgentPanel } from '../ui/agent';

/** Lucide 风格图标（内联 SVG，线性） */
const IC = {
  dice: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M16 8h.01M12 12h.01M8 16h.01"/></svg>',
  brain: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/></svg>',
  export: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  settings: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
  archive: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>',
  schema: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><rect x="3" y="10" width="18" height="4" rx="1"/><rect x="3" y="16" width="10" height="4" rx="1"/></svg>',
  codex: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/><path d="M9 7h7M9 11h5"/></svg>',
  agent: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.3 0-2.5-.3-3.6-.9L4 21l1.5-4.3A8.5 8.5 0 1 1 21 11.5Z"/><path d="M12 8.5v6"/><path d="M9 11.5h6"/></svg>',
};

export function registerAllTools(): void {
  /* 模块（左栏）：大的功能视图。语义联想=灵感触发器；多分支/推演/导出=世界沙盘附属——都不单独成模块 */
  registerTool({
    id: 'sandbox', name: '世界沙盘', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><circle cx="6" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="18" cy="12" r="2"/></svg>',
    open(host) { host.innerHTML = ''; },   /* 点击回到沙盘主视图（清空右侧面板） */
  });
  registerTool({
    id: 'inspire', name: '灵感触发器', icon: IC.dice,
    open(host, store) {
      /* 必须 return 这条 promise 链：registry.openTool 靠它的 resolve 值拿到清理函数，
         切走工具时才能拆掉 assoc 画布的 window 监听 + 两个 RAF 循环（与下面 codex 同理）。
         不 return（旧写法）→ adopt 永远收不到清理函数 → 每点一次工具积一份监听与永不退场的帧循环。 */
      if (!store) return;
      return import('../ui/inspire').then((m) => m.renderInspire(store, host));
    },
  });
  registerTool({
    id: 'ai', name: 'AI', icon: IC.brain,
    open(host, store) {
      if (!store) return;
      import('../ui/ai-workbench').then((m) => m.renderAiWorkbench(store, host));
    },
  });
  registerTool({
    id: 'codex', name: '设定库', icon: IC.codex,
    open(host, store) {
      /* 返回清理函数：面板有 store 订阅 + 状态提示定时器 */
      if (!store) return;
      return import('../ui/codex').then((m) => m.renderCodex(store, host));
    },
  });
  /* 占位模块：素材库
     （原「编辑器」工具已并入「设定库」工作台：左栏是**一棵文件夹树**，
       世界 → 时间线 → 种类 → 节点 ／ 世界 → `_設定` → 类型 → 实体，见 `src/ui/codex.ts`。）*/
  registerTool({ id: 'library', name: '素材库', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>', placeholder: true });

  /* ── 管理组（左栏下段，贴着底部；见 registry.ts 的 `Tool.group`）──
     用户 2026-09-12：「设置放到左侧栏最底下」+ 干活的和管理别混着排。
     语义上这是「配置 / 数据安全」一类，不常点，但点的时候要一眼找到：
     结构体管理（改数据结构）→ 回收站（我删错了）→ 备份管理（数据坏了 / 回到某个时间点）→ 设置（最底）。 */
  registerTool({
    id: 'schema', name: '结构体管理', icon: IC.schema, group: 'manage',
    open(host, store) {
      /* 返回清理函数：面板里有状态提示定时器 */
      if (!store) return;
      return import('../ui/schema').then((m) => m.renderSchema(store, host));
    },
  });
  registerTool({
    id: 'trash', name: '回收站', icon: IC.trash, group: 'manage',
    open(host, store) {
      /* 返回清理函数：面板内有状态提示定时器，切走工具时要清掉 */
      if (!store) return;
      return import('../ui/trash').then((m) => m.renderTrash(store, host));
    },
  });
  registerTool({
    id: 'backup', name: '备份管理', icon: IC.archive, group: 'manage',
    open(host, store) {
      /* 返回清理函数：面板内有状态提示定时器 */
      if (!store) return;
      return import('../ui/backup').then((m) => m.renderBackup(store, host));
    },
  });
  /* 设置是**面板型**工具（`panel: true`）：点它不接管主区，自己挂一层悬浮面板 ——
     用户 2026-09-13：「我希望设置面板是悬浮面板，而不是单开一个标签页」。
     与别的工具不同，这里**静态 import**（不 `.then(import(...))`）：面板很轻（只依赖 settings.ts），
     而左栏按钮的高亮要问它 `isOpen()`、再点一次要问它 `close()` —— 两者都需要一个同步的模块引用，
     同时静态 + 动态 import 同一个模块只会让 Vite 报 "dynamic import will not move module into another
     chunk" 的无效动态导入警告。 */
  registerTool({
    id: 'settings', name: '设置', icon: IC.settings, group: 'manage',
    panel: true,
    isOpen: () => isSettingsPanelOpen(),
    close: () => closeSettingsPanel(),
    open(_host, store) {
      if (!store) return;
      return openSettingsPanel(store);
    },
  });
  /* 灵框助手（`panel: true`）：**右侧停靠**的对话框，Ctrl+K 也能呼出（见 `src/ui/shell.ts`）。
     同样是面板型 —— 用户要的是「主要工作还是在灵框内」：聊的时候还能继续看设定与正文，
     所以它不接管主区、也不盖遮罩（设置那层是全屏遮罩，两者互不干扰，可以同时开）。
     静态 import 的理由与设置相同：左栏高亮要同步问 `isAgentPanelOpen()`。 */
  registerTool({
    id: 'agent', name: '助手', icon: IC.agent,
    panel: true,
    isOpen: () => isAgentPanelOpen(),
    close: () => closeAgentPanel(),
    open(_host, store) {
      if (!store) return;
      return openAgentPanel(store);
    },
  });
}
