/** 地图生成内核 —— **灵框自己的适配层**。
 *
 *  内核是 vendored 的 mapgen4（Apache-2.0，见 `src/mapgen/NOTICE.md`）：Delaunay/Voronoi 对偶网格 +
 *  噪声高度 + 迎风坡降雨/雨影 + 流量累加切河谷 + WebGL 斜投影渲染（山体阴影 / 生物群系配色 / 描边）。
 *  业务代码**只**用这个文件的四个入口：`createEngine` / `runGeneration` / `statsOf` / `TerrainView`，
 *  不要直接 import `./vendor/*`。
 *
 *  ── 为什么搬它（用户 2026-10-14：「好丑，有没有现成的轮子」→ 选定「整包搬 mapgen4」）
 *  mapgen4 作者写的目标就是「**跑得快到能边刷边重算** + **好看，而不是追求物理真实**」——
 *  正好对上灵框要的「看起来像的地图」。我们自己那版缺的三件事（山成峰、迎风坡降雨、流量累加切河谷）
 *  全在 `vendor/map.ts` 里。
 *
 *  ── 灵框的取舍（都写在这里，方便以后改）
 *  1. **世界仍是上游那个 1000×1000 方形网格**（`choosePoints` 的 bounds 写死），内部 FBO 固定 2048²。
 *     灵框的地图是 900×500（1.8:1）⇒ 我们不碰任何几何/光照数学，而是**取中间那条横带**显示
 *     （`BAND` 常量 + `screenToWorld` 一致的裁剪）。这样上游的着色各向同性、不会拉扁。
 *  2. **一个世界一张图**：`MapData.terrain` 只存参数（种子/档位/数量），图在渲染时现算（同种子同一片地）。
 *  3. **档位与描述 → 上游参数**的映射在 `STYLE_PRESETS` 与 `paramsFromSeed()`（灵框自己的规矩）。
 *     ⚠️ 换内核后有几项**不再可控**（见 `APPLY_NOTES`）：上游的陆块数/岛数不是旋钮（它由噪声决定），
 *     湖也不是「挖出来的」而是内陆海。`spec.landRatio` / `spec.ridges` / `spec.rivers` 仍可控。
 */

/* ⚠️ 上游没提供可用的 .d.ts（见 NOTICE.md 第 7 条）⇒ 边界这一层用 any 收口，
   灵框自己的类型（下面这些 interface）是准的。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Delaunator from 'delaunator';
import {TriangleMesh} from './vendor/dual-mesh/index';
import {choosePoints} from './vendor/generate-points';
import MapGen from './vendor/map';
import Geometry from './vendor/geometry';
import Painting from './vendor/painting';
import {
  beginStroke as vendorBeginStroke, paintAt as vendorPaintAt,
  resetPainting as vendorResetPainting, userHasPainted as vendorUserHasPainted,
} from './vendor/painting';
import Renderer from './vendor/render';

/* ── 参数（字段名与上游 `mapgen4.ts` 的 initialParams 一致；默认值也照抄）────────── */

export interface MapgenElevationParams {
  seed: number;
  island: number;
  noisy_coastlines: number;
  hill_height: number;
  mountain_jagged: number;
  mountain_sharpness: number;
  mountain_folds: number;
  ocean_depth: number;
}
export interface MapgenBiomesParams {
  wind_angle_deg: number;
  raininess: number;
  rain_shadow: number;
  evaporation: number;
}
export interface MapgenRiversParams {
  lg_min_flow: number;
  lg_river_width: number;
  flow: number;
}
export interface MapgenRenderParams {
  zoom: number;
  x: number;
  y: number;
  light_angle_deg: number;
  slope: number;
  flat: number;
  ambient: number;
  overhead: number;
  tilt_deg: number;
  rotate_deg: number;
  mountain_height: number;
  outline_depth: number;
  outline_strength: number;
  outline_threshold: number;
  outline_coast: number;
  outline_water: number;
  biome_colors: number;
  /* ⭐ 灵框追加（第九十七轮）：渲染风格 —— 与"生成什么地形"无关，只决定怎么看。
     缺省值必须等于上游原样（晕渲满格、无等高线、无分层设色）⇒ 旧数据/旧调用一个字节都不变。 */
  shade: number;          /* 0 = 完全平面，1 = 上游原样的山体阴影 */
  contour: number;        /* 0/1：等高线 */
  contour_scale: number;  /* 整个高度范围画几条等高线（10 ⇒ 每 0.1 高度一条） */
  bands: number;          /* >1 = 分层设色档数（0/1 = 关） */
}
export interface MapgenParams {
  spacing: number;
  mountainSpacing: number;
  mesh: { seed: number };
  elevation: MapgenElevationParams;
  biomes: MapgenBiomesParams;
  rivers: MapgenRiversParams;
  render: MapgenRenderParams;
}

/** 上游默认值（逐字抄自 `mapgen4.ts:25-66` 的 `initialParams` + `config.js`） */
export const DEFAULT_PARAMS: MapgenParams = {
  spacing: 5.5,
  mountainSpacing: 35,
  mesh: { seed: 12345 },
  elevation: {
    seed: 187, island: 0.5, noisy_coastlines: 0.01, hill_height: 0.02,
    mountain_jagged: 0, mountain_sharpness: 9.8, mountain_folds: 0.05, ocean_depth: 1.40,
  },
  biomes: { wind_angle_deg: 0, raininess: 0.9, rain_shadow: 0.5, evaporation: 0.5 },
  rivers: { lg_min_flow: 2.7, lg_river_width: -2.4, flow: 0.2 },
  render: {
    zoom: 100 / 480, x: 500, y: 500, light_angle_deg: 80, slope: 2, flat: 2.5, ambient: 0.25,
    overhead: 30, tilt_deg: 0, rotate_deg: 0, mountain_height: 50,
    outline_depth: 1, outline_strength: 15, outline_threshold: 0, outline_coast: 0,
    outline_water: 13.0, biome_colors: 1,
    /* ⭐ 灵框追加（第九十七轮）：这四个上游没有 ⇒ 缺省值即上游原样（见 `styleRenderParams()`）*/
    shade: 1, contour: 0, contour_scale: 10, bands: 0,
  },
};

/** 灵框的档位（用户能选的三种世界形态）→ 上游参数。理由：上游没有「档位」这个概念，
 *  它只有一堆滑杆；我们把"大陆/群岛/盘古"翻译成参数组合。 */
export const STYLE_PRESETS = {
  continent: { island: 0.5, noisy_coastlines: 0.012, ocean_depth: 1.4, mountainSpacing: 35 },
  archipelago: { island: 0.3, noisy_coastlines: 0.05, ocean_depth: 1.15, mountainSpacing: 26 },
  pangaea: { island: 0.72, noisy_coastlines: 0.02, ocean_depth: 1.55, mountainSpacing: 40 },
} as const;
export type MapgenStyle = keyof typeof STYLE_PRESETS;
export const MAPGEN_STYLES: MapgenStyle[] = ['continent', 'archipelago', 'pangaea'];

/** 换内核后**不再可控**的东西（面板/文档要如实说，别假装还在） */
export const APPLY_NOTES = [
  '陆块数 / 岛数不再是指定项 —— 上游的陆地形状由噪声与「岛屿度」决定，不是数出来的',
  '湖泊不再"挖"出来：内陆低地被淹就是内陆海（所以湖数可能为 0）',
];

/* ── ⭐ 灵框追加（第九十七轮）：渲染风格（「看的方式」）──────────────────────────
   用户 2026-10-14：「这个山怎么是立体的，不应该是等高线那一种的吗」→ 选了"做成开关"。
   关键事实：**风格只是渲染参数**（照度强度 / 等高线 / 分层设色），与"生成什么地形"无关
   ⇒ 换风格 = `TerrainView.setStyle()` = 下一帧重画，**不重建网格、不重算地形**（瞬时）。
   三档各自的一套参数在 `styleRenderParams()` 里，改档只改这一个函数。 */

export type TerrainStyleId = 'relief' | 'contour' | 'flat';
export const DEFAULT_TERRAIN_STYLE: TerrainStyleId = 'relief';

/** 面板上的三档（`label` 进 UI，`hint` 作悬停说明 —— 全项目界面不用 emoji） */
export const TERRAIN_STYLES: { id: TerrainStyleId; label: string; hint: string }[] = [
  { id: 'relief', label: '立体', hint: '山体阴影（上游默认）：一眼看出山在哪、哪边是坡，偏插画' },
  { id: 'contour', label: '等高线', hint: '分层设色 + 等高线，只留一点点阴影：像地形图，读高度读得准' },
  { id: 'flat', label: '平面', hint: '纯色块：没有阴影也没有线，看植被与地形分区最清楚' },
];

export function isTerrainStyle(v: unknown): v is TerrainStyleId {
  return v === 'relief' || v === 'contour' || v === 'flat';
}

/** 数据里那个宽 `string` → 认得出的档（认不出的按默认档，不报错） */
export function terrainStyleOf(v: unknown): TerrainStyleId {
  return isTerrainStyle(v) ? v : DEFAULT_TERRAIN_STYLE;
}

export function terrainStyleLabel(v: unknown): string {
  const id = terrainStyleOf(v);
  return (TERRAIN_STYLES.find((s) => s.id === id) ?? TERRAIN_STYLES[0]).label;
}

/** 风格 → 渲染参数（叠在 `params.render` 之上；缺省档 = 空对象也能跑，值就是上游原样）。
 *  `contour` 那一档的 0.35 晕渲是刻意的：纯平的分层设色在缩略图上"糊成一块"，
 *  留一点阴影既像地形图、又还能看出山脊走向；同时把山脊描边压到 8，
 *  让**等高线**当主角（15 的话满屏都是深色棱线，与线打架）。
 *  `flat` 把 `outline_strength` 归零：那是内核沿深度不连续性画的山脊描边，
 *  不关掉的话"平面"档看着还是立体的（第九十七轮真机截图逮到的）。 */
export function styleRenderParams(v: unknown): Partial<MapgenRenderParams> {
  switch (terrainStyleOf(v)) {
    case 'contour': return { shade: 0.35, bands: 10, contour: 1, contour_scale: 10, outline_strength: 8 };
    case 'flat': return { shade: 0, bands: 0, contour: 0, outline_strength: 0 };
    default: return { shade: 1, bands: 0, contour: 0, outline_strength: 15 };
  }
}

/* ── 种子：一串文字 → 两个 32 位整数（网格种子与高度种子分开，照上游的规矩）──────── */

/** FNV-1a（稳定、够散）；空串给 1，避免全 0 */
export function seedInt(text: string): number {
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return (h >>> 1) || 1; /* 上游 seed 范围是 1..1<<30 */
}

export interface MapgenSpecInput {
  landRatio?: number;
  ridges?: number;
  rivers?: number;
  /* 索引签名：这份 spec 要存进 `MapData.terrain.spec`（数据层用的是宽索引签名），
     少这一行 TS 会拦「没有索引签名」（第九十三轮踩过）。 */
  [k: string]: number | undefined;
}

export const DEFAULT_SPEC: Required<MapgenSpecInput> = { landRatio: 0.34, ridges: 4, rivers: 1 };

/** 灵框的（种子 + 档位 + 数量）→ 上游完整参数。
 *  · `landRatio` 只作为**目标**记下来，真正的收敛在 `runGeneration()` 里做（改 `island`）；
 *  · `ridges` → `mountainSpacing`（山脊越密，山峰间距越小）；
 *  · `rivers` → `rivers.flow` / `lg_min_flow`（河越多，阈值越低）。 */
export function paramsFromSeed(seed: string, style: string = 'continent', spec?: MapgenSpecInput): MapgenParams {
  const st = STYLE_PRESETS[(style as MapgenStyle)] ?? STYLE_PRESETS.continent;
  const sp = { ...DEFAULT_SPEC, ...(spec ?? {}) };
  const keys = seedInt(String(seed || '灵框'));
  const ridges = Math.min(8, Math.max(1, Math.round(sp.ridges)));
  const rv = Math.min(4, Math.max(0, sp.rivers));
  const p: MapgenParams = JSON.parse(JSON.stringify(DEFAULT_PARAMS));
  p.mesh.seed = keys;
  p.elevation.seed = seedInt(String(seed || '灵框') + '|高度');
  p.elevation.island = st.island;
  p.elevation.noisy_coastlines = st.noisy_coastlines;
  p.elevation.ocean_depth = st.ocean_depth;
  p.mountainSpacing = Math.round(56 - ridges * 5.2); /* ridges 2 → 46，4 → 35（上游默认），6 → 25 */
  p.rivers.flow = 0.14 + rv * 0.06;
  p.rivers.lg_min_flow = 3.2 - rv * 0.35;
  return p;
}

/* ── 引擎：网格 + 生成器 ─────────────────────────────────────────────────────── */

export interface TerrainEngine {
  mesh: any;
  t_peaks: number[];
  map: any;
  params: MapgenParams;
  /** 生成用的目标陆地占比（undefined = 不重定海平面，用档位自带的形状与水量） */
  targetLandRatio?: number;
  /** 目标河占比（河流阈值按流量的分位数自校准，见 `statsOf`）；undefined ⇒ 3% */
  riverFraction?: number;
  /** 上次生成真正量到的陆地占比 */
  landRatio: number;
  /** 上次重定海平时用的基准高度（debug / 面板显示用） */
  seaLevel: number;
  /** 重定海平**之前**的最高高度（归一化会把最大值固定拉到 0.85 ⇒ 用它才看得出真实起伏） */
  rawPeak: number;
}

/** 建一块地：取点（边界 + 山峰 + Poisson 铺满）→ Delaunay → 对偶网格 → 挂上游要的字段。
 *  ⚠️ 这段是上游 `mesh.ts` 的 `makeMesh()` 逐句搬过来的，只把它的
 *  `fetch('build/points-*.data')`（离线预计算的点位文件）换成运行时 `choosePoints()`。 */
export function createEngine(params: MapgenParams, targetLandRatio?: number, riverFraction?: number): TerrainEngine {
  const pts = choosePoints(params.mesh.seed, params.spacing, params.mountainSpacing) as any;
  const init = TriangleMesh.addGhostStructure({
    points: pts.points,
    delaunator: Delaunator.from(pts.points as any) as any,
    numBoundaryPoints: pts.numExteriorBoundaryPoints,
  });
  const mesh: any = new TriangleMesh(init as any);

  /* 与边界相连的三角形（岛屿/大陆判定用；上游 mesh.ts:33-36 同款） */
  mesh.is_boundary_t = new Int8Array(mesh.numTriangles);
  for (let t = 0; t < mesh.numTriangles; t++) {
    mesh.is_boundary_t[t] = mesh.r_around_t(t).some((r: number) => mesh.is_boundary_r(r)) ? 1 : 0;
  }
  /* 每条半边的世界长度（渲染/笔刷半径用；上游 mesh.ts:38-45 同款） */
  mesh.length_s = new Float32Array(mesh.numSides);
  for (let s = 0; s < mesh.numSides; s++) {
    const r1 = mesh.r_begin_s(s), r2 = mesh.r_end_s(s);
    const dx = mesh.x_of_r(r1) - mesh.x_of_r(r2), dy = mesh.y_of_r(r1) - mesh.y_of_r(r2);
    mesh.length_s[s] = Math.sqrt(dx * dx + dy * dy);
  }

  /* 山峰：Poisson 点里那一段（外边界 + 内边界之后的 numMountainPoints 个区域）→ 取相邻三角形 */
  const r_peaks = Array.from(
    { length: pts.numMountainPoints },
    (_: unknown, i: number) => i + pts.numExteriorBoundaryPoints + pts.numInteriorBoundaryPoints,
  );
  const t_peaks: number[] = r_peaks.map((r: number) => mesh.t_inner_s(mesh._s_of_r[r]));

  const map: any = new (MapGen as any)(mesh, t_peaks, params);
  return { mesh, t_peaks, map, params, targetLandRatio, riverFraction, landRatio: 0, seaLevel: 0, rawPeak: 0 };
}

/** 面板/助手最常用的那一句：一串种子文字 + 档位 + 数量 → 引擎（并记住目标陆地占比 / 河占比） */
export function createEngineFor(seed: string, style: string, spec?: MapgenSpecInput): TerrainEngine {
  const params = paramsFromSeed(seed, style, spec);
  const merged = { ...DEFAULT_SPEC, ...(spec ?? {}) };
  const rv = Math.min(4, Math.max(0, merged.rivers));
  return createEngine(params, merged.landRatio, 0.01 + 0.015 * rv);
}

/* ── 手刷地形（画笔）───────────────────────────────────────────────
   上游 `painting.ts` 的高度约束场是**模块级单例**（128×128），笔迹只活在这一场里，换种子就被重新生成。
   灵框的做法：**存笔划、不存场** —— `MapTerrainSpec.paint` 放一串笔划（工具 + 尺寸 + 归一化坐标点），
   生成时按同样的顺序重放。这样数据文件只多几百字节（而不是 64KB 的场、更不是 base64 的几十 KB），
   也和"只存参数、图现算"的既有理念一致。
   ⚠️ 重放必须**逐点一致**：实时刷和重放都走同一个固定步长 `PAINT_DT`（不用真实帧间隔），
   否则"刷完看到的图"和"关掉重开之后的图"会不一样。 */
export const PAINT_DT = 60; /* ms/点（上游把 dt 钳在 100ms 内；这个值让"点一下"就有可见强度） */

/** 世界坐标下的一个笔触点（0..1 ＝ 世界 1000 单位 /1000） */
export interface PaintPoint { x: number; y: number }
/** 一笔：工具 + 尺寸 + 轨迹点（`MapTerrainSpec.paint` 存的就是它） */
export interface PaintStroke { tool: string; size: string; points: PaintPoint[] }

export const PAINT_TOOLS: { id: string; label: string; hint: string }[] = [
  { id: 'mountain', label: '造山', hint: '抬高：刷出山脊、高原' },
  { id: 'valley', label: '压谷', hint: '微微抬一点：造丘陵与缓坡' },
  { id: 'shallow', label: '浅海', hint: '压低：淹成浅海、内陆湖' },
  { id: 'ocean', label: '深海', hint: '压到底：开海峡、深海沟' },
];
export const PAINT_SIZES: { id: string; label: string }[] = [
  { id: 'tiny', label: '极细' },
  { id: 'small', label: '细' },
  { id: 'medium', label: '中' },
  { id: 'large', label: '粗' },
];
export const DEFAULT_PAINT_TOOL = 'mountain';
export const DEFAULT_PAINT_SIZE = 'small';

/** 起一笔（上游的 `currentStroke` 会记下这一笔开始前的高度，混色时以它为底） */
export function beginPaintStroke(): void { vendorBeginStroke(); }

/** 实时刷一个点（固定步长；x/y 是 0..1 的世界坐标）
 *  ⚠️ 上游的形参顺序是 `(toolId, x, y, sizeId, dtMs)` —— 别按"工具、尺寸、坐标"的直觉写。 */
export function paintStep(tool: string, size: string, x: number, y: number): void {
  vendorPaintAt(tool, x, y, size, PAINT_DT);
}

/** 重放一个世界的全部笔迹。⚠️ 场里**已经有笔迹**时直接返回 —— 同种子重复生成时场里已经含着它，
    再重放一遍会双重叠加（山越刷越高）。 */
export function replayPaint(strokes: PaintStroke[] | undefined): void {
  if (!strokes?.length || vendorUserHasPainted()) return;
  for (const s of strokes) {
    if (!s?.points?.length) continue;
    vendorBeginStroke();
    for (const p of s.points) vendorPaintAt(s.tool, p.x, p.y, s.size, PAINT_DT);
  }
}

/** 清空约束场（"清空笔迹"用：笔划从数据里删掉之后，场也得回到干净状态） */
export function resetPaint(): void { vendorResetPainting(); }

/** 这一场里有没有笔迹（护栏与测试用） */
export function paintedSoFar(): boolean { return vendorUserHasPainted(); }

/** 生成地形数据（高度 / 降雨 / 河流）。`shape = false` 时**不重定海平面**（只算一次，快一倍），
 *  给"边刷边重算"那条路用（画笔改的是高度约束，不需要每帧都重新定海平面）。
 *  `strokes` = 这个世界的**手刷笔迹**：约束场是内核的模块级单例，换种子时会被重新生成 ⇒
 *  这里在生成前把笔迹**重放**一遍（只在场子是"干净"的时候重放，见 `replayPaint` 的说明）。 */
export function runGeneration(engine: TerrainEngine, opts?: { shape?: boolean; strokes?: PaintStroke[] }): void {
  const { map, params } = engine;
  const shape = opts?.shape !== false;

  /* ① 高度 + ② 重定海平面（要"陆地占 X%"就在这里定死）—— 必须排在降雨与河流之前：
     降雨的迎风坡/雨影看 elevation_r，河流的流向看 elevation_t。 */
  Painting.setElevationParam(params.elevation);
  if (opts?.strokes?.length) replayPaint(opts.strokes);
  map.assignElevation(params.elevation, { size: Painting.size, constraints: Painting.constraints });
  if (shape && engine.targetLandRatio !== undefined) reseatSeaLevel(engine, engine.targetLandRatio);
  map.assignRainfall(params.biomes);
  map.assignRivers(params.rivers);
  engine.landRatio = landRatioOf(engine);
}

/** ⭐ 灵框加的一步（上游没有）：**按目标陆地占比重定海平面**。
 *
 *  上游控制水量的旋钮只有 `island`（岛屿度），而它是**形状**旋钮：实测 island 从 0.02 抬到 1.0，
 *  陆地占比反而从 0.51 掉到 0.35（它把边缘压成深海、只留中间一块）⇒ 拿它当"陆地多少"用会反向。
 *  这里改成：把陆地三角形的高度**分位数**取出来当新的海平面，然后分两段线性归一化
 *  （海面以下压到 [-0.55, 0]、海面以上拉到 [0, 0.85]）⇒ 陆地占比**精确**等于目标（±1/N），
 *  地形形状不变，着色与山体阴影的动态范围也稳定。确定性：同参数必得同结果。 */
function reseatSeaLevel(engine: TerrainEngine, target: number): void {
  const { mesh, map } = engine;
  const n = mesh.numSolidTriangles;
  if (!n) return;
  const e: Float32Array = map.elevation_t;
  const sorted = new Float32Array(n);
  for (let t = 0; t < n; t++) sorted[t] = e[t];
  sorted.sort();
  const at = Math.min(n - 1, Math.max(0, Math.floor((1 - target) * n)));
  const sea = sorted[at];
  let minE = sorted[0], maxE = sorted[n - 1];
  if (!(maxE > sea)) maxE = sea + 1e-3;

  const OCEAN = 0.55, LAND = 0.85;
  const map1 = (v: number) => (v < sea
    ? -(sea - v) / Math.max(sea - minE, 1e-3) * OCEAN
    : (v - sea) / (maxE - sea) * LAND);

  for (let t = 0; t < e.length; t++) e[t] = map1(e[t]);
  const er: Float32Array = map.elevation_r;
  if (er) for (let r = 0; r < er.length; r++) er[r] = map1(er[r]);
  engine.seaLevel = sea;
  engine.rawPeak = maxE;
}

function landRatioOf(engine: TerrainEngine): number {
  const { mesh, map } = engine;
  const n = mesh.numSolidTriangles;
  let land = 0;
  for (let t = 0; t < n; t++) if (map.elevation_t[t] >= 0) land++;
  return n ? land / n : 0;
}

/* ── 统计（面板提示行 / 助手回执用；字段名沿用灵框原来那套，UI 不用改）────────── */

export interface TerrainStats {
  lands: number;
  islands: number;
  zones: number;
  rivers: number;
  lakes: number;
  peak: number;
  landRatio: number;
  /* 灵框自用 */
  regions: number;
  solidTriangles: number;
  /** 量到的最长河（三角形数）—— 面板上能看出"水系壮不壮" */
  longestRiver: number;
}

/** 连通分量（三角形图；跨半边相邻）。上游没有这层统计，这是灵框自己加的。 */
function triangleComponents(mesh: any, pred: (t: number) => boolean): number[][] {
  const n = mesh.numSolidTriangles;
  const seen = new Uint8Array(n);
  const out: number[][] = [];
  for (let t0 = 0; t0 < n; t0++) {
    if (seen[t0] || !pred(t0)) continue;
    const comp: number[] = [];
    const stack: number[] = [t0];
    seen[t0] = 1;
    while (stack.length) {
      const t = stack.pop() as number;
      comp.push(t);
      for (let j = 0; j < 3; j++) {
        const u = mesh.t_outer_s(3 * t + j);
        if (u >= 0 && u < n && !seen[u] && pred(u)) { seen[u] = 1; stack.push(u); }
      }
    }
    out.push(comp);
  }
  return out;
}

/** 陆地形态统计。判据（灵框自己定的，写清楚免得以后猜）：
 *  · **大陆** = 占陆地面积 ≥ 3%（且至少 60 个三角形）的陆块；**岛** = 大小在 8..大陆线之间；
 *  · **湖** = 不挨着边界的水域连通块（≥ 4 个三角形）—— 上游不挖湖，内陆低地被淹就是湖/内陆海；
 *  · **河** = `flow_t` 排在陆地流量前 `riverFraction`（默认 3%）的三角形连通块数
 *    （上游的 `lg_min_flow` 是给它自己渲染用的，量级跟 `flow_t` 对不上，所以这里自校准）；
 *  · **地形区** = 陆地三角形按「高度档 × 湿度档」分类后，成员 ≥ 20 的那些类（最多 3×4=12）；
 *  · **最高峰** = 最大高度 × 9000 m（上游高度是 -1..1 的归一值，灵框按 1.0 ⇒ 9000 m 折算，只为好读）。 */
export function statsOf(engine: TerrainEngine): TerrainStats {
  const { mesh, map } = engine;
  const n = mesh.numSolidTriangles;
  const land = (t: number) => map.elevation_t[t] >= 0;
  const water = (t: number) => map.elevation_t[t] < 0;

  const landComps = triangleComponents(mesh, land);
  const sizes = landComps.map((c) => c.length).sort((a, b) => b - a);
  const landTotal = sizes.reduce((a, b) => a + b, 0);
  const big = Math.max(60, Math.round(landTotal * 0.03));
  const lands = sizes.filter((s) => s >= big).length || (sizes.length ? 1 : 0);
  const islands = sizes.filter((s) => s >= 8 && s < big).length;

  const lakeComps = triangleComponents(mesh, water)
    .filter((c) => c.length >= 4 && !c.some((t) => mesh.is_boundary_t[t]));
  const lakes = lakeComps.length;

  /* 河的阈值按流量分位数自校准：取陆地里有流量的三角形，从高往低切出一个比例 */
  const flows: number[] = [];
  for (let t = 0; t < n; t++) if (land(t) && map.flow_t[t] > 0) flows.push(map.flow_t[t]);
  flows.sort((a, b) => a - b);
  const frac = engine.riverFraction ?? 0.03;
  const thr = flows.length ? flows[Math.min(flows.length - 1, Math.floor(flows.length * (1 - frac)))] : Infinity;
  const riverComps = triangleComponents(mesh, (t) => land(t) && map.flow_t[t] >= thr);
  const rivers = riverComps.length;
  const longestRiver = riverComps.reduce((m, c) => Math.max(m, c.length), 0);

  /* 高度档 × 湿度档（湿度用 moisture_t，上游 assignRivers 里算过） */
  const eBands = [0.02, 0.08, 0.22, 0.5];
  const mBands = [0.1, 0.25, 0.5];
  const zones = new Set<string>();
  const counts = new Map<string, number>();
  let peak = 0;
  let landCount = 0;
  for (let t = 0; t < n; t++) {
    if (!land(t)) continue;
    landCount++;
    const e = map.elevation_t[t];
    if (e > peak) peak = e;
    let ei = 0;
    while (ei < eBands.length && e > eBands[ei]) ei++;
    const m = map.moisture_t ? map.moisture_t[t] : 0.2;
    let mi = 0;
    while (mi < mBands.length && m > mBands[mi]) mi++;
    const key = ei + ':' + mi;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if ((counts.get(key) ?? 0) === 20) zones.add(key);
  }

  return {
    lands, islands, zones: zones.size, rivers, lakes,
    peak: Math.round((engine.rawPeak || peak) * 9000),
    landRatio: n ? landCount / n : 0,
    regions: mesh.numSolidRegions,
    solidTriangles: n,
    longestRiver,
  };
}

/* ── 视图：一块画布上的地形（沙盘地图栏 / 生成面板预览 / 抽卡缩略图都走它）──────── */

/** 灵框地图是 1.8:1，而内核世界是方的（1000×1000，画布 2048²）⇒ **取中间那条横带**。
 *  `BAND` = 横带在世界坐标里的上下界（y 从 234 到 766 ⇒ 532/1000 ≈ 0.532，2048×0.532 ≈ 1090 像素高）。 */
export const BAND = { y0: 234, y1: 766, x0: 20, x1: 980 };

export class TerrainView {
  readonly canvas: HTMLCanvasElement;
  private renderer: any;
  private engine: TerrainEngine;
  private disposed = false;
  /** ⭐ 灵框追加（第九十七轮）：当前风格叠在 `params.render` 之上（`setStyle()` 写它） */
  private styleOverride: Partial<MapgenRenderParams> = {};

  constructor(canvas: HTMLCanvasElement, engine: TerrainEngine) {
    this.canvas = canvas;
    this.engine = engine;
    this.renderer = new (Renderer as any)(engine.mesh, canvas);
  }

  /** ⭐ 只换风格：**不重传几何、不重算地形**，只把新参数交给渲染循环 ⇒ 下一帧就变。
   *  （`update()` 会重新上传地图几何 + 河流几何，那是"地形变了"才需要的；
   *   风格是"看"的参数，所以走这条更短的路。） */
  setStyle(renderParam?: Partial<MapgenRenderParams>): void {
    this.styleOverride = renderParam ?? {};
    if (this.disposed) return;
    this.renderer.updateView({ ...this.engine.params.render, ...this.styleOverride });
  }

  /** 把最新数据推给 GPU 并排一帧（生成完 / 换了渲染参数 / 刚构造完都要调） */
  update(renderParam?: Partial<MapgenRenderParams>): void {
    if (this.disposed) return;
    const { map, params } = this.engine;
    const p = { ...params.render, ...this.styleOverride, ...(renderParam ?? {}) };
    Geometry.setMapGeometry(map, params.elevation.mountain_folds, this.renderer.quad_elements, this.renderer.a_quad_em);
    this.renderer.numRiverTriangles = Geometry.setRiverGeometry(map, params.spacing, params.rivers, this.renderer.a_river_xyww);
    this.renderer.updateMap();
    this.renderer.updateView(p);
  }

  /** 抓一张 2048² 的像素图（上游自带的 screenshotCanvas；WebGL 缓冲区不保留，只能这样读）。 */
  snapshot(timeoutMs = 3000): Promise<HTMLCanvasElement> {
    return new Promise((resolve, reject) => {
      if (this.disposed) { reject(new Error('地形视图已经销毁')); return; }
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error('地形渲染超时（没等到那一帧）'));
      }, timeoutMs);
      this.renderer.screenshotCallback = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(this.renderer.screenshotCanvas as HTMLCanvasElement);
      };
      this.update();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.renderer.stopDrawingLoop(); } catch { /* 上游没有就当没有 */ }
    try {
      const gl = this.renderer.webgl?.gl as WebGL2RenderingContext | undefined;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch { /* 丢上下文失败不影响后续 */ }
  }
}
