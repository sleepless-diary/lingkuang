/** 灵框 · 悬浮设置面板
 *
 *  用户 2026-09-13：「我希望设置面板是悬浮面板，而不是单开一个标签页」。
 *  以前「设置」是注册成**工具**的（`src/tools/register.ts`），点它＝工具宿主 `#lk-module-view`
 *  把世界沙盘整个换掉：改个旋钮要离开你正在编的条目，改完还得再切回去。
 *  现在它是一层**悬浮面板**：主区原样留在后面（正在编的条目、左树展开态、滚动位置都不动），
 *  关掉就回到原处。表单本体仍在 `src/ui/settings.ts` 的 `renderSettingsInto()`，这里只负责"框"。
 *
 *  三种关法：右上角 ×、Esc、点遮罩空白处；关掉/打开都广播 `lingkuang-panel`
 *  （detail = `{ id: 'settings', open }`），壳 `src/ui/shell.ts` 用它同步左栏那个按钮的高亮。
 *
 *  ⚠️ 它挂在 `document.body` 上（不在工具格里）：工具格切走会被整格摘掉，而悬浮面板恰恰要
 *  「主区不动」——挂在壳里的任何一格都会破坏这一点。 */

import type { Store } from '../store/store';
import { renderSettingsInto } from './settings';

/** 面板根（遮罩 + 卡片都在这一个元素里），同时是「开着没开着」的唯一判据 */
const PANEL_ID = 'lk-settings-panel';
let openEl: HTMLElement | null = null;
let disposeInner: (() => void) | null = null;

export function isSettingsPanelOpen(): boolean {
  return !!openEl && document.body.contains(openEl);
}

/** 关掉（没开就是空操作）。单实例，调用方不用自己判断。 */
export function closeSettingsPanel(): void {
  if (!openEl) return;
  const el = openEl;
  openEl = null;
  disposeInner?.();
  disposeInner = null;
  el.remove();
  window.dispatchEvent(new CustomEvent('lingkuang-panel', { detail: { id: 'settings', open: false } }));
}

/** 开（已经开着就先关掉重开，保证表单显示的是当前值）。返回给工具注册表的清理函数。 */
export function openSettingsPanel(store: Store): () => void {
  closeSettingsPanel();
  const overlay = document.createElement('div');
  overlay.id = PANEL_ID;
  overlay.className = 'lk-overlay-in';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:1800;background:rgba(15,15,17,.45);display:flex;align-items:center;justify-content:center;padding:32px;';

  const card = document.createElement('div');
  card.className = 'lk-pop-in lk-set-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', '设置');
  /* 卡片用**亮面**（`--surface`/`--fg`）：表单里的输入框、说明文字本来就是照亮面调的色，
     换成弹窗那种深色 chrome 会看不清。 */
  card.style.cssText =
    'width:560px;max-width:100%;max-height:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--surface);color:var(--fg);border:1px solid var(--border-strong);border-radius:var(--radius-lg);box-shadow:var(--elev-raised);';

  const head = document.createElement('div');
  head.style.cssText =
    'display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border);flex-shrink:0;';
  const title = document.createElement('div');
  title.textContent = '设置';
  title.style.cssText = 'font-size:var(--text-base);font-weight:600;color:var(--fg);';
  const close = document.createElement('button');
  close.id = 'lk-set-close';
  close.type = 'button';
  close.textContent = '×';
  close.title = '关闭（Esc）';
  close.style.cssText =
    'margin-left:auto;background:transparent;border:1px solid var(--border);color:var(--fg-2);border-radius:var(--radius-sm);width:24px;height:24px;line-height:1;font-size:15px;cursor:pointer;flex-shrink:0;';
  head.append(title, close);

  const body = document.createElement('div');
  body.id = 'lk-set-body';
  body.style.cssText = 'flex:1;overflow:auto;';

  card.append(head, body);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  renderSettingsInto(body, store);

  /* 关法：×、Esc、点遮罩空白（点卡片内部不关 —— 拖滑块时手抖出界不该把面板关掉） */
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') closeSettingsPanel(); };
  window.addEventListener('keydown', onKey);
  close.addEventListener('click', () => closeSettingsPanel());
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeSettingsPanel(); });

  openEl = overlay;
  disposeInner = () => window.removeEventListener('keydown', onKey);
  window.dispatchEvent(new CustomEvent('lingkuang-panel', { detail: { id: 'settings', open: true } }));
  return () => closeSettingsPanel();
}
