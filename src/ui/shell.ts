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
import { staggerIn } from './motion';
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
            <div class="lk-pane lk-pane-map" id="lk-pane-map">
              <div class="lk-pane-head">地图 <span class="lk-ph">（占位）</span></div>
              <div class="lk-pane-body lk-placeholder">地图视图 · Leaflet 重构</div>
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
  store.subscribe(() => {
    renderWorldTabs(store);
    renderTimelineTabs(store);
  });
}

/* 世界栏签名缓存：与时间线页签同理 —— renderWorldTabs 挂在 store 订阅里，
   拖动节点时每帧被调一次，无条件重写 innerHTML 会每帧重建整个世界栏并重绑监听。 */
let worldTabsSig = '';

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

/** 时间线 tabs（沙盘 pane-head）：切换时间线 + 新建 */
function renderTimelineTabs(store: Store): void {
  const head = document.getElementById('lk-pane-timeline')?.querySelector('.lk-pane-head');
  if (!head) return;
  const ws = currentWorld(store);
  const ids = (ws.order ?? []).filter((id) => ws.timelines[id]);
  const active = activeTimelineId(store);
  /* 首次构建完整 head（含 tabs 容器 + 撤销/重做/节点按钮）；之后只更新 tabs，不清掉沙盘工具的 appendChild 节点 */
  let tabs = head.querySelector('.lk-tl-tabs') as HTMLElement | null;
  let undoBtn = head.querySelector('#lk-undo') as HTMLElement | null;
  let redoBtn = head.querySelector('#lk-redo') as HTMLElement | null;
  let nodeBtn = head.querySelector('#lk-node-new') as HTMLElement | null;
  if (!tabs) {
    head.innerHTML =
      `<button class="lk-tl-tab is-new" id="lk-undo" title="撤销 (Ctrl+Z)">↶</button><button class="lk-tl-tab is-new" id="lk-redo" title="重做 (Ctrl+Y)">↷</button><span class="lk-tl-tabs"></span><button class="lk-tl-tab is-new" id="lk-node-new" title="新建节点">＋节点</button><span id="lk-tools" style="display:flex;gap:4px;align-items:center;flex-shrink:0;"></span>`;
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
      const tabsHtml = ids
        .map(
          (id) =>
            `<button class="lk-tl-tab${id === active ? ' is-active' : ''}" data-tl="${escapeHtml(id)}"><span class="nm">${escapeHtml(ws.timelines[id]?.name ?? '?')}</span><span class="cnt">${ws.timelines[id]?.nodes.length ?? 0}</span></button>`
        )
        .join('');
      tabs.innerHTML = tabsHtml + `<button class="lk-tl-tab is-new" id="lk-tl-new" title="新建时间线">＋</button>`;
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
      tabs.querySelector('#lk-tl-new')?.addEventListener('click', () => addTimeline(store, '新时间线'));
    } else {
      /* 集合没变：名字 / 计数 / 选中态**就地更新**（不重建 ⇒ 不重播入场） */
      tabs.querySelectorAll<HTMLElement>('.lk-tl-tab[data-tl]').forEach((el) => {
        const id = el.dataset.tl as string;
        const tl = ws.timelines[id];
        const label = tl?.name ?? '?';
        const nm = el.querySelector('.nm');
        if (nm && nm.textContent !== label) nm.textContent = label;
        const n = String(tl?.nodes.length ?? 0);
        const cnt = el.querySelector('.cnt');
        if (cnt && cnt.textContent !== n) cnt.textContent = n;
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

function renderToolbar(store: Store): void {
  shellStore = store; bindPanelEvents();
  const bar = document.getElementById('lk-toolbar');
  const toolHost = document.getElementById('lk-tool-host');
  if (!bar || !toolHost) return;
  /* 左栏分两段（用户 2026-09-12：「设置放到左侧栏最底下」）：
     上段＝创作工具（沙盘/灵感/编辑器/AI/设定库…，缺省组），下段＝管理项（结构体/回收站/备份/设置）
     并**贴着底部**（CSS `.lk-tool-group.is-bottom { margin-top: auto }`）。
     排序由这里决定、不靠注册顺序 —— 工具的登记顺序可以随实现方便，左栏长什么样归壳管。 */
  const all = listTools();
  const group = (g: 'create' | 'manage'): Tool[] => all.filter((t) => (t.group ?? 'create') === g);
  const btn = (t: Tool): string =>
    `<button class="lk-tool-btn${t.placeholder ? ' is-ph' : ''}" data-tool="${t.id}" title="${t.name}${t.placeholder ? '（占位）' : ''}">${t.icon}<span>${t.name}</span></button>`;
  const manage = group('manage');
  bar.innerHTML =
    `<div class="lk-tool-group">${group('create').map(btn).join('')}</div>` +
    (manage.length ? `<div class="lk-tool-group is-bottom">${manage.map(btn).join('')}</div>` : '');
  bar.querySelectorAll('.lk-tool-btn').forEach((el) => {
    el.addEventListener('click', () => {
      const id = (el as HTMLElement).dataset.tool!;
      /* 面板型工具（设置）：**不碰主区** —— 不开模块视图、不隐藏沙盘，只开关那一层悬浮面板。
         按钮高亮跟着"面板开着没开着"走（× / Esc / 点遮罩关掉时由 `lingkuang-panel` 同步）。 */
      const t = all.find((x) => x.id === id);
      if (t?.panel) {
        if (t.isOpen?.()) t.close?.();
        else openTool(id, document.getElementById('lk-module-view') as HTMLElement, store);
        syncPanelButtons();
        return;
      }
      bar.querySelectorAll('.lk-tool-btn').forEach((b) => b.classList.remove('is-active'));
      el.classList.add('is-active');
      /* 记「上次打开的工具」——下次进灵框直接回到这个视图（见 `src/ui/session.ts`）。
         面板型工具在上面就 return 了：它不接管主区，不该覆盖"上次在看哪个主视图"。 */
      rememberTool(id);
      const moduleView = document.getElementById('lk-module-view');
      const toolHost = document.getElementById('lk-tool-host');
      const right = document.querySelector('.lk-right') as HTMLElement | null;
      if (id === 'sandbox') {
        /* 世界沙盘：恢复沙盘视图（隐藏模块，恢复右区 + tool-host） */
        /* 这条分支不走 openTool，得自己结算上一个工具的清理函数：
           否则「编辑器 → 世界沙盘」会把 tiptap 实例 + 订阅 + 全局监听留在后台。 */
        disposeCurrentTool();
        /* 沙盘不走 openTool，界面名得自己上报（助手据此知道他现在人在沙盘里） */
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
    });
  });
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
function bindPanelEvents(): void {
  if (panelEvtBound) return;
  panelEvtBound = true;
  window.addEventListener('lingkuang-panel', () => syncPanelButtons());
  /* **Ctrl+K 呼出助手**（用户选定 Ctrl+K）：走应用内 keydown，**不用 Electron 的 globalShortcut**
     —— 全局热键会跟系统/别的软件抢按键（Ctrl+K 在编辑器里到处都是），而用户要的是「灵框内」呼出。
     再按一次收起；只认单按 Ctrl/Cmd+K（带 Shift/Alt 的组合让给别人）。 */
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    if (e.key !== 'k' && e.key !== 'K') return;
    const t = listTools().find((x) => x.id === 'agent');
    if (!t?.panel) return;
    e.preventDefault();
    if (t.isOpen?.()) t.close?.();
    else if (shellStore) openTool('agent', document.getElementById('lk-module-view') as HTMLElement, shellStore);
    syncPanelButtons();
  });
}
