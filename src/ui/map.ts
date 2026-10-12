/** 地图模块——手绘矢量地图（区域 + 标记）+ **生成地形**，存 ws.maps[]
 *
 *  ⭐ 2026-10-13（用户：「我建议先做一个基础的，看起来像的地图生成，真实模拟是额外附件」）：
 *  顶栏多一排「种子 + 档位 + 生成地形」控件，调 `src/ui/map-gen.ts` 的纯函数生成一张底稿。
 *  ⭐ 同日第二轮（用户选**混合方案**：「地形主要是拿来看，文化分区什么的主要是拿来动手」）：
 *  **地形 = 栅格位图**（有光影、好看，最底层）+ **岸线/湖岸/河 = 矢量描边**（同一套噪声场派生、
 *  放大不糊、以后能点，见 `src/ui/map-terrain.ts` 的 `terrainVectors`）；**文化分区仍是手绘
 *  `regions`**（可拖拽、可改，压在底图之上）⇒「生成作底稿、手绘精修」。
 *  整次生成只走一次 `save()` ⇒ 一步 Ctrl+Z 撤销回去。
 *  ⭐ 2026-10-14（用户：「生成做成一个独立的面板吧，两种，创作者自己一个个调参数或者 AI 直出，
 *  可以抽卡」）：生成控件**从这里搬走**，进了 `src/ui/map-studio.ts` 那层悬浮面板；
 *  地图栏只留「生成地形…」一个入口 + 一行现状（`#map-gen-note`）。 */
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import { uid } from '../store/ids';
import type { MapData } from '../store/types';
import { escapeHtml } from './html';
import { DEFAULT_MAP, polylinePath, smoothClosedPath } from './map-gen';
import { terrainDataUrl, terrainSummary, terrainVectors } from './map-terrain';
import { openMapStudioFromToolbar } from './map-studio';

type Mode = 'region' | 'marker' | 'move';

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
        w.maps = [DEFAULT_MAP()];
      }
    }, { undo: false, keepRedo: true });
  }

  /* 每次用时从 store 解析当前地图，不缓存对象引用：
     undo/redo（store.ts 直接替换整个 data）与外部 vault 重载都会让缓存的引用失效，
     旧代码缓存了 map，撤销后重绘时画的仍是那个已被丢弃的旧对象。 */
  /* 每次用时从 store 解析当前地图，不缓存对象引用：
     undo/redo（store.ts 直接替换整个 data）与外部 vault 重载都会让缓存的引用失效，
     旧代码缓存了 map，撤销后重绘时画的仍是那个已被丢弃的旧对象。
     ⚠️ `maps` 是**可选**字段，整体替换 worldsets 后的那一帧可能是 undefined：
     旧写法 `maps![0]` 在这里抛 TypeError，而 store.update 是先改数据后通知，
     异常会穿出 update 打断调用方 —— 实测过一次新建节点时：表单没被清空、
     src/main.ts 的 suppressWrite 卡在 true（此后永久不再自动落盘，静默丢数据）。
     现在返回 null，调用方跳过这一帧即可（下一次通知就会带上真地图）。 */
  const curMap = (): MapData | null => currentWorld(store).maps?.[0] ?? null;

  let mode: Mode = 'move';
  let drawing: [number, number][] = [];

  host.style.overflow = 'hidden';
  host.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;">
      <div style="display:flex;flex-wrap:wrap;gap:6px;row-gap:4px;padding:6px 10px;border-bottom:1px solid var(--border-soft);background:var(--surface-2);align-items:center;">
        <span style="font-size:var(--text-xs);font-weight:600;color:var(--fg);">地图 · ${escapeHtml(curMap()?.name ?? '默认地图')}</span>
        <span id="map-gen-note" style="font-size:var(--text-xs);color:var(--fg-2);"></span>
        <span style="flex:1;"></span>
        <button id="map-gen" title="打开地图生成面板：自己一个个调参数 / AI 直出 / 抽卡" style="background:none;border:1px solid var(--accent);color:var(--accent);border-radius:var(--radius-sm);font-size:11px;padding:3px 10px;cursor:pointer;">生成地形…</button>
        <span style="width:1px;height:16px;background:var(--border-soft);"></span>
        <button data-mode="region" class="map-mode" style="background:none;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:3px 10px;cursor:pointer;">区域</button>
        <button data-mode="marker" class="map-mode" style="background:none;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:3px 10px;cursor:pointer;">标记</button>
        <button data-mode="move" class="map-mode" style="background:none;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:3px 10px;cursor:pointer;">移动</button>
        <button id="map-clear" style="background:none;border:1px solid #c0392b;color:#c0392b;border-radius:var(--radius-sm);font-size:11px;padding:3px 10px;cursor:pointer;">清空标记</button>
        <span id="map-hint" style="font-size:var(--text-xs);color:var(--fg-2);">拖拽画区域（松开闭合）</span>
      </div>
      <div style="flex:1;position:relative;overflow:hidden;">
        <svg id="map-svg" width="${curMap()?.width ?? 900}" height="${curMap()?.height ?? 500}" style="position:absolute;left:0;top:0;background:var(--surface-2);touch-action:none;"></svg>
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
    hint.textContent = m === 'region' ? '区域' : m === 'marker' ? '标记' : '平移';
    hint.title = m === 'region' ? '拖拽画区域（松开闭合）' : m === 'marker' ? '点击放置标记' : '拖拽平移';
  }
  host.querySelectorAll('.map-mode').forEach((b) =>
    (b as HTMLElement).addEventListener('click', () => setMode((b as HTMLElement).dataset.mode as Mode))
  );
  host.querySelector('#map-clear')?.addEventListener('click', () => {
    /* 必须走 save()：旧写法只改内存里的 map 再 renderSvg()，既不通知订阅者，
       也就不会触发 main.ts 的 400ms 防抖落盘 → 关掉窗口就丢。 */
    save((m) => { m.markers = []; });
  });

  /* ── 生成地形：控件已经搬进**地图生成工作室**（`src/ui/map-studio.ts` 的悬浮面板 ——
     用户 2026-10-14：「生成做成一个独立的面板吧，两种，创作者自己一个个调参数或者 AI 直出，
     可以抽卡」）。地图栏这里只留**一个入口**（`#map-gen`）与一行现状（`#map-gen-note`）。
     落盘仍只有一条路：`src/ui/map-gen.ts` 的 `generateIntoMap()` —— 工作室的「采用到地图」
     与助手的 `generate_map` 动作共用它，一次 store.update ⇒ 一步 Ctrl+Z 就能撤销回去。 */
  const genNote = host.querySelector('#map-gen-note') as HTMLElement;
  host.querySelector('#map-gen')?.addEventListener('click', () => { openMapStudioFromToolbar(store); });
  setMode('move');

  function renderSvg() {
    const m = curMap();
    if (!m) { svg.innerHTML = ''; return; }   /* maps 瞬时缺失（worldsets 被整体替换中）→ 这一帧不画 */
    /* 现状一行（生成工作室搬走之后，这里是「现在长的是什么」的唯一去处）：
       参数直接从缓存里取统计，不重算 —— 这一帧的 `terrainVectors()` 刚算过同一份网格。 */
    const s = m.terrain ? terrainSummary(m.terrain, m.width, m.height) : null;
    genNote.textContent = s && m.terrain
      ? `${s.lands} 块陆地 · ${s.islands} 座岛 · ${s.zones} 个地形区 · ${s.rivers} 条河 · ${s.lakes} 个湖 · 种子「${m.terrain.seed}」`
      : '还没有地形';
    /* ⭐ 生成的地形 = 一张现算出来的图（`src/ui/map-terrain.ts`）。
       画在最底层，手绘的区域 / 标记 / 轨迹都盖在它上面 ⇒「生成作底稿、手绘精修」。 */
    const terr = terrainDataUrl(m.terrain, m.width, m.height);
    const terrain = terr
      ? `<image href="${terr}" x="0" y="0" width="${m.width}" height="${m.height}" preserveAspectRatio="none" data-terrain="1" style="pointer-events:none;"/>`
      : '';
    /* ⭐ 矢量层（同一份网格派生）：岸线 / 湖岸 / 河 —— 底图是位图（放大糊），
       地图之所以像地图靠的是这几条**线**（放大不糊、以后能点、能挂设定）。
       一律 `pointer-events:none`：它们是底稿，不许挡住画区域 / 放标记 / 平移。 */
    const vec = terrainVectors(m.terrain, m.width, m.height);
    const coast = vec.coast
      .map((d) => `<path d="${d}" fill="none" stroke="rgba(22,34,46,.72)" stroke-width="1.3" stroke-linejoin="round" data-coast="1" style="pointer-events:none;"/>`)
      .join('');
    const lakeEdge = vec.lakes
      .map((d) => `<path d="${d}" fill="none" stroke="rgba(30,56,78,.7)" stroke-width="1.1" data-lake="1" style="pointer-events:none;"/>`)
      .join('');
    const riverLine = vec.rivers
      .map((d) => `<path d="${d}" fill="none" stroke="rgba(64,104,132,.6)" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" data-river="1" style="pointer-events:none;"/>`)
      .join('');
    const regions = m.regions
      .map(
        (r) =>
          `<path d="${r.path}" fill="${r.fill}" fill-rule="${r.rule ?? 'nonzero'}" stroke="rgba(58,58,52,.5)" stroke-width="1" data-region="${escapeHtml(r.name)}" style="cursor:pointer;" title="${escapeHtml(r.name)}"/>`
      )
      .join('');
    /* 开放线（手绘水系 / 轨迹）：画在区域之上、标记之下。`lines` 可选（旧数据没有）。 */
    const lines = (m.lines ?? [])
      .map(
        (l) =>
          `<path d="${polylinePath(l.points)}" fill="none" stroke="${l.color ?? 'var(--fg-2)'}" stroke-width="${l.width ?? 1.5}" stroke-linecap="round" stroke-linejoin="round" data-line-kind="${l.kind}"${l.name ? ` data-line="${escapeHtml(l.name)}"` : ''}/>`
      )
      .join('');
    const markers = m.markers
      .map(
        (mk) =>
          `<g transform="translate(${mk.x},${mk.y})" style="cursor:pointer;">
            <circle r="6" fill="var(--accent)" stroke="var(--accent-on)" stroke-width="1"/>
            <text y="-10" text-anchor="middle" style="font-size:10px;fill:var(--fg);">${escapeHtml(mk.label)}</text>
          </g>`
      )
      .join('');
    const drawingPath = drawing.length > 1 ? `<path d="${smoothClosedPath(drawing)}" fill="rgba(158,194,98,.15)" stroke="var(--accent)" stroke-width="1" stroke-dasharray="4 2"/>` : '';
    /* 层序：地形图（底）→ 文化分区色块（**动手层**）→ 岸线/湖岸/河（压在上面才清晰）
       → 手绘开放线 → 标记 → 正在画的那一笔。 */
    svg.innerHTML = terrain + regions + coast + lakeEdge + riverLine + lines + markers + drawingPath;
  }

  let panning = false, panX = 0, panY = 0, panSX = 0, panSY = 0;

  /* ⭐ 适应窗口：地图数据一直是 900×500，而沙盘右半边那格比它窄 —— 不缩的话生成完只能
     看到左上角一块（2026-10-13 真机截图发现的）。缩放只动 CSS transform，不动数据；
     代价是**指针坐标要按缩放比换算回 SVG 用户坐标**（见 `local()`），否则手绘会画偏。 */
  let viewScale = 1;
  function fitView() {
    const m = curMap();
    const box = svg.parentElement;
    if (!m || !box) return;
    const bw = box.clientWidth || m.width;
    const bh = box.clientHeight || m.height;
    viewScale = Math.min(bw / m.width, bh / m.height, 1);
    svg.style.transformOrigin = '0 0';
    svg.style.transform = `scale(${viewScale})`;
    svg.style.left = Math.max(0, Math.round((bw - m.width * viewScale) / 2)) + 'px';
    svg.style.top = Math.max(0, Math.round((bh - m.height * viewScale) / 2)) + 'px';
  }
  /** 视口坐标 → SVG 用户坐标（缩放后 rect 变小了，必须除回来） */
  function local(e: PointerEvent): [number, number] {
    const r = svg.getBoundingClientRect();
    const k = (curMap()?.width ?? 900) / (r.width || 1);
    return [(e.clientX - r.left) * k, (e.clientY - r.top) * k];
  }

  /* 收尾统一入口。commit=true（正常 pointerup）才把区域落盘；
     其余情况（pointercancel、丢失的 pointerup）丢弃这一笔，避免半成品区域写进数据。 */
  function endDrag(commit: boolean) {
    if (commit && mode === 'region' && drawing.length >= 3) {
      const pts = drawing;
      const fill = `rgba(${158 + Math.floor(Math.random() * 60)},${150 + Math.floor(Math.random() * 50)},${98},0.25)`;
      save((m) => {
        m.regions.push({
          id: uid('rg'),
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
    const [x, y] = local(e);
    if (mode === 'region') {
      drawing = [[x, y]];
      renderSvg();
    } else if (mode === 'marker') {
      save((m) => { m.markers.push({ id: uid('mk'), x, y, label: `M${labelSeq++}` }); });
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
      drawing.push(local(e));
      renderSvg();
    } else if (panning) {
      svg.style.left = panX + (e.clientX - panSX) + 'px';
      svg.style.top = panY + (e.clientY - panSY) + 'px';
    }
  };
  const onUp = () => endDrag(true);
  const onCancel = () => endDrag(false);
  const onResize = () => fitView();
  mapCleanup?.();
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('resize', onResize);
  mapCleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('resize', onResize);
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
  fitView();
  renderSvg();
}
