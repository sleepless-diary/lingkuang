/** 地图模块——手绘矢量地图（区域 + 标记）+ **生成地形**，存 ws.maps[]
 *
 *  ⭐ 2026-10-15（用户：「好丑，有没有现成的轮子，我们生成的地图好假」→ 选定 A2「整包搬 mapgen4」）：
 *  **地形从"我们自己画的栅格图 + 矢量岸线"整体换成内核渲染的 WebGL 画布**
 *  （`src/mapgen/`，Apache-2.0，见 `src/mapgen/NOTICE.md`）—— 山成峰、河成网、迎风坡降雨、
 *  山体阴影与描边全由内核的 shader 画（原来那三条 SVG 岸线/湖岸/河因此删掉：内核已经画了）。
 *  层序变成：**地形画布（最底）→ 手绘 `regions` 文化分区（动手层）→ 手绘开放线 → 标记**。
 *  ⚠️ 画布与 SVG 一起放在 `#map-stage` 里：`fitView()` / 平移只动这**一个**元素，
 *  两者永远对齐（坐标都是地图自己的 900×500 空间，手绘落点不用换算）。
 *  内核世界是方的、内部位图 2048² ⇒ 取**中间横带**铺满地图格子（`bandLayout()`），不拉伸。
 *  ⭐ 2026-10-14（用户：「生成做成一个独立的面板吧，两种，创作者自己一个个调参数或者 AI 直出，
 *  可以抽卡」）：生成控件**从这里搬走**，进了 `src/ui/map-studio.ts` 那层悬浮面板；
 *  地图栏只留「生成地形…」一个入口 + 一行现状（`#map-gen-note`）。 */
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import { uid } from '../store/ids';
import type { MapData } from '../store/types';
import { escapeHtml } from './html';
import { DEFAULT_MAP, polylinePath, smoothClosedPath } from './map-gen';
import { mountTerrain, terrainStats } from './map-terrain';
import { openMapStudioFromToolbar } from './map-studio';

type Mode = 'region' | 'marker' | 'move';

/* 同 detail.ts：host 是长生命周期容器，重新渲染必须摘掉上一次的订阅，
   否则切到别的工具后旧订阅仍会往别人的界面里画东西。 */
let mapUnsub: (() => void) | null = null;
/* window 上的指针监听同理：只加不减的话，进出地图工具 N 次就叠 2N 个，
   且每个都还在对着已废弃的 SVG 跑重绘。 */
let mapCleanup: (() => void) | null = null;

export function renderMap(store: Store, host: HTMLElement): void {
  /* 首次进入若还没有地图就补一张默认地图（写入走 store.update，不直接改 data；
     建默认地图属于初始化，不占撤销格） */
  if (!currentWorld(store).maps?.length) {
    store.update((d) => {
      const w = d.worldsets[store.activeWorld];
      if (!w.maps || !w.maps.length) {
        w.maps = [DEFAULT_MAP()];
      }
    }, { undo: false, keepRedo: true });
  }

  /* 每次用时从 store 解析当前地图，不缓存对象引用：
     undo/redo（store.ts 直接替换整个 data）与外部 vault 重载都会让缓存的引用失效，
     旧代码缓存了 map，撤销后重绘时画的仍是那个已被丢弃的旧对象。 */
  /* 每次用时从 store 解析当前地图，不缓存对象引用：
     undo/redo（store.ts 直接替换整个 data）与外部 vault 重载都会让缓存的引用失效，
     旧代码缓存了 map，撤销后重绘时画的仍是那个已被丢弃的旧对象。
     ⚠️ `maps` 是**可选**字段，整体替换 worldsets 后的那一帧可能是 undefined：
     旧写法 `maps![0]` 在这里抛 TypeError，而 store.update 是先改数据后通知，
     异常会穿出 update 打断调用方 —— 实测过一次新建节点时：表单没被清空、
     src/main.ts 的 suppressWrite 卡在 true（此后永久不再自动落盘，静默丢数据）。
     现在返回 null，调用方跳过这一帧即可（下一次通知就会带上真地图）。 */
  const curMap = (): MapData | null => currentWorld(store).maps?.[0] ?? null;

  let mode: Mode = 'move';
  let drawing: [number, number][] = [];

  host.style.overflow = 'hidden';
  host.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;">
      <div style="display:flex;flex-wrap:wrap;gap:6px;row-gap:4px;padding:6px 10px;border-bottom:1px solid var(--border-soft);background:var(--surface-2);align-items:center;">
        <span style="font-size:var(--text-xs);font-weight:600;color:var(--fg);">地图 · ${escapeHtml(curMap()?.name ?? '默认地图')}</span>
        <span id="map-gen-note" style="font-size:var(--text-xs);color:var(--fg-2);"></span>
        <span style="flex:1;"></span>
        <button id="map-gen" title="打开地图生成面板：自己一个个调参数 / AI 直出 / 抽卡" style="background:none;border:1px solid var(--accent);color:var(--accent);border-radius:var(--radius-sm);font-size:11px;padding:3px 10px;cursor:pointer;">生成地形…</button>
        <span style="width:1px;height:16px;background:var(--border-soft);"></span>
        <button data-mode="region" class="map-mode" style="background:none;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:3px 10px;cursor:pointer;">区域</button>
        <button data-mode="marker" class="map-mode" style="background:none;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:3px 10px;cursor:pointer;">标记</button>
        <button data-mode="move" class="map-mode" style="background:none;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:3px 10px;cursor:pointer;">移动</button>
        <button id="map-clear" style="background:none;border:1px solid #c0392b;color:#c0392b;border-radius:var(--radius-sm);font-size:11px;padding:3px 10px;cursor:pointer;">清空标记</button>
        <span id="map-hint" style="font-size:var(--text-xs);color:var(--fg-2);">拖拽画区域（松开闭合）</span>
      </div>
      <div style="flex:1;position:relative;overflow:hidden;">
        <div id="map-stage" style="position:absolute;left:0;top:0;transform-origin:0 0;">
          <div id="map-terrain" style="position:absolute;left:0;top:0;background:var(--surface-2);overflow:hidden;"></div>
          <svg id="map-svg" width="${curMap()?.width ?? 900}" height="${curMap()?.height ?? 500}" style="position:absolute;left:0;top:0;background:transparent;touch-action:none;"></svg>
        </div>
      </div>
    </div>`;

  const svg = host.querySelector('#map-svg') as unknown as SVGSVGElement;
  /* 缩放/平移只动 #map-stage（画布与 SVG 的公共父层）⇒ 两层永远对齐 */
  const stage = host.querySelector('#map-stage') as HTMLElement;
  const terrainBox = host.querySelector('#map-terrain') as HTMLElement;
  let terrainCanvas: HTMLCanvasElement | null = null;
  let disposeTerrain: (() => void) | null = null;
  let terrainKey = '';
  const hint = host.querySelector('#map-hint') as HTMLElement;
  let labelSeq = 1;

  function setMode(m: Mode) {
    mode = m;
    drawing = [];
    host.querySelectorAll('.map-mode').forEach((b) => (b as HTMLElement).style.background = 'none');
    const btn = host.querySelector(`.map-mode[data-mode="${m}"]`) as HTMLElement;
    if (btn) btn.style.background = 'rgba(158,194,98,.2)';
    hint.textContent = m === 'region' ? '区域' : m === 'marker' ? '标记' : '平移';
    hint.title = m === 'region' ? '拖拽画区域（松开闭合）' : m === 'marker' ? '点击放置标记' : '拖拽平移';
  }
  host.querySelectorAll('.map-mode').forEach((b) =>
    (b as HTMLElement).addEventListener('click', () => setMode((b as HTMLElement).dataset.mode as Mode))
  );
  host.querySelector('#map-clear')?.addEventListener('click', () => {
    /* 必须走 save()：旧写法只改内存里的 map 再 renderSvg()，既不通知订阅者，
       也就不会触发 main.ts 的 400ms 防抖落盘 → 关掉窗口就丢。 */
    save((m) => { m.markers = []; });
  });

  /* ── 生成地形：控件已经搬进**地图生成工作室**（`src/ui/map-studio.ts` 的悬浮面板 ——
     用户 2026-10-14：「生成做成一个独立的面板吧，两种，创作者自己一个个调参数或者 AI 直出，
     可以抽卡」）。地图栏这里只留**一个入口**（`#map-gen`）与一行现状（`#map-gen-note`）。
     落盘仍只有一条路：`src/ui/map-gen.ts` 的 `generateIntoMap()` —— 工作室的「采用到地图」
     与助手的 `generate_map` 动作共用它，一次 store.update ⇒ 一步 Ctrl+Z 就能撤销回去。 */
  const genNote = host.querySelector('#map-gen-note') as HTMLElement;
  host.querySelector('#map-gen')?.addEventListener('click', () => { openMapStudioFromToolbar(store); });
  setMode('move');

  function renderSvg() {
    const m = curMap();
    if (!m) { svg.innerHTML = ''; return; }   /* maps 瞬时缺失（worldsets 被整体替换中）→ 这一帧不画 */
    syncTerrain(m);
    const regions = m.regions
      .map(
        (r) =>
          `<path d="${r.path}" fill="${r.fill}" fill-rule="${r.rule ?? 'nonzero'}" stroke="rgba(58,58,52,.5)" stroke-width="1" data-region="${escapeHtml(r.name)}" style="cursor:pointer;" title="${escapeHtml(r.name)}"/>`
      )
      .join('');
    /* 开放线（手绘水系 / 轨迹）：画在区域之上、标记之下。`lines` 可选（旧数据没有）。 */
    const lines = (m.lines ?? [])
      .map(
        (l) =>
          `<path d="${polylinePath(l.points)}" fill="none" stroke="${l.color ?? 'var(--fg-2)'}" stroke-width="${l.width ?? 1.5}" stroke-linecap="round" stroke-linejoin="round" data-line-kind="${l.kind}"${l.name ? ` data-line="${escapeHtml(l.name)}"` : ''}/>`
      )
      .join('');
    const markers = m.markers
      .map(
        (mk) =>
          `<g transform="translate(${mk.x},${mk.y})" style="cursor:pointer;">
            <circle r="6" fill="var(--accent)" stroke="var(--accent-on)" stroke-width="1"/>
            <text y="-10" text-anchor="middle" style="font-size:10px;fill:var(--fg);">${escapeHtml(mk.label)}</text>
          </g>`
      )
      .join('');
    const drawingPath = drawing.length > 1 ? `<path d="${smoothClosedPath(drawing)}" fill="rgba(158,194,98,.15)" stroke="var(--accent)" stroke-width="1" stroke-dasharray="4 2"/>` : '';
    /* 层序：地形画布（`#map-terrain`，**在 SVG 底下**，内核渲染的）+ 手绘开放线 → 标记
       → 正在画的那一笔。（原来的矢量岸线/湖岸/河已删：内核的 shader 自己会画。）*/
    svg.innerHTML = regions + lines + markers + drawingPath;
  }

  /* ── 地形画布：只在**参数真的变了**的时候重建（生成一次约 30~60ms），
     同一帧里手绘层的重画不影响它。参数键一样 ⇒ 什么都不做。 */
  function syncTerrain(m: MapData) {
    terrainBox.style.width = m.width + 'px';
    terrainBox.style.height = m.height + 'px';
    const s = terrainStats(m.terrain, m.width, m.height);
    genNote.textContent = s && m.terrain
      ? `${s.lands} 块陆地 · ${s.islands} 座岛 · ${s.rivers} 条河 · 最高峰约 ${s.peak} m · 陆地占 ${Math.round(s.landRatio * 100)}% · 种子「${m.terrain.seed}」`
      : '还没有地形';
    const key = m.terrain
      ? `${m.terrain.seed}|${m.terrain.style}|${JSON.stringify(m.terrain.spec ?? {})}|${m.width}x${m.height}`
      : '';
    if (key === terrainKey) return;
    terrainKey = key;
    disposeTerrain?.();
    disposeTerrain = null;
    if (!m.terrain) { terrainCanvas?.remove(); terrainCanvas = null; return; }
    if (!terrainCanvas) {
      terrainCanvas = document.createElement('canvas');
      terrainCanvas.id = 'map-terrain-canvas';
      terrainCanvas.setAttribute('data-terrain', '1');
      terrainBox.appendChild(terrainCanvas);
    }
    try {
      disposeTerrain = mountTerrain(terrainCanvas, m.terrain, m.width, m.height);
    } catch {
      /* 拿不到 WebGL（老机器/禁用显卡）⇒ 地图栏退化成"只有手绘层"，不炸整个沙盘 */
      genNote.textContent = '这台机器开不了 WebGL2，地形画不出来（手绘区域照常能用）';
      terrainCanvas.remove();
      terrainCanvas = null;
      terrainKey = '';
    }
  }

  let panning = false, panX = 0, panY = 0, panSX = 0, panSY = 0;

  /* ⭐ 适应窗口：地图数据一直是 900×500，而沙盘右半边那格比它窄 —— 不缩的话生成完只能
     看到左上角一块（2026-10-13 真机截图发现的）。缩放只动 CSS transform，不动数据；
     代价是**指针坐标要按缩放比换算回 SVG 用户坐标**（见 `local()`），否则手绘会画偏。
     ⚠️ 动的元素是 `#map-stage`（地形画布与 SVG 的公共父层）—— 只动 SVG 的话地形会跟着错位。 */
  let viewScale = 1;
  function fitView() {
    const m = curMap();
    const box = stage.parentElement;
    if (!m || !box) return;
    const bw = box.clientWidth || m.width;
    const bh = box.clientHeight || m.height;
    viewScale = Math.min(bw / m.width, bh / m.height, 1);
    stage.style.transformOrigin = '0 0';
    stage.style.transform = `scale(${viewScale})`;
    stage.style.left = Math.max(0, Math.round((bw - m.width * viewScale) / 2)) + 'px';
    stage.style.top = Math.max(0, Math.round((bh - m.height * viewScale) / 2)) + 'px';
  }
  /** 视口坐标 → SVG 用户坐标（缩放后 rect 变小了，必须除回来） */
  function local(e: PointerEvent): [number, number] {
    const r = svg.getBoundingClientRect();
    const k = (curMap()?.width ?? 900) / (r.width || 1);
    return [(e.clientX - r.left) * k, (e.clientY - r.top) * k];
  }

  /* 收尾统一入口。commit=true（正常 pointerup）才把区域落盘；
     其余情况（pointercancel、丢失的 pointerup）丢弃这一笔，避免半成品区域写进数据。 */
  function endDrag(commit: boolean) {
    if (commit && mode === 'region' && drawing.length >= 3) {
      const pts = drawing;
      const fill = `rgba(${158 + Math.floor(Math.random() * 60)},${150 + Math.floor(Math.random() * 50)},${98},0.25)`;
      save((m) => {
        m.regions.push({
          id: uid('rg'),
          name: `区域 ${m.regions.length + 1}`,
          points: pts,
          path: smoothClosedPath(pts),
          fill,
        });
      });
    }
    drawing = [];
    panning = false;
    renderSvg();
  }

  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // 右键/中键不画区域、不拖画布
    const [x, y] = local(e);
    if (mode === 'region') {
      drawing = [[x, y]];
      renderSvg();
    } else if (mode === 'marker') {
      save((m) => { m.markers.push({ id: uid('mk'), x, y, label: `M${labelSeq++}` }); });
    } else {
      panning = true;
      panSX = e.clientX; panSY = e.clientY;
      /* 平移基准取当前 inline style 的 left/top——与下面赋值的 style.left/top 同一坐标系。
         旧代码用 getBoundingClientRect()（视口坐标）当基准，第一帧会把 SVG 平移一个
         「容器在视口中的偏移」那么多，表现为一拖就瞬移。 */
      panX = parseFloat(stage.style.left) || 0;
      panY = parseFloat(stage.style.top) || 0;
    }
  });
  const onMove = (e: PointerEvent) => {
    /* 丢失 pointerup 的兜底：没按键却收到 move，说明收尾信号丢了
       （在窗口外松开 / pointercancel 没派发），就地收尾——否则会一直画下去或一直平移。 */
    if (e.buttons === 0) {
      if (panning || drawing.length) endDrag(false);
      return;
    }
    if (mode === 'region' && drawing.length) {
      drawing.push(local(e));
      renderSvg();
    } else if (panning) {
      stage.style.left = panX + (e.clientX - panSX) + 'px';
      stage.style.top = panY + (e.clientY - panSY) + 'px';
    }
  };
  const onUp = () => endDrag(true);
  const onCancel = () => endDrag(false);
  const onResize = () => fitView();
  /* ⭐ 只监听 window.resize 是不够的：地图栏**自己**也会变高变矮 —— 上面那行状态文字一变长
     （生成地形后正是如此）就换行、工具栏变高、下面的格子变矮，而缩放还按老高度算 ⇒
     图被切掉一截（第九十三轮实测：格子 289→261，缩放仍按 289）。ResizeObserver 一并盯住。 */
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => fitView()) : null;
  if (ro && stage.parentElement) ro.observe(stage.parentElement);
  mapCleanup?.();
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('resize', onResize);
  mapCleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('resize', onResize);
    ro?.disconnect();
    disposeTerrain?.();   /* ⭐ 地形画布后面挂着 WebGL 上下文（4 张 2048² FBO）—— 必须销毁 */
    disposeTerrain = null;
    terrainKey = '';
  };

  /* 改动必须发生在 store.update 内部：update() 先把「当前」data 深拷贝进撤销栈，
     再执行 fn。旧写法是「先直接改 map —— 而 map 就是 ws.maps[0] 这个活引用 ——
     再调用 update 把同一个对象赋回去」，于是快照里已经含着这次改动，
     撤销/重做对地图等于完全无效。 */
  function save(mutate: (m: MapData) => void) {
    store.update((d) => {
      const m = d.worldsets[store.activeWorld]?.maps?.[0];
      if (m) mutate(m);
    });
  }

  mapUnsub?.();
  mapUnsub = store.subscribe(() => {
    /* #map-svg 只由本模块产出：容器被别的工具接管 → 自行退订（window 监听一并摘掉） */
    if (!host.isConnected || !host.querySelector('#map-svg')) {
      mapUnsub?.();
      mapUnsub = null;
      mapCleanup?.();
      mapCleanup = null;
      return;
    }
    renderSvg();
  });
  fitView();
  renderSvg();
}
