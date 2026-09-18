/** AI 工作台——**多会话对话**（第 3.4 片）+ 角色扮演 / 酒馆剧情推演入口。
 *
 * 用户 2026-09-18：「**有会话管理的那种，选定一个主会话，其他会话可以作为角色或者不同视角，
 * 酒馆就是连接不同的会话，剧情推演就是加一个主控会话**」。
 * 已定：① 每个会话各自一份独立历史，「连接」= 把被连会话最近若干条拼进系统提示（`linkTail`）；
 * ② 界面 = 左边一列会话（新建 / 重命名 / 删除 / 选中 / 连接）+ 右边对话。
 * 会话的存储与纯逻辑在 `src/ui/ai-sessions.ts`（落 `agent/sessions.json`，裸数组）。
 */
import type { Store } from '../store/store';
import { aiChat, type ChatMsg } from './ai';
import { isImeEnter } from './keys';
import { renderRoleplay } from './roleplay';
import { renderTavern } from './tavern';
import {
  adoptSessions, clearHistory, createSession, ensureSessionsLoaded, listSessions, linkSummary,
  persistSessions, pushMsg, removeSession, renameSession, sessionPrompt, setActiveSession,
  setSessionSink, toggleLink, activeSession, isLinked,
  type AiSession, type SessionRole,
} from './ai-sessions';

const MODEL = 'qwen3:14b';

const api = (): any => (window as any).lingkuangAPI ?? {};

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
      `<span style="font-size:11px;color:var(--accent);border:1px solid var(--accent);border-radius:var(--radius-pill);padding:1px 7px;margin-left:7px;">${roleOfLabel(s)}</span>` +
      `<span style="font-size:11px;color:var(--fg-2);margin-left:8px;">${esc(linkSummary(s))}</span>` +
      `<span style="font-size:11px;color:var(--fg-2);margin-left:8px;">${s.history.length} 条</span>` +
      `<button id="ai-edit-persona" style="margin-left:10px;${BTN}">角色设定</button>` +
      `<button id="ai-clear" style="margin-left:6px;${BTN}">清空对话</button>`;
    headEl.querySelector('#ai-clear')?.addEventListener('click', () => {
      if (!window.confirm(`清空「${s.name}」的对话？只清这一个会话。`)) return;
      clearHistory(s.id);
      renderLog(); renderHead();
      setNote('已清空');
    });
    headEl.querySelector('#ai-edit-persona')?.addEventListener('click', () => {
      const box = document.createElement('div');
      box.style.cssText = 'margin-top:8px;display:flex;gap:6px;';
      box.innerHTML = `<textarea id="ai-persona" rows="3" style="flex:1;min-width:0;resize:vertical;${INPUT}">${esc(s.persona ?? '')}</textarea>` +
        `<button id="ai-persona-ok" style="${BTN}">存</button>`;
      headEl.appendChild(box);
      (box.querySelector('#ai-persona') as HTMLTextAreaElement).focus();
      box.querySelector('#ai-persona-ok')?.addEventListener('click', () => {
        s.persona = (box.querySelector('#ai-persona') as HTMLTextAreaElement).value.trim();
        persistSessions();
        box.remove();
        renderHead();
        setNote('角色设定已存（进这个会话的系统提示）');
      });
    });
  };

  const renderLog = (): void => {
    const s = activeSession();
    if (!s || !s.history.length) {
      logEl.innerHTML = '<div style="font-size:12px;color:var(--fg-2);line-height:1.9;">还没有对话。<br>直接说点什么，或者先给这个会话写一段「角色设定」。</div>';
      return;
    }
    logEl.innerHTML = s.history.map((m) => {
      const mine = m.role === 'user';
      const bg = mine ? 'var(--accent)' : 'var(--surface-2)';
      const fg = mine ? 'var(--accent-on)' : 'var(--fg)';
      return `<div style="display:flex;${mine ? 'justify-content:flex-end;' : ''}">` +
        `<div style="max-width:78%;white-space:pre-wrap;word-break:break-word;background:${bg};color:${fg};border-radius:var(--radius-sm);padding:7px 10px;font-size:13px;line-height:1.7;">${esc(m.content)}</div></div>`;
    }).join('');
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

  const renderAll = (): void => { renderList(); renderHead(); renderLog(); };

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

  const send = async (): Promise<void> => {
    const s = activeSession();
    if (!s || busy) return;
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    busy = true;
    const id = s.id;
    pushMsg(id, { role: 'user', content: text });
    renderLog(); renderHead();
    setNote('在想…');
    const sys = sessionPrompt(s);
    const msgs: ChatMsg[] = sys ? [{ role: 'system', content: sys }] : [];
    msgs.push(...s.history);
    try {
      const r = await aiChat(msgs, { model: MODEL, temperature: 0.85, numPredict: 500 });
      pushMsg(id, { role: 'assistant', content: r.text });
      setNote((r.model || MODEL) + ' · ' + (r.text.length) + ' 字');
    } catch (e) {
      setNote('出错了：' + (e instanceof Error ? e.message : String(e)), true);
    }
    busy = false;
    if (activeSession()?.id === id) { renderLog(); renderHead(); }
  };

  host.querySelector('#ai-send')?.addEventListener('click', () => { void send(); });
  inputEl.addEventListener('keydown', (e) => {
    if (isImeEnter(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
  });

  host.querySelector('#ai-open-roleplay')?.addEventListener('click', () => renderRoleplay(store, host));
  host.querySelector('#ai-open-tavern')?.addEventListener('click', () => renderTavern(store, host));

  setNote('正在读会话…');
  void ensureSessionsLoaded().then(() => {
    if (!listSessions().length) adoptSessions([]);
    renderAll();
    setNote('本地 ' + MODEL + ' · 会话存在 agent/sessions.json（能手看手改）');
    inputEl.focus();
  });
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
