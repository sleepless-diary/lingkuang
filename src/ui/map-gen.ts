/** 地图生成的**参数层**（UI 与助手共用的一份规矩）。
 *
 *  ⭐ 2026-10-15（用户：「好丑，有没有现成的轮子，我们生成的地图好假」→ 选定 A2「整包搬 mapgen4」）：
 *  **地形内核换成 vendored 的 mapgen4**（`src/mapgen/`，Apache-2.0，见 `src/mapgen/NOTICE.md`）。
 *  本文件因此瘦身成四件事，不再自己算地形：
 *    ① `MAP_STYLES` / `MapStyle`：档位（大陆 / 群岛 / 盘古）—— 映射到内核参数的组合；
 *    ② `MapSpec`：创作者能调的**三个**数量旋钮（陆地占比 / 山脊 / 河）；
 *    ③ `parseMapPrompt()` / `planGeneration()`：一句话 → 档位与旋钮（**描述本身当种子**）；
 *    ④ `generateIntoMap()`：**唯一落盘入口**（面板「采用到地图」与助手的 `generate_map` 共用）。
 *
 *  ⚠️ 换内核后**有几项不再可控**，别在界面上假装还在（`APPLY_NOTES` 会显示给创作者看）：
 *    · 陆块数 / 岛数：内核的陆地形状由噪声 + 岛屿度决定，不是数出来的；
 *    · 湖：内核不"挖"湖，内陆低地被淹就是内陆海（所以湖数可能是 0）。
 *  仍可控：**陆地占比**（内核里由灵框加了"按分位数重定海平面"，精确命中）、
 *  **山脊密度**（→ 山峰间距）、**河流密度**（→ 流量的分位数阈值）。 */

import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import { uid } from '../store/ids';
import type { MapData, MapMask } from '../store/types';
import {
  APPLY_NOTES, DEFAULT_TERRAIN_STYLE, MAPGEN_STYLES, createEngineFor, isContourMode, isTerrainStyle,
  runGeneration, statsOf, terrainStyleLabel,
  type MapgenSpecInput, type MapgenStyle, type TerrainStats,
} from '../mapgen';
import { isMapForm, mapFormLabel, type MapForm } from '../mapgen/planet';
import { PLANET_PREVIEW_H, planetField } from './planet-view';

export type MapStyle = MapgenStyle;

/** 创作者能调的数量。空着 = 交给档位默认值（别写 0 —— 0 是"一个都不要"）。 */
export type MapSpec = MapgenSpecInput;

/** 面板状态行 / 助手回执读的那份统计（内核算的，字段名沿用灵框原来那套） */
export type MapGenSummary = TerrainStats;

export interface MapGenResult {
  ok: boolean;
  note: string;
}

export const MAP_STYLES: { id: MapStyle; label: string; hint: string }[] = [
  { id: 'continent', label: '大陆', hint: '两三块大陆 + 若干岛；山峰成带、迎风坡多雨' },
  { id: 'archipelago', label: '群岛', hint: '一片碎岛与海峡：海岸线碎、岛多、陆地少' },
  { id: 'pangaea', label: '盘古', hint: '一整块超级大陆，边缘完整、内陆干旱' },
];

export function styleHint(id: MapStyle): string {
  return MAP_STYLES.find((s) => s.id === id)?.hint ?? '';
}

/** 换内核后**做不到**的事（面板上如实写出来，别让创作者以为是自己没调对） */
export const MAP_LIMITS = APPLY_NOTES;

/* ── 几何小工具（手绘区域与轨迹用；和内核无关，留着）──────────────────────── */
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Catmull-Rom 平滑 → 闭合 SVG path（手绘区域用）
 *  ⭐ 第一百一十轮：控制臂要**限长**（k ≤ 2·本段长 / 邻点跨度）。
 *  否则首尾缺口一大（手绘松开闭合、两头离得远），相邻两点的控制臂会被拉到 20+ 单位外，
 *  曲线在起笔/收笔处甩出一个钩状凸起 —— 小图上就是一条突兀的"尖角"。 */
export function smoothClosedPath(pts: [number, number][]): string {
  if (pts.length < 3) return pts.map(([x, y]) => `M${r1(x)},${r1(y)}`).join(' ');
  const p = pts.map((pt) => ({ x: pt[0], y: pt[1] }));
  let d = `M${r1(p[0].x)},${r1(p[0].y)}`;
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y) || 1e-6;
  for (let i = 0; i < p.length; i++) {
    const p0 = p[(i - 1 + p.length) % p.length];
    const p1 = p[i];
    const p2 = p[(i + 1) % p.length];
    const p3 = p[(i + 2) % p.length];
    const seg = dist(p1, p2);
    const k1 = Math.min(1, (2 * seg) / dist(p0, p2));
    const k2 = Math.min(1, (2 * seg) / dist(p1, p3));
    const c1x = p1.x + ((p2.x - p0.x) / 6) * k1;
    const c1y = p1.y + ((p2.y - p0.y) / 6) * k1;
    const c2x = p2.x - ((p3.x - p1.x) / 6) * k2;
    const c2y = p2.y - ((p3.y - p1.y) / 6) * k2;
    d += ` C${r1(c1x)},${r1(c1y)} ${r1(c2x)},${r1(c2y)} ${r1(p2.x)},${r1(p2.y)}`;
  }
  return d + ' Z';
}

/** 从存盘的区域 path 里拆回端点序列（我们自己生成的格式：`M x,y C .. .. x,y ... Z`）。
 *  末尾那个点等于起点（闭合段回到了起点）⇒ 丢掉，避免"补边"永远是长度 0 的假段。 */
export function regionPoints(d: string): [number, number][] | null {
  const g = d.match(/-?\d+(?:\.\d+)?/g);
  if (!g || g.length < 8 || (g.length - 2) % 6 !== 0) return null;   /* 认不出格式就别动它 */
  const n = g.map(Number);
  const pts: [number, number][] = [[n[0], n[1]]];
  for (let i = 2; i + 5 < n.length; i += 6) pts.push([n[i + 4], n[i + 5]]);
  const lastP = pts[pts.length - 1];
  if (pts.length > 2 && Math.hypot(lastP[0] - pts[0][0], lastP[1] - pts[0][1]) < 0.05) pts.pop();
  return pts;
}

/** 区域 path → 该画的 `{ fill, stroke }`（第一百一十轮修"尖角"）。
 *
 *  两个毛病都出在**存盘的老 path**里（新画的已经被 `smoothClosedPath` 的限长规则修好了）：
 *  ① 首尾缺口大时，起笔/收笔两处的控制臂被拉出 20+ 单位 ⇒ 轮廓甩出一个钩状凸起；
 *  ② 拖拽画区域是"松开闭合"，手一松就补一条直边，缺得远时这条直边横穿地图。
 *  ⇒ 这里把端点拆出来**重算一遍**（限长 Catmull-Rom，顺手去掉钩），
 *     缺口比其它边中位数的 3 倍还长时，描边省掉那条补边（填色仍闭合，只是一层 0.25 的淡色）。
 *  认不出的 path（外来数据）原样返回，不把图弄坏。 */
export function regionPaths(d: string): { fill: string; stroke: string } {
  const pts = regionPoints(d);
  if (!pts || pts.length < 4) return { fill: d, stroke: d };
  const closed = smoothClosedPath(pts);
  const seg: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    seg.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const closing = seg[seg.length - 1];
  const rest = seg.slice(0, -1).sort((x, y) => x - y);
  const median = rest[rest.length >> 1] || 1;
  if (closing < median * 3) return { fill: closed, stroke: closed };
  return { fill: closed, stroke: closed.replace(/\s+C[^CZ]*Z$/, '') };
}

/** 开放折线 → SVG path（手绘轨迹 / 路线用） */
export function polylinePath(pts: [number, number][]): string {
  if (!pts.length) return '';
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${r1(x)},${r1(y)}`).join(' ');
}

/** 这块区域是不是「误拖出来的细长条」——用户在地图上拖一下（本意是想平移/随手点），
 *  「拖拽画区域」就落下一个几乎没面积的多边形；它在地图上只剩一条斜线，
 *  正是第一百一十轮报的"突兀的尖角"。
 *  判据：多边形面积 / 外接矩形面积 < 0.07（正经区域一般 0.2 以上，细长条只有几个百分点）。 */
export function regionIsSliver(pts: [number, number][]): boolean {
  if (pts.length < 4) return true;                       /* 不到 4 个点围不出一块面 */
  let area = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    area += a[0] * b[1] - b[0] * a[1];
    if (a[0] < minX) minX = a[0];
    if (a[0] > maxX) maxX = a[0];
    if (a[1] < minY) minY = a[1];
    if (a[1] > maxY) maxY = a[1];
  }
  const a = Math.abs(area / 2);
  const box = Math.max(1, (maxX - minX) * (maxY - minY));
  return a / box < 0.07;
}

/* ── 一句话 → 参数（离线，不调 AI）────────────────────────────────────────── */

const NUM = '(\\d{1,2}|[一二两三四五六七八九十])';
const CN: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function pickNum(text: string, re: RegExp): number | undefined {
  const m = text.match(re);
  if (!m) return undefined;
  const raw = m[1];
  const n = /^\d+$/.test(raw) ? Number(raw) : CN[raw];
  return Number.isFinite(n) ? n : undefined;
}

export interface MapPromptParse {
  style?: MapStyle;
  spec: MapSpec;
  /** ⭐ 形态（第九十八轮）：描述里点了「星球 / 整颗 / 全球」就出星球，点了「局部 / 一片」就出局部 */
  form?: MapForm;
  /** 认出来的词（面板上显示"按你说的：…"） */
  matched: string[];
}

/** 形态关键词。⚠️ 第一百零八轮：「局部」这个形态整个退场了（底图 = 星球总图，
 *  细节交给"区域精细化样本"）⇒ 这里只认「星球」；说「局部 / 一片地区」不再把形态切回局部
 *  —— 那是老数据的形态，仍能看，但不该被一句话又生出来。 */
const FORM_WORDS: [RegExp, MapForm, string][] = [
  [/星球|球面|球体|整颗|全球|行星|一整颗|planet/i, 'planet', '星球'],
];

/** 档位关键词。⚠️ 顺序即优先级：先问"群岛"，再"盘古"，最后才是"大陆"
 *  （"一片群岛"里也含"陆"字，所以具体的必须排在前面）。 */
const STYLE_WORDS: [RegExp, MapStyle, string][] = [
  [/群岛|岛链|碎岛|列岛|岛国|archipelago/i, 'archipelago', '群岛'],
  [/盘古|超级大陆|一整块|整块大陆|pangaea/i, 'pangaea', '盘古'],
  [/大陆|陆地|板块|continent/i, 'continent', '大陆'],
];

/** 数量关键词（只写内核真能做到的三项） */
const SPEC_WORDS: [RegExp, (s: MapSpec) => void, string][] = [
  [/崎岖|多山|山脊|山脉|群峰|雪山|高地/, (s) => { s.ridges = 7; }, '多山'],
  [/平原|盆地|坦荡|平坦|低地|少山/, (s) => { s.ridges = 2; }, '多平原'],
  [/水系|大河|江河|河网|湿润|雨林|沼泽|三角洲/, (s) => { s.rivers = 3; }, '水系发达'],
  [/干旱|沙漠|荒漠|缺水|贫瘠|荒原/, (s) => { s.rivers = 0; s.landRatio = 0.3; }, '干旱'],
  [/广袤|大片陆地|富饶|沃野|绿意/, (s) => { s.landRatio = 0.5; }, '大片陆地'],
  [/汪洋|水世界|零星小岛|礁/, (s) => { s.landRatio = 0.18; }, '少陆多海'],
];

/** 一句话 → {档位, 数量, 认出来的词}。**纯离线**（AI 不可用时也照用，见 `map-studio.ts`）。 */
export function parseMapPrompt(text: string): MapPromptParse {
  const t = String(text ?? '');
  let style: MapStyle | undefined;
  let form: MapForm | undefined;
  const matched: string[] = [];
  for (const [re, id, label] of FORM_WORDS) {
    if (re.test(t)) { form = id; matched.push(label); break; }
  }
  for (const [re, id, label] of STYLE_WORDS) {
    if (re.test(t)) { style = id; matched.push(label); break; }
  }
  const spec: MapSpec = {};
  for (const [re, apply, label] of SPEC_WORDS) {
    if (re.test(t)) { apply(spec); matched.push(label); }
  }
  /* 明说的数字压过形容词：「三条大河」「五条山脉」「陆地占 30%」 */
  const rivers = pickNum(t, new RegExp(NUM + '\\s*(?:条|道)?\\s*(?:大)?河'));
  if (rivers !== undefined) { spec.rivers = Math.max(0, Math.min(4, Math.round(rivers / 2) + 1)); matched.push(`${rivers} 条河`); }
  const ridges = pickNum(t, new RegExp(NUM + '\\s*(?:条|道|座)?\\s*(?:山|山脊|山脉)'));
  if (ridges !== undefined) { spec.ridges = Math.max(1, Math.min(8, Math.round(ridges) + 2)); matched.push(`${ridges} 条山`); }
  const ratio = Number((t.match(/(\d{1,2})\s*(?:%|％|个百分点)/) ?? [])[1]);
  if (Number.isFinite(ratio) && ratio > 0) {
    spec.landRatio = Math.max(0.15, Math.min(0.6, ratio / 100));
    matched.push(`陆地 ${ratio}%`);
  }
  return { style, spec, form, matched };
}

/* ── 计划与落盘 ───────────────────────────────────────────────────────────── */

export interface MapGenInput {
  description?: string;
  seed?: string;
  style?: string;
  spec?: MapSpec;
  /** ⭐ 「看的方式」（第九十七轮）：relief 立体 / contour 等高线 / flat 平面。
   *  不给 = 沿用这张地图原来那档（换地形不该重置创作者的显示偏好）。 */
  view?: string;
  /** ⭐ 「形态」（第九十八轮）：local 局部（mapgen4）/ planet 星球（球面生成）。
   *  不给 = 从描述里认（「星球」「一片地区」…），还认不出就沿用这张地图原来那个形态。
   *  ⚠️ 第一百零八轮起「局部」退场：不给就落回「星球」。 */
  form?: string;
  /** ⭐ 手绘海陆剪影（第一百零八轮）：编辑器画出来的掩膜，生成时按它钉死海陆。 */
  mask?: MapMask;
  /** ⭐ 等高线方式（第一百零八轮）：auto / all / half / fifth —— 显示参数，一并落盘。 */
  contour?: string;
}

export interface MapPlan {
  seed: string;
  style: MapStyle;
  spec: MapSpec;
  form: MapForm;
  matched: string[];
}

/** 把「描述 + 显式参数」合成一份可复现的生成计划（纯函数，UI 与助手共用同一份规矩）。
 *  ⚠️ **描述本身当种子**：同一句话永远同一片地（想换就按「换一颗」或去抽卡）。 */
export function planGeneration(input: MapGenInput): MapPlan {
  const desc = String(input.description ?? '').trim();
  const parsed = parseMapPrompt(desc);
  const seed = String(input.seed ?? '').trim() || desc || '灵框';
  const rawStyle = String(input.style ?? '') as MapStyle;
  const style = MAPGEN_STYLES.includes(rawStyle) ? rawStyle : (parsed.style ?? 'continent');
  const form: MapForm = isMapForm(input.form) ? input.form : (parsed.form ?? 'planet');
  return {
    seed,
    style,
    spec: { ...parsed.spec, ...(input.spec ?? {}) },
    form,
    matched: parsed.matched,
  };
}

/** 默认空地图（`src/ui/map.ts` 首次进地图、以及助手在还没建过地图的世界里生成时共用） */
export const DEFAULT_MAP = (): MapData => ({ id: uid('m'), name: '默认地图', width: 900, height: 500, regions: [], markers: [], paths: [] });

export interface MapApplyResult {
  ok: boolean;
  note: string;
  plan?: MapPlan;
  summary?: MapGenSummary;
}

/** ⭐ **唯一**的落盘入口：地图生成面板的「采用到地图」与助手的 `generate_map` 动作都走这里
 *  （一份实现 ⇒ 两条路的行为不会分叉）。一次 `store.update()` ⇒ 一步 Ctrl+Z 撤销；
 *  这个世界还没建过地图时顺手建一张默认地图，别让创作者先去点一次地图栏。
 *  ⚠️ 存的只是**参数**（种子/档位/数量），地形图在渲染时现算 ⇒ JSON 里只多几百字节。
 *  ⚠️ 这里**不碰画布**（助手那条路可能在没有地图栏的时候跑）：统计直接问内核要。 */
export function generateIntoMap(store: Store, input: MapGenInput): MapApplyResult {
  const plan = planGeneration(input);
  const before = currentWorld(store).maps?.[0];
  const w = before?.width ?? 900;
  const h = before?.height ?? 500;
  /* ⭐ 手刷笔迹：**种子与档位都没变**时留着（那还是同一片地，只是重新算了一遍 —— 刷过的
     地方照样有意义）；换种子/换档位就是另一片地了，笔迹自然作废。
     ⚠️ 星球形态**不画**笔迹（它不支持手刷），但笔迹仍留在数据里 —— 切回「局部」就回来了。
     ⚠️ 少了这一步，创作者刷了二十笔、去面板只调一个旋钮再「采用」，笔迹会被静默清掉。 */
  const old = before?.terrain;
  const keepPaint = old && old.seed === plan.seed && old.style === plan.style ? old.paint : undefined;
  /* ⭐ 「看的方式」（第九十七轮）：显式给了就用（工作室每次都给）；没给就沿用这张地图原来那档
     （助手的 `generate_map` 不带 view ⇒ 换一片地不该把创作者选的"看的方式"重置）；
     都没有才落回默认「立体」。它只是**显示参数** ⇒ 与"生成什么地形"无关、不参与缓存键。 */
  const view = isTerrainStyle(input.view)
    ? input.view
    : (isTerrainStyle(old?.view) ? old!.view! : DEFAULT_TERRAIN_STYLE);
  /* ⭐ 「形态」（第九十八轮）优先级：显式参数 > 描述里的词（「生成一颗星球」）> 这张地图原来那个
     > 默认「局部」。与 view 同一个道理：助手换一片地时不该悄悄把形态换掉。 */
  /* ⚠️ 第一百零八轮：底图 = 星球总图 ⇒ 没显式给形态时一律出星球（老数据里的 local 不再被沿用，
     否则创作者"采用"一次又会回到那个已经退场的形态）。 */
  const form: MapForm = isMapForm(input.form)
    ? input.form
    : (parseMapPrompt(String(input.description ?? '')).form ?? 'planet');
  plan.form = form;

  /* 统计：两种形态各问各的内核（星球那条不碰 mapgen4 的引擎，也就不会白建一次网格）。
     ⚠️ 星球这条必须用**预览分辨率**（256）：这里同步要一份统计给"已采用"那行字，
     用 PLANET_VIEW_H 就是一次 1.5s 的同步长任务（第一百零六轮实测：点「采用」卡 1.8s）。
     预览那张场刚刚算过、已缓存 ⇒ 这行字是白拿的；地图栏那份 768 的统计会自己重算。 */
  let s: TerrainStats;
  if (form === 'planet') {
    s = planetField({ seed: plan.seed, style: plan.style, spec: plan.spec, mask: input.mask }, PLANET_PREVIEW_H).stats;
  } else {
    const engine = createEngineFor(plan.seed, plan.style, plan.spec);
    runGeneration(engine, { strokes: keepPaint });   /* 统计要跟画布看到的一致 ⇒ 笔迹一起算 */
    s = statsOf(engine);
  }

  let created = false;
  store.update((d) => {
    const ws = d.worldsets[store.activeWorld];
    if (!ws) return;
    if (!ws.maps?.length) { ws.maps = [DEFAULT_MAP()]; created = true; }
    const m = ws.maps[0];
    /* 立体度 / 等高线方式是**显示参数**，换地形时沿用（用户挑过"顶视"就别给他弹回立体） */
    const lift = m.terrain?.lift;
    const contour = isContourMode(input.contour) ? input.contour : m.terrain?.contour;
    m.terrain = { seed: plan.seed, style: plan.style, spec: plan.spec, view, form };
    if (lift) m.terrain.lift = lift;
    if (contour) m.terrain.contour = contour;
    if (keepPaint?.length) m.terrain.paint = keepPaint;
    /* ⭐ 第一百零八轮：剪影只在与这颗种子/档位同一片地时才有意义（换种子就是另一颗星球），
       所以照旧"显式给了就写、没给就沿用旧的"。 */
    const mask = input.mask ?? (old && old.seed === plan.seed && old.style === plan.style ? old.mask : undefined);
    if (form === 'planet' && mask) m.terrain.mask = mask;
  });

  const what = plan.matched.length ? `（按你说的：${plan.matched.join('、')}）` : '';
  const kept = keepPaint?.length ?? 0;
  const isPlanet = form === 'planet';
  return {
    ok: true,
    plan,
    summary: s,
    note:
      `${created ? '这个世界还没有地图，我顺手建了一张「默认地图」并' : `已在「${before?.name ?? '默认地图'}」上`}` +
      `生成${isPlanet ? '了一颗星球' : '地形'}：` +
      `${s.lands} 块陆地 · ${s.islands} 座岛 · ${s.rivers} 条河 · 最高峰约 ${s.peak} m` +
      `（陆地占 ${Math.round(s.landRatio * 100)}%）${what}` +
      (isPlanet
        ? `。形态「星球」= 等距圆柱 2:1：**经度无缝、有两极**，地图栏点「球体看」就能贴到球上转着看；手刷只对「局部」形态有效`
        : (kept ? `（手刷的 ${kept} 笔保住了 —— 种子与档位没变）` : '')) +
      `（种子「${plan.seed}」，形态「${mapFormLabel(form)}」${input.mask ? '· 按你画的海陆剪影' : ''}，看的方式「${terrainStyleLabel(view)}」，` +
      `Ctrl+Z 可撤销，生成后照样能手绘精修。图是 ${w}×${h} 的现算图，不写进数据文件）`,
  };
}
