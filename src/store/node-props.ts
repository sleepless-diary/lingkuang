/** 灵框 · 节点固定属性（六行内置字段）的显示配置
 *
 *  背景（用户 2026-10-24）：「结构体管理里面应该对内置字段也能进行修改（但是事件节点等触及底层的
 *  字段需要保护）」。
 *
 *  节点的属性面板（`src/ui/props-panel.ts`）一直是「固定六行 + 模板字段 + 自定义属性」：
 *  固定六行写死在代码里，结构体管理改不了。现在把**显示层**交出来 —— 每个种类（`formats[k]`）
 *  可以给这六行改名、调顺序、隐藏，配置存在 `formats.json` 的 `props` 里（跟着模板走，不新开文件）。
 *
 *  ⚠️ 只改显示，**不改数据**：隐藏一行不会删节点上的值；底层四样（时间/精度/种类/类型）连隐藏都
 *  不允许 —— 时间轴坐标、模板与 vault 目录、沙盘画法全指着它们，藏了只会让日后解释不清。
 */
import type { NodeFixedKey, NodePropLayout, WorldFormat } from './types';

/** 默认显示名（也是属性面板里写回数据时用的键，**别改**：`props-panel` 的 `saveFixed()` 认它） */
export const FIXED_LABEL: Record<NodeFixedKey, string> = {
  title: '标题',
  time: '时间',
  precision: '精度',
  type: '类型',
  kind: '种类',
  desc: '描述',
};

/** 底层项：**不可隐藏**（改名允许 —— 名字只是显示） */
export const PROTECTED_KEYS: NodeFixedKey[] = ['time', 'precision', 'kind', 'type'];

/** 默认顺序：与 2026-09 那版属性面板一致（标题 → 时间 → 精度 → 类型 → 种类 → 描述） */
export const DEFAULT_LAYOUT: NodePropLayout[] = (['title', 'time', 'precision', 'type', 'kind', 'desc'] as NodeFixedKey[])
  .map((key) => ({ key }));

export interface ResolvedProp { key: NodeFixedKey; label: string; hidden: boolean; locked: boolean }

/** 把某一版（可能来自老文件 / 手改坏了的）配置收敛成**六行必有值**的形态：
 *  非法键与重复键丢掉、缺的键按默认顺序补在末尾；保护项强制 `hidden=false`。 */
export function resolveNodeProps(fmt: WorldFormat | undefined): ResolvedProp[] {
  const raw = Array.isArray(fmt?.props) && fmt.props.length ? fmt.props : DEFAULT_LAYOUT;
  const out: ResolvedProp[] = [];
  const seen = new Set<NodeFixedKey>();
  const push = (key: NodeFixedKey, label?: string, hidden?: boolean): void => {
    if (!FIXED_LABEL[key] || seen.has(key)) return;
    seen.add(key);
    const locked = PROTECTED_KEYS.includes(key);
    out.push({ key, label: (label ?? '').trim() || FIXED_LABEL[key], hidden: locked ? false : !!hidden, locked });
  };
  for (const p of raw as NodePropLayout[]) if (p && p.key) push(p.key, p.label, p.hidden);
  for (const p of DEFAULT_LAYOUT) push(p.key);
  return out;
}

/** 面板保存用：把 ResolvedProp[] 写回存档形态（默认名不落盘，保持文件干净） */
export function toLayout(rows: ResolvedProp[]): NodePropLayout[] {
  return rows.map((r) => {
    const item: NodePropLayout = { key: r.key };
    if (r.label && r.label !== FIXED_LABEL[r.key]) item.label = r.label;
    if (r.hidden) item.hidden = true;
    return item;
  });
}
