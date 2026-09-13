/** 编辑器模块——文稿编辑（时间线节点 + 实体，Obsidian 式 #字段：值）：
 * 左侧 sidebar（时间线 tab：时间线→节点；实体 tab：类型→实体），右侧编辑 doc（失焦保存） */
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import { saveNodeDoc, addEntity } from '../store/actions';
import type { TimelineNode, Entity } from '../store/types';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { Image } from './image-ext';
import { Tag } from './tag-ext';
import { createPropsPanel } from './props-panel';
import type { PropsTarget as Target } from './props-panel';
import { promptDialog } from './confirm';

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}


export function renderEditor(store: Store, host: HTMLElement): () => void {
  host.style.overflow = 'hidden';
  host.innerHTML = `
    <div style="display:flex;height:100%;">
      <div style="width:300px;border-right:1px solid var(--border);display:flex;flex-direction:column;background:var(--surface-2);">
        <div style="padding:8px 10px;border-bottom:1px solid var(--border-soft);display:flex;align-items:center;gap:6px;">
          <span style="font-size:15px;font-weight:600;color:var(--fg);">编辑器</span>
          <span style="flex:1;"></span>
          <button id="ed-h1" title="标题" style="background:none;border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:2px 8px;cursor:pointer;">H</button>
          <button id="ed-img" style="background:none;border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:2px 10px;cursor:pointer;">插图</button>
          <button id="ed-tab-tl" style="background:none;border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:2px 10px;cursor:pointer;">时间线</button>
          <button id="ed-tab-entity" style="background:none;border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:2px 10px;cursor:pointer;">实体</button>
        </div>
        <div id="ed-sidebar" style="flex:1;overflow:auto;padding:6px 8px;"></div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;min-width:0;">
        <div id="ed-title" style="padding:8px 14px;border-bottom:1px solid var(--border-soft);font-size:var(--text-sm);color:var(--fg-2);">选择左侧节点/实体开始编辑（自动保存）</div>
        <div id="ed-props" style="display:none;padding:10px 14px;border-bottom:1px solid var(--border-soft);background:var(--surface-2);"></div>
        <div id="ed-hint" style="display:none;padding:8px 14px;border-bottom:1px solid var(--border-soft);background:rgba(217,101,92,.12);font-size:var(--text-xs);color:var(--fg);line-height:1.5;"></div>
        <div style="flex:1;display:flex;min-height:0;">
          <div id="ed-doc" style="flex:1;width:100%;background:var(--surface);border:none;height:100%;overflow:hidden;"></div>
        </div>
        <div id="ed-status" style="padding:4px 14px;border-top:1px solid var(--border-soft);font-size:var(--text-xs);color:var(--fg-2);"></div>
      </div>
    </div>`;

  const sidebar = host.querySelector('#ed-sidebar') as HTMLElement;
  const docBox = host.querySelector('#ed-doc') as HTMLElement;
  const hintEl = host.querySelector('#ed-hint') as HTMLElement;
  /* 全局提示条（累积列表）：多个文件出错并列展示，各自带「恢复格式」/自定义按钮；key 去重 */
  const hints = new Map<string, { msg: string; onRestore?: () => void; actionBtn?: { text: string; onClick: () => void } }>();
  function renderHints(): void {
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
  hintEl.onclick = () => { hints.clear(); renderHints(); };
  /* 校验节点原始 .md 是否缺 #正文： 标签（外部误删会破坏编辑器正文结构）；缺且节点有正文内容时报错 + 恢复 */
  async function checkBodyTag(w: string, tl: string, id: string, doc: string, title: string): Promise<void> {
    const api = (window as any).lingkuangAPI;
    if (!api?.readNodeText) return;
    try {
      const res = await api.readNodeText(w, tl, id);
      /* 异步返回时若已切到别的节点，忽略本次结果（防旧提示闪现） */
      if (id !== currentNodeId) return;
      if (!res || !res.ok || !res.text) return;
      if (!/#正文[：:]/.test(res.text) && doc) {
        addHint('node:' + id, `【${title || '该节点'}】的文件丢了「#正文：」标签（外部修改），直接在 Obsidian 恢复容易出错。`, () => {
          saveNodeDoc(store, tl, id, doc);
          status.textContent = '已恢复 ✓';
          removeHint('node:' + id); /* 恢复后移除该条 */
        });
      } else {
        removeHint('node:' + id); /* 该节点校验通过（标签在）→ 移除它的提示 */
      }
      /* 其他情况不隐藏：提示条全局常驻，切节点/正常节点都不清，方便看到哪个文件出问题 */
    } catch (e) { /* 读取失败不打扰 */ }
  }
  /* 监听外部（Obsidian）对节点字段的增删 → 显示提示框。
     两个 window 监听都留了具名引用：切走工具时要 removeEventListener，
     否则每进一次编辑器就多积一对永久监听（它们持有本函数整个作用域）。 */
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
  function findNodeById(id: string): { tlId: string; node: any } | null {
    for (const ws of Object.values(store.data.worldsets)) {
      for (const tlId of (ws.order ?? [])) {
        const tl = ws.timelines?.[tlId];
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
    status.textContent = '已恢复 ✓';
    removeHint('node:' + id);
  }
  /* 恢复描述：把旧描述写回该节点，触发落盘补回 #描述： */
  function restoreDesc(id: string, oldDesc?: string): void {
    if (oldDesc === undefined) return;
    store.update((d) => {
      for (const ws of Object.values(d.worldsets)) {
        for (const tlId of (ws.order ?? [])) {
          const tl = ws.timelines?.[tlId];
          const n = (tl?.nodes ?? []).find((x: any) => x.id === id);
          if (n) { n.desc = oldDesc; return; }
        }
      }
    });
    status.textContent = '已恢复 ✓';
    removeHint('node:' + id);
  }
  /* tiptap 所见即所得编辑器（输入 # 变标题等 → markdown 双向转，vault 保持 Obsidian markdown 外部可读） */
  const editor = new Editor({
    element: docBox, extensions: [StarterKit, Markdown, Image, Tag], contentType: 'markdown', content: '',
  });
  function getDocMd(): string {
    /* 清理 tiptap 序列化的孤立 &nbsp; 空行（保留真实内容，去掉纯占位空行）。
       旧写法 /(^|\n)(\s*&nbsp;\s*)+\n?/g 里的 \s 会吃掉换行且是贪婪的，
       于是 "A\n\n&nbsp;\n\nB"（A 和 B 是两个段落）被压成 "A\nB" —— 段落分隔丢了。
       改成：只认「整行除 &nbsp; 外只有空格制表符」的占位行，删掉它并保留两侧换行，
       再把 3 个以上连续换行折回 markdown 里等价的两个（空段落本来就是段落分隔符）。 */
    return (editor.getMarkdown() || '')
      .replace(/(^|\n)[ \t]*(?:&nbsp;[ \t]*)+(?=\n|$)/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+/, '');
  }
  function setDoc(md: string): void {
    editor.commands.setContent(md || '', { contentType: 'markdown' });
  }

  /* ── 当前编辑目标 ──────────────────────────────────────────────
     target 绑定「文档框里现在装的是谁的内容」，并且带 world。它修掉两个坑：
     1) 旧实现按 tab + currentNodeId/currentEntityId 决定存到哪，而 setTab 既不重载
        文档也不清 id → 「节点 → 实体 tab → 回时间线 tab → 点空白」blur 时会把实体的
        正文写进节点正文（用户一个字都没改）；
     2) 侧栏遍历所有世界，保存却一律走 store.activeWorld → 编辑非活动世界的节点被
        静默丢弃（`if (n)` 直接 no-op），状态栏还显示「已保存 ✓」。 */
  /* Target 现在由 ./props-panel 导出（PropsTarget 的别名，见文件头 import）——
     属性面板是公共模块，节点/实体两条路共用同一个身份类型，不再各留一份联合类型。 */
  let target: Target | null = null;
  /* 每个 tab 各记住上次打开的文档，切回来能恢复（且 target 与文档框内容始终一致） */
  const lastTarget: Record<'tl' | 'entity', Target | null> = { tl: null, entity: null };

  /** 就地改 target 指向的对象（走 store.update，用 target 自己的 world） */
  function patchTarget(fn: (o: TimelineNode | Entity) => void): void {
    const t = target;
    if (!t) return;
    store.update((d) => {
      const ws = d.worldsets[t.world];
      if (!ws) return;
      if (t.kind === 'node') {
        const n = ws.timelines[t.tlId]?.nodes.find((x) => x.id === t.nodeId);
        if (n) fn(n);
      } else {
        const e = ws.entities?.[t.entityId];
        if (e) fn(e);
      }
    });
  }
  function docOf(t: Target): string {
    const ws = store.data.worldsets[t.world];
    if (!ws) return '';
    return t.kind === 'node'
      ? ws.timelines[t.tlId]?.nodes.find((x) => x.id === t.nodeId)?.doc ?? ''
      : ws.entities?.[t.entityId]?.doc ?? '';
  }
  function titleOf(t: Target): string {
    const ws = store.data.worldsets[t.world];
    if (!ws) return '';
    return t.kind === 'node'
      ? ws.timelines[t.tlId]?.nodes.find((x) => x.id === t.nodeId)?.title ?? ''
      : ws.entities?.[t.entityId]?.name ?? '';
  }
  /** 把文档框内容落盘到 target（没有 target 就不写，避免把 A 的内容写给 B） */
  function flushDoc(): void {
    const t = target;
    if (!t) return;
    const md = getDocMd();
    if (t.kind === 'node') saveNodeDoc(store, t.tlId, t.nodeId, md, { world: t.world });
    else store.update((d) => { const e = d.worldsets[t.world]?.entities?.[t.entityId]; if (e) e.doc = md; });
    status.textContent = '已保存 ✓';
  }
  /* 点击编辑器空白区 → 聚焦 tiptap，进入输入 */
  docBox.addEventListener('click', () => { editor.commands.focus(); });
  const titleEl = host.querySelector('#ed-title') as HTMLElement;
  const propsEl = host.querySelector('#ed-props') as HTMLElement;
  const status = host.querySelector('#ed-status') as HTMLElement;
  const tabTl = host.querySelector('#ed-tab-tl') as HTMLElement;
  const tabEntity = host.querySelector('#ed-tab-entity') as HTMLElement;
  const imgBtn = host.querySelector('#ed-img') as HTMLElement;
  const h1Btn = host.querySelector('#ed-h1') as HTMLElement;
  /* 属性面板（公共模块 src/ui/props-panel.ts）：节点与实体共用一份「改字段」实现。
     面板自己从 getTarget() + store 推导目标对象，写回走本函数作用域里的 patchTarget
     （撤销语义不变）；status 用来显示「已保存 ✓」。 */
  const propsPanel = createPropsPanel({ store, host: propsEl, status, getTarget: () => target, patchTarget });
  let tab: 'tl' | 'entity' = 'tl';
  let currentTlId = '';
  let currentNodeId = '';
  let currentEntityId = '';
  /* 树展开状态（Obsidian 文件树）：世界 + 时间线 + 类型文件夹三级可展开/折叠 */
  const expandedWorlds = new Set<string>();
  const expandedTls = new Set<string>();
  const expandedKinds = new Set<string>();   /* key = ws::tl::kind */

  function setTab(t: 'tl' | 'entity') {
    if (t !== tab) flushDoc();   /* 切换前先把正在编辑的内容落盘，别丢改动 */
    tab = t;
    tabTl.style.background = t === 'tl' ? 'rgba(158,194,98,.15)' : 'none';
    tabEntity.style.background = t === 'entity' ? 'rgba(158,194,98,.15)' : 'none';
    /* 恢复该 tab 上次打开的文档。关键：target 必须与文档框内容严格一致——
       旧实现只切 tab 不重载文档也不清 id，文档框里留着上一个 tab 的内容，
       而 blur 按新 tab 的 id 保存 → 节点正文被实体正文覆盖。 */
    target = lastTarget[t];
    setDoc(target ? docOf(target) : '');
    if (target) titleEl.textContent = titleOf(target);
    renderSidebar();
  }

  /** 树里的一行"空提示"（没有内容的文件夹展开时给一句人话，而不是一片空白） */
  function emptyRow(text: string): HTMLElement {
    const d = document.createElement('div');
    d.className = 'ed-tempty';
    d.textContent = text;
    return d;
  }

  /** 选中一个实体（「实体」页签的树 + 「时间线」页签树里的 `_设定` 分支共用这一份）。
   *  ⚠️ 树里列的是**所有世界**的实体，所以点到别的世界那一行时先把活动世界切过去，
   *  否则 currentWorld(store) 里找不到它（静默无反应）。 */
  function selectEntity(id: string, world?: string): void {
    const wName = world ?? store.activeWorld;
    if (wName !== store.activeWorld && store.data.worldsets[wName]) store.setActiveWorld(wName);
    const e = currentWorld(store).entities?.[id];
    if (!e) return;
    currentEntityId = id;
    target = { kind: 'entity', world: store.activeWorld, entityId: id };
    lastTarget.entity = target;
    setDoc(e.doc ?? '');
    propsPanel.render(e, true);
    titleEl.textContent = e.name;
    status.textContent = '失焦自动保存';
    renderSidebar();
  }

  function renderSidebar() {
    const ws = currentWorld(store);
    sidebar.innerHTML = '';
    if (tab === 'tl') {
      /* 世界 → 时间线 → 节点 三层树（Obsidian 风格，可展开/折叠） */
      const worlds = Object.keys(store.data.worldsets);
      const frag = document.createElement('div');
      frag.className = 'ed-tree';
      worlds.forEach((wName) => {
        const w = store.data.worldsets[wName];
        const wOpen = expandedWorlds.has(wName);
        const rec = document.createElement('div');
        rec.className = 'ed-tnode ed-tworld' + (wOpen ? ' is-open' : '');
        rec.dataset.kind = 'world';
        rec.dataset.path = wName;
        rec.innerHTML = `
          <span class="ed-tcaret"></span><span class="ed-tlabel">${escape(wName)}</span>
          <span class="ed-tcount">${(w.order ?? []).filter((id) => w.timelines[id]).length}</span>`;
        frag.appendChild(rec);
        if (wOpen) {
          (w.order ?? []).filter((id) => w.timelines[id]).forEach((tlId) => {
            const tl = w.timelines[tlId];
            const tOpen = expandedTls.has(wName + '::' + tlId);
            const tRec = document.createElement('div');
            tRec.className = 'ed-tnode ed-ttl' + (tOpen ? ' is-open' : '');
            tRec.dataset.kind = 'tl';
            tRec.dataset.world = wName;
            tRec.dataset.path = tlId;
            tRec.innerHTML = `
              <span class="ed-tcaret"></span><span class="ed-tlabel">${escape(tl?.name ?? '?')}</span>
              <span class="ed-tcount">${tl?.nodes?.length ?? 0}</span>`;
            frag.appendChild(tRec);
            if (tOpen && tl) {
              /* 种类文件夹 = **这条时间线里真的有节点的种类**（= 硬盘上真有的文件夹，一一对应）。
                 ⚠️ 不要再从「结构体管理」（`store.data.formats`）里把**没节点的种类也列出来**：
                 内建默认里那几个种类名（角色/地点/物品/组织）跟**实体类型**重名，凭空画出来会
                 让「主线」和「_设定」下面同时挂一个「角色」文件夹 —— 用户 2026-09-13 报：
                 「我指的是角色，地点，物品等文件夹同时存在于主线与设定文件夹下，是bug」。
                 想知道有哪些种类可用，看左栏「结构体管理」；想新建节点，在沙盘里建。 */
              const used = new Map<string, any[]>();
              for (const n of tl.nodes ?? []) {
                const k = (n as any).kind || '事件';
                if (!used.has(k)) used.set(k, []);
                used.get(k)!.push(n);
              }
              const fmts = store.data.formats ?? {};
              [...used.keys()].forEach((k) => {
                const nodes = used.get(k) ?? [];
                const kOpen = expandedKinds.has(wName + '::' + tlId + '::' + k);
                const kRec = document.createElement('div');
                kRec.className = 'ed-tnode ed-tkind' + (kOpen ? ' is-open' : '');
                kRec.dataset.kind = 'tkind';
                kRec.dataset.world = wName;
                kRec.dataset.tl = tlId;
                kRec.dataset.path = k;
                kRec.innerHTML = `<span class="ed-tcaret"></span><span class="ed-tlabel">${escape(fmts[k]?.name ?? k)}</span><span class="ed-tcount">${nodes.length}</span>`;
                frag.appendChild(kRec);
                if (kOpen) {
                  nodes.forEach((n) => {
                    const nRec = document.createElement('div');
                    const isOn = n.id === currentNodeId && currentTlId === tlId;
                    nRec.className = 'ed-tnode ed-tnode-item' + (isOn ? ' is-on' : '');
                    nRec.dataset.kind = 'node';
                    nRec.dataset.world = wName;
                    nRec.dataset.tl = tlId;
                    nRec.dataset.path = n.id;
                    nRec.innerHTML = `<span class="ed-tlabel">${escape(n.title)}</span>`;
                    frag.appendChild(nRec);
                  });
                }
              });
            }
          });
          /* ── `_设定`：这个世界里的**实体**（硬盘上是 `<世界>/_设定/<类型>/<名字>.md`） ──
             用户 2026-09-13：「编辑器的树现在只能显示事件节点，其他结构体的文件夹没有在树里面」
             ⇒ 树要跟硬盘上的文件夹一一对应：`_设定` 也当一层"结构体文件夹"列出来，
             类型**全部列出**（哪怕一个实体都没有，空的置灰）。点实体行 = 切到「实体」页签再选中它
             （页签各自记着自己打开的那份文档，不能就地换，否则正文会串）。 */
          const ents = Object.values(w.entities ?? {});
          const setKey = 'setting::' + wName;
          const sOpen = expandedTls.has(setKey);
          const sRec = document.createElement('div');
          sRec.className = 'ed-tnode ed-tset' + (sOpen ? ' is-open' : '');
          sRec.dataset.kind = 'set';
          sRec.dataset.world = wName;
          sRec.dataset.path = '_设定';
          sRec.innerHTML = `<span class="ed-tcaret"></span><span class="ed-tlabel">_设定</span><span class="ed-tcount">${ents.length}</span>`;
          frag.appendChild(sRec);
          if (sOpen) {
            const ets = Object.entries(w.entityTypes ?? {});
            if (!ets.length) frag.appendChild(emptyRow('还没有实体类型（左栏「结构体管理 → 实体类型」里加）'));
            ets.forEach(([tid, t]) => {
              const kids = ents.filter((e) => e.typeId === tid);
              const eOpen = expandedTls.has('entity::' + tid);
              const eRec = document.createElement('div');
              eRec.className = 'ed-tnode ed-ttype ed-tset-type' + (eOpen ? ' is-open' : '') + (kids.length ? '' : ' is-empty');
              eRec.dataset.kind = 'etype';
              eRec.dataset.world = wName;
              eRec.dataset.path = tid;
              eRec.innerHTML = `<span class="ed-tcaret"></span><span class="ed-tlabel">${escape(t.name)}</span><span class="ed-tcount">${kids.length}</span>`;
              frag.appendChild(eRec);
              if (eOpen) {
                if (!kids.length) frag.appendChild(emptyRow('这个类型还没有实体'));
                kids.forEach((e) => {
                  const nRec = document.createElement('div');
                  nRec.className = 'ed-tnode ed-tnode-item' + (e.id === currentEntityId ? ' is-on' : '');
                  nRec.dataset.kind = 'entity';
                  nRec.dataset.world = wName;
                  nRec.dataset.path = e.id;
                  nRec.innerHTML = `<span class="ed-tlabel">${escape(e.name)}</span>`;
                  frag.appendChild(nRec);
                });
              }
            });
          }
        }
      });
      frag.querySelectorAll('.ed-tnode').forEach((el) => {
        el.addEventListener('click', () => {
          const kind = (el as HTMLElement).dataset.kind;
          if (kind === 'world') {
            const p = (el as HTMLElement).dataset.path!;
            if (expandedWorlds.has(p)) expandedWorlds.delete(p); else expandedWorlds.add(p);
            renderSidebar();
          } else if (kind === 'tl') {
            const w = (el as HTMLElement).dataset.world!;
            const p = (el as HTMLElement).dataset.path!;
            const key = w + '::' + p;
            if (expandedTls.has(key)) expandedTls.delete(key); else expandedTls.add(key);
            renderSidebar();
          } else if (kind === 'tkind') {
            const w = (el as HTMLElement).dataset.world!;
            const tl = (el as HTMLElement).dataset.tl!;
            const k = (el as HTMLElement).dataset.path!;
            const key = w + '::' + tl + '::' + k;
            if (expandedKinds.has(key)) expandedKinds.delete(key); else expandedKinds.add(key);
            renderSidebar();
          } else if (kind === 'set') {
            /* `_设定` 这一层（实体） */
            const key = 'setting::' + (el as HTMLElement).dataset.world!;
            if (expandedTls.has(key)) expandedTls.delete(key); else expandedTls.add(key);
            renderSidebar();
          } else if (kind === 'etype') {
            /* `_设定` 下的类型文件夹：展开态与「实体」页签共用（key = entity::<类型 id>） */
            const key = 'entity::' + (el as HTMLElement).dataset.path!;
            if (expandedTls.has(key)) expandedTls.delete(key); else expandedTls.add(key);
            renderSidebar();
          } else if (kind === 'entity') {
            /* 在「时间线」页签的树里点实体：**就地**把右边打开的文档换成这个实体，
               **不切页签** —— 用户 2026-09-13 反馈：「点到设定里面的实体文件时
               测试世界观文件夹会消失，事件文件夹也没了」（切页签 = 左栏整棵树换成
               「实体」页签那套类型列表，世界的层级与展开态全没了）。
               安全性：先把当前文档落盘再换 target（与 setTab 同一条纪律）；
               `lastTarget.tl` **不动**（时间线页签"上次打开的节点"照旧），
               `selectEntity` 里会把 `lastTarget.entity` 指向这个实体，所以
               之后手动切到「实体」页签时打开的正是它。 */
            const id = (el as HTMLElement).dataset.path!;
            flushDoc();
            selectEntity(id, (el as HTMLElement).dataset.world);
          } else if (kind === 'node') {
            const w = (el as HTMLElement).dataset.world!;
            const tl = (el as HTMLElement).dataset.tl!;
            const id = (el as HTMLElement).dataset.path!;
            currentTlId = tl; currentNodeId = id;
            target = { kind: 'node', world: w, tlId: tl, nodeId: id };
            lastTarget.tl = target;
            const node = store.data.worldsets[w]?.timelines[tl]?.nodes.find((x) => x.id === id);
            setDoc(node?.doc ?? '');
            propsPanel.render(node ?? undefined);
            titleEl.textContent = node?.title ?? '';
            status.textContent = '失焦自动保存';
            /* 校验 #正文： 标签；提示条全局常驻（不清），提示里带文件名 */
            checkBodyTag(w, tl, id, node?.doc ?? '', node?.title ?? '');
            renderSidebar();
          }
        });
      });
      sidebar.appendChild(frag);
      return;
    }
    /* 实体 tab：类型 → 实体 树（可展开，同样去绿色字体） */
    const types = ws.entityTypes ?? {};
    const entities = ws.entities ?? {};
    sidebar.innerHTML = `
      <div style="display:flex;gap:4px;margin-bottom:6px;">
        <select id="ed-entity-type" title="新建实体用哪个类型（= 模板，在左栏「结构体管理」的“实体类型”分区里增删字段）" style="flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:3px 4px;font-size:11px;outline:none;">${Object.entries(types).map(([tid, t]) => `<option value="${escape(tid)}">${escape(t.name)}</option>`).join('')}</select>
        <button id="ed-entity-new" style="flex:1;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:3px;cursor:pointer;">＋实体</button>
        <button id="ed-type-new" style="flex:1;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);font-size:11px;padding:3px;cursor:pointer;">＋类型</button>
      </div>
      <div id="ed-entity-list"></div>`;
    sidebar.querySelector('#ed-entity-new')?.addEventListener('click', () => {
      /* 用下拉里选的类型（旧写法硬编码「取第一个类型」，还不带类型选择入口） */
      const picked = (sidebar.querySelector('#ed-entity-type') as HTMLSelectElement | null)?.value;
      const typeId = picked || Object.keys(types)[0] || 'default';
      const id = addEntity(store, { typeId, name: '新实体' });
      currentEntityId = id;
      target = { kind: 'entity', world: store.activeWorld, entityId: id };
      lastTarget.entity = target;
      const e = currentWorld(store).entities?.[id];
      setDoc(e?.doc ?? '');
      propsPanel.render(e ?? undefined, true);
      titleEl.textContent = '新实体';
      renderSidebar();
    });
    sidebar.querySelector('#ed-type-new')?.addEventListener('click', () => {
      void promptDialog({
        title: '新建实体类型',
        message: '类型就是这套实体的模板（定义该有哪些字段）。字段在左栏「结构体管理」的“实体类型”分区里增删。',
        label: '类型名（如 势力 / 种族 / 魔法体系）',
        placeholder: '势力',
        confirmText: '创建',
      }).then((name) => {
        const k = (name ?? '').trim();
        if (!k) return;
        store.update((d) => {
          const ws2 = d.worldsets[store.activeWorld];
          if (!ws2) return;
          if (!ws2.entityTypes) ws2.entityTypes = {};
          if (ws2.entityTypes[k]) return;
          ws2.entityTypes[k] = { id: k, name: k, fields: [] };
        });
        renderSidebar();
        status.textContent = `已建类型「${k}」· 到「结构体管理」加字段`;
      });
    });
    const el = sidebar.querySelector('#ed-entity-list') as HTMLElement;
    const frag = document.createElement('div');
    frag.className = 'ed-tree';
    Object.entries(types).forEach(([tid, t]) => {
      const eOpen = expandedTls.has('entity::' + tid);
      const tRec = document.createElement('div');
      tRec.className = 'ed-tnode ed-ttype' + (eOpen ? ' is-open' : '');
      tRec.dataset.kind = 'etype';
      tRec.dataset.path = tid;
      tRec.innerHTML = `<span class="ed-tcaret"></span><span class="ed-tlabel">${escape(t.name)}</span><span class="ed-tcount">${Object.values(entities).filter((e) => e.typeId === tid).length}</span>`;
      frag.appendChild(tRec);
      if (eOpen) {
        Object.values(entities).filter((e) => e.typeId === tid).forEach((e) => {
          const nRec = document.createElement('div');
          const isOn = e.id === currentEntityId;
          nRec.className = 'ed-tnode ed-tnode-item' + (isOn ? ' is-on' : '');
          nRec.dataset.kind = 'entity';
          nRec.dataset.path = e.id;
          nRec.innerHTML = `<span class="ed-tlabel">${escape(e.name)}</span>`;
          frag.appendChild(nRec);
        });
      }
    });
    frag.querySelectorAll('.ed-tnode').forEach((el) => {
      el.addEventListener('click', () => {
        const kind = (el as HTMLElement).dataset.kind;
        const path = (el as HTMLElement).dataset.path!;
        if (kind === 'etype') {
          const key = 'entity::' + path;
          if (expandedTls.has(key)) expandedTls.delete(key); else expandedTls.add(key);
          renderSidebar();
        } else if (kind === 'entity') {
          selectEntity(path, (el as HTMLElement).dataset.world);
        }
      });
    });
    el.appendChild(frag);
  }

  /* 失焦保存：tiptap blur 时写回 markdown（vault 仍存 Obsidian markdown）。
     一律按 target 存——target 是「文档框里现在装的那份文档」的身份（含 world），
     与当前 tab / 当前活动世界无关，所以既不会串文档，也不会在编辑非活动世界的
     节点时静默丢弃（后者旧实现还会照样显示「已保存 ✓」）。 */
  editor.on('blur', () => { if (target) flushDoc(); });

  tabTl.addEventListener('click', () => setTab('tl'));
  tabEntity.addEventListener('click', () => setTab('entity'));
  /* 标题按钮：把当前段落设为一级标题（tiptap setHeading，可靠所见即所得） */
  h1Btn.addEventListener('click', () => {
    editor.chain().focus().toggleHeading({ level: 1 }).run();
  });
  /* 插入图片：弹文件框 → 导入 vault assets → 在光标处插入 markdown 图片（所见即所得显示） */
  imgBtn.addEventListener('click', async () => {
    const api = (window as any).lingkuangAPI;
    if (!api?.importImage) return;
    const res = await api.importImage();
    if (res?.ok && res.path) {
      editor.chain().focus().setImage({ src: res.path, alt: '' }).run();
      status.textContent = '已插入图片 ✓';
    } else if (res?.canceled) {
      /* 用户取消，不提示 */
    } else {
      status.textContent = String(res?.error ?? '插入图片失败');
    }
  });
  const unsubSidebar = store.subscribe(() => renderSidebar());
  setTab('tl');
  /* 切走工具时的清理：先把未落的编辑交出去，再拆掉编辑器/订阅/全局监听。
     旧实现只由 registry.openTool 清 host.innerHTML，tiptap 实例、两个 window
     监听和 store 订阅都留在内存里，每点一次「编辑器」多积一份。 */
  return () => {
    if (target) flushDoc();
    unsubSidebar();
    window.removeEventListener('lingkuang-vault-field-changed', onVaultFields);
    window.removeEventListener('lingkuang-vault-auto-fixed', onAutoFixed);
    editor.destroy();
  };
}
