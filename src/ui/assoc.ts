/** 词义联想 · 无限画布 + 力导向节点 + 单线聚焦（完整还原 legacy）
 * 点击根词 → 展开联想（Ollama/API）；节点可拖拽（组跟随）；Alt+滚轮缩放；拖拽平移
 * 放在灵感触发器生成卡片下方，独立画布区域
 */
import { loadSettings } from './settings';
import { escapeHtml } from './html';

interface AssocNode {
  id: number; word: string; isRoot: boolean; parent: number | null;
  children: number[]; expanded: boolean; selected: boolean;
  x: number; y: number; vx: number; vy: number;
  w?: number; h?: number;
  focusChildId?: number | null;
}
interface AssocEdge { from: number; to: number; }
interface AssocGraph { nodes: AssocNode[]; edges: AssocEdge[]; wordIndex: Record<string, number>; }

/* 初版把画布当成一个 2000×1200 的「世界」，节点和视窗都被夹在里头。
   用户 2026-09-12：「**现在有边界了，向上拖不动节点了，我想要无限画布**」——
   于是三个夹子全撤：拖节点不再夹、力导向不再夹、视窗平移也不再夹（只保留缩放 0.4~3）。
   这两个常量现在只剩两个用途：① 新节点的初始落点参考区 ② 连线 SVG 的作图原点与 viewBox。
   连线必须能画到框外 ⇒ `.assoc__lines` 在 `src/style.css` 里 `overflow: visible`
   （SVG 根元素默认裁到自己的视口，节点跑到框外时连线会被裁掉）。
   视窗可以飘到很远，靠画布里的「回到节点群」按钮回来（`updateViewportHelp` / `recenterToNodes`，早就有）。 */
const HOME_W = 2000, HOME_H = 1200;
/* 拖节点时贴边自动推视窗（用户 2026-09-12：「把节点移出视窗时视窗不会顺着移动」）：
   指针进到画布边缘 PAN_EDGE 以内就持续朝那个方向推；拖出画布甚至拖出窗口也算，越界越深推得越快。 */
const PAN_EDGE = 56, PAN_MAX_V = 18;

/** 沿祖先链找第一个「真的能滚」的容器（overflowY 是 auto/scroll 且 scrollHeight > clientHeight）。
 *  别写死类名：工具宿主从 `.lk-module-view` 换成 `.lk-tool-slot` 时，写死的那份会静默失效
 *  （滚轮在画布上毫无反应），症状还很难联想到根因。 */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return null;
}

/** 挂载联想画布。返回清理函数：摘掉全部 window 监听 + 停掉两个 requestAnimationFrame 循环。
 *  调用方（inspire.ts → tools/register.ts 的 open）必须把它交回 registry，
 *  否则工具切走后监听与帧循环会一直留在 window 上，每点一次工具积一份。 */
export function mountAssocCanvas(host: HTMLElement, getWord: () => string): () => void {
  host.style.overflow = 'hidden';
  host.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;">
      <div style="display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--border-soft);background:var(--surface-2);">
        <span style="font-size:var(--text-xs);font-weight:600;color:var(--fg);">词义联想</span>
        <input id="assoc-input" placeholder="输入词，回车联想…" style="width:110px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 8px;font-size:11px;outline:none;" />
        <span id="assoc-status" style="font-size:11px;color:var(--fg-2);font-family:var(--font-mono);">点词条展开联想</span>
        <span style="flex:1;"></span>
        <button id="assoc-export" title="把暂存词经 Ollama 归类写入词库" style="background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-sm);padding:3px 10px;font-size:11px;cursor:pointer;">导出暂存词（<span id="assoc-staged-cnt">0</span>）</button>
        <span style="font-size:10px;color:var(--fg-2);">左键拖节点/拖空白 · 中键轮盘移动 · Alt+滚轮缩放</span>
      </div>
      <div id="assoc-stage" style="flex:1;position:relative;overflow:hidden;cursor:default;background:var(--surface);">
        <div id="assoc-world" style="position:absolute;top:0;left:0;width:${HOME_W}px;height:${HOME_H}px;transform-origin:0 0;">
          <svg class="assoc__lines" style="position:absolute;top:0;left:0;width:${HOME_W}px;height:${HOME_H}px;pointer-events:none;"></svg>
        </div>
        <!-- 轮盘方向指示箭头（锚定在屏幕，画布平移/缩放不带动它） -->
        <svg id="assoc-rocker-arrow" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;display:none;">
          <line id="assoc-rocker-line" stroke="var(--accent)" stroke-width="2" stroke-dasharray="4 3"></line>
          <polygon id="assoc-rocker-head" fill="var(--accent)"></polygon>
          <circle id="assoc-rocker-ctr" r="3" fill="var(--accent)"></circle>
        </svg>
        <!-- 节点全移出屏幕时的「返回」指示（可点击回到节点群） -->
        <button id="assoc-goto" title="回到节点" style="position:absolute;display:none;align-items:center;gap:6px;padding:6px 12px;border:none;border-radius:var(--radius-sm);background:var(--accent);color:var(--accent-on);font-size:12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);z-index:6;white-space:nowrap;">
          <span id="assoc-goto-arrow">◀</span>回到节点群
        </button>
      </div>
    </div>`;

  const stage = host.querySelector('#assoc-stage') as HTMLElement;
  const world = host.querySelector('#assoc-world') as HTMLElement;
  const status = host.querySelector('#assoc-status') as HTMLElement;
  /* 注意：不缓存 svg 引用——renderGraph 会重建 innerHTML，旧引用失效。drawEdges 动态获取。 */

  let assocGraph: AssocGraph | null = null;
  let focusedId = 0;
  /* 已加载词库里的全部词（跨分类）。导出查重的唯一依据——旧代码只声明从未填充，
     于是 `wordLib.has(w)` 恒为 false，守卫不可达；而下面只做「同分类」查重，
     结果是已存在于别的分类的词被重复写进新分类、added 计数偏大。 */
  const wordLib = new Set<string>();
  function fillWordLib(lib: Record<string, string[]> | null | undefined) {
    wordLib.clear();
    if (!lib) return;
    Object.keys(lib).forEach((cat) => {
      const list = lib[cat];
      if (Array.isArray(list)) list.forEach((w) => { if (typeof w === 'string') wordLib.add(w); });
    });
  }

  /* ── 暂存词表（点「存」→ localStorage，导出时经 Ollama 归类写入词库）── */
  const STAGED_KEY = 'lingkuang-char-staged';
  let staged: string[] = [];
  try {
    staged = (JSON.parse(localStorage.getItem(STAGED_KEY) || '[]') || []).filter((w: string) => typeof w === 'string' && w.length > 0);
  } catch { staged = []; }
  function persistStaged() {
    try { localStorage.setItem(STAGED_KEY, JSON.stringify(staged)); } catch { /* ignore */ }
  }

  /* ── 平移 + 缩放 ── */
  let assocPanX = 0, assocPanY = 0, assocZoom = 1;
  /* 左键拖空白 → 跟手平移画布 */
  let isBlankPan = false, panSX = 0, panSY = 0, panOX = 0, panOY = 0;
  /* 中键「轮盘/摇杆」移动：点一下进入，按 按下点→鼠标当前 的方向持续平移 */
  let isRocker = false, joyCX = 0, joyCY = 0, joyDX = 0, joyDY = 0, rockerRAF: number | null = null;
  let dragNodeId: number | null = null, dragMoved = false, dragSX = 0, dragSY = 0, dragGroup: Set<number> | null = null, suppressClick = false;
  let suppressClickTimer: number | null = null;   /* 卸载时要清掉，否则回调在画布销毁后才跑 */
  /* 拖节点时的贴边自动推视窗：dragPanX0/Y0 = 按下那一刻的视窗平移量（算拖拽位移时要扣掉它），
     dragPX/PY = 指针最后位置（指针不动时靠 rAF 循环继续推），autoPanRAF = 推视窗的帧循环 */
  let dragPanX0 = 0, dragPanY0 = 0, dragPX = 0, dragPY = 0, autoPanRAF: number | null = null;
  /* 钉住（`_pinned`）的效力上限：两个相连的词被拉开超过这么多像素，钉子就松开、让弹簧把线收回来。
     静止长度是 140（弹簧 `(d - 140) * 0.05`），这里给到约 3 倍，小范围摆位不受影响。 */
  const PIN_YIELD = 420;

  /* 统一复位指针手势：pointerup / pointercancel / 「丢失 pointerup 的 pointermove」兜底都走这里。
     旧实现只有 pointerup 一个出口，且全文件没有 pointercancel——
     指针在窗口外松开、系统撤销指针、alt-tab 之后就永远停在拖动态。 */
  function endPointerGestures(): void {
    const wasDrag = dragMoved;
    dragNodeId = null; dragGroup = null; isBlankPan = false;
    stopAutoPan();   /* 拖完了 → 停掉贴边推视窗的帧循环 */
    stage.style.cursor = 'default';   /* 空白恢复=正常 */
    if (wasDrag) suppressClick = true;   /* 拖拽节点 → 抑制紧随的 click */
    dragMoved = false;
    if (suppressClickTimer !== null) clearTimeout(suppressClickTimer);
    suppressClickTimer = window.setTimeout(() => { suppressClick = false; suppressClickTimer = null; }, 0);   /* 无论如何都清，防止卡住 */
  }

  function applyWorldTransform() {
    world.style.transform = `translate(${assocPanX}px,${assocPanY}px) scale(${assocZoom})`;
    updateViewportHelp();   /* 视图变换后同步「返回节点」提示 */
  }

  /* ── 拖节点：把节点摆到指针下 ──
     关键：位移里必须**扣掉视窗自己平移过的量**（`assocPanX - dragPanX0`）。
     不扣的话，贴边自动推视窗时节点会从鼠标底下溜走 —— 因为「指针没动」而「画布动了」时，
     节点在世界里的坐标也该跟着变。扣掉之后：节点屏幕位置 = 世界坐标×缩放 + 平移量，
     化简后恒等于「按下时的屏幕位置 + 指针位移」，与视窗怎么动无关（贴手、不漂）。 */
  function applyDrag(cx: number, cy: number): void {
    if (dragNodeId === null || !assocGraph) return;
    const dn = assocGraph.nodes[dragNodeId];
    if (!dn) return;
    const dx = cx - dragSX - (assocPanX - dragPanX0);
    const dy = cy - dragSY - (assocPanY - dragPanY0);
    if (!dragMoved && Math.abs(dx) + Math.abs(dy) > 4) dragMoved = true;
    if (!dragMoved) return;
    /* ⚠️ 刻意**不夹**在世界边界里（用户 2026-09-12 要「无限画布」）：夹了的话节点一碰边就钉住、
       从边上根本拖不出去（往上拖尤其明显 —— 世界顶边 y=20 就在眼前）。
       松手后也不能再被力导向夹回来 ⇒ `forceStep` 里那四个边界判断也一并撤了。 */
    dn.x = (dn as any)._dragOx + dx / assocZoom;
    dn.y = (dn as any)._dragOy + dy / assocZoom;
    dn.vx = 0; dn.vy = 0;
    /* 手动摆过的节点**钉住**：松手后不许力导向把它拽回原位（见 forceStep 里的 _pinned 分支）。
       实测（2026-09-12）：只撤边界不钉位置的话，往正上方拖 300px、松手 2 秒内会被弹簧拽回约 200px 并继续荡
       —— 用户看到的就是「拖了又弹回去」。 */
    (dn as any)._pinned = true;
    world.querySelectorAll('.assoc__node, .assoc__root').forEach((el, i) => {
      const n = assocGraph!.nodes[i];
      if (n) (el as HTMLElement).style.transform = `translate(${n.x}px,${n.y}px)`;
    });
    drawEdges();
  }

  /** 指针离画布边缘多近 → 推力（+1 = 贴着左边、要往左推；-1 = 贴着右边；0 = 在中间不推）。
   *  拖到画布外（甚至窗口外）时值为 ±1（越界越深也是 ±1），所以「拖出视窗」照样持续推。 */
  function edgePush(pos: number, lo: number, hi: number): number {
    const a = Math.min(1, Math.max(0, (PAN_EDGE - (pos - lo)) / PAN_EDGE));
    const b = Math.min(1, Math.max(0, (PAN_EDGE - (hi - pos)) / PAN_EDGE));
    return a - b;
  }
  function stopAutoPan(): void {
    if (autoPanRAF !== null) { cancelAnimationFrame(autoPanRAF); autoPanRAF = null; }
  }
  /* 贴边自动推视窗：**不再夹在世界边界里**（原本有 clampPanToWorld，「无限画布」要撤掉它）。
     旧版夹它的理由 —— 「节点被力导向夹在世界里、推过头只剩空白、被拖的节点会先撞墙然后被甩在鼠标后面」
     —— 随着节点夹子一起作废：现在节点能一直跟着指针走，视窗也就该一直跟。 */
  function autoPanTick(): void {
    autoPanRAF = null;   /* 先清再判：下面 applyDrag 不会再启动第二个循环 */
    if (dragNodeId === null || !dragMoved || !host.isConnected) return;
    const r = stage.getBoundingClientRect();
    const px = edgePush(dragPX, r.left, r.right);
    const py = edgePush(dragPY, r.top, r.bottom);
    if (!px && !py) return;   /* 指针回到中间 → 停帧；下次 pointermove 会再启动 */
    assocPanX += px * PAN_MAX_V;
    assocPanY += py * PAN_MAX_V;
    applyWorldTransform();
    applyDrag(dragPX, dragPY);   /* 视窗动了 → 立刻把节点重新贴回指针（它世界坐标要跟着变） */
    autoPanRAF = requestAnimationFrame(autoPanTick);   /* 指针还在边上就一直推（没有边界，永不"推到头"） */
  }
  /** 指针不动时也要继续推（pointermove 不会再来），所以用 rAF 循环；已在跑就不重复起。 */
  function ensureAutoPan(): void {
    if (autoPanRAF === null && dragNodeId !== null && dragMoved && host.isConnected) {
      autoPanRAF = requestAnimationFrame(autoPanTick);
    }
  }
  /* 中键轮盘移动：每帧沿 按下点→当前鼠标 的方向持续位移 */
  function startRockerLoop() {
    if (rockerRAF !== null) cancelAnimationFrame(rockerRAF);   /* 只取消旧帧，不动 isRocker */
    const tick = () => {
      /* 自检：退出轮盘状态或画布已不在文档里（工具切走）→ 停帧，不再空转 */
      if (!isRocker || !host.isConnected) { stopRockerLoop(); return; }
      const dist = joyDX * joyDX + joyDY * joyDY;
      if (dist > 49) { /* 死区：偏移 <7px 不动，防抖 */
        const len = Math.sqrt(dist);
        const speed = Math.min(len * 0.015, 6);   /* 偏移越大越快，封顶 6px/帧；斜率减半 → 低速区更宽更易精细 */
        /* 画布朝「按下点→鼠标」方向移动（所见即所得：箭头指向哪，内容就往哪滚） */
        assocPanX -= (joyDX / len) * speed;
        assocPanY -= (joyDY / len) * speed;
        applyWorldTransform();
      }
      rockerRAF = requestAnimationFrame(tick);
    };
    rockerRAF = requestAnimationFrame(tick);
  }
  function stopRockerLoop() {
    if (rockerRAF !== null) { cancelAnimationFrame(rockerRAF); rockerRAF = null; }
    isRocker = false;
    if (stage) stage.style.cursor = 'default';   /* 退出轮盘 → 恢复光标 */
    hideRockerArrow();   /* 退出轮盘 → 隐藏方向箭头 */
  }

  /* ── 轮盘方向指示箭头（锚定屏幕坐标，画布平移/缩放不带动）── */
  function updateRockerArrow() {
    const svg = host.querySelector('#assoc-rocker-arrow') as SVGSVGElement | null;
    const line = svg?.querySelector('#assoc-rocker-line') as SVGLineElement | null;
    const head = svg?.querySelector('#assoc-rocker-head') as SVGPolygonElement | null;
    const ctr = svg?.querySelector('#assoc-rocker-ctr') as SVGCircleElement | null;
    if (!svg || !line || !head || !ctr) return;
    svg.style.display = 'block';
    const rect = stage.getBoundingClientRect();
    const cx = joyCX - rect.left, cy = joyCY - rect.top;
    ctr.setAttribute('cx', String(cx)); ctr.setAttribute('cy', String(cy));
    const dist = joyDX * joyDX + joyDY * joyDY;
    if (dist < 49) {   /* 死区内：只画中心点 */
      line.setAttribute('x1', String(cx)); line.setAttribute('y1', String(cy));
      line.setAttribute('x2', String(cx)); line.setAttribute('y2', String(cy));
      head.setAttribute('points', '');
      return;
    }
    const len = Math.sqrt(dist);
    /* 箭头长度反映「实际移动速度」（speed = len*0.015 封顶6）：速度越大箭头越长，直观体现当前速度档 */
    const speed = Math.min(len * 0.015, 6);
    const L = Math.max(16, (speed / 6) * 240);   /* 最低16px可见，满速240px */
    const nx = joyDX / len, ny = joyDY / len;
    const x2 = cx + nx * L, y2 = cy + ny * L;
    line.setAttribute('x1', String(cx)); line.setAttribute('y1', String(cy));
    line.setAttribute('x2', String(x2)); line.setAttribute('y2', String(y2));
    /* 三角箭头 */
    const ah = 10, aw = 6;
    const bx1 = x2 - nx * ah + ny * aw, by1 = y2 - ny * ah - nx * aw;
    const bx2 = x2 - nx * ah - ny * aw, by2 = y2 - ny * ah + nx * aw;
    head.setAttribute('points', `${x2},${y2} ${bx1},${by1} ${bx2},${by2}`);
  }
  function hideRockerArrow() {
    const s = host.querySelector('#assoc-rocker-arrow');
    if (s) (s as HTMLElement).style.display = 'none';
  }

  /* ── 节点全移出屏幕时：屏幕边缘方向箭头 + 「回到节点群」按钮 ── */
  function updateViewportHelp() {
    const btn = host.querySelector('#assoc-goto') as HTMLButtonElement | null;
    const arrowEl = host.querySelector('#assoc-goto-arrow') as HTMLSpanElement | null;
    if (!btn || !assocGraph || !assocGraph.nodes.length) { if (btn) btn.style.display = 'none'; return; }
    const W = stage.clientWidth, H = stage.clientHeight;
    if (W === 0 || H === 0) return;
    /* CSS transform: translate(t) scale(s) → 节点屏幕坐标 = p*s + t */
    const z = assocZoom, px = assocPanX, py = assocPanY;
    let anyVisible = false, cxp = 0, cyp = 0, cnt = 0;
    assocGraph.nodes.forEach((n) => {
      const sx = n.x * z + px, sy = n.y * z + py;
      cxp += sx; cyp += sy; cnt++;
      if (sx >= 0 && sx <= W && sy >= 0 && sy <= H) anyVisible = true;
    });
    if (anyVisible) { btn.style.display = 'none'; return; }   /* 还有节点在屏内 → 不需要提示 */
    /* 全部移出 → 显示，定位在质心方向对应的屏幕边缘 */
    cxp /= cnt; cyp /= cnt;
    /* 质心相对 stage 中心的方向占比 */
    const dx = cxp - W / 2, dy = cyp - H / 2;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    let posX: number, posY: number, arrow: string;
    if (adx >= ady) {   /* 横向为主：箭头放左/右边缘 */
      posX = dx >= 0 ? W - 24 : 12; posY = H / 2;
      arrow = dx >= 0 ? '◀' : '▶';
    } else {            /* 纵向为主：放上/下边缘 */
      posX = W / 2; posY = dy >= 0 ? H - 24 : 12;
      arrow = dy >= 0 ? '▲' : '▼';
    }
    btn.style.display = 'flex';
    btn.style.left = (posX - btn.offsetWidth / 2) + 'px';
    btn.style.top = (posY - btn.offsetHeight / 2) + 'px';
    if (arrowEl) arrowEl.textContent = arrow;
  }
  /* 回到节点群：把节点质心平移到画布中心 */
  function recenterToNodes() {
    if (!assocGraph || !assocGraph.nodes.length) return;
    const W = stage.clientWidth, H = stage.clientHeight;
    if (W === 0 || H === 0) return;
    const z = assocZoom;
    let cx = 0, cy = 0, cnt = 0;
    assocGraph.nodes.forEach((n) => { cx += n.x; cy += n.y; cnt++; });
    cx /= cnt; cy /= cnt;
    assocPanX = W / 2 - cx * z;
    assocPanY = H / 2 - cy * z;
    applyWorldTransform();
    updateViewportHelp();
  }
  function assocStatus(m: string) { status.textContent = m; }

  /* 词库命中检测 */
  /* 清洗联想词：去掉首尾符号/空白，只留 1-8 字真词（不靠 \\W，中文会被误判） */
  function cleanWords(raw: string): string[] {
    const strip = /^[\s\d\-—.*•·、，。！？、:：;；()（）\[\]【】"'“”‘’]+|[\s\d\-—.*•·、，。！？、:：;；()（）\[\]【】"'“”‘’]+$/g;
    return raw
      .split('\n')
      .map((x) => x.trim())
      .map((x) => x.replace(strip, ''))
      .filter((x) => x.length >= 1 && x.length <= 8)
      .filter((x) => /[\u4e00-\u9fa5a-zA-Z0-9]/.test(x))
      .slice(0, 7);
  }

  /* 收集子树（拖动整组跟随） */
  function collectTree(rootId: number): Set<number> {
    const set = new Set<number>();
    const walk = (nid: number) => {
      if (set.has(nid)) return;
      set.add(nid);
      const n = assocGraph?.nodes[nid];
      if (n) n.children.forEach(walk);
    };
    walk(rootId);
    return set;
  }

  /* ── 可见性：selected 永远保留；展开节点的子层（受 focusChildId 限制）── */
  function visibleIds(): Set<number> {
    const vis = new Set<number>();
    if (!assocGraph || !assocGraph.nodes.length) return vis;
    /* 所有节点都显示（聚焦=视觉淡化非焦点路径，不物理隐藏——多分支数据全保留） */
    assocGraph.nodes.forEach((n) => vis.add(n.id));
    return vis;
  }

  /* ── 点击节点（单线聚焦状态机）── */
  function onNodeClick(id: number) {
    if (!assocGraph) return;
    const node = assocGraph.nodes[id];
    if (!node) return;
    focusedId = id;
    const parent = node.parent !== null ? assocGraph.nodes[node.parent] : null;
    if (parent) {
      /* 点子词：选中（保留思维链）+ 收起父的其他兄弟（focusChildId）+ 独立展开该词（无论是否展开过都联想） */
      node.selected = true;
      parent.focusChildId = id;
      /* 思维链上的词自动存进暂存表（不用手动点「存」） */
      if (staged.indexOf(node.word) === -1) { staged.push(node.word); persistStaged(); updateStagedCnt(); }
      (node as any)._staged = true;
      expandNode(id);
      return;
    }
    /* 点父级/根：也触发独立展开（二次联想）——恢复收起或展开 */
    if (node.children.length) {
      if (node.focusChildId !== null && node.focusChildId !== undefined) {
        node.focusChildId = null;
        renderGraph();
        assocStatus('恢复全部子层');
      } else {
        expandNode(id);   /* 点根词等前级：独立展开联想新分支 */
      }
    } else if (!node.expanded) {
      expandNode(id);
    }
  }

  /* ── 力导向 ── */
  function forceStep(nodes: AssocNode[], vis: Set<number>, edges: AssocEdge[], temp: number, damp: number, dragGroup: Set<number> | null) {
    const nodeById: Record<number, AssocNode> = {};
    nodes.forEach((n) => { nodeById[n.id] = n; });
    const vList = nodes.filter((n) => vis.has(n.id));
    /* ⭐ 「手里那一格」的受力只免**它自己**，线的另一头照常受力。
       用户 2026-09-13 报「线没断，但是拉力失效了」：原来是「跨过手里那一格的受力**两边一起**跳过」
       （`if (dragGroup && has(a) !== has(b)) continue/return`），于是拖一个词走的**全程**
       与它相连的词纹丝不动（实测：拖子节点 120px，根词位移 0），松手之后才追过来 ——
       看着就是「线还在、线上没有力」，拖得越远越明显。
       被拖的那一格在下面积分阶段本来就被冻住（`n.id === dragNodeId`），所以只免它、别的一律照拉。 */
    const inHand = (id: number) => dragGroup !== null && dragGroup.has(id);
    for (let i = 0; i < vList.length; i++) {
      for (let j = i + 1; j < vList.length; j++) {
        const a = vList[i], b = vList[j];
        const aIn = inHand(a.id), bIn = inHand(b.id);
        if (aIn && bIn) continue;   /* 两端都在手里（拖的是整棵子树）→ 组内力学照旧，组形不变 */
        const dx = a.x - b.x, dy = a.y - b.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (900 / (d * d)) * temp;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        if (!aIn) { a.vx += fx; a.vy += fy; }
        if (!bIn) { b.vx -= fx; b.vy -= fy; }
      }
    }
    edges.forEach((e) => {
      const a = nodeById[e.from], b = nodeById[e.to];
      if (!a || !b || !vis.has(a.id) || !vis.has(b.id)) return;
      const aIn = inHand(a.id), bIn = inHand(b.id);
      if (aIn && bIn) return;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      /* 钉住是「别乱动」，不是「焊死」：被拉得超过 PIN_YIELD 就**松开钉子跟着走**。
         否则「我手工摆过的词」会成为唯一一处"拉力失效"的地方 —— 而用户报的正是拉力失效
         （2026-09-13：「拉太远时拉力会失效」）。手动摆过 → 在原地不动；被拉太远 → 弹簧赢。
         阈值取得比静止长度（140）大得多，所以小范围摆位不受影响。 */
      if (!aIn && d > PIN_YIELD) (a as any)._pinned = false;
      if (!bIn && d > PIN_YIELD) (b as any)._pinned = false;
      const f = (d - 140) * 0.05 * temp;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      if (!aIn) { a.vx += fx; a.vy += fy; }
      if (!bIn) { b.vx -= fx; b.vy -= fy; }
    });
    vList.forEach((n) => {
      if (dragGroup && n.id === dragNodeId) { n.vx = 0; n.vy = 0; return; }
      /* 手动摆过的节点（`_pinned`，在 applyDrag 里打标记）不再被力导向积分挪动：
         它仍然参与上面的斥力/弹簧计算（会把别的节点推开、把子节点拉过来），但自己的位置不动。
         这就是「无限画布」里"我放哪儿就待在哪儿"的那一半；撤掉边界只解决了"能拖出去"。
         ⚠️ 例外：被拉得超过 PIN_YIELD 时上面的弹簧会把钉子摘掉（见那里的注释）。 */
      if ((n as any)._pinned) { n.vx = 0; n.vy = 0; return; }
      n.vx *= damp; n.vy *= damp; n.x += n.vx * 0.5; n.y += n.vy * 0.5;
      /* ⚠️ 这里原来有四个「夹在世界里」的判断（20 .. WORLD_W-20），已撤掉：
         用户要的是无限画布 —— 夹住的话节点一碰边就停、松手还会被拽回世界内。
         现在节点的世界坐标不设上下限（可以为负），图的聚拢靠弹簧（子节点被拉到父节点 140px 处）
         与斥力的平衡，不再拿边界当容器。 */
    });
  }

  function drawEdges() {
    const svg = world.querySelector('.assoc__lines') as SVGSVGElement | null;
    if (!svg || !assocGraph) return;
    svg.setAttribute('viewBox', `0 0 ${HOME_W} ${HOME_H}`);
    const nodeById: Record<number, AssocNode> = {};
    assocGraph.nodes.forEach((n) => { nodeById[n.id] = n; });
    /* 只画可见节点之间的边——收起节点的连线一并隐藏（视觉干净，只留聚焦链路） */
    const vis = visibleIds();
    svg.innerHTML = assocGraph.edges
      .filter((e) => vis.has(e.from) && vis.has(e.to))
      .map((e) => {
        const a = nodeById[e.from], b = nodeById[e.to];
        if (!a || !b) return '';
        const x1 = a.x + (a.w || 70) / 2, y1 = a.y + (a.h || 30) / 2;
        const x2 = b.x + (b.w || 70) / 2, y2 = b.y + (b.h || 30) / 2;
        return `<path d="M ${x1} ${y1} L ${x2} ${y2}" fill="none" stroke="rgba(58,58,52,0.25)" stroke-width="1.2"/>`;
      })
      .join('');
  }

  let simRAF: number | null = null;
  function stopSim() { if (simRAF) { cancelAnimationFrame(simRAF); simRAF = null; } }
  function startSim() {
    stopSim();
    if (!assocGraph) return;
    let frame = 0;
    const tick = () => {
      /* 画布已不在文档里（工具切走）或图已清空 → 停帧。旧代码在无节点时还无限续帧，
         面板关掉后这个循环也永远不会退场。 */
      if (!host.isConnected || !assocGraph || !assocGraph.nodes.length) { stopSim(); return; }
      frame++;
      const temp = frame < 90 ? 1 : 0.22;
      const damp = frame < 90 ? 0.82 : 0.92;
      const vis = visibleIds();
      /* 不把被拖节点从 vis 排除——保留它参与边张力，子节点拖动时才能被引力拉扯（拖动中有力学） */
      forceStep(assocGraph.nodes, vis, assocGraph.edges, temp, damp, dragNodeId !== null ? dragGroup : null);
      world.querySelectorAll('.assoc__node, .assoc__root').forEach((el, i) => {
        const n = assocGraph!.nodes[i];
        if (n) (el as HTMLElement).style.transform = `translate(${n.x}px,${n.y}px)`;
      });
      drawEdges();
      updateViewportHelp();   /* 节点移动时同步「返回节点」提示 */
      simRAF = requestAnimationFrame(tick);
    };
    simRAF = requestAnimationFrame(tick);
  }

  /* ── 渲染 world 内节点 ── */
  function renderGraph() {
    if (!assocGraph) return;
    world.style.width = HOME_W + 'px';
    world.style.height = HOME_H + 'px';
    const vis = visibleIds();
    world.innerHTML = '<svg class="assoc__lines" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;"></svg>'
      + assocGraph.nodes.map((n) => {
        const cls = n.isRoot ? 'assoc__root' : 'assoc__node';
        let extra = '';
        if (n.id === focusedId) extra += ' is-focus';
        if (n.selected) extra += ' is-selected';
        if ((n as any)._staged) extra += ' is-staged';   /* 已暂存：橙边框标记，与选中绿区分 */
        /* 视觉聚焦：非焦点路径的词淡化（不隐藏，保留多分支） */
        if (focusedId !== null && focusedId !== undefined && n.id !== focusedId && !isOnFocusPath(n.id)) extra += ' is-dim';
        const hidden = vis.has(n.id) ? '' : ' style="display:none"';
        /* n.word 来自工具栏输入框与 LLM 输出（cleanWords 只校验长度，`<b>x</b>` 能通过）：
           直接拼进 innerHTML 会变成真标签、`"` 会逃出 title 属性 → 按注入对待。
           普通中/英词转义后与原串完全一致，渲染结果不变。 */
        const wordHtml = escapeHtml(n.word);
        return `<span class="${cls}${extra}" data-id="${n.id}" title="${wordHtml}"${hidden}>${wordHtml}</span>`;
      })
      .join('');
    world.querySelectorAll('.assoc__node, .assoc__root').forEach((el, i) => {
      const n = assocGraph!.nodes[i];
      if (!n) return;
      n.w = (el as HTMLElement).offsetWidth;
      n.h = (el as HTMLElement).offsetHeight;
      (el as HTMLElement).style.transform = `translate(${n.x}px,${n.y}px)`;
    });
    drawEdges();
  }
  /* ── 联想调用（Ollama 双模式）── */
  async function callAssociate(id: number) {
    const node = assocGraph?.nodes[id];
    if (!node) return;
    assocStatus(`展开「${node.word}」的联想…`);
    let words: string[] = [];
    try {
      const cfg = loadSettings();
      const messages = [{ role: 'user', content: '你是词义联想引擎。给定一个词，生成 5-7 个不同的发散联想词。\n规则：1. 后一个词由前一个词自然联想而来 2. 词要具体、有画面感，2-4字中文名词为主 3. 输出格式：每行一个词，不要序号解释\n\n输入词：\n' + node.word }];
      if (cfg.aiMode === 'api') {
        if (!cfg.apiKey) { assocStatus('API 模式需在设置填 Key'); return; }
        const r = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey }, body: JSON.stringify({ model: cfg.model, messages, temperature: 0.8, max_tokens: 200 }) });
        if (!r.ok) throw new Error('api ' + r.status);
        words = cleanWords((await r.json()).choices[0].message.content || '');
      } else {
        const r = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: cfg.model, messages, stream: false, options: { temperature: 0.8, num_predict: 200, think: false } }) });
        if (!r.ok) throw new Error('ollama ' + r.status);
        const msg = (await r.json()).message || {};
        /* qwen3: think:false 后内容应在 content；若仍空则读 thinking（兜底） */
        const text = msg.content || msg.thinking || '';
        words = cleanWords(text);
      }
    } catch (err) {
      /* 联想失败：不清 expanded（否则已展开的词变收起、新词也不显示）——只提示，保留展开状态 */
      renderGraph();
      assocStatus('联想失败：' + (err instanceof Error ? err.message : String(err)));
      return;
    }
    if (!assocGraph) return;
    let added = 0;
    words.forEach((w) => {
      let nid: number;
      if (assocGraph!.wordIndex[w] !== undefined) {
        nid = assocGraph!.wordIndex[w];
        /* 词已存在（可能属别的父）：也把它加为当前词的子层。防环：若该词是当前词祖先则跳过 */
        if (isAncestor(nid, id)) return;
        if (!node.children.includes(nid)) node.children.push(nid);
      } else {
        nid = assocGraph!.nodes.length;
        assocGraph!.wordIndex[w] = nid;
        assocGraph!.nodes.push({
          id: nid, word: w, isRoot: false, parent: id, children: [], expanded: false, selected: false,  /* 普通节点，非选中 */
          x: node.x + (Math.random() - 0.5) * 200,
          y: node.y + (Math.random() - 0.5) * 200,
          vx: 0, vy: 0,
        });
        node.children.push(nid);
        added++;
      }
      if (nid !== id) {
        const dup = assocGraph!.edges.some((e) => e.from === id && e.to === nid);
        if (!dup) assocGraph!.edges.push({ from: id, to: nid });
      }
    });
    renderGraph();
    startSim();
    assocStatus(`「${node.word}」联想 ${added} 词 · 点词条展开 / 再点刷新`);
  }

  function expandNode(id: number) {
    const node = assocGraph?.nodes[id];
    if (!node) return;
    node.expanded = true;
    renderGraph();
    callAssociate(id);
  }

  /* 判断 target 是否是 ancestor 的祖先（沿 parent 链，防回环） */
  function isAncestor(ancestorId: number, targetId: number): boolean {
    let cur: number | null = targetId;
    let depth = 0;
    while (cur !== null && depth < 500) {
      if (cur === ancestorId) return true;
      cur = assocGraph?.nodes[cur]?.parent ?? null;
      depth++;
    }
    return false;
  }

  /* 是否在焦点路径上（根→focusedId 的祖先链 ∪ focusedId 自身 ∪ 它展开的子层）——这些高亮不淡化 */
  function isOnFocusPath(id: number): boolean {
    if (focusedId === null || focusedId === undefined) return true;   /* 未聚焦则全部正常 */
    if (id === focusedId) return true;
    /* 向上找：id 是否 focusedId 的祖先 */
    let cur: number | null = focusedId;
    let d = 0;
    while (cur !== null && cur !== undefined && d < 500) {
      if (cur === id) return true;   /* id 是焦点的祖先（路径上的中间节点） */
      cur = assocGraph?.nodes[cur]?.parent ?? null;
      d++;
    }
    /* id 是否 focusedId 展开的子层（当前聚焦级） */
    const f = assocGraph?.nodes[focusedId];
    if (f && f.children.includes(id)) return true;
    return false;
  }


  /* 移除子树（自身保留，skipSelected 跳过选中支线） */
  /* ── 交互事件 ──
     返回清理函数：window 上的 pointermove/pointerup/pointercancel/keydown 生命周期长于本视图，
     工具切走时必须逐个 removeEventListener，否则每点一次工具就多积一份。 */
  function bindEvents(): () => void {
    const onStagePointerDown = (e: PointerEvent) => {
      /* 已处于轮盘模式时，再按任何鼠标键 → 先退出轮盘（本次按键继续其默认行为，如左键拖节点） */
      if (isRocker) stopRockerLoop();
      const store = (e.target as HTMLElement).closest('.store');
      if (store) { /* 暂存交给 click */ return; }
      const nodeEl = (e.target as HTMLElement).closest('.assoc__node, .assoc__root');
      if (nodeEl && assocGraph && e.button === 0) {
        dragNodeId = parseInt((nodeEl as HTMLElement).dataset.id!, 10);
        dragGroup = collectTree(dragNodeId);
        dragSX = e.clientX; dragSY = e.clientY; dragMoved = false; suppressClick = false;
        dragPanX0 = assocPanX; dragPanY0 = assocPanY;   /* 记下按下时的视窗平移量：位移要扣掉它 */
        dragPX = e.clientX; dragPY = e.clientY;
        const dn = assocGraph.nodes[dragNodeId];
        if (dn) { (dn as any)._dragOx = dn.x; (dn as any)._dragOy = dn.y; }
        stage.style.cursor = 'grabbing';   /* 拖节点：抓手 */
        return;
      }
      /* 左键点空白 → 跟手平移画布 */
      if (e.button === 0) {
        isBlankPan = true; panSX = e.clientX; panSY = e.clientY; panOX = assocPanX; panOY = assocPanY;
        stage.style.cursor = 'grabbing';   /* 空白平移：抓手 */
        return;
      }
      /* 中键（button 1）按下 → 「轮盘/摇杆」模式：点一下进入，之后向 中心→鼠标 方向持续平移 */
      if (e.button === 1) {
        e.preventDefault();   /* 阻止浏览器中键自动滚动 */
        joyCX = e.clientX; joyCY = e.clientY;
        joyDX = 0; joyDY = 0;
        isRocker = true;
        stage.style.cursor = 'crosshair';   /* 轮盘用十字准星，不用抓手（鼠标不需按住拖动） */
        updateRockerArrow();   /* 显示方向指示箭头 */
        startRockerLoop();
      }
    };
    const onMove = (e: PointerEvent) => {
      /* 丢失 pointerup 的兜底：没按键却收到 move，说明收尾信号丢了（在窗口外松开 / pointercancel 未派发），
         就地复位拖动与平移——否则拖动态永远卡住。
         ⚠ 轮盘模式本来就不按住鼠标使用，所以不能在这里一律 return。 */
      if (e.buttons === 0 && !isRocker && (dragNodeId !== null || isBlankPan)) {
        endPointerGestures();
        return;
      }
      if (dragNodeId !== null && assocGraph) {
        const dn = assocGraph.nodes[dragNodeId];
        if (!dn) { dragNodeId = null; dragGroup = null; return; }
        dragPX = e.clientX; dragPY = e.clientY;
        applyDrag(e.clientX, e.clientY);
        ensureAutoPan();   /* 指针贴在边缘（或已拖出视窗）→ 持续推视窗 */
        return;
      }
      if (isBlankPan) {
        assocPanX = panOX + (e.clientX - panSX);   /* 左键拖空白：跟手平移 */
        assocPanY = panOY + (e.clientY - panSY);
        applyWorldTransform();
      }
      if (isRocker) {
        e.preventDefault();   /* 轮盘模式：阻止浏览器中键自动滚动 */
        joyDX = e.clientX - joyCX;   /* 中心 → 当前鼠标 的偏移向量 */
        joyDY = e.clientY - joyCY;
        updateRockerArrow();   /* 方向变化 → 实时刷新箭头 */
      }
    };
    const onUp = (e: PointerEvent) => {
      endPointerGestures();
      /* 注意：中键轮盘是「点一下进入、按其它键退出」，不随松开中键退出（鼠标不需按住）。
         但松开的是别的鼠标键 —— 说明用户去点了画布外面 —— 这时退出轮盘。 */
      if (isRocker && e.button !== 1) stopRockerLoop();
    };
    /* pointercancel：指针被系统接管（触控手势 / 拖出窗口 / 浏览器抢走）——之后不会再有 pointerup */
    const onCancel = () => {
      endPointerGestures();
      if (isRocker) stopRockerLoop();   /* 发起轮盘的那根指针没了 → 一并退出 */
    };
    const onKeyDown = (e: KeyboardEvent) => {
      /* 轮盘模式下手按任何键（除在输入框内打字）→ 退出轮盘 */
      if (isRocker && !(e.target instanceof HTMLInputElement)) stopRockerLoop();
    };
    const onWheel = (e: WheelEvent) => {
      if (e.altKey) {
        e.preventDefault();
        const rect = stage.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const nz = Math.min(3, Math.max(0.4, assocZoom * (e.deltaY > 0 ? 0.9 : 1.1)));
        assocPanX = mx - (mx - assocPanX) * (nz / assocZoom);
        assocPanY = my - (my - assocPanY) * (nz / assocZoom);
        assocZoom = nz;
        applyWorldTransform();
        return;
      }
      /* 普通滚轮：让**真正的**滚动祖先滚动（画布 stage 是 overflow:hidden，会吞掉滚轮，接管到这里）。
         ⚠️ 原来写死 `stage.closest('.lk-module-view')`，但工具宿主改成一格一工具之后，
         真正在滚的是那格（`.lk-tool-slot`，inspire 给它设了 overflow:auto），
         `#lk-module-view` 自己的 scrollHeight === clientHeight **根本不会滚**
         ⇒ 鼠标停在画布上滚滚轮毫无反应（用户得把鼠标挪到卡片区才能滚）。
         现在沿祖先链找第一个"overflowY 是 auto/scroll **且真的能滚**"的元素。 */
      const scroller = scrollParent(stage);
      if (scroller) scroller.scrollTop += e.deltaY;
    };
    const onClick = (e: MouseEvent) => {
      if (suppressClick) return;   // 拖拽后的 click 抑制
      /* 点击节点 → 展开联想（思维链词自动暂存，无需「存」按钮） */
      const nodeEl = (e.target as HTMLElement).closest('.assoc__node, .assoc__root');
      if (nodeEl && assocGraph) {
        onNodeClick(parseInt((nodeEl as HTMLElement).dataset.id!, 10));
        return;
      }
    };

    stage.addEventListener('pointerdown', onStagePointerDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKeyDown);
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('click', onClick);

    return () => {
      stage.removeEventListener('pointerdown', onStagePointerDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKeyDown);
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('click', onClick);
    };
  }

  /* 更新导出按钮计数 + 绑定导出（Ollama 归类 → saveCharLib） */
  /* 重建导出按钮完整内容（含 #assoc-staged-cnt span），保证计数 span 永远存在 */
  function renderExportBtn() {
    if (!exportBtn) return;
    exportBtn.innerHTML = '导出暂存词（<span id="assoc-staged-cnt">' + staged.length + '</span>）';
  }
  function updateStagedCnt() {
    const cnt = host.querySelector('#assoc-staged-cnt') as HTMLElement | null;
    if (cnt) cnt.textContent = String(staged.length);
    else renderExportBtn();   /* span 被误删时（如临时「分类中…」）重建，避免计数丢失 */
  }
  const exportBtn = host.querySelector('#assoc-export') as HTMLButtonElement | null;
  if (exportBtn) {
    updateStagedCnt();
    exportBtn.addEventListener('click', async () => {
      if (!staged.length) { assocStatus('没有暂存词'); return; }
      assocStatus('正在分类 ' + staged.length + ' 个暂存词…');
      exportBtn.disabled = true;
      exportBtn.textContent = '分类中…';
      try {
        const api = (window as any).lingkuangAPI;
        if (!api?.classifyWords || !api?.saveCharLib || !api?.loadCharLib) { assocStatus('导出不可用（需 Electron 环境）'); throw new Error('no api'); }
        const res = await api.classifyWords(staged);
        const libRes = await api.loadCharLib();
        if (!res?.ok || !libRes?.ok || !libRes.data) { assocStatus('分类/词库加载失败'); throw new Error('fail'); }
        const lib = libRes.data;
        const map = res.map || {};
        /* 刚加载的词库 = 导出查重的真相来源：填满 wordLib（跨全部分类）。
           旧代码 wordLib 从未被填充 → `wordLib.has(w)` 恒 false → 守卫不可达；
           加上下面只做同分类 indexOf 去重，已存在于别的分类的词会被重复写进新分类。 */
        fillWordLib(lib);
        let added = 0, fallback = 0;
        staged.forEach((w) => {
          if (wordLib.has(w)) return;   /* 跨分类查重：任意分类里已有此词 → 不重复写入 */
          const cat = map[w] && lib[map[w]] ? map[w] : '主题意象';
          if (!lib[cat]) lib[cat] = [];
          if (lib[cat].indexOf(w) === -1) { lib[cat].push(w); wordLib.add(w); added++; }
          else if (!map[w]) fallback++;
        });
        if (!added) { assocStatus('暂存词都已在词库中'); }
        else {
          await api.saveCharLib(lib);
          assocStatus(`已写入词库 ${added} 词（回退到「主题意象」${fallback}）`);
        }
        staged = [];
        persistStaged();
        updateStagedCnt();
      } catch (err) {
        assocStatus('导出失败：' + (err instanceof Error ? err.message : String(err)));
      } finally {
        /* 恢复按钮：用 renderExportBtn() 重建含 #assoc-staged-cnt span 的完整内容。
           不能用 textContent 覆盖，否则内嵌 span 被删、计数之后无法更新 */
        exportBtn.disabled = false;
        renderExportBtn();
      }
    });
  }

  /* ── 初始化：建根词 ── */
  function initFromRoot(word: string) {
    const id = 0;
    assocGraph = {
      nodes: [{ id, word, isRoot: true, parent: null, children: [], expanded: false, selected: false, x: 300, y: 250, vx: 0, vy: 0 }],
      edges: [],
      wordIndex: { [word]: id },
    };
    focusedId = 0;
    assocPanX = 0; assocPanY = 0; assocZoom = 1;
    applyWorldTransform();
    renderGraph();
    startSim();
    /* 自动展开第一层 */
    expandNode(0);
  }

  const unbindEvents = bindEvents();

  /* 「回到节点群」按钮：全部节点移出屏幕时点击 → 画布回到节点群 */
  const gotoBtn = host.querySelector('#assoc-goto') as HTMLButtonElement | null;
  if (gotoBtn) {
    gotoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      recenterToNodes();
    });
  }
  /* 外部提供根词时初始化 */
  const root = getWord();
  if (root) initFromRoot(root);

  /* 暴露：可被外部调用重新设根（每次点词条触发） */
  (host as any).assocSetRoot = (w: string) => {
    /* 若已有同词根，聚焦；否则重建 */
    if (assocGraph && assocGraph.nodes[0] && assocGraph.nodes[0].word === w) { onNodeClick(0); return; }
    initFromRoot(w);
  };

  /* 工具栏输入框：回车 → 以输入词开始联想 */
  const input = host.querySelector('#assoc-input') as HTMLInputElement | null;
  if (input) {
    const go = () => {
      const w = input.value.trim();
      if (!w) { assocStatus('请先输入一个词'); return; }
      input.blur();
      assocStatus(`由「${w}」开始联想`);
      (host as any).assocSetRoot(w);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
      e.stopPropagation();   /* 防止画布中键/其它按键干扰输入 */
    });
  }

  /* ── 卸载清理：工具切走时由 registry 调用（inspire.ts 把本函数一路往上传）。
     不返这个函数，window 监听与 simRAF/rockerRAF 就会每点一次工具积一份、且永不退场。 */
  return () => {
    unbindEvents();          /* 摘掉 3 个 window 监听 + stage 上的按下/滚轮/点击 */
    stopSim();               /* 停力导向帧循环 */
    stopRockerLoop();        /* 停轮盘帧循环（内部会 cancelAnimationFrame） */
    stopAutoPan();           /* 停贴边推视窗的帧循环 */
    if (suppressClickTimer !== null) { clearTimeout(suppressClickTimer); suppressClickTimer = null; }
    delete (host as any).assocSetRoot;   /* 摘掉暴露给外部的入口，避免指向已销毁画布 */
  };
}
