/** 地图底图的**落盘缓存**（第一百三十三轮）。
 *
 *  用户 2026-10-31：「为什么每次进入灵框时都要重新渲染一次地图」。
 *  地形是参数的纯函数 —— `MapData.terrain` 里只有种子 / 档位 / 数量 / 剪影，图每次现算
 *  （这是有意的：图不进 worldbuilding.json，数据文件才不会被几张位图撑大）。代价是每次启动
 *  都要重算一遍：**星球 ~1.9s（场 1.4 + 上色 0.5）、局部 ~130ms**，中间还得盖一层遮罩。
 *
 *  这里把**渲染好的那一帧**连同状态行那份统计，按"参数签名"存进 `userData/mapcache/`：
 *  下次启动签名没变就直接贴图 —— 不建网格、不算场、不挂遮罩、也不依赖 WebGL。
 *  落盘与 IPC 在 `main.js` 的 `map:cache-*`，本文件只管"键怎么算、什么时候命中"。
 *
 *  ⚠️ 三条纪律（改这块之前先读完）：
 *    ① **键里必须有决定画面的全部参数**：形态 / 种子 / 档位 / 看的方式 / 立体度 / 等高线 /
 *       spec / 手刷笔迹 / 剪影 / 地图尺寸 / 位图边长。少一项 = 换了参数还贴旧图。
 *    ② `MAP_CACHE_VERSION` 只在**生成算法**变了时抬（噪声、海平面、河流、湖、海底、上色管线的
 *       数学部分）。只改配色/材质/等高线默认值时**不用**手动抬 —— `styleFingerprint()`
 *       （`src/mapgen/styles.ts`）已经把它们打进键里了。
 *    ③ 忘了抬版本的后果是**用户永远看到旧地形**（代码是新的、画面是旧的），而且没有任何提示。
 *       所以：动 `src/mapgen/` 的算法 ⇒ 先来这里 +1。
 *
 *  ⚠️ 缓存是**派生数据**，不是资产：删掉 `userData/mapcache/` 只会让下次启动重算一遍；
 *     它不进 worldbuilding.json、不进备份、不进 git。
 *  ⚠️ 命中失败（没 IPC / 文件被删 / 解码失败 / 没有统计）一律**退回现算** —— 缓存坏了不能挡路。
 */

import { mapFormOf } from '../mapgen/planet';
import { styleFingerprint, type TerrainStats } from '../mapgen';
import { TERRAIN_BITMAP } from './map-terrain';
import { PLANET_VIEW_H } from './planet-view';
import type { MapTerrainSpec } from '../store/types';

/* ⚠️ 抬这个数字 = 本机所有旧底图作废（下次进灵框重算一遍）。规则见文件头第 ② 条。
   第一百三十三轮（2026-10-31）初版：1。 */
export const MAP_CACHE_VERSION = 1;

/** 与 `main.js` 的 `MAP_CACHE_MAX` 对齐（那里才是真正的闸门；这里只用来裁内存索引） */
const MAX_ENTRIES = 8;

interface Entry { key: string; stats: TerrainStats | null; ts: number }

/* 启动时只拉"索引"（key + 统计，几百字节），命中了才把那张图取回来 ——
   8 张 1536² 的图全搬进内存要多花十几 MB，而一次只显示一张。 */
let entries: Map<string, Entry> | null = null;
let loading: Promise<void> | null = null;

/** 缓存键：**决定这一帧像素的全部参数**。形态/种子/档位/看的方式/立体度/等高线/spec/笔迹/剪影/
 *  地图尺寸/位图边长，外加版本号与配色指纹。键一样 ⇒ 图一定一样（确定性内核的承诺）。 */
export function mapCacheKey(t: MapTerrainSpec, w: number, h: number): string {
  return [
    `v${MAP_CACHE_VERSION}`,
    styleFingerprint(),
    mapFormOf(t.form),
    t.seed ?? '', t.style ?? '',
    t.view ?? '', t.lift ?? '', t.contour ?? '',
    JSON.stringify(t.spec ?? {}),
    JSON.stringify(t.paint ?? []),
    JSON.stringify(t.mask ?? null),
    w, h, TERRAIN_BITMAP, PLANET_VIEW_H,
  ].join('\u0001');
}

/** 读一次索引（幂等；失败就当"没有缓存"，绝不抛）。 */
export function ensureMapCache(): Promise<void> {
  if (entries) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    try {
      const api = (window as any).lingkuangAPI;
      const r = api?.mapCacheIndex ? await api.mapCacheIndex() : null;
      const out = new Map<string, Entry>();
      if (r && r.ok && Array.isArray(r.entries)) {
        for (const e of r.entries) {
          if (!e || typeof e.key !== 'string') continue;
          out.set(e.key, { key: e.key, stats: e.stats ?? null, ts: Number(e.ts) || 0 });
        }
      }
      entries = out;
    } catch {
      /* 读不到就**这次不缓存**，但把 loading 放开 ⇒ 下一次重建还会再试一次
         （索引读失败往往是一次性的，不该让整个会话都失去加速）。 */
      loading = null;
    }
  })();
  return loading;
}

/** 这一份参数上次留下的统计（状态行用）。没有就是 null —— 命中要求统计也在，
 *  否则状态行会空着，那比多算一次更难看。 */
export function cachedStats(key: string): TerrainStats | null {
  return entries?.get(key)?.stats ?? null;
}

/** 取那张图（dataURL）。没命中 / 读写失败一律返回 ''。 */
export async function readCachedTerrainImage(key: string): Promise<string> {
  await ensureMapCache();
  if (!entries?.has(key)) return '';
  try {
    const api = (window as any).lingkuangAPI;
    const r = api?.mapCacheGet ? await api.mapCacheGet(key) : null;
    return r && r.ok && typeof r.url === 'string' ? r.url : '';
  } catch { return ''; }
}

/** 渲染完之后把这一帧交出去（**不 await、不挡界面**：IPC 写盘失败也不该影响看地图）。 */
export function putCachedTerrain(key: string, url: string, stats: TerrainStats | null): void {
  if (!key || !url || !stats) return;
  try {
    const api = (window as any).lingkuangAPI;
    if (!api?.mapCachePut) return;
    void Promise.resolve(api.mapCachePut(key, url, stats)).then((r: any) => {
      if (!r || !r.ok) return;
      if (!entries) entries = new Map();
      entries.set(key, { key, stats, ts: Date.now() });
      while (entries.size > MAX_ENTRIES) {
        const first = entries.keys().next().value as string | undefined;
        if (first === undefined) break;
        entries.delete(first);
      }
    }).catch(() => { /* 缓存写不进去不影响主流程 */ });
  } catch { /* 同上 */ }
}
