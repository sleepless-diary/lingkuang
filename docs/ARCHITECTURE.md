# 灵框 LingKuang · 代码地图（Architecture）

> 给开发者 / AI 编程助手的快速上手文档。先读这份，再动代码。

## 1. 项目是什么

世界观创作工作台（Electron 单窗口应用，Vite + TypeScript 模块化）。核心功能：

- **世界沙盘 · 时间线**：横向节点图，多时间线并列、多条循环（轮回）、剧情线、时间指针
- **历法系统**：可编辑历法模型（`src/calendar.ts`），默认公历（闰年/大小月精确）
- **随机角色生成器**：词库随机组合角色，词条锁定、组合存档
- **词义联想图**：本地/API LLM 生成联想词，力导向节点图
- **编辑器**：tiptap Markdown 所见即所得，节点文稿管理
- **AI 工作台 / 角色扮演 / 酒馆推演**
- **地图模块**：手绘矢量地图（区域 + 标记）
- **MCP server**：供外部工具查询世界观数据

## 2. 文件结构

| 路径 | 职责 |
|---|---|
| `main.js` | Electron 主进程。IPC：`data:load/save`（世界观）、`settings`、`lib`（词库）、`ai:associate`（联想）、`ai:classify`（词分类）、`aiChat()`（双模式 LLM 调用）、`vault:*`（Obsidian 文稿：`scan`/`write`/`write-entity`/`delete`/`delete-entity`/`delete-timeline`/`delete-world`/`trash-list`/`trash-restore`/`trash-purge`）、`formats:load/save`（结构体格式）、`backup:list/create/restore/export/import`（备份管理）、`app:flush-sync`（退出前同步落盘） |
| `preload.js` | contextBridge 安全桥，暴露 `window.lingkuangAPI` |
| `index.html` | Vite 入口（`<div id="app">` + `<script src="/src/main.ts">`） |
| `mcp-server.js` | MCP 服务器（`query_timeline` / `query_node` / `search_world` / `query_loop`） |
| `src/main.ts` | 渲染进程入口，创建 store → 渲染 shell |
| `src/calendar.ts` | **历法系统**：可编辑历法模型（`Calendar`/`TimePoint`/`toEpoch`/`fromEpoch`），默认公历 |
| `src/store/` | 数据层：`store.ts`（单一数据源 + 订阅）、`actions.ts`（修改入口）、`types.ts`（领域类型） |
| `src/tools/` | `registry.ts`（工具栏工具注册表 + `Tool.group` 左栏分组；`openTool()` 给每次打开发一个**工具格** `.lk-tool-slot`——见「工具宿主」一段）+ `register.ts`（工具定义） |
| `src/ui/shell.ts` | 壳 UI：世界栏 + 工具栏 + 沙盘 + 工具宿主 |
| `src/ui/timeline.ts` | 世界沙盘时间线（坐标 epoch 秒、标尺分级、循环、剧情线、时间指针） |
| `src/ui/inspire.ts` | 灵感触发器（随机角色生成 + 词义联想入口） |
| `src/ui/assoc.ts` | 词义联想**无限画布**（力导向 + 单线聚焦 + 视窗平移/缩放 + 拖节点贴边自动推视窗 + 手动摆过的节点钉住，钉住上限 `PIN_YIELD = 420`）；拖拽中只免"手里那一格"、线的另一头照常受力（＝线上的拉力）；没有世界边界（`HOME_W/HOME_H` 只是初始落点区与 SVG 作图区），框外连线靠 `.assoc__lines { overflow: visible }`；宿主高度由 `src/ui/inspire.ts` 的 `fitAssocHeight()` 让开 sticky 工具条，滚动容器用 `scrollParent()` 现找 |
| `src/ui/editor.ts` | 编辑器（tiptap，左侧 sidebar 时间线/实体 tab，右侧文稿编辑）。属性面板**不在这个文件里**了 —— 见 `src/ui/props-panel.ts`。⭐ **左树跟硬盘上的文件夹一一对应**（2026-09-13，用户：「编辑器的树现在只能显示事件节点，其他结构体的文件夹没有在树里面」）：时间线页签 = 世界 → 时间线 → **种类** → 节点，种类列的是 **`store.data.formats` 的全部种类 ∪ 这条时间线实际用到的种类**（空的也列、`is-empty` 置灰、展开给一句「这个结构体还没有节点」）；每个世界的时间线之后还有 **`_设定` 分支**（实体；列出 `entityTypes` 的**全部类型**，空的同样置灰），类型下是实体行。⚠️ 在时间线页签点实体行必须**先 `setTab('entity')` 再 `selectEntity(id, world)`** —— 两个页签各记自己那份文档（`lastTarget`），就地换会把节点正文写进实体文件；`selectEntity` 里世界不同要先 `store.setActiveWorld`（树列的是**全部世界**的实体） |
| `src/ui/props-panel.ts` | **公共属性面板**（节点与实体共用**同一份**「改字段」实现，编辑器和设定库都调它）：`createPropsPanel({ store, host, status?, getTarget, patchTarget })` → `{ render(node, isEntity?), hide() }`；`PropsTarget` 是两边共用的身份联合类型。内含 AE 式 scrub（`createScrubField`）与历法推进的时间控件。⚠️ 面板构建后**刻意不重渲染**（避免销毁拖拽中的 scrub 控件），所以提交要走 `patchTarget`（从 store 取最新 properties 再合并） |
| `src/ui/ai-workbench.ts` / `roleplay.ts` / `tavern.ts` | AI 工作台 / 角色扮演 / 酒馆剧情推演 |
| `src/ui/map.ts` | 手绘矢量地图（区域 + 标记） |
| `src/ui/detail.ts` / `node-form.ts` | 节点详情 / 新建节点表单（详情面板里的「模板字段」区按节点种类渲染该种类的结构化字段，直接可填） |
| `src/ui/settings.ts` | 设置（AI 引擎 / 偏好项，存 localStorage） |
| `src/ui/eyedrop.ts` / `image-ext.ts` / `tag-ext.ts` | 吸管 / 编辑器图片扩展 / 标签扩展 |
| `src/ui/confirm.ts` | 确认 / 输入弹层（`confirmDialog` / `promptDialog`）。**不要用 `window.confirm`**：同步阻塞渲染进程（卡 tiptap 与 rAF），且无法用 tokens 配色 |
| `src/ui/trash.ts` | 回收站面板（`vault/.trash` 的列出 / 恢复 / 彻底清空；孤儿项需用户指定世界与格式） |
| `src/ui/backup.ts` | 备份管理面板（世界观数据 / 角色词库的备份列表、恢复、导出、导入）。恢复要走「禁写 → 覆盖 → 重载」，见 §4 落盘保护 |
| `src/ui/keys.ts` / `html.ts` | `isImeEnter(e)`（中文输入法回车守卫）/ `escapeHtml(s)`（外部文本进 innerHTML 前必过） |
| `src/ui/alert.ts` | **壳级横幅**（`#lk-alerts` 通栏，`showShellAlert`/`removeShellAlert`/`hasShellAlert`）：放「必须被看见、且要用户做选择」的状态（数据文件判损、自动保存已暂停）。与编辑器内部的 `addHint` 不同 —— 那条活在编辑器工具里、切走就没了，这条挂壳上，任何工具下都在 |
| `src/ui/schema.ts` | **结构体管理**面板（两个分区：**节点种类** / **实体类型**）。保存 → 节点种类写 `formats`（`formats.json`）或实体类型写 `worldsets[active].entityTypes` → 派发 `lingkuang-formats-changed`，由 `src/main.ts` 的 `ensureAllFormatFields` / `ensureEntityLayer` 补空值、清模板外的字段 |
| `src/ui/motion.ts` | **动效层**（`enter(el, cls='lk-enter')` 重放入场 / `staggerIn(container)` 常驻错峰（页签栏）/ `cascadeIn(container, step, maxDelay, start)` 一次性错峰（工具打开、换页签、换条目）/ `stopCascade(container)` 取消一次性错峰（"这次不许播"的分支要显式调）/ `childHeights(container)` + `smoothHeights(container, before)` 高度平滑（重排类）/ `motionReduced()`）：keyframes 在 `src/style.css` 末尾「动效层」一节，时长走 `--motion-*` 令牌。⚠️ 只挂**显式切换**（切工具/开面板/换页签/弹窗），别挂 store 订阅触发的重渲染；⚠️ **不给整块容器挂**（会"洗白一下"且盖掉元素错峰） |
| `src/ui/codex.ts` | **设定库 = 工作台**（合并方案 A 第 3 步）：左列「实体」/「时间线节点」双页签 + 搜索框（节点是 世界→时间线→种类→节点 四级树，搜索时摊平成列表）、中栏档案字段、右栏正文编辑器。节点中栏用 `src/ui/props-panel.ts`（与编辑器同一份）、实体用 `src/ui/fields.ts`、正文用 `src/ui/doc-editor.ts`。⚠️ 换条目必须走 `switchTarget()`（先 flush 再改选择）。⭐ **同页签内换条目走「就地换内容」**（`swapBody()`，2026-09-13）：保住骨架，只换「名字/类型 + 字段行 + 正文」，内容区（`#cx-body`）播一次 `.lk-swap-in` 轻淡入 —— 整块 `render()` 会把左列错峰重播一遍、**把滚动位置打回顶部**（`#cx-root` 就是滚动容器）、还把 tiptap 销毁重建（用户描述为「点击实体会刷新界面」）。换页签/换世界/条目删空才整块重建。⭐ 编辑器的写回目标是**读时取值**的模块级 `docTarget`（编辑器跨条目复用），安全性由 `switchTarget` 的顺序保证：先 flush（旧目标）再改 `docTarget`。⚠️ store 订阅**按 `bodySignature()` 决定要不要重建**中/右栏 —— 无条件 `render()` 会 dispose 掉 tiptap，而「自动落盘 → vault 回扫」每次编辑后约 360ms 就会走一趟订阅，实测每换一次 DOM 就有丢击键/焦点/IME 的风险（第十八轮） |
| `src/ui/fields.ts` | 模板字段控件的**公共渲染**（`fieldRow(field, value, onChange, labelWidth)` / `parseFieldInput` / `formatFieldValue`），按模板声明的类型决定形态。约定：只在 `change`（失焦/回车）提交 |
| `src/ui/doc-editor.ts` | 极简文稿编辑器（tiptap，与 `editor.ts` 同一套扩展）：`createDocEditor(el, onFlush)` → `{ setDoc, getDoc, flush, dispose }`。⚠️ 切条目必须 flush 再 dispose；⭐ 但**同页签内换条目**（codex）刻意**不 dispose**：`setDoc(md)` 换文档、实例留着，省掉"正文区先空一帧"（`setDoc` 会同步 `last`，所以换文档本身不会触发一次多余的写回） |
| `src/store/entities.ts` | 实体层基础：`BUILTIN_ENTITY_TYPES`（角色/地点/物品/组织/种族）、`ensureEntityTypes`（世界没有类型时**播种一次**）、`ensureEntityFields`（按类型补字段）、`entityTypeOf` |
| `src/store/evolution.ts` | **演变（实体版本历史）的纯逻辑**，不碰 DOM / store：`docDiff(prev, next)` / `applyDoc(prev, patch)`（正文**按行**存差异，`hunks[].at` = 上一版行号、从大到小排、从后往前应用）、`frameDiff(prev, next)`（没变化返回 `null`，不产生空帧）/ `applyPatch(st, patch)`、**`statesOf(e)` 一次算出全部前缀**（初稿 + 每一帧之后的样子；换版本 = 换个下标取数组，O(1)）、`epochOfNodes(ws)`（节点 → epoch，按世界算一次年表）、`normalizeFrames(e, epochOf)`（按锚点时间排序 + 一个节点只留一帧，**就地**整理）、`nearestVersion` / `versionAtNode`（站哪个节点看哪一版）、`patchSummary` / `isEmptyPatch` |
| `src/ui/evolution-rail.ts` | 设定库右侧那条**等距竖线**（用户 2026-09-13）：一格 = 世界里一个事件节点（所有时间线合起来按时间排，顶上第一格是初稿），每格 46px 固定高（`flex: 0 0 46px` + `min/max-height` 钉死 —— 高度不稳就不叫"等距"）、有帧的格子点亮并显示差异摘要。它**自己不写数据**，只通过 `onSelect` / `onAddFrame` / `onDeleteFrame` 回调 `codex.ts`。⚠️ 让选中格滚进视野时**只滚帧条自己的 `.lk-rail__rows`**（算 `offsetTop`），**不要用 `scrollIntoView()`** —— 它会把所有祖先滚动容器一起滚，而 `#cx-root` 正是面板的滚动容器（实测把面板 scrollTop 从 260 拽到 122，被 `codex-smooth-switch.cjs` ★6 抓住） |
| `data/worldbuilding.js` | 世界观种子数据（`window.__SEED_TIMELINES__`），首次运行/无用户数据时使用 |
| `data/character_lib.json` | 角色生成词库（58 分类，萌百来源 CC BY-NC-SA，勿商用） |
| `design-system/` | 设计令牌（`tokens.css` 权威颜色/字体源） |
| `docs/` | 架构 / 历法 / 编辑器对接 / 用户手册等文档 |

### 种类（模板）与节点 —— 「接口 / 实现」模型

用户 2026-09-12 的定位：**数据像接口一样，自带一套模版，然后自己设定内容**。落到代码上：

- **种类（kind）= 模板/接口**：定义「这个种类有哪些字段」。存在 `%APPDATA%\lingkuang\formats.json`
  （`main.js` 的 `DEFAULT_FORMATS` 是内建 5 个：角色/地点/物品/组织/事件；`formats:load/save` 读写）。
  字段类型：`text`（短文本）/ `longtext`（长文本）/ `number`（数值）/ `boolean`（开关）/ `list`（列表，值是数组）。
- **节点 = 模板的实现**：每个节点属于一个种类，字段值放在 `node.properties`。**节点属于哪个种类由它在
  vault 里的文件夹名承载** —— `vault:scan` 用 `n.kind = sub.name` 回填，`vault:write` 按 `kind` 建目录
  （因此改种类＝换文件夹，旧文件按 id 清掉）。
- **字段集合的权威 = 模板**：`src/main.ts` 的 `ensureAllFormatFields(store)` 会
  「给模板内的字段补空值（`number→0`/`boolean→false`/`list→[]`/其余 `''`）+ 删掉模板外的键」，
  启动时、外部改动后、以及模板变更事件后都会跑。所以**在灵框里增删字段是唯一正道，外部手改属性会被抹平**
  （`cssclasses`/`tags`/`aliases` 除外）。
- **给节点指定种类**：＋节点窗口的「种类」下拉（`src/ui/node-form.ts`）、编辑器属性面板的「种类」行
  （`src/ui/editor.ts`）。两处都走 `addNode`/`saveFixed`，最终落到 `node.kind`。
- **填字段值**：点沙盘上的节点 → 详情面板的「模板字段」区（`src/ui/detail.ts`，控件形态跟字段类型走：
  短文本 input / 长文本 textarea / 数值 number / 开关 checkbox / 列表用「、」分隔的 input）；
  或在编辑器的属性区填。两处写的是同一份 `node.properties`，都走 `store.update`（可撤销）。
  ⚠️ 这两个面板都是**每次 store 通知就整块重渲染**，所以字段控件只在 `change`（失焦/回车）时提交 ——
  用 `input` 边打边存会触发重渲染、把正在输入的框销毁。

### 实体（设定库）与实体类型

- **实体类型 `EntityType` = 模板**：定义这类实体该有哪些字段。存在**每个世界**的 `entityTypes`
  （跟着 `worldbuilding.json` 走，不走 IPC）。内建 5 个（角色/地点/物品/组织/种族）由
  `src/store/entities.ts` 的 `ensureEntityTypes` 在「这个世界还没有任何类型」时**播种一次**，
  之后完全由用户增删改。⚠️ 故意不做读取端兜底合并（`main.js` 的 `loadFormatsRaw` 踩过：
  内建种类在面板里删掉、下次读又冒出来）。
- **实体 `Entity` = 实现**：`properties` 是「**初稿**」（按类型模板填的结构化特征），`doc` 是正文（Markdown）。
  `frames: EntityFrame[]` 是「**演变**」—— 一串锚在时间线事件节点上的版本帧，**每帧只存与上一帧的区别**
  （字段用 `set`/`del`、正文用行级 `hunks`）。「某一刻的样子」= 初稿 + 按锚点时间叠加到那一帧为止的所有差异。
  完整方案见 `docs/ENTITY-EVOLUTION.md`；纯逻辑在 `src/store/evolution.ts`，界面在
  `src/ui/evolution-rail.ts`（右栏那条竖线）+ `src/ui/codex.ts`（看哪一版 / 改哪一版 / 写回那一版）。
- **模板分开存、面板统一管**：节点种类在 `formats`（应用级），实体类型在 `entityTypes`（世界级），
  但都由左栏「结构体管理」一个面板的两个分区编辑（两者数据结构同构 `{ id, name, fields[] }`，复用同一套 UI）。
- **补全时机**：`src/main.ts` 的 `ensureEntityLayer`（播种类型 + 按模板补字段）在启动时、以及任何
  `lingkuang-formats-changed` 事件后运行，与节点侧的 `ensureAllFormatFields` 并列。
- **看与改内容**：左栏「设定库」（`src/ui/codex.ts`）—— 类型筛选 + 列表 + 档案卡；
  编辑器实体页也能改（属性区按类型模板渲染，含「实体类型」行可换类型，换完派发模板变更事件补字段）。
- `buildPropCtrl(v, onChange, live?, declType?)` 的第 4 个参数是**模板声明的类型**：
  长文本用 textarea、列表即使当前是空值也走勾选列表那一支 —— 让编辑器与详情面板「按模板渲染」
  而不是「按值的 JS 类型猜」。

## 3. 数据模型

### 世界观（%APPDATA%\lingkuang\worldbuilding.json，经 IPC `data:load/save`）
```jsonc
{
  "worldsets": {                    // 世界观集合
    "示例世界观": {
      "timelines": {                // 时间线 id → 时间线
        "demo-world": {
          "id": "demo-world",
          "name": "示例世界·白石大陆",
          "absOffset": 0,           // 绝对纪元偏移
          "nodes": [                // 节点数组
            { "year": -800, "type": "event", "title": "上古之门开启", "desc": "...",
              "tag": "起源", "people": [], "places": [],
              "month": 1, "day": 1, "hour": 0 }   // 6 月起节点带年月日时分
            // type: world_event | story_event | loop-boundary
          ],
          "loops": [                // 多条循环
            { "id": "l1", "name": "轮回", "startId": "n3", "endId": "n5", "count": 3 }
          ],
          "storylines": [],          // 剧情线（聚焦范围）
          "calendar": null           // 可选：该线历法；空则默认公历
        }
      },
      "order": ["demo-world"],
      "docs": {},
      "maps": [],
      "entities": {},                // 实体（角色/物品等）
      "timeCursor": null
    }
  },
  "active": "示例世界观"
}
```
- 节点 `year` 存**该线历法下的原始年份**，`month/day/hour` 可选。
- 历法换算走 `src/calendar.ts` 的 `toEpoch/fromEpoch`（坐标轴统一公历 epoch 秒）。

## 4. 关键机制

### 历法（src/calendar.ts）
- `Calendar`（历法定义，`mode: function|table`，默认公历 `gregorian` 预设）
- `TimePoint`（时间点：`{anchor:{year}, values:{month,day,hour,minute,second}}`）
- `toEpoch(cal, tp)` / `fromEpoch(cal, epoch)`：历法 ↔ 绝对刻度的双向换算
- `buildYearTable`：年起点累积表，把 O(年数) 降到 O(1)
- `defaultCalendar()` = 现实公历（闰年/大小月精确）

### 坐标系统（src/ui/timeline.ts）
- `timeToX/xToTime` 出入**公历 epoch 秒**（内部用公历平均年宽 `SEC_PER_YEAR` 换算，spacing 为 px/年）
- 节点/指针/剧情框/循环定位走 `nodeEpoch`/`yearEpoch`（`toEpoch`）
- 标尺按缩放分档（年→月→日→时→分），日/月档按公历真实日期推进（尊重大小月，不固定步长漂移）
- 时间指针 `timeCursor` 存 epoch 秒
- **因果线（`drawCauses`）的坐标基准取 `.tl-causes` 这个 SVG 自身的 rect**：它带 `top:34px` 偏移，
  SVG 用户坐标原点在它自己左上角；别拿 `.tl-wrap` 的 rect 再加手调常数（曾用 `-26` / `-5`，
  导致端点恒偏低 3px、并向内钻 5px 进圆点里，看起来"没对准"）。端点取 `.cap` 的实测半径
  （现取，不硬编码 7）并**沿弧线自身到达方向（θ≈32°）贴到圆周上**，而不是取水平极点——
  两个节点都在轴线上，取极点会让尖端正好压在轴线上，看起来像"连在线上"而不是连在节点上；
  沿切线贴边后尖端比圆心高 `r·sinθ ≈ 3.7px`，明显离开轴线。弧高按跨距成比例
  （`cdy/cdx` 为常数 → 末端切线角度与跨距无关），上限取画布高度一半。
  `.tl-causes` 未给宽高属性 → 它是 SVG 固有尺寸 300×150（`right`/`bottom` 被忽略），
  只靠 `overflow:visible` 正常显示，坐标映射不受影响。

### 数据处理（src/store/）
- `store.ts`：`createStore` + `subscribe`，`update(cb, opts)` 统一改数据
- `actions.ts`：`addNode` / `addTimeline` / `setTimeCursor` 等，视图不直接碰 data
- 持久化经 `main.js` IPC（`%APPDATA%\lingkuang\worldbuilding.json`；`LINGKUANG_TEST_DATA` 覆盖测试路径）
- **落盘保护（别退回去）**：写前把现有文件轮换到 `.backup-0/1/2.json`；若文件**存在但
  `JSON.parse` 失败**，必须先逐字节另存为 `.bak-corrupt-<时间戳>.json` 再弹原生对话框，
  **绝不能让它演变成「空数据覆盖整个文件」**——旧行为实测：损坏后启动，不做任何操作，
  世界就被换成「新世界」，且 3 次保存内轮换会把最后一份原文件挤掉。
- **判损护栏（第十八轮，两层）**：
  ① **先重读再判损** —— 判损前重读 3 次、每次隔 200ms（`READ_ATTEMPTS`/`READ_RETRY_MS`）。
  单次读失败不足定罪：本应用自己的 `writeFileSync` 先截断再写，读者会看到中间态；而
  `preserveFile` 是 `copyFileSync`，拷的是**失败那次读之后**的磁盘现状（2026-08-23 那份 290KB
  的 `.bak-corrupt` 至今能正常解析，就是这么来的）。`data:load` 回传 `attempts`。
  ② **判损即上锁（`dataWriteLock`）** —— 锁挂在 **`writeDataFileSync()`** 里，那是 `data:save` 与
  `app:flush-sync` **唯一的共用写入口**，锁在这里两条路径同时失效。上锁后 `data:save` 回
  `{ok:false, locked:true}`、且**不轮换备份**；`backup:restore`/`backup:import` **不经**它
  （留给用户的救援通道）。出口两个，都是显式的：IPC `data:allow-write`（壳级横幅「继续用新数据」，
  解锁后派发 `lingkuang-force-save` 立刻落一次盘）、或从备份恢复。
  **读到一份能解析的文件 = 自动解锁**。
- **判损要在 UI 上说出来**：`loadData()` 不再吞 `ok:false`，把它作为 `corrupt` 回传，
  由 `src/ui/alert.ts` 的 `showShellAlert` 挂一条**壳级横幅**（`#lk-alerts`）。文案分两种：
  vault 兜住了（节点/实体在 `.md` 里没事，只是循环/剧情线/历法读不出来）vs vault 也空（界面是空的，别再动它）。
- **两个受管文件**：`worldbuilding.json`（世界观）与 `character_lib.json`（词库）走同一套
  备份/恢复基础设施（`main.js` 的 `BACKUP_TARGETS` + `preserveFile` / `rotateBackups` /
  `listBackups`，IPC `backup:list|create|restore|export|import`）。
- **恢复的闸门（删了就会静默回滚）**：恢复会替换磁盘上的数据文件，但内存 store 仍是旧数据。
  「备份管理」在 `backup:restore` 前派发 `lingkuang-restore-start`，`src/main.ts` 据此
  同时置 `suppressWrite`（停自动落盘）与 `restoreInProgress`（**跳过 beforeunload 的 flushSync**），
  然后 `location.reload()`。少任何一个，退出补写都会用旧数据把恢复结果盖回去。
- **语义边界**：节点正文在 vault 的 `.md` 里（**节点以文件为准**，见上），恢复 JSON 备份恢复的是
  时间线结构 / 循环 / 剧情线 / 地图 / 实体 / 历法 / 世界笔记 / 时间指针，不会增删节点。

### vault（Obsidian 文稿源，`main.js`）
- **`vault:watch` 先建根目录再监听**：vault 根不存在时**不能直接失败退出** —— 首次启动、或
  `LINGKUANG_VAULT` 指向还没建的目录时它必然不存在，而应用自己第一次保存就会把它建出来。
  曾经这里 `return {ok:false}` 而渲染层 `vaultWatch().catch(()=>{})` 接不住 `ok:false`
  ⇒ **整个会话没有监听**，外部改的 `.md` 一律不回扫且无提示（第十八轮修的既有 bug）。
  渲染层现在会对 `ok:false` 打 `console.warn`。
- **判「世界/时间线是否存在」看目录，不看节点数**：`scanWorldDir` / `scanTimelineDir` 收空时间线（`nodes: []`）。
  旧逻辑 `if (nodes.length)` 会让「删掉一条时间线里最后一个节点」导致整个世界从扫描结果里消失，
  而渲染层是 `d.worldsets = newData.worldsets` 整体替换 ⇒ 整体被冲掉并被写回 JSON（数据损失）。
- `VAULT_RESERVED = new Set(['.trash','assets'])` + `isReservedDir()`：保留目录不进扫描。
  必须挡 `assets`（编辑器导入图片放 `VAULT_DIR()/assets`，在 vault 根），否则它会被当成一个世界观。
- **删除 = `moveToTrash()`**（同盘 rename）到 `vault/.trash/`，`index.json` 记原相对路径与元数据
  （平铺文件 + 索引，兼容旧的无索引平铺文件）。`pruneTrashIndex()` 自愈。
- **恢复要同时回插 store**（`applyTrashRestore`，按 id 幂等、`{ undo:false }`）：只把文件移回 vault 的话，
  界面要等下次扫描才看得到，用户会认为恢复失败。
- frontmatter **不写 kind**（kind 由所在文件夹名承载，`vault:scan` 用 `sub.name` 回填）
  ⇒ 孤儿（回收站里路径信息缺失的项）恢复时必须由用户选格式，不能默认落 `事件/`。
- **实体（设定库）也写 vault 的 `.md`**：`<世界>/_设定/<类型>/<名字>.md`（`const ENTITY_DIR = '_设定'`）。
  实体不属于任何时间线（它们属于整个世界），所以走单独一趟 `scanEntityDir(wsDir)` → `{ 类型名: 实体[] }`，
  由 `vault:scan` 一并返回；`scanWorldDir` 跳过 `_设定`，它不会被当成一条时间线。
  frontmatter 存 `id/name/type` + 全部 `properties`，正文写在 `#正文：` 标签之后。
  - **`type` 由文件夹名承载**，与节点侧的 kind 同构：`mdToEntity` 读回 frontmatter 的 `type`，
    但 `scanEntityDir` 会用所在文件夹名覆盖它（重扫时文件夹才是权威）。
  - 节点与实体**共用 `parseFm(text)`**（frontmatter 解析只有一份，避免两处漂移）。
  - 换类型/改名后 `writeVaultEntitySync` 要清掉同 id 的旧 `.md`，否则旧文件会残留并被回扫捞回来
    （`mergeEntities` 按 id 去重是后扫到者赢，旧类型反而可能胜出 ⇒ **类型改不回去**）。
    规则与节点侧**同构**，见下面那条「同 id 只留一份」。
  - `src/main.ts` 的 `mergeEntities(byType, baseEntities)` 把扫描结果摊平成 `{ id: Entity }` 并带 `typeId`；
    **例外**：这个世界在 vault 里还没有 `_设定` 目录时保留 `base` 的实体，别把升级前 JSON-only 的实体整批抹掉。
  - **演变（版本历史）也在同一个 `.md` 里**：`entityToMd` 在正文之后追加 `#演变：` 段，
    内容是 ```json 围栏里的一串帧（`framesToMd` / `parseFrames`）。为什么不用 frontmatter：
    Obsidian 的属性面板只认扁平键值，嵌套数组既不好读也不好写回；围栏里的 JSON 能**原样往返**。
    ⚠️ `mdToEntity` 必须**先切掉 `#演变：` 段再做正文解析**（否则整段 JSON 会被当成正文的一部分）。
    ⚠️ **认不出来就原样保留**：段在、JSON 读不出来时打 `_framesBroken` + 存 `_framesRaw`，
    `entityToMd` 见到这两个标记就**照抄原文** —— 历史绝不能被一次解析失败写没。
    `frames` 在 `mergeEntities` 里是「**文件为源**」的：`.md` 没有这段就是没有帧（用户在 Obsidian 删掉应当生效）。
  - **启动时要补写一趟实体**（`writeAllEntities()`，在 `renderShell()` 之后、`vaultWatch()` 之前）：
    `writeAll` 只由 store 订阅触发，光靠它的话「升级前就存在的实体」要等用户碰一下才会变成文件。
    只写实体不写节点 —— 节点 `.md` 可能是手写手工排版的，每次启动回写会把它们整体归一化。

- **空时间线是纯 JSON 容器（第二十轮）**：vault 里「一条时间线 = 一个目录」，所以
  `vaultToWorldData` 按 vault 重建 `timelines` 时会丢掉**还没放节点**的时间线（它没有目录）——
  症状：新建一条时间线，重启或任何一次回扫后它从界面消失；而时间线级的 `absOffset` / `loops` /
  `storylines` / `calendar` **只有 JSON 一份**（重建时靠 `prev?.` 从 base 抄回来），随之一并消失，
  紧接着被 `writeAll` 写成永久丢失。**例外判据**（与实体那条同构，但**不能**只看"扫不到"）：
  `base` 里该时间线**本身就是 0 节点** ⇒ 保留（纯 JSON 容器）；`base` 里有节点却扫不到目录
  ⇒ 用户从外部删了整个目录 ⇒ 继续按「文件为源」丢掉（反过来会让外部删除"删不掉"、文件被写回来）。
  页签次序也改为以 `base.order` 为准（原来直接用 vault 的 readdir 顺序，重启后次序可能变，
  而且保留下来的空时间线必须留在原位）。

- **同 id 只留一份（第十九轮）**：节点的种类、实体的类型**都由文件夹名承载**，所以「换种类/换类型」
  在磁盘上 = 把 `.md` 搬到另一个文件夹，**旧文件夹那份必须删掉**。留着的话回扫是「后来者覆盖」
  （`scanTimelineDir` 的 `nodesById.set(n.id, n)`、`mergeEntities` 的 `out[e.id] = {...}`），
  readdir 顺序一合适旧文件就胜出 ⇒ 用户看到的是「我改的东西自己变回去了」。
  做法：**扫描期登记 `vaultFileIndex`（`世界\\u0000范围\\u0000id` → 扫描见过的该 id 的**全部**文件路径，
  含败者）**，写盘时按 id 一步删旧文件 —— 扫描本来就读了全部文件，登记零额外 I/O；
  而「写盘时扫目录比对」是 O(节点数²) 次读盘（`writeAll` 每次落盘遍历全部节点）：200 个节点实测
  2060 ms → **313 ms**。两层：① 索引（改名 / 换种类 / 同 id 两份全覆盖）；② 兜底 = 别的种类文件夹里
  「同名」那份（索引冷或过期时兜最常见形状，只 stat 不读内容）。
  ⚠️ 索引只是**线索**：`dropVaultFileIfSameId` 删之前一律再解析确认 id，且只删**当前 vault 根目录内**的文件
  （索引半张/过期/换 vault 都不会误删）；`vault:scan` 开头整张重建。
  ⚠️ 清理**挂在写盘上**（既有语义）：一份「输了」的残留要等这个节点下次被写才会消失。
- ⚠️ **测试前置必须给出确定起点**：`seed-node.cjs` 播节点前先清空这条时间线。
  同 id 两份并存时赢家随 readdir 顺序而变，断言会假挂（曾把「目录脏」误判成代码改坏 —— 见第十九轮的 A/B）。

### 演变（实体版本历史：看哪一版 / 改哪一版 / 写回哪一版）

方案与存储格式见 `docs/ENTITY-EVOLUTION.md`；这里是**实现上的三条线**，改这块之前务必先读：

- **数据形状**：`entity.properties/doc/name/typeId` = **初稿**（第 0 版），`entity.frames[]` = 一串提交，
  每帧 `{ nodeId, world, tlId, note, at, patch }`，`patch` 只写**出现过的键**（`set` / `del` / `name` / `typeId` / `doc`）。
- **看哪一版**：`codex.ts` 的 `viewState()` = `statesOf(e)[entityVersion()]`。
  `entityVersion()` = `versionAtNode(e, epochOf, epochOf(railNode), railNode)` ——
  选中的节点自己有帧就是那一帧，否则是**它之前最近的一帧**（floor），一帧都没有就是初稿。
  中栏字段、名字/类型、正文**全部从这里取**，不再直接读实体身上的初稿。
- **改哪一版 = 落点策略**（`editVersion()`，用户 2026-09-13 把三种模式放进设置）：
  **手动**（默认）不新开版本（改的是你现在看的那一版）；**自动**在"选中格还没有版本"时先开一个空帧；
  **锁定**永远落到 `settings.evolveLock` 指的那一帧。⚠️ 落点写在右栏底部小字上（`editHint`），不弹窗。
- **写回**：`commitState(v, next)` —— `v === 0` 直接改实体自己；`v ≥ 1` 改那一帧的 patch，而 patch 是
  **用前后两版重新算出来的**（`frameDiff(states[v-1], next)`），不做增量记账：改任何一版都只动那一帧，
  后面各帧的差异天然跟着重放。
- **默认落点**：换实体时 `ensureRailSelection()` 把选中格设成**离沙盘时间指针（`timeCursor`，epoch 秒）最近的那一帧**
  （用户指定），没有帧就是初稿。用 `nearestVersion(e, epochOf, cursor)`。
- **帧条只列"有版本的"事件**（用户 2026-09-13 上午：「我希望没有版本的节点就不显示」）：
  `evolution-rail.ts` 的 `rows()` = `allRows().filter(r => r.hasFrame)`；`allRows()` 仍返回全部节点，
  给底部那个「记到」下拉（`#cx-anchor`）出选项 —— **它是现在唯一的"新版本记在哪个事件上"入口**，
  因为帧条上再也点不到空格子。`railAnchor`（codex 里的模块级状态）由下拉与"点帧条某一行"共同维护，
  默认 = `nearestNodeId()`（离指针最近的事件）。
  ⚠️ 连带三条不能忘：① **自动模式落到 `railAnchor`**，不是"你现在看的那一版"；
  ② `patchVersion()` / `writeDoc()` 必须**先定"改哪一版"再取那一版的样子**（自动模式会新建一版并挪视图，
  先取 `viewState()` 会把旧版内容写进新版）；③ 删掉"当前正站着的"那一版之后，`railNode` 退到它的**前一版**
  （那一行已从帧条上消失，不退的话视图停在不存在的版本上）。
- **帧条可以"展开"没版本的事件**（用户 2026-09-13 下午：「能展开未创建 git 的节点，但虚化显示」+
  「那个展开其实就是【记到】后面的下拉选框，不过和时间线一起显示更直观」）：闭包状态 `showAll`，
  底部一行 `.lk-rail__more`（`data-rail-toggle`）切换；展开后没版本的事件**按时间插进时间线**、
  整格 `is-ghost`（`opacity:.4` + 空心点），当前「记到」那一格 `is-anchor` + 小药丸 `.lk-rail__tag`。
  **点虚化行 = 换「记到」（`deps.onAnchor`），不动正在看的版本**；点有版本的行才换版本（`deps.onSelect`）。
  ⚠️ 展开行**不要用 `.lk-rail__row`**（那一类 46px 钉死是"等距"承诺）；`showAll` 是闭包状态，
  面板重建（`render()`）会回到收起 —— 可接受，别为它引入全局状态。
- ⚠️ **回扫与写盘的竞态**（未修，机制最可能是"写盘在飞时来的扫描用旧快照覆盖内存"）：
  见 `docs/BUGS.md` 第二十一轮「七」，`entity-evolution.cjs` 约 2/10 次会因此挂 ★5 那组；
  动这块之前先读那一条，别把红灯当成本地回归。
- ⚠️ **面板高度预算**（用户 2026-09-13 上午：「默认创建了一个滚动条，去掉吧」）：`#cx-root` 是
  `height:100%` + `overflow:auto`，内容比窗口高**一个像素**就会长出滚动条。实测（1440×900、真实数据）
  只差 3px，来自"给一句空话预留的消息行 + 松掉的内边距/间距"。所以：`#cx-msg` 没消息时 `display:none`
  （`say()` 负责开关）；根内边距 14/12、块间距 8。**别再给这个面板加"常驻但没内容"的块** ——
  它就是那种 3px 的来源。守卫：`entity-evolution.cjs` ★0d 断言"外壳开销 ≤130px"
  （= 面板总高 − 三栏那一行；与正文长短、窗口大小都无关）。
- ⚠️ **物化缓存必须跟着 store 通知作废**：`states` 按实体 id 缓存，`store.subscribe` 里 `statesId = ''`
  —— 外部回扫可能换掉同一个实体 id 的帧/正文，不清缓存就会显示旧内容。
- ⚠️ **静默提交要能嵌套**：`withQuiet(fn)` 保存并恢复旧值（不是无脑置 `false`）——
  「写正文 → 提交某一版」是嵌套的，里层提前解除静默会让整块面板重建一次。
- ⚠️ 「正在看：初稿 / 第 N 版」那行（`#cx-vnote`）必须在**换条目（`swapBody`）与换版本**时都刷新 ——
  它属于骨架 HTML，只在 `render()` 里生成的话，切到另一条实体会显示上一条的版本（实测踩到）。

### 工具宿主（`src/tools/registry.ts` 的 `openTool`）
- 工具栏工具都是**模块级大视图**：点击 → `openTool(id, moduleView, store)` → 各工具用动态 import 渲染
  （`register.ts` 里每个 `open` 都是 `import('../ui/xxx').then((m) => m.renderXxx(host, store))`）。
- **左栏分两段**（用户 2026-09-12：「设置放到左侧栏最底下」）：工具的 `Tool.group` 决定它去哪一段 ——
  缺省 `'create'` = 创作工具（沙盘 / 灵感 / 编辑器 / AI / 设定库 / 素材库）在上段；
  `'manage'` = 低频管理项（结构体管理 / 回收站 / 备份管理 / **设置**）在下段并**贴着底部**
  （`src/style.css` 的 `.lk-tool-group.is-bottom { margin-top: auto }`，分隔线 `--chrome-2`）。
  ⚠️ **顺序归壳管、不靠注册顺序**：`src/ui/shell.ts` 的 `renderToolbar()` 按 `Tool.group` 过滤后再拼 DOM
  ⇒ 在 `register.ts` 里怎么排都不影响左栏长什么样（登记顺序只决定同组内的先后）。
  世界栏那排 `.lk-tool-btn`（`.lk-worldbar-tools`）用的是同一个类名但横向样式，不受分组影响。
  守卫：`tools/e2e/toolbar-groups.cjs`（两组 / 顺序 / 贴底 / 点最底下那个真的是设置）。
- **每个工具写进自己那一格**：`openTool` 在 `#lk-module-view` 里新建一个 `.lk-tool-slot` 并把它当 `host`
  交给工具；渲染完若仍是当前工具 → 保留这一格 + 挂块级错峰；若中途被切走 → 摘掉这一格 + 跑它的清理函数。
- ⚠️ **为什么不能让所有工具直接写 `#lk-module-view`**（实测出来的竞态，别退回去）：工具是「先渲染进
  host、再把清理函数交回来」，而且像 `src/ui/settings.ts` 那样**函数内部还有自己的一层异步渲染**。
  于是「打开 A → 立刻打开 B」时，慢的 A 完全可能在 B 渲染完之后才落地，把 B 盖掉：**工具栏亮着 B、
  主区却是 A**（实测：同一个同步块里连点 settings + codex，2.5 秒后主区仍停在 settings）。
  格子法把「写哪儿」钉在**打开那一刻** ⇒ 晚到多久都无害（它写的是已被摘掉的格子）。
- 布局：`.lk-tool-slot { height: 100% }`（`src/style.css`）—— 必须把「百分比高度撑得住」这条链传下去，
  否则工具根部写 `height: 100%` 会因为父元素高度 auto 塌成 0（`#lk-module-view` 是 `.lk-main` 的
  flex 项，高度确定）。工具对 host 自己的设置（如 `host.style.overflow = 'auto'`）现在落在格子上，
  语义与原来写在 `#lk-module-view` 上一致；`closest('.lk-module-view')` 这类查询依旧能穿过格子。
- 打开失败**不再静默**：`.catch` 里 `console.warn`（以前静默吞掉，"点了没反应"很难查）。

### 动效（`src/ui/motion.ts` + `src/style.css` 末尾「动效层」）
- 令牌：`--motion-fast 180ms`（hover / 选中变色，点一下要立刻有反馈）/ `--motion-base 320ms`（弹窗卡片）/
  `--motion-slow 640ms` / **`--motion-enter 640ms`（入场专用）** / `--ease-standard`。
  用户 2026-09-12 两次体感反馈（「稍微慢一点」→「算了直接再调慢一点」）⇒ 入场直接取 640ms
  ＝设计系统 slow 档＝`DESIGN.md:157` 的 Waking fade 自己的时长，不再自造中间值；错峰 **100ms/项**
  （`.lk-enter-stagger > *:nth-child(n)`，第 6 项封顶）。
  ⚠️ `src/style.css` **不 import tokens.css**，所以它自己那份令牌必须与设计系统同值 ——
  本轮之前是 fast `100ms` / base `160ms`（比设计系统快一倍，正落在 DESIGN.md:182 禁止的
  "snappy developer tool" 档），已对齐；降级块也在 style.css 里复写了一份。
- **三个 API**：
  · `enter(el, cls = 'lk-enter')` 重放一次入场（摘类 → 强制重排 → 加类；只加类不重播）；
  · `staggerIn(container)` = **常驻**错峰（类留在容器上）—— 延迟不在 JS 里算，而是 CSS 按子项序号给
    （`.lk-enter-stagger > *:nth-child(n)`）：工具是动态 import 的，子项常在调用之后才建出来，
    遍历当时不存在的元素注入不进去；按序号给则天然覆盖后插入的项。**只用于页签栏**这类
    「容器长期活着、子项随时被换掉」的地方。
  · `cascadeIn(container, step=100, maxDelay=500, start=0)` = **一次性**错峰（跑完自己摘类 + 清行内延迟）：
    用于「**这一次**渲染出来的这些块依次浮现」（工具打开 / 换页签 / 换条目）。类**必须**摘掉 ——
    否则工具下次重渲染（codex 是 `host.innerHTML = …` 整块重来）新建的子项会再播一遍＝改个字段闪一下。
    带 `.lk-own-cascade` 的子项会被**跳过**（见下面「块里面的元素」那条）。`maxDelay` 别太小：
    封顶太早会让后几项**同时**冒出来，看着又像整块（灵感触发器 13 张卡用的是 step 50 / 封顶 720）。
    ⚠️ **没有盒子的子项（`display:none`）同样跳过**（`getClientRects().length === 0`）：
    `cascadeIn` 靠"**最后一块**的 `animationend`"收手，而 `display:none` 的元素永远不会播动画
    ⇒ 它要是恰好排在最后（设定库的 `#cx-msg` 就是），整组错峰只能等 `maxDelay + 2000ms` 兜底
    才摘类（`motion-switch` ★6 当场抓到：`{cls:true, anims:3}`）。判据与 `.lk-own-cascade` 同理：
    "不会播动画的子项，既不给它写延迟，也别让它当最后一块"。
- ⚠️ **整块容器不许播动画**（用户 2026-09-12 反馈「切换工具时会闪黑一下」的真因）：抓帧实测，
  点工具后第一帧"里面内容已全部就位、只是整块发灰"（`#lk-module-view` 在低不透明度上），
  而且整块淡入把每个元素自己的错峰**完全盖住**。⇒ `openTool` 不再 `enter(host)`、回沙盘也不再
  整块 `lk-fade-in`；改成容器保持不透明、由**工具根部的顶层块**依次浮现。
- **挂点**：切工具/开面板 = `src/tools/registry.ts` 的 `openTool()`（唯一入口，覆盖工具栏点击与快捷键；
  渲染完给 `cascadeIn` 挂块级错峰 —— 工具是动态 import 的，同步/异步两条路径都要挂）；
  回沙盘 = `src/ui/shell.ts`（**不播动画**，只切显示）；时间线/世界页签 = `src/ui/shell.ts`（`staggerIn`，
  签名没变就早退，拖动不会重放）；弹窗 = `src/ui/confirm.ts`（遮罩 `--motion-fast` + 卡片 `--motion-base`，
  **只入场不退场**：退场要等 animationend 才能 resolve，破坏性操作的 Promise 不该为观感延迟）；
  设定库换页签 = `src/ui/codex.ts`（`pendingEnter` 标志：只有显式切换播，store 订阅触发的
  重建不播，否则改一个字段整块淡入一次；两级 `cascadeIn`：顶层块 0/100/200/300 + 左列条目 200ms 起逐条 60ms）；
  ⭐ **设定库换条目 = 不重建骨架**（2026-09-13，见 `src/ui/codex.ts` 的 `swapBody()`）：
  同一页签内换条目只换「名字/类型 + 字段行 + 正文」，中/右栏那块容器 `#cx-body` 播
  `.lk-swap-in`（`@keyframes lk-swap`：`opacity .5 → 1`，`--motion-base`）。
  **不从 0 起淡、也不加 transform**：从 0 出来就是"闪一下白"（就是本节开头那个被否掉的整块淡入），
  而 transform 会让套着 contenteditable 的那块成为 fixed 的包含块、还会让过渡期的光标位置跟着位移。
  换页签（中栏结构真的变了）仍走整块重建 + 错峰；
  **灵感触发器卡片** = `src/ui/inspire.ts` 的 `renderChar(combo, animate)` 末尾
  `if (animate) cascadeIn(result, 50, 720, 120); else stopCascade(result);`
  （`#insp-result` 是卡片网格，13 张卡排 `120…720ms` 阶梯；**只有初次进入**（`renderChar(null, true)`）
  播，「重新生成」与加载组合**不播** —— 用户 2026-09-12 二次要求「重新生成改成无错分的，
  只有初次进入时才有错分」：那两种是"我要立刻看新词"，排队只会碍事。非动画分支必须显式调
  `stopCascade`，理由见下面「`stopCascade`」那条）；
  锁定与改词条数按既有设计不重建卡片，故也不播。
  详情面板 = `src/ui/detail.ts`（只在首次 `renderView`）；新建节点表单 = `src/ui/node-form.ts`；
  壳级横幅 = `src/ui/alert.ts`。
- ⚠️ **纪律**：入场动画只挂显式切换 —— `src/ui/timeline.ts` 每次 store 通知都整体重渲染，
  给它挂「挂载即动画」会在拖动节点时不停重放（`docs/ROADMAP.md` 的硬约束）。
- ⚠️ **块里面的元素要自己再挂一级**（用户 2026-09-12：「卡片也是一样的，错分入场」）：工具根部的
  顶层错峰**盖不到块内部的元素**（卡片 / 列表项在块里面）。做法与「整块容器不许播」同源：
  让那个内部容器带 **`.lk-own-cascade`** ⇒ 父级不给它整块淡入，由它自己的 `cascadeIn` 给子项排阶梯。
  两侧都要有：CSS 的 `.lk-enter-stagger > .lk-own-cascade { animation: none }` 才是压住动画的那条；
  `cascadeIn` 里把它从 `kids` 滤掉只是为了不写无用的行内延迟、也不让它当"最后一块"
  （它没有动画，`animationend` 永远不来）。**被跳过的子项不占序号**（父级延迟仍是 0 / 100）。
- ⚠️ **`cascadeIn` 的两个坑（都实测踩过）**：
  ① 它写的是**行内** `animation-delay`，行内值优先级**高过媒体查询** ⇒ 必须在函数里自己读
     `motionReduced()` 把延迟清零，只靠 CSS 的降级块压不住（`DESIGN.md:159` 要求减少动效下错峰归零）。
  ② `animationend` **会冒泡** ⇒ 收手监听器必须认 `e.target === 最后一块`，且不能用 `{ once: true }`
     （冒泡事件会把它消耗掉）。不认的话，一个早早结束的后代动画就会把整组错峰提前收掉。
- **`stopCascade(container)`** = 取消一次性错峰（摘类 + 清子项行内延迟），`cascadeIn` 自己收手时也走它。
  存在的理由：错峰类要等**最后一块**的 `animationend`（或 `maxDelay + 2000ms` 兜底）才摘，
  在它挂着的这段时间里重渲染同一个容器（灵感触发器「重新生成」重建 13 张卡），新子项会从父类
  继承 `.lk-enter-stagger > *` 的 nth-child 延迟 ⇒ **又错峰一遍**，"不该播的那一次"照样播了。
  ⇒ 凡是「同一个容器有时要播、有时不许播」的挂点，**不播的分支必须显式 `stopCascade`**，
  结果才与点击时刻无关。
- **高度平滑（重排类）**：`childHeights(container)` 量旧高度 → 重建 DOM → `smoothHeights(container, before)`
  从旧高度过渡到新高度。这是**两步 API**（旧高度只在改 DOM 之前量得到），CSS 侧配 `.lk-h-smooth`
  （`transition: height var(--motion-base) var(--ease-standard)` + `overflow: hidden`）。
  为什么 CSS 自己做不到：**`height: auto` 过渡不了** —— 内容驱动的变化不改 specified value，
  浏览器不会启动过渡；所以必须量出 px、临时写死、跑完再还回 `auto`。
  网格行高与外层容器高度都是跟着子项算出来的，子项平滑变高变矮时它们自然一起平滑。
  与入场那套的分工：`cascadeIn` 动的是 opacity（新元素浮现），`smoothHeights` 动的是 height
  （元素还在，只是变高矮并挤开下面的）。减少动效时**整段跳过**（`motionReduced()`），高度直接落位。
  首个用户 = 灵感触发器卡片（`src/ui/inspire.ts` 的 `renderChar`）：
  词条数随机 ⇒ 卡片高度只有 80/104/128/152 四档，实测卡片区**同一个 tick 内** 430 → 646px。
- Anime.js（`animejs@4.5.0`，devDependency）已装但**尚未使用**：它留给「元素被重建、却要从旧位置
  连续滑到新位置」的场景（画布节点移动 / 列表增删让位），那是 CSS transition 表达不了的
  （重建后的元素没有"旧位置"这个概念）。

### 联想画布（`src/ui/assoc.ts` + 宿主 `src/ui/inspire.ts`）
- **无限画布**（用户 2026-09-12：「现在有边界了，向上拖不动节点了，我想要无限画布」）：
  **没有任何世界边界** —— 拖节点不夹、力导向不夹、视窗平移不夹（只夹缩放 0.4~3）。
  两个常量 `HOME_W = 2000` / `HOME_H = 1200` 现在只剩两个用途：**新节点的初始落点参考区**
  与**连线 SVG 的作图原点 + viewBox**（早先叫 `WORLD_W/WORLD_H`，那名字会让人以为是边界，已改名）。
  视窗可以飘到很远 ⇒ 安全绳是画布里的「回到节点群」按钮（`updateViewportHelp` 在节点全出屏时显示、
  `recenterToNodes` 把质心平移回画布中心）。
- ⚠️ **手动摆过的节点被钉住**：`applyDrag` 里 `(dn as any)._pinned = true`，`forceStep` 的积分循环里
  `if ((n as any)._pinned) { n.vx = 0; n.vy = 0; return; }` —— 钉住的节点仍参与斥力/弹簧计算
  （推开别人、把子节点拉过来），只是自己不动。**为什么需要**：实测只撤边界的话，往正上方拖 300px、
  松手后 2 秒内被弹簧拽回 **217px** 并继续荡，用户看到的还是"拖了又弹回去"。
  钉标记会随 `assocSetRoot`（按根词重建）自然清掉。
- ⭐ **钉住有上限 `PIN_YIELD = 420`**（用户 2026-09-13：「拉太远时拉力会失效」）：
  弹簧循环里 `if (!aIn && d > PIN_YIELD) (a as any)._pinned = false;`（两端各判一次）——
  「钉住是别乱动，不是焊死」。没有它的话，**两端都被手工摆过**时线被拉多长都回不来
  （A/B 实测间距 `4477 → 4477`，就是用户说的"拉力失效"）。420 ≈ 静止长度 140 的 3 倍，小范围摆位不受影响。
- ⭐ **拖拽中"手里那一格"只免它自己**（同一条用户反馈的另一半，也是主因）：
  `forceStep` 里用 `const inHand = (id) => dragGroup !== null && dragGroup.has(id);`，
  跨边界的斥力/弹簧改成「**谁不在手里谁受力**」（`if (!aIn) { a.vx += fx; … }`），
  只有两端都在手里（拖整棵子树）时才整对跳过（组形不变）。
  **旧写法 `if (dragGroup && (has(a) !== has(b))) continue;` 把线的另一头也一起免了** ⇒
  拖一个词的全程相连的词纹丝不动（A/B：拖 144px 时根词位移 1px、线从 148 拉成 291），
  松手才追过来 —— 用户看到的就是「线没断，但线上没有力」。
  守卫：`tools/e2e/assoc-pull.cjs`（★1 把节点往"离开根"的方向拖，要求间距不许被拉长）。
  ⚠️ 力本身**不是**数据溢出：`(d-140)*0.05` 随距离线性增长、1e6 px 时 10998/帧、全程有限，
  ★4 把节点丢到 40 万像素外专门验证不出 NaN/Infinity。
- ⚠️ **框外的连线靠 CSS 才画得出来**：连线层是 `2000×1200` 的 SVG（`viewBox: 0 0 2000 1200`），
  而 SVG 根元素**默认把内容裁到自己的视口** ⇒ 节点跑到框外时线整段消失（节点还在）。
  `src/style.css` 的 `.assoc__lines { overflow: visible }` 是这条的全部依据，删了它框外的线就没了
  （`tools/e2e/assoc-canvas.cjs` ★9 用"故意画在框外的 path + `elementFromPoint` 命中/A-B"守着）。
- 世界坐标固定 `HOME_W × HOME_H` 作为**原点区**；`#assoc-stage`（`flex:1; overflow:hidden`）
  里放 `#assoc-world`（`transform-origin: 0 0`），视窗靠
  `world.style.transform = translate(assocPanX, assocPanY) scale(assocZoom)` —— 即
  **节点屏幕坐标 = 世界坐标 × zoom + pan**（世界坐标可以为负、可以离原点很远）。
- ⚠️ **拖拽算式必须扣掉 pan**（否则视窗一动节点就漂）：
  `dx = cx - dragSX - (assocPanX - dragPanX0)`（`applyDrag(cx, cy)`）。
  `dragPanX0/dragPanY0` = **按下那一刻**的 pan，`dragSX/dragSY` = 按下点。
- **贴边自动推视窗**：`edgePush(pos, lo, hi)` 在离边缘 `PAN_EDGE = 56` 内返回 ±1 推力；
  `ensureAutoPan()` 起 rAF、`autoPanTick()` 每帧把 pan 推 `PAN_MAX_V = 18` px；
  `stopAutoPan()` 挂在 `endPointerGestures()` 与卸载清理上（松手/切工具/卸载都要停）。
  没有边界 ⇒ 指针还在边上就一直推（旧版有 `clampPanToWorld()`，已随无限画布删掉）。
- ⚠️ **滚动容器不能写死**：真正会滚的是工具格 `.lk-tool-slot`（`overflow: auto`），而
  `#lk-module-view` 自己 `scrollHeight === clientHeight` **根本不会滚**。画布上的滚轮分支要用
  模块级 `scrollParent(el)`（沿祖先链找第一个 `overflowY` 为 auto/scroll 且 `scrollHeight > clientHeight`
  的祖先），写死 `closest('.lk-module-view')` 会让"鼠标停在画布上滚滚轮毫无反应"。
- ⚠️ **画布高度要避开 sticky 工具条**（用户 2026-09-12：「节点会被一块地方挡住，看不全」）：
  灵感触发器里那条输入行是 `position: sticky`（实测占 `top 8 … bottom 62`），而画布是页面最后一块 ⇒
  写死 `height: 100vh` 会让画布顶部 54px 永远压在工具条底下。宿主 `src/ui/inspire.ts` 的
  `fitAssocHeight()` 量 `need = 工具条底边 − 画布容器顶边`，再让 `#insp-assoc` 用
  `calc(100vh − <need>px)`；挂 `ResizeObserver` 盯那条工具条 + `window resize`，清理函数里 `disconnect`。
  兜底 CSS 写 `calc(100vh - 62px)`（JS 跑之前的首帧不能是错的）。
  守卫：`tools/e2e/assoc-canvas.cjs`（★1 还要求画布顶部那一圈 `elementFromPoint` 归画布而不是工具条）。
- 测试注意：测试实例 `showInactive` ⇒ 窗口 `hidden` ⇒ **rAF 不出帧不推进**，断言"自动推视窗"前
  必须 `forceFrames()`（`Page.captureScreenshot`）；指针事件用合成的 `PointerEvent`，
  `pointerdown` 打在**节点元素**上（stage 靠冒泡收），`pointermove/pointerup` 打在 `window` 上。
  两套守卫：`tools/e2e/assoc-canvas.cjs`（几何/无限/框外连线）、
  `tools/e2e/assoc-pull.cjs`（拉力：拖拽全程、近处钉住、拉太远收线、极远处不出 NaN；
  它把 `window.fetch` 换成固定 5 个词，保证"根 + 5 子词"的图确定复现）。

## 5. 脚手架

- **TypeScript**（`tsconfig.json`，strict + noUnusedLocals/noUnusedParameters）
- **Vite**：`vite build`；`npm start` = build + electron
- **打包**：`npm run dist`（= `vite build` + electron-builder，NSIS 安装版 + portable）
  - 渲染层产物在 **`app-dist/`**，不是 `dist/`：electron-builder 会把自己 `directories.output`
    从 app files 里强制排除，两者同名时渲染层**永远进不了包**（曾因此打出必然白屏的安装包）。
    `main.js` 的 `win.loadFile` 指向 `app-dist/index.html`，`build.files` 必须含 `app-dist/**/*`。
  - **改完代码要先 `vite build` 再启动**（桌面快捷方式直接跑 `electron .`，不会自己构建）。
- **语法检查**：`node --check <file>.js`；TS 由 `tsc` 走 strict
