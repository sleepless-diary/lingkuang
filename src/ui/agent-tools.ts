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
import { setAgentAsk, setAgentScope } from './agent-perm';
import type { AgentMode } from './agent-mode';
import type { AgentAsk, AgentScope } from './settings';

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
  /** ⭐ 这一条**永远**只出卡片、不许自动执行（创作者把询问关成「直接执行」也一样）。
   *  用在"自我提权"这类动作上：`set_mode` 切到 Agent、把权限范围放宽 —— 那一步必须他亲手点。 */
  needsConfirm?: boolean;
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
  /* ⭐ 灵框自己的设置（用户 2026-09-26：「给 AI 留一条改灵框设置的通道（包括聊天/Agent）」）。
     ⚠️ 只认白名单三个键 —— 不给模型碰"数据目录 / 界面布局 / 供应商密钥"这类东西的口子
     （apiKey 一概不认：那是密钥，只该由创作者自己在设置面板里填）。 */
  { name: 'set_setting', title: '改设置', desc: '改助手自己的设置：权限范围 / 是否每次询问 / 模式', args: '{ key: "agentScope"|"agentAsk"|"agentMode", value: 新值 }' },
  { name: 'set_mode', title: '切模式', desc: '把助手切到「聊天」或「Agent」模式（切到 Agent 永远要创作者点一下）', args: '{ mode: "chat"|"agent" }' },
];

export function findTool(name: string): ToolSpec | undefined {
  return READ_TOOLS.concat(WRITE_TOOLS).find((t) => t.name === name);
}

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.some((t) => t.name === name);
}

/** 给系统提示用：把能用的动作列出来 + 说清怎么调。
 *  ⭐ 2026-09-26 用户改口后**两个模式都注入**这份协议（「聊天模式也留一点灵框内部的工具」），
 *  差别只在最后那句"一次能做几步"：聊天一次一个、Agent 可以连着走多步（见 `agent-mode.ts`）。
 *  ⚠️ 灵框**外**的能力（文件 / 命令 / 联网）现在一条都没有 —— 将来加进来时在这里另起一段。 */
export function toolsPrompt(mode: AgentMode = 'agent'): string {
  const rows = READ_TOOLS.map((t) => `- ${t.name} ${t.args} —— ${t.desc}`)
    .concat(WRITE_TOOLS.map((t) => `- ${t.name}（要创作者点头）${t.args} —— ${t.desc}`));
  return [
    '【你能用的动作】',
    '只读的可以随时用，我会立刻把结果给你；写入的不会直接生效，会先变成一张要创作者点「应用」的提议卡片。',
    ...rows,
    '要动用某个动作时，**整条回复只写一行 JSON**，别夹散文、别加解释。两个键的名字必须是 tool 和 args：',
    '{"tool":"read_entity","args":{"name":"安德希亚城"}}',
    '{"tool":"set_field","args":{"entity":"霜精灵","field":"描述","value":"霜精灵是生活在北境冻原的种族。"}}',
    '⚠️ 不要写成 {"动作名":{…}}（例如 {"set_field":{…}}），也不要写成 {"name":…,"arguments":…} —— 那样我认不出来。',
    '要放开权限（切到 Agent 模式、把权限改宽）时，那张卡片**永远**要创作者点「应用」才会生效 —— 别催他。',
    mode === 'agent'
      ? '不需要用动作时就用平常的话回答。**一次提问里可以连着提多个动作**（我最多放你走 8 步），批量活一次规划好。'
      : '不需要用动作时就用平常的话回答。**一次提问只提一个动作**（这是「聊天」模式的规矩），做完把结果说给他、等他决定下一步。',
  ].join('\n');
}

/* ---------------- 解析模型回复 ---------------- */

/* ⭐ 各家的模型写法五花八门（用户 2026-09-15 实测：模型把动作写成了
 *   `{"set_field":{"entity":"霜精灵","field":"描述","value":"…"}}` —— 工具名当键，
 *   那时解析器只认正统 `{"tool":…,"args":…}` ⇒ 整坨 JSON 被当聊天画到脸上、什么也没发生）。
 *   所以这里把「名字」的写法全认下来，参数位置也容错；实在认不出才返回 null。 */
const ARG_KEYS = ['args', 'arguments', 'parameters', 'params', 'input'];
/** 参数写成裸值（`{"search":"雪"}`）时，这个动作的主参数叫什么 */
const PRIMARY: Record<string, string> = {
  list_entities: 'type',
  read_entity: 'name',
  list_nodes: '',
  search: 'q',
  create_entity: 'name',
  set_field: 'value',
  append_doc: 'text',
  create_node: 'title',
  rename_entity: 'name',
  set_setting: 'value',
  set_mode: 'mode',
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const knownTool = (v: unknown): string | null => {
  const n = str(v);
  return n && findTool(n) ? n : null;
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** 把各种形状掰成参数对象；掰不动就退到该动作的主参数名 */
function toArgs(tool: string, v: unknown): ToolArgs {
  let raw = v;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw); /* 值本身是 JSON 字符串 */
    } catch {
      raw = v;
    }
  }
  if (isObj(raw)) return raw as ToolArgs;
  const key = PRIMARY[tool];
  return key ? ({ [key]: raw } as ToolArgs) : {};
}

/** 认出来的动作名 + 参数；认不出返回 null */
export function normalizeCall(obj: unknown): ToolCall | null {
  if (!isObj(obj)) return null;
  const o = obj as Record<string, unknown>;
  /* ① 正统 {tool|name|action|act, args|arguments|…}；名字认得出就顺便收参数 */
  const direct = knownTool(o.tool) ?? knownTool(o.name) ?? knownTool(o.action) ?? knownTool(o.act);
  if (direct) {
    for (const k of ARG_KEYS) if (k in o) return { tool: direct, args: toArgs(direct, o[k]) };
    const rest: ToolArgs = {}; /* 参数摊平在顶层 */
    for (const [k, v] of Object.entries(o)) if (!['tool', 'name', 'action', 'act'].includes(k)) rest[k] = v;
    return { tool: direct, args: rest };
  }
  /* ② 工具名当键 —— {"set_field":{…}}（本地小模型很爱这么写） */
  const keys = Object.keys(o);
  if (keys.length === 1) {
    const t = knownTool(keys[0]);
    if (t) return { tool: t, args: toArgs(t, o[keys[0]]) };
  }
  /* ③ 工具名当键 + 同级还夹了别的键（{"set_field":{…},"说明":"…"}）：取第一个认识的那个 */
  for (const k of keys) {
    const t = knownTool(k);
    if (t) return { tool: t, args: toArgs(t, o[k]) };
  }
  return null;
}

/** 从模型回复里抠出工具调用；不是调用就返回 null（当普通聊天处理） */
export function parseToolCall(raw: string): ToolCall | null {
  const text = String(raw ?? '').replace(/```[a-zA-Z]*/g, '').trim();
  /* 整段就是一个 JSON 才认 —— 免得回答里提到例子被误当成调用 */
  if (!text.startsWith('{')) return null;
  const end = text.lastIndexOf('}');
  if (end < 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    try {
      obj = JSON.parse(text.slice(0, end + 1)); /* 后面还挂着一句话，切到最后一个 } 再试 */
    } catch {
      return null;
    }
  }
  return normalizeCall(obj);
}

/** 整条回复就是一个 JSON 对象、但没能映射到任何一个动作 —— 多半是格式写歪了 */
export function looksLikeToolJson(raw: string): boolean {
  const text = String(raw ?? '').replace(/```[a-zA-Z]*/g, '').trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return false;
  try {
    return isObj(JSON.parse(text));
  } catch {
    return false;
  }
}

/* ---------------- 小工具 ---------------- */

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
    /* ⭐ 灵框自己的设置（用户 2026-09-26：「给 AI 留一条改灵框设置的通道（包括聊天/Agent）」）。
       ⚠️ 白名单三个键；**放宽**（切 Agent / 范围改可写 / 关掉询问）一律 `needsConfirm: true`：
       即便创作者把询问关成「直接执行」，自我提权这一步也必须他亲手点一下。收窄随时生效。 */
    case 'set_setting':
    case 'set_mode': {
      const key = call.tool === 'set_mode' ? 'agentMode' : str(a.key);
      const value = call.tool === 'set_mode' ? str(a.mode) : str(a.value);
      const ALLOWED: Record<string, string[]> = {
        agentScope: ['readonly', 'workspace'],
        agentAsk: ['always', 'never'],
        agentMode: ['chat', 'agent'],
      };
      const KEY_CN: Record<string, string> = { agentScope: '权限范围', agentAsk: '写入要不要先问', agentMode: '助手模式' };
      if (!ALLOWED[key]) {
        return { ok: false, note: '能改的设置只有 agentScope（readonly|workspace）、agentAsk（always|never）、agentMode（chat|agent）。' };
      }
      if (ALLOWED[key].indexOf(value) < 0) {
        return { ok: false, note: `「${key}」只能是 ${ALLOWED[key].join(' 或 ')}，我收到的是「${value}」。` };
      }
      const widen = value === 'agent' || value === 'workspace' || value === 'never';
      const what = key === 'agentMode'
        ? (value === 'agent' ? '它能连着走多步、批量改' : '回到平常：一次只做一个动作')
        : key === 'agentScope'
          ? (value === 'workspace' ? '允许它改你的数据（写入仍走提议卡片）' : '只读：写入一律不执行')
          : (value === 'never' ? '写入不再问你，直接落盘' : '每次写入都先出卡片等你点「应用」');
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `改设置：${KEY_CN[key]} → ${value}`,
          detail: what + (widen ? '（这一步放开了更大的权限，必须你点「应用」）' : ''),
          needsConfirm: widen,
          apply: () => {
            if (key === 'agentScope') {
              setAgentScope(value as AgentScope);
              return { ok: true, note: `权限范围已改成「${value}」` };
            }
            if (key === 'agentAsk') {
              setAgentAsk(value as AgentAsk);
              return { ok: true, note: `写入询问方式已改成「${value}」` };
            }
            /* 模式住在 `src/ui/agent.ts` 的模块变量里 —— 动作层直接改它会成 import 环，
               所以广播一条事件，由那边收（与 `lingkuang-agent-perm` / `lingkuang-sessions` 同一套做法）。 */
            window.dispatchEvent(new CustomEvent('lingkuang-agent-mode', { detail: { mode: value } }));
            return { ok: true, note: value === 'agent' ? '已切到 Agent 模式（能连着走多步）' : '已切回聊天模式（一次只做一个动作）' };
          },
        },
      };
    }
    default:
      return { ok: false, note: `不认识的动作：${call.tool}` };
  }
}
