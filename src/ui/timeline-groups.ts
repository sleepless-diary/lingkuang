/** 世界沙盘 · 密集区"时间组"的纯逻辑（第一百二十七轮）。
 *
 *  目的（用户 2026-10-25 讨论后定）：密集排布下"每个名字都同时显示"是做不到的
 *  —— 25 个节点跨 1752 年、中位间距 9 年 ⇒ 全览时相邻两点只隔 6~7px，名字却有 50~80px 宽。
 *  所以静态画面只负责"这一段有几件事"，把同一小段时间里的事件收成**一列**：
 *
 *      660–673 年                          ← 列头（AI 整理过就用它起的名字）
 *        蚀兽出现
 *        雅缇娜出生
 *        奥普菲斯出生
 *        +1                                ← 放不下的收成"+N"
 *
 *  **AI 接口**：列怎么分、叫什么，可以交给 AI —— 写在
 *  `%APPDATA%\lingkuang\sandbox-groups.json`（MCP 工具 `timeline_groups_get/set`）。
 *  这里只做两件事：① 有 AI 方案就按方案分组（没被分到的节点退回机械分组）；
 *  ② 没方案（或方案里没有这些节点）就按**屏幕像素**自动聚：相邻点挤到名字放不下就并一列。
 *  纯函数、不碰 DOM（探针/单测可以直接调）。
 */

export interface GroupNode {
  id: string;
  title: string;
  /** 历法原始年（列头与排序用） */
  year: number;
  /** 屏幕 x（相对轨道左缘，px） */
  x: number;
  /** true = 剧情事件（名字挂时间线上方） */
  story: boolean;
}

export interface GroupSpec {
  id: string;
  /** 列头文字（AI 起的名字；留空则用年份区间） */
  title?: string;
  from?: number;
  to?: number;
  nodes: string[];
  note?: string;
}

export interface GroupPlan {
  source?: 'ai' | 'manual';
  title?: string;
  groups: GroupSpec[];
  updatedAt?: string;
}

export interface Group {
  key: string;
  /** 列头：AI 标题，或年份区间 */
  head: string;
  /** 年份区间（AI 命名时作为副标题） */
  range: string;
  named: boolean;
  story: boolean;
  from: number;
  to: number;
  nodes: GroupNode[];
  cx: number;
  collapsed: boolean;
  /** 实际显示的行数（不含被 "+N" 顶掉的那些） */
  rows: number;
  hidden: number;
}

const rangeText = (from: number, to: number): string => (from === to ? `${from} 年` : `${from}–${to} 年`);

function finishGroup(members: GroupNode[], key: string, title?: string): Group {
  const sorted = members.slice().sort((a, b) => a.year - b.year || a.x - b.x);
  const story = sorted.filter((n) => n.story).length >= sorted.length / 2;   /* 多数派决定挂哪侧 */
  const from = sorted[0].year;
  const to = sorted[sorted.length - 1].year;
  const cx = sorted.reduce((s, n) => s + n.x, 0) / sorted.length;
  const named = !!(title && title.trim());
  return {
    key,
    head: named ? title!.trim() : rangeText(from, to),
    range: rangeText(from, to),
    named,
    story,
    from,
    to,
    nodes: sorted,
    cx,
    collapsed: false,
    rows: sorted.length,
    hidden: 0,
  };
}

/** 机械分组：同侧（剧情/世界分开）、相邻点屏幕间距 < minGap 就并进同一列；
 *  一列横向跨度超过 `minGap * 2.6` 或节点数超过 maxNodes 就另起一列。 */
export function mechanicalGroups(
  nodes: GroupNode[],
  opts: { minGapPx?: number; maxNodes?: number } = {}
): Group[] {
  const minGap = opts.minGapPx ?? 64;
  const maxNodes = opts.maxNodes ?? 12;
  const out: Group[] = [];
  for (const story of [true, false]) {
    const side = nodes.filter((n) => n.story === story).sort((a, b) => a.x - b.x);
    let cur: GroupNode[] = [];
    const flush = (): void => {
      if (!cur.length) return;
      out.push(finishGroup(cur, `auto-${out.length}`));
      cur = [];
    };
    for (const n of side) {
      const prev = cur[cur.length - 1];
      if (!prev) { cur = [n]; continue; }
      const close = n.x - prev.x < minGap;
      const tooWide = n.x - cur[0].x > minGap * 2.6;
      if (close && !tooWide && cur.length < maxNodes) cur.push(n);
      else { flush(); cur = [n]; }
    }
    flush();
  }
  return out.sort((a, b) => a.cx - b.cx);
}

/** 按 AI 方案分组：方案里出现的节点按方案走，没被分到的按机械分组补。 */
export function planGroups(
  nodes: GroupNode[],
  plan: GroupPlan | null | undefined,
  opts: { minGapPx?: number; maxNodes?: number } = {}
): Group[] {
  if (!plan || !Array.isArray(plan.groups) || !plan.groups.length) return mechanicalGroups(nodes, opts);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const used = new Set<string>();
  const out: Group[] = [];
  for (const spec of plan.groups) {
    const members = (spec.nodes || [])
      .map((id) => byId.get(id))
      .filter((n): n is GroupNode => !!n && !used.has(n.id));
    if (!members.length) continue;
    members.forEach((m) => used.add(m.id));
    const g = finishGroup(members, spec.id || `ai-${out.length}`, spec.title);
    if (typeof spec.from === 'number' && typeof spec.to === 'number') {
      g.from = spec.from;
      g.to = spec.to;
      g.range = rangeText(spec.from, spec.to);
      if (!g.named) g.head = g.range;
    }
    out.push(g);
  }
  const rest = nodes.filter((n) => !used.has(n.id));
  if (rest.length) out.push(...mechanicalGroups(rest, opts));
  out.sort((a, b) => a.cx - b.cx);
  return out;
}

/** 决定每列显示几行，并做一次"语义缩放"：
 *  `pxPerYear` 太小（远看，一年不到 1.2px）时整列收成「列头 + 数量」。 */
export function fitGroups(
  groups: Group[],
  opts: { maxRows: number; pxPerYear: number; collapseBelow?: number }
): Group[] {
  const below = opts.collapseBelow ?? 0.3;
  return groups.map((g) => {
    if (g.nodes.length < 2) return { ...g, rows: 1, hidden: 0, collapsed: false };
    if (opts.pxPerYear < below) return { ...g, collapsed: true, rows: 0, hidden: g.nodes.length };
    const rows = Math.max(1, Math.min(g.nodes.length, Math.max(1, opts.maxRows)));
    return { ...g, collapsed: false, rows, hidden: Math.max(0, g.nodes.length - rows) };
  });
}
