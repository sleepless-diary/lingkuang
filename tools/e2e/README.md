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
| `codex-node-tab.cjs` | 设定库（工作台）里编辑**时间线节点** **18 项**（文件名是历史遗留）：★1 左栏**只有一棵树**（没有类别页签 `#cx-tab-*`、没有形态开关 `#cx-view`、没有筛选 pills `[data-cx-chip]` —— 守着"别再长出第二套控件"）→ ★2 **打开就是全展开**（时间线/种类/节点/`_设定`/类型/实体 一次点击都不用）→ ★3 点世界行**收起**、再点展开回来（默认展开 ≠ 不能收）→ ★4 层级顺序 = 硬盘目录 → ★5/★5b 种类层只有「事件」、节点行就在树里 → 公共属性面板固定行 → **★9b 提交字段后面板不重建**（元素身份不变；★9c 那一次提交确实落进了 `.md`，防"什么都没发生"式的假绿）→ 改描述/正文落到节点的 `.md` → 搜索 → **换到另一类别的行**后正文不串文档。⚠️ ★9b/★9c 原来在 `editor-props-panel.cjs` 里，编辑器工具并进工作台后搬过来（用种类模板字段「地点」当探针，不动标题 —— 标题会改文件名，而本套件按固定路径读文件） |
| `codex-tree-view.cjs` | 工作台左栏的**形态守卫 21 项**（用户 2026-09-13 三句话的终态：「设定库和编辑器是不是可以做成同一工具的两种不同形式啊（在设置里面切换）」→「时间线节点和实体这两个按钮，列表和文件夹树的功能有点混乱，能不能重新设计一下」→「**要不这样，把全部改成文件树的形式，这样子也方便看**」）：★1 **只有一棵树**（世界层 1 个、页签/形态开关/pills 全为 0）→ ★2 **默认全展开**（各层都在，无需点击）→ **★2b 形态与旧键 `workbenchView` 无关**（自足地把它写成 `list`，左栏照样是树）→ ★3 时间线分支与 `_設定` 分支同框、顺序 = 硬盘目录 → ★4/★5/★6 种类只列真有节点的 / 类型列全部（空的置灰 + 一句人话）→ ★8/★9 点实体行 = 就地换中栏/右栏（名字/字段/帧条 + 该行高亮）且**左树没被换掉** → ★11 点节点行（面包屑 + 属性面板）→ ★12/★13 搜索跨类别命中且摊平成列表、清空后回到树 → **★15 收起的那一枝在左列重画之后仍然收着**（collapsed 语义）→ ★17 再点展开回来 → **★18 设置面板里不再有「工作台默认形态」那组单选**。⚠️ 它需要**有空类型**的前置（`reset-entity-vault.cjs` + `seed-node.cjs`），跑到别的目录上会挂 ★5/★6 |
| `seed-editor-tree.cjs` | 前置：给**文件夹树的语义**造确定起点 —— **节点种类** `事件`（**有 2 个节点** ⇒ 该出现在时间线下）+ `战斗`（**一个节点都没有** ⇒ **不该**出现）+ `角色`（没有节点、且与实体类型同名 ⇒ **不该**出现，用户 2026-09-13 报的「角色/地点/物品等文件夹同时存在于主线与设定文件夹下」就是它）；**实体类型** `角色`（1 个实体）+ `地点`（**一个实体都没有** ⇒ 该出现，设定侧列全部类型）。⚠️ 它整份写 `formats.json`（`main.js` 的 `loadFormatsRaw` 只要文件能解析就**直接用**、不跟内建合并）⇒ 空种类能不能出现在树里完全取决于这份文件。⚠️ formats.json 是**启动时读**的 ⇒ 播完要重启应用；⚠️ 全新目录要**先起一次应用**写出 `worldbuilding.json` 再来播种 |
| `workbench-tree-folders.cjs` | 工作台文件夹树的**文件夹语义 29 项**（从原 `editor-tree.cjs` 搬过来的那批断言；编辑器工具下线后它是这套语义唯一的守卫）：★0 打开就是树 → ★1/★3 世界与时间线**默认就展开**（`rowOpen` 读 `is-open`；⚠️ 默认全展开之后"点一下"是**收起**，所以这里不许再瞎点）→ ★4 有节点的「事件」计数 2 → **★5/★5b/★5c 有定义但一个节点都没有的「战斗」「角色」不许出现在时间线下、时间线下的种类只有真有节点的那些**（★15 全树里「角色」只出现一次且在 `_设定` 下）→ ★10/★11 同一棵树里有 **`_设定`** 分支（计数 = 实体数）+ **★11b 缩进与「主线」一致（`paddingLeft` 都 18px，且 ≠ 世界行的 8px）** → ★13/★14 实体类型**全部列出**，空的「地点」同样置灰 + 一句「这个类型还没有实体」→ ★19 类型下有实体行 → ★20~★26b 在树里点实体行 = **就地**换中栏/右栏（★22 **树没被换掉**、★23/★23b/★23c/★23d **世界/时间线/种类文件夹都还在、`_设定` 仍展开**、★23e 该实体行高亮、★24~★26 名字/正文/字段都换成该实体、★26b 之后**收起再展开 `_設定`** 仍在编辑这个实体、高亮与展开态都回来）→ ★27 无异常。⚠️ 移植时踩到的坑：`_設定`（繁体）与界面里的 `_设定`（简体）不是同一串 —— 按标签点行会静默点不中，后面一片 FAIL 全由它引起 |
| `codex-switch-target.cjs` | 不变量：换条目不能把上一条的正文写进下一条（按 `.md` 文件断言正文归属；走「不失焦就切」的危险路径） |
| `workbench-add-node.cjs` | 工作台顶栏的**新建**（直接建节点 + 类型跟随 + 一次建多个 + 「待填」强调 + **落在时间指针那一年**）**19 项**（用户 2026-09-13：「添加实体按钮在事件节点中其实可以改成添加节点的，毕竟万一用户不知道添加事件节点要在世界沙盒怎么办」→「添加节点就直接添加节点吧，就像添加实体一样」→ 当晚又提「我想要当前选中的是哪个分类就自动在当前分类下创建实体，还有我希望能同时创建多个未填数据的实体或者节点（**强调显示一下就行**）」→ 深夜再提「**新建节点时直接插入尾部然后移到正确的顺序，能不能直接插入到对应的位置**」「**新建实体左边两个按钮有什么用**」）：★0 进节点态后顶栏换成「时间线 ▾ + ＋新建节点」（实体那组 `display:none` 且 `disabled`，下拉默认 = **正在看的那条时间线**）、**★0b 两组控件各有说明小字**（`#cx-newbox .lk-newlbl` 的文本序列 = `类型|数量|时间线|数量`）、★1 点一下树里多一行「新节点」且**没有**弹出表单、★2 工作台选中了它（面包屑 `#cx-nodepath` = 世界观·时间线·种类、中栏标题字段 = 新节点、左树高亮在它身上）、★3 它落进 `vault/<世界>/主线/事件/新节点.md`（**种类跟着正在看的那条**）、★4 中栏改名 ⇒ 文件跟着改名、旧的「新节点.md」不留第二份、★5 id 没变（是改名不是新建）、★6 左树那行跟着改、**★8 类型跟随**（把正在编的那条的类型改成「地点」⇒ 顶栏 `#cx-new-type` 跟着到「地点」；断言特意比"**不等于第一个选项**"，否则"没跟随"也能读到第一项 = 假绿）、**★9 一次建 3 个**（树里多 3 行且名字唯一：新实体 / 新实体 2 / 新实体 3）、**★10 这 3 条都带「待填」**（`is-stub` 类 + `.ed-ttag` 文本）、**★11 三条都落进 `_设定/<类型>/`**、**★12 换条目时也跟上**（手动把下拉拨到别的类型 → 点回「银发少女」⇒ 回到它自己的类型）、**★13 改过名就不算「待填」**、**★14 节点侧也能量产**（数量框 2 ⇒ 多 2 行且都落 `.md`）、**★15 树里的节点按时间排**（`$env:LK_SEED_ORDER="1"` 播种会多一个 `year:1` 的「上古」⇒ 它排到 `year:312` 的「王国的建立」**前面**）、**★16 新建的节点年份 = 时间指针那一年**（`timeCursor` 设在 year 200 ⇒ 新建出来 `appliedYear = 200`，不是旧默认的 0）、**★17 新节点落在正确的位置**（上古(1) < 新节点(200) < 王国的建立(312)）、★20 无异常。⚠️ 它会把节点与实体改名/改类型 ⇒ 前置必须 `reset-entity-vault.cjs` + `seed-node.cjs` 重播一遍；A/B（`git checkout -- src/ui/codex.ts` + `vite build`）**9/19**（挂的正是 ★8~★17） |
| `seed-smooth-switch.cjs` | 前置（**只许跑在测试目录**，它会清空测试世界的 `_设定`/`主线`/`.trash`）：3 个**不同类型**的实体（角色/地点/物品，字段集合不同）+ 2 个节点 + **34 个「配角」实体**。配角是为了让**左列自己就撑得比可视区高** —— 否则「换条目后滚动位置不回顶」这条断言没有可滚的余地（中栏高度随字段数变，靠正文撑高度既费字又不稳）。⚠️ **这个数字是算出来的**：列表行改成 `.ed-tnode` 的样式（行高 21-24px）后，20 个配角撑不到中栏那么高（实测 `#cx-root` over=0 ⇒ 面板不可滚 ⇒ ★0/★6 假挂），算法 = 行高 × 行数 > 中栏高度（1440×900 下 11 字段的角色 ≈ 743px）。正文写在**闭合的 `---` 之后**：第一版把 `#正文：` 塞进了 frontmatter，结果实体 doc 全是空串、断言一片 FAIL |
| `codex-smooth-switch.cjs` | 设定库**换条目/换类别不发"刷新"**28 项（用户 2026-09-13：「点击实体会刷新界面，我希望变成平滑切换」→ 下午又报「从事件节点切换到实体节点时，事件节点保持选中状态，且面板刷新」→ 深夜再报「切换时元素 y 坐标会变，**应该是增加实体按钮的出现与消失导致的**」→ 当晚再提「演变窗口消失时编辑页的切换很生硬，顺便再给演变做一下出入场动画」）：★1/★2/★3 换实体后 `#cx-root`/`#cx-search`/`#cx-doc .ProseMirror` **还是同一个元素**（骨架/编辑器没被重建）、★4/★5 名字+字段行+正文都换成新条目的（字段集合真的换了）、★6 **滚动位置不回顶**（`scrollTop 260 → 260`；旧实现换掉滚动容器 ⇒ 恒 0）、★7 左列高亮跟过去（`.is-on` 类，不再是行内背景色）、★8 **不重播整块错峰**（无 `.lk-enter-stagger` / 无 `lk-wake` / 无行内延迟）、★9/★10 内容区播的是**行级 WAAPI**（幽灵往左退场 + 新内容从右入场）且终态不透明无位移、★11/★12 打字后不失焦直接换条目**正文归属不串**（编辑器跨条目复用带来的新风险）、★13 **换类别**（点另一类别的那一行，实体 → 时间线节点）也**就地**换（骨架同一元素、无整块错峰、改播行级转场、实体行高亮清零 / 节点行高亮正好 1 个）、**★13b 换类别时"框"一动不动**（左树/中右栏/顶栏那组控件/**帧条**的 top 相同、`#cx-newbox` 高度恒 28px、节点态显示的是「＋新建节点」那组而实体那组藏起来并禁用）、**★13c 帧条是"演"着收起来的**（元素常驻 + `.is-off` + `transitionProperty` 含 width + 过渡对象里有 width/margin-left 且时长 > 0 + 起点 176px/不透明、终态 0×0/透明 + **同一 tick 里高度必须还撑着** `h1 > 0` 且没有 `.is-collapsed`）、**★13c2 演完之后才 `.is-collapsed`**（宽高都 0；用户 2026-09-13 深夜报的「从设定文件切换到节点文件演变面板会**直接消失**」就是 `height: auto → 0` 被瞬时吃掉）、★14 节点→节点也就地换且中栏属性面板跟着换、★14b 换回实体同样就地换、★14c **换回实体后节点行的高亮必须消失**（+ 高亮落到实体行、帧条回到原宽、中栏字段与正文都是该实体的）、**★14d 绕一圈回来（实体 → 节点 → 实体）框的位置与高度与出发时逐项相同（含帧条的宽/高）**、**★13g 顶栏两组控件各带说明小字**（`.lk-newlbl` 的四个标签：`类型|数量|时间线|数量`）、**★13d/★13d2/★13d3 共享按钮的"老虎机滚字"**（用户 2026-09-13 深夜：「**新建实体按钮里面实体和节点文字的切换做成类似老虎机的上下切换**」→ 2026-09-14 又报「**新建实体按钮文字会重叠**」+「**我希望滚动的只有实体和节点两个字**」—— 现在**只有那两个字在裁切盒里滚**，不动的「＋新建」在盒外：★13d 断言 `fix === '＋新建'` + `label === '节点'` + 拼起来是「＋新建节点」，★13d3 断言**滚动距离 = 裁切盒高度**（写死 13px < 一行字高 16px 时两行字在盒里叠着 = 用户报的"文字重叠"），**★13d4 断言两段错开播**（新字 `delay === 旧字 dur`：同时播时两行字各露半截、又都半透明，看着仍是糊成一团 —— 用户 2026-09-14 第二轮「节点和实体两个文字会重叠」），★13d2 演完 `.lk-roll__prev` 归 0 个且标签身上没动画（**轮询**判，见铁律 19）、**★13e 盒里的字与「＋新建」在同一水平线上**（用户 2026-09-14：「实体和节点两个字的位置**偏下**了」—— 裁切盒是 `overflow:hidden` 的行内块，靠 `vertical-align:middle` 摆位时盒里的字实测比「＋新建」**低 1.81px**；修法 = 按钮 `inline-flex + align-items:center`；量法 = 用 `Range` 取**字体框** top/bottom 逐项比，**别量元素盒**（盒高还含行高）。⚠️ 计算值可能是 `flex` 而不是 `inline-flex` —— 按钮是 `#cx-newbox` 这个 flex 容器的子项，行内级 display 会被块化 ⇒ 断言写成 `/^(inline-)?flex$/`。A/B：把 flex 去掉 ⇒ 27/28，只挂 ★13e）。⚠️ 读按钮文字**不能**用 `btn.textContent`（这一刻盒里还挂着克隆的旧字，会读成「＋新建节点实体」），要"盒外前缀 + 真标签"拼起来）、★15 无异常。⚠️ 断言前必须**轮询等上一次错峰收手**（见铁律 10）；⚠️ 量几何要换算到内容原点、动效先推终态（见铁律 16/17）；⚠️ 行**仍然**按 `[data-cx-id]` 找（树上的实体行带着这个属性，旧套件才不用改） |
| `seed-corrupt-data.cjs` | 前置：造出「截断的 `worldbuilding.json` + 空 vault」（= `docs/BUGS.md` 记的那条数据损失场景；**空 vault 是关键**，否则 vault 会兜住） |
| `data-corrupt-guard.cjs` | 判损护栏 16 项：截断文件启动后**原文件逐字节未被覆盖** + 副本隔离 + 重读过（`attempts>1`）+ `data:save` 被拒且标明 `locked` + 壳级横幅两条出口 + 点「继续用新数据」解锁并自愈 + 中途补全的文件被重读捞回 |
| `data-load-clean.cjs` | 误报守卫 6 项：**干净**数据启动时护栏一步都不该动（`attempts===1`、无横幅、无副本、写盘照常） |
| `codex-swap-motion.cjs` | 设定库**换条目转场 14 项**（用户 2026-09-13 深夜：「算了，就这样吧，**直接落地吧**，相关设置写入设置面板」——做法 P 从演示页 `docs/motion-demo/doc-slide.html` 落地）：★1/★2 换实体时旧内容被做成一层 `.lk-cx-ghost` 幽灵（且**克隆体里没有 id** —— 否则会多出第二个 `#cx-doc`/`#cx-fields` 把 `querySelector` 引错）、★3 出场关键帧 `1/none → 0/translateX(-32px)` + `cubic-bezier(0.7,0,0.84,0)`（慢→快）、★4 入场 `0/translateX(32px) → 1/none` + `cubic-bezier(0.16,1,0.3,1)`（快→慢）、★5 **先出后进 + 逐行错峰**（出场 0/10…、入场 300/310…）、★6 整块容器自己**没有**动画（框不动）、★7 终态行归位且幽灵自己消失、★8 设置里关掉开关 → 瞬时换（无幽灵无动画）、★9/★10 三个旋钮真的生效（错峰 30ms → 0/30/60…；入场距离 60px → 关键帧跟着变；速度 0.5× → 300→600ms）、★11 同一同步块连点三下只留**一层**幽灵、终态 = 最后点的那条、★12 无异常。⚠️ 前置是 `seed-smooth-switch.cjs`；⚠️ `getKeyframes()` 里的数值是**字符串**（见铁律 15） |
| `codex-list-motion.cjs` | 左树**行级动效 25 项**（用户 2026-09-13 深夜：「**新建实体和节点时不是硬切换，而是从左侧滑入（就像正文的入场一样），其下的所有节点都向下平滑移动（删除时也一样），展开文件夹时文件向下弹出**」）：★1/★1b 新建出来的行 `translateX(-24px)/0 → none/1`（从**左侧**滑入）且逐行错峰 0/30/60、★2 其余行 **FLIP** 让位（`translateY(±旧-新) → none`，320ms；**方向不写死** —— 新行插在上面就向下、插在下面就向上）、★3/★3b 展开文件夹露出来的行 `translateY(-8px)/0 → none/1`（错峰 22ms）、★4/★4b 收起种类 → 下面的行向上补位；再展开 → 向下让位 + 新行下弹、**★4c/★4c2/★4c3 收起文件夹时里面那些行先变成钉在原位的幽灵再退场**（用户 2026-09-13 深夜：「**设定文件夹收起时无动画，收起时下面的文件直接消失**」→ 2026-09-14 又定姿势：「**文件出场动画改成入场的反向就行了**」——幽灵挂 `document.body`、类 `lk-list-ghost`、文字就是那一行，退场 = **展开入场 `rowsDropIn` 的倒放**：`none/1 → translateY(-8px)/0`（往上 8px 升走、150ms、错峰 12ms、曲线倒成慢→快；**错峰顺序与入场一致**（0/12/24…，自上而下）—— 第一版 `[...ghosts].reverse()` 让"最后落地的先走"，用户当场指出「**没有像入场一样的错分**」），演完自己摘掉；**★4d 幽灵必须长在原位**（`padding-left` 与水平位置跟原行逐项相同 —— 用户：「收起文件时文件会**先向左移**，然后再上隐」，真因是克隆体上写了 `padding:0` 把各层类的缩进清零了）、**★4e 退场错峰同序且总量 ≤96ms**（不限量时 44 行会让第一行等 946ms 才动）、**★4f 收起时"下面的行补位"要等这一枝退场**走完**（一行都不许提前；2026-09-14 第三轮用户：「文件收起时下面的文字会**重叠（多出来一份）**」—— 中间试过"咬合 55%"（提前 40ms 起跑）来消掉"停一拍"，实测那 55ms 里幽灵还半透明、补位行已滑进同一位置 ⇒ 同一行文字两份；现在首行 delay 必须**正好等于**退场总时长、其余行 ≥ 它）⇒ `collapse()` 把 `rowsLeaveTotal()` 写进 `flipDelayMs`，`renderList()` 交给 `flipRows(..., {delay, step, maxDelay})`，且必须 `fill:'both'` 冻在旧位置；实测收「事件」：1 个幽灵 0 + 150 ⇒ 退场总时长 **150ms**，下面那些行 FLIP 从 **150** 起按 14ms 一档往后排（封顶 120ms）**、**★4k 补位的行"越高的越先移"**（用户 2026-09-14：「文件夹收起后其下文件上移**错分方向反了**…现在是越下面的越先移」；A/B 旧代码：所有行 delay 都是 `99` = 整块一起动）；★4c2 直接拿 ★4b 记下的入场关键帧反过来比，不各写各的字面量；⚠️ 断言必须**先记下点击前 `document.body.children`、只认这一批刚冒出来的幽灵**，同一时刻可能还挂着上一批，实测 `before:1, ghosts:6`）、★5 删除确认后被删那行留一个**钉在原位的幽灵**（`position:fixed`、挂 `document.body`、文本 = 那一行的名字）、★5b 幽灵演 `none/1 → translateX(-24px)/0`（慢→快）、★5c 同时下面的行 FLIP 补位且行数 -1、★5d 幽灵演完自己摘掉（不留浮层）、★6 系统「减少动态效果」时新建照样完成但**一次动画都不演**、★7 无异常。**量法**：动画只在**点下去那个 tick** 里抓得到（`autoRelease` 会在 `dur+800ms` 后取消）⇒ 点击与读数必须写在**同一个 eval**；隐藏窗口里动画不推进，但**参数**（关键帧/延迟/时长）读得到。⚠️ 前置 = `reset-entity-vault.cjs` + `seed-node.cjs`；⚠️ **本套件会建 5 个实体、删 1 个** ⇒ 重跑必须重新播种并重启实例，而且**别紧跟 `workbench-add-node.cjs` 在同一个实例里跑**（那样跑 14/17，是脏状态假挂）。**A/B（`git stash` 掉 motion.ts/codex.ts/evolution-rail.ts/style.css + rebuild）15/17**（挂 ★4c/★4c2）；2026-09-14 给 ★4f 单独做过一次 A/B：把 `flipRows` 的 delay 写死 0 ⇒ **19/20**（只挂 ★4f） |
| `settings-panel.cjs` | **设置是悬浮面板 12 项**（用户 2026-09-13：「我希望设置面板是悬浮面板，而不是单开一个标签页」）：★0 前置（设定库开着、设置按钮在左栏最底下）、★1 点它开出一层 `position:fixed`、挂在 `document.body` 上的面板（卡片 `lk-pop` 320ms + 遮罩 `lk-fade` 180ms）、★2 **主区一动不动**（`#cx-root` 同一元素、`#lk-module-view` 的 HTML 长度没变、模块视图仍显示、按钮亮着）、★3 面板头是「设置」且四张卡片都在（联想引擎/画布偏好/设定演变/**换条目转场**）、★4 拖一次转场滑块**立刻**写进 `localStorage`（不用点保存）、★5/★6/★7 三种关法（Esc / × / 点遮罩空白；**点卡片内部不关**）、★8/★9 再点一次按钮＝关（开关语义，`lingkuang-panel` 事件同步高亮）、★10 用过设置后回到原处（工作台同一元素、树还在、按钮不亮）、★11 无异常 |
| `agent-panel.cjs` | 灵框助手**面板 16 项**（用户 2026-09-15：「ai 真的工作，类 agent…有一个自己的对话框…有记忆…还有一个全局快捷键」）：★0 前置（设定库开着）、★1 `Ctrl+K` 开出来的是 `position:fixed` / 贴右 / 宽 380 的面板、★2 **主区一动不动**（`#cx-root` 同一元素 + `#lk-module-view` 的 HTML 长度没变）、★3 头行与输入框都在、★4 「正在编」焦点 chip（`正在编：银发少女` / `正在编事件：王国的建立` / `最近在看：X` / `没打开条目`）与模型 chip（实测 `本地 · qwen2.5:7b`）、★5 **上下文打包**（`#lk-agent-ctx` 里有 `【工作区】当前世界「测试世界观」`/`【当前时间线】主线（1 个事件）`/`312 王国的建立·事件`/`【创作者此刻打开的那一条】设定「银发少女」（角色）` + **`文件：测试世界观/_设定/角色/银发少女.md`**，且**焦点块排在 `【设定】共` 之前**）+ 字段与正文）、★6 ⭐**换个条目焦点跟着换**（`lingkuang-agent-focus`；换条目是 UI 状态、不一定动数据，所以不能只靠 store 订阅）、★6b ⭐**切到别的工具焦点只降级不清空**（chip 变 `最近在看：王国的建立`、上下文里那条与它的文件路径仍在、末尾有「现在切到别的功能去了」、**不是** `NO_FOCUS`）、★6c **切回工作台 ⇒ 升回「正在编」**（降级标记消失）、★7 盘上的历史进对话框、★8 IPC 落盘 round-trip（磁盘上是**裸数组**，不是 `{chat:[…]}`）、★9 Esc 关、★10 `Ctrl+K` 再按＝关、★11 左栏「助手」按钮也能开关、★12 **面板只有一格**（开设置 ⇒ 助手让位；关掉后主区没动、助手还能再呼出 —— `registry.ts` 只有一格 `disposePanel`，同一时刻只能开一个面板）、★13 无未捕获异常。⚠️ 前置 = `reset-entity-vault.cjs` + `seed-node.cjs` + **`seed-agent-chat.cjs`**（同一 pwsh 调用里做，再重启实例）；⚠️ 走 `LK_AGENT_DIR` → `dirname(LINGKUANG_TEST_DATA)/agent` → `%TEMP%/lk-evault2/agent` 找历史文件 |
| `agent-memory.cjs` | 灵框助手**长期记忆 + 三档权限 15 项**（片 2，用户 2026-09-15：「有记忆，能总结创作者的偏好等」+「和真 agent 软件一样，有禁止，部分执行和 YOLO 什么的」）：★0 前置、★1 面板里有记忆区与权限下拉（三档齐、**默认「逐项确认」**、`data-gate === 'propose'`）、★5 **启动时从磁盘读回来的那条偏好进了清单**（判据：`memory.json` 预置 `m-seed-1` —— 只在内存里加一条证明不了持久化）、★2 手动加一条（面板 + 磁盘同时多）、★3 就地改（磁盘旧文字消失）、★4 点 × 忘掉（另一条不受影响）、★9 切「只读」（面板值 + `localStorage['lingkuang-settings'].agentPerm` + 提示文案）、★11 只读 ⇒ `data-gate === 'deny'`、★12 ⭐**记忆真的进了系统提示**（假引擎抓 `messages[0].content` 里有 `【创作者偏好（长期记忆）】` 与记得的那条文字）、★10 只读档提示词里有「改不了东西」（不写这句模型会一口答应「我帮你改好了」）、★13 切 YOLO ⇒ `gate === 'allow'`、★6 从对话总结（mock 输出带 ```json 围栏与前后废话也抠得出 → 两条 `src=auto` 进清单并落盘）、★7 再总结同样内容 ⇒ 不重复记（`这几条已经记过了`）、★8 mock 给废话 ⇒ 只提示不新增、★14 无未捕获异常。⚠️ 前置 = `reset-entity-vault.cjs` + `seed-node.cjs` + **`seed-agent-memory.cjs`**；⚠️ **假引擎**：套件往页面里塞 `window.__lkAgentMock`（字符串 / 字符串数组 / 函数），`src/ui/agent-model.ts` 的 `agentAsk` 见到它就直接回 `{text, model:'mock'}` —— e2e 不可能真连 Ollama；用 **`JSON.stringify(fenced)`** 构造带反引号的 mock 字符串（模板字面量里写不了反引号），抓提示词就用函数形态 `window.__lkAgentMock = (m) => { window.__lkSeen = m; return '收到。'; }` 然后在页面内算布尔，别把整段 system 传回来 |
| `agent-tools.cjs` | 灵框助手**动作工具 + 提议卡片 19 项**（片 3 + 3.1 协议容错）：★0 前置（工作台 + 面板没开）、★1 `Ctrl+K` 开面板、★2 只读动作 `list_entities` **自动跑掉**（`.lk-agent__call` 写「用到动作：list_entities」、`.lk-agent__tool` 里出「银发少女」、**不出卡片**）、★3 ⭐**只读结果真的喂回了下一轮**（假引擎看到第二次 messages 里有 `【动作结果：list_entities】` 与结果文字 —— 只画在屏幕上不算数）、★4 动作协议写进了系统提示（`【你能用的动作】` + 真例子 `{"tool":"read_entity"` + 反面教材 `不要写成`）、★5 只读完模型接着用普通话回答、★6 写入动作在默认档**变成一张提议卡片**（标题「新建设定：测试新条目（角色）」+ `note` 提示要点「应用」）、★7 ⭐**点「应用」之前数据一点没动**（左树行数不变 —— 这才是「提议」的意义）、★8 点 `[data-prop-ok="0"]` 才落盘（树多一行 + 卡片 `.is-settled` + note「已新建设定「测试新条目」」）、★9 点「忽略」什么都不做（note「已忽略」）、★10 只读档不出卡片不落盘（`data-gate==='deny'`，note「只读档：这次写入没有执行」）、★11 YOLO 档直接落盘（`data-gate==='allow'` + 设置里 `agentPerm==='yolo'`）、★12 认不出的裸 JSON（`fly_to_moon`）**回头纠正一次**（断言 `dumped === false` —— 裸 JSON 不许出现在任何气泡里、`__lkSeen[1]` 末条是 `【格式提醒】`、最后气泡是重发后的回答）、★13 前面带散文的 JSON 当聊天（免得它举例说明时被误当调用）、★15 ⭐**「工具名当键」`{"set_field":{…}}` 也认下来了**（用户实测的形状 ⇒ 出卡片而不是一坨 JSON）、★16 点应用后再 `read_entity` 读回 `发色=墨黑`（**用户那条 bug 的回归测试**）、★17 参数写成裸值（`{"search":"银发"}`）也认（`PRIMARY` 兜成 `q`）、★18 ⭐纠正一轮后模型照办 ⇒ 只读动作照常跑起来、★14 无未捕获异常。⚠️ 前置 = `reset-entity-vault.cjs` + `seed-node.cjs` + `seed-agent-memory.cjs`；⚠️ **这份套件会改夹具数据（建实体、改权限）⇒ 必须自己一份干净起点**；串跑指纹：上一份套件把助手面板留在开着 ⇒ `Ctrl+K` 反而关掉它 ⇒ ★0 报 `{panel:true}`、随后 `Cannot set properties of null (setting 'value')`（套件已加「先点 `#lk-agent-close` 收掉」+ `setPerm('confirm')` 兜底，但仍不能替代干净起点）。⚠️ 两处专治「面板/数据被上一份套件搅过」的兜底写在点中实体行之后：先 `document.getElementById('lk-agent-close')?.click()`，`check('★1 …')` 之后再 `setPerm('confirm')` |
| `seed-motion.cjs` | 前置：给动效套件造确定起点 —— **两条时间线**（页签错峰至少要两个 tab，**第二条故意 0 节点、vault 里没有目录**，顺带守着「空时间线不被 vault 重建抹掉」那条修复）+ 各一个节点 + 一个实体。独立目录（`%TEMP%\lk-motion`），免得给别的套件留下额外时间线 |
| `toolbar-groups.cjs` | 左栏分组**5 项**：两组（创作 **6** 个 / 管理 4 个 —— 2026-09-15 创作组末尾加了「助手」）+ 顺序固定、管理组**贴底**（离底 ≤10px 且与上段留 >40px 空隙）、最底下那个就是「设置」且点了真能开出**悬浮**面板（fixed + 挂 body + 主区 HTML 未变）、再点一次＝关、无未捕获异常。**不依赖世界数据**，哪个已播种的目录都能跑。⚠️ 创作组从 6 个变 5 个是 2026-09-13 合并工作台的结果（「编辑器」工具下线，它的树并进设定库）；★3 在 2026-09-13 深夜从「主区出现设置页」改成「悬浮面板 + 主区不动」 |
| `motion-switch.cjs` | 动效（切换类）**25 项**：切工具/开面板/回沙盘/时间线页签错峰/弹窗/工作台换类别 + 换条目/**灵感触发器卡片** —— ① **参数**（`getAnimations()` 的 name + 时长 + 延迟 + `playState`，在点击的同一个同步块里读）② **真的在跑**（出**一帧**后要 `animationend`，见铁律 6）③ **终态不残留**（`finish()` 后 opacity=1 / transform=none）④ **容器不许播**（★2/★7/★9：整块淡入是"闪一下"的来源）⑤ **错峰自收手**（★6：类与行内延迟都清掉，否则重渲染会重播）⑥ **减少动效降级**（★15/★21/★24：`lk-fade`/200ms、错峰延迟全 0，含行内值）⑦ **竞态守卫**（★17：同 tick 连点两个工具，终态必须是后点的那个）⑧ **块里面的元素也要错峰**（★18 卡片排 `120…720ms` 阶梯 + 卡片区自己不整块淡入、★19「重新生成」**不重播**（用户 2026-09-12：只有初次进入才错分）、★20 锁定不重建卡片）⑨ **高度平滑**（★23 变高矮的卡挂上 `height` 过渡、起点被钉在旧高度、★23b 落位后停在目标高度、★24 减少动效下根本不挂）+ 功能回归（★16 点第二个时间线页签真的切过去了）。⚠️ ★13/★14 自 2026-09-13 下午起是**反向守卫**：工作台换类别/换条目只重造 `#cx-body`，所以 `#cx-root` 与 `#cx-list` 的子项**一个 CSS 动画都不该有**（`animationName` 有值的），内容区改由**行级 WAAPI 转场**承担（幽灵层 + 行上的 `el.animate()`，参数细查见 `codex-swap-motion.cjs`；整块错峰的节奏由 ★1/★8「切工具」覆盖）。⚠️ ★7 在 2026-09-13 深夜从点 `settings` 改成点 `schema` —— 设置已经**不再接管主区**（悬浮面板，见 `settings-panel.cjs`），点它不会切工具。⚠️ 断言**不依赖墙钟**，原因见铁律 6/7 |
| `seed-empty-timeline.cjs` | 前置：三条时间线 —— 主线(1 节点)、**支线(0 节点，故意不建目录)**、副线(1 节点)；vault 里只有主线与副线的目录 |
| `timeline-persist.cjs` | 空时间线不该被 vault 重建抹掉 8 项：启动后三条页签都在 → 空时间线能选中 → 点＋新建（直接建、默认名「新时间线」）→ **落盘后空时间线还在文件里** → 回扫后仍在 → **外部删掉主线目录后主线消失且不复活** → 副线与两条空时间线都没被牵连 |
| `cold-start-empty-timeline.cjs` | 重启复验 3 项（承接 `timeline-persist.cjs` 的收尾状态）：两条空时间线仍在、被外部删目录的主线不复活、盘上文件与界面一致 |
| `assoc-canvas.cjs` | 灵感触发器·联想画布 **11 项**（用户 2026-09-12 两条：「节点会被一块地方挡住，看不全 / 移出视窗时视窗不跟着移」→「**现在有边界了，向上拖不动节点了，我想要无限画布**」）：★1 滚到底时**画布顶部不被 sticky 工具条压住**（`stageTop ≥ barBottom`、`stageBottom ≤ vh`、画布顶部那一圈 `elementFromPoint` 归画布、高度 ≥ vh×0.7）、★2 鼠标停在**画布上**滚滚轮真能滚页面（找的是真滚动容器 `.lk-tool-slot`，不是写死的类名）、★3 拖到右边缘**按住不放**→视窗自己往右推且节点**一直贴在鼠标下**、★3b **越过旧世界右墙继续推**（没有边界）、★4 松手后推力立刻停、★5 反向拖到左边缘 → 越过原点继续走（左边同样没墙）、★7 **向上拖节点**：世界坐标真的变小（可以 < 20、甚至为负）+ 贴上边缘时 `panY > 0`、★8 松手即真的松手（之后的指针移动不再带动节点 + 贴边推停住；**原来断言"坐标一动不动"，`PIN_YIELD` 之后已改判据**）、★9 跑到**框外的连线照样画出来**（含 A/B：把 SVG 的 `overflow` 改成 `hidden` 时同一点 `elementFromPoint` 就打不中）、★6 无未捕获异常。⚠️ 自动推视窗是 rAF 驱动的 ⇒ 断言前必须 `forceFrames()`（见铁律 6） |
| `assoc-pull.cjs` | 联想画布**连线上的"拉力"6 项**（用户 2026-09-13：「**拉太远时拉力会失效**」→「线没断，但是拉力失效了，是不是数据溢出的问题」）：★1 拖拽**全程**就是"线被拉住"（往"离开根"的方向拖 150px，间距不许被拉长；A/B：修复前根词位移 **1px**、线从 148 拉成 **291**，修复后 146/146）、★2 拖得近（< `PIN_YIELD 420`）松手后**它自己留在被放下的地方**（自身漂移 0，线由邻居过来收）、★3 **两端都被手工摆过** + 拉太远 → 钉子失效、间距收回静止长度（A/B：修复前 `4477 → 4477` 永远回不来）、★4 丢到 **40 万像素外**不出 NaN/Infinity 且仍在被往回拉（否定"数据溢出"这个猜测）、★5 无异常。⚠️ 它把 `window.fetch` 换成固定 5 个词（`雪狼/冻湖/松林/极光/猎户`）—— 没有 ollama 时图里只有根词、**没有边就无从断言拉力**；落点夹在画布内（拖出画布会触发贴边推视窗，测到的就不是弹簧）；★1 必须**沿"根 → 被拖词"方向往外拖**（见铁律 9） |
| `seed-evolution.cjs` | 前置（**只许跑在测试目录**）：3 个事件节点（年份 **315 / 327 / 350**，帧要按锚点时间排序）+ 2 条实体（角色·银发少女 = 被测；物品·霜纹剑 = 验"历史各归各的"）+ 把 JSON 的 `timeCursor` 设成 **3.1e10**（≈公元 1000 年，**一定在所有节点之后**）。⚠️ 这是唯一**不依赖历法换算**的写法：只要 epoch 随年份单调，就能断言"最近的那一帧"是最后一帧。⚠️ 它还**自己写实体类型的字段模板**（`worldsets[ws].entityTypes`）并在世界/时间线缺失时建出来 —— 继承来的目录里「角色」可能只有一个字段，`setField('年龄')` 会静默无效（2026-09-13 踩到：七条断言一起报假 FAIL） |
| `entity-evolution.cjs` | 演变（实体版本历史）**49 项**（用户 2026-09-13：「我想在设定库右侧加一条竖着的等距的时间线…当选中实例时，默认进入离当前指针最近的 git」+「都做吧，把模式放到设置里面」+ 次日上午「**我希望没有版本的节点就不显示**」+「**默认创建了一个滚动条，去掉吧**」+ 下午「**能展开未创建 git 的节点，但虚化显示**」+ 深夜「**我希望切换帧时直接高亮要写到的地方**，还有**自动模式下怎么还有记一帧的按钮**」）：★0/★0b 没有版本时帧条只有「初稿」一格、但「记到」下拉里三个事件都在（默认离指针最近）、★0c 每格**等高**（等距）、★0d **面板外壳开销 ≤130px**（这条滚动条的账）、★0e~★0h **展开虚化行**（默认收起且底部写"还有 N 个没版本"；展开后 3 个没版本的事件**按时间** 315/327/350 插进时间线、`opacity` 实测 **0.4**、点虚化行 = 换「记到」+ 该行标「记到」、**不动正在看的版本**、再点收起）、★1 没有版本时默认落初稿、★2/★2b 帧条不列没有版本的节点且底部写明落点、★3 **手动模式**站在初稿改字段 = 改**初稿**（frontmatter 变）且**不产生帧**、★4/★4b 选「记到 第一次魔潮」+ ＋记一帧 → `.md` 出现 `#演变：` 段（锚在 n-evo-2）、帧条多一格且**视图跟过去**、★5/★5b 改字段进**那一帧的 patch** 而初稿不动（中栏显示的是这一版的值）、★6/★6b 切回初稿看到初稿的值、★7/★7b/★7c 改正文 → **行级 hunks**（不是整段）且初稿正文没被改写、切版本正文也不同、★8 换另一条实体不串台、★9 **默认落在离沙盘指针最近的那一帧**、★10/★10b/★10c/★10d/★10e **自动模式**把改动记到「记到」那个事件上、新帧是**增量**、且自动建的那版也上帧条、★11 点初稿那一格看到初稿、★12/★12b/★12c **锁定模式**视图与落点都钉在锁定帧、★14/★14b/★14c 删帧先弹确认、只删那一帧、删掉当前这版后退回前一版、**★15/★15b/★15c/★15d/★15e 写目标高亮**（手动 = 正在看的那版；切到初稿→高亮跟着挪；自动 = 「记到」那格**且它还没版本时也要被拉进帧条**；自动模式**没有**「＋记一帧」；锁定 = 锁住那格且只有一格亮）、**★16/★16b/★16c 类型是身份、不进版本差异**（用户 2026-09-13 深夜：「**时间帧内为什么能修改实体的类型**」—— 站在某一帧上把类型从「角色」改成「物品」⇒ 文件搬到 `_设定/物品/银发少女.md`、旧路径那份为空、`#cx-vnote` 出现「类型改的是整条设定，不记进版本」、那一帧的 patch **不含** `typeId`、帧数量不变；★16b 逐字节比搬过去那份帧；★16c 改回「角色」文件也搬回来）、★13 无异常。⚠️ 读 `.md` 必须**轮询等写下去**（见铁律 11）。⚠️ **必须 `reset-entity-vault.cjs` + `seed-evolution.cjs` 再重启**：只播种不 reset 的话 vault 里上一轮的 `#演变：` 段会被回扫捞回来（帧是**文件为源**）⇒ ★0/★5/★5b/★9/★9b/★10 六条一起假挂（实测 39/46）。⚠️ 曾经偶发 **34/38**（★5/★5b/★10d/★14b 一起挂）：内存里的改动被一次旧快照回扫盖掉，机制与调查见 `docs/BUGS.md` 第二十一轮「七」；套件开头已**显式复位设置**（★12 会把模式改成"锁定"且不复位） |
| `vault-rescan-race.cjs` | 「写盘在飞时来的回扫」**6 项**（为上面那条偶发写的守卫）：★0/★0b 前置（这一版已建好 + 塞 30 个实体把写盘窗口拉长）、★1 **死等节点 `.md` 的 mtime 变化 = 抓到写盘刚开始的那一刻**，立刻改**另一个**实体的 `.md`，逼 watcher 事件落进写盘飞行中 —— 断言「刚改的字段不许自己变回去」（采样里不许出现非 19）、★1b 那一帧的 patch 落进 `.md`、★2 **外部改动仍然要能回扫进界面**（防"靠永不回扫换绿"）、★3 无异常 |
| `storyline-world-history.cjs` | 沙盒顶部「剧情线 / 世界历史」下拉 **8 项**（用户 2026-09-13：「**世界沙盒中从剧情线切换到世界历史再移动指针时会导致跳回剧情线**」）：★0 前置（下拉在、至少一条剧情线；**id 从选项里取，不写死**）、★1 选「世界历史」**当场**不被改回去、★2 移动指针后仍是世界历史、★3 世界历史 = 不聚焦（`#lk-story-mask` 子元素 0 段）、★4/★4b 切回剧情线照常生效且遮罩回来、★5 点笔刷（另一条重画下拉的路径）后仍是世界历史、★6 无异常。A/B：修复前 4/8（★1/★2/★3/★5 挂）。⚠️ 要对着**有剧情线的数据**跑（`%TEMP%\lk-story` = 真实数据副本） |
| `cold-start-evolution.cjs` | 演变**冷启动 9 项**（承接上一条跑完的数据）：帧还在（亮格数 = 文件里的帧数）+ 摘要正确 + 默认落点仍是最近的那一帧 + **物化正确**（界面末版 = 初稿 + 全部帧，与脚本里独立算的一份比对）+ 切初稿只剩初稿值 + 正文也按版本取 + 无异常 |
| `rail-order.cjs` | 帧条（演变）**展开/收起的错峰顺序 + 已有格子的让位 26 项**（用户 2026-09-14：「展开面板时也有错分，**离已有帧节点越近的节点越先出现**；出场也是一样，**离已有帧越远的帧越先退场**，最后再**平滑切换最外层框的高度**」+ 2026-09-15「**帧面板会闪一瞬间的滚动条**，节点的**入场和出场还是参考我们文件树的管理吧**」）+ 深夜「**已有的帧节点的位置变化也要平滑，时间线长度也一样**」）：★1 逐行 22ms 错峰（单行 260ms）、★2 顺序**按距离升序**（近的先；种子两端都有版本 ⇒ 与 DOM 顺序不同）、★3 入场 = **从上方落下来**（`translateY(-8px) → 原位`，与左树展开文件夹同一套）且不透明度 `0 → 0.4`（**不许亮到 1**，否则会"先全亮再变虚"）、**★3b 第一行当下就动**（最小 `delay` = 0 —— 帧条只有入场，谁也不许先白等一个 dur）、★4/★4b 框高动画带 `delay`、`fill:'both'`，点下去那一 tick 框还没长高、**★4e 展开时被挤下去的行当下就让位**（FLIP `translateY(-184px)` → 原位、`delay 0`、一格位移 = 4 × 46px）、★5 演完框回自然高度、★6 收起先化幽灵、★7 退场顺序 = **距离降序**（远的先走）、★8 退场 = **往上淡出**（`translateY(-8px)`）且不透明度起点 `0.4`（不是 1）、★9 **裁切层停在旧高度**（否则退场中的行被裁没）而框的目标高度已经变矮、**★9b 收框等退场全走完才开始**（`delay ≥` 最后一行的 `delay + dur`；用户 2026-09-14：「收起时节点要先出场，外面的框再收起」）、**★9c 收起时被抽上来的行等虚化行退完才补位**（`translateY(+184px)` → 原位、`delay === boxDelay` = 236）、★10 演完收干净、**★10b 记一帧：新格子从左边滑进来**（`translateX(-24px)` → 原位，与左树"新出现的行"同一套）、**★10c 它下面的格子让位**（`translateY(-46px)` → 原位 · delay 0）、**★10d 整条时间线的高度也演**（框 `138 → 184px` 且 `boxFrom` = 旧高度；以前这条路上框是同一 tick 蹦过去的）、**★12 框的高度动画先结束时盒子必须还夹着**（`inline:hidden` + `barW:0`，而那一刻被让位的行还钉在 `translateY(184px)`、`scrollHeight > clientHeight` —— 夹子一松就是用户看到的那条"闪一下的滚动条"，A/B 旧代码 `barW:16`）、★11 无异常。⭐ 2026-09-14 第七轮加的四条：**★0d 开关是「演变」标题右边的 `<button>`**（不再是列表底下那一行；`#cx-rail .lk-rail__head` 里有它、`.lk-rail__rows` 里没有、`.lk-rail__more` 已不存在）、**★4c 框的动画终点 = 它真正想要的高度**（`boxTo` 对 `min(scrollHeight, max-height)` 差 ≤1.5px —— 差值就是被人算进去的一条 15px 横向滚动条，修前 `363.333` vs `348`；用户原话「展开后外面的框高度会闪」）、**★4d 滚动盒 `overflow-x: hidden`**（入场行的 `translateX(+32px)` 会撑出横向可溢）、★9b 见上。⚠️ 前置是**自己的**播种脚本 `seed-rail-order.cjs`；⚠️ 「距离」在断言里是**从 DOM 现算**的（行号差的最小值），不写死数字；⚠️ 「＋记一帧」那三条里，**换完「记到」下拉必须重新 `querySelector` 那个按钮** —— 下拉一变帧条就重画（`innerHTML` 换掉），换之前抓到的按钮已脱离文档，`click()` 什么都不发生（第一版的白点：`frames` 一直是 2） |
| `node-changed-by.cjs` | **「这件事改变了谁」15 项**（2026-09-14 新功能，用户原话：「**好，你先去写新功能吧，我在上课**」）：站在一个事件节点上看它改动了哪些设定，点一行跳到"这条设定在这个事件之后的样子"。★1 节点中栏有这块 + 计数、★2 **只列真有帧的**设定（没帧的实体是负例、不许出现）、★3 版本号**按各自的帧算**（同一个事件上银发少女是第 2 版、霜纹剑是第 1 版）、★4 每行有类型名与改动摘要（摘要点出改了哪个字段）、★5 负例实体不在列表里、★6~★9b 点一行 ⇒ 跳到那条设定 + **中栏是这一版的样子**（年龄 21 / 发色 雪白，不是初稿的 17 / 银白）+ 「正在看：第 2 版」+ 帧条停在 `n-evo-2` 且**可见**（`.is-off` 为 false）+ 左树高亮换到实体行、节点行不再亮、★10 没有任何帧的事件给**一句人话**（不是空白）、★11 只改过一次的事件 = 1 条 + 第 1 版、★12 来回进出**不叠内容**（监听只挂一次）、★13 无异常。⚠️ 前置是**自己的**播种脚本 `seed-node-changed.cjs`（帧直接写在 `.md` 的 `#演变：` 段里，不靠界面点出来 —— 界面点出来的帧依赖上一轮跑没跑，断言会飘） |

启动补写那条单独跑一次：

```powershell
node tools\e2e\seed-json-only-entity.cjs     # 播种 JSON-only 实体
# 起应用（同上面的 Start-Process）
node tools\e2e\startup-materialize-entity.cjs
```

设定库工作台那几条（编辑节点 + 左栏形态守卫）跑一次：

```powershell
node tools\e2e\reset-entity-vault.cjs
node tools\e2e\seed-node.cjs                 # 播节点 + 种类模板 + 一条有正文的实体
# 起应用（同上面的 Start-Process）
node tools\e2e\codex-node-tab.cjs            # 18 项
node tools\e2e\codex-tree-view.cjs           # 22 项（左栏只有一棵树 + 默认全展开的守卫）

# 另一轮：换条目串不串正文（先 reset，不用 seed）
node tools\e2e\codex-switch-target.cjs       # 7 项

# 另一轮：工作台顶栏直接建节点（reset + seed 之后，重新起一次应用）
node tools\e2e\workbench-add-node.cjs        # 19 项（★15~★17 要 LK_SEED_ORDER=1 播种，见下）

# 另一轮：灵框助手（reset + seed-node 之后，还要 seed-agent-chat 把盘上的历史写出来，再重启）
node tools\e2e\seed-agent-chat.cjs           # 写 <dirname(LINGKUANG_TEST_DATA)>\agent\chat.json（**裸数组**）
node tools\e2e\seed-agent-memory.cjs         # 写 agent\memory.json（**裸数组**）+ 清测试 userData 的 localStorage
node tools\e2e\agent-memory.cjs              # 15 项（片 2：长期记忆 + 三档权限；用 window.__lkAgentMock 假引擎）
node tools\e2e\agent-tools.cjs               # 19 项（片 3 + 3.1 协议容错：动作工具 + 提议卡片；⚠️ 它会**建实体、改权限** ⇒ 必须自己一份干净起点）
```

**文件夹树的语义那条**用独立目录（`lk-edtree`）—— 它要"有节点的种类"和"空种类 / 与实体类型重名的种类"同时在 `formats.json` 里：

```powershell
$env:LINGKUANG_TEST_DATA="C:\Users\<你>\AppData\Local\Temp\lk-edtree\worldbuilding.json"
$env:LINGKUANG_VAULT="C:\Users\<你>\AppData\Local\Temp\lk-edtree\vault"
$env:LINGKUANG_TEST_USERDATA="C:\Users\<你>\AppData\Local\Temp\lk-edtree\userdata"

# ⚠️ 全新目录先起一次应用（让应用写出 worldbuilding.json），再播种
node tools\e2e\seed-editor-tree.cjs          # 整份写 formats.json（事件 有节点 / 战斗 空 / 角色 空且与实体类型重名）
# 起应用（同上面的 Start-Process，端口 9704）—— formats.json 是启动时读的，播完必须重启
node tools\e2e\workbench-tree-folders.cjs    # 29 项
```

**设定库"换条目不发刷新"那条**用独立目录（`lk-smooth`）—— 它要 3 个不同类型的实体 + 一个能被左列撑高的列表：

```powershell
$env:LINGKUANG_TEST_DATA="C:\Users\<你>\AppData\Local\Temp\lk-smooth\worldbuilding.json"
$env:LINGKUANG_VAULT="C:\Users\<你>\AppData\Local\Temp\lk-smooth\vault"
$env:LINGKUANG_TEST_USERDATA="C:\Users\<你>\AppData\Local\Temp\lk-smooth\userdata"

node tools\e2e\seed-smooth-switch.cjs        # ⚠️ 会清空测试世界的 _设定/主线/.trash
# 起应用（同上面的 Start-Process）
node tools\e2e\codex-smooth-switch.cjs       # 28 项
```

⚠️ 这条**改完界面后要重跑**（重跑前重新播种 + 重启实例：套件会把面板停在时间线节点上、并改掉几条正文）。
⚠️ A/B（验证断言真有判别力，见铁律 9）：`git checkout -- src/ui/codex.ts` + `vite build` 复跑 ⇒
**未修复 8/16**（★1/★2/★3/★6/★8/★9/★10/★14 挂），修复后 16/16。

✅ 跑完上面的步骤，还可以顺手跑一条**不依赖世界数据**的：

```powershell
node tools\e2e\toolbar-groups.cjs             # 5 项：左栏两组 + 设置贴底
```

只读探针（不改数据、不产帧，专查「助手到底看得到什么」——2026-09-18 查「AI 看不到我打开的文件」时用的，
见 `docs/BUGS.md` 第二十八轮）：

```powershell
# 前置同 agent-panel（reset-entity-vault + seed-node），起实例后：
node tools\e2e\probe-focus.cjs                # 五幕：进工作台 / 点实体行 / 点节点行 / 切走工具 / 切回 —— 打印 chip 与上下文长度
node tools\e2e\probe-focus2.cjs               # 真模型版：拿真引擎问用户原话，看它能不能点名那一条（约 10-30s）
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
node tools\e2e\entity-evolution.cjs        # 49 项（会写入帧、最后删掉一帧）
node tools\e2e\vault-rescan-race.cjs       # 6 项：写盘在飞时来的回扫不许把改动打回去（接着跑即可）

# 重启应用（数据保留上一轮的结果）
node tools\e2e\cold-start-evolution.cjs    # 9 项：帧还在 + 物化正确
```

**「这件事改变了谁」（节点侧反向视图）那条**（2026-09-14 新增，**只属于它自己的目录**）：

```powershell
$env:LINGKUANG_TEST_DATA="C:\Users\<你>\AppData\Local\Temp\lk-changed\worldbuilding.json"
$env:LINGKUANG_VAULT="C:\Users\<你>\AppData\Local\Temp\lk-changed\vault"
$env:LINGKUANG_TEST_USERDATA="C:\Users\<你>\AppData\Local\Temp\lk-changed\userdata"

# 全新目录要先起一次应用、让它写出 worldbuilding.json（别的种子脚本也一样：
# 播种第一步 readFileSync 会 ENOENT 退出），关掉再播
node tools\e2e\seed-node-changed.cjs       # 银发少女 2 帧 / 霜纹剑 1 帧 / 守夜人队长 0 帧 / n-evo-3 没有帧
# 起应用
$env:LK_CDP_PORT="10210"
node tools\e2e\node-changed-by.cjs         # 15 项（A/B 改动前 2/15）
```

⚠️ 这个套件**不改数据**（只读 + 切视图），所以可以在同一实例连跑；但它的播种脚本会**清空测试世界的
`_设定`/`主线`**，别对着别的套件的目录跑。

**转场 / 悬浮设置面板那两条**（2026-09-13 深夜新增）：

```powershell
# 转场（要有 ≥2 条实体、且实体类型「角色」字段齐全）
$env:LINGKUANG_TEST_DATA="C:\Users\<你>\AppData\Local\Temp\lk-smooth\worldbuilding.json"
$env:LINGKUANG_VAULT="C:\Users\<你>\AppData\Local\Temp\lk-smooth\vault"
$env:LINGKUANG_TEST_USERDATA="C:\Users\<你>\AppData\Local\Temp\lk-smooth\userdata"
node tools\e2e\seed-smooth-switch.cjs          # 3 实体（不同类型）+ 2 节点 + 34 配角（撑高左列）
# 起应用
node tools\e2e\codex-swap-motion.cjs           # 14 项：换条目的行级转场 + 四个旋钮
node tools\e2e\codex-smooth-switch.cjs         # 28 项：换条目/换类别不重建骨架 + 帧条"演完才收高度" + 滚字（两段错开）
```

```powershell
# 左树行级动效（新建滑入 / 让位 FLIP / 展开下弹 / 删除幽灵）
# 目录用 lk-evault2；**本套件会建 5 个实体、删 1 个** ⇒ 重跑必须重新播种并重启实例
$env:LINGKUANG_TEST_DATA="C:\Users\<你>\AppData\Local\Temp\lk-evault2\worldbuilding.json"
$env:LINGKUANG_VAULT="C:\Users\<你>\AppData\Local\Temp\lk-evault2\vault"
$env:LINGKUANG_TEST_USERDATA="C:\Users\<你>\AppData\Local\Temp\lk-evault2\userdata"
node tools\e2e\reset-entity-vault.cjs
$env:LK_SEED_ORDER="1"; node tools\e2e\seed-node.cjs   # ⚠️ 给 workbench-add-node ★15~★17 用（多播 year:1 的「上古」+ 指针设到 year 200）
# 起应用
node tools\e2e\codex-list-motion.cjs           # 25 项（A/B 改动前 19/25；★4k 是"补位越高的越先移"）
# ⚠️ 这套**不要**设 LK_SEED_ORDER（★4c 断言「事件」下只有「王国的建立」）
#    要跟 workbench-add-node 换着跑时，中间必须重新 reset + seed + 重启（见铁律 4）
```

**帧条（演变）展开/收起的错峰顺序**要一份"两端都有版本"的数据（距离顺序**与 DOM 顺序不同**，
否则顺序断言会假绿，见铁律 24）：

```powershell
$env:LINGKUANG_TEST_DATA="C:\Users\<你>\AppData\Local\Temp\lk-railord\worldbuilding.json"
$env:LINGKUANG_VAULT="C:\Users\<你>\AppData\Local\Temp\lk-railord\vault"
$env:LINGKUANG_TEST_USERDATA="C:\Users\<你>\AppData\Local\Temp\lk-railord\userdata"
# 全新目录要**先起一次应用**写出 worldbuilding.json，再播种（见"那条"一节）
node tools\e2e\seed-rail-order.cjs             # 6 节点（第 1、6 个有版本）+ 1 实体 2 帧
# 起应用
node tools\e2e\rail-order.cjs                  # 26 项（A/B 改动前 21 项：★1/★3/★8/★10b/★12 挂）
# ⚠️ 一次性套件：★10 会真的记一帧（n-ro-2 从此有版本）⇒ 同一实例再跑会 13/26。
#    重跑必须 reset + seed-rail-order.cjs + 重启（见 tools/e2e/README.md 的"那条"）。
```

```powershell
# 悬浮设置面板（不动数据，任何已播种目录都能跑）
node tools\e2e\settings-panel.cjs              # 12 项
node tools\e2e\toolbar-groups.cjs              # 5 项：左栏分组 + 点最底下那个开出悬浮面板
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
★1/★8 当场从 25/25 掉到 23/25 —— 不是动画坏了，是下标错位（dump 里第 3 项是 `[]`）。
（当时 ★13 也是这么挂的；不过 ★13 自同日下午起改成了**反向守卫**「换类别不重播整块」，不再按子项序号读。）
同一条坑对"按子项数循环"的任何断言都成立。

## 铁律 13：**别把"有几块/有几行"写进断言**（要钉的是节奏与关系，不是快照）

同一天下午又踩了它的孪生兄弟：左栏重做撤掉工作台那一行页签之后，`#cx-root` 的可见顶层块
从 3 个变成 2 个 ⇒ `motion-switch.cjs` ★1/★8/★15 里"至少三块""第 2 块 100ms、第 3 块 200ms"
全部作废（★8 甚至挂在 `a2b[1]` 这个 **display:none 的空位**上）。这不是产品回退，是断言把 UI 结构当成了契约。

- 钉**节奏**：`played[i].delay === i * 100`（块数随便变），`played.length >= 2`（下限而不是等号）。
- 钉**关系**：列表行按 `[data-cx-id]`/`[data-act=…]` 找，序号一律现算（`flatten` 后再比）。
- 界面结构是**可以变的**：它变了而断言没挂，才说明断言写对了。

## 铁律 14：**"点一下展开"之前先读状态** —— 默认值反转时它会变成收起

`workbench-tree-folders.cjs` 原来一路 `clickRow('world', WS)` → `clickRow('tl', '主线')` → `clickRow('wset', '_设定')`
把树一层层点开。用户 2026-09-13 说「把全部改成文件树的形式，这样子也方便看」之后，树改成**默认全展开**
（`collapsed*` Set 记的是"被收起来的"）⇒ **同样那几次点击变成了"收起"**，后面 ★4~★26 会整片挂，
而产品其实没问题。

- 写法：`rowOpen(act, label)` 先读 `is-open` 类，**需要展开时才点**（幂等）；"默认就展开"本身写成断言。
- 同类坑：`codex-node-tab.cjs` 的 ★2/★3 也从"点开看层级"改成"打开就全在 + 点一下能收起再展开"。
- 换个说法：**测的是不变量（这一枝该是开的），不是"点几下能开"这个动作序列**。

## 铁律 15：**WAAPI 的关键帧值是字符串** —— `kf[0].opacity === 1` 会假挂

`el.animate()` 建的动画，用 `a.effect.getKeyframes()` 读回来的 `opacity` / `transform` 是
**字符串**（`'1'` / `'0'` / `'translateX(32px)'`），不是数字。第一版断言写成
`kf[0].o === 1` ⇒ `codex-swap-motion` ★3/★4 与 `codex-smooth-switch` ★9 三处**同时假挂**，
而参数其实完全正确（dump 里明明白白 `{"o":"1","t":"none"}`）。

- 写法：统一 `String(kf[0].o) === '1'`（`transform` 本来就是字符串，`includes('32px')` 即可）。
- 顺带：**CSS 动画与 WAAPI 动画都在同一张 `getAnimations()` 表里**，用 `a.animationName` 区分 ——
  有名字的是 CSS 类动画（`lk-wake`/`lk-swap`），没名字的是 `el.animate()` 建的（见铁律 8）。
  工作台换条目自 2026-09-13 深夜起改成行级 WAAPI 转场 ⇒ `motion-switch` ★13/★14 的
  "内容区不许播"要读 `animationName` 为空的那批。

## 铁律 16：量「有没有位移」时，先把坐标换算到**滚动容器的内容原点**

`#cx-root`（设定库工作台）自己就是滚动容器。直接比 `getBoundingClientRect().top` 会把**滚动位置**
一起比进去：`codex-smooth-switch.cjs` 的 ★6 刚把面板滚到 260px，随后取的基线整体高 260，
到 ★14d（换回实体的那一头，面板已经不滚了）就"对不上"—— 假挂一次，产品其实没问题。

- 正确写法：`t = rect.top - rootRect.top + root.scrollTop`（本套件把它封成页面里的 `window.__geoNow()`）。
- 反面教材：`display:none` 的元素 `getBoundingClientRect()` **全是 0**（帧条**曾经**在节点态就是这样），
  只能拿它的 `h` 或 `display` 说话，**别比 top** —— 那比出来的是垃圾值。
  ⚠️ 帧条自 2026-09-13 起改成**常驻 + `.is-off`**（宽/高收到 0 而不是 `display:none`，见 `src/style.css` 的
  `.lk-rail.is-off`）⇒ 这类断言要跟着改成比 `w`/`off`，否则测的是已经不存在的实现。
- 顺带：`visibility:hidden` 的元素**照旧占位**，几何与可见时一样 —— 想让"框不动"就选它，
  想让"这块不存在"才用 `display:none`（2026-09-13 深夜的 y 跳 7px 就是选错了这个）。

## 铁律 17：**过渡不是动画** —— 要么 `finish()` 到终态再量，要么读 `transitionProperty`；而且注意读数顺序

帧条那种"演一遍收起"用的是 CSS **过渡**（`transition: width …`），而：

- 隐藏窗口里过渡**不会自己走完**（和铁律 6 的动画一个道理）⇒ 点完立刻量 `getBoundingClientRect().width`
  量到的还是**起点**（176px，"明明收起来了却还是宽的"）。`codex-smooth-switch.cjs` 的 `window.__geoNow()`
  因此在量每个元素**之前**先 `el.getAnimations().forEach(a => a.finish())` 推到终态。
- 过渡对象**不在 `animationName` 里**（它是 `CSSTransition`，`transitionProperty` 才是它的属性名）；
  判"有没有过渡"要看 `getAnimations()` 里 `a.transitionProperty`，别用 `a.animationName`（铁律 8 的补充）。
- ⚠️ **顺序陷阱**：`__geoNow()` 会顺手 `finish()` 一切，所以"抓过渡正在飞"的探针（`__railProbe()`）
  必须**排在 `__geoNow()` 之前**读 —— 反过来读永远拿到空数组、宽度已经是 0，于是"帧条没有动画"这种假 FAIL。
- `height: auto → 0` **过渡不了**（`auto` 不是可插值长度）：帧条收起时宽/位移/透明度是渐变的，
  高度是"瞬时"的。这在布局上看不出来 —— 帧条本来就比中栏矮，行高由中栏决定（★13b 钉住"框不动"）。

## 铁律 18：同一时刻可能挂着**好几批**幽灵/动画 —— 断言只认"这一次点击刚造出来的"

左树收起文件夹（`ghostRows()`）、删除条目（`pinRowGhost()`）都是把行克隆成 `position:fixed` 的幽灵
（类 `lk-list-ghost` / 挂在 `document.body` 上）再演退场。幽灵**活到动画演完**，所以两次点击挨得近时
页面上会同时存在两批 —— 实测 `codex-list-motion.cjs` ★4c 一次读到 `before: 1, ghosts: 6`。

正确写法（★4c 就是这么写的）：点击**之前**先记下 `document.body.children` 的集合，点击后
**只挑不在那个集合里的**新节点来断言（`[...document.body.children].filter(el => !before.has(el))`），
再过滤 `lk-list-ghost`。反过来"数一数页面上有几个幽灵"会在有残留时误判。

同族的病：改 UI 默认值（默认收起 → 默认全展开）会让"点一下展开"的测试步骤变成**收起**，
整片挂而产品没问题（铁律 14）；每个套件还要有**自己那一份干净起点** ——
`codex-list-motion.cjs` 紧跟 `workbench-add-node.cjs` 在同一个实例里跑会 14/17，
`entity-evolution.cjs` 只播种不 `reset-entity-vault.cjs` 会 39/46，两次都是脏状态假挂。

## 铁律 19：**"动画收干净了没"要轮询，别用固定 sleep** —— 兜底定时器比你以为的晚

隐藏窗口里动画不推进（铁律 6），`animation.finished` 可能**永不 resolve**，
真正把元素/类/行内延迟收掉的是各原语自己的**兜底定时器**：`rollText` 是 `dur*2 + 600`（改两段错开后
= 960ms）、`rowsLeaveAndRemove` 是 `dur + step*n + 400`、`cascadeIn` 是 `maxDelay + 2000`。
固定 `sleep(700)` 正好压在前者前面 ⇒ `codex-smooth-switch.cjs` ★13d2 会**随机假挂**
（实测：改了滚字时长之后它立刻挂着不动）。

写法（★13d2 改后）：
```js
const gone = await (async () => { for (let i = 0; i < 30; i++) { const r = await read(); if (r.prev === 0 && r.anims === 0) return true; await sleep(120); } return false; })();
```
断言仍然严格（收不干净照样 FAIL），只是不再赌时长。同族的铁律 10/11 也是这个道理。

## 铁律 20 · 量"两段文字对不齐"要用 `Range` 的字体框，不能量元素盒

用户报"某两个字偏下了/偏上了"这类**亚像素级**的排版问题时，元素的 `getBoundingClientRect()` 量不出真相 ——
元素盒的高度包含 `line-height`，两个盒子的高度往往本来就不同。正确做法：用 `Range.selectNodeContents()`
取**文本节点自己的字体框**，两边都是同一字体才有可比性：

```js
const rectOf = (n) => { const r = document.createRange(); r.selectNodeContents(n); return r.getBoundingClientRect(); };
rectOf(btn.firstChild)      // 「＋新建」这截文字的字体框
rectOf(btn.querySelector('.lk-roll__t'))   // 盒里那两个字
```
实测（2026-09-14，`#cx-new`）：裁切盒靠 `vertical-align:middle` 摆位时两者的 `top` 差 **1.81px**（盒里的字偏下）；
按钮改 `inline-flex + align-items:center` 后差 **0**。⚠️ 量之前要确认**没有动画/过渡在跑**（动画期间带着
`transform`，量出来当然是歪的），并且 `display` 的计算值可能被父级 flex 块化（`inline-flex` → `flex`）。

## 铁律 21 · 给 WAAPI 的 FLIP 加 `delay` 就必须一起给 `fill:'both'`

`src/ui/motion.ts` 的 `flipRows()` 默认 `fill:'none'`（演完自然落在新位置，不需要清理）。一旦传了 `delay`
（收起文件夹时"等里面那一枝退场走完、下面的行再往上补位"，见 `codex-list-motion.cjs` ★4f），
`fill:'none'` 会让那一行在**延迟期间先瞬移到新位置**、等延迟过完再跳回旧位置演一遍 —— 看着就是"抖一下"。
所以 `flipRows` 里写的是 `fill: delay > 0 ? 'both' : 'none'`，`autoRelease` 的时长也要加上 `delay`
（否则动画对象会被提前取消，行卡在旧位置上）。

## 铁律 22 · 改 fixture 脚本 = 改数据；"把脚本改回去"救不了已经写脏的那份 JSON

2026-09-14 试过一次"让 `reset-entity-vault.cjs` 既铺 `entityTypes` 又在硬盘上建五个类型空文件夹"，
试完把脚本 `git checkout` 回退了 —— **但那次运行已经把 `fields` 写成对象**（`{描述:'text'}`）落进
`%TEMP%\lk-evault2\worldbuilding.json`。后果：`src/store/actions.ts` 的 `addEntity` 里
`for (const f of ws.entityTypes?.[typeId]?.fields ?? [])` 抛
**`TypeError: object is not iterable (cannot read property Symbol(Symbol.iterator))`** ——
点「＋新建」**静默失败**，`codex-list-motion.cjs` 崩到 **7/24**（不是 24/24 里的几条，是大面积）。

判别特征：新建按钮点了没反应 + 一个 `TypeError: object is not iterable` + 断言全是"行没多出来"。

**恢复 = 删掉整个测试目录重建**（别在原地修补）：① `node tools/e2e/seed-node.cjs`
② 起一次应用让扫描写出 `worldbuilding.json`（此时 `fields` 是**数组**）③ 关掉应用
④ `reset-entity-vault.cjs` + `seed-node.cjs` ⑤ 再起实例跑套件。
重建后 `codex-node-tab` 17/18 → **18/18**、`codex-tree-view` 21/22 → **22/22**
（之前那两条"fixture 漂移"其实就是这份脏数据）。

## 铁律 23 · 新写的断言若与前一条共享状态，自己先把状态摆正

`entity-evolution.cjs` 的 ★0f 已经把帧条**展开**了，随后我又写的 ★0f3 里**盲点**一次 toggle
⇒ 那一下变成"收起"，★0f3/★0f4/★0g/★0h 当场挂，**并把后面 16 条版本类断言一起带崩（30/49）**。
更要命的是：`git stash` 退回源文件后**同样 30/49、同样 19 条** ⇒ 一度被误判成"自己改的源码有回归"。
正确写法（与铁律 14 同源）：**先读状态再决定点不点** ——
`if (document.querySelector('.lk-rail__rows .lk-rail__row.is-ghost')) more().click();  /* 先收起来 */`
而且 `render()` 会换掉 DOM，**点完必须重新 `querySelector`**，老引用已脱离文档、点了没反应。

## 铁律 24 · 顺序类断言先问"**如果根本没排序**，这条会挂吗"

`rail-order.cjs` ★2 第一版的种子把两个版本放在**开头两个**节点上 ⇒ 距离序列恰好随 DOM 递增，
"按距离排"与"照着 DOM 顺序排"结果**一模一样** —— 于是它在**修复前的代码上也全绿**（假绿）。
把版本改到**两端**（距离 1/2/2/1，与 DOM 顺序不同）之后，★2/★7 在旧代码上才 FAIL。
**判据**：写顺序断言时先把"没排序会得到什么顺序"算一遍；两者相同就换 fixture。
同理：距离要在断言里**从 DOM 现算**（别写死"距离 1/2/3/4"——第一版我就是把距离算错了，
`dist` 恰好等于 DOM 序，于是又骗过自己一次）。

## 铁律 25 · 读"这一行该有的不透明度"之前，先把它身上的动画摘掉

`getComputedStyle(el).opacity` 对挂了动画的元素给的是**当前动画值**（延迟里是 0、跑一半是 0.93）。
`motion.ts` 的 `naturalOpacity()` 拿它当"终点值"，于是：同一次点击里 `playSwap` 对同一批行播**两遍**入场时，
第二遍读到的正是第一遍**延迟里的 0** ⇒ 转场演完整块内容不可见（`codex-smooth-switch.cjs` ★10 抓的是
`opacity: "0.934666"`，那是窗口可见时读到的一半路程值）。所以它内部先 cancel 掉这一行**所有动 opacity 的动画**再读。
配套：`autoRelease` 里 `Promise.all(anims.map(a => a.finished))` 要**各自 `.catch`** —— 一个被取消会让整体
reject，其余动画永远等不到取消、带着 `fill:'both'` 钉在终点值上。


## 铁律 26 · 两段动画"咬合"会叠字 —— 先走的必须**先走完**

收起文件夹时，里面那些行是**克隆出来的幽灵**（`position:fixed` 钉在原位、住在 `overflow:hidden` 的裁切层里）
在演退场，**真正的行**同时在往上补位。让后者**提前**起跑（本项目试过 `FLIP_OVERLAP = 0.55`，提前 40ms）
看着衔接更紧，实测换来的是**屏幕上同一行文字出现两份**：幽灵还在半透明（探针实测 132~187ms 窗口，
`hits: 1`），补位行已经滑进同一个位置。用户 2026-09-14 的原话就是「**文件收起时下面的文字会重叠
（多出来一份）**」。
判据：`flipDelayMs = rowsLeaveTotal(n, EXIT)`（首行 delay **正好等于**退场总时长），想"不拖沓"就去压
`EXIT`（150ms / 12ms），**不要**去缩那段等待。
⚠️ 同理：帧条那种"只有入场、没有出场"的地方，`rowsEnter` 的 `start` 默认是 `dur`（正文转场"先出后进"
用的）—— 不显式给 `0` 就白等一个 `dur`，框都在长了行还没出来（`rail-order.cjs` ★3b 盯这条）。


## 铁律 27 · 量"盒子想要多高"时，**滚动条不是内容**

给一个框做高度动画（`smoothBoxHeight(el, from)`）时，目标高度是**当场量**的。如果这一刻里面正有行在
演入场，而入场用的是**位移**（`translateX/translateY`）—— 位移会**撑出可滚动溢出**：`overflow: auto`
的盒子当场长出一条滚动条，`getBoundingClientRect().height` 就把它算进去了。等行们落定、滚动条一走，
框就"闪"矮一条滚动条的高度。用户 2026-09-14 的原话：「**展开后外面的框高度会闪**」；实测帧条那次
动画终点 `363.333px` 而自然高度 `348px` —— 差 15.33px，正好一条横向滚动条。

两条做法（都要）：
1. **盒子只在需要的方向上滚**：`overflow: auto` 配 `overflow-x: hidden`（横向没有可滚的东西就别让它滚）；
2. **量之前先把 `overflow` 钉成 `hidden`**（`smoothBoxHeight` 内部就是这么做的）—— 量到的才是内容高度；
   顺带：`scrollHeight`（不含滚动条）可以当"真正想要的高度"，`rail-order.cjs` ★4c 用的就是它。


## 铁律 28 · "上一轮在哪 / 这一轮在哪"：快照要**自己存**、而且要**按批提交**

给列表做 FLIP（`flipRows`）要两份位置：`prev`（改动**前**每一行在哪）与 `tops`（改动**后**）。后一份
当场量没问题；**前一份有两个坑**，帧条（`src/ui/evolution-rail.ts` 的 `rowTops`）都实测踩过：

1. **不能现场量 DOM**：行身上可能还挂着上一轮的让位/入场动画 —— `getBoundingClientRect()` 给的是
   **动画当前值**、不是布局位置（隐藏窗口里动画根本不推进，铁律 6，那就永远停在起点）。
   实测：展开时给 `n-ro-6` 播的 `translateY(-184px)` 让位动画停在起点 ⇒ 收起时量到的"旧位置"**正好等于
   新位置**（都是 92px）⇒ 位移算成 0 ⇒ 让位动画整个不演，产品看着就是"位置变化不平滑"。
   ⇒ 位置快照**自己存**（这次重画完、动画开演**之前**量的那一份）。
2. **也不能每一刀都提交**：一次用户动作里渲染函数常被连着调**好几刀**（store 通知 + 换锚点 + 切条目……，
   实测同一 tick 4 刀），而每一刀都会把行换成一拨**新元素** —— 动画挂在元素身上，
   第二刀一换 DOM 就把第一刀的动画**连同元素一起丢掉**（现象：`anims: []`，可框在长高、格子也在，就是没人演）。
   ⇒ 快照**按批提交**：`BATCH_MS = 80` 之内算同一批，批内每一刀都用**批开始前**的布局 ——
   算出的位移一样、都往当前这拨元素上重新挂一遍，**最后一刀留下的就是屏幕上那一份**
   （左树用的是另一条路：`withListHold()` 把中间那几刀**挡住**，效果相同 —— 关键是别让中间的 DOM 换代）。

顺带一条：**换了下拉/筛选之后，之前抓到的按钮引用已经脱离文档** —— 帧条里换完「记到」下拉会整条重画，
换之前 `querySelector` 拿到的「＋ 记一帧」`click()` 什么都不发生（`rail-order.cjs` 第一版就是这么白点的：
`frames` 一直是 2）。**换完必须重新查。**

## 铁律 29 · 断言"某一刻该是什么样"时，先问**窗口推不推进动画**

测试实例的 `document.visibilityState` **不一定是 hidden**：加了 `LINGKUANG_TEST_WINDOW_NOFOCUS=1`
通常不推进（WAAPI 冻在起点、`currentTime` 恒 0），但同一套 env 起出来的实例**有时也会正常推进**。
这一条直接决定"读取动画对象"这类断言能不能成立：

- **会推进**时，`fill:'none'` 的动画**演完就从 `getAnimations()` 里消失**（它不再是 relevant animation），
  `fill:'both'` 的还在。⇒ `rail-order.cjs` ★10 原来"点完等 260ms 再读新格子的入场动画"就是时绿时红的
  （实测同一份代码一次读到、一次读到空）——**改成在点击的同一个同步块里读参数**（动画是同步挂上的）。
- **要造"某一刻"的状态，就自己把时间按住**，别指望跑得够快：★12 要的是"框的高度动画先结束、被让位的行
  还在飞"那一瞬 ⇒ 在同一个同步块里**只暂停"行"的动画**并把它们按回起点（`a.pause(); a.currentTime = 0`），
  让**框的动画正常 `finish()`**，再 `await null` 几次把 `finished → 回调` 的微任务跑完，然后读数。
  ⚠️ **别把所有动画都 `pause()`**：老代码"松夹子"走的正是 `a.finished.then(...)`，一暂停它就永远不触发
  ⇒ 这条断言会变成**两边都绿**的废断言（`rail-order.cjs` ★12 第一版就是这个坑：旧代码也 26/26；
  只暂停行之后 A/B 立刻显出 `barW:16` 那条滚动条）。
- 两次点击挤在**同一个 tick** 里（比如"展开 + 收起"连点）时，第二刀看到的是**已经换好的新 DOM**
  ⇒ 什么动画都不建（实测 `sameEl:false` / `boxAnimN:0`）⇒ 要分两次 eval，中间等它落定。


## 铁律 30 · **别同时跑两个测试实例** —— 窗口互相遮挡会让"出帧"永久挂住

`motion-switch.cjs` 靠 `Page.captureScreenshot` 出帧（铁律 6），而**渲染进程只在窗口真的可见时才产帧**：
两个测试实例并排时后开的那个被压住 ⇒ 截图请求永远等不到帧 ⇒ 套件的 CDP `send()` **没有超时**，
于是整个套件挂死在那里（2026-09-15 实测：600s 被 pwsh 超时杀掉，只留下 ★1~★3 的 PASS）。

- 症状特征：**纯 DOM 的断言全过，一走到 `forceFrames()` 就停住不动**（不报错、不退出）。
- 规矩：**一次只留一个测试实例** —— 起新的之前先按 `--remote-debugging-port` 把旧的杀掉。
- 自证：同一个 build、同一份 fixture，**单独一个实例复跑 `motion-switch.cjs` = 25/25 PASS**。

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
