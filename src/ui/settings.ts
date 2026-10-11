/** 设置模块 —— **分页**（模型 / 画布 / 转场 / 演变）+ AI **供应商档案**；存 localStorage `lingkuang-settings`。
 *
 *  用户 2026-09-26：「做成可选供应商和自定义供应商的版本吧，再把设置分页做一下，就像 dsh
 *  （我比较熟悉这种模式）」⇒ 这一版两件事一起做：
 *   · **供应商**：原来只有一句 `aiMode: 'ollama' | 'api'` + 三个平铺字段（baseUrl/apiKey/model），
 *     换一家得手打一遍端点、还得把 Key 清掉。现在档案在 `src/ui/ai-providers.ts` 里，可以有好几家、
 *     预设一键加、自定义自己填；「当前在用」的那家决定所有 AI 功能往哪儿发请求。
 *   · **分页**：借 DSH 设置那套「左侧导航 + 右侧分区」。四页的 DOM **一开始就都在**，只切显隐 ——
 *     与工作台左树「两组都在骨架里只切显隐，否则换类别时下面整体跳 7px」同一条纪律；
 *     ⚠️ 顺带保住 `tools/e2e/settings-panel.cjs` ★3（四张卡片标题同屏都在）。
 *
 *  ⚠️ 存盘时机两种，别弄混：
 *   · **立刻存盘并广播**（`saveNow`）—— 转场、演变：设定库 / 动效层马上要用新规则；
 *   · **底部「保存设置」**（草稿）—— 供应商档案、画布偏好：与以往 AI 那一栏的行为一致。 */
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import { uid } from '../store/ids';
import { probeModels, readCatalog, recommendModel, type ModelCatalog, type ProbeCfg } from './ai-models';
import {
  KIND_LABEL,
  PRESETS,
  activeOf,
  customProvider,
  defaultProviders,
  presetOf,
  probeCfgOf,
  providerFromPreset,
  sanitizeProvider,
  type ProviderProfile,
} from './ai-providers';
/* 助手的模式（自动 / 一轮）也存在这儿 —— 只取类型与默认值，不 import `agent.ts`（那会成环） */
import { AGENT_STEPS_FREE, DEFAULT_MODE, type AgentMode } from './agent-mode';

/** 演变（设定库的版本历史）的三种模式，用户 2026-09-13 选「都做，把模式放到设置里面」 */
export type EvolveMode = 'manual' | 'auto' | 'locked';

/** 助手「能动手到什么程度」= 两个**正交**旋钮（用户 2026-09-26：平常聊天、少数情况才让它动手）：
 *   · `AgentScope`：**范围** —— 只读 / 可写（借 DSH `permission` 预设里的 sandbox 那一维）
 *   · `AgentAsk`  ：**询问** —— 每次确认 / 直接执行（借 approval 那一维）
 *  两者组合出的三种实际行为，与片 2~4 那个单档 `readonly|confirm|yolo` 一一对应
 *  （见 `src/ui/agent-perm.ts`）；老的单档值在 `loadSettings()` 里一次性迁移过来。
 *  ⚠️ 两个档（「自动」/「一轮」）**都动手** —— 权限管"允许它做到哪一步"，模式管"这次要多自主"
 *  （见 `src/ui/agent-mode.ts` 与 `src/ui/agent-perm.ts` 顶部）。 */
export type AgentScope = 'readonly' | 'workspace';
export type AgentAsk = 'always' | 'never';

interface Settings {
  /* AI 供应商档案（见 `src/ui/ai-providers.ts`）+ 当前在用哪一份 */
  providers: ProviderProfile[];
  activeProvider: string;
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
  /* 助手能动手到什么程度（两个旋钮；闸门在 `src/ui/agent-perm.ts`，对两个档都有效）。
     范围：readonly = 一个字都不许改；workspace = 可以写这个世界的设定与事件。
     询问：always = 每次改动出一张提议卡片等你点「应用」；never = 直接执行。 */
  agentScope: AgentScope;
  agentAsk: AgentAsk;
  /* 助手的**自主程度**（2026-10-11 起落盘，用户选「记着」）：'agent' = 自动档（默认，需要时连着走多步）
     / 'chat' = 一轮档（一次只做一个动作）。见 `src/ui/agent-mode.ts` 顶部。 */
  agentMode: AgentMode;
  /* 一次提问最多放它连着走几步（2026-10-11，用户：「**不能设置无上限吗**」）：
     0 = **不限**（默认）—— 由它自己决定什么时候做完，不再逼创作者每 8 步打一次「继续」。
     运行时值住 `src/ui/agent-mode.ts`（面板上的 select 改它），这里只负责**落盘**。 */
  agentSteps: number;
}

const DEFAULTS: Settings = {
  providers: defaultProviders(),   /* 出厂 = 本地 Ollama 一条（灵框开箱即用的那条路） */
  activeProvider: 'ollama',
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
  /* 默认档 = **自动**（2026-10-11）：用户「使用工具时能不能直接切换到 agent 模式」⇒ 不必先猜档位，
     该用工具就用工具、需要时连着走多步；"一轮"是他明确的克制选择，选了会被记住。 */
  agentMode: DEFAULT_MODE,
  /* 默认**不限步数**（用户 2026-10-11 原话：「不能设置无上限吗」）—— 0 = 不限，
     兜底天花板在 `agent-mode.ts` 的 `AGENT_STEPS_HARD`（防它绕圈，正常碰不到）。 */
  agentSteps: AGENT_STEPS_FREE,
};

/** 老的单档权限（片 2~4 的 `agentPerm`）→ 两个旋钮的迁移表。
 *  留在这里而不是 `agent-perm.ts`：迁移是**读设置**时的事，与闸门无关。 */
const OLD_PERM: Record<string, { scope: AgentScope; ask: AgentAsk }> = {
  readonly: { scope: 'readonly', ask: 'always' },
  confirm: { scope: 'workspace', ask: 'always' },
  yolo: { scope: 'workspace', ask: 'never' },
};

/* `qwen3:14b` / `qwen2.5:14b` 的正文全进了 thinking（联想解析不了、RP 也读不出话），
   老版本把它们当默认写进过设置 ⇒ 读到时回落到 content 正常的 `qwen2.5:7b`。 */
function normalizeModel(m: string): string {
  const v = m.trim();
  if (v === 'qwen3:14b' || v === 'qwen2.5:14b') return 'qwen2.5:7b';
  return v;
}

/** 老版本（一句 `aiMode` + 三个平铺字段）→ **一条**供应商档案。
 *  ⚠️ 只折出他当时在用的那一条，不顺手塞四家没配 Key 的预设 —— 想要别的去「添加供应商」加。
 *  落盘里已经有 `providers`（哪怕只有一条）时就以它为准。 */
function migrateProviders(stored: Record<string, unknown>): { providers: ProviderProfile[]; activeProvider: string } {
  const rawList = Array.isArray(stored.providers) ? (stored.providers as unknown[]) : [];
  const list = rawList.map(sanitizeProvider).filter((p): p is ProviderProfile => !!p);
  if (list.length) {
    const active = typeof stored.activeProvider === 'string' && list.some((p) => p.id === stored.activeProvider)
      ? stored.activeProvider
      : list[0].id;
    return { providers: list, activeProvider: active };
  }
  const oldBase = typeof stored.baseUrl === 'string' ? stored.baseUrl.trim() : '';
  const oldKey = typeof stored.apiKey === 'string' ? stored.apiKey : '';
  const oldModel = normalizeModel(typeof stored.model === 'string' ? stored.model : '');
  if (stored.aiMode === 'api') {
    return {
      providers: [{ id: 'pv-custom', name: '自定义供应商', preset: 'custom', kind: 'openai', baseUrl: oldBase, apiKey: oldKey, model: oldModel }],
      activeProvider: 'pv-custom',
    };
  }
  const ollama = providerFromPreset('ollama');
  return {
    providers: [{ ...ollama, baseUrl: oldBase || ollama.baseUrl, model: oldModel || ollama.model }],
    activeProvider: ollama.id,
  };
}

export function loadSettings(): Settings {
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(localStorage.getItem('lingkuang-settings') || '{}');
  } catch {
    stored = {};
  }
  const s = { ...DEFAULTS, ...stored } as Settings;
  const mp = migrateProviders(stored);
  s.providers = mp.providers;
  s.activeProvider = mp.activeProvider;
  /* 老键搬完就删：`lingkuang-settings` 里不再留一具已经不认得的 aiMode/baseUrl/apiKey/model */
  const legacy = s as unknown as Record<string, unknown>;
  delete legacy.aiMode;
  delete legacy.baseUrl;
  delete legacy.apiKey;
  delete legacy.model;
  /* 一次性迁移：老档位 → 两旋钮（只在创作者没显式设过新旋钮时才搬，且搬完把旧键删掉，
     免得 `lingkuang-settings` 里一直留着一个已经不认得的键）。 */
  if (typeof stored.agentPerm === 'string' && OLD_PERM[stored.agentPerm]) {
    const m = OLD_PERM[stored.agentPerm];
    if (stored.agentScope === undefined) s.agentScope = m.scope;
    if (stored.agentAsk === undefined) s.agentAsk = m.ask;
    delete legacy.agentPerm;
  }
  /* 手改过 localStorage / 老版本写进怪值 ⇒ 回落到默认，别让闸门读到一个它不认识的档 */
  if (s.agentScope !== 'readonly' && s.agentScope !== 'workspace') s.agentScope = DEFAULTS.agentScope;
  if (s.agentAsk !== 'always' && s.agentAsk !== 'never') s.agentAsk = DEFAULTS.agentAsk;
  /* 模式同理（老版本没有这个键 ⇒ 拿到默认档「自动」；手改成怪值也回落） */
  if (s.agentMode !== 'chat' && s.agentMode !== 'agent') s.agentMode = DEFAULTS.agentMode;
  /* 步数（0 = 不限；负数 / NaN / 手改怪值一律回默认，`agent-mode.ts` 的 `setAgentSteps()` 里还会再兜一次） */
  const st = Math.floor(Number(s.agentSteps));
  s.agentSteps = Number.isFinite(st) && st > 0 ? st : AGENT_STEPS_FREE;
  return s;
}
export function saveSettings(s: Settings) {
  localStorage.setItem('lingkuang-settings', JSON.stringify(s));
}

/** 「当前在用」的供应商 —— 所有 AI 调用（`src/ui/ai.ts` / `assoc.ts` / 助手面板）都从这儿取配置。
 *  ⚠️ 定义在 `settings.ts` 而不是 `ai-providers.ts`：那边不许 import 这里（会成环）。 */
export function activeProviderProfile(): ProviderProfile | null {
  return activeOf(loadSettings());
}

/** 分页定义（顺序 = 左侧导航的顺序）。`id` 同时是 `data-page` 与 `#lk-set-page-<id>` 的后缀。 */
const PAGES: { id: string; label: string }[] = [
  { id: 'model', label: '模型' },
  { id: 'canvas', label: '画布' },
  { id: 'motion', label: '转场' },
  { id: 'evolve', label: '演变' },
];

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
  const input = 'background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:5px 8px;font-size:var(--text-sm);outline:none;width:100%;';
  const label = 'font-size:var(--text-xs);color:var(--fg-2);';
  const card = 'border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;display:flex;flex-direction:column;gap:8px;';
  host.style.overflow = 'hidden';
  host.style.height = '100%';
  host.innerHTML = `
    <div id="lk-set-shell" style="display:flex;height:100%;min-height:0;">
      <div id="lk-set-nav" style="width:112px;flex-shrink:0;border-right:1px solid var(--border);background:var(--surface-2);padding:10px 8px;display:flex;flex-direction:column;gap:2px;">
        ${PAGES.map((p, i) => `<button type="button" class="lk-set-nav-btn${i === 0 ? ' is-on' : ''}" data-page="${p.id}">${p.label}</button>`).join('')}
      </div>
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;">
        <div id="lk-set-pages" style="flex:1;min-height:0;overflow:auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px;">

          <!-- ① 模型：AI 供应商 + 当前这一家的模型 -->
          <section class="lk-set-page" id="lk-set-page-model" style="display:flex;flex-direction:column;gap:12px;">
            <div style="${card}">
              <div style="font-size:var(--text-sm);font-weight:600;color:var(--fg);">联想引擎</div>
              <div style="${label}">AI 功能往哪儿发请求，由「当前在用」的那一家决定；可以有好几家，随时切换。每家带自己的端点、Key 和模型。</div>
              <div id="set-prov-list" style="display:flex;flex-direction:column;gap:4px;"></div>
              <div style="display:flex;align-items:center;gap:8px;">
                <button id="set-prov-add" type="button" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 10px;font-size:var(--text-xs);cursor:pointer;">＋ 添加供应商 ▾</button>
                <span id="set-prov-add-hint" style="font-size:11px;color:var(--fg-2);"></span>
              </div>
              <div id="set-prov-add-menu" style="display:none;flex-direction:column;gap:2px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface-2);padding:6px;"></div>
            </div>

            <div style="${card}display:none;" id="set-prov-editor">
              <div style="display:flex;align-items:center;gap:8px;">
                <div id="set-prov-title" style="font-size:var(--text-sm);font-weight:600;color:var(--fg);">编辑供应商</div>
                <button id="set-prov-close" type="button" style="margin-left:auto;background:transparent;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg-2);padding:3px 8px;font-size:var(--text-xs);cursor:pointer;">收起</button>
              </div>
              <!-- 一行小字：这家要连哪儿（预设的端点已经填好，别让人再看见一个要填的框） -->
              <div id="set-prov-sum" style="${label}line-height:1.5;"></div>
              <div style="display:flex;flex-direction:column;gap:4px;">
                <label style="${label}" id="set-prov-keylab">API Key（本地 Ollama 可留空）</label>
                <input id="set-prov-apikey" type="password" placeholder="sk-..." autocomplete="off" style="${input}"/>
              </div>
              <div style="display:flex;flex-direction:column;gap:6px;">
                <div style="display:flex;align-items:center;gap:6px;">
                  <label style="${label}">模型</label>
                  <span id="set-model-hint" style="font-size:11px;color:var(--fg-2);margin-left:auto;text-align:right;"></span>
                </div>
                <div style="display:flex;gap:6px;">
                  <button id="set-model-btn" type="button" title="点开：列出端点提供的模型" style="flex:1;min-width:0;display:flex;align-items:center;gap:6px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:5px 8px;font-size:var(--text-sm);cursor:pointer;text-align:left;">
                    <span id="set-model-cur" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
                    <span style="color:var(--fg-2);font-size:10px;flex-shrink:0;">▾</span>
                  </button>
                  <button id="set-model-refresh" type="button" title="问端点要一份最新清单" style="flex-shrink:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg-2);padding:5px 10px;font-size:var(--text-xs);cursor:pointer;">刷新</button>
                </div>
                <div id="set-model-menu" style="display:none;flex-direction:column;gap:6px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface-2);padding:8px;">
                  <input id="set-model-search" type="text" placeholder="搜索模型名…" style="${input}"/>
                  <div id="set-model-list" style="display:flex;flex-direction:column;gap:2px;max-height:210px;overflow:auto;"></div>
                  <div style="display:flex;gap:6px;">
                    <input id="set-model-manual" type="text" placeholder="或直接手填模型名" style="flex:1;min-width:0;${input}"/>
                    <button id="set-model-manual-ok" type="button" style="flex-shrink:0;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg-2);padding:4px 10px;font-size:var(--text-xs);cursor:pointer;">用这个</button>
                  </div>
                </div>
              </div>
              <!-- 主按钮：一键 = 拿 Key 去问清单 → 自动挑模型 → 设为当前在用 → 立刻落盘
                   （用户 2026-09-28：「直接选供应商再填 key，尽量简化」—— 所以它**不等底部那次「保存设置」**） -->
              <div style="display:flex;gap:6px;align-items:center;">
                <button id="set-prov-save-add" type="button" style="background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-sm);padding:5px 12px;font-size:var(--text-xs);cursor:pointer;">保存并启用</button>
                <button id="set-prov-adv-toggle" type="button" style="background:transparent;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg-2);padding:4px 10px;font-size:var(--text-xs);cursor:pointer;">高级（名字 / 端点 / 协议）</button>
              </div>
              <!-- 高级：预设用不到的那几个字段（自定义供应商默认展开） -->
              <div id="set-prov-advbox" style="display:none;flex-direction:column;gap:8px;border-top:1px solid var(--border);padding-top:8px;">
                <div style="display:flex;flex-direction:column;gap:4px;">
                  <label style="${label}">名字</label>
                  <input id="set-prov-name" type="text" style="${input}"/>
                </div>
                <div style="display:flex;flex-direction:column;gap:4px;">
                  <label style="${label}">协议（决定请求怎么发、清单怎么问）</label>
                  <select id="set-prov-kind" style="${input}">
                    <option value="ollama">${KIND_LABEL.ollama}（/api/chat + /api/tags）</option>
                    <option value="openai">${KIND_LABEL.openai}（/chat/completions + /models）</option>
                  </select>
                </div>
                <div style="display:flex;flex-direction:column;gap:4px;">
                  <label style="${label}">Base URL</label>
                  <input id="set-prov-baseurl" type="text" placeholder="https://…/v1" style="${input}"/>
                </div>
              </div>
              <div style="display:flex;gap:6px;align-items:center;">
                <button id="set-prov-use" type="button" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 10px;font-size:var(--text-xs);cursor:pointer;">设为当前在用</button>
                <button id="set-prov-del" type="button" style="margin-left:auto;background:transparent;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg-2);padding:4px 10px;font-size:var(--text-xs);cursor:pointer;">删除这一家</button>
              </div>
            </div>

            <div style="font-size:var(--text-xs);color:var(--fg-2);">⚠️ 灵框本体免费开源。AI 联想为可选能力——本地部署（自付电费）或第三方 API（费用由提供商收取），均与灵框无关。</div>
          </section>

          <!-- ② 画布 -->
          <section class="lk-set-page" id="lk-set-page-canvas" style="display:none;flex-direction:column;gap:12px;">
            <div style="${card}">
              <div style="font-size:var(--text-sm);font-weight:600;color:var(--fg);">画布偏好</div>
              <div style="display:flex;align-items:center;gap:10px;">
                <span style="${label}width:90px;">平移惯性</span>
                <input id="set-glide" type="range" min="0" max="1" step="0.05" value="${s.glide}" style="flex:1;"/>
                <span id="set-glide-v" style="${label}width:30px;text-align:right;">${s.glide}</span>
              </div>
              <div style="display:flex;align-items:center;gap:10px;">
                <span style="${label}width:90px;">平移敏感度</span>
                <input id="set-sens" type="range" min="0.2" max="3" step="0.1" value="${s.sensitivity}" style="flex:1;"/>
                <span id="set-sens-v" style="${label}width:30px;text-align:right;">${s.sensitivity}</span>
              </div>
              <div style="display:flex;align-items:center;gap:10px;">
                <span style="${label}width:90px;">标尺密度</span>
                <input id="set-ruler" type="range" min="0.5" max="2" step="0.1" value="${s.rulerDensity}" style="flex:1;"/>
                <span id="set-ruler-v" style="${label}width:30px;text-align:right;">${s.rulerDensity}</span>
              </div>
            </div>
          </section>

          <!-- ③ 转场 -->
          <section class="lk-set-page" id="lk-set-page-motion" style="display:none;flex-direction:column;gap:12px;">
            <div style="${card}">
              <div style="font-size:var(--text-sm);font-weight:600;color:var(--fg);">换条目转场</div>
              <div style="${label}">在设定库里点另一条条目时，旧内容先往左退场，新内容再从右淡入；<b>一行比一行晚一点</b>。改完立刻生效（点一下条目就能看出区别）。</div>
              <label style="${label}display:flex;align-items:center;gap:6px;"><input type="checkbox" id="set-motion-on"${s.motionSwap ? ' checked' : ''}/>开启转场（关掉＝立刻换，不做任何动画）</label>
              <label style="${label}display:flex;align-items:center;gap:6px;"><input type="checkbox" id="set-ai-autoname"${s.aiAutoName ? ' checked' : ''}/>AI 会话自动起名（没选人设时，聊几轮后按内容提炼一个短名字）</label>
              <div style="display:flex;align-items:center;gap:10px;">
                <span style="${label}width:90px;">速度</span>
                <input id="set-motion-speed" type="range" min="0.3" max="1.6" step="0.1" value="${s.motionSpeed}" style="flex:1;"/>
                <span id="set-motion-speed-v" style="${label}width:38px;text-align:right;">${s.motionSpeed}×</span>
              </div>
              <div style="display:flex;align-items:center;gap:10px;">
                <span style="${label}width:90px;">行与行错峰</span>
                <input id="set-motion-stagger" type="range" min="0" max="60" step="1" value="${s.motionStagger}" style="flex:1;"/>
                <span id="set-motion-stagger-v" style="${label}width:38px;text-align:right;">${s.motionStagger}ms</span>
              </div>
              <div style="display:flex;align-items:center;gap:10px;">
                <span style="${label}width:90px;">入场距离</span>
                <input id="set-motion-dx" type="range" min="0" max="80" step="1" value="${s.motionEnterDx}" style="flex:1;"/>
                <span id="set-motion-dx-v" style="${label}width:38px;text-align:right;">${s.motionEnterDx}px</span>
              </div>
            </div>
          </section>

          <!-- ④ 演变 -->
          <section class="lk-set-page" id="lk-set-page-evolve" style="display:none;flex-direction:column;gap:12px;">
            <div style="${card}">
              <div style="font-size:var(--text-sm);font-weight:600;color:var(--fg);">设定演变（版本历史）</div>
              <div style="${label}">设定库右侧那条竖线叫「演变」：每一格是时间线上的一个事件节点。同一格可以在不同事件上长成不同的样子，这里决定<b>改动什么时候变成"一版"</b>。改完立刻生效。</div>
              <label style="${label}display:flex;align-items:flex-start;gap:6px;"><input type="radio" name="evolveMode" value="manual"${s.evolveMode === 'manual' ? ' checked' : ''}/><span><b>手动</b>（默认）：只有点「＋ 在这一格记一帧」才会留一版；平时改动改的是<b>你现在看的这一版</b>，不随手产生历史。</span></label>
              <label style="${label}display:flex;align-items:flex-start;gap:6px;"><input type="radio" name="evolveMode" value="auto"${s.evolveMode === 'auto' ? ' checked' : ''}/><span><b>自动</b>：改动直接落在你选中的那一格上；这一格还没有版本就自动开一个 —— 事件之间自然长出差异。</span></label>
              <label style="${label}display:flex;align-items:flex-start;gap:6px;"><input type="radio" name="evolveMode" value="locked"${s.evolveMode === 'locked' ? ' checked' : ''}/><span><b>锁定</b>：改动永远记到下面选定的那一格上（右侧竖线也钉在它上面），适合"往后所有变化都算在这个事件之后"。</span></label>
              <div style="display:flex;align-items:center;gap:8px;">
                <span style="${label}width:90px;">锁定在哪一格</span>
                <select id="set-evolve-lock" style="flex:1;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 6px;font-size:var(--text-xs);outline:none;">
                  <option value="">（未选）</option>
                  ${lockNodes.map((n) => `<option value="${n.id}"${n.id === lockId ? ' selected' : ''}>${n.label}</option>`).join('')}
                </select>
              </div>
              <div style="${label}">「${lockWorld || '（未选世界）'}」有 ${lockNodes.length} 个事件节点可选。</div>
            </div>
          </section>
        </div>

        <div style="flex-shrink:0;border-top:1px solid var(--border);padding:10px 16px;display:flex;align-items:center;gap:10px;">
          <button id="set-save" style="background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-sm);padding:7px 16px;font-size:var(--text-sm);cursor:pointer;">保存设置</button>
          <div id="set-msg" style="font-size:var(--text-xs);color:var(--accent);"></div>
        </div>
      </div>
    </div>`;

  const msg = host.querySelector('#set-msg') as HTMLElement;
  const bind = (id: string, fn: (v: string) => void) => {
    const el = host.querySelector(id) as HTMLInputElement;
    el.addEventListener('input', () => fn(el.value));
    el.addEventListener('change', () => fn(el.value));
    return el;
  };

  /* ── 分页（左侧导航）──
     四页的 DOM 一开始就都在，只切 `display`：不重建 ⇒ 切回来时草稿还在、滚动位置还在
     （与工作台左树"两组都在骨架里只切显隐"同一条纪律）。 */
  const navBtns = [...host.querySelectorAll('#lk-set-nav .lk-set-nav-btn')] as HTMLElement[];
  function showPage(id: string): void {
    for (const b of navBtns) b.classList.toggle('is-on', b.dataset.page === id);
    for (const p of PAGES) {
      const el = host.querySelector('#lk-set-page-' + p.id) as HTMLElement | null;
      if (el) el.style.display = p.id === id ? 'flex' : 'none';
    }
  }
  for (const b of navBtns) b.addEventListener('click', () => showPage(b.dataset.page || 'model'));
  showPage('model');

  /* ── 供应商档案（用户 2026-09-26：「做成可选供应商和自定义供应商的版本」）──────────────
     一行 = 一份档案：名字 / 协议 / 端点 / Key / 选中的模型；「当前在用」的那份决定所有 AI 请求。
     借 DSH `ProviderEditor` / `CustomProviderCard` 的分寸（① 预设只产候选 ② 自定义是"创建"
     ③ 失败点名是哪个字段）：这里预设只负责把 Base URL 填好，改什么都得你自己动手。 */
  const provList = host.querySelector('#set-prov-list') as HTMLElement;
  const addBtn = host.querySelector('#set-prov-add') as HTMLButtonElement | null;
  const addMenu = host.querySelector('#set-prov-add-menu') as HTMLElement | null;
  const addHint = host.querySelector('#set-prov-add-hint') as HTMLElement | null;
  const editor = host.querySelector('#set-prov-editor') as HTMLElement | null;
  const pTitle = host.querySelector('#set-prov-title') as HTMLElement | null;
  const pName = host.querySelector('#set-prov-name') as HTMLInputElement | null;
  const pKind = host.querySelector('#set-prov-kind') as HTMLSelectElement | null;
  const pBase = host.querySelector('#set-prov-baseurl') as HTMLInputElement | null;
  const pKey = host.querySelector('#set-prov-apikey') as HTMLInputElement | null;
  const pUse = host.querySelector('#set-prov-use') as HTMLButtonElement | null;
  const pDel = host.querySelector('#set-prov-del') as HTMLButtonElement | null;
  const pClose = host.querySelector('#set-prov-close') as HTMLButtonElement | null;
  const mBtn = host.querySelector('#set-model-btn') as HTMLButtonElement | null;
  const mCur = host.querySelector('#set-model-cur') as HTMLElement | null;
  const mMenu = host.querySelector('#set-model-menu') as HTMLElement | null;
  const mList = host.querySelector('#set-model-list') as HTMLElement | null;
  const mSearch = host.querySelector('#set-model-search') as HTMLInputElement | null;
  const mHint = host.querySelector('#set-model-hint') as HTMLElement | null;
  const mRefresh = host.querySelector('#set-model-refresh') as HTMLButtonElement | null;
  const mManual = host.querySelector('#set-model-manual') as HTMLInputElement | null;
  const mManualOk = host.querySelector('#set-model-manual-ok') as HTMLButtonElement | null;
  const pSum = host.querySelector('#set-prov-sum') as HTMLElement | null;
  const pKeyLab = host.querySelector('#set-prov-keylab') as HTMLElement | null;
  const pAdvBox = host.querySelector('#set-prov-advbox') as HTMLElement | null;
  const pAdvBtn = host.querySelector('#set-prov-adv-toggle') as HTMLButtonElement | null;
  const pSaveAdd = host.querySelector('#set-prov-save-add') as HTMLButtonElement | null;

  /** 正在编辑哪一家（null = 收起编辑卡） */
  let editing: string | null = null;
  /* 编辑卡现在有两种来路（用户 2026-09-28：「直接选供应商再填 key，尽量简化」）：
     · `create` = 刚从「＋ 添加供应商」里点了一家预设 ⇒ 只让人看见 **Key**（端点已填好、
       协议不用选），主按钮是「保存并启用」；名字/协议/端点折在「高级」里。
     · `edit`   = 点行上的「编辑」/ 自定义供应商 ⇒ 老样子，字段都在（自定义的那几个本来就是空的）。
     ⚠️ 两态**共用同一张卡的同一批 id**（`#set-prov-name/kind/baseurl/apikey/...`），只是折叠显隐：
     守卫（`tools/e2e/settings-model-picker.cjs` ★3/★9/★12/★14）按 `.value` 读，折叠不影响取值。 */
  let editorMode: 'create' | 'edit' = 'edit';
  let advOpen = false;
  let catalog: ModelCatalog | null = null;
  let probing = false;
  const byId = (id: string): ProviderProfile | undefined => s.providers.find((p) => p.id === id);
  const edited = (): ProviderProfile | undefined => (editing ? byId(editing) : undefined);
  const hhmm = (t: number): string => {
    const d = new Date(t);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  const dirty = (text = '改好了 —— 点「保存设置」生效'): void => { msg.textContent = text; };
  function el<K extends keyof HTMLElementTagNameMap>(tag: K, css: string, text?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    e.style.cssText = css;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const btnCss = 'background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg-2);padding:3px 8px;font-size:11px;cursor:pointer;';

  /* ── 本机模型模版（用户 2026-09-28：「**我本地的所有模型都做成模版放在设置里面**」）──
     目的（用户选定）＝「换本地模型太麻烦」：原来换 `qwen3:32b` ↔ `qwen2.5:7b` 要走
     「＋ 添加供应商 → 本地 Ollama → 打开编辑器 → 点模型 → 刷新探测 / 手填」一大圈。
     形态（用户选定 A）＝「＋ 添加供应商」菜单里**每个本机模型一条**：点一下就多一家
     「本地 Ollama · qwen3:32b」，模型已经选好 —— 之后切换就是点一行「使用」。
     清单来源＝问**本机 Ollama**（`probeModels` → GET `/api/tags`，见 `src/ui/ai-models.ts`）：
     先吃上次那份缓存（Ollama 没开也能选），打开菜单时再后台刷一次。 */
  let localCatalog: ModelCatalog | null = null;
  let localProbing = false;
  /** 「本机 Ollama」的端点：已经有 ollama 档案就用它的（有人把 Ollama 挂在别的端口），否则用预设那条 */
  function localCfg(): ProbeCfg {
    const p = s.providers.find((x) => x.preset === 'ollama' && x.kind === 'ollama');
    return { aiMode: 'ollama', baseUrl: (p?.baseUrl || presetOf('ollama').baseUrl || '').replace(/\/+$/, ''), apiKey: '' };
  }
  /** 本机这个模型是不是已经有主了（同一端点 + 同一模型名）—— 免得点两下加出两家一模一样的 */
  function localOwner(modelId: string): ProviderProfile | undefined {
    const base = localCfg().baseUrl;
    return s.providers.find((p) => p.kind === 'ollama' && (p.baseUrl || '').replace(/\/+$/, '') === base && p.model === modelId);
  }
  async function refreshLocalCatalog(): Promise<void> {
    if (localProbing) return;
    localProbing = true;
    const res = await probeModels(localCfg());
    localProbing = false;
    if (res.ok && res.catalog) localCatalog = res.catalog;
    if (addMenu && addMenu.style.display === 'flex') paintAddMenu();   /* 菜单还开着就换上新清单 */
  }

  /** 把供应商清单画出来（每次改动后重画 —— 行数是个位数，不值得做 diff）。 */
  function paintProviders(): void {
    if (!provList) return;
    provList.textContent = '';
    for (const p of s.providers) {
      const on = p.id === s.activeProvider;
      const row = el('div', 'display:flex;align-items:center;gap:8px;border:1px solid ' + (on ? 'var(--accent)' : 'var(--border)')
        + ';border-radius:var(--radius-sm);padding:6px 8px;background:' + (on ? 'var(--surface-2)' : 'transparent') + ';');
      row.dataset.prov = p.id;
      /* 圆点 = 「这家配好了没」：本地 Ollama 不需要 Key ⇒ 填实；别的按有没有存 Key */
      const ready = !!p.baseUrl && !!p.model && (p.kind === 'ollama' || !!p.apiKey);
      const dot = el('span', 'width:7px;height:7px;border-radius:50%;flex-shrink:0;background:' + (ready ? 'var(--accent)' : 'var(--border-strong)') + ';');
      dot.title = ready ? '这家配好了' : '这家还缺东西（端点 / Key / 模型）';
      const meta = el('div', 'flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;');
      const nm = el('div', 'font-size:var(--text-xs);color:var(--fg);' + (on ? 'font-weight:600;' : ''), p.name + (on ? '（当前在用）' : ''));
      const sub = el('div', 'font-size:11px;color:var(--fg-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
        (p.model || '还没选模型') + ' · ' + (p.baseUrl || '还没填端点') + ' · ' + KIND_LABEL[p.kind]);
      meta.append(nm, sub);
      const acts = el('div', 'display:flex;gap:4px;flex-shrink:0;');
      if (!on) {
        const use = el('button', btnCss, '使用');
        use.dataset.act = 'use';
        use.title = '把这一家设为当前在用';
        use.addEventListener('click', () => { s.activeProvider = p.id; paintProviders(); dirty(); });
        acts.appendChild(use);
      }
      const edit = el('button', btnCss, '编辑');
      edit.dataset.act = 'edit';
      edit.addEventListener('click', () => openEditor(p.id));
      acts.appendChild(edit);
      row.append(dot, meta, acts);
      provList.appendChild(row);
    }
  }

  /** 「添加供应商」菜单：**五家预设全列**（+ 永远在的自定义 + 下面那段本机模型）。
   *  ⚠️ 2026-09-28 改：以前只列"还没加过的"（DSH `CustomProviderCard` 的 `taken` 分寸：已经存在的路由
   *  不许被影子覆盖），结果**要给已经加过的那家换 Key 时，菜单里反而找不到它** —— 用户实测报的
   *  （「我没看到deepseek什么的诶」，可他清单里早就有一条 DeepSeek）。现在已有的那家**照样列**、
   *  小字写「已有 · 点一下去改 Key」，点它 = 开那家的编辑卡（**仍然不重复加**）：
   *  `taken` 那条分寸从"把已有的藏起来"改成"把已有的说出来、点它去改"。
   *  （本机模型那一堆模版是另一回事：同一个模型点两次也**不重复加**，见 `addLocalModel()`。） */
  function paintAddMenu(): void {
    if (!addMenu) return;
    addMenu.textContent = '';
    for (const p of PRESETS.filter((x) => x.id !== 'custom')) {
      /* 已经有主的那家：优先认"预设自己那条"（id === preset.id），其次认第一条同 preset 的
         （本机模型模版的档案 preset 也是 `ollama`，但它们各有各的 id —— 别因此把整段藏起来） */
      const have = s.providers.find((q) => q.id === p.id) ?? s.providers.find((q) => q.preset === p.id);
      const row = el('button', 'display:flex;flex-direction:column;gap:1px;align-items:flex-start;background:transparent;border:1px solid transparent;border-radius:var(--radius-sm);padding:4px 6px;cursor:pointer;text-align:left;width:100%;');
      row.dataset.preset = p.id;
      row.dataset.have = have ? have.id : '';
      row.append(
        el('span', 'font-size:var(--text-xs);color:' + (have ? 'var(--fg-2)' : 'var(--fg)') + ';', p.name),
        el('span', 'font-size:11px;color:var(--fg-2);', have ? '已有「' + have.name + '」· 点一下去改 Key / 换模型' : p.hint),
      );
      row.addEventListener('click', () => (have ? editPreset(have.id) : addPreset(p.id)));
      addMenu.appendChild(row);
    }
    /* 「本机模型」那一段：一行一个探测到的本地模型（点一下＝一家，模型已选好）。
       行标 `data-local`、**不用 `data-preset`** —— `[data-preset]` 是"静态预设清单"的判据
       （tools/e2e/settings-model-picker.cjs:87 与 ★8/★9、settings-local-templates.cjs 的 ★1b 都按它断言）。
       2026-09-28 起那段清单是**五家预设全列**、已加过的也列（标 `data-have`）；本机模版仍走 `data-local`。 */
    const local = localCatalog;
    if (local && local.models.length) {
      addMenu.appendChild(el('div',
        'font-size:10px;color:var(--fg-2);padding:6px 6px 2px;margin-top:2px;border-top:1px solid var(--border);',
        '本机模型（' + local.models.length + ' 个 · ' + hhmm(local.at) + ' 拉的）· 点一下＝加一家并切过去（模型已选好）'));
      for (const m of local.models) {
        const owner = localOwner(m.id);
        const row = el('button', 'display:flex;flex-direction:column;gap:1px;align-items:flex-start;background:transparent;border:1px solid transparent;border-radius:var(--radius-sm);padding:4px 6px;cursor:pointer;text-align:left;width:100%;');
        row.dataset.local = m.id;
        row.append(
          el('span', 'font-size:var(--text-xs);color:var(--fg);', '本地 Ollama · ' + m.id),
          el('span', 'font-size:11px;color:var(--fg-2);',
            owner ? '已有 · 点一下设为当前在用' : (m.meta ? m.meta + ' · 点一下加一家并切过去' : '点一下加一家并切过去（模型已选好）')),
        );
        row.addEventListener('click', () => addLocalModel(m.id));
        addMenu.appendChild(row);
      }
    } else {
      addMenu.appendChild(el('div',
        'font-size:11px;color:var(--fg-2);padding:5px 6px 2px;margin-top:2px;border-top:1px solid var(--border);',
        localProbing ? '正在问本机 Ollama 要模型清单…' : '没探测到本机模型（本机 Ollama 没开？）—— 下面照旧能自己加一家选模型'));
    }
    const cus = el('button', 'display:flex;flex-direction:column;gap:1px;align-items:flex-start;background:transparent;border:1px solid transparent;border-radius:var(--radius-sm);padding:4px 6px;cursor:pointer;text-align:left;width:100%;border-top:1px solid var(--border);');
    cus.dataset.preset = 'custom';
    cus.append(
      el('span', 'font-size:var(--text-xs);color:var(--fg);', '自定义供应商'),
      el('span', 'font-size:11px;color:var(--fg-2);', presetOf('custom').hint),
    );
    cus.addEventListener('click', () => addCustom());
    addMenu.appendChild(cus);
  }

  function addPreset(presetId: string): void {
    s.providers.push(providerFromPreset(presetId));
    hideAddMenu();
    paintProviders();
    dirty('已添加「' + presetOf(presetId).name + '」—— 把 Key 粘进去、点「保存并启用」就完事');
    openEditor(presetId, 'create');
  }
  /** 点一行「已经有了」的预设：**不重复加**，直接开那家的编辑卡
   *  （预设那家的卡就是简化卡：Key + 「保存并启用」，名字/端点折在「高级」里 ⇒ 换 Key 两步）。 */
  function editPreset(id: string): void {
    const p = byId(id);
    if (!p) return;
    hideAddMenu();
    openEditor(p.id);
    dirty('「' + p.name + '」已经在清单里 —— 改完 Key 点「保存并启用」');
  }
  function addCustom(): void {
    const p = customProvider(uid('pv'));
    s.providers.push(p);
    hideAddMenu();
    paintProviders();
    dirty('已添加自定义供应商 —— 填好端点、Key 和模型再点「保存设置」');
    openEditor(p.id);
  }
  /** 点一行「本机模型」：已经有主的那条**不重复加**，直接切过去（点两下不该多出两家）。
   *  新加的那家顺手设成「当前在用」—— 你要的就是"换这个模型"，再让你去点一次「使用」等于把省下的麻烦加回去
   *  （行上的小字也照实写了"点一下加一家并切过去"）。落盘仍要点底部「保存设置」。 */
  function addLocalModel(modelId: string): void {
    const have = localOwner(modelId);
    if (have) {
      s.activeProvider = have.id;
      hideAddMenu();
      paintProviders();
      dirty('「' + have.name + '」已经在清单里 —— 已设为当前在用，点「保存设置」生效');
      openEditor(have.id);
      return;
    }
    const cfg = localCfg();
    const p: ProviderProfile = {
      id: uid('pv'),
      name: '本地 Ollama · ' + modelId,
      preset: 'ollama',
      kind: 'ollama',
      baseUrl: cfg.baseUrl,
      apiKey: '',
      model: modelId,
    };
    s.providers.push(p);
    s.activeProvider = p.id;
    hideAddMenu();
    paintProviders();
    dirty('已添加「' + p.name + '」并设为当前在用 —— 点「保存设置」生效');
    openEditor(p.id);
  }
  function showAddMenu(open: boolean): void {
    if (!addMenu) return;
    addMenu.style.display = open ? 'flex' : 'none';
  }
  function hideAddMenu(): void {
    showAddMenu(false);
    if (addHint) addHint.textContent = '';
  }

  /** 卡片外观按「是哪一家 + 什么来路」刷一遍：预设藏起名字/协议/端点、自定义展开、缺 Key 叫人填 Key。 */
  function paintEditorChrome(): void {
    const p = edited();
    const preset = p ? presetOf(p.preset) : null;
    const custom = !p || p.preset === 'custom';
    if (pTitle) pTitle.textContent = (editorMode === 'create' ? '添加 · ' : '编辑供应商 · ') + (p?.name || '');
    if (pSum) {
      pSum.textContent = !p ? '' : custom
        ? '端点是自己填的 —— 在下面「高级」里填 Base URL、协议和模型名。'
        : '端点已经填好：' + p.baseUrl + '（' + (preset?.hint || '') + '）—— '
          + (p.apiKey ? 'Key 已经存好了，换个模型直接点下面的「模型」。' : '把 Key 粘进去就行。');
    }
    if (pKeyLab) {
      pKeyLab.textContent = !p ? 'API Key' : preset && !preset.keyHint
        ? 'API Key（本地端点不用填，留空即可）'
        : 'API Key' + (preset?.keyHint ? '（' + preset.keyHint + '）' : '');
    }
    if (pAdvBox) pAdvBox.style.display = advOpen ? 'flex' : 'none';
    if (pAdvBtn) {
      pAdvBtn.textContent = advOpen ? '收起高级' : '高级（名字 / 端点 / 协议）';
      pAdvBtn.style.display = custom ? 'none' : '';
    }
    /* 一键那条只对"端点是现成的"有意义（预设）。自定义供应商本来就得自己填端点，按钮没意义 */
    if (pSaveAdd) pSaveAdd.style.display = custom ? 'none' : '';
  }

  function openEditor(id: string, mode: 'create' | 'edit' = 'edit'): void {
    const p = byId(id);
    if (!p || !editor) return;
    editing = id;
    editorMode = mode;
    /* 自定义那家一上来就得看见端点输入框（不然"整张卡只有一个 Key"是荒唐的） */
    advOpen = p.preset === 'custom';
    editor.style.display = 'flex';
    if (pName) pName.value = p.name;
    if (pKind) pKind.value = p.kind;
    if (pBase) pBase.value = p.baseUrl;
    if (pKey) pKey.value = p.apiKey;
    if (pKey) pKey.placeholder = presetOf(p.preset).keyHint || '本地端点可留空';
    if (pDel) pDel.disabled = s.providers.length <= 1;
    if (pDel) pDel.title = s.providers.length <= 1 ? '至少要留一家供应商' : '删掉这一家（点「保存设置」生效）';
    catalog = p.baseUrl ? readCatalog(probeCfgOf(p)) : null;
    showMenu(false);
    paintModelList();
    if (mHint) {
      mHint.textContent = mode === 'create'
        ? '点「保存并启用」——电脑会问端点要一份清单、替你挑一个'
        : catalog
          ? catalog.models.length + ' 个模型 · ' + hhmm(catalog.at) + ' 拉的'
          : '点开可列出端点提供的模型';
    }
    paintEditorChrome();
    /* 新加一家的主顺路是"粘 Key"⇒ 光标直接落在那儿（本地 Ollama 不用 Key，就别抢焦点） */
    if (mode === 'create' && p.kind === 'openai') pKey?.focus();
    paintProviders();
  }
  function closeEditor(): void {
    editing = null;
    if (editor) editor.style.display = 'none';
    showMenu(false);
    paintProviders();
  }

  function markModelStale(): void {
    if (mHint) mHint.textContent = '端点改了 —— 点「刷新」重新问一次';
  }
  function showMenu(open: boolean): void {
    if (!mMenu) return;
    mMenu.style.display = open ? 'flex' : 'none';
    mBtn?.classList.toggle('is-open', open);
  }
  /** 清单行：当前值永远在单子上（哪怕端点这次没报它：清单是缓存的、或手填过一个端点没有的名字） */
  function paintModelList(): void {
    if (!mList) return;
    const p = edited();
    const q = (mSearch?.value || '').trim().toLowerCase();
    const rows: { id: string; meta: string; cur: boolean }[] = [];
    if (p?.model) rows.push({ id: p.model, meta: '当前在用', cur: true });
    for (const m of catalog?.models ?? []) if (!rows.some((r) => r.id === m.id)) rows.push({ id: m.id, meta: m.meta, cur: false });
    const shown = rows.filter((r) => !q || r.id.toLowerCase().includes(q));
    if (mCur) mCur.textContent = p?.model || '（还没选模型）';
    mList.textContent = '';
    if (!shown.length) {
      mList.appendChild(el('div', 'font-size:var(--text-xs);color:var(--fg-2);padding:2px 0;', q ? '没有匹配的模型' : '清单还是空的 —— 点「刷新」问一次端点'));
      return;
    }
    for (const r of shown) {
      const row = el('button', 'display:flex;align-items:center;gap:8px;width:100%;background:transparent;border:1px solid '
        + (r.cur ? 'var(--accent)' : 'transparent') + ';border-radius:var(--radius-sm);padding:4px 6px;color:var(--fg);font-size:var(--text-xs);cursor:pointer;text-align:left;');
      row.className = 'lk-set-model-row' + (r.cur ? ' is-cur' : '');
      row.dataset.model = r.id;
      row.append(
        el('span', 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' + (r.cur ? 'font-weight:600;' : ''), r.id),
        el('span', 'flex-shrink:0;color:var(--fg-2);font-size:11px;', r.meta),
      );
      row.addEventListener('click', () => pickModel(r.id));
      mList.appendChild(row);
    }
  }
  function pickModel(name: string): void {
    const p = edited();
    if (!p) return;
    p.model = name;
    if (mCur) mCur.textContent = name;
    showMenu(false);
    if (mHint) mHint.textContent = '已选 ' + name + '（点「保存设置」落盘）';
    paintModelList();
    paintProviders();
  }
  async function probeModelList(): Promise<void> {
    const p = edited();
    if (probing || !p) return;
    probing = true;
    if (mHint) mHint.textContent = '正在问端点要清单…';
    if (mRefresh) mRefresh.disabled = true;
    const res = await probeModels(probeCfgOf(p));
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

  /** **一键：拿 Key 去问清单 → 自动挑一个模型 → 设为当前在用 → 立刻落盘并广播。**
   *
   *  用户 2026-09-28：「我们把预设做一下吧，到时候直接选供应商再填 key，尽量简化」。
   *  以前这条顺路是：点预设 ⇒ 编辑卡里有 5 个字段要自己看 ⇒ 粘 Key ⇒ 点「刷新」⇒ 在几十行里挑模型
   *  ⇒ 回列表点「使用」（或在这张卡里点）⇒ 到底部点「保存设置」。现在压成一下：
   *  选一家 → 粘 Key → 「保存并启用」。
   *
   *  三点分寸：
   *   · **落盘不等底部那次「保存设置」**：按钮就叫「保存并启用」，再让人回去点一次等于没简化。
   *     于是这一下是"立刻存盘 + 广播"（与转场/演变那几项 `saveNow` 同一档语义）。其它供应商字段
   *     （名字/端点/协议）改了仍然是草稿，要底部那次保存 —— 别把两种时机弄混。
   *   · **挑模型是"偏好 + 猜"，不是写死**：清单里有预设偏好的那个就用它，否则挑一个像对话模型的
   *     （见 `recommendModel`）；已经手选过模型（`p.model` 非空）就**不动它**。
   *   · **没连上不装成功**：报端点原话、把 Key 留在框里、自动展开高级（去改端点或手填模型名），
   *     并且**不落盘** —— 免得存下一家打不通的供应商，让创作者以为是灵框坏了。 */
  async function saveAndEnable(): Promise<void> {
    const p = edited();
    if (!p) return;
    if (!p.baseUrl) {
      advOpen = true;
      paintEditorChrome();
      dirty('这家还没填端点 —— 在「高级」里填 Base URL');
      pBase?.focus();
      return;
    }
    if (p.kind === 'openai' && !p.apiKey) {
      dirty('把 API Key 粘进去再点「保存并启用」');
      pKey?.focus();
      return;
    }
    if (probing) return;
    probing = true;
    if (pSaveAdd) pSaveAdd.disabled = true;
    if (mHint) mHint.textContent = '正在拿这把 Key 问端点…';
    const res = await probeModels(probeCfgOf(p));
    probing = false;
    if (pSaveAdd) pSaveAdd.disabled = false;
    if (!res.ok || !res.catalog) {
      advOpen = true;
      paintEditorChrome();
      if (mHint) mHint.textContent = '没问到模型清单：' + res.error;
      showMenu(true);            /* 顺便把"手填模型名"那一行露出来 */
      paintModelList();
      dirty('没连上 ' + p.baseUrl + '：' + res.error);
      return;
    }
    catalog = res.catalog;
    const picked = p.model || recommendModel(catalog.models, presetOf(p.preset).defaultModel);
    p.model = picked;
    s.activeProvider = p.id;
    saveSettings(s);
    /* 供应商换过 ⇒ 广播一次：助手面板的 chip、联想窗口下次打开就是新的 */
    window.dispatchEvent(new CustomEvent('lingkuang-settings'));
    editorMode = 'edit';
    showMenu(false);
    paintModelList();
    paintEditorChrome();
    paintProviders();
    if (mHint) mHint.textContent = catalog.models.length + ' 个模型 · ' + hhmm(catalog.at) + ' 拉的';
    dirty('已启用「' + p.name + ' · ' + picked + '」—— 现在就能用了（不满意可点「模型」换）');
  }

  addBtn?.addEventListener('click', () => {
    const open = addMenu?.style.display !== 'flex';
    if (open) {
      /* 本机模型那一段：先拿上次那份缓存画一次（Ollama 没开也照样能选），再在后台刷一次 */
      localCatalog = localCatalog ?? readCatalog(localCfg());
      paintAddMenu();
      void refreshLocalCatalog();
    }
    showAddMenu(open);
    if (addHint) addHint.textContent = open ? '选一家 —— 端点已经替你填好，粘上 Key 点「保存并启用」就能用（标着「已有」的那家点一下是去改它的 Key）' : '';
  });
  const EDIT_FIELDS = [['#set-prov-name', 'name'], ['#set-prov-baseurl', 'baseUrl'], ['#set-prov-apikey', 'apiKey']] as const;
  for (const [sel, key] of EDIT_FIELDS) {
    bind(sel, (v) => {
      const p = edited();
      if (!p) return;
      if (key === 'name') p.name = v;
      else if (key === 'baseUrl') { p.baseUrl = v; markModelStale(); catalog = null; }
      else p.apiKey = v;
      paintEditorChrome();
      paintProviders();
    });
  }
  pKind?.addEventListener('change', () => {
    const p = edited();
    if (!p) return;
    p.kind = pKind.value === 'ollama' ? 'ollama' : 'openai';
    catalog = null;
    markModelStale();
    paintEditorChrome();
    paintProviders();
  });
  pUse?.addEventListener('click', () => {
    if (!editing) return;
    s.activeProvider = editing;
    paintProviders();
    dirty('「' + (edited()?.name || '') + '」现在是当前在用 —— 点「保存设置」生效');
  });
  pDel?.addEventListener('click', () => {
    if (!editing) return;
    if (s.providers.length <= 1) { dirty('至少要留一家供应商'); return; }
    const gone = byId(editing);
    s.providers = s.providers.filter((p) => p.id !== editing);
    if (!s.providers.some((p) => p.id === s.activeProvider)) s.activeProvider = s.providers[0].id;
    closeEditor();
    paintProviders();
    dirty('已删掉「' + (gone?.name || '') + '」—— 点「保存设置」生效');
  });
  pClose?.addEventListener('click', () => closeEditor());
  pAdvBtn?.addEventListener('click', () => { advOpen = !advOpen; paintEditorChrome(); });
  pSaveAdd?.addEventListener('click', () => void saveAndEnable());
  /* Key 框里敲回车 = 点「保存并启用」（粘完 Key 顺手回车，这是"填 Key 就能用"最省的一下） */
  pKey?.addEventListener('keydown', (e) => { if (e.key === 'Enter') void saveAndEnable(); });
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
  paintProviders();
  paintModelList();

  bind('#set-glide', (v) => { s.glide = parseFloat(v); (host.querySelector('#set-glide-v') as HTMLElement).textContent = v; });
  bind('#set-sens', (v) => { s.sensitivity = parseFloat(v); (host.querySelector('#set-sens-v') as HTMLElement).textContent = v; });
  bind('#set-ruler', (v) => { s.rulerDensity = parseFloat(v); (host.querySelector('#set-ruler-v') as HTMLElement).textContent = v; });

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
  const aiNameEl = host.querySelector('#set-ai-autoname') as HTMLInputElement | null;
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
    /* 供应商 / 模型换过 ⇒ 广播一次：别处读设置的（助手面板的 chip、联想窗口）下次打开就是新的 */
    window.dispatchEvent(new CustomEvent('lingkuang-settings'));
    msg.textContent = '已保存 ✓';
    setTimeout(() => (msg.textContent = ''), 1500);
  });
}
