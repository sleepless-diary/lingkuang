/** 手绘原型（第一百三十五轮）：**多图层 + 高精度 + RLE 压缩**。
 *
 *  用户 2026-10-31：「能不能把当前的地图编辑系统重构一下，我想要更高精度的手绘原型，以及能对原型
 *  进行区域噪声叠加（手动添加），以及在绘制原型时就能预设定高山等地形的位置」。
 *  追问后拍板：噪声**两个方向都要**（加噪 / 抹平）+ 一支「边缘复杂化」笔；原型 **1024×512**；
 *  地形预设 = **高山 / 丘陵 / 高原 / 盆地低地 / 湖泊内海**；气候底子 = **沙地 / 湿地**。
 *
 *  为什么不再用"2 bit/格、定长 base64"（第一百零八轮那套）：
 *    · 320×160 画不出海湾、半岛与山脉走向（用户原话「精细度不够」）；
 *    · 只有海陆一层 ⇒ 海拔全靠噪声，创作者没法说"这里必须是高山"；
 *    · 定长编码下 1024×512 的海陆一层就要 131KB 文本，五层直接爆掉 worldbuilding.json。
 *  ⇒ 每层各自 **RLE（游程）+ base64**：手画的都是大片同值区域，实测 1024×512 画满几块大陆
 *     也在 2~8KB 量级（`.review` 里的实测见 ARCHITECTURE 第一百三十五轮）。
 *
 *  ⚠️ 本文件是**纯数据层**（不 import store / UI）：`src/store/types.ts` 的 `MapProto` 与
 *  `ProtoStored` 结构相同，两边靠结构类型兼容（老规矩，见 `planet.ts` 头注释）。
 *  ⚠️ 编码一旦发版就不能改语义：`v` 是格式版本，`decodeProto()` 认不出的版本按 1 处理。
 */

/** 原型分辨率：等距圆柱 2:1（与星球图同域）。1024 = 底图 1536 宽的 2/3，
 *  每格在底图上约 1.5px ⇒ 手画的海湾/半岛/山脉走向都落得下。 */
export const PROTO_W = 1024;
export const PROTO_H = 512;
export const PROTO_VERSION = 1;

/** 海陆层（`land`）：0 = 没画（交给生成器）/ 1 = 陆地 / 2 = 海洋 */
export const LAND_NONE = 0;
export const LAND_SET = 1;
export const SEA_SET = 2;

/** 地形分区层（`zone`）—— 画在哪，海拔就按哪一档塑形 */
export const ZONE_NONE = 0;
export const ZONE_MOUNTAIN = 1;
export const ZONE_HILL = 2;
export const ZONE_PLATEAU = 3;
export const ZONE_BASIN = 4;
export const ZONE_LAKE = 5;

/** 气候底子层（`climate`）—— 只改湿度（⇒ 上色与植被），不改高度 */
export const CLIMATE_NONE = 0;
export const CLIMATE_DRY = 1;
export const CLIMATE_WET = 2;

/** 区域噪声层（`noise`）：**有符号** −8..8（0 = 没画）。
 *  正 = 加噪（山更密更碎、海岸更毛），负 = 抹平（冲积平原/盆地那种干净的低地）。 */
export const NOISE_MAX = 8;
/** 海岸复杂化层（`edge`）：0..8。**湍流置换**的强度（不是逐点加噪）。 */
export const EDGE_MAX = 8;
/** 锐利的海陆掩膜先糊开多少**原型格**再判阈值。
 *  这是"能把海岸挪动多少格"的分母：掩膜梯度 ≈ 1/(2·R)，阈值扰动 `amp` 挪动 `amp·2R` 格。
 *  R=10、amp 0.62 ⇒ 满强度时海岸最多挪 ≈ 12 格（1024 宽 ≈ 底图 19px）。 */
export const EDGE_BLUR_CELLS = 20;
/** 满强度时阈值扰动的幅度（相对 0..1 的海陆场；>0.5 会把整片糊掉的区域翻面，别贪大）。 */
export const EDGE_TURB_AMP = 0.6;

/* ── 湍流场（边缘复杂化）────────────────────────────────────────────────────
 *  用户 2026-10-31：「边缘复杂化怎么是纯随机啊，而不是湍流置换类的」。
 *  旧做法是在海陆判定上**逐格加**一圈高频 shore 噪声（`lf + wig > 0.5`）——
 *  每个像素各自摇一次硬币，结果就是"毛边 / 白噪音"，没有方向性。
 *
 *  为什么"直接把掩膜拿去域扭曲"不够（本轮实测）：手画掩膜是**锐利**的（0/1 跳变），
 *  双线性取样下梯度约为 1 格⁻¹，任何位移场只会把边界挪 **不到 1 格**；把位移调大到
 *  几十格，取样又会跳出笔迹范围 ⇒ 白洞/断崖。
 *
 *  正确做法（也是图像学里"用湍流置换一条等高线"的标准做法）：
 *    ① 先把海陆场**糊开**（`EDGE_BLUR_CELLS`）⇒ 梯度变缓，阈值挪一点边界就走很多格；
 *    ② 用一条**多尺度相干湍流**（本文件 `buildEdgeTurbulence`）去扰动阈值：
 *       `lf + t·amp > 0.5`。等值线于是沿着湍流场的等值线走 —— 连续、成条成团；
 *    ③ 湍流只取 16/32/64 格波长（**没有格点级高频**），所以不会出现"每格独立摇"的白毛。
 *  海岸因此被推成一串**峡湾 / 半岛 / 泻湖**；满强度 ≈ 十几格，且面积基本守恒。 */

function hash01(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const smoothstep01 = (t: number) => t * t * (3 - 2 * t);

/** 周期性值噪声（x 方向周期 = `cells` 格；y 不环绕）。原型是等距圆柱，经度必须闭合。 */
function periodicNoise(x: number, y: number, cells: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smoothstep01(xf), v = smoothstep01(yf);
  const x0 = ((xi % cells) + cells) % cells;
  const x1 = (x0 + 1) % cells;
  const a = hash01(x0, yi, seed), b = hash01(x1, yi, seed);
  const c = hash01(x0, yi + 1, seed), d = hash01(x1, yi + 1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/** 可分离**膨胀**（平方窗取最大值，x 环绕）：把「边缘」笔迹的强度往外扩 r 格。
 *  为什么需要：用户往往在离海岸几格的地方刷一笔；如果只按笔迹模糊，强度在到达海岸前
 *  就衰减没了 —— 内陆被啃出一个个**封闭的小海**（第一百三十六轮实测），而不是改海岸形状。
 *  先膨胀再模糊 ⇒ 海岸线上拿到接近满强度的扰动，凿出来的海湾与大海连通。 */
export function dilateField(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0) return src;
  const n = Math.max(0, w | 0) * Math.max(0, h | 0);
  const tmp = new Float32Array(n);
  const out = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let d = -r; d <= r; d++) {
        const v = src[row + ((x + d + w) % w)];
        if (v > m) m = v;
      }
      tmp[row + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let d = -r; d <= r; d++) {
        const yy = y + d < 0 ? 0 : (y + d >= h ? h - 1 : y + d);
        const v = tmp[yy * w + x];
        if (v > m) m = v;
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

/** 多尺度相干湍流场（零均值，RMS 归一）：16/32/64 格三档波长。画板预览与生成器共用。
 *  ⚠️ 三档都**不含格点级高频** —— 这是"湍流"与"白毛"的分界（旧版 shore 噪声含 freq 48 那档）。 */
export function buildEdgeTurbulence(w: number, h: number, seed = 1): Float32Array {
  const n = Math.max(1, w | 0) * Math.max(1, h | 0);
  const out = new Float32Array(n);
  const OCTAVES: [number, number][] = [[16, 0.5], [32, 0.3], [64, 0.2]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let o = 0; o < OCTAVES.length; o++) {
        const cells = OCTAVES[o][0];
        /* y 与 x 用同一格宽（原型 2:1）⇒ 湍流各向同性，不会被拉成横条 */
        v += periodicNoise((x / w) * cells, (y / w) * cells, cells, seed + cells + o * 131) * OCTAVES[o][1];
      }
      out[y * w + x] = v;
    }
  }
  /* 值噪声落在 0..1 ⇒ 先转成零均值，再按 RMS 归一（典型值 |t| ≈ 1，夹 ±1.6） */
  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i];
  mean /= Math.max(1, n);
  for (let i = 0; i < n; i++) out[i] = (out[i] - mean) * 2;
  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += out[i] * out[i];
  const rms = Math.sqrt(sumSq / Math.max(1, n)) || 1;
  for (let i = 0; i < n; i++) {
    const v = out[i] / rms;
    out[i] = v > 1.6 ? 1.6 : (v < -1.6 ? -1.6 : v);
  }
  return out;
}

/** 解码后的五层（生成器与画板共用同一套结构，都是整格数组）。 */
export interface ProtoLayers {
  w: number;
  h: number;
  /** 0 未画 / 1 陆 / 2 海 */
  land: Uint8Array;
  /** 见 ZONE_* */
  zone: Uint8Array;
  /** 见 CLIMATE_* */
  climate: Uint8Array;
  /** −NOISE_MAX..NOISE_MAX */
  noise: Int8Array;
  /** 0..EDGE_MAX */
  edge: Uint8Array;
}

/** 落盘形态（每层一个 RLE + base64 串；空层省略 ⇒ 老数据/没画的层不占地方）。 */
export interface ProtoStored {
  w: number;
  h: number;
  /** 格式版本（当前 1） */
  v?: number;
  land: string;
  zone?: string;
  climate?: string;
  noise?: string;
  edge?: string;
}

/** 老剪影（第一百零八轮）：2 bit/格定长 base64。只用于**读**旧数据。 */
export interface LegacyMaskStored {
  w: number;
  h: number;
  bits: string;
}

/** 生成器能接的任何原型输入：解码后的层 / 落盘形态 / 老剪影。 */
export type ProtoInput = ProtoLayers | ProtoStored | LegacyMaskStored;

/* ── 基础编解码 ─────────────────────────────────────────────────────────────── */

const CHUNK = 8192;

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(s);
}

/** LEB128（每字节 7 bit，高位续位）—— 游程长度几乎都是一位数/两位数，比写 4 字节定长省。 */
function pushVarint(out: number[], v: number): void {
  let n = Math.max(0, Math.floor(v));
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
}

/** 一层 → RLE + base64。`offset` 用来把有符号值抬成无符号（噪声层用 NOISE_MAX）。 */
export function encodeRle(vals: ArrayLike<number>, n: number, offset = 0): string {
  const out: number[] = [];
  let i = 0;
  while (i < n) {
    const v = (vals[i] | 0) + offset;
    let run = 1;
    while (i + run < n && (vals[i + run] | 0) + offset === v) run++;
    pushVarint(out, run);
    out.push(v & 0xff);
    i += run;
  }
  return bytesToB64(Uint8Array.from(out));
}

/** RLE + base64 → 一层（值已减去 `offset`；坏数据返回 null ⇒ 当没画）。 */
export function decodeRle(b64: string | undefined, n: number, offset = 0): Int16Array | null {
  if (!b64) return null;
  let bin: string;
  try { bin = atob(String(b64)); } catch { return null; }
  const out = new Int16Array(n);
  let pos = 0;
  let i = 0;
  while (i < n && pos < bin.length) {
    let run = 0;
    let shift = 0;
    for (;;) {
      if (pos >= bin.length) return out;
      const b = bin.charCodeAt(pos++) & 0xff;
      run |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
      if (shift > 28) return out;              /* 坏数据：别把内存填炸 */
    }
    if (pos >= bin.length) return out;
    const v = (bin.charCodeAt(pos++) & 0xff) - offset;
    const end = Math.min(n, i + run);
    for (; i < end; i++) out[i] = v;
  }
  return out;
}

/** 一层是不是全空（全 0）—— 落盘时省掉空层。 */
function layerEmpty(vals: ArrayLike<number>, n: number): boolean {
  for (let i = 0; i < n; i++) if (vals[i]) return false;
  return true;
}

/* ── 对外：空原型 / 编解码 / 兼容老剪影 ─────────────────────────────────────── */

export function emptyLayers(w: number = PROTO_W, h: number = PROTO_H): ProtoLayers {
  const n = Math.max(1, w | 0) * Math.max(1, h | 0);
  return {
    w: w | 0,
    h: h | 0,
    land: new Uint8Array(n),
    zone: new Uint8Array(n),
    climate: new Uint8Array(n),
    noise: new Int8Array(n),
    edge: new Uint8Array(n),
  };
}

/** 落盘形态（空层省略；`blankSea` 时把"没画"补成海洋 —— 画板那个勾选框）。 */
export function encodeProto(layers: ProtoLayers, opts?: { blankSea?: boolean }): ProtoStored {
  const { w, h } = layers;
  const n = Math.max(0, w | 0) * Math.max(0, h | 0);
  /* 「留白 = 海洋」：把 0 补成 2 再编码（只影响海陆层；别动别的层） */
  let land: ArrayLike<number> = layers.land;
  if (opts?.blankSea) {
    const copy = new Uint8Array(n);
    for (let i = 0; i < n; i++) copy[i] = layers.land[i] === LAND_NONE ? SEA_SET : layers.land[i];
    land = copy;
  }
  const out: ProtoStored = { w, h, v: PROTO_VERSION, land: encodeRle(land, n) };
  if (!layerEmpty(layers.zone, n)) out.zone = encodeRle(layers.zone, n);
  if (!layerEmpty(layers.climate, n)) out.climate = encodeRle(layers.climate, n);
  if (!layerEmpty(layers.noise, n)) out.noise = encodeRle(layers.noise, n, NOISE_MAX);
  if (!layerEmpty(layers.edge, n)) out.edge = encodeRle(layers.edge, n);
  return out;
}

/** 老剪影（2 bit/格，低位在前）→ 最近邻放大到原型分辨率。 */
function legacyToLayers(legacy: LegacyMaskStored): ProtoLayers | null {
  const sw = Math.max(1, legacy.w | 0);
  const sh = Math.max(1, legacy.h | 0);
  if (!legacy.bits) return null;
  let bin = '';
  try { bin = atob(String(legacy.bits)); } catch { return null; }
  if (bin.length < Math.ceil((sw * sh * 2) / 8)) return null;
  const src = new Uint8Array(sw * sh);
  for (let i = 0; i < src.length; i++) {
    const bit = i * 2;
    src[i] = ((bin.charCodeAt(bit >> 3) & 0xff) >> (bit & 7)) & 3;
  }
  const out = emptyLayers(PROTO_W, PROTO_H);
  for (let y = 0; y < PROTO_H; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / PROTO_H));
    const row = y * PROTO_W;
    for (let x = 0; x < PROTO_W; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / PROTO_W));
      out.land[row + x] = src[sy * sw + sx];
    }
  }
  return out;
}

/** 任何形态的原型 → 五层数组。没画过 / 坏数据返回 null（⇒ 照常生成，不挡路）。 */
export function decodeProto(
  proto?: ProtoStored | null,
  legacy?: LegacyMaskStored | null,
): ProtoLayers | null {
  if (proto && typeof proto.land === 'string' && proto.w > 0 && proto.h > 0) {
    const w = Math.max(1, Math.round(proto.w));
    const h = Math.max(1, Math.round(proto.h));
    const n = w * h;
    const out = emptyLayers(w, h);
    const land = decodeRle(proto.land, n);
    if (land) for (let i = 0; i < n; i++) out.land[i] = land[i] === LAND_SET || land[i] === SEA_SET ? land[i] : LAND_NONE;
    const zone = decodeRle(proto.zone, n);
    if (zone) for (let i = 0; i < n; i++) out.zone[i] = zone[i] >= 0 && zone[i] <= ZONE_LAKE ? zone[i] : ZONE_NONE;
    const climate = decodeRle(proto.climate, n);
    if (climate) for (let i = 0; i < n; i++) out.climate[i] = climate[i] >= 0 && climate[i] <= CLIMATE_WET ? climate[i] : CLIMATE_NONE;
    const noise = decodeRle(proto.noise, n, NOISE_MAX);
    if (noise) for (let i = 0; i < n; i++) out.noise[i] = Math.max(-NOISE_MAX, Math.min(NOISE_MAX, noise[i]));
    const edge = decodeRle(proto.edge, n);
    if (edge) for (let i = 0; i < n; i++) out.edge[i] = Math.max(0, Math.min(EDGE_MAX, edge[i]));
    return out;
  }
  if (legacy && legacy.bits) return legacyToLayers(legacy);
  return null;
}

/** 生成器入口：解码后的层直接用；落盘形态解码；老剪影放大。 */
export function decodeProtoInput(input?: ProtoInput | null): ProtoLayers | null {
  if (!input) return null;
  const anyIn = input as unknown as Record<string, unknown>;
  if (anyIn.land && typeof anyIn.land !== 'string') {
    const layers = input as ProtoLayers;
    if (layers.land instanceof Uint8Array && layers.w > 0 && layers.h > 0) return layers;
    return null;
  }
  if (typeof anyIn.land === 'string') return decodeProto(input as ProtoStored, null);
  if (typeof anyIn.bits === 'string') return decodeProto(null, input as LegacyMaskStored);
  return null;
}

/** 画过哪些东西（状态行 / 面板上的小字用）。**只数，不改数据**。 */
export function protoSummary(layers: ProtoLayers): {
  landPct: number; seaPct: number; blankPct: number;
  zone: Record<number, number>; climate: Record<number, number>;
  noiseUp: number; noiseDown: number; edge: number;
} {
  const n = layers.land.length || 1;
  let land = 0, sea = 0;
  const zone: Record<number, number> = {};
  const climate: Record<number, number> = {};
  let noiseUp = 0, noiseDown = 0, edge = 0;
  for (let i = 0; i < n; i++) {
    const v = layers.land[i];
    if (v === LAND_SET) land++;
    else if (v === SEA_SET) sea++;
    if (layers.zone[i]) zone[layers.zone[i]] = (zone[layers.zone[i]] ?? 0) + 1;
    if (layers.climate[i]) climate[layers.climate[i]] = (climate[layers.climate[i]] ?? 0) + 1;
    const nz = layers.noise[i];
    if (nz > 0) noiseUp++;
    else if (nz < 0) noiseDown++;
    if (layers.edge[i]) edge++;
  }
  const pct = (v: number) => Math.round((v / n) * 100);
  return {
    landPct: pct(land), seaPct: pct(sea), blankPct: 100 - pct(land) - pct(sea),
    zone, climate, noiseUp: pct(noiseUp), noiseDown: pct(noiseDown), edge: pct(edge),
  };
}
