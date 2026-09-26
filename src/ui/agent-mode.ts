/** 灵框 · 助手的两种工作模式（用户 2026-09-26 定的方向）
 *
 *  用户原话：「**我想让灵框平常是正常的聊天及工作，但是少数情况下有 agent 工作能力**」。
 *  ⇒ 目的：**默认是普通聊天/创作助手**（轻、快、不打扰）；只有创作者显式切进 agent 时，
 *  助手才拿到"能动手"的那一套（动作协议 + 写工具 + 权限闸门 + 提议卡片）。
 *
 *  这个模块只管**模式本身，以及它带来的提示词差异**（与 `agent-perm.ts` 分工一致：
 *  那边管"允许做到哪一步"这个长期设定，这边管"这次要不要让它动手"）：
 *   · `chat`：系统提示里**不出现**动作协议（`toolsPrompt()`）与权限段；模型的回复一律当聊天，
 *     不做 `parseToolCall`、不做格式纠错轮 —— 平常聊天不该被 JSON 协议带偏
 *     （本地 7B 尤其明显：喂了协议就会时不时吐半截 JSON 给你看）。
 *   · `agent`：片 3 那一套全开，写动作还要过 `src/ui/agent-perm.ts` 的 `gateWrite()`。
 *
 *  ⚠️ 模式**不落盘、不进设置**：它是"这一次我要它动手"的临时授权，
 *  面板每次打开都从 `chat` 开始 —— 否则「少数情况」会变成"忘了切回来"，下次一开口它就动数据了。
 *  权限（`agentScope` / `agentAsk`）才是长期设定，存在 `localStorage['lingkuang-settings']`。
 */
export type AgentMode = 'chat' | 'agent';

export const MODES: AgentMode[] = ['chat', 'agent'];

export const MODE_LABEL: Record<AgentMode, string> = { chat: '聊天', agent: 'Agent' };

/** 面板上给用户看的一句话说明（切模式时立刻换） */
export const MODE_HINT: Record<AgentMode, string> = {
  chat: '平常就是聊天：它只出建议，不会动你的数据。',
  agent: '已把「动手」的能力交给它：能查、能改，写入要过下面那关。',
};

/** 拼进系统提示的那一段。
 *  agent 模式返回空串（提示词由 `permissionPrompt()` + `toolsPrompt()` 说，不在这里重复）；
 *  chat 模式必须**明说没有动手能力** —— 否则创作者说「帮我把发色改一下」，
 *  模型会顺着答「已经帮你改好了」，而数据一点没动（这是最伤信任的一类谎报）。 */
export function modePrompt(mode: AgentMode): string {
  if (mode === 'agent') return '';
  return [
    '【你现在是「聊天」模式】你只能聊天：读不到动作、也改不了灵框里的任何数据。',
    '要改稿子时，把改动写成创作者能直接抄走的话（例如「把『霜精灵』的发色改成银白」），',
    '不要说「我已经改好了 / 已更新」这类话，也不要输出 JSON 指令 —— 那条通道现在没开。',
  ].join('');
}
