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
    dispose() {
      try { editor.destroy(); } catch { /* 销毁失败不挡切换 */ }
    },
  };
}
