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
import { sampleRampHex, terrainStyleDef } from './styles';

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

/** 档位 + 创作者旋钮 → 本形态真正用到的三件套（陆地占比 / 山脊密度 / 河密度） */
export function planetSpec(style: string, spec?: MapgenSpecInput): Required<MapgenSpecInput> {
  const p = PRESETS[(isPlanetStyle(style) ? style : 'continent') as PlanetStyle];
  return {
    landRatio: clamp(Number(spec?.landRatio ?? p.landRatio), 0.05, 0.8),
    ridges: clamp(Math.round(Number(spec?.ridges ?? 4)), 1, 8),
    rivers: clamp(Math.round(Number(spec?.rivers ?? 1)), 0, 4),
  };
}

/* ── 场 ─────────────────────────────────────────────────────────────────────── */

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
  spec: Required<MapgenSpecInput>;
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

/** **生成一颗星球**（纯函数：同参数逐字节同结果）。
 *  `h` 是网格高（宽 = 2h），默认 `PLANET_H`；预览可以给更小的值换速度。 */
export function buildPlanetField(seed: string, style: string, spec?: MapgenSpecInput, h: number = PLANET_H): PlanetField {
  const sp = planetSpec(style, spec);
  const w = h * 2;
  const n = w * h;
  /* 五个噪声"域"分开（照局部内核的规矩）：同一颗种子下各层互不相关 */
  const nC = createNoise3D(mulberry32(seedInt(String(seed) + '|大陆')));
  const nP = createNoise3D(mulberry32(seedInt(String(seed) + '|分区')));
  const nM = createNoise3D(mulberry32(seedInt(String(seed) + '|山脉')));
  const nD = createNoise3D(mulberry32(seedInt(String(seed) + '|细节')));
  const nW = createNoise3D(mulberry32(seedInt(String(seed) + '|湿度')));

  /* 陆核 / 山体核（各自的随机流：与上面五个噪声域互不相关，同种子仍确定） */
  const cores = placeCores(mulberry32(seedInt(String(seed) + '|陆核')), style);
  const mounts = placeMassifs(mulberry32(seedInt(String(seed) + '|山体')), cores, sp.ridges);

  const mtnAmp = 0.5 + sp.ridges * 0.16;          /* ridges 1..8 → 0.66 .. 1.78 */
  const ridgeFreq = 2.0 + sp.ridges * 0.18;
  /* 域扭曲幅度：**别贪大**。0.30 那版真机出图是"细长漩涡 + 内海成片"，像虫形不像大陆
     （fBm 的等值线本来就偏蠕虫）；0.18 保住有机感又不把大陆撕碎。 */
  const warpAmp = 0.18;

  const raw = new Float32Array(n);       /* 大陆度：**只决定海陆**（不参与高度）*/
  const hraw = new Float32Array(n);      /* 陆地起伏场：底 + 分区基准 + 板缘山带 + 细节 */
  const deta = new Float32Array(n);      /* 细节颗粒（海底起伏也借它一点）*/
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
      const shore = fbm3(nC, x, y, z, 2.15, 2) * 0.13 + fbm3(nC, x, y, z, 6.5, 2) * 0.032;
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
      /* ⭐ 高度**另起一套场**：陆块场只决定海陆（它的等值线就是海岸线），高度是
         "底 + 分区基准 + **主山体** + 山脊 + 板缘山带 + 细节"。主山体 `mf` 是绝对主角，
         板缘带 `band` 降到配角 —— 旧版只有板缘带，山是撒满全图的疙瘩、没有主峰。
         海岸那圈仍由下面的**沿海压低**处理（dist 越近越矮 ⇒ 海岸平原 + 内陆抬升）。 */
      hraw[kk] = 0.14 + (prov - 0.5) * 0.34
        + mf * (0.82 + 0.42 * provRelief)
        + mf * rg * mtnAmp * 0.42
        + mtnAmp * rg * band * provRelief * 0.20
        + det * 0.075 + fine * 0.05;
      deta[kk] = det;
      if (c < lo) lo = c;
      if (c > hi) hi = c;
    }
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

  const elev = new Float32Array(n);
  const e01 = new Float32Array(n);
  const land = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (raw[k] > sea) land[k] = 1;
  /* 碎块清理：小于约 10 格的陆块还给海（噪声斑点，不是岛）。**必须在下游各 pass 之前做**
     —— 距离海 / 高度 / 汇流 / 温度 / 统计就都跑在同一张干净的陆地掩膜上。 */
  pruneSmall(w, h, land, Math.max(4, Math.round(n * 0.00002)));

  /* ── 距海（多源 BFS；经度环绕）——**必须在高度之前算**：
     ① 陆地高度乘它做"沿海压低"（海岸是低地、越高越往里）；
     ② 海深按它分陆架与深海盆（大陆架浅、大洋盆地深）——这两条是"像真地图"的关键。 */
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let k = 0; k < n; k++) if (!land[k]) { dist[k] = 0; queue[tail++] = k; }
  while (head < tail) {
    const i = queue[head++];
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
    if (hraw[k] > maxH) maxH = hraw[k];
  }
  const hInv = 1 / (maxH || 1);
  for (let k = 0; k < n; k++) {
    if (land[k]) {
      const t = clamp(hraw[k] * hInv, 0, 1);
      elev[k] = Math.pow(t, 1.15) * peakKm;
      e01[k] = t;
    } else {
      const shelf = clamp(dist[k] / 9, 0, 1);          /* 0 在岸边 → 1 深海盆（9 格 ≈ 620 km 陆架）*/
      const basin = clamp(0.78 + deta[k] * 0.5, 0.4, 1.3); /* 海盆也起起伏伏（洋中脊/海沟的粗略替身）*/
      elev[k] = -(0.12 + Math.pow(shelf, 0.75) * (maxDepthKm - 0.12) * basin);
      if (elev[k] < -maxDepthKm) elev[k] = -maxDepthKm;
    }
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
      moist[k] = clamp(far * (0.45 + 0.55 * wind) * alt + nnn * 0.12, 0, 1);
      /* 温度：纬度 + 海拔两条都算。⚠️ 系数调过：照 vision 那条口径的形（30 − 0.55×|纬度|、
         海拔 −6.5℃/km）会把 45° 上 800 m 的高地就冻成雪原 —— 真机出图"内陆成片惨白"
         就是这个来的。改成 32 − 0.45×|纬度|、−6.0℃/km ⇒ 45° 雪线约 2.5 km、赤道约 5.8 km，
         与真实地球同量级。 */
      temp[k] = 32 - 0.45 * alat - 6.0 * Math.max(0, elev[k]);
    }
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
  for (let k = 0; k < n; k++) if (land[k]) flow[k] = 0.35 + 0.65 * moist[k];
  /* `down[i]` = i 的下游格（−1 = 洼地，水出不去）；`basin[i]` = 有多少格的水汇进 i。
     两个都在这一趟里顺手攒出来 —— 湖的判定与"把河补成 4 连通"都要用（见下）。 */
  const down = new Int32Array(n).fill(-1);
  const basin = new Int32Array(n);
  for (let q = 0; q < order.length; q++) {
    const i = order[q];
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

  /* ── 统计（字段名与局部形态一致，UI 因此不用改）────────────────────────────
     ⚠️ 面积闸门**随分辨率缩放**：8 格在 1024×512 上只有 4 个像素 —— 不缩放的话
     "岛"会数出上百个（真机首跑就是 99 个），面板上那一行就没意义了。 */
  const sizes = components(w, h, land);
  const landTotal = sizes.reduce((a, b) => a + b, 0);
  const big = Math.max(60, Math.round(landTotal * 0.03));
  const minIsland = Math.max(8, Math.round(n * 0.00004));
  const riverComps = components(w, h, river).filter((s) => s >= 12);
  let peak = 0, maxFlow = 0;
  for (let k = 0; k < n; k++) {
    if (land[k] && elev[k] > peak) peak = elev[k];
    if (land[k] && flow[k] > maxFlow) maxFlow = flow[k];
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
    landRatio: landTotal / n,
    regions: 0,
    solidTriangles: n,
    longestRiver: Math.round(maxFlow),
  };

  return { w, h, elev, e01, land, river, lake, moist, temp, flow, style, spec: sp, stats };
}

/* ── 上色（八档「看的方式」）──────────────────────────────────────────────────────
   ⚠️ 只换颜色：**不重算地形**（换档是瞬时的，与局部形态的 setStyle() 同一条规矩）。
   色带与旋钮的唯一来源是 ./styles.ts（与 WebGL 那条路共用同一张表）⇒ 以后加档只改那边。
   局部形态的 frag_drape 干的事（山体细节 / 海岸湿沙与浪花 / 水纹 / 排线 / 纸纹 / 颗粒 / 暗角），
   这里用同样的思路再做一遍：星球图约 1.18M 像素，逐像素三次取噪仍在百毫秒量级。
   ⚠️ **极地夹边不能动**：at() 的行下标必须夹在 0..h-1（守卫 tools/e2e/map-planet.cjs ★6 靠它）。 */

type RGB = [number, number, number];
const hex = (s: string): RGB => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
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

/** 把场画成 RGBA（w*h*4，可直接进 canvas / WebGL 贴图）。认不出的 view 落回默认档。 */
export function renderPlanet(f: PlanetField, view: unknown): Uint8ClampedArray {
  const def = terrainStyleDef(view);
  const { w, h, elev, e01, land, river, lake, moist, temp } = f;
  const out = new Uint8ClampedArray(w * h * 4);
  const needSmooth = def.contour > 0 || def.bands > 1;
  const sm = needSmooth ? boxFilter(e01, w, h) : null;   /* 等高线用平滑后的高度 */
  /* 山体阴影也从**平滑高度**求：逐格差分会把网格噪声一起放大，看着像揉皱的锡纸 */
  const hs = boxFilter(elev, w, h);
  const dyKm = Math.PI * R_KM / h;
  const landLut = rampLut(def.land);
  const seaLut = rampLut(def.sea);
  const lineC = hex(def.line);
  const lineDark = mix(lineC, [18, 18, 16], 0.45);
  const riverC = hex(def.river);
  const bandN = def.bands > 1 ? def.bands : 0;
  let maxDepth = 0.5;
  for (let k = 0; k < w * h; k++) { const d = -elev[k]; if (d > maxDepth) maxDepth = d; }
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
      }
      let col: RGB;
      if (!isLand) {
        /* 海：深浅色带 + 细纹（上游口径：8.5 km 折算 1.0 水深）*/
        /* 海深按**这片海最深的那一格**归一化：固定除以 8.5 时大多数地图只吃到色带最浅的一小段，
           看上去"海是一片平色"（第一百零三轮第一版截图）。 */
        const depth = Math.pow(clamp(-elev[k] / maxDepth, 0, 1), 0.7);
        col = rampAt(seaLut, depth);
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
        /* 干湿偏色：湿的地方偏绿、干的地方偏暖 —— 沙漠/雨林在同高度也能分开 */
        if (def.moist > 0) {
          const dry = clamp((0.45 - moist[k]) * 1.6, 0, 1) * def.moist;
          col = mix(col, mix(col, [201, 177, 132], 0.55), dry * 0.35);
        }
        /* 细节斑驳 */
        if (def.detail > 0) {
          const kk = 1 + det * 0.12 * def.detail;
          col = [col[0] * kk, col[1] * kk, col[2] * kk];
        }
        /* 雪线：年均温 < −3℃ 的陆地渐白（只给"写实"那几档：蓝图上压雪会毁掉整套配色）*/
        if (def.detail >= 0.6 && t > 0.6 && temp[k] < -3) {
          col = mix(col, SNOW, clamp((-temp[k] - 3) / 22, 0.08, 0.6));
        }
        /* 等高线：用**平滑过**的高度切 contourScale 档；每 4 条计曲线加深（线色也来自档位）*/
        if (def.contour > 0 && sm) {
          const cs = def.contourScale;
          const cb = Math.floor(sm[k] * cs);
          const bl = Math.floor(sm[at(j - 1, i)] * cs);
          const bu = Math.floor(sm[at(j, i - 1)] * cs);
          if (cb !== bl || cb !== bu) col = cb % 4 === 0 ? lineDark : lineC;
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
  }
  return out;
}

/** 便捷：场 + 上色一次拿全（离线脚本 / 守卫用；界面里两者分开缓存）*/
export function buildPlanet(seed: string, style: string, spec?: MapgenSpecInput, view?: unknown, h: number = PLANET_H) {
  const field = buildPlanetField(seed, style, spec, h);
  return { field, rgba: renderPlanet(field, view) };
}
