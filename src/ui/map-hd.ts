/** 全窗口大图的高清版（第一百零八轮）。
 *
 *  用户原话：「进入全窗口预览时能不能渲染一下更高的分辨率」。
 *  拍板口径：**局部 3072² / 星球 2304×1152**，都带遮罩进度，用完立刻释放。
 *
 *  分工（别把两条路混在一起）：
 *    · `src/ui/map-terrain.ts` 的 `terrainFullUrl(t, w, h, size)` —— mapgen4 那条；
 *    · `src/ui/planet-view.ts` 的 `planetImageUrlHD(t, view)` —— 星球那条（分帧 + 进度）。
 *  本文件只是"按形态挑哪条 + 把进度折成一句人话"，不碰内核。
 *
 *  ⚠️ 高清图**不缓存**：3072² 的 4 张 FBO 峰值约 190MB、1152 高的星球场约 60MB ——
 *  算完就还。调用方负责挂遮罩（`showBusy`）并且 `await nextFrame()` 之后再进来。 */

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

export async function hdImageFor(
  t: MapTerrainSpec, w: number, h: number, onProgress?: (p: HdProgress) => void,
): Promise<HdImage> {
  const form = mapFormOf(t.form);
  const style = terrainStyleOf(t.view);
  const styleLabel = terrainStyleLabel(style);
  if (form === 'planet') {
    const src = await planetImageUrlHD(t, style, PLANET_HD_H, (p) => onProgress?.({ pct: p.pct, phase: p.phase }));
    return {
      src,
      title: `${mapFormLabel(form)}（高清 ${PLANET_HD_H * 2}×${PLANET_HD_H}）· ${styleLabel}`,
      note: '星球高清图',
    };
  }
  onProgress?.({ pct: 0.35, phase: '建高清视图' });
  const src = await terrainFullUrl(t, w, h, TERRAIN_HD_BITMAP);
  onProgress?.({ pct: 1, phase: '出图' });
  return {
    src,
    title: `${mapFormLabel(form)}（高清 ${TERRAIN_HD_BITMAP}²）· ${styleLabel}`,
    note: '地形高清图',
  };
}
