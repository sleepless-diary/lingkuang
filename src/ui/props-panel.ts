/** 属性面板（公共模块）——给**时间线节点**与**实体**渲染同一套可编辑属性：
 *  标题/时间（历法 scrub）/精度/类型/种类/描述 + 模板字段 + 自定义属性增删。
 *
 *  从 `src/ui/editor.ts` 抽出：编辑器与设定库（`src/ui/codex.ts`）共用这一份「改字段」实现，
 *  避免出现第二份/第三份漂移的副本。面板只认 `PropsPanelDeps`（store / 容器 / 目标身份 /
 *  写回回调），不关心调用方是哪个面板。
 *
 *  ⚠️ 两条不能动的行为约定：
 *  ① 提交后**不整块重渲染面板**（否则会销毁正在拖拽的 scrub 控件）；
 *  ② `saveProp` 每次从 store 取**最新** properties 再合并，不用构建时的快照。
 */
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import type { PropValue, TimelineNode, Entity, Timeline, TimePrecision, FieldType } from '../store/types';
import { PRECISION_ORDER, PRECISION_LABELS } from '../store/types';
import { toEpoch, fromEpoch, buildYearTable, calendarOf, timePointOf } from '../calendar';
import { isImeEnter } from './keys';
import { parseTimeText } from './node-form';

/** 面板当前编辑的对象身份（与原 editor.ts 的 Target 联合类型一致） */
export type PropsTarget =
  | { kind: 'node'; world: string; tlId: string; nodeId: string }
  | { kind: 'entity'; world: string; entityId: string };

export interface PropsPanelDeps {
  store: Store;
  /** 面板容器（原来是 editor.ts 里的 propsEl） */
  host: HTMLElement;
  /** 显示「已保存 ✓」的地方；不传就静默不写状态 */
  status?: HTMLElement | null;
  /** 当前编辑对象；返回 null 表示没有目标（面板应隐藏） */
  getTarget: () => PropsTarget | null;
  /** 把改动写回 store（撤销语义由调用方决定，editor 传它自己那个 patchTarget） */
  patchTarget: (fn: (o: any) => void) => void;
}

/** render() 收到的对象形态：节点与实体字段的并集（都是可选，调用方传各自那套） */
interface PropsNode {
  title?: string; name?: string; year?: number | string; precision?: string;
  type?: string; kind?: string; typeId?: string; desc?: string;
  properties?: Record<string, PropValue>;
  month?: number; day?: number; hour?: number; minute?: number; second?: number;
}

export interface PropsPanel {
  /** 渲染。node 参数与原 renderProps 第一个参数同形；isEntity 决定读哪套模板（节点看 formats[kind]，实体看 entityTypes[typeId]） */
  render(node: any | undefined, isEntity?: boolean): void;
  /** 隐藏面板 */
  hide(): void;
}

/** AE 式 scrub：鼠标水平拖拽 / 滚轮垂直 调整数值，shift 加大步进；可聚焦直接输入。用于数值和日期属性。 */
function createScrubField(
  cfg: { value: number; step: number; format: (v: number) => string; onCommit: (v: number) => void; min?: number; inputValue?: (v: number) => string; parse?: (s: string) => number; onInputText?: (s: string) => void; }
): HTMLElement {
  /* 控件自己记住当前值：拖动/滚轮/输入之后要累加，否则每次滚轮都从**初始值**算起 ——
     表现为「滚第二格没反应」。属性面板里所有数值/日期 scrub 都受这个影响。 */
  let value = cfg.value;
  const el = document.createElement('span');
  el.style.cssText = 'flex:1;min-width:0;display:flex;align-items:center;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);cursor:ew-resize;user-select:none;';
  const label = document.createElement('span');
  label.style.cssText = 'flex:1;padding:3px 6px;font-size:var(--text-xs);color:var(--fg);font-family:var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  label.textContent = cfg.format(value);
  el.appendChild(label);
  let dragging = false, startX = 0, startV = value, shift = false, downX = 0, moved = false, editing = false, isDown = false;
  el.addEventListener('pointerdown', (e) => {
    if (editing) return; /* 编辑态：事件交给 input，不抢拖动/单击 */
    if (e.altKey) { startInput(); return; }
    isDown = true; dragging = false; moved = false; downX = e.clientX; startX = e.clientX; startV = value; shift = e.shiftKey;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    /* 只有按住（isDown）才处理拖动；悬停移动不触发改值 */
    if (!isDown) return;
    if (Math.abs(e.clientX - downX) > 3) moved = true;
    if (!dragging && moved) { dragging = true; el.style.background = 'var(--surface)'; }
    if (!dragging) return;
    const dx = e.clientX - startX;
    const s = cfg.step * (shift ? 10 : 1);
    const v = clamp(startV + Math.round(dx) * s);
    value = v;
    cfg.onCommit(v);
    label.textContent = cfg.format(v);
  });
  el.addEventListener('pointerup', () => {
    isDown = false;
    /* 单击（按下后未拖动且未在编辑）→ 直接进入输入编辑；拖动才结束拖动态 */
    if (!moved) { if (!editing) startInput(); return; }
    if (dragging) { dragging = false; el.style.background = 'var(--surface-2)'; }
  });
  el.addEventListener('wheel', (e) => {
    e.preventDefault(); e.stopPropagation();
    const s = cfg.step * (e.shiftKey ? 10 : 1);
    const dir = e.deltaY < 0 ? 1 : -1;
    const v = clamp(value + dir * s);
    value = v;
    cfg.onCommit(v);
    label.textContent = cfg.format(v);
  }, { passive: false });
  /* 双击也保留（兼容点快时误判），与单击都进输入 */
  el.addEventListener('dblclick', (e) => { e.preventDefault(); startInput(); });
  function startInput() {
    const inp = document.createElement('input');
    inp.value = cfg.inputValue ? cfg.inputValue(value) : cfg.format(value);
    inp.style.cssText = 'flex:1;min-width:0;background:var(--surface);border:none;outline:none;color:var(--fg);font-size:var(--text-xs);font-family:var(--font-mono);padding:3px 6px;cursor:text;';
    editing = true;
    el.replaceChildren(inp);
    /* 不全选：单击进来直接落光标到末尾，立即可输入（免去"全选→取消全选"两步） */
    inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
    /* 回车提交并退出编辑；输入法组字期的回车是「上屏候选词」，不提交 */
    inp.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || isImeEnter(ev)) return;
      ev.preventDefault();
      inp.blur();
    });
    inp.addEventListener('blur', () => {
      editing = false;
      if (cfg.onInputText) { cfg.onInputText(inp.value); el.replaceChildren(label); return; }
      const n = cfg.parse ? cfg.parse(inp.value) : parseFloat(inp.value);
      if (!Number.isNaN(n)) { const v = clamp(n); value = v; cfg.onCommit(v); label.textContent = cfg.format(v); }
      el.replaceChildren(label);
    });
  }
  function clamp(v: number): number { return cfg.min !== undefined ? Math.max(cfg.min, v) : v; }
  return el;
}

/* ── 日期 scrub 辅助：YYYY-MM-DD ↔ 天数（从 1970-01-01），支持拖拽/滚轮按天调整；世界纪年暂用标准公历，预留纪元接口 ── */
const DAY_MS = 86400000;
function dateToOrd(s: string): number {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return 0;
  return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1970, 0, 1)) / DAY_MS);
}
function ordToDate(ord: number): string {
  const d = new Date(Date.UTC(1970, 0, 1) + ord * DAY_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function fmtCNDate(s: string): string {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : s;
}

/* 刻度 → 人性化显示由「时间」那一行的 fmtPrec 按节点精度生成（见 render），
   这里原先的 fmtYearDisplay 一律显示到「时」、不看精度，已删除。 */

/** 按属性类型生成值控件（数值/日期 scrub、布尔 checkbox、多选一列 checkbox、文本 input），change 回调对应 PropValue。
 *  live 用于数组控件：属性面板刻意不重渲染，若按构建时的快照 v 增删，
 *  连点两项时第二项会把第一项算回来（取消勾选 A → 存 [B,C]，再取消 B → 由旧 v 算出 [A,C]，A 复活）。 */
/** 按值生成属性控件。`declType` = 模板里**声明的**字段类型，用来覆盖「按值的 JS 类型猜」的默认行为：
 *  长文本要 textarea（而不是单行 input）、列表即使当前是空值也要走勾选列表那一支。 */
function buildPropCtrl(v: PropValue, onChange: (next: PropValue) => void, live?: () => PropValue, declType?: FieldType): HTMLElement {
  /* 长文本（模板声明）→ 多行框 */
  if (declType === 'longtext') {
    const ta = document.createElement('textarea');
    ta.value = typeof v === 'string' ? v : '';
    ta.style.cssText = 'flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-xs);outline:none;font-family:inherit;line-height:1.5;min-height:40px;resize:vertical;';
    ta.addEventListener('change', () => onChange(ta.value));
    return ta;
  }
  /* 数值 → 拖拽 + 滚轮 scrub */
  if (typeof v === 'number') {
    return createScrubField({ value: v, step: 1, format: (n) => String(n), onCommit: (n) => onChange(n) });
  }
  /* 日期 → 拖拽 + 滚轮 scrub（按天调整，显示中文年月日；标准公历，预留世界观纪年） */
  if (typeof v === 'string' && /^\d{4}-\d{1,2}-\d{1,2}$/.test(v)) {
    return createScrubField({
      value: dateToOrd(v), step: 1,
      format: (ord) => fmtCNDate(ordToDate(ord)),
      inputValue: (ord) => ordToDate(ord),
      parse: (s) => dateToOrd(s),
      onCommit: (ord) => onChange(ordToDate(ord)),
    });
  }
  /* 布尔 → 复选框 */
  if (typeof v === 'boolean') {
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = v;
    cb.style.cssText = 'width:16px;height:16px;';
    cb.addEventListener('change', () => onChange(cb.checked));
    return cb;
  }
  /* 多选（或模板声明为列表）→ 一列复选框（每项一个开关）+ 新增项 */
  if (Array.isArray(v) || declType === 'list') {
    const base: (string | number)[] = Array.isArray(v) ? v : [];
    const list = document.createElement('div');
    list.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;';
    base.forEach((item) => {
      const lab = document.createElement('label');
      lab.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:var(--text-xs);color:var(--fg);';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = String(item); cb.checked = true;
      cb.style.cssText = 'width:14px;height:14px;';
      const txt = document.createElement('span'); txt.textContent = String(item);
      cb.addEventListener('change', () => {
        /* 取消勾选 = 从列表移除该项。基于「最新值」算，而不是构建时的快照 */
        const cur = live ? live() : v;
        const arr = Array.isArray(cur) ? cur : base;
        const next = cb.checked ? [...arr, item] : arr.filter((x) => String(x) !== String(item));
        onChange(next);
      });
      lab.appendChild(cb); lab.appendChild(txt);
      list.appendChild(lab);
    });
    /* 新增一项：旧实现只能勾掉已有的项 —— 而「列表」字段刚补默认值时是空数组，
       没有任何入口能加第一项，等于这个类型没法用。 */
    const addWrap = document.createElement('div');
    addWrap.style.cssText = 'display:flex;gap:4px;align-items:center;';
    const addInp = document.createElement('input');
    addInp.placeholder = '添加一项…';
    addInp.style.cssText = 'width:96px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:2px 5px;font-size:var(--text-xs);outline:none;';
    const addBtn = document.createElement('button');
    addBtn.textContent = '＋';
    addBtn.title = '添加一项';
    addBtn.style.cssText = 'background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:2px 8px;font-size:11px;cursor:pointer;';
    const doAdd = (): void => {
      const t = addInp.value.trim();
      if (!t) return;
      const cur = live ? live() : v;
      const arr = Array.isArray(cur) ? cur : base;
      if (arr.some((x) => String(x) === t)) { addInp.value = ''; return; }
      onChange([...arr, t]);
      addInp.value = '';
      /* 面板刻意不整块重渲染（避免销毁正在编辑的控件），所以这里就地补一行勾选项让改动看得见 */
      const lab = document.createElement('label');
      lab.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:var(--text-xs);color:var(--fg);';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = t; cb.checked = true;
      cb.style.cssText = 'width:14px;height:14px;';
      cb.addEventListener('change', () => {
        const c2 = live ? live() : v;
        const a2 = Array.isArray(c2) ? c2 : base;
        onChange(cb.checked ? [...a2, t] : a2.filter((x) => String(x) !== t));
      });
      const txt2 = document.createElement('span'); txt2.textContent = t;
      lab.appendChild(cb); lab.appendChild(txt2);
      list.insertBefore(lab, addWrap);
    };
    addBtn.addEventListener('click', doAdd);
    addInp.addEventListener('keydown', (e) => { if (e.key !== 'Enter' || isImeEnter(e)) return; e.preventDefault(); doAdd(); });
    addWrap.appendChild(addInp); addWrap.appendChild(addBtn);
    list.appendChild(addWrap);
    return list;
  }
  /* 文本 → 普通输入 */
  const inp = document.createElement('input');
  inp.value = String(v ?? '');
  inp.style.cssText = 'flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-xs);outline:none;font-family:inherit;';
  inp.addEventListener('change', () => onChange(inp.value));
  return inp;
}

export function createPropsPanel(deps: PropsPanelDeps): PropsPanel {
  const { store, host, status, getTarget, patchTarget } = deps;

  /* ── 目标推导（原来闭包在 renderEditor 里）：从 getTarget() 拿身份，再从 store 取实体对象 ── */
  function targetNode(): TimelineNode | undefined {
    const t = getTarget();
    if (!t || t.kind !== 'node') return undefined;
    return store.data.worldsets[t.world]?.timelines[t.tlId]?.nodes.find((x) => x.id === t.nodeId);
  }
  function targetEntity(): Entity | undefined {
    const t = getTarget();
    if (!t || t.kind !== 'entity') return undefined;
    return store.data.worldsets[t.world]?.entities?.[t.entityId];
  }
  function targetTimeline(): Timeline | undefined {
    const t = getTarget();
    if (!t || t.kind !== 'node') return undefined;
    return store.data.worldsets[t.world]?.timelines[t.tlId];
  }
  /** 面板容器清空 + 隐藏（没有目标时） */
  function hide(): void {
    host.style.display = 'none';
    host.innerHTML = '';
  }

  /* 属性面板：显示节点/实体元数据（标题/时间/精度/类型/种类/描述）+ 模板字段 + 自定义属性增删
     （结构化属性由世界沙盘管理，编辑器与设定库共用这一份实现） */
  function render(nodeIn: any | undefined, isEntity = false): void {
    const node = nodeIn as PropsNode | undefined;
    if (!node) { hide(); return; }
    host.style.display = '';
    /* 模板里声明的字段类型（决定长文本用 textarea、列表走勾选列表那一支）：
       节点看 kind 对应的 formats，实体看它 typeId 对应的实体类型。 */
    const decl: Record<string, FieldType> = {};
    if (isEntity) {
      const t = (currentWorld(store).entityTypes ?? {})[node.typeId ?? ''];
      for (const f of t?.fields ?? []) decl[f.name] = f.type;
    } else {
      const t = store.data.formats?.[node.kind ?? '事件'];
      for (const f of t?.fields ?? []) decl[f.name] = f.type;
    }
    /* 自定义属性：可编辑（按类型控件），固定属性也用可编辑控件（年份 scrub、精度/类型下拉、标题/描述文本） */
    /* 面板构建后刻意不重渲染（避免销毁拖拽中的 scrub 控件），所以每次提交都要从 store
       取最新 properties 再合并——用构建时的 props 快照会让「改第二项」把「改第一项」覆盖回去 */
    const liveProps = (): Record<string, PropValue> => {
      const o = targetNode() ?? targetEntity();
      return o && o.properties ? o.properties : {};
    };
    const saveProp = (next: Record<string, PropValue>) => {
      patchTarget((o) => { o.properties = next; });
      if (status) status.textContent = '已保存 ✓';
      /* 不在此重渲染面板：scrub 控件自身更新显示，避免销毁拖拽中控件 */
    };
    const addPropRow = (appendTo: HTMLElement, k: string, v: PropValue): void => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0;';
      const keyEl = document.createElement('span');
      keyEl.style.cssText = 'flex-shrink:0;width:80px;font-size:var(--text-xs);color:var(--fg-2);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      keyEl.textContent = k;
      row.appendChild(keyEl);
      row.appendChild(buildPropCtrl(v, (nv) => saveProp({ ...liveProps(), [k]: nv }), () => liveProps()[k], decl[k]));
      const del = document.createElement('button'); del.textContent = '×'; del.title = '删除属性';
      del.style.cssText = 'flex-shrink:0;width:18px;height:18px;background:none;border:none;color:var(--fg-2);cursor:pointer;font-size:14px;';
      del.addEventListener('click', () => { const np = { ...liveProps() }; delete np[k]; saveProp(np); render(node, isEntity); });
      row.appendChild(del);
      appendTo.appendChild(row);
    };
    /* 固定属性也改成可编辑：标题/描述文本、年份数值 scrub、精度/类型下拉；保存写回 node 字段 */
    const saveFixed = (patch: Record<string, string>) => {
      patchTarget((o) => {
        if ('name' in o) {   /* 实体：名称 + 类型（类型=模板，决定该有哪些字段） */
          if (patch['名称'] !== undefined) o.name = patch['名称'];
          if (patch['实体类型'] !== undefined) o.typeId = patch['实体类型'];
          return;
        }
        for (const [k, v] of Object.entries(patch)) {
          if (k === '标题') o.title = v;
          else if (k === '时间') {
            const p = parseTimeText(v);
            o.year = (p?.year ?? parseFloat(v)) || 0;
            if (p) { o.precision = p.precision; o.month = p.month; o.day = p.day; o.hour = p.hour; o.minute = p.minute; o.second = p.second; }
          }
          else if (k === '精度') {
            /* 改精度必须连带补/清 month/day/hour/minute/second，规则与 src/ui/detail.ts 一致：
               变细补默认值（月/日 → 1，时/分/秒 → 0），变粗清成 undefined。
               否则「精度=年」的节点会留着上次的月/日 —— main.js 的 yearToDateStr 是「有才写」，
               照样写出 `312-07-15`，于是精度与数据互相矛盾（详情面板也因此显示「312年7月15日」）。 */
            const want = v as TimePrecision;
            const wi = PRECISION_ORDER.indexOf(want);
            o.precision = want;
            o.month = wi >= 1 ? (o.month ?? 1) : undefined;
            o.day = wi >= 2 ? (o.day ?? 1) : undefined;
            o.hour = wi >= 3 ? (o.hour ?? 0) : undefined;
            o.minute = wi >= 4 ? (o.minute ?? 0) : undefined;
            o.second = wi >= 5 ? (o.second ?? 0) : undefined;
          }
          else if (k === '类型') o.type = v as TimelineNode['type'];
          else if (k === '种类') o.kind = v || undefined;   /* 种类=模板（决定该有哪些属性字段），也是它在 vault 里的文件夹名 */
          else if (k === '描述') o.desc = v;
        }
      });
      if (status) status.textContent = '已保存 ✓';
      /* 不在此重渲染面板：scrub 控件自身更新显示，避免销毁拖拽中控件 */
    };
    /* 固定属性行：年份数值 scrub、精度/类型下拉、标题/描述文本 */
    /* 固定属性行：年份数值 scrub、精度/类型下拉、标题/描述文本、种类下拉（模板引用） */
    const fixedRows: { k: string; v: string }[] = isEntity
      ? [{ k: '名称', v: node.name ?? '' }, { k: '实体类型', v: node.typeId ?? '' }]
      : [
          { k: '标题', v: node.title ?? '' },
          { k: '时间', v: node.year !== undefined ? String(node.year) : '' },
          { k: '精度', v: node.precision ?? '' },
          { k: '类型', v: node.type ?? '' },
          { k: '种类', v: node.kind ?? '' },
        ];
    if (!isEntity) fixedRows.push({ k: '描述', v: node.desc ?? '' });
    const addFixedRow = (appendTo: HTMLElement, k: string, v: string): void => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0;';
      const keyEl = document.createElement('span');
      keyEl.style.cssText = 'flex-shrink:0;width:80px;font-size:var(--text-xs);color:var(--fg-2);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      keyEl.textContent = k;
      row.appendChild(keyEl);
      let ctrl: HTMLElement;
      if (k === '时间') {
        const tl = targetTimeline();
        const cal = calendarOf(tl ?? {});
        const daySec = cal.unit.minute * cal.unit.hour * cal.unit.day;
        const hourSec = cal.unit.minute * cal.unit.hour;
        const minuteSec = cal.unit.minute;
        const prec = (node.precision ?? 'year') as TimePrecision;
        const pi = Math.max(0, PRECISION_ORDER.indexOf(prec));
        /* 年表照契约传上（不传会退回逐年累加；内核已改成 O(1)，传了更快）。
           窗口取节点年附近即可 —— 拖动超出窗口也没关系，表只是加速，表外走闭式公式。 */
        const y0 = Math.floor(Number(node.year ?? 0));
        const table = buildYearTable(cal, y0 - 8, y0 + 8);
        const epoch = toEpoch(cal, timePointOf(Number(node.year ?? 0), { month: node.month, day: node.day, hour: node.hour, minute: node.minute, second: node.second }), table);
        /* 步长只用来把鼠标位移换算成「步数」（scrub 是「值 + 固定步长」的通用控件），
           真正的推进走下面的 stepTarget，所以这里取近似值不影响精度。
           ★ 刻度跟着**精度**走：旧写法一律按「天」，于是「年」精度的节点拖一格看不出变化，
           却把不存在的年月日写进了只有「年」的节点（312年 → 312-01-02）。 */
        const stepSec = pi === 0 ? Math.round(365.2425 * daySec)
          : pi === 1 ? Math.round((365.2425 * daySec) / 12)
            : pi === 2 ? daySec
              : pi === 3 ? hourSec
                : pi === 4 ? minuteSec
                  : 1;
        /* ★ 按「步数」在**历法**上推进，而不是在秒上累加固定步长：一年有 365/366 天，
           固定步长必然漂移 —— 曾用 365.2425 天当「一年」，碰上 366 天的闰年（312 年正是）
           连一格都推不动，年份纹丝不动。这也正是项目约定：日/月档要按真实日期推进。 */
        const stepTarget = (steps: number): number => {
          const tp0 = fromEpoch(cal, epoch, table);
          const v0 = tp0.values;
          if (pi === 0) return toEpoch(cal, timePointOf(tp0.anchor.year + steps, { month: v0.month, day: v0.day, hour: v0.hour, minute: v0.minute, second: v0.second }), table);
          if (pi === 1) {
            const mAbs = tp0.anchor.year * 12 + (v0.month - 1) + steps;
            return toEpoch(cal, timePointOf(Math.floor(mAbs / 12), { month: ((mAbs % 12) + 12) % 12 + 1, day: v0.day, hour: v0.hour, minute: v0.minute, second: v0.second }), table);
          }
          const per = pi === 2 ? daySec : pi === 3 ? hourSec : pi === 4 ? minuteSec : 1;
          return epoch + steps * per;
        };
        /* 显示与写回都只到**精度那一级**：
           ① 「精度=年」的节点不再显示成「312年1月1日」；
           ② 拖一下不会把已有的时/分/秒清掉（旧 onCommit 只拼年月日 → parseTimeText 判成「日」
              精度 → 把 hour/minute/second 置空，而精度字段又被覆盖回旧值 → 精度与数据矛盾）。 */
        const fmtPrec = (n: number): string => {
          const tp = fromEpoch(cal, n, table);
          const v = tp.values;
          let s = `${tp.anchor.year}年`;
          if (pi >= 1) s += `${v.month}月`;
          if (pi >= 2) s += `${v.day}日`;
          if (pi >= 3) s += `${v.hour}时`;
          if (pi >= 4) s += `${v.minute}分`;
          if (pi >= 5) s += `${v.second}秒`;
          return s;
        };
        /* 控件给的原始值 → 步数 → 历法目标：显示与写回都走它，
           保证「屏幕上的字」与「存进去的值」永远一致。 */
        const fmtByValue = (n: number): string => fmtPrec(stepTarget(Math.round((n - epoch) / stepSec)));
        ctrl = createScrubField({
          value: epoch, step: stepSec,
          format: fmtByValue,
          inputValue: fmtByValue, /* 输入框显示中文可读时间，parseTimeText 可解析 */
          onCommit: (n) => saveFixed({ 时间: fmtByValue(n), 精度: prec }),
          onInputText: (s) => { /* 手动输入：parseTimeText 自动识别精度（打字可以改精度） */
            const p = parseTimeText(s);
            if (p) {
              saveFixed({ 时间: s, 精度: p.precision });
              render(targetNode());
            }
          },
        });
      } else if (k === '精度') {
        const sel = document.createElement('select');
        sel.style.cssText = 'flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-xs);outline:none;';
        /* 选项文字用中文（渲染层是全中文界面，之前直接显示 year/month/day… 很突兀） */
        PRECISION_ORDER.forEach((p) => { const o = document.createElement('option'); o.value = p; o.textContent = PRECISION_LABELS[p]; sel.appendChild(o); });
        sel.value = v; sel.addEventListener('change', () => {
          saveFixed({ 精度: sel.value });
          /* 改精度后重渲染面板，让时间 scrub 的显示/步进/输入跟随新精度 */
          render(targetNode());
        });
        ctrl = sel;
      } else if (k === '种类') {
        /* 种类=模板引用：选了它，属性区就按那种类的字段渲染（模板在「结构体管理」里定义）。
           vault 里这个节点的文件夹也会跟着换（vault:write 按 kind 建目录）——
           旧文件夹那份按 id 清掉是**必须**的：两个文件夹各留一份时，重扫是同 id 后来者覆盖，
           旧文件会把种类和字段打回旧值（= 用户说的「我改的东西自己变回去了」）。
           规则见 main.js 的 dropStaleNodeFiles（第十九轮）。 */
        const sel = document.createElement('select');
        sel.style.cssText = 'flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-xs);outline:none;';
        const kinds = Object.keys(store.data.formats ?? {});
        (kinds.length ? kinds : ['事件']).forEach((kk) => { const o = document.createElement('option'); o.value = kk; o.textContent = kk; sel.appendChild(o); });
        sel.value = v && kinds.includes(v) ? v : (kinds[0] ?? '事件');
        sel.title = '种类（模板）：决定这个节点有哪些属性字段，在「结构体管理」里定义';
        sel.addEventListener('change', () => {
          saveFixed({ 种类: sel.value });
          /* 换种类后属性字段集合变了，重渲染让属性区跟上 */
          render(targetNode());
        });
        ctrl = sel;
      } else if (k === '实体类型') {
        /* 实体换类型（= 换模板）：换完要按新类型补字段 —— 派发模板变更事件，
           由 src/main.ts 的 ensureEntityLayer 统一补全（模板是唯一权威）。 */
        const sel = document.createElement('select');
        sel.style.cssText = 'flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-xs);outline:none;';
        const types = currentWorld(store).entityTypes ?? {};
        const ids = Object.keys(types);
        (ids.length ? ids : ['']).forEach((tid) => { const o = document.createElement('option'); o.value = tid; o.textContent = tid ? (types[tid].name || tid) : '（还没有类型）'; sel.appendChild(o); });
        sel.value = v && types[v] ? v : (ids[0] ?? '');
        sel.title = '实体类型（模板）：决定这个实体有哪些字段，在左栏「结构体管理」的“实体类型”里定义';
        sel.addEventListener('change', () => {
          saveFixed({ 实体类型: sel.value });
          window.dispatchEvent(new CustomEvent('lingkuang-formats-changed'));
          render(targetEntity(), true);
        });
        ctrl = sel;
      } else if (k === '类型') {
        const sel = document.createElement('select');
        sel.style.cssText = 'flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-xs);outline:none;';
        [['world_event', '世界事件'], ['story_event', '剧情事件'], ['loop-boundary', '循环边界']].forEach(([val, label]) => { const o = document.createElement('option'); o.value = val; o.textContent = label; sel.appendChild(o); });
        sel.value = v; sel.addEventListener('change', () => saveFixed({ 类型: sel.value }));
        ctrl = sel;
      } else if (k === '描述') {
        const ta = document.createElement('textarea');
        ta.value = v; ta.rows = 2;
        ta.style.cssText = 'flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-xs);outline:none;font-family:inherit;resize:vertical;';
        ta.addEventListener('change', () => saveFixed({ 描述: ta.value }));
        ctrl = ta;
      } else {
        const inp = document.createElement('input');
        inp.value = v;
        inp.style.cssText = 'flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 6px;font-size:var(--text-xs);outline:none;font-family:inherit;';
        inp.addEventListener('change', () => saveFixed({ [k]: inp.value }));
        ctrl = inp;
      }
      row.appendChild(ctrl);
      appendTo.appendChild(row);
    };
    const props = node.properties || {};
    host.innerHTML = `<div class="ed-props"></div>`;
    const box = host.querySelector('.ed-props') as HTMLElement;
    fixedRows.forEach((r) => addFixedRow(box, r.k, r.v));
    /* 格式引用：选择 kind（在 formats.json 定义应填字段）→ 按格式渲染字段 */
    /* 属性区：显示所有属性（格式字段已由 ensureAllFormatFields 补进 node.properties，起因/影响等归这里） */
    if (Object.keys(props).length) {
      const title = document.createElement('div');
      title.className = 'ed-props-title'; title.textContent = '属性';
      box.appendChild(title);
      Object.entries(props).forEach(([k, v]) => addPropRow(box, k, v));
    }
  }

  return { render, hide };
}
