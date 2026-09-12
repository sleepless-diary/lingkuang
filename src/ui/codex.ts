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
import type { Entity } from '../store/types';
import { currentWorld } from '../store/store';
import { addEntity, removeEntity } from '../store/actions';
import { confirmDialog } from './confirm';
import { escapeHtml } from './html';
import { fieldRow } from './fields';
import { createDocEditor, type DocEditor } from './doc-editor';

const INP = 'flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 7px;font-size:var(--text-sm);outline:none;font-family:inherit;user-select:text;';

export function renderCodex(store: Store, host: HTMLElement): () => void {
  host.style.overflow = 'hidden';
  let filterType = '';          // '' = 全部
  let activeId = '';
  let msgTimer: number | undefined;
  /* 正文编辑器（tiptap）。切换条目时必须先 flush 再 dispose —— 否则正在编辑的正文会丢，
     而 tiptap 实例不销毁会积 window 监听与订阅。 */
  let docEditor: DocEditor | null = null;
  /* 正文自身提交时不要再整块重渲染（否则每敲完一段失焦都会重建编辑器、丢光标位置） */
  let quiet = false;

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

  function render(): void {
    /* 切条目 / 重渲染前先把正文结算掉（未失焦的编辑也在里面），再销毁旧实例 */
    if (docEditor) { docEditor.flush(); docEditor.dispose(); docEditor = null; }
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
                   <div id="cx-fields" style="display:flex;flex-direction:column;gap:5px;"></div>
                 </div>
                 <div style="margin-top:10px;border-top:1px dashed var(--border-soft);padding-top:10px;">
                   <div style="font-size:10px;color:var(--fg-2);margin-bottom:4px;">正文（Markdown · 失焦自动保存）</div>
                   <div id="cx-doc"></div>
                 </div>`
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
    /* 字段行（公共控件 `src/ui/fields.ts`）：模板声明的类型决定控件形态 */
    const fieldsHost = host.querySelector('#cx-fields') as HTMLElement | null;
    if (fieldsHost && cur) {
      if (!(t?.fields ?? []).length) {
        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:var(--text-xs);color:var(--fg-2);';
        hint.textContent = '这个类型还没有字段 —— 到左栏「结构体管理」的“实体类型”里加。';
        fieldsHost.appendChild(hint);
      }
      for (const f of t?.fields ?? []) {
        fieldsHost.appendChild(fieldRow(f, cur.properties?.[f.name], (v) => {
          patchEntity((e) => { e.properties = { ...(e.properties ?? {}), [f.name]: v }; });
          say('已保存 ✓');
        }));
      }
    }
    /* 正文：真编辑器（tiptap）。onFlush 回写实体 doc —— 落盘时由主进程写进
       `<世界>/_设定/<类型>/<名字>.md` 的 `#正文：` 之后，Obsidian 双向可读 */
    const docHost = host.querySelector('#cx-doc') as HTMLElement | null;
    if (docHost && cur) {
      docEditor = createDocEditor(docHost, (md) => {
        quiet = true;   /* 正文自身的提交不整块重渲染 —— 否则会重建编辑器、丢光标位置 */
        try { patchEntity((e) => { e.doc = md; }); } finally { quiet = false; }
      });
      docEditor.setDoc(cur.doc ?? '');
    }

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

  let torn = false;
  const unsub = store.subscribe(() => {
    if (torn || quiet) return;
    if (!host.isConnected || !host.querySelector('#cx-root')) { unsub(); return; }
    render();
  });
  render();
  return () => {
    torn = true;
    unsub();
    /* 切走工具时把未失焦的正文也结算掉，再销毁 tiptap 实例 */
    if (docEditor) { docEditor.flush(); docEditor.dispose(); docEditor = null; }
    if (msgTimer) window.clearTimeout(msgTimer);
  };
}
