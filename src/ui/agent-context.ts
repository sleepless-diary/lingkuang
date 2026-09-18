/** 灵框 · 助手上下文打包（ROADMAP §5「统一 AI 服务层」的原则：**应用层查好再塞**，
 *  比让模型自己一遍遍反问、或让它在 DOM 里刨要可靠得多）。
 *  这一层只负责「把事实整理成文本」，语气/规矩在 `src/ui/agent.ts` 的提示词里。
 */
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import type { Entity, PropValue, Timeline, TimelineNode, Worldset } from '../store/types';
import { calendarOf, fromEpoch } from '../calendar';
import { activityBlock } from './agent-activity';

/** 「创作者现在在看哪一条」——由工作台（`src/ui/codex.ts`）上报，助手据此知道该关心什么 */
export interface AgentFocus {
  kind: 'entity' | 'node';
  world: string;
  id: string;
  title: string;
  /** 他是在哪儿看着这条：设定库工作台（`'codex'`，缺省）还是世界沙盘的时间线（`'timeline'`）。
   *  用户 2026-09-18：「时间轴面板也要让它能看到我在哪个文件」——沙盘那边点节点同样上报，只是换个说法。 */
  view?: 'codex' | 'timeline';
}

/** vault 里的实体根目录名（与 `main.js` 的 `ENTITY_DIR`/`entityPath` 一致）：
 *  `<世界>/_设定/<类型>/<名字>.md`；节点是 `<世界>/<时间线>/<种类>/<标题>.md`（见 `main.js` 的 `nodePath`）。 */
const ENTITY_DIR = '_设定';

let focus: AgentFocus | null = null;

/* 「这一条现在还开在屏幕上吗」。2026-09-18 用户实测报的 bug：「这个 ai 看不到我此时打开的文件」——
   他一问「主要是哪个文件」，助手只答出世界名（它在工作台里明明答得又准又点名）。
   根因之一：切走工具（比如去看一眼沙盘）时这里被 `setAgentFocus(null)` 清空，
   于是助手只剩「工作区 / 时间线 / 设定」可依 —— 那点信息只够它说「测试世界观的文件」。
   现在**不清空、只降级**：焦点留着并标注「他刚才在看这一条，现在切到别的功能去了」。 */
let live = true;

/** 两条焦点是不是同一条（同 kind/世界/id/名字）。工作上每一次 render 都会上报一次，
 *  内容没变就不该广播 —— 否则助手的上下文预览每 360ms 重画一遍。 */
function sameFocus(a: AgentFocus | null, b: AgentFocus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.world === b.world && a.id === b.id && a.title === b.title && a.view === b.view;
}

function announce(): void {
  /* 广播给助手面板：它的「正在编」小标签与上下文预览要跟着换。
     光靠 store 订阅不够 —— **换条目是 UI 状态，不一定动数据**（点一下左树另一行就不会有 store 通知）。 */
  window.dispatchEvent(new CustomEvent('lingkuang-agent-focus'));
}

export function setAgentFocus(f: AgentFocus | null): void {
  /* 工作台真的报了焦点 ⇒ 它就在屏幕上，重新算「现役」 */
  const nextLive = f ? true : live;
  if (sameFocus(focus, f) && nextLive === live) return;
  focus = f;
  live = nextLive;
  announce();
}

/** 工作台从屏幕上撤走（`src/ui/codex.ts` 的 dispose）——**不清空焦点**，只降级为「最近在看」。 */
export function setAgentFocusLive(v: boolean): void {
  if (live === v) return;
  live = v;
  announce();
}

export function isAgentFocusLive(): boolean { return live; }

export function getAgentFocus(): AgentFocus | null { return focus; }

/* 「他此刻在哪个界面」。用户 2026-09-18 实测：他明明切去了别的功能，问「哪个文件」时助手
   还是一口咬定「你正在看艾德温·霜冠」，连问两次都不改口 —— 因为上下文里**根本没有界面这一维**，
   焦点降级那句「他刚才在看这一条」反被它读成「他现在还在看」。
   界面名由 `src/tools/registry.ts` 的 `openTool()`（工具名）与 `src/ui/shell.ts` 的沙盘分支上报。 */
let view = '';

export function setAgentView(name: string): void {
  if (view === name) return;
  view = name;
  announce();
}

export function getAgentView(): string { return view; }

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

/** 「创作者此刻打开的那一条」——焦点条目的字段与正文（各自截断，正文给得多一点，那是创作者真正在写的东西）。
 *  ⚠️ 这一块在 `buildContext()` 里排在**第二位**（紧跟【工作区】）：用户 2026-09-18 实测「AI 看不到我打开的文件」，
 *  除了切工具被清空，另一个原因是它原来排在最后一行 —— 小模型读到后面就不看了。**它就是这条消息的主角，得放前面。** */
function focusBlock(ws: Worldset): string {
  const f = focus;
  if (!f || f.world !== ws.name) return '';
  /* 降级时标题也得换掉：还写「此刻打开的那一条」，模型会当成「他现在就在看」（用户实测连问两次都不改口） */
  const head = live ? '【创作者此刻打开的那一条】' : '【创作者最近打开过的那一条】';
  const age = live
    ? ''
    : '\n  （这一条**不是**他此刻在看的：他刚才看过，随后切去了别的功能 —— 他说「这个」多半仍指它，'
      + '但要先看上面那行【创作者此刻在哪】，拿不准就问他一句）';
  /* 同一个节点，在沙盘时间线上点开和在设定库里点开，助手该说的话不一样（用户 2026-09-18 要求时间轴也上报） */
  const place = f.view === 'timeline'
    ? '\n  在哪：世界沙盘的时间线上（他刚点开这条看）'
    : '\n  在哪：设定库工作台';
  if (f.kind === 'entity') {
    const e = ws.entities?.[f.id];
    if (!e) return '';
    const tname = ws.entityTypes?.[e.typeId]?.name ?? e.typeId;
    const fields = fieldsOf(e.properties);
    const doc = clip(e.doc, 600);
    return `${head}设定「${e.name}」（${tname}）`
      + `\n  文件：${ws.name}/${ENTITY_DIR}/${tname}/${e.name}.md`
      + `${place}`
      + `${fields ? '\n  字段：' + fields : ''}${doc ? '\n  正文：' + doc : ''}${age}`;
  }
  let node: TimelineNode | undefined;
  let tlName = '';
  for (const tl of Object.values(ws.timelines ?? {})) {
    node = (tl.nodes ?? []).find((n) => n.id === f.id);
    if (node) { tlName = tl.name; break; }
  }
  if (!node) return '';
  const fields = fieldsOf(node.properties);
  const doc = clip(node.doc, 600);
  const kind = node.kind ? node.kind : '事件';
  return `${head}事件「${node.year ?? '?'} 年 ${node.title}」`
    + `${node.kind && node.kind !== '事件' ? '（' + node.kind + '）' : ''}`
    + `\n  文件：${ws.name}/${tlName}/${kind}/${node.title}.md`
    + `${place}`
    + `${node.desc ? '\n  简述：' + clip(node.desc, 200) : ''}`
    + `${fields ? '\n  字段：' + fields : ''}`
    + `${doc ? '\n  正文：' + doc : ''}${age}`;
}

/** 助手不知道该看哪一条时，**别让它拿世界名糊弄** —— 直接把「问清是哪一条」写进上下文 */
const NO_FOCUS = '【创作者此刻打开的那一条】（没有：他没打开任何条目。'
  + '他说「这个 / 这条 / 当前 / 我打开的文件」时，直接问他指的是哪一条，不要拿世界名或时间线名糊弄，'
  + '也不要把【他最近做过的事】里的东西当成他此刻在看的东西）';

/** 「他此刻在哪个界面」——单独一条、排在【工作区】之后：光有焦点不够，
 *  模型得先知道他现在人在哪个工具里，才不会把「最近打开过的」说成「你正在看」。 */
function viewBlock(): string {
  if (!view) return '';
  return `【创作者此刻在哪】界面：${view}`;
}

/** 打包当前工作区现状（世界 / **此刻打开的那一条** / 时间线 / 设定 / **他最近做过的事**），超预算整体截断 */
export function buildContext(store: Store, budget = 4000): string {
  const ws = currentWorld(store);
  if (!ws) return '【工作区】还没有世界观';
  const names = Object.keys(store.data.worldsets ?? {});
  const parts: string[] = [
    `【工作区】当前世界「${ws.name}」（共 ${names.length} 个世界：${names.slice(0, 8).join('、')}）`,
    viewBlock(),
    focusBlock(ws) || NO_FOCUS,
    /* 他最近改过什么（用户 2026-09-18：「能不能让这个 ai 能读到我的过去操作行为」）。
       排在焦点之后：先知道他在看哪一条，再看他刚才动过什么，顺序反了他会以为流水是当下这一条。 */
    activityBlock(),
    timelineBlock(ws, store.activeTimeline),
    entitiesBlock(ws),
  ];
  return clip(parts.filter(Boolean).join('\n'), budget);
}
