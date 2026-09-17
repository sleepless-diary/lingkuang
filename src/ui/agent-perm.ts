/** 灵框 · 助手的权限档（三档，用户 2026-09-15 定的：「和真 agent 软件一样，有禁止，部分执行和 YOLO 什么的」）
 *
 *  档位存在设置里（`localStorage['lingkuang-settings'].agentPerm`）而不是助手的对话文件里：
 *  它是"我允许这个助手做什么"的**长期设定**，该跟模型选择放一起，关掉助手也不该忘。
 *
 *  片 2 只做**骨架**：档位能被选、能存、系统提示里会告诉模型自己现在是哪一档，面板根上还挂了
 *  `data-gate`（片 3 的写工具执行前问 `gateWrite()`；e2e 直接读这个属性，不必反射模块）。
 *  真正"逐项确认（提议卡片）"的执行体在片 3 的工具协议里。
 */
import { loadSettings, saveSettings, type AgentPerm } from './settings';

export const PERM_LABEL: Record<AgentPerm, string> = {
  readonly: '只读',
  confirm: '逐项确认',
  yolo: 'YOLO',
};

/** 面板里给用户看的一句话说明 */
export const PERM_HINT: Record<AgentPerm, string> = {
  readonly: '助手只能看，不会动你的稿子——建议会写成可以直接抄走的一段',
  confirm: '助手想改稿子会先给你一张提议卡片，你点「应用」才落盘',
  yolo: '助手可以自己改稿子（改动仍进撤销栈，但不再逐条问你）',
};

export function getAgentPerm(): AgentPerm {
  return loadSettings().agentPerm;
}

export function setAgentPerm(p: AgentPerm): void {
  const cfg = loadSettings();
  if (cfg.agentPerm === p) return;
  saveSettings({ ...cfg, agentPerm: p });
  window.dispatchEvent(new CustomEvent('lingkuang-agent-perm', { detail: { perm: p } }));
}

/** 写操作的闸门：`deny` 不许写 / `propose` 要变成提议卡片 / `allow` 直接执行。
 *  片 3 的每个写工具在动手之前都必须先问它。 */
export function gateWrite(): 'deny' | 'propose' | 'allow' {
  const p = getAgentPerm();
  if (p === 'readonly') return 'deny';
  if (p === 'confirm') return 'propose';
  return 'allow';
}

/** 拼进系统提示的那一段：让模型知道自己的手被绑到哪一步（否则它会一口答应"我帮你改好了"） */
export function permissionPrompt(): string {
  const p = getAgentPerm();
  if (p === 'readonly') {
    return '【你的权限：只读】你现在改不了任何东西。要给改动时，写成"把某条改成某样"的完整建议，让创作者自己抄过去，不要说你已经改了。';
  }
  if (p === 'confirm') {
    return '【你的权限：逐项确认】你可以提出改动，但每一处改动都要等创作者点「应用」才真的生效。请把要改的地方说清楚（改哪一条、改成什么），不要声称已经改好。';
  }
  return '【你的权限：YOLO】创作者已允许你直接执行改动，不必逐条确认。执行完请用一句话说明你改了什么。';
}
