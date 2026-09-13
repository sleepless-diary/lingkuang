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
import { createVaultNotices, type VaultNotices } from './vault-notice';
import { loadSettings } from './settings';
import {
  epochOfNodes, frameDiff, nearestVersion, normalizeFrames, statesOf, versionAtNode, type EntityState,
} from '../store/evolution';
import { cascadeIn, enter, motionReduced, rowsEnter, rowsLeave } from './motion';

const INP = 'flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 7px;font-size:var(--text-sm);outline:none;font-family:inherit;user-select:text;';

/** 正文写回哪个目标（编辑器跨条目复用，目标会变，所以是**读时取值**不是创建时捕获）。
 *  安全性由 `switchTarget` 保证：它一定先 `flush()`（此时 docTarget 还是旧目标）再改 docTarget。 */
type DocTarget = { kind: 'entity'; id: string } | { kind: 'node'; world: string; tlId: string; nodeId: string };

/** 节点身份（带 world —— 左列会列出**所有世界**的时间线，保存时必须写回它自己那个世界） */
interface NodeTarget { world: string; tlId: string; nodeId: string; }

export function renderCodex(store: Store, host: HTMLElement): () => void {
  host.style.overflow = 'hidden';
  let mode: 'entity' | 'node' = 'entity';
  let query = '';               /* 搜索词：实体按名字过滤，节点按标题过滤（非空时树摊平成命中列表） */
  /* 左栏就是**一棵文件夹树**，时间线节点与设定条目同框，跟硬盘目录一一对应：
       世界 → 时间线 → 种类 → 节点   （= `<世界>/<时间线>/<种类>/<节点>.md`）
       世界 → `_设定` → 类型 → 实体  （= `<世界>/_设定/<类型>/<实体>.md`）
     形态之争到此结束（用户 2026-09-13 的两句话）：
       ① 「时间线节点和实体这两个按钮，列表和文件夹树的功能有点混乱，能不能重新设计一下」
       ② 「要不这样，把全部改成文件树的形式，这样子也方便看」
     ⇒ **没有列表形态、没有形态开关、没有类别页签、也没有筛选 pills** ——
     树的形状本身就是筛选（要看哪一类就展开哪一枝），点中哪一行就编哪一类。
     树**默认全展开**（见下面三个 collapsed* Set），所以打开左栏就看得到全部条目。 */
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
  /* 外部改动提示条（Obsidian 把 `#描述：`/`#正文：` 标签改坏、或启动时被自动补回格式）。
     一次创建活到切走；宿主元素每次 render 都会换，所以 render 完要 refresh()。 */
  let vaultNotices: VaultNotices | null = null;
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
  /* 换条目转场里那层"旧内容幽灵"（用户 2026-09-13 定稿的做法 P，见 playSwap）。
     同一时刻最多一层：新的一轮开始时**复用**它，而不是把"其实还没露过脸"的新内容再快照一遍。 */
  let swapGhost: HTMLElement | null = null;
  /* ── 演变（版本历史，2026-09-13）─────────────────────────────────
     中/右栏显示的**不是实体身上那一份**，而是「你现在站在哪个事件上看它」那一版：
     `statesOf(实体)` 一次算出初稿 + 每一帧之后的全部样子，换版本就是换个下标取数组（O(1)）。
     `railNode` = 选中的锚点节点（null = 初稿那一格）；`railKey` = 这个选择属于哪条实体，
     换实体要重挑默认值（用户指定：**离沙盘时间指针最近的那一帧**）。 */
  let railNode: string | null = null;
  /* 「记到哪个事件」（帧条底部那个下拉）：新版本落在哪一格。用户 2026-09-13 上午要求
     「没有版本的节点就不显示」之后，帧条上再也点不到空格子 ⇒ 建版本的入口就是这个锚点。 */
  let railAnchor: string | null = null;
  let railKey = '';
  let rail: Rail | null = null;
  let states: EntityState[] = [];
  let statesId = '';
  /* 节点 epoch 按世界缓存（拖帧条、每次改字段都要查，不该每次重算年表） */
  let epochWorld = '';
  let epochCache: Map<string, number> = new Map();
  /* 左栏那棵树的展开状态。**记的是"被收起来的那些"，不是"被展开的那些"** ——
     默认**全展开**（用户 2026-09-13：「把全部改成文件树的形式，这样子也方便看」）：
     打开左栏就该看到全部条目，而不是先点三层才看见东西。点一下 = 收起那一枝。
     三个 Set 的键：世界 = 世界名；`collapsedTls` 那层 = `<世界>::<时间线 id>` 与 `setting::<世界>`；
     `collapsedKinds` 那层 = `<世界>::<时间线 id>::<种类>` 与 `etype::<世界>::<类型 id>`。 */
  const collapsedWorlds = new Set<string>();
  const collapsedTls = new Set<string>();
  const collapsedKinds = new Set<string>();

  const world = () => currentWorld(store);
  const types = () => world().entityTypes ?? {};
  const entities = (): Entity[] => Object.values(world().entities ?? {}) as Entity[];
  const typeName = (id: string): string => types()[id]?.name ?? id ?? '（无类型）';
  const active = (): Entity | undefined => world().entities?.[activeId];
  const match = (s: string | undefined): boolean => !query || String(s ?? '').toLowerCase().includes(query.toLowerCase());

  /* 实体：按名字排序的一份（树里同层按名字排，选择归一（normalizeEntitySelection）也用它） */
  const sortedEntities = (): Entity[] => entities()
    .slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));

  /** 展开态：Set 里有的表示**被用户收起来了**（默认全展开，见三个 collapsed* 的注释） */
  const isOpen = (s: Set<string>, k: string): boolean => !s.has(k);
  const toggleOpen = (s: Set<string>, k: string): void => { if (s.has(k)) s.delete(k); else s.add(k); };

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
  const activeNode = (): TimelineNode | undefined => {
    const t = nodeTarget;
    if (!t) return undefined;
    return store.data.worldsets[t.world]?.timelines[t.tlId]?.nodes.find((x) => x.id === t.nodeId);
  };
  /** 摊平全部世界的节点（带上它属于哪个世界/时间线/种类）—— 列表、搜索、树都用这一份。
   *  列表形态与搜索都**不看世界/时间线**：一个搜索框管全部条目（用户 2026-09-13 要的「便利性」）。 */
  interface FlatNode { world: string; tlId: string; tlName: string; kind: string; node: TimelineNode }
  function flatNodes(): FlatNode[] {
    const out: FlatNode[] = [];
    for (const g of tlGroups()) {
      for (const [kind, list] of g.kinds) {
        for (const node of list) out.push({ world: g.world, tlId: g.tlId, tlName: g.tlName, kind, node });
      }
    }
    return out;
  }
  /** 搜索命中的节点 */
  const searchNodes = (): FlatNode[] => flatNodes().filter((h) => match(h.node.title));

  /* ── 树的 `_设定` 分支：世界 → 类型 → 实体（＝ vault 的 `_设定/<类型>/<名字>.md` 形状）──────
     与 tlGroups 一样刻意遍历**全部世界**。类型清单取 `entityTypes` 的**全部**（含一个实体都没有的：
     置灰 + 一句「这个类型还没有实体」）—— 用户 2026-09-13 要的「显示其他结构体」。
     ⚠️ 这里**不要**改成「只列有实体的类型」：那是把设定类型清单当成硬盘目录来用，
     而类型本身是模型的一部分（新类型就是要能在树里看见、点进去建第一个条目）。 */
  interface SetGroup { world: string; groups: { id: string; name: string; list: Entity[] }[]; }
  function setGroups(): SetGroup[] {
    const out: SetGroup[] = [];
    for (const [wName, w] of Object.entries(store.data.worldsets)) {
      const types = (w.entityTypes ?? {}) as Record<string, { name?: string }>;
      const ents = Object.values((w.entities ?? {}) as Record<string, Entity>);
      const groups = Object.keys(types).map((id) => ({
        id,
        name: types[id]?.name ?? id,
        list: ents.filter((e) => e.typeId === id).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh')),
      }));
      out.push({ world: wName, groups });
    }
    return out;
  }
  /** 搜「设定条目」（跨世界按名字）—— 树视图里搜索要同时搜节点和实体 */
  function searchEntities(): { world: string; entity: Entity }[] {
    const out: { world: string; entity: Entity }[] = [];
    for (const [wName, w] of Object.entries(store.data.worldsets)) {
      for (const e of Object.values((w.entities ?? {}) as Record<string, Entity>)) {
        if (match(e.name)) out.push({ world: wName, entity: e });
      }
    }
    return out;
  }

  function say(text: string, bad = false): void {
    const el = host.querySelector('#cx-msg') as HTMLElement | null;
    if (!el) return;
    /* 没有消息时**不占位置**（display:none）——见 render() 里 #cx-root 的高度预算：
       给一句空话留 27px，正好把面板顶出窗口几像素，于是"什么都没超也长出滚动条" */
    el.style.display = 'block';
    el.textContent = text;
    el.style.color = bad ? 'var(--danger)' : 'var(--accent)';
    if (msgTimer) window.clearTimeout(msgTimer);
    msgTimer = window.setTimeout(() => { if (el.isConnected) { el.textContent = ''; el.style.display = 'none'; } }, 2600);
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

  /** 离沙盘时间指针最近的**事件节点**（不看有没有版本）—— 锚点下拉的默认值 */
  function nearestNodeId(): string | null {
    const ws = currentWorld(store) as any;
    const cursor = Number(ws?.timeCursor ?? 0);
    let best: string | null = null;
    let bd = Infinity;
    for (const tlId of (ws?.order ?? []) as string[]) {
      for (const n of (ws?.timelines?.[tlId]?.nodes ?? []) as TimelineNode[]) {
        const d = Math.abs((epochOf(n.id) ?? 0) - cursor);
        if (d < bd) { bd = d; best = n.id; }
      }
    }
    return best;
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
    /* 「记到」的锚点：锁定模式跟锁定点走，否则 = 离指针最近的事件（换实体不重置，锚点是整个世界的事） */
    if (st.evolveMode === 'locked' && lock && lock.world === store.activeWorld) railAnchor = lock.nodeId;
    else if (!railAnchor || !findNode(railAnchor)) railAnchor = nearestNodeId();
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
   *   - 手动（默认）：改动改的是**你现在看的这一版**（初稿 or 某一帧）——所见即所改；
   *     想新开一版，用帧条底部的「记到 + ＋记一帧」；
   *   - 自动：改动落到**「记到」那个事件**上 —— 它还没有版本就先建一版，改动即成那一版；
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
    if (st.evolveMode === 'auto' && railAnchor !== null) {
      if (!(e.frames ?? []).some((f) => f.nodeId === railAnchor)) addFrame(railAnchor, true);
      /* 改动既然记在锚点那一版上，视图也跟着站过去 —— 否则屏幕上这一栏显示的是别的版本的值 */
      railNode = railAnchor;
      return entityVersion();
    }
    return entityVersion();
  }

  /** 改「现在看到的那一版」（名字/类型/字段/正文都走这里）。
   *  ⚠️ 顺序：**先定"改哪一版"再取那一版的样子** —— 自动模式里 `editVersion()` 可能会新建一版
   *  并把视图挪过去，先取 `viewState()` 就会拿"旧那一版"的内容去覆盖"新那一版"（内容整块串位）。 */
  function patchVersion(fn: (st: EntityState) => void): void {
    const v = editVersion();
    const st = states[Math.max(0, Math.min(states.length - 1, v))];
    if (!st) return;
    const next: EntityState = { ...st, properties: { ...st.properties } };
    fn(next);
    commitState(v, next);
    /* 提交走的是 quiet（订阅里不重建），所以屏幕上那行「正在看：第 N 版」要手动跟上 */
    const vn = host.querySelector<HTMLElement>('#cx-vnote');
    if (vn) vn.textContent = versionNoteText();
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
    const idx = (e.frames ?? []).findIndex((f) => f.nodeId === nodeId);
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
      /* 删掉的正是"现在站着的那一格" ⇒ 视图不能停在一个已经不存在的版本上，
         退到它**前一版**（没有前一版就是初稿）。用户 2026-09-13 上午改成"没有版本的节点不显示"，
         不这么退的话那一格会连行一起从帧条上消失，看起来像"点了没反应还丢了东西"。 */
      if (railNode === nodeId) railNode = (e2?.frames ?? [])[Math.max(0, idx - 1)]?.nodeId ?? null;
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
    /* 点帧条上的行 = "我要看这一版"，顺便把「记到」也带过去（下一个版本记在这附近最顺手）。
       点初稿（null）不动锚点 —— 初稿不是可以"记到"的地方。 */
    if (nodeId !== null) railAnchor = nodeId;
    const e = active();
    if (e) { states = statesOf(e); statesId = e.id; }   /* 换版本 = 换个下标取数组，不用重算 */
    if (!swapBody()) render();
  }
  /** 把正文写回**指定**目标（不是「当前选中的」）—— 关闭时调用也不会串文档。 */
  function writeDoc(t: DocTarget, md: string): void {
    withQuiet(() => {
      if (t.kind === 'entity') {
        /* 实体：正文属于**现在看到的那一版**（初稿 or 某一帧的差异），不是实体身上那一份。
           `t.id` 一定还是"刚才编辑的那条"（switchTarget 先 flush 再改选择）。
           ⚠️ 与 patchVersion 同一条顺序纪律：**先定"改哪一版"再取那一版的样子** ——
           自动模式下 `editVersion()` 可能新建一版并把视图挪过去，先取 viewState() 会串位。 */
        if (t.id !== activeId) { store.update((d) => { const e = d.worldsets[store.activeWorld]?.entities?.[t.id]; if (e) e.doc = md; }); return; }
        const v = editVersion();
        const st = states[Math.max(0, Math.min(states.length - 1, v))];
        if (!st) { store.update((d) => { const e = d.worldsets[store.activeWorld]?.entities?.[t.id]; if (e) e.doc = md; }); return; }
        if (st.doc !== md) commitState(v, { ...st, doc: md });
        const vn = host.querySelector<HTMLElement>('#cx-vnote');
        if (vn) vn.textContent = versionNoteText();
        rail?.render();
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

  /** 实体选择归一（当前这条被删掉/换世界了 → 落到第一条）。render() 与 swapBody() 共用同一规则，
   *  两处各写一遍就会漂移（比如删除后回退到哪一条）。
   *  对着**全部实体**归一（`sortedEntities()`）—— 不是对着"左栏此刻画出来的那批"：
   *  左树可能正被搜索词收窄，那也不该把正在编辑的实体清掉（否则中栏会跳成"左边选一个实体看图"）。 */
  function normalizeEntitySelection(): void {
    if (mode !== 'entity') return;
    if (!active()) activeId = sortedEntities()[0]?.id ?? '';
  }

  /* ── 换条目转场（用户 2026-09-13 定稿的「做法 P」）──────────────────────────────────────────
     规格从演示页 `docs/motion-demo/doc-slide.html` 里逐轮谈出来的（用户当时的话）：
       ·「我想要的是……关键帧 a 时不透明度 0、位置在 b 位置右边；b 时不透明度 100、速度快到慢；
          每行都是这个动画，但是每行比上一行慢一点（错峰）」；
       ·「出场也是一样的动画，但是是慢到快」+「应该先出场再入场」；
       ·「执行入场动画之前能不能不透明度调为 0」（⇒ 必须 fill:'both'，否则延迟期间会先亮出来）；
       ·「我指的是从右向左入场时要错分，不是入场后左右弹动一下」（⇒ 只走左右，不走上下）。
     实现要点：
       ① 旧内容做成一层**幽灵**（`#cx-body` 里的绝对定位克隆）往左退场、演完自己消失；
          新内容待在原地、延后一个出场时长再从右淡入 —— 框、左树、滚动位置一律不动；
       ② 快照必须在**改 DOM 之前**取（`body.innerHTML`），而且要把克隆里的 `id` 全摘掉 ——
          否则会多出第二个 `#cx-doc`/`#cx-fields`，`host.querySelector('#cx-fields')` 会抓到幽灵里那个；
       ③ 已经有一轮在飞时**复用**那层幽灵（它才是用户最后看见的那份内容），并把它的动画重头再来；
          否则连点两下时会把"还没显形的新内容"当成旧内容再演一遍 ⇒ 闪。 */
  const ROW_SEL = '[data-cx-row], #cx-props .ed-props > *';

  /** 转场要逐行动画的行。`skipGhost=true`（对 `#cx-body` 用）时**排除幽灵层里的行** ——
   *  否则同一份旧内容会在"出场"和"入场"里各演一遍。给幽灵层自己用时要传 false，
   *  不然那个 `.closest('.lk-cx-ghost')` 会把幽灵的每一行都滤掉（踩过：幽灵当场被收掉，
   *  `exits` 为空 ⇒ `Promise.all([])` 立刻 resolve ⇒ 看起来根本没建幽灵）。 */
  function rowsOf(root: HTMLElement, skipGhost = true): HTMLElement[] {
    return (Array.from(root.querySelectorAll(ROW_SEL)) as HTMLElement[]).filter(
      (el) => (!skipGhost || !el.closest('.lk-cx-ghost')) && el.getClientRects().length > 0
    );
  }

  /** 收掉幽灵层（关掉转场、整块重建、工具切走时都要） */
  function dropGhost(): void {
    if (!swapGhost) return;
    for (const a of swapGhost.getAnimations()) { try { a.cancel(); } catch { /* 已取消 */ } }
    swapGhost.remove();
    swapGhost = null;
  }

  /** 取"旧内容"的快照（**必须在改 DOM 之前调**）。
   *  先收掉上一轮那层幽灵：它也是 `#cx-body` 的子元素，留着会被一起写进快照
   *  （快照里嵌一层幽灵 ⇒ 新幽灵里凭空多一块旧内容）。连点两下时这一收就是"上一轮的出场被截断"，
   *  换来的是"每一轮都是拿**当前看得见的那份**内容去演"，与演示页里那个循环模型一致。 */
  function snapshotForSwap(body: HTMLElement): string {
    dropGhost();
    return body.innerHTML;
  }

  /** 演一次换内容的转场。`prevHtml` = 改动**之前**的 `#cx-body.innerHTML`（本轮不演就传 null）。
   *  一轮只演一层幽灵：进来先把上一轮那层收掉，避免连点时越堆越多。 */
  function playSwap(body: HTMLElement, prevHtml: string | null): void {
    const s = loadSettings();
    dropGhost();
    if (s.motionSwap === false) return;
    /* 系统「减少动态效果」：只留一次短淡入（DESIGN.md:159），不摆行、不建幽灵层
       —— motion.ts 那两个函数在 reduced 下会返回空数组，幽灵层会留在屏幕上没人收，所以这里先拦。 */
    if (motionReduced()) { enter(body, 'lk-swap-in'); return; }
    const speed = Math.max(0.2, s.motionSpeed || 1);
    const dur = Math.round(300 / speed);
    const step = Math.max(0, s.motionStagger ?? 10);
    const dx = Math.max(0, s.motionEnterDx ?? 32);
    if (prevHtml !== null) {
      const ghost = document.createElement('div');
      ghost.className = 'lk-cx-ghost';
      ghost.setAttribute('aria-hidden', 'true');
      ghost.innerHTML = prevHtml;
      /* ⚠️ 克隆体里的 id 全部摘掉：`#cx-doc`/`#cx-fields`/`#cx-name` 各多出一份的话，
         `host.querySelector('#cx-fields')` 就可能抓到幽灵里那一份（接线/断言全线错位）。 */
      for (const el of Array.from(ghost.querySelectorAll('[id]'))) el.removeAttribute('id');
      body.appendChild(ghost);
      swapGhost = ghost;
      const exits = rowsLeave(rowsOf(ghost, false), { dx, step, dur });
      const kill = (): void => { if (swapGhost === ghost) dropGhost(); };
      /* 没有可动画的行（全被 display:none 滤掉）时别留一层静止的重复内容 —— 直接收掉 */
      Promise.all(exits.map((a) => a.finished)).then(kill).catch(() => { /* 被取消 */ });
      /* 兜底：隐藏窗口里动画不推进，`finished` 永远不来（README 铁律 6），这层幽灵不能留着 */
      window.setTimeout(kill, dur + step * 80 + 600);
    }
    rowsEnter(rowsOf(body), { dx, step, dur, start: dur });
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
     返回 false = 这次不该走这条路（骨架还没建好 / 一条实体都没有那种空条目版）⇒ 调用方整块 render()。
     **换类别**（节点 ↔ 实体）也走这里：见下面 `renderedMode !== mode` 那一支与 `mountBody()`。 */
  function swapBody(animate = true): boolean {
    if (!host.querySelector('#cx-root')) return false;
    const body = host.querySelector<HTMLElement>('#cx-body');
    if (!body) return false;
    /* 幽灵层的素材必须在**改 DOM 之前**取（`snapshotForSwap` 会先收掉上一轮那层） */
    const prevHtml = animate ? snapshotForSwap(body) : null;
    /* **换类别**（时间线节点 ↔ 设定条目）：中栏结构不同，但骨架不用动 —— 只重造 `#cx-body`
       （见 mountBody），左树、顶栏、帧条元素与 `#cx-root` 的滚动位置全留着。 */
    if (renderedMode !== mode) {
      if (mode === 'entity') { normalizeEntitySelection(); ensureRailSelection(); }
      if (!mountBody(prevHtml, animate)) return false;
      renderList();          /* 左列只动高亮 —— 那一列同时装着两类条目，不用重建 */
      rail?.render();        /* 帧条跟着换（节点模式它藏着，重画无害） */
      pendingEnter = false;  /* 骨架没重建 ⇒ 不该有整块错峰 */
      bodySig = bodySignature();
      return true;
    }
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
      void vaultNotices?.checkBodyTag(t.world, t.tlId, t.nodeId, n.doc ?? '', n.title ?? '');
    }
    docTarget = next;
    if (docEditor) docEditor.setDoc(md);   /* 同一个 tiptap 实例换文档，不销毁不重建 */
    renderList();                          /* 左列只动高亮：那一列没有编辑器，重建只花 DOM 钱 */
    rail?.render();                        /* 右栏那条竖线：换实体/换版本要重画高亮与摘要 */
    pendingEnter = false;                  /* 骨架没重建 ⇒ 不该有整块错峰 */
    bodySig = bodySignature();             /* 签名立刻对齐，否则下一次 store 变化会白重建一次 */
    playSwap(body, prevHtml);
    return true;
  }

  /** 正文那一行的标题 + 两个小按钮（H1 / 插入图片）——
   *  这两个动作原来是「编辑器」工具专有的（`src/ui/editor.ts` 的 `#ed-h1` / `#ed-img`），
   *  并成工作台后搬到这里（实体与节点共用同一份）。 */
  const docBar = (label: string): string => `
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
      <span style="font-size:10px;color:var(--fg-2);">${label}</span>
      <span style="margin-left:auto;display:flex;gap:4px;flex-shrink:0;">
        <button id="cx-h1" title="把光标所在段落设为一级标题" style="background:transparent;border:1px solid var(--border);color:var(--fg-2);border-radius:var(--radius-sm);padding:1px 8px;font-size:10px;cursor:pointer;">H1</button>
        <button id="cx-img" title="插入图片（存进 vault 的 assets）" style="background:transparent;border:1px solid var(--border);color:var(--fg-2);border-radius:var(--radius-sm);padding:1px 8px;font-size:10px;cursor:pointer;">图片</button>
      </span>
    </div>`;

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
      const row = fieldRow(f, st.properties?.[f.name], (v) => {
        patchVersion((s) => { s.properties = { ...s.properties, [f.name]: v }; });
        say('已保存 ✓');
      });
      row.dataset.cxRow = '';   /* 转场的一行：换条目时这一行跟着错峰淡入（见 playSwap） */
      el.appendChild(row);
    }
  }

  /** 中/右栏那一块的 HTML（按当前 mode）。
   *  `render()` 建骨架时用它；**换类别**（实体 ↔ 节点）时也用它 —— 那时只把 `#cx-body` 里这一块
   *  换掉，骨架、左树与滚动位置都留着（见 mountBody）。写在 render() 外面就是为了能两处共用。 */
  function bodyHtml(): string {
    const kinds = Object.keys(types());
    if (mode === 'entity') {
      const st = viewState();
      if (!st) return '<div style="font-size:var(--text-xs);color:var(--fg-2);">左边选一个实体看图。</div>';
      return `
        <div data-cx-row style="display:flex;align-items:center;gap:8px;">
          <input id="cx-name" value="${escapeHtml(st.name)}" style="${INP}font-size:15px;font-weight:600;"/>
          <span style="font-size:var(--text-xs);color:var(--fg-2);flex-shrink:0;">类型</span>
          <select id="cx-type" style="flex-shrink:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-xs);outline:none;">${kinds.map((k) => `<option value="${escapeHtml(k)}"${k === st.typeId ? ' selected' : ''}>${escapeHtml(typeName(k))}</option>`).join('')}</select>
          <button id="cx-del" style="margin-left:auto;flex-shrink:0;background:transparent;border:1px solid var(--danger);color:var(--danger);border-radius:var(--radius-sm);padding:3px 10px;font-size:var(--text-xs);cursor:pointer;">删除</button>
        </div>
        <div id="cx-vnote" data-cx-row style="font-size:var(--text-xs);color:var(--fg-2);margin-top:4px;">${escapeHtml(versionNoteText())}</div>
        <div style="display:flex;flex-direction:column;gap:5px;margin-top:10px;border-top:1px dashed var(--border-soft);padding-top:10px;">
          <div id="cx-fields" style="display:flex;flex-direction:column;gap:5px;"></div>
        </div>
        <div data-cx-row style="margin-top:10px;border-top:1px dashed var(--border-soft);padding-top:10px;">
          ${docBar('正文（Markdown · 失焦自动保存 · 落在 vault 的 <code>_设定/&lt;类型&gt;/&lt;名字&gt;.md</code>）')}
          <div id="cx-doc"></div>
        </div>`;
    }
    const t = nodeTarget;
    const n = activeNode();
    if (!t || !n) return '<div style="font-size:var(--text-xs);color:var(--fg-2);">左边选一个时间线节点看图。</div>';
    const tlName = store.data.worldsets[t.world]?.timelines[t.tlId]?.name ?? t.tlId;
    const kind = n.kind || '事件';
    return `
      <div id="cx-nodepath" data-cx-row style="font-size:var(--text-xs);color:var(--fg-2);margin-bottom:8px;">${escapeHtml(t.world)} · ${escapeHtml(tlName)} · ${escapeHtml(kind)}</div>
      <div id="cx-props" style="display:flex;flex-direction:column;gap:5px;"></div>
      <div data-cx-row style="margin-top:10px;border-top:1px dashed var(--border-soft);padding-top:10px;">
        ${docBar('正文（Markdown · 失焦自动保存）')}
        <div id="cx-doc"></div>
      </div>`;
  }

  function render(): void {
    /* 整块重建会把 `#cx-body` 连它里面的幽灵层一起换掉 ⇒ 先把那层收干净（否则它挂在已脱离文档的
       节点上，`swapGhost` 那个引用还指着它，下一轮转场会"复用"一个看不见的东西） */
    dropGhost();
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
    const newCtl = isEntity && kinds.length
      ? `<select id="cx-new-type" title="新实体的类型" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 6px;font-size:var(--text-xs);outline:none;">${kinds.map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(typeName(k))}</option>`).join('')}</select>
         <button id="cx-new" style="background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-sm);padding:6px 14px;font-size:var(--text-xs);cursor:pointer;">＋新建实体</button>`
      : '';

    host.innerHTML = `
      <div style="max-width:1020px;margin:0 auto;padding:14px 16px 12px;display:flex;flex-direction:column;gap:8px;height:100%;overflow:auto;" id="cx-root">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <div style="font-size:17px;font-weight:600;color:var(--fg);">设定库</div>
          <span style="font-size:var(--text-xs);color:var(--fg-2);">「${escapeHtml(store.activeWorld || '（未选世界）')}」的条目 · 字段由模板决定（在左栏「结构体管理」里改模板）</span>
          <span id="cx-newbox" style="margin-left:auto;gap:6px;align-items:center;${isEntity ? 'display:flex;' : 'display:none;'}">${newCtl}</span>
        </div>
        <div id="cx-hint" style="display:none;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:rgba(217,101,92,.12);font-size:var(--text-xs);color:var(--fg);line-height:1.5;"></div>
        <div style="display:flex;gap:12px;align-items:flex-start;">
          <div style="width:250px;flex-shrink:0;display:flex;flex-direction:column;gap:6px;border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px;">
            <input id="cx-search" placeholder="搜索设定与事件…" style="${INP}" value="${escapeHtml(query)}"/>
            <div id="cx-list" style="display:flex;flex-direction:column;gap:1px;"></div>
          </div>
          <div id="cx-body" style="flex:1;min-width:0;border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;position:relative;">
            ${bodyHtml()}
          </div>
          <!-- 右栏那条竖线**常驻**（节点模式只是藏起来）—— 换类别时就不用动骨架，见 mountBody -->
          <div id="cx-rail" class="lk-rail" title="演变：站在某个事件上看这条设定" style="${isEntity ? '' : 'display:none;'}"></div>
        </div>
        <div id="cx-msg" style="font-size:var(--text-xs);display:none;"></div>
      </div>`;

    /* ★ 高度预算（用户 2026-09-13 上午：「默认创建了一个滚动条，去掉吧」）——
       这个面板是 `height:100%` + `overflow:auto`，所以**内容只要比窗口高一个像素就会长出滚动条**。
       实测（1440×900、真实数据 11 字段 + 一篇正文）：内容 864px vs 可用 861px ⇒ 差 3px，
       于是"什么都没超出"却挂了一条滚动条（A/B 过：与帧条无关，把帧条 display:none 也一样超 3px）。
       三处让位后不再超：
         ① 根内边距 18px → 14/12px、块间距 10px → 8px（下面这行的内联样式）；
         ② `#cx-msg` 没消息时 `display:none`（原来给一句空话留了约 27px，见 say()）；
         ③ 帧条只列有版本的节点（`src/ui/evolution-rail.ts`，行数从 8 变 2）。
       内容真的比窗口高（正文写长了）时这条滚动条还会出现 —— 那时它是对的。 */

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
        getAnchor: () => railAnchor,
        onSelect: (id) => setRailNode(id),
        onAnchor: (id) => { railAnchor = id; rail?.render(); },
        onAddFrame: (id) => {
          addFrame(id);
          /* 刚记下的那一版直接显示出来（不然点了 ＋ 屏幕上什么都没变，像没生效） */
          railNode = id;
          const e = active();
          if (e) { states = statesOf(e); statesId = e.id; }
          if (!swapBody()) render(); else { bodySig = bodySignature(); rail?.render(); }
        },
        onDeleteFrame: (id) => deleteFrame(id),
      })
      : null;
    rail?.render();

    /* 切换才播入场（见 pendingEnter 的说明）。用**一次性错峰**而不是整块淡入 ——
       整块淡入会让整个面板"洗白一下"，还盖掉元素自己的错峰。两级：
       ① 顶层块：标题行 → 三栏主体 → 底部提示行；
       ② 左列条目：等主体那块到位（200ms）之后逐条浮现。
       store 订阅触发的重建仍然不播，避免改个字段就闪一下。 */
    if (pendingEnter) {
      pendingEnter = false;
      cascadeIn(host.querySelector<HTMLElement>('#cx-root'));
      cascadeIn(host.querySelector<HTMLElement>('#cx-list'), 60, 420, 200);
    }

    /* ── 事件 ── */
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
    /* 外部改动提示条：宿主刚被整块重建，把已有提示重画进来（提示是累积的，不因切条目而丢） */
    vaultNotices?.refresh();
    /* 中/右栏那一块的接线（编辑器 / 属性面板 / 字段行 / 各按钮）—— 与换类别时共用，见 wireBody */
    wireBody();
    /* 骨架重建完就把签名对齐，免得下一次 store 变化因为签名过期而白重建一次 */
    bodySig = bodySignature();
    /* 记下这版骨架是按哪一类建的：相同类别内换条目才敢走"只换内容"那条轻路径 */
    renderedMode = mode;
  }

  /** 把中/右栏那一块接上（建 tiptap、属性面板、字段行、各按钮）。
   *  `render()` 建完骨架调它；**换类别**只重造 `#cx-body` 之后也调它（见 mountBody）。
   *  两处各写一遍必漂移 —— 这一课抽公共属性面板时吃过。 */
  function wireBody(): void {
    const isEntity = mode === 'entity';
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
      /* 正文那两个小按钮（原来在「编辑器」工具里）：H1 = 当前段落设为一级标题；
         图片 = 弹文件框 → 导入 vault assets → 在光标处插入（所见即所得）。 */
      host.querySelector('#cx-h1')?.addEventListener('click', () => docEditor?.toggleHeading(1));
      host.querySelector('#cx-img')?.addEventListener('click', async () => {
        const api = (window as any).lingkuangAPI;
        if (!api?.importImage || !docEditor) return;
        const res = await api.importImage();
        if (res?.ok && res.path) { docEditor.insertImage(String(res.path)); say('已插入图片 ✓'); }
        else if (res?.canceled) { /* 用户取消，不提示 */ }
        else say(String(res?.error ?? '插入图片失败'), true);
      });
    }
    /* 外部改动提示条：宿主刚被整块重建，把已有提示重画进来（提示是累积的，不因切条目而丢） */
    vaultNotices?.refresh();
    /* 顺手校验这个节点的 .md 是否还带着「#正文：」标签（外部误删会破坏正文结构，
       见 `src/ui/vault-notice.ts`）。原来这一步在编辑器工具里，现在跟着工作台。 */
    if (nodeTarget) {
      const n = activeNode();
      if (n) void vaultNotices?.checkBodyTag(nodeTarget.world, nodeTarget.tlId, nodeTarget.nodeId, n.doc ?? '', n.title ?? '');
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
  }

  /** 换**类别**（时间线节点 ↔ 设定条目）时只重造 `#cx-body` 那一块。
   *  用户 2026-09-13：「从事件节点切换到实体节点时，事件节点保持选中状态，**且面板刷新**」——
   *  旧写法（`renderedMode !== mode` 就整块 `render()`）一次点击要付三样代价：左列那棵树重播一遍错峰、
   *  `#cx-root`（滚动容器）被换掉 ⇒ 滚动回顶、tiptap 重建。而中/右栏之外的东西**本来就不用动**：
   *  左树同时装着两类条目、顶栏只有那个「＋新建实体」要显隐、帧条元素常驻（节点模式藏起来）。
   *  所以这里只换内容 + 重新接线。返回 false = 骨架不在（调用方整块 render()）。 */
  function mountBody(prevHtml: string | null = null, animate = true): boolean {
    const body = host.querySelector<HTMLElement>('#cx-body');
    if (!body) return false;
    /* 旧编辑器/面板都住在这一块里：先结算正文（用旧 docTarget），再销毁。
       顺手收掉上一轮的幽灵层：它也在这一块里，留着会被 `body.innerHTML = …` 一起带走，
       而 `swapGhost` 还指着那个已被摘掉的节点（下一轮转场就会复用一个看不见的东西）。 */
    if (docEditor) { docEditor.flush(); docEditor.dispose(); docEditor = null; }
    dropGhost();
    docTarget = null;
    propsPanel = null;   /* 旧面板跟着旧 DOM 一起没了 */
    body.innerHTML = bodyHtml();
    const railHost = host.querySelector<HTMLElement>('#cx-rail');
    if (railHost) railHost.style.display = mode === 'entity' ? '' : 'none';
    const newBox = host.querySelector<HTMLElement>('#cx-newbox');
    if (newBox) newBox.style.display = mode === 'entity' ? 'flex' : 'none';
    wireBody();
    renderedMode = mode;
    /* 换类别也是"换文件"：同一套转场（旧内容往左退 → 新内容从右入）。放在 wireBody 之后 ——
       tiptap 得先建好，正文那一块才有东西可以逐行淡入。 */
    if (animate) playSwap(body, prevHtml);
    return true;
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

  /** ── 左栏那棵树 ──────────────────────────────────────────────────────────────
      一棵树同时装下**时间线节点**和**设定条目**，跟硬盘上的目录一一对应：
        世界 → 时间线 → 种类 → 节点      （= `<世界>/<时间线>/<种类>/<节点>.md`）
        世界 → `_设定` → 类型 → 实体     （= `<世界>/_设定/<类型>/<实体>.md`）
      **默认全展开**（那三个 collapsed* Set 记的是"被收起来的"）—— 用户 2026-09-13：
      「把全部改成文件树的形式，这样子也方便看」⇒ 打开左栏就该看到全部条目，点某一枝才收起。
      点任意一行 = 换中栏/右栏的目标（节点与实体都能点）。
      搜索非空时摊平成命中列表（节点 + 实体一起搜）。
      ⚠️ 种类/类型下"空着的"两类**待遇不同**，别顺手统一：
        ① 节点**种类**只列真有节点的（= 硬盘上真有这个目录）—— 用户 2026-09-13：
           「我指的是角色，地点，物品等文件夹同时存在于主线与设定文件夹下，是bug」；
        ② 实体**类型**列全部（含一个实体都没有的，置灰 + 一句人话）—— 类型是模型的一部分，
           新的类型要能在树里看见、点进去建第一个条目（用户要的「显示其他结构体」）。 */

  /** 树里的一行（`.ed-*` 类来自 `src/style.css`）。
   *  ⚠️ 用 `setAttribute('data-' + k)` 而不是 `dataset[k]`：带连字符的键（`cx-id`）走 dataset 会抛
   *  `SyntaxError: 'cx-id' is not a valid property name`（连字符后面跟小写字母是 dataset 的禁区）。 */
  function treeRow(cls: string, html: string, ds: Record<string, string>): HTMLElement {
    const d = document.createElement('div');
    d.className = 'ed-tnode ' + cls;
    d.innerHTML = html;
    for (const [k, v] of Object.entries(ds)) d.setAttribute('data-' + k, v);
    return d;
  }
  function emptyRow(text: string): HTMLElement {
    const d = document.createElement('div');
    d.className = 'ed-tempty';
    d.textContent = text;
    return d;
  }

  /** 只重画左列（那棵树）。搜索框在它外面，所以打字不会被重建、不丢焦点。 */
  function renderList(): void {
    const listEl = host.querySelector<HTMLElement>('#cx-list');
    if (!listEl) return;
    const frag = document.createElement('div');
    frag.className = 'ed-tree';

    if (query) {
      /* 搜索：节点与实体一起摊平（非空时不分层，跟列表视图节点的做法一致） */
      const nodeHits = searchNodes();
      const entHits = searchEntities();
      if (!nodeHits.length && !entHits.length) {
        listEl.innerHTML = '<div style="font-size:var(--text-xs);color:var(--fg-2);padding:4px;">没有匹配的条目。</div>';
        return;
      }
      nodeHits.forEach((h) => {
        const on = mode === 'node' && !!nodeTarget && nodeTarget.world === h.world && nodeTarget.tlId === h.tlId && nodeTarget.nodeId === h.node.id;
        frag.appendChild(treeRow('ed-tnode-item' + (on ? ' is-on' : ''),
          `<span class="ed-tlabel">${escapeHtml(h.node.title)}</span><span class="ed-tcount">${escapeHtml(h.kind)}</span>`,
          { act: 'node', nw: h.world, ntl: h.tlId, nid: h.node.id }));
      });
      entHits.forEach((h) => {
        const on = mode === 'entity' && store.activeWorld === h.world && h.entity.id === activeId;
        frag.appendChild(treeRow('ed-tnode-item' + (on ? ' is-on' : ''),
          `<span class="ed-tlabel">${escapeHtml(h.entity.name)}</span><span class="ed-tcount">${escapeHtml(typeNameOf(h.world, h.entity.typeId))}</span>`,
          { act: 'entity', nw: h.world, nid: h.entity.id, 'cx-id': h.entity.id, 'cx-type': typeNameOf(h.world, h.entity.typeId) }));
      });
      listEl.innerHTML = '';
      listEl.appendChild(frag);
      bindTreeClicks(frag);
      return;
    }

    const allGroups = tlGroups();
    const setAll = setGroups();
    const worlds = Object.keys(store.data.worldsets);
    if (!worlds.length) {
      listEl.innerHTML = '<div style="font-size:var(--text-xs);color:var(--fg-2);padding:4px;">还没有世界。</div>';
      return;
    }
    for (const wName of worlds) {
      const wOpen = isOpen(collapsedWorlds, wName);
      frag.appendChild(treeRow('ed-tworld' + (wOpen ? ' is-open' : ''),
        `<span class="ed-tcaret"></span><span class="ed-tlabel">${escapeHtml(wName)}</span>`,
        { act: 'world', nw: wName }));
      if (!wOpen) continue;

      /* ① 时间线分支 */
      for (const g of allGroups.filter((x) => x.world === wName)) {
        const tlKey = g.world + '::' + g.tlId;
        const tOpen = isOpen(collapsedTls, tlKey);
        const total = [...g.kinds.values()].reduce((n, l) => n + l.length, 0);
        frag.appendChild(treeRow('ed-ttl' + (tOpen ? ' is-open' : ''),
          `<span class="ed-tcaret"></span><span class="ed-tlabel">${escapeHtml(g.tlName)}</span><span class="ed-tcount">${total}</span>`,
          { act: 'tl', nw: g.world, ntl: g.tlId }));
        if (!tOpen) continue;
        for (const [kind, nodes] of g.kinds) {
          const kKey = tlKey + '::' + kind;
          const kOpen = isOpen(collapsedKinds, kKey);
          frag.appendChild(treeRow('ed-tkind' + (kOpen ? ' is-open' : ''),
            `<span class="ed-tcaret"></span><span class="ed-tlabel">${escapeHtml(kind)}</span><span class="ed-tcount">${nodes.length}</span>`,
            { act: 'tkind', nw: g.world, ntl: g.tlId, nk: kind }));
          if (!kOpen) continue;
          for (const n of nodes) {
            /* ⚠️ 高亮必须**同时**看「选的是谁」和「现在在编哪一类」——只是 nodeTarget 匹配的话，
               切到实体后这一行还亮着（用户 2026-09-13：「从事件节点切换到实体节点时，事件节点保持选中状态」）。 */
            const on = mode === 'node' && !!nodeTarget && nodeTarget.world === g.world && nodeTarget.tlId === g.tlId && nodeTarget.nodeId === n.id;
            frag.appendChild(treeRow('ed-tnode-item' + (on ? ' is-on' : ''),
              `<span class="ed-tlabel">${escapeHtml(n.title)}</span>`,
              { act: 'node', nw: g.world, ntl: g.tlId, nid: n.id }));
          }
        }
      }

      /* ② `_设定` 分支（实体）—— 与时间线平级 */
      const sg = setAll.find((x) => x.world === wName);
      if (sg) {
        const setKey = 'setting::' + wName;
        const sOpen = isOpen(collapsedTls, setKey);
        const total = sg.groups.reduce((n, t) => n + t.list.length, 0);
        frag.appendChild(treeRow('ed-tset' + (sOpen ? ' is-open' : ''),
          `<span class="ed-tcaret"></span><span class="ed-tlabel">_设定</span><span class="ed-tcount">${total}</span>`,
          { act: 'wset', nw: wName }));
        if (sOpen) {
          for (const t of sg.groups) {
            /* 类型行：一个实体都没有也列（置灰 + 展开时给一句人话） */
            const tKey = 'etype::' + wName + '::' + t.id;
            const tOpen = isOpen(collapsedKinds, tKey);
            frag.appendChild(treeRow('ed-ttype ed-tset-type' + (tOpen ? ' is-open' : '') + (t.list.length ? '' : ' is-empty'),
              `<span class="ed-tcaret"></span><span class="ed-tlabel">${escapeHtml(t.name)}</span><span class="ed-tcount">${t.list.length}</span>`,
              { act: 'etype', nw: wName, nk: t.id }));
            if (!tOpen) continue;
            if (!t.list.length) { frag.appendChild(emptyRow('这个类型还没有实体')); continue; }
            for (const e of t.list) {
              const on = mode === 'entity' && store.activeWorld === wName && e.id === activeId;
              /* `cx-id` / `cx-type` 是给测试与将来拖拽用的稳定抓手（树上不显示类型 —— 上一层文件夹
                 已经写着它了）；`[data-cx-id]` 这个属性名是历史约定，十几条 e2e 都按它找实体行。 */
              frag.appendChild(treeRow('ed-tnode-item' + (on ? ' is-on' : ''),
                `<span class="ed-tlabel">${escapeHtml(e.name)}</span>`,
                { act: 'entity', nw: wName, nid: e.id, 'cx-id': e.id, 'cx-type': typeNameOf(wName, e.typeId) }));
            }
          }
        }
      }
    }
    listEl.innerHTML = '';
    listEl.appendChild(frag);
    bindTreeClicks(frag);
  }

  function bindTreeClicks(frag: HTMLElement): void {
    frag.querySelectorAll<HTMLElement>('.ed-tnode').forEach((el) => {
      el.addEventListener('click', () => {
        const ds = el.dataset;
        if (ds.act === 'world') {
          toggleOpen(collapsedWorlds, ds.nw!);
          renderList();
        } else if (ds.act === 'tl') {
          toggleOpen(collapsedTls, ds.nw + '::' + ds.ntl);
          renderList();
        } else if (ds.act === 'tkind') {
          toggleOpen(collapsedKinds, ds.nw + '::' + ds.ntl + '::' + ds.nk);
          renderList();
        } else if (ds.act === 'wset') {
          toggleOpen(collapsedTls, 'setting::' + ds.nw);
          renderList();
        } else if (ds.act === 'etype') {
          toggleOpen(collapsedKinds, 'etype::' + ds.nw + '::' + ds.nk);
          renderList();
        } else if (ds.act === 'node') {
          switchTarget(() => {
            mode = 'node';
            nodeTarget = { world: ds.nw!, tlId: ds.ntl!, nodeId: ds.nid! };
          });
        } else if (ds.act === 'entity') {
          /* 树列的是**全部世界**的条目 ⇒ 换世界要先 setActiveWorld（`active()` 只看当前世界的 entities） */
          const w = ds.nw!;
          const id = ds.nid!;
          switchTarget(() => {
            if (store.activeWorld !== w) store.setActiveWorld(w);
            mode = 'entity';
            activeId = id;
            /* 这里**不动任何展开态**：点中谁就是编辑谁，跟"左栏此刻画成什么样"是两件事
               （旧版有两个页签 + 类型筛选，点条目时会顺手把它们改掉；那正是"混乱"的来源之一）。 */
          });
        }
      });
    });
  }

  /** 某个世界里某个类型显示叫什么（树会列出**全部世界**的实体，`typeName()` 只看当前世界） */
  function typeNameOf(wName: string, typeId: string): string {
    const t = (store.data.worldsets[wName] as any)?.entityTypes?.[typeId];
    return t?.name ?? typeId ?? '';
  }

  let torn = false;
  const unsub = store.subscribe(() => {
    if (torn) return;
    if (!host.isConnected || !host.querySelector('#cx-root')) { unsub(); return; }
    /* 物化结果缓存作废：数据可能被外部回扫换过（同一个实体 id，但帧/正文已不同） */
    statesId = '';
    /* 左列照旧重画：那一列没有编辑器，重建只花 DOM 钱，而且实体/节点增删必须立刻反映
       （展开态记在 collapsed* 三个 Set 里，重画不会把用户收起来的那几枝又撑开） */
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
  /* 设置里改了「设定演变」的模式/锁定点 → 视图与落点都要跟着变（锁定模式下视图钉在锁定那一格）。
     （左栏形态不再由设置决定：左栏只有一棵树，见文件顶部那段说明。） */
  const onSettings = (): void => {
    if (!railKey || !active()) return;
    /* `swapBody(false)`：改设置触发的重画**不演转场** —— 用户没在换文件，那一下动起来反而莫名 */
    if (!swapBody(false)) render();   /* swapBody 内部会 ensureRailSelection + 重画帧条 */
  };
  window.addEventListener('lingkuang-settings', onSettings);
  /* 外部改动提示条（原来长在「编辑器」工具里，工具下线时搬到 `src/ui/vault-notice.ts`）。
     **一次创建、活到切走**：提示是累积列表（key 去重），切条目不清 —— 用户得能看见哪个文件出过事。
     宿主元素延后取（`render()` 会整块重建 DOM），所以每次 render 之后要 `refresh()` 重画一遍。 */
  vaultNotices = createVaultNotices({
    getHost: () => host.querySelector<HTMLElement>('#cx-hint'),
    store,
    getCurrentNodeId: () => nodeTarget?.nodeId ?? '',
    say,
  });
  render();
  return () => {
    torn = true;
    unsub();
    dropGhost();   /* 转场里的幽灵层跟着工具一起收（它还挂在 #cx-body 上） */
    window.removeEventListener('lingkuang-settings', onSettings);
    vaultNotices?.dispose();
    vaultNotices = null;
    /* 切走工具时把未失焦的正文也结算掉，再销毁 tiptap 实例 */
    if (docEditor) { docEditor.flush(); docEditor.dispose(); docEditor = null; }
    if (msgTimer) window.clearTimeout(msgTimer);
  };
}
