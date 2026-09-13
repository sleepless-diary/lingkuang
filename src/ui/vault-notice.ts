/** 外部改动提示条 —— 原来长在 `src/ui/editor.ts` 里（编辑器工具下线时搬出来的）。
 *
 *  两件事：
 *  ① 用户在 Obsidian 里把某个节点的 `.md` 改坏（删掉 `「#描述：」` / `「#正文：」` 标签、
 *     或增删了字段），灵框这边给一条提示 —— 能一键恢复的带「恢复格式」按钮；
 *  ② 启动时 `src/main.ts` 已经自动补回标准标签的那些文件，告知一声（可「不再提示」）。
 *
 *  ⚠️ 提示条是**累积列表**（key 去重）：多个文件出问题并列展示，切节点不清空 ——
 *     用户得能看见「哪个文件出过事」。点一下整条清掉。
 *  ⚠️ 两个 window 监听都留了具名引用并在 dispose 里移除：否则每开一次工作台就多积一对永久监听
 *     （它们持有本模块整个作用域，等于把整块面板钉在内存里）。 */
import type { Store } from '../store/store';
import { saveNodeDoc } from '../store/actions';

export interface VaultNotices {
  /** 换节点时校验它的 .md 是否还带着「#正文：」标签（缺且节点有正文 → 提示 + 一键恢复） */
  checkBodyTag(world: string, tlId: string, nodeId: string, doc: string, title: string): Promise<void>;
  /** 宿主被重建（工作台的 render() 换掉了整块 DOM）之后，把已有提示重新画进新的容器 */
  refresh(): void;
  dispose(): void;
}

export function createVaultNotices(deps: {
  /** 提示条的容器（工作台里是 `#cx-hint`）。**延后取**：宿主会被整块重建 */
  getHost: () => HTMLElement | null;
  store: Store;
  /** 异步返回时若已切到别的条目，就别再提示（防旧提示闪现） */
  getCurrentNodeId: () => string;
  /** 一句人话反馈（工作台里是底部那行 `#cx-msg`），可选 */
  say?: (msg: string) => void;
}): VaultNotices {
  const { store } = deps;
  /* 全局提示条（累积列表）：多个文件出错并列展示，各自带「恢复格式」/自定义按钮；key 去重 */
  const hints = new Map<string, { msg: string; onRestore?: () => void; actionBtn?: { text: string; onClick: () => void } }>();
  function renderHints(): void {
    const hintEl = deps.getHost();
    if (!hintEl) return;
    if (!hints.size) { hintEl.style.display = 'none'; hintEl.innerHTML = ''; return; }
    hintEl.style.display = 'block';
    hintEl.innerHTML = '';
    hints.forEach((h) => {
      const row = document.createElement('div');
      row.style.cssText = 'margin:2px 0;padding:6px 8px;background:rgba(217,101,92,.14);border-radius:var(--radius-sm);';
      row.textContent = h.msg;
      if (h.onRestore) {
        const btn = document.createElement('button');
        btn.textContent = '恢复格式';
        btn.style.cssText = 'margin-left:8px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);font-size:var(--text-xs);padding:2px 8px;cursor:pointer;';
        btn.onclick = (e) => { e.stopPropagation(); h.onRestore!(); };
        row.appendChild(btn);
      }
      if (h.actionBtn) {
        const btn = document.createElement('button');
        btn.textContent = h.actionBtn.text;
        btn.style.cssText = 'margin-left:8px;background:none;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg-2);font-size:var(--text-xs);padding:2px 8px;cursor:pointer;';
        btn.onclick = (e) => { e.stopPropagation(); h.actionBtn!.onClick(); };
        row.appendChild(btn);
      }
      hintEl.appendChild(row);
    });
  }
  function addHint(key: string, msg: string, onRestore?: () => void, actionBtn?: { text: string; onClick: () => void }): void { hints.set(key, { msg, onRestore, actionBtn }); renderHints(); }
  function removeHint(key: string): void { if (hints.delete(key)) renderHints(); }

  function findNodeById(id: string): { tlId: string; node: any } | null {
    for (const ws of Object.values(store.data.worldsets)) {
      for (const tlId of ((ws as any).order ?? [])) {
        const tl = (ws as any).timelines?.[tlId];
        if (!tl) continue;
        const n = (tl.nodes ?? []).find((x: any) => x.id === id);
        if (n) return { tlId, node: n };
      }
    }
    return null;
  }
  /* 恢复 #正文： 标签：重写该节点 doc，触发落盘补回标准格式 */
  function restoreBodyTag(id: string): void {
    const found = findNodeById(id);
    if (!found) return;
    saveNodeDoc(store, found.tlId, id, found.node.doc ?? '');
    deps.say?.('已恢复 ✓');
    removeHint('node:' + id);
  }
  /* 恢复描述：把旧描述写回该节点，触发落盘补回 #描述： */
  function restoreDesc(id: string, oldDesc?: string): void {
    if (oldDesc === undefined) return;
    store.update((d) => {
      for (const ws of Object.values(d.worldsets)) {
        for (const tlId of ((ws as any).order ?? [])) {
          const tl = (ws as any).timelines?.[tlId];
          const n = (tl?.nodes ?? []).find((x: any) => x.id === id);
          if (n) { n.desc = oldDesc; return; }
        }
      }
    });
    deps.say?.('已恢复 ✓');
    removeHint('node:' + id);
  }
  /** 校验节点原始 .md 是否缺 #正文： 标签（外部误删会破坏正文结构）；缺且节点有正文内容时报错 + 恢复 */
  async function checkBodyTag(w: string, tl: string, id: string, doc: string, title: string): Promise<void> {
    const api = (window as any).lingkuangAPI;
    if (!api?.readNodeText) return;
    try {
      const res = await api.readNodeText(w, tl, id);
      if (id !== deps.getCurrentNodeId()) return;   /* 异步返回时已切走 → 忽略 */
      if (!res || !res.ok || !res.text) return;
      if (!/#正文[：:]/.test(res.text) && doc) {
        addHint('node:' + id, `【${title || '该节点'}】的文件丢了「#正文：」标签（外部修改），直接在 Obsidian 恢复容易出错。`, () => {
          saveNodeDoc(store, tl, id, doc);
          deps.say?.('已恢复 ✓');
          removeHint('node:' + id);
        });
      } else {
        removeHint('node:' + id);   /* 该节点校验通过（标签在）→ 移除它的提示 */
      }
      /* 其他情况不隐藏：提示条全局常驻，切节点/正常节点都不清，方便看到哪个文件出问题 */
    } catch { /* 读取失败不打扰 */ }
  }

  /* 监听外部（Obsidian）对节点字段的增删 → 显示提示框 */
  const onVaultFields = ((e: Event) => {
    const list = (e as CustomEvent<{ id: string; title: string; diffs: string[]; oldDesc?: string }[]>).detail || [];
    if (!list.length) return;
    list.forEach((it) => {
      /* 可一键恢复的字段：正文标签被删、描述被删 → 带恢复按钮 */
      const bodyTagLost = it.diffs.some((d) => d.includes('「#正文：」标签被删除'));
      const descLost = it.diffs.some((d) => d.includes('描述被删除'));
      if (bodyTagLost || descLost) {
        const msgs: string[] = [];
        if (bodyTagLost) msgs.push('丢了「#正文：」标签');
        if (descLost) msgs.push('描述被删除');
        addHint('node:' + it.id, `【${it.title || '该节点'}】${msgs.join('、')}（外部修改），直接在 Obsidian 恢复容易出错。`, () => {
          if (bodyTagLost) restoreBodyTag(it.id);
          if (descLost) restoreDesc(it.id, it.oldDesc);
        });
      } else {
        addHint('external', `【${it.title || '该节点'}】检测到不支持的字段变更：${it.diffs.join('、')}。 请在灵框内的「结构体管理」中修改，Obsidian 端不支持直接增删属性/描述/正文。`);
      }
    });
  }) as EventListener;
  window.addEventListener('lingkuang-vault-field-changed', onVaultFields);

  /* 自动修复通知（已修好，告知 + 可选以后不再提示） */
  const onAutoFixed = ((e: Event) => {
    if (localStorage.getItem('lingkuang-hide-auto-fix-notice') === '1') return;
    const list = (e as CustomEvent<string[]>).detail || [];
    if (!list.length) return;
    addHint('autofix', `已自动修复：${list.join('、')} 的格式（已补回标准「#描述：」/「#正文：」标签）。字段集合只能在左栏「结构体管理」里调整，内容值随意。`, undefined, { text: '不再提示此类', onClick: () => { localStorage.setItem('lingkuang-hide-auto-fix-notice', '1'); removeHint('autofix'); } });
  }) as EventListener;
  window.addEventListener('lingkuang-vault-auto-fixed', onAutoFixed);

  return {
    checkBodyTag,
    refresh: renderHints,
    dispose(): void {
      window.removeEventListener('lingkuang-vault-field-changed', onVaultFields);
      window.removeEventListener('lingkuang-vault-auto-fixed', onAutoFixed);
      hints.clear();
    },
  };
}
