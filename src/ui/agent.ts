/** 灵框 · 助手面板（Ctrl+K 呼出 / 左栏「助手」按钮）。
 *
 *  形态：**右侧停靠**，不是设置那种全屏遮罩 —— 用户的原话是「主要工作还是在灵框内」，
 *  聊天时要能一边看着设定与正文改（遮罩会把主区盖住、点不动）。
 *
 *  它在 `src/tools/register.ts` 里登记为 `panel: true` 的工具，所以**完全不碰主区**
 *  （`openTool` 的面板分支不清 host、不建 `.lk-tool-slot`、不播错峰），
 *  需要时可以和设置面板同时开着 —— 两个面板各自 dispose，互不干扰。
 *
 *  片 1 只做：对话框 + 上下文注入 + 对话历史落盘 + Ctrl+K。
 *  长期记忆（偏好总结）与工具/权限在片 2 / 片 3。
 */
import { aiChat, type ChatMsg } from './ai';
import { buildContext, getAgentFocus } from './agent-context';
import { isImeEnter } from './keys';
import { escapeHtml } from './html';
import { loadSettings } from './settings';
import type { Store } from '../store/store';

const PANEL_ID = 'lk-agent-panel';
/** 送给模型的历史条数上限（再往前的靠「上下文」与将来的长期记忆，不靠堆对话） */
const HISTORY_SEND = 16;

const SYS_HEAD = [
  '你是「灵框」里的创作助手。灵框是世界观创作工作台：创作者在里面管理世界观、时间线事件、设定条目（角色/地点/物品/组织等）。',
  '工作方式：',
  '1. 用中文回答，简明扼要（默认 3-6 句；创作者说「展开」再展开）。',
  '2. 只依据下面「工作区现状」里给出的信息；没有的就直说没有、并指出可以去哪里补，不要编造设定。',
  '3. 提到设定时优先用现状里的原名与年份，别改名。',
  '4. 你暂时不能直接改稿子（改稿能力在后续版本，且会先征得创作者同意）——请把建议写成可以直接抄走的一段话。',
].join('\n');

let openEl: HTMLElement | null = null;
let store: Store | null = null;
let disposeAll: (() => void) | null = null;
let history: ChatMsg[] = [];
let loaded = false;
let busy = false;

const api = (): any => (window as any).lingkuangAPI;

export function isAgentPanelOpen(): boolean {
  return !!openEl && document.body.contains(openEl);
}

/* ── 历史落盘（主进程 `agent:load` / `agent:save`；放文件不放 localStorage：
      这是创作者资产，要能备份、能查看、能手改） ────────────────────── */
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
  } catch {
    /* 读不到就从空开始，不挡对话 */
  }
}

function persist(): void {
  try {
    void api()?.agentSave?.({ chat: history });
  } catch {
    /* 落盘失败不该影响这一次对话 */
  }
}

/* ── 渲染 ─────────────────────────────────────────────────────────── */
function msgHtml(m: ChatMsg): string {
  const who = m.role === 'user' ? 'is-user' : 'is-ai';
  return `<div class="lk-agent__msg ${who}"><div class="lk-agent__bubble">${escapeHtml(m.content)}</div></div>`;
}

function renderMsgs(): void {
  const box = openEl?.querySelector('#lk-agent-msgs');
  if (!box) return;
  box.innerHTML = history.length
    ? history.map(msgHtml).join('')
    : '<div class="lk-agent__empty">问点什么吧。比如「这条时间线的冲突还缺什么」「帮我把正在编的那条设定写细一点」。</div>';
  box.scrollTop = box.scrollHeight;
}

function renderMeta(): void {
  if (!openEl) return;
  const cfg = loadSettings();
  const chip = openEl.querySelector('#lk-agent-model');
  if (chip) chip.textContent = `${cfg.aiMode === 'api' ? 'API' : '本地'} · ${cfg.model}`;
  const f = getAgentFocus();
  const fchip = openEl.querySelector('#lk-agent-focus');
  if (fchip) fchip.textContent = f ? (f.kind === 'entity' ? `正在编：${f.title}` : `正在编事件：${f.title}`) : '没打开条目';
}

function renderCtx(): void {
  const pre = openEl?.querySelector('#lk-agent-ctx');
  if (!pre || !store) return;
  pre.textContent = buildContext(store);
}

function setNote(text: string, isErr = false): void {
  const el = openEl?.querySelector('#lk-agent-note');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-err', isErr);
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
  const msgs: ChatMsg[] = [
    { role: 'system', content: SYS_HEAD + '\n\n【工作区现状】\n' + buildContext(store) },
    ...history.slice(-HISTORY_SEND),
  ];
  try {
    const r = await aiChat(msgs, { temperature: 0.7, numPredict: 900 });
    history.push({ role: 'assistant', content: r.text || '（模型返回了空内容）' });
    setNote(r.model ? '模型：' + r.model : '');
    persist();
  } catch (e) {
    /* 报错**不进历史**（否则会被反复喂回模型），只在面板底部提示 */
    setNote('出错：' + (e instanceof Error ? e.message : String(e)) + '（检查设置里的 AI 模式与模型）', true);
  }
  busy = false;
  renderMsgs();
}

/* ── 开 / 关 ──────────────────────────────────────────────────────── */
export function closeAgentPanel(): void {
  if (!openEl) return;
  openEl.remove();
  openEl = null;
  store = null;
  disposeAll?.();
  disposeAll = null;
  window.dispatchEvent(new CustomEvent('lingkuang-panel', { detail: { id: 'agent', open: false } }));
}

export function openAgentPanel(s: Store): () => void {
  if (isAgentPanelOpen()) return () => closeAgentPanel();
  store = s;
  const cfg = loadSettings();
  const el = document.createElement('aside');
  el.id = PANEL_ID;
  el.className = 'lk-agent';
  el.setAttribute('role', 'dialog');
  el.innerHTML =
    '<div class="lk-agent__head">' +
      '<div class="lk-agent__title">灵框助手</div>' +
      '<div class="lk-agent__chips">' +
        `<span class="lk-agent__chip" id="lk-agent-model">${escapeHtml((cfg.aiMode === 'api' ? 'API' : '本地') + ' · ' + cfg.model)}</span>` +
        '<span class="lk-agent__chip is-focus" id="lk-agent-focus">没打开条目</span>' +
      '</div>' +
      '<button class="lk-agent__x" id="lk-agent-close" title="关闭（Esc）">×</button>' +
    '</div>' +
    '<details class="lk-agent__ctx"><summary>上下文（每次提问自动带上）</summary><pre id="lk-agent-ctx"></pre></details>' +
    '<div class="lk-agent__msgs" id="lk-agent-msgs"></div>' +
    '<div class="lk-agent__note" id="lk-agent-note"></div>' +
    '<div class="lk-agent__input">' +
      '<textarea id="lk-agent-input" rows="3" placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"></textarea>' +
      '<button class="lk-agent__send" id="lk-agent-send">发送</button>' +
    '</div>';
  document.body.appendChild(el);
  openEl = el;

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
  disposeAll = (): void => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('lingkuang-agent-focus', onFocus);
    unsub();
  };

  el.querySelector('#lk-agent-close')?.addEventListener('click', () => closeAgentPanel());
  el.querySelector('#lk-agent-send')?.addEventListener('click', () => { void send(); });
  const ta = el.querySelector<HTMLTextAreaElement>('#lk-agent-input');
  ta?.addEventListener('keydown', (e: KeyboardEvent) => {
    /* 中文输入法选词的回车不能当发送（复用 `src/ui/keys.ts` 的 isImeEnter） */
    if (e.key !== 'Enter' || e.shiftKey || isImeEnter(e)) return;
    e.preventDefault();
    void send();
  });

  renderMsgs();
  renderMeta();
  renderCtx();
  setNote('');
  void ensureLoaded().then(() => { renderMsgs(); });
  if (ta) ta.focus();
  window.dispatchEvent(new CustomEvent('lingkuang-panel', { detail: { id: 'agent', open: true } }));
  return () => closeAgentPanel();
}

export function toggleAgentPanel(s: Store): void {
  if (isAgentPanelOpen()) closeAgentPanel();
  else openAgentPanel(s);
}
