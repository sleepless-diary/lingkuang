/** **星球形态**：球面程序化世界地图（灵框地图的第二个形态，与 `./index.ts` 里 vendored 的
 *  mapgen4「局部地形」并存）。
 *
 *  ⭐ 2026-10-16（用户：「我们的算法不是能放在真实球体上的地图」→ ask_user_question 选定
 *  「A 灵框自己出星球图：球面无缝生成 + 球体预览」+「与现内核并存」）：
 *  局部地形那张图是**平面方图** —— 二维泊松盘网格、纹理 `CLAMP_TO_EDGE`、经度不闭合、没有极点，
 *  所以贴不到球上。本文件补上另一半：**等距圆柱（equirectangular，恒定 2:1）的整颗星球**。
 *
 *  ⭐ 为什么它天生能贴球（三条别以后改坏）：
 *    · 每个格子先换算成**单位球上的三维点**（纬度/经度 → xyz），再拿 **3D 噪声**采样
 *      ⇒ 经度 ±180° 两侧在球上是同一个位置，**接缝天然不存在**（不是靠"把两边对齐"补出来的）；
 *    · 极点：最上一行是纬度 ±89.8° 那一圈，球上收到一个点 ⇒ 整行颜色几乎相同 —— 这是**正确**的，
 *      也是守卫 `tools/e2e/map-planet.cjs` 用来证明"真的在球面采样"的判据（平面采样的极点行会跟赤道一样花）；
 *    · 网格恒定 `w = 2h` ⇒ 直接就是球体贴图。
 *
 *  管线：三维噪声（大陆度 + 单位球上的域扭曲 + 板缘带 × 脊状噪声造山 + 分区基准/起伏）
 *  → 海平面取**陆地占比的分位数**（所以占比精确命中，不是碰运气）
 *  → 距离海（多源 BFS，经度环绕）→ 温度（纬度递减 + 海拔递减）/ 湿度（风带 × 距海）
 *  → 汇流（按高度降序把水往下游送）→ 河 / 湖 → 连通分量统计。
 *
 *  ⚠️ 与 mapgen4 那条路**口径一致**：统计字段名沿用 `TerrainStats`（`./index.ts`）⇒ 地图栏状态行、
 *  助手回执、工作室面板都不用改；"看的方式"（立体 / 等高线 / 平面）只在 `renderPlanet()` 里换**上色**，
 *  不重算地形（与局部形态的 `TerrainView.setStyle()` 同一个规矩）。
 *  ⚠️ 没做的（别在界面上假装有）：真板块运动 / 侵蚀 / 雨影 / 柯本气候分类 —— 那是
 *  `F:\knowledge-base\projects\world-map` 那条重管线的活（用户口径：真实模拟是额外附件）。 */

import { createNoise3D } from 'simplex-noise';
/* ⚠️ **只用 `import type`**：本模块要能被离线脚本单独打包进 node 跑（`vite build --lib` →
 *  `require`），而 `./index.ts` 那条链拉进 vendored mapgen4，里面有 DOM 假设（`document` /
 *  `HTMLCanvasElement`）⇒ 值导入会在 node 里直接炸。`seedInt` 因此本地抄一份。 */
import type { MapgenSpecInput, TerrainStats } from './index';
import { climateHex, sampleRampHex, styleMaterial, styleSeabed, terrainStyleDef } from './styles';
/* ⭐ 第一百三十五轮：手绘原型（多图层）—— 纯数据模块，不拉 DOM，能跟本文件一起离线打包。 */
import {
  CLIMATE_DRY, CLIMATE_WET, EDGE_MAX, LAND_SET, NOISE_MAX, SEA_SET,
  ZONE_BASIN, ZONE_HILL, ZONE_LAKE, ZONE_MOUNTAIN, ZONE_PLATEAU,
  decodeProtoInput, type LegacyMaskStored, type ProtoInput,
} from './proto';

/* ── 小工具 ─────────────────────────────────────────────────────────────────── */

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const D2R = Math.PI / 180;
/** 地球半径（km）——只用于把格距换算成公里，让坡度/光照有物理意义 */
const R_KM = 6371;

/** FNV-1a（与 `./index.ts` 的 `seedInt()` 同一口径：非空、稳定、够散）*/
function seedInt(text: string): number {
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return (h >>> 1) || 1;
}

/** 确定性伪随机（同一颗种子永远同一颗星球）。取 mulberry32：短、无依赖、够散。 */
function mulberry32(a: number): () => number {
  let t = a >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

type Noise3 = (x: number, y: number, z: number) => number;

/** 分形叠加（-1..1）。**采样点必须在单位球上**，否则经度接缝会露出来。 */
function fbm3(n: Noise3, x: number, y: number, z: number, freq: number, oct: number, gain = 0.5): number {
  let amp = 1, f = freq, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * n(x * f, y * f, z * f);
    norm += amp; amp *= gain; f *= 2;
  }
  return sum / (norm || 1);
}

/** 脊状多重分形（0..1）：`1-|n|` 取脊 —— 这是"山成链"而不是"疙瘩"的来源。 */
function ridged3(n: Noise3, x: number, y: number, z: number, freq: number, oct: number): number {
  let amp = 1, f = freq, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * (1 - Math.abs(n(x * f, y * f, z * f)));
    norm += amp; amp *= 0.5; f *= 2.05;
  }
  return sum / (norm || 1);
}

/* ── 形态：局部（mapgen4）/ 星球（本文件）────────────────────────────────────
   用户 2026-10-16 选定「与现内核并存」⇒ 地图栏 / 工作室里多一个「形态」选择，
   两套内核共用同一份种子 / 档位 / 数量 / 「看的方式」。 */
export type MapForm = 'local' | 'planet';
export const MAP_FORMS: { id: MapForm; label: string; hint: string }[] = [
  { id: 'local', label: '局部', hint: '一片地区的地形：山峰成带、能手刷精修（但它是方图，贴不到球上）' },
  { id: 'planet', label: '星球', hint: '整颗星球（等距圆柱 2:1）：经度无缝、有两极与冰盖，能贴到球上看' },
];
export const DEFAULT_MAP_FORM: MapForm = 'local';

export function isMapForm(v: unknown): v is MapForm {
  return v === 'local' || v === 'planet';
}
export function mapFormOf(v: unknown): MapForm {
  return isMapForm(v) ? v : DEFAULT_MAP_FORM;
}
export function mapFormLabel(v: unknown): string {
  return (MAP_FORMS.find((f) => f.id === mapFormOf(v)) ?? MAP_FORMS[0]).label;
}

/* ── 参数 ───────────────────────────────────────────────────────────────────── */

/** 生成网格高（宽 = 2 倍 ⇒ 1536×768 ≈ 118 万格）。再高生成时间与缓存内存都成倍涨。 */
export const PLANET_H = 768;
/** 归一化时用的最高峰 / 最深海沟（km） */
export const MAX_ELEV_KM = 8.8;
export const MAX_DEPTH_KM = 8.5;
/** 等高线「自动淡出」的三档（位图像素）：线间距 ≤ MIN 最淡、≥ FULL 满强度、地板 FLOOR。
 *  与 `src/mapgen/vendor/render.ts` 里 frag_drape 的 2.0 / 7.0 / 0.18 保持同值。 */
const CONTOUR_FADE_MIN_PX = 2;
const CONTOUR_FADE_FULL_PX = 7;
const CONTOUR_FADE_FLOOR = 0.18;

/** 档位（与局部形态的三个名字**共用**：大陆 / 群岛 / 盘古 —— 界面上一份档位两种形态通用） */
const PRESETS = {
  continent: { landRatio: 0.34, mtn: 1.0, depth: 1.0 },
  archipelago: { landRatio: 0.21, mtn: 0.72, depth: 0.85 },
  pangaea: { landRatio: 0.46, mtn: 1.12, depth: 1.1 },
} as const;
export type PlanetStyle = keyof typeof PRESETS;
export const PLANET_STYLES: PlanetStyle[] = ['continent', 'archipelago', 'pangaea'];

export function isPlanetStyle(v: unknown): v is PlanetStyle {
  return v === 'continent' || v === 'archipelago' || v === 'pangaea';
}

/** 档位 + 创作者旋钮 → 本形态真正用到的四件套（陆地占比 / 山脊密度 / 河密度 / 海底起伏）
 *
 *  ⭐ 第一百三十二轮加 `seabed`：用户「给地图生成加上海底生成的功能，顺便匹配各个风格」。
 *  0 = 不生成水下起伏（只剩陆架 → 陆坡 → 深海盆的自然剖面，海面看起来仍是平的），
 *  4 = 洋中脊 / 海沟 / 海山链 / 深海丘陵都拉满；**默认 2（中等）** —— 老图没有这个字段时
 *  打开就有海底细节（用户拍板："默认中等起伏，想恢复平海把旋钮拉到 0"）。 */
export function planetSpec(style: string, spec?: MapgenSpecInput): { landRatio: number; ridges: number; rivers: number; seabed: number } {
  const p = PRESETS[(isPlanetStyle(style) ? style : 'continent') as PlanetStyle];
  const rawSeabed = Number(spec?.seabed ?? 2);
  return {
    landRatio: clamp(Number(spec?.landRatio ?? p.landRatio), 0.05, 0.8),
    ridges: clamp(Math.round(Number(spec?.ridges ?? 4)), 1, 8),
    rivers: clamp(Math.round(Number(spec?.rivers ?? 1)), 0, 4),
    seabed: clamp(Math.round(Number.isFinite(rawSeabed) ? rawSeabed : 2), 0, 4),
  };
}

/* ── 场 ─────────────────────────────────────────────────────────────────────── */

/** ⭐ 手绘剪影的老结构（第一百零八轮）：2 bit/格的掩膜，`bits` = base64。
 *  0 = 没画（交给生成器）、1 = 陆地、2 = 海洋。
 *  **第一百三十五轮起只用于读旧数据** —— 新数据走 `./proto.ts` 的五层原型；
 *  `planetFieldGen()` 两种都收（`decodeProtoInput()` 会把老剪影最近邻放大到 1024×512）。
 *  ⚠️ 与 `src/store/types.ts` 的 `MapMask` **结构相同**（那边不反向 import 这里，
 *  这里也不 import 数据层）⇒ 两边靠结构类型兼容。 */
export type SilhouetteMask = LegacyMaskStored;

export interface PlanetField {
  w: number; h: number;
  /** 每格海拔（km；海平面 = 0，水下为负）——球体顶点位移也用它 */
  elev: Float32Array;
  /** 陆地海拔归一化 0..1（水下 = 0）——上色分档用 */
  e01: Float32Array;
  land: Uint8Array;
  river: Uint8Array;
  lake: Uint8Array;
  /** 湿度 0..1（风带 × 距海） */
  moist: Float32Array;
  /** 年均温（℃；纬度递减 + 海拔递减） */
  temp: Float32Array;
  /** 汇流量（格数，画河与"最长河"用） */
  flow: Float32Array;
  style: string;
  spec: { landRatio: number; ridges: number; rivers: number; seabed: number };
  stats: TerrainStats;
}

/** 8 邻域连通分量（**经度环绕**、极点行按行首尾相连）。返回各分量大小（降序）。 */
function components(w: number, h: number, mask: Uint8Array): number[] {
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const out: number[] = [];
  for (let start = 0; start < n; start++) {
    if (seen[start] || !mask[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let size = 0;
    while (top) {
      const i = stack[--top];
      size++;
      const y = (i / w) | 0;
      const x = i - y * w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;      /* 极点之外没有行（纬向不环绕）*/
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = (x + dx + w) % w;        /* ⭐ 经度环绕 */
          const j = yy * w + xx;
          if (!seen[j] && mask[j]) { seen[j] = 1; stack[top++] = j; }
        }
      }
    }
    out.push(size);
  }
  return out.sort((a, b) => b - a);
}

/** 把小于 `minSize` 格的连通块从掩码里抹掉（噪声级的斑点，不是岛）。
 *  真机首跑：不清理时"岛"数到 74~99 个、大陆边缘全是毛刺 —— 面板上那一行就没信息量了。 */
function pruneSmall(w: number, h: number, mask: Uint8Array, minSize: number): number {
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const comp: number[] = [];
  let removed = 0;
  for (let start = 0; start < n; start++) {
    if (seen[start] || !mask[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    comp.length = 0;
    while (top) {
      const i = stack[--top];
      comp.push(i);
      const y = (i / w) | 0, x = i - y * w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const j = yy * w + ((x + dx + w) % w);
          if (!seen[j] && mask[j]) { seen[j] = 1; stack[top++] = j; }
        }
      }
    }
    if (comp.length < minSize) { for (const i of comp) mask[i] = 0; removed += comp.length; }
  }
  return removed;
}

/* ── 大陆核 / 山体核（2026-10-13 第九十九轮）──────────────────────────────────
   ⭐ 用户原话：「**大陆没有大陆的感觉**」（对照小森邻 OCity 的制图示例 —— 见
   `F:\knowledge-base\projects\world-map\OCITY-RECON.md`：他们那张图是 **1 块大而连续的
   陆块 + 4~5 座岛**，内部 **1~2 个主山体**，色带一圈圈退开）。
   旧版陆块 = fBm 的等值线 ⇒ 必然切出一堆**大小相近的碎块**（实测大陆档最大一块只占陆地
   两成多、"大陆"数出七八块），而且各向同性噪声**撒满全图**，看不出哪儿是"主峰"。
   现在改成**先放核**：
     · **大陆核** = 球面上一块陆地的"胚胎"（椭圆 + 方位角，`ra/rb` 是切平面上的正弦半径）；
       核**重叠就自动连成大陆**（`max` 融合）⇒ 少数大而连续的陆块；
     · **山体核** = 放在核内部（离核心一点距离）的 1~2 个主山体 ⇒ 同心色带的主峰；
     · 核外只有一点低频扰动 + 负基准 ⇒ 大洋连成一片，不会撒满小岛。
   核的个数/大小/方位、山体位置全部由种子推出来 ⇒ 同种子仍逐字节一致。 */
type V3 = [number, number, number];
interface Kernel { c: V3; e1: V3; e2: V3; ra: number; rb: number; amp: number }

/** 球面随机单位向量（纬度用 `2u−1` ⇒ 面积均匀，两极不会扎堆）。
 *  ⭐ 纬度**收在 ±66°以内**：等距圆柱投影下，极区一格经度只有赤道的 1/6 宽 ——
 *  一块极地陆地在图上会被拉成**横贯全图的条带**（真机首跑就是这样：顶上一条细丝、
 *  底下一条大抹痕），像 bug 不像大陆。核不往极区放，再加 `POLAR_LAT` 那道收口。 */
function randDir(rnd: () => number): V3 {
  const z = 0.913 * (2 * rnd() - 1), phi = 2 * Math.PI * rnd(), r = Math.sqrt(Math.max(0, 1 - z * z));
  return [r * Math.cos(phi), r * Math.sin(phi), z];
}

/** 极区收口：`|lat| ≥ 72°` 一律海洋、58°~72° 之间渐隐（开放极海 ⇒ 没有拉伸条带）。
 *  ⚠️ 别拿余纬去减（第一版写成 `(90 − |lat| − 72)/14` ⇒ **|lat| ≥ 18° 就被收口**，
 *  83% 的星球被钉在同一个常数上；直方图求分位撞上这根尖峰 + float32 抖动 ⇒ 陆地占比 0.92）。 */
const POLAR_LAT = 72, POLAR_FADE = 14;
function polarTaper(lat: number): number {
  const t = (POLAR_LAT - Math.abs(lat)) / POLAR_FADE;
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

/** 以 `c` 为法向、方位角 `az` 的切平面正交基（椭圆的长轴方向由它定）*/
function basisOf(c: V3, az: number): [V3, V3] {
  const t: V3 = Math.abs(c[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let e1: V3 = [c[1] * t[2] - c[2] * t[1], c[2] * t[0] - c[0] * t[2], c[0] * t[1] - c[1] * t[0]];
  const il = 1 / (Math.hypot(e1[0], e1[1], e1[2]) || 1);
  e1 = [e1[0] * il, e1[1] * il, e1[2] * il];
  const e2: V3 = [c[1] * e1[2] - c[2] * e1[1], c[2] * e1[0] - c[0] * e1[2], c[0] * e1[1] - c[1] * e1[0]];
  const ca = Math.cos(az), sa = Math.sin(az);
  return [
    [e1[0] * ca + e2[0] * sa, e1[1] * ca + e2[1] * sa, e1[2] * ca + e2[2] * sa],
    [e2[0] * ca - e1[0] * sa, e2[1] * ca - e1[1] * sa, e2[2] * ca - e1[2] * sa],
  ];
}

/** 椭圆核的"角距比"：0 = 核心、1 = 核边界（**真球面角距** ⇒ 远侧半球不会被镜像）。
 *  ⚠️ 不能用切平面投影直接当距离：`u²+v² = sin²θ`，在**对跖点** θ=180° 时 `u=v=0`
 *  ⇒ 投影塌成 0 ⇒ 对跖点被当成核心正中心，每块陆地的背面又长出一块 ——
 *  真机实测陆地占比冲到 **0.98**（整颗星球连成一整块）。`d > 0` 这道闸就是治它的。 */
function kernelQ(x: number, y: number, z: number, k: Kernel): number {
  const d = x * k.c[0] + y * k.c[1] + z * k.c[2];
  if (d <= 0) return 2;                                   /* 远侧半球：算作外部 */
  const th = Math.acos(clamp(d, -1, 1));
  const u = x * k.e1[0] + y * k.e1[1] + z * k.e1[2];
  const v = x * k.e2[0] + y * k.e2[1] + z * k.e2[2];
  const st = Math.sqrt(Math.max(0, 1 - d * d));           /* = sinθ */
  if (st < 1e-6) return th / k.ra;                        /* 正对核心：方位无意义 */
  const a = u / st / k.ra, b = v / st / k.rb;             /* 该方位上的单位方向 ÷ 两个半径 */
  return th * Math.sqrt(a * a + b * b);                   /* θ / 该方位的椭圆半径 */
}

/** 三档的核排布（`sep` 是核之间的最小角距 —— 大于两个核的半径和就会**连成一块**）。
 *  ⚠️ 别把大陆档的核撒得太开：那样会得到 4 块各占一成多的小大陆，"没有大陆的感觉"
 *  正是这么来的。0.78 rad ≈ 45°、核半径 ≈ 0.55~0.80（≈ 33°~53°）⇒ 少数核**互相咬合**，
 *  出来是 2~4 块大小悬殊的陆块。 */
const CORE_PLAN: Record<PlanetStyle, {
  n: number; ra: [number, number]; sep: number;
  isl: number; islRa: [number, number]; islSep: number;
}> = {
  continent:   { n: 4,  ra: [0.60, 0.80], sep: 1.00, isl: 9,  islRa: [0.09, 0.17], islSep: 0.28 },
  archipelago: { n: 8,  ra: [0.26, 0.42], sep: 0.42, isl: 12, islRa: [0.07, 0.14], islSep: 0.22 },
  pangaea:     { n: 3,  ra: [0.78, 1.00], sep: 0.50, isl: 4,  islRa: [0.12, 0.20], islSep: 0.36 },
};

/** ⭐ 海岸细节（第一百零七轮）：`shore` 场额外叠的高频档（freq, amp, octave）。
 *
 *  用户 2026-10-23：「陆地边缘还是看起来太顺滑了」。
 *  原来只有 2.15 / 6.5 两档（≈ 38px / 12px @512 宽）⇒ 海岸是"肥圆的波浪"，没有礁石与细碎岬角。
 *  这里补 12 / 24 / 48 三档。**幅度是实测标定的，不是拍的**：`fbm3` 归一化后实际幅度只有
 *  名义值的 ~1/4，而 `raw` 沿海的梯度很陡（约 4 / 单位球）⇒ 名义 0.03 只挪半像素。
 *  `.review/planet-coast-png.mjs` 逐档离线出图 + 量 `landDiff`：0.30/0.14/0.06 ≈ 2% 陆地像素翻转（"有点碎"），
 *  0.55/0.26/0.12 ≈ 4%（碎到出现成片小潟湖）。取中间那一档，海岸碎度（岸线格 ÷ 陆地格 @256）约翻 2.5 倍。
 *  球面坐标采样 ⇒ 经度接缝天然连续；`pruneSmall` 会把碎成几格的小岛还给海。 */
export const COAST_SHORE_TERMS: { freq: number; amp: number; oct: number }[] = [
  { freq: 12, amp: 0.42, oct: 3 },
  { freq: 24, amp: 0.20, oct: 3 },
  { freq: 48, amp: 0.09, oct: 2 },
];

/** 把 `COAST_SHORE_TERMS` 叠成 shore 场的高频尾巴（缺省两档；扫参脚本会改它）。 */
function coastShoreDetail(n: Noise3, x: number, y: number, z: number): number {
  let s = 0;
  for (let q = 0; q < COAST_SHORE_TERMS.length; q++) {
    const tr = COAST_SHORE_TERMS[q];
    s += fbm3(n, x, y, z, tr.freq, tr.oct) * tr.amp;
  }
  return s;
}

/** 撒核：大陆核（amp 1）+ 岛核（amp 乘 0.44 ⇒ 又矮又小）*/
function placeCores(rnd: () => number, style: string): Kernel[] {
  const p = CORE_PLAN[(isPlanetStyle(style) ? style : 'continent') as PlanetStyle];
  const out: Kernel[] = [];
  const add = (count: number, raMin: number, raMax: number, amp: number, sep: number) => {
    for (let tries = 0, made = 0; made < count && tries < count * 80; tries++) {
      const c = randDir(rnd);
      let ok = true;
      for (const k of out) {
        if (c[0] * k.c[0] + c[1] * k.c[1] + c[2] * k.c[2] > Math.cos(sep)) { ok = false; break; }
      }
      if (!ok) continue;
      const ra = raMin + (raMax - raMin) * rnd();
      const [e1, e2] = basisOf(c, rnd() * Math.PI);
      out.push({ c, e1, e2, ra, rb: ra * (0.58 + 0.42 * rnd()), amp });
      made++;
    }
  };
  add(p.n, p.ra[0], p.ra[1], 1, p.sep);
  add(p.isl, p.islRa[0], p.islRa[1], 0.44, p.islSep);
  return out;
}

/** 每个核里放 1~2 个主山体（离核心一点距离 ⇒ 山体不在正中心、大陆看起来才有"重心"）*/
function placeMassifs(rnd: () => number, cores: Kernel[], ridges: number): Kernel[] {
  const out: Kernel[] = [];
  for (const k of cores) {
    const island = k.amp < 0.7;
    const cnt = island ? 1 : (rnd() < 0.6 ? 2 : 1);
    for (let i = 0; i < cnt; i++) {
      const d = k.ra * (0.06 + 0.42 * rnd());
      const [t1] = basisOf(k.c, rnd() * Math.PI);
      const c: V3 = [k.c[0] + t1[0] * d, k.c[1] + t1[1] * d, k.c[2] + t1[2] * d];
      const il = 1 / (Math.hypot(c[0], c[1], c[2]) || 1);
      const cc: V3 = [c[0] * il, c[1] * il, c[2] * il];
      const ra = k.ra * (island ? 0.55 : 0.34 + 0.20 * rnd());
      const [e1, e2] = basisOf(cc, rnd() * Math.PI);
      out.push({
        c: cc, e1, e2, ra, rb: ra * (0.50 + 0.45 * rnd()),
        amp: (island ? 0.50 : 0.82) * (0.86 + 0.035 * ridges + 0.18 * rnd()),
      });
    }
  }
  return out;
}

/** 分帧进度的统一形状（`planetFieldGen` / `renderPlanetGen` 都吐这个）。
 *  用户 2026-10-23：「给加载做一点提示，不然别人以为会卡了」——
 *  这两种计算各要 1.4s / 0.5s，整段同步跑的话连"正在算"都画不出来。 */
export interface PlanetProgress {
  phase: string;
  done: number;
  total: number;
}

/** 双线性取样（四个角 + 预乘权重）。原型的六个效果场共用同一组下标/权重 ⇒ 只算一次。 */
function bilin(arr: Float32Array, a0: number, a1: number, x0: number, x1: number,
  w00: number, w10: number, w01: number, w11: number): number {
  return arr[a0 + x0] * w00 + arr[a0 + x1] * w10 + arr[a1 + x0] * w01 + arr[a1 + x1] * w11;
}

/** 可分离盒式模糊（x 环绕、y 夹边）—— 让画出来的分区边界是**坡**而不是"一格台阶"。
 *  ⚠️ 只模糊"效果场"（抬升/山脊/压平/气候/噪声/边缘），**不模糊海陆**：
 *  海陆靠双线性已经够平滑，多模糊一次会把没画的地方也染上 0.5 ⇒ 阈值附近乱翻。 */
function boxBlur(src: Float32Array, w: number, h: number, r: number): void {
  if (r <= 0 || w <= 0 || h <= 0) return;
  const tmp = new Float32Array(src.length);
  const span = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += src[row + ((x + d + w) % w)];
      tmp[row + x] = s / span;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let d = -r; d <= r; d++) {
        const yy = y + d < 0 ? 0 : (y + d >= h ? h - 1 : y + d);
        s += tmp[yy * w + x];
      }
      src[y * w + x] = s / span;
    }
  }
}

/** **生成一颗星球**（生成器版：同参数逐字节同结果，只是把工作切成一小片一小片）。
 *
 *  ⚠️ 这是**唯一实现**：`buildPlanetField()` 只是把它一口气跑完的同步外壳
 *  （守卫 / 离线脚本 / 预览用）；界面走 `drivePlanetField()`（`src/ui/planet-view.ts`），
 *  每片之间让出一帧，遮罩与进度条才画得出来。
 *  切点只放在**阶段边界**与**行循环**上：所有跨阶段的中间量都是局部变量，天然连续。 */
export function* planetFieldGen(seed: string, style: string, spec?: MapgenSpecInput, h: number = PLANET_H, protoIn?: ProtoInput | null): Generator<PlanetProgress, PlanetField, void> {
  const sp = planetSpec(style, spec);
  const w = h * 2;
  const n = w * h;
  /* 五个噪声"域"分开（照局部内核的规矩）：同一颗种子下各层互不相关 */
  const nC = createNoise3D(mulberry32(seedInt(String(seed) + '|大陆')));
  const nP = createNoise3D(mulberry32(seedInt(String(seed) + '|分区')));
  const nM = createNoise3D(mulberry32(seedInt(String(seed) + '|山脉')));
  const nD = createNoise3D(mulberry32(seedInt(String(seed) + '|细节')));
  const nW = createNoise3D(mulberry32(seedInt(String(seed) + '|湿度')));
  /* ⭐ 第一百三十二轮：海底两个独立噪声域（与陆地那五个互不相关，同种子仍确定）：
     · nB  —— 低频「陆缘活动度」：高的那半边陆架窄、外缘有海沟（活动陆缘），
              低的那半边陆架宽、没有海沟（被动陆缘）—— 真地图上这圈宽窄差别很大；
     · nBR —— 脊状噪声：洋中脊的脊线、海山的孤立峰、深海丘陵的碎起伏都从它来。 */
  const nB = createNoise3D(mulberry32(seedInt(String(seed) + '|海底')));
  const nBR = createNoise3D(mulberry32(seedInt(String(seed) + '|海底脊')));

  /* 陆核 / 山体核（各自的随机流：与上面五个噪声域互不相关，同种子仍确定） */
  const cores = placeCores(mulberry32(seedInt(String(seed) + '|陆核')), style);
  const mounts = placeMassifs(mulberry32(seedInt(String(seed) + '|山体')), cores, sp.ridges);
  yield { phase: '撒陆核与山体', done: 0, total: 1 };

  /* ⭐ 第一百零八轮（手绘海陆剪影）→ 第一百三十五轮（多图层原型）：
     原型**优先于**噪声 —— 画过的地方直接钉死海陆（见下面 `forced[]` 的用法），
     没画的地方照旧由大陆场决定 ⇒「只在东半球画一块大陆」这种用法照样成立。

     原型有 **五层**（`src/mapgen/proto.ts`）：
       land   —— 海陆（0 未画 / 1 陆 / 2 海，靠双线性 + shore 噪声定边界，不是硬阈值方块）
       zone   —— 地形分区（高山 / 丘陵 / 高原 / 盆地 / 湖泊内海）⇒ 改**海拔形状**
       climate—— 气候底子（沙地 / 湿地）⇒ 只改湿度（上色/植被）
       noise  —— 区域噪声（有符号 −8..8）⇒ 乘在起伏上：正 = 更碎、负 = 更平
       edge   —— 海岸复杂化（0..8）⇒ 放大海岸线的抖动幅度
     六张"效果场"先在同一分辨率上铺好、模糊一圈（盒式），再双线性取样到输出网格
     —— 否则手画的边界在成图上是一格一格的台阶。 */
  const proto = decodeProtoInput(protoIn);
  const mw0 = proto ? proto.w : 0;
  const mh0 = proto ? proto.h : 0;
  const maskLand = proto ? new Float32Array(mw0 * mh0) : null;
  const maskSea = proto ? new Float32Array(mw0 * mh0) : null;
  const zRaise = proto ? new Float32Array(mw0 * mh0) : null;   /* 基面抬升 */
  const zRidge = proto ? new Float32Array(mw0 * mh0) : null;   /* 山脊放大 */
  const zFlat = proto ? new Float32Array(mw0 * mh0) : null;    /* 起伏压平 */
  const climF = proto ? new Float32Array(mw0 * mh0) : null;    /* −1 干 / +1 湿 */
  const noiseF = proto ? new Float32Array(mw0 * mh0) : null;   /* −1..1 有符号噪声 */
  const edgeF = proto ? new Float32Array(mw0 * mh0) : null;    /* 0..1 海岸复杂化 */
  if (proto && maskLand && maskSea && zRaise && zRidge && zFlat && climF && noiseF && edgeF) {
    for (let i = 0; i < proto.land.length; i++) {
      const zn = proto.zone[i];
      const lv = proto.land[i];
      /* 湖泊/内海笔刷 = 直接钉成水（比海陆层更具体 ⇒ 它说了算）。
         它不会变成"海"：深度按离岸距离算（离陆地越近越浅）⇒ 内陆那片是浅水湖。 */
      if (zn === ZONE_LAKE) maskSea[i] = 1;
      else if (lv === LAND_SET) maskLand[i] = 1;
      else if (lv === SEA_SET) maskSea[i] = 1;
      if (zn === ZONE_MOUNTAIN) { zRidge[i] = 1; zRaise[i] = 0.34; }
      else if (zn === ZONE_HILL) { zRidge[i] = 0.38; zRaise[i] = 0.07; }
      else if (zn === ZONE_PLATEAU) { zRaise[i] = 0.26; zFlat[i] = 1; }
      else if (zn === ZONE_BASIN) { zRaise[i] = -0.32; zFlat[i] = 0.5; }
      const cl = proto.climate[i];
      if (cl === CLIMATE_DRY) climF[i] = -1;
      else if (cl === CLIMATE_WET) climF[i] = 1;
      noiseF[i] = proto.noise[i] / NOISE_MAX;
      edgeF[i] = proto.edge[i] / EDGE_MAX;
    }
    /* 模糊半径按原型宽度缩放（1024 → 3 格，底图上约 4.5px）：够把直边化成坡，
       又不会把"一条山脉"糊成一片。 */
    const r = Math.max(1, Math.round(mw0 / 340));
    for (const f of [zRaise, zRidge, zFlat, climF, noiseF, edgeF]) boxBlur(f, mw0, mh0, r);
  }
  /* 剪影边缘要自然，不能一格一格地楼梯（第一版最近邻就是这样，和海岸细节的成果打架）：
     · 掩膜 → 两张 0/1 场（陆地 / 海洋），双线性采样 ⇒ 边界是斜的、不平；
     · 再叠一层已有的 shore 多尺度噪声做抖动 ⇒ 边缘像自然海岸而不是手绘色块；
     · 阈值 0.5 定海陆：一边过半就是它，两边都不过半 = 没画（交给生成器）。
     预先把列/行 → 原型格 + 权重算好（两万多次除法不该放在逐像素路径上）。 */
  const maskX0 = proto ? new Int32Array(w) : null;
  const maskX1 = proto ? new Int32Array(w) : null;
  const maskXF = proto ? new Float32Array(w) : null;
  const maskY0 = proto ? new Int32Array(h) : null;
  const maskY1 = proto ? new Int32Array(h) : null;
  const maskYF = proto ? new Float32Array(h) : null;
  if (proto && maskX0 && maskX1 && maskXF && maskY0 && maskY1 && maskYF) {
    const axis = (count: number, cells: number, i0: Int32Array, i1: Int32Array, fr: Float32Array) => {
      for (let k = 0; k < count; k++) {
        const f = (k + 0.5) * cells / count - 0.5;
        const base = Math.floor(f);
        fr[k] = f - base;
        i0[k] = Math.min(cells - 1, Math.max(0, base));
        i1[k] = Math.min(cells - 1, Math.max(0, base + 1));
      }
    };
    axis(w, mw0, maskX0, maskX1, maskXF);
    axis(h, mh0, maskY0, maskY1, maskYF);
  }
  /** 双线性取样一张原型效果场（箱外 = 0）。闭包只建一次；热循环里调 1~6 次。 */
  const sampleField = (arr: Float32Array, j: number, i: number): number => {
    if (!maskX0 || !maskX1 || !maskXF || !maskY0 || !maskY1 || !maskYF) return 0;
    const fx = maskXF[j], fy = maskYF[i];
    const a0 = maskY0[i] * mw0, a1 = maskY1[i] * mw0;
    const x0 = maskX0[j], x1 = maskX1[j];
    return (arr[a0 + x0] * (1 - fx) + arr[a0 + x1] * fx) * (1 - fy)
      + (arr[a1 + x0] * (1 - fx) + arr[a1 + x1] * fx) * fy;
  };
  /** 0 = 没画（自由）、1 = 钉成陆地、2 = 钉成海洋 */
  const forced = proto ? new Uint8Array(n) : null;
  /** 每格的气候权重（−1 干 / +1 湿）—— 湿度那一趟要用，顺手在同一趟里存下来 */
  const climateAt = proto ? new Float32Array(n) : null;

  const mtnAmp = 0.5 + sp.ridges * 0.16;          /* ridges 1..8 → 0.66 .. 1.78 */
  const ridgeFreq = 2.0 + sp.ridges * 0.18;
  /* 域扭曲幅度：**别贪大**。0.30 那版真机出图是"细长漩涡 + 内海成片"，像虫形不像大陆
     （fBm 的等值线本来就偏蠕虫）；0.18 保住有机感又不把大陆撕碎。 */
  const warpAmp = 0.18;

  const raw = new Float32Array(n);       /* 大陆度：**只决定海陆**（不参与高度）*/
  const hraw = new Float32Array(n);      /* 陆地起伏场：底 + 分区基准 + 板缘山带 + 细节 */
  const deta = new Float32Array(n);      /* 细节颗粒（海底起伏也借它一点）*/
  /* ⭐ 第一百三十二轮：板缘带（`band` = 主板缘噪声的零交叉带）。陆地拿它造山，
     海底拿它放**洋中脊** —— 板块边界在海里就是隆起，两张图因此读得出同一套构造。 */
  const plateBand = new Float32Array(n);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < h; i++) {
    const lat = 90 - (i + 0.5) * 180 / h;
    const cl = Math.cos(lat * D2R), sl = Math.sin(lat * D2R);
    for (let j = 0; j < w; j++) {
      const lon = -180 + (j + 0.5) * 360 / w;
      /* 单位球上的点 —— 经度在这里被"卷"起来，所以接缝根本不存在 */
      let x = cl * Math.cos(lon * D2R), y = cl * Math.sin(lon * D2R), z = sl;

      /* 域扭曲：先把采样点推一下（**推完重新归一化** ⇒ 仍旧落在单位球上，不会破球面对称）。
         这一步是"像不像自然地形"的分界：没有它，fBm 的团块一眼就看得出是噪声。 */
      const wx = nW(x * 2.4 + 13.1, y * 2.4 + 7.7, z * 2.4 + 3.3);
      const wy = nW(x * 2.4 + 41.7, y * 2.4 + 29.3, z * 2.4 + 11.1);
      const wz = nW(x * 2.4 + 77.1, y * 2.4 + 53.9, z * 2.4 + 19.7);
      const px = x + wx * warpAmp, py = y + wy * warpAmp, pz = z + wz * warpAmp;
      const inv = 1 / (Math.sqrt(px * px + py * py + pz * pz) || 1);
      x = px * inv; y = py * inv; z = pz * inv;

      /* ① 陆块：**核的高度场取最大** —— 核重叠就自动连成大陆（这是"少数大而连续的陆块"
         与"一堆碎块"的分界）。`1−q²` 是连续抛物线（核外自然为负），阈值一动就是一圈圈
         缩放的椭圆 ⇒ 海岸永远平滑、不会切出碎块。 */
      let cw = -10;
      for (let q = 0; q < cores.length; q++) {
        const kv = cores[q].amp * (1 - kernelQ(x, y, z, cores[q]) ** 2);
        if (kv > cw) cw = kv;
      }
      /* 海岸的"湾岬"：**两档**扰动加在陆块场上（低频 2.15 给大尺度湾岬，中频 6.5 给小半岛 /
         小海湾）。只有低频时海岸是"肥圆的波浪"，一眼就看得出底下是个椭圆核。
         末尾乘 `polarTaper`：极区收成海（否则极地陆地在等距圆柱下会拉成横贯全图的条带）。 */
      const shore = fbm3(nC, x, y, z, 2.15, 2) * 0.13 + fbm3(nC, x, y, z, 6.5, 2) * 0.032
        + coastShoreDetail(nC, x, y, z);
      /* 极区收口：`pt=1` 原样；`pt=0` 压到 −1.1 附近。⭐ ① 扰动 `shore` 放在**收口外面**
         —— 若写成乘进去，极区那 2% 的格子会取到同一个常数，直方图求分位就废了；
         ② 地板要**足够低**：盘古档海平面能低到 −0.68，地板只给 −0.75 的话
         `shore` 的 +0.18 会把极区顶回海平面以上（实测极区仍有 7.4% 陆地点）。 */
      const pt = polarTaper(lat);
      const c = cw * pt + shore - (1 - pt) * 1.1;
      /* ② 板缘带：低频场的零交叉线 ⇒ 山系成"带/链"，不是满地疙瘩 */
      const pl = fbm3(nM, x, y, z, 1.05, 2);
      const band = Math.max(0, 1 - Math.abs(pl) / 0.16);
      /* ③ 脊状噪声（山脊本身） */
      const rg = Math.pow(ridged3(nM, x, y, z, ridgeFreq, 4), 1.6);
      /* ④ 分区：每区自己的基准高度与起伏（高原 / 丘陵 / 平原 —— 用户要的"随机分区"） */
      const prov = fbm3(nP, x, y, z, 2.2, 3) * 0.5 + 0.5;
      const provRelief = 0.55 + 0.9 * prov;
      /* ⑤ 细节颗粒：两档频率 —— 中频给"丘陵/沟谷"，高频给"别像塑料"的表面质感。
         ⚠️ 2026-10-13 试过再加一档 freq 48 的高频：**看着更"细"，但代价太大** ——
         高频抖动在高度场上造出成千上万个比格子还小的洼地，汇流被切成几格就断的短沟
         （渲染出来是一片蓝色抓痕），等高线也跟着发毛。细颗粒留给「看的方式」去表现。 */
      const det = fbm3(nD, x, y, z, 8, 3);
      const fine = fbm3(nD, x, y, z, 22, 2);

      /* ⑤ 主山体：每个核里那 1~2 个 —— **这一条是"有没有主峰"的分界**。旧版只有各向同性
         的板缘带噪声，山是撒满全图的疙瘩 ⇒ 没有重心、色带乱、看着不像大陆。 */
      let mf = 0;
      for (let q = 0; q < mounts.length; q++) {
        const mq = kernelQ(x, y, z, mounts[q]);
        if (mq >= 1) continue;
        mf += mounts[q].amp * Math.pow(1 - mq, 1.35);
      }

      const kk = i * w + j;
      raw[kk] = c;
      /* ⭐ 原型取样（第一百三十五轮）：六个效果场共用一组双线性权重。
         没画原型时这六个量都是 0，下面那几行就退化成原来的公式。 */
      let zr = 0, zg = 0, zf = 0, clw = 0, nz = 0, eg = 0;
      if (forced && maskLand && maskSea && zRaise && zRidge && zFlat && climF && noiseF && edgeF
        && maskX0 && maskX1 && maskXF && maskY0 && maskY1 && maskYF) {
        const x0 = maskX0[j], x1 = maskX1[j], y0 = maskY0[i], y1 = maskY1[i];
        const fx = maskXF[j], fy = maskYF[i];
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        const a0 = y0 * mw0, a1 = y1 * mw0;
        eg = bilin(edgeF, a0, a1, x0, x1, w00, w10, w01, w11);
        /* 海岸抖动：原来固定 0.6（"把直边打毛"就够了）；「边缘复杂化」笔刷把它放大到 ~2.8 倍。
           仍是同一层 `shore` 噪声（含 12/24/48 三档高频尾巴）⇒ 不额外算噪声。 */
        const wig = shore * (0.6 + 1.8 * eg);
        const lf = bilin(maskLand, a0, a1, x0, x1, w00, w10, w01, w11);
        const sf = bilin(maskSea, a0, a1, x0, x1, w00, w10, w01, w11);
        forced[kk] = (lf + wig > 0.5) ? 1 : ((sf - wig > 0.5) ? 2 : 0);
        zr = bilin(zRaise, a0, a1, x0, x1, w00, w10, w01, w11);
        zg = bilin(zRidge, a0, a1, x0, x1, w00, w10, w01, w11);
        zf = bilin(zFlat, a0, a1, x0, x1, w00, w10, w01, w11);
        clw = bilin(climF, a0, a1, x0, x1, w00, w10, w01, w11);
        nz = bilin(noiseF, a0, a1, x0, x1, w00, w10, w01, w11);
        if (climateAt) climateAt[kk] = clw;
      }
      /* ⭐ 高度**另起一套场**：陆块场只决定海陆（它的等值线就是海岸线），高度是
         "底 + 分区基准 + **主山体** + 山脊 + 板缘山带 + 细节"。主山体 `mf` 是绝对主角，
         板缘带 `band` 降到配角 —— 旧版只有板缘带，山是撒满全图的疙瘩、没有主峰。
         海岸那圈仍由下面的**沿海压低**处理（dist 越近越矮 ⇒ 海岸平原 + 内陆抬升）。

         ⭐ 第一百三十五轮：手绘的"地形预设"作为**乘法**作用在起伏项上（加一个常数只会
         得到一块台地，不是山）：高山 = 山脊 ×1.62 + 基面 0.26；高原 = 基面 0.34、起伏压到
         0.45/0.12（顶面平）；盆地 = 基面 −0.32、起伏再压一半；噪声正负 = 起伏 ×(1+nz·0.45)、
         细节 ×(1+nz·0.9)（加噪更碎、抹平更干净）。 */
      const baseH = 0.14 + (prov - 0.5) * 0.34 + zr;
      const massifH = mf * (0.82 + 0.42 * provRelief);
      const ridgeH = mf * rg * mtnAmp * 0.42 + mtnAmp * rg * band * provRelief * 0.20;
      const detailH = det * 0.075 + fine * 0.05;
      /* 乘法因子一律夹正：抹平笔刷把系数压到 0 附近就够"平"了，压成负数会把山脊翻成沟 */
      const ridgeScale = Math.max(0.06, 1 + zg * 0.75 - zf * 0.55 + nz * 1.1);
      const detailScale = Math.max(0.04, 1 - zf * 0.88 + nz * 1.4);
      hraw[kk] = baseH + massifH
        + ridgeH * ridgeScale
        + detailH * detailScale
        + nz * (det * 0.16 + (rg - 0.5) * 0.22);
      deta[kk] = det;
      plateBand[kk] = band;
      if (c < lo) lo = c;
      if (c > hi) hi = c;
    }
    /* 分帧：每 16 行让出一次（实测这一趟占首次生成的六成 ⇒ 单片约 8~10ms）*/
    if ((i & 15) === 15 || i === h - 1) yield { phase: '地形起伏', done: i + 1, total: h };
  }

  /* 海平面 = **分位数**（要 34% 陆地就取 66% 分位那个高度）：占比是精确命中的，不是碰运气。
     直方图求分位（2048 桶）比全排序快一个量级，误差 ~0.05% 足够。 */
  const BUCKETS = 2048;
  const hist = new Int32Array(BUCKETS);
  const span = (hi - lo) || 1;
  for (let k = 0; k < n; k++) {
    const b = clamp(((raw[k] - lo) / span * (BUCKETS - 1)) | 0, 0, BUCKETS - 1);
    hist[b]++;
  }
  const wantLand = Math.round(sp.landRatio * n);
  let acc = 0, sea = hi;
  for (let b = 0; b < BUCKETS; b++) {
    acc += hist[b];
    if (acc >= n - wantLand) { sea = lo + (b / (BUCKETS - 1)) * span; break; }
  }
  yield { phase: '定海平面', done: 1, total: 1 };

  const elev = new Float32Array(n);
  const e01 = new Float32Array(n);
  const land = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (raw[k] > sea) land[k] = 1;
  /* 碎块清理：小于约 10 格的陆块还给海（噪声斑点，不是岛）。**必须在下游各 pass 之前做**
     —— 距离海 / 高度 / 汇流 / 温度 / 统计就都跑在同一张干净的陆地掩膜上。 */
  pruneSmall(w, h, land, Math.max(4, Math.round(n * 0.00002)));
  /* ⭐ 第一百零八轮：剪影优先 —— 在 `pruneSmall` **之后**再盖一遍，否则手画的小岛会被当噪声清掉。
     代价：陆地占比不再精确等于 `landRatio`（剪影说了算），这是用户画的意图，不是 bug。 */
  if (forced) {
    let changed = 0;
    for (let k = 0; k < n; k++) {
      const fv = forced[k];
      if (fv === 1) { if (!land[k]) { land[k] = 1; changed++; } }
      else if (fv === 2) { if (land[k]) { land[k] = 0; changed++; } }
    }
    if (changed) yield { phase: '按剪影定海陆', done: 1, total: 1 };
  }

  /* ── 距海（多源 BFS；经度环绕）——**必须在高度之前算**：
     陆地高度乘它做"沿海压低"（海岸是低地、越高越往里）。
     ⚠️ 海底**不能**用它：这个场里海格恒为 0（它量的就是"离海多远"），见下面 `seaDist`。 */
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let k = 0; k < n; k++) if (!land[k]) { dist[k] = 0; queue[tail++] = k; }
  while (head < tail) {
    const i = queue[head++];
    if ((head & 0x7fff) === 0) yield { phase: '算离海距离', done: head, total: n };
    const y = (i / w) | 0, x = i - y * w;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const j = yy * w + ((x + dx + w) % w);
        if (dist[j] < 0) { dist[j] = dist[i] + 1; queue[tail++] = j; }
      }
    }
  }

  /* ── 离陆地距离（只给海底用；经度环绕）——**必须另算一张**：
     上面那个 `dist` 是"离海距离"（海格恒为 0，越往内陆越大），拿它铺海底会把**每一格海**
     都算成 `t = 0` ⇒ 整片海同一个深度（第一百三十二轮第一版实测：海深全是 0.12 km、
     标准差 0，海底等于没生成）。海底要的是"离岸边多远"，所以从**陆地**出发做 BFS。 */
  const seaDist = new Int32Array(n).fill(-1);
  {
    let head2 = 0, tail2 = 0;
    for (let k = 0; k < n; k++) if (land[k]) { seaDist[k] = 0; queue[tail2++] = k; }
    while (head2 < tail2) {
      const i = queue[head2++];
      if ((head2 & 0x7fff) === 0) yield { phase: '算离陆距离', done: head2, total: n };
      const y = (i / w) | 0, x = i - y * w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const j = yy * w + ((x + dx + w) % w);
          if (seaDist[j] < 0) { seaDist[j] = seaDist[i] + 1; queue[tail2++] = j; }
        }
      }
    }
  }

  /* ── 高度 ───────────────────────────────────────────────────────────────── */
  const preset = PRESETS[(isPlanetStyle(style) ? style : 'continent') as PlanetStyle];
  /* 峰高跟"山脊密度"走（1 → 4.1 km、4 → 6.2 km、8 → 9.0 km）：归一化到固定 8.8 km 的话
     "最高峰"永远是一个常数，面板上那一行就没信息量了。 */
  const peakKm = clamp(3.4 + sp.ridges * 0.7, 3.4, 9.4);
  const maxDepthKm = MAX_DEPTH_KM * preset.depth;
  let maxH = 0;
  for (let k = 0; k < n; k++) {
    if (!land[k]) continue;
    /* 沿海压低：最靠海的 3 圈压到 22%~100%（⇒ 海岸平原 → 内陆抬升，而不是"遍地一样高"）*/
    const taper = 0.22 + 0.78 * clamp(Math.min(dist[k], 3) / 3, 0, 1);
    hraw[k] *= taper;
    /* 盆地/抹平笔刷可能把 hraw 压到负数 ⇒ 夹一个地板（陆地格必须在海平面以上） */
    if (hraw[k] < 0.02) hraw[k] = 0.02;
    if (hraw[k] > maxH) maxH = hraw[k];
  }
  const hInv = 1 / (maxH || 1);
  for (let k = 0; k < n; k++) {
    if (!land[k]) continue;
    const t = clamp(hraw[k] * hInv, 0, 1);
    elev[k] = Math.pow(t, 1.15) * peakKm;
    e01[k] = t;
  }
  yield { phase: '铺海底与陆地高度', done: 1, total: 1 };

  /* ── 海底（第一百三十二轮）──────────────────────────────────────────────────
     用户 2026-10-25：「给地图生成加上海底生成的功能，顺便匹配各个风格」。
     以前海里只有一条 `dist/9` 的深度坡 + 一点噪声起伏 ⇒ 渲染出来就是**一片平的蓝色渐变**
     （最多深浅不同），既没有洋中脊也没有海沟，九个风格也只能换"海是什么颜色"。

     现在按真实洋底的**四层结构**生成（全部在单位球上取 3D 噪声 ⇒ 经度无缝、极点收敛，
     与大陆场同一套规矩）：
       ① 陆架：宽度 3.8~10.4 格，**活动陆缘窄、被动陆缘宽**（`active` 低频场决定）；
       ② 陆坡：陆架外缘陡降，`sstep` 两段过渡到深海盆；
       ③ 深海盆：大尺度起伏 + 深海丘陵（`deta` 与脊状噪声的低幅碎起伏）；
       ④ 构造地形：**洋中脊**长在板块边界（`plateBand`，与陆地造山是同一套板缘带）、
          **海沟**出现在活动陆缘的陆坡外侧（窄带 + 脊状噪声打断）、**海山**是脊状噪声的孤立高锋。
     所有起伏都乘 `sbAmp = seabed/4`：0 ⇒ 只剩 ①②③ 的自然剖面（真正的"平海"），
     4 ⇒ 构造地形拉满。**海底一律不许冒出水面**（`Math.min(depth*k, lift)` 上限 + 软地板），
     否则 `land[]` 与高度场会互相矛盾（渲染/汇流/统计全得跟着坏）。 */
  const sbAmp = clamp(sp.seabed / 4, 0, 1);
  const maxCap = maxDepthKm * 1.35;
  for (let i = 0; i < h; i++) {
    const lat = 90 - (i + 0.5) * 180 / h;
    const cl = Math.cos(lat * D2R), sl = Math.sin(lat * D2R);
    for (let j = 0; j < w; j++) {
      const k = i * w + j;
      if (land[k]) continue;
      const lon = -180 + (j + 0.5) * 360 / w;
      const x = cl * Math.cos(lon * D2R), y = cl * Math.sin(lon * D2R), z = sl;

      /* ① 陆缘活动度 0..1（低频）：高的一侧陆架窄 + 有海沟，低的一侧陆架宽 + 无海沟 */
      const active = clamp(fbm3(nB, x, y, z, 1.9, 2) * 0.5 + 0.5, 0, 1);
      /* ② 脊状噪声 0..1（1 = 脊顶）：洋中脊的脊线 / 海山孤峰 / 深海丘陵都读它 */
      const crest = ridged3(nBR, x, y, z, 6.2, 3);
      const shelfLen = 10.4 - 6.6 * active;

      /* `t` = 离岸格数 ÷ 这片海的陆架宽度（1 = 陆架外缘、3 之后算深海盆）*/
      const t = seaDist[k] / shelfLen;
      let depth = 0.10 + 0.16 * Math.min(1, t)
        + 0.58 * maxDepthKm * sstep(1.0, 2.8, t)
        + 0.22 * maxDepthKm * sstep(2.4, 6.0, t);
      /* ③ 深海盆：大尺度分区起伏 + 深海丘陵（只在深水区，陆架上不要碎噪音） */
      const basinT = sstep(1.6, 4.5, t);
      depth += ((active - 0.5) * 0.9 + deta[k] * 0.26 + (crest - 0.5) * 0.24) * sbAmp * basinT;
      /* 深海盆先封顶：海沟必须**比海盆更深**，否则最深的地方永远是大片平底 */
      const basinCap = maxDepthKm * 0.90;
      if (depth > basinCap) depth = basinCap;

      /* ④a 洋中脊：板块边界（与陆地造山同一条 `plateBand`）在深水区隆起；
         抬升量有上限（不吃掉超过 45% 的水深）⇒ 洋中脊永远在海面以下 */
      if (sbAmp > 0) {
        const ridgeMask = Math.pow(clamp(plateBand[k], 0, 1), 1.35) * sstep(1.2, 3.2, t);
        if (ridgeMask > 0) {
          const lift = ridgeMask * (0.55 + 0.55 * crest) * 2.4 * sbAmp;
          depth -= Math.min(depth * 0.45, lift);
        }
      }
      /* ④b 海沟：活动陆缘的陆坡外侧一条窄带（`t` ∈ 约 0.85~3.4），
         往 `maxDepthKm * 1.16` 的目标深度**混合**（而不是直接加固定深度）——
         这样浅的陆坡外缘会挖出深沟、深的盆地不会无限加深。
         脊状噪声打断带状 ⇒ 读起来是"弧形的沟"，不是一条等深的槽。 */
      if (sbAmp > 0) {
        const trenchBelt = sstep(0.85, 1.25, t) * (1 - sstep(1.7, 3.4, t));
        const trenchAmt = sstep(0.42, 0.72, active) * trenchBelt * (0.55 + 0.45 * crest);
        if (trenchAmt > 0) {
          const target = maxDepthKm * 1.16;
          depth += (target - depth) * trenchAmt * sbAmp * 0.92;
        }
      }
      /* ④c 海山：脊状噪声的孤立高锋（只在深水、稀疏）；抬升量同样有上限 ⇒ 平顶海山 */
      if (sbAmp > 0) {
        const seamount = sstep(0.80, 0.94, crest) * (0.65 + 0.35 * (1 - active)) * sstep(1.8, 3.6, t);
        if (seamount > 0) depth -= Math.min(depth * 0.60, seamount * 2.6 * sbAmp);
      }
      /* ⭐ 区域噪声笔刷也作用到海底：加噪 ⇒ 起伏更碎（海山/沟谷变多），抹平 ⇒ 更平的深海盆。
         只在深海盆里生效（陆架/陆坡保持原来的自然剖面，否则浅滩会被噪声顶出水面）。 */
      if (noiseF) {
        const nzS = sampleField(noiseF, j, i);
        if (nzS) depth -= nzS * (crest - 0.5) * 1.2 * sstep(1.4, 3.0, t);
      }
      /* 软地板：万一算到水面附近，压回 100 m 以下（海底不许变成陆地）*/
      if (depth < 0.12) depth = 0.12 + (0.12 - depth) * 0.12;
      if (depth > maxCap) depth = maxCap;
      elev[k] = -depth;
    }
    if ((i & 15) === 15 || i === h - 1) yield { phase: '铺海底', done: i + 1, total: h };
  }

  const moist = new Float32Array(n);
  const temp = new Float32Array(n);
  for (let i = 0; i < h; i++) {
    const lat = 90 - (i + 0.5) * 180 / h;
    const alat = Math.abs(lat);
    /* 风带：赤道多雨（ITCZ）→ 副热带高压干（≈28°）→ 西风带湿（≈46°）→ 极地干（≈64°）。
       周期 36° 的余弦刚好压在这四个带上（不做真气候演算，只求"像"）。 */
    const wind = 0.5 + 0.5 * Math.cos((alat - 10) * Math.PI / 18);
    for (let j = 0; j < w; j++) {
      const k = i * w + j;
      const lat2 = lat * D2R;
      const dx = Math.cos(lat2), dsy = Math.sin(lat2);
      const nnn = nW(dx * 1.7 + 5.5, dsy * 1.7 + 9.9, lat / 90 * 1.7);
      const far = clamp(1 - dist[k] / 42, 0, 1);
      const alt = clamp(1 - Math.max(0, elev[k]) / 5.2, 0.25, 1);
      /* ⭐ 湿度（第一百零六轮修正）：以前几乎只看"离海多远" ⇒ 大陆内部一律干成荒漠，
         整颗星球是"黄心绿边"（真机截图一眼就假）。现在以**风带**为底（ITCZ 湿 / 副热带干 /
         西风带湿 / 极地干），离海远近只做 0.62→1.0 的微调，内陆也会按纬度分出雨林 / 草原 / 荒漠。 */
      const belt = 0.38 + 0.62 * wind;
      moist[k] = clamp((belt * (0.62 + 0.38 * far) + nnn * 0.16) * alt, 0, 1);
      /* ⭐ 气候底子笔刷（第一百三十五轮）：沙地 −1 / 湿地 +1，**只改湿度**
         ⇒ 改变植被上色与河网密度，不动海拔（用户要的是"底子"，不是又一层地形）。 */
      if (climateAt) {
        const cw = climateAt[k];
        if (cw) moist[k] = clamp(moist[k] + cw * 0.26, 0, 1);
      }
      /* 温度：纬度 + 海拔两条都算。⚠️ 系数调过：照 vision 那条口径的形（30 − 0.55×|纬度|、
         海拔 −6.5℃/km）会把 45° 上 800 m 的高地就冻成雪原 —— 真机出图"内陆成片惨白"
         就是这个来的。改成 32 − 0.45×|纬度|、−6.0℃/km ⇒ 45° 雪线约 2.5 km、赤道约 5.8 km，
         与真实地球同量级。 */
      temp[k] = 32 - 0.45 * alat - 6.0 * Math.max(0, elev[k]);
    }
    if ((i & 31) === 31 || i === h - 1) yield { phase: '算温度与湿度', done: i + 1, total: h };
  }

  /* ── 汇流 → 河 / 湖 ───────────────────────────────────────────────────────
     按高度**降序**把每个陆地格的水送给它最低的邻居（`flatqueue` 那类结构的桶排序版：
     高度分 4096 桶，从高到低扫）。水 = 基础 + 湿度（湿的地方水多）。 */
  const flow = new Float32Array(n);
  let landCount = 0;
  for (let k = 0; k < n; k++) if (land[k]) landCount++;
  /* ⚠️ 数组长度必须是**陆地格数**（不是 n）：给 n 的话尾部会留一大片 0，而 `order[q]` 读出来
     就是"0 号格" ⇒ 0 号格是陆地时它会被重复处理 ~35 万次、把下游流量灌成假高值
     （真机 `longestRiver` 冲到 810 就是这么来的）。 */
  const order = new Int32Array(landCount);
  {
    const B = 4096;
    const cnt = new Int32Array(B + 1);
    for (let k = 0; k < n; k++) {
      if (!land[k]) continue;
      const b = clamp((((elev[k] - 0) / MAX_ELEV_KM) * B) | 0, 0, B);
      cnt[b]++;
    }
    let sum = 0;
    for (let b = B; b >= 0; b--) { const c0 = cnt[b]; cnt[b] = sum; sum += c0; }
    for (let k = 0; k < n; k++) {
      if (!land[k]) continue;
      const b = clamp((((elev[k] - 0) / MAX_ELEV_KM) * B) | 0, 0, B);
      order[cnt[b]++] = k;
    }
  }
  yield { phase: '排高度序', done: 1, total: 1 };
  for (let k = 0; k < n; k++) if (land[k]) flow[k] = 0.35 + 0.65 * moist[k];
  /* `down[i]` = i 的下游格（−1 = 洼地，水出不去）；`basin[i]` = 有多少格的水汇进 i。
     两个都在这一趟里顺手攒出来 —— 湖的判定与"把河补成 4 连通"都要用（见下）。 */
  const down = new Int32Array(n).fill(-1);
  const basin = new Int32Array(n);
  for (let q = 0; q < order.length; q++) {
    const i = order[q];
    if ((q & 0x7fff) === 0) yield { phase: '算汇流', done: q, total: order.length || 1 };
    if (!land[i]) continue;
    const y = (i / w) | 0, x = i - y * w;
    let best = -1, bestH = elev[i];
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const j = yy * w + ((x + dx + w) % w);
        if (elev[j] < bestH) { bestH = elev[j]; best = j; }
      }
    }
    if (best >= 0) {
      flow[best] += flow[i];
      down[i] = best;
      basin[best] += basin[i] + 1;   /* 降序扫 ⇒ 处理 i 时 basin[i] 已经收全了上游 */
    }
  }

  /* 河：流量的分位数阈值（河越多 ⇒ 阈值越低）—— 与局部形态"河阈值自校准"同一个思路 */
  const river = new Uint8Array(n);
  const landFlow: number[] = [];
  for (let k = 0; k < n; k++) if (land[k]) landFlow.push(flow[k]);
  landFlow.sort((a, b) => b - a);
  /* 河网密度：`rivers 0..4` ⇒ 0.1% .. 0.58% 的**陆地格**。
     ⚠️ 2026-10-13 从 0.4%~2.4% 收下来：2.4% 在这个分辨率下是 9,600 格，
     画出来是铺满全陆地的蓝色短须（真机截图），而真地图上一颗星球也就几十条主河。 */
  const riverFraction = 0.001 + 0.0012 * sp.rivers;
  const thr = landFlow.length ? landFlow[Math.min(landFlow.length - 1, Math.floor(landFlow.length * riverFraction))] : Infinity;
  for (let k = 0; k < n; k++) if (land[k] && flow[k] >= thr && flow[k] > 1.5) river[k] = 1;
  /* ⭐ 把河补成 **4 连通**：最陡下降常常走对角格，1px 路径于是成了"只在角上相接"的阶梯 ——
     数据上是一条河，画出来却是一串断点（真机放大量到 28% 的河格只有对角邻居）。
     对角走一步时把两个拐角格一起点亮 ⇒ 2×2 的小块，看上去是连续的线（弯道处略粗，可接受）。 */
  for (let k = 0; k < n; k++) {
    if (!river[k]) continue;
    const d = down[k];
    if (d < 0 || !river[d]) continue;
    const y = (k / w) | 0, x = k - y * w;
    const yd = (d / w) | 0, xd = d - yd * w;
    if (xd === x || yd === y) continue;                 /* 正交走的一步：本来就 4 连通 */
    let dx = xd - x;
    if (dx > 1) dx = -1; else if (dx < -1) dx = 1;      /* 经度环绕 */
    const j1 = y * w + ((x + dx + w) % w);
    const j2 = yd * w + x;
    if (land[j1]) river[j1] = 1;
    if (land[j2]) river[j2] = 1;
  }
  yield { phase: '连通河道', done: 1, total: 1 };
  /* ⭐ 碎河清理（2026-10-13）：高度场里比格子还小的洼地会把汇流切成一堆**几格就断**的短沟，
     画出来不是河、是一片蓝色抓痕（用户「细节都不够」那一轮真机截图就是这样）。
     只留 ≥ `RIVER_MIN_CELLS` 格的河网；统计那边 `riverComps >= 12` 本来就是同一口径。 */
  {
    const RIVER_MIN_CELLS = 10;
    const seen = new Uint8Array(n);
    const stack: number[] = [];
    const cells: number[] = [];
    for (let k0 = 0; k0 < n; k0++) {
      if (!river[k0] || seen[k0]) continue;
      stack.length = 0; cells.length = 0;
      stack.push(k0); seen[k0] = 1;
      while (stack.length) {
        const c = stack.pop() as number;
        cells.push(c);
        const y = (c / w) | 0, x = c - y * w;
        const nb = [y > 0 ? c - w : -1, y < h - 1 ? c + w : -1,
          y * w + ((x + w - 1) % w), y * w + ((x + 1) % w)];
        for (const j of nb) {
          if (j >= 0 && river[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }
      if (cells.length < RIVER_MIN_CELLS) for (const c of cells) river[c] = 0;
    }
  }
  /* 湖：陆地上"水出不去"的洼地（`down < 0`），且**集水区够大**才算湖。
     ⚠️ 首版把**每一个**洼地都当湖画（深色海水色）—— 真机放大一看：河谷里全是深色点串，
     而统计里"湖"还是 0（洼地是孤立单格、被 ≥4 格的连通分量闸门滤掉）⇒ **渲染与统计两套判据**。
     现在两边同源：集水区 ≥ 600 格才认（≈ 23 万 km² 量级的流域 —— 本形态不做侵蚀，洼地天然偏多，
     闸门不放高的话满图都是小蓝方块），湖面只画洼地本身 + 紧邻的平底格
     （本分辨率下一格 ≈ 39 km，1~3 格的面就相当于里海那种大湖了）。 */
  const lake = new Uint8Array(n);
  let lakeCount = 0;
  /* 集水区闸门**随分辨率缩放**（h=512 → 630 格、h=256 → 157 格）：写死的话预览尺寸下一个湖都没有 */
  const minBasin = Math.max(40, Math.round(n * 0.0012));
  for (let k = 0; k < n; k++) {
    if (!land[k] || down[k] >= 0 || basin[k] < minBasin) continue;
    lakeCount++;
    lake[k] = 1;
    const y0 = (k / w) | 0, x0 = k - y0 * w;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y0 + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const j = yy * w + ((x0 + dx + w) % w);
        if (land[j] && down[j] === k && elev[j] - elev[k] < 0.02) lake[j] = 1;
      }
    }
  }

  yield { phase: '认湖', done: 1, total: 1 };

  /* ── 统计（字段名与局部形态一致，UI 因此不用改）────────────────────────────
     ⚠️ 面积闸门**随分辨率缩放**：8 格在 1024×512 上只有 4 个像素 —— 不缩放的话
     "岛"会数出上百个（真机首跑就是 99 个），面板上那一行就没意义了。 */
  const sizes = components(w, h, land);
  const landTotal = sizes.reduce((a, b) => a + b, 0);
  const big = Math.max(60, Math.round(landTotal * 0.03));
  const minIsland = Math.max(8, Math.round(n * 0.00004));
  const riverComps = components(w, h, river).filter((s) => s >= 12);
  let peak = 0, maxFlow = 0, deepest = 0;
  for (let k = 0; k < n; k++) {
    if (land[k] && elev[k] > peak) peak = elev[k];
    if (land[k] && flow[k] > maxFlow) maxFlow = flow[k];
    /* ⭐ 第一百三十二轮：最深海沟（米）—— 状态行/预览行用它证明"海底真的生成了" */
    if (!land[k] && -elev[k] > deepest) deepest = -elev[k];
  }
  const zoneSeen = new Map<string, number>();
  for (let k = 0; k < n; k++) {
    if (!land[k]) continue;
    const key = `${Math.min(3, (e01[k] * 4) | 0)}|${Math.min(3, (moist[k] * 4) | 0)}`;
    zoneSeen.set(key, (zoneSeen.get(key) ?? 0) + 1);
  }
  const stats: TerrainStats = {
    lands: sizes.filter((s) => s >= big).length || (sizes.length ? 1 : 0),
    islands: sizes.filter((s) => s >= minIsland && s < big).length,
    zones: [...zoneSeen.values()].filter((v) => v >= 20).length,
    rivers: riverComps.length,
    lakes: lakeCount,
    peak: Math.round(peak * 1000),
    deepest: Math.round(deepest * 1000),
    landRatio: landTotal / n,
    regions: 0,
    solidTriangles: n,
    longestRiver: Math.round(maxFlow),
  };

  yield { phase: '汇总统计', done: 1, total: 1 };

  return { w, h, elev, e01, land, river, lake, moist, temp, flow, style, spec: sp, stats };
}

/** 同步外壳：一口气跑到完（守卫 / 离线脚本 / 预览图用）。
 *  界面**不要**用它 —— 1.4s 的同步调用会把"正在算"的遮罩一起冻住。 */
export function buildPlanetField(seed: string, style: string, spec?: MapgenSpecInput, h: number = PLANET_H, proto?: ProtoInput | null): PlanetField {
  const it = planetFieldGen(seed, style, spec, h, proto);
  let step = it.next();
  while (!step.done) step = it.next();
  return step.value;
}

/* ── 上色（九档「看的方式」）──────────────────────────────────────────────────────
   ⚠️ 只换颜色：**不重算地形**（换档是瞬时的，与局部形态的 setStyle() 同一条规矩）。
   色带与旋钮的唯一来源是 ./styles.ts（与 WebGL 那条路共用同一张表）⇒ 以后加档只改那边。
   局部形态的 frag_drape 干的事（山体细节 / 海岸湿沙与浪花 / 水纹 / 排线 / 纸纹 / 颗粒 / 暗角），
   这里用同样的思路再做一遍：星球图约 1.18M 像素，逐像素三次取噪仍在百毫秒量级。
   ⚠️ **极地夹边不能动**：at() 的行下标必须夹在 0..h-1（守卫 tools/e2e/map-planet.cjs ★6 靠它）。 */

type RGB = [number, number, number];
/* ⭐ 第一百零五轮：`hex()` 原来在**逐像素**路径上被调（`renderPlanet` 里
   `hex(climateHex(...))` ⇒ 每个像素一次 rgbToHex + 一次反解，1.18M 次 ≈ 100ms）。
   climateHex 的取值只落在 3 温带 × 4 湿度的格点上 ⇒ 缓存后基本全命中。
   ⚠️ 返回值是**共享数组**：调用方只读（`mix()` 会新建），千万别就地改。 */
const hexCache = new Map<string, RGB>();
const hex = (s: string): RGB => {
  let v = hexCache.get(s);
  if (!v) {
    v = [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
    if (hexCache.size < 4096) hexCache.set(s, v);
  }
  return v;
};
const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
];
const sstep = (a: number, b: number, v: number): number => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const SNOW = hex('#f2f4f2');

/** 逐像素值噪声（与着色器同一套公式）。坐标用**格子数**而不是 uv：极地不会被拉伸成横条。 */
function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise2(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
const fbm2 = (x: number, y: number): number =>
  0.5 * vnoise2(x, y) + 0.25 * vnoise2(x * 2.03, y * 2.03) + 0.125 * vnoise2(x * 4.01, y * 4.01);

/** 色带 → 256 级查找表（逐像素调 sampleRampHex() 要解析十六进制串，1M 次会肉眼可见地慢）*/
function rampLut(hexes: string[]): RGB[] {
  const out: RGB[] = [];
  for (let i = 0; i < 256; i++) out.push(hex(sampleRampHex(hexes, i / 255)));
  return out;
}
const rampAt = (lut: RGB[], t: number): RGB => lut[Math.round(clamp(t, 0, 1) * 255)];

/** 3×3 盒滤（x 环绕、y 夹边）—— 抽等高线前先过一遍。
 *  真实制图也是从**平滑过的 DEM** 抽等高线的：不平滑时，海拔恰好压在档位线附近的地方
 *  会因逐格噪声反复跨档 ⇒ 画出来是一团团碎毛（用户 2026-10-13 真机截图上的低地就是这样）。 */
function boxFilter(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < h; i++) {
    const yu = (i > 0 ? i - 1 : 0) * w;
    const yc = i * w;
    const yd = (i < h - 1 ? i + 1 : h - 1) * w;
    for (let j = 0; j < w; j++) {
      const jm = (j + w - 1) % w, jp = (j + 1) % w;
      out[yc + j] = (src[yu + jm] + src[yu + j] + src[yu + jp]
        + src[yc + jm] + src[yc + j] + src[yc + jp]
        + src[yd + jm] + src[yd + j] + src[yd + jp]) / 9;
    }
  }
  return out;
}

/** 把场画成 RGBA（w*h*4，可直接进 canvas / WebGL 贴图）。认不出的 view 落回默认档。
 *  生成器版：每 32 行让出一次 —— 768 高时整趟约 0.5s，切完单片约 20ms。 */
export function* renderPlanetGen(f: PlanetField, view: unknown, contourEvery = 0): Generator<PlanetProgress, Uint8ClampedArray, void> {
  const def = terrainStyleDef(view);
  const { w, h, elev, e01, land, river, lake, moist, temp } = f;
  const out = new Uint8ClampedArray(w * h * 4);
  const needSmooth = def.contour > 0 || def.bands > 1;
  const sm = needSmooth ? boxFilter(e01, w, h) : null;   /* 等高线用平滑后的高度 */
  /* 山体阴影也从**平滑高度**求：逐格差分会把网格噪声一起放大，看着像揉皱的锡纸 */
  const hs = boxFilter(elev, w, h);
  yield { phase: '上色', done: 0, total: h };
  const dyKm = Math.PI * R_KM / h;
  const landLut = rampLut(def.land);
  const seaLut = rampLut(def.sea);
  const lineC = hex(def.line);
  const lineDark = mix(lineC, [18, 18, 16], 0.45);
  const riverC = hex(def.river);
  /* ⭐ 第一百零六轮：材质分层（岩 / 岩层条带 / 雪 / 浅滩）—— 与 `frag_drape` 同一套规矩 */
  const mat = styleMaterial(view);
  /* ⭐ 第一百三十二轮：海底画法（晕渲 / 等深线 / 深度分层设色）—— 九档风格各自的读海底方式 */
  const sbd = styleSeabed(view);
  const bandN = def.bands > 1 ? def.bands : 0;
  let maxDepth = 0.5;
  for (let k = 0; k < w * h; k++) { const d = -elev[k]; if (d > maxDepth) maxDepth = d; }
  yield { phase: '量海深', done: 1, total: 1 };
  /* ⚠️ 行索引必须**夹在 0..h-1**（极点外面没有行）。不夹的话 i=0 那一行的"上一行"是负下标：
     · land[负数] 读到 undefined ⇒ 极地**每一格陆地都被当成海岸线**（整行压上深色边）；
     · elev[负数] 读到 undefined ⇒ 光照算出 NaN ⇒ col * NaN 写进 Uint8ClampedArray 变 0
       ⇒ 极地整行发黑。
     守卫 tools/e2e/map-planet.cjs ★6（"极地行起伏应远小于赤道行"）就是被这两条逼红的。 */
  const at = (x: number, y: number) => {
    const yy = y < 0 ? 0 : (y >= h ? h - 1 : y);
    return yy * w + (((x % w) + w) % w);
  };
  for (let i = 0; i < h; i++) {
    const lat = 90 - (i + 0.5) * 180 / h;
    const cl = Math.max(0.05, Math.cos(lat * D2R));
    const dxKm = (2 * Math.PI * R_KM * cl) / w;
    for (let j = 0; j < w; j++) {
      const k = i * w + j;
      const isLand = land[k] === 1;
      const t = clamp(e01[k], 0, 1);
      /* 细节噪声（世界格坐标 ⇒ 接缝只差一格，看不出） */
      const det = def.detail > 0 ? fbm2(j / w * 90, i / h * 45) - 0.5 : 0;
      /* 坡度：陆地才用（山体阴影 / 排线都读它）。
         ⚠️ 第一百零三轮：**按像素夸张**（原来除以 dxKm/dyKm ⇒ 陆坡只有 0.02 量级，
         光照算出来几乎是常数 —— 星球图因此"一片平色、山看不出来"）。这里是制图学的
         垂直夸张，不是物理坡度；`dxKm/dyKm` 仍留给需要真实单位的排线判断。 */
      let gx = 0, gy = 0;
      if (isLand) {
        /* 垂直夸张 15 倍（制图学常用量级）：km/km 的真实坡度只有 0.02 上下，不夸张看不出山。 */
        const ex = 15;
        gx = (hs[at(j + 1, i)] - hs[at(j - 1, i)]) / (2 * Math.max(0.5, dxKm)) * ex;
        gy = (hs[at(j, i + 1)] - hs[at(j, i - 1)]) / (2 * Math.max(0.5, dyKm)) * ex;
      } else {
        /* ⭐ 第一百三十二轮：海底也要坡度 —— 晕渲 / 等深线都读它。海底起伏比陆地小一个量级
           （几 km 对 8 km 的峰），垂直夸张给 45 倍才看得见；仍用同一个 `hs`（平滑过的高程）
           ⇒ 不会把逐格噪声当成"处处是陡坡"（山体那版踩过的坑）。 */
        const ex = 45;
        gx = (hs[at(j + 1, i)] - hs[at(j - 1, i)]) / (2 * Math.max(0.5, dxKm)) * ex;
        gy = (hs[at(j, i + 1)] - hs[at(j, i - 1)]) / (2 * Math.max(0.5, dyKm)) * ex;
      }
      let col: RGB;
      if (!isLand) {
        /* 海：深度色带 + （按档）深度分层设色 / 等深线 / 海底晕渲 / 水面细纹。
           ⚠️ 海深按**这片海最深的那一格**归一化（第八十几轮定的）：固定除以 8.5 时大多数地图
           只吃到色带最浅的一小段，看上去"海是一片平色"。现在海沟是最深的那一格，
           色带满幅用在 0..最深 —— 陆架浅、海盆中、海沟最深，一眼读得出层次。 */
        const depthN = clamp(-elev[k] / maxDepth, 0, 1);
        let dt = Math.pow(depthN, 0.7);
        /* 深度分层设色（第一百三十二轮）：与陆地的 `bands` 同一种画法（档内保留 30% 渐变，
           不做成色卡）。地形图 / 等高线地形图 / 蓝图 / 极简靠它读"几档水深"。 */
        if (sbd.bands > 1) {
          const lv = dt * sbd.bands;
          dt = (Math.floor(lv) + 0.30 * (lv - Math.floor(lv))) / sbd.bands;
        }
        col = rampAt(seaLut, dt);
        /* ⭐ 浅滩带（B4）：岸线水侧渐浅，不再与深海一个色 */
        if (mat.shelf > 0) {
          const shallow = 1 - sstep(0, 0.10, depthN);
          col = mix(col, mix(col, [158, 199, 189], 0.55), shallow * mat.shelf);
        }
        /* 海底纹理：细节噪声（水面之下的一层"砂"）*/
        if (def.detail > 0) {
          const kk = 1 + det * 0.10 * def.detail;
          col = [col[0] * kk, col[1] * kk, col[2] * kk];
        }
        /* 等深线（第一百三十二轮）：用**平滑过的绝对高度**按深度切档，与陆地的等高线同一个
           画法（线距太密时淡出，不做成一片深色）；每 5 条一条计曲线（线色加深）。
           `BN` 与分层设色档数对齐 ⇒ 每条线正好落在色阶交界上（分层图配线，读起来最顺）。 */
        if (sbd.bathy > 0) {
          const BN = sbd.bands > 1 ? sbd.bands : 10;
          const btOf = (v: number) => clamp(-v / maxDepth, 0, 1);
          const cb = Math.floor(btOf(hs[k]) * BN);
          const bl = Math.floor(btOf(hs[at(j - 1, i)]) * BN);
          const bu = Math.floor(btOf(hs[at(j, i - 1)]) * BN);
          if (cb !== bl || cb !== bu) {
            const spx = Math.abs(btOf(hs[at(j + 3, i)]) - btOf(hs[at(j - 3, i)])) / 6;
            const spy = Math.abs(btOf(hs[at(j, i + 3)]) - btOf(hs[at(j, i - 3)])) / 6;
            const spacingPx = 1 / Math.max(Math.max(spx, spy) * BN, 1e-6);
            const alpha = clamp((spacingPx - 2) / 5, 0.18, 1);
            const base = cb % 5 === 0 ? lineDark : lineC;
            col = mix(col, base, alpha * Math.min(1, sbd.bathy) * 0.62);
          }
        }
        /* 海底晕渲（第一百三十二轮）：光还是西北上方，只给约 ±1/3 的明暗 ——
           读得出洋中脊的脊线、海沟的沟壁、海山的锥形，又不会把整片海压成"山地图"。 */
        if (sbd.shade > 0) {
          const nx = -gx, ny = -gy, nzz = 1;
          const nl = Math.sqrt(nx * nx + ny * ny + 1);
          const lx = -0.55, ly = -0.62, lz = 0.56;
          const lam = clamp((nx / nl) * lx + (ny / nl) * ly + (nzz / nl) * lz, 0, 1);
          const f2 = clamp(1 + 0.62 * sbd.shade * (lam * 1.9 - 0.95), 0.66, 1.28);
          col = [col[0] * f2, col[1] * f2, col[2] * f2];
        }
        if (def.waterNoise > 0) {
          const wn = fbm2(j / w * 42, i / h * 21) - 0.5;
          const kk = 1 + wn * def.waterNoise * 0.16;
          col = [col[0] * kk, col[1] * kk, col[2] * kk];
        }
      } else {
        /* 高程分布偏低（多数陆地贴在海平面附近）⇒ 轻度 gamma 拉开低地层次 */
        let tt = Math.pow(t, 0.72);
        if (bandN > 0) {
          const lv = tt * bandN;
          tt = (Math.floor(lv) + 0.35 * (lv - Math.floor(lv))) / bandN;
        }
        col = rampAt(landLut, tt);
        /* ⭐ 第一百零四轮：生物群系 —— 用户「只能看出山脉和平原两种地形」。
           星球这边**有真实纬度温度**（`temp[]`，年均℃）和湿度（`moist[]`），所以直接查气候表：
           低地按气候上色（荒漠 / 草原 / 温带林 / 雨林 / 苔原 / 针叶林），
           t > 0.42 起逐渐交回高程色带（岩 / 雪）—— 山脊不会被"气候绿"糊成草坪。 */
        if (def.biome > 0) {
          /* 星球有真实年均温（℃）：−5℃ 及以下算寒带、30℃ 及以上算热带 —— 按实测分位
             （本机种子 5%..95% = 1.7..28℃）正好铺满三条温度带，不会整颗星球都落进"暖带=荒漠"。 */
          const temp01 = clamp((temp[k] + 5) / 35, 0, 1);
          /* 湿度：星球的 `moist` 中位数约 0.46（不是"必然偏湿"的量），先除以 0.75 再向两端拉 1.2 倍，
             让 0.46 落在"旱生林"那一列、0.8 以上才进雨林 —— 不然整颗星球都读成荒漠/稀树草原。 */
          const moist01 = clamp(0.5 + ((moist[k] - 0.05) / 0.75 - 0.5) * 1.2, 0, 1);
          const climateC = hex(climateHex(def.treat, temp01, moist01));
          const s0 = clamp((t - 0.42) / 0.36, 0, 1);
          const rockMix = s0 * s0 * (3 - 2 * s0);
          col = mix(mix(col, climateC, def.biome), col, rockMix);
        }
        /* 细节斑驳 */
        if (def.detail > 0) {
          const kk = 1 + det * 0.12 * def.detail;
          col = [col[0] * kk, col[1] * kk, col[2] * kk];
        }
        /* ⭐ 第一百零六轮：地表材质分层（B3）—— 高处 + 陡坡露岩（带岩层条带），再压雪线。
           以前高处只是"更浅的绿"，山脊与平原分不开（用户「看不出不同地形之间的区别」）。 */
        const steep = clamp(Math.hypot(gx, gy) * 1.6, 0, 1);
        const rockT = clamp(Math.max(sstep(0.58, 0.80, tt), sstep(0.34, 0.78, steep) * 0.78), 0, 1);
        if (mat.rock > 0) {
          const rockC = mix(rampAt(landLut, 0.52), rampAt(landLut, 0.74), clamp(0.30 + 0.34 * (det + 0.5), 0, 1));
          col = mix(col, rockC, rockT * mat.rock);
          if (mat.strata > 0) {
            const strata = (tt * 34 + (det + 0.5) * 1.4) % 1;
            const band = sstep(0.42, 0.52, strata) - sstep(0.52, 0.62, strata);
            const bk = 1 + band * 0.11 * mat.strata * rockT;
            col = [col[0] * bk, col[1] * bk, col[2] * bk];
          }
        }
        if (mat.snow > 0) {
          /* 雪线只压在**最高的那圈**（0.88..0.98）：第一版从 0.80 起，整块高原都被刷成白色
             ⇒ 星球图上是几团"奶油"（第一百零六轮真机截图）。 */
          const snowT = sstep(0.88, 0.98, t) * sstep(0.30, 0.60, rockT);
          if (snowT > 0) col = mix(col, SNOW, clamp(snowT, 0, 0.85) * mat.snow);
        }
        /* 等高线：用**平滑过**的高度切 contourScale 档；每 4 条计曲线加深（线色也来自档位）*/
        if (def.contour > 0 && sm) {
          const cs = def.contourScale;
          const cb = Math.floor(sm[k] * cs);
          const bl = Math.floor(sm[at(j - 1, i)] * cs);
          const bu = Math.floor(sm[at(j, i - 1)] * cs);
          /* ⭐ 第一百一十轮：自动档从「跳线」改成「**淡出**」。
             跳线是按档号取模，间距一变就必然断线 ⇒ 小图上一片断断续续的虚线（真机截图实测）；
             淡出没有断口：平地线间距够（≥12px）就正常画，陡坡上几十条线自动变淡，
             合成一层浅浅的坡面过渡，而不是一块突兀的深色。
             手动档（全部/每2条/每5条）仍按档号跳线 —— 那是用户明确要的"省略"。 */
          const spx = Math.abs(sm[at(j + 3, i)] - sm[at(j - 3, i)]) / 6;
          const spy = Math.abs(sm[at(j, i + 3)] - sm[at(j, i - 3)]) / 6;
          const spacingPx = 1 / Math.max(Math.max(spx, spy) * cs, 1e-6);
          const autoAlpha = clamp((spacingPx - CONTOUR_FADE_MIN_PX) / (CONTOUR_FADE_FULL_PX - CONTOUR_FADE_MIN_PX), CONTOUR_FADE_FLOOR, 1);
          const every = contourEvery > 0 ? contourEvery : 0;
          const keep = every <= 1 || cb % every === 0;
          if (keep && (cb !== bl || cb !== bu)) {
            const base = ((every > 1 ? (cb / every) | 0 : cb) % 5 === 0) ? lineDark : lineC;
            col = contourEvery > 0 ? base : mix(col, base, autoAlpha);
          }
        }
        /* 坡面排线（水墨 / 羊皮纸 / 蓝图）：沿坡向排线，越陡越密 */
        if (def.hatch > 0) {
          const ang = Math.atan2(gy, gx);
          const sv = (j * Math.cos(ang) + i * Math.sin(ang)) * 1.15;
          const hl = sstep(0.62, 0.96, Math.abs(Math.sin(sv)));
          const steep = sstep(0.05, 0.30, Math.hypot(gx, gy));
          col = mix(col, lineC, hl * steep * def.hatch * 0.75);
        }
      }
      /* 山体阴影（强度 = 档位的 shade；极简档 0 ⇒ 完全不画）。噪声微扰法线 ⇒ 山不是光滑色团。 */
      if (isLand && def.shade > 0) {
        const px = gx + det * 0.05 * def.detail, py = gy + det * 0.05 * def.detail;
        const nx = -px, ny = -py, nzz = 1;
        const nl = Math.sqrt(nx * nx + ny * ny + 1);
        const lx = -0.55, ly = -0.62, lz = 0.56;   /* 光从西北上方来（地图惯例）*/
        const lam = clamp((nx / nl) * lx + (ny / nl) * ly + (nzz / nl) * lz, 0, 1);
        const f2 = clamp(1 + 0.9 * def.shade * (lam * 1.9 - 0.95), 0.55, 1.35);
        col = [col[0] * f2, col[1] * f2, col[2] * f2];
      }
      /* 海岸：陆地一侧湿沙 + 浪花亮边；档位没开就只留上游那条 1 格暗线 */
      if (isLand) {
        const nb = !land[at(j - 1, i)] || !land[at(j + 1, i)] || !land[at(j, i - 1)] || !land[at(j, i + 1)];
        if (nb) {
          /* 海岸**永远是"一条线"**：先压湿沙，再压一道深描边 ——
             1536px 的星球图上不画这条线，陆地边缘就糊成一片（第一版截图的毛病）。 */
          if (def.coast > 0) col = mix(col, mix(col, [232, 222, 194], 0.55), def.coast);
          col = mix(col, mix(col, [40, 42, 40], 0.55), 0.7);
        }
      } else if (def.coast > 0) {
        /* 水侧浪花：紧挨陆地的水格提亮一点，读得出"岸" */
        const wb = land[at(j - 1, i)] || land[at(j + 1, i)] || land[at(j, i - 1)] || land[at(j, i + 1)];
        if (wb) col = mix(col, [226, 236, 232], def.coast * 0.4);
      }
      if (lake[k]) col = rampAt(seaLut, 0.12);
      /* 河：本格画实色，**四邻淡淡晕一指宽** —— 1px 的线缩到面板尺寸就成了一串点。 */
      if (river[k]) col = riverC;
      else if (isLand && (river[at(j - 1, i)] || river[at(j + 1, i)] || river[at(j, i - 1)] || river[at(j, i + 1)]
        || river[at(j - 1, i - 1)] || river[at(j + 1, i - 1)] || river[at(j - 1, i + 1)] || river[at(j + 1, i + 1)])) {
        /* 四邻 + 四对角：星球图缩放后 1px 的河只剩几个点，得让它有"一指宽" */
        col = mix(col, riverC, 0.35);
      }
      /* 屏幕空间收尾三层：纸纹 / 颗粒 / 暗角（与着色器同一个顺序） */
      const u = j / w, v = i / h;
      if (def.paper > 0) {
        const stain = fbm2(u * 7, v * 7);
        const kk = 1 - def.paper * (0.10 - 0.18 * stain);
        col = [col[0] * kk * 1.04, col[1] * kk * 0.99, col[2] * kk * 0.92];
      }
      if (def.grain > 0) {
        const g = hash2(j, i) - 0.5;
        const kk = 1 + g * def.grain * 0.35;
        col = [col[0] * kk, col[1] * kk, col[2] * kk];
      }
      if (def.vignette > 0) {
        const rr = Math.hypot(u - 0.5, v - 0.5);
        const kk = 1 - def.vignette * sstep(0.40, 0.95, rr);
        col = [col[0] * kk, col[1] * kk, col[2] * kk];
      }
      const o = k * 4;
      out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2]; out[o + 3] = 255;
    }
    if ((i & 31) === 31 || i === h - 1) yield { phase: '上色', done: i + 1, total: h };
  }
  return out;
}

/** 同步外壳（同 `buildPlanetField`：离线/守卫用；界面走分帧版）*/
export function renderPlanet(f: PlanetField, view: unknown, contourEvery = 0): Uint8ClampedArray {
  const it = renderPlanetGen(f, view, contourEvery);
  let step = it.next();
  while (!step.done) step = it.next();
  return step.value;
}

/** 便捷：场 + 上色一次拿全（离线脚本 / 守卫用；界面里两者分开缓存）*/
export function buildPlanet(seed: string, style: string, spec?: MapgenSpecInput, view?: unknown, h: number = PLANET_H, proto?: ProtoInput | null, contourEvery = 0) {
  const field = buildPlanetField(seed, style, spec, h, proto);
  return { field, rgba: renderPlanet(field, view, contourEvery) };
}
