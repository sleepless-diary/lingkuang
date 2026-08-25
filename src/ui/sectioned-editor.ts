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

/* 源码段读取：用 innerText 归一 <br>/块级换行为 \n 并去掉末尾占位空行（保留 ## 等 markdown 源码本身） */
function readSegText(el: HTMLElement): string {
  return (el.innerText ?? '').replace(/\n+$/, '');
}

export function createSectionedEditor(host: HTMLElement, initialMd: string, opts: SectionedEditorOptions = {}): SectionedEditor {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  let fullText = initialMd;
  let sections: MdSection[] = splitMarkdown(fullText, true);
  let activeIdx = -1;
  let destroyed = false;
  let suppressBlur = false;   /* renderAll 重建期间抑制 focusout，避免误存退出 */
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
      sections = splitMarkdown(fullText, true);
      activeIdx = Math.min(activeIdx, Math.max(0, sections.length - 1));
    }
  }

  /* 全量重建段 DOM；focusIdx 段为源码（contenteditable），其余预览（markdown-it 渲染） */
  function renderAll(focusIdx: number) {
    /* 重建 DOM 会移除当前聚焦段 → 触发 focusout；抑制它，避免误判为"退出编辑"保存 */
    suppressBlur = true;
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
        /* 内联强制清 contenteditable 聚焦时的系统 focus ring（Chromium UA 层用
           -webkit-focus-ring-color，外部 CSS 有时压不住；内联优先级最高一定能生效） */
        const st = el.style;
        st.outline = 'none';
        st.boxShadow = 'none';
        st.border = 'none';
        (st as any).webkitFocusRingColor = 'transparent';
      } else {
        el.innerHTML = md.render(s.source);
      }
      segEls.push(el);
      host.appendChild(el);
    }
    /* 不在此复位 suppressBlur：保持 true 直到 placeCaret 聚焦成功后再复位，覆盖重建产生的失焦 */
  }

  /* 把光标放到源码段 caret 处，并聚焦该段 */
  function placeCaret(idx: number, caret = 0) {
    const el = segEls[idx];
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (sel) {
      const tn = el.firstChild;
      const range = document.createRange();
      if (tn && tn.nodeType === Node.TEXT_NODE) {
        const pos = Math.min(caret, (tn.textContent ?? '').length);
        range.setStart(tn, pos);
      } else {
        /* 空段：以 el 为准，确保选区落在段内 */
        range.setStart(el, 0);
      }
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    /* 聚焦已回到 editor 内；延迟解除失焦抑制，确保 focusout 派发窗口已过 */
    requestAnimationFrame(() => { suppressBlur = false; });
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
    const text = readSegText(el);
    /* atStart/atEnd 用 Range 比较光标与段边界（比 anchorOffset 可靠，不受 anchorNode 类型影响） */
    let atStart = false;
    let atEnd = false;
    try {
      const range = sel.getRangeAt(0);
      const head = document.createRange();
      head.setStart(el, 0);
      head.collapse(true);
      atStart = range.compareBoundaryPoints(Range.START_TO_START, head) <= 0;
      const tail = document.createRange();
      tail.selectNodeContents(el);
      tail.collapse(false);
      atEnd = range.compareBoundaryPoints(Range.START_TO_START, tail) >= 0;
    } catch { /* 保护：range 异常时视为非边界 */ }
    if (e.key === 'ArrowDown' && atEnd && activeIdx < sections.length - 1) {
      e.preventDefault();
      setActive(activeIdx + 1, 0);
    } else if (e.key === 'ArrowUp' && atStart && activeIdx > 0) {
      e.preventDefault();
      setActive(activeIdx - 1, 0);
    } else if (e.key === 'Enter' && atEnd && /^ {0,3}#{1,6}/.test(text)) {
      /* 标题语法：源码段段尾回车 → 该段渲染为标题预览，光标落入新的空白可编辑段继续写。
         note-gen 手感：`##` 后没打空格也认（回车时自动补空格成合法标题）。
         实现：先在段源码里补空格（若缺），再在段尾插入换行，使 splitMarkdown(keepBlank) 产出 heading + blank 两段。 */
      e.preventDefault();
      flushActive();
      ensureSections();
      const cur = sections[activeIdx];
      /* note-gen 手感：标题行若 `#` 后无空格（如纯 `##` 或 `##标题`），自动补一个空格成合法标题 */
      let titleSrc = cur.source;
      let titleEnd = titleSrc.length;   // 标题行结束位置（在 titleSrc 中的索引）
      if (/^ {0,3}#{1,6}/.test(titleSrc) && !/^ {0,3}#{1,6}\s/.test(titleSrc)) {
        const m = /^ {0,3}(#{1,6})/.exec(titleSrc)!;
        titleEnd = m[0].length;
        titleSrc = titleSrc.slice(0, titleEnd) + ' ' + titleSrc.slice(titleEnd);
        fullText = fullText.slice(0, cur.start) + titleSrc + fullText.slice(cur.end);
        sections = splitMarkdown(fullText, true);
      }
      const c2 = sections[activeIdx];
      fullText = fullText.slice(0, c2.end) + '\n' + fullText.slice(c2.end);
      sections = splitMarkdown(fullText, true);
      ensureSections();
      renderAll(activeIdx + 1);
      placeCaret(activeIdx + 1, 0);
    } else if (e.key === 'Backspace' && atStart && activeIdx > 0) {
      e.preventDefault();
      flushActive();
      ensureSections();
      const cur = sections[activeIdx];
      const prev = sections[activeIdx - 1];
      const merged = prev.source + '\n' + cur.source;
      fullText = fullText.slice(0, prev.start) + merged + fullText.slice(cur.end);
      sections = splitMarkdown(fullText, true);
      renderAll(activeIdx - 1);
      placeCaret(activeIdx, prev.source.length);
    }
  }

  /* 失焦：当前源码段写回，回调保存 */
  function onFocusOut(e: FocusEvent) {
    if (destroyed) return;
    /* 重建 DOM 时移除旧段触发 focusout，但新段马上会聚焦回 host：若当前/即将的焦点还在 host 内则不保存退出 */
    const related = e.relatedTarget as Node | null;
    if (related && host.contains(related)) return;
    const ae = document.activeElement as Node | null;
    if (ae && host.contains(ae)) return;
    if (suppressBlur) return;
    flushActive();
    opts.onBlur?.(getMarkdown());
  }

  function getMarkdown(): string {
    flushActive();
    return fullText;
  }
  function setMarkdown(mdText: string) {
    fullText = mdText;
    sections = splitMarkdown(fullText, true);
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
