/** 素材库 —— 两页签：① 词库浏览器 ② vault 文件浏览
 *
 *  2026-10-19 工作流评审里它是「死入口」：`src/tools/register.ts` 里 `library` 一直是
 *  `placeholder: true`，点开只有一句"功能未做"。而这两份东西其实是应用里**体量最大的素材**：
 *    · 词库 `data/character_lib.json`（61 分类 ~4669 词条，萌百 CC BY-NC-SA）—— 以前只有灵感触发器在用，且只能随机抽；
 *    · vault（默认 `F:\lingkuang-vault`，167 个文件）—— **不属于任何实体/节点的散篇笔记在灵框里根本没有入口**。
 *
 *  ① 词库页：分类列表 + 跨分类搜索 + 点「＋」进「选中词条」（`src/ui/intake.ts`）→ 可建实体或让 AI 提炼成角色。
 *  ② vault 页：目录浏览（`lingkuangAPI.fs.list`）+ 全库搜索（`fs.search`）+ 只读预览（`fs.read`）。
 *     不写盘：vault 是 Obsidian 的地盘，灵框这边只读（要改去 Obsidian，或在设定库里编那一条）。
 */
import { pushStaged } from './intake';
import { escapeHtml } from './html';

type Lib = Record<string, string[]>;
let cache: Lib | null = null;

interface FsEntry { name: string; dir: boolean; size: number; mtime: number }
interface FsApi {
  list?: (p?: string) => Promise<{ ok?: boolean; path?: string; root?: { label: string }; entries?: FsEntry[]; error?: string }>;
  read?: (p: string) => Promise<{ ok?: boolean; text?: string; path?: string; size?: number; error?: string }>;
  search?: (p: string, q: string) => Promise<{ ok?: boolean; hits?: { file: string; line: number; text: string }[]; scanned?: number; error?: string }>;
}

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

const fmtSize = (n: number): string => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
const fmtTime = (ms: number): string => {
  const d = new Date(ms);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export async function renderLibrary(host: HTMLElement): Promise<void> {
  host.style.overflow = 'auto';
  host.innerHTML = `
    <div class="lk-page lk-page--lg" style="padding:16px 18px;display:flex;flex-direction:column;gap:10px;">
      <div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:17px;font-weight:600;color:var(--fg);">素材库</span>
          <span style="display:flex;gap:4px;" id="lib-tabs">
            <button class="lk-btn lk-btn--sm" id="lib-tab-words" data-on="1">词库</button>
            <button class="lk-btn lk-btn--sm lk-btn--ghost" id="lib-tab-vault">vault 文件</button>
          </span>
          <span style="flex:1;"></span>
          <span id="lib-total" style="font-size:var(--text-xs);color:var(--fg-2);"></span>
        </div>
        <div id="lib-sub" style="font-size:var(--text-xs);color:var(--fg-2);line-height:1.6;margin-top:4px;"></div>
      </div>
      <div id="lib-words-pane" style="display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <input id="lib-search" class="lk-input" placeholder="搜词（跨全部分类）" style="width:280px;"/>
          <span id="lib-msg" style="font-size:var(--text-xs);color:var(--fg-2);"></span>
        </div>
        <div style="display:flex;gap:12px;align-items:flex-start;">
          <div style="width:196px;flex-shrink:0;display:flex;flex-direction:column;gap:2px;border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px;max-height:66vh;overflow:auto;">
            <div id="lib-cats"></div>
          </div>
          <div id="lib-words" style="flex:1;min-width:0;border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px;max-height:66vh;overflow:auto;"></div>
        </div>
      </div>
      <div id="lib-vault-pane" style="display:none;flex-direction:column;gap:8px;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <button class="lk-btn lk-btn--sm lk-btn--ghost" id="lib-up" title="上一级">↑ 上一级</button>
          <span id="lib-crumb" style="font-size:var(--text-xs);color:var(--fg-2);font-family:var(--font-mono);"></span>
          <span style="flex:1;"></span>
          <input id="lib-fsearch" class="lk-input" placeholder="搜 vault 全部文件（内容）" style="width:260px;"/>
          <button class="lk-btn lk-btn--sm" id="lib-fsearch-go">搜</button>
        </div>
        <div style="display:flex;gap:12px;align-items:flex-start;">
          <div id="lib-files" style="flex:1;min-width:0;border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px;max-height:64vh;overflow:auto;"></div>
          <div id="lib-file-body" style="width:44%;flex-shrink:0;border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px;max-height:64vh;overflow:auto;">
            <div class="lk-empty lk-empty--sm"><div class="lk-empty__title">选一个文件预览</div><div class="lk-empty__hint">vault 是 Obsidian 的地盘：这里只读，不改写。要编条目请去「设定库」。</div></div>
          </div>
        </div>
      </div>
    </div>`;

  const paneWords = host.querySelector('#lib-words-pane') as HTMLElement;
  const paneVault = host.querySelector('#lib-vault-pane') as HTMLElement;
  const tabWords = host.querySelector('#lib-tab-words') as HTMLButtonElement;
  const tabVault = host.querySelector('#lib-tab-vault') as HTMLButtonElement;
  const sub = host.querySelector('#lib-sub') as HTMLElement;
  const total = host.querySelector('#lib-total') as HTMLElement;
  const msg = host.querySelector('#lib-msg') as HTMLElement;

  const setTab = (t: 'words' | 'vault'): void => {
    paneWords.style.display = t === 'words' ? 'flex' : 'none';
    paneVault.style.display = t === 'vault' ? 'flex' : 'none';
    tabWords.className = 'lk-btn lk-btn--sm' + (t === 'words' ? '' : ' lk-btn--ghost');
    tabVault.className = 'lk-btn lk-btn--sm' + (t === 'vault' ? '' : ' lk-btn--ghost');
    if (t === 'words') {
      sub.innerHTML = '角色词库（来源：萌百科，CC BY-NC-SA，请勿商用）。点词右边的「＋」把它放进<b>选中词条</b> —— 在「灵感触发器」页的联想画布上方能看到，之后可以建为设定，或让 AI 把一把词提炼成一个完整角色。';
      void loadWords();
    } else {
      sub.innerHTML = '灵框库（vault）里的全部文件：设定条目、事件、以及<b>不属于任何条目的散篇笔记</b>。只读浏览，改动请在 Obsidian 里做。';
      void loadVault();
    }
  };
  tabWords.addEventListener('click', () => setTab('words'));
  tabVault.addEventListener('click', () => setTab('vault'));

  /* ── ① 词库 ─────────────────────────────────────────────── */
  const wordsLoaded = { done: false };
  async function loadWords(): Promise<void> {
    if (wordsLoaded.done) return;
    wordsLoaded.done = true;
    const catBox = host.querySelector('#lib-cats') as HTMLElement;
    const wordBox = host.querySelector('#lib-words') as HTMLElement;
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

    const drawCats = (): void => {
      catBox.innerHTML = cats.map((c) => {
        const n = (lib[c] ?? []).length;
        const hit = q && (lib[c] ?? []).some((w) => w.toLowerCase().includes(q)) ? ' has-hit' : '';
        return `<button class="lk-lib-cat${c === cat ? ' is-on' : ''}${hit}" data-cat="${escapeHtml(c)}"><span>${escapeHtml(c)}</span><span class="lk-lib-cat__n">${n}</span></button>`;
      }).join('');
      catBox.querySelectorAll<HTMLElement>('[data-cat]').forEach((el) => {
        el.addEventListener('click', () => { cat = el.dataset.cat!; q = ''; search.value = ''; drawCats(); drawWords(); });
      });
    };

    const drawWords = (): void => {
      const pool: { cat: string; word: string }[] = [];
      if (q) {
        for (const c of cats) for (const w of lib[c] ?? []) if (w.toLowerCase().includes(q)) pool.push({ cat: c, word: w });
      } else {
        for (const w of lib[cat] ?? []) pool.push({ cat, word: w });
      }
      total.textContent = q ? `${pool.length} 条命中` : `${cats.length} 分类 · ${Object.values(lib).reduce((a, v) => a + v.length, 0)} 词条`;
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
    };

    search.addEventListener('input', () => {
      q = search.value.trim().toLowerCase();
      drawCats();
      drawWords();
    });
    drawCats();
    drawWords();
  }

  /* ── ② vault 文件 ────────────────────────────────────────── */
  let vaultRoot = '';
  let curDir = '';
  const fileList = (): HTMLElement => host.querySelector('#lib-files') as HTMLElement;
  const fileBody = (): HTMLElement => host.querySelector('#lib-file-body') as HTMLElement;
  const crumb = (): HTMLElement => host.querySelector('#lib-crumb') as HTMLElement;

  const showPreview = async (p: string, line?: number): Promise<void> => {
    const api = (window as unknown as { lingkuangAPI?: { fs?: FsApi } }).lingkuangAPI;
    const box = fileBody();
    box.innerHTML = '<div class="lk-empty lk-empty--sm"><div class="lk-empty__title">读取中…</div></div>';
    if (!api?.fs?.read) { box.innerHTML = '<div class="lk-empty lk-empty--sm"><div class="lk-empty__title">读不了（不在 Electron 里）</div></div>'; return; }
    const r = await api.fs.read(p);
    if (!r?.ok) {
      box.innerHTML = `<div class="lk-empty lk-empty--sm"><div class="lk-empty__title">读不出来</div><div class="lk-empty__hint">${escapeHtml(String(r?.error ?? '未知原因'))}</div></div>`;
      return;
    }
    const text = String(r.text ?? '');
    const lines = text.split(/\r?\n/);
    const start = Math.max(0, (line ?? 1) - 1);
    const slice = lines.slice(start, start + 220);
    box.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:6px;">
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="font-size:var(--text-xs);font-weight:600;color:var(--fg);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(p)}">${escapeHtml(p.split(/[\\/]/).pop() ?? p)}</span>
          <button class="lk-btn lk-btn--sm lk-btn--ghost" id="lib-copy">复制路径</button>
        </div>
        <div style="font-size:var(--text-2xs);color:var(--fg-2);font-family:var(--font-mono);word-break:break-all;">${escapeHtml(p)}</div>
        <div style="font-size:var(--text-2xs);color:var(--fg-2);">${fmtSize(r.size ?? text.length)} · ${lines.length} 行${line ? ` · 命中第 ${line} 行` : ''}${lines.length > 220 ? ' · 只显示前 220 行' : ''}</div>
        <pre style="margin:0;white-space:pre-wrap;font-family:var(--font-mono);font-size:var(--text-2xs);line-height:1.6;color:var(--fg);">${escapeHtml(slice.join('\n'))}</pre>
      </div>`;
    box.querySelector('#lib-copy')?.addEventListener('click', () => {
      void navigator.clipboard?.writeText(p).then(() => { msg.textContent = '已复制路径'; }, () => { msg.textContent = '复制失败'; });
    });
  };

  async function loadVault(dir?: string): Promise<void> {
    const api = (window as unknown as { lingkuangAPI?: { fs?: FsApi } }).lingkuangAPI;
    const list = fileList();
    if (!api?.fs?.list) {
      list.innerHTML = '<div class="lk-empty lk-empty--sm"><div class="lk-empty__title">vault 浏览只在 Electron 里可用</div><div class="lk-empty__hint">浏览器里跑 vite dev 时读不到磁盘。</div></div>';
      return;
    }
    list.innerHTML = '<div class="lk-empty lk-empty--sm"><div class="lk-empty__title">读取中…</div></div>';
    const r = await api.fs.list(dir ?? undefined);
    if (!r?.ok) {
      list.innerHTML = `<div class="lk-empty lk-empty--sm"><div class="lk-empty__title">列不出来</div><div class="lk-empty__hint">${escapeHtml(String(r?.error ?? '未知原因'))}</div></div>`;
      return;
    }
    if (!vaultRoot) vaultRoot = String(r.path ?? '');
    curDir = String(r.path ?? '');
    const entries = (r.entries ?? []).filter((e) => e.dir || /\.(md|markdown|txt|json)$/i.test(e.name));
    const rel = vaultRoot && curDir.startsWith(vaultRoot) ? curDir.slice(vaultRoot.length).replace(/^[\\/]/, '') : curDir;
    crumb().textContent = (r.root?.label ? `【${r.root.label}】` : '') + (rel || '（根目录）');
    crumb().title = curDir;
    total.textContent = `${entries.filter((e) => !e.dir).length} 个文件 · ${entries.filter((e) => e.dir).length} 个文件夹`;
    if (!entries.length) {
      list.innerHTML = '<div class="lk-empty lk-empty--sm"><div class="lk-empty__title">这个文件夹是空的</div><div class="lk-empty__hint">上一级看看，或换个文件夹。</div></div>';
      return;
    }
    list.innerHTML = entries.map((e) => `
      <button class="lk-lib-row" data-name="${escapeHtml(e.name)}" data-dir="${e.dir ? '1' : ''}">
        <span class="lk-lib-row__kind">${e.dir ? '夹' : '文'}</span>
        <span class="lk-lib-row__name">${escapeHtml(e.name)}</span>
        <span class="lk-lib-row__meta">${e.dir ? '' : fmtSize(e.size)}</span>
        <span class="lk-lib-row__time">${e.dir ? '' : fmtTime(e.mtime)}</span>
      </button>`).join('');
    list.querySelectorAll<HTMLElement>('[data-name]').forEach((el) => {
      el.addEventListener('click', () => {
        const name = el.dataset.name!;
        const full = curDir.replace(/[\\/]$/, '') + '/' + name;
        if (el.dataset.dir) void loadVault(full);
        else void showPreview(full);
      });
    });
  }

  host.querySelector('#lib-up')?.addEventListener('click', () => {
    if (!curDir || !vaultRoot || curDir === vaultRoot) { void loadVault(vaultRoot || undefined); return; }
    const parent = curDir.replace(/[\\/][^\\/]+$/, '');
    void loadVault(parent || vaultRoot);
  });

  const doSearch = async (): Promise<void> => {
    const api = (window as unknown as { lingkuangAPI?: { fs?: FsApi } }).lingkuangAPI;
    const inp = host.querySelector('#lib-fsearch') as HTMLInputElement;
    const q = inp.value.trim();
    const list = fileList();
    if (!q) { void loadVault(curDir || undefined); return; }
    if (!api?.fs?.search || !vaultRoot) { list.innerHTML = '<div class="lk-empty lk-empty--sm"><div class="lk-empty__title">搜索只在 Electron 里可用</div></div>'; return; }
    list.innerHTML = '<div class="lk-empty lk-empty--sm"><div class="lk-empty__title">搜索中…</div></div>';
    const r = await api.fs.search(vaultRoot, q);
    if (!r?.ok) {
      list.innerHTML = `<div class="lk-empty lk-empty--sm"><div class="lk-empty__title">搜不了</div><div class="lk-empty__hint">${escapeHtml(String(r?.error ?? '未知原因'))}</div></div>`;
      return;
    }
    const hits = r.hits ?? [];
    total.textContent = `${hits.length} 处命中 · 扫了 ${r.scanned ?? 0} 个文件`;
    if (!hits.length) {
      list.innerHTML = '<div class="lk-empty lk-empty--sm"><div class="lk-empty__title">没有命中</div><div class="lk-empty__hint">换个关键词试试；只搜 ≤512 KB 的文本文件，最多 200 处。</div></div>';
      return;
    }
    list.innerHTML = hits.map((h, i) => `
      <button class="lk-lib-row" data-file="${escapeHtml(h.file)}" data-line="${h.line}" data-i="${i}">
        <span class="lk-lib-row__kind">行</span>
        <span class="lk-lib-row__name">${escapeHtml(h.file)}<span class="lk-lib-row__line">:${h.line}</span></span>
        <span class="lk-lib-row__meta">${escapeHtml(h.text)}</span>
      </button>`).join('');
    list.querySelectorAll<HTMLElement>('[data-file]').forEach((el) => {
      el.addEventListener('click', () => {
        const full = String(vaultRoot).replace(/[\\/]$/, '') + '/' + el.dataset.file;
        void showPreview(full, Number(el.dataset.line ?? 1));
      });
    });
  };
  host.querySelector('#lib-fsearch-go')?.addEventListener('click', () => { void doSearch(); });
  host.querySelector('#lib-fsearch')?.addEventListener('keydown', (ev) => { if ((ev as KeyboardEvent).key === 'Enter') { ev.preventDefault(); void doSearch(); } });

  setTab('words');
}
