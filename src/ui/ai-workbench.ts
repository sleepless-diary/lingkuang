/** AI 工作台——角色扮演 / 酒馆剧情推演 / 联想（入口卡片选择） */
import type { Store } from '../store/store';
import { renderRoleplay } from './roleplay';
import { renderTavern } from './tavern';

export function renderAiWorkbench(store: Store, host: HTMLElement): void {
  host.style.overflow = 'auto';
  host.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;">
      <div style="padding:14px 16px 0;">
        <div style="font-size:17px;font-weight:600;color:var(--fg);">AI 工作台</div>
        <div style="font-size:12px;color:var(--fg-2);margin-top:4px;">本地 Ollama（qwen3:14b）· 免费 · 隐私本地</div>
      </div>
      <div id="ai-cards" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;padding:14px 16px;"></div>
    </div>`;

  const cards = host.querySelector('#ai-cards') as HTMLElement;
  const defs = [
    { id: 'roleplay', name: '角色扮演', desc: 'AI 代入设定角色对话，体验角色' },
    { id: 'tavern', name: '酒馆 · 剧情推演', desc: '基于剧情线推演下一步/分支走向' },
  ];
  cards.innerHTML = defs.map((d) => `
    <button data-ai="${d.id}" style="text-align:left;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--elev-raised);padding:14px;cursor:pointer;">
      <div style="font-size:14px;font-weight:600;color:var(--fg);margin-bottom:6px;">${d.name}</div>
      <div style="font-size:12px;color:var(--fg-2);line-height:1.6;">${d.desc}</div>
    </button>`).join('');

  cards.querySelectorAll('[data-ai]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = (el as HTMLElement).dataset.ai!;
      if (id === 'roleplay') renderRoleplay(store, host);
      else if (id === 'tavern') renderTavern(store, host);
    });
  });
}
