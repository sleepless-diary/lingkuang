/** 灵框 · 入口（Vite） */
import createStore, { emptyData } from './store/store';
import { renderShell } from './ui/shell';
import { disposeCurrentTool } from './tools/registry';
import './style.css';

/** 数据加载：优先 vault(.md 文件为源)；无 vault 则回退 JSON/空数据 */
async function loadData() {
  const api = (window as any).lingkuangAPI;
  /* ⓪ 先读 JSON 兜底数据：.md 只承载节点，循环/剧情线/历法/时间指针/世界笔记
     只存在于 JSON 里。下面 vaultToWorldData 要用它回填——不回填的话，
     「vault 为源」每次启动都会把这些字段清空（启用 vault 后建的循环/剧情线活不过一次重启）。 */
  let jsonData: any = null;
  if (api && api.loadData) {
    try {
      const res = await api.loadData();
      if (res && res.ok && res.data) jsonData = res.data;
    } catch (e) { /* JSON 读失败就只靠 vault */ }
  }
  /* ① vault 为源：扫描 .md 文件生成 store 数据（节点以文件为准，其余字段从 JSON 回填） */
  if (api && api.vaultScan) {
    try {
      const vres = await api.vaultScan();
      if (vres && vres.ok && vres.worlds) {
        const data = vaultToWorldData(vres.worlds, jsonData);
        if (Object.keys(data.worldsets).length) return data;
      }
    } catch (e) { /* vault 失败则回退 */ }
  }
  /* ② 回退 JSON（旧数据/首次） */
  if (jsonData) return jsonData;
  return emptyData();
}

/** vault 扫描结果 {世界观:{时间线:[节点]}} → WorldData。
 *  `base` = 现有数据（启动时来自 JSON 缓存，重载时来自 store），用于回填 .md 表达不了的字段：
 *  loops / storylines / calendar / absOffset / docs / timeCursor。
 *  只在「vault 里确实存在这条时间线/这个世界」时回填——vault 里没有的一律不复活，
 *  否则外部删掉整个文件夹后，旧数据会把整批节点一起带回来。 */
function vaultToWorldData(
  worlds: Record<string, Record<string, any[]>>,
  base?: { worldsets?: Record<string, any> } | null,
) {
  const worldsets: Record<string, any> = {};
  for (const [wsName, tls] of Object.entries(worlds || {})) {
    const baseWs = base?.worldsets?.[wsName];
    const timelines: Record<string, any> = {};
    const order: string[] = [];
    for (const [tlName, nodes] of Object.entries(tls || {})) {
      const id = 'tl-' + tlName;
      const prev = baseWs?.timelines?.[id];
      timelines[id] = {
        id,
        name: tlName,
        absOffset: prev?.absOffset ?? 0,
        nodes,
        loops: Array.isArray(prev?.loops) ? prev.loops : [],
        storylines: Array.isArray(prev?.storylines) ? prev.storylines : [],
        /* 自定义历法只存在 JSON 里，丢了就等于世界观的时间体系被重置 */
        ...(prev?.calendar ? { calendar: prev.calendar } : {}),
      };
      order.push(id);
    }
    /* 先继承 base（JSON 缓存）里的整份世界设定，再用 vault 结果覆写「以 .md 为源」的部分。
       以前只挑 name/timelines/order/docs/timeCursor 重建，把 vault 里**根本不存在**的字段
       全丢了：`maps`（地图的区域/标记/路径）、`entities` / `entityTypes`（实体库）。
       而 vault 是源、外部 Obsidian 每改一次就回扫一次 —— 于是这些数据每次都被清空，
       紧接着又被写回 JSON 变成永久丢失（实测：回扫后 maps 被换成一张新建的空默认地图）。 */
    worldsets[wsName] = {
      ...baseWs,
      name: wsName,
      timelines,
      order,
      docs: baseWs?.docs ?? {},
      timeCursor: baseWs?.timeCursor ?? null,
    };
  }
  return { worldsets };
}

/** 对比重载前后节点字段，检测外部（Obsidian）对属性/描述/正文的增删。灵框自写时 store 与 vault 一致，不会误报。 */
function nodeFieldDiff(oldData: any, newData: any): { id: string; title: string; diffs: string[]; oldDesc?: string }[] {
  const results: { id: string; title: string; diffs: string[]; oldDesc?: string; oldProps?: Record<string, any>; oldFixed?: { year?: number; precision?: string; type?: string } }[] = [];
  /* 索引旧数据节点 by id */
  const oldById: Record<string, any> = {};
  for (const ws of Object.values(oldData.worldsets ?? {}) as any[]) {
    for (const tlId of (ws.order ?? [])) {
      const tl = ws.timelines?.[tlId];
      if (!tl) continue;
      for (const n of tl.nodes ?? []) oldById[n.id] = n;
    }
  }
  for (const ws of Object.values(newData.worldsets ?? {}) as any[]) {
    for (const tlId of (ws.order ?? [])) {
      const tl = ws.timelines?.[tlId];
      if (!tl) continue;
      for (const n of tl.nodes ?? []) {
        const old = oldById[n.id];
        if (!old) continue; /* 新节点不提示 */
        const diffs: string[] = [];
        const oldProps = old.properties ?? {};
        const nProps = n.properties ?? {};
        const oldKeys = new Set(Object.keys(oldProps));
        const newKeys = new Set(Object.keys(nProps));
        for (const k of newKeys) if (!oldKeys.has(k)) diffs.push(`属性「${k}」新增`);
        for (const k of oldKeys) if (!newKeys.has(k)) diffs.push(`属性「${k}」被删除`);
        /* 共同键的值变化（如值被清空/修改）也计入属性变更，便于自动回退 */
        for (const k of oldKeys) {
          if (newKeys.has(k) && JSON.stringify(oldProps[k]) !== JSON.stringify(nProps[k])) {
            diffs.push(nProps[k] === '' || nProps[k] === undefined || nProps[k] === null ? `属性「${k}」值被清空` : `属性「${k}」值被修改`);
          }
        }
        /* 固定字段（year/precision/type/title）被外部删除 → 报告并恢复 */
        const oldFixed: { year?: number; precision?: string; type?: string } = {};
        if (old.year !== undefined && n.year === undefined) { diffs.push('year 字段被删除'); oldFixed.year = old.year; }
        if (old.precision !== undefined && n.precision === undefined) { diffs.push('precision 字段被删除'); oldFixed.precision = old.precision; }
        if (old.type !== undefined && n.type === undefined) { diffs.push('type 字段被删除'); oldFixed.type = old.type; }
        if (old.desc && !n.desc) diffs.push('描述被删除');
        if (old.doc && !n.doc) diffs.push('正文被删除');
        /* #正文： 标签被删但正文内容还在（doc 仍非空）：外部删了标签，易破坏编辑器正文结构 */
        if (old._hasBodyTag && n._hasBodyTag === false) diffs.push('「#正文：」标签被删除');
        const hasPropChange = oldKeys.size !== newKeys.size || [...oldKeys].some((k) => !newKeys.has(k)) || [...newKeys].some((k) => !oldKeys.has(k)) || [...oldKeys].some((k) => newKeys.has(k) && JSON.stringify(oldProps[k]) !== JSON.stringify(nProps[k]));
        const hasFixedChange = Object.keys(oldFixed).length > 0;
        if (diffs.length) results.push({ id: n.id, title: n.title || '', diffs, oldDesc: old.desc && !n.desc ? old.desc : undefined, oldProps: hasPropChange ? old.properties : undefined, oldFixed: hasFixedChange ? oldFixed : undefined });
      }
    }
  }
  return results;
}

/** 自动修复可安全恢复的字段（描述被删/「#正文：」标签被删），写回 store 触发落盘；返回已修复的节点标题列表 */
function autoFixFieldDiffs(store: any, repairable: { id: string; title: string; oldDesc?: string; oldProps?: Record<string, any>; oldFixed?: { year?: number; precision?: string; type?: string }; diffs: string[] }[]): string[] {
  const repaired: string[] = [];
  for (const d of repairable) {
    const bodyLost = d.diffs.some((x) => x.includes('「#正文：」标签被删除'));
    const descLost = d.diffs.some((x) => x.includes('描述被删除'));
    const propLost = d.diffs.some((x) => x.startsWith('属性「'));
    const fixedLost = d.diffs.some((x) => x.includes('字段被删除'));
    if (bodyLost || descLost || propLost || fixedLost) {
      store.update((dd: any) => {
        for (const ws of Object.values(dd.worldsets) as any[]) {
          for (const tlId of (ws.order ?? [])) {
            const tl = ws.timelines?.[tlId];
            const n = (tl?.nodes ?? []).find((x: any) => x.id === d.id);
            if (n) {
              if (bodyLost) n.doc = n.doc ?? ''; /* 触发落盘重写，nodeToMd 补回 #正文： */
              if (descLost && d.oldDesc !== undefined) n.desc = d.oldDesc; /* 写回旧描述，补回 #描述： */
              if (propLost && d.oldProps !== undefined) n.properties = d.oldProps; /* 属性回退成灵框旧状态 */
              if (fixedLost && d.oldFixed) {
                if (d.oldFixed.year !== undefined) n.year = d.oldFixed.year;
                if (d.oldFixed.precision !== undefined) n.precision = d.oldFixed.precision;
                if (d.oldFixed.type !== undefined) n.type = d.oldFixed.type;
              }
              /* 对照 node.kind 格式补全缺失字段（formats 为权威，确保 Obsidian 删的字段补回） */
              const fmt = store.data.formats && store.data.formats[(n as any).kind || '事件'];
              if (fmt && fmt.fields && fmt.fields.length) {
                if (!n.properties) n.properties = {};
                for (const f of fmt.fields) {
                  if (n.properties[f.name] === undefined) {
                    n.properties[f.name] = f.type === 'number' ? 0 : f.type === 'boolean' ? false : '';
                  }
                }
              }
              return;
            }
          }
        }
      }, { undo: false });
      repaired.push(d.title || d.id);
    }
  }
  return repaired;
}

/** 根据内部小数年份推断精度（与 360 天/年制一致：月 1/12、日 1/360、时 1/8640、分 1/518400、秒 1/31104000）。
    仅用于缺失 precision 时补合理默认（月初等 day/month 重合的边界可能不精确，但比一律 year 好）。 */
function inferPrecision(year: any): string {
  if (year === undefined || year === null || Number.isNaN(+year)) return 'year';
  const y = +year;
  const frac = y - Math.floor(y + 1e-9);
  if (frac <= 1e-9) return 'year';
  const m = frac * 12;
  if (Math.abs(m - Math.round(m)) < 1e-6) return 'month';
  const d = frac * 360;
  if (Math.abs(d - Math.round(d)) < 1e-6) return 'day';
  const h = frac * 8640;
  if (Math.abs(h - Math.round(h)) < 1e-6) return 'hour';
  const mi = frac * 518400;
  if (Math.abs(mi - Math.round(mi)) < 1e-6) return 'minute';
  return 'second';
}

/** 对照 node.kind 格式补全缺失字段（formats 为权威；解决 Obsidian 打开前删的属性也补回）。启动 + 外部改动后调用 */
function ensureAllFormatFields(store: any): void {
  let changed = false;
  for (const ws of Object.values(store.data.worldsets) as any[]) {
    for (const tlId of (ws.order ?? [])) {
      const tl = ws.timelines?.[tlId];
      if (!tl) continue;
      for (const n of tl.nodes ?? []) {
        /* 固定字段缺失补默认（precision/type 任何节点都应有；kind 由所在文件夹决定，旧数据缺失归「事件」） */
        if ((n as any).precision === undefined) { (n as any).precision = inferPrecision((n as any).year); changed = true; }
        if ((n as any).type === undefined) { (n as any).type = 'world_event'; changed = true; }
        if ((n as any).kind === undefined) { (n as any).kind = '事件'; changed = true; }
        const fmt = store.data.formats && store.data.formats[(n as any).kind || '事件'];
        if (!fmt || !fmt.fields || !fmt.fields.length) continue;
        /* 格式为唯一权威：删除格式外多余属性（Obsidian 新加的、格式没有的键）；Obsidian 元数据（cssclasses/tags 等）除外 */
        const allowed = new Set(fmt.fields.map((f: any) => f.name));
        const OBSIDIAN_META = new Set(['cssclasses', 'cssclass', 'tags', 'aliases']);
        if (n.properties) {
          for (const k of Object.keys(n.properties)) {
            if (!allowed.has(k) && !OBSIDIAN_META.has(k)) { delete n.properties[k]; changed = true; }
          }
        } else {
          n.properties = {};
        }
        /* 补全格式内缺失字段（值随意，格式字段保留用户填的） */
        for (const f of fmt.fields) {
          if (n.properties[f.name] === undefined) {
            n.properties[f.name] = f.type === 'number' ? 0 : f.type === 'boolean' ? false : '';
            changed = true;
          }
        }
      }
    }
  }
  if (changed) store.update(() => {}, { undo: false }); /* 触发落盘，把补全字段写回 vault */
}

async function main() {
  const data = await loadData();
  const store = createStore(data);
  /* 加载格式定义（kind → 应填字段集合）进 store.formats */
  try {
    const api0 = (window as any).lingkuangAPI;
    if (api0?.loadFormats) {
      const fr = await api0.loadFormats();
      if (fr && fr.ok && fr.data) {
        store.update((d) => { d.formats = fr.data; }, { undo: false });
      }
    }
  } catch (e) { /* 格式加载失败不影响启动 */ }
  /* 自动落盘：任何 store 变化 → 防抖 400ms → 写 vault(.md 为源) + JSON 缓存 */
  let saveTimer: number | undefined;
  let suppressWrite = false;   /* 外部 vault 改动重载时设为 true，避免写回造成循环 */
  let pendingWrite = false;    /* 有改动还没落盘（退出前要同步补写） */
  /* 备份恢复中：恢复会替换磁盘上的数据文件，但内存 store 仍是旧数据。
     期间必须同时禁掉「自动落盘」和「退出 flush」，否则任何一次写回都会把恢复结果盖掉。
     「备份管理」面板在调用 backupRestore 前派发 lingkuang-restore-start。 */
  let restoreInProgress = false;
  window.addEventListener('lingkuang-restore-start', () => { restoreInProgress = true; suppressWrite = true; });
  window.addEventListener('lingkuang-restore-end', () => { restoreInProgress = false; suppressWrite = false; });
  async function writeAll(): Promise<void> {
    const api = (window as any).lingkuangAPI;
    if (!api) return;
    pendingWrite = false;   /* 置前：期间再有改动，订阅会重新置 true 并重新排程 */
    /* ① 写 vault：遍历所有节点 → 各自 .md 文件 */
    if (api.vaultWrite) {
      for (const [wsName, ws] of Object.entries(store.data.worldsets)) {
        for (const tlId of (ws.order ?? [])) {
          const tl = ws.timelines[tlId];
          if (!tl) continue;
          for (const node of tl.nodes) {
            try { await api.vaultWrite(wsName, tl.name, node); } catch (e) { /* 单节点失败忽略 */ }
          }
        }
      }
    }
    /* ② 写 JSON 缓存（保留旧流程，作备份；formats 由独立 formats.json 管，不写进这里） */
    if (api.saveData) { const { formats: _fmt, ...rest } = store.data; api.saveData(rest); }
  }
  store.subscribe(() => {
    if (suppressWrite) return;
    pendingWrite = true;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { void writeAll(); }, 400);
  });
  /* 退出前落盘：先让当前工具把未提交的编辑交给 store（编辑器只在 tiptap blur 时提交，
     光标还在正文里就关窗口的话，那些字连 store 都没进），再同步写盘。 */
  window.addEventListener('beforeunload', () => {
    /* 备份恢复中：文件刚被换成备份内容，内存里还是旧数据。
       此时绝不能 flush——否则退出补写会用旧数据把恢复结果盖掉。 */
    if (restoreInProgress) return;
    try { disposeCurrentTool(); } catch (e) { /* 清理失败不挡退出 */ }
    if (!pendingWrite) return;
    window.clearTimeout(saveTimer);
    const api = (window as any).lingkuangAPI;
    if (!api?.flushSync) return;
    const nodes: { wsName: string; tlName: string; node: unknown }[] = [];
    for (const [wsName, ws] of Object.entries(store.data.worldsets)) {
      for (const tlId of (ws.order ?? [])) {
        const tl = ws.timelines[tlId];
        if (!tl) continue;
        for (const node of tl.nodes) nodes.push({ wsName, tlName: tl.name, node });
      }
    }
    const { formats: _fmt, ...rest } = store.data;
    try { api.flushSync({ data: rest, nodes }); pendingWrite = false; } catch (e) { /* 下一次启动还有 JSON 备份 */ }
  });
  /* 在落盘订阅注册后才补全，确保 store.update 能触发落盘写回 .md（type/precision/kind + 格式字段） */
  ensureAllFormatFields(store);
  const host = document.getElementById('app')!;
  renderShell(store, host);

  /* 同步刷新：监听外部 Obsidian 改 vault .md → 重新 scan → 替换 store（文件为源，不写回） */
  const api = (window as any).lingkuangAPI;
  if (api?.vaultWatch) api.vaultWatch().catch(() => {});
  if (api?.onVaultChanged) {
    api.onVaultChanged(async () => {
      try {
        /* vault 是源，但内存里还可能有没落盘的改动（自动落盘有 400ms 防抖，写一整个
           世界的 .md 也要时间）。直接拿磁盘快照整片替换会把它们抹掉——先把待写内容
           推进 vault 让源追上内存，再重载。 */
        for (let i = 0; i < 3 && pendingWrite; i++) await writeAll();
        if (pendingWrite) return; /* 仍在写（正在连续输入）→ 放弃这轮，下个变化事件再来 */
        const vres = await api.vaultScan();
        if (vres && vres.ok && vres.worlds) {
          /* 以当前 store 为 base：外部改 .md 只该覆盖节点，不能顺手清空循环/剧情线/历法 */
          const newData = vaultToWorldData(vres.worlds, store.data);
          /* 检测外部对节点字段的增删（属性/描述/正文），对比重载前的 store 与扫描结果 */
          const diffs = nodeFieldDiff(store.data, newData);
          suppressWrite = true;
          /* 从源同步不是用户编辑：不占撤销格。否则每次外部改动都会压进一个
             「看起来什么都没变」的整库快照，Ctrl+Z 就被这些空转快照吃掉了。 */
          try {
            store.update((d) => { d.worldsets = newData.worldsets; }, { undo: false });
          } finally {
            /* 必须 finally：store.update 先改数据、后通知，任何订阅者抛异常都会穿出来；
               漏掉这一句 suppressWrite 就永久卡在 true → 此后**整个会话不再自动落盘**（静默丢数据）。 */
            suppressWrite = false;
          }
          /* 自动修复可安全恢复的字段（描述/正文标签/属性被增删），其余仍提示 */
          const repairable = diffs.filter((d: any) => d.diffs.some((x: string) => x.includes('「#正文：」标签被删除') || x.includes('描述被删除') || x.startsWith('属性「') || x.includes('字段被删除')));
          const residual = diffs.filter((d: any) => !repairable.includes(d));
          const repaired = autoFixFieldDiffs(store, repairable);
          ensureAllFormatFields(store);
          if (repaired.length) window.dispatchEvent(new CustomEvent('lingkuang-vault-auto-fixed', { detail: repaired }));
          if (residual.length) window.dispatchEvent(new CustomEvent('lingkuang-vault-field-changed', { detail: residual }));
        }
      } catch (e) { /* ignore */ }
    });
  }

  /* 撤销/重做快捷键（避开输入框焦点） */
  window.addEventListener('keydown', (e) => {
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      store.redo();
    }
  });
}

main();
