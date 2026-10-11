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

/* ── 滚动纪律（用户 2026-10-11：「输出的时候划不动对话列表」「流式输出的时候只能看到最顶部」）──
   旧写法每来一片增量就 `scrollTop = scrollHeight`，两条毛病：
     ① 创作者往回翻的**每一帧**都被拽回底部 ⇒ 列表"划不动"（想看上面那几句根本停不住）；
     ② 思考块**自己**那个 240px 的滚动盒（`.lk-think__body`）从来没被滚过 ⇒ 思考一超过 240px
        就只能看见最顶部那一屏，底下新长出来的全在裁剪区外（＝"新内容被截断了"）。
   现在两条规矩：**贴底才跟**（动手前先看他本来在不在底部，已经往上翻了就不打扰他）、
   思考块**内外一起跟**。`24px` 是"算不算在底部"的容差（和浏览器滚动条的取整误差同量级）。 */
function nearBottom(el: HTMLElement | null): boolean {
  if (!el) return false;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
}
function stick(el: HTMLElement | null, keep: boolean): void {
  if (el && keep) el.scrollTop = el.scrollHeight;
}

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

  const paint = (html: string, keepBottom: boolean): void => {
    body.innerHTML = html;
    stick(scroller, keepBottom);
  };

  return {
    root: wrap,
    push(delta: string): void {
      if (done || !delta) return;
      const keep = nearBottom(scroller);   /* ⚠️ 必须在改 innerHTML **之前**量 */
      acc += delta;
      paint(mdToHtml(acc) + CARET, keep);
    },
    placeholder(text: string): void {
      if (done) return;
      paint('<div class="lk-md__wait">' + mdToHtml(text) + '</div>' + CARET, nearBottom(scroller));
    },
    finish(text?: string): void {
      if (done) return;
      done = true;
      if (typeof text === 'string') acc = text;
      body.classList.remove('is-live');
      paint(mdToHtml(acc), nearBottom(scroller));
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

/* ── 「思考」块（用户 2026-09-26：「看不到他的思考诶，怎么办」）─────────────────────────
   `src/ui/ai.ts` 一直在收 `reasoning_content`（DeepSeek 兼容）/ `thinking`（Ollama），
   但只当"正文为空时的兜底" ⇒ 界面上一个字都看不见。这里把它画成一块**可折叠的思考**：
     · 生成中：`open` + `.is-live`（看得见它在想什么，边想边长）；
     · 落定后：自动折叠成一行「思考 · N 字」，点一下展开（想回看时还在）。
   历史里的那一条走 `thinkBlockHtml()` —— 同一种 DOM 形状（`details.lk-think`），默认折叠。
   ⚠️ 思考是**明文**不是 markdown（模型吐的是草稿，不该被 `**` 渲染成粗体），所以全程转义。 */
const escText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 历史里那条思考（折叠态）。空文本返回空串 ⇒ 调用方可以直接拼 */
export function thinkBlockHtml(text: string, label = '思考'): string {
  if (!text) return '';
  return '<details class="lk-think"><summary class="lk-think__sum">' + escText(label) + ' · ' + text.length +
    ' 字</summary><div class="lk-think__body">' + escText(text) + '</div></details>';
}

export interface LiveThinkOpts {
  /** 标题（默认「思考」） */
  label?: string;
  /** 自动滚到底的容器（默认 = 挂载的父元素） */
  scroll?: HTMLElement | null;
  /** 初始是否摊开（默认摊开 —— 用户要的就是"看得见"） */
  open?: boolean;
}

export interface LiveThink {
  root: HTMLElement;
  push(delta: string): void;
  /** 落定：折叠起来（不传 = 用累积到的文本）。真值以 `AiReply.reasoning` 为准时传进来对齐 */
  finish(text?: string): void;
  remove(): void;
  text(): string;
}

export function liveThink(parent: HTMLElement, o: LiveThinkOpts = {}): LiveThink {
  const label = o.label ?? '思考';
  const det = document.createElement('details');
  det.className = 'lk-think is-live';
  det.open = o.open !== false;
  const sum = document.createElement('summary');
  sum.className = 'lk-think__sum';
  const body = document.createElement('div');
  body.className = 'lk-think__body';
  det.appendChild(sum);
  det.appendChild(body);
  parent.appendChild(det);
  const scroller = o.scroll === undefined ? parent : o.scroll;

  let acc = '';
  let done = false;
  /* ⭐ 内外一起跟（见文件头「滚动纪律」）：`outer` = 消息列表，`inner` = 思考块自己那个
     `max-height:240px; overflow-y:auto` 的滚动盒 —— 它是"思考的视口"，不跟就只能看最顶部。 */
  const paint = (outerKeep: boolean, innerKeep: boolean): void => {
    body.textContent = acc;
    sum.textContent = label + (acc ? ' · ' + acc.length + ' 字' : '');
    stick(scroller, outerKeep);
    stick(body, innerKeep);
  };
  paint(nearBottom(scroller), true);

  return {
    root: det,
    push(delta: string): void {
      if (done || !delta) return;
      const ko = nearBottom(scroller);
      const ki = nearBottom(body);
      acc += delta;
      paint(ko, ki);
    },
    finish(text?: string): void {
      if (done) return;
      done = true;
      if (typeof text === 'string') acc = text;
      /* 一句思考都没有（模型不思考 / 这次没吐）⇒ 整块摘掉，别留一个空的「思考」标题 */
      if (!acc) { det.remove(); return; }
      paint(nearBottom(scroller), nearBottom(body));
      det.classList.remove('is-live');
      det.open = false;
    },
    remove(): void {
      done = true;
      det.remove();
    },
    text(): string {
      return acc;
    },
  };
}
