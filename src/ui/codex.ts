/** 灵框 · 设定库（实体档案视图）
 *
 * 第一阶段交付物：实体（角色/地点/物品/组织/种族…）在这里当**条目**看与改。
 * - 左列：类型筛选 + 实体列表（按名字排序）
 * - 右侧：档案卡 —— 名称 / 类型 / **按类型模板渲染的字段** / 正文预览 / 删除
 *
 * 与「结构体管理」的分工：那个面板管**模板**（类型有哪些字段），这个面板管**内容**（实体的字段值）。
 * 模板是唯一权威（`src/main.ts` 的 ensureEntityLayer 负责补空字段），所以这里的字段集合跟着类型走。
 */
import type { Store } from '../store/store';
import type { Entity, FieldType } from '../store/types';
import { currentWorld } from '../store/store';
import { addEntity, removeEntity } from '../store/actions';
import { confirmDialog } from './confirm';
import { escapeHtml } from './html';
import { isImeEnter } from './keys';

const INP = 'flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 7px;font-size:var(--text-sm);outline:none;font-family:inherit;user-select:text;';

export function renderCodex(store: Store, host: HTMLElement): () => void {
  host.style.overflow = 'hidden';
  let filterType = '';          // '' = 全部
  let activeId = '';
  let msgTimer: number | undefined;

  const world = () => currentWorld(store);
  const types = () => world().entityTypes ?? {};
  const entities = (): Entity[] => Object.values(world().entities ?? {}) as Entity[];
  const filtered = (): Entity[] => {
    const list = entities().filter((e) => !filterType || e.typeId === filterType);
    return list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
  };
  const typeName = (id: string): string => types()[id]?.name ?? id ?? '（无类型）';
  const active = (): Entity | undefined => world().entities?.[activeId];

  function say(text: string, bad = false): void {
    const el = host.querySelector('#cx-msg') as HTMLElement | null;
    if (!el) return;
    el.textContent = text;
    el.style.color = bad ? 'var(--danger)' : 'var(--accent)';
    if (msgTimer) window.clearTimeout(msgTimer);
    msgTimer = window.setTimeout(() => { if (el.isConnected) el.textContent = ''; }, 2600);
  }

  /** 改实体身上某个字段（或名字/类型）。走 store.update → 可撤销、会落盘。 */
  function patchEntity(fn: (e: Entity) => void): void {
    store.update((d) => {
      const ws = d.worldsets[store.activeWorld];
      const e = ws?.entities?.[activeId];
      if (e) fn(e);
    });
  }

  /** 字段控件：模板声明的类型决定形态（长文本 textarea / 列表用「、」分隔 / 数值 number / 开关 checkbox） */
  function fieldRow(name: string, type: FieldType, e: Entity): string {
    const v = e.properties?.[name];
    const nm = escapeHtml(name);
    const label = `<span style="width:64px;flex-shrink:0;font-size:var(--text-xs);color:var(--fg-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${nm}">${nm}</span>`;
    if (type === 'boolean') {
      return `<div style="display:flex;align-items:center;gap:6px;">${label}<input data-cx-field="${nm}" type="checkbox"${v === true ? ' checked' : ''} style="width:15px;height:15px;cursor:pointer;"/></div>`;
    }
    if (type === 'number') {
      return `<div style="display:flex;align-items:center;gap:6px;">${label}<input data-cx-field="${nm}" type="number" value="${typeof v === 'number' ? v : ''}" style="${INP}"/></div>`;
    }
    if (type === 'list') {
      const arr = Array.isArray(v) ? v : [];
      return `<div style="display:flex;align-items:center;gap:6px;">${label}<input data-cx-field="${nm}" type="text" value="${escapeHtml(arr.join('、'))}" placeholder="多项用、分隔" style="${INP}"/></div>`;
    }
    if (type === 'longtext') {
      return `<div style="display:flex;align-items:flex-start;gap:6px;">${label}<textarea data-cx-field="${nm}" placeholder="（可留空）" style="${INP}min-height:52px;resize:vertical;line-height:1.6;">${escapeHtml(typeof v === 'string' ? v : '')}</textarea></div>`;
    }
    return `<div style="display:flex;align-items:center;gap:6px;">${label}<input data-cx-field="${nm}" type="text" value="${escapeHtml(typeof v === 'string' ? v : '')}" placeholder="（可留空）" style="${INP}"/></div>`;
  }

  function render(): void {
    const list = filtered();
    if (!active() || !list.some((e) => e.id === activeId)) activeId = list[0]?.id ?? '';
    const cur = active();
    const t = cur ? types()[cur.typeId] : undefined;
    const kinds = Object.keys(types());

    const chips = [{ id: '', label: `全部 ${entities().length}` }]
      .concat(kinds.map((k) => ({ id: k, label: `${typeName(k)} ${entities().filter((e) => e.typeId === k).length}` })))
      .map((c) => `<button data-cx-filter="${escapeHtml(c.id)}" style="background:${filterType === c.id ? 'var(--accent)' : 'var(--surface-2)'};color:${filterType === c.id ? 'var(--accent-on)' : 'var(--fg)'};border:1px solid ${filterType === c.id ? 'var(--accent)' : 'var(--border)'};border-radius:var(--radius-pill);padding:3px 10px;font-size:var(--text-xs);cursor:pointer;">${escapeHtml(c.label)}</button>`)
      .join('');

    const listHtml = list.length
      ? list.map((e) => `<button data-cx-id="${escapeHtml(e.id)}" style="display:flex;align-items:center;gap:6px;width:100%;text-align:left;background:${e.id === activeId ? 'var(--surface-2)' : 'transparent'};border:1px solid ${e.id === activeId ? 'var(--border)' : 'transparent'};border-radius:var(--radius-sm);color:var(--fg);padding:5px 8px;font-size:var(--text-sm);cursor:pointer;">
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(e.name || '(未命名)')}</span>
          <span style="font-size:10px;color:var(--fg-2);">${escapeHtml(typeName(e.typeId))}</span>
        </button>`).join('')
      : '<div style="font-size:var(--text-xs);color:var(--fg-2);padding:4px;">还没有实体。右上角选类型后点「＋新建实体」。</div>';

    host.innerHTML = `
      <div style="max-width:1020px;margin:0 auto;padding:18px 16px;display:flex;flex-direction:column;gap:10px;height:100%;overflow:auto;" id="cx-root">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <div style="font-size:17px;font-weight:600;color:var(--fg);">设定库</div>
          <span style="font-size:var(--text-xs);color:var(--fg-2);">「${escapeHtml(store.activeWorld || '（未选世界）')}」的实体 · 字段由类型模板决定（在左栏「结构体管理」里改模板）</span>
          <span style="margin-left:auto;display:flex;gap:6px;align-items:center;">
            <select id="cx-new-type" title="新实体的类型" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 6px;font-size:var(--text-xs);outline:none;">${(kinds.length ? kinds : ['']).map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(k ? typeName(k) : '（还没有类型）')}</option>`).join('')}</select>
            <button id="cx-new" ${kinds.length ? '' : 'disabled'} style="background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-sm);padding:6px 14px;font-size:var(--text-xs);cursor:pointer;${kinds.length ? '' : 'opacity:.4;cursor:default;'}">＋新建实体</button>
          </span>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">${chips}</div>
        <div style="display:flex;gap:12px;align-items:flex-start;">
          <div style="width:250px;flex-shrink:0;display:flex;flex-direction:column;gap:3px;border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px;">${listHtml}</div>
          <div style="flex:1;min-width:0;border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;">
            ${cur
              ? `<div style="display:flex;align-items:center;gap:8px;">
                   <input id="cx-name" value="${escapeHtml(cur.name)}" style="${INP}font-size:15px;font-weight:600;"/>
                   <span style="font-size:var(--text-xs);color:var(--fg-2);flex-shrink:0;">类型</span>
                   <select id="cx-type" style="flex-shrink:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-xs);outline:none;">${kinds.map((k) => `<option value="${escapeHtml(k)}"${k === cur.typeId ? ' selected' : ''}>${escapeHtml(typeName(k))}</option>`).join('')}</select>
                   <button id="cx-del" style="margin-left:auto;flex-shrink:0;background:transparent;border:1px solid var(--danger);color:var(--danger);border-radius:var(--radius-sm);padding:3px 10px;font-size:var(--text-xs);cursor:pointer;">删除</button>
                 </div>
                 <div style="display:flex;flex-direction:column;gap:5px;margin-top:10px;border-top:1px dashed var(--border-soft);padding-top:10px;">
                   ${(t?.fields ?? []).map((f) => fieldRow(f.name, f.type, cur)).join('') || '<div style="font-size:var(--text-xs);color:var(--fg-2);">这个类型还没有字段 —— 到左栏「结构体管理」的“实体类型”里加。</div>'}
                 </div>
                 <div style="margin-top:10px;border-top:1px dashed var(--border-soft);padding-top:10px;font-size:var(--text-sm);color:var(--fg);line-height:1.7;white-space:pre-wrap;">${cur.doc ? escapeHtml(cur.doc).slice(0, 800) : '<span style="color:var(--fg-2);">（正文为空 · 在左栏「编辑器」的实体页里写）</span>'}</div>`
              : '<div style="font-size:var(--text-xs);color:var(--fg-2);">左边选一个实体看图。</div>'}
          </div>
        </div>
        <div id="cx-msg" style="font-size:var(--text-xs);"></div>
      </div>`;

    /* ── 事件 ── */
    host.querySelectorAll<HTMLElement>('[data-cx-filter]').forEach((el) => {
      el.addEventListener('click', () => { filterType = el.dataset.cxFilter ?? ''; render(); });
    });
    host.querySelectorAll<HTMLElement>('[data-cx-id]').forEach((el) => {
      el.addEventListener('click', () => { activeId = el.dataset.cxId ?? ''; render(); });
    });
    host.querySelector('#cx-new')?.addEventListener('click', () => {
      const sel = host.querySelector('#cx-new-type') as HTMLSelectElement | null;
      const typeId = sel?.value ?? '';
      if (!typeId) return;
      const id = addEntity(store, { typeId, name: '新实体' });
      activeId = id;
      render();
      say('已新建，改个名字吧');
    });
    host.querySelector('#cx-name')?.addEventListener('change', () => {
      const inp = host.querySelector('#cx-name') as HTMLInputElement;
      patchEntity((e) => { e.name = inp.value.trim() || '未命名'; });
      say('已保存 ✓');
    });
    host.querySelector('#cx-type')?.addEventListener('change', () => {
      const sel = host.querySelector('#cx-type') as HTMLSelectElement;
      patchEntity((e) => { e.typeId = sel.value; });
      /* 换类型 → 按新模板补字段（由 src/main.ts 的 ensureEntityLayer 统一做） */
      window.dispatchEvent(new CustomEvent('lingkuang-formats-changed'));
      say('已换类型 ✓');
    });
    /* 字段：**只在 change（失焦/回车）提交** —— 这个面板每次 store 通知会重渲染，
       用 input 边打边存会把正在输入的框销毁。 */
    host.querySelectorAll<HTMLElement>('[data-cx-field]').forEach((el) => {
      const name = el.dataset.cxField ?? '';
      const fType = (t?.fields ?? []).find((f) => f.name === name)?.type ?? 'text';
      el.addEventListener('change', () => {
        if (fType === 'boolean') {
          const checked = (el as HTMLInputElement).checked;
          patchEntity((e) => { e.properties = { ...(e.properties ?? {}), [name]: checked }; });
          say('已保存 ✓');
          return;
        }
        const raw = (el as HTMLInputElement | HTMLTextAreaElement).value;
        patchEntity((e) => {
          const p = { ...(e.properties ?? {}) };
          if (fType === 'number') {
            const num = Number(raw);
            p[name] = raw.trim() !== '' && Number.isFinite(num) ? num : 0;
          } else if (fType === 'list') {
            p[name] = raw.split(/[、,，/|]/).map((x) => x.trim()).filter(Boolean);
          } else {
            p[name] = raw;
          }
          e.properties = p;
        });
        say('已保存 ✓');
      });
      el.addEventListener('keydown', (ev) => {
        const k = ev as KeyboardEvent;
        if (fType === 'longtext' || k.key !== 'Enter' || isImeEnter(k)) return;
        (el as HTMLInputElement).blur();
      });
    });
    host.querySelector('#cx-del')?.addEventListener('click', () => {
      const c = active();
      if (!c) return;
      void confirmDialog({
        title: `删除实体「${c.name || '未命名'}」？`,
        message: '这条设定（含它的字段值与正文）会被移除。',
        detail: '可以先用左栏「备份管理」的「立即备份」留一份，或在回收站里找它的正文文件。',
        confirmText: '删除',
        danger: true,
      }).then((ok) => {
        if (!ok) return;
        removeEntity(store, c.id);
        activeId = '';
        render();
        say('已删除');
      });
    });
  }

  const unsub = store.subscribe(() => {
    if (!host.isConnected || !host.querySelector('#cx-root')) { unsub(); return; }
    render();
  });
  render();
  return () => {
    unsub();
    if (msgTimer) window.clearTimeout(msgTimer);
  };
}
