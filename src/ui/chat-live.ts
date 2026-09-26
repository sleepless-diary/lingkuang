/** 灵框 · 「活气泡」：把流式增量画进一个气泡里
 *
 *  用户 2026-09-26：「我想要流式输出」——在那之前四个聊天面都是等一整段回来再一次性画出来
 *  （`aiChat()` 拿完整回复），长回答时界面是"静着不动，然后啪地出现一大坨"。
 *
 *  用法：
 *    const live = liveBubble(box, { wrapClass: '…', innerClass: '…', bodyClass: '… lk-md', scroll: box });
 *    await aiChatStream(msgs, { onDelta: (d) => live.push(d) });
 *    live.finish(finalText);   // 落定（也可什么都不传，用累积到的文本）
 *    live.remove();            // 出错 / 不要这个气泡了
 *
 *  ⚠️ 每次 `push()` **同步**落 DOM，不用 rAF/定时器节流：测试实例是 showInactive（窗口不可见）时
 *     rAF 不跑、定时器被节流到 ~1s ⇒ 那样写出来的流式在自动化里根本看不见（本项目已栽过两次）。
 *     一次增量重画一个几 KB 的 md 是小活，不值得为它引入"看不见的中间态"。
 *  ⚠️ 气泡里写的是 `mdToHtml()` 的结果（不是明文），所以每个面都要给容器挂 `lk-md` 类拿样式。
 */
import { mdToHtml } from './md';

export interface LiveBubbleOpts {
  /** 最外层（可选，例：`lk-agent__cutwrap`） */
  wrapClass?: string;
  /** 中间层（可选，例：`lk-agent__msg is-ai`，管对齐与最大宽度） */
  innerClass?: string;
  /** 写内容的那个元素：类名（例：`lk-agent__bubble lk-md`） */
  bodyClass?: string;
  /** 写内容的那个元素：行内样式（老面板没有类名，靠 style.cssText 排版） */
  bodyStyle?: string;
  /** 自动滚到底的容器（默认 = 挂载的父元素） */
  scroll?: HTMLElement | null;
}

export interface LiveBubble {
  /** 挂上去的那个根（出错时要摘的就是它） */
  root: HTMLElement;
  /** 拿到的增量文本追加进去并重画 */
  push(delta: string): void;
  /** 覆盖显示一句状态（例：动作 JSON 不该给创作者看见时改说「正在整理成动作…」） */
  placeholder(text: string): void;
  /** 落定：停掉光标，用最终文本画一次（不传 = 用累积到的文本） */
  finish(text?: string): void;
  /** 摘掉这个气泡（出错、或整块重画前主动收尾） */
  remove(): void;
  /** 到现在为止累积到的原文（调用方要回填历史时用） */
  text(): string;
}

const CARET = '<span class="lk-md__caret"></span>';

export function liveBubble(parent: HTMLElement, o: LiveBubbleOpts = {}): LiveBubble {
  const wrap = document.createElement('div');
  if (o.wrapClass) wrap.className = o.wrapClass;
  const inner = document.createElement('div');
  if (o.innerClass) inner.className = o.innerClass;
  const body = document.createElement('div');
  if (o.bodyClass) body.className = o.bodyClass;
  if (o.bodyStyle) body.style.cssText = o.bodyStyle;
  inner.appendChild(body);
  wrap.appendChild(inner);
  parent.appendChild(wrap);

  /* 活气泡要能"原地不动地长"：`.is-live` 让 CSS 少做点过渡（不必每帧闪一次布局动画） */
  body.classList.add('is-live');

  let acc = '';
  let done = false;
  const scroller = o.scroll === undefined ? parent : o.scroll;

  const paint = (html: string): void => {
    body.innerHTML = html;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  };

  return {
    root: wrap,
    push(delta: string): void {
      if (done || !delta) return;
      acc += delta;
      paint(mdToHtml(acc) + CARET);
    },
    placeholder(text: string): void {
      if (done) return;
      paint('<div class="lk-md__wait">' + mdToHtml(text) + '</div>' + CARET);
    },
    finish(text?: string): void {
      if (done) return;
      done = true;
      if (typeof text === 'string') acc = text;
      body.classList.remove('is-live');
      paint(mdToHtml(acc));
    },
    remove(): void {
      done = true;
      wrap.remove();
    },
    text(): string {
      return acc;
    },
  };
}
