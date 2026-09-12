/** 编辑器模块——文稿编辑（时间线节点 + 实体，Obsidian 式 #字段：值）：
 * 左侧 sidebar（时间线 tab：时间线→节点；实体 tab：类型→实体），右侧编辑 doc（失焦保存） */
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import { saveNodeDoc, addEntity } from '../store/actions';
import type { PropValue, TimelineNode, Entity, Timeline, TimePrecision } from '../store/types';
import { PRECISION_ORDER, PRECISION_LABELS } from '../store/types';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { Image } from './image-ext';
import { Tag } from './tag-ext';
import { parseTimeText } from './node-form';
import { isImeEnter } from './keys';
import { toEpoch, fromEpoch, buildYearTable, calendarOf, timePointOf } from '../calendar';

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** AE 式 scrub：鼠标水平拖拽 / 滚轮垂直 调整数值，shift 加大步进；可聚焦直接输入。用于数值和日期属性。 */
function createScrubField(
  cfg: { value: number; step: number; format: (v: number) => string; onCommit: (v: number) => void; min?: number; inputValue?: (v: number) => string; parse?: (s: string) => number; onInputText?: (s: string) => void; }
): HTMLElement {
  /* 控件自己记住当前值：拖动/滚轮/输入之后要累加，否则每次滚轮都从**初始值**算起 ——
     表现为「滚第二格没反应」。属性面板里所有数值/日期 scrub 都受这个影响。 */
  let value = cfg.value;
  const el = document.createElement('span');
  el.style.cssText = 'flex:1;min-width:0;display:flex;align-items:center;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);cursor:ew-resize;user-select:none;';
  const label = document.createElement('span');
  label.style.cssText = 'flex:1;padding:3px 6px;font-size:var(--text-xs);color:var(--fg);font-family:var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  label.textContent = cfg.format(value);
  el.appendChild(label);
  let dragging = false, startX = 0, startV = value, shift = false, downX = 0, moved = false, editing = false, isDown = false;
  el.addEventListener('pointerdown', (e) => {
    if (editing) return; /* 编辑态：事件交给 input，不抢拖动/单击 */
    if (e.altKey) { startInput(); return; }
    isDown = true; dragging = false; moved = false; downX = e.clientX; startX = e.clientX; startV = value; shift = e.shiftKey;
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
    value = v;
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
    const v = clamp(value + dir * s);
    value = v;
    cfg.onCommit(v);
    label.textContent = cfg.format(v);
  }, { passive: false });
  /* 双击也保留（兼容点快时误判），与单击都进输入 */
  el.addEventListener('dblclick', (e) => { e.preventDefault(); startInput(); });
  function startInput() {
    const inp = document.createElement('input');
    inp.value = cfg.inputValue ? cfg.inputValue(value) : cfg.format(value);
    inp.style.cssText = 'flex:1;min-width:0;background:var(--surface);border:none;outline:none;color:var(--fg);font-size:var(--text-xs);font-family:var(--font-mono);padding:3px 6px;cursor:text;';
    editing = true;
    el.replaceChildren(inp);
    /* 不全选：单击进来直接落光标到末尾，立即可输入（免去"全选→取消全选"两步） */
    inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
    /* 回车提交并退出编辑；输入法组字期的回车是「上屏候选词」，不提交 */
    inp.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || isImeEnter(ev)) return;
      ev.preventDefault();
      inp.blur();
    });
    inp.addEventListener('blur', () => {
      editing = false;
      if (cfg.onInputText) { cfg.onInputText(inp.value); el.replaceChildren(label); return; }
      const n = cfg.parse ? cfg.parse(inp.value) : parseFloat(inp.value);
      if (!Number.isNaN(n)) { const v = clamp(n); value = v; cfg.onCommit(v); label.textContent = cfg.format(v); }
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

/* 刻度 → 人性化显示由「时间」那一行的 fmtPrec 按节点精度生成（见 renderProps），
   这里原先的 fmtYearDisplay 一律显示到「时」、不看精度，已删除。 */

/** 按属性类型生成值控件（数值/日期 scrub、布尔 checkbox、多选一列 checkbox、文本 input），change 回调对应 PropValue。
 *  live 用于数组控件：属性面板刻意不重渲染，若按构建时的快照 v 增删，
 *  连点两项时第二项会把第一项算回来（取消勾选 A → 存 [B,C]，再取消 B → 由旧 v 算出 [A,C]，A 复活）。 */
function buildPropCtrl(v: PropValue, onChange: (next: PropValue) => void, live?: () => PropValue): HTMLElement {
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
        /* 取消勾选 = 从列表移除该项。基于「最新值」算，而不是构建时的快照 */
        const cur = live ? live() : v;
        const arr = Array.isArray(cur) ? cur : v;
        const next = cb.checked ? [...arr, item] : arr.filter((x) => String(x) !== String(item));
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


export function renderEditor(store: Store, host: HTMLElement): () => void {
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
  /* 监听外部（Obsidian）对节点字段的增删 → 显示提示框。
     两个 window 监听都留了具名引用：切走工具时要 removeEventListener，
     否则每进一次编辑器就多积一对永久监听（它们持有本函数整个作用域）。 */
  const onVaultFields = ((e: Event) => {
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
  }) as EventListener;
  window.addEventListener('lingkuang-vault-field-changed', onVaultFields);
  /* 自动修复通知（已修好，告知 + 可选以后不再提示） */
  const onAutoFixed = ((e: Event) => {
    if (localStorage.getItem('lingkuang-hide-auto-fix-notice') === '1') return;
    const list = (e as CustomEvent<string[]>).detail || [];
    if (!list.length) return;
    addHint('autofix', `已自动修复：${list.join('、')} 的格式（已补回标准「#描述：」/「#正文：」标签）。格式只能在「结构体管理器」里调整，内容值随意。`, undefined, { text: '不再提示此类', onClick: () => { localStorage.setItem('lingkuang-hide-auto-fix-notice', '1'); removeHint('autofix'); } });
  }) as EventListener;
  window.addEventListener('lingkuang-vault-auto-fixed', onAutoFixed);
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
    /* 清理 tiptap 序列化的孤立 &nbsp; 空行（保留真实内容，去掉纯占位空行）。
       旧写法 /(^|\n)(\s*&nbsp;\s*)+\n?/g 里的 \s 会吃掉换行且是贪婪的，
       于是 "A\n\n&nbsp;\n\nB"（A 和 B 是两个段落）被压成 "A\nB" —— 段落分隔丢了。
       改成：只认「整行除 &nbsp; 外只有空格制表符」的占位行，删掉它并保留两侧换行，
       再把 3 个以上连续换行折回 markdown 里等价的两个（空段落本来就是段落分隔符）。 */
    return (editor.getMarkdown() || '')
      .replace(/(^|\n)[ \t]*(?:&nbsp;[ \t]*)+(?=\n|$)/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+/, '');
  }
  function setDoc(md: string): void {
    editor.commands.setContent(md || '', { contentType: 'markdown' });
  }

  /* ── 当前编辑目标 ──────────────────────────────────────────────
     target 绑定「文档框里现在装的是谁的内容」，并且带 world。它修掉两个坑：
     1) 旧实现按 tab + currentNodeId/currentEntityId 决定存到哪，而 setTab 既不重载
        文档也不清 id → 「节点 → 实体 tab → 回时间线 tab → 点空白」blur 时会把实体的
        正文写进节点正文（用户一个字都没改）；
     2) 侧栏遍历所有世界，保存却一律走 store.activeWorld → 编辑非活动世界的节点被
        静默丢弃（`if (n)` 直接 no-op），状态栏还显示「已保存 ✓」。 */
  type Target =
    | { kind: 'node'; world: string; tlId: string; nodeId: string }
    | { kind: 'entity'; world: string; entityId: string };
  let target: Target | null = null;
  /* 每个 tab 各记住上次打开的文档，切回来能恢复（且 target 与文档框内容始终一致） */
  const lastTarget: Record<'tl' | 'entity', Target | null> = { tl: null, entity: null };

  function targetNode(): TimelineNode | undefined {
    const t = target;
    if (!t || t.kind !== 'node') return undefined;
    return store.data.worldsets[t.world]?.timelines[t.tlId]?.nodes.find((x) => x.id === t.nodeId);
  }
  function targetEntity(): Entity | undefined {
    const t = target;
    if (!t || t.kind !== 'entity') return undefined;
    return store.data.worldsets[t.world]?.entities?.[t.entityId];
  }
  function targetTimeline(): Timeline | undefined {
    const t = target;
    if (!t || t.kind !== 'node') return undefined;
    return store.data.worldsets[t.world]?.timelines[t.tlId];
  }
  /** 就地改 target 指向的对象（走 store.update，用 target 自己的 world） */
  function patchTarget(fn: (o: TimelineNode | Entity) => void): void {
    const t = target;
    if (!t) return;
    store.update((d) => {
      const ws = d.worldsets[t.world];
      if (!ws) return;
      if (t.kind === 'node') {
        const n = ws.timelines[t.tlId]?.nodes.find((x) => x.id === t.nodeId);
        if (n) fn(n);
      } else {
        const e = ws.entities?.[t.entityId];
        if (e) fn(e);
      }
    });
  }
  function docOf(t: Target): string {
    const ws = store.data.worldsets[t.world];
    if (!ws) return '';
    return t.kind === 'node'
      ? ws.timelines[t.tlId]?.nodes.find((x) => x.id === t.nodeId)?.doc ?? ''
      : ws.entities?.[t.entityId]?.doc ?? '';
  }
  function titleOf(t: Target): string {
    const ws = store.data.worldsets[t.world];
    if (!ws) return '';
    return t.kind === 'node'
      ? ws.timelines[t.tlId]?.nodes.find((x) => x.id === t.nodeId)?.title ?? ''
      : ws.entities?.[t.entityId]?.name ?? '';
  }
  /** 把文档框内容落盘到 target（没有 target 就不写，避免把 A 的内容写给 B） */
  function flushDoc(): void {
    const t = target;
    if (!t) return;
    const md = getDocMd();
    if (t.kind === 'node') saveNodeDoc(store, t.tlId, t.nodeId, md, { world: t.world });
    else store.update((d) => { const e = d.worldsets[t.world]?.entities?.[t.entityId]; if (e) e.doc = md; });
    status.textContent = '已保存 ✓';
  }
  /* 属性面板（只读）：显示节点元数据 + #描述： + 已有自定义属性（结构化属性由世界沙盘管理，编辑器仅展示） */
  function renderProps(node: { title?: string; name?: string; year?: number | string; precision?: string; type?: string; desc?: string; properties?: Record<string, PropValue>; month?: number; day?: number; hour?: number; minute?: number; second?: number } | undefined, isEntity = false) {
    if (!node) { propsEl.style.display = 'none'; propsEl.innerHTML = ''; return; }
    propsEl.style.display = '';
    /* 自定义属性：可编辑（按类型控件），固定属性也用可编辑控件（年份 scrub、精度/类型下拉、标题/描述文本） */
    /* 面板构建后刻意不重渲染（避免销毁拖拽中的 scrub 控件），所以每次提交都要从 store
       取最新 properties 再合并——用构建时的 props 快照会让「改第二项」把「改第一项」覆盖回去 */
    const liveProps = (): Record<string, PropValue> => {
      const o = targetNode() ?? targetEntity();
      return o && o.properties ? o.properties : {};
    };
    const saveProp = (next: Record<string, PropValue>) => {
      patchTarget((o) => { o.properties = next; });
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
      row.appendChild(buildPropCtrl(v, (nv) => saveProp({ ...liveProps(), [k]: nv }), () => liveProps()[k]));
      const del = document.createElement('button'); del.textContent = '×'; del.title = '删除属性';
      del.style.cssText = 'flex-shrink:0;width:18px;height:18px;background:none;border:none;color:var(--fg-2);cursor:pointer;font-size:14px;';
      del.addEventListener('click', () => { const np = { ...liveProps() }; delete np[k]; saveProp(np); renderProps(node, isEntity); });
      row.appendChild(del);
      appendTo.appendChild(row);
    };
    /* 固定属性也改成可编辑：标题/描述文本、年份数值 scrub、精度/类型下拉；保存写回 node 字段 */
    const saveFixed = (patch: Record<string, string>) => {
      patchTarget((o) => {
        if ('name' in o) {   /* 实体：只有名称可改 */
          if (patch['名称'] !== undefined) o.name = patch['名称'];
          return;
        }
        for (const [k, v] of Object.entries(patch)) {
          if (k === '标题') o.title = v;
          else if (k === '时间') {
            const p = parseTimeText(v);
            o.year = (p?.year ?? parseFloat(v)) || 0;
            if (p) { o.precision = p.precision; o.month = p.month; o.day = p.day; o.hour = p.hour; o.minute = p.minute; o.second = p.second; }
          }
          else if (k === '精度') {
            /* 改精度必须连带补/清 month/day/hour/minute/second，规则与 src/ui/detail.ts 一致：
               变细补默认值（月/日 → 1，时/分/秒 → 0），变粗清成 undefined。
               否则「精度=年」的节点会留着上次的月/日 —— main.js 的 yearToDateStr 是「有才写」，
               照样写出 `312-07-15`，于是精度与数据互相矛盾（详情面板也因此显示「312年7月15日」）。 */
            const want = v as TimePrecision;
            const wi = PRECISION_ORDER.indexOf(want);
            o.precision = want;
            o.month = wi >= 1 ? (o.month ?? 1) : undefined;
            o.day = wi >= 2 ? (o.day ?? 1) : undefined;
            o.hour = wi >= 3 ? (o.hour ?? 0) : undefined;
            o.minute = wi >= 4 ? (o.minute ?? 0) : undefined;
            o.second = wi >= 5 ? (o.second ?? 0) : undefined;
          }
          else if (k === '类型') o.type = v as TimelineNode['type'];
          else if (k === '格式') o.kind = v || undefined;
          else if (k === '描述') o.desc = v;
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
        const tl = targetTimeline();
        const cal = calendarOf(tl ?? {});
        const daySec = cal.unit.minute * cal.unit.hour * cal.unit.day;
        const hourSec = cal.unit.minute * cal.unit.hour;
        const minuteSec = cal.unit.minute;
        const prec = (node.precision ?? 'year') as TimePrecision;
        const pi = Math.max(0, PRECISION_ORDER.indexOf(prec));
        /* 年表照契约传上（不传会退回逐年累加；内核已改成 O(1)，传了更快）。
           窗口取节点年附近即可 —— 拖动超出窗口也没关系，表只是加速，表外走闭式公式。 */
        const y0 = Math.floor(Number(node.year ?? 0));
        const table = buildYearTable(cal, y0 - 8, y0 + 8);
        const epoch = toEpoch(cal, timePointOf(Number(node.year ?? 0), { month: node.month, day: node.day, hour: node.hour, minute: node.minute, second: node.second }), table);
        /* 步长只用来把鼠标位移换算成「步数」（scrub 是「值 + 固定步长」的通用控件），
           真正的推进走下面的 stepTarget，所以这里取近似值不影响精度。
           ★ 刻度跟着**精度**走：旧写法一律按「天」，于是「年」精度的节点拖一格看不出变化，
           却把不存在的年月日写进了只有「年」的节点（312年 → 312-01-02）。 */
        const stepSec = pi === 0 ? Math.round(365.2425 * daySec)
          : pi === 1 ? Math.round((365.2425 * daySec) / 12)
            : pi === 2 ? daySec
              : pi === 3 ? hourSec
                : pi === 4 ? minuteSec
                  : 1;
        /* ★ 按「步数」在**历法**上推进，而不是在秒上累加固定步长：一年有 365/366 天，
           固定步长必然漂移 —— 曾用 365.2425 天当「一年」，碰上 366 天的闰年（312 年正是）
           连一格都推不动，年份纹丝不动。这也正是项目约定：日/月档要按真实日期推进。 */
        const stepTarget = (steps: number): number => {
          const tp0 = fromEpoch(cal, epoch, table);
          const v0 = tp0.values;
          if (pi === 0) return toEpoch(cal, timePointOf(tp0.anchor.year + steps, { month: v0.month, day: v0.day, hour: v0.hour, minute: v0.minute, second: v0.second }), table);
          if (pi === 1) {
            const mAbs = tp0.anchor.year * 12 + (v0.month - 1) + steps;
            return toEpoch(cal, timePointOf(Math.floor(mAbs / 12), { month: ((mAbs % 12) + 12) % 12 + 1, day: v0.day, hour: v0.hour, minute: v0.minute, second: v0.second }), table);
          }
          const per = pi === 2 ? daySec : pi === 3 ? hourSec : pi === 4 ? minuteSec : 1;
          return epoch + steps * per;
        };
        /* 显示与写回都只到**精度那一级**：
           ① 「精度=年」的节点不再显示成「312年1月1日」；
           ② 拖一下不会把已有的时/分/秒清掉（旧 onCommit 只拼年月日 → parseTimeText 判成「日」
              精度 → 把 hour/minute/second 置空，而精度字段又被覆盖回旧值 → 精度与数据矛盾）。 */
        const fmtPrec = (n: number): string => {
          const tp = fromEpoch(cal, n, table);
          const v = tp.values;
          let s = `${tp.anchor.year}年`;
          if (pi >= 1) s += `${v.month}月`;
          if (pi >= 2) s += `${v.day}日`;
          if (pi >= 3) s += `${v.hour}时`;
          if (pi >= 4) s += `${v.minute}分`;
          if (pi >= 5) s += `${v.second}秒`;
          return s;
        };
        /* 控件给的原始值 → 步数 → 历法目标：显示与写回都走它，
           保证「屏幕上的字」与「存进去的值」永远一致。 */
        const fmtByValue = (n: number): string => fmtPrec(stepTarget(Math.round((n - epoch) / stepSec)));
        ctrl = createScrubField({
          value: epoch, step: stepSec,
          format: fmtByValue,
          inputValue: fmtByValue, /* 输入框显示中文可读时间，parseTimeText 可解析 */
          onCommit: (n) => saveFixed({ 时间: fmtByValue(n), 精度: prec }),
          onInputText: (s) => { /* 手动输入：parseTimeText 自动识别精度（打字可以改精度） */
            const p = parseTimeText(s);
            if (p) {
              saveFixed({ 时间: s, 精度: p.precision });
              renderProps(targetNode());
            }
          },
        });
      } else if (k === '精度') {
        const sel = document.createElement('select');
        sel.style.cssText = 'flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-xs);outline:none;';
        /* 选项文字用中文（渲染层是全中文界面，之前直接显示 year/month/day… 很突兀） */
        PRECISION_ORDER.forEach((p) => { const o = document.createElement('option'); o.value = p; o.textContent = PRECISION_LABELS[p]; sel.appendChild(o); });
        sel.value = v; sel.addEventListener('change', () => {
          saveFixed({ 精度: sel.value });
          /* 改精度后重渲染面板，让时间 scrub 的显示/步进/输入跟随新精度 */
          renderProps(targetNode());
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
    if (t !== tab) flushDoc();   /* 切换前先把正在编辑的内容落盘，别丢改动 */
    tab = t;
    tabTl.style.background = t === 'tl' ? 'rgba(158,194,98,.15)' : 'none';
    tabEntity.style.background = t === 'entity' ? 'rgba(158,194,98,.15)' : 'none';
    /* 恢复该 tab 上次打开的文档。关键：target 必须与文档框内容严格一致——
       旧实现只切 tab 不重载文档也不清 id，文档框里留着上一个 tab 的内容，
       而 blur 按新 tab 的 id 保存 → 节点正文被实体正文覆盖。 */
    target = lastTarget[t];
    setDoc(target ? docOf(target) : '');
    if (target) titleEl.textContent = titleOf(target);
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
            target = { kind: 'node', world: w, tlId: tl, nodeId: id };
            lastTarget.tl = target;
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
      target = { kind: 'entity', world: store.activeWorld, entityId: id };
      lastTarget.entity = target;
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
          target = { kind: 'entity', world: store.activeWorld, entityId: path };
          lastTarget.entity = target;
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

  /* 失焦保存：tiptap blur 时写回 markdown（vault 仍存 Obsidian markdown）。
     一律按 target 存——target 是「文档框里现在装的那份文档」的身份（含 world），
     与当前 tab / 当前活动世界无关，所以既不会串文档，也不会在编辑非活动世界的
     节点时静默丢弃（后者旧实现还会照样显示「已保存 ✓」）。 */
  editor.on('blur', () => { if (target) flushDoc(); });

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
  const unsubSidebar = store.subscribe(() => renderSidebar());
  setTab('tl');
  /* 切走工具时的清理：先把未落的编辑交出去，再拆掉编辑器/订阅/全局监听。
     旧实现只由 registry.openTool 清 host.innerHTML，tiptap 实例、两个 window
     监听和 store 订阅都留在内存里，每点一次「编辑器」多积一份。 */
  return () => {
    if (target) flushDoc();
    unsubSidebar();
    window.removeEventListener('lingkuang-vault-field-changed', onVaultFields);
    window.removeEventListener('lingkuang-vault-auto-fixed', onAutoFixed);
    editor.destroy();
  };
}
