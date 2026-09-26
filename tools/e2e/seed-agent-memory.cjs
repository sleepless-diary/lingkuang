/* 播种助手的「长期记忆」起点：`<dirname(LINGKUANG_TEST_DATA)>/agent/memory.json`（**裸数组**）。
 *
 * 为什么要预置一条：套件要证明「**启动时从磁盘读回来的记忆进面板**」——
 * 那是"记忆是创作者资产、关掉应用也还在"的唯一证据（只在内存里加一条是证明不了的）。
 * 顺便把 chat.json 清成空数组，免得上一轮的对话混进「从对话里总结」。
 *
 * 用法（跟其它 seed 一样，必须在**起应用之前**、同一次 pwsh 调用里跑）：
 *   node tools/e2e/seed-agent-memory.cjs
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
fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify([
  { id: 'm-seed-1', text: '人名喜欢两三个字', at: 1758000000000, src: 'manual' },
], null, 2), 'utf8');
fs.writeFileSync(path.join(dir, 'chat.json'), '[]', 'utf8');

// 顺手清掉测试 userData 里的 localStorage：★1 要断言「默认档 = 可写 + 每次确认」，
// 而上一轮跑完会把 `agentScope: 'workspace', agentAsk: 'never'`（直接执行）留在 localStorage 里 ——
// 脏起点会让那条断言假挂（2026-09-15 实测：连跑第二遍 ★1 报 `cur:"yolo"`，14/15；片 4 之后键名是
// agentScope/agentAsk）。只在 LINGKUANG_TEST_USERDATA 存在时才清 —— 绝不能碰用户正式 userData。
const ud = process.env.LINGKUANG_TEST_USERDATA;
if (ud) {
  fs.rmSync(path.join(ud, 'Local Storage'), { recursive: true, force: true });
  console.log('  已清掉 localStorage（' + path.join(ud, 'Local Storage') + '）');
}

console.log('已播种助手记忆起点：1 条手写偏好「人名喜欢两三个字」（id m-seed-1），对话历史清空');
console.log('  ' + dir);
