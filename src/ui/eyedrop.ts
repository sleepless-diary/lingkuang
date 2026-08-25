/** 吸管工具（模块级）：跨视图让用户去时间线上点取一个节点。
 * 用法：requestEyedrop(onPick) 进入吸管模式；时间线节点被点击时 pick(id) 回调；isActive() 判断是否在吸管中。
 */
let pickCb: ((id: string) => void) | null = null;

export function requestEyedrop(onPick: (id: string) => void): void {
  pickCb = onPick;
  window.dispatchEvent(new CustomEvent('lk-eyedrop-active', { detail: true }));
}
export function pick(id: string): void {
  if (!pickCb) return;
  const cb = pickCb;
  pickCb = null;
  window.dispatchEvent(new CustomEvent('lk-eyedrop-active', { detail: false }));
  cb(id);
}
export function isEyedropActive(): boolean {
  return pickCb !== null;
}
export function cancelEyedrop(): void {
  if (!pickCb) return;
  pickCb = null;
  window.dispatchEvent(new CustomEvent('lk-eyedrop-active', { detail: false }));
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancelEyedrop();
});
