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
            const re = /#([^\s#：:]+)(?![:：])/g;
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;
              let m; re.lastIndex = 0;
              while ((m = re.exec(node.text)) !== null) {
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
