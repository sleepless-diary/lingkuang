/** 灵框 · 结构体管理（模板/字段定义面板）
 *
 * 用户 2026-09-12 的比喻：「数据就像抽象或者接口一样，自带一套模版然后自己设定内容」。
 * 对应关系：
 *   - **种类**（角色/地点/物品/组织/事件…）= 接口/模板，定义「这个种类有哪些字段」，存在 formats.json
 *   - **节点** = 模板的一个实例，填字段的值；节点属于哪个种类由 vault 里的**文件夹名**承载
 *     （`main.js` 的 vault:scan 用 `n.kind = sub.name` 回填，vault:write 也按 kind 建目录）
 *
 * 这个面板只做一件事：编辑模板本身。改完点「保存模板」→ 写 formats.json → 更新 store.formats
 * → 派发 `lingkuang-formats-changed`，由 `src/main.ts` 的 `ensureAllFormatFields` 负责
 * 给所有节点补空字段 / 清掉模板外的字段（模板是唯一权威，这一点是既有的设计约定）。
 */
import type { Store } from '../store/store';
import type { FieldType, WorldFormat } from '../store/types';
import { confirmDialog, promptDialog } from './confirm';
import { escapeHtml } from './html';

/** 字段类型的中文名（面板里只显示中文，值仍用 FieldType 的字面量） */
const TYPE_LABEL: Record<FieldType, string> = {
  text: '短文本',
  longtext: '长文本',
  number: '数值',
  boolean: '开关',
  list: '列表',
};
const TYPE_ORDER: FieldType[] = ['text', 'longtext', 'number', 'boolean', 'list'];

type Formats = Record<string, WorldFormat>;

/** store 里的 formats 快照（深拷贝，面板在草稿上编辑，点保存才生效） */
function readFormats(store: Store): Formats {
  const src = store.data.formats;
  if (!src) return {};
  const out: Formats = {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = { id: v?.id ?? k, name: v?.name ?? k, fields: (v?.fields ?? []).map((f) => ({ name: f.name, type: f.type })) };
  }
  return out;
}

export function renderSchema(store: Store, host: HTMLElement): () => void {
  host.style.overflow = 'auto';
  const api = (window as unknown as { lingkuangAPI?: { saveFormats?: (f: Formats) => Promise<{ ok: boolean; error?: string }> } }).lingkuangAPI;

  let saved: Formats = readFormats(store);      // 已保存的
  let draft: Formats = readFormats(store);      // 草稿
  let activeKind: string = Object.keys(draft)[0] ?? '';
  let msgTimer: number | undefined;

  /** 数一下某种类下有多少节点、以及某个字段被多少节点填过值（用于「会影响 N 个节点」的提示） */
  function impact(kind: string, fieldName?: string): { nodes: number; filled: number } {
    let nodes = 0, filled = 0;
    for (const ws of Object.values(store.data.worldsets)) {
      for (const tlId of ws.order ?? []) {
        const tl = ws.timelines?.[tlId];
        if (!tl) continue;
        for (const n of tl.nodes ?? []) {
          if ((n.kind ?? '事件') !== kind) continue;
          nodes++;
          if (fieldName && n.properties && n.properties[fieldName] !== undefined && n.properties[fieldName] !== '') filled++;
        }
      }
    }
    return { nodes, filled };
  }

  const dirty = (): boolean => JSON.stringify(draft) !== JSON.stringify(saved);

  function say(text: string, bad = false): void {
    const el = host.querySelector('#sc-msg') as HTMLElement | null;
    if (!el) return;
    el.textContent = text;
    el.style.color = bad ? 'var(--danger)' : 'var(--accent)';
    if (msgTimer) window.clearTimeout(msgTimer);
    msgTimer = window.setTimeout(() => { if (el.isConnected) el.textContent = ''; }, 2600);
  }

  function render(): void {
    const kinds = Object.keys(draft);
    if (!kinds.includes(activeKind)) activeKind = kinds[0] ?? '';
    const cur = activeKind ? draft[activeKind] : undefined;

    const kindList = kinds
      .map((k) => {
        const imp = impact(k);
        return `<button data-kind="${escapeHtml(k)}" style="display:flex;align-items:center;gap:6px;width:100%;text-align:left;background:${k === activeKind ? 'var(--surface-2)' : 'transparent'};border:1px solid ${k === activeKind ? 'var(--border)' : 'transparent'};border-radius:var(--radius-sm);color:var(--fg);padding:5px 8px;font-size:var(--text-sm);cursor:pointer;">
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(k)}</span>
          <span style="font-size:10px;color:var(--fg-2);font-family:var(--font-mono);">${draft[k].fields.length} 字段 · ${imp.nodes} 节点</span>
        </button>`;
      })
      .join('');

    const fieldRows = !cur
      ? '<div style="font-size:var(--text-xs);color:var(--fg-2);">还没有任何种类，点左下角「＋新建种类」。</div>'
      : cur.fields
          .map((f, i) => `<div data-row="${i}" style="display:flex;align-items:center;gap:6px;">
            <input data-fname="${i}" value="${escapeHtml(f.name)}" placeholder="字段名（如 性别）" style="flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 7px;font-size:var(--text-sm);outline:none;"/>
            <select data-ftype="${i}" style="width:88px;flex-shrink:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 5px;font-size:var(--text-xs);outline:none;">${TYPE_ORDER.map((t) => `<option value="${t}"${f.type === t ? ' selected' : ''}>${TYPE_LABEL[t]}</option>`).join('')}</select>
            <button data-fup="${i}" title="上移" style="background:none;border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--fg-2);padding:2px 6px;font-size:11px;cursor:pointer;">↑</button>
            <button data-fdown="${i}" title="下移" style="background:none;border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--fg-2);padding:2px 6px;font-size:11px;cursor:pointer;">↓</button>
            <button data-fdel="${i}" title="删除字段" style="background:none;border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--danger);padding:2px 7px;font-size:11px;cursor:pointer;">✕</button>
          </div>`)
          .join('');

    const imp = activeKind ? impact(activeKind) : { nodes: 0, filled: 0 };
    host.innerHTML = `
      <div style="max-width:940px;margin:0 auto;padding:18px 16px;display:flex;flex-direction:column;gap:12px;" id="sc-root">
        <div>
          <div style="font-size:17px;font-weight:600;color:var(--fg);">结构体管理</div>
          <div style="font-size:var(--text-xs);color:var(--fg-2);line-height:1.6;margin-top:4px;">
            种类=模板（定义有哪些字段），节点=按模板填内容。节点的种类由它在 vault 里的<b>文件夹名</b>决定。<br/>
            加字段 → 该种类的所有节点自动补空值；<b>删字段 → 这些节点里该字段已填的值会被清掉</b>（保存时会先让你确认）。
          </div>
        </div>
        <div style="display:flex;gap:12px;align-items:flex-start;">
          <div style="width:250px;flex-shrink:0;display:flex;flex-direction:column;gap:4px;border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px;">
            <div style="font-size:var(--text-xs);color:var(--fg-2);padding:0 2px 2px;">种类（模板）</div>
            ${kindList || '<div style="font-size:var(--text-xs);color:var(--fg-2);">（空）</div>'}
            <button id="sc-kind-new" style="margin-top:4px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:5px;font-size:var(--text-xs);cursor:pointer;">＋新建种类</button>
          </div>
          <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px;">
            ${cur
              ? `<div style="display:flex;align-items:center;gap:8px;">
                   <span style="font-size:var(--text-sm);font-weight:600;color:var(--fg);">${escapeHtml(activeKind)}</span>
                   <span style="font-size:var(--text-xs);color:var(--fg-2);">${imp.nodes} 个节点用这个模板</span>
                   <button id="sc-kind-del" style="margin-left:auto;background:transparent;border:1px solid var(--danger);color:var(--danger);border-radius:var(--radius-sm);padding:3px 10px;font-size:var(--text-xs);cursor:pointer;">删除此种类</button>
                 </div>
                 <div style="display:flex;flex-direction:column;gap:6px;">${fieldRows}</div>
                 <button id="sc-field-new" style="align-self:flex-start;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:5px 12px;font-size:var(--text-xs);cursor:pointer;">＋添加字段</button>`
              : ''}
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <button id="sc-save" ${dirty() ? '' : 'disabled'} style="background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-sm);padding:8px 18px;font-size:var(--text-sm);cursor:pointer;${dirty() ? '' : 'opacity:.4;cursor:default;'}">保存模板</button>
          <button id="sc-revert" ${dirty() ? '' : 'disabled'} style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg-2);padding:8px 14px;font-size:var(--text-sm);cursor:pointer;${dirty() ? '' : 'opacity:.4;cursor:default;'}">放弃改动</button>
          <span id="sc-msg" style="font-size:var(--text-xs);"></span>
        </div>
      </div>`;

    /* ── 事件绑定 ── */
    /* 只同步「保存/放弃」的可用态，不重建 DOM —— 重建会把正在输入的字段名输入框销毁、丢焦点 */
    const syncSaveButtons = (): void => {
      const d = dirty();
      const s = host.querySelector('#sc-save') as HTMLButtonElement | null;
      const r = host.querySelector('#sc-revert') as HTMLButtonElement | null;
      if (s) { s.disabled = !d; s.style.opacity = d ? '' : '.4'; s.style.cursor = d ? 'pointer' : 'default'; }
      if (r) { r.disabled = !d; r.style.opacity = d ? '' : '.4'; }
    };
    host.querySelectorAll<HTMLElement>('[data-kind]').forEach((el) => {
      el.addEventListener('click', () => { activeKind = el.dataset.kind ?? ''; render(); });
    });

    host.querySelectorAll<HTMLInputElement>('[data-fname]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const i = Number(inp.dataset.fname);
        if (cur && cur.fields[i]) cur.fields[i].name = inp.value;
        syncSaveButtons();   /* 一打字就让「保存模板」可点（不能靠 render()，那会丢焦点） */
      });
      inp.addEventListener('blur', () => render());   /* 失焦时刷新保存按钮的可用态 */
    });
    host.querySelectorAll<HTMLSelectElement>('[data-ftype]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const i = Number(sel.dataset.ftype);
        if (cur && cur.fields[i]) cur.fields[i].type = sel.value as FieldType;
        render();
      });
    });
    host.querySelectorAll<HTMLElement>('[data-fup]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.fup);
        if (!cur || i <= 0) return;
        [cur.fields[i - 1], cur.fields[i]] = [cur.fields[i], cur.fields[i - 1]];
        render();
      });
    });
    host.querySelectorAll<HTMLElement>('[data-fdown]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.fdown);
        if (!cur || i >= cur.fields.length - 1) return;
        [cur.fields[i + 1], cur.fields[i]] = [cur.fields[i], cur.fields[i + 1]];
        render();
      });
    });
    host.querySelectorAll<HTMLElement>('[data-fdel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.fdel);
        if (!cur || !cur.fields[i]) return;
        const f = cur.fields[i];
        const imp2 = impact(activeKind, f.name);
        void confirmDialog({
          title: `删除字段「${f.name}」？`,
          message: imp2.filled
            ? `这个种类下有 ${imp2.filled} 个节点填过这个字段，保存后它们的值会被清掉。`
            : `这个种类下没有节点填过这个字段，删除是安全的。`,
          detail: cur.fields.length <= 1 ? '注意：这是该种类的最后一个字段，删完后模板会没有字段。' : undefined,
          confirmText: '删除字段',
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          cur.fields.splice(i, 1);
          render();
        });
      });
    });

    host.querySelector('#sc-field-new')?.addEventListener('click', () => {
      if (!cur) return;
      cur.fields.push({ name: '', type: 'text' });
      render();
      const inputs = host.querySelectorAll<HTMLInputElement>('[data-fname]');
      inputs[inputs.length - 1]?.focus();
    });

    host.querySelector('#sc-kind-new')?.addEventListener('click', () => {
      void promptDialog({
        title: '新建种类',
        message: '种类名会直接成为 vault 里的文件夹名（节点就放在那个文件夹下）。',
        label: '种类名（如 魔法体系 / 种族 / 势力）',
        placeholder: '魔法体系',
        confirmText: '创建',
      }).then((name) => {
        const k = (name ?? '').trim();
        if (!k) return;
        if (draft[k]) { say(`已经有「${k}」了`, true); return; }
        draft[k] = { id: k, name: k, fields: [] };
        activeKind = k;
        render();
        say('已加入草稿，点「保存模板」生效');
      });
    });

    host.querySelector('#sc-kind-del')?.addEventListener('click', () => {
      if (!activeKind || !cur) return;
      const imp2 = impact(activeKind);
      void confirmDialog({
        title: `删除种类「${activeKind}」？`,
        message: imp2.nodes
          ? `有 ${imp2.nodes} 个节点属于这个种类。删掉模板后它们仍然存在、属性值也不会丢，只是不再有「该填哪些字段」的约束。`
          : '这个种类下还没有节点。',
        detail: 'vault 里的文件夹不会被删（节点文件还在原处）。',
        confirmText: '删除种类',
        danger: true,
      }).then((ok) => {
        if (!ok) return;
        delete draft[activeKind];
        activeKind = Object.keys(draft)[0] ?? '';
        render();
        say('已从草稿移除，点「保存模板」生效');
      });
    });

    host.querySelector('#sc-revert')?.addEventListener('click', () => {
      draft = JSON.parse(JSON.stringify(saved)) as Formats;
      render();
      say('已放弃未保存的改动');
    });

    host.querySelector('#sc-save')?.addEventListener('click', () => {
      /* 保存前先自检：字段名不能为空、不能重名 —— 空名会让属性面板出现无标题行，重名会互相覆盖 */
      const errs: string[] = [];
      for (const [k, v] of Object.entries(draft)) {
        const seen = new Set<string>();
        for (const f of v.fields) {
          const nm = f.name.trim();
          if (!nm) { errs.push(`「${k}」里有空字段名`); continue; }
          if (seen.has(nm)) errs.push(`「${k}」里字段名重复：${nm}`);
          seen.add(nm);
        }
      }
      if (errs.length) { say('保存失败：' + errs.slice(0, 3).join('；'), true); return; }

      /* 影响统计：删掉的字段里有多少已填值（要让用户知道会清掉多少） */
      let lostFields = 0, lostValues = 0, addedFields = 0;
      for (const [k, v] of Object.entries(saved)) {
        const next = draft[k];
        if (!next) continue;
        const nextNames = new Set(next.fields.map((f) => f.name.trim()));
        for (const f of v.fields) {
          if (nextNames.has(f.name)) continue;
          lostFields++;
          lostValues += impact(k, f.name).filled;
        }
        const prevNames = new Set(v.fields.map((f) => f.name));
        addedFields += next.fields.filter((f) => !prevNames.has(f.name.trim())).length;
      }
      const summary = `${addedFields ? `新增 ${addedFields} 个字段（会给对应种类的节点补空值）` : ''}${addedFields && (lostFields || lostValues) ? '；' : ''}${lostFields ? `删除 ${lostFields} 个字段，其中 ${lostValues} 处已填的值会被清掉` : ''}`;

      const doSave = (): void => {
        void (async () => {
          /* 规整成存档格式（去掉首尾空格、丢弃空字段），再写盘 */
          const clean: Formats = {};
          for (const [k, v] of Object.entries(draft)) {
            clean[k] = { id: k, name: v.name || k, fields: v.fields.map((f) => ({ name: f.name.trim(), type: f.type })) };
          }
          const res = api?.saveFormats ? await api.saveFormats(clean).catch(() => ({ ok: false, error: '写入失败' })) : { ok: false, error: '不在 Electron 环境' };
          if (!res || !res.ok) { say('保存失败：' + (res?.error ?? '未知错误'), true); return; }
          saved = JSON.parse(JSON.stringify(clean)) as Formats;
          draft = JSON.parse(JSON.stringify(clean)) as Formats;
          /* 让 store 里的模板立刻生效（改模板不是节点数据改动，用 undo:false + keepRedo） */
          store.update((d) => { d.formats = clean; }, { undo: false, keepRedo: true });
          /* 交给 src/main.ts 的 ensureAllFormatFields 去补空值 / 清多余字段，并把结果落盘 */
          window.dispatchEvent(new CustomEvent('lingkuang-formats-changed'));
          render();
          say('已保存 ✓');
        })();
      };

      if (lostValues || lostFields) {
        void confirmDialog({
          title: '保存模板？',
          message: summary,
          detail: '被清掉的值无法撤销（可以先用左侧「回收站 / 备份管理」的“立即备份”留一份）。',
          confirmText: '保存',
          danger: lostValues > 0,
        }).then((ok) => { if (ok) doSave(); });
      } else {
        doSave();
      }
    });
  }

  render();
  /* 清理函数：面板里有状态提示定时器 */
  return () => { if (msgTimer) window.clearTimeout(msgTimer); };
}
