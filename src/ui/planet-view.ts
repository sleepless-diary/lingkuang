/** 星球形态接到界面上：**场缓存 + 2:1 画布 + 球体句柄 + 缩略图**。
 *
 *  与 `src/ui/map-terrain.ts`（局部形态，走 mapgen4 的 WebGL 画布）分工相同，但两条路**不共用实现**：
 *    · 局部 = 内核的 WebGL 渲染器（`TerrainView`），画布是**正方形**、只露中间一条横带；
 *    · 星球 = 本模块把等距圆柱图**直接画进 2D 画布**（1024×512 的位图按 CSS 缩放铺开，比例 2:1 绝不拉伸），
 *      另有一个球体视图（`./globe.ts`）。
 *
 *  ⚠️ 两条缓存分开：**场**（噪声/海平面/河流，~450ms）按 (种子, 档位, 数量, 分辨率) 缓存；
 *  **上色**（八档「看的方式」，~45ms）按 场 + 风格 缓存 ⇒ 换风格不重算地形（与局部形态同一条规矩）。
 *  ⚠️ 图**不落盘**：`MapData.terrain` 里只有几百字节参数。 */

import { PLANET_H, buildPlanetField, renderPlanet, type PlanetField } from '../mapgen/planet';
import type { MapgenSpecInput, TerrainStats } from '../mapgen';
import type { MapTerrainSpec } from '../store/types';
import { mountGlobe, type GlobeHandle } from './globe';

/** 地图栏与球体贴图用的分辨率（1536×768 ≈ 1.2s —— 只在换星球/换档位时算一次）。
 *  ⭐ 2026-10-13 用户「**分辨率和细节都不够**」：从 512 抬到 768（1024×512 → 1536×768）。
 *  再往上（1024 ⇒ 2048×1024）生成时间与场缓存都要翻倍，收益却只在高倍放大时才看得见。 */
export const PLANET_VIEW_H = PLANET_H;
/** 预览与抽卡用的分辨率（512×256，约 150ms —— 一次抽 6 张也跟得上）*/
export const PLANET_PREVIEW_H = 256;

const fields = new Map<string, PlanetField>();
const colors = new Map<string, Uint8ClampedArray>();
/* 场缓存从 4 降到 3：768 高时一张场约 27 MB（8 个数组），4 张就上 100 MB 了 */
const MAX_FIELDS = 3;
const MAX_COLORS = 6;

const fieldKeyOf = (t: MapTerrainSpec, h: number) =>
  `${t.seed}|${t.style}|${JSON.stringify(t.spec ?? {})}|${h}`;
const colorKeyOf = (t: MapTerrainSpec, h: number, view: string) => `${fieldKeyOf(t, h)}|${view}`;

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
  const f = buildPlanetField(t.seed, t.style, (t.spec ?? {}) as MapgenSpecInput, h);
  fields.set(key, f);
  trim(fields, MAX_FIELDS);
  return f;
}

/** 上色（「看的方式」八档）—— 便宜，但抽卡/切档会连点，也缓存 */
export function planetRgba(t: MapTerrainSpec, h: number, view: string): Uint8ClampedArray {
  const key = colorKeyOf(t, h, view);
  const hit = colors.get(key);
  if (hit) return hit;
  const out = renderPlanet(planetField(t, h), view);
  colors.set(key, out);
  trim(colors, MAX_COLORS);
  return out;
}

/** 状态行 / 助手回执要的那几个数字（与局部形态同一套字段）*/
export function planetStats(t: MapTerrainSpec | undefined, h: number = PLANET_VIEW_H): TerrainStats | null {
  if (!t) return null;
  return planetField(t, h).stats;
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

/** 把星球图铺进画布：画布本体 = 原图分辨率（1024×512），CSS 缩放铺到 `w × w/2`（**2:1 不拉伸**）。
 *  比格子矮就上下留边居中（`boxH` 是地图格子高，通常 500；图高 450 ⇒ 各留 25px）。 */
export function mountPlanet(
  canvas: HTMLCanvasElement, t: MapTerrainSpec, w: number, boxH: number, view: string,
): PlanetHandle {
  const f = planetField(t, PLANET_VIEW_H);
  const drawH = Math.round(w / 2);
  canvas.width = f.w;
  canvas.height = f.h;
  canvas.style.position = 'absolute';
  canvas.style.left = '0px';
  canvas.style.top = Math.max(0, Math.round((boxH - drawH) / 2)) + 'px';
  canvas.style.width = w + 'px';
  canvas.style.height = drawH + 'px';
  canvas.style.pointerEvents = 'none';       /* 手绘层在上面：指针要能穿过去 */
  const ctx = canvas.getContext('2d');
  const put = (rgba: Uint8ClampedArray) => {
    if (!ctx) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), f.w, f.h), 0, 0);
  };
  put(planetRgba(t, PLANET_VIEW_H, view));
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
  const side = Math.min(w, boxH);
  canvas.style.position = 'absolute';
  canvas.style.left = Math.round((w - side) / 2) + 'px';
  canvas.style.top = Math.round((boxH - side) / 2) + 'px';
  canvas.style.width = side + 'px';
  canvas.style.height = side + 'px';
  canvas.style.cursor = 'grab';
  const f = planetField(t, PLANET_VIEW_H);
  const globe = mountGlobe(canvas, f, planetRgba(t, PLANET_VIEW_H, view));
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
