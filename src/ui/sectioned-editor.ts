/** 分段 markdown 编辑器（notegen 式：光标段显示源码，其他段 markdown-it 预览；存纯 markdown）
 * 无框架原生 DOM。思路借鉴 note-gen section-document.ts 的原位替换 + 后缀平移，但不引 React 不虚拟化。 */
import MarkdownIt from 'markdown-it';
import { splitMarkdown, type MdSection } from './section-markdown';

export interface SectionedEditorOptions {
  onBlur?: (md: string) => void;   // 失焦保存（editor.ts 用）
}
export interface SectionedEditor {
  getMarkdown(): string;
  setMarkdown(md: string): void;
  focus(): void;
  destroy(): void;
}

/* 源码段读取：pre-wrap 下 innerText 把 <br>/块级换行归一成 \n，去掉编辑器末尾占位空行 */
function readSegText(el: HTMLElement): string {
  return (el.innerText ?? '').replace(/\n+$/, '');
}

export function createSectionedEditor(host: HTMLElement, initialMd: string, opts: SectionedEditorOptions = {}): SectionedEditor {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  let fullText = initialMd;
  let sections: MdSection[] = splitMarkdown(fullText);
  let activeIdx = -1;
  let destroyed = false;
  const segEls: HTMLElement[] = [];

  host.classList.add('md-editor');
  host.removeAttribute('contenteditable');   // 容器不编辑

  /* 空文档也保证一段可编辑 */
  function ensureSections() {
    if (sections.length === 0) sections = [{ start: 0, end: 0, source: '', type: 'para' as const }];
  }

  /* 把当前源码段最新内容写回 fullText 并重分段（离开段时调用） */
  function flushActive() {
    if (activeIdx < 0 || activeIdx >= segEls.length) return;
    const s = sections[activeIdx];
    const newSrc = readSegText(segEls[activeIdx]);
    if (newSrc !== s.source) {
      fullText = fullText.slice(0, s.start) + newSrc + fullText.slice(s.end);
      sections = splitMarkdown(fullText);
      activeIdx = Math.min(activeIdx, Math.max(0, sections.length - 1));
    }
  }

  /* 全量重建段 DOM；focusIdx 段为源码（contenteditable），其余预览（markdown-it 渲染） */
  function renderAll(focusIdx: number) {
    ensureSections();
    activeIdx = Math.max(0, Math.min(focusIdx, sections.length - 1));
    host.textContent = '';
    segEls.length = 0;
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const el = document.createElement('div');
      const isSrc = i === activeIdx;
      el.className = 'md-seg' + (isSrc ? ' is-src' : ' is-prev');
      el.dataset.i = String(i);
      if (isSrc) {
        el.setAttribute('contenteditable', 'true');
        el.textContent = s.source;
      } else {
        el.innerHTML = md.render(s.source);
      }
      segEls.push(el);
      host.appendChild(el);
    }
  }

  /* 把光标放到源码段 caret 处 */
  function placeCaret(idx: number, caret = 0) {
    const el = segEls[idx];
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (!sel) return;
    const tn = el.firstChild;
    const range = document.createRange();
    if (tn && tn.nodeType === Node.TEXT_NODE) {
      const pos = Math.min(caret, (tn.textContent ?? '').length);
      range.setStart(tn, pos);
    } else {
      range.setStart(el, 0);
    }
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /* 切到某段为源码段：先 flush 当前段写回，再重分段重渲染，然后聚焦 */
  function setActive(idx: number, caret = 0) {
    flushActive();
    renderAll(idx);
    placeCaret(activeIdx, caret);
  }

  function segIndexOfNode(node: Node | null): number {
    if (!node) return -1;
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
    const seg = el?.closest?.('.md-seg') as HTMLElement | null;
    if (!seg) return -1;
    return Number(seg.dataset.i ?? -1);
  }

  /* 预览段点击 → 切源码模式并聚焦；点容器空白 → 聚焦当前/首个段 */
  function onDocClick(e: MouseEvent) {
    if (destroyed) return;
    const targetNode = e.target as Node;
    /* 点预览段（或段内）→ 切该段为源码 */
    const idx = segIndexOfNode(targetNode);
    if (idx >= 0 && idx !== activeIdx) {
      setActive(idx, 0);
      return;
    }
    /* 点源码段内空白 → 聚焦即可；点容器空白（非段、非按钮）→ 聚焦当前/首段源码 */
    if (idx < 0 && !(targetNode as HTMLElement).closest?.('.md-seg')) {
      const t = activeIdx >= 0 ? activeIdx : 0;
      setActive(t, 0);
    }
  }

  /* 源码段内跨段导航：段首 Up / 段尾 Down / 段首 Backspace 合并上一段 */
  function onKeyDown(e: KeyboardEvent) {
    if (destroyed) return;
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed) return;
    const idx = segIndexOfNode(sel.anchorNode);
    if (idx !== activeIdx || activeIdx < 0) return;
    const el = segEls[activeIdx];
    const text = (el.firstChild?.textContent ?? el.innerText ?? '');
    const caret = sel.anchorOffset;
    const atStart = caret <= 0;
    const atEnd = caret >= text.length;
    if (e.key === 'ArrowDown' && atEnd && activeIdx < sections.length - 1) {
      e.preventDefault();
      setActive(activeIdx + 1, 0);
    } else if (e.key === 'ArrowUp' && atStart && activeIdx > 0) {
      e.preventDefault();
      setActive(activeIdx - 1, 0);
    } else if (e.key === 'Backspace' && atStart && activeIdx > 0) {
      e.preventDefault();
      flushActive();
      ensureSections();
      const cur = sections[activeIdx];
      const prev = sections[activeIdx - 1];
      const merged = prev.source + '\n' + cur.source;
      fullText = fullText.slice(0, prev.start) + merged + fullText.slice(cur.end);
      sections = splitMarkdown(fullText);
      renderAll(activeIdx - 1);
      placeCaret(activeIdx, prev.source.length);
    }
  }

  /* 失焦：当前源码段写回，回调保存 */
  function onFocusOut(e: FocusEvent) {
    if (destroyed) return;
    const related = e.relatedTarget as Node | null;
    if (related && host.contains(related)) return;   // 仍在编辑器内
    flushActive();
    opts.onBlur?.(getMarkdown());
  }

  function getMarkdown(): string {
    flushActive();
    return fullText;
  }
  function setMarkdown(mdText: string) {
    fullText = mdText;
    sections = splitMarkdown(fullText);
    renderAll(0);
    placeCaret(0);
  }
  function focus() {
    const t = activeIdx >= 0 ? activeIdx : 0;
    if (t >= segEls.length) renderAll(t);
    placeCaret(t);
  }
  function destroy() {
    destroyed = true;
    host.removeEventListener('click', onDocClick);
    host.removeEventListener('keydown', onKeyDown);
    host.removeEventListener('focusout', onFocusOut);
    host.textContent = '';
  }

  host.addEventListener('click', onDocClick);
  host.addEventListener('keydown', onKeyDown);
  host.addEventListener('focusout', onFocusOut);

  renderAll(0);
  return { getMarkdown, setMarkdown, focus, destroy };
}
