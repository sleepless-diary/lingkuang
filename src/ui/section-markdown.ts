/** markdown 分段 core：把 markdown 文本拆成 block 段，记录每段源码 + 偏移 + 类型。
 * note-gen 思想（光标段显示源码，其他段渲染），纯函数无框架依赖。 */
export interface MdSection {
  start: number;      // 段在全文的起点（char offset）
  end: number;        // 段在全文的终点（含末尾换行前的源码，不含段间空行）
  source: string;     // 段的 markdown 源码（含首尾换行前的行）
  type: 'heading' | 'para' | 'list' | 'code' | 'quote' | 'hr' | 'blank';
  level?: number;     // heading 级别
}

/** 按行解析 markdown → 段列表。连续同类行合并为一段，空行/缩进作为段边界标记。
 * keepBlank=true 时空行保留为独立 blank 段（source=''），供编辑器产生可继续编辑的空段。 */
export function splitMarkdown(src: string, keepBlank = false): MdSection[] {
  const lines = src.split('\n');
  const sections: MdSection[] = [];
  let cur: { type: MdSection['type']; level?: number; start: number; lines: string[] } | null = null;
  const flush = () => {
    if (cur) {
      const body = cur.lines.join('\n');
      sections.push({ start: cur.start, end: cur.start + body.length, source: body, type: cur.type, level: cur.level });
      cur = null;
    }
  };

  let offset = 0;
  const lineType = (l: string): MdSection['type'] => {
    if (/^ {0,3}#+\s/.test(l)) return 'heading';
    if (/^ {0,3}([-*])\s/.test(l)) return 'list';
    if (/^ {0,3}\d+[.、]\s/.test(l)) return 'list';
    if (/^ {0,3}>/.test(l)) return 'quote';
    if (/^ {0,3}(```|~~~)/.test(l)) return 'code';
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) return 'hr';
    if (!l.trim()) return 'blank';
    return 'para';
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const t = lineType(l);
    /* 空白行：若当前有段，作为段结束标记；keepBlank=true 时保留为独立空段 */
    if (t === 'blank') {
      flush();
      if (keepBlank) sections.push({ start: offset, end: offset, source: '', type: 'blank' });
      offset += l.length + 1;
      continue;
    }
    if (!cur) {
      cur = { type: t, level: t === 'heading' ? (/^ {0,3}(#+)\s/.exec(l))![1].length : undefined, start: offset, lines: [] };
    } else if (t !== cur.type && !(t === 'para' && cur.type === 'para')) {
      /* 类型变化 → 结束当前段（下一段从这行开始），但仅当不是同类型延续 */
      flush();
      cur = { type: t, level: t === 'heading' ? (/^ {0,3}(#+)\s/.exec(l))![1].length : undefined, start: offset, lines: [] };
    }
    cur.lines.push(l);
    offset += l.length + 1;
  }
  flush();
  return sections;
}

/** 根据字符 offset 找所在段 */
export function sectionAt(sections: MdSection[], pos: number): MdSection | null {
  for (const s of sections) {
    if (pos >= s.start && pos <= s.end) return s;
  }
  return sections.length ? sections[sections.length - 1] : null;
}
