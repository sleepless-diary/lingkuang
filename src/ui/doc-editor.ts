/** 灵框 · 极简文稿编辑器（设定库/工作台用）
 *
 * 与 `src/ui/editor.ts` 共用同一套 tiptap 扩展（StarterKit + Markdown + Image + Tag），
 * 但只管「编辑一份 Markdown 正文」，不带侧栏、属性面板、目标跟踪那些事。
 *
 * ⚠️ 切换条目必须 `dispose()` 旧实例再建新的 —— tiptap 实例不销毁会积 window 监听与订阅。
 * 正文最终落到 `entity.doc`，由主进程写进 vault 的 `<世界>/_设定/<类型>/<名字>.md`
 * （`#正文：` 标签之后），所以 Obsidian 里能看、也能改回来（文件为源）。
 */
import { Editor, Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { Image } from './image-ext';
import { Tag } from './tag-ext';
import { loadSettings } from './settings';

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

/** 段落聚焦：给**光标所在的顶层块**挂 `.is-cur`（其余块由 CSS 压暗）。
 *  用 ProseMirror 的 decoration 而不是自己改 DOM —— 见 createDocEditor 里那段说明。 */
const focusParaKey = new PluginKey('lkFocusPara');
const FocusPara = Extension.create({
  name: 'lkFocusPara',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: focusParaKey,
        props: {
          decorations(state) {
            const { $from } = state.selection;
            if ($from.depth < 1) return null;
            try {
              return DecorationSet.create(state.doc, [
                Decoration.node($from.before(1), $from.after(1), { class: 'is-cur' }),
              ]);
            } catch {
              return null;
            }
          },
        },
      }),
    ];
  },
});

export function createDocEditor(el: HTMLElement, onFlush: (md: string) => void): DocEditor {
  const pFocus = loadSettings().focusParagraph !== false;
  const editor = new Editor({
    element: el,
    extensions: [StarterKit, Markdown, Image, Tag, ...(pFocus ? [FocusPara] : [])],
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
  /* 段落聚焦（设置 → 外观，默认开）：聚焦时给编辑器挂 `.is-typing`，光标所在的**顶层块**
     由 ProseMirror 的 decoration 打上 `.is-cur` —— 写长文时眼睛只跟着当前这一段走。
     ⚠️ 为什么用 decoration 而不是自己 `setAttribute`：实测往 PM 管的 DOM 上写属性会被它下次
     重排默默擦掉（`has-cur` 还在、`data-cur` 没了 ⇒ 整篇被压暗）。decoration 是 PM 认可的写法。
     ⚠️ 只在**聚焦期间**生效（blur 摘掉），否则回看时整篇有一半是灰的。 */
  if (loadSettings().focusParagraph !== false) {
    const dom = editor.view.dom;
    editor.on('focus', () => dom.classList.add('is-typing'));
    editor.on('blur', () => dom.classList.remove('is-typing'));
  }
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
