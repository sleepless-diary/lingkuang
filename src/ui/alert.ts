/** 灵框 · 壳级横幅（窗口顶部通栏）—— 用于「必须被看见、且要用户做选择」的状态。
 *
 *  与 `src/ui/vault-notice.ts` 那套 addHint 的区别：那条提示活在设定库工作台内部（面板里的一角），
 *  切到别的工具就看不到了；这条挂在壳上（`#lk-alerts`），任何工具下都在，只有用户自己点掉才消失。
 *  这里放的都是数据安全级的状态（如「数据文件判损、自动保存已暂停」），
 *  漏看一次的代价不对称 —— 所以宁可常驻，也不做成一闪而过的提示。 */

import { enter } from './motion';

export interface ShellAlertAction {
  text: string;
  /** 主操作（最该点的那个）：描边强调，不打色块 —— 与 design-system 的克制风格一致 */
  primary?: boolean;
  onClick: () => void | Promise<void>;
}

export interface ShellAlert {
  /** 幂等键：同 id 重复 show 是**替换**，不会叠出两条 */
  id: string;
  tone?: 'danger' | 'warn';
  title: string;
  body?: string;
  actions?: ShellAlertAction[];
}

const alerts = new Map<string, ShellAlert>();

/** 显示/替换一条横幅。宿主还没渲染出来时只记状态，等下一次 render 落地。 */
export function showShellAlert(a: ShellAlert): void {
  alerts.set(a.id, a);
  render();
}

export function removeShellAlert(id: string): void {
  if (alerts.delete(id)) render();
}

export function hasShellAlert(id: string): boolean {
  return alerts.has(id);
}

function render(): void {
  const host = document.getElementById('lk-alerts');
  if (!host) return;
  host.innerHTML = '';
  host.style.display = alerts.size ? 'block' : 'none';
  for (const a of alerts.values()) {
    const row = document.createElement('div');
    row.className = 'lk-alert' + (a.tone ? ` is-${a.tone}` : '');
    row.dataset.alert = a.id;
    /* 通栏从左侧滑入：这是「必须被看见」的数据安全提示，缓一下比直接闪出来更容易被注意到 */
    enter(row, 'lk-reveal-x');
    /* 结构固定：文本块（标题 + 正文）+ 右侧按钮组。文本用 textContent 而不是 innerHTML
       —— 正文里要带文件路径（可能含用户自己起的名字），拼 HTML 会变成注入面。 */
    const text = document.createElement('div');
    text.className = 'lk-alert-text';
    const title = document.createElement('div');
    title.className = 'lk-alert-title';
    title.textContent = a.title;
    text.appendChild(title);
    if (a.body) {
      const body = document.createElement('div');
      body.className = 'lk-alert-body';
      body.textContent = a.body;
      text.appendChild(body);
    }
    row.appendChild(text);
    const acts = document.createElement('div');
    acts.className = 'lk-alert-actions';
    for (const act of a.actions ?? []) {
      const btn = document.createElement('button');
      btn.className = 'lk-alert-btn' + (act.primary ? ' is-primary' : '');
      btn.textContent = act.text;
      btn.addEventListener('click', () => { void act.onClick(); });
      acts.appendChild(btn);
    }
    if (acts.childElementCount) row.appendChild(acts);
    host.appendChild(row);
  }
}
