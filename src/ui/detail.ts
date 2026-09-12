/** 节点详情面板（TS 版）——分区就地编辑：点哪块编辑哪块，点区域外 blur 自动保存 */
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import type { TimelineNode, TimePrecision } from '../store/types';
import { PRECISION_ORDER, PRECISION_LABELS } from '../store/types';
import { parseTimeText } from './node-form';
import { requestEyedrop } from './eyedrop';
import { escapeHtml } from './html';
import { isImeEnter } from './keys';
import { removeNode } from '../store/actions';
import { confirmDialog } from './confirm';

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
  const yr = n.year;
  const m = n.month, d = n.day, h = n.hour, mi = n.minute, s = n.second;
  let str = `${yr}年`;
  if (m !== undefined && m >= 1) str += `${m}月`;
  if (d !== undefined && d >= 1) str += `${d}日`;
  if (h !== undefined) str += `${h}时`;
  if (mi !== undefined) str += `${mi}分`;
  if (s !== undefined) str += `${s}秒`;
  return str;
}

/* 同一时刻只保留一个详情面板订阅。
   host（#lk-tool-host）是长生命周期容器、不会卸载：每次点节点都会重新调用
   renderNodeDetail。旧写法只靠 `!host.isConnected` 退订，而 host 永远连着，
   于是每点一个节点就永久多一个订阅——各自还持有当时那个 node 闭包，并且会在
   切到别的工具后把别人的面板覆盖掉。 */
let detailUnsub: (() => void) | null = null;

export function renderNodeDetail(
  store: Store,
  host: HTMLElement,
  node: TimelineNode,
  tlId?: string,
  onChanged?: () => void
): void {
  /** 时间部件名（月/日/时/分/秒）——精度下拉按档位决定显示哪几个 */
  type PartKey = 'month' | 'day' | 'hour' | 'minute' | 'second';
  /* 重新从 store 取最新节点（外部 vault 重载后传入引用会失效） */
  function freshNode(): TimelineNode | undefined {
    return store.data.worldsets[store.activeWorld]?.timelines[tlId ?? '']?.nodes.find((x) => x.id === node.id);
  }

  /* 把编辑作用到 store 里的「最新」节点上。
     不能沿用「改闭包里的 node，再把所有字段整体拷回 store」的写法：外部改动
     （Obsidian 编辑 vault / 编辑器重载）会用新的 worldsets 替换 store 数据，
     闭包里的 node 随即成为孤儿对象，整体拷贝会把别人的改动整片覆盖回旧值
     ——表现为「改一处，别处悄悄回滚」，且旧值会被写回 vault。 */
  function patch(fn: (n: TimelineNode) => void) {
    store.update((d) => {
      const n = d.worldsets[store.activeWorld]?.timelines[tlId ?? '']?.nodes.find((x) => x.id === node.id);
      if (n) fn(n);
    });
    if (onChanged) onChanged();
  }

  /** 读值一律走这里：外部重载后闭包里的 node 已失效 */
  const latest = (): TimelineNode => freshNode() ?? node;

  function renderView() {
    const cur = freshNode() ?? node;   /* 用最新节点渲染（Obsidian 改动后显示最新值） */
    const { fields, body } = parseDoc(cur.doc);
    const timeText = fields.find((f) => f.k === '时间')?.v ?? fmtNodeTime(cur);
    host.innerHTML = `
      <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;user-select:none;" id="d-view">
        <div style="display:flex;align-items:baseline;gap:8px;">
          <span id="d-t" style="font-size:15px;font-weight:600;color:var(--fg);cursor:text;">${escapeHtml(cur.title)}</span>
          <span id="d-tm" style="font-size:var(--text-xs);color:var(--fg-2);font-family:var(--font-mono);cursor:text;">${timeText}</span>
          <button id="d-del" style="margin-left:auto;background:transparent;border:1px solid #c0392b;color:#c0392b;border-radius:var(--radius-sm);padding:3px 10px;font-size:var(--text-xs);cursor:pointer;align-self:baseline;">删除</button>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          <span id="d-ty" style="font-size:10px;color:var(--fg);background:rgba(158,194,98,.1);border:1px solid var(--border-soft);border-radius:var(--radius-pill);padding:1px 8px;cursor:pointer;">${cur.type === 'story_event' ? '剧情事件' : cur.type === 'world_event' ? '世界事件' : cur.type === 'loop-boundary' ? '循环边界' : '节点'}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
          <span style="font-size:var(--text-xs);color:var(--fg-2);">精度</span>
          <select id="d-prec" title="这个节点的时间精确到哪一档（改档位会补/清对应的月日时分秒）" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:2px 5px;font-size:var(--text-xs);outline:none;cursor:pointer;">${PRECISION_ORDER.map((p) => `<option value="${p}"${(cur.precision ?? 'year') === p ? ' selected' : ''}>${PRECISION_LABELS[p]}</option>`).join('')}</select>
          <span id="d-parts" style="display:flex;gap:4px;align-items:center;"></span>
        </div>
        <div id="d-d" style="font-size:var(--text-sm);color:var(--fg-2);line-height:1.6;border-left:2px solid var(--accent);padding-left:8px;cursor:text;min-height:18px;">${cur.desc ? mdRender(cur.desc) : '<span style="color:var(--fg-2);">(无描述)</span>'}</div>
        <div id="d-fields" style="display:flex;flex-direction:column;gap:6px;"></div>
        <div id="d-causes" style="display:flex;flex-direction:column;gap:4px;border-top:1px dashed var(--border-soft);padding-top:6px;"></div>
        <div id="d-b" style="font-size:var(--text-sm);color:var(--fg);line-height:1.7;cursor:text;min-height:18px;">${body ? mdRender(body) : '<span style="color:var(--fg-2);">(空正文)</span>'}</div>
      </div>`;

    /* 分区就地编辑：点哪块 → 那块变输入框；blur（点击区域外）→ 保存恢复 */
    inlineEdit(host, '#d-t', { multi: false, get: () => latest().title, set: (v) => patch((n) => { n.title = v.trim(); }) });
    inlineEdit(host, '#d-d', { multi: true, get: () => latest().desc || '', set: (v) => patch((n) => { n.desc = v.trim() || undefined; }) });
    /* 正文编辑用原始 doc（含 `#字段：值` 行），字段行由上方字段区负责展示 */
    inlineEdit(host, '#d-b', { multi: true, get: () => latest().doc || '', set: (v) => patch((n) => { n.doc = v; }) });

    host.querySelector('#d-ty')?.addEventListener('click', () => {
      const sel = document.createElement('select');
      const t0 = latest().type;
      sel.innerHTML = `<option value="world_event"${t0 === 'world_event' ? ' selected' : ''}>世界事件</option><option value="story_event"${t0 === 'story_event' ? ' selected' : ''}>剧情事件</option>`;
      const slot = host.querySelector('#d-ty') as HTMLElement;
      slot.replaceWith(sel);
      sel.focus();
      sel.addEventListener('change', () => { patch((n) => { n.type = sel.value as 'world_event' | 'story_event'; }); renderView(); });
    });

    /* ── 时间精度：下拉选档 + 只显示该档需要的部件（照 legacy 的行为）──
       legacy（lingkuang.js:1971-2041）是「年份输入 + 精度下拉 + 月/日/时/分 按档位出现」，
       v3 重写时只留下了「点时间直接打字、精度从文字里推断」，把选择这一动作丢了。
       这里把它补回来，并与打字共存：打字（parseTimeText）也会改精度，重渲染后下拉自动跟随。 */
    const precSel = host.querySelector('#d-prec') as HTMLSelectElement | null;
    const partsEl = host.querySelector('#d-parts') as HTMLElement | null;
    if (partsEl) {
      const idx = PRECISION_ORDER.indexOf((cur.precision ?? 'year') as TimePrecision);
      const parts: { key: PartKey; label: string; v?: number }[] = [
        { key: 'month', label: '月', v: cur.month },
        { key: 'day', label: '日', v: cur.day },
        { key: 'hour', label: '时', v: cur.hour },
        { key: 'minute', label: '分', v: cur.minute },
        { key: 'second', label: '秒', v: cur.second },
      ];
      /* 精度 = 年（大多数节点）时一个部件框都不出现，面板不会变高 */
      partsEl.innerHTML = parts
        .filter((_, i) => idx >= i + 1)
        .map((p) => `<input data-part="${p.key}" type="number" value="${p.v ?? ''}" title="${p.label}" style="width:46px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:2px 4px;font-size:var(--text-xs);font-family:var(--font-mono);outline:none;user-select:text;"/><span style="font-size:10px;color:var(--fg-2);">${p.label}</span>`)
        .join('');
      partsEl.querySelectorAll<HTMLInputElement>('input[data-part]').forEach((inp) => {
        const commit = () => {
          const key = inp.dataset.part as PartKey;
          const raw = inp.value.trim();
          const num = raw === '' ? NaN : parseInt(raw, 10);
          const val = Number.isFinite(num) ? num : undefined;
          patch((n) => {
            /* 时分秒的 0 是合法值：这里不能写 `parseInt(...) || undefined`（会把 0 清掉） */
            if (key === 'month') n.month = val;
            else if (key === 'day') n.day = val;
            else if (key === 'hour') n.hour = val;
            else if (key === 'minute') n.minute = val;
            else n.second = val;
          });
          /* 只刷新那行时间文字，不整块重渲染 —— 否则在几个部件框之间 Tab 切换会被打断 */
          const tm = host.querySelector('#d-tm');
          const nc = freshNode();
          if (tm && nc) tm.textContent = parseDoc(nc.doc).timeText ?? fmtNodeTime(nc);
        };
        inp.addEventListener('change', commit);
        inp.addEventListener('blur', commit);
        inp.addEventListener('keydown', (ev) => { if (ev.key !== 'Enter' || isImeEnter(ev)) return; inp.blur(); });
      });
    }
    precSel?.addEventListener('change', () => {
      const want = precSel.value as TimePrecision;
      const wi = PRECISION_ORDER.indexOf(want);
      patch((n) => {
        n.precision = want;
        /* 变细：缺的部件补默认值（月/日 → 1，时/分/秒 → 0）。不补的话落盘那边是「有才写」，
           会出现「有日没月」这种不完整时间。
           变粗：更细的部件清成 undefined —— 只有这样 `main.js` 的 yearToDateStr 才真的
           只写年份，不会把「312年」写成「312年1月1日」（第二轮修过的老 bug）。 */
        n.month = wi >= 1 ? (n.month ?? 1) : undefined;
        n.day = wi >= 2 ? (n.day ?? 1) : undefined;
        n.hour = wi >= 3 ? (n.hour ?? 0) : undefined;
        n.minute = wi >= 4 ? (n.minute ?? 0) : undefined;
        n.second = wi >= 5 ? (n.second ?? 0) : undefined;
      });
      renderView();
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
          if (p) { patch((n) => { n.year = p.year; n.precision = p.precision; n.month = p.month; n.day = p.day; n.hour = p.hour; n.minute = p.minute; n.second = p.second; }); }
          renderView();
        });
        /* 输入法回车是「上屏候选词」，不该提前提交（blur 会保存并退出编辑） */
        inp.addEventListener('keydown', (ev) => {
          if (ev.key !== 'Enter' || isImeEnter(ev)) return;
          inp.blur();
        });
      });
    }

    host.querySelector('#d-del')?.addEventListener('click', () => {
      if (!tlId) return;
      /* 走 removeNode：它同时会把 vault 里对应的 .md 移进回收站。
         旧写法在这里自己 filter 一遍，绕过了动作层 → 文件残留 → 节点下次启动复活。 */
      void confirmDialog({
        title: `删除节点「${node.title || '未命名'}」？`,
        message: '节点会从时间线移除，对应的 .md 文件移入 vault 的回收站。',
        detail: '需要时可从工具栏「回收站」恢复。',
        confirmText: '删除',
        danger: true,
      }).then((okDel) => {
        if (!okDel) return;
        removeNode(store, tlId, node.id);
        host.innerHTML = '';
        detailUnsub?.();
        detailUnsub = null;
        if (onChanged) onChanged();
      });
    });

    const fieldsBox = host.querySelector('#d-fields') as HTMLElement;
    fields.forEach((f) => { fieldsBox.appendChild(makeFieldCard(f.k, f.v)); });
    const causesBox = host.querySelector('#d-causes') as HTMLElement;
    renderCauses(causesBox);
  }

  /* 因果区：本事件由哪些节点导致（可删/添加），画线数据存在 node.causes（目标节点 id） */
  function renderCauses(box: HTMLElement) {
    const tl = tlId ? currentWorld(store).timelines[tlId] : undefined;
    const all: TimelineNode[] = (tl?.nodes ?? []) as TimelineNode[];
    const nameOf = (id: string) => all.find((x: TimelineNode) => x.id === id)?.title ?? id;
    box.innerHTML = `<div style="font-size:11px;font-weight:600;color:var(--fg-2);">因果</div>` +
      `<div style="display:flex;flex-wrap:wrap;gap:4px;">` +
      ((latest().causes ?? []).map((id) =>
        `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:2px 8px;font-size:var(--text-xs);color:var(--fg);">
          <span style="color:var(--accent);">◈</span>${escapeHtml(nameOf(id))}
          <button data-cid="${escapeHtml(id)}" style="border:none;background:none;color:var(--fg-2);cursor:pointer;font-size:12px;line-height:1;">×</button>
        </span>`).join('')
      ) +
      `<button id="d-causes-add" style="border:1px dashed var(--border-strong);background:none;color:var(--fg-2);border-radius:var(--radius-sm);padding:2px 8px;font-size:var(--text-xs);cursor:pointer;">+ 添加导致</button>` +
      `</div>`;
    box.querySelectorAll('[data-cid]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.cid!;
        patch((n) => { n.causes = (n.causes ?? []).filter((x) => x !== id); });
        renderView();
      });
    });
    box.querySelector('#d-causes-add')?.addEventListener('click', () => {
      const slot = box.querySelector('#d-causes-add') as HTMLElement;
      slot.textContent = '点取时间线节点… Esc 取消';
      requestEyedrop((id) => {
        patch((n) => { n.causes = [...(n.causes ?? []), id]; });
        renderView();
      });
    });
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
      /* 点击区域外（blur）→ 保存 + 恢复只读。
         set 内部已走 patch()（store.update + onChanged），这里不再重复保存。 */
      input.addEventListener('blur', () => { opts.set(input.value); renderView(); });
      /* 单行输入（标题）：回车提交并退出编辑；输入法组字期的回车是上屏，不算提交 */
      input.addEventListener('keydown', (ev) => {
        if (opts.multi || ev.key !== 'Enter' || isImeEnter(ev)) return;
        input.blur();
      });
    });
  }

  renderView();
  /* 外部 vault 改动 → store 更新 → 面板自动重绘最新值（编辑中不干扰） */
  detailUnsub?.();
  detailUnsub = store.subscribe(() => {
    /* #d-view 只由本面板产出：容器被别的工具接管 / 面板已卸载 → 自行退订 */
    if (!host.isConnected || !host.querySelector('#d-view')) { detailUnsub?.(); detailUnsub = null; return; }
    if (host.querySelector('input, textarea, select')) return;   /* 编辑中不重绘 */
    renderView();
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
