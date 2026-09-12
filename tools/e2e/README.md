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
3. **「昨天还全过、今天挂了」先做 A/B，别急着改代码。**
   `git stash push -u` → `npx vite build`（此时工作树 = HEAD）→ 用**同一个全新目录**复跑那条套件。
   同一条挂 = 既有缺陷，不是本次改动引入的（第十八轮就是这么定案的：`entity-vault` 从 17/17 掉到 14/17，
   A/B 证明 HEAD 同样 14/17，真因是 `vault:watch` 在 vault 根不存在时静默不挂监听）。
   另外**目录状态会影响结果**：空 vault 起步 ≠ 用过一轮的 vault（同一条 bug 只在前者现形），
   所以复现时永远从 `reset-*.cjs` + 全新临时目录开始。
4. **回归挂了先怀疑「目录脏」，再怀疑代码。** 复现脏目录最省事的办法：**把那个目录原样复制两份**
   （一份跑 HEAD、一份跑改动），两边看到完全一样的起点，一次就能分辨「我改坏了」还是「起点本来就脏」。
   第十九轮实测：`codex-node-tab.cjs` 从 15/15 掉到 13/15，A/B 发现 **HEAD 在同一目录上只有 12/15**
   —— 真因是上一会话遗留的同 id 节点 `.md` 没清（`reset-entity-vault.cjs` 只清实体、
   **不清时间线节点目录**），同 id 两份并存时回扫的赢家由 readdir 顺序决定，
   而测试断言读的是**固定路径**。⇒ 现在 `seed-node.cjs` 会先清空这条时间线：**播种要给确定起点**。

## 文件

| 文件 | 作用 |
| --- | --- |
| `entity-vault.cjs` | 实体（设定库）落 vault `.md` 的全链路：落盘 → `_设定` 不算时间线 → 外部改字段/正文回扫 → 换类型不残留旧文件且回扫不被打回 → 删除进回收站不复活 → 回收站恢复回 store 与原位 |
| `cold-start-entity-vault.cjs` | 重启后实体类型与文件位置是否保持（换类型那条缺陷的最终症状） |
| `reset-entity-vault.cjs` | 前置清理：测试世界实体清空 + 删 `_设定` / `.trash`（不清理的话上一轮残留会被回扫捞回来） |
| `seed-json-only-entity.cjs` | 前置：造「升级前就存在的 JSON-only 实体」（实体只在 JSON 里，vault 里没有 `_设定`） |
| `startup-materialize-entity.cjs` | 启动补写：不点任何东西，实体应当自己写成文件（`writeAll` 只在有改动时才跑，靠启动这一趟兜底） |
| `seed-node.cjs` | 前置：给测试世界播一个时间线节点（含种类模板 `formats.json`）+ 一条**有正文的实体**（用来测跨页签不串文档）。**播之前会先清空这条时间线**，保证确定起点（同 id 两份并存时赢家看 readdir 顺序，断言会假挂） |
| `seed-kind-change.cjs` | 前置：播一个落在 `主线/战斗/` 里的节点（**种类由文件夹名承载**），并让 `formats.json` 里同时有「事件」「战斗」两种，好在界面里把种类改过去 |
| `kind-change-stale-file.cjs` | 换种类后旧文件不残留 11 项：改种类 → 新文件夹写出文件 + **同 id 只剩一份** + 回扫后种类**没被打回旧值** + 盘上旧残留**自愈**（目标路径已存在时也生效）+ **同目录里改了名的残留**在下一次落盘时被清掉 + 收敛后界面（种类 + 标题）与活下来的文件一致。⚠️ 清理**挂在写盘上**：播一份「输了」的残留不会自己消失，要像真人那样动一下这个节点（改描述）触发落盘再断言 |
| `codex-node-tab.cjs` | 设定库「时间线节点」页签：四级树 → 公共属性面板固定行 → 改描述/正文落到节点的 `.md` → 搜索 → 跨页签不串文档 |
| `editor-props-panel.cjs` | 编辑器侧的共享面板守卫：固定行齐全、时间是 scrub、描述是 textarea、**提交后面板不重建**（元素身份不变） |
| `codex-switch-target.cjs` | 不变量：换条目不能把上一条的正文写进下一条（按 `.md` 文件断言正文归属；走「不失焦就切」的危险路径） |
| `seed-corrupt-data.cjs` | 前置：造出「截断的 `worldbuilding.json` + 空 vault」（= `docs/BUGS.md` 记的那条数据损失场景；**空 vault 是关键**，否则 vault 会兜住） |
| `data-corrupt-guard.cjs` | 判损护栏 16 项：截断文件启动后**原文件逐字节未被覆盖** + 副本隔离 + 重读过（`attempts>1`）+ `data:save` 被拒且标明 `locked` + 壳级横幅两条出口 + 点「继续用新数据」解锁并自愈 + 中途补全的文件被重读捞回 |
| `data-load-clean.cjs` | 误报守卫 6 项：**干净**数据启动时护栏一步都不该动（`attempts===1`、无横幅、无副本、写盘照常） |

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

「换种类」那条（节点种类 = 所在文件夹名 ⇒ 换种类就是搬文件夹）：

```powershell
$env:LINGKUANG_TEST_DATA="C:\Users\<你>\AppData\Local\Temp\lk-kind\worldbuilding.json"
$env:LINGKUANG_VAULT="C:\Users\<你>\AppData\Local\Temp\lk-kind\vault"

node tools\e2e\seed-kind-change.cjs           # 播 主线\战斗\王国的建立.md（+ 两种种类模板）
# 起应用（同上面的 Start-Process）
node tools\e2e\kind-change-stale-file.cjs     # 10 项：改种类 → 旧文件夹那份必须被清掉、种类不被打回
```

判损护栏那条（**必须用全新目录** —— 那条既有 bug 只在「启动时 vault 根还不存在」时现形）：

```powershell
$env:LINGKUANG_TEST_DATA="C:\Users\<你>\AppData\Local\Temp\lk-corrupt\worldbuilding.json"
$env:LINGKUANG_VAULT="C:\Users\<你>\AppData\Local\Temp\lk-corrupt\vault"   # 目录不存在 = 空 vault

node tools\e2e\seed-corrupt-data.cjs         # 播种一个截断的文件（真解析不了）
# 起应用（同上面的 Start-Process）→ 会弹原生「数据文件损坏」对话框（**这是被测行为**）
node tools\e2e\data-corrupt-guard.cjs        # 16 项
```

`data-corrupt-guard.cjs` 的最后一项（★14「中途补全的文件能被重读捞回」）需要在
`loadData()` 飞行途中把文件补全 —— 脚本自己控时（截断 → 发起读 → 60ms 后补齐），
跑三轮取一次 `ok && attempts>1` 的观测，避免 IPC 抖动把首读挤到补齐之后。

**误报守卫 `data-load-clean.cjs` 不能跑在这个目录里**：判损那轮已经留下 `.bak-corrupt-*`，
它的 ★4「没有凭空生成损坏副本」会挂。它要的是**干净数据**，跟上面「设定库工作台那两条」用同一个前置：

```powershell
node tools\e2e\reset-entity-vault.cjs
node tools\e2e\seed-node.cjs                 # 干净数据 + 一条节点 + 一条实体
# 起应用
node tools\e2e\data-load-clean.cjs           # 6 项：attempts===1 / 无横幅 / 无副本 / 写盘照常
```
