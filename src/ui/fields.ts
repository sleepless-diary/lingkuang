/** 灵框 · 模板字段控件（共用）
 *
 * 一块「字段名 + 控件」的行，按**模板声明的类型**渲染，供三个面板共用：
 * 设定库/工作台、节点详情面板、编辑器属性区。
 *
 * ⚠️ 统一约定：**只在 `change`（失焦 / 回车）时提交** —— 这几个面板都会在 store 通知时整块重渲染，
 * 用 `input` 边打边存会把正在输入的框销毁、没法连着打字。
 */
import type { FieldType, PropValue } from '../store/types';
import { isImeEnter } from './keys';

const INP = 'flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 7px;font-size:var(--text-sm);outline:none;font-family:inherit;user-select:text;';

export interface FieldSpec { name: string; type: FieldType }

/** 输入文字 → 字段值（列表按「、,，/|」拆项；数值空值归 0，与模板默认值一致） */
export function parseFieldInput(raw: string, type: FieldType): PropValue {
  if (type === 'number') {
    const n = Number(raw);
    return raw.trim() !== '' && Number.isFinite(n) ? n : 0;
  }
  if (type === 'list') return raw.split(/[、,，/|]/).map((x) => x.trim()).filter(Boolean);
  return raw;
}

/** 字段值 → 控件里显示的文字 */
export function formatFieldValue(v: PropValue | undefined, type: FieldType): string {
  if (type === 'list') return Array.isArray(v) ? v.join('、') : '';
  if (type === 'boolean') return '';
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' ? v : '';
}

/** 造一行字段控件。`onChange` 只在 change/回车时调用。 */
export function fieldRow(field: FieldSpec, value: PropValue | undefined, onChange: (v: PropValue) => void, labelWidth = 64): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText = `display:flex;gap:6px;align-items:${field.type === 'longtext' ? 'flex-start' : 'center'};`;
  const label = document.createElement('span');
  label.style.cssText = `width:${labelWidth}px;flex-shrink:0;font-size:var(--text-xs);color:var(--fg-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
  label.textContent = field.name;
  label.title = field.name;
  row.appendChild(label);

  if (field.type === 'boolean') {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = value === true;
    cb.style.cssText = 'width:15px;height:15px;cursor:pointer;';
    cb.addEventListener('change', () => onChange(cb.checked));
    row.appendChild(cb);
    return row;
  }

  const text = formatFieldValue(value, field.type);
  let ctrl: HTMLInputElement | HTMLTextAreaElement;
  if (field.type === 'longtext') {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = `${INP}min-height:52px;resize:vertical;line-height:1.6;`;
    ctrl = ta;
  } else {
    const inp = document.createElement('input');
    inp.type = field.type === 'number' ? 'number' : 'text';
    inp.value = text;
    inp.placeholder = field.type === 'list' ? '多项用、分隔' : '（可留空）';
    inp.style.cssText = INP;
    ctrl = inp;
  }
  ctrl.addEventListener('change', () => onChange(parseFieldInput(ctrl.value, field.type)));
  /* 单行控件：回车 = 提交并退出（blur 会触发 change；输入法组字期的回车不算） */
  ctrl.addEventListener('keydown', (ev) => {
    const k = ev as KeyboardEvent;
    if (field.type === 'longtext' || k.key !== 'Enter' || isImeEnter(k)) return;
    ev.preventDefault();
    ctrl.blur();
  });
  row.appendChild(ctrl);
  return row;
}
