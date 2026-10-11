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

import { addEntity, addNode, addTimeline, addWorld, removeEntity, removeNode, removeTimeline, removeWorld } from '../store/actions';
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import type { Entity, PropValue, Timeline, TimelineNode, Worldset } from '../store/types';
import { fsAddRoot, fsAvailable, fsBatchAvailable, fsDefaultPath, fsDelete, fsImportStatus, fsList, fsPrompt, fsRead, fsReadMany, fsRootOf, fsRootsCached, fsSearch, fsSetRootWrite, fsWrite } from './agent-fs';
import { webAvailable, webFetch, webPrompt, webSearch } from './agent-web';
import { setAgentAsk, setAgentScope } from './agent-perm';
import { stepsPrompt, type AgentMode } from './agent-mode';
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
  /** 应用时真正落盘的函数。⭐ 允许是 async：灵框外的文件写要走主进程 IPC（`src/ui/agent-fs.ts`），
   *  两个调度方（`src/ui/agent.ts` 的 `handleWrite()` / `agentCardClick()`）一律 `await` 它。 */
  apply: () => { ok: boolean; note: string } | Promise<{ ok: boolean; note: string }>;
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
  /** 灵框**外**的文件动作：只在文件通道可用时列进提示词（旧版主进程没有 `fs:*` 通道） */
  needsFs?: boolean;
  /** 批量导入那两个（`read_many` / `import_status`）：还要主进程**有** `fs:read-many`（旧版只有单文件那几个） */
  needsFsBatch?: boolean;
  /** 联网动作：只在主进程有 `web:*` 通道时列出（片 2） */
  needsWeb?: boolean;
}

/* ---------------- 只读动作 ---------------- */

const READ_TOOLS: ToolSpec[] = [
  { name: 'list_entities', title: '列出设定', desc: '按类型列出这个世界里已有的设定条目名字', args: '{ type?: 类型名 }' },
  { name: 'read_entity', title: '看一条设定', desc: '读出某条设定的类型、全部字段与正文', args: '{ name: 名字 }' },
  { name: 'list_nodes', title: '列出事件', desc: '列出当前时间线上的事件（年份 + 标题 + 种类）', args: '{}' },
  { name: 'search', title: '搜一搜', desc: '在世界里按关键词搜设定与事件，给名字和年份', args: '{ q: 关键词 }' },
  /* ⭐ 片 1（2026-09-28）：灵框**外**的文件 —— 只读三件，白名单由主进程把关（`src/ui/agent-fs.ts`） */
  { name: 'list_files', title: '列文件夹', desc: '列出某个文件夹里有什么（目录 / 名字 / 大小 / 改动时间）', args: '{ path: 文件夹绝对路径 }', needsFs: true },
  { name: 'read_file', title: '读文件', desc: '读一个文本文件的内容（2 MB 以内）', args: '{ path: 文件绝对路径 }', needsFs: true },
  { name: 'search_files', title: '搜文件', desc: '在一个文件夹里按关键词找内容，给「文件:行号:那一行」', args: '{ q: 关键词, path?: 文件夹绝对路径 }', needsFs: true },
  /* ⭐ 片 4（2026-10-15）：批量读 + 导入进度 —— 用户问「**为什么他干活了这么久但是我一个节点都没看到**」：
     真机 120 条里只有 list_files×60 / read_file×29，**一个写入都没有**；它自己的计划是"先全摸清再建"，
     而能发给模型的只有最近十几条 ⇒ 读完忘、忘了重读，永远到不了"建"。
     `read_many` 把"搬库"从几十轮压到几轮（一次一批、默认读还没读过的），`import_status` 让它随时看得见进度。 */
  { name: 'read_many', title: '批量读文件', desc: '一次读一批文本文件（不给参数 = 读**还没读过的**下一批，一次最多 12 个 / 约 12000 字）—— 搬一整个资料库用这个，别一个文件一个动作地磨', args: '{ paths?: [文件绝对路径…], dir?: 文件夹绝对路径, limit?: 一批几个, chars?: 总字数, again?: true 表示重读读过的 }', needsFs: true, needsFsBatch: true },
  { name: 'import_status', title: '导入进度', desc: '看这个资料库一共多少文本文件、已读多少、还剩多少、下一批是哪些（别靠记忆猜，问它）', args: '{ dir?: 文件夹绝对路径 }', needsFs: true, needsFsBatch: true },
  /* ⭐ 片 2（2026-09-29）：联网 —— 只读两件（搜 + 抓网页），主进程 `web:*` 通道把关（见 `src/ui/agent-web.ts`）。
     用户原话：「把能做的东西都写了吧…联网搜索还有拖入文件到会话什么的」。 */
  { name: 'web_search', title: '联网搜', desc: '在互联网上搜关键词，给标题 / 网址 / 摘要（要用它核实资料、找参考资料时先搜）', args: '{ q: 关键词, limit?: 条数 }', needsWeb: true },
  { name: 'web_fetch', title: '开网页', desc: '抓一个网页，读它正文的文字（去掉标签与脚本）', args: '{ url: 完整网址(http/https) }', needsWeb: true },
];

/* ---------------- 写入动作 ---------------- */

const WRITE_TOOLS: ToolSpec[] = [
  { name: 'create_entity', title: '新建设定', desc: '新建一条设定条目（会给它补上该类型的空字段）；也可以一次建一批（仅「自动」档 —— 搬资料库用这个）', args: '{ name: 名字, type?: 类型名, fields?: { 字段: 值 } } 或 { entities: [{ name, type?, fields? }…] }' },
  { name: 'set_field', title: '改字段', desc: '改某条设定的一个字段值；也可以一次改一批（同一个字段、同一个值，仅「自动」档）', args: '{ entity: 名字, field: 字段名, value: 值 } 或 { entities: [名字…], field, value }' },
  { name: 'append_doc', title: '续写正文', desc: '在某条设定或某个事件的正文末尾追加一段', args: '{ target: "entity"|"node", name: 名字, text: 正文 }' },
  { name: 'create_node', title: '新建事件', desc: '在当前时间线上建一个事件节点；也可以一次建一批（仅「自动」档）', args: '{ title: 标题, year: 年份, kind?: 种类, desc?: 一句简述 } 或 { nodes: [{ title, year, kind?, desc? }…] }' },
  { name: 'rename_entity', title: '改名', desc: '给一条设定改名', args: '{ entity: 旧名字, name: 新名字 }' },
  /* ⭐ 灵框自己的设置（用户 2026-09-26：「给 AI 留一条改灵框设置的通道（包括聊天/Agent）」）。
     ⚠️ 只认白名单三个键 —— 不给模型碰"数据目录 / 界面布局 / 供应商密钥"这类东西的口子
     （apiKey 一概不认：那是密钥，只该由创作者自己在设置面板里填）。 */
  { name: 'set_setting', title: '改设置', desc: '改助手自己的设置：权限范围 / 是否每次询问 / 模式', args: '{ key: "agentScope"|"agentAsk"|"agentMode", value: 新值 }' },
  { name: 'set_mode', title: '切模式', desc: '把助手切到「自动」或「一轮」档（切到自动 = 放它连着走多步，永远要创作者点一下）', args: '{ mode: "chat"|"agent" }' },
  /* ⭐ 片 1：写文件。`needsConfirm` 在 `planWrite()` 里按"是不是灵框库外"逐条决定（见那一节）。 */
  { name: 'write_file', title: '写文件', desc: '新建或整篇覆盖一个文本文件（灵框库以外每次都要创作者点「应用」）', args: '{ path: 文件绝对路径, text: 内容 }', needsFs: true },
  { name: 'append_file', title: '追加到文件', desc: '在一个文本文件末尾追加一段（文件不存在就建）', args: '{ path: 文件绝对路径, text: 内容 }', needsFs: true },
  /* ⭐ 2026-09-29：创作者让你看/写一个还没交给你的文件夹时，**别直接说做不到** —— 提这个动作，
     他会看到一张「把某文件夹交给助手」的卡片（默认只读；要写就 write:true）。永远要人点头（needsConfirm）。 */
  { name: 'allow_folder', title: '要一个文件夹', desc: '请创作者把一个文件夹交给助手（他点「应用」才生效；默认只读，write:true 才可写）', args: '{ path: 文件夹绝对路径, write?: true }', needsFs: true },
  /* ⭐ 片 3 的另一半：**新建世界 / 时间线**（用户那天问的原话是「删除和创建」）。
     原有的创建工具只管灵框**里面一条条的内容**（create_entity / create_node / write_file / append_file），
     而「世界」「时间线」这两层一直没有入口 —— `src/store/actions.ts` 的 addWorld / addTimeline 早就有。 */
  { name: 'create_world', title: '新建世界', desc: '新建一个世界观（同名会自动加序号；建完会切到它，里面是空的）', args: '{ name: 世界名字 }' },
  { name: 'create_timeline', title: '新建时间线', desc: '在当前世界里新建一条时间线（空的，之后可以往里建事件）', args: '{ name: 时间线名字 }' },
  /* ⭐ 片 3（2026-10-12）：**删除**。用户当天问「你没给AI配置删除和创建的工具吗」——
     创建早有（create_entity / create_node / write_file / append_file），删除一条都没有。
     全部走回收站：灵框库里那三个由 `src/store/actions.ts` 的 removeXxx 把 .md 移进 `vault/.trash/`，
     灵框外的 delete_file 由主进程 `shell.trashItem()` 移进 **Windows 回收站**。 */
  { name: 'delete_entity', title: '删设定', desc: '删掉一条设定（它的 .md 一起移进 vault 回收站，可恢复）', args: '{ name: 名字 }' },
  { name: 'delete_node', title: '删事件', desc: '删掉当前时间线上的一个事件（.md 一起移进回收站，可恢复；同名多个要再给 year）', args: '{ title: 标题, year?: 年份 }' },
  { name: 'delete_timeline', title: '删时间线', desc: '删掉整条时间线（连同它上面的事件目录一起移进回收站，可恢复）', args: '{ name: 时间线名字 }' },
  { name: 'delete_world', title: '删世界', desc: '删掉整个世界（连同它的时间线与设定一起移进回收站，可恢复）', args: '{ name: 世界名字 }' },
  { name: 'delete_file', title: '删文件', desc: '把灵框库外的一个文件移进 Windows 回收站（只删文件、不删目录；不能删灵框库里的文件）', args: '{ path: 文件绝对路径 }', needsFs: true },
];

export function findTool(name: string): ToolSpec | undefined {
  return READ_TOOLS.concat(WRITE_TOOLS).find((t) => t.name === name);
}

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.some((t) => t.name === name);
}

/** 给系统提示用：把能用的动作列出来 + 说清怎么调。
 *  ⭐ 2026-09-26 用户改口后**两个模式都注入**这份协议（「聊天模式也留一点灵框内部的工具」），
 *  差别只在最后那句"一次能做几步"：「一轮」一次一个、「自动」可以连着走多步（见 `agent-mode.ts`）。
 *  ⭐ 2026-09-28（片 1）：灵框**外**的**文件**动作加进来了 —— `needsFs` 标着的那些只在主进程真有
 *  `fs:*` 通道时列出（否则模型会对着不存在的工具空转）；后面再跟一段 `fsPrompt()`，说清"你能碰哪些
 *  文件夹、规矩是什么"。⚠️ 命令 / 联网 / 抓网页**仍然一条都没有**（这一轮用户只批了文件读写）。 */
export function toolsPrompt(mode: AgentMode = 'agent'): string {
  const live = (t: ToolSpec): boolean => (!t.needsFs || fsAvailable()) && (!t.needsFsBatch || fsBatchAvailable()) && (!t.needsWeb || webAvailable());
  const rows = READ_TOOLS.filter(live).map((t) => `- ${t.name} ${t.args} —— ${t.desc}`)
    .concat(WRITE_TOOLS.filter(live).map((t) => `- ${t.name}（要创作者点头）${t.args} —— ${t.desc}`));
  return [
    '【你能用的动作】',
    '只读的可以随时用，我会立刻把结果给你；写入的不会直接生效，会先变成一张要创作者点「应用」的提议卡片。',
    ...rows,
    fsPrompt(),
    webPrompt(),
    '要动用某个动作时，回复里**只写 JSON**（别夹解释）。两个键的名字必须是 tool 和 args：',
    '{"tool":"read_entity","args":{"name":"安德希亚城"}}',
    '{"tool":"set_field","args":{"entity":"霜精灵","field":"描述","value":"霜精灵是生活在北境冻原的种族。"}}',
    '⚠️ 不要写成 {"动作名":{…}}（例如 {"set_field":{…}}），也不要写成 {"name":…,"arguments":…} —— 那样我认不出来。',
    /* ⭐ 用户 2026-10-12：「不能兼容一次多个动作执行吗」—— 真机会话里模型自己纠结过
       「只写一行 JSON」与「可以连着提多个动作」是不是矛盾（reasoning 原话："only one action per reply?"），
       于是老老实实一次只提一个，最后想批量时改走厂商原生调用，被接口拒掉、还把警告当正文发了出来。
       这里把话说明白：多动作 = 一行一个 JSON，不是"一次只能一个"。 */
    '⭐ **「一次多个动作」的正规写法就是一行一个 JSON**（要连着做几件事就写几行，我按顺序全跑）—— 别理解成"一次只能一个"：',
    '{"tool":"list_files","args":{"path":"D:/Desktop/世界观资料整理/设定/第一世界"}}',
    '{"tool":"list_files","args":{"path":"D:/Desktop/世界观资料整理/设定/第二世界"}}',
    /* ⭐ 片 4（2026-10-15，用户：「**话说为什么他干活了这么久但是我一个节点都没看到**」）：
       真机 120 条里它读了 60 次目录 + 29 次文件、**一次写入都没有** —— 计划是"先把内容全摸清，
       再一次性建条目"，而能发给它的只有最近十几条消息 ⇒ 读完忘、忘了重读，永远到不了"建"。
       这里把正规打法钉死（有批量通道时才说 —— 旧版主进程没有 read_many）。 */
    ...(fsBatchAvailable() ? [
      '⭐ **搬资料库（把一个文件夹的素材变成灵框里的条目）的正规打法**，就这三步循环做：',
      '   ① `read_many`（不给参数）= 读下一批**还没读过**的文件（一次最多 12 个 / 约 12000 字）；',
      '   ② **读完这一批就立刻建条目**：`create_entity{entities:[{name,type?,fields?},…]}` 一次建一批；事件用 `create_node{nodes:[…]}`，正文用 `append_doc`；',
      '   ③ 建完再 `read_many` 读下一批；想知道还剩多少就问 `import_status`。',
      '⚠️ **绝不要"先把整个库读完、再一次性建"**：你只看得见最近十几条消息，读多了前面的就从你眼前消失了（历次实测：那样会无限重读、一个条目都建不出来）。**读一批、建一批**是唯一走得通的做法。',
      '⚠️ `create_node`（事件）要有当前时间线；这个世界还没有时间线就先 `create_timeline`（设定条目 `create_entity` 不依赖时间线）。',
    ] : []),
    '⚠️ **别用你厂商那套原生函数调用**（`＜…invoke name="…"＞`／DSML 那种形状，或在后台自行发起"调用"）：那套一次只允许一个，你多写几个会被**厂商接口**当场拒绝，并把一段 `<system_warning>…</system_warning>` 塞进你的回复里 —— 那是噪音，我只会丢掉它，创作者一个字都看不到。多动作一律用上面那种"一行一个纯 JSON"。',
    '要放开权限（切到「自动」档、把权限改宽）时，那张卡片**永远**要创作者点「应用」才会生效 —— 别催他。',
    '⚠️ 删除类动作（delete_entity / delete_node / delete_timeline / delete_world / delete_file）**只有创作者明说要删时才用**：别自己判断"这条重复了、那个没用了"就动手。它们都会进回收站（灵框库里 → vault 回收站，灵框库外的文件 → Windows 回收站），但那是给创作者捞回误删的，不是给你试错的。',
    mode === 'agent'
      ? '不需要用动作时就用平常的话回答。**一次提问里可以连着提多个动作**（' + stepsPrompt() + '）；批量活（一次建好几个事件、给一批设定加同一个字段、**把一整个资料库搬进来**）**一次规划好再动手**：`set_field{entities:[…]}`、`create_node{nodes:[…]}` 与 `create_entity{entities:[…]}` 三种批量形态只有在这个（「自动」）档里认。'
      : '不需要用动作时就用平常的话回答。**一次提问只提一个动作**（这是「一轮」档的规矩），做完把结果说给他、等他决定下一步；**也不要用批量形态**（`entities`/`nodes` 两个键这个档不认，要用得先切到「自动」）。',
  ].join('\n');
}

/* ---------------- 原生 function calling（2026-10-15，用户选定「上原生 function calling」）----------------
 *
 *  背景：到这一轮为止，助手一直靠**文本协议**（模型把动作写成一行一个 JSON、我们解析）。
 *  历轮修的全是"解析器认不认得出"（DSML / 厂商警告 / 散文穿插 / 回声 / 一行坏掉…），
 *  用户 2026-10-15 第四次报「工具调用又被当成正文了」并问「有没有现成的轮子可以用啊」——
 *  选定的答案就是**厂商原生 function calling**：请求里带 `tools`（JSON Schema），
 *  模型用它自己那套结构化调用回话（`AiReply.calls`），动作**根本不进正文**，
 *  我们那套文本解析器从此只是**兜底**（本地小模型/不支持 tools 的端点还靠它）。
 *
 *  ⚠️ 两件事刻意不做：
 *   ① 历史仍按**文本协议**存（`src/ui/agent.ts` 把原生调用再序列化成"一行一个 JSON"落进历史）——
 *      `sessions.json` 的格式、渲染、折叠、回执、下一轮请求的形状因此一个字都不用改；
 *   ② schema 一律**宽松**（`additionalProperties: true`、只列参数名不写类型）——
 *      严格 schema 会让模型少给一个键就被端点 400，而参数校验本来就是 `planWrite()` 在做。 */

/** 厂商原生调用（`src/ui/ai.ts` 的 `AiReply.calls` 的形状 —— 结构兼容，不 import 以免绕圈） */
export interface NativeCall { id?: string; name: string; args: string }
export interface NativeTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** 从 `args` 那串人话里抠出参数名（`{ type?: 类型名 }` → `type`；`{ q: 关键词, path?: … }` → `q`/`path`） */
function propNames(argsText: string): string[] {
  const out: string[] = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*[?:]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(argsText))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** 厂商原生工具清单（与 `toolsPrompt()` 同一张表、同一套 `needsFs`/`needsWeb` 过滤）。 */
export function nativeTools(): NativeTool[] {
  const live = (t: ToolSpec): boolean => (!t.needsFs || fsAvailable()) && (!t.needsFsBatch || fsBatchAvailable()) && (!t.needsWeb || webAvailable());
  const all = READ_TOOLS.concat(WRITE_TOOLS).filter(live);
  return all.map((t) => {
    const props: Record<string, unknown> = {};
    for (const k of propNames(t.args)) props[k] = {};
    const primary = PRIMARY[t.name];
    if (primary && !props[primary]) props[primary] = {};
    const write = isWriteTool(t.name);
    return {
      type: 'function' as const,
      function: {
        name: t.name,
        description: `${t.desc}。参数：${t.args}`
          + (write ? '（写入类：不会直接生效，会先变成一张要创作者点「应用」的提议卡片）' : ''),
        parameters: { type: 'object', properties: props, additionalProperties: true },
      },
    };
  });
}

/** 原生调用 ⇒ 内部 `ToolCall`（参数原文按 JSON 解析，能修的先修；工具名不认识 ⇒ 进 `bad`） */
export function callsFromNative(list: NativeCall[]): { calls: ToolCall[]; bad: string[] } {
  const calls: ToolCall[] = [];
  const bad: string[] = [];
  for (const c of list) {
    const name = str(c.name);
    if (!findTool(name)) { bad.push(JSON.stringify({ tool: name, args: c.args })); continue; }
    const raw: unknown = c.args;
    if (isObj(raw)) { calls.push({ tool: name, args: raw as ToolArgs }); continue; }
    const text = str(raw);
    if (!text) { calls.push({ tool: name, args: {} }); continue; }
    let o: unknown;
    try {
      o = JSON.parse(text);
    } catch {
      try {
        o = JSON.parse(repairJsonText(text));
      } catch {
        bad.push(JSON.stringify({ tool: name, args: text }));
        continue;
      }
    }
    calls.push({ tool: name, args: toArgs(name, o) });
  }
  return { calls, bad };
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
  create_world: 'name',
  create_timeline: 'name',
  rename_entity: 'name',
  set_setting: 'value',
  set_mode: 'mode',
  list_files: 'path',
  read_file: 'path',
  read_many: 'dir',
  import_status: 'dir',
  search_files: 'q',
  write_file: 'text',
  append_file: 'text',
  delete_entity: 'name',
  delete_node: 'title',
  delete_timeline: 'name',
  delete_world: 'name',
  delete_file: 'path',
  allow_folder: 'path',
  web_search: 'q',
  web_fetch: 'url',
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
/** 字段值的显示形态（数组用 / 连起来）—— 卡片与回执共用一个写法 */
const fmtVal = (v: PropValue): string => (Array.isArray(v) ? v.join('/') : String(v));
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

/** 从 `from` 处切出一个**配平**的 JSON 对象（`from` 必须是 `{`）；切不动返回 null。
 *  ⚠️ 必须**字符串感知**地数大括号：参数里带 `{` / `}`（`write_file` 的正文、`set_field` 的值）
 *     时，按字符数大括号会当场切错。 */
function readJsonObject(text: string, from: number): { span: string; next: number } | null {
  if (text[from] !== '{') return null;
  let i = from;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) return null; /* 括号没配平 */
  return { span: text.slice(from, i), next: i };
}

/** 把一段「连在一起的多个 JSON 对象」切成一个个对象文本；夹了散文就返回 null。 */
function splitJsonSpans(text: string): string[] | null {
  const spans: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /[\s,;]/.test(text[i])) i++; /* 分隔符：换行 / 逗号 / 分号 / 空格 */
    if (i >= text.length) break;
    const one = readJsonObject(text, i);
    if (!one) return null; /* 夹了散文 ⇒ 不当动作看 */
    spans.push(one.span);
    i = one.next;
  }
  return spans.length ? spans : null;
}

/** `text[i]` 那一行里、`{` 之前只有空白 / 一个列表符号（`-` `*` `•` `1.`）⇒ 算「顶在行首」 */
function atLineStart(text: string, i: number): boolean {
  let j = i;
  while (j > 0 && text[j - 1] !== '\n') j--;
  return /^\s*(?:[-*+•]|\d+[.)])?\s*$/.test(text.slice(j, i));
}

/** ⭐ 用户 2026-10-11 实测报的坑（原话：「工具也被吃了」）：
 *  模型**先写一句话、再一行一个动作** ——
 *  「好，这是个大工程 —— 我先把整个库的结构扫完，再分批读内容建条目。」后面跟 8 行
 *  `{"tool":"list_files","args":{"path":"D:\\Desktop\\…"}}`。
 *  老规矩「整段就是一个 JSON」把这一整条当聊天吃了（`splitJsonSpans` 一遇散文就 null）⇒
 *  **8 个动作一个都没跑**，创作者看到的就是"工具被吃了"。
 *
 *  ⭐ 用户 2026-10-13 第二次实测（原话：「**依旧被当成正文了**」）：那一批是
 *  **14 行动作 + 末尾还有一句散文**（「接下来先读其他几批文件，先把内容全摸清，再一次性建条目。」）——
 *  上面那条规矩只认**前置**散文（`if (spans.length) return null`），尾巴上挂一句话就整批作废，
 *  于是 14 个动作一个都没跑、整坨 JSON 被当正文画到脸上。
 *
 *  所以这里前后都认。判据仍然收得很紧，免得把"举例说明"当成真调用（★13 那条仍然不许跑）：
 *   ① 至少 **2 个**对象（`你可以这样写：` + 一个例子 = 1 个 ⇒ 还是聊天）；
 *   ② 第 1 个之后，每个对象都**顶在一行开头**（夹在句子中间的不算）；
 *   ③ 单对象 + 前置散文 ⇒ 仍然当聊天（★13）。
 *
 *  ⭐ 用户 2026-10-14 第三次实测（原话：「**还是被当成正文发出来了**」，附真机会话原文）：一批
 *  **4 行动作 + 一大段回声（模型把前几轮的历史回执原样抄了一遍：`【动作结果：list_files】…`）
 *  + 两句英文散文 + 又是 13 行动作**，一共 17 个动作、中间夹着 26 行非 JSON。旧规矩只允许
 *  散文挂在"头"或"尾"各一段（`if (tailProse) return null`）⇒ 中间那段一回声就整批作废，
 *  17 个动作一个都没跑、整坨 JSON 又被当正文画到脸上。
 *  ⇒ 现在的规矩：**对象之间的任何非 JSON 行都允许**（回声 / 散文都算），只守「≥2 个」与
 *  「第 2 个起必须独立成行」这两条。代价是"回复里正好有两行能解析成动作的 JSON 例子"会真跑，
 *  但那本来就是我们给的协议形状 —— 宁可跑，不可吃。 */
function splitJsonSpansLoose(text: string): string[] | null {
  const spans: string[] = [];
  let i = 0;
  let sawProse = false; /* 第 1 个对象**之前**有散文（「先写一句话」） */
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{') {
      if (spans.length && !atLineStart(text, i)) return null; /* 第 2 个起必须独立成行 */
      const one = readJsonObject(text, i);
      if (!one) return null;
      spans.push(one.span);
      i = one.next;
      continue;
    }
    if (/[ \t\r\n,;]/.test(ch)) { i++; continue; }
    /* 非 JSON 行：第 1 个对象之前＝前置散文；对象之间 / 之后＝回声或散文。都放行。 */
    if (!spans.length) sawProse = true;
    i++;
  }
  if (!spans.length) return null;
  if (spans.length >= 2) return spans; /* 一行一个动作：前后、中间挂话都认 */
  return sawProse ? null : spans; /* 单个动作 + 前置散文 ⇒ 仍然当聊天（★13） */
}

/** 模型偶尔会把键名**写重**一遍：真机 `#119` 的第 24 行就是
 *  `{"tool":"tool":"read_file","args":{…}}`（2026-10-15 这一次「又被当成正文了」的元凶）。
 *  能就地修的语法坏法先修一版，再交给 `JSON.parse`。 */
function repairJsonText(s: string): string {
  return s
    /* `"tool":"tool":` / `"args":"args":` / `"path":"path":` —— 键名与它的值重了一遍 */
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"\1"\s*:/g, '"$1":')
    .trim();
}

/** 一串对象文本 ⇒ 工具调用。
 *
 *  ⭐ 用户 2026-10-15（原话还是「工具调用又被当成正文了」）：真机那一批是 **37 行** `read_file`，
 *  其中**只有第 24 行**是坏的（`{"tool":"tool":"read_file",…}`）—— 老规矩「有一段认不出就
 *  整段作废」把 **36 个好好的动作全扔了**，整坨 JSON 又被当正文画到创作者脸上。
 *  ⇒ 现在的规矩：**坏的挑出来通报、好的照跑**，一行手滑绝不拖死一整批。
 *  安全边界没动：认不出的那行只会被**跳过**，永远不会被猜着执行。 */
function callsFromSpans(spans: string[]): { calls: ToolCall[]; bad: string[] } {
  const calls: ToolCall[] = [];
  const bad: string[] = [];
  for (const s of spans) {
    let o: unknown;
    try {
      o = JSON.parse(s);
    } catch {
      try {
        o = JSON.parse(repairJsonText(s));
      } catch {
        bad.push(s);
        continue;
      }
    }
    const call = normalizeCall(o);
    if (!call) { bad.push(s); continue; }
    calls.push(call);
  }
  return { calls, bad };
}

/** 从模型回复里抠出**全部**工具调用；不是调用就返回空数组（当普通聊天处理）。
 *
 *  ⭐ 用户 2026-10-10 实测报的这个坑：「有时候工具打出来了但是无法调用，卡住了吗」——
 *  模型把 **4 个 JSON 连写**在一段回复里（中间连换行都没有），老解析器 `JSON.parse` 整段直接抛错
 *  ⇒ `parseToolCall` 与 `looksLikeToolJson` 双双 false ⇒ 整坨 JSON 被当聊天原文画到创作者脸上、
 *  **一个动作都没跑**，这一轮就此结束（看起来就是"卡住了"）。现在这种连写按顺序全认。 */
export interface ToolBatch {
  /** 认下来、该跑的（顺序即模型写的顺序） */
  calls: ToolCall[];
  /** 同一批里**认不出**的原文（坏了 / 工具名不认识）—— 上层拿它通报一声，别静默吞掉 */
  bad: string[];
}

export function parseToolBatch(raw: string): ToolBatch {
  const none: ToolBatch = { calls: [], bad: [] };
  /* ⭐ 厂商噪音先剥（用户 2026-10-12：「不能兼容一次多个动作执行吗」）—— 剥完可能正好露出一条
     正经 JSON；不剥的话「警告 + 1 个 JSON」既不以 `{` 开头、也不满足"散文 + ≥2 个对象"，
     那个动作会被静默吃掉（他看到的正是"提示一次只能一个动作、然后什么都没发生"）。 */
  const text = stripVendorNoise(String(raw ?? '').replace(/```[a-zA-Z]*/g, '').trim());
  /* ① ⭐ DSML（DeepSeek 那一族的原生标记）先认一遍 —— 用户 2026-10-11：「又被当正文发出来了」 */
  if (looksLikeDsml(text)) {
    const dsml = parseDsmlCalls(text);
    if (dsml.length) return { calls: dsml, bad: [] };
  }
  /* ② ⭐「先说一句话、再一行一个动作」（用户 2026-10-11：「工具也被吃了」）——
     不是以 `{` 开头的**不代表不是动作**：那一批 8 个 list_files 就是这么被吃掉的。 */
  if (!text.startsWith('{')) {
    const batch = splitJsonSpansLoose(text);
    return batch ? callsFromSpans(batch) : none;
  }
  let obj: unknown;
  let parsed = false;
  try {
    obj = JSON.parse(text);
    parsed = true;
  } catch {
    const end = text.lastIndexOf('}');
    if (end >= 0) {
      try {
        obj = JSON.parse(text.slice(0, end + 1)); /* 后面还挂着一句话，切到最后一个 } 再试 */
        parsed = true;
      } catch { /* 落到下面「一串」那条路 */ }
    }
  }
  if (parsed) {
    const one = normalizeCall(obj);
    /* 整段就是一个对象、却认不出工具名 ⇒ 不报 `bad`（那条走「格式提醒」纠正一次的老路） */
    return one ? { calls: [one], bad: [] } : none;
  }
  /* ⭐ 尾巴上挂着散文的那一批（用户 2026-10-13）走这条 —— `splitJsonSpans` 遇散文一律 null */
  const spans = splitJsonSpans(text) ?? splitJsonSpansLoose(text);
  return spans ? callsFromSpans(spans) : none;
}

export function parseToolCalls(raw: string): ToolCall[] {
  return parseToolBatch(raw).calls;
}

/** 单个调用（渲染层画「用到动作」那一行、只读判定都用它） */
export function parseToolCall(raw: string): ToolCall | null {
  return parseToolCalls(raw)[0] ?? null;
}

/** 整条回复是一个（或**一串**）JSON 对象、但没能映射到动作 —— 多半是格式写歪了 */
export function looksLikeToolJson(raw: string): boolean {
  const text = String(raw ?? '').replace(/```[a-zA-Z]*/g, '').trim();
  /* ⭐ 认不出的 DSML 标记也算「像动作、格式写歪了」—— 好让上层回头纠正它一次，
     而不是把这一坨标记当聊天画到创作者脸上（用户 2026-10-11：「又被当正文发出来了」） */
  if (looksLikeDsml(text)) return parseDsmlCalls(text).length === 0;
  /* ⭐ 厂商警告同理（用户 2026-10-12）：只剩警告、没有可跑动作 ⇒ 当"像动作、格式被搅了"，
     让上层回头纠正它一次 —— 绝不把那段 `<system_warning>…</system_warning>` 当正文画出来。 */
  if (looksLikeVendorNoise(text)) return parseToolCalls(text).length === 0;
  /* ⭐「先说一句话 / 末尾再叮嘱一句、中间一行一个动作」的形状同理（用户 2026-10-11「工具也被吃了」、
      2026-10-13「依旧被当成正文了」）：认得出动作就正常跑（那条走 `parseToolCalls`），
      认不出（工具名写歪了）也该回头纠正一次，而不是当聊天糊在脸上。
      ⚠️ 这条必须排在 `!text.endsWith('}')` 那个早退**之前** —— 尾巴上有散文时它不以 `}` 结尾。 */
  const isObjText = (s: string): boolean => {
    try { return isObj(JSON.parse(s)); } catch { return false; }
  };
  const loose = splitJsonSpansLoose(text);
  if (loose) return loose.every(isObjText);
  if (!text.startsWith('{') || !text.endsWith('}')) return false;
  try {
    if (isObj(JSON.parse(text))) return true;
  } catch { /* 可能是一串对象 */ }
  const spans = splitJsonSpans(text);
  if (!spans) return false;
  return spans.every(isObjText);
}

/** 流式用的**宽松**判据：这一段里只要出现「顶在行首的 `{`」，就先别往气泡里写 ——
 *  对象还没吐完（括号没配平）也得能认出来。落定后真不真跑由 `parseToolCalls()` 定：
 *  认不出就照旧当聊天画出来（气泡由 `renderMsgs()` 重画，闪不到人）。
 *  ⭐ 用户 2026-10-11：「工具也被吃了」—— 那一批动作前面有一句话，于是 `startsWith('{')` 不成立，
 *  整批 JSON 边流边往气泡里写。 */
export function looksLikeToolBatch(raw: string): boolean {
  return /(^|\n)[ \t]*(?:[-*+•]|\d+[.)])?[ \t]*\{/.test(String(raw ?? ''));
}

/* ---------- 厂商噪音：模型的原生多调用被接口拒掉时塞回来的那段 ----------
 *
 *  ⭐ 用户 2026-10-12 实测（原话：「不能兼容一次多个动作执行吗」，贴的就是这一坨）：
 *
 *      <system_warning>工具调用被拒绝：一次只能输出一个动作。</system_warning>
 *
 *      {"tool":"list_files","args":{"path":"D:\\…\\角色"}}
 *
 *  真相：**这句话不是灵框写的**（全仓 grep `system_warning` 零命中）—— 云端 `deepseek-flash`
 *  在"想一次提多个动作"时走了它自己那套**原生**函数调用，厂商接口一次只放一个 ⇒ 当场拒掉、
 *  把这段警告塞进 `message.content`。它既不是动作、也不是创作者要看的话：
 *  旧代码里这段会被 `toolProse()` 当正文画进气泡，而它后面**那一条正经 JSON 反而没被认**
 *  （`splitJsonSpansLoose()` 要求"散文 + ≥2 个对象"，只有一个对象 ⇒ 当聊天，
 *  动作被静默吃掉 —— 创作者看到的就是"提示一次只能一个动作、然后什么也没发生"）。
 *
 *  处理：**先剥噪音再解析**（剥完是纯 JSON 就照常跑，`警告 + 1 个 JSON` 与 `警告 + N 个 JSON` 都认）；
 *  只剩警告、没有动作的，走「格式提醒」纠正一次，绝不画到创作者脸上。 */

/** 有厂商塞进来的警告块吗（`<system_warning …>…</system_warning>`，或只吐了一半的单边标记） */
export function looksLikeVendorNoise(raw: string): boolean {
  const text = String(raw ?? '');
  /* 宽松：`<system_warning>` 只吐到一半（`<system_warn`）时也算 —— 流式遮罩靠它别闪 */
  return /<\s*\/?\s*system_warn/i.test(text);
}

/** 抠掉厂商警告块（配对与没配对的都抠），其余原样返回 */
export function stripVendorNoise(raw: string): string {
  return String(raw ?? '')
    .replace(/<\s*system_warning\b[^>]*>[\s\S]*?<\s*\/\s*system_warning\s*>/gi, '')
    .replace(/<\s*\/?\s*system_warning\b[^>]*>/gi, '')
    /* 只吐了一半、`>` 都没到的尾巴（`<system_warn`）也一并清掉 */
    .replace(/<\s*\/?\s*system_warn[a-z_]*\s*$/i, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 动作消息里那截**散文**（模型先写的那句话 —— 用户 2026-10-11 实测的
 *  「好，这是个大工程 —— 我先把整个库的结构扫完，再分批读内容建条目。」）。
 *  这条消息不是「动作 + 散文」的形状就返回 ''：宁可什么都不显示，也绝不把 JSON 画到创作者脸上。 */
export function toolProse(raw: string): string {
  const rawText = String(raw ?? '');
  if (looksLikeDsml(rawText)) return ''; /* DSML 形态没有正文可留 */
  /* ⭐ 厂商警告不是正文（用户 2026-10-12）—— 先剥掉它；「一句话 + 一批动作」里那句真散文照留 */
  const text = stripVendorNoise(rawText.replace(/```[a-zA-Z]*/g, '').trim());
  if (!text) return '';
  const spans = splitJsonSpans(text) ?? splitJsonSpansLoose(text);
  if (!spans) return ''; /* 抠不干净（比如「{…}后面还挂一句话」）⇒ 一个字都不留 */
  let rest = text;
  for (const s of spans) rest = rest.replace(s, '\n');
  /* ⭐ 用户 2026-10-14（「还是被当成正文发出来了」）：模型会把**前几轮的历史回执**原样抄进正文
     （连我们编的"里 N 项"都抄串了：抄成"里 8 项"却列了 14 行）。那是回声、不是它说的话 ——
     画进气泡只会让创作者以为又拿到一份结果。`【动作结果：` 是我们自己的机器消息前缀，
     模型正经写话不会这么开头 ⇒ 从这一行起、连同它下面那段正文（到空行为止）整块丢掉。 */
  const out: string[] = [];
  let echoing = false;
  for (const line of rest.split('\n')) {
    if (/^\s*【动作结果：/.test(line)) { echoing = true; continue; }
    if (echoing) {
      if (line.trim() === '') { echoing = false; out.push(''); } /* 空行 = 这段回声到头了 */
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

/* ---------- DSML：DeepSeek 那一族的**原生**函数调用标记 ----------
 *
 *  ⭐ 用户 2026-10-11 实测报的坑（原话：「又被当正文发出来了」）：
 *  云端 `deepseek-flash` 压根不理会我们那套「整条回复只写一行 JSON」的协议，按它训练时的
 *  格式吐了一坨（下面这些竖线是**全角 U+FF5C**，是从他真实会话文件
 *  `%APPDATA%\lingkuang\agent\sessions.json` 里抓到的原样）：

      ＜｜｜DSML｜｜ calls＞
      ＜｜｜DSML｜｜ invoke name="read_file"＞
      ＜｜｜DSML｜｜ parameter name="args" string="false"＞{"path":"D:\\…\\总览.md"}＜/｜｜DSML｜｜ parameter＞
      ＜/｜｜DSML｜｜ invoke＞
      ……（★一次能连吐好几个 invoke）

 *  老解析器只认 `{…}` ⇒ **一个动作都没跑**，整坨标记还被当正文画到创作者脸上（他看到的
 *  就是"AI 把工具调用当话说了"）。这里把标记认下来：`invoke name=` 取动作名、里面每个
 *  `parameter name=` 取参数。
 *
 *  ⚠️ 别去枚举那些符号：真机是全角 `｜｜DSML｜｜`，别家版本可能是 ASCII `||DSML||`、也可能
 *     干脆没前缀 —— 只按「`<` + 任意非 `>` + `invoke` / `parameter` + 属性」这个宽松形状匹配。 */

/** 参数取值：能当 JSON 解析就当对象（`{"path":"…"}`），否则去实体、当普通字符串 */
function dsmlValue(raw: string): unknown {
  const s = String(raw ?? '').replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();
  const txt = s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
  if (txt.startsWith('{') || txt.startsWith('[')) {
    try {
      return JSON.parse(txt);
    } catch { /* 不是合法 JSON 就当普通字符串用 */ }
  }
  return txt;
}

/** 回复里像不像 DSML 标记（**严格**判据，给"要不要解析 / 要不要纠正"用）：
 *  ① 有 `<…invoke…>` / `<…parameter…>` 这种标签；② 或带 DSML 字样**且**提到 calls/invoke/parameter。 */
export function looksLikeDsml(raw: string): boolean {
  const text = String(raw ?? '');
  if (/<\s*\/?\s*[^>]*?\b(?:invoke|parameter)\b[^>]*>/i.test(text)) return true;
  return /DSML/i.test(text) && /\b(?:calls|invoke|parameter)\b/i.test(text);
}

/** 流式用（**宽松**判据）：`<` 后面到 `>` 之前出现 `DSML` 就算 —— 真机第一片增量只到
 *  `＜｜｜DSML｜｜ cal`（`invoke` 还没写完），严格判据那一刻认不出，标记会先闪进气泡。
 *  刻意宁可少画一屏文本，也不把这一坨标记糊到创作者脸上（用户 2026-10-11「又被当正文发出来了」）。 */
export function looksLikeToolMarkup(raw: string): boolean {
  const text = String(raw ?? '');
  /* ⭐ 厂商警告块也别闪进气泡（用户 2026-10-12：`<system_warning>工具调用被拒绝…` 被当正文画出来了） */
  if (looksLikeVendorNoise(text)) return true;
  if (/<[^>]*DSML/i.test(text)) return true;
  return looksLikeDsml(text);
}

/** 从 DSML 标记里抠出全部调用；一个都认不出 ⇒ 空数组（交给"回头纠正一次"那条路） */
function parseDsmlCalls(raw: string): ToolCall[] {
  const text = String(raw ?? '');
  if (!looksLikeDsml(text)) return [];
  const out: ToolCall[] = [];
  /* ⚠️ `(?!\/)`：开头不能是 `/`，否则收尾标签会被当成开标签再认一次 */
  const openRe = /<\s*(?!\/)[^>]*?\binvoke\s+name\s*=\s*"([^"]+)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(text))) {
    const rest = text.slice(m.index + m[0].length);
    const closeAt = rest.search(/<\s*\/\s*[^>]*?\binvoke\b[^>]*>/i);
    const inner = closeAt >= 0 ? rest.slice(0, closeAt) : rest;
    const params: ToolArgs = {};
    let count = 0;
    const pRe = /<\s*(?!\/)[^>]*?\bparameter\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)(?:<\s*\/\s*[^>]*?\bparameter\b[^>]*>|$)/gi;
    let p: RegExpExecArray | null;
    while ((p = pRe.exec(inner))) {
      params[p[1]] = dsmlValue(p[2]);
      count++;
    }
    /* 参数写成「一个 args / arguments 键装着一整个对象」时掰开；摊平的（`name="path"`）直接用 */
    const keys = Object.keys(params);
    const bag = count === 1 && ARG_KEYS.includes(keys[0]) ? toArgs(m[1], params[keys[0]]) : params;
    const call = normalizeCall({ tool: m[1], args: bag });
    /* 有一个 invoke 认不出 ⇒ 整段不当动作（和 JSON 那条路同一个规矩：宁可不动，也不猜着执行） */
    if (!call) return [];
    out.push(call);
  }
  return out;
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

const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const fmtSize = (n: number): string => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
/** 一次读给模型看的字数上限（全文另说 —— 超过就明说"只给了前 N 字"，别让它以为读完了） */
const FILE_READ_CAP = 6000;

/** 白名单挡下来时给模型的**出路**：提一张 `allow_folder` 卡片，创作者点一下「应用」文件夹就到手了。
 *  ⭐ 为什么非要有这句（用户 2026-09-29 实测）：他把桌面文件夹路径丢给助手，助手被白名单拦下之后
 *  只会说「请确认路径是否正确」—— 用户看到的结论是"这 AI 读写不了灵框外"。**拦下来必须给出路**，
 *  否则模型会绕着说、创作者以为功能不存在。`isDir` 决定要不要去掉最后一段（文件夹取自己，文件取父目录）。 */
function withFolderHint(err: string, path: string, isDir: boolean): string {
  if (!/不在助手能(看|写)的文件夹里|还没接上文件通道/.test(err)) return err;
  const dir = isDir ? path : (path.replace(/[\\/][^\\/]*$/, '') || path);
  return `${err}\n（要够到这儿得先让创作者把这个文件夹交给你：提一个 {"tool":"allow_folder","args":{"path":"${dir}"}} —— 他会看到一张卡片，点「应用」就交给你了（默认只读，要写加 "write":true）。**别直接说做不到**。）`;
}

/** 文件类只读动作（片 1）：白名单由主进程把关，这里只把结果说成人话。
 *  ⚠️ 只读 = 随时可用、不进提议卡片；但"只读"只保证**不改**文件，读到的照样是私有素材。 */
async function runFileRead(call: ToolCall): Promise<string> {
  const a = call.args;
  if (call.tool === 'list_files') {
    const p = str(a.path) || fsDefaultPath();
    if (!p) return '要列哪个文件夹？给我完整路径。';
    const r = await fsList(p);
    if (!r.ok) return withFolderHint(r.error, p, true);
    const { entries, root } = r.data;
    const head = `「${p}」（${root.label}${root.write ? ' · 可写' : ' · 只读'}）里 ${entries.length} 项：`;
    if (!entries.length) return head + '\n（空文件夹）';
    return head + '\n' + entries.map((e) => `${e.dir ? '[目录] ' : ''}${e.name}${e.dir ? '' : '（' + fmtSize(e.size) + '）'}`).join('\n');
  }
  if (call.tool === 'read_file') {
    const p = str(a.path);
    if (!p) return '要读哪个文件？给我完整路径。';
    const r = await fsRead(p);
    if (!r.ok) return withFolderHint(r.error, p, false);
    const text = r.data.text ?? '';
    const body = text.length > FILE_READ_CAP
      ? text.slice(0, FILE_READ_CAP) + `\n…（全文 ${text.length} 字，这里只给了前 ${FILE_READ_CAP} 字）`
      : text;
    return `「${p}」（${fmtSize(r.data.size)}）\n${body || '（空文件）'}`;
  }
  /* ⭐ 片 4：批量读（一次一批，默认"还没读过的下一批"）—— 「搬一整个资料库」的正规家伙 */
  if (call.tool === 'read_many') {
    if (!fsBatchAvailable()) return '这个版本的灵框还没有批量读取通道（升级一下主进程）；先用 read_file 一个文件一个来。';
    const paths = Array.isArray(a.paths) ? (a.paths as unknown[]).map((x) => str(x)).filter(Boolean) : [];
    const dir = str(a.dir) || str(a.path);
    const lim = num(a.limit);
    const chars = num(a.chars);
    const again = a.again === true || a.again === 'true';
    const r = await fsReadMany({
      paths: paths.length ? paths : undefined,
      dir: dir || undefined,
      limit: lim && lim > 0 ? lim : undefined,
      chars: chars && chars > 0 ? chars : undefined,
      again,
    });
    if (!r.ok) return withFolderHint(r.error, dir || paths[0] || fsDefaultPath(), true);
    const d = r.data;
    const leftover = d.outside.length
      ? `\n⚠️ 有 ${d.outside.length} 个路径不在助手能看的文件夹里（被跳过）：${d.outside.slice(0, 3).join('、')}` +
        `\n（要够到它们得先让创作者把文件夹交给你：提一个 {"tool":"allow_folder","args":{"path":"${d.outside[0].replace(/[\\/][^\\/]*$/, '')}"}} —— 他点「应用」就成了。**别直接说做不到**。）`
      : '';
    if (!d.files.length) {
      const done = d.total > 0 && d.remaining === 0
        ? `【批量读取】范围内 ${d.total} 个文本文件**已经全读过了**（已读 ${d.read}），没有新内容。\n` +
          '⭐ 别再读了 —— 现在该**建条目**：把手上这些内容用 `create_entity{entities:[…]}` 落进设定库（事件用 `create_node{nodes:[…]}`，没有时间线就先 `create_timeline`）。'
        : `【批量读取】这一批没有读到东西（范围内 ${d.total} 个文本文件，已读 ${d.read}，还剩 ${d.remaining}）。`;
      const al = d.already.length
        ? `\n（你要的那 ${d.already.length} 个之前已经读过：${d.already.slice(0, 3).join('、')} —— 真想再读一遍就加 "again":true）`
        : '';
      return done + al + leftover;
    }
    const charsGot = d.files.reduce((x, f) => x + f.text.length, 0);
    const head = `【批量读取】这一批 ${d.files.length} 个文件（共 ${charsGot} 字）· 范围内 ${d.total} 个文本文件，已读 ${d.read}，还剩 ${d.remaining}`;
    const body = d.files.map((f) =>
      `---- ${f.rel}（${fmtSize(f.size)}${f.truncated ? ` · 全文 ${f.chars} 字，这里只给了前 ${f.text.length} 字` : ''}）----\n${f.text || '（空文件）'}`).join('\n\n');
    const tail = '⭐ **就着这一批立刻建条目**：`create_entity{entities:[{name,type?,fields?},…]}` 一次建一批（事件用 `create_node{nodes:[…]}`，没有时间线就先 `create_timeline`），建完再 `read_many` 读下一批 —— 别攒着"全读完再建"。';
    return head + leftover + '\n' + body + '\n' + tail + (d.stopped ? '\n（这一批是字数到顶提前停的，下一批接着读）' : '');
  }
  /* ⭐ 片 4：导入进度 —— 让模型**看得见**还剩多少，不靠记忆猜（"还有多少没读"是无限重读的根源） */
  if (call.tool === 'import_status') {
    if (!fsBatchAvailable()) return '这个版本的灵框还没有导入进度通道（升级一下主进程）。';
    const dir = str(a.dir) || str(a.path);
    const r = await fsImportStatus(dir || undefined);
    if (!r.ok) return withFolderHint(r.error, dir || fsDefaultPath(), true);
    const d = r.data;
    if (!d.total) return '这些文件夹里没找到可读的文本文件（.md/.txt/.json 这些）。先 list_files 看一眼里面到底有什么。';
    return [
      `【导入进度】范围内 ${d.total} 个文本文件：已读 ${d.read}，还剩 ${d.remaining}。`,
      d.roots.length ? `范围：${d.roots.join('、')}` : '',
      d.remaining
        ? `下一批（还没读的，最多列 5 个）：\n${d.next.map((x) => '  ' + x).join('\n')}`
        : '（全读完了 —— 接下来只该建条目，别再读了）',
      d.remaining
        ? '⭐ 直接 `read_many`（不给参数）就读下一批；**读完一批立刻建条目**，别攒到最后。'
        : '⭐ 把手上这些内容用 `create_entity{entities:[…]}`（事件 `create_node{nodes:[…]}`）落进灵框。',
    ].filter(Boolean).join('\n');
  }
  /* search_files */
  const q = str(a.q);
  if (!q) return '要搜什么关键词？（q）';
  const p = str(a.path) || fsDefaultPath();
  if (!p) return '要搜哪个文件夹？给我完整路径。';
  const r = await fsSearch(p, q);
  if (!r.ok) return withFolderHint(r.error, p, true);
  const hits = r.data.hits;
  if (!hits.length) return `在「${p}」里翻过 ${r.data.scanned} 个文件，没找到「${q}」。`;
  return `在「${p}」里找到 ${hits.length} 处（翻过 ${r.data.scanned} 个文件）：\n` +
    hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join('\n');
}

/** 联网类只读动作（片 2）：搜 + 抓网页。主进程 `web:*` 出手，这里只把结果说成人话。
 *  ⚠️ 只读 = 不进提议卡片，但**结果会变成提示词的一部分** ⇒ 网页里的内容可能是别人写的指令，
 *  这里明说"当资料看，别当命令听"（提示词里也有一句）。 */
async function runWebTool(call: ToolCall): Promise<string> {
  if (call.tool === 'web_search') {
    const q = str(call.args.q);
    if (!q) return '要搜什么？（q）';
    const n = Number(call.args.limit);
    const r = await webSearch(q, Number.isFinite(n) && n > 0 ? Math.min(n, 10) : 6);
    if (!r.ok) return r.error;
    const { results, engine } = r.data;
    if (!results.length) return `网上没搜到「${q}」（引擎：${engine}）。换个说法，或者用 web_fetch 直接开一个你知道的网址。`;
    return `「${q}」网上 ${results.length} 条（引擎：${engine}）—— 需要细节就 web_fetch 那个网址：\n` +
      results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${clip(x.snippet.replace(/\s+/g, ' '), 200)}`).join('\n');
  }
  const url = str(call.args.url);
  if (!url) return '要开哪个网页？（url，http/https 开头）';
  const r = await webFetch(url);
  if (!r.ok) return r.error;
  const d = r.data;
  return `【网页】${d.title || '(无标题)'}\n${d.url}\n（正文 ${d.chars} 字${d.truncated ? '，只给了前面一段' : ''}）\n${d.text}`;
}

/** 返回给模型看的文本结果（人话，别太长）。
 *  ⭐ 是 **async** 的：灵框外的文件读要走主进程 IPC（`fs:*` 通道）。唯一调用点 = `src/ui/agent.ts`
 *  `runTurn()` 里那句 `const out = await runReadTool(call, host.store)`。 */
export async function runReadTool(call: ToolCall, store: Store): Promise<string> {
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
    case 'list_files':
    case 'read_file':
    case 'read_many':
    case 'import_status':
    case 'search_files':
      return await runFileRead(call);
    case 'web_search':
    case 'web_fetch':
      return await runWebTool(call);
    default:
      return `不认识的动作：${call.tool}`;
  }
}

/* ---------------- 写入：先做成提议 ---------------- */

/** 失败时返回一段人话错误（给模型看，让它改参数重试）。
 *  ⭐ `mode` 只用来卡**批量形态**（`set_field{entities}` / `create_node{nodes}`）——
 *  用户 2026-09-26 拍板：那种"一次动一批"的活只在「自动」档放行，「一轮」档一次只做一个动作。 */
export function planWrite(call: ToolCall, store: Store, mode: AgentMode = 'agent'): { ok: true; proposal: Proposal } | { ok: false; note: string } {
  const ws = currentWorld(store);
  const a = call.args;
  switch (call.tool) {
    case 'create_entity': {
      /* ⭐ 批量形态（2026-10-11，用户：「**我在测试灵框能不能吃下我的所有世界观信息，你都补进来吧**」）：
         `entities: [{ name, type?, fields? }…]` —— **一次搬一整个库**：一张卡片建一批，
         创作者点一次「应用」就落一整批（原来一条一张卡片 ⇒ 搬 100 条要点 100 次）。
         只在「自动」档放行；没写 name 的项直接丢掉（不因为一条写错就整批不动）；
         **已经存在的名字跳过**（搬库时模型常把同一批重发一次，重复建会把树搞乱）。 */
      const manyEnt = Array.isArray(a.entities) ? (a.entities as unknown[]) : null;
      if (manyEnt) {
        if (mode !== 'agent') return { ok: false, note: '「一轮」档一次只建一个 —— 要批量建请先切到「自动」档，或者一个一个说。' };
        const types0 = Object.values(ws?.entityTypes ?? {});
        if (!types0.length) return { ok: false, note: '这个世界还没有类型模板，先在结构体管理里建一个。' };
        const items = manyEnt
          .map((o) => (isObj(o) ? o : ({ name: o } as ToolArgs))) /* 也认 `["名字", …]` 这种最省的写法 */
          .map((o) => {
            const want = str(o.type);
            const t = types0.find((x) => x.name === want || x.id === want) ?? types0[0];
            const f = (o.fields && typeof o.fields === 'object' ? o.fields : {}) as unknown as Record<string, PropValue>;
            return { name: str(o.name), typeId: t.id, typeName: t.name, fields: f };
          })
          .filter((it) => it.name);
        if (!items.length) return { ok: false, note: '批量建设定要给我 entities: [{ name: 名字, fields?: {…} }, …]（每一项都得有 name）。' };
        const dup = items.filter((it) => findEntity(ws, it.name)).map((it) => it.name);
        const fresh = items.filter((it) => !findEntity(ws, it.name));
        if (!fresh.length) return { ok: false, note: `这些设定都已经有了，没有要新建的：${dup.join('、')}。要改它们就用 set_field。` };
        return {
          ok: true,
          proposal: {
            tool: call.tool,
            title: `新建设定：${fresh.length} 条`,
            detail:
              fresh.map((it) => `${it.name}（${it.typeName}）${Object.keys(it.fields).length ? ' · ' + Object.keys(it.fields).length + ' 个字段' : ''}`).join('\n') +
              (dup.length ? `\n（已经有、跳过：${dup.join('、')}）` : ''),
            apply: () => {
              for (const it of fresh) addEntity(store, { name: it.name, typeId: it.typeId, properties: it.fields });
              return { ok: true, note: `已新建 ${fresh.length} 条设定：${fresh.map((it) => it.name).join('、')}` };
            },
          },
        };
      }
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
      const field = str(a.field);
      if (!field) return { ok: false, note: '要改哪个字段？（args.field）' };
      const raw = a.value;
      const value: PropValue = Array.isArray(raw)
        ? (raw as (string | number)[])
        : typeof raw === 'boolean' || typeof raw === 'number'
          ? raw
          : str(raw);
      /* ⭐ 批量形态（阶段 2B）：`entities: [名字…]` —— 同一个字段、同一个值，一次改一批。
         只在 Agent 模式放行；找不到的名字**跳过并写在卡片上**（不因为一条写错就整批不动）。 */
      const many = Array.isArray(a.entities) ? (a.entities as unknown[]).map((n) => str(n)).filter(Boolean) : [];
      if (many.length) {
        if (mode !== 'agent') return { ok: false, note: '「一轮」档一次只改一条 —— 要批量改请先切到「自动」档，或者一条一条说。' };
        const hits = many.map((n) => findEntity(ws, n)).filter((e): e is Entity => !!e);
        const miss = many.filter((n) => !findEntity(ws, n));
        if (!hits.length) return { ok: false, note: `没找到这些设定：${miss.join('、')}。` };
        const ids = hits.map((e) => e.id);
        return {
          ok: true,
          proposal: {
            tool: call.tool,
            title: `改字段：${hits.length} 条设定 · ${field}`,
            detail:
              `都改成：${fmtVal(value)}\n` +
              hits.map((e) => e.name).join('、') +
              (miss.length ? `\n（没找到、跳过：${miss.join('、')}）` : ''),
            apply: () => {
              store.update((d) => {
                for (const id of ids) {
                  const ent = d.worldsets[store.activeWorld]?.entities?.[id];
                  if (!ent) continue;
                  if (!ent.properties) ent.properties = {};
                  ent.properties[field] = value;
                }
              });
              return { ok: true, note: `已把 ${hits.length} 条设定的 ${field} 改成 ${fmtVal(value)}（${hits.map((e) => e.name).join('、')}）` };
            },
          },
        };
      }
      const e = findEntity(ws, str(a.entity));
      if (!e) return { ok: false, note: `没找到叫「${str(a.entity)}」的设定。` };
      const old = e.properties?.[field];
      const id = e.id;
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `改字段：${e.name} · ${field}`,
          detail: `${old === undefined ? '（原本没有这个字段）' : String(old)} → ${fmtVal(value)}`,
          apply: () => {
            store.update((d) => {
              const ent = d.worldsets[store.activeWorld]?.entities?.[id];
              if (!ent) return;
              if (!ent.properties) ent.properties = {};
              ent.properties[field] = value;
            });
            return { ok: true, note: `已把「${e.name}」的 ${field} 改成 ${fmtVal(value)}` };
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
      /* ⭐ 批量形态（阶段 2B）：`nodes: [{title, year, kind?, desc?}…]` —— 一次建一串事件。
         只在 Agent 模式放行；没有 title 的项直接丢掉（不整批失败）。 */
      const manyNodes = Array.isArray(a.nodes) ? (a.nodes as unknown[]) : null;
      if (manyNodes) {
        if (mode !== 'agent') return { ok: false, note: '「一轮」档一次只建一个 —— 要批量建请先切到「自动」档，或者一个一个说。' };
        const tl0 = ws?.timelines?.[store.activeTimeline];
        if (!tl0) return { ok: false, note: '当前没有打开的时间线（这个世界连一条时间线都还没有）—— 先把时间线建出来：{"tool":"create_timeline","args":{"name":"<时间线名字>"}}，建完再往它上面建事件。设定条目（create_entity）不受影响，可以先建。' };
        const items = manyNodes
          .map((o) => (isObj(o) ? o : ({ title: o } as ToolArgs)))
          .map((o) => ({ title: str(o.title), year: num(o.year) ?? 0, kind: str(o.kind), desc: str(o.desc) }))
          .filter((it) => it.title);
        if (!items.length) return { ok: false, note: '批量建事件要给我 nodes: [{ title, year }, …]（每一项都得有 title）。' };
        const tlId0 = tl0.id;
        const tlName = tl0.name;
        return {
          ok: true,
          proposal: {
            tool: call.tool,
            title: `新建事件：${items.length} 个（${tlName}）`,
            detail: items.map((it) => `${it.year} ${it.title}${it.kind ? ' · ' + it.kind : ''}`).join('\n'),
            apply: () => {
              for (const it of items) {
                const partial: Partial<TimelineNode> = { title: it.title, year: it.year, type: 'story_event' };
                if (it.kind) partial.kind = it.kind;
                if (it.desc) partial.desc = it.desc;
                addNode(store, tlId0, partial);
              }
              return { ok: true, note: `已在「${tlName}」上新建 ${items.length} 个事件：${items.map((it) => it.title).join('、')}` };
            },
          },
        };
      }
      const title = str(a.title);
      if (!title) return { ok: false, note: '新建事件要给我标题（args.title）。' };
      const tl = ws?.timelines?.[store.activeTimeline];
      if (!tl) return { ok: false, note: '当前没有打开的时间线（这个世界连一条时间线都还没有）—— 先把时间线建出来：{"tool":"create_timeline","args":{"name":"<时间线名字>"}}，建完再往它上面建事件。' };
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
        ? (value === 'agent' ? '切到「自动」档：它能连着走多步、批量改' : '切到「一轮」档：一次只做一个动作')
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
            return { ok: true, note: value === 'agent' ? '已切到「自动」档（该用工具就用工具，需要时连着走多步）' : '已切到「一轮」档（一次只做一个动作）' };
          },
        },
      };
    }
    /* ⭐ 片 1（2026-09-28）：灵框**外**的文件写。
       三道门在这里各就各位：① 认不出在哪个白名单文件夹里 ⇒ 直接拒绝（人话告诉它该请创作者加进来）；
       ② 那个文件夹是只读 ⇒ 拒绝；③ **灵框库以外** ⇒ `needsConfirm: true`（即便权限是「直接执行」，
       也必须创作者亲手点「应用」—— 这是他选的档："写灵框外一律逐次确认"）。
       ⚠️ 这里的前缀判断只为了**出卡片**；真正拦人的是主进程 `main.js` 的 `fsMatchRoot()`（realpath）。 */
    case 'write_file':
    case 'append_file': {
      const p = str(a.path);
      const text = str(a.text);
      if (!p) return { ok: false, note: '要写哪个文件？给我完整绝对路径（args.path）。' };
      if (!text) return { ok: false, note: '要写什么内容？（args.text）' };
      const root = fsRootOf(p);
      if (!root) {
        const allowed = fsRootsCached().map((r) => r.path).join('、') || '（还没接过文件夹）';
        const dir = p.replace(/[\\/][^\\/]*$/, '') || p;
        return { ok: false, note: `「${p}」不在助手能碰的文件夹里（能碰的只有：${allowed}）。要么写到灵框库里，要么提一个 allow_folder 动作（{"tool":"allow_folder","args":{"path":"${dir}","write":true}}）让创作者决定要不要把它交给你 —— **不要**反复试同一个路径。` };
      }
      if (!root.write) {
        return { ok: false, note: `「${root.label}」是**只读**的，写不进去。要写就提一个 allow_folder 动作（{"tool":"allow_folder","args":{"path":"${root.path}","write":true}}）让创作者点一下放开，或者写到灵框库里。` };
      }
      const outside = !root.builtin;
      const append = call.tool === 'append_file';
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `${append ? '追加到文件' : '写文件'}：${baseName(p)}`,
          detail: `路径：${p}\n${outside ? `（**灵框库外** —— ${root.label}${root.write ? ' · 可写' : ''}，只有你点「应用」才会落盘）\n` : ''}${clip(text, 300)}`,
          needsConfirm: outside,
          apply: async () => {
            const r = await fsWrite(p, text, append ? 'append' : 'overwrite');
            return r.ok
              ? { ok: true, note: `已${append ? '追加到' : '写入'} ${r.data.path}（${r.data.bytes} 字节）` }
              : { ok: false, note: `没写成：${r.error}` };
          },
        },
      };
    }
    /* ⭐ 2026-09-29（用户实测踩到的坑）：助手**自己**要一个文件夹。
       他把桌面文件夹路径丢给助手 ⇒ 被白名单拦下 ⇒ 模型只会说「请确认路径是否正确」，
       他因此以为"这 AI 读写不了灵框外"。现在拦下来必须给这条出路：提一张卡片，他点一下就成了。
       三条纪律：① 永远 `needsConfirm: true`（放开白名单 = 扩大权限，和 set_mode 同一类：只有创作者点「应用」才算）；
       ② 卡片上明说这是灵框库外、默认只读；③ 落地走 `fsAddRoot()`，要可写再补一次 `fsSetRootWrite()`。 */
    case 'allow_folder': {
      const raw = str(a.path);
      if (!raw) return { ok: false, note: '要哪个文件夹？给我完整绝对路径（args.path）。' };
      /* ⚠️ 模型很可能递一个**文件**路径过来（它刚被 `read_file` 拦下）—— 而授权的粒度是**文件夹**，
         所以这里退到父目录，并在卡片上写明"交出来的是它所在的文件夹"（别让它以为只给了一个文件）。 */
      const looksFile = /[\\/][^\\/]*\.[a-z0-9]{1,8}$/i.test(raw);
      const p = looksFile ? (raw.replace(/[\\/][^\\/]*$/, '') || raw) : raw;
      const want = a.write === true || a.write === 1 || /^(true|1|yes)$/i.test(str(a.write));
      const known = fsRootOf(p);
      if (known) {
        return { ok: false, note: `「${known.label}」创作者早就交给你了（${known.write ? '可写' : '只读'}）—— 直接用 list_files / read_file${known.write ? ' / write_file' : ''} 就行，别再要一次。` };
      }
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `把文件夹交给助手：${baseName(p)}`,
          detail: `路径：${p}\n${looksFile ? `（你要的是文件「${baseName(raw)}」，助手授权的粒度是**文件夹** —— 交出来的是它所在的这个）\n` : ''}（**灵框库外**的文件夹 —— 交给我之后${want ? '**可写**：我能往里写，但每一次写仍然要你亲手点「应用」' : '**只读**：我能看，不能写'}；不点就不会加，随时能在助手的「文件夹」里撤掉）`,
          needsConfirm: true,
          apply: async () => {
            const r = await fsAddRoot(p);
            if (!r.ok) return { ok: false, note: `没加成：${r.error}` };
            const got = fsRootOf(p);   /* fsAddRoot 成功后模块缓存已更新 ⇒ 这里一定能认出来 */
            const label = got ? got.label : baseName(p);
            if (want && got) {
              const w = await fsSetRootWrite(got.path, true);
              if (!w.ok) return { ok: true, note: `已经把「${label}」（只读）交给助手了，但改成可写那步没成：${w.error}` };
            }
            return { ok: true, note: `已经把「${label}」交给助手了（${want ? '可写' : '只读'}）—— 现在可以让我看${want ? '、写' : ''}那个文件夹里的文件了` };
          },
        },
      };
    }
    /* ⭐ 新建世界 / 时间线（片 3 的另一半：「删除和创建」）。两层都用 `src/store/actions.ts` 的
       `addWorld` / `addTimeline` —— id 由 `uid('tl')` 生成、字段由 actions 补齐，这里不自己拼。 */
    case 'create_world': {
      const name = str(a.name);
      if (!name) return { ok: false, note: '新世界叫什么？（args.name）' };
      const exists = Object.prototype.hasOwnProperty.call(store.data.worldsets ?? {}, name);
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `新建世界：${name}${exists ? '（重名，会自动加序号）' : ''}`,
          detail: '会切到新世界。它是空的（还没有时间线）—— 接着可以 `create_timeline` 建一条，再往里建事件',
          apply: () => {
            const got = addWorld(store, name);
            return { ok: true, note: `已新建世界「${got}」${got === name ? '' : `（「${name}」重名了，实际叫这个）`}，现在就在这个世界里` };
          },
        },
      };
    }
    case 'create_timeline': {
      const name = str(a.name);
      if (!name) return { ok: false, note: '新时间线叫什么？（args.name）' };
      if (!ws) return { ok: false, note: '当前没有打开的世界 —— 先 `create_world` 建一个。' };
      const dup = (ws.order ?? []).map((id) => ws.timelines?.[id]).some((t) => !!t && t.name === name);
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `新建时间线：${name}${dup ? '（同名，会并存两条）' : ''}`,
          detail: `建在世界「${store.activeWorld}」上，是空的（还没有事件）`,
          apply: () => {
            addTimeline(store, name);
            return { ok: true, note: `已在世界「${store.activeWorld}」里新建时间线「${name}」（空的）` };
          },
        },
      };
    }
    /* ⭐ 删除（片 3，2026-10-12 用户原话：「你没给AI配置删除和创建的工具吗」—— 创建早有、删除一条都没有）。
       四条纪律：
       ① **一律走 `src/store/actions.ts`**（`removeEntity` / `removeNode` / `removeTimeline` / `removeWorld`）——
          那四个函数已经在做「store 移除 + vault 里的 .md 移进回收站」两件事。灵框是"文件为源"，
          只删内存不清文件的话，下次启动扫描会把东西**读回来**（删除等于没生效）。
       ② 找不到目标就**别动手**：把人话 + 候选名单写回去（模型下一轮能改对名字），不出卡片。
       ③ 创作者 2026-10-12 亲口选的安全档 = **「直接执行」档下删除直接生效**（不走 `needsConfirm`）；
          所以提示词里另加了一句纪律：只有他明说要删才删（见 `toolsPrompt()` 末段）。
       ④ 两条**兜底护栏**（不靠权限档，永远生效）：最后一个世界 / 最后一条时间线不删 ——
          删了灵框就空了，而 `removeWorld()` 还会顺手补一个空世界 ⇒ 创作者看到的是"数据全没了、界面却还是原样"。 */
    case 'delete_entity': {
      const name = str(a.name);
      if (!name) return { ok: false, note: '要删哪条设定？（args.name）' };
      const e = findEntity(ws, name);
      if (!e) {
        const names = Object.values(ws?.entities ?? {}).map((x) => x.name);
        return { ok: false, note: `没找到叫「${name}」的设定，**什么都没删**。${names.length ? '这个世界里有：' + names.slice(0, 20).join('、') + (names.length > 20 ? `…（共 ${names.length} 条）` : '') : '这个世界还没有设定条目。'}` };
      }
      const tn = typeName(ws, e);
      const id = e.id;
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `删除设定：${e.name}（${tn}）`,
          detail: `${fieldsLine(e, 6)}\n（它的 .md 会移进 vault 回收站 —— 「备份管理 → 回收站」里能恢复）`,
          apply: () => {
            removeEntity(store, id);
            return { ok: true, note: `已删除设定「${e.name}」（${tn}）—— .md 已移进 vault 回收站，能从「备份管理 → 回收站」恢复` };
          },
        },
      };
    }
    case 'delete_node': {
      const want = str(a.title);
      if (!want) return { ok: false, note: '要删哪个事件？（args.title；同名多个再给 args.year）' };
      const tl = ws?.timelines?.[store.activeTimeline];
      if (!tl) return { ok: false, note: '当前没有打开的时间线 —— 先在沙盘里选一条，我才知道删哪条线上的事件。' };
      /* ⚠️ 年份**没给**时不许当成 0 去过滤（`num('')` 恰好返回 0 —— 首跑就是被这个咬的：
         模型只说标题、不给年份 ⇒ `n.year === 0` 一条都对不上 ⇒ 明明有这个事件却说"没有叫…"）。
         判据看**原始字符串**：没写就 null（＝不过滤），写了才解析。 */
      const rawYear = str(a.year);
      const year = rawYear === '' ? null : num(a.year);
      const hits = tl.nodes
        .filter((n) => n.title === want || (want.length > 1 && n.title.includes(want)))
        .filter((n) => (year === null ? true : n.year === year));
      if (!hits.length) {
        const cands = tl.nodes.slice(0, 20).map((n) => `${n.year} ${n.title}`);
        return { ok: false, note: `时间线「${tl.name}」上没有叫「${want}」的事件，**什么都没删**。${cands.length ? '它上面有：' + cands.join('、') + (tl.nodes.length > 20 ? `…（共 ${tl.nodes.length} 个）` : '') : '它上面还没有事件。'}` };
      }
      if (hits.length > 1) {
        return { ok: false, note: `「${want}」在「${tl.name}」上能对上 ${hits.length} 个事件：${hits.map((n) => `${n.year} ${n.title}`).join('、')}。给我 args.year 指定删哪一个，我再动手。` };
      }
      const node = hits[0];
      const tlId = tl.id;
      const nodeId = node.id;
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `删除事件：${node.year} ${node.title}`,
          detail: `${node.kind ? node.kind + ' · ' : ''}${clip(node.desc ?? '', 120) || '（没有简述）'}\n（它的 .md 会移进 vault 回收站 —— 「备份管理 → 回收站」里能恢复）`,
          apply: () => {
            removeNode(store, tlId, nodeId);
            return { ok: true, note: `已删除事件「${node.title}」（${node.year} 年，在「${tl.name}」上）—— .md 已移进 vault 回收站，可恢复` };
          },
        },
      };
    }
    case 'delete_timeline':
    case 'delete_world': {
      const wholeWorld = call.tool === 'delete_world';
      const want = str(a.name);
      if (!want) return { ok: false, note: `要删${wholeWorld ? '哪个世界' : '哪条时间线'}？（args.name）` };
      if (wholeWorld) {
        const all = Object.keys(store.data.worldsets ?? {});
        const name = all.find((n) => n === want) ?? all.find((n) => n.toLowerCase() === want.toLowerCase());
        if (!name) return { ok: false, note: `没找到叫「${want}」的世界，**什么都没删**。${all.length ? '现有的世界：' + all.join('、') : ''}` };
        if (all.length <= 1) {
          /* ⭐ 拦下来必须给一条**出路**（同片 1.1 的不变量）：只说"我不做"，模型就会回去跟创作者说
             "请自己删"，绕一圈什么也没干。这里把下一步动作直接写成能照抄的 JSON。 */
          return { ok: false, note: `「${name}」是**唯一**的世界 —— 删了灵框就空了，这条我不做。`
            + `要真删它，先 {"tool":"create_world","args":{"name":"<新世界名>"}} 建一个新世界（有了第二个，它就不是唯一了，那时删得掉）；`
            + `或者请创作者自己在世界栏里删（那里会先问他一次）。` };
        }
        const tlCount = Object.keys(store.data.worldsets[name]?.timelines ?? {}).length;
        return {
          ok: true,
          proposal: {
            tool: call.tool,
            title: `删除世界：${name}`,
            detail: `整个世界（${tlCount} 条时间线 + 全部设定）的目录一起移进 vault 回收站 —— 「备份管理 → 回收站」里能恢复`,
            apply: () => {
              removeWorld(store, name);
              return { ok: true, note: `已删除世界「${name}」（连同 ${tlCount} 条时间线）—— 目录已移进 vault 回收站，可恢复` };
            },
          },
        };
      }
      const list = (ws?.order ?? []).map((id) => ws?.timelines?.[id]).filter((t): t is Timeline => !!t);
      const tl = list.find((t) => t.name === want) ?? list.find((t) => t.name.toLowerCase() === want.toLowerCase());
      if (!tl) return { ok: false, note: `这个世界里没有叫「${want}」的时间线，**什么都没删**。${list.length ? '它有的时间线：' + list.map((t) => t.name).join('、') : '这个世界还没有时间线。'}` };
      if (list.length <= 1) {
        return { ok: false, note: `「${tl.name}」是这个世界**唯一**的时间线 —— 删了沙盘就空了，这条我不做。`
          + `要真删它，先 {"tool":"create_timeline","args":{"name":"<新时间线名>"}} 再建一条（有了第二条，它就删得掉）；`
          + `或者请创作者自己在世界栏里删（那里会先问他一次）。` };
      }
      const tlId = tl.id;
      const nodeCount = tl.nodes.length;
      const loopCount = (tl.loops ?? []).length;
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `删除时间线：${tl.name}`,
          detail: `${nodeCount} 个事件${loopCount ? ` · ${loopCount} 个循环` : ''} —— 目录一起移进 vault 回收站（「备份管理 → 回收站」里能恢复）`,
          apply: () => {
            removeTimeline(store, tlId);
            return { ok: true, note: `已删除时间线「${tl.name}」（${nodeCount} 个事件）—— 目录已移进 vault 回收站，可恢复` };
          },
        },
      };
    }
    /* 灵框**外**的文件删（片 3）：走主进程 `shell.trashItem()` ⇒ Windows 回收站。
       三条前门：① 不在白名单里 ⇒ 拒绝 + 给出 allow_folder 那条出路；② 灵框库（vault）里 ⇒ 拒绝，
       让他改用 delete_entity / delete_node（那里 store 与 .md 一起动）；③ 只读目录 ⇒ 拒绝。 */
    case 'delete_file': {
      const p = str(a.path);
      if (!p) return { ok: false, note: '要删哪个文件？给我完整绝对路径（args.path）。' };
      const root = fsRootOf(p);
      if (!root) {
        const allowed = fsRootsCached().map((r) => r.path).join('、') || '（还没接过文件夹）';
        const dir = p.replace(/[\\/][^\\/]*$/, '') || p;
        return { ok: false, note: `「${p}」不在助手能碰的文件夹里（能碰的只有：${allowed}）。要删它得先提一个 allow_folder 动作（{"tool":"allow_folder","args":{"path":"${dir}","write":true}}）让创作者点一下把这个文件夹交给我 —— **不要**反复试同一个路径。` };
      }
      if (root.builtin) {
        return { ok: false, note: '灵框库（vault）里的文件**不能**用 delete_file 删 —— 那里"文件为源"，只删文件会让世界数据和文件对不上。要删设定用 delete_entity、删事件用 delete_node（它们会把 .md 移进 vault 回收站）。' };
      }
      if (!root.write) {
        return { ok: false, note: `「${root.label}」是**只读**的，删不了里面的东西。要删就提一个 allow_folder 动作（{"tool":"allow_folder","args":{"path":"${root.path}","write":true}}）让创作者点一下放开成可写。` };
      }
      return {
        ok: true,
        proposal: {
          tool: call.tool,
          title: `删除文件：${baseName(p)}`,
          detail: `路径：${p}\n（**灵框库外** —— ${root.label} · 可写；删掉是移进 **Windows 回收站**，能从那儿捞回来）`,
          apply: async () => {
            const r = await fsDelete(p);
            return r.ok
              ? { ok: true, note: `已把 ${r.data.path} 移进系统回收站（${fmtSize(r.data.bytes)}，可恢复）` }
              : { ok: false, note: `没删成：${r.error}` };
          },
        },
      };
    }
    default:
      return { ok: false, note: `不认识的动作：${call.tool}` };
  }
}
