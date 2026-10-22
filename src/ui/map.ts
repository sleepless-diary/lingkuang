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
import type { MapData, MapPaintStroke } from '../store/types';
import { escapeHtml } from './html';
import { DEFAULT_MAP, polylinePath, smoothClosedPath } from './map-gen';
import {
  mountTerrain, mapPointToWorld, resetTerrainPaint, terrainStats, liftOf, type TerrainHandle,
} from './map-terrain';
import { PLANET_VIEW_H, mountGlobeView, mountPlanet, planetStats } from './planet-view';
import { DEFAULT_PAINT_SIZE, DEFAULT_PAINT_TOOL, TERRAIN_STYLES, beginPaintStroke, paintStep, terrainStyleLabel, terrainStyleOf } from '../mapgen';
import { MAP_FORMS, mapFormLabel, mapFormOf } from '../mapgen/planet';
import { openMapStudioFromToolbar } from './map-studio';

type Mode = 'region' | 'marker' | 'move' | 'paint';
/** 两套内核的句柄**同形**（dispose / setStyle / regenerate）—— 地图栏不关心底下是哪一个 */
type TerrainLayer = TerrainHandle | ReturnType<typeof mountPlanet>;

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
        <button id="map-gen" title="打开地图生成面板：自己一个个调参数 / AI 直出 / 抽卡" style="background:none;border:1px solid var(--accent);color:var(--accent-ink);border-radius:var(--radius-sm);font-size:11px;padding:3px 10px;cursor:pointer;">生成地形…</button>
        <select id="map-form" title="形态：局部 = 一片地区的地形（能手刷精修）；星球 = 整颗星球（经度无缝、有两极，能贴到球上看）" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:2px 6px;cursor:pointer;">${MAP_FORMS.map((f) => `<option value="${f.id}" title="${escapeHtml(f.hint)}">${escapeHtml(f.label)}</option>`).join('')}</select>
        <button id="map-globe" class="lk-btn lk-btn--ghost lk-btn--sm" title="球体看：把星球图贴到一颗真球上（拖动旋转、滚轮缩放）—— 只在星球形态下出现" style="display:none;background:none;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:3px 10px;cursor:pointer;">球体看</button>
        <select id="map-view" title="看的方式：地形怎么画（八档：自然 / 地形图 / 羊皮纸 / 水墨 / 蓝图 / 梦核 / 卫星 / 极简）—— 只换画法，不重算地形" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:2px 6px;cursor:pointer;">${TERRAIN_STYLES.map((s) => `<option value="${s.id}" title="${escapeHtml(s.hint)}">${escapeHtml(s.label)}</option>`).join('')}</select>
        <select id="map-lift" title="立体度：立体 = 山有厚度（能看到山坡侧面）；顶视 = 从正上方看（没有侧壁，只有色带与明暗）—— 只换看法，不重算地形" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:2px 6px;cursor:pointer;"><option value="solid" title="山有厚度：能看见山坡侧面与投影（默认）">立体</option><option value="flat" title="正上方俯视：山只靠色带与明暗表达高度，没有侧壁">顶视</option></select>
        <button data-mode="region" class="map-mode lk-btn lk-btn--ghost lk-btn--sm" >区域</button>
        <span style="width:1px;height:16px;background:var(--border-soft);"></span>
        <button data-mode="marker" class="map-mode lk-btn lk-btn--ghost lk-btn--sm" >标记</button>
        <button data-mode="paint" class="map-mode lk-btn lk-btn--ghost lk-btn--sm" title="手刷地形：造山 / 压谷 / 浅海 / 深海（在地形上直接刷）" >地形</button>
        <button data-mode="move" class="map-mode lk-btn lk-btn--ghost lk-btn--sm" >移动</button>
        <button id="map-clear" class="lk-btn lk-btn--danger lk-btn--sm" >清空标记</button>
        <span id="map-hint" style="font-size:var(--text-xs);color:var(--fg-2);">拖拽画区域（松开闭合）</span>
        <span id="map-paint-bar" style="display:none;align-items:center;gap:4px;flex-wrap:wrap;row-gap:4px;width:100%;padding-top:4px;border-top:1px dashed var(--border-soft);">
          <span style="font-size:var(--text-xs);color:var(--fg-2);">刷子</span>
          <button class="map-brush lk-btn lk-btn--ghost lk-btn--sm" data-tool="mountain" >造山</button>
          <button class="map-brush lk-btn lk-btn--ghost lk-btn--sm" data-tool="valley" >压谷</button>
          <button class="map-brush lk-btn lk-btn--ghost lk-btn--sm" data-tool="shallow" >浅海</button>
          <button class="map-brush lk-btn lk-btn--ghost lk-btn--sm" data-tool="ocean" >深海</button>
          <span style="width:1px;height:14px;background:var(--border-soft);"></span>
          <button class="map-brush-size lk-btn lk-btn--ghost lk-btn--sm" data-size="tiny" >极细</button>
          <button class="map-brush-size lk-btn lk-btn--ghost lk-btn--sm" data-size="small" >细</button>
          <button class="map-brush-size lk-btn lk-btn--ghost lk-btn--sm" data-size="medium" >中</button>
          <button class="map-brush-size lk-btn lk-btn--ghost lk-btn--sm" data-size="large" >粗</button>
          <span style="flex:1;"></span>
          <span id="map-paint-note" style="font-size:var(--text-xs);color:var(--fg-2);"></span>
          <button id="map-paint-undo" class="lk-btn lk-btn--ghost lk-btn--sm" >撤销最后一笔</button>
          <button id="map-paint-clear" class="lk-btn lk-btn--ghost lk-btn--sm" >清空笔迹</button>
        </span>
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
  let terrainHandle: TerrainLayer | null = null;
  let terrainKey = '';
  /* ⭐ 「看的方式」：上一次已经推给 GPU 的那一档（与 `terrainKey` 分开 —— 换风格不重建画布）*/
  let terrainStyleKey = '';
  /* ⭐ 「球体看」（第九十八轮）：星球形态下的第二个视图（平面图 ⇄ 真球），只对星球有效 */
  let globeOn = false;
  const hint = host.querySelector('#map-hint') as HTMLElement;
  let labelSeq = 1;

  /* ── 手刷地形（画笔）的状态：刷子 / 尺寸 / 正在刷的这一笔 ───────────────── */
  let brushTool = DEFAULT_PAINT_TOOL;
  let brushSize = DEFAULT_PAINT_SIZE;
  let liveStroke: MapPaintStroke | null = null;
  let lastPaint: { x: number; y: number } | null = null;
  /** 世界坐标里两点比这还近就不记（≈半个约束格）：既省事，也让"重放"的点序列稳定 */
  const PAINT_MIN_STEP = 0.004;
  const paintBar = host.querySelector('#map-paint-bar') as HTMLElement;
  const paintNote = host.querySelector('#map-paint-note') as HTMLElement;

  function paintState(msg?: string) {
    const m = curMap();
    const n = m?.terrain?.paint?.length ?? 0;
    paintNote.textContent = msg ?? (m?.terrain
      ? (n ? `已刷 ${n} 笔` : '按住拖动就能刷 —— 每一笔单独一步撤销')
      : '这片地还没有地形：先点「生成地形…」');
  }

  function brushUi() {
    const mark = (el: HTMLElement, on: boolean) => {
      el.style.background = on ? 'rgba(158,194,98,.2)' : 'none';
      el.style.borderColor = on ? 'var(--accent)' : 'var(--border)';
    };
    host.querySelectorAll('.map-brush').forEach((b) => mark(b as HTMLElement, (b as HTMLElement).dataset.tool === brushTool));
    host.querySelectorAll('.map-brush-size').forEach((b) => mark(b as HTMLElement, (b as HTMLElement).dataset.size === brushSize));
  }

  function setMode(m: Mode) {
    mode = m;
    drawing = [];
    liveStroke = null;
    lastPaint = null;
    host.querySelectorAll('.map-mode').forEach((b) => (b as HTMLElement).style.background = 'none');
    const btn = host.querySelector(`.map-mode[data-mode="${m}"]`) as HTMLElement;
    if (btn) btn.style.background = 'rgba(158,194,98,.2)';
    paintBar.style.display = m === 'paint' ? 'flex' : 'none';
    /* 提示行两段：短名 + 悬停说明（照旧是中栏那行的写法，不加图标） */
    const tips: Record<Mode, [string, string]> = {
      region: ['区域', '拖拽画区域（松开闭合）'],
      marker: ['标记', '点击放置标记'],
      move: ['平移', '拖拽平移'],
      paint: ['地形', '按住拖动 = 刷地形（造山 / 压谷 / 浅海 / 深海）；每一笔单独一步撤销'],
    };
    hint.textContent = tips[m][0];
    hint.title = tips[m][1];
    if (m === 'paint') { brushUi(); paintState(); }
  }
  host.querySelectorAll('.map-mode').forEach((b) =>
    (b as HTMLElement).addEventListener('click', () => setMode((b as HTMLElement).dataset.mode as Mode))
  );
  host.querySelectorAll('.map-brush').forEach((b) =>
    (b as HTMLElement).addEventListener('click', () => {
      brushTool = (b as HTMLElement).dataset.tool ?? DEFAULT_PAINT_TOOL;
      brushUi();
    })
  );
  host.querySelectorAll('.map-brush-size').forEach((b) =>
    (b as HTMLElement).addEventListener('click', () => {
      brushSize = (b as HTMLElement).dataset.size ?? DEFAULT_PAINT_SIZE;
      brushUi();
    })
  );
  host.querySelector('#map-paint-undo')?.addEventListener('click', () => {
    /* ⚠️ 光把笔划从数据里去掉是不够的：内核那个约束场里**那一笔还在**（重放会被"场里已有笔迹"
       挡掉）⇒ 必须先让场回到干净状态，再让重建把剩下的笔划重放一遍。 */
    resetTerrainPaint();
    save((m) => { m.terrain?.paint?.pop(); });
    terrainKey = '';
    renderSvg();
    paintState('已撤销最后一笔');
  });
  host.querySelector('#map-paint-clear')?.addEventListener('click', () => clearPaint());
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
  const formSel = host.querySelector('#map-form') as HTMLSelectElement;
  const liftSel = host.querySelector('#map-lift') as HTMLSelectElement;
  const globeBtn = host.querySelector('#map-globe') as HTMLButtonElement;
  host.querySelector('#map-gen')?.addEventListener('click', () => { openMapStudioFromToolbar(store); });
  /* ⭐ 「看的方式」（第九十七轮）：改了**只重画**（`syncTerrain` 里换渲染参数），不重算地形。
     落盘照走 `save()`（一步撤销）—— 与面板「采用到地图」同一条路，不留第二份状态。 */
  viewSel.addEventListener('change', () => {
    const v = viewSel.value;
    if (!curMap()?.terrain) return;
    save((mm) => { if (mm.terrain) mm.terrain.view = v; });
  });
  /* ⭐ 「形态」（第九十八轮）：局部 ⇄ 星球。两套内核**共用**同一份种子/档位/数量/看的方式
     ⇒ 切过去只是换了一套渲染，参数还在；落盘照走 `save()`（一步撤销）。 */
  formSel.addEventListener('change', () => {
    const v = formSel.value;
    if (!curMap()?.terrain) return;
    save((mm) => { if (mm.terrain) mm.terrain.form = v; });
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
    syncTerrain(m);
    /* 球体上看不了手绘：区域/标记是**地图平面坐标**，要投到球面上得另做一遍投影（本轮不做）
       ⇒ 藏起来 + 关掉指针，免得笔画在旋转的球上对不上位置。切回平面就恢复。 */
    const onGlobe = mapFormOf(m.terrain?.form) === 'planet' && globeOn;
    svg.style.opacity = onGlobe ? '0' : '1';
    svg.style.pointerEvents = onGlobe ? 'none' : '';
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
  function syncTerrain(m: MapData) {
    terrainBox.style.width = m.width + 'px';
    terrainBox.style.height = m.height + 'px';
    const form = mapFormOf(m.terrain?.form);
    const s = form === 'planet'
      ? planetStats(m.terrain, PLANET_VIEW_H)
      : terrainStats(m.terrain, m.width, m.height);
    /* ⭐ 「看的方式」（第九十七轮）：只决定**怎么画**。控件跟着数据走（在别处改了这里也同步），
       没有地形时置灰 —— 还没生成出来的地，谈不上用哪种画法。 */
    const style = terrainStyleOf(m.terrain?.view);
    if (viewSel.value !== style) viewSel.value = style;
    viewSel.disabled = !m.terrain;
    /* ⭐ 「形态」（第九十八轮）：控件跟着数据走；星球形态才显示「球体看」，画笔在星球下不适用 */
    if (formSel.value !== form) formSel.value = form;
    formSel.disabled = !m.terrain;
    /* ⭐ 「立体度」（第一百零四轮）：控件跟着数据走；星球形态是 CPU 画的平面图，没有立体度这回事 ⇒ 藏起来 */
    const lift = liftOf(m.terrain);
    if (liftSel.value !== lift) liftSel.value = lift;
    liftSel.disabled = !m.terrain;
    liftSel.style.display = m.terrain && form === 'planet' ? 'none' : '';
    globeBtn.style.display = m.terrain && form === 'planet' ? '' : 'none';
    globeBtn.style.background = globeOn ? 'rgba(158,194,98,.2)' : 'none';
    if (m.terrain && form === 'planet' && mode === 'paint') setMode('move');
    genNote.textContent = s && m.terrain
      ? `${mapFormLabel(form)} · ${s.lands} 块陆地 · ${s.islands} 座岛 · ${s.rivers} 条河 · 最高峰约 ${s.peak} m · 陆地占 ${Math.round(s.landRatio * 100)}% · 种子「${m.terrain.seed}」 · ${terrainStyleLabel(style)}${form === 'planet' && globeOn ? ' · 球体' : ''}`
      : '还没有地形';
    const key = m.terrain
      ? `${form}|${m.terrain.seed}|${m.terrain.style}|${lift}|${JSON.stringify(m.terrain.spec ?? {})}|${m.width}x${m.height}|${JSON.stringify(m.terrain.paint ?? [])}`
        + (form === 'planet' ? `|${globeOn ? 'globe' : 'equirect'}|${style}` : '')
      : '';
    if (key === terrainKey) {
      /* 地形没变，但「看的方式」可能变了（面板采用 / 助手改了数据）⇒ **只换渲染参数、不重建画布** */
      if (terrainStyleKey !== style) { terrainStyleKey = style; terrainHandle?.setStyle(style); }
      return;
    }
    terrainKey = key;
    terrainStyleKey = style;
    terrainHandle?.dispose();
    terrainHandle = null;
    /* ⚠️ 重建前**换一块新画布**：`TerrainView.dispose()` 会 `loseContext()` 把那块画布永久作废，
       在它上面再 `getContext('webgl2')` 只会拿到一个已丢失的上下文、静默画出空白
       （第九十三轮缩略图踩过同一个坑；球体那条同理）。 */
    terrainCanvas?.remove();
    terrainCanvas = null;
    if (!m.terrain) { paintState(); return; }
    terrainCanvas = document.createElement('canvas');
    terrainCanvas.id = 'map-terrain-canvas';
    terrainCanvas.setAttribute('data-terrain', '1');
    if (form === 'planet') terrainCanvas.setAttribute('data-planet', globeOn ? 'globe' : 'equirect');
    terrainBox.appendChild(terrainCanvas);
    try {
      if (form === 'planet') {
        const g = globeOn ? mountGlobeView(terrainCanvas, m.terrain, m.width, m.height, style) : null;
        if (g) terrainHandle = g;
        else {
          if (globeOn) globeOn = false;   /* 没 WebGL ⇒ 退回平面图（按钮下次会跟着复位） */
          terrainHandle = mountPlanet(terrainCanvas, m.terrain, m.width, m.height, style);
        }
      } else {
        terrainHandle = mountTerrain(terrainCanvas, m.terrain, m.width, m.height);
      }
    } catch {
      /* 拿不到 WebGL（老机器/禁用显卡）⇒ 地图栏退化成"只有手绘层"，不炸整个沙盘 */
      genNote.textContent = '这台机器开不了 WebGL2，地形画不出来（手绘区域照常能用）';
      terrainCanvas.remove();
      terrainCanvas = null;
      terrainKey = '';
    }
    paintState();
  }

  /* ── 手刷地形：一笔 = 一次 `save()`（一步撤销）。刷的过程中**不落盘**，只在画布上重算
     （`shape:false` 约 12ms ⇒ 跟手）。松手才写进数据，写完之后 store 通知会让 `syncTerrain`
     按"新键"重建一次 —— 那次走**完整生成**（含重定海平面），所以屏上看到的和关掉重开算出来的
     是同一张图。 */
  function paintFrom(e: PointerEvent): void {
    const m = curMap();
    if (!m?.terrain || !terrainHandle) return;
    const [mx, my] = local(e);
    const p = mapPointToWorld(mx, my, m.width, m.height);
    if (lastPaint) {
      const dx = p.x - lastPaint.x, dy = p.y - lastPaint.y;
      if (dx * dx + dy * dy < PAINT_MIN_STEP * PAINT_MIN_STEP) return;
    }
    lastPaint = p;
    paintStep(brushTool, brushSize, p.x, p.y);
    liveStroke?.points.push(p);
    terrainHandle.regenerate({ shape: false });
  }

  function startPaint(e: PointerEvent): void {
    const m = curMap();
    if (!m?.terrain || !terrainHandle) { paintState('这片地还没有地形：先点「生成地形…」'); return; }
    if (mapFormOf(m.terrain.form) === 'planet') { paintState('星球形态暂不支持手刷 —— 想刷局部地形就切回「局部」'); return; }
    beginPaintStroke();
    liveStroke = { tool: brushTool, size: brushSize, points: [] };
    lastPaint = null;
    paintFrom(e);
  }

  function endPaint(commit: boolean): void {
    const s = liveStroke;
    liveStroke = null;
    lastPaint = null;
    if (!s || !s.points.length) return;
    if (!commit) {
      /* 丢弃这一笔（外面松手/指针被抢走）：场里已经有了半笔，得把场重置回"只有已落盘笔划"的样子 */
      resetTerrainPaint();
      terrainKey = '';
      renderSvg();
      return;
    }
    save((m) => {
      if (!m.terrain) return;
      if (!m.terrain.paint) m.terrain.paint = [];
      m.terrain.paint.push(s);
    });
    paintState();
  }

  /** 清空笔迹：数据里删掉笔划 + **内核的约束场也回到干净状态**
     （`setElevationParam` 只在种子/岛屿度变了时才重新生成 ⇒ 不重置的话同种子重建时场里还留着旧笔迹）。 */
  function clearPaint(): void {
    resetTerrainPaint();
    save((m) => { if (m.terrain) m.terrain.paint = []; });
    renderSvg();
    paintState('笔迹已清空');
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
    /* ⭐ 第一百零三轮：允许**放大**到 2×（原来钳在 1 ⇒ 地图永远只有 900×500，四周一圈空）。
       地形位图本身是 2048²，放大到 2× 仍有余量，不会糊。 */
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
    } else if (mode === 'paint') {
      startPaint(e);
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
      if (panning || drawing.length || liveStroke) { endDrag(false); endPaint(false); }
      return;
    }
    if (mode === 'region' && drawing.length) {
      drawing.push(local(e));
      renderSvg();
    } else if (mode === 'paint' && liveStroke) {
      paintFrom(e);
    } else if (panning) {
      stage.style.left = panX + (e.clientX - panSX) + 'px';
      stage.style.top = panY + (e.clientY - panSY) + 'px';
    }
  };
  const onUp = () => { endDrag(true); endPaint(true); };
  const onCancel = () => { endDrag(false); endPaint(false); };
  const onResize = () => fitView();
  /* ⭐ 生成工作室（`src/ui/map-studio.ts`）与助手都靠这两个事件把地图栏切到"地形"模式 ——
     面板负责说"要刷"，地图栏负责刷（画布与指针都在这儿）。 */
  const onBrushEvt = (e: Event) => {
    const d = (e as CustomEvent).detail as { on?: boolean; tool?: string; size?: string } | undefined;
    if (d?.tool) brushTool = d.tool;
    if (d?.size) brushSize = d.size;
    /* 星球形态没有手刷（笔刷那条路只通 mapgen4 的局部地形）⇒ 别把界面切进画笔档 */
    if (d?.on !== false && mapFormOf(curMap()?.terrain?.form) === 'planet') return;
    setMode(d?.on === false ? 'move' : 'paint');
  };
  const onClearEvt = () => clearPaint();
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
  window.addEventListener('lingkuang-map-brush', onBrushEvt);
  window.addEventListener('lingkuang-map-clear-paint', onClearEvt);
  mapCleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('lingkuang-map-brush', onBrushEvt);
    window.removeEventListener('lingkuang-map-clear-paint', onClearEvt);
    ro?.disconnect();
    terrainHandle?.dispose();   /* ⭐ 地形画布后面挂着 WebGL 上下文（4 张 2048² FBO）—— 必须销毁 */
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
