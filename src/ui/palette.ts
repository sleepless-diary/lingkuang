/** 命令面板 / 全局检索（Ctrl+P）—— 2026-10-19 工作流评审的 C 项
 *
 *  为什么要有它：`codex.ts` 左栏那个搜索框只认「实体名 + 节点标题」，而且必须人已经在设定库里。
 *  地图、词库、助手记忆、vault 里的散篇 md 都不在它的射程内；工具一共 11 个，也没有任何入口能"按名字跳到某条东西"。
 *  条目过了三百就只能靠记性 —— 这就是评审里说的「没有全局导航」。
 *
 *  这一版的射程（故意小，先把"跳得动"做出来）：
 *    ① 设定条目（跨世界：名字 / 别名 / 类型 / 世界）
 *    ② 时间线节点（跨世界跨线：标题 / 描述片段 / 种类）
 *    ③ 工具（按名字跳到工具）
 *  没有做的：vault 里不属于任何条目的散篇 md、地图、词库 —— 那些要么没有 id 体系、要么得走主进程列目录，
 *  留作后续（见 `docs/UI-REVIEW-2026-10-19.md`）。
 */
import type { Store } from '../store/store';
import { listTools } from '../tools/registry';
import { rememberTarget, rememberTool } from './session';
import { escapeHtml } from './html';
import type { Entity, Timeline, TimelineNode } from '../store/types';

interface Item {
  kind: 'entity' | 'node' | 'tool' | 'world';
  label: string;
  sub: string;
  /** 参与匹配的全部文本（小写） */
  hay: string;
  run(): void;
}

const MAX_ROWS = 40;

let open = false;
let backdrop: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let listEl: HTMLElement | null = null;
let current: Item[] = [];
let cursor = 0;

const TYPE_LABEL = { entity: '设定', node: '事件', tool: '工具', world: '世界集' } as const;

/** 点一下左栏那颗按钮 = 走完整条「切工具」的路（隐藏右区 / 记住工具 / 子树卸载），
 *  比自己再写一遍 openTool 安全 —— 那条路已经处理了面板型工具与工具清理函数。 */
function openToolById(id: string): void {
  const btn = document.querySelector<HTMLElement>(`#lk-toolbar [data-tool="${id}"]`);
  btn?.click();
}

function collect(store: Store): Item[] {
  const out: Item[] = [];

  /* ── 设定条目 ── */
  for (const [wName, ws] of Object.entries(store.data.worldsets)) {
    const types = (ws.entityTypes ?? {}) as Record<string, { name?: string }>;
    for (const e of Object.values((ws.entities ?? {}) as Record<string, Entity>)) {
      const typeName = types[e.typeId]?.name ?? e.typeId ?? '';
      const alias = String(e.properties?.['别名'] ?? '').trim();
      const subType = String(e.properties?.['类型'] ?? '').trim();
      const label = String(e.name ?? '').trim() || '（未命名）';
      out.push({
        kind: 'entity',
        label,
        sub: [wName, typeName, subType && subType !== typeName ? subType : '', alias ? '别名 ' + alias : '']
          .filter(Boolean).join(' · '),
        hay: [label, alias, typeName, subType, wName].join(' ').toLowerCase(),
        run: () => {
          if (store.activeWorld !== wName) store.setActiveWorld(wName);
          rememberTarget({ kind: 'entity', id: e.id });
          rememberTool('codex');
          openToolById('codex');
        },
      });
    }
  }

  /* ── 时间线节点 ── */
  for (const [wName, ws] of Object.entries(store.data.worldsets)) {
    for (const [tlId, tl] of Object.entries((ws.timelines ?? {}) as Record<string, Timeline>)) {
      for (const n of (tl.nodes ?? []) as TimelineNode[]) {
        const label = String(n.title ?? '').trim() || '（未命名事件）';
        const desc = String(n.desc ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
        const kind = n.kind || '事件';
        out.push({
          kind: 'node',
          label,
          sub: [wName, tl.name ?? tlId, kind, desc].filter(Boolean).join(' · '),
          hay: [label, desc, kind, tl.name ?? '', wName].join(' ').toLowerCase(),
          run: () => {
            if (store.activeWorld !== wName) store.setActiveWorld(wName);
            store.setActiveTimeline(tlId);
            rememberTarget({ kind: 'node', tlId, nodeId: n.id });
            rememberTool('codex');
            openToolById('codex');
          },
        });
      }
    }
  }

  /* ── 工具 ── */
  for (const t of listTools()) {
    out.push({
      kind: 'tool',
      label: t.name,
      sub: '工具 · ' + (t.panel ? '面板' : '页'),
      hay: (t.name + ' ' + t.id).toLowerCase(),
      run: () => openToolById(t.id),
    });
  }

  /* ── 世界集（换世界：多世界时比点世界栏快） ── */
  for (const wName of Object.keys(store.data.worldsets)) {
    out.push({
      kind: 'world',
      label: wName,
      sub: '世界集 · 切到这个世界',
      hay: wName.toLowerCase(),
      run: () => { store.setActiveWorld(wName); },
    });
  }
  return out;
}

/** 打分：完全相等 > 前缀 > 词首 > 包含；同分按 kind 顺序（设定 > 事件 > 工具 > 世界集） */
function score(it: Item, q: string): number {
  const label = it.label.toLowerCase();
  if (label === q) return 100;
  if (label.startsWith(q)) return 80;
  if (it.hay.includes(q)) return 50;
  return 0;
}

export function isPaletteOpen(): boolean { return open; }

export function togglePalette(store: Store): void {
  if (open) { closePalette(); return; }
  render(store);
}

export function closePalette(): void {
  open = false;
  backdrop?.remove();
  backdrop = null;
  inputEl = null;
  listEl = null;
  current = [];
  cursor = 0;
}

function render(store: Store): void {
  closePalette();
  open = true;
  const all = collect(store);

  backdrop = document.createElement('div');
  backdrop.className = 'lk-palette';
  backdrop.innerHTML = `
    <div class="lk-palette__box" role="dialog" aria-label="命令面板">
      <input id="lk-palette-input" class="lk-palette__input" type="text" placeholder="跳到哪里…（设定、事件、工具；Esc 关闭）" autocomplete="off" spellcheck="false" />
      <div id="lk-palette-list" class="lk-palette__list"></div>
      <div class="lk-palette__foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> 选 · <kbd>Enter</kbd> 去 · <kbd>Esc</kbd> 关</span>
        <span id="lk-palette-cnt" class="lk-palette__cnt"></span>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  inputEl = backdrop.querySelector('#lk-palette-input') as HTMLInputElement;
  listEl = backdrop.querySelector('#lk-palette-list') as HTMLElement;
  const cntEl = backdrop.querySelector('#lk-palette-cnt') as HTMLElement;

  const draw = (): void => {
    const q = (inputEl?.value ?? '').trim().toLowerCase();
    current = q
      ? all.map((it) => ({ it, s: score(it, q) })).filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s || a.it.kind.localeCompare(b.it.kind))
          .slice(0, MAX_ROWS).map((x) => x.it)
      : all.slice(0, MAX_ROWS);
    cursor = Math.min(cursor, Math.max(0, current.length - 1));
    if (!listEl) return;
    listEl.innerHTML = current.length
      ? current.map((it, i) => `
        <div class="lk-palette__row${i === cursor ? ' is-on' : ''}" data-i="${i}">
          <span class="lk-palette__kind">${TYPE_LABEL[it.kind]}</span>
          <span class="lk-palette__label">${escapeHtml(it.label)}</span>
          <span class="lk-palette__sub">${escapeHtml(it.sub)}</span>
        </div>`).join('')
      : '<div class="lk-palette__empty">没有匹配的条目。试试设定名、事件标题，或「设定库」「地图生成」这样的工具名。</div>';
    cntEl.textContent = q ? `${current.length} 条匹配` : `共 ${all.length} 条`;
  };

  const go = (i: number): void => {
    const it = current[i];
    if (!it) return;
    closePalette();
    try { it.run(); } catch { /* 跳不过去就当无事发生，别把面板挂死 */ }
  };

  inputEl.addEventListener('input', () => { cursor = 0; draw(); });
  inputEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); cursor = Math.min(cursor + 1, current.length - 1); redraw(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); cursor = Math.max(cursor - 1, 0); redraw(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); go(cursor); }
    else if (ev.key === 'Escape') { ev.preventDefault(); closePalette(); }
  });
  /* 行内点击（鼠标党） */
  listEl.addEventListener('click', (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (row) go(Number(row.dataset.i ?? 0));
  });
  /* 点空白关掉 */
  backdrop.addEventListener('mousedown', (ev) => { if (ev.target === backdrop) closePalette(); });

  const redraw = (): void => {
    if (!listEl) return;
    listEl.querySelectorAll<HTMLElement>('.lk-palette__row').forEach((el, i) => el.classList.toggle('is-on', i === cursor));
    listEl.querySelector<HTMLElement>('.lk-palette__row.is-on')?.scrollIntoView({ block: 'nearest' });
  };

  draw();
  inputEl.focus();
}

/* Esc 的兜底：焦点不在输入框里（比如点过列表再按方向键）时也能关 */
window.addEventListener('keydown', (ev) => {
  if (!open) return;
  if (ev.key === 'Escape') { ev.preventDefault(); closePalette(); }
}, true);
