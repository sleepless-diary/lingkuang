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
import { aiChat, type ChatMsg } from './ai';
import { isImeEnter } from './keys';
import { loadSettings } from './settings';
import { buildContext } from './agent-context';
import { renderRoleplay } from './roleplay';
import { renderTavern } from './tavern';
import {
  AI_SESSION_FRAME, adoptSessions, clearHistory, createSession, ensureSessionsLoaded, listSessions, linkSummary,
  markAutoNamed, pushMsg, removeSession, renameSession, sessionPrompt, setActiveSession, setSessionPersona,
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
      ], { model: MODEL, temperature: 0.3, numPredict: 24 });
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
    /* 系统提示 = 灵框是什么 + 这次会话的人设（或「没选人设」的反向约束）+ 当前工作区现状。
       工作区现状每次现拼，所以助手/会话看到的都是他此刻在编的东西。 */
    const sys = [AI_SESSION_FRAME, sessionPrompt(s, personaTextOf(store, s)), '【工作区现状】\n' + buildContext(store)].filter(Boolean).join('\n\n');
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
    /* 聊完这一轮看看要不要按内容起个名（设置里默认关；要发一次模型请求，所以只做一次） */
    void autoName(s);
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
