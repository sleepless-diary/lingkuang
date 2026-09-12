/** 灵框 · 工具注册表（工具栏）——模块 = 大视图（灵感/编辑器/AI…） */
import type { Store } from '../store/store';
import { enter } from '../ui/motion';
export interface Tool {
  id: string;
  name: string;
  icon: string;                 // Lucide SVG（内联）
  desc?: string;
  placeholder?: boolean;        // true = 占位（功能未做）
  /** 打开工具。可返回清理函数（或它的 Promise，因为各工具用动态 import 懒加载）：
   *  host 是长生命周期容器（#lk-tool-host），切走时只清 innerHTML 不会销毁 tiptap 实例、
   *  window 监听和 store 订阅——不清就会每点一次工具多积一份。 */
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
let openSeq = 0;

export function openTool(id: string, host: HTMLElement, store?: Store): void {
  const tool = tools.get(id);
  if (!tool) return;
  disposeCurrent?.();
  disposeCurrent = null;
  host.innerHTML = '';
  /* 切工具/开面板的入场（DESIGN.md 第 7 节）。挂在这里 = 唯一入口，覆盖工具栏点击、
     快捷键、「世界沙盘」分支以外的所有工具打开路径；容器本身在动画，工具动态 import
     完成后内容在淡入过程中落进来，不会二次闪。
     注意**不要**在这儿给 host 挂子项错峰（staggerIn）：那是常驻类，而工具每次重渲染
     （codex 就是 `host.innerHTML = …` 整块重来）都会让**新建出来的子项**重新播一遍 ——
     改个字段整块闪一下。错峰只挂在「显式切换」那几处（页签栏 / 设定库内容块）。 */
  enter(host);
  const seq = ++openSeq;
  const ret = tool.open ? tool.open(host, store) : (renderPlaceholder(host, tool), undefined);
  const adopt = (d: void | (() => void)) => {
    if (typeof d !== 'function') return;
    /* 期间又切走了：立刻就地清理，不接管 */
    if (seq !== openSeq) { d(); return; }
    disposeCurrent = d;
  };
  if (ret && typeof (ret as Promise<void | (() => void)>).then === 'function') {
    (ret as Promise<void | (() => void)>).then(adopt).catch(() => { /* 加载失败由工具自己提示 */ });
  } else {
    adopt(ret as void | (() => void));
  }
}

/** 立即跑掉当前工具的清理函数（退出前 flush 之类需要先结算时用） */
export function disposeCurrentTool(): void {
  disposeCurrent?.();
  disposeCurrent = null;
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
