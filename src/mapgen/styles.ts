/** 地图的「看的方式」——**唯一**的风格注册表（第一百零三轮）。
 *
 *  用户 2026-10-20：「我们的地图生成系统还是很假，而且不像真实地图，显示风格也很少而且不好看」
 *  ⇒ 三档（立体 / 等高线 / 平面）扩成八档，并且每档带**自己的高程色带**和一套真实感旋钮
 *  （山体细节噪声 / 海岸湿沙与泡沫 / 水面细纹 / 排线 / 纸纹 / 颗粒 / 暗角）。
 *
 *  两条硬规矩：
 *    1. **风格只是渲染参数**：换档 = 下一帧重画，不重建网格、不重算地形（第九十七轮定的，别破坏）；
 *    2. **缺省值 = 上游原样**：`grade = 0` 时着色器里这整套是死代码 ⇒ 没设置的调用方（旧测试、
 *       离线脚本）拿到的还是 mapgen4 原色带。
 *
 *  颜色格式全用 `#rrggbb`；`land` 恰好 8 个等距采样点、`sea` 恰好 6 个，着色器按**等距**插值
 *  （改数量要同时改 `vendor/render.ts` 的 `u_land_ramp[8]` / `u_sea_ramp[6]`）。 */

import type { MapgenRenderParams } from './index';

/** 八档的 id（数据里存的就是这个字符串；旧数据里的 relief/contour/flat 由别名表归一化） */
export type TerrainStyleId =
  | 'natural' | 'topo' | 'paper' | 'ink'
  | 'blueprint' | 'dreamcore' | 'satellite' | 'minimal';

export const DEFAULT_TERRAIN_STYLE: TerrainStyleId = 'natural';

/** 旧 id → 新 id。①保旧数据能读；②语义对得上：relief≈自然、contour≈地形图、flat≈极简 */
export const TERRAIN_STYLE_ALIASES: Record<string, TerrainStyleId> = {
  relief: 'natural',
  contour: 'topo',
  flat: 'minimal',
};

export interface TerrainStyleDef {
  id: TerrainStyleId;
  label: string;
  hint: string;
  /** 陆地色带：8 个等距采样点，t=0 海平面边 → t=1 最高峰 */
  land: string[];
  /** 水色带：6 个等距采样点，t=0 岸边 → t=1 最深海 */
  sea: string[];
  /** 等高线 / 排线 / 描边用的线色 */
  line: string;
  /** 河 */
  river: string;
  /** 用不用这套色带（0 = 上游原色带；八档全是 1） */
  grade: number;
  /** 山体晕渲强度（0 = 完全平面） */
  shade: number;
  /** 分层设色档数（0 = 连续渐变） */
  bands: number;
  /** 等高线浓度（0 = 不画） */
  contour: number;
  /** 高度范围分几格（越大线越密） */
  contourScale: number;
  /** 山体细节噪声（0 = 光滑） */
  detail: number;
  /** 海岸湿沙 + 浪花亮边（0 = 不画） */
  coast: number;
  /** 水面细纹（0 = 死平） */
  waterNoise: number;
  /** 坡面排线（0 = 不排；水墨/雕版用） */
  hatch: number;
  /** 纸面做旧（0 = 无） */
  paper: number;
  /** 颗粒（0 = 无） */
  grain: number;
  /** 四角压暗（0 = 无） */
  vignette: number;
  /** 湿度偏色权重（湿偏绿 / 干偏暖；0 = 不看湿度） */
  moist: number;
  /** 气候色权重（0 = 只看高度；越大低地越按「干湿 × 冷暖」上色 —— 生物群系） */
  biome: number;
  /** 气候表的染色方式（八档各自的调子；见 `applyClimate()`） */
  treat: ClimateTreat;
  /** 山脊描边强度 */
  outline: number;
  /** 河两侧压边（上游的 outline_water：越大河床越"凹"） */
  outlineWater: number;
  /** 海岸描边（上游的 outline_coast） */
  outlineCoast: number;
  /** 光角（度） */
  light: number;
  /* ⭐ 第一百零六轮：地表材质分层 + 浅滩带（B3/B4）。
     没写就按 `MATERIAL_DEFAULTS`（按 id 取）—— 八档的配色是逐条挑的，材质强度也逐档给，不用改一堆字面量。 */
  /** 高处 / 陡坡露岩（0 = 不上岩色） */
  rock?: number;
  /** 岩层条带（0 = 无） */
  strata?: number;
  /** 雪线（0 = 不压雪） */
  snow?: number;
  /** 水侧浅滩带（0 = 与深海同色） */
  shelf?: number;
}

/** 八档。色带是**逐条挑的**（不是算法生成）：挑的标准是"缩到 120px 的缩略图还认得出是什么风格" */
export const TERRAIN_STYLE_DEFS: TerrainStyleDef[] = [
  {
    id: 'natural',
    label: '自然',
    hint: '真实地形配色：绿低地 → 黄褐丘陵 → 灰岩 → 雪线，海从浅青到深蓝，带山体细节与海岸浪花',
    land: ['#7b9557', '#8aa05e', '#9aa966', '#adaf74', '#b6a480', '#b39784', '#bbb6ae', '#f3f2ec'],
    sea: ['#7fb5b4', '#5f9aa4', '#46808f', '#33647b', '#26506a', '#1b3c52'],
    line: '#3d4a33',
    river: '#5b9fc4',
    grade: 1, shade: 1, bands: 0, contour: 0, contourScale: 10,
    detail: 0.65, coast: 0.5, waterNoise: 0.2, hatch: 0, paper: 0, grain: 0.05, vignette: 0,
    moist: 0.8, biome: 0.85, treat: 'natural', outline: 15, outlineWater: 13, outlineCoast: 0.75, light: 80,
  },
  {
    id: 'topo',
    label: '地形图',
    hint: '分层设色 + 等高线：像纸本地形图，读高度读得准（每格 20 条线，计曲线更深）',
    land: ['#d7e2b0', '#cddda2', '#c3d29a', '#cbc79a', '#d0b992', '#c7a582', '#bb9478', '#efe9dc'],
    sea: ['#d4e8ee', '#bcdbe4', '#9cc8d6', '#83b6c8', '#6fa4bd', '#5e94ae'],
    line: '#8a5a2e',
    river: '#4b8cb0',
    grade: 1, shade: 0.32, bands: 14, contour: 1, contourScale: 20,
    detail: 0.18, coast: 0.3, waterNoise: 0.04, hatch: 0, paper: 0.12, grain: 0.02, vignette: 0,
    moist: 0.25, biome: 0.4, treat: 'pale', outline: 8, outlineWater: 13, outlineCoast: 0.8, light: 80,
  },
  {
    id: 'paper',
    label: '羊皮纸',
    hint: '做旧航海图：暖褐墨色、坡面排线、纸纹与暗角；海面留白，河是褐色墨线',
    land: ['#cdb98e', '#c6b087', '#bfa47c', '#b3956f', '#a4835f', '#97795a', '#8f7050', '#7a5d43'],
    sea: ['#d3c4a2', '#c8b894', '#bdab87', '#b19d7c', '#a69271', '#9a8464'],
    line: '#6a4a2c',
    river: '#8a6636',
    grade: 1, shade: 0.5, bands: 0, contour: 0.55, contourScale: 9,
    detail: 0.35, coast: 0.3, waterNoise: 0.1, hatch: 0.45, paper: 0.9, grain: 0.5, vignette: 0.45,
    moist: 0.2, biome: 0.55, treat: 'sepia', outline: 10, outlineWater: 13, outlineCoast: 1.5, light: 65,
  },
  {
    id: 'ink',
    label: '水墨',
    hint: '单色水墨：只靠墨色浓淡与坡面皴线读地形，海是留白',
    land: ['#bdbab2', '#a9a69e', '#8b8880', '#6b6963', '#57554f', '#4a4842', '#403e39', '#333230'],
    sea: ['#f0eee8', '#e7e5de', '#dedcd4', '#d6d4cc', '#d0cec6', '#c9c7bf'],
    line: '#22211e',
    river: '#3d3b36',
    grade: 1, shade: 0.95, bands: 0, contour: 0.25, contourScale: 8,
    detail: 0.85, coast: 0.15, waterNoise: 0.2, hatch: 0.35, paper: 0.3, grain: 0.12, vignette: 0.3,
    moist: 0.1, biome: 0.45, treat: 'ink', outline: 14, outlineWater: 13, outlineCoast: 0.6, light: 75,
  },
  {
    id: 'blueprint',
    label: '蓝图',
    hint: '工程蓝图：深蓝底 + 青线，等高线像制图网格，海岸描一圈细线',
    land: ['#0d2a47', '#123a5c', '#17496e', '#1d5a84', '#24648f', '#2a6d99', '#3180a5', '#3b83ac'],
    sea: ['#0a2038', '#081a2e', '#071528', '#061222', '#050f1c', '#040c17'],
    line: '#8fd3ee',
    river: '#7cc4e4',
    grade: 1, shade: 0.5, bands: 0, contour: 1, contourScale: 16,
    detail: 0.15, coast: 0.6, waterNoise: 0.2, hatch: 0.3, paper: 0, grain: 0.12, vignette: 0.35,
    moist: 0, biome: 0.5, treat: 'blue', outline: 6, outlineWater: 13, outlineCoast: 1.8, light: 60,
  },
  {
    id: 'dreamcore',
    label: '梦核',
    hint: '灵框自己的皮肤色：暖灰橄榄陆地 + 荧光绿水系，颗粒与暗角，像从旧录像里截的',
    land: ['#9aa585', '#93a07f', '#8a9875', '#7d8b69', '#748263', '#6f7c5d', '#697453', '#9aa38f'],
    sea: ['#aab7a9', '#9daf9f', '#93a89b', '#82978f', '#6f8884', '#5b7573'],
    line: '#3a4535',
    river: '#9ec262',
    grade: 1, shade: 0.75, bands: 0, contour: 0.2, contourScale: 9,
    detail: 0.5, coast: 0.4, waterNoise: 0.25, hatch: 0, paper: 0.35, grain: 0.3, vignette: 0.5,
    moist: 0.5, biome: 0.75, treat: 'dream', outline: 12, outlineWater: 13, outlineCoast: 1.4, light: 75,
  },
  {
    id: 'satellite',
    label: '卫星',
    hint: '卫星影像：深绿雨林 → 黄褐荒漠 → 灰岩，海是深蓝，细节最强、明暗对比最大',
    land: ['#3f5a2a', '#4a6431', '#566d36', '#67793e', '#7d844d', '#8f8a63', '#a09a86', '#eae8e2'],
    sea: ['#2f6f8e', '#235a7b', '#1a4566', '#12324e', '#0d2842', '#0a2136'],
    line: '#1c1c17',
    river: '#5793b4',
    grade: 1, shade: 1, bands: 0, contour: 0, contourScale: 10,
    detail: 1, coast: 0.45, waterNoise: 0.3, hatch: 0, paper: 0, grain: 0.1, vignette: 0.25,
    moist: 1, biome: 0.8, treat: 'vivid', outline: 15, outlineWater: 13, outlineCoast: 1, light: 80,
  },
  {
    id: 'minimal',
    label: '极简',
    hint: '纯色块：没有阴影、没有线、没有噪声，只看陆块形状与地形分区',
    land: ['#c9cfba', '#c2c9b1', '#bfc7ac', '#b8c2a7', '#b2bb9f', '#acb69a', '#a7b194', '#9ea88c'],
    sea: ['#d6dedb', '#cbd5d3', '#c2cecd', '#b9c6c6', '#b3c1c1', '#adbcbc'],
    line: '#98a290',
    river: '#a7bcbb',
    grade: 1, shade: 0, bands: 0, contour: 0, contourScale: 10,
    detail: 0, coast: 0.25, waterNoise: 0, hatch: 0, paper: 0, grain: 0, vignette: 0,
    moist: 0.3, biome: 0.3, treat: 'muted', outline: 0, outlineWater: 13, outlineCoast: 0.4, light: 80,
  },
];

const BY_ID = new Map<TerrainStyleId, TerrainStyleDef>(TERRAIN_STYLE_DEFS.map((d) => [d.id, d]));

export function isTerrainStyle(v: unknown): v is TerrainStyleId {
  return typeof v === 'string' && BY_ID.has(v as TerrainStyleId);
}

/** 数据里的宽 `string` → 认得出的档（旧 id 走别名；认不出的按默认档，不报错） */
export function terrainStyleOf(v: unknown): TerrainStyleId {
  if (isTerrainStyle(v)) return v;
  if (typeof v === 'string' && TERRAIN_STYLE_ALIASES[v]) return TERRAIN_STYLE_ALIASES[v];
  return DEFAULT_TERRAIN_STYLE;
}

export function terrainStyleDef(v: unknown): TerrainStyleDef {
  return BY_ID.get(terrainStyleOf(v)) ?? TERRAIN_STYLE_DEFS[0];
}

export function terrainStyleLabel(v: unknown): string {
  return terrainStyleDef(v).label;
}

/* ── 等高线绘制方式（第一百零八轮）─────────────────────────────────────────────
   用户原话：「有些地方因为地形陡峭导致等高线有点密集，能不能加一个等高线绘制方式，
   是全部显示还是省略部分」。拍板口径：**自动抽稀 + 手动档位** —— 默认「自动」按屏幕上的
   线间距自动跳线（陡坡自然变稀、平地全显示），另给「全部 / 减半 / 每五条」三档手选。

   ⚠️ 这是**显示参数**（和 `view` / `lift` 同一类）：换它不重算地形，只是重画。
   着色器里 0 = 自动（按 `fwidth(zLand)` 现算每格多少条），n>1 = 每 n 条画一挑一：
   见 `vendor/render.ts` 的 `u_contour_every`。星球那条 CPU 上色读同一个数字。 */
export type ContourMode = 'auto' | 'all' | 'half' | 'fifth';

export const CONTOUR_MODES: { id: ContourMode; label: string; hint: string }[] = [
  { id: 'auto', label: '自动', hint: '按屏幕上线间距自动跳线：陡坡变稀、平地照旧全显示' },
  { id: 'all', label: '全部', hint: '每条等高线都画（陡坡上会挤成一片）' },
  { id: 'half', label: '减半', hint: '每 2 条画 1 条' },
  { id: 'fifth', label: '每五条', hint: '每 5 条画 1 条 —— 只留主等高线，读起来最清爽' },
];

export function isContourMode(v: unknown): v is ContourMode {
  return v === 'auto' || v === 'all' || v === 'half' || v === 'fifth';
}

/** 数据里的宽 `string` → 认得的方式（缺省/认不出 = 自动）*/
export function contourModeOf(v: unknown): ContourMode {
  return isContourMode(v) ? v : 'auto';
}

export function contourModeLabel(v: unknown): string {
  const m = contourModeOf(v);
  return CONTOUR_MODES.find((c) => c.id === m)?.label ?? '自动';
}

/** 渲染参数里的「每几条画一条」：0 = 自动（着色器按屏幕导数现算），其余是手选倍率 */
export function contourEveryOf(v: unknown): number {
  switch (contourModeOf(v)) {
    case 'all': return 1;
    case 'half': return 2;
    case 'fifth': return 5;
    case 'auto':
    default: return 0;
  }
}

/** 面板上的八档（`label` 进 UI，`hint` 作悬停说明 —— 界面不用 emoji） */
export const TERRAIN_STYLES: { id: TerrainStyleId; label: string; hint: string }[] =
  TERRAIN_STYLE_DEFS.map((d) => ({ id: d.id, label: d.label, hint: d.hint }));

/* ── 色带工具（着色器与星球两种上色共用）────────────────────────────────────── */

/** `#rrggbb` → 0..1 的三元组（着色器 uniform 用） */
export function colorFloats(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

/** 色带 → 等距采样后的平坦 Float32Array（`uniform3fv` 直接吃） */
export function rampFloats(hexes: string[], n: number): Float32Array {
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = colorFloats(sampleRampHex(hexes, n === 1 ? 0 : i / (n - 1)));
    out[i * 3] = r; out[i * 3 + 1] = g; out[i * 3 + 2] = b;
  }
  return out;
}

/** 在一条 `#rrggbb` 色带上按 t∈[0,1] 线性插值，返回 `#rrggbb`（星球逐像素上色用） */
export function sampleRampHex(hexes: string[], t: number): string {
  const n = hexes.length;
  if (n === 0) return '#000000';
  if (n === 1) return hexes[0];
  const f = Math.min(1, Math.max(0, t)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(f));
  const k = f - i;
  const a = hexes[i], b = hexes[i + 1];
  const ch = (p: number, q: number) => Math.round(p + (q - p) * k);
  return '#' + [1, 3, 5].map((o) => {
    const v = ch(parseInt(a.slice(o, o + 2), 16), parseInt(b.slice(o, o + 2), 16));
    return v.toString(16).padStart(2, '0');
  }).join('');
}

/* ── 气候色（生物群系）────────────────────────────────────────────────────────
   用户 2026-10-21：「看不出不同地形之间有什么区别，只能看出山脉和平原两种地形」。
   **高程色带只能表达"多高"，表达不了"多干 / 多冷"** ⇒ 再挂一张 **干湿 × 冷暖** 的气候表：
   4 个湿度档（干 → 湿，纹理 x）× 3 个温度带（冷 / 温 / 暖，纹理 y）。
   着色器按 `texture(u_biome, vec2(湿度, 温度))` 采样，线性过滤 ⇒ 群系之间是渐变不是色块。
   八档风格各自把这张表染成自己的调子（`applyClimate`）—— 内容（哪里干哪里冷）来自地形，色调来自风格。 */

/** 基准气候表：行 = 温度带（冷 / 温 / 暖），列 = 湿度（干 → 湿）。 */
const CLIMATE_BASE: string[][] = [
  /* 冷带：苔原（灰白）→ 荒原 → 针叶林（青灰绿）→ 深针叶林 —— 蓝绿调，与温带的黄绿拉开 */
  ['#d5d7cc', '#b6bcae', '#6e8a7c', '#4f6f66'],
  /* 温带：干草原（卡其）→ 草甸 → 温带阔叶林 → 深林 */
  ['#b3a97f', '#98a46f', '#5f8355', '#4a6f4a'],
  /* 暖带：荒漠（沙黄）→ 稀树草原（黄绿）→ 旱生林（橄榄）→ 雨林（深绿） */
  ['#dfc48c', '#c3b26b', '#93a557', '#3f6f45'],
];

export type ClimateTreat = 'natural' | 'vivid' | 'dream' | 'sepia' | 'ink' | 'blue' | 'pale' | 'muted';

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}
/** 两色按 k 混合（0 = a，1 = b） */
function mixHex(a: string, b: string, k: number): string {
  const [r1, g1, b1] = hexToRgb(a), [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(r1 + (r2 - r1) * k, g1 + (g2 - g1) * k, b1 + (b2 - b1) * k);
}
/** 亮度（Rec.709） */
function luma(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** 去饱和：按 k 走向同亮度的灰 */
function desat(hex: string, k: number): string {
  const l = luma(hex);
  return mixHex(hex, rgbToHex(l, l, l), k);
}

/** 把基准气候色染成某档风格的调子（只动色相/明度，不动"哪里是什么群系"的分布） */
function applyClimate(hex: string, treat: ClimateTreat): string {
  switch (treat) {
    case 'vivid':   /* 卫星：略提亮、略加饱和（往纯色推一点） */
      return desat(mixHex(hex, '#ffffff', 0.04), -0.12);
    case 'dream':   /* 梦核：压向品牌橄榄绿，再混一层暖灰（旧录像感） */
      return mixHex(mixHex(hex, '#87a95c', 0.32), '#c9c6bd', 0.14);
    case 'sepia':   /* 羊皮纸：整体褐化 */
      return mixHex(hex, '#c9b489', 0.55);
    case 'ink':     /* 水墨：只剩明暗（留一点冷灰蓝，别变纯中性） */
      return mixHex(rgbToHex(luma(hex), luma(hex), luma(hex)), '#5b6470', 0.16);
    case 'blue':    /* 蓝图：压进深蓝，靠明度区分群系 */
      return mixHex(mixHex(hex, '#1b4a72', 0.62), '#8fd3ee', 0.05);
    case 'pale':    /* 地形图：往纸白提，保持读图时的低刺激 */
      return mixHex(mixHex(hex, '#f2eddd', 0.45), '#8a5a2e', 0.03);
    case 'muted':   /* 极简：灰化 + 压平 */
      return mixHex(desat(hex, 0.5), '#cfcbbf', 0.35);
    case 'natural':
    default:
      return hex;
  }
}

/** 气候表 → 着色器纹理（4×3，行主序：温度带 0..2 × 湿度档 0..3），12×3 个 0..1 分量 */
export function climateFloats(treat: ClimateTreat): Float32Array {
  const out = new Float32Array(12 * 3);
  let i = 0;
  for (const row of CLIMATE_BASE) {
    for (const hex of row) {
      const [r, g, b] = colorFloats(applyClimate(hex, treat));
      out[i++] = r; out[i++] = g; out[i++] = b;
    }
  }
  return out;
}

/** 某个群系的颜色（星球逐像素上色用：按温度 / 湿度双线性插值） */
export function climateHex(treat: ClimateTreat, temp01: number, moist01: number): string {
  const t = Math.max(0, Math.min(1, temp01)) * (CLIMATE_BASE.length - 1);
  const m = Math.max(0, Math.min(1, moist01)) * (CLIMATE_BASE[0].length - 1);
  const t0 = Math.floor(t), t1 = Math.min(CLIMATE_BASE.length - 1, t0 + 1), tk = t - t0;
  const m0 = Math.floor(m), m1 = Math.min(CLIMATE_BASE[0].length - 1, m0 + 1), mk = m - m0;
  const row = (ri: number) => mixHex(CLIMATE_BASE[ri][m0], CLIMATE_BASE[ri][m1], mk);
  return applyClimate(mixHex(row(t0), row(t1), tk), treat);
}

/** 材质分层的逐档强度（第一百零六轮）：把"山"与"平原"分开的四把旋钮。
 *  · rock   —— 高处 + 陡坡露岩（雪线也要靠它给掩码）；
 *  · strata —— 岩层条带（地形图/卫星最重，极简档 0）；
 *  · snow   —— 雪线（水墨/蓝图压雪会毁掉那套配色 ⇒ 低甚至 0）；
 *  · shelf  —— 水侧浅滩带（岸线不再是"一刀切"的深蓝）。 */
const MATERIAL_DEFAULTS: Record<TerrainStyleId, { rock: number; strata: number; snow: number; shelf: number }> = {
  natural:   { rock: 0.62, strata: 0.35, snow: 0.85, shelf: 0.75 },
  topo:      { rock: 0.50, strata: 0.65, snow: 0.55, shelf: 0.45 },
  paper:     { rock: 0.42, strata: 0.22, snow: 0.30, shelf: 0.35 },
  ink:       { rock: 0.55, strata: 0.30, snow: 0.25, shelf: 0.30 },
  blueprint: { rock: 0.65, strata: 0.55, snow: 0.10, shelf: 0.50 },
  dreamcore: { rock: 0.35, strata: 0.18, snow: 0.45, shelf: 0.55 },
  satellite: { rock: 0.85, strata: 0.50, snow: 1.00, shelf: 0.80 },
  minimal:   { rock: 0.00, strata: 0.00, snow: 0.00, shelf: 0.15 },
};

/** 某档解析后的材质强度 —— 星球那条 CPU 上色路径与 WebGL 共用同一份取值 */
export function styleMaterial(v: unknown): { rock: number; strata: number; snow: number; shelf: number } {
  const d = terrainStyleDef(v);
  const m = MATERIAL_DEFAULTS[d.id];
  return { rock: d.rock ?? m.rock, strata: d.strata ?? m.strata, snow: d.snow ?? m.snow, shelf: d.shelf ?? m.shelf };
}

/** 风格 → 渲染参数（叠在 `params.render` 之上）。缺省档缺省值 = 上游原样。 */
export function styleRenderParams(v: unknown): Partial<MapgenRenderParams> {
  const d = terrainStyleDef(v);
  const mat = MATERIAL_DEFAULTS[d.id];
  return {
    grade: d.grade,
    shade: d.shade,
    bands: d.bands,
    contour: d.contour,
    contour_scale: d.contourScale,
    detail: d.detail,
    coast: d.coast,
    water_noise: d.waterNoise,
    hatch: d.hatch,
    paper: d.paper,
    grain: d.grain,
    vignette: d.vignette,
    moist: d.moist,
    rock: d.rock ?? mat.rock,
    strata: d.strata ?? mat.strata,
    snow: d.snow ?? mat.snow,
    shelf: d.shelf ?? mat.shelf,
    biome_amt: d.biome,
    biome_ramp: Array.from(climateFloats(d.treat)),
    outline_strength: d.outline,
    outline_water: d.outlineWater,
    outline_coast: d.outlineCoast,
    light_angle_deg: d.light,
    land_ramp: Array.from(rampFloats(d.land, 8)),
    sea_ramp: Array.from(rampFloats(d.sea, 6)),
    line_color: colorFloats(d.line),
    river_color: colorFloats(d.river),
  };
}
