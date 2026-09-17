/** 灵框 · 助手上下文打包（ROADMAP §5「统一 AI 服务层」的原则：**应用层查好再塞**，
 *  比让模型自己一遍遍反问、或让它在 DOM 里刨要可靠得多）。
 *  这一层只负责「把事实整理成文本」，语气/规矩在 `src/ui/agent.ts` 的提示词里。
 */
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import type { Entity, PropValue, Timeline, TimelineNode, Worldset } from '../store/types';
import { calendarOf, fromEpoch } from '../calendar';

/** 「创作者现在在看哪一条」——由工作台（`src/ui/codex.ts`）上报，助手据此知道该关心什么 */
export interface AgentFocus {
  kind: 'entity' | 'node';
  world: string;
  id: string;
  title: string;
}

let focus: AgentFocus | null = null;

/** 两条焦点是不是同一条（同 kind/世界/id/名字）。工作上每一次 render 都会上报一次，
 *  内容没变就不该广播 —— 否则助手的上下文预览每 360ms 重画一遍。 */
function sameFocus(a: AgentFocus | null, b: AgentFocus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.world === b.world && a.id === b.id && a.title === b.title;
}

export function setAgentFocus(f: AgentFocus | null): void {
  if (sameFocus(focus, f)) return;
  focus = f;
  /* 广播给助手面板：它的「正在编」小标签与上下文预览要跟着换。
     光靠 store 订阅不够 —— **换条目是 UI 状态，不一定动数据**（点一下左树另一行就不会有 store 通知）。 */
  window.dispatchEvent(new CustomEvent('lingkuang-agent-focus'));
}

export function getAgentFocus(): AgentFocus | null { return focus; }

/** 单行压平 + 截断（模型不需要保留排版，反而浪费 token） */
function clip(s: string | null | undefined, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function propLine(k: string, v: PropValue): string {
  const val = Array.isArray(v) ? v.join('、') : String(v);
  return `${k}=${clip(val, 40)}`;
}

function fieldsOf(props: Record<string, PropValue> | undefined, max = 10): string {
  const ent = Object.entries(props ?? {});
  if (!ent.length) return '';
  return ent.slice(0, max).map(([k, v]) => propLine(k, v)).join('；');
}

/** 时间指针（epoch 秒）→ 历年（⚠️ 年份在 `.anchor.year`，写成 tp.year 会静默 undefined） */
function cursorLabel(tl: Timeline, cursor: number | null | undefined): string {
  if (typeof cursor !== 'number' || !Number.isFinite(cursor)) return '';
  try {
    return `第 ${fromEpoch(calendarOf(tl), cursor).anchor.year} 年`;
  } catch {
    return '';
  }
}

function timelineBlock(ws: Worldset, tlId: string): string {
  const tl = ws.timelines?.[tlId];
  if (!tl) return '';
  const nodes = [...(tl.nodes ?? [])].sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
  const head = `【当前时间线】${tl.name}（${nodes.length} 个事件）`;
  const shown = nodes.slice(0, 12).map((n: TimelineNode) => `${n.year ?? '?'} ${n.title}${n.kind ? '·' + n.kind : ''}`);
  const line = shown.length
    ? '  ' + shown.join('｜') + (nodes.length > shown.length ? `（另有 ${nodes.length - shown.length} 个未列出）` : '')
    : '  （这条时间线还没有事件）';
  const cur = cursorLabel(tl, ws.timeCursor);
  return [head, line, cur ? `  时间指针停在：${cur}` : ''].filter(Boolean).join('\n');
}

function entitiesBlock(ws: Worldset): string {
  const list = Object.values(ws.entities ?? {});
  if (!list.length) return '【设定】还没有任何条目';
  const byType = new Map<string, Entity[]>();
  for (const e of list) {
    const arr = byType.get(e.typeId) ?? [];
    arr.push(e);
    byType.set(e.typeId, arr);
  }
  const lines = [...byType.entries()].map(([typeId, arr]) => {
    const tname = ws.entityTypes?.[typeId]?.name ?? typeId;
    const names = arr.slice(0, 6).map((e) => e.name).join('、');
    return `  ${tname} ${arr.length} 条：${names}${arr.length > 6 ? '…' : ''}`;
  });
  return `【设定】共 ${list.length} 条\n${lines.join('\n')}`;
}

/** 「你正在编」——焦点条目的字段与正文（各自截断，正文给得多一点，那是创作者真正在写的东西） */
function focusBlock(ws: Worldset): string {
  const f = focus;
  if (!f || f.world !== ws.name) return '';
  if (f.kind === 'entity') {
    const e = ws.entities?.[f.id];
    if (!e) return '';
    const tname = ws.entityTypes?.[e.typeId]?.name ?? e.typeId;
    const fields = fieldsOf(e.properties);
    const doc = clip(e.doc, 600);
    return `【正在编·设定】${e.name}（${tname}）${fields ? '\n  字段：' + fields : ''}${doc ? '\n  正文：' + doc : ''}`;
  }
  let node: TimelineNode | undefined;
  for (const tl of Object.values(ws.timelines ?? {})) {
    node = (tl.nodes ?? []).find((n) => n.id === f.id);
    if (node) break;
  }
  if (!node) return '';
  const fields = fieldsOf(node.properties);
  const doc = clip(node.doc, 600);
  return `【正在编·事件】${node.year ?? '?'} 年 ${node.title}${node.kind ? '（' + node.kind + '）' : ''}`
    + `${node.desc ? '\n  简述：' + clip(node.desc, 200) : ''}`
    + `${fields ? '\n  字段：' + fields : ''}`
    + `${doc ? '\n  正文：' + doc : ''}`;
}

/** 打包当前工作区现状（世界 / 时间线 / 设定 / 正在编的那一条），超预算整体截断 */
export function buildContext(store: Store, budget = 4000): string {
  const ws = currentWorld(store);
  if (!ws) return '【工作区】还没有世界观';
  const names = Object.keys(store.data.worldsets ?? {});
  const parts: string[] = [
    `【工作区】当前世界「${ws.name}」（共 ${names.length} 个世界：${names.slice(0, 8).join('、')}）`,
    timelineBlock(ws, store.activeTimeline),
    entitiesBlock(ws),
    focusBlock(ws),
  ];
  return clip(parts.filter(Boolean).join('\n'), budget);
}
