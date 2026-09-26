/* 播种「主会话 = 助手」这一片的起点：`<dirname(LINGKUANG_TEST_DATA)>/agent/`（**裸数组**，与 chat.json 同层）。
 *
 * 为什么要这样播（用户 2026-09-26：「其实我最开始的想法是主会话和助手指向的是同一个会话」）：
 *   · `chat.json` = **老版本助手自己的历史**（4 条，四类各一条）：一句话、一个答、一条**分割线**
 *     （`{role:'system',content:'',div:true}`）、一条**动作回执**（`【动作结果：set_field】…`，
 *     role 是 user）。⇒ 用来验证「一次性迁移」把这四类都并进主会话，且 AI 页会把后两类
 *     画成「分割点 / 系统回执」而不是空消息 / 创作者说的话。
 *   · `sessions.json` = 一条**空历史的「主会话」**（迁移才有得做）+ 一条**角色会话**（证明"只共享主会话"，
 *     角色会话仍各自独立 —— 它一旦被并进主会话，角色扮演的能力就串味了）。
 *
 * ⚠️ 必须在**起应用之前**跑（与其它 seed 同纪律）。
 * 用法：node tools/e2e/seed-agent-main-session.cjs
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = process.env.LK_AGENT_DIR
  ? process.env.LK_AGENT_DIR
  : process.env.LINGKUANG_TEST_DATA
    ? path.join(path.dirname(process.env.LINGKUANG_TEST_DATA), 'agent')
    : path.join(os.tmpdir(), 'lk-evault2', 'agent');

fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

/* 老助手的 chat.json：四类消息各一条，顺序就是当年真实的顺序（分割线把上面的对话切在上下文之外） */
const chat = [
  { role: 'user', content: '老助手说过的一句' },
  { role: 'assistant', content: '老助手答过的一句' },
  { role: 'system', content: '', div: true },
  { role: 'user', content: '【动作结果：set_field】现在是「只读」档，没有执行。' },
];
fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify(chat, null, 2), 'utf8');

const sessions = [
  { id: 's-main', name: '主会话', role: 'main', personaId: '', links: [], history: [], at: 1758000000000 },
  {
    id: 's-role', name: '艾德温', role: 'character', personaId: '', links: [],
    history: [
      { role: 'user', content: '角色会话自己的一句' },
      { role: 'assistant', content: '角色会话的答' },
    ],
    at: 1758000000000,
  },
];
fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(sessions, null, 2), 'utf8');
fs.writeFileSync(path.join(dir, 'memory.json'), '[]', 'utf8');

/* 顺手清掉测试 userData 里的 localStorage：上一轮可能把工具落点/活动会话留在那儿，脏起点会让
   「AI 页打开的是不是主会话」变成运气。只在 LINGKUANG_TEST_USERDATA 存在时清（绝不碰正式 userData）。 */
const ud = process.env.LINGKUANG_TEST_USERDATA;
if (ud) {
  fs.rmSync(path.join(ud, 'Local Storage'), { recursive: true, force: true });
  console.log('  已清掉 localStorage（' + path.join(ud, 'Local Storage') + '）');
}

console.log('已播种：chat.json = 4 条老历史（话/答/分割线/动作回执）；sessions.json = 空历史的「主会话」+ 角色会话「艾德温」');
console.log('  ' + dir);
