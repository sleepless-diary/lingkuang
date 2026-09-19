/** **新建节点面板**（专用创建面板）——名字 + 年份 + 种类 + 模板字段 + 创建/取消
 *
 *  它跟 `src/ui/detail.ts` 的**节点信息面板**是两件事，刻意不复用：
 *   · 信息面板回答「这个**已经存在**的节点长什么样」（标题 / 时间 / 类型 / 精度 / 描述 /
 *     因果 / 正文 / 删除，还有演变那一套）；
 *   · 这个面板回答「新节点该是什么」—— 身份三项（名字 / 年份 / 种类）+ 该种类的**模板字段**，
 *     一次填完按「创建」落库。
 *
 *  用户 2026-09-19：「给创建节点做专门适配（创建面板要有名字/年份/种类/模板字段 + 创建/取消，
 *  不要复用节点信息面板，现在连创建按钮都没有）」。此前那一版是「点＋节点就立刻建一个叫
 *  「新节点」的节点、再打开信息面板」——名字是占位的、种类没得选、模板字段也来不及填，
 *  而且整个面板里根本没有「创建」这个动作可点。
 *
 *  模板字段复用 `src/ui/fields.ts` 的 `fieldRow()`（与信息面板 / 设定库工作台同一套控件）。
 *  已填的值先攒在本地的 `props` 字典里、**换种类时只重画控件不丢值**，等「创建」时随
 *  `addNode(..., { properties })` 一次落库（`src/store/actions.ts` 的 addNode 是 `...node`
 *  透传，properties 原样进 store；空值由 `src/main.ts` 的 `ensureAllFormatFields` 补默认值）。
 */
import type { Store } from '../store/store';
import type { Timeline, FormatField, PropValue } from '../store/types';
import { PRECISION_LABELS } from '../store/types';
import type { Calendar } from '../calendar';
import { buildYearTable, calendarOf, fromEpoch } from '../calendar';
import { addNode } from '../store/actions';
import { isImeEnter } from './keys';
import { escapeHtml } from './html';
import { enter } from './motion';
import { fieldRow } from './fields';

/** 公历平均年宽（365.25 天）。与 `src/ui/timeline.ts:100` 的坐标轴口径一致：
 *  坐标轴是公历 epoch 秒，只有「epoch 秒 → 年」的粗估才用它。 */
const SEC_PER_YEAR = 31557600;

/** 历法声明的「月数 / 单月最大天数」。
 *  `Calendar.layers` 里 `id === 'month'` 的层的 `values` 就是月长表：
 *  多元素 = 大小月（个数即月数），单元素 = 固定层（月数未声明，按 12）；
 *  `variants`（平年/闰年两套）取各套最大值。缺层时返回公历默认。 */
function monthBounds(cal: Calendar): { months: number; maxDay: number } {
  const layer = cal.layers.find((l) => l.id === 'month');
  if (!layer) return { months: 12, maxDay: 31 };
  const sets = [layer.values, ...Object.values(layer.variants ?? {})].filter((v) => v && v.length > 0);
  let months = 12;
  let maxDay = 31;
  for (const vals of sets) {
    if (vals.length > 1) months = Math.max(months, vals.length);
    maxDay = Math.max(maxDay, ...vals);
  }
  return { months, maxDay };
}

/** 时间文本解析（精简版，照抄 legacy parseTimeText）："312" / "312年7月" / "312年7月15日" */
/** 时间文本解析（支持任意分隔符）："312" / "312年7月" / "312-7-15" / "312.7.15.8.30.45" / "312/7/15"
 * 分隔符可以是 -.、/，年月日时分秒字面量。自动识别精度，返回结构化 年/月/日/时/分/秒（不再压成小数）。
 * `cal` = 该时间线的历法：上限随之放宽（自定义历法可能有 13+ 个月 / 40 天的月）。
 * **只放宽不收紧**——不传历法时与原先的公历硬编码上限完全一致。 */
export function parseTimeText(text: string, cal?: Calendar): { year: number; precision: 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second'; month?: number; day?: number; hour?: number; minute?: number; second?: number } | null {
  const t = String(text || '').trim();
  if (!t) return null;
  /* 提取所有整数（带负号：负号仅当紧邻串首或非数字字符时才算，数字间的 - 当分隔符）。
     任意非数字字符（年月日时分秒字面量、|/;~@、空格等）一律当分隔符 → 支持任意符号分隔。 */
  const nums: number[] = [];
  const re = /(^|[^\d])(-?\d+)/g;
  let m;
  while ((m = re.exec(t)) !== null) nums.push(parseInt(m[2], 10));
  if (!nums.length) return null;
  if (nums.length > 6) return null;
  if (nums.some((n) => Number.isNaN(n))) return null;
  const year = nums[0];
  const month = nums.length > 1 ? nums[1] : undefined;
  const day = nums.length > 2 ? nums[2] : undefined;
  const hour = nums.length > 3 ? nums[3] : undefined;
  const minute = nums.length > 4 ? nums[4] : undefined;
  const second = nums.length > 5 ? nums[5] : undefined;
  /* 上限：默认公历硬编码（12 / 31 / 24 / 60 / 60）。传入历法时只放宽——见函数注释 */
  const mb = cal ? monthBounds(cal) : { months: 12, maxDay: 31 };
  const maxHour = cal ? Math.max(24, cal.unit.day) : 24;
  const maxMin = cal ? Math.max(60, cal.unit.hour) : 60;
  const maxSec = cal ? Math.max(60, cal.unit.minute) : 60;
  if (month !== undefined && (month < 1 || month > mb.months)) return null;
  if (day !== undefined && (day < 1 || day > mb.maxDay)) return null;
  if (hour !== undefined && (hour < 0 || hour >= maxHour)) return null;
  if (minute !== undefined && (minute < 0 || minute >= maxMin)) return null;
  if (second !== undefined && (second < 0 || second >= maxSec)) return null;
  const precision = second !== undefined ? 'second' : minute !== undefined ? 'minute' : hour !== undefined ? 'hour' : day !== undefined ? 'day' : month !== undefined ? 'month' : 'year';
  return { year, precision, month, day, hour, minute, second };
}

/** epoch 秒 → 人类可读时间文本（"312" / "312年7月" / "312年7月15日" / "312年7月15日9时30分"）。
 *
 *  ⚠️ `world.timeCursor` 存的是 **epoch 秒**（AGENTS.md 关键坑 2），不是「小数年份」。
 *  旧实现把它当年份取整，于是时间指针一动，默认时间就填成 9 位巨型整数；
 *  直接点「确定」就把 `year ≈ 3e8` 写进节点并落盘 frontmatter，随后
 *  `src/ui/timeline.ts:307-313 fitAll()` → `buildYearTable(cal, yLo-50, yHi+50)`
 *  会 `new Array(3e8)` 再逐年后推 → 卡死 / 撑爆内存。
 *  这里改为与沙盘指针同一口径：同历法、同年表、`fromEpoch` 反推（对照 `timeline.ts:71-84 epochText`）。 */
function fmtCursorTime(cal: Calendar, tl: Timeline | undefined, epoch: number): string {
  const ys = (tl?.nodes ?? []).map((n) => n.year ?? 0);
  const guess = Math.floor(epoch / SEC_PER_YEAR);
  /* 年表覆盖节点年份范围（与 fitAll 同口径），并把 epoch 所在年固定包进去；
     窗口上限 4000 年——极端年份范围不造百万级年表 */
  let lo = Math.min(guess - 4, ys.length ? Math.min(...ys) - 50 : guess - 4);
  let hi = Math.max(guess + 4, ys.length ? Math.max(...ys) + 50 : guess + 4);
  if (hi - lo > 4000) { lo = guess - 4; hi = guess + 4; }
  const tp = fromEpoch(cal, epoch, buildYearTable(cal, lo, hi));
  const y = tp.anchor.year;
  const v = tp.values;
  const mo = v['month'] ?? 1;
  const d = v['day'] ?? 1;
  const h = v['hour'] ?? 0;
  const mi = v['minute'] ?? 0;
  const se = v['second'] ?? 0;
  const hasTime = h > 0 || mi > 0 || se > 0;
  /* 逐级只写「有信息」的部分：正好落在年初就只给年份，别把精度从「年」悄悄抬到「日」 */
  let s = String(y);
  if (mo > 1 || d > 1 || hasTime) s += `年${mo}月`;
  if (d > 1 || hasTime) s += `${d}日`;
  if (hasTime) { s += `${h}时`; if (mi > 0 || se > 0) s += `${mi}分`; }
  return s;
}

/* 这个面板的字段不多，样式就写在两处常量里，别在模板里散着调 */
const LBL = 'font-size:var(--text-xs);color:var(--fg-2);';
const INP = 'background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:6px 8px;font-size:var(--text-sm);outline:none;font-family:inherit;';

export function renderNodeForm(store: Store, host: HTMLElement, tlId: string, tlName: string): void {
  /* 默认年份 = 当前时间指针（world.timeCursor，epoch 秒）→ 该时间线历法下的人类可读文本 */
  const ws = store.data.worldsets[store.activeWorld];
  const tl = ws?.timelines[tlId];
  const cal = calendarOf(tl ?? {});
  const cursor = ws?.timeCursor;
  const defaultYear = cursor !== null && cursor !== undefined ? fmtCursorTime(cal, tl, cursor) : '';
  /* 种类（模板）：决定这个节点有哪些属性字段，也决定它在 vault 里落进哪个文件夹。
     以前这个表单完全没有入口 → 所有节点都只能是「事件」。 */
  const formats = store.data.formats ?? {};
  const kindList = Object.keys(formats).length ? Object.keys(formats) : ['事件'];
  const defKind = kindList.includes('事件') ? '事件' : kindList[0];
  const kindOpts = kindList
    .map((k) => `<option value="${escapeHtml(k)}"${k === defKind ? ' selected' : ''}>${escapeHtml(k)}（${(formats[k]?.fields ?? []).length} 个字段）</option>`)
    .join('');
  host.innerHTML = `
    <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;user-select:none;">
      <div>
        <div style="font-size:15px;font-weight:600;color:var(--fg);">新建节点</div>
        <div style="font-size:var(--text-xs);color:var(--fg-2);margin-top:2px;">建在「${escapeHtml(tlName)}」</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        <label style="${LBL}" for="nf-title">名字</label>
        <input id="nf-title" type="text" placeholder="节点名字" style="${INP}"/>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        <label style="${LBL}" for="nf-time">年份（默认 = 时间指针）</label>
        <input id="nf-time" type="text" value="${escapeHtml(defaultYear)}" placeholder="312 或 312年7月 / 312年7月15日 / 312-7-15" style="${INP}"/>
        <div id="nf-time-hint" style="font-size:10px;color:var(--fg-2);font-family:var(--font-mono);min-height:14px;"></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        <label style="${LBL}" for="nf-kind">种类（模板 · 在左栏「结构体管理」里定义）</label>
        <select id="nf-kind" style="${INP}cursor:pointer;">${kindOpts}</select>
      </div>
      <div id="nf-props" style="display:flex;flex-direction:column;gap:6px;border-top:1px dashed var(--border-soft);padding-top:8px;"></div>
      <div id="nf-err" style="font-size:var(--text-xs);color:#c0392b;display:none;"></div>
      <div style="display:flex;gap:8px;">
        <button id="nf-ok" style="flex:1;background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-sm);padding:7px;font-size:var(--text-sm);cursor:pointer;">创建</button>
        <button id="nf-cancel" style="flex:1;background:var(--surface-2);color:var(--fg-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:7px;font-size:var(--text-sm);cursor:pointer;">取消</button>
      </div>
      <details style="border-top:1px dashed var(--border-soft);padding-top:8px;">
        <summary style="${LBL}cursor:pointer;">其他（可留空 · 建完也能在信息面板里改）</summary>
        <div style="display:flex;flex-direction:column;gap:10px;padding-top:10px;">
          <div style="display:flex;flex-direction:column;gap:4px;">
            <label style="${LBL}" for="nf-type">类型</label>
            <select id="nf-type" style="${INP}cursor:pointer;">
              <option value="world_event">世界事件</option>
              <option value="story_event">剧情事件</option>
            </select>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            <label style="${LBL}" for="nf-desc">描述</label>
            <textarea id="nf-desc" placeholder="节点描述（可留空）" style="${INP}width:100%;height:56px;resize:vertical;line-height:1.5;"></textarea>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            <label style="${LBL}" for="nf-doc">正文（Markdown · #字段：值 行 + 正文）</label>
            <textarea id="nf-doc" placeholder="#事件：&#10;节点正文…" style="${INP}width:100%;height:110px;resize:vertical;font-family:var(--font-mono);line-height:1.6;"></textarea>
          </div>
        </div>
      </details>
    </div>`;

  const title = host.querySelector('#nf-title') as HTMLInputElement;
  const time = host.querySelector('#nf-time') as HTMLInputElement;
  const kindSel = host.querySelector('#nf-kind') as HTMLSelectElement;
  const propsBox = host.querySelector('#nf-props') as HTMLElement;
  const type = host.querySelector('#nf-type') as HTMLSelectElement;
  const desc = host.querySelector('#nf-desc') as HTMLTextAreaElement;
  const docBox = host.querySelector('#nf-doc') as HTMLTextAreaElement;
  const err = host.querySelector('#nf-err') as HTMLElement;

  /* 模板字段的值按**字段名**攒着：换种类只重画控件，已经填过的值不丢，
     切回去还在（用户可能先点几下种类看看各套模板长什么样） */
  const props: Record<string, PropValue> = {};

  /** 某个种类声明了哪些字段（权威 = `formats`，见 docs/ARCHITECTURE.md「种类（模板）与节点」） */
  function fieldsOf(kind: string): FormatField[] {
    return store.data.formats?.[kind]?.fields ?? [];
  }

  /** 重画模板字段区（换种类时调）。控件形态与信息面板 / 工作台共用 `fieldRow()`。 */
  function renderTemplateFields(): void {
    const kind = kindSel.value;
    const fields = fieldsOf(kind);
    propsBox.textContent = '';
    const head = document.createElement('div');
    head.style.cssText = LBL;
    head.textContent = fields.length ? `${kind} · 模板字段` : `「${kind}」这个种类还没有字段（在左栏「结构体管理」里加）`;
    propsBox.appendChild(head);
    for (const f of fields) {
      propsBox.appendChild(fieldRow(f, props[f.name], (v) => { props[f.name] = v; }, 58));
    }
  }

  function showErr(msg: string): void {
    err.textContent = msg;
    err.style.display = '';
  }

  function close(): void {
    host.innerHTML = '';
  }

  function submit(): void {
    const t = title.value.trim();
    if (!t) { showErr('名字不能为空'); title.focus(); return; }
    const parsed = parseTimeText(time.value, cal);
    if (time.value.trim() && !parsed) { showErr('年份格式：312 | 312年7月 | 312年7月15日 | 312-7-15（分隔符任意）'); return; }
    /* 只带走**当前种类模板里**的字段：换过种类时 props 里可能留着上一套的键，
       多余键虽会被 `ensureAllFormatFields` 抹掉，但没必要先写脏再清 */
    const properties: Record<string, PropValue> = {};
    for (const f of fieldsOf(kindSel.value)) {
      const v = props[f.name];
      if (v !== undefined) properties[f.name] = v;
    }
    addNode(store, tlId, {
      title: t,
      type: type.value as 'world_event' | 'story_event',
      kind: kindSel.value || undefined,   /* 种类=模板；决定它在 vault 里落进哪个文件夹 */
      year: parsed?.year ?? 0,
      precision: parsed?.precision ?? 'year',
      month: parsed?.month,
      day: parsed?.day,
      hour: parsed?.hour,
      minute: parsed?.minute,
      second: parsed?.second,
      desc: desc.value.trim() || undefined,
      doc: docBox.value,   /* 正文（Markdown） */
      properties,
    });
    close();
  }

  /* 年份输入即显示解析结果（精度/校验），不用等落库 */
  const timeHint = host.querySelector('#nf-time-hint') as HTMLElement | null;
  function updateTimeHint(): void {
    if (!timeHint) return;
    const raw = time.value.trim();
    if (!raw) { timeHint.textContent = ''; return; }
    const p = parseTimeText(raw, cal);
    if (!p) { timeHint.textContent = '⚠ 无法识别（支持 年月日时分秒 或任意分隔符）'; timeHint.style.color = 'var(--fg-2)'; return; }
    const precLabel = PRECISION_LABELS[p.precision] ?? p.precision;
    timeHint.textContent = `✅ 精度：${precLabel}（内部年=${p.year}）`;
    timeHint.style.color = 'var(--accent)';
  }

  title.focus();
  renderTemplateFields();
  kindSel.addEventListener('change', renderTemplateFields);
  time.addEventListener('input', updateTimeHint);
  updateTimeHint();

  /* 面板入场（DESIGN.md 第 7 节）。本函数是一次性的（无订阅、提交/取消即 host.innerHTML='' 关闭），
     所以直接播即可，不需要防重播。 */
  enter(host);
  host.querySelector('#nf-ok')?.addEventListener('click', submit);
  host.querySelector('#nf-cancel')?.addEventListener('click', close);
  /* 输入法组字期的回车是「上屏候选词」，不是提交（见 src/ui/keys.ts）。
     名字/年份两栏回车都等于「创建」（模板字段那几行归 fieldRow 自己管：回车=提交该字段） */
  for (const el of [title, time]) {
    el.addEventListener('keydown', (e) => { if (e.key !== 'Enter' || isImeEnter(e)) return; submit(); });
  }
}
