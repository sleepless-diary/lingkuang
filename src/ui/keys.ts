/** 键盘事件辅助。
 *
 * 中文/日文输入法用回车「上屏候选词」，这不是「提交/发送」。
 * IME 组字期间浏览器先派发 `isComposing === true` 的 keydown（老实现只给 keyCode 229），
 * 不拦掉就会一边上屏一边提交表单/发送消息（roleplay 还会顺手清空输入框，未上屏内容直接丢）。 */
export function isImeEnter(e: KeyboardEvent): boolean {
  /* keyCode 已废弃，但 IME 组字期部分环境只给 229 不给 isComposing，两个都判 */
  return e.isComposing || e.keyCode === 229;
}
