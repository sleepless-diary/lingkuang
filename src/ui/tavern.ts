/** 酒馆剧情推演模块——基于当前剧情线/时间线，AI 推演下一步剧情走向（分支选项） */
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import { aiChatStream } from './ai';
import { liveBubble } from './chat-live';
import { mdToHtml } from './md';
import { escapeHtml } from './html';
import { activeProviderProfile } from './settings';
import { providerSummary } from './ai-providers';

export function renderTavern(store: Store, host: HTMLElement): void {
  host.style.overflow = 'auto';
  host.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;">
      <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border-soft);background:var(--surface-2);flex-shrink:0;">
        <span style="font-size:15px;font-weight:600;color:var(--fg);">酒馆 · 剧情推演</span>
        <span id="tv-status" style="font-size:11px;color:var(--fg-2);">选择剧情线，AI 推演下一步走向</span>
      </div>
      <div style="padding:10px 14px;flex-shrink:0;">
        <select id="tv-tl" style="width:100%;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:5px 8px;font-size:var(--text-sm);outline:none;"></select>
      </div>
      <div id="tv-log" style="flex:1;overflow:auto;padding:10px 14px;display:flex;flex-direction:column;gap:8px;min-height:0;"></div>
      <div style="padding:8px 14px;border-top:1px solid var(--border-soft);display:flex;gap:8px;flex-shrink:0;">
        <button id="tv-sim" style="background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-sm);padding:8px 16px;font-size:var(--text-sm);cursor:pointer;">推演下一步</button>
        <button id="tv-branch" style="background:var(--surface);color:var(--fg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 16px;font-size:var(--text-sm);cursor:pointer;">生成分支选项</button>
      </div>
    </div>`;

  const sel = host.querySelector('#tv-tl') as HTMLSelectElement;
  const log = host.querySelector('#tv-log') as HTMLElement;
  const status = host.querySelector('#tv-status') as HTMLElement;

  /* 时间线一律「用的时候现取」，不存构建期快照：
     store.undo()/redo()（store.ts:58-69）与 vault 重载（main.ts:310）都是整体替换
     store.data，构建期抓到的 ws 会变成孤儿引用——撤销之后面板仍拿旧世界的数据推演。 */
  const tlList = () => {
    const ws = currentWorld(store);
    return (ws.order ?? []).filter((id) => ws.timelines[id]).map((id) => ws.timelines[id]);
  };
  const getTimeline = (id: string) => currentWorld(store).timelines[id];

  /* 填充剧情线（含时间线名 + 剧情线名） */
  function fillTlOptions(): void {
    const tls = tlList();
    sel.innerHTML = tls.length
      ? tls.map((tl) => `<option value="${escapeHtml(tl.id)}">${escapeHtml(tl.name)}（${tl.nodes.length} 节点）</option>`).join('')
      : '<option value="">（无时间线）</option>';
  }
  fillTlOptions();

  function contextFromTl(tlId: string): string {
    const tl = getTimeline(tlId);
    if (!tl) return '';
    const nodes = tl.nodes.map((n) => `${n.year} · ${n.title}`).join('\n');
    const lines = (tl.storylines || []).map((l) => `${l.name}: ${l.segments.map((s) => `${s.start}→${s.end === null ? '∞' : s.end}`).join(', ')}`).join('\n');
    return `时间线「${tl.name}」\n节点：\n${nodes || '（空）'}\n剧情线：\n${lines || '（无）'}`;
  }

  /* 气泡样式抽出来：一次性画（bubble）与流式画（liveBubble）同一套排版 */
  const bubbleCss = (who: 'ai' | 'user'): string =>
    `max-width:85%;padding:8px 12px;border-radius:var(--radius-sm);font-size:var(--text-sm);line-height:1.7;white-space:pre-wrap;align-self:${who === 'user' ? 'flex-end' : 'flex-start'};background:${who === 'user' ? 'rgba(158,194,98,.15)' : 'var(--surface-2)'};border:1px solid var(--border-soft);color:var(--fg);`;

  function bubble(text: string, who: 'ai' | 'user') {
    const div = document.createElement('div');
    div.style.cssText = bubbleCss(who);
    /* AI 的推演过极简 markdown（2026-09-26 用户：「如 **文字** 这种」） */
    if (who === 'user') div.textContent = text;
    else { div.className = 'lk-md'; div.innerHTML = mdToHtml(text); }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  async function run(mode: 'sim' | 'branch') {
    const tlId = sel.value;
    if (!tlId) { status.textContent = '请先选时间线'; return; }
    const context = contextFromTl(tlId);
    status.textContent = mode === 'sim' ? '正在推演下一步剧情…' : '正在生成分支选项…';
    /* 流式：边生成边写（用户 2026-09-26「我想要流式输出」）；输出不再设 500 上限 */
    const live = liveBubble(log, { bodyClass: 'lk-md', bodyStyle: bubbleCss('ai'), scroll: log });
    live.placeholder('推演中…');
    try {
      const instruction = mode === 'sim'
        ? `你是剧情推演引擎。基于下面的剧情线/时间线，推演"下一步最可能发生的事件"，用 2-4 句话描述，续写剧情。\n\n${context}`
        : `你是剧情推演引擎。基于下面的剧情线/时间线，给出 2-3 个不同的分支走向（每个分支一句话，用「分支N：」开头）。\n\n${context}`;
      const reply = await aiChatStream([{ role: 'user', content: instruction }], { temperature: mode === 'branch' ? 1.0 : 0.8, onDelta: (d) => live.push(d) });
      live.finish(reply.text || '(空回复)');
    } catch (e) {
      live.remove();
      bubble('⚠️ 推演失败：' + (e instanceof Error ? e.message : String(e)), 'ai');
    } finally {
      status.textContent = '酒馆剧情推演 · ' + providerSummary(activeProviderProfile());
    }
  }

  host.querySelector('#tv-sim')?.addEventListener('click', () => run('sim'));
  host.querySelector('#tv-branch')?.addEventListener('click', () => run('branch'));
}
