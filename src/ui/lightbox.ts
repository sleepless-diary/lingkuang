/** 大图查看器（第一百零六轮）。
 *
 *  用户原话：「点击大图时全窗口显示大图，再点一下返回（方便看细节），双击放大，
 *  滚轮调整大小，拖动调整位置」。
 *
 *  用法：`openLightbox({ src, title, hint })`。`src` 就是 dataURL / 图片地址。
 *  交互（全部在遮罩自己身上，不碰调用方的 DOM）：
 *    · 点一下（没有拖动）→ 关掉；
 *    · 双击 → 在指针处放大 / 缩回适应窗口；
 *    · 滚轮 → 以指针为锚缩放（0.4×适应 … 12×）；
 *    · 按住拖动 → 平移；
 *    · Esc 关，+/- 缩放，0 回适应窗口。
 *
 *  ⚠️ 单键"点一下返回"与双击放大要共存：鼠标抬起后**延迟 240ms** 才关，
 *  双击在窗口期内到达就把这次关闭取消 —— 否则双击的第一下就把图关掉了。 */

export interface LightboxItem {
  src: string;
  title?: string;
  hint?: string;
}

interface View {
  scale: number;
  tx: number;
  ty: number;
}

let root: HTMLElement | null = null;
let img: HTMLImageElement | null = null;
let zoomEl: HTMLElement | null = null;
let closeTimer: number | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 12;

export function isLightboxOpen(): boolean {
  return root !== null;
}

export function closeLightbox(): void {
  if (closeTimer !== null) { window.clearTimeout(closeTimer); closeTimer = null; }
  if (keyHandler) { window.removeEventListener('keydown', keyHandler); keyHandler = null; }
  root?.remove();
  root = null;
  img = null;
  zoomEl = null;
}

export function openLightbox(item: LightboxItem): void {
  closeLightbox();
  if (!item?.src) return;

  const el = document.createElement('div');
  el.className = 'lk-lb';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML = `
    <div class="lk-lb__bar">
      <span class="lk-lb__title"></span>
      <span class="lk-lb__zoom">100%</span>
      <span class="lk-lb__hint">点一下返回 · 双击放大 · 滚轮缩放 · 拖动平移</span>
      <button class="lk-lb__close" type="button" title="返回（Esc）">×</button>
    </div>
    <img class="lk-lb__img" alt="" draggable="false">
    <div class="lk-lb__tip">点击图片任意处返回</div>`;
  root = el;
  img = el.querySelector('.lk-lb__img') as HTMLImageElement;
  zoomEl = el.querySelector('.lk-lb__zoom') as HTMLElement;
  const titleEl = el.querySelector('.lk-lb__title') as HTMLElement;
  const hintEl = el.querySelector('.lk-lb__hint') as HTMLElement;
  titleEl.textContent = item.title ?? '';
  titleEl.hidden = !item.title;
  if (item.hint) hintEl.textContent = item.hint;

  const state: View = { scale: 1, tx: 0, ty: 0 };
  let fit = 1;

  const apply = () => {
    if (!img) return;
    img.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
    if (zoomEl) zoomEl.textContent = Math.round((state.scale / fit) * 100) + '%';
  };
  const centerFit = () => {
    if (!img) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const nw = img.naturalWidth || 1, nh = img.naturalHeight || 1;
    /* 适应窗口：不放大超过 1:1（小图放大只会糊），大图缩到放得下 */
    fit = Math.min(vw / nw, vh / nh, 1);
    state.scale = fit;
    state.tx = (vw - nw * fit) / 2;
    state.ty = (vh - nh * fit) / 2;
    apply();
  };

  /** 以视口坐标 (cx, cy) 为锚缩放到 next（锚点下的像素保持不动） */
  const zoomAt = (next: number, cx: number, cy: number) => {
    const s = Math.max(fit * MIN_ZOOM, Math.min(fit * MAX_ZOOM, next));
    const k = s / state.scale;
    state.tx = cx - (cx - state.tx) * k;
    state.ty = cy - (cy - state.ty) * k;
    state.scale = s;
    apply();
  };

  let dragging = false;
  let moved = false;
  let px = 0, py = 0, ptx = 0, pty = 0;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    /* 工具栏上的按钮不启动拖动（否则点关闭会变成拖图） */
    if ((e.target as HTMLElement)?.closest('.lk-lb__bar')) return;
    dragging = true;
    moved = false;
    px = e.clientX; py = e.clientY;
    ptx = state.tx; pty = state.ty;
    el.setPointerCapture?.(e.pointerId);
    el.classList.add('is-grab');
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - px, dy = e.clientY - py;
    if (!moved && Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    state.tx = ptx + dx;
    state.ty = pty + dy;
    apply();
  });
  const endDrag = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('is-grab');
    try { el.releasePointerCapture?.(e.pointerId); } catch { /* 指针已释放 */ }
  };
  el.addEventListener('pointerup', (e) => {
    const wasDrag = moved;
    endDrag(e);
    if (wasDrag) return;
    /* 点一下（或点按钮）→ 延迟关：窗口期内来了双击就取消这次关闭 */
    if ((e.target as HTMLElement)?.closest('.lk-lb__close')) { closeLightbox(); return; }
    if (closeTimer !== null) window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => { closeTimer = null; closeLightbox(); }, 240);
  });
  el.addEventListener('pointercancel', endDrag);

  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (closeTimer !== null) { window.clearTimeout(closeTimer); closeTimer = null; }
    /* 已经放大过就缩回适应窗口，否则在指针处放到 2.5×（"方便看细节"） */
    if (state.scale > fit * 1.6) {
      centerFit();
    } else {
      zoomAt(fit * 2.5, e.clientX, e.clientY);
    }
  });

  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (closeTimer !== null) { window.clearTimeout(closeTimer); closeTimer = null; }
    const factor = Math.exp(-e.deltaY * 0.0018);
    zoomAt(state.scale * factor, e.clientX, e.clientY);
  }, { passive: false });

  keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { closeLightbox(); return; }
    if (e.key === '0') { centerFit(); return; }
    if (e.key === '+' || e.key === '=') {
      zoomAt(state.scale * 1.25, window.innerWidth / 2, window.innerHeight / 2);
      return;
    }
    if (e.key === '-') zoomAt(state.scale / 1.25, window.innerWidth / 2, window.innerHeight / 2);
  };
  window.addEventListener('keydown', keyHandler);

  img.addEventListener('load', () => { centerFit(); el.classList.add('is-ready'); }, { once: true });
  img.src = item.src;
  /* 已经在缓存里的图不会触发 load */
  if (img.complete && img.naturalWidth) { centerFit(); el.classList.add('is-ready'); }

  document.body.appendChild(el);
  window.requestAnimationFrame(() => el.classList.add('is-in'));
}
