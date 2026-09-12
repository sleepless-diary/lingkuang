/** 灵框 · 设定库右侧的「演变」竖条（等距时间线）
 *
 *  用户 2026-09-13 的要求（原话）：「我想在设定库右侧加一条竖着的等距的时间线，用来储存不同节点，
 *  当选中实例时，默认进入离当前指针最近的 git」。
 *
 *  所以这一条**不是按时间比例画的**（不是甘特图），而是像 git log 一样**每一格等高**：
 *  一格 = 世界里的一个事件节点（所有时间线合起来按时间排），有帧的格子带点与差异摘要，
 *  顶上第一格是「初稿」。点哪一格 = 站在哪个事件上看这个实例。
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
  onSelect: (nodeId: string | null) => void;
  /** 点「＋记一帧」：在这一格上留一个版本 */
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

  /** 世界里的全部事件节点（所有时间线合起来），按时间排序 —— 就是这条竖线上的格子 */
  function rows(): Row[] {
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
    const mode = loadSettings().evolveMode;
    const modeText = mode === 'auto' ? '自动' : mode === 'locked' ? '锁定' : '手动';
    const rs = rows();
    const orphans = e ? orphanRows(e, rs) : [];
    /* 现在编辑会落到哪一版（选中格的版本）——手动模式下"没有版本的格子会改到上一版"，必须写在脸上 */
    const onRow = rs.find((r) => r.nodeId === sel);
    const frameHere = !!onRow?.hasFrame;
    const viewV = sel === null ? 0 : (onRow ? onRow.version : 0);
    const editV = mode === 'locked' ? lockedVersion(e) : viewV;
    /** 某一版的锚点标题（提示里要说清"改动会记到哪一版上"） */
    const noteFor = (v: number): string => {
      const f = (e?.frames ?? [])[v - 1];
      if (!f) return '初稿';
      return rs.find((x) => x.nodeId === f.nodeId)?.node.title || f.note || '更早的一版';
    };
    /** 底部那行小字：把"改哪里"讲明白（三种模式下语义不同，不写清楚会以为改的是别处） */
    const editHint = (): string => {
      if (!e) return '';
      if (mode === 'locked') return `锁定模式：改动都记在「${noteFor(editV)}」那一帧上`;
      if (sel === null) return '站在初稿上：改动改的是初稿';
      if (frameHere) return '';
      if (viewV === 0) return '这一格没有版本：改动会改到初稿上';
      return `这一格没有版本：改动会改到「${noteFor(viewV)}」那一版上`;
    };

    const rowHtml = (r: Row): string => {
      const on = r.nodeId === sel;
      const frame = (e?.frames ?? [])[r.version - 1];
      /* 这一行是**这个节点**的格子 ⇒ 标题必须是节点自己的标题。
         （曾经写成 `frame?.note || r.node.title`：没有版本的格子会顶上"上一版"的锚点标题，
         于是「霜冠加冕」那一格显示成「第一次魔潮」—— 截图走查抓到的。
         帧自己的 `note` 只在**有帧**时用作标题，两者不同就显示成 "节点名（帧备注）"。 */
      const note = r.hasFrame && frame?.note && frame.note !== r.node.title
        ? `${r.node.title}（${frame.note}）`
        : (r.node.title || frame?.note || '');
      /* 没有版本的格子：说明它"用的是哪一版"，比重复那一版的摘要有用 */
      const floorTitle = r.version > 0
        ? (rs.find((x) => x.nodeId === (e?.frames ?? [])[r.version - 1]?.nodeId)?.node.title
          || (e?.frames ?? [])[r.version - 1]?.note || '上一版')
        : '';
      const sum = r.hasFrame
        ? (isEmptyPatch(frame?.patch) ? '（只是标记）' : patchSummary(frame?.patch))
        : (r.version > 0 ? `沿用「${floorTitle}」那一版` : '（还没有版本）');
      return `<div class="lk-rail__row${on ? ' is-on' : ''}${r.hasFrame ? ' is-frame' : ''}" data-rail="${escapeHtml(r.nodeId)}" title="${escapeHtml(r.tlName + ' · ' + timeText(r.node) + ' ' + note)}">
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
        ${orphans.map((o) => `<div class="lk-rail__row${o.nodeId === sel ? ' is-on' : ''}" data-rail="${escapeHtml(o.nodeId)}" title="这一帧锚的节点已经被删掉了（历史仍保留）">
          <span class="lk-rail__dot"></span>
          <span class="lk-rail__t">孤立</span>
          <span class="lk-rail__n">节点已删除</span>
          <span class="lk-rail__s">${escapeHtml(patchSummary((e?.frames ?? [])[o.version - 1]?.patch))}</span>
        </div>`).join('')}
      </div>
      <div class="lk-rail__foot">
        ${sel === null
          ? `<span class="lk-rail__hint">选一个事件，才能在这一格留版本</span>`
          : frameHere
            ? `<span class="lk-rail__hint">这一格已经是版本</span>
             <button class="lk-rail__del" data-rail-del="${escapeHtml(sel)}">删掉这一帧</button>`
            : `<button class="lk-rail__add" data-rail-add="${escapeHtml(sel)}">＋ 在这一格记一帧</button>`}
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

  return { render };
}

export { ROW_H };
