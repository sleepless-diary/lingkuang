/** 灵框 · 设定库（工作台）
 *
 * 目的（2026-09-12 用户拍板「合并方案 A」第 3 步）：编辑器和设定库过去各自实现了一遍
 * 「列条目 + 改字段 + 写正文」——同一件事做两遍，而且各缺一半（设定库写不了正文、编辑器
 * 没有类型筛选）。这个面板要长成**唯一的工作台**：
 *   左列 = 条目列表（「实体」与「时间线节点」两个页签 + 搜索框）
 *   中栏 = 档案字段（节点用 `src/ui/props-panel.ts` 的公共属性面板 —— 与编辑器**同一份实现**，
 *          不再有第三份「改字段」；实体仍走 `src/ui/fields.ts` 的模板字段控件）
 *   右栏 = 正文编辑器（`src/ui/doc-editor.ts`；实体与节点都落自己的 vault `.md`）
 *
 * 与「结构体管理」的分工：那个面板管**模板**（有哪些字段），这个面板管**内容**（字段的值）。
 * 模板是唯一权威（`src/main.ts` 的 ensureEntityLayer / ensureAllFormatFields 负责补空字段），
 * 所以这里的字段集合跟着模板走。
 *
 * ⚠️ 换条目（实体或节点）必须**先 flush 旧正文、再把选择改掉**（见 `switchTarget`）：
 * 顺序反了会把上一条的正文写进新选中的那一条。这一坑在编辑器里踩过（见 editor.ts 的注释）。
 */
import type { Store } from '../store/store';
import type { Entity, TimelineNode } from '../store/types';
import { currentWorld } from '../store/store';
import { addEntity, removeEntity } from '../store/actions';
import { confirmDialog } from './confirm';
import { escapeHtml } from './html';
import { fieldRow } from './fields';
import { createDocEditor, type DocEditor } from './doc-editor';
import { createPropsPanel, type PropsPanel } from './props-panel';
import { cascadeIn } from './motion';

const INP = 'flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 7px;font-size:var(--text-sm);outline:none;font-family:inherit;user-select:text;';

/** 节点身份（带 world —— 左列会列出**所有世界**的时间线，保存时必须写回它自己那个世界） */
interface NodeTarget { world: string; tlId: string; nodeId: string; }

export function renderCodex(store: Store, host: HTMLElement): () => void {
  host.style.overflow = 'hidden';
  let mode: 'entity' | 'node' = 'entity';
  let query = '';               /* 搜索词：实体按名字过滤，节点按标题过滤（非空时树摊平成列表） */
  let filterType = '';          /* 实体页签的类型筛选，'' = 全部 */
  let activeId = '';            /* 当前实体 */
  let nodeTarget: NodeTarget | null = null;   /* 当前节点 */
  let msgTimer: number | undefined;
  /* 正文编辑器（tiptap）。切换条目时必须先 flush 再 dispose —— 否则正在编辑的正文会丢，
     而 tiptap 实例不销毁会积 window 监听与订阅。 */
  let docEditor: DocEditor | null = null;
  /* 正文/面板**自身**的提交不要整块重渲染：否则每敲完一段失焦都会重建编辑器丢光标，
     拖拽中的 scrub 控件也会被销毁（props-panel 依赖这一点）。 */
  let quiet = false;
  /* 中/右栏的内容签名（见 bodySignature）。声明在这里而不是订阅旁边：
     render() 里要写它，而 render() 定义在前 —— 放后面会形成 TDZ。 */
  let bodySig = '';
  /* 显式切换（换条目 / 换页签）标记：只有它触发的中/右栏重建才播入场动画。
     store 订阅触发的重建（外部改 vault 回扫、字段提交后签名变化）**不播** ——
     否则改一个字段整块面板块淡入一次，看着像闪。 */
  let pendingEnter = false;
  /* 节点页签的树展开状态（世界 / 时间线 / 种类 三级，与编辑器同一套交互） */
  const expandedWorlds = new Set<string>();
  const expandedTls = new Set<string>();
  const expandedKinds = new Set<string>();

  const world = () => currentWorld(store);
  const types = () => world().entityTypes ?? {};
  const entities = (): Entity[] => Object.values(world().entities ?? {}) as Entity[];
  const typeName = (id: string): string => types()[id]?.name ?? id ?? '（无类型）';
  const active = (): Entity | undefined => world().entities?.[activeId];
  const match = (s: string | undefined): boolean => !query || String(s ?? '').toLowerCase().includes(query.toLowerCase());

  const filtered = (): Entity[] => entities()
    .filter((e) => (!filterType || e.typeId === filterType) && match(e.name))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));

  /* ── 节点页签的数据源：世界 → 时间线 → 种类分组（＝ vault 的目录形状）──────────
     刻意遍历**所有世界**（不只 activeWorld）：左列是一棵树，树就该看得见全部；
     nodeTarget 带 world，所以编辑非活动世界的节点也会写回它自己的世界。 */
  interface TlGroup { world: string; tlId: string; tlName: string; kinds: Map<string, TimelineNode[]>; }
  function tlGroups(): TlGroup[] {
    const out: TlGroup[] = [];
    for (const [wName, w] of Object.entries(store.data.worldsets)) {
      for (const tlId of (w.order ?? [])) {
        const tl = w.timelines[tlId];
        if (!tl) continue;
        const kinds = new Map<string, TimelineNode[]>();
        for (const n of tl.nodes ?? []) {
          const k = n.kind || '事件';
          if (!kinds.has(k)) kinds.set(k, []);
          kinds.get(k)!.push(n);
        }
        out.push({ world: wName, tlId, tlName: tl.name, kinds });
      }
    }
    return out;
  }
  const nodeCount = (): number => tlGroups().reduce((n, g) => n + [...g.kinds.values()].reduce((m, l) => m + l.length, 0), 0);
  const activeNode = (): TimelineNode | undefined => {
    const t = nodeTarget;
    if (!t) return undefined;
    return store.data.worldsets[t.world]?.timelines[t.tlId]?.nodes.find((x) => x.id === t.nodeId);
  };
  /** 搜索命中的节点（摊平）：带上它属于哪个世界/时间线/种类，列表里要显示 */
  function searchNodes(): { world: string; tlId: string; tlName: string; kind: string; node: TimelineNode }[] {
    const out: { world: string; tlId: string; tlName: string; kind: string; node: TimelineNode }[] = [];
    for (const g of tlGroups()) {
      for (const [kind, list] of g.kinds) {
        for (const node of list) {
          if (match(node.title)) out.push({ world: g.world, tlId: g.tlId, tlName: g.tlName, kind, node });
        }
      }
    }
    return out;
  }

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
  /** 就地改 target 指向的节点（用 nodeTarget 自己的 world，不回退 activeWorld）。 */
  function patchNode(fn: (n: TimelineNode) => void): void {
    const t = nodeTarget;
    if (!t) return;
    store.update((d) => {
      const n = d.worldsets[t.world]?.timelines[t.tlId]?.nodes.find((x) => x.id === t.nodeId);
      if (n) fn(n);
    });
  }
  /** 把正文写回**指定**目标（不是「当前选中的」）—— 关闭时调用也不会串文档。 */
  function writeDoc(t: { kind: 'entity'; id: string } | { kind: 'node'; world: string; tlId: string; nodeId: string }, md: string): void {
    quiet = true;
    try {
      if (t.kind === 'entity') {
        store.update((d) => { const e = d.worldsets[store.activeWorld]?.entities?.[t.id]; if (e) e.doc = md; });
      } else {
        store.update((d) => {
          const n = d.worldsets[t.world]?.timelines[t.tlId]?.nodes.find((x) => x.id === t.nodeId);
          if (n) n.doc = md;
        });
      }
    } finally { quiet = false; }
  }

  /** 换目标（换条目 / 换页签）：**先把正文结算掉再改选择**。
   *  反过来的话，`render()` 开头那次 flush 会把旧条目的正文写进新选中的条目 —— 实测过的坑。 */
  function switchTarget(mutate: () => void): void {
    if (docEditor) { docEditor.flush(); docEditor.dispose(); docEditor = null; }
    mutate();
    pendingEnter = true;   /* 这是用户主动切换：render() 播一次入场 */
    render();
  }

  const tabBtn = (id: string, label: string, on: boolean): string =>
    `<button id="${id}" class="lk-cx-tab" style="background:${on ? 'var(--accent)' : 'var(--surface-2)'};color:${on ? 'var(--accent-on)' : 'var(--fg)'};border:1px solid ${on ? 'var(--accent)' : 'var(--border)'};border-radius:var(--radius-pill);padding:3px 12px;font-size:var(--text-xs);cursor:pointer;">${escapeHtml(label)}</button>`;

  function render(): void {
    /* 切条目 / 换页签 / 重渲染前先把正文结算掉（未失焦的编辑也在里面），再销毁旧实例 */
    if (docEditor) { docEditor.flush(); docEditor.dispose(); docEditor = null; }
    /* 目标没了（外部删掉 / 换世界）→ 清掉，免得面板显示一条不存在的数据 */
    if (nodeTarget && !activeNode()) nodeTarget = null;
    const isEntity = mode === 'entity';
    const cur = isEntity ? active() : undefined;
    if (isEntity && (!cur || !filtered().some((e) => e.id === activeId))) activeId = filtered()[0]?.id ?? '';
    const kinds = Object.keys(types());
    const mainEnt = (): string => {
      const e = active();
      if (!e) return '<div style="font-size:var(--text-xs);color:var(--fg-2);">左边选一个实体看图。</div>';
      return `
        <div style="display:flex;align-items:center;gap:8px;">
          <input id="cx-name" value="${escapeHtml(e.name)}" style="${INP}font-size:15px;font-weight:600;"/>
          <span style="font-size:var(--text-xs);color:var(--fg-2);flex-shrink:0;">类型</span>
          <select id="cx-type" style="flex-shrink:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-xs);outline:none;">${kinds.map((k) => `<option value="${escapeHtml(k)}"${k === e.typeId ? ' selected' : ''}>${escapeHtml(typeName(k))}</option>`).join('')}</select>
          <button id="cx-del" style="margin-left:auto;flex-shrink:0;background:transparent;border:1px solid var(--danger);color:var(--danger);border-radius:var(--radius-sm);padding:3px 10px;font-size:var(--text-xs);cursor:pointer;">删除</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:5px;margin-top:10px;border-top:1px dashed var(--border-soft);padding-top:10px;">
          <div id="cx-fields" style="display:flex;flex-direction:column;gap:5px;"></div>
        </div>
        <div style="margin-top:10px;border-top:1px dashed var(--border-soft);padding-top:10px;">
          <div style="font-size:10px;color:var(--fg-2);margin-bottom:4px;">正文（Markdown · 失焦自动保存 · 落在 vault 的 <code>_设定/&lt;类型&gt;/&lt;名字&gt;.md</code>）</div>
          <div id="cx-doc"></div>
        </div>`;
    };
    const mainNode = (): string => {
      const t = nodeTarget;
      const n = activeNode();
      if (!t || !n) return '<div style="font-size:var(--text-xs);color:var(--fg-2);">左边选一个时间线节点看图。</div>';
      const tlName = store.data.worldsets[t.world]?.timelines[t.tlId]?.name ?? t.tlId;
      const kind = n.kind || '事件';
      return `
        <div style="font-size:var(--text-xs);color:var(--fg-2);margin-bottom:8px;">${escapeHtml(t.world)} · ${escapeHtml(tlName)} · ${escapeHtml(kind)}</div>
        <div id="cx-props" style="display:flex;flex-direction:column;gap:5px;"></div>
        <div style="margin-top:10px;border-top:1px dashed var(--border-soft);padding-top:10px;">
          <div style="font-size:10px;color:var(--fg-2);margin-bottom:4px;">正文（Markdown · 失焦自动保存）</div>
          <div id="cx-doc"></div>
        </div>`;
    };
    const newCtl = isEntity && kinds.length
      ? `<select id="cx-new-type" title="新实体的类型" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 6px;font-size:var(--text-xs);outline:none;">${kinds.map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(typeName(k))}</option>`).join('')}</select>
         <button id="cx-new" style="background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-sm);padding:6px 14px;font-size:var(--text-xs);cursor:pointer;">＋新建实体</button>`
      : '';

    host.innerHTML = `
      <div style="max-width:1020px;margin:0 auto;padding:18px 16px;display:flex;flex-direction:column;gap:10px;height:100%;overflow:auto;" id="cx-root">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <div style="font-size:17px;font-weight:600;color:var(--fg);">设定库</div>
          <span style="font-size:var(--text-xs);color:var(--fg-2);">「${escapeHtml(store.activeWorld || '（未选世界）')}」的条目 · 字段由模板决定（在左栏「结构体管理」里改模板）</span>
          <span style="margin-left:auto;display:flex;gap:6px;align-items:center;">${newCtl}</span>
        </div>
        <div style="display:flex;gap:4px;align-items:center;">
          ${tabBtn('cx-tab-entity', `实体 ${entities().length}`, isEntity)}
          ${tabBtn('cx-tab-node', `时间线节点 ${nodeCount()}`, !isEntity)}
          <span style="font-size:var(--text-xs);color:var(--fg-2);margin-left:6px;">${isEntity ? '写设定条目' : '写时间线上的事件节点'}</span>
        </div>
        <div style="display:flex;gap:12px;align-items:flex-start;">
          <div style="width:250px;flex-shrink:0;display:flex;flex-direction:column;gap:6px;border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px;">
            <input id="cx-search" placeholder="${isEntity ? '搜索实体…' : '搜索节点…'}" style="${INP}" value="${escapeHtml(query)}"/>
            <div id="cx-chips" style="display:flex;gap:4px;flex-wrap:wrap;"></div>
            <div id="cx-list" style="display:flex;flex-direction:column;gap:3px;"></div>
          </div>
          <div style="flex:1;min-width:0;border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;">
            ${isEntity ? mainEnt() : mainNode()}
          </div>
        </div>
        <div id="cx-msg" style="font-size:var(--text-xs);"></div>
      </div>`;

    renderList();

    /* 切换才播入场（见 pendingEnter 的说明）。用**一次性错峰**而不是整块淡入 ——
       整块淡入会让整个面板"洗白一下"，还盖掉元素自己的错峰。两级：
       ① 顶层块：标题行 → 页签行 → 三栏主体 → 提示行；
       ② 左列条目：等主体那块到位（200ms）之后逐条浮现。
       store 订阅触发的重建仍然不播，避免改个字段就闪一下。 */
    if (pendingEnter) {
      pendingEnter = false;
      cascadeIn(host.querySelector<HTMLElement>('#cx-root'));
      cascadeIn(host.querySelector<HTMLElement>('#cx-list'), 60, 420, 200);
    }

    /* ── 事件 ── */
    host.querySelector('#cx-tab-entity')?.addEventListener('click', () => switchTarget(() => { mode = 'entity'; query = ''; }));
    host.querySelector('#cx-tab-node')?.addEventListener('click', () => switchTarget(() => { mode = 'node'; query = ''; }));
    /* 搜索：只重画左列（**不重建整块**）—— 否则每敲一个字都会被重建的输入框丢焦点 */
    host.querySelector('#cx-search')?.addEventListener('input', (ev) => {
      query = (ev.target as HTMLInputElement).value;
      renderList();
    });
    host.querySelector('#cx-new')?.addEventListener('click', () => {
      const sel = host.querySelector('#cx-new-type') as HTMLSelectElement | null;
      const typeId = sel?.value ?? '';
      if (!typeId) return;
      const id = addEntity(store, { typeId, name: '新实体' });
      switchTarget(() => { activeId = id; });
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
    /* 实体字段行（公共控件 `src/ui/fields.ts`）：模板声明的类型决定控件形态 */
    const fieldsHost = host.querySelector('#cx-fields') as HTMLElement | null;
    const e = active();
    if (fieldsHost && e) {
      const t = types()[e.typeId];
      if (!(t?.fields ?? []).length) {
        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:var(--text-xs);color:var(--fg-2);';
        hint.textContent = '这个类型还没有字段 —— 到左栏「结构体管理」的“实体类型”里加。';
        fieldsHost.appendChild(hint);
      }
      for (const f of t?.fields ?? []) {
        fieldsHost.appendChild(fieldRow(f, e.properties?.[f.name], (v) => {
          patchEntity((ent) => { ent.properties = { ...(ent.properties ?? {}), [f.name]: v }; });
          say('已保存 ✓');
        }));
      }
    }
    /* 节点：中栏用**公共属性面板**（与编辑器同一份实现，含标题/时间历法 scrub/精度/种类/描述 + 种类字段） */
    const propsHost = host.querySelector('#cx-props') as HTMLElement | null;
    if (propsHost && nodeTarget) {
      const panel: PropsPanel = createPropsPanel({
        store,
        host: propsHost,
        status: null,
        getTarget: () => (nodeTarget ? { kind: 'node', ...nodeTarget } : null),
        /* 面板自己的提交走 quiet（不整块重渲染 —— 拖拽中的 scrub 控件不能被销毁），
           但左列的标题要跟着变，所以单独重画一次列表。 */
        patchTarget: (fn) => {
          quiet = true;
          try { patchNode(fn); say('已保存 ✓'); } finally { quiet = false; }
          renderList();
        },
      });
      panel.render(activeNode(), false);
    }
    /* 正文：真编辑器（tiptap）。**写回创建时就捕获的目标**，不是「当前选中的那个」——
       这样即便选择已经变了，内容也不会串到别的条目上。 */
    const docHost = host.querySelector('#cx-doc') as HTMLElement | null;
    if (docHost && (isEntity ? !!active() : !!nodeTarget)) {
      const myTarget: { kind: 'entity'; id: string } | { kind: 'node'; world: string; tlId: string; nodeId: string } =
        isEntity ? { kind: 'entity', id: activeId } : { kind: 'node', ...(nodeTarget as NodeTarget) };
      docEditor = createDocEditor(docHost, (md) => {
        writeDoc(myTarget, md);
        /* 正文落盘后左列不用重画（标题没变），也不该整块重渲染（会丢光标） */
      });
      docEditor.setDoc((isEntity ? active()?.doc : activeNode()?.doc) ?? '');
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
        switchTarget(() => { activeId = ''; });
        say('已删除');
      });
    });
    /* 骨架重建完就把签名对齐，免得下一次 store 变化因为签名过期而白重建一次 */
    bodySig = bodySignature();
  }

  /** 中/右栏「该显示什么」的内容签名（目标身份 + 字段 + 正文）。
   *  订阅里**只有它变了才重建** —— 理由见 unsub 处的长注释。 */
  function bodySignature(): string {
    /* 带上 activeWorld：骨架里的标题（「XX」的条目）与中栏取的实体都跟着它走，
       换世界必须重建，否则留着上一个世界的名字。 */
    const w = store.activeWorld ?? '';
    if (mode === 'entity') {
      const e = active();
      const kindList = Object.keys(types()).join(',');
      if (!e) return ['entity', w, 'none', kindList].join('|');
      return ['entity', w, e.id, e.typeId ?? '', e.name, JSON.stringify(e.properties ?? {}), e.doc ?? '', kindList].join('|');
    }
    if (!nodeTarget) return ['node', w, 'none'].join('|');
    const n = activeNode();
    if (!n) return ['node', w, nodeTarget.world, nodeTarget.tlId, nodeTarget.nodeId, 'gone'].join('|');
    return ['node', w, nodeTarget.world, nodeTarget.tlId, nodeTarget.nodeId,
      n.title, n.year, n.precision, n.type, n.kind ?? '',
      JSON.stringify(n.properties ?? {}), n.desc ?? '', n.doc ?? ''].join('|');
  }

  /** 两个页签上的计数在**骨架**里（不在 renderList 里）—— 单独刷，别为它重建整块。 */
  function updateTabCounts(): void {
    const b1 = host.querySelector('#cx-tab-entity');
    const b2 = host.querySelector('#cx-tab-node');
    if (b1) b1.textContent = `实体 ${entities().length}`;
    if (b2) b2.textContent = `时间线节点 ${nodeCount()}`;
  }

  /** 只重画左列（chips + 列表/树）。搜索框在它外面，所以打字不会被重建、不丢焦点。 */
  function renderList(): void {
    const chipsEl = host.querySelector('#cx-chips') as HTMLElement | null;
    const listEl = host.querySelector('#cx-list') as HTMLElement | null;
    if (!chipsEl || !listEl) return;

    if (mode === 'entity') {
      const kinds = Object.keys(types());
      chipsEl.innerHTML = [{ id: '', label: `全部 ${entities().length}` }]
        .concat(kinds.map((k) => ({ id: k, label: `${typeName(k)} ${entities().filter((e) => e.typeId === k).length}` })))
        .map((c) => `<button data-cx-filter="${escapeHtml(c.id)}" style="background:${filterType === c.id ? 'var(--accent)' : 'var(--surface-2)'};color:${filterType === c.id ? 'var(--accent-on)' : 'var(--fg)'};border:1px solid ${filterType === c.id ? 'var(--accent)' : 'var(--border)'};border-radius:var(--radius-pill);padding:3px 10px;font-size:var(--text-xs);cursor:pointer;">${escapeHtml(c.label)}</button>`)
        .join('');
      const list = filtered();
      listEl.innerHTML = list.length
        ? list.map((e) => `<button data-cx-id="${escapeHtml(e.id)}" style="display:flex;align-items:center;gap:6px;width:100%;text-align:left;background:${e.id === activeId ? 'var(--surface-2)' : 'transparent'};border:1px solid ${e.id === activeId ? 'var(--border)' : 'transparent'};border-radius:var(--radius-sm);color:var(--fg);padding:5px 8px;font-size:var(--text-sm);cursor:pointer;">
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(e.name || '(未命名)')}</span>
            <span style="font-size:10px;color:var(--fg-2);">${escapeHtml(typeName(e.typeId))}</span>
          </button>`).join('')
        : `<div style="font-size:var(--text-xs);color:var(--fg-2);padding:4px;">${query ? '没有匹配的实体。' : '还没有实体。右上角选类型后点「＋新建实体」。'}</div>`;
      chipsEl.querySelectorAll<HTMLElement>('[data-cx-filter]').forEach((el) => {
        el.addEventListener('click', () => { filterType = el.dataset.cxFilter ?? ''; renderList(); });
      });
      listEl.querySelectorAll<HTMLElement>('[data-cx-id]').forEach((el) => {
        el.addEventListener('click', () => { switchTarget(() => { activeId = el.dataset.cxId ?? ''; }); });
      });
      return;
    }

    /* ── 节点页签 ──────────────────────────────────────────────────
       搜索非空 → 摊平成一条条命中（带上它属于哪个世界/时间线/种类）；
       否则 → 世界 → 时间线 → 种类 → 节点 四级树（复用 style.css 的 .ed-* 样式）。 */
    chipsEl.innerHTML = '';
    const frag = document.createElement('div');
    frag.className = 'ed-tree';
    const row = (cls: string, html: string, ds: Record<string, string>): HTMLElement => {
      const d = document.createElement('div');
      d.className = 'ed-tnode ' + cls;
      d.innerHTML = html;
      for (const [k, v] of Object.entries(ds)) d.dataset[k] = v;
      return d;
    };
    if (query) {
      const hits = searchNodes();
      if (!hits.length) {
        listEl.innerHTML = '<div style="font-size:var(--text-xs);color:var(--fg-2);padding:4px;">没有匹配的节点。</div>';
        return;
      }
      hits.forEach((h) => {
        const on = !!nodeTarget && nodeTarget.world === h.world && nodeTarget.tlId === h.tlId && nodeTarget.nodeId === h.node.id;
        frag.appendChild(row('ed-tnode-item' + (on ? ' is-on' : ''),
          `<span class="ed-tlabel">${escapeHtml(h.node.title)}</span><span class="ed-tcount">${escapeHtml(h.kind)}</span>`,
          { act: 'node', nw: h.world, ntl: h.tlId, nid: h.node.id }));
      });
    } else {
      const groups = tlGroups();
      if (!groups.length) {
        listEl.innerHTML = '<div style="font-size:var(--text-xs);color:var(--fg-2);padding:4px;">还没有时间线。</div>';
        return;
      }
      for (const g of groups) {
        const wOpen = expandedWorlds.has(g.world);
        frag.appendChild(row('ed-tworld' + (wOpen ? ' is-open' : ''),
          `<span class="ed-tcaret"></span><span class="ed-tlabel">${escapeHtml(g.world)}</span>`,
          { act: 'world', nw: g.world }));
        if (!wOpen) continue;
        const tlKey = g.world + '::' + g.tlId;
        const tOpen = expandedTls.has(tlKey);
        const total = [...g.kinds.values()].reduce((n, l) => n + l.length, 0);
        frag.appendChild(row('ed-ttl' + (tOpen ? ' is-open' : ''),
          `<span class="ed-tcaret"></span><span class="ed-tlabel">${escapeHtml(g.tlName)}</span><span class="ed-tcount">${total}</span>`,
          { act: 'tl', nw: g.world, ntl: g.tlId }));
        if (!tOpen) continue;
        for (const [kind, nodes] of g.kinds) {
          const kKey = tlKey + '::' + kind;
          const kOpen = expandedKinds.has(kKey);
          frag.appendChild(row('ed-tkind' + (kOpen ? ' is-open' : ''),
            `<span class="ed-tcaret"></span><span class="ed-tlabel">${escapeHtml(kind)}</span><span class="ed-tcount">${nodes.length}</span>`,
            { act: 'tkind', nw: g.world, ntl: g.tlId, nk: kind }));
          if (!kOpen) continue;
          for (const n of nodes) {
            const on = !!nodeTarget && nodeTarget.world === g.world && nodeTarget.tlId === g.tlId && nodeTarget.nodeId === n.id;
            frag.appendChild(row('ed-tnode-item' + (on ? ' is-on' : ''),
              `<span class="ed-tlabel">${escapeHtml(n.title)}</span>`,
              { act: 'node', nw: g.world, ntl: g.tlId, nid: n.id }));
          }
        }
      }
    }
    listEl.innerHTML = '';
    listEl.appendChild(frag);
    frag.querySelectorAll<HTMLElement>('.ed-tnode').forEach((el) => {
      el.addEventListener('click', () => {
        const ds = el.dataset;
        if (ds.act === 'world') {
          const k = ds.nw!;
          if (expandedWorlds.has(k)) expandedWorlds.delete(k); else expandedWorlds.add(k);
          renderList();
        } else if (ds.act === 'tl') {
          const k = ds.nw + '::' + ds.ntl;
          if (expandedTls.has(k)) expandedTls.delete(k); else expandedTls.add(k);
          renderList();
        } else if (ds.act === 'tkind') {
          const k = ds.nw + '::' + ds.ntl + '::' + ds.nk;
          if (expandedKinds.has(k)) expandedKinds.delete(k); else expandedKinds.add(k);
          renderList();
        } else if (ds.act === 'node') {
          switchTarget(() => { nodeTarget = { world: ds.nw!, tlId: ds.ntl!, nodeId: ds.nid! }; });
        }
      });
    });
  }

  let torn = false;
  const unsub = store.subscribe(() => {
    if (torn) return;
    if (!host.isConnected || !host.querySelector('#cx-root')) { unsub(); return; }
    /* 左列照旧重画：那一列没有编辑器，重建只花 DOM 钱，而且实体/节点增删必须立刻反映 */
    updateTabCounts();
    renderList();
    /* ★ 中/右栏按**内容签名**决定要不要重建 —— 这是本节最容易踩的坑：
       自动落盘 → vault watcher 回扫 → store.update 这条链**每次编辑后约 360ms 都会走到
       这里一次**（实测：改「描述」落盘 t=1234ms，正文编辑器被换掉 t=1597ms）。
       而 render() 开头会 flush + dispose 掉 tiptap 再新建一个，于是在正文里打字时
       编辑器每隔几秒就被换一次 DOM：**恰好落在换的那一瞬的击键/焦点/IME 组合状态会丢**
       （codex-node-tab 的 ★11 「改正文落进 .md」就是这么间歇性失败的 —— 不是测试写错，
       真人打字一样会丢）。签名没变 = 屏幕上该显示的东西没变 = 编辑器没必要动。
       面板自己的提交（quiet）同样跳过，理由同前：拖拽中的 scrub 控件不能被销毁；
       但签名要跟上，否则下一次真正的外部改动会被漏掉。 */
    const sig = bodySignature();
    if (quiet) { bodySig = sig; return; }
    if (sig !== bodySig) render();
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
