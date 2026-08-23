/** 灵框 · 领域类型（数据层契约） */

/** 时间精度 */
export type TimePrecision = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second';

/** 时间线节点：本体 = 文稿（doc） */
export interface TimelineNode {
  id: string;
  title: string;
  year: number;                 // 内部小数年份（nodeToTime）
  precision: TimePrecision;
  type: 'event' | 'plot' | 'place' | 'year' | 'loop-boundary';
  desc?: string;
  doc?: string;                 // 节点本体（Markdown，frontmatter 存元数据）
  tag?: string;
  people?: string[];
  places?: string[];
  entityId?: string;            // 关联实体
  loopGroup?: string;           // 循环分组
}

/** 剧情线（多段，gap 与线无关） */
export interface StorySegment { start: number; end: number | null; }  // end=null 无限延续
export interface Storyline {
  id: string;
  name: string;
  segments: StorySegment[];
  color?: string;
}

/** 循环（轮回） */
export interface Loop {
  id: string;
  name: string;
  startId?: string;
  endId?: string;
  count: number;
  color?: string;
}

export interface Timeline {
  id: string;
  name: string;
  absOffset: number;
  nodes: TimelineNode[];
  loops: Loop[];
  storylines: Storyline[];
}

/** 实体类型（自定义） */
export interface EntityTypeField { id: string; name: string; type: 'text' | 'longtext' | 'number' | 'boolean'; }
export interface EntityType { id: string; name: string; fields: EntityTypeField[]; }

/** 实体实例（本体 = 文稿 e.doc） */
export interface Entity {
  id: string;
  typeId: string;
  name: string;
  doc?: string;
}

/** 地图（Leaflet 思路：手绘区域 + 标记 + 轨迹） */
export interface MapRegion {
  id: string;
  name: string;
  path: string;                 // SVG path（手绘平滑）
  points: [number, number][];
  fill: string;
  altitude?: number;            // 标量场（等高线）
  concentration?: number;
  filter?: string;              // 粗糙化滤镜（AE 式叠加）
}
export interface MapMarker { id: string; x: number; y: number; label: string; entityId?: string; }
export interface MapPath {                       // 路径追踪（人物/物品轨迹）
  id: string;
  entityId: string;
  points: { t: number; x: number; y: number }[]; // t=时间
  color?: string;
}
export interface MapData {
  id: string;
  name: string;
  width: number;
  height: number;
  regions: MapRegion[];
  markers: MapMarker[];
  paths: MapPath[];
}

/** 世界观（= 顶部世界栏的一个 tab） */
export interface Worldset {
  name: string;
  timelines: Record<string, Timeline>;
  order: string[];
  docs: Record<string, string>;
  entityTypes?: Record<string, EntityType>;
  entities?: Record<string, Entity>;
  maps?: MapData[];
  timeCursor?: number | null;
}

/** 根数据文件 */
export interface WorldData {
  worldsets: Record<string, Worldset>;
}
