/** 节点详情面板（TS 版）——文稿本体渲染：字段卡片 + 正文；逻辑照抄 legacy showDetail/parseDoc */
import type { Store } from '../store/store';
import type { TimelineNode } from '../store/types';
import { saveNodeDoc } from '../store/actions';

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
  const y = Math.round(n.year * 100) / 100;
  const { month, day } = partsFromYear(n.year);
  const m = month ? `${month}月` : '';
  const d = day && month ? `${day}日` : '';
  return `${y}年${m}${d}`;
}

/** 从小数年份拆出月/日（旧数据时间 = year 小数，非独立字段） */
function partsFromYear(y: number): { month?: number; day?: number } {
  const frac = y - Math.floor(y);
  if (frac <= 0.001) return {};
  const month = Math.floor(frac * 12) + 1;
  const rem = (frac * 12 - (month - 1)) * 30;
  const day = Math.floor(rem + 1e-6) + 1;
  return { month: month > 12 ? undefined : month, day };
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
  const chips = [
    ...(node.tag ? [node.tag] : []),
    ...(node.people ?? []).map((p) => `人：${p}`),
    ...(node.places ?? []).map((p) => `地：${p}`),
  ];

  host.innerHTML = `
    <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;align-items:baseline;gap:8px;">
        <span style="font-size:15px;font-weight:600;color:var(--fg);">${node.title}</span>
        <span style="font-size:var(--text-xs);color:var(--fg-2);font-family:var(--font-mono);">${timeText}</span>
      </div>
      ${node.desc ? `<div style="font-size:var(--text-sm);color:var(--fg-2);line-height:1.6;border-left:2px solid var(--accent);padding-left:8px;">${mdRender(node.desc)}</div>` : ''}
      <div style="display:flex;gap:4px;flex-wrap:wrap;">${chips.map((c) => `<span style="font-size:10px;color:var(--accent);background:rgba(158,194,98,.1);border:1px solid var(--border-soft);border-radius:var(--radius-pill);padding:1px 8px;">${c}</span>`).join('')}</div>
      <div style="display:flex;gap:6px;align-items:center;">
        <span style="font-size:var(--text-xs);color:var(--fg-2);">时间</span>
        <input id="d-year" type="number" step="any" value="${node.year}" style="width:90px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-sm);outline:none;"/>
        <span style="font-size:var(--text-xs);color:var(--fg-2);">（小数=月日，如 312.5 = 6月）</span>
        <button id="d-del" style="margin-left:auto;background:transparent;border:1px solid #c0392b;color:#c0392b;border-radius:var(--radius-sm);padding:3px 10px;font-size:var(--text-xs);cursor:pointer;">删除</button>
      </div>
      <div id="d-fields" style="display:flex;flex-direction:column;gap:6px;"></div>
      <div id="d-body" style="font-size:var(--text-sm);color:var(--fg);line-height:1.7;"></div>
    </div>`;

  const bodyEl = host.querySelector('#d-body') as HTMLElement;
  bodyEl.innerHTML = body ? mdRender(body) : '<span style="color:var(--fg-2);">(空正文)</span>';

  const yearInput = host.querySelector('#d-year') as HTMLInputElement;
  yearInput.addEventListener('change', () => {
    const v = parseFloat(yearInput.value);
    if (Number.isFinite(v)) {
      node.year = v;
      if (tlId) saveNodeDoc(store, tlId, node.id, node.doc ?? '');
      if (onChanged) onChanged();
    }
  });
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
