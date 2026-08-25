# 灵框 LingKuang

[![GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/sleepless-diary/lingkuang)](https://github.com/sleepless-diary/lingkuang/releases)
[![Electron](https://img.shields.io/badge/Electron-43-47848F)](package.json)

世界观创作工作台（Electron + Vite + TypeScript）。面向创作者的时间线、随机角色生成、词义联想、Markdown 编辑器与 AI 辅助。

> 界面：暖灰米底 + 冷荧光绿点缀，AE 风工具栏。截图见 `docs/screenshot.png`。

---

## ✨ 功能

| 模块 | 说明 |
|---|---|
| 🕰️ **世界沙盘 · 时间线** | 横向节点图、拖拽平移、Alt+滚轮缩放、多条循环（轮回）、剧情线、时间指针 |
| 🗺️ **地图** | Leaflet 重构（开发中，占位） |
| 🎲 **灵感触发器** | 58 分类 / 4600+ 词条随机组合触发角色灵感；词条数可选、可锁定、组合可保存 |
| 🔗 **词义联想图** | 点词展开一级联想（本地 Ollama 或 OpenAI 兼容 API）；力导向布局、可拖动、取消入库词一键暂存导出 |
| 📝 **编辑器** | tiptap Markdown 所见即所得，文稿列表管理 |
| 🌀 **AI 工作台** | 常驻 AI 面板（接入本地/云端模型） |
| ⚙️ **设置** | 联想引擎（Ollama / OpenAI 兼容）、其他配置 |

**历法（可编辑日历）**：时间线采用可编辑历法模型（`src/calendar.ts`），默认公历（闰年/大小月精确）。节点时间带年月日时分，坐标轴统一为公历 epoch 秒换算，标尺按缩放分档（年→月→日→时→分，含千年/万年档）。

## 🚀 安装运行

### 普通用户：直接下载

从 [Releases](https://github.com/sleepless-diary/lingkuang/releases) 下载：

- `LingKuang-x.x.x-x64.exe` — 安装版（双击安装）
- `LingKuang-x.x.x-portable-x64.exe` — 便携版（双击即用）

不需要 Node.js / npm。

### 开发者：源码运行

需要 **Node.js 18+**：

```bash
npm install
npm start      # 构建 + 启动 Electron
```

其他脚本：`npm run dev`（Vite 开发）、`npm run build`（仅构建）、`npm run dist`（打包安装/便携版）。

### 词义联想（可选）

词义联想引擎支持双模式（设置 → 联想引擎）：

| 模式 | 说明 |
|---|---|
| **本地 Ollama** | 安装 [Ollama](https://ollama.com) + `ollama pull qwen2.5:7b` |
| **OpenAI 兼容 API** | 设置里填 Base URL / API Key / 模型名 |

也可用环境变量 `LINGKUANG_AI_MODE` 等配置。未配置 AI 时，时间线 / 灵感触发器 / 编辑器等核心功能完全可用。

## 📂 目录结构

```
lingkuang/
├── main.js              # Electron 主进程（IPC：数据读写 / Ollama 联想 / 词库分类）
├── preload.js           # contextBridge 安全桥
├── index.html           # Vite 入口（#app 挂载点）
├── mcp-server.js        # MCP 服务器（query_timeline / search_world 等）
├── src/
│   ├── main.ts          # 渲染进程入口
│   ├── calendar.ts      # 历法系统（可编辑历法，默认公历）
│   ├── store/           # 数据层（types / actions / store）
│   ├── tools/           # 工具注册
│   └── ui/              # 各视图：shell / timeline / inspire / assoc / editor / map / ai / settings ...
├── data/
│   ├── worldbuilding.js # 世界观种子数据
│   └── character_lib.json  # 角色生成词库
├── design-system/       # 设计令牌与规范
└── docs/                # 架构、历法、编辑器对接、用户手册等文档
```

用户数据（时间线/设置/暂存词）保存在系统 `%APPDATA%\lingkuang\`，不随仓库分发。

## 📄 License

- 代码：**GPL-3.0**（见 [LICENSE](LICENSE)）
- 词库 `data/character_lib.json`：基于**萌娘百科**（[CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/)）词条整理并混有 AI 扩充词条，**仅限非商业用途**，与代码协议相互独立。需商用请替换为自建词库（58 个分类 key 见 `src/ui/inspire.ts`）。

## 📖 文档

- [代码地图](docs/ARCHITECTURE.md) — 架构 / 数据模型 / 关键机制
- [历法系统](docs/CALENDAR.md) — 可编辑历法模型设计
- [编辑器对接](docs/EDITOR-SANDBOX-BRIDGE.md) — 编辑器与世界沙盘的数据对接
- [已知 Bug](docs/BUGS.md)
- [功能路线图](docs/ROADMAP.md)
- [用户手册](docs/USER_GUIDE.md)
