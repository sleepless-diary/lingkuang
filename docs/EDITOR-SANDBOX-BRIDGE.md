# 编辑器 ↔ 世界沙盘 · 对接文档（Editor / Sandbox Bridge）

> 说明灵框**正文编辑器**（`src/ui/editor.ts`，tiptap）与**世界沙盘简易编辑器**（`src/ui/detail.ts` 节点详情）如何对接到**同一个节点**的数据。两者读写的是同一份 store 节点对象，职责边界如下。

## 1. 两端定位

| 端 | 文件 | 职责 |
|---|---|---|
| **正文编辑器** | `src/ui/editor.ts` | 编辑节点的**叙事正文** `node.doc`（markdown 富文本，所见即所得 + 图片 + `#tag` 胶囊）；**编辑**结构化属性 `node.properties`（带类型：文本/数值/复选框/多选/日期，`saveProp` 写回） |
| **世界沙盘简易编辑器** | `src/ui/detail.ts` | 节点详情面板：就地编辑 `title / type / desc / doc / year / precision`。**结构化属性编辑（`properties` + 类型控件）为约定目标，由沙盘側按本文档实现**（当前 detail.ts 未实现，编辑器已接管属性存储） |

**核心原则**：正文是**文章**（富文本，编辑器管）；属性是**结构体字段**（节点/角色/地点的类型化键值，沙盘管）。编辑器不编辑属性，沙盘不负责正文富文本排版。

## 2. 共享数据模型

两端操作同一个 `TimelineNode`（store 数据）：

```ts
interface TimelineNode {
  id: string;
  title: string;                 // 标题（沙盘编辑 / 编辑器只读展示）
  year: number;                  // 内部小数年份
  precision: TimePrecision;      // 'year' | 'month' | 'day' | ...
  type: 'world_event' | 'story_event' | 'loop-boundary';
  desc?: string;                 // #描述：(沙盘编辑 / 编辑器只读展示)
  doc?: string;                  // #正文：(正文编辑器 tiptap 编辑)
  properties?: Record<string, PropValue>;   // 结构化属性（编辑器 saveProp 编辑存储；沙盘展示可共用）
}
```

`PropValue`（`src/store/types.ts`）：

```ts
type PropValue = string | number | boolean | (string | number)[];
```

## 3. 数据流

```
世界沙盘 detail.ts                         正文编辑器 editor.ts
─────────────────────                      ─────────────────────
只读展示 ├─ title/type/desc/year             ├─ doc → tiptap 所见即所得
         ├─ doc（正文区 mdRender 预览）       ├─ properties → 属性区（makePropCtrl 按类型编辑）
编辑     ├─ inlineEdit title/desc/doc         └─ 失焦 getMarkdown() → 写回 node.doc
         └─ 属性编辑（约定目标，待实现）             └─ 属性区 saveProp → 写回 node.properties
                   │ store.update                 │ store.update
                   ▼                               ▼
              node.properties  ←──同一节点──→   node.doc
（vault .md frontmatter 存 properties，正文存 #正文：）
```

- **属性**：编辑器属性区 `saveProp` → `store.update` 写 `node.properties`（带正确类型）→ 落盘 frontmatter（`main.js nodeToMd`/`fmtProp`）→ 沙盘只读/展示可读取。
- **正文**：编辑器失焦 `editor.getMarkdown()` → `saveNodeDoc` 写 `node.doc` → 落盘 `#正文：` → 沙盘正文区 `mdRender` 预览更新。

## 4. 字段类型契约（属性）

`properties` 的键值对按值类型决定控件与展示（两端一致）：

| PropValue 类型 | 编辑器控件（makePropCtrl，已实现） | 展示/序列化 | frontmatter（Obsidian） |
|---|---|---|---|
| `number` | `<input type="number">` | 数字 | `key: 123` |
| `boolean` | `<input type="checkbox">` | 是 / 否 | `key: true/false` |
| `(string\|number)[]` 多选 | `<select multiple>` + ＋新建选项 | `a、b、c` | `key: [a, b]` |
| 日期 `YYYY-MM-DD` | `<input type="date">` | 页面展示可转 `YYYY年M月D日` | `key: 2026-08-23` |
| `string` 文本 | `<input type="text">` | 原样 | `key: 值` |

日期在编辑器按 `YYYY-MM-DD`（date 类型）存储（Obsidian 兼容）；页面只读展示时可用正则转中文年月日。序列化由 `main.js` 的 `parseProp` 按格式推断类型。

## 5. 序列化与 Obsidian 兼容

- `main.js`：`nodeToMd` 用 `fmtProp` 按类型写 frontmatter；`mdToNode` 用 `parseProp` 按格式解析回 `properties`（Obsidian 加的属性类型能读回）。
- 固定字段 `id/title/year/precision/type` 不进入 `properties`。
- 多行列表格式（`key:\n  - a`）暂不解析，Obsidian 默认行内 `[a, b]` 已兼容。

## 6. 注意事项

- **同一节点引用**：detail.ts 用 `freshNode()` 从 store 重取最新节点（外部 vault 重载后传入引用会失效），编辑器经 `find(id)` 取节点——两端都以 `store.data.worldsets[..].timelines[..].nodes.find(id)` 为唯一准。
- **store.update 触发重绘**：编辑器属性区 `saveProp`（store.update + renderProps）、失焦保存 doc；detail.ts `renderView` 在 `store.subscribe` 重绘。编辑中（有 input/textarea/select）不重绘，避免打断。
- **属性存储归属**：编辑器 `editor.ts` 已实现属性编辑（`makePropCtrl` + `saveProp` 写 `node.properties`，类型正确）；沙盘 `detail.ts` 如需属性编辑，按本文档契约实现，两端共用同一 `node.properties`（不重复写）。
- **保存边界**：编辑器失焦保存 doc、属性区 change 保存 properties；沙盘 inlineEdit 保存 title/desc/doc/year 等。两端独立、互不覆盖对方字段（editor 写 doc + properties，detail 写 title/desc/year）。
- **日期展示**：属性存 `YYYY-MM-DD`（Obsidian 兼容），页面只读展示可转中文年月日；建议在属性**摘要/只读区**做中文转换，编辑控件用 date input（ISO）。

## 7. 高级功能（以后做，先留接口，勿提前实现）

> 用户 2026-08 明确：以下属**高级功能**，本次不做，只记录方向与预留接口。

- **枚举下拉（属性值从预设里选）**：用户在世界沙盒里自定义枚举选项；但**预置字段**（如角色性别、发色等灵框内建类型的字段）由灵框**预置**枚举。→ 数据层 `properties` 值仍为 `PropValue`（string），枚举只是编辑层的下拉候选（将来在沙盒/类型定义处配置 `enum` 选项）。
- **自定义纪年法**：世界观可能有自建纪年（如"蚀渊纪元287年"），本质是**不同时钟/加减关系组合记录时间**。实现路径：用户通过**灵框 AI**（有门槛）按接口生成纪年定义，`main.js` 或编辑器用该定义做日期换算。
  - **已预留接口**：`editor.ts` 的 `dateToOrd`/`ordToDate`/`fmtCNDate`（模块级独立函数），接自定义纪元只需替换这 3 个函数（传入纪元基准/换算关系）。
  - 配置界面可做但复杂（纪年=多种组合），暂不做。
- **时间记录法自定义**：类似纪年法，属高级/以后。
- **本次范围**：编辑器属性控件已做数值/日期 scrub + 布尔 checkbox + 多选一列 checkbox + 文本 input + 添加属性类型下拉（含日期）。以上高级项仅在文档记录、接口预留，不在本次实现。
