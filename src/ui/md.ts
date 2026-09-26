/** 灵框 · 极简 Markdown → HTML（聊天气泡用）
 *
 *  用户 2026-09-26：「ai 的回答没被渲染，如 **文字** 这种」——在那之前气泡是 `escapeHtml(内容)`，
 *  模型吐出来的 `**粗体**`、`# 标题`、`- 列表`、``` 代码块 ``` 全按字面显示。
 *
 *  分寸：**只做聊天里真会出现的那些**（粗/斜/行内码/代码块/标题/列表/引用/分割线/链接）。
 *  不做表格、脚注、嵌套列表、HTML 透传 —— 清单越长，在**流式半截文本**上越容易崩。
 *
 *  ⚠️ 安全：先整段转义 HTML，再在**转义后**的文本上套标记（`* _ ~ ` [ ]` 这些标记字符不受转义影响），
 *     绝不把模型吐的 HTML 当标签 —— 那是注入面。
 *  ⚠️ 流式友好：① 未闭合的 ``` 也当代码块收尾（否则半截回复会把后面所有字吞进 <pre>）；
 *     ② 块与块之间**不插换行**（气泡容器可能是 `white-space:pre-wrap`，插换行会多出空行）；
 *     ③ 单换行 → `<br>`，这样纯文本的换行意图也保得住。
 */

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ESC[c]);
}

/** 行内标记：行内码 / 粗 / 斜 / 删除线 / 链接（输入必须是**已转义**的文本） */
function inline(s: string): string {
  return s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    /* 只认 http(s) 链接：别让 `[点这里](javascript:…)` 变成可点的东西 */
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

export function mdToHtml(src: string): string {
  if (!src) return '';
  let text = esc(src.replace(/\r\n?/g, '\n'));

  /* ① 代码块先摘出来（含未闭合的），用 \u0000n\u0000 占位，最后还原 */
  const blocks: string[] = [];
  text = text.replace(/```([^\n]*)\n?([\s\S]*?)(?:```|$)/g, (_m, lang: string, code: string) => {
    const l = String(lang).trim().replace(/[^a-zA-Z0-9+#._-]/g, '').slice(0, 16);
    blocks.push('<pre class="lk-md__pre"><code' + (l ? ' data-lang="' + l + '"' : '') + '>' + code.replace(/\n+$/, '') + '</code></pre>');
    return '\u0000' + (blocks.length - 1) + '\u0000';
  });

  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  const flushPara = (): void => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
  const flushList = (): void => {
    if (!list) return;
    out.push('<' + list.tag + '>' + list.items.map((i) => '<li>' + inline(i) + '</li>').join('') + '</' + list.tag + '>');
    list = null;
  };

  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (/^\u0000\d+\u0000$/.test(t)) { flushPara(); flushList(); out.push(t); continue; }
    if (!t) { flushPara(); flushList(); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) { flushPara(); flushList(); const lv = Math.min(3, h[1].length); out.push('<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>'); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushPara(); flushList(); out.push('<hr>'); continue; }
    const q = /^&gt;\s?(.*)$/.exec(t);
    if (q) { flushPara(); flushList(); out.push('<blockquote>' + inline(q[1]) + '</blockquote>'); continue; }
    const ul = /^[-*+]\s+(.*)$/.exec(t);
    const ol = /^\d+[.)]\s+(.*)$/.exec(t);
    if (ul || ol) {
      flushPara();
      const tag: 'ul' | 'ol' = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(ul ? ul[1] : (ol as RegExpExecArray)[1]);
      continue;
    }
    flushList();
    para.push(t);
  }
  flushPara();
  flushList();

  return out.join('').replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)] ?? '');
}
