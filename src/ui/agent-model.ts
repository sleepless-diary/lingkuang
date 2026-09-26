/** 灵框 · 助手的模型出口（片 2 起，所有 AI 调用都从这里走）
 *
 *  为什么单独一层：片 2 的「从对话里总结偏好」与片 3 的「文本 JSON 指令」都要拿到**可解析的模型输出**，
 *  而 e2e 里不能真去连 Ollama（测试机不一定装着模型，连上也跑不稳）——所以留一个**假引擎后门**：
 *  测试用 CDP 设 `window.__lkAgentMock`，正式运行时它永远是 undefined，一路走真实的 `aiChatStream`。
 *  这与主进程那套 `LINGKUANG_TEST_*` 是同一个思路（AGENTS.md「测试后门」）。
 *
 *  后门四种写法（都只在测试里用）：
 *    window.__lkAgentMock = '一段应答'                  // 每次都回这句
 *    window.__lkAgentMock = ['第一次的应答', '第二次…']  // 按顺序取，取到最后一个就一直用它
 *    window.__lkAgentMock = (msgs) => '看着消息想出来的'  // 想看喂进去的提示词时用（可把 msgs 存到 window 上）
 *    window.__lkAgentMock = { chunks: ['一', '段', '应', '答'], reasoning: ['先想', '再答'], gap: 60, truncated: true }
 *        // **分片**：一片一片喂给 onDelta（中间隔着 gap 毫秒的真定时器）—— 流式只有跨任务才看得见，
 *        //   同一个任务里把几片喂完，自动化那边读到的永远只有最后态。`reasoning` 分片同理走
 *        //   `onReasoning`（思考先喂完、再喂正文）。
 *
 *  2026-09-26：流式落地 —— `agentAsk(messages, { onDelta })` 把增量透传给调用方（真路径走
 *  `aiChatStream`），修掉「等一整段回来再啪地画出来」。
 */
import { aiChatStream, type AiReply, type ChatMsg } from './ai';

export interface AskOpts {
  temperature?: number;
  numPredict?: number;
  /** 流式回调：拿到一块就调一次（不传 = 只要最终文本） */
  onDelta?: (delta: string) => void;
  /** 思考增量回调（模型吐 `reasoning_content`/`thinking` 时一块一次） */
  onReasoning?: (delta: string) => void;
}

type MockReply = string | string[] | ((msgs: ChatMsg[]) => string | Promise<string>) | { chunks: unknown[]; reasoning?: unknown[]; gap?: number; truncated?: boolean };

const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

/** 送一组消息给模型。带 `__lkAgentMock` 时返回假应答（`model` 标成 `'mock'`，便于断言）。 */
export async function agentAsk(messages: ChatMsg[], opts?: AskOpts): Promise<AiReply> {
  const mock = (window as any).__lkAgentMock as MockReply | undefined;
  if (mock !== undefined && mock !== null) {
    let text: unknown = mock;
    if (typeof mock === 'function') text = await mock(messages);
    else if (Array.isArray(mock)) text = mock.length > 1 ? mock.shift() : mock[0];
    /* 分片假应答：{ chunks: [...] } —— 用来测流式（一片一次 onDelta，中间隔开任务） */
    if (text && typeof text === 'object' && Array.isArray((text as { chunks?: unknown[] }).chunks)) {
      const m = text as { chunks: unknown[]; reasoning?: unknown[]; gap?: number; truncated?: boolean };
      const gap = Math.max(0, Number(m.gap ?? 60));
      /* 思考分片先喂完、再喂正文 —— 与真端点同序（`ai.ts` 的 eat() 也是思考先到） */
      const rparts = Array.isArray(m.reasoning) ? m.reasoning.map((c) => String(c)) : [];
      for (const rp of rparts) {
        opts?.onReasoning?.(rp);
        if (gap) await sleep(gap);
      }
      const parts = m.chunks.map((c) => String(c));
      for (let i = 0; i < parts.length; i++) {
        opts?.onDelta?.(parts[i]);
        if (gap) await sleep(gap);
      }
      return { text: parts.join(''), model: 'mock', truncated: m.truncated === true, reasoning: rparts.join('') };
    }
    if (typeof text === 'string') return { text, model: 'mock' };
  }
  return aiChatStream(messages, opts);
}
