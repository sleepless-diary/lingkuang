/** 灵框 · 帮助面板（左栏常驻，`panel: true`）
 *
 *  为什么需要它：应用没有原生菜单（`main.js` 的 `Menu.setApplicationMenu(null)` + `autoHideMenuBar`），
 *  于是「快捷键是什么 / 手册在哪 / 数据存在哪」在界面上**一个入口都没有** —— 2026-10-25 首启评审
 *  实测到的第 4 条设计缺口（唯一的向导藏在 Ctrl+K 后面，而 Ctrl+K 全应用零提示）。
 *
 *  形态：贴着左栏的**小浮层**（不是全屏遮罩）—— 它是一张速查卡，看一眼就回去干活，
 *  不该像设置那样把主区压暗。关法：× / Esc / 点外面一点 / 再点左栏那个「帮助」。
 *
 *  内容只放"没有别处可查"的东西：快捷键、鼠标手势、手册与数据目录的入口、版本。
 *  教程式的说明留给 `docs/USER_GUIDE.md` —— 面板里复制一份必然漂移。 */

import type { Store } from '../store/store';

const PANEL_ID = 'lk-help-panel';
const MANUAL_URL = 'https://github.com/sleepless-diary/lingkuang/blob/master/docs/USER_GUIDE.md';
let openEl: HTMLElement | null = null;

interface Api {
  openExternal?: (url: string) => Promise<{ ok: boolean; error?: string }>;
  openDataDir?: () => Promise<{ ok: boolean; path?: string }>;
  appInfo?: () => Promise<{ version?: string; dataDir?: string; vault?: string }>;
}

const KEYS: [string, string][] = [
  ['Ctrl+J / Ctrl+K', '灵框助手（右侧对话，随时能叫出来）'],
  ['Ctrl+P', '命令面板：按名字跳设定 / 事件 / 工具'],
  ['Ctrl+Z / Ctrl+Y', '撤销 / 重做'],
];
const MOUSE: [string, string][] = [
  ['右键空白处', '新建事件节点'],
  ['拖动空白', '平移画布'],
  ['Alt + 滚轮', '缩放（以鼠标为中心）'],
  ['世界 / 时间线页签上的 ⋯', '改名、删除'],
];

export function isHelpPanelOpen(): boolean {
  return !!openEl && document.body.contains(openEl);
}

export function closeHelpPanel(): void {
  if (!openEl) return;
  const el = openEl;
  openEl = null;
  el.remove();
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('keydown', onKey);
  window.dispatchEvent(new CustomEvent('lingkuang-panel', { detail: { id: 'help', open: false } }));
}

let onOutside: (e: MouseEvent) => void = () => {};
let onKey: (e: KeyboardEvent) => void = () => {};

export function openHelpPanel(_store: Store): () => void {
  closeHelpPanel();
  const api = (window as unknown as { lingkuangAPI?: Api }).lingkuangAPI;

  const el = document.createElement('div');
  el.id = PANEL_ID;
  el.className = 'lk-pop-in';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '帮助');
  el.style.cssText =
    'position:fixed;left:76px;bottom:10px;z-index:1900;width:392px;max-height:min(76vh,560px);overflow:auto;'
    + 'background:var(--surface);color:var(--fg);border:1px solid var(--border-strong);border-radius:var(--radius-lg);'
    + 'box-shadow:var(--elev-raised);';

  const row = (k: string, v: string): string =>
    `<div class="lk-help__row"><kbd class="lk-help__k">${k}</kbd><span class="lk-help__v">${v}</span></div>`;

  el.innerHTML = `
    <div class="lk-help__head">
      <b>帮助</b>
      <span>两分钟认全灵框</span>
      <button id="lk-help-close" title="关闭（Esc）">×</button>
    </div>
    <div class="lk-help__body">
      <div class="lk-help__sec">快捷键</div>
      ${KEYS.map(([k, v]) => row(k, v)).join('')}
      <div class="lk-help__sec">鼠标</div>
      ${MOUSE.map(([k, v]) => row(k, v)).join('')}
      <div class="lk-help__acts">
        <button id="lk-help-manual" class="lk-btn lk-btn--sm">打开使用手册</button>
        <button id="lk-help-data" class="lk-btn lk-btn--ghost lk-btn--sm">打开数据目录</button>
      </div>
      <div class="lk-help__foot" id="lk-help-foot">灵框 LingKuang</div>
    </div>`;

  document.body.appendChild(el);
  openEl = el;

  el.querySelector('#lk-help-close')?.addEventListener('click', () => closeHelpPanel());
  el.querySelector('#lk-help-manual')?.addEventListener('click', () => {
    void api?.openExternal?.(MANUAL_URL)?.catch(() => { /* 打不开浏览器不影响面板 */ });
  });
  el.querySelector('#lk-help-data')?.addEventListener('click', () => {
    void api?.openDataDir?.()?.catch(() => { /* 同上 */ });
  });
  /* 版本 / 数据目录：拿不到就保留静态那句（测试实例里 IPC 可能没接上） */
  void api?.appInfo?.().then((info) => {
    const foot = el.querySelector('#lk-help-foot');
    if (!foot || !info) return;
    const parts = [`灵框 LingKuang${info.version ? ' ' + info.version : ''}`, 'GPL-3.0'];
    if (info.dataDir) parts.push(`数据：${info.dataDir}`);
    foot.textContent = parts.join(' · ');
  }).catch(() => { /* 版本拿不到就算了 */ });

  onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') closeHelpPanel(); };
  onOutside = (e: MouseEvent): void => {
    if (el.contains(e.target as Node)) return;
    if ((e.target as HTMLElement | null)?.closest?.('[data-tool="help"]')) return;   /* 再点按钮＝自己会切 */
    closeHelpPanel();
  };
  document.addEventListener('keydown', onKey);
  /* 捕获 + 延后一轮：开面板那一下的 mousedown 不该立刻把它关掉 */
  setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);

  window.dispatchEvent(new CustomEvent('lingkuang-panel', { detail: { id: 'help', open: true } }));
  return () => closeHelpPanel();
}
