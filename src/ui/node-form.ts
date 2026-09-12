/** 新建节点表单（常驻工具）——标题 + 时间文本（支持 "312" / "312年7月"）+ 类型 */
import type { Store } from '../store/store';
import type { Timeline } from '../store/types';
import { PRECISION_LABELS } from '../store/types';
import type { Calendar } from '../calendar';
import { buildYearTable, calendarOf, fromEpoch } from '../calendar';
import { addNode } from '../store/actions';
import { isImeEnter } from './keys';
import { escapeHtml } from './html';
import { enter } from './motion';

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

export function renderNodeForm(store: Store, host: HTMLElement, tlId: string, tlName: string): void {
  /* 默认时间 = 当前时间指针（world.timeCursor，epoch 秒）→ 该时间线历法下的人类可读文本 */
  const ws = store.data.worldsets[store.activeWorld];
  const tl = ws?.timelines[tlId];
  const cal = calendarOf(tl ?? {});
  const cursor = ws?.timeCursor;
  const defaultTime = cursor !== null && cursor !== undefined ? fmtCursorTime(cal, tl, cursor) : '';
  /* 种类（模板）：决定这个节点有哪些属性字段，也决定它在 vault 里落进哪个文件夹。
     以前这个表单完全没有入口 → 所有节点都只能是「事件」，角色/地点/物品/组织那几套模板用不上。 */
  const formats = store.data.formats ?? {};
  const kindList = Object.keys(formats).length ? Object.keys(formats) : ['事件'];
  const defKind = kindList.includes('事件') ? '事件' : kindList[0];
  const kindOpts = kindList
    .map((k) => `<option value="${escapeHtml(k)}"${k === defKind ? ' selected' : ''}>${escapeHtml(k)}（${(formats[k]?.fields ?? []).length} 个字段）</option>`)
    .join('');
  host.innerHTML = `
    <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;">
      <div style="font-size:15px;font-weight:600;color:var(--fg);">添加节点 · ${tlName}</div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        <label style="font-size:var(--text-xs);color:var(--fg-2);">标题</label>
        <input id="nf-title" type="text" placeholder="节点标题" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:6px 8px;font-size:var(--text-sm);outline:none;"/>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        <label style="font-size:var(--text-xs);color:var(--fg-2);">时间（默认=当前指示器）</label>
        <input id="nf-time" type="text" value="${defaultTime}" placeholder="312 或 312年7月/7月15日 或 312-7-15 或 312年7月15日9时" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:6px 8px;font-size:var(--text-sm);outline:none;"/>
        <div id="nf-time-hint" style="font-size:10px;color:var(--fg-2);font-family:var(--font-mono);min-height:14px;"></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        <label style="font-size:var(--text-xs);color:var(--fg-2);">描述</label>
        <textarea id="nf-desc" placeholder="节点描述（可留空）" style="width:100%;height:60px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:6px 8px;font-size:var(--text-sm);outline:none;resize:vertical;font-family:inherit;line-height:1.5;"></textarea>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        <label style="font-size:var(--text-xs);color:var(--fg-2);">正文（Markdown · #字段：值 行 + 正文）</label>
        <textarea id="nf-doc" placeholder="#事件：&#10;节点正文…" style="width:100%;height:120px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:6px 8px;font-size:var(--text-sm);outline:none;resize:vertical;font-family:var(--font-mono);line-height:1.6;"></textarea>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        <label style="font-size:var(--text-xs);color:var(--fg-2);">类型</label>
        <select id="nf-type" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:6px 8px;font-size:var(--text-sm);outline:none;">
          <option value="world_event">世界事件</option>
          <option value="story_event">剧情事件</option>
        </select>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        <label style="font-size:var(--text-xs);color:var(--fg-2);">种类（决定这个节点有哪些属性字段 · 在「结构体管理」里定义）</label>
        <select id="nf-kind" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:6px 8px;font-size:var(--text-sm);outline:none;">${kindOpts}</select>
      </div>
      <div style="display:flex;gap:8px;">
        <button id="nf-ok" style="flex:1;background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-sm);padding:7px;font-size:var(--text-sm);cursor:pointer;">确定</button>
        <button id="nf-cancel" style="flex:1;background:var(--surface-2);color:var(--fg-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:7px;font-size:var(--text-sm);cursor:pointer;">取消</button>
      </div>
      <div id="nf-err" style="font-size:var(--text-xs);color:#c0392b;display:none;"></div>
    </div>`;

  const title = host.querySelector('#nf-title') as HTMLInputElement;
  const time = host.querySelector('#nf-time') as HTMLInputElement;
  const type = host.querySelector('#nf-type') as HTMLSelectElement;
  const kindSel = host.querySelector('#nf-kind') as HTMLSelectElement;
  const desc = host.querySelector('#nf-desc') as HTMLTextAreaElement;
  const docBox = host.querySelector('#nf-doc') as HTMLTextAreaElement;
  const err = host.querySelector('#nf-err') as HTMLElement;
  title.focus();

  /* 创建节点时实时自动匹配时间精度：输入即显示解析结果（精度/校验），不用等落库 */
  const timeHint = host.querySelector('#nf-time-hint') as HTMLElement | null;
  function updateTimeHint() {
    if (!timeHint) return;
    const raw = time.value.trim();
    if (!raw) { timeHint.textContent = ''; return; }
    const p = parseTimeText(raw, cal);
    if (!p) { timeHint.textContent = '⚠ 无法识别（支持 年月日时分秒 或任意分隔符）'; timeHint.style.color = 'var(--fg-2)'; return; }
    const precLabel = PRECISION_LABELS[p.precision] ?? p.precision;
    timeHint.textContent = `✅ 精度：${precLabel}（内部年=${p.year}）`;
    timeHint.style.color = 'var(--accent)';
  }
  time?.addEventListener('input', updateTimeHint);
  updateTimeHint();

  function submit() {
    const t = title.value.trim();
    if (!t) { showErr('标题不能为空'); title.focus(); return; }
    const parsed = parseTimeText(time.value, cal);
    if (time.value.trim() && !parsed) { showErr('时间格式：312 | 312年7月 | 312年7月15日 | 312-7-15 或 312.7.15.8.30.45（分隔符任意）'); return; }
    addNode(store, tlId, {
      title: t,
      type: type.value as 'world_event' | 'story_event',
      kind: kindSel?.value || undefined,   /* 种类=模板；决定它在 vault 里落进哪个文件夹 */
      year: parsed?.year ?? 0,
      precision: parsed?.precision ?? 'year',
      month: parsed?.month,
      day: parsed?.day,
      hour: parsed?.hour,
      minute: parsed?.minute,
      second: parsed?.second,
      desc: desc.value.trim() || undefined,
      doc: docBox.value,   /* 正文（Markdown） */
    });
    host.innerHTML = '';
  }
  function showErr(msg: string) {
    err.textContent = msg;
    err.style.display = '';
  }
  /* 面板入场（DESIGN.md 第 7 节）。本函数是一次性的（无订阅、提交即 host.innerHTML='' 关闭），
     所以直接播即可，不需要防重播。 */
  enter(host);
  host.querySelector('#nf-ok')?.addEventListener('click', submit);
  host.querySelector('#nf-cancel')?.addEventListener('click', () => (host.innerHTML = ''));
  /* 输入法组字期的回车是「上屏候选词」，不是提交（见 src/ui/keys.ts） */
  time.addEventListener('keydown', (e) => { if (e.key !== 'Enter' || isImeEnter(e)) return; submit(); });
}
