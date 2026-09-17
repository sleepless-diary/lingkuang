/* 前置：给灵框助手播一段**对话历史**（`<数据目录>/agent/chat.json`）。
   路径算法与 `main.js` 的 `AGENT_DIR()` 一模一样（测试时跟着 LINGKUANG_TEST_DATA 走同一个临时目录）。

   为什么文件式播种：面板打开时读的就是它（IPC `agent:load`），这样测的是
   「历史真的从盘上进对话框」，而不是只测内存里那份数组。
   ⚠️ 文件格式是**裸数组**（`[{role,content},…]`），不是 `{chat:[…]}` —— main.js 的
   `agent:save` 直接 `JSON.stringify(chat.slice(-AGENT_CHAT_MAX))` 写盘，写错了会被当成"没有历史"。 */
const fs = require('fs');
const path = require('path');
const DATA = process.env.LINGKUANG_TEST_DATA;
if (!DATA) { console.log('FAIL 需要 LINGKUANG_TEST_DATA'); process.exit(1); }

const dir = path.join(path.dirname(DATA), 'agent');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const chat = [
  { role: 'user', content: '种子提问：这条时间线上主角是谁？' },
  { role: 'assistant', content: '种子回答：银发少女。' },
];
const file = path.join(dir, 'chat.json');
fs.writeFileSync(file, JSON.stringify(chat, null, 2), 'utf8');
console.log('已播种助手对话历史 2 条 →', file);
