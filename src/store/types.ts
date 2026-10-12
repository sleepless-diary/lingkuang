/** 灵框 · 领域类型（数据层契约） */

/** 自定义笔记属性值（Obsidian 属性类型：文本/数值/布尔/多选列表/日期字符串） */
export type PropValue = string | number | boolean | (string | number)[];

/** 时间精度 */
export type TimePrecision = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second';

/** 从粗到细的精度顺序（下拉顺序；也用于判断「哪一档更细」）。
    改精度时按它补/清 month/day/hour/minute/second —— 落盘那边 `yearToDateStr`
    是「有才写」（`main.js`：`n.month !== undefined && n.month !== null` 才写月），
    所以清成 `undefined` 就真的只写年份，不会凭空多出 `-01-01`。 */
export const PRECISION_ORDER: TimePrecision[] = ['year', 'month', 'day', 'hour', 'minute', 'second'];

/** 精度的中文标签（界面上只用这一份，避免各处各写一套映射） */
export const PRECISION_LABELS: Record<TimePrecision, string> = {
  year: '年',
  month: '月',
  day: '日',
  hour: '时',
  minute: '分',
  second: '秒',
};

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

/** 实体类型（= 实体模板）。字段与 FormatField 同构：按**名字**索引，值存在实体的 properties 里。
 *  （旧结构里每个字段还带一个从未被读取的 `id`，已去掉。） */
export interface EntityTypeField { name: string; type: FieldType; }
export interface EntityType { id: string; name: string; fields: EntityTypeField[]; }

/** ── 演变（实体版本历史，用户 2026-09-12 定方向、2026-09-13 细化）──
 *
 *  模型（与 git 同构）：
 *   - **初稿** = 实体自己身上的 `name` / `typeId` / `properties` / `doc`（= 第 0 版）
 *   - **帧** = 一个个提交，**只存与上一帧的区别**，锚在时间线上的一个事件节点上（`nodeId`）
 *   - 「某一刻的样子」= 初稿 + 按时间顺序叠加到那一帧为止的所有差异
 *
 *  几条硬约定：
 *   1. 帧数据存在**实体自己身上**（旧设计 `EntityLayer` 曾想按 epoch 开时间窗、后被本设计取代），
 *      不写进事件节点 —— 节点只是锚点。
 *   2. 每帧**只记改掉的键**，没动的字段不重复存（长文正文按行存差异，见 `DocPatch`）。
 *   3. `nodeId` 指向的节点被删掉时，帧**不删**（历史不能因为删了个节点就丢），只标记为「孤立」。
 */
export interface EntityFrame {
  nodeId: string;                   // 锚点：时间线节点 id
  world: string;                    // 该节点所在世界观
  tlId: string;                     // 该节点所在时间线
  note?: string;                    // 备注（缺省用节点标题显示）
  at?: number;                      // 记下这一帧的时刻（epoch 毫秒，仅显示用）
  patch: FramePatch;                // 与上一帧的区别
}

/** 一帧的差异内容：只有出现过的键才写（未动的字段一律省略） */
export interface FramePatch {
  name?: string;                            // 改了名字
  typeId?: string;                          // 换了类型
  set?: Record<string, PropValue>;          // 字段值：键 = 字段名，值 = 这一刻的新值
  del?: string[];                           // 被清空的字段名
  doc?: DocPatch;                           // 正文（Markdown）的差异
}

/** 按行存正文差异。`hunks` 为空且 `full` 有值 = 整段替换（改得太多、或差异算不出来时的兜底）。 */
export interface DocPatch {
  hunks?: DocHunk[];
  full?: string;
}

/** 一段行级改动。`at` 是**上一版**里的行号（0 基）；`hunks` 按 `at` **从大到小**排列，
 *  从后往前应用就天然不用算偏移（这是选这个顺序的唯一原因）。 */
export interface DocHunk {
  at: number;
  del: string[];
  ins: string[];
}

/** 模板字段类型（结构体管理面板里可选的种类）——
 *  「列表」的值是数组，编辑器按数组渲染成一列可勾选项 + 新增输入框。 */
export type FieldType = 'text' | 'longtext' | 'number' | 'boolean' | 'list';

/** 格式/结构体定义：kind → 应填字段集合（权威参考，autoFix 对照它补缺失字段） */
export interface FormatField { name: string; type: FieldType; }
export interface WorldFormat { id: string; name: string; fields: FormatField[]; }

/** 实体实例（本体 = 文稿 e.doc） */
export interface Entity {
  id: string;
  typeId: string;
  kind?: string;                // 引用格式
  name: string;
  doc?: string;
  properties?: Record<string, PropValue>;   // 「初稿」：按类型模板填的结构化特征
  frames?: EntityFrame[];                   // 「演变」：按时间排列的版本帧（只存与上一帧的区别）
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
  /** ⭐ 生成器的多层等高带：一个 path 里可能有多个环（内海/盆地）⇒ 要 evenodd 才挖得对洞。
      手绘区域不写这个字段（默认 nonzero，与从前一模一样）。 */
  rule?: 'evenodd';
}
export interface MapMarker { id: string; x: number; y: number; label: string; entityId?: string; }
export interface MapPath {                       // 路径追踪（人物/物品轨迹）
  id: string;
  entityId: string;
  points: { t: number; x: number; y: number }[]; // t=时间
  color?: string;
}
/** 地图上的**开放**线（河流 / 山脊 / 路线）—— 区域是闭合面，这些是线。
    生成器（`src/ui/map-gen.ts`）与将来的手绘路径共用这一条。 */
export interface MapLine {
  id: string;
  kind: 'river' | 'ridge' | 'road';
  points: [number, number][];
  name?: string;
  width?: number;
  color?: string;
}
/** ⭐ 手刷地形的一笔：工具 + 尺寸 + 轨迹点（**归一化世界坐标 0..1**）。
 *  和地形本身一样是"存参数不存图"：128×128 的高度约束场**不落盘**，
 *  生成时按同样的顺序重放这些笔划即可（所以数据文件只多几百字节）。 */
export interface MapPaintStroke {
  tool: string;   /* mountain | valley | shallow | ocean（见 src/mapgen/index.ts 的 PAINT_TOOLS） */
  size: string;   /* tiny | small | medium | large */
  points: { x: number; y: number }[];
}
/** ⭐ 生成的地形：**只存参数**（种子 / 档位 / 数量，几百字节）——
    地形图由 `src/ui/map-gen.ts` 现算现画（确定性：同一份参数永远同一片地），
    所以 worldbuilding.json 里不会塞进几百 KB 的 base64 图片。 */
export interface MapTerrainSpec {
  seed: string;
  style: string;
  spec?: { [k: string]: number | undefined };
  paint?: MapPaintStroke[]; // 手刷笔迹（笔划，不是场；可选 ⇒ 旧数据照旧能读）
  /* ⭐ 「看的方式」（第九十七轮）：relief 立体 / contour 等高线 / flat 平面
     （见 `src/mapgen/index.ts` 的 `TERRAIN_STYLES`）。可选 ⇒ 旧数据照旧能读；
     改它**不重算地形**，只重画（所以它不是生成参数，是显示参数）。 */
  view?: string;
}
export interface MapData {
  id: string;
  name: string;
  width: number;
  height: number;
  regions: MapRegion[];
  markers: MapMarker[];
  paths: MapPath[];
  /* ⚠️ 下面两个是**可选**字段（旧数据没有 ⇒ 照旧能读能画）。加字段而不是改结构，
     是因为地图住在 worldbuilding.json 里，用户手里那份数据不能因升级读不出来。 */
  lines?: MapLine[];        // 开放线（手绘轨迹之外，给将来的矢量水系留位）
  terrain?: MapTerrainSpec; // 程序化生成的地形（见 `src/ui/map-gen.ts`；图现算）
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
