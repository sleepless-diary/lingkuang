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
 *
 * ⚠️ 同模式内换条目走**就地换内容**（见 `swapBody`），不再整块 `render()`：整块重建会把骨架
 * 重造一遍（左列重播错峰、滚动位置回顶、tiptap 被销毁再新建）——用户对它的描述是
 * 「点击实体会刷新界面」（2026-09-13）。
 */
import type { Store } from '../store/store';
import type { Entity, EntityFrame, TimelineNode } from '../store/types';
import { currentWorld } from '../store/store';
import { addEntity, removeEntity } from '../store/actions';
import { confirmDialog } from './confirm';
import { escapeHtml } from './html';
import { fieldRow } from './fields';
import { createDocEditor, type DocEditor } from './doc-editor';
import { createPropsPanel, type PropsPanel } from './props-panel';
import { createEvolutionRail, type Rail } from './evolution-rail';
import { loadSettings } from './settings';
import {
  epochOfNodes, frameDiff, nearestVersion, normalizeFrames, statesOf, versionAtNode, type EntityState,
} from '../store/evolution';
import { cascadeIn, enter } from './motion';

const INP = 'flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 7px;font-size:var(--text-sm);outline:none;font-family:inherit;user-select:text;';

/** 正文写回哪个目标（编辑器跨条目复用，目标会变，所以是**读时取值**不是创建时捕获）。
 *  安全性由 `switchTarget` 保证：它一定先 `flush()`（此时 docTarget 还是旧目标）再改 docTarget。 */
type DocTarget = { kind: 'entity'; id: string } | { kind: 'node'; world: string; tlId: string; nodeId: string };

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
  /* 正文编辑器（tiptap）。**整块重建时**必须先 flush 再 dispose —— 否则正在编辑的正文会丢，
     而 tiptap 实例不销毁会积 window 监听与订阅。同模式内换条目则**留着它**（见 swapBody）。 */
  let docEditor: DocEditor | null = null;
  /* 编辑器当前指向谁（读写都在 DocTarget 的类型注释里说明） */
  let docTarget: DocTarget | null = null;
  /* 节点中栏的公共属性面板（与编辑器共用同一份实现）。同模式内换节点直接复用它 ——
     面板从 getTarget()+store 推导目标，所以换个 nodeTarget 再 render 就是新节点。 */
  let propsPanel: PropsPanel | null = null;
  /* 现在的骨架是按哪个页签建出来的：与 mode 不一致就说明得整块重来（中栏结构不同） */
  let renderedMode: 'entity' | 'node' | null = null;
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
  /* ── 演变（版本历史，2026-09-13）─────────────────────────────────
     中/右栏显示的**不是实体身上那一份**，而是「你现在站在哪个事件上看它」那一版：
     `statesOf(实体)` 一次算出初稿 + 每一帧之后的全部样子，换版本就是换个下标取数组（O(1)）。
     `railNode` = 选中的锚点节点（null = 初稿那一格）；`railKey` = 这个选择属于哪条实体，
     换实体要重挑默认值（用户指定：**离沙盘时间指针最近的那一帧**）。 */
  let railNode: string | null = null;
  let railKey = '';
  let rail: Rail | null = null;
  let states: EntityState[] = [];
  let statesId = '';
  /* 节点 epoch 按世界缓存（拖帧条、每次改字段都要查，不该每次重算年表） */
  let epochWorld = '';
  let epochCache: Map<string, number> = new Map();
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

  /** 就地改 target 指向的节点（用 nodeTarget 自己的 world，不回退 activeWorld）。 */
  function patchNode(fn: (n: TimelineNode) => void): void {
    const t = nodeTarget;
    if (!t) return;
    store.update((d) => {
      const n = d.worldsets[t.world]?.timelines?.[t.tlId]?.nodes.find((x) => x.id === t.nodeId);
      if (n) fn(n);
    });
  }

  /* ── 演变：版本、物化、写回 ─────────────────────────────────────── */

  /** 静默提交（不触发整块重渲染）。**保存并恢复**旧值而不是无脑置 false —— 这几段会互相嵌套
   *  （写正文 → 提交某一版），无脑置 false 会在里层提前解除静默，让整块面板重建一次。 */
  function withQuiet(fn: () => void): void {
    const was = quiet;
    quiet = true;
    try { fn(); } finally { quiet = was; }
  }

  /** 节点 epoch（键 = 节点 id）。按世界缓存。 */
  function epochMap(): Map<string, number> {
    const w = store.activeWorld ?? '';
    if (w !== epochWorld) { epochWorld = w; epochCache = epochOfNodes(currentWorld(store) as any); }
    return epochCache;
  }
  const epochOf = (id: string): number => epochMap().get(id) ?? 0;

  /** 左列/右栏要显示的节点（带它属于哪条时间线） */
  function findNode(nodeId: string): { node: TimelineNode; tlId: string } | undefined {
    for (const tlId of currentWorld(store).order ?? []) {
      const n = currentWorld(store).timelines?.[tlId]?.nodes?.find((x) => x.id === nodeId);
      if (n) return { node: n, tlId };
    }
    return undefined;
  }

  /** 换实体时重挑锚点。锁定模式钉在锁定那一格；否则 = **离沙盘时间指针最近的那一帧**
   *  （用户 2026-09-13 指定），一帧都没有就落到初稿。顺便把物化结果算好、把帧按时间排好。 */
  function ensureRailSelection(): void {
    const e = active();
    if (!e) { railNode = null; railKey = ''; states = []; statesId = ''; return; }
    const st = loadSettings();
    const lock = st.evolveLock;
    if (st.evolveMode === 'locked' && lock && lock.world === store.activeWorld && findNode(lock.nodeId)) {
      railNode = lock.nodeId;
    } else if (railKey !== e.id) {
      const cursor = Number((currentWorld(store) as any).timeCursor ?? 0);
      const v = nearestVersion(e, epochOf, cursor);
      railNode = v > 0 ? ((e.frames ?? [])[v - 1]?.nodeId ?? null) : null;
    }
    railKey = e.id;
    /* 帧按锚点时间排序（同一个节点只留一帧）。就地整理**不写回**：写回由 store.update 那条路做 */
    normalizeFrames(e, epochOf);
    states = statesOf(e);
    statesId = e.id;
  }

  /** 现在看的是第几版：0 = 初稿，k = 第 k 帧之后 */
  function entityVersion(): number {
    const e = active();
    if (!e || railNode === null) return 0;
    return versionAtNode(e, epochOf, epochOf(railNode), railNode);
  }

  /** 现在看到的这一版的样子（中栏字段 / 正文都从这里取，不再直接读实体身上的初稿） */
  function viewState(): EntityState | undefined {
    const e = active();
    if (!e) return undefined;
    if (statesId !== e.id) { states = statesOf(e); statesId = e.id; }
    return states[Math.max(0, Math.min(states.length - 1, entityVersion()))];
  }

  /** 把「某一版的样子」写回去：v=0 改实体自己（初稿），v≥1 改那一帧的差异。
   *  ⚠️ 差异是**用前后两版重新算出来的**（`frameDiff(states[v-1], next)`），不做增量记账 ——
   *  这样改任何一版都只动那一帧，后面各帧的差异天然跟着重放，不会算错。 */
  function commitState(v: number, next: EntityState): void {
    const prev = states[v - 1];
    withQuiet(() => {
      store.update((d) => {
        const ent = d.worldsets[store.activeWorld]?.entities?.[activeId];
        if (!ent) return;
        if (v === 0) {
          ent.name = next.name;
          ent.typeId = next.typeId;
          ent.properties = next.properties;
          ent.doc = next.doc;
          return;
        }
        const fr = ent.frames?.[v - 1];
        if (fr) fr.patch = (prev ? frameDiff(prev, next) : null) ?? {};
      });
    });
    if (states[v]) states[v] = next;
  }

  /** 编辑**该落到哪一版**（用户 2026-09-13 把三种模式放进设置里）：
   *   - 手动（默认）：不新开版本 —— 选中格没有帧时，改动落到它**之前最近的那一版**（右栏那行小字会写明）；
   *   - 自动：选中格还没有帧 → 先开一个空帧，改动即成「这一格与上一格的区别」；
   *   - 锁定：永远落到锁定的那一帧（设置里选）。
   *  三种模式都**不弹窗**：落点写在右栏上，看得见再改。 */
  function editVersion(): number {
    const e = active();
    if (!e) return 0;
    const st = loadSettings();
    if (st.evolveMode === 'locked') {
      const lock = st.evolveLock;
      if (lock && lock.world === store.activeWorld) return versionAtNode(e, epochOf, epochOf(lock.nodeId), lock.nodeId);
    }
    if (st.evolveMode === 'auto' && railNode !== null && !(e.frames ?? []).some((f) => f.nodeId === railNode)) {
      addFrame(railNode, true);
      return entityVersion();
    }
    return entityVersion();
  }

  /** 改「现在看到的那一版」（名字/类型/字段/正文都走这里） */
  function patchVersion(fn: (st: EntityState) => void): void {
    const st = viewState();
    if (!st) return;
    const next: EntityState = { ...st, properties: { ...st.properties } };
    fn(next);
    commitState(editVersion(), next);
    rail?.render();
  }

  /** 在某个事件节点上留一帧（空帧 = 只是标记「从这一刻起就是这个样子」；
   *  随后在这一格里改动，改动就成为它与上一帧的区别）。 */
  function addFrame(nodeId: string, silent = false): void {
    const hit = findNode(nodeId);
    if (!hit) return;
    const fr: EntityFrame = {
      nodeId,
      world: store.activeWorld,
      tlId: hit.tlId,
      note: hit.node.title,
      at: Date.now(),
      patch: {},
    };
    const e = active();
    withQuiet(() => {
      store.update((d) => {
        const ent = d.worldsets[store.activeWorld]?.entities?.[activeId];
        if (!ent) return;
        ent.frames = [...(ent.frames ?? []), fr];
        normalizeFrames(ent, epochOf);   /* 按锚点时间插到正确位置（同一个节点只留一帧） */
      });
    });
    if (e) { states = statesOf(active() ?? e); statesId = e.id; }
    if (!silent) { say('已在这一格记下一帧 ✓'); rail?.render(); }
  }

  /** 删掉某一格上的帧（历史，带确认）。后面的帧不受影响：它们各自相对自己的上一帧。 */
  function deleteFrame(nodeId: string): void {
    const e = active();
    const fr = (e?.frames ?? []).find((f) => f.nodeId === nodeId);
    if (!e || !fr) return;
    void confirmDialog({
      title: '删掉这一帧？',
      message: `「${fr.note || findNode(nodeId)?.node.title || '这一格'}」这一帧记的变化会被丢掉。`,
      detail: '之后的版本不受影响（每一帧存的是它与上一帧的区别）。',
      confirmText: '删掉这一帧',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      withQuiet(() => {
        store.update((d) => {
          const ent = d.worldsets[store.activeWorld]?.entities?.[activeId];
          if (ent?.frames) ent.frames = ent.frames.filter((f) => f.nodeId !== nodeId);
        });
      });
      const e2 = active();
      if (e2) { states = statesOf(e2); statesId = e2.id; }
      say('已删掉这一帧');
      if (!swapBody()) render();
    });
  }

  /** 「正在看：…」那行小字：站在初稿还是站在某个事件之后的版本（放在中栏顶部）。
   *  ⚠️ 它必须**跟着换条目/换版本一起更新** —— 否则切到另一条实体后这行还写着上一条的版本
   *  （实测：切到没有版本的实体再切回来，右栏高亮是「第 1 版」而这里仍写着"初稿"）。 */
  function versionNoteText(): string {
    const v = entityVersion();
    return v === 0 ? '正在看：初稿' : `正在看：第 ${v} 版（锚在右边那格事件上）`;
  }

  /** 换「站在哪个事件上看」：先结算正文，再换版本（顺序反了会把这一版的正文写进那一版）。 */
  function setRailNode(nodeId: string | null): void {
    if (railNode === nodeId) return;
    if (docEditor) docEditor.flush();
    railNode = nodeId;
    const e = active();
    if (e) { states = statesOf(e); statesId = e.id; }   /* 换版本 = 换个下标取数组，不用重算 */
    if (!swapBody()) render();
  }
  /** 把正文写回**指定**目标（不是「当前选中的」）—— 关闭时调用也不会串文档。 */
  function writeDoc(t: DocTarget, md: string): void {
    withQuiet(() => {
      if (t.kind === 'entity') {
        /* 实体：正文属于**现在看到的那一版**（初稿 or 某一帧的差异），不是实体身上那一份。
           `t.id` 一定还是"刚才编辑的那条"（switchTarget 先 flush 再改选择），
           所以 viewState()/editVersion() 此刻读到的就是对的版本。 */
        const st = t.id === activeId ? viewState() : undefined;
        if (st && st.doc !== md) commitState(editVersion(), { ...st, doc: md });
        else if (!st) store.update((d) => { const e = d.worldsets[store.activeWorld]?.entities?.[t.id]; if (e) e.doc = md; });
      } else {
        store.update((d) => {
          const n = d.worldsets[t.world]?.timelines?.[t.tlId]?.nodes.find((x) => x.id === t.nodeId);
          if (n) n.doc = md;
        });
      }
    });
  }

  /** 换目标（换条目 / 换页签）：**先把正文结算掉再改选择**。
   *  反过来的话，`render()` 开头那次 flush 会把旧条目的正文写进新选中的条目 —— 实测过的坑。
   *  flush 之后不销毁编辑器：同模式内换条目走就地换内容（保留 tiptap 实例与滚动位置）。 */
  function switchTarget(mutate: () => void): void {
    if (docEditor) docEditor.flush();   /* 只结算，不 dispose（dispose 交给整块 render 那条路） */
    mutate();
    if (swapBody()) return;
    pendingEnter = true;   /* 这是用户主动切换：整块重建时播一次入场 */
    render();
  }

  /** 实体选择归一（当前这条被筛掉/被删掉 → 落到列表第一条）。render() 与 swapBody() 共用同一规则，
   *  两处各写一遍就会漂移（比如删除后回退到哪一条）。 */
  function normalizeEntitySelection(): void {
    if (mode !== 'entity') return;
    if (!active() || !filtered().some((e) => e.id === activeId)) activeId = filtered()[0]?.id ?? '';
  }

  /* ── 就地换内容（用户 2026-09-13：「设定库中点击实体会刷新界面，我希望变成平滑切换」）────────
     旧路径：点条目 → switchTarget → render() → `host.innerHTML = …`，把**整个面板**（标题行、页签行、
     左列、中栏、右栏）重造一遍。一次点击要付三样代价，眼睛看到的就是"界面刷新了一下"：
       ① 左列与整块骨架重播一次错峰入场（该点开的东西又一个个冒出来，最多 700ms）；
       ② `#cx-root` 就是滚动容器，被换掉 ⇒ **滚动位置回到顶部**（正文在屏幕下半截时最明显）；
       ③ tiptap 实例被 dispose 再新建 ⇒ 正文区先空一帧再填回来。
     而同一页签内换条目，**真正该变的只有三样**：名字/类型/字段行、正文、左列那条高亮。
     所以这里保住骨架，只换这三样，再给内容区一次轻淡入（`.lk-swap-in` 从 0.5 不透明度落位 —— 
     不是从透明开始：从 0 出来就是"闪一下白"，那是用户报过的老毛病，别再犯）。
     返回 false = 这次不该走这条路（换页签 / 换世界 / 条目被删空 / 骨架还没建好）⇒ 调用方整块 render()。 */
  function swapBody(): boolean {
    if (renderedMode !== mode || !host.querySelector('#cx-root')) return false;
    const body = host.querySelector<HTMLElement>('#cx-body');
    if (!body) return false;
    let next: DocTarget;
    let md: string;
    if (mode === 'entity') {
      normalizeEntitySelection();
      ensureRailSelection();
      const st = viewState();
      const nameEl = host.querySelector<HTMLInputElement>('#cx-name');
      const typeEl = host.querySelector<HTMLSelectElement>('#cx-type');
      const fieldsEl = host.querySelector<HTMLElement>('#cx-fields');
      /* 骨架是"一个条目都没有"那一版（中栏只有一句提示）⇒ 结构不同，整块重建 */
      if (!st || !nameEl || !typeEl || !fieldsEl) return false;
      nameEl.value = st.name ?? '';
      /* 类型下拉里没有这个 id（外部的类型被删了）就别硬写 value —— 浏览器会把 select 落到第一个选项上 */
      if (Array.from(typeEl.options).some((o) => o.value === st.typeId)) typeEl.value = st.typeId ?? '';
      fillEntityFields(fieldsEl, st);
      const vn = host.querySelector<HTMLElement>('#cx-vnote');
      if (vn) vn.textContent = versionNoteText();
      next = { kind: 'entity', id: activeId };
      md = st.doc ?? '';
    } else {
      const t = nodeTarget;
      const n = activeNode();
      const pathEl = host.querySelector<HTMLElement>('#cx-nodepath');
      const propsEl = host.querySelector<HTMLElement>('#cx-props');
      if (!t || !n || !pathEl || !propsEl || !propsPanel) return false;
      const tlName = store.data.worldsets[t.world]?.timelines[t.tlId]?.name ?? t.tlId;
      pathEl.textContent = `${t.world} · ${tlName} · ${n.kind || '事件'}`;
      propsPanel.render(n, false);
      next = { kind: 'node', world: t.world, tlId: t.tlId, nodeId: t.nodeId };
      md = n.doc ?? '';
    }
    docTarget = next;
    if (docEditor) docEditor.setDoc(md);   /* 同一个 tiptap 实例换文档，不销毁不重建 */
    renderList();                          /* 左列只动高亮：那一列没有编辑器，重建只花 DOM 钱 */
    rail?.render();                        /* 右栏那条竖线：换实体/换版本要重画高亮与摘要 */
    pendingEnter = false;                  /* 骨架没重建 ⇒ 不该有整块错峰 */
    bodySig = bodySignature();             /* 签名立刻对齐，否则下一次 store 变化会白重建一次 */
    enter(body, 'lk-swap-in');
    return true;
  }

  const tabBtn = (id: string, label: string, on: boolean): string =>
    `<button id="${id}" class="lk-cx-tab" style="background:${on ? 'var(--accent)' : 'var(--surface-2)'};color:${on ? 'var(--accent-on)' : 'var(--fg)'};border:1px solid ${on ? 'var(--accent)' : 'var(--border)'};border-radius:var(--radius-pill);padding:3px 12px;font-size:var(--text-xs);cursor:pointer;">${escapeHtml(label)}</button>`;

  /** 中栏的实体字段行（模板声明的类型决定控件形态）。
   *  整块 render() 与就地换条目（swapBody）**共用这一份** —— 两处各写一遍就会漂移，
   *  这一课在抽公共属性面板时吃过（同一件事做两遍，各缺一半）。
   *  ⚠️ 参数是**某一版的样子**（`EntityState`），不是实体本身：显示的是"你站的这一格"的版本，
   *  写回也写进那一版（`patchVersion`），字段值与初稿可以不同。 */
  function fillEntityFields(el: HTMLElement, st: EntityState): void {
    el.innerHTML = '';
    const t = types()[st.typeId];
    if (!(t?.fields ?? []).length) {
      const hint = document.createElement('div');
      hint.style.cssText = 'font-size:var(--text-xs);color:var(--fg-2);';
      hint.textContent = '这个类型还没有字段 —— 到左栏「结构体管理」的“实体类型”里加。';
      el.appendChild(hint);
    }
    for (const f of t?.fields ?? []) {
      el.appendChild(fieldRow(f, st.properties?.[f.name], (v) => {
        patchVersion((s) => { s.properties = { ...s.properties, [f.name]: v }; });
        say('已保存 ✓');
      }));
    }
  }

  function render(): void {
    /* 切条目 / 换页签 / 重渲染前先把正文结算掉（未失焦的编辑也在里面），再销毁旧实例。
       结算用的是**旧** docTarget，所以清空它必须排在这一步之后。 */
    if (docEditor) { docEditor.flush(); docEditor.dispose(); docEditor = null; }
    docTarget = null;
    propsPanel = null;   /* 旧面板的宿主元素马上要被换掉，留着没用 */
    /* 目标没了（外部删掉 / 换世界）→ 清掉，免得面板显示一条不存在的数据 */
    if (nodeTarget && !activeNode()) nodeTarget = null;
    const isEntity = mode === 'entity';
    normalizeEntitySelection();
    ensureRailSelection();   /* 实体页签：把"站在哪个事件上看"与各版本的样子准备好 */
    const kinds = Object.keys(types());
    const mainEnt = (): string => {
      const st = viewState();
      if (!st) return '<div style="font-size:var(--text-xs);color:var(--fg-2);">左边选一个实体看图。</div>';
      return `
        <div style="display:flex;align-items:center;gap:8px;">
          <input id="cx-name" value="${escapeHtml(st.name)}" style="${INP}font-size:15px;font-weight:600;"/>
          <span style="font-size:var(--text-xs);color:var(--fg-2);flex-shrink:0;">类型</span>
          <select id="cx-type" style="flex-shrink:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-xs);outline:none;">${kinds.map((k) => `<option value="${escapeHtml(k)}"${k === st.typeId ? ' selected' : ''}>${escapeHtml(typeName(k))}</option>`).join('')}</select>
          <button id="cx-del" style="margin-left:auto;flex-shrink:0;background:transparent;border:1px solid var(--danger);color:var(--danger);border-radius:var(--radius-sm);padding:3px 10px;font-size:var(--text-xs);cursor:pointer;">删除</button>
        </div>
        <div id="cx-vnote" style="font-size:var(--text-xs);color:var(--fg-2);margin-top:4px;">${escapeHtml(versionNoteText())}</div>
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
        <div id="cx-nodepath" style="font-size:var(--text-xs);color:var(--fg-2);margin-bottom:8px;">${escapeHtml(t.world)} · ${escapeHtml(tlName)} · ${escapeHtml(kind)}</div>
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
          <div id="cx-body" style="flex:1;min-width:0;border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;">
            ${isEntity ? mainEnt() : mainNode()}
          </div>
          ${isEntity ? '<div id="cx-rail" class="lk-rail" title="演变：站在某个事件上看这条设定"></div>' : ''}
        </div>
        <div id="cx-msg" style="font-size:var(--text-xs);"></div>
      </div>`;

    renderList();

    /* 右栏那条竖线（演变）。只在实体页签有 —— 它按「世界的事件节点」画格子；
       它自己不写数据，建帧/删帧/换格都回到这个文件里（免得两处各说一套怎么落盘）。 */
    const railHost = host.querySelector<HTMLElement>('#cx-rail');
    rail = railHost
      ? createEvolutionRail({
        store,
        host: railHost,
        getEntity: () => active(),
        getSelected: () => railNode,
        onSelect: (id) => setRailNode(id),
        onAddFrame: (id) => { addFrame(id); bodySig = bodySignature(); rail?.render(); },
        onDeleteFrame: (id) => deleteFrame(id),
      })
      : null;
    rail?.render();

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
      /* 改名走**当前那一版**：初稿就改实体自己（文件名跟着变），某一帧上就记进那帧的差异
         （文件名始终按初稿的名字 —— .md 得有个稳定的落点） */
      patchVersion((st) => { st.name = inp.value.trim() || '未命名'; });
      say('已保存 ✓');
    });
    host.querySelector('#cx-type')?.addEventListener('change', () => {
      const sel = host.querySelector('#cx-type') as HTMLSelectElement;
      patchVersion((st) => { st.typeId = sel.value; });
      /* 换类型 → 按新模板补字段（由 src/main.ts 的 ensureEntityLayer 统一做） */
      window.dispatchEvent(new CustomEvent('lingkuang-formats-changed'));
      say('已换类型 ✓');
    });
    /* 实体字段行（公共控件 `src/ui/fields.ts`）：模板声明的类型决定控件形态 */
    const fieldsHost = host.querySelector('#cx-fields') as HTMLElement | null;
    const st0 = viewState();
    if (fieldsHost && st0) fillEntityFields(fieldsHost, st0);
    /* 节点：中栏用**公共属性面板**（与编辑器同一份实现，含标题/时间历法 scrub/精度/种类/描述 + 种类字段） */
    const propsHost = host.querySelector('#cx-props') as HTMLElement | null;
    if (propsHost && nodeTarget) {
      propsPanel = createPropsPanel({
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
      propsPanel.render(activeNode(), false);
    }
    /* 正文：真编辑器（tiptap）。**写回 docTarget 当时指着的目标**（不是"当前选中的那个"按值捕获）——
       编辑器现在跨条目复用（见 swapBody），目标会变；而 switchTarget/ render() 都保证
       先 flush（旧目标）再改 docTarget，所以内容不会串到别的条目上。 */
    const docHost = host.querySelector('#cx-doc') as HTMLElement | null;
    if (docHost && (isEntity ? !!active() : !!nodeTarget)) {
      docTarget = isEntity ? { kind: 'entity', id: activeId } : { kind: 'node', ...(nodeTarget as NodeTarget) };
      docEditor = createDocEditor(docHost, (md) => {
        if (docTarget) writeDoc(docTarget, md);
        /* 正文落盘后左列不用重画（标题没变），也不该整块重渲染（会丢光标） */
      });
      docEditor.setDoc((isEntity ? viewState()?.doc : activeNode()?.doc) ?? '');
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
    /* 记下这版骨架是按哪个页签建的：同页签内换条目才敢走就地换内容（中栏结构相同） */
    renderedMode = mode;
  }

  /** 中/右栏「该显示什么」的内容签名（目标身份 + 字段 + 正文）。
   *  订阅里**只有它变了才重建** —— 理由见 unsub 处的长注释。 */
  function bodySignature(): string {
    /* 带上 activeWorld：骨架里的标题（「XX」的条目）与中栏取的实体都跟着它走，
       换世界必须重建，否则留着上一个世界的名字。 */
    const w = store.activeWorld ?? '';
    if (mode === 'entity') {
      const kindList = Object.keys(types()).join(',');
      const st = viewState();
      if (!st) return ['entity', w, 'none', kindList].join('|');
      /* 带版本号：同一格里换版本（点右栏另一格）必须重建中/右栏。
         内容取**这一版的样子**（不是实体身上的初稿）—— 否则改了某一帧、显示的却是初稿，签名看不出差别。 */
      const v = entityVersion();
      return ['entity', w, activeId, 'v' + v, railNode ?? '', st.typeId ?? '', st.name,
        JSON.stringify(st.properties ?? {}), st.doc ?? '', kindList].join('|');
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
    /* 物化结果缓存作废：数据可能被外部回扫换过（同一个实体 id，但帧/正文已不同） */
    statesId = '';
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
  /* 设置里改了「设定演变」的模式/锁定点 → 视图与落点都要跟着变（锁定模式下视图钉在锁定那一格） */
  const onSettings = (): void => {
    if (!railKey || !active()) return;
    if (!swapBody()) render();   /* swapBody 内部会 ensureRailSelection + 重画帧条 */
  };
  window.addEventListener('lingkuang-settings', onSettings);
  render();
  return () => {
    torn = true;
    unsub();
    window.removeEventListener('lingkuang-settings', onSettings);
    /* 切走工具时把未失焦的正文也结算掉，再销毁 tiptap 实例 */
    if (docEditor) { docEditor.flush(); docEditor.dispose(); docEditor = null; }
    if (msgTimer) window.clearTimeout(msgTimer);
  };
}
