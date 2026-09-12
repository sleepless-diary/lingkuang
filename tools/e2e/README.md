# tools/e2e · 灵框端到端验证（真实 Electron + CDP）

跑的是**真的应用**（`app-dist/` 里的渲染层 + `main.js`），用 Chrome DevTools Protocol
驱动界面、读真实 DOM，再对**磁盘上的 vault 文件**做断言。不碰真实数据 —— 全靠
`LINGKUANG_TEST_DATA` / `LINGKUANG_VAULT` 两个后门把读写重定向到临时目录
（真实数据在 `%APPDATA%\lingkuang\`，见 `AGENTS.md`）。

## 跑一次（PowerShell）

```powershell
cd F:\Projects\lingkuang-v3
npx vite build                                  # 改了 src/ 必须先构建，桌面快捷方式不会自己构建

# 1) 干净前置：清空测试世界的实体 + 删掉 vault 的 _设定 / .trash
$env:LINGKUANG_TEST_DATA="C:\Users\<你>\AppData\Local\Temp\lk-evault2\worldbuilding.json"
$env:LINGKUANG_VAULT="C:\Users\<你>\AppData\Local\Temp\lk-evault2\vault"
node tools\e2e\reset-entity-vault.cjs

# 2) 起测试实例（用 Start-Process，别用 Node 的 child_process 捕获输出 —— 管道 stdio 会被沙箱拦成 spawn EPERM）
$env:LINGKUANG_TEST_WINDOW_SIZE="1180,780"; $env:LINGKUANG_TEST_WINDOW_NOFOCUS="1"
Start-Process -FilePath "F:\Projects\lingkuang-v3\node_modules\electron\dist\electron.exe" `
  -ArgumentList @("F:\Projects\lingkuang-v3","--remote-debugging-port=9334")
Start-Sleep -Seconds 3

# 3) 跑测试
node tools\e2e\entity-vault.cjs                  # 17 项，退出码 0 = 全过

# 4) 冷启动复验（重启后状态还在不在）
Get-Process electron | Where-Object { $_.Path -like "*lingkuang-v3*" } | Stop-Process -Force
Start-Sleep -Seconds 2
Start-Process -FilePath "F:\Projects\lingkuang-v3\node_modules\electron\dist\electron.exe" `
  -ArgumentList @("F:\Projects\lingkuang-v3","--remote-debugging-port=9334")
Start-Sleep -Seconds 3
node tools\e2e\cold-start-entity-vault.cjs
```

`LK_CDP_PORT` 可改端口（默认 `9334`）。**每个 pwsh 调用都是全新进程**，
cwd 与环境变量不跨调用保留 —— 环境变量要和命令写在同一次调用里。

## 两条铁律（踩过坑）

1. **验证「外部改 `.md` 有没有生效」必须读活 UI（DOM），不能读 `worldbuilding.json`。**
   回扫路径按设计 `suppressWrite = true`，只进内存**不回写 JSON**（文件为源，JSON 只是缓存）。
   拿 JSON 断言会误报「字段/正文没同步」—— 曾因此白排查数轮。
2. **页面内选择器片段是「字符串」**，要用 Node 模板插值展开进表达式：
   `` ev(`(${SEL('发色')})?.value`) ``。写成 `(SEL.toString())('发色')` 是在页面里**调用**它，
   得到的是函数源码字符串，`?.value` 恒为 `undefined`。

## 文件

| 文件 | 作用 |
| --- | --- |
| `entity-vault.cjs` | 实体（设定库）落 vault `.md` 的全链路：落盘 → `_设定` 不算时间线 → 外部改字段/正文回扫 → 换类型不残留旧文件且回扫不被打回 → 删除进回收站不复活 → 回收站恢复回 store 与原位 |
| `cold-start-entity-vault.cjs` | 重启后实体类型与文件位置是否保持（换类型那条缺陷的最终症状） |
| `reset-entity-vault.cjs` | 前置清理：测试世界实体清空 + 删 `_设定` / `.trash`（不清理的话上一轮残留会被回扫捞回来） |
| `seed-json-only-entity.cjs` | 前置：造「升级前就存在的 JSON-only 实体」（实体只在 JSON 里，vault 里没有 `_设定`） |
| `startup-materialize-entity.cjs` | 启动补写：不点任何东西，实体应当自己写成文件（`writeAll` 只在有改动时才跑，靠启动这一趟兜底） |
| `seed-node.cjs` | 前置：给测试世界播一个时间线节点（含种类模板 `formats.json`）+ 一条**有正文的实体**（用来测跨页签不串文档） |
| `codex-node-tab.cjs` | 设定库「时间线节点」页签：四级树 → 公共属性面板固定行 → 改描述/正文落到节点的 `.md` → 搜索 → 跨页签不串文档 |
| `editor-props-panel.cjs` | 编辑器侧的共享面板守卫：固定行齐全、时间是 scrub、描述是 textarea、**提交后面板不重建**（元素身份不变） |
| `codex-switch-target.cjs` | 不变量：换条目不能把上一条的正文写进下一条（按 `.md` 文件断言正文归属；走「不失焦就切」的危险路径） |

启动补写那条单独跑一次：

```powershell
node tools\e2e\seed-json-only-entity.cjs     # 播种 JSON-only 实体
# 起应用（同上面的 Start-Process）
node tools\e2e\startup-materialize-entity.cjs
```

设定库工作台那两条（节点页签 + 编辑器共享面板）跑一次：

```powershell
node tools\e2e\reset-entity-vault.cjs
node tools\e2e\seed-node.cjs                 # 播节点 + 种类模板 + 一条有正文的实体
# 起应用（同上面的 Start-Process）
node tools\e2e\codex-node-tab.cjs            # 15 项
node tools\e2e\editor-props-panel.cjs        # 9 项（同一个实例直接接着跑即可）

# 另一轮：换条目串不串正文（先 reset，不用 seed）
node tools\e2e\codex-switch-target.cjs       # 7 项
```
