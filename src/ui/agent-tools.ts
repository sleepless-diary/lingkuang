/* 灵框助手的「动作」（片 3）。
 *
 * ⭐ 为什么不用 function calling：本地跑的是 7B 级模型，工具调用基本不可用
 *    （不是格式崩就是参数编造）。所以协议退回到**文本 JSON 指令** ——
 *    模型只要把整条消息写成一行 `{"tool":"名字","args":{…}}` 就行，
 *    解析失败就当普通聊天，不会把对话卡死。
 *
 * ⭐ 只读与写入走两条完全不同的路：
 *    - 只读（list_entities / read_entity / …）：立刻执行，结果作为下一轮喂回模型；
 *    - 写入（set_field / create_node / …）：**不直接落盘** ——
 *      先做成一张 `Proposal`（提议卡片），由 `src/ui/agent.ts` 按
 *      `src/ui/agent-perm.ts` 的 `gateWrite()` 决定：拒绝 / 等创作者点「应用」/ 自动执行。
 *      这样「YOLO」只是把「等点一下」去掉，写入路径始终只有一条。
 *
 * 数据改动一律走 `src/store/actions.ts`（`addEntity`/`addNode` 会按类型模板补全字段、
 * id 走单调时钟），不自己手写 id、不直接改 `data`。
 */

import { addEntity, addNode } from '../store/actions';
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import type { Entity, PropValue, TimelineNode, Worldset } from '../store/types';

export type ToolArgs = Record<string, unknown>;

/** 模型要求调用某个动作 —— 从它的回复里解析出来的东西 */
export interface ToolCall {
  tool: string;
  args: ToolArgs;
}

/** 一条待批准的写入：卡片上显示什么、点了「应用」做什么 */
export interface Proposal {
  tool: string;
  /** 卡片标题，如「改字段：银发少女 · 发色」 */
  title: string;
  /** 卡片正文，人话描述这次要改什么 */
  detail: string;
  /** 应用时真正落盘的函数 */
  apply: () => { ok: boolean; note: string };
}

interface ToolSpec {
  name: string;
  title: string;
  desc: string;
  /** 参数说明（进提示词，让模型知道该给什么键） */
  args: string;
}

/* ---------------- 只读动作 ---------------- */

const READ_TOOLS: ToolSpec[] = [
  { name: 'list_entities', title: '列出设定', desc: '按类型列出这个世界里已有的设定条目名字', args: '{ type?: 类型名 }' },
  { name: 'read_entity', title: '看一条设定', desc: '读出某条设定的类型、全部字段与正文', args: '{ name: 名字 }' },
  { name: 'list_nodes', title: '列出事件', desc: '列出当前时间线上的事件（年份 + 标题 + 种类）', args: '{}' },
  { name: 'search', title: '搜一搜', desc: '在世界里按关键词搜设定与事件，给名字和年份', args: '{ q: 关键词 }' },
];

/* ---------------- 写入动作 ---------------- */

const WRITE_TOOLS: ToolSpec[] = [
  { name: 'create_entity', title: '新建设定', desc: '新建一条设定条目（会给它补上该类型的空字段）', args: '{ name: 名字, type?: 类型名, fields?: { 字段: 值 } }' },
  { name: 'set_field', title: '改字段', desc: '改某条设定的一个字段值', args: '{ entity: 名字, field: 字段名, value: 值 }' },
  { name: 'append_doc', title: '续写正文', desc: '在某条设定或某个事件的正文末尾追加一段', args: '{ target: "entity"|"node", name: 名字, text: 正文 }' },
  { name: 'create_node', title: '新建事件', desc: '在当前时间线上建一个事件节点', args: '{ title: 标题, year: 年份, kind?: 种类, desc?: 一句简述 }' },
  { name: 'rename_entity', title: '改名', desc: '给一条设定改名', args: '{ entity: 旧名字, name: 新名字 }' },
];

export function findTool(name: string): ToolSpec | undefined {
  return READ_TOOLS.concat(WRITE_TOOLS).find((t) => t.name === name);
}

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.some((t) => t.name === name);
}

/** 给系统提示用：把能用的动作列出来 + 说清怎么调 */
export function toolsPrompt(): string {
  const rows = READ_TOOLS.map((t) => `- ${t.name} ${t.args} —— ${t.desc}`)
    .concat(WRITE_TOOLS.map((t) => `- ${t.name}（要创作者点头）${t.args} —— ${t.desc}`));
  return [
    '【你能用的动作】',
    '只读的可以随时用，我会立刻把结果给你；写入的不会直接生效，会先变成一张要创作者点「应用」的提议卡片。',
    ...rows,
    '要动用某个动作时，**整条回复只写一行 JSON**，别夹散文、别加解释：',
    '{"tool":"动作名","args":{…}}',
    '不需要用动作时就用平常的话回答。一次只提一个动作。',
  ].join('\n');
}

/* ---------------- 解析模型回复 ---------------- */

/** 从模型回复里抠出工具调用；不是调用就返回 null（当普通聊天处理） */
export function parseToolCall(raw: string): ToolCall | null {
  const text = String(raw ?? '').replace(/```[a-zA-Z]*/g, '').trim();
  if (!text) return null;
  /* 整段就是一个 JSON 才认 —— 免得回答里提到例子被误当成调用 */
  let body = text;
  if (!body.startsWith('{')) {
    const at = body.indexOf('{"tool"');
    if (at < 0) return null;
    const end = body.lastIndexOf('}');
    if (end <= at) return null;
    body = body.slice(at, end + 1);
    if (text.slice(0, at).trim().length > 0) return null; /* 前面有正文 ⇒ 是解释，不是调用 */
  }
  let obj: unknown;
  try {
    obj = JSON.parse(body);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as { tool?: unknown; args?: unknown };
  if (typeof o.tool !== 'string' || !o.tool.trim()) return null;
  if (!findTool(o.tool.trim())) return null;
  const args = o.args && typeof o.args === 'object' && !Array.isArray(o.args) ? (o.args as ToolArgs) : {};
  return { tool: o.tool.trim(), args };
}

/* ---------------- 小工具 ---------------- */

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(str(v));
  return Number.isFinite(n) ? n : null;
};
const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
};

function findEntity(ws: Worldset | undefined, name: string): Entity | undefined {
  const list = Object.values(ws?.entities ?? {});
  const want = name.trim();
  return (
    list.find((e) => e.name === want) ||
    list.find((e) => e.name.toLowerCase() === want.toLowerCase()) ||
    list.find((e) => e.name.includes(want) || want.includes(e.name))
  );
}

function typeName(ws: Worldset | undefined, e: Entity): string {
  return ws?.entityTypes?.[e.typeId]?.name ?? e.typeId;
}

function fieldsLine(e: Entity, max = 12): string {
  const rows = Object.entries(e.properties ?? {}).slice(0, max);
  if (!rows.length) return '（还没有字段）';
  return rows.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : String(v)}`).join('；');
}

/* ---------------- 只读：立刻执行 ---------------- */

/** 返回给模型看的文本结果（人话，别太长） */
export function runReadTool(call: ToolCall, store: Store): string {
  const ws = currentWorld(store);
  const a = call.args;
  switch (call.tool) {
    case 'list_entities': {
      const want = str(a.type);
      const byType = new Map<string, string[]>();
      for (const e of Object.values(ws?.entities ?? {})) {
        const t = typeName(ws, e);
        if (want && t !== want) continue;
        const arr = byType.get(t) ?? [];
        arr.push(e.name);
        byType.set(t, arr);
      }
      if (!byType.size) return want ? `没有「${want}」类型的设定。` : '这个世界还没有设定条目。';
      return [...byType.entries()].map(([t, names]) => `${t}（${names.length}）：${names.join('、')}`).join('\n');
    }
    case 'read_entity': {
      const e = findEntity(ws, str(a.name));
      if (!e) return `没找到叫「${str(a.name)}」的设定。`;
      const doc = (e.doc ?? '').replace(/\s+/g, ' ').trim();
      return [`${e.name}（${typeName(ws, e)}）`, `字段：${fieldsLine(e)}`, doc ? `正文：${clip(doc, 600)}` : '正文：（空）'].join('\n');
    }
    case 'list_nodes': {
      const tl = ws?.timelines?.[store.activeTimeline];
      if (!tl) return '当前没有打开的时间线。';
      if (!tl.nodes.length) return `时间线「${tl.name}」上还没有事件。`;
      const rows = [...tl.nodes].sort((x, y) => x.year - y.year).slice(0, 20);
      return `时间线「${tl.name}」（${tl.nodes.length} 个事件）\n` + rows.map((n) => `${n.year} ${n.title}${n.kind ? '·' + n.kind : ''}`).join('\n');
    }
    case 'search': {
      const q = str(a.q).toLowerCase();
      if (!q) return '要搜什么？给我个关键词。';
      const hits: string[] = [];
      for (const e of Object.values(ws?.entities ?? {})) {
        if (e.name.toLowerCase().includes(q) || JSON.stringify(e.properties ?? {}).toLowerCase().includes(q)) {
          hits.push(`设定：${e.name}（${typeName(ws, e)}）`);
        }
      }
      for (const tl of Object.values(ws?.timelines ?? {})) {
        for (const n of tl.nodes) {
          if (n.title.toLowerCase().includes(q) || (n.desc ?? '').toLowerCase().includes(q)) hits.push(`事件：${n.year} ${n.title}（${tl.name}）`);
        }
      }
      return hits.length ? hits.slice(0, 20).join('\n') : `没搜到和「${str(a.q)}」有关的东西。`;
    }
    default:
      return `不认识的动作：${call.tool}`;
  }
}

/* ---------------- 写入：先做成提议 ---------------- */

/** 失败时返回一段人话错误（给模型看，让它改参数重试） */
export function planWrite(call: ToolCall, store: Store): { ok: true; proposal: Proposal } | { ok: false; note: string } {
  const ws = currentWorld(store);
  const a = call.args;
  switch (call.tool) {
    case 'create_entity': {
      const name = str(a.name);
      if (!name) return { ok: false, note: '新建设定要给我名字（args.name）。' };
      const types = Object.values(ws?.entityTypes ?? {});
      const want = str(a.type);
      const type = types.find((t) => t.name === want || t.id === want) ?? types[0];
      if (!type) return { ok: false, note: '这个世界还没有类型模板，先在结构体管理里建一个。' };
      const fields = (a.fields && typeof a.fields === 'object' ? a.fields : {}) as unknown as Record<string, PropValue>;
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `新建设定：${name}（${type.name}）`,
          detail: Object.keys(fields).length ? `字段：${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('；')}` : '先建出来，字段留空',
          apply: () => {
            addEntity(store, { name, typeId: type.id, properties: fields });
            return { ok: true, note: `已新建设定「${name}」` };
          },
        },
      };
    }
    case 'set_field': {
      const e = findEntity(ws, str(a.entity));
      if (!e) return { ok: false, note: `没找到叫「${str(a.entity)}」的设定。` };
      const field = str(a.field);
      if (!field) return { ok: false, note: '要改哪个字段？（args.field）' };
      const raw = a.value;
      const old = e.properties?.[field];
      const id = e.id;
      const value: PropValue = Array.isArray(raw)
        ? (raw as (string | number)[])
        : typeof raw === 'boolean' || typeof raw === 'number'
          ? raw
          : str(raw);
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `改字段：${e.name} · ${field}`,
          detail: `${old === undefined ? '（原本没有这个字段）' : String(old)} → ${Array.isArray(value) ? value.join('/') : String(value)}`,
          apply: () => {
            store.update((d) => {
              const ent = d.worldsets[store.activeWorld]?.entities?.[id];
              if (!ent) return;
              if (!ent.properties) ent.properties = {};
              ent.properties[field] = value;
            });
            return { ok: true, note: `已把「${e.name}」的 ${field} 改成 ${Array.isArray(value) ? value.join('/') : String(value)}` };
          },
        },
      };
    }
    case 'append_doc': {
      const kind = str(a.target) === 'node' ? 'node' : 'entity';
      const text = str(a.text);
      if (!text) return { ok: false, note: '要续写什么？（args.text）' };
      const name = str(a.name);
      if (kind === 'entity') {
        const e = findEntity(ws, name);
        if (!e) return { ok: false, note: `没找到叫「${name}」的设定。` };
        const id = e.id;
        const next = [e.doc ?? '', text].filter(Boolean).join('\n\n');
        return {
          ok: true,
          proposal: {
            tool: call.tool,
            title: `续写正文：${e.name}`,
            detail: clip(text, 200),
            apply: () => {
              store.update((d) => {
                const ent = d.worldsets[store.activeWorld]?.entities?.[id];
                if (ent) ent.doc = next;
              });
              return { ok: true, note: `已把这段接到「${e.name}」正文末尾` };
            },
          },
        };
      }
      const tl = ws?.timelines?.[store.activeTimeline];
      const node = tl?.nodes.find((n) => n.title === name) ?? tl?.nodes.find((n) => n.title.includes(name) && name.length > 0);
      if (!tl || !node) return { ok: false, note: `当前时间线上没找到事件「${name}」。` };
      const tlId = tl.id;
      const nodeId = node.id;
      const next = [node.doc ?? '', text].filter(Boolean).join('\n\n');
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `续写正文：${node.year} ${node.title}`,
          detail: clip(text, 200),
          apply: () => {
            store.update((d) => {
              const n = d.worldsets[store.activeWorld]?.timelines?.[tlId]?.nodes.find((x) => x.id === nodeId);
              if (n) n.doc = next;
            });
            return { ok: true, note: `已把这段接到事件「${node.title}」正文末尾` };
          },
        },
      };
    }
    case 'create_node': {
      const title = str(a.title);
      if (!title) return { ok: false, note: '新建事件要给我标题（args.title）。' };
      const tl = ws?.timelines?.[store.activeTimeline];
      if (!tl) return { ok: false, note: '当前没有打开的时间线，先在沙盘里选一条。' };
      const year = num(a.year) ?? 0;
      const kind = str(a.kind);
      const desc = str(a.desc);
      const tlId = tl.id;
      const partial: Partial<TimelineNode> = { title, year, type: 'story_event' };
      if (kind) partial.kind = kind;
      if (desc) partial.desc = desc;
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `新建事件：${title}`,
          detail: `${year} 年${kind ? ' · ' + kind : ''}（落在时间线「${tl.name}」上）${desc ? '\n' + clip(desc, 160) : ''}`,
          apply: () => {
            addNode(store, tlId, partial);
            return { ok: true, note: `已在「${tl.name}」上新建事件「${title}」（${year} 年）` };
          },
        },
      };
    }
    case 'rename_entity': {
      const e = findEntity(ws, str(a.entity));
      if (!e) return { ok: false, note: `没找到叫「${str(a.entity)}」的设定。` };
      const next = str(a.name);
      if (!next) return { ok: false, note: '要改成什么名字？（args.name）' };
      const id = e.id;
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `改名：${e.name} → ${next}`,
          detail: 'vault 里的 .md 文件会跟着改名',
          apply: () => {
            store.update((d) => {
              const ent = d.worldsets[store.activeWorld]?.entities?.[id];
              if (ent) ent.name = next;
            });
            return { ok: true, note: `已把「${e.name}」改名为「${next}」` };
          },
        },
      };
    }
    default:
      return { ok: false, note: `不认识的动作：${call.tool}` };
  }
}
