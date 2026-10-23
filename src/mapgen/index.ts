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
 *  1. **世界仍是上游那个 1000×1000 方形网格**（`choosePoints` 的 bounds 写死），内部 FBO 固定 1536²。
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
import { terrainOffset, type TerrainNoiseParams } from './noise';

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
  /* ⭐ 灵框追加（第一百零三轮）：八档风格的真实感旋钮 + 色带。全是可选 ⇒ 不填即上游原样。
     值的来源只有一处：`src/mapgen/styles.ts` 的 `styleRenderParams()`。 */
  grade?: number;              /* 0 = 用上游色带；1 = 完全用下面两条色带 */
  detail?: number;             /* 山体细节噪声强度 */
  coast?: number;              /* 海岸湿沙 + 浪花亮边 */
  water_noise?: number;        /* 水面细纹 */
  hatch?: number;              /* 坡面排线 */
  paper?: number;              /* 纸面做旧 */
  grain?: number;              /* 颗粒 */
  vignette?: number;           /* 四角压暗 */
  moist?: number;              /* 湿度偏色权重 */
  /* ⭐ 灵框追加（第一百零四轮）：生物群系 —— 用户「看不出不同地形之间有什么区别」。
     气候色 = 干湿 × 冷暖，4×3 纹理（x = 湿度、y = 温度），由 `styles.ts` 的 `climateFloats()` 生成。 */
  biome_amt?: number;          /* 气候色权重（0 = 只看高度，1 = 低地完全按气候上色） */
  biome_ramp?: number[];       /* 4×3×3：气候表 RGB（0..1） */
  land_ramp?: number[];        /* 8×3：陆地高程色带（0..1 RGB） */
  sea_ramp?: number[];         /* 6×3：海深色带 */
  line_color?: number[];       /* 等高线 / 排线 / 描边色 */
  river_color?: number[];      /* 河色 */
  /* ⭐ 灵框追加（第一百零六轮）：地表材质分层（B3）+ 浅滩带（B4） */
  rock?: number;               /* 岩：高处 / 陡坡露岩（0 = 不上岩色） */
  strata?: number;             /* 岩层条带 */
  snow?: number;               /* 雪线 */
  shelf?: number;              /* 水侧浅滩带 */
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
  /* ⭐ 灵框改动（第一百零五轮）：`spacing` 5.5 → 4.8。
     5.5 时一个三角边在屏幕上约 8.6px，海岸/山脊的**波长下限**就被这个宽度钉住（用户
     「边缘还是很平滑」）；4.8 ⇒ 三角 +31%（5.0 万 → 6.6 万）、建网格只 +6ms、生成耗时不变。
     再往上（4.2 / 3.6）实测三角 +72% / +134%，收益递减，留给以后的档位化。 */
  spacing: 4.8,
  mountainSpacing: 35,
  mesh: { seed: 12345 },
  elevation: {
    /* ⭐ 灵框改动（第一百零四轮）：`hill_height` 0.02 → 0.06。上游这块只铺一层很浅的丘陵，
       实测陆地高度分位：50% 低于 0.026、75% 低于 0.078 ⇒ 一半陆地是"平地"，
       玩家看到的就是"几座山 + 一大片平原"（用户 2026-10-21 的原话）。
       抬到 0.06 后平地从 39% 降到 13%、丘陵 61% ⇒ 起伏铺满，同时峰值/均值仍 9.68（守卫要 ≥ 5.9）。*/
    seed: 187, island: 0.5, noisy_coastlines: 0.01, hill_height: 0.07,
    /* ⭐ 灵框改动（第一百零四轮）：`mountain_folds` 0.05 → 0.18。
       folds 只改**渲染**用的高度（`geometry.ts` 里 `(1 - folds*sqrt(e))*e`：把山谷压低、山脊留住），
       不改 elevation_t ⇒ 统计/守卫口径不变，但山体的脊谷对比更强（"山看着像山脊而不是灰团"）。 */
    mountain_jagged: 0, mountain_sharpness: 9.8, mountain_folds: 0.18, ocean_depth: 1.40,
  },
  /* ⭐ 灵框改动（第一百零四轮）：`raininess` 0.9 → 0.55 / `rain_shadow` 0.5 → 0.7。
     上游这套降雨只用来画"湿绿干黄"，0.9 时**陆地降雨挤在 0.47..0.94、一半以上 > 0.8**
     ⇒ 整张图一个气候（全湿），生物群系只能上一种绿。降下来 + `normalizeRainfall()`
     归一化后才拉得出真正的干湿分区（实测陆地降雨 0.29..0.57，干燥区占 55%）。
     河流数与陆地占比不受影响（实测 rain 0.9 / 0.55 两档都是 45~46 条河、陆地 0.34）。 */
  biomes: { wind_angle_deg: 0, raininess: 0.55, rain_shadow: 0.7, evaporation: 0.5 },
  rivers: { lg_min_flow: 2.7, lg_river_width: -2.4, flow: 0.2 },
  render: {
    zoom: 100 / 480, x: 500, y: 500, light_angle_deg: 80, slope: 2.6, flat: 2.5, ambient: 0.25,
    /* ⭐ 灵框改动（第一百零四轮）：`mountain_height` 50 → 72（垂直夸张）。
       上游的 50 在小窗口缩略尺寸下，山几乎只剩"颜色不一样"；抬到 72 才有立体感，
       同时 `slope` 2 → 2.6 让向阳/背阴面差得更开。 */
    overhead: 30, tilt_deg: 0, rotate_deg: 0, mountain_height: 72,
    outline_depth: 1, outline_strength: 15, outline_threshold: 0, outline_coast: 0,
    outline_water: 13.0, biome_colors: 1,
    /* ⭐ 灵框追加（第九十七轮）：这四个上游没有 ⇒ 缺省值即上游原样（见 `styleRenderParams()`）*/
    shade: 1, contour: 0, contour_scale: 10, bands: 0,
  },
};

/** 灵框的档位（用户能选的三种世界形态）→ 上游参数。理由：上游没有「档位」这个概念，
 *  它只有一堆滑杆；我们把"大陆/群岛/盘古"翻译成参数组合。 */
export const STYLE_PRESETS = {
  /* ⭐ 灵框改动（第一百零五轮）：`noisy_coastlines` 全线抬档 —— 这是"海岸线有多碎"的唯一开关
     （上游拿它在海平面附近叠一层高频噪声，只改海岸、不改大陆形状）。
     实测（同种子）：0.012 → 0.028 时陆/水交界边对数 1684 → 约 2100（+25%），生成耗时一分不变。
     代价是河数会跟着涨（河口变多）—— `paramsFromSeed()` 里把 `lg_min_flow` 一并抬一点压回去。 */
  continent: { island: 0.5, noisy_coastlines: 0.028, ocean_depth: 1.4, mountainSpacing: 35 },
  archipelago: { island: 0.3, noisy_coastlines: 0.055, ocean_depth: 1.15, mountainSpacing: 26 },
  pangaea: { island: 0.72, noisy_coastlines: 0.032, ocean_depth: 1.55, mountainSpacing: 40 },
} as const;
export type MapgenStyle = keyof typeof STYLE_PRESETS;
export const MAPGEN_STYLES: MapgenStyle[] = ['continent', 'archipelago', 'pangaea'];

/** 换内核后**不再可控**的东西（面板/文档要如实说，别假装还在） */
export const APPLY_NOTES = [
  '陆块数 / 岛数不再是指定项 —— 上游的陆地形状由噪声与「岛屿度」决定，不是数出来的',
  '湖泊不再"挖"出来：内陆低地被淹就是内陆海（所以湖数可能为 0）',
];

/* ── 渲染风格（「看的方式」）——注册表已搬到 `src/mapgen/styles.ts`（第一百零三轮）──
   这里只做**转出口**：老代码 `import { TERRAIN_STYLES } from '../mapgen'` 一行都不用改。
   八档 + 旧 id 别名（relief→natural / contour→topo / flat→minimal）都在 `styles.ts` 里定义，
   值也只有那一个来源 —— 别再往这里加第二份表。 */
export {
  DEFAULT_TERRAIN_STYLE, TERRAIN_STYLES, TERRAIN_STYLE_ALIASES, TERRAIN_STYLE_DEFS,
  colorFloats, isTerrainStyle, rampFloats, sampleRampHex, styleRenderParams,
  terrainStyleDef, terrainStyleLabel, terrainStyleOf,
  type TerrainStyleDef, type TerrainStyleId,
} from './styles';

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
  /* 山脊密度 → 山峰间距。上游 `/ 5.2` 的斜率我们没动，只把基准 56 收到 50：
     ridges 4（默认）从 35 收到 30 ⇒ 实测陆地 >0.12 的山体连通块从 7 条涨到 10 条（"山太少"的另一半）。*/
  p.mountainSpacing = Math.round(50 - ridges * 5); /* ridges 2 → 40，4 → 30，6 → 20 */
  /* 丘陵跟着山脊一起抬：用户选"山脊密"时多半也想要更多起伏，而不是只有主峰变多 */
  p.elevation.hill_height = 0.05 + ridges * 0.0055; /* ridges 1 → 0.056，4 → 0.072，8 → 0.094 */
  p.rivers.flow = 0.14 + rv * 0.06;
  p.rivers.lg_min_flow = 3.2 - rv * 0.35;
  /* ⭐ 第一百零三轮：河宽从上游的 0.0907（exp(-2.4)）抬到 0.135（exp(-2.0)，约 1.5 倍）。
     用户「很假」的一半是**河看不见**：地图栏那块画布把位图缩到 ~900px 显示，
     上游那种"刚好一格"的细线在缩略尺寸下直接消失（状态行写着 29 条河，画面一根都没有）。
     河**数**不受影响（数的是流量连通块），所以统计/守卫口径不变。 */
  p.rivers.lg_river_width = -2.0;
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
  /* ⭐ 第一百零四轮：多尺度细节噪声 —— 必须在重定海平面**之前**（陆地占比之后还会被精确钉住）。 */
  applyTerrainNoise(engine);
  /* ⭐ 第一百零六轮：按汇流切谷（脊—谷相间）—— 同样在重定海平面之前。 */
  erodeTerrain(engine);
  if (shape && engine.targetLandRatio !== undefined) reseatSeaLevel(engine, engine.targetLandRatio);
  map.assignRainfall(params.biomes);
  map.assignRivers(params.rivers);
  /* ⭐ 第一百零四轮：降雨归一化必须排在河流之后（河流用得上原始降雨/流量口径）。 */
  normalizeRainfall(engine);
  engine.landRatio = landRatioOf(engine);
}

/** ⭐ 灵框加的一步（第一百零四轮）：把陆地降雨换成**分位数排名**（0..1）。
 *
 *  着色器拿 `v_em.y`（= region/三角形降雨）当湿度轴去查气候表，它必须是**这一张图里的相对干湿**。
 *  ⚠️ 只做 min-max 归一化不够：上游降雨分布极偏（中位数就吃掉 70%+ 的量程）⇒ 归一化后
 *  仍有八成陆地挤在"湿"那两列，整张图还是一色绿。改成**排名**：每块陆地按降雨大小取百分位，
 *  0..1 均匀铺满 ⇒ 沙漠 / 草原 / 温带林 / 雨林四列各占约 1/4，气候带一眼能分开。
 *  排名与线性各混 7:3（纯排名的分界线太"刀切"，掺一点原始梯度会自然些）。
 *  只取陆地（`elevation_r >= 0`）定标尺，海洋不参与；确定性：纯排序，无随机。 */
function normalizeRainfall(engine: TerrainEngine): void {
  const { map, mesh } = engine;
  const rain: Float32Array = map.rainfall_r;
  if (!rain || !rain.length) return;
  const nr = mesh.numRegions ?? rain.length;
  const landIdx: number[] = [];
  let lo = Infinity, hi = -Infinity;
  for (let r = 0; r < nr; r++) {
    if (map.elevation_r[r] < 0) continue;
    const v = rain[r];
    if (!Number.isFinite(v)) continue;
    landIdx.push(r);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (landIdx.length < 4 || !(hi - lo > 1e-6)) return;
  const sorted = landIdx.map((r) => rain[r]).sort((a, b) => a - b);
  const n = sorted.length;
  /* 名次用二分找左下界（并列值给同一个名次 ⇒ 同湿度的两块陆地一样绿） */
  const rankOf = (v: number) => {
    let a = 0, b = n;
    while (a < b) { const m = (a + b) >> 1; if (sorted[m] < v) a = m + 1; else b = m; }
    return a / (n - 1);
  };
  const lin = 1 / (hi - lo);
  for (const r of landIdx) {
    rain[r] = 0.7 * rankOf(rain[r]) + 0.3 * (rain[r] - lo) * lin;
  }
  for (let r = 0; r < rain.length; r++) {
    if (map.elevation_r[r] >= 0) continue;
    const v = (rain[r] - lo) * lin;
    rain[r] = v < 0 ? 0 : (v > 1 ? 1 : v);
  }
}

/** ⭐ 灵框加的一步（第一百零四轮）：把多尺度噪声叠进高度场（细节 fBm + 山脊噪声）。
 *
 *  用户原话：「还有一件事，能不能用多重噪声增加复杂度」。
 *  上游的形貌 = 平滑插值的网格 + 泊松盘撒点 ⇒ 山是"光滑的包"、平原是"一整片均匀面"。
 *  这里按高度加权叠三层：海平面附近 0（海岸线保持平滑）、山脚 35%、山腰以上满幅；
 *  噪声本身见 `src/mapgen/noise.ts`（4 octave fBm + 3 octave 山脊，全部确定性）。
 *
 *  ⚠️ 只改高度场，且调用点在 `reseatSeaLevel()` 之前 ⇒ 陆地占比仍精确等于目标（守卫 ★2）；
 *  确定性由整数哈希保证（守卫 ★3「同种子一致 + 换种子不同」）。 */
function applyTerrainNoise(engine: TerrainEngine): void {
  const { mesh, map } = engine;
  /* ⭐ 第一百零六轮：山脊噪声从"配角"抬成"主角" —— 用户「山很少」。
     ① `ridgeAmp` 0.10 → 0.26：脊的高度不再只是细节，而是能改变坡线的起伏；
     ② 换成**山脊多重分形**（`ridgedMultifractal2D`，5 octave）：主脊上长出分叉支脉；
     ③ 加**域扭曲**（warpAmp 0.5）：团块边界不再是圆斑。*/
  const p: TerrainNoiseParams = {
    frequency: 1 / 95,
    detailAmp: 0.05,
    ridgeAmp: 0.26,
    octaves: 4,
    ridgeOctaves: 5,
    warpAmp: 0.5,
    chainAmp: 0.26,
    chainFreq: 1 / 260,
    chainWidth: 0.055,
    seed: (engine.params.elevation.seed | 0) ^ 0x2f1b3c5d,
  };
  const eT: Float32Array = map.elevation_t;
  if (eT) {
    for (let t = 0; t < eT.length; t++) {
      const e = eT[t];
      if (e <= 0) continue;
      eT[t] = e + terrainOffset(mesh.x_of_t(t), mesh.y_of_t(t), e, p);
    }
  }
  const eR: Float32Array = map.elevation_r;
  if (eR) {
    for (let r = 0; r < eR.length; r++) {
      const e = eR[r];
      if (e <= 0) continue;
      eR[r] = e + terrainOffset(mesh.x_of_r(r), mesh.y_of_r(r), e, p);
    }
  }
}

/** ⭐ 灵框加的一步（第一百零六轮）：**按汇流切谷**（B2「坡度侵蚀一次迭代成谷」）。
 *
 *  用户 2026-10-21：「山很少，而且看不出不同地形之间有什么区别」。
 *  噪声能加"脊"，但加不出"谷"：真实山地的形态是**脊—谷相间**，谷是水沿最陡方向一路冲出来的。
 *  这里做一趟确定性的水力侵蚀近似（和星球形态的汇流同一套思路，按三角网而不是栅格）：
 *    ① 陆地三角按高度降序（4096 桶排序）；
 *    ② 每个三角降"1 滴雨"，全部送给最陡的邻居（`t_outer_s` 跨边的邻接），于是流量沿谷底累加；
 *    ③ 按 `K·flow^0.55` 下切，**下限 45% 原高**（防止把山顶削平，也保证不会跌破海平面）；
 *    ④ 反写 `elevation_r`（区域高度 = 三个相邻三角的平均），降雨与河流那几步才看到同一片地。
 *  ⚠️ 调用点在 `reseatSeaLevel()` **之前** ⇒ 陆地占比仍精确等于目标（守卫 ★2）；
 *  纯算术、无随机 ⇒ 同种子逐位一致（守卫 ★3）。 */
function erodeTerrain(engine: TerrainEngine): void {
  const { mesh, map } = engine;
  const e: Float32Array = map.elevation_t;
  if (!e?.length) return;
  const n = mesh.numSolidTriangles;
  const flow = new Float32Array(n);
  let hi = 0;
  for (let t = 0; t < n; t++) if (e[t] > hi) hi = e[t];
  if (!(hi > 0)) return;

  const B = 4096;
  const binOf = (v: number) => Math.min(B, Math.max(0, ((v / hi) * B) | 0));
  const cnt = new Int32Array(B + 1);
  let landN = 0;
  for (let t = 0; t < n; t++) if (e[t] > 0) { cnt[binOf(e[t])]++; landN++; }
  if (landN < 32) return;
  let sum = 0;
  for (let b = B; b >= 0; b--) { const c = cnt[b]; cnt[b] = sum; sum += c; }
  const order = new Int32Array(landN);
  for (let t = 0; t < n; t++) if (e[t] > 0) order[cnt[binOf(e[t])]++] = t;

  for (let q = 0; q < order.length; q++) {
    const t = order[q];
    flow[t] += 1;
    let best = -1, bestH = e[t];
    for (let j = 0; j < 3; j++) {
      const u = mesh.t_outer_s(3 * t + j);
      if (u < 0 || u >= n) continue;
      if (e[u] < bestH) { bestH = e[u]; best = u; }
    }
    if (best >= 0) { flow[best] += flow[t]; }
  }

  /* 下切：主河道（flow 上千）切几米，支沟（flow 十位）切薄薄一层。
     系数 0.0016 → 0.0032（第一百零六轮第二版）：第一版只切掉 1~2%，山谷在 900px 的地图上
     根本看不出来；加倍后才看得出"脊—谷相间"。 */
  const K = 0.0032;
  for (let t = 0; t < n; t++) {
    if (e[t] <= 0) continue;
    const f = flow[t];
    if (f < 2) continue;
    const cut = K * Math.pow(f, 0.55);
    const floor = e[t] * 0.45;
    const next = e[t] - cut;
    e[t] = next < floor ? floor : next;
  }

  /* 反写区域高度：每个 region = 相邻三个三角的平均（与上游 assignElevation 的口径一致） */
  const er: Float32Array = map.elevation_r;
  if (!er?.length) return;
  const acc = new Float32Array(er.length);
  const num = new Uint8Array(er.length);
  for (let t = 0; t < n; t++) {
    if (e[t] <= 0) continue;
    const rs: number[] = mesh.r_around_t(t);
    for (const r of rs) { acc[r] += e[t]; if (num[r] < 250) num[r]++; }
  }
  for (let r = 0; r < er.length; r++) {
    if (er[r] < 0) continue;          /* 海里不动：海深由海平面重定统一处理 */
    if (num[r]) er[r] = acc[r] / num[r];
  }
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

/** 灵框地图是 1.8:1，而内核世界是方的（1000×1000，画布 1536²）⇒ **取中间那条横带**。
 *  `BAND` = 横带在世界坐标里的上下界（y 从 234 到 766 ⇒ 532/1000 ≈ 0.532，1536×0.532 ≈ 817 像素高）。 */
export const BAND = { y0: 234, y1: 766, x0: 20, x1: 980 };

export class TerrainView {
  readonly canvas: HTMLCanvasElement;
  private renderer: any;
  private engine: TerrainEngine;
  private disposed = false;
  /** ⭐ 灵框追加（第九十七轮）：当前风格叠在 `params.render` 之上（`setStyle()` 写它） */
  private styleOverride: Partial<MapgenRenderParams> = {};

  /** `textureSize` = 内部位图边长（第一百零六轮 C3）：地图栏 1536、缩略图/抽卡 768。
   *  不传 = 内核缺省 1536（旧调用不变）。 */
  constructor(canvas: HTMLCanvasElement, engine: TerrainEngine, textureSize?: number) {
    this.canvas = canvas;
    this.engine = engine;
    this.renderer = new (Renderer as any)(engine.mesh, canvas, textureSize);
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

  /** 抓一张 `TERRAIN_BITMAP²` 的像素图（上游自带的 screenshotCanvas；WebGL 缓冲区不保留，只能这样读）。 */
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
