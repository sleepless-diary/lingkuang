# 灵框 LingKuang · 已知 Bug 清单

> 未修复的已知问题。修复时先读 `ARCHITECTURE.md`（尤其"关键坑"章节）。
> 每条标了复现路径和建议方向。修完请在条目上打勾并注明修复 commit。
>
> 2026-08-27 做了一轮全量审计（主进程 / 打包链路 / store / 时间线 / 编辑器 / 各工具面板），
> 下面「本轮已修复」记录已改掉的，文末「本轮新发现（未修复）」记录还没动的。
> 同日第二轮：继续清「底层」问题（数据保真 / 退出落盘 / 注入 / 死状态），见「第二轮已修复」。
> 同日第三轮：继续清泄漏与拖动兜底，见「第三轮已修复」。
> 同日第四轮：清掉一条会让**整个会话停止自动落盘**的异常链，以及 epoch/年份混用、
> vault 回扫清空地图与实体库两条数据损失，见「第四轮已修复」。
> 同日第五轮（用户选定 A = 删除保护 + 回收站恢复）：全仓破坏性操作加确认、回收站从
> 「只能移进去」补成「能列能恢复能清空」，并顺带修掉一条「删掉最后一个节点 → 整个世界被清掉」
> 的数据损失，见「第五轮已修复」。
> 2026-09-12 第六轮：修掉一条**启动即静默丢整个世界**的数据损失（`worldbuilding.json`
> 解析失败 → 被空数据覆盖），见「第六轮已修复」。

## 第二十二轮（2026-09-13 深夜）· 换条目转场落地 + 设置改成悬浮面板

> **需求**（用户原话）：「算了，就这样吧，**直接落地吧**，相关设置写入设置面板，对了，
> **我希望设置面板是悬浮面板，而不是单开一个标签页**」。
> 半句是"把演示页里谈定的转场做进应用 + 把旋钮放进设置"，后半句是"设置不能再顶掉主区"。
> 转场的规格是用户在 `docs/motion-demo/doc-slide.html`（演示页，随本轮一起入库当规格档）里
> 逐轮谈出来的，落地时逐条对应他的原话 —— 完整清单见 `docs/ARCHITECTURE.md` 的「动效」一节。

### 一、换条目转场（做法 P）

- **实现**：`src/ui/motion.ts` 新增 `rowsLeave(rows, {dx, step, dur})` / `rowsEnter(rows, {dx, step, dur, start})`
  （Web Animations API，`fill:'both'`）；`src/ui/codex.ts` 新增 `playSwap(body, prevHtml)` +
  `snapshotForSwap(body)` + `dropGhost()` + `rowsOf(root, skipGhost)`，`swapBody(animate = true)` 与
  `mountBody(prevHtml, animate)` 两条路都演；行由 `data-cx-row` 标出（实体：名字行 / 版本注 / 每个字段行 /
  正文块；节点：面包屑 + `#cx-props .ed-props > *` + 正文块）。CSS 只在 `src/style.css` 加了一条
  `.lk-cx-ghost`（`position:absolute; inset:0; padding:12px; overflow:hidden; pointer-events:none`）。
- **参数**（默认值 = 用户在演示页里点头的那套）：出场 `1/原位 → 0/translateX(-32px)`，
  `cubic-bezier(0.7,0,0.84,0)`（慢→快），300ms；入场 `0/translateX(32px) → 1/原位`，
  `cubic-bezier(0.16,1,0.3,1)`（快→慢），300ms，**整体延后 300ms**（先出后进）；每行 +10ms 错峰。
- **四个旋钮**（设置面板「换条目转场」卡片，改完立刻生效）：`motionSwap` 开 / `motionSpeed` 1× /
  `motionStagger` 10ms / `motionEnterDx` 32px；关掉＝瞬时换（真的不做动画）。减少动效偏好下退化成
  `.lk-swap-in` 一次短淡入（DESIGN.md:159）。

**自己写出来的三个坑（都已在代码里写清理由）**：

1. **`rowsOf` 的排除条件把幽灵的每一行也滤掉了**：`el.closest('.lk-cx-ghost')` 对幽灵内部的行**恒为真**
   ⇒ `exits` 是空数组 ⇒ `Promise.all([]).then(kill)` **立刻 resolve** ⇒ 幽灵当场被收掉。现象是
   「幽灵层存在过一瞬，读不到」——套件 ★1/★3 就是这么 FAIL 的（`ghost:false, outN:0`），
   而入场动画一切正常。修法：`rowsOf(root, skipGhost = true)`，扫 `#cx-body` 时排除、扫幽灵时传 `false`。
2. **`getKeyframes()` 里的数值是字符串**（`'1'`/`'0'`）：断言写 `kf[0].o === 1` 会**假挂**。
   两个套件都踩了（`codex-swap-motion` ★3/★4、`codex-smooth-switch` ★9），统一 `String(...)` 比。
3. **快照会把上一轮的幽灵一起拍进去**：幽灵也是 `#cx-body` 的子元素。第一版让"有幽灵时复用旧幽灵、
   不取新快照"，结果换类别走 `mountBody()` 时 `body.innerHTML = …` 会把旧幽灵**连 DOM 一起换掉**，
   而 `swapGhost` 还指着它 ⇒ 下一轮既没幽灵也没快照（`ghost:false`，只有入场）。
   改成：`snapshotForSwap()` **先 `dropGhost()` 再取 innerHTML**，`playSwap()` 开头也先收掉上一轮那层 ——
   「一轮只演一层：拿当前看得见的那份内容去演」，与演示页里那个循环模型一致；连点三下只留一层
   （`codex-swap-motion` ★11）。

### 二、设置改成悬浮面板（`Tool.panel`）

- 以前「设置」是普通工具：点它＝`#lk-module-view` 把主区整个换掉，改完还得切回来。
  现在 `src/tools/registry.ts` 的 `Tool` 多了 **`panel?: boolean`**，`openTool` 见到面板型工具
  **完全不碰主区**（不结算当前工具、不摘格子、不写 `#lk-module-view`），把它自己的悬浮层
  （`src/ui/settings-panel.ts`，挂 `document.body`、`position:fixed`）交给它自己管；
  清理函数单独存在 `disposePanel` 里（与 `disposeCurrent` 分开：**开设置不该把主区的工具关掉**）。
- 关法三种（× / Esc / 点遮罩空白），打开与关闭都广播 `lingkuang-panel`；`src/ui/shell.ts` 的
  `syncPanelButtons()` 据此同步左栏那个按钮的高亮 —— 再点一次按钮＝关（按钮是开关）。
- `src/ui/settings.ts` 的 `renderSettings(store, host)` 改名 `renderSettingsInto(host, store)`
  （宿主由悬浮层提供，它自己管尺寸与滚动），面板头部的「设置」由面板给，表单里原来那一行标题删掉。
- **`settings-panel.ts` 在 `register.ts` 里是静态 import**：左栏高亮要同步问它 `isOpen()`，
  同时静态 + 动态 import 同一模块会让 Vite 报 `INEFFECTIVE_DYNAMIC_IMPORT`（无效动态导入）警告。

### 三、连带改掉的测试

- `tools/e2e/motion-switch.cjs`：★7 原来点 `settings`（它已经不会切工具了）⇒ 换成 `schema`；
  ★13/★14 的反向守卫改成"内容区改播**行级 WAAPI 动画**"（`animationName` 为空的那批）；
  并在换类别之前**轮询等上一轮工具打开的错峰收手**（不干净的基线上 `#cx-root` 子项还挂着 `lk-wake`，
  实测让 ★13 假挂一次）。
- `tools/e2e/toolbar-groups.cjs`：★3 改成断言"悬浮面板 + 主区 HTML 未变"，新增 ★3b（再点＝关）。
- `tools/e2e/codex-tree-view.cjs`：★18 顺带断言设置是悬浮层、工作台那棵树没被顶掉，新增 18b。
- 新增 **`tools/e2e/codex-swap-motion.cjs`（14 项）** 与 **`tools/e2e/settings-panel.cjs`（12 项）**，
  两者都做过 A/B（改动前分别 **6/14** 与 **4/12** FAIL，断言有判别力）。

### 四、换类别时元素上下跳 7px（用户 2026-09-13 深夜报）

- 原话：「事件节点和设定实体切换时，元素 y 坐标会变，**应该是增加实体按钮的出现与消失导致的**」
  —— 用户猜对了，量下来一字不差。
- 实测（`tools/e2e/` 之外的探针，`%TEMP%\lk-yprobe.cjs`；窗口 1440×900）：

  | | 实体态 | 节点态 |
  |---|---|---|
  | 头行（`#cx-root` 第一个子元素）高 | **28px** | **21px** |
  | 三栏行 / `#cx-list` / `#cx-body` 的 top | 50 / 90 / 50 | 43 / 83 / 43 |
  | `#cx-newbox`（「类型下拉 + ＋新建实体」） | `display:flex`，h=28 | `display:none`，h=0 |

  那个按钮高 28px，而头行的文字只有 21px ⇒ 节点态把整组控件 `display:none` 之后头行矮 7px，
  **下面所有元素（三栏行 / 左树 / 中右栏）跟着上下跳 7px**。另一个探针证明 `#cx-root` **之上**的外壳
  （`#lk-alerts` / `.lk-app` / `.lk-main` / `#lk-module-view` / `.lk-tool-slot`）全程 top=0、h=863 不变
  ⇒ 与外壳无关。
- 修法（`src/ui/codex.ts`）：
  1. 那组控件**两种类别下都渲染**（`newCtl` 不再 `isEntity && …`），骨架里也不带条件 `display:none`；
  2. 新增 `syncNewBox()`：节点态**只藏不拆**（占位照旧 ⇒ 头行恒 28px），
     同时把里面那组控件 `disabled` —— **隐藏元素仍然吃程序化 `.click()`**，
     不禁用的话节点态下还能凭空建出一个实体（`#cx-new` 的处理器不看 mode）；
     （第五节的「两组控件按类别换」在这条之上继续加料：节点态那一格里装的已经不是实体控件，
     而是「时间线 ▾ + ＋新建节点」。）
  3. `mountBody()` 与 `render()` 里都调 `syncNewBox()`（原来是直接改 `style.display`）。
- 修后复量：头行两种模式都 28px，三栏行 top 都是 50、`#cx-list` 90、`#cx-body` 50。
- **A/B（新断言必须在修复前的代码上挂）**：把 `box.style.visibility` 改回 `box.style.display` 并重建，
  `codex-smooth-switch.cjs` 的 ★13b 立刻复现用户的症状 ——
  `{"before":{"list":{"t":90},"body":{"t":50},"newbox":{"t":14,"h":28}},"after":{"list":{"t":83},"body":{"t":43},"newbox":{"h":0,"vis":"none"}}}`。
- 测试：`tools/e2e/codex-smooth-switch.cjs` 18 → **20 项**，新增
  ★13b（换类别时左树/中右栏/那组控件的 top 相同、它的高度不变、节点态 `visibility:hidden` 且控件被禁用）
  与 ★14d（实体 → 节点 → 实体 绕一圈回来，框的位置与高度与出发时逐项相同）。
- ⚠️ 量几何时踩到的坑：`#cx-root` **自己就是滚动容器**，直接读 `getBoundingClientRect().top` 会把
  **滚动位置**算进来（★6 刚滚过 260px，基线就整体高 260 ⇒ 回程时对不上，★14d 假挂一次）。
  正确写法是换算到「面板内容原点」：`top - rootRect.top + root.scrollTop`。同理，
  **`display:none` 的元素 `getBoundingClientRect()` 全是 0**，只能拿它的 `h` 或 `display` 说话，别比 top。

### 五、顶栏那组控件按类别换：节点态**直接建节点**（用户 2026-09-13 深夜）

- 原话：「说实话，添加实体按钮在事件节点中其实可以改成添加节点的，**毕竟万一用户不知道
  添加事件节点要在世界沙盒怎么办**」→ 我提了「弹出建节点表单」的做法，用户回：「**添加节点就直接
  添加节点吧，就像添加实体一样**」⇒ 不做弹层，点一下直接建（与「＋新建实体」同一套手感）。
- 实现（`src/ui/codex.ts`）：
  - 顶栏那一个位置**两组控件**，按类别显隐：实体态 = 「类型 ▾ + ＋新建实体」（原样），
    节点态 = 「时间线 ▾ + ＋新建节点」。两组都是「一个下拉 + 一个按钮」的同一套样式（`NEWSEL`/`NEWBTN`），
    高度一样 ⇒ **换类别时头行高度不变**（第四节那条不变量继续成立，★13b 已改成断言这一条）。
  - `syncNewBox()` 改成切**组自身**的 `display`，并把隐藏那一组里的 `button/select/input` 全部 `disabled`
    —— 隐藏元素仍然吃程序化 `.click()`，不禁用的话节点态下还能凭空建出一个实体（反之亦然）。
    带 `data-off` 的控件（这个世界一条时间线都没有时的「＋新建节点」）在显隐切换里不会被重新启用。
  - `newTimelines()`（= 当前世界的时间线清单，`order` 在前）+ `nodeNewTlId()`（默认 = **正在编的那个
    节点所在的时间线**，没有就第一条）+ `nodeNewKind(tlId)`（默认跟正在看的那条**同种类** ⇒
    落在同一个文件夹；否则 `事件`，即 `main.js` 里 `kind` 缺省的兜底值、也是左树的分组口径）。
  - 点「＋新建节点」：`addNode(store, tlId, { title: '新节点', kind })` → `switchTarget()` 选中它 →
    `say('已新建，改个名字吧')`（和新建实体一模一样：名字/时间/字段都在中栏改）。
    ⚠️ `switchTarget` 里 `mode='node'` 与 `nodeTarget` 必须一起设 —— 只设 nodeTarget 的话，
    从实体态点过来时 `mode` 还是 entity，`bodyHtml()` 会按实体画中栏。
  - 一个自摆的坑：组容器与按钮**不能同 id**（第一版都叫 `#cx-new-node`）⇒ 容器 `#cx-new-node`、
    按钮 `#cx-new-node-btn`。`querySelector('#cx-new-node')` 抓到容器的话，监听器根本挂不到按钮上。
- 测试：新增 **`tools/e2e/workbench-add-node.cjs`（8 项）**：★0 节点态顶栏真的换成那一组（另一组藏起来
  且禁用、时间线下拉默认 = 正在看的那条）、★1 点一下树里多一行「新节点」且**没有**弹出表单、
  ★2 工作台选中了它（面包屑 / 标题字段 / 左树高亮）、★3 它落进 `vault/<世界>/主线/事件/新节点.md`
  （种类跟着正在看的那条）、★4 中栏改名 ⇒ 文件跟着改名且旧的「新节点.md」不留第二份、
  ★5 id 没变（是改名不是新建）、★6 左树那行跟着改、★7 无异常。
  **A/B（改动前 = `git checkout -- src/ui/codex.ts` + 重建）3/8**：★0/★1/★2/★3/★5 全挂，
  且 ★1 dump 直接看到树里只有「王国的建立」一行 ⇒ 断言有判别力。

### 六、新建的三件事：类型跟随 / 一次建多个 / 「待填」强调（用户 2026-09-13 深夜）

- 原话（一条消息里三件）：「**我想要当前选中的是哪个分类就自动在当前分类下创建实体，还有我希望
  能同时创建多个未填数据的实体或者节点（强调显示一下就行）**」。
- **类型跟随**：`syncNewType()` —— 实体态把 `#cx-new-type` 对齐到 `active()?.typeId`（选项里没有这个类型
  就不动，别硬写 value）。调用点只有 `syncNewBox()` 的末尾一处，于是 `render()` 与 `mountBody()` 两条路
  都覆盖到，`swapBody()` 的同类轻路径里另调一次（换条目 = 换目标，必须跟上）。
  **手动改选之后只要不换目标就保持你选的** —— 所以它不是在每次渲染都无条件覆盖。
- **一次建多个**：每组顶栏加一个数量框（`#cx-new-count` / `#cx-new-node-count`，`readCount(sel)` 夹
  1..`NEW_MAX = 20`，样式常量 `NEWNUM` 的高度必须与 `NEWSEL`/`NEWBTN` 一致，否则又回到第四节那个跳 7px）。
  点一下建 N 个，`switchTarget()` 选**第一个**（按顺序往下填最顺手）。
  名字必须唯一：`uniqueName(base, taken: Set<string>)` ⇒ 新实体 / 新实体 2 / 新实体 3 —— 同名会写进
  **同一个 `.md` 路径**互相覆盖（`entityPath`/`nodePath` 都按名字定路径，这是既有设计）。
- **「待填」强调**：`isStub(name)` = `/^新(?:实体|节点)(?:[ ]?\d+)?$/`；命中就在 `treeRow()` 里加 `is-stub`
  类 + 名字后挂一颗 `.ed-ttag` 小药丸「待填」（`.ed-tlabel` 走 accent 绿；样式与帧条的 `.lk-rail__tag` 同款）。
  四出行渲染处共用 `itemCls(on, name)` / `stubTag(name)`。**不存状态**，只看名字 —— 改过名/自己填了名字自动消失。
- 测试：`tools/e2e/workbench-add-node.cjs` **8 → 15 项**（★8 类型跟随 / ★9 批量 3 个且名字唯一 / ★10 三条都带
  「待填」/ ★11 三条都落 `_设定/<类型>/` / ★12 换条目时也跟上 / ★13 改过名就不再是「待填」/ ★14 节点侧也能量产）。
  ⚠️ ★8 的断言特意比「**不等于第一个选项**」：那条实体的类型（地点）不是下拉首项（角色），
  否则"没跟随"也能读到第一项 = 假绿。**A/B（改动前）8/15**，挂的正是 ★8~★14 七条。

### 七、帧条（演变）的出入场：原来是硬切（用户 2026-09-13 深夜）

- 原话：「（用户上一条消息的第三件）**演变窗口消失时编辑页的切换很生硬，顺便再给演变做一下出入场动画**」。
- 机制：`mountBody()` 里原来是 `railHost.style.display = mode === 'entity' ? '' : 'none'` —— 节点模式下
  `display:none` 让右栏**瞬间**消失，中栏随之变宽，整块布局"啪"地跳一下。
- 修法：`#cx-rail` **常驻骨架**，只 `classList.toggle('is-off', mode !== 'entity')`；CSS 侧
  `.lk-rail` 加 `transition`（宽/高/外边距/透明度 320ms + 位移 640ms），`.lk-rail.is-off` 收到
  `width:0; height:0; margin-left:-12px; opacity:0; transform:translateX(14px); border-width:0`。
  - `margin-left:-12px` 抵掉三栏那行的 `gap:12px`，否则收起了还留 12px 空档；
  - **高度必须一起收**：那行是 `align-items:flex-start`，帧条高度由内容决定，只收宽度的话内容被挤成
    一列、反而更高，把整行撑高（`#cx-root` 多一像素就长滚动条）。实测收起来是 0×0、展开回来 176×(自然高)。
  - ⚠️ `height: auto → 0` **过渡不了**（`auto` 不是可插值长度）⇒ 高度是瞬时收的。这在布局上看不出来
    （帧条比中栏矮，行高由中栏决定），★13b 钉的是"框不动"。
- 测试：`codex-smooth-switch.cjs` **20 → 21 项**，新增 **★13c**（元素常驻 + `.is-off` + `transitionProperty`
  含 width/height + 过渡对象里有 width/margin-left 且时长 > 0 + 起点 176px/不透明、终态 0×0/透明）、
  ★13b 与 ★14d 改成比帧条的 top/宽/高（原来比的是 `display`，实现改了就得跟着改）。
  **A/B（改动前）19/21**：★13b（`display:none` ⇒ 帧条 rect 全 0、top 对不上）与 ★13c
  （`off:false, transitionProperty:'all', 过渡对象 0 个`）精确复现。

### 验证（二十二）

- `codex-swap-motion` **14/14**（A/B 改动前 6 FAIL）；`settings-panel` **12/12**（A/B 4/12）；
- 换类别 y 跳 7px（第四节）：`codex-smooth-switch` **21/21**，A/B（退回 `display` 切换）时 ★13b 挂、
  其余照旧（判别力坐实）；
- 顶栏按类别换 + 直接建节点（第五节）：新增 `workbench-add-node`，第六节扩到 **15/15**，A/B（改动前）**8/15**；
- 帧条出入场（第七节）：`codex-smooth-switch` ★13c 新增，A/B（改动前）**19/21**（★13b/★13c 挂）；
- 回归全绿（都在**这个构建**上跑过，各自干净起点）：
  `codex-smooth-switch` **21/21**、`workbench-add-node` **15/15**、`codex-swap-motion` 14/14、
  `codex-node-tab` 18/18、`codex-tree-view` 22/22、`codex-switch-target` 7/7、`motion-switch` 25/25、
  `toolbar-groups` 5/5、`settings-panel` 12/12、`workbench-tree-folders` 29/29、
  `entity-evolution` 38/38、`entity-vault` 17/17；
- ⚠️ **踩到的假红灯**：`codex-node-tab` 16/18、`codex-tree-view` 21/22 曾同时挂，真因不是本轮改动，
  而是**上一个测试实例（A/B 用的 9782）没杀干净** —— 它的 store 里还留着上一轮改名/改类型的实体，
  我 reset+seed 之后它一次回扫就把旧实体写回 vault（`_设定/地点/银发少女.md` 复活，文件为源 ⇒ 类型被顶掉）。
  杀掉 9782、重新播种后两个套件立刻 18/18、22/22。**收尾务必按端口杀干净（可先 `Get-CimInstance` 列一遍）。**
  `tsc --noEmit` / `vite build` exit 0。
- ⚠️ 两条测试环境教训：① `toolbar-groups` **必须用全新实例** —— `codex-tree-view` 会把悬浮设置面板
  留在开着的状态，同实例接着跑时 ★3 点那一下变成"关"，且主区已被前一个套件改过
  （`moduleUntouched:false`），实测假挂一次；② `#cx-root` 是滚动容器，量几何要换算成内容原点坐标
  （见第四节末尾）。
- ⚠️ 视觉取证受限：`Page.captureScreenshot` 在隐藏窗口（`LINGKUANG_TEST_WINDOW_NOFOCUS=1`，实测
  `Page.bringToFront` 也救不回来，`visibilityState` 仍是 `hidden`）里**抓不到中间帧** ——
  动画要么停在 0、要么被出帧一次性推到底。所以转场的证据是**参数级断言 + 演示页**（用户自己在
  可见的 Edge 窗口里看过并点头），不是截图。

### 八、切帧时看不清"改动会写到哪儿" + 自动模式还摆着「＋记一帧」（用户 2026-09-13 深夜）

- 原话（同一条消息的另外两件）：「**我希望切换帧时直接高亮要写到的地方**，还有**自动模式下怎么还有
  记一帧的按钮**」。用户在我给的选项里选了「在帧条上把要写进去的那一格点亮 + 挂个『改这里』小标签」。
- 实现（`src/ui/evolution-rail.ts` + `src/ui/codex.ts`）：
  - `RailDeps` 新增 `getWriteTarget: () => string | null`；codex 侧新增 **`writeTargetNodeId()`** ——
    **只算不写**（⚠️ 不能复用 `editVersion()`：它会建帧、还会把视图挪过去，那是副作用）。三种模式的落点：
    锁定 = `evolveLock.nodeId`（且世界匹配）；自动 = 「记到」那一格（`railAnchor`，为 null 时退回正在看的那版）；
    手动 = 正在看的那一版（`railNode`，null = 初稿）。
  - 那一格加 `.is-write`（accent 内描边 ring，与 `is-on` 的深色底区分：**"正在看"与"会写进去"可以是两行**）
    + `.lk-rail__tag--write`「改这里」药丸（accent 实底）。两者重合时（自动模式下就是同一格）只挂一个标签。
  - **写目标那一格必须"看得见"**：帧条默认只列有版本的格子，而自动模式的「记到」常常还没版本
    ⇒ 单独把它补进 `shown`（虚化样子 + 「改这里」）。**这是 ★15c 逼出来的**：第一版没有这一步，
    实测 `is-write` 一个都没有（`aIdx:-1`）——"高亮要写到的地方"在格子上根本不存在。
  - 自动模式下**不渲染** `[data-rail-add]`（改动本就会自动记一版，留着按钮只会让人以为要手动点）；
    空状态文案跟着换成「改一下字段就会自动记一版」；「记到」下拉保留（它决定自动帧锚在哪个事件上）。
- 测试：`entity-evolution.cjs` **38 → 43 项**（★15 手动=正在看的那版 / ★15b 切到初稿写目标跟着挪 /
  ★15c 自动=「记到」那格且被拉进帧条 / ★15d 自动没有 ＋记一帧 / ★15e 锁定=锁住那格且只有一格亮）。
- 连带改：★0 的 `rows[0].n === '初稿'` 改成 `startsWith('初稿')`（名字后面现在可能跟着「改这里」标签）。

### 九、左树的增删重排是"啪"地换（用户 2026-09-13 深夜）

- 原话：「**新建实体和节点时不是硬切换，而是从左侧滑入（就像正文的入场一样），其下的所有节点都向下
  平滑移动（删除时也一样），展开文件夹时文件向下弹出**」。
- 为什么不能只靠 CSS：左树每次重画都是 `innerHTML` 整块换掉（元素**新建**、没有"旧位置"），
  transition/keyframes 都表达不了"从旧位置滑到新位置"。`src/ui/motion.ts` 新增三个原语 + 一个测量器：
  | 原语 | 用途 | 关键帧 |
  |---|---|---|
  | `rowSlideIn(el, {dx=24,dur=320,delay})` | 新出现的行 | `translateX(-24px)/0 → none/1`（快→慢，`fill:'both'`） |
  | `flipRows(rows, keys, tops, prev, {dur=320})` | 其余**位置变了**的行 | `translateY(旧-新) → none`（`fill:'none'`） |
  | `rowsDropIn(rows, {dy=8,dur=260,step=22})` | 展开文件夹露出来的行 | `translateY(-8px)/0 → none/1`，逐行 +22ms |
  | `rowLeaveAndRemove(el, {dx:24,dur:260})` | 被删的那一行（幽灵） | `none/1 → translateX(-24px)/0`（慢→快），演完 `el.remove()` |
  | `topsOf(container)` | 量"相对容器顶部"的 top | ——（相对值，避开页面滚动） |
- 左树侧（`src/ui/codex.ts`）：行加稳定键 `data-cx-key`（`<act>|<id>`）；`renderList()` 结尾量一次位置、
  与上一轮快照 `rowTops` 做 FLIP、把"新出现的行"分成两类（展开露出来的 → `rowsDropIn`；真新建的 →
  `rowSlideIn`，错峰 30ms 封顶 240ms）；**首次渲染 / 整块重建后不演**（`cold = prev.size === 0`）。
  展开时在 `bindTreeClicks` 里记 `justOpened = <键>`（键与 `collapsed*` 三个 Set 同构），
  renderList 按祖先链判断一行是不是"刚被展开出来的"。
- **两个坑（都在代码里写了理由）**：
  1. **两次重画会把刚起头的动画顶掉**：`addEntity()` 走 `store.update` ⇒ store 订阅**同步**重画一次左树，
     紧接着 `switchTarget()` 又重画一次 —— 两次落在同一个 tick，浏览器中间根本不合成帧，动画连一帧都
     没画出来。修法：新增 `withListHold()`，建 N 个 / 删一条期间**先别重画**，末尾一次画完。
  2. **删除中途会把位置快照冲掉**：删掉"当前正在编的那条"会让正文签名变化 ⇒ 中途触发一次整块 `render()`，
     左树元素全换 ⇒ 靠"上一次 renderList 留下的快照"会在这中间失效（实测删完**没有**让位动画）。
     修法：`snapshotRows()` —— 删除前**主动拍一张**旧位置快照。
- 删除时被删的那一行留一个**钉在原位的幽灵**（`pinRowGhost()`：`cloneNode` + `position:fixed` 挂在
  `document.body` 上，因为 `#cx-list` 马上会被清空；克隆体里的 `[id]` 全摘掉，否则页面上会多出第二个
  `#cx-fields`/`#cx-doc`，`querySelector` 抓错元素）。

### 十、帧条收起时"直接消失"（用户 2026-09-13 深夜报，第七节的后续）

- 原话：「**对了，从设定文件切换到节点文件演变面板会直接消失**」。
- 抓帧探针（`%TEMP%\lk-railoff.cjs`，点节点行后连采样）实测：点下去**同一个 tick** 里
  帧条 `h` 已经从 **271 → 1**，而 `w` 才刚开始走（176 → 79 → 10 → 0）⇒ `overflow:hidden` 当场把内容裁没，
  那 320ms 的宽度收起**根本看不见**。元素身份没变（`same:true`，不是被重建）。
- 根因：`.lk-rail.is-off { height: 0 }` —— `height: auto → 0` **不是可插值长度**，过渡对它是**瞬时**生效的
  （第七节当时就是这么写的，还写着"布局上看不出来"；在"收起"这个方向上它其实把整个动画吃掉了）。
- 修法（`src/ui/codex.ts` 的 **`setRailOpen(open)`** + `src/style.css`）：
  - `.is-off` 里**删掉** `height: 0`，改由 JS 在 **420ms 后**加 `.is-collapsed { height: 0 }`
    （那时 opacity 已经到 0，收高度看不出来）；展开时立刻摘掉两个类（宽度从 0 长出来，观感就是拉开）。
  - `.lk-rail > * { min-width: 168px }`：宽度收到 0 的过程中内容**不许重排**（实测子项宽度 175 → 18，
    挤成一列会让高度暴涨、把那一行撑高、`#cx-root` 平白长滚动条）。
  - 骨架里节点态直接给 `class="lk-rail is-off is-collapsed"`（首帧不演）。
- 复测：收起时 `h` 保持 271 直到宽度走完（176 → 43 → 6 → 0），之后才 `.is-collapsed` → h=0；展开时
  高度立刻回来、宽度 106 → 172 → 176。
- 测试：`codex-smooth-switch.cjs` ★13c 反转为「**同一 tick 里高度必须还撑着**（`h1 > 0` 且没有
  `.is-collapsed`）」，新增 **★13c2**「演完之后 `.is-collapsed` + 宽高都 0」。**A/B：改动前 ★13c 挂**
  （读到的正是那个被瞬时归零的高度）。

### 十一、⚠️ 一次建多个会**静默丢数据**（`'e' + Date.now()` 撞车，本轮自查 + 新套件逼出来的）

- 现象：点一次「＋新建实体」（数量 3）只活下来 **2** 个，名字还跳号（`新实体 / 新实体 3`，
  中间的 `新实体 2` 连 JSON 带 vault 一起没了）。是 `tools/e2e/codex-list-motion.cjs` 的 ★1 逼出来的：
  它断言"新建出来的那几行都从左侧滑入"，第一版实测只数到 2 行。
- 根因：`src/store/actions.ts` 六处 id 都是 **`'e' + Date.now()`**（节点/时间线/地图/循环/剧情线同理）。
  批量建条目时循环在**同一毫秒**里跑完 ⇒ 三次拿到**同一个 id** ⇒ `entities[id] = {…}` 后建的把先建的
  **覆盖**掉（vault 侧同一个 `.md` 路径也互相覆盖）。**界面上只看见少了一行，没有任何报错。**
- 修法：新增 **`src/store/ids.ts`** 的 `uid(prefix)` —— 「**单调时钟**」：以 `Date.now()` 打底，
  同一毫秒内依次 +1（`lastStamp`），永不重复；id 仍是"前缀 + 十进制数字"，排序语义与 vault 文件名都不受影响。
  六处生成点（`addTimeline`/`addNode`/`addEntity`/`addMap`/`addLoop`/`copyNode` + `ensureTimeline` 里那个
  带随机数的）+ `src/ui/map.ts`（默认地图 / 区域 / 标记）+ `src/ui/timeline.ts`（剧情线）全部改用它。
- A/B（同一个探针、同一台机、各自干净起点）：**改动前 建 3 个 → JSON/vault 各只剩 2 个**；
  改动后 → **3 个**（`新实体 / 新实体 2 / 新实体 3`，行数 +3）。vault 侧也逐份核对过。

### 十二、收起文件夹时，里面的行是**"啪"地消失**的（用户 2026-09-14 报）

用户原话：「**设定文件夹收起时无动画，收起时下面的文件直接消失**」。

- **为什么上一轮的"收起上补"没盖住它**：上一轮做的是**其余行**的 FLIP（下面那些行平滑补位），
  而**被收掉的那几行本身**是随 `renderList()` 的 `innerHTML` 一起没的 —— 元素根本不再存在，
  没有任何东西可以演退场。删除条目那条之所以有动画，是因为它单独造了幽灵层
  （`pinRowGhost()`），收起这条当初漏了。
- **修法**：通用化出 `ghostRows(rows)`（一批行克隆成 `position:fixed` 钉在原位的幽灵，
  标 `lk-list-ghost` 类，`z-index: 860`，克隆体里的 `[id]` 全摘）；收起时先用
  `descendantsOf(el)` 找出"这一枝底下的行"（按 `rowDepth()` 判层级：世界 0 / 时间线·`_设定` 1 /
  种类·类型 2 / 节点·实体·空提示 3；DOM 里紧跟其后、层级更深的那些），克隆钉住 → `renderList()`
  → `rowsLeaveAndRemove(ghosts, { dy: 8, dur: 260, step: 22 })`（`src/ui/motion.ts` 新增的
  "一批行退场后从 DOM 摘掉"，与单行版 `rowLeaveAndRemove` 同族）。
- **退场姿势：展开入场的倒放**（用户 2026-09-14 看过第一版之后：「**文件出场动画改成入场的反向就行了**」）。
  第一版收起时是"往左 20px 淡出"，与展开时的"从上方 -8px 落下来"没关系，两件事各演各的；
  现在收起 = `rowsDropIn` 倒着播：方向 `none/1 → translateY(-8px)/0`（往上 8px 升走）、
  时长 260ms、错峰 22ms 全对齐，曲线也倒过来（入场 快→慢 `cubic-bezier(0.16,1,0.3,1)`
  的倒放就是出场 慢→快 `cubic-bezier(0.7,0,0.84,0)`），**延迟顺序也反过来**
  （`[...ghosts].reverse()`：入场时最后落地的那一行最先升走）。
  `RowMotionOpts` 因此多了个可选的 `dy`：给了它 `rowsLeave()` 就走上下、不给还是左右
  （换条目转场继续用 `dx`）。**断言直接拿入场的关键帧来比反向**（★4c2：出场的终点 = 入场的起点
  `translateY(-8px)/0`、出场的起点 = 入场的终点 `none/1`）—— 比各写各的字面量可靠：
  ⚠️ 上一版 `open1` 里混着 FLIP 让位行（`translateY(-21.39px)/ → none/`），交叉断言被它们搅黄过一次，
  现在先按 `to === 'none/1'` 把"展开露出来的行"筛出来再比。
- **教训（断言侧）**：同一时刻页面上可能**同时挂着好几批幽灵**（收起 A 还没演完又收起 B；
  隐藏窗口里 `finished` 永不 resolve，只能等 `dur + step*n + 400ms` 的兜底定时器）。
  第一版断言直接数 `document.body.children` 里 `z-index === 860` 的，把上一批 4 个也算进去了
  （实测 `before:1, ghosts:6`）⇒ 现在先记下点击前已有的 body 子元素、**只认这一批新增的**。

### 十三、新建的节点"先挂在末尾、过一会儿跳到别处"（用户 2026-09-14 报）

用户原话：「**新建节点时直接插入尾部然后移到正确的顺序，能不能直接插入到对应的位置**」。

- **机制（两个各管一半）**：
  1. **左树的节点顺序原本 = 数组顺序**（`tlGroups()` 直接遍历 `tl.nodes`）。而 `tl.nodes` 会被
     **vault 回扫整条换掉**（`src/main.ts:142` 的 `nodes` 来自扫描结果 ⇒ "文件夹 + 文件名"顺序），
     于是新建的节点在内存里先追加在末尾、下一次回扫后又跳到别处 —— 用户看到的"跳"就是这个。
  2. **新节点的 `year` 默认是 0**（`addNode` 的缺省），所以它出生在时间轴最左端，
     跟"我想在这儿加一件事"没有关系。
- **修法**：① `tlGroups()` 里把每条时间线的节点**按 epoch 排**（`epochOfNodes(w)`，与沙盘上
  从左到右的同一套换算；同一时刻的按 id 排 —— id 是单调时钟，保住连建时的创建次序），
  顺序从此由**数据**决定，与数组/文件名顺序无关；② 新增 `cursorYear(tlId)`：新节点的 `year`
  取**时间指针那一年**（`fromEpoch(calendarOf(tl), timeCursor)`），于是它一建出来就落在对应位置。
  ⚠️ `fromEpoch` 返回的是 **`{ anchor: { year }, values: {...} }`**，不是顶层 `year` ——
  第一版写成 `tp.year` 静默拿到 `undefined` ⇒ 退回 0（★16 当场抓住：`appliedYear: "0"`）。
- 顺带：搜索命中的节点列表（`flatNodes()`）也走 `tlGroups()`，所以一起变有序。

### 十四、「类型」不该是能按版本改的东西（用户 2026-09-14 问）

用户原话：「**时间帧内为什么能修改实体的类型**」。

- **为什么它是错的**：类型决定 `.md` 落在 `_设定/<类型>/` 哪个文件夹（`entityPath()`），
  而**文件名只按初稿的名字算**。让某一帧改类型 ⇒ 文件留在旧文件夹里、界面写着新类型，
  下一次回扫（类型从**文件夹名**来，见 `mergeEntities`）又把它顶回去，两边永远对不上。
- **修法（两半，合起来才是完整语义）**：
  ① `commitState(v, next)` 里 v ≥ 1 时，算差异前把两边的 `typeId` 都归一到**实体现有的**
  `typeId`（`norm(s)`）⇒ 版本差异里永远不会出现 `typeId`；
  ② `#cx-type` 的 change 不再走 `patchVersion`，而是直接改实体本身（`withQuiet` + `store.update`
  + `statesId = ''` 作废旧缓存 + `swapBody(false)`），提示改成「已换类型（作用于整条设定，不记进版本）」；
  ③ 中栏那个下拉的选中值也取**实体自己的** `typeId`（不是这一版的），
  并在站在帧上时把 `#cx-vnote` 补一句「· 类型改的是整条设定，不记进版本」。
- 实测（`entity-evolution.cjs` ★16/★16b/★16c）：站在第 1 版上把类型从「角色」改成「物品」
  ⇒ 文件搬到 `_设定/物品/银发少女.md`、旧文件夹不留第二份、**这一帧的 `patch` 只有 `set`/`doc`
  两个键（没有 `typeId`）**、既有版本历史逐字节不变；改回去文件也搬回 `_设定/角色/`。

### 十五、顶栏那组「新建」控件：说清用途 + 一个按钮滚字（用户 2026-09-14 两条）

用户原话：「**新建实体左边两个按钮有什么用**」+「**新建实体按钮里面实体和节点文字的切换做成类似老虎机的上下切换**」。

- **"两个按钮"其实是**「类型 ▾」下拉和「数量」输入框 —— 它们跟真正的按钮用同一套尺寸样式，
  看起来像两个用途不明的按钮 ⇒ 各挂一个 `.lk-newlbl` 小标签（`类型` / `时间线` / `数量`），
  按钮自己的 `title` 也补成「新建条目（类型 / 数量看左边）」这类人话。
- **滚字**：原来两组各有一个按钮、靠 `display` 交替显隐 —— 换的是**元素**，
  因此"实体 ↔ 节点"这几个字的切换根本没有可演的动画。现在顶栏只有**一个** `#cx-new`：
  两组各留自己的「下拉 + 数量」，按钮的标签包在 `.lk-roll`（裁切盒）里，
  `rollText(box, next)`（`src/ui/motion.ts` 新增）把旧字克隆一份盖在原处往上滚出、
  真标签从下方滚入（同样的 `EASE_ACCEL`/`EASE_DECEL` 一对镜像曲线），跑完两个动画都取消、
  克隆体摘掉 —— 留着会让"换类别后不许有动画"那几条守卫失灵。
- 判别力：A/B（`git stash` 掉 codex.ts + rebuild）时按钮根本不存在 `.lk-roll`，
  ★13d 读到 `out/in` 皆空；改后实测关键帧 `translateY(0px) → translateY(-13px)`（出）
  与 `translateY(13px) → none`（入）。
  （这一版的"整串字一起滚 + 滚 13px"后来被用户推翻，见第十六节。）


### 十六、滚字看着"糊成一团"：只有两个字该滚、滚一格要够一行字高（用户 2026-09-14 两条）

用户原话：「**新建实体按钮文字会重叠**」+「**我希望滚动的只有实体和节点两个字**」。

- **症状**：换类别时（实体 ↔ 节点）按钮上那串字像两层字叠在一起。
- **两个原因叠在一起**，都在"滚一格"这件事上：
  ① 滚的是**整串字**（「＋新建实体」↔「＋新建节点」）—— 前缀也有半截留在裁切盒里；
  ② 滚动距离写死 **13px**，而一行 CJK 字高实测 **16px** ⇒ 旧字与新字在盒子里**始终叠着 3px**，
     而两者都是不透明的，看上去就是文字重叠。
- **修法**（`src/ui/codex.ts` + `src/ui/motion.ts`）：
  ① 按钮改成 `<button id="cx-new">＋新建<span class="lk-roll"><span class="lk-roll__t">实体</span></span></button>`
     —— 不动的「＋新建」放在裁切盒**外面**，盒里只有会变的那两个字（实体 / 节点 都是 2 字，宽度也一样，
     所以按钮宽度不会抖）；`rollText(btn.querySelector('.lk-roll'), isEntity ? '实体' : '节点')`。
  ② `rollText()` 的 `dy` 默认值从写死的 13 改成 **裁切盒自己的高度**
     （`const dy = o.dy ?? Math.max(12, Math.round(box.getBoundingClientRect().height) || 16)`）——
     "一格"就是"一行"，旧字整行移出、新字整行移入，任何一帧都只有一行字在身上。
- 实测（真实 Electron + CDP）：按钮 83×30、裁切盒 **22×16**（`overflow:hidden`）、
  出 `translateY(0px)/1 → translateY(-16px)/0`、入 `translateY(16px)/0 → none/1`；
  演完 `.lk-roll__prev` 0 个、标签上 0 个动画、按钮文字 = 「＋新建节点」。
  截图核对：静止帧 = 干净的「＋新建实体」；滚到一半的那一帧里两个字**上下分开**（各露出一半），
  不再叠在同一处。
- 断言：★13d 改成「`fix === '＋新建'` + `label === '节点'` + 拼起来还是「＋新建节点」」，
  另加 **★13d3**「滚动距离 = 裁切盒高度（≥ 一行字高）」。
  ⚠️ 断言里**不能直接读 `btn.textContent`** —— 这一刻盒里还挂着克隆的旧字，
  会读成「＋新建节点实体」（第一版就是这么假挂的，改成"前缀 + 真标签"拼）。
  **A/B（`git checkout --` 两个源文件 + rebuild）24/26**，挂的正是 ★13d 与 ★13d3；
  修复后 **26/26**（`workbench-add-node.cjs` 的 ★0 也同步改成读"前缀 + 真标签"，19/19）。
- ⚠️ 又一次踩到**模板字符串里写反引号**：套件里那些给 `Runtime.evaluate` 的注释里写
  `` `.lk-roll__prev` `` 会把模板字面量提前闭合（`SyntaxError: missing ) after argument list`），
  中文注释里一律不写反引号（与 AGENTS 里那条"别把 UTF-8 源码往返 PowerShell"同族的低级坑）。


### 十七、收文件夹"先往左跳"、退场错峰反着来、滚字两段还是同时播（用户 2026-09-14 第二轮两条）

用户原话：「**节点和实体两个文字会重叠**」+「**收起文件时文件会先向左移，然后再上隐，而且没有像入场一样的错分**」。
两条都是第十六节的**后续反馈**（上一版改过、但改得不够），三个根因：

① **收起时"先往左移"** = 幽灵行的缩进被清零。`ghostRows()` / `pinRowGhost()` 克隆行时写了
   `padding:0`（想"干净一点"），而树里那些缩进恰恰是**各层类的 `padding-left`**：
   世界 8px / 时间线·`_设定` 18px / 种类·类型 27px / 条目 36px ⇒ 克隆体当场少掉 18~36px 的左缩进，
   看着就是"文件先往左跳一下"。修法：**别覆写 padding**（克隆体带着同一个类，缩进本来就对）。
   实测（`codex-list-motion` 的 ★4d）：改前 `padL:"0px"`，改后 `padL:"36px"` 与原行逐项一致。
② **退场错峰"不像入场"** = 顺序被反转 + 没有上限。上一版用 `[...ghosts].reverse()` 让"最后落地的先走"，
   而**入场是自上而下一行行出来**的（`rowsDropIn` 用 `delay: i * step`）⇒ 退场倒着播，波浪方向跟入场对不上。
   更要命的是错峰**不封顶**：实测 44 行的文件夹里第一行要等 **946ms** 才动
   （`delays: [946,924,…,0]`），看着就是"卡住不动然后整片消失"。修法两条：
   · `leave()` 不再 `reverse()` —— 与入场同序（0/22/44…，自上而下）；
   · `src/ui/motion.ts` 的 `rowsLeave` 与 `rowsDropIn` 都加 **`maxDelay`（默认 `MAX_STAGGER = 240`ms）**：
     `delay: Math.min(i * step, maxDelay)`。实测 13 行时 `[0,22,44,…,240,240,…]`（尾部一起动），
     不再是 264ms 起的倒序。
③ **滚字"还是会重叠"** = 两段同时播。第十六节把滚动距离改成"一格 = 一行字高"之后，
   两行字在**几何上**正好首尾相接、不叠；但它们**同时**在动、且都还半透明 ⇒ 中间那几帧是
   "旧字的下半截 + 新字的上半截"各一层笔画，看上去仍是糊成一团（用户的原话就是"会重叠"）。
   修法：`rollText()` 改成**两段错开**播 —— 旧字先走（`duration: dur`，delay 0），
   新字等它走完再进（`delay: dur`），每段默认 `dur = 180`（整段换字 360ms）。
   这样任何一帧要么只有旧字在往上走、要么只有新字在往下落，中间那一下盒里接近空的。
- 断言：`codex-list-motion.cjs` 17 → **19 项**（新增 **★4d** 幽灵长在原位、**★4e** 退场错峰同序且 ≤240ms；
  ★4d 顺带盯 `_設定` 那一大枝的 `bigPad` 也全 > 0）；`codex-smooth-switch.cjs` 26 → **27 项**
  （新增 **★13d4**「旧字先走、新字后到：`in.delay === out.dur`」）。
- **A/B（先在改前的代码上跑，确认有判别力）**：
  · `codex-list-motion` **17/19** —— 挂 ★4d（`geoGhost padL "0px"` vs 原行 `"36px"`）、
    ★4e（`delays: [264,242,…,0]`，倒序且超上限）；
  · `codex-smooth-switch` **26/27** —— 挂 ★13d4（`out:{dur:260,delay:0}` / `in:{dur:260,delay:0}`，两段同时）。
  修复后分别 **19/19**、**27/27**。
- ⚠️ **★13d2 从"固定 sleep 700ms"改成轮询**：滚字收手在隐藏窗口里靠 `rollText` 的兜底定时器
  （`dur*2 + 600` = 960ms），而固定等 700ms 会压在边界上假挂。**动画的"收干净"一律轮询，别用固定 sleep。**


### 验证（二十二 · 续）

- `tools/e2e/codex-list-motion.cjs`（**新增，14 项**）：★1/★1b 新行从左侧滑入且错峰 0/30/60、
  ★2 其余行 FLIP（**方向不写死**：插在上面是向下让位、插在下面是向上让位，两种都对）、
  ★3/★3b 展开文件夹的行向下弹出（错峰 22ms）、★4/★4b 收起→向上补位、再展开→向下让位、
  ★5/★5b/★5c 删除的幽灵钉在原位往左退场 + 下面的行补位 + 行数 -1、★5d 幽灵演完自己摘掉、
  ★6 减少动效时**一次动画都不演**、★7 无未捕获异常。
  **A/B（`git stash` 掉 motion.ts/codex.ts/evolution-rail.ts/style.css + rebuild）4/14** ——
  正好是那 10 条新断言全挂（★5d/★6/★7 是守卫，两边都过）。
- `entity-evolution.cjs` **43/43**（新增 5 项见第八节）；重跑要**重新播种 + 重启**（脏实例连跑第二遍会掉到 31/38）。
- 回归全绿（都在这个构建上、各自干净起点）：`codex-smooth-switch` **22/22**、`codex-swap-motion` 14/14、
  `codex-node-tab` 18/18、`codex-tree-view` 22/22、`codex-switch-target` 7/7、`workbench-add-node` 15/15、
  `workbench-tree-folders` 29/29、`motion-switch` 25/25、`toolbar-groups` 5/5、`settings-panel` 12/12、
  `entity-vault` 17/17、`kind-change-stale-file` 11/11；`tsc --noEmit` / `vite build` exit 0。
- ⚠️ 又一次踩到 **PowerShell 往返 UTF-8 源码**的坑：用 `(Get-Content -Raw) -replace … | Set-Content -Encoding utf8`
  批量改 `src/store/actions.ts` 的 id 生成，把中文注释全写成了乱码（还加了 BOM）。
  救法：`git checkout -- src/store/actions.ts`，改用 edit 工具逐处改。
  **批量改名/替换一律用 edit 工具或 node 写文件，别走 PowerShell**（SKILL `never-roundtrip-utf8-source-through-powershell`）。

### 验证（十二 ~ 十五）

- `codex-list-motion.cjs` **14 → 17 项**：新增 ★4c（收起「事件」时里面那些行变成**钉在原位的幽灵**、
  行数归零、幽灵文字就是那一行）、★4c2（退场 = **展开入场的倒放**：`none/1 → translateY(-8px)/0`，
  关键帧直接把 ★4b 记下的入场起点/终点反过来比）、★4c3（演完自己摘掉）。
  **A/B（`git stash push -- src/ui/codex.ts src/ui/motion.ts src/style.css` + rebuild）15/17** ——
  挂的正是 ★4c/★4c2（dump 里 `ghostAnim` 为空）。修复后 **17/17**。
- `workbench-add-node.cjs` **15 → 19 项**：新增 ★0b（两个控件各有说明小字）、
  ★15（左树按时间排：`year:1` 的「上古」排到 `year:312` 的「王国的建立」前面）、
  ★16（工作台建的节点 `year` = 时间指针那一年 200，不是旧默认的 0）、
  ★17（它落在 上古(1) < 新节点(200) < 王国的建立(312) **中间**，而不是挂在末尾）。
  前置多了一步：`$env:LK_SEED_ORDER="1"` 再跑 `seed-node.cjs`（它会多播一个 `year:1` 的「上古」，
  并把 `timeCursor` 设在 year 200 —— 公历换算与 `src/calendar.ts` 的 `toEpoch` 同一套公式）。
  **A/B（只 stash 源码）9/19** —— ★15/★16/★17 全挂（`appliedYear: null`、顺序 = 数组顺序）。

### 验证（十六）

- `codex-smooth-switch.cjs` **25 → 26 项**：★13d 改成"只有那两个字滚"、新增 ★13d3（滚一格 = 盒高）。
  **A/B（把 `src/ui/codex.ts` + `src/ui/motion.ts` 退回 HEAD + rebuild）24/26**（挂 ★13d/★13d3，
  dump `{"fix":"＋新建节点＋新建实体","outN":[0,-13]}`）；修复后 **26/26**。
- `workbench-add-node.cjs` ★0 的读法同步改成"前缀 + 真标签"（`btnText === '＋新建节点'`），**19/19**
  （⚠️ 必须先杀干净上一轮实例再 reset + seed：留着旧实例它会把自己内存里的 `新实体 2/3` 写回 vault，
  `uniqueName` 就从 4 开始跳号、★9/★10/★11/★13 一起假挂 —— 本轮踩到过一次）。
- 回归全绿（各自干净起点）：`codex-swap-motion` 14/14、`codex-list-motion` 17/17、
  `codex-node-tab` 18/18、`codex-tree-view` 22/22、`motion-switch` 25/25；
  `tsc --noEmit` / `node --check` / `vite build` 全 exit 0。
- ⚠️ 端口又撞上一次：`--remote-debugging-port=9935` 落在 **Steam** 手里（`/json` 返 404 HTML）
  ⇒ Electron DevTools 起不来。选端口后**先轮询 `/json/version` 看到 `Browser` 再往下跑**。
  修复后 **19/19**。
- `entity-evolution.cjs` **43 → 46 项**：新增 ★16（站在帧上改类型 ⇒ 文件搬到 `_设定/物品/`、
  `#cx-vnote` 有那句提示、这一帧的 `patch` 不含 `typeId`）、★16b（搬过去那份帧与搬之前**逐字节相同**）、
  ★16c（改回「角色」文件也搬回来）。**A/B 44/46**（★16/★16b 挂；★16c 因为"根本没搬走"而空过，
  它是 ★16 的配套守卫，判别力由 ★16 承担）。修复后 **46/46**。
  ⚠️ 这套件跑之前必须 `reset-entity-vault.cjs` + `seed-evolution.cjs` 再重启：只跑 seed 的话
  vault 里上一轮的 `#演变：` 段会被回扫捞回来（**帧是文件为源**）⇒ ★0/★5/★5b/★9/★9b/★10 六条一起假挂
  （实测 39/46，差点当成回归）。
- 回归全绿（各自干净起点）：`codex-smooth-switch` **25/25**（★13d 滚字关键帧、★13d2 旧字克隆与动画都收干净、
  ★13g 两组说明小字）、`codex-swap-motion` 14/14、`motion-switch` 25/25、`codex-node-tab` 18/18、
  `codex-tree-view` 22/22、`codex-switch-target` 7/7、`settings-panel` 12/12、`toolbar-groups` 5/5、
  `data-load-clean` 6/6、`entity-vault` 17/17、`kind-change-stale-file` 11/11、
  `workbench-tree-folders` 29/29；`tsc --noEmit` / `vite build` exit 0。
- ⚠️ 两个"看似回归"的假挂，成因都是**脏实例**：`codex-list-motion` 紧跟 `workbench-add-node` 跑（14/17）、
  `entity-evolution` 只播种不 reset 就跑（39/46）。**每个套件都要自己那一份干净起点**，
  并起来跑之前先想清楚它动了哪些文件。

### 验证（十七）

- `codex-list-motion.cjs` **17 → 19 项**（新增 ★4d 幽灵长在原位、★4e 退场错峰同序且 ≤240ms；
  为量"错峰顺序与总量"，套件里额外收起一次 `_設定`（13 行）再展开回来）。
  **A/B（`git checkout -- src/ui/codex.ts src/ui/motion.ts` + `vite build`）17/19** ——
  挂 ★4d（`geoGhost padL "0px"` vs `geoBefore "36px"`）、★4e（`delays:[264,242,…,0]`）；修复后 **19/19**。
  ⚠️ 本套件跑之前**不要**设 `LK_SEED_ORDER=1`：`★4c` 断言「事件」下那些幽灵都叫「王国的建立」，
  多播一个「上古」就会挂（本轮我先误设了一次，5 秒就复现了这条）。
- `codex-smooth-switch.cjs` **26 → 27 项**（新增 ★13d4）；**A/B（退回 HEAD 的 `src/ui/motion.ts`）26/27**，
  dump `{"out":{"dur":260,"delay":0},"in":{"dur":260,"delay":0}}`；修复后 **27/27**。
  同套件的 **★13d2 改成轮询**（固定 `sleep(700)` 会压在 `dur*2+600=960ms` 兜底定时器前面 ⇒ 假挂）。
- 回归全绿（各自干净起点）：`codex-node-tab` 18/18、`codex-tree-view` 22/22、`workbench-add-node` 19/19
  （lk-evault2 + reset + seed，这个套件**要** `LK_SEED_ORDER=1`）、`codex-swap-motion` 14/14、
  `motion-switch` 25/25、`entity-evolution` 46/46（lk-evo + reset + seed + 重启）；
  `tsc --noEmit` / `node --check` / `vite build` 全 exit 0。

### 十八、滚字那两个字"偏下"了 + 收起文件夹时"下面的行先动"

用户 2026-09-14 一条消息两条：「**实体和节点两个字的位置偏下了**」+「**应该是文件先消失，下面的文件夹再移上来，
现在反了，下面的移上来后文件再消失**」。

**① 偏下 1.81px（`src/ui/codex.ts` 的 `NEWBTN` + `src/style.css` 的 `.lk-roll`）**

`#cx-new` 里那个老虎机裁切盒（`.lk-roll`）是 `overflow:hidden` 的**行内块**，靠 `vertical-align: middle` 摆位 ——
而 `middle` 的规则是"盒子中线对齐父元素基线 + x-height/2"，**不等于**"盒子里的字与旁边那行字同一条基线"。
用 `Range` 量**字体框**（同一字体才有可比性，元素盒还包含行高）实测：

| | 前缀「＋新建」字体框 | 盒里的字字体框 | 差 |
|---|---|---|---|
| 修前（`vertical-align:middle`） | top 22.67 / bottom 34.67 | top **24.48** / bottom **36.48** | **+1.81px**（偏下） |
| 修后（按钮 `inline-flex;align-items:center`） | top 22.67 / bottom 34.67 | top 22.67 / bottom 34.67 | **0** |

修法 = 按钮本身改 `display:inline-flex;align-items:center;justify-content:center`（flex 居中不求基线），
`.lk-roll` 那句 `vertical-align: middle` 留作"万一按钮不是 flex"的兜底（注释写明）。

**② 顺序反了（`src/ui/codex.ts` 的 `collapse()/leave()` + `src/ui/motion.ts` 的 `flipRows`）**

收起一枝叶要做两件事：里面那些行**退场**（幽灵层）、下面的行**往上补位**（FLIP）。原来两者**同时**发生，
用户看到的是"下面的先窜上来、文件再消失"。修法：`collapse()` 里把这一枝的退场总时长
（`rowsLeaveTotal(n, EXIT)` = 单行 260ms + 最后一行的错峰延迟，封顶 240ms）写进模块级 `flipDelayMs`，
`renderList()` 把它交给 `flipRows(..., { delay })`。**`flipRows` 给了 `delay` 就必须 `fill:'both'`** ——
延迟期间要**冻在旧位置**上；`fill:'none'` 的话那一行会先瞬移到新位置、等延迟过完再跳回旧位置演一遍。

实测（收起「主线」那一枝，它下面还挂着 `_設定` 一整枝）：

| 量 | 值 |
|---|---|
| 幽灵退场 | 3 行，delay `0/22/44`，dur 260，`none/1 → translateY(-8px)/0` |
| 退场总时长 | `44 + 260` = **304ms** |
| 下面 45 行的 FLIP | delay **304**、dur 320、`fill:"both"`、`from: translateY(64.1875px)` |
| 2.6s 后 | 幽灵 0 个、残留动画 0 个 |

（收起「事件」那种单行枝时退场总时长 = 260，下面那些行就 delay 260。）

**测试与 A/B**：`codex-list-motion.cjs` 19 → **20 项**（新增 **★4f**「下面的行补位要等这一枝退场走完：
FLIP delay = 退场总时长（两条都由量出来的数比，不写死）、`fill:'both'`」）；`codex-smooth-switch.cjs` 27 → **28 项**
（新增 **★13e**「盒里的字与「＋新建」字体框 top/bottom 逐项相同」）。
**A/B（把 `NEWBTN` 的 flex 去掉 + 把 `flipRows` 的 delay 写死 0，`vite build` 后跑）**：
`codex-list-motion` **19/20**（★4f 挂）、`codex-smooth-switch` **27/28**（★13e 挂）⇒ 两条断言都有判别力；恢复后 20/20、28/28。

**⚠️ 一个与本次改动无关的既有假挂（已 A/B 排除）**：`codex-tree-view.cjs` 现在 **20/22**，
挂的是 ★7/★8（「空类型也在、置灰」）—— 因为该 fixture 的世界里 `entityTypes` 只剩「角色」
（vault 里只有 `_设定/角色`，扫描结果会把类型收窄成"真有的那几个"）。
`git stash` 退回改动前的三个源文件 + `vite build` 后**同样 20/22、同样两条** ⇒ 不是本次引入的。
修法方向（未做）：让 `reset-entity-vault.cjs` 既铺 `entityTypes` 又在硬盘上建五个类型空文件夹 ——
本轮试过一次，反而把 `codex-node-tab` 的树层级断言带崩（15/22），遂回退，先如实记档。

### 十九、左树外框不平滑、收起的行"跑出框外"、帧条展开是硬切（用户 2026-09-14 三条 + 一条追加）

用户原话：「**文件树最外面的框也要做平滑切换，而且关文件夹时部分文件会超出这个框，git管理面板里面的展开也做成平滑切换**」→ 随后：「**文件收起的动画快一点，现在有一点停滞感**」。

**实测根因**（探针 `%TEMP%\lk-p3.cjs` / `lk-p4.cjs` / `lk-p5.cjs`）：

| 量 | 值 |
|---|---|
| `#cx-list`（左树那个框）展开态高 | **327px** |
| 收起世界后**同一 tick** | **23px**（无动画，硬切） |
| 幽灵原来的落点 | 直接挂 `document.body` + `position:fixed` + `z-index:860/900` ⇒ 既不受外框裁切、也不跟着框缩 |

⇒ 两件事一个病根：框自己的高度没人管（内容撑的），幽灵又住在框外面，所以"关文件夹时部分文件**超出这个框**"。

**修法（`src/ui/motion.ts` 三个新原语 + 两处调用）**
- `ghostLayerFor(clip, z = 860)`：造一层**贴着 `clip` 位置**的 `position:fixed; overflow:hidden` 裁切层挂到 body（`motionReduced()` 返回 null）；`cloneIntoLayer(layer, rect, el, cls?)`：把行克隆进层、坐标换算成层内坐标、`position:absolute`、摘掉所有 `[id]`（**不许写 `padding:0`** —— 缩进就是各层的 `padding-left`，清零会让幽灵往左跳）；`smoothBoxHeight(el, from, {dur = 240})`：把框钉在旧高度演到新高度，动画期间临时 `overflow:hidden`，演完还回去。
- `src/ui/codex.ts`：`ghostRows()`/`pinRowGhost()` 都改成造层 + 克隆（`ghostLayerFor(#cx-list, 860/900)` + `cloneIntoLayer(..., 'lk-list-ghost')`）；`renderList()` 开头量 `boxBefore`，`done()` 里量 `boxAfter`（**必须在 `smoothBoxHeight` 之前量**，否则拿到的是动画起点）→ `smoothBoxHeight` + `syncGhostLayers(boxAfter)`（活着的层高度设成目标高度，配 CSS 过渡一起缩）。
- `src/style.css`：`.lk-ghost-layer { overflow:hidden; pointer-events:none; transition: height 240ms cubic-bezier(0.16,1,0.3,1) }`。
- `src/ui/evolution-rail.ts`：帧条的 `[data-rail-toggle]` 不再硬切 —— 展开时新露出的虚化行走 `rowsDropIn`，收起时先把它们克隆进贴着 `.lk-rail__rows` 的裁切层走 `rowsLeaveAndRemove`，**并把层高设成收起后盒子的高度**（否则退场中的行会露出帧条框外，与左树同病）。

**提速（用户追加要求）**：`EXIT` 从 `{ dy: 8, dur: 260, step: 22 }` → **`{ dy: 8, dur: 180, step: 14, maxDelay: 120 }`**（两处：`src/ui/codex.ts`、`src/ui/evolution-rail.ts`）；新增 **`FLIP_OVERLAP = 0.55`**：`flipDelayMs = Math.round(rowsLeaveTotal(n, EXIT) * FLIP_OVERLAP)` —— 不再等整枝走完才补位（"停一拍再上移"的停滞感来源），顺序仍是"文件先动、下面的行后动"。

**两个自己踩出来的 bug（都在收尾时被抓出来）**
1. **`pinRowGhost()` 忘了给克隆体挂 `lk-list-ghost` 类** ⇒ 删除时那一行的幽灵在层里"存在但认不出"：测试数到 `ghosts: 0`、`rowLeaveAndRemove` 也认不出它而**留下一个空的 900 层**压在页面上。
2. **`rowLeaveAndRemove`（单数）没做"层空了就摘层"**（上一轮只给了 `rowsLeaveAndRemove` 复数版）⇒ 同上，层的清理只能靠兜底超时。

**测试**：`codex-list-motion.cjs` 20 → **24 项**（★4g 框高度是演的、★4h 幽灵住在裁切层里且全在层内、★4i 层的目标高度 = 框动画终点、★4j 演完层摘掉且 `overflow` 还回去）；`entity-evolution.cjs` 46 → **49 项**（★0f3 展开逐行下弹、★0f4 收起时裁切层里的幽灵退场 + 层高跟到盒子、★0f5 层演完摘掉）。老断言按新参数更新：★4e 错峰 `14`/封顶 `120`、★4c2 `dur 180`、★5/★5b/★5d 改成**层里找幽灵**（900 现在是层、幽灵本体不再有 z-index）。

**⚠️ 两条教训（比改动本身重要）**
1. **改 fixture 脚本 = 改数据，回退脚本不够**。本轮试过一次"让 `reset-entity-vault.cjs` 既铺 `entityTypes` 又在硬盘上建五个类型空文件夹"，试完把脚本 `git checkout` 回退了，**但那次运行已经把 `fields` 写成对象**（`{描述:'text'}`）存进 `%TEMP%\lk-evault2\worldbuilding.json`。于是 `src/store/actions.ts` 的 `addEntity` 里
   `for (const f of ws.entityTypes?.[typeId]?.fields ?? [])` 抛 **`TypeError: object is not iterable (cannot read property Symbol(Symbol.iterator))`**：点「＋新建」静默失败、`codex-list-motion` 崩到 **7/24**。
   恢复法 = **删掉整个测试目录重建**：① `seed-node.cjs` ② 起一次应用让扫描写出 `worldbuilding.json`（`fields` 是**数组**）③ 关应用 ④ `reset-entity-vault.cjs` + `seed-node.cjs` ⑤ 再起实例跑套件。之后 `codex-node-tab`/`codex-tree-view` 从 17/18、21/22 回到 **18/18、22/22**。
2. **新写的断言违反了本项目自己的铁律 14**（"点一下展开之前先读状态"）：★0f 已经把帧条展开了，我又写的 ★0f3 里**盲点**一次 toggle 变成"收起" ⇒ ★0f3/★0f4/★0g/★0h 立刻挂，**并且把后面 16 条版本类断言一起带崩（30/49）**；因为 `git stash` 退回源文件后**同样 30/49、同样 19 条**，我一度以为是自己这几条改动引起的回归（A/B 的价值也在这：它证明"不是源文件的问题"）。修法 = ★0f3 自己先读 `is-ghost` 再决定点不点（并把"收起后行数"当断言）。
   ⚠️ 另一个测试写法：隐藏窗口里动画不推进（铁律 6）⇒ ★0f4 不能比**渲染高度**（过渡刚开始量到的还是旧值），要比**目标值** `lay.style.height === box.height + 'px'`。

## 第二十一轮（2026-09-13）· 演变：实体的版本历史（新功能 + 两条自查出来的 bug）

> **目的**（用户 2026-09-12 提、09-13 细化）：给每个世界一套 git ——
> 「时间线本身就可以充当 git，事件节点就是不同的版本」「每个实例版本随事件节点变化」
> 「每个 git 保存与上一节点的区别」「我想在设定库右侧加一条竖着的等距的时间线，
> 用来储存不同节点，当选中实例时，默认进入离当前指针最近的 git」「都做吧，把模式放到设置里面」。
> 方案与存储格式单列一份 `docs/ENTITY-EVOLUTION.md`（含取舍与实测数字），这里只记**实现里踩到的坑**。

### 一、新功能（都已落地）
- **数据**：`Entity.frames: EntityFrame[]`（锚在事件节点上的提交，**只存与上一帧的区别**；
  字段 `set`/`del`，正文按行 `hunks`）。旧设计 `EntityLayer`（按 epoch 开时间窗、全量覆盖）**删除**
  —— 它从未被实现过，留着就是第二套语义。
- **纯逻辑** `src/store/evolution.ts`：`docDiff`/`applyDoc`、`frameDiff`/`applyPatch`、
  **`statesOf` 一次算全部前缀**（换版本 O(1)）、`epochOfNodes`、`normalizeFrames`、
  `nearestVersion`/`versionAtNode`、`patchSummary`。
- **存储**：`main.js` 的 `entityToMd` 在正文后追加 `#演变：` 段（```json 围栏）；`mdToEntity`
  先切掉这一段再做正文解析。**解析失败一律原样保留**（`_framesBroken` + `_framesRaw`）——
  宁可界面暂时没历史，也不能把历史写没。
- **界面**：`src/ui/evolution-rail.ts`（右侧等距竖线：一格一个事件节点，顶上第一格初稿，
  有帧的格点亮并显示差异摘要）＋ `src/ui/codex.ts` 的 `viewState()`（看哪一版）/ `editVersion()`
  （改哪一版）/ `commitState()`（写回那一版）。
- **三种模式**（设置 → 设定演变，存 localStorage）：手动（默认，只有点「＋ 在这一格记一帧」才留版本）/
  自动（改动自动在选中格开一帧）/ 锁定（改动永远落到锁定的那一帧，视图也钉在它上面）。

### 二、★ 星标：用户明确提了两次的"注意优化"——实测数字（200 帧 + 120 行正文）
| 动作 | 耗时 |
| --- | --- |
| 打开设定库 → 帧条出现（201 格） | 107 ms |
| 换一版（缓存热，含 tiptap 换文档） | 平均 47 ms（27–55） |
| 换一版（缓存刚作废 → 要重放 200 帧） | 平均 31 ms（27–39） |
| 改一个字段（算差异 → 写 store） | 28 ms |
| 改一段正文（算行级差异 → 写 store） | 12 ms |

**结论**：瓶颈**不在物化**（重放 200 帧与缓存热同量级 ⇒ O(n²) 那条路真的被避开了），
而在显示某一版正文时 tiptap 换文档。要再快该动"换文档只 diff 不重建"，不是缓存策略。

### 三、自查出来的 bug（都不是用户报的，是回归套件与我自己的断言抓到的）
1. **「正在看：初稿 / 第 N 版」那行在换条目后不刷新**（`codex.ts`）：它属于骨架 HTML，
   只在 `render()` 里生成，而换条目走的是 `swapBody()`（只换名字/类型/字段/正文）⇒
   切到另一条实体会显示**上一条**的版本。修法：抽 `versionNoteText()`，骨架给它 `id="cx-vnote"`，
   `swapBody()` 里也刷新一次。（被新套件的 ★9 抓到。）
2. **右栏让选中格滚进视野时把整个面板也滚了**（`evolution-rail.ts`）：原来用 `onEl.scrollIntoView()`，
   它会把**所有**祖先滚动容器一起滚，而 `#cx-root` 正是面板的滚动容器 ⇒ 用户滚到正文中间，
   切个实体就被拽走（实测 `#cx-root.scrollTop` 260 → **122**）。修法：只滚帧条自己的
   `.lk-rail__rows`（按 `offsetTop`/`clientHeight` 手动算），并给 `.lk-rail__rows` 加 `position: relative`
   让 `offsetTop` 有正确参照。（被既有套件 `codex-smooth-switch.cjs` 的 ★6 抓到 —— 这条正是不变量的价值。）
3. **等距格子差点被内容撑破**：`.lk-rail__row` 用 `flex: 0 0 46px` 时，flex 项的 `min-height:auto`
   会让内容（时间/标题/摘要三行）把格子顶高 ⇒ 实测 50px。修法：`height/min-height/max-height` 三处钉死
   + `box-sizing: border-box` + `overflow: hidden`（等距是这条竖线的全部意义，必须由代码保证）。
4. **静默提交的嵌套**：原来 `quiet = true; try{…} finally{ quiet = false }`，而
   「写正文 → 提交某一版」是嵌套调用 ⇒ 里层提前解除静默、整块面板白重建一次。
   修法：`withQuiet(fn)` 保存并恢复旧值。

### 验证
- `tools/e2e/seed-evolution.cjs` + `entity-evolution.cjs` **27/27**（当天上午扩到 **32 项**，见第五节）：
  等距格子 / 没版本时默认初稿 / **手动模式改的是初稿且不产生历史** / ＋记一帧 → 段落出现 /
  改字段进那一帧的 patch 而初稿不动 / 切版本看到不同内容 / 正文按行 hunks 且初稿正文不变 /
  另一条实体不串台 / **默认落在离指针最近的那一帧** / 自动模式自动开帧且是增量 /
  锁定模式视图与落点一致 / 删帧先确认且只删那一帧 / 无未捕获异常。
- `tools/e2e/cold-start-evolution.cjs` **8/8**（当天上午终态变化后仍是 **9/9**）：重启后帧还在、
  物化正确（初稿 / 末版两套值）、正文按版本取、默认落点仍是最近的那一帧。
- 回归全绿：`codex-node-tab` 15/15、`editor-props-panel` 9/9、`codex-switch-target` 7/7、
  `codex-smooth-switch` 16/16、`toolbar-groups` 4/4、`motion-switch` 25/25；
  `node --check main.js` / `tsc --noEmit` / `vite build` 全 exit 0。
- 静态往返（不起 Electron）：把 `main.js` 里实体序列化那几支函数抽出来单测 ——
  无帧时不写演变段、有帧逐字节往返、再写一遍字节相同（幂等）、坏 JSON 原样保留、
  手写 .md 照旧解析，**18/18**。

### 已知限制（新增，未修）
- 帧锚在**当前世界**的节点上；跨世界不认。
- 重命名/换类型时，`.md` 的文件名与目录始终按**初稿**（某一帧上改名只影响那一版的显示名）。
- 帧条每格等高、不按时间比例（用户明确要"等距"）；时间跨度极大时它不会变形。
- 「自动」模式记到的是**「记到」下拉里那个事件**（不是"你现在看的这一版"）—— 见下面第五节，
  这是 2026-09-13 上午改成"帧条只列有版本的节点"之后的必然结果（视图可能停在初稿，而改动记在锚点上）。

### 五、用户上手第一天的两条反馈（2026-09-13 上午）

> 用户原话：「**我希望没有版本的节点就不显示**」+「**默认创建了一个滚动条，去掉吧**」。

**5.1 帧条只列「有版本的」节点（改语义）**
- 原设计把世界里**每一个**事件节点都画成一格（用户 7 个节点里 6 个没有版本）—— 看着像待办清单，
  不像 git log。改成只列 `hasFrame` 的节点（`src/ui/evolution-rail.ts` 的 `rows()` = `allRows().filter(...)`）。
- **代价**：帧条上再也点不到"空格子"⇒ 建版本少了一个入口。补法：底部加一行
  「记到 [事件 ▾]」下拉（`#cx-anchor`，选项 = 世界里全部事件节点，默认 = 离沙盘指针最近的那个），
  ＋按钮改成「＋ 记一帧」并**常驻**（原来正站在某版本上时会被"删掉这一帧"顶掉，现在两个都在）。
- **顺带消失的一条语义**：旧版「站在没有版本的格子上 ⇒ 改动落到它上一版」这套 floor 逻辑，
  界面上再也没有入口（那格子不显示了）；三种模式因此变得更好解释：
  手动 = 改的就是你现在看的那一版（初稿或某帧）；自动 = 改的记到「记到」那个事件上（没有版本就先建一版）；
  锁定 = 永远记到锁定帧。
- 连带改的三处（都是"不修就会自相矛盾"）：`editVersion()` 自动模式改用 `railAnchor`；
  `patchVersion()`/`writeDoc()` 改成**先定"改哪一版"再取那一版的样子**（自动模式会新建一版并挪视图，
  先取 `viewState()` 会把旧版内容覆盖进新版）；删掉当前这一版后视图退到它的前一版（否则那一行
  连行一起消失，看着像"点了没反应还丢了东西"）。

**5.2 面板"凭空多了一条滚动条"**
- 实测（1440×900、真实数据 11 字段 + 一篇正文）：`#cx-root` 内容 **864px** vs 可用 **861px** —— 差 3px，
  于是**什么都没超出**却挂着一条滚动条。A/B 过：与帧条无关（把 `#cx-rail` 设成 `display:none`、
  中栏从 521px 撑到 709px 之后，**仍然超 3px**）。
- 处方三处让位（都不是"把 3px 藏起来"，而是**不为空东西留位置**）：
  ① 根内边距 18px → 14/12px、块间距 10px → 8px；
  ② `#cx-msg`（底部那句状态提示）没消息时 `display:none` —— 原来给一句空话留了约 27px；
  ③ 帧条只列有版本的节点（8 格 → 2 格）。
- **副作用（真实联动的坑）**：`#cx-msg` 正好是 `#cx-root` 的**最后一个**子项，而 `cascadeIn()` 靠
  "最后一块的 `animationend`"收手 ⇒ 它 `display:none` 之后那个事件永远不来，整组错峰只能等
  `maxDelay+2000ms` 兜底（`motion-switch` ★6 当场抓到：`{cls:true, anims:3}`）。
  修法：`cascadeIn()` 一并跳过**没有盒子的子项**（`getClientRects().length === 0`），
  与它本来跳过 `.lk-own-cascade` 是同一条理由（后者也没有动画）。

### 验证（五 · 2026-09-13 上午）
- `entity-evolution.cjs` **27 → 32 项全过**：新增 ★0b（下拉里事件都在 + 默认离指针最近）、
  ★0d（**面板外壳开销 ≤130px**：标题行+页签行+内边距+间距+消息行 = 面板总高 − 三栏那一行。
  ⚠️ 不能断言"1440×900 下没有滚动条"—— 那取决于正文多长，正文长了本来就该滚）、
  ★10e（自动建的那一版也上帧条且视图跟过去）、★14c（删掉当前这一版后退回前一版）、★2b。
- `cold-start-evolution.cjs` **9/9**（接了新的终态：跑完只剩 1 帧）。
- `motion-switch.cjs` **25/25**（★15 顺带修了断言：只挑**真的播了动画**的块，"隐藏的块没有动画"不该算失败）。
- 回归：`codex-node-tab` 15/15、`editor-props-panel` 9/9、`codex-switch-target` 7/7、
  `codex-smooth-switch` 16/16、`toolbar-groups` 4/4、`assoc-canvas` 11/11（**要给它一个刚起的实例**）。
- `seed-evolution.cjs` 改成**自给自足**：自己写实体类型字段模板（`entityTypes`）+ 世界/时间线不存在
  就建出来。踩到的教训：继承来的测试目录里「角色」只有一个字段「发色」⇒ `setField('年龄'/'能力'/'瞳色')`
  静默无效，★5/★5b/★6/★10c/★10d/★10e/★11 **七条一起报假 FAIL**，看着像产品坏了。

### 六、帧条要能"展开没版本的事件"（用户第三条反馈，**已做**）

用户原话：「**我希望在右侧时间线加一个展开的功能，能展开未创建 git 的节点，但虚化显示**」，
随后自己澄清语义：「**我那个展开时间线其实就是【记到】后面的下拉选框，不过和时间线一起显示，更直观一点**」。

- 上一版按用户 5.1 的要求把帧条收成"只列有版本的节点"，代价是**"记到哪个事件"只能看底部那个下拉**，
  跟时间线是割裂的两处。现在把两者合成一处：帧条底部一行 `▾ 展开全部事件（还有 N 个没版本）`，
  展开后**没版本的事件按时间插进时间线**（不是挤在末尾），整格 `opacity:.4` + 空心虚线点 = 虚化；
  当前「记到」的那一格带 accent 左边框 + 小药丸「记到」。
- **点虚化行 = 换「记到」**（`deps.onAnchor`），**不动正在看的版本** —— 这正是用户要的"下拉搬到时间线上"。
  点有版本的行才换版本（`deps.onSelect`），锁定模式整行忽略（与旧行为一致）。
- 实现：`src/ui/evolution-rail.ts` 的 `rows()` 仍只列有版本的（`allRows()` 给下拉与虚化行用）、
  `rowHtml(r)` 加 `is-ghost`/`is-anchor`/`data-ghost`，新增 `moreHtml(n)`（class `.lk-rail__more`，
  **刻意不用 `.lk-rail__row`** —— 那一类高 46px 是"等距"的承诺，展开行不该占一格）；
  `src/style.css` 加 `.lk-rail__row.is-ghost` / `.is-anchor` / `.lk-rail__tag` / `.lk-rail__more`。
  `src/ui/codex.ts` 一行没动（`onAnchor` 早就接好了）。

### 七、⚠️ **未坐实、未修**：套件偶发 `34/38`（★5/★5b/★10d/★14b 一起挂）

> 记在这里是因为它**看起来像数据损失**（改动自己变回去），将来一定会再遇到；但机制只做到"最可能"，
> 没有拿到可复现的现场，所以**没有动那段代码**（先量后改：测不出差别的改动不进主干）。

- **现象**：`entity-evolution.cjs` 约 **2/10 次**（我的构建；同一目录 HEAD 那次 32/38 里 ★5 是过的，
  但只有 1 个样本，不足以下结论）。逐 150ms 采样拿到的现场是：
  `t+0/150/300ms 中栏=19、md={}` → **`t+450ms 中栏=17`** → 之后一直是 17，`.md` 从头到尾没拿到 19。
  ⇒ 不是"没写下去"，是**内存里的改动被盖掉了**，然后那次写盘照旧写了被打回去的内容。
- **最可能的机制**（读代码 + 上面那条采样唯一自洽的解释）：`src/main.ts` 的自动落盘
  `writeAll()` 在**开头**就把 `pendingWrite = false`（`src/main.ts:396`），而 `vault` 监听回调判断
  "这份扫描快照能不能覆盖内存"**只看 `pendingWrite`**（`src/main.ts:479` / `:495`）。于是：
  写盘正在飞（节点先写、实体后写）时到达的 watcher 事件 → `scan enter pending=false` → 不 flush、
  直接 `vaultScan()` → 这次扫描读到的实体 `.md` 还是**改动前**的样子 → 扫完 `pendingWrite` 仍是
  false → `APPLY` 用旧快照整片替换 `worldsets` ⇒ 实体按文件重建（`mergeEntities` 里**文件里的
  `frames` 覆盖内存里的**）⇒ 帧的 patch 变回 `{}`，同一轮 writeAll 才轮到写实体、读到的已是旧内容。
  这与第十五轮那条"结构体管理删字段被复活"是**同一类**（旧快照回扫盖掉新改动）。
- **没坐实的原因**（如实记）：按上面的机制写了确定性复现套件 `tools/e2e/vault-rescan-race.cjs`
  （改字段 → 死等节点 `.md` 的 mtime 变化 = 写盘刚起步 → 立刻改**另一个**实体的 `.md`，逼 watcher
  事件落在写盘飞行中；为了拉长窗口还先塞 30 个实体），**在修复前的代码上它仍然 3/3 通过** ⇒
  这条路径要么不是主犯、要么还有别的条件（例如两次扫描竞争、或 `nodeFieldDiff`/自动修复那条支路）。
  也用"把写盘人为拖慢 150ms"试过，一样复现不出来。
- **顺带排除的**：不是本轮"虚化行"引起的 —— 把「展开 → 点虚化行 → 收起」原样搬进独立探针
  （`lk-evo-probe.mjs` / `lk-evo-probe2.mjs`，每次全新 userdata + 全新 vault）**3/3 通过**；
  也不是"400ms 防抖压在边界上"（把 settle 去掉同样通过）。
- **本轮做的两件小事**：① `entity-evolution.cjs` 开头**显式复位设置**（`evolveMode='manual'`、
  `evolveLock=null`，在打开工具之前写 localStorage）—— 套件 ★12 会把模式改成"锁定"且从不复位，
  同一个 userdata 跑第二遍开局就不是手动模式了（SKILL `seed-must-be-self-contained`）；
  ② 套件头部写明这条**已知偶发**，免得下次看到红灯误判成回归。
- **将来要修的话**（未实施）：给回扫加"写盘代际"判断 —— `writeAll()` 自增一个 `writeGen` 并维护
  "在飞计数"，回扫在 `vaultScan()` **之前**记下这两个值，扫完要求 `pendingWrite === false &&
  writeGen 未变 && 在飞计数为 0` 才允许 APPLY；命中就跳过本轮（必要时延迟重试一次，保证外部改动
  不会被永久漏掉）。这样只会**更保守**，不会让回扫更贪。

### 八、世界沙盒：切到「世界历史」被**当场**打回剧情线（用户第一条反馈，**已修**）

用户原话：「**世界沙盒中从剧情线切换到世界历史再移动指针时会导致跳回剧情线**」。

- **根因**（`src/ui/timeline.ts` 的 `renderStoryUI()`）：剧情线选择框里"世界历史"那一项的值是 `null`，
  而旧代码 `const active = activeLineId && lines.some(l => l.id === activeLineId) ? activeLineId : lines[0]?.id ?? null;`
  把**用户显式选的 `null`（世界历史）当成"还没选"**，于是下一次重画就把它打回第一条剧情线；
  而选择框的 change 处理器紧接着就调 `renderStoryUI()`（`src/ui/timeline.ts:575-581`）⇒
  **不用移动指针，选完当场就被改回去**（用户以为要移动指针才复现，其实是同一件事）。
- **修法**：加 `let linePinned = false;`，只有"用户还没选过"或"聚焦的那条线被删了"才自动落位到第一条：
  `const ids = new Set(lines.map(l => l.id)); if (!linePinned || (activeLineId !== null && !ids.has(activeLineId))) activeLineId = lines[0]?.id ?? null; linePinned = true;`
  （change 处理器里置 `linePinned = true`）。
- **A/B**（`tools/e2e/storyline-world-history.cjs`，8 项）：修复后 8/8；把 `src/ui/timeline.ts` 退回 HEAD
  重新 build 后 **★1/★2/★3/★5 四条 FAIL**（4/8）⇒ 断言确实盯住了这个 bug。★1 选完保持"世界历史"、
  ★2 移动指针后仍是"世界历史"、★3 世界历史下没有聚焦遮罩（`#lk-story-mask` 子元素 0 个）、
  ★4 切回剧情线照样生效。

### 验证（六/七/八）

- `entity-evolution.cjs` **32 → 38 项**：新增 ★0e（默认收起 + 底部提示"还有 N 个没版本"）、
  ★0f（展开后 3 个虚化行**按时间** 315/327/350 插入，且都不是"有版本"）、★0f2（
  `getComputedStyle().opacity` 实测 0.4 = 真半透明）、★0g（点虚化行 → 「记到」下拉跟着变 + 该行
  标上「记到」；测完把锚点复位，不污染后面的断言）、★0g2（点虚化行**不动正在看的版本**）、
  ★0h（再点一次收起，虚化行消失、锚点照旧）。干净目录跑 **38/38**。
- `tools/e2e/vault-rescan-race.cjs`（新增，6 项）：写盘在飞时改别的实体 `.md` →
  「刚改的字段不许自己变回去」+「外部改动仍然要能回扫进界面」（后者是防"靠永不回扫换绿"的守卫）。
- 剧情线那条（八）：`storyline-world-history.cjs` 8/8，A/B 4/8（★1/★2/★3/★5 挂）。
- 视觉取证：1440×900 下截图确认帧条 = 起点/初稿（实心、选中）→ 三个虚化事件行（含带「记到」
  小药丸的那一格）→ `▴ 只看有版本的（0）`；中栏/正文/左列都不受影响。
- `tsc --noEmit` exit 0、`node --check main.js` exit 0、`vite build` exit 0。

### 九、编辑器的树只显示"已有节点"的种类，空结构体与 `_设定`（实体）根本不在树里（用户第四条反馈，**已修**）

用户原话（先问「编辑器文件树我希望能自适应文件夹结构，并显示其他结构体」，追问后澄清）：
「**就是编辑器的树现在只能显示事件节点，其他结构体的文件夹没有在树里面**」。

- **旧行为（机制）**：`src/ui/editor.ts` 的 `renderSidebar()` 时间线页签里，种类文件夹是**从这条时间线
  已有的节点反推**出来的（遍历 `tl.nodes` 收 kind）⇒
  ① 一个节点都没有的结构体（战斗 / 组织 / 魔法体系…）在树里**根本不存在**，
  于是"新建第一个节点"没有入口可按；
  ② `_设定`（实体，硬盘上是 `<世界>/_设定/<类型>/<名字>.md`）**完全不在「时间线」页签的树里** ——
  只能切到「实体」页签才看得见，树跟硬盘的文件夹对不上。
- **修法**（都在 `src/ui/editor.ts`）：
  ① 种类文件夹改成 **`store.data.formats` 的全部种类 ∪ 这条时间线实际用到的种类**
  （`const kindKeys = [...Object.keys(fmts), ...[...used.keys()].filter((k) => !fmts[k])];`），
  空的那一类加 `is-empty`（label 与计数 `opacity:.45`），展开时给一句人话「这个结构体还没有节点」
  （新增 `emptyRow(text)` 生成 `.ed-tempty`）；
  ⚠️ **这一半（从 formats 列"没节点的种类"）第二天就被用户报为 bug，已在第十节推翻**：
  内建默认种类名与实体类型重名 ⇒ 树里凭空多出一堆空文件夹。现在只列**真的有节点**的种类。
  ② 每个世界的时间线之后新增 **`_设定` 分支**（`data-kind="set"`，label `_设定`，计数 = 实体数），
  展开后列出 `w.entityTypes` 的**全部类型**（空的 `is-empty` + 「这个类型还没有实体」），
  类型下是实体行（`data-kind="entity"`、`data-world`、`data-path=<实体 id>`）；
  ③ 新增 `selectEntity(id, world?)`，**世界不同时先 `store.setActiveWorld(w)`**（树列的是全部世界的实体，
  旧写法在非活动世界上会静默无反应），再设 `currentEntityId`/`target`/`lastTarget.entity`/`setDoc`/
  `propsPanel.render(e, true)`/标题/状态/`renderSidebar()`；「实体」页签的树也改走这同一份。
  ④ ⚠️ **在时间线页签的树里点实体行必须"先 `setTab('entity')` 再选中"**：两个页签各记着自己打开的那份
  文档（`lastTarget`），就地换会把**节点正文写进实体文件**。
- **A/B**（新套件 `tools/e2e/editor-tree.cjs`，28 项）：修复后 **28/28**；把 `src/ui/editor.ts` +
  `src/style.css` 退回 HEAD 重新 build 后 **7/28**（★5~★26 一起挂：树里只有「事件」、没有「战斗」、
  没有 `_设定`、点实体行页面停在"选择左侧节点/实体开始编辑"）⇒ 断言确实盯住了这件事。
- ⚠️ 套件自己的一个坑（已修）：`listRows()` 一开始没把 `empty`（`is-empty`）读回来，
  ★6 明明行为正确却报 FAIL —— 断言里用到的字段必须真的在返回对象里。
- **当天用户的第二、三条反馈（同一次改动的后续，已修）**：
  ① 「**点到设定里面的实体文件时测试世界观文件夹会消失，事件文件夹也没了**」——
  第一版在时间线页签点实体行时调了 `setTab('entity')`，于是左栏整棵树被换成「实体」页签那套
  「类型 → 实体」列表：世界层级、时间线、事件/战斗文件夹全部不见。**改成就地换右栏文档、不切页签**
  （换 `target` 前先 `flushDoc()`，`lastTarget.tl` 不动；`selectEntity` 写好 `lastTarget.entity`，
  之后手动切「实体」页签打开的正是它）。
  ② 「**设定文件夹和世界观文件夹处于同一缩进**」——`_设定` 是**世界下面的一层**（与时间线同级），
  但 `.ed-tset` 没有自己的 `padding-left`（只有 `.ed-tnode` 的 8px），而时间线是 18px。
  已补 `padding-left: 18px`；实测阶梯：世界 74px（pad 8）→ 时间线/`_设定` **84px（pad 18）** →
  种类/类型 93px（pad 27）→ 节点/实体行 92px（pad 36）。
- **A/B（针对这两条新反馈）**：把 `src/ui/editor.ts` + `src/style.css` 退回 `4532cc8` 重新 build，
  复跑更新后的套件（34 项）⇒ **27/34**，挂的正是 ★11b（`set:"8px"` vs `tl:"18px"`）、
  ★22（`bgEntity` 有高亮 = 切了页签）、★23/★23b/★23c（世界行/时间线行/种类行全为空数组）、
  ★23d（`_设定` 展开态没了）、★23e（高亮那一行其实在「实体」页签那棵树里）。修复后 **34/34**。

### 十、同名文件夹挂在两处：「角色/地点/物品/组织」同时出现在「主线」和「_设定」下面（用户第四条的后续反馈，**已修**）

用户原话：「**主线文件夹里面为什么也有角色文件夹等**」→ 追问后确认：「**我指的是角色，地点，物品等
文件夹同时存在于主线与设定文件夹下，是bug**」→ 最后授权我自行决定：「**要不优化一下文件夹结构**」。

- **根源不是树，是"默认值名字撞车"**：`main.js` 的 `DEFAULT_FORMATS`（**节点种类**的内建默认）原来是
  `角色/地点/物品/组织/事件`，前四个与 `src/store/entities.ts` 的 `BUILTIN_ENTITY_TYPES`
  （`角色/地点/物品/组织/种族`，**实体类型**）**一字不差**。用户机器上
  `%APPDATA%\lingkuang\formats.json` **不存在**（只吃内建默认）⇒ 「主线」下凭空多出四个空文件夹，
  名字跟「_设定」下的实体类型完全一样。第九节第一版"把 formats 里没节点的种类也列出来"把这个
  撞名**放大成了可见的 bug**（在那之前树只列有节点的种类，恰好遮住了它）。
- **两条修法**：
  ① `src/ui/editor.ts`：`kindKeys` 改成 **只取 `[...used.keys()]`（真有节点的种类）**，
   = 硬盘上真有的文件夹；删掉空种类那一支（`is-empty` 与「这个结构体还没有节点」那句；
  `emptyRow()` 仍被 `_设定` 的类型用着）。注释里写明"不要再从 formats 列没节点的种类"。
  ② `main.js`：`DEFAULT_FORMATS` 只留 **`事件`（起因/影响）+ `战斗`（交战方/结果）**，
   注释写明"节点种类 ≠ 实体类型，名字不许撞车"。
  **不动磁盘布局**（`<世界>/<时间线>/<种类>/<节点>.md` 与 `<世界>/_设定/<类型>/<实体>.md` 原样），
  也不动 `_设定` 侧"列出全部实体类型（含空的、置灰）"的行为 —— 那是用户第四条明确要的
  「显示其他结构体」。
- **真实数据副本复现（关键证据）**：把 `%APPDATA%\lingkuang\worldbuilding.json` + `F:\lingkuang-vault`
  拷到 `%TEMP%\lk-dupe`（**没有 formats.json** ⇒ 吃内建默认）跑起来，改后全树标签实测为
  `["测试世界观","主线","事件","_设定","角色","地点","物品","组织","种族"]` ——
  「主线」下**只有「事件」(7)」**，`_设定` 下 5 个类型（角色 0 / 地点 4 / 物品 3 / 组织 2 / 种族 1），
  **全树无重名**、无未捕获异常。
- **A/B（判别力）**：`tools/e2e/editor-tree.cjs` 33 项，修复后 **33/33**；把 `src/ui/editor.ts`
  退回 HEAD 重新 build 后 **28/33**，挂的正是新增/改写的 5 条 —— ★5（「战斗」不该出现）、
  ★5b（「角色」不该出现在主线下）、★5c（主线下只有「事件」）、★15b（全树里「角色」只许出现一次
  且在 `_设定` 下）、★23c，且 dump 里能直接看到 `[事件, 战斗, 角色]` 三个种类行
  = **用户报的现象本体**。

### 十一、设定库与编辑器合并成**一个工作台**（用户批准，**已做**）

用户原话：「**设定库和编辑器是不是可以做成同一工具的两种不同形式啊（在设置里面切换）**」
→ 我给了方案与代价（工具栏少一个图标、编辑器那棵树并进工作台、要重测左栏）→ 用户：「**那就开干吧**」。

- **为什么这件事便宜**：`src/ui/codex.ts` 的「时间线节点」页签**已经**是 世界→时间线→种类→节点
  四级树，用的就是 `src/style.css` 的 `.ed-*` 类（与 `src/ui/editor.ts` 那棵树同一套长相），
  两边还共用 `src/ui/props-panel.ts`（中栏字段）与 `src/ui/doc-editor.ts`（右栏正文）。
  缺的只是 `editor.ts` 独有的一条：**世界 → `_設定` → 类型 → 实体**分支。
- **做成了什么**：工作台左栏顶部一个「列表 / 文件夹树」开关（`listView`），
  `'tree'` 用新函数 `renderTreeList()` 把两类条目画进同一棵树（`data-act` = world/tl/tkind/wset/etype/node/entity），
  点任意一行 = 换中栏/右栏的目标；搜索在树形态下**节点与实体一起搜**。
  **两类"空"待遇不同**（别顺手统一）：节点**种类只列真有节点的**（= 硬盘上真有的目录，第十节那条），
  实体**类型列全部**（含一个实体都没有的，置灰 + 一句人话）—— 后者才是用户要的「显示其他结构体」。
- **默认形态在设置里**：`Settings.workbenchView: 'list' | 'tree'`（localStorage `lingkuang-settings`），
  设置面板新增「设定库（工作台）」卡片（两个 radio + `saveNow`）；`codex.ts` 监听 `lingkuang-settings`，
  改完**当场**换形态（开着的面板不用重开）。
- **编辑器独有、本轮搬走的**：① `H`（`toggleHeading(1)`）与「插图」（`importImage` → `insertImage`）
  两个正文按钮 → `doc-editor.ts` 新增 `toggleHeading` / `insertImage`，工作台正文标题行两个小按钮调它；
  ② **外部改动提示条**（Obsidian 删了 `「#描述：」`/`「#正文：」` 标签、或启动时格式被自动补回）
  → 新建 `src/ui/vault-notice.ts`（`createVaultNotices`，一次创建活到切走、宿主延后取、render 后 `refresh()`）。
  **这一条是数据安全设施，不能跟着编辑器一起没掉** —— 所以是"搬"不是"删"。
- **删掉的**：`src/ui/editor.ts`（`git rm`）、`src/tools/register.ts` 里的 `editor` 注册
  ⇒ 左栏创作组 6 → 5 个（`toolbar-groups.cjs` 的期望值跟着改）。
- **测试跟着搬**：原 `editor-tree.cjs`（33 项）与 `editor-props-panel.cjs`（9 项）随工具下线而退役，
  它们的独特断言进了新套件 —— `tools/e2e/workbench-tree-folders.cjs`（31 项：文件夹语义那一批）
  与 `codex-node-tab.cjs` 的 ★9b/★9c（提交后面板不重建 + 那次提交真落进了 `.md`）。
  新增 `tools/e2e/codex-tree-view.cjs`（29 项：形态开关 / 同框 / 点行换目标 / 记住默认形态）。
- **A/B（判别力）**：`git stash`（三个源文件）+ `vite build` + 重启实例 ⇒ `codex-tree-view.cjs`
  **3/29**（开关都不存在，dump 里 `toggle:[]`、`ph:"搜索实体…"`），修复后 **29/29**。
- 途中踩到的（都留了注释/README）：① `_設定`（繁体）与界面里的 `_设定`（简体）不是同一串 ——
  按标签点行会静默点不中，`workbench-tree-folders.cjs` 第一版 **19/31** 全由它引起；
  ② 新加的 `#cx-hint`（平时 `display:none`）**不占错峰序号**，而 `motion-switch.cjs` ★1/★13 是
  按下标硬读子项的 ⇒ 25/25 掉到 23/25（改成 `.filter((x) => x.length)` 后恢复，已写进 README 铁律 12）。

### 十二、左栏重做：撤掉两个页签，只留「筛什么」+「怎么摆」（用户 2026-09-13，**中间站 —— 已由第十三节取代**）

用户原话：「**时间线节点和实体这两个按钮，列表和文件夹树的功能有点混乱，能不能重新设计一下**」
→ 我给了两个模型并问选哪个 → 用户：「**你来决定吧，这是一个创作者的工作台，以便利性为主**」。
→ 我选了「一套筛选 + 一个视图开关」这一版（下面第一条就是为什么另一个模型不够）。

- **混乱的根**：左栏当时有**四个按钮说两件事** —— 两个页签（实体 / 时间线节点 = 你在管哪一类）
  叠两个形态按钮（列表 / 文件夹树 = 这一列怎么摆）。更糟的是**「列表」在两个页签下的含义不一样**：
  实体页签下是一列平铺条目，节点页签下画出来的**其实也是那棵树**（行长相、点击行为都与文件夹形态相同，
  只有左栏那一列不同）⇒ 用户看到的正是"这两个功能有点混乱"。
- **重做成两个控件**（都在左栏）：
  ① **一排筛选 pills**（`#cx-chips` 里的 `[data-cx-chip]`）= **筛什么**：`全部 N` / 各实体类型 `角色 1` /
  `时间线节点 M`。计数**按当前搜索词算**（搜索时一眼看出命中落在哪一类）。
  ② **一个视图按钮**（`#cx-view`）= **怎么摆**，按钮上写当前形态（`视图 列表` / `视图 文件夹`），
  `title` 说点下去会变成什么；点击只重画左列 + 写 `Settings.workbenchView`（**不整块重建**，同第十一节）。
  **一**个按钮不会跟筛选 pills 打架（两个并排的按钮会让人以为是第二种筛选）。
- **`mode` 不再是全局页签，而是"你点中了哪一行"**：点实体行 → `mode='entity'`（中栏走 `fields.ts`、右栏出帧条），
  点节点行 → `mode='node'`（中栏走 `props-panel.ts` + 面包屑）。两条路都走 `switchTarget()`。
- **「列表」= 一列平铺的条目**（按类别分组：`设定` / `时间线节点` 两个 `.ed-tgroup` 小标题，
  只有 `全部` 时显示小标题）；**「文件夹」= 那棵树**（世界 → 时间线 → 种类 → 节点 ／ 世界 → `_设定` → 类型 → 实体）。
  两种形态的行都用同一套 `.ed-tnode` 渲染与同一份点击处理（`bindTreeClicks`），
  列表行多一个 `.ed-tflat`（`padding-left: 8px` —— 列表没有层级，36px 的树缩进在这里没意义）。
  ⇒ 从根上除掉"列表里其实藏着棵树"这件事。
- **⚠️ 顺带修掉的连带问题**：`normalizeEntitySelection()` 原来对着**筛过的那批**归一 ⇒ 用户把 pills
  切到「时间线节点」时会把正在编辑的实体清空（中栏跳成"左边选一个实体看图"）。现在它对着**全部实体**
  归一：筛选只决定"看什么"，不决定"在编谁"。同理，点条目不再偷偷改用户选的筛选（旧代码在实体分支里
  `filterType = ''`）。
- **兼容**：列表里的实体行仍带 `data-cx-id`（旧版是 `<button data-cx-id>`），行内仍是两个 span
  （`children[0]` = 名字、`children[1]` = 类型）⇒ 十几个按 `[data-cx-id]` 找行的老套件**一行都不用改**。
  ⚠️ `treeRow()` 里的属性写入从 `dataset[k]` 改成 `setAttribute('data-' + k)`：带连字符的键（`cx-id`）
  走 dataset 会抛 `SyntaxError: 'cx-id' is not a valid property name`。
  ⚠️ 这一节的「两个控件」只活了几十分钟 —— 用户看完就说「把全部改成文件树的形式」，见第十三节。

### 十三、左栏定型：只有一棵树，而且**默认全展开**（用户 2026-09-13，**已做**）

用户原话：「**要不这样，把全部改成文件树的形式，这样子也方便看**」
⇒ 形态之争到此结束：第十二节那两个控件（筛选 pills + 视图按钮）一起撤掉 —— 它们是中间站，不是终点。

- **撤掉的东西**：列表形态（`listView`）、筛选 pills（`#cx-chips` / `[data-cx-chip]` / `renderChips()` /
  `filteredEntities()`）、视图按钮（`#cx-view` / `VIEW_TIP` / `viewLabel()` / `viewBtnHtml()`）、
  设置面板那组「工作台默认形态」单选与 `Settings.workbenchView` 字段（`DEFAULTS` 里那条也删）、
  `#cx-chips` 那两行骨架、`searchPlaceholder()`、`.ed-tflat` / `.ed-tgroup` 两条 CSS。
  现在左栏 = 一个搜索框 + 那棵树（`#cx-list`），`renderList()` 就是树本身（原来的 `renderTreeList()`）。
- **为什么筛选也不需要**：**树的形状本身就是筛选** —— 要看哪一类就展开哪一枝；条目已经按
  世界 → 时间线 → 种类（或 `_設定` → 类型）分好组，再叠一层 pills 只是把同一件事说两遍。
  搜索保留，而且**跨类别**（非空时把命中摊平，一个框同时管"设定"和"事件"）。
- **默认全展开**：`expandedWorlds/Tls/Kinds` 三个 Set **语义反转**成 `collapsedWorlds/Tls/Kinds`
  （记"被收起来的"那些），配一对一行函数 `isOpen(set, key)` / `toggleOpen(set, key)` ——
  空 Set（初始状态）就是全展开。用户的话是"方便看"：打开左栏就该看到全部条目，
  而不是先点三层才看见东西；点一下 = 收起那一枝。收起态**跨重画保持**（`renderList()` 只读不写那几个 Set）。
- **连带的测试收益**：`[data-cx-id]`（实体行）与 `[data-act="node"]`（节点行）开箱即见 ⇒
  `codex-smooth-switch` / `kind-change-stale-file` / `motion-switch` 里"先展开再点"的步骤全都不需要了。
  ⚠️ 反过来，`workbench-tree-folders.cjs` 里原来那些"点一下展开"的步骤**现在会变成收起** ⇒
  改成 `rowOpen(act, label)` 先读 `is-open` 再决定点不点（★0/1/3/12/★17 都改成"默认就展开"的断言）。
- **新的稳定抓手**：实体行仍带 `data-cx-id`，另外补了 **`data-cx-type`**（树上**不显示**类型 ——
  上一层文件夹已经写着它了）；`entity-vault.cjs` / `cold-start-entity-vault.cjs` /
  `startup-materialize-entity.cjs` 原来读 `children[1]`（旧列表行的第二个 span）当类型，改读 `data-cx-type`。
- ⚠️ **旧键 `workbenchView` 从此与形态无关**：`codex-tree-view.cjs` 开头故意把它写成 `'list'` 再开工具，
  断言左栏**照样**是那棵树（守着"形态不再由设置决定"）。

### 验证（五/六/七/八/九/十/十一）

- `editor-tree.cjs` **28 → 34 → 33 项**（`seed-editor-tree.cjs` 播种：节点种类 `事件` 有 2 个节点 /
  `战斗` **空** / `角色` **空且与实体类型同名**；实体类型 `角色` 有 1 个实体 / `地点` **空**）；
  A/B：退回第一版 7/28、退回"切页签 + 无缩进" 27/34、退回第十节的"列 formats 全部种类" 28/33。
  `%TEMP%\lk-edtree` + 端口 9704。**该套件已退役**（第十一节），语义移入 `workbench-tree-folders.cjs`（31 项）。

- 第十一节：`codex-tree-view.cjs` 29/29（`%TEMP%\lk-evault2` + `reset-entity-vault.cjs` + `seed-node.cjs`）、
  `workbench-tree-folders.cjs` 31/31（`%TEMP%\lk-edtree` + `seed-editor-tree.cjs`）；
  回归 `codex-node-tab` 17/17、`codex-smooth-switch` 16/16、`codex-switch-target` 7/7、
  `toolbar-groups` 4/4（创作组 5 个）、`motion-switch` 25/25、`entity-evolution` 38/38（干净起点）、
  `entity-vault` 17/17、`data-load-clean` 6/6、`kind-change-stale-file` 11/11；
  `tsc --noEmit` / `node --check` / `vite build` 全 exit 0。
- 真实数据副本（第十节）：`%TEMP%\lk-dupe`（真实 JSON + 真实 vault 的副本、**无 formats.json**）
  ⇒ 全树无重名，「主线」下只有「事件」。

- 第十二节（左栏重做）：
  `codex-tree-view.cjs` **30/30**（`%TEMP%\lk-evault2` + `reset-entity-vault.cjs` + `seed-node.cjs`，端口 9710）——
  新增 ★1b「列表形态不分层：两类条目分组平铺（设定 / 时间线节点）、没有世界层」，
  ★1/★3 改成断言「一个视图按钮 + pills」且 `#cx-tab-*` 数量为 0（守着"别再长出第二套开关"）、
  ★27 加断言「回到列表后世界层消失」。
  `codex-node-tab.cjs` 17 → **18/18**（★1 改成 pills 断言；★2 改成"筛到节点后是一列平铺、没有世界层"；
  ★3/4/5/5b 改成切「视图 文件夹」后的四级树；★14 改成"点另一类别的行"）。
  `motion-switch.cjs` **25/25**（★1/★8/★13/★15 里"至少三块/第 2 块 100ms/第 3 块 200ms"改成
  **只钉节奏**：`played[i].delay === i * 100` —— 撤掉页签那行后工作台只剩 2 个可见顶层块；
  ★13 改成点"另一类别的那一行"，★14 改回点实体行）。
  其余回归全绿：`workbench-tree-folders` 31/31（★26b 改成"切一次视图形态后仍在编辑这个实体、展开态没丢"）、
  `codex-smooth-switch` 16/16（`[data-cx-id]` + `.is-on`；⚠️ `seed-smooth-switch.cjs` 的配角 **20 → 34**：
  行高变成 `.ed-tnode` 的 21-24px 之后，20 个配角撑不到中栏那么高 ⇒ `#cx-root` over=0 ⇒ 面板不可滚 ⇒
  ★0/★6 假挂）、`codex-switch-target` 7/7、`entity-evolution` 38/38（干净起点）、`entity-vault` 17/17 +
  冷启动 PASS、`startup-materialize-entity` 6/6、`data-load-clean` 6/6、`toolbar-groups` 4/4、
  `kind-change-stale-file` 11/11（★① 改成"筛到时间线节点 → 列表里直接点那条"）；`tsc --noEmit` / `vite build` exit 0。
  视觉：`%TEMP%\lk-left-list.png` / `lk-left-tree.png`（列表 = pills + 设定/时间线节点 分组行 + 视图按钮写「视图 列表」；
  文件夹 = 世界文件夹 + 按钮写「视图 文件夹」）。
  ⚠️ 又踩了两次"套件不自足/前提变了"，两次都不是产品问题：`codex-tree-view` 在 `lk-motion` 上跑（那里没有空类型）
  挂 ★7/8/★9；`startup-materialize-entity` 少了 `seed-json-only-entity.cjs` 挂 ★1/2/3。

- 第十三节（左栏定型）—— 全绿，用的都是**干净起点**（播种 + 重启）：
  `codex-tree-view.cjs` 重写成 **21/21**（原来那套"两种形态 30 项"整段作废）：★1 左栏只有一棵树
  （没有页签 / 形态开关 / pills）、★2 默认全展开（tl/kind/node/setRow/etype/ent 一次点击都不用）、
  ★2b 形态与旧键 `workbenchView` 无关、★3 层级顺序 = 硬盘目录、★4 种类只列真有节点的、
  ★5/★6 空类型在且置灰 + 一句人话、★8/★9 点实体行换中栏且左树没被换掉、★11 点节点行、
  ★12 搜索跨类别且摊平、★15 收起的那一枝**在左栏重画之后仍然收着**、★17 再展开回来、
  ★18 设置面板里**没有**形态单选了。
  `codex-node-tab.cjs` **18/18**（★1 改成"只有一棵树"、★2 改成"打开就是全展开"、★3 改成"点世界行收起/再点展开"、
  ★4 改成"层级顺序 = 硬盘目录"、★5/★5b 改成"种类只有事件 / 节点就在树里"、★14 去掉切形态那一步）。
  `workbench-tree-folders.cjs` **29/29**（展开步骤改成幂等的 `rowOpen` 判读；★26b 从"切一次视图形态"
  改成"收起再展开 `_設定` 后仍在编辑这个实体、高亮与展开态都回来"）。
  回归：`codex-smooth-switch` **16/16**（多亏 `data-cx-id` 默认可见；★0 的 38 行一次查全）、
  `kind-change-stale-file` **11/11**（步骤① 去掉 `@node` chip，直接点树里的节点行）、
  `motion-switch` **25/25**、`entity-evolution` **38/38**（重新播种 + 重启，含以往偶发的 ★5/★5b/★10d/★14b）、
  `entity-vault` **17/17** + 冷启动 PASS、`startup-materialize-entity` **6/6**、`codex-switch-target` **7/7**、
  `data-load-clean` **6/6**、`toolbar-groups` **4/4**；`tsc --noEmit` / `vite build` 全 exit 0。
- 回归（历史）：`codex-node-tab.cjs` 15/15、`editor-props-panel.cjs` 9/9（同一实例接着跑）。

## 第二十轮（2026-09-12）· 动效层第 A 片（切换类）+ 一条新发现的数据损失

> **目的**：用户在前两轮数据修复后选了「3 做动效」，并明确「**这是个大活，所有涉及元素变化情况的
> 都要做上动画**」，随后补一句「**看一下有没有现成的动画库可以用，看 kb**」。
> 分片计划：**A 切换类（本轮）** / B 列表变化 / C 画布（时间线）；用户先选 A。

### 一、先查 kb：现成动画库有什么（用户点名要看）
- `F:\knowledge-base\tech-notes\design\animejs.md` = **Anime.js**（`juliangarnier/anime`，69.2k⭐，MIT），
  笔记本身就是冲着灵框写的：「**灵框 v3 是 Electron 前端** —— 加 UI 微交互（卡片/折叠/切换动画）
  能用 Anime.js；世界观**时间线交互**（节点拖动/展开/循环框动效）更丝滑；用户之前用类 AE scrub +
  transition 做动效 —— Anime.js 是更完善方案（几行代码替代手搓）」。
- 另有 `tech-notes/dev/morph-icon.md`（状态图标动画，配 Anime.js）；KB 日记 `daily/2026-07-12.md:25`
  记着用户装过 GSAP AI Skills（`F:\gsap-skills` 目录确实在）。但 GSAP 是 Webflow 自家许可
  （免费、非 OSI），Anime.js 是 MIT 且体积小得多（打包约 119.8KB）⇒ 真要装就装 Anime.js。
- **决定（用户选 1）**：现在就装 Anime.js，但 **CSS 打底**，库只用在 CSS 表达不了的地方
  （元素被重建、却要从**旧位置**滑到新位置：画布节点移动 / 列表增删让位 = 第 B/C 片）。
  ⇒ `animejs@4.5.0` 进 devDependencies，**本轮一行都没用**；装前做过烟测（ESM 命名导出
  `animate`/`stagger`/`utils` 类型可解析 + esbuild 能打包）。

### 二、动效层（新增 `src/ui/motion.ts` + `src/style.css` 末尾「动效层」）
- 两个 API：`enter(el, cls='lk-enter')` 重放一次入场（**摘类 → 强制重排 → 加类**，只加类不会重播）；
  `staggerIn(container, sel, step=40, cap=12)` 给子项注入 `--lk-delay`（≤12 项，长列表不至于等一两秒）。
- keyframes：`lk-wake`（淡入 + 上浮 8px = DESIGN.md:157 的 Waking fade）/ `lk-fade` / `lk-reveal-x` /
  `lk-pop`（= legacy `modal-in`）；错峰靠容器类 `.lk-enter-stagger > *` 读 `--lk-delay`。
- 挂点（细节见 `ARCHITECTURE.md`）：`src/tools/registry.ts` 的 `openTool()`（切工具/开面板唯一入口）、
  `src/ui/shell.ts`（回沙盘走 `lk-fade-in` 不带 transform；世界栏/时间线页签错峰 40ms）、
  `src/ui/confirm.ts`（遮罩 + 卡片）、`src/ui/codex.ts`（`pendingEnter`：**只有显式换条目/换页签**才播）、
  `src/ui/detail.ts`（首次 renderView）、`src/ui/node-form.ts`、`src/ui/alert.ts`（横幅滑入）。
- **只入场、不做退场**（弹窗）：`settle()` 立刻 resolve 并移除 overlay；等 animationend 再 resolve
  会让破坏性操作（删除/恢复）为一个观感延迟 200ms。要退场得先想清楚这个时序。
- `prefers-reduced-motion`：容器动画降级为纯淡入（DESIGN.md:159「only --motion-fast fades」），
  错峰归零 —— 都由 `src/style.css` 的降级块负责（延迟改为 CSS 按序号给之后，行内值压不住的问题也一起没了）。
- **时值（用户 2026-09-12 体感反馈「速度稍微慢一点，元素弹出要错分一点点时间」）**：
  入场单列 `--motion-enter: 480ms`（设计系统只有 base 320 / slow 640 两档，DESIGN.md:157 的 Waking fade
  用的正是 640ms，取中间值），错峰从 40ms 提到 **80ms**（第 8 项封顶），设定库换页签/换条目的内容块
  也改成逐块错峰浮现。

### 三、顺带修掉：`src/style.css` 的动效令牌与设计系统差一倍（本轮已修）
- `src/style.css:23-25` 自己声明了一份动效令牌：`--ease-standard: cubic-bezier(0.4,0,0.2,1)`（Material 味）、
  `--motion-base: 160ms`、`--motion-fast: 100ms`，**且没有 `--motion-slow`**；
  而 `design-system/tokens.css:116-119` + DESIGN.md 第 7 节写的是 **180 / 320 / 640ms** +
  `cubic-bezier(0.22,0.75,0.25,1)`，并在 `DESIGN.md:182` 明令「**Do not** speed up the motion to feel like
  a snappy developer tool. The dream registers at **300ms+, not 150ms**」。
  ⇒ 应用跑的是被设计系统明确禁止的档位。已把 `src/style.css` 的四个令牌对齐设计系统，
  并在文件里复写一份 reduced-motion 降级块（该文件不 import `tokens.css`，只能复写）。
  影响面：只有 `src/style.css:320` 那一处既有 `transition` 用到这些令牌（画布节点变色/位移），
  其余动效都是本轮新加的。

### 四、本片途中挖出的数据损失（**已修**）· 没有节点的时间线会被 vault 重建抹掉
- **现象**：新建一条时间线（还没有节点），重启应用（或任何一次 vault 回扫）后它**从界面上消失**。
- **机制**：`src/main.ts:122 vaultToWorldData()` 重建 `timelines` 时**只遍历 vault 扫描结果**
  （`for (const [tlName, nodes] of Object.entries(tls))`，`id = 'tl-' + tlName`，`order.push(id)`），
  而**一条没有任何节点的时间线在 vault 里根本没有对应目录** ⇒ 这趟重建直接把它丢掉。
  同类漏洞此前已修过两处：`maps`（`src/main.ts:147-151` 的注释）与 `entities`
  （`src/main.ts:161-163` 的「vault 里还没有 `_设定` 目录 → 保留 base」例外），**`timelines` 漏了**。
  更值得注意：时间线级的 `absOffset` / `loops` / `circa` / `storylines` **只有 JSON 一份**
  （重建时靠 `prev?.` 从 base 抄回来）—— 一旦这条时间线被丢掉，**它的循环与剧情线一起消失**，
  这正是用户上一轮问过的「只存在 JSON 里的东西」。
- **实测（本机，`%TEMP%\lk-motion`）**：播两条时间线（主线 1 节点 / 支线 0 节点）→ 起应用 →
  页签栏只有「主线 ＋」，盘上 JSON 里两条都还在（`loadData` 后没写盘所以没被抹）；
  **若此时发生任何落盘，`writeAll` 会按内存里那份（少了空时间线）覆盖文件 ⇒ 变成永久丢失。**
- **修法（已落地）**：`vaultToWorldData()` 在按 vault 重建完后补一趟 —— `base` 里该时间线
  **本身就是 0 节点**（纯 JSON 容器）就保留；`base` 里有节点却扫不到目录（用户从外部删了整个目录）
  继续丢掉。**不能**只看"扫不到"就保留：那样外部删除会"删不掉"，还会把文件重新写回来。
  另外页签次序改为以 `base.order` 为准（原来用 vault 的 readdir 顺序，重启后次序可能变，
  保留下来的空时间线也必须留在原位）。
- **验证**：`tools/e2e/timeline-persist.cjs` **8/8** + `tools/e2e/cold-start-empty-timeline.cjs` **3/3**
  （夹具 `seed-empty-timeline.cjs` = 三条时间线：主线有节点、**支线 0 节点且没有目录**、副线有节点；
  断言覆盖「启动后三条都在 / 空时间线能选中 / 落盘后空时间线还在文件里 / 回扫后仍在 / **外部删掉主线
  目录后主线消失且不复活、副线与两条空时间线都没被牵连** / 重启后空时间线仍在」）。
  顺带的回归守卫：`seed-motion.cjs` 的第二条时间线现在**故意留空**，一旦这条修复回归，
  `motion-switch.cjs` 的 ★7（要求两个页签）会立刻挂。



> **目的**：用户在菜单里选的「先修『改动自己变回去』」。节点的**种类 = 它所在的文件夹名**
> （`nodePath()` 按 `n.kind` 建目录、`scanTimelineDir()` 用 `sub.name` 回填），
> 所以在应用里换种类 = 把 `.md` 搬到另一个文件夹 —— 而 `writeVaultNodeSync` 只清**目标文件夹**里
> 同 id 的旧文件，**旧文件夹那份留在原地**。回扫时同 id 是「后来者覆盖」
> （`nodesById.set(n.id, n)`），readdir 顺序一不合适（NTFS 按 UTF-16 序：
> `事` U+4E8B < `战` U+6218，「事件」总排在「战斗」前面），旧文件就是后来者 ⇒
> **每次回扫都把种类连同字段一起打回旧值**。用户看到的是「我改的东西自己变回去了」。
> 设定库的条目（实体）先前有同样的毛病，第十六轮已修；节点侧是同一段形状的坑。

### 复现（先证明，再修）

新 e2e `tools/e2e/kind-change-stale-file.cjs` + `seed-kind-change.cjs`
（播 `主线/战斗/王国的建立.md`，再**在界面里把种类改成「事件」**）。
**修复前跑 4/8**，症状全中：

- ★4 同 id 剩两份：`["事件/王国的建立.md","战斗/王国的建立.md"]`
- ★5 旧文件夹那份还在
- ★6 **回扫之后种类被打回「战斗」**（正是用户看到的症状）
- ★7 回扫之后仍是两份

### 修法：扫描登记索引 → 写盘按 id 一步删（`dropStaleNodeFiles` / `dropStaleEntityFiles`）

第一版是「三层扫目录」（⓪ 同目录按 id / ① 别处同名 / ② 搬到新位置时全树），
跑通之后用户选了「接着修那条慢的」，于是收敛成现在这两层 —— **删之前一律按 id 命中才删**
（id 相同即同一个节点，那份是被应用忽略的旧副本，删它不丢用户可见内容）：

- ① **索引**（`main.js` 的 `vaultFileIndex`）：**扫描期登记**「这个 id 的 `.md` 在哪」——
  扫描本来就把每个 `.md` 读了一遍，登记零额外 I/O；值里含**同 id 的全部文件**（不只赢家，
  败者照样要清）。写盘时按 id 直接找到旧文件删掉：改名 / 换种类 / 同 id 两份，全覆盖，O(1)。
- ② **兜底**：**别的种类文件夹里同名**的那份（索引冷或过期时兜住最常见那种形状，只 stat 不读内容）。
  换种类的残留必定同名（换种类只换文件夹），所以这一层同时**自愈升级前就留在盘上的旧残留**
  —— ★8 就是测这个（手工把旧残留放回旧文件夹，应用自己清掉，收敛后界面说的种类/标题与活下来的文件一致）。

**为什么不每次扫目录**：`writeVaultNodeSync` 每次自动落盘都会被调一次（渲染层 `writeAll` 遍历全部节点），
扫目录比对 id = O(节点数²) 次读盘。**实测**（一条 200 个节点的时间线，走渲染层真实 `api.vaultWrite`
逐个 await，两边同一台机、各自全新实例）：

| | 写 200 个节点一轮 |
| --- | --- |
| 修复前（每次写盘读整个文件夹） | **2060 ms**（10.30 ms/个） |
| 现在（索引 → 按 id 一步删） | **313 ms**（1.56 ms/个） |

旧版是 O(节点数²)（节点翻倍 = 耗时四倍），新版每个节点恒定。

- 键 = `世界\u0000范围\u0000id`（范围 = 时间线名；实体用 `_设定`）；`vault:scan` 开头整张重建。
- ⚠️ 索引只当**线索**不当真相：删之前一律再解析一遍确认 id（`dropVaultFileIfSameId`），
  并且只删**当前 vault 根目录里**的文件 —— 索引半张、过期、或换了 vault 都不会误删别人的文件。
- 实体侧同一套（`_设定/**` 从第十六轮的「每次写都全扫」改成同一条规则）。
- **⚠️ 清理挂在写盘上（既有语义，未变）**：只有当一个节点**被写**时才清它的旧文件。
  一份「输了」的残留（不改变回扫赢家 ⇒ 界面无变化 ⇒ 不触发落盘）会躺到下次有人动这个节点 ——
  ★11 就是按这个语义断言的：先放残留 → 再改一下描述触发落盘 → 才要求只剩一份。

### A/B 教训：**脏目录会让测试假挂**（这次差点误判成「改坏了」）

改完先跑回归，`codex-node-tab.cjs` 从 15/15 掉到 **13/15**、★10/★11 连挂三次，看着像我的锅。
按 `tools/e2e/README.md` 铁律 3 做 A/B（把脏目录原样复制两份，一边跑 HEAD、一边跑改动）：
**HEAD 在同一目录上只有 12/15，★10/★11 读到的是空字符串**。真因是**目录脏** ——
上一会话遗留的 `王国的建立（改）.md` 与本次播种的 `王国的建立.md` **同 id**，
回扫赢家是（改）那份（后缀更长、排序在后），应用一直写（改）那份，而测试读的是固定路径的原名那份；
`reset-entity-vault.cjs` **只清实体、不清时间线节点目录**，残留于是跨会话累积。
而 HEAD 那 12/15 里，旧代码会把播种的那份**删掉**（同目录按 id 清理），测试读到空文件。

⇒ 两件事：**① `seed-node.cjs` 现在先清空这条时间线**（播种必须给出确定起点，不靠 readdir 运气）；
**② 我的改动在该脏目录上与 HEAD 行为逐项对等**（同样 12/15、同样塌成一份），
换到干净起点后 `codex-node-tab` 回到 **15/15**。
（这也是「同目录残留不能不管」的证据：旧代码清它、我第一版为省时把这一步关掉了；
现在由索引接管 —— 它登记的正是扫描见过的全部同 id 文件，★11 盯着这条。）

### 验证

- 新测试 `kind-change-stale-file.cjs` **11/11 ×2**（干净起点；含索引层那条 ★11）
- `codex-node-tab` **15/15 ×3**（干净起点）、`editor-props-panel` **9/9**、`data-load-clean` **6/6**
- `entity-vault` **17/17**、冷启动 **PASS**、`startup-materialize-entity` **6/6**
- `codex-switch-target` **7/7 ×3**、`data-corrupt-guard` **16/16**
- `node --check main.js` / `tsc --noEmit` / `vite build` 全 exit 0
- 性能对照见上表（200 节点：2060 ms → 313 ms），脚本在 `%TEMP%`（`lk-perf-seed.cjs` / `lk-perf-bench.cjs`，一次性）

### 仍在案的（未修）

- 同一条时间线里同 id 两份并存时，**赢家仍由 readdir 顺序决定**（NTFS 按 UTF-16 序）。
  它是本 bug 的传播机制；现在写盘会清掉/自愈，但「谁是赢家」这条规则本身还是隐式的。
- 实体**重名**会撞进同一个 `.md` 路径（`entityPath()` 用名字当文件名）——既有设计，未改。

### 五、用户第二条体感反馈「切换工具时会闪黑一下…元素还是没错开弹出」（本轮已修）

- **抓帧定性**：`Page.captureScreenshot` 连抓 6 帧（脚本 `%TEMP%\lk-swithseq.cjs`，图 `%TEMP%\lk-sw-0..5.png`）
  ⇒ 点工具后的**第一帧**「面板里内容其实已全部就位、只是整块发灰」（`#lk-module-view` 停在低不透明度上）。
  窗口底色 `main.js:319 backgroundColor: '#c5c2ba'` 是浅色，所以不是真"黑"——用户说的是这一下"整片洗白/发暗"。
  **两条反馈同一个病根**：整块容器 opacity 动画既造成"闪"，又把每个元素自己的错峰**完全盖住**
  （整片一起淡入，看不出谁先谁后）。
- **修法**：① `src/tools/registry.ts` 的 `openTool()` 删掉 `enter(host)`；② `src/ui/shell.ts` 回沙盘不再
  `lk-fade-in`；③ 改成渲染完后给**工具根部的顶层块**挂 `cascadeIn()`（一次性错峰）；
  ④ 设定库再加**第二级** `cascadeIn(#cx-list, 60, 420, 200)`（左列条目等主体那块到位后逐条浮现）；
  ⑤ 时值按用户「直接再调慢一点」：`--motion-enter` 480 → **640ms**（＝设计系统 slow 档＝
  `DESIGN.md:157` 自己的 Waking fade 时长），错峰 80 → **100ms/项**（第 6 项封顶）；
  ⑥ 弹窗卡片改走 `--motion-base`（320ms）：弹层是"等你操作"的东西，不该花一整个 dream 时长浮上来。

### 六、本片途中挖出的**工具切换竞态：慢工具盖掉新工具**（本轮已修）

- **现象/实测**：同一个同步块里点 `settings`（import 未缓存）→ 立刻点 `codex`（已缓存），
  **2.5 秒后主区仍停在 settings，而工具栏按钮亮着 codex**（MutationObserver 时间线：`cx-root` 先出现、
  settings 的 `DIV` 后出现，之后没有任何修正）。
- **机制**：各工具的 `open` 是 `import(...).then((m) => m.renderXxx(host, store))`，而
  `src/ui/settings.ts` **函数内部还有自己的一层异步渲染** —— 它把清理函数交回来时 DOM 未必写完。
  `openTool` 里"过期回调就地作废"只护得住**清理函数**，护不住那次渲染：落后的那次直接写进
  `#lk-module-view`，把当前工具盖掉。（曾先试过"过期落地就把当前工具重开一次盖回来"——
  **不够**：settings 的内部渲染发生在它返回清理函数之后，守卫跑完它还能再写一次。）
- **修法：一格一工具**。`openTool` 每次在 `#lk-module-view` 里新建 `.lk-tool-slot`，把**格子**当 host
  交给工具；切走时整格（连 DOM）摘掉 ⇒ 晚到的渲染写进已被摘掉的格子，永远无害。把"写哪儿"钉在
  **打开那一刻**是关键。布局上格子要 `height: 100%`（把「百分比高度撑得住」这条链传下去，
  否则工具根部 `height: 100%` 会因为父元素高度 auto 塌成 0）；`closest('.lk-module-view')` 这类
  查询仍能穿过格子（`src/ui/assoc.ts` 在用）。
- **守护**：`motion-switch.cjs` ★17 用**同一个同步块**连点两个工具（挑本套件从没点过、import 必然
  没缓存的 `schema`），断言终态是后点的那个、且格子只剩一个。

### 七、本轮自己写出来的两个坑（都已修，留档防重犯）

- **`animationend` 会冒泡**：`cascadeIn` 的收手监听器原来只 `{ once: true }` 挂在"最后一块"上，
  容器里任何**后代**元素自己的动画结束都会把它消耗掉 ⇒ 整组错峰被提前收掉（实测：本该错峰
  0/100/200/300 + 640ms，几百毫秒后动画对象就空了、类也摘了）。修法：认 `e.target === 最后一块`，
  且不能用 `once`。
- **行内 `animation-delay` 压得过媒体查询**：`cascadeIn` 注入的是行内值，只在 CSS 里写
  `prefers-reduced-motion` 降级块**压不住** ⇒ 函数里必须自己读 `motionReduced()` 把延迟清零
  （否则"减少动效"下依然一个个错开着出来）。
- 顺带把 `openTool` 的 `.catch(() => {})` 改成 `console.warn`：静默吞异常让"点了没反应"极难查
  （本会话被它耽误过一次，`#cx-root` 一直不出现却什么错都看不到）。

### 验证（五/六/七）

- `tools/e2e/motion-switch.cjs` 扩到 **18 项**（新增 ★2/★7/★9「容器不许播」、★6「错峰自收手」、
  ★17「同 tick 连点竞态守卫」、★4 改用 `animationend` 当"真的在跑"的证据）—— **18/18**
- 回归（全部干净起点、各自独立目录）：`codex-node-tab` **15/15**、`editor-props-panel` **9/9**、
  `codex-switch-target` **7/7**、`data-load-clean` **6/6**、`startup-materialize-entity` **6/6**、
  `entity-vault` **17/17** + 冷启动 **PASS**、`kind-change-stale-file` **11/11**、
  `data-corrupt-guard` **16/16**、`timeline-persist` **8/8**、`cold-start-empty-timeline` **3/3**
- `node --check main.js` / `node --check preload.js` / `tsc --noEmit` / `vite build` 全 exit 0
- ⚠️ 测试上的新事实（写进 `tools/e2e/README.md` 铁律 6/7）：这个环境里**出一帧就可能把 CSS 动画
  直接推到结尾**，所以"读 `currentTime` 中间态"是不可靠的（★4 改用 `animationend`）；而且
  `cascadeIn` 是一次性的、播完会**自己收手**，读晚了动画对象就是空数组。

### 八、卡片级错峰（灵感触发器）+ 两条测试铁律（本轮已做）

- **用户问法**：「灵框触发器的卡片算同一个元素吗，我想卡片也是一样的，错分入场」。
  答案：**不算** —— 卡片（= `CHAR_GROUPS` 的 13 组，各一张 `.tool-card`）在块**里面**：
  `src/tools/registry.ts` 那趟顶层错峰只到「标题栏 / 卡片区 / 联想画布」三块，卡片跟着卡片区整块出来。
- **做法**：`src/ui/inspire.ts` 的 `renderChar(combo, animate = false)` 末尾
  `if (animate) cascadeIn(result, 50, 720, 120); else stopCascade(result);`
  （`result` = 卡片网格 `#insp-result`）—— 13 张正好排成 `120·170·…·720ms` 的阶梯。
  步长 50、封顶 720 是刻意的：封顶太早（如 500）时后面几张会**同时**冒出来，看着像整块。
- **播的时机（用户当天二次要求后收敛）**：用户说「**重新生成改成无错分的，只有初次进入时才有错分**」
  ⇒ 只有**初次进入**（工具打开，`renderChar(null, true)`）播；「重新生成」（`inspire.ts:211`）与
  「组合 N」加载（`:203`）都**不播** —— 那两种是"我要立刻看新词"，再排 13 张队只会碍事。
  锁定（`:134`）与改词条数（`:148`）按既有设计**不重建卡片**，所以本来就不播。
  ⚠️ 不播的分支**必须显式 `stopCascade(result)`**：错峰类要等最后一张动画结束（或
  `maxDelay + 2000ms` 兜底）才摘掉，用户打开工具后马上点「重新生成」时它多半还挂在卡片区上，
  新卡片会从父类继承 `.lk-enter-stagger > *` 的 nth-child 延迟 ⇒ 又错峰一遍，
  "不该播的那一次"照样播了。加了这一步，行为才与点击时刻无关。
  为此 `src/ui/motion.ts` 新增导出 **`stopCascade(container)`**（摘类 + 清子项行内延迟），
  `cascadeIn` 自己收手时也改走它。
- **配套机制 `.lk-own-cascade`**：卡片区自己带这个类 ⇒ **父级那趟不许给它整块淡入**，否则又是用户报过的
  那个病（整块半透明 ⇒ 洗白 + 把子级错峰盖住），只是下沉了一层。两侧都要有：
  CSS `.lk-enter-stagger > .lk-own-cascade { animation: none }`（靠 (0,2,0) 特异性压过 `> *`
  和降级块里的 `> *:nth-child(n)`）+ JS 在 `cascadeIn` 里把它从 `kids` 滤掉（不写无用的行内延迟，
  也不让它当"最后一块"——它没有动画，`animationend` 永远不来，会白等到兜底定时器）。
  附带好处：**被跳过的子项不占序号**（父级三块的延迟仍是 0 / 100，画布不会莫名多等 100ms）。
- **测试坑一（★4 曾随机挂）**：`Page.captureScreenshot` **只打一帧**时，隐藏页面里动画的生命周期走不完
  ⇒ `animationend` 一个都不来（实测 `__ends` 是空数组）。按铁律 6 用 `forceFrames()` 连打几帧才稳。
- **测试坑二（★16 被改挂过）**：新加的 ★21（减少动效下卡片降级）在 ★16「沙盘仍然可见」**之前**
  把主区切到了灵感触发器、却没切回来 ⇒ ★16 的前提被自己破坏（`sandboxVisible:false`）。
  教训与"脏目录"同类：**断言要顺带把状态还回去**，否则污染后面几条。
- **跑测试时用户正开着正式应用（本轮新事实，已加后门）**：`main.js` 有单实例锁，第二个实例抢不到锁会
  `app.quit()`，而**正式实例收到 `second-instance` 会 destroy + 重建用户正在用的窗口** —— 也就是
  「起个测试实例」这个动作本身就会打断用户。新增后门 `LINGKUANG_TEST_USERDATA=<目录>` 把 userData
  （localStorage / settings.json / 词库副本）也隔离，并在该变量存在时**不参与单实例锁**；
  顺带避免两个实例共用一份 Chromium profile（Local Storage 是 LevelDB，会互相踩）。
  ⚠️ README 里那条老写法 `Get-Process electron | Where-Object { $_.Path -like '*lingkuang-v3*' } | Stop-Process`
  会**连用户的正式应用一起杀掉**，已改成按调试端口 / 测试 userData 匹配。

### 验证（八）

- `tools/e2e/motion-switch.cjs` 扩到 **22 项**（新增 ★18 卡片逐个错峰 + 卡片区自己不整块淡入、
  ★19「重新生成」**不重播**、★20 锁定不重建卡片、★21 减少动效下卡片降级）—— **22/22**
- 回归（隔离 userData、各自干净起点）：`codex-node-tab` **15/15**、`editor-props-panel` **9/9**、
  `data-load-clean` **6/6**
- 视觉取证（动效类改动必须抓帧看）：点开灵感触发器后连抓 5 帧 —— 帧 0 只有标题栏、
  帧 ~360ms 前两排已清晰而**后几张仍在淡入**（真·一张张出来，无洗白）
- `tsc --noEmit` / `node --check main.js` / `vite build` 全 exit 0

### 九、刷新词条时高度一跳（灵感触发器）+ 两个测量陷阱（本轮已做）

- **用户原话**：「**刷新词条的时候高度会变，能不能改成平滑过渡**」。
- **实测机制**（点「重新生成」前后各量一次）：每张卡的词条数是随机的（`currentCount()` = 1..min(4, keys.length)），
  但**卡片高度只有 80 / 104 / 128 / 152 四档** —— 因为网格默认 `align-items: stretch`，
  一行四张卡的高度都取**该行最高那张**。所以高度是按"行"整批变的：
  实测卡片区**同一个 tick 内** 570 → 498px / 430 ↔ 646px（连下面的联想画布一起弹一下）。
- **做法**：`src/ui/motion.ts` 新增 `childHeights(container)`（**重建前**量旧高度）+
  `smoothHeights(container, before)`（重建后从旧高度过渡到自然高度），CSS 侧 `.lk-h-smooth`
  （`transition: height var(--motion-base) var(--ease-standard)` + `overflow: hidden`）。
  为什么不能让 CSS 自己过渡：**`height: auto` 过渡不了** —— 内容驱动的变化不改 specified value，
  浏览器不会启动过渡；只能量出 px、临时写死、跑完还回 auto。网格行高与外层容器高度跟着子项算，
  子项平滑变高矮时它们自然一起平滑，不用单独处理。
  过渡期间 `overflow: hidden` 是必须的：变高那半程内容比盒子高，不裁会盖到下一张卡上。
  减少动效时**整段跳过**（`motionReduced()`），高度直接落位。
  挂点：`src/ui/inspire.ts` 的 `renderChar()` —— 初次进入走 `cascadeIn`（错峰），
  「重新生成」与加载组合走 `stopCascade` + `smoothHeights`。
- **视觉取证**：逐帧抓卡片区高度 = **430 → 555 → 629 → 645 → 646**（连续长上去，不是一步跳），
  中间帧截图确认最后一行是"被裁着往外长"、没有盖到下面。
- **测量陷阱一（我第一版探针十轮全报"高度没变"）**：高度过渡会把卡片**钉在旧高度上**，
  所以「点完立刻量渲染高度」量到的还是旧值 ⇒ 误以为改动没生效。这反过来是**免费的中间态证据**：
  同一 tick 里 `style.height`（目标）≠ 渲染高度（起点），就说明过渡确实在跑。★23 就是这么断言的。
- **测量陷阱二**：`el.getAnimations()` **把 CSS 过渡也算进来**（`CSSTransition` 与 `CSSAnimation`
  同一张表）⇒ ★19「点重新生成后没有入场动画」原本写 `anims === 0`，加了高度过渡后变成 13、
  直接误报。要判"没有入场动画"必须 `filter((a) => a.animationName)`。
- **测试基建**：★4（"出一帧后动画真的播完"）在隐藏窗口里**随机挂** —— 出帧本身不稳，
  同样 6 帧，一次把动画推到底、一次纹丝不动。改成**出帧到事件出现为止**（最多 8 轮 × 3 帧），
  断言没放宽（仍要求真的收到 `lk-wake` 播完的事件）。同一实例连跑两遍现在都 25/25。

### 验证（九）

- `tools/e2e/motion-switch.cjs` **22 → 25 项**（新增 ★23 过渡确实挂上、★23b 落位后停在目标高度、
  ★24 减少动效下不挂过渡）—— **25/25 ×2**（同一实例）
- 回归：`toolbar-groups` **4/4**、`codex-node-tab` **15/15**、`editor-props-panel` **9/9**
- `tsc --noEmit` / `vite build` 全 exit 0

### 十、灵感触发器的联想画布：被工具条挡、滚轮不生效、拖出视窗不跟着移（本轮已做）

> 用户原话：「**联想画布内节点会被一块地方挡住，看不全，还有把节点移出视窗时视窗不会顺着移动**」。
> 三件事看着无关，实测是**同一个容器的账**：画布高度写死 `100vh`、滚动容器找错了人、拖拽算式里
> 漏了视窗平移量。

**① 「挡住」= sticky 工具条压在画布最上面 54px（实测）**
- 窗口 1180×780 ⇒ `innerHeight` **741**；`#insp-scroll > div`（输入行那条）实测
  `position: sticky`、rect `top: 8 / bottom: 62`（高 54）。
- 而 `#insp-assoc` 原来是 `height: 100vh`（= 741）且是页面**最后一块** ⇒ 滚到底时画布顶部正好
  落在 y=62 以上、被工具条盖住；实测初始只有 **49~57px** 可见 ⇒ 画布最上面那一圈节点
  **怎么滚都看不全**（用户看到的"被一块地方挡住"）。
- **修法**：`src/ui/inspire.ts` 新增 `fitAssocHeight()` —— 量出工具条实际底边相对画布容器顶边的
  距离 `need = Math.ceil(barEl.getBoundingClientRect().bottom - host.getBoundingClientRect().top)`，
  再 `canvasHost.style.height = calc(100vh - <need>px)`；挂 `ResizeObserver` 盯那条工具条
  （文字换行/按钮增减都会改它高度）+ `window resize`，返回值里一并 `disconnect`。
  兜底样式也从 `100vh` 改成 `calc(100vh - 62px)`（JS 跑之前的首帧不能是错的）。
- 修后实测：`barBottom 54 / stageTop 90 / stageBottom 741 / stageH 651`（≥ 视口 70%），
  且画布顶部那一圈 `elementFromPoint` **归属画布**（`#assoc-world`）而不是工具条。

**② 画布上滚滚轮毫无反应 = 滚动容器找错人**
- 真正在滚的是 **`.lk-tool-slot`**（工具格，`overflow: auto`），而 `#lk-module-view` 自己
  `scrollHeight === clientHeight === 741` **根本不会滚**。
- `src/ui/assoc.ts` 的普通滚轮分支原来写死 `stage.closest('.lk-module-view')` ⇒ 拿到一个不滚的
  元素、滚轮被吞 ⇒ 鼠标停在画布上滚不动（得挪到卡片区才能滚）。
- **修法**：新增模块级 `function scrollParent(el)`（沿祖先链找第一个 `overflowY` 为 auto/scroll
  且 `scrollHeight > clientHeight` 的祖先），滚轮分支改用它。

**③ 拖出视窗不跟着移 + 视窗一动节点就漂 = 拖拽算式没扣平移量**
- 原式 `dn.x = _dragOx + (e.clientX - dragSX) / assocZoom` —— 没扣 `assocPanX`，所以视窗只要动，
  节点相对鼠标就漂。
- **修法**（`src/ui/assoc.ts`）：常量 `PAN_EDGE = 56, PAN_MAX_V = 18`；新状态
  `dragPanX0/dragPanY0`（按下瞬间的 pan）与 `dragPX/dragPY`（节点落点）；
  `applyDrag(cx, cy)` 用 `dx = cx - dragSX - (assocPanX - dragPanX0)`；`edgePush(pos, lo, hi)` 判左右边缘
  （±56px 内返回 ±1），`ensureAutoPan()` / `autoPanTick()` 用 rAF 每帧把 pan 推 `PAN_MAX_V * 推力`
  像素，`stopAutoPan()` 在 `endPointerGestures()` 与卸载清理里都调。
  ⇒ 详见下面「十一」：当时这里还加了两个"夹在世界内"的夹子（节点落点、视窗平移），
  **当轮就被用户推翻**（他要无限画布），该段保留作为来龙去脉，现行语义以「十一」为准。

### 十一、无限画布：撤掉三个夹子 + 钉住手动摆放的节点（用户当场推翻上一版）

> 用户原话（第十节刚上线后立刻）：**「现在有边界了，向上拖不动节点了，我想要无限画布」**。
> 「向上拖不动」正是第十节那两个夹子造成的：世界顶边 `y=20` 就在眼前 ⇒ 节点往上拖到 20 就钉住；
> 视窗 pan 夹在 `[min(0,·), max(0,·)]` ⇒ **panY 最大是 0**，往上推根本推不动。

**① 三个夹子全撤（`src/ui/assoc.ts`）**
- 拖节点落点（原 `applyDrag` 里的 `Math.min(Math.max(...,20), WORLD_W-20-w)`）：撤。
- 力导向（原 `forceStep` 尾部四个边界判断 `20 .. WORLD_W-20`）：撤 —— 不撤的话松手后节点会被拽回框内。
- 视窗平移（`clampPanToWorld()`）：整个函数删掉，`autoPanTick` 里的"推到边界就收手"检查一并去掉
  （没有边界 ⇒ 指针还在边上就一直推）。
- 副作用：`WORLD_W/WORLD_H` 这个名字会让人以为是边界 ⇒ 改名 **`HOME_W/HOME_H`**，
  注释写明它现在只剩两个用途：新节点初始落点参考区、连线 SVG 的作图原点与 viewBox。
  缩放仍夹在 0.4~3（那是缩放，不是边界）。

**② 手动摆过的节点要钉住（否则"能拖出去"变成"拖了又弹回来"）**
- **实测（先量后改）**：只撤三个夹子时，把根节点往正上方拖 300px、松手后出 60 帧
  ⇒ 世界坐标从 `−7811` 被弹簧拽回 `−7594`（**2 秒内回弹 217px**，第 120 帧仍在 −7616 荡）。
  用户看到的就是"拖了又弹回去"。
- 修法：`applyDrag` 里 `(dn as any)._pinned = true`；`forceStep` 的积分循环里
  `if ((n as any)._pinned) { n.vx = 0; n.vy = 0; return; }` —— 钉住的节点**仍然参与斥力/弹簧计算**
  （会把别的节点推开、把子节点拉过来），只是自己不动。等价于"我放哪儿就待在哪儿"。
  重新按根词展开（`assocSetRoot`）会重建节点，钉标记自然消失。
- 实测钉住后 `drift: [0,0]`（60 帧零位移）。

**③ 框外的连线不能被裁掉（无限化的隐藏坑）**
- 连线层是 `2000×1200` 的 SVG（`viewBox: 0 0 2000 1200`），而 SVG 根元素**默认把内容裁到自己的视口**
  ⇒ 节点跑到框外（甚至负坐标）时，**连线整段消失**（节点还在，线没了）。
- 修法：`src/style.css` 里 `.assoc__lines { overflow: visible; }`。
- 验证方式（可复用）：拿一条**故意画在框外**的 path（坐标取当前视口中心换算出的世界坐标，
  必然是负几千），临时 `pointer-events:stroke; stroke-width:12` 后 `elementFromPoint` 打它的中点：
  `overflow: visible` 时命中 `path`，把它改成 `hidden`（A/B）时命中画布底下的 `DIV`
  —— 后者证明"裁掉"这事真的会发生，前者才不是自说自话。

**④ 视窗能飘得很远 ⇒ 安全绳**
- 「回到节点群」按钮（`updateViewportHelp` / `recenterToNodes`）本来就有（节点全出屏时出现），
  无限画布下它就是那条安全绳；本轮只做了确认，没改。

### 验证（十一）

- `tools/e2e/assoc-canvas.cjs` **8 → 11 项**（同一套件把第十节的断言**反过来**）：
  ★3b 按住不放越过旧世界右墙（`panX` 一路 −7961 → −9226，旧墙是 `stageW−2000 = −899`）且节点仍贴鼠标；
  ★5 反向推**越过原点**（`panX` −9226 → −3533 → +2206）继续走；★7 **向上拖**：节点世界坐标
  `250 → −50`（旧版在 20 就停）+ 贴顶边按住 `panY = 3641 > 0`（旧版夹在 0）且节点仍贴鼠标；
  ★8 松手 60 帧 `drift: [0,0]`（钉住）；★9 框外连线不裁（含上面那条 A/B）。
- 视觉取证：把根节点往上拖到世界 `y = −1872`（远在旧 2000×1200 框外）后截图 ——
  6 个节点与 5 条连线**全部正常**，背景无任何边界痕迹。
- 回归：`motion-switch` **25/25**、`codex-node-tab` **15/15**、`editor-props-panel` **9/9**、
  `toolbar-groups` **4/4**；`tsc --noEmit` / `vite build` 全 exit 0。

### 验证（十）

- 新增 `tools/e2e/assoc-canvas.cjs`（首版 **8 项**）：★1 滚到底时 `stageTop(90) ≥ barBottom(62)`、
  `stageBottom(741) ≤ vh`、顶部那一圈 `elementFromPoint` 仍归画布、`stageH 651 ≥ vh×0.7`；
  ★2 画布上 dispatch `WheelEvent(deltaY:260)` → 真滚动容器 `scrollTop 0 → 260`；
  ★3 拖到右边缘「按住不放」出 3 帧 → `panX 0 → −417` 且节点仍**贴在鼠标下**（`underCursor:true`）；
  ★4 松手后出 8 帧视窗纹丝不动（**这条至今有效**）。
  （★3b「推到头停在世界右墙」与 ★5「停在左墙 0」两条边界断言已被「十一」反过来，见上。）

- ⚠️ 测试前提（已写进脚本头）：测试实例是 `showInactive`（窗口 hidden）⇒ **rAF 不出帧不推进**，
  「自动推视窗」必须 `forceFrames()`（`Page.captureScreenshot`）才走，否则看起来像"没实现"。
  指针事件用 `new PointerEvent(...)` 合成：`pointerdown` 打在**节点元素**上（stage 的监听靠冒泡），
  `pointermove/pointerup` 打在 `window` 上（画布挂的是 window）。
- 视觉取证：滚到底截图，画布顶部的 8 个节点**完整可见**、工具条只在它上方，无遮挡。
- 回归：`motion-switch` **25/25**、`codex-node-tab` **15/15**、`editor-props-panel` **9/9**、
  `toolbar-groups` **4/4**；`tsc --noEmit` / `vite build` 全 exit 0。
  （⚠️ `codex-node-tab` 必须在**只有一条时间线**的目录里跑：它按第一个时间线页签展开树，
  在 `lk-motion`（两条时间线）里跑会展开到空的那条 ⇒ 2/9 假挂。）

### 十二、连线上的「拉力」：拖动全程是死的 + 钉住没有上限（本轮已修）

> 用户原话：「**拉太远时拉力会失效**」；追问后补充：「**线没断，但是拉力失效了，是不是数据溢出的问题**」。
> 注意"线没断" —— 边还在画，但线上没有力。

**① 先排除"数据溢出"（用户猜的方向），结论：不是**
- 把力公式在各距离下算了一遍（与 `forceStep` 完全一致：弹簧 `(d-140)*0.05*temp`、斥力 `900/(d*d)*temp`）：

  | 距离 d | 弹簧力(temp=1) | 稳态(temp=0.22) | 斥力 | 每帧位移 |
  |---|---|---|---|---|
  | 1e3 | 43 | 9.5 | 9e-4 | 54 |
  | 1e5 | 4993 | 1098 | 9e-8 | 6316 |
  | 1e6 | 49993 | 10998 | 9e-10 | 63241 |
  | 1e15 | 5e13 | 1.1e12 | 9e-28 | 6.3e12 |

  ⇒ 力随距离**线性增长**、全程有限，没有 NaN/Infinity（把节点丢到 40 万像素外实测 `bad:false`，
  并且它确实在被往回拉）。所以"力度不够/算坏了"不成立。

**② 真因（`src/ui/assoc.ts` 的 `forceStep`）：跨过"手里那一格"的受力是**两边一起**被跳过的**
```ts
if (dragGroup && (dragGroup.has(a.id) !== dragGroup.has(b.id))) continue;   // 斥力
if (dragGroup && (dragGroup.has(a.id) !== dragGroup.has(b.id))) return;     // 弹簧
```
- 被拖的那个节点本来就在积分阶段被冻住（`n.id === dragNodeId`），**它自己不需要这份豁免**；
  可这一行把**线的另一头**也一起免了 ⇒ 拖一个词的**全程**，与它相连的词纹丝不动。
- **A/B 实测**（同一套断言、同一台机、各自全新实例；修复前 = `git checkout -- src/ui/assoc.ts` 后重新 build）：
  | | 拖动 144px 时根词位移 | 线被拉成 | 两端都手工摆过后再甩远 |
  |---|---|---|---|
  | 修复前 | **1 px** | **291**（静止长度 140） | 间距 **4477 → 4477**（永远回不来） |
  | 修复后 | 146 px | 146 | 1811 → **142** |
- 为什么用户说"拉太远"才明显：小幅度拖动时邻居那一小段没跟上也看不出来；拖得越远，线被拉得越长、
  越像"线还在但没力"。

**③ 修法（两处，都很小）**
1. `const inHand = (id) => dragGroup !== null && dragGroup.has(id);` —— 只免**手里那一格**：
   跨边界的受力改成「谁不在手里谁受力」（`if (!aIn) { a.vx += fx; … }`），两端都在手里（拖整棵子树）时
   照旧整对跳过（组形不变）。
2. 新增 **`PIN_YIELD = 420`**：钉住（`_pinned`）原来没有上限 —— **两端都被手工摆过**时，线被拉多长都回不来
   （上表第三列 4477→4477 就是这一条）。现在弹簧里加一句：
   `if (!aIn && d > PIN_YIELD) (a as any)._pinned = false;`（两端各判一次）
   —— 「钉住是别乱动，不是焊死」：小范围摆位不受影响（静止长度 140 的 3 倍才松钉），
   被拉太远就让弹簧把线收回来。

**④ 测试：新增 `tools/e2e/assoc-pull.cjs`（6 项）+ 修掉两条不可靠的旧断言**
- 新套件把 `window.fetch` 换成固定 5 个词（`雪狼/冻湖/松林/极光/猎户`），保证"根 + 5 子词"的图**确定复现**
  —— 否则本机没跑 ollama 时图里只有根词、根本没有边，拉力无从断言。★1 拖动全程线被拉住（A/B 判据）、
  ★2 近处钉住（自身漂移 0）、★3 两端都钉住 + 拉太远后必须收回、★4 40 万像素外不出 NaN、★5 无异常。
- ⚠️ **★1 的第一版写在修复前也能 PASS**（实测踩到）：落点方向不对时，位移里带着"朝根靠"的分量，
  原地不动也能让间距变小（那次 `gapBefore 134 → gapDuring 60`）。改成**沿"根 → 被拖词"方向往外拖**
  才有判别力（`gapDuring 291` vs `146`）。教训：断言要盯"只有修好才会发生的那件事"。
- ⚠️ 落点必须**夹在画布内**：拖到画布外会触发贴边自动推视窗，节点被推飞几千像素，测的就不是弹簧了。
- `tools/e2e/assoc-canvas.cjs` 的 **★8 改判据**：原来断言"松手后节点坐标一动不动（钉住）"——
  `PIN_YIELD` 之后这不再是承诺，改为守住"手势真的结束"（松手后的指针移动不再带动节点 + 贴边推停住）。
- `tools/e2e/assoc-canvas.cjs` 的 **★9 顺手修掉一个假绿**：原来用正则只挑"紧跟 M/L 的那个数"、
  还要求它以 `-` 开头或 4 位以上 ⇒ **漏掉"x 正常、y 为负"的常见情形**
  （实测 `d = "M 638.5 -443.5 L …"`，y 明明在框外却判成 inside）。现在把坐标全取出来按视口逐点判。

### 验证（十二）

- `tools/e2e/assoc-pull.cjs` **6/6**（同一实例连跑 3 遍稳定）；A/B：**未修复版 3/6**（★1/★3/★4 全 FAIL，
  正是用户报的三件事），**修复后 6/6**。
- `tools/e2e/assoc-canvas.cjs` **11/11**（★8 改判据、★9 修假绿后）。
- 回归：`motion-switch` **25/25**、`codex-node-tab` **15/15**、`editor-props-panel` **9/9**、
  `toolbar-groups` **4/4**；`tsc --noEmit` / `node --check` / `vite build` 全 exit 0。

### 十三、设定库点一下实体就像"刷新界面"（2026-09-13，**本轮已修**）

> **用户原话**：「**设定库中点击实体会刷新界面，我希望变成平滑切换（点击其他实体时），
> 顺便生成一点测试数据**」。

**机制**（`src/ui/codex.ts`，旧写法）：点左列条目 → `switchTarget()` → `render()` →
`host.innerHTML = …` 把**整个面板**（标题行、页签行、左列、中栏、右栏）重造一遍。
同一页签内换条目时，真正该变的只有三样东西（名字/类型 + 字段行 + 正文），却要付三样代价：

1. **左列与整块骨架重播一次错峰入场**（`cascadeIn(#cx-root)` + `cascadeIn(#cx-list, 60, 420, 200)`）
   ⇒ 该点开的东西又一个个冒出来，最多 700ms；
2. **`#cx-root` 本身就是滚动容器**（`overflow:auto` + `height:100%`）—— 被换掉 ⇒ **滚动位置回到顶部**。
   实测：点前 `scrollTop 260`，点后 **0**（正文在屏幕下半截、或左列条目多的时候最明显）；
3. **tiptap 实例被 `dispose()` 再新建** ⇒ 正文区先空一帧再填回来
   （`#cx-doc .ProseMirror` 元素身份新旧不同）。

**修法：同模式内换条目走「就地换内容」**（`swapBody()`，`src/ui/codex.ts`）——
保住骨架，只换该换的三样，再给内容区一次**轻淡入** `.lk-swap-in`：

- `switchTarget()` 里 `flush()` 之后**不再 dispose** 编辑器；`swapBody()` 成功就直接返回，
  失败（换页签 / 换世界 / 条目被删空 / 骨架是"没有条目"那一版）才 `pendingEnter = true; render()`。
- 正文写回的目标从"创建时捕获"改成**读时取值**（`docTarget`）——编辑器跨条目复用了，
  目标会变；安全性由 `switchTarget` 的顺序保证（先 `flush`（旧目标）再改 `docTarget`）。
- 节点中栏的公共属性面板 `propsPanel` 同样提升成模块级并复用（它从 `getTarget()+store`
  推导目标，换个 `nodeTarget` 再 `render(node)` 就是新节点）。
- 骨架里新增两个 id 当"就地换"的抓手：**`#cx-body`**（中栏 + 右栏那块容器，淡入挂在它上面）、
  **`#cx-nodepath`**（节点的「世界 · 时间线 · 种类」面包屑）。
- 实体字段行抽成 `fillEntityFields(el, e)`，`render()` 与 `swapBody()` **共用一份**
  （两处各写一遍就会漂移 —— 抽公共属性面板时吃过这个亏）。
- `.lk-swap-in` 的 keyframes 从 **`opacity: .5` 落位，不是从 0**：从 0 出来就是"闪一下白"
  （用户报过的老毛病，见第五节）；也刻意只动 opacity 不加 transform ——
  这一块里套着 contenteditable，transform 会让它成为 fixed 的包含块、还会让过渡期间的光标位置跟着位移。
- 换页签（中栏结构真的变了）与换世界仍然整块重建 + 错峰，★13 专门守这一条。

**A/B（先证明断言有判别力，见 e2e README 铁律 9）**：同一个 `%TEMP%\lk-smooth` 目录、
`git checkout -- src/ui/codex.ts` + `vite build` 复跑 ⇒ **未修复 8/16**，
挂的正是 ★1（骨架元素换了）/★2（搜索框换了）/★3（tiptap 换了）/★6（滚动 260 → **0**）/
★8（错峰重播：`stagger:true, wake:4, delayed:4`）/★9（没有 `lk-swap`）/★10/★14；
**修复后 16/16**。内容类断言（★4/★5/★7/★11/★12）在两边都过 —— 那本来就是对的，留作回归。

**顺带产出的测试数据**（用户「顺便生成一点测试数据」）：
`tools/e2e/seed-smooth-switch.cjs` 播 3 个不同类型实体 + 2 个节点 + **20 个「配角」实体**
（配角是为了让左列自己撑得比可视区高 —— 否则"滚动不回顶"这条断言没有可滚的余地）；
用户真实世界（`F:\\lingkuang-vault\\测试世界观\\_设定\\`）另写入 9 条**演示设定**
（艾德温·霜冠 / 灰袍法师·塞尔 / 守夜人队长·凛 / 安德希亚城 / 北境冻原 / 王之霜冠 / 霜纹剑 /
守夜人 / 霜精灵，id 前缀 `demo-`），内容贴合那个世界已有的时间线。

### 验证（十三）

- 新增 `tools/e2e/codex-smooth-switch.cjs` **16/16**；A/B 未修复版 **8/16**（见上）。
- 回归：`codex-node-tab` **15/15**、`editor-props-panel` **9/9**、`codex-switch-target` **7/7**、
  `data-load-clean` **6/6**、`toolbar-groups` **4/4**、`entity-vault` **17/17**（干净起点）、
  `motion-switch` **25/25**；`tsc --noEmit` / `vite build` 全 exit 0。
- ⚠️ `entity-vault` 第一次跑出 **11/17**：同一实例里先跑了 `codex-switch-target`（它建了「甲」「乙」），
  断言于是看到多余的实体 —— 按铁律 4（先怀疑目录脏）重来：**reset + 重启后 17/17**。

### 十四、换类别时的两件事：节点高亮不消失 + 面板刷新（2026-09-13，**本轮已修**）

> **用户原话**：「**从事件节点切换到实体节点时，事件节点保持选中状态，且面板刷新**」。

**两件事两个根因，都在 `src/ui/codex.ts`：**

1. **高亮不消失（一行）**：树的节点行原来只比"选的是谁"，没看"现在在编哪一类" ——
   `const on = !!nodeTarget && nodeTarget.world === g.world && …`（`renderList()` 里树分支与搜索命中
   分支各一处）。切到实体后 `nodeTarget` 照旧指着一个节点 ⇒ 那一行**还亮着**，看上去像没切过去。
   修法：条件前面加 `mode === 'node' &&`（实体行那边本来就有 `mode === 'entity'`，两边对齐）。

2. **面板刷新**：`swapBody()` 开头 `if (renderedMode !== mode || !host.querySelector('#cx-root')) return false;`
   ⇒ **换类别一律整块 `render()`**（左树与骨架重播错峰、`#cx-root` 滚动容器被换掉 ⇒ 滚动回顶、
   tiptap 重建）—— 就是用户看到的"刷新"。可中/右栏之外的东西**本来就不用动**：
   左树同时装着两类条目、顶栏只有那个「＋新建实体」要显隐、帧条元素可以常驻（节点模式藏起来）。

**修法：把"就地换"扩到换类别**（仍然是 `swapBody()`，新增 `mountBody()`）：

- 中/右栏那一块的 HTML 抽成 `bodyHtml()`（写在 `render()` 外面，两处共用）；
  它的接线（建 tiptap / 属性面板 / 字段行 / `#cx-name` `#cx-type` `#cx-del` `#cx-h1` `#cx-img`）
  抽成 `wireBody()`。
- `mountBody()`：结算旧正文 → 销毁旧编辑器/面板 → `#cx-body` 的 innerHTML 换成 `bodyHtml()` →
  切 `#cx-rail` 与 `#cx-newbox` 的显隐 → `wireBody()` → `renderedMode = mode`。
- `swapBody()` 里 `renderedMode !== mode` 那一支改成走 `mountBody()`：只重造 **`#cx-body`**，
  骨架（顶栏、左树、`#cx-root` 的滚动位置）全留着，内容区照旧播一次 `.lk-swap-in`。
- 骨架里 `#cx-rail` 改成**常驻**（节点模式 `display:none`）、顶栏那个「类型下拉 + ＋新建实体」
  包进 `#cx-newbox` 按 mode 显隐 —— 这两样原来靠骨架重建来切换。
- `pendingEnter` 那条路（整块重建 + 两级错峰）保留，但如今只在"骨架不在 / 最后一个实体被删空"
  时才走到；换类别与换条目都不再经过它。

**A/B（同一 `%TEMP%\lk-smooth` 目录、`git checkout -- src/ui/codex.ts` + `vite build` 复跑）**：
**未修复 15/18**，挂的正是 ★13/★14b/★14c —— 而且 ★14c 的 dump 直接把用户报的现象打了出来：
`{"sameRoot":false,"stagger":true,"wake":2,"delayed":2,"body":[],"nodeOn":["第一次魔潮"]}`
（切到实体后节点行**还亮着**、还整块重建 + 错峰）；**修复后 18/18**。

### 验证（十四）

- `tools/e2e/codex-smooth-switch.cjs` 16 → **18 项**：★13 从"换类别仍然整块重建 + 错峰"**反转**成
  "换类别也**就地**换（骨架同一元素、无 `.lk-enter-stagger`/`lk-wake`/行内延迟、内容区播一次
  `lk-swap`、实体行高亮清零、节点行高亮正好 1 个）"；新增 ★14b（换回实体同样就地换）、
  ★14c（**节点行的高亮必须消失**、高亮落到实体行、帧条重新出现、中栏字段与正文都是该实体的）。
  **修复后 18/18 · 修复前 15/18**。
- `tools/e2e/motion-switch.cjs` **25/25**：★13/★14 原来断言"换类别后内容块逐块错峰（第 i 块迟 i×100ms）"
  与"左列第二级错峰（200/260ms）"—— 这两个触发点随这次修改消失，改成**反向守卫**
  （换类别/换条目后 `#cx-root` 与 `#cx-list` 的子项**一个动画都没有**、内容区只播 `lk-swap`）。
  整块错峰的**节奏**断言仍由 ★1/★8（切工具）覆盖 —— 那条路照旧整块重建。
- 回归（各自干净起点）：`codex-node-tab` **18/18**、`codex-tree-view` **21/21**、
  `codex-switch-target` **7/7**、`kind-change-stale-file` **11/11**、`workbench-tree-folders` **29/29**、
  `entity-evolution` **38/38**、`entity-vault` **17/17**、`data-load-clean` **6/6**、
  `toolbar-groups` **4/4**；`npx tsc --noEmit` / `npx vite build` 全 exit 0。
- ⚠️ `entity-evolution` 在同一实例里连跑第二遍是 **31/38**（脏状态），重新播种 + 重启后 38/38 ——
  与上一轮同一回事，别当成回归。

## 第十八轮（2026-09-12）· 数据判损护栏 + 两个静默失效

> **目的**：`main.js` 里那条注释早就写下了后果 —— 解析不了的 `worldbuilding.json`
> **绝不能被空数据静默覆盖**（截断文件启动、不做任何操作，文件就变成「新世界」）。
> 这一轮去堵它，顺带挖出两个同族毛病：**都是静默失效 —— 出事了，但界面上零提示**。
> 用户选了「先做判损护栏」。

### 一、判损护栏（`main.js` 的 `dataWriteLock`）

**为什么不是「解析失败就报损坏」那么简单**：2026-08-23 那份 290KB 的
`worldbuilding.bak-corrupt-20260823-175035.json` **至今能正常 `JSON.parse`**
（无 BOM、结尾完整，5 个世界 / 17 条时间线 / 99 个节点）。而 `preserveFile()` 是朴素的
`fs.copyFileSync`（`main.js:380`），拷的是**失败那次读之后**的磁盘现状 —— 所以
「判损瞬间的字节」和「拷下来的字节」可以不是同一份东西。能解释这件事的机制只有竞态：
本应用自己的 `writeFileSync` 先截断再写，读它的人会看到中间态；读失败 → 报损坏 →
拷的时候写入方已经完成。（时间戳对不上：副本 mtime 17:49:52 vs 文件名戳 17:50:35 差 43 秒，
所以**没坐实**，但它证明了「单次读失败」不足以定罪。）

两层护栏：
- **① 先重读再判损**：判损前重读 3 次、每次隔 200ms（`READ_ATTEMPTS = 4`、`READ_RETRY_MS = 200`），
  读不到就拿着上一份 raw 继续重试。真损坏必然次次失败，竞态读到的半截几乎必然在下一次就完整。
  `data:load` 因此改成 async，并回传 `attempts`（自动化据它断言「确实重读过」）。
- **② 判损即上锁**：锁挂在 **`writeDataFileSync()`** 里 —— 那是 `data:save` 与
  `app:flush-sync`（退出前落盘）**唯一的共用写入口**，锁在这里两条路径同时失效，不存在漏一条。
  上锁后 `data:save` 回 `{ok:false, locked:true}`（不是普通失败：这是有意为之，自动化与 UI 要能区分）。
  两个出口都是显式的：新 IPC `data:allow-write`（顶部横幅「继续用新数据」）解锁并立刻落一次盘
  （`lingkuang-force-save` 事件 → `writeAll()`），或者走「备份管理」（`backup:restore` / `backup:import`
  **不经** `writeDataFileSync`，上锁不影响它们 —— 这正是留给用户的救援通道）。
  **读到一份能解析的文件 = 损坏已解决 → 自动解锁**，不让用户记着去点。

**渲染层**：`loadData()` 不再把 `ok:false` 静默吞掉（旧代码 `if (res.ok && res.data)` 之后就没有 else，
失败与「首次启动」不可区分），改为回传 `corrupt`，由 `mountDataCorruptAlert()` 挂一条**壳级横幅**。
新增 `src/ui/alert.ts`（`showShellAlert`/`removeShellAlert`/`hasShellAlert`）+ 壳里加 `#lk-alerts` 通栏：
编辑器内部那套 `addHint` 活在编辑器工具里、切走就没了，而这条必须**任何工具下都在**。
横幅按 `vaultHasData` 说两句不同的话：vault 兜住了 →「节点/实体没受影响，但循环/剧情线/历法读不出来」；
vault 也是空的 →「界面现在是空的，别再动它」。正文用 `textContent`（带用户路径，不拼 HTML）。

### 二、`vault:watch` 静默失效（`main.js:1171`，**既有 bug，已修**）

```js
if (!fs.existsSync(root)) return { ok: false, error: 'vault not exist' };   // 修前：直接不挂监听
```
vault 根目录不存在时**永远不挂监听**，而渲染层那句 `api.vaultWatch().catch(() => {})`
（`src/main.ts`）只能接 reject、接不住 `ok:false` —— 于是**整个会话外部改的 `.md` 一律不回扫**，
界面零提示，直到下次重启。首次启动、或 vault 指向一个还没建的目录，必然命中；
而应用自己第一次保存就会把目录建出来，所以「目录已存在」的实例一切正常。

**怎么发现的**：这一轮的 e2e 用了全新临时目录，`entity-vault.cjs` 从 17/17 变成 **14/17**（★5/★6 挂）。
做了 **A/B**：`git stash push -u` → 用 HEAD（本轮改动之前）重新 `vite build` → 同一个 fresh 目录复跑
→ **同样 14/17、同样三条失败** ⇒ 不是本轮引入，是既有缺陷。差异只在于「启动时 vault 根存不存在」。
- 修法：`vault:watch` 里**先 `mkdirSync(root, {recursive:true})` 再监听**（vault 是应用自己的数据根，
  应用本来就往里写文件）；渲染层再加一句 `console.warn`，让 `ok:false` 不再无声无息。
- 验证：同一个 fresh 目录 **14/17 → 17/17**。

### 三、设定库的正文编辑器每 ~360ms 被整块重建一次（`src/ui/codex.ts`，**既有 bug，已修**）

**症状**：`codex-node-tab.cjs` 的 ★11（改正文落进 .md）间歇性失败，而 ★10（改描述）稳定通过 ——
两者走同一条写盘通路，所以先怀疑测试。**探针给了机制**（`MutationObserver` 盯 `#cx-doc`）：

| | 修复前 | 修复后 |
| --- | --- | --- |
| 改「描述」落盘 | t=1234ms | t=790ms |
| `#cx-doc` 里的编辑器 | **t=1597ms 被 removed 换成新的** | 观察器日志 **`[]`（一次都没动）** |
| 抓着的那个元素 | `elConnected:false`、`sameEl:false` | `elConnected:true`、**`sameEl:true`** |

**机制**：`store.subscribe` 里只要不是面板自己的提交（`quiet`）就 `render()`，而 `render()` 开头会
`flush + dispose` 掉 tiptap 再新建一个。**自动落盘 → vault watcher 回扫 → `store.update`**
这条链在每次编辑后约 360ms 都会走到这里一次 —— 于是在正文里打字时，编辑器每隔几秒被换一次 DOM。
已进编辑器的字**不会**丢（`render()` 先 flush 再 dispose），丢的是**恰好落在换 DOM 那一瞬的
击键/焦点/IME 组合状态**（探针那次卡在 1350ms 侥幸没事，测试那次卡在 1600ms 之后就丢了）。
**这不是测试写错：真人打字一样会丢。**

**修法**：订阅里加**内容签名闸门** —— `bodySignature()` = 目标身份 + 该目标的全部显示字段 + 正文
+ `activeWorld`（骨架标题跟着它走）。签名没变 = 屏幕上该显示的东西没变 = 编辑器没必要动。
左列照旧每次重画（那一列没有编辑器，重建只花 DOM 钱），页签计数单独用 `updateTabCounts()` 刷
（计数在**骨架**里，不在 `renderList()` 里，否则会留着旧数字）。
`quiet` 提交仍然跳过重建（拖拽中的 scrub 不能被销毁），但**签名要跟上**，否则下一次真外部改动会被漏掉。
`switchTarget()` 依旧直接调 `render()`（换条目必须重建），所以换文档的语义没变。
`bodySig` 声明在 `quiet` 旁边而不是订阅旁（`render()` 里要写它，放后面会形成 TDZ）。

### 验证（真实 Electron + CDP，`LINGKUANG_TEST_DATA`/`LINGKUANG_VAULT` 隔离）
- 新增 `tools/e2e/data-corrupt-guard.cjs` **16/16**：★1 截断文件启动 6 秒后**原文件逐字节未变**、
  ★2/★3 副本存在且与原文一致、★4/★5 已上锁且 `attempts=4`（证明重读）、★6/★7 上锁期间
  `data:save` 被拒且文件未变、★8~★10 横幅可见/两个出口/正文带副本路径、11~13 点「继续用新数据」
  → 横幅消失 + 解锁 + 文件被换成合法 JSON（自愈）、★14 中途补全的文件被重读捞回（`ok:true, attempts:2`）。
- 新增 `tools/e2e/data-load-clean.cjs` **6/6**：**误报守卫** —— 干净数据下次读通（`attempts === 1`）、
  没有横幅、没有凭空生成副本、写盘通路照常。
- `codex-node-tab.cjs` **15/15 连跑 3 轮**（含旧组合 `data-load-clean` 先跑 —— 那是修复前 2/2 复现失败的组合）。
- `codex-switch-target.cjs` **7/7 连跑 3 轮**；`editor-props-panel.cjs` **9/9**；
  `entity-vault.cjs` **17/17**（fresh 目录，修复前 14/17）；`startup-materialize-entity.cjs` **6/6**；
  冷启动 **PASS**。`node --check main.js/preload.js`、`tsc --noEmit`、`vite build` 全部 exit 0。

### 已知限制（新增，未修）
- **节点侧换「种类」的旧 `.md` 残留**：`writeVaultNodeSync`（`main.js:558`）只清理**目标目录**里同 id 的
  旧文件，而 `nodePath()` 按 `kind` 分文件夹 ⇒ 改 kind 后旧文件留在原文件夹，重扫按 id 去重是
  **后扫到者赢**（readdir 顺序决定，NTFS 按 UTF-16 序）⇒ 类型/字段会被打回旧值。
  实体侧本轮之前已用 `entityFiles()` 全树清理修好，**节点侧同类问题仍在**（与实体同一套修法）。
- **实体字段仍是两套**：设定库实体档案用 `fields.ts`、公共面板的属性行用 `buildPropCtrl`（等第 4 步收）。
- **判损上锁期间的取舍**（有意为之，记在案）：上锁后 JSON 不再被写，而循环/剧情线/历法**只存在于 JSON**，
  所以这段时间里对它们的改动不会落盘 —— 换来的是「唯一可恢复的那份文件不被覆盖」。
  用户点「继续用新数据」或从备份恢复即解除；两条路都在横幅上写着。
- `rotateBackups` 只留 3 份，且上锁期间不轮换（这正是要保的：别把最后一份原文件挤出去）。

## 第十七轮（2026-09-12）· 合并方案 A 第 3 步：设定库长成工作台

> **目的**（先目的后实现）：第 1、2 步做完后，编辑器和设定库**都能「列条目 + 改字段 + 写正文」**了
> —— 重叠到达峰值，用户每次都得先想「这件事该去哪个工具」。这一步把设定库做成**唯一的工作台**：
> 左列＝条目列表（「实体」/「时间线节点」两个页签 + 搜索框）、中栏＝档案字段、右栏＝正文编辑器；
> 第 4 步才谈编辑器降级还是撤掉。
> 用户明确选了方向 A：「抽公共属性面板，两边共用」—— 不允许出现第三份「改字段」实现。

### 抽公共面板（`src/ui/props-panel.ts`，新增）
- 把编辑器那套属性面板**整体移出** `editor.ts`：`createScrubField`（AE 式 scrub）、
  `dateToOrd`/`ordToDate`/`fmtCNDate`、`buildPropCtrl`、整个 `renderProps`（约 260 行）。
  `editor.ts` 967 → 513 行（`+12 / -466`），不再保留第二份。
- 冻结 API：`createPropsPanel({ store, host, status?, getTarget, patchTarget })` →
  `{ render(node, isEntity?), hide() }`；`PropsTarget` 是节点/实体共用的身份联合类型
  （`editor.ts` 原先那个局部 `Target` 改为 `import type { PropsTarget as Target }`，只有一份定义）。
- 面板自己从 `getTarget() + store` 推导 `targetNode/targetEntity/targetTimeline`（不进 deps）；
  `status` 改可空（面板里所有写状态都 `if (status)`）——这同时修掉一个隐患：
  原实现 `status.textContent = ...` 在 null 上会抛异常。

### 设定库工作台（`src/ui/codex.ts`）
- 左列双页签：**实体**（原类型筛选 chips + 列表）与**时间线节点**（世界→时间线→种类→节点 四级树，
  复用 `style.css` 的 `.ed-*` 树样式；搜索非空时摊平成命中列表）。
- 搜索框**只重画左列**（`renderList()`），不重建整块面板 —— 否则每敲一个字都会被重建的输入框丢焦点。
- 中栏：节点走**公共属性面板**（与编辑器同一份实现，含标题/时间历法 scrub/精度/类型/种类/描述 +
  种类模板字段 + 自定义属性增删）；实体仍走 `src/ui/fields.ts` 的模板字段控件。
- 右栏：`src/ui/doc-editor.ts` 正文编辑器，节点与实体各有各的 doc。
- 节点身份带 `world`（左列树列**所有世界**，编辑非活动世界的节点也写回它自己的世界）。

### 顺带按构造消除的一个隐患（**没有复现出实际损坏**，如实记录）
- 旧写法是「先把 `activeId` 改成新条目，再 `render()`」，而 `render()` 开头才 `docEditor.flush()`，
  flush 回调又按**当时**的 `activeId` 写 —— 结构上「上一条的正文可能写进下一条」。
- **实测没能复现**：真实鼠标点击会先 blur（blur 早于 click）→ 提交时 activeId 还没变；
  建条目走 `addEntity` 时 store 订阅会先同步触发一次 render，那时 activeId 也还是旧的。
  两种路径（含程序化 `.click()` 不失焦）在旧构建上都 **7/7 PASS**。
- 但仍按构造改掉：换目标一律走 `switchTarget()`（**先 flush 再改选择**），
  且正文写回**创建时就捕获的目标**（`writeDoc(myTarget, md)`），不再依赖「当前选中的是谁」。
  `tools/e2e/codex-switch-target.cjs` 作为回归哨兵（按 `.md` 文件断言正文归属）。

### 实测（真实 Electron + CDP，`LINGKUANG_TEST_DATA`/`LINGKUANG_VAULT` 隔离）
- `tools/e2e/codex-node-tab.cjs` **15/15 PASS**：双页签 → 四级树 → 选中节点 → 中栏固定行
  `标题/时间/精度/类型/种类/描述` + 种类模板字段 `地点/规模` → 改**描述**落进 `.md` 的 `#描述：` 段 →
  改**正文**落进 `#正文：` 段 → 搜索命中/空提示 → 切回实体页签正文框显示的是实体自己的正文。
- `tools/e2e/editor-props-panel.cjs` **9/9 PASS**（编辑器这一侧守共享面板）：固定行齐全、时间仍是
  scrub、描述是 textarea、**提交后面板没被重建**（输入框元素身份不变，`sameEl:true`）＋ 状态栏「已保存 ✓」。
- 回归：`entity-vault` **17/17**、冷启动 **PASS**、`startup-materialize-entity` **6/6**、
  `codex-switch-target` **7/7**（连跑 4 次稳定）；`tsc --noEmit` 与 `vite build` 均 exit 0。

### 已知限制（新增，未修）
- **编辑器重建窗口会吞掉紧随其后的首次输入**：`render()` 由 store 订阅触发时会把整块面板
  （含 tiptap 实例）重建，若恰好落在「用户刚点进正文、还没打字」的瞬间，那一下输入会落空。
  这是**既有行为**（旧 `codex.ts` 同样整块重渲染；`editor.ts` 只重画 sidebar 所以没这个问题），
  本步未改。修法方向：正文编辑器跨重建保留 selection，或让 store 订阅只重画左列。
  → **第十八轮已修**（订阅改按内容签名决定要不要重建；探针实测修复前每 ~360ms 换一次编辑器 DOM）。
- **实体字段仍是两套**：设定库实体档案用 `fields.ts`、公共面板的属性行用 `buildPropCtrl`。
  节点侧已经收敛成一份，实体侧等第 4 步（编辑器去留）定了再收。
→ **2026-09-13 已定**：编辑器工具**撤掉**、并入设定库工作台（第二十一轮十一），
但**实体字段仍是两套**（`src/ui/fields.ts` 的模板控件 vs 工作台节点侧的 `buildPropCtrl`）——
这一步没动它，仍是待办。
- 设定库的节点视图**没有「删除节点」**（节点生命周期仍归世界沙盘 / 详情面板），
  这一步只做「看与改」。

## 第十六轮（2026-09-12）· 实体（设定库）也写 vault 的 .md

> 接第十五轮留下的「已知限制」：`entity.doc` 只在 `worldbuilding.json` 里 ⇒ 实体正文在 Obsidian 里
> 看不到、也改不了。这一刀给实体也写 vault 文件，与节点同一套**文件为源**语义。

### 新增
- vault 里的实体根目录 **`_设定`**（`main.js` 的 `const ENTITY_DIR = '_设定'`）：
  `<世界>/_设定/<类型>/<名字>.md`。以 `_` 开头 = 「灵框的系统目录」，`scanWorldDir` / `vault:scan`
  会跳过它，不会把它当成一条时间线。
- `main.js`：`parseFm(text)`（从 `mdToNode` 抽出的 frontmatter 解析，**节点与实体共用**，避免两处漂移；
  键匹配顺序「先试带引号的键、再退回非贪婪裸键」**不能反**）、`entityToMd(e, typeName)` / `mdToEntity(text)`
  （frontmatter 存 id/name/type + 全部字段，正文写在 `#正文：` 标签之后，兼容手写 .md）、`entityPath()`、
  `writeVaultEntitySync()`、`scanEntityDir(wsDir)`、IPC `vault:write-entity` / `vault:delete-entity`；
  `vault:scan` 返回值新增 `entities`；`vault:trash-list` / `vault:trash-restore` / `app:flush-sync` 各加实体分支。
- `preload.js`：暴露 `vaultWriteEntity` / `vaultDeleteEntity`。
- `src/main.ts`：`mergeEntities(byType, baseEntities)` 摊平成 `{ id: Entity }` 并带上 `typeId`；
  `vaultToWorldData(worlds, entities, base)` 三处调用点（loadData / writeAll / onVaultChanged 回扫）改齐；
  `writeAll` 与退出时的 `flushSync` 都带上 `entities`。
- `src/store/actions.ts`：`removeEntity` 改为「先取出实体对象 → 删内存 → `vaultDeleteEntity` 把文件移进回收站」
  （与 `removeNode` 同理：只从 store 删、不清文件的话，下次重扫会把它从文件里拉回来）；
  `applyTrashRestore` 加 `kind === 'entity'` 分支。

### 本轮修掉的 5 条缺陷（都是这一刀自己带出来的）
1. **`src/main.ts` 实体写盘循环嵌错了层**：循环被嵌在「世界循环」内部 ⇒ W 个世界把全世界的实体各写一遍
   = **W² 次 IPC 写盘 + W² 轮 vault 监听回调**。已挪到世界循环**之外**。
2. **换类型后旧 `.md` 残留，类型改不回去**：`writeVaultEntitySync` 原来只清**目标目录**里同 id 的旧文件，
   实体从「角色」改成「地点」后 `_设定/角色/<名字>.md` 还在，回扫按 id 去重是**后扫到者赢**
   （NTFS 目录序下 `地` < `角`，旧的「角色」反而后扫到）⇒ **每次回扫都把 `typeId` 打回「角色」**。
   已改成用 `entityFiles(wsName)` 在 `_设定/**` 全树找同 id 旧文件再删。
   **节点侧换 `kind` 有同样的残留问题**（`nodePath()` 按 kind 分目录），属既有问题，本轮未动。
3. **`main.js` 的 `moveToTrash` 漏登记实体字段**：`vault:delete-entity` 传了 `type` / `entityId`，
   但 entry 只写 `kind/relPath/trashName/ts/title/world/timeline/nodeId` ⇒ 恢复时 `rec.type` 取不到。
   已补登记 `type` / `entityId`，`kind` 注释改为 `node | timeline | world | entity`。
4. **`src/ui/trash.ts:42 KIND_LABEL` 缺 `entity`** ⇒ 回收站里实体项显示成 raw 值「entity」。已补「实体」。
5. **升级前就存在的实体永远不会变成文件**：`writeAll` 只由 store 订阅触发（改动后 400ms 防抖），
   所以启动后不碰任何东西时，`_设定/` 根本不会被创建 —— 而这条链路的目的正是「实体在 Obsidian 里
   看得到」，用户升级后打开应用只会觉得「没生效」。（真实数据上实测复现：实体在设定库里，
   vault 里却没有 `_设定/`。）已抽出 `writeAllEntities()` 并在 `renderShell()` 之后、
   `vaultWatch()` 之前补跑一次 —— **只写实体、不写节点**（节点 `.md` 可能是手写手工排版的，
   每次启动回写会把它们整体归一化；放在 `vaultWatch()` 之前也是为了让自家写盘不被当成「外部改动」）。

### 实测（真实 Electron + CDP 9334，`LINGKUANG_TEST_DATA` / `LINGKUANG_VAULT` 隔离真实数据）**17/17 PASS**
建实体 → 改名字/填字段/写正文 → `_设定/角色/银发少女.md`（frontmatter 的 id/name/type/字段齐全 + `#正文：`）→
`_设定` 没被当成时间线 → **外部改 .md 的字段与正文都回扫进活 UI** → 换类型后文件搬到 `_设定/地点/`、
旧目录清空、再触发一轮回扫类型**仍是「地点」** → 删除后文件进回收站、重扫**不复活** →
回收站里显示中文「实体」→ 恢复后文件回原位、实体回 store、正文还在 → 全程无未捕获异常。
另做**冷启动**复验：重启后实体类型仍是「地点」、文件仍在 `_设定/地点/`。
启动补写单独一个用例（`tools/e2e/startup-materialize-entity.cjs`，先 `seed-json-only-entity.cjs` 播种）
**6/6 PASS**：造一个只在 JSON 里、vault 里没有 `_设定` 的实体 → 启动后**不点任何东西**它自己写出文件 →
字段值与正文都搬进文件 → 回扫不弹「外部改动」也不把类型打回 → 文件不会写成第二份。
并在**真实数据**上验了一遍（`%APPDATA%\lingkuang\worldbuilding.json` + `F:\lingkuang-vault`，先整份备份）：
启动后实体补写成 `_设定/角色/新实体.md`、7 个节点 `.md` 一个没少、无未捕获异常、无提示噪音。

> **排查教训（重要，别重犯）**：验证「外部改 .md 有没有生效」**必须读活 UI**，不能读 `worldbuilding.json`
> —— 回扫路径按设计 `suppressWrite = true`，**只进内存不回写 JSON**（文件为源，JSON 只是缓存，
> 下次启动仍以 .md 为准，不丢数据）。上一版测试脚本正是拿 JSON 断言，误报「字段/正文没同步」两条，白排查数轮。
> 另一条：CDP 脚本里的 DOM 选择器片段是**字符串**，要用 Node 模板插值 `${SEL('发色')}` 展开进表达式；
> 写成 `(SEL.toString())('发色')` 是在页面里**调用**它 → 得到源码字符串 → `?.value` 恒为 `undefined`。

### 已知限制（新增，未修）
- 实体**重名**会写进**同一个 `.md` 路径**互相覆盖（`entityPath` = `<名字>.md`）。节点侧 `nodePath()`
  同样是 `safe(n.title) + '.md'`，属**既有设计**，这一刀沿用 —— 没变好，也没变坏。
- 回收站恢复实体的提示语仍把它算进「N 个节点」（`applyTrashRestore` 复用了 `nNodes` 计数器），
  文案不精确，不影响数据。

## 第十五轮（2026-09-12）· 合并方案 A 第 1+2 步（设定库能写正文了）

> 用户提问：「编辑器和设定库是不是功能有点重叠了，能不能做在一起，先谈方案」。
> 查证后的真实重叠只有两处 ——**「列条目」与「改字段」各做了两遍**；而**正文只有编辑器能写**
> （设定库的正文是只读预览）⇒ 设定库是"半张卡"。用户选 **方案 A**：合成一个工作台
> （左＝条目列表 / 中＝档案字段 / 右＝正文编辑器）。分 5 小步做，本轮完成**第 1、2 步**。

- **第 1 步（抽公共渲染，不改界面）**：新增 `src/ui/fields.ts` —— `fieldRow(field, value, onChange, labelWidth)`、
  `parseFieldInput(raw, type)`、`formatFieldValue(v, type)`。设定库的档案字段改用它
  （原先是在 HTML 字符串里拼 `data-cx-field` 再统一绑定，现在直接造 DOM 行）。
  约定写进文件头：**只在 `change`（失焦/回车）提交**，因为这些面板都会在 store 通知时整块重渲染。
- **第 2 步（正文从预览换成真编辑器）**：新增 `src/ui/doc-editor.ts` —— `createDocEditor(el, onFlush)`
  返回 `{ setDoc, getDoc, flush, dispose }`，与 `src/ui/editor.ts` 共用同一套 tiptap 扩展
  （StarterKit + Markdown + Image + Tag），但不带侧栏/属性面板/目标跟踪。
  设定库右侧的正文预览换成它，`onFlush` 回写 `entity.doc`。
  - **切条目必须先 `flush()` 再 `dispose()`**（`render()` 开头统一做），否则未失焦的正文会丢；
    tiptap 实例不销毁会积 window 监听与订阅。
  - 正文自身的提交用 `quiet` 标志跳过整块重渲染 —— 否则每次失焦都会重建编辑器、丢光标位置。
  - 切走工具时 `torn` 标志 + flush + dispose，避免在拆面板的过程中被 store 通知再建一个实例。
- 实测（真实 Electron + CDP）**11/11**：建实体改名 → 11 个字段由公共控件渲染、长文本是 textarea →
  字段值能存 → 正文区有 ProseMirror → **正文失焦后落盘**（`entity.doc`）→ 存的是 Markdown（无 HTML 标签）→
  切走再切回正文回显且未丢 → 切换条目时页面上**只有 1 个编辑器**（不漏实例）→ 切走工具后编辑器已销毁 → 全程无异常。
- ~~**已知限制**：`entity.doc` 目前**只存在 `worldbuilding.json` 里**……~~ → **已解决**：见下面
  「第十六轮」——实体（含正文）现在也写成 vault 的 `.md`（`<世界>/_设定/<类型>/<名字>.md`）。

### 剩下的小步
3. ~~设定库左列加「时间线节点」页签~~ → **已完成，见「第十七轮」**。
4. 工具栏收口：编辑器降级保留（只做纯文稿写作）还是撤掉 —— 用一阵子再定。
   → **2026-09-13 定了：撤掉**（用户：「设定库和编辑器是不是可以做成同一工具的两种不同形式啊
   （在设置里面切换）」→「那就开干吧」）。做法与迁移清单见**第二十一轮十一**。
   （第 3 步之后两边其实已经都能列条目/改字段/写正文了，去留只差 UX 取舍。）
5. 合并后的最终命名（「工作台」？）与布局微调。

## 第十四轮（2026-09-12）· 实体系统第一阶段（设定库）

> 用户在岔路口选了「走 B：实体系统（路线图里的第一优先）」，并定了三件事：
> ① 模板**分开存**（节点种类 vs 实体类型）、面板**统一管**；② 差异帧**存在实体自己身上**（不放到事件节点上）；
> ③ 这一轮只做**第一阶段**：类型/字段可管 + 建实体选类型并补字段 + 档案页（演变留到下一阶段）。

### 新增
- `src/store/entities.ts`：`BUILTIN_ENTITY_TYPES`（角色 11 字段 / 地点 5 / 物品 4 / 组织 4 / 种族 3）、
  `ensureEntityTypes(ws)`（世界还没有任何实体类型时**播种一次**）、`ensureEntityFields(ws)`（按类型补空字段）、
  `entityTypeOf(ws, e)`。默认值与节点侧一致：数值 0 / 开关 false / 列表 `[]` / 其余 `''`。
- `src/ui/codex.ts` + 左栏工具「**设定库**」：类型筛选（带计数）+ 实体列表（按名字排序）+ 档案卡
  （名称/类型可改、字段按类型模板渲染、正文预览、删除带确认）。
  字段提交用 `change`（失焦/回车）—— 面板每次 store 通知会重渲染，用 `input` 会把正在输入的框销毁。
- `src/store/actions.ts`：新增 `removeEntity`；`addEntity` 改为**按类型补全字段**，类型取「传了的且存在 → 否则第一个」。
- `src/ui/schema.ts`：面板拆成「**节点种类** / **实体类型**」两个分区，共用同一套编辑 UI
  （两者数据结构同构 `{ id, name, fields[] }`）。实体类型写入 `worldsets[activeWorld].entityTypes`
  （跟着世界数据走，不需要 IPC）；影响统计按分区分别数节点或实体；切换分区若有未保存改动会先确认。
- `src/ui/editor.ts`：实体页新增**类型下拉**（＋实体按它建）+ 属性区的「**实体类型**」行
  （可换类型，换完派发 `lingkuang-formats-changed` 触发按新类型补字段）。
- `buildPropCtrl(v, onChange, live?, declType?)` 新增第 4 个参数：模板声明的类型优先于「按值的 JS 类型猜」——
  长文本用 textarea、列表即使当前是空值也走勾选列表那一支。

### 顺带修掉
- `addEntity` 旧写法硬编码 `typeId: entity.typeId ?? 'default'`，而 `'default'` 这个类型**根本不存在**
  → 新实体永远挂在一个空类型上、模板永远不生效；且当时 UI 没有任何选类型的入口。
- `EntityTypeField` 带一个**从未被读取**的 `id` → 已去掉，与 `FormatField` 对齐为 `{ name, type }`。
- 实体页的「＋类型」以前直接建一个叫「新类型」的空类型、既不能改名也不能加字段
  → 现在用输入框命名，并提示字段去「结构体管理」的“实体类型”分区加。

### 实测（真实 Electron + CDP）16/16
内建 5 个类型自动播种（角色 11 字段）→ 结构体管理「实体类型」分区列出 5 个类型与字段行 →
给角色加字段「所属势力」并落盘 → 设定库建实体（类型=角色、按模板补出 12 个字段）→ 改名 →
填文本字段 → 填列表字段拆成 2 项数组 → 按类型筛选（角色 1 条、地点 0 条）→
编辑器实体页有类型下拉、「实体类型」行=角色、属性区列出模板字段 → 删除（带确认弹层）→
全程无未捕获异常。tsc --noEmit 0；node --check main.js 0；vite build 0。

### 下一阶段（未做）
- **差异帧 / 角色演变**（用户钦点的差异化卖点）：`EntityLayer`（`since`/`until`/`note`/`values`）类型已定义、
  `Entity.layers` 字段已加，还差：编辑差异帧的 UI、「此刻的样子」的物化函数（初稿 + `since <= t` 的帧叠加）、
  与时间指针联动。
- 实体互链（角色住哪 / 属于哪个组织 / 持有何物）、物品持有链、关系网 —— 都复用 `layers` 模型。

## 第十三轮（2026-09-12）· 数据管理系统（「结构体管理」）

> 用户指令：「开始做数据管理系统，我这里的数据就像抽象或者接口一样，自带一套模版然后自己设定内容」。
> 落实为：**种类=模板/接口**（定义有哪些字段）→ **节点=实现**（填字段的值）。
> 决策（用户三选一，均取推荐）：面板名叫「结构体管理」；字段类型 = 短文本/长文本/数值/开关/**列表**；
> 删字段＝**连带清掉已填的值**（删前二次确认并报出会影响几个节点）。

### 新增
- `src/ui/schema.ts`：结构体管理面板（左侧种类列表带「N 字段 · M 节点」，右侧字段编辑：
  改名/改类型/上下移/删除，＋新建种类、＋添加字段、保存模板、放弃改动）。
  保存链路：校验（空名、重名）→ 影响统计（新增几字段、删几个字段会清掉几处值）→ 需要时二次确认
  → `formats:save` 写盘 → `store.update(d => d.formats = …)`（`{undo:false, keepRedo:true}`，模板不是节点数据）
  → 派发 `lingkuang-formats-changed` → `src/main.ts` 的 `ensureAllFormatFields` 补空值/清多余字段并落盘。
- `src/tools/register.ts`：注册工具 `{id:'schema', name:'结构体管理'}`（`open` 返回清理函数，面板有提示定时器）。
- **给节点指定种类**（此前完全没有入口，见下）：＋节点窗口新增「种类」下拉（`src/ui/node-form.ts`，
  选项含每种多少字段，默认「事件」）；编辑器属性面板新增「种类」行（`src/ui/editor.ts`，`saveFixed({种类})`）。
- `src/store/types.ts`：新增 `export type FieldType = 'text'|'longtext'|'number'|'boolean'|'list'`，
  `FormatField.type` 与 `EntityTypeField.type` 都改用它。
- 列表字段此前**只能勾掉已有项、无法新增**（`buildPropCtrl` 的数组分支）：新增项输入框 + 新增后
  就地补一行勾选项（面板刻意不整块重渲染，不能靠 re-render 显示）。

### 顺带修掉的真 bug
- **① 内建 5 个种类删不掉**（`main.js` 的 `loadFormatsRaw`）：旧实现是「内建 kind + 用户浅合并」
  （`merged[k] = { ...v, ...parsed[k] }`）→ 在面板里删掉「角色」，下次读又被兜回来。
  修：**有 `formats.json` 就以它为准**（只做字段级规整：过滤空字段名、类型不认识退回 `text`），
  没有才回退内建默认。`formats.json` 本来就是整份写出的，不需要兜底合并。
  （实测用户真实目录里没有 `formats.json`，所以这个改动零迁移风险。）
- **② 重扫期间落下的改动会被磁盘旧内容盖回**（`src/main.ts` 的 vault 重扫）：`vaultScan()` 是异步的，
  扫描窗口内发生的 store 改动会在扫描结果 `d.worldsets = …` 整体替换时被回滚。
  实测：在结构体管理里删掉一个模板字段（内存里已清掉该值）时，若恰好有一次重扫在飞，
  那个值会「复活」。修：拿到扫描结果后 `if (pendingWrite) return;` —— 本轮结果已过时，下个变化事件再来。
  这条对**任何编辑**都成立，不只是删字段。
- **测试后门**：`FORMATS_FILE` 现在跟随 `LINGKUANG_TEST_DATA`（放同一个临时目录），
  否则跑自动化测试会写进真实的 `%APPDATA%\lingkuang\formats.json`、改掉用户自己的模板。

### 实测（真实 Electron + CDP）19/19
内建 5 个种类与字段数 → 角色模板 6 字段类型正确 → 加「职业」字段且「保存模板」随之可点 →
`formats.json` 落盘 → ＋节点下拉含全部种类 → 建节点 `kind=角色`、`.md` 落在 `…/角色/测试角色.md`、
属性按模板补空值（含新增的 职业）→ 编辑器出现「种类」行=角色、属性区渲染角色字段 →
给「职业」填「法师」→ 删该字段时确认弹层写出「这个种类下有 1 个节点填过这个字段」→
保存时再确认一次「删除 1 个字段，其中 1 处已填的值会被清掉」→ `formats.json` 与节点上的值都被清掉、
属性面板里那一行也消失 → 新建种类「魔法体系」落盘并出现在＋节点下拉 → 全程无未捕获异常。
tsc --noEmit 0；node --check main.js 0；vite build 0。

### 紧接着补齐：详情面板直接显示/编辑模板字段（同一功能的下半截）
- 问题：模板系统做完后，**字段值只能在左栏编辑器的属性区填** —— 从沙盘点一个节点看到的是
  时间/类型/描述/正文/因果，看不到它的结构化字段，想填「发色、性格」要绕好几步。
- 修（`src/ui/detail.ts`）：详情面板新增
  ① 种类标签（类型标签旁边，如「角色」）；
  ② 「**N · 模板字段**」区，按 `store.data.formats[kind].fields` 渲染，控件形态跟字段类型走
  （短文本 input / 长文本 textarea / 数值 number / 开关 checkbox / 列表用「、」分隔的 input）；
  ③ 写回同一份 `node.properties`（走 `patch()` → `store.update`，可撤销）。
  没有模板的种类（或模板无字段）不渲染这一块；切换模板后重开面板自动跟随。
- ⚠️ 关键实现约束：详情面板**每次 store 通知就整块重渲染**，所以控件只在 `change`（失焦/回车）时提交 ——
  用 `input` 边打边存会触发重渲染、把正在输入的框销毁。
- 实测（真实 Electron + CDP）**12/12**：给角色模板加一个列表字段「别名」→ 建角色节点（属性含默认
  `别名: []`）→ 点节点出现种类标签与 7 个字段行、控件类型正确（身高 number / 性格 textarea / 别名 text）→
  填 发色=银白 / 身高=172（**存成 number 而不是字符串**）/ 别名=`银发、白塔之主, 旧王`
  （**拆成 3 项数组**）→ 重新打开面板能回显 → 事件节点仍显示 起因/影响 → 全程无未捕获异常。

## 第十二轮已修复（2026-09-12）· 年表跨度限幅 + 编辑器时间控件

### ① 年表跨度限幅（补完第十一轮没修完的那条）
- `buildYearTable(cal, min, max)` 新增 `export const YEAR_TABLE_MAX_SPAN = 20000`：跨度超限时把窗口收窄到
  `[min, min + 20000 - 1]`。理由：表只是**加速** —— 查不到时 `yearStart` 走闭式公式仍是 O(1)、结果完全一致，
  所以宁可收窄也不能按跨度分配。顺带 `if (max < min) max = min`。
- 实测：跨度 1e5 / 1e6 / 1e7 / 1e8 / 2^32 → **一律 20000 项、约 0.3ms**（修复前 1e7 = 41.9ms/76MB、
  ≥ 2^32 直接抛 RangeError）；限幅表在**窗口内外**与无表结果逐点一致。

### ② 编辑器的时间 scrub（用户点名要修的那件）
> 原来的毛病（子代理审计 + 自己复现）：`onCommit` 只拼「年/月/日」交给 `parseTimeText` → 判成「日」精度
> → 把 `hour/minute/second` 清空，而同一个 patch 里随后的 `精度` 键又把 `precision` 覆盖回旧值
> → 「精度写着 minute、数据里没有分」；反向「精度=年」的节点拖一格会**凭空长出**月/日
> （`312年` → frontmatter `312-01-02`，详情面板跟着显示「312年1月2日」）；显示函数 `fmtYearDisplay`
> 只到「时」、完全不看精度。注释写的是「反推存完整时间」，与实现不符。
- 修法（`src/ui/editor.ts`）：
  - 新增 `stepTarget(steps)`：按**步数**在历法上推进（年 → 年份 +steps；月 → 年月按 12 进位；
    日/时/分/秒 → 秒上直接加）。旧写法拿 365.2425 天当「一年」，碰上 366 天的闰年（**312 年正是**）
    **连一格都推不动** —— 年份纹丝不动。这也正是项目约定：日/月档要按真实日期推进，不能固定步长累加。
  - 新增 `fmtPrec`：显示与写回都只到**节点精度那一级**，`format` / `inputValue` / `onCommit` 全走
    `fmtByValue = (n) => fmtPrec(stepTarget(round((n - epoch) / stepSec)))` —— 保证「屏幕上的字」
    与「存进去的值」永远一致。「312年」不再显示成「312年1月1日」，拖一格也不动不该有的字段。
  - `saveFixed` 的 `精度` 分支补上「补/清 month/day/hour/minute/second」，规则与 `src/ui/detail.ts` 一致
    （旧实现只写 `o.precision`，于是选「年」也会留着上次的月/日）。
  - 删掉 `fmtYearDisplay`（不看精度、只到「时」）；三处换算（`toEpoch`/`fromEpoch`）补传年表（契约要求）。
- 附带修掉控件本身的老毛病：`createScrubField` **不记自己的当前值**，滚轮每次都从**初始值**算起
  → 「滚第二格没反应」。现在用局部 `let value` 累加（属性面板里所有数值/日期 scrub 都受益）。
- 实测（真实 Electron + CDP）**17/17**：
  年精度节点显示「312年」→ 滚一格 `year=313`、frontmatter `year: 313`、**没有凭空长出月/日**
  → 滚第二格 `year=314`（累加生效）；
  分精度节点显示「312年7月15日9时30分」→ 滚一格 `minute 30→31`，时/月/日都在、frontmatter `312-07-15 09:31`；
  精度下拉 分→日 清掉时分、年→分 补默认值（1/1、0/0）、分→年 清空且 frontmatter 回到 `year: 314`。
- 教训：`let` 声明顺序写错（`label.textContent = cfg.format(value)` 之后才 `let value`）会让**整个编辑器
  工具启动即抛** `ReferenceError: Cannot access 'r' before initialization`（打包后变量被压缩成 `r`），
  面板全空。`npx tsc --noEmit` 直接报 TS2448/TS2454 抓到了 —— 改完必须跑类型检查。

### ③ 剧情线段删除不落盘（子代理顺带确证，历法范围外）
- `src/ui/timeline.ts` 段面板的「✕」原来是 `line.segments.splice(si, 1)`，而 `line` 来自 `timeline()`
  = `store.data` 里的**活引用** → 直接 splice 既不通知订阅者（不落盘）也不进撤销栈
  → 重启后这段「复活」、Ctrl+Z 也回不来（`src/store/actions.ts` 的注释早已写明这个坑，此处漏改）。
- 修法：改走 `store.update`，按 `activeTimelineId()` 在 `d.worldsets[...]` 里重新找到该剧情线再 splice。

### 仍**未修**（待用户决定）
- **frontmatter 读入侧零校验**（子代理 P2）：`main.js` 的 `dateStrToYear` 正则只限位数不限范围，
  于是外部写进来的 `year: 312-13-01` 被照单全收 —— `fnDaysInMonth` 对 `month > 12` 返回 0，
  而 `toEpoch` 的月份是「前 N-1 个月天数之和」→ **13 月等于多过一整年**，节点被画到 313-01-01，
  面板却按原始字段显示「312年13月1日」；`year: 312-07-45` 同理落到 8 月。
  而同一串粘进「＋节点」表单会被 `parseTimeText` 拒掉 —— 两套实现判定不一致。
- **小数年被静默截断**（P3）：`main.js` 的 `Math.floor(+year + 1e-9)` 会把 `year: 312.5` 落盘成 `312`
  （183 天消失），`-312.5` → `-313`（倒跳一年）。当前 `F:\lingkuang-vault` 里 7 个节点年份全是整数，
  属**潜伏**而非正在发生。
- 注释与现实不符（一行记档）：`src/calendar.ts` 的 `defaultCalendar()` 注释写「360 天 / 12 月 / 每月 30 天」、
  `src/store/types.ts` 写「空则默认 360 天制」，而实际返回的是 `fn: 'gregorian'`（365/366 天）。

## 第十一轮已修复（2026-09-12）· 历法内核（`src/calendar.ts`）

> 用户问「我们的日历系统还有 bug 吗」。做法：`src/calendar.ts` **自包含、零 import**，
> 所以把它**单独编译成 JS 直接在 Node 里跑**（`npx tsc src/calendar.ts --ignoreConfig ...`），
> 对内核做穷举与性能实测，不必起 Electron。所有数字都是实测值。

### ① `toEpoch` 丢掉「秒」→ 与 `fromEpoch` 不是严格互逆（而文档声称互逆）
- `toEpoch` 原来只累加 `hour * hourSec + minute * cal.unit.minute`，**没有加 `second`**；
  而 `fromEpoch` 会算出 `second` 并写进 `TimePoint`。
- 实测：`312-7-15 9:30:45` → epoch → 反推回 `9:30:00`；直接对比
  `toEpoch(9:30:45) === toEpoch(9:30:00)`（差 0 秒，应为 45）。13 条往返用例里 3 条不一致，全是秒。
- 影响：`precision: 'second'` 的节点被摆到最多偏 1 秒的位置（年在坐标轴上是 3.15e7 秒，肉眼无感），
  但**显示**会与数据不一致 —— 编辑器的时间 scrub 用 `fmtYearDisplay` → `fromEpoch`，于是
  「数据里有 45 秒、面板显示 0 秒」。
- 修法：`epoch += hour * hourSec + minute * cal.unit.minute + second;`
- 实测：**13/13 往返恒等**（含 `312-12-31 23:59:59`、`312-6-6 6:6:6`）。

### ② 年表构建与无表换算都是 O(|year|) → 年份多敲几个数字就冻界面

> ⚠️ **同一轮内的更正**：这一条**当时没修完**。下面只换了「min 年起点」的算法，而 `buildYearTable`
> **按 `max - min` 分配数组并逐年后推**那段原样保留，`fitAll` 传的又正是「节点年份最小到最大」的
> **整段跨度**（`src/ui/timeline.ts` 的 `setYearTable(yLo - 50, yHi + 50)`）。当时的性能用例是
> `buildYearTable(cal, huge, huge + 100)` —— 只有 100 年宽，形状不对，所以漏了。
> 实测宽跨度（2026-09-12 补测）：1e6 跨度 4.3ms/7MB、1e7 跨度 **41.9ms/76MB**（线性）、
> 跨度 ≥ 2^32 抛 `RangeError: Invalid array length`（在 rAF 回调里抛 → fit 视图永久失效）。
> **已在「第十二轮」按 `YEAR_TABLE_MAX_SPAN = 20000` 限幅修掉。**

- `buildYearTable` 算 min 年起点、`yearStart` 的回退分支、`fromEpoch` 的回退分支
  原来一律「从 0 年逐年累加 / 扣减」。
- 实测斜率（默认公历）：年表构建 1e6 年 11ms → 1e7 年 119ms → 按同斜率 **1e10 年约 2 分钟**；
  `fromEpoch`（表外）1e7 年 15ms → 1e10 年约 15 秒。
- **可达路径**：`parseTimeText` 对年份**没有任何上限**（`nums[0]` 取任意整数），
  在「＋节点」的时间框里多敲几个 0 → `fitAll()` → `setYearTable(yLo-50, yHi+50)` → 直接冻住。
- 修法：
  - 新增 `daysBeforeYear(cal, year)`：function 模式走**闭式公式** —— 公历用 floor 除法
    `⌊(y+3)/4⌋ − ⌊(y+99)/100⌋ + ⌊(y+399)/400⌋`（0 年是 400 的倍数所以算作闰年，与 `daysInYear` 一致），
    负数年利用「闰年集合关于 0 对称」折算；fixed365/360 直接乘。table 模式仍逐年累加（列表历法天然 O(n)）。
  - `buildYearTable` 的 min 年起点、`yearStart` 的回退分支改用 `daysBeforeYear` → O(1)。
  - `fromEpoch` 回退路径改为「用**平均年宽**（新增 `avgDaysInYear`，公历 365.2425）估一个年 →
    按差值跳年迭代收敛 → ±1 精调」。原先拿 `daysInYear(0)`（366）当均值会偏 0.2%，
    在 1e10 年上放大成几千万年的误差，±1 逼近仍是 O(误差)（实测 348ms）。
  - 顺带给 `fromEpoch` 的逐月扣减加 `w <= 0` 保护：月长取不到值时旧写法 `rem >= 0` 恒真 → 死循环。
- 实测（修复后）：年表构建 1e10 年 **0.01ms**、`toEpoch` 0.00ms、
  `fromEpoch`（表外、1e10 年）**0.00ms**；负年份同样 0.01ms。
- **正确性证明**（不是只测快）：闭式公式与「逐年累加参考实现」在 **-3000~3000 共 6001 年**
  逐点比对**全部一致**；年表 `starts` 4001 项与参考一致；有表/无表 32 组换算完全一致。

### 已核对、**无 bug** 的部分（避免重复排查）
- 闰年规则：312 年 366 天、1900 年 365 天（百年不闰）、2000 年 366 天（400 年闰）✓
- 大小月与跨年：`312-02-28 +1天 = 02-29`、`02-29 +1天 = 03-01`、`11-30 +1天 = 12-01`、
  `12-31 +1天 = 313-01-01` ✓
- 负年份与 0 年：`-800-01-01`、`-1-12-31 12:00`、`0-01-01` 往返全对 ✓
- `width()` 只在 table 模式内部被调用，没有外部调用点（默认历法 `layers: []` 时返回 0 不影响任何路径）✓
- `variantOf` / `layerValues` 选变体用的年份与 `daysInMonth` / `daysInYear` 一致 ✓
- 时间轴调用点（`src/ui/timeline.ts`）**全部**传了 `getYearTable()` ✓

### 相邻发现（属编辑器面板，**未修**，待用户决定）
- `src/ui/editor.ts` 的时间 scrub（`createScrubField`）：
  `fmtYearDisplay` 只显示到「时」（丢 分/秒）；`onCommit` 只拼「年/月/日」再交给 `parseTimeText`
  → 判成「日」精度 → **把节点的 时/分/秒 清空**，而同时又用旧值覆盖 `精度` 字段
  → 出现「精度写着 minute、数据里没有分」的矛盾态。注释写的是「反推存完整时间」，与实现不符。
- `src/ui/editor.ts` 的 `fmtYearDisplay(epoch, c)`、`toEpoch(...)`、`fromEpoch(c, n)` 三处**没传年表**
  （`timeline.ts` 全部传了）→ 年份大时每次重绘都是 O(年)。内核修好后这条已不致命。

### ★ 更大的缺口（不是 bug，是功能没入口）
- **历法系统没有 UI**：全仓 grep `calendar` 的写入点，只有 `src/main.ts:61` 的「vault 回扫时保留 JSON 里
  已有的 calendar」，**`src/ui/` 里没有任何代码能创建 / 修改 / 切换历法**。
  也就是说 `layers` / `variants` / `switches` / `mode:'table'` / `Epoch`（年号）这一整套数据层能力，
  用户手上的唯一可达历法就是默认公历（格里高利）。ROADMAP P2 的「自定义历法/纪年」还没接 UI。

## 第十轮已修复（2026-09-12）· 节点面板的时间精度选择（补回 legacy 功能）

> 用户问「节点面板的时间精度选择是不是不见了」。查证结论：**不是本轮改丢的** ——
> `git log -S '精度' -- src/ui/detail.ts` 零命中，v3 的节点详情面板**从来没有过**精度选择；
> 是 v3 重写时没搬过来（老灵框有）。

- legacy 的做法（`lingkuang.js:1971-2041`）：`#d-year` 年份输入 + `#d-precision` 精度下拉 +
  `#d-month`/`#d-day`/`#d-hour`/`#d-minute` **按档位显示**（`updateTimeFields()`：precision≠year 才显示月，
  day/hour/minute 才显示日…），改精度后重排节点位置。
- v3 原来的替代：点「时间」直接打字，`parseTimeText` 从文字里推断精度（`312`→年、`312年7月`→月精度）。
  功能上做得到，但「选一档」这个动作没了 —— 这正是用户觉得「不见了」的东西。
- 补回（`src/ui/detail.ts`）：标题旁（类型标签下方）新增一行「精度」下拉，六个选项全中文。
  **只加下拉，不做 legacy 那种「按档位出现 月/日/时/分 输入框」的部件框** ——
  用户 2026-09-12 明确：「其实不用老版本的，回滚，加个下拉选项就行了」。
  月日时分秒仍然通过点「时间」直接打字来填（`parseTimeText`），两者共存：
  打字改了精度之后重渲染会让下拉自动跟随。
  - 改细（如「年」→「日」）：缺的部件补默认值（月/日 → 1，时/分/秒 → 0）。
    不补的话 `precision` 是「日」而 `month/day` 为空 —— 落盘只写年份、面板也只显示「312年」，
    档位等于没生效。
  - 改粗（如「日」→「年」）：更细的部件**清成 `undefined`** —— `main.js:38-60` 的 `yearToDateStr`
    是「有才写」（`hasMonth = n.month !== undefined && n.month !== null`），清掉才真的只写年份；
    否则详情面板又会把「312年」显示成「312年1月1日」（第二轮修过的老 bug）。
- 顺带：`src/store/types.ts` 导出 `PRECISION_LABELS`（年/月/日/时/分/秒）与 `PRECISION_ORDER`；
  `src/ui/editor.ts` 的精度下拉原来直接显示 `year/month/day/...`（全中文界面里的英文），改用中文标签；
  `src/ui/node-form.ts` 里那份重复的中文映射也改成用共享常量。
- 实测（真实 Electron + CDP）**11/11**：下拉默认「年」→ 选「日」**不出现任何部件框**
  （`#d-parts` 与 `input[data-part]` 均不存在），数据补成 `month/day = 1/1`、时间文字「312年1月1日」、
  frontmatter `year: 312-01-01` → 点时间打字「312年7月15日」后数据 `7/15`、下拉仍显示「日」、
  frontmatter `year: 312-07-15` → 选「分」仍无部件框、时间补成「312年7月15日0时0分」 →
  ★改回「年」后 `month/day/hour/minute` 清空、显示回「312年」、**frontmatter 回到 `year: 312`**。
- 备注：详情面板的时间文字优先取正文里的 `#时间：` 字段行（`parseDoc` 的 `timeText`）。
  实测用户现有数据里**没有任何节点**带该字段行（0 命中），所以这条优先级不会造成困扰，未改动。

## 第九轮已修复（2026-09-12）· 重做分支的作废规则

> 用户实测反馈：「假设我现在从状态2撤回为状态1，在状态1进行修改后还能返回状态2」
> —— 撤销之后又改了东西，Ctrl+Y 仍能跳回后面那个状态，把刚做的修改悄悄吃掉。

- 根因：`src/store/store.ts` 的 `update()` **只在推撤销快照时**清空 `redoStack`
  （原写法 `if (opts?.undo !== false) { undoStack.push(clone(data)); …; redoStack.length = 0; }`）。
  于是所有 `{undo:false}` 的写入口**改了数据却不清重做栈**：
  `src/store/actions.ts` 的 `setTimeCursor`（移动时间指针）与 `applyTrashRestore`（回收站恢复）。
  而内容类修改（改标题 / 改正文 / 拖动改年份 / 新建节点）走的是默认 `update`，本来就是对的
  —— 这也是为什么只靠读代码不容易发现：出问题的是那两个「不算一步」的写入口。
- 修法：把清空重做栈从「推快照」里拆出来，改成**任何用户造成的持久化改动都作废重做分支**；
  新增 `keepRedo?: boolean`，只给**应用自己的记账**用（不是用户编辑）：
  `src/main.ts` 的 vault 重扫 / 格式字段补全 / formats 载入 / 外部改动自动修复、
  `src/ui/map.ts` 挂载时建默认地图、`src/ui/timeline.ts` 拖动中间的逐帧帧
  （`saveNodeDoc` 的 opts 同步加了 `keepRedo`）。
- ⚠️ **vault 重扫必须豁免**，否则撤销/重做自己触发的 `.md` 写盘会在 400ms 后把重做栈清掉，
  「重做」就永远按不出来。这是本轮最关键的回归点，已单独断言（见下 ①）。
- 语义选择：移动时间指针**故意不豁免** —— 它是「这个世界此刻的时间」（`ws.timeCursor`，会落盘），
  不是滚动位置，所以移动它算一次改动、作废重做分支（↷ 按钮立刻变灰，看得见）。
  若希望「移动指针不影响重做」，给 `src/store/actions.ts` 的 `setTimeCursor` 加 `keepRedo: true` 即可。
- 实测（真实 Electron + CDP）**10/10**：
  ① 撤销 → 立刻 Ctrl+Y **仍能**回到状态2（重扫没有清掉重做栈）；
  ② 撤销 → 改标题 → ↷ 失效，且这次修改被保留（没有被重做吃掉）；
  ③ 撤销 → 移动时间指针 → `#lk-redo` 立刻 `disabled`，Ctrl+Y 不再复活旧状态。
  另 **9/9** 回归：改标题 / 拖动改年份 / 改正文 / 新建节点 四种修改之后，Ctrl+Y 均不复活旧状态。

## 第八轮已修复（2026-09-12）· 两处可见改动（用户点头后做）

> 这两条会改变用户能看到的画面，按此前口径必须先确认；用户 2026-09-12 选择「两个都做」。

### 非线性视图：改成「与线性同排版 + 等距」（按用户澄清的目的重做）
- 位置：`src/ui/timeline.ts` 的 `renderNonlinear`。
- 上一版（同日的 commit `30537bd`）按本文档原来写的「类型泳道」实现：按 `world_event` /
  `story_event` 分成两行。**用户澄清目的后推翻**——原话：
  「其实非线性不需要泳道，就和线性模式一样排版就行，只要等距就行了，
  非线性的作用是为了方便看清节点的时间顺序（排除时间干扰）」。
  分行恰恰违背目的：同一条时间线上的先后关系被拆到两行里，反而看不出顺序。
- 修法（最终版）：
  ① **单行**：不再分行，节点一律落在轴线上（沿用 CSS `.tl__n{top:50%}`，与线性完全一致），
     `.tl-line` 轴线保留；`nodeHtml` 恢复三参数（上一版为分行而加的 `top?` 已删除）；
  ② **按时间排序再等距**：`const ordered = nodes.slice().sort((a, b) => nodeEpoch(a) - nodeEpoch(b))`
    —— `tl.nodes` 的数组顺序**不是时间序**（vault 是节点的源，重扫后是目录/文件顺序），
     照原样排会得到 `330→420→450→312→500` 这种乱序，等于把这个功能废掉；
  ③ 每个节点自带年份标签，放在**名字的对侧**（世界事件名字在下方 → 年份在上
     `calc(50% - 19px)`；剧情事件名字在上方 → 年份在下 `calc(50% + 14px)`），两边都不打架；
  ④ **顶部标尺与时间指针在该模式隐藏**：标尺按时间画刻度、而这里 x 是序列序，刻度与节点对不上，
     标尺正是这个模式要排除的「时间干扰」（`scaleEl.innerHTML = ''`），
     指针横坐标同理（`cursorEl.style.display = 'none'`，写在 `renderNonlinear` 里），
     但「已发生/未发生」的淡化仍在 `updateCursor` 里按时间算。
- 实测（真实 Electron + CDP，量 `getBoundingClientRect`）：5 个节点全部 `cy=140.5` = 轨道半高 `281/2`
  （**单行**），相邻间距恒为 `143.2`（**等距**），年份从左到右 `312/330/420/450/500`（**单调不减 = 时间序**），
  每个年份距自己的圆点 `dx=0`、世界在上 `-14` / 剧情在下 `+19`，轴线 1 条，标尺长度 0，指针 `display:none`。
- **线性视图回归**：标尺回来（长度 6415）、指针回来、无逐节点年份标签、节点仍居中于轴线
  （`cy=140.5`）、剧情名在上 `-25.5` / 世界名在下 `+15.5`。

### ★ 本轮同步踩到并修掉的坑：`nonlinearMode` 暂存死区（真实教训）
- 第一版改法把 `nonlinearMode` 读进了 `updateCursor()`（`cursorEl.style.display = nonlinearMode ? ... `）。
  而 `updateCursor` 是由 `renderScale()` 尾部调用的，`renderScale` 在 `let nonlinearMode` 声明
  **之前**就会被执行 → 启动直接抛
  `ReferenceError: Cannot access 'Z' before initialization`（打包后变量被压缩成 `Z`）。
- 后果不是「界面难看」而是**整排沙盘按钮消失**：`mountTimeline` 在尾部才调 `renderExtraTools()`，
  一抛就中断，`#lk-tools` 里永远空的 —— 「＋循环 / 非线性」两个按钮连创建都没创建
  （实测 `#lk-tools` 子元素数 0）。是 CDP 抓 `Runtime.exceptionThrown` 才定位到的。
- 修法：把隐藏指针的语句移到 `renderNonlinear` 内部（那里 `nonlinearMode` 必定已初始化），
  `updateCursor` 恢复原样。
- 教训：**在「声明位置靠后的 `let`」和「声明位置靠前的函数」之间连引用要格外小心** ——
  函数定义早于变量声明没问题，但调用点若也早于声明就是 TDZ。启动期异常会静默砍掉后面所有初始化。

### ↶ ↷ 没有可用状态
- `store.canUndo()/canRedo()` 是 store 的公开接口，但全仓**零调用点** —— 工具栏两个按钮永远可点，
  撤销栈空时点了静默无反应（用户会觉得「撤销坏了」）。
- 修法：`src/ui/shell.ts` 新增 `syncHistoryButtons(store)`，挂在 store 订阅里
  （放在页签签名早退**之前**，签名没变也要刷）：按状态设 `disabled` + `opacity:.35` + `cursor:default`。
- 实测：启动时两个都禁用（`opacity:0.35`）→ 建节点后 ↶ 可用、↷ 仍禁用 → 撤销一次后 ↷ 变可用
  → 重做后 ↷ 又变禁用。

## 第七轮已修复（2026-09-12）· 撤销功能

> 口径同前：只动底层。全部通过 `tsc --noEmit` / `node --check` / `vite build`；
> 关键项用真实 Electron + CDP 做端到端实测（副屏实例，临时数据 + 临时 vault）。

### ★ 撤销「建节点」被 vault 重扫复活（本轮主犯 · 实测证据）
- 现象：`Ctrl+Z` 撤销掉刚建的节点，节点**消失约 100ms 又回来**，用户感受就是「撤销按了没反应」。
- 实测（每 100ms 采样画布 `.tl__n` 数量）：修复前 `[0,1,1,1,…]`；修复后 `[0,0,0,…]`。
- 根因：节点以 vault 的 `.md` 为**源**（`src/main.ts` 的 `vaultToWorldData` 拿文件重建节点），
  而 `store.undo()` 只改内存。撤销后节点从内存消失、`.md` 却还在 vault 里 → 下一次 vault 重扫
  （我们自己写盘也会触发 watcher，主进程 `main.js` 的 `vault:watch` 防抖 400ms）用文件把它拉了回来。
  重扫前那次「先 flush 待写内容」（`src/main.ts` 的 `for (let i = 0; i < 3 && pendingWrite; i++) await writeAll()`）
  只保证内存里**存在**的节点写进 vault，管不了内存里**已不存在**的节点。
  **撤销栈本身完全正常** —— 这也解释了这个 bug 为什么长期被误判成「撤销实现有问题」。
- 修法：`src/store/actions.ts` 新增 `undoWithVault(store)` / `redoWithVault(store)`：
  撤销/重做前后各取一次「节点索引」（`indexNodes`，键 = 世界名 + 时间线名 + 节点 id），
  **消失的**用 `vaultDelete` 移进 `.trash`、**回来的**用 `vaultWrite` 写回 vault。
  只处理前后差集 —— 外部（Obsidian）新建的文件不在索引里，不会被误删。
  反向也必须做：重做让节点回到内存，但它的 `.md` 已在回收站，不补写就又被重扫抹掉。
- 接线：`src/main.ts` 的 Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y，`src/ui/shell.ts` 的 ↶ ↷ 按钮
  （原来直接调 `store.undo()/redo()`）。

### 拖动节点改时间不可撤销（老条目「已确认原因一」）
- `src/ui/timeline.ts` 的拖动为了跟手，**直接改 `store.data` 里的活引用** `n.year`，
  逐帧再 `saveNodeDoc(..., {undo:false})` 只负责通知 + 落盘；`pointerup` 从不补一次提交
  → 整次拖动永远进不了撤销栈，栈非空时 Ctrl+Z 恢复到更早的克隆，把拖动和上一个无关操作一起回滚
  （用户原话的现象：「撤销一次，两处都变了」）。
- 修法：年份**真的变了**的那一帧先 `store.update(() => {})` 空提交一次，把「拖动前」定格进撤销栈
  （`nodeDragSnapshotted` 保证一次拖动只压一格；微动 2px 往往还是同一年，不留空撤销格）。
  为什么不等到 `pointerup` 再提交：那时数据已经被改过，`store.update` 的快照拍到的就是
  **改后**的状态 → Ctrl+Z 变空操作（`src/ui/map.ts` 曾踩过同一个坑：`save()` 里 `map` 就是 `ws.maps[0]`）。
- 实测：拖动 312 → 547 后，Ctrl+Z 第 1 次年份回到 312，且**标题仍在**（没有连坐上一个操作）。

### 撤销/重做后世界游标悬空
- `activeWorld` / `activeTimeline` 不在快照里。新建世界观 B → 切到 B → Ctrl+Z：
  B 随快照消失，游标仍指向 B → `currentWorld()` 返回兜底空对象 → 界面变成
  「一个没有名字的空世界」、世界页签一个都不高亮（看起来像撤销把数据毁了）。
- 修法：`src/store/store.ts` 新增 `reseatSelection()`，`undo()` / `redo()` 替换 `data` 后
  按 `setActiveWorld` / `setActiveTimeline` 同样的规则重新落位。
- 实测：撤销后页签仍高亮 `测试世界观`，且高亮项确实存在于 `worldsets`。

### 已核实为「无需改」的部分（老条目「其余仍待查」结案）
- 编辑面板内联编辑（标题/描述/正文）、类型下拉、时间块、人物/地点/因果 chips ——
  `src/ui/detail.ts` 的写路径**全部**走 `patch()` → `store.update`，都正常入栈（逐条 grep 确认）。
- redo 栈：`update()` 推快照时清空 `redoStack`、`undo()/redo()` 互相搬运；
  实测「改标题一 → 改标题二 → Ctrl+Z → Ctrl+Z → Ctrl+Y」逐步正确。

### 遗留
> 上面两条「属可见改动」的项用户已点头并做完，见「第八轮已修复（2026-09-12）」。当前无遗留。

## 第六轮已修复（2026-09-12）

### 数据损失 / 崩溃

- [x] **JSON 解析失败时，整个世界观被空数据静默覆盖（启动即丢，无需任何操作）**
  - 位置：`main.js` 的 `data:load` + `src/main.ts:8-33 loadData()`。
  - 旧行为：`data:load` 解析失败只回 `{ok:false}` → `loadData` 静默吞掉（`jsonData = null`）
    → 落到 `emptyData()`，界面显示一个空的「新世界」→ 400ms 防抖自动落盘把**整个文件写成
    空白世界观**。且 `.backup-0/1/2` 三格轮换会在 3 次保存内把最后一份原文件彻底挤掉。
  - **实测复现**（2026-09-12）：造一个截断的 `worldbuilding.json`（296 B，内含「不该丢的节点」）
    启动后**不做任何操作**：
    ```
    启动前  worldbuilding.json            296 B
    启动后  worldbuilding.backup-0.json   296 B   ← 被轮换到这里
            worldbuilding.json            369 B   ← 覆盖成全新空世界
    界面    世界页签 ["新世界","＋"]，画布 0 节点，console 零报错
    ```
    触发场景很常见：写盘途中崩溃/断电、磁盘满、手改文件少个括号——任何一次让文件解析不了
    的情况都会导致下次启动世界消失，且用户完全不知情。
  - 修法：`data:load` 改为「先读文件、再单独 try 解析」。解析失败时先
    `preserveCorruptDataFile()` 把损坏内容**逐字节另存**为
    `<base>.bak-corrupt-YYYYMMDD-HHMMSS.json`（沿用机器上已有 `bak-corrupt` 命名；
    同秒重名自动加 `-2`/`-3` 后缀，绝不覆盖），再 `notifyCorruptData()` 弹**原生对话框**：
    解析错误原因 + 副本完整路径 + 恢复步骤（关掉灵框 → 删掉新的 `worldbuilding.json` →
    把副本改名回去），按钮「打开所在文件夹」（`shell.showItemInFolder`）/「知道了」。
    之后再照常回 `{ok:false, corruptPath}`。
  - 为什么用原生对话框而不是应用内提示：①这种事不该被错过（整世界消失）；
    ②启动时用户停在沙盘，而现有的 `addHint` 提示挂在编辑器面板里，看不见；
    ③`dialog` 本来就已从 electron 导入。
  - 验证：同一份损坏文件重启后 → 生成 `worldbuilding.bak-corrupt-20260912-152124.json`
    （296 B，`copyFileSync` 逐字节拷贝，读回确认「不该丢的节点」在里面）、
    界面照常起来、electron 存活；抓副屏截图确认对话框真的显示，文案与按钮齐全。
  - 顺带修：对话框里的字节数原本用 `raw.length`（JS 字符串长度 = UTF-16 码元数），中文一字只算
    1，把 296 字节的文件报成「264 字节」→ 改用 `Buffer.byteLength(raw, 'utf8')`。

### 备份 / 恢复（补齐 ROADMAP「数据备份/恢复」的另一半）

- [x] **手动导出 / 导入**：`backup:export`（`dialog.showSaveDialog` 选落点，默认文件名带时间戳）/
  `backup:import`（`showOpenDialog`）。导入**先校验是合法 JSON 再动现有文件**，
  否则「导入一个坏文件」会反过来把数据毁掉。
- [x] **备份列表 UI**：新增工具「备份管理」（`src/ui/backup.ts`）。两个受管目标各一节：
  世界观数据 / 角色词库。逐项列出 当前 / 自动轮换 / 损坏存档 / 手动备份 / 恢复前快照 / 出厂词库，
  带时间与大小，可一键恢复；顶部 立即备份 / 导出到文件 / 从文件导入。
- [x] **`character_lib.json`（词库）接入备份**：此前完全裸奔——`lib:save` 直接覆写，
  写坏或误导出一次就再也找不回来（它是用户在联想图里一点点攒出来的）。现在
  `lib:save` 写前轮换 `.backup-0/1/2`，`lib:load` 解析失败时同样先另存 `.bak-corrupt-*`
  再回 `ok:false`（种子词库解析失败没得救，只读、随包）。
- **恢复的闸门（关键，别删）**：恢复要覆盖正在用的数据文件，但内存 store 还是旧数据，
  之后任何一次自动落盘都会把恢复结果盖回去。所以「备份管理」在调用 `backup:restore` 前
  派发 `lingkuang-restore-start`，`src/main.ts` 据此同时禁掉自动落盘与**退出前的
  `beforeunload` flushSync**，然后 `location.reload()` 重新载入。
  `lingkuang-restore-end` 用于失败时恢复常态。
- **语义边界（实测确认，必须让用户知道）**：节点正文存在 vault 的 `.md` 里，
  **节点以文件为准**，不在这份 JSON 中。所以恢复 `worldbuilding.json` 备份**不会**让节点增多或减少
  ——它恢复的是时间线结构 / 循环 / 剧情线 / 地图 / 实体 / 历法 / 世界笔记 / 时间指针。
  面板与确认弹层都写明了这一点（否则用户会以为恢复没生效）。删掉的节点去「回收站」找。
- 顺带修：`src/ui/confirm.ts` 的 `message` / `detail` 用 `textContent` 且没设 `white-space`，
  文案里的 `\n` 会被 HTML 折叠成空格 → 加 `white-space:pre-line`（需要讲清后果的弹层常是多行文案）。

### 实测（本项）

- 世界观数据侧 28 条、词库侧 14 条（stub electron 后 require 真实 `main.js` 直调 handler），
  端到端 15 条（真实 Electron + CDP）：面板渲染、立即备份、恢复确认弹层、
  恢复后重载、**数据文件保持备份内容（闸门有效性）**、恢复前快照含被丢弃内容、
  拒绝目录外路径 / 不存在来源 / 未知 target、坏文件导入被拒且原文件未被动、取消导出与导入。

## 第五轮已修复（2026-08-27 收尾）

> 本轮口径仍为「只动底层，不改用户能看到的界面/交互」的延续——但本轮**是用户点名要的功能**，
> 所以新增了可见入口（回收站面板、新建世界观）。全部通过 `tsc --noEmit`、`node --check`、
> `vite build`；用 stub-electron 的 IPC 测试 42 条 + 真实 Electron/CDP 的 UI 测试 23 条 +
> 扫描回归 9 条共 74 条断言验证。

### 数据损失 / 崩溃

- [x] **删掉时间线里最后一个节点 → 整个世界被扫描结果清掉**
  - 位置：`main.js` 的 `vault:scan`（`if (Object.keys(tls).length) worlds[ws.name] = tls;` +
    `scanWorldDir` 的 `if (nodes.length) tls[tl.name] = nodes;`）。
  - 现象：把一条时间线里的节点全删掉（**目录还在**），扫描结果里连这个世界都不再出现；
    而渲染层 `src/main.ts:317` 是 `d.worldsets = newData.worldsets`（整体替换）⇒
    世界的时间线 / 地图（区域+标记+路径）/ 实体库 / 循环 / 剧情线 / 自定义历法 / docs /
    timeCursor **当场从界面消失**，并被随后的自动落盘写进 `worldbuilding.json`。属数据损失。
  - 根因：把「目录是否存在」和「目录里有没有节点」混为一谈。vault 是源，判存在应看目录。
  - 修法：抽出 `scanTimelineDir(tlDir)` / `scanWorldDir(wsDir)`，**空时间线/空世界也收**
    （`nodes: []`）；`vaultToWorldData`（`src/main.ts:40-79`）本来就能处理空数组。
    「外部真删目录才消失」的语义不变（已验证：真删目录后确实消失，不会被 base 复活）。
  - 附带：`VAULT_RESERVED = new Set(['.trash','assets'])` + `isReservedDir()` ——
    必须挡 `assets`：`main.js` 把编辑器导入的图片放 `VAULT_DIR()/assets`（vault 根），
    过去靠「有节点才收」被顺带跳过，改成「目录即存在」后它就会被当成一个世界观。
  - 验证：扫描回归 9 条（assets 不成世界观 / 空时间线仍列出 / 空世界仍列出 /
    删掉最后一个节点后世界与时间线不消失 / 外部真删目录才消失）。

### 破坏性操作无保护（本轮重点）

- [x] **全仓没有任何删除确认**（`confirm(` 零命中）→ 节点/循环一点就没了，且**没有撤销兜底**
  （拖动改时间不可撤销那条仍在，见下方「时间线」）。
  - 修法：新增 `src/ui/confirm.ts` —— 自建弹层而不是 `window.confirm`，理由有三：
    ① `window.confirm` 无法用 `design-system/tokens.css` 配色；② 它是**同步阻塞**渲染进程的，
    会卡住 tiptap 与时间线的 rAF；③ 破坏性操作需要把后果写清楚（节点数 / 是否进回收站）。
    导出 `confirmDialog(opts): Promise<boolean>` 与 `promptDialog(opts): Promise<string|null>`。
    配色用 `var(--danger)`（tokens 注释「rust, never alarm red」）/ `var(--accent)`，
    默认焦点在「取消」；**纯确认弹层故意不绑回车**（删除最容易被误触），
    `promptDialog` 有输入框所以回车=确认，但走 `isImeEnter()`（`src/ui/keys.ts`）。
  - 接线：`src/ui/timeline.ts`（右键删除节点、`#lp-del` 删除循环）、`src/ui/detail.ts`（`#d-del`）。

- [x] **时间线与世界观在灵框内根本删不掉**
  - 根因：`removeTimeline` 在当前代码里不存在（唯一命中 `lingkuang.js:828`，那是已从 `build.files`
    摘掉的遗留单文件版）。
  - 修法：`src/store/actions.ts` 新增 `removeTimeline(store, tlId)`、`removeWorld(store, wsName)`、
    `addWorld(store, name)`（重名自动加序号）；`src/ui/shell.ts` 加「＋」新建世界观按钮，
    并为世界页签 / 时间线页签加右键菜单（删除项标注影响面，如节点数）。
    **删除最后一个世界时自动补一个空世界**，否则 `activeWorld` 悬空、而灵框内没有别的
    「新建世界」入口会走进死路。

- [x] **`.trash` 是半成品**：删除只是把 `.md` `rename` 进 `VAULT_DIR()/.trash`，而
    `vault:scan` 与 `cleanupStaleVaultFiles` 都显式跳过隐藏目录 ⇒ 灵框内**没有任何地方能读它**，
    所谓「可恢复」只能自己去资源管理器翻。且旧命名 `${Date.now()}-${i}-${basename}` 只留 basename，
    **丢掉了「哪个世界 / 哪条时间线 / 哪个类型文件夹」**，而那正是恢复要用的路径。
  - 修法：`.trash/index.json` 记录每条的原相对路径与元数据（`moveToTrash(relPath, meta)` 保存
    `{id,kind,relPath,trashName,ts,title,world,timeline,nodeId}`）；**平铺文件 + 索引**而不是
    镜像目录结构，为的是兼容机器上可能已存在的旧平铺文件。`pruneTrashIndex()` 会把磁盘上
    已消失的项从索引摘掉（恢复/清空后自愈）。
    新 IPC：`vault:trash-list`（返回 `{entries, orphans}`）、`vault:trash-restore`、
    `vault:trash-purge`（`{names}` 或 `{all:true}`，拒绝 `..` 与路径分隔符）、
    `vault:delete-timeline`、`vault:delete-world`。
  - **恢复必须同时回插 store**（`applyTrashRestore`，按 id 幂等、`{ undo:false }`）：
    只把文件移回 vault 的话界面要等下次扫描才看得到，用户会以为恢复失败。
    原位若有同名文件则加「-恢复<时间戳>」后缀，**不覆盖**。
  - 新增 `src/ui/trash.ts`（注册成工具栏「回收站」）：分「可恢复」与「位置未知（孤儿）」两组，
    支持逐项恢复 / 彻底删除 / 清空回收站（双重确认）/ 刷新。
  - 孤儿恢复的 kind 修正：原逻辑硬编码 `safeName(nodeData.kind || '事件')`，但 `nodeToMd` 的
    frontmatter **不写 kind**（kind 由文件夹名承载，靠 `vault:scan` 用 `sub.name` 回填）⇒
    孤儿会静默落到 `事件/`。改为 `it.nodeKind || nodeData.kind || '事件'`，并由 UI 让用户选格式。

### 其他

- [x] **`src/ui/shell.ts` 的 `renderWorldTabs` 每次通知都无条件重写 innerHTML** →
  拖动节点期间（每帧 `saveNodeDoc`）每帧重建整个世界页签栏并重绑监听。
  修法：模块级 `let worldTabsSig = ''` 签名比对后再重建（与上一轮 `timelineTabsSig` 同法）。

## 第四轮已修复（2026-08-27 深夜）

> 本轮口径同前：**只动底层，不改用户能看到的界面/交互**。全部通过 `tsc --noEmit`、
> `node --check`、`vite build`；关键项用真实 Electron 实例 + CDP 做了端到端验证。

### 数据损失 / 崩溃（本轮重点，全是实测出来的）

- [x] **`src/ui/node-form.ts` 把 epoch 秒的 `timeCursor` 当日历年 → 能把应用卡死**
  - 位置：`renderNodeForm()` 的默认时间预填 + 旧的 `fmtCursorTime(y: number)`。
  - 根因：`world.timeCursor` 存的是 **epoch 秒**（AGENTS.md 关键坑 2；写入侧是
    `timeline.ts:355/388/463` 的 `setTimeCursor(store, xToTime(...))`，读取侧
    `timeline.ts:287` 的指针渲染也按 epoch 处理——`timeline.ts:296` 的注释写明了这一点），
    而 `fmtCursorTime` 按「小数年 + 小数部分推月日」实现 → 预填出 `9862680600` 这种十位整数。
    用户不改直接点「确定」→ `year ≈ 9.8e9` 写进节点并落盘；随后 `timeline.ts:307-313` 的
    `fitAll()` → `setYearTable(yLo - 50, yHi + 50)` → `buildYearTable` 既 `new Array(3e8)`
    又逐年后推 → 卡死 / 撑爆内存。
  - 修法：删掉小数年实现，改用与沙盘指针同一口径的历法换算（`calendarOf(tl)` +
    `buildYearTable` 覆盖节点年份范围 + `fromEpoch`）；逐级只写「有信息」的部分
    （正好落在年初就只给年份，不把精度从「年」悄悄抬到「日」）；年表窗口上限 4000 年。
  - 验证：`timeCursor = 9862680600` → 表单显示 `312年7月15日9时30分`
    （312 是闰年、196 天偏移，与独立手算逐字一致）。

- [x] **`src/store/actions.ts` 的 `addNode` 逐字段白名单静默吃掉 `desc`**
  - 根因：白名单只列 id/title/year/precision/月日时分秒/type/doc，而唯一调用点
    `src/ui/node-form.ts` 一直在传 `desc: desc.value.trim()` → 新建节点的描述永远为空。
  - 修法：改为 `...node` 展开 + 补默认值（`desc`/`tag`/`people`/`places`/`kind`/`causes` 一并恢复）。
  - 验证：端到端建节点后 JSON 里 `desc=E2E DESC`。

- [x] **`src/main.ts` 的 `vaultToWorldData` 每次 vault 回扫都清空地图与实体库**
  - 位置：`src/main.ts:64-70`。
  - 根因：重建 worldset 时只挑 `name/timelines/order/docs/timeCursor`，把 vault 里
    **根本不存在**的字段全丢了：`maps`（地图的区域/标记/路径）、`entities` / `entityTypes`
    （实体库）。而 vault 是源、外部 Obsidian 每改一次就回扫一次，丢完还被写回 JSON
    → 永久丢失（实测：回扫后 `maps` 变成一张新建的空默认地图）。
  - 修法：`{ ...baseWs, name, timelines, order, docs, timeCursor }` —— 先继承整份世界设定，
    再用 vault 结果覆写「以 .md 为源」的部分。
  - 验证：预置 `maps: [mKEEP, regions=1, markers=1]` + `entities: {e1}`，回扫后原样保留。

- [x] **`src/ui/map.ts` 的 `curMap()` 在 `maps` 缺失时抛异常**
  - 位置：旧写法 `const curMap = (): MapData => currentWorld(store).maps![0];`
  - 根因：`maps` 是**可选**字段；撤销/重做与 vault 重载都是整体替换 worldsets，
    替换后的那一帧 `maps` 可能是 `undefined` → `undefined[0]` 抛
    `TypeError: Cannot read properties of undefined (reading '0')`。
  - 修法：返回 `MapData | null`，`renderSvg()` 拿不到就清空这一帧、下次通知再画；
    模板里的 `curMap().name/width/height` 加兜底。顺带给 `map.ts` 的 `mk.label` 补了 `escapeHtml`。

- [x] **一个订阅者抛异常会掐死整条数据链（放大器，本轮真正的元凶）**
  - 链路（CDP 实测）：`map.ts` 抛一次 → 异常穿出 `store.update()` → `src/main.ts:310` 那句
    `suppressWrite = false` 永远不执行 → `suppressWrite` **永久为 true**
    → **此后整个会话不再自动落盘**；同时 `node-form.ts` 的 `submit()` 被中断在
    `host.innerHTML = ''` 之前（表单不清空），新建的节点既不进 vault 也不进 JSON，静默消失。
  - 修法（两处，互为兜底）：
    - `src/store/store.ts`：新增 `notify()`，逐个订阅者 `try/catch` + `console.error`，
      单个视图的渲染 bug 不再中断整轮通知、也不再穿出 `update()`；
    - `src/main.ts`：`suppressWrite = true` 后改用
      `try { store.update(...) } finally { suppressWrite = false }`。
  - 验证：修复后 CDP 抓 `window.onerror` 为空，表单正常清空，新节点 JSON + vault 双写。

### 子代理只读审计（11 个文件）发现的其余条目

- [x] **`src/ui/assoc.ts:354` 用户/LLM 文本未转义**（词条来自工具栏输入框与 LLM 输出，
  局部 `cleanWords` 只校验长度 1-8，`<b>x</b>` 能通过；`"` 还能逃出 `title` 属性）
  → 复用 `src/ui/html.ts` 的 `escapeHtml`。
- [x] **`src/ui/assoc.ts` 拖动无兜底** → 抽 `endPointerGestures()` 统一收尾；注册 `pointercancel`；
  `pointermove` 首行 `e.buttons === 0 && !isRocker` 即复位。
  ⚠️ **`!isRocker` 是必须的**：中键轮盘本来就不按住鼠标用，一律 return 会让它「进入即退出」。
- [x] **`src/ui/assoc.ts` 每次挂载泄漏 3 个 window 监听 + 2 个永不退场的 RAF**
  → `bindEvents()` 返回清理函数、`mountAssocCanvas` 返回清理函数、`inspire.ts` 往上传递、
  `src/tools/register.ts` 的 `open` **return** 这条 promise 链（旧写法没 return，
  `registry.adopt` 永远拿不到清理函数 → 整个 dispose 机制对「灵感触发器」失效）；
  `simRAF`/`rockerRAF` 的 tick 自检 `host.isConnected`；window `pointerup` 仅在
  **非中键**时退出轮盘（字面实现会让中键轮盘进入即退出，属可见行为破坏）。
  - 验证：CDP 连做 3 轮「打开灵感触发器 → 切到设置」，window 监听净增 **0**（修复前每轮 +3）。
- [x] **`src/ui/assoc.ts:55` 的 `wordLib` 从未被填充** → 新增 `fillWordLib(lib)` 从整份词库
  灌入全部分类，写入后 `wordLib.add(w)`。`wordLib.has(w)` 守卫从此可达：**跨分类不再重复写入**，
  `added` 计数不再偏大（对上用户痛点「词库分类混杂」）。
- [x] **`src/ui/shell.ts` 未转义** → 世界名页签的 `data-world` 与文本、时间线页签的 `data-tl`
  与文本都走 `escapeHtml`（名字含 `"` 时属性被截断，`store.setActiveWorld` 判断失败静默 no-op，
  表现是「点了没反应」）。
- [x] **`src/ui/shell.ts` 拖动期间每帧重建整个页签栏** → 新增模块级 `timelineTabsSig`，
  签名只由 `(id, name, count, active)` 决定，没变就跳过 `innerHTML` 重建
  （拖动节点时 `timeline.ts` 每帧 `saveNodeDoc(..., { undo: false })` → 每帧通知）。
  ⚠️ 遗留：`renderWorldTabs` 仍在同一订阅里每次通知重写 innerHTML（本轮按范围未改）。
- [x] **`src/ui/tavern.ts` 闭包捕获一次性快照** → 改成 `tlList()` / `getTimeline(id)` 在使用点
  惰性解析 `currentWorld(store)`（`undo()/redo()` 与 vault 重载都是整体替换 `store.data`，
  构建期抓到的 `ws` 会成孤儿引用，撤销后仍拿旧数据推演）；顺手删掉从未被当输入用的死状态 `history`。
- [x] **6 处 Enter 缺 IME 守卫** → 新增 `src/ui/keys.ts` 的 `isImeEnter(e)`，用在
  `roleplay.ts:76`（最严重：`send()` 还会清空输入框，未上屏内容直接丢）、
  `detail.ts:133` / `detail.ts:206`（保留 `opts.multi` 短路）、`editor.ts:75`、`node-form.ts:191`。
- [x] **`src/ui/node-form.ts` 硬编码历法上限**（`month > 12` / `day > 31` / `hour > 23` …）
  与可编辑历法冲突 → `parseTimeText(text, cal?)` 新增可选历法参数，上限从 `Calendar.layers`
  的 month 层与 `Calendar.unit` 推导。**只放宽不收紧**：不传历法时与原来的公历硬编码完全一致。

### 其他

- [x] **桌面快捷方式指向已删除的旧 checkout**（非代码问题）
  - 现象：`D:\Desktop\灵框.lnk` 的 target 是
    `F:\OpenDesign\.od\projects\lingkuang-v3-ui\node_modules\electron\dist\electron.exe`，
    而该目录已不存在 → 桌面启动的永远是旧版本 / 悬空。
  - 修法：重新指向 `F:\Projects\lingkuang-v3\node_modules\electron\dist\electron.exe`，
    args 与 workdir 都改成 `F:\Projects\lingkuang-v3`。
  - 数据：两个 checkout 的 `package.json` name 同为 `lingkuang`，且 `main.js:13-14` 显式
    `app.setName('lingkuang')` + `app.setPath('userData', appData/lingkuang)`
    → 共用 `%APPDATA%\lingkuang`，**数据无需迁移**。
  - ⚠️ `main.js` 现在加载 `app-dist/index.html`（打包路径）——**改完代码要先 `npx vite build`
    再点桌面图标**。

## 第三轮已修复（2026-08-27 收尾）

> 本轮口径：**只动底层，不改用户能看到的界面/交互**。全部通过 `tsc --noEmit`、
> `node --check`、`vite build`。

- [x] **`src/ui/map.ts` 的 window 指针监听只加不减**
  - 位置：`renderMap()` 里的 `window.addEventListener('pointermove'/'pointerup')`。
  - 根因：每次进入地图工具都重新注册，旧的从不移除 → 进出 N 次就叠 2N 个监听，
    且每个都在对着已废弃的 SVG 跑 `renderSvg()`。
  - 修法：新增模块级 `mapCleanup`，重新进入时先摘掉旧的；store 订阅自退订时一并摘掉。
- [x] **`src/ui/map.ts` 拖动状态无兜底**（与 `timeline.ts` 同类）
  - 根因：`panning`/`drawing` 只在 `pointerup` 里清。丢失那次 pointerup（在窗口外松开、
    指针被系统取消）之后，不按键移动鼠标也会一直平移画布、或一直往区域里加点。
  - 修法：抽出 `endDrag(commit: boolean)` 统一收尾；注册 `pointercancel`；
    `pointermove` 首行判断 `e.buttons === 0` 即就地收尾；`pointerdown` 加 `e.button !== 0` 早退
    （右键/中键不再画区域或拖画布）。区域只在正常 pointerup 落盘，取消则丢弃半成品。
- [x] **vault 重新扫描覆盖尚未写盘的改动（自动保存竞态）**
  - 位置：`src/main.ts` 的 `onVaultChanged` 回调。
  - 根因：watcher 对自己写的文件也会触发；回调在「内存比磁盘新」时仍拿磁盘快照整片替换。
  - 修法：替换前先把待写内容推进 vault——
    `for (let i = 0; i < 3 && pendingWrite; i++) await writeAll();`，
    仍为 true 就放弃这轮（说明正在连续输入），等下个变化事件再重载。
- [x] **外部同步占用撤销格，把 Ctrl+Z 吃掉**
  - 位置：同上回调里的 `store.update((d) => { d.worldsets = newData.worldsets; })`。
  - 根因：该 `update` 用默认 `{ undo: true }`，于是每次外部改动（含自己写盘触发的回环）
    都压进一个整库深拷贝快照，其内容与当前状态看起来一致 → Ctrl+Z 表现为「按了没反应」。
  - 修法：传 `{ undo: false }`——从源同步不是用户编辑。
- [x] **`files` 里的死重**
  - `lingkuang.js`（263.7 KB）与根 `index.html`（vite 源入口）已从 `build.files` 移除。
    二者运行时不加载：`main.js` 全仓只有一处
    `loadFile(path.join(__dirname, 'app-dist', 'index.html'))`；`lingkuang.js` 唯一引用者是
    未被应用加载的 `legacy-index.html`。`index.html` 仍是 vite 的**构建入口**，留在仓库根目录不受影响。
  - 复核过的误报：`design-system/**/*` 同样不被构建引用（`src/style.css` 自带 `:root` 令牌），
    但只有 3 文件 24.4 KB，且是 `AGENTS.md` 指定的颜色来源，**故意保留**。
- [x] **文档与现实不符（3 处）**
  - `EDITOR-ESAY-TODO.md`：文首加显著回退说明（`9926baa` 已把方案2 整体回退、tiptap 现仍在用、
    项目路径更正为 `F:\Projects\lingkuang-v3`），并在第 53 行原处标注该状态已失效。
  - `docs/EDITOR-SANDBOX-BRIDGE.md:59`：`makePropCtrl` → `buildPropCtrl`。
  - `docs/EDITOR-SANDBOX-BRIDGE.md:71`：改写为与实际一致，并把键名字符类的真实后果
    升格成下面那条数据损失条目。

## 第二轮已修复（2026-08-27 下半场）

> 用户口径：「底层优化都可以直接动手，不影响我表面看到的就行」。
> 因此**没有动任何布局/交互设计**；下面第 10 条（标尺月档）与第 8 条（标签高亮）
> 属于「把明显渲染错的修对」，会看到差别，但差别正是原 bug。

- [x] **frontmatter 丢时刻精度**（`main.js` `yearToDateStr`/`dateStrToYear`）
  - 根因：`nodeToMd` 的 meta 只写 `['id','title','year','precision','type']`，而 `year` 只输出
    `YYYY-MM-DD`；`dateStrToYear` 也只回 `{year,month,day}`。`hour/minute/second` 直接丢。
  - 修：`year` 写成 `312-07-15 13:30:05`（有才写），解析侧同步支持 `YYYY[-MM[-DD[ HH[:MM[:SS]]]]]`。
- [x] **year-only 节点往返后凭空多出 month/day**（同上）
  - 根因：旧 `yearToDateStr` 一律补 `-01-01`。`precision:'year'` 的节点读回来变成
    `month:1, day:1`，而 `src/ui/detail.ts:fmtNodeTime` 只看字段有没有，于是详情面板
    的「312年」显示成「312年1月1日」——**这是用户能看见的渲染错**。
  - 修：每级「有才写」；`dateStrToYear` 的正则相应放宽为可选月/日。
- [x] **vault 为源时清空 loops / storylines / calendar**（`src/main.ts` `vaultToWorldData`）
  - 根因：该函数硬编码 `loops: [], storylines: []`、`absOffset: 0`、`docs: {}`、`timeCursor: null`，
    而 `.md` 只存节点，这些字段只存在 JSON 里 → 启用 vault 后建的循环/剧情线**活不过一次重启**；
    自定义历法也一样被丢（等于世界观时间体系被重置）。
  - 修：`loadData` 先读 JSON 当 base，`vaultToWorldData(worlds, base)` 按时间线回填这几个字段；
    vault 监听重载那条路径也把 `store.data` 当 base 传进去。
  - 注意：vault 里**不存在**的时间线一概不复活（否则外部删掉整个文件夹后，旧数据会把整批节点带回来）。
- [x] **删除节点不删 vault .md → 节点复活**（`main.js` 无 `vault:delete`；两处删除各写各的）
  - 根因：`.md` 是「文件为源」，只从 store 删而文件还在 → 下次启动扫回来。
    `src/ui/timeline.ts` 走 `removeNode`，`src/ui/detail.ts` 却自己 `filter` 一遍，绕过了动作层。
  - 修：新增 `vault:delete` IPC（按 id 递归找文件 → 移到 `vault/.trash/`，不真删，留人工恢复），
    preload 补 `vaultDelete`；`removeNode` 成为唯一入口并负责移文件；`detail.ts` 的删除改调 `removeNode`。
  - 配套：`vault:scan` 与 `cleanupStaleVaultFiles` 跳过 `.` 开头的目录，
    否则 `.trash` 会被当成一个世界观列出来。
- [x] **退出时未落盘 → 未保存的编辑丢失**
  - 根因：编辑器只在 tiptap `blur` 提交，`src/main.ts` 落盘是 400ms 防抖；
    `src/` 里没有 `beforeunload`/`visibilitychange`，`main.js` 也没有 `before-quit`/`will-quit`。
    光标还在正文里直接关窗 = 那些字连 store 都没进；即使进了，防抖定时器也随进程消失。
  - 修：主进程加同步通道 `app:flush-sync`（`ipcMain.on` + `e.returnValue`，与 `data:save`/`vault:write`
    共用抽出来的 `writeDataFileSync`/`writeVaultNodeSync`）；preload 暴露 `flushSync`；
    渲染进程 `beforeunload` 里先 `disposeCurrentTool()`（顺带把编辑器未提交内容 flush 进 store，
    因为 editor 的 dispose 会调 `flushDoc`）再同步写盘。加了 `pendingWrite` 脏标记，没改动就不写。
- [x] **编辑器每次点工具栏都泄漏一份实例**
  - 根因：`src/tools/registry.ts` 的 `openTool` 只 `host.innerHTML=''`，而 `renderEditor` 从不销毁：
    tiptap 实例、两个 `window` 监听、一个 `store.subscribe` 全部留下，每进一次编辑器多一份。
    且各工具的 `open` 都是 `import(...).then(...)` 异步的，切快了旧回调还会覆盖新面板。
  - 修：`Tool.open` 允许返回清理函数（或它的 Promise）；registry 记住当前清理函数、
    切走时调用，并用 `openSeq` 丢弃过期回调；`renderEditor` 返回清理函数
    （flush 未提交内容 → 退订 → 摘监听 → `editor.destroy()`）；
    `shell.ts` 的「世界沙盘」分支不走 `openTool`，补调 `disposeCurrentTool()`。
- [x] **`getDocMd` 的 `&nbsp;` 清理会吃掉段落分隔**（`src/ui/editor.ts`）
  - 根因：`/(^|\n)(\s*&nbsp;\s*)+\n?/g` 里的 `\s` 包含换行且贪婪，
    `"A\n\n&nbsp;\n\nB"`（A、B 是两个段落）被压成 `"A\nB"`。
  - 修：只认「整行除 `&nbsp;` 外只有空格/制表符」的占位行，删行保留两侧换行，
    再把 3 个以上连续换行折回两个（空段落本来就是段落分隔符）。
- [x] **外部文本直插 innerHTML**（XSS / 标题里的 `<div>` 会变成真标签）
  - 新增 `src/ui/html.ts` 的 `escapeHtml`（`&` 最先替换；同时转义 `"` 与 `'`）。
  - 接入：`timeline.ts` 8 处（节点标题、剧情线名、循环名、时间线名、option 的 value）、
    `detail.ts` 的标题 + 原局部 `escapeHtml`（后者没转义 `"`，而 `mdRender` 把 `$2` 塞进
    `<a href="$2">`，`[x](a" onmouseover="…)` 能逃出属性）、`map.ts` 2 处、`tavern.ts` 1 处。
  - 复查确认**误报**：`ai-workbench.ts` 的 `${d.name}`/`${d.desc}` 来自硬编码数组，不是用户数据。
- [x] **`tag-ext` 正则被回溯绕过 → `#正文：` 被高亮成 `#正`**
  - 根因：`/#([^\s#：:]+)(?![:：])/g` 的否定环视可以被回溯绕过：贪婪吃满「正文」→ 环视失败 →
    回退成「正」→ 下一个字符不是冒号 → 匹配成立。
  - 修：类里已排除冒号，改成匹配后检查后一个字符是不是冒号再决定跳过。
- [x] **标尺月档全部塌到同一 epoch**（`src/ui/timeline.ts` 主刻度）
  - 根因：`month: tp0.values.month + i * stepMonths` 会超过 12，`daysInMonth` 对 `>12` 返回 0，
    于是这些刻度的 epoch 都等于年初 → 几十个「1月」标签叠在同一个 x 上。
  - 修：按 1-based 连续月序号拆成 `年 + 月（取模）`。
- [x] **拖动状态丢失 `pointerup` 后卡死**（`src/ui/timeline.ts` 三处拖动 + `map.ts`）
  - 根因：`nodeDragId`/`dragging`/`cursorDrag`/`handleDrag`/`brushDrag` 只在 `pointerup` 里清，
    没有 `pointercancel`，`pointermove` 也不看 `e.buttons`。一次丢失的 pointerup
    （指针取消 / 拖出窗口 / 切窗）就让节点永远跟着鼠标走，而且**每帧把 `n.year` 写回盘**。
  - 修：抽出 `endDrag()`，`pointerup` / `pointercancel` / `window.blur` 都走它；
    三条 `pointermove` 加 `e.buttons === 0` 兜底（笔刷额外撤掉框选高亮）；
    `endDrag` 恢复光标时看 `.lk-eyedrop`，不再一律打回 `default`。
- [x] **拖动热路径漏传年表**（`src/ui/timeline.ts`）
  - `fromEpoch(cal(), e)` → `fromEpoch(cal(), e, getYearTable())`（拖动每帧都调，漏了就 O(年数)）；
    渲染标尺里的 `fromEpoch(cal(), s0)` 同样补上。
- [x] **asar 依赖体积**（打包侧优化，非 bug）
  - 基线：`app.asar` 23.3 MB / 4160 条目，其中 4136 条是 node_modules（99.4%）。
  - 实测只有 `mcp-server.js` 真的需要运行时依赖（`@modelcontextprotocol/sdk` + `zod`），
    `main.js`/`preload.js` 只要 electron 与 node 内置模块，`src/` 里的
    `@tiptap/*`、`markdown-it` 经 vite 打包后不再被 require。
  - 修：把 `@tiptap/core`、`@tiptap/markdown`、`@tiptap/pm`、`@tiptap/starter-kit`、`markdown-it`
    移入 `devDependencies`。生产依赖降到 93 个包 / 14.6 MB（移出约 9.6 MB）。
  - **尚未复验**：重打包时 electron-builder 下载 GitHub 辅助包 `ETIMEDOUT`（网络问题，非项目问题），
    所以「改动后的 asar 体积」还没量到；已单独验证 `mcp-server.js` 的三个 require 仍可解析。

## 本轮已修复（2026-08-27 审计）

- [x] **打包产物永远不含渲染层 → 装完白屏**（致命：打包链路此前从未可用）
  - 根因：`vite.config.ts` 的 `build.outDir` 与 `package.json` 的 `build.directories.output` 都是 `dist`，
    而 electron-builder 会把自己 output 目录从 app files 里强制排除（app-builder-lib `fileMatcher`），
    所以渲染层永远进不了 `app.asar`；`files` 里也没有 `dist`；`npm run dist` 也不跑 `vite build`。
    实测（`electron-builder --dir` 后列 asar）：包内只有 `main.js/preload.js/data/design-system/...`，
    完全没有渲染层 → `main.js` 的 `loadFile(__dirname/dist/index.html)` 必然失败。
  - 修复：vite `outDir` 改为 `app-dist`（与 electron-builder 的 `dist` 彻底分开）、
    `files` 加 `app-dist/**/*`、`dist`/`pack` 脚本先跑 `vite build`、`.gitignore` 加 `app-dist/`。
    重打包实测 asar 内含 `\app-dist\index.html` 及 9 个资源。
  - 附带：旧写法下 `npm start`（`vite build` + `emptyOutDir: true`）会把已打好的安装包一起删掉，现已不会。
  - 已改正 `docs/ROADMAP.md` 里「打包发布」的 `[x]`（此前不可能产出可用安装包）。

- [x] **词库导出写入只读 asar**（`lib:save`）
  - 根因：`LIB_FILE = path.join(__dirname, 'data', 'character_lib.json')`；打包后 `__dirname` 在 `app.asar` 内，
    asar 只读 → 写入失败；同时违反「数据写 `%APPDATA%\lingkuang\`，不写项目目录」。
  - 修复：读优先 `userData/character_lib.json`，缺失时回落随包种子；写一律写 userData。

- [x] **剧情线一建立就卡死**（主线程跑约 10¹⁰ 次循环）
  - 根因：刷选 `brushYearFromVx` 返回 `xToTime()` 的 **epoch 秒**，存进 `segments` 后却被
    `yearEpoch()` 当**年**用 → `toEpoch` 落进 `calendar.ts` 的按年累加回退分支（`for (y=0; y<9.6e9; y++)`）。
  - 修复：刷选结果换算回「年」（`/ SEC_PER_YEAR`），与 `segments` 既有语义、`yearEpoch()`、`inLine()` 一致；
    并给空 `segments` 加保护（`Math.min(...[])` = Infinity 会真·死循环）。

- [x] **剧情线聚焦把全部节点过滤掉（画布恒空）**
  - 根因：`inLine(n.year)` 拿「原始年」比「epoch 秒」恒 false；`storyMode` 写死 `focus` 且无 UI 可切。
  - 修复：与上一条同源，单位统一后自然正确。

- [x] **剧情线建线/擦除不落盘、不进撤销**
  - 根因：直接 push/改 `tl.storylines`（store.data 的活引用），绕过 `store.update` → 不通知、不落盘、不进撤销栈。
  - 修复：改走 `store.update`。

- [x] **`segments` 缺失会让整个沙盘停止刷新**
  - 根因：`linesOf()` 只校验外层 `storylines` 是数组；单条线缺 `segments` 时 `inLine()` 抛 TypeError，
    而 `render()` 每次都会走到那里。
  - 修复：`linesOf()` 统一补 `segments: []`。

- [x] **编辑器往返丢内容（本应用自己写出的 .md 读回来就损坏）**
  - 根因：`main.js` 的 `mdToNode` 是逐行 `#字段：` 解析器，无围栏识别、且空行会终止字段：
    ①正文里的空行（段落分隔）全丢；②正文里出现一行 `#描述：xx` 会被当成真标记 →
    描述被正文顶掉、正文被截断（实测 `doc='前\n#描述：伪装\n后'` → `{desc:'伪装\n后', doc:'前'}`）；
    ③多段 `desc` 只剩第一段；④围栏代码块里的标记文本被吞。
  - 修复：加三条护栏（围栏内不识别标记、已知标记只认第一次、描述/正文内的空行算内容）；顺带统一 CRLF。
    往返测试对比修复前后：旧代码 5/5 失败，新代码 5/5 通过。

- [x] **切 tab 会把实体正文写进节点正文**
  - 根因：`setTab` 只切高亮和侧栏，既不重载文档也不清 `currentNodeId`/`currentEntityId`，
    而 blur 保存按当前 tab 的 id 走 → 「节点 → 实体 tab → 回时间线 tab → 点空白」就把实体正文写进节点。
  - 修复：引入带 `world` 的 `target`（绑定「文档框里装的是谁的内容」），保存一律按 `target`；
    切 tab 先落盘、再按该 tab 上次打开的文档恢复。

- [x] **编辑非活动世界的节点被静默丢弃**（还照样显示「已保存 ✓」）
  - 根因：侧栏遍历所有世界（`dataset.world`），保存侧一律走 `store.activeWorld` → `if (n)` 直接 no-op。
  - 修复：`target` 带 world，`saveNodeDoc` 支持 `opts.world`；属性面板改走 `target`。

- [x] **属性面板改第二项会把第一项改回去**（陈旧闭包）
  - 根因：面板刻意不重渲染，`saveProp({...props, [k]: nv})` 用的是构建时快照；
    数组控件同理（取消勾选 A 后再取消 B，A 复活）。
  - 修复：提交时从 store 取最新 `properties` 再合并；数组控件加 `live` 取值回调。

- [x] **`inspire.ts` 组合存档存不进也读不出**
  - 根因①：`collectCombo()` 选 `.insp-card`，卡片实际是 `.tool-card`（该类全项目不存在）→ 永远存空组合。
  - 根因②：chip 文案恒含 `✕`，删除/加载靠 `textContent.includes('✕')` 判断 → 永远走删除，加载分支不可达。
  - 修复：选择器改 `.tool-card`；「加载」与「删除」拆成两个独立控件。

- [x] **`detail.ts` 陈旧闭包覆盖外部改动 + 订阅泄漏**
  - 根因①：`save()` 把闭包里那个 `node` 的**所有字段**整体拷回 store；外部（Obsidian / vault 重载）
    替换 `worldsets` 后该引用已成孤儿 → 编辑一处、别处悄悄回滚，旧值还会写回 vault。
  - 根因②：订阅只在 `!host.isConnected` 时退订，而 `#lk-tool-host` 永不卸载 →
    每点一个节点多一个永久订阅（持有陈旧闭包），切到别的工具后还会覆盖别人的面板。
  - 修复：改用 `patch(fn)` 直接改 store 里的最新节点（读值走 `latest()`）；
    订阅改为模块级单例，并在 `#d-view` 消失（面板被接管）时自行退订。

- [x] **`map.ts` 撤销对地图完全无效 + 清空标记不落盘 + 平移瞬移**
  - 根因①：`save()` 是 `ws2.maps[0] = map`，而 `map` 就是 `ws.maps[0]`；调用方先直接改 `map`
    再 `store.update` → 撤销快照里已经含着这次改动。
  - 根因②：「清空标记」只改内存 + 重绘，不调 `save()` → 不通知、不落盘，关窗即丢。
  - 根因③：平移用 `getBoundingClientRect()`（视口坐标）当基准，却赋给 `style.left`（相对 offsetParent）
    → 第一帧瞬移一个容器偏移量。
  - 修复：`save(mutate)` 把改动放进 `store.update` 内执行；清空标记走 `save()`；平移基准改用当前
    inline `style.left/top`；顺带不再缓存 `map` 引用（undo 会整片替换 data）。

- [x] **时间线上右键轻微拖动会静默改年份**
  - 根因：`pointerdown` 无 `e.button` 判断，右键按住节点横移 >2px 就逐帧重写 `n.year` 并落盘。
  - 修复：`if (e.button !== 0) return;`。

- [x] **非线性视图残留因果箭头**
  - 根因：非线性分支 `return` 前不调 `drawCauses()`，箭头留在上一帧线性布局的位置。
  - 修复：非线性分支补 `drawCauses()`。

- [x] **笔刷按钮在界面上不存在**
  - 根因：`renderStoryUI` 注册了 `#lk-brush` 的监听，但 HTML 从没产出该按钮 → 只能靠右键菜单进笔刷。
  - 修复：补上「笔刷」按钮（含激活态高亮）。

- [x] **文件名带空格的图片会退化成文本并丢失**
  - 根因：导入图片只过滤 `\/:*?"<>|` 不过滤空格，markdown 输出也不转义；
    CommonMark/marked 在空白处截断目标 → `![](assets/my pic.png)` 被解析成普通文本，
    下次 `setContent` 时图片变成字面文本（Windows 截图名常带空格）。
  - 修复：`image-ext.renderMarkdown` 对目标做 `encodeURI`；导入时把空白替换为 `_`。
    marked 实测：未转义 3/3 退化为 text，转义后全部解析为 image。

## 时间线

- [ ] **剧情线聚焦遮罩：固定在摄像机 + 透明度**（2026-08-21）
  - 现象：①遮罩位置不随时间线滚动（glide 惯性平移路径没触发 updateRangeMask）②灰色遮罩叠加使时间线变深（已临时调低透明度至 0.20）。
  - 决定：与 UI 总设计一起修（用户明确后置）；透明度可调控件也归入 UI 总设计。

- [ ] **时间指针缓动与画布不同步**（2026-08-21）
  - 现象：快速平移（滚轮 glide/空格拖拽）时指针移动与画布错位（已改 transform 定位仍不完全同步，疑与合成器时序/多监听有关）。
  - 决定：用户明确"到时候一起修"（归入 UI/性能总设计）。

- [ ] **剧情线起止时间输入 UI 截断**（2026-08-21）
  - 现象：数值（年/月/日/时/分输入框）因布局窄被截断，看不清完整数字。
  - 决定：功能已确认 OK，**UI 问题和总设计一起修**（用户明确后置，不单独改）。
  - 位置：story-modal 的起止时间组（`.tl__time-row` / `.tl__time-edit`）。

- [x] **撤销（Ctrl+Z）未修好**（2026-08-20 用户反馈）→ **2026-09-12 第七轮已修**
  - 真正的根因**不是**撤销栈，而是「节点以 vault 的 `.md` 为源」导致撤销被重扫覆盖；
    加上拖动不入栈、撤销后世界游标悬空。三条的根因 / 修法 / 实测证据见上面「第七轮已修复（2026-09-12）」。
  - 本条下面保留的是当时的定位记录（原因一/二/三），原因二、三此前已修：
  - 已确认原因一：**拖动节点改时间完全不可撤销**。`timeline.ts` 拖动中间态用
    `saveNodeDoc(..., {undo:false})` 本身没错，但 `pointerup` 结束时**没有补一次带撤销的提交**，
    于是整次拖动永远进不了撤销栈；栈非空时 Ctrl+Z 反而恢复到更早的克隆，
    把拖动和上一个无关操作一起回滚（即用户看到的「撤销一次，两处都变了」）。
    修法：`pointerdown` 记下原年份，`pointerup` 用 `store.update`（走 actions）提交一次。
  - 已确认原因二：**循环/右键菜单的写操作绕过 `store.update`**（见文末新发现第 1 条），
    既不进撤销栈也不落盘，撤销时会被一起回滚。
    → 第二轮已修（循环写操作改走 `src/store/actions.ts` 的
    `addLoop`/`setLoopCount`/`removeLoop`/`copyNode`/`removeNode`）。
  - 已确认原因三（第三轮已修）：**外部 vault 同步把自己塞进撤销栈**。`src/main.ts` 的
    `onVaultChanged` 回调用默认 `{ undo: true }` 做整片替换，而 watcher 对自己写盘的文件也会触发
    → 每次编辑都会推入一个「看起来什么都没变」的整库深拷贝快照，Ctrl+Z 就表现为按了没反应。
    修法：该次 `store.update` 传 `{ undo: false }`；并在替换前先 flush 待写内容，避免又抹掉内存里的改动。
  - 其余仍待查：编辑面板内联编辑（title/desc）、people/places chips 等路径是否都 pushUndo；
    渲染重建后撤销/重做状态；redo 栈正确性。
  - 待办：用户复现现象后定位；修复后补验证（多次编辑→撤销→重做→对比数据）。

- [ ] **剧情范围条的拖动边界**（AE 工作区式增强）
  - 现象：范围条目前固定（创建时定起终节点），不能像 AE 工作区那样拖动两端调整。
  - 建议：范围条加拖拽手柄，拖动更新 startNodeId/endNodeId（或改存年份）。

- [ ] **多循环非线性布局错位**（`lingkuang.js` renderTimeline）
  - 现象：同一时间线多条循环时，非线性（序列）视图里重复段节点按偏移时间混合排序，可能与各自循环框不匹配。
  - 根因：循环重复段节点未标 `_loopId`，无法归位到所属循环框。
  - 建议：重复段节点加 `_loopId`，排序/分组时按它归位。单循环无影响，多循环才触发。

- [ ] **孤儿边界节点残留**（历史数据）
  - 现象：旧版测试数据里存在无循环引用的 `loop-boundary` 节点（如年 2265/3024）。
  - 建议：`migrateLoops()` 里加一次孤儿边界清理，或提供"清理孤儿节点"工具。

- [ ] **循环边界吸管/共享边界交互**（待验证）
  - 现象：`boundary: both` 共享边界节点的复用/拆分在复杂编辑序列下可能有边界情况未覆盖。
  - 建议：补充边界节点被删除/移动时循环引用的级联处理测试。

## 词义联想图

- [ ] **词库分类准确率偏低**（ai:classify）
  - 现象：7b 模型对小批量单词分类约 80% 准确，偶发明显错误（如"怀表→特殊服装"、"血色→其他身体特征"）。
  - 建议：分类 prompt 加更多规则/示例；或导出前提供人工确认界面；或支持更大模型。

- [ ] **联想图在窗口尺寸变化/视图切换后的布局**
  - 现象：`assocPanX/Y` 初始居中基于打开时 stage 尺寸；窗口 resize 后焦点可能偏移。
  - 建议：监听 resize 或提供"重置视图"按钮（回到根节点居中）。

- [ ] **展开失败时节点状态回滚**
  - 现象：`callAssociate` 失败会把 `node.expanded=false` 并重渲染，但 `selected`/`focusChildId` 状态可能残留不一致。
  - 建议：失败路径统一走 `renderGraph()` 并校验状态机不变量。

## 角色生成器

- [ ] **词库部分分类混杂**（数据质量问题）
  - 现象：`发色` 分类混入瞳色词（"黑瞳"等）；分类经 LLM 重分类后仍有少量错位（如"傲娇→关系"）。
  - 建议：词库数据清洗脚本（可复用 Ollama 重分类链路）。

- [ ] **联想图与生成器的词库同步**
  - 现象：导出暂存词后 `charWords` 重建，但当前已展开的联想图节点命中状态（实线/虚线）不实时刷新。
  - 建议：导出成功后对当前 `assocGraph` 重新计算命中并 `renderGraph()`（当前仅重建词集合）。

## 编辑器 / 通用

- [ ] **Markdown 预览细节**（待测）
  - 现象：表格/代码块/引用等复杂 Markdown 在预览中的样式细节可能未完全覆盖。
  - 建议：对照 CommonMark 规范补 CSS。

- [ ] **窗口最小尺寸以下布局挤压**（低优先级）
  - 现象：`minWidth 960 / minHeight 600` 以下（不达标）时侧边栏/画布可能挤压变形。
  - 建议：已设 minWidth/minHeight，一般不会触发；若需更小窗口需做响应式。

## 打包 / 分发

- [ ] **SmartScreen 未签名警告**
  - 现象：未签名 exe 首次运行弹"未知发布者"。
  - 建议：暂缓（开源免费项目）；有预算再上 OV 证书或 GitHub 免费 EV 渠道。

- [ ] **无自动更新**（低优先级）
  - 现象：新版本需手动下载替换。
  - 建议：接 electron-updater + GitHub Releases（发布后）。

## 本轮新发现（未修复）

> 2026-08-27 审计中发现、但本轮未改的问题。按「数据损失 / 崩溃」优先排序。

### 数据损失 / 崩溃风险

> 第二轮已修 4 条，第三轮又修掉 vault 重扫竞态——见上面「第二轮已修复」「第三轮已修复」。

- [x] **frontmatter 键名含 `-` `.` `(` 或空格的属性会被静默删除** → **第四轮已修**
  - 位置：`main.js` 的 `mdToNode` 读取正则（原 `line.match(/^([\w\u4e00-\u9fa5]+):\s*(.*)$/)`）。
  - 现象：在 Obsidian 里写 `身高(cm): 170`、`所属-阵营: 甲`、`所属.阵营: 甲`、`note 1: x`，
    灵框不但读不到这些属性，下次保存还会**把它们从文件里删掉**——`mdToNode` 只把匹配上的行
    收进 `fm`，而 `nodeToMd` 会整体重写 frontmatter。属数据损失，不只是「不显示」。
  - 用户决议（2026-08-27）：「数据管理要在灵框里面做，本质上不允许在灵框外增删属性字段」，
    但**灵框自己写出去的键必须能读回来** —— 写入端 `nodeToMd` 的 `${k}: ${fmtProp(v)}` 对键名
    零校验，读取端收窄就是「写完读不回」，用户在属性面板手打 `身高(cm)` 等于自毁数据。
  - 修法：读取端改为「先试**带引号的键**（`^("(?:[^"\\]|\\.)*")\s*:\s*(.*)$`），
    再退回**非贪婪**裸键（`^(.+?):\s*(.*)$`）」，键交给新的 `parseKey()` 去引号。
    非贪婪是必须的：贪婪会把 `year: 312-07-15 13:30:05` 的键吃成 `year: 312-07-15 13`、值只剩 `30:05`。
    写入端新增 `fmtKey()`：仅在键含 ASCII 冒号 / 首尾空白 / 为空时加双引号（合法 YAML，Obsidian 可读），
    普通中文键（如 `性别`）行为不变。
  - 验证：11 种键（`身高(cm)`、`所属-阵营`、`所属 阵营`、`性别`、`母语/方言`、`等级.战斗`、
    `标签#1`、`a:b`、空键、首尾空白、含引号键）**全部往返成功**；`year` 时分秒回归、
    固定字段不进 properties、`causes`、描述/正文、旧数据（手写无引号中文键）兼容 全部通过。

### 时间线

- [x] **拖动改时间不可撤销** → **2026-09-12 第七轮已修**（详见「第七轮已修复」的原因一）。

- [x] **非线性「类型泳道」没有真正生效** → **2026-09-12 第八轮已修**（用户点头后做，详见「第八轮已修复」）
  - 位置：`src/ui/timeline.ts` 的 `renderNonlinear` + `src/style.css` 的 `.tl__n{top:50%}`。
  - 根因：`nodeHtml` 只写 `left`，`top` 交给 CSS 的 50% → 两种类型的节点圆点全挤在垂直中线，
    而年份标签写在泳道上，数字离自己的节点 90px 以上，读不出对应关系。
  - 建议：给 `nodeHtml` 加 y 参数，或在非线性分支自己设 `top`。（采用了前者）


### 编辑器

> 本轮这 5 条全部已修（tiptap 实例/监听/订阅泄漏、`&nbsp;` 吃段落、`mdRender` 属性注入、
> 标题未转义、`tag-ext` 正则回溯）——见上面「第二轮已修复」。暂无遗留。

### 死代码 / 文档与现实不符

- [ ] **`src/ui/sectioned-editor.ts` 与 `src/ui/section-markdown.ts` 是死代码**
  - 说明：`3f68607` 曾把编辑器迁移到分区编辑器，但 `9926baa` 又**改回 tiptap**
    （`editor.ts` 里是 `new Editor({... extensions: [StarterKit, Markdown, Image, Tag] ...})`）。
    这两个文件没有任何地方 import（只有前者 import 后者），`src/style.css` 里也没有 `.md-seg`/`.md-editor` 了。
    `ARCHITECTURE.md` 与 `AGENTS.md` 说的「编辑器是 tiptap」是**对的**（这几轮笔记里曾误判为过时）。
  - 已核实（2026-08-27 第二轮）：`app-dist/assets/*.js` 里搜 `md-seg` / `sectioned-editor` / `section-markdown`
    零命中 → vite 不打包未引用模块，所以它们对运行时和安装包**零成本**。
    因此本轮**故意不删**（两个文件已在 git 里，随时可 `git rm`；保留是因为分区编辑器是被主动回退的方案，
    将来可能重做）。要删就 `git rm src/ui/sectioned-editor.ts src/ui/section-markdown.ts`。
  - 附带缺陷（若将来复活分区编辑器才需要处理）：
    ① `sectioned-editor.ts` 在标题处回车后 `renderAll(activeIdx + 1)` 先改掉了 `activeIdx`，
    紧接着 `placeCaret(activeIdx + 1, 0)` 变成 `old+2` → `segEls[idx]` 为 undefined 提前 return，
    跳过 `requestAnimationFrame(() => { suppressBlur = false; })` → `suppressBlur` 永久为 true，之后所有 blur 都不保存；
    ② `section-markdown.ts` 的 `lineType` 不跟踪围栏，`## 标题` 出现在 ``` 块里也会被当标题
    （偏移本身是自洽的，`slice(start,end) === source` 成立，只是缺围栏状态）；
    ③ `readSegText` 走 `innerText`，受布局/CSS 影响，应改用 `textContent`。
  - 建议：要么删掉这两个文件，要么在文件头注明「当前未接入」。

- [x] **`EDITOR-ESAY-TODO.md` 的描述在 HEAD 上是错的** → 第三轮已修：
  文首加回退说明（含当前真实代码引用），第 53 行原处标注该状态已失效。

- [x] **`docs/EDITOR-SANDBOX-BRIDGE.md` 两处不符** → 第三轮已修：
  第 59 行改为 `buildPropCtrl`；第 71 行改写为与实际一致，并把「键受字符类限制」的
  真实后果（会删属性）升格成上面「数据损失」里的独立条目。

### 优化（非 bug）

> 第二轮已做：渲染层依赖移出 asar。第三轮已做：`files` 死重。当前无遗留。

- [x] **`files` 里的死重** → 第三轮已从 `build.files` 移除 `lingkuang.js`（263.7 KB）与根 `index.html`。
  仓库里的 `legacy-index.html`（`lingkuang.js` 的唯一引用者，本身也不被应用加载）
  用户选择保留并已随本轮一起提交，**未删**。


---

### 提 Bug / 修 Bug 约定
- 新 Bug 请按上面格式追加（现象 / 复现 / 根因 / 建议）。
- 修复时同步更新 `ARCHITECTURE.md` 的"关键坑"（如果涉及）。
- 保持风格一致（无 emoji、文字不用黄色系等提醒，见 `ARCHITECTURE.md` §5）。
