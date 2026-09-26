/** AI 工作台——**多会话对话**（第 3.4 片）+ 角色扮演 / 酒馆剧情推演入口。
 *
 * 用户 2026-09-18：「**有会话管理的那种，选定一个主会话，其他会话可以作为角色或者不同视角，
 * 酒馆就是连接不同的会话，剧情推演就是加一个主控会话**」。
 * 已定：① 每个会话各自一份独立历史，「连接」= 把被连会话最近若干条拼进系统提示（`linkTail`）；
 * ② 界面 = 左边一列会话（新建 / 重命名 / 删除 / 选中 / 连接）+ 右边对话。
 * 会话的存储与纯逻辑在 `src/ui/ai-sessions.ts`（落 `agent/sessions.json`，裸数组）。
 */
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import { entityTypeOf } from '../store/entities';
import type { Entity } from '../store/types';
import { aiChat, aiChatStream, type ChatMsg } from './ai';
import { liveBubble, liveThink, thinkBlockHtml } from './chat-live';
import { mdToHtml } from './md';
import { isImeEnter } from './keys';
import { activeProviderProfile, loadSettings } from './settings';
import { providerSummary } from './ai-providers';
import { buildContext } from './agent-context';
import { renderRoleplay } from './roleplay';
import { renderTavern } from './tavern';
/* ⭐ 2C：主会话与 Ctrl+K 的助手是**同一格会话、同一套能力** ⇒ 这一页直接用助手那一套：
   `runTurn()`（一次提问的共用实现）+ `cardsHtml()` / `agentCardClick`（提议卡片）
   + `getAgentMode()` / `setAgentMode()`（模式开关，两个入口共享一份状态）。 */
import { RESULT_RE, agentCallRow, agentCardClick, cardsHtml, getAgentMode, isAgentRunning, runTurn, setAgentMode } from './agent';
import {
  AI_SESSION_FRAME, adoptSessions, clearHistory, createSession, ensureSessionsLoaded, listSessions, linkSummary,
  markAutoNamed, pushMsg, removeSession, renameSession, sessionPrompt, setActiveSession, setSessionPersona,
  setSessionSink, toggleLink, activeSession, isLinked,
  type AiSession, type SessionRole,
} from './ai-sessions';

const api = (): any => (window as any).lingkuangAPI ?? {};

/* 跨入口同步用的监听（见 renderAiWorkbench 尾部）：换工具重挂时必须先摘掉旧的，别越积越多 */
let sessionWatch: (() => void) | null = null;
/* 2C：卡片状态（`lingkuang-agent-cards`）与模式（`lingkuang-agent-mode`）的监听 —— 同一条纪律 */
let agentWatch: { off: () => void } | null = null;

const BTN = 'background:var(--surface-2);border:1px solid var(--border-strong);border-radius:var(--radius-sm);color:var(--fg-2);font-size:12px;padding:3px 8px;cursor:pointer;';
const INPUT = 'background:var(--surface-2);border:1px solid var(--border-strong);border-radius:var(--radius-sm);color:var(--fg);font-size:12px;padding:4px 7px;font-family:inherit;';

export function renderAiWorkbench(store: Store, host: HTMLElement): void {
  host.style.overflow = 'hidden';
  host.innerHTML =
    '<div style="display:flex;height:100%;">' +
      '<div style="width:210px;flex:0 0 210px;border-right:1px solid var(--border);display:flex;flex-direction:column;">' +
        '<div style="padding:10px 10px 6px;font-size:13px;font-weight:600;color:var(--fg);">会话</div>' +
        '<div style="padding:0 10px 8px;display:flex;gap:4px;">' +
          `<input id="ai-new-name" placeholder="新会话名字" style="flex:1;min-width:0;${INPUT}">` +
          `<select id="ai-new-role" style="${INPUT}">` +
            '<option value="character">角色</option><option value="perspective">视角</option><option value="director">主控</option>' +
          '</select>' +
        '</div>' +
        '<div style="padding:0 10px 8px;"><button id="ai-new" style="width:100%;' + BTN + '">＋ 新建会话</button></div>' +
        '<div id="ai-sess" style="flex:1;overflow-y:auto;padding:0 6px 8px;"></div>' +
        '<div style="border-top:1px solid var(--border);padding:8px 10px;display:flex;gap:6px;">' +
          `<button id="ai-open-roleplay" style="${BTN}">角色扮演</button>` +
          `<button id="ai-open-tavern" style="${BTN}">酒馆推演</button>` +
        '</div>' +
      '</div>' +
      '<div style="flex:1;min-width:0;display:flex;flex-direction:column;">' +
        '<div id="ai-head" style="padding:10px 14px 6px;border-bottom:1px solid var(--border);"></div>' +
        '<div id="ai-log" style="flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:8px;"></div>' +
        '<div id="ai-note" style="padding:0 14px;font-size:11px;color:var(--fg-2);min-height:15px;"></div>' +
        '<div style="padding:8px 14px 12px;display:flex;gap:6px;">' +
          `<textarea id="ai-input" rows="2" placeholder="说点什么…（Enter 发送，Shift+Enter 换行）" style="flex:1;min-width:0;resize:none;${INPUT}"></textarea>` +
          `<button id="ai-send" style="${BTN}color:var(--accent);border-color:var(--accent);">发送</button>` +
        '</div>' +
      '</div>' +
    '</div>';

  const listEl = host.querySelector('#ai-sess') as HTMLElement;
  const logEl = host.querySelector('#ai-log') as HTMLElement;
  const headEl = host.querySelector('#ai-head') as HTMLElement;
  const noteEl = host.querySelector('#ai-note') as HTMLElement;
  const inputEl = host.querySelector('#ai-input') as HTMLTextAreaElement;
  let busy = false;
  let saveTimer = 0;

  /* 落盘只有一个口子（和助手同一条教训：各模块各持一份迟早写歪）；节流 400ms */
  setSessionSink((sessions) => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { void api().agentSave?.({ sessions }); }, 400);
  });

  const setNote = (t: string, err = false): void => {
    noteEl.textContent = t;
    noteEl.style.color = err ? 'var(--danger)' : 'var(--fg-2)';
  };

  const renderHead = (): void => {
    const s = activeSession();
    if (!s) { headEl.innerHTML = ''; return; }
    headEl.innerHTML =
      `<span style="font-size:14px;font-weight:600;color:var(--fg);">${esc(s.name)}</span>` +
      /* ⚠️ 角色 chip 与下面那句「＝ Ctrl+K…」都**不再是荧光绿**（用户 2026-09-26：「这里面有三处荧光绿」）：
         这两处只是**说明**（这一格是什么角色 / 它与助手共用同一份对话），而这一头唯一该被
         看见的是**当前模式那个按钮**（`--accent` 的语义 = 唯一该看的东西）。chip 现在与助手
         浮层的 `.lk-agent__chip` 同款（`--fg-2` 文字 + `--border-strong` 边）。
         守卫：`tools/e2e/agent-main-session.cjs` ★13（数 `#ai-head` 里的 accent 元素，只许一个）。 */
      `<span style="font-size:11px;color:var(--fg-2);border:1px solid var(--border-strong);border-radius:var(--radius-pill);padding:1px 7px;margin-left:7px;">${roleOfLabel(s)}</span>` +
      `<span style="font-size:11px;color:var(--fg-2);margin-left:8px;">${esc(linkSummary(s))}</span>` +
      `<span style="font-size:11px;color:var(--fg-2);margin-left:8px;">${s.history.length} 条</span>` +
      (s.role === 'main' ? '<span style="font-size:11px;color:var(--fg-2);margin-left:8px;">＝ Ctrl+K 的灵框助手（同一份对话）</span>' : '') +
      /* ⭐ 2C：模式开关在 AI 页也要有 —— 两个入口**共享一份状态**，在哪儿切都算数
         （`setAgentMode` 广播 `lingkuang-agent-mode`，助手那层浮层当场跟上）。 */
      (s.role === 'main'
        ? '<div style="margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
            '<span style="font-size:11px;color:var(--fg-2);">模式</span>' +
            `<button id="lk-ai-mode-chat" style="${BTN}${getAgentMode() === 'chat' ? 'color:var(--accent);border-color:var(--accent);' : ''}">聊天</button>` +
            `<button id="lk-ai-mode-agent" style="${BTN}${getAgentMode() === 'agent' ? 'color:var(--accent);border-color:var(--accent);' : ''}">Agent</button>` +
            '<span style="font-size:11px;color:var(--fg-2);">' +
              (getAgentMode() === 'agent'
                ? 'Agent：能连着走多步、可批量改（写入按两把权限旋钮走）'
                : '聊天：能查也能改，一次只做一个动作') +
            '</span>' +
          '</div>'
        : '') +
      `<span style="font-size:11px;color:var(--fg-2);margin-left:10px;">人设</span>` +
      `<select id="ai-persona" style="${INPUT}margin-left:5px;max-width:190px;">` + personaOptions(store, s.personaId ?? '') + '</select>' +
      `<button id="ai-clear" style="margin-left:6px;${BTN}">清空对话</button>` +
      '<div style="font-size:11px;color:var(--fg-2);margin-top:4px;">人设就是设定库里的一条：改人设去「设定库」改那条角色，这里只选人（内容每次发消息时现取）。</div>';
    headEl.querySelector('#ai-clear')?.addEventListener('click', () => {
      if (!window.confirm(`清空「${s.name}」的对话？只清这一个会话。`)) return;
      clearHistory(s.id);
      renderLog(); renderHead();
      setNote('已清空');
    });
    (headEl.querySelector('#ai-persona') as HTMLSelectElement | null)?.addEventListener('change', (e) => {
      const pid = (e.target as HTMLSelectElement).value;
      /* 用户 2026-09-18：「启用人设的会话名就是该人名」⇒ 把实体名一起传进去，选了就改名 */
      setSessionPersona(s.id, pid, entityNameOf(store, pid));
      renderAll();
      setNote(pid ? '人设已选：会话名跟着改成那条角色的名字，人设正文每次发消息时现取' : '已取消人设（名字留着）');
    });
    /* 2C：模式开关（只有主会话有这两个按钮；点了就广播，助手浮层跟着变） */
    headEl.querySelector('#lk-ai-mode-chat')?.addEventListener('click', () => { setAgentMode('chat'); renderHead(); });
    headEl.querySelector('#lk-ai-mode-agent')?.addEventListener('click', () => { setAgentMode('agent'); renderHead(); });
  };

  const renderLog = (): void => {
    const s = activeSession();
    if (!s || !s.history.length) {
      logEl.innerHTML = '<div style="font-size:12px;color:var(--fg-2);line-height:1.9;">还没有对话。<br>直接说点什么，或者先给这个会话写一段「角色设定」。</div>';
      return;
    }
    logEl.innerHTML = s.history.map((m) => {
      /* ⭐ 2026-09-26：这一格可能与**助手**共用历史（`role:'main'` 就是 Ctrl+K 的灵框助手），
         两类「系统痕迹」不能画成聊天气泡 —— ① 分割线 `div:true`；② `【动作结果：…】` 的系统回执
         （它的 role 是 user，照旧画就成了「创作者说过这句话」）。 */
      if (m.div === true) {
        return '<div data-k="div" style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--fg-2);">' +
          '<span style="flex:1;height:1px;background:var(--border-strong);"></span>上下文分割点' +
          '<span style="flex:1;height:1px;background:var(--border-strong);"></span></div>';
      }
      /* ⭐ 2C：主会话会真调动作 ⇒ 调用画成一行（与助手浮层同一个写法），别把 JSON 当聊天文字 */
      const callRow = agentCallRow(m);
      if (callRow) return callRow;
      if (m.role === 'user') {
        const receipt = RESULT_RE.exec(m.content);
        if (receipt) {
          return '<div data-k="receipt" style="max-width:78%;font-size:12px;color:var(--fg-2);background:var(--surface-2);' +
            'border:1px dashed var(--border-strong);border-radius:var(--radius-sm);padding:6px 9px;">' +
            '<div style="font-weight:600;">' + esc(receipt[1]) + '</div>' +
            '<pre style="margin:3px 0 0;white-space:pre-wrap;font-family:inherit;">' + esc(m.content.slice(receipt[0].length).trim()) + '</pre></div>';
        }
      }
      const mine = m.role === 'user';
      const bg = mine ? 'var(--accent)' : 'var(--surface-2)';
      const fg = mine ? 'var(--accent-on)' : 'var(--fg)';
      /* AI 那边过极简 markdown（2026-09-26 用户：「如 **文字** 这种」）；自己打的字当纯文本 */
      const inner = mine ? esc(m.content) : mdToHtml(m.content);
      /* 这一条当时的思考过程（用户 2026-09-26「看不到他的思考诶」）：折叠一块，排在气泡上面 ——
         与助手浮层同一种 DOM（`thinkBlockHtml()`），两个入口看起来才是同一位助手。 */
      const think = (!mine && m.reasoning) ? thinkBlockHtml(m.reasoning) : '';
      return think + `<div style="display:flex;${mine ? 'justify-content:flex-end;' : ''}">` +
        `<div class="${mine ? '' : 'lk-md '}"style="max-width:78%;white-space:${mine ? 'pre-wrap' : 'normal'};word-break:break-word;background:${bg};color:${fg};border-radius:var(--radius-sm);padding:7px 10px;font-size:13px;line-height:1.7;">${inner}</div></div>`;
    }).join('');
    /* ⭐ 2C：主会话的提议卡片画在这一格末尾 —— 与助手浮层是**同一份** `cards`
       （下标相同 ⇒ 在哪边点「应用」都算数，`agentCardClick` 也只有一个实现）。 */
    if (s.role === 'main') logEl.innerHTML += cardsHtml();
    logEl.scrollTop = logEl.scrollHeight;
  };

  const renderList = (): void => {
    const cur = activeSession();
    listEl.innerHTML = listSessions().map((s) => {
      const on = cur && s.id === cur.id;
      const linked = !on && isLinked(s.id);
      return '<div data-s="' + s.id + '" style="display:flex;align-items:center;gap:4px;padding:5px 7px;border-radius:var(--radius-sm);cursor:pointer;' +
        (on ? 'background:var(--surface-2);' : '') + '">' +
        `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;color:${on ? 'var(--fg)' : 'var(--fg-2)'};">${esc(s.name)}</span>` +
        `<span style="font-size:10px;color:var(--fg-2);">${roleOfLabel(s)}</span>` +
        (s.role === 'main' ? '' : `<button data-act="link" title="连进当前会话 / 断开" style="${BTN}padding:0 5px;${linked ? 'color:var(--accent);border-color:var(--accent);' : ''}">${linked ? '断' : '连'}</button>`) +
        (s.role === 'main' ? '' : `<button data-act="del" title="删除会话" style="${BTN}padding:0 5px;">×</button>`) +
        '</div>';
    }).join('');
  };

  const renderAll = (): void => { syncPersonaNames(store); renderList(); renderHead(); renderLog(); };

  /** 自动起名（设置里默认关）：只对「没选人设、还没起过、聊够 4 条」的会话做一次 —— 要发一次模型请求 */
  const autoName = async (s: AiSession): Promise<void> => {
    if (!loadSettings().aiAutoName || s.personaId || s.autoNamed) return;
    const real = s.history.filter((m) => m.role !== 'system');
    if (real.length < 4) return;
    markAutoNamed(s.id);
    try {
      const transcript = real.slice(-8).map((m) => (m.role === 'user' ? '创作者：' : 'AI：') + m.content.slice(0, 160)).join('\n');
      const r = await aiChat([
        { role: 'system', content: '给下面这段对话起一个 2~6 个字的短标题，直接输出标题本身：不要标点、不要引号、不要解释。' },
        { role: 'user', content: transcript },
      ], { temperature: 0.3, numPredict: 24 });
      const title = String(r.text || '').replace(/[\s\r\n"'「」『』《》【】。，、！？：；]/g, '').slice(0, 12);
      if (title) { renameSession(s.id, title); setNote('按内容起了个名字：' + title); }
    } catch {
      /* 起名失败不影响聊天（设置里可以关掉） */
    }
    renderAll();
  };

  listEl.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest('[data-s]') as HTMLElement | null;
    if (!row) return;
    const id = row.dataset.s as string;
    const act = (e.target as HTMLElement).dataset.act;
    const s = listSessions().find((x) => x.id === id);
    if (!s) return;
    if (act === 'link') { toggleLink(id); renderAll(); setNote(toggleLinkSummary(id)); return; }
    if (act === 'del') {
      if (!window.confirm(`删除会话「${s.name}」？这段对话会一起没。`)) return;
      removeSession(id); renderAll(); setNote('已删除「' + s.name + '」');
      return;
    }
    setActiveSession(id);
    renderAll();
  });

  /* 双击重命名（Electron 没有 window.prompt，所以就地换成输入框） */
  listEl.addEventListener('dblclick', (e) => {
    const row = (e.target as HTMLElement).closest('[data-s]') as HTMLElement | null;
    if (!row) return;
    const s = listSessions().find((x) => x.id === row.dataset.s);
    if (!s) return;
    const inp = document.createElement('input');
    inp.value = s.name;
    inp.style.cssText = INPUT + 'flex:1;min-width:0;';
    row.innerHTML = '';
    row.appendChild(inp);
    inp.focus();
    inp.select();
    let settled = false;
    const done = (): void => { if (settled) return; settled = true; renameSession(s.id, inp.value); renderAll(); };
    /* ⚠️ Enter 必须**直接**结算，不能只靠 `inp.blur()`：无焦点窗口（测试实例 `LINGKUANG_TEST_WINDOW_NOFOCUS=1`）
       里元素根本没拿到焦点，`blur()` 不派发事件 ⇒ 名字白改（2026-09-18 实测 ★5 挂在这）。 */
    inp.addEventListener('blur', done);
    inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); done(); } });
  });

  host.querySelector('#ai-new')?.addEventListener('click', () => {
    const nameEl = host.querySelector('#ai-new-name') as HTMLInputElement;
    const roleEl = host.querySelector('#ai-new-role') as HTMLSelectElement;
    createSession(nameEl.value, roleEl.value as SessionRole);
    nameEl.value = '';
    renderAll();
    setNote('新会话已建，左边选它、右边直接聊');
  });

  /* ⭐ 2C：主会话的发送**不再自己拼系统提示、自己调模型**，而是把这一轮交给助手那套共用实现
     （`runTurn`）—— 工具循环、动作协议、提议卡片、轮数分档（聊天 1 轮 / Agent 8 轮）、
     流式气泡全在一处。非主会话（角色 / 视角 / 主控）照旧：它们只演，不动手。 */
  const send = async (): Promise<void> => {
    const s = activeSession();
    /* 两个入口共用"正在跑"的标志：同一格会话不能在浮层和这一页同时跑两轮 */
    if (!s || busy || isAgentRunning()) return;
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    busy = true;
    const id = s.id;
    const isMain = s.role === 'main';
    const BUBBLE = 'max-width:78%;word-break:break-word;background:var(--surface-2);color:var(--fg);border-radius:var(--radius-sm);padding:7px 10px;font-size:13px;line-height:1.7;';
    try {
      if (isMain) {
        /* 宿主 = 这一页：气泡画进 `#ai-log`（用与下面同一条气泡样式），
           历史落 `agent/sessions.json` 的那条主会话，提示写底部那行；
           卡片由 `renderLog()` 末尾的 `cardsHtml()` 画出来。 */
        await runTurn(text, {
          box: logEl,
          bodyClass: 'lk-md',
          bodyStyle: BUBBLE,
          note: setNote,
          rerender: () => { if (activeSession()?.id === id) { renderLog(); renderHead(); } },
          push: (m) => pushMsg(id, m),
          store,
        });
      } else {
        pushMsg(id, { role: 'user', content: text });
        renderLog(); renderHead();
        setNote('在想…');
        /* 系统提示 = 灵框是什么 + 这次会话的人设（或「没选人设」的反向约束）+ 当前工作区现状。
           工作区现状每次现拼，所以助手/会话看到的都是他此刻在编的东西。 */
        const sys = [AI_SESSION_FRAME, sessionPrompt(s, personaTextOf(store, s)), '【工作区现状】\n' + buildContext(store)].filter(Boolean).join('\n\n');
        const msgs: ChatMsg[] = sys ? [{ role: 'system', content: sys }] : [];
        msgs.push(...s.history);
        /* 流式：边生成边写进气泡（用户 2026-09-26「我想要流式输出」）；输出不再设 500 上限 */
        /* 思考块：非主会话（角色/视角/主控）也一样 —— 会思考的模型在这一栏也该看得见它在想什么。
           先挂它 ⇒ 思考排在正文**上面**（与助手浮层、主会话同序） */
        const think = liveThink(logEl, { scroll: logEl });
        const live = liveBubble(logEl, {
          bodyClass: 'lk-md',
          bodyStyle: BUBBLE,
          scroll: logEl,
        });
        live.placeholder('在想…');
        try {
          const r = await aiChatStream(msgs, { temperature: 0.85, onDelta: (d) => live.push(d), onReasoning: (d) => think.push(d) });
          live.finish(r.text);
          think.finish(r.reasoning);
          pushMsg(id, { role: 'assistant', content: r.text, reasoning: r.reasoning });
          /* 被截断如实说（用户 2026-09-26 报「输出被截断了」） */
          if (r.truncated) setNote('回复被模型的输出上限截断了（' + r.model + '）：说「接着说」可以续', true);
          else setNote(r.model + ' · ' + (r.text.length) + ' 字');
        } catch (e) {
          live.remove();
          think.remove();
          setNote('出错了：' + (e instanceof Error ? e.message : String(e)), true);
        }
      }
    } catch (e) {
      /* `runTurn` 内部自己 catch 过；这里是宿主接线出问题时的兜底，别静默 */
      setNote('出错了：' + (e instanceof Error ? e.message : String(e)), true);
    }
    busy = false;
    if (activeSession()?.id === id) { renderLog(); renderHead(); }
    /* 聊完这一轮看看要不要按内容起个名（设置里默认关；要发一次模型请求，所以只做一次） */
    void autoName(s);
  };

  host.querySelector('#ai-send')?.addEventListener('click', () => { void send(); });
  /* 提议卡片的「应用」/「忽略」：与助手浮层**同一个**处理函数（事件委托，卡片跟着记录区重画） */
  logEl.addEventListener('click', agentCardClick);
  inputEl.addEventListener('keydown', (e) => {
    if (isImeEnter(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
  });

  host.querySelector('#ai-open-roleplay')?.addEventListener('click', () => renderRoleplay(store, host));
  host.querySelector('#ai-open-tavern')?.addEventListener('click', () => renderTavern(store, host));

  /* ⭐ 反向同步（用户 2026-09-26：「主会话和助手指向的是同一个会话」）：助手那层浮层往主会话里
     写了东西时，这一页得当场重画 —— 只共享数据、屏幕不跟，创作者会以为两边是两格。
     ⚠️ 正在生成时不重画（会抹掉自己那条流式气泡）；换工具重挂前先把旧监听摘掉。 */
  if (sessionWatch) window.removeEventListener('lingkuang-sessions', sessionWatch);
  sessionWatch = () => { if (!busy && document.body.contains(host)) { renderLog(); renderHead(); } };
  window.addEventListener('lingkuang-sessions', sessionWatch);
  /* ⭐ 2C：卡片状态与模式在两个入口之间同步 —— 助手浮层点了「应用」或切了模式，这一页当场跟上
     （同一格会话，屏幕不能各说各话）。换工具重挂前先把旧监听摘掉，别越积越多。 */
  if (agentWatch) agentWatch.off();
  const onCards = (e: Event): void => {
    if (busy || !document.body.contains(host)) return;
    renderLog(); renderHead();
    const n = (e as CustomEvent).detail?.note;
    if (typeof n === 'string' && n) setNote(n);
  };
  const onMode = (): void => { if (document.body.contains(host)) renderHead(); };
  window.addEventListener('lingkuang-agent-cards', onCards);
  window.addEventListener('lingkuang-agent-mode', onMode);
  agentWatch = {
    off: () => {
      window.removeEventListener('lingkuang-agent-cards', onCards);
      window.removeEventListener('lingkuang-agent-mode', onMode);
    },
  };

  setNote('正在读会话…');
  void ensureSessionsLoaded().then(() => {
    if (!listSessions().length) adoptSessions([]);
    renderAll();
    setNote(providerSummary(activeProviderProfile()) + ' · 会话存在 agent/sessions.json（能手看手改）');
    inputEl.focus();
  });
}

/** 人设下拉：设定库里的所有条目（带类型名）。用户 2026-09-18：「会话直接选择人设进行聊天」 */
function personaOptions(store: Store, cur: string): string {
  const ws = currentWorld(store);
  /* ⚠️ `Worldset.entities` 是 Record<string, Entity>（**不是数组**）—— 写成 [...entities] 会
     `TypeError: i is not iterable`（2026-09-18 实测：整个 renderHead 挂掉、右边全空）。 */
  const es = Object.values((ws?.entities ?? {}) as Record<string, Entity>);
  const out = ['<option value="">不选人设</option>'];
  for (const e of es) {
    const tn = entityTypeOf(ws, e)?.name ?? '';
    out.push(`<option value="${e.id}"${e.id === cur ? ' selected' : ''}>${esc(e.name)}${tn ? '（' + esc(tn) + '）' : ''}</option>`);
  }
  if (cur && !es.some((e) => e.id === cur)) out.push('<option value="" selected>（人设已不在设定库）</option>');
  return out.join('');
}

/** 人设正文**现取**（不给会话存副本）：字段 + 正文，就是设定库里那条角色此刻的样子 ——
 *  这样在设定库改了人设，会话里下一次发言立刻按新人设说。 */
function personaTextOf(store: Store, s: AiSession): string {
  if (!s.personaId) return '';
  const ws = currentWorld(store);
  const e = ((ws?.entities ?? {}) as Record<string, Entity>)[s.personaId];
  if (!e) return '';
  const tn = entityTypeOf(ws, e)?.name ?? '';
  const lines = [`【人设】${e.name}${tn ? '（' + tn + '）' : ''}`, `  文件：${ws?.name ?? ''}/_设定/${tn}/${e.name}.md`];
  const props = (e.properties ?? {}) as Record<string, unknown>;
  const kv = Object.keys(props).filter((k) => String(props[k] ?? '') !== '').map((k) => `${k}=${String(props[k])}`);
  if (kv.length) lines.push('  字段：' + kv.join('；'));
  const doc = String((e as any).doc ?? '').trim();
  if (doc) lines.push('  正文：' + doc.slice(0, 600));
  return lines.join('\n');
}

/** 会话名跟着人设走：选人设时已改名，这里再兜一次「设定库里那条角色改了名」的情况。 */
function syncPersonaNames(store: Store): void {
  for (const s of listSessions()) {
    if (!s.personaId) continue;
    const name = entityNameOf(store, s.personaId);
    if (name && name !== s.name) renameSession(s.id, name);
  }
}

/** 从设定库现取实体名（人设名 = 会话名） */
function entityNameOf(store: Store, id: string): string {
  if (!id) return '';
  const ws = currentWorld(store);
  const e = ((ws?.entities ?? {}) as Record<string, Entity>)[id];
  return e ? e.name : '';
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function roleOfLabel(s: AiSession): string {
  return s.role === 'main' ? '主' : s.role === 'character' ? '角' : s.role === 'director' ? '控' : '视';
}

function toggleLinkSummary(id: string): string {
  const s = listSessions().find((x) => x.id === id);
  const cur = activeSession();
  if (!s || !cur) return '';
  const on = (cur.links ?? []).indexOf(id) >= 0;
  return (on ? '已把「' : '已断开「') + s.name + '」';
}
