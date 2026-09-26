/** 世界沙盘 · 时间线视图（TS 版，批量迁移 legacy 核心）
 * 节点横排 + 标尺刻度 + 平移缩放 + 时间指针 + 节点拖动改时间 + fit 视图
 */
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import { getTimeline, setTimeCursor, saveNodeDoc, addLoop, setLoopCount, removeLoop, copyNode, removeNode } from '../store/actions';
import { uid } from '../store/ids';
import type { Timeline, TimelineNode, Storyline, Loop } from '../store/types';
import { renderNodeForm } from './node-form';
import { isEyedropActive, pick } from './eyedrop';
import { escapeHtml } from './html';
import { confirmDialog } from './confirm';
import { toEpoch, fromEpoch, calendarOf, timePointOf, buildYearTable } from '../calendar';
import type { Calendar, YearTable } from '../calendar';

interface View {
  panX: number;
  panY: number;
  spacing: number;      // px/年
}

export function mountTimeline(
  store: Store,
  host: HTMLElement,
  onSelect?: (node: TimelineNode) => void
): void {
  host.classList?.remove('lk-placeholder');   /* 挂载后移除占位样式 */
  host.innerHTML = `
    <div class="tl-wrap" style="position:relative;width:100%;height:100%;overflow:hidden;cursor:default;">
      <div class="tl-scale" style="position:absolute;top:0;left:0;right:0;height:34px;background:var(--surface-2);overflow:hidden;"></div>
      <div class="tl-track" style="position:absolute;top:34px;left:0;right:0;bottom:0;cursor:crosshair;"></div>
      <svg class="tl-causes" style="position:absolute;top:34px;left:0;right:0;bottom:0;pointer-events:none;z-index:4;overflow:visible;"></svg>
      <div class="tl-cursor" style="position:absolute;top:0;bottom:0;width:0;pointer-events:none;display:none;z-index:5;">
        <div style="position:absolute;top:38px;bottom:0;left:-1px;width:2px;background:var(--accent);opacity:.55;"></div>
        <div class="tl-cursor-handle" style="position:absolute;top:4px;left:-9px;width:18px;height:18px;border-radius:50%;background:var(--chrome);border:1px solid var(--accent);cursor:ew-resize;pointer-events:auto;box-shadow:0 2px 6px rgba(0,0,0,.4);"></div>
        <div class="tl-cursor-time" style="position:absolute;top:32px;left:6px;font-family:var(--font-mono);font-size:9px;color:var(--accent);background:rgba(15,15,17,.8);padding:1px 5px;border-radius:3px;white-space:nowrap;"></div>
      </div>
    </div>`;

  const wrap = host.querySelector('.tl-wrap') as HTMLElement;
  const scaleEl = host.querySelector('.tl-scale') as HTMLElement;
  const track = host.querySelector('.tl-track') as HTMLElement;
  const causesSvg = host.querySelector('.tl-causes') as SVGSVGElement;
  const cursorEl = host.querySelector('.tl-cursor') as HTMLElement;
  const cursorTimeEl = cursorEl.querySelector('.tl-cursor-time') as HTMLElement;
  const view: View = { panX: 0, panY: 0, spacing: 2 };
  /* ── 分段映射（第 4.0 片 C 底座）的缓存 ──
     聚焦一条剧情线时，段与段之间的空隙要从时间轴上**压掉**（见 rebuildWarp 那段注释）。
     状态声明放在这里（而不是跟函数放在剧情线那一节）：`timeToX/xToTime` 会在这之前就被调用，
     `let` 有 TDZ —— 在这里先落地成 null，早调用就按"不压缩"走。 */
  type WarpSeg = { a: number; b: number; base: number };   // 真实年区间 [a,b] + 它在压缩轴上的起点
  let warpSegs: WarpSeg[] | null = null;
  let warpTotal = 0;
  let warpReady = false;
  /* ── 平滑视图（第 3.9 片）─────────────────────────────────────────────
     用户 2026-09-18：「**除了拖动以外都做成平滑切换**：时间线的滚动、标尺的缩放、标尺的移动」，
     拖动除外（拖动时鼠标变抓手）。滚轮不再直接改 view，而是改 targetView，再由每帧循环把 view 逼近它：
       view += (target - view) × (1 − exp(−k·dt))
     比「差值 × 固定比例」好在**帧率无关**（60Hz 与 120Hz 手感一致，且每次吃掉剩余距离的固定比例，永不越界）。
     缩放插的是 **log(spacing)** —— spacing 是 px/年（乘性的量），直接线性插会在细档「嗖」地跳过去。
     ⚠️ 隐藏窗口里 rAF 不跑（测试实例 visibilityState === "hidden"）⇒ **直接落值**，
     否则自动化永远读不到确定几何；prefers-reduced-motion 同理（这里内联判，免得为一个判据加 import）。 */
  const targetView = { panX: 0, spacing: 2 };
  const EASE_K = 14;                       /* 每秒吃掉多少剩余比例：14 ≈ 250ms 基本到位 */
  let easeRaf = 0;
  /* 缓动看门狗（2026-09-26 由「固定 600ms 兜底」改）：只在 rAF **真的停摆**时才落值。
     ⚠️ 旧写法 `setTimeout(..., 600)` 是「启动后 600ms 无条件 snapView()」——连滚多格时缓动本来
     就可能跑过 600ms ⇒ 兜底把**还在跑的**缓动掐掉、一帧内直接落值。实测（100 格连续缩放、
     `tools/e2e/probe-ease-edge.cjs` 逐帧）：61ms 起跑 → 664ms 兜底响 → view 从 -34,196,900
     跳到 -125,926,000px（9,172 万 px）→ 675ms 再起跑 → 1278ms 再跳一次（3.9 亿 px）
     ＝ 用户报的「在缩放尺度边缘时标尺缩放的缓动没生效」＋「缩放时标尺有轻微卡顿」（同一个病根）。
     看门狗：`lastFrameAt` 每帧刷新，只有 `EASE_STALL_MS` 内**一帧都没出**才判定停摆（后台窗口/
     未聚焦/节流 —— 也就是旧兜底真正要防的那件事）。 */
  let easeWatchdog = 0;
  let lastFrameAt = 0;
  const EASE_STALL_MS = 250;
  /* 缩放锚点（第 3.9 片补）：用户实测「缩放时标尺会左右横移」——
     病根两条：① 锚点时间 `tAt` 用**还在动画中的当前视图**算，连滚两格就漂；
     ② 每帧把 spacing 和 panX **各自**插值，锚点自然按不住（spacing 变了 panX 没跟上）。
     现在：锚点时间一律用**目标视图**算，并且缩放期间 panX 由「锚点不动」反推。 */
  let zoomHold: { x: number; t: number } | null = null;
  /* ⚠️ 三种情况**不做动画、直接落值**：
     ① 系统开了「减少动态效果」；② 页面不可见；③ **窗口没聚焦**。
     ③ 是实测逼出来的：后台/未聚焦窗口里 rAF 被降频甚至暂停，平滑循环会**停在半路**，
     视图既不跟手也不到位（自动化里表现为「平移 180px 只走了 49px 就停了」）。
     顺带也是好事：没在看的时候不做无用动画。 */
  const noSmooth = (): boolean =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.visibilityState === 'hidden' || !document.hasFocus();
  function snapView(): void { view.panX = targetView.panX; view.spacing = targetView.spacing; }
  function kickEase(): void {
    if (noSmooth()) { snapView(); render(); return; }
    if (easeRaf) return;
    let last = performance.now();
    lastFrameAt = last;                     /* 看门狗起点（首帧还没来，先按"刚活过"算） */
    const step = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000);   /* 卡帧时别一次吃掉太多 */
      last = now;
      lastFrameAt = now;                    /* 看门狗：这一帧还活着 */
      const a = 1 - Math.exp(-EASE_K * dt);
      const ls = Math.log(view.spacing), lt = Math.log(targetView.spacing);
      view.spacing = Math.exp(ls + (lt - ls) * a);
      if (zoomHold) {
        /* 缩放：把锚点那一格**钉在屏幕同一位置**（panX 由 spacing 反推），就不会左右横移 */
        view.panX = zoomHold.x - 40 - (zoomHold.t / SEC_PER_YEAR) * view.spacing;
      } else {
        view.panX += (targetView.panX - view.panX) * a;
      }
      render();
      const done = Math.abs(targetView.panX - view.panX) < 0.05
        && Math.abs(Math.log(targetView.spacing / view.spacing)) < 0.0005;
      if (done) { window.clearTimeout(easeWatchdog); snapView(); render(); easeRaf = 0; return; }
      easeRaf = requestAnimationFrame(step);
    };
    easeRaf = requestAnimationFrame(step);
    /* 兜底（看门狗）：rAF 被降频/暂停时（后台窗口、未聚焦、节流）平滑循环会停在半路 ——
       那时才落值。**不是**按时间无条件落值，所以连滚多格的长缓动不会被半路打断。
       实测过「平移 180px 只走了 27px 就停住」那种停摆，看门狗 250ms 内一定抓到。 */
    window.clearTimeout(easeWatchdog);
    const watch = (): void => {
      if (performance.now() - lastFrameAt <= EASE_STALL_MS) {
        easeWatchdog = window.setTimeout(watch, EASE_STALL_MS);   /* 还在出帧 ⇒ 什么都不做 */
        return;
      }
      if (easeRaf) { cancelAnimationFrame(easeRaf); easeRaf = 0; }
      snapView(); render();
    };
    easeWatchdog = window.setTimeout(watch, EASE_STALL_MS);
  }

  /* ── 坐标换算：出入公历 epoch 秒；spacing 为 px/年，内部用平均年宽(SEC_PER_YEAR)换算 ──
     ⚠️ 位置定位用近似年宽，日期显示用 fromEpoch 精确(公历闰年) */
  function timeToX(e: number): number { return year2w(e / SEC_PER_YEAR) * view.spacing + view.panX + 40; }
  function xToTime(x: number): number { return w2year((x - 40 - view.panX) / view.spacing) * SEC_PER_YEAR; }

  /* ── 历法刻度辅助：节点/时间点 → 绝对刻度（统一坐标轴单位）── */
  function cal(): Calendar {
    return calendarOf(timeline() ?? {});
  }
  /* 历法年表缓存：把 toEpoch/fromEpoch 降为 O(1)，避免每次 O(年数) 累加导致卡顿 */
  let yearTable: YearTable | undefined;
  function getYearTable(): YearTable | undefined {
    return yearTable;
  }
  function setYearTable(min: number, max: number): void {
    yearTable = buildYearTable(cal(), min, max);
  }
  function nodeEpoch(n: TimelineNode): number {
    return toEpoch(cal(), timePointOf(n.year ?? 0, n), getYearTable());
  }
  /* 纯年份 → epoch 秒（作为该年 1月1日，用于剧情框/循环的"年"定位转 epoch 秒） */
  function yearEpoch(y: number): number {
    return toEpoch(cal(), timePointOf(Math.floor(y), { month: 1, day: 1, hour: 0 }), getYearTable());
  }
  /* 按当前标尺档位(unit)裁剪显示：从『年』显示到该档位，如 unit='日' → 316年7月15日；unit='时' → ...9时 */
  function epochText(epoch: number, unit?: string): string {
    const tp = fromEpoch(cal(), epoch, getYearTable());
    const y = tp.anchor.year, v = tp.values;
    let s = `${y}年`;
    if (unit === '年') return s;                    /* 只到年 */
    if (v.month >= 1) s += `${v.month}月`;
    if (unit === '月') return s;
    if (v.day >= 1) s += `${v.day}日`;
    if (unit === '日') return s;
    if (v.hour) s += `${v.hour}时`;
    if (unit === '时') return s;
    if (v.minute) s += `${v.minute}分`;
    return s;
  }

  /* ── 有效时间线 id（兼容旧数据 order 与 key 不一致）── */
  function activeTimelineId(): string | undefined {
    const ws = currentWorld(store);
    const valid = (ws.order ?? []).find((id) => ws.timelines[id]);
    if (store.activeTimeline && ws.timelines[store.activeTimeline]) return store.activeTimeline;
    return valid || Object.keys(ws.timelines)[0];
  }
  function timeline(): Timeline | undefined {
    const id = activeTimelineId();
    return id ? getTimeline(store, id) : undefined;
  }

  /* ── 标尺刻度（照抄 legacy niceStep/buildScale）── */
  /* 公历平均年宽（365.25 天），用于坐标定位的「epoch秒 ↔ 年」近似换算；日期显示用 fromEpoch 精确 */
  const SEC_PER_YEAR = 31557600;
  /* 取最接近的 1/2/5/10 倍（使每格落在「整数个较友好单位」上，有中间过渡档） */
  /* 标尺步长（d3 式参考版）：每格目标 72px → 算出每格应跨多少年 → 按单位(年/月/日/时/分)分档，niceStep 取整。
     这是之前验证过「年→月→日→时→分」单调正确的版本，作为参考基准。 */
  function quantStepAt(sp: number): { stepSec: number; unit: string } {
    const years = 72 / sp;   /* 每格应跨多少年 */
    function niceStep(raw: number): number {
      const p = Math.pow(10, Math.floor(Math.log10(raw)));
      const m = raw / p;
      return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
    }
    if (years >= 1) {
      const n = Math.max(1, niceStep(years));
      return { stepSec: Math.round(n * SEC_PER_YEAR), unit: '年' };
    }
    const months = years * 12;
    if (months >= 1) {
      const n = Math.max(1, niceStep(months));
      return { stepSec: Math.round(n * (SEC_PER_YEAR / 12)), unit: '月' };
    }
    const days = months * 30.4375;
    if (days >= 1) {
      const n = Math.max(1, niceStep(days));
      return { stepSec: Math.round(n * 86400), unit: '日' };
    }
    /* 时/分档也走 niceStep（旧代码 hours 直接用、分档写死 60 秒 ⇒ 缩到这两档时
       刻度按「1 小时 / 1 分钟」硬网格铺，屏幕上会**突然变密**）。 */
    const hours = days * 24;
    if (hours >= 1) { const n = Math.max(1, niceStep(hours)); return { stepSec: Math.round(n * 3600), unit: '时' }; }
    const mins = hours * 60;
    const nm = Math.max(1, niceStep(mins));
    return { stepSec: Math.max(60, Math.round(nm * 60)), unit: '分' };
  }
  /* 标尺刻度文字：走历法(fromEpoch)，返回两级 {prev(上一级,更粗), cur(当前,细)}。
     例 unit='日' → {prev:'7月', cur:'15号'}；unit='月' → {prev:'285年', cur:'7月'} */
  /* 标尺刻度文字：用 fromEpoch(历法) 精确反推（坐标已统一 epoch 秒，SEC_PER_YEAR=公历平均年宽） */
  function fmtScale(s: number, unit: string): { prev: string; cur: string } {
    const tp = fromEpoch(cal(), s, getYearTable());
    const y = tp.anchor.year, v = tp.values;
    const m = v.month, d = v.day, h = v.hour, mi = v.minute;
    switch (unit) {
      case '年': return { prev: '', cur: `${y}年` };
      case '月': return { prev: `${y}年`, cur: `${m}月` };
      case '日': return { prev: `${m}月`, cur: `${d}号` };
      case '时': return { prev: `${d}日`, cur: `${h}时` };      /* 上一级=日（纯日） */
      case '分': return { prev: `${h}时`, cur: `${mi}分` };
      default:  return { prev: `${mi}分`, cur: `${s % 60}秒` };
    }
  }
  /** 一套网格（`unit` + `stepSec`）在**当前视图**下该有的刻度：主刻度（带数字）+ 小刻度 + 断口。
      抽成函数是给「换档交叉淡化」用的（2026-09-26 第 ⑥ 轮）：交接点附近要把**相邻那套网格的数字**
      也画出来，而两套网格的生成规则完全一样（历法进位 / 全局原点相位 / 聚焦剔空隙），
      差别只有 `unit` / `stepSec`。
      `majorOnly` = 邻居网格只画主刻度：它的**线**一律隐身（只有数字在淡），小刻度画了也看不见，
      纯粹白占 DOM 和每帧写样式的开销。 */
  function gridItems(unit: string, stepSec: number, majorOnly: boolean): { key: string; cls: string; left: number; html: string }[] {
    const s0 = Math.round(xToTime(0));                 /* 左边缘 epoch 秒（xToTime 已返回 epoch 秒） */
    const s1 = Math.round(xToTime(wrap.clientWidth));   /* 右边缘 epoch 秒 */
    /* 主刻度间距 stepSec；细分出小刻度（每主刻度间 subDiv 个小竖线，如尺子副刻度） */
    const subDiv = 10;                      /* 每个主刻度间细分 10 个小刻度 */
    /* 起点对齐：各档位向上对齐到「整单位」边界（年→1月1日0点、月→1日0点、日→0点、时→整时、分→整分），
       确保刻度落在整齐的整单位上，不跳过、不落中间 */
    let start: number;
    {
      const tp = fromEpoch(cal(), s0, getYearTable());
      let y = tp.anchor.year, mo = tp.values.month, d = tp.values.day, h = tp.values.hour, mi = tp.values.minute;
      switch (unit) {
        case '年': mo = 1; d = 1; h = 0; mi = 0; break;   /* 对齐到整年 1月1日 */
        case '月': d = 1; h = 0; mi = 0; break;            /* 对齐到整月 1日 */
        case '日': h = 0; mi = 0; break;                   /* 对齐到整日 0点 */
        case '时': mi = 0; break;                          /* 对齐到整时 */
        case '分': break;                                  /* 分档，保留 */
      }
      start = toEpoch(cal(), timePointOf(y, { month: mo, day: d, hour: h, minute: mi }), getYearTable());
    }
    /* 主刻度的 epoch **逐个按历法算**（不是 `start + i*stepSec`）。
       ⭐ 2026-09-18 用户实测：「标尺会随着左右移动改变显示的数字」—— 旧代码年档用
       `start + i * stepSec`（stepSec = n×365.25 天），加着加着就漂出 1月1日：
       同一个视觉位置在不同平移量下会算出不同的年份，于是数字跟着平移变。
       年档按整年进位、月档按月进位、日档按天进位（都走 timePointOf，尊重大小月/闰年），
       时/分档走均匀的秒网格（整小时/整分钟，天然和平移无关）。 */
    const stepYears = Math.max(1, Math.round(stepSec / SEC_PER_YEAR));
    const stepDays = Math.max(1, Math.round(stepSec / 86400));
    const stepMonths = Math.max(1, Math.round(stepSec / (SEC_PER_YEAR / 12)));
    /* ⭐ 刻度网格锚在**全局原点**上（不是视窗左边缘）。用户 2026-09-18 实测：
       「省略的区域不固定，有时候是 182 有时候变成 186」—— 旧代码的 `start` 取「左边缘所在的那一格」，
       于是**平移一格整条网格的相位就翻过去**（180/185/190 → 182/187/192），同一缩放档下省略的年份会变。
       现在：年档取 stepYears 的整数倍年、月档取「自 0 年起的月序号」的整数倍、日档取「自 epoch 起的整日序号」的倍数，
       时/分本来就是秒网格 —— **相位只由 step 决定，跟平移和视窗宽度无关**。 */
    const mod = (n: number, s: number): number => ((n % s) + s) % s;
    const tp0 = fromEpoch(cal(), start, getYearTable());
    const mainSec: number[] = [];
    const MAX_TICKS = 4000;                  /* 保险：极端缩放下别把 DOM 画爆 */
    if (unit === '年') {
      const y0 = tp0.anchor.year - mod(tp0.anchor.year, stepYears);
      const yEnd = fromEpoch(cal(), s1, getYearTable()).anchor.year;
      for (let y = y0; y <= yEnd && mainSec.length <= MAX_TICKS; y += stepYears) {
        const s = toEpoch(cal(), timePointOf(y, { month: 1, day: 1 }), getYearTable());
        if (s > s1) break;
        mainSec.push(s);
      }
    } else if (unit === '月') {
      const ord0 = tp0.anchor.year * 12 + (tp0.values.month - 1);
      const tpEnd = fromEpoch(cal(), s1, getYearTable());
      const ordEnd = tpEnd.anchor.year * 12 + (tpEnd.values.month - 1);
      for (let ord = ord0 - mod(ord0, stepMonths); ord <= ordEnd && mainSec.length <= MAX_TICKS; ord += stepMonths) {
        const y = Math.floor(ord / 12);
        const mo = mod(ord, 12) + 1;
        const s = toEpoch(cal(), timePointOf(y, { month: mo, day: 1 }), getYearTable());
        if (s > s1) break;
        mainSec.push(s);
      }
    } else if (unit === '日') {
      const daySpan = stepDays * 86400;
      let s = Math.floor(s0 / daySpan) * daySpan;
      for (let i = 0; s <= s1 && i <= MAX_TICKS; i++) { mainSec.push(s); s += daySpan; }
    } else {
      /* 时/分档的网格就是 stepSec（用户 2026-09-18：「缩放到时和分时会突然变得密集」——
         旧代码这里写死 3600/60，等于无视 stepSec，一小时一根线地铺满屏幕）。 */
      const grid = Math.max(60, stepSec);
      let s = Math.floor(s0 / grid) * grid;
      for (let i = 0; s <= s1 && i <= MAX_TICKS; i++) { mainSec.push(s); s += grid; }
    }
    /* 聚焦时：段间空隙在屏幕上宽度为 0 ⇒ 落在空隙里的刻度要**剔掉**（否则全叠在接缝上）。
       取刻度的成本由「可见宽度 / 主刻度间距」决定（stepSec 随 spacing 走），剔掉不增加成本。 */
    const ticks = warpSegs ? mainSec.filter((s) => inWarpSeg(s / SEC_PER_YEAR)) : mainSec;
    /* 这一帧该有的刻度（按 DOM 顺序：先主刻度、再小刻度/断口 —— 与旧实现的 `html + subHtml` 同序）。
       ⚠️ key **只认身份**（种类|单位|时刻），**不认档位**（2026-09-26 二轮修复：用户实测
       「入场时标尺的文字会闪一下」）。旧 key 里带了 `stepSec`，而缩放每跨过一次档位
       （`quantStep()` 在 1/2/5/10×10^k 之间跳）**每根刻度的 key 就全变** ⇒ 整批判成"换档" ⇒
       走"先出后进"⇒ 旧数字先淡掉 100ms 再淡回来 = 看着是**尺子没动、只有字在闪**
       （线的相位没变，落在原来的位置上）。
       现在换档时"还在的那些刻度"复用同一元素（原地不动、数字不重建）。
       小刻度/断口同理：位置或区间变了就是新元素（取整仍用 `Math.round(s)`）。 */
    const items: { key: string; cls: string; left: number; html: string }[] = [];
    for (let i = 0; i < ticks.length; i++) {
      const s = ticks[i];
      const x = timeToX(s);
      const t = fmtScale(s, unit);
      /* 用历法数值判断是否「整单位边界」：日档=1号、月档=1月，才显示上一级；其他档看上一级变化 */
      const tpNow = fromEpoch(cal(), s, getYearTable());
      const tpPrev = fromEpoch(cal(), s - stepSec, getYearTable());
      let showPrev = false;
      if (unit === '日') showPrev = tpNow.values.day === 1;
      else if (unit === '月') showPrev = tpNow.values.month === 1;
      else if (unit === '时') showPrev = tpNow.values.day !== tpPrev.values.day;   /* 跨天才显示「日」 */
      else if (unit === '分') showPrev = tpNow.values.hour !== tpPrev.values.hour; /* 跨小时才显示「时」 */
      else showPrev = !!(t.prev && tpNow.values.month !== tpPrev.values.month);
      const prev = showPrev ? `<span class="tl__axis-prev">${t.prev}</span>` : '';
      items.push({ key: `M|${unit}|${s}`, cls: 'tl__axis-tick tl__axis-tick--major', left: x, html: `${prev}<span class="tl__axis-label">${t.cur}</span>` });
    }
    if (majorOnly) return items;             /* 邻居网格只要数字（它的线一律隐身） */
    /* 小刻度：在**相邻主刻度之间**等分插（旧代码用 start + k*subStep，年档会累计漂移） */
    for (let i = 0; i + 1 < ticks.length; i++) {
      const a = ticks[i], b = ticks[i + 1];
      /* 接缝：相邻两个主刻度之间只要「压缩轴上的距离 < 真实距离」，就说明中间隔着被截断的区段
         —— 那里既不插小刻度（插出来是假的密度），也不假装连续，画一个断口标记。 */
      if (warpSegs && (year2w(b / SEC_PER_YEAR) - year2w(a / SEC_PER_YEAR)) < (b - a) / SEC_PER_YEAR - 1e-9) {
        items.push({ key: `C|${unit}|${a}|${b}`, cls: 'tl__axis-cut', left: Math.round((timeToX(a) + timeToX(b)) / 2), html: '⋯' });
        continue;
      }
      for (let k = 1; k < subDiv; k++) {
        const s = a + (b - a) * (k / subDiv);
        items.push({ key: `m|${unit}|${Math.round(s)}`, cls: 'tl__axis-tick tl__axis-tick--minor', left: timeToX(s), html: '' });
      }
    }
    return items;
  }

  /* ── 换档的交叉淡化（2026-09-26 第 ⑥ 轮 · 用户「整体文字的出入场」）────────────────────────
     用户规格（原话）：「**把整个缩放尺度当成一个 x 轴，在轴上时，文字的不透明度图像类似于一个正态分布的
     图像（100% 不透明度的占比要长一点），每个文字依照对应的 x 计算当前的不透明度**」；
     并当场拍板选 **A = 交叉淡化**（「新旧两套同时在，各约 50%」）。
     为什么必须是**缩放值的纯函数**、不能再按时间播动画：前面三版都是按时间播（见下面 ④ 那几轮），
     必然长出"同一块地方忽明忽暗"——边缘反复进出、被取消时 opacity 硬跳回 1、淡完删掉又从 0 淡起。
     纯函数没有"开始 / 结束 / 被取消 / 从头再淡一遍"这些状态，缩放连续 ⇒ 不透明度连续。
     · 每套网格（unit + stepSec）在 spacing 轴上有一段"会被 `quantStepAt()` 选中"的区间；
       权重 = 区间中部（`GRID_PLATEAU`）恒 1、两侧按高斯尾巴降到 **0.5** —— 正好落在交接点上。
       交接点上两套各 0.5 ⇒ 加起来 ≈1 ⇒ **不会出现"两边都看不见"的空白**。
     · 只有**数字**在淡：线只留当前档那一套（邻居网格的主刻度线隐身）⇒ 不重演第四十二轮
       「两个重叠的标尺」。
     · 同一 unit 内的相邻网格常常是**嵌套**的（1年 ⊂ 2年）⇒ 同一个 key 会被两套都产出；
       合并时取 **max 权重**、`line` 取**或**（它在当前档里就照旧画线）⇒ 不会重复画。 */
  const GRID_PLATEAU = 0.6;                /* 平台占区间半宽的比例（= 用户要的"100% 的占比长一点"） */
  const GRID_LN2 = Math.LN2;
  const GRID_MIN_W = 0.03;                 /* 权重低于它就不画（尾巴到此已 ≈ 看不见） */
  /* 找邻居网格的采样倍率：网格区间在 spacing 轴上只有 ~1.3~1.5 倍宽，×1.15 一步就跨出去了；
     多取几档是为了"当前档正处在区间中间"时也能摸到两侧邻居（那时邻居权重≈0，会被 GRID_MIN_W 滤掉）。 */
  const GRID_NEIGHBOR_F = [1.15, 1.45, 1.9, 2.6];
  const gridRangeCache = new Map<string, { lo: number; hi: number }>();
  function gridAt(sp: number): { stepSec: number; unit: string } { return quantStepAt(sp); }
  /** 这套网格在 spacing 轴上的有效区间（`quantStepAt` 一直选中它的那一段）。只依赖网格本身，
      所以按 `unit|stepSec` 缓存一辈子。
      ⚠️ `spInside` 必须是**确实落在该网格内**的 spacing（邻居网格是拿 `view.spacing × 倍率` 采到的，
      它当然不在当前 spacing 里）—— 第一版错把「当前 spacing」传进来，于是邻居网格 `same()` 为假 ⇒
      返回 null ⇒ 权重退化成 1（两套都满不透明度 = 第四十二轮那两把尺子又回来了）。
      端点用二分找：先 ×1.1 扩到第一个"不是它"的点，再二分开 30 次（区间宽度只有 1.3~1.5 倍）。 */
  function gridRange(unit: string, stepSec: number, spInside: number): { lo: number; hi: number } | null {
    const key = unit + '|' + stepSec;
    const hit = gridRangeCache.get(key);
    if (hit) return hit;
    const same = (s: number): boolean => { const g = gridAt(s); return g.unit === unit && g.stepSec === stepSec; };
    if (!same(spInside)) return null;        /* 调用方拿错了点（正常不该发生） */
    let inLo = spInside, outLo = spInside, inHi = spInside, outHi = spInside;
    for (let i = 0; i < 80; i++) { const n = inLo / 1.1; if (n < 1e-5) { outLo = 1e-5; break; } if (!same(n)) { outLo = n; break; } inLo = n; }
    for (let i = 0; i < 80; i++) { const n = inHi * 1.1; if (n > 1e10) { outHi = 1e10; break; } if (!same(n)) { outHi = n; break; } inHi = n; }
    if (outLo === spInside) outLo = 1e-5;    /* 一路扩到极限都没换人（顶到缩放上限/下限那一档） */
    if (outHi === spInside) outHi = 1e10;
    for (let i = 0; i < 30; i++) { const m = Math.sqrt(inLo * outLo); if (same(m)) inLo = m; else outLo = m; }
    for (let i = 0; i < 30; i++) { const m = Math.sqrt(inHi * outHi); if (same(m)) inHi = m; else outHi = m; }
    const r = { lo: inLo, hi: inHi };
    gridRangeCache.set(key, r);
    return r;
  }
  /** 这套网格**此刻**该有多不透明（用户要的"正态分布 + 长平台"）：`u` = 当前 spacing 到区间中点的
      距离 ÷ 半宽（在 `log(spacing)` 上量）⇒ 区间内 `u ∈ [0,1]`、交接点上正好 `u = 1`。
      `u ≤ GRID_PLATEAU` 恒 1；之后 `exp(−ln2·((u−p)/(1−p))²)` ⇒ **u=1 处正好 0.5**（与邻档各半）。 */
  function gridWeight(unit: string, stepSec: number, spInside: number, spNow: number): number {
    const r = gridRange(unit, stepSec, spInside);
    if (!r || !(r.hi > r.lo) || !(spNow > 0)) return 1;
    const c = Math.log(Math.sqrt(r.lo * r.hi));
    const h = Math.log(r.hi / r.lo) / 2;
    if (!(h > 0)) return 1;
    const u = Math.abs(Math.log(spNow) - c) / h;
    if (u <= GRID_PLATEAU) return 1;
    const t = (u - GRID_PLATEAU) / (1 - GRID_PLATEAU);
    return Math.exp(-GRID_LN2 * t * t);
  }
  function renderScale() {
    const active = quantStepAt(view.spacing);
    currentScaleUnit = active.unit;          /* 记录当前标尺档位，供指针文字裁剪 */
    /* 候选网格 = 当前这套（永远要有）+ 两侧邻居（按倍率采样，远处权重≈0、会被滤掉）。
       每项都带上"确实落在这套网格里"的那个 spacing（`gridRange` 要用）。 */
    const cand: { unit: string; stepSec: number; inside: number }[] =
      [{ unit: active.unit, stepSec: active.stepSec, inside: view.spacing }];
    const seenGrid = new Set<string>([active.unit + '|' + active.stepSec]);
    for (const f of GRID_NEIGHBOR_F) {
      for (const sp of [view.spacing * f, view.spacing / f]) {
        const g = gridAt(sp);
        const k = g.unit + '|' + g.stepSec;
        if (seenGrid.has(k)) continue;
        seenGrid.add(k);
        cand.push({ unit: g.unit, stepSec: g.stepSec, inside: sp });
      }
    }
    const merged = new Map<string, { key: string; cls: string; left: number; html: string; w: number; line: boolean }>();
    for (const g of cand) {
      const isActive = g.unit === active.unit && g.stepSec === active.stepSec;
      const gw = gridWeight(g.unit, g.stepSec, g.inside, view.spacing);
      if (gw < GRID_MIN_W) continue;
      for (const it of gridItems(g.unit, g.stepSec, !isActive)) {
        const prev = merged.get(it.key);
        if (!prev) { merged.set(it.key, { key: it.key, cls: it.cls, left: it.left, html: it.html, w: gw, line: isActive }); continue; }
        /* 同一个 key 被两套网格都产出（同 unit 内的嵌套网格，如 1年 ⊂ 2年）⇒ 取**并集**
           `1−(1−w₁)(1−w₂)`，不是 max：1980 年在两套里都成立，交接点上两套各 0.5 时它该是 0.75
           而不是 0.5（那个数字并没有"要走了"，不需要变暗）。跨 unit 的交接没有共享 key ⇒ 不受影响。 */
        prev.w = 1 - (1 - prev.w) * (1 - gw);
        if (isActive) prev.line = true;
      }
    }
    /* ⚠️ 必须**按屏幕位置排序**再排 DOM：换档交接点上有两套网格的数字交错，而 map 的插入顺序
       = 候选网格顺序（"每套内部有序、两套前后相接"）⇒ 排出来的 DOM 顺序**不是从左到右**：
       谁按 `querySelectorAll('.tl__axis-tick--major')` 的顺序读，相邻间距就会出现负数、整片错位
       （A/B 实测：`timeline-scale` ★1/★1b/★2 一起 FAIL，`gaps` 里冒出 `-370`）。 */
    paintScale(Array.from(merged.values()).sort((a, b) => a.left - b.left));
  }

  /* ── 标尺刻度的 DOM diff + 文字不透明度（第 ⑤ 片 · **六轮改口**）────────────────────────
     同一处第 6 次改口，前几版别再抄回来：
     ① 09-19 用户：「年月日等刻度的出入场用不透明度和缩放尺度计算」⇒ 09-26 上午做（opacity + scale 挂刻度元素）；
     ② 同日下午用户否掉：「要不标尺动画去了吧，感觉有点，emm不符合我的预期」⇒ 整套撤（commit `2b88813`）；
     ③ 同日用户再要：「标尺上的文字能不能随缩放比例稍微做一点不透明度的出入场」⇒ 只淡文字、按**时间**淡（commit `aff3f45`）；
     ④ 用户看完报：「**有了，但是文字会闪烁**」，并给了新规格：「**把整个缩放尺度当成一个 x 轴，在轴上时，
        文字的不透明度图像类似于一个正态分布的图像（100% 不透明度的占比要长一点），每个文字依照对应的 x
        计算当前的不透明度**」⇒ **动画与"什么时候播"这个判断一并消失**：不透明度成了**位置的纯函数**。
     ⑤ 同日用户接着纠正：「**我的出入场意思其实是整体文字的出入场**，我们现在缩放时文字不是会隐藏其他尺度的
        文字吗，但是文字隐藏和出现是硬切的」⇒ ④ 把"位置"读成了**屏幕位置**（两端变暗），用户要的是
        **缩放轴**上的整体文字：换档（年↔月↔日↔时↔分，以及同一档里 niceStep 的 1/2/5/10 阶梯）时
        一整批数字按**缩放值**交叉淡化（用户当场选 A：新旧两套同时在、各约 50%）——见下面
        `gridWeight()` / `renderScale()` / `GRID_PLATEAU` 那一段。
     ⑥ 屏幕两端那套**留着但减淡**（用户：「留着，但是左右的淡出和淡入强度降一点（100% 不透明度范围加长）」）
        ⇒ `LABEL_PLATEAU` 0.34 → 0.44、尾巴 `exp(−2t²)`（贴边 0.135，不再是 0.018）。两个因子相乘。
     为什么纯函数一上就不闪了：位置/缩放都是连续变的（缓动每帧变一点），纯函数 ⇒ 不透明度也连续变；
     没有「开始播 / 结束 / 被取消 / 再从头淡一遍」这些状态，就没有"同一块地方忽明忽暗"。
     旧版那三种闪（边缘反复进出、被"捞回来"时 opacity 硬跳回 1、淡完删掉再从 0 淡起）全部不存在。
     · 曲线 = **平台 + 高斯尾巴**（用户要的"正态分布、100% 的占比长一点"）：中间 `LABEL_PLATEAU`×2 恒 1，
       两头 `t ∈ [0,1]` 走 `exp(−4t²)`（t=0 处值与斜率都接得上平台 ⇒ 交界无折角；t=1 ⇒ 0.018 ≈ 看不见）。
     · 只写**文字 span**（`.tl__axis-label` / `.tl__axis-prev`）的 opacity，刻度那根线永不参与
       ⇒ 缩放/平移时"尺子"纹丝不动（第四十二轮「两个重叠的标尺」那条教训）。
     · 走掉的刻度：**当场摘**。它在锥形里本来就已经淡到 ≈0，摘掉看不出来，也没有淡出可等。
     ⚠️ DOM diff / 元素复用必须留着 —— 它跟"播不播动画"是两件事，而且是「整条标尺重画」那个闪的解药
     （旧写法一句 `scaleEl.innerHTML = html + subHtml` 每帧重建 180 来个元素、对象全换）。 */
  const scaleTicks = new Map<string, HTMLElement>();
  /** 平台半宽（占标尺宽度的比例）：中间 2×0.44 = **88% 恒 100% 不透明**。
      2026-09-26 用户看过第一版（平台 0.34 / 尾巴 `exp(−4t²)`，贴边只剩 0.018）之后的要求：
      「**留着，但是左右的淡出和淡入强度降一点（100% 不透明度范围加长）**」⇒ 平台 0.44、尾巴 `exp(−2t²)`。 */
  const LABEL_PLATEAU = 0.44;
  const LABEL_EDGE_MIN = Math.exp(-2);   /* ≈ 0.135：贴到标尺两端那一档的透明度 */
  /** 文字按**屏幕位置**算出的不透明度：`x` = 刻度在标尺上的 px，`w` = 标尺宽度。
      纯函数、无状态、无动画；在 `paintScale` 里与「换档权重」**相乘**。 */
  function labelWindow(x: number, w: number): number {
    if (!(w > 0)) return 1;
    const half = w / 2;
    const plateau = half * LABEL_PLATEAU;
    const t = (Math.abs(x - half) - plateau) / Math.max(1, half - plateau);
    if (t <= 0) return 1;
    if (t >= 1) return LABEL_EDGE_MIN;   /* 贴到边缘：钉住下限，免得边界上忽明忽暗 */
    return Math.exp(-2 * t * t);
  }
  /** 每根刻度自己的文字 span（创建 / 重写 html 时记账）——每帧只写 opacity，**不做 DOM 查询**
      （仓库对每帧查询量敏感，见 `tools/e2e/causes-line.cjs` ★3 那条上限）。 */
  const scaleLabels = new WeakMap<HTMLElement, HTMLElement[]>();
  const rememberLabels = (el: HTMLElement): void => {
    scaleLabels.set(el, Array.from(el.querySelectorAll<HTMLElement>('.tl__axis-label, .tl__axis-prev')));
  };
  /** 每根刻度**上一次写进去的 html**：复用的元素在换档后「上一级」那截文字可能不再是同一个
      （时/分档的 `showPrev` 是拿 `s - stepSec` 比的）⇒ 内容真的变了才重写，
      逐帧 `innerHTML =` 就又变回"整条标尺重画"了。 */
  const scaleHtml = new WeakMap<HTMLElement, string>();
  function paintScale(items: { key: string; cls: string; left: number; html: string; w: number; line: boolean }[]): void {
    const els: HTMLElement[] = [];
    const seen = new Set<string>();
    /* 标尺宽度（平台与锥形都按它算）：一个元素一次 layout 读，别放进循环。 */
    const w = scaleEl.clientWidth;
    for (const it of items) {
      seen.add(it.key);
      let el = scaleTicks.get(it.key);
      if (!el) {
        el = document.createElement('div');
        el.className = it.cls;
        el.innerHTML = it.html;
        rememberLabels(el);
        scaleTicks.set(it.key, el);
      } else if (scaleHtml.get(el) !== it.html) {
        /* 内容真变了才重写（换档后"上一级"那截可能不是同一个）；逐帧 `innerHTML =` 就又变回"整条标尺重画"。
           ⚠️ 重写后必须重新记账 —— 旧的 span 已经被抹掉了。 */
        el.innerHTML = it.html;
        rememberLabels(el);
      }
      scaleHtml.set(el, it.html);
      el.style.left = `${it.left}px`;
      /* 邻居网格的主刻度：线隐身（只有数字在淡）⇒ 屏上永远只有一把尺子的线。 */
      el.classList.toggle('tl__axis-tick--ghost', !it.line);
      /* 文字不透明度 = **换档权重（缩放值的纯函数）** × **位置的锥形**（屏幕两端渐隐，用户要的"弱一点"）。
         这里**没有动画、没有过渡**：两个因子都是连续量的纯函数 ⇒ 不会闪。
         小刻度 / 断口没有文字，一次 DOM 查询都不做。 */
      const labels = scaleLabels.get(el);
      if (labels && labels.length) {
        const op = labelWindow(it.left, w) * it.w;
        for (const s of labels) s.style.opacity = op >= 0.999 ? '' : op.toFixed(3);
      }
      els.push(el);
    }
    /* 顺序：刻度必须从左到右排（测试读 `querySelectorAll` 的顺序、以及 z 序都依赖它）。
       ⚠️ 只比**活元素之间的相对顺序**（账本里已经没有"退场中"的元素了）。 */
    const live = new Set<Element>(els);
    let prevLive: Element | null = null;
    for (const el of els) {
      let n: ChildNode | null = prevLive ? prevLive.nextSibling : scaleEl.firstChild;
      while (n && !live.has(n as Element)) n = n.nextSibling;
      if (n !== el) scaleEl.insertBefore(el, n);
      prevLive = el;
    }
    /* 走掉的：**当场摘**（DOM 与账本一一对应 ⇒ 屏上任何时刻只有一把尺子）。
       它的 x 已经落在两端的锥形里、文字本来就只有 0.018 ⇒ 摘掉看不出来，也没有淡出可等。 */
    for (const [key, el] of Array.from(scaleTicks)) {
      if (seen.has(key)) continue;
      scaleTicks.delete(key);
      el.remove();
    }
  }
  /** 整块清空（无时间线 / 重挂载那种"这一版标尺作废"的路径）。
      ⚠️ 账本必须一起清：元素被 `innerHTML` 抹掉了、账本还记着的话，下一帧就会往
      一个**脱离文档**的元素上写 left，屏幕上的标尺会缺一截。退场账本同理（它攒的是脱离文档的元素）。 */
  function clearScale(): void {
    scaleTicks.clear();
    scaleEl.innerHTML = '';
  }

  /* ── 渲染节点 ── */
  let selectedId: string | null = null;
  function renderBase() {
    const tl = timeline();
    if (!tl) {
      track.innerHTML = '<div style="padding:20px;font-size:var(--text-sm);color:var(--fg-2);">无时间线 · 待建</div>';
      clearScale();
      return;
    }
    const nodes = tl.nodes;
    const lineHtml = '<div class="tl-line"></div>';   /* 时间线常驻贯穿（无限画布） */
    track.innerHTML =
      lineHtml +
      nodes
        .map((n) => nodeHtml(n, timeToX(nodeEpoch(n)), n.id === selectedId))
        .join('');
    renderScale();
    updateCursor();
  }

  /* 因果线：从发起节点(n) 指向目标 cause(c)（用户在本节点添加 -> 箭头从本节点出发指向所选节点）。
     端点取 .cap 圆点的**真实外缘**、垂直取圆点中心；坐标基准取 SVG 自身 rect（它带 top:34px 偏移）。
     旧实现用 wrapRect + 手调常数（-26 / -5）会让端点恒偏低 3px、并向内多缩 5px 钻进圆点里，
     相邻节点只差十几 px 时会读成"连到了旁边那个点"。
     箭头大小/线宽/不透明度随节点间距联动（缩小→变小变淡，避免挤在一起回旋/看不清） */
  /* ── 因果线的 DOM 道具池（第 ④ 片）──────────────────────────────────────────
     用户 2026-09-26 报「缩放时标尺有轻微卡顿，而且渲染出的因果线会跳位置」。
     卡顿的那一半：旧写法每帧 `causesSvg.innerHTML = defs + 294 条 path`（294 个 marker 全新建、
     HTML 重新解析），外加每条边各查一次 `track.querySelector('[data-id=…]')`
     —— 294 边 × 2 = 588 次、每次都扫 track 的 150 个子元素（加压夹具实测 ~800 次/帧，
     单次缩放 3 格 58,950 次 ≈ 631ms；150 节点时帧间隔 p95 20.9ms / 12/107 帧 > 20ms）。
     现在 `<path>` / `<marker>` 都按**序号**常驻复用，只写变化的属性。 */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  let causeDefs: SVGDefsElement | null = null;
  const causeMarkers: { m: SVGMarkerElement; arrow: SVGPathElement }[] = [];
  const causePaths: SVGPathElement[] = [];
  type CauseCenter = { x: number; y: number; r: number };
  /* 第 i 条弧线的箭头 marker（懒建，建好就一直用同一个元素） */
  function causeMarkerSlot(i: number): { m: SVGMarkerElement; arrow: SVGPathElement } {
    let slot = causeMarkers[i];
    if (!slot) {
      if (!causeDefs) {
        causeDefs = document.createElementNS(SVG_NS, 'defs') as SVGDefsElement;
        causesSvg.appendChild(causeDefs);
      }
      const m = document.createElementNS(SVG_NS, 'marker') as SVGMarkerElement;
      m.setAttribute('id', 'lk-ca-' + i);
      m.setAttribute('orient', 'auto');
      const arrow = document.createElementNS(SVG_NS, 'path') as SVGPathElement;
      arrow.setAttribute('fill', 'var(--fg)');
      m.appendChild(arrow);
      causeDefs.appendChild(m);
      slot = { m, arrow };
      causeMarkers[i] = slot;
    }
    return slot;
  }
  /* 第 i 条弧线的 path（同样懒建复用） */
  function causePath(i: number): SVGPathElement {
    let p = causePaths[i];
    if (!p) {
      p = document.createElementNS(SVG_NS, 'path') as SVGPathElement;
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'var(--fg)');
      p.setAttribute('marker-end', `url(#lk-ca-${i})`);
      causesSvg.appendChild(p);
      causePaths[i] = p;
    }
    return p;
  }
  function drawCauses() {
    const tl = timeline();
    const byId = new Map<string, TimelineNode>((tl?.nodes ?? []).map((n) => [n.id, n]));
    let idx = 0;
    /* 弧线形状系数：末端切线角度 = atan(CURVE_DY / CURVE_DX) ≈ 32°，与跨距无关，
       也是端点贴圆点边缘时用的到达角（两者必须同源，否则贴边方向与弧线切线不连续） */
    const CURVE_DX = 0.4, CURVE_DY = 0.25;
    const RIM_ANGLE = Math.atan2(CURVE_DY, CURVE_DX);
    const cth = Math.cos(RIM_ANGLE), sth = Math.sin(RIM_ANGLE);
    const svgRect = causesSvg.getBoundingClientRect();
    /* 圆心表：每帧**一次**集体查询 + 每个圆点只读一次 rect（旧写法每条边各查各的），
       而且只查**真的有因果线**的节点 —— 孤点不读 rect、不逼布局。 */
    const centers = new Map<string, CauseCenter>();
    const needIds = new Set<string>();
    for (const n of tl?.nodes ?? []) {
      for (const cid of n.causes ?? []) {
        if (!byId.has(cid)) continue;
        needIds.add(n.id);
        needIds.add(cid);
      }
    }
    if (needIds.size) {
      track.querySelectorAll('[data-id]').forEach((el) => {
        const id = (el as HTMLElement).dataset.id ?? '';
        if (!needIds.has(id)) return;
        const dot = (el.querySelector('.cap') as HTMLElement | null) ?? (el as HTMLElement);
        const r = dot.getBoundingClientRect();
        centers.set(id, { x: r.left + r.width / 2 - svgRect.left, y: r.top + r.height / 2 - svgRect.top, r: r.width / 2 });
      });
    }
    for (const n of tl?.nodes ?? []) {
      const a = centers.get(n.id);
      if (!a) continue;
      for (const cid of n.causes ?? []) {
        const b = centers.get(cid);
        if (!b) continue;
        const dir = b.x >= a.x ? 1 : -1;
        /* 端点落在圆点边缘、且**沿弧线自身的到达方向**（θ≈32°），而不是取水平极点：
           两个节点都落在轴线上，取水平极点会让尖端正好压在轴线上，看起来"连在线上"而不是
           连在节点上。沿切线方向贴边后，尖端落在圆周上、比圆心高 r·sinθ，明显离开轴线。
           ⚠️ 两圆点靠近到"贴边量互相越过"时**不许硬切**（旧式 `if ((x2 - x1) * dir <= 0)` 分支）：
           实测 Δx=10.6px 时尖端落在圆心（dy 0 / dx -2）、11.9px 时**一帧内**跳到圆周
           （dy 3.71 / dx -5.93）—— 横跳 3.9px + 竖跳 3.7px，而节点自身只动了 1.09px，
           缩放时看着就是「因果线跳位置」；完全重合时端点还会反向（箭头指向自己）。
           改成按「还差多少才够贴边」连续收缩：k = gap / need 从 1 收到 0 ⇒ 尖端沿切线方向
           连续滑向两圆的接触点，弧线随之缩成一点、`op` 乘 k 淡出 —— 任何一帧的位移都不超过
           节点自身的位移。k = 1 时与原来的贴边几何**逐字等价**（gap ≥ need ⇒ seg = gap − need）。 */
        const gap = Math.abs(b.x - a.x);
        const need = (a.r + b.r) * cth;
        const k = need > 0 ? Math.min(1, gap / need) : 1;
        const x1 = a.x + dir * a.r * cth * k, y1 = a.y - a.r * sth * k;
        const x2 = b.x - dir * b.r * cth * k, y2 = b.y - b.r * sth * k;
        const seg = Math.abs(x2 - x1);
        /* 控制点随间距缩放：cdx < seg/2 不回旋。cdy 按跨距成比例（于是末端切线角度
           = cdy/cdx = RIM_ANGLE 恒定），端点因此始终以可见角度接近圆点——旧版把 cdy clamp 在
           绝对值 26px，跨距 >104px 后弧高就固定不变，缩放越大弧线越平、末端贴着轴线滑过去，
           看起来像没接到点上。上限取画布高度一半，避免跨距极大时弧线冲出画布 */
        const cdx = seg * CURVE_DX, cdy = Math.min(seg * CURVE_DY, track.clientHeight * 0.5);
        /* 联动：箭头/线宽/不透明度随间距（`op` 再乘 k ⇒ 两圆点重合的极端情况下自然消隐，
           不会留下一条零长度、方向未定义的反向箭头） */
        const mSize = Math.max(3, Math.min(6, seg * 0.04));      /* 箭头大小（调细为 1/3） */
        const width = Math.max(0.8, Math.min(1.6, seg * 0.006));  /* 线宽（更细） */
        const op = Math.max(0.35, Math.min(0.9, seg / 130)) * k;
        /* 第 idx 条弧线：marker / path 都按序号复用，只写变化的属性
           （旧写法这里每帧新建 294 个 marker + 294 条 path，还要重新解析一遍 HTML） */
        const slot = causeMarkerSlot(idx);
        const p = causePath(idx);
        slot.m.setAttribute('markerWidth', String(mSize));
        slot.m.setAttribute('markerHeight', String(mSize));
        slot.m.setAttribute('refX', String(mSize - 2));
        slot.m.setAttribute('refY', String(mSize / 2));
        slot.arrow.setAttribute('d', `M0,1 L${mSize - 1},${mSize / 2} L0,${mSize - 1} z`);
        p.setAttribute('d', `M ${x1} ${y1} C ${x1 + dir * cdx} ${y1 - cdy}, ${x2 - dir * cdx} ${y2 - cdy}, ${x2} ${y2}`);
        p.setAttribute('stroke-width', String(width));
        p.setAttribute('opacity', String(op));
        if (p.style.display) p.style.display = '';
        idx++;
      }
    }
    /* 这一帧用不到的弧线（图变小 / 换世界 / 没时间线 / 在聚焦线外）：藏掉，**不删** ——
       元素留在池子里下次复用。 */
    for (let i = idx; i < causePaths.length; i++) causePaths[i].style.display = 'none';
  }

  let render: () => void = renderBase;   /* 可被剧情线/循环包装重赋 */

  /* 节点 HTML（legacy 结构：.tl__n + .cap + .tl__name） */
  function nodeHtml(n: TimelineNode, x: number, sel: boolean): string {
    const typeCls = n.type === 'story_event' ? ' is-story' : n.type === 'world_event' ? ' is-world' : '';
    return `<div class="tl__n${sel ? ' is-sel' : ''}${typeCls}" data-id="${n.id}" style="left:${x}px;">
      <div class="cap"></div><div class="tl__name">${escapeHtml(n.title)}</div>
    </div>`;
  }
  function updateCursor() {
    const ws = currentWorld(store);
    let t = ws.timeCursor;
    /* 常显：未设置/被清空时，记住最近一次有效值（不跳回最早节点 316），指针落在稳定位置 */
    if (t === null || t === undefined) {
      t = lastCursorT;
    } else {
      lastCursorT = t;
    }
    cursorEl.style.display = '';
    cursorEl.style.left = timeToX(t) + 'px';
    /* t 是 epoch 秒：直接 fromEpoch 反推显示（不再当"年"换算，避免 O(巨大年份) 累加卡死） */
    cursorTimeEl.textContent = epochText(t, currentScaleUnit);
    /* 未发生节点淡化 */
    track.querySelectorAll('.tl__n').forEach((el) => {
      const n = (el as HTMLElement).dataset.id;
      const node = timeline()?.nodes.find((x) => x.id === n);
      if (node) (el as HTMLElement).style.opacity = nodeEpoch(node) > t ? '0.4' : '';   /* 都用 epoch 秒比较 */
    });
  }

  /* ── fit 视图（缩放适配全部节点）── */
  function fitAll() {
    const tl = timeline();
    if (!tl || !tl.nodes.length) { view.panX = 0; view.spacing = 2; targetView.panX = 0; targetView.spacing = 2; return; }
    /* 先按节点原始年份范围建历法年表，让 nodeEpoch/fromEpoch 走 O(1)，避免 O(年数) 累加卡顿 */
    const ys = tl.nodes.map((n) => n.year ?? 0);
    const yLo = Math.min(...ys), yHi = Math.max(...ys);
    setYearTable(yLo - 50, yHi + 50);
    /* 聚焦时只 fit **线内**节点，而且跨度要在**压缩轴**上量 —— 线外的年份在屏幕上已被压掉，
       拿真实年份算出来的 spacing 会让两段挤在左边一小撮。 */
    rebuildWarp();
    const fitNodes = storyMode === 'focus' && activeLine() ? tl.nodes.filter((n) => inLine(n.year)) : tl.nodes;
    const epochs = (fitNodes.length ? fitNodes : tl.nodes).map((n) => nodeEpoch(n));   /* 节点 epoch 秒（用 O(1) table） */
    const loE = Math.min(...epochs), hiE = Math.max(...epochs);
    const lo = year2w(loE / SEC_PER_YEAR), hi = year2w(hiE / SEC_PER_YEAR);  /* 压缩轴上的年 */
    const span = Math.max(1, hi - lo);
    targetView.spacing = Math.min(40, Math.max(0.05, (wrap.clientWidth - 120) / span));
    targetView.panX = 40 - lo * targetView.spacing;
    kickEase();
    render();
  }

  /* ── 交互状态 ── */
  let spaceDown = false;
  let dragging = false;        // 空格平移
  let lastX = 0;
  let cursorDrag = false;      // 空白拖动指针
  let lastCursorT = 0;         // 记住最近一次有效时间指针位置（timeCursor 被清空时兜底，不跳回最早节点）
  let currentScaleUnit = '年';  // 当前标尺档位（renderScale 更新，updateCursor 用它裁剪指针文字）
  let nodeDragId: string | null = null;
  let nodeDragMoved = false;
  /* 本次拖动是否已经压过「拖动前」的撤销快照（见 pointermove 里那段注释） */
  let nodeDragSnapshotted = false;

  wrap.addEventListener('pointerdown', (e) => {
    /* 只响应左键：pointerdown 对任意按键都触发，不判断的话
       右键按住节点轻微一拖就会逐帧改写年份（并落盘），而右键菜单照样弹出；
       空白处右键也会顺带把时间指针挪到点击位置。 */
    if (e.button !== 0) return;
    if (typeof brushing !== 'undefined' && brushing) return;   /* 笔刷模式：交给笔刷分支 */
    wrap.style.cursor = 'grabbing';           /* 任何拖动都变抓手（endDrag 复原） */
    const nodeEl = (e.target as HTMLElement).closest('.tl__n') as HTMLElement | null;
    if (nodeEl) {
      /* 节点：点击选中 / 拖动改时间 */
      nodeDragId = nodeEl.dataset.id ?? null;
      nodeDragMoved = false;
      nodeDragSnapshotted = false;
      lastX = e.clientX;
      return;
    }
    if (spaceDown) {
      dragging = true;
      lastX = e.clientX;
      wrap.style.cursor = 'grabbing';
      return;
    }
    cursorDrag = true;
    const rect = wrap.getBoundingClientRect();
    setTimeCursor(store, xToTime(e.clientX - rect.left));
  });
  window.addEventListener('pointermove', (e) => {
    /* 指针键已经松了却没收到 pointerup（指针取消 / 在窗口外松手 / 切窗）：
       先结算拖动。旧实现只在 pointerup 里清状态，一次丢失的 pointerup 就让节点
       永远跟着鼠标走，而且每帧都把 n.year 写回盘（saveNodeDoc）。 */
    if (e.buttons === 0) {
      if (nodeDragId || dragging || cursorDrag) endDrag();
      return;
    }
    const rect = wrap.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    if (nodeDragId) {
      if (Math.abs(e.clientX - lastX) > 2) nodeDragMoved = true;
      if (nodeDragMoved) {
        const tl = timeline();
        const n = tl?.nodes.find((x) => x.id === nodeDragId);
        if (n) {
          const e = xToTime(mx);                       /* 鼠标位置 → epoch 秒 */
          const yr = fromEpoch(cal(), e, getYearTable()).anchor.year;   /* 反推存年（精确到年）；拖动热路径必须带年表，否则 O(年数) */
          /* ★ 拖动前先压一次撤销快照（整个拖动只压一次）。
             拖动为了跟手，是**直接改 store.data 里的活引用** n.year，逐帧再
             saveNodeDoc({undo:false}) 只负责通知+落盘。若等 pointerup 再提交，
             store.update 的快照拍到的就是「已经改过」的数据 → Ctrl+Z 是空操作
             ——map.ts 曾踩过同一个坑（save() 里 map 就是 ws.maps[0]）。
             所以在这里空提交一次，把「拖动前」定格进撤销栈；
             年份真的变了才压，微动 2px 往往还是同一年，不该留一个空撤销格。
             效果：Ctrl+Z 只回退这一次拖动，不再连上一个无关操作一起回滚
             （用户反馈的「撤销一次，两处都变了」）。 */
          if (yr !== n.year && !nodeDragSnapshotted) {
            nodeDragSnapshotted = true;
            store.update(() => {});
          }
          n.year = yr;
          render();
          saveNodeDoc(store, tl!.id, n.id, n.doc ?? '', { undo: false, keepRedo: true });   // 拖动中间态不进撤销；是否作废重做由本次拖动那一次提交决定
        }
      }
      return;
    }
    if (dragging) {
      zoomHold = null;                     /* 手动拖动平移：解除缩放锚点 */
      if (nonlinearMode) {
        nlPan += e.clientX - lastX;     /* 非线性有自己那套游标（见滚轮那段注释） */
      } else {
        view.panX += e.clientX - lastX;
        targetView.panX = view.panX;    /* 拖动 = 1:1，不给缓动插队 */
      }
      lastX = e.clientX;
      render();
      return;
    }
    if (cursorDrag) {
      setTimeCursor(store, xToTime(mx));
    }
  });
  /* 统一结算拖动：pointerup / pointercancel / 窗口失焦 都走这里 */
  function endDrag(): void {
    nodeDragId = null;
    nodeDragMoved = false;
    nodeDragSnapshotted = false;
    dragging = false;
    cursorDrag = false;
    /* 吸管模式下光标是 copy，不要一律打回 default */
    wrap.style.cursor = wrap.classList.contains('lk-eyedrop') ? 'copy' : 'default';
    wrap.style.cursor = 'grab';           /* 拖动结束复原（eyedrop 会再覆盖成 copy） */
  }
  window.addEventListener('pointerup', () => {
    const wasNodeClick = nodeDragId && !nodeDragMoved;
    if (wasNodeClick && nodeDragId) {
      const n = timeline()?.nodes.find((x) => x.id === nodeDragId);
      if (isEyedropActive()) {
        if (n) pick(n.id);   /* 吸管：把点中的节点 id 交给调用方 */
      } else if (n) {
        selectedId = n.id;
        render();
        if (onSelect) onSelect(n);
      }
    }
    endDrag();
  });
  /* pointercancel：指针被系统接管（触控手势 / 拖出窗口 / 浏览器抢走）——之后不会再有 pointerup */
  window.addEventListener('pointercancel', endDrag);
  window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !spaceDown) spaceDown = true; });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });
  window.addEventListener('blur', () => { spaceDown = false; endDrag(); });

  /* 滚轮：普通=左右平移（横向滚动），Alt=缩放（照抄 legacy scrollPan） */
  wrap.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      /* 非线性模式有**自己的一套**视图游标（nlPan/nlZoom）：那一支的 x 是序列序、与时间无关，
         复用 view.panX/spacing 会让两种模式互相踩（切回线性时整条时间线被推到天边）。
         旧行为是这一支根本不响应滚轮 ⇒ 节点看起来"钉在屏幕上"。 */
      if (nonlinearMode) {
        if (e.altKey) {
          const rect = wrap.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const before = (mx - 50 - nlPan) / nlZoom;                 /* 鼠标下的"缩放前坐标" */
          nlZoom = Math.min(8, Math.max(0.2, nlZoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
          nlPan = mx - 50 - before * nlZoom;                          /* 把那一点钉在原地 */
        } else {
          /* 平移只认一个轴（Shift+滚轮时 Chromium 把量塞进 deltaX）—— 与下面线性分支同一规则 */
          nlPan -= e.deltaX !== 0 ? e.deltaX : e.deltaY;
        }
        render();
        return;
      }
      if (e.altKey) {
        const rect = wrap.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
        const next = Math.min(1e8, Math.max(0.05, targetView.spacing * factor));
        /* 锚点时间要用**目标视图**算（用当前视图算的话，连滚几格会拿还在动画中的位置当锚点 ⇒ 横移） */
        const tAtSec = (mx - 40 - targetView.panX) / targetView.spacing * SEC_PER_YEAR;
        targetView.spacing = next;
        targetView.panX = mx - 40 - (tAtSec / SEC_PER_YEAR) * next;
        zoomHold = { x: mx, t: tAtSec };
      } else {
        zoomHold = null;                       /* 一旦开始平移，锚点就不管了 */
        /* 平移只认**一个轴**：Shift+滚轮时 Chromium 把量塞进 deltaX（deltaY 可能同时非 0），
           两个都减 = 一次滚动走两倍 ⇒ 用户实测「shift 滚轮横移时有时候会突然跳一下」。 */
        const d = e.deltaX !== 0 ? e.deltaX : e.deltaY;
        targetView.panX -= d;
      }
      kickEase();
    },
    { passive: false }
  );
  wrap.style.cursor = 'grab';               /* 画布默认抓手（拖动时变 grabbing） */
  wrap.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('.tl__n')) return;
    if (nonlinearMode) { nlPan = 0; nlZoom = 1; render(); return; }   /* 非线性：双击＝回到"刚好铺满" */
    fitAll();
  });
  /* 吸管模式提示：激活时 wrap 加类 + 光标变 copy */
  window.addEventListener('lk-eyedrop-active', ((e: Event) => {
    const on = !!(e as CustomEvent<boolean>).detail;
    wrap.classList.toggle('lk-eyedrop', on);
    wrap.style.cursor = on ? 'copy' : 'grab';
  }) as EventListener);

  /* 指针手柄拖动 */
  const handle = cursorEl.querySelector('.tl-cursor-handle') as HTMLElement;
  let handleDrag = false;
  handle.addEventListener('pointerdown', (e) => {
    if (cursorEl.style.display === 'none') return;   /* 仅真正隐藏时不能拖；常显('')可拖 */
    handleDrag = true;
    e.stopPropagation();
  });
  window.addEventListener('pointermove', (e) => {
    if (!handleDrag) return;
    if (e.buttons === 0) { handleDrag = false; return; }   /* 丢失 pointerup 时兜底 */
    const rect = wrap.getBoundingClientRect();
    setTimeCursor(store, xToTime(e.clientX - rect.left));
  });
  window.addEventListener('pointerup', () => { handleDrag = false; });
  window.addEventListener('pointercancel', () => { handleDrag = false; });

  store.subscribe(() => render());
  render();
  requestAnimationFrame(() => fitAll());

  /* ══════════ 剧情线（笔刷创建 / 多段 / 聚焦过滤 / 遮罩）══════════ */
  const TL_HEAD = document.getElementById('lk-pane-timeline')?.querySelector('.lk-pane-head') as HTMLElement | null;
  if (!TL_HEAD) return;

  let storyMode: 'focus' | 'full' = 'focus';        // 默认聚焦剧情线
  let activeLineId: string | null = null;            // 聚焦的剧情线；**null = 世界历史（不聚焦）**
  /* 用户是否**显式**动过这个下拉（含选中「— 世界历史 —」）。
     没有它就没法把「用户选了世界历史」和「还没选过」区分开 —— 详见 renderStoryUI 里的注释。 */
  let linePinned = false;
  let brushing = false;                              // 笔刷模式
  let pendingSegs: { start: number; end: number | null }[] = [];  // 累积段（**年**，与 segments/inLine 同一语义）
  let newLinePanelOpen = false;   // 右侧面板此刻是不是「新建剧情线」（它是待创建状态，不是 store 里的线）
  let newLineName = '';           // 那条待创建线的名字
  const brushSel = document.createElement('div');
  brushSel.style.cssText =
    'position:absolute;top:34px;bottom:0;z-index:4;pointer-events:none;background:rgba(158,194,98,.10);border:1px solid rgba(158,194,98,.55);display:none;';
  wrap.appendChild(brushSel);

  /* 开放段（end === null）延伸到的上限：取最大节点年；没有节点时退回段起点 */
  function openEndYear(fallback: number): number {
    const ys = (timeline()?.nodes ?? []).map((n) => n.year ?? 0);
    return ys.length ? Math.max(...ys) : fallback;
  }

  function linesOf(): Storyline[] {
    const tl = timeline();
    const arr = tl && Array.isArray(tl.storylines) ? tl.storylines : [];
    /* 单条线也要补 segments（legacy 数据可能是 startYear/endYear 或 nodeIds 形态）。
       缺 segments 时 inLine() 会抛 TypeError，而 render() 每次 store 更新都会走到那里
       → 整个沙盘从此不再刷新。这里统一补成空数组，线仍可见、可继续编辑。 */
    return arr.map((l) => ({ ...l, segments: Array.isArray(l.segments) ? l.segments : [] }));
  }
  function activeLine(): Storyline | undefined {
    return linesOf().find((l) => l.id === activeLineId);
  }
  function inLine(t: number): boolean {
    const ln = activeLine();
    if (!ln) return false;
    return ln.segments.some((s) => (s.end === null || s.end === undefined ? t >= s.start : t >= s.start && t <= s.end));
  }

  /* ══════════ 分段映射（第 4.0 片 C）：聚焦时把段间的空隙从时间轴上压掉 ══════════
     用户 2026-09-19：「我想要的剧情线其实是**剧情线之外的内容（包括时间线）全部截断**，
     如果剧情线之间是多段时间则**连接两段时间**（剔除中间的节点和时间线）」。
     做法：真实年 ↔ **压缩年** 一层单调映射 —— 每段按原长度保留、段间空隙长度归零，
     段内相对位置与段的先后都不变。`timeToX / xToTime` 是时间与屏幕之间的**唯一**通道
     （节点、标尺、指针、色带、点击/拖动、滚轮缩放锚点全走它们）⇒ 底座接在这里，
     上层一个都不用改；段外节点早就在 `render` 包装器里按 `inLine()` 过滤掉了。
     ⚠️ 与 `docs/ROADMAP.md` 的「非线性模式：节点间时间插值（默认关）」共用这一层：
     那边是再叠一层段内映射，两者都改 `year2w/w2year` 这一对出入口。 */

  /** 重算压缩轴。段是**年**为单位（0.1 精度）；`end === null` = 开放段，延伸到最大节点年。
   *  重叠/乱序的段先排序再合并，保证映射单调（段内不可能出现负长度）。 */
  function rebuildWarp(): void {
    if (!warpReady || storyMode !== 'focus') { warpSegs = null; warpTotal = 0; return; }
    const ln = activeLine();
    const segs = (ln?.segments ?? [])
      .map((s) => {
        const a = Number(s.start);
        const b = s.end === null || s.end === undefined ? openEndYear(a) : Number(s.end);
        return { a: Math.min(a, b), b: Math.max(a, b) };
      })
      .filter((s) => Number.isFinite(s.a) && Number.isFinite(s.b) && s.b > s.a)
      .sort((x, y) => x.a - y.a);
    const merged: { a: number; b: number }[] = [];
    for (const s of segs) {
      const last = merged[merged.length - 1];
      if (last && s.a <= last.b) last.b = Math.max(last.b, s.b);   /* 重叠/相接 ⇒ 并成一段 */
      else merged.push({ ...s });
    }
    let cum = 0;
    warpSegs = merged.map((m) => { const o = { a: m.a, b: m.b, base: cum }; cum += m.b - m.a; return o; });
    if (!warpSegs.length) warpSegs = null;
    warpTotal = cum;
  }

  /** 真实年 → 压缩年（单调不减）。空隙里的年份一律落到接缝上（段尾）。 */
  function year2w(y: number): number {
    const segs = warpSegs;
    if (!segs) return y;
    const first = segs[0], last = segs[segs.length - 1];
    if (y <= first.a) return y - first.a;                     /* 第一段之前：保持与段首的距离 */
    if (y >= last.b) return last.base + (last.b - last.a) + (y - last.b);   /* 最后一段之后：不压缩 */
    for (const s of segs) {
      if (y <= s.b) return y >= s.a ? s.base + (y - s.a) : s.base;   /* 段内按原长；空隙贴到接缝 */
    }
    return warpTotal;
  }

  /** 压缩年 → 真实年（year2w 的逆；段外同样线性延续） */
  function w2year(w: number): number {
    const segs = warpSegs;
    if (!segs) return w;
    const first = segs[0], last = segs[segs.length - 1];
    if (w <= first.base) return w + first.a;
    const lastW = last.base + (last.b - last.a);
    if (w >= lastW) return last.b + (w - lastW);
    for (const s of segs) {
      const end = s.base + (s.b - s.a);
      if (w <= end) return s.a + (w - s.base);
    }
    return lastW;
  }

  /** 这个**真实年**在不在（压缩后真正可见的）某一段里。全览时恒真。 */
  function inWarpSeg(y: number): boolean {
    const segs = warpSegs;
    if (!segs) return true;
    return segs.some((s) => y >= s.a - 1e-9 && y <= s.b + 1e-9);
  }

  function renderStoryUI() {
    if (!TL_HEAD) return;
    const lines = linesOf();
    /* 只在「用户还没选过」或「聚焦的那条线已经不存在了」时，才自动落到第一条线。
       ⚠️ 不能写成 `activeLineId || lines[0]?.id` —— `null` 是用户**显式选的「— 世界历史 —」**，
       那样写等于每次重画都把它打回剧情线：用户 2026-09-13 报的「从剧情线切到世界历史，
       一动指针就跳回剧情线」就是这么来的（下拉的 change 处理器里紧接着的那次 renderStoryUI()
       当场就把选择改回去了，指针都不用动）。 */
    const ids = new Set(lines.map((l) => l.id));
    /* ⭐ 默认**全览**（用户 2026-09-19：「我希望默认打开灵框时是全览」）：以前这里会自动落到
       第一条剧情线 ⇒ 一进沙盘就是聚焦态（线外内容被截断）。现在**不自动聚焦** ——
       只有用户自己在下拉里选了哪条线才聚焦；聚焦的那条被删掉也退回全览。 */
    if (!linePinned || (activeLineId !== null && !ids.has(activeLineId))) {
      activeLineId = null;
    }
    linePinned = true;   /* 走过一次就当作"已初始化"，之后世界历史/空世界都保持用户的选择 */
    const lineOpts = lines
      .map((l) => `<option value="${escapeHtml(l.id)}"${l.id === activeLineId ? ' selected' : ''}>${escapeHtml(l.name)}</option>`)
      .join('');
    const existing = TL_HEAD.querySelector('#lk-story-ui');
    if (existing) existing.remove();
    const ui = document.createElement('span');
    ui.id = 'lk-story-ui';
    ui.style.cssText = 'display:flex;gap:4px;align-items:center;flex-shrink:0;';
    /* 状态区（第 4.0 片 A 步）：**你正在看什么**。用户 2026-09-18：「全览和聚焦能直接做成同一个下拉窗口」——
       所以只留**一个下拉**：第一项「全览」= 不聚焦（看整条时间线），其余项 = 聚焦某条剧情线（线外内容截断）。 */
    ui.innerHTML = `
      <select class="lk-tl-tab" id="lk-line-sel" title="全览 = 看整条时间线；选一条剧情线 = 聚焦只看它" style="font-size:11px;background:none;border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--fg);padding:2px 4px;" ${lines.length ? '' : 'disabled'}>
        <option value="">— 全览 —</option>${lineOpts}<option value="__new__">＋ 新建剧情线…</option></select>`;
    /* 下拉底部那一项是**动作**（开右侧创建面板），不是状态：见 change 处理器里的 __new__ 分支。 */
    /* 状态区固定在面板头**最左**（标题左边）：「左＝看什么，右＝做什么」。工具在 #lk-tools 里，两边不混。 */
    let stateEl = TL_HEAD.querySelector('#lk-state') as HTMLElement | null;
    if (!stateEl) {
      stateEl = document.createElement('span');
      stateEl.id = 'lk-state';
      stateEl.style.cssText = 'display:flex;gap:6px;align-items:center;flex-shrink:0;margin-right:10px;padding-right:10px;border-right:1px solid var(--border-soft);';
      TL_HEAD.insertBefore(stateEl, TL_HEAD.firstChild);
    }
    /* ⚠️ 只摘掉自己那一块（`ui` 的 id 就是 `#lk-story-ui`）。整块 `innerHTML = ''` 会把
       `renderExtraTools()` 搬过来的「非线性」一起抹掉，之后它再搬一次 ⇒ **每切一次非线性就多一个按钮**
       （用户 2026-09-19 实测）。 */
    stateEl.querySelectorAll('#lk-story-ui').forEach((el) => el.remove());
    stateEl.appendChild(ui);

    /* 「＋剧情线」是**工具**（做一件事），放右上角 #lk-tools；左边状态区只留那个下拉。 */
    const toolsBox = TL_HEAD.querySelector('#lk-tools');
    if (toolsBox && !document.getElementById('lk-line-new')) {
      const b = document.createElement('button');
      b.className = 'lk-tl-tab is-new';
      b.id = 'lk-line-new';
      b.title = '新建剧情线（先覆盖整条时间线，随后在右侧面板里编辑区段）';
      b.textContent = '＋剧情线';
      toolsBox.appendChild(b);
    }

    ui.querySelector('#lk-brush')?.addEventListener('click', () => {
      brushing = !brushing;
      renderStoryUI();
      if (!brushing) clearBrushSel();
    });
    ui.querySelector('#lk-line-sel')?.addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      /* 「＋ 新建剧情线…」是**动作**不是状态：开右侧创建面板，然后把下拉拨回原样
         （否则它会一直显示成"当前聚焦的是新建剧情线"）。用户 2026-09-19：
         「在聚焦的下拉框底部增加一个新建剧情线的功能，点击在右侧面板展开新建剧情线的面板」。 */
      if (v === '__new__') {
        (e.target as HTMLSelectElement).value = activeLineId ?? '';
        openNewLinePanel();
        return;
      }
      /* 空串 = 「— 世界历史 —」，是一个**选择**（不聚焦任何剧情线），不是"没选"。
         下面的 renderStoryUI() 认得这个区别（见那里的 linePinned）。 */
      activeLineId = v || null;
      linePinned = true;
      render();
      renderStoryUI();
      renderSegPanel();
      /* 切聚焦后自动 fit（用户 2026-09-18：「进入时默认缩放至刚好能看到所有节点…切换聚焦时」）：
         等这一帧画完再量宽度，否则都是旧几何。C 步做完后这里改成 fit 到该线的区段。 */
      requestAnimationFrame(() => fitAll());
    });
    /* 「＋剧情线」（面板头右上角那个按钮）与聚焦下拉底部的「＋ 新建剧情线…」是**同一个动作**：
       开右侧创建面板，而不是立刻建一条。⚠️ 旧写法在这里直接 push 了一条线，而且把
       `yearEpoch(年)`（**epoch 秒**）写进了 `segments` —— 而段的语义是「年」（见 `inLine()` /
       渲染遮罩的 `yearEpoch(s.start)`），那种线段大到 `inLine(任何年份)` 都为 false ⇒ 聚焦它
       等于什么都看不见。现在统一走面板，段一律写「年」（`openNewLinePanel()` 里种的默认段也是年）。 */
    document.getElementById('lk-line-new')?.addEventListener('click', () => openNewLinePanel());
  }

  /* 刷选结果统一为「年」——与 segments 的既有语义、yearEpoch()、inLine() 一致。
     xToTime() 出的是 epoch 秒（见上面坐标换算），直接存会让 yearEpoch(9.6e9)
     落进 toEpoch 的「按年累加」回退分支 → 主线程跑 ~10¹⁰ 次循环，建剧情线即卡死。 */
  function brushYearFromVx(vx: number): number { return xToTime(vx) / SEC_PER_YEAR; }
  function clearBrushSel() { brushSel.style.display = 'none'; brushSel.style.left = '0'; brushSel.style.width = '0'; }
  function setBrushSel(vx0: number, vx1: number) {
    brushSel.style.display = '';
    brushSel.style.left = Math.min(vx0, vx1) + 'px';
    brushSel.style.width = Math.abs(vx1 - vx0) + 'px';
  }

  /* 橡皮擦差集（照抄 legacy eraseRange）：返回擦除 e0~e1 后的段 */
  function eraseRange(segs: { start: number; end: number | null }[], e0: number, e1: number): { start: number; end: number | null }[] {
    const out: { start: number; end: number | null }[] = [];
    segs.forEach((s) => {
      const s1 = s.end === null || s.end === undefined ? Infinity : s.end;
      if (e1 < s.start || e0 > s1) { out.push(s); return; }
      if (e0 <= s.start && e1 >= s1) return;
      if (e0 > s.start) out.push({ start: s.start, end: e0 });
      if (e1 < s1) out.push({ start: e1, end: s.end });
    });
    return out;
  }

  /* 笔刷拖拽（brushing 时框选时间段；Alt=擦除模式） */
  let brushDrag = false, brushStartX = 0, brushLastX = 0, brushErase = false;
  wrap.addEventListener('pointerdown', (e) => {
    if (!brushing) return;
    if ((e.target as HTMLElement).closest('.tl__n')) return;
    brushDrag = true;
    brushErase = e.altKey;
    brushStartX = e.clientX - wrap.getBoundingClientRect().left;
    brushLastX = brushStartX;
    setBrushSel(brushStartX, brushStartX);
  });
  window.addEventListener('pointermove', (e) => {
    if (!brushDrag) return;
    if (e.buttons === 0) { brushDrag = false; clearBrushSel(); return; }   /* 丢失 pointerup 时兜底 */
    brushLastX = e.clientX - wrap.getBoundingClientRect().left;
    setBrushSel(brushStartX, brushLastX);
  });
  window.addEventListener('pointercancel', () => {
    if (!brushDrag) return;
    brushDrag = false;
    clearBrushSel();   /* 手势被取消：不落段，只撤掉框选高亮 */
  });
  window.addEventListener('pointerup', () => {
    if (!brushDrag) return;
    brushDrag = false;
    const t0 = brushYearFromVx(brushStartX), t1 = brushYearFromVx(brushLastX);
    const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
    clearBrushSel();
    if (hi - lo <= 0.01) return;
    if (brushErase) {
      /* 擦除：对聚焦线已存段 或 未命名累积段做差集。
         下面粒度 0.1 是「年」——brushYearFromVx 现在回年，与 segments 语义一致。 */
      const tlId = activeTimelineId();
      const e0 = Math.round(lo * 10) / 10, e1 = Math.round(hi * 10) / 10;
      if (activeLineId && tlId) {
        const lineId = activeLineId;
        store.update((d) => {
          const ln2 = d.worldsets[store.activeWorld]?.timelines[tlId]?.storylines?.find((l) => l.id === lineId);
          if (ln2) ln2.segments = eraseRange(Array.isArray(ln2.segments) ? ln2.segments : [], e0, e1);
        });
      } else {
        pendingSegs = eraseRange(pendingSegs, e0, e1);
      }
    } else {
      /* 吸附到**节点时间**（用户：「也有吸附可以吸附到节点时间」）：边界距某节点 ≤8px 就贴过去。 */
      const tolY = 8 / Math.max(0.0001, view.spacing);
      const nodeYears = (timeline()?.nodes ?? []).map((nd) => nd.year ?? 0);
      const snapYear = (vv: number): number => {
        let best = vv, bestD = tolY;
        for (const yy of nodeYears) { const dd = Math.abs(yy - vv); if (dd < bestD) { bestD = dd; best = yy; } }
        return best;
      };
      const yA = snapYear(lo), yB = snapYear(hi);
      pendingSegs.push({ start: Math.round(Math.min(yA, yB) * 10) / 10, end: Math.round(Math.max(yA, yB) * 10) / 10 });
    }
    renderStoryUI();
    /* 创建面板开着时，新拖出来的段落要立刻出现在它里面（那条 pointerup 只重画画布与状态区） */
    if (newLinePanelOpen) renderNewLinePanel();
    render();
  });

  /* 剧情线范围条（时间线上色带）+ 遮罩。
     ⚠️ `nonlinear === true` 时**两层都清空**：非线性模式把 x 换成了序列序（与时间无关），
     而这两层是按 `timeToX(年份)` 画的 ⇒ 叠上去只会盖错地方（用户 2026-09-19 报的
     「非线性和聚焦同时开有 bug」）。参数化而不是在里面读 `nonlinearMode`：那是 `let`，
     而这个函数在它的声明**之前**就会被调用（启动那次 render）—— 直接读会 TDZ 抛错。 */
  function renderStoryOverlay(nonlinear = false) {    const ln = activeLine();
    /* 遮罩 */
    let mask = wrap.querySelector('#lk-story-mask') as HTMLElement | null;
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'lk-story-mask';
      mask.style.cssText = 'position:absolute;top:34px;bottom:0;left:0;right:0;z-index:2;pointer-events:none;';
      wrap.appendChild(mask);
    }
    mask.innerHTML = '';
    /* 非线性：遮罩没有意义（它按时间画），把色带也一起清掉再走 —— 那一条带子表示的是
       "剧情线覆盖了哪一段**时间**"，而这一支的 x 是序列序。 */
    if (nonlinear) {
      const bar0 = wrap.querySelector('.tl__storybar');
      if (bar0) bar0.innerHTML = '';
      return;
    }
    /* segments 为空时 Math.min()/Math.max() 返回 ±Infinity，yearEpoch(Infinity) 会让
       toEpoch 的按年累加变成真·死循环 —— 必须先判空 */
    if (storyMode === 'focus' && ln && ln.segments.length) {
      /* 范围外盖灰 */
      const lo = Math.min(...ln.segments.map((s) => s.start));
      const hi = Math.max(...ln.segments.map((s) => (s.end === null || s.end === undefined ? openEndYear(s.start) : s.end)));
      const xLo = timeToX(yearEpoch(lo)), xHi = timeToX(yearEpoch(hi));
      const w = wrap.clientWidth;
      if (xLo > 0) mask.innerHTML += `<div style="position:absolute;top:0;bottom:0;left:0;width:${xLo}px;background:rgba(110,108,100,.3);"></div>`;
      if (xHi < w) mask.innerHTML += `<div style="position:absolute;top:0;bottom:0;left:${xHi}px;width:${w - xHi}px;background:rgba(110,108,100,.3);"></div>`;
    }
    /* 范围条色带 */
    let bar = wrap.querySelector('.tl__storybar') as HTMLElement | null;
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'tl__storybar';
      wrap.appendChild(bar);
    }
    bar.innerHTML = '';
    if (ln) {
      ln.segments.forEach((s) => {
        const x0 = timeToX(yearEpoch(s.start));
        const x1 = timeToX(yearEpoch(s.end === null || s.end === undefined ? openEndYear(s.start) : s.end));
        bar.innerHTML += `<div class="tl__storybar-seg" style="left:${x0}px;width:${Math.max(2, x1 - x0)}px;"></div>`;
      });
    }
  }

  /* 聚焦过滤：渲染时只显示线内节点 */
  const origRender = render;
  render = function () {
    const tl = timeline();
    rebuildWarp();   /* 段被编辑过 / 换了线 / 换了模式，压缩轴都要跟着重算（段很少，成本可忽略） */
    if (tl && storyMode === 'focus' && activeLine()) {
      const nodes = tl.nodes.filter((n) => inLine(n.year));
      track.innerHTML = lineHtmlOf(nodes);
      renderScale();
      updateCursor();
    } else {
      origRender();
    }
    renderStoryOverlay();
    drawCauses();
  };

  function lineHtmlOf(nodes: TimelineNode[]): string {
    let html = '<div class="tl-line"></div>';
    return html + nodes.map((n) => {
      const x = timeToX(nodeEpoch(n));
      const sel = n.id === selectedId;
      return nodeHtml(n, x, sel);
    }).join('');
  }

  renderStoryUI();
  renderSegPanel();
  /* 到这里剧情线那几个状态（storyMode / activeLineId / linePinned）才真正可用 ⇒ 打开映射并重画一次
     （:608 那次 render() 跑在剧情线那一段之前，那时只能按「不压缩」画）。 */
  warpReady = true;
  rebuildWarp();
  render();

  /* 段列表面板（右侧）：聚焦剧情线时显示段列表，可删段 */
  function renderSegPanel() {
    const toolHost = document.getElementById('lk-tool-host');
    if (!toolHost) return;
    /* 「新建剧情线」面板占着同一个宿主：它会自己画、自己收，这里别把它冲掉 */
    if (newLinePanelOpen) return;
    const tl = timeline();
    const ln = activeLineId && tl ? tl.storylines.find((l) => l.id === activeLineId) : undefined;
    if (!ln) { toolHost.innerHTML = ''; return; }
    /* 剧情线创建面板（第 4.0 片 B 步）：段可**手动输入**时间，也可用「＋ 添加一段」在时间线上拖出来；
       拾取是**这个面板里的编辑手段**（笔刷），不是工具栏上的模式 —— 用户 2026-09-18 纠正过这一点）。 */
    toolHost.innerHTML = [
      '<div style="padding:12px 14px;display:flex;flex-direction:column;gap:8px;">',
      `<div style="font-size:15px;font-weight:600;color:var(--fg);">${escapeHtml(ln.name)}</div>`,
      '<div style="display:flex;align-items:center;gap:6px;font-size:var(--text-xs);color:var(--fg-2);">',
      `<span>${ln.segments.length} 段</span>`,
      brushing ? '<span style="color:var(--accent);">正在拾取…</span><button id="seg-cancel" class="lk-tl-tab">取消</button>' : '',
      '<button id="seg-add" class="lk-tl-tab is-new" title="在时间线上拖动框出一段（Alt 拖 = 擦除；靠近节点会吸附）" style="margin-left:auto;">＋ 添加一段</button>',
      '</div>',
      `<div style="display:flex;flex-direction:column;gap:4px;">${(ln.segments.length ? ln.segments.map((s, i) => [
        '<div style="display:flex;align-items:center;gap:6px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 8px;">',
        `<input data-sv="${i}" data-k="start" value="${s.start}" title="开始（年）" style="width:66px;background:none;border:none;color:var(--accent);font-family:var(--font-mono);font-size:var(--text-xs);" />`,
        '<span style="color:var(--fg-2);font-size:var(--text-xs);">→</span>',
        `<input data-sv="${i}" data-k="end" value="${s.end === null ? '' : s.end}" placeholder="∞" title="结束（年；留空＝一直延续）" style="width:66px;background:none;border:none;color:var(--accent);font-family:var(--font-mono);font-size:var(--text-xs);" />`,
        `<button data-si="${i}" title="删除这一段" style="margin-left:auto;background:none;border:none;color:var(--danger);cursor:pointer;font-size:12px;">✕</button>`,
        '</div>',
      ].join('')).join('') : '<div style="font-size:var(--text-xs);color:var(--fg-2);">（还没有段）</div>')}</div>`,
      '</div>',
    ].join('');
    /* 手动输入时间：改成合法数字就写回该段（留空 = ∞） */
    toolHost.querySelectorAll('[data-sv]').forEach((el) => {
      el.addEventListener('change', () => {
        const si = parseInt((el as HTMLElement).dataset.sv!, 10);
        const key = (el as HTMLElement).dataset.k!;
        const raw = (el as HTMLInputElement).value.trim();
        const num = raw === '' ? null : Number(raw);
        if (num !== null && !Number.isFinite(num)) return;
        const tlId = activeTimelineId();
        if (!tlId) return;
        store.update((d) => {
          const t2 = d.worldsets[store.activeWorld]?.timelines[tlId];
          const ln2 = t2?.storylines?.find((l) => l.id === activeLineId);
          const sg = ln2?.segments?.[si];
          if (!sg) return;
          if (key === 'start') sg.start = num === null ? sg.start : num;
          else sg.end = num;
        });
        renderSegPanel();
        render();
      });
    });
    toolHost.querySelector('#seg-add')?.addEventListener('click', () => {
      brushing = true;
      renderSegPanel();
      renderStoryUI();
    });
    toolHost.querySelector('#seg-cancel')?.addEventListener('click', () => {
      brushing = false;
      clearBrushSel();
      renderSegPanel();
      renderStoryUI();
    });
    toolHost.querySelectorAll('[data-si]').forEach((el) => {
      el.addEventListener('click', () => {
        const si = parseInt((el as HTMLElement).dataset.si!, 10);
        /* 必须走 store.update：`tl.storylines` 是 store.data 里的**活引用**，
           直接 splice 既不通知订阅者（段面板/自动落盘都不动）也不进撤销栈
           —— 重启后这段「复活」，Ctrl+Z 也回不来（与建线/擦除同一个坑，
           见 src/store/actions.ts 里那段说明）。 */
        const tlId = activeTimelineId();
        if (tlId) {
          store.update((d) => {
            const t = d.worldsets[store.activeWorld]?.timelines[tlId];
            const line2 = t?.storylines?.find((l) => l.id === activeLineId);
            if (line2) line2.segments.splice(si, 1);
          });
        }
        renderSegPanel();
        render();
      });
    });
  }

  /* ── 新建剧情线面板（右侧宿主 `#lk-tool-host`）──
     两个入口：面板头右上角的「＋剧情线」按钮、**聚焦下拉底部的「＋ 新建剧情线…」**
     （用户 2026-09-19：「在聚焦的下拉框底部增加一个新建剧情线的功能，点击在右侧面板展开
     新建剧情线的面板」）。
     段一律用**年**（与 `segments` 的既有语义、`inLine()`、遮罩里的 `yearEpoch(s.start)` 一致）；
     「＋ 添加一段」进拾取态、在时间线上拖出段（pointerup 收尾时会重画本面板）。
     ⚠️ 本面板存在期间 `renderSegPanel()` 会早退 —— 同一个宿主，否则会被「这条线的段」冲掉。 */
  function openNewLinePanel(): void {
    const ys = (timeline()?.nodes ?? []).map((nd) => nd.year ?? 0);
    /* 默认给一段 = 整条时间线的跨度（**年**）：省得先拖一段才能建；不想要就按 ✕ 删掉 */
    pendingSegs = ys.length ? [{ start: Math.min(...ys), end: Math.max(...ys) }] : [];
    newLineName = `剧情线 ${linesOf().length + 1}`;
    newLinePanelOpen = true;
    brushing = false;
    clearBrushSel();
    renderNewLinePanel();
    renderStoryUI();     /* 拾取态与下拉的高亮跟着复位 */
  }

  function closeNewLinePanel(): void {
    newLinePanelOpen = false;
    pendingSegs = [];
    brushing = false;
    clearBrushSel();
    const toolHost = document.getElementById('lk-tool-host');
    if (toolHost) toolHost.innerHTML = '';
    renderStoryUI();
    render();
  }

  function renderNewLinePanel(): void {
    const toolHost = document.getElementById('lk-tool-host');
    if (!toolHost || !newLinePanelOpen) return;
    const segRow = (s: { start: number; end: number | null }, i: number): string => [
      '<div style="display:flex;align-items:center;gap:6px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 8px;">',
      `<input data-nv="${i}" data-k="start" value="${s.start}" title="开始（年）" style="width:66px;background:none;border:none;color:var(--accent);font-family:var(--font-mono);font-size:var(--text-xs);" />`,
      '<span style="color:var(--fg-2);font-size:var(--text-xs);">→</span>',
      `<input data-nv="${i}" data-k="end" value="${s.end === null ? '' : s.end}" placeholder="∞" title="结束（年；留空＝一直延续）" style="width:66px;background:none;border:none;color:var(--accent);font-family:var(--font-mono);font-size:var(--text-xs);" />`,
      `<button data-ni="${i}" title="删除这一段" style="margin-left:auto;background:none;border:none;color:var(--danger);cursor:pointer;font-size:12px;">✕</button>`,
      '</div>',
    ].join('');
    toolHost.innerHTML = [
      '<div style="padding:12px 14px;display:flex;flex-direction:column;gap:10px;">',
      '<div style="font-size:15px;font-weight:600;color:var(--fg);">新建剧情线</div>',
      '<div style="display:flex;flex-direction:column;gap:4px;">',
      '<label style="font-size:var(--text-xs);color:var(--fg-2);" for="nl-name">名字</label>',
      `<input id="nl-name" type="text" value="${escapeHtml(newLineName)}" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 7px;font-size:var(--text-sm);outline:none;" />`,
      '</div>',
      '<div style="display:flex;align-items:center;gap:6px;font-size:var(--text-xs);color:var(--fg-2);">',
      `<span>${pendingSegs.length} 段（单位：年）</span>`,
      brushing ? '<span style="color:var(--accent);">在时间线上拖出一段…</span>' : '',
      '<button id="nl-add" class="lk-tl-tab is-new" title="在时间线上拖动框出一段（Alt 拖 = 擦除；靠近节点会吸附）" style="margin-left:auto;">＋ 添加一段</button>',
      '</div>',
      `<div style="display:flex;flex-direction:column;gap:4px;">${pendingSegs.length ? pendingSegs.map(segRow).join('') : '<div style="font-size:var(--text-xs);color:var(--fg-2);">（还没有段：点「＋ 添加一段」在时间线上拖）</div>'}</div>`,
      '<div style="display:flex;gap:8px;">',
      '<button id="nl-ok" style="flex:1;background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-sm);padding:7px;font-size:var(--text-sm);cursor:pointer;">创建</button>',
      '<button id="nl-cancel" style="flex:1;background:var(--surface-2);color:var(--fg-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:7px;font-size:var(--text-sm);cursor:pointer;">取消</button>',
      '</div>',
      '</div>',
    ].join('');
    const nameEl = toolHost.querySelector('#nl-name') as HTMLInputElement | null;
    nameEl?.addEventListener('change', () => { newLineName = nameEl.value; });
    toolHost.querySelectorAll('[data-nv]').forEach((el) => {
      const h = el as HTMLInputElement;
      h.addEventListener('change', () => {
        const i = parseInt(h.dataset.nv!, 10);
        const raw = h.value.trim();
        const num = raw === '' ? null : Number(raw);
        if (num !== null && !Number.isFinite(num)) return;
        const seg = pendingSegs[i];
        if (!seg) return;
        if (h.dataset.k === 'start') { if (num !== null) seg.start = num; } else seg.end = num;
        renderNewLinePanel();
      });
    });
    toolHost.querySelectorAll('[data-ni]').forEach((el) => el.addEventListener('click', () => {
      pendingSegs.splice(parseInt((el as HTMLElement).dataset.ni!, 10), 1);
      renderNewLinePanel();
    }));
    toolHost.querySelector('#nl-add')?.addEventListener('click', () => {
      brushing = true;
      renderNewLinePanel();
      renderStoryUI();
    });
    toolHost.querySelector('#nl-cancel')?.addEventListener('click', () => closeNewLinePanel());
    toolHost.querySelector('#nl-ok')?.addEventListener('click', () => {
      const tlId = activeTimelineId();
      if (!tlId) return;
      const id = uid('sl');
      const segs = pendingSegs.slice();
      const name = (newLineName || '').trim() || `剧情线 ${linesOf().length + 1}`;
      /* 走 store.update：直接 push 进 `tl.storylines`（store.data 里的活引用）既不通知订阅者
         （段面板/自动落盘都不动）、也不进撤销栈 —— 重启后那条线会「复活」（见 renderSegPanel 里的说明） */
      store.update((d) => {
        const tl2 = d.worldsets[store.activeWorld]?.timelines[tlId];
        if (!tl2) return;
        if (!tl2.storylines) tl2.storylines = [];
        tl2.storylines.push({ id, name, segments: segs });
      });
      newLinePanelOpen = false;
      pendingSegs = [];
      brushing = false;
      clearBrushSel();
      activeLineId = id;   /* 建完就聚焦它（与旧按钮一致：立刻能看到效果） */
      renderStoryUI();
      render();
      renderSegPanel();    /* 右侧换成「这条线的段」编辑面板 */
    });
  }

  /* ══════════ 循环系统（循环框 + 幽灵节点 + 面板）══════════ */
  let loopPanelId: string | null = null;    // 当前打开面板的循环
  let nonlinearMode = false;                // 非线性（序列均匀横排）

  function loopsOf(): Loop[] {
    const tl = timeline();
    return (tl && Array.isArray(tl.loops) ? tl.loops : []) as Loop[];
  }
  function loopById(id: string): Loop | undefined {
    return loopsOf().find((l) => l.id === id);
  }
  function findNodeById(nid: string | undefined): TimelineNode | undefined {
    const tl = timeline();
    return nid ? tl?.nodes.find((n) => n.id === nid) : undefined;
  }
  function loopRange(L: Loop): { lo: number; hi: number; span: number } | null {
    const s = findNodeById(L.startId), e = findNodeById(L.endId);
    if (!s || !e) return null;
    const lo = Math.min(s.year, e.year), hi = Math.max(s.year, e.year);
    return { lo, hi, span: hi - lo };
  }

  function renderLoops() {
    let frames = wrap.querySelector('#lk-loop-frames') as HTMLElement | null;
    if (!frames) {
      frames = document.createElement('div');
      frames.id = 'lk-loop-frames';
      frames.style.cssText = 'position:absolute;top:34px;left:0;right:0;bottom:0;z-index:1;pointer-events:none;';
      wrap.appendChild(frames);
    }
    frames.innerHTML = '';
    const tl = timeline();
    if (!tl) return;
    loopsOf().forEach((L) => {
      const r = loopRange(L);
      if (!r) return;
      const x0 = timeToX(yearEpoch(r.lo)), x1 = timeToX(yearEpoch(r.hi));
      frames.innerHTML += `<div class="tl__loop" data-loop-id="${escapeHtml(L.id)}" style="left:${x0}px;width:${Math.max(2, x1 - x0)}px;" title="${escapeHtml(L.name)}（${L.count} 次）"><span class="tl__loop-badge">${L.count}×</span></div>`;
      /* 幽灵节点：范围内节点复制 count-1 次，偏移 span */
      if (L.count > 1) {
        const inner = tl.nodes.filter((n) => n.year >= r.lo && n.year <= r.hi);
        for (let c = 1; c < L.count; c++) {
          inner.forEach((n) => {
            const x = timeToX(yearEpoch(n.year + c * r.span));
            frames!.innerHTML += `<div class="tl__ghost" style="left:${x}px;"><div class="cap"></div><div class="tl__name">${escapeHtml(n.title)}²</div></div>`;
          });
        }
      }
    });
    /* 双击循环框 → 面板（右侧） */
    frames.querySelectorAll('.tl__loop').forEach((el) => {
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const lid = (el as HTMLElement).dataset.loopId!;
        loopPanelId = lid;
        renderLoopPanel();
      });
    });
  }

  function renderLoopPanel() {
    const L = loopPanelId ? loopById(loopPanelId) : undefined;
    const toolHost = document.getElementById('lk-tool-host');
    if (!toolHost) return;
    if (!L) { toolHost.innerHTML = ''; return; }
    const r = loopRange(L);
    toolHost.innerHTML = `
      <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;">
        <div style="font-size:15px;font-weight:600;color:var(--fg);">循环 · ${escapeHtml(L.name)}</div>
        <div style="font-size:var(--text-xs);color:var(--fg-2);">${r ? `${r.lo}年 → ${r.hi}年（跨度 ${r.span} 年）` : '起终节点缺失'}</div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:var(--text-xs);color:var(--fg-2);">循环次数</span>
          <button id="lp-minus" style="width:24px;height:24px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);cursor:pointer;">−</button>
          <span id="lp-count" style="font-size:var(--text-sm);color:var(--accent);min-width:24px;text-align:center;">${L.count ?? 1}</span>
          <button id="lp-plus" style="width:24px;height:24px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);cursor:pointer;">＋</button>
        </div>
        <button id="lp-del" style="background:transparent;border:1px solid #c0392b;color:#c0392b;border-radius:var(--radius-sm);padding:6px;font-size:var(--text-sm);cursor:pointer;">删除循环</button>

      </div>`;
    toolHost.querySelector('#lp-minus')?.addEventListener('click', () => {
      const tid = activeTimelineId();
      if (!L || !tid) return;
      setLoopCount(store, tid, L.id, Math.max(1, (L.count ?? 1) - 1));
      renderLoopPanel(); renderLoops();
    });
    toolHost.querySelector('#lp-plus')?.addEventListener('click', () => {
      const tid = activeTimelineId();
      if (!L || !tid) return;
      setLoopCount(store, tid, L.id, Math.min(20, (L.count ?? 1) + 1));
      renderLoopPanel(); renderLoops();
    });
    toolHost.querySelector('#lp-del')?.addEventListener('click', () => {
      const tid = activeTimelineId();
      if (!tid || !L) return;
      /* 循环是纯视图结构（重复展示一段节点），不持有数据，所以只加确认、不进回收站 */
      void confirmDialog({
        title: `删除循环「${L.name}」？`,
        message: '循环框会从时间线上移除，循环内的节点本身不受影响。',
        detail: '循环只是视图结构（把一段节点重复展示 N 次），不持有数据。',
        confirmText: '删除',
        danger: true,
      }).then((okDel) => {
        if (!okDel) return;
        removeLoop(store, tid, L.id);
        loopPanelId = null;
        toolHost.innerHTML = '';
        renderLoops();
      });
    });
  }

  /* 沙盘头加「＋循环」「非线性」常驻工具 */
  function renderExtraTools() {
    if (!TL_HEAD) return;
    let ext: HTMLElement | null = TL_HEAD.querySelector('#lk-extras');
    if (ext) ext.remove();
    ext = document.createElement('span');
    ext.id = 'lk-extras';
    ext.style.cssText = 'display:flex;gap:4px;align-items:center;flex-shrink:0;';    ext.innerHTML = `
      <button class="lk-tl-tab is-new" id="lk-loop-new" title="新建循环（选起终节点）">＋循环</button>
      <button class="lk-tl-tab${nonlinearMode ? ' is-active' : ''}" id="lk-nonlinear" title="非线性：按序列顺序均匀排列">非线性</button>`;

    /* 把它搬进面板头最左的状态区（顺序：非线性 | 全览下拉）。 */
    TL_HEAD.querySelectorAll('#lk-state #lk-nonlinear').forEach((el) => el.remove());   /* 去重：只留一个 */
    const stateBox = TL_HEAD.querySelector('#lk-state');
    const nlBtn = ext.querySelector('#lk-nonlinear');
    if (stateBox && nlBtn) stateBox.insertBefore(nlBtn, stateBox.firstChild);
    /* 放进固定容器 #lk-tools（与 story-ui 同容器，extras 居后，位置固定不乱跑） */
    const tools = TL_HEAD.querySelector('#lk-tools');
    if (tools) tools.appendChild(ext); else TL_HEAD.insertBefore(ext, TL_HEAD.querySelector('#lk-node-new') ?? TL_HEAD.lastChild);
    ext.querySelector('#lk-loop-new')?.addEventListener('click', () => {
      const tl = timeline();
      if (!tl) return;
      const toolHost = document.getElementById('lk-tool-host');
      if (!toolHost) return;
      const opts = tl.nodes
        .map((n) => `<option value="${escapeHtml(n.id)}">${n.year} · ${escapeHtml(n.title)}</option>`)
        .join('');
      toolHost.innerHTML = `
        <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;">
          <div style="font-size:15px;font-weight:600;color:var(--fg);">新建循环 · ${escapeHtml(tl.name)}</div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            <label style="font-size:var(--text-xs);color:var(--fg-2);">名称</label>
            <input id="lp-name" type="text" placeholder="潮汐轮回" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:6px 8px;font-size:var(--text-sm);outline:none;"/>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            <label style="font-size:var(--text-xs);color:var(--fg-2);">起始节点</label>
            <select id="lp-start" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:6px 8px;font-size:var(--text-sm);outline:none;">${opts}</select>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            <label style="font-size:var(--text-xs);color:var(--fg-2);">结束节点</label>
            <select id="lp-end" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:6px 8px;font-size:var(--text-sm);outline:none;">${opts}</select>
          </div>
          <div style="display:flex;gap:8px;">
            <button id="lp-ok" style="flex:1;background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-sm);padding:7px;font-size:var(--text-sm);cursor:pointer;">创建</button>
            <button id="lp-cancel" style="flex:1;background:var(--surface-2);color:var(--fg-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:7px;font-size:var(--text-sm);cursor:pointer;">取消</button>
          </div>
        </div>`;
      toolHost.querySelector('#lp-ok')?.addEventListener('click', () => {
        const tid = activeTimelineId();
        if (!tid) return;
        const name = (toolHost.querySelector('#lp-name') as HTMLInputElement).value.trim() || `循环 ${loopsOf().length + 1}`;
        const startId = (toolHost.querySelector('#lp-start') as HTMLSelectElement).value;
        const endId = (toolHost.querySelector('#lp-end') as HTMLSelectElement).value;
        if (!startId || !endId) return;
        addLoop(store, tid, { name, startId, endId, count: 2 });
        toolHost.innerHTML = '';
        renderLoops();
      });
      toolHost.querySelector('#lp-cancel')?.addEventListener('click', () => (toolHost.innerHTML = ''));
    });
    document.getElementById('lk-nonlinear')?.addEventListener('click', () => {
      nonlinearMode = !nonlinearMode;
      /* 进非线性时把那一套游标归零：它是**独立**的画布视图，沿用上次的平移会让人一进来
         就对着空白（而且和线性视图的 panX 根本不是一套坐标）。 */
      if (nonlinearMode) { nlPan = 0; nlZoom = 1; }
      renderExtraTools();
      render();
    });
  }

  /* ══════════ 非线性模式（序列顺序 · 等距横排）══════════ */
  /* 非线性模式**自己那套**视图游标：这一支的 x 是序列序、与时间无关，复用 `view.panX/spacing`
     会让两种模式互相踩（切回线性时整条时间线被推到天边）。进出这个模式时归零（见按钮那边）。 */
  let nlPan = 0;
  let nlZoom = 1;
  function renderNonlinear() {
    const tl = timeline();
    if (!tl || !nonlinearMode) return;
    /* 聚焦时只排**线内**节点 —— 与线性视图同一套语义（聚焦＝只看这条线上的事）：
       非线性只是把"距离"换成等距，不该把线外的东西又放回来。
       （用户 2026-09-19：「非线性和聚焦做一下适配，现在两个同时开有bug」。） */
    const focusOn = storyMode === 'focus' && !!activeLine();
    const nodes = focusOn ? tl.nodes.filter((n) => inLine(n.year)) : tl.nodes;
    if (!nodes.length) return;
    /* 排版与线性视图一致（节点都落在轴线上、剧情事件名字在上、世界事件名字在下），
       区别只有两点：x 一律等距（与年份无关），以及每个节点自带年份标签。
       **不按类型分行** —— 分行会把同一条时间线上的先后关系拆到两行里，反而看不清顺序。
       这个模式的目的（用户 2026-09-12）就是「方便看清节点的时间顺序（排除时间干扰）」。 */
    /* 先按**时间**排序再等距排 —— 这个模式的目的就是「看清时间顺序」，而 `tl.nodes`
       的数组顺序并不是时间序（vault 是节点的源，重扫后数组顺序 = 目录/文件顺序）。
       照原样排会得到 330→420→450→312→500 这种乱序，等于把功能废掉。
       线性视图靠 x 坐标表达时间，所以不受数组顺序影响；这个模式只把「距离」换成等距。 */
    const ordered = nodes.slice().sort((a, b) => nodeEpoch(a) - nodeEpoch(b));
    /* 等距仍然等距，但整条带子必须**可平移、可缩放**：旧写法 pitch 只由窗口宽度算、
       x 里也没有 panX ⇒ 节点钉死在屏幕上，节点比屏宽时尾巴既看不到也够不着
       （用户 2026-09-19：「非线性下节点固定在屏幕上了」）。 */
    const basePitch = Math.max(24, (wrap.clientWidth - 100) / Math.max(1, ordered.length));
    const pitch = Math.max(8, basePitch * nlZoom);
    /* 顶部标尺是按**时间**画刻度的，而这里的 x 是序列序 → 刻度与节点对不上；
       标尺正是这个模式要排除的「时间干扰」，清空（切回线性时 baseRender 会重画）。 */
    clearScale();
    track.innerHTML =
      `<div class="tl-line" style="left:0;right:0;"></div>` +
      ordered
        .map((node, i) => {
          const x = 50 + i * pitch + nlPan;
          /* 年份放「名字的对侧」，两边都不打架：世界事件的名字在圆点下方
             （.tl__n.is-world .tl__name{top:22px}）→ 年份在上；剧情事件的名字在上方
             （.is-story → top:-19px）→ 年份在下。calc(50%) 跟着节点的 top:50% 走。 */
          const yearTop = node.type === 'story_event' ? 'calc(50% + 14px)' : 'calc(50% - 19px)';
          return nodeHtml(node, x, node.id === selectedId) +
            `<div style="font-size:8px;color:var(--fg-2);position:absolute;top:${yearTop};left:${x}px;transform:translateX(-50%);">${node.year}</div>`;
        })
        .join('');
    updateCursor();
    /* 时间指针的横坐标在这个模式下没有意义（x 是序列序），藏掉指针本身 ——
       只能写在这里：`updateCursor` 在 `let nonlinearMode` 声明**之前**就会被调用
       （renderScale 的尾部），在那儿读它属于暂存死区，会让启动直接抛
       `ReferenceError: Cannot access 'nonlinearMode' before initialization`，
       而 mountTimeline 是在尾部才 renderExtraTools()，一抛整排沙盘按钮都不会创建。
       「已发生/未发生」的淡化在上面 updateCursor 里已按时间算好，不受影响。 */
    cursorEl.style.display = 'none';
  }

  /* render 统一入口：非线性 > 剧情线聚焦 > 常规 */
  const baseRender = render;
  render = function () {
    /* 非线性分支也要重画因果线：节点已按序列重排，若只 return，
       causesSvg 里留着上一帧线性布局的箭头，指向空白处 */
    if (nonlinearMode) {
      /* 传 true：那一支的 x 是序列序、与时间无关，时间遮罩/色带在那里只会盖错地方 */
      renderNonlinear();
      renderLoops();
      renderStoryOverlay(true);
      drawCauses();
      return;
    }
    baseRender();
    renderLoops();
  };

  renderExtraTools();
  renderLoops();

  /* ══════════ 右键菜单（重新设计：工具已常驻，右键=快捷操作）══════════ */
  let ctxMenu: HTMLElement | null = null;
  function closeCtx() { ctxMenu?.remove(); ctxMenu = null; }
  function showCtx(x: number, y: number, nodeId: string | null) {
    closeCtx();
    ctxMenu = document.createElement('div');
    ctxMenu.style.cssText =
      'position:fixed;z-index:1000;background:var(--chrome);color:var(--fg-inverse);border:1px solid var(--chrome-2);border-radius:var(--radius-sm);padding:4px;min-width:150px;box-shadow:0 6px 20px rgba(0,0,0,.5);';
    const items: [string, () => void][] = nodeId
      ? [
          ['编辑', () => {
            const tl = timeline();
            const n = tl?.nodes.find((x) => x.id === nodeId);
            if (n && onSelect) onSelect(n);
          }],
          ['复制节点', () => {
            const tid = activeTimelineId();
            if (tid && nodeId) { copyNode(store, tid, nodeId); render(); }
          }],
          ['删除节点', () => {
            const tid = activeTimelineId();
            const n = timeline()?.nodes.find((x) => x.id === nodeId);
            if (!tid || !nodeId) return;
            void confirmDialog({
              title: `删除节点「${n?.title ?? '未命名'}」？`,
              message: '节点会从时间线移除，对应的 .md 文件移入 vault 的回收站。',
              detail: '需要时可从工具栏「回收站」恢复。',
              confirmText: '删除',
              danger: true,
            }).then((okDel) => {
              if (!okDel) return;
              removeNode(store, tid, nodeId);
              render();
            });
          }],
        ]
      : [
          ['新建节点', () => {
            const tl = timeline();
            const tid = activeTimelineId();
            if (!tl || !tid) return;
            const toolHost = document.getElementById('lk-tool-host');
            if (toolHost) renderNodeForm(store, toolHost, tid, tl.name);
          }],
          ['剧情线笔刷', () => { brushing = !brushing; renderStoryUI(); }],
          ['新建循环', () => { renderExtraTools(); document.getElementById('lk-loop-new')?.dispatchEvent(new MouseEvent('click')); }],
          ['fit 视图', () => fitAll()],
        ];
    items.forEach(([label, fn]) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText =
        'display:block;width:100%;text-align:left;background:none;border:none;color:var(--fg-inverse);font-size:12px;padding:5px 8px;cursor:pointer;border-radius:var(--radius-sm);';
      b.addEventListener('mouseenter', () => (b.style.background = 'var(--chrome-2)'));
      b.addEventListener('mouseleave', () => (b.style.background = 'none'));
      b.addEventListener('click', () => { closeCtx(); fn(); });
      ctxMenu!.appendChild(b);
    });
    document.body.appendChild(ctxMenu);
    ctxMenu.style.left = Math.min(x, window.innerWidth - 170) + 'px';
    ctxMenu.style.top = Math.min(y, window.innerHeight - items.length * 30 - 20) + 'px';
  }
  wrap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const nodeEl = (e.target as HTMLElement).closest('.tl__n') as HTMLElement | null;
    showCtx(e.clientX, e.clientY, nodeEl?.dataset.id ?? null);
  });
  document.addEventListener('click', (e) => {
    if (ctxMenu && !ctxMenu.contains(e.target as Node)) closeCtx();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtx(); });

  /* ── 宿主宽度变化时补一次重画（2026-09-26 第 ⑤ 片顺带修）─────────────────────────────────
     病根：`renderScale()` 的刻度范围是按 `wrap.clientWidth` 算的，而**宿主被藏起来时它是 0**
     —— 于是只画得出**一根**刻度（实测 `majors: 1, minors: 0`），`fitAll()` 也会按 0 宽算出
     `spacing = 下限 0.05`（等于没 fit）。而"切回沙盘"那条路（`src/ui/shell.ts` 里 `id === 'sandbox'`
     的分支）只**恢复显示**、不重画 ⇒ 这根孤零零的刻度会一直挂着。
     触发场景是现成的：会话恢复（`src/ui/session.ts`，09-19 加的）让应用**开局停在设定库**，
     于是沙盘宿主是"隐藏着挂载"的，用户第一次切回沙盘就看到一根刻度 + 没 fit 的视图。
     这里兜底：宽度**变了**就重画（重画不动视图，只是按新宽度重算刻度）；
     其中"从 0 变成真宽度"那一次额外补 `fitAll()` —— 之前那次 fit 是按 0 宽算的，不算数。 */
  let lastW = wrap.clientWidth;
  new ResizeObserver(() => {
    const w = wrap.clientWidth;
    if (w === lastW) return;
    const wasZero = lastW === 0;
    lastW = w;
    if (w === 0) return;          /* 又被藏起来了：这一帧画什么都看不见，等它出来再画 */
    if (wasZero) fitAll();
    render();
  }).observe(wrap);
}