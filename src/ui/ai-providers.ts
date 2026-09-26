/** 灵框 · AI **供应商档案**（用户 2026-09-26：「做成可选供应商和自定义供应商的版本吧，
 *  再把设置分页做一下，就像 dsh」）。
 *
 *  以前设置里只有一句 `aiMode: 'ollama' | 'api'` + 三个平铺字段（baseUrl / apiKey / model）：
 *  「用谁」和「怎么连」挤在一起，换一家就得手打一遍 Base URL、再把 API Key 清掉。
 *  现在一个**供应商档案** = 一行：名字 + 协议（原生 Ollama / OpenAI 兼容）+ 端点 + Key + 选中的模型；
 *  设置页里可以有好几份，**当前在用**的那份决定所有 AI 功能往哪儿发请求。
 *
 *  借 DSH `dsh-client-ui-settings-models` 的三条分寸（读过它的 ProviderEditor / CustomProviderCard）：
 *   ① **预设只产候选**：预设只是帮你把 Base URL 填好的一条起跑线，绝不替你写死或偷偷改配置；
 *   ② **自定义是"创建"不是"编辑"**：预设之外有一条自定义供应商，端点/协议/模型都得自己填；
 *      失败要**点名是哪个字段**（而不是等到发请求那一刻才报 http 404）；
 *   ③ **凭据与档案一起走、但单独一把**：档案里存的是 `apiKey` 字面量（灵框是本地单机应用，
 *      没有 DSH 那种 credentials/set 的凭据库；面板上它以 password 输入框出现，不写进日志）。
 *
 *  ⚠️ 本模块**不 import `./settings`** —— `settings.ts` 要 import 这里做迁移，
 *  反向 import 会成环（上一轮 `ai-models.ts` 已经栽过一次，见那里的注释）。所以
 *  `activeOf()` 收的是**结构类型**，不认 `Settings`。 */

/** 协议：`ollama` = 原生 `/api/chat` + `/api/tags`；`openai` = OpenAI 兼容 `/chat/completions` + `/models` */
export type ProviderKind = 'ollama' | 'openai';

export interface ProviderProfile {
  /** 稳定 id（落盘用；预设那条就用预设 id，自定义的用 `uid('pv')`） */
  id: string;
  /** 显示名（自定义的可以随便改） */
  name: string;
  /** 出自哪条预设（`ollama`/`deepseek`/`openai`/`siliconflow`/`custom`）—— 只为了显示说明与图标 */
  preset: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  /** 这一家选中的模型名（切换供应商 = 连模型一起换） */
  model: string;
}

export interface ProviderPreset {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  /** 一句话说明（面板上显示在名字下面） */
  hint: string;
  /** API Key 输入框的 placeholder（空串 = 不需要 Key） */
  keyHint: string;
}

/** 预设清单：本地一条 + 三家常见的 + 自定义。**顺序 = 面板上「添加供应商」菜单的顺序**。 */
export const PRESETS: ProviderPreset[] = [
  { id: 'ollama', name: '本地 Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', hint: '跑在自己电脑上，不花钱；要先起 ollama serve', keyHint: '' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', hint: '官方 API，按量付费', keyHint: 'sk-…' },
  { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', hint: '官方 API，需要能连上它的网络', keyHint: 'sk-…' },
  { id: 'siliconflow', name: '硅基流动', kind: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', hint: '国内聚合端点，模型多、常有免费额度', keyHint: 'sk-…' },
  { id: 'custom', name: '自定义供应商', kind: 'openai', baseUrl: '', hint: '任何 OpenAI 兼容端点（中转站 / 自建 / 局域网里的另一台机器）', keyHint: 'sk-…' },
];

export const KIND_LABEL: Record<ProviderKind, string> = {
  ollama: '原生 Ollama',
  openai: 'OpenAI 兼容',
};

export function presetOf(id: string): ProviderPreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[PRESETS.length - 1];
}

/** 默认供应商 = 本地 Ollama（灵框开箱即用的那条路；模型用 content 正常的 qwen2.5:7b）。 */
export function defaultProviders(): ProviderProfile[] {
  return [providerFromPreset('ollama')];
}

/** 按预设造一份档案（自己 id 生成留空 —— 预设的 id 就是预设 id）。 */
export function providerFromPreset(presetId: string): ProviderProfile {
  const p = presetOf(presetId);
  return {
    id: p.id,
    name: p.name,
    preset: p.id,
    kind: p.kind,
    baseUrl: p.baseUrl,
    apiKey: '',
    model: p.id === 'ollama' ? 'qwen2.5:7b' : '',
  };
}

/** 自定义供应商（id 由调用方给 —— 它得用 store 层的 `uid()`，本模块不认识 store）。 */
export function customProvider(id: string): ProviderProfile {
  return { id, name: '自定义供应商', preset: 'custom', kind: 'openai', baseUrl: '', apiKey: '', model: '' };
}

/** 把落盘里读出来的一条洗成合法档案（手改过 localStorage / 老版本写进怪值都从这儿过）。
 *  返回 null = 这条根本不是个档案，直接丢掉。 */
export function sanitizeProvider(raw: unknown): ProviderProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const baseUrl = typeof r.baseUrl === 'string' ? r.baseUrl.trim() : '';
  if (!id) return null;
  const preset = typeof r.preset === 'string' && PRESETS.some((p) => p.id === r.preset) ? r.preset : 'custom';
  const kind: ProviderKind = r.kind === 'ollama' ? 'ollama' : r.kind === 'openai' ? 'openai' : presetOf(preset).kind;
  const fallbackName = preset === 'custom' ? '自定义供应商' : presetOf(preset).name;
  return {
    id,
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : fallbackName,
    preset,
    kind,
    baseUrl,
    apiKey: typeof r.apiKey === 'string' ? r.apiKey : '',
    model: typeof r.model === 'string' ? r.model.trim() : '',
  };
}

/** 「当前在用」的那份档案；`activeProvider` 指丢了（比如那条被删了）就退回第一份。 */
export function activeOf(s: { providers?: ProviderProfile[]; activeProvider?: string }): ProviderProfile | null {
  const list = Array.isArray(s.providers) ? s.providers : [];
  if (!list.length) return null;
  return list.find((p) => p.id === s.activeProvider) ?? list[0];
}

/** 一行摘要（助手面板的 chip、设置页的「当前在用」都用它）。 */
export function providerSummary(p: ProviderProfile | null): string {
  if (!p) return '还没配供应商';
  const model = p.model || '还没选模型';
  return p.name + ' · ' + model;
}

/** 这一份档案能不能真的发请求；不能就说清缺什么（设置页与 AI 调用共用同一句人话）。 */
export function providerProblem(p: ProviderProfile | null): string {
  if (!p) return '还没配 AI 供应商（设置 → 模型）';
  if (!p.baseUrl) return '「' + p.name + '」还没填端点地址（设置 → 模型）';
  if (!p.model) return '「' + p.name + '」还没选模型（设置 → 模型）';
  if (p.kind === 'openai' && !p.apiKey) return '「' + p.name + '」需要 API Key（设置 → 模型）';
  return '';
}

/** 转成 `src/ui/ai-models.ts` 的问清单参数（那边的探测只认 ollama/api 两分法）。 */
export function probeCfgOf(p: ProviderProfile): { aiMode: 'ollama' | 'api'; baseUrl: string; apiKey: string } {
  return { aiMode: p.kind === 'ollama' ? 'ollama' : 'api', baseUrl: p.baseUrl, apiKey: p.apiKey };
}
