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
| `main.js` | Electron 主进程。IPC：`data:load/save`（世界观）、`settings`、`lib`（词库）、`ai:associate`（联想）、`ai:classify`（词分类）、`aiChat()`（双模式 LLM 调用）、`vault:*`（Obsidian 文稿） |
| `preload.js` | contextBridge 安全桥，暴露 `window.lingkuangAPI` |
| `index.html` | Vite 入口（`<div id="app">` + `<script src="/src/main.ts">`） |
| `mcp-server.js` | MCP 服务器（`query_timeline` / `query_node` / `search_world` / `query_loop`） |
| `src/main.ts` | 渲染进程入口，创建 store → 渲染 shell |
| `src/calendar.ts` | **历法系统**：可编辑历法模型（`Calendar`/`TimePoint`/`toEpoch`/`fromEpoch`），默认公历 |
| `src/store/` | 数据层：`store.ts`（单一数据源 + 订阅）、`actions.ts`（修改入口）、`types.ts`（领域类型） |
| `src/tools/` | `registry.ts`（工具栏工具注册表）+ `register.ts`（工具定义） |
| `src/ui/shell.ts` | 壳 UI：世界栏 + 工具栏 + 沙盘 + 工具宿主 |
| `src/ui/timeline.ts` | 世界沙盘时间线（坐标 epoch 秒、标尺分级、循环、剧情线、时间指针） |
| `src/ui/inspire.ts` | 灵感触发器（随机角色生成 + 词义联想入口） |
| `src/ui/assoc.ts` | 词义联想无限画布（力导向 + 单线聚焦） |
| `src/ui/editor.ts` | 编辑器（tiptap，左侧 sidebar 时间线/实体 tab，右侧文稿编辑） |
| `src/ui/ai-workbench.ts` / `roleplay.ts` / `tavern.ts` | AI 工作台 / 角色扮演 / 酒馆剧情推演 |
| `src/ui/map.ts` | 手绘矢量地图（区域 + 标记） |
| `src/ui/detail.ts` / `node-form.ts` | 节点详情 / 新建节点表单 |
| `src/ui/settings.ts` | 设置（AI 引擎 / 偏好项，存 localStorage） |
| `src/ui/eyedrop.ts` / `image-ext.ts` / `tag-ext.ts` | 吸管 / 编辑器图片扩展 / 标签扩展 |
| `data/worldbuilding.js` | 世界观种子数据（`window.__SEED_TIMELINES__`），首次运行/无用户数据时使用 |
| `data/character_lib.json` | 角色生成词库（58 分类，萌百来源 CC BY-NC-SA，勿商用） |
| `design-system/` | 设计令牌（`tokens.css` 权威颜色/字体源） |
| `docs/` | 架构 / 历法 / 编辑器对接 / 用户手册等文档 |

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

### 数据处理（src/store/）
- `store.ts`：`createStore` + `subscribe`，`update(cb, opts)` 统一改数据
- `actions.ts`：`addNode` / `addTimeline` / `setTimeCursor` 等，视图不直接碰 data
- 持久化经 `main.js` IPC（`%APPDATA%\lingkuang\worldbuilding.json`；`LINGKUANG_TEST_DATA` 覆盖测试路径）

## 5. 脚手架

- **TypeScript**（`tsconfig.json`，strict + noUnusedLocals/noUnusedParameters）
- **Vite**：`vite build`；`npm start` = build + electron
- **打包**：`npm run dist`（electron-builder，NSIS 安装版 + portable）
- **语法检查**：`node --check <file>.js`；TS 由 `tsc` 走 strict
