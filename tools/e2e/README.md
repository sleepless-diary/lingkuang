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
| `seed-node.cjs` | 前置：给测试世界播一个时间线节点（含种类模板 `formats.json`）+ 一条**有正文的实体**（用来测换类别不串文档）。**播之前会先清空这条时间线**，保证确定起点（同 id 两份并存时赢家看 readdir 顺序，断言会假挂） |
| `seed-kind-change.cjs` | 前置：播一个落在 `主线/战斗/` 里的节点（**种类由文件夹名承载**），并让 `formats.json` 里同时有「事件」「战斗」两种，好在界面里把种类改过去 |
| `kind-change-stale-file.cjs` | 换种类后旧文件不残留 11 项：改种类 → 新文件夹写出文件 + **同 id 只剩一份** + 回扫后种类**没被打回旧值** + 盘上旧残留**自愈**（目标路径已存在时也生效）+ **同目录里改了名的残留**在下一次落盘时被清掉 + 收敛后界面（种类 + 标题）与活下来的文件一致。⚠️ 清理**挂在写盘上**：播一份「输了」的残留不会自己消失，要像真人那样动一下这个节点（改描述）触发落盘再断言 |
| `codex-node-tab.cjs` | 设定库（工作台）里编辑**时间线节点** **18 项**（文件名是历史遗留：那两个页签已在 2026-09-13 左栏重做里撤掉）：★1 左列是「筛选 pills + 一个视图按钮」且 `#cx-tab-*` 数量为 0（守着"别再长出第二套开关"）→ ★2 筛到「时间线节点」后是**一列平铺**（没有世界层）→ ★3/★4/★5/★5b 切「视图 文件夹」后逐层展开四级树 → 公共属性面板固定行 → **★9b 提交字段后面板不重建**（元素身份不变；★9c 那一次提交确实落进了 `.md`，防"什么都没发生"式的假绿）→ 改描述/正文落到节点的 `.md` → 搜索 → **换到另一类别的行**后正文不串文档。⚠️ ★9b/★9c 原来在 `editor-props-panel.cjs` 里，编辑器工具并进工作台后搬过来（用种类模板字段「地点」当探针，不动标题 —— 标题会改文件名，而本套件按固定路径读文件） |
| `codex-tree-view.cjs` | 工作台左栏**两种形态 30 项**（用户 2026-09-13：「**设定库和编辑器是不是可以做成同一工具的两种不同形式啊（在设置里面切换）**」+「**时间线节点和实体这两个按钮，列表和文件夹树的功能有点混乱，能不能重新设计一下**」）：★1 左栏 = **一个视图按钮 `#cx-view` + 一排筛选 pills**且没有 `#cx-tab-*` → **★1b 列表形态不分层**（两类条目分组平铺：`设定` / `时间线节点`，没有世界层）→ ★3/★3b 切文件夹后 pills 让位、改出世界层、按钮文案变「视图 文件夹」 → ★5 **同一个世界下时间线与 `_设定` 分支同框**（这棵树原来只长在「编辑器」工具里）→ ★7/★9/★11 类型层列出全部类型（含一个实体都没有的、置灰 + 一句人话）→ ★13/★14 树里点实体行 = 就地换中栏/右栏（名字/字段/右栏帧条都在 + 该行高亮）→ ★16/★18/★20 时间线分支：种类只列真有节点的、点节点行换到节点且**左树没被换掉** → ★21 树视图里搜索同时命中节点与实体 → ★23/★24/★25 视图按钮写进 `localStorage`（`workbenchView`）、设置面板那组单选跟着显示、**重开工作台直接是上次选的形态** → ★27 切回列表（世界层消失）+ 复位。⚠️ `_设定` 行要**展开世界**之后才出现（树的展开态是各层自己的），所以 ★3 只断言"换成了树"，同框交给 ★5。⚠️ 自足：开头先把 `workbenchView` 复位成 `list`；⚠️ 它需要**有空类型**的前置（`reset-entity-vault.cjs` + `seed-node.cjs`），跑到别的目录上会挂 ★7/★8/★9 |
| `seed-editor-tree.cjs` | 前置：给**文件夹树的语义**造确定起点 —— **节点种类** `事件`（**有 2 个节点** ⇒ 该出现在时间线下）+ `战斗`（**一个节点都没有** ⇒ **不该**出现）+ `角色`（没有节点、且与实体类型同名 ⇒ **不该**出现，用户 2026-09-13 报的「角色/地点/物品等文件夹同时存在于主线与设定文件夹下」就是它）；**实体类型** `角色`（1 个实体）+ `地点`（**一个实体都没有** ⇒ 该出现，设定侧列全部类型）。⚠️ 它整份写 `formats.json`（`main.js` 的 `loadFormatsRaw` 只要文件能解析就**直接用**、不跟内建合并）⇒ 空种类能不能出现在树里完全取决于这份文件。⚠️ formats.json 是**启动时读**的 ⇒ 播完要重启应用；⚠️ 全新目录要**先起一次应用**写出 `worldbuilding.json` 再来播种 |
| `workbench-tree-folders.cjs` | 工作台文件夹树的**文件夹语义 31 项**（从原 `editor-tree.cjs` 搬过来的那批断言；编辑器工具下线后它是这套语义唯一的守卫）：★4 有节点的「事件」计数 2 → **★5/★5b/★5c 有定义但一个节点都没有的「战斗」「角色」不许出现在时间线下、时间线下的种类只有真有节点的那些**（★15 全树里「角色」只出现一次且在 `_设定` 下）→ ★10/★11 同一棵树里有 **`_设定`** 分支（计数 = 实体数）+ **★11b 缩进与「主线」一致（`paddingLeft` 都 18px，且 ≠ 世界行的 8px）** → ★13/★14 实体类型**全部列出**，空的「地点」同样置灰 + 一句「这个类型还没有实体」→ ★19 类型下有实体行 → ★20~★26b 在树里点实体行 = **就地**换中栏/右栏（★22 **树没被换掉**、★23/★23b/★23c/★23d **世界/时间线/种类文件夹都还在、`_设定` 仍展开**、★23e 该实体行高亮、★24~★26 名字/正文/字段都换成该实体、★26b 之后**切一次视图形态**（文件夹 → 列表 → 文件夹）仍在编辑这个实体且 `_设定` 的展开态没丢）→ ★27 无异常。⚠️ 移植时踩到的坑：`_設定`（繁体）与界面里的 `_设定`（简体）不是同一串 —— 按标签点行会静默点不中，后面一片 FAIL 全由它引起 |
| `codex-switch-target.cjs` | 不变量：换条目不能把上一条的正文写进下一条（按 `.md` 文件断言正文归属；走「不失焦就切」的危险路径） |
| `seed-smooth-switch.cjs` | 前置（**只许跑在测试目录**，它会清空测试世界的 `_设定`/`主线`/`.trash`）：3 个**不同类型**的实体（角色/地点/物品，字段集合不同）+ 2 个节点 + **34 个「配角」实体**。配角是为了让**左列自己就撑得比可视区高** —— 否则「换条目后滚动位置不回顶」这条断言没有可滚的余地（中栏高度随字段数变，靠正文撑高度既费字又不稳）。⚠️ **这个数字是算出来的**：列表行改成 `.ed-tnode` 的样式（行高 21-24px）后，20 个配角撑不到中栏那么高（实测 `#cx-root` over=0 ⇒ 面板不可滚 ⇒ ★0/★6 假挂），算法 = 行高 × 行数 > 中栏高度（1440×900 下 11 字段的角色 ≈ 743px）。正文写在**闭合的 `---` 之后**：第一版把 `#正文：` 塞进了 frontmatter，结果实体 doc 全是空串、断言一片 FAIL |
| `codex-smooth-switch.cjs` | 设定库**换条目不发"刷新"**16 项（用户 2026-09-13：「点击实体会刷新界面，我希望变成平滑切换」）：★1/★2/★3 换实体后 `#cx-root`/`#cx-search`/`#cx-doc .ProseMirror` **还是同一个元素**（骨架/编辑器没被重建）、★4/★5 名字+字段行+正文都换成新条目的（字段集合真的换了）、★6 **滚动位置不回顶**（`scrollTop 260 → 260`；旧实现换掉滚动容器 ⇒ 恒 0）、★7 左列高亮跟过去（`.is-on` 类，不再是行内背景色）、★8 **不重播整块错峰**（无 `.lk-enter-stagger` / 无 `lk-wake` / 无行内延迟）、★9/★10 内容区播一次 `lk-swap` 淡入且终态不透明无位移、★11/★12 打字后不失焦直接换条目**正文归属不串**（编辑器跨条目复用带来的新风险）、★13 **换类别**（点另一类别的那一行，实体 → 时间线节点）**仍然整块重建 + 错峰**（结构变了，不许就地换）、★14 节点→节点也就地换且中栏属性面板跟着换、★15 无异常。⚠️ 断言前必须**轮询等上一次错峰收手**（见铁律 10）；⚠️ 行**仍然**按 `[data-cx-id]` 找（列表行带着这个属性，旧套件才不用改） |
| `seed-corrupt-data.cjs` | 前置：造出「截断的 `worldbuilding.json` + 空 vault」（= `docs/BUGS.md` 记的那条数据损失场景；**空 vault 是关键**，否则 vault 会兜住） |
| `data-corrupt-guard.cjs` | 判损护栏 16 项：截断文件启动后**原文件逐字节未被覆盖** + 副本隔离 + 重读过（`attempts>1`）+ `data:save` 被拒且标明 `locked` + 壳级横幅两条出口 + 点「继续用新数据」解锁并自愈 + 中途补全的文件被重读捞回 |
| `data-load-clean.cjs` | 误报守卫 6 项：**干净**数据启动时护栏一步都不该动（`attempts===1`、无横幅、无副本、写盘照常） |
| `seed-motion.cjs` | 前置：给动效套件造确定起点 —— **两条时间线**（页签错峰至少要两个 tab，**第二条故意 0 节点、vault 里没有目录**，顺带守着「空时间线不被 vault 重建抹掉」那条修复）+ 各一个节点 + 一个实体。独立目录（`%TEMP%\lk-motion`），免得给别的套件留下额外时间线 |
| `toolbar-groups.cjs` | 左栏分组**4 项**：两组（创作 5 个 / 管理 4 个）+ 顺序固定、管理组**贴底**（离底 ≤10px 且与上段留 >40px 空隙）、最底下那个就是「设置」且点了真能开设置面板、无未捕获异常。**不依赖世界数据**，哪个已播种的目录都能跑。⚠️ 创作组从 6 个变 5 个是 2026-09-13 合并工作台的结果（「编辑器」工具下线，它的树并进设定库） |
| `motion-switch.cjs` | 动效（切换类）**25 项**：切工具/开面板/回沙盘/时间线页签错峰/弹窗/工作台换类别 + 换条目/**灵感触发器卡片** —— ① **参数**（`getAnimations()` 的 name + 时长 + 延迟 + `playState`，在点击的同一个同步块里读）② **真的在跑**（出**一帧**后要 `animationend`，见铁律 6）③ **终态不残留**（`finish()` 后 opacity=1 / transform=none）④ **容器不许播**（★2/★7/★9：整块淡入是"闪一下"的来源）⑤ **错峰自收手**（★6：类与行内延迟都清掉，否则重渲染会重播）⑥ **减少动效降级**（★15/★21/★24：`lk-fade`/200ms、错峰延迟全 0，含行内值）⑦ **竞态守卫**（★17：同 tick 连点两个工具，终态必须是后点的那个）⑧ **块里面的元素也要错峰**（★18 卡片排 `120…720ms` 阶梯 + 卡片区自己不整块淡入、★19「重新生成」**不重播**（用户 2026-09-12：只有初次进入才错分）、★20 锁定不重建卡片）⑨ **高度平滑**（★23 变高矮的卡挂上 `height` 过渡、起点被钉在旧高度、★23b 落位后停在目标高度、★24 减少动效下根本不挂）+ 功能回归（★16 点第二个时间线页签真的切过去了）。⚠️ 断言**不依赖墙钟**，原因见铁律 6/7 |
| `seed-empty-timeline.cjs` | 前置：三条时间线 —— 主线(1 节点)、**支线(0 节点，故意不建目录)**、副线(1 节点)；vault 里只有主线与副线的目录 |
| `timeline-persist.cjs` | 空时间线不该被 vault 重建抹掉 8 项：启动后三条页签都在 → 空时间线能选中 → 点＋新建（直接建、默认名「新时间线」）→ **落盘后空时间线还在文件里** → 回扫后仍在 → **外部删掉主线目录后主线消失且不复活** → 副线与两条空时间线都没被牵连 |
| `cold-start-empty-timeline.cjs` | 重启复验 3 项（承接 `timeline-persist.cjs` 的收尾状态）：两条空时间线仍在、被外部删目录的主线不复活、盘上文件与界面一致 |
| `assoc-canvas.cjs` | 灵感触发器·联想画布 **11 项**（用户 2026-09-12 两条：「节点会被一块地方挡住，看不全 / 移出视窗时视窗不跟着移」→「**现在有边界了，向上拖不动节点了，我想要无限画布**」）：★1 滚到底时**画布顶部不被 sticky 工具条压住**（`stageTop ≥ barBottom`、`stageBottom ≤ vh`、画布顶部那一圈 `elementFromPoint` 归画布、高度 ≥ vh×0.7）、★2 鼠标停在**画布上**滚滚轮真能滚页面（找的是真滚动容器 `.lk-tool-slot`，不是写死的类名）、★3 拖到右边缘**按住不放**→视窗自己往右推且节点**一直贴在鼠标下**、★3b **越过旧世界右墙继续推**（没有边界）、★4 松手后推力立刻停、★5 反向拖到左边缘 → 越过原点继续走（左边同样没墙）、★7 **向上拖节点**：世界坐标真的变小（可以 < 20、甚至为负）+ 贴上边缘时 `panY > 0`、★8 松手即真的松手（之后的指针移动不再带动节点 + 贴边推停住；**原来断言"坐标一动不动"，`PIN_YIELD` 之后已改判据**）、★9 跑到**框外的连线照样画出来**（含 A/B：把 SVG 的 `overflow` 改成 `hidden` 时同一点 `elementFromPoint` 就打不中）、★6 无未捕获异常。⚠️ 自动推视窗是 rAF 驱动的 ⇒ 断言前必须 `forceFrames()`（见铁律 6） |
| `assoc-pull.cjs` | 联想画布**连线上的"拉力"6 项**（用户 2026-09-13：「**拉太远时拉力会失效**」→「线没断，但是拉力失效了，是不是数据溢出的问题」）：★1 拖拽**全程**就是"线被拉住"（往"离开根"的方向拖 150px，间距不许被拉长；A/B：修复前根词位移 **1px**、线从 148 拉成 **291**，修复后 146/146）、★2 拖得近（< `PIN_YIELD 420`）松手后**它自己留在被放下的地方**（自身漂移 0，线由邻居过来收）、★3 **两端都被手工摆过** + 拉太远 → 钉子失效、间距收回静止长度（A/B：修复前 `4477 → 4477` 永远回不来）、★4 丢到 **40 万像素外**不出 NaN/Infinity 且仍在被往回拉（否定"数据溢出"这个猜测）、★5 无异常。⚠️ 它把 `window.fetch` 换成固定 5 个词（`雪狼/冻湖/松林/极光/猎户`）—— 没有 ollama 时图里只有根词、**没有边就无从断言拉力**；落点夹在画布内（拖出画布会触发贴边推视窗，测到的就不是弹簧）；★1 必须**沿"根 → 被拖词"方向往外拖**（见铁律 9） |
| `seed-evolution.cjs` | 前置（**只许跑在测试目录**）：3 个事件节点（年份 **315 / 327 / 350**，帧要按锚点时间排序）+ 2 条实体（角色·银发少女 = 被测；物品·霜纹剑 = 验"历史各归各的"）+ 把 JSON 的 `timeCursor` 设成 **3.1e10**（≈公元 1000 年，**一定在所有节点之后**）。⚠️ 这是唯一**不依赖历法换算**的写法：只要 epoch 随年份单调，就能断言"最近的那一帧"是最后一帧。⚠️ 它还**自己写实体类型的字段模板**（`worldsets[ws].entityTypes`）并在世界/时间线缺失时建出来 —— 继承来的目录里「角色」可能只有一个字段，`setField('年龄')` 会静默无效（2026-09-13 踩到：七条断言一起报假 FAIL） |
| `entity-evolution.cjs` | 演变（实体版本历史）**38 项**（用户 2026-09-13：「我想在设定库右侧加一条竖着的等距的时间线…当选中实例时，默认进入离当前指针最近的 git」+「都做吧，把模式放到设置里面」+ 次日上午「**我希望没有版本的节点就不显示**」+「**默认创建了一个滚动条，去掉吧**」+ 下午「**能展开未创建 git 的节点，但虚化显示**」）：★0/★0b 没有版本时帧条只有「初稿」一格、但「记到」下拉里三个事件都在（默认离指针最近）、★0c 每格**等高**（等距）、★0d **面板外壳开销 ≤130px**（这条滚动条的账）、★0e~★0h **展开虚化行**（默认收起且底部写"还有 N 个没版本"；展开后 3 个没版本的事件**按时间** 315/327/350 插进时间线、`opacity` 实测 **0.4**、点虚化行 = 换「记到」+ 该行标「记到」、**不动正在看的版本**、再点收起）、★1 没有版本时默认落初稿、★2/★2b 帧条不列没有版本的节点且底部写明落点、★3 **手动模式**站在初稿改字段 = 改**初稿**（frontmatter 变）且**不产生帧**、★4/★4b 选「记到 第一次魔潮」+ ＋记一帧 → `.md` 出现 `#演变：` 段（锚在 n-evo-2）、帧条多一格且**视图跟过去**、★5/★5b 改字段进**那一帧的 patch** 而初稿不动（中栏显示的是这一版的值）、★6/★6b 切回初稿看到初稿的值、★7/★7b/★7c 改正文 → **行级 hunks**（不是整段）且初稿正文没被改写、切版本正文也不同、★8 换另一条实体不串台、★9 **默认落在离沙盘指针最近的那一帧**、★10/★10b/★10c/★10d/★10e **自动模式**把改动记到「记到」那个事件上、新帧是**增量**、且自动建的那版也上帧条、★11 点初稿那一格看到初稿、★12/★12b/★12c **锁定模式**视图与落点都钉在锁定帧、★14/★14b/★14c 删帧先弹确认、只删那一帧、删掉当前这版后退回前一版、★13 无异常。⚠️ 读 `.md` 必须**轮询等写下去**（见铁律 11）。⚠️ **已知偶发 34/38**（约 2/10 次，★5/★5b/★10d/★14b 一起挂）：内存里的改动被一次旧快照回扫盖掉，机制与调查见 `docs/BUGS.md` 第二十一轮「七」；套件开头已**显式复位设置**（★12 会把模式改成"锁定"且不复位），重跑请重新播种 + 重启实例 |
| `vault-rescan-race.cjs` | 「写盘在飞时来的回扫」**6 项**（为上面那条偶发写的守卫）：★0/★0b 前置（这一版已建好 + 塞 30 个实体把写盘窗口拉长）、★1 **死等节点 `.md` 的 mtime 变化 = 抓到写盘刚开始的那一刻**，立刻改**另一个**实体的 `.md`，逼 watcher 事件落进写盘飞行中 —— 断言「刚改的字段不许自己变回去」（采样里不许出现非 19）、★1b 那一帧的 patch 落进 `.md`、★2 **外部改动仍然要能回扫进界面**（防"靠永不回扫换绿"）、★3 无异常 |
| `storyline-world-history.cjs` | 沙盒顶部「剧情线 / 世界历史」下拉 **8 项**（用户 2026-09-13：「**世界沙盒中从剧情线切换到世界历史再移动指针时会导致跳回剧情线**」）：★0 前置（下拉在、至少一条剧情线；**id 从选项里取，不写死**）、★1 选「世界历史」**当场**不被改回去、★2 移动指针后仍是世界历史、★3 世界历史 = 不聚焦（`#lk-story-mask` 子元素 0 段）、★4/★4b 切回剧情线照常生效且遮罩回来、★5 点笔刷（另一条重画下拉的路径）后仍是世界历史、★6 无异常。A/B：修复前 4/8（★1/★2/★3/★5 挂）。⚠️ 要对着**有剧情线的数据**跑（`%TEMP%\lk-story` = 真实数据副本） |
| `cold-start-evolution.cjs` | 演变**冷启动 9 项**（承接上一条跑完的数据）：帧还在（亮格数 = 文件里的帧数）+ 摘要正确 + 默认落点仍是最近的那一帧 + **物化正确**（界面末版 = 初稿 + 全部帧，与脚本里独立算的一份比对）+ 切初稿只剩初稿值 + 正文也按版本取 + 无异常 |

启动补写那条单独跑一次：

```powershell
node tools\e2e\seed-json-only-entity.cjs     # 播种 JSON-only 实体
# 起应用（同上面的 Start-Process）
node tools\e2e\startup-materialize-entity.cjs
```

设定库工作台那几条（编辑节点 + 左栏两种形态）跑一次：

```powershell
node tools\e2e\reset-entity-vault.cjs
node tools\e2e\seed-node.cjs                 # 播节点 + 种类模板 + 一条有正文的实体
# 起应用（同上面的 Start-Process）
node tools\e2e\codex-node-tab.cjs            # 18 项
node tools\e2e\codex-tree-view.cjs           # 30 项（两种左栏形态；结尾会把形态复位成列表）

# 另一轮：换条目串不串正文（先 reset，不用 seed）
node tools\e2e\codex-switch-target.cjs       # 7 项
```

**文件夹树的语义那条**用独立目录（`lk-edtree`）—— 它要"有节点的种类"和"空种类 / 与实体类型重名的种类"同时在 `formats.json` 里：

```powershell
$env:LINGKUANG_TEST_DATA="C:\Users\<你>\AppData\Local\Temp\lk-edtree\worldbuilding.json"
$env:LINGKUANG_VAULT="C:\Users\<你>\AppData\Local\Temp\lk-edtree\vault"
$env:LINGKUANG_TEST_USERDATA="C:\Users\<你>\AppData\Local\Temp\lk-edtree\userdata"

# ⚠️ 全新目录先起一次应用（让应用写出 worldbuilding.json），再播种
node tools\e2e\seed-editor-tree.cjs          # 整份写 formats.json（事件 有节点 / 战斗 空 / 角色 空且与实体类型重名）
# 起应用（同上面的 Start-Process，端口 9704）—— formats.json 是启动时读的，播完必须重启
node tools\e2e\workbench-tree-folders.cjs    # 31 项
```

**设定库"换条目不发刷新"那条**用独立目录（`lk-smooth`）—— 它要 3 个不同类型的实体 + 一个能被左列撑高的列表：

```powershell
$env:LINGKUANG_TEST_DATA="C:\Users\<你>\AppData\Local\Temp\lk-smooth\worldbuilding.json"
$env:LINGKUANG_VAULT="C:\Users\<你>\AppData\Local\Temp\lk-smooth\vault"
$env:LINGKUANG_TEST_USERDATA="C:\Users\<你>\AppData\Local\Temp\lk-smooth\userdata"

node tools\e2e\seed-smooth-switch.cjs        # ⚠️ 会清空测试世界的 _设定/主线/.trash
# 起应用（同上面的 Start-Process）
node tools\e2e\codex-smooth-switch.cjs       # 16 项
```

⚠️ 这条**改完界面后要重跑**（重跑前重新播种 + 重启实例：套件会把面板停在时间线节点上、并改掉几条正文）。
⚠️ A/B（验证断言真有判别力，见铁律 9）：`git checkout -- src/ui/codex.ts` + `vite build` 复跑 ⇒
**未修复 8/16**（★1/★2/★3/★6/★8/★9/★10/★14 挂），修复后 16/16。

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

## 铁律 10：**别让"上一次的动画"污染这一次的断言**（等基线，别用固定 sleep）

写「换条目不再重播错峰」时踩到：点了实体之后读 `#cx-root`，发现它**带着** `.lk-enter-stagger`、
子项还有行内延迟 —— 差点判成"又播了一遍"。真因是**工具打开那一次**的错峰还挂着：

- `openTool()` 的错峰目标是「工具根部的顶层块」：`slot.children.length >= 2 ? slot : slot.firstElementChild`。
  **codex 的工具格只有一个子元素**（`#cx-root`）⇒ 那一次的错峰类与行内延迟就落在 `#cx-root` 上；
- 隐藏窗口里动画不推进 ⇒ `animationend` 不会来，类只能等 `cascadeIn` 的兜底定时器
  （`maxDelay + 2000` = 2500ms）摘掉。而工具是**动态 import** 的，错峰起点比"点工具"晚几百毫秒，
  所以"点完睡 2800ms"正好压在边界上 —— A/B 那次就翻车（同一条 ★0 一次过、一次挂）。

做法：**轮询到基线干净再开始**（比固定 sleep 稳，也说明白我们在等什么）：

```js
const clean = `(() => { const r = document.querySelector('#cx-root');
  return !!r && !r.classList.contains('lk-enter-stagger')
    && [...r.children].every((c) => !c.style.animationDelay); })()`;
for (let i = 0; i < 32; i++) { if (await ev(clean)) break; await sleep(250); }
```

同族的第二条：**要断言"滚动位置不回顶"，得先让内容真的能滚**。
`#cx-root` 是 `overflow:auto; height:100%`，内容没超过可视高时 `scrollTop` 恒为 0 ——
断言就成了空过（修复前也过 ⇒ 假绿）。实测（窗口 1180×780、可视高 741）：8 段正文 + 4 个字段的实体
`scrollHeight` 只有 741，11 个字段的角色才 846。所以要么把正文写到够长，要么**让左列自己撑高**
（`seed-smooth-switch.cjs` 播 20 个配角就是干这个的）。另外注意：换到**内容更短**的条目时，
浏览器会把 `scrollTop` 夹回可滚范围（甚至 0）—— 那是正常行为，断言别写成"任何情况都必须相等"。

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
「换到另一类别的行」挂、`data-load-clean` 0/6（它会如实报告 `locked:true` + `attempts:4`）。
当时我按「产品坏了」排查了一轮，最后 `Get-ChildItem` 看到 `worldbuilding.json` **0 字节**、mtime
与播种同一秒才定案 —— **回归挂了先看盘中文件的实际大小与 mtime，再怀疑代码。**

补救：**0 字节的数据文件不会自愈（这是判损护栏的设计）**，要从同目录的
`worldbuilding.backup-N.json` 拷回来（`Copy-Item worldbuilding.backup-0.json worldbuilding.json`），
再删掉那几份 `worldbuilding.bak-corrupt-*.json`（否则 `data-load-clean` 的 ★4「没有凭空生成损坏副本」会挂）。

## 演变（实体版本历史）那条

```powershell
$env:LINGKUANG_TEST_DATA="C:\Users\<你>\AppData\Local\Temp\lk-evo\worldbuilding.json"
$env:LINGKUANG_VAULT="C:\Users\<你>\AppData\Local\Temp\lk-evo\vault"
$env:LINGKUANG_TEST_USERDATA="C:\Users\<你>\AppData\Local\Temp\lk-evo\userdata"

node tools\e2e\seed-evolution.cjs          # 3 节点（315/327/350）+ 2 实体 + timeCursor 设到所有节点之后 + 实体字段模板
# 起应用
node tools\e2e\entity-evolution.cjs        # 38 项（会写入帧、最后删掉一帧）
node tools\e2e\vault-rescan-race.cjs       # 6 项：写盘在飞时来的回扫不许把改动打回去（接着跑即可）

# 重启应用（数据保留上一轮的结果）
node tools\e2e\cold-start-evolution.cjs    # 9 项：帧还在 + 物化正确
```

**剧情线 / 世界历史那条**要对着有剧情线的数据跑（`%TEMP%\lk-story` = 真实数据的副本）：

```powershell
$env:LINGKUANG_TEST_DATA="C:\Users\<你>\AppData\Local\Temp\lk-story\worldbuilding.json"
$env:LINGKUANG_VAULT="C:\Users\<你>\AppData\Local\Temp\lk-story\vault"
$env:LINGKUANG_TEST_USERDATA="C:\Users\<你>\AppData\Local\Temp\lk-story\userdata"
# 起应用（同上面的 Start-Process）
node tools\e2e\storyline-world-history.cjs  # 8 项
```

⚠️ **如果要一个全新目录**：先起一次应用让它写出 `worldbuilding.json`（数据文件不存在时
`seed-evolution.cjs` 读不到，会在第一步退出）—— 或者直接拿一个已有的测试目录当底。
2026-09-13 之前这里还依赖"底子里有 `测试世界观` 且「角色」字段齐全"，现在播种脚本自己写了（见上表）。

## 铁律 11：**要断言 `.md` 的内容，必须轮询等它写下去，不能固定 sleep**
`store.update` → 400ms 防抖（`src/main.ts`）→ IPC `vault:write-*` → 落盘，
再叠上 vault watcher 回扫，实际落盘时间随机器和上一个动作浮动。
第一版 `entity-evolution.cjs` 用 `await sleep(500)` 之后读文件，结果 ★3/★4/★7/★10c/★12b
**五条全报 FAIL**，读到的都是"上一拍"的文件 —— 当时差点去改产品代码。
改成轮询（`waitMd(path, pred)`，最多 6s）后同一份代码 27/27。

```js
const waitMd = (p, pred, ms = 6000) => waitFor(() => { try { return pred(read(p)); } catch { return false; } }, ms);
await ev(setField('发色', '墨黑'));
await waitMd(MD_A, (t) => fmValue(t, '发色') === '墨黑');   // ✅
// await sleep(500); const t = read(MD_A);                  // ❌ 会读到上一拍
```

同族提醒：**别把"动画/定时器有没有跑"混进这类断言**。判"写下去了没有"看文件；
判"动画播了没有"看 `getAnimations()` + `animationend`（铁律 6/7）。两者用了同一句
`sleep(500)` 的时候，挂起来会分不清是哪一边。

## 铁律 12：**别给容器留"常驻但没内容"的子项**（它会顶出滚动条，还会吃掉动画的收手信号）
设定库面板是 `height:100%` + `overflow:auto`：内容比窗口高**一个像素**就长滚动条。实测（1440×900、
真实数据 11 字段 + 一篇正文）只差 **3px**，而差的这 3px 来自"给底部那句状态提示预留的一行 + 松掉的内边距"
（A/B 过：与帧条无关）。⇒ `#cx-msg` 改成没消息时 `display:none`。

紧接着是第二层坑：`#cx-msg` 正好是 `#cx-root` 的**最后一个**子项，而 `cascadeIn()` 靠
"**最后一块**的 `animationend`"收手 ⇒ 它不播动画，那个事件永远不来，整组错峰只能等 2.5s 兜底定时器
（`motion-switch` ★6 当场抓到 `{cls:true, anims:3}`）。修法：`cascadeIn()` 跳过
`getClientRects().length === 0` 的子项（与它本来跳过 `.lk-own-cascade` 是同一条理由）。

守卫：`entity-evolution.cjs` ★0d（**外壳开销 ≤130px** = 面板总高 − 三栏那一行；与正文长短、窗口大小无关）
+ `motion-switch.cjs` ★6（错峰自己收手）。

**推论（断言要按这个写）**：既然 `cascadeIn()` 会跳过没有盒子的子项，**它们就不占错峰序号** ⇒
"第 3 块延迟 200ms" 这类断言**不能按 `children` 下标硬读**，要先 `.filter((x) => x.length)`。
2026-09-13 工作台加了一条 `#cx-hint`（平时 `display:none`，见下）之后，`motion-switch.cjs` 的
★1/★13 当场从 25/25 掉到 23/25 —— 不是动画坏了，是下标错位（dump 里第 3 项是 `[]`）。
同一条坑对"按子项数循环"的任何断言都成立。

## 铁律 13：**别把"有几块/有几行"写进断言**（要钉的是节奏与关系，不是快照）

同一天下午又踩了它的孪生兄弟：左栏重做撤掉工作台那一行页签之后，`#cx-root` 的可见顶层块
从 3 个变成 2 个 ⇒ `motion-switch.cjs` ★1/★8/★13/★15 里"至少三块""第 2 块 100ms、第 3 块 200ms"
全部作废（★8 甚至挂在 `a2b[1]` 这个 **display:none 的空位**上）。这不是产品回退，是断言把 UI 结构当成了契约。

- 钉**节奏**：`played[i].delay === i * 100`（块数随便变），`played.length >= 2`（下限而不是等号）。
- 钉**关系**：列表行按 `[data-cx-id]`/`[data-act=…]` 找，序号一律现算（`flatten` 后再比）。
- 界面结构是**可以变的**：它变了而断言没挂，才说明断言写对了。

## 真实数据副本冒烟（改完数据层之后跑一次）

**用途**：合成数据全绿 ≠ 用户自己的数据能用。这一条拿**用户真实数据的副本**跑一遍：
世界能不能加载、设定库右栏能不能画出来、**改一个字段会不会乱动别的文件**。
实测（2026-09-13，10 条实体 / 7 个节点 / 单世界）：8/8 PASS —— 改「艾德温·霜冠」一个字段后
**整座 vault 只有那一个 `.md` 的哈希变了**，其余 16 个文件一个没动，而且**没有凭空长出 `#演变：` 段**
（没有帧就不该有这个段 ⇒ 老数据不会因为装了这个版本被改写）。

```powershell
$real = "$env:TEMP\lk-real-evo"
Remove-Item $real -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $real | Out-Null
Copy-Item "$env:APPDATA\lingkuang\worldbuilding.json" "$real\worldbuilding.json" -Force
Copy-Item "F:\lingkuang-vault" "$real\vault" -Recurse -Force      # ← 必须复制，别指着真 vault 跑

$env:LINGKUANG_TEST_DATA="$real\worldbuilding.json"
$env:LINGKUANG_VAULT="$real\vault"
$env:LINGKUANG_TEST_USERDATA="$real\userdata"; $env:LK_CDP_PORT="9440"
# 起应用（同上面的 Start-Process，端口 9440）
node tools\e2e\real-data-smoke.cjs $real    # 8 项
```

⚠️ 脚本自己会改副本里的数据（改一个字段），所以**只许对着副本跑**；
⚠️ 它按名字找「艾德温·霜冠」与「初稿」等字样 —— 换一套真实数据时按实际情况改断言；
⚠️ 它比对的是**整座 vault 的 MD5**，所以跑之前别在别的窗口动同一份副本。
