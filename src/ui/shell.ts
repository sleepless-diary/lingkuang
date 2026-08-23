/** 灵框 · 壳 UI（世界栏 + 工具栏 + 沙盘）——AE 风：圆角少、工具感强 */
import type { Store } from '../store/store';
import { listTools, openTool } from '../tools/registry';
import { registerAllTools } from '../tools/register';
import { mountTimeline } from './timeline';
import { renderNodeDetail } from './detail';
import { addTimeline } from '../store/actions';
import { currentWorld } from '../store/store';
import { renderNodeForm } from './node-form';

export function renderShell(store: Store, host: HTMLElement): void {
  registerAllTools();

  host.innerHTML = `
    <div class="lk-app">
      <main class="lk-main">
        <nav class="lk-toolbar" id="lk-toolbar"></nav>
        <div class="lk-right">
          <header class="lk-worldbar">
            <div class="lk-worldbar-tabs" id="lk-world-tabs"></div>
          </header>
          <section class="lk-sandbox" id="lk-sandbox">
            <div class="lk-pane lk-pane-timeline" id="lk-pane-timeline">
              <div class="lk-pane-head">世界沙盘 · 时间线 <span class="lk-ph">（功能迁移中）</span></div>
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

function renderWorldTabs(store: Store): void {
  const tabs = document.getElementById('lk-world-tabs');
  if (!tabs) return;
  const worlds = Object.keys(store.data.worldsets);
  tabs.innerHTML = worlds
    .map(
      (w) =>
        `<button class="lk-world-tab${w === store.activeWorld ? ' is-active' : ''}" data-world="${w}">${w}</button>`
    )
    .join('');
  tabs.querySelectorAll('.lk-world-tab').forEach((el) => {
    el.addEventListener('click', () => store.setActiveWorld((el as HTMLElement).dataset.world!));
  });
}

/** 有效时间线 id（兼容旧数据 order 与 key 不一致）：order 里存在才用，否则回退第一个 key */
function activeTimelineId(store: Store): string | undefined {
  const ws = currentWorld(store);
  const valid = (ws.order ?? []).find((id) => ws.timelines[id]);
  if (store.activeTimeline && ws.timelines[store.activeTimeline]) return store.activeTimeline;
  return valid || Object.keys(ws.timelines)[0];
}

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
      `<span class="lk-pane-title">世界沙盘 · 时间线</span><button class="lk-tl-tab is-new" id="lk-undo" title="撤销 (Ctrl+Z)">↶</button><button class="lk-tl-tab is-new" id="lk-redo" title="重做 (Ctrl+Y)">↷</button><span class="lk-tl-tabs"></span><span id="lk-tools" style="display:flex;gap:4px;align-items:center;flex-shrink:0;"></span><button class="lk-tl-tab is-new" id="lk-node-new" title="新建节点">＋节点</button>`;
    tabs = head.querySelector('.lk-tl-tabs') as HTMLElement;
    undoBtn = head.querySelector('#lk-undo');
    redoBtn = head.querySelector('#lk-redo');
    nodeBtn = head.querySelector('#lk-node-new');
    undoBtn?.addEventListener('click', () => store.undo());
    redoBtn?.addEventListener('click', () => store.redo());
    nodeBtn?.addEventListener('click', () => {
      const id = activeTimelineId(store);
      const tl = id ? currentWorld(store).timelines[id] : undefined;
      if (!tl) return;
      const toolHost = document.getElementById('lk-tool-host');
      if (toolHost && id) renderNodeForm(store, toolHost, id, tl.name);
    });
  }
  /* 只更新 tabs 容器内容（不覆盖整个 head，保留沙盘工具 appendChild 节点） */
  if (tabs) {
    const tabsHtml = ids
      .map(
        (id) =>
          `<button class="lk-tl-tab${id === active ? ' is-active' : ''}" data-tl="${id}">${ws.timelines[id]?.name ?? '?'}<span class="cnt">${ws.timelines[id]?.nodes.length ?? 0}</span></button>`
      )
      .join('');
    tabs.innerHTML = tabsHtml + `<button class="lk-tl-tab is-new" id="lk-tl-new" title="新建时间线">＋</button>`;
    tabs.querySelectorAll('.lk-tl-tab[data-tl]').forEach((el) => {
      el.addEventListener('click', () => store.setActiveTimeline((el as HTMLElement).dataset.tl!));
    });
    tabs.querySelector('#lk-tl-new')?.addEventListener('click', () => addTimeline(store, '新时间线'));
  }
}

function renderToolbar(store: Store): void {
  const bar = document.getElementById('lk-toolbar');
  const toolHost = document.getElementById('lk-tool-host');
  if (!bar || !toolHost) return;
  bar.innerHTML = listTools()
    .map(
      (t) =>
        `<button class="lk-tool-btn${t.placeholder ? ' is-ph' : ''}" data-tool="${t.id}" title="${t.name}${t.placeholder ? '（占位）' : ''}">${t.icon}<span>${t.name}</span></button>`
    )
    .join('');
  bar.querySelectorAll('.lk-tool-btn').forEach((el) => {
    el.addEventListener('click', () => {
      bar.querySelectorAll('.lk-tool-btn').forEach((b) => b.classList.remove('is-active'));
      el.classList.add('is-active');
      const id = (el as HTMLElement).dataset.tool!;
      const moduleView = document.getElementById('lk-module-view');
      const toolHost = document.getElementById('lk-tool-host');
      const right = document.querySelector('.lk-right') as HTMLElement | null;
      if (id === 'sandbox') {
        /* 世界沙盘：恢复沙盘视图（隐藏模块，恢复右区 + tool-host） */
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
}
