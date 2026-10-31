/** 手绘原型画板（第一百零八轮起；**第一百三十七轮改成图层列表 + 变换 + 液化**）。
 *
 *  用户原话（第一百三十五轮）：「我想要更高精度的手绘原型，以及能对原型进行区域噪声叠加
 *  （手动添加），以及在绘制原型时就能预设定高山等地形的位置」。
 *  第一百三十六轮：「地形、气候常显；边缘画下即时生效；边缘改成湍流置换」。
 *  ⭐ 第一百三十七轮：「要是我想叠加多层怎么办，然后每层自定义湍流参数什么的」
 *  ⇒ 拍板：**五类层全做成图层列表**（海陆 / 地形 / 气候 / 噪声 / 湍流，可多张、可排序/显隐/重命名），
 *     湍流层每层自带 **尺度 / 幅度 / 细节层数 / 种子 / 混合方式 / 扩散半径**；
 *     另加 **变换工具**（移动/缩放/旋转）与 **液化**（推挤 / 膨胀 / 收缩）。
 *
 *  合成规则（与 `src/mapgen/planet.ts` 生成时同一套）：
 *    · 海陆 / 地形 / 气候：从下往上，**上层非 0 的格子覆盖下层**（0 = 透明）；
 *    · 噪声：所有可见噪声层**求和**（夹 −8..8）；
 *    · 湍流：不进网格合成，生成时**逐层叠加扰动**（各自参数）。
 *
 *  ⚠️ 界面不用 emoji、不用黄色系文字（AGENTS.md），颜色只用 tokens.css 的变量；
 *  画布里的配色是**地图语义色**，不参与文字对比度那条规矩。 */

import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import type { MapMask, MapProto } from '../store/types';
import {
  CLIMATE_DRY, CLIMATE_WET, EDGE_MAX, KIND_LABEL, NOISE_MAX, PROTO_H, PROTO_W, PROTO_KINDS,
  ZONE_BASIN, ZONE_CODE, ZONE_HILL, ZONE_LAKE, ZONE_MOUNTAIN, ZONE_PACK, ZONE_PLAIN, ZONE_PLATEAU,
  ZONE_STRENGTH, ZONE_STRENGTH_MAX,
  buildEdgeTurbulence, compositeNoise, compositeU8, decodeProtoInput, dilateField, emptyDoc,
  encodeProto, newLayer, turbLayers,
  type DecodedLayer, type ProtoDoc, type ProtoLayerKind, type TurbBlend,
} from '../mapgen/proto';
import { nextFrame, showBusy } from './busy';
import { closeLightbox, isLightboxOpen } from './lightbox';
import { generateIntoMap } from './map-gen';

/** 原型分辨率（老名字保留：外部只关心"这块画板有多大"）。 */
export const MASK_W = PROTO_W;
export const MASK_H = PROTO_H;
const MAX_UNDO = 30;
const ZOOM_MIN = 1;
const ZOOM_MAX = 24;
const TURB_LAND_BLUR = 20;   /* 海陆场糊开多少格（决定湍流能把海岸推多远），与生成器一致 */

type Mode = 'brush' | 'transform' | 'liquify';
type LiquifyKind = 'push' | 'pinch' | 'bulge';
type RGB = [number, number, number];

interface Brush { id: string; label: string; hint: string; value: number }

const PALETTES: Record<ProtoLayerKind, Brush[]> = {
  land: [
    { id: 'land', label: '陆地', hint: '涂成陆地（还没画的地方交给生成器）', value: 1 },
    { id: 'sea', label: '海洋', hint: '涂成海洋 —— 也就是把这一块从陆地擦掉', value: 2 },
  ],
  zone: [
    { id: 'mountain', label: '高山', hint: '山脉 / 高峰：山脊放大 + 基面抬高（强度 = 山有多高多崎岖）', value: ZONE_MOUNTAIN },
    { id: 'hill', label: '丘陵', hint: '中等起伏：山脊略放大、基面微微抬高（强度 = 起伏大小）', value: ZONE_HILL },
    { id: 'plateau', label: '高原', hint: '抬高的平顶：基面抬高 + 起伏压平（强度 = 抬多高）', value: ZONE_PLATEAU },
    { id: 'basin', label: '盆地', hint: '低地：基面压低、起伏再压一半（强度 = 压多低）', value: ZONE_BASIN },
    { id: 'plain', label: '平原', hint: '只压起伏、不改基面（接替老噪声层的「抹平」）', value: ZONE_PLAIN },
    { id: 'lake', label: '湖泊/内海', hint: '直接钉成水面（离岸越近越浅，不会变成深海）', value: ZONE_LAKE },
    { id: 'erase', label: '擦除', hint: '把这一层擦回"没画"（别的层不动）', value: 0 },
  ],
  climate: [
    { id: 'dry', label: '沙地', hint: '干燥底子：湿度压低 ⇒ 荒漠/草原色，河更少', value: CLIMATE_DRY },
    { id: 'wet', label: '湿地', hint: '湿润底子：湿度抬高 ⇒ 森林色，河更多', value: CLIMATE_WET },
    { id: 'erase', label: '擦除', hint: '把这一层擦回"没画"', value: 0 },
  ],
  noise: [
    { id: 'noise-up', label: '加噪', hint: '这一片更崎岖：山脊/细节一起放大（强度用顶栏滑块）', value: 1 },
    { id: 'noise-down', label: '抹平', hint: '这一片更平：起伏与细节一起压下去', value: -1 },
    { id: 'erase', label: '擦除', hint: '把噪声擦掉', value: 0 },
  ],
  turb: [
    { id: 'turb', label: '湍流强度', hint: '沿岸刷：这一层的湍流会把海岸推开（强度用顶栏滑块）', value: 1 },
    { id: 'erase', label: '擦除', hint: '把这一层的笔迹擦掉', value: 0 },
  ],
};

/* 画布里的颜色（地图语义色，不是文字色）*/
const C_UNSET: RGB = [201, 198, 189];
const C_LAND: RGB = [123, 149, 87];
const C_SEA: RGB = [47, 111, 142];
const C_ZONE: Record<number, RGB> = {
  [ZONE_MOUNTAIN]: [107, 82, 54],
  [ZONE_HILL]: [143, 122, 78],
  [ZONE_PLATEAU]: [169, 143, 92],
  [ZONE_BASIN]: [122, 138, 102],
  [ZONE_PLAIN]: [146, 156, 126],
  [ZONE_LAKE]: [63, 127, 166],
};
const C_CLIMATE: Record<number, RGB> = {
  [CLIMATE_DRY]: [201, 163, 94],
  [CLIMATE_WET]: [79, 125, 99],
};
const C_NOISE_UP: RGB = [194, 90, 74];
const C_NOISE_DOWN: RGB = [91, 127, 181];
const C_TURB: RGB = [88, 168, 184];
const C_KIND: Record<ProtoLayerKind, string> = {
  land: '#7b9557', zone: '#8f7a4e', climate: '#c9a35e', noise: '#c25a4a', turb: '#58a8b8',
};

let openEl: HTMLElement | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let keyUpHandler: ((e: KeyboardEvent) => void) | null = null;
let hostStore: Store | null = null;

/* 画板状态（模块级：关掉再开，画到一半的原型还在） */
let doc: ProtoDoc = emptyDoc();
let activeId = '';
let mode: Mode = 'brush';
let toolId = 'land';
/** 每个类别各自记住上次用的笔刷 —— 否则「笔刷 id 撞名」（比如 zone 的 erase 与 turb 的 erase）
 *  会让切到湍流层后仍然在"擦除"，看起来像"还在画海陆"（第一百三十八轮用户报的就是这个）。 */
const toolByKind: Partial<Record<ProtoLayerKind, string>> = {};
let lastKind: ProtoLayerKind | null = null;
let brushCells = 8;
let strength = 5;
let liquifyKind: LiquifyKind = 'push';
let zoom = 1;
let panX = 0;
let panY = 0;
type UndoEntry =
  | { type: 'data'; id: string; data: Uint8Array | Int8Array }
  | { type: 'doc'; layers: DecodedLayer[] };
let undoStack: UndoEntry[] = [];

export function isMapEditorOpen(): boolean {
  return !!openEl && document.body.contains(openEl);
}

export function clearEditorMask(): void {
  doc = emptyDoc();
  undoStack = [];
}

/** 把任意尺寸的解码结果对齐到 1024×512（老原型/异常数据）：最近邻，够用且不引入模糊。 */
function fitDoc(src: ProtoDoc): ProtoDoc {
  if (src.w === PROTO_W && src.h === PROTO_H) return src;
  const out = emptyDoc();
  out.layers = src.layers.map((l) => {
    const n = PROTO_W * PROTO_H;
    const data = l.kind === 'noise' ? new Int8Array(n) : new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const y = (i / PROTO_W) | 0, x = i - y * PROTO_W;
      const sy = Math.min(src.h - 1, Math.floor((y * src.h) / PROTO_H));
      const sx = Math.min(src.w - 1, Math.floor((x * src.w) / PROTO_W));
      data[i] = l.data[sy * src.w + sx];
    }
    return { ...l, data };
  });
  return out;
}

const hashSeed = (text: string): number => {
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return (h >>> 1) || 1;
};

/* ── 打开画板 ─────────────────────────────────────────────────────────────── */

/** 不给原型就沿用这张地图现在那份（"在现有原型上接着改"；老剪影会自动放大）。 */
export function openMapEditor(store: Store, opts?: { proto?: MapProto; mask?: MapMask }): void {
  if (isLightboxOpen()) closeLightbox();
  closeMapEditor();
  hostStore = store;
  const m = currentWorld(store).maps?.[0];
  const src = opts?.proto ?? opts?.mask ?? m?.terrain?.proto ?? m?.terrain?.mask;
  const decoded = src ? decodeProtoInput(src) : null;
  doc = decoded ? fitDoc(decoded) : emptyDoc();
  if (!doc.layers.length) doc = emptyDoc();
  undoStack = [];
  mode = 'brush';
  toolId = 'land';
  brushCells = 8;
  strength = 5;
  liquifyKind = 'push';
  zoom = 1;
  panX = 0;
  panY = 0;
  activeId = (doc.layers.find((l) => l.kind === 'land') ?? doc.layers[0]).id;

  const el = document.createElement('div');
  el.className = 'lk-ed';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', '手绘原型');
  el.innerHTML = `
    <div class="lk-ed__bar">
      <span class="lk-ed__title">手绘原型</span>
      <span class="lk-ed__hint" id="ed-hint">1024×512 · 图层列表 · 滚轮缩放 · 中键 / 空格+左键拖动</span>
      <span class="lk-ed__spacer"></span>
      <span class="lk-ed__group" id="ed-modes">
        <button class="lk-ed__tool" data-mode="brush" title="画笔：在选中图层上涂">画笔</button>
        <button class="lk-ed__tool" data-mode="transform" title="变换：拖动移动 / 拖角缩放 / 拖顶部圆点旋转">变换</button>
        <button class="lk-ed__tool" data-mode="liquify" title="液化：推挤 / 膨胀 / 收缩当前图层">液化</button>
      </span>
      <label class="lk-ed__slider" title="笔刷大小（单位：原型格）">
        <span>笔刷</span>
        <input type="range" id="ed-brush" min="1" max="40" step="1" value="8">
        <span class="lk-ed__val" id="ed-brush-n">8</span>
      </label>
      <label class="lk-ed__slider" id="ed-strength-box" title="强度（噪声 / 湍流 / 液化用）">
        <span>强度</span>
        <input type="range" id="ed-strength" min="1" max="8" step="1" value="5">
        <span class="lk-ed__val" id="ed-strength-n">5</span>
      </label>
      <span class="lk-ed__group">
        <button class="lk-ed__btn" id="ed-zoom-out" title="缩小">−</button>
        <button class="lk-ed__btn" id="ed-zoom-fit" title="适应窗口（1×）">适应</button>
        <button class="lk-ed__btn" id="ed-zoom-in" title="放大">＋</button>
        <span class="lk-ed__val" id="ed-zoom">100%</span>
      </span>
      <span class="lk-ed__group">
        <button class="lk-ed__btn" id="ed-undo" title="撤销（Ctrl+Z）">撤销</button>
        <button class="lk-ed__btn" id="ed-export" title="把当前图层导出为 PNG">导出</button>
      </span>
      <label class="lk-ed__check" title="勾上：没画的地方一律算海洋（原型就是整个世界）；不勾：没画的地方交给生成器随机">
        <input type="checkbox" id="ed-blank-sea" checked> 留白 = 海洋
      </label>
      <button class="lk-ed__btn is-primary" id="ed-go" title="按这幅原型生成星球（当前地图的种子与档位）">按这幅生成</button>
      <button class="lk-ed__close" id="ed-close" title="关掉（Esc）">×</button>
    </div>
    <div class="lk-ed__sub">
      <span class="lk-ed__subtitle" id="ed-layer-name">海陆</span>
      <span class="lk-ed__group" id="ed-brushes"></span>
      <span class="lk-ed__subnote" id="ed-layer-hint"></span>
    </div>
    <div class="lk-ed__main">
      <aside class="lk-ed__side">
        <div class="lk-ed__sidehead"><span>图层</span><span class="lk-ed__val" id="ed-layer-count"></span></div>
        <div class="lk-ed__layers" id="ed-layers"></div>
        <div class="lk-ed__addrow">
          <select id="ed-add-kind" class="lk-ed__sel">
            <optgroup label="生成层">
              ${PROTO_KINDS.filter((k) => k !== 'turb' && k !== 'noise').map((k) => `<option value="${k}">${KIND_LABEL[k]}</option>`).join('')}
            </optgroup>
            <optgroup label="效果层">
              <option value="turb">${KIND_LABEL.turb}</option>
            </optgroup>
          </select>
          <button class="lk-ed__btn" id="ed-add" title="新建一张该类型的图层（放在最上面）">＋ 新建层</button>
        </div>
        <div class="lk-ed__props" id="ed-props"></div>
      </aside>
      <div class="lk-ed__stage" id="ed-stage">
        <canvas id="ed-canvas"></canvas>
        <canvas id="ed-cursor"></canvas>
      </div>
    </div>
    <div class="lk-ed__foot">
      <span id="ed-stat"></span>
      <span id="ed-note"></span>
      <input type="file" id="ed-file" accept="image/*" style="display:none;">
    </div>`;
  document.body.appendChild(el);
  openEl = el;

  const q = <T extends HTMLElement>(sel: string) => el.querySelector(sel) as T;
  const stage = q<HTMLElement>('#ed-stage');
  const canvas = q<HTMLCanvasElement>('#ed-canvas');
  const cursorCanvas = q<HTMLCanvasElement>('#ed-cursor');
  const ctx = canvas.getContext('2d');
  const cctx = cursorCanvas.getContext('2d');
  const statEl = q<HTMLElement>('#ed-stat');
  const noteEl = q<HTMLElement>('#ed-note');
  const fileEl = q<HTMLInputElement>('#ed-file');
  const zoomEl = q<HTMLElement>('#ed-zoom');
  const brushEl = q<HTMLInputElement>('#ed-brush');
  const brushNEl = q<HTMLElement>('#ed-brush-n');
  const strEl = q<HTMLInputElement>('#ed-strength');
  const strNEl = q<HTMLElement>('#ed-strength-n');
  const strBox = q<HTMLElement>('#ed-strength-box');
  const brushesEl = q<HTMLElement>('#ed-brushes');
  const layerNameEl = q<HTMLElement>('#ed-layer-name');
  const layerHintEl = q<HTMLElement>('#ed-layer-hint');
  const layersEl = q<HTMLElement>('#ed-layers');
  const propsEl = q<HTMLElement>('#ed-props');
  const addKindEl = q<HTMLSelectElement>('#ed-add-kind');
  const layerCountEl = q<HTMLElement>('#ed-layer-count');
  const mapSeed = String(currentWorld(store).maps?.[0]?.terrain?.seed ?? '灵框');

  /* ── 合成缓存 ─────────────────────────────────────────────────────────── */
  let compDirty = true;
  let previewDirty = true;
  let landComp: Uint8Array = new Uint8Array(PROTO_W * PROTO_H);
  let zoneComp: Uint8Array = new Uint8Array(PROTO_W * PROTO_H);
  let climateComp: Uint8Array = new Uint8Array(PROTO_W * PROTO_H);
  let noiseComp: Int8Array = new Int8Array(PROTO_W * PROTO_H);
  let landRev = 0;
  let landBlurRev = -1;
  let landBlur: Float32Array | null = null;
  let seaBlur: Float32Array | null = null;
  const previewLand = new Uint8Array(PROTO_W * PROTO_H);
  const turbFieldCache = new Map<string, Float32Array>();

  const active = (): DecodedLayer | undefined => doc.layers.find((l) => l.id === activeId);
  const activeKind = (): ProtoLayerKind => active()?.kind ?? 'land';
  const checkpoint = () => { landRev++; compDirty = true; previewDirty = true; };
  /** 只改了某一层：只有海陆层会让"糊开的海陆场"失效，别的层不必重算它（卡顿的主要来源）。 */
  const touchLayer = (kind: ProtoLayerKind) => {
    if (kind === 'land') landRev++;
    compDirty = true;
    previewDirty = true;
  };

  const recomputeComps = () => {
    landComp = compositeU8(doc, 'land');
    zoneComp = compositeU8(doc, 'zone');
    climateComp = compositeU8(doc, 'climate');
    noiseComp = compositeNoise(doc);
    compDirty = false;
  };

  const blurField = (src: Float32Array, r: number): Float32Array => {
    const w = PROTO_W, h = PROTO_H;
    const tmp = new Float32Array(src.length);
    const out = new Float32Array(src.length);
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
        out[y * w + x] = s / span;
      }
    }
    return out;
  };

  const hasData = (l: DecodedLayer): boolean => {
    const d = l.data;
    for (let i = 0; i < d.length; i++) if (d[i]) return true;
    return false;
  };

  /** 重建预览海陆：合成海陆 + 每层湍流（糊开的海陆场 + 相干湍流扰动阈值），与生成器同一算法。 */
  const buildPreview = () => {
    previewDirty = false;
    /* 只给 e2e 数次数：验证「刷完再算」（笔画期间不重建预览） */
    (window as any).__lkPrevBuilds = ((window as any).__lkPrevBuilds || 0) + 1;
    const n = PROTO_W * PROTO_H;
    const blankSea = (el.querySelector('#ed-blank-sea') as HTMLInputElement | null)?.checked ?? true;
    const turbs = turbLayers(doc).filter(hasData);
    if (!turbs.length) {
      for (let i = 0; i < n; i++) previewLand[i] = ZONE_CODE(zoneComp[i]) === ZONE_LAKE ? 2 : landComp[i];
      return;
    }
    if (landBlurRev !== landRev || !landBlur || !seaBlur) {
      const lf = new Float32Array(n);
      const sf = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const v = landComp[i];
        if (ZONE_CODE(zoneComp[i]) === ZONE_LAKE) { sf[i] = 1; continue; }
        if (v === 1) lf[i] = 1;
        else if (v === 2 || (blankSea && v === 0)) sf[i] = 1;
      }
      landBlur = blurField(lf, TURB_LAND_BLUR);
      seaBlur = blurField(sf, TURB_LAND_BLUR);
      landBlurRev = landRev;
    }
    /* 每层：强度（膨胀+模糊）与湍流场（参数键缓存） */
    const preps: { strength: Float32Array; field: Float32Array; amp: number; blend: TurbBlend }[] = [];
    for (const l of turbs) {
      const s = new Float32Array(n);
      for (let i = 0; i < n; i++) s[i] = (l.data[i] as number) / EDGE_MAX;
      const diff = Math.max(0, Math.round(l.diffusion));
      if (diff > 0) {
        s.set(dilateField(s, PROTO_W, PROTO_H, diff));
        const b = blurField(s, Math.max(1, Math.round(diff * 0.6)));
        s.set(b);
      }
      const key = `${l.scale}|${l.octaves}|${l.seed}`;
      let field = turbFieldCache.get(key);
      if (!field) {
        field = buildEdgeTurbulence(PROTO_W, PROTO_H, hashSeed(mapSeed + '|湍流' + (l.seed | 0)), {
          scale: l.scale, octaves: l.octaves,
        });
        if (turbFieldCache.size > 12) turbFieldCache.clear();
        turbFieldCache.set(key, field);
      }
      preps.push({ strength: s, field, amp: l.amp, blend: l.blend });
    }
    const lb = landBlur, sb = seaBlur;
    for (let i = 0; i < n; i++) {
      if (ZONE_CODE(zoneComp[i]) === ZONE_LAKE) { previewLand[i] = 2; continue; }
      let lf = lb[i], sf = sb[i];
      const coastal = 4 * lf * sf;
      if (coastal > 0.001) {
        let tb = 0;
        for (const p of preps) {
          const st = p.strength[i];
          if (st <= 0.004) continue;
          const t0 = p.field[i] * st * p.amp * coastal;
          if (p.blend === 'add') tb += t0;
          else if (p.blend === 'grow') tb += t0 > 0 ? t0 : 0;
          else tb += t0 < 0 ? t0 : 0;
        }
        lf += tb; sf -= tb;
      }
      previewLand[i] = lf > 0.5 ? 1 : (sf > 0.5 ? 2 : 0);
    }
  };

  /* ── 画布 ─────────────────────────────────────────────────────────────── */
  const buf = document.createElement('canvas');
  buf.width = PROTO_W;
  buf.height = PROTO_H;
  const bctx = buf.getContext('2d');
  const img = bctx ? bctx.createImageData(PROTO_W, PROTO_H) : null;
  let statText = '';

  function paintBuf() {
    if (!bctx || !img) return;
    if (compDirty) recomputeComps();
    /* ⭐ 第一百三十八轮：**刷完再算**。
       笔画/变换/液化进行中（`strokeBusy`）一律不重算湍流预览（多层膨胀+模糊+噪声是"卡"的根源）：
       · 正在改海陆层 → 直接显示裸海陆（笔下的形状跟手）；
       · 正在改别的层 → 沿用上一帧的陆地预览（它没变），只实时叠当前层的笔迹。
       松手时再统一重建一次。 */
    if (!strokeBusy) {
      if (previewDirty) buildPreview();
    } else if (activeKind() === 'land') {
      for (let i = 0; i < PROTO_W * PROTO_H; i++) previewLand[i] = ZONE_CODE(zoneComp[i]) === ZONE_LAKE ? 2 : landComp[i];
    }
    const d = img.data;
    const n = PROTO_W * PROTO_H;
    const kind = activeKind();
    for (let i = 0; i < n; i++) {
      const lv = previewLand[i];
      let r = C_UNSET[0], g = C_UNSET[1], b = C_UNSET[2];
      if (lv === 1) { r = C_LAND[0]; g = C_LAND[1]; b = C_LAND[2]; }
      else if (lv === 2) { r = C_SEA[0]; g = C_SEA[1]; b = C_SEA[2]; }
      /* 地形 / 气候常显（当前层最实，其余半透明）。
         ⭐ 地形强度用**饱和度/明度**表现：强度 1 只有三成着色（淡），8 才是满色。 */
      const z = zoneComp[i];
      if (z) {
        const c = C_ZONE[ZONE_CODE(z)];
        if (c) {
          const s = ZONE_STRENGTH(z) / ZONE_STRENGTH_MAX;
          const t = (kind === 'zone' ? 0.92 : 0.55) * (0.3 + 0.7 * s);
          r = r * (1 - t) + c[0] * t; g = g * (1 - t) + c[1] * t; b = b * (1 - t) + c[2] * t;
        }
      }
      const cl = climateComp[i];
      if (cl) {
        const c = C_CLIMATE[cl];
        if (c) {
          const t = kind === 'climate' ? 0.85 : 0.42;
          r = r * (1 - t) + c[0] * t; g = g * (1 - t) + c[1] * t; b = b * (1 - t) + c[2] * t;
        }
      }
      /* 噪声 / 湍流：只在编辑它们的时候叠（否则画布太花） */
      if (kind === 'noise' && noiseComp[i]) {
        const nv = noiseComp[i];
        const c = nv > 0 ? C_NOISE_UP : C_NOISE_DOWN;
        const t = Math.min(1, Math.abs(nv) / NOISE_MAX) * 0.72;
        r = r * (1 - t) + c[0] * t; g = g * (1 - t) + c[1] * t; b = b * (1 - t) + c[2] * t;
      } else if (kind === 'turb') {
        const l = active();
        const ev = l ? (l.data[i] as number) : 0;
        if (ev) {
          const t = Math.min(1, ev / EDGE_MAX) * 0.8;
          r = r * (1 - t) + C_TURB[0] * t; g = g * (1 - t) + C_TURB[1] * t; b = b * (1 - t) + C_TURB[2] * t;
        }
      }
      const o = i << 2;
      d[o] = r | 0; d[o + 1] = g | 0; d[o + 2] = b | 0; d[o + 3] = 255;
    }
    bctx.putImageData(img, 0, 0);

    /* 状态行 */
    let land = 0, sea = 0;
    for (let i = 0; i < n; i++) { const v = landComp[i]; if (v === 1) land++; else if (v === 2) sea++; }
    const pct = (v: number) => Math.round((v / n) * 100);
    /* 当前层的明细（用户看"这一层画了多少"），和顶栏一处显示，别让状态行只剩总数 */
    let extra = '';
    if (kind === 'zone') {
      const names: [number, string][] = [[ZONE_MOUNTAIN, '高山'], [ZONE_HILL, '丘陵'], [ZONE_PLATEAU, '高原'], [ZONE_BASIN, '盆地'], [ZONE_PLAIN, '平原'], [ZONE_LAKE, '湖泊']];
      const parts: string[] = [];
      let sSum = 0, sCnt = 0;
      for (const [codeV, name] of names) {
        let c = 0;
        for (let i = 0; i < n; i++) {
          const zv = zoneComp[i];
          if (!zv || ZONE_CODE(zv) !== codeV) continue;
          c++;
          sSum += ZONE_STRENGTH(zv);
          sCnt++;
        }
        if (c) parts.push(`${name} ${pct(c)}%`);
      }
      const avg = sCnt ? (sSum / sCnt).toFixed(1) : '0';
      extra = parts.length
        ? ` · 地形：${parts.join(' · ')}（强度均 ${avg}）`
        : ' · 地形：还没画';
    } else if (kind === 'climate') {
      let dry = 0, wet = 0;
      for (let i = 0; i < n; i++) { if (climateComp[i] === CLIMATE_DRY) dry++; else if (climateComp[i] === CLIMATE_WET) wet++; }
      extra = ` · 气候：沙地 ${pct(dry)}% · 湿地 ${pct(wet)}%`;
    } else if (kind === 'noise') {
      let up = 0, down = 0;
      for (let i = 0; i < n; i++) { if (noiseComp[i] > 0) up++; else if (noiseComp[i] < 0) down++; }
      extra = ` · 噪声：加噪 ${pct(up)}% · 抹平 ${pct(down)}%`;
    } else if (kind === 'turb') {
      const l = active();
      let c = 0;
      if (l) for (let i = 0; i < n; i++) if (l.data[i]) c++;
      extra = ` · 湍流笔迹 ${pct(c)}%（尺度 ${l?.scale ?? 1}× · 幅度 ${l?.amp ?? 0.6}）`;
    }
    const turbs = turbLayers(doc).filter((l) => l.on).length;
    statText = `陆地 ${pct(land)}% · 海洋 ${pct(sea)}% · 留白 ${100 - pct(land) - pct(sea)}%${extra}`
      + ` · 图层 ${doc.layers.length}（${turbs} 张湍流）· 当前「${active()?.name ?? '—'}」`;
    statEl.textContent = statText;
    zoomEl.textContent = Math.round(zoom * 100) + '%';
    layerCountEl.textContent = `${doc.layers.length}`;
  }

  /* 视口 */
  let vw = 960;
  let vh = 480;
  const baseScale = () => Math.min(vw / PROTO_W, vh / PROTO_H) || 1;
  const cellPx = () => baseScale() * zoom;
  const contentW = () => PROTO_W * cellPx();
  const contentH = () => PROTO_H * cellPx();
  function clampPan() {
    const cw = contentW(), ch = contentH();
    panX = cw <= vw ? (vw - cw) / 2 : Math.min(0, Math.max(vw - cw, panX));
    panY = ch <= vh ? (vh - ch) / 2 : Math.min(0, Math.max(vh - ch, panY));
  }
  const screenX = (x: number) => panX + x * cellPx();
  const screenY = (y: number) => panY + y * cellPx();

  function paint() {
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(buf, 0, 0, PROTO_W, PROTO_H, panX, panY, contentW(), contentH());
    const cp = cellPx();
    if (cp >= 6) {
      ctx.strokeStyle = 'rgba(0,0,0,.13)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= PROTO_W; x++) {
        const px = Math.round(panX + x * cp) + 0.5;
        ctx.moveTo(px, panY); ctx.lineTo(px, panY + contentH());
      }
      for (let y = 0; y <= PROTO_H; y++) {
        const py = Math.round(panY + y * cp) + 0.5;
        ctx.moveTo(panX, py); ctx.lineTo(panX + contentW(), py);
      }
      ctx.stroke();
    }
    drawOverlay();
    statEl.textContent = statText;
    zoomEl.textContent = Math.round(zoom * 100) + '%';
  }

  /* ── 覆盖层：笔刷圆环 / 变换框 ────────────────────────────────────────── */
  let ringX = -1;
  let ringY = -1;
  let tfBox: { x0: number; y0: number; x1: number; y1: number } | null = null;

  function drawOverlay() {
    if (!cctx) return;
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.clearRect(0, 0, vw, vh);
    if (mode === 'transform' && tfBox) {
      const x0 = screenX(tfBox.x0), y0 = screenY(tfBox.y0);
      const x1 = screenX(tfBox.x1), y1 = screenY(tfBox.y1);
      cctx.strokeStyle = 'rgba(0,0,0,.6)';
      cctx.lineWidth = 3;
      cctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      cctx.strokeStyle = 'rgba(255,255,255,.9)';
      cctx.lineWidth = 1;
      cctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      const handles: [number, number][] = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
      for (const [hx, hy] of handles) {
        cctx.fillStyle = '#8fe28f';
        cctx.fillRect(hx - 4, hy - 4, 8, 8);
        cctx.strokeStyle = 'rgba(0,0,0,.7)';
        cctx.strokeRect(hx - 4, hy - 4, 8, 8);
      }
      const mx = (x0 + x1) / 2;
      cctx.beginPath();
      cctx.moveTo(mx, y0 - 26); cctx.lineTo(mx, y0);
      cctx.strokeStyle = 'rgba(255,255,255,.8)';
      cctx.stroke();
      cctx.beginPath();
      cctx.arc(mx, y0 - 30, 5, 0, Math.PI * 2);
      cctx.fillStyle = '#8fe28f';
      cctx.fill();
      cctx.strokeStyle = 'rgba(0,0,0,.7)';
      cctx.stroke();
      return;
    }
    if (ringX < 0) return;
    if (mode === 'liquify') {
      const r = Math.max(2, brushCells * cellPx());
      cctx.beginPath(); cctx.arc(ringX, ringY, r, 0, Math.PI * 2);
      cctx.strokeStyle = 'rgba(0,0,0,.55)'; cctx.lineWidth = 3; cctx.stroke();
      cctx.beginPath(); cctx.arc(ringX, ringY, r, 0, Math.PI * 2);
      cctx.strokeStyle = 'rgba(255,255,255,.85)'; cctx.lineWidth = 1; cctx.stroke();
      return;
    }
    const r = Math.max(2, (brushCells - 0.5) * cellPx());
    cctx.beginPath(); cctx.arc(ringX, ringY, r, 0, Math.PI * 2);
    cctx.strokeStyle = 'rgba(0,0,0,.55)'; cctx.lineWidth = 3; cctx.stroke();
    cctx.beginPath(); cctx.arc(ringX, ringY, r, 0, Math.PI * 2);
    cctx.strokeStyle = 'rgba(255,255,255,.85)'; cctx.lineWidth = 1; cctx.stroke();
    cctx.beginPath(); cctx.arc(ringX, ringY, 1.2, 0, Math.PI * 2);
    cctx.fillStyle = 'rgba(255,255,255,.9)'; cctx.fill();
  }

  function resize() {
    const r = stage.getBoundingClientRect();
    vw = Math.max(120, Math.round(r.width));
    vh = Math.max(80, Math.round(r.height));
    canvas.width = vw; canvas.height = vh;
    cursorCanvas.width = vw; cursorCanvas.height = vh;
    clampPan();
    paint();
    drawOverlay();
  }

  /* ── 指针 → 原型格 ─────────────────────────────────────────────────────── */
  const cellAt = (clientX: number, clientY: number): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    const k = r.width ? vw / r.width : 1;
    const cp = contentW() / PROTO_W;
    return {
      x: Math.floor(((clientX - r.left) * k - panX) / cp),
      y: Math.floor(((clientY - r.top) * k - panY) / cp),
    };
  };

  const currentValue = (): number => {
    const kind = activeKind();
    const b = PALETTES[kind].find((x) => x.id === toolId) ?? PALETTES[kind][0];
    /* 地形：类型码 + 顶栏强度滑块（0..8）打包进同一格 */
    if (kind === 'zone') return b.value === 0 ? 0 : ZONE_PACK(b.value, strength);
    if (kind === 'noise') return b.value === 0 ? 0 : (b.value > 0 ? strength : -strength);
    if (kind === 'turb') return b.value === 0 ? 0 : strength;
    return b.value;
  };

  const pushUndoData = (l: DecodedLayer) => {
    const data = l.data instanceof Int8Array ? new Int8Array(l.data) : new Uint8Array(l.data);
    undoStack.push({ type: 'data', id: l.id, data });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
  };
  const pushUndoDoc = () => {
    undoStack.push({ type: 'doc', layers: doc.layers.slice() });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
  };
  const restoreData = (id: string, data: Uint8Array | Int8Array) => {
    const l = doc.layers.find((x) => x.id === id);
    if (!l) return;
    const t = l.data as unknown as Uint8Array;
    t.set(data as unknown as Uint8Array);
    checkpoint();
  };
  const undo = () => {
    const prev = undoStack.pop();
    if (!prev) return;
    if (prev.type === 'doc') {
      doc.layers = prev.layers;
      if (!doc.layers.some((l) => l.id === activeId)) activeId = doc.layers[0]?.id ?? '';
    } else {
      restoreData(prev.id, prev.data);
    }
    checkpoint();
    renderLayers();
    renderProps();
    syncUi();
    paintBuf();
    paint();
  };

  const stamp = (cx: number, cy: number) => {
    const l = active();
    if (!l) return;
    const val = currentValue();
    const arr = l.data;
    const r = Math.max(0, brushCells - 1);
    for (let y = cy - r; y <= cy + r; y++) {
      if (y < 0 || y >= PROTO_H) continue;
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || x >= PROTO_W) continue;
        const dx = x - cx, dy = y - cy;
        if (r > 0 && dx * dx + dy * dy > r * r + r * 0.6) continue;
        arr[y * PROTO_W + x] = val;
      }
    }
  };
  const line = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    for (let i = 0; i <= steps; i++) {
      const t = steps ? i / steps : 0;
      stamp(Math.round(a.x + (b.x - a.x) * t), Math.round(a.y + (b.y - a.y) * t));
    }
  };

  /* ── 变换：移动 / 缩放 / 旋转 ───────────────────────────────────────────── */
  type Tf = { dx: number; dy: number; scale: number; rot: number };
  let tf: Tf = { dx: 0, dy: 0, scale: 1, rot: 0 };
  let tfSnapshot: Uint8Array | Int8Array | null = null;
  let tfDrag: { kind: 'move' | 'scale' | 'rot'; sx: number; sy: number; base: Tf; dist0: number; ang0: number } | null = null;
  let tfBBox: { cx: number; cy: number; x0: number; y0: number; x1: number; y1: number } | null = null;

  const computeBBox = (l: DecodedLayer) => {
    let x0 = PROTO_W, y0 = PROTO_H, x1 = -1, y1 = -1;
    const d = l.data;
    for (let y = 0; y < PROTO_H; y++) {
      const row = y * PROTO_W;
      for (let x = 0; x < PROTO_W; x++) {
        if (d[row + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    if (x1 < 0) return null;
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, x0: x0 - 0.5, y0: y0 - 0.5, x1: x1 + 1.5, y1: y1 + 1.5 };
  };
  const syncTfBox = () => {
    const l = active();
    tfBBox = l ? computeBBox(l) : null;
    if (!tfBBox) { tfBox = null; return; }
    const w = (tfBBox.x1 - tfBBox.x0) * tf.scale;
    const h = (tfBBox.y1 - tfBBox.y0) * tf.scale;
    const cx = tfBBox.cx + tf.dx, cy = tfBBox.cy + tf.dy;
    tfBox = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
  };
  /** 把快照按 tf 重采样进图层（最近邻；绕 bbox 中心旋转/缩放）。 */
  const applyTransform = () => {
    const l = active();
    if (!l || !tfSnapshot || !tfBBox) return;
    const src = tfSnapshot as unknown as Uint8Array;
    const dst = l.data as unknown as Uint8Array;
    const { cx, cy } = tfBBox;
    const cos = Math.cos(-tf.rot), sin = Math.sin(-tf.rot);
    const inv = 1 / Math.max(0.05, tf.scale);
    for (let y = 0; y < PROTO_H; y++) {
      const row = y * PROTO_W;
      const py = y + 0.5 - cy - tf.dy;
      for (let x = 0; x < PROTO_W; x++) {
        const px = x + 0.5 - cx - tf.dx;
        const sx = Math.round(cx + (px * cos - py * sin) * inv - 0.5);
        const sy = Math.round(cy + (px * sin + py * cos) * inv - 0.5);
        dst[row + x] = sx >= 0 && sx < PROTO_W && sy >= 0 && sy < PROTO_H ? src[sy * PROTO_W + sx] : 0;
      }
    }
    touchLayer(l.kind);
  };
  const resetTf = () => {
    tf = { dx: 0, dy: 0, scale: 1, rot: 0 };
    tfSnapshot = null;
    tfDrag = null;
    syncTfBox();
  };

  /* ── 液化：推挤 / 膨胀 / 收缩 ───────────────────────────────────────────── */
  let liqSnapshot: Uint8Array | Int8Array | null = null;
  let liqLast: { x: number; y: number } | null = null;
  const liquifyAt = (x: number, y: number) => {
    const l = active();
    if (!l || !liqSnapshot || !liqLast) return;
    const src = liqSnapshot as unknown as Uint8Array;
    const dst = l.data as unknown as Uint8Array;
    const r = Math.max(1, brushCells);
    const r2 = r * r;
    const k = (strength / 8) * 0.55;
    const dx = x - liqLast.x, dy = y - liqLast.y;
    const cx = liqLast.x + 0.5, cy = liqLast.y + 0.5;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(PROTO_W - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(PROTO_H - 1, Math.ceil(cy + r));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const ox = px + 0.5 - cx, oy = py + 0.5 - cy;
        const d2 = ox * ox + oy * oy;
        if (d2 > r2) continue;
        const fall = 1 - Math.sqrt(d2) / r;
        let sx = px, sy = py;
        if (liquifyKind === 'push') { sx = px - dx * fall * k; sy = py - dy * fall * k; }
        else if (liquifyKind === 'pinch') { const m = 1 + k * fall; sx = cx + ox * m; sy = cy + oy * m; }
        else { const m = 1 - k * fall; sx = cx + ox * m; sy = cy + oy * m; }
        const ix = Math.round(sx), iy = Math.round(sy);
        dst[py * PROTO_W + px] = ix >= 0 && ix < PROTO_W && iy >= 0 && iy < PROTO_H ? src[iy * PROTO_W + ix] : 0;
      }
    }
    liqLast = { x, y };
    touchLayer(l.kind);
  };

  /* ── 交互状态 ─────────────────────────────────────────────────────────── */
  let drawing = false;
  /** 笔画 / 变换 / 液化进行中：这段里**不重算湍流预览**（松手再算，见 `paintBuf()`） */
  let strokeBusy = false;
  let panning = false;
  let last: { x: number; y: number } | null = null;
  let panStart = { x: 0, y: 0, px: 0, py: 0 };
  let spaceDown = false;
  const setCursorGrab = (on: boolean) => { canvas.style.cursor = on ? 'grab' : (mode === 'transform' ? 'move' : 'crosshair'); };

  /** 变换框命中（屏幕坐标）：返回拖拽类型 */
  const hitTransform = (clientX: number, clientY: number): 'move' | 'scale' | 'rot' | null => {
    if (!tfBox) return null;
    const r = canvas.getBoundingClientRect();
    const k = r.width ? vw / r.width : 1;
    const sx = (clientX - r.left) * k, sy = (clientY - r.top) * k;
    const x0 = screenX(tfBox.x0), y0 = screenY(tfBox.y0);
    const x1 = screenX(tfBox.x1), y1 = screenY(tfBox.y1);
    const mx = (x0 + x1) / 2;
    if (Math.hypot(sx - mx, sy - (y0 - 30)) <= 12) return 'rot';
    for (const [hx, hy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]] as [number, number][]) {
      if (Math.hypot(sx - hx, sy - hy) <= 12) return 'scale';
    }
    if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) return 'move';
    return null;
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      panning = true;
      panStart = { x: e.clientX, y: e.clientY, px: panX, py: panY };
      setCursorGrab(true);
      try { canvas.setPointerCapture?.(e.pointerId); } catch { /* 合成事件 */ }
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    const p = cellAt(e.clientX, e.clientY);
    if (mode === 'transform') {
      const hit = hitTransform(e.clientX, e.clientY);
      if (!hit || !tfBBox) return;
      const l = active();
      if (!l) return;
      pushUndoData(l);
      tfSnapshot = l.data instanceof Int8Array ? new Int8Array(l.data) : new Uint8Array(l.data);
      const r = canvas.getBoundingClientRect();
      const k = r.width ? vw / r.width : 1;
      const sx = (e.clientX - r.left) * k, sy = (e.clientY - r.top) * k;
      const bcx = screenX(tfBBox.cx + tf.dx), bcy = screenY(tfBBox.cy + tf.dy);
      const corner = screenX(tfBox ? tfBox.x1 : tfBBox.cx);
      void corner;
      strokeBusy = true;
      tfDrag = {
        kind: hit,
        sx, sy,
        base: { ...tf },
        dist0: Math.max(4, Math.hypot(sx - bcx, sy - bcy)),
        ang0: Math.atan2(sy - bcy, sx - bcx),
      };
      try { canvas.setPointerCapture?.(e.pointerId); } catch { /* 合成事件 */ }
      e.preventDefault();
      return;
    }
    /* 画笔 / 液化 */
    const l = active();
    if (!l) return;
    /* 旧噪声层只读（第一百三十九轮：强度已并进地形笔刷；老数据仍参与生成） */
    if (mode === 'brush' && l.kind === 'noise') {
      noteEl.textContent = '旧噪声层是只读的：新版本请用「地形」层的强度笔刷（高山/平原…+ 强度滑块）';
      return;
    }
    pushUndoData(l);
    if (mode === 'liquify') {
      liqSnapshot = l.data instanceof Int8Array ? new Int8Array(l.data) : new Uint8Array(l.data);
      liqLast = p;
      drawing = true;
      strokeBusy = true;
      try { canvas.setPointerCapture?.(e.pointerId); } catch { /* 合成事件 */ }
      e.preventDefault();
      return;
    }
    drawing = true;
    strokeBusy = true;
    last = p;
    stamp(p.x, p.y);
    touchLayer(l.kind);
    paintBuf();
    paint();
    try { canvas.setPointerCapture?.(e.pointerId); } catch { /* 合成事件 */ }
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const k = r.width ? vw / r.width : 1;
    ringX = (e.clientX - r.left) * k;
    ringY = (e.clientY - r.top) * k;
    if (panning) {
      panX = panStart.px + (e.clientX - panStart.x);
      panY = panStart.py + (e.clientY - panStart.y);
      clampPan();
      paint();
      return;
    }
    if (mode === 'transform' && tfDrag) {
      const { cx, cy } = tfBBox!;
      /* ⚠️ 用**画布坐标**（ringX/ringY，与 tfDrag.sx/sy 同一套）算位移：
         混用 clientX 会把画布在窗口里的偏移量也算进位移（第一百三十七轮踩过，56px 被当成 300+）。 */
      const dxCell = (ringX - tfDrag.sx) / cellPx();
      const dyCell = (ringY - tfDrag.sy) / cellPx();
      if (tfDrag.kind === 'move') {
        tf = { ...tfDrag.base, dx: tfDrag.base.dx + dxCell, dy: tfDrag.base.dy + dyCell };
      } else if (tfDrag.kind === 'scale') {
        const bcx = screenX(cx + tfDrag.base.dx), bcy = screenY(cy + tfDrag.base.dy);
        const dist = Math.hypot(ringX - bcx, ringY - bcy);
        tf = { ...tfDrag.base, scale: Math.max(0.1, Math.min(8, tfDrag.base.scale * (dist / tfDrag.dist0))) };
      } else {
        const bcx = screenX(cx + tfDrag.base.dx), bcy = screenY(cy + tfDrag.base.dy);
        const ang = Math.atan2(ringY - bcy, ringX - bcx) - tfDrag.ang0;
        tf = { ...tfDrag.base, rot: tfDrag.base.rot + ang };
      }
      syncTfBox();
      applyTransform();
      paintBuf();
      paint();
      return;
    }
    if (mode === 'liquify' && drawing) {
      const p = cellAt(e.clientX, e.clientY);
      liquifyAt(p.x, p.y);
      paintBuf();
      paint();
      return;
    }
    if (drawing && last) {
      const p = cellAt(e.clientX, e.clientY);
      line(last, p);
      last = p;
      touchLayer(activeKind());
      paintBuf();
      paint();
    }
    drawOverlay();
  });

  const endStroke = (e: PointerEvent) => {
    if (mode === 'transform' && tfDrag) {
      tf = { dx: 0, dy: 0, scale: 1, rot: 0 };
      tfDrag = null;
      tfSnapshot = null;
      syncTfBox();
    }
    if (strokeBusy) {
      /* 松手才补湍流预览（笔画期间跳过了，见 paintBuf） */
      strokeBusy = false;
      previewDirty = true;
      paintBuf();
      paint();
    }
    drawing = false;
    panning = false;
    last = null;
    liqSnapshot = null;
    liqLast = null;
    setCursorGrab(false);
    try { canvas.releasePointerCapture?.(e.pointerId); } catch { /* 已释放 */ }
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', () => { ringX = -1; ringY = -1; drawOverlay(); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const s0 = baseScale();
    const mx = (sx - panX) / (s0 * zoom);
    const my = (sy - panY) / (s0 * zoom);
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * Math.exp(-e.deltaY * 0.0016)));
    zoom = Math.round(next * 100) / 100;
    panX = sx - mx * s0 * zoom;
    panY = sy - my * s0 * zoom;
    clampPan();
    paint();
  }, { passive: false });

  const setZoom = (z: number) => {
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
    clampPan();
    paint();
  };

  /* ── 图层面板 ─────────────────────────────────────────────────────────── */
  /* 第一百三十八轮：图层分两类展示 —— 生成层（海陆/地形/气候/噪声）与效果层（湍流）。
     "生成层"决定生成出来的世界长什么样；"效果层"只改海岸的破碎程度。 */
  const fxKind = (k: ProtoLayerKind) => k === 'turb';
  const rowHtml = (l: DecodedLayer) => `
      <div class="lk-ed__layer${l.id === activeId ? ' is-on' : ''}${l.on ? '' : ' is-off'}"
        data-id="${l.id}" data-kind="${l.kind}" draggable="true" title="拖动可排序">
        <button class="lk-ed__eye" data-eye="${l.id}" title="${l.on ? '隐藏' : '显示'}">${l.on ? '◉' : '○'}</button>
        <span class="lk-ed__chip" style="background:${C_KIND[l.kind]}"></span>
        <span class="lk-ed__lname">${escapeHtml(l.name)}</span>
        <span class="lk-ed__lkind">${KIND_LABEL[l.kind]}</span>
        ${l.kind === 'noise' ? '<span class="lk-ed__ltag">旧</span>' : ''}
      </div>`;
  function renderLayers() {
    const gen = doc.layers.filter((l) => !fxKind(l.kind));
    const fx = doc.layers.filter((l) => fxKind(l.kind));
    layersEl.innerHTML = `
      <div class="lk-ed__grouphead">生成层<span>${gen.length}</span></div>
      ${gen.map(rowHtml).join('')}
      <div class="lk-ed__grouphead">效果层<span>${fx.length}</span></div>
      ${fx.map(rowHtml).join('')}`;
  }

  /* 拖动排序（只在同一类里换：生成层之间 / 效果层之间） */
  let dragId: string | null = null;
  const clearDropMarks = () => layersEl.querySelectorAll('.is-drop,.is-dragging')
    .forEach((e) => e.classList.remove('is-drop', 'is-dragging'));
  layersEl.addEventListener('dragstart', (e) => {
    const row = (e.target as HTMLElement).closest('[data-id]') as HTMLElement | null;
    if (!row?.dataset.id) return;
    dragId = row.dataset.id;
    row.classList.add('is-dragging');
    try { (e as DragEvent).dataTransfer?.setData('text/plain', dragId); } catch { /* 老浏览器 */ }
    e.stopPropagation();
  });
  layersEl.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const row = (e.target as HTMLElement).closest('[data-id]') as HTMLElement | null;
    layersEl.querySelectorAll('.is-drop').forEach((n) => n.classList.remove('is-drop'));
    if (row?.dataset.id && row.dataset.id !== dragId) row.classList.add('is-drop');
  });
  layersEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const row = (e.target as HTMLElement).closest('[data-id]') as HTMLElement | null;
    if (!dragId || !row?.dataset.id || row.dataset.id === dragId) { clearDropMarks(); return; }
    const from = doc.layers.find((l) => l.id === dragId);
    const to = doc.layers.find((l) => l.id === row.dataset.id);
    if (from && to && fxKind(from.kind) === fxKind(to.kind)) {
      pushUndoDoc();
      doc.layers.splice(doc.layers.indexOf(from), 1);
      doc.layers.splice(doc.layers.indexOf(to), 0, from);
      checkpoint();
      renderLayers();
      paintBuf();
      paint();
    }
    dragId = null;
    clearDropMarks();
  });
  layersEl.addEventListener('dragend', () => { dragId = null; clearDropMarks(); });

  const escapeHtml = (s: string) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

  function renderProps() {
    const l = active();
    if (!l) { propsEl.innerHTML = '<div class="lk-ed__subnote">没有图层：先新建一层</div>'; return; }
    const turb = l.kind === 'turb';
    const range = (key: string, label: string, min: number, max: number, step: number, val: string, hint: string) => `
      <div class="lk-ed__prop" title="${hint}">
        <label>${label}</label>
        <input type="range" data-prop="${key}" min="${min}" max="${max}" step="${step}" value="${val}">
        <span class="lk-ed__val" data-val="${key}">${val}</span>
      </div>`;
    propsEl.innerHTML = `
      <div class="lk-ed__prop"><label>名称</label>
        <input type="text" data-prop="name" value="${escapeHtml(l.name)}" class="lk-ed__txt"></div>
      <div class="lk-ed__prop"><label>可见</label>
        <input type="checkbox" data-prop="on" ${l.on ? 'checked' : ''}></div>
      ${turb ? `
        ${range('scale', '尺度', 0.5, 3, 0.1, String(l.scale), '湍流波长倍数：小 = 细碎峡湾，大 = 大海湾/半岛')}
        ${range('amp', '幅度', 0.2, 1.2, 0.05, String(l.amp), '这一层最多能把海岸推多远（与笔迹强度相乘）')}
        ${range('octaves', '细节', 1, 4, 1, String(l.octaves), '倍频层数：1 圆润 … 4 带细碎毛边')}
        ${range('diffusion', '扩散', 0, 24, 1, String(l.diffusion), '笔迹强度向周围扩散多少格（离海岸几格刷也能作用到海岸）')}
        <div class="lk-ed__prop"><label>种子</label>
          <input type="number" data-prop="seed" value="${l.seed}" step="1" class="lk-ed__txt"></div>
        <div class="lk-ed__prop"><label>混合</label>
          <select data-prop="blend" class="lk-ed__sel">
            <option value="add"${l.blend === 'add' ? ' selected' : ''}>叠加（双向）</option>
            <option value="grow"${l.blend === 'grow' ? ' selected' : ''}>只长陆</option>
            <option value="erode"${l.blend === 'erode' ? ' selected' : ''}>只侵蚀</option>
          </select></div>`
      : `<div class="lk-ed__subnote">${KIND_HINT[l.kind]}</div>`}
      <div class="lk-ed__proprow">
        <button class="lk-ed__btn" data-act="clear" title="清空这一层">清空本层</button>
        <button class="lk-ed__btn" data-act="del" title="删除这一层">删除本层</button>
      </div>
      <div class="lk-ed__subnote">拖动图层行可排序（同类层之间）</div>`;
  }

  const KIND_HINT: Record<ProtoLayerKind, string> = {
    land: '海陆：从下往上合成，上层画过的格子覆盖下层（没画 = 透明）。',
    zone: '地形：高山 / 丘陵 / 高原 / 盆地 / 湖泊内海 —— 只改海拔形状。',
    climate: '气候：沙地 / 湿地 —— 只改湿度（植被上色与河网），不改海拔。',
    noise: '旧噪声层（只读）：老地图仍会按它生成；新版本请改用「地形」层的强度笔刷。',
    turb: '湍流：沿岸刷；这一层用上面的参数把海岸推开。多张湍流层会叠加。',
  };

  /* ── 顶栏 / 子栏同步 ───────────────────────────────────────────────────── */
  function syncUi() {
    const kind = activeKind();
    /* 换类别时**换回该类别自己上次用的笔刷**；否则 erase 这类 id 撞名会把"画笔"变成"橡皮"，
       表现为"切到湍流层后刷了没反应 / 还是在画海陆"（第一百三十八轮修）。 */
    if (kind !== lastKind) {
      if (lastKind) toolByKind[lastKind] = toolId;
      toolId = toolByKind[kind] ?? PALETTES[kind][0].id;
      lastKind = kind;
    }
    el.querySelectorAll('[data-mode]').forEach((b) => {
      (b as HTMLElement).classList.toggle('is-on', (b as HTMLElement).dataset.mode === mode);
    });
    /* 画笔 / 液化调色板 */
    let toolButtons = '';
    if (mode === 'brush') {
      if (kind === 'noise') {
        /* 旧噪声层只读：不给画笔（数据仍参与生成） */
        toolButtons = '<span class="lk-ed__subnote">旧噪声层：只读 —— 新版本请用「地形」层的强度笔刷（高山/平原… + 强度滑块）</span>';
      } else {
        const pal = PALETTES[kind];
        if (!pal.some((b) => b.id === toolId)) toolId = pal[0].id;
        toolButtons = pal.map((b) => `<button class="lk-ed__tool${b.id === toolId ? ' is-on' : ''}" data-tool="${b.id}" title="${b.hint}">${b.label}</button>`).join('');
      }
    } else if (mode === 'liquify') {
      toolButtons = ([['push', '推挤'], ['pinch', '收缩'], ['bulge', '膨胀']] as [LiquifyKind, string][])
        .map(([id, name]) => `<button class="lk-ed__tool${id === liquifyKind ? ' is-on' : ''}" data-liq="${id}" title="液化：${name}">${name}</button>`).join('');
    } else {
      toolButtons = '<span class="lk-ed__subnote">拖动框内移动 · 拖四角缩放 · 拖顶部圆点旋转</span>';
    }
    brushesEl.innerHTML = toolButtons;
    const l = active();
    layerNameEl.textContent = l ? l.name : '—';
    layerHintEl.textContent = mode === 'transform' ? '变换只会改当前这一层的网格（最近邻重采样）'
      : mode === 'liquify' ? '液化只在当前层上推/缩，松手前不会破坏别的层'
        : (PALETTES[kind].find((b) => b.id === toolId)?.hint ?? '');
    /* 强度滑块：地形（逐格强度）、湍流、液化都用它 */
    const strOn = kind === 'zone' || kind === 'turb' || mode === 'liquify';
    strBox.style.display = strOn ? 'flex' : 'none';
    brushEl.value = String(brushCells);
    brushNEl.textContent = String(brushCells);
    strEl.value = String(strength);
    strNEl.textContent = String(strength);
    const tfMode = mode === 'transform';
    q<HTMLElement>('#ed-brush').style.opacity = tfMode ? '0.35' : '1';
  }

  /* ── 事件：顶栏 ───────────────────────────────────────────────────────── */
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const modeBtn = t.closest('[data-mode]') as HTMLElement | null;
    if (modeBtn?.dataset.mode) {
      mode = modeBtn.dataset.mode as Mode;
      resetTf();
      if (mode === 'transform') syncTfBox();
      else tfBox = null;
      syncUi();
      paintBuf();
      paint();
      return;
    }
    const toolBtn = t.closest('[data-tool]') as HTMLElement | null;
    if (toolBtn?.dataset.tool) { toolId = toolBtn.dataset.tool; syncUi(); return; }
    const liqBtn = t.closest('[data-liq]') as HTMLElement | null;
    if (liqBtn?.dataset.liq) { liquifyKind = liqBtn.dataset.liq as LiquifyKind; syncUi(); return; }
    const layerRow = t.closest('[data-id]') as HTMLElement | null;
    if (layerRow?.dataset.id && !t.closest('[data-eye]')) {
      activeId = layerRow.dataset.id;
      resetTf();
      renderLayers();
      renderProps();
      syncUi();
      paintBuf();
      paint();
      return;
    }
    const eye = t.closest('[data-eye]') as HTMLElement | null;
    if (eye?.dataset.eye) {
      const l = doc.layers.find((x) => x.id === eye.dataset.eye);
      if (l) { l.on = !l.on; checkpoint(); renderLayers(); renderProps(); syncUi(); paintBuf(); paint(); }
      return;
    }
    if (t.closest('#ed-close')) { closeMapEditor(); return; }
    if (t.closest('#ed-zoom-in')) { setZoom(zoom * 1.5); return; }
    if (t.closest('#ed-zoom-out')) { setZoom(zoom / 1.5); return; }
    if (t.closest('#ed-zoom-fit')) { zoom = 1; clampPan(); paint(); return; }
    if (t.closest('#ed-undo')) { undo(); return; }
    if (t.closest('#ed-export')) { exportPng(); return; }
    if (t.closest('#ed-add')) { addLayer(); return; }
    if (t.closest('#ed-go')) { void applyPatch(); return; }
    const act = t.closest('[data-act]') as HTMLElement | null;
    if (act?.dataset.act) { layerAction(act.dataset.act); return; }
  });

  const addLayer = () => {
    const kind = addKindEl.value as ProtoLayerKind;
    const same = doc.layers.filter((l) => l.kind === kind).length + 1;
    pushUndoDoc();
    const l = newLayer(kind, `${KIND_LABEL[kind]} ${same}`);
    doc.layers.unshift(l);
    activeId = l.id;
    checkpoint();
    renderLayers();
    renderProps();
    syncUi();
    paintBuf();
    paint();
  };

  const layerAction = (act: string) => {
    const l = active();
    if (!l) return;
    if (act === 'clear') {
      pushUndoData(l);
      (l.data as unknown as Uint8Array).fill(0);
      touchLayer(l.kind);
      paintBuf();
      paint();
    } else if (act === 'del') {
      if (doc.layers.length <= 1) { noteEl.textContent = '至少留一层'; return; }
      pushUndoDoc();
      doc.layers = doc.layers.filter((x) => x.id !== l.id);
      activeId = doc.layers[0]?.id ?? '';
      checkpoint();
      renderLayers();
      renderProps();
      syncUi();
      paintBuf();
      paint();
    }
  };

  /* 属性面板：值变就地改（不重渲染，免得滑块掉焦） */
  const onProp = (e: Event) => {
    const t = e.target as HTMLElement;
    const key = (t as HTMLInputElement).dataset?.prop;
    const l = active();
    if (!key || !l) return;
    const valEl = propsEl.querySelector(`[data-val="${key}"]`);
    switch (key) {
      case 'name': l.name = (t as HTMLInputElement).value || KIND_LABEL[l.kind]; renderLayers(); syncUi(); break;
      case 'on': l.on = (t as HTMLInputElement).checked; renderLayers(); break;
      case 'scale': l.scale = Number((t as HTMLInputElement).value); if (valEl) valEl.textContent = String(l.scale); break;
      case 'amp': l.amp = Number((t as HTMLInputElement).value); if (valEl) valEl.textContent = String(l.amp); break;
      case 'octaves': l.octaves = Math.round(Number((t as HTMLInputElement).value)); if (valEl) valEl.textContent = String(l.octaves); break;
      case 'diffusion': l.diffusion = Math.round(Number((t as HTMLInputElement).value)); if (valEl) valEl.textContent = String(l.diffusion); break;
      case 'seed': l.seed = Math.round(Number((t as HTMLInputElement).value)) || 0; break;
      case 'blend': l.blend = (t as HTMLSelectElement).value as TurbBlend; break;
      default: return;
    }
    checkpoint();
    paintBuf();
    paint();
  };
  propsEl.addEventListener('input', onProp);
  propsEl.addEventListener('change', onProp);

  brushEl.addEventListener('input', () => {
    brushCells = Math.max(1, Math.min(40, Number(brushEl.value) || 1));
    brushNEl.textContent = String(brushCells);
    drawOverlay();
  });
  strEl.addEventListener('input', () => {
    strength = Math.max(1, Math.min(8, Number(strEl.value) || 1));
    strNEl.textContent = String(strength);
  });
  (el.querySelector('#ed-blank-sea') as HTMLInputElement | null)?.addEventListener('change', () => {
    previewDirty = true;
    paintBuf();
    paint();
  });

  fileEl.addEventListener('change', () => {
    const f = fileEl.files?.[0];
    if (!f) return;
    const l = active();
    if (!l || l.kind !== 'land') { noteEl.textContent = '导入只支持「海陆」层的图层'; fileEl.value = ''; return; }
    const url = URL.createObjectURL(f);
    const im = new Image();
    im.onload = () => {
      const tmp = document.createElement('canvas');
      tmp.width = PROTO_W; tmp.height = PROTO_H;
      const tctx = tmp.getContext('2d');
      if (!tctx) { URL.revokeObjectURL(url); return; }
      tctx.drawImage(im, 0, 0, PROTO_W, PROTO_H);
      const data = tctx.getImageData(0, 0, PROTO_W, PROTO_H).data;
      pushUndoData(l);
      for (let i = 0; i < PROTO_W * PROTO_H; i++) {
        const o = i * 4;
        const a = data[o + 3], g = data[o + 1], b = data[o + 2];
        l.data[i] = a < 32 ? 0 : (g > b + 10 ? 1 : (b > g + 10 ? 2 : 0));
      }
      checkpoint();
      paintBuf();
      paint();
      noteEl.textContent = `已导入「${f.name}」到「${l.name}」`;
      URL.revokeObjectURL(url);
    };
    im.onerror = () => { noteEl.textContent = '这张图读不出来，换一张 PNG 试试'; URL.revokeObjectURL(url); };
    im.src = url;
    fileEl.value = '';
  });

  /** 把当前层按调色板导出 PNG（颜色即语义） */
  const exportPng = () => {
    const l = active();
    if (!l) return;
    const out = document.createElement('canvas');
    out.width = PROTO_W; out.height = PROTO_H;
    const octx = out.getContext('2d');
    if (octx) {
      const data = octx.createImageData(PROTO_W, PROTO_H);
      const d = data.data;
      for (let i = 0; i < PROTO_W * PROTO_H; i++) {
        const v = l.data[i] as number;
        let r = 201, g = 198, b = 189;
        if (l.kind === 'land') {
          if (v === 1) { r = C_LAND[0]; g = C_LAND[1]; b = C_LAND[2]; }
          else if (v === 2) { r = C_SEA[0]; g = C_SEA[1]; b = C_SEA[2]; }
        } else if (v) {
          if (l.kind === 'zone') {
            /* 地形：类型色 × 强度（淡 → 浓），与画布上的读法一致 */
            const c = C_ZONE[ZONE_CODE(v)];
            if (c) {
              const t = ZONE_STRENGTH(v) / ZONE_STRENGTH_MAX;
              r = 201 * (1 - t) + c[0] * t; g = 198 * (1 - t) + c[1] * t; b = 189 * (1 - t) + c[2] * t;
            }
          } else {
            const c = l.kind === 'climate' ? C_CLIMATE[v]
              : l.kind === 'noise' ? (v > 0 ? C_NOISE_UP : C_NOISE_DOWN) : C_TURB;
            if (c) { r = c[0]; g = c[1]; b = c[2]; }
          }
        }
        const o = i << 2;
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
      }
      octx.putImageData(data, 0, 0);
    }
    const a = document.createElement('a');
    a.download = `原型-${l.name}.png`;
    a.href = out.toDataURL('image/png');
    a.click();
    noteEl.textContent = `已导出「${l.name}」（1024×512，颜色即层语义）`;
  };

  const applyPatch = async () => {
    const st = hostStore;
    if (!st) return;
    const t = currentWorld(st).maps?.[0]?.terrain;
    const b = showBusy(el, '正在按原型生成…', { sub: '图层合成 · 地形分区 · 气候 · 噪声 · 多层湍流 一起进生成器' });
    await nextFrame();
    try {
      /* 「留白 = 海洋」：生成时在最底下补一张"整幅海"的海陆层（不污染用户自己的层；
         名字固定，重复生成不会叠出多张）。预览里也是这么算的。 */
      const blankSea = (el.querySelector('#ed-blank-sea') as HTMLInputElement | null)?.checked ?? true;
      let outDoc = doc;
      if (blankSea) {
        const sea = newLayer('land', '海（留白）');
        (sea.data as Uint8Array).fill(2);
        outDoc = {
          ...doc,
          layers: [...doc.layers.filter((l) => l.name !== '海（留白）'), sea],
        };
      }
      const proto = encodeProto(outDoc);
      const r = generateIntoMap(st, {
        seed: t?.seed ? String(t.seed) : '灵框',
        style: t?.style ? String(t.style) : 'continent',
        spec: (t?.spec ?? {}) as { [k: string]: number | undefined },
        view: t?.view,
        form: 'planet',
        proto,
      });
      b.done();
      noteEl.textContent = r.note;
      window.setTimeout(() => closeMapEditor(), 1400);
    } catch (err) {
      b.done();
      noteEl.textContent = '生成失败：' + (err instanceof Error ? err.message : String(err));
    }
  };

  keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { closeMapEditor(); return; }
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.code === 'Space' || e.key === ' ') { spaceDown = true; setCursorGrab(true); e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); return; }
    if (e.key === 'b' || e.key === 'B') { mode = 'brush'; resetTf(); tfBox = null; syncUi(); paint(); return; }
    if (e.key === 't' || e.key === 'T') { mode = 'transform'; syncTfBox(); syncUi(); paint(); return; }
    if (e.key === 'l' || e.key === 'L') { mode = 'liquify'; tfBox = null; syncUi(); paint(); return; }
    if (e.key === '[') { brushEl.value = String(Math.max(1, brushCells - 1)); brushEl.dispatchEvent(new Event('input')); }
    if (e.key === ']') { brushEl.value = String(Math.min(40, brushCells + 1)); brushEl.dispatchEvent(new Event('input')); }
  };
  keyUpHandler = (e: KeyboardEvent) => { if (e.code === 'Space' || e.key === ' ') { spaceDown = false; setCursorGrab(false); } };
  window.addEventListener('keydown', keyHandler);
  window.addEventListener('keyup', keyUpHandler);

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(stage);
  (el as HTMLElement & { _ro?: ResizeObserver | null })._ro = ro;

  renderLayers();
  renderProps();
  syncUi();
  paintBuf();
  resize();
  window.requestAnimationFrame(() => resize());
  window.setTimeout(() => resize(), 120);
  noteEl.textContent = '图层可叠：海陆/地形/气候按上层覆盖，噪声求和，湍流逐层叠加。变换与液化只改当前层。';
}

export function closeMapEditor(): void {
  if (!openEl) return;
  if (keyHandler) { window.removeEventListener('keydown', keyHandler); keyHandler = null; }
  if (keyUpHandler) { window.removeEventListener('keyup', keyUpHandler); keyUpHandler = null; }
  const ro = (openEl as HTMLElement & { _ro?: ResizeObserver | null })._ro;
  ro?.disconnect();
  openEl.remove();
  openEl = null;
  hostStore = null;
}
