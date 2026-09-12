# tools/e2e · 灵框端到端验证（真实 Electron + CDP）

跑的是**真的应用**（`app-dist/` 里的渲染层 + `main.js`），用 Chrome DevTools Protocol
驱动界面、读真实 DOM，再对**磁盘上的 vault 文件**做断言。不碰真实数据 —— 全靠
`LINGKUANG_TEST_DATA` / `LINGKUANG_VAULT` / `LINGKUANG_TEST_USERDATA` 三个后门把读写重定向到临时目录
（真实数据在 `%APPDATA%\lingkuang\`，见 `AGENTS.md`）。

⚠️ **`LINGKUANG_TEST_USERDATA` 不是可有可无的**（2026-09-12 加）：用户常常**正开着正式应用**，
而 `main.js` 有单实例锁 —— 不带它起测试实例，测试实例会抢不到锁自杀，**并且正式实例收到
`second-instance` 会把用户正在用的窗口 destroy + 重建**（＝起个测试实例就把用户的窗口搞没了）。
带上它之后 userData 也隔离（localStorage / settings.json / 词库副本各一份），两个实例还能并行跑。

## 跑一次（PowerShell）

```powershell
cd F:\Projects\lingkuang-v3
npx vite build                                  # 改了 src/ 必须先构建，桌面快捷方式不会自己构建

# 1) 干净前置：清空测试世界的实体 + 删掉 vault 的 _设定 / .trash
$env:LINGKUANG_TEST_DATA="C:\Users\<你>\AppData\Local\Temp\lk-evault2\worldbuilding.json"
$env:LINGKUANG_VAULT="C:\Users\<你>\AppData\Local\Temp\lk-evault2\vault"
$env:LINGKUANG_TEST_USERDATA="C:\Users\<你>\AppData\Local\Temp\lk-evault2\userdata"   # 别省
node tools\e2e\reset-entity-vault.cjs

# 2) 起测试实例（用 Start-Process，别用 Node 的 child_process 捕获输出 —— 管道 stdio 会被沙箱拦成 spawn EPERM）
$env:LINGKUANG_TEST_WINDOW_SIZE="1180,780"; $env:LINGKUANG_TEST_WINDOW_NOFOCUS="1"
Start-Process -FilePath "F:\Projects\lingkuang-v3\node_modules\electron\dist\electron.exe" `
  -ArgumentList @("F:\Projects\lingkuang-v3","--remote-debugging-port=9334")
Start-Sleep -Seconds 3

# 3) 跑测试
node tools\e2e\entity-vault.cjs                  # 17 项，退出码 0 = 全过

# 4) 冷启动复验（重启后状态还在不在）
# ⚠️ **别**用 `Get-Process electron | Where-Object { $_.Path -like '*lingkuang-v3*' } | Stop-Process`
#    —— 那会连用户正开着的正式应用一起杀掉。按**调试端口**挑（只杀自己起的那个）：
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -like '*remote-debugging-port=9334*' -or $_.CommandLine -like '*lk-evault2*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
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
| `seed-motion.cjs` | 前置：给动效套件造确定起点 —— **两条时间线**（页签错峰至少要两个 tab，**第二条故意 0 节点、vault 里没有目录**，顺带守着「空时间线不被 vault 重建抹掉」那条修复）+ 各一个节点 + 一个实体。独立目录（`%TEMP%\lk-motion`），免得给别的套件留下额外时间线 |
| `toolbar-groups.cjs` | 左栏分组**4 项**：两组（创作 6 个 / 管理 4 个）+ 顺序固定、管理组**贴底**（离底 ≤10px 且与上段留 >40px 空隙）、最底下那个就是「设置」且点了真能开设置面板、无未捕获异常。**不依赖世界数据**，哪个已播种的目录都能跑 |
| `motion-switch.cjs` | 动效（切换类）**25 项**：切工具/开面板/回沙盘/页签错峰/弹窗/设定库换页签/**灵感触发器卡片** —— ① **参数**（`getAnimations()` 的 name + 时长 + 延迟 + `playState`，在点击的同一个同步块里读）② **真的在跑**（出**一帧**后要 `animationend`，见铁律 6）③ **终态不残留**（`finish()` 后 opacity=1 / transform=none）④ **容器不许播**（★2/★7/★9：整块淡入是"闪一下"的来源）⑤ **错峰自收手**（★6：类与行内延迟都清掉，否则重渲染会重播）⑥ **减少动效降级**（★15/★21/★24：`lk-fade`/200ms、错峰延迟全 0，含行内值）⑦ **竞态守卫**（★17：同 tick 连点两个工具，终态必须是后点的那个）⑧ **块里面的元素也要错峰**（★18 卡片排 `120…720ms` 阶梯 + 卡片区自己不整块淡入、★19「重新生成」**不重播**（用户 2026-09-12：只有初次进入才错分）、★20 锁定不重建卡片）⑨ **高度平滑**（★23 变高矮的卡挂上 `height` 过渡、起点被钉在旧高度、★23b 落位后停在目标高度、★24 减少动效下根本不挂）+ 功能回归（★16 点第二个时间线页签真的切过去了）。⚠️ 断言**不依赖墙钟**，原因见铁律 6/7 |
| `seed-empty-timeline.cjs` | 前置：三条时间线 —— 主线(1 节点)、**支线(0 节点，故意不建目录)**、副线(1 节点)；vault 里只有主线与副线的目录 |
| `timeline-persist.cjs` | 空时间线不该被 vault 重建抹掉 8 项：启动后三条页签都在 → 空时间线能选中 → 点＋新建（直接建、默认名「新时间线」）→ **落盘后空时间线还在文件里** → 回扫后仍在 → **外部删掉主线目录后主线消失且不复活** → 副线与两条空时间线都没被牵连 |
| `cold-start-empty-timeline.cjs` | 重启复验 3 项（承接 `timeline-persist.cjs` 的收尾状态）：两条空时间线仍在、被外部删目录的主线不复活、盘上文件与界面一致 |
| `assoc-canvas.cjs` | 灵感触发器·联想画布 **11 项**（用户 2026-09-12 两条：「节点会被一块地方挡住，看不全 / 移出视窗时视窗不跟着移」→「**现在有边界了，向上拖不动节点了，我想要无限画布**」）：★1 滚到底时**画布顶部不被 sticky 工具条压住**（`stageTop ≥ barBottom`、`stageBottom ≤ vh`、画布顶部那一圈 `elementFromPoint` 归画布、高度 ≥ vh×0.7）、★2 鼠标停在**画布上**滚滚轮真能滚页面（找的是真滚动容器 `.lk-tool-slot`，不是写死的类名）、★3 拖到右边缘**按住不放**→视窗自己往右推且节点**一直贴在鼠标下**、★3b **越过旧世界右墙继续推**（没有边界）、★4 松手后推力立刻停、★5 反向拖到左边缘 → 越过原点继续走（左边同样没墙）、★7 **向上拖节点**：世界坐标真的变小（可以 < 20、甚至为负）+ 贴上边缘时 `panY > 0`、★8 松手即真的松手（之后的指针移动不再带动节点 + 贴边推停住；**原来断言"坐标一动不动"，`PIN_YIELD` 之后已改判据**）、★9 跑到**框外的连线照样画出来**（含 A/B：把 SVG 的 `overflow` 改成 `hidden` 时同一点 `elementFromPoint` 就打不中）、★6 无未捕获异常。⚠️ 自动推视窗是 rAF 驱动的 ⇒ 断言前必须 `forceFrames()`（见铁律 6） |
| `assoc-pull.cjs` | 联想画布**连线上的"拉力"6 项**（用户 2026-09-13：「**拉太远时拉力会失效**」→「线没断，但是拉力失效了，是不是数据溢出的问题」）：★1 拖拽**全程**就是"线被拉住"（往"离开根"的方向拖 150px，间距不许被拉长；A/B：修复前根词位移 **1px**、线从 148 拉成 **291**，修复后 146/146）、★2 拖得近（< `PIN_YIELD 420`）松手后**它自己留在被放下的地方**（自身漂移 0，线由邻居过来收）、★3 **两端都被手工摆过** + 拉太远 → 钉子失效、间距收回静止长度（A/B：修复前 `4477 → 4477` 永远回不来）、★4 丢到 **40 万像素外**不出 NaN/Infinity 且仍在被往回拉（否定"数据溢出"这个猜测）、★5 无异常。⚠️ 它把 `window.fetch` 换成固定 5 个词（`雪狼/冻湖/松林/极光/猎户`）—— 没有 ollama 时图里只有根词、**没有边就无从断言拉力**；落点夹在画布内（拖出画布会触发贴边推视窗，测到的就不是弹簧）；★1 必须**沿"根 → 被拖词"方向往外拖**（见铁律 9） |

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

✅ 跑完上面的步骤，还可以顺手跑一条**不依赖世界数据**的：

```powershell
node tools\e2e\toolbar-groups.cjs             # 4 项：左栏两组 + 设置贴底
```

联想画布那两条（**不依赖时间线数据**，哪个已播种的目录都能跑；`assocSetRoot('雪原')` 自己造根节点）：

```powershell
# 起应用（同上面的 Start-Process）
node tools\e2e\assoc-canvas.cjs               # 11 项：遮挡 / 画布上滚轮 / 贴边自动推视窗 / 无限画布
node tools\e2e\assoc-pull.cjs                 # 6 项：连线上的拉力（拖拽全程 / 近处钉住 / 拉太远收线 / 极远端不出 NaN）
```

⚠️ 这两条的「自动推视窗」是 rAF 驱动的，而测试实例是 hidden（铁律 6）⇒ 脚本里用 `forceFrames()`
自己出帧。**建议给它一个刚起的实例**（视窗平移/缩放是模块级状态，前一个套件动过画布的话，
★3 读到的起点就不是 0；断言仍成立，但读数看着费解）。
⚠️ `assoc-pull.cjs` 会覆盖 `window.fetch`（换掉 LLM 联想）⇒ **同一个实例里跑的后续套件也会用固定 5 个词**。
不影响 `motion-switch` / `toolbar-groups` 这类不联网的套件，但心里要有数（想还原就重开实例）。

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

动效（切换类）那条 —— 用**独立目录**（`lk-motion`），因为它需要一个两条时间线的世界：

```powershell
$env:LINGKUANG_TEST_DATA="C:\Users\<你>\AppData\Local\Temp\lk-motion\worldbuilding.json"
$env:LINGKUANG_VAULT="C:\Users\<你>\AppData\Local\Temp\lk-motion\vault"
$env:LINGKUANG_TEST_USERDATA="C:\Users\<你>\AppData\Local\Temp\lk-motion\userdata"

node tools\e2e\seed-motion.cjs                # 2 条时间线（各 1 节点）+ 1 个实体
# 起应用（同上面的 Start-Process）
node tools\e2e\motion-switch.cjs              # 25 项
```

⚠️ 这套件**必须在 `no-preference` 下跑**，脚本自己会先 `Emulation.setEmulatedMedia` 钉死环境
（系统的「减少动效」偏好会让令牌降级、时长全变），★15 再翻成 `reduce` 验降级。

## 铁律 6：**隐藏窗口里 CSS 动画不推进** —— 动效断言不能靠墙钟

测试实例用 `LINGKUANG_TEST_WINDOW_NOFOCUS=1`（`showInactive`）起，渲染进程的
`document.visibilityState` 是 **`hidden`**。此时 CSS 动画**不会推进**：
`getAnimations()` 里 `playState` 是 `running`，但 `currentTime` 永远是 0、`getComputedStyle` 停在
动画起点（opacity 0 / translateY 8px）。实测采样 2.4 秒 12 次，`currentTime` 纹丝不动。

后果：「点一下 → `sleep(700)` → 断言 opacity=1」这种写法**天然不可靠** —— 绝大多数时候红，
偶尔被某个操作（比如 `Page.captureScreenshot`）强制出帧推进了动画，就变成绿 ⇒ 随机挂。
（本次就是这样：同一套件两次跑，同一个断言一次 `opacity: 1`、一次 `opacity: 0`。）

正确姿势（`motion-switch.cjs` 就是这么写的）：
1. **参数**：在点击的**同一个同步块**里读 `getAnimations()` 的 name / 时长 / 延迟 / `playState`；
2. **真的会动**：`Page.captureScreenshot`（jpeg quality 10）**连打 5-6 帧**（`motion-switch.cjs` 的
   `forceFrames()`），然后要 **`animationend` 事件**（脚本开头挂 `window.__ends` 全局监听）——
   动画播到结尾才会触发，帧被吞掉或动画从未启动都不会来。
   ⚠️ **只打一帧是不够的**：实测单张 `captureScreenshot` 之后 `__ends` 仍是空数组（隐藏页面要连续
   几帧才走完动画生命周期）—— ★4 就是因此随机挂过一次，已改成连打；
   ⚠️ **别用 `currentTime > 0` 当证据**：实测这一帧往往**直接把动画推到结尾**（读完是"已播完"、类也
   被清了，见下条铁律 7），中途态根本抓不到（早期版本就是这么随机挂的）；
3. **终态**：`el.getAnimations().forEach(a => a.finish())` 把动画推到结尾，再读计算样式
   （必须回到 `opacity: 1` + `transform: none`）。这比"等一会儿"更确定，而且正好覆盖
   「动画停在起点/中途」这类真缺陷。

## 铁律 7：**一次性动效会"自己收手"** —— 读晚了什么都没有

`cascadeIn()` 是**一次性**错峰：它给子项加类 + 行内延迟，播完（最后一块 `animationend`，或
`maxDelay + 2000ms` 兜底）就把类与行内延迟都清掉 —— 因为不清的话，工具下次整块重渲染
（`host.innerHTML = …`）时新建的子项会带着旧延迟再播一遍＝改个字段闪一下。

后果（都踩过）：
- 「出一帧再读动画对象」可能读到**空数组**：动画已经播完并收手了。要断言"播过了"请用
  `animationend`（见铁律 6 第 2 步）。
- 想知道"收手了没有"，就**故意**等它播完（或 `finish()` 推到底）再读：类必须已摘掉、
  `style.animationDelay` 必须已清空（`motion-switch.cjs` ★6 就是这条）。
- 别指望「出帧 → 读中间态 → 再出帧」这种节奏：这套环境里第一帧就可能把动画直接送到结尾。

## 铁律 8：**`getAnimations()` 里既有动画也有过渡** —— 判"没有入场动画"必须按 `animationName` 过滤

`el.getAnimations()` 返回的是**同一个列表**：`CSSAnimation`（keyframes）与 `CSSTransition`（transition）。
2026-09-12 加高度平滑（`.lk-h-smooth` 的 `transition: height`）之后，★19「点重新生成后卡片没有入场动画」
原本写 `anims === 0` —— 变高矮的卡各带一个 `CSSTransition`，读数直接变成 13、误报成"错峰又播了"。
判"没有入场动画"用 `el.getAnimations().filter((a) => a.animationName).length`；
判"有高度过渡"反过来读 `a.transitionProperty === 'height'`（或 `getComputedStyle(el).transitionProperty`）。

同族的两条（都在 `motion-switch.cjs` ★23 上踩过）：
- **过渡会把起点钉在行内样式上**：点完立刻量 `getBoundingClientRect().height`，量到的是**旧高度**
  （过渡还没跑）—— 我第一版探针就是这么写的，十轮全报"高度没变"、误以为改动没生效。
  这反而成了免费的中间态证据：同一 tick 里 `style.height`（目标）≠ 渲染高度（起点）＝ 过渡在跑。
- **要读过渡参数，得挑"真的挂上过渡的那张卡"**：没变高矮的卡根本没有那个类，
  读它只会得到浏览器默认的 `transitionProperty: 'all'`。

## 铁律 9：**新写的断言必须在"修复前"的代码上跑一遍** —— 否则可能是个假绿

2026-09-13 写「拉力」的守卫（`assoc-pull.cjs` ★1）时踩到：第一版断言"拖动后间距没被拉长"，
在**未修复**的代码上居然也 PASS（读数 `gapBefore 134 → gapDuring 60`）——
因为那次落点方向是随手挑的，位移里带着"朝根靠"的分量，邻居不动也能让间距变小。
改成**沿"根 → 被拖词"方向往外拖**之后才有判别力：未修复 `291`（根词只动 1px）、修复后 `146`。

做法（这次就用它验证了 3 条断言）：
```powershell
Copy-Item src\ui\assoc.ts src\ui\assoc.ts.mine -Force
git checkout -- src/ui/assoc.ts      # 回到修复前
npx vite build                       # 渲染层要重新 build；main.js 改动不用（不走 vite）
# 重启实例 → node tools\e2e\assoc-pull.cjs   ⇒ 期望 FAIL（这次 3/6）
Copy-Item src\ui\assoc.ts.mine src\ui\assoc.ts -Force; Remove-Item src\ui\assoc.ts.mine
npx vite build                       # 恢复修复后 ⇒ 6/6
```
顺带两条：① 断言要盯**"只有修好才会发生的那件事"**（这次是"间距不涨"，不是"根词位移了多少"——
后者随图布局浮动，不稳定）；② 几何类断言先看**方向/坐标系**对不对，再谈阈值。

## 空时间线那条（数据损失修复的守卫）

```powershell
$env:LINGKUANG_TEST_DATA="C:\Users\<你>\AppData\Local\Temp\lk-tl\worldbuilding.json"
$env:LINGKUANG_VAULT="C:\Users\<你>\AppData\Local\Temp\lk-tl\vault"

node tools\e2e\seed-empty-timeline.cjs         # 主线(1 节点) / 支线(0 节点，无目录) / 副线(1 节点)
# 起应用
node tools\e2e\timeline-persist.cjs            # 8 项（最后会从外部删掉主线的目录）

# 重启应用
node tools\e2e\cold-start-empty-timeline.cjs   # 3 项：空时间线仍在、被外部删掉的主线不复活
```

## 铁律 5：**别把播种脚本接进 `Select-Object -First N`**

```powershell
node tools\e2e\seed-node.cjs | Select-Object -First 1   # ❌ 会杀掉正在写盘的进程
node tools\e2e\seed-node.cjs                            # ✅ 不接管道，或接 -Last（-Last 要读完整个流）
```

PowerShell 拿到第 N 条输出就**提前终止上游进程**。播种脚本是「写文件」的（`seed-node.cjs` 最后一步
是 `writeFileSync(DATA, …)`），正好被打断就留下 **0 字节**的 `worldbuilding.json`。
后果是一串连锁误报：应用启动读空文件 → 判损上锁 → 世界根本没加载 → `codex-node-tab` 的
「切回实体页签」挂、`data-load-clean` 0/6（它会如实报告 `locked:true` + `attempts:4`）。
当时我按「产品坏了」排查了一轮，最后 `Get-ChildItem` 看到 `worldbuilding.json` **0 字节**、mtime
与播种同一秒才定案 —— **回归挂了先看盘中文件的实际大小与 mtime，再怀疑代码。**

补救：**0 字节的数据文件不会自愈（这是判损护栏的设计）**，要从同目录的
`worldbuilding.backup-N.json` 拷回来（`Copy-Item worldbuilding.backup-0.json worldbuilding.json`），
再删掉那几份 `worldbuilding.bak-corrupt-*.json`（否则 `data-load-clean` 的 ★4「没有凭空生成损坏副本」会挂）。
