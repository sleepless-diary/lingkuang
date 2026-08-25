/** 编辑器模块——文稿编辑（时间线节点 + 实体，Obsidian 式 #字段：值）：
 * 左侧 sidebar（时间线 tab：时间线→节点；实体 tab：类型→实体），右侧编辑 doc（失焦保存） */
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import { saveNodeDoc, addEntity } from '../store/actions';
import type { PropValue } from '../store/types';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { Image } from './image-ext';
import { Tag } from './tag-ext';
import { parseTimeText } from './node-form';
import { toEpoch, fromEpoch, defaultCalendar, calendarOf, timePointOf } from '../calendar';

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** AE 式 scrub：鼠标水平拖拽 / 滚轮垂直 调整数值，shift 加大步进；可聚焦直接输入。用于数值和日期属性。 */
function createScrubField(
  cfg: { value: number; step: number; format: (v: number) => string; onCommit: (v: number) => void; min?: number; inputValue?: (v: number) => string; parse?: (s: string) => number; onInputText?: (s: string) => void; }
): HTMLElement {
  const el = document.createElement('span');
  el.style.cssText = 'flex:1;min-width:0;display:flex;align-items:center;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);cursor:ew-resize;user-select:none;';
  const label = document.createElement('span');
  label.style.cssText = 'flex:1;padding:3px 6px;font-size:var(--text-xs);color:var(--fg);font-family:var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  label.textContent = cfg.format(cfg.value);
  el.appendChild(label);
  let dragging = false, startX = 0, startV = cfg.value, shift = false, downX = 0, moved = false, editing = false, isDown = false;
  el.addEventListener('pointerdown', (e) => {
    if (editing) return; /* 编辑态：事件交给 input，不抢拖动/单击 */
    if (e.altKey) { startInput(); return; }
    isDown = true; dragging = false; moved = false; downX = e.clientX; startX = e.clientX; startV = cfg.value; shift = e.shiftKey;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    /* 只有按住（isDown）才处理拖动；悬停移动不触发改值 */
    if (!isDown) return;
    if (Math.abs(e.clientX - downX) > 3) moved = true;
    if (!dragging && moved) { dragging = true; el.style.background = 'var(--surface)'; }
    if (!dragging) return;
    const dx = e.clientX - startX;
    const s = cfg.step * (shift ? 10 : 1);
    const v = clamp(startV + Math.round(dx) * s);
    cfg.onCommit(v);
    label.textContent = cfg.format(v);
  });
  el.addEventListener('pointerup', () => {
    isDown = false;
    /* 单击（按下后未拖动且未在编辑）→ 直接进入输入编辑；拖动才结束拖动态 */
    if (!moved) { if (!editing) startInput(); return; }
    if (dragging) { dragging = false; el.style.background = 'var(--surface-2)'; }
  });
  el.addEventListener('wheel', (e) => {
    e.preventDefault(); e.stopPropagation();
    const s = cfg.step * (e.shiftKey ? 10 : 1);
    const dir = e.deltaY < 0 ? 1 : -1;
    const v = clamp(cfg.value + dir * s);
    cfg.onCommit(v);
    label.textContent = cfg.format(v);
  }, { passive: false });
  /* 双击也保留（兼容点快时误判），与单击都进输入 */
  el.addEventListener('dblclick', (e) => { e.preventDefault(); startInput(); });
  function startInput() {
    const inp = document.createElement('input');
    inp.value = cfg.inputValue ? cfg.inputValue(cfg.value) : cfg.format(cfg.value);
    inp.style.cssText = 'flex:1;min-width:0;background:var(--surface);border:none;outline:none;color:var(--fg);font-size:var(--text-xs);font-family:var(--font-mono);padding:3px 6px;cursor:text;';
    editing = true;
    el.replaceChildren(inp);
    /* 不全选：单击进来直接落光标到末尾，立即可输入（免去"全选→取消全选"两步） */
    inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
    inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); } });
    inp.addEventListener('blur', () => {
      editing = false;
      if (cfg.onInputText) { cfg.onInputText(inp.value); el.replaceChildren(label); return; }
      const n = cfg.parse ? cfg.parse(inp.value) : parseFloat(inp.value);
      if (!Number.isNaN(n)) { const v = clamp(n); cfg.onCommit(v); label.textContent = cfg.format(v); }
      el.replaceChildren(label);
    });
  }
  function clamp(v: number): number { return cfg.min !== undefined ? Math.max(cfg.min, v) : v; }
  return el;
}

/* ── 日期 scrub 辅助：YYYY-MM-DD ↔ 天数（从 1970-01-01），支持拖拽/滚轮按天调整；世界纪年暂用标准公历，预留纪元接口 ── */
const DAY_MS = 86400000;
function dateToOrd(s: string): number {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return 0;
  return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1970, 0, 1)) / DAY_MS);
}
function ordToDate(ord: number): string {
  const d = new Date(Date.UTC(1970, 0, 1) + ord * DAY_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function fmtCNDate(s: string): string {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : s;
}

/* 刻度 → 人性化显示（用 fromEpoch 反推，支持年月日时分）；cal 缺省用默认 360 天制 */
function fmtYearDisplay(epoch: number, cal?: import('../calendar').Calendar): string {
  const c = cal ?? defaultCalendar();
  const tp = fromEpoch(c, epoch);
  const yr = tp.anchor.year;
  const v = tp.values;
  let s = `${yr}年`;
  if (v.month >= 1) s += `${v.month}月`;
  if (v.day >= 1) s += `${v.day}日`;
  if (v.hour) s += `${v.hour}时`;
  return s;
}

/** 按属性类型生成值控件（数值/日期 scrub、布尔 checkbox、多选一列 checkbox、文本 input），change 回调对应 PropValue */
function buildPropCtrl(v: PropValue, onChange: (next: PropValue) => void): HTMLElement {
  /* 数值 → 拖拽 + 滚轮 scrub */
  if (typeof v === 'number') {
    return createScrubField({ value: v, step: 1, format: (n) => String(n), onCommit: (n) => onChange(n) });
  }
  /* 日期 → 拖拽 + 滚轮 scrub（按天调整，显示中文年月日；标准公历，预留世界观纪年） */
  if (typeof v === 'string' && /^\d{4}-\d{1,2}-\d{1,2}$/.test(v)) {
    return createScrubField({
      value: dateToOrd(v), step: 1,
      format: (ord) => fmtCNDate(ordToDate(ord)),
      inputValue: (ord) => ordToDate(ord),
      parse: (s) => dateToOrd(s),
      onCommit: (ord) => onChange(ordToDate(ord)),
    });
  }
  /* 布尔 → 复选框 */
  if (typeof v === 'boolean') {
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = v;
    cb.style.cssText = 'width:16px;height:16px;';
    cb.addEventListener('change', () => onChange(cb.checked));
    return cb;
  }
  /* 多选 → 一列复选框（每项一个开关） */
  if (Array.isArray(v)) {
    const list = document.createElement('div');
    list.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;';
    v.forEach((item) => {
      const lab = document.createElement('label');
      lab.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:var(--text-xs);color:var(--fg);';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = String(item); cb.checked = true;
      cb.style.cssText = 'width:14px;height:14px;';
      const txt = document.createElement('span'); txt.textContent = String(item);
      cb.addEventListener('change', () => {
        /* 取消勾选 = 从列表移除该项 */
        const next = cb.checked ? [...v, item] : v.filter((x) => String(x) !== String(item));
        onChange(next);
      });
      lab.appendChild(cb); lab.appendChild(txt);
      list.appendChild(lab);
    });
    return list;
  }
  /* 文本 → 普通输入 */
  const inp = document.createElement('input');
  inp.value = String(v ?? '');
  inp.style.cssText = 'flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-xs);outline:none;font-family:inherit;';
  inp.addEventListener('change', () => onChange(inp.value));
  return inp;
}


export function renderEditor(store: Store, host: HTMLElement): void {
  host.style.overflow = 'hidden';
  host.innerHTML = `
    <div style="display:flex;height:100%;">
      <div style="width:300px;border-right:1px solid var(--border);display:flex;flex-direction:column;background:var(--surface-2);">
        <div style="padding:8px 10px;border-bottom:1px solid var(--border-soft);display:flex;align-items:center;gap:6px;">
          <span style="font-size:15px;font-weight:600;color:var(--fg);">编辑器</span>
          <span style="flex:1;"></span>
          <button id="ed-h1" title="标题" style="background:none;border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:2px 8px;cursor:pointer;">H</button>
          <button id="ed-img" style="background:none;border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:2px 10px;cursor:pointer;">插图</button>
          <button id="ed-tab-tl" style="background:none;border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:2px 10px;cursor:pointer;">时间线</button>
          <button id="ed-tab-entity" style="background:none;border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:2px 10px;cursor:pointer;">实体</button>
        </div>
        <div id="ed-sidebar" style="flex:1;overflow:auto;padding:6px 8px;"></div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;min-width:0;">
        <div id="ed-title" style="padding:8px 14px;border-bottom:1px solid var(--border-soft);font-size:var(--text-sm);color:var(--fg-2);">选择左侧节点/实体开始编辑（自动保存）</div>
        <div id="ed-props" style="display:none;padding:10px 14px;border-bottom:1px solid var(--border-soft);background:var(--surface-2);"></div>
        <div id="ed-hint" style="display:none;padding:8px 14px;border-bottom:1px solid var(--border-soft);background:rgba(217,101,92,.12);font-size:var(--text-xs);color:var(--fg);line-height:1.5;"></div>
        <div style="flex:1;display:flex;min-height:0;">
          <div id="ed-doc" style="flex:1;width:100%;background:var(--surface);border:none;height:100%;overflow:hidden;"></div>
        </div>
        <div id="ed-status" style="padding:4px 14px;border-top:1px solid var(--border-soft);font-size:var(--text-xs);color:var(--fg-2);"></div>
      </div>
    </div>`;

  const sidebar = host.querySelector('#ed-sidebar') as HTMLElement;
  const docBox = host.querySelector('#ed-doc') as HTMLElement;
  const hintEl = host.querySelector('#ed-hint') as HTMLElement;
  /* 全局提示条（累积列表）：多个文件出错并列展示，各自带「恢复格式」/自定义按钮；key 去重 */
  const hints = new Map<string, { msg: string; onRestore?: () => void; actionBtn?: { text: string; onClick: () => void } }>();
  function renderHints(): void {
    if (!hints.size) { hintEl.style.display = 'none'; hintEl.innerHTML = ''; return; }
    hintEl.style.display = 'block';
    hintEl.innerHTML = '';
    hints.forEach((h) => {
      const row = document.createElement('div');
      row.style.cssText = 'margin:2px 0;padding:6px 8px;background:rgba(217,101,92,.14);border-radius:var(--radius-sm);';
      row.textContent = h.msg;
      if (h.onRestore) {
        const btn = document.createElement('button');
        btn.textContent = '恢复格式';
        btn.style.cssText = 'margin-left:8px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);font-size:var(--text-xs);padding:2px 8px;cursor:pointer;';
        btn.onclick = (e) => { e.stopPropagation(); h.onRestore!(); };
        row.appendChild(btn);
      }
      if (h.actionBtn) {
        const btn = document.createElement('button');
        btn.textContent = h.actionBtn.text;
        btn.style.cssText = 'margin-left:8px;background:none;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg-2);font-size:var(--text-xs);padding:2px 8px;cursor:pointer;';
        btn.onclick = (e) => { e.stopPropagation(); h.actionBtn!.onClick(); };
        row.appendChild(btn);
      }
      hintEl.appendChild(row);
    });
  }
  function addHint(key: string, msg: string, onRestore?: () => void, actionBtn?: { text: string; onClick: () => void }): void { hints.set(key, { msg, onRestore, actionBtn }); renderHints(); }
  function removeHint(key: string): void { if (hints.delete(key)) renderHints(); }
  hintEl.onclick = () => { hints.clear(); renderHints(); };
  /* 校验节点原始 .md 是否缺 #正文： 标签（外部误删会破坏编辑器正文结构）；缺且节点有正文内容时报错 + 恢复 */
  async function checkBodyTag(w: string, tl: string, id: string, doc: string, title: string): Promise<void> {
    const api = (window as any).lingkuangAPI;
    if (!api?.readNodeText) return;
    try {
      const res = await api.readNodeText(w, tl, id);
      /* 异步返回时若已切到别的节点，忽略本次结果（防旧提示闪现） */
      if (id !== currentNodeId) return;
      if (!res || !res.ok || !res.text) return;
      if (!/#正文[：:]/.test(res.text) && doc) {
        addHint('node:' + id, `【${title || '该节点'}】的文件丢了「#正文：」标签（外部修改），直接在 Obsidian 恢复容易出错。`, () => {
          saveNodeDoc(store, tl, id, doc);
          status.textContent = '已恢复 ✓';
          removeHint('node:' + id); /* 恢复后移除该条 */
        });
      } else {
        removeHint('node:' + id); /* 该节点校验通过（标签在）→ 移除它的提示 */
      }
      /* 其他情况不隐藏：提示条全局常驻，切节点/正常节点都不清，方便看到哪个文件出问题 */
    } catch (e) { /* 读取失败不打扰 */ }
  }
  /* 监听外部（Obsidian）对节点字段的增删 → 显示提示框 */
  window.addEventListener('lingkuang-vault-field-changed', ((e: Event) => {
    const list = (e as CustomEvent<{ id: string; title: string; diffs: string[]; oldDesc?: string }[]>).detail || [];
    if (!list.length) return;
    list.forEach((it) => {
      /* 可一键恢复的字段：正文标签被删、描述被删 → 带恢复按钮 */
      const bodyTagLost = it.diffs.some((d) => d.includes('「#正文：」标签被删除'));
      const descLost = it.diffs.some((d) => d.includes('描述被删除'));
      if (bodyTagLost || descLost) {
        const msgs: string[] = [];
        if (bodyTagLost) msgs.push('丢了「#正文：」标签');
        if (descLost) msgs.push('描述被删除');
        addHint('node:' + it.id, `【${it.title || '该节点'}】${msgs.join('、')}（外部修改），直接在 Obsidian 恢复容易出错。`, () => {
          if (bodyTagLost) restoreBodyTag(it.id);
          if (descLost) restoreDesc(it.id, it.oldDesc);
        });
      } else {
        addHint('external', `【${it.title || '该节点'}】检测到不支持的字段变更：${it.diffs.join('、')}。 请在灵框内的「结构体管理」中修改，Obsidian 端不支持直接增删属性/描述/正文。`);
      }
    });
  }) as EventListener);
  /* 自动修复通知（已修好，告知 + 可选以后不再提示） */
  window.addEventListener('lingkuang-vault-auto-fixed', ((e: Event) => {
    if (localStorage.getItem('lingkuang-hide-auto-fix-notice') === '1') return;
    const list = (e as CustomEvent<string[]>).detail || [];
    if (!list.length) return;
    addHint('autofix', `已自动修复：${list.join('、')} 的格式（已补回标准「#描述：」/「#正文：」标签）。格式只能在「结构体管理器」里调整，内容值随意。`, undefined, { text: '不再提示此类', onClick: () => { localStorage.setItem('lingkuang-hide-auto-fix-notice', '1'); removeHint('autofix'); } });
  }) as EventListener);
  function findNodeById(id: string): { tlId: string; node: any } | null {
    for (const ws of Object.values(store.data.worldsets)) {
      for (const tlId of (ws.order ?? [])) {
        const tl = ws.timelines?.[tlId];
        if (!tl) continue;
        const n = (tl.nodes ?? []).find((x: any) => x.id === id);
        if (n) return { tlId, node: n };
      }
    }
    return null;
  }
  /* 恢复 #正文： 标签：重写该节点 doc，触发落盘补回标准格式 */
  function restoreBodyTag(id: string): void {
    const found = findNodeById(id);
    if (!found) return;
    saveNodeDoc(store, found.tlId, id, found.node.doc ?? '');
    status.textContent = '已恢复 ✓';
    removeHint('node:' + id);
  }
  /* 恢复描述：把旧描述写回该节点，触发落盘补回 #描述： */
  function restoreDesc(id: string, oldDesc?: string): void {
    if (oldDesc === undefined) return;
    store.update((d) => {
      for (const ws of Object.values(d.worldsets)) {
        for (const tlId of (ws.order ?? [])) {
          const tl = ws.timelines?.[tlId];
          const n = (tl?.nodes ?? []).find((x: any) => x.id === id);
          if (n) { n.desc = oldDesc; return; }
        }
      }
    });
    status.textContent = '已恢复 ✓';
    removeHint('node:' + id);
  }
  /* tiptap 所见即所得编辑器（输入 # 变标题等 → markdown 双向转，vault 保持 Obsidian markdown 外部可读） */
  const editor = new Editor({
    element: docBox, extensions: [StarterKit, Markdown, Image, Tag], contentType: 'markdown', content: '',
  });
  function getDocMd(): string {
    /* 清理 tiptap 序列化的孤立 &nbsp; 空行（保留真实内容，去掉纯占位空行） */
    return (editor.getMarkdown() || '').replace(/(^|\n)(\s*&nbsp;\s*)+\n?/g, '\n').replace(/^\n+/, '');
  }
  function setDoc(md: string): void {
    editor.commands.setContent(md || '', { contentType: 'markdown' });
  }
  /* 属性面板（只读）：显示节点元数据 + #描述： + 已有自定义属性（结构化属性由世界沙盘管理，编辑器仅展示） */
  function renderProps(node: { title?: string; name?: string; year?: number | string; precision?: string; type?: string; desc?: string; properties?: Record<string, PropValue>; month?: number; day?: number; hour?: number; minute?: number; second?: number } | undefined, isEntity = false) {
    if (!node) { propsEl.style.display = 'none'; propsEl.innerHTML = ''; return; }
    propsEl.style.display = '';
    /* 自定义属性：可编辑（按类型控件），固定属性也用可编辑控件（年份 scrub、精度/类型下拉、标题/描述文本） */
    const saveProp = (next: Record<string, PropValue>) => {
      store.update((d) => {
        if (tab === 'tl' && currentTlId && currentNodeId) {
          const n = d.worldsets[store.activeWorld]?.timelines[currentTlId]?.nodes.find((x) => x.id === currentNodeId);
          if (n) n.properties = next;
        } else if (tab === 'entity' && currentEntityId) {
          const e = d.worldsets[store.activeWorld]?.entities?.[currentEntityId];
          if (e) e.properties = next;
        }
      });
      status.textContent = '已保存 ✓';
      /* 不在此重渲染面板：scrub 控件自身更新显示，避免销毁拖拽中控件 */
    };
    const addPropRow = (appendTo: HTMLElement, k: string, v: PropValue): void => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0;';
      const keyEl = document.createElement('span');
      keyEl.style.cssText = 'flex-shrink:0;width:80px;font-size:var(--text-xs);color:var(--fg-2);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      keyEl.textContent = k;
      row.appendChild(keyEl);
      row.appendChild(buildPropCtrl(v, (nv) => saveProp({ ...props, [k]: nv })));
      const del = document.createElement('button'); del.textContent = '×'; del.title = '删除属性';
      del.style.cssText = 'flex-shrink:0;width:18px;height:18px;background:none;border:none;color:var(--fg-2);cursor:pointer;font-size:14px;';
      del.addEventListener('click', () => { const np = { ...props }; delete np[k]; saveProp(np); renderProps(node, isEntity); });
      row.appendChild(del);
      appendTo.appendChild(row);
    };
    /* 固定属性也改成可编辑：标题/描述文本、年份数值 scrub、精度/类型下拉；保存写回 node 字段 */
    const saveFixed = (patch: Record<string, string>) => {
      store.update((d) => {
        if (tab === 'tl' && currentTlId && currentNodeId) {
          const n = d.worldsets[store.activeWorld]?.timelines[currentTlId]?.nodes.find((x) => x.id === currentNodeId);
          if (!n) return;
          for (const [k, v] of Object.entries(patch)) {
            if (k === '标题') n.title = v;
            else if (k === '时间') {
              const p = parseTimeText(v);
              n.year = (p?.year ?? parseFloat(v)) || 0;
              if (p) { n.precision = p.precision; n.month = p.month; n.day = p.day; n.hour = p.hour; n.minute = p.minute; n.second = p.second; }
            }
            else if (k === '精度') n.precision = v as any;
            else if (k === '类型') n.type = v as any;
            else if (k === '格式') n.kind = v || undefined;
            else if (k === '描述') n.desc = v;
          }
        } else if (tab === 'entity' && currentEntityId) {
          const e = d.worldsets[store.activeWorld]?.entities?.[currentEntityId];
          if (e && patch['名称'] !== undefined) e.name = patch['名称'];
        }
      });
      status.textContent = '已保存 ✓';
      /* 不在此重渲染面板：scrub 控件自身更新显示，避免销毁拖拽中控件 */
    };
    /* 固定属性行：年份数值 scrub、精度/类型下拉、标题/描述文本 */
    const fixedRows: { k: string; v: string }[] = isEntity
      ? [{ k: '名称', v: node.name ?? '' }]
      : [
          { k: '标题', v: node.title ?? '' },
          { k: '时间', v: node.year !== undefined ? String(node.year) : '' },
          { k: '精度', v: node.precision ?? '' },
          { k: '类型', v: node.type ?? '' },
        ];
    if (!isEntity) fixedRows.push({ k: '描述', v: node.desc ?? '' });
    const addFixedRow = (appendTo: HTMLElement, k: string, v: string): void => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0;';
      const keyEl = document.createElement('span');
      keyEl.style.cssText = 'flex-shrink:0;width:80px;font-size:var(--text-xs);color:var(--fg-2);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      keyEl.textContent = k;
      row.appendChild(keyEl);
      let ctrl: HTMLElement;
      if (k === '时间') {
        const tl = store.data.worldsets[store.activeWorld]?.timelines[currentTlId];
        const cal = calendarOf(tl ?? {});
        const daySec = cal.unit.minute * cal.unit.hour * cal.unit.day;
        const epoch = toEpoch(cal, timePointOf(Number(node.year ?? 0), { month: node.month, day: node.day, hour: node.hour, minute: node.minute, second: node.second }));
        ctrl = createScrubField({
          value: epoch, step: daySec, /* 一天一刻度 */
          format: (n) => fmtYearDisplay(n, cal),
          inputValue: (n) => fmtYearDisplay(n, cal), /* 输入框显示中文可读时间，parseTimeText 可解析 */
          onCommit: (n) => { /* 拖动/滚轮：按刻度回调，反推存完整时间 */
            const tp = fromEpoch(cal, n);
            const s = `${tp.anchor.year}年${tp.values.month}月${tp.values.day}日`;
            saveFixed({ 时间: s, 精度: node.precision ?? 'year' });
          },
          onInputText: (s) => { /* 双击/手动输入：parseTimeText 自动识别精度，同步更新完整时间 */
            const p = parseTimeText(s);
            if (p) {
              saveFixed({ 时间: s, 精度: p.precision });
              const n = store.data.worldsets[store.activeWorld]?.timelines[currentTlId]?.nodes.find((x) => x.id === currentNodeId);
              renderProps(n ?? undefined);
            }
          },
        });
      } else if (k === '精度') {
        const sel = document.createElement('select');
        sel.style.cssText = 'flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-xs);outline:none;';
        ['year', 'month', 'day', 'hour', 'minute', 'second'].forEach((p) => { const o = document.createElement('option'); o.value = p; o.textContent = p; sel.appendChild(o); });
        sel.value = v; sel.addEventListener('change', () => {
          saveFixed({ 精度: sel.value });
          /* 改精度后重渲染面板，让时间 scrub 的显示/步进/输入跟随新精度 */
          const n = store.data.worldsets[store.activeWorld]?.timelines[currentTlId]?.nodes.find((x) => x.id === currentNodeId);
          renderProps(n ?? undefined);
        });
        ctrl = sel;
      } else if (k === '类型') {
        const sel = document.createElement('select');
        sel.style.cssText = 'flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-xs);outline:none;';
        [['world_event', '世界事件'], ['story_event', '剧情事件'], ['loop-boundary', '循环边界']].forEach(([val, label]) => { const o = document.createElement('option'); o.value = val; o.textContent = label; sel.appendChild(o); });
        sel.value = v; sel.addEventListener('change', () => saveFixed({ 类型: sel.value }));
        ctrl = sel;
      } else if (k === '描述') {
        const ta = document.createElement('textarea');
        ta.value = v; ta.rows = 2;
        ta.style.cssText = 'flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-xs);outline:none;font-family:inherit;resize:vertical;';
        ta.addEventListener('change', () => saveFixed({ 描述: ta.value }));
        ctrl = ta;
      } else {
        const inp = document.createElement('input');
        inp.value = v;
        inp.style.cssText = 'flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-xs);outline:none;font-family:inherit;';
        inp.addEventListener('change', () => saveFixed({ [k]: inp.value }));
        ctrl = inp;
      }
      row.appendChild(ctrl);
      appendTo.appendChild(row);
    };
    const props = node.properties || {};
    propsEl.innerHTML = `<div class="ed-props"></div>`;
    const box = propsEl.querySelector('.ed-props') as HTMLElement;
    fixedRows.forEach((r) => addFixedRow(box, r.k, r.v));
    /* 格式引用：选择 kind（在 formats.json 定义应填字段）→ 编辑器按格式渲染字段 */
    /* 属性区：显示所有属性（格式字段已由 ensureAllFormatFields 补进 node.properties，起因/影响等归这里） */
    if (Object.keys(props).length) {
      const title = document.createElement('div');
      title.className = 'ed-props-title'; title.textContent = '属性';
      box.appendChild(title);
      Object.entries(props).forEach(([k, v]) => addPropRow(box, k, v));
    }
  }
  /* 点击编辑器空白区 → 聚焦 tiptap，进入输入 */
  docBox.addEventListener('click', () => { editor.commands.focus(); });
  const titleEl = host.querySelector('#ed-title') as HTMLElement;
  const propsEl = host.querySelector('#ed-props') as HTMLElement;
  const status = host.querySelector('#ed-status') as HTMLElement;
  const tabTl = host.querySelector('#ed-tab-tl') as HTMLElement;
  const tabEntity = host.querySelector('#ed-tab-entity') as HTMLElement;
  const imgBtn = host.querySelector('#ed-img') as HTMLElement;
  const h1Btn = host.querySelector('#ed-h1') as HTMLElement;
  let tab: 'tl' | 'entity' = 'tl';
  let currentTlId = '';
  let currentNodeId = '';
  let currentEntityId = '';
  /* 树展开状态（Obsidian 文件树）：世界 + 时间线 + 类型文件夹三级可展开/折叠 */
  const expandedWorlds = new Set<string>();
  const expandedTls = new Set<string>();
  const expandedKinds = new Set<string>();   /* key = ws::tl::kind */

  function setTab(t: 'tl' | 'entity') {
    tab = t;
    tabTl.style.background = t === 'tl' ? 'rgba(158,194,98,.15)' : 'none';
    tabEntity.style.background = t === 'entity' ? 'rgba(158,194,98,.15)' : 'none';
    renderSidebar();
  }

  function renderSidebar() {
    const ws = currentWorld(store);
    sidebar.innerHTML = '';
    if (tab === 'tl') {
      /* 世界 → 时间线 → 节点 三层树（Obsidian 风格，可展开/折叠） */
      const worlds = Object.keys(store.data.worldsets);
      const frag = document.createElement('div');
      frag.className = 'ed-tree';
      worlds.forEach((wName) => {
        const w = store.data.worldsets[wName];
        const wOpen = expandedWorlds.has(wName);
        const rec = document.createElement('div');
        rec.className = 'ed-tnode ed-tworld' + (wOpen ? ' is-open' : '');
        rec.dataset.kind = 'world';
        rec.dataset.path = wName;
        rec.innerHTML = `
          <span class="ed-tcaret"></span><span class="ed-tlabel">${escape(wName)}</span>
          <span class="ed-tcount">${(w.order ?? []).filter((id) => w.timelines[id]).length}</span>`;
        frag.appendChild(rec);
        if (wOpen) {
          (w.order ?? []).filter((id) => w.timelines[id]).forEach((tlId) => {
            const tl = w.timelines[tlId];
            const tOpen = expandedTls.has(wName + '::' + tlId);
            const tRec = document.createElement('div');
            tRec.className = 'ed-tnode ed-ttl' + (tOpen ? ' is-open' : '');
            tRec.dataset.kind = 'tl';
            tRec.dataset.world = wName;
            tRec.dataset.path = tlId;
            tRec.innerHTML = `
              <span class="ed-tcaret"></span><span class="ed-tlabel">${escape(tl?.name ?? '?')}</span>
              <span class="ed-tcount">${tl?.nodes?.length ?? 0}</span>`;
            frag.appendChild(tRec);
            if (tOpen && tl) {
              /* 按类型文件夹（kind）分组：世界 → 时间线 → [类型文件夹] → 节点 */
              const groups = new Map<string, any[]>();
              for (const n of tl.nodes ?? []) {
                const k = (n as any).kind || '事件';
                if (!groups.has(k)) groups.set(k, []);
                groups.get(k)!.push(n);
              }
              groups.forEach((nodes, k) => {
                const kOpen = expandedKinds.has(wName + '::' + tlId + '::' + k);
                const kRec = document.createElement('div');
                kRec.className = 'ed-tnode ed-tkind' + (kOpen ? ' is-open' : '');
                kRec.dataset.kind = 'tkind';
                kRec.dataset.world = wName;
                kRec.dataset.tl = tlId;
                kRec.dataset.path = k;
                kRec.innerHTML = `<span class="ed-tcaret"></span><span class="ed-tlabel">${escape(k)}</span><span class="ed-tcount">${nodes.length}</span>`;
                frag.appendChild(kRec);
                if (kOpen) {
                  nodes.forEach((n) => {
                    const nRec = document.createElement('div');
                    const isOn = n.id === currentNodeId && currentTlId === tlId;
                    nRec.className = 'ed-tnode ed-tnode-item' + (isOn ? ' is-on' : '');
                    nRec.dataset.kind = 'node';
                    nRec.dataset.world = wName;
                    nRec.dataset.tl = tlId;
                    nRec.dataset.path = n.id;
                    nRec.innerHTML = `<span class="ed-tlabel">${escape(n.title)}</span>`;
                    frag.appendChild(nRec);
                  });
                }
              });
            }
          });
        }
      });
      frag.querySelectorAll('.ed-tnode').forEach((el) => {
        el.addEventListener('click', () => {
          const kind = (el as HTMLElement).dataset.kind;
          if (kind === 'world') {
            const p = (el as HTMLElement).dataset.path!;
            if (expandedWorlds.has(p)) expandedWorlds.delete(p); else expandedWorlds.add(p);
            renderSidebar();
          } else if (kind === 'tl') {
            const w = (el as HTMLElement).dataset.world!;
            const p = (el as HTMLElement).dataset.path!;
            const key = w + '::' + p;
            if (expandedTls.has(key)) expandedTls.delete(key); else expandedTls.add(key);
            renderSidebar();
          } else if (kind === 'tkind') {
            const w = (el as HTMLElement).dataset.world!;
            const tl = (el as HTMLElement).dataset.tl!;
            const k = (el as HTMLElement).dataset.path!;
            const key = w + '::' + tl + '::' + k;
            if (expandedKinds.has(key)) expandedKinds.delete(key); else expandedKinds.add(key);
            renderSidebar();
          } else if (kind === 'node') {
            const w = (el as HTMLElement).dataset.world!;
            const tl = (el as HTMLElement).dataset.tl!;
            const id = (el as HTMLElement).dataset.path!;
            currentTlId = tl; currentNodeId = id;
            const node = store.data.worldsets[w]?.timelines[tl]?.nodes.find((x) => x.id === id);
            setDoc(node?.doc ?? '');
            renderProps(node ?? undefined);
            titleEl.textContent = node?.title ?? '';
            status.textContent = '失焦自动保存';
            /* 校验 #正文： 标签；提示条全局常驻（不清），提示里带文件名 */
            checkBodyTag(w, tl, id, node?.doc ?? '', node?.title ?? '');
            renderSidebar();
          }
        });
      });
      sidebar.appendChild(frag);
      return;
    }
    /* 实体 tab：类型 → 实体 树（可展开，同样去绿色字体） */
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
      renderProps(e ?? undefined, true);
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
    const frag = document.createElement('div');
    frag.className = 'ed-tree';
    Object.entries(types).forEach(([tid, t]) => {
      const eOpen = expandedTls.has('entity::' + tid);
      const tRec = document.createElement('div');
      tRec.className = 'ed-tnode ed-ttype' + (eOpen ? ' is-open' : '');
      tRec.dataset.kind = 'etype';
      tRec.dataset.path = tid;
      tRec.innerHTML = `<span class="ed-tcaret"></span><span class="ed-tlabel">${escape(t.name)}</span><span class="ed-tcount">${Object.values(entities).filter((e) => e.typeId === tid).length}</span>`;
      frag.appendChild(tRec);
      if (eOpen) {
        Object.values(entities).filter((e) => e.typeId === tid).forEach((e) => {
          const nRec = document.createElement('div');
          const isOn = e.id === currentEntityId;
          nRec.className = 'ed-tnode ed-tnode-item' + (isOn ? ' is-on' : '');
          nRec.dataset.kind = 'entity';
          nRec.dataset.path = e.id;
          nRec.innerHTML = `<span class="ed-tlabel">${escape(e.name)}</span>`;
          frag.appendChild(nRec);
        });
      }
    });
    frag.querySelectorAll('.ed-tnode').forEach((el) => {
      el.addEventListener('click', () => {
        const kind = (el as HTMLElement).dataset.kind;
        const path = (el as HTMLElement).dataset.path!;
        if (kind === 'etype') {
          const key = 'entity::' + path;
          if (expandedTls.has(key)) expandedTls.delete(key); else expandedTls.add(key);
          renderSidebar();
        } else if (kind === 'entity') {
          currentEntityId = path;
          const e = currentWorld(store).entities?.[path];
          setDoc(e?.doc ?? '');
          renderProps(e ?? undefined, true);
          titleEl.textContent = e?.name ?? '';
          status.textContent = '失焦自动保存';
          renderSidebar();
        }
      });
    });
    el.appendChild(frag);
  }

  /* 失焦保存：tiptap blur 时写回 markdown（vault 仍存 Obsidian markdown） */
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
  /* 标题按钮：把当前段落设为一级标题（tiptap setHeading，可靠所见即所得） */
  h1Btn.addEventListener('click', () => {
    editor.chain().focus().toggleHeading({ level: 1 }).run();
  });
  /* 插入图片：弹文件框 → 导入 vault assets → 在光标处插入 markdown 图片（所见即所得显示） */
  imgBtn.addEventListener('click', async () => {
    const api = (window as any).lingkuangAPI;
    if (!api?.importImage) return;
    const res = await api.importImage();
    if (res?.ok && res.path) {
      editor.chain().focus().setImage({ src: res.path, alt: '' }).run();
      status.textContent = '已插入图片 ✓';
    } else if (res?.canceled) {
      /* 用户取消，不提示 */
    } else {
      status.textContent = String(res?.error ?? '插入图片失败');
    }
  });
  store.subscribe(() => renderSidebar());
  setTab('tl');
}
