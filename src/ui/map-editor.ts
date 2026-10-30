/** 手绘原型画板（第一百零八轮起；**第一百三十五轮重写**）。
 *
 *  用户原话（第一百零八轮）：「再做一个简易的编辑器，能让用户自行绘制大陆和地形，并在此之上生成对应地形」。
 *  第一百零九轮：「这个手绘面板精细度不够，而且不能放大或者拖动，笔刷大小用滑块调整吧……
 *  手绘地形里面的橡皮定位不清晰，海洋不就是橡皮的功能吗」。
 *  ⭐ 第一百三十五轮（2026-10-31）：「能不能把当前的地图编辑系统重构一下，我想要更高精度的手绘原型，
 *  以及能对原型进行区域噪声叠加（手动添加），以及在绘制原型时就能预设定高山等地形的位置」。
 *
 *  这一版把"一张 320×160 的海陆剪影"换成**五层 1024×512 的原型**（数据与编解码在 `src/mapgen/proto.ts`）：
 *    · **海陆**   —— 陆地 / 海洋（原来的那层；留白仍可勾"= 海洋"）
 *    · **地形**   —— 高山 / 丘陵 / 高原 / 盆地低地 / 湖泊内海：画在哪，生成时海拔就按哪一档塑形
 *    · **气候**   —— 沙地 / 湿地：只改湿度（⇒ 植被上色、河网密度），不动海拔
 *    · **噪声**   —— 加噪 / 抹平（强度 1~8）：**有符号**地乘在起伏上
 *    · **边缘**   —— 海岸复杂化（强度 1~8）：放大海岸线的抖动幅度
 *  五个层各自 RLE 压缩 ⇒ 1024×512 画满几块大陆通常只有几 KB（老的 2 bit 定长是 131KB/层）。
 *
 *  ⭐ 第一百三十六轮（用户三条反馈）：
 *   ① **地形 / 气候常显** —— 换到任何层，画过的地形分区与气候底子都留在画布上（当前层更实，其余淡）；
 *   ② **边缘画下即时生效** —— 画边缘时海岸线当场按湍流置换变形，不用等「按这幅生成」；
 *   ③ **边缘 = 湍流置换**（不是逐点加噪）—— 位移来自多尺度相干湍流场（`buildEdgeTurbulence()`），
 *      与生成器共用同一张场：海岸被整体推开成峡湾/半岛，而不是每格独立抖成白毛。
 *
 *  交互仍是第一百零九轮定的那套（用户当时逐条点名要的）：滚轮以指针为锚缩放、中键 / 空格+左键拖动、
 *  笔刷滑块、跟随指针的圆环、放大到一格 ≥ 6px 时画淡网格。**没有橡皮当主工具** —— 每层自带「擦除」。
 *
 *  生成仍走**同一条落盘路** `generateIntoMap()`（`src/ui/map-gen.ts`）⇒ 一步 Ctrl+Z 能撤；
 *  原型优先于噪声（`src/mapgen/planet.ts` 的 `forced[]` / 效果场）。
 *
 *  ⚠️ 界面不用 emoji、不用黄色系文字（AGENTS.md），颜色只用 tokens.css 的变量；
 *  画布里的配色是**地图语义色**（陆地绿 / 海洋蓝 / 山地棕…），不参与文字对比度那条规矩。 */

import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import type { MapMask, MapProto } from '../store/types';
import {
  CLIMATE_DRY, CLIMATE_WET, EDGE_BLUR_CELLS, EDGE_MAX, EDGE_TURB_AMP, NOISE_MAX, PROTO_H, PROTO_W,
  ZONE_BASIN, ZONE_HILL, ZONE_LAKE, ZONE_MOUNTAIN, ZONE_PLATEAU,
  buildEdgeTurbulence, decodeProtoInput, dilateField, emptyLayers, encodeProto, protoSummary, type ProtoLayers,
} from '../mapgen/proto';
import { nextFrame, showBusy } from './busy';
import { closeLightbox, isLightboxOpen } from './lightbox';
import { generateIntoMap } from './map-gen';

/** 原型分辨率（与 `src/mapgen/proto.ts` 一致）。老名字保留：外部只关心"这块画板有多大"。 */
export const MASK_W = PROTO_W;
export const MASK_H = PROTO_H;
const MAX_UNDO = 40;
const ZOOM_MIN = 1;
const ZOOM_MAX = 24;

type LayerId = 'land' | 'zone' | 'climate' | 'noise' | 'edge';
type RGB = [number, number, number];

interface Brush {
  id: string;
  label: string;
  hint: string;
  value: number;
}

const LAYER_ORDER: LayerId[] = ['land', 'zone', 'climate', 'noise', 'edge'];
const LAYER_LABEL: Record<LayerId, string> = {
  land: '海陆', zone: '地形', climate: '气候', noise: '噪声', edge: '边缘',
};
const PALETTES: Record<LayerId, Brush[]> = {
  land: [
    { id: 'land', label: '陆地', hint: '涂成陆地（还没画的地方交给生成器）', value: 1 },
    { id: 'sea', label: '海洋', hint: '涂成海洋 —— 也就是把这一块从陆地擦掉', value: 2 },
  ],
  zone: [
    { id: 'mountain', label: '高山', hint: '山脉 / 高峰：山脊放大 + 基面抬高 ⇒ 画过的地方是最高的一带', value: ZONE_MOUNTAIN },
    { id: 'hill', label: '丘陵', hint: '中等起伏：山脊略放大、基面微微抬高', value: ZONE_HILL },
    { id: 'plateau', label: '高原', hint: '抬高的平顶：基面抬高 + 起伏压平', value: ZONE_PLATEAU },
    { id: 'basin', label: '盆地', hint: '低地：基面压低、起伏再压一半', value: ZONE_BASIN },
    { id: 'lake', label: '湖泊/内海', hint: '直接钉成水面（离岸越近越浅，不会变成深海）', value: ZONE_LAKE },
    { id: 'erase', label: '擦除', hint: '把这一层擦回"没画"（别的层不动）', value: 0 },
  ],
  climate: [
    { id: 'dry', label: '沙地', hint: '干燥底子：湿度压低 ⇒ 荒漠/草原色，河更少', value: CLIMATE_DRY },
    { id: 'wet', label: '湿地', hint: '湿润底子：湿度抬高 ⇒ 森林色，河更多', value: CLIMATE_WET },
    { id: 'erase', label: '擦除', hint: '把这一层擦回"没画"', value: 0 },
  ],
  noise: [
    { id: 'noise-up', label: '加噪', hint: '这一片更崎岖：山脊/细节一起放大（强度用右边的滑块）', value: 1 },
    { id: 'noise-down', label: '抹平', hint: '这一片更平：起伏与细节一起压下去', value: -1 },
    { id: 'erase', label: '擦除', hint: '把噪声擦掉', value: 0 },
  ],
  edge: [
    { id: 'edge-add', label: '边缘复杂化', hint: '海岸线更碎：用**湍流置换**把这一带的海岸整体推开（画下去当场生效，不是生成时才算）', value: 1 },
    { id: 'erase', label: '擦除', hint: '把这一带的海岸恢复平滑', value: 0 },
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
  [ZONE_LAKE]: [63, 127, 166],
};
const C_CLIMATE: Record<number, RGB> = {
  [CLIMATE_DRY]: [201, 163, 94],
  [CLIMATE_WET]: [79, 125, 99],
};
const C_NOISE_UP: RGB = [194, 90, 74];
const C_NOISE_DOWN: RGB = [91, 127, 181];
const C_EDGE: RGB = [88, 168, 184];

let openEl: HTMLElement | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let keyUpHandler: ((e: KeyboardEvent) => void) | null = null;
let hostStore: Store | null = null;

/* 画板状态（模块级：关掉再开，画到一半的原型还在 —— 与抽卡同一个体验） */
let layers: ProtoLayers = emptyLayers();
let undoStack: { layer: LayerId; data: Uint8Array | Int8Array }[] = [];
let layer: LayerId = 'land';
let toolId = 'land';
let brushCells = 8;
let strength = 5;
let zoom = 1;
let panX = 0;
let panY = 0;

export function isMapEditorOpen(): boolean {
  return !!openEl && document.body.contains(openEl);
}

export function clearEditorMask(): void {
  layers = emptyLayers();
  undoStack = [];
}

/** 把任意尺寸的解码结果对齐到 1024×512（旧原型/异常数据）—— 最近邻，够用且不引入模糊。 */
function fitLayers(src: ProtoLayers): ProtoLayers {
  if (src.w === PROTO_W && src.h === PROTO_H) return src;
  const out = emptyLayers();
  const n = PROTO_W * PROTO_H;
  for (let i = 0; i < n; i++) {
    const y = (i / PROTO_W) | 0;
    const x = i - y * PROTO_W;
    const sy = Math.min(src.h - 1, Math.floor((y * src.h) / PROTO_H));
    const sx = Math.min(src.w - 1, Math.floor((x * src.w) / PROTO_W));
    const s = sy * src.w + sx;
    out.land[i] = src.land[s];
    out.zone[i] = src.zone[s];
    out.climate[i] = src.climate[s];
    out.noise[i] = src.noise[s];
    out.edge[i] = src.edge[s];
  }
  return out;
}

function brushOf(id: string): Brush {
  return PALETTES[layer].find((b) => b.id === id) ?? PALETTES[layer][0];
}

/* ── 打开画板 ─────────────────────────────────────────────────────────────── */

/** 不给原型就沿用这张地图现在那份（"在现有原型上接着改"；老剪影会自动放大成五层）。 */
export function openMapEditor(store: Store, opts?: { proto?: MapProto; mask?: MapMask }): void {
  if (isLightboxOpen()) closeLightbox();
  closeMapEditor();
  hostStore = store;
  const m = currentWorld(store).maps?.[0];
  const src = opts?.proto ?? opts?.mask ?? m?.terrain?.proto ?? m?.terrain?.mask;
  const decoded = src ? decodeProtoInput(src) : null;
  layers = decoded ? fitLayers(decoded) : emptyLayers();
  undoStack = [];
  layer = 'land';
  toolId = 'land';
  /* 打开时把"视图/笔刷"恢复默认（画到一半的**数据**留着，操作参数不跨次沿用 —— 
     否则上次把笔刷拉到 30，这次一进来又大又难画） */
  brushCells = 8;
  strength = 5;
  zoom = 1;
  panX = 0;
  panY = 0;

  const el = document.createElement('div');
  el.className = 'lk-ed';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', '手绘原型');
  el.innerHTML = `
    <div class="lk-ed__bar">
      <span class="lk-ed__title">手绘原型</span>
      <span class="lk-ed__hint" id="ed-hint">1024×512 · 五层 · 滚轮缩放 · 中键 / 空格+左键拖动</span>
      <span class="lk-ed__spacer"></span>
      <span class="lk-ed__group">
        <button class="lk-ed__tool" data-layer="land" title="海陆：决定大陆、海岸与海在哪">海陆</button>
        <button class="lk-ed__tool" data-layer="zone" title="地形分区：高山 / 丘陵 / 高原 / 盆地 / 湖泊">地形</button>
        <button class="lk-ed__tool" data-layer="climate" title="气候底子：沙地 / 湿地（只改湿度）">气候</button>
        <button class="lk-ed__tool" data-layer="noise" title="区域噪声：加噪 / 抹平（有符号）">噪声</button>
        <button class="lk-ed__tool" data-layer="edge" title="海岸复杂化：这一带的海岸更碎">边缘</button>
      </span>
      <label class="lk-ed__slider" title="笔刷大小（单位：原型格）">
        <span>笔刷</span>
        <input type="range" id="ed-brush" min="1" max="40" step="1" value="8">
        <span class="lk-ed__val" id="ed-brush-n">8</span>
      </label>
      <label class="lk-ed__slider" id="ed-strength-box" title="强度（噪声 / 边缘层用）">
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
        <button class="lk-ed__btn" id="ed-undo" title="撤销上一笔（Ctrl+Z）">撤销</button>
        <button class="lk-ed__btn" id="ed-clear" title="清空当前这一层">清空本层</button>
        <button class="lk-ed__btn" id="ed-import" title="从 PNG 导入到海陆层（绿 = 陆地、蓝 = 海洋）">导入</button>
        <button class="lk-ed__btn" id="ed-export" title="把当前这一层导出为 PNG">导出</button>
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
    <div class="lk-ed__stage" id="ed-stage">
      <canvas id="ed-canvas"></canvas>
      <canvas id="ed-cursor"></canvas>
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

  /* ── 画布：原型 → 一张小画布（贴图源）───────────────────────────────────────
     ⭐ 第一百三十六轮（用户三条反馈）：
       · **地形 / 气候常显**：不再"切到哪层只看哪层"，画过的分区与气候永远叠在底图上
         （当前层更实，别的层淡一点，但都看得见）；
       · **边缘画下即时生效**：画边缘时海岸线当场按**湍流置换**变形（不是等生成才变）；
       · 边缘不再逐格摇硬币：位移来自 `buildEdgeTurbulence()` 的相干湍流（与生成器同一张场）。 */
  const buf = document.createElement('canvas');
  buf.width = PROTO_W;
  buf.height = PROTO_H;
  const bctx = buf.getContext('2d');
  const img = bctx ? bctx.createImageData(PROTO_W, PROTO_H) : null;

  let statText = '';
  /** 预览用的海陆（= 画的海陆 + 边缘湍流置换 + 湖泊算水）—— 画布显示的是它，不是裸的 land 层 */
  const previewLand = new Uint8Array(PROTO_W * PROTO_H);
  let previewDirty = true;
  /** 边缘湍流场（与生成器同一套 `buildEdgeTurbulence`：16/32/64 格波长的相干噪声） */
  let turbField: Float32Array | null = null;
  /** 糊开的海陆场（湍流阈值要在缓梯度上才推得动海岸），随 land 层变化重建 */
  let landBlur: Float32Array | null = null;
  let seaBlur: Float32Array | null = null;
  let blurRev = -1;
  let landRevision = 0;
  /** 与生成器同一个种子口径（FNV-1a）：同一张地图，画板预览与生成出来的位移方向一致 */
  const seedOf = (text: string): number => {
    let h = 0x811c9dc5;
    const s = String(text ?? '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return (h >>> 1) || 1;
  };
  const mapSeed = String(currentWorld(store).maps?.[0]?.terrain?.seed ?? '灵框');

  /** 可分离盒式模糊（x 环绕）。边缘置换靠它把海陆场糊成缓梯度。 */
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

  /** 重建预览海陆：**糊开的海陆场 + 湍流阈值扰动**（与 `planet.ts` 生成时同一算法）。
   *  只在画过边缘的地方生效；没画边缘时就是裸的海陆（湖泊算水）。 */
  function rebuildPreview(): void {
    const n = PROTO_W * PROTO_H;
    let anyEdge = false;
    for (let i = 0; i < n; i++) if (layers.edge[i]) { anyEdge = true; break; }
    const blankSea = (el.querySelector('#ed-blank-sea') as HTMLInputElement | null)?.checked ?? true;
    if (!anyEdge) {
      for (let i = 0; i < n; i++) previewLand[i] = layers.zone[i] === ZONE_LAKE ? 2 : layers.land[i];
      previewDirty = false;
      return;
    }
    if (!turbField) turbField = buildEdgeTurbulence(PROTO_W, PROTO_H, seedOf(mapSeed + '|边缘'));
    if (!landBlur || !seaBlur || blurRev !== landRevision) {
      const lf = new Float32Array(n);
      const sf = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const v = layers.land[i];
        if (v === 1) lf[i] = 1;
        else if (v === 2 || (blankSea && v === 0)) sf[i] = 1;
      }
      landBlur = blurField(lf, EDGE_BLUR_CELLS);
      seaBlur = blurField(sf, EDGE_BLUR_CELLS);
      blurRev = landRevision;
    }
    const eg = new Float32Array(n);
    for (let i = 0; i < n; i++) eg[i] = layers.edge[i] / EDGE_MAX;
    /* 强度：先膨胀 ~10 格（笔迹离海岸几格也能作用到海岸），再模糊 ~6 格（平滑起落） */
    const egW = blurField(dilateField(eg, PROTO_W, PROTO_H, 10), 6);
    for (let i = 0; i < n; i++) {
      if (layers.zone[i] === ZONE_LAKE) { previewLand[i] = 2; continue; }
      const w = egW[i];
      if (w <= 0.004) { previewLand[i] = layers.land[i]; continue; }
      const tb0 = turbField[i] * w * EDGE_TURB_AMP;
      const lfB = landBlur[i], sfB = seaBlur[i];
      /* 只作用在海岸带（与生成器同一条规矩：4·lf·sf 在内陆/深海为 0） */
      const tb = tb0 * 4 * lfB * sfB;
      const lf = lfB + tb;
      const sf = sfB - tb;
      previewLand[i] = lf > 0.5 ? 1 : (sf > 0.5 ? 2 : 0);
    }
    previewDirty = false;
  }

  function paintBuf() {
    if (!bctx || !img) return;
    if (previewDirty) rebuildPreview();
    const d = img.data;
    const n = PROTO_W * PROTO_H;
    for (let i = 0; i < n; i++) {
      const lv = previewLand[i];
      let r = C_UNSET[0], g = C_UNSET[1], b = C_UNSET[2];
      if (lv === 1) { r = C_LAND[0]; g = C_LAND[1]; b = C_LAND[2]; }
      else if (lv === 2) { r = C_SEA[0]; g = C_SEA[1]; b = C_SEA[2]; }
      /* ⭐ 地形常显（当前层最实、其余层半透明，但都不藏） */
      const z = layers.zone[i];
      if (z) {
        const c = C_ZONE[z];
        if (c) {
          const t = layer === 'zone' ? 0.92 : 0.55;
          r = r * (1 - t) + c[0] * t;
          g = g * (1 - t) + c[1] * t;
          b = b * (1 - t) + c[2] * t;
        }
      }
      /* ⭐ 气候常显 */
      const cl = layers.climate[i];
      if (cl) {
        const c = C_CLIMATE[cl];
        if (c) {
          const t = layer === 'climate' ? 0.85 : 0.42;
          r = r * (1 - t) + c[0] * t;
          g = g * (1 - t) + c[1] * t;
          b = b * (1 - t) + c[2] * t;
        }
      }
      /* 噪声 / 边缘：只在画它们的时候叠（否则画布太花） */
      if (layer === 'noise') {
        const nv = layers.noise[i];
        if (nv) {
          const c = nv > 0 ? C_NOISE_UP : C_NOISE_DOWN;
          const t = Math.min(1, Math.abs(nv) / NOISE_MAX) * 0.72;
          r = r * (1 - t) + c[0] * t;
          g = g * (1 - t) + c[1] * t;
          b = b * (1 - t) + c[2] * t;
        }
      } else if (layer === 'edge') {
        const ev = layers.edge[i];
        if (ev) {
          const t = Math.min(1, ev / EDGE_MAX) * 0.8;
          r = r * (1 - t) + C_EDGE[0] * t;
          g = g * (1 - t) + C_EDGE[1] * t;
          b = b * (1 - t) + C_EDGE[2] * t;
        }
      }
      const o = i << 2;
      d[o] = r | 0; d[o + 1] = g | 0; d[o + 2] = b | 0; d[o + 3] = 255;
    }
    bctx.putImageData(img, 0, 0);

    /* 状态行：海陆是"地基"（永远显示），后面接当前层的明细 */
    const sum = protoSummary(layers);
    const pct = (v: number) => `${Math.round((v / n) * 100)}%`;
    let extra = '';
    if (layer === 'land') {
      extra = ' · 画陆地/海洋：没画的地方由生成器决定（勾了「留白 = 海洋」则算海）';
    } else if (layer === 'zone') {
      const parts: string[] = [];
      for (const [k, name] of [[ZONE_MOUNTAIN, '高山'], [ZONE_HILL, '丘陵'], [ZONE_PLATEAU, '高原'], [ZONE_BASIN, '盆地'], [ZONE_LAKE, '湖泊']] as [number, string][]) {
        const v = sum.zone[k] ?? 0;
        if (v) parts.push(`${name} ${pct(v)}`);
      }
      extra = parts.length ? ' · 地形：' + parts.join(' · ') : ' · 地形：还没画（画了才会改海拔形状）';
    } else if (layer === 'climate') {
      const parts: string[] = [];
      if (sum.climate[CLIMATE_DRY]) parts.push(`沙地 ${pct(sum.climate[CLIMATE_DRY])}`);
      if (sum.climate[CLIMATE_WET]) parts.push(`湿地 ${pct(sum.climate[CLIMATE_WET])}`);
      extra = parts.length ? ' · 气候：' + parts.join(' · ') : ' · 气候：还没画（只改湿度，不改海拔）';
    } else if (layer === 'noise') {
      extra = ` · 噪声：加噪 ${sum.noiseUp}% · 抹平 ${sum.noiseDown}%`;
    } else {
      extra = ` · 边缘：复杂化 ${sum.edge}%（湍流置换，画下去海岸当场变形）`;
    }
    statText = `陆地 ${sum.landPct}% · 海洋 ${sum.seaPct}% · 留白 ${sum.blankPct}%${extra}`;
  }

  /** 视口尺寸（CSS px）；画布按它开，缩放/平移都在这里换算 */
  let vw = 960;
  let vh = 480;

  const baseScale = () => Math.min(vw / PROTO_W, vh / PROTO_H) || 1;
  const cellPx = () => baseScale() * zoom;
  const contentW = () => PROTO_W * cellPx();
  const contentH = () => PROTO_H * cellPx();

  /** 内容比视口小时居中；比视口大时不许拖出边界（拖到边上刚好贴边）*/
  function clampPan() {
    const cw = contentW();
    const ch = contentH();
    panX = cw <= vw ? (vw - cw) / 2 : Math.min(0, Math.max(vw - cw, panX));
    panY = ch <= vh ? (vh - ch) / 2 : Math.min(0, Math.max(vh - ch, panY));
  }

  function paint() {
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(buf, 0, 0, PROTO_W, PROTO_H, panX, panY, contentW(), contentH());
    /* 网格：一格 ≥ 6px 时画细网格（一格一格补细节）；再画一条每 64 格的粗线当地标 */
    const cp = cellPx();
    if (cp >= 6) {
      ctx.strokeStyle = 'rgba(0,0,0,.13)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= PROTO_W; x++) {
        const px = Math.round(panX + x * cp) + 0.5;
        ctx.moveTo(px, panY);
        ctx.lineTo(px, panY + contentH());
      }
      for (let y = 0; y <= PROTO_H; y++) {
        const py = Math.round(panY + y * cp) + 0.5;
        ctx.moveTo(panX, py);
        ctx.lineTo(panX + contentW(), py);
      }
      ctx.stroke();
    }
    if (cp * 64 >= 40) {
      ctx.strokeStyle = 'rgba(0,0,0,.26)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= PROTO_W; x += 64) {
        const px = Math.round(panX + x * cp) + 0.5;
        ctx.moveTo(px, panY);
        ctx.lineTo(px, panY + contentH());
      }
      for (let y = 0; y <= PROTO_H; y += 64) {
        const py = Math.round(panY + y * cp) + 0.5;
        ctx.moveTo(panX, py);
        ctx.lineTo(panX + contentW(), py);
      }
      ctx.stroke();
    }
    statEl.textContent = statText;
    zoomEl.textContent = Math.round(zoom * 100) + '%';
  }

  /** 笔刷圆环：跟随指针（半径 = 笔刷格数 × 当前格宽）*/
  let ringX = -1;
  let ringY = -1;
  function drawRing() {
    if (!cctx) return;
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.clearRect(0, 0, vw, vh);
    if (ringX < 0) return;
    const r = Math.max(2, (brushCells - 0.5) * cellPx());
    cctx.beginPath();
    cctx.arc(ringX, ringY, r, 0, Math.PI * 2);
    cctx.strokeStyle = 'rgba(0,0,0,.55)';
    cctx.lineWidth = 3;
    cctx.stroke();
    cctx.beginPath();
    cctx.arc(ringX, ringY, r, 0, Math.PI * 2);
    cctx.strokeStyle = 'rgba(255,255,255,.85)';
    cctx.lineWidth = 1;
    cctx.stroke();
    cctx.beginPath();
    cctx.arc(ringX, ringY, 1.2, 0, Math.PI * 2);
    cctx.fillStyle = 'rgba(255,255,255,.9)';
    cctx.fill();
  }

  function resize() {
    const r = stage.getBoundingClientRect();
    vw = Math.max(120, Math.round(r.width));
    vh = Math.max(80, Math.round(r.height));
    canvas.width = vw;
    canvas.height = vh;
    cursorCanvas.width = vw;
    cursorCanvas.height = vh;
    clampPan();
    paint();
    drawRing();
  }

  /* ── 指针 → 原型格 ─────────────────────────────────────────────────────── */
  const cellAt = (clientX: number, clientY: number): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    /* backing store 可能比 CSS 尺寸大/小（窗口刚开、resize 还没跑完）⇒ 先按比例换到画布坐标 */
    const k = r.width ? vw / r.width : 1;
    const cp = contentW() / PROTO_W;
    return {
      x: Math.floor(((clientX - r.left) * k - panX) / cp),
      y: Math.floor(((clientY - r.top) * k - panY) / cp),
    };
  };

  /** 当前笔刷要写进去的值（噪声有**符号**、边缘是 1..8 的强度） */
  const currentValue = (): number => {
    const b = brushOf(toolId);
    if (layer === 'noise') return b.value === 0 ? 0 : (b.value > 0 ? strength : -strength);
    if (layer === 'edge') return b.value === 0 ? 0 : strength;
    return b.value;
  };

  const stamp = (cx: number, cy: number) => {
    const val = currentValue();
    const arr = layers[layer];
    if (layer === 'land') landRevision++;
    if (layer === 'land' || layer === 'edge') previewDirty = true;
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

  /** 复制一层（Int8 / Uint8 各按自己的类型 copy —— 别用类型断言骗过去） */
  const snapshotOf = (id: LayerId): Uint8Array | Int8Array => {
    const a = layers[id];
    return a instanceof Int8Array ? new Int8Array(a) : new Uint8Array(a);
  };
  const restoreInto = (id: LayerId, data: Uint8Array | Int8Array) => {
    const t = layers[id] as unknown as Uint8Array;
    t.set(data as unknown as Uint8Array);
  };
  const pushUndo = () => {
    undoStack.push({ layer, data: snapshotOf(layer) });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
  };

  let drawing = false;
  let panning = false;
  let last: { x: number; y: number } | null = null;
  let panStart = { x: 0, y: 0, px: 0, py: 0 };
  let spaceDown = false;

  const setCursorGrab = (on: boolean) => { canvas.style.cursor = on ? 'grab' : 'crosshair'; };

  canvas.addEventListener('pointerdown', (e) => {
    /* 中键 / 空格 + 左键 = 平移（不吃绘制）*/
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      panning = true;
      panStart = { x: e.clientX, y: e.clientY, px: panX, py: panY };
      setCursorGrab(true);
      try { canvas.setPointerCapture?.(e.pointerId); } catch { /* 合成事件没有活动指针 */ }
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    pushUndo();
    drawing = true;
    last = cellAt(e.clientX, e.clientY);
    stamp(last.x, last.y);
    paintBuf();
    paint();
    try { canvas.setPointerCapture?.(e.pointerId); } catch { /* 合成事件没有活动指针 */ }
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
      drawRing();
      return;
    }
    if (drawing && last) {
      const p = cellAt(e.clientX, e.clientY);
      line(last, p);
      last = p;
      paintBuf();
      paint();
    }
    drawRing();
  });

  const endStroke = (e: PointerEvent) => {
    drawing = false;
    panning = false;
    last = null;
    setCursorGrab(false);
    try { canvas.releasePointerCapture?.(e.pointerId); } catch { /* 已释放 */ }
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', () => { ringX = -1; ringY = -1; drawRing(); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  /* 滚轮：以指针为锚缩放（缩放的目的是"凑近补细节"，所以锚点必须跟着光标走）*/
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const s0 = baseScale();
    const mx = (sx - panX) / (s0 * zoom);
    const my = (sy - panY) / (s0 * zoom);
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * Math.exp(-e.deltaY * 0.0016)));
    zoom = Math.round(next * 100) / 100;
    panX = sx - mx * s0 * zoom;
    panY = sy - my * s0 * zoom;
    clampPan();
    paint();
    drawRing();
  }, { passive: false });

  const setZoom = (z: number) => {
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
    clampPan();
    paint();
  };

  /* ── 顶栏 / 子栏的同步 ─────────────────────────────────────────────────── */
  function syncUi() {
    el.querySelectorAll('[data-layer]').forEach((b) => {
      (b as HTMLElement).classList.toggle('is-on', (b as HTMLElement).dataset.layer === layer);
    });
    const brushes = PALETTES[layer];
    brushesEl.innerHTML = brushes
      .map((b) => `<button class="lk-ed__tool${b.id === toolId ? ' is-on' : ''}" data-tool="${b.id}" title="${b.hint}">${b.label}</button>`)
      .join('');
    layerNameEl.textContent = LAYER_LABEL[layer];
    layerHintEl.textContent = brushOf(toolId).hint;
    const strOn = layer === 'noise' || layer === 'edge';
    strBox.style.display = strOn ? 'flex' : 'none';
    brushEl.value = String(brushCells);
    brushNEl.textContent = String(brushCells);
    strEl.value = String(strength);
    strNEl.textContent = String(strength);
  }

  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const layerBtn = t.closest('[data-layer]') as HTMLElement | null;
    if (layerBtn?.dataset.layer) {
      const next = layerBtn.dataset.layer as LayerId;
      if (LAYER_ORDER.includes(next) && next !== layer) {
        layer = next;
        toolId = PALETTES[layer][0].id;
        syncUi();
        paintBuf();
        paint();
      }
      return;
    }
    const toolBtn = t.closest('[data-tool]') as HTMLElement | null;
    if (toolBtn?.dataset.tool) {
      toolId = toolBtn.dataset.tool;
      syncUi();
      return;
    }
    if (t.closest('#ed-close')) { closeMapEditor(); return; }
    if (t.closest('#ed-zoom-in')) { setZoom(zoom * 1.5); return; }
    if (t.closest('#ed-zoom-out')) { setZoom(zoom / 1.5); return; }
    if (t.closest('#ed-zoom-fit')) { zoom = 1; clampPan(); paint(); return; }
    if (t.closest('#ed-undo')) {
      const prev = undoStack.pop();
      if (prev) {
        /* 撤销恢复的是"那一笔所在的那一层"：先切回去，否则看起来没反应 */
        layer = prev.layer;
        restoreInto(layer, prev.data);
        landRevision++;
        previewDirty = true;
        toolId = PALETTES[layer][0].id;
        syncUi();
        paintBuf();
        paint();
      }
      return;
    }
    if (t.closest('#ed-clear')) {
      pushUndo();
      (layers[layer] as unknown as Uint8Array).fill(0);
      if (layer === 'land') landRevision++;
      previewDirty = true;
      paintBuf();
      paint();
      return;
    }
    if (t.closest('#ed-import')) {
      if (layer !== 'land') { noteEl.textContent = '导入只支持「海陆」层（先切到海陆再导）'; return; }
      fileEl.click();
      return;
    }
    if (t.closest('#ed-export')) { exportPng(); return; }
    if (t.closest('#ed-go')) { void applyPatch(); return; }
  });

  brushEl.addEventListener('input', () => {
    brushCells = Math.max(1, Math.min(40, Number(brushEl.value) || 1));
    brushNEl.textContent = String(brushCells);
    drawRing();
  });
  strEl.addEventListener('input', () => {
    strength = Math.max(1, Math.min(8, Number(strEl.value) || 1));
    strNEl.textContent = String(strength);
  });
  /* 「留白 = 海洋」会改变边缘置换的衬底（没画的地方算不算海）⇒ 预览要重建 */
  (el.querySelector('#ed-blank-sea') as HTMLInputElement | null)?.addEventListener('change', () => {
    landRevision++;
    previewDirty = true;
    paintBuf();
    paint();
  });

  fileEl.addEventListener('change', () => {
    const f = fileEl.files?.[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    const im = new Image();
    im.onload = () => {
      const tmp = document.createElement('canvas');
      tmp.width = PROTO_W;
      tmp.height = PROTO_H;
      const tctx = tmp.getContext('2d');
      if (!tctx) { URL.revokeObjectURL(url); return; }
      tctx.drawImage(im, 0, 0, PROTO_W, PROTO_H);
      const data = tctx.getImageData(0, 0, PROTO_W, PROTO_H).data;
      pushUndo();
      for (let i = 0; i < PROTO_W * PROTO_H; i++) {
        const o = i * 4;
        const a = data[o + 3], g = data[o + 1], b = data[o + 2];
        layers.land[i] = a < 32 ? 0 : (g > b + 10 ? 1 : (b > g + 10 ? 2 : 0));
      }
      landRevision++;
      previewDirty = true;
      paintBuf();
      paint();
      noteEl.textContent = `已导入「${f.name}」到海陆层（绿 = 陆地、蓝 = 海洋、其它 = 留白）`;
      URL.revokeObjectURL(url);
    };
    im.onerror = () => { noteEl.textContent = '这张图读不出来，换一张 PNG 试试'; URL.revokeObjectURL(url); };
    im.src = url;
    fileEl.value = '';
  });

  /** 把当前层按调色板画成一张 PNG（导出后拿出去也看得出是哪一层）*/
  const exportPng = () => {
    const out = document.createElement('canvas');
    out.width = PROTO_W;
    out.height = PROTO_H;
    const octx = out.getContext('2d');
    if (octx) {
      const data = octx.createImageData(PROTO_W, PROTO_H);
      const d = data.data;
      const active = layers[layer];
      for (let i = 0; i < PROTO_W * PROTO_H; i++) {
        let r = 201, g = 198, b = 189;
        if (layer === 'land') {
          const lv = layers.land[i];
          if (lv === 1) { r = C_LAND[0]; g = C_LAND[1]; b = C_LAND[2]; }
          else if (lv === 2) { r = C_SEA[0]; g = C_SEA[1]; b = C_SEA[2]; }
        } else {
          const v = active[i];
          if (v) {
            const c = layer === 'zone' ? C_ZONE[v]
              : layer === 'climate' ? C_CLIMATE[v]
                : layer === 'noise' ? (v > 0 ? C_NOISE_UP : C_NOISE_DOWN) : C_EDGE;
            if (c) { r = c[0]; g = c[1]; b = c[2]; }
          }
        }
        const o = i << 2;
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
      }
      octx.putImageData(data, 0, 0);
    }
    const a = document.createElement('a');
    a.download = `原型-${LAYER_LABEL[layer]}.png`;
    a.href = out.toDataURL('image/png');
    a.click();
    noteEl.textContent = `已导出「${LAYER_LABEL[layer]}」层（1024×512，颜色即层语义）`;
  };

  const applyPatch = async () => {
    const st = hostStore;
    if (!st) return;
    const t = currentWorld(st).maps?.[0]?.terrain;
    const b = showBusy(el, '正在按原型生成…', { sub: '海陆 · 地形分区 · 气候 · 噪声 · 海岸 一起进生成器' });
    await nextFrame();
    try {
      /* ⭐ 「留白 = 海洋」（缺省勾上）：原型是"整个世界"的海陆 —— 没画的地方算海。
         不勾的话留白交给生成器随机（适合"我只想钉死东半球那块大陆"）。 */
      const blankSea = (el.querySelector('#ed-blank-sea') as HTMLInputElement | null)?.checked ?? true;
      const proto = encodeProto(layers, { blankSea });
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
    } catch (e) {
      b.done();
      noteEl.textContent = '生成失败：' + (e instanceof Error ? e.message : String(e));
    }
  };

  keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { closeMapEditor(); return; }
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.code === 'Space' || e.key === ' ') { spaceDown = true; setCursorGrab(true); e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      const prev = undoStack.pop();
      if (prev) {
        layer = prev.layer;
        restoreInto(layer, prev.data);
        landRevision++;
        previewDirty = true;
        toolId = PALETTES[layer][0].id;
        syncUi();
        paintBuf();
        paint();
      }
      return;
    }
    /* 1~5 切层（画地图时手不用离开画布） */
    const idx = Number(e.key) - 1;
    if (idx >= 0 && idx < LAYER_ORDER.length) {
      layer = LAYER_ORDER[idx];
      toolId = PALETTES[layer][0].id;
      syncUi();
      paintBuf();
      paint();
      return;
    }
    if (e.key === '[') { brushEl.value = String(Math.max(1, brushCells - 1)); brushEl.dispatchEvent(new Event('input')); }
    if (e.key === ']') { brushEl.value = String(Math.min(40, brushCells + 1)); brushEl.dispatchEvent(new Event('input')); }
  };
  keyUpHandler = (e: KeyboardEvent) => { if (e.code === 'Space' || e.key === ' ') { spaceDown = false; setCursorGrab(false); } };
  window.addEventListener('keydown', keyHandler);
  window.addEventListener('keyup', keyUpHandler);

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(stage);
  (el as HTMLElement & { _ro?: ResizeObserver | null })._ro = ro;

  syncUi();
  paintBuf();
  resize();
  window.requestAnimationFrame(() => resize());
  window.setTimeout(() => resize(), 120);
  noteEl.textContent = '地形 / 气候常显（换层也看得见）；边缘是湍流置换 —— 画下去海岸当场变形。画完按「按这幅生成」。';
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
