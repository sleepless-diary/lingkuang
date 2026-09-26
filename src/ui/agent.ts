/** 灵框 · 助手面板（Ctrl+K 呼出 / 左栏「助手」按钮）。
 *
 *  形态：**右侧停靠**，不是设置那种全屏遮罩 —— 用户的原话是「主要工作还是在灵框内」，
 *  聊天时要能一边看着设定与正文改（遮罩会把主区盖住、点不动）。
 *
 *  它在 `src/tools/register.ts` 里登记为 `panel: true` 的工具，所以**完全不碰主区**
 *  （`openTool` 的面板分支不清 host、不建 `.lk-tool-slot`、不播错峰）。
 *  注意 `registry.ts` 只有**一格** `disposePanel`：设置与助手同一时刻只能开一个。
 *
 *  片 1：对话框 + 上下文注入 + 对话历史落盘 + Ctrl+K。
 *  片 2：长期记忆（可见可改可总结）+ 三档权限骨架（`src/ui/agent-perm.ts`）。
 *  片 3：工具协议（文本 JSON 指令）+ 提议卡片 —— 那时才真正会改稿子。
 *  片 4（本片）：**两种模式**（`src/ui/agent-mode.ts`）—— 用户 2026-09-26：
 *    「平常是正常的聊天及工作，但是少数情况下有 agent 工作能力」⇒ 面板默认 `chat`
 *    （系统提示里没有动作协议、回复也不解析动作），显式切到 `agent` 才拿到工具与权限闸门。
 */
import { type ChatMsg } from './ai';
import { agentAsk } from './agent-model';
import { liveBubble, liveThink, thinkBlockHtml, type LiveBubble, type LiveThink } from './chat-live';
import { mdToHtml } from './md';
import { buildContext, getAgentFocus, isAgentFocusLive } from './agent-context';
import { agentActing, loadActivity, recentActivity } from './agent-activity';
import { HIST_MAX, adoptSessions, ensureSessionsLoaded, mainSession, persistSessions, pushMsg } from './ai-sessions';
import {
  addMemory, adoptFromDisk, getMemory, memoryPrompt, removeMemory,
  setMemorySink, summarizePrefs, updateMemory,
} from './agent-memory';
import { MODE_HINT, MODE_LABEL, MODES, modePrompt, type AgentMode } from './agent-mode';
import { ASKS, ASK_LABEL, SCOPES, SCOPE_LABEL, gateWrite, getAgentAsk, getAgentScope, permHint, permName, permissionPrompt, setAgentAsk, setAgentScope } from './agent-perm';
import { isWriteTool, looksLikeToolJson, parseToolCall, planWrite, runReadTool, toolsPrompt, type Proposal, type ToolCall } from './agent-tools';
import { motionReduced } from './motion';
import { isImeEnter } from './keys';
import { escapeHtml } from './html';
import { activeProviderProfile, type AgentAsk, type AgentScope } from './settings';
import { providerSummary } from './ai-providers';
import type { Store } from '../store/store';

const PANEL_ID = 'lk-agent-panel';
/** 送给模型的历史条数上限（再往前的靠「上下文」与长期记忆，不靠堆对话） */
const HISTORY_SEND = 16;

const SYS_HEAD = [
  '你是「灵框」里的创作助手。灵框是世界观创作工作台：创作者在里面管理世界观、时间线事件、设定条目（角色/地点/物品/组织等）。',
  '工作方式：',
  '1. 用中文回答，简明扼要（默认 3-6 句；创作者说「展开」再展开）。',
  '2. 只依据下面「工作区现状」里给出的信息；没有的就直说没有、并指出可以去哪里补，不要编造设定。',
  '3. 提到设定时优先用现状里的原名与年份，别改名。',
  '4. 沿用下面「创作者偏好」里的习惯（如果有）。',
  '5. 创作者说「这个 / 这条 / 当前 / 我现在打开的文件 / 这个面板」时，指的就是现状里【创作者此刻打开的那一条】；' +
    '回答要**点名那一条**（名字 + 它是什么），问文件就报它那一行「文件：」的路径。' +
    '若那一栏写着「没有」，就一句话问他是哪一条（能从【他最近做过的事】里挑出候选，就点名问「是刚改的「X」吗」）：' +
    '别拿世界名、时间线名糊弄，**更不要解释你看不到什么 / 你没有选中任何条目**。' +
    /* 用户 2026-09-18 实测：助手被纠正「你看错了，不是这个界面」之后，仍连着两轮答「你正在看 XX」——
       根因是上下文里只有「最近打开过的那一条」，没有任何「他此刻在哪个界面」的信息。 */
    '先看现状里【创作者此刻在哪】那一行写的界面名 —— 那才是他现在人在的地方。' +
    '若焦点那一栏写的是【创作者最近打开过的那一条】，说明**他已经切走了**：不许说「你正在看 / 你还停留在这一条」，' +
    '要么按【创作者此刻在哪】回答，要么一句话问他现在指的是哪一条（同样别解释你「看不到」）。',
  /* 用户 2026-09-18 实测：改完之后「修改结果」和「下一句回答」一起冒出来 ——
     根因是模型把动作回执的汇报与下一个问题的答案写进了同一条回复（回执与他的新提问都是 user 消息，一轮里全答了）。
     界面已经把回执单独画成一块，模型再复述一遍纯属重复。 */
  '6. 【动作结果：…】是**你自己动作的系统回执**，界面上已经单独显示了那块结果 —— 不要为它写汇报、' +
    '也不要复述改成了什么；创作者紧接着问别的就直接答那件事，别把回执的汇报和那个答案混在同一条回复里。',
  /* 用户 2026-09-18：「能不能让这个 ai 能读到我的过去操作行为」 */
  '7. 现状里若有【他最近做过的事】，那是**创作者自己动手改的**操作流水（不是你干的；' +
    '标着「灵框助手代劳」的才是你干的）。可以用它回答「我刚才改了什么」「我改到哪一步了」，' +
    '别问他做过的事（现状里就有），也别把那些改动说成是你做的。',
].join('\n');

/** 助手这一次对话的**系统提示**（AI 页的「主会话」也用这一份 —— 两处入口是同一格会话，
 *  提示词不能有两副面孔）。⭐ 2026-09-26 用户改口后**两个模式都有灵框内部的动作**，所以
 *  `tools = true` 时动作协议与权限段照注入；两个模式的差别在自主程度（见 `modePrompt()`）。
 *  ⚠️ `tools = false` 现在只有一处用途：**AI 页的主会话**在"提议卡片搬过去"之前还没有
 *  卡片 UI —— 喂了协议它就会吐动作 JSON 而没人执行。那份 UI 补上后这里应当一律传 true。 */
export function agentSystemPrompt(st: Store, m: AgentMode = mode, tools = true): string {
  return [
    SYS_HEAD,
    modePrompt(m),
    ...(tools ? [permissionPrompt(), toolsPrompt(m)] : []),
    memoryPrompt(),
    '【工作区现状】\n' + buildContext(st),
  ].filter(Boolean).join('\n\n');
}

let openEl: HTMLElement | null = null;
let store: Store | null = null;
let disposeAll: (() => void) | null = null;
/* ⭐ 2026-09-26（用户：「其实我最开始的想法是主会话和助手指向的是同一个会话」）：
   这条历史**就是主会话（`role:'main'`）的历史** —— 助手不再有自己的 `chat.json`。
   `ensureLoaded()` 把指针接到 `mainSession().history`，写入一律走 `pushHistory()`。 */
let history: ChatMsg[] = [];

/** 主会话的历史数组 —— ⚠️ **读它一律走这里，别直接读模块变量**：会话对象会被
 *  `adoptSessions()`（重读磁盘）整体重建 ⇒ 数组换了新对象，缓存的那份就成了"另一个世界"。
 *  2C 实测踩到：AI 页在主会话里写了 2 条（磁盘/界面都 8 条），助手浮层重开却只画得出 6 条
 *  —— 因为浮层手里还攥着重读之前那个数组。 */
function hist(): ChatMsg[] {
  const m = mainSession();
  if (m && m.history !== history) history = m.history;
  return history;
}
let loaded = false;
let busy = false;
/* 模型不吐思考时，只在**本次运行**里说明一次（用户 2026-09-26 问「还是看不到思考链」——
   真因是他在用的 qwen2.5:7b 根本不吐 thinking 字段，而界面上一点痕迹都没有）。 */
let noThinkHinted = false;
/** 当前模式（⭐ 两个模式**都有**灵框内部的动作 —— 差别在自主程度：`chat` 一次只做一个动作，
 *  `agent` 可以连着走多步。见 `src/ui/agent-mode.ts` 顶部说明）。
 *  ⚠️ **面板会话态、不落盘**：每次打开都从 `chat` 开始。 */
let mode: AgentMode = 'chat';
/* AI 的 `set_mode` 动作（`src/ui/agent-tools.ts` 的 planWrite）不能直接改这个模块变量
   （会成 import 环），它广播事件、这里收 —— 与 `lingkuang-agent-perm` / `lingkuang-sessions`
   同一套做法。面板开着就顺手重画那两段按钮与说明。 */
window.addEventListener('lingkuang-agent-mode', (e) => {
  const m = (e as CustomEvent).detail?.mode;
  if (m !== 'chat' && m !== 'agent') return;
  /* ⭐ 2C：写入口只有一个 —— `setAgentMode()`（自带 `if (mode === next) return;` 守卫，
     写状态 + 重画 + 再派发同一个事件 ⇒ 那一次必然早退，不成环）。 */
  setAgentMode(m);
});
/** 「＋ 手动加一条」点了之后，列表里多出一行空输入框等着填 */
let draft = false;

/* 动作（片 3）：一次提问里最多连着几轮模型调用（模型看结果 → 再决定），
   防它在「列设定 → 再看一条 → 再列」里打转。
   ⭐ 2026-09-26 用户拍板：两个模式的差别就在这儿 —— 聊天**一次只做一个动作**
   （1 轮动作 + 1 轮答话），Agent 可以连着走多步。
   `cards` = 这次会话里还没处理的提议卡片。 */
const CHAT_ROUNDS = 1;
const AGENT_ROUNDS = 8;
/* 模型把动作格式写歪时，用它回头纠正一次（只一次） */
const FIX_NOTE =
  '【格式提醒】你上一条不是合法的动作调用（我认不出来）。要动用动作，请整条回复只写一行：' +
  '{"tool":"动作名","args":{…}} —— 键名必须是 tool 与 args，例如 ' +
  '{"tool":"set_field","args":{"entity":"霜精灵","field":"描述","value":"…"}}。' +
  '不要写成 {"动作名":{…}} 这种形状，也不要写成 {"name":…,"arguments":…}。' +
  '如果只是想聊天，就直接说人话，别写 JSON。';
let cards: { p: Proposal; done?: string; ignored?: boolean }[] = [];

const api = (): any => (window as any).lingkuangAPI;

export function isAgentPanelOpen(): boolean {
  return !!openEl && document.body.contains(openEl);
}

/* ── 落盘（主进程 `agent:load` / `agent:save`；放文件不放 localStorage：
      这是创作者资产，要能备份、能查看、能手改）。
      ⚠️ `agent:save` 是**整包写**：chat 与 memory 一起给，所以记忆的落盘也走这里。 ── */
/** 会话里的**上下文分割线**（用户 2026-09-18：「加一个分割上下文的功能，可分开之前的上下文但是保留系统提示词和记忆」）。
 *  它自己不是消息，只是「从这里往上不再发给模型」的界碑；落盘存成 { role:'system', content:'', div:true }
 *  —— chat.json 仍是裸数组、能手看手改，渲染时画成一条虚线。 */
type AgentMsg = ChatMsg & { div?: boolean };

/** 最后一条分割线**之后**的下标（没有分割线 = 0）。渲染与发送**共用它**，免得两处算法漂移。 */
export function cutIndex(list: ChatMsg[]): number {
  let at = 0;
  list.forEach((m, i) => { if ((m as AgentMsg).div === true) at = i + 1; });
  return at;
}

/** 真正发给模型的历史：分割线之上只留在文件里给人看。系统提示词与长期记忆不受影响（每次现拼）。 */
export function sentHistory(list: ChatMsg[], max = HISTORY_SEND): ChatMsg[] {
  return list.slice(cutIndex(list)).slice(-max);
}

/** 分割 / 重新接上（按钮在面板头上；「重新接上」在分割线本身上 —— 鼠标移上去才出现那个叉） */
let lastActionAt = 0;

/** 往**主会话**的历史里塞一条并落盘（助手与 AI 页共用这一份历史，所以一律走它）。
 *  ⚠️ 不能直接 `history.push`：只有 `pushMsg` 会裁剪 HIST_MAX、并触发 `ai-sessions` 的落盘。 */
function pushHistory(m: ChatMsg): void {
  const s = mainSession();
  if (!s) return;
  pushMsg(s.id, m);
  history = s.history;
}

function splitContext(): void {
  if (Date.now() - lastActionAt < 350) return;
  lastActionAt = Date.now();
  const h = hist();
  if (!h.length) { setNote('还没有对话，不用分割'); return; }
  const above = h.length;
  pushHistory({ role: 'system', content: '', div: true });
  setNote('已分割：上面 ' + above + ' 条不再发给模型；想接回来，把鼠标放到那条线上点叉');
  persist();
  renderMsgs();
}

/** 重新接上这段上下文 = 摘掉分割线（用户 2026-09-18：「取消分割可以做在线旁边，
 *  鼠标悬浮在线上时显示一个叉，按下就能重新连接上下文」） */
function unsplitContext(): void {
  if (Date.now() - lastActionAt < 350) return;
  lastActionAt = Date.now();
  const h = hist();
  for (let i = h.length - 1; i >= 0; i--) {
    if ((h[i] as AgentMsg).div === true) { h.splice(i, 1); break; }
  }
  setNote('已重新接上：上面那些对话又回到上下文里了');
  persistSessions();
  renderMsgs();
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    /* ⭐ 先保证会话（主会话）在内存里，再把历史指针接过去 —— 助手可以比 AI 工具先开（Ctrl+K 浮层），
       那时 `ai-sessions` 的落盘口子还没被 AI 页注入，所以它自带兜底写。 */
    await ensureSessionsLoaded();
    let main = mainSession();
    if (!main) { adoptSessions([]); main = mainSession(); }
    history = main?.history ?? [];
    const r = await api()?.agentLoad?.();
    /* ⭐ 一次性迁移：老版本助手的历史住在 `agent/chat.json`（`r.chat`）。**只有主会话还空着**时才并
       进来 —— 迁过一次之后主会话非空，就不会重复追加；老文件留着不动（创作者资产，要能备份）。 */
    if (r?.ok && Array.isArray(r.chat) && main && !main.history.length) {
      const old = r.chat
        .filter((m: any) => m && typeof m.content === 'string' && (m.div === true || m.role === 'user' || m.role === 'assistant'))
        .map((m: any) => (m.div === true ? ({ role: 'system', content: '', div: true } as ChatMsg) : ({ role: m.role, content: m.content } as ChatMsg)));
      if (old.length) {
        main.history = old.slice(-HIST_MAX);
        history = main.history;
        persistSessions();
      }
    }
    if (r?.ok) adoptFromDisk(r.memory);
    if (r?.ok) loadActivity(r.activity);
  } catch {
    /* 读不到就从空开始，不挡对话 */
  }
}

function persist(): void {
  try {
    /* ⚠️ 不再写 chat：对话归**会话**所有（`pushHistory` → `ai-sessions` 的落盘口子），
       这里只剩长期记忆与操作流水；`agent:save` 是「给了才写」，不带 chat 就不会碰老文件。 */
    void api()?.agentSave?.({ memory: getMemory(), activity: recentActivity() });
  } catch {
    /* 落盘失败不该影响这一次对话 */
  }
}

/* ── 渲染 ─────────────────────────────────────────────────────────── */
/* 动作的调用与结果都是**对话的一部分**（要喂回模型），但显示上不能混成聊天气泡：
   调用显示成一行「用到动作」，结果显示成一小块说明。 */
export const RESULT_RE = /^【动作结果：([^】]+)】/;

function isCallMsg(m: ChatMsg): boolean {
  /* ⭐ 两个模式都把动作消息画成「用到动作」那一行（2026-09-26 用户改口：聊天模式也留内部工具）。
     旧版按 mode 短路是片 4 的规矩（那时 chat 零工具）；现在 chat 也会真执行动作，
     再短路就会把**已经执行过的**动作画成一段 JSON 文字 —— 创作者以为没发生，其实已经改完了。 */
  return m.role === 'assistant' && parseToolCall(m.content) !== null;
}

function msgHtml(m: ChatMsg): string {
  if (isCallMsg(m)) {
    const call = parseToolCall(m.content);
    return `<div class="lk-agent__call">用到动作：${escapeHtml(call?.tool ?? '?')}</div>`;
  }
  if (m.role === 'user') {
    const mm = RESULT_RE.exec(m.content);
    if (mm) {
      return (
        `<div class="lk-agent__tool"><div class="lk-agent__tool-h">${escapeHtml(mm[1])}</div>` +
        `<pre>${escapeHtml(m.content.slice(mm[0].length).trim())}</pre></div>`
      );
    }
  }
  const who = m.role === 'user' ? 'is-user' : 'is-ai';
  /* AI 那边过一遍极简 markdown（用户 2026-09-26：「ai 的回答没被渲染，如 **文字** 这种」）；
     创作者自己打的字照旧当纯文本 —— 他写 `**` 就是想看见两个星号。 */
  const body = m.role === 'user' ? escapeHtml(m.content) : mdToHtml(m.content);
  /* 这一条当时想过来的过程（用户 2026-09-26「看不到他的思考诶」）：折叠一块，排在正文**上面** ——
     读的顺序上思考先于回答。`.lk-agent__cutwrap` 是普通块容器，两块天然上下排。 */
  const think = m.role === 'assistant' && m.reasoning ? thinkBlockHtml(m.reasoning) : '';
  return think + `<div class="lk-agent__msg ${who}"><div class="lk-agent__bubble${m.role === 'user' ? '' : ' lk-md'}">${body}</div></div>`;
}

/* 提议卡片：写入动作不直接落盘，先在这里等创作者点头（`应用` / `忽略`） */
function cardHtml(i: number, c: { p: Proposal; done?: string; ignored?: boolean }): string {
  const settled = c.done || c.ignored;
  const acts = settled
    ? ''
    : `<div class="lk-agent__prop-acts">` +
        `<button class="lk-agent__prop-btn is-primary" data-prop-ok="${i}">应用</button>` +
        `<button class="lk-agent__prop-btn" data-prop-no="${i}">忽略</button>` +
      `</div>`;
  const state = c.done
    ? `<div class="lk-agent__prop-note">${escapeHtml(c.done)}</div>`
    : c.ignored
      ? '<div class="lk-agent__prop-note">已忽略</div>'
      : '';
  return (
    `<div class="lk-agent__prop${settled ? ' is-settled' : ''}" data-prop="${i}">` +
      `<div class="lk-agent__prop-h">${escapeHtml(c.p.title)}</div>` +
      `<div class="lk-agent__prop-d">${escapeHtml(c.p.detail)}</div>` +
      acts +
      state +
    `</div>`
  );
}

/** 提议卡片的 HTML —— **两个入口共用**（助手浮层的消息区、AI 页主会话的记录区都调它）。
 *  卡片索引就是 `cards` 的下标 ⇒ 两个入口画出来的 `data-prop-ok="i"` 指向同一张卡片。 */
export function cardsHtml(): string {
  return cards.map((c, i) => cardHtml(i, c)).join('');
}

/** 「用到动作：X」那一行 —— **AI 页主会话也要画它**（否则模型吐的动作 JSON 会被 mdToHtml
 *  当成一段普通文字糊到创作者脸上，而动作其实已经执行了）。返回 null = 这条不是动作消息。 */
export function agentCallRow(m: ChatMsg): string | null {
  if (!isCallMsg(m)) return null;
  const call = parseToolCall(m.content);
  return '<div data-k="call" style="max-width:78%;font-size:12px;color:var(--accent);background:var(--surface-2);' +
    'border:1px solid var(--border-strong);border-radius:var(--radius-sm);padding:5px 9px;">' +
    '用到动作：' + escapeHtml(call?.tool ?? '?') + '</div>';
}

function renderMsgs(): void {
  const box = openEl?.querySelector('#lk-agent-msgs');
  if (!box) return;
  const h = hist();
  const cut = cutIndex(h);
  const head = h.length
    ? h
        .map((m, i) => {
          if ((m as AgentMsg).div === true) {
            return (
                            '<div class="lk-agent__cut">上下文分割：以上 ' + i +
              ' 条不再发给模型（系统提示词与长期记忆照常）' +
              '<button class="lk-agent__cut-x" data-cut-x="1" title="重新接上这段上下文（上面的对话又发给模型）">×</button>' +
              '</div>'
            );
          }
          return `<div class="lk-agent__cutwrap${i < cut ? ' is-cut' : ''}">${msgHtml(m)}</div>`;
        })
        .join('')
    : '<div class="lk-agent__empty">问点什么吧。比如「这条时间线的冲突还缺什么」「帮我把正在编的那条设定写细一点」。</div>';
  box.innerHTML = head + cardsHtml();
  box.scrollTop = box.scrollHeight;
  /* 分割按钮的文案在这里同步；**接线只接一次** —— 挂在面板根上做事件委托，
     逐个按钮绑会在整块重画时重复接（一次点击跑两遍 = 分割当场被自己撤销）。 */
  const btn = openEl?.querySelector('#lk-agent-split') as HTMLButtonElement | null;
  if (btn) btn.textContent = '分割上下文';
  if (openEl && openEl.dataset.splitBound !== '1') {
    openEl.dataset.splitBound = '1';
    openEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.id === 'lk-agent-split') splitContext();
      else if (target.dataset.cutX === '1') unsplitContext();
    });
  }
}

function renderMeta(): void {
  if (!openEl) return;
  const chip = openEl.querySelector('#lk-agent-model');
  if (chip) chip.textContent = providerSummary(activeProviderProfile());
  const f = getAgentFocus();
  const fchip = openEl.querySelector('#lk-agent-focus');
  if (fchip) {
    /* 三态：正在编（工作台在屏幕上）／最近在看（切到别的工具去了，焦点留着降级）／没打开条目 */
    fchip.textContent = !f
      ? '没打开条目'
      : isAgentFocusLive()
        ? (f.kind === 'entity' ? `正在编：${f.title}` : `正在编事件：${f.title}`)
        : `最近在看：${f.title}`;
    fchip.classList.toggle('is-stale', !!f && !isAgentFocusLive());
  }
}

function renderCtx(): void {
  const pre = openEl?.querySelector('#lk-agent-ctx');
  if (!pre || !store) return;
  pre.textContent = buildContext(store);
}

/* 记忆区：一块 `<details>` + 若干可改的条目。用**事件委托**（列表会整体重画，
   逐个绑监听会随重画丢）——改完失焦即存盘，× 即忘掉。 */
function memRowHtml(id: string, text: string, src: string): string {
  const mem = id ? ` data-mem-id="${escapeHtml(id)}"` : '';
  return (
    `<div class="lk-agent__mem-item"${mem} data-src="${escapeHtml(src)}">` +
      `<input class="lk-agent__mem-input" value="${escapeHtml(text)}" placeholder="比如：人名偏好两三个字" />` +
      (id ? '<button class="lk-agent__mem-x" data-mem-del="' + escapeHtml(id) + '" title="忘掉这一条">×</button>' : '') +
    '</div>'
  );
}

function renderMemory(): void {
  const list = openEl?.querySelector('#lk-agent-mem-list');
  if (!list) return;
  const mem = getMemory();
  const sum = openEl?.querySelector('#lk-agent-mem-summary');
  if (sum) sum.textContent = `长期记忆（${mem.length} 条偏好）`;
  const html = mem.map((it) => memRowHtml(it.id, it.text, it.src)).join('') + (draft ? memRowHtml('', '', 'manual') : '');
  list.innerHTML = html || '<div class="lk-agent__mem-empty">还没记住什么。聊几轮后点「从对话里总结」，或者手动加一条。</div>';
  if (draft) list.querySelector<HTMLInputElement>('.lk-agent__mem-item:last-child .lk-agent__mem-input')?.focus();
}

/* 权限：两个**正交**旋钮（范围 × 询问，`src/ui/agent-perm.ts`），选了就存进设置
   （`lingkuang-settings` 的长设定期设定），并告诉模型它现在能动手到什么程度。
   面板根上挂 `data-gate`（deny/propose/allow）——Agent 模式的写工具执行前问 `gateWrite()`，
   e2e 也直接读这个属性（不必反射模块）。 */
function renderPerm(): void {
  if (!openEl) return;
  const scope = getAgentScope();
  const ask = getAgentAsk();
  const sSel = openEl.querySelector<HTMLSelectElement>('#lk-agent-scope');
  const aSel = openEl.querySelector<HTMLSelectElement>('#lk-agent-ask');
  if (sSel && sSel.value !== scope) sSel.value = scope;
  if (aSel && aSel.value !== ask) aSel.value = ask;
  /* ⭐ 2026-09-26 改口后**两个模式都能动手**（聊天模式也有内部动作）⇒ 两把旋钮在两个模式里
     **都可用**：权限才是"允许做到哪一步"的长期设定，模式只决定"这次要多自主"。
     （旧版在聊天模式把它们禁掉、还写着"用不上"，那是片 4 的零工具语义，已废。） */
  if (sSel) sSel.disabled = false;
  if (aSel) aSel.disabled = false;
  const hint = openEl.querySelector('#lk-agent-perm-hint');
  if (hint) {
    hint.textContent = permName(scope, ask) + '：' + permHint(scope, ask);
  }
  openEl.querySelector('.lk-agent__perm')?.classList.remove('is-off');
  openEl.dataset.gate = gateWrite();
}

/* 模式：`chat`（默认）⇄ `agent`。切进 agent 是**显式授权**，所以状态必须看得见
   （分段控件 `.is-on` + 面板根 `.is-agent`）—— 不然"我现在是不是在 agent 里"没人知道。
   模式不进设置、不落盘：关掉面板再打开 = 回到聊天（用户 2026-09-26：「平常是正常的聊天」）。 */
function renderMode(): void {
  if (!openEl) return;
  openEl.dataset.mode = mode;
  openEl.classList.toggle('is-agent', mode === 'agent');
  for (const m of MODES) {
    const b = openEl.querySelector<HTMLElement>('#lk-agent-mode-' + m);
    if (b) b.classList.toggle('is-on', m === mode);
  }
  const hint = openEl.querySelector('#lk-agent-mode-hint');
  if (hint) hint.textContent = MODE_HINT[mode];
  renderPerm();   /* 权限那行的可用性跟着模式走：两处必须同时更新 */
}

/* ⭐ 2C：模式**两个入口共享一份**（Ctrl+K 的助手浮层 + AI 页的主会话）。
   `setAgentMode()` 是唯一写入口：改状态 → 重画本层 → 广播 `lingkuang-agent-mode`，
   另一个入口听这个事件刷新自己的分段控件。 */
export function getAgentMode(): AgentMode { return mode; }

export function setAgentMode(next: AgentMode): void {
  if (mode === next) return;
  mode = next;
  renderMode();
  setNote(mode === 'agent'
    ? '已切到 Agent：能连着走多步（写入按下面那档权限走）'
    : '已切回聊天：一次只做一个动作（写入照样要过下面那关）');
  window.dispatchEvent(new CustomEvent('lingkuang-agent-mode', { detail: { mode: next } }));
}

function setMode(next: AgentMode): void { setAgentMode(next); }

function setNote(text: string, isErr = false): void {
  const el = openEl?.querySelector('#lk-agent-note');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-err', isErr);
}

/* 写入动作：三档权限决定它怎么落地 ——
   只读 = 不执行（把意图讲给创作者）；逐项确认 = 出一张提议卡片等点「应用」；
   YOLO = 直接执行。三条路都往历史里塞一条「动作结果」，模型下一轮才知道发生了什么。 */
function handleWrite(call: ToolCall, host: AgentRunHost): void {
  const gate = gateWrite();
  if (gate === 'deny') {
    host.push({ role: 'user', content: `【动作结果：${call.tool}】现在是「只读」档，没有执行。把你的意图写成创作者能照着改的话。` });
    host.note('只读档：这次写入没有执行', true);
    return;
  }
  const plan = planWrite(call, host.store, mode);
  if (!plan.ok) {
    host.push({ role: 'user', content: `【动作结果：${call.tool}】${plan.note}` });
    host.note(plan.note, true);
    return;
  }
  /* ⭐ `needsConfirm`（自我提权那类动作）**无视**"直接执行"档：那一档是创作者授权了平常的写入，
     不等于授权助手自己把权限往宽里调 —— 这一步必须他亲手点「应用」。 */
  if (gate === 'allow' && !plan.proposal.needsConfirm) {
    agentActing();
    const r = plan.proposal.apply();
    host.push({ role: 'user', content: `【动作结果：${call.tool}】${r.note}（系统回执，界面已单独显示这块，不必复述）` });
    host.note(r.note);
    return;
  }
  cards.push({ p: plan.proposal });
  host.note(plan.proposal.needsConfirm && gate === 'allow'
    ? '这一步会放开更大的权限 —— 只有你点「应用」才会生效'
    : '写了一张提议卡片，点「应用」才落盘');
}

/** 卡片状态变了：**两个入口都要跟着重画**（助手浮层直接重画；AI 页听 `lingkuang-agent-cards`） */
function notifyCards(note?: string): void {
  if (openEl) { renderMsgs(); if (note !== undefined) setNote(note); }
  window.dispatchEvent(new CustomEvent('lingkuang-agent-cards', { detail: { note } }));
}

/* 卡片上的「应用」/「忽略」（事件委托：两个入口各自把监听挂在自己的消息容器上；
   卡片跟着消息区一起重画 ⇒ 不能逐个绑） */
export function agentCardClick(e: Event): void {
  const el = (e.target as HTMLElement).closest('[data-prop-ok], [data-prop-no]') as HTMLElement | null;
  if (!el) return;
  const i = Number(el.dataset.propOk ?? el.dataset.propNo ?? '-1');
  const c = cards[i];
  if (!c) return;
  if (el.dataset.propNo !== undefined) {
    c.ignored = true;
    notifyCards();
    return;
  }
  if (gateWrite() === 'deny') {
    if (openEl) setNote('现在是「只读」档，改权限才能落盘', true);
    return;
  }
  agentActing();
  const r = c.p.apply();
  /* 卡片上只留一句短话：这句长说明下面已经有一块【动作结果】了，同一条话画两遍很吵 */
  c.done = '已应用';
  pushHistory({ role: 'user', content: `【动作结果：${c.p.tool}】${r.note}（系统回执，界面已单独显示这块，不必复述）` });
  /* 落盘由 pushHistory → pushMsg 负责 */
  notifyCards(r.note);
}

/* ── 一次提问（第 4 片 2C：两个入口共用这一份）────────────────────────
   用户 2026-09-26：「**主会话和助手指向的是同一个会话**」⇒ 工具循环、系统提示、提议卡片
   只实现一次：`runTurn()` 管逻辑，「画在哪 / 存哪里 / 提示写哪」三件事交给宿主
   （`AgentRunHost`）。Ctrl+K 的助手浮层与 AI 页的主会话各给一个宿主 ——
   同一格会话在两个入口因此**能力完全一致**（这就是 2C 的全部目的）。 */
export interface AgentRunHost {
  /** 消息区容器（流式气泡挂它上面） */
  box: HTMLElement | null;
  wrapClass?: string;
  innerClass?: string;
  bodyClass?: string;
  bodyStyle?: string;
  /** 底部提示 */
  note(text: string, isErr?: boolean): void;
  /** 重画消息区（提议卡片随之重画） */
  rerender(): void;
  /** 把一条消息塞进历史（浮层走 pushHistory、AI 页走 pushMsg —— 都是同一格主会话） */
  push(m: ChatMsg): void;
  /** 用哪份数据 */
  store: Store;
}

/** 有没有一次提问正在跑（跨入口共用：AI 页靠它挡重复发送） */
export function isAgentRunning(): boolean { return busy; }

/** 助手浮层那个宿主 */
function panelHost(): AgentRunHost {
  return {
    box: openEl?.querySelector<HTMLElement>('#lk-agent-msgs') ?? null,
    wrapClass: 'lk-agent__cutwrap',
    innerClass: 'lk-agent__msg is-ai',
    bodyClass: 'lk-agent__bubble lk-md',
    note: setNote,
    rerender: () => { renderMsgs(); renderCtx(); },
    push: pushHistory,
    store: store as Store,
  };
}

/* ── 发送 ─────────────────────────────────────────────────────────── */
async function send(): Promise<void> {
  if (busy || !openEl || !store) return;
  const ta = openEl.querySelector<HTMLTextAreaElement>('#lk-agent-input');
  const text = (ta?.value ?? '').trim();
  if (!text) return;
  if (ta) ta.value = '';
  await runTurn(text, panelHost());
}

/** 一次提问的**共用实现**：助手浮层与 AI 页的主会话都走它 */
export async function runTurn(text: string, host: AgentRunHost): Promise<void> {
  if (busy) return;
  /* ⚠️ `busy` 必须在 `await` **之前**占位：`ensureLoaded()` 会让出这一帧，两次点击就都能挤进来
     （老代码 busy=true 是同步设的，这个顺序不能变） */
  busy = true;
  try {
    await ensureLoaded();
  } catch (e) {
    busy = false;
    host.note('出错：' + (e instanceof Error ? e.message : String(e)), true);
    return;
  }
  /* 写入一律经这里：`host.push` 之后把指针重新对齐（AI 页写的是同一格会话，
     对齐之后助手浮层下次重画读到的才是同一份）。`hist()` 顺带在开头对一次。 */
  const push = (m: ChatMsg): void => {
    host.push(m);
    const cur = mainSession();
    if (cur && cur.history !== history) history = cur.history;
  };
  hist();
  host.note('正在思考…');
  push({ role: 'user', content: text });
  host.rerender();
  /* 系统提示按模式拼 —— 见 `agentSystemPrompt()`：**AI 页的「主会话」用的是同一个函数** */
  const sys = agentSystemPrompt(host.store, mode);
  /* 输出上限不再由这里设 900（用户 2026-09-26：「ai 的输出被截断了」）：不传 = 引擎不设上限，
     只有「就要短答案」的地方（联想 / 起名 / 总结）才显式给 numPredict。 */
  const cfg = { temperature: 0.7 };
  const box = host.box;
  let live: LiveBubble | null = null;
  /* 思考块（用户 2026-09-26「看不到他的思考诶」）：与气泡同生共死，但排在它上面 */
  let think: LiveThink | null = null;
  /* 这一问有没有收到过一个字的思考：空 ⇒ 模型不吐（见末尾那条说明） */
  let sawThink = false;
  try {
    /* 一次提问 = 最多 `roundMax` 轮：模型要么说话（结束），要么要求一个只读动作
       （执行完把结果喂回去，让它接着说）。写入动作一轮就结束 —— 要么落盘要么等点击。 */
    let fixed = false; /* ⭐ 格式纠错只做一次，免得跟模型来回拉锯 */
    const roundMax = mode === 'agent' ? AGENT_ROUNDS : CHAT_ROUNDS;
    for (let round = 0; round <= roundMax; round++) {
      /* 分割线之上的对话**不发给模型**（系统提示词、记忆、工作区现状都在 sys 里，照旧每次现拼） */
      const msgs: ChatMsg[] = [{ role: 'system', content: sys }, ...sentHistory(hist())];
      /* 流式（用户 2026-09-26：「我想要流式输出」）：先挂一个空气泡，增量到了就往里写。
         ⚠️ 两个模式下这一段都可能在吐动作 JSON —— 那种东西不给创作者看：从第一个 `{` 起就改说
         「正在整理成动作…」，这一轮走完再由 renderMsgs() 画成「用到动作」那一行。 */
      live?.remove();
      think?.remove();
      /* ⚠️ **先挂思考块、再挂气泡**：DOM 的追加顺序就是屏幕上的上下顺序 —— 反过来写，
         流式那一段思考会显示在正文下面，落定重画（`msgHtml`）之后又跳回上面（★6 实测抓到的跳动）。
         模型不吐思考时它自己会消失（`finish()` 里空思考整块摘掉）。 */
      think = box ? liveThink(box, { scroll: box }) : null;
      live = box
        ? liveBubble(box, { wrapClass: host.wrapClass, innerClass: host.innerClass, bodyClass: host.bodyClass, bodyStyle: host.bodyStyle, scroll: box })
        : null;
      live?.placeholder('正在思考…');
      let acc = '';
      let suppressed = false;
      const r = await agentAsk(msgs, {
        ...cfg,
        onReasoning: (d: string) => { sawThink = true; think?.push(d); },
        onDelta: (d: string) => {
          acc += d;
          /* 自动化要看的「中间态」：测试先建好 window.__lkStreamLog，这里只往里记，正式运行零成本 */
          const log = (window as any).__lkStreamLog;
          if (Array.isArray(log)) log.push({ len: acc.length, t: Date.now() });
          if (acc.trimStart().startsWith('{')) { suppressed = true; live?.placeholder('正在整理成动作…'); return; }
          live?.push(d);
        },
      });
      /* 气泡收尾：正常说完就落定；在吐动作 JSON 就保持"正在整理成动作…"（不给 JSON 闪一下的机会） */
      if (!suppressed && !looksLikeToolJson(r.text)) live?.finish(r.text);
      /* 思考落定即折叠（正文才是主角；想回看点开它，历史里那份也还在）。
         真值以 `r.reasoning` 为准 —— 与下面落进历史的那一份对齐；空的话整块摘掉。 */
      if (r.reasoning) sawThink = true;
      think?.finish(r.reasoning);
      /* ⭐ 两个模式**都解析动作**（2026-09-26 用户改口：聊天模式也有灵框内部的动作）；
         差别只在能连着走几步 —— `roundMax` 已经按模式定好了。别再说"聊天模式不解析"，
         那会让模型吐的动作 JSON 被当聊天画到脸上、什么也不发生。 */
      const call = parseToolCall(r.text);
      if (!call && looksLikeToolJson(r.text)) {
        /* 想调动作、格式却写歪了（用户 2026-09-15 实测：`{"set_field":{…}}`）。
           纠正一次（进历史、不进气泡），还不行就不再把这坨 JSON 糊到创作者脸上。 */
        if (!fixed && round < roundMax) {
          fixed = true;
          push({ role: 'user', content: FIX_NOTE });
          host.note('它发来的动作格式不对，我让它按格式重发了一次…');
          continue;
        }
        host.note('它两次都没按动作格式回话，这次先算了（可以再问一次，或换个模型）', true);
        break;
      }
      if (!call) {
        push({ role: 'assistant', content: r.text || '（模型返回了空内容）', reasoning: r.reasoning });
        /* 被截断要如实说 —— 用户 2026-09-26 报「输出被截断了」时界面上什么都没有 */
        if (r.truncated) host.note('回复被模型的输出上限截断了（' + (r.model || '模型') + '）：说「接着说」可以续', true);
        else if (!sawThink && !noThinkHinted) {
          /* 模型压根不吐思考 —— 界面上原本一点痕迹都没有，分不清「功能没做」还是「这个模型没有」。
             每个运行周期只说一次，之后安静（用户 2026-09-26 实测就是在用非推理模型）。 */
          noThinkHinted = true;
          host.note((r.model && r.model !== 'mock' ? '模型：' + r.model + ' · ' : '')
            + '它不吐思考过程（这个模型不是推理模型）—— 想看得见思考，去「设置 → 模型」换成会推理的，比如本机的 qwen3:14b');
        } else host.note(r.model === 'mock' ? '' : r.model ? '模型：' + r.model : '');
        break;
      }
      push({ role: 'assistant', content: r.text, reasoning: r.reasoning });
      if (isWriteTool(call.tool)) {
        handleWrite(call, host);
        break;
      }
      const out = runReadTool(call, host.store);
      push({ role: 'user', content: `【动作结果：${call.tool}】\n${out}` });
      host.rerender();
      if (round === roundMax) {
        host.note(mode === 'agent' ? '动作调了几轮了，先停一下' : '聊天模式一次只做一个动作 —— 要我接着做就再说一声', true);
      }
    }
  } catch (e) {
    /* 报错**不进历史**（否则会被反复喂回模型），只在宿主底部提示 */
    live?.remove();
    think?.remove();
    host.note('出错：' + (e instanceof Error ? e.message : String(e)) + '（检查设置里的 AI 模式与模型）', true);
  }
  busy = false;
  host.rerender();
  /* ⭐ 2C：跑的过程中 `busy` 是 true ⇒ **另一个入口**的 `lingkuang-sessions` 监听会主动跳过重画
     （那是为了不打断流式气泡，见 `openAgentPanel` 的 onSessions）。跑完必须补一次广播，
     否则同一格会话在另一边还停在旧内容上（实测：AI 页写完 8 条，助手浮层只画得出 6 条）。 */
  window.dispatchEvent(new CustomEvent('lingkuang-sessions'));
}

/* ── 从对话里总结偏好 ─────────────────────────────────────────────── */
async function summarize(): Promise<void> {
  if (busy || !openEl) return;
  if (!hist().length) {
    setNote('还没聊过，没什么可总结的', true);
    return;
  }
  busy = true;
  setNote('正在读对话、总结偏好…');
  try {
    const cands = await summarizePrefs(hist());
    let n = 0;
    for (const c of cands) if (addMemory(c, 'auto')) n++;
    renderMemory();
    setNote(n ? `记下 ${n} 条偏好` : (cands.length ? '这几条已经记过了' : '没看出新的稳定偏好（再多聊几轮试试）'));
  } catch (e) {
    setNote('总结失败：' + (e instanceof Error ? e.message : String(e)), true);
  }
  busy = false;
}

/* ── 开 / 关 ──────────────────────────────────────────────────────── */
export function closeAgentPanel(): void {
  if (!openEl) return;
  const el = openEl;
  /* 向右滑出（用户 2026-09-18：「出场时也是向右平滑出场」）：先摘掉 .is-in 让它滑回去，
     动画走完再 remove —— 直接 remove 会"啪"地消失，剩下的状态清理照旧立刻做。
     ⚠️ 滑出期间 `isAgentPanelOpen()` 已经是 false，但 DOM 还在 ⇒ 必须 `pointer-events:none`
     （`.is-out`），否则那 300ms 里面板上的按钮还能被点到。
     ⚠️ 兜底定时器给 420ms 而不是 320ms：隐藏窗口（测试实例）里定时器被节流到 ~1s，
     真机上 transitionend 会先到（那时就摘掉了），两者都摘一次是幂等的。 */
  el.classList.remove('is-in');
  el.classList.add('is-out');
  const drop = (): void => { el.remove(); };
  el.addEventListener('transitionend', (ev) => {
    if (ev.target === el && ev.propertyName === 'transform') drop();
  }, { once: true });
  window.setTimeout(drop, motionReduced() ? 0 : 420);
  openEl = null;
  store = null;
  draft = false;
  cards = [];
  /* 模式回落：关掉面板 = 收回"动手"的授权，下次打开还是聊天（用户 2026-09-26：「平常是聊天」） */
  setAgentMode('chat');
  setMemorySink(null);
  disposeAll?.();
  disposeAll = null;
  window.dispatchEvent(new CustomEvent('lingkuang-panel', { detail: { id: 'agent', open: false } }));
}

export function openAgentPanel(s: Store): () => void {
  if (isAgentPanelOpen()) return () => closeAgentPanel();
  store = s;
  const el = document.createElement('aside');
  el.id = PANEL_ID;
  el.className = 'lk-agent';
  el.setAttribute('role', 'dialog');
  el.dataset.gate = gateWrite();
  el.innerHTML =
    '<div class="lk-agent__head">' +
      '<div class="lk-agent__title">灵框助手</div>' +
      '<div class="lk-agent__chips">' +
        `<span class="lk-agent__chip" id="lk-agent-model">${escapeHtml(providerSummary(activeProviderProfile()))}</span>` +
        '<span class="lk-agent__chip is-focus" id="lk-agent-focus">没打开条目</span>' +
      '</div>' +
      '<button class="lk-agent__split" id="lk-agent-split" title="把上面的对话切出上下文（系统提示词与长期记忆照常）">分割上下文</button>' +
      '<button class="lk-agent__x" id="lk-agent-close" title="关闭（Esc）">×</button>' +
    '</div>' +
    '<div class="lk-agent__mode">' +
      '<span class="lk-agent__mode-lbl">模式</span>' +
      '<div class="lk-agent__seg" id="lk-agent-mode">' +
        MODES.map((m) => `<button class="lk-agent__seg-btn${m === mode ? ' is-on' : ''}" id="lk-agent-mode-${m}" data-mode="${m}">${MODE_LABEL[m]}</button>`).join('') +
      '</div>' +
      '<span class="lk-agent__mode-hint" id="lk-agent-mode-hint"></span>' +
    '</div>' +
    '<div class="lk-agent__perm">' +
      '<span class="lk-agent__perm-lbl">权限</span>' +
      /* 两个**正交**旋钮：范围 × 询问（`src/ui/agent-perm.ts`）。分开摆而不是合成一个三选一：
         创作者能一眼说出"不许写 / 写了要问我 / 随你写"这三种之外，还能组合出第四种（只读+不问）。 */
      '<select class="lk-agent__perm-sel" id="lk-agent-scope">' +
        SCOPES.map((v) => `<option value="${v}"${v === getAgentScope() ? ' selected' : ''}>${SCOPE_LABEL[v]}</option>`).join('') +
      '</select>' +
      '<select class="lk-agent__perm-sel" id="lk-agent-ask">' +
        ASKS.map((v) => `<option value="${v}"${v === getAgentAsk() ? ' selected' : ''}>${ASK_LABEL[v]}</option>`).join('') +
      '</select>' +
      '<span class="lk-agent__perm-hint" id="lk-agent-perm-hint"></span>' +
    '</div>' +
    '<details class="lk-agent__mem">' +
      '<summary id="lk-agent-mem-summary">长期记忆（0 条偏好）</summary>' +
      '<div class="lk-agent__mem-list" id="lk-agent-mem-list"></div>' +
      '<div class="lk-agent__mem-acts">' +
        '<button class="lk-agent__mem-btn" id="lk-agent-mem-add">＋ 手动加一条</button>' +
        '<button class="lk-agent__mem-btn" id="lk-agent-mem-sum">从对话里总结</button>' +
      '</div>' +
    '</details>' +
    '<details class="lk-agent__ctx"><summary>上下文（每次提问自动带上）</summary><pre id="lk-agent-ctx"></pre></details>' +
    '<div class="lk-agent__msgs" id="lk-agent-msgs"></div>' +
    '<div class="lk-agent__note" id="lk-agent-note"></div>' +
    '<div class="lk-agent__input">' +
      '<textarea id="lk-agent-input" rows="3" placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"></textarea>' +
      '<button class="lk-agent__send" id="lk-agent-send">发送</button>' +
    '</div>';
  document.body.appendChild(el);
  openEl = el;
  /* 从右侧滑入：以"滑出位"（CSS 里 `.lk-agent` 的 translateX(100%)）入 DOM，下一帧再上 .is-in。
     中间必须强制重排（读 offsetWidth），否则浏览器把两次样式变更合并成一次、根本看不到过渡。 */
  void el.offsetWidth;
  el.classList.add('is-in');
  setMemorySink(persist);

  /* Esc 关闭 + 跟着 store 变（创作者一边聊一边改设定，焦点与上下文会变） */
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    closeAgentPanel();
  };
  window.addEventListener('keydown', onKey);
  const unsub = s.subscribe(() => { renderMeta(); });
  /* 「正在编」换了一条（点左树另一行 / 换世界 / 那条被删了）→ 小标签与上下文预览都要跟上。
     换条目是 UI 状态、不一定触发 store 通知，所以 `agent-context.ts` 会单独广播这个事件。 */
  const onFocus = (): void => { renderMeta(); renderCtx(); };
  window.addEventListener('lingkuang-agent-focus', onFocus);
  const onPerm = (): void => { renderPerm(); };
  window.addEventListener('lingkuang-agent-perm', onPerm);
  disposeAll = (): void => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('lingkuang-agent-focus', onFocus);
    window.removeEventListener('lingkuang-agent-perm', onPerm);
    unsub();
  };

  el.querySelector('#lk-agent-close')?.addEventListener('click', () => closeAgentPanel());
  el.querySelector('#lk-agent-send')?.addEventListener('click', () => { void send(); });
  /* 提议卡片的「应用」/「忽略」（卡片跟消息区一起重画，所以用委托） */
  el.querySelector('#lk-agent-msgs')?.addEventListener('click', agentCardClick);
  const ta = el.querySelector<HTMLTextAreaElement>('#lk-agent-input');
  ta?.addEventListener('keydown', (e: KeyboardEvent) => {
    /* 中文输入法选词的回车不能当发送（复用 `src/ui/keys.ts` 的 isImeEnter） */
    if (e.key !== 'Enter' || e.shiftKey || isImeEnter(e)) return;
    e.preventDefault();
    void send();
  });

  /* 记忆：改文字（失焦/回车即存）、删条目、手动加、从对话总结 */
  const memList = el.querySelector('#lk-agent-mem-list');
  memList?.addEventListener('change', (e) => {
    const inp = (e.target as HTMLElement).closest('.lk-agent__mem-input') as HTMLInputElement | null;
    if (!inp) return;
    const item = inp.closest('.lk-agent__mem-item') as HTMLElement | null;
    const id = item?.dataset.memId ?? '';
    const text = inp.value.trim();
    if (!id) {
      draft = false;
      if (text) addMemory(text, 'manual');
    } else {
      updateMemory(id, text);
    }
    renderMemory();
  });
  memList?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-mem-del]') as HTMLElement | null;
    if (!btn) return;
    removeMemory(btn.dataset.memDel || '');
    renderMemory();
  });
  el.querySelector('#lk-agent-mem-add')?.addEventListener('click', () => {
    draft = true;
    const det = el.querySelector<HTMLDetailsElement>('.lk-agent__mem');
    if (det) det.open = true;
    renderMemory();
  });
  el.querySelector('#lk-agent-mem-sum')?.addEventListener('click', () => { void summarize(); });

  /* 模式：聊天 ⇄ Agent（显式切换；面板每次打开都从聊天开始） */
  for (const m of MODES) {
    el.querySelector('#lk-agent-mode-' + m)?.addEventListener('click', () => setMode(m));
  }

  /* 权限两旋钮：范围（只读/可写）× 询问（每次确认/直接执行） */
  const scopeSel = el.querySelector<HTMLSelectElement>('#lk-agent-scope');
  scopeSel?.addEventListener('change', () => {
    setAgentScope(scopeSel.value as AgentScope);
    renderPerm();
  });
  const askSel = el.querySelector<HTMLSelectElement>('#lk-agent-ask');
  askSel?.addEventListener('change', () => {
    setAgentAsk(askSel.value as AgentAsk);
    renderPerm();
  });

  renderMsgs();
  renderMeta();
  renderCtx();
  renderMemory();
  renderMode();   /* 内部会一并刷新权限那行（聊天模式下它不可用） */
  setNote('');
  void ensureLoaded().then(() => { renderMsgs(); renderMemory(); });
  /* ⭐ 同一格会话的**屏幕**也要同步（见 `src/ui/ai-sessions.ts` 的 announce）：AI 页往主会话里写了
     东西时，这层浮层得当场重画。⚠️ 正在生成时不重画 —— 会把这条流式气泡一起抹掉。 */
  const onSessions = (): void => { if (!busy && isAgentPanelOpen()) renderMsgs(); };
  window.addEventListener('lingkuang-sessions', onSessions);
  if (ta) ta.focus();
  window.dispatchEvent(new CustomEvent('lingkuang-panel', { detail: { id: 'agent', open: true } }));
  return () => { window.removeEventListener('lingkuang-sessions', onSessions); closeAgentPanel(); };
}

export function toggleAgentPanel(s: Store): void {
  if (isAgentPanelOpen()) closeAgentPanel();
  else openAgentPanel(s);
}
