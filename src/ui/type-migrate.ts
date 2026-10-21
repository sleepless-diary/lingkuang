/** 类别整理：把字段「类型」的值提升成真正的实体类型（typeId）
 *
 *  为什么需要它（2026-10-19 工作流评审的实测）：
 *    真实数据 112 条实体里 107 条把真实类别写在 `properties['类型']`（人物/历史/概念/基础设施/元设定…），
 *    而 `typeId` 大量是同一个「角色」模板 ⇒ `codex.ts` 的树按 `typeId` 分组，于是**一百多条全挤在一个文件夹里**，
 *    「类别混乱」的根在这儿，而上一轮只做了「行尾显示副类型」的治标。
 *
 *  为什么不能只改 `typeId` 了事：vault 里实体的路径是 `_设定/<类型名>/<名字>.md`（见 main.js 的
 *  `writeVaultEntitySync`）—— 只改内存里的 `typeId` 会让**下次重扫从旧目录把旧副本再拉回来**，
 *  变成同名两条。所以必须连带搬文件：先 `vault:delete-entity`（按 id 在全类型目录里找到并移进回收站），
 *  再 `vault:write-entity` 写到新目录。顺序不能反（反了会把刚写的新文件当成旧的删掉）。
 *
 *  安全阀：执行前先 `backup:create` 存一份 worldbuilding.json；失败就整件事不开始。
 *  `properties['类型']` 一律**保留**（不删只标）—— 它是作者的原始记录，删了就回不去了。
 */
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';
import type { Entity, EntityType } from '../store/types';

export interface TypePlanRow {
  /** 字段「类型」的值（要变成的类型名） */
  value: string;
  /** 会搬过去的实体 id */
  ids: string[];
  /** 目标类型 id（已存在就复用，否则是新建的 id） */
  targetId: string;
  isNew: boolean;
}

export interface TypePlan {
  rows: TypePlanRow[];
  /** 要新建的类型（id / 名字 / 字段：按原类型的字段并集，同名同型才保留原类型，否则退化成 text） */
  newTypes: EntityType[];
  /** 已经在正确类型下 / 没有「类型」字段的条数 */
  skipped: number;
  /** 归一化后只剩 1 条的类别：**不建类型**（否则会冒出几十个只有一条的类型），列为待定 */
  pendingSingles: { value: string; count: number }[];
}

const EMPTY_PLAN: TypePlan = { rows: [], newTypes: [], skipped: 0, pendingSingles: [] };

/** 把「物品/科技/魔法」「元设定/待办」这种多值写法收成**一个**主类别：取第一个分隔符之前那段。
 *  为什么必须收：类型名会进 vault 的目录名（`_设定/<类型名>/`），斜杠会造出嵌套目录。 */
export function primaryCategory(raw: string): string {
  const s = String(raw ?? '').trim();
  const first = s.split(/[\/／、,，·|｜>＞]+/).map((x) => x.trim()).find(Boolean) ?? '';
  return first.slice(0, 20);
}

export function planTypeSplit(store: Store): TypePlan {
  const ws = currentWorld(store);
  if (!ws) return EMPTY_PLAN;
  const types = (ws.entityTypes ?? {}) as Record<string, EntityType>;
  const typeName = (id: string): string => String(types[id]?.name ?? id);
  const byValue = new Map<string, { ids: string[]; fieldUnion: Map<string, EntityType['fields'][number]> }>();
  let skipped = 0;

  for (const e of Object.values((ws.entities ?? {}) as Record<string, Entity>)) {
    const raw = typeof e.properties?.['类型'] === 'string' ? String(e.properties['类型']).trim() : '';
    if (!raw) { skipped++; continue; }
    if (raw === typeName(e.typeId)) { skipped++; continue; }
    /* 归一化成一个主类别：`物品/科技/魔法` 与 `物品/材料` 落到同一个「物品」里 */
    const key = primaryCategory(raw);
    if (!key) { skipped++; continue; }
    const slot = byValue.get(key) ?? { ids: [], fieldUnion: new Map<string, EntityType['fields'][number]>() };
    slot.ids.push(e.id);
    for (const f of types[e.typeId]?.fields ?? []) {
      const prev = slot.fieldUnion.get(f.name);
      /* 同名同型就保留，冲突就退化成 text（不让「整理类别」顺手改掉字段类型） */
      if (!prev || prev.type === f.type) slot.fieldUnion.set(f.name, f);
      else slot.fieldUnion.set(f.name, { name: f.name, type: 'text' });
    }
    byValue.set(key, slot);
  }

  const rows: TypePlanRow[] = [];
  const newTypes: EntityType[] = [];
  const pendingSingles: { value: string; count: number }[] = [];
  const usedIds = new Set(Object.keys(types));
  let seq = 0;
  /* 少于 2 条的类别先不动：真实数据里 36 个类别有 27 个只有 1 条，全建出来就是 27 个空文件夹 */
  const MIN_PER_TYPE = 2;
  for (const [value, slot] of byValue) {
    if (slot.ids.length < MIN_PER_TYPE) { pendingSingles.push({ value, count: slot.ids.length }); continue; }
    const existing = Object.values(types).find((t) => String(t.name ?? '').trim() === value);
    if (existing) {
      rows.push({ value, ids: slot.ids, targetId: existing.id, isNew: false });
      continue;
    }
    /* 类型 id **直接用类别名**（老数据就是 `角色`/`地点` 这种 id = 名字的写法）。
       不能造 `et_1` 这种机器 id：vault 的实体路径、frontmatter 的 `type`、以及重扫时的
       `typeId: e.type ?? 类型名` 全都拿它当目录名 —— id 与名字一旦不一致，重扫后 85 条实体会
       全部悬空（类型行在、实体归不进去）。冲突时才加后缀。 */
    let id = value;
    if (usedIds.has(id)) id = value + '_' + (++seq);
    usedIds.add(id);
    rows.push({ value, ids: slot.ids, targetId: id, isNew: true });
    newTypes.push({ id, name: value, fields: Array.from(slot.fieldUnion.values()) });
  }
  /* 多的排前面：一眼看到最该整理的 */
  rows.sort((a, b) => b.ids.length - a.ids.length || a.value.localeCompare(b.value, 'zh'));
  pendingSingles.sort((a, b) => a.value.localeCompare(b.value, 'zh'));
  return { rows, newTypes, skipped, pendingSingles };
}

/** 一句话摘要（给确认弹层用） */
export function typeSplitSummary(plan: TypePlan): string {
  const moved = plan.rows.reduce((n, r) => n + r.ids.length, 0);
  const fresh = plan.rows.filter((r) => r.isNew).length;
  const reuse = plan.rows.length - fresh;
  const single = plan.pendingSingles.length ? `；另有 ${plan.pendingSingles.length} 个类别只有 1 条（先不动 —— 免得冒出几十个只有一条的类型）` : '';
  return `会搬 ${moved} 条实体：新建 ${fresh} 个类型、复用 ${reuse} 个已有类型；${plan.skipped} 条已经在正确类型下${single}。`;
}

interface VaultApi {
  /* 目标名要和 `main.js` 的 BACKUP_TARGETS 对上：worldbuilding.json 是 `data`（词库才是 `lib`） */
  backupCreate?: (target: string) => Promise<{ ok?: boolean; error?: string; path?: string }>;
  vaultDeleteEntity?: (ws: string, e: unknown) => Promise<{ ok?: boolean }>;
  vaultWriteEntity?: (ws: string, typeName: string, e: unknown) => Promise<{ ok?: boolean; error?: string }>;
}

export interface ApplyResult { ok: boolean; moved: number; created: number; error?: string }

export async function applyTypeSplit(store: Store, plan: TypePlan): Promise<ApplyResult> {
  const ws = currentWorld(store);
  const wName = store.activeWorld;
  if (!ws || !plan.rows.length) return { ok: false, moved: 0, created: 0, error: '没有要整理的条目' };
  const api = (window as unknown as { lingkuangAPI?: VaultApi }).lingkuangAPI;
  if (!api?.backupCreate) return { ok: false, moved: 0, created: 0, error: '不在 Electron 里（没有备份接口），为了安全不执行' };

  const bk = await api.backupCreate('data').catch((err: unknown) => ({ ok: false, error: String(err) }));
  if (!bk?.ok) return { ok: false, moved: 0, created: 0, error: '先存备份失败，已中止：' + String(bk?.error ?? '未知原因') };

  /* 先记下要搬的实体（store.update 之后就取不到旧的了） */
  const jobs: { value: string; targetId: string; ent: Entity }[] = [];
  for (const row of plan.rows) {
    for (const id of row.ids) {
      const e = ws.entities?.[id];
      if (e) jobs.push({ value: row.value, targetId: row.targetId, ent: JSON.parse(JSON.stringify(e)) as Entity });
    }
  }

  store.update((d) => {
    const w = d.worldsets[wName];
    if (!w) return;
    if (!w.entityTypes) w.entityTypes = {};
    for (const t of plan.newTypes) w.entityTypes[t.id] = t;
    for (const row of plan.rows) {
      for (const id of row.ids) {
        const e = w.entities?.[id];
        if (e) e.typeId = row.targetId;
      }
    }
  });

  let moved = 0;
  let firstErr = '';
  for (const job of jobs) {
    const next = { ...job.ent, typeId: job.targetId };
    /* 顺序不能反：先按 id 把旧目录里的那份移进回收站，再写新目录的那份 */
    if (api.vaultDeleteEntity) await api.vaultDeleteEntity(wName, job.ent).catch(() => null);
    const res = api.vaultWriteEntity ? await api.vaultWriteEntity(wName, job.value, next).catch((err: unknown) => ({ ok: false, error: String(err) })) : { ok: false, error: '没有写 vault 的接口' };
    if (res?.ok) moved++;
    else if (!firstErr) firstErr = String((res as { error?: string })?.error ?? '写 vault 失败');
  }

  return { ok: !firstErr, moved, created: plan.newTypes.length, error: firstErr || undefined };
}

/** 计划里最值得显示的一行（弹层正文用）：最多列前 8 个类别 */
export function typeSplitLines(plan: TypePlan): string {
  const top = plan.rows.slice(0, 8).map((r) => `${r.value} ${r.ids.length} 条${r.isNew ? '（新建类型）' : '（并入已有类型）'}`);
  const more = plan.rows.length > 8 ? `……另有 ${plan.rows.length - 8} 个类别` : '';
  return top.join('\n') + (more ? '\n' + more : '');
}
