/** 手绘原型（第一百三十五轮起；**第一百三十七轮改成图层列表**）。
 *
 *  用户 2026-10-31：「能不能把当前的地图编辑系统重构一下，我想要更高精度的手绘原型，以及能对原型
 *  进行区域噪声叠加（手动添加），以及在绘制原型时就能预设定高山等地形的位置」。
 *  2026-10-31 晚（第一百三十六轮）：「地形、气候常显；边缘画下即时生效；边缘改成湍流置换」。
 *  2026-10-31 深夜（第一百三十七轮）：「要是我想叠加多层怎么办，然后每层自定义湍流参数什么的」
 *  ⇒ 追问后拍板：**五类层都做成图层列表**（海陆 / 地形 / 气候 / 噪声 / 湍流），
 *     并且再加**变换工具**与**液化**；湍流层每层自带 尺度 / 幅度 / 细节层数 / 种子 / 混合方式 / 扩散半径。
 *
 *  数据形态（v2）：
 *    `MapProto.layers: ProtoLayer[]` —— **显示顺序 = 数组顺序（第一个在最上）**；
 *    每层一个 RLE+base64 的值网格（`bits`）+ 元信息（kind/name/on）+ 湍流参数。
 *    合成规则：
 *      · land / zone / climate：**从下往上**，非 0 的格子覆盖（上层优先，0 = 透明）；
 *      · noise：**求和**并夹在 −8..8（"区域噪声叠加"就是这个意思）；
 *      · turb：不进合成网格，生成时**逐层叠加扰动**（各自参数）。
 *    v1（单层 `land/zone/climate/noise/edge`）仍能读，自动展开成五层。
 *
 *  ⚠️ 本文件是**纯数据层**（不 import store / UI）：`src/store/types.ts` 的 `MapProto` 与
 *  `ProtoStored` 结构相同，两边靠结构类型兼容。
 *  ⚠️ 编码一旦发版就不能改语义：`v` 是格式版本（v2 = 图层列表）。
 */

/** 原型分辨率：等距圆柱 2:1（与星球图同域）。1024 = 底图 1536 宽的 2/3。 */
export const PROTO_W = 1024;
export const PROTO_H = 512;
export const PROTO_VERSION = 3;

/** 海陆层：0 = 没画（交给生成器）/ 1 = 陆地 / 2 = 海洋 */
export const LAND_NONE = 0;
export const LAND_SET = 1;
export const SEA_SET = 2;

/** 地形分区层 —— 画在哪，海拔就按哪一档塑形。
 *  ⭐ 第一百三十九轮：每格还带一个**强度 0~8**（用户：「每个地形笔刷能自行决定效果强度」）。
 *  存储时一个字节打包：低 3 位 = 类型码，高 4 位 = 强度。用 `ZONE_PACK / ZONE_CODE / ZONE_STRENGTH` 读写。 */
export const ZONE_NONE = 0;
export const ZONE_MOUNTAIN = 1;
export const ZONE_HILL = 2;
export const ZONE_PLATEAU = 3;
export const ZONE_BASIN = 4;
export const ZONE_LAKE = 5;
/** 平原 / 低起伏：只压起伏、不改基面（接替"噪声层抹平"的用途） */
export const ZONE_PLAIN = 6;
export const ZONE_STRENGTH_MAX = 8;

/** 类型码（低 3 位） */
export const ZONE_CODE = (v: number): number => v & 7;
/** 强度 0..8（高 4 位） */
export const ZONE_STRENGTH = (v: number): number => (v >> 3) & 15;
/** 打包：类型 + 强度（强度 0 视为"没画"由调用方处理；强度实际写 1..8） */
export const ZONE_PACK = (code: number, strength: number): number =>
  (code & 7) | ((Math.max(0, Math.min(15, Math.round(strength))) & 15) << 3);
/** 老的"纯类型"值（1..6，没打包）→ 满强度；0 保持"没画" */
export const ZONE_NORMALIZE = (v: number): number => (v > 0 && v <= 7 ? ZONE_PACK(v, ZONE_STRENGTH_MAX) : v);

/** 气候底子层 —— 只改湿度（⇒ 上色与植被），不改高度 */
export const CLIMATE_NONE = 0;
export const CLIMATE_DRY = 1;
export const CLIMATE_WET = 2;

/** 区域噪声层：**有符号** −8..8（0 = 没画）。正 = 加噪、负 = 抹平。 */
export const NOISE_MAX = 8;
/** 湍流层（强度笔迹）：0..8。 */
export const EDGE_MAX = 8;

/** 湍流层的默认参数（新建层 / 老数据迁移都用它）。 */
export const TURB_DEFAULTS = {
  scale: 1,              /* 波长倍数：0.5 细碎 … 3 大海湾 */
  amp: 0.6,              /* 幅度：0.2..1.2 */
  octaves: 3,            /* 细节层数：1..4 */
  seed: 0,               /* 种子偏移：同参数也能换形状 */
  blend: 'add' as TurbBlend,
  diffusion: 10,         /* 笔迹强度的膨胀半径（格） */
  /* ⭐ 第一百四十一轮：沿岸带（band）模式。开启后 `data` 不再是"强度笔迹"，
     而是**闸门**（1 = 这条海岸要受影响），强度由下面的带宽/衰减 + 当前海岸线实时算出来，
     所以形状怎么变（变换 / 液化 / 重画），效果都自动贴着海岸走。 */
  band: false,           /* 老层默认仍是"笔迹"模式（照旧读、照旧生成） */
  bandWidth: 18,         /* 沿岸带宽度（格）：离海岸多远还有效 */
  bandFalloff: 0.55,     /* 0..1：越接近 1，边缘越陡（贴岸硬边）；0 = 一路平缓衰减 */
};
export type TurbBlend = 'add' | 'grow' | 'erode';

export type ProtoLayerKind = 'land' | 'zone' | 'climate' | 'noise' | 'turb';
export const PROTO_KINDS: ProtoLayerKind[] = ['land', 'zone', 'climate', 'noise', 'turb'];
export const KIND_LABEL: Record<ProtoLayerKind, string> = {
  land: '海陆', zone: '地形', climate: '气候', noise: '噪声', turb: '湍流',
};

/** 落盘形态的一层（`bits` = RLE+base64；参数只对 turb 有意义）。 */
export interface ProtoLayer {
  id: string;
  kind: ProtoLayerKind;
  name: string;
  /** 缺省 true；false = 隐藏（不参与合成 / 生成） */
  on?: boolean;
  bits: string;
  scale?: number;
  amp?: number;
  octaves?: number;
  seed?: number;
  blend?: TurbBlend;
  diffusion?: number;
  /** v3：沿岸带模式（只有 turb 层有意义） */
  band?: boolean;
  bandWidth?: number;
  bandFalloff?: number;
}

/** 落盘形态（v2）。v1 的 `land/zone/climate/noise/edge` 只为读旧数据保留。 */
export interface ProtoStored {
  w: number;
  h: number;
  v?: number;
  layers?: ProtoLayer[];
  /* ── v1 兼容（只读）── */
  land?: string;
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

/** 解码后的一层（画板与生成器都吃这个）。 */
export interface DecodedLayer {
  id: string;
  kind: ProtoLayerKind;
  name: string;
  on: boolean;
  data: Uint8Array | Int8Array;
  scale: number;
  amp: number;
  octaves: number;
  seed: number;
  blend: TurbBlend;
  diffusion: number;
  /** 湍流层：沿岸带模式（`data` 当"闸门"用，强度由海岸线实时算） */
  band: boolean;
  bandWidth: number;
  bandFalloff: number;
}

/** 解码后的整份原型（图层顺序 = 显示顺序，第一个在最上）。 */
export interface ProtoDoc {
  w: number;
  h: number;
  layers: DecodedLayer[];
}

/** 生成器能接的任何原型输入：解码后的 doc / 落盘形态 / 老剪影。 */
export type ProtoInput = ProtoDoc | ProtoStored | LegacyMaskStored;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/* ── 基础编解码（RLE + base64）────────────────────────────────────────────── */

const CHUNK = 8192;

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(s);
}

/** LEB128（每字节 7 bit，高位续位）。 */
function pushVarint(out: number[], v: number): void {
  let n = Math.max(0, Math.floor(v));
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
}

/** 一层 → RLE + base64。`offset` 把有符号值抬成无符号（噪声层用 NOISE_MAX）。 */
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

/** RLE + base64 → 一层（值已减去 `offset`；坏数据返回 null）。 */
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
      if (shift > 28) return out;
    }
    if (pos >= bin.length) return out;
    const v = (bin.charCodeAt(pos++) & 0xff) - offset;
    const end = Math.min(n, i + run);
    for (; i < end; i++) out[i] = v;
  }
  return out;
}

/* ── 图层模型 ─────────────────────────────────────────────────────────────── */

let layerSeq = 0;
function nextId(): string {
  layerSeq++;
  return `l${layerSeq.toString(36)}${Date.now().toString(36).slice(-4)}`;
}

function emptyData(kind: ProtoLayerKind, n: number): Uint8Array | Int8Array {
  return kind === 'noise' ? new Int8Array(n) : new Uint8Array(n);
}

/** 新建一层（参数用默认值）。 */
export function newLayer(kind: ProtoLayerKind, name?: string, w = PROTO_W, h = PROTO_H): DecodedLayer {
  const n = Math.max(1, w | 0) * Math.max(1, h | 0);
  return {
    id: nextId(),
    kind,
    name: name ?? KIND_LABEL[kind],
    on: true,
    data: emptyData(kind, n),
    ...TURB_DEFAULTS,
  };
}

/** 空原型：五类层各一张（空网格）——画板一打开就有列表。 */
/** 新原型默认建这几层（⭐ 第一百三十九轮起**不再新建噪声层**：强度已并进地形笔刷；
 *  老的噪声层仍能读、仍参与生成，只是 UI 里只读）。 */
export const DEFAULT_KINDS: ProtoLayerKind[] = ['land', 'zone', 'climate', 'turb'];

export function emptyDoc(w = PROTO_W, h = PROTO_H): ProtoDoc {
  return { w, h, layers: DEFAULT_KINDS.map((k) => newLayer(k, KIND_LABEL[k], w, h)) };
}

/** 层的值域（解码时夹紧 / 画板写入时参考）。 */
export function valueRange(kind: ProtoLayerKind): [number, number] {
  switch (kind) {
    case 'land': return [0, 2];
    case 'zone': return [0, ZONE_PACK(7, 15)];
    case 'climate': return [0, 2];
    case 'noise': return [-NOISE_MAX, NOISE_MAX];
    default: return [0, EDGE_MAX];
  }
}

function decodeLayer(raw: ProtoLayer, w: number, h: number): DecodedLayer | null {
  if (!raw || !raw.kind || !PROTO_KINDS.includes(raw.kind)) return null;
  const n = w * h;
  const offset = raw.kind === 'noise' ? NOISE_MAX : 0;
  const vals = decodeRle(raw.bits, n, offset);
  const data = emptyData(raw.kind, n);
  if (vals) {
    const [lo, hi] = valueRange(raw.kind);
    for (let i = 0; i < n; i++) {
      const v = clamp(vals[i], lo, hi);
      /* 地形层：老数据是"纯类型码 1..6"（没强度）⇒ 迁移成满强度 */
      data[i] = raw.kind === 'zone' ? ZONE_NORMALIZE(v) : v;
    }
  }
  return {
    id: raw.id || nextId(),
    kind: raw.kind,
    name: String(raw.name || KIND_LABEL[raw.kind]),
    on: raw.on !== false,
    data,
    scale: clamp(Number(raw.scale ?? TURB_DEFAULTS.scale), 0.5, 3),
    amp: clamp(Number(raw.amp ?? TURB_DEFAULTS.amp), 0.2, 1.2),
    octaves: clamp(Math.round(Number(raw.octaves ?? TURB_DEFAULTS.octaves)), 1, 4),
    seed: Math.round(Number(raw.seed ?? TURB_DEFAULTS.seed)) || 0,
    blend: raw.blend === 'grow' || raw.blend === 'erode' ? raw.blend : 'add',
    diffusion: clamp(Math.round(Number(raw.diffusion ?? TURB_DEFAULTS.diffusion)), 0, 24),
    band: raw.band === true,
    bandWidth: clamp(Math.round(Number(raw.bandWidth ?? TURB_DEFAULTS.bandWidth)), 2, 80),
    bandFalloff: clamp(Number(raw.bandFalloff ?? TURB_DEFAULTS.bandFalloff), 0, 1),
  };
}

/** 落盘形态 → 解码 doc。认 v2（layers）/ v1（五张平铺字段）/ 老剪影。 */
export function decodeProto(
  proto?: ProtoStored | null,
  legacy?: LegacyMaskStored | null,
): ProtoDoc | null {
  if (proto && Array.isArray(proto.layers) && proto.layers.length) {
    const w = Math.max(1, Math.round(proto.w || PROTO_W));
    const h = Math.max(1, Math.round(proto.h || PROTO_H));
    const layers: DecodedLayer[] = [];
    for (const raw of proto.layers) {
      const l = decodeLayer(raw, w, h);
      if (l) layers.push(l);
    }
    if (layers.length) return { w, h, layers };
  }
  if (proto && (typeof proto.land === 'string' || typeof proto.zone === 'string'
    || typeof proto.climate === 'string' || typeof proto.noise === 'string' || typeof proto.edge === 'string')) {
    const w = Math.max(1, Math.round(proto.w || PROTO_W));
    const h = Math.max(1, Math.round(proto.h || PROTO_H));
    const doc: ProtoDoc = { w, h, layers: [] };
    const add = (kind: ProtoLayerKind, bits?: string) => {
      const l = newLayer(kind, KIND_LABEL[kind], w, h);
      const vals = decodeRle(bits, w * h, kind === 'noise' ? NOISE_MAX : 0);
      if (vals) {
        const [lo, hi] = valueRange(kind);
        for (let i = 0; i < vals.length; i++) {
          const v = clamp(vals[i], lo, hi);
          l.data[i] = kind === 'zone' ? ZONE_NORMALIZE(v) : v;
        }
      }
      doc.layers.push(l);
    };
    add('land', proto.land);
    add('zone', proto.zone);
    add('climate', proto.climate);
    add('noise', proto.noise);
    add('turb', proto.edge);
    return doc;
  }
  if (legacy && legacy.bits) return legacyDoc(legacy);
  return null;
}

/** 老剪影（2 bit/格，任意分辨率）→ 最近邻放大成一张海陆层 + 其余空层。 */
function legacyDoc(legacy: LegacyMaskStored): ProtoDoc | null {
  const sw = Math.max(1, legacy.w | 0);
  const sh = Math.max(1, legacy.h | 0);
  let bin = '';
  try { bin = atob(String(legacy.bits)); } catch { return null; }
  if (bin.length < Math.ceil((sw * sh * 2) / 8)) return null;
  const src = new Uint8Array(sw * sh);
  for (let i = 0; i < src.length; i++) {
    const bit = i * 2;
    src[i] = ((bin.charCodeAt(bit >> 3) & 0xff) >> (bit & 7)) & 3;
  }
  const doc = emptyDoc();
  const land = doc.layers.find((l) => l.kind === 'land');
  if (!land) return doc;
  for (let y = 0; y < PROTO_H; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / PROTO_H));
    for (let x = 0; x < PROTO_W; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / PROTO_W));
      land.data[y * PROTO_W + x] = src[sy * sw + sx];
    }
  }
  return doc;
}

/** 任何形态的原型 → 解码 doc（坏数据 / 空数据返回 null）。 */
export function decodeProtoInput(input?: ProtoInput | null): ProtoDoc | null {
  if (!input) return null;
  const any = input as unknown as Record<string, unknown>;
  if (Array.isArray(any.layers)) {
    const first = (any.layers as unknown[])[0] as Record<string, unknown> | undefined;
    if (first && (first.data instanceof Uint8Array || first.data instanceof Int8Array)) {
      const doc = input as ProtoDoc;
      if (doc.w > 0 && doc.h > 0 && doc.layers.length) return doc;
      return null;
    }
    return decodeProto(input as ProtoStored, null);
  }
  if (typeof any.land === 'string' || typeof any.zone === 'string' || typeof any.climate === 'string'
    || typeof any.noise === 'string' || typeof any.edge === 'string') {
    return decodeProto(input as ProtoStored, null);
  }
  if (typeof any.bits === 'string') return decodeProto(null, input as LegacyMaskStored);
  return null;
}

/** 解码 doc → 落盘形态（参数取两位小数，避免浮点噪声把 JSON 撑大）。 */
export function encodeProto(doc: ProtoDoc): ProtoStored {
  const w = Math.max(1, Math.round(doc.w));
  const h = Math.max(1, Math.round(doc.h));
  const n = w * h;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const layers: ProtoLayer[] = doc.layers.map((l) => {
    const out: ProtoLayer = {
      id: l.id,
      kind: l.kind,
      name: l.name,
      bits: encodeRle(l.data, n, l.kind === 'noise' ? NOISE_MAX : 0),
    };
    if (!l.on) out.on = false;
    if (l.kind === 'turb') {
      out.scale = r2(l.scale);
      out.amp = r2(l.amp);
      out.octaves = Math.round(l.octaves);
      out.seed = Math.round(l.seed);
      out.blend = l.blend;
      out.diffusion = Math.round(l.diffusion);
      if (l.band) {
        out.band = true;
        out.bandWidth = Math.round(l.bandWidth);
        out.bandFalloff = r2(l.bandFalloff);
      }
    }
    return out;
  });
  return { w, h, v: PROTO_VERSION, layers };
}

/* ── 沿岸带（第一百四十一轮）────────────────────────────────────────────────── */

/**
 * 到最近海岸的格距（BFS 四邻；**横向环绕**、纵向夹住，与地图的星球口径一致）。
 * @param coast 长度 w*h：非 0 视为海岸
 * @param maxD 超过这个距离一律按 maxD 记（省一点内存带宽）
 */
export function coastDistanceField(coast: Uint8Array, w: number, h: number, maxD = 96): Float32Array {
  const n = w * h;
  const dist = new Float32Array(n).fill(maxD);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    if (coast[i]) { dist[i] = 0; queue[tail++] = i; }
  }
  if (tail === 0) return dist;
  while (head < tail) {
    const i = queue[head++];
    const d = dist[i] + 1;
    if (d >= maxD) continue;
    const x = i % w, y = (i / w) | 0;
    const left = y * w + ((x - 1 + w) % w);
    const right = y * w + ((x + 1) % w);
    const up = y > 0 ? i - w : -1;
    const down = y < h - 1 ? i + w : -1;
    if (dist[left] > d) { dist[left] = d; queue[tail++] = left; }
    if (dist[right] > d) { dist[right] = d; queue[tail++] = right; }
    if (up >= 0 && dist[up] > d) { dist[up] = d; queue[tail++] = up; }
    if (down >= 0 && dist[down] > d) { dist[down] = d; queue[tail++] = down; }
  }
  return dist;
}

/** 沿岸带强度（0..1）：离岸越近越强，`width` 之外为 0；`falloff` 越大边缘越陡。 */
export function bandStrengthAt(distance: number, width: number, falloff: number): number {
  const w = Math.max(1, width);
  const t = distance / w;
  if (t >= 1) return 0;
  return Math.pow(1 - t, 1 + Math.max(0, Math.min(1, falloff)) * 3);
}

/** 整张沿岸带强度场（`gate` 非 0 的格子才算 —— 闸门就是"哪几条海岸"）。 */
export function bandField(dist: Float32Array, gate: ArrayLike<number> | null, width: number, falloff: number): Float32Array {
  const n = dist.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (gate && !gate[i]) continue;
    out[i] = bandStrengthAt(dist[i], width, falloff);
  }
  return out;
}

/* ── 合成（生成器与画板共用同一套规则）────────────────────────────────────── */

/** land / zone / climate 的合成：**从下往上**，非 0 覆盖（第一个 = 最上层）。 */
export function compositeU8(doc: ProtoDoc, kind: 'land' | 'zone' | 'climate'): Uint8Array {
  const n = doc.w * doc.h;
  const out = new Uint8Array(n);
  for (let li = doc.layers.length - 1; li >= 0; li--) {
    const l = doc.layers[li];
    if (!l.on || l.kind !== kind) continue;
    const data = l.data as Uint8Array;
    for (let i = 0; i < n; i++) if (data[i]) out[i] = data[i];
  }
  return out;
}

/** noise 的合成：所有可见噪声层**求和**并夹在 −8..8（这就是"叠加"）。 */
export function compositeNoise(doc: ProtoDoc): Int8Array {
  const n = doc.w * doc.h;
  const out = new Int8Array(n);
  for (let li = doc.layers.length - 1; li >= 0; li--) {
    const l = doc.layers[li];
    if (!l.on || l.kind !== 'noise') continue;
    const data = l.data;
    for (let i = 0; i < n; i++) out[i] = clamp(out[i] + data[i], -NOISE_MAX, NOISE_MAX);
  }
  return out;
}

/** 参与生成的湍流层（保持显示顺序）。 */
export function turbLayers(doc: ProtoDoc): DecodedLayer[] {
  return doc.layers.filter((l) => l.kind === 'turb' && l.on);
}

/* ── 湍流场与工具 ─────────────────────────────────────────────────────────── */

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

/** 可分离**膨胀**（平方窗取最大值，x 环绕）：把笔迹强度往外扩 r 格。
 *  必须先膨胀再模糊：否则"离海岸几格"的笔迹强度在半路就衰减没了，
 *  凿出来的海湾会变成内陆封闭小海。 */
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

/** 多尺度相干湍流场（零均值、RMS 归一、夹 ±1.6）。
 *  `scale` 缩放波长（0.5 细碎 … 3 大海湾），`octaves` 取前几档（1 圆润 … 4 带细碎毛边）。
 *  ⚠️ 不含格点级高频 —— 这是"湍流"与"白毛"的分界。 */
export function buildEdgeTurbulence(
  w: number, h: number, seed = 1, opts?: { scale?: number; octaves?: number },
): Float32Array {
  const n = Math.max(1, w | 0) * Math.max(1, h | 0);
  const out = new Float32Array(n);
  const scale = clamp(Number(opts?.scale ?? 1), 0.5, 3);
  const oct = clamp(Math.round(Number(opts?.octaves ?? 3)), 1, 4);
  const BASE = [16, 32, 64, 128];
  const WEIGHT = [0.5, 0.28, 0.14, 0.08];
  const octaves: [number, number][] = [];
  for (let o = 0; o < oct; o++) octaves.push([Math.max(2, Math.round(BASE[o] * scale)), WEIGHT[o]]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let o = 0; o < octaves.length; o++) {
        const cells = octaves[o][0];
        /* y 与 x 用同一格宽（原型 2:1）⇒ 各向同性 */
        v += periodicNoise((x / w) * cells, (y / w) * cells, cells, seed + cells + o * 131) * octaves[o][1];
      }
      out[y * w + x] = v;
    }
  }
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
