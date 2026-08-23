/** 世界沙盘 · 时间线视图（TS 版，批量迁移 legacy 核心）
 * 节点横排 + 标尺刻度 + 平移缩放 + 时间指针 + 节点拖动改时间 + fit 视图
 */
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import { getTimeline, setTimeCursor, saveNodeDoc } from '../store/actions';
import type { Timeline, TimelineNode, Storyline, Loop } from '../store/types';
import { renderNodeForm } from './node-form';

interface View {
  panX: number;
  panY: number;
  spacing: number;      // px/年
}

export function mountTimeline(
  store: Store,
  host: HTMLElement,
  onSelect?: (node: TimelineNode) => void
): void {
  host.classList?.remove('lk-placeholder');   /* 挂载后移除占位样式 */
  host.innerHTML = `
    <div class="tl-wrap" style="position:relative;width:100%;height:100%;overflow:hidden;cursor:default;">
      <div class="tl-scale" style="position:absolute;top:0;left:0;right:0;height:26px;border-bottom:1px solid var(--border-soft);background:var(--surface-2);overflow:hidden;"></div>
      <div class="tl-track" style="position:absolute;top:26px;left:0;right:0;bottom:0;cursor:crosshair;"></div>
      <div class="tl-cursor" style="position:absolute;top:0;bottom:0;width:0;pointer-events:none;display:none;z-index:5;">
        <div style="position:absolute;top:30px;bottom:0;left:-1px;width:2px;background:var(--accent);opacity:.55;"></div>
        <div class="tl-cursor-handle" style="position:absolute;top:4px;left:-9px;width:18px;height:18px;border-radius:50%;background:var(--chrome);border:1px solid var(--accent);cursor:ew-resize;pointer-events:auto;box-shadow:0 2px 6px rgba(0,0,0,.4);"></div>
        <div class="tl-cursor-time" style="position:absolute;top:24px;left:6px;font-family:var(--font-mono);font-size:9px;color:var(--accent);background:rgba(15,15,17,.8);padding:1px 5px;border-radius:3px;white-space:nowrap;"></div>
      </div>
    </div>`;

  const wrap = host.querySelector('.tl-wrap') as HTMLElement;
  const scaleEl = host.querySelector('.tl-scale') as HTMLElement;
  const track = host.querySelector('.tl-track') as HTMLElement;
  const cursorEl = host.querySelector('.tl-cursor') as HTMLElement;
  const cursorTimeEl = cursorEl.querySelector('.tl-cursor-time') as HTMLElement;
  const view: View = { panX: 0, panY: 0, spacing: 2 };

  /* ── 坐标换算（照抄 legacy）── */
  function timeToX(t: number): number { return t * view.spacing + view.panX + 40; }
  function xToTime(x: number): number { return (x - 40 - view.panX) / view.spacing; }

  /* ── 有效时间线 id（兼容旧数据 order 与 key 不一致）── */
  function activeTimelineId(): string | undefined {
    const ws = currentWorld(store);
    const valid = (ws.order ?? []).find((id) => ws.timelines[id]);
    if (store.activeTimeline && ws.timelines[store.activeTimeline]) return store.activeTimeline;
    return valid || Object.keys(ws.timelines)[0];
  }
  function timeline(): Timeline | undefined {
    const id = activeTimelineId();
    return id ? getTimeline(store, id) : undefined;
  }

  /* ── 标尺刻度（照抄 legacy niceStep/buildScale）── */
  function niceStep(raw: number): number {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }
  function fmtScale(t: number): string {
    if (t < 0) return `公元前 ${-t} 年`;
    return `${t} 年`;
  }
  function renderScale() {
    const raw = 100 / view.spacing;               // 100px 容器的年跨度
    const step = niceStep(raw);
    const t0 = Math.floor(xToTime(0) / step) * step;
    const t1 = Math.ceil(xToTime(wrap.clientWidth) / step) * step;
    let html = '';
    for (let t = t0; t <= t1; t += step) {
      const x = timeToX(t);
      html += `<div class="tl__axis-tick" style="left:${x}px;"><span class="tl__axis-label">${fmtScale(Math.round(t * 100) / 100)}</span></div>`;
    }
    scaleEl.innerHTML = html;
  }

  /* ── 渲染节点 ── */
  let selectedId: string | null = null;
  function renderBase() {
    const tl = timeline();
    if (!tl) {
      track.innerHTML = '<div style="padding:20px;font-size:var(--text-sm);color:var(--fg-2);">无时间线 · 待建</div>';
      scaleEl.innerHTML = '';
      return;
    }
    const nodes = tl.nodes;
    const lineHtml = '<div class="tl-line"></div>';   /* 时间线常驻贯穿（无限画布） */
    track.innerHTML =
      lineHtml +
      nodes
        .map((n) => nodeHtml(n, timeToX(n.year), n.id === selectedId))
        .join('');
    renderScale();
    updateCursor();
  }

  let render: () => void = renderBase;   /* 可被剧情线/循环包装重赋 */

  /* 节点 HTML（legacy 结构：.tl__n + .cap + .tl__name） */
  function nodeHtml(n: TimelineNode, x: number, sel: boolean): string {
    return `<div class="tl__n${sel ? ' is-sel' : ''}${n.type === 'event' ? ' is-event' : ''}" data-id="${n.id}" style="left:${x}px;">
      <div class="cap"></div><div class="tl__name">${n.title}</div>
    </div>`;
  }
  function updateCursor() {
    const ws = currentWorld(store);
    const t = ws.timeCursor;
    if (t === null || t === undefined) { cursorEl.style.display = 'none'; return; }
    cursorEl.style.display = '';
    cursorEl.style.left = timeToX(t) + 'px';
    cursorTimeEl.textContent = fmtScale(Math.round(t * 100) / 100);
    /* 未发生节点淡化 */
    track.querySelectorAll('.tl__n').forEach((el) => {
      const n = (el as HTMLElement).dataset.id;
      const node = timeline()?.nodes.find((x) => x.id === n);
      if (node) (el as HTMLElement).style.opacity = node.year > t ? '0.4' : '';
    });
  }

  /* ── fit 视图（缩放适配全部节点）── */
  function fitAll() {
    const tl = timeline();
    if (!tl || !tl.nodes.length) { view.panX = 0; view.spacing = 2; return; }
    const years = tl.nodes.map((n) => n.year);
    const lo = Math.min(...years), hi = Math.max(...years);
    const span = Math.max(1, hi - lo);
    view.spacing = Math.min(40, Math.max(0.05, (wrap.clientWidth - 120) / span));
    view.panX = 40 - lo * view.spacing;
    render();
  }

  /* ── 交互状态 ── */
  let spaceDown = false;
  let dragging = false;        // 空格平移
  let lastX = 0;
  let cursorDrag = false;      // 空白拖动指针
  let nodeDragId: string | null = null;
  let nodeDragMoved = false;

  wrap.addEventListener('pointerdown', (e) => {
    if (typeof brushing !== 'undefined' && brushing) return;   /* 笔刷模式：交给笔刷分支 */
    const nodeEl = (e.target as HTMLElement).closest('.tl__n') as HTMLElement | null;
    if (nodeEl) {
      /* 节点：点击选中 / 拖动改时间 */
      nodeDragId = nodeEl.dataset.id ?? null;
      nodeDragMoved = false;
      lastX = e.clientX;
      return;
    }
    if (spaceDown) {
      dragging = true;
      lastX = e.clientX;
      wrap.style.cursor = 'grabbing';
      return;
    }
    cursorDrag = true;
    const rect = wrap.getBoundingClientRect();
    setTimeCursor(store, xToTime(e.clientX - rect.left));
  });
  window.addEventListener('pointermove', (e) => {
    const rect = wrap.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    if (nodeDragId) {
      if (Math.abs(e.clientX - lastX) > 2) nodeDragMoved = true;
      if (nodeDragMoved) {
        const tl = timeline();
        const n = tl?.nodes.find((x) => x.id === nodeDragId);
        if (n) {
          n.year = Math.round(xToTime(mx) * 10) / 10;
          render();
          saveNodeDoc(store, tl!.id, n.id, n.doc ?? '', { undo: false });   // 拖动中间态不进撤销
        }
      }
      return;
    }
    if (dragging) {
      view.panX += e.clientX - lastX;
      lastX = e.clientX;
      render();
      return;
    }
    if (cursorDrag) {
      setTimeCursor(store, xToTime(mx));
    }
  });
  window.addEventListener('pointerup', () => {
    const wasNodeClick = nodeDragId && !nodeDragMoved;
    if (wasNodeClick) {
      const n = timeline()?.nodes.find((x) => x.id === nodeDragId);
      if (n) {
        selectedId = n.id;
        render();
        if (onSelect) onSelect(n);
      }
    }
    nodeDragId = null;
    nodeDragMoved = false;
    dragging = false;
    cursorDrag = false;
    wrap.style.cursor = 'default';
    if (cursorDrag) { /* 已在 pointerup 前松开 */ }
  });
  window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !spaceDown) spaceDown = true; });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });
  window.addEventListener('blur', () => { spaceDown = false; });

  /* 滚轮：普通=左右平移（横向滚动），Ctrl=缩放（照抄 legacy scrollPan） */
  wrap.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.ctrlKey) {
        const rect = wrap.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const tAt = xToTime(mx);
        const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
        view.spacing = Math.min(40, Math.max(0.05, view.spacing * factor));
        view.panX = mx - 40 - tAt * view.spacing;
      } else {
        view.panX -= e.deltaY;   /* 滚轮上下 → 时间线左右平移 */
        if (e.deltaX) view.panX -= e.deltaX;
      }
      render();
    },
    { passive: false }
  );
  wrap.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('.tl__n')) return;
    fitAll();
  });

  /* 指针手柄拖动 */
  const handle = cursorEl.querySelector('.tl-cursor-handle') as HTMLElement;
  let handleDrag = false;
  handle.addEventListener('pointerdown', (e) => {
    if (!cursorEl.style.display) return;
    handleDrag = true;
    e.stopPropagation();
  });
  window.addEventListener('pointermove', (e) => {
    if (!handleDrag) return;
    const rect = wrap.getBoundingClientRect();
    setTimeCursor(store, xToTime(e.clientX - rect.left));
  });
  window.addEventListener('pointerup', () => { handleDrag = false; });

  store.subscribe(() => render());
  render();
  requestAnimationFrame(() => fitAll());

  /* ══════════ 剧情线（笔刷创建 / 多段 / 聚焦过滤 / 遮罩）══════════ */
  const TL_HEAD = document.getElementById('lk-pane-timeline')?.querySelector('.lk-pane-head') as HTMLElement | null;
  if (!TL_HEAD) return;

  let storyMode: 'focus' | 'full' = 'focus';        // 默认聚焦剧情线
  let activeLineId: string | null = null;            // 聚焦的剧情线
  let brushing = false;                              // 笔刷模式
  let pendingSegs: { start: number; end: number | null }[] = [];  // 累积段
  const brushSel = document.createElement('div');
  brushSel.style.cssText =
    'position:absolute;top:26px;bottom:0;z-index:4;pointer-events:none;background:rgba(158,194,98,.10);border:1px solid rgba(158,194,98,.55);display:none;';
  wrap.appendChild(brushSel);

  function linesOf(): Storyline[] {
    const tl = timeline();
    return (tl && Array.isArray(tl.storylines) ? tl.storylines : []) as Storyline[];
  }
  function activeLine(): Storyline | undefined {
    return linesOf().find((l) => l.id === activeLineId);
  }
  function inLine(t: number): boolean {
    const ln = activeLine();
    if (!ln) return false;
    return ln.segments.some((s) => (s.end === null ? t >= s.start : t >= s.start && t <= s.end));
  }

  function renderStoryUI() {
    if (!TL_HEAD) return;
    const lines = linesOf();
    const active = activeLineId && lines.some((l) => l.id === activeLineId) ? activeLineId : lines[0]?.id ?? null;
    if (active !== activeLineId) activeLineId = active;
    const lineOpts = lines
      .map((l) => `<option value="${l.id}"${l.id === activeLineId ? ' selected' : ''}>${l.name}</option>`)
      .join('');
    const existing = TL_HEAD.querySelector('#lk-story-ui');
    if (existing) existing.remove();
    const ui = document.createElement('span');
    ui.id = 'lk-story-ui';
    ui.style.cssText = 'display:flex;gap:4px;align-items:center;flex-shrink:0;';
    ui.innerHTML = `
      <button class="lk-tl-tab${brushing ? ' is-active' : ''}" id="lk-brush" title="笔刷：拖拽空白框选时间段加入剧情线">笔刷</button>
      <select class="lk-tl-tab" id="lk-line-sel" style="font-size:11px;background:none;border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--fg);padding:2px 4px;" ${lines.length ? '' : 'disabled'}>
        <option value="">— 世界历史 —</option>${lineOpts}</select>
      <button class="lk-tl-tab is-new" id="lk-line-new" title="新建剧情线">＋线</button>
      ${pendingSegs.length ? `<span class="cnt" style="font-size:10px;color:var(--accent);">已选 ${pendingSegs.length} 段</span>` : ''}`;
    /* 固定槽位：story-ui 恒在最前（笔刷/线），extras 恒在最后（循环/非线性），不因重建互换 */
    const tools = TL_HEAD.querySelector('#lk-tools');
    if (tools) tools.insertBefore(ui, tools.firstChild); else TL_HEAD.appendChild(ui);

    ui.querySelector('#lk-brush')?.addEventListener('click', () => {
      brushing = !brushing;
      renderStoryUI();
      if (!brushing) clearBrushSel();
    });
    ui.querySelector('#lk-line-sel')?.addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      activeLineId = v || null;
      render();
      renderStoryUI();
      renderSegPanel();
    });
    ui.querySelector('#lk-line-new')?.addEventListener('click', () => {
      if (pendingSegs.length === 0) { brushing = true; renderStoryUI(); return; }
      const id = 'sl' + Date.now();
      const tl = timeline();
      if (!tl) return;
      if (!tl.storylines) tl.storylines = [];
      const name = `剧情线 ${tl.storylines.length + 1}`;
      tl.storylines.push({ id, name, segments: pendingSegs.slice() });
      pendingSegs = [];
      activeLineId = id;
      brushing = false;
      clearBrushSel();
      renderStoryUI();
      render();
    });
  }

  function brushYearFromVx(vx: number): number { return xToTime(vx); }
  function clearBrushSel() { brushSel.style.display = 'none'; brushSel.style.left = '0'; brushSel.style.width = '0'; }
  function setBrushSel(vx0: number, vx1: number) {
    brushSel.style.display = '';
    brushSel.style.left = Math.min(vx0, vx1) + 'px';
    brushSel.style.width = Math.abs(vx1 - vx0) + 'px';
  }

  /* 橡皮擦差集（照抄 legacy eraseRange）：返回擦除 e0~e1 后的段 */
  function eraseRange(segs: { start: number; end: number | null }[], e0: number, e1: number): { start: number; end: number | null }[] {
    const out: { start: number; end: number | null }[] = [];
    segs.forEach((s) => {
      const s1 = s.end === null || s.end === undefined ? Infinity : s.end;
      if (e1 < s.start || e0 > s1) { out.push(s); return; }
      if (e0 <= s.start && e1 >= s1) return;
      if (e0 > s.start) out.push({ start: s.start, end: e0 });
      if (e1 < s1) out.push({ start: e1, end: s.end });
    });
    return out;
  }

  /* 笔刷拖拽（brushing 时框选时间段；Alt=擦除模式） */
  let brushDrag = false, brushStartX = 0, brushLastX = 0, brushErase = false;
  wrap.addEventListener('pointerdown', (e) => {
    if (!brushing) return;
    if ((e.target as HTMLElement).closest('.tl__n')) return;
    brushDrag = true;
    brushErase = e.altKey;
    brushStartX = e.clientX - wrap.getBoundingClientRect().left;
    brushLastX = brushStartX;
    setBrushSel(brushStartX, brushStartX);
  });
  window.addEventListener('pointermove', (e) => {
    if (!brushDrag) return;
    brushLastX = e.clientX - wrap.getBoundingClientRect().left;
    setBrushSel(brushStartX, brushLastX);
  });
  window.addEventListener('pointerup', () => {
    if (!brushDrag) return;
    brushDrag = false;
    const t0 = brushYearFromVx(brushStartX), t1 = brushYearFromVx(brushLastX);
    const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
    clearBrushSel();
    if (hi - lo <= 0.01) return;
    if (brushErase) {
      /* 擦除：对聚焦线已存段 或 未命名累积段做差集 */
      const tl = timeline();
      if (activeLineId && tl) {
        const ln = tl.storylines.find((l) => l.id === activeLineId);
        if (ln) ln.segments = eraseRange(ln.segments, Math.round(lo * 10) / 10, Math.round(hi * 10) / 10);
      } else {
        pendingSegs = eraseRange(pendingSegs, Math.round(lo * 10) / 10, Math.round(hi * 10) / 10);
      }
    } else {
      pendingSegs.push({ start: Math.round(lo * 10) / 10, end: Math.round(hi * 10) / 10 });
    }
    renderStoryUI();
    render();
  });

  /* 剧情线范围条（时间线上色带）+ 遮罩 */
  function renderStoryOverlay() {    const ln = activeLine();
    /* 遮罩 */
    let mask = wrap.querySelector('#lk-story-mask') as HTMLElement | null;
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'lk-story-mask';
      mask.style.cssText = 'position:absolute;top:26px;bottom:0;left:0;right:0;z-index:2;pointer-events:none;';
      wrap.appendChild(mask);
    }
    mask.innerHTML = '';
    if (storyMode === 'focus' && ln) {
      /* 范围外盖灰 */
      const lo = Math.min(...ln.segments.map((s) => s.start));
      const hi = ln.segments.some((s) => s.end === null)
        ? Math.max(...ln.segments.map((s) => (s.end === null ? -Infinity : s.end)), ...ln.segments.filter((s) => s.end === null).map(() => (timeline()?.nodes.map((n) => n.year).reduce((a, b) => Math.max(a, b), -Infinity) ?? 0)))
        : Math.max(...ln.segments.map((s) => s.end!));
      const xLo = timeToX(lo), xHi = timeToX(hi);
      const w = wrap.clientWidth;
      if (xLo > 0) mask.innerHTML += `<div style="position:absolute;top:0;bottom:0;left:0;width:${xLo}px;background:rgba(110,108,100,.3);"></div>`;
      if (xHi < w) mask.innerHTML += `<div style="position:absolute;top:0;bottom:0;left:${xHi}px;width:${w - xHi}px;background:rgba(110,108,100,.3);"></div>`;
    }
    /* 范围条色带 */
    let bar = wrap.querySelector('.tl__storybar') as HTMLElement | null;
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'tl__storybar';
      wrap.appendChild(bar);
    }
    bar.innerHTML = '';
    if (ln) {
      ln.segments.forEach((s) => {
        const x0 = timeToX(s.start);
        const x1 = s.end === null ? timeToX(Math.max(...(timeline()?.nodes.map((n) => n.year) ?? [s.start]))) : timeToX(s.end);
        bar.innerHTML += `<div class="tl__storybar-seg" style="left:${x0}px;width:${Math.max(2, x1 - x0)}px;"></div>`;
      });
    }
  }

  /* 聚焦过滤：渲染时只显示线内节点 */
  const origRender = render;
  render = function () {
    const tl = timeline();
    if (tl && storyMode === 'focus' && activeLine()) {
      const nodes = tl.nodes.filter((n) => inLine(n.year));
      track.innerHTML = lineHtmlOf(nodes);
      renderScale();
      updateCursor();
    } else {
      origRender();
    }
    renderStoryOverlay();
  };

  function lineHtmlOf(nodes: TimelineNode[]): string {
    let html = '<div class="tl-line"></div>';
    return html + nodes.map((n) => {
      const x = timeToX(n.year);
      const sel = n.id === selectedId;
      return nodeHtml(n, x, sel);
    }).join('');
  }

  renderStoryUI();
  renderSegPanel();

  /* 段列表面板（右侧）：聚焦剧情线时显示段列表，可删段 */
  function renderSegPanel() {
    const toolHost = document.getElementById('lk-tool-host');
    if (!toolHost) return;
    const tl = timeline();
    const ln = activeLineId && tl ? tl.storylines.find((l) => l.id === activeLineId) : undefined;
    if (!ln) { toolHost.innerHTML = ''; return; }
    toolHost.innerHTML = `
      <div style="padding:12px 14px;display:flex;flex-direction:column;gap:8px;">
        <div style="font-size:15px;font-weight:600;color:var(--fg);">${ln.name}</div>
        <div style="font-size:var(--text-xs);color:var(--fg-2);">${ln.segments.length} 段 · 笔刷框选加段，Alt+框选擦除</div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          ${ln.segments.map((s, i) => `<div style="display:flex;align-items:center;gap:6px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 8px;font-size:var(--text-xs);color:var(--fg);">
            <span style="font-family:var(--font-mono);color:var(--accent);">${s.start} → ${s.end === null ? '∞' : s.end}</span>
            <button data-si="${i}" style="margin-left:auto;background:none;border:none;color:#c0392b;cursor:pointer;font-size:12px;">✕</button>
          </div>`).join('') || '<div style="font-size:var(--text-xs);color:var(--fg-2);">（无线段）</div>'}
        </div>
      </div>`;
    toolHost.querySelectorAll('[data-si]').forEach((el) => {
      el.addEventListener('click', () => {
        const si = parseInt((el as HTMLElement).dataset.si!, 10);
        if (tl) {
          const line = tl.storylines.find((l) => l.id === activeLineId);
          if (line) line.segments.splice(si, 1);
        }
        renderSegPanel();
        render();
      });
    });
  }

  /* ══════════ 循环系统（循环框 + 幽灵节点 + 面板）══════════ */
  let loopPanelId: string | null = null;    // 当前打开面板的循环
  let nonlinearMode = false;                // 非线性（序列均匀横排）

  function loopsOf(): Loop[] {
    const tl = timeline();
    return (tl && Array.isArray(tl.loops) ? tl.loops : []) as Loop[];
  }
  function loopById(id: string): Loop | undefined {
    return loopsOf().find((l) => l.id === id);
  }
  function findNodeById(nid: string | undefined): TimelineNode | undefined {
    const tl = timeline();
    return nid ? tl?.nodes.find((n) => n.id === nid) : undefined;
  }
  function loopRange(L: Loop): { lo: number; hi: number; span: number } | null {
    const s = findNodeById(L.startId), e = findNodeById(L.endId);
    if (!s || !e) return null;
    const lo = Math.min(s.year, e.year), hi = Math.max(s.year, e.year);
    return { lo, hi, span: hi - lo };
  }

  function renderLoops() {
    let frames = wrap.querySelector('#lk-loop-frames') as HTMLElement | null;
    if (!frames) {
      frames = document.createElement('div');
      frames.id = 'lk-loop-frames';
      frames.style.cssText = 'position:absolute;top:26px;left:0;right:0;bottom:0;z-index:1;pointer-events:none;';
      wrap.appendChild(frames);
    }
    frames.innerHTML = '';
    const tl = timeline();
    if (!tl) return;
    loopsOf().forEach((L) => {
      const r = loopRange(L);
      if (!r) return;
      const x0 = timeToX(r.lo), x1 = timeToX(r.hi);
      frames.innerHTML += `<div class="tl__loop" data-loop-id="${L.id}" style="left:${x0}px;width:${Math.max(2, x1 - x0)}px;" title="${L.name}（${L.count} 次）"><span class="tl__loop-badge">${L.count}×</span></div>`;
      /* 幽灵节点：范围内节点复制 count-1 次，偏移 span */
      if (L.count > 1) {
        const inner = tl.nodes.filter((n) => n.year >= r.lo && n.year <= r.hi);
        for (let c = 1; c < L.count; c++) {
          inner.forEach((n) => {
            const x = timeToX(n.year + c * r.span);
            frames!.innerHTML += `<div class="tl__ghost" style="left:${x}px;"><div class="cap"></div><div class="tl__name">${n.title}²</div></div>`;
          });
        }
      }
    });
    /* 双击循环框 → 面板（右侧） */
    frames.querySelectorAll('.tl__loop').forEach((el) => {
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const lid = (el as HTMLElement).dataset.loopId!;
        loopPanelId = lid;
        renderLoopPanel();
      });
    });
  }

  function renderLoopPanel() {
    const L = loopPanelId ? loopById(loopPanelId) : undefined;
    const toolHost = document.getElementById('lk-tool-host');
    if (!toolHost) return;
    if (!L) { toolHost.innerHTML = ''; return; }
    const r = loopRange(L);
    toolHost.innerHTML = `
      <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;">
        <div style="font-size:15px;font-weight:600;color:var(--fg);">循环 · ${L.name}</div>
        <div style="font-size:var(--text-xs);color:var(--fg-2);">${r ? `${r.lo}年 → ${r.hi}年（跨度 ${r.span} 年）` : '起终节点缺失'}</div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:var(--text-xs);color:var(--fg-2);">循环次数</span>
          <button id="lp-minus" style="width:24px;height:24px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);cursor:pointer;">−</button>
          <span id="lp-count" style="font-size:var(--text-sm);color:var(--accent);min-width:24px;text-align:center;">${L.count ?? 1}</span>
          <button id="lp-plus" style="width:24px;height:24px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);cursor:pointer;">＋</button>
        </div>
        <button id="lp-del" style="background:transparent;border:1px solid #c0392b;color:#c0392b;border-radius:var(--radius-sm);padding:6px;font-size:var(--text-sm);cursor:pointer;">删除循环</button>
        <div style="font-size:var(--text-xs);color:var(--fg-2);">提示：双击时间线上的循环框打开此面板</div>
      </div>`;
    toolHost.querySelector('#lp-minus')?.addEventListener('click', () => {
      if (!L) return;
      L.count = Math.max(1, (L.count ?? 1) - 1);
      renderLoopPanel(); renderLoops();
    });
    toolHost.querySelector('#lp-plus')?.addEventListener('click', () => {
      if (!L) return;
      L.count = Math.min(20, (L.count ?? 1) + 1);
      renderLoopPanel(); renderLoops();
    });
    toolHost.querySelector('#lp-del')?.addEventListener('click', () => {
      const tl = timeline();
      if (!tl || !L) return;
      tl.loops = (tl.loops || []).filter((x) => x.id !== L.id);
      loopPanelId = null;
      toolHost.innerHTML = '';
      renderLoops();
    });
  }

  /* 沙盘头加「＋循环」「非线性」常驻工具 */
  function renderExtraTools() {
    if (!TL_HEAD) return;
    let ext: HTMLElement | null = TL_HEAD.querySelector('#lk-extras');
    if (ext) ext.remove();
    ext = document.createElement('span');
    ext.id = 'lk-extras';
    ext.style.cssText = 'display:flex;gap:4px;align-items:center;flex-shrink:0;';    ext.innerHTML = `
      <button class="lk-tl-tab is-new" id="lk-loop-new" title="新建循环（选起终节点）">＋循环</button>
      <button class="lk-tl-tab${nonlinearMode ? ' is-active' : ''}" id="lk-nonlinear" title="非线性：按序列顺序均匀排列">非线性</button>`;
    /* 放进固定容器 #lk-tools（与 story-ui 同容器，extras 居后，位置固定不乱跑） */
    const tools = TL_HEAD.querySelector('#lk-tools');
    if (tools) tools.appendChild(ext); else TL_HEAD.insertBefore(ext, TL_HEAD.querySelector('#lk-node-new') ?? TL_HEAD.lastChild);
    ext.querySelector('#lk-loop-new')?.addEventListener('click', () => {
      const tl = timeline();
      if (!tl) return;
      const toolHost = document.getElementById('lk-tool-host');
      if (!toolHost) return;
      const opts = tl.nodes
        .map((n) => `<option value="${n.id}">${n.year} · ${n.title}</option>`)
        .join('');
      toolHost.innerHTML = `
        <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;">
          <div style="font-size:15px;font-weight:600;color:var(--fg);">新建循环 · ${tl.name}</div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            <label style="font-size:var(--text-xs);color:var(--fg-2);">名称</label>
            <input id="lp-name" type="text" placeholder="潮汐轮回" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:6px 8px;font-size:var(--text-sm);outline:none;"/>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            <label style="font-size:var(--text-xs);color:var(--fg-2);">起始节点</label>
            <select id="lp-start" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:6px 8px;font-size:var(--text-sm);outline:none;">${opts}</select>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            <label style="font-size:var(--text-xs);color:var(--fg-2);">结束节点</label>
            <select id="lp-end" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:6px 8px;font-size:var(--text-sm);outline:none;">${opts}</select>
          </div>
          <div style="display:flex;gap:8px;">
            <button id="lp-ok" style="flex:1;background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-sm);padding:7px;font-size:var(--text-sm);cursor:pointer;">创建</button>
            <button id="lp-cancel" style="flex:1;background:var(--surface-2);color:var(--fg-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:7px;font-size:var(--text-sm);cursor:pointer;">取消</button>
          </div>
        </div>`;
      toolHost.querySelector('#lp-ok')?.addEventListener('click', () => {
        const name = (toolHost.querySelector('#lp-name') as HTMLInputElement).value.trim() || `循环 ${loopsOf().length + 1}`;
        const startId = (toolHost.querySelector('#lp-start') as HTMLSelectElement).value;
        const endId = (toolHost.querySelector('#lp-end') as HTMLSelectElement).value;
        if (!startId || !endId) return;
        const tl2 = timeline();
        if (!tl2) return;
        if (!tl2.loops) tl2.loops = [];
        tl2.loops.push({ id: 'lp' + Date.now(), name, startId, endId, count: 2 });
        toolHost.innerHTML = '';
        renderLoops();
      });
      toolHost.querySelector('#lp-cancel')?.addEventListener('click', () => (toolHost.innerHTML = ''));
    });
    ext.querySelector('#lk-nonlinear')?.addEventListener('click', () => {
      nonlinearMode = !nonlinearMode;
      renderExtraTools();
      render();
    });
  }

  /* ══════════ 非线性模式（按序列顺序均匀横排 + 类型泳道）══════════ */
  function renderNonlinear() {
    const tl = timeline();
    if (!tl || !nonlinearMode) return;
    const nodes = tl.nodes;
    if (!nodes.length) return;
    const lanes = ['event', 'plot', 'place'];
    const inLane = (n: TimelineNode, l: string) => (l === 'event' ? n.type === 'event' : l === 'plot' ? n.type === 'plot' : n.type === 'place' || n.type === 'year');
    let laneCounts: Record<string, number> = {};
    lanes.forEach((l) => { laneCounts[l] = nodes.filter((n) => inLane(n, l)).length; });
    const maxCount = Math.max(1, ...Object.values(laneCounts));
    const pitch = Math.max(24, (wrap.clientWidth - 100) / maxCount);
    const laneY: Record<string, number> = {};
    let y = 40;
    lanes.forEach((l) => { laneY[l] = y; y += 90; });
    const laneEls = lanes.map((l) => `<div style="position:absolute;left:0;right:0;top:${laneY[l] - 14}px;height:1px;background:var(--border-soft);"></div><div style="position:absolute;left:4px;top:${laneY[l] - 20}px;font-size:9px;color:var(--fg-2);">${l === 'event' ? '事件' : l === 'plot' ? '角色' : '地点'}</div>`).join('');
    const counters: Record<string, number> = { event: 0, plot: 0, place: 0 };
    track.innerHTML =
      `<div class="tl-line" style="left:0;right:0;"></div>` + laneEls +
      nodes
        .map((node) => {
          const lane = lanes.find((l) => inLane(node, l)) ?? 'event';
          const x = 50 + counters[lane]++ * pitch;
          return nodeHtml(node, x, node.id === selectedId) + `<div style="font-size:8px;color:var(--fg-2);position:absolute;top:${laneY[lane] + 12}px;left:${x}px;transform:translateX(-50%);">${node.year}</div>`;
        })
        .join('');
    renderScale();
    updateCursor();
  }

  /* render 统一入口：非线性 > 剧情线聚焦 > 常规 */
  const baseRender = render;
  render = function () {
    if (nonlinearMode) { renderNonlinear(); renderLoops(); renderStoryOverlay(); return; }
    baseRender();
    renderLoops();
  };

  renderExtraTools();
  renderLoops();

  /* ══════════ 右键菜单（重新设计：工具已常驻，右键=快捷操作）══════════ */
  let ctxMenu: HTMLElement | null = null;
  function closeCtx() { ctxMenu?.remove(); ctxMenu = null; }
  function showCtx(x: number, y: number, nodeId: string | null) {
    closeCtx();
    ctxMenu = document.createElement('div');
    ctxMenu.style.cssText =
      'position:fixed;z-index:1000;background:var(--chrome);color:var(--fg-inverse);border:1px solid var(--chrome-2);border-radius:var(--radius-sm);padding:4px;min-width:150px;box-shadow:0 6px 20px rgba(0,0,0,.5);';
    const items: [string, () => void][] = nodeId
      ? [
          ['编辑', () => {
            const tl = timeline();
            const n = tl?.nodes.find((x) => x.id === nodeId);
            if (n && onSelect) onSelect(n);
          }],
          ['复制节点', () => {
            const tl = timeline();
            const n = tl?.nodes.find((x) => x.id === nodeId);
            if (tl && n) {
              tl.nodes.push({ ...n, id: 'n' + Date.now(), title: n.title + ' 副本' });
              render();
            }
          }],
          ['删除节点', () => {
            const tl = timeline();
            if (tl) { tl.nodes = tl.nodes.filter((x) => x.id !== nodeId); render(); }
          }],
        ]
      : [
          ['新建节点', () => {
            const tl = timeline();
            const tid = activeTimelineId();
            if (!tl || !tid) return;
            const toolHost = document.getElementById('lk-tool-host');
            if (toolHost) renderNodeForm(store, toolHost, tid, tl.name);
          }],
          ['剧情线笔刷', () => { brushing = !brushing; renderStoryUI(); }],
          ['新建循环', () => { renderExtraTools(); document.getElementById('lk-loop-new')?.dispatchEvent(new MouseEvent('click')); }],
          ['fit 视图', () => fitAll()],
        ];
    items.forEach(([label, fn]) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText =
        'display:block;width:100%;text-align:left;background:none;border:none;color:var(--fg-inverse);font-size:12px;padding:5px 8px;cursor:pointer;border-radius:var(--radius-sm);';
      b.addEventListener('mouseenter', () => (b.style.background = 'var(--chrome-2)'));
      b.addEventListener('mouseleave', () => (b.style.background = 'none'));
      b.addEventListener('click', () => { closeCtx(); fn(); });
      ctxMenu!.appendChild(b);
    });
    document.body.appendChild(ctxMenu);
    ctxMenu.style.left = Math.min(x, window.innerWidth - 170) + 'px';
    ctxMenu.style.top = Math.min(y, window.innerHeight - items.length * 30 - 20) + 'px';
  }
  wrap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const nodeEl = (e.target as HTMLElement).closest('.tl__n') as HTMLElement | null;
    showCtx(e.clientX, e.clientY, nodeEl?.dataset.id ?? null);
  });
  document.addEventListener('click', (e) => {
    if (ctxMenu && !ctxMenu.contains(e.target as Node)) closeCtx();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtx(); });
}