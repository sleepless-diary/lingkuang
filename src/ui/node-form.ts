/** 新建节点表单（常驻工具）——标题 + 时间文本（支持 "312" / "312年7月"）+ 类型 */
import type { Store } from '../store/store';
import { addNode } from '../store/actions';

/** 时间文本解析（精简版，照抄 legacy parseTimeText）："312" / "312年7月" / "312年7月15日" */
/** 时间文本解析（支持任意分隔符）："312" / "312年7月" / "312-7-15" / "312.7.15.8.30.45" / "312/7/15"
 * 分隔符可以是 -.、/，年月日时分秒字面量。自动识别精度，全部折算进小数年份。 */
export function parseTimeText(text: string): { year: number; precision: 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second'; month?: number; day?: number; hour?: number; minute?: number; second?: number } | null {
  const t = String(text || '').trim();
  if (!t) return null;
  /* 把年月日时分秒字面量和任意分隔符统一归一成 "." 便于 split */
  const norm = t
    .replace(/[年月日时分秒]/g, '.')
    .replace(/[\-\/\、,，\s·:：]+/g, '.');
  const parts = norm.split('.').filter((p) => p !== '');
  if (!parts.length) return null;
  if (parts.length > 6) return null;
  const nums = parts.map((p) => parseInt(p, 10));
  if (nums.some((n) => Number.isNaN(n))) return null;
  const year = nums[0];
  const month = nums.length > 1 ? nums[1] : undefined;
  const day = nums.length > 2 ? nums[2] : undefined;
  const hour = nums.length > 3 ? nums[3] : undefined;
  const minute = nums.length > 4 ? nums[4] : undefined;
  const second = nums.length > 5 ? nums[5] : undefined;
  if (month !== undefined && (month < 1 || month > 12)) return null;
  if (day !== undefined && (day < 1 || day > 31)) return null;
  if (hour !== undefined && (hour < 0 || hour > 23)) return null;
  if (minute !== undefined && (minute < 0 || minute > 59)) return null;
  if (second !== undefined && (second < 0 || second > 59)) return null;
  /* 全折算进小数年份；月→/12，日→/360，时→/8640(24*360)，分→/518400，秒→/31104000 */
  let y = year;
  if (month) y += (month - 1) / 12;
  if (day) y += (day - 1) / 360;
  if (hour) y += hour / 8640;
  if (minute) y += minute / 518400;
  if (second) y += second / 31104000;
  const precision = second !== undefined ? 'second' : minute !== undefined ? 'minute' : hour !== undefined ? 'hour' : day !== undefined ? 'day' : month !== undefined ? 'month' : 'year';
  return { year: Math.round(y * 1e6) / 1e6, precision, month, day, hour, minute, second };
}

/** 小数年份 → 人类可读时间文本（"312" / "312年7月" / "312年7月15日" / "312年7月15日9时30分"） */
function fmtCursorTime(y: number): string {
  const yr = Math.floor(y + 1e-9);
  const frac = y - yr;
  if (frac <= 0.001) return String(yr);
  const month = Math.floor(frac * 12) + 1;
  const rem = (frac * 12 - (month - 1)) * 30;
  const day = Math.floor(rem + 1e-6) + 1;
  if (month > 12) return String(yr);
  let s = day <= 1 ? `${yr}年${month}月` : `${yr}年${month}月${day}日`;
  /* 时/分：由小数余量推算（整天占比 1/360，时 1/8640，分 1/518400，秒 1/31104000） */
  const dayFrac = rem - (day - 1);
  if (dayFrac > 0.0001) {
    const hour = Math.floor(dayFrac * 24);
    const hourRem = (dayFrac * 24 - hour) * 60;
    const minute = Math.floor(hourRem + 1e-6);
    const second = Math.floor((hourRem - minute) * 60 + 1e-6);
    if (minute > 0 || second > 0) s += `${hour}时${minute}分`;
  }
  return s;
}

export function renderNodeForm(store: Store, host: HTMLElement, tlId: string, tlName: string): void {
  /* 默认时间 = 当前时间指针（world.timeCursor 小数年份）→ 人类可读文本 */
  const cursor = store.data.worldsets[store.activeWorld]?.timeCursor;
  const defaultTime = cursor !== null && cursor !== undefined ? fmtCursorTime(cursor) : '';
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
      <div style="display:flex;gap:8px;">
        <button id="nf-ok" style="flex:1;background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-sm);padding:7px;font-size:var(--text-sm);cursor:pointer;">确定</button>
        <button id="nf-cancel" style="flex:1;background:var(--surface-2);color:var(--fg-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:7px;font-size:var(--text-sm);cursor:pointer;">取消</button>
      </div>
      <div id="nf-err" style="font-size:var(--text-xs);color:#c0392b;display:none;"></div>
    </div>`;

  const title = host.querySelector('#nf-title') as HTMLInputElement;
  const time = host.querySelector('#nf-time') as HTMLInputElement;
  const type = host.querySelector('#nf-type') as HTMLSelectElement;
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
    const p = parseTimeText(raw);
    if (!p) { timeHint.textContent = '⚠ 无法识别（支持 年月日时分秒 或任意分隔符）'; timeHint.style.color = 'var(--fg-2)'; return; }
    const precLabel = { year: '年', month: '月', day: '日', hour: '时', minute: '分', second: '秒' }[p.precision] ?? p.precision;
    timeHint.textContent = `✅ 精度：${precLabel}（内部年=${p.year}）`;
    timeHint.style.color = 'var(--accent)';
  }
  time?.addEventListener('input', updateTimeHint);
  updateTimeHint();

  function submit() {
    const t = title.value.trim();
    if (!t) { showErr('标题不能为空'); title.focus(); return; }
    const parsed = parseTimeText(time.value);
    if (time.value.trim() && !parsed) { showErr('时间格式：312 | 312年7月 | 312年7月15日 | 312-7-15 或 312.7.15.8.30.45（分隔符任意）'); return; }
    addNode(store, tlId, {
      title: t,
      type: type.value as 'world_event' | 'story_event',
      year: parsed?.year ?? 0,
      precision: parsed?.precision ?? 'year',
      desc: desc.value.trim() || undefined,
      doc: docBox.value,   /* 正文（Markdown） */
    });
    host.innerHTML = '';
  }
  function showErr(msg: string) {
    err.textContent = msg;
    err.style.display = '';
  }
  host.querySelector('#nf-ok')?.addEventListener('click', submit);
  host.querySelector('#nf-cancel')?.addEventListener('click', () => (host.innerHTML = ''));
  time.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}
