/** 设置模块——AI 引擎（本地 Ollama / OpenAI 兼容 API）+ 偏好项；存 localStorage */
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import { probeModels, readCatalog, type ModelCatalog, type ProbeCfg } from './ai-models';

/** 演变（设定库的版本历史）的三种模式，用户 2026-09-13 选「都做，把模式放到设置里面」 */
export type EvolveMode = 'manual' | 'auto' | 'locked';

/** 助手「能动手到什么程度」= 两个**正交**旋钮（用户 2026-09-26：平常聊天、少数情况才让它动手）：
 *   · `AgentScope`：**范围** —— 只读 / 可写（借 DSH `permission` 预设里的 sandbox 那一维）
 *   · `AgentAsk`  ：**询问** —— 每次确认 / 直接执行（借 approval 那一维）
 *  两者组合出的三种实际行为，与片 2~4 那个单档 `readonly|confirm|yolo` 一一对应
 *  （见 `src/ui/agent-perm.ts`）；老的单档值在 `loadSettings()` 里一次性迁移过来。
 *  ⚠️ 它们只在 **Agent 模式**下有意义 —— 聊天模式根本不动手（见 `src/ui/agent-mode.ts`）。 */
export type AgentScope = 'readonly' | 'workspace';
export type AgentAsk = 'always' | 'never';

interface Settings {
  aiMode: 'ollama' | 'api';
  baseUrl: string;
  apiKey: string;
  model: string;
  glide: number;      // 平移惯性（0-1）
  sensitivity: number; // 平移敏感度
  rulerDensity: number; // 标尺密度
  evolveMode: EvolveMode;   // 改动什么时候变成"一版"（见设置面板里的说明）
  evolveLock: { world: string; tlId: string; nodeId: string } | null;   // 锁定模式锁在哪一格
  /* 换条目转场（用户 2026-09-13 在演示页 `docs/motion-demo/doc-slide.html` 里定稿的旋钮，
     落地后原样搬进设置面板）。默认值 = 演示页里那套：速度 1×、错峰 10ms、入场距离 32px。 */
  motionSwap: boolean;      // 开启转场（关掉 = 立刻换，不做任何动画）
  aiAutoName: boolean;      // 没选人设的 AI 会话自动提炼名字（默认关：要额外发一次模型请求）
  motionSpeed: number;      // 速度倍率（改的是时长：300ms ÷ 倍率）
  motionStagger: number;    // 行错峰 ms（一行比上一行晚多少）
  motionEnterDx: number;    // 入场距离 px（同时是出场距离，往左走同样的量）
  /* 助手能动手到什么程度（两个旋钮；闸门在 `src/ui/agent-perm.ts`，只在 Agent 模式下有意义）。
     范围：readonly = 一个字都不许改；workspace = 可以写这个世界的设定与事件。
     询问：always = 每次改动出一张提议卡片等你点「应用」；never = 直接执行。 */
  agentScope: AgentScope;
  agentAsk: AgentAsk;
}

const DEFAULTS: Settings = {
  aiMode: 'ollama',
  baseUrl: 'http://localhost:11434',
  apiKey: '',
  model: 'qwen2.5:7b',
  glide: 0.55,
  sensitivity: 1,
  rulerDensity: 1,
  evolveMode: 'manual',
  evolveLock: null,
  motionSwap: true,
  aiAutoName: false,
  motionSpeed: 1,
  motionStagger: 10,
  motionEnterDx: 32,
  /* 默认组合 = 可写 + 每次确认（＝原来的「逐项确认」档）：助手想改稿子得先给一张提议卡片、
     创作者点「应用」才落盘 —— 既不是什么都不让做（那样它没用），也不是一上来就全自动（风险太高）。 */
  agentScope: 'workspace',
  agentAsk: 'always',
};

/** 老的单档权限（片 2~4 的 `agentPerm`）→ 两个旋钮的迁移表。
 *  留在这里而不是 `agent-perm.ts`：迁移是**读设置**时的事，与闸门无关。 */
const OLD_PERM: Record<string, { scope: AgentScope; ask: AgentAsk }> = {
  readonly: { scope: 'readonly', ask: 'always' },
  confirm: { scope: 'workspace', ask: 'always' },
  yolo: { scope: 'workspace', ask: 'never' },
};

export function loadSettings(): Settings {
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(localStorage.getItem('lingkuang-settings') || '{}');
  } catch {
    stored = {};
  }
  const s = { ...DEFAULTS, ...stored } as Settings;
  /* 一次性迁移：老档位 → 两旋钮（只在创作者没显式设过新旋钮时才搬，且搬完把旧键删掉，
     免得 `lingkuang-settings` 里一直留着一个已经不认得的键）。 */
  if (typeof stored.agentPerm === 'string' && OLD_PERM[stored.agentPerm]) {
    const m = OLD_PERM[stored.agentPerm];
    if (stored.agentScope === undefined) s.agentScope = m.scope;
    if (stored.agentAsk === undefined) s.agentAsk = m.ask;
    delete (s as unknown as Record<string, unknown>).agentPerm;
  }
  /* 手改过 localStorage / 老版本写进怪值 ⇒ 回落到默认，别让闸门读到一个它不认识的档 */
  if (s.agentScope !== 'readonly' && s.agentScope !== 'workspace') s.agentScope = DEFAULTS.agentScope;
  if (s.agentAsk !== 'always' && s.agentAsk !== 'never') s.agentAsk = DEFAULTS.agentAsk;
  /* 默认用 qwen2.5:7b（content 正常输出）；qwen3:14b 内容全进 thinking 联想解析不了，回退 */
  if (s.model === 'qwen3:14b' || s.model === 'qwen2.5:14b') s.model = 'qwen2.5:7b';
  return s;
}
export function saveSettings(s: Settings) {
  localStorage.setItem('lingkuang-settings', JSON.stringify(s));
}

/** 把设置表单画进**给定的元素**里（用户 2026-09-13：「我希望设置面板是悬浮面板，而不是单开一个标签页」）。
 *  以前这个函数直接把宿主当整页接管（`host.style.overflow='auto'` + 写 innerHTML），
 *  现在宿主由 `src/ui/settings-panel.ts` 的悬浮层提供，它自己管尺寸与滚动。 */
export function renderSettingsInto(host: HTMLElement, store: Store): void {
  const s = loadSettings();
  /* 锁定模式下要选"锁在哪一格"：列出当前世界的时间线节点（按时间排） */
  const lockWorld = store.activeWorld || '';
  const lockNodes: { id: string; tlId: string; label: string }[] = [];
  const ws: any = currentWorld(store);
  for (const tlId of ws.order ?? []) {
    const tl = ws.timelines?.[tlId];
    for (const n of tl?.nodes ?? []) {
      lockNodes.push({ id: n.id, tlId, label: `${n.year ?? ''}${n.month ? '-' + String(n.month).padStart(2, '0') : ''} ${n.title ?? ''}`.trim() });
    }
  }
  const lockId = s.evolveLock && s.evolveLock.world === lockWorld ? s.evolveLock.nodeId : '';
  host.style.overflow = 'auto';
  host.innerHTML = `
    <div style="max-width:520px;margin:0 auto;padding:20px 16px;display:flex;flex-direction:column;gap:14px;">
      <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;display:flex;flex-direction:column;gap:8px;">
        <div style="font-size:var(--text-sm);font-weight:600;color:var(--fg);">联想引擎</div>
        <div style="display:flex;gap:8px;">
          <label style="font-size:var(--text-xs);color:var(--fg-2);display:flex;align-items:center;gap:4px;"><input type="radio" name="aiMode" value="ollama"${s.aiMode === 'ollama' ? ' checked' : ''}/>本地 Ollama（免费 · 需自部署）</label>
          <label style="font-size:var(--text-xs);color:var(--fg-2);display:flex;align-items:center;gap:4px;"><input type="radio" name="aiMode" value="api"${s.aiMode === 'api' ? ' checked' : ''}/>OpenAI 兼容 API（按量付费）</label>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          <label style="font-size:var(--text-xs);color:var(--fg-2);">Base URL</label>
          <input id="set-baseurl" type="text" value="${s.baseUrl}" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:5px 8px;font-size:var(--text-sm);outline:none;"/>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          <label style="font-size:var(--text-xs);color:var(--fg-2);">API Key（本地模式可留空）</label>
          <input id="set-apikey" type="password" value="${s.apiKey}" placeholder="sk-..." style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:5px 8px;font-size:var(--text-sm);outline:none;"/>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <div style="display:flex;align-items:center;gap:6px;">
            <label style="font-size:var(--text-xs);color:var(--fg-2);">模型</label>
            <span id="set-model-hint" style="font-size:11px;color:var(--fg-2);margin-left:auto;text-align:right;"></span>
          </div>
          <div style="display:flex;gap:6px;">
            <button id="set-model-btn" type="button" title="点开：列出端点提供的模型" style="flex:1;min-width:0;display:flex;align-items:center;gap:6px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:5px 8px;font-size:var(--text-sm);cursor:pointer;text-align:left;">
              <span id="set-model-cur" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${s.model || '（还没选模型）'}</span>
              <span style="color:var(--fg-2);font-size:10px;flex-shrink:0;">▾</span>
            </button>
            <button id="set-model-refresh" type="button" title="问端点要一份最新清单" style="flex-shrink:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg-2);padding:5px 10px;font-size:var(--text-xs);cursor:pointer;">刷新</button>
          </div>
          <div id="set-model-menu" style="display:none;flex-direction:column;gap:6px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface-2);padding:8px;">
            <input id="set-model-search" type="text" placeholder="搜索模型名…" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 8px;font-size:var(--text-sm);outline:none;"/>
            <div id="set-model-list" style="display:flex;flex-direction:column;gap:2px;max-height:210px;overflow:auto;"></div>
            <div style="display:flex;gap:6px;">
              <input id="set-model-manual" type="text" placeholder="或直接手填模型名" style="flex:1;min-width:0;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 8px;font-size:var(--text-sm);outline:none;"/>
              <button id="set-model-manual-ok" type="button" style="flex-shrink:0;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg-2);padding:4px 10px;font-size:var(--text-xs);cursor:pointer;">用这个</button>
            </div>
          </div>
        </div>
      </div>
      <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;display:flex;flex-direction:column;gap:10px;">
        <div style="font-size:var(--text-sm);font-weight:600;color:var(--fg);">画布偏好</div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:var(--text-xs);color:var(--fg-2);width:90px;">平移惯性</span>
          <input id="set-glide" type="range" min="0" max="1" step="0.05" value="${s.glide}" style="flex:1;"/>
          <span id="set-glide-v" style="font-size:var(--text-xs);color:var(--fg-2);width:30px;text-align:right;">${s.glide}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:var(--text-xs);color:var(--fg-2);width:90px;">平移敏感度</span>
          <input id="set-sens" type="range" min="0.2" max="3" step="0.1" value="${s.sensitivity}" style="flex:1;"/>
          <span id="set-sens-v" style="font-size:var(--text-xs);color:var(--fg-2);width:30px;text-align:right;">${s.sensitivity}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:var(--text-xs);color:var(--fg-2);width:90px;">标尺密度</span>
          <input id="set-ruler" type="range" min="0.5" max="2" step="0.1" value="${s.rulerDensity}" style="flex:1;"/>
          <span id="set-ruler-v" style="font-size:var(--text-xs);color:var(--fg-2);width:30px;text-align:right;">${s.rulerDensity}</span>
        </div>
      </div>
      <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;display:flex;flex-direction:column;gap:10px;">
        <div style="font-size:var(--text-sm);font-weight:600;color:var(--fg);">换条目转场</div>
        <div style="font-size:var(--text-xs);color:var(--fg-2);">在设定库里点另一条条目时，旧内容先往左退场，新内容再从右淡入；<b>一行比一行晚一点</b>。改完立刻生效（点一下条目就能看出区别）。</div>
        <label style="font-size:var(--text-xs);color:var(--fg-2);display:flex;align-items:center;gap:6px;"><input type="checkbox" id="set-motion-on"${s.motionSwap ? ' checked' : ''}/>开启转场（关掉＝立刻换，不做任何动画）</label>
        <label style="font-size:var(--text-xs);color:var(--fg-2);display:flex;align-items:center;gap:6px;"><input type="checkbox" id="set-ai-autoname"${s.aiAutoName ? ' checked' : ''}/>AI 会话自动起名（没选人设时，聊几轮后按内容提炼一个短名字）</label>
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:var(--text-xs);color:var(--fg-2);width:90px;">速度</span>
          <input id="set-motion-speed" type="range" min="0.3" max="1.6" step="0.1" value="${s.motionSpeed}" style="flex:1;"/>
          <span id="set-motion-speed-v" style="font-size:var(--text-xs);color:var(--fg-2);width:38px;text-align:right;">${s.motionSpeed}×</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:var(--text-xs);color:var(--fg-2);width:90px;">行与行错峰</span>
          <input id="set-motion-stagger" type="range" min="0" max="60" step="1" value="${s.motionStagger}" style="flex:1;"/>
          <span id="set-motion-stagger-v" style="font-size:var(--text-xs);color:var(--fg-2);width:38px;text-align:right;">${s.motionStagger}ms</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:var(--text-xs);color:var(--fg-2);width:90px;">入场距离</span>
          <input id="set-motion-dx" type="range" min="0" max="80" step="1" value="${s.motionEnterDx}" style="flex:1;"/>
          <span id="set-motion-dx-v" style="font-size:var(--text-xs);color:var(--fg-2);width:38px;text-align:right;">${s.motionEnterDx}px</span>
        </div>
      </div>
      <div style="font-size:var(--text-xs);color:var(--fg-2);">⚠️ 灵框本体免费开源。AI 联想为可选能力——本地部署（自付电费）或第三方 API（费用由提供商收取），均与灵框无关。</div>
      <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;display:flex;flex-direction:column;gap:8px;">
        <div style="font-size:var(--text-sm);font-weight:600;color:var(--fg);">设定演变（版本历史）</div>
        <div style="font-size:var(--text-xs);color:var(--fg-2);">设定库右侧那条竖线叫「演变」：每一格是时间线上的一个事件节点。同一格可以在不同事件上长成不同的样子，这里决定<b>改动什么时候变成"一版"</b>。改完立刻生效。</div>
        <label style="font-size:var(--text-xs);color:var(--fg-2);display:flex;align-items:flex-start;gap:6px;"><input type="radio" name="evolveMode" value="manual"${s.evolveMode === 'manual' ? ' checked' : ''}/><span><b>手动</b>（默认）：只有点「＋ 在这一格记一帧」才会留一版；平时改动改的是<b>你现在看的这一版</b>，不随手产生历史。</span></label>
        <label style="font-size:var(--text-xs);color:var(--fg-2);display:flex;align-items:flex-start;gap:6px;"><input type="radio" name="evolveMode" value="auto"${s.evolveMode === 'auto' ? ' checked' : ''}/><span><b>自动</b>：改动直接落在你选中的那一格上；这一格还没有版本就自动开一个 —— 事件之间自然长出差异。</span></label>
        <label style="font-size:var(--text-xs);color:var(--fg-2);display:flex;align-items:flex-start;gap:6px;"><input type="radio" name="evolveMode" value="locked"${s.evolveMode === 'locked' ? ' checked' : ''}/><span><b>锁定</b>：改动永远记到下面选定的那一格上（右侧竖线也钉在它上面），适合"往后所有变化都算在这个事件之后"。</span></label>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:var(--text-xs);color:var(--fg-2);width:90px;">锁定在哪一格</span>
          <select id="set-evolve-lock" style="flex:1;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 6px;font-size:var(--text-xs);outline:none;">
            <option value="">（未选）</option>
            ${lockNodes.map((n) => `<option value="${n.id}"${n.id === lockId ? ' selected' : ''}>${n.label}</option>`).join('')}
          </select>
        </div>
        <div style="font-size:var(--text-xs);color:var(--fg-2);">「${lockWorld || '（未选世界）'}」有 ${lockNodes.length} 个事件节点可选。</div>
      </div>
      <button id="set-save" style="background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-sm);padding:8px;font-size:var(--text-sm);cursor:pointer;">保存设置</button>
      <div id="set-msg" style="font-size:var(--text-xs);color:var(--accent);"></div>
    </div>`;

  const msg = host.querySelector('#set-msg') as HTMLElement;
  const bind = (id: string, fn: (v: string) => void) => {
    const el = host.querySelector(id) as HTMLInputElement;
    el.addEventListener('input', () => fn(el.value));
    el.addEventListener('change', () => fn(el.value));
    return el;
  };
  /* ── 模型选择（用户 2026-09-26：「设置里面的 ai 选择能不能改成像 dsh 里面的模型选择一样」）──
     原来是个手打模型名的文本框：写错了要到发请求那一刻才知道。现在点开是**从端点问来的清单**
     （Ollama `/api/tags` / OpenAI 兼容 `/models`，见 `src/ui/ai-models.ts`），可搜索、可刷新；
     端点连不上就把原因写在旁边，下面那行手填照旧能用 —— 借 DSH `ModelListEditor` 的分寸：
     探测只产候选，用哪个由人点下去，绝不背着他改配置。 */
  const mBtn = host.querySelector('#set-model-btn') as HTMLButtonElement | null;
  const mCur = host.querySelector('#set-model-cur') as HTMLElement | null;
  const mMenu = host.querySelector('#set-model-menu') as HTMLElement | null;
  const mList = host.querySelector('#set-model-list') as HTMLElement | null;
  const mSearch = host.querySelector('#set-model-search') as HTMLInputElement | null;
  const mHint = host.querySelector('#set-model-hint') as HTMLElement | null;
  const mRefresh = host.querySelector('#set-model-refresh') as HTMLButtonElement | null;
  const mManual = host.querySelector('#set-model-manual') as HTMLInputElement | null;
  const mManualOk = host.querySelector('#set-model-manual-ok') as HTMLButtonElement | null;
  const probeCfg = (): ProbeCfg => ({ aiMode: s.aiMode, baseUrl: s.baseUrl, apiKey: s.apiKey });
  /* 打开面板先用缓存那份（端点没开也看得见上次拉到的），只有「刷新」成功才覆盖它 */
  let catalog: ModelCatalog | null = readCatalog(probeCfg());
  let probing = false;
  const hhmm = (t: number): string => {
    const d = new Date(t);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  function markModelStale(): void {
    if (mHint) mHint.textContent = '端点改了 —— 点「刷新」重新问一次';
  }
  function showMenu(open: boolean): void {
    if (!mMenu) return;
    mMenu.style.display = open ? 'flex' : 'none';
    mBtn?.classList.toggle('is-open', open);
  }
  function paintModelList(): void {
    if (!mList) return;
    const q = (mSearch?.value || '').trim().toLowerCase();
    const rows: { id: string; meta: string; cur: boolean }[] = [];
    /* 当前值永远在单子上（哪怕端点这次没报它：清单是缓存的、或手填过一个端点没有的名字） */
    if (s.model) rows.push({ id: s.model, meta: '当前在用', cur: true });
    for (const m of catalog?.models ?? []) if (!rows.some((r) => r.id === m.id)) rows.push({ id: m.id, meta: m.meta, cur: false });
    const shown = rows.filter((r) => !q || r.id.toLowerCase().includes(q));
    mList.textContent = '';
    if (!shown.length) {
      const empty = document.createElement('div');
      empty.textContent = q ? '没有匹配的模型' : '清单还是空的 —— 点「刷新」问一次端点';
      empty.style.cssText = 'font-size:var(--text-xs);color:var(--fg-2);padding:2px 0;';
      mList.appendChild(empty);
      return;
    }
    for (const r of shown) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'lk-set-model-row' + (r.cur ? ' is-cur' : '');
      row.dataset.model = r.id;
      row.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;background:transparent;border:1px solid '
        + (r.cur ? 'var(--accent)' : 'transparent') + ';border-radius:var(--radius-sm);padding:4px 6px;color:var(--fg);font-size:var(--text-xs);cursor:pointer;text-align:left;';
      const name = document.createElement('span');
      name.textContent = r.id;
      name.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' + (r.cur ? 'font-weight:600;' : '');
      const meta = document.createElement('span');
      meta.textContent = r.meta;
      meta.style.cssText = 'flex-shrink:0;color:var(--fg-2);font-size:11px;';
      row.append(name, meta);
      row.addEventListener('click', () => pickModel(r.id));
      mList.appendChild(row);
    }
  }
  function pickModel(name: string): void {
    s.model = name;
    if (mCur) mCur.textContent = name;
    showMenu(false);
    if (mHint) mHint.textContent = '已选 ' + name + '（点「保存设置」落盘）';
    paintModelList();
  }
  async function probeModelList(): Promise<void> {
    if (probing) return;
    probing = true;
    if (mHint) mHint.textContent = '正在问端点要清单…';
    if (mRefresh) mRefresh.disabled = true;
    const res = await probeModels(probeCfg());
    probing = false;
    if (mRefresh) mRefresh.disabled = false;
    if (res.ok && res.catalog) {
      catalog = res.catalog;
      if (mHint) mHint.textContent = res.catalog.models.length + ' 个模型 · ' + hhmm(res.catalog.at) + ' 拉的';
    } else if (mHint) {
      mHint.textContent = '拉取失败：' + res.error + '（下面那行可以手填）';
    }
    paintModelList();
  }
  mBtn?.addEventListener('click', () => {
    const open = mMenu?.style.display !== 'flex';
    showMenu(open);
    if (!open) return;
    paintModelList();
    /* 第一次打开、手上还没有清单 ⇒ 直接问一次（缓存里有就不打扰端点） */
    if (!catalog || !catalog.models.length) void probeModelList();
  });
  mRefresh?.addEventListener('click', () => void probeModelList());
  mSearch?.addEventListener('input', () => paintModelList());
  mManualOk?.addEventListener('click', () => { const v = (mManual?.value || '').trim(); if (v) pickModel(v); });
  mManual?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const v = (mManual?.value || '').trim();
    if (v) pickModel(v);
  });
  if (mHint) {
    mHint.textContent = catalog
      ? catalog.models.length + ' 个模型 · ' + hhmm(catalog.at) + ' 拉的'
      : '点开可列出端点提供的模型';
  }
  paintModelList();
  bind('#set-baseurl', (v) => { s.baseUrl = v; markModelStale(); });
  bind('#set-apikey', (v) => { s.apiKey = v; markModelStale(); });
  bind('#set-glide', (v) => { s.glide = parseFloat(v); (host.querySelector('#set-glide-v') as HTMLElement).textContent = v; });
  bind('#set-sens', (v) => { s.sensitivity = parseFloat(v); (host.querySelector('#set-sens-v') as HTMLElement).textContent = v; });
  bind('#set-ruler', (v) => { s.rulerDensity = parseFloat(v); (host.querySelector('#set-ruler-v') as HTMLElement).textContent = v; });
  host.querySelectorAll('input[name="aiMode"]').forEach((el) => {
    (el as HTMLInputElement).addEventListener('change', () => {
      s.aiMode = (el as HTMLInputElement).value as Settings['aiMode'];
      markModelStale();
    });
  });
  /* 演变模式与锁定点：**立刻存盘并广播**（不用等"保存设置"）——
     设定库的右栏要在用户切回去时就已经是新规则了。 */
  const saveNow = (msgText: string) => {
    saveSettings(s);
    window.dispatchEvent(new CustomEvent('lingkuang-settings'));
    msg.textContent = msgText;
    setTimeout(() => (msg.textContent = ''), 1500);
  };
  host.querySelectorAll('input[name="evolveMode"]').forEach((el) => {
    (el as HTMLInputElement).addEventListener('change', () => {
      s.evolveMode = (el as HTMLInputElement).value as EvolveMode;
      /* 选锁定却没选过格子 → 自动落到第一个事件上，免得"锁了个空" */
      if (s.evolveMode === 'locked' && !lockId && lockNodes.length) {
        s.evolveLock = { world: lockWorld, tlId: lockNodes[0].tlId, nodeId: lockNodes[0].id };
        const sel = host.querySelector('#set-evolve-lock') as HTMLSelectElement | null;
        if (sel) sel.value = lockNodes[0].id;   /* 面板上的下拉当场显示出来 */
      }
      saveNow('已保存 ✓');
    });
  });
  /* 换条目转场：四个旋钮都**立刻存盘并广播**，用户在设定库里接着点条目就能看出区别 */
  const onEl = host.querySelector('#set-motion-on') as HTMLInputElement | null;
  onEl?.addEventListener('change', () => { s.motionSwap = onEl.checked; saveNow('已保存 ✓'); });
  /* AI 会话自动起名（默认关） */
  const aiNameEl = document.getElementById('set-ai-autoname') as HTMLInputElement | null;
  aiNameEl?.addEventListener('change', () => { s.aiAutoName = aiNameEl.checked; saveNow('已保存 ✓'); });
  bind('#set-motion-speed', (v) => {
    s.motionSpeed = parseFloat(v);
    (host.querySelector('#set-motion-speed-v') as HTMLElement).textContent = v + '×';
    saveNow('已保存 ✓');
  });
  bind('#set-motion-stagger', (v) => {
    s.motionStagger = parseFloat(v);
    (host.querySelector('#set-motion-stagger-v') as HTMLElement).textContent = v + 'ms';
    saveNow('已保存 ✓');
  });
  bind('#set-motion-dx', (v) => {
    s.motionEnterDx = parseFloat(v);
    (host.querySelector('#set-motion-dx-v') as HTMLElement).textContent = v + 'px';
    saveNow('已保存 ✓');
  });
  host.querySelector('#set-evolve-lock')?.addEventListener('change', (ev) => {
    const id = (ev.target as HTMLSelectElement).value;
    const hit = lockNodes.find((n) => n.id === id);
    s.evolveLock = hit ? { world: lockWorld, tlId: hit.tlId, nodeId: hit.id } : null;
    saveNow(hit ? '已锁定到这一格 ✓' : '已取消锁定 ✓');
  });
  host.querySelector('#set-save')?.addEventListener('click', () => {
    saveSettings(s);
    msg.textContent = '已保存 ✓';
    setTimeout(() => (msg.textContent = ''), 1500);
  });
}
