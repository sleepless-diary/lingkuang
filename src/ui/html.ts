/** HTML 转义——外部文本插进 innerHTML 前必须过一遍。
 *
 *  节点标题、时间线名、剧情线名、地图/区域名全部来自 vault 的 .md frontmatter
 *  和用户输入。直接拼进 innerHTML 会让标题里的 `<div>` 变成真标签、`"` 逃出属性值
 *  （例如 title="{区域名}"）；渲染进程手里有 vault 读写桥，所以按注入对待。
 *
 *  `&` 必须最先替换，否则后面的 `&lt;` 会被二次转义成 `&amp;lt;`。 */
export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
