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
import { cloneIntoLayer, ghostLayerFor, rowsEnter, rowsLeaveAndRemove, rowsLeaveTotal, smoothBoxHeight } from './motion';
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
  /** **改动会写进哪一格**（null = 初稿）—— 用户 2026-09-13：「我希望切换帧时直接高亮要写到的地方」。
   *  ⚠️ 只算不写：不能拿 `codex.ts` 的 `editVersion()` 当代替，它会建帧、还会把视图挪过去。 */
  getWriteTarget: () => string | null;
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
  /* 「展开全部事件」（用户 2026-09-13 下午）：
     默认仍只列**有版本的**格子（上午那句「没有版本的节点就不显示」），
     点底部的展开行就把**还没版本的事件**也按时间插进来 —— **虚化**显示；
     点虚化那一行 = 换「记到」（＝底部下拉选框的同一件事，只是长在时间线上，更直观），
     **不改**正在看的版本（那一版还不存在，没什么可看）。
     状态放这里而不是 render 里重建，否则一重画就弹回收起。 */
  let showAll = false;
  /** 帧条上"展开/收起"用的动效参数：与左树文件夹的弹出/收回**同一档**（往上 8px、180ms、错峰 14ms、
   *  封顶 120ms —— 2026-09-14 用户：「文件收起的动画快一点，现在有一点停滞感」，两处一起调快才是一套）。 */
  /* 帧条那些行（展开出来的虚化行 / 收起时退场的行）的出入场参数。
     用户 2026-09-14 第三轮：「**帧面板节点的出入场换成左右移动（就像正文面板一样）**」
     ⇒ 不再用"上下 8px"（`dy`），改成与正文行级转场同一套左右位移：
     出场 `0 / 原地 → 左移 dx`（慢→快）、入场 `从右 dx → 原地`（快→慢）。
     ⚠️ `rowsLeave` 里 **`dy` 优先于 `dx`** ⇒ 这里绝不能给 `dy`。 */
  const EXIT = { dx: 32, dur: 200, step: 12, maxDelay: 96 } as const;
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
   *  没有版本的节点仍在下拉里可选（那是"给谁记版本"的入口），**展开后**也会以虚化行的形式列在这里。 */
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
    /* 「改动落到哪一格」——三种模式的落点不同（手动＝正在看的那版／自动＝「记到」那格／锁定＝锁住那格），
       codex 那边算好给这里点亮。它和「正在看的那一格」可以是**不同的两行**（手动模式站在第 2 版看、
       锚点却在第 5 个事件上），所以两种高亮各画各的。 */
    const write = deps.getWriteTarget();
    const mode = loadSettings().evolveMode;
    const modeText = mode === 'auto' ? '自动' : mode === 'locked' ? '锁定' : '手动';
    const all = allRows();
    const rs = all.filter((r) => r.hasFrame);
    /* 帧条上画的格子 = 有版本的 ∪ **改动要写进去的那一格**。
       ⚠️ 第二项是必须的：自动模式的「记到」常常还没版本（改动会自动在它上面开一版），
       而帧条默认只列有版本的格子 ⇒ 那一格根本不在屏幕上，"高亮要写到的地方"就无从谈起
       （实测 ★15c：`is-write` 一个都没有）。补进来的那一格是虚化样子 + 「改这里」标签。 */
    const shown = showAll ? all : all.filter((r) => r.hasFrame || r.nodeId === write);
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
      const sum = r.hasFrame
        ? (isEmptyPatch(frame?.patch) ? '（只是标记）' : patchSummary(frame?.patch))
        : '还没版本';
      const isAnchor = r.nodeId === anchor;
      /* 写目标：改动真会落进这一格（用户 2026-09-13：「切换帧时直接高亮要写到的地方」） */
      const isWrite = r.nodeId === write;
      /* 虚化行：还没版本的事件（只在"展开"时出现）。样式见 .lk-rail__row.is-ghost */
      const cls = `lk-rail__row${on ? ' is-on' : ''}${r.hasFrame ? ' is-frame' : ' is-ghost'}${isAnchor ? ' is-anchor' : ''}${isWrite ? ' is-write' : ''}`;
      /* 两种标签不同时挂（自动模式里两者是同一格，挂两个反而糊）：写目标优先 —— 它是"你改的东西会去哪" */
      const tag = isWrite ? '<span class="lk-rail__tag lk-rail__tag--write">改这里</span>'
        : (isAnchor ? '<span class="lk-rail__tag">记到</span>' : '');
      const tip = r.hasFrame
        ? `${r.tlName} · ${timeText(r.node)} ${note}${isWrite ? '（改动会写进这一格）' : ''}`
        : `${r.tlName} · ${timeText(r.node)} ${note}（还没版本 —— 点它 = 把新版本记到这个事件）`;
      return `<div class="${cls}" data-rail="${escapeHtml(r.nodeId)}"${r.hasFrame ? '' : ' data-ghost="1"'} title="${escapeHtml(tip)}">
        <span class="lk-rail__dot"></span>
        <span class="lk-rail__t">${escapeHtml(timeText(r.node))}</span>
        <span class="lk-rail__n">${escapeHtml(note)}${tag}</span>
        <span class="lk-rail__s">${escapeHtml(sum)}</span>
      </div>`;
    };
    /* 展开/收起的**开关**（用户 2026-09-14：「帧面板的展开和收起做成按钮放演化标题右边吧」）。
       它原来是列表底下那一行 —— 得先把帧条滚到底才点得到，而且自己还在"等距"的列表里占一块。
       现在是标题右边的按钮：不占列表高度、随时看得见。
       `data-rail-toggle` 这个钩子保持不变（点击委托在下面，套件也认它）。
       没有"还没版本的事件"可展开时**不出现**（没东西可切）。 */
    const toggleHtml = (n: number): string => (n === 0 && !showAll ? '' : `<button class="lk-rail__toggle" data-rail-toggle="1" title="${showAll ? `收起，只看有版本的事件（${rs.length} 个）` : `把还没版本的 ${n} 个事件也列出来（虚化显示，点它换「记到」）`}">${showAll ? '▴ 收起' : `▾ 全部（${rs.length + n}）`}</button>`);

    host.innerHTML = `
      <div class="lk-rail__head">
        <span class="lk-rail__title">演变</span>
        ${toggleHtml(all.length - rs.length)}
        <span class="lk-rail__mode" title="在「设置 → 设定演变」里改">${escapeHtml(modeText)}</span>
      </div>
      <div class="lk-rail__rows">
        <div class="lk-rail__row lk-rail__row--base${sel === null ? ' is-on' : ''}${write === null ? ' is-write' : ''}" data-rail="" title="初稿（实体 .md 里 frontmatter 的那一份）${write === null ? '；改动会写进这一格' : ''}">
          <span class="lk-rail__dot"></span>
          <span class="lk-rail__t">起点</span>
          <span class="lk-rail__n">初稿${write === null ? '<span class="lk-rail__tag lk-rail__tag--write">改这里</span>' : ''}</span>
          <span class="lk-rail__s">${e ? `${Object.keys(e.properties ?? {}).length} 个字段` : ''}</span>
        </div>
        ${shown.map(rowHtml).join('')}
        ${orphans.map((o) => `<div class="lk-rail__row${o.nodeId === sel ? ' is-on' : ''} is-frame" data-rail="${escapeHtml(o.nodeId)}" title="这一帧锚的节点已经被删掉了（历史仍保留）">
          <span class="lk-rail__dot"></span>
          <span class="lk-rail__t">孤立</span>
          <span class="lk-rail__n">节点已删除</span>
          <span class="lk-rail__s">${escapeHtml(patchSummary((e?.frames ?? [])[o.version - 1]?.patch))}</span>
        </div>`).join('')}
        ${rs.length + orphans.length ? '' : `<div class="lk-rail__empty">还没有版本<br>${mode === 'auto' ? '改一下字段就会自动记一版' : '选好事件，点下面的 ＋'}</div>`}
      </div>
      <div class="lk-rail__foot">
        <div class="lk-rail__pick">
          <span class="lk-rail__lbl">记到</span>
          <select id="cx-anchor" class="lk-rail__sel" title="新版本记在哪个事件上">
            ${all.length ? all.map((r) => `<option value="${escapeHtml(r.nodeId)}"${r.nodeId === anchor ? ' selected' : ''}>${escapeHtml(String(r.node.year ?? '') + ' ' + (r.node.title || ''))}</option>`).join('') : '<option value="">（这个世界还没有事件节点）</option>'}
          </select>
        </div>
        <div class="lk-rail__acts">
          ${mode === 'auto' ? '' : `<button class="lk-rail__add" data-rail-add="${escapeHtml(anchor)}"${anchor ? '' : ' disabled'}>＋ 记一帧</button>`}
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

  /** 虚化行的**出场/入场顺序**（用户 2026-09-14：「展开面板时也有错分，**离已有帧节点越近的越先出现**；
   *  出场也是一样，**离已有帧越远的帧越先退场**」）。
   *
   *  距离怎么算：帧条是**等距**的（每格 46px 钉死），所以"隔了几行"就是时间距离最直观的代理。
   *  锚点 = 那些**留在帧条上的**格子：有版本的行（`.is-frame`）+ 顶上永远的「初稿」行
   *  （`.lk-rail__row--base`）—— 用户嘴里的"已有帧"就是它们。
   *  `all` 与 `rows` 都是**同一个 DOM 顺序**（时间序）里的元素；`sort` 稳定 ⇒ 同距离的按时间先后。
   *  ⚠️ 出场那一路要在 `render()` **之前**调用：收起之后那些虚化行就不在 DOM 里了，
   *  距离只能在旧的（展开着的）那份列表上算。 */
  function orderByDistance(all: HTMLElement[], rows: HTMLElement[], farFirst: boolean): HTMLElement[] {
    const anchors = all
      .map((r, i) => (r.classList.contains('is-frame') || r.classList.contains('lk-rail__row--base') ? i : -1))
      .filter((i) => i >= 0);
    const dist = (el: HTMLElement): number => {
      const i = all.indexOf(el);
      if (i < 0 || !anchors.length) return 0;
      return Math.min(...anchors.map((j) => Math.abs(i - j)));
    };
    return rows.slice().sort((a, b) => (farFirst ? dist(b) - dist(a) : dist(a) - dist(b)));
  }

  /* 事件：委托一次挂上，重画 innerHTML 后不用重挂 */
  host.addEventListener('click', (ev) => {
    const el = ev.target as HTMLElement;
    const add = el.closest<HTMLElement>('[data-rail-add]');
    if (add) { deps.onAddFrame(add.dataset.railAdd || ''); return; }
    const del = el.closest<HTMLElement>('[data-rail-del]');
    if (del) { deps.onDeleteFrame(del.dataset.railDel || ''); return; }
    /* 「▾ 全部」/「▴ 收起」（标题右边那个按钮）：不是硬切，虚化行**逐行从右边滑进来**；收起时它们先化成
       幽灵（钉在原位、裁在帧条的滚动盒里）演一次退场，**退场走完**才收外面的框 ——
       与左树文件夹的展开/收起同一套原语（用户 2026-09-14：「git 管理面板里面的展开也做成平滑切换」）。
       顺序按**离最近的一版有多远**排（见 `orderByDistance`）：入场近的先出现、退场远的先走。 */
    if (el.closest('[data-rail-toggle]')) {
      const rowBox = host.querySelector<HTMLElement>('.lk-rail__rows');
      const boxBefore = rowBox ? rowBox.getBoundingClientRect().height : 0;
      const before = new Set([...host.querySelectorAll<HTMLElement>('.lk-rail__row')].map((r) => r.dataset.rail ?? ''));
      /* 收起前先排序 + 克隆：两者都必须在 `render()` 之前（`host.innerHTML` 一换它们就没了）。
         ⚠️ **别把裁切层的高度改成收起后的高度**：那一层是"退场中的虚化行"唯一的容身之处，
         当场缩下去＝把它们裁没（旧写法就是这么干的，慢一点的行整段看不见）。框的高度现在
         等退场走得差不多再缩（下面那个 `smoothBoxHeight` 的 delay），所以层也不需要跟。 */
      const dying = showAll
        ? orderByDistance(
            [...host.querySelectorAll<HTMLElement>('.lk-rail__row')],
            [...host.querySelectorAll<HTMLElement>('.lk-rail__row.is-ghost')],
            true)
        : [];
      const lay = rowBox && dying.length ? ghostLayerFor(rowBox, 860) : null;
      const ghosts = lay ? dying.map((r) => cloneIntoLayer(lay.layer, lay.rect, r, 'lk-list-ghost')) : [];
      showAll = !showAll;
      render();
      const boxAfter = host.querySelector<HTMLElement>('.lk-rail__rows');
      const fresh = [...host.querySelectorAll<HTMLElement>('.lk-rail__row')].filter((r) => !before.has(r.dataset.rail ?? ''));
      if (ghosts.length) {
        rowsLeaveAndRemove(ghosts, EXIT);
        /* 退场**走完**再收框（用户 2026-09-14：「收起时节点要先出场，外面的框再收起」）。
           原来是"走到六成就开始收"（`× 0.6`）：框一边缩、行一边淡，缩下去的那一段里行还没走完，
           看上去是框把行"啃"掉半截。`rowsLeaveTotal` 就是"单行时长 + 封顶后的错峰总量"。 */
        smoothBoxHeight(boxAfter, boxBefore, { delay: rowsLeaveTotal(ghosts.length, EXIT) });
      } else if (fresh.length) {
        /* 入场：**离最近的一版越近的越先出现**（`orderByDistance` 已按距离升序排好），从**右边**滑进来。
           ⚠️ `rowsEnter` 的 `start` 默认是 `dur`（那是给"先出后进"的正文转场用的）；帧条这里**必须
           显式给 0**，否则整批要等 200ms 才开始动 —— 框都在长了行还没出来。 */
        const enter = orderByDistance([...host.querySelectorAll<HTMLElement>('.lk-rail__row')], fresh, false);
        rowsEnter(enter, { dx: EXIT.dx, dur: EXIT.dur, step: EXIT.step, maxDelay: EXIT.maxDelay, start: 0 });
        /* 框晚半步再长高（`rowsLeaveTotal` 就是"单行时长 + 封顶后的错峰总量"，入场同档参数） */
        smoothBoxHeight(boxAfter, boxBefore, { delay: Math.round(rowsLeaveTotal(enter.length, EXIT) * 0.5) });
      }
      return;
    }
    const row = el.closest<HTMLElement>('[data-rail]');
    if (row) {
      if (loadSettings().evolveMode === 'locked') return;   /* 锁定模式：视图也钉在锁定点（见设置里的说明） */
      const id = row.dataset.rail || null;
      /* 虚化行（还没版本的事件）= 只换「记到」，**不动正在看的版本** ——
         这一版还不存在，没有"跳过去看"可谈；用户要的就是"下拉选框长在时间线上"这件事。 */
      if (id && row.dataset.ghost) { deps.onAnchor(id); return; }
      deps.onSelect(id);
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
