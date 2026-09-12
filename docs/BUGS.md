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

- [ ] **撤销（Ctrl+Z）未修好**（2026-08-20 用户反馈；2026-08-27 定位到其中一条确定原因）
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

- [ ] **拖动改时间不可撤销**（详见上面「撤销（Ctrl+Z）」条目的已确认原因一）。

- [ ] **非线性「类型泳道」没有真正生效**
  - 位置：`src/ui/timeline.ts` 的 `renderNonlinear` + `src/style.css` 的 `.tl__n{top:50%}`。
  - 根因：`nodeHtml` 只写 `left`，`top` 交给 CSS 的 50% → 两种类型的节点圆点全挤在垂直中线，
    而年份标签写在泳道上，数字离自己的节点 90px 以上，读不出对应关系。
  - 建议：给 `nodeHtml` 加 y 参数，或在非线性分支自己设 `top`。
  - ⚠️ **修这个会改变画面布局**（泳道会从此分开），用户口径是「不影响我表面看到的」，
    动手前先确认。


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
