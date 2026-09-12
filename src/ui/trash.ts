/** 回收站 —— 删除的节点 / 时间线 / 世界都先移进 `vault/.trash`，这里能看、能恢复、能彻底删。
 *
 *  为什么必须有这个面板：删除是不可逆的创作损失，而 vault 的 `.md` 是「文件为源」
 *  （不清文件的话下次扫描节点就复活）。所以「删除」= 把文件移进 `.trash`；
 *  但只有「移进去」没有「取出来」的入口，等于把安全网挂在了够不着的地方。
 *
 *  条目分两类：
 *   - node / timeline / world：主进程在 `.trash/index.json` 里记了原始相对路径，恢复 = 移回原位；
 *   - orphan：早期版本删除留下的平铺文件（没有位置记录），需要指定恢复到哪个世界/时间线，
 *     由主进程按 md 内容里的 kind/title 放回对应的类型文件夹。
 */
import type { Store } from '../store/store';
import { applyTrashRestore } from '../store/actions';
import type { TrashRestored } from '../store/actions';
import { escapeHtml } from './html';
import { confirmDialog } from './confirm';

interface TrashEntry {
  id: string;
  kind: string;
  relPath?: string;
  trashName: string;
  ts: number;
  title: string;
  world?: string;
  timeline?: string;
  nodeId?: string;
  exists: boolean;
  size: number;
  preview: string;
}
interface ListResult { ok: boolean; entries?: TrashEntry[]; orphans?: TrashEntry[]; error?: string }
interface RestoreResult { ok: boolean; restored?: TrashRestored[]; failed?: { name: string; error: string }[]; error?: string }
interface PurgeResult { ok: boolean; purged?: number; error?: string }
interface TrashAPI {
  trashList?: () => Promise<ListResult>;
  trashRestore?: (items: { trashName: string; world?: string; timeline?: string; nodeKind?: string }[]) => Promise<RestoreResult>;
  trashPurge?: (names: string[]) => Promise<PurgeResult>;
  trashPurgeAll?: () => Promise<PurgeResult>;
}

const KIND_LABEL: Record<string, string> = { node: '节点', timeline: '时间线', world: '世界观', orphan: '位置未知' };

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtTime(ts: number): string {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString('zh-CN', { hour12: false }); } catch { return ''; }
}

export function renderTrash(store: Store, host: HTMLElement): () => void {
  const api = (window as unknown as { lingkuangAPI?: TrashAPI }).lingkuangAPI;
  host.style.overflow = 'auto';
  host.innerHTML = `
    <div style="max-width:880px;margin:0 auto;padding:20px 16px;display:flex;flex-direction:column;gap:14px;">
      <div>
        <div style="font-size:17px;font-weight:600;color:var(--fg);">回收站</div>
        <div style="font-size:var(--text-xs);color:var(--fg-2);line-height:var(--leading-body);margin-top:4px;">
          删除的节点 / 时间线 / 世界观会先移到这里（vault 的 <span style="font-family:var(--font-mono);">.trash</span> 目录），文件没有被真正删除。
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <button id="tr-refresh" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:5px 12px;font-size:var(--text-sm);cursor:pointer;">刷新</button>
        <button id="tr-purge-all" style="background:transparent;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg-2);padding:5px 12px;font-size:var(--text-sm);cursor:pointer;">清空回收站</button>
        <span id="tr-msg" style="font-size:var(--text-xs);color:var(--accent);"></span>
      </div>
      <div id="tr-list"></div>
    </div>`;

  const listEl = host.querySelector('#tr-list') as HTMLElement;
  const msgEl = host.querySelector('#tr-msg') as HTMLElement;
  if (!api?.trashList) {
    listEl.innerHTML = `<div style="font-size:var(--text-sm);color:var(--fg-2);">回收站不可用（需在 Electron 环境中运行）。</div>`;
    return () => { /* 无监听、无订阅，无需清理 */ };
  }

  let msgTimer: number | undefined;
  const say = (s: string): void => {
    msgEl.textContent = s;
    if (msgTimer) window.clearTimeout(msgTimer);
    msgTimer = window.setTimeout(() => { msgEl.textContent = ''; }, 2500);
  };

  const rowStyle =
    'display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface-2);';
  const btnStyle =
    'background:none;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 10px;font-size:var(--text-xs);cursor:pointer;flex-shrink:0;';

  function renderRows(entries: TrashEntry[], orphans: TrashEntry[]): void {
    if (!entries.length && !orphans.length) {
      listEl.innerHTML = `<div style="font-size:var(--text-sm);color:var(--fg-2);">回收站是空的。</div>`;
      return;
    }
    listEl.innerHTML = '';

    const title = document.createElement('div');
    title.textContent = '可恢复';
    title.style.cssText = 'font-size:var(--text-sm);font-weight:600;color:var(--fg);margin-bottom:6px;';
    if (entries.length) listEl.appendChild(title);

    for (const it of entries) {
      const row = document.createElement('div');
      row.style.cssText = rowStyle + 'margin-bottom:6px;';

      const kind = document.createElement('span');
      kind.textContent = KIND_LABEL[it.kind] ?? it.kind;
      kind.style.cssText =
        'flex-shrink:0;font-size:var(--text-xs);color:var(--fg-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:1px 6px;';

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0;';
      const name = document.createElement('div');
      name.textContent = it.title || it.trashName;
      name.style.cssText = 'font-size:var(--text-sm);color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      const meta = document.createElement('div');
      const parts = [it.world, it.timeline, it.preview, fmtSize(it.size), fmtTime(it.ts)].filter((x) => !!x);
      meta.textContent = parts.join(' · ');
      meta.style.cssText = 'font-size:var(--text-xs);color:var(--fg-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      info.appendChild(name);
      info.appendChild(meta);

      const restore = document.createElement('button');
      restore.textContent = '恢复';
      restore.style.cssText = btnStyle;
      restore.addEventListener('click', () => {
        void doRestore([{ trashName: it.trashName }]);
      });

      const purge = document.createElement('button');
      purge.textContent = '彻底删除';
      purge.style.cssText = btnStyle + 'color:var(--danger);border-color:var(--danger);';
      purge.addEventListener('click', () => {
        void confirmDialog({
          title: `彻底删除「${it.title || it.trashName}」？`,
          message: '文件会从磁盘上真正删除，无法再恢复。',
          confirmText: '彻底删除',
          danger: true,
        }).then((okDel) => { if (okDel) void doPurge([it.trashName]); });
      });

      row.appendChild(kind);
      row.appendChild(info);
      row.appendChild(restore);
      row.appendChild(purge);
      listEl.appendChild(row);
    }

    if (orphans.length) {
      const t2 = document.createElement('div');
      t2.textContent = '位置未知（早期版本删除的文件，需指定恢复到哪条时间线）';
      t2.style.cssText = 'font-size:var(--text-sm);font-weight:600;color:var(--fg);margin:14px 0 6px;';
      listEl.appendChild(t2);
      const worlds = Object.keys(store.data.worldsets);
      for (const it of orphans) {
        const row = document.createElement('div');
        row.style.cssText = rowStyle + 'margin-bottom:6px;flex-wrap:wrap;';

        const info = document.createElement('div');
        info.style.cssText = 'flex:1;min-width:180px;';
        const name = document.createElement('div');
        name.textContent = it.trashName;
        name.style.cssText = 'font-size:var(--text-sm);color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        const meta = document.createElement('div');
        meta.textContent = `${fmtSize(it.size)} · ${fmtTime(it.ts) || '时间未知'}`;
        meta.style.cssText = 'font-size:var(--text-xs);color:var(--fg-2);';
        info.appendChild(name);
        info.appendChild(meta);

        const wSel = document.createElement('select');
        wSel.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 6px;font-size:var(--text-xs);';
        for (const w of worlds) {
          const o = document.createElement('option');
          o.value = w; o.textContent = w;
          wSel.appendChild(o);
        }
        const tlInput = document.createElement('input');
        tlInput.placeholder = '时间线名';
        tlInput.style.cssText = 'width:130px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 6px;font-size:var(--text-xs);';
        const fillTl = (): void => {
          const ws = store.data.worldsets[wSel.value];
          const names = ws ? Object.values(ws.timelines ?? {}).map((t) => t.name) : [];
          tlInput.value = names[0] ?? '';
        };
        wSel.addEventListener('change', fillTl);
        fillTl();

        /* 格式（kind）：.md frontmatter 不记 kind（靠文件夹名承载），孤儿文件里取不到，
           只能让用户选 —— 否则会一律落到「事件/」，角色/地点静默错位。 */
        const kSel = document.createElement('select');
        kSel.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 6px;font-size:var(--text-xs);';
        const kinds = Object.keys(store.data.formats ?? {});
        for (const k of (kinds.length ? kinds : ['事件'])) {
          const o = document.createElement('option');
          o.value = k; o.textContent = k;
          kSel.appendChild(o);
        }
        kSel.value = kinds.includes('事件') ? '事件' : (kinds[0] ?? '事件');

        const restore = document.createElement('button');
        restore.textContent = '恢复';
        restore.style.cssText = btnStyle;
        restore.addEventListener('click', () => {
          void doRestore([{ trashName: it.trashName, world: wSel.value, timeline: tlInput.value.trim(), nodeKind: kSel.value }]);
        });

        const purge = document.createElement('button');
        purge.textContent = '彻底删除';
        purge.style.cssText = btnStyle + 'color:var(--danger);border-color:var(--danger);';
        purge.addEventListener('click', () => {
          void confirmDialog({
            title: `彻底删除「${it.trashName}」？`,
            message: '文件会从磁盘上真正删除，无法再恢复。',
            confirmText: '彻底删除',
            danger: true,
          }).then((okDel) => { if (okDel) void doPurge([it.trashName]); });
        });

        row.appendChild(info);
        row.appendChild(wSel);
        row.appendChild(tlInput);
        row.appendChild(kSel);
        row.appendChild(restore);
        row.appendChild(purge);
        listEl.appendChild(row);
      }
    }
  }

  async function refresh(): Promise<void> {
    const r = await api!.trashList!();
    if (!host.isConnected) return;   /* 期间切走了工具 */
    if (!r.ok) {
      listEl.innerHTML = `<div style="font-size:var(--text-sm);color:var(--danger);">读取失败：${escapeHtml(r.error ?? '未知错误')}</div>`;
      return;
    }
    renderRows(r.entries ?? [], r.orphans ?? []);
  }

  async function doRestore(items: { trashName: string; world?: string; timeline?: string; nodeKind?: string }[]): Promise<void> {
    const r = await api!.trashRestore!(items);
    if (!host.isConnected) return;
    if (!r.ok) { say(`恢复失败：${r.error ?? '未知错误'}`); return; }
    /* 恢复要同时回插 store，否则「文件回来了但界面要重启才看得到」 */
    const stat = applyTrashRestore(store, r.restored ?? []);
    const failed = r.failed ?? [];
    if (failed.length) say(`部分失败：${failed.map((f) => f.error).join('；')}`);
    else say(`已恢复：${stat.nodes} 个节点、${stat.timelines} 条时间线、${stat.worlds} 个世界观`);
    await refresh();
  }

  async function doPurge(names: string[]): Promise<void> {
    const r = await api!.trashPurge!(names);
    if (!host.isConnected) return;
    if (!r.ok) { say(`删除失败：${r.error ?? '未知错误'}`); return; }
    say(`已彻底删除 ${r.purged ?? 0} 项`);
    await refresh();
  }

  host.querySelector('#tr-refresh')?.addEventListener('click', () => { void refresh(); });
  host.querySelector('#tr-purge-all')?.addEventListener('click', () => {
    void confirmDialog({
      title: '清空回收站？',
      message: '回收站里的所有文件会从磁盘上真正删除，无法再恢复。',
      detail: '如果只是想清理，建议先确认没有需要取回的内容。',
      confirmText: '清空',
      danger: true,
    }).then((okDel) => {
      if (!okDel) return;
      void api!.trashPurgeAll!().then(async (r) => {
        if (!host.isConnected) return;
        say(r.ok ? `已清空 ${r.purged ?? 0} 项` : `清空失败：${r.error ?? '未知错误'}`);
        await refresh();
      });
    });
  });

  void refresh();
  return () => { if (msgTimer) window.clearTimeout(msgTimer); };
}
