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
import { liveBubble, type LiveBubble } from './chat-live';
import { mdToHtml } from './md';
import { buildContext, getAgentFocus, isAgentFocusLive } from './agent-context';
import { agentActing, loadActivity, recentActivity } from './agent-activity';
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

let openEl: HTMLElement | null = null;
let store: Store | null = null;
let disposeAll: (() => void) | null = null;
let history: ChatMsg[] = [];
let loaded = false;
let busy = false;
/** 当前模式（`chat` = 平常聊天，不注入动作协议；`agent` = 能动手）。
 *  ⚠️ **面板会话态、不落盘**：每次打开都从 `chat` 开始（见 `src/ui/agent-mode.ts` 顶部说明）。 */
let mode: AgentMode = 'chat';
/** 「＋ 手动加一条」点了之后，列表里多出一行空输入框等着填 */
let draft = false;

/* 动作（片 3）：`MAX_ROUNDS` = 只读动作最多连着跑几轮（模型看结果 → 再决定），
   防它在「列设定 → 再看一条 → 再列」里打转。`cards` = 这次会话里还没处理的提议卡片。 */
const MAX_ROUNDS = 3;
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
function splitContext(): void {
  if (Date.now() - lastActionAt < 350) return;
  lastActionAt = Date.now();
  if (!history.length) { setNote('还没有对话，不用分割'); return; }
  const above = history.length;
  history.push({ role: 'system', content: '', div: true } as AgentMsg);
  setNote('已分割：上面 ' + above + ' 条不再发给模型；想接回来，把鼠标放到那条线上点叉');
  persist();
  renderMsgs();
}

/** 重新接上这段上下文 = 摘掉分割线（用户 2026-09-18：「取消分割可以做在线旁边，
 *  鼠标悬浮在线上时显示一个叉，按下就能重新连接上下文」） */
function unsplitContext(): void {
  if (Date.now() - lastActionAt < 350) return;
  lastActionAt = Date.now();
  for (let i = history.length - 1; i >= 0; i--) {
    if ((history[i] as AgentMsg).div === true) { history.splice(i, 1); break; }
  }
  setNote('已重新接上：上面那些对话又回到上下文里了');
  persist();
  renderMsgs();
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const r = await api()?.agentLoad?.();
    if (r?.ok && Array.isArray(r.chat)) {
      /* ⚠️ 分割线（div:true）也要读回来，否则重开面板「分割」就白做了 */
      history = r.chat
        .filter((m: any) => m && typeof m.content === 'string' && (m.div === true || m.role === 'user' || m.role === 'assistant'))
        .map((m: any) => (m.div === true ? ({ role: 'system', content: '', div: true } as AgentMsg) : ({ role: m.role, content: m.content } as AgentMsg)));
    }
    if (r?.ok) adoptFromDisk(r.memory);
    if (r?.ok) loadActivity(r.activity);
  } catch {
    /* 读不到就从空开始，不挡对话 */
  }
}

function persist(): void {
  try {
    void api()?.agentSave?.({ chat: history, memory: getMemory(), activity: recentActivity() });
  } catch {
    /* 落盘失败不该影响这一次对话 */
  }
}

/* ── 渲染 ─────────────────────────────────────────────────────────── */
/* 动作的调用与结果都是**对话的一部分**（要喂回模型），但显示上不能混成聊天气泡：
   调用显示成一行「用到动作」，结果显示成一小块说明。 */
const RESULT_RE = /^【动作结果：([^】]+)】/;

function isCallMsg(m: ChatMsg): boolean {
  /* ⚠️ 只有 agent 模式才把这种消息画成「用到动作」那一行（片 4）：
     聊天模式**没有**动作这回事，模型偶尔吐的 JSON 就是一段普通文字 ——
     若照旧画成「用到动作：create_entity」，创作者会以为它真动手了（其实什么也没发生）。
     副作用（已知、可接受）：agent 模式下真调用留下的消息，切回聊天模式后显示成原始 JSON 文字。 */
  if (mode !== 'agent') return false;
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
  return `<div class="lk-agent__msg ${who}"><div class="lk-agent__bubble${m.role === 'user' ? '' : ' lk-md'}">${body}</div></div>`;
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

function renderMsgs(): void {
  const box = openEl?.querySelector('#lk-agent-msgs');
  if (!box) return;
  const cut = cutIndex(history);
  const head = history.length
    ? history
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
  box.innerHTML = head + cards.map((c, i) => cardHtml(i, c)).join('');
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
  /* 聊天模式没有"动手"这回事：控件留着（别让它跳），但禁掉并压暗 ——
     免得看着像"权限已经生效"，也免得创作者以为改了权限就切过去了。 */
  const off = mode !== 'agent';
  if (sSel) sSel.disabled = off;
  if (aSel) aSel.disabled = off;
  const hint = openEl.querySelector('#lk-agent-perm-hint');
  if (hint) {
    hint.textContent = off
      ? '聊天模式用不上（切到 Agent 才动手）'
      : permName(scope, ask) + '：' + permHint(scope, ask);
  }
  openEl.querySelector('.lk-agent__perm')?.classList.toggle('is-off', off);
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

function setMode(next: AgentMode): void {
  if (mode === next) return;
  mode = next;
  renderMode();
  setNote(mode === 'agent'
    ? '已切到 Agent：它能查、能改（写入按下面那档权限走）'
    : '已切回聊天：它只出建议，不会动你的数据');
}

function setNote(text: string, isErr = false): void {
  const el = openEl?.querySelector('#lk-agent-note');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-err', isErr);
}

/* 写入动作：三档权限决定它怎么落地 ——
   只读 = 不执行（把意图讲给创作者）；逐项确认 = 出一张提议卡片等点「应用」；
   YOLO = 直接执行。三条路都往历史里塞一条「动作结果」，模型下一轮才知道发生了什么。 */
function handleWrite(call: ToolCall): void {
  if (!store) return;
  const gate = gateWrite();
  if (gate === 'deny') {
    history.push({ role: 'user', content: `【动作结果：${call.tool}】现在是「只读」档，没有执行。把你的意图写成创作者能照着改的话。` });
    setNote('只读档：这次写入没有执行', true);
    return;
  }
  const plan = planWrite(call, store);
  if (!plan.ok) {
    history.push({ role: 'user', content: `【动作结果：${call.tool}】${plan.note}` });
    setNote(plan.note, true);
    return;
  }
  if (gate === 'allow') {
    agentActing();
    const r = plan.proposal.apply();
    history.push({ role: 'user', content: `【动作结果：${call.tool}】${r.note}（系统回执，界面已单独显示这块，不必复述）` });
    setNote(r.note);
    return;
  }
  cards.push({ p: plan.proposal });
  setNote('写了一张提议卡片，点「应用」才落盘');
}

/* 卡片上的「应用」/「忽略」（事件委托：卡片随消息区一起重画） */
function onCardClick(e: Event): void {
  const el = (e.target as HTMLElement).closest('[data-prop-ok], [data-prop-no]') as HTMLElement | null;
  if (!el) return;
  const i = Number(el.dataset.propOk ?? el.dataset.propNo ?? '-1');
  const c = cards[i];
  if (!c) return;
  if (el.dataset.propNo !== undefined) {
    c.ignored = true;
    renderMsgs();
    return;
  }
  if (gateWrite() === 'deny') {
    setNote('现在是「只读」档，改权限才能落盘', true);
    return;
  }
  agentActing();
  const r = c.p.apply();
  /* 卡片上只留一句短话：这句长说明下面已经有一块【动作结果】了，同一条话画两遍很吵 */
  c.done = '已应用';
  history.push({ role: 'user', content: `【动作结果：${c.p.tool}】${r.note}（系统回执，界面已单独显示这块，不必复述）` });
  persist();
  renderMsgs();
  setNote(r.note);
}

/* ── 发送 ─────────────────────────────────────────────────────────── */
async function send(): Promise<void> {
  if (busy || !openEl || !store) return;
  const ta = openEl.querySelector<HTMLTextAreaElement>('#lk-agent-input');
  const text = (ta?.value ?? '').trim();
  if (!text) return;
  if (ta) ta.value = '';
  busy = true;
  setNote('正在思考…');
  history.push({ role: 'user', content: text });
  renderMsgs();
  renderCtx();
  /* 系统提示按模式拼：聊天模式**不许出现**动作协议与权限段 —— 那是"能动手"才该看到的
     说明书（本地小模型只要看见协议，就会时不时吐半截 JSON 给创作者看）。
     两种模式都带长期记忆与工作区现状。 */
  const sys = [
    SYS_HEAD,
    modePrompt(mode),
    ...(mode === 'agent' ? [permissionPrompt(), toolsPrompt()] : []),
    memoryPrompt(),
    '【工作区现状】\n' + buildContext(store),
  ].filter(Boolean).join('\n\n');
  /* 输出上限不再由这里设 900（用户 2026-09-26：「ai 的输出被截断了」）：不传 = 引擎不设上限，
     只有「就要短答案」的地方（联想 / 起名 / 总结）才显式给 numPredict。 */
  const cfg = { temperature: 0.7 };
  const box = openEl.querySelector<HTMLElement>('#lk-agent-msgs');
  let live: LiveBubble | null = null;
  try {
    /* 一次提问 = 最多 MAX_ROUNDS 轮：模型要么说话（结束），要么要求一个只读动作
       （执行完把结果喂回去，让它接着说）。写入动作一轮就结束 —— 要么落盘要么等点击。 */
    let fixed = false; /* ⭐ 格式纠错只做一次，免得跟模型来回拉锯 */
    for (let round = 0; round <= MAX_ROUNDS; round++) {
      /* 分割线之上的对话**不发给模型**（系统提示词、记忆、工作区现状都在 sys 里，照旧每次现拼） */
      const msgs: ChatMsg[] = [{ role: 'system', content: sys }, ...sentHistory(history)];
      /* 流式（用户 2026-09-26：「我想要流式输出」）：先挂一个空气泡，增量到了就往里写。
         ⚠️ agent 模式下这一段可能在吐动作 JSON —— 那种东西不给创作者看：从第一个 `{` 起就改说
         「正在整理成动作…」，这一轮走完再由 renderMsgs() 画成「用到动作」那一行。 */
      live?.remove();
      live = box
        ? liveBubble(box, { wrapClass: 'lk-agent__cutwrap', innerClass: 'lk-agent__msg is-ai', bodyClass: 'lk-agent__bubble lk-md', scroll: box })
        : null;
      live?.placeholder('正在思考…');
      let acc = '';
      let suppressed = false;
      const r = await agentAsk(msgs, {
        ...cfg,
        onDelta: (d: string) => {
          acc += d;
          /* 自动化要看的「中间态」：测试先建好 window.__lkStreamLog，这里只往里记，正式运行零成本 */
          const log = (window as any).__lkStreamLog;
          if (Array.isArray(log)) log.push({ len: acc.length, t: Date.now() });
          if (mode === 'agent' && acc.trimStart().startsWith('{')) { suppressed = true; live?.placeholder('正在整理成动作…'); return; }
          live?.push(d);
        },
      });
      /* 气泡收尾：正常说完就落定；在吐动作 JSON 就保持"正在整理成动作…"（不给 JSON 闪一下的机会） */
      if (!suppressed && !(mode === 'agent' && looksLikeToolJson(r.text))) live?.finish(r.text);
      /* ⚠️ 聊天模式**不解析动作**：模型偶尔还是会对着"帮我改一下"吐一坨 JSON，
         那样的回复当普通文字画出来就行（创作者至少看得见它说了什么），
         不走纠错轮 —— 那是 agent 模式才有的来回。 */
      const call = mode === 'agent' ? parseToolCall(r.text) : null;
      if (mode === 'agent' && !call && looksLikeToolJson(r.text)) {
        /* 想调动作、格式却写歪了（用户 2026-09-15 实测：`{"set_field":{…}}`）。
           纠正一次（进历史、不进气泡），还不行就不再把这坨 JSON 糊到创作者脸上。 */
        if (!fixed && round < MAX_ROUNDS) {
          fixed = true;
          history.push({ role: 'user', content: FIX_NOTE });
          setNote('它发来的动作格式不对，我让它按格式重发了一次…');
          continue;
        }
        setNote('它两次都没按动作格式回话，这次先算了（可以再问一次，或换个模型）', true);
        break;
      }
      if (!call) {
        history.push({ role: 'assistant', content: r.text || '（模型返回了空内容）' });
        /* 被截断要如实说 —— 用户 2026-09-26 报「输出被截断了」时界面上什么都没有 */
        if (r.truncated) setNote('回复被模型的输出上限截断了（' + (r.model || '模型') + '）：说「接着说」可以续', true);
        else setNote(r.model === 'mock' ? '' : r.model ? '模型：' + r.model : '');
        break;
      }
      history.push({ role: 'assistant', content: r.text });
      if (isWriteTool(call.tool)) {
        handleWrite(call);
        break;
      }
      const out = runReadTool(call, store);
      history.push({ role: 'user', content: `【动作结果：${call.tool}】\n${out}` });
      renderMsgs();
      if (round === MAX_ROUNDS) setNote('动作调了几轮了，先停一下', true);
    }
    persist();
  } catch (e) {
    /* 报错**不进历史**（否则会被反复喂回模型），只在面板底部提示 */
    live?.remove();
    setNote('出错：' + (e instanceof Error ? e.message : String(e)) + '（检查设置里的 AI 模式与模型）', true);
  }
  busy = false;
  renderMsgs();
}

/* ── 从对话里总结偏好 ─────────────────────────────────────────────── */
async function summarize(): Promise<void> {
  if (busy || !openEl) return;
  if (!history.length) {
    setNote('还没聊过，没什么可总结的', true);
    return;
  }
  busy = true;
  setNote('正在读对话、总结偏好…');
  try {
    const cands = await summarizePrefs(history);
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
  mode = 'chat';
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
  el.querySelector('#lk-agent-msgs')?.addEventListener('click', onCardClick);
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
  if (ta) ta.focus();
  window.dispatchEvent(new CustomEvent('lingkuang-panel', { detail: { id: 'agent', open: true } }));
  return () => closeAgentPanel();
}

export function toggleAgentPanel(s: Store): void {
  if (isAgentPanelOpen()) closeAgentPanel();
  else openAgentPanel(s);
}
