/** 程序化地形生成 —— 纯 TS、零依赖、**确定性**（同一颗种子永远长出同一片地）。
 *
 *  演进（三轮用户反馈，都记在这儿免得后人再把路走回去）：
 *   ① 2026-10-13「我建议先做一个基础的，看起来像的地图生成，真实模拟是额外附件」
 *      → 第一版是"圆疙瘩 + 径向抖动"，当场被否：「**你做的有点丑**」
 *   ② 「**能不能通过叠加多层噪声的方式生成啊，大噪声确定走向，小噪声加细节**」
 *      → 第二版上了 fBm + 域扭曲 + Marching Squares 等高带，像地图了，但仍然被否：
 *   ③ 「**确定不同地形的生成逻辑和形态，然后随机分区再生成，不是真实模拟但是也能有细节，
 *      不生成等高线，而是直接生成真实地形**」← **当前这版**
 *
 *  所以现在的链条是（关键词：**地形类型 → 随机分区 → 按类型的长法合成 → 真实地形图**）：
 *    ① 大陆骨架（低频噪声 + 陆核掩膜）→ 海陆分界 + 距离海岸
 *    ② **随机分区**：Voronoi 细胞（十几到二十几个），每格按「高度 × 湿度 × 纬度」
 *       判一个**地形类型**（平原/森林/沙漠/丘陵/山地/高原/雪原/湖泊/沼泽/滩涂/浅海/深海）
 *    ③ **每种地形有自己的生成逻辑与形态**（`TERRAINS[].style`）：
 *         smooth 平原（低频、几乎没起伏）／rolling 丘陵森林（中频浑圆）／
 *         ridged 山地（`1-|2n-1|` 山脊，锋利）／dunes 沙漠（正弦沙丘被噪声扭曲）／
 *         flat 高原雪原（平顶 + 陡沿）／basin 湖沼（下沉盆底）
 *       分区之间不是硬切：按 Voronoi 权重重叠混合**参数**（基高/起伏/形态），
 *       所以从平原走到山地是渐变的，但每块地又明显"是另一种地形"。
 *    ④ 上色 + **山体阴影**（NW 光位 lambert）→ 一张真彩地形图；河按最陡下降烘进去。
 *    ⑤ 产物**不是**矢量等高线，而是**参数**（种子/档位/数量）—— 图在渲染时现算现画
 *       （`src/ui/map-terrain.ts` 走 canvas），所以 worldbuilding.json 里只多几百字节，
 *       而不是塞一张几百 KB 的 base64；手绘的区域/标记照旧盖在地形之上。
 *
 *  真模拟（板块漂移 / 侵蚀 / 洋流气候）在另一条 Python 管线里
 *  （`F:\knowledge-base\projects\world-map\`，全链 ~7.5 min、中间栅格 3.6 GB）——
 *  那是**额外附件**，不进这条主路径；本文件建成一张地形图约 60~150 ms。 */

import { uid } from '../store/ids';
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import type { MapData, MapLine, MapMarker, MapRegion, MapTerrainSpec } from '../store/types';

export type MapStyle = 'continent' | 'archipelago' | 'pangaea';

/** 显式参数：描述里解析出来的、或调用方直接给的 —— **压过**档位的默认值。
    ⚠️ 写成 `type` 而不是 `interface`：这样它能直接塞进 `MapData.terrain.spec`
    （索引签名要求，interface 没有隐式索引签名）。 */
export type MapSpec = {
  lands?: number;
  islands?: number;
  ridges?: number;
  rivers?: number;
  lakes?: number;
  /** 陆地占比 0~1（默认按档位：大陆 .34 / 群岛 .24 / 盘古 .44） */
  landRatio?: number;
};

export interface MapGenSummary {
  lands: number;      // 主要陆块（连通分量里面积大的那些）
  islands: number;    // 小岛
  zones: number;      // 地形区（随机分出来的块数）
  rivers: number;     // 河
  lakes: number;      // 湖
  peak: number;       // 最高处（示意海拔，米）
  landRatio: number;  // 陆地占比
}

export interface MapGenResult {
  regions: MapRegion[];
  lines: MapLine[];
  markers: MapMarker[];
  summary: MapGenSummary;
}

/** 矢量线（格坐标）：闭合环（海岸线 / 湖岸）与开口折线（河）。
    ⭐ 2026-10-13（用户选「混合方案」）：「**地形主要是拿来看，文化分区什么的主要是拿来动手**」
    ⇒ 地形本体是栅格位图（有光影、好看），**岸线 / 湖岸 / 河是矢量**（放大不糊、以后能点、
    能挂设定）。它们是同一套噪声场的**派生物** ⇒ 不落盘，渲染时现取（`src/ui/map-terrain.ts`）。 */
export type TerrainPath = [number, number][];

/** 建一张地形图：像素（RGB，已上色 + 打光）+ 高度 + 陆地掩膜 + 统计 + 矢量线 */
export interface TerrainGrid {
  w: number;
  h: number;
  cell: number;
  rgb: Uint8ClampedArray;
  height: Float32Array;
  sea: number;
  summary: MapGenSummary;
  coast: TerrainPath[];    // 海岸线（只收闭合环）
  lakes: TerrainPath[];    // 湖岸（只收闭合环）
  rivers: TerrainPath[];   // 河流（开口折线：从高处沿最陡下降走到海）
}

/** 「＋ 生成」那排控件用的档位表（标签 + 一句人话） */
export const MAP_STYLES: { id: MapStyle; label: string; hint: string }[] = [
  { id: 'continent', label: '大陆', hint: '两三块大陆 + 几座岛' },
  { id: 'archipelago', label: '群岛', hint: '一片岛链 + 两块小陆' },
  { id: 'pangaea', label: '盘古', hint: '一整块超级大陆' },
];

export function styleHint(id: MapStyle): string {
  return MAP_STYLES.find((s) => s.id === id)?.hint ?? '';
}

/* ── 地形类型：**每种地形自己的长法**（用户第 ③ 条要求的核心）────────────────
   `style` = 形态逻辑；`base` = 相对海平面的基础高度；`relief` = 起伏强度；`rgb` = 基色。
   上下顺序也是"从低到高"，海洋在最前、雪原在最后。 */
type Morph = 'smooth' | 'rolling' | 'ridged' | 'dunes' | 'flat' | 'basin';

interface Terrain {
  id: string;
  label: string;
  style: Morph;
  base: number;
  relief: number;
  rgb: [number, number, number];
  water?: boolean;
}

export const TERRAINS: Terrain[] = [
  { id: 'deep', label: '深海', style: 'smooth', base: -0.55, relief: 0.05, rgb: [18, 32, 48], water: true },
  { id: 'ocean', label: '海洋', style: 'smooth', base: -0.3, relief: 0.06, rgb: [30, 54, 78], water: true },
  { id: 'shallow', label: '浅海', style: 'smooth', base: -0.1, relief: 0.05, rgb: [56, 96, 124], water: true },
  { id: 'lake', label: '湖泊', style: 'basin', base: -0.04, relief: 0.02, rgb: [48, 84, 110], water: true },
  { id: 'beach', label: '滩涂', style: 'flat', base: 0.015, relief: 0.02, rgb: [204, 194, 158] },
  { id: 'plain', label: '平原', style: 'smooth', base: 0.07, relief: 0.05, rgb: [130, 158, 92] },
  { id: 'swamp', label: '沼泽', style: 'basin', base: 0.03, relief: 0.03, rgb: [96, 118, 82] },
  { id: 'forest', label: '森林', style: 'rolling', base: 0.14, relief: 0.1, rgb: [66, 100, 62] },
  { id: 'desert', label: '沙漠', style: 'dunes', base: 0.12, relief: 0.07, rgb: [204, 178, 118] },
  { id: 'hill', label: '丘陵', style: 'rolling', base: 0.28, relief: 0.16, rgb: [140, 132, 84] },
  { id: 'plateau', label: '高原', style: 'flat', base: 0.44, relief: 0.06, rgb: [156, 130, 92] },
  { id: 'mountain', label: '山地', style: 'ridged', base: 0.62, relief: 0.3, rgb: [108, 100, 94] },
  { id: 'snow', label: '雪原', style: 'flat', base: 0.66, relief: 0.05, rgb: [228, 232, 236] },
];

const T = (id: string) => TERRAINS.find((t) => t.id === id) as Terrain;

/* ── 确定性随机 ──────────────────────────────────────────────────── */
function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0 || 1;
}

function makeRnd(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── 噪声：值噪声 + fBm。oct 少/频率低 = 大噪声（走向）；oct 多/频率高 = 小噪声（细节）── */
function hash2(seed: number, x: number, y: number): number {
  let h = seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smoothstep = (t: number) => t * t * (3 - 2 * t);

function noise2(seed: number, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = smoothstep(x - xi);
  const v = smoothstep(y - yi);
  const a = hash2(seed, xi, yi);
  const b = hash2(seed, xi + 1, yi);
  const c = hash2(seed, xi, yi + 1);
  const d = hash2(seed, xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(seed: number, x: number, y: number, oct: number, gain = 0.5, lac = 2): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += noise2(seed + i * 1013, x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lac;
  }
  return sum / norm;
}

/** 山脊形态：把噪声翻折成尖脊（经典 ridged multifractal） */
const ridged = (n: number) => 1 - Math.abs(n * 2 - 1);

/* ── 几何小工具（手绘区域与生成物观感一致）────────────────────────── */
const r1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, a = 0, b = 1) => (n < a ? a : n > b ? b : n);

/** Catmull-Rom 平滑 → 闭合 SVG path（手绘区域用） */
export function smoothClosedPath(pts: [number, number][]): string {
  if (pts.length < 3) return pts.map(([x, y]) => `M${r1(x)},${r1(y)}`).join(' ');
  const p = pts.map((pt) => ({ x: pt[0], y: pt[1] }));
  let d = `M${r1(p[0].x)},${r1(p[0].y)}`;
  for (let i = 0; i < p.length; i++) {
    const p0 = p[(i - 1 + p.length) % p.length];
    const p1 = p[i];
    const p2 = p[(i + 1) % p.length];
    const p3 = p[(i + 2) % p.length];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${r1(c1x)},${r1(c1y)} ${r1(c2x)},${r1(c2y)} ${r1(p2.x)},${r1(p2.y)}`;
  }
  return d + ' Z';
}

/** 开放折线 → SVG path（手绘轨迹 / 路线用） */
export function polylinePath(pts: [number, number][]): string {
  if (!pts.length) return '';
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${r1(x)},${r1(y)}`).join(' ');
}

/* ── 分区：Voronoi 细胞（随机分区，每格判一个地形类型）──────────────── */
interface Zone {
  x: number;
  y: number;      // 站点坐标（格）
  terr: Terrain;
}

/** 距离海岸有多少格（BFS；用来判浅海/滩涂/内陆性） */
function coastDistance(land: Uint8Array, w: number, h: number): Int16Array {
  const d = new Int16Array(w * h).fill(9999);
  const q: number[] = [];
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    const y = (i - x) / w;
    const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
    if (edge) { d[i] = 0; q.push(i); continue; }
    /* 海陆分界上 = 距离 1 */
    const l = land[i];
    if (land[i - 1] !== l || land[i + 1] !== l || land[i - w] !== l || land[i + w] !== l) { d[i] = 1; q.push(i); }
  }
  for (let head = 0; head < q.length; head++) {
    const i = q[head];
    const x = i % w;
    const y = (i - x) / w;
    const n = d[i] + 1;
    if (x > 0 && d[i - 1] > n) { d[i - 1] = n; q.push(i - 1); }
    if (x < w - 1 && d[i + 1] > n) { d[i + 1] = n; q.push(i + 1); }
    if (y > 0 && d[i - w] > n) { d[i - w] = n; q.push(i - w); }
    if (y < h - 1 && d[i + w] > n) { d[i + w] = n; q.push(i + w); }
  }
  return d;
}

/** 连通分量（陆块 / 岛）：面积统计 */
function components(v: Float32Array, sea: number, w: number, h: number) {
  const seen = new Uint8Array(w * h);
  const out: { area: number; peak: number }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (seen[i] || v[i] <= sea) continue;
    let area = 0;
    let peak = -1e9;
    stack.length = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop() as number;
      const x = c % w;
      const y = (c - x) / w;
      area++;
      if (v[c] > peak) peak = v[c];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const k = ny * w + nx;
          if (!seen[k] && v[k] > sea) { seen[k] = 1; stack.push(k); }
        }
      }
    }
    out.push({ area, peak });
  }
  return out;
}

/* ── 等值线（Marching Squares）→ 矢量线 ──────────────────────────────────
   用途：把高度场里「高度 = 海平面」那条线取出来 = **海岸线 + 湖岸**。
   ⚠️ 只收**闭合**环：开口的（切到画布边缘那种）一律丢掉 —— 第 2 版把开口环首尾一连，
   在海面上横穿出一条斜线，那正是"丑"的来源之一。现在最外一圈被压成海（见 buildTerrain），
   等值线天然闭合，剩下的开口碎屑本来也不该画。 */
/** 闭合环的有向面积（正负 = 绕向）：**陆地边界为负、湖岸为正**（陆地永远在左手边走出来的） */
function polyArea(pts: TerrainPath): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/* 方向：0=东 1=南 2=西 3=北（屏幕坐标 y 向下 ⇒ 这个顺序就是顺时针） */
const DXX = [1, 0, -1, 0];
const DYY = [0, 1, 0, -1];

function landAt(land: Uint8Array, w: number, h: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < w && y < h && land[y * w + x] === 1;
}

/** 走到一个新角点后，该往哪条"半边"继续：由陆地掩膜在这个角点四个象限里的**交界配对**决定。
    ⭐ 为什么不用"先左转、再直行、再右转、最后掉头"那套贴墙规则：角点上有四条边界交汇时
    （斜角相接的陆地就是），那套规则会跳墙 ⇒ 走进一条回不到起点的环（2026-10-13 离线实测：
    大陆的岸线走满 8200 步都不闭合，同一块地还被走出两条面积几乎相同的"环"）。
    配对法是**双射**（每个来向对应唯一去向）⇒ 走法必然分解成闭合环，从哪出发都会绕回原处。 */
function pairNext(land: Uint8Array, w: number, h: number, x: number, y: number, dIn: number): number {
  const hi = (dIn + 2) % 4;                 /* 来时的半边：从角点指回上一个角点 */
  const NW = landAt(land, w, h, x - 1, y - 1);
  const NE = landAt(land, w, h, x, y - 1);
  const SE = landAt(land, w, h, x, y);
  const SW = landAt(land, w, h, x - 1, y);
  const halves: number[] = [];
  if (NW !== NE) halves.push(3);            /* 上边（北）是 NW/NE 的交界 */
  if (NE !== SE) halves.push(0);            /* 右边（东）是 NE/SE 的交界 */
  if (SE !== SW) halves.push(1);            /* 下边（南）是 SE/SW 的交界 */
  if (SW !== NW) halves.push(2);            /* 左边（西）是 SW/NW 的交界 */
  const i = halves.indexOf(hi);
  if (i < 0) return -1;                     /* 这条半边不挨着边界 ⇒ 走不下去了 */
  /* 环形相邻配对：两条半边时唯一；四条时 (北,东)(南,西) —— 对角相接就在这一步分开 */
  return halves[i % 2 === 0 ? (i + 1) % halves.length : (i - 1 + halves.length) % halves.length];
}

/** 从某个"角点 + 出发方向"沿边界走一整圈；返回角点列与该圈走过的状态（用来去重） */
function traceLoop(land: Uint8Array, w: number, h: number, sx: number, sy: number, sd: number, maxSteps: number) {
  const pts: TerrainPath = [];
  const keys: string[] = [];
  let x = sx;
  let y = sy;
  let d = sd;
  for (let step = 0; step < maxSteps; step++) {
    keys.push(x + ',' + y + ',' + d);
    pts.push([x, y]);
    x += DXX[d];
    y += DYY[d];
    const nd = pairNext(land, w, h, x, y, d);
    if (nd < 0) break;
    d = nd;
    if (x === sx && y === sy && d === sd) break;   /* 回到起点、且又要朝起始方向走 ⇒ 一圈走完 */
  }
  return { pts, keys };
}

/* ── 海岸线 / 湖岸：沿**陆地边界**走（不是插值等值线）────────────────────────
   ⭐ 为什么不用 Marching Squares 插值：那张场在 4px 网格上全是 1 格级的小特征，
   插值出来的线段端点会在鞍点/退化处撞在一起，接链时 15% 的顶点是 4 度、还有成片的
   零长短段 ⇒ 一整片大陆被拆成几十条**接不拢的开口链**，最后一条岸线都画不出来
   （2026-10-13 离线实测：群岛 518 段 → 0 个闭合环 + 44 条碎链）。
   沿边界走的好处：角点全是**整数**、必然闭合、天然自带绕向（陆地永远在左手边 ⇒
   `polyArea < 0` 的是海岸线、`> 0` 的是湖岸），也不需要"环内取样"来判断哪边是陆。 */
function coastLoops(land: Uint8Array, w: number, h: number, minArea: number): { pts: TerrainPath; land: boolean }[] {
  const seen = new Set<string>();
  const out: { pts: TerrainPath; land: boolean }[] = [];
  const maxSteps = (w + h) * 12 + 4000;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (land[y * w + x] !== 1) continue;
      /* 每个"陆地格子挨着水的那条边"都是一个可能的起点（左右上下各查一次） */
      const seeds: [number, number, number][] = [];
      if (!landAt(land, w, h, x, y - 1)) seeds.push([x + 1, y, 2]);
      if (!landAt(land, w, h, x, y + 1)) seeds.push([x, y + 1, 0]);
      if (!landAt(land, w, h, x - 1, y)) seeds.push([x, y, 1]);
      if (!landAt(land, w, h, x + 1, y)) seeds.push([x + 1, y, 3]);
      for (const [sx, sy, sd] of seeds) {
        if (seen.has(sx + ',' + sy + ',' + sd)) continue;
        const { pts, keys } = traceLoop(land, w, h, sx, sy, sd, maxSteps);
        for (const k of keys) seen.add(k);
        if (pts.length < 8) continue;
        const a = polyArea(pts);
        if (Math.abs(a) < minArea) continue;
        out.push({ pts, land: a < 0 });
      }
    }
  }
  return out;
}
/** Chaikin 磨圆（闭合环）：等值线是折的，磨两下才像海岸线 */
function chaikinClosed(pts: TerrainPath, iter = 2): TerrainPath {
  let cur = pts;
  for (let k = 0; k < iter && cur.length > 3; k++) {
    const next: TerrainPath = [];
    for (let i = 0; i < cur.length; i++) {
      const a = cur[i];
      const b = cur[(i + 1) % cur.length];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    cur = next;
  }
  return cur;
}

/** Chaikin 磨圆（开口折线，如河）：两端不动 */
function chaikinOpen(pts: TerrainPath, iter = 2): TerrainPath {
  let cur = pts;
  for (let k = 0; k < iter && cur.length > 2; k++) {
    const next: TerrainPath = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i];
      const b = cur[i + 1];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

/** 抽稀：挨得太近的点丢掉（点太密只会让 SVG 变大，看不出更多细节） */
function thin(pts: TerrainPath, tol: number, closed: boolean): TerrainPath {
  if (pts.length < 4) return pts;
  const out: TerrainPath = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const q = out[out.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= tol) out.push(p);
  }
  const lastIn = pts[pts.length - 1];
  if (closed) {
    const q = out[out.length - 1];
    if (Math.hypot(out[0][0] - q[0], out[0][1] - q[1]) < tol) out.pop();
    return out.length >= 3 ? out : pts;
  }
  const q = out[out.length - 1];
  if (q !== lastIn && Math.hypot(lastIn[0] - q[0], lastIn[1] - q[1]) > 0.001) out.push(lastIn);   /* 河口必须接到海 */
  return out;
}

/* ── 建地形 ──────────────────────────────────────────────────────── */
export function buildTerrain(spec: MapTerrainSpec, width: number, height: number): TerrainGrid {
  const style: MapStyle = spec.style === 'archipelago' || spec.style === 'pangaea' ? spec.style : 'continent';
  const key = `${spec.seed}|${style}|${width}x${height}`;
  const rnd = makeRnd(key);
  const sp: MapSpec = spec.spec ?? {};
  const s = Math.min(width, height);
  const cell = 3;
  const w = Math.max(16, Math.ceil(width / cell));
  const h = Math.max(12, Math.ceil(height / cell));
  const N = w * h;

  const seedLand = hashSeed(`${key}|陆`);
  const seedWarp = hashSeed(`${key}|扭曲`);
  const seedMoist = hashSeed(`${key}|湿度`);
  const seedRidge = hashSeed(`${key}|山脉`);
  const seedMorph = hashSeed(`${key}|形态`);
  const fBig = 2.6 / Math.max(w, h);
  const warpAmp = (s / cell) * 0.22;

  const landRatio = sp.landRatio ?? (style === 'pangaea' ? 0.44 : style === 'archipelago' ? 0.24 : 0.34);
  const wantLands = sp.lands ?? (style === 'pangaea' ? 1 : style === 'archipelago' ? 3 : 2 + Math.floor(rnd() * 2));
  const rangeCount = sp.ridges ?? (style === 'pangaea' ? 4 : 2 + Math.floor(rnd() * 3));
  const bigArea = N * 0.02;      /* 面积 ≥ 全图 2% 才算「大陆」 */
  const isleArea = N * 0.0012;   /* 比这更小的是高频噪声的碎屑，不算岛 */

  interface Core {
    x: number;
    y: number;
    rx: number;
    ry: number;
    rot: number;
  }
  const ell = (e: Core, x: number, y: number) => {
    const dx = x - e.x;
    const dy = y - e.y;
    const c = Math.cos(-e.rot);
    const sn = Math.sin(-e.rot);
    const u = (dx * c - dy * sn) / e.rx;
    const v = (dx * sn + dy * c) / e.ry;
    const d = Math.hypot(u, v);
    return d >= 1 ? 0 : 1 - d * d;   /* 平滑衰减，边界不硬 */
  };
  const makeCores = (n: number, mul: number): Core[] => {
    const out: Core[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        x: w * (0.22 + rnd() * 0.56),
        y: h * (0.24 + rnd() * 0.52),
        rx: w * (style === 'pangaea' ? 0.42 : 0.2 + rnd() * 0.14) * mul,
        ry: h * (style === 'pangaea' ? 0.4 : 0.2 + rnd() * 0.16) * mul,
        rot: rnd() * Math.PI,
      });
    }
    return out;
  };
  /* 山脉脊线（山地长在哪）：细长核，只抬"海拔"不造陆 */
  const rangesOf = (cores: Core[]): Core[] => {
    const out: Core[] = [];
    for (let i = 0; i < rangeCount; i++) {
      const c = cores[Math.floor(rnd() * cores.length)] ?? { x: w / 2, y: h / 2, rx: w * 0.2, ry: h * 0.2 };
      out.push({
        x: c.x + (rnd() - 0.5) * c.rx * 0.9,
        y: c.y + (rnd() - 0.5) * c.ry * 0.9,
        rx: w * (0.05 + rnd() * 0.05),
        ry: h * (0.18 + rnd() * 0.16),
        rot: rnd() * Math.PI,
      });
    }
    return out;
  };

  /* ── 第一遍：**海陆**（raw vs sea）+ 海拔趋势 + 湿度。收敛回路要反复调它，所以独立成函数。
     ⚠️ 这一遍的标尺（raw）与后面"地形高度"的标尺**不是同一个**：
     raw 的海平面是分位数算出来的（可能是 0.18），而地形高度的海平面固定是 0。
     曾经把两个混着用来判陆地 ⇒ 统计出"陆地占 31% 却只有 1 块陆地"的鬼数字。 */
  interface Pass1 {
    raw: Float32Array;
    elev: Float32Array;
    moist: Float32Array;
    sea: number;
    peak: number;
    land: Uint8Array;
  }
  const pass1 = (cores: Core[], ranges: Core[], noiseMul: number): Pass1 => {
    const raw = new Float32Array(N);
    const elev = new Float32Array(N);
    const moist = new Float32Array(N);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        /* 域扭曲：采样点先被另一层低频噪声推开 —— 这一步是"像不像手画"的分界 */
        const wx = x + (fbm(seedWarp, x * fBig * 0.8, y * fBig * 0.8, 2) - 0.5) * warpAmp;
        const wy = y + (fbm(seedWarp + 977, x * fBig * 0.8, y * fBig * 0.8, 2) - 0.5) * warpAmp;
        let core = 0;
        for (const c of cores) {
          const e = ell(c, wx, wy);
          if (e > core) core = e;
        }
        const big = (fbm(seedLand, wx * fBig, wy * fBig, 3) - 0.46) * 0.7 * noiseMul;   /* 大噪声：走向 */
        const fine = (fbm(seedMorph, wx * fBig * 7, wy * fBig * 7, 3) - 0.5) * 0.1;     /* 小噪声：细节 */
        raw[i] = core * 0.75 + big + fine;
        let r = 0;
        for (const g of ranges) {
          const e = ell(g, wx, wy);
          if (e > r) r = e;
        }
        const trend = fbm(seedRidge, wx * fBig * 2.3, wy * fBig * 2.3, 5);
        elev[i] = clamp(r * 0.75 + trend * 0.55 - 0.06);
        moist[i] = fbm(seedMoist, wx * fBig * 1.3, wy * fBig * 1.3, 3);
      }
    }
    const sorted = Float32Array.from(raw).sort();
    const sea = sorted[Math.floor((1 - landRatio) * (sorted.length - 1))];
    const land = new Uint8Array(N);
    for (let i = 0; i < N; i++) land[i] = raw[i] > sea ? 1 : 0;
    return { raw, elev, moist, sea, peak: sorted[sorted.length - 1], land };
  };

  /* ⭐ 「两个大陆」这种话要真算数：数一遍连通分量，多了把陆核缩小、噪声加大（裂开），
     少了反过来（抱团）。**只在点名要地块数时**才收敛（没点名就按档位的随机核数）。 */
  let cores = makeCores(wantLands, 1);
  let noiseMul = 1;
  let p1 = pass1(cores, rangesOf(cores), noiseMul);
  for (let attempt = 0; attempt < 5 && sp.lands != null; attempt++) {
    const bigs = components(p1.raw, p1.sea, w, h).filter((c) => c.area >= bigArea).length;
    if (bigs === sp.lands) break;
    if (bigs > sp.lands) {
      cores = makeCores(wantLands, 1.12);
      noiseMul *= 0.78;
    } else {
      cores = makeCores(wantLands, 0.9);
      noiseMul *= 1.18;
    }
    p1 = pass1(cores, rangesOf(cores), noiseMul);
  }
  const cdist = coastDistance(p1.land, w, h);
  /* 相对海拔：0 = 海岸线，1 = 全图最高（**只在陆地上有意义**，水上为负） */
  const e01 = new Float32Array(N);
  const span = Math.max(1e-6, p1.peak - p1.sea);
  for (let i = 0; i < N; i++) e01[i] = (p1.raw[i] - p1.sea) / span;

  /* ── 第二遍：**随机分区**（Voronoi），每格按「海陆 + 离岸 + 海拔 + 湿度 + 纬度」判地形类型 */
  const zoneCount = Math.max(6, Math.round(N / 900) + Math.floor(rnd() * 4));
  const zones: Zone[] = [];
  for (let i = 0; i < zoneCount; i++) zones.push({ x: rnd() * w, y: rnd() * h, terr: T('plain') });
  for (const z of zones) {
    const zi = Math.min(N - 1, Math.max(0, Math.round(z.y) * w + Math.round(z.x)));
    const d = cdist[zi];
    const alt = clamp(e01[zi] * 0.6 + p1.elev[zi] * 0.6);
    const mo = p1.moist[zi];
    const lat = Math.abs(z.y / h - 0.5) * 2;         /* 0 赤道 → 1 两极 */
    if (!p1.land[zi]) {
      z.terr = d <= 2 ? T('shallow') : e01[zi] > -0.06 ? T('ocean') : T('deep');
    } else if (d <= 2) {
      z.terr = T('beach');
    } else if (alt > 0.62) {
      z.terr = T('mountain');
    } else if (alt > 0.48) {
      z.terr = mo > 0.5 ? T('mountain') : T('plateau');
    } else if (alt > 0.34) {
      z.terr = lat > 0.45 ? T('plateau') : T('hill');
    } else if (lat > 0.72 && alt > 0.22) {
      z.terr = T('snow');
    } else if (mo < 0.36) {
      z.terr = alt > 0.2 ? T('hill') : T('desert');
    } else if (mo < 0.44) {
      z.terr = T('swamp');
    } else if (mo > 0.58) {
      z.terr = T('forest');
    } else {
      z.terr = T('plain');
    }
  }
  /* 湖：内陆低洼处单独点几个（不受分区影响，像地图上的水泡） */
  const lakeSpots: { x: number; y: number }[] = [];
  const wantLakes = sp.lakes ?? (1 + Math.floor(rnd() * 3));
  for (let t = 0; t < 400 && lakeSpots.length < wantLakes; t++) {
    const x = 2 + Math.floor(rnd() * (w - 4));
    const y = 2 + Math.floor(rnd() * (h - 4));
    const i = y * w + x;
    if (!p1.land[i] || cdist[i] < 4 || e01[i] > 0.3) continue;
    if (lakeSpots.some((p) => Math.hypot(p.x - x, p.y - y) < Math.min(w, h) * 0.14)) continue;
    lakeSpots.push({ x, y });
  }

  /* ── 第三遍：按类型的长法合成地形高度 + 上色（分区之间混合**参数** ⇒ 渐变而非硬切） */
  const morphW = [0, 0, 0, 0, 0, 0];
  const mIdx: Record<string, number> = { smooth: 0, rolling: 1, ridged: 2, dunes: 3, flat: 4, basin: 5 };
  const hgt = new Float32Array(N);
  const rgb = new Uint8ClampedArray(N * 4);
  const wts = new Float64Array(zones.length);
  /* 分区权重：**锐化的 1/d²**（`1/(d²+1)²`）—— 近的分区压倒性地强、远的趋近 0，
     但**永不归零**。试过"只让半径内的分区参与"（紧凑支撑）：圆盘之间留缝，缝上落到
     "最近的那一个" ⇒ 硬切换，真机截图上成了从陆地射出去的放射状光条。 */
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let wsum = 0;
      let best = 0;
      let bestD = Infinity;
      for (let k = 0; k < zones.length; k++) {
        const z = zones[k];
        const dx = x - z.x;
        const dy = y - z.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD) { bestD = d2; best = k; }
        const inv = 1 / (d2 + 1);
        const wt = inv * inv;
        wts[k] = wt;
        wsum += wt;
      }
      /* ⭐ 陆和水**各混各的颜色**：分区类型是按"站点落在哪"判出来的，站点在岸边时
         整个分区都会被刷成滩涂/平原色 —— 早先不分陆水，海面上就出现一圈发白的光晕
         （真机截图一眼可见）。分成两套累加器之后，海上只让 water 那几种地形的颜色进来，
         陆地只让陆地地形进来；高度参数（base/relief/形态）也只由陆地那套决定。 */
      let rr = 0;
      let gg = 0;
      let bb = 0;
      let base = 0;
      let relief = 0;
      let landW = 0;
      let wr = 0;
      let wg = 0;
      let wb = 0;
      let wsumW = 0;
      for (let k = 0; k < 6; k++) morphW[k] = 0;
      for (let k = 0; k < zones.length; k++) {
        const wt = wts[k];
        const t = zones[k].terr;
        if (t.water) {
          wr += t.rgb[0] * wt;
          wg += t.rgb[1] * wt;
          wb += t.rgb[2] * wt;
          wsumW += wt;
        } else {
          base += t.base * wt;
          relief += t.relief * wt;
          rr += t.rgb[0] * wt;
          gg += t.rgb[1] * wt;
          bb += t.rgb[2] * wt;
          morphW[mIdx[t.style]] += wt;
          landW += wt;
        }
      }
      const sumL = landW > 0 ? landW : 1;
      const sumW = wsumW > 0 ? wsumW : 1;
      for (let k = 0; k < 6; k++) morphW[k] /= sumL;
      base /= sumL;
      relief /= sumL;
      /* 每种形态算一次自己的噪声，再按权重合成 ——「每种地形有自己的长法」就体现在这。
         ⚠️ 频率别调低：网格是 3px/格，0.045/格 的波长是 60px —— 真机上就是一团糊。
         0.12~0.24/格（波长 12~25px）才有"地形"的质感。 */
      const nSmooth = (fbm(seedMorph + 11, x * 0.12, y * 0.12, 3) - 0.5) * 2;
      const nRoll = (fbm(seedMorph + 23, x * 0.24, y * 0.24, 5) - 0.5) * 2;
      const nRidge = (ridged(fbm(seedMorph + 37, x * 0.2, y * 0.2, 5)) - 0.45) * 2;
      const nDune = (Math.abs(Math.sin(x * 0.5 + fbm(seedMorph + 41, x * 0.12, y * 0.12, 2) * 6)) - 0.5) * 2;
      /* 高原/雪原：平顶 + 陡沿（越靠分区中心越平、越靠边越陡） */
      const dSite = Math.hypot(x - zones[best].x, y - zones[best].y) / Math.max(4, Math.min(w, h) * 0.12);
      const nFlat = (clamp(dSite, 0, 1) - 0.5) * 1.2 + (fbm(seedMorph + 53, x * 0.14, y * 0.14, 2) - 0.5);
      const nBasin = -0.5 + (fbm(seedMorph + 67, x * 0.16, y * 0.16, 2) - 0.5) * 0.6;
      /* 底噪：给平地也留一层细颗粒，否则大片纯色看上去像没渲染完 */
      const nGrain = (fbm(seedMorph + 83, x * 0.55, y * 0.55, 3) - 0.5) * 0.16;
      const morph =
        nSmooth * morphW[0] + nRoll * morphW[1] + nRidge * morphW[2] + nDune * morphW[3] + nFlat * morphW[4] + nBasin * morphW[5];
      const e = e01[i];
      let hv: number;
      if (e <= 0) {
        hv = e * 1.1 - 0.02;                                   /* 水：越深越负（海平面固定 = 0） */
      } else {
        /* 陆：真实海拔趋势（e）+ 该地形的基础高度与起伏（形态按类型混出来） */
        hv = e * (0.5 + relief * 0.9) + base * 0.5 + morph * relief * 0.5 + nGrain;
        if (cdist[i] <= 1) hv = Math.min(hv, 0.03);            /* 贴海岸的一圈压平（滩涂） */
      }
      for (const p of lakeSpots) {
        const d = Math.hypot(p.x - x, p.y - y);
        /* ⚠️ 洼法不能跟周围高度挂钩：早先写成 `hv*(1-t) - 0.06*t`，在高地上（hv≈0.3）
           这条曲线根本压不到 0 ⇒ 参数里报了 1 个湖、图上一条湖岸都画不出来（离线实测）。
           改成"先把陆地削到 0、再按 t 挖" ⇒ 湖岸就是半径 4.5 格的那个圈，稳定可预测。 */
        if (d < 4.5) {
          const t = clamp((4.5 - d) / 4.5);
          hv = Math.min(hv, 0) - 0.12 * t;
        }
      }
      hgt[i] = clamp(hv, -0.9, 1.5);
      /* 颜色按**最终**陆/水定（湖是挖出来的洼地 ⇒ 那里也得是水色，不能留着陆地色） */
      const wet = hgt[i] <= 0;
      let cr = wet ? wr / sumW : rr / sumL;
      let cg = wet ? wg / sumW : gg / sumL;
      let cb = wet ? wb / sumW : bb / sumL;
      if (wet) {
        const kk = clamp(1 + hgt[i] * 1.1, 0.4, 1);            /* 水越深越暗 */
        cr *= kk;
        cg *= kk;
        cb *= kk;
      }
      const col = i * 4;
      rgb[col] = cr;
      rgb[col + 1] = cg;
      rgb[col + 2] = cb;
      rgb[col + 3] = 255;
    }
  }

  /* ── 世界边缘一圈海：让**所有**等值线都闭合（否则切到画布边缘的等值线会被首尾一连，
     在海面上横穿一条斜线 —— 第 2 版实测到的那个丑东西），顺便给地图一个自然的边框。
     只动"地形高度"这一层（`hgt`）+ 那一圈的颜色；统计仍以第一遍的 raw 为准。 */
  {
    const band = 3;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.min(x, y, w - 1 - x, h - 1 - y);
        if (d >= band) continue;
        const i = y * w + x;
        const depth = -0.05 - (band - d) * 0.06;      /* 越靠外越深 */
        if (hgt[i] > depth) hgt[i] = depth;
        const col = i * 4;
        rgb[col] = 34;
        rgb[col + 1] = 60;
        rgb[col + 2] = 86;
      }
    }
  }

  /* ── 山体阴影（NW 光位，lambert）—— "真实地形"的立体感全靠这一步 */
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const xm = x > 0 ? i - 1 : i;
      const xp = x < w - 1 ? i + 1 : i;
      const ym = y > 0 ? i - w : i;
      const yp = y < h - 1 ? i + w : i;
      const dzdx = (hgt[xp] - hgt[xm]) * 3.6;
      const dzdy = (hgt[yp] - hgt[ym]) * 3.6;
      const len = Math.hypot(dzdx, dzdy, 1);
      const lam = clamp((dzdx * 0.55 + dzdy * 0.55 + 0.63) / len, 0.15, 1.6);
      /* 打光只是"提神"，不是主角：增益压低、上下限收紧。
         早先 `0.62 + lam * 0.55` 会把大片亮面推到 255 —— 真机截图里陆地中间糊成一片白。 */
      const k = clamp(0.72 + lam * 0.42, 0.55, 1.26);
      const col = i * 4;
      rgb[col] = clamp(rgb[col] * k, 0, 255);
      rgb[col + 1] = clamp(rgb[col + 1] * k, 0, 255);
      rgb[col + 2] = clamp(rgb[col + 2] * k, 0, 255);
    }
  }

  /* ── 岸线 / 湖岸（矢量）：拿**最终高度场**的陆地掩膜，沿边界走一圈（见 `coastLoops` 的说明）。
     最外一圈已经是海 ⇒ 环全闭合；`land: true` 的是海岸线，`false` 的是湖岸。 */
  const landMask = new Uint8Array(N);
  for (let i = 0; i < N; i++) landMask[i] = hgt[i] > 0 ? 1 : 0;
  const coastV: TerrainPath[] = [];
  const lakeV: TerrainPath[] = [];
  for (const c of coastLoops(landMask, w, h, 6)) {
    const pts = thin(chaikinClosed(c.pts, 2), 1.2, true);
    if (c.land) coastV.push(pts);
    else lakeV.push(pts);
  }

  /* ── 河：从高处沿最陡下降走到海（**存成矢量折线**，栅格图里不再烘线 —— 见文件头「混合方案」） */
  const riversV: TerrainPath[] = [];
  const wantRivers = sp.rivers ?? (2 + Math.floor(rnd() * 3));
  let rivers = 0;
  {
    const cand: { i: number; v: number }[] = [];
    for (let i = 0; i < N; i++) if (p1.land[i] && e01[i] > 0.5) cand.push({ i, v: e01[i] });
    cand.sort((a, b) => b.v - a.v);
    const used: { x: number; y: number }[] = [];
    for (let t = 0; t < cand.length && rivers < wantRivers; t++) {
      const c = cand[Math.floor(t * (cand.length / Math.max(1, wantRivers * 10)))];
      if (!c) break;
      const sx = c.i % w;
      const sy = (c.i - sx) / w;
      if (used.some((p) => Math.hypot(p.x - sx, p.y - sy) < Math.min(w, h) * 0.12)) continue;
      let cur = c.i;
      const path: number[] = [];
      let ok = false;
      for (let step = 0; step < 900; step++) {
        const x = cur % w;
        const y = (cur - x) / w;
        path.push(cur);
        if (hgt[cur] <= 0) { ok = path.length > 8; break; }
        let next = -1;
        let bv = hgt[cur] + (noise2(seedMorph + 91, x * 0.15, y * 0.15) - 0.5) * 0.06;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const k = ny * w + nx;
            /* 加一点噪声偏置 ⇒ 河道会蜿蜒。不加的话从高处沿最陡下降就是笔直一道
               （真机截图里那几道直蓝线就是这么来的，一点不像河）。 */
            const vv = hgt[k] + (noise2(seedMorph + 91, nx * 0.15, ny * 0.15) - 0.5) * 0.06;
            if (vv < bv) { bv = vv; next = k; }
          }
        }
        if (next < 0) break;
        cur = next;
      }
      if (!ok) continue;
      used.push({ x: sx, y: sy });
      rivers += 1;
      /* 折线存格坐标（渲染时 ×cell）；磨圆 + 抽稀，阶梯状的八邻域走法才像河 */
      riversV.push(thin(chaikinOpen(path.map((idx) => { const px = idx % w; return [px, (idx - px) / w] as [number, number]; }), 2), 1.2, false));
    }
  }

  /* ── 统计（提示行要如实报数）：海陆一律以**第一遍**的 raw vs sea 为准 */
  const comps = components(p1.raw, p1.sea, w, h);
  const landCells = comps.reduce((a, c) => a + c.area, 0);
  const summary: MapGenSummary = {
    lands: comps.filter((c) => c.area >= bigArea).length,
    islands: comps.filter((c) => c.area >= isleArea && c.area < bigArea).length,
    zones: zones.length,
    rivers,
    lakes: lakeV.length,   /* 报**真画出来的**湖岸数（参数里挑了几个 spot 是另一回事） */
    peak: Math.round(1200 + Math.max(0, p1.peak - p1.sea) * 7200),
    landRatio: Math.round((landCells / N) * 100) / 100,
  };
  return { w, h, cell, rgb, height: hgt, sea: 0, summary, coast: coastV, lakes: lakeV, rivers: riversV };
}

/** 分区统计（面板/助手提示用）：每种地形各占多少格 */
export function terrainZoneLabels(): string[] {
  return TERRAINS.map((t) => t.label);
}

/* ⭐ 2026-10-13（用户：「**要留一点输入口，比如向助手描述然后生成**」）：创作者说人话 → 参数。
   两个入口共用这一份，**不需要第二次 AI 调用**：关键词直接映射成参数，描述本身当种子
   （同样的描述 = 同一张图，改一个字 = 换一块大陆）。想不出词就用档位下拉框顶上。 */

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const NUM = '(\\d{1,2}|[一二两三四五六七八九十])';

function pickNum(text: string, re: RegExp): number | undefined {
  const m = text.match(re);
  if (!m) return undefined;
  const raw = m[1];
  const n = /^\d+$/.test(raw) ? Number(raw) : CN_NUM[raw];
  return Number.isFinite(n) ? Math.max(0, Math.min(12, n)) : undefined;
}

export interface MapPromptParse {
  style?: MapStyle;
  spec: MapSpec;
  matched: string[];
}

/** 描述 → 档位 + 数量。认不出任何关键词就返回空（调用方退回档位下拉框）。 */
export function parseMapPrompt(text: string): MapPromptParse {
  const t = String(text ?? '');
  const spec: MapSpec = {};
  const matched: string[] = [];
  let style: MapStyle | undefined;
  if (/盘古|超级大陆|一整块|整块大陆|pangaea/i.test(t)) { style = 'pangaea'; matched.push('盘古式超级大陆'); }
  else if (/群岛|岛链|岛屿群|一堆岛|散落.{0,2}岛|archipelago/i.test(t)) { style = 'archipelago'; matched.push('群岛'); }
  else if (/大陆|陆地|continent/i.test(t)) { style = 'continent'; matched.push('大陆'); }

  /* ⚠️ 「一片群岛」里的那个「一」不算岛的数量（负向断言把 群/链/屿 排掉），
     否则群岛档会被解析成"只长一座岛"，图就空了。 */
  const lands = pickNum(t, new RegExp(`${NUM}\\s*[块片个座]?\\s*(?:大)?陆`));
  const islands = pickNum(t, new RegExp(`${NUM}\\s*[座个片]?\\s*(?:大|小)?岛(?!群|链|屿)`));
  const ridges = pickNum(t, new RegExp(`${NUM}\\s*[条道列]?\\s*(?:山|山脉|山脊)`));
  const rivers = pickNum(t, new RegExp(`${NUM}\\s*[条道]?\\s*(?:大)?河`));
  const lakes = pickNum(t, new RegExp(`${NUM}\\s*[个片座]?\\s*(?:大)?湖`));
  if (lands != null) { spec.lands = lands; matched.push(`${lands} 块陆地`); }
  if (islands != null) { spec.islands = islands; matched.push(`${islands} 座岛`); }
  if (ridges != null) { spec.ridges = ridges; matched.push(`${ridges} 条山脉`); }
  if (rivers != null) { spec.rivers = rivers; matched.push(`${rivers} 条河`); }
  if (lakes != null) { spec.lakes = lakes; matched.push(`${lakes} 个湖`); }
  /* 只说了「群山 / 有湖」没给数字：给个温和的默认（不喧宾夺主） */
  if (ridges == null && /群山|多山|山脉|山地|崇山/.test(t)) { spec.ridges = 5; matched.push('多山'); }
  if (rivers == null && /河|水系|水流/.test(t) && !/没有河|无河/.test(t)) { spec.rivers = 3; matched.push('有河'); }
  if (lakes == null && /湖/.test(t) && !/没有湖|无湖/.test(t)) { spec.lakes = 3; matched.push('有湖'); }
  /* 点了名的地形类型也认（沙漠/森林/雪原/沼泽…）—— 记进 matched，交给分区规则自然长 */
  const named = TERRAINS.filter((x) => !x.water && t.includes(x.label)).map((x) => x.label);
  if (named.length) matched.push(`要${named.join('、')}`);
  return { style, spec, matched };
}

export interface MapGenInput {
  description?: string;
  seed?: string;
  style?: MapStyle;
  spec?: MapSpec;
}
export interface MapPlan {
  seed: string;
  style: MapStyle;
  spec: MapSpec;
  matched: string[];
}

/** 把「描述 + 显式参数」合成一份可复现的生成计划（纯函数，UI 与助手共用同一份规矩） */
export function planGeneration(input: MapGenInput): MapPlan {
  const desc = String(input.description ?? '').trim();
  const parsed = parseMapPrompt(desc);
  const seed = String(input.seed ?? '').trim() || desc || '灵框';
  return {
    seed,
    style: input.style ?? parsed.style ?? 'continent',
    spec: { ...parsed.spec, ...(input.spec ?? {}) },
    matched: parsed.matched,
  };
}

/** 默认空地图（`src/ui/map.ts` 首次进地图、以及助手在还没建过地图的世界里生成时共用） */
export const DEFAULT_MAP = (): MapData => ({ id: uid('m'), name: '默认地图', width: 900, height: 500, regions: [], markers: [], paths: [] });

export interface MapApplyResult {
  ok: boolean;
  note: string;
  plan?: MapPlan;
  summary?: MapGenSummary;
}

/** ⭐ **唯一**的落盘入口：地图面板的「生成地形」与助手的 `generate_map` 动作都走这里
    （一份实现 ⇒ 两条路的行为不会分叉）。一次 `store.update()` ⇒ 一步 Ctrl+Z 撤销；
    这个世界还没建过地图时顺手建一张默认地图，别让创作者先去点一次地图栏。
    ⚠️ 存的只是**参数**（种子/档位/数量），地形图在渲染时现算 ⇒ JSON 里只多几百字节。 */
export function generateIntoMap(store: Store, input: MapGenInput): MapApplyResult {
  const plan = planGeneration(input);
  const before = currentWorld(store).maps?.[0];
  const g = buildTerrain({ seed: plan.seed, style: plan.style, spec: plan.spec }, before?.width ?? 900, before?.height ?? 500);
  let created = false;
  store.update((d) => {
    const w = d.worldsets[store.activeWorld];
    if (!w) return;
    if (!w.maps?.length) { w.maps = [DEFAULT_MAP()]; created = true; }
    const m = w.maps[0];
    m.terrain = { seed: plan.seed, style: plan.style, spec: plan.spec };
  });
  const s = g.summary;
  const what = plan.matched.length ? `（按你说的：${plan.matched.join('、')}）` : '';
  return {
    ok: true,
    plan,
    summary: s,
    note:
      `${created ? '这个世界还没有地图，我顺手建了一张「默认地图」并' : `已在「${before?.name ?? '默认地图'}」上`}生成地形：` +
      `${s.lands} 块陆地 · ${s.islands} 座岛 · ${s.zones} 个地形区 · ${s.rivers} 条河 · ${s.lakes} 个湖 · ` +
      `最高峰约 ${s.peak} m（陆地占 ${Math.round(s.landRatio * 100)}%）${what}` +
      `（种子「${plan.seed}」，Ctrl+Z 可撤销，生成后照样能手绘精修）`,
  };
}
