/** 全窗口大图的高清版（第一百零八轮；第一百零九轮加缓存与保存）。
 *
 *  用户原话：第一百零八轮「进入全窗口预览时能不能渲染一下更高的分辨率」；
 *  第一百零九轮「高清大图怎么每次都要重新算，不能保存吗」。
 *  拍板口径：**局部 3072² / 星球 2304×1152**，出图带遮罩进度。
 *
 *  缓存（第一百零九轮）：一张高清图在内存里留 **LRU 3 张**（键 = 形态/种子/档位/感知参数/
 *  剪影/尺寸）—— 同一张地形再点开是**瞬时**的，不重算也不出遮罩。3072² 的 dataURL 约 1~4MB，
 *  3 张 ≈ 十几 MB，可接受；地图语义一变（换种子/档位/看的方式/等高线/剪影）键就变，自然失效。
 *  要长期留档：查看器右上角的「保存」把 PNG 存到本地（`LightboxItem.download`）。
 *
 *  分工（别把两条路混在一起）：
 *    · `src/ui/map-terrain.ts` 的 `terrainFullUrl(t, w, h, size)` —— mapgen4 那条；
 *    · `src/ui/planet-view.ts` 的 `planetImageUrlHD(t, view)` —— 星球那条（分帧 + 进度）。
 *  本文件只是"按形态挑哪条 + 把进度折成一句人话 + 留一份缓存"，不碰内核。 */

import type { MapTerrainSpec } from '../store/types';
import { mapFormOf, mapFormLabel } from '../mapgen/planet';
import { terrainStyleOf, terrainStyleLabel } from '../mapgen';
import { TERRAIN_HD_BITMAP, terrainFullUrl } from './map-terrain';
import { PLANET_HD_H, planetImageUrlHD } from './planet-view';

export interface HdProgress {
  pct: number;
  phase?: string;
}

export interface HdImage {
  src: string;
  title: string;
  /** 显示在遮罩/状态行上的那一行说明 */
  note: string;
}

/** LRU 容量：3 张足够"来回看两张图 + 一张刚出的" */
const CACHE_MAX = 3;
const cache = new Map<string, HdImage>();

function keyOf(t: MapTerrainSpec, w: number, h: number): string {
  return JSON.stringify([
    mapFormOf(t.form), t.seed ?? '', t.style ?? '', t.view ?? '', t.lift ?? '', t.contour ?? '',
    t.spec ?? null, t.proto ?? null, t.mask ?? null, w, h,
  ]);
}

/** 命中缓存就返回（并把这条挪到队尾 = 最近用过）；没命中返回 null。 */
export function hdCached(t: MapTerrainSpec, w: number, h: number): HdImage | null {
  const k = keyOf(t, w, h);
  const hit = cache.get(k);
  if (!hit) return null;
  cache.delete(k);
  cache.set(k, hit);
  return hit;
}

/** 清掉缓存（换世界/换地图时调用也无害；数据变了键自己会变）*/
export function clearHdCache(): void {
  cache.clear();
}

export async function hdImageFor(
  t: MapTerrainSpec, w: number, h: number, onProgress?: (p: HdProgress) => void,
): Promise<HdImage> {
  const k = keyOf(t, w, h);
  const hit = cache.get(k);
  if (hit) {
    cache.delete(k);
    cache.set(k, hit);
    return hit;
  }
  const form = mapFormOf(t.form);
  const style = terrainStyleOf(t.view);
  const styleLabel = terrainStyleLabel(style);
  let out: HdImage;
  if (form === 'planet') {
    const src = await planetImageUrlHD(t, style, PLANET_HD_H, (p) => onProgress?.({ pct: p.pct, phase: p.phase }));
    out = {
      src,
      title: `${mapFormLabel(form)}（高清 ${PLANET_HD_H * 2}×${PLANET_HD_H}）· ${styleLabel}`,
      note: '星球高清图',
    };
  } else {
    onProgress?.({ pct: 0.35, phase: '建高清视图' });
    const src = await terrainFullUrl(t, w, h, TERRAIN_HD_BITMAP);
    onProgress?.({ pct: 1, phase: '出图' });
    out = {
      src,
      title: `${mapFormLabel(form)}（高清 ${TERRAIN_HD_BITMAP}²）· ${styleLabel}`,
      note: '地形高清图',
    };
  }
  cache.set(k, out);
  while (cache.size > CACHE_MAX) {
    const first = cache.keys().next();
    if (first.done) break;
    cache.delete(first.value);
  }
  return out;
}
