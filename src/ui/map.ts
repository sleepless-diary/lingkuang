/** 地图模块——手绘矢量地图（区域 + 标记），存 ws.maps[]；基础版照抄 legacy 平滑 */
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import type { MapData } from '../store/types';
import { escapeHtml } from './html';

type Mode = 'region' | 'marker' | 'move';

/** Catmull-Rom 平滑 → SVG path（闭合区域） */
function smoothClosedPath(pts: [number, number][]): string {
  if (pts.length < 3) return pts.map(([x, y]) => `M${x},${y}`).join(' ');
  const p = pts.map((pt) => ({ x: pt[0], y: pt[1] }));
  let d = `M${p[0].x},${p[0].y}`;
  for (let i = 0; i < p.length; i++) {
    const p0 = p[(i - 1 + p.length) % p.length];
    const p1 = p[i];
    const p2 = p[(i + 1) % p.length];
    const p3 = p[(i + 2) % p.length];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`;
  }
  return d + ' Z';
}

/* 同 detail.ts：host 是长生命周期容器，重新渲染必须摘掉上一次的订阅，
   否则切到别的工具后旧订阅仍会往别人的界面里画东西。 */
let mapUnsub: (() => void) | null = null;
/* window 上的指针监听同理：只加不减的话，进出地图工具 N 次就叠 2N 个，
   且每个都还在对着已废弃的 SVG 跑重绘。 */
let mapCleanup: (() => void) | null = null;

export function renderMap(store: Store, host: HTMLElement): void {
  /* 首次进入若还没有地图就补一张默认地图（写入走 store.update，不直接改 data；
     建默认地图属于初始化，不占撤销格） */
  if (!currentWorld(store).maps?.length) {
    store.update((d) => {
      const w = d.worldsets[store.activeWorld];
      if (!w.maps || !w.maps.length) {
        w.maps = [{ id: 'm' + Date.now(), name: '默认地图', width: 900, height: 500, regions: [], markers: [], paths: [] }];
      }
    }, { undo: false });
  }

  /* 每次用时从 store 解析当前地图，不缓存对象引用：
     undo/redo（store.ts 直接替换整个 data）与外部 vault 重载都会让缓存的引用失效，
     旧代码缓存了 map，撤销后重绘时画的仍是那个已被丢弃的旧对象。 */
  const curMap = (): MapData => currentWorld(store).maps![0];

  let mode: Mode = 'move';
  let drawing: [number, number][] = [];

  host.style.overflow = 'hidden';
  host.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;">
      <div style="display:flex;gap:6px;padding:6px 10px;border-bottom:1px solid var(--border-soft);background:var(--surface-2);align-items:center;">
        <span style="font-size:var(--text-xs);font-weight:600;color:var(--fg);">地图 · ${escapeHtml(curMap().name)}</span>
        <span style="flex:1;"></span>
        <button data-mode="region" class="map-mode" style="background:none;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:3px 10px;cursor:pointer;">区域</button>
        <button data-mode="marker" class="map-mode" style="background:none;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:3px 10px;cursor:pointer;">标记</button>
        <button data-mode="move" class="map-mode" style="background:none;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:3px 10px;cursor:pointer;">移动</button>
        <button id="map-clear" style="background:none;border:1px solid #c0392b;color:#c0392b;border-radius:var(--radius-sm);font-size:11px;padding:3px 10px;cursor:pointer;">清空标记</button>
        <span id="map-hint" style="font-size:var(--text-xs);color:var(--fg-2);">拖拽画区域（松开闭合）</span>
      </div>
      <div style="flex:1;position:relative;overflow:hidden;">
        <svg id="map-svg" width="${curMap().width}" height="${curMap().height}" style="position:absolute;left:0;top:0;background:var(--surface-2);touch-action:none;"></svg>
      </div>
    </div>`;

  const svg = host.querySelector('#map-svg') as unknown as SVGSVGElement;
  const hint = host.querySelector('#map-hint') as HTMLElement;
  let labelSeq = 1;

  function setMode(m: Mode) {
    mode = m;
    drawing = [];
    host.querySelectorAll('.map-mode').forEach((b) => (b as HTMLElement).style.background = 'none');
    const btn = host.querySelector(`.map-mode[data-mode="${m}"]`) as HTMLElement;
    if (btn) btn.style.background = 'rgba(158,194,98,.2)';
    hint.textContent = m === 'region' ? '拖拽画区域（松开闭合）' : m === 'marker' ? '点击放置标记' : '拖拽平移';
  }
  host.querySelectorAll('.map-mode').forEach((b) =>
    (b as HTMLElement).addEventListener('click', () => setMode((b as HTMLElement).dataset.mode as Mode))
  );
  host.querySelector('#map-clear')?.addEventListener('click', () => {
    /* 必须走 save()：旧写法只改内存里的 map 再 renderSvg()，既不通知订阅者，
       也就不会触发 main.ts 的 400ms 防抖落盘 → 关掉窗口就丢。 */
    save((m) => { m.markers = []; });
  });
  setMode('move');

  function renderSvg() {
    const m = curMap();
    const regions = m.regions
      .map(
        (r) =>
          `<path d="${r.path}" fill="${r.fill}" stroke="rgba(58,58,52,.5)" stroke-width="1" style="cursor:pointer;" title="${escapeHtml(r.name)}"/>`
      )
      .join('');
    const markers = m.markers
      .map(
        (mk) =>
          `<g transform="translate(${mk.x},${mk.y})" style="cursor:pointer;">
            <circle r="6" fill="var(--accent)" stroke="var(--accent-on)" stroke-width="1"/>
            <text y="-10" text-anchor="middle" style="font-size:10px;fill:var(--fg);">${mk.label}</text>
          </g>`
      )
      .join('');
    const drawingPath = drawing.length > 1 ? `<path d="${smoothClosedPath(drawing)}" fill="rgba(158,194,98,.15)" stroke="var(--accent)" stroke-width="1" stroke-dasharray="4 2"/>` : '';
    svg.innerHTML = regions + markers + drawingPath;
  }

  let panning = false, panX = 0, panY = 0, panSX = 0, panSY = 0;

  /* 收尾统一入口。commit=true（正常 pointerup）才把区域落盘；
     其余情况（pointercancel、丢失的 pointerup）丢弃这一笔，避免半成品区域写进数据。 */
  function endDrag(commit: boolean) {
    if (commit && mode === 'region' && drawing.length >= 3) {
      const pts = drawing;
      const fill = `rgba(${158 + Math.floor(Math.random() * 60)},${150 + Math.floor(Math.random() * 50)},${98},0.25)`;
      save((m) => {
        m.regions.push({
          id: 'rg' + Date.now(),
          name: `区域 ${m.regions.length + 1}`,
          points: pts,
          path: smoothClosedPath(pts),
          fill,
        });
      });
    }
    drawing = [];
    panning = false;
    renderSvg();
  }

  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // 右键/中键不画区域、不拖画布
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (mode === 'region') {
      drawing = [[x, y]];
      renderSvg();
    } else if (mode === 'marker') {
      save((m) => { m.markers.push({ id: 'mk' + Date.now(), x, y, label: `M${labelSeq++}` }); });
    } else {
      panning = true;
      panSX = e.clientX; panSY = e.clientY;
      /* 平移基准取当前 inline style 的 left/top——与下面赋值的 style.left/top 同一坐标系。
         旧代码用 getBoundingClientRect()（视口坐标）当基准，第一帧会把 SVG 平移一个
         「容器在视口中的偏移」那么多，表现为一拖就瞬移。 */
      panX = parseFloat(svg.style.left) || 0;
      panY = parseFloat(svg.style.top) || 0;
    }
  });
  const onMove = (e: PointerEvent) => {
    /* 丢失 pointerup 的兜底：没按键却收到 move，说明收尾信号丢了
       （在窗口外松开 / pointercancel 没派发），就地收尾——否则会一直画下去或一直平移。 */
    if (e.buttons === 0) {
      if (panning || drawing.length) endDrag(false);
      return;
    }
    if (mode === 'region' && drawing.length) {
      const rect = svg.getBoundingClientRect();
      drawing.push([e.clientX - rect.left, e.clientY - rect.top]);
      renderSvg();
    } else if (panning) {
      svg.style.left = panX + (e.clientX - panSX) + 'px';
      svg.style.top = panY + (e.clientY - panSY) + 'px';
    }
  };
  const onUp = () => endDrag(true);
  const onCancel = () => endDrag(false);
  mapCleanup?.();
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  mapCleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
  };

  /* 改动必须发生在 store.update 内部：update() 先把「当前」data 深拷贝进撤销栈，
     再执行 fn。旧写法是「先直接改 map —— 而 map 就是 ws.maps[0] 这个活引用 ——
     再调用 update 把同一个对象赋回去」，于是快照里已经含着这次改动，
     撤销/重做对地图等于完全无效。 */
  function save(mutate: (m: MapData) => void) {
    store.update((d) => {
      const m = d.worldsets[store.activeWorld]?.maps?.[0];
      if (m) mutate(m);
    });
  }

  mapUnsub?.();
  mapUnsub = store.subscribe(() => {
    /* #map-svg 只由本模块产出：容器被别的工具接管 → 自行退订（window 监听一并摘掉） */
    if (!host.isConnected || !host.querySelector('#map-svg')) {
      mapUnsub?.();
      mapUnsub = null;
      mapCleanup?.();
      mapCleanup = null;
      return;
    }
    renderSvg();
  });
  renderSvg();
}
