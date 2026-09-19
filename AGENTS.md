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
- `src/store/`：数据层（`store.ts` 单一数据源 + 订阅、`actions.ts` 修改入口、`types.ts` 领域类型、`ids.ts` **id 生成** —— 一切 id 走 `uid(prefix)`，**不许手写 `'x' + Date.now()`**：同一毫秒里连建多个会撞 id、后建的把先建的覆盖掉）
- `src/tools/`：工具栏工具注册（`registry.ts` + `register.ts`）
- `src/ui/shell.ts`：壳 UI（世界栏 + 工具栏 + 沙盘 + 工具宿主）
- `src/ui/session.ts`：**会话状态**（进入灵框时回到上次关闭时的样子：世界/时间线 + 上次打开的工具 + 设定库正在编的那一条；存 localStorage `lingkuang-session`，**不写数据文件**，见 ARCHITECTURE）
- `src/ui/timeline.ts`：**世界沙盘时间线**（坐标 epoch 秒、标尺分级、循环、剧情线、时间指针）
- `src/ui/inspire.ts` / `assoc.ts` / `codex.ts` / `map.ts` / `ai-workbench.ts` / `roleplay.ts` / `tavern.ts` / `settings.ts` / `settings-panel.ts` / `detail.ts` / `node-form.ts`
  —— 其中 **`codex.ts` = 设定库工作台**（左栏**一棵文件夹树**：世界 → 时间线 → 种类 → 节点 ／ 世界 → `_设定` → 类型 → 实体，**默认全展开**；点中哪一行就编哪一类，中栏字段、右栏正文、右边缘**常驻**的演变帧条（节点模式加 `.is-off` 演着收起），换条目时 `#cx-body` 演一次**行级转场**；顶栏那组控件按类别换：实体态「类型 ▾ + 数量 + ＋新建实体」／节点态「时间线 ▾ + 数量 + ＋新建节点」（**按钮只有一个** `#cx-new`，文案用 `rollText()` 上下滚着换）——**不用切去世界沙盘也能建节点**，下拉**跟着你正在编的那条走**（`syncNewType()`/`nodeNewTlId()`），数量框可一次建多个（名字 `uniqueName()` 保证唯一，没改名的标「待填」`.ed-ttag`），新建的节点落在**时间指针那一年**（`cursorYear()`）而树按 `epochOfNodes()` 的时间排。两组都在骨架里只切显隐，否则换类别时下面整体跳 7px）；节点中栏另有一块 **「这件事改变了谁」**（`#cx-changed`）—— 站在事件上看它改过哪些设定（名字 / 类型 / 第几版 / 改动摘要），点一行跳到"这条设定在这个事件之后的样子"（数据本来就在 `Entity.frames[].nodeId`，不新增存储）。
  **`settings.ts`** = 设置项的存储与表单（`loadSettings`/`saveSettings`/`renderSettingsInto`）；
  **`settings-panel.ts`** = 那层**悬浮设置面板**（用户 2026-09-13：「我希望设置面板是悬浮面板，而不是单开一个标签页」⇒ `src/tools/registry.ts` 里 `Tool.panel = true` 的面板型工具）。
  原 `src/ui/editor.ts` 已于 2026-09-13 并入工作台并删除（提示条搬去 `src/ui/vault-notice.ts`）。
- `src/ui/eyedrop.ts` / `image-ext.ts` / `tag-ext.ts`：吸管 / 编辑器图片 / 标签扩展
- `data/worldbuilding.js`：种子世界观；`data/character_lib.json`：角色词库（萌百来源 CC BY-NC-SA，勿商用）

## 测试后门

- 环境变量 `LINGKUANG_TEST_DATA=<文件路径>` → 数据读写走该文件，不碰 `%APPDATA%\lingkuang\worldbuilding.json`
- 环境变量 `LINGKUANG_VAULT=<目录>` → vault 指向该目录（配合上一条，测试完全不碰真实数据）
- 环境变量 `LINGKUANG_TEST_USERDATA=<目录>` → **userData 也隔离**（localStorage / settings.json / 词库副本）。
  且它存在时测试实例**不参与单实例锁** —— 否则用户正开着正式应用时，测试实例抢不到锁会自杀，
  而正式实例收到 `second-instance` 会把**用户正在用的窗口**关掉重建（＝起个测试实例就打断用户）
- 环境变量 `LINGKUANG_TEST_WINDOW_POS="1920,0"` → 窗口开在指定位置（多屏时开在副屏做验证，主屏不受扰）
- 环境变量 `LINGKUANG_TEST_WINDOW_SIZE="1180,780"` → 指定窗口尺寸
- 环境变量 `LINGKUANG_TEST_WINDOW_NOFOCUS=1` → 不抢焦点（`showInactive`）
- 自动化验证走 CDP：`Start-Process electron.exe -ArgumentList @($proj,'--remote-debugging-port=9333')`
  ——用 `Start-Process` 起进程，**别用 Node 的 `child_process` 捕获输出**（管道 stdio 会被沙箱拦成
  `spawn EPERM`）；再用 Node 内置 `fetch` + 内置 `WebSocket` 连 `webSocketDebuggerUrl`，
  做 `Runtime.evaluate` 取 DOM 实测值 / `Page.captureScreenshot` 截图。

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
