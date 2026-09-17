/** 灵框 · 助手的模型出口（片 2 起，所有 AI 调用都从这里走）
 *
 *  为什么单独一层：片 2 的「从对话里总结偏好」与片 3 的「文本 JSON 指令」都要拿到**可解析的模型输出**，
 *  而 e2e 里不能真去连 Ollama（测试机不一定装着模型，连上也跑不稳）——所以留一个**假引擎后门**：
 *  测试用 CDP 设 `window.__lkAgentMock`，正式运行时它永远是 undefined，一路走真实的 `aiChat`。
 *  这与主进程那套 `LINGKUANG_TEST_*` 是同一个思路（AGENTS.md「测试后门」）。
 *
 *  后门三种写法（都只在测试里用）：
 *    window.__lkAgentMock = '一段应答'                  // 每次都回这句
 *    window.__lkAgentMock = ['第一次的应答', '第二次…']  // 按顺序取，取到最后一个就一直用它
 *    window.__lkAgentMock = (msgs) => '看着消息想出来的'  // 想看喂进去的提示词时用（可把 msgs 存到 window 上）
 */
import { aiChat, type AiReply, type ChatMsg } from './ai';

export interface AskOpts {
  temperature?: number;
  numPredict?: number;
}

type MockReply = string | string[] | ((msgs: ChatMsg[]) => string | Promise<string>);

/** 送一组消息给模型。带 `__lkAgentMock` 时返回假应答（`model` 标成 `'mock'`，便于断言）。 */
export async function agentAsk(messages: ChatMsg[], opts?: AskOpts): Promise<AiReply> {
  const mock = (window as any).__lkAgentMock as MockReply | undefined;
  if (mock !== undefined && mock !== null) {
    let text: unknown = mock;
    if (typeof mock === 'function') text = await mock(messages);
    else if (Array.isArray(mock)) text = mock.length > 1 ? mock.shift() : mock[0];
    if (typeof text === 'string') return { text, model: 'mock' };
  }
  return aiChat(messages, opts);
}
