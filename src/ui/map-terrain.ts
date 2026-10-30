/** 地形层：把 `src/mapgen`（vendored mapgen4）接到界面上。
 *
 *  三件事，都是"把内核包成界面好用的形状"：
 *    · **引擎缓存**：同一份参数（种子/档位/数量/尺寸）只建一次网格、只生成一次；
 *    · **画布挂载**：内核世界是**方的**（1000×1000 网格、内部 2048² 位图），灵框地图是
 *      900×500 ⇒ 不缩放拉伸（那会把山河拉扁），而是**取中间那条横带**显示（`bandLayout`）。
 *      这一条是 2026-10-15 定下的：裁带 vs 拉扁，选了裁带 —— 上游的着色/光照假设世界是方的。
 *    · **缩略图**：生成面板的预览与抽卡要的是 dataURL（`terrainThumbUrl`），
 *      走内核自带的 screenshot 通道（WebGL 缓冲区不保留，只能在同一帧里 `readPixels`）。
 *
 *  ⚠️ 图**不进数据文件**：`MapData.terrain` 里只存参数（种子/档位/数量，几百字节），
 *  渲染时现算（确定性：同一份参数永远同一片地）。⭐ 第一百三十三轮起，渲染好的那一帧会
 *  另存进 `userData/mapcache/`（`src/ui/map-cache.ts`）—— 那是**派生缓存**，不是数据。 */

import {
  BAND, TerrainView, contourModeOf, contourEveryOf, createEngineFor, resetPaint, runGeneration, statsOf, styleRenderParams,
  type MapgenRenderParams, type MapgenSpecInput, type TerrainEngine, type TerrainStats,
} from '../mapgen';
import type { MapTerrainSpec } from '../store/types';

export type { TerrainStats };

/** 立体度：`flat` = 顶视（垂直夸张归零 ⇒ 看不到山坡侧壁），其余 = 立体。
 *  用户 2026-10-21：「山好像有顶部边缘，能不能做成开关」—— 这就是那个开关的取值。 */
export function liftOf(t: MapTerrainSpec | undefined): 'solid' | 'flat' {
  return t?.lift === 'flat' ? 'flat' : 'solid';
}

/** 「看的方式」+ 立体度 → 渲染参数（缺省 = 立体：不动 `mountain_height`，沿用内核默认的垂直夸张） */
export function terrainRenderParams(t: MapTerrainSpec): Partial<MapgenRenderParams> {
  const p = styleRenderParams(t.view);
  /* ⭐ 第一百零八轮：等高线抽稀（用户「陡峭的地方等高线有点密」）—— 0 = 自动、
     n = 每 n 条画一条。只是显示参数，与地形生成无关。 */
  const q: Partial<MapgenRenderParams> = { ...p, contour_every: contourEveryOf(t.contour) };
  return liftOf(t) === 'flat' ? { ...q, mountain_height: 0 } : q;
}

/** 等高线方式的中文名（状态行 / 面板提示用） */
export { contourModeOf };

/** 内核位图边长（`render.ts` 的 `fbo_texture_size`；改那里就得改这里）
 *  ⭐ 第一百零五轮：2048 → 1536。屏幕宽约 1500px ⇒ 2048 只是被降采样（磨软边缘 + 多付显存），
 *  1536 与屏幕 1:1；`bandLayout()` 是**按比例**算的，所以地图格子的 CSS 尺寸一分不变。 */
export const TERRAIN_BITMAP = 1536;
/** ⭐ 第一百零八轮：**全窗口大图**的位图边长（3072²）。
 *  用户原话：「进入全窗口预览时能不能渲染一下更高的分辨率」。点开大图才现挂一个
 *  3072 的视图（4 张 FBO 峰值约 190MB），截完立刻 dispose —— 常驻的还是 1536。 */
export const TERRAIN_HD_BITMAP = 3072;
/** 缩略图 / 抽卡 / 面板预览的位图边长（第一百零六轮 C3）。
 *  这些图最终只显示 264~720px 宽，1536² 是纯浪费（4 张 FBO 的填充率 ×4）；
 *  768² 对 720px 的预览仍是 1:1 以上，纹理比屏幕大一倍多。 */
export const THUMB_BITMAP = 768;
/** 默认渲染参数下画布能看到的世界范围（`zoom = 100/480`、`x = y = 500`）*/
const WORLD_VIEW = 960;

/* ── 引擎缓存 ─────────────────────────────────────────────────────────────── */

interface Cached { engine: TerrainEngine; stats: TerrainStats }
const engines = new Map<string, Cached>();
const MAX_ENGINES = 8;

const keyOf = (t: MapTerrainSpec, w: number, h: number) =>
  `${t.seed}|${t.style}|${JSON.stringify(t.spec ?? {})}|${w}x${h}|${JSON.stringify(t.paint ?? [])}`;

/** 参数 → 引擎（含统计）。建一次网格约 30~70ms、生成约 30~60ms ⇒ 必须缓存。
 *  ⚠️ 缓存键**含手刷笔迹**：笔迹不同就是另一片地（内核的约束场是模块级单例，见 `src/mapgen`）。 */
export function terrainEngine(t: MapTerrainSpec, w: number, h: number): Cached {
  const key = keyOf(t, w, h);
  const hit = engines.get(key);
  if (hit) return hit;
  const engine = createEngineFor(t.seed, t.style, (t.spec ?? {}) as MapgenSpecInput);
  runGeneration(engine, { strokes: t.paint });
  const out: Cached = { engine, stats: statsOf(engine) };
  engines.set(key, out);
  if (engines.size > MAX_ENGINES) {
    const first = engines.keys().next().value;
    if (first !== undefined && first !== key) engines.delete(first);
  }
  return out;
}

/** 只要统计数字（状态行 / 助手回执）时用它 */
export function terrainStats(t: MapTerrainSpec | undefined, w: number, h: number): TerrainStats | null {
  if (!t) return null;
  return terrainEngine(t, w, h).stats;
}

export function clearTerrainCache(): void {
  engines.clear();
}

/** 「清空笔迹」：笔划从数据里删掉之后，**内核那个约束场也得回到干净状态** ——
 *  否则同种子重建时场里还留着旧笔迹（`setElevationParam` 只在种子/岛屿度变了时才重新生成）。 */
export function resetTerrainPaint(): void {
  resetPaint();
  engines.clear();
}

/* ── 位图 ↔ 地图的映射：取中间横带 ────────────────────────────────────────── */

/** 把 `TERRAIN_BITMAP²` 位图里「横带」那一块搬到界面上：给的是画布 CSS 尺寸与负的 top 偏移。
 *  推导：画布能看到世界 960 单位（→ 位图边长像素）⇒ 横带 y∈[BAND.y0, BAND.y1] 对应
 *  位图 y ∈ [(y0-20)/960×边长, (y1-20)/960×边长]（1536 时 y0=234 ⇒ 342px，带高 851px）。
 *  要让它正好铺满 w×h 的格子 ⇒ 缩放 h/带高，画布整体按这个比例（**正方形、不拉伸**）。 */
export function bandLayout(w: number, h: number): { size: number; top: number; left: number } {
  const sy = (BAND.y0 - BAND.x0) / WORLD_VIEW * TERRAIN_BITMAP;
  const sh = (BAND.y1 - BAND.y0) / WORLD_VIEW * TERRAIN_BITMAP;
  const scale = h / sh;
  const size = TERRAIN_BITMAP * scale;
  /* 正方形画布铺进 w×h 的格子：宽高各差零点几像素（带的宽高比与格子的宽高比只近似相等），
     居中摆 —— 宁可两边各切掉半像素，也不能非均匀缩放（那会把山河拉扁）。 */
  return { size, top: -sy * scale, left: -(size - w) / 2 };
}

/** 位图上的源矩形（缩略图 `drawImage` 用）。`size` 必须与出图那块视图的位图边长一致
 *  （第一百零六轮：缩略图走 768²，地图栏走 1536²）。 */
export function bandSource(size: number = TERRAIN_BITMAP): { sx: number; sy: number; sw: number; sh: number } {
  return {
    sx: 0,
    sy: (BAND.y0 - BAND.x0) / WORLD_VIEW * size,
    sw: size,
    sh: (BAND.y1 - BAND.y0) / WORLD_VIEW * size,
  };
}

/* ── 挂到界面上（地图栏那块画布）────────────────────────────────────────────── */

/** 挂上去之后拿到的句柄：`dispose()` 卸载（换世界/关地图栏时必须调，否则 GL 上下文泄漏）；
 *  `regenerate()` 用同一块画布重跑生成（**手刷地形**那条路：每刷一个点就重算一次，
 *  约 12ms，走 `shape:false` 不重定海平面 ⇒ 画面上只在刷的地方变）。 */
export interface TerrainHandle {
  dispose: () => void;
  regenerate: (opts?: { shape?: boolean }) => void;
  /** ⭐ 「看的方式」（第九十七轮）：只换渲染风格 —— 不重建网格、不重算地形，下一帧就变。 */
  setStyle: (v: string | undefined) => void;
  /** ⭐ 第一百零五轮：**实时的**统计（手刷直接改内核的场，缓存里那份 stats 会旧）。
   *  手刷落盘后状态行要立刻报新数字，不能等空闲那趟全量重建。 */
  liveStats: () => TerrainStats;
  /** ⭐ 第一百三十三轮：把**当前这一帧**抓成 dataURL（落盘底图缓存用，见 `src/ui/map-cache.ts`）。
   *  走内核自带的 screenshot 通道（WebGL 缓冲区不保留，只能在同一帧里 `readPixels`）；
   *  抓完**不销毁**视图 —— 地图栏还在用它。 */
  snapshotUrl: (format?: 'png' | 'webp') => Promise<string>;
}

/** 把一块画布变成"这个世界的地形"。 */
export function mountTerrain(canvas: HTMLCanvasElement, t: MapTerrainSpec, w: number, h: number): TerrainHandle {
  const { engine } = terrainEngine(t, w, h);
  const L = bandLayout(w, h);
  canvas.style.position = 'absolute';
  canvas.style.left = L.left + 'px';
  canvas.style.top = L.top + 'px';
  canvas.style.width = L.size + 'px';
  canvas.style.height = L.size + 'px';
  canvas.style.pointerEvents = 'none';
  const view = new TerrainView(canvas, engine);
  view.setStyle(terrainRenderParams(t));   /* 风格 + 立体度在构造后立刻定下来（缺省 = 立体）*/
  view.update();
  return {
    liveStats: () => statsOf(engine),
    dispose: () => view.dispose(),
    setStyle: (v) => view.setStyle(terrainRenderParams({ ...t, view: v })),
    snapshotUrl: async (format) => {
      /* ⚠️ `snapshot()` 会自己 `update()` 排一帧（要等渲染循环那一帧才读得到像素）；
         它**不改**任何数据，调用方可以放心在渲染完之后调（落盘底图缓存就是这么用的）。 */
      const shot = await view.snapshot();
      return format === 'webp'
        ? shot.toDataURL('image/webp', 0.9)
        : shot.toDataURL('image/png');
    },
    regenerate: (opts) => {
      /* ⚠️ 实时刷的时候场里**已经**有这一笔（`paintStep` 直接写进内核的约束场）⇒
         `replayPaint` 会因为"场里有笔迹"而跳过重放，不会双重叠加。 */
      runGeneration(engine, { shape: opts?.shape, strokes: t.paint });
      view.update();
    },
  };
}

/** 地图格子坐标（0..w / 0..h）→ 世界归一化坐标（0..1）。
 *  手刷地形要把指针位置换算成内核认识的世界坐标：横带 y∈[BAND.y0,BAND.y1] 铺满格子高，
 *  方形画布比格子宽一点点（`bandLayout` 居中摆）⇒ 先换算到方形画布的比例再落回世界。 */
export function mapPointToWorld(mx: number, my: number, w: number, h: number): { x: number; y: number } {
  const L = bandLayout(w, h);
  const px = (mx - L.left) / (L.size || 1);
  const py = (my - L.top) / (L.size || 1);
  const cl = (v: number) => Math.min(1, Math.max(0, v));
  return {
    x: cl((BAND.x0 + px * (BAND.x1 - BAND.x0)) / 1000),
    y: cl((BAND.y0 + py * (BAND.y1 - BAND.y0)) / 1000),
  };
}

/* ── 缩略图 / 预览（生成面板用）────────────────────────────────────────────── */

/* ⚠️ **一个视图配一块自己的画布**：`TerrainView.dispose()` 会 `loseContext()` 把画布的 WebGL
   上下文永久毁掉（这是对的 —— 一次抽卡要建 6~12 个视图），所以换参数时必须**连画布一起换**，
   否则下一张卡片会在一块死掉的画布上 `getContext('webgl2')`，静默出一张空图（第九十三轮实测）。 */
let thumb: { canvas: HTMLCanvasElement; view: TerrainView; key: string } | null = null;

function thumbViewFor(t: MapTerrainSpec, w: number, h: number): TerrainView {
  /* ⚠️ 键里**含风格**（第九十七轮实测）：复用同一个视图改渲染参数时，`snapshot()` 抓到的
     是上一档的画面（每次换风格都滞后一格 —— 参数明明已经送进 GL 了，见 BUGS 第九十七轮）。
     换风格 = 换一块画布 + 一个新渲染器 ⇒ 第一帧就是对的，与抽卡那张卡同一个道理。 */
  const key = keyOf(t, w, h) + '|' + (t.view ?? '');
  if (thumb && thumb.key === key) return thumb.view;
  thumb?.view.dispose();          /* 丢旧上下文（那块画布随之作废，不再复用） */
  const canvas = document.createElement('canvas');
  const { engine } = terrainEngine(t, w, h);
  const view = new TerrainView(canvas, engine, THUMB_BITMAP);
  thumb = { canvas, view, key };
  return view;
}

/** 出一张缩略图（异步：要等渲染循环那一帧）。失败返回空串（调用方跳过这张）。 */
export async function terrainThumbUrl(
  t: MapTerrainSpec, w: number, h: number, outW: number, outH: number, format: 'png' | 'jpeg' = 'png',
): Promise<string> {
  try {
    const view = thumbViewFor(t, w, h);
    /* ⭐ 风格是渲染参数（不在缓存键里）⇒ 每次出图前按这份 spec 重设一次：
       同一块地切「等高线」「平面」时，缩略图才跟着变（而不是永远第一档）。 */
    view.setStyle(terrainRenderParams(t));
    const shot = await view.snapshot();
    const out = document.createElement('canvas');
    out.width = Math.max(16, Math.round(outW));
    out.height = Math.max(16, Math.round(outH));
    const ctx = out.getContext('2d');
    if (!ctx) return '';
    const s = bandSource(THUMB_BITMAP);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(shot, s.sx, s.sy, s.sw, s.sh, 0, 0, out.width, out.height);
    /* ⭐ 区域样本落盘用 JPEG（第一百零八轮实测：264×147 的 PNG 因为地形噪声有 100KB+，
       JPEG 只要 10~20KB）—— 缩略图是"记住这一版长什么样"，不是像素级档案。 */
    return out.toDataURL(format === 'jpeg' ? 'image/jpeg' : 'image/png', format === 'jpeg' ? 0.82 : undefined);
  } catch (e) {
    console.warn('[map-terrain] 缩略图失败：', e);
    return '';
  }
}

/** 面板关掉时把离屏视图收掉（显存） */
export function releaseThumbs(): void {
  thumb?.view.dispose();
  thumb = null;
}

/** 全尺寸位图（大图查看器用）：内核的整张 1536² 截图，不裁横带。
 *  用户 2026-10-23：「点击大图时全窗口显示大图，方便看细节」——
 *  地图格子里看到的只是中间那条横带，整张图里还有上下两片地形。
 *  ⚠️ 这里**临时**开一个视图（不走 thumb 那块 768² 的）：大图要看细节，768² 放大到全屏会糊。
 *  `size` 缺省 1536（"点开就有"的即时图），传 `TERRAIN_HD_BITMAP`（3072）就是高清版。
 *  用完立刻 dispose（一次性，不常驻显存）。 */
export async function terrainFullUrl(
  t: MapTerrainSpec, w: number, h: number, size: number = TERRAIN_BITMAP,
): Promise<string> {
  const canvas = document.createElement('canvas');
  const { engine } = terrainEngine(t, w, h);
  const view = new TerrainView(canvas, engine, size);
  try {
    view.setStyle(terrainRenderParams(t));
    const shot = await view.snapshot();
    return shot.toDataURL('image/png');
  } finally {
    view.dispose();
  }
}
