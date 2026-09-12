/** tiptap 自定义 Image 节点 + markdown 双向序列化（`![alt](src)`）。
 * 独立于 React；让图片在所见即所得编辑器中直接显示，并在 markdown 里以标准语法存（外部 Obsidian 可读）。 */
import { Node } from '@tiptap/core';
import type { MarkdownToken, MarkdownParseHelpers, JSONContent } from '@tiptap/core';

export interface ImageOptions { inline?: boolean; }
export interface ImageAttrs { src: string; alt?: string; title?: string; }

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    image: {
      setImage: (attrs: ImageAttrs) => ReturnType;
    };
  }
}

export const Image = Node.create<ImageOptions>({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,

  addOptions() { return { inline: false }; },
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: this.options.inline ? 'span[data-type="image"]' : 'img[src]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['img', { ...HTMLAttributes, style: 'max-width:100%;border-radius:2px;' }];
  },
  addCommands() {
    return {
      setImage: (attrs) => ({ commands }) => commands.insertContent({ type: this.name, attrs }),
    };
  },

  /* ── markdown 双向序列化（@tiptap/markdown + marked）── */
  markdownTokenName: 'image',
  parseMarkdown(token: MarkdownToken, _helpers: MarkdownParseHelpers) {
    const t = token as unknown as { href?: string; title?: string; text?: string };
    return {
      type: this.name,
      attrs: { src: t.href ?? '', alt: t.text ?? '', title: t.title ?? undefined },
    };
  },
  renderMarkdown(node: JSONContent) {
    const attrs = (node.attrs ?? {}) as ImageAttrs;
    /* 目标必须做 URL 转义：CommonMark/marked 在空白处截断目标，
       `![](assets/my pic.png)` 会被解析成普通文本而不是图片 ——
       图片在下次 setContent 时退化成字面文本并从文档里消失（Windows 截图名常带空格）。 */
    const src = encodeURI(attrs.src ?? '');
    const alt = attrs.alt ?? '';
    const title = attrs.title ? ` "${attrs.title}"` : '';
    return `![${alt}](${src}${title})`;
  },
});
