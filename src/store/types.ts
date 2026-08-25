/** 灵框 · 领域类型（数据层契约） */

/** 自定义笔记属性值（Obsidian 属性类型：文本/数值/布尔/多选列表/日期字符串） */
export type PropValue = string | number | boolean | (string | number)[];

/** 时间精度 */
export type TimePrecision = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second';

/** 时间线节点：本体 = 文稿（doc） */
export interface TimelineNode {
  id: string;
  title: string;
  year: number;                 // 该时间线历法下的原始年份（312、-800，人类可读）
  precision: TimePrecision;
  month?: number;               // 原始月 1~12（下同，由 parseTimeText 解析后存入）
  day?: number;                 // 原始日
  hour?: number;                // 原始时 0~23
  minute?: number;              // 原始分
  second?: number;              // 原始秒
  type: 'world_event' | 'story_event' | 'loop-boundary';
  kind?: string;                // 引用格式（character/place/item/... 在 formats.json 定义应填字段）
  causes?: string[];            // 因果线：本节点由哪些节点导致（存目标节点 id，frontmatter Obsidian 双向可读）
  desc?: string;
  doc?: string;                 // 节点本体（Markdown，frontmatter 存元数据）
  tag?: string;
  people?: string[];
  places?: string[];
  entityId?: string;            // 关联实体
  loopGroup?: string;           // 循环分组
  properties?: Record<string, PropValue>;   // 自定义笔记属性（frontmatter 任意键值，Obsidian 双向可读）
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
  calendar?: import('../../src/calendar').Calendar;   // 该线历法；空则默认 360 天制（兼容现有数据）
}

/** 实体类型（自定义） */
export interface EntityTypeField { id: string; name: string; type: 'text' | 'longtext' | 'number' | 'boolean'; }
export interface EntityType { id: string; name: string; fields: EntityTypeField[]; }

/** 格式/结构体定义：kind → 应填字段集合（权威参考，autoFix 对照它补缺失字段） */
export interface FormatField { name: string; type: 'text' | 'longtext' | 'number' | 'boolean'; }
export interface WorldFormat { id: string; name: string; fields: FormatField[]; }

/** 实体实例（本体 = 文稿 e.doc） */
export interface Entity {
  id: string;
  typeId: string;
  kind?: string;                // 引用格式
  name: string;
  doc?: string;
  properties?: Record<string, PropValue>;   // 自定义笔记属性（frontmatter 任意键值）
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
  formats?: Record<string, WorldFormat>;   // 格式/结构体定义（kind → 应填字段）
}
