# 灵框 v3 编辑器重构任务交接（2026-08-23）

> 本文件给后续会话/Rule 接手"编辑器方案2"任务用。项目路径：`F:\OpenDesign\.od\projects\lingkuang-v3-ui\`

## 任务背景
用户想把编辑器做成 **notegen 式**：所见即所得预览 + **光标所在段显示 markdown 源码标记**（如标题行显示 `##`，其他段渲染成富文本），且支持长文档。已确认方向 = **方案2**（markdown 分段渲染，不用 tiptap 富文本，不引 React）。

## 已完成（不要重做）
- **`src/ui/section-markdown.ts`** —— markdown 分段核心（纯函数）：`splitMarkdown(src)` 按行拆 block 段（heading/para/list/code/quote/hr），返回 `{start,end,source,type,level}`；`sectionAt(sections,pos)` 定位光标所在段。**node 测试验证正确**（标题/段落/列表/引用拆分正常）。
- **`markdown-it` 依赖** 已装（`package.json`），用于段渲染 markdown→HTML。
- 当前 git 最后提交 `21cabe7`，工作区干净（除 `data/character_lib.json` 运行时词库 + `legacy-index.html` 遗留，均不提交）。

## 目标实现（方案2 编辑器主体，待做）
把编辑器做成"光标段源码 + 其他段预览"：
1. **编辑器用 contenteditable**（或分段 DOM），存 node.doc 的 markdown 源码
2. **分段渲染**：用 `splitMarkdown` 把 markdown 拆段
   - **光标所在段** → 显示该段 markdown 源码（contenteditable，可编辑）
   - **其他段** → `markdown-it` 渲染成只读预览（不可编辑）
3. **光标移动**（`selectionchange`）→ 判断当前段 → 切换该段为源码编辑、其他段回预览。光标移走时，把编辑的源码重新拼回 markdown。
4. **长文档**：用户明确"可能会放一整本书"，要能支持较长文本（不需要 note-gen 的虚拟化那么重，但别卡顿；可用分段节流渲染）。
5. **保存**：编辑时把各段源码拼回完整 markdown → 写回 `node.doc`（blur 自动保存）→ 走现有 `saveNodeDoc`/`store.update` 同步回 vault `.md`（Obsidian 兼容格式 `#字段：值` 不能破坏，正文字段用 `#正文：`）。
6. **替换 tiptap**：`src/ui/editor.ts` 当前已经改成了 tiptap（`Editor` + `Markdown` + `MarkdownMarkers`），方案2要**移除 tiptap**，换成 markdown 分段编辑器。`MarkdownMarkers` 扩展可删除。`@tiptap/*`、`@tiptap/pm` 依赖完成方案2后可 `npm uninstall` 清掉。

## 关键参考（note-gen 源码，代理已开可 clone）
- 仓库：`https://github.com/codexu/note-gen`（Tauri + Next.js + React，**不是 tiptap 实现"光标显示##"**）
- "光标段源码"核心在：`src/app/core/main/editor/markdown/sectioned-markdown-editor.tsx`（952行，React + markdown-it 分段 + `@tanstack/react-virtual` 虚拟化 + `section-document.ts` 分段）
- **注意**：note-gen 那段是 React + 虚拟化架构，**不要整套照抄**（会违背项目"无框架、活得久"）。只借鉴它的**分段算法思想**（用我们的 `section-markdown.ts` + markdown-it 实现，不引 React）。若想参考分段/光标 offset 计算的细节，看 `section-document.ts` 的纯逻辑部分。
- 若能联系到 notegen 用户想要的**确切交互**（光标在标题行时行首显示 `##`，移开渲染成标题），这正是 `sectioned-markdown-editor` 的交互。

## 编辑器交互预期（用户描述的 notegen 效果）
- 光标在标题段 → 该段行首显示 `##`/`###` 等 markdown 标记（源码），段内容可编辑
- 光标移开该段 → 该段渲染成富文本标题（`# 标题` 渲染成大字标题，不再显示 `##`）
- 加粗/列表等同理（光标段显示 `**`/`- `，移开渲染）
- 存的是纯 markdown（Obsidian/vault 兼容）

## 项目约束（别踩坑）
- **无框架、原生 DOM**（Vite+TS）：不引 React/Next（note-gen 是 React，只能借鉴算法不能引框架）
- **UI 配色**：不用黄色系；文字用 `--fg`，强调勿用荧光绿做文字（黑底上荧光绿可以，乳黄背景上文字用 `--fg`）；元素用荧光绿要加边框
- **vault 同步**：`.md` 为源，正文字段用 `#正文：`，描述用 `#描述：`，`main.js` 的 `nodeToMd`/`mdToNode` 负责转换；编辑器保存必须保持这个格式
- **`data/character_lib.json`** 是 CC BY-NC-SA 词库，保持 LF 行尾，不要提交改动（运行时数据）
- git push：需 `HTTPS_PROXY=http://127.0.0.1:7892`（代理已开），push 报 TLS 超时重试即可
- build：`npm run build`（tsc + rolldown）；改完要 tsc + build 通过再提交

## 步骤建议（分多轮，每轮用户实测）
1. 写编辑器骨架：contenteditable 容器 + `splitMarkdown` 分段渲染初版（光标段源码、其他段预览）
2. 光标切换逻辑（`selectionchange` 判断段、切换/拼接）
3. 保存回 markdown + 接入 editor.ts（替换 tiptap）+ vault 同步验证
4. 长文档性能调优（分段节流）
5. `npm uninstall @tiptap/* @tiptap/markdown @tiptap/pm` 清理
6. tsc/build 验证 + 提交，用户实测迭代

## 本轮进度（2026-08-23，方案2 编辑器骨架已完成，待用户实测）
- **已完成**：新增 `src/ui/sectioned-editor.ts` —— contenteditable 分段编辑器（光标段源码、其他段 markdown-it 预览；点击预览段/方向键跨段切源码；离开段 `flushActive` 原位替换回拼 markdown；失焦 `onBlur` 保存）；`editor.ts` 已移除 tiptap（含 `MarkdownMarkers`）改用新编辑器；`style.css` 用 `.md-editor` 样式替换 tiptap 样式；`tsc` + `vite build` 通过，editor chunk 已无 tiptap/ProseMirror 引用。
- **骨架已知局限（下一轮优化，非本轮）**：① 点击预览段 → 源码段光标落**段首**（未精确映射落点偏移）；② 编辑中段内加空行导致段落分裂时，切段索引可能定位偏差（沿用 note-gen 思路后续优化）；③ `@tiptap/*`/`@tiptap/pm` 未 `npm uninstall`；④ 长文档性能（分段节流）未做。等用户实测反馈后处理。

## 一句话给新会话
"继续灵框编辑器方案2（notegen 式 markdown 分段：光标段显示源码、其他段预览），`section-markdown.ts` 分段核心已做好验证过，下一步写 contenteditable 分段编辑器骨架，参考 note-gen 的 `sectioned-markdown-editor.tsx` 交互，但不引 React。先问用户或用 AGENTS.md 确认，然后从编辑器骨架开始。"
