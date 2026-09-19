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
  let easeTimer = 0;
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
    const step = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000);   /* 卡帧时别一次吃掉太多 */
      last = now;
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
      if (done) { window.clearTimeout(easeTimer); snapView(); render(); easeRaf = 0; return; }
      easeRaf = requestAnimationFrame(step);
    };
    easeRaf = requestAnimationFrame(step);
    /* 兜底：rAF 被降频/暂停时（后台窗口、未聚焦、节流）平滑循环会停在半路 ——
       600ms 后无条件落到目标值。实测过「平移 180px 只走了 27px 就停住」。 */
    window.clearTimeout(easeTimer);
    easeTimer = window.setTimeout(() => {
      if (easeRaf) { cancelAnimationFrame(easeRaf); easeRaf = 0; }
      snapView(); render();
    }, 600);
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
  function quantStep(): { stepSec: number; unit: string } {
    const sp = view.spacing;
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
  function renderScale() {
    const { stepSec, unit } = quantStep();
    currentScaleUnit = unit;                 /* 记录当前标尺档位，供指针文字裁剪 */
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
    let html = '';
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
      html += `<div class="tl__axis-tick tl__axis-tick--major" style="left:${x}px;">${prev}<span class="tl__axis-label">${t.cur}</span></div>`;
    }
    /* 小刻度：在**相邻主刻度之间**等分插（旧代码用 start + k*subStep，年档会累计漂移） */
    let subHtml = '';
    for (let i = 0; i + 1 < ticks.length; i++) {
      const a = ticks[i], b = ticks[i + 1];
      /* 接缝：相邻两个主刻度之间只要「压缩轴上的距离 < 真实距离」，就说明中间隔着被截断的区段
         —— 那里既不插小刻度（插出来是假的密度），也不假装连续，画一个断口标记。 */
      if (warpSegs && (year2w(b / SEC_PER_YEAR) - year2w(a / SEC_PER_YEAR)) < (b - a) / SEC_PER_YEAR - 1e-9) {
        subHtml += `<div class="tl__axis-cut" style="left:${Math.round((timeToX(a) + timeToX(b)) / 2)}px;">⋯</div>`;
        continue;
      }
      for (let k = 1; k < subDiv; k++) {
        const s = a + (b - a) * (k / subDiv);
        subHtml += `<div class="tl__axis-tick tl__axis-tick--minor" style="left:${timeToX(s)}px;"></div>`;
      }
    }
    scaleEl.innerHTML = html + subHtml;
  }

  /* ── 渲染节点 ── */
  let selectedId: string | null = null;
  function renderBase() {
    const tl = timeline();
    if (!tl) {
      track.innerHTML = '<div style="padding:20px;font-size:var(--text-sm);color:var(--fg-2);">无时间线 · 待建</div>';
      scaleEl.innerHTML = '';
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
  function drawCauses() {
    const tl = timeline();
    const byId = new Map<string, TimelineNode>((tl?.nodes ?? []).map((n) => [n.id, n]));
    let pathSvg = '';
    let defsSvg = '';
    let idx = 0;
    /* 弧线形状系数：末端切线角度 = atan(CURVE_DY / CURVE_DX) ≈ 32°，与跨距无关，
       也是端点贴圆点边缘时用的到达角（两者必须同源，否则贴边方向与弧线切线不连续） */
    const CURVE_DX = 0.4, CURVE_DY = 0.25;
    const RIM_ANGLE = Math.atan2(CURVE_DY, CURVE_DX);
    const svgRect = causesSvg.getBoundingClientRect();
    const nodeCenter = (id: string): { x: number; y: number; r: number } | null => {
      const el = track.querySelector(`[data-id="${id}"]`) as HTMLElement | null;
      if (!el) return null;
      const dot = (el.querySelector('.cap') as HTMLElement | null) ?? el;
      const r = dot.getBoundingClientRect();
      return { x: r.left + r.width / 2 - svgRect.left, y: r.top + r.height / 2 - svgRect.top, r: r.width / 2 };
    };
    for (const n of tl?.nodes ?? []) {
      for (const cid of n.causes ?? []) {
        if (!byId.get(cid)) continue;
        const a = nodeCenter(n.id), b = nodeCenter(cid);
        if (!a || !b) continue;
        const dir = b.x >= a.x ? 1 : -1;
        /* 端点落在圆点边缘、且**沿弧线自身的到达方向**（θ≈32°），而不是取水平极点：
           两个节点都落在轴线上，取水平极点会让尖端正好压在轴线上，看起来"连在线上"而不是
           连在节点上。沿切线方向贴边后，尖端落在圆周上、比圆心高 r·sinθ，明显离开轴线。
           两圆点重叠到贴边量互相越过时，退回水平极点 + 2px 间距，避免弧线自交/退化。 */
        const cth = Math.cos(RIM_ANGLE), sth = Math.sin(RIM_ANGLE);
        let x1 = a.x + dir * a.r * cth, y1 = a.y - a.r * sth;
        let x2 = b.x - dir * b.r * cth, y2 = b.y - b.r * sth;
        let seg = Math.abs(x2 - x1);
        if ((x2 - x1) * dir <= 0) {
          x1 = a.x + dir * 2; y1 = a.y;
          x2 = b.x - dir * 2; y2 = b.y;
          seg = Math.abs(x2 - x1);
        }
        /* 控制点随间距缩放：cdx < seg/2 不回旋。cdy 按跨距成比例（于是末端切线角度
           = cdy/cdx = RIM_ANGLE 恒定），端点因此始终以可见角度接近圆点——旧版把 cdy clamp 在
           绝对值 26px，跨距 >104px 后弧高就固定不变，缩放越大弧线越平、末端贴着轴线滑过去，
           看起来像没接到点上。上限取画布高度一半，避免跨距极大时弧线冲出画布 */
        const cdx = seg * CURVE_DX, cdy = Math.min(seg * CURVE_DY, track.clientHeight * 0.5);
        /* 联动：箭头/线宽/不透明度随间距 */
        const mSize = Math.max(3, Math.min(6, seg * 0.04));      /* 箭头大小（调细为 1/3） */
        const width = Math.max(0.8, Math.min(1.6, seg * 0.006));  /* 线宽（更细） */
        const op = Math.max(0.35, Math.min(0.9, seg / 130));
        const mid = 'lk-ca-' + (idx++);
        defsSvg += `<marker id="${mid}" markerWidth="${mSize}" markerHeight="${mSize}" refX="${mSize - 2}" refY="${mSize / 2}" orient="auto"><path d="M0,1 L${mSize - 1},${mSize / 2} L0,${mSize - 1} z" fill="var(--fg)"/></marker>`;
        pathSvg += `<path d="M ${x1} ${y1} C ${x1 + dir * cdx} ${y1 - cdy}, ${x2 - dir * cdx} ${y2 - cdy}, ${x2} ${y2}" fill="none" stroke="var(--fg)" stroke-width="${width}" opacity="${op}" marker-end="url(#${mid})"></path>`;
      }
    }
    causesSvg.innerHTML = defsSvg + pathSvg;
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
  let pendingSegs: { start: number; end: number | null }[] = [];  // 累积段
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
        <option value="">— 全览 —</option>${lineOpts}</select>`;
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
    document.getElementById('lk-line-new')?.addEventListener('click', () => {
      if (pendingSegs.length === 0) {
        /* B 步（右侧创建面板）之前：先用整条时间线的跨度做默认区段，保证「＋剧情线」立刻可见、可聚焦 */
        const ys = (timeline()?.nodes ?? []).map((nd) => nd.year ?? 0);
        if (ys.length) pendingSegs = [{ start: yearEpoch(Math.min(...ys)), end: yearEpoch(Math.max(...ys)) }];
        if (pendingSegs.length === 0) return;
      }
      const id = uid('sl');
      const tlId = activeTimelineId();
      if (!tlId) return;
      const segs = pendingSegs.slice();
      /* 走 store.update：直接 push 进 tl.storylines（那是 store.data 里的活引用）
         既不通知订阅者（tab 计数等视图停在旧值），也不进撤销栈，更不会触发落盘 */
      store.update((d) => {
        const tl2 = d.worldsets[store.activeWorld]?.timelines[tlId];
        if (!tl2) return;
        if (!tl2.storylines) tl2.storylines = [];
        tl2.storylines.push({ id, name: `剧情线 ${tl2.storylines.length + 1}`, segments: segs });
      });
      pendingSegs = [];
      activeLineId = id;
      brushing = false;
      clearBrushSel();
      renderStoryUI();
      render();
    });
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
    scaleEl.innerHTML = '';
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
}