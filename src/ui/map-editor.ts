/** 手绘海陆剪影编辑器（第一百零八轮）。
 *
 *  用户原话：「再做一个简易的编辑器，能让用户自行绘制大陆和地形，并在此之上生成对应地形」。
 *  拍板口径：**独立的全屏海陆画板** —— 先刷海陆剪影（可擦改 / 可导入导出），
 *  再回去按这幅剪影生成星球（不是"在现有画笔上加两支"）。
 *
 *  实现要点（都是刻意的取舍）：
 *    · 剪影是 **160×80 的小掩膜**（2 bit/格），画板把它放大 6 倍显示 —— 手画的是"大陆在哪"，
 *      海岸的细节交给生成器（它本来就有海岸噪声）；掩膜越小，存进数据文件越省（约 4.3KB 文本）。
 *    · 生成走**同一条落盘路**：`generateIntoMap()`（`src/ui/map-gen.ts`），一次 `store.update`
 *      ⇒ 一步 Ctrl+Z 能撤。
 *    · 星球生成里剪影**优先于**噪声：画过的地方直接钉死海陆（见 `src/mapgen/planet.ts` 的
 *      `forced[]`）⇒ 没画的地方照旧随机，只在东半球画一块也成立。
 *    · 导出/导入是 PNG：导出的图就是画板本身；导入时按颜色分类（绿 = 陆地、蓝 = 海洋、
 *      透明/其它 = 没画）⇒ 可以用别的画图软件先画好再贴回来。
 *
 *  ⚠️ 界面不用 emoji、不用黄色系文字（AGENTS.md），颜色只用 tokens.css 的变量。 */

import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import type { MapMask } from '../store/types';
import { nextFrame, showBusy } from './busy';
import { closeLightbox, isLightboxOpen } from './lightbox';
import { generateIntoMap } from './map-gen';

/** 掩膜分辨率（与 `MapTerrainSpec.mask` 一致）*/
export const MASK_W = 160;
export const MASK_H = 80;
const CELL = 6;                       /* 画板上每格 6px ⇒ 960×480 */
const MAX_UNDO = 30;

type Tool = 'land' | 'sea' | 'erase';

let openEl: HTMLElement | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let hostStore: Store | null = null;

/* 画板状态（模块级：关掉再开，画到一半的剪影还在 —— 与抽卡同一个体验） */
let mask: Uint8Array = new Uint8Array(MASK_W * MASK_H);
let undoStack: Uint8Array[] = [];
let tool: Tool = 'land';
let brush = 4;

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

function decodeMask(src: MapMask | undefined): Uint8Array {
  const out = new Uint8Array(MASK_W * MASK_H);
  if (!src || !src.bits) return out;
  let bin = '';
  try { bin = atob(src.bits); } catch { return out; }
  for (let i = 0; i < out.length; i++) {
    const bit = i * 2;
    const byte = bin.charCodeAt(bit >> 3) & 0xff;
    out[i] = (byte >> (bit & 7)) & 3;
  }
  return out;
}

export function clearEditorMask(): void {
  mask = new Uint8Array(MASK_W * MASK_H);
  undoStack = [];
}

/* ── 打开画板 ─────────────────────────────────────────────────────────────── */

/** `seed` / `style` / `spec` / `view` 不给就沿用这张地图现在的（"在现有星球上改海陆"）。 */
export function openMapEditor(store: Store, opts?: { mask?: MapMask }): void {
  if (isLightboxOpen()) closeLightbox();
  closeMapEditor();
  hostStore = store;
  const m = currentWorld(store).maps?.[0];
  const startMask = opts?.mask ?? m?.terrain?.mask;
  mask = decodeMask(startMask);
  undoStack = [];

  const el = document.createElement('div');
  el.className = 'lk-ed';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', '手绘海陆');
  el.innerHTML = `
    <div class="lk-ed__bar">
      <span class="lk-ed__title">手绘海陆</span>
      <span class="lk-ed__hint" id="ed-hint">涂绿 = 陆地，涂蓝 = 海洋；不涂的地方交给生成器。</span>
      <span class="lk-ed__spacer"></span>
      <span class="lk-ed__group">
        <button class="lk-ed__tool is-on" data-tool="land" title="涂成陆地">陆地</button>
        <button class="lk-ed__tool" data-tool="sea" title="涂成海洋">海洋</button>
        <button class="lk-ed__tool" data-tool="erase" title="擦回：没画的地方交给生成器">橡皮</button>
      </span>
      <span class="lk-ed__group">
        <button class="lk-ed__size" data-size="2" title="细">细</button>
        <button class="lk-ed__size is-on" data-size="4" title="中">中</button>
        <button class="lk-ed__size" data-size="8" title="粗">粗</button>
        <button class="lk-ed__size" data-size="14" title="很粗">很粗</button>
      </span>
      <span class="lk-ed__group">
        <button class="lk-ed__btn" id="ed-undo" title="撤销上一笔">撤销</button>
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
    <div class="lk-ed__stage">
      <canvas id="ed-canvas" width="${MASK_W * CELL}" height="${MASK_H * CELL}"></canvas>
    </div>
    <div class="lk-ed__foot">
      <span id="ed-stat"></span>
      <span id="ed-note"></span>
      <input type="file" id="ed-file" accept="image/*" style="display:none;">
    </div>`;
  document.body.appendChild(el);
  openEl = el;

  const q = <T extends HTMLElement>(sel: string) => el.querySelector(sel) as T;
  const canvas = q<HTMLCanvasElement>('#ed-canvas');
  const ctx = canvas.getContext('2d');
  const statEl = q<HTMLElement>('#ed-stat');
  const noteEl = q<HTMLElement>('#ed-note');
  const fileEl = q<HTMLInputElement>('#ed-file');

  /** 掩膜 → 屏幕：先把 160×80 画到一张小画布，再关掉平滑放大（不然边缘糊成一片）*/
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
  const paint = () => {
    if (!ctx) return;
    paintBuf();
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(buf, 0, 0, canvas.width, canvas.height);
    let land = 0, sea = 0;
    for (let i = 0; i < mask.length; i++) { if (mask[i] === 1) land++; else if (mask[i] === 2) sea++; }
    const pct = (v: number) => Math.round((v / mask.length) * 100);
    statEl.textContent = `陆地 ${pct(land)}% · 海洋 ${pct(sea)}% · 留白 ${100 - pct(land) - pct(sea)}%`;
  };

  let drawing = false;
  let last: { x: number; y: number } | null = null;
  const cellAt = (e: PointerEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.floor(((e.clientX - r.left) / (r.width || 1)) * MASK_W),
      y: Math.floor(((e.clientY - r.top) / (r.height || 1)) * MASK_H),
    };
  };
  const stamp = (cx: number, cy: number) => {
    const val = tool === 'land' ? 1 : tool === 'sea' ? 2 : 0;
    const r = brush;
    for (let y = cy - r; y <= cy + r; y++) {
      if (y < 0 || y >= MASK_H) continue;
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || x >= MASK_W) continue;
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > r * r) continue;
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
  const begin = (e: PointerEvent) => {
    if (e.button !== 0) return;
    undoStack.push(mask.slice());
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    drawing = true;
    last = cellAt(e);
    stamp(last.x, last.y);
    paint();
    canvas.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  canvas.addEventListener('pointerdown', begin);
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing || !last) return;
    const p = cellAt(e);
    line(last, p);
    last = p;
    paint();
  });
  const end = (e: PointerEvent) => {
    drawing = false;
    last = null;
    try { canvas.releasePointerCapture?.(e.pointerId); } catch { /* 已释放 */ }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  const syncTools = () => {
    el.querySelectorAll('[data-tool]').forEach((b) => (b as HTMLElement).classList.toggle('is-on', (b as HTMLElement).dataset.tool === tool));
    el.querySelectorAll('[data-size]').forEach((b) => (b as HTMLElement).classList.toggle('is-on', Number((b as HTMLElement).dataset.size) === brush));
  };
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const toolBtn = t.closest('[data-tool]') as HTMLElement | null;
    if (toolBtn?.dataset.tool) { tool = toolBtn.dataset.tool as Tool; syncTools(); return; }
    const sizeBtn = t.closest('[data-size]') as HTMLElement | null;
    if (sizeBtn?.dataset.size) { brush = Number(sizeBtn.dataset.size); syncTools(); return; }
    if (t.closest('#ed-close')) { closeMapEditor(); return; }
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
    const a = document.createElement('a');
    a.download = '海陆剪影.png';
    a.href = buf.toDataURL('image/png');
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

  keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMapEditor(); };
  window.addEventListener('keydown', keyHandler);
  syncTools();
  paint();
  noteEl.textContent = '生成的星球会按这幅剪影钉死海陆；画完按「按这幅生成」。默认「留白 = 海洋」——想只钉死一块大陆就取消勾选。';
}

export function closeMapEditor(): void {
  if (!openEl) return;
  if (keyHandler) { window.removeEventListener('keydown', keyHandler); keyHandler = null; }
  openEl.remove();
  openEl = null;
  hostStore = null;
}
