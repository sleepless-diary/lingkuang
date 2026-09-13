/** 灵框 · 设定库右侧的「演变」竖条（等距时间线）
 *
 *  用户 2026-09-13 的要求（原话）：「我想在设定库右侧加一条竖着的等距的时间线，用来储存不同节点，
 *  当选中实例时，默认进入离当前指针最近的 git」。
 *
 *  所以这一条**不是按时间比例画的**（不是甘特图），而是像 git log 一样**每一格等高**：
 *  一格 = 一个版本，顶上第一格是「初稿」，往下是**已经留过版本的事件**。点哪一格 = 站在哪一版上看这个实例。
 *
 *  ⚠️ 2026-09-13 上午改：用户原话「**我希望没有版本的节点就不显示**」——
 *  原先这条线会把世界里**每一个**事件节点都列出来（7 个节点里 6 个是空的），像一份待办清单而不是历史。
 *  现在只列**有版本的**（`hasFrame`）。代价：不能再"点空格子来选锚点"了，所以底部补了一个
 *  锚点下拉（`#cx-anchor`）=「记到哪个事件」；点帧条上的行也会把锚点带过去。
 *
 *  它自己**不写数据**（只发事件）—— 写盘、建帧、删帧都在 `src/ui/codex.ts` 里，
 *  免得"哪个模块负责落盘"两处各说一套（这一课在抽公共属性面板时吃过）。
 */
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import type { Entity, TimelineNode } from '../store/types';
import { epochOfNodes, isEmptyPatch, patchSummary, versionAtNode } from '../store/evolution';
import { escapeHtml } from './html';
import { loadSettings } from './settings';

export interface RailDeps {
  store: Store;
  host: HTMLElement;
  /** 当前实体（没有就画一句提示） */
  getEntity: () => Entity | undefined;
  /** 当前选中的那一格（节点 id；null = 初稿） */
  getSelected: () => string | null;
  /** 「记到哪个事件」（底部下拉的当前值；null = 还没定，兜底用离指针最近的那个） */
  getAnchor: () => string | null;
  onSelect: (nodeId: string | null) => void;
  /** 换锚点：只记在 codex 里，不碰数据 */
  onAnchor: (nodeId: string) => void;
  /** 点「＋记一帧」：在锚点那一格上留一个版本 */
  onAddFrame: (nodeId: string) => void;
  /** 删掉这一格上的版本（历史，带确认） */
  onDeleteFrame: (nodeId: string) => void;
}

export interface Rail {
  render: () => void;
}

interface Row {
  nodeId: string;
  node: TimelineNode;
  tlName: string;
  epoch: number;
  version: number;        /* 这一格对应的版本号（0 = 初稿；无帧的格子 = 它之前最近的那一帧） */
  hasFrame: boolean;
}

const ROW_H = 46;   /* 等距：每一格固定高度（用户要的"等距时间线"）；样式在 src/style.css 的 .lk-rail__row */

export function createEvolutionRail(deps: RailDeps): Rail {
  const { store, host } = deps;
  /* 节点 epoch 只按世界缓存：拖帧条、改字段都会重画这一条，不必每次都算年表 */
  let cacheWorld = '';
  let cacheEpoch: Map<string, number> = new Map();

  function epochMap(): Map<string, number> {
    const w = store.activeWorld;
    if (w !== cacheWorld) { cacheWorld = w; cacheEpoch = epochOfNodes(currentWorld(store) as any); }
    return cacheEpoch;
  }

  /** 世界里的全部事件节点（所有时间线合起来），按时间排序 —— 底部下拉从这里出选项 */
  function allRows(): Row[] {
    const ws = currentWorld(store);
    const ep = epochMap();
    const list: { nodeId: string; node: TimelineNode; tlName: string; epoch: number }[] = [];
    for (const tlId of ws.order ?? []) {
      const tl = ws.timelines?.[tlId];
      if (!tl) continue;
      for (const n of tl.nodes ?? []) list.push({ nodeId: n.id, node: n, tlName: tl.name ?? tlId, epoch: ep.get(n.id) ?? 0 });
    }
    list.sort((a, b) => a.epoch - b.epoch || String(a.node.title).localeCompare(String(b.node.title)));
    const e = deps.getEntity();
    const epo = (id: string): number => ep.get(id) ?? 0;
    return list.map((r) => ({
      ...r,
      version: e ? versionAtNode(e, epo, r.epoch, r.nodeId) : 0,
      hasFrame: !!e?.frames?.some((f) => f.nodeId === r.nodeId),
    }));
  }

  /** 帧条上真正显示的格子 = **有版本的节点**（用户 2026-09-13 上午：「没有版本的节点就不显示」）。
   *  没有版本的节点仍在下拉里可选（那是"给谁记版本"的入口），只是不占这条线的位置。 */
  function rows(): Row[] {
    return allRows().filter((r) => r.hasFrame);
  }

  /** 帧锚点在哪个节点上（拿不到节点对象的帧 = 孤立帧，仍要显示出来：历史不能因为删了节点就消失） */
  function orphanRows(e: Entity, rs: Row[]): { nodeId: string; version: number }[] {
    const ids = new Set(rs.map((r) => r.nodeId));
    const out: { nodeId: string; version: number }[] = [];
    (e.frames ?? []).forEach((f, i) => { if (!ids.has(f.nodeId)) out.push({ nodeId: f.nodeId, version: i + 1 }); });
    return out;
  }

  function timeText(n: TimelineNode): string {
    let s = `${n.year ?? ''}`;
    if (n.month) s += `-${String(n.month).padStart(2, '0')}`;
    if (n.day) s += `-${String(n.day).padStart(2, '0')}`;
    return s || '（无时间）';
  }

  function render(): void {
    const e = deps.getEntity();
    const sel = deps.getSelected();
    const anchor = deps.getAnchor() ?? '';
    const mode = loadSettings().evolveMode;
    const modeText = mode === 'auto' ? '自动' : mode === 'locked' ? '锁定' : '手动';
    const all = allRows();
    const rs = all.filter((r) => r.hasFrame);
    const orphans = e ? orphanRows(e, all) : [];
    /** 一个事件叫什么（提示里要说清"改动会记到哪儿"） */
    const nodeTitle = (nodeId: string | null): string => {
      if (!nodeId) return '初稿';
      const r = all.find((x) => x.nodeId === nodeId);
      if (r) return r.node.title || r.tlName;
      return (e?.frames ?? []).find((f) => f.nodeId === nodeId)?.note || '（已删掉的事件）';
    };
    /** 某一版的锚点标题 */
    const noteFor = (v: number): string => {
      const f = (e?.frames ?? [])[v - 1];
      return f ? nodeTitle(f.nodeId) : '初稿';
    };
    /* 底部那行小字：三种模式下"改哪里"完全不同，不写清楚会以为改的是别处。
       （没有版本的格子已经不上帧条了，所以"这一格没有版本，改动会改到上一版"那句提示也一并消失） */
    const editHint = (): string => {
      if (!e) return '';
      if (mode === 'locked') return `锁定模式：改动都记在「${noteFor(lockedVersion(e))}」那一帧上`;
      if (mode === 'auto') return `自动模式：改动会记到「${nodeTitle(anchor || null)}」上（还没版本就先建一版）`;
      if (sel === null) return '手动模式：现在改的是初稿；要给某个事件留版本，用下面的 ＋';
      const onRow = rs.find((r) => r.nodeId === sel);
      return `手动模式：改动改的就是这一版（第 ${onRow ? onRow.version : 0} 版）`;
    };

    const rowHtml = (r: Row): string => {
      const on = r.nodeId === sel;
      const frame = (e?.frames ?? [])[r.version - 1];
      /* 标题 = 这个节点的标题；帧自己另起的 `note` 不同就写成 "节点名（帧备注）" */
      const note = frame?.note && frame.note !== r.node.title
        ? `${r.node.title}（${frame.note}）`
        : (r.node.title || frame?.note || '');
      const sum = isEmptyPatch(frame?.patch) ? '（只是标记）' : patchSummary(frame?.patch);
      return `<div class="lk-rail__row${on ? ' is-on' : ''} is-frame" data-rail="${escapeHtml(r.nodeId)}" title="${escapeHtml(r.tlName + ' · ' + timeText(r.node) + ' ' + note)}">
        <span class="lk-rail__dot"></span>
        <span class="lk-rail__t">${escapeHtml(timeText(r.node))}</span>
        <span class="lk-rail__n">${escapeHtml(note)}</span>
        <span class="lk-rail__s">${escapeHtml(sum)}</span>
      </div>`;
    };

    host.innerHTML = `
      <div class="lk-rail__head">
        <span class="lk-rail__title">演变</span>
        <span class="lk-rail__mode" title="在「设置 → 设定演变」里改">${escapeHtml(modeText)}</span>
      </div>
      <div class="lk-rail__rows">
        <div class="lk-rail__row lk-rail__row--base${sel === null ? ' is-on' : ''}" data-rail="" title="初稿（实体 .md 里 frontmatter 的那一份）">
          <span class="lk-rail__dot"></span>
          <span class="lk-rail__t">起点</span>
          <span class="lk-rail__n">初稿</span>
          <span class="lk-rail__s">${e ? `${Object.keys(e.properties ?? {}).length} 个字段` : ''}</span>
        </div>
        ${rs.map(rowHtml).join('')}
        ${orphans.map((o) => `<div class="lk-rail__row${o.nodeId === sel ? ' is-on' : ''} is-frame" data-rail="${escapeHtml(o.nodeId)}" title="这一帧锚的节点已经被删掉了（历史仍保留）">
          <span class="lk-rail__dot"></span>
          <span class="lk-rail__t">孤立</span>
          <span class="lk-rail__n">节点已删除</span>
          <span class="lk-rail__s">${escapeHtml(patchSummary((e?.frames ?? [])[o.version - 1]?.patch))}</span>
        </div>`).join('')}
        ${rs.length + orphans.length ? '' : '<div class="lk-rail__empty">还没有版本<br>选好事件，点下面的 ＋</div>'}
      </div>
      <div class="lk-rail__foot">
        <div class="lk-rail__pick">
          <span class="lk-rail__lbl">记到</span>
          <select id="cx-anchor" class="lk-rail__sel" title="新版本记在哪个事件上">
            ${all.length ? all.map((r) => `<option value="${escapeHtml(r.nodeId)}"${r.nodeId === anchor ? ' selected' : ''}>${escapeHtml(String(r.node.year ?? '') + ' ' + (r.node.title || ''))}</option>`).join('') : '<option value="">（这个世界还没有事件节点）</option>'}
          </select>
        </div>
        <div class="lk-rail__acts">
          <button class="lk-rail__add" data-rail-add="${escapeHtml(anchor)}"${anchor ? '' : ' disabled'}>＋ 记一帧</button>
          ${sel !== null && rs.some((r) => r.nodeId === sel)
            ? `<button class="lk-rail__del" data-rail-del="${escapeHtml(sel)}">删掉这一帧</button>`
            : ''}
        </div>
        <span class="lk-rail__hint">${escapeHtml(editHint())}</span>
      </div>`;

    /* 选中的那一格滚进视野 —— ⚠️ **只滚帧条自己那个滚动盒**，不能用 `scrollIntoView()`：
       它会把**所有**祖先滚动容器都滚一遍，而 `#cx-root` 正是整个面板的滚动容器 ⇒
       用户好不容易滚到正文中间，切个实体就被拉回别处（实测：面板 scrollTop 260 → 122，
       被既有套件 `codex-smooth-switch.cjs` 的 ★6 抓个正着）。 */
    const box = host.querySelector<HTMLElement>('.lk-rail__rows');
    const onEl = host.querySelector<HTMLElement>('.lk-rail__row.is-on');
    if (box && onEl) {
      const top = onEl.offsetTop;
      const bottom = top + onEl.offsetHeight;
      if (top < box.scrollTop) box.scrollTop = top;
      else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
    }
  }

  /** 锁定模式：改动固定落到锁定的那一帧（没有就落到离它最近的已有版本） */
  function lockedVersion(e: Entity | undefined): number {
    const lock = loadSettings().evolveLock;
    if (!e || !lock || lock.world !== store.activeWorld) return 0;
    const ep = epochMap();
    const r = rows().find((x) => x.nodeId === lock.nodeId);
    return r ? r.version : versionAtNode(e, (id) => ep.get(id) ?? 0, ep.get(lock.nodeId) ?? 0, lock.nodeId);
  }

  /* 事件：委托一次挂上，重画 innerHTML 后不用重挂 */
  host.addEventListener('click', (ev) => {
    const el = ev.target as HTMLElement;
    const add = el.closest<HTMLElement>('[data-rail-add]');
    if (add) { deps.onAddFrame(add.dataset.railAdd || ''); return; }
    const del = el.closest<HTMLElement>('[data-rail-del]');
    if (del) { deps.onDeleteFrame(del.dataset.railDel || ''); return; }
    const row = el.closest<HTMLElement>('[data-rail]');
    if (row) {
      if (loadSettings().evolveMode === 'locked') return;   /* 锁定模式：视图也钉在锁定点（见设置里的说明） */
      deps.onSelect(row.dataset.rail || null);
    }
  });
  /* 底部的「记到」下拉：换锚点 = 换"新版本记在哪个事件上"（不碰数据，只记在 codex 里） */
  host.addEventListener('change', (ev) => {
    const el = ev.target as HTMLElement;
    if (el instanceof HTMLSelectElement && el.id === 'cx-anchor' && el.value) deps.onAnchor(el.value);
  });

  return { render };
}

export { ROW_H };
