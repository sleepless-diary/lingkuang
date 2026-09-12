# 灵框 · 知识库查看器 (kb-viewer)

灵框 LingKuang 的**新工具分支** —— 把知识库（`F:/knowledge-base`）变成一个手机 / 平板 / 电脑都能看的网页应用。

> 阈限梦核皮肤，与灵框主程序同一套设计令牌（`design-system/tokens.css`）。
> 零依赖（唯一可选依赖是灵框自己的 `markdown-it`），不碰灵框现有代码。

---

## 快速开始

```bash
# 双击 start.bat，或：
cd tools/kb-viewer
node server.js
```

启动后控制台会打印两个地址：

```
本机   http://localhost:7717
手机   http://192.168.x.x:7717   <- 同一 WiFi 下用这个
```

手机 / 平板浏览器打开那个「手机」地址即可。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `KB_PORT` | `7717` | 监听端口 |
| `KB_HOST` | `0.0.0.0` | 监听地址（`127.0.0.1` 则只有本机能访问） |
| `KB_ROOT` | `F:/knowledge-base` | 知识库根目录 |

---

## 功能

| 视图 | 说明 |
|---|---|
| 最近 | 最近更新的文件 + 知识库统计 + 分区分栏（可只看某个目录） |
| 目录 | 左侧抽屉文件树（手机）/ 固定侧栏（桌面 ≥900px） |
| 文件 | Markdown 渲染、表格 / 代码块横向滑动、元信息（大小 / 修改时间） |
| 搜索 | 文件名 + 全文搜索，命中行高亮 |

其他：字号调节（Aa，四级循环，存 localStorage）、hash 路由（`#f=<path>`，浏览器返回键可用）、深色模式跟随系统、安全区适配（刘海屏 / 手势条）。

---

## API

服务端是零依赖 Node HTTP，所有能力都走 JSON API，方便以后接别的客户端。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（版本 / root / 渲染引擎） |
| GET | `/api/stats` | 文件数 / 总字节 / 分区分栏统计 |
| GET | `/api/tree?depth=3` | 目录树 |
| GET | `/api/recent?limit=30&dir=college` | 最近修改（可按目录过滤） |
| GET | `/api/search?q=记账&limit=50` | 全文搜索 |
| GET | `/api/file?path=daily/2026-09-10.md` | 文件内容（原文 + 渲染后 HTML） |
| POST | `/api/save` | 写回文件 `{path, text}`（已在服务端就绪，前端尚未接入） |

**安全**：所有 `path` 都被 `safeJoin()` 夹死在 `KB_ROOT` 内，`../../` 穿越会返回 `bad path`（有冒烟测试覆盖）。

---

## 测试

```bash
node test-smoke.js      # 拉起服务 -> 打全部 API -> 结果写 smoke-result.txt -> 杀进程
```

覆盖：health / stats / tree / recent / file / search / 静态资源 / manifest / 图标 / 路径穿越防护 / 404。

---

## 目录结构

```
tools/kb-viewer/
├── server.js            # 零依赖 HTTP 服务 + API + 迷你 Markdown 降级渲染器
├── start.bat            # Windows 双击启动
├── test-smoke.js        # 冒烟测试
├── make-icons.py        # 从 build/icon.png 生成 PWA 图标集
├── public/
│   ├── index.html
│   ├── style.css        # 阈限梦核令牌
│   ├── app.js           # 无框架前端
│   ├── sw.js            # Service Worker（只缓存壳，API 实时）
│   ├── manifest.webmanifest
│   └── icons/           # 192 / 512 / maskable / apple-touch / favicon
└── smoke-result.txt     # 测试输出（跑完生成）
```

---

## 装到手机主屏（PWA）

现在服务跑在局域网 HTTP 上，浏览器**能加到主屏但不能做完整 PWA 安装**（需要 HTTPS）。

- **安卓 Chrome**：打开地址 → 右上角菜单 →「添加到主屏幕」
- **iOS Safari**：分享 →「添加到主屏幕」

图标就是灵框本人的图标，打开后基本是全屏。

要变成真正的可安装 PWA（无地址栏、可离线），需要 HTTPS —— 这就是「穿透」那一步要解决的事。

---

## 以后可以扩的方向

- 接入 `/api/save` → 手机上直接改笔记
- 接入灵框的 vault（`F:/lingkuang-vault`）→ 时间线节点互通
- 接入 MCP（`mcp-server.js` 已有 `query_timeline` / `search_world`）→ 在手机上问 AI
- 全文索引（现在每次搜索都现读文件，519 个文件还行，上万就得上索引）
- 收藏 / 置顶 / 最近打开（localStorage 即可）

---

## 与灵框主程序的关系

完全独立：不改 `main.js` / `preload.js` / `src/`，不新增 npm 依赖，不进 electron-builder 的 `files` 列表（打包出的桌面应用体积不变）。

以后要集成到灵框窗口里的话，加一个 BrowserView 指向 `http://localhost:7717` 即可。
