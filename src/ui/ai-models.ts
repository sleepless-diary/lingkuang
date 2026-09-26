/** 灵框 · 模型清单（设置面板那个「模型选择」用）
 *
 *  用户 2026-09-26：「**设置里面的 ai 选择能不能改成像 dsh 里面的模型选择一样**」。
 *  DSH 那边的分寸（`@deepseek-ai/dsh-client-ui-settings-models` 的 `ModelListEditor`）：
 *  去问端点「你到底提供哪些模型」，拿回来的**只是候选**，由创作者点一个 —— 绝不背着他改配置；
 *  端点问不出来也**不是死路**：把失败原因显示出来，旁边照样能手填。
 *
 *  两种端点各有各的问法（与 `src/ui/ai.ts` 的拼法一致 —— 那边也是往 baseUrl 后面接
 *  `/api/chat` / `/chat/completions`）：
 *   · Ollama（`aiMode === 'ollama'`，baseUrl 形如 `http://localhost:11434`）→ GET `/api/tags`
 *   · OpenAI 兼容（`aiMode === 'api'`，baseUrl 形如 `https://…/v1`）→ GET `/models`
 *
 *  拉到哪份清单就按「aiMode|baseUrl」缓存进 localStorage `lingkuang-model-cache`：下次打开设置
 *  即使端点没开、也还能看见上次那份（DSH 的共享 catalog 也是这个角色）。探测失败**不覆盖**缓存。
 */
/** 清单里的一行：`meta` 是给人看的小字（参数量 / 量化 / 体积 / 归属） */
export interface ModelEntry { id: string; meta: string; }
export interface ModelCatalog { at: number; models: ModelEntry[]; }
/** 探测端点要的三件事（`Settings` 里就有，够用就行，免得这个模块反向依赖设置的类型形状） */
export interface ProbeCfg { aiMode: 'ollama' | 'api'; baseUrl: string; apiKey: string; }

const CACHE_KEY = 'lingkuang-model-cache';
/** 端点没响应就到此为止：5 秒足够本机 Ollama 报清单，再久创作者已经以为设置卡死了 */
const TIMEOUT_MS = 5000;

function humanBytes(n: unknown): string {
  const v = typeof n === 'number' ? n : NaN;
  if (!v || !isFinite(v)) return '';
  const gb = v / 1073741824;
  return gb >= 1 ? gb.toFixed(1) + ' GB' : Math.round(v / 1048576) + ' MB';
}

/** 缓存键：换了端点/换了模式就是另一份清单（旧清单对新端点没有参考价值） */
export function cacheKey(cfg: ProbeCfg): string {
  return cfg.aiMode + '|' + (cfg.baseUrl || '').replace(/\/+$/, '');
}

type CacheFile = Record<string, ModelCatalog>;

function readFile(): CacheFile {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    return raw && typeof raw === 'object' ? (raw as CacheFile) : {};
  } catch {
    return {};
  }
}

/** 上次成功拉到的清单（没有就 null）。失败不写缓存 ⇒ 这里拿到的永远是"见过世面"的那份。 */
export function readCatalog(cfg: ProbeCfg): ModelCatalog | null {
  const hit = readFile()[cacheKey(cfg)];
  if (!hit || !Array.isArray(hit.models)) return null;
  const models = hit.models.filter((m) => m && typeof m.id === 'string' && m.id);
  return models.length ? { at: typeof hit.at === 'number' ? hit.at : 0, models } : null;
}

function writeCatalog(cfg: ProbeCfg, cat: ModelCatalog): void {
  const file = readFile();
  file[cacheKey(cfg)] = cat;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(file)); } catch { /* 存不下就算了，下次重新拉 */ }
}

/** Ollama `/api/tags`：`{ models: [{ name, size, details: { parameter_size, quantization_level } }] }` */
function fromOllama(data: any): ModelEntry[] {
  const arr: any[] = Array.isArray(data?.models) ? data.models : [];
  const out: ModelEntry[] = [];
  for (const m of arr) {
    const id = String(m?.name || m?.model || '').trim();
    if (!id) continue;
    const d = m?.details || {};
    const meta = [d.parameter_size, d.quantization_level, humanBytes(m?.size)].filter(Boolean).join(' · ');
    out.push({ id, meta });
  }
  return out;
}

/** OpenAI 兼容 `/models`：`{ data: [{ id, owned_by }] }`（有的网关只给 `models`） */
function fromApi(data: any): ModelEntry[] {
  const arr: any[] = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : []);
  const out: ModelEntry[] = [];
  for (const m of arr) {
    const id = String(m?.id || m?.name || '').trim();
    if (!id) continue;
    out.push({ id, meta: String(m?.owned_by || '') });
  }
  return out;
}

/** 问端点要清单。**永远 resolve**（失败当结果返回，不 throw）—— 调用方只管画提示。 */
export async function probeModels(cfg: ProbeCfg): Promise<{ ok: boolean; error: string; catalog: ModelCatalog | null }> {
  const base = (cfg.baseUrl || '').replace(/\/+$/, '');
  const fail = (error: string) => ({ ok: false, error, catalog: null });
  if (!base) return fail('还没填 Base URL');
  const headers: Record<string, string> = {};
  if (cfg.aiMode === 'api' && cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(cfg.aiMode === 'api' ? base + '/models' : base + '/api/tags', { headers, signal: ac.signal });
    if (!r.ok) return fail('端点返回 http ' + r.status + (r.status === 401 || r.status === 403 ? '（API Key 不对？）' : ''));
    const data = await r.json();
    const models = (cfg.aiMode === 'api' ? fromApi(data) : fromOllama(data)).sort((a, b) => a.id.localeCompare(b.id));
    if (!models.length) return fail('端点没报出任何模型');
    const catalog: ModelCatalog = { at: Date.now(), models };
    writeCatalog(cfg, catalog);
    return { ok: true, error: '', catalog };
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    return fail(/abort/i.test(msg) ? '端点 ' + TIMEOUT_MS / 1000 + ' 秒没响应' : '连不上端点：' + msg);
  } finally {
    window.clearTimeout(timer);
  }
}
