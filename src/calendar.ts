/** 灵框 · 历法/纪年系统（基础层，B 模型）
 *
 * 用户拍板模型（2026-08-24，docs/CALENDAR.md）：
 *   - 一个层 = 一个数组，每个元素 = 该位置把上一层拆成几份（下标从 1 开始）。
 *   - 单元素 = 固定层（year:[12]、day:[24]、hour:[60]）；多元素 = 可变层（month:[31,28,31,...]）。
 *   - 单位层（物理进制，内建，一般不改）与历法层（文化设定，用户配）分开。
 *   - 并列开放：一个层既可是序列（手填数组），也可通过 switch 切换到函数（如格里高利闰年、干支）。
 *
 * 权威事实源 = 单调整数刻度（秒，排序/循环/时间指针走它）；人类可读层 = 完整序列。
 * 上层（排序/循环/时间指针）只调 width()，不关心某层是查表还是计算。
 */

/** 一个层 = 一个数组，每个元素 = 该位置把上一层拆成几份（下标从 1 开始）。
 *  `variants` 支持同一层多套值（平年/闰年月长），由 switch 按 anchor 年选哪套。 */
export interface Layer {
  id: string;            // 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 自定义
  values: number[];      // 单元素=固定层；多元素=可变层（大小月）。下标从 1 开始
  variants?: Record<string, number[]>;   // 如 { normal:[31,28,...], leap:[31,29,...] }
}

/** 单位层：物理进制（内建，一般不改） */
export interface UnitSystem {
  day: number;      // 一天几小时（默认 24）
  hour: number;     // 一小时几分（默认 60）
  minute: number;   // 一分几秒（默认 60）
}

/** 切换规则：周期性 cycle，决定某层用哪个变体（闰年/干支与同构） */
export interface LayerSwitch {
  id: string;
  period: number;                      // 周期：4（闰年）/ 60（干支）
  map: Record<number, string>;         // 当前值 mod period → 变体 id
  source?: string;                     // 由哪层折算（默认 anchor 年层）
  offset?: number;                     // 相位
}

/** 年号 / 纪元：一个历法可有多个，切换留给管理层 AI */
export interface Epoch {
  id: string;
  name: string;
  origin: number;        // 纪元元年 = 基准刻度的多少
}

/** 历法定义
 *  mode='function'（默认）：换算走内置函数预设（快，O(1)），list 仅作可选降级兜底；
 *  mode='table'：换算走手填列表（能表达极复杂历法，但显著降性能）。 */
export interface Calendar {
  id: string;
  name: string;                       // '白石历' | '公历'
  mode: 'function' | 'table';         // 换算主路径：函数（默认）/ 列表（降级可选项）
  fn?: string;                        // function 模式下的内建预设 id：'gregorian'|'ganzhi'|...
  anchor: { year: number } & { epochs?: Epoch[] };
  layers: Layer[];                    // 分层定义：month/day/hour/minute，每层一个数组（table 模式用）
  unit: UnitSystem;                   // 单位层（物理进制）
  switches: LayerSwitch[];            // 闰年/干支等切换
}

/** 一个时间点 = 完整序列 */
export interface TimePoint {
  anchor: { epochId?: string; year: number };
  values: Record<string, number>;     // {month:7, day:15, hour:9, ...}，键 = 层名，下标从 1 开始
}

/** 年起点累积表，years 任取 → 该年 1月1日0点的绝对刻度（O(1) 查表，替代逐年累加）。
 *  starts 下标 = year - min，starts[k] = 第 (min+k) 年起点刻度。 */
export interface YearTable {
  min: number;
  max: number;
  starts: number[];
}

/** 年表最多这么多项。表只是**加速**：查不到时 `yearStart` 走闭式公式仍是 O(1)、结果一致，
 *  所以跨度超限时**收窄窗口**，而不是硬撑 —— 见 `buildYearTable` 里的说明。 */
export const YEAR_TABLE_MAX_SPAN = 20000;

/** 构建年起点累积表（把 min..max 每年的起点刻度算好）。用于把 toEpoch/fromEpoch 降为 O(1)。
 *  ★ 跨度超限时只建前 YEAR_TABLE_MAX_SPAN 年：`fitAll`（`src/ui/timeline.ts`）传的是
 *  「节点年份最小到最大」的**整段**，世界跨度一大（手滑填了个 1e8 年，或世界观真的跨百万年）
 *  就会按跨度分配数组并逐年后推 —— 实测跨度 1e6 = 4.3ms/7MB、1e7 = 41.9ms/76MB（线性），
 *  按同斜率 1e8 约 400ms+/760MB、跨度 ≥ 2^32 直接抛 `RangeError: Invalid array length`
 *  （在 rAF 回调里抛，fit 视图永久失效）。收窄后：范围内查表，范围外走闭式公式。 */
export function buildYearTable(cal: Calendar, min: number, max: number): YearTable {
  if (max < min) max = min;
  if (max - min + 1 > YEAR_TABLE_MAX_SPAN) max = min + YEAR_TABLE_MAX_SPAN - 1;
  const size = max - min + 1;
  const starts = new Array<number>(size);
  const daySec = cal.unit.minute * cal.unit.hour * cal.unit.day;
  // 从纪元原点 0 年起点 0 出发：min 年起点直接用闭式公式（O(1)，不再逐年后推）
  starts[0] = daysBeforeYear(cal, min) * daySec;
  // 向正方向逐年后推
  for (let y = min; y < max; y++) {
    starts[y + 1 - min] = starts[y - min] + daysInYear(cal, y) * daySec;
  }
  return { min, max, starts };
}

/** 某年 1 月 1 日 0 点相对纪元原点（0 年 1 月 1 日 0 点）的**累计天数**（可为负）。
 *  function 模式走闭式公式 → O(1)；table 模式只能逐年累加（列表能表达任意历法，但慢）。
 *  ★ 必须 O(1)：`buildYearTable` 要拿它算 min 年的起点，而 `yearStart` / `fromEpoch` 的回退路径
 *  也用它。旧实现一律从 0 年逐年累加 —— 用户在「＋节点」里多敲几个数字就能冻住界面
 *  （实测年表构建耗时：1e6 年 11ms、1e7 年 119ms、按同一斜率 1e10 年约 2 分钟）。
 *  格里高利闰年累计数用 floor 除法（对负数年同样成立）：
 *  [0, y) 内闰年数 = ⌊(y+3)/4⌋ − ⌊(y+99)/100⌋ + ⌊(y+399)/400⌋ —— 与 `daysInYear` 的判定一致
 *  （0 年是 400 的倍数，所以它是闰年，这条公式把它算进去了）。负数年利用
 *  「闰年集合关于 0 对称」把 [y,0) 折到正值侧，再减掉 0 年自己。 */
function daysBeforeYear(cal: Calendar, year: number): number {
  if (cal.mode === 'table') {
    let acc = 0;
    if (year >= 0) { for (let y = 0; y < year; y++) acc += daysInYear(cal, y); }
    else { for (let y = 0; y > year; y--) acc -= daysInYear(cal, y - 1); }
    return acc;
  }
  switch (cal.fn) {
    case 'gregorian': {
      const leapsBefore = (y: number) => Math.floor((y + 3) / 4) - Math.floor((y + 99) / 100) + Math.floor((y + 399) / 400);
      const n = year >= 0 ? leapsBefore(year) : -(leapsBefore(1 - year) - 1);
      return 365 * year + n;
    }
    case 'fixed365': return 365 * year;
    case 'fixed360': return 360 * year;
    default: return 360 * year;
  }
}

/** 查某年起点刻度：在表范围内 O(1)，范围外回退到 O(1) 的闭式公式 */
function yearStart(cal: Calendar, table: YearTable | undefined, year: number, daySec: number): number {
  if (table) {
    if (year >= table.min && year <= table.max) return table.starts[year - table.min];
  }
  return daysBeforeYear(cal, year) * daySec;
}

/* ── 基础查询 ── */

/** 由 anchor 年 + switch 决定当前用哪个变体 id（如 'leap'/'normal'）；无 switch 返回 undefined */
function variantOf(cal: Calendar, anchorYear: number): string | undefined {
  const sw = cal.switches.find((s) => (s.source === undefined || s.source === 'year') && (s.map && Object.values(s.map).length > 0));
  if (!sw) return undefined;
  const key = ((anchorYear + (sw.offset ?? 0)) % sw.period + sw.period) % sw.period;
  return sw.map[key];
}

/** 取某层的取值数组（按 anchor 年选变体） */
function layerValues(cal: Calendar, layer: string, anchorYear: number): number[] {
  const l = cal.layers.find((x) => x.id === layer);
  if (!l) return [];
  const v = variantOf(cal, anchorYear);
  if (v && l.variants && l.variants[v]) return l.variants[v];
  return l.values;
}

/** 【并列开放】某层第 idx 个位置往下拆几份（统一接口；默认查数组，可 override 成函数） */
export function width(
  cal: Calendar,
  layer: string,
  idx: number,
  anchorYear: number,
  resolver?: (layer: string, idx: number, anchorYear: number) => number,
): number {
  if (resolver) {
    const v = resolver(layer, idx, anchorYear);
    if (v !== undefined) return v;
  }
  const vals = layerValues(cal, layer, anchorYear);
  // 单元素数组：所有位置共用该元素（固定层）。多元素数组：下标从 1 开始，越界回退到最后一个。
  if (vals.length === 0) return 0;
  if (vals.length === 1) return vals[0];
  const i = Math.min(Math.max(idx, 1), vals.length);
  return vals[i - 1];
}

/* ── 换算 ── */

/** 内置函数预设：某年某月有几天。按 cal.fn 选预设；未匹配时回退到固定 30/365 兜底。 */
function fnDaysInMonth(cal: Calendar, year: number, month: number): number {
  switch (cal.fn) {
    case 'gregorian': {
      // 格里高利闰年：4的倍数且(非百或400的倍数)· 月长表为平年基础，闰年2月+1
      const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
      const base = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (month < 1 || month > 12) return 0;
      return base[month - 1] + (month === 2 && isLeap(year) ? 1 : 0);
    }
    case 'fixed365': {
      const base = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (month < 1 || month > 12) return 0;
      return base[month - 1];
    }
    case 'fixed360': {
      // 白石历：12 个月，每月 30 天
      if (month < 1 || month > 12) return 0;
      return 30;
    }
    default:
      // 无预设时兜底：每层值(30)或 365/12 粗略，尽力不崩
      return 30;
  }
}

/** 该年某月有几天：function 模式走函数预设（快），table 模式查列表（降级） */
function daysInMonth(cal: Calendar, year: number, month: number): number {
  if (cal.mode === 'table') return width(cal, 'month', month, year);
  return fnDaysInMonth(cal, year, month);
}

/** 该年总天数：function 模式用预设年宽，table 模式累加月长表 */
function daysInYear(cal: Calendar, year: number): number {
  if (cal.mode === 'table') {
    const monthVals = layerValues(cal, 'month', year);
    if (monthVals.length === 0) return 0;
    let sum = 0;
    for (let m = 1; m <= monthVals.length; m++) sum += daysInMonth(cal, year, m);
    return sum;
  }
  // function 模式：预设年宽
  switch (cal.fn) {
    case 'gregorian': return ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) ? 366 : 365;
    case 'fixed365': return 365;
    case 'fixed360': return 360;
    default: return 360;
  }
}

/** 平均年宽（天）：仅用于 `fromEpoch` 回退路径**估**一个年，估完还有精调。
 *  用真实均值而不是 daysInYear(0)：公历用 366 会偏 0.2%，在超大年份上放大成几千万年的误差，
 *  ±1 逼近就退化成 O(误差)（实测 1e10 年要 348ms）。 */
function avgDaysInYear(cal: Calendar): number {
  if (cal.mode === 'table') return Math.max(1, daysInYear(cal, 0));
  switch (cal.fn) {
    case 'gregorian': return 365.2425;
    case 'fixed365': return 365;
    case 'fixed360': return 360;
    default: return 360;
  }
}

/** 完整序列 → 单调整数刻度（秒）。年月日逐层累加（下标从 1），无浮点。
 *  传入 yearTable 则年部分 O(1) 查表，否则回退逐年累加。 */
export function toEpoch(cal: Calendar, tp: TimePoint, table?: YearTable): number {
  const y = tp.anchor.year;
  const daySec = cal.unit.minute * cal.unit.hour * cal.unit.day;
  let epoch = yearStart(cal, table, y, daySec);

  // 月：前 (M-1) 个月天数之和 × 一天秒
  const month = tp.values['month'] ?? 1;
  for (let m = 1; m < month; m++) epoch += daysInMonth(cal, y, m) * daySec;
  // 日：(D-1) × 一天秒
  const day = tp.values['day'] ?? 1;
  epoch += (day - 1) * daySec;
  // 时/分/秒：H × 一小时秒 + Mi × 60 + S
  const hour = tp.values['hour'] ?? 0;
  const minute = tp.values['minute'] ?? 0;
  const second = tp.values['second'] ?? 0;
  const hourSec = cal.unit.minute * cal.unit.hour;
  /* ★ 秒必须一起加：漏掉它 toEpoch/fromEpoch 就不是严格互逆（实测 9:30:45 往返变成 9:30:00），
     而这一对函数的互逆性是「节点位置 ↔ 时间文字」的地基（精度支持到「秒」档）。 */
  epoch += hour * hourSec + minute * cal.unit.minute + second;
  return epoch;
}

/** 单调整数刻度（秒）→ 完整序列（与 toEpoch 严格互逆）。
 *  传入 yearTable 则年定位二分 O(log n)，否则回退逐年扣减。 */
export function fromEpoch(cal: Calendar, epoch: number, table?: YearTable): TimePoint {
  const daySec = cal.unit.minute * cal.unit.hour * cal.unit.day;
  const hourSec = cal.unit.minute * cal.unit.hour;
  const minuteSec = cal.unit.minute;

  // 年定位：优先二分查表（在表范围内）
  let year: number;
  let rem: number;
  if (table && epoch >= table.starts[0] && epoch < table.starts[table.starts.length - 1]) {
    // 二分找最后一个 starts[idx] <= epoch 的 idx
    let lo = 0, hi = table.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (table.starts[mid] <= epoch) lo = mid; else hi = mid - 1;
    }
    year = table.min + lo;
    rem = epoch - table.starts[lo];
  } else {
    /* 回退路径也保持 O(1)：旧实现从 0 年开始逐年扣减，年份大时卡死
       （实测 1e7 年 15ms、按同一斜率 1e10 年约 15 秒）。先用平均年宽估一个年，
       再按「差多少秒就跳多少年」迭代收敛，最后 ±1 精调 —— 不许用 ±1 逼近大误差，
       那还是 O(误差)（实测 1e10 年 348ms）。 */
    const avgSec = avgDaysInYear(cal) * daySec;
    let y = Math.floor(epoch / avgSec);
    /* table 模式没有闭式公式：把估计值夹到年表区间内，免得用巨大年份去走列表累加 */
    if (cal.mode === 'table' && table) y = Math.min(Math.max(y, table.min - 1), table.max + 1);
    let start = yearStart(cal, table, y, daySec);
    for (let i = 0; i < 8 && start > epoch; i++) {
      y -= Math.max(1, Math.round((start - epoch) / avgSec));
      start = yearStart(cal, table, y, daySec);
    }
    for (let i = 0; i < 8 && start + daysInYear(cal, y) * daySec <= epoch; i++) {
      y += Math.max(1, Math.round((epoch - start) / avgSec));
      start = yearStart(cal, table, y, daySec);
    }
    while (start > epoch) { y--; start = yearStart(cal, table, y, daySec); }
    while (start + daysInYear(cal, y) * daySec <= epoch) { y++; start = yearStart(cal, table, y, daySec); }
    year = y;
    rem = epoch - start;
  }

  // 月：逐月扣减，直到余量落进某月
  let month = 1;
  for (;;) {
    const w = daysInMonth(cal, year, month) * daySec;
    /* w <= 0 只在历法退化（该年没有这个月，如月长表取不到值）时出现；
       不挡的话 `rem >= 0` 恒真 → 死循环。 */
    if (w <= 0 || rem < w) break;
    rem -= w;
    month++;
  }
  // 日
  const day = Math.floor(rem / daySec) + 1;
  rem -= (day - 1) * daySec;
  // 时/分/秒
  const hour = Math.floor(rem / hourSec);
  rem -= hour * hourSec;
  const minute = Math.floor(rem / minuteSec);
  const second = Math.round(rem - minute * minuteSec);

  return { anchor: { year }, values: { month, day, hour, minute, second } };
}

/* ── 灵框集成 helper ── */

/** 默认历法：360 天 / 12 月 / 每月 30 天（兼容现有种子数据，无历法时兜底） */
export function defaultCalendar(): Calendar {
  return {
    id: 'default-gregorian', name: '现实公历（格里高利）', mode: 'function', fn: 'gregorian',
    anchor: { year: 0 }, unit: { day: 24, hour: 60, minute: 60 },
    layers: [],
    switches: [],
  };
}

/** 取时间线的历法：有则用之，无则默认公历（格里高利） */
export function calendarOf(tl: { calendar?: Calendar }): Calendar {
  return tl.calendar ?? defaultCalendar();
}

/** 把「存了原始年月日时分秒的字段对象」转成 TimePoint（供 toEpoch） */
export function timePointOf(
  y: number,
  fields?: { month?: number; day?: number; hour?: number; minute?: number; second?: number },
): TimePoint {
  return {
    anchor: { year: y },
    values: {
      month: fields?.month ?? 1,
      day: fields?.day ?? 1,
      hour: fields?.hour ?? 0,
      minute: fields?.minute ?? 0,
      second: fields?.second ?? 0,
    },
  };
}
