/** 星球形态接到界面上：**场缓存 + 2:1 画布 + 球体句柄 + 缩略图**。
 *
 *  与 `src/ui/map-terrain.ts`（局部形态，走 mapgen4 的 WebGL 画布）分工相同，但两条路**不共用实现**：
 *    · 局部 = 内核的 WebGL 渲染器（`TerrainView`），画布是**正方形**、只露中间一条横带；
 *    · 星球 = 本模块把等距圆柱图**直接画进 2D 画布**（1024×512 的位图按 CSS 缩放铺开，比例 2:1 绝不拉伸），
 *      另有一个球体视图（`./globe.ts`）。
 *
 *  ⚠️ 两条缓存分开：**场**（噪声/海平面/河流，~450ms）按 (种子, 档位, 数量, 分辨率) 缓存；
 *  **上色**（九档「看的方式」，~45ms）按 场 + 风格 缓存 ⇒ 换风格不重算地形（与局部形态同一条规矩）。
 *  ⚠️ 图**不落盘**：`MapData.terrain` 里只有几百字节参数。 */

import { PLANET_H, buildPlanetField, planetFieldGen, renderPlanet, renderPlanetGen, type PlanetField, type PlanetProgress } from '../mapgen/planet';
import { contourEveryOf } from '../mapgen/styles';
import type { MapgenSpecInput, TerrainStats } from '../mapgen';
import type { MapTerrainSpec } from '../store/types';
import { mountGlobe, type GlobeHandle } from './globe';

/** 地图栏与球体贴图用的分辨率（1536×768 ≈ 1.2s —— 只在换星球/换档位时算一次）。
 *  ⭐ 2026-10-13 用户「**分辨率和细节都不够**」：从 512 抬到 768（1024×512 → 1536×768）。
 *  再往上（1024 ⇒ 2048×1024）生成时间与场缓存都要翻倍，收益却只在高倍放大时才看得见。 */
export const PLANET_VIEW_H = PLANET_H;
/** 预览与抽卡用的分辨率（512×256，约 150ms —— 一次抽 6 张也跟得上）*/
export const PLANET_PREVIEW_H = 256;
/** ⭐ 第一百零八轮：**全窗口大图**的分辨率（2304×1152，约 2.25 倍像素）。
 *  用户原话：「进入全窗口预览时能不能渲染一下更高的分辨率」—— 点开大图才现算，
 *  算完马上释放（不进食谱缓存：一张 1152 高的场约 60MB）。 */
export const PLANET_HD_H = 1152;

const fields = new Map<string, PlanetField>();
const colors = new Map<string, Uint8ClampedArray>();
/* 场缓存从 4 降到 3：768 高时一张场约 27 MB（8 个数组），4 张就上 100 MB 了 */
const MAX_FIELDS = 3;
const MAX_COLORS = 6;

/* ⚠️ 键里**必须含剪影**（第一百零八轮）：同一颗种子画了剪影就是另一片地。 */
const fieldKeyOf = (t: MapTerrainSpec, h: number) =>
  `${t.seed}|${t.style}|${JSON.stringify(t.spec ?? {})}|${h}|${t.mask ? JSON.stringify(t.mask) : ''}`;
const colorKeyOf = (t: MapTerrainSpec, h: number, view: string) => `${fieldKeyOf(t, h)}|${view}|${contourEveryOf(t.contour)}`;

function trim<K, V>(m: Map<K, V>, max: number) {
  while (m.size > max) {
    const first = m.keys().next().value as K | undefined;
    if (first === undefined) break;
    m.delete(first);
  }
}

/** 场（噪声 / 海平面 / 河流 / 统计）—— 贵的那一步，必须缓存 */
export function planetField(t: MapTerrainSpec, h: number = PLANET_VIEW_H): PlanetField {
  const key = fieldKeyOf(t, h);
  const hit = fields.get(key);
  if (hit) return hit;
  const f = buildPlanetField(t.seed, t.style, (t.spec ?? {}) as MapgenSpecInput, h, t.mask ?? null);
  fields.set(key, f);
  trim(fields, MAX_FIELDS);
  return f;
}

/** 上色（「看的方式」九档）—— 便宜，但抽卡/切档会连点，也缓存 */
export function planetRgba(t: MapTerrainSpec, h: number, view: string): Uint8ClampedArray {
  const key = colorKeyOf(t, h, view);
  const hit = colors.get(key);
  if (hit) return hit;
  const out = renderPlanet(planetField(t, h), view, contourEveryOf(t.contour));
  colors.set(key, out);
  trim(colors, MAX_COLORS);
  return out;
}

/** 状态行 / 助手回执要的那几个数字（与局部形态同一套字段）*/
export function planetStats(t: MapTerrainSpec | undefined, h: number = PLANET_VIEW_H): TerrainStats | null {
  if (!t) return null;
  return planetField(t, h).stats;
}

/* ── 分帧驱动（第一百零六轮）────────────────────────────────────────────────
   用户：「给加载做一点提示，不然别人以为会卡了」。
   星球首次生成是 1.4s（场）+ 0.5s（上色）的同步长任务，遮罩画不出来。
   内核已经改成生成器（`planetFieldGen` / `renderPlanetGen`）⇒ 这里一帧跑一小片，
   顺便把"到哪一步了"换成 0..1 的进度。 */

/** 各阶段在整趟里的权重量程（[起, 止]）—— 实测耗时占比的粗略刻度，只用来画进度条 */
const PHASE_PCT: Record<string, [number, number]> = {
  '撒陆核与山体': [0.02, 0.04],
  '地形起伏': [0.04, 0.55],
  '定海平面': [0.55, 0.58],
  '算离海距离': [0.58, 0.65],
  '算离陆距离': [0.65, 0.66],
  '铺海底与陆地高度': [0.66, 0.665],
  '铺海底': [0.665, 0.70],
  '算温度与湿度': [0.70, 0.74],
  '排高度序': [0.74, 0.76],
  '算汇流': [0.76, 0.84],
  '连通河道': [0.84, 0.86],
  '认湖': [0.86, 0.88],
  '汇总统计': [0.88, 0.90],
  '量海深': [0.90, 0.91],
  '上色': [0.91, 1.0],
  '缓存': [1, 1],
};

export interface PlanetProgressInfo extends PlanetProgress { pct: number }
export type PlanetProgressCb = (p: PlanetProgressInfo) => void;

const pctOf = (p: PlanetProgress): number => {
  const band = PHASE_PCT[p.phase] ?? [0, 1];
  const local = p.total > 0 ? Math.min(1, Math.max(0, p.done / p.total)) : 1;
  return band[0] + (band[1] - band[0]) * local;
};

/** 跑一个生成器：每帧最多 12ms，然后让出；`from..to` 把这一段的进度映射进总进度 */
function drive<T>(gen: Generator<PlanetProgress, T, void>, onProgress: PlanetProgressCb | undefined, from: number, to: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tick = () => {
      try {
        const t0 = performance.now();
        let step = gen.next();
        while (!step.done && performance.now() - t0 < 12) step = gen.next();
        if (step.done) { resolve(step.value); return; }
        onProgress?.({ ...step.value, pct: from + (to - from) * pctOf(step.value) });
        requestAnimationFrame(tick);
      } catch (e) { reject(e); }
    };
    requestAnimationFrame(tick);
  });
}

/** 在飞的场/上色：同一份参数被两处同时要时只算一遍（地图栏 + 工作室预览） */
const inflightFields = new Map<string, Promise<PlanetField>>();
const inflightColors = new Map<string, Promise<Uint8ClampedArray>>();

/** 分帧版 `planetField`：界面用这个（能画进度），算完仍回填同一份缓存 */
export function planetFieldAsync(t: MapTerrainSpec, h: number = PLANET_VIEW_H, onProgress?: PlanetProgressCb): Promise<PlanetField> {
  const key = fieldKeyOf(t, h);
  const hit = fields.get(key);
  if (hit) { onProgress?.({ phase: '缓存', done: 1, total: 1, pct: 1 }); return Promise.resolve(hit); }
  const busy = inflightFields.get(key);
  if (busy) return busy;
  const job = drive(planetFieldGen(t.seed, t.style, (t.spec ?? {}) as MapgenSpecInput, h, t.mask ?? null), onProgress, 0, 0.9)
    .then((f) => {
      fields.set(key, f);
      trim(fields, MAX_FIELDS);
      inflightFields.delete(key);
      return f;
    }, (e) => { inflightFields.delete(key); throw e; });
  inflightFields.set(key, job);
  return job;
}

/** 分帧版 `planetRgba`：换「看的方式」时约 0.5s ⇒ 也切成小片，进度接着场的 0.9 往上走 */
export function planetRgbaAsync(t: MapTerrainSpec, h: number, view: string, onProgress?: PlanetProgressCb): Promise<Uint8ClampedArray> {
  const key = colorKeyOf(t, h, view);
  const hit = colors.get(key);
  if (hit) return Promise.resolve(hit);
  const busy = inflightColors.get(key);
  if (busy) return busy;
  const job = planetFieldAsync(t, h, onProgress).then((f) =>
    drive(renderPlanetGen(f, view, contourEveryOf(t.contour)), onProgress, 0.9, 1).then((out) => {
      colors.set(key, out);
      trim(colors, MAX_COLORS);
      inflightColors.delete(key);
      return out;
    }, (e) => { inflightColors.delete(key); throw e; }));
  inflightColors.set(key, job);
  return job;
}

export function clearPlanetCache(): void {
  fields.clear();
  colors.clear();
}

/* ── 挂到界面上 ──────────────────────────────────────────────────────────────── */

/** 与 `TerrainHandle`（局部形态）**同形**：地图栏不关心底下是哪一套内核 */
export interface PlanetHandle {
  dispose: () => void;
  setStyle: (v?: string) => void;
  regenerate: (opts?: { shape?: boolean }) => void;
  /** 与 `TerrainHandle.liveStats` 同义（星球没有手刷，场缓存里的 stats 就是最新） */
  liveStats: () => TerrainStats;
}

/** 把星球图铺进画布：画布本体 = 原图分辨率（1536×768），CSS 缩放铺到 `w × w/2`（**2:1 不拉伸**）。
 *  比格子矮就上下留边居中（`boxH` 是地图格子高，通常 500；图高 450 ⇒ 各留 25px）。 */
export function mountPlanet(
  canvas: HTMLCanvasElement, t: MapTerrainSpec, w: number, boxH: number, view: string,
): PlanetHandle {
  const f = planetField(t, PLANET_VIEW_H);
  return mountPlanetPrepared(canvas, t, w, boxH, view, f, planetRgba(t, PLANET_VIEW_H, view));
}

/** 已经算好场与 RGBA 的挂载版（界面的分帧路径用这个，避免二次计算） */
export function mountPlanetPrepared(
  canvas: HTMLCanvasElement, t: MapTerrainSpec, w: number, boxH: number, _view: string,
  f: PlanetField, rgba: Uint8ClampedArray,
): PlanetHandle {
  const drawH = Math.round(w / 2);
  canvas.width = f.w;
  canvas.height = f.h;
  canvas.style.position = 'absolute';
  canvas.style.left = '0px';
  canvas.style.top = Math.max(0, Math.round((boxH - drawH) / 2)) + 'px';
  canvas.style.width = w + 'px';
  canvas.style.height = drawH + 'px';
  canvas.style.pointerEvents = 'none';       /* 手绘层在上面：指针要能穿过去 */
  canvas.style.cursor = 'zoom-in';
  const ctx = canvas.getContext('2d');
  const put = (data: Uint8ClampedArray) => {
    if (!ctx) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(data), f.w, f.h), 0, 0);
  };
  put(rgba);
  return {
    dispose: () => { /* 2D 画布：没有 GL 资源要还 */ },
    setStyle: (v) => put(planetRgba(t, PLANET_VIEW_H, String(v ?? 'natural'))),
    regenerate: () => { /* 星球形态 v1 不支持手刷：画笔留给局部形态 */ },
    liveStats: () => f.stats,
  };
}

/** 球体视图：一块方画布 + 一颗真球。没 WebGL 时返回 `null`（调用方退化成平面图）。 */
export function mountGlobeView(
  canvas: HTMLCanvasElement, t: MapTerrainSpec, w: number, boxH: number, view: string,
): (PlanetHandle & { globe: GlobeHandle }) | null {
  const f = planetField(t, PLANET_VIEW_H);
  return mountGlobePrepared(canvas, t, w, boxH, view, f, planetRgba(t, PLANET_VIEW_H, view));
}

/** 与 `mountPlanetPrepared` 同理：球体那条也接已经算好的场 */
export function mountGlobePrepared(
  canvas: HTMLCanvasElement, _t: MapTerrainSpec, w: number, boxH: number, _view: string,
  f: PlanetField, rgba: Uint8ClampedArray,
): (PlanetHandle & { globe: GlobeHandle }) | null {
  const side = Math.min(w, boxH);
  canvas.width = side;
  canvas.height = side;
  canvas.style.position = 'absolute';
  canvas.style.left = Math.round((w - side) / 2) + 'px';
  canvas.style.top = Math.round((boxH - side) / 2) + 'px';
  canvas.style.width = side + 'px';
  canvas.style.height = side + 'px';
  canvas.style.cursor = 'grab';
  const globe = mountGlobe(canvas, f, rgba);
  if (!globe) return null;
  return {
    globe,
    dispose: () => globe.dispose(),
    setStyle: () => { /* 球体上换「看的方式」要重挂（贴图变了）—— 调用方按 key 重建 */ },
    regenerate: () => { /* 不支持手刷 */ },
    liveStats: () => f.stats,
  };
}

/* ── 缩略图（生成面板的预览与抽卡）──────────────────────────────────────────── */

/** 出图尺寸与格子同比例（2:1 居中留边），低分辨率场现算 —— 比局部形态那套（WebGL 截图）简单得多。 */
export function planetThumbUrl(
  t: MapTerrainSpec, _w: number, outW: number, outH: number, view: string,
): Promise<string> {
  try {
    const f = planetField(t, PLANET_PREVIEW_H);
    const rgba = planetRgba(t, PLANET_PREVIEW_H, view);
    const src = document.createElement('canvas');
    src.width = f.w;
    src.height = f.h;
    const sctx = src.getContext('2d');
    if (!sctx) return Promise.resolve('');
    sctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), f.w, f.h), 0, 0);
    const out = document.createElement('canvas');
    out.width = Math.max(16, Math.round(outW));
    out.height = Math.max(16, Math.round(outH));
    const ctx = out.getContext('2d');
    if (!ctx) return Promise.resolve('');
    /* 2:1 图放进 outW×outH 的卡面：按宽铺满、上下居中（与地图栏同一条规矩）*/
    const dh = Math.round(out.width / 2);
    const dy = Math.round((out.height - dh) / 2);
    ctx.fillStyle = '#101418';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, f.w, f.h, 0, dy, out.width, dh);
    return Promise.resolve(out.toDataURL('image/png'));
  } catch (e) {
    console.warn('[planet-view] 缩略图失败：', e);
    return Promise.resolve('');
  }
}

export function releasePlanetThumbs(): void {
  /* 2D 画布不占显存（位图随 GC 走）—— 留着这个函数是为了与 map-terrain 的调用点对称 */
}

/** 全尺寸图（大图查看器用）：整张 1536×768 等距圆柱图。缓存命中时是同步的（几百 KB dataURL）。 */
export function planetImageUrl(t: MapTerrainSpec, view: string, h: number = PLANET_VIEW_H): string {
  const f = planetField(t, h);
  const rgba = planetRgba(t, h, view);
  const c = document.createElement('canvas');
  c.width = f.w;
  c.height = f.h;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), f.w, f.h), 0, 0);
  return c.toDataURL('image/png');
}

/** ⭐ 第一百零八轮：**全窗口大图**（2304×1152）—— 现算、不缓存、算完即弃。
 *  用户原话：「进入全窗口预览时能不能渲染一下更高的分辨率」。
 *  与 planetImageUrl()（1536×768，走缓存）分工：那个给"点开就有"的即时图，
 *  这个给"点开大图"的一次性高清图（约 3~4s，调用方负责挂遮罩与进度）。
 *  ⚠️ 不写进 fields / colors（缓存表）：1152 高的场约 60MB，留着会把缓存挤掉还白占内存。 */
export async function planetImageUrlHD(
  t: MapTerrainSpec, view: string, h: number = PLANET_HD_H, onProgress?: PlanetProgressCb,
): Promise<string> {
  const f = await drive(
    planetFieldGen(t.seed, t.style, (t.spec ?? {}) as MapgenSpecInput, h, t.mask ?? null),
    onProgress, 0, 0.85,
  );
  const rgba = await drive(renderPlanetGen(f, view, contourEveryOf(t.contour)), onProgress, 0.85, 1);
  const c = document.createElement('canvas');
  c.width = f.w;
  c.height = f.h;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), f.w, f.h), 0, 0);
  return c.toDataURL('image/png');
}
