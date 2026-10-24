/** 灵框 · 外观主题（2026-10-24 用户：「给灵框整体多做几个可选风格」）
 *
 *  做法：token 仍然是**唯一颜色来源**（`design-system/tokens.css`）。
 *  主题 = 在 `<html data-theme="…">` 上覆盖那一组颜色 token，其余（字号/间距/圆角/动效）不动。
 *  `warm` 是默认那套「阈限暖灰」，**不写 data-theme**（保持旧构建的 DOM 一模一样，截图对比不会假红）。
 *
 *  ⚠️ 每套主题都要保证两条口径：
 *  ① `--accent-ink` 在 `--surface` 上 ≥ 4.5:1（强调文字用它，不用 `--accent`）；
 *  ② `--fg-inverse` 在 `--chrome` 上 ≥ 7:1（左栏工具名靠它）。
 */
export type ThemeId = 'warm' | 'night' | 'paper' | 'slate';

export interface ThemeDef {
  id: ThemeId;
  name: string;
  hint: string;
  /** 预览用的三色：[底、面、强调] —— 设置面板里的色块就靠它，不需要真的切过去 */
  swatch: [string, string, string];
}

export const THEMES: ThemeDef[] = [
  { id: 'warm', name: '阈限暖灰', hint: '出厂：褪色殿堂、荧光绿、AE 工具感', swatch: ['#d8d5cc', '#17171a', '#9ec262'] },
  { id: 'night', name: '夜读', hint: '深灰底 + 暖白字，晚上写稿不刺眼', swatch: ['#1e1e21', '#0e0e10', '#a8c96e'] },
  { id: 'paper', name: '旧纸', hint: '米黄纸面 + 墨字，像摊开的手稿', swatch: ['#efe7d6', '#241f18', '#93ab54'] },
  { id: 'slate', name: '青灰', hint: '冷色工作台，强调色偏青', swatch: ['#d6dbdd', '#141a1d', '#6fa89a'] },
];

export function isThemeId(v: unknown): v is ThemeId {
  return v === 'warm' || v === 'night' || v === 'paper' || v === 'slate';
}

/** 把主题挂到 `<html>` 上；`warm` 清掉属性（= 默认样式，不额外定义） */
export function applyTheme(id: ThemeId | undefined): void {
  const root = document.documentElement;
  if (!id || id === 'warm') delete root.dataset.theme;
  else root.dataset.theme = id;
}
