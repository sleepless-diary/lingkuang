/** 手绘海陆剪影编辑器（第一百零八轮；第一百零九轮大改）。
 *
 *  用户原话（第一百零八轮）：「再做一个简易的编辑器，能让用户自行绘制大陆和地形，并在此之上生成对应地形」。
 *  第一百零九轮反馈（原话）：「地形工具加入手绘面板吧，这个手绘面板精细度不够，而且不能放大或者拖动，
 *  笔刷大小用滑块调整吧……手绘地形里面的橡皮定位不清晰，海洋不就是橡皮的功能吗」。
 *
 *  因此这一版：
 *    · **更细的剪影**：掩膜 160×80 → **320×160**（2 bit/格，base64 约 17KB）。手画的是"大陆在哪"，
 *      海岸细节仍交给生成器的海岸噪声；但 320 宽已经能画出海湾、半岛与湖。
 *    · **能放大/拖动**：滚轮以指针为锚缩放 1×~8×；中键拖动 / 按住空格 + 左键拖动平移；
 *      「适应」一键回到整幅。屏幕上画的是插值前的方块（`imageSmoothingEnabled = false`），
 *      放大后能一格一格地补。
 *    · **笔刷用滑块**：`input[type=range]` 1~20 格，旁边实时显示格数。
 *    · **只有陆地和海洋**：橡皮撤了 —— 「海洋」本来就是"擦掉陆地"（用户原话「海洋不就是橡皮的功能吗」）。
 *      `留白 = 海洋` 勾上时整幅剪影就是世界；不勾则留白交给生成器随机。
 *    · **笔刷定位**：跟随指针的圆环（半径 = 笔刷格数 × 当前格宽），画的时候不会"点歪"。
 *
 *  生成仍走**同一条落盘路** `generateIntoMap()`（`src/ui/map-gen.ts`）⇒ 一步 Ctrl+Z 能撤。
 *  星球生成里剪影**优先于**噪声（见 `src/mapgen/planet.ts` 的 `forced[]`）。
 *
 *  ⚠️ 界面不用 emoji、不用黄色系文字（AGENTS.md），颜色只用 tokens.css 的变量。 */

import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import type { MapMask } from '../store/types';
import { nextFrame, showBusy } from './busy';
import { closeLightbox, isLightboxOpen } from './lightbox';
import { generateIntoMap } from './map-gen';

/** 掩膜分辨率（与 `MapTerrainSpec.mask` 一致）*/
export const MASK_W = 320;
export const MASK_H = 160;
/** 1:1 时每格占多少屏幕像素 ⇒ 整幅 960×480 */
const CELL = 3;
const MAX_UNDO = 40;
const ZOOM_MIN = 1;
const ZOOM_MAX = 8;

type Tool = 'land' | 'sea';

let openEl: HTMLElement | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let keyUpHandler: ((e: KeyboardEvent) => void) | null = null;
let hostStore: Store | null = null;

/* 画板状态（模块级：关掉再开，画到一半的剪影还在 —— 与抽卡同一个体验） */
let mask: Uint8Array = new Uint8Array(MASK_W * MASK_H);
let undoStack: Uint8Array[] = [];
let tool: Tool = 'land';
let brushCells = 4;
let zoom = 1;
let panX = 0;
let panY = 0;

export function isMapEditorOpen(): boolean {
  return !!openEl && document.body.contains(openEl);
}

/* ── 掩膜编解码（2 bit/格，低位在前）────────────────────────────────────────── */

function encodeMask(m: Uint8Array): MapMask {
  const bytes = new Uint8Array(Math.ceil(MASK_W * MASK_H * 2 / 8));
  for (let i = 0; i < MASK_W * MASK_H; i++) {
    const bit = i * 2;
    bytes[bit >> 3] |= (m[i] & 3) << (bit & 7);
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return { w: MASK_W, h: MASK_H, bits: btoa(bin) };
}

/** 读剪影。⚠️ 老数据是 160×80（第一百零八轮）⇒ 按**源分辨率**读，再最近邻放大到 320×160。 */
function decodeMask(src: MapMask | undefined): Uint8Array {
  const out = new Uint8Array(MASK_W * MASK_H);
  if (!src || !src.bits || !src.w || !src.h) return out;
  let bin = '';
  try { bin = atob(src.bits); } catch { return out; }
  const sw = src.w;
  const sh = src.h;
  for (let y = 0; y < MASK_H; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / MASK_H));
    for (let x = 0; x < MASK_W; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / MASK_W));
      const i = sy * sw + sx;
      const bit = i * 2;
      const byte = bin.charCodeAt(bit >> 3) & 0xff;
      out[y * MASK_W + x] = (byte >> (bit & 7)) & 3;
    }
  }
  return out;
}

export function clearEditorMask(): void {
  mask = new Uint8Array(MASK_W * MASK_H);
  undoStack = [];
}

/* ── 打开画板 ─────────────────────────────────────────────────────────────── */

/** `mask` 不给就沿用这张地图现在的那幅剪影（"在现有剪影上接着改"）。 */
export function openMapEditor(store: Store, opts?: { mask?: MapMask }): void {
  if (isLightboxOpen()) closeLightbox();
  closeMapEditor();
  hostStore = store;
  const m = currentWorld(store).maps?.[0];
  const startMask = opts?.mask ?? m?.terrain?.mask;
  mask = decodeMask(startMask);
  undoStack = [];
  zoom = 1;
  panX = 0;
  panY = 0;

  const el = document.createElement('div');
  el.className = 'lk-ed';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', '手绘海陆');
  el.innerHTML = `
    <div class="lk-ed__bar">
      <span class="lk-ed__title">手绘海陆</span>
      <span class="lk-ed__hint" id="ed-hint">滚轮缩放 · 中键 / 空格+左键拖动 · 左键绘制</span>
      <span class="lk-ed__spacer"></span>
      <span class="lk-ed__group">
        <button class="lk-ed__tool is-on" data-tool="land" title="涂成陆地">陆地</button>
        <button class="lk-ed__tool" data-tool="sea" title="涂成海洋（也就是把陆地擦掉）">海洋</button>
      </span>
      <label class="lk-ed__slider" title="笔刷大小（单位：剪影格）">
        <span>笔刷</span>
        <input type="range" id="ed-brush" min="1" max="20" step="1" value="4">
        <span class="lk-ed__val" id="ed-brush-n">4</span>
      </label>
      <span class="lk-ed__group">
        <button class="lk-ed__btn" id="ed-zoom-out" title="缩小">−</button>
        <button class="lk-ed__btn" id="ed-zoom-fit" title="适应窗口（1×）">适应</button>
        <button class="lk-ed__btn" id="ed-zoom-in" title="放大">＋</button>
        <span class="lk-ed__val" id="ed-zoom">100%</span>
      </span>
      <span class="lk-ed__group">
        <button class="lk-ed__btn" id="ed-undo" title="撤销上一笔（Ctrl+Z）">撤销</button>
        <button class="lk-ed__btn" id="ed-clear" title="清空整幅剪影">清空</button>
        <button class="lk-ed__btn" id="ed-import" title="从 PNG 导入（绿 = 陆地、蓝 = 海洋）">导入</button>
        <button class="lk-ed__btn" id="ed-export" title="导出这幅剪影为 PNG">导出</button>
      </span>
      <label class="lk-ed__check" title="勾上：没画的地方一律算海洋（剪影就是整个世界）；不勾：没画的地方交给生成器随机">
        <input type="checkbox" id="ed-blank-sea" checked> 留白 = 海洋
      </label>
      <button class="lk-ed__btn is-primary" id="ed-go" title="按这幅剪影生成星球（当前地图的种子与档位）">按这幅生成</button>
      <button class="lk-ed__close" id="ed-close" title="关掉（Esc）">×</button>
    </div>
    <div class="lk-ed__stage" id="ed-stage">
      <canvas id="ed-canvas"></canvas>
      <canvas id="ed-cursor"></canvas>
    </div>
    <div class="lk-ed__foot">
      <span id="ed-stat"></span>
      <span id="ed-note"></span>
      <input type="file" id="ed-file" accept="image/*" style="display:none;">
    </div>`;
  document.body.appendChild(el);
  openEl = el;

  const q = <T extends HTMLElement>(sel: string) => el.querySelector(sel) as T;
  const stage = q<HTMLElement>('#ed-stage');
  const canvas = q<HTMLCanvasElement>('#ed-canvas');
  const cursorCanvas = q<HTMLCanvasElement>('#ed-cursor');
  const ctx = canvas.getContext('2d');
  const cctx = cursorCanvas.getContext('2d');
  const statEl = q<HTMLElement>('#ed-stat');
  const noteEl = q<HTMLElement>('#ed-note');
  const fileEl = q<HTMLInputElement>('#ed-file');
  const zoomEl = q<HTMLElement>('#ed-zoom');
  const brushEl = q<HTMLInputElement>('#ed-brush');
  const brushNEl = q<HTMLElement>('#ed-brush-n');

  /** 掩膜 → 一张 320×160 的小画布（贴图源）。每格格子颜色：陆地绿 / 海洋蓝 / 留白灰。 */
  const buf = document.createElement('canvas');
  buf.width = MASK_W;
  buf.height = MASK_H;
  const bctx = buf.getContext('2d');
  const paintBuf = () => {
    if (!bctx) return;
    const img = bctx.createImageData(MASK_W, MASK_H);
    for (let i = 0; i < mask.length; i++) {
      const v = mask[i];
      const o = i * 4;
      if (v === 1) { img.data[o] = 123; img.data[o + 1] = 149; img.data[o + 2] = 87; img.data[o + 3] = 255; }
      else if (v === 2) { img.data[o] = 47; img.data[o + 1] = 111; img.data[o + 2] = 142; img.data[o + 3] = 255; }
      else { img.data[o] = 201; img.data[o + 1] = 198; img.data[o + 2] = 189; img.data[o + 3] = 255; }
    }
    bctx.putImageData(img, 0, 0);
  };

  /** 视口尺寸（CSS px）；画布按它开，缩放/平移都在这里换算 */
  let vw = 960;
  let vh = 480;

  const baseScale = () => Math.min(vw / (MASK_W * CELL), vh / (MASK_H * CELL)) || 1;
  const cellPx = () => CELL * baseScale() * zoom;
  const contentW = () => MASK_W * cellPx();
  const contentH = () => MASK_H * cellPx();

  /** 内容比视口小时居中；比视口大时不许拖出边界（拖到边上刚好贴边）*/
  function clampPan() {
    const cw = contentW();
    const ch = contentH();
    panX = cw <= vw ? (vw - cw) / 2 : Math.min(0, Math.max(vw - cw, panX));
    panY = ch <= vh ? (vh - ch) / 2 : Math.min(0, Math.max(vh - ch, panY));
  }

  function paint() {
    if (!ctx) return;
    paintBuf();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(buf, 0, 0, MASK_W, MASK_H, panX, panY, contentW(), contentH());
    /* 放大到一格 ≥ 7px 时画淡淡的网格 —— 方便一格一格地补细节 */
    const cp = cellPx();
    if (cp >= 7) {
      ctx.strokeStyle = 'rgba(0,0,0,.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= MASK_W; x++) {
        const px = Math.round(panX + x * cp) + 0.5;
        ctx.moveTo(px, panY);
        ctx.lineTo(px, panY + contentH());
      }
      for (let y = 0; y <= MASK_H; y++) {
        const py = Math.round(panY + y * cp) + 0.5;
        ctx.moveTo(panX, py);
        ctx.lineTo(panX + contentW(), py);
      }
      ctx.stroke();
    }
    let land = 0, sea = 0;
    for (let i = 0; i < mask.length; i++) { if (mask[i] === 1) land++; else if (mask[i] === 2) sea++; }
    const pct = (v: number) => Math.round((v / mask.length) * 100);
    statEl.textContent = `陆地 ${pct(land)}% · 海洋 ${pct(sea)}% · 留白 ${100 - pct(land) - pct(sea)}%`;
    zoomEl.textContent = Math.round(zoom * 100) + '%';
  }

  /** 笔刷圆环：跟随指针（半径 = 笔刷格数 × 当前格宽）*/
  let ringX = -1;
  let ringY = -1;
  function drawRing() {
    if (!cctx) return;
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.clearRect(0, 0, vw, vh);
    if (ringX < 0) return;
    const r = Math.max(2, (brushCells - 0.5) * cellPx());
    cctx.beginPath();
    cctx.arc(ringX, ringY, r, 0, Math.PI * 2);
    cctx.strokeStyle = 'rgba(0,0,0,.55)';
    cctx.lineWidth = 3;
    cctx.stroke();
    cctx.beginPath();
    cctx.arc(ringX, ringY, r, 0, Math.PI * 2);
    cctx.strokeStyle = 'rgba(255,255,255,.85)';
    cctx.lineWidth = 1;
    cctx.stroke();
    cctx.beginPath();
    cctx.arc(ringX, ringY, 1.2, 0, Math.PI * 2);
    cctx.fillStyle = 'rgba(255,255,255,.9)';
    cctx.fill();
  }

  function resize() {
    const r = stage.getBoundingClientRect();
    vw = Math.max(120, Math.round(r.width));
    vh = Math.max(80, Math.round(r.height));
    canvas.width = vw;
    canvas.height = vh;
    cursorCanvas.width = vw;
    cursorCanvas.height = vh;
    clampPan();
    paint();
    drawRing();
  }

  /* ── 指针 → 掩膜格 ─────────────────────────────────────────────────────── */
  const cellAt = (clientX: number, clientY: number): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    /* backing store 可能比 CSS 尺寸大/小（窗口刚开、resize 还没跑完）⇒ 先按比例换到画布坐标 */
    const k = r.width ? vw / r.width : 1;
    const cp = contentW() / MASK_W;
    return {
      x: Math.floor(((clientX - r.left) * k - panX) / cp),
      y: Math.floor(((clientY - r.top) * k - panY) / cp),
    };
  };

  const stamp = (cx: number, cy: number) => {
    const val = tool === 'land' ? 1 : 2;
    const r = Math.max(0, brushCells - 1);
    for (let y = cy - r; y <= cy + r; y++) {
      if (y < 0 || y >= MASK_H) continue;
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || x >= MASK_W) continue;
        const dx = x - cx, dy = y - cy;
        if (r > 0 && dx * dx + dy * dy > r * r + r * 0.6) continue;
        mask[y * MASK_W + x] = val;
      }
    }
  };
  const line = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    for (let i = 0; i <= steps; i++) {
      const t = steps ? i / steps : 0;
      stamp(Math.round(a.x + (b.x - a.x) * t), Math.round(a.y + (b.y - a.y) * t));
    }
  };

  let drawing = false;
  let panning = false;
  let last: { x: number; y: number } | null = null;
  let panStart = { x: 0, y: 0, px: 0, py: 0 };
  let spaceDown = false;

  const setCursorGrab = (on: boolean) => { canvas.style.cursor = on ? 'grab' : 'crosshair'; };

  canvas.addEventListener('pointerdown', (e) => {
    /* 中键 / 空格 + 左键 = 平移（不吃绘制）*/
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      panning = true;
      panStart = { x: e.clientX, y: e.clientY, px: panX, py: panY };
      setCursorGrab(true);
      try { canvas.setPointerCapture?.(e.pointerId); } catch { /* 合成事件没有活动指针 */ }
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    undoStack.push(mask.slice());
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    drawing = true;
    last = cellAt(e.clientX, e.clientY);
    stamp(last.x, last.y);
    paint();
    try { canvas.setPointerCapture?.(e.pointerId); } catch { /* 合成事件没有活动指针 */ }
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const k = r.width ? vw / r.width : 1;
    ringX = (e.clientX - r.left) * k;
    ringY = (e.clientY - r.top) * k;
    if (panning) {
      panX = panStart.px + (e.clientX - panStart.x);
      panY = panStart.py + (e.clientY - panStart.y);
      clampPan();
      paint();
      drawRing();
      return;
    }
    if (drawing && last) {
      const p = cellAt(e.clientX, e.clientY);
      line(last, p);
      last = p;
      paint();
    }
    drawRing();
  });

  const endStroke = (e: PointerEvent) => {
    drawing = false;
    panning = false;
    last = null;
    setCursorGrab(false);
    try { canvas.releasePointerCapture?.(e.pointerId); } catch { /* 已释放 */ }
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', () => { ringX = -1; ringY = -1; drawRing(); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  /* 滚轮：以指针为锚缩放（缩放的目的是"凑近补细节"，所以锚点必须跟着光标走）*/
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const s0 = CELL * baseScale();
    const mx = (sx - panX) / (s0 * zoom);
    const my = (sy - panY) / (s0 * zoom);
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * Math.exp(-e.deltaY * 0.0016)));
    zoom = Math.round(next * 100) / 100;
    panX = sx - mx * s0 * zoom;
    panY = sy - my * s0 * zoom;
    clampPan();
    paint();
    drawRing();
  }, { passive: false });

  const setZoom = (z: number) => {
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
    clampPan();
    paint();
  };

  const syncTools = () => {
    el.querySelectorAll('[data-tool]').forEach((b) => (b as HTMLElement).classList.toggle('is-on', (b as HTMLElement).dataset.tool === tool));
    brushEl.value = String(brushCells);
    brushNEl.textContent = String(brushCells);
  };

  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const toolBtn = t.closest('[data-tool]') as HTMLElement | null;
    if (toolBtn?.dataset.tool) { tool = toolBtn.dataset.tool as Tool; syncTools(); return; }
    if (t.closest('#ed-close')) { closeMapEditor(); return; }
    if (t.closest('#ed-zoom-in')) { setZoom(zoom * 1.5); return; }
    if (t.closest('#ed-zoom-out')) { setZoom(zoom / 1.5); return; }
    if (t.closest('#ed-zoom-fit')) { zoom = 1; clampPan(); paint(); return; }
    if (t.closest('#ed-undo')) {
      const prev = undoStack.pop();
      if (prev) { mask = prev; paint(); }
      return;
    }
    if (t.closest('#ed-clear')) {
      undoStack.push(mask.slice());
      mask = new Uint8Array(MASK_W * MASK_H);
      paint();
      return;
    }
    if (t.closest('#ed-import')) { fileEl.click(); return; }
    if (t.closest('#ed-export')) { exportPng(); return; }
    if (t.closest('#ed-go')) { void applyPatch(); return; }
  });

  brushEl.addEventListener('input', () => {
    brushCells = Math.max(1, Math.min(20, Number(brushEl.value) || 1));
    brushNEl.textContent = String(brushCells);
    drawRing();
  });

  fileEl.addEventListener('change', () => {
    const f = fileEl.files?.[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    const im = new Image();
    im.onload = () => {
      const tmp = document.createElement('canvas');
      tmp.width = MASK_W;
      tmp.height = MASK_H;
      const tctx = tmp.getContext('2d');
      if (!tctx) { URL.revokeObjectURL(url); return; }
      tctx.drawImage(im, 0, 0, MASK_W, MASK_H);
      const data = tctx.getImageData(0, 0, MASK_W, MASK_H).data;
      undoStack.push(mask.slice());
      for (let i = 0; i < mask.length; i++) {
        const o = i * 4;
        const a = data[o + 3], g = data[o + 1], b = data[o + 2];
        mask[i] = a < 32 ? 0 : (g > b + 10 ? 1 : (b > g + 10 ? 2 : 0));
      }
      paint();
      noteEl.textContent = `已导入「${f.name}」（绿 = 陆地、蓝 = 海洋、其它 = 留白）`;
      URL.revokeObjectURL(url);
    };
    im.onerror = () => { noteEl.textContent = '这张图读不出来，换一张 PNG 试试'; URL.revokeObjectURL(url); };
    im.src = url;
    fileEl.value = '';
  });

  const exportPng = () => {
    paintBuf();
    /* 导出放大 4 倍（1280×640）：拿出去在别的画图软件里看得清；导回来会按颜色还原 */
    const out = document.createElement('canvas');
    out.width = MASK_W * 4;
    out.height = MASK_H * 4;
    const octx = out.getContext('2d');
    if (octx) {
      octx.imageSmoothingEnabled = false;
      octx.drawImage(buf, 0, 0, out.width, out.height);
    }
    const a = document.createElement('a');
    a.download = '海陆剪影.png';
    a.href = out.toDataURL('image/png');
    a.click();
    noteEl.textContent = '已导出 PNG（再导入回来会按颜色还原）';
  };

  const applyPatch = async () => {
    const st = hostStore;
    if (!st) return;
    const mm = currentWorld(st).maps?.[0];
    const t = mm?.terrain;
    const b = showBusy(el, '正在按剪影生成…', { sub: '星球 · 剪影优先于噪声' });
    await nextFrame();
    try {
      /* ⭐ 「留白 = 海洋」（缺省勾上）：剪影是"整个世界"的海陆 —— 没画的地方算海。
         不勾的话留白交给生成器随机（适合"我只想钉死东半球那块大陆"）。 */
      const blankSea = (el.querySelector('#ed-blank-sea') as HTMLInputElement | null)?.checked ?? true;
      const out = blankSea ? mask.slice() : mask;
      if (blankSea) for (let i = 0; i < out.length; i++) if (out[i] === 0) out[i] = 2;
      const r = generateIntoMap(st, {
        seed: t?.seed ? String(t.seed) : '灵框',
        style: t?.style ? String(t.style) : 'continent',
        spec: (t?.spec ?? {}) as { [k: string]: number | undefined },
        view: t?.view,
        form: 'planet',
        mask: encodeMask(out),
      });
      b.done();
      noteEl.textContent = r.note;
      window.setTimeout(() => closeMapEditor(), 1200);
    } catch (e) {
      b.done();
      noteEl.textContent = '生成失败：' + (e instanceof Error ? e.message : String(e));
    }
  };

  keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { closeMapEditor(); return; }
    if (e.code === 'Space' || e.key === ' ') { spaceDown = true; setCursorGrab(true); e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      const prev = undoStack.pop();
      if (prev) { mask = prev; paint(); }
      return;
    }
    if (e.key === '[') { brushEl.value = String(Math.max(1, brushCells - 1)); brushEl.dispatchEvent(new Event('input')); }
    if (e.key === ']') { brushEl.value = String(Math.min(20, brushCells + 1)); brushEl.dispatchEvent(new Event('input')); }
  };
  keyUpHandler = (e: KeyboardEvent) => { if (e.code === 'Space' || e.key === ' ') { spaceDown = false; setCursorGrab(false); } };
  window.addEventListener('keydown', keyHandler);
  window.addEventListener('keyup', keyUpHandler);

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(stage);
  (el as HTMLElement & { _ro?: ResizeObserver | null })._ro = ro;

  syncTools();
  resize();
  window.requestAnimationFrame(() => resize());
  window.setTimeout(() => resize(), 120);
  noteEl.textContent = '生成的星球会按这幅剪影钉死海陆；画完按「按这幅生成」。滚轮缩放、中键或空格拖动 —— 放大后能一格一格补细节。';
}

export function closeMapEditor(): void {
  if (!openEl) return;
  if (keyHandler) { window.removeEventListener('keydown', keyHandler); keyHandler = null; }
  if (keyUpHandler) { window.removeEventListener('keyup', keyUpHandler); keyUpHandler = null; }
  const ro = (openEl as HTMLElement & { _ro?: ResizeObserver | null })._ro;
  ro?.disconnect();
  openEl.remove();
  openEl = null;
  hostStore = null;
}
