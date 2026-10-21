/** 素材库 —— 词库浏览器（`data/character_lib.json`，58 分类 ~4669 词条，萌百来源 CC BY-NC-SA）
 *
 *  2026-10-19 工作流评审里它是「死入口」：`src/tools/register.ts` 里 `library` 一直是
 *  `placeholder: true`，点开只有一句"功能未做"。而词库其实是这个应用里**体量最大的一份素材**
 *  （只有灵感触发器在用，且只能随机抽，不能挑）。
 *
 *  这一版只做三件事，别加功能：
 *    ① 按分类看全库、按关键词搜（跨分类）
 *    ② 点一个词 → 进「选中词条」（`src/ui/intake.ts` 的暂存词）→ 那边可以建实体或让 AI 提炼
 *    ③ 告诉人暂存词在哪看（不然点了"加入"没反应，像是坏了）
 *
 *  不做：编辑词库、分词/归类（那是联想画布的「导出暂存词」那条路）。词库是 CC BY-NC-SA，
 *  编辑它会牵扯到许可证与上游合并，不在本轮范围。
 */
import { pushStaged } from './intake';
import { escapeHtml } from './html';

type Lib = Record<string, string[]>;

let cache: Lib | null = null;

async function loadLib(): Promise<Lib | null> {
  if (cache) return cache;
  /* 与 `inspire.ts` 同一口径：**先走主进程**（`loadCharLib` 读的是项目根 / 随包种子的
     `data/character_lib.json`），再退回 fetch。
     ⚠️ 生产构建里 `app-dist/` 并没有 `data/` 目录（vite 只打 src），所以只写 fetch 的话
     打出来的应用里这一页永远是"词库没加载出来"。 */
  const api = (window as unknown as { lingkuangAPI?: { loadCharLib?: () => Promise<{ ok?: boolean; data?: Lib }> } }).lingkuangAPI;
  try {
    const res = api?.loadCharLib ? await api.loadCharLib() : null;
    if (res?.ok && res.data) cache = res.data;
  } catch { /* fallthrough */ }
  if (!cache) {
    try {
      const r = await fetch('data/character_lib.json');
      if (r.ok) cache = await r.json();
    } catch { /* fallthrough */ }
  }
  return cache;
}

export async function renderLibrary(host: HTMLElement): Promise<void> {
  host.style.overflow = 'auto';
  host.innerHTML = `
    <div class="lk-page lk-page--lg" style="padding:16px 18px;display:flex;flex-direction:column;gap:10px;">
      <div>
        <div style="font-size:17px;font-weight:600;color:var(--fg);">素材库</div>
        <div style="font-size:var(--text-xs);color:var(--fg-2);line-height:1.6;margin-top:4px;">
          角色词库（来源：萌百科，CC BY-NC-SA，请勿商用）。点词右边的「＋」把它放进<b>选中词条</b> ——
          在「灵感触发器」页的联想画布上方能看到，之后可以建为设定，或让 AI 把一把词提炼成一个完整角色。
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <input id="lib-search" class="lk-input" placeholder="搜词（跨全部 58 个分类）" style="width:280px;"/>
        <span id="lib-msg" style="font-size:var(--text-xs);color:var(--fg-2);"></span>
        <span style="flex:1;"></span>
        <span id="lib-total" style="font-size:var(--text-xs);color:var(--fg-2);"></span>
      </div>
      <div style="display:flex;gap:12px;align-items:flex-start;">
        <div style="width:196px;flex-shrink:0;display:flex;flex-direction:column;gap:2px;border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px;max-height:66vh;overflow:auto;">
          <div id="lib-cats"></div>
        </div>
        <div id="lib-words" style="flex:1;min-width:0;border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px;max-height:66vh;overflow:auto;"></div>
      </div>
    </div>`;

  const catBox = host.querySelector('#lib-cats') as HTMLElement;
  const wordBox = host.querySelector('#lib-words') as HTMLElement;
  const msg = host.querySelector('#lib-msg') as HTMLElement;
  const total = host.querySelector('#lib-total') as HTMLElement;
  const search = host.querySelector('#lib-search') as HTMLInputElement;

  const lib = await loadLib();
  if (!lib) {
    wordBox.innerHTML = '<div class="lk-empty lk-empty--sm"><div class="lk-empty__title">词库没加载出来</div><div class="lk-empty__hint">找不到 <code>data/character_lib.json</code>。自己构建过 <code>app-dist</code> 的话，确认这份词库一起被拷进去了。</div></div>';
    return;
  }

  const cats = Object.keys(lib);
  let cat = cats[0] ?? '';
  let q = '';

  const say = (t: string, bad = false): void => {
    msg.textContent = t;
    msg.style.color = bad ? 'var(--danger)' : 'var(--fg-2)';
    window.setTimeout(() => { if (msg.textContent === t) msg.textContent = ''; }, 2600);
  };

  function drawCats(): void {
    catBox.innerHTML = cats.map((c) => {
      const n = (lib![c] ?? []).length;
      const hit = q && (lib![c] ?? []).some((w) => w.toLowerCase().includes(q)) ? ' has-hit' : '';
      return `<button class="lk-lib-cat${c === cat ? ' is-on' : ''}${hit}" data-cat="${escapeHtml(c)}"><span>${escapeHtml(c)}</span><span class="lk-lib-cat__n">${n}</span></button>`;
    }).join('');
    catBox.querySelectorAll<HTMLElement>('[data-cat]').forEach((el) => {
      el.addEventListener('click', () => { cat = el.dataset.cat!; q = ''; search.value = ''; drawCats(); drawWords(); });
    });
  }

  function drawWords(): void {
    const pool: { cat: string; word: string }[] = [];
    if (q) {
      for (const c of cats) for (const w of lib![c] ?? []) if (w.toLowerCase().includes(q)) pool.push({ cat: c, word: w });
    } else {
      for (const w of lib![cat] ?? []) pool.push({ cat, word: w });
    }
    total.textContent = q ? `${pool.length} 条命中` : `「${cat}」${pool.length} 条`;
    if (!pool.length) {
      wordBox.innerHTML = '<div class="lk-empty lk-empty--sm"><div class="lk-empty__title">这边没有词</div><div class="lk-empty__hint">换个关键词，或点左边别的分类。</div></div>';
      return;
    }
    wordBox.innerHTML = `<div class="lk-lib-words">${pool.slice(0, 600).map((it) => `
      <span class="lk-lib-word" title="${escapeHtml(q ? it.cat : '')}">${escapeHtml(it.word)}
        <button class="lk-lib-add" data-w="${escapeHtml(it.word)}" title="加入选中词条">＋</button>
      </span>`).join('')}</div>${pool.length > 600 ? '<div class="lk-lib-more">只画前 600 条，用搜索缩小范围。</div>' : ''}`;
    wordBox.querySelectorAll<HTMLElement>('[data-w]').forEach((el) => {
      el.addEventListener('click', () => {
        const w = el.dataset.w!;
        const n = pushStaged([w]);
        say(n ? `已加入选中词条：${w}` : `「${w}」已经在选中词条里了`);
      });
    });
  }

  search.addEventListener('input', () => {
    q = search.value.trim().toLowerCase();
    drawCats();
    drawWords();
  });

  const words = Object.values(lib).reduce((a, v) => a + v.length, 0);
  host.querySelector('#lib-total')!.textContent = `${cats.length} 分类 · ${words} 词条`;
  drawCats();
  drawWords();
}
