/** 灵框 · 壳 UI（世界栏 + 工具栏 + 沙盘）——AE 风：圆角少、工具感强 */
import type { Store } from '../store/store';
import { listTools, openTool, disposeCurrentTool } from '../tools/registry';
import type { Tool } from '../tools/registry';
import { registerAllTools } from '../tools/register';
import { mountTimeline } from './timeline';
import { renderNodeDetail } from './detail';
import { escapeHtml } from './html';
import { addTimeline, addWorld, removeTimeline, removeWorld, undoWithVault, redoWithVault } from '../store/actions';
import { confirmDialog, promptDialog } from './confirm';
import { currentWorld } from '../store/store';
import { renderNodeForm } from './node-form';
import { staggerIn, tweenNumber } from './motion';
import { setAgentFocus, setAgentView } from './agent-context';
import { rememberTool } from './session';

export function renderShell(store: Store, host: HTMLElement): void {
  registerAllTools();

  host.innerHTML = `
    <div class="lk-app">
      <div class="lk-alerts" id="lk-alerts" style="display:none;"></div>
      <main class="lk-main">
        <nav class="lk-toolbar" id="lk-toolbar"></nav>
        <div class="lk-right">
          <header class="lk-worldbar">
            <div class="lk-worldbar-tabs" id="lk-world-tabs"></div>
          </header>
          <section class="lk-sandbox" id="lk-sandbox">
            <div class="lk-pane lk-pane-timeline" id="lk-pane-timeline">
              <div class="lk-pane-head"></div>
              <div class="lk-pane-body lk-placeholder">时间线视图</div>
            </div>
            <div class="lk-split" id="lk-split" role="separator" aria-orientation="horizontal" tabindex="0"
                 aria-label="拖动调整时间线与地图的上下比例；双击收起/展开地图"
                 title="拖动调整上下比例（双击收起/展开地图）"></div>
            <div class="lk-pane lk-pane-map" id="lk-pane-map">
              <div class="lk-pane-head">地图 <span class="lk-ph">手绘 / 生成地形</span><button class="lk-tl-tab is-new" id="lk-map-toggle" title="收起地图，让时间线独占全高">收起</button></div>
              <div class="lk-pane-body lk-placeholder">地图视图</div>
            </div>
          </section>
        </div>
        <aside class="lk-tool-host" id="lk-tool-host"></aside>
        <div class="lk-module-view" id="lk-module-view" style="display:none;"></div>
      </main>
    </div>`;

  renderWorldTabs(store);
  renderToolbar(store);
  renderTimelineTabs(store);
  const timelineBody = document.getElementById('lk-pane-timeline')?.querySelector('.lk-pane-body') as HTMLElement;
  mountTimeline(store, timelineBody, (node) => {
    /* 沙盘上点开一个事件：助手那边的「他此刻在看哪一条」要跟着走
       —— 用户 2026-09-18：「时间轴面板也要让它能看到我在哪个文件」。
       `view: 'timeline'` 让上下文里写「在哪：世界沙盘的时间线上」，跟设定库工作台区分开。 */
    setAgentFocus({ kind: 'node', world: currentWorld(store).name, id: node.id, title: node.title, view: 'timeline' });
    const toolHost = document.getElementById('lk-tool-host');
    if (!toolHost) return;
    const tlId = store.activeTimeline && currentWorld(store).timelines[store.activeTimeline]
      ? store.activeTimeline
      : (currentWorld(store).order ?? []).find((id) => currentWorld(store).timelines[id]) || Object.keys(currentWorld(store).timelines)[0];
    renderNodeDetail(store, toolHost, node, tlId, () => {
      /* 删除/改时间后刷新时间线（store 已变，subscribe 自动 render） */
    });
  });
  /* 地图 pane 实装 */
  const mapBody = document.getElementById('lk-pane-map')?.querySelector('.lk-pane-body') as HTMLElement;
  if (mapBody) {
    mapBody.classList.remove('lk-placeholder');
    import('./map').then((m) => m.renderMap(store, mapBody));
  }
  mountSandboxSplit();
  store.subscribe(() => {
    renderWorldTabs(store);
    renderTimelineTabs(store);
  });
}

/* 世界栏签名缓存：与时间线页签同理 —— renderWorldTabs 挂在 store 订阅里，
   拖动节点时每帧被调一次，无条件重写 innerHTML 会每帧重建整个世界栏并重绑监听。 */
let worldTabsSig = '';

/* ══════════ 上下分割（第一百二十二轮）══════════
   方案里那条「上下分割可拖拽 + 地图可折叠，比例存 localStorage」。
   以前是写死的 `flex:1 / flex:1`：地图太挤只能改代码重开，时间线太挤再改回来
   （设计稿里作者为此单次 5 分钟、近一月 6 次）。
   做法：**只改 flex-grow**（basis 固定 0），不写 height —— 地图那边靠 ResizeObserver
   `fitView()`，改 flex 它自然会重新量；写 height 反而会与它的观测打架。
   比例是**会话态**（这台机器看这张图的习惯），存 localStorage，不进数据文件。 */
const SPLIT_KEY = 'lingkuang-split';
const SPLIT_COLLAPSED_KEY = 'lingkuang-split-collapsed';
const SPLIT_MIN = 0.18;      /* 再小时间线就放不下标尺 + 节点名了 */
const SPLIT_MAX = 0.82;      /* 再小地图只剩一条缝，跟收起没区别 */
function clampSplit(v: number): number { return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v)); }
function readSplit(): number {
  const v = Number(localStorage.getItem(SPLIT_KEY));
  return Number.isFinite(v) && v > 0 ? clampSplit(v) : 0.5;
}
function mountSandboxSplit(): void {
  const sandbox = document.getElementById('lk-sandbox');
  const tl = document.getElementById('lk-pane-timeline');
  const map = document.getElementById('lk-pane-map');
  const bar = document.getElementById('lk-split');
  const toggle = document.getElementById('lk-map-toggle');
  if (!sandbox || !tl || !map || !bar) return;
  let ratio = readSplit();
  let collapsed = localStorage.getItem(SPLIT_COLLAPSED_KEY) === '1';
  const apply = (): void => {
    if (collapsed) {
      /* 收起 = 地图只留标题栏（body 藏起来、pane 不吸剩余空间），时间线独占 */
      tl.style.flex = '1 1 0';
      map.style.flex = '0 0 auto';
      map.classList.add('is-collapsed');
      if (toggle) toggle.textContent = '展开';
    } else {
      tl.style.flex = `${ratio} 1 0`;
      map.style.flex = `${1 - ratio} 1 0`;
      map.classList.remove('is-collapsed');
      if (toggle) toggle.textContent = '收起';
    }
    bar.setAttribute('aria-valuenow', String(Math.round((collapsed ? 1 : ratio) * 100)));
  };
  const setCollapsed = (v: boolean): void => {
    collapsed = v;
    localStorage.setItem(SPLIT_COLLAPSED_KEY, v ? '1' : '0');
    apply();
    /* 展开后让地图重新量一次（它自己也有 ResizeObserver，这里只是多给一帧保险） */
    if (!v) requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  };
  toggle?.addEventListener('click', () => setCollapsed(!collapsed));
  /* 拖拽：用 setPointerCapture 收 move —— 指针拖到地图上/窗口外也不会丢事件 */
  let dragging = false;
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (collapsed) setCollapsed(false);
    dragging = true;
    try { bar.setPointerCapture(e.pointerId); } catch { /* 老内核没有捕获也无妨 */ }
    bar.classList.add('is-drag');
    document.body.classList.add('lk-split-drag');
    e.preventDefault();
  });
  bar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = sandbox.getBoundingClientRect();
    if (r.height < 80) return;
    ratio = clampSplit((e.clientY - r.top) / r.height);
    apply();
  });
  const endDragSplit = (): void => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('is-drag');
    document.body.classList.remove('lk-split-drag');
    localStorage.setItem(SPLIT_KEY, String(Math.round(ratio * 1000) / 1000));
  };
  bar.addEventListener('pointerup', endDragSplit);
  bar.addEventListener('pointercancel', endDragSplit);
  bar.addEventListener('lostpointercapture', endDragSplit);
  bar.addEventListener('dblclick', () => setCollapsed(!collapsed));
  /* 键盘：分割条能 Tab 到，↑↓ 调比例（不用鼠标也能改，顺便满足 aria 的基本要求） */
  bar.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (collapsed) setCollapsed(false);
    ratio = clampSplit(ratio + (e.key === 'ArrowUp' ? -0.03 : 0.03));
    apply();
    localStorage.setItem(SPLIT_KEY, String(Math.round(ratio * 1000) / 1000));
    e.preventDefault();
  });
  apply();
}
/* ↶ ↷ 的可用状态。`store.canUndo()/canRedo()` 一直是 store 的公开接口，但全仓**零调用点**——
   按钮永远可点，撤销栈空时点了静默无反应（用户会以为「撤销坏了」）。
   这里把状态映射成 disabled + 降透明度，让「现在能不能撤销」一眼可见。 */
function syncHistoryButtons(store: Store): void {
  const pairs: Array<[string, boolean]> = [
    ['#lk-undo', store.canUndo()],
    ['#lk-redo', store.canRedo()],
  ];
  for (const [sel, on] of pairs) {
    const btn = document.querySelector(sel) as HTMLButtonElement | null;
    if (!btn) continue;
    btn.disabled = !on;
    btn.style.opacity = on ? '' : '0.35';
    btn.style.cursor = on ? '' : 'default';
  }
}

function renderWorldTabs(store: Store): void {
  const tabs = document.getElementById('lk-world-tabs');
  if (!tabs) return;
  const worlds = Object.keys(store.data.worldsets);
  const sig = JSON.stringify(worlds.map((w) => [w, w === store.activeWorld]));
  if (sig === worldTabsSig) return;
  worldTabsSig = sig;
  tabs.innerHTML =
    worlds
      .map(
        (w) =>
          `<button class="lk-world-tab${w === store.activeWorld ? ' is-active' : ''}" data-world="${escapeHtml(w)}" title="${escapeHtml(w)}（右键删除）">${escapeHtml(w)}</button>`
      )
      .join('') + `<button class="lk-world-tab is-new" id="lk-world-new" title="新建世界观">＋</button>`;
  tabs.querySelectorAll('.lk-world-tab[data-world]').forEach((el) => {
    const name = (el as HTMLElement).dataset.world!;
    el.addEventListener('click', () => store.setActiveWorld(name));
    /* 右键删除：与沙盘节点右键菜单同一套入口约定（避免误点即删） */
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const ws = store.data.worldsets[name];
      const tlCount = ws ? Object.keys(ws.timelines ?? {}).length : 0;
      const nodeCount = ws
        ? Object.values(ws.timelines ?? {}).reduce((a, t) => a + (t.nodes?.length ?? 0), 0)
        : 0;
      void confirmDialog({
        title: `删除世界观「${name}」？`,
        message: `将移除 ${tlCount} 条时间线、${nodeCount} 个节点；vault 里整个目录会移入回收站。`,
        detail: '可从工具栏「回收站」恢复。删掉最后一个世界时会自动补一个空世界。',
        confirmText: '删除',
        danger: true,
      }).then((okDel) => { if (okDel) removeWorld(store, name); });
    });
  });
  /* 页签错峰入场。只在这个分支里调：签名没变就早退了，拖动节点时不会重放。
     延迟按子项序号由 CSS 给（style.css 的 .lk-enter-stagger），所以之后新加的页签也有错峰。 */
  staggerIn(tabs);
  tabs.querySelector('#lk-world-new')?.addEventListener('click', () => {
    void promptDialog({
      title: '新建世界观',
      label: '名称',
      value: '新世界',
      placeholder: '世界名',
      confirmText: '创建',
    }).then((name) => { if (name !== null) addWorld(store, name); });
  });
}

/** 有效时间线 id（兼容旧数据 order 与 key 不一致）：order 里存在才用，否则回退第一个 key */
function activeTimelineId(store: Store): string | undefined {
  const ws = currentWorld(store);
  const valid = (ws.order ?? []).find((id) => ws.timelines[id]);
  if (store.activeTimeline && ws.timelines[store.activeTimeline]) return store.activeTimeline;
  return valid || Object.keys(ws.timelines)[0];
}

/* 时间线 tabs 的两份缓存（用户 2026-09-19：「点创建节点时主线页签会上下弹动」）：
   · `timelineTabsIds` = 页签的**集合**（id 顺序）；只有它变了（新建/删除时间线）才重建 DOM；
   · `timelineTabsActive` = 当前选中，用来分辨「换页签」（显式切换 ⇒ 允许播错峰入场）。
   计数与名字一律**就地改**，绝不重写 innerHTML —— 容器上常驻的 `.lk-enter-stagger`
   会给每个新建的子元素播一次 `lk-wake`（上浮 8px + 逐个错峰），于是"建一个节点、
   整条页签栏上下弹一下"（计数变了就重建是这里的病根）。
   顺带保住原来那个目的：拖动节点时每帧一次 store 通知不再重建 tab 栏、不再重绑监听。 */
let timelineTabsIds: string[] = [];
let timelineTabsActive = '';
let timelineTabsBuilt = false;

/** 新建时间线：先问名字。
 *  2026-10-19 工作流评审：真实数据里两条都叫「主线」、三条 0 节点 —— 重名是「新建太便宜 + 不拦」的后果，
 *  拦在建的那一刻最省事；重名时不再默默堆第二条，而是直接切到已有的那条（与 AI 侧 `create_timeline` 同名复用同一口径）。 */
async function newTimelineFlow(store: Store): Promise<void> {
  const ws = currentWorld(store);
  const existing = new Set(Object.values(ws?.timelines ?? {}).map((t) => String(t.name ?? '').trim()));
  let base = '新时间线';
  for (let i = 2; existing.has(base); i++) base = `新时间线 ${i}`;
  const name = await promptDialog({
    title: '新建时间线',
    message: '给它起个名字 —— 一条时间线就是一个「世界」。',
    value: base,
    confirmText: '创建',
  });
  if (name === null) return;
  const nm = name.trim() || base;
  const dup = Object.values(ws?.timelines ?? {}).find((t) => String(t.name ?? '').trim() === nm);
  if (dup) { store.setActiveTimeline(dup.id); return; }
  store.setActiveTimeline(addTimeline(store, nm));
}

/** 时间线 tabs（沙盘 pane-head）：切换时间线 + 新建 */
function renderTimelineTabs(store: Store): void {
  const head = document.getElementById('lk-pane-timeline')?.querySelector('.lk-pane-head');
  if (!head) return;
  const ws = currentWorld(store);
  const allIds = (ws.order ?? []).filter((id) => ws.timelines[id]);
  const active = activeTimelineId(store);
  /* 空线收纳（2026-10-19 工作流评审）：真实数据 5 条时间线里 3 条 0 节点（AI 建的、名字还重），
     全摊在标题栏里，把真正在用的那两条挤到换行。默认把「0 节点且不是当前选中」的折成一颗
     「空线 N」按钮，点一下展开/收起；状态记在 localStorage（不写数据文件）。
     当前选中那条**永远可见** —— 刚点「＋」建出来的空线不会一建出来就消失。 */
  const showEmpty = localStorage.getItem('lingkuang-show-empty-tl') === '1';
  const emptyIds = allIds.filter((id) => (ws.timelines[id]?.nodes?.length ?? 0) === 0 && id !== active);
  const ids = showEmpty ? allIds : allIds.filter((id) => emptyIds.indexOf(id) === -1);
  /* 首次构建完整 head（含 tabs 容器 + 撤销/重做/节点按钮）；之后只更新 tabs，不清掉沙盘工具的 appendChild 节点 */
  let tabs = head.querySelector('.lk-tl-tabs') as HTMLElement | null;
  let undoBtn = head.querySelector('#lk-undo') as HTMLElement | null;
  let redoBtn = head.querySelector('#lk-redo') as HTMLElement | null;
  let nodeBtn = head.querySelector('#lk-node-new') as HTMLElement | null;
  if (!tabs) {
    /* 面板头分三个区（第一百二十二轮 · 方案里的「工具栏分组」）：
       [撤销/重做] │ [画布状态：非线性] │ 页签 │ [新建：节点 / 循环]
       —— 左簇是"看什么"（视图状态），右簇是"造什么"（写数据），中间是切换时间线。
       ⚠️ `#lk-state` 以前只被 timeline.ts **查询**、从没人创建（死分支：非线性永远留在
       #lk-tools 里，和「＋循环」挤在一起）。这里把它建出来，那条搬移逻辑才真的生效。 */
    head.innerHTML =
      `<button class="lk-tl-tab is-new" id="lk-undo" title="撤销 (Ctrl+Z)">↶</button><button class="lk-tl-tab is-new" id="lk-redo" title="重做 (Ctrl+Y)">↷</button><span class="lk-tl-sep"></span><span id="lk-state" style="display:flex;gap:4px;align-items:center;flex-shrink:0;"></span><span class="lk-tl-sep"></span><span class="lk-tl-tabs"></span><span class="lk-tl-sep"></span><button class="lk-tl-tab is-new" id="lk-node-new" title="新建节点">＋节点</button><span id="lk-tools" style="display:flex;gap:4px;align-items:center;flex-shrink:0;"></span>`;
    tabs = head.querySelector('.lk-tl-tabs') as HTMLElement;
    undoBtn = head.querySelector('#lk-undo');
    redoBtn = head.querySelector('#lk-redo');
    nodeBtn = head.querySelector('#lk-node-new');
    undoBtn?.addEventListener('click', () => undoWithVault(store));
    redoBtn?.addEventListener('click', () => redoWithVault(store));
    nodeBtn?.addEventListener('click', () => {
      const id = activeTimelineId(store);
      const tl = id ? currentWorld(store).timelines[id] : undefined;
      if (!tl) return;
      const toolHost = document.getElementById('lk-tool-host');
      if (toolHost && id) renderNodeForm(store, toolHost, id, tl.name);
    });
    timelineTabsBuilt = false;   /* head 重建后 .lk-tl-tabs 是空容器，下面必须重建一次内容 */
    timelineTabsIds = [];
    timelineTabsActive = '';
  }
  /* 页签可辨性（用户 2026-10-17 评审）：真实数据里有两条时间线都叫「主线」、三条 0 节点，
     原来五个页签肉眼分不出谁是谁。⇒ 同名加序号 `·2`；0 节点不再显示一个不显眼的 `0`，
     改「空」+ `.is-empty`（低饱和/斜体）。计数与名字仍然**就地更新**，不重建 DOM。 */
  const nameTotals = new Map<string, number>();
  for (const id of ids) {
    const n = ws.timelines[id]?.name ?? '?';
    nameTotals.set(n, (nameTotals.get(n) ?? 0) + 1);
  }
  const tabLabels = (): Map<string, { name: string; empty: boolean }> => {
    const seen = new Map<string, number>();
    const out = new Map<string, { name: string; empty: boolean }>();
    for (const id of ids) {
      const raw = ws.timelines[id]?.name ?? '?';
      const seq = (seen.get(raw) ?? 0) + 1;
      seen.set(raw, seq);
      out.set(id, {
        name: (nameTotals.get(raw) ?? 0) > 1 ? `${raw}·${seq}` : raw,
        empty: (ws.timelines[id]?.nodes.length ?? 0) === 0,
      });
    }
    return out;
  };
  /* 撤销/重做按钮的可用态：随每次 store 通知刷新（这里在早退之前，签名不变也要刷） */
  syncHistoryButtons(store);
  /* 只更新 tabs 容器内容（不覆盖整个 head，保留沙盘工具 appendChild 节点） */
  if (tabs) {
    const activeKey = active ?? '';
    /* 结构签名只由「页签的 id 顺序」决定 —— 集合没变就不碰 DOM */
    const sameSet = timelineTabsBuilt
      && timelineTabsIds.length === ids.length
      && ids.every((id, i) => timelineTabsIds[i] === id);
    /* 「换页签」是**显式切换**（motion.ts 的纪律允许播入场错峰），数据变化不是 */
    const switched = timelineTabsActive !== activeKey;
    if (!sameSet) {
      timelineTabsBuilt = true;
      timelineTabsIds = [...ids];
      timelineTabsActive = activeKey;
      const labels = tabLabels();
      const tabsHtml = ids
        .map((id) => {
          const l = labels.get(id)!;
          return `<button class="lk-tl-tab${id === active ? ' is-active' : ''}${l.empty ? ' is-empty' : ''}" data-tl="${escapeHtml(id)}" title="${escapeHtml(l.name)}${l.empty ? '（还没有节点）' : ''}"><span class="nm">${escapeHtml(l.name)}</span><span class="cnt">${l.empty ? '空' : (ws.timelines[id]?.nodes.length ?? 0)}</span></button>`;
        })
        .join('');
      tabs.innerHTML = tabsHtml + `<button class="lk-tl-tab is-new" id="lk-tl-new" title="新建时间线">＋</button>`
        + (emptyIds.length || showEmpty ? `<button class="lk-tl-tab is-new" id="lk-tl-empty" title="${showEmpty ? '收起 0 节点的时间线' : '展开 0 节点的时间线'}">${showEmpty ? '收起空线' : `空线 ${emptyIds.length}`}</button>` : '');
      staggerIn(tabs);   /* 页签错峰入场：只有「页签集合变了」这一条路会重建 DOM */
      tabs.querySelectorAll('.lk-tl-tab[data-tl]').forEach((el) => {
        const id = (el as HTMLElement).dataset.tl!;
        el.addEventListener('click', () => store.setActiveTimeline(id));
        el.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          const tl = ws.timelines[id];
          void confirmDialog({
            title: `删除时间线「${tl?.name ?? '?'}」？`,
            message: `将移除该时间线的 ${tl?.nodes.length ?? 0} 个节点；vault 里对应目录会移入回收站。`,
            detail: '可从工具栏「回收站」恢复。',
            confirmText: '删除',
            danger: true,
          }).then((okDel) => { if (okDel) removeTimeline(store, id); });
        });
      });
      tabs.querySelector('#lk-tl-new')?.addEventListener('click', () => { void newTimelineFlow(store); });
      /* 「空线 N」：展开/收起（只重画页签，不碰 sandbox 挂在 head 尾巴上的工具位） */
      tabs.querySelector('#lk-tl-empty')?.addEventListener('click', () => {
        localStorage.setItem('lingkuang-show-empty-tl', showEmpty ? '0' : '1');
        timelineTabsIds = [];   /* 可见集合变了 ⇒ 下一次强制重建 DOM */
        renderTimelineTabs(store);
      });
    } else {
      /* 集合没变：名字 / 计数 / 选中态 / 空态**就地更新**（不重建 ⇒ 不重播入场） */
      const labels = tabLabels();
      tabs.querySelectorAll<HTMLElement>('.lk-tl-tab[data-tl]').forEach((el) => {
        const id = el.dataset.tl as string;
        const l = labels.get(id);
        const label = l?.name ?? '?';
        const nm = el.querySelector('.nm');
        if (nm && nm.textContent !== label) nm.textContent = label;
        const cntText = l?.empty ? '空' : String(ws.timelines[id]?.nodes.length ?? 0);
        const cnt = el.querySelector('.cnt');
        if (cnt && cnt.textContent !== cntText) {
          /* 计数不硬跳（2026-10-24）：数字滚动到新值；「空」这种非数字直接换字 */
          if (l?.empty) cnt.textContent = cntText;
          else tweenNumber(cnt as HTMLElement, ws.timelines[id]?.nodes.length ?? 0);
        }
        el.classList.toggle('is-empty', !!l?.empty);
        if (id === active) el.classList.add('is-active');
        else el.classList.remove('is-active');
      });
      if (switched) {
        timelineTabsActive = activeKey;
        staggerIn(tabs);   /* 换页签：显式切换，播一次错峰（e2e motion-switch ★15 断言这条） */
      }
    }
  }
}

/** 左栏只留三件「干活」的主入口（2026-10-24 定：世界沙盘 / 设定库 / 助手）。
 *  其余工具收进「实验室」抽屉 —— 名字与一句说明都在，找得到，只是不占主路径。
 *  排序仍然由壳决定、不靠注册顺序（同 2026-09-12 那轮「设置放最底下」的纪律）。 */
const RAIL_PRIMARY = ['sandbox', 'codex', 'agent'];

/** 抽屉里每一行的一句说明。工具本身没有 desc 字段，这段文案就是它的「是什么」。 */
const LAB_HINT: Record<string, string> = {
  inspire: '抽卡组合，出角色灵感',
  ai: 'AI 工作台（多会话）',
  mapgen: '地形 / 星球生成',
  library: '词库与 vault 文件',
  schema: '设定类型与字段模板',
  trash: '删掉的条目在这里',
  backup: '快照与回滚',
};

function renderToolbar(store: Store): void {
  shellStore = store; bindPanelEvents();
  const bar = document.getElementById('lk-toolbar');
  const toolHost = document.getElementById('lk-tool-host');
  if (!bar || !toolHost) return;
  /* 左栏的排序与分组**归壳管**（用户 2026-09-12：「设置放到左侧栏最底下」，2026-10-24：
     「11 个工具太吵，收窄到 3 个主入口」）。工具的登记顺序可以随实现方便，这里只按 id 取。 */
  const all = listTools();
  const byId = (id: string): Tool | undefined => all.find((t) => t.id === id);
  const primary = RAIL_PRIMARY.map(byId).filter((t): t is Tool => !!t);
  const settings = byId('settings');
  const rest = all.filter((t) => !RAIL_PRIMARY.includes(t.id) && t.id !== 'settings');

  const btn = (t: Tool): string =>
    `<button class="lk-tool-btn${t.placeholder ? ' is-ph' : ''}" data-tool="${t.id}" title="${t.name}${t.placeholder ? '（占位）' : ''}">${t.icon}<span>${t.name}</span></button>`;
  /* 「实验室」按钮：不是一个工具（没有 id），只是抽屉的开关 —— 所以不给它 `data-tool`，
     免得 `restoreSession()` / e2e 把「上次打开的工具」错记到它头上。 */
  const labBtn = `<button class="lk-tool-btn" id="lk-lab-btn" title="实验室：其余 ${rest.length} 个工具（灵感 / 素材库 / 地图 / 结构 / 回收站 / 备份）"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg><span>实验室</span></button>`;

  bar.innerHTML =
    `<div class="lk-tool-group">${primary.map(btn).join('')}</div>` +
    `<div class="lk-tool-group is-bottom">${labBtn}${settings ? btn(settings) : ''}</div>`;

  /* ── 实验室抽屉：挂在 `.lk-app` 里、贴着左栏底（`.lk-lab`），点外面 / Esc 收起 ── */
  const app = document.querySelector('.lk-app') as HTMLElement | null;
  let lab = document.getElementById('lk-lab');
  if (!lab && app) {
    lab = document.createElement('div');
    lab.id = 'lk-lab';
    lab.className = 'lk-lab';
    lab.hidden = true;
    app.appendChild(lab);
  }
  if (lab) {
    const item = (t: Tool): string =>
      `<button class="lk-lab__item${t.placeholder ? ' is-ph' : ''}" data-tool="${t.id}" title="${t.name}"><span class="lk-lab__ic">${t.icon}</span><span class="lk-lab__tx"><b>${t.name}</b><i>${escapeHtml(LAB_HINT[t.id] ?? '')}</i></span></button>`;
    lab.innerHTML =
      `<div class="lk-lab__head"><b>实验室</b><span>其余 ${rest.length} 个工具 · 不占主路径</span></div>` +
      `<div class="lk-lab__list">${rest.map(item).join('')}</div>` +
      `<div class="lk-lab__foot">想常用哪个，说一声就搬回左栏。</div>`;
  }

  const syncRailActive = (id: string): void => {
    for (const b of Array.from(bar.querySelectorAll<HTMLElement>('.lk-tool-btn'))) {
      b.classList.toggle('is-active', b.dataset.tool === id);
    }
    /* 实验室按钮亮 = 当前开着的是抽屉里的某个工具（它们没有自己的图标位了） */
    bar.querySelector('#lk-lab-btn')?.classList.toggle('is-active', !RAIL_PRIMARY.includes(id) && id !== 'settings');
  };

  /** 点工具＝切换视图。原来是内联在按钮监听里的，现在三个入口（主栏 / 抽屉）共用这一份 ——
   *  两处各写一遍必漂移（这一课在「中栏字段行」上吃过）。 */
  const activate = (id: string): void => {
    const t = all.find((x) => x.id === id);
    if (!t) return;
    const moduleView = document.getElementById('lk-module-view');
    /* 面板型工具（设置 / 助手 / 地图生成）：**不碰主区** —— 只开关那一层悬浮面板。
       高亮只认 `syncPanelButtons()`（它按 `isOpen()` 判），**不能**再走 syncRailActive：
       那样"关掉面板"时会把按钮按 id 重新点亮（实测：设置关掉了、左栏还亮着）。 */
    if (t.panel) {
      if (t.isOpen?.()) t.close?.();
      else if (moduleView) openTool(id, moduleView, store);
      syncPanelButtons();
      return;
    }
    syncRailActive(id);
    /* 记「上次打开的工具」——下次进灵框直接回到这个视图（见 `src/ui/session.ts`）。
       面板型工具在上面就 return 了：它不接管主区，不该覆盖"上次在看哪个主视图"。 */
    rememberTool(id);
    const right = document.querySelector('.lk-right') as HTMLElement | null;
    if (id === 'sandbox') {
      /* 世界沙盘：恢复沙盘视图（隐藏模块，恢复右区 + tool-host）。
         这条分支不走 openTool，得自己结算上一个工具的清理函数：
         否则「编辑器 → 世界沙盘」会把 tiptap 实例 + 订阅 + 全局监听留在后台。 */
      disposeCurrentTool();
      setAgentView('世界沙盘');
      if (moduleView) { moduleView.style.display = 'none'; moduleView.innerHTML = ''; }
      if (toolHost) { toolHost.style.display = ''; toolHost.innerHTML = ''; }
      if (right) right.style.display = '';
      return;
    }
    /* 其他模块：隐藏右区（sandbox/worldbar），模块 flex 占满工具栏右侧（工具栏始终可见） */
    if (moduleView) {
      moduleView.style.display = '';
      moduleView.innerHTML = '';
      if (toolHost) toolHost.style.display = 'none';
      if (right) right.style.display = 'none';
      openTool(id, moduleView, store);
    }
  };

  const toggleLab = (force?: boolean): void => {
    if (!lab) return;
    const open = force ?? !!lab.hidden;
    lab.hidden = !open;
    bar.querySelector('#lk-lab-btn')?.classList.toggle('is-open', open);
  };

  bar.querySelectorAll<HTMLElement>('.lk-tool-btn[data-tool]').forEach((el) => {
    el.addEventListener('click', () => activate(el.dataset.tool as string));
  });
  bar.querySelector('#lk-lab-btn')?.addEventListener('click', () => toggleLab());
  lab?.querySelectorAll<HTMLElement>('.lk-lab__item[data-tool]').forEach((el) => {
    el.addEventListener('click', () => {
      activate(el.dataset.tool as string);
      toggleLab(false);
    });
  });
  if (!labDismissBound) {
    labDismissBound = true;
    const closeLab = (): void => {
      const l = document.getElementById('lk-lab');
      if (!l || l.hidden) return;
      l.hidden = true;
      document.getElementById('lk-lab-btn')?.classList.remove('is-open');
    };
    document.addEventListener('pointerdown', (ev) => {
      const t = ev.target as HTMLElement | null;
      if (!t) return;
      const l = document.getElementById('lk-lab');
      if (!l || l.hidden) return;
      /* 点抽屉里面、或者点开关自己 —— 都不收（开关的 click 自己会切） */
      if (l.contains(t) || t.closest('#lk-lab-btn')) return;
      closeLab();
    });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeLab(); });
  }
  syncPanelButtons();
}

/** 面板型工具（设置）的按钮高亮 = 那一层悬浮面板此刻开着没开着。
 *  × / Esc / 点遮罩关掉时面板会广播 `lingkuang-panel`，这里跟着同步（不然按钮会一直亮着）。 */
function syncPanelButtons(): void {
  const bar = document.getElementById('lk-toolbar');
  if (!bar) return;
  for (const b of Array.from(bar.querySelectorAll<HTMLElement>('.lk-tool-btn'))) {
    const t = listTools().find((x) => x.id === b.dataset.tool);
    if (!t?.panel) continue;
    b.classList.toggle('is-active', !!t.isOpen?.());
  }
}

/* 只挂一次：`renderToolbar` 每次重建工具栏都会走一遍，重复注册会把同一个回调堆起来 */
/* 壳里留一份 store 引用：`bindPanelEvents()` 是模块级函数、作用域里没有 store，
   而 **Ctrl+K** 要能直接开「灵框助手」（不该先逼用户去点工具按钮）。 */
let shellStore: Store | null = null;

let panelEvtBound = false;
/** 「实验室」抽屉的"点外面就收"只挂一次（renderToolbar 重建工具栏时会再走一遍这段） */
let labDismissBound = false;
function bindPanelEvents(): void {
  if (panelEvtBound) return;
  panelEvtBound = true;
  window.addEventListener('lingkuang-panel', () => syncPanelButtons());
  /* **Ctrl+K 呼出助手**（用户选定 Ctrl+K）：走应用内 keydown，**不用 Electron 的 globalShortcut**
     —— 全局热键会跟系统/别的软件抢按键（Ctrl+K 在编辑器里到处都是），而用户要的是「灵框内」呼出。
     再按一次收起；只认单按 Ctrl/Cmd+K（带 Shift/Alt 的组合让给别人）。 */
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    /* 2026-10-19 用户：「ctrl+k 一只手有点难按」⇒ 主键改 **Ctrl+J**（J 在右手食指位，左手也够得着），
        Ctrl+K 留作老习惯的别名；带 Shift/Alt 的组合仍旧让给别人。 */
    const key = e.key.toLowerCase();
    /* Ctrl/Cmd+P = 命令面板 / 全局检索（2026-10-19 工作流评审 C 项：11 个工具 + 132 条条目，
       没有一处能「按名字跳过去」）。面板自己管开/关与 Esc。 */
    if (key === 'p') {
      e.preventDefault();
      if (shellStore) void import('./palette').then((m) => m.togglePalette(shellStore as Store)).catch(() => { /* 打不开不影响主流程 */ });
      return;
    }
    if (key !== 'j' && key !== 'k') return;
    const t = listTools().find((x) => x.id === 'agent');
    if (!t?.panel) return;
    e.preventDefault();
    if (t.isOpen?.()) t.close?.();
    else if (shellStore) openTool('agent', document.getElementById('lk-module-view') as HTMLElement, shellStore);
    syncPanelButtons();
  });
}
