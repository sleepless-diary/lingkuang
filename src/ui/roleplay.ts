/** 角色扮演模块——AI 代入设定角色对话（用「设置 → 模型」里**当前在用**那家供应商与它选中的模型） */
import type { Store } from '../store/store';
import { aiChatStream, type ChatMsg } from './ai';
import { liveBubble, liveThink } from './chat-live';
import { mdToHtml } from './md';
import { isImeEnter } from './keys';
import { activeProviderProfile } from './settings';
import { providerSummary } from './ai-providers';

export function renderRoleplay(_store: Store, host: HTMLElement): void {
  host.style.overflow = 'auto';
  host.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;">
      <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border-soft);background:var(--surface-2);flex-shrink:0;">
        <span style="font-size:15px;font-weight:600;color:var(--fg);">角色扮演</span>
        <span id="rp-status" style="font-size:11px;color:var(--fg-2);">AI 代入角色对话 · ${providerSummary(activeProviderProfile())}</span>
        <span style="flex:1;"></span>
        <button id="rp-new" style="background:var(--surface);color:var(--fg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 10px;font-size:11px;cursor:pointer;">新会话</button>
      </div>
      <div style="padding:10px 14px;display:flex;flex-direction:column;gap:8px;flex-shrink:0;">
        <textarea id="rp-char" placeholder="角色设定（名称 + 性格/背景，如：艾琳，沉默寡言的天才炼金术士，对陌生人防备…）" style="width:100%;height:70px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:8px;font-size:var(--text-sm);outline:none;resize:vertical;font-family:var(--font-mono);"></textarea>
        <button id="rp-start" style="background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-sm);padding:7px;font-size:var(--text-sm);cursor:pointer;">开始扮演</button>
      </div>
      <div id="rp-log" style="flex:1;overflow:auto;padding:10px 14px;display:flex;flex-direction:column;gap:8px;min-height:0;"></div>
      <div style="padding:8px 14px;border-top:1px solid var(--border-soft);display:flex;gap:8px;flex-shrink:0;">
        <input id="rp-input" placeholder="对角色说话…" style="flex:1;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:8px;font-size:var(--text-sm);outline:none;" />
        <button id="rp-send" style="background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-sm);padding:8px 16px;font-size:var(--text-sm);cursor:pointer;">发送</button>
      </div>
    </div>`;

  const charBox = host.querySelector('#rp-char') as HTMLTextAreaElement;
  const startBtn = host.querySelector('#rp-start') as HTMLButtonElement;
  const log = host.querySelector('#rp-log') as HTMLElement;
  const input = host.querySelector('#rp-input') as HTMLInputElement;
  const sendBtn = host.querySelector('#rp-send') as HTMLButtonElement;
  const status = host.querySelector('#rp-status') as HTMLElement;
  let history: ChatMsg[] = [];
  let started = false;

  /* 气泡样式抽出来：一次性画（bubble）与流式画（liveBubble）必须是同一套排版 */
  const bubbleCss = (who: 'user' | 'ai'): string =>
    `max-width:80%;padding:8px 12px;border-radius:var(--radius-sm);font-size:var(--text-sm);line-height:1.6;white-space:pre-wrap;align-self:${who === 'user' ? 'flex-end' : 'flex-start'};background:${who === 'user' ? 'rgba(158,194,98,.15)' : 'var(--surface-2)'};border:1px solid var(--border-soft);color:var(--fg);`;

  function bubble(text: string, who: 'user' | 'ai') {
    const div = document.createElement('div');
    div.style.cssText = bubbleCss(who);
    /* AI 的回答过极简 markdown（2026-09-26 用户：「如 **文字** 这种」）；自己打的字当纯文本 */
    if (who === 'user') div.textContent = text;
    else { div.className = 'lk-md'; div.innerHTML = mdToHtml(text); }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  async function send() {
    const msg = input.value.trim();
    if (!msg || !started) return;
    input.value = '';
    bubble(msg, 'user');
    history.push({ role: 'user', content: msg });
    /* 流式：边生成边写进气泡（用户 2026-09-26「我想要流式输出」）；输出不再设 400 上限 */
    /* 模型自己的思考过程（用户 2026-09-26「看不到他的思考诶」）—— 先挂它，气泡随后 ⇒ 思考在正文**上面**；
       只有模型真吐 reasoning 时才留下（`finish()` 里空思考会自己摘掉） */
    const think = liveThink(log, { scroll: log });
    const live = liveBubble(log, { bodyClass: 'lk-md', bodyStyle: bubbleCss('ai'), scroll: log });
    live.placeholder('思考中…');
    try {
      status.textContent = 'AI 思考中…';
      const reply = await aiChatStream(history, { temperature: 0.9, onDelta: (d) => live.push(d), onReasoning: (d) => think.push(d) });
      live.finish(reply.text || '(空回复)');
      think.finish(reply.reasoning);
      history.push({ role: 'assistant', content: reply.text });
    } catch (e) {
      live.remove();
      bubble('⚠️ AI 调用失败：' + (e instanceof Error ? e.message : String(e)), 'ai');
    } finally {
      status.textContent = 'AI 代入角色对话 · ' + providerSummary(activeProviderProfile());
    }
  }

  startBtn.addEventListener('click', () => {
    const charSetting = charBox.value.trim();
    if (!charSetting) { status.textContent = '请先填角色设定'; return; }
    history = [{ role: 'system', content: `你正在扮演角色扮演中的角色。角色设定如下：\n${charSetting}\n请完全代入该角色，用符合角色性格/背景的第一人称回应对方，保持角色一致，不要跳出角色。` }];
    started = true;
    log.innerHTML = '';
    bubble('（角色扮演开始，以「' + charSetting.split(/[，,\n]/)[0] + '」的身份回应）', 'ai');
    input.placeholder = '对角色说话…';
    status.textContent = '角色扮演中 · ' + providerSummary(activeProviderProfile());
  });

  sendBtn.addEventListener('click', send);
  /* 输入法用回车「上屏候选词」，那不是发送：send() 还会顺手清空输入框，
     不拦掉等于一边上屏一边发送，未上屏内容直接丢。 */
  input.addEventListener('keydown', (e) => { if (e.key !== 'Enter' || isImeEnter(e)) return; send(); });
  host.querySelector('#rp-new')?.addEventListener('click', () => {
    started = false; history = []; log.innerHTML = '';
    input.placeholder = '对角色说话…';
    status.textContent = 'AI 代入角色对话 · ' + providerSummary(activeProviderProfile());
  });
}
