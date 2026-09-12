/** 确认 / 输入弹层 —— 替代原生 `window.confirm` 与 `window.prompt`。
 *
 *  为什么不用原生：① 原生对话框无法使用 design-system 的 token 配色，风格直接断裂；
 *  ② 它们是**同步阻塞渲染进程**的，会卡住 tiptap 与画布的 rAF 循环；
 *  ③ 破坏性操作需要讲清后果（删了什么、去哪了、能不能恢复），原生只支持一行文字。
 *
 *  交互约定：默认焦点在「取消」（删除类操作误按回车不该执行）；
 *  Esc / 点遮罩 / 取消 → 取消；任何路径都会 resolve，不会悬挂调用方。
 *  输入弹层里回车 = 确认（有文本框，回车是自然提交），但走 isImeEnter 排除输入法上屏。 */
import { isImeEnter } from './keys';

export interface DialogOptions {
  title: string;
  message?: string;
  /** 补充说明（小字、次要色），例如「已移入回收站，可从「回收站」恢复」 */
  detail?: string;
  confirmText?: string;
  cancelText?: string;
  /** 破坏性操作：确认按钮用 --danger（锈棕）而非荧光绿 */
  danger?: boolean;
}

export type ConfirmOptions = DialogOptions;

export interface PromptOptions extends DialogOptions {
  label?: string;
  value?: string;
  placeholder?: string;
}

interface Extra {
  getValue: () => unknown;
  focus: () => void;
}

/** 弹层骨架。确认 → resolve(getValue())；取消 → resolve(null)。 */
function openDialog(opts: DialogOptions & { extra?: (card: HTMLElement) => Extra }): Promise<unknown> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2000;background:rgba(15,15,17,.45);display:flex;align-items:center;justify-content:center;';
    const card = document.createElement('div');
    card.style.cssText =
      'min-width:320px;max-width:460px;background:var(--chrome-2);color:var(--fg-inverse);border:1px solid var(--border-strong);border-radius:var(--radius-lg);padding:var(--space-5);box-shadow:var(--elev-raised);display:flex;flex-direction:column;gap:var(--space-3);';

    const title = document.createElement('div');
    title.textContent = opts.title;
    title.style.cssText = 'font-size:var(--text-base);font-weight:600;';
    card.appendChild(title);

    if (opts.message) {
      const p = document.createElement('div');
      p.textContent = opts.message;
      /* pre-line：文案里的 \n 要真的换行（默认会被 HTML 折叠成空格，
         恢复/删除这类需要讲清后果的弹层经常是多行文案） */
      p.style.cssText = 'font-size:var(--text-sm);line-height:var(--leading-body);white-space:pre-line;';
      card.appendChild(p);
    }
    if (opts.detail) {
      const p = document.createElement('div');
      p.textContent = opts.detail;
      p.style.cssText = 'font-size:var(--text-xs);line-height:var(--leading-body);color:var(--meta);white-space:pre-line;';
      card.appendChild(p);
    }

    /* 额外控件（输入框等）必须插在按钮行之前 */
    const extra = opts.extra ? opts.extra(card) : null;

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:flex-end;gap:var(--space-2);margin-top:var(--space-1);';

    const cancel = document.createElement('button');
    cancel.textContent = opts.cancelText ?? '取消';
    cancel.style.cssText =
      'background:none;border:1px solid var(--border-strong);color:var(--fg-inverse);border-radius:var(--radius-sm);padding:6px 14px;font-size:var(--text-sm);cursor:pointer;';

    const ok = document.createElement('button');
    ok.textContent = opts.confirmText ?? '确定';
    ok.style.cssText = `border:none;border-radius:var(--radius-sm);padding:6px 14px;font-size:var(--text-sm);cursor:pointer;background:${
      opts.danger ? 'var(--danger)' : 'var(--accent)'
    };color:${opts.danger ? 'var(--fg-inverse)' : 'var(--accent-on)'};`;

    row.appendChild(cancel);
    row.appendChild(ok);
    card.appendChild(row);
    overlay.appendChild(card);

    let settled = false;
    const settle = (confirmed: boolean): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(confirmed ? (extra ? extra.getValue() : true) : null);
    };
    /* 捕获阶段监听：不受弹层内控件自身的 keydown 干扰 */
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); settle(false); return; }
      /* 只有带输入框的弹层才让回车提交；纯确认弹层不绑定回车 —— 删除最容易被误触发 */
      if (e.key === 'Enter' && extra && !isImeEnter(e)) { e.preventDefault(); settle(true); }
    };
    window.addEventListener('keydown', onKey, true);
    cancel.addEventListener('click', () => settle(false));
    ok.addEventListener('click', () => settle(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) settle(false); });

    document.body.appendChild(overlay);
    (extra ? extra : { focus: () => cancel.focus() }).focus();
  });
}

/** 确认弹层 → true / false */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return openDialog(opts).then((v) => v === true);
}

/** 输入弹层 → 输入的文本 / null（取消）。空串是合法结果，由调用方决定默认值。 */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return openDialog({
    ...opts,
    extra: (card) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:var(--space-1);';
      if (opts.label) {
        const lab = document.createElement('span');
        lab.textContent = opts.label;
        lab.style.cssText = 'font-size:var(--text-xs);color:var(--meta);';
        wrap.appendChild(lab);
      }
      const input = document.createElement('input');
      input.type = 'text';
      input.value = opts.value ?? '';
      if (opts.placeholder) input.placeholder = opts.placeholder;
      input.style.cssText =
        'background:var(--chrome);border:1px solid var(--border-strong);border-radius:var(--radius-sm);color:var(--fg-inverse);padding:6px 8px;font-size:var(--text-sm);outline:none;';
      wrap.appendChild(input);
      card.appendChild(wrap);
      return {
        getValue: () => input.value,
        focus: () => { input.focus(); input.select(); },
      };
    },
  }).then((v) => (typeof v === 'string' ? v : null));
}
