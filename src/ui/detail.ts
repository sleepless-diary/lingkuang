/** 节点详情面板（TS 版）——文稿本体渲染：字段卡片 + 正文；逻辑照抄 legacy showDetail/parseDoc */
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
  /* 时分秒：月→1/12，日→1/360，时→1/8640，分→1/518400，秒→1/31104000 */
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
  const { fields } = parseDoc(node.doc);
  const timeText = fields.find((f) => f.k === '时间')?.v ?? fmtNodeTime(node);

  host.innerHTML = `
    <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <input id="d-title" type="text" value="${node.title}" placeholder="节点标题" style="flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:5px 8px;font-size:15px;font-weight:600;outline:none;"/>
        <span style="font-size:var(--text-xs);color:var(--fg-2);font-family:var(--font-mono);white-space:nowrap;">${timeText}</span>
        <button id="d-del" style="margin-left:auto;background:transparent;border:1px solid #c0392b;color:#c0392b;border-radius:var(--radius-sm);padding:3px 10px;font-size:var(--text-xs);cursor:pointer;white-space:nowrap;">删除</button>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        <span style="font-size:var(--text-xs);color:var(--fg-2);">类型</span>
        <select id="d-type" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 6px;font-size:var(--text-sm);outline:none;">
          <option value="world_event"${node.type === 'world_event' ? ' selected' : ''}>世界事件</option>
          <option value="story_event"${node.type === 'story_event' ? ' selected' : ''}>剧情事件</option>
        </select>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        <label style="font-size:var(--text-xs);color:var(--fg-2);">描述</label>
        <textarea id="d-desc" placeholder="描述（可留空）" style="width:100%;height:56px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:6px 8px;font-size:var(--text-sm);outline:none;resize:vertical;font-family:inherit;line-height:1.5;">${node.desc ?? ''}</textarea>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <span style="font-size:var(--text-xs);color:var(--fg-2);">时间</span>
        <input id="d-time" type="text" value="${timeText}" placeholder="312年7月15日 或 312-7-15" style="flex:1;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-sm);outline:none;"/>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        <label style="font-size:var(--text-xs);color:var(--fg-2);">正文（Markdown · #字段：值 行 + 正文）</label>
        <textarea id="d-doc" placeholder="#事件：&#10;节点正文…" style="width:100%;height:150px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:6px 8px;font-size:var(--text-sm);outline:none;resize:vertical;font-family:var(--font-mono);line-height:1.6;">${node.doc ?? ''}</textarea>
      </div>
      <div id="d-fields" style="display:flex;flex-direction:column;gap:6px;"></div>
    </div>`;

  /* 保存改动的节点属性：写回 node 字段 + store.subscribe 自动写 vault/JSON */
  function save() {
    if (tlId) saveNodeDoc(store, tlId, node.id, node.doc ?? '');
    if (onChanged) onChanged();
  }
  const titleInput = host.querySelector('#d-title') as HTMLInputElement;
  titleInput.addEventListener('change', () => { node.title = titleInput.value.trim(); store.update(() => {}); save(); });
  const typeSelect = host.querySelector('#d-type') as HTMLSelectElement;
  typeSelect.addEventListener('change', () => { node.type = typeSelect.value as 'world_event' | 'story_event'; store.update(() => {}); save(); });
  const descInput = host.querySelector('#d-desc') as HTMLTextAreaElement;
  descInput.addEventListener('change', () => { node.desc = descInput.value.trim() || undefined; store.update(() => {}); save(); });
  const timeInput = host.querySelector('#d-time') as HTMLInputElement;
  timeInput.addEventListener('change', () => {
    const p = parseTimeText(timeInput.value);
    if (p) { node.year = p.year; node.precision = p.precision; save(); }
    else if (timeInput.value.trim()) timeInput.value = fmtNodeTime(node);
  });
  const docBox = host.querySelector('#d-doc') as HTMLTextAreaElement;
  docBox.addEventListener('input', () => { node.doc = docBox.value; });
  docBox.addEventListener('blur', () => { if (tlId) saveNodeDoc(store, tlId, node.id, node.doc ?? ''); if (onChanged) onChanged(); });
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
  fields.forEach((f) => {
    fieldsBox.appendChild(makeFieldCard(f.k, f.v));
  });
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
