/** 灵框 · 地图生成工作室（**悬浮面板**）
 *
 *  用户 2026-10-14：「生成做成一个独立的面板吧，两种，创作者自己一个个调参数或者 AI 直出，
 *  可以抽卡（毕竟是随机生成的）」⇒ 生成控件从地图栏那一排里搬出来，单独一层面板，三个入口：
 *    · **自己调**：档位 + 陆地/岛/山脉/河/湖/陆地占比 + 种子；改动即时出预览（300ms 防抖）
 *    · **AI 直出**：一句话交给当前供应商的模型翻成参数；没配 AI / 没回出参数 ⇒ 退回关键词解析
 *      （`parseMapPrompt`，**离线也能用**）—— 解析结果**填进「自己调」那张表单**（于是三个页签是
 *      同一份参数，抽卡可以直接拿 AI 给的参数去抽）
 *    · **抽卡**：同一套参数抽 6 颗种子（也能连参数一起随机 —— 完全是随机生成，不抽白不抽），
 *      一张一张翻出来；点一张看大图、单张「换」重抽、抽过的保留 12 张翻得回去
 *  满意了才「采用到地图」—— 落盘永远只有一条路：`src/ui/map-gen.ts` 的 `generateIntoMap()`
 *  （与助手的 `generate_map` 动作**同一份实现**），一次 `store.update` ⇒ 一步 Ctrl+Z。
 *
 *  ⚠️ 与设置/助手面板一样是 `Tool.panel = true` 的**面板型**工具：**不接管主区**（正在编的条目、
 *  沙盘上的地图都留在后面），而且**不盖遮罩** —— 用户要的就是「边看地图边调」。
 *  代价：`src/tools/registry.ts` 只有一格 `disposePanel` ⇒ 面板同时只能开一个（开这个会收起
 *  设置/助手那层），这是注册表既有约定，不是这里的选择。
 *  ⚠️ 预览与抽卡都是**纯函数 + 缓存**（`src/ui/map-terrain.ts`），图不落盘：数据里只存参数。 */

import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import type { MapTerrainSpec } from '../store/types';
import { aiChat, splitReply } from './ai';
import { escapeHtml } from './html';
import {
  MAP_LIMITS, MAP_STYLES, generateIntoMap, parseMapPrompt, planGeneration, styleHint,
  type MapGenSummary, type MapPlan, type MapSpec, type MapStyle,
} from './map-gen';
import { releaseThumbs, terrainStats, terrainThumbUrl } from './map-terrain';
import { openTool } from '../tools/registry';

const BATCH = 6;      /* 一次抽几张（用户选的 6） */
const KEEP = 12;      /* 抽过的保留多少张（翻得回去） */
const DEBOUNCE = 300; /* 调参数 → 出预览的防抖 */
const PREVIEW_W = 720; /* 大图（缩略图是渲染结果缩放出来的，不是另画一遍） */
const PREVIEW_H = 400;
const CARD_W = 264;   /* 抽卡小图 */
const CARD_H = 147;

interface Cand { seed: string; style: MapStyle; spec: MapSpec; url: string }

/** 面板根，同时是「开着没开着」的唯一判据 */
let openEl: HTMLElement | null = null;
let disposeInner: (() => void) | null = null;
let hostStore: Store | null = null;

/* ⚠️ 这些是**模块级**的：关掉再开，参数与抽过的卡还在（抽卡抽到一半关掉不心疼） */
let tab: 'tune' | 'ai' | 'draw' = 'tune';
let cands: Cand[] = [];
let picked = -1;
let cur: MapPlan | null = null;
let rolling = false;
let aiBusy = false;
let dbTimer: number | null = null;

export function isMapStudioOpen(): boolean {
  return !!openEl && document.body.contains(openEl);
}

/** 关掉（没开就是空操作） */
export function closeMapStudio(): void {
  if (!openEl) return;
  const el = openEl;
  openEl = null;
  hostStore = null;
  rolling = false;
  if (dbTimer !== null) { window.clearTimeout(dbTimer); dbTimer = null; }
  disposeInner?.();
  disposeInner = null;
  releaseThumbs();   /* ⭐ 离屏视图后面挂着 WebGL 上下文（64MB 显存）—— 关面板就还回去 */
  el.remove();
  window.dispatchEvent(new CustomEvent('lingkuang-panel', { detail: { id: 'mapgen', open: false } }));
}

/** 预览上的统计行（顺手把"最长的河"也标出来 —— 内核有这条数据） */
function sumLine(s: MapGenSummary): string {
  const river = s.longestRiver > 0 ? `（最长一条 ${s.longestRiver} 格）` : '';
  return `${s.lands} 块陆地 · ${s.islands} 座岛 · ${s.zones} 个地形区 · ${s.rivers} 条河${river} · `
    + `${s.lakes} 个湖 · 最高峰约 ${s.peak} m · 陆地占 ${Math.round(s.landRatio * 100)}%`;
}

/* ── AI 直出：一句话 → 参数 JSON（认不出就退回关键词解析）───────────────────── */
const AI_SYS = '你是世界地图生成器的参数解析器。把创作者的一句话翻译成参数 JSON，'
  + '只输出一个 JSON 对象，不要解释、不要 markdown 代码块。';

function aiPrompt(desc: string): string {
  return [
    '把下面这句话翻译成地图生成参数。',
    '档位 style（三选一）：continent = 大陆／archipelago = 群岛（海岸线碎、岛多）／pangaea = 盘古（一整块超级大陆）。',
    '可选参数（没有的就不写，别硬凑）：ridges 山脊密度 1-8（越大山越多越密）、rivers 河流密度 0-4、landRatio 陆地占比 0.15-0.6。',
    '注意：**陆块数与岛数不是参数**（由档位与随机决定），别输出 lands/islands/lakes。',
    `创作者的话：${desc}`,
    '只输出形如 {"style":"archipelago","rivers":3,"landRatio":0.28} 的一行 JSON。',
  ].join('\n');
}

/** 模型回的那坨文本 → 参数（认不出返回 null ⇒ 调用方退回关键词解析）。
 *  容忍：```json 代码块、前后带说明、参数写成 `{"style":…,"spec":{…}}` 的嵌套形态、字符串数字。 */
function parseAiParams(raw: string): { style?: MapStyle; spec: MapSpec } | null {
  const t = String(raw ?? '').replace(/```[a-zA-Z]*/g, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(t.slice(a, b + 1)) as Record<string, unknown>;
  } catch { return null; }
  if (!root || typeof root !== 'object') return null;
  const inner = root.spec;
  const src = (inner && typeof inner === 'object' ? inner : root) as Record<string, unknown>;
  const styles: MapStyle[] = ['continent', 'archipelago', 'pangaea'];
  const rawStyle = root.style ?? src.style;
  const style = styles.includes(rawStyle as MapStyle) ? (rawStyle as MapStyle) : undefined;
  const spec: MapSpec = {};
  const int = (v: unknown, lo: number, hi: number): number | undefined => {
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    return Math.max(lo, Math.min(hi, Math.round(n)));
  };
  const ridges = int(src.ridges, 1, 8);        if (ridges !== undefined) spec.ridges = ridges;
  const rivers = int(src.rivers, 0, 4);        if (rivers !== undefined) spec.rivers = rivers;
  const ratio = Number(src.landRatio);
  if (Number.isFinite(ratio) && ratio > 0) spec.landRatio = Math.max(0.15, Math.min(0.6, ratio > 1 ? ratio / 100 : ratio));
  /* 档位和参数一个都没给 ⇒ 当它没回出东西（哪怕 JSON 是合法的） */
  if (style === undefined && !Object.keys(spec).length) return null;
  return { style, spec };
}

function describeParams(style: MapStyle, spec: MapSpec): string {
  const bits: string[] = [MAP_STYLES.find((s) => s.id === style)?.label ?? style];
  if (spec.ridges !== undefined) bits.push(`山脊密度 ${spec.ridges}`);
  if (spec.rivers !== undefined) bits.push(`河流密度 ${spec.rivers}`);
  if (spec.landRatio !== undefined) bits.push(`陆地占 ${Math.round(spec.landRatio * 100)}%`);
  return bits.join(' · ');
}

/** 从**地图栏**那个「生成地形…」按钮开这层（`src/ui/map.ts` 用它）。
 *  ⚠️ 必须绕一下注册表：`Tool.panel = true` 的面板型工具只有**一格** `disposePanel`，
 *  而「开第二个面板时先把上一个收起来」这件事是 `src/tools/registry.ts` 的 `openTool()` 干的。
 *  直接从地图栏调 `openMapStudio()` 的话注册表不知道这层存在 ⇒ 之后开设置/助手面板不会收起它，
 *  两块浮层会叠在一起（实测：从地图栏开的生成面板 + 设置面板同时挂着，左栏按钮也不亮）。 */
export function openMapStudioFromToolbar(store: Store): void {
  openTool('mapgen', document.createElement('div'), store);
}

/** 开面板（已经开着就先关掉重开，保证显示的是当前世界的地形）。返回清理函数。 */
export function openMapStudio(store: Store): () => void {
  closeMapStudio();
  hostStore = store;
  const card = document.createElement('div');
  card.id = 'lk-map-studio';
  card.className = 'lk-ms lk-pop-in';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', '地图生成');
  card.innerHTML = `
    <div class="lk-ms__head">
      <div class="lk-ms__title">地图生成</div>
      <div class="lk-ms__tabs">
        <button class="lk-ms__tab" data-tab="tune">自己调</button>
        <button class="lk-ms__tab" data-tab="ai">AI 直出</button>
        <button class="lk-ms__tab" data-tab="draw">抽卡</button>
      </div>
      <button id="ms-close" class="lk-ms__x" title="关闭（Esc）">×</button>
    </div>
    <div class="lk-ms__body">
      <div class="lk-ms__stage">
        <img id="ms-img" alt="" style="display:none;">
        <div id="ms-empty" class="lk-ms__empty">还没有预览</div>
      </div>
      <div id="ms-note" class="lk-ms__note"></div>

      <div class="lk-ms__sec" data-sec="tune">
        <div class="lk-ms__row">
          <label>档位</label>
          <select id="ms-style">${MAP_STYLES.map((s) => `<option value="${s.id}">${escapeHtml(s.label)}</option>`).join('')}</select>
          <span id="ms-style-hint" class="lk-ms__dim"></span>
        </div>
        <div class="lk-ms__grid">
          <label>山脊密度<input id="ms-ridges" type="number" min="1" max="8" placeholder="按档位"></label>
          <label>河流密度<input id="ms-rivers" type="number" min="0" max="4" placeholder="按档位"></label>
          <label>陆地占比（%）<input id="ms-ratio" type="number" min="15" max="60" placeholder="按档位"></label>
        </div>
        <div id="ms-limits" class="lk-ms__hint"></div>
        <div class="lk-ms__row">
          <label>种子</label>
          <input id="ms-seed" placeholder="留空 = 用「灵框」，同一颗种子永远同一片地">
          <button id="ms-reseed" class="lk-ms__btn" title="随机换一颗种子再预览">换一颗</button>
        </div>
        <div class="lk-ms__sub">手绘地形（刷子）</div>
        <div class="lk-ms__hint">生成出来的只是「底稿」—— 不满意的地方不用重新抽，去地图栏直接用刷子改：造山 / 压谷 / 浅海 / 深海。
          每一笔都能单独撤销，笔迹存在地图数据里（关掉重开还在，同一颗种子算出来还是这张图）。</div>
        <div class="lk-ms__row">
          <button id="ms-brush" class="lk-ms__btn">在地图上刷</button>
          <button id="ms-brush-clear" class="lk-ms__btn">清空笔迹</button>
          <span id="ms-brush-n" class="lk-ms__dim"></span>
        </div>
      </div>

      <div class="lk-ms__sec" data-sec="ai">
        <div class="lk-ms__hint">用一句话说你要什么地形 —— 交给当前 AI 供应商翻成参数（没配 AI 或认不出就按关键词解析）。</div>
        <textarea id="ms-desc" rows="3" placeholder="例：一片被风暴撕碎的群岛，只有两条大河，大片雪原"></textarea>
        <div class="lk-ms__row">
          <button id="ms-ai-go" class="lk-ms__btn is-primary">AI 直出</button>
          <span class="lk-ms__dim">参数会填进「自己调」那一页，三个页签共用同一份参数</span>
        </div>
      </div>

      <div class="lk-ms__sec" data-sec="draw">
        <div class="lk-ms__hint">同一套参数、换 6 颗种子 —— 挑一张顺眼的。也可以连参数一起随机。</div>
        <div class="lk-ms__row">
          <button id="ms-roll-same" class="lk-ms__btn is-primary">抽 6 张（换种子）</button>
          <button id="ms-roll-rand" class="lk-ms__btn">抽 6 张（连参数随机）</button>
          <span id="ms-draw-params" class="lk-ms__dim"></span>
        </div>
        <div id="ms-grid" class="lk-ms__cards"></div>
      </div>
    </div>
    <div class="lk-ms__foot">
      <span id="ms-state" class="lk-ms__state"></span>
      <button id="ms-apply" class="lk-ms__btn is-primary">采用到地图</button>
    </div>`;
  document.body.appendChild(card);
  openEl = card;

  const q = <T extends HTMLElement>(sel: string) => card.querySelector(sel) as T;
  const img = q<HTMLImageElement>('#ms-img');
  const emptyEl = q<HTMLElement>('#ms-empty');
  const limitsEl = q<HTMLElement>('#ms-limits');
  limitsEl.innerHTML = MAP_LIMITS.map((t) => `· ${escapeHtml(t)}`).join('<br>');
  const noteEl = q<HTMLElement>('#ms-note');
  const stateEl = q<HTMLElement>('#ms-state');
  const gridEl = q<HTMLElement>('#ms-grid');
  const styleSel = q<HTMLSelectElement>('#ms-style');
  const hintEl = q<HTMLElement>('#ms-style-hint');
  const seedEl = q<HTMLInputElement>('#ms-seed');
  const descEl = q<HTMLTextAreaElement>('#ms-desc');
  const drawParamsEl = q<HTMLElement>('#ms-draw-params');
  const inputOf = (id: string) => q<HTMLInputElement>('#' + id);
  const setState = (t: string) => { stateEl.textContent = t; };

  const dims = (): { w: number; h: number } => {
    const m = hostStore ? currentWorld(hostStore).maps?.[0] : undefined;
    return { w: m?.width ?? 900, h: m?.height ?? 500 };
  };
  const numOf = (id: string): number | undefined => {
    const v = inputOf(id).value.trim();
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  /** 表单 → 参数（空着的项 = 交给档位默认值，别写 0 —— 0 是"一个都不要"） */
  const formParams = (): { style: MapStyle; spec: MapSpec; seed: string } => {
    const style = (styleSel.value || 'continent') as MapStyle;
    const spec: MapSpec = {};
    const clampInt = (v: number | undefined, lo: number, hi: number) => (v === undefined ? undefined : Math.max(lo, Math.min(hi, Math.round(v))));
    const ridges = clampInt(numOf('ms-ridges'), 1, 8);  if (ridges !== undefined) spec.ridges = ridges;
    const rivers = clampInt(numOf('ms-rivers'), 0, 4);  if (rivers !== undefined) spec.rivers = rivers;
    const ratio = numOf('ms-ratio');                    if (ratio !== undefined) spec.landRatio = Math.max(0.15, Math.min(0.6, ratio / 100));
    return { style, spec, seed: seedEl.value.trim() };
  };
  const syncHint = () => {
    hintEl.textContent = styleHint(styleSel.value as MapStyle);
    drawParamsEl.textContent = describeParams(styleSel.value as MapStyle, formParams().spec);
  };
  const fillForm = (style: MapStyle | undefined, spec: MapSpec) => {
    if (style) styleSel.value = style;
    const put = (id: string, v: number | undefined) => { inputOf(id).value = v === undefined ? '' : String(v); };
    put('ms-ridges', spec.ridges);
    put('ms-rivers', spec.rivers);
    put('ms-ratio', spec.landRatio === undefined ? undefined : Math.round(spec.landRatio * 100));
    syncHint();
  };

  /** 出一张预览（**只画，不落盘** —— 落盘只在「采用到地图」那一下）。
   *  ⚠️ **异步**：图是内核现渲染的（要等渲染循环那一帧、再从 WebGL 读像素），
   *  所以用序号把"改完参数之前的那些请求"作废，免得旧图后到盖掉新图。 */
  let previewSeq = 0;
  const previewOf = async (p: MapPlan) => {
    cur = p;
    const { w, h } = dims();
    /* 预览要跟"采用之后的样子"一致 ⇒ 种子与档位没变时把手刷笔迹也带上（同 `generateIntoMap`） */
    const old = hostStore ? currentWorld(hostStore).maps?.[0]?.terrain : undefined;
    const keepPaint = old && old.seed === p.seed && old.style === p.style ? old.paint : undefined;
    const t: MapTerrainSpec = { seed: p.seed, style: p.style, spec: p.spec, ...(keepPaint?.length ? { paint: keepPaint } : {}) };
    const seq = ++previewSeq;
    const url = await terrainThumbUrl(t, w, h, PREVIEW_W, PREVIEW_H);
    if (seq !== previewSeq || !openEl) return;
    img.src = url;
    img.style.display = url ? '' : 'none';
    emptyEl.style.display = url ? 'none' : '';
    const s = terrainStats(t, w, h);
    noteEl.textContent = s ? `${sumLine(s)} · 种子「${p.seed}」` : `种子「${p.seed}」`;
  };
  const fromForm = () => {
    const f = formParams();
    syncHint();
    void previewOf(planGeneration({ seed: f.seed, style: f.style, spec: f.spec }));
  };
  const debounced = () => {
    if (dbTimer !== null) window.clearTimeout(dbTimer);
    dbTimer = window.setTimeout(() => { dbTimer = null; if (openEl) fromForm(); }, DEBOUNCE);
  };

  const apply = () => {
    if (!cur || !hostStore) { setState('先出一张预览，再采用。'); return; }
    const r = generateIntoMap(hostStore, { seed: cur.seed, style: cur.style, spec: cur.spec });
    setState(r.note);
    syncBrush();
  };

  /* ── 手绘地形（刷子）：面板只负责"把地图栏切到地形模式" —— 画布与指针都在地图栏
     （`src/ui/map.ts` 监听 `lingkuang-map-brush` / `lingkuang-map-clear-paint`）。
     用户定下的分工：**地形拿来看，文化分区拿来动手**；刷子就是"在看得见的底稿上动手"的另一半。 */
  const brushN = q<HTMLElement>('#ms-brush-n');
  function syncBrush(): void {
    const m = hostStore ? currentWorld(hostStore).maps?.[0] : undefined;
    const n = m?.terrain?.paint?.length ?? 0;
    brushN.textContent = m?.terrain ? (n ? `${n} 笔笔迹` : '还没有笔迹') : '这片地还没有地形';
  }
  q<HTMLButtonElement>('#ms-brush').addEventListener('click', () => {
    const m = hostStore ? currentWorld(hostStore).maps?.[0] : undefined;
    if (!m?.terrain) { setState('先在这边抽一张、点「采用到地图」，才有地可刷。'); return; }
    /* 面板 560px 宽，摆在地图栏上面 ⇒ 先把面板收掉再切刷子，否则看不到自己刷了什么 */
    window.dispatchEvent(new CustomEvent('lingkuang-map-brush', { detail: { on: true } }));
    closeMapStudio();
  });
  q<HTMLButtonElement>('#ms-brush-clear').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('lingkuang-map-clear-paint'));
    syncBrush();
    setState('笔迹已清空');
  });

  const randomSeed = () => '灵框-' + Math.random().toString(36).slice(2, 7);
  const ri = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));
  const randomParams = (): { style: MapStyle; spec: MapSpec } => {
    const styles: MapStyle[] = ['continent', 'archipelago', 'pangaea'];
    const spec: MapSpec = {
      ridges: ri(2, 8), rivers: ri(0, 4),
      landRatio: Math.round((0.2 + Math.random() * 0.28) * 100) / 100,
    };
    return { style: styles[Math.floor(Math.random() * styles.length)], spec };
  };

  const renderGrid = () => {
    if (!cands.length) {
      gridEl.innerHTML = '<div class="lk-ms__dim">还没抽过。</div>';
      return;
    }
    gridEl.innerHTML = cands.map((c, i) => `
      <div class="lk-ms__card${i === picked ? ' is-on' : ''}" data-cand="${i}" title="点一下看大图">
        ${c.url ? `<img src="${c.url}" alt="">` : '<div class="lk-ms__wait">抽…</div>'}
        <div class="lk-ms__card-meta">
          <span title="${escapeHtml(c.seed)}">${escapeHtml(c.seed)}</span>
          <button class="lk-ms__mini" data-reroll="${i}" title="这一张换一颗种子重抽">换</button>
          <button class="lk-ms__mini" data-use="${i}" title="就用这一张">用这张</button>
        </div>
      </div>`).join('');
  };
  const selectCard = (i: number) => {
    const c = cands[i];
    if (!c) return;
    picked = i;
    void previewOf({ seed: c.seed, style: c.style, spec: c.spec, matched: [] });
    renderGrid();
  };
  /** 抽一批：**一张一张地翻**（生成一张约 60~150ms，串行出图才不会整片白等） */
  const roll = (withParams: boolean) => {
    if (rolling) return;
    rolling = true;
    const base = withParams ? randomParams() : formParams();
    /* 连参数一起随机时把抽到的参数**写回表单**：不然「抽卡」那页下面标的参数与卡片对不上，
       创作者点一张卡也不知道自己抽中的是"2 块陆地 8 座岛"还是表单里那套。 */
    if (withParams) fillForm(base.style, base.spec);
    const fresh: Cand[] = [];
    for (let i = 0; i < BATCH; i++) fresh.push({ seed: randomSeed(), style: base.style, spec: { ...base.spec }, url: '' });
    cands = fresh.concat(cands).slice(0, KEEP);
    picked = 0;
    renderGrid();
    const { w, h } = dims();
    let i = 0;
    const step = async () => {
      if (!openEl) { rolling = false; return; }
      const c = fresh[i];
      c.url = await terrainThumbUrl({ seed: c.seed, style: c.style, spec: c.spec }, w, h, CARD_W, CARD_H);
      if (!openEl) { rolling = false; return; }
      renderGrid();
      setState(`抽到第 ${i + 1}/${BATCH} 张…`);
      i++;
      if (i < BATCH) window.setTimeout(() => void step(), 0);
      else {
        rolling = false;
        if (openEl) { selectCard(0); setState('点一张看大图；满意就「用这张」或底下「采用到地图」（一次 Ctrl+Z 能撤）。'); }
      }
    };
    window.setTimeout(() => void step(), 0);
  };
  const rerollOne = (i: number) => {
    const c = cands[i];
    if (!c || rolling) return;
    c.seed = randomSeed();
    c.url = '';
    renderGrid();
    const { w, h } = dims();
    window.setTimeout(async () => {
      if (!openEl) return;
      c.url = await terrainThumbUrl({ seed: c.seed, style: c.style, spec: c.spec }, w, h, CARD_W, CARD_H);
      if (!openEl) return;
      renderGrid();
      if (picked === i) selectCard(i);
    }, 0);
  };

  /** AI 直出：真调模型；模型没回出参数 / 没配 AI ⇒ 退回关键词解析（离线可用） */
  const aiGo = async () => {
    if (aiBusy) return;
    const desc = descEl.value.trim();
    if (!desc) { setState('先在上面写一句你想要的地形。'); return; }
    aiBusy = true;
    setState('正在问 AI…');
    let got: { style?: MapStyle; spec: MapSpec } | null = null;
    let err = '';
    try {
      const r = await aiChat([{ role: 'system', content: AI_SYS }, { role: 'user', content: aiPrompt(desc) }], { temperature: 0.2 });
      got = parseAiParams(splitReply(r).body);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    aiBusy = false;
    if (!openEl) return;
    const kw = parseMapPrompt(desc);
    const style = got?.style ?? kw.style ?? (styleSel.value as MapStyle);
    const spec: MapSpec = { ...kw.spec, ...(got?.spec ?? {}) };
    fillForm(style, spec);
    /* 种子 = 你这句话（同一句话 = 同一张图；想换就按「换一颗」或去抽卡）。
       ⚠️ 必须**同时写进表单**：只改 preview 的 plan 而表单里还留着上一颗种子的话，
       创作者下一次改任何参数（防抖 fromForm）就会拿表单里那颗老种子重算 —— 预览会莫名其妙跳回旧图。 */
    seedEl.value = desc;
    syncHint();
    void previewOf(planGeneration({ description: desc, seed: desc, style, spec }));
    if (got) setState(`AI 给的参数：${describeParams(style, spec)}。种子 = 你这句话；不抽一张？`);
    else if (err) setState(`没连上 AI（${err}）—— 这次按关键词解析：${describeParams(style, spec)}`);
    else if (kw.matched.length) setState(`AI 没回出参数，这次按关键词解析（${kw.matched.join('、')}）—— 结果填进「自己调」了`);
    else setState('AI 没回出参数、也没认得出关键词，用的是默认档 —— 去「自己调」改，或者再写得具体点');
  };

  const showTab = (t: 'tune' | 'ai' | 'draw') => {
    tab = t;
    card.querySelectorAll('.lk-ms__tab').forEach((b) => {
      (b as HTMLElement).classList.toggle('is-on', (b as HTMLElement).dataset.tab === t);
    });
    card.querySelectorAll('.lk-ms__sec').forEach((s) => {
      (s as HTMLElement).style.display = (s as HTMLElement).dataset.sec === t ? '' : 'none';
    });
    if (t === 'draw') { renderGrid(); syncHint(); }
  };

  /* ── 接线（事件委托：卡片区域会整块重画，逐个绑必然漏）────────────────── */
  card.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const tabBtn = t.closest('[data-tab]') as HTMLElement | null;
    if (tabBtn?.dataset.tab) { showTab(tabBtn.dataset.tab as 'tune' | 'ai' | 'draw'); return; }
    if (t.closest('#ms-close')) { closeMapStudio(); return; }
    if (t.closest('#ms-apply')) { apply(); return; }
    if (t.closest('#ms-reseed')) { seedEl.value = randomSeed(); fromForm(); setState('换了一颗种子。'); return; }
    if (t.closest('#ms-roll-same')) { roll(false); return; }
    if (t.closest('#ms-roll-rand')) { roll(true); return; }
    if (t.closest('#ms-ai-go')) { void aiGo(); return; }
    const re = t.closest('[data-reroll]') as HTMLElement | null;
    if (re) { rerollOne(Number(re.dataset.reroll)); return; }
    const use = t.closest('[data-use]') as HTMLElement | null;
    if (use) { const i = Number(use.dataset.use); selectCard(i); setState('这张已选中 —— 按底下「采用到地图」写进地图。'); return; }
    const cd = t.closest('[data-cand]') as HTMLElement | null;
    if (cd) { selectCard(Number(cd.dataset.cand)); return; }
  });
  styleSel.addEventListener('change', () => { syncHint(); fromForm(); });
  ['ms-ridges', 'ms-rivers', 'ms-ratio'].forEach((id) =>
    inputOf(id).addEventListener('input', debounced)
  );
  seedEl.addEventListener('input', debounced);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMapStudio(); };
  window.addEventListener('keydown', onKey);
  disposeInner = () => window.removeEventListener('keydown', onKey);

  /* ── 开局：这个世界已经有地形就照着它填（接着上一轮改），没有就先出一张默认预览 ──
     ⚠️ `MapTerrainSpec.style` 在 `src/store/types.ts` 里是宽 `string`（数据层不许反向依赖
     `src/ui/map-gen.ts` 的 `MapStyle`）⇒ 读回来这里收窄一次。 */
  const m = currentWorld(store).maps?.[0];
  syncBrush();
  if (m?.terrain) {
    const t = { seed: m.terrain.seed, style: m.terrain.style as MapStyle, spec: m.terrain.spec ?? {} };
    fillForm(t.style, t.spec);
    seedEl.value = t.seed;
    void previewOf({ ...t, matched: [] });
    setState(`这是「${m.name}」现在的地形 —— 改参数或抽一张，满意了再采用。`);
  } else {
    fillForm('continent', {});
    fromForm();
    setState('挑一套参数或抽几张 —— 预览满意了按「采用到地图」。');
  }
  showTab(tab);
  renderGrid();
  window.dispatchEvent(new CustomEvent('lingkuang-panel', { detail: { id: 'mapgen', open: true } }));
  return () => closeMapStudio();
}
