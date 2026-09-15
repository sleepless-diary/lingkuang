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

/* ── 行级转场（换条目：旧内容往左走、新内容从右淡入）────────────────────────────────────────
   规格由用户在演示页 `docs/motion-demo/doc-slide.html` 里逐轮定稿（做法 P），照抄过来：
    · 两个关键帧：a = 不透明度 0 + 位置在终点**右边** `dx`，b = 不透明度 1 + 原位；入场曲线**快→慢**；
    · 出场是同一条动画反过来：不透明度 1 + 原位 → 0 + 往**左** `dx`，曲线**慢→快**；
    · **一行比一行晚** `step`（默认 10ms）；出场整体排完，入场才起步（`start` = 出场时长）⇒ 先出后进；
    · 只有**左右**位移，**没有上下** —— 上下位移会被看成"弹了一下"（用户 2026-09-13 的原话）。
   为什么用 Web Animations API 而不是 CSS 类：需要每行一个 delay、两条镜像曲线、还要能中途取消
   （快速连点时），CSS 类的行内延迟那套（`cascadeIn`）表达不了；而且这里必须 `fill:'both'`，
   否则入场在延迟期间会以**正常不透明度**显示 = 用户报过的"文字先出现，然后才演动画"。 */

/** 行级转场的公共参数：`dx` 入场距离(px)、`dy` 上下出场距离(px，给了它就走上下)、
 *  `step` 行错峰(ms)、`dur` 单行时长(ms)、`start` 入场整体延后(ms) */
export interface RowMotionOpts {
  dx?: number;
  dy?: number;
  step?: number;
  dur?: number;
  start?: number;
  /** 错峰总量的上限（默认 240ms）—— 几十行时不让最后一行等到近一秒才动 */
  maxDelay?: number;
}

/** 错峰默认上限：超过这个总量之后所有行一起动 */
const MAX_STAGGER = 240;

/** 出场曲线：慢 → 快 */
const EASE_ACCEL = 'cubic-bezier(0.7, 0, 0.84, 0)';
/** 入场曲线：快 → 慢 */
const EASE_DECEL = 'cubic-bezier(0.16, 1, 0.3, 1)';
/** 单行时长基准（速度倍率在调用处除） */
export const ROW_DUR = 300;

/** 动画跑完就**取消**（不是留在那儿吃 fill）—— 取消后元素回到自然样式，与动画终点完全一样，
 *  但 `getAnimations()` 是干净的。隐藏窗口里动画不推进、`finished` 永不 resolve，所以另有一条
 *  按参数算出来的兜底定时器（与 `cascadeIn` 的 `maxDelay + 2000` 同一个理由）。 */
function autoRelease(anims: Animation[], totalMs: number): void {
  const release = (): void => { for (const a of anims) { try { a.cancel(); } catch { /* 已取消 */ } } };
  if (!anims.length) return;
  Promise.all(anims.map((a) => a.finished)).then(release).catch(() => { /* 被取消过 */ });
  window.setTimeout(release, totalMs + 800);
}

/** 行级**出场**：每行 `1 / 原位` → `0 / 往左 dx`（慢→快），按序号错峰。返回动画对象（调用方可取消）。
 *  给了 `dy` 就走**上下**（`0 / 原位` → `-dy`，往上）—— 那是"入场动画倒着播"的用法，见 `rowsDropIn`。
 *  错峰总量有上限（`maxDelay`，默认 240ms）：一个文件夹里几十行时，`i * step` 会让最后一行等上
 *  近一秒才动（实测 44 行 ⇒ 967ms），看着就是"卡住不动然后整片消失"。 */
export function rowsLeave(rows: HTMLElement[], o: RowMotionOpts = {}): Animation[] {
  if (motionReduced()) return [];
  const dx = o.dx ?? 32;
  const step = o.step ?? 10;
  const dur = o.dur ?? ROW_DUR;
  const maxDelay = o.maxDelay ?? MAX_STAGGER;
  const out = o.dy !== undefined ? `translateY(${-o.dy}px)` : `translateX(${-dx}px)`;
  const anims = rows.map((el, i) =>
    el.animate(
      [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: out }],
      { duration: dur, delay: Math.min(i * step, maxDelay), easing: EASE_ACCEL, fill: 'both' }
    )
  );
  autoRelease(anims, dur + Math.min(step * rows.length, maxDelay));
  return anims;
}

/** 行级**入场**：每行 `0 / 从右 dx` → `1 / 原位`（快→慢），按序号错峰，整体延后 `start`。
 *  `fill:'both'` ⇒ 延迟期间**保持不透明度 0**（用户明确要求：动画开始前不许先亮出来）。 */
export function rowsEnter(rows: HTMLElement[], o: RowMotionOpts = {}): Animation[] {
  if (motionReduced()) return [];
  const dx = o.dx ?? 32;
  const step = o.step ?? 10;
  const dur = o.dur ?? ROW_DUR;
  const start = o.start ?? dur;
  const anims = rows.map((el, i) =>
    el.animate(
      [{ opacity: 0, transform: `translateX(${dx}px)` }, { opacity: 1, transform: 'none' }],
      { duration: dur, delay: start + i * step, easing: EASE_DECEL, fill: 'both' }
    )
  );
  autoRelease(anims, start + dur + step * rows.length);
  return anims;
}

/* ── 列表增删重排（工作台左树）────────────────────────────────────────────────────────────
   用户 2026-09-13：「新建实体和节点时**不是硬切换**，而是从左侧滑入（就像正文的入场一样），
   其下的所有节点都**向下平滑移动**（删除时也一样），展开文件夹时文件**向下弹出**」。
   三件事对应下面三个函数：
    · 新出现的那一行 → `rowSlideIn`（只有左右位移 + 渐显）；
    · 其余那些"位置变了"的行 → `flipRows`（FLIP：先瞬移回旧位置，再滑到新位置）；
    · 展开文件夹露出来的那些行 → `rowsDropIn`（从上方一点落下来）。
   为什么必须用 WAAPI：左树每次重画都是 `innerHTML` 整块换掉（`src/ui/codex.ts` 的 `renderList()`），
   元素是**新建**的、没有"旧位置"这个概念，CSS transition / keyframes 都表达不了。 */

/** **FLIP**：行增删之后，让还在的那些行从**旧位置**滑到新位置（＝其下的行平滑让位，删除时向上让位）。
 *
 *  `rows` / `keys` / `tops` 三个数组按下标对齐（`tops[i]` = 第 i 行现在相对容器的 top）；
 *  `prev` = **上一次**布局的 key → 相对 top。只有两次都在的行才动。
 *  位移太小（<1.5px，等于没动）或太大（>240px，那是整棵树换了形态）都不演 —— 后者演出来像乱飞。
 *  不给 `delay` 时 `fill:'none'`（结束自然落在新位置）；**给了 `delay` 就必须 `fill:'both'`** ——
 *  延迟期间要**冻在旧位置上**，否则那一行会先瞬移到新位置、等延迟过完再跳回旧位置演一遍
 *  （用户 2026-09-14：「应该是文件先消失，下面的文件夹再移上来，现在反了」——
 *  收起文件夹时，"里面的行退场"与"下面的行补位"必须**先后**发生，就靠这个 `delay`）。 */
export function flipRows(rows: HTMLElement[], keys: string[], tops: number[], prev: Map<string, number>, o: { dur?: number; delay?: number } = {}): Animation[] {
  if (motionReduced()) return [];
  const dur = o.dur ?? 320;
  const delay = o.delay ?? 0;
  const anims: Animation[] = [];
  rows.forEach((el, i) => {
    const p = prev.get(keys[i]);
    if (p === undefined) return;                       /* 新出现的行：由 rowSlideIn / rowsDropIn 负责 */
    const delta = p - tops[i];
    if (Math.abs(delta) < 1.5 || Math.abs(delta) > 240) return;
    anims.push(el.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }],
      { duration: dur, delay, easing: EASE_DECEL, fill: delay > 0 ? 'both' : 'none' }));
  });
  autoRelease(anims, dur + delay + 200);
  return anims;
}

/** 新出现的**一行**从左侧滑入（起点在终点左边 `dx`，往右落位）+ 渐显，快→慢。
 *  只有**左右**位移：上下位移会被看成"弹了一下"（用户 2026-09-13 的原话）。 */
export function rowSlideIn(el: HTMLElement | null, o: { dx?: number; dur?: number; delay?: number } = {}): Animation | null {
  if (!el || motionReduced()) return null;
  const dx = o.dx ?? 24;
  const dur = o.dur ?? 320;
  const delay = o.delay ?? 0;
  const a = el.animate(
    [{ opacity: 0, transform: `translateX(${-dx}px)` }, { opacity: 1, transform: 'none' }],
    { duration: dur, delay, easing: EASE_DECEL, fill: 'both' }
  );
  autoRelease([a], delay + dur + 200);
  return a;
}

/** 展开文件夹时，**被展开出来的那些行**从上方一点（`translateY(-dy)`）落下来 + 渐显，逐行小幅错峰。
 *  （用户 2026-09-13：「展开文件夹时文件向下弹出」）
 *  与 `rowsLeave` 对称：同样的 `maxDelay` 上限（几十行时不至于让末尾的行等近一秒）。 */
export function rowsDropIn(rows: HTMLElement[], o: { dy?: number; dur?: number; step?: number; maxDelay?: number } = {}): Animation[] {
  if (motionReduced()) return [];
  const dy = o.dy ?? 8;
  const dur = o.dur ?? 260;
  const step = o.step ?? 22;
  const maxDelay = o.maxDelay ?? MAX_STAGGER;
  const anims = rows.map((el, i) =>
    el.animate(
      [{ opacity: 0, transform: `translateY(${-dy}px)` }, { opacity: 1, transform: 'none' }],
      { duration: dur, delay: Math.min(i * step, maxDelay), easing: EASE_DECEL, fill: 'both' }
    )
  );
  autoRelease(anims, dur + Math.min(step * rows.length, maxDelay) + 200);
  return anims;
}

/** 把**一个元素**演出场再从 DOM 里摘掉（删除条目时钉在原位淡出的幽灵层用）。
 *  动画跑完（或兜底超时）后 `el.remove()` —— `rowsLeave` 本身只播不动 DOM。 */
export function rowLeaveAndRemove(el: HTMLElement | null, o: RowMotionOpts = {}): void {
  if (!el) return;
  const anims = rowsLeave([el], o);
  const kill = (): void => {
    const box = el.parentElement;   /* 幽灵住在裁切层里 ⇒ 空了这层也要跟着走（同 rowsLeaveAndRemove） */
    el.remove();
    if (box && box.classList.contains('lk-ghost-layer') && !box.childElementCount) box.remove();
  };
  if (!anims.length) { kill(); return; }   /* 减少动效：直接摘掉 */
  Promise.all(anims.map((a) => a.finished)).then(kill).catch(kill);
  window.setTimeout(kill, (o.dur ?? ROW_DUR) + (o.step ?? 10) + 400);
}

/** 一批行按 `rowsLeave` 演完**总共要多久**（最后一行的 delay + 单行时长）。
 *  收起文件夹时要用它给"下面的行补位"（`flipRows` 的 `delay`）定时 ——
 *  用户 2026-09-14：「应该是**文件先消失，下面的文件夹再移上来**，现在反了」。 */
export function rowsLeaveTotal(n: number, o: RowMotionOpts = {}): number {
  const step = o.step ?? 10;
  const dur = o.dur ?? ROW_DUR;
  const maxDelay = o.maxDelay ?? MAX_STAGGER;
  return dur + Math.min(step * Math.max(0, n - 1), maxDelay);
}

/** 把**一批**元素演出场再从 DOM 里摘掉（收起文件夹时，里面那些行不是"啪"地消失，
 *  而是原地往左淡出）。
 *
 *  用户 2026-09-14：「设定文件夹收起时无动画，收起时下面的文件直接消失」——
 *  收起时那一枝的行会被 `innerHTML` 整块换掉，元素是当场没的；所以退场必须演在
 *  **克隆出来的幽灵层**上（调用方先 `cloneNode` + `position:fixed` 钉在原位，见
 *  `src/ui/codex.ts` 的 `ghostRows()`），这里只负责播 + 收。 */
export function rowsLeaveAndRemove(rows: HTMLElement[], o: RowMotionOpts = {}): void {
  if (!rows.length) return;
  const anims = rowsLeave(rows, o);
  const kill = (): void => {
    for (const el of rows) {
      const box = el.parentElement;
      el.remove();
      /* 幽灵是住在一层**裁切层**里的（见 `ghostLayerFor`）：最后一行摘掉之后这层也得跟着走，
         否则页面上会留一堆空的 fixed 层（它们不吃事件，但会挡住别的测试的 `elementFromPoint`）。 */
      if (box && box.classList.contains('lk-ghost-layer') && !box.childElementCount) box.remove();
    }
  };
  if (!anims.length) { kill(); return; }   /* 减少动效：直接摘掉 */
  Promise.all(anims.map((a) => a.finished)).then(kill).catch(kill);
  const dur = o.dur ?? ROW_DUR;
  const step = o.step ?? 10;
  window.setTimeout(kill, dur + step * rows.length + 400);
}

/* ── 幽灵层的裁切 + "最外面那个框"的高度平滑 ────────────────────────────────────────────────
   用户 2026-09-14：「文件树**最外面的框**也要做平滑切换，而且关文件夹时**部分文件会超出这个框**」。

   两条其实是同一件事的两半：收起文件夹时外框**当场**从 327px 缩到 23px（实测同一 tick 就缩完），
   而退了场的行是挂在 `document.body` 上的 `position:fixed` 克隆体 —— 既不受外框裁切、也没有跟着缩，
   于是它们"飘"在缩小后的框外面。所以：
   ① 幽灵改成住进一层**贴着外框、`overflow:hidden`** 的裁切层（`ghostLayerFor` + `cloneIntoLayer`）；
   ② 外框自己的高度变化改成**演出来**（`smoothBoxHeight`），动画期间同样 `overflow:hidden`。 */

/** 造一层贴着 `clip` 那个元素位置的**裁切层**（`position:fixed` + `overflow:hidden`，挂在 body 上）。
 *  返回层与层自己的 rect（克隆坐标要换算成层内坐标）。`motionReduced()` 时返回 null。 */
export function ghostLayerFor(clip: HTMLElement, z = 860): { layer: HTMLElement; rect: DOMRect } | null {
  if (motionReduced()) return null;
  const r = clip.getBoundingClientRect();
  const layer = document.createElement('div');
  layer.className = 'lk-ghost-layer';
  layer.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;overflow:hidden;pointer-events:none;z-index:${z};`;
  document.body.appendChild(layer);
  return { layer, rect: r };
}

/** 把一个元素克隆进裁切层（坐标换成层内坐标，用 `position:absolute` 才受层的 `overflow:hidden` 约束）。
 *  ⚠️ 克隆体里的 `[id]` 一律摘掉：留着就是页面里第二个 `#cx-fields` / `#cx-doc`，`querySelector` 会抓错。
 *  ⚠️ **不要**顺手写 `padding:0`：树的缩进是各层类的 `padding-left`（世界 8px / 时间线 18px /
 *  种类 27px / 条目 36px），清零会让整行**往左跳**（用户 2026-09-14：「收起文件时文件会先向左移」）。 */
export function cloneIntoLayer(layer: HTMLElement, rect: DOMRect, el: HTMLElement, cls?: string): HTMLElement {
  const r = el.getBoundingClientRect();
  const g = el.cloneNode(true) as HTMLElement;
  g.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  if (cls) g.classList.add(cls);
  g.style.cssText = `position:absolute;left:${r.left - rect.left}px;top:${r.top - rect.top}px;width:${r.width}px;height:${r.height}px;margin:0;pointer-events:none;`;
  layer.appendChild(g);
  return g;
}

/** **一个元素自己**的高度变化也演出来（左树外面那个框）。`from` = 变化前量到的高度；
 *  新高度当场量（此刻还没钉住）。位移太小就什么都不做。演完把 `overflow` 还回去、取消动画
 *  （`fill:'none'` ⇒ 落回自然高度，与动画终点一致，不会跳）。 */
export function smoothBoxHeight(el: HTMLElement | null, from: number, o: { dur?: number } = {}): Animation | null {
  if (!el || motionReduced() || !(from > 0)) return null;
  const to = el.getBoundingClientRect().height;
  if (Math.abs(to - from) < 1.5) return null;
  const prevOverflow = el.style.overflow;
  const dur = o.dur ?? 240;           /* 与 `.lk-ghost-layer` 的过渡时长同档（见 src/style.css） */
  el.style.overflow = 'hidden';       /* 动画期间必须裁住：框还矮着的时候里面的行会溢出去 */
  const a = el.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: dur, easing: EASE_DECEL, fill: 'none' });
  let done = false;
  const finish = (): void => { if (done) return; done = true; el.style.overflow = prevOverflow; try { a.cancel(); } catch { /* 已取消 */ } };
  a.finished.then(finish).catch(() => { /* 被取消过 */ });
  window.setTimeout(finish, dur + 400);
  return a;
}

/** **老虎机式换字**：同一个地方换一种说法时，旧字往上滚出、新字从下滚入。
 *
 *  用户 2026-09-14：「新建实体按钮里面实体和节点文字的切换做成类似老虎机的上下切换」。
 *  `box` = 那个裁切盒（`.lk-roll`，`overflow:hidden`），里面第二层 `.lk-roll__t` 是真标签。
 *  做法：把旧文字克隆一份绝对定位盖在原处往上滚出，真标签换成新文字后从下方滚入。
 *  ⚠️ **滚动距离 = 裁切盒自己的高度**（不是写死的 13px）：滚一格的距离小于一行字高时，
 *  旧字和新字在盒子里**叠在同一处**，看着像文字糊成一团（用户 2026-09-14：「新建实体按钮
 *  文字会重叠」）。按盒高滚 ⇒ 旧字整行移出、新字整行移入。
 *  ⚠️ **两段错开播，不同时**（`in` 的 delay = `out` 的时长）：同时播时虽然两行字在几何上正好首尾相接，
 *  但**各露半截、又都还半透明**，看上去仍是两层笔画叠在一起（用户第二轮反馈的「节点和实体两个文字
 *  会重叠」）。错开之后任何一帧要么是旧字在往上走、要么是新字在往下落，中间那一下盒里接近空的。
 *  ⚠️ **只滚"会变的那两个字"**：调用方把不动的部分（「＋新建」）放在盒外 —— 整串一起滚等于
 *  两行字各有半截留在盒里，正是上面那个"重叠"的观感。
 *  ⚠️ 跑完**两个动画都取消**（`fill:'both'` 留着会让 `getAnimations()` 一直非空 ——
 *  而"换类别后容器里不许有动画"那几条守卫正是按它判的）。 */
export function rollText(box: HTMLElement | null, next: string, o: { dur?: number; dy?: number } = {}): void {
  const t = box?.querySelector<HTMLElement>('.lk-roll__t');
  if (!box || !t) return;
  if ((t.textContent ?? '') === next) return;
  if (motionReduced()) { t.textContent = next; return; }
  const dur = o.dur ?? 180;    /* **每一段**的时长：整段换字 = 2 × dur */
  /* 盒高即"一行"：量不到就退回 16px（≈ 常见行高），绝不退回 13 那种小于字高的值 */
  const dy = o.dy ?? Math.max(12, Math.round(box.getBoundingClientRect().height) || 16);
  const prev = t.cloneNode(true) as HTMLElement;
  prev.classList.add('lk-roll__prev');
  box.appendChild(prev);
  t.textContent = next;
  const out = prev.animate(
    [{ transform: 'translateY(0)', opacity: 1 }, { transform: `translateY(${-dy}px)`, opacity: 0 }],
    { duration: dur, easing: EASE_ACCEL, fill: 'both' }
  );
  const inn = t.animate(
    [{ transform: `translateY(${dy}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
    { duration: dur, delay: dur, easing: EASE_DECEL, fill: 'both' }
  );
  const done = (): void => {
    try { out.cancel(); inn.cancel(); } catch { /* 已取消 */ }
    prev.remove();
  };
  Promise.all([out.finished, inn.finished]).then(done).catch(done);
  window.setTimeout(done, dur * 2 + 600);
}

/** 量下容器里每个子项此刻**相对容器顶部**的 top（喂给 `flipRows` 的 `prev` / `tops`）。
 *  用相对 top 而不是视口 top：`#cx-list` 会跟着 `#cx-root` 一起滚，视口坐标会把滚动量算进去。 */
export function topsOf(container: HTMLElement | null): { els: HTMLElement[]; tops: number[] } {
  if (!container) return { els: [], tops: [] };
  const base = container.getBoundingClientRect().top;
  const els = Array.from(container.children) as HTMLElement[];
  return { els, tops: els.map((el) => el.getBoundingClientRect().top - base) };
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
