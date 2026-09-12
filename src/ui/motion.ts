/** 灵框 · 动效层（切换类：入场 / 错峰 / 弹层）
 *
 *  规格：`design-system/DESIGN.md` 第 7 节（Motion & Interaction）—— 动作慢、呼吸感、不 snappy；
 *  令牌在 `design-system/tokens.css`（`--motion-fast` 180 / `--motion-base` 320 / `--motion-slow` 640
 *  + `--ease-standard`），keyframes 在 `src/style.css` 末尾的「动效层」一节。
 *
 *  **为什么用 CSS 而不是动画库**（Anime.js 已装在 devDependencies，见文末说明）：
 *    ·「元素变化」的绝大多数场景（进场、错峰、弹层）CSS keyframes 就够 —— 零运行时开销、
 *      自动吃到 tokens.css 的 `prefers-reduced-motion` 降级块（用户少动效偏好时只留短淡入）。
 *    · 只有「元素被重建、却要从**旧位置**连续滑到新位置」的场景（时间线节点移动 / 循环框变化 /
 *      列表增删后其余项让位）CSS transition 表达不了（元素重建后没有"旧位置"这个概念），
 *      那类才用 Anime.js —— 作用点见 docs/ARCHITECTURE.md「动效层」。
 *
 *  两条纪律（违反会踩到已知坑）：
 *    ① 入场动画只挂**显式切换**（切工具 / 开面板 / 换页签 / 弹窗）。**不要**挂到 store 订阅
 *       触发的重渲染上 —— `src/ui/timeline.ts` 每次 store 通知都整体重渲染，
 *       挂了会变成「拖动节点时动画不停重放」（`docs/ROADMAP.md` 硬约束）。
 *    ② 重放必须「摘类 → 强制重排 → 加类」。只加类不会重播：动画在元素上已经跑完，
 *       类名没变化时引擎不会重新开始。
 */

/** 用户是否要求减少动效（系统「减少动态效果」/ 无动画偏好）。 */
export function motionReduced(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 重放一次入场动画。默认 `lk-enter` = 淡入 + 上浮 8px（DESIGN.md:157 的 Waking fade），时长 `--motion-base`。
 *  大容器（整个沙盘那种）建议传 `'lk-fade-in'`：只淡入不加 transform —— transform 会让该元素
 *  成为 fixed 子元素的包含块（弹层/右键菜单虽是临时元素，也没必要冒这个险）。 */
export function enter(el: HTMLElement | null, cls = 'lk-enter'): void {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;   /* 强制重排：让「移除」对动画引擎生效，否则重加类不会重播 */
  el.classList.add(cls);
}

/** 给容器的子项注入错峰延迟（`--lk-delay`），并挂上 `lk-enter-stagger` 让它们获得入场动画。
 *
 *  `sel` 默认直接子项。`step` 是每项间隔（DESIGN.md:157 用 ~40ms），`cap` 是错峰上限
 *  —— 长列表错峰无上限会让最后一项等一两秒（列表越长越像卡了）。
 *
 *  为什么先摘类再重排再加类：延迟是**行内** `--lk-delay`，而子项动画由父类的后代选择器定义。
 *  只改行内值对**已经在跑**的动画无效（动画早已按旧延迟启动）；摘掉父类会让子项动画失效，
 *  重排后再加回来就是全新一次启动，新延迟才生效。 */
export function staggerIn(container: HTMLElement | null, sel = ':scope > *', step = 40, cap = 12): void {
  if (!container) return;
  const items = Array.from(container.querySelectorAll<HTMLElement>(sel));
  container.classList.remove('lk-enter-stagger');
  if (!motionReduced()) {
    /* 减少动效：错峰关掉（延迟是行内值，tokens.css 的媒体查询压不住行内） */
    items.forEach((el, i) => el.style.setProperty('--lk-delay', `${Math.min(i, cap) * step}ms`));
  }
  void container.offsetWidth;
  container.classList.add('lk-enter-stagger');
}
