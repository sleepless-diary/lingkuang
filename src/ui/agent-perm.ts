/** 灵框 · 助手「能动手到什么程度」的闸门（两个**正交**旋钮）
 *
 *  用户 2026-09-15 定的方向：「**和真 agent 软件一样，有禁止，部分执行和 YOLO 什么的**」；
 *  2026-09-26 又把它收窄到「**平常是正常的聊天及工作，但是少数情况下有 agent 工作能力**」⇒
 *  权限只在 **Agent 模式**下有意义（聊天模式根本不动手，见 `src/ui/agent-mode.ts`）。
 *
 *  两个旋钮（都存 `localStorage['lingkuang-settings']`：这是"我允许这个助手做什么"的**长期设定**，
 *  该跟模型选择放一起，关掉助手也不该忘）：
 *   · 范围 `agentScope`：`readonly`（一个字都不许改）/ `workspace`（可以写这个世界的设定与事件）
 *   · 询问 `agentAsk`  ：`always`（每次改动出一张提议卡片等你点「应用」）/ `never`（直接执行）
 *
 *  组合出三种实际行为，与片 2~4 的单档 `readonly|confirm|yolo` 一一对应：
 *   readonly+always → `deny`    = 只读
 *   workspace+always → `propose` = 逐项确认
 *   workspace+never  → `allow`   = 直接执行（原来的「YOLO」）
 *   readonly+never   → `deny`    = 「直接执行」对只读没有意义 —— **闸门先看范围**
 *
 *  ⚠️ 写入实现只有一条（`src/ui/agent-tools.ts` 的 `Proposal.apply()`），
 *  权限只决定「拒绝 / 出卡片等点头 / 直接执行」。
 */
import { loadSettings, saveSettings, type AgentAsk, type AgentScope } from './settings';

export const SCOPES: AgentScope[] = ['readonly', 'workspace'];
export const ASKS: AgentAsk[] = ['always', 'never'];

export const SCOPE_LABEL: Record<AgentScope, string> = { readonly: '只读', workspace: '可写' };
export const ASK_LABEL: Record<AgentAsk, string> = { always: '每次确认', never: '直接执行' };

/** 两个旋钮的组合叫什么（沿用老的三个名字 —— 创作者不用重新学一套词汇） */
export function permName(scope: AgentScope, ask: AgentAsk): string {
  if (scope === 'readonly') return '只读';
  return ask === 'always' ? '逐项确认' : '直接执行';
}

/** 面板里给用户看的一句话说明（按**组合**说：单看"可写"不知道它会不会先问你） */
export function permHint(scope: AgentScope, ask: AgentAsk): string {
  if (scope === 'readonly') return '助手只能看，不会动你的稿子——建议会写成可以直接抄走的一段';
  return ask === 'always'
    ? '助手想改稿子会先给你一张提议卡片，你点「应用」才落盘'
    : '助手可以自己改稿子（改动仍进撤销栈，但不再逐条问你）';
}

export function getAgentScope(): AgentScope {
  return loadSettings().agentScope;
}

export function getAgentAsk(): AgentAsk {
  return loadSettings().agentAsk;
}

/** 两个旋钮一起读（闸门与提示词都要用，省一次解析） */
export function getAgentKnobs(): { scope: AgentScope; ask: AgentAsk } {
  const cfg = loadSettings();
  return { scope: cfg.agentScope, ask: cfg.agentAsk };
}

/** 只改一个旋钮、另一个保持不动；**变了才存**并广播（面板的提示文案跟着换） */
function save(next: { scope?: AgentScope; ask?: AgentAsk }): void {
  const cfg = loadSettings();
  const scope = next.scope ?? cfg.agentScope;
  const ask = next.ask ?? cfg.agentAsk;
  if (scope === cfg.agentScope && ask === cfg.agentAsk) return;
  saveSettings({ ...cfg, agentScope: scope, agentAsk: ask });
  window.dispatchEvent(new CustomEvent('lingkuang-agent-perm', { detail: { scope, ask } }));
}

export function setAgentScope(s: AgentScope): void {
  save({ scope: s });
}

export function setAgentAsk(a: AgentAsk): void {
  save({ ask: a });
}

/** 写操作的闸门：`deny` 不许写 / `propose` 要变成提议卡片 / `allow` 直接执行。
 *  Agent 模式的每个写工具在动手之前都必须先问它（`src/ui/agent.ts` 的 `handleWrite()`）。 */
export function gateWrite(): 'deny' | 'propose' | 'allow' {
  const { scope, ask } = getAgentKnobs();
  if (scope === 'readonly') return 'deny';   /* 范围优先：只读时"直接执行"无从谈起 */
  return ask === 'always' ? 'propose' : 'allow';
}

/** 拼进系统提示的那一段：让模型知道自己的手被绑到哪一步（否则它会一口答应"我帮你改好了"）。
 *  只在 **Agent 模式**下拼（聊天模式由 `src/ui/agent-mode.ts` 的 `modePrompt()` 说"你只能聊天"）。 */
export function permissionPrompt(): string {
  const { scope, ask } = getAgentKnobs();
  if (scope === 'readonly') {
    return '【你的权限：只读】你现在改不了任何东西。要给改动时，写成"把某条改成某样"的完整建议，让创作者自己抄过去，不要说你已经改了。';
  }
  if (ask === 'always') {
    return '【你的权限：逐项确认】你可以提出改动，但每一处改动都要等创作者点「应用」才真的生效。请把要改的地方说清楚（改哪一条、改成什么），不要声称已经改好。';
  }
  return '【你的权限：直接执行】创作者已允许你直接执行改动，不必逐条确认。执行完请用一句话说明你改了什么。';
}
