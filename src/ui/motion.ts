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

/** 用户是否要求减少动效（系统「减少动态效果」/ 无动画偏好）。
 *  注意：CSS 侧的降级（时长缩短、错峰归零、动画名降级为纯淡入）由 `src/style.css`「动效层」的
 *  `@media (prefers-reduced-motion: reduce)` 负责，**JS 侧不需要自己判断**。
 *  留着这个函数是给 JS 驱动的动画用（画布节点移动 / 列表让位那两片要引 Anime.js，媒体查询管不到）。 */
export function motionReduced(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 重放一次入场动画。默认 `lk-enter` = 淡入 + 上浮 8px（DESIGN.md:157 的 Waking fade），
 *  时长 `--motion-enter`。大容器（整个沙盘那种）建议传 `'lk-fade-in'`：只淡入不加 transform
 *  —— transform 会让该元素成为 fixed 子元素的包含块。 */
export function enter(el: HTMLElement | null, cls = 'lk-enter'): void {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;   /* 强制重排：让「移除」对动画引擎生效，否则重加类不会重播 */
  el.classList.add(cls);
}

/** 让容器的子项**错峰**入场（每项依次晚一点浮现）。
 *
 *  延迟不在这里算，而是由 CSS 按子项序号给（`.lk-enter-stagger > *:nth-child(n)`，见 style.css）——
 *  这样有两个好处：① 工具是动态 import 的，子项常常在**这个函数之后**才被建出来，按序号给的延迟
 *  对新插入的项同样生效（JS 遍历当时不存在的元素是注入不进去的）；② 节奏只有一处可调。
 *
 *  先摘类再重排再加类：子项动画由父类的后代选择器定义，摘掉父类＝子项动画失效，重排后加回来
 *  就是全新一次启动（只加类不会重播）。 */
export function staggerIn(container: HTMLElement | null): void {
  if (!container) return;
  container.classList.remove('lk-enter-stagger');
  void container.offsetWidth;
  container.classList.add('lk-enter-stagger');
}

/** **一次性**错峰：给容器的子项依次注入延迟并播一次入场，跑完把类与行内延迟都清掉。
 *
 *  与 `staggerIn` 的唯一区别是「一次性 vs 常驻」，两者都不能混用：
 *   · 页签栏那种「容器长期活着、子项随时会被换掉」→ `staggerIn`（类常驻，新子项自动有错峰）；
 *   · 工具打开 / 换页签那种「**这一次**渲染出来的这些块依次浮现」→ `cascadeIn`。
 *     类必须摘掉：工具下次重渲染（codex 是 `host.innerHTML = …` 整块重来）时新建的子项
 *     若再播一遍，就是"改个字段闪一下"。
 *
 *  ⚠️ 为什么不再对**整块容器**做淡入（原 `openTool` 里的 `enter(host)`）：容器是占满主区的
 *  一大片，整块 opacity 0→1 在视觉上就是"整个界面被洗白一下"（实测抓帧：点工具后第一帧里面
 *  内容已全部就位、只是整块发灰），而且它把每个元素自己的错峰**完全盖住**了。
 *  现在改成容器保持不透明、由里面的块依次浮现。
 *
 *  `step` 每块间隔；`maxDelay` 封顶（块多时不让最后一块等到天荒地老）；`start` 用于二级错峰
 *  （比如列表要等它所在的那一大块先浮现）。
 *
 *  ⚠️ 带 `.lk-own-cascade` 的子项会被**跳过**：那是"自己会给子级错峰"的容器
 *  （灵感触发器的卡片区 `#insp-result`）。父级若还给它整块淡入，就是把用户报过的那个病
 *  （整块半透明 ⇒ 洗白 + 里面每个元素自己的错峰被盖住）下沉一层。CSS 侧对应的
 *  `.lk-enter-stagger > .lk-own-cascade { animation: none }` 才是真正压住动画的那一条，
 *  这里过滤只是为了不给它写无用的行内延迟、以及不让它当"最后一块"（它没有动画，
 *  animationend 永远不会来，会白白等到兜底定时器）。
 *
 *  ⚠️ **没有盒子的子项（`display:none`）同样要跳过**，理由与上一条一模一样：
 *  2026-09-13 把设定库底部那句空消息行改成 `display:none` 之后，它正好是 `#cx-root` 的
 *  **最后一个**子项 —— 于是"最后一块的 animationend"永远不来，整组错峰只能等 2.5s 兜底定时器
 *  才收手（motion-switch ★6 立刻抓到：`{cls:true, anims:3}`）。判据用 `getClientRects().length`
 *  （没有盒子 ⇒ 动画不会跑），跳过后后面的块序号自动前移，延迟不会留空洞。 */
export function cascadeIn(container: HTMLElement | null, step = 100, maxDelay = 500, start = 0): void {
  if (!container) return;
  const kids = (Array.from(container.children) as HTMLElement[])
    .filter((el) => !el.classList.contains('lk-own-cascade') && el.getClientRects().length > 0);
  if (!kids.length) return;
  /* 减少动效：错峰整个关掉（DESIGN.md:159）。**必须在这里判**，不能只靠 CSS 的降级块 ——
     本函数给子项写的是**行内** animation-delay，行内值优先级高于媒体查询里的规则，
     不在这儿清零的话「减少动效」下依然会一个个错开着出来。 */
  const reduced = motionReduced();
  const st = reduced ? 0 : step;
  const md = reduced ? 0 : maxDelay;
  const s0 = reduced ? 0 : start;
  kids.forEach((el, i) => el.style.animationDelay = `${Math.min(s0 + i * st, md)}ms`);
  container.classList.remove('lk-enter-stagger');
  void container.offsetWidth;   /* 强制重排：只加类不会重播 */
  container.classList.add('lk-enter-stagger');
  const last = kids[kids.length - 1];
  const clear = (): void => {
    last.removeEventListener('animationend', onEnd);
    stopCascade(container);
  };
  /* ⚠️ `animationend` **会冒泡**：容器里任何后代元素自己的动画结束时都会飘上来。
     不认 `e.target` 的话，一个早早结束的后代动画就会把整组错峰提前收掉
     （实测：本该错峰 0/100/200/300ms + 640ms，几百毫秒后动画对象就空了、类也被摘了）。
     所以只认"最后一块自己"的那一次，且不能用 `{ once: true }`（冒泡事件会把它消耗掉）。 */
  const onEnd = (e: AnimationEvent): void => { if (e.target === last) clear(); };
  last.addEventListener('animationend', onEnd);
  /* 兜底：元素中途被换掉 / 动画被跳过时 animationend 不会来，不清的话下次切换会带着旧延迟重播 */
  window.setTimeout(clear, md + 2000);
}

/** 取消**一次性**错峰：摘掉容器上的错峰类、清掉子项的行内延迟（`cascadeIn` 自己收手时也走这里）。
 *
 *  为什么需要它（用户 2026-09-12 二次要求「重新生成改成无错分的，只有初次进入时才有错分」）：
 *  错峰类是等**最后一块**的 animationend（或 `maxDelay + 2000ms` 兜底）才摘掉的，
 *  在它挂着的这段时间里重渲染容器（灵感触发器「重新生成」重建 13 张卡），
 *  新子项会从父类继承 `.lk-enter-stagger > *` 那套 nth-child 延迟 ⇒ **又错峰一遍**，
 *  "不该播的那一次"照样播了。非动画分支显式调这个函数，结果就与点击时刻无关。 */
export function stopCascade(container: HTMLElement | null): void {
  if (!container) return;
  container.classList.remove('lk-enter-stagger');
  for (const el of Array.from(container.children) as HTMLElement[]) el.style.animationDelay = '';
}

/** 量下容器每个子项此刻的高度（**重建之前**调，结果喂给 `smoothHeights`）。
 *  高度只在"改 DOM 之前"才量得到旧值，所以是两步 API，不能合成一个函数。 */
export function childHeights(container: HTMLElement | null): number[] {
  if (!container) return [];
  return Array.from(container.children).map((el) => (el as HTMLElement).getBoundingClientRect().height);
}

/** 让容器子项从 `before`（`childHeights` 量的旧高度）**平滑过渡**到重建后的自然高度。
 *
 *  为什么需要（用户 2026-09-12：「刷新词条的时候高度会变，能不能改成平滑过渡」）：
 *  灵感触发器点「重新生成」时每张卡的词条数随机变（实测高度只有 80/104/128/152 四档），
 *  卡片区**同一个 tick 内**从 570px 跳到 498px —— 下面所有内容"啪"地弹一下。
 *  CSS 过渡不了 `height: auto`（内容驱动的变化不触发 height 过渡），所以这里量出前后 px、
 *  临时写死高度再过渡。网格行高与外层容器高度都是**跟着子项算出来的**，子项平滑变高变矮时
 *  它们自然一起平滑，不用单独处理。
 *
 *  与 `cascadeIn` 的区别：那个是**入场**（新元素浮现，动 opacity）；这个是**重排**（元素还在，
 *  只是变高变矮、把下面的挤开，动的是 height）。过渡期间挂 `.lk-h-smooth`（裁剪 + 时长/缓动）。
 *  减少动效时**整段跳过**：系统偏好的语义就是"别动"，高度直接落位。 */
export function smoothHeights(container: HTMLElement | null, before: number[]): void {
  if (!container || !before.length || motionReduced()) return;
  const kids = Array.from(container.children) as HTMLElement[];
  /* 先一次性量完所有"新高度"再动手：一旦给某张卡写死高度，后面量到的就是**过渡中的值** */
  const tos = kids.map((el) => el.getBoundingClientRect().height);
  kids.forEach((el, i) => {
    const from = before[i];
    const to = tos[i];
    if (from === undefined || to === undefined) return;   /* 新出现的子项没有旧高度可比，不补间 */
    if (Math.abs(to - from) < 1) return;                  /* 高度没变的卡：白挂一次过渡 */
    el.style.height = `${from}px`;
    el.classList.add('lk-h-smooth');
    void el.offsetWidth;   /* 强制重排：让 from 成为过渡起点（否则与 to 同一帧写入会被合并） */
    el.style.height = `${to}px`;
    const done = (): void => {
      el.removeEventListener('transitionend', onEnd);
      el.classList.remove('lk-h-smooth');
      el.style.height = '';   /* 还回 auto，高度重新由内容/网格说了算 */
    };
    /* ⚠️ `transitionend` **会冒泡**（同 cascadeIn 那个坑）：子孙元素自己的过渡结束也会飘上来，
       所以既要认 `e.target === el`，也不能用 `{ once: true }`（会被冒泡事件消耗掉）。
       另加 propertyName 过滤：这个类只过渡 height 一个属性。 */
    const onEnd = (e: TransitionEvent): void => { if (e.target === el && e.propertyName === 'height') done(); };
    el.addEventListener('transitionend', onEnd);
    /* 兜底：元素中途被换掉 / 过渡被打断时 transitionend 不会来，不清的话行内高度会一直挂着 */
    window.setTimeout(done, 900);
  });
}
