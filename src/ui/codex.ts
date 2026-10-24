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
import { addEntity, addNode, removeEntity } from '../store/actions';
import { confirmDialog } from './confirm';
import { escapeHtml } from './html';
import { fieldRow } from './fields';
import { createDocEditor, type DocEditor } from './doc-editor';
import { createPropsPanel, type PropsPanel } from './props-panel';
import { createEvolutionRail, type Rail } from './evolution-rail';
import { createVaultNotices, type VaultNotices } from './vault-notice';
import { loadSettings } from './settings';
import { aiChat, type ChatMsg } from './ai';
import { setAgentFocus, setAgentFocusLive } from './agent-context';
import { lastTarget, rememberTarget } from './session';
import {
  epochOfNodes, frameDiff, nearestVersion, normalizeFrames, patchSummary, statesOf, versionAtNode, type EntityState,
} from '../store/evolution';
import { calendarOf, fromEpoch } from '../calendar';
import { cascadeIn, cloneIntoLayer, enter, flipRows, ghostLayerFor, motionReduced, rollText, rowLeaveAndRemove, rowSlideIn, rowsDropIn, rowsLeave, smoothBoxHeight, topsOf } from './motion';

const INP = 'flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 7px;font-size:var(--text-sm);outline:none;font-family:inherit;user-select:text;';
/* 顶栏那两组「下拉 + 新建按钮」共用同一份样式 —— 高度必须一模一样（27px），
   换类别时头行高度才不会变（用户 2026-09-13 深夜报过"切换时元素上下跳 7px"）。 */
const NEWSEL = 'background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 6px;font-size:var(--text-xs);outline:none;';
/** ⚠️ `display:inline-flex` + `align-items:center` 不是装饰 —— 里面的 `.lk-roll` 是个
 *  `overflow:hidden` 的行内块裁切盒，靠 `vertical-align` 摆位时它的中线和「＋新建」的基线
 *  并不在同一水平线上：实测裁切盒里的字比「＋新建」**低 1.81px**（用户 2026-09-14：
 *  「实体和节点两个字的位置偏下了」）。改成 flex 居中后两者字体框 top/bottom 完全相同（实测差值 0）。 */
const NEWBTN = 'background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-sm);padding:6px 14px;font-size:var(--text-xs);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;';
/** 一次建几个（用户 2026-09-13：「我希望能同时创建多个未填数据的实体或者节点」）。
 *  高度必须与 NEWSEL/NEWBTN 一致，否则又会长出"换类别跳 7px"那种问题。 */
const NEWNUM = 'width:46px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 6px;font-size:var(--text-xs);outline:none;text-align:center;';
/** 批量上限：一次建太多会一次落一屏 .md，也没人这么用 */
const NEW_MAX = 20;

/** AI 续写的系统提示 —— 三条都写死，是因为模型最爱犯的就是这三样：
 *  发明新专有名词、加"以下是续写"的客套、把设定写成说明书。 */
const AI_CONTINUE_SYS = '你在帮一位创作者写他的世界观设定。规则：只用下面给出的世界、设定、字段与已有正文，不要发明新的专有名词、势力或时间线；只输出正文段落本身（不要标题、不要解释、不要"以下是"）；200–400 字，人称与口吻跟已有正文一致。';

/** 给 AI 调用套一个硬超时：中转线首字节 20–60 秒是常态（用户实测），没有超时就会一直转圈。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`AI 超时（${Math.round(ms / 1000)} 秒）：中转首字节常常 20–60 秒，可到「设置 → 模型」换本地 Ollama 再试`)), ms);
    p.then(
      (v) => { window.clearTimeout(timer); resolve(v); },
      (e) => { window.clearTimeout(timer); reject(e); },
    );
  });
}

/** 正文写回哪个目标（编辑器跨条目复用，目标会变，所以是**读时取值**不是创建时捕获）。
 *  安全性由 `switchTarget` 保证：它一定先 `flush()`（此时 docTarget 还是旧目标）再改 docTarget。 */
type DocTarget = { kind: 'entity'; id: string } | { kind: 'node'; world: string; tlId: string; nodeId: string };

/** 节点身份（带 world —— 左列会列出**所有世界**的时间线，保存时必须写回它自己那个世界） */
interface NodeTarget { world: string; tlId: string; nodeId: string; }

export function renderCodex(store: Store, host: HTMLElement): () => void {
  host.style.overflow = 'hidden';
  let mode: 'entity' | 'node' = 'entity';
  let query = '';               /* 搜索词：实体按名字过滤，节点按标题过滤（非空时树摊平成命中列表） */
  /* 「待补稿」过滤（用户 2026-10-19 工作流评审：112 条实体里 106 条正文是空的，树上看不出来，
     于是永远想不起来补）。点搜索框右边那颗 chip 打开：左列换成一张「正文还空着」的清单。 */
  let draftOnly = false;
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
  /* 上次在编哪一条（`src/ui/session.ts`）：**挂载时就落位**，好让下面第一次 render 直接画它 ——
     这就是用户要的「进入灵框＝接着上次干活」。找不到那条（被删了 / 换了世界 / 换了数据目录）
     就当没有存档，走原来的默认（实体第一条）；绝不新建出来。 */
  {
    const want = lastTarget();
    const ws0 = store.data.worldsets[store.activeWorld];
    if (want?.kind === 'entity' && ws0?.entities?.[want.id]) {
      activeId = want.id;
    } else if (want?.kind === 'node' && ws0?.timelines?.[want.tlId]?.nodes.some((n) => n.id === want.nodeId)) {
      mode = 'node';
      nodeTarget = { world: store.activeWorld, tlId: want.tlId, nodeId: want.nodeId };
    }
  }
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

  /* ── 左树的行级动效（用户 2026-09-13：「新建实体和节点时不是硬切换，而是从左侧滑入…其下的
     所有节点都向下平滑移动（删除时也一样），展开文件夹时文件向下弹出」）──────────────────
     左树每次重画都是 `innerHTML` 整块换掉 ⇒ 元素是新建的、没有"旧位置"这个概念，CSS 表达不了。
     所以自己记一份**上一次布局**：行键 → 相对 top（`rowTops`），重画后拿它做 FLIP。
     键 = 行的 `data-cx-key`（`<act>|<id>`，见 `rowKey()`）。 */
  let rowTops = new Map<string, number>();
  /** 补位那一批**自己的**错峰：从上往下每行晚 14ms、封顶 120ms（与退场同档参数）。
   *  用户 2026-09-14：「文件夹收起后其下文件上移**错分方向反了**，应该是越高的越先移，
   *  现在是越下面的越先移」—— 原先所有补位的行共用一个延迟（整块一起上移），
   *  现在按"从上到下"的顺序逐行延迟（见 `motion.ts` 的 `flipRows`）。 */
  const FLIP_STEP = 14;
  const FLIP_MAX = 120;

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

  /** 批量改动（一次建 N 个 / 删一条）期间**先别重画左树**。
   *
   *  为什么（用户 2026-09-13：「新建实体和节点时不是硬切换，而是从左侧滑入」）：
   *  `addEntity()` 走 `store.update` ⇒ 订阅里**同步**就重画一次左树，随后 `switchTarget()`
   *  又把左树重画一次 —— 第一次刚起头的入场动画连一帧都没画出来，元素就被第二次重建顶掉了
   *  （两次重画在同一个 tick 里，浏览器中间根本不合成帧）。攒到末尾只画一次，动画才有机会演。
   *  只挡左树：中/右栏的签名判断等逻辑照旧（否则会漏掉真正需要重建的情况）。 */
  let listHold = 0;
  function withListHold(fn: () => void): void {
    listHold++;
    try { fn(); } finally { listHold--; }
  }

  /** 帧条的显隐（实体态展开 / 节点态收起）。
   *
   *  ⚠️ 收起的**高度要等演完再收**：`height: auto → 0` 不是可插值长度，过渡对它是瞬时生效的，
   *  而这一条有 `overflow: hidden` ⇒ 内容当场被裁没，宽度那 320ms 的收起根本看不见 ——
   *  用户 2026-09-13 报的「从设定文件切换到节点文件演变面板会直接消失」就是这个
   *  （实测：点下去同一 tick 里高已经 271 → 1，而宽才刚从 176 开始走）。
   *  420ms > 宽度/透明度的 320ms（那时候已经全透明，收高度看不出来）。 */
  function setRailOpen(open: boolean): void {
    const el = host.querySelector<HTMLElement>('#cx-rail');
    if (!el) return;
    el.classList.toggle('is-off', !open);
    if (open) { el.classList.remove('is-collapsed'); return; }
    window.setTimeout(() => {
      if (el.isConnected && el.classList.contains('is-off')) el.classList.add('is-collapsed');
    }, 420);
  }

  /** 「改动会写进哪一格」——**只算不写**。
   *  ⚠️ 不能拿 `editVersion()` 替代：它会建帧（自动模式）并把视图挪过去，那是副作用。 */
  function writeTargetNodeId(): string | null {
    const st = loadSettings();
    if (st.evolveMode === 'locked') {
      const lock = st.evolveLock;
      if (lock && lock.world === store.activeWorld) return lock.nodeId;
    }
    if (st.evolveMode === 'auto' && railAnchor !== null) return railAnchor;
    return railNode;   /* 手动 = 正在看的那一版（null = 初稿） */
  }

  /** 量一次左树各行当前的位置（相对左树容器），存成 FLIP 要的"旧位置"快照。
   *  **删除前必须先拍一张**：删掉当前条目会让正文签名变化 ⇒ 中途触发一次整块 `render()`，
   *  左树元素全被换掉 —— 只靠"上一次 renderList 留下的快照"会在这中间被冲掉（实测删完没有让位动画）。 */
  function snapshotRows(): Map<string, number> {
    const el = host.querySelector<HTMLElement>('#cx-list .ed-tree') ?? host.querySelector<HTMLElement>('#cx-list');
    const now = topsOf(el);
    return new Map(now.els.map((e, i) => [e.getAttribute('data-cx-key') || '', now.tops[i]]));
  }

  /** 让**还活着**的幽灵裁切层跟着左树的新高度一起缩（配 `src/style.css` 里 `.lk-ghost-layer` 的
   *  height 过渡，曲线与 `smoothBoxHeight` 同一档）。不这么做的话：外框在 320ms 里越缩越矮，
   *  而裁切层还停在旧高度 ⇒ 幽灵在后半程又"露"到框外面去了 —— 用户 2026-09-14 报的那件事只解决一半。
   *  ⚠️ 传进来的必须是**目标高度**：调用点上 `smoothBoxHeight` 已经把外框钉住了，此刻再量
   *  `getBoundingClientRect()` 拿到的是动画**起点**（实测：传元素进去时层高一直停在 327，外框已经到 132）。 */
  function syncGhostLayers(targetH: number): void {
    document.querySelectorAll<HTMLElement>('.lk-ghost-layer').forEach((lay) => { lay.style.height = `${targetH}px`; });
  }

  /** 清掉页面上**所有**左树幽灵层（连带动画一起取消）。
   *  用户 2026-10-24：「打开和收起时有时候会出现重叠」—— 根因之一就是两台幽灵叠在一起：
   *  收起 A 的退场还没演完又收起 B，`ghostLayerFor()` 又造一层，两层各自钉在原位 ⇒ 同一行字出现两份。
   *  现在同一时刻只允许一批：新的一批进来先把旧的整批收走（宁可截断上一段的尾巴，也不要重影）。 */
  function dropListGhosts(): void {
    document.querySelectorAll<HTMLElement>('.lk-ghost-layer').forEach((lay) => {
      for (const a of lay.getAnimations({ subtree: true })) { try { a.cancel(); } catch { /* 已取消 */ } }
      lay.remove();
    });
  }

  /** 被删掉的那一行：克隆一份**钉在原位**演一次退场，同时下面的行向上让位（FLIP）。
   *  克隆体住在**贴着左树的裁切层**里（`ghostLayerFor(#cx-list, 900)`）—— 不能直接挂 `#cx-list`（它马上
   *  会被 `innerHTML = ''` 清空），也不能裸挂 `document.body`（那样不受外框裁切，用户 2026-09-14 报的
   *  「关文件夹时部分文件会**超出这个框**」就是这么来的）。 */
  function pinRowGhost(id: string): HTMLElement | null {
    const row = host.querySelector<HTMLElement>('#cx-list [data-cx-id="' + id + '"]');
    const clip = host.querySelector<HTMLElement>('#cx-list');
    if (!row || !clip || motionReduced()) return null;
    dropListGhosts();
    const lay = ghostLayerFor(clip, 900);
    if (!lay) return null;
    /* 类名与"收起文件夹"那一批统一（`lk-list-ghost`）：测试与清理逻辑都按它认幽灵 */
    return cloneIntoLayer(lay.layer, lay.rect, row, 'lk-list-ghost');
  }

  /* ── 节点页签的数据源：世界 → 时间线 → 种类分组（＝ vault 的目录形状）──────────
     刻意遍历**所有世界**（不只 activeWorld）：左列是一棵树，树就该看得见全部；
     nodeTarget 带 world，所以编辑非活动世界的节点也会写回它自己的世界。 */
  interface TlGroup { world: string; tlId: string; tlName: string; kinds: Map<string, TimelineNode[]>; }
  function tlGroups(): TlGroup[] {
    const out: TlGroup[] = [];
    for (const [wName, w] of Object.entries(store.data.worldsets)) {
      /* 节点按**时间**排（和沙盘上从左到右的次序一致），不按数组顺序 —— 数组顺序会随 vault 回扫
         变成"文件夹 + 文件名"顺序，于是新建的节点先排在尾巴上、过一会儿又跳到别处
         （用户 2026-09-14：「新建节点时直接插入尾部然后移到正确的顺序，能不能直接插入到对应的位置」）。
         同一时刻的（比如一次连建的几个）按 id 排 —— id 是单调时钟（`src/store/ids.ts`），能保住创建次序。 */
      const ep = epochOfNodes(w);
      for (const tlId of (w.order ?? [])) {
        const tl = w.timelines[tlId];
        if (!tl) continue;
        const sorted = [...(tl.nodes ?? [])].sort(
          (a, b) => (ep.get(a.id) ?? 0) - (ep.get(b.id) ?? 0) || String(a.id).localeCompare(String(b.id))
        );
        const kinds = new Map<string, TimelineNode[]>();
        for (const n of sorted) {
          const k = n.kind || '事件';
          if (!kinds.has(k)) kinds.set(k, []);
          kinds.get(k)!.push(n);
        }
        out.push({ world: wName, tlId, tlName: tl.name, kinds });
      }
    }
    return out;
  }
  /** 顶栏那个「时间线 ▾」的选项 = 当前世界的全部时间线（`order` 在前，没进 order 的补在后面） */
  function newTimelines(): { id: string; name: string }[] {
    const ws = store.data.worldsets[store.activeWorld];
    if (!ws) return [];
    const ids = (ws.order ?? []).filter((id) => ws.timelines[id]);
    for (const id of Object.keys(ws.timelines ?? {})) if (!ids.includes(id)) ids.push(id);
    return ids.map((id) => ({ id, name: ws.timelines[id]?.name || '未命名' }));
  }
  /** 默认选中哪条时间线：**正在编的那个节点所在的那条**（同一个世界），否则第一条。
   *  用户 2026-09-13：「添加实体按钮在事件节点中其实可以改成添加节点的」——
   *  在工作台里新建的节点，理应落回你此刻正在看的那条时间线。 */
  function nodeNewTlId(): string {
    const list = newTimelines();
    const t = nodeTarget;
    if (t && t.world === store.activeWorld && list.some((x) => x.id === t.tlId)) return t.tlId;
    return list[0]?.id ?? '';
  }
  /** 新节点用哪种「种类」（决定它在 vault 里落进哪个文件夹、有哪些字段）：
   *  跟当前正在看的那条**同种类**（同一条时间线里）；否则 `事件`（= main.js 里 `kind` 缺省的兜底值、
   *  也是左树的分组口径）；再没有就用模板里的第一个。 */
  function nodeNewKind(tlId: string): string {
    const t = nodeTarget;
    if (t && t.tlId === tlId) {
      const cur = store.data.worldsets[t.world]?.timelines[t.tlId]?.nodes.find((n) => n.id === t.nodeId);
      if (cur?.kind) return cur.kind;
    }
    const fmts = Object.keys(store.data.formats ?? {});
    return fmts.length && !fmts.includes('事件') ? fmts[0] : '事件';
  }
  /** 新节点默认落在**时间指针**所在的那一年 —— 这样它从建出来的那一刻起就排在"对应的位置"上，
   *  而不是先挂在末尾、等你自己填了年份才跳过去。
   *  用户 2026-09-14：「新建节点时直接插入尾部然后移到正确的顺序，能不能直接插入到对应的位置」。
   *  指针没设过（`timeCursor` 为空）就退回 0，与 `addNode` 的缺省一致。 */
  function cursorYear(tlId: string): number {
    const ws = store.data.worldsets[store.activeWorld];
    const tl = ws?.timelines[tlId];
    const cursor = (ws as any)?.timeCursor;
    if (!tl || cursor === null || cursor === undefined || !Number.isFinite(Number(cursor))) return 0;
    const tp = fromEpoch(calendarOf(tl as any), Number(cursor)) as any;
    /* ⚠️ `fromEpoch` 返回的是 `{ anchor: { year }, values: {...} }`（不是顶层 `year`）——
       写成 `tp.year` 会静默拿到 undefined ⇒ 退回 0，新节点又落回最前面。 */
    const y = Number(tp?.anchor?.year ?? 0);
    return Number.isFinite(y) ? y : 0;
  }
  /** 「刚建出来还没填」的条目：名字还是 ＋新建 时给的占位名 ⇒ 左树里标一个「待填」，
   *  改过名（或者自己填了字段）就自动不当它是新的了。用户 2026-09-13：「我希望能同时创建多个
   *  未填数据的实体或者节点（**强调显示一下就行**）」。 */
  const isStub = (name: string | undefined): boolean => /^新(?:实体|节点)(?:[ ]?\d+)?$/.test(String(name ?? '').trim());
  /** 名字后面那个「待填」小标 —— 强调「这一条是刚建出来还没填的」 */
  const stubTag = (name: string | undefined): string => (isStub(name) ? '<span class="ed-ttag">待填</span>' : '');
  /** 正文（Markdown 本体）去掉标记后的字数 —— 只回答「有没有内容」，不追求精确字数。 */
  const docLen = (e: Entity): number => String(e.doc ?? '').replace(/[\s#>*_`~\-\[\]()!|]/g, '').length;
  /** 「还只是张卡」：正文不到 20 字。判据与 `.ed-tsub` 那轮一致 —— 字段填满但正文空 = 没成稿。 */
  const isDraft = (e: Entity): boolean => docLen(e) < 20;
  const draftTag = (e: Entity): string => (isDraft(e)
    ? '<span class="ed-ttag is-draft" title="正文还空着（不足 20 字）：点开补稿，或点搜索框右边的「待补稿」看全部">草稿</span>'
    : '');
  /** 左列 chip 上的数字：当前世界正文还空着的实体数 */
  const draftCount = (): number => entities().filter(isDraft).length;
  /** 「成稿」的门槛字数。`docLen` 已去掉 Markdown 标记，所以它约等于"看得见的字"。
   *  选 200 不选「20 字就算成稿」：20 只是"不再是空卡"的下限（左树「草稿」标签用它），
   *  200 才是"这条设定能拿去用"。两个数各有各的用途，别合并。 */
  const DONE_WORDS = 200;
  /** 正文完成度刻度（`docBar` 里那个 `#cx-meter`）：条 + 字数。
   *  只读内存里的 `doc`，不解析 HTML、不遍历全库 —— 每敲一次保存重画一次也 < 1ms。 */
  function syncMeter(): void {
    const el = host.querySelector<HTMLElement>('#cx-meter');
    if (!el) return;
    const e = active();
    if (!e) return;
    const n = docLen(e);
    const pct = Math.min(100, Math.round((n / DONE_WORDS) * 100));
    el.classList.toggle('is-done', n >= DONE_WORDS);
    el.title = n >= DONE_WORDS ? `正文 ${n} 字（已过 ${DONE_WORDS} 字的成稿线）` : `正文 ${n} 字 / 成稿线 ${DONE_WORDS} 字`;
    el.querySelector<HTMLElement>('.lk-meter__num')!.textContent = n >= DONE_WORDS ? `${n} 字 ✓` : `${n} / ${DONE_WORDS} 字`;
    el.querySelector<HTMLElement>('.lk-meter__bar i')!.style.width = pct + '%';
  }
  /** 条目行的类名：选中 + 待填，四处置（搜索命中两处 / 树上两处）都用它，免得各写一份 */
  const itemCls = (on: boolean, name: string | undefined): string =>
    'ed-tnode-item' + (on ? ' is-on' : '') + (isStub(name) ? ' is-stub' : '');
  /** 占位名要**唯一**：同名会写进同一个 `.md` 路径互相覆盖（`entityPath`/`nodePath` 都按名字定路径）。
   *  批量建 N 个时也靠它保证 新实体 1 / 2 / 3… 各不相同。 */
  function uniqueName(base: string, taken: Set<string>): string {
    if (!taken.has(base)) { taken.add(base); return base; }
    for (let i = 2; i < 9999; i++) {
      const n = base + ' ' + i;
      if (!taken.has(n)) { taken.add(n); return n; }
    }
    return base + ' ' + Date.now();
  }
  /** 顶栏那个「一次建几个」的输入框：1..NEW_MAX，读不出来就当 1 */
  function readCount(sel: string): number {
    const el = host.querySelector<HTMLInputElement>(sel);
    const n = Math.floor(Number(el?.value ?? 1));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, NEW_MAX) : 1;
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
        if (fr) {
          /* ⚠️ **类型不进版本差异**（用户 2026-09-14：「时间帧内为什么能修改实体的类型」）：
             类型是这条设定的**身份** —— 它决定 `.md` 落在 `_设定/<类型>/` 哪个文件夹里，
             而文件名只按初稿的名字算。让某一帧改类型 = 文件在旧文件夹里、界面却写着新类型，
             而且回扫（类型从文件夹名来）会把它顶回去 ⇒ 两边永远对不上。所以差异里恒用实体现有的
             typeId，改类型只作用于整条设定（见 `#cx-type` 的 change 处理器）。 */
          const norm = (s: EntityState): EntityState => ({ ...s, typeId: ent.typeId ?? s.typeId });
          fr.patch = (prev ? frameDiff(norm(prev), norm(next)) : null) ?? {};
        }
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
    return v === 0 ? '正在看：初稿' : `正在看：第 ${v} 版（锚在右边那格事件上）· 类型改的是整条设定，不记进版本`;
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
        syncMeter();          /* 正文字数刻度跟着这次保存走（AI 续写/手写同一条路） */
        pulseSaved();         /* 落盘的微光：不弹字、不打断，边缘亮一下 */
      } else {
        store.update((d) => {
          const n = d.worldsets[t.world]?.timelines?.[t.tlId]?.nodes.find((x) => x.id === t.nodeId);
          if (n) n.doc = md;
        });
        pulseSaved();
      }
    });
  }

  /** 落盘后的一次微光：正文框边缘亮一下再灭（700ms）。
   *  为什么不用 `say('已保存 ✓')`：那是**字**，每次失焦都弹一句会打断写作；
   *  这里的反馈不需要读，只要余光感觉到"存住了"。 */
  let savedTimer: number | undefined;
  function pulseSaved(): void {
    const el = host.querySelector<HTMLElement>('#cx-doc');
    if (!el) return;
    el.classList.remove('is-saved');
    void el.offsetWidth;                     /* 强制重排：连着写两次也能重播 */
    el.classList.add('is-saved');
    if (savedTimer) window.clearTimeout(savedTimer);
    savedTimer = window.setTimeout(() => el.classList.remove('is-saved'), 750);
  }

  /** 「AI 续写」—— 接着已有正文往下写，只往**这条设定**上落。
   *
   *  为什么是「续写」而不是「生成整条」：用户库里 112 条实体 106 条正文是空的，但空的原因
   *  不是不会起头，而是**写到一半断了**（字段卡填得齐全，正文一两句就停）。生成整张卡只会
   *  再造 65 张抽卡模板；接着写才是补上「最后一米」。
   *
   *  三条纪律：
   *   ① 上下文只给**已经存在的东西**（字段 + 已有正文结尾），prompt 里写死"不许发明新设定"；
   *   ② 结果走 `docEditor.append()` —— 一次可撤销的 transaction，**不覆盖**已有正文，
   *      不满意 Ctrl+Z 就没了；
   *   ③ 60 秒硬超时 + 失败走 `say()`（存在了 20–60 秒的中转、以及没配 Key 的两条路）。 */
  async function aiContinue(): Promise<void> {
    const btn = host.querySelector<HTMLButtonElement>('#cx-ai');
    if (!btn || btn.dataset.busy === '1') return;
    const e = active();
    const st = viewState();
    if (!e || !st) { say('先选一条设定再续写', true); return; }
    const cur = docEditor?.getDoc() ?? st.doc ?? '';
    btn.dataset.busy = '1';
    btn.disabled = true;
    btn.textContent = '续写中…';
    try {
      const fields = Object.entries(st.properties ?? {})
        .filter(([, v]) => v != null && String(v).trim())
        .slice(0, 12)
        .map(([k, v]) => `${k}：${String(v).slice(0, 60)}`)
        .join('；');
      const tail = cur.trim().slice(-1500);
      /* 正文还空着时不能叫"接着写"（没得接）—— 实测那样模型会凭空造一个角色出来。
         空稿走「按字段起开篇」，并且明说别新造人名/地名。 */
      const empty = cur.trim().length < 20;
      const msgs: ChatMsg[] = [
        { role: 'system', content: AI_CONTINUE_SYS },
        {
          role: 'user',
          content: [
            `【世界】${store.activeWorld}`,
            `【设定】${e.name || '未命名'}（${typeNameOf(store.activeWorld, st.typeId)}）`,
            `【字段】${fields || '（还没填）'}`,
            '',
            `【已有正文${tail ? '结尾' : ''}】`,
            tail || '（空）',
            '',
            empty
              ? '正文还空着。依据上面的设定字段写 2–4 段开篇（200–400 字），不要新造人名、地名或组织名。'
              : '接着上面往下写 200–400 字，不要引入尚未出现过的新专有名词。',
          ].join('\n'),
        },
      ];
      const reply = await withTimeout(aiChat(msgs, { temperature: 0.85, numPredict: 500 }), 60_000);
      /* `thinkingOnly` = 模型把预算全花在思考上、正文一个字没有。那种"字"不能当正文写进设定。 */
      if (reply.thinkingOnly) { say('这次模型只想了没写（思考占满预算）—— 再点一次，或换个模型', true); return; }
      const text = (reply.text || '').trim();
      if (!text) { say('AI 没返回内容，再点一次试试', true); return; }
      docEditor?.append(text);
      say('已续写 · 不满意可 Ctrl+Z 整段撤销');
    } catch (err) {
      say(err instanceof Error ? err.message : 'AI 续写失败', true);
    } finally {
      delete btn.dataset.busy;
      btn.disabled = false;
      btn.textContent = 'AI 续写';
    }
  }

  /** 换目标（换条目 / 换页签）：**先把正文结算掉再改选择**。
   *  反过来的话，`render()` 开头那次 flush 会把旧条目的正文写进新选中的条目 —— 实测过的坑。
   *  flush 之后不销毁编辑器：同模式内换条目走就地换内容（保留 tiptap 实例与滚动位置）。 */
  /** 上报「创作者此刻在编哪一条」给灵框助手（`src/ui/agent-context.ts`）。
   *  助手的上下文里那段「正在编 · 设定 / 事件」就是它喂的（字段 + 正文）。
   *  调用点只有两处：换目标之后、以及骨架每次画完（`syncNewBox()` 尾巴）——
   *  **不在 store 订阅里上报**（那条路每 360ms 走一次，白抖）。 */
  function reportAgentFocus(): void {
    const world = store.activeWorld;
    if (mode === 'entity') {
      const e = store.data.worldsets[world]?.entities?.[activeId];
      setAgentFocus(e ? { kind: 'entity', world, id: e.id, title: e.name } : null);
      return;
    }
    const tgt = nodeTarget;
    if (!tgt) { setAgentFocus(null); return; }
    const n = store.data.worldsets[tgt.world]?.timelines?.[tgt.tlId]?.nodes.find((x) => x.id === tgt.nodeId);
    setAgentFocus(n ? { kind: 'node', world: tgt.world, id: n.id, title: n.title } : null);
  }

  function switchTarget(mutate: () => void): void {
    if (docEditor) docEditor.flush();   /* 只结算，不 dispose（dispose 交给整块 render 那条路） */
    mutate();
    reportAgentFocus();
    /* 记下「正在编哪一条」（`src/ui/session.ts`）：下次进灵框直接停在这里。
       挂在这里是因为**所有**换目标的路都走 switchTarget（左树点行 / 新建后选中 / 删除后回退），
       而 `reportAgentFocus()` 那边的身份只有 { kind, id }、没带 tlId —— 节点态靠它恢复不了。 */
    rememberTarget(mode === 'entity'
      ? (activeId ? { kind: 'entity', id: activeId } : null)
      : (nodeTarget ? { kind: 'node', tlId: nodeTarget.tlId, nodeId: nodeTarget.nodeId } : null));
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
    /* 兜底：只认 `swapGhost` 一个变量的话，上一轮若因为窗口不可见/动画没推进而没被收掉，
       后面就会**叠着好几层旧内容**（实测：切到 B 时屏幕上还是 A 的标题与字段）。整片清干净。 */
    for (const g of Array.from(body.querySelectorAll('.lk-cx-ghost'))) g.remove();
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
      /* **不透明底**：幽灵压在正文上面，新内容在它下面。以前幽灵是透明的，退场时新旧两份字
         叠在一起（实测截图：同一个位置两行不同的名字），既看不清也像"闪了一下"。
         现在退场是一层"卡片淡出"，遮住新内容直到自己淡完 —— 任何时刻屏幕上只有一份字。 */
      ghost.style.background = 'var(--surface)';
      ghost.style.borderRadius = 'var(--radius-sm)';
      ghost.innerHTML = prevHtml;
      /* ⚠️ 克隆体里的 id 全部摘掉：`#cx-doc`/`#cx-fields`/`#cx-name` 各多出一份的话，
         `host.querySelector('#cx-fields')` 就可能抓到幽灵里那一份（接线/断言全线错位）。 */
      for (const el of Array.from(ghost.querySelectorAll('[id]'))) el.removeAttribute('id');
      body.appendChild(ghost);
      swapGhost = ghost;
      /* 退场 = **擦除**（wipe）：幽灵是一张不透明卡片，`clip-path` 从右往左把它裁掉，
         下面的新内容像被"揭开"一样露出来。
         为什么不是淡出：新旧两份字叠在同一片区域里，半透明期间会同时看到两个标题
         （实测截图：`日常` 与 `安德雅特斯山` 糊在一起）。擦除没有重叠区 —— 左边是新的、
         右边是旧的，中间只有一条边；也不会有空白帧。 */
      const exits = rowsLeave(rowsOf(ghost, false), { dx, step, dur, easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)' });
      const wipe = ghost.animate(
        [{ clipPath: 'inset(0 0 0 0%)' }, { clipPath: 'inset(0 0 0 100%)' }],
        { duration: dur, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'both' }
      );
      const kill = (): void => { if (swapGhost === ghost) dropGhost(); };
      /* 没有可动画的行（全被 display:none 滤掉）时别留一层静止的重复内容 —— 直接收掉 */
      Promise.all([...exits.map((a) => a.finished), wipe.finished]).then(kill).catch(() => { /* 被取消 */ });
      /* 兜底：隐藏窗口里动画不推进，`finished` 永远不来（README 铁律 6），这层幽灵不能留着 */
      window.setTimeout(kill, dur + step * 80 + 600);
    }
    /* 入场**不再有任何行级动画**（用户 2026-10-24：「把入场时的滑动也撤了吧」）：
       擦除揭开的就是最终态 —— 滑动会让被揭开的那部分还在移动，像"一边揭一边抖"。
       所以新内容先原地就位（`rowsEnter` 整段拿掉），动的只有上面那张正在被裁掉的旧卡片。 */
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
      syncSelection();       /* 只动高亮，**不重建树**（重建会打断正在演的展开动画） */
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
      /* 类型下拉里没有这个 id（外部的类型被删了）就别硬写 value —— 浏览器会把 select 落到第一个选项上。
         取的是**实体自己**的类型（不是这一版的）：类型是身份，不进版本差异。 */
      const curType = active()?.typeId ?? st.typeId;
      if (Array.from(typeEl.options).some((o) => o.value === curType)) typeEl.value = curType ?? '';
      fillEntityFields(fieldsEl, st);
      const vn = host.querySelector<HTMLElement>('#cx-vnote');
      if (vn) vn.textContent = versionNoteText();
      /* 同一实体停留时，别处新记的帧也要出现在「它出现在哪些事件」里 */
      const evEl = host.querySelector<HTMLElement>('#cx-events');
      if (evEl) renderEntityEvents(evEl);
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
      /* 同一节点上停留时，别处（帧条/别的设定）新记的版本也要出现在这块里 */
      const chEl = host.querySelector<HTMLElement>('#cx-changed');
      if (chEl) renderChangedBy(chEl);
      next = { kind: 'node', world: t.world, tlId: t.tlId, nodeId: t.nodeId };
      md = n.doc ?? '';
      void vaultNotices?.checkBodyTag(t.world, t.tlId, t.nodeId, n.doc ?? '', n.title ?? '');
    }
    docTarget = next;
    if (docEditor) docEditor.setDoc(md);   /* 同一个 tiptap 实例换文档，不销毁不重建 */
    syncMeter();                           /* 换到别一条：字数刻度跟着换 */
    syncSelection();                       /* 只动高亮：不重建树（用户 2026-10-24：切换文件时不该重建） */
    rail?.render();                        /* 右栏那条竖线：换实体/换版本要重画高亮与摘要 */
    syncNewType();                         /* 顶栏「新建的类型」跟着换到的这条走（见 syncNewType） */
    pendingEnter = false;                  /* 骨架没重建 ⇒ 不该有整块错峰 */
    bodySig = bodySignature();             /* 签名立刻对齐，否则下一次 store 变化会白重建一次 */
    playSwap(body, prevHtml);
    return true;
  }

  /** 正文那一行的标题 + 小按钮（H1 / 插图 / AI 续写）——
   *  这几个动作原来是「编辑器」工具专有的（`src/ui/editor.ts` 的 `#ed-h1` / `#ed-img`），
   *  并成工作台后搬到这里（实体与节点共用同一份）。
   *  **「AI 续写」只在实体页签出现**（用户 2026-10-24：设定卡写得出来才算成稿）；
   *  右边的 `#cx-meter` 是完成度刻度 —— 与左树「草稿」标签同一判据（正文 < 20 字 = 草稿）。 */
  const docBar = (label: string): string => `
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
      <span style="font-size:11px;color:var(--fg-2);">${label}</span>
      ${mode === 'entity' ? '<span id="cx-meter" class="lk-meter" title="正文字数（去掉符号的空字数）：200 字算成稿"><span class="lk-meter__num">0 字</span><span class="lk-meter__bar"><i></i></span></span>' : ''}
      <span style="margin-left:auto;display:flex;gap:4px;flex-shrink:0;">
        ${mode === 'entity' ? '<button id="cx-ai" title="让 AI 接着已有正文往下写 200–400 字（Ctrl+Z 可整段撤销）" style="background:transparent;border:1px solid var(--accent-ink);color:var(--accent-ink);border-radius:var(--radius-sm);padding:1px 8px;font-size:11px;cursor:pointer;">AI 续写</button>' : ''}
        <button id="cx-h1" title="把光标所在段落设为一级标题" style="background:transparent;border:1px solid var(--border);color:var(--fg-2);border-radius:var(--radius-sm);padding:1px 8px;font-size:11px;cursor:pointer;">H1</button>
        <button id="cx-img" title="插入图片（存进 vault 的 assets）" style="background:transparent;border:1px solid var(--border);color:var(--fg-2);border-radius:var(--radius-sm);padding:1px 8px;font-size:11px;cursor:pointer;">图片</button>
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
      if (!st) return '<div class="lk-empty lk-empty--sm"><div class="lk-empty__title">左边选一个实体</div><div class="lk-empty__hint">树里按类型分组；点一行就能在这里改字段和正文。</div></div>';
      /* 类型取**实体自己**的（不是这一版的）—— 类型是身份、不进版本差异，见 commitState 里那段 */
      const curType = active()?.typeId ?? st.typeId;
      return `
        <div data-cx-row style="display:flex;align-items:center;gap:8px;">
          <input id="cx-name" value="${escapeHtml(st.name)}" style="${INP}font-size:15px;font-weight:600;"/>
          <span style="font-size:var(--text-xs);color:var(--fg-2);flex-shrink:0;">类型</span>
          <select id="cx-type" title="类型是这条设定的身份（决定它落在 vault 的哪个文件夹）—— 改它作用于整条设定，不记进版本历史" style="flex-shrink:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-xs);outline:none;">${kinds.map((k) => `<option value="${escapeHtml(k)}"${k === curType ? ' selected' : ''}>${escapeHtml(typeName(k))}</option>`).join('')}</select>
          <button id="cx-del" style="margin-left:auto;flex-shrink:0;background:transparent;border:1px solid var(--danger);color:var(--danger);border-radius:var(--radius-sm);padding:3px 10px;font-size:var(--text-xs);cursor:pointer;">删除</button>
        </div>
        <div id="cx-vnote" data-cx-row style="font-size:var(--text-xs);color:var(--fg-2);margin-top:4px;">${escapeHtml(versionNoteText())}</div>
        <div id="cx-events" data-cx-row style="margin-top:10px;border-top:1px dashed var(--border-soft);padding-top:10px;"></div>
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
    if (!t || !n) return '<div class="lk-empty lk-empty--sm"><div class="lk-empty__title">左边选一个时间线节点</div><div class="lk-empty__hint">节点 = 你世界里的一个事件；中栏改属性与正文，右栏看它改变过谁。</div></div>';
    const tlName = store.data.worldsets[t.world]?.timelines[t.tlId]?.name ?? t.tlId;
    const kind = n.kind || '事件';
    return `
      <div id="cx-nodepath" data-cx-row style="font-size:var(--text-xs);color:var(--fg-2);margin-bottom:8px;">${escapeHtml(t.world)} · ${escapeHtml(tlName)} · ${escapeHtml(kind)}</div>
      <div id="cx-props" style="display:flex;flex-direction:column;gap:5px;"></div>
      <div id="cx-changed" data-cx-row style="margin-top:10px;border-top:1px dashed var(--border-soft);padding-top:10px;"></div>
      <div data-cx-row style="margin-top:10px;border-top:1px dashed var(--border-soft);padding-top:10px;">
        ${docBar('正文（Markdown · 失焦自动保存）')}
        <div id="cx-doc"></div>
      </div>`;
  }

  /** 「这件事改变了谁」—— 演变的反向视图。
   *
   *  演变本身是"一条设定挂在某个事件上的一版"（`Entity.frames[].nodeId`）。帧条把它**竖着列成一条线**
   *  （站在设定上看它经历过什么）；这里**倒过来看**：站在一个事件上，看它改动了哪些设定，并给个入口
   *  跳过去。数据本来就在（不用新字段），所以这一块只是"读 + 跳"，不新增存储。
   *  方向来自用户 2026-09-13 的选单（帧条的反向视图）。 */
  function changedRows(): { e: Entity; v: number; note: string }[] {
    const n = activeNode();
    if (!n) return [];
    const out: { e: Entity; v: number; note: string }[] = [];
    for (const e of Object.values(currentWorld(store)?.entities ?? {})) {
      const fr = (e.frames ?? []).find((f) => f.nodeId === n.id);
      if (!fr) continue;
      out.push({
        e,
        /* 第几版 = `versionAtNode` 的语义（这个节点上有帧就是它，否则往下取） */
        v: versionAtNode(e, epochOf, epochOf(n.id), n.id),
        note: patchSummary(fr.patch) || (fr.note ?? ''),
      });
    }
    /* 改得多的排前面（摘要长说明动得多），同长按名字 —— "这件事影响最大的是谁"一眼可见 */
    out.sort((a, b) => b.note.length - a.note.length || String(a.e.name ?? '').localeCompare(String(b.e.name ?? '')));
    return out;
  }

  /** 实体 → 事件：这条设定在哪些事件里被改过（= 它的 `frames[].nodeId` 挂在哪些节点上）。
   *  与上面 `changedRows()` 正好互为镜像：那边站在事件上看改过谁，这边站在设定上看被哪些事件改过。
   *  数据同样现成（不新增字段），所以这块只读 + 跳。
   *  ⚠️ 2026-10-19 评审实测：112 条实体 **0 条有帧** ⇒ 这块默认是空的，所以空态必须给一句人话 +
   *  一个明确去处，否则又是一个「看起来坏掉的空白区」。 */
  interface EntityEventRow { world: string; tlId: string; tlName: string; nodeId: string; title: string; note: string; epoch: number }
  function entityEventRows(): EntityEventRow[] {
    const e = active();
    if (!e) return [];
    const out: EntityEventRow[] = [];
    for (const [wName, w] of Object.entries(store.data.worldsets)) {
      const epochMap = epochOfNodes(w);
      for (const [tlId, tl] of Object.entries((w.timelines ?? {}) as Record<string, { name?: string; nodes?: TimelineNode[] }>)) {
        for (const n of tl.nodes ?? []) {
          const fr = (e.frames ?? []).find((f) => f.nodeId === n.id);
          if (!fr) continue;
          out.push({
            world: wName,
            tlId,
            tlName: tl.name ?? tlId,
            nodeId: n.id,
            title: n.title || '（未命名事件）',
            note: patchSummary(fr.patch) || (fr.note ?? ''),
            epoch: epochMap.get(n.id) ?? 0,
          });
        }
      }
    }
    /* 按时间排（同一刻就按标题）：这块读起来应该像「它的编年史」 */
    out.sort((a, b) => a.epoch - b.epoch || a.title.localeCompare(b.title, 'zh'));
    return out;
  }

  /** 只填 `#cx-events` 的 innerHTML（监听同样只在 `wireBody()` 里挂一次）。 */
  function renderEntityEvents(el: HTMLElement): void {
    if (!active()) { el.innerHTML = ''; return; }
    const rows = entityEventRows();
    const head = '<div style="display:flex;align-items:center;gap:6px;font-size:var(--text-xs);color:var(--fg-2);margin-bottom:2px;">'
      + '<span>它出现在哪些事件</span>'
      + (rows.length ? `<span style="opacity:.7;">${rows.length} 个</span>` : '')
      + '</div>';
    if (!rows.length) {
      el.innerHTML = head + '<div class="ed-tempty" style="padding-left:0;">还没有挂在任何事件上。要让这条设定随时间变化：在右栏那条竖线上「＋ 记一帧」，或在某个事件的「这件事改变了谁」里反向改它 —— 两种做法都会在这里留下一行。</div>';
      return;
    }
    el.innerHTML = head + rows.map((r) => `
      <button data-cx-evt="${escapeHtml(r.world + '|' + r.tlId + '|' + r.nodeId)}" title="跳到这个事件"
        style="display:flex;align-items:center;gap:6px;width:100%;text-align:left;background:var(--surface-2);border:1px solid var(--border-soft);border-radius:var(--radius-sm);padding:4px 7px;margin-top:4px;cursor:pointer;color:var(--fg);font-size:var(--text-xs);font-family:inherit;">
        <span style="font-weight:600;flex-shrink:0;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(r.title)}</span>
        <span style="color:var(--fg-2);flex-shrink:0;">${escapeHtml(r.tlName)}</span>
        <span style="color:var(--fg-2);opacity:.85;margin-left:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(r.note || '记了一版')}</span>
      </button>`).join('');
  }

  /** 只填 `#cx-changed` 的 innerHTML。⚠️ 点击监听**在 `wireBody()` 里只挂一次** ——
   *  轻路径 `swapBody()` 会反复刷这一块（同一个元素），在这里挂就会一层层叠监听。 */
  function renderChangedBy(el: HTMLElement): void {
    const n = activeNode();
    if (!n) { el.innerHTML = ''; return; }
    const rows = changedRows();
    const head = '<div style="display:flex;align-items:center;gap:6px;font-size:var(--text-xs);color:var(--fg-2);margin-bottom:2px;">'
      + '<span>这件事改变了谁</span>'
      + (rows.length ? `<span style="opacity:.7;">${rows.length} 条设定</span>` : '')
      + '</div>';
    if (!rows.length) {
      el.innerHTML = head + '<div class="ed-tempty" style="padding-left:0;">这个事件还没有改变任何设定。想记的话：在左边选中一条设定，在它右边那条时间线上点「＋ 记一帧」，事件选这一个。</div>';
      return;
    }
    el.innerHTML = head + rows.map(({ e, v, note }) => `
      <button data-cx-goto="${escapeHtml(e.id)}" title="跳到这条设定在这个事件之后的样子"
        style="display:flex;align-items:center;gap:6px;width:100%;text-align:left;background:var(--surface-2);border:1px solid var(--border-soft);border-radius:var(--radius-sm);padding:4px 7px;margin-top:4px;cursor:pointer;color:var(--fg);font-size:var(--text-xs);font-family:inherit;">
        <span style="font-weight:600;flex-shrink:0;">${escapeHtml(e.name || '未命名')}</span>
        <span style="color:var(--fg-2);flex-shrink:0;">${escapeHtml(typeNameOf(store.activeWorld, e.typeId))}</span>
        <span style="color:var(--fg-2);flex-shrink:0;">第 ${v} 版</span>
        <span style="color:var(--fg-2);opacity:.85;margin-left:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(note || '记了一版')}</span>
      </button>`).join('');
  }

  /** 跳到"这条设定在这个事件之后的样子"：`railNode` **直接钉在这个节点上**（不是"离指针最近的那一版"），
   *  `railKey` 一起设 ⇒ `ensureRailSelection()` 里 `railKey !== e.id` 不成立，不会把这一版挪走。 */
  function jumpToEntityVersion(id: string): void {
    const nodeId = nodeTarget?.nodeId ?? null;
    if (!currentWorld(store)?.entities?.[id]) return;
    switchTarget(() => {
      mode = 'entity';
      activeId = id;
      railNode = nodeId;
      railKey = id;
      if (nodeId) railAnchor = nodeId;   /* 「记到」也跟着挪过来：接着改就是改这一版 */
    });
    say(nodeId ? '已跳到它在这个事件之后的样子 ✓' : '已跳到这条设定 ✓');
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
    /* 顶栏那组控件**两种类别下都要渲染出来**（各自只藏不拆，见 `syncNewBox()`）：
       少了它，节点态的头行会矮 7px（28 → 21），下面所有元素跟着上下跳一下。
       用户 2026-09-13：「添加实体按钮在事件节点中其实可以改成添加节点的，毕竟万一用户不知道
       添加事件节点要在世界沙盒怎么办」⇒ 节点态换成同一套长相的「时间线 ▾ + 数量」。
       ⚠️ 2026-09-14 两处改动（用户：「新建实体左边两个按钮有什么用」「新建实体按钮里面实体和节点
       文字的切换做成类似老虎机的上下切换」）：
        · 每个控件前面加一个说明性小标签（类型 / 时间线 / 数量）—— 原来那两个控件长得像按钮，
          没说清是干什么的；
        · **按钮只有一个**（`#cx-new`，标签会像老虎机一样上下滚），两组只各自带自己的「下拉 + 数量」。
          两个按钮交替显隐的话，"实体→节点"那两个字的切换是**换了个元素**，没法演滚字。 */
    const newCtl = kinds.length
      ? `<span class="lk-newlbl">类型</span><select id="cx-new-type" title="新实体的类型（默认跟着你正在编的那条走）" style="${NEWSEL}">${kinds.map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(typeName(k))}</option>`).join('')}</select>
         <span class="lk-newlbl">数量</span><input id="cx-new-count" type="number" min="1" max="${NEW_MAX}" step="1" value="1" title="一次建几个（最多 ${NEW_MAX}）" style="${NEWNUM}"/>`
      : '';
    const tlNewOpts = newTimelines();
    const nodeCtl = `<span class="lk-newlbl">时间线</span><select id="cx-new-tl" title="新节点放进哪条时间线（默认跟着你正在编的那条走）" style="${NEWSEL}">${
      tlNewOpts.map((t) => `<option value="${escapeHtml(t.id)}"${t.id === nodeNewTlId() ? ' selected' : ''}>${escapeHtml(t.name)}</option>`).join('')
    }</select>
      <span class="lk-newlbl">数量</span><input id="cx-new-node-count" type="number" min="1" max="${NEW_MAX}" step="1" value="1" title="一次建几个（最多 ${NEW_MAX}）" style="${NEWNUM}"/>`;

    host.innerHTML = `
      <div class="cx-root lk-page lk-page--lg" style="padding:14px 16px 12px;display:flex;flex-direction:column;gap:8px;height:100%;overflow:auto;" id="cx-root">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <div style="font-size:17px;font-weight:600;color:var(--fg);">设定库</div>
          <span style="font-size:var(--text-xs);color:var(--fg-2);">「${escapeHtml(store.activeWorld || '（未选世界）')}」的条目 · 字段由模板决定（在左栏「结构体管理」里改模板）</span>
          <span id="cx-newbox" style="margin-left:auto;gap:6px;align-items:center;display:flex;">
            <span id="cx-new-entity" style="gap:6px;align-items:center;display:${isEntity ? 'flex' : 'none'};">${newCtl}</span>
            <span id="cx-new-node" style="gap:6px;align-items:center;display:${isEntity ? 'none' : 'flex'};">${nodeCtl}</span>
            <button id="cx-new" style="${NEWBTN}" data-off-entity="${kinds.length ? '' : '1'}" data-off-node="${tlNewOpts.length ? '' : '1'}">＋新建<span class="lk-roll"><span class="lk-roll__t">${isEntity ? '实体' : '节点'}</span></span></button>
          </span>
        </div>
        <div id="cx-hint" style="display:none;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:rgba(217,101,92,.12);font-size:var(--text-xs);color:var(--fg);line-height:1.5;"></div>
        <div style="display:flex;gap:12px;align-items:flex-start;">
          <div style="width:250px;flex-shrink:0;display:flex;flex-direction:column;gap:6px;border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px;">
            <div style="display:flex;gap:4px;align-items:center;">
              <input id="cx-search" placeholder="搜索设定与事件…" style="${INP};flex:1;min-width:0;" value="${escapeHtml(query)}"/>
              <button id="cx-draft" class="lk-chip${draftOnly ? ' is-on' : ''}" data-on="${draftOnly ? '1' : ''}" title="只看正文还空着的条目（不足 20 字）" style="flex-shrink:0;cursor:pointer;background:none;">待补稿 ${draftCount()}</button>
            </div>
            <div id="cx-list" style="display:flex;flex-direction:column;gap:1px;"></div>
          </div>
          <div id="cx-body" style="flex:1;min-width:0;border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;position:relative;">
            ${bodyHtml()}
          </div>
          <!-- 右栏那条竖线**常驻**（节点模式只是藏起来）—— 换类别时就不用动骨架，见 mountBody -->
          <div id="cx-rail" class="lk-rail${isEntity ? '' : ' is-off is-collapsed'}" title="演变：站在某个事件上看这条设定"></div>
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
        /* 「改动会写进哪一格」——帧条据此点亮那一行 + 挂「改这里」标签（见 writeTargetNodeId） */
        getWriteTarget: () => writeTargetNodeId(),
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
    /* 「待补稿」开关：只重画左列（骨架不动），chip 自己记着开没开 */
    host.querySelector('#cx-draft')?.addEventListener('click', () => {
      draftOnly = !draftOnly;
      const chip = host.querySelector<HTMLElement>('#cx-draft');
      chip?.classList.toggle('is-on', draftOnly);
      renderList();
    });
    /* 实体态那个「＋新建实体」：类型默认跟着**你正在编的那条**（`syncNewType()`），
       点一下建 1..NEW_MAX 个占位条目（用户 2026-09-13：「我希望能同时创建多个未填数据的实体」），
       名字自动取唯一（新实体 / 新实体 2 / …）—— 同名会写进同一个 `.md` 路径互相覆盖。 */
    const createEntities = (): void => {
      const sel = host.querySelector('#cx-new-type') as HTMLSelectElement | null;
      const typeId = sel?.value ?? '';
      if (!typeId) return;
      const n = readCount('#cx-new-count');
      const taken = new Set(entities().map((e) => e.name || ''));
      const ids: string[] = [];
      /* 建的过程先别重画左树（`withListHold`）：`addEntity` 每次都会触发一次重画，
         而后面 `switchTarget()` 还会再画一次 —— 两次落在同一个 tick 里，新建那几行的
         「从左侧滑入」连一帧都画不出来就被顶掉了（用户看到的就是"硬切换"）。 */
      withListHold(() => {
        for (let i = 0; i < n; i++) ids.push(addEntity(store, { typeId, name: uniqueName('新实体', taken) }));
      });
      switchTarget(() => { activeId = ids[0]; });   /* 选**第一个**：按顺序往下填 */
      say(n > 1 ? `已新建 ${n} 个，改个名字吧` : '已新建，改个名字吧');
    };
    /* 节点态那个「＋新建节点」：**直接建**（和「＋新建实体」同一套手感 —— 用户 2026-09-13：
       「添加节点就直接添加节点吧，就像添加实体一样」），建完在工作台里选中它，
       名字/时间/字段就在中栏改。节点落进 vault 的 `<时间线>/<种类>/新节点.md`。
       ⚠️ `year` 取**时间指针**那一年（`cursorYear`）—— 否则新节点 `year: 0`，排在哪里全看
       数组顺序：先是挂在尾巴上，等你填了年份才跳到"对应的位置"（用户 2026-09-14 报的）——
       左树现在按时间排（`tlGroups`），给对年份它就**一次到位**。 */
    const createNodes = (): void => {
      const sel = host.querySelector('#cx-new-tl') as HTMLSelectElement | null;
      const tlId = sel?.value ?? '';
      if (!tlId) return;
      const n = readCount('#cx-new-node-count');
      const kind = nodeNewKind(tlId);
      const year = cursorYear(tlId);
      const taken = new Set((store.data.worldsets[store.activeWorld]?.timelines[tlId]?.nodes ?? []).map((x) => x.title || ''));
      const ids: string[] = [];
      withListHold(() => {   /* 同「＋新建实体」：攒到末尾一次重画，新行才演得出"从左侧滑入" */
        for (let i = 0; i < n; i++) ids.push(addNode(store, tlId, { title: uniqueName('新节点', taken), kind, year }));
      });
      switchTarget(() => {
        mode = 'node';
        nodeTarget = { world: store.activeWorld, tlId, nodeId: ids[0] };
      });
      say(n > 1 ? `已新建 ${n} 个，改个名字吧` : '已新建，改个名字吧');
    };
    /* 顶栏那**一个**按钮：建实体还是建节点看你此刻在编哪一类（按钮上的字也跟着换，见 syncNewBox）。
       用户 2026-09-14：「新建实体按钮里面实体和节点文字的切换做成类似老虎机的上下切换」——
       原来两个按钮交替显隐，换的是**元素**，滚字无从谈起。 */
    host.querySelector('#cx-new')?.addEventListener('click', () => {
      if (mode === 'entity') createEntities(); else createNodes();
    });
    /* 外部改动提示条：宿主刚被整块重建，把已有提示重画进来（提示是累积的，不因切条目而丢） */
    vaultNotices?.refresh();
    /* 中/右栏那一块的接线（编辑器 / 属性面板 / 字段行 / 各按钮）—— 与换类别时共用，见 wireBody */
    wireBody();
    /* 顶栏那组「类型 + ＋新建实体」按当前类别显隐（只藏不拆，见 syncNewBox） */
    syncNewBox();
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
      /* **类型作用于整条设定**（不走 `patchVersion`）：它是这条设定的身份，决定 `.md` 落在
         `_设定/<类型>/` 哪个文件夹里，而路径只按初稿的名字算 ⇒ 让某一帧改类型，文件会留在旧
         文件夹里、而界面写着新类型，回扫（类型从文件夹名来）又把它顶回去。
         用户 2026-09-14：「时间帧内为什么能修改实体的类型」⇒ 现在不论站在哪一版，改类型都是
         改这条设定本身（与 `commitState` 里"差异恒用实体现有 typeId"是同一件事的两半）。 */
      if (sel.value === (active()?.typeId ?? '')) return;
      withQuiet(() => {
        store.update((d) => {
          const e = d.worldsets[store.activeWorld]?.entities?.[activeId];
          if (e) e.typeId = sel.value;
        });
      });
      statesId = '';   /* 物化缓存作废：类型影响每一版的状态 */
      /* 换类型 → 按新模板补字段（由 src/main.ts 的 ensureEntityLayer 统一做） */
      window.dispatchEvent(new CustomEvent('lingkuang-formats-changed'));
      say('已换类型（作用于整条设定，不记进版本）✓');
      if (!swapBody(false)) render();
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
    /* 「这件事改变了谁」（节点侧的反向视图）：填内容 + **只在这儿挂一次**点击
       （跳到那条设定在这个事件之后的样子）。轻路径 `swapBody()` 只重填内容，不重挂监听。 */
    const changedEl = host.querySelector<HTMLElement>('#cx-changed');
    if (changedEl) {
      renderChangedBy(changedEl);
      changedEl.addEventListener('click', (ev) => {
        const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-cx-goto]');
        const id = b?.dataset.cxGoto;
        if (id) jumpToEntityVersion(id);
      });
    }
    /* 「它出现在哪些事件」（实体侧的反向视图，与上面那块互为镜像）：
       点一行跳到那个事件（跨世界/跨时间线都认，因为行里带着 world|tlId|nodeId）。 */
    const eventsEl = host.querySelector<HTMLElement>('#cx-events');
    if (eventsEl) {
      renderEntityEvents(eventsEl);
      eventsEl.addEventListener('click', (ev) => {
        const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-cx-evt]');
        const raw = b?.dataset.cxEvt;
        if (!raw) return;
        const parts = raw.split('|');
        const [w, tl, nid] = parts;
        if (!w || !tl || !nid) return;
        nodeTarget = { world: w, tlId: tl, nodeId: nid };
        switchTarget(() => { mode = 'node'; });
        say('已跳到那个事件 ✓');
      });
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
      syncMeter();
      /* 正文那两个小按钮（原来在「编辑器」工具里）：H1 = 当前段落设为一级标题；
         图片 = 弹文件框 → 导入 vault assets → 在光标处插入（所见即所得）。 */
      host.querySelector('#cx-h1')?.addEventListener('click', () => docEditor?.toggleHeading(1));
      /* 「AI 续写」：只在实体页签有这颗按钮（节点正文由沙盘那边管），点了就走 aiContinue() */
      host.querySelector('#cx-ai')?.addEventListener('click', () => { void aiContinue(); });
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
        /* 被删的那一行先克隆一份钉在原位（`#cx-list` 马上会被重画清空，所以幽灵挂在 body 上），
           下面的行由 FLIP 平滑补位 —— 用户 2026-09-13：「新建实体和节点时…其下的所有节点都向下
           平滑移动（删除时也一样）」。 */
        const ghost = pinRowGhost(c.id);
        rowTops = snapshotRows();                        /* 先拍旧位置：让位动画要靠它（见 snapshotRows） */
        withListHold(() => removeEntity(store, c.id));   /* 攒到末尾一次重画，让位动画才演得出来 */
        switchTarget(() => { activeId = ''; });
        rowLeaveAndRemove(ghost, { dx: 24, dur: 260 });
        say('已删除');
      });
    });
  }

  /** 顶栏那组控件**只藏不拆**（两组都在骨架里，按类别显隐）。
   *
   *  用户 2026-09-13 深夜：「事件节点和设定实体切换时，元素 y 坐标会变，**应该是增加实体按钮的
   *  出现与消失导致的**」—— 量下来正是如此：那个按钮高 28px，而头行的文字只有 21px，
   *  `display:none` 之后头行从 28 变 21 ⇒ **下面所有元素（三栏行 / 左树 / 中右栏）跟着上下跳 7px**。
   *  所以两组都渲染出来，只切**组自身**的 `display`：两边都是「一个下拉 + 一个按钮」的同一套样式
   *  （下拉 21px + 按钮 27px ⇒ 行高恒 28px），外面那行的高度不变。
   *  隐藏那一组里的控件同时 `disabled` —— 隐藏元素仍然吃**程序化** `.click()`，
   *  不禁用的话节点态下还能凭空建出一个实体（反之亦然）。 */
  function syncNewBox(): void {
    const isEntity = mode === 'entity';
    for (const [sel, on] of [['#cx-new-entity', isEntity], ['#cx-new-node', !isEntity]] as [string, boolean][]) {
      const g = host.querySelector<HTMLElement>(sel);
      if (!g) continue;
      g.style.display = on ? 'flex' : 'none';
      for (const el of Array.from(g.querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>('button,select,input'))) {
        /* `data-off` = 这控件本来就不能用（比如这个世界一条时间线都没有），显隐不该把它打开 */
        el.disabled = !on || el.hasAttribute('data-off');
      }
    }
    /* 共用那个按钮：能不能按看**当前这一类**建不建得出来（没有实体类型 / 没有时间线就不能）。
       按钮上「＋新建」是**不动的前缀**，滚的只有后面那两个字（用户 2026-09-14：「我希望滚动的
       只有实体和节点两个字」）—— 前缀跟着滚会让整串字一起上下跑，两行字在裁切盒里叠在一起看着发糊。 */
    const btn = host.querySelector<HTMLButtonElement>('#cx-new');
    if (btn) {
      const off = btn.getAttribute(isEntity ? 'data-off-entity' : 'data-off-node') === '1';
      btn.disabled = off;
      btn.title = off
        ? (isEntity ? '这个世界还没有设定类型（去「结构体管理」加一个）' : '这个世界还没有时间线 —— 先去世界沙盘建一条')
        : (isEntity ? '新建设定条目（类型 / 数量看左边）' : '新建时间线节点（时间线 / 数量看左边）');
      rollText(btn.querySelector<HTMLElement>('.lk-roll'), isEntity ? '实体' : '节点');
    }
    syncNewType();
    /* 骨架重画一律收尾在这一句上（render() 与 mountBody() 都会走到）⇒ 助手那边「正在编」跟着刷新 */
    reportAgentFocus();
  }

  /** 顶栏那个「类型 ▾」跟着**你正在编的那条**走：换条目 / 换类别 / 换了它的类型之后自动对上。
   *  用户 2026-09-13：「我想要当前选中的是哪个分类就自动在当前分类下创建实体」。
   *  你手动改选之后只要不换目标就保持你选的（同步只在 `render()` 与 `mountBody()` 这两条路上跑）。 */
  function syncNewType(): void {
    const sel = host.querySelector<HTMLSelectElement>('#cx-new-type');
    if (!sel || mode !== 'entity') return;
    const cur = active()?.typeId ?? '';
    if (cur && Array.from(sel.options).some((o) => o.value === cur)) sel.value = cur;
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
    /* 帧条改成**常驻 + .is-off**（原来是 `display:none` 硬切 —— 面板宽度瞬间变化，
       用户 2026-09-13：「演变窗口消失时编辑页的切换很生硬…顺便再给演变做一下出入场动画」）。
       常驻还顺手让"展开/收起"有过渡可演（CSS 在 `.lk-rail` / `.lk-rail.is-off`）。
       ⚠️ 收起时高度**等演完再收**（`setRailOpen`）—— 直接写 `height: 0` 会瞬时生效，
       被 `overflow: hidden` 一裁，用户看到的就是"直接消失"（见 setRailOpen 的注释）。 */
    setRailOpen(mode === 'entity');
    syncNewBox();
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

  /** 只重画左列（那棵树）。搜索框在它外面，所以打字不会被重建、不丢焦点。
   *
   *  行级动效（用户 2026-09-13：「新建实体和节点时不是硬切换，而是从左侧滑入（就像正文的入场一样），
   *  其下的所有节点都向下平滑移动（删除时也一样），展开文件夹时文件向下弹出」）：
   *    · **新出现的行**分两种 —— 展开文件夹露出来的 ⇒ 向下弹出（`rowsDropIn`）、真新建出来的
   *      ⇒ 从左侧滑入（`rowSlideIn`，靠 `justOpened` 这个键分辨）；
   *    · **其余行**位置变了 ⇒ FLIP（`flipRows`，用上一次的 `rowTops` 快照），这就是"下面的行平滑让位"。
   *  左树每次都是 `innerHTML` 整块换掉（元素是新建的、没有旧位置），所以位置快照必须自己存。 */
  /** 只同步「哪一行是选中的」——**不重建树**。
   *  用户 2026-10-24：「切换文件时有时候会重建文件树」：swapBody() 原来调 renderList()（整棵
   *  innerHTML 重建），每点一条都要付一次 DOM 重建，正在演的展开动画也会被打断。 */
  function syncSelection(): void {
    const listEl = host.querySelector<HTMLElement>('#cx-list');
    if (!listEl) return;
    for (const el of Array.from(listEl.querySelectorAll<HTMLElement>('.ed-tnode-item'))) {
      const ds = el.dataset;
      const on = ds.act === 'entity'
        ? mode === 'entity' && store.activeWorld === ds.nw && ds.nid === activeId
        : mode === 'node' && !!nodeTarget && nodeTarget.world === ds.nw && nodeTarget.tlId === ds.ntl && nodeTarget.nodeId === ds.nid;
      el.classList.toggle('is-on', on);
    }
  }

  /** 树要不要重建：只认**结构/文字**（世界、时间线、节点标题与种类、实体名/类型/副类型/草稿态）。
   *  ⚠️ 不把正文长度放进来（每次击键都变 ⇒ 打着字重建左树）；选中态也不在（走 syncSelection()）。 */
  function treeSignature(): string {
    const out: string[] = [];
    for (const [wName, ws] of Object.entries(store.data.worldsets)) {
      out.push('w:' + wName);
      for (const tlId of ws.order ?? []) {
        const tl = ws.timelines?.[tlId];
        if (!tl) continue;
        out.push('t:' + tlId + ':' + (tl.name ?? ''));
        for (const n of tl.nodes ?? []) out.push('n:' + n.id + ':' + (n.title ?? '') + ':' + (n.kind ?? ''));
      }
      for (const e of Object.values(ws.entities ?? {})) {
        out.push('e:' + e.id + ':' + (e.name ?? '') + ':' + (e.typeId ?? '') + ':' + (isDraft(e) ? 1 : 0) + ':' + String(e.properties?.['类型'] ?? ''));
      }
    }
    return out.join('\n');
  }
  let lastTreeSig = '';

  function renderList(): void {
    if (listHold) return;                     /* 批量改动期间攒着，末尾一次画完（见 withListHold） */
    const listEl = host.querySelector<HTMLElement>('#cx-list');
    if (!listEl) return;
    lastTreeSig = treeSignature();            /* 记下这一版的结构签名（store 订阅据此决定要不要重建） */
    /* "最外面那个框"自己的高度也要平滑（用户 2026-09-14：「文件树**最外面的框**也要做平滑切换」）：
       外框高度是内容撑的，收起一个文件夹时它**同一 tick** 就从 327px 缩到 23px。先在改动前把旧高度量下来，
       末尾交给 `smoothBoxHeight()` 演到新高度（动画期间它会临时 `overflow:hidden`，把行裁在框里）。 */
    const boxBefore = listEl.getBoundingClientRect().height;
    const prev = rowTops;
    const cold = prev.size === 0;             /* 本会话第一次画（或刚整块重建）⇒ 全都别演，否则整个列表飞一遍 */
    const frag = document.createElement('div');
    frag.className = 'ed-tree';
    /* 两种"新出现的行"分开收 */
    const revealed: HTMLElement[] = [];
    const fresh: HTMLElement[] = [];
    /** 给一行打上稳定键（FLIP 用），并按"是展开露出来的还是新建的"归档 */
    const keep = (el: HTMLElement, key: string, inReveal = false): HTMLElement => {
      el.setAttribute('data-cx-key', key);
      if (!prev.has(key)) (inReveal ? revealed : fresh).push(el);
      return el;
    };
    /** 收尾：换进 DOM → 接线 → 演行级动效 → 存下这一次的位置快照 */
    const done = (): void => {
      listEl.innerHTML = '';
      listEl.appendChild(frag);
      bindTreeClicks(frag);
      const now = topsOf(frag);
      /* 外框的**目标**高度要在这里量（还没被 `smoothBoxHeight` 钉住，量到的是自然高度）——
         幽灵裁切层跟着它缩，见 `syncGhostLayers()`。 */
      const boxAfter = listEl.getBoundingClientRect().height;
      const keys = now.els.map((el) => el.getAttribute('data-cx-key') || '');
      if (!cold) {
        /* 补位的行**越高的越先移**（`step`）：收起文件夹时它下面的整片会一行行"被抽上去"，
           而不是整块平移（用户 2026-09-14 的第二条） */
        /* dur 240（默认 320）：展开时新行要等让位演完才落，320+错峰 ≈ 440ms 的"空一拍"太明显；
           240 已经够看清楚"下面的行让开了"，总等待压到 ~300ms 以内。 */
        const flips = flipRows(now.els, keys, now.tops, prev, { step: FLIP_STEP, maxDelay: FLIP_MAX, dur: 240 });
        /* 展开露出来的那批**等让位演完再落**（用户 2026-10-24：「打开和收起时有时候会出现重叠」）：
           以前两件事同一帧起跑 —— 下面的行还在从旧位置往下滑，新行已经在最终位置淡入，
           中间那一段就是"两行字压在一起"。现在入场延迟 = 让位动画真正结束的时刻（严格先让位、后露出），
           跟收起那条「先出后补」是同一个口径。
           `delay` 走 WAAPI 的 delay + `fill:'both'` ⇒ 等待期间新行保持透明，不会先亮出来再演。 */
        const flipTotal = flips.reduce((m, a) => {
          const t = a.effect?.getTiming?.();
          return Math.max(m, Number(t?.delay ?? 0) + Number(t?.duration ?? 0));
        }, 0);
        if (revealed.length) rowsDropIn(revealed, { delay: flipTotal });
        /* 新建的那几行（不是展开露出来的）仍在让位之后滑入，避免同上重叠 */
        fresh.forEach((el, i) => rowSlideIn(el, { delay: flipTotal + Math.min(i * 30, 240) }));
      }
      rowTops = new Map(keys.map((k, i) => [k, now.tops[i]]));
      smoothBoxHeight(listEl, boxBefore);     /* 外框高度也演（同上，用户 2026-09-14 的第一条） */
      syncGhostLayers(boxAfter);              /* 幽灵的裁切层跟着外框一起缩，不然后半段又会露到框外 */
    };

    /* 待补稿：把所有世界「正文还空着」的实体摊平成一张清单（搜索优先，两者互斥）。
       渲染复用搜索那一支的扁平行 + FLIP，所以收/展的动画行为跟搜索完全一致。 */
    if (draftOnly && !query) {
      const hits: { world: string; entity: Entity }[] = [];
      for (const [wName, w] of Object.entries(store.data.worldsets)) {
        for (const e of Object.values((w.entities ?? {}) as Record<string, Entity>)) {
          if (!w.entityTypes?.[e.typeId] && !wName) continue;
          if (isDraft(e)) hits.push({ world: wName, entity: e });
        }
      }
      hits.sort((a, b) => (a.world.localeCompare(b.world, 'zh') || (a.entity.name || '').localeCompare(b.entity.name || '', 'zh')));
      if (!hits.length) {
        listEl.innerHTML = '<div style="font-size:var(--text-xs);color:var(--fg-2);padding:4px;">没有待补稿的条目：每条实体的正文都写过了。</div>';
        rowTops = new Map();
        smoothBoxHeight(listEl, boxBefore);
        return;
      }
      hits.forEach((h) => {
        const on = mode === 'entity' && store.activeWorld === h.world && h.entity.id === activeId;
        const meta = typeNameOf(h.world, h.entity.typeId);
        frag.appendChild(keep(treeRow(itemCls(on, h.entity.name),
          `<span class="ed-tlabel">${escapeHtml(h.entity.name)}</span>${stubTag(h.entity.name)}<span class="ed-tcount">${escapeHtml(meta)}</span>`,
          { act: 'entity', nw: h.world, nid: h.entity.id, 'cx-id': h.entity.id, 'cx-type': meta }),
          'entity|' + h.world + '::' + h.entity.id));
      });
      done();
      return;
    }

    if (query) {
      /* 搜索：节点与实体一起摊平（非空时不分层，跟列表视图节点的做法一致） */
      const nodeHits = searchNodes();
      const entHits = searchEntities();
      if (!nodeHits.length && !entHits.length) {
        listEl.innerHTML = '<div style="font-size:var(--text-xs);color:var(--fg-2);padding:4px;">没有匹配的条目。</div>';
        rowTops = new Map();
        smoothBoxHeight(listEl, boxBefore);   /* 这条早退路径也要演，否则搜不到东西时框会"啪"地缩 */
        return;
      }
      nodeHits.forEach((h) => {
        const on = mode === 'node' && !!nodeTarget && nodeTarget.world === h.world && nodeTarget.tlId === h.tlId && nodeTarget.nodeId === h.node.id;
        frag.appendChild(keep(treeRow(itemCls(on, h.node.title),
          `<span class="ed-tlabel">${escapeHtml(h.node.title)}</span>${stubTag(h.node.title)}<span class="ed-tcount">${escapeHtml(h.kind)}</span>`,
          { act: 'node', nw: h.world, ntl: h.tlId, nid: h.node.id }), 'node|' + h.world + '::' + h.node.id));
      });
      entHits.forEach((h) => {
        const on = mode === 'entity' && store.activeWorld === h.world && h.entity.id === activeId;
        frag.appendChild(keep(treeRow(itemCls(on, h.entity.name),
          `<span class="ed-tlabel">${escapeHtml(h.entity.name)}</span>${stubTag(h.entity.name)}${draftTag(h.entity)}<span class="ed-tcount">${escapeHtml(typeNameOf(h.world, h.entity.typeId))}</span>`,
          { act: 'entity', nw: h.world, nid: h.entity.id, 'cx-id': h.entity.id, 'cx-type': typeNameOf(h.world, h.entity.typeId) }),
          'entity|' + h.world + '::' + h.entity.id));
      });
      done();
      return;
    }

    const allGroups = tlGroups();
    const setAll = setGroups();
    const worlds = Object.keys(store.data.worldsets);
    if (!worlds.length) {
      listEl.innerHTML = '<div style="font-size:var(--text-xs);color:var(--fg-2);padding:4px;">还没有世界。</div>';
      rowTops = new Map();
      return;
    }

    /* ── 树 = 嵌套的「行 + 孩子容器」（2026-10-24 重写）──────────────────────────────
       旧实现是**平铺**的行 + 幽灵层 + FLIP + 错峰，靠"时序"拼出「打开/收起」：
       收起时克隆一份幽灵钉在原位退场、下面的行延后 FLIP 补位。平铺结构里**没有"一枝"这个东西**，
       所以只能靠时间对齐来假装；只要有一次重画插进来，时序就错开 ⇒ 同一行字两份（就是那个"重叠"）。
       现在改成**结构上正确**的做法：每一枝 = 一行 + 一个 `.ed-kids` 孩子容器，收起/展开只动
       容器的高度。行始终在正常文档流里 ⇒ **不可能重叠**；也不需要幽灵、FLIP、错峰、延时。 */
    const kidsBox = (): HTMLElement => { const d = document.createElement('div'); d.className = 'ed-kids'; return d; };
    const branch = (key: string, open: boolean, row: HTMLElement, kids: HTMLElement): HTMLElement => {
      const el = document.createElement('div');
      el.className = 'ed-branch';
      el.setAttribute('data-branch', key);
      row.classList.toggle('is-open', open);
      if (!open) kids.style.display = 'none';   /* 收起：不占位，也不吃掉后续行的高度 */
      el.append(row, kids);
      return keep(el, 'branch|' + key);
    };

    for (const wName of worlds) {
      const wOpen = isOpen(collapsedWorlds, wName);
      const wRow = treeRow('ed-tworld', `<span class="ed-tcaret"></span><span class="ed-tlabel">${escapeHtml(wName)}</span>`, { act: 'world', nw: wName });
      const wKids = kidsBox();

      /* ① 时间线分支 */
      for (const g of allGroups.filter((x) => x.world === wName)) {
        const tlKey = g.world + '::' + g.tlId;
        const tOpen = isOpen(collapsedTls, tlKey);
        const total = [...g.kinds.values()].reduce((n, l) => n + l.length, 0);
        const tRow = treeRow('ed-ttl', `<span class="ed-tcaret"></span><span class="ed-tlabel">${escapeHtml(g.tlName)}</span><span class="ed-tcount">${total}</span>`, { act: 'tl', nw: g.world, ntl: g.tlId });
        const tKids = kidsBox();
        for (const [kind, nodes] of g.kinds) {
          const kKey = tlKey + '::' + kind;
          const kOpen = isOpen(collapsedKinds, kKey);
          const kRow = treeRow('ed-tkind', `<span class="ed-tcaret"></span><span class="ed-tlabel">${escapeHtml(kind)}</span><span class="ed-tcount">${nodes.length}</span>`, { act: 'tkind', nw: g.world, ntl: g.tlId, nk: kind });
          const kKids = kidsBox();
          for (const n of nodes) {
            const on = mode === 'node' && !!nodeTarget && nodeTarget.world === g.world && nodeTarget.tlId === g.tlId && nodeTarget.nodeId === n.id;
            kKids.appendChild(treeRow('ed-tnode-item' + (on ? ' is-on' : '') + (isStub(n.title) ? ' is-stub' : ''),
              `<span class="ed-tlabel">${escapeHtml(n.title)}</span>${stubTag(n.title)}`,
              { act: 'node', nw: g.world, ntl: g.tlId, nid: n.id }));
          }
          tKids.appendChild(branch('tkind|' + kKey, kOpen, kRow, kKids));
        }
        wKids.appendChild(branch('tl|' + tlKey, tOpen, tRow, tKids));
      }

      /* ② `_设定` 分支（实体）—— 与时间线平级 */
      const sg = setAll.find((x) => x.world === wName);
      if (sg) {
        const setKey = 'setting::' + wName;
        const sOpen = isOpen(collapsedTls, setKey);
        const total = sg.groups.reduce((n, t) => n + t.list.length, 0);
        const sRow = treeRow('ed-tset', `<span class="ed-tcaret"></span><span class="ed-tlabel">_设定</span><span class="ed-tcount">${total}</span>`, { act: 'wset', nw: wName });
        const sKids = kidsBox();
        for (const t of sg.groups) {
          const tKey = 'etype::' + wName + '::' + t.id;
          const tOpen = isOpen(collapsedKinds, tKey);
          const tRow = treeRow('ed-ttype ed-tset-type' + (t.list.length ? '' : ' is-empty'), `<span class="ed-tcaret"></span><span class="ed-tlabel">${escapeHtml(t.name)}</span><span class="ed-tcount">${t.list.length}</span>`, { act: 'etype', nw: wName, nk: t.id });
          const tKids = kidsBox();
          if (!t.list.length) tKids.appendChild(emptyRow('这个类型还没有实体'));
          for (const e of t.list) {
            const on = mode === 'entity' && store.activeWorld === wName && e.id === activeId;
            /* 副类型：真实类别写在 properties['类型'] 里时，行尾挂一颗小药丸（与文件夹同名就不重复画） */
            const subRaw = e.properties?.['类型'];
            const sub = typeof subRaw === 'string' ? subRaw.trim() : '';
            const folderName = typeNameOf(wName, e.typeId);
            /* data-cx-id / data-cx-type 是 e2e 与将来拖拽的稳定抓手（历史上按它找实体行） */
            tKids.appendChild(treeRow('ed-tnode-item' + (on ? ' is-on' : '') + (isStub(e.name) ? ' is-stub' : ''),
              `<span class="ed-tlabel">${escapeHtml(e.name)}</span>${stubTag(e.name)}${draftTag(e)}${sub && sub !== folderName ? `<span class="ed-tsub" title="这条的「类型」字段（结构体里的分类口径，与所在文件夹不一定是同一个词）">${escapeHtml(sub)}</span>` : ''}<span class="ed-thover" title="正文字数（去掉 Markdown 符号）">${docLen(e)} 字</span>`,
              { act: 'entity', nw: wName, nid: e.id, 'cx-id': e.id, 'cx-type': folderName }));
          }
          sKids.appendChild(branch('etype|' + tKey, tOpen, tRow, tKids));
        }
        wKids.appendChild(branch('wset|' + wName, sOpen, sRow, sKids));
      }
      frag.appendChild(branch('world|' + wName, wOpen, wRow, wKids));
    }
    done();
  }
  /** 展开/收起一个孩子容器：**只动高度**，DOM 不重建。
   *  - 打开：display 恢复 → height 0 → 内容自然高 → 结束后把 height 交还给 CSS（auto）
   *  - 收起：从当前高 → 0 → 结束后 display:none
   *  行始终在正常文档流里随容器一起被裁 → 任何时刻都不会有两行叠在同一个位置。 */
  function animateKids(kids: HTMLElement, open: boolean): void {
    for (const a of kids.getAnimations()) { try { a.cancel(); } catch { /* 已取消 */ } }
    const rows = Array.from(kids.querySelectorAll<HTMLElement>('.ed-tnode'));
    if (motionReduced()) {
      kids.style.display = open ? '' : 'none';
      kids.style.height = '';
      kids.style.overflow = '';
      return;
    }
    if (open) {
      kids.style.display = '';
      const h = kids.scrollHeight;          /* ⚠️ 必须在 display 恢复之后量（否则是 0 ⇒ 看起来"没动画"） */
      kids.style.overflow = 'hidden';
      /* 展开 = 容器撑开 **+ 行向下弹出（一行比一行晚 12ms）**。
         行只有 transform/opacity、不动布局 ⇒ 不会互相压住（第一百一十六轮那条前提仍成立）。 */
      const rowAnims = rowsDropIn(rows, { dy: 8, dur: 220, step: 12, maxDelay: 180 });
      const rowTotal = rowAnims.reduce((m, x) => { const t = x.effect?.getTiming(); return Math.max(m, Number(t?.delay ?? 0) + Number(t?.duration ?? 0)); }, 0);
      const anim = kids.animate([{ height: '0px' }, { height: h + 'px' }], { duration: Math.max(220, rowTotal), easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
      anim.onfinish = () => { kids.style.height = ''; kids.style.overflow = ''; };
      anim.oncancel = () => { kids.style.height = ''; kids.style.overflow = ''; };
    } else {
      const h = kids.getBoundingClientRect().height;
      kids.style.overflow = 'hidden';
      /* 收起 = 行往上收起（一行比一行晚 10ms）+ 容器同时收到 0 */
      const rowAnims = rowsLeave(rows, { dy: 8, dur: 160, step: 10, maxDelay: 140, easing: 'cubic-bezier(0.25, 0.7, 0.3, 1)' });
      const rowTotal = rowAnims.reduce((m, x) => { const t = x.effect?.getTiming(); return Math.max(m, Number(t?.delay ?? 0) + Number(t?.duration ?? 0)); }, 0);
      const anim = kids.animate([{ height: h + 'px' }, { height: '0px' }], { duration: Math.max(160, rowTotal), easing: 'cubic-bezier(0.25, 0.7, 0.3, 1)' });
      anim.onfinish = () => { kids.style.display = 'none'; kids.style.height = ''; kids.style.overflow = ''; };
    }
  }


  function bindTreeClicks(frag: HTMLElement): void {
    frag.querySelectorAll<HTMLElement>('.ed-tnode').forEach((el) => {
      el.addEventListener('click', () => {
        const ds = el.dataset;

        /* 展开/收起 = 只动这一枝的 `.ed-kids` 高度（不重画、不造幽灵、不 FLIP）⇒ 行永远在各自位置上。 */
        const toggle = (key: string, set: Set<string>, row: HTMLElement): void => {
          const kids = row.closest('.ed-branch')?.querySelector<HTMLElement>(':scope > .ed-kids');
          const open = !isOpen(set, key);
          toggleOpen(set, key);
          row.classList.toggle('is-open', open);
          if (kids) animateKids(kids, open);
        };
        if (ds.act === 'world') toggle(ds.nw!, collapsedWorlds, el);
        else if (ds.act === 'tl') toggle(ds.nw + '::' + ds.ntl, collapsedTls, el);
        else if (ds.act === 'tkind') toggle(ds.nw + '::' + ds.ntl + '::' + ds.nk, collapsedKinds, el);
        else if (ds.act === 'wset') toggle('setting::' + ds.nw, collapsedTls, el);
        else if (ds.act === 'etype') toggle('etype::' + ds.nw + '::' + ds.nk, collapsedKinds, el);
        else if (ds.act === 'node') {
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
    /* 左列：**只有结构/文字变了才重建**，否则只同步高亮（2026-10-24）。
       以前每次 store 通知都整棵重建 —— 自动落盘每隔几百毫秒来一次，于是"切文件时树会重建"、
       正在演的展开动画也被打断。 */
    if (treeSignature() !== lastTreeSig) renderList(); else syncSelection();
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
    setAgentFocusLive(false);   /* 工具切走：**不清空**助手的焦点，只降级成「最近在看」——
                                   否则创作者去看一眼沙盘再问「这个文件」，助手就只剩世界名可说（2026-09-18 用户实测） */
    vaultNotices = null;
    /* 切走工具时把未失焦的正文也结算掉，再销毁 tiptap 实例 */
    if (docEditor) { docEditor.flush(); docEditor.dispose(); docEditor = null; }
    if (msgTimer) window.clearTimeout(msgTimer);
  };
}
