/** 区域精细化（第一百零八轮）。
 *
 *  用户原话：「能不能加一个精细化生成的功能，把局部类型删了，改成能在地图上选一个区域
 *  进行精细化生成（也能重复生成和抽卡），生成结果留档，作为该地区的样本」。
 *
 *  产品口径（问过两轮确认）：
 *    · **底图 = 星球总图**（「局部」那个形态退场了）；在地图上拖框选一块区域，
 *      这块区域的"细节"由 mapgen4 那条内核生成（更密的网格 `spacing 3.4`）；
 *    · 一个区域**可留多版样本**，其中一版标「当前采用」—— 地图上叠它那张图；
 *    · 样本落盘 = **参数 + 一张卡片缩略图（dataURL）**（用户选的 B）；
 *    · 抽卡一次 6 张、每张可「换一颗」重抽；大图走高清出图（`map-hd.ts`）。
 *
 *  ⚠️ 样本**不是**从星球图上裁下来的：星球是球面等距圆柱、区域细节是 mapgen4 的方形网格，
 *  两套内核本来就不通用。样本的定位是"**这一带长什么样**的细化研究图"，框的位置记下来是为了
 *  "这个样本属于哪一块地"，不是像素级对齐。以后要做真对齐得另起一条管线（见 ARCHITECTURE）。
 *
 *  ⚠️ 与生成工作室（`map-studio.ts`）同形：悬浮面板、不接管主区、不改地图栏的画布。 */

import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import { uid } from '../store/ids';
import type { MapData, MapRegionDetail, MapRegionSample } from '../store/types';
import { escapeHtml } from './html';
import { nextFrame, showBusy } from './busy';
import { closeLightbox, isLightboxOpen, openLightbox } from './lightbox';
import { confirmDialog } from './confirm';
import { closeMapStudio } from './map-studio';
import { hdImageFor } from './map-hd';
import { terrainThumbUrl } from './map-terrain';
import type { MapgenSpecInput } from '../mapgen';

const BATCH = 6;
const CARD_W = 264;
const CARD_H = 147;
/** 区域样本的网格密度（主地图 4.8；越细越"精细化"，代价是三角 ×2.1、建网格慢一倍）*/
const SAMPLE_SPACING = 3.4;

export interface RefineRect { x: number; y: number; w: number; h: number }

interface State {
  regionId: string | null;
  picked: string | null;
}

let openEl: HTMLElement | null = null;
let hostStore: Store | null = null;
let unsub: (() => void) | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let state: State = { regionId: null, picked: null };
let rolling = false;

const mapOf = (store: Store): MapData | null => currentWorld(store).maps?.[0] ?? null;
const refinedOf = (m: MapData | null): MapRegionDetail[] => m?.refined ?? [];
const regionOf = (store: Store): MapRegionDetail | null => {
  const m = mapOf(store);
  if (!m || !state.regionId) return null;
  return refinedOf(m).find((r) => r.id === state.regionId) ?? null;
};
const sampleOf = (r: MapRegionDetail | null): MapRegionSample | null =>
  r ? (r.samples.find((s) => s.id === (state.picked ?? r.active)) ?? r.samples[0] ?? null) : null;

function saveRefine(store: Store, mutate: (list: MapRegionDetail[]) => void): void {
  store.update((d) => {
    const m = d.worldsets[store.activeWorld]?.maps?.[0];
    if (!m) return;
    if (!m.refined) m.refined = [];
    mutate(m.refined);
  });
}

export function isMapRefineOpen(): boolean {
  return !!openEl && document.body.contains(openEl);
}

export function closeMapRefine(): void {
  if (!openEl) return;
  unsub?.();
  unsub = null;
  if (keyHandler) { window.removeEventListener('keydown', keyHandler); keyHandler = null; }
  openEl.remove();
  openEl = null;
  hostStore = null;
  rolling = false;
  window.dispatchEvent(new CustomEvent('lingkuang-panel', { detail: { id: 'maprefine', open: false } }));
}

/** 打开（`rect` 给了就**新建**一个区域；只给 `regionId` 就编辑已有的）*/
export function openMapRefine(store: Store, opts: { regionId?: string; rect?: RefineRect }): void {
  if (isLightboxOpen()) closeLightbox();
  closeMapRefine();
  closeMapStudio();
  hostStore = store;
  state = { regionId: opts.regionId ?? null, picked: null };

  const card = document.createElement('div');
  card.id = 'lk-map-refine';
  card.className = 'lk-ms lk-rf lk-pop-in';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', '区域精细化');
  card.innerHTML = `
    <div class="lk-ms__head">
      <div class="lk-ms__title">区域精细化</div>
      <select id="rf-regions" class="lk-ms__sel" title="已框出的区域（在地图上用「细化区域」拖框可新建）"></select>
      <button id="rf-close" class="lk-ms__x" title="关闭（Esc）">×</button>
    </div>
    <div class="lk-ms__body">
      <div class="lk-ms__stage">
        <img id="rf-img" alt="" style="display:none;">
        <div id="rf-empty" class="lk-ms__empty">还没有样本</div>
      </div>
      <div id="rf-note" class="lk-ms__note"></div>
      <div class="lk-ms__row">
        <button id="rf-roll" class="lk-ms__btn is-primary">抽 6 张（这个区域）</button>
        <button id="rf-hd" class="lk-ms__btn" title="按 3072² 现算一张高清图，全窗口看细节">全窗口看高清</button>
        <button id="rf-del" class="lk-ms__btn">删除这个区域</button>
      </div>
      <div class="lk-ms__hint">一个区域可留多版：抽几张、挑一版「采用」，地图上就叠它那张图；
        其余版本在下面切换。样本只存参数 + 一张小图，不占多少地方。</div>
      <div id="rf-list" class="lk-ms__cards"></div>
    </div>`;
  document.body.appendChild(card);
  openEl = card;

  const q = <T extends HTMLElement>(sel: string) => card.querySelector(sel) as T;
  const img = q<HTMLImageElement>('#rf-img');
  const emptyEl = q<HTMLElement>('#rf-empty');
  const noteEl = q<HTMLElement>('#rf-note');
  const listEl = q<HTMLElement>('#rf-list');
  const regionsSel = q<HTMLSelectElement>('#rf-regions');
  const stageEl = q<HTMLElement>('.lk-ms__stage');
  stageEl.style.position = 'relative';
  stageEl.title = '点一下全窗口看大图（双击放大 · 滚轮缩放 · 拖动平移）';
  stageEl.addEventListener('click', () => {
    if (img.style.display === 'none' || !img.src) return;
    openLightbox({ src: img.src, title: '区域样本' });
  });

  const baseOf = (): { style: string; spec: MapgenSpecInput; view: string; lift?: string; contour?: string; w: number; h: number } => {
    const m = mapOf(store!);
    const t = m?.terrain;
    return {
      style: String(t?.style ?? 'continent'),
      spec: (t?.spec ?? {}) as MapgenSpecInput,
      view: String(t?.view ?? 'natural'),
      lift: t?.lift,
      contour: t?.contour,
      w: m?.width ?? 900,
      h: m?.height ?? 500,
    };
  };
  const sampleSpec = (): MapgenSpecInput => ({ ...baseOf().spec, spacing: SAMPLE_SPACING });
  const newSeed = (): string => '灵框-区-' + Math.random().toString(36).slice(2, 7);

  const createRegion = (rect: RefineRect): MapRegionDetail | null => {
    const m = mapOf(store);
    if (!m) return null;
    const n = refinedOf(m).length + 1;
    const region: MapRegionDetail = {
      id: uid('rf'),
      name: `区域 ${n}`,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.max(24, Math.round(rect.w)), h: Math.max(16, Math.round(rect.h)) },
      samples: [],
      createdAt: Date.now(),
    };
    saveRefine(store, (list) => { list.push(region); });
    return region;
  };

  const thumbOf = (s: MapRegionSample, w: number, h: number): Promise<string> =>
    terrainThumbUrl(
      { seed: s.seed, style: s.style, spec: s.spec, view: s.view, lift: s.lift, contour: s.contour },
      w, h, CARD_W, CARD_H, 'jpeg',
    );

  const noteOf = () => {
    const m = mapOf(store);
    const r = regionOf(store);
    if (!m || !r) { noteEl.textContent = '先在地图上用「细化区域」拖一块出来。'; return; }
    const pctW = Math.round((r.rect.w / m.width) * 100);
    const pctH = Math.round((r.rect.h / m.height) * 100);
    const active = r.samples.find((s) => s.id === r.active);
    noteEl.textContent = `${r.name} · 框在 (${r.rect.x}, ${r.rect.y}) · 占地图 ${pctW}% × ${pctH}% · `
      + `${r.samples.length} 个样本` + (active ? ` · 当前采用「${active.seed}」` : ' · 还没采用哪一版')
      + ` · 区域细节（mapgen4 网格 ${SAMPLE_SPACING}，比主图 ${4.8} 更细）`;
  };

  const renderList = () => {
    const r = regionOf(store);
    if (!r || !r.samples.length) { listEl.innerHTML = '<div class="lk-ms__dim">这个区域还没抽过。</div>'; return; }
    listEl.innerHTML = r.samples.map((s, i) => `
      <div class="lk-ms__card${s.id === (state.picked ?? r.active) ? ' is-on' : ''}" data-sample="${escapeHtml(s.id)}" title="点一下看大图">
        ${s.thumb ? `<img src="${s.thumb}" alt="">` : '<div class="lk-ms__wait">抽…</div>'}
        <div class="lk-ms__card-meta">
          <span title="${escapeHtml(s.seed)}">${i + 1}. ${escapeHtml(s.seed)}</span>
          <button class="lk-ms__mini" data-use="${escapeHtml(s.id)}" title="这一版作为这个区域当前采用">${s.id === r.active ? '已采用' : '采用'}</button>
          <button class="lk-ms__mini" data-reroll="${escapeHtml(s.id)}" title="这一张换一颗种子重抽">换</button>
        </div>
      </div>`).join('');
  };

  const renderStage = () => {
    const s = sampleOf(regionOf(store));
    const src = s?.thumb ?? '';
    img.src = src;
    img.style.display = src ? '' : 'none';
    emptyEl.style.display = src ? 'none' : '';
    emptyEl.textContent = regionOf(store)?.samples.length ? '这一版还没有缩略图' : '还没有样本';
  };

  const render = () => {
    const m = mapOf(store);
    const list = refinedOf(m);
    if (!state.regionId && list.length) state.regionId = list[0].id;
    if (state.regionId && !list.some((r) => r.id === state.regionId)) state.regionId = list[0]?.id ?? null;
    regionsSel.innerHTML = list.length
      ? list.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)} · ${r.samples.length} 版</option>`).join('')
      : '<option value="">（还没有区域）</option>';
    if (state.regionId) regionsSel.value = state.regionId;
    noteOf();
    renderList();
    renderStage();
  };

  /** 抽 N 张：先算好缩略图，再一次性落盘（不要一张一次 store.update，否则 Ctrl+Z 要按 6 下）*/
  const roll = async () => {
    if (rolling) return;
    const r = regionOf(store);
    if (!r) { noteEl.textContent = '先在地图上用「细化区域」拖一块出来。'; return; }
    rolling = true;
    const { w, h } = baseOf();
    const style = baseOf().style;
    const spec = sampleSpec();
    const view = baseOf().view;
    const lift = baseOf().lift;
    const contour = baseOf().contour;
    const b = showBusy(stageEl, '正在细化这块区域…', { sub: `网格 ${SAMPLE_SPACING} · 一次 ${BATCH} 张` });
    await nextFrame();
    const fresh: MapRegionSample[] = [];
    try {
      for (let i = 0; i < BATCH; i++) {
        const s: MapRegionSample = { id: uid('rs'), seed: newSeed(), style, spec, view, lift, contour, createdAt: Date.now() };
        b.set(`正在细化这块区域… ${i + 1}/${BATCH}`, (i + 1) / BATCH, s.seed);
        /* 每张之间让一帧：缩略图是同步的（建网格 + 生成约 150ms），不让帧连遮罩都刷不动 */
        await nextFrame();
        s.thumb = await thumbOf(s, w, h);
        fresh.push(s);
      }
    } finally {
      b.done();
      rolling = false;
    }
    const id = r.id;
    saveRefine(store, (list) => {
      const hit = list.find((x) => x.id === id);
      if (!hit) return;
      hit.samples.push(...fresh);
      state.picked = fresh[0]?.id ?? null;
    });
    render();
  };

  const reroll = async (sampleId: string) => {
    if (rolling) return;
    const r = regionOf(store);
    const s = r?.samples.find((x) => x.id === sampleId);
    if (!r || !s) return;
    rolling = true;
    const { w, h } = baseOf();
    const b = showBusy(stageEl, '换一颗种子重抽…');
    await nextFrame();
    let thumb = '';
    const seed = newSeed();
    try {
      thumb = await thumbOf({ ...s, seed }, w, h);
    } finally {
      b.done();
      rolling = false;
    }
    const rid = r.id;
    saveRefine(store, (list) => {
      const hit = list.find((x) => x.id === rid)?.samples.find((x) => x.id === sampleId);
      if (!hit) return;
      hit.seed = seed;
      hit.thumb = thumb;
      hit.createdAt = Date.now();
    });
    render();
  };

  const useSample = (sampleId: string) => {
    const rid = regionOf(store)?.id;
    if (!rid) return;
    saveRefine(store, (list) => {
      const hit = list.find((x) => x.id === rid);
      if (hit) hit.active = sampleId;
    });
    state.picked = sampleId;
    render();
  };

  const hd = async () => {
    const s = sampleOf(regionOf(store));
    if (!s) return;
    const { w, h } = baseOf();
    const b = showBusy(document.body, '正在出高清图…', { sub: '局部 3072² · 算完就还' });
    await nextFrame();
    try {
      const shot = await hdImageFor({ seed: s.seed, style: s.style, spec: s.spec, view: s.view, lift: s.lift }, w, h, (p) => {
        b.set('正在出高清图…', p.pct, p.phase);
      });
      b.done();
      if (shot.src) openLightbox({ src: shot.src, title: `区域样本 · ${s.seed}` });
    } catch (e) {
      b.done();
      console.warn('[map-refine] 高清图失败：', e);
      noteEl.textContent = '高清图出不来（详见面板与控制台）';
    }
  };

  const removeRegion = async () => {
    const r = regionOf(store);
    if (!r) return;
    const ok = await confirmDialog({
      title: '删除这个区域？',
      message: `${r.name} 与它名下的 ${r.samples.length} 个样本都会删掉（地图上的框也一起去掉）。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    const id = r.id;
    saveRefine(store, (list) => {
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) list.splice(i, 1);
    });
    state.regionId = null;
    state.picked = null;
    render();
  };

  card.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('#rf-close')) { closeMapRefine(); return; }
    if (t.closest('#rf-roll')) { void roll(); return; }
    if (t.closest('#rf-hd')) { void hd(); return; }
    if (t.closest('#rf-del')) { void removeRegion(); return; }
    const use = t.closest('[data-use]') as HTMLElement | null;
    if (use) { useSample(use.dataset.use!); return; }
    const re = t.closest('[data-reroll]') as HTMLElement | null;
    if (re) { void reroll(re.dataset.reroll!); return; }
    const sm = t.closest('[data-sample]') as HTMLElement | null;
    if (sm) { state.picked = sm.dataset.sample!; render(); return; }
  });
  regionsSel.addEventListener('change', () => {
    state.regionId = regionsSel.value || null;
    state.picked = null;
    render();
  });
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMapRefine(); };
  keyHandler = onKey;
  window.addEventListener('keydown', onKey);
  unsub = store.subscribe(() => { if (isMapRefineOpen() && hostStore) render(); });

  /* 新框出来的一块：先建区域，再照它渲染 */
  if (opts.rect) {
    const r = createRegion(opts.rect);
    if (r) { state.regionId = r.id; state.picked = null; }
  }
  render();
  window.dispatchEvent(new CustomEvent('lingkuang-panel', { detail: { id: 'maprefine', open: true } }));
}
