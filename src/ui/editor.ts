/** 编辑器模块——文稿编辑（时间线节点 + 实体，Obsidian 式 #字段：值）：
 * 左侧 sidebar（时间线 tab：时间线→节点；实体 tab：类型→实体），右侧编辑 doc（失焦保存） */
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import { saveNodeDoc, addEntity } from '../store/actions';
import { mdRender } from './detail';
import type { EntityType } from '../store/types';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';

export function renderEditor(store: Store, host: HTMLElement): void {
  host.style.overflow = 'hidden';
  host.innerHTML = `
    <div style="display:flex;height:100%;">
      <div style="width:300px;border-right:1px solid var(--border);display:flex;flex-direction:column;background:var(--surface-2);">
        <div style="padding:8px 10px;border-bottom:1px solid var(--border-soft);display:flex;align-items:center;gap:6px;">
          <span style="font-size:15px;font-weight:600;color:var(--fg);">编辑器</span>
          <span style="flex:1;"></span>
          <button id="ed-tab-tl" style="background:none;border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:2px 10px;cursor:pointer;">时间线</button>
          <button id="ed-tab-entity" style="background:none;border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:2px 10px;cursor:pointer;">实体</button>
        </div>
        <div id="ed-sidebar" style="flex:1;overflow:auto;padding:6px 8px;"></div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;min-width:0;">
        <div id="ed-title" style="padding:8px 14px;border-bottom:1px solid var(--border-soft);font-size:var(--text-sm);color:var(--fg-2);">选择左侧节点/实体开始编辑（自动保存）</div>
        <div style="flex:1;display:flex;min-height:0;">
          <div id="ed-doc" style="flex:1;width:50%;background:var(--surface);border:none;height:100%;overflow:hidden;"></div>
          <div id="ed-preview" style="flex:1;width:50%;border-left:1px solid var(--border-soft);padding:12px 14px;font-size:var(--text-sm);color:var(--fg);line-height:1.7;overflow:auto;"></div>
        </div>
        <div id="ed-status" style="padding:4px 14px;border-top:1px solid var(--border-soft);font-size:var(--text-xs);color:var(--fg-2);"></div>
      </div>
    </div>`;

  const sidebar = host.querySelector('#ed-sidebar') as HTMLElement;
  const docBox = host.querySelector('#ed-doc') as HTMLElement;
  const preview = host.querySelector('#ed-preview') as HTMLElement;
  /* tiptap 富文本编辑器（所见即所得 → markdown 双向转，vault 保持 Obsidian markdown） */
  const editor = new Editor({
    element: docBox, extensions: [StarterKit, Markdown], contentType: 'markdown', content: '',
    onUpdate: () => { preview.innerHTML = mdRender(getDocMd()); },
  });
  function getDocMd(): string { return editor.getMarkdown() || ''; }
  function setDoc(md: string): void { editor.commands.setContent(md || '', { contentType: 'markdown' }); }
  /* 点击编辑器空白区 → 聚焦 tiptap，进入输入 */
  docBox.addEventListener('click', () => { editor.commands.focus(); });
  const titleEl = host.querySelector('#ed-title') as HTMLElement;
  const status = host.querySelector('#ed-status') as HTMLElement;
  const tabTl = host.querySelector('#ed-tab-tl') as HTMLElement;
  const tabEntity = host.querySelector('#ed-tab-entity') as HTMLElement;
  let tab: 'tl' | 'entity' = 'tl';
  let currentTlId = '';
  let currentNodeId = '';
  let currentEntityId = '';

  function validTlId(): string | undefined {
    const ws = currentWorld(store);
    const valid = (ws.order ?? []).find((id) => ws.timelines[id]);
    if (store.activeTimeline && ws.timelines[store.activeTimeline]) return store.activeTimeline;
    return valid || Object.keys(ws.timelines)[0];
  }
  function setTab(t: 'tl' | 'entity') {
    tab = t;
    tabTl.style.background = t === 'tl' ? 'rgba(158,194,98,.15)' : 'none';
    tabEntity.style.background = t === 'entity' ? 'rgba(158,194,98,.15)' : 'none';
    renderSidebar();
  }

  function renderSidebar() {
    const ws = currentWorld(store);
    if (tab === 'tl') {
      const ids = (ws.order ?? []).filter((id) => ws.timelines[id]);
      const tlId = validTlId();
      sidebar.innerHTML = `
        <select id="ed-tl" style="width:100%;margin-bottom:6px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 8px;font-size:var(--text-sm);outline:none;">
          ${ids.map((id) => `<option value="${id}"${id === tlId ? ' selected' : ''}>${ws.timelines[id]?.name ?? '?'} (${ws.timelines[id]?.nodes.length ?? 0})</option>`).join('')}
        </select>
        <div id="ed-node-list"></div>`;
      const sel = sidebar.querySelector('#ed-tl') as HTMLSelectElement;
      sel.addEventListener('change', () => store.setActiveTimeline(sel.value));
      const tl = tlId ? ws.timelines[tlId] : undefined;
      const nodeList = sidebar.querySelector('#ed-node-list') as HTMLElement;
      if (tl) {
        nodeList.innerHTML = tl.nodes
          .map(
            (n) =>
              `<button class="ed-item${n.id === currentNodeId ? ' is-on' : ''}" data-id="${n.id}" style="display:block;width:100%;text-align:left;background:${n.id === currentNodeId ? 'rgba(158,194,98,.12)' : 'none'};border:none;color:var(--fg);font-size:var(--text-xs);padding:4px 8px;border-radius:var(--radius-sm);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><span style="font-family:var(--font-mono);color:var(--accent);">${n.year}</span> · ${n.title}</button>`
          )
          .join('') || '<div style="font-size:var(--text-xs);color:var(--fg-2);padding:6px;">（空时间线）</div>';
        nodeList.querySelectorAll('.ed-item').forEach((el) => {
          el.addEventListener('click', () => {
            currentNodeId = (el as HTMLElement).dataset.id!;
            currentTlId = tlId!;
            const n = tl.nodes.find((x) => x.id === currentNodeId);
            setDoc(n?.doc ?? '');
            titleEl.textContent = n?.title ?? '';
            status.textContent = '失焦自动保存';
            renderSidebar();
          });
        });
      }
      return;
    }
    /* 实体 tab */
    const types = ws.entityTypes ?? {};
    const entities = ws.entities ?? {};
    sidebar.innerHTML = `
      <div style="display:flex;gap:4px;margin-bottom:6px;">
        <button id="ed-entity-new" style="flex:1;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:3px;cursor:pointer;">＋实体</button>
        <button id="ed-type-new" style="flex:1;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:3px;cursor:pointer;">＋类型</button>
      </div>
      <div id="ed-entity-list"></div>`;
    sidebar.querySelector('#ed-entity-new')?.addEventListener('click', () => {
      const typeId = Object.keys(types)[0] ?? 'default';
      const id = addEntity(store, { typeId, name: '新实体' });
      currentEntityId = id;
      const e = currentWorld(store).entities?.[id];
      setDoc(e?.doc ?? '');
      titleEl.textContent = '新实体';
      renderSidebar();
    });
    sidebar.querySelector('#ed-type-new')?.addEventListener('click', () => {
      store.update((d) => {
        const ws2 = d.worldsets[store.activeWorld];
        if (!ws2.entityTypes) ws2.entityTypes = {};
        const tid = 'et' + Date.now();
        ws2.entityTypes[tid] = { id: tid, name: '新类型', fields: [] };
      });
      renderSidebar();
    });
    const el = sidebar.querySelector('#ed-entity-list') as HTMLElement;
    el.innerHTML = Object.entries(types)
      .map(
        ([tid, t]) =>
          `<div style="margin-bottom:4px;">
            <div style="font-size:11px;font-weight:600;color:var(--accent);padding:2px 4px;">${(t as EntityType).name} <span style="color:var(--fg-2);font-weight:400;">${Object.values(entities).filter((e) => e.typeId === tid).length}</span></div>
            ${Object.values(entities)
              .filter((e) => e.typeId === tid)
              .map(
                (e) =>
                  `<button class="ed-item${e.id === currentEntityId ? ' is-on' : ''}" data-id="${e.id}" style="display:block;width:100%;text-align:left;background:${e.id === currentEntityId ? 'rgba(158,194,98,.12)' : 'none'};border:none;color:var(--fg);font-size:var(--text-xs);padding:3px 10px;border-radius:var(--radius-sm);cursor:pointer;">${e.name}</button>`
              )
              .join('')}
          </div>`
      )
      .join('') || '<div style="font-size:var(--text-xs);color:var(--fg-2);padding:6px;">（无类型，先建类型）</div>';
    el.querySelectorAll('.ed-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentEntityId = (btn as HTMLElement).dataset.id!;
        const e = currentWorld(store).entities?.[currentEntityId];
        setDoc(e?.doc ?? '');
        titleEl.textContent = e?.name ?? '';
        status.textContent = '失焦自动保存';
        renderSidebar();
      });
    });
  }

  /* 失焦保存 + 实时预览 */
  /* 保存：tiptap 失焦时把 markdown 写回 doc（vault 仍存 Obsidian markdown） */
  editor.on('blur', () => {
    const md = getDocMd();
    if (tab === 'tl' && currentNodeId && currentTlId) {
      saveNodeDoc(store, currentTlId, currentNodeId, md);
      status.textContent = '已保存 ✓';
    } else if (tab === 'entity' && currentEntityId) {
      store.update((d) => {
        const e = d.worldsets[store.activeWorld]?.entities?.[currentEntityId];
        if (e) e.doc = md;
      });
      status.textContent = '已保存 ✓';
    }
  });

  tabTl.addEventListener('click', () => setTab('tl'));
  tabEntity.addEventListener('click', () => setTab('entity'));
  store.subscribe(() => renderSidebar());
  setTab('tl');
}
