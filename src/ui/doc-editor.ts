/** 灵框 · 极简文稿编辑器（设定库/工作台用）
 *
 * 与 `src/ui/editor.ts` 共用同一套 tiptap 扩展（StarterKit + Markdown + Image + Tag），
 * 但只管「编辑一份 Markdown 正文」，不带侧栏、属性面板、目标跟踪那些事。
 *
 * ⚠️ 切换条目必须 `dispose()` 旧实例再建新的 —— tiptap 实例不销毁会积 window 监听与订阅。
 * 正文最终落到 `entity.doc`，由主进程写进 vault 的 `<世界>/_设定/<类型>/<名字>.md`
 * （`#正文：` 标签之后），所以 Obsidian 里能看、也能改回来（文件为源）。
 */
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { Image } from './image-ext';
import { Tag } from './tag-ext';

export interface DocEditor {
  setDoc(md: string): void;
  getDoc(): string;
  /** 有改动才交给 onFlush（避免每次失焦都压一个撤销格） */
  flush(): void;
  dispose(): void;
  /** 把光标所在段落切成一/二/三级标题（所见即所得；从 `src/ui/editor.ts` 的 H1 按钮搬过来） */
  toggleHeading(level: 1 | 2 | 3): void;
  /** 在光标处插入图片（`src` 是 vault assets 里的相对路径，Image 扩展负责显示） */
  insertImage(src: string): void;
  /** 在正文末尾追加一段纯文本（AI 续写用）。走一次可撤销的 transaction，写完立刻 flush。 */
  append(text: string): void;
}

/** 追加进编辑器的最小转义：只挡 HTML 元字符，AI 吐的 Markdown 标记原样当文字（正文本来就允许写 **粗体**） */
function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function createDocEditor(el: HTMLElement, onFlush: (md: string) => void): DocEditor {
  const editor = new Editor({
    element: el,
    extensions: [StarterKit, Markdown, Image, Tag],
    contentType: 'markdown',
    content: '',
    editorProps: {
      attributes: {
        style: 'outline:none;min-height:200px;font-size:var(--text-sm);color:var(--fg);line-height:1.75;user-select:text;',
      },
    },
  });
  let last = '';
  const getDoc = (): string => editor.getMarkdown() || '';
  const flush = (): void => {
    const md = getDoc();
    if (md === last) return;
    last = md;
    onFlush(md);
  };
  editor.on('blur', flush);
  return {
    setDoc(md: string) {
      last = md || '';
      editor.commands.setContent(md || '', { contentType: 'markdown' });
    },
    getDoc,
    flush,
    toggleHeading(level: 1 | 2 | 3) {
      editor.chain().focus().toggleHeading({ level }).run();
    },
    insertImage(src: string) {
      editor.chain().focus().setImage({ src, alt: '' }).run();
    },
    append(text: string) {
      const add = String(text || '').trim();
      if (!add) return;
      /* 一段一段插成 `<p>`：整串塞进 insertContent 时换行会被 HTML 解析吃成空格，
         模型给的段落就粘成一坨。空行分段、单换行当 <br>，与 Markdown 的观感一致。 */
      const html = add.split(/\n{2,}/).map((p) => `<p>${escapeText(p).replace(/\n/g, '<br>')}</p>`).join('');
      editor.chain().focus('end').insertContentAt(editor.state.doc.content.size, html).run();
      /* insertContentAt 是一次正常 transaction ⇒ Ctrl+Z 能整段撤销；但失焦前不会自己落盘，
         所以这里直接 flush（否则用户点完续写就关窗，正文只在编辑器里）。 */
      flush();
    },
    dispose() {
      try { editor.destroy(); } catch { /* 销毁失败不挡切换 */ }
    },
  };
}
