/** 节点详情面板（TS 版）——分区就地编辑：点哪块编辑哪块，点区域外 blur 自动保存 */
import type { Store } from '../store/store';
import type { TimelineNode } from '../store/types';
import { saveNodeDoc } from '../store/actions';
import { parseTimeText } from './node-form';

interface ParsedDoc {
  fields: { k: string; v: string }[];
  body: string;
  timeText: string | null;
}

export function parseDoc(doc: string | undefined): ParsedDoc {
  const fields: { k: string; v: string }[] = [];
  const bodyLines: string[] = [];
  let timeText: string | null = null;
  String(doc || '')
    .split('\n')
    .forEach((line) => {
      const m = line.match(/^#\s*([^：:]+)[：:]\s*(.*)$/);
      if (m && m[1].trim()) {
        if (m[1].trim() === '时间') timeText = m[2].trim();
        fields.push({ k: m[1].trim(), v: m[2].trim() });
      } else bodyLines.push(line);
    });
  return { fields, body: bodyLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), timeText };
}

export function fmtNodeTime(n: TimelineNode): string {
  const yr = Math.floor(n.year + 1e-9);
  const frac = n.year - yr;
  if (n.precision === 'year' || frac <= 0.001) return `${yr}年`;
  const month = Math.floor(frac * 12) + 1;
  const rem = (frac * 12 - (month - 1)) * 30;
  const day = Math.floor(rem + 1e-6) + 1;
  let s = `${yr}年${month}月`;
  if (n.precision === 'day' || n.precision === 'hour' || n.precision === 'minute' || n.precision === 'second') s += `${day}日`;
  const dayFrac = rem - (day - 1);
  if (n.precision === 'hour' || n.precision === 'minute' || n.precision === 'second') {
    const hour = Math.floor(dayFrac * 24);
    const hourRem = (dayFrac * 24 - hour) * 60;
    const minute = Math.floor(hourRem + 1e-6);
    const second = Math.floor((hourRem - minute) * 60 + 1e-6);
    s += `${hour}时`;
    if (n.precision === 'minute' || n.precision === 'second') s += `${minute}分`;
    if (n.precision === 'second') s += `${second}秒`;
  }
  return s;
}

export function renderNodeDetail(
  store: Store,
  host: HTMLElement,
  node: TimelineNode,
  tlId?: string,
  onChanged?: () => void
): void {
  const { fields, body } = parseDoc(node.doc);
  const timeText = fields.find((f) => f.k === '时间')?.v ?? fmtNodeTime(node);
  const typeLabel = node.type === 'story_event' ? '剧情事件' : node.type === 'world_event' ? '世界事件' : node.type === 'loop-boundary' ? '循环边界' : '节点';

  function save() {
    if (tlId) saveNodeDoc(store, tlId, node.id, node.doc ?? '');
    store.update(() => {});
    if (onChanged) onChanged();
  }

  function renderView() {
    host.innerHTML = `
      <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;user-select:none;" id="d-view">
        <div style="display:flex;align-items:baseline;gap:8px;">
          <span id="d-t" style="font-size:15px;font-weight:600;color:var(--fg);cursor:text;">${node.title}</span>
          <span id="d-tm" style="font-size:var(--text-xs);color:var(--fg-2);font-family:var(--font-mono);cursor:text;">${timeText}</span>
          <button id="d-del" style="margin-left:auto;background:transparent;border:1px solid #c0392b;color:#c0392b;border-radius:var(--radius-sm);padding:3px 10px;font-size:var(--text-xs);cursor:pointer;align-self:baseline;">删除</button>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          <span id="d-ty" style="font-size:10px;color:var(--fg);background:rgba(158,194,98,.1);border:1px solid var(--border-soft);border-radius:var(--radius-pill);padding:1px 8px;cursor:pointer;">${typeLabel}</span>
        </div>
        <div id="d-d" style="font-size:var(--text-sm);color:var(--fg-2);line-height:1.6;border-left:2px solid var(--accent);padding-left:8px;cursor:text;min-height:18px;">${node.desc ? mdRender(node.desc) : '<span style="color:var(--fg-2);">(无描述)</span>'}</div>
        <div id="d-fields" style="display:flex;flex-direction:column;gap:6px;"></div>
        <div id="d-b" style="font-size:var(--text-sm);color:var(--fg);line-height:1.7;cursor:text;min-height:18px;">${body ? mdRender(body) : '<span style="color:var(--fg-2);">(空正文)</span>'}</div>
      </div>`;

    /* 分区就地编辑：点哪块 → 那块变输入框；blur（点击区域外）→ 保存恢复 */
    inlineEdit(host, '#d-t', { multi: false, get: () => node.title, set: (v) => { node.title = v.trim(); } });
    inlineEdit(host, '#d-d', { multi: true, get: () => node.desc || '', set: (v) => { node.desc = v.trim() || undefined; } });
    inlineEdit(host, '#d-b', { multi: true, get: () => node.doc || '', set: (v) => { node.doc = v; } });

    host.querySelector('#d-ty')?.addEventListener('click', () => {
      const sel = document.createElement('select');
      sel.innerHTML = `<option value="world_event"${node.type === 'world_event' ? ' selected' : ''}>世界事件</option><option value="story_event"${node.type === 'story_event' ? ' selected' : ''}>剧情事件</option>`;
      const slot = host.querySelector('#d-ty') as HTMLElement;
      slot.replaceWith(sel);
      sel.focus();
      sel.addEventListener('change', () => { node.type = sel.value as 'world_event' | 'story_event'; renderView(); save(); });
      sel.addEventListener('blur', () => { node.type = sel.value as 'world_event' | 'story_event'; renderView(); save(); });
    });

    /* 时间块：点击 → 输入框（parseTimeText），blur 保存 */
    const tmEl = host.querySelector('#d-tm') as HTMLElement | null;
    if (tmEl) {
      tmEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const inp = document.createElement('input');
        inp.value = timeText;
        inp.style.cssText = `background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-xs);font-family:var(--font-mono);outline:none;width:120px;`;
        tmEl.replaceWith(inp);
        inp.focus(); inp.select();
        inp.addEventListener('blur', () => {
          const p = parseTimeText(inp.value);
          if (p) { node.year = p.year; node.precision = p.precision; save(); }
          renderView();
        });
        inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') inp.blur(); });
      });
    }

    host.querySelector('#d-del')?.addEventListener('click', () => {
      if (!tlId) return;
      store.update((d) => {
        const tl = d.worldsets[store.activeWorld]?.timelines[tlId];
        if (tl) tl.nodes = tl.nodes.filter((x) => x.id !== node.id);
      });
      host.innerHTML = '';
      if (onChanged) onChanged();
    });

    const fieldsBox = host.querySelector('#d-fields') as HTMLElement;
    fields.forEach((f) => { fieldsBox.appendChild(makeFieldCard(f.k, f.v)); });
  }

  /** 内联编辑：点击元素切换为 input/textarea，blur 保存并恢复只读 */
  function inlineEdit(host: HTMLElement, sel: string, opts: { multi: boolean; get: () => string; set: (v: string) => void }) {
    const el = host.querySelector(sel) as HTMLElement | null;
    if (!el) return;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const input = document.createElement(opts.multi ? 'textarea' : 'input') as HTMLInputElement;
      input.value = opts.get();
      input.style.cssText = `width:100%;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 8px;font-size:${opts.multi ? 'var(--text-sm)' : '15px'};font-family:${opts.multi ? 'var(--font-mono)' : 'inherit'};line-height:1.6;outline:none;resize:vertical;`;
      if (!opts.multi) input.style.fontWeight = '600';
      el.replaceWith(input);
      input.focus();
      input.select();
      /* 点击区域外（blur）→ 保存 + 恢复只读 */
      input.addEventListener('blur', () => { opts.set(input.value); renderView(); save(); });
      input.addEventListener('keydown', (ev) => { if (!opts.multi && ev.key === 'Enter') input.blur(); });
    });
  }

  renderView();
}

function makeFieldCard(k: string, v: string): HTMLElement {
  const card = document.createElement('div');
  card.style.cssText = 'border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface);box-shadow:var(--elev-raised);overflow:hidden;';
  const head = document.createElement('div');
  head.style.cssText =
    'padding:3px 10px;font-size:11px;font-weight:500;font-family:var(--font-mono);border-bottom:1px solid var(--border-soft);background:var(--accent);color:var(--accent-on);';
  head.textContent = k;
  const val = document.createElement('div');
  val.style.cssText = 'padding:6px 10px;font-size:var(--text-sm);color:var(--fg);min-height:20px;outline:none;';
  val.textContent = v;
  card.appendChild(head);
  card.appendChild(val);
  return card;
}

/** 轻量 Markdown 渲染（**粗体** / #标题 / -列表 / 链接 / 代码，安全转义） */
export function mdRender(src: string): string {
  return escapeHtml(src)
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (/^#{1,3}\s/.test(t)) {
        const level = (t.match(/^#+/) || [''])[0].length;
        return `<div style="font-weight:600;font-size:${level === 1 ? 15 : 13}px;margin:6px 0 2px;color:var(--fg);">${t.replace(/^#+\s*/, '')}</div>`;
      }
      if (/^[-*]\s/.test(t)) return `<div style="padding-left:12px;position:relative;">${t.replace(/^[-*]\s*/, '')}</div>`;
      if (/^\d+[.、]\s/.test(t)) return `<div style="padding-left:12px;">${t.replace(/^\d+[.、]\s*/, '')}</div>`;
      return `<div>${t}</div>`;
    })
    .join('')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code style="background:var(--surface-2);padding:0 4px;border-radius:2px;font-family:var(--font-mono);font-size:12px;">$1</code>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" style="color:var(--accent);text-decoration:underline;">$1</a>');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
