/** markdown 分段 core：把 markdown 文本拆成 block 段，记录每段源码 + 偏移 + 类型。
 * note-gen 思想（光标段显示源码，其他段渲染），纯函数无框架依赖。 */
export interface MdSection {
  start: number;      // 段在全文的起点（char offset）
  end: number;        // 段在全文的终点（含末尾换行前的源码，不含段间空行）
  source: string;     // 段的 markdown 源码（含首尾换行前的行）
  type: 'heading' | 'para' | 'list' | 'code' | 'quote' | 'hr' | 'blank';
  level?: number;     // heading 级别
}

/** 按行解析 markdown → 段列表。连续同类行合并为一段，空行/缩进作为段边界标记。 */
export function splitMarkdown(src: string): MdSection[] {
  const lines = src.split('\n');
  const sections: MdSection[] = [];
  let cur: { type: MdSection['type']; level?: number; start: number; lines: string[] } | null = null;
  const flush = () => {
    if (cur) {
      const body = cur.lines.slice(0, -1).join('\n');      // 去掉末尾记入的 blank 分隔
      const hadBlank = cur.lines.length > body.split('\n').length;
      const len = body.length + (hadBlank ? 1 : 0);
      sections.push({ start: cur.start, end: cur.start + len, source: body, type: cur.type, level: cur.level });
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
    /* 空白行：若当前有段，作为段结束标记（当前段到此为止，空白交给下一段） */
    if (t === 'blank') {
      flush();
      /* 连续空行合并为一段 blank 也行，这里简单丢弃（段间空行自然分隔） */
      // advance offset by line length + \n
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
