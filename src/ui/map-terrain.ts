/** 地形作图：把 `src/ui/map-gen.ts` 算出来的像素搬进 canvas、编码成 PNG dataURL；
 *  顺便把同一份网格里的**矢量线**（海岸线 / 湖岸 / 河）翻成 SVG path（2026-10-13 混合方案）。
 *
 *  为什么用 canvas 而不是塞图进数据文件：
 *    · `MapData.terrain` 里只存**参数**（种子/档位/数量），worldbuilding.json 只多几百字节；
 *    · 图在渲染时现算（纯函数 + 确定性）⇒ 换机器、换会话都是同一片地，也不怕文件膨胀；
 *    · PNG 编码交给浏览器（`toDataURL`），**零依赖**，不用自己写编码器。
 *
 *  ⭐ 混合方案（用户 2026-10-13：「地形主要是拿来看，文化分区什么的主要是拿来动手」）：
 *    栅格 = 地形本体（看）；矢量 = 岸线/湖岸/河（描边，放大不糊，以后能点能挂设定）。
 *    两者都从**同一份网格**派生 ⇒ 缓存网格，避免算两遍（900×500 约 60~150ms）。
 *  ⚠️ 缓存只按参数键 —— 同一份参数必然同一张图（生成器的确定性是前提）。 */

import { buildTerrain, polylinePath, smoothClosedPath, type MapStyle, type MapSpec, type TerrainGrid, type TerrainPath } from './map-gen';
import type { MapTerrainSpec } from '../store/types';

const keyOf = (t: MapTerrainSpec, w: number, h: number) => `${t.seed}|${t.style}|${JSON.stringify(t.spec ?? {})}|${w}x${h}`;

/* 网格缓存：栅格图与矢量线都从它派生（一张 225×125 的网格约 225KB，留 3 张够撤销重做来回） */
const grids = new Map<string, TerrainGrid>();

function gridOf(t: MapTerrainSpec, w: number, h: number): TerrainGrid {
  const key = keyOf(t, w, h);
  const hit = grids.get(key);
  if (hit) return hit;
  const g = buildTerrain(t, w, h);
  grids.set(key, g);
  if (grids.size > 3) {
    const first = grids.keys().next().value;
    if (first !== undefined && first !== key) grids.delete(first);
  }
  return g;
}

const cache = new Map<string, string>();

/** 参数 → 地形图 dataURL（空参数返回空串，调用方按空串跳过 <image>） */
export function terrainDataUrl(t: MapTerrainSpec | undefined, width: number, height: number): string {
  if (!t) return '';
  const key = keyOf(t, width, height);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const g = gridOf(t, width, height);
  const small = document.createElement('canvas');
  small.width = g.w;
  small.height = g.h;
  const sctx = small.getContext('2d');
  if (!sctx) return '';
  const img = sctx.createImageData(g.w, g.h);
  img.data.set(g.rgb);
  sctx.putImageData(img, 0, 0);
  /* 小图放大到真实尺寸：canvas 的双线性插值顺手把分区边界磨软 ⇒ 不会一格一格地硬切 */
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const octx = out.getContext('2d');
  if (!octx) return '';
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(small, 0, 0, width, height);
  const url = out.toDataURL('image/png');
  cache.set(key, url);
  if (cache.size > 6) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  return url;
}

/** 矢量层：海岸线 / 湖岸 / 河（SVG path 字符串，坐标已从"格"换算成地图单位）。
 *  缓存与栅格同一个键 ⇒ 同一次生成的两层永远对得上。 */
export interface TerrainVectors {
  coast: string[];
  lakes: string[];
  rivers: string[];
}

const EMPTY: TerrainVectors = { coast: [], lakes: [], rivers: [] };
const vecCache = new Map<string, TerrainVectors>();

export function terrainVectors(t: MapTerrainSpec | undefined, width: number, height: number): TerrainVectors {
  if (!t) return EMPTY;
  const key = keyOf(t, width, height);
  const hit = vecCache.get(key);
  if (hit) return hit;
  const g = gridOf(t, width, height);
  const sc = (pts: TerrainPath) => pts.map(([x, y]) => [x * g.cell, y * g.cell] as [number, number]);
  const out: TerrainVectors = {
    coast: g.coast.map((p) => smoothClosedPath(sc(p))),
    lakes: g.lakes.map((p) => smoothClosedPath(sc(p))),
    rivers: g.rivers.map((p) => polylinePath(sc(p))),
  };
  vecCache.set(key, out);
  if (vecCache.size > 6) {
    const first = vecCache.keys().next().value;
    if (first !== undefined) vecCache.delete(first);
  }
  return out;
}

/** 只要统计数字（提示行/助手回执）时用它 —— 不碰 canvas */
export function terrainSummary(t: MapTerrainSpec, width: number, height: number) {
  return gridOf(t, width, height).summary;
}

/** 给测试/诊断用：这份参数算出来的图多大（字节） */
export function terrainBytes(t: MapTerrainSpec, width: number, height: number): number {
  return terrainDataUrl(t, width, height).length;
}

/** 类型再导出（别的模块只要类型时不必再 import map-gen） */
export type { MapStyle, MapSpec };
