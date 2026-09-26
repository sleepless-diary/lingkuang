/** AI 工具的**会话管理**（第 3.4 片）。
 *
 * 用户 2026-09-18 的原话：「**有会话管理的那种，选定一个主会话，其他会话可以作为角色或者不同视角，
 * 酒馆就是连接不同的会话，剧情推演就是加一个主控会话**」。
 * 两点已定：① 每个会话**各自一份独立历史**，「连接」= 把被连会话最近若干条拼进上下文（不是共享历史）；
 * ② 界面 = 左边一列会话列表（新建/重命名/删除/选中）+ 右边对话。
 *
 * 落盘 `%APPDATA%\lingkuang\agent\sessions.json`（**裸数组**，与 `chat.json` / `memory.json` 同款：
 * 创作者资产，要能手看、手改、备份），走 `preload.js` 的 `agentLoad()` / `agentSave({ sessions })`
 * —— `main.js` 的 `agent:save` 是「**给了才写**」，只带 sessions 的那次保存不会碰 chat/memory/activity。
 *
 * ⭐ 2026-09-26（用户：「其实我最开始的想法是主会话和助手指向的是同一个会话」）：
 *  `role:'main'` 那条**就是 Ctrl+K 的「灵框助手」**—— 同一份历史、同一个身份。助手不再有自己的
 *  `chat.json`（老文件只在首次迁进来一次，之后停写）。因此：
 *  ① 助手拿这条会话走 `mainSession()`；
 *  ② **落盘兜底**：助手的浮层可以在 AI 工具没挂载时用（那时 `sink` 还没被注入），所以 `persist()`
 *     在没有 sink 时自己写 —— 否则那些对话只活在内存里，一关就没。
 */
import { uid } from '../store/ids';
import type { ChatMsg } from './ai';

export type SessionRole = 'main' | 'character' | 'perspective' | 'director';

export interface AiSession {
  id: string;
  name: string;
  role: SessionRole;
  /** 人设 = **设定库里某一条实体**的 id。用户 2026-09-18：「**人设直接复用我们的角色系统，
   *  修改人设去设定库里面，会话直接选择人设进行聊天**」—— 这里只存指针（不存文本），
   *  每次发消息时从 store 现取 ⇒ 在设定库改了那条角色，会话里立刻生效。 */
  personaId?: string;
  /** 连着的会话 id：酒馆＝连接会话，剧情推演＝挂一个主控 */
  links?: string[];
  history: ChatMsg[];
  at: number;
  /** 已经被「自动起名」改过一次名（免得每轮都去问模型） */
  autoNamed?: boolean;
}

export const ROLE_LABEL: Record<SessionRole, string> = {
  main: '主会话',
  character: '角色',
  perspective: '视角',
  director: '主控',
};

const ROLES: SessionRole[] = ['main', 'character', 'perspective', 'director'];
/** 单个会话最多留多少条（历史是给「接着聊」用的，不是归档） */
export const HIST_MAX = 120;
/** 「连接」只带被连会话最近这么多条 —— 全带会把上下文撑爆，也会让主控盖过当前会话 */
export const LINK_TAIL = 8;

const api = (): any => (window as any).lingkuangAPI ?? {};

let list: AiSession[] = [];
let activeId = '';
let sink: ((sessions: AiSession[]) => void) | null = null;
let loadOnce: Promise<void> | null = null;

/** 落盘口子由 `src/ui/ai-workbench.ts` 注入（它和助手一样：写盘只有一个地方，各模块各持一份迟早写歪） */
export function setSessionSink(fn: ((sessions: AiSession[]) => void) | null): void {
  sink = fn;
}

/* ⚠️ 兜底写：助手浮层**不依赖 AI 工具挂载**（`sink` 由 `src/ui/ai-workbench.ts` 在
   renderAiWorkbench 里注入），没注入时自己写。节流 400ms —— 与 AI 页那份节流同一个量级。 */
let saveTimer = 0;
function persist(): void {
  if (sink) {
    try { sink(list); } catch { /* 落盘失败不该打断聊天 */ }
    return;
  }
  try {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { void api().agentSave?.({ sessions: list }); }, 400);
  } catch { /* 落盘失败不该打断聊天 */ }
}

function isRole(x: unknown): x is SessionRole {
  return typeof x === 'string' && (ROLES as string[]).indexOf(x) >= 0;
}

function normMsg(m: any): ChatMsg | null {
  if (!m || typeof m.content !== 'string') return null;
  const role = m.role === 'user' || m.role === 'assistant' || m.role === 'system' ? m.role : 'assistant';
  /* ⚠️ 分割线（`div:true`）必须一起读回来：它现在是**助手与 AI 页共用**的那条会话里的界碑，
     丢了就等于助手的「分割上下文」白做（助手那边老代码也单独守过这一点）。 */
  if (m.div === true) return { role: 'system', content: '', div: true } as ChatMsg;
  return { role, content: m.content } as ChatMsg;
}

/** 磁盘 → 内存。空（第一次用 / 文件被删）就建一个「主会话」：用户第一眼得看到能打字的地方 */
export function adoptSessions(raw: unknown): void {
  const arr = Array.isArray(raw) ? raw : [];
  list = arr
    .filter((x: any) => x && typeof x.id === 'string' && typeof x.name === 'string')
    .map((x: any): AiSession => ({
      id: x.id,
      name: x.name,
      role: isRole(x.role) ? x.role : 'character',
      personaId: typeof x.personaId === 'string' ? x.personaId : '',
      links: Array.isArray(x.links) ? x.links.filter((y: unknown) => typeof y === 'string') : [],
      history: Array.isArray(x.history) ? (x.history.map(normMsg).filter(Boolean) as ChatMsg[]) : [],
      at: typeof x.at === 'number' ? x.at : Date.now(),
      autoNamed: x.autoNamed === true,
    }));
  if (!list.some((s) => s.role === 'main')) {
    list.unshift({ id: uid('s'), name: '主会话', role: 'main', personaId: '', links: [], history: [], at: Date.now() });
  }
  if (!list.some((s) => s.id === activeId)) activeId = list[0].id;
}

/** 广播「这格会话的历史变了」：助手（Ctrl+K 浮层）与 AI 页各挂一个监听，把「同一格会话」落到
 *  **屏幕上** —— 只共享数据、屏幕不跟，创作者会以为两边是两格。用 window 事件而不是互相 import：
 *  两个模块谁都不该依赖对方的渲染函数。 */
function announce(): void {
  try { window.dispatchEvent(new CustomEvent('lingkuang-sessions')); } catch { /* 没有 window 就算了 */ }
}

/** 懒加载一次（AI 工具第一次打开时调；重复调用共享同一个 promise） */
export function ensureSessionsLoaded(): Promise<void> {
  if (!loadOnce) {
    loadOnce = (async () => {
      try {
        const r = await api().agentLoad?.();
        adoptSessions(r && r.sessions);
      } catch {
        adoptSessions([]);
      }
    })();
  }
  return loadOnce;
}

/** 改了会话自己的字段（名字以外，比如 persona）之后要落盘时手动调一次 */
export function persistSessions(): void { persist(); }

export function listSessions(): AiSession[] { return list; }

/** `role:'main'` 那条 = **Ctrl+K 的灵框助手**用的那一条（`adoptSessions` 保证它一定存在） */
export function mainSession(): AiSession | null {
  return list.find((s) => s.role === 'main') ?? null;
}

export function activeSession(): AiSession | null {
  return list.find((s) => s.id === activeId) ?? list[0] ?? null;
}

export function setActiveSession(id: string): void {
  if (!list.some((s) => s.id === id)) return;
  activeId = id;
}

export function createSession(name: string, role: SessionRole = 'character', personaId = ''): AiSession {
  const s: AiSession = { id: uid('s'), name: name.trim() || '新会话', role, personaId, links: [], history: [], at: Date.now() };
  list.push(s);
  activeId = s.id;
  persist();
  return s;
}

/** 给会话选人设（人设本体在设定库里，这里只记 id）。
 *  用户 2026-09-18：「**启用人设的会话名就是该人名**」⇒ 选上人设就把会话名改成那条角色的名字；
 *  取消人设（personaId 空）时名字不回滚（已经是人话了，别把人家名字抹了）。 */
export function setSessionPersona(id: string, personaId: string, personaName = ''): void {
  const s = list.find((x) => x.id === id);
  if (!s) return;
  const changed = (s.personaId ?? '') !== personaId || (!!personaName && s.name !== personaName);
  if (!changed) return;
  s.personaId = personaId;
  if (personaId && personaName) { s.name = personaName; s.autoNamed = false; }
  s.at = Date.now();
  persist();
}

/** 自动起名用：把这条会话标成「已自动起过名」（不再重复问模型） */
export function markAutoNamed(id: string): void {
  const s = list.find((x) => x.id === id);
  if (!s || s.autoNamed) return;
  s.autoNamed = true;
  persist();
}

export function renameSession(id: string, name: string): void {
  const s = list.find((x) => x.id === id);
  if (!s) return;
  const next = name.trim();
  if (!next || next === s.name) return;
  s.name = next;
  s.at = Date.now();
  persist();
}

export function removeSession(id: string): void {
  const s = list.find((x) => x.id === id);
  /* 主会话是「总在那儿」的那一格：删了会让人无处落笔，也断了所有连接 */
  if (!s || s.role === 'main') return;
  list = list.filter((x) => x.id !== id);
  for (const other of list) if (other.links && other.links.length) other.links = other.links.filter((l) => l !== id);
  if (activeId === id) activeId = list[0]?.id ?? '';
  persist();
}

export function isLinked(id: string): boolean {
  const s = activeSession();
  return !!s && !!s.links && s.links.indexOf(id) >= 0;
}

/** 把另一个会话连进当前会话 / 断开（酒馆＝连角色会话，剧情推演＝连一个主控） */
export function toggleLink(id: string): boolean {
  const s = activeSession();
  if (!s || s.id === id) return false;
  const links = s.links ?? (s.links = []);
  const i = links.indexOf(id);
  if (i >= 0) links.splice(i, 1);
  else links.push(id);
  s.at = Date.now();
  persist();
  return i < 0;
}

export function linkedSessions(s: AiSession = activeSession() as AiSession): AiSession[] {
  if (!s || !s.links || !s.links.length) return [];
  return s.links.map((id) => list.find((x) => x.id === id)).filter(Boolean) as AiSession[];
}

export function pushMsg(id: string, m: ChatMsg): void {
  const s = list.find((x) => x.id === id);
  if (!s) return;
  s.history.push(m);
  if (s.history.length > HIST_MAX) s.history.splice(0, s.history.length - HIST_MAX);
  s.at = Date.now();
  persist();
  announce();
}

export function clearHistory(id: string): void {
  const s = list.find((x) => x.id === id);
  if (!s || !s.history.length) return;
  /* ⚠️ 必须**原地清空**而不是换一个数组：助手模块把 `history` 指针接到了这个数组上
     （`src/ui/agent.ts` 的 pushHistory），换数组会让它继续往一串没人看的旧数据里写。 */
  s.history.length = 0;
  s.at = Date.now();
  persist();
  announce();
}

/** 生成这个会话的系统提示：角色设定 + 连着谁（只带尾巴，标明「这是别的会话说的」） */
export function sessionPrompt(s: AiSession | null = activeSession(), personaText = ''): string {
  if (!s) return '';
  const parts: string[] = [];
  /* ⚠️ 2026-09-18 用户实测反馈：「**你是不是给主会话加提示词了，这个 ai 有明显倾向**」——
     所以主会话**一句人设都不加**（原来那句「他在写世界观，你直接帮他」正是倾向的来源）。
     其余角色也只说「你在扮演谁」，人设正文一律来自设定库（`personaText` 由界面现取）。 */
  /* ⭐ 用户 2026-09-18 复看：「**为什么不选人设也是这样子**」—— 原来**不选人设也照样发一句
     「你扮演下面这条角色。」**（后面什么都没有），那等于明确邀请模型自己编一个人设
     （qwen3:14b 当场就长出「紫色烟雾里的星辰旅人」那一套）。现在**没有人设就一句角色框架都不发**。 */
  if (personaText) {
    if (s.role === 'director') parts.push('你是这次会话的主控，负责调度剧情走向。');
    else if (s.role === 'character') parts.push('你扮演下面这条角色。');
    else if (s.role === 'perspective') parts.push('你从下面这个视角说话。');
    parts.push(personaText);
  } else {
    /* 没选人设 = 普通聊天。模型自己爱演（那是它的训练倾向），这里给一条反向约束；
       想让它自由发挥就把这行删掉。 */
    parts.push('这次会话没有指定人设：按普通写作助手回答，不要扮演角色、不要写旁白或动作描写。');
  }
  for (const l of linkedSessions(s)) {
    const tail = l.history.slice(-LINK_TAIL);
    if (!tail.length) continue;
    const text = tail.map((m) => `${m.role === 'user' ? '创作者' : '对方'}：${m.content.slice(0, 200)}`).join('\n');
    parts.push(`【连着的会话：${l.name}（${ROLE_LABEL[l.role]}）】最近 ${tail.length} 条，旧 → 新：\n${text}`);
  }
  return parts.join('\n\n');
}

/** 会话的基础设定（用户 2026-09-18：「在专门的对话窗口 ai 说它没有可以调用的工具，也不知道灵框」）——
 *  以前 AI 工具的会话只拿到人设，连自己在哪个应用里都不知道。这段补上身份与工作区事实；
 *  真正的**动作协议**仍只在 Ctrl+K 的灵框助手里（那边才有 handler），这里不吹能力。 */
export const AI_SESSION_FRAME = [
  '你在「灵框 LingKuang」里：一个世界观创作工作台（Electron 桌面应用）。',
  '它的数据是一层层套的：世界 → 时间线（时间线上是事件节点）＋ 设定库（角色 / 地点 / 物品 / 组织 …）。',
  '设定与事件都会同步写进 vault 目录下的 Markdown 文件（_设定/<类型>/<名字>.md）。',
  '你能看到创作者当前的工作区现状（世界、时间线、设定清单、他正在编的那一条）。',
  '你没有联网能力。要改数据（新建/改字段/写正文）时，把改法说清楚让他确认 —— 真正能落盘的写动作目前只在 Ctrl+K 的「灵框助手」里开放。',
].join('');
/** 给界面用的一句话：「连了谁」 */
export function linkSummary(s: AiSession | null = activeSession()): string {
  const linked = s ? linkedSessions(s) : [];
  return linked.length ? '连着：' + linked.map((l) => l.name).join('、') : '没连别的会话';
}
