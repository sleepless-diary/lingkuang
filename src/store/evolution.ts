/** 灵框 · 演变（实体版本历史）—— 纯逻辑，不碰 DOM / store
 *
 *  与 git 同构的三件事：
 *   1. **初稿**（`Entity` 自己的 name/typeId/properties/doc）= 第 0 版
 *   2. **帧**（`EntityFrame[]`）= 提交，只存与上一帧的区别，锚在时间线的一个事件节点上
 *   3. **物化**（`statesOf`）= 初稿按顺序叠加所有帧，得到每一刻的样子
 *
 *  为什么要"物化一次、数组存起来"（用户明确提的性能要求）：
 *   拖帧条要看任意一帧的样子。若每换一帧就从初稿重算，n 帧要算 n(n+1)/2 次 = O(n²)，
 *   帧一多就卡。`statesOf` 一次算出**全部**前缀（O(n)），之后任意一帧都是 O(1) 取数组元素。
 *
 *  ⚠️ 这里所有函数都**不改传入的对象**（除 `normalizeFrames` 明确就地整理数组，见其注释）。
 */
import type { DocHunk, DocPatch, Entity, EntityFrame, FramePatch, PropValue, TimelineNode, Worldset } from './types';
import { calendarOf, timePointOf, toEpoch, buildYearTable } from '../calendar';

/** 物化出来的一版样子（= 某一刻的实体） */
export interface EntityState {
  name: string;
  typeId: string;
  properties: Record<string, PropValue>;
  doc: string;
}

/** LCS 表的格子上限：超过就退回「一整段替换」。
 *  正文一般几十到几百行（400×400 = 16 万格，一次几毫秒）；真有人贴进几千行时，
 *  宁可让这一帧存大一点，也不要每次保存都算一张千万格的表。 */
const LCS_MAX_CELLS = 400_000;

function cloneValue(v: PropValue): PropValue {
  return Array.isArray(v) ? v.slice() : v;
}

/** 值的相等判断（数组按元素比 —— `['冰'] !== ['冰']` 是引用比较，会导致每帧都记一遍没变的列表） */
export function sameValue(a: PropValue | undefined, b: PropValue | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = Array.isArray(a) ? a : [];
    const y = Array.isArray(b) ? b : [];
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  return a === b;
}

/** 实体的初稿（第 0 版） */
export function baseState(e: Entity): EntityState {
  return {
    name: e.name ?? '',
    typeId: e.typeId ?? '',
    properties: { ...(e.properties ?? {}) },
    doc: e.doc ?? '',
  };
}

/* ── 正文（Markdown）按行存差异 ───────────────────────────────────── */

/** 空串 = 0 行（不是「1 个空行」—— 否则空正文与只有一个空行的正文会互相产生差异） */
function splitLines(s: string): string[] {
  const t = String(s ?? '');
  return t === '' ? [] : t.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/** 对一段（已裁掉公共前后缀的）区域做 LCS，产出多段 hunk。
 *  `offset` 把这些行号平移回**上一版**的坐标。返回按 `at` 从大到小排好序。 */
function lcsHunks(a: string[], b: string[], offset: number): DocHunk[] {
  const m = a.length, n = b.length, w = n + 1;
  const dp = new Uint32Array((m + 1) * w);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const hunks: DocHunk[] = [];
  let cur: DocHunk | null = null;
  const flush = () => { if (cur && (cur.del.length || cur.ins.length)) hunks.push(cur); cur = null; };
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) { flush(); i++; j++; continue; }
    if (!cur) cur = { at: offset + i, del: [], ins: [] };
    /* 两条路都不缩短 LCS 时优先"插"（与多数 diff 工具一致：新增看起来比删除自然） */
    if (j < n && (i >= m || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) { cur.ins.push(b[j]); j++; }
    else { cur.del.push(a[i]); i++; }
  }
  flush();
  hunks.reverse();          /* at 从大到小 —— 应用时从后往前，天然不用算偏移 */
  return hunks;
}

/** 算两版正文的差异。改动大到「差异比正文还长」时改用 `full`（整段存）。 */
export function docDiff(prev: string, next: string): DocPatch {
  if (prev === next) return {};
  const a = splitLines(prev), b = splitLines(next);
  /* 先裁公共前后缀：最常见的"接着往下写"就是一条 hunk，不用建表 */
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const am = a.slice(p, a.length - s), bm = b.slice(p, b.length - s);
  const hunks = am.length * bm.length > LCS_MAX_CELLS
    ? [{ at: p, del: am, ins: bm }]                                    /* 太大：整块换 */
    : lcsHunks(am, bm, p);
  const touched = hunks.reduce((n2, h) => n2 + h.del.length + h.ins.length, 0);
  if (touched > b.length) return { full: next };                       /* 差异比正文还长 → 整段更省 */
  return { hunks };
}

/** 在一版正文上应用差异。手改过的 .md 可能让 `at` 越界 —— 夹到合法范围，宁可错位也不抛异常。 */
export function applyDoc(prev: string, patch: DocPatch | undefined): string {
  if (!patch) return prev;
  if (typeof patch.full === 'string') return patch.full;
  const lines = splitLines(prev);
  for (const h of patch.hunks ?? []) {          /* 已按 at 从大到小排好 */
    const at = Math.max(0, Math.min(lines.length, Math.floor(h.at) || 0));
    const del = Math.max(0, Math.min(lines.length - at, h.del.length));
    lines.splice(at, del, ...h.ins);
  }
  return lines.join('\n');
}

/* ── 帧：与上一版的区别 ──────────────────────────────────────────── */

/** 算 `prev → next` 的区别。**没变化返回 null**（不产生空帧）。 */
export function frameDiff(prev: EntityState, next: EntityState): FramePatch | null {
  const p: FramePatch = {};
  if (prev.name !== next.name) p.name = next.name;
  if (prev.typeId !== next.typeId) p.typeId = next.typeId;
  const set: Record<string, PropValue> = {};
  const pp = prev.properties ?? {}, np = next.properties ?? {};
  for (const k of Object.keys(np)) if (!sameValue(pp[k], np[k])) set[k] = cloneValue(np[k]);
  const del = Object.keys(pp).filter((k) => !(k in np));
  if (Object.keys(set).length) p.set = set;
  if (del.length) p.del = del;
  if ((prev.doc ?? '') !== (next.doc ?? '')) p.doc = docDiff(prev.doc ?? '', next.doc ?? '');
  if (p.name === undefined && p.typeId === undefined && !p.set && !p.del && !p.doc) return null;
  return p;
}

/** 把一帧的差异叠加到一版样子上 */
export function applyPatch(st: EntityState, patch: FramePatch | undefined): EntityState {
  if (!patch) return st;
  const properties = { ...(st.properties ?? {}) };
  if (patch.set) for (const [k, v] of Object.entries(patch.set)) properties[k] = cloneValue(v);
  if (patch.del) for (const k of patch.del) delete properties[k];
  return {
    name: patch.name ?? st.name,
    typeId: patch.typeId ?? st.typeId,
    properties,
    doc: patch.doc ? applyDoc(st.doc, patch.doc) : st.doc,
  };
}

/** 一次算出**全部**前缀：[初稿, 第1帧后, 第2帧后, …]（长度 = 帧数 + 1）。
 *  返回的下标即"版本号"：0 = 初稿，k = 第 k 帧之后的样子。 */
export function statesOf(e: Entity): EntityState[] {
  const out: EntityState[] = [baseState(e)];
  for (const f of e.frames ?? []) out.push(applyPatch(out[out.length - 1], f.patch));
  return out;
}

/** 某个版本的一版样子（越界就取最近的一版） */
export function stateOf(e: Entity, version: number): EntityState {
  const all = statesOf(e);
  const i = Math.max(0, Math.min(all.length - 1, Math.floor(version) || 0));
  return all[i];
}

/** 某一帧的差异摘要（帧条上那一行小字）。只看改了什么，不展开正文内容。 */
export function patchSummary(p: FramePatch | undefined, max = 3): string {
  if (!p) return '';
  const bits: string[] = [];
  if (p.name !== undefined) bits.push('名字');
  if (p.typeId !== undefined) bits.push('类型');
  const keys = Object.keys(p.set ?? {});
  for (const k of keys.slice(0, max)) bits.push(k);
  if (keys.length > max) bits.push(`等 ${keys.length} 项`);
  if (p.del?.length) bits.push(`清空 ${p.del.length} 项`);
  if (p.doc) bits.push(hasDocChange(p.doc) ? '正文' : '');
  const s = bits.filter(Boolean).join('、');
  return s || '（无内容变化）';
}

/** 这一帧的正文差异是否真的改了东西（空的 hunks 也算"没改"） */
export function hasDocChange(p: DocPatch | undefined): boolean {
  if (!p) return false;
  if (typeof p.full === 'string') return true;
  return (p.hunks ?? []).some((h) => h.del.length || h.ins.length);
}

/** 一帧是不是"空帧"（只做时间标记，没改内容） */
export function isEmptyPatch(p: FramePatch | undefined): boolean {
  if (!p) return true;
  return p.name === undefined && p.typeId === undefined
    && !Object.keys(p.set ?? {}).length && !(p.del ?? []).length && !hasDocChange(p.doc);
}

/* ── 锚点：帧挂在哪个节点上 ──────────────────────────────────────── */

/** 全世界所有节点的 epoch 秒（键 = 节点 id）。
 *  与 `src/ui/timeline.ts:64 nodeEpoch` 同一套换算（历法 + 年表），这里建一次表给所有节点共用。 */
export function epochOfNodes(ws: Worldset | undefined): Map<string, number> {
  const out = new Map<string, number>();
  const tls = Object.values(ws?.timelines ?? {}) as any[];
  for (const tl of tls) {
    const cal = calendarOf(tl ?? {});
    const nodes = (tl?.nodes ?? []) as TimelineNode[];
    if (!nodes.length) continue;
    const years = nodes.map((n) => Number(n.year ?? 0));
    const table = buildYearTable(cal, Math.min(...years) - 1, Math.max(...years) + 1);
    for (const n of nodes) out.set(n.id, toEpoch(cal, timePointOf(Number(n.year ?? 0), n), table));
  }
  return out;
}

/** 按锚点时间排序 + 一个节点只留一帧（后写的赢）+ 丢掉没有 nodeId 的脏数据。
 *  **就地整理 `e.frames`**（与 `src/store/entities.ts` 的 ensureXxx 同风格），返回是否改动过。 */
export function normalizeFrames(e: Entity, epochOf: (nodeId: string) => number): boolean {
  const before = e.frames ?? [];
  const byNode = new Map<string, EntityFrame>();
  for (const f of before) if (f && f.nodeId) byNode.set(f.nodeId, f);
  const sorted = [...byNode.values()].sort((a, b) => {
    const d = epochOf(a.nodeId) - epochOf(b.nodeId);
    return d !== 0 ? d : String(a.nodeId).localeCompare(String(b.nodeId));
  });
  const changed = sorted.length !== before.length || sorted.some((f, i) => f !== before[i]);
  if (changed) e.frames = sorted;
  return changed;
}

/** 离 `cursor`（epoch 秒）最近的**已有帧**的版本号（1 基，配 `statesOf` 的下标）；没有帧则返回 0（初稿）。 */
export function nearestVersion(e: Entity, epochOf: (nodeId: string) => number, cursor: number): number {
  const frames = e.frames ?? [];
  let best = 0, bestD = Infinity;
  frames.forEach((f, i) => {
    const d = Math.abs(epochOf(f.nodeId) - cursor);
    if (d < bestD) { bestD = d; best = i + 1; }        /* 并列取更早的那帧（确定性） */
  });
  return best;
}

/** 站在某个节点上时"看到的是哪一版"：该节点有帧就是它，否则是**它之前最近的一帧**（floor）；
 *  一个帧都没有 → 初稿（0）。`nodeEpoch` 是选中节点的 epoch 秒。 */
export function versionAtNode(e: Entity, epochOf: (nodeId: string) => number, nodeEpoch: number, nodeId?: string): number {
  const frames = e.frames ?? [];
  if (nodeId) {
    const hit = frames.findIndex((f) => f.nodeId === nodeId);   /* 这一格自己有帧 → 就是它 */
    if (hit >= 0) return hit + 1;
  }
  let best = 0;
  for (let i = 0; i < frames.length; i++) {
    /* 帧已按时间排好：最后一个不晚于选中节点的就是 floor */
    if (epochOf(frames[i].nodeId) <= nodeEpoch) best = i + 1;
    else break;
  }
  return best;
}
