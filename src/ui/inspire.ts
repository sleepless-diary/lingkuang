/** 灵感触发器——随机角色生成（词库 58 分类；照抄 legacy 生成/锁定/组数逻辑）+ 词义联想画布 */
import type { Store } from '../store/store';
import { cascadeIn, stopCascade } from './motion';

interface Group { t: string; keys: string[]; n: number; }
type Lib = Record<string, string[]>;
type Combo = Record<string, Record<string, string>>;

const CHAR_GROUPS: Group[] = [
  { t: '外貌', keys: ['发色', '发型', '瞳色', '肤色'], n: 4 },
  { t: '身体特征', keys: ['角', '瞳', '耳', '尾', '翅', '其他身体特征'], n: 4 },
  { t: '服装', keys: ['上衣', '下装', '连体衣', '套装'], n: 4 },
  { t: '穿戴', keys: ['鞋', '袜', '内衣', '腿饰', '眼镜'], n: 4 },
  { t: '饰品', keys: ['头饰', '颈饰', '臂饰', '腰饰', '手饰', '脚链', '肩饰', '面饰', '背部装饰', '发饰'], n: 4 },
  { t: '装备', keys: ['武器', '法器', '道具', '随身物', '特殊服装', '坐骑'], n: 4 },
  { t: '内在', keys: ['表层性格', '深层性格', '癖好'], n: 3 },
  { t: '身份', keys: ['气质', '职业', '种族', '身份地位', '名字含义'], n: 4 },
  { t: '背景', keys: ['背景经历', '秘密', '目标', '执念', '恐惧'], n: 4 },
  { t: '能力', keys: ['能力', '弱点'], n: 2 },
  { t: '关系/主题', keys: ['关系', '主题意象', '代表色'], n: 3 },
  { t: '格调', keys: ['服装', '食物', '气味', '体型', '萌属性'], n: 4 },
  { t: '意象触发', keys: ['声响', '抽象概念', '自然意象'], n: 3 },
];

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

/** 返回清理函数（联想画布的卸载函数），由 tools/register.ts 的 open 交回 registry：
 *  registry.openTool 在切走工具时调用它，摘掉画布的 window 监听 + 两个 requestAnimationFrame 循环。 */
export async function renderInspire(_store: Store, host: HTMLElement): Promise<void | (() => void)> {  let lib: Lib | null = null;
  let locks: Record<string, string> = {};
  const groupCounts: Record<number, string> = {};
  let activeCombo: Combo | null = null;

  try { locks = JSON.parse(localStorage.getItem('lingkuang-inspire-locks') || '{}'); } catch { locks = {}; }
  const saves: Combo[] = (() => { try { return JSON.parse(localStorage.getItem('lingkuang-inspire-saves') || '[]'); } catch { return []; } })();

  host.style.overflow = 'auto';   /* host = 本次打开的工具格（.lk-tool-slot），内容溢出让它自己滚 */
  host.innerHTML = `
    <div style="display:block;height:100%;" id="insp-scroll">
      <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border-soft);background:var(--surface-2);flex-wrap:wrap;position:sticky;top:0;z-index:2;">
        <span style="font-size:15px;font-weight:600;color:var(--fg);">灵感触发器</span>
        <span id="insp-status" style="font-size:var(--text-xs);color:var(--fg-2);">加载词库…</span>
        <span style="flex:1;"></span>
        <div id="insp-saves" style="display:flex;flex-wrap:wrap;gap:4px;"></div>
        <button id="insp-save" style="background:var(--surface);color:var(--fg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 12px;font-size:var(--text-sm);cursor:pointer;">保存组合</button>
        <button id="insp-roll" style="background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-sm);padding:6px 14px;font-size:var(--text-sm);cursor:pointer;">重新生成</button>
      </div>
      <div id="insp-result" class="lk-own-cascade" style="padding:14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;align-content:start;"></div>
      <div id="insp-assoc" style="height:100vh;border-top:1px solid var(--border-soft);display:flex;flex-direction:column;"></div>
    </div>`;

  const status = host.querySelector('#insp-status') as HTMLElement;
  const result = host.querySelector('#insp-result') as HTMLElement;
  const savesBox = host.querySelector('#insp-saves') as HTMLElement;

  function persistLocks() {
    localStorage.setItem('lingkuang-inspire-locks', JSON.stringify(locks));
  }
  function persistSaves() {
    localStorage.setItem('lingkuang-inspire-saves', JSON.stringify(saves));
  }
  function statusMsg(m: string) { status.textContent = m; }

  /* 抽一组：锁定 key 保留，其余洗牌补足 */
  function rollGroup(g: Group, count: number): Record<string, string> {
    const res: Record<string, string> = {};
    const locked = g.keys.filter((k) => locks[k] !== undefined);
    locked.forEach((k) => { res[k] = locks[k]; });
    const free = shuffle(g.keys.filter((k) => locks[k] === undefined && Array.isArray(lib![k]) && lib![k].length > 0));
    const need = Math.max(0, count - locked.length);
    free.slice(0, Math.min(need, free.length)).forEach((k) => {
      res[k] = lib![k][Math.floor(Math.random() * lib![k].length)];
    });
    return res;
  }
  function currentCount(g: Group, gi: number): number {
    const v = groupCounts[gi];
    if (v === undefined || v === 'rand') return 1 + Math.floor(Math.random() * Math.min(4, g.keys.length));
    const n = parseInt(v ?? '', 10);
    return isNaN(n) ? g.n : n;
  }
  function countOptions(g: Group, current?: string): string {
    const max = Math.min(4, g.keys.length);
    const cur = current || 'rand';
    let o = `<option value="rand"${cur === 'rand' ? ' selected' : ''}>随机</option>`;
    for (let i = 1; i <= max; i++) o += `<option value="${i}"${cur === String(i) ? ' selected' : ''}>${i}</option>`;
    return o;
  }

  /* animate：只有**初次进入**（工具打开、:237）才逐张错峰。
     用户 2026-09-12 二次要求：「重新生成改成无错分的，只有初次进入时才有错分」——
     点「重新生成」是在盯着卡片看，还要等 13 张排完队才看得全，反而碍事；
     加载已存组合同理（用户要的是立刻看到那一组长什么样）。 */
  function renderChar(combo: Combo | null, animate = false) {
    if (!lib) return;
    result.innerHTML = CHAR_GROUPS.map((g, gi) => {
      const picks = combo ? combo[g.t] || {} : rollGroup(g, currentCount(g, gi));
      const rows = Object.keys(picks).map((k) => {
        const locked = locks[k] !== undefined;
        return `<div class="insp-row${locked ? ' is-locked' : ''}" data-key="${k}" style="display:flex;align-items:center;gap:8px;margin:5px 0;font-size:var(--text-sm);line-height:1.5;${locked ? 'background:rgba(158,194,98,.12);border-radius:6px;padding:2px 4px;' : ''}">
          <span class="insp-key">${k}</span>
          <button class="insp-val" data-word="${picks[k]}" title="点击语义联想" style="flex:1;text-align:left;background:none;border:none;color:var(--fg);cursor:pointer;font-size:var(--text-sm);font-weight:500;">${picks[k]}</button>
          <button class="insp-lock" data-key="${k}" title="${locked ? '解锁' : '锁定：下次随机保留'}" style="background:none;border:none;color:${locked ? 'var(--accent)' : 'var(--fg-2)'};cursor:pointer;font-size:13px;">⚿</button>
        </div>`;
      }).join('');
      return `<div class="tool-card">
        <h3 style="display:flex;align-items:center;">${g.t}<select class="insp-count" data-g="${gi}" style="margin-left:auto;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md);color:var(--fg);font-size:10px;padding:1px 4px;">${countOptions(g, groupCounts[gi])}</select></h3>
        ${rows}</div>`;
    }).join('');
    bindEvents();
    /* 卡片自己这一层错峰（用户 2026-09-12：「卡片也是一样的，错分入场」）。
       卡片（= CHAR_GROUPS 的 13 组，各一张 .tool-card）在**块里面**，registry 那趟顶层错峰
       只到「标题栏 / 卡片区 / 联想画布」三块，盖不到卡片 ⇒ 得在这儿再挂一级。
       步长 50ms、封顶 720ms：13 张正好排成 120→720ms 的阶梯（不封顶的话后面几张会挤在一起同时冒出来）。
       #insp-result 带 .lk-own-cascade ⇒ 它自己**不整块淡入**（整块半透明会又把卡片错峰洗掉，
       就是用户报过的"闪一下 + 没错开"），由每张卡自己浮现。
       只由 animate 参数决定播不播：初次进入（:237）播；「重新生成」（:211）与加载组合（:203）
       不播 —— 那两种都是"我要立刻看新词"，排队只会碍事。
       不播时还要显式 `stopCascade`：错峰类要等最后一张动画结束才摘，打开后马上点「重新生成」的话
       它还挂在卡片区上，新卡片会从父类继承 nth-child 延迟又错峰一遍（"不该播的那次"照样播）。 */
    if (animate) cascadeIn(result, 50, 720, 120);
    else stopCascade(result);
  }

  /* ── 语义联想（Ollama，设置里配引擎）── */
  function bindEvents() {
    result.querySelectorAll('.insp-val').forEach((el) => {
      el.addEventListener('click', () => {
        const w = (el as HTMLElement).dataset.word!;
        /* 触发下方画布联想 */
        const canvas = host.querySelector('#insp-assoc') as HTMLElement | null;
        if (canvas && (canvas as any).assocSetRoot) (canvas as any).assocSetRoot(w);
      });
    });
    result.querySelectorAll('.insp-lock').forEach((el) => {
      el.addEventListener('click', () => {
        const k = (el as HTMLElement).dataset.key!;
        if (locks[k] !== undefined) delete locks[k];
        else {
          const row = (el as HTMLElement).closest('.insp-row');
          const val = row?.querySelector('.insp-val')?.textContent ?? '';
          locks[k] = val;
        }
        persistLocks();
        /* 只切换锁定状态，不刷新词条（避免重roll）——更新按钮颜色+行高亮 */
        const btn = el as HTMLElement;
        const isLocked = locks[k] !== undefined;
        btn.style.color = isLocked ? 'var(--accent)' : 'var(--fg-2)';
        btn.title = isLocked ? '解锁' : '锁定：下次随机保留';
        const row = (el as HTMLElement).closest('.insp-row') as HTMLElement;
        row.style.background = isLocked ? 'rgba(158,194,98,.12)' : '';
        row.style.borderRadius = isLocked ? '6px' : '';
        row.style.padding = isLocked ? '2px 4px' : '';
      });
    });
    result.querySelectorAll('.insp-count').forEach((el) => {
      el.addEventListener('change', () => {
        groupCounts[parseInt((el as HTMLElement).dataset.g!, 10)] = (el as HTMLSelectElement).value;
        /* 切换词条数：只记录数量设置，保留当前词条不刷新；点「重新生成」才按新数量随机 */
      });
    });
  }

  function collectCombo(): Combo {
    const combo: Combo = {};
    /* 选择器必须与 renderChar 里真正用的卡片类一致（.tool-card，见 src/style.css）。
       历史上这里写的是 .insp-card，全项目不存在该类 → 永远匹配 0 个卡片 → 存进去全是空组合。 */
    result.querySelectorAll('.tool-card').forEach((card, gi) => {
      const g = CHAR_GROUPS[gi];
      if (!g) return;
      const m: Record<string, string> = {};
      card.querySelectorAll('.insp-row').forEach((row) => {
        const k = (row as HTMLElement).dataset.key;
        if (k) m[k] = row.querySelector('.insp-val')?.textContent ?? '';
      });
      combo[g.t] = m;
    });
    return combo;
  }

  function renderSaves() {
    /* 「加载」与「删除」必须是两个独立控件。
       历史实现把两者塞进同一个按钮，再靠 textContent 是否含 ✕ 判断意图，
       而 chip 文案恒为「组合 N ✕」→ 点任何一次都走删除分支，加载分支永远不可达。 */
    savesBox.innerHTML = saves.length
      ? saves.map((_c, i) => `<span style="display:inline-flex;align-items:stretch;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;">
          <button data-si="${i}" title="加载组合 ${i + 1}" style="background:none;border:none;color:var(--fg);font-size:10px;padding:2px 7px;cursor:pointer;">组合 ${i + 1}</button>
          <button data-del="${i}" title="删除组合 ${i + 1}" style="background:none;border:none;border-left:1px solid var(--border);color:var(--fg-2);font-size:10px;padding:2px 6px;cursor:pointer;">✕</button>
        </span>`).join('')
      : '';
    savesBox.querySelectorAll('[data-del]').forEach((el) => {
      el.addEventListener('click', () => {
        saves.splice(parseInt((el as HTMLElement).dataset.del!, 10), 1);
        persistSaves();
        renderSaves();
        statusMsg('已删除组合');
      });
    });
    savesBox.querySelectorAll('[data-si]').forEach((el) => {
      el.addEventListener('click', () => {
        const si = parseInt((el as HTMLElement).dataset.si!, 10);
        if (!saves[si]) return;
        activeCombo = saves[si];
        renderChar(activeCombo);
        statusMsg(`已加载组合 ${si + 1}`);
      });
    });
  }

  host.querySelector('#insp-roll')?.addEventListener('click', () => {
    activeCombo = null;
    renderChar(null);
    statusMsg('已重新生成');
  });
  host.querySelector('#insp-save')?.addEventListener('click', () => {
    if (!lib) return;
    saves.push(collectCombo());
    persistSaves();
    renderSaves();
    statusMsg(`已保存组合 ${saves.length}`);
  });

  /* 加载词库 */
  const api = (window as any).lingkuangAPI;
  try {
    const res = api?.loadCharLib ? await api.loadCharLib() : null;
    if (res?.ok && res.data) lib = res.data;
  } catch { /* fallthrough */ }
  if (!lib) {
    try {
      const r = await fetch('data/character_lib.json');
      if (r.ok) lib = await r.json();
    } catch { /* fallthrough */ }
  }
  if (!lib) { statusMsg('词库加载失败'); return; }
  statusMsg(`${Object.keys(lib).length} 分类 · ${Object.values(lib).reduce((a, v) => a + v.length, 0)} 词条`);
  renderSaves();
  renderChar(null, true);   /* 初次进入：卡片逐张错峰 */
  /* 挂载联想画布（灵感生成卡片下方），并把它的清理函数往上传：
     mountAssocCanvas → 本函数 → register.ts 的 open 返回值 → registry.adopt。 */
  const canvasHost = host.querySelector('#insp-assoc') as HTMLElement | null;
  if (!canvasHost) return;
  const m = await import('./assoc');
  return m.mountAssocCanvas(canvasHost, () => '');
}
