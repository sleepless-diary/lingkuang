/** 地图模块——手绘矢量地图（区域 + 标记）+ **生成地形**，存 ws.maps[]
 *
 *  ⭐ 2026-10-15（用户：「好丑，有没有现成的轮子，我们生成的地图好假」→ 选定 A2「整包搬 mapgen4」）：
 *  **地形从"我们自己画的栅格图 + 矢量岸线"整体换成内核渲染的 WebGL 画布**
 *  （`src/mapgen/`，Apache-2.0，见 `src/mapgen/NOTICE.md`）—— 山成峰、河成网、迎风坡降雨、
 *  山体阴影与描边全由内核的 shader 画（原来那三条 SVG 岸线/湖岸/河因此删掉：内核已经画了）。
 *  层序变成：**地形画布（最底）→ 手绘 `regions` 文化分区（动手层）→ 手绘开放线 → 标记**。
 *  ⚠️ 画布与 SVG 一起放在 `#map-stage` 里：`fitView()` / 平移只动这**一个**元素，
 *  两者永远对齐（坐标都是地图自己的 900×500 空间，手绘落点不用换算）。
 *  内核世界是方的、内部位图 1536² ⇒ 取**中间横带**铺满地图格子（`bandLayout()`），不拉伸。
 *  ⭐ 2026-10-14（用户：「生成做成一个独立的面板吧，两种，创作者自己一个个调参数或者 AI 直出，
 *  可以抽卡」）：生成控件**从这里搬走**，进了 `src/ui/map-studio.ts` 那层悬浮面板；
 *  地图栏只留「生成地形…」一个入口 + 一行现状（`#map-gen-note`）。
 *  ⭐ 2026-10-31（第一百三十四轮，用户：「能不能底下的地图只是一个展示器，点一下才能进入
 *  地图编辑模式，包括划区域什么的」）：这一格**默认是展示器**（工具条不出现、手绘层不接指针、
 *  点一下 = 看大图）；点「编辑…」或大图里的「编辑」⇒ **同一个 DOM 就地升成全屏画板**
 *  （`.lk-map-edit`，`position:fixed`），工具条才出现；「完成」/Esc 退回展示。 */
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import { uid } from '../store/ids';
import type { MapData } from '../store/types';
import { escapeHtml } from './html';
import { DEFAULT_MAP, polylinePath, regionIsSliver, regionPaths, regionPoints, smoothClosedPath } from './map-gen';
import {
  bandLayout, mountTerrain, resetTerrainPaint, terrainStats, liftOf, type TerrainHandle, type TerrainStats,
} from './map-terrain';
import { cachedStats, ensureMapCache, mapCacheKey, putCachedTerrain, readCachedTerrainImage } from './map-cache';
import {
  PLANET_VIEW_H, mountGlobePrepared, mountPlanetPrepared, planetFieldAsync, planetRgbaAsync,
} from './planet-view';
import { nextFrame, showBusy, type BusyHandle } from './busy';
import { openLightbox } from './lightbox';
import {
  CONTOUR_MODES, TERRAIN_STYLES, contourModeLabel, contourModeOf, terrainStyleLabel, terrainStyleOf,
} from '../mapgen';
import { mapFormLabel, mapFormOf } from '../mapgen/planet';
import { openMapStudioFromToolbar } from './map-studio';
import { openMapEditor } from './map-editor';
import { hdCached, hdImageFor } from './map-hd';

type Mode = 'region' | 'marker' | 'move';
/** 两套内核的句柄**同形**（dispose / setStyle / regenerate）—— 地图栏不关心底下是哪一个 */
type TerrainLayer = TerrainHandle | ReturnType<typeof mountPlanetPrepared>;

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
  /* 地图栏（2026-10-25 工作台化 D）：
     原来 10 个控件挤在一行、三种高度（19/23/24px）、还有一个孤零零的竖线分隔符，
     顺序是「生成地形 / 等高线 / 球体看 / 风格 / 立体 / 区域 | 标记 / 手绘 / 移动 / 清空标记」——
     动作、画法、模式三件事交叉混排，看不出哪几个是一组。
     现在按**用途**排成四簇，中间用 `.lk-tbsep` 竖线隔开，模式收成一件分段控件：
       [生成地形][地形·手绘] ｜ [等高线][风格][立体][球体看] ｜ [移动|区域|标记] ｜ [清空标记]
     高度统一 24px（`.lk-tbx` / `.lk-seg`），与时间线面板头同一套原语。 */
  host.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;">
      <div id="map-head" style="display:flex;flex-wrap:wrap;gap:8px;row-gap:4px;padding:6px 10px;border-bottom:1px solid var(--border-soft);background:var(--surface-2);align-items:center;">
        <span style="font-size:var(--text-xs);font-weight:600;color:var(--fg);">地图 · ${escapeHtml(curMap()?.name ?? '默认地图')}</span>
        <span id="map-gen-note" style="font-size:var(--text-xs);color:var(--fg-2);"></span>
        <span style="flex:1;"></span>
        <button id="map-edit" class="lk-tbx" title="进入编辑模式（全屏）：划区域 / 放标记 / 换画法 / 生成地形">编辑…</button>
      </div>
      <div id="map-toolbar" style="display:none;flex-wrap:wrap;gap:6px;row-gap:4px;padding:6px 10px;border-bottom:1px solid var(--border-soft);background:var(--surface-2);align-items:center;">
        <span class="lk-tbg">
          <button id="map-gen" class="lk-tbx lk-tbx--accent" title="打开地图生成面板：自己一个个调参数 / AI 直出 / 抽卡">生成地形…</button>
          <button id="map-editor" class="lk-tbx" title="手绘大陆与海洋：全屏画板（可滚动缩放、拖动），画完按剪影生成整颗星球">地形 · 手绘…</button>
        </span>
        <span class="lk-tbsep"></span>
        <span class="lk-tbg">
          <select id="map-contour" class="lk-tbx" title="等高线画法：自动 = 按屏幕线距自动跳线（陡坡变稀 / 平地全显示）；也可以强制「全部 / 减半 / 每五条」">${CONTOUR_MODES.map((c) => `<option value="${c.id}" title="${escapeHtml(c.hint)}">${escapeHtml(c.label)}</option>`).join('')}</select>
          <select id="map-view" class="lk-tbx" title="看的方式：地形怎么画（九档：自然 / 地形图 / 等高线地形图 / 羊皮纸 / 水墨 / 蓝图 / 梦核 / 卫星 / 极简）—— 只换画法，不重算地形">${TERRAIN_STYLES.map((s) => `<option value="${s.id}" title="${escapeHtml(s.hint)}">${escapeHtml(s.label)}</option>`).join('')}</select>
          <select id="map-lift" class="lk-tbx" title="立体度：立体 = 山有厚度（能看到山坡侧面）；顶视 = 从正上方看（没有侧壁，只有色带与明暗）—— 只换看法，不重算地形"><option value="solid" title="山有厚度：能看见山坡侧面与投影（默认）">立体</option><option value="flat" title="正上方俯视：山只靠色带与明暗表达高度，没有侧壁">顶视</option></select>
          <button id="map-globe" class="lk-tbx" title="球体看：把星球图贴到一颗真球上（拖动旋转、滚轮缩放）—— 只在星球形态下出现" style="display:none;">球体看</button>
        </span>
        <span class="lk-tbsep"></span>
        <span class="lk-seg" id="map-modes">
          <button data-mode="move" class="map-mode" title="移动：拖拽平移地图">移动</button>
          <button data-mode="region" class="map-mode" title="区域：拖拽画区域（松开闭合）">区域</button>
          <button data-mode="marker" class="map-mode" title="标记：点击放置标记">标记</button>
        </span>
        <span class="lk-tbsep"></span>
        <button id="map-clear" class="lk-tbx lk-tbx--danger" title="清空这张地图上的全部标记">清空标记</button>
        <button id="map-done" class="lk-tbx lk-tbx--accent" title="退出编辑模式，回到展示（Esc）">完成</button>
        <span id="map-hint" style="font-size:var(--text-2xs);color:var(--fg-2);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">拖拽平移</span>
      </div>
      <div style="flex:1;position:relative;overflow:hidden;">
        <div id="map-stage" style="position:absolute;left:0;top:0;transform-origin:0 0;">
          <div id="map-terrain" style="position:absolute;left:0;top:0;background:var(--surface-2);overflow:hidden;"></div>
          <svg id="map-svg" width="${curMap()?.width ?? 900}" height="${curMap()?.height ?? 500}" style="position:absolute;left:0;top:0;background:transparent;touch-action:none;"></svg>
        </div>
        <div id="map-view-hint" style="position:absolute;left:12px;bottom:10px;font-size:var(--text-2xs);color:var(--fg-2);opacity:.85;pointer-events:none;">点一下看大图 · 右上「编辑…」动手改</div>
      </div>
    </div>`;

  const svg = host.querySelector('#map-svg') as unknown as SVGSVGElement;
  /* 展示态：手绘层不接指针 —— 点一下要落到整格上，用来开大图（`setEditing(true)` 时恢复） */
  svg.style.pointerEvents = 'none';
  /* 缩放/平移只动 #map-stage（画布与 SVG 的公共父层）⇒ 两层永远对齐 */
  const stage = host.querySelector('#map-stage') as HTMLElement;
  const terrainBox = host.querySelector('#map-terrain') as HTMLElement;
  let terrainCanvas: HTMLCanvasElement | null = null;
  let terrainHandle: TerrainLayer | null = null;
  let terrainKey = '';
  /* ⭐ 「看的方式」：上一次已经推给 GPU 的那一档（与 `terrainKey` 分开 —— 换风格不重建画布）*/
  let terrainStyleKey = '';
  /* ⭐ 第一百零六轮：加载遮罩的句柄 + 重建序号（切得快时旧任务自己作废）*/
  let busy: BusyHandle | null = null;
  let rebuildSeq = 0;
  /* ⭐ 「球体看」（第九十八轮）：星球形态下的第二个视图（平面图 ⇄ 真球），只对星球有效 */
  let globeOn = false;
  const hint = host.querySelector('#map-hint') as HTMLElement;
  let labelSeq = 1;

  /* ── 展示态 / 编辑态（第一百三十四轮）──────────────────────────────────────
     用户 2026-10-31：「能不能底下的地图只是一个展示器，点一下才能进入地图编辑模式，
     包括划区域什么的」。目的（追问确认）：先看大图，真要动手再进编辑器。
     ⇒ 地图格默认**只读**：没有工具条、不接指针、点一下 = 看大图；
        进编辑 = 点「编辑…」（或大图里那颗「编辑」）⇒ 这一格升成**全屏画板**，工具条才出现，
        划区域 / 放标记 / 拖平移 / 换画法 / 生成地形都在那里；「完成」或 Esc 退回展示。
     ⚠️ 做法是**同一个 DOM 就地升成全屏**（`host` 加 `lk-map-edit` 变 fixed），
        不是另挂一套画布 —— 那会多一整块 WebGL 上下文（4 张 1536² FBO）和一套订阅。
        `fitView()` 量的是 `stage.parentElement`，全屏后尺寸变了，`ResizeObserver` 会自己补一帧。 */
  let editing = false;
  const toolbar = host.querySelector('#map-toolbar') as HTMLElement;
  const editBtn = host.querySelector('#map-edit') as HTMLButtonElement;
  const doneBtn = host.querySelector('#map-done') as HTMLButtonElement;
  const viewHint = host.querySelector('#map-view-hint') as HTMLElement;
  /* 展示态点一下 = 看大图：**整格**都算（不只是 SVG 那 900×500 —— 格子比图大时四周有一圈留白），
     而且拖过（>4px）就不算点击。按下在格子上、松手可能在窗口任何地方 ⇒ 收尾挂在 window 那个
     `onUp` 上（`tools/e2e` 里也有"按下发在 svg、松手发在 window"的合成手势）。 */
  const viewBox = stage.parentElement as HTMLElement;
  let tapDown = false, tapMoved = false, tapX = 0, tapY = 0;

  function onEditKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    setEditing(false);
  }

  function setEditing(on: boolean): void {
    if (editing === on) return;
    editing = on;
    host.classList.toggle('lk-map-edit', on);
    document.body.classList.toggle('lk-map-editing', on);
    toolbar.style.display = on ? 'flex' : 'none';
    editBtn.style.display = on ? 'none' : '';
    viewHint.hidden = on;
    /* 展示态：手绘层不接指针（点一下要落到整格上，用来开大图） */
    svg.style.pointerEvents = on ? '' : 'none';
    tapDown = false;
    if (on) {
      drawing = [];
      setMode('move');
      hint.textContent = '拖拽平移 · 区域/标记在左边切换';
      window.addEventListener('keydown', onEditKey);
    } else {
      endDrag(false);
      panning = false;
      window.removeEventListener('keydown', onEditKey);
    }
    /* 进/出都重算一次"适应窗口"：全屏 ↔ 格子两种尺寸（ResizeObserver 也会补，但这一帧更跟手） */
    window.requestAnimationFrame(() => fitView());
  }

  editBtn.addEventListener('click', () => setEditing(true));
  doneBtn.addEventListener('click', () => setEditing(false));
  viewBox.addEventListener('pointerdown', (e) => {
    if (editing || e.button !== 0) return;
    tapDown = true;
    tapMoved = false;
    tapX = e.clientX;
    tapY = e.clientY;
  });

  function setMode(m: Mode) {
    mode = m;
    drawing = [];
    /* 分段控件的高亮交给 CSS（`.lk-seg > button.is-on`）——
       原来这里直接写 `style.background`，于是"选中态"和别的面板的按钮长得不是一套。 */
    host.querySelectorAll('.map-mode').forEach((b) => (b as HTMLElement).classList.toggle('is-on', (b as HTMLElement).dataset.mode === m));
    /* 提示行两段：短名 + 悬停说明（照旧是中栏那行的写法，不加图标） */
    const move: [string, string] = ['拖拽平移', '拖拽平移地图'];   /* 编辑态才有"点一下"以外的手势 */
    const tips: Record<Mode, [string, string]> = {
      region: ['拖拽画区域（松开闭合）', '拖拽画区域（松开闭合）'],
      marker: ['点击放置标记', '点击放置标记'],
      move,
    };
    hint.textContent = tips[m][0];
    hint.title = tips[m][1];
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
  const viewSel = host.querySelector('#map-view') as HTMLSelectElement;
  const contourSel = host.querySelector('#map-contour') as HTMLSelectElement;
  const liftSel = host.querySelector('#map-lift') as HTMLSelectElement;
  const globeBtn = host.querySelector('#map-globe') as HTMLButtonElement;
  host.querySelector('#map-gen')?.addEventListener('click', () => { openMapStudioFromToolbar(store); });
  /* ⭐ 手绘海陆（第一百零八轮）：全屏画板，画完按剪影生成星球（落盘仍走 generateIntoMap）*/
  host.querySelector('#map-editor')?.addEventListener('click', () => { openMapEditor(store); });
  /* ⭐ 「看的方式」（第九十七轮）：改了**只重画**（`syncTerrain` 里换渲染参数），不重算地形。
     落盘照走 `save()`（一步撤销）—— 与面板「采用到地图」同一条路，不留第二份状态。 */
  viewSel.addEventListener('change', () => {
    const v = viewSel.value;
    if (!curMap()?.terrain) return;
    save((mm) => { if (mm.terrain) mm.terrain.view = v; });
  });
  /* ⭐ 等高线方式（第一百零八轮）：用户「有些地方因为地形陡峭导致等高线有点密集」。
     只是**显示参数** ⇒ 落盘照走 `save()`（一步撤销），换它不重算地形。 */
  contourSel.addEventListener('change', () => {
    const v = contourSel.value;
    if (!curMap()?.terrain) return;
    save((mm) => { if (mm.terrain) mm.terrain.contour = v; });
  });
  /* ⭐ 「立体度」（第一百零四轮）：立体（山有厚度、能看到山坡侧面）⇄ 顶视（正上方看，没有侧壁）。
     只改渲染的垂直夸张（`mountain_height`），**不重算地形**；落盘照走 `save()`（一步撤销）。 */
  liftSel.addEventListener('change', () => {
    const v = liftSel.value;
    if (!curMap()?.terrain) return;
    save((mm) => { if (mm.terrain) mm.terrain.lift = v; });
  });
  globeBtn.addEventListener('click', () => {
    globeOn = !globeOn;
    if (globeOn) setMode('move');        /* 球体上看不了手绘：切回平移档 */
    terrainKey = '';                     /* 逼 syncTerrain 重挂（平面画布 ⇄ 球体） */
    renderSvg();
  });
  setMode('move');

  function renderSvg() {
    const m = curMap();
    if (!m) { svg.innerHTML = ''; return; }   /* maps 瞬时缺失（worldsets 被整体替换中）→ 这一帧不画 */
    /* 刚松手的那一帧**不重建地形**（见 endPaint 的注释）：等空闲那一趟再来 */
    syncTerrain(m);
    /* 球体上看不了手绘：区域/标记是**地图平面坐标**，要投到球面上得另做一遍投影（本轮不做）
       ⇒ 藏起来 + 关掉指针，免得笔画在旋转的球上对不上位置。切回平面就恢复。 */
    const onGlobe = mapFormOf(m.terrain?.form) === 'planet' && globeOn;
    svg.style.opacity = onGlobe ? '0' : '1';
    svg.style.pointerEvents = onGlobe ? 'none' : '';
    const regions = m.regions
      /* 细长条区域不画：那是「在地图上拖了一下」被当成区域的产物，画出来就是一条斜线
         （第一百一十轮用户报的"尖角"）。判据见 regionIsSliver。 */
      .filter((r) => !regionIsSliver(r.points?.length >= 4 ? r.points : (regionPoints(r.path) ?? [])))
      .map((r) => {
        /* 老 path 里可能带着"松开补的直边"和起收笔的钩状凸起（见 regionPaths 注释）：
           重算一遍端点再画，填色与描边分开 —— 描边只描真正画过的笔迹。 */
        const rp = regionPaths(r.path);
        const stroke = rp.stroke === rp.fill
          ? ''
          : `<path d="${rp.stroke}" fill="none" stroke="rgba(58,58,52,.5)" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" pointer-events="none"/>`;
        return `<path d="${rp.fill}" fill="${r.fill}" fill-rule="${r.rule ?? 'nonzero'}" stroke="${rp.stroke === rp.fill ? 'rgba(58,58,52,.5)' : 'none'}" stroke-width="1" data-region="${escapeHtml(r.name)}" style="cursor:pointer;" title="${escapeHtml(r.name)}"/>${stroke}`;
      })
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
            <text y="-10" text-anchor="middle" style="font-size:11px;fill:var(--fg);">${escapeHtml(mk.label)}</text>
          </g>`
      )
      .join('');
    const drawingPath = drawing.length > 1 ? `<path d="${smoothClosedPath(drawing)}" fill="rgba(158,194,98,.15)" stroke="var(--accent)" stroke-width="1" stroke-dasharray="4 2"/>` : '';
    /* 层序：地形画布（`#map-terrain`，**在 SVG 底下**，内核渲染的）+ 手绘开放线 → 标记
       → 正在画的那一笔。（原来的矢量岸线/湖岸/河已删：内核的 shader 自己会画。）*/
    svg.innerHTML = regions + lines + markers + drawingPath;
  }

  /* ── 地形画布：只在**参数真的变了**的时候重建。
     两种形态两条路：
       · **局部**（`local`）：内核的 WebGL 渲染器（`mountTerrain`）—— 正方形画布只露中间横带，
         生成约 30~70ms、支持手刷（`regenerate`）；
       · **星球**（`planet`）：等距圆柱图直接铺进 2D 画布（`mountPlanet`），或者贴到一颗真球上
         （`mountGlobeView`）—— 场算一次约 450ms，之后换「看的方式」只是重新上色（约 45ms）。
     ⚠️ 局部那条键里**含手刷笔迹**：刷完一笔就是另一片地（内核的约束场是模块级单例）。 */
  /** 状态行（统计 + 种子 + 看的方式）。手刷落盘后也要立刻调一次（用 liveStats） */
  function setTerrainNote(m: MapData, s: TerrainStats | null): void {
    const form = mapFormOf(m.terrain?.form);
    const style = terrainStyleOf(m.terrain?.view);
    genNote.textContent = s && m.terrain
      ? `${mapFormLabel(form)} · ${s.lands} 块陆地 · ${s.islands} 座岛 · ${s.rivers} 条河 · 最高峰约 ${s.peak} m`
        + `${s.deepest ? ` · 最深海沟约 ${s.deepest} m` : ''} · 陆地占 ${Math.round(s.landRatio * 100)}% · 种子「${m.terrain.seed}」 · ${terrainStyleLabel(style)} · 等高线${contourModeLabel(m.terrain.contour)}${form === 'planet' && globeOn ? ' · 球体' : ''}`
      : '还没有地形';
  }

  function syncTerrain(m: MapData) {
    terrainBox.style.width = m.width + 'px';
    terrainBox.style.height = m.height + 'px';
    const form = mapFormOf(m.terrain?.form);
    /* ⭐ 「看的方式」（第九十七轮）：只决定**怎么画**。控件跟着数据走（在别处改了这里也同步），
       没有地形时置灰 —— 还没生成出来的地，谈不上用哪种画法。 */
    const style = terrainStyleOf(m.terrain?.view);
    if (viewSel.value !== style) viewSel.value = style;
    viewSel.disabled = !m.terrain;
    /* ⭐ 等高线方式（第一百零八轮）：控件跟着数据走；没有地形时置灰 */
    const contour = contourModeOf(m.terrain?.contour);
    if (contourSel.value !== contour) contourSel.value = contour;
    contourSel.disabled = !m.terrain;
    /* ⭐ 「立体度」（第一百零四轮）：控件跟着数据走；星球形态是 CPU 画的平面图，没有立体度这回事 ⇒ 藏起来 */
    const lift = liftOf(m.terrain);
    if (liftSel.value !== lift) liftSel.value = lift;
    liftSel.disabled = !m.terrain;
    liftSel.style.display = m.terrain && form === 'planet' ? 'none' : '';
    globeBtn.style.display = m.terrain && form === 'planet' ? '' : 'none';
    globeBtn.style.background = globeOn ? 'rgba(158,194,98,.2)' : 'none';
    if (!m.terrain) {
      setTerrainNote(m, null);
      terrainKey = '';
      terrainStyleKey = '';
      rebuildSeq++;                 /* 作废在飞的生成 */
      busy?.done();
      busy = null;
      terrainHandle?.dispose();
      terrainHandle = null;
      terrainCanvas?.remove();
      terrainCanvas = null;
      return;
    }
    /* ⚠️ 状态行里那份统计**不能**在这里同步算：星球要 1.4s、局部要 130ms，
       一算就把"遮罩都还没画出来"的那一帧一起冻住（用户原话：「别人以为会卡了」）。
       统计等 rebuildTerrain 算完再补；命中底图缓存时那份统计也一起从缓存里拿。 */
    /* ⭐ 第一百三十三轮：`view` 进键了。以前局部形态靠 `setStyle()` 就地换风格（不重建），
       但**从底图缓存贴出来的是一张死图**，没有视图可以 setStyle ⇒ 换风格会毫无反应。
       现在一律走"换键 ⇒ 重建"，重建时要么命中那一档的缓存、要么现算（引擎缓存还在内存里）。 */
    const key = m.terrain
      ? `${form}|${m.terrain.seed}|${m.terrain.style}|${m.terrain.view ?? ''}|${lift}|${JSON.stringify(m.terrain.spec ?? {})}|${m.width}x${m.height}|${JSON.stringify(m.terrain.paint ?? [])}`
        + (form === 'planet' ? `|${globeOn ? 'globe' : 'equirect'}` : '')
        + `|${contour}|${JSON.stringify(m.terrain.mask ?? null)}`
      : '';
    if (key === terrainKey) {
      /* 地形与「看的方式」都没变 ⇒ 什么都不用做。风格已经进键（换风格就是换键），
         这里的 `setStyle` 只作兜底：万一哪条路只改了渲染参数没进键，至少当场重画。 */
      if (terrainStyleKey !== style) { terrainStyleKey = style; terrainHandle?.setStyle(style); }
      return;
    }
    terrainKey = key;
    terrainStyleKey = style;
    void rebuildTerrain(m, key, style, form);
  }

  /* ── 落盘底图缓存（第一百三十三轮）──────────────────────────────────────────
     用户 2026-10-31：「为什么每次进入灵框时都要重新渲染一次地图」。
     地形是参数的纯函数，图以前每次启动都现算（星球 ~1.9s、局部 ~130ms + 遮罩）。
     现在把渲染好的那一帧按参数签名存在 `userData/mapcache/`（见 `src/ui/map-cache.ts`）：
     签名没变就直接贴图，不建网格、不算场、不挂遮罩。图仍然不进 worldbuilding.json。 */

  /** 地形画布的几何（**缓存贴图与现算两条路共用** —— 两处各写一套 CSS 必漂移：
   *  局部 = 正方形位图裁中间横带（`bandLayout`）；星球 = 等距圆柱图按 2:1 铺、上下居中）。 */
  function placeTerrainCanvas(canvas: HTMLCanvasElement, form: string, w: number, h: number): void {
    canvas.style.position = 'absolute';
    canvas.style.pointerEvents = 'none';
    if (form === 'planet') {
      const drawH = Math.round(w / 2);
      canvas.style.left = '0px';
      canvas.style.top = Math.max(0, Math.round((h - drawH) / 2)) + 'px';
      canvas.style.width = w + 'px';
      canvas.style.height = drawH + 'px';
      canvas.style.cursor = 'zoom-in';
      return;
    }
    const L = bandLayout(w, h);
    canvas.style.left = L.left + 'px';
    canvas.style.top = L.top + 'px';
    canvas.style.width = L.size + 'px';
    canvas.style.height = L.size + 'px';
  }

  /** 命中缓存就贴图（不建网格、不算场、不挂遮罩）。返回 true = 画布已经就位。 */
  async function paintCachedTerrain(m: MapData, form: string): Promise<boolean> {
    if (!m.terrain || globeOn) return false;   /* 球体那一帧是 WebGL 球面投影，缓存里没有 */
    const key = mapCacheKey(m.terrain, m.width, m.height);
    /* ⚠️ 必须先等索引读回来再看命中：`cachedStats()` 只读内存里的索引，
       顺序反了就会永远拿到 null ⇒ 每次启动照旧现算（本套件第一版就是这么假红的）。 */
    await ensureMapCache();
    const stats = cachedStats(key);
    if (!stats) return false;                  /* 没有统计 ⇒ 状态行会空着，宁可重算 */
    const url = await readCachedTerrainImage(key);
    if (!url) return false;
    const img = new Image();
    const ok = await new Promise<boolean>((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
    });
    if (!ok) return false;
    const canvas = document.createElement('canvas');
    canvas.id = 'map-terrain-canvas';
    canvas.setAttribute('data-terrain', '1');
    if (form === 'planet') canvas.setAttribute('data-planet', 'equirect');
    canvas.width = img.naturalWidth || canvas.width;
    canvas.height = img.naturalHeight || canvas.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0);
    placeTerrainCanvas(canvas, form, m.width, m.height);
    terrainCanvas?.remove();
    terrainCanvas = canvas;
    terrainBox.appendChild(canvas);
    setTerrainNote(m, stats);
    return true;
  }

  /** 星球：手上有刚上完色的 `rgba`（整张等距圆柱图）⇒ 直接编一张 WebP，不用再开视图。 */
  function cachePlanetFrame(key: string, f: { w: number; h: number; stats: TerrainStats }, rgba: Uint8ClampedArray): void {
    try {
      const c = document.createElement('canvas');
      c.width = f.w;
      c.height = f.h;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), f.w, f.h), 0, 0);
      const url = c.toDataURL('image/webp', 0.9);
      if (url.startsWith('data:image/')) putCachedTerrain(key, url, f.stats);
    } catch { /* 编码失败就不缓存（下次照样能算） */ }
  }

  /** 真正的重建（第一百零六轮：改成**异步 + 遮罩 + 进度**）。
     两条路都先铺遮罩、让出两帧，再动内核：
       · 局部：建网格 + 生成约 130ms（走 `terrainStats`/`mountTerrain` 的引擎缓存）；
       · 星球：场 1.4s + 上色 0.5s —— 生成器分帧（`planetFieldAsync` / `planetRgbaAsync`），
         每片 12ms，进度条跟着走。
     `key` / `seq` 一起用：切得快时后到的旧任务必须自己丢掉（否则会把新图盖成旧图）。 */
  async function rebuildTerrain(m: MapData, key: string, style: string, form: string): Promise<void> {
    const seq = ++rebuildSeq;
    const stale = () => seq !== rebuildSeq || terrainKey !== key;
    terrainHandle?.dispose();
    terrainHandle = null;
    /* ⚠️ 重建前**换一块新画布**：`TerrainView.dispose()` 会 `loseContext()` 把那块画布永久作废，
       在它上面再 `getContext('webgl2')` 只会拿到一个已丢失的上下文、静默画出空白
       （第九十三轮缩略图踩过同一个坑；球体那条同理）。 */
    terrainCanvas?.remove();
    terrainCanvas = null;
    if (!m.terrain) return;
    /* ⭐ 落盘底图（第一百三十三轮）：参数没变就**直接贴上次那一帧** —— 启动瞬开、不算场、不挂遮罩，
       连 WebGL 都不需要。没命中才往下走现算那条路。 */
    if (await paintCachedTerrain(m, form)) return;
    if (stale()) return;
    genNote.textContent = form === 'planet'
      ? (globeOn ? '正在生成星球（球体）…' : '正在算星球…')
      : '正在生成地形…';
    const canvas = document.createElement('canvas');
    canvas.id = 'map-terrain-canvas';
    canvas.setAttribute('data-terrain', '1');
    if (form === 'planet') canvas.setAttribute('data-planet', globeOn ? 'globe' : 'equirect');
    terrainBox.appendChild(canvas);
    terrainCanvas = canvas;
    const busyHost = (stage.parentElement ?? host) as HTMLElement;
    const b = showBusy(busyHost, form === 'planet' ? (globeOn ? '正在生成星球（球体）…' : '正在算星球…') : '正在生成地形…', {
      sub: form === 'planet' ? '第一次要几秒；之后换「看的方式」只重上色' : '建网格 · 算河流 · 定海岸',
    });
    busy = b;
    await nextFrame();
    try {
      if (form === 'planet') {
        const f = await planetFieldAsync(m.terrain, PLANET_VIEW_H, (p) => b.set('正在算星球…', p.pct, p.phase));
        if (stale()) return;
        const rgba = await planetRgbaAsync(m.terrain, PLANET_VIEW_H, style, (p) => b.set('正在上色…', p.pct, p.phase));
        if (stale()) return;
        const g = globeOn ? mountGlobePrepared(canvas, m.terrain, m.width, m.height, style, f, rgba) : null;
        if (g) terrainHandle = g;
        else {
          if (globeOn) globeOn = false;   /* 没 WebGL ⇒ 退回平面图（按钮下次会跟着复位） */
          terrainHandle = mountPlanetPrepared(canvas, m.terrain, m.width, m.height, style, f, rgba);
        }
        setTerrainNote(m, f.stats);
        /* ⭐ 落盘底图：等遮罩收掉再编码（`toDataURL` 是同步的，几十 ms 不该挡"已算好"那一下）。
           键在**此刻**算好 —— 260ms 后数据可能已被撤销/换档，键必须对应屏幕上这一帧。 */
        const planetKey = mapCacheKey(m.terrain, m.width, m.height);
        const field = f, pixels = rgba;
        window.setTimeout(() => { if (!globeOn) cachePlanetFrame(planetKey, field, pixels); }, 260);
      } else {
        const s = terrainStats(m.terrain, m.width, m.height);
        if (stale()) return;
        terrainHandle = mountTerrain(canvas, m.terrain, m.width, m.height);
        setTerrainNote(m, s);
        /* ⭐ 落盘底图：`snapshotUrl()` 要等内核那一帧（readPixels），所以晚 260ms 再抓 ——
           不挡遮罩收，也不影响用户马上开始画区域。 */
        if (s) {
          const cacheKey = mapCacheKey(m.terrain, m.width, m.height);
          const handle0 = terrainHandle as TerrainHandle;
          window.setTimeout(() => {
            void (async () => {
              try {
                const url = await handle0.snapshotUrl('webp');
                if (url) putCachedTerrain(cacheKey, url, s);
              } catch { /* 视图已被换掉 / 抓帧超时：这次不缓存，下次渲染再说 */ }
            })();
          }, 260);
        }
      }
    } catch (e) {
      console.warn('[map] 地形生成失败：', e);
      genNote.textContent = form === 'planet' ? '星球生成失败（详见面板与控制台）' : '这台机器开不了 WebGL2，地形画不出来（手绘区域照常能用）';
      canvas.remove();
      if (terrainCanvas === canvas) terrainCanvas = null;
      terrainKey = '';
    } finally {
      b.done();
      if (busy === b) busy = null;
    }
  }

  /** 老「局部」地形留下的手刷笔迹：数据里删掉 + 内核的约束场也回到干净状态
   *  （`setElevationParam` 只在种子/岛屿度变了时才重新生成 ⇒ 不重置的话同种子重建时场里还留着旧笔迹）。
   *  工作室的「清空旧笔迹」按钮走 `lingkuang-map-clear-paint` 事件到这里。 */
  function clearLegacyPaint(): void {
    resetTerrainPaint();
    save((m) => { if (m.terrain) m.terrain.paint = []; });
    renderSvg();
  }

  let panning = false, panX = 0, panY = 0, panSX = 0, panSY = 0;

  /** 点一下地形 → 全窗口看大图（第一百零六轮）。局部形态给**整张** 1536² 位图
   *  （地图格子里只是中间那条横带），星球给整张 1536×768 等距圆柱图。 */
  async function openBigView(): Promise<void> {
    const m = curMap();
    if (!m?.terrain) return;
    const form = mapFormOf(m.terrain.form);
    /* ⭐ 第一百零八轮：大图统一走**高清**（局部 3072² / 星球 2304×1152）。
       ⭐ 第一百零九轮（用户：「高清大图怎么每次都要重新算，不能保存吗」）：
       命中缓存就**直接开**（不挂遮罩、不重算）；没命中才算 —— 算完的图留在 LRU 里，
       同一张地形再点开是瞬时的。查看器右上角还有「保存」把 PNG 存到本地。*/
    const cached = hdCached(m.terrain, m.width, m.height);
    if (cached) { openLightbox({ ...cached, download: m.name + '-高清.png', actions: [{ label: '编辑', title: '关掉大图，进全屏画板动手改', onClick: () => setEditing(true) }] }); return; }
    const b = showBusy((stage.parentElement ?? host) as HTMLElement, '正在出高清大图…', {
      sub: form === 'planet' ? '星球 2304×1152 · 第一次几秒（之后用缓存）' : '地形 3072² · 一次性视图',
    });
    await nextFrame();
    try {
      const shot = await hdImageFor(m.terrain, m.width, m.height, (p) => b.set('正在出高清大图…', p.pct, p.phase));
      b.done();
      if (shot.src) openLightbox({ src: shot.src, title: m.name + ' · ' + shot.title, download: m.name + '-高清.png', actions: [{ label: '编辑', title: '关掉大图，进全屏画板动手改', onClick: () => setEditing(true) }] });
    } catch (e) {
      b.done();
      console.warn('[map] 出大图失败：', e);
      genNote.textContent = '高清图出不来（详见面板与控制台）';
    }
  }

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
    /* ⭐ 第一百零三轮：允许**放大**到 2×（原来钳在 1 ⇒ 地图永远只有 900×500，四周一圈空）。
       地形位图本身是 1536²（≈ 屏幕 1.66× 时 1:1），放大到 2× 会略微上采样 —— 但比 2048 位图
        被降采样更锐（第一百零五轮）。 */
    viewScale = Math.min(bw / m.width, bh / m.height, 2);
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
    /* 太细的一笔（面积/外接矩形 < 7%）不落盘：多半是「想拖地图/随手一划」被当成画区域，
       存下来只会在地图上留一条斜线（第一百一十轮）。 */
    if (commit && mode === 'region' && drawing.length >= 3 && !regionIsSliver(drawing)) {
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
    /* 展示态不接指针（`pointerEvents='none'` 时这条也不会来，双保险） */
    if (!editing) return;
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
    if (!editing) {
      if (tapDown && Math.abs(e.clientX - tapX) + Math.abs(e.clientY - tapY) > 4) tapMoved = true;
      return;
    }
    /* 丢失 pointerup 的兜底：没按键却收到 move，说明收尾信号丢了
       （在窗口外松开 / pointercancel 没派发），就地收尾——否则会一直画下去或一直平移。 */
    if (e.buttons === 0) {
      if (panning || drawing.length) { endDrag(false); }
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
  const onUp = (e: PointerEvent) => {
    /* 展示态：按下-松手之间没拖 ⇒ 点一下看大图（编辑态那条路不在这里） */
    if (!editing) {
      if (!tapDown) return;
      tapDown = false;
      if (!tapMoved && e.button === 0) void openBigView();
      return;
    }
    endDrag(true);
  };
  const onCancel = () => { tapDown = false; endDrag(false); };
  /* 第一百二十二轮：地图**可以收起了**（上下分割条 / 标题栏按钮）。收起时这一格高度 ≈ 0，
     `fitView()` 会把缩放算成 0 或负数，展开后要么一片空白、要么比例全错 ——
     所以高度不够就**不要量**，等展开后的那次 ResizeObserver 再算。 */
  const onResize = () => { if ((stage.parentElement?.clientHeight ?? 0) >= 60) fitView(); };
  /* 工作室的「清空旧笔迹」：只清老局部地形留下的手刷笔迹（第一百零九轮画笔条已退场）。*/
  const onClearEvt = () => clearLegacyPaint();
  /* ⭐ 只监听 window.resize 是不够的：地图栏**自己**也会变高变矮 —— 上面那行状态文字一变长
     （生成地形后正是如此）就换行、工具栏变高、下面的格子变矮，而缩放还按老高度算 ⇒
     图被切掉一截（第九十三轮实测：格子 289→261，缩放仍按 289）。ResizeObserver 一并盯住。 */
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => onResize()) : null;
  if (ro && stage.parentElement) ro.observe(stage.parentElement);
  mapCleanup?.();
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('resize', onResize);
  window.addEventListener('lingkuang-map-clear-paint', onClearEvt);
  mapCleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('lingkuang-map-clear-paint', onClearEvt);
    ro?.disconnect();
    rebuildSeq++;
    busy?.done();
    busy = null;
    terrainHandle?.dispose();   /* ⭐ 地形画布后面挂着 WebGL 上下文（4 张 1536² FBO）—— 必须销毁 */
    terrainHandle = null;
    terrainKey = '';
    terrainStyleKey = '';
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
