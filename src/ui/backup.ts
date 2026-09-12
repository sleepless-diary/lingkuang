/** 备份管理：世界观数据 / 角色词库的备份列表、恢复、导出、导入。
 *
 *  和「回收站」是同一个主题的两半——回收站管「我删错了」，这里管「数据被写坏了 / 想回到某个时间点」。
 *  每个受管文件都有这几类副本：
 *    自动轮换 .backup-0/1/2        每次保存前把原文件推进去（保留 3 份）
 *    损坏存档 .bak-corrupt-<ts>    解析失败时逐字节另存（保命用，绝不覆盖）
 *    手动备份 .bak-manual-<ts>     用户点「立即备份」
 *    恢复前快照 .bak-prerestore-<ts> 恢复/导入前自动留一份当前的
 *
 *  ⚠️ 恢复某个文件不能只改文件：内存里的 store 还是旧数据，之后任何一次自动落盘
 *  都会把刚恢复的内容写回去。所以恢复世界观数据走「先禁写 → 覆盖文件 → 重载窗口」，
 *  并在重载前跳过 beforeunload 的 flush（否则退出 flush 又会用旧数据盖一次）。 */
import type { Store } from '../store/store';
import { confirmDialog } from './confirm';
import { escapeHtml } from './html';

interface BackupEntry {
  kind: string;
  label: string;
  path: string;
  name: string;
  bytes: number;
  mtime: number;
  restorable: boolean;
}
interface BackupInfo {
  ok: boolean;
  label?: string;
  file?: string;
  entries?: BackupEntry[];
  error?: string;
}
interface BackupApi {
  backupList: (t: string) => Promise<BackupInfo>;
  backupCreate: (t: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  backupRestore: (t: string, p: string) => Promise<{ ok: boolean; from?: string; safety?: string; bytes?: number; error?: string }>;
  backupExport: (t: string) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
  backupImport: (t: string) => Promise<{ ok: boolean; from?: string; safety?: string; canceled?: boolean; error?: string }>;
}
const api = () => (window as unknown as { lingkuangAPI?: BackupApi }).lingkuangAPI;

const fmtBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const fmtTime = (ms: number): string => {
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};
/** 每类副本一句话说明（面板上要能看懂哪份是什么） */
const KIND_NOTE: Record<string, string> = {
  current: '正在使用的文件',
  auto: '自动轮换（每次保存前留）',
  corrupt: '上次读不出来时保下的原件',
  manual: '手动建的备份',
  prerestore: '恢复/导入前自动留下的',
  builtin: '随包分发的出厂词库',
};

const TARGETS = [
  {
    id: 'data',
    title: '世界观数据',
    file: 'worldbuilding.json',
    note: '时间线结构 / 循环 / 剧情线 / 地图 / 实体 / 历法 / 世界笔记 / 时间指针',
    /* 这条必须写明白：实测过——恢复 JSON 备份后节点仍在，因为节点正文不在 JSON 里。
       不说清楚的话，用户会以为「恢复了 = 节点也回来了」或者反过来以为恢复没生效。 */
    caveat: '节点正文存在 vault 的 .md 文件里（Obsidian 可直接编辑，节点以文件为准），不在这份 JSON 中——恢复它只恢复上面那些结构。删掉的节点请到「回收站」里找。',
  },
  { id: 'lib', title: '角色词库', file: 'character_lib.json', note: '灵感触发器与联想图用的词条' },
];

const BTN = 'border:1px solid var(--border);background:var(--surface-2);color:var(--fg);border-radius:var(--radius-sm);padding:3px 10px;font-size:11px;cursor:pointer;';
const BTN_MAIN = 'border:none;background:var(--accent);color:var(--accent-on);border-radius:var(--radius-sm);padding:3px 10px;font-size:11px;cursor:pointer;';

export function renderBackup(_store: Store, host: HTMLElement): () => void {
  const a = api();
  host.style.overflow = 'auto';
  let msgTimer: number | undefined;
  let disposed = false;

  host.innerHTML = `
    <div style="max-width:680px;margin:0 auto;padding:18px 16px 30px;display:flex;flex-direction:column;gap:16px;">
      <div>
        <div style="font-size:17px;font-weight:600;color:var(--fg);">备份管理</div>
        <div style="font-size:var(--text-xs);color:var(--fg-2);line-height:1.8;margin-top:6px;">
          灵框每次保存前会自动把原文件轮换备份（保留 3 份）；数据读不出来时还会把原件完整另存一份，不会被覆盖。
          在这里可以回退到任意一份备份，或把数据导出成文件带走。
        </div>
      </div>
      <div id="bk-body" style="display:flex;flex-direction:column;gap:16px;"></div>
      <div id="bk-msg" style="font-size:var(--text-xs);color:var(--accent);min-height:17px;line-height:1.7;word-break:break-all;"></div>
    </div>`;

  const body = host.querySelector('#bk-body') as HTMLElement;
  const msgEl = host.querySelector('#bk-msg') as HTMLElement;

  function say(text: string, ms = 5000): void {
    msgEl.textContent = text;
    if (msgTimer) window.clearTimeout(msgTimer);
    msgTimer = window.setTimeout(() => { msgEl.textContent = ''; }, ms);
  }

  function sectionHtml(t: (typeof TARGETS)[number], info: BackupInfo): string {
    const entries = info.entries ?? [];
    const rows = entries.length
      ? entries.map((e) => `
        <div style="display:flex;align-items:center;gap:10px;padding:7px 11px;border-top:1px solid var(--border);">
          <span style="width:150px;flex-shrink:0;font-size:var(--text-xs);color:${e.kind === 'current' ? 'var(--accent)' : 'var(--fg-2)'};" title="${escapeHtml(KIND_NOTE[e.kind] ?? '')}">${escapeHtml(e.label)}</span>
          <span style="flex:1;min-width:0;font-family:var(--font-mono);font-size:11px;color:var(--fg-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(e.path)}">${fmtTime(e.mtime)} · ${fmtBytes(e.bytes)}</span>
          ${e.restorable ? `<button class="lk-bk-restore" data-target="${t.id}" data-path="${escapeHtml(e.path)}" data-label="${escapeHtml(e.label)}" style="${BTN}">恢复</button>` : ''}
        </div>`).join('')
      : `<div style="padding:10px 11px;border-top:1px solid var(--border);font-size:var(--text-xs);color:var(--fg-2);">还没有任何备份。</div>`;
    return `
      <section style="border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;">
        <div style="padding:11px 12px;display:flex;align-items:center;gap:10px;background:var(--surface-2);">
          <div style="flex:1;min-width:0;">
            <div style="font-size:var(--text-sm);font-weight:600;color:var(--fg);">${t.title}</div>
            <div style="font-size:11px;color:var(--fg-2);margin-top:2px;">${t.note}</div>
            ${t.caveat ? `<div style="font-size:11px;color:var(--fg-2);line-height:1.7;margin-top:4px;">${t.caveat}</div>` : ''}
            <div style="font-family:var(--font-mono);font-size:10px;color:var(--fg-2);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(info.file || '')}">${escapeHtml(info.file || '（文件还没生成）')}</div>
          </div>
          <button class="lk-bk-create" data-target="${t.id}" style="${BTN}">立即备份</button>
          <button class="lk-bk-export" data-target="${t.id}" style="${BTN}">导出到文件</button>
          <button class="lk-bk-import" data-target="${t.id}" style="${BTN_MAIN}">从文件导入</button>
        </div>
        ${rows}
      </section>`;
  }

  async function refresh(): Promise<void> {
    if (!a?.backupList) {
      body.innerHTML = `<div style="font-size:var(--text-sm);color:var(--fg-2);">备份功能需要 Electron 环境。</div>`;
      return;
    }
    const infos = await Promise.all(TARGETS.map((t) => a.backupList(t.id).catch(() => ({ ok: false } as BackupInfo))));
    if (disposed || !host.isConnected) return;
    body.innerHTML = TARGETS.map((t, i) => sectionHtml(t, infos[i])).join('');
  }

  /** 恢复：世界观数据要重载窗口（内存 store 必须换成恢复后的内容），词库只需刷新列表 */
  async function doRestore(target: string, path: string, label: string): Promise<void> {
    if (!a?.backupRestore) return;
    const isData = target === 'data';
    const ok = await confirmDialog({
      title: `恢复「${label}」？`,
      message: isData
        ? `会用这份备份覆盖当前的世界观数据（${label}）。\n\n当前内容会先自动留一份「恢复前快照」，恢复错了还能回头。恢复后灵框会重新载入。\n\n注意：节点正文在 vault 的 .md 文件里（节点以文件为准），这份备份改不到它 —— 恢复的是时间线结构 / 循环 / 剧情线 / 地图 / 实体 / 历法 / 笔记。`
        : `会用这份备份覆盖当前的角色词库（${label}）。\n\n当前内容会先自动留一份「恢复前快照」。`,
      confirmText: '恢复',
      danger: true,
    });
    if (!ok) return;
    /* 先禁写再覆盖：否则自动落盘（400ms 防抖）会拿内存里的旧数据把恢复结果盖掉 */
    window.dispatchEvent(new CustomEvent('lingkuang-restore-start'));
    const r = await a.backupRestore(target, path);
    if (!r.ok) {
      window.dispatchEvent(new CustomEvent('lingkuang-restore-end'));
      say('恢复失败：' + (r.error || '未知错误'));
      return;
    }
    if (isData) {
      location.reload();
      return;
    }
    say(`已从「${label}」恢复词库（${fmtBytes(r.bytes ?? 0)}）。重新打开灵感触发器 / 联想图即可生效。`);
    await refresh();
  }

  body.addEventListener('click', async (ev) => {
    const el = ev.target as HTMLElement;
    const t = el.dataset?.target;
    if (!t) return;
    if (el.classList.contains('lk-bk-restore')) {
      await doRestore(t, el.dataset.path ?? '', el.dataset.label ?? '');
      return;
    }
    if (!a) return;
    if (el.classList.contains('lk-bk-create')) {
      const r = await a.backupCreate(t);
      say(r.ok ? '已备份到：' + (r.path ?? '') : '备份失败：' + (r.error || '未知错误'));
      await refresh();
      return;
    }
    if (el.classList.contains('lk-bk-export')) {
      const r = await a.backupExport(t);
      if (r.canceled) return;
      say(r.ok ? '已导出到：' + (r.path ?? '') : '导出失败：' + (r.error || '未知错误'));
      await refresh();
      return;
    }
    if (el.classList.contains('lk-bk-import')) {
      const r = await a.backupImport(t);
      if (r.canceled) return;
      if (!r.ok) { say('导入失败：' + (r.error || '未知错误')); return; }
      /* 导入同样换了数据文件：世界观数据必须重载，否则内存旧数据会把它盖回去 */
      if (t === 'data') { window.dispatchEvent(new CustomEvent('lingkuang-restore-start')); location.reload(); return; }
      say('已导入：' + (r.from ?? ''));
      await refresh();
    }
  });

  void refresh();

  return () => {
    disposed = true;
    if (msgTimer) window.clearTimeout(msgTimer);
  };
}
