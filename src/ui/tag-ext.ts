/** tag 高亮扩展：给正文里的 `#tag`（# 后非空白、非冒号/中文冒号）加 CSS 类，渲染成 Obsidian 风格胶囊。
 * 用 ProseMirror Decoration（纯视觉装饰，不改文档结构），序列化回 markdown 时原样保留 `#tag` 文本，外部 Obsidian 可读。
 * 排除 `# ` 标题和 `#字段：`（灵框正文字段，带冒号）。 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const tagDecorationPlugin = new PluginKey('tagDecoration');

export const Tag = Extension.create({
  name: 'tag',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: tagDecorationPlugin,
        props: {
          decorations(state) {
            const decos: Decoration[] = [];
            /* 注意：不能写成 /#([^\s#：:]+)(?![:：])/g —— 末尾的否定环视会被回溯绕过去。
               对 `#正文：`，贪婪类先吃满「正文」，此时环视看到「：」失败，于是回溯成「正」，
               下一个字符是「文」不是冒号 → 整体成立，结果把 `#正` 高亮成标签。
               改成：类里已经排除了冒号（吃不到冒号），匹配完再看后一个字符是不是冒号来决定跳过。 */
            const re = /#([^\s#：:]+)/g;
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;
              let m; re.lastIndex = 0;
              while ((m = re.exec(node.text)) !== null) {
                /* `#字段：` / `#字段:` 是灵框的结构化字段（#描述：/#正文：），不是标签 */
                const after = node.text[m.index + m[0].length];
                if (after === '：' || after === ':') continue;
                const from = pos + m.index;
                const to = from + m[0].length;
                decos.push(Decoration.inline(from, to, { class: 'md-tag' }));
              }
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});
