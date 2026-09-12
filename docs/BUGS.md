# 灵框 LingKuang · 已知 Bug 清单

> 未修复的已知问题。修复时先读 `ARCHITECTURE.md`（尤其"关键坑"章节）。
> 每条标了复现路径和建议方向。修完请在条目上打勾并注明修复 commit。
>
> 2026-08-27 做了一轮全量审计（主进程 / 打包链路 / store / 时间线 / 编辑器 / 各工具面板），
> 下面「本轮已修复」记录已改掉的，文末「本轮新发现（未修复）」记录还没动的。
> 同日第二轮：继续清「底层」问题（数据保真 / 退出落盘 / 注入 / 死状态），见「第二轮已修复」。

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

> 本轮已修 4 条（循环写操作绕过 store.update、循环/剧情线重启即丢、删除节点复活、
> 退出不 flush）——见上面「第二轮已修复」。这里只剩下面这条。

- [ ] **vault 重新扫描会覆盖尚未写盘的改动（自动保存竞态）**
  - 位置：`src/main.ts` 的扫描回调（`store.update((d) => { d.worldsets = newData.worldsets; })`）。
  - 根因：watcher 对自己写的文件也会触发，回调**整片替换** `worldsets` 而不合并待写改动；
    `suppressWrite` 只抑制回写，挡不住已在排队或更晚的写盘。
    （第二轮已经把 loops/storylines/calendar 这类「.md 表达不了」的字段改成从 base 回填，
    但节点本身仍是整片替换。）
  - 建议：节点也按 id 合并而非替换；或对比 mtime/hash 跳过自己刚写的那次扫描；
    替换前先取消/落地待写定时器。

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

- [ ] **`EDITOR-ESAY-TODO.md` 的描述在 HEAD 上是错的**
  - 内容：第 53 行称「`editor.ts` 已移除 tiptap…已无 tiptap/ProseMirror 引用」，与当前代码相反；
    文件头还指向另一个 checkout（`F:\OpenDesign\...`）。建议改标注为历史记录或删除。

- [ ] **`docs/EDITOR-SANDBOX-BRIDGE.md` 两处不符**
  - 第 71 行称 `mdToNode`/`parseProp` 能读回 Obsidian 加的属性 —— 实际 frontmatter 键受
    `/^([\w\u4e00-\u9fa5]+):/` 限制，`身高(cm)`、`所属-阵营` 这类键会被静默丢弃；
    第 59 行写 `makePropCtrl`，代码里是 `buildPropCtrl`。

### 优化（非 bug）

> 本轮已做：渲染层依赖移出 asar（见「第二轮已修复」）。下面剩纯死重。

- [ ] **`files` 里的死重**
  - `lingkuang.js`（270KB legacy 单体）与根目录 `index.html`（vite 源入口，`<script src="/src/main.ts">`）
    都在 electron-builder 的 `files` 里，但运行时不加载任何一个
    （`main.js` 加载的是 `app-dist/index.html`，而它在打包时会被 vite 重新生成）。
  - 建议：从 `files` 移除这两项（顺带删掉仓库里那个 `legacy-index.html`）。


---

### 提 Bug / 修 Bug 约定
- 新 Bug 请按上面格式追加（现象 / 复现 / 根因 / 建议）。
- 修复时同步更新 `ARCHITECTURE.md` 的"关键坑"（如果涉及）。
- 保持风格一致（无 emoji、文字不用黄色系等提醒，见 `ARCHITECTURE.md` §5）。
