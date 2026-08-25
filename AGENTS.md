# AGENTS.md — AI 编程助手约定

> 本文件供 AI 编程工具（Claude Code / Cursor / Codex 等）自动读取。
> **动手改代码前先读 `docs/ARCHITECTURE.md`（完整代码地图）。**

## 项目

灵框 LingKuang：世界观创作工作台（Electron + Vite + TypeScript 模块化）。世界沙盘时间线 / 随机角色生成 / 词义联想图 / Markdown 编辑器 / AI 工作台。

- 运行：`npm start`（= `vite build` + `electron .`）；开发 `npm run dev`（Vite）
- 打包：`npm run dist`（electron-builder，NSIS 安装版 + portable，输出 dist/）
- 数据：`%APPDATA%\lingkuang\`（不写项目目录；测试用 `LINGKUANG_TEST_DATA` 覆盖）
- 语法/类型：TS 走 `tsc --noEmit`（strict + noUnusedLocals）；JS 走 `node --check`

## 文件职责

- `main.js`：Electron 主进程（IPC：数据/设置/词库/AI 联想与分类/vault）
- `preload.js`：contextBridge 安全桥
- `src/main.ts`：渲染进程入口（Vite）
- `src/calendar.ts`：**历法系统**（`Calendar`/`toEpoch`/`fromEpoch`/`buildYearTable`，默认公历）
- `src/store/`：数据层（`store.ts` 单一数据源 + 订阅、`actions.ts` 修改入口、`types.ts` 领域类型）
- `src/tools/`：工具栏工具注册（`registry.ts` + `register.ts`）
- `src/ui/shell.ts`：壳 UI（世界栏 + 工具栏 + 沙盘 + 工具宿主）
- `src/ui/timeline.ts`：**世界沙盘时间线**（坐标 epoch 秒、标尺分级、循环、剧情线、时间指针）
- `src/ui/inspire.ts` / `assoc.ts` / `editor.ts` / `map.ts` / `ai-workbench.ts` / `roleplay.ts` / `tavern.ts` / `settings.ts` / `detail.ts` / `node-form.ts`
- `src/ui/eyedrop.ts` / `image-ext.ts` / `tag-ext.ts`：吸管 / 编辑器图片 / 标签扩展
- `data/worldbuilding.js`：种子世界观；`data/character_lib.json`：角色词库（萌百来源 CC BY-NC-SA，勿商用）

## 测试后门

- 环境变量 `LINGKUANG_TEST_DATA=<文件路径>` → 数据读写走该文件，不碰 `%APPDATA%\lingkuang\worldbuilding.json`

## 风格约定

- **界面不用 emoji**；**文字/强调避免黄色系**（对比度低，文字用 `--fg`、强调用 `--accent`）
- 颜色只用 `design-system/tokens.css` 变量（暖灰底/荧光绿/深 chrome）
- 新功能尽量加在 `src/ui/` 对应模块或 `src/tools/` 注册，不堆进单一文件
- **⭐ 需求协作规范（2026-08-22 用户明确）**：用户会讲「目的与实现」。**先抓住目的**（这个功能为什么存在、解决什么痛点），再谈实现细节。用户只讲实现/没讲清目的时，**主动提醒用户补充目的**，不猜着改。参考教训：联想图"聚焦"反复改 N 版都错，因为没先理解目的是"多分支探索 + 视觉降噪"——按目的设计立刻对。

## ⚠️ 关键坑（改这些逻辑前必读 ARCHITECTURE）

1. **历法换算用 `toEpoch/fromEpoch`**，不要硬编码年宽；标尺日/月档**按公历真实日期推进**（尊重大小月/闰年），不用固定步长累加（否则跨月漂移）。
2. **`timeCursor` 存 epoch 秒**，节点 `year` 存历法下的原始年份（`month/day/hour` 可选）——两者别混。
3. **坐标轴统一公历 epoch 秒**（`timeToX/xToTime` 出入 epoch 秒）；`buildYearTable` 降到 O(1)，换算记得传 `getYearTable()`，否则 O(年数) 卡顿。
4. **store 单一数据源**：视图不直接改 `data`，走 `store.update` / `actions`。
5. **编辑器是 tiptap**；Obsidian 式 `#字段：值` 行 + frontmatter，方法见 `docs/EDITOR-SANDBOX-BRIDGE.md`。

## 文档

- `docs/ARCHITECTURE.md` — 代码地图（改代码前必读）
- `docs/CALENDAR.md` — 历法系统设计
- `docs/EDITOR-SANDBOX-BRIDGE.md` — 编辑器 ↔ 世界沙盘对接
- `docs/BUGS.md` — 已知 bug（修完打勾 + commit 注明）
- `docs/ROADMAP.md` — 功能路线图
- `docs/USER_GUIDE.md` — 用户操作手册
- `LICENSE` GPL-3.0；词库 CC BY-NC-SA（与代码分离）
