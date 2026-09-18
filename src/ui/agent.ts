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
 *  片 2（本片）：长期记忆（可见可改可总结）+ 三档权限骨架（`src/ui/agent-perm.ts`）。
 *  片 3：工具协议（文本 JSON 指令）+ 提议卡片 —— 那时才真正会改稿子。
 */
import { type ChatMsg } from './ai';
import { agentAsk } from './agent-model';
import { buildContext, getAgentFocus, isAgentFocusLive } from './agent-context';
import {
  addMemory, adoptFromDisk, getMemory, memoryPrompt, removeMemory,
  setMemorySink, summarizePrefs, updateMemory,
} from './agent-memory';
import { PERM_HINT, PERM_LABEL, gateWrite, getAgentPerm, permissionPrompt, setAgentPerm } from './agent-perm';
import { isWriteTool, looksLikeToolJson, parseToolCall, planWrite, runReadTool, toolsPrompt, type Proposal, type ToolCall } from './agent-tools';
import { isImeEnter } from './keys';
import { escapeHtml } from './html';
import { loadSettings, type AgentPerm } from './settings';
import type { Store } from '../store/store';

const PANEL_ID = 'lk-agent-panel';
/** 送给模型的历史条数上限（再往前的靠「上下文」与长期记忆，不靠堆对话） */
const HISTORY_SEND = 16;
const PERMS: AgentPerm[] = ['readonly', 'confirm', 'yolo'];

const SYS_HEAD = [
  '你是「灵框」里的创作助手。灵框是世界观创作工作台：创作者在里面管理世界观、时间线事件、设定条目（角色/地点/物品/组织等）。',
  '工作方式：',
  '1. 用中文回答，简明扼要（默认 3-6 句；创作者说「展开」再展开）。',
  '2. 只依据下面「工作区现状」里给出的信息；没有的就直说没有、并指出可以去哪里补，不要编造设定。',
  '3. 提到设定时优先用现状里的原名与年份，别改名。',
  '4. 沿用下面「创作者偏好」里的习惯（如果有）。',
  '5. 创作者说「这个 / 这条 / 当前 / 我现在打开的文件 / 这个面板」时，指的就是现状里【创作者此刻打开的那一条】；' +
    '回答要**点名那一条**（名字 + 它是什么），问文件就报它那一行「文件：」的路径。' +
    '若那一栏写着「没有」，就直接问他现在开的是哪一条，别拿世界名、时间线名糊弄过去。',
].join('\n');

let openEl: HTMLElement | null = null;
let store: Store | null = null;
let disposeAll: (() => void) | null = null;
let history: ChatMsg[] = [];
let loaded = false;
let busy = false;
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
async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const r = await api()?.agentLoad?.();
    if (r?.ok && Array.isArray(r.chat)) {
      history = r.chat
        .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m: any) => ({ role: m.role, content: m.content } as ChatMsg));
    }
    if (r?.ok) adoptFromDisk(r.memory);
  } catch {
    /* 读不到就从空开始，不挡对话 */
  }
}

function persist(): void {
  try {
    void api()?.agentSave?.({ chat: history, memory: getMemory() });
  } catch {
    /* 落盘失败不该影响这一次对话 */
  }
}

/* ── 渲染 ─────────────────────────────────────────────────────────── */
/* 动作的调用与结果都是**对话的一部分**（要喂回模型），但显示上不能混成聊天气泡：
   调用显示成一行「用到动作」，结果显示成一小块说明。 */
const RESULT_RE = /^【动作结果：([^】]+)】/;

function isCallMsg(m: ChatMsg): boolean {
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
  return `<div class="lk-agent__msg ${who}"><div class="lk-agent__bubble">${escapeHtml(m.content)}</div></div>`;
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
  const head = history.length
    ? history.map(msgHtml).join('')
    : '<div class="lk-agent__empty">问点什么吧。比如「这条时间线的冲突还缺什么」「帮我把正在编的那条设定写细一点」。</div>';
  box.innerHTML = head + cards.map((c, i) => cardHtml(i, c)).join('');
  box.scrollTop = box.scrollHeight;
}

function renderMeta(): void {
  if (!openEl) return;
  const cfg = loadSettings();
  const chip = openEl.querySelector('#lk-agent-model');
  if (chip) chip.textContent = `${cfg.aiMode === 'api' ? 'API' : '本地'} · ${cfg.model}`;
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

/* 权限：选了就存进设置（`lingkuang-settings`），并告诉模型它现在能动手到什么程度。
   面板根上挂 `data-gate`（deny/propose/allow）——片 3 的写工具执行前问 `gateWrite()`，
   e2e 也直接读这个属性（不必反射模块）。 */
function renderPerm(): void {
  if (!openEl) return;
  const p = getAgentPerm();
  const sel = openEl.querySelector<HTMLSelectElement>('#lk-agent-perm');
  if (sel && sel.value !== p) sel.value = p;
  const hint = openEl.querySelector('#lk-agent-perm-hint');
  if (hint) hint.textContent = PERM_HINT[p];
  openEl.dataset.gate = gateWrite();
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
    const r = plan.proposal.apply();
    history.push({ role: 'user', content: `【动作结果：${call.tool}】${r.note}` });
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
  const r = c.p.apply();
  c.done = r.note;
  history.push({ role: 'user', content: `【动作结果：${c.p.tool}】${r.note}` });
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
  const sys = [
    SYS_HEAD,
    permissionPrompt(),
    toolsPrompt(),
    memoryPrompt(),
    '【工作区现状】\n' + buildContext(store),
  ].filter(Boolean).join('\n\n');
  const cfg = { temperature: 0.7, numPredict: 900 };
  try {
    /* 一次提问 = 最多 MAX_ROUNDS 轮：模型要么说话（结束），要么要求一个只读动作
       （执行完把结果喂回去，让它接着说）。写入动作一轮就结束 —— 要么落盘要么等点击。 */
    let fixed = false; /* ⭐ 格式纠错只做一次，免得跟模型来回拉锯 */
    for (let round = 0; round <= MAX_ROUNDS; round++) {
      const msgs: ChatMsg[] = [{ role: 'system', content: sys }, ...history.slice(-HISTORY_SEND)];
      const r = await agentAsk(msgs, cfg);
      const call = parseToolCall(r.text);
      if (!call && looksLikeToolJson(r.text)) {
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
        setNote(r.model === 'mock' ? '' : r.model ? '模型：' + r.model : '');
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
  openEl.remove();
  openEl = null;
  store = null;
  draft = false;
  cards = [];
  setMemorySink(null);
  disposeAll?.();
  disposeAll = null;
  window.dispatchEvent(new CustomEvent('lingkuang-panel', { detail: { id: 'agent', open: false } }));
}

export function openAgentPanel(s: Store): () => void {
  if (isAgentPanelOpen()) return () => closeAgentPanel();
  store = s;
  const cfg = loadSettings();
  const perm = getAgentPerm();
  const el = document.createElement('aside');
  el.id = PANEL_ID;
  el.className = 'lk-agent';
  el.setAttribute('role', 'dialog');
  el.dataset.gate = gateWrite();
  el.innerHTML =
    '<div class="lk-agent__head">' +
      '<div class="lk-agent__title">灵框助手</div>' +
      '<div class="lk-agent__chips">' +
        `<span class="lk-agent__chip" id="lk-agent-model">${escapeHtml((cfg.aiMode === 'api' ? 'API' : '本地') + ' · ' + cfg.model)}</span>` +
        '<span class="lk-agent__chip is-focus" id="lk-agent-focus">没打开条目</span>' +
      '</div>' +
      '<button class="lk-agent__x" id="lk-agent-close" title="关闭（Esc）">×</button>' +
    '</div>' +
    '<div class="lk-agent__perm">' +
      '<span class="lk-agent__perm-lbl">权限</span>' +
      '<select class="lk-agent__perm-sel" id="lk-agent-perm">' +
        PERMS.map((p) => `<option value="${p}"${p === perm ? ' selected' : ''}>${PERM_LABEL[p]}</option>`).join('') +
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

  /* 权限三档 */
  const permSel = el.querySelector<HTMLSelectElement>('#lk-agent-perm');
  permSel?.addEventListener('change', () => {
    setAgentPerm(permSel.value as AgentPerm);
    renderPerm();
  });

  renderMsgs();
  renderMeta();
  renderCtx();
  renderMemory();
  renderPerm();
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
