/** 灵框 · 实体层（设定库）基础
 *
 * 模型（用户 2026-09-12 定）：
 *   - **类型 EntityType** = 模板：角色该有哪些字段（发色/性格/所属…）
 *   - **实体 Entity** = 实现：设定库里的一个条目（银发少女），`properties` 就是它的**初稿**
 *   - 差异帧（Phase 2）存在**实体自己身上**（`Entity.layers`，按时间叠加的时间窗），
 *     不放在事件节点上 —— 这条是用户明确选的。
 *
 * 与「节点种类」的关系：**模板分开存**（节点种类在 `worldbuilding.json` 顶层的 `formats`，
 * 由 `main.js` 的 `formats:load/save` 管；实体类型在**每个世界**的 `entityTypes`），
 * 但都由左栏「结构体管理」一个面板统一编辑。
 */
import type { Entity, EntityType, Worldset } from './types';

/** 内建实体类型。只在某个世界**还没有任何实体类型**时播种一次，之后完全由用户增删改。
 *  ⚠️ 故意**不做读取端兜底合并** —— `main.js` 的 `loadFormatsRaw` 曾经那样写，后果是
 *  「内建种类在面板里删掉、下次读又冒出来」。播种一次 + 之后以数据为准，才不会重演。 */
export const BUILTIN_ENTITY_TYPES: EntityType[] = [
  { id: '角色', name: '角色', fields: [
    { name: '性别', type: 'text' }, { name: '种族', type: 'text' }, { name: '年龄', type: 'text' },
    { name: '发色', type: 'text' }, { name: '瞳色', type: 'text' }, { name: '身高', type: 'number' },
    { name: '外貌', type: 'longtext' }, { name: '性格', type: 'longtext' },
    { name: '能力', type: 'longtext' }, { name: '所属', type: 'text' }, { name: '别名', type: 'list' },
  ] },
  { id: '地点', name: '地点', fields: [
    { name: '所属区域', type: 'text' }, { name: '规模', type: 'text' }, { name: '气候', type: 'text' },
    { name: '描述', type: 'longtext' }, { name: '别名', type: 'list' },
  ] },
  { id: '物品', name: '物品', fields: [
    { name: '种类', type: 'text' }, { name: '持有者', type: 'text' }, { name: '能力', type: 'longtext' },
    { name: '说明', type: 'longtext' },
  ] },
  { id: '组织', name: '组织', fields: [
    { name: '性质', type: 'text' }, { name: '首领', type: 'text' }, { name: '根据地', type: 'text' },
    { name: '简介', type: 'longtext' },
  ] },
  { id: '种族', name: '种族', fields: [
    { name: '寿命', type: 'text' }, { name: '特征', type: 'longtext' }, { name: '分布', type: 'text' },
  ] },
];

/** 该类型的字段默认值（与 `main.js` 的 FORMAT_TYPES 默认值一致：数值 0 / 开关 false / 列表 [] / 其余 ''） */
function defaultOf(type: string): string | number | boolean | never[] {
  return type === 'number' ? 0 : type === 'boolean' ? false : type === 'list' ? [] : '';
}

/** 世界还没有实体类型时播种内建类型。返回是否改动了数据。 */
export function ensureEntityTypes(ws: Worldset): boolean {
  if (ws.entityTypes && Object.keys(ws.entityTypes).length) return false;
  const seeded: Record<string, EntityType> = {};
  for (const t of BUILTIN_ENTITY_TYPES) seeded[t.id] = { id: t.id, name: t.name, fields: t.fields.map((f) => ({ ...f })) };
  ws.entityTypes = seeded;
  return true;
}

/** 按实体类型的模板给每个实体补全缺失字段（值用默认值）。
 *  与节点那边的 `ensureAllFormatFields` 同一套约定：**模板是唯一权威**，缺什么补什么。
 *  返回是否改动了数据。 */
export function ensureEntityFields(ws: Worldset): boolean {
  const types = ws.entityTypes ?? {};
  const entities = ws.entities ?? {};
  let changed = false;
  for (const e of Object.values(entities) as Entity[]) {
    const t = types[e.typeId];
    if (!t || !t.fields.length) continue;
    if (!e.properties) { e.properties = {}; changed = true; }
    for (const f of t.fields) {
      if (e.properties[f.name] === undefined) { e.properties[f.name] = defaultOf(f.type); changed = true; }
    }
  }
  return changed;
}

/** 取实体的类型模板（没有就返回 undefined） */
export function entityTypeOf(ws: Worldset, e: Entity | undefined): EntityType | undefined {
  if (!e) return undefined;
  return (ws.entityTypes ?? {})[e.typeId];
}
