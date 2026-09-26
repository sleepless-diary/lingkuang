/* 前置：播一条**带因果线（causes）**的时间线，用来复现「缩放时因果线跳位置」。
   4 个节点：一条短链（乙→丙只差 1 年，缩小到一定程度两个圆点会重叠 = 退化分支）
   + 一条跨距很大的（甲→丁，400-300=100 年，用来读"弧线随间距缩放"的连续性）。
   与 main.js 的 nodeToMd 同格式：frontmatter 里 `causes: [id, id]`（行内数组）。 */
const fs = require('fs');
const path = require('path');
const DATA = process.env.LINGKUANG_TEST_DATA;
const VAULT = process.env.LINGKUANG_VAULT;
const WS = '测试世界观';
const TL = '主线';
const KIND = '事件';
if (!DATA || !VAULT) { console.log('FAIL 需要 LINGKUANG_TEST_DATA / LINGKUANG_VAULT'); process.exit(1); }

const FORMATS = path.join(path.dirname(DATA), 'formats.json');
fs.writeFileSync(FORMATS, JSON.stringify({
  [KIND]: { id: KIND, name: KIND, fields: [{ name: '地点', type: 'text' }] },
}, null, 2), 'utf8');

const dir = path.join(VAULT, WS, TL, KIND);
/* ⚠️ 清的是**整个世界**（不只这条时间线）：上一轮套件（seed-motion / seed-storyline-focus）
   会在 worldbuilding.json 里留下**没有目录的空时间线** `tl-side`（支线），而会话恢复
   （localStorage `lingkuang-session`，存的是 `{world, timeline}`）还记得它 ⇒ 打开沙盘落在
   `支线`：屏上有刻度、**一个节点都没有**。上一轮就在这儿白跑一次探针（track 只有 1 个子元素）。
   目录 + JSON 两侧一起清，让应用**只**从本脚本写的文件重建这条线。 */
fs.rmSync(path.join(VAULT, WS), { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const node = (id, title, year, causes, body) => ({
  file: path.join(dir, title + '.md'),
  text: `---
id: ${id}
title: ${title}
year: ${year}
precision: year
type: world_event${causes.length ? `\ncauses: [${causes.join(', ')}]` : ''}
---
#描述：
${body}

#正文：
${body}
`,
});
const nodes = [
  node('n-e2e-a', '甲', 300, [], '因果链的起点。'),
  node('n-e2e-b', '乙', 340, ['n-e2e-a'], '由甲导致。'),
  node('n-e2e-c', '丙', 341, ['n-e2e-b'], '由乙导致（与乙只差 1 年 ⇒ 缩小后两圆点会重叠）。'),
  node('n-e2e-d', '丁', 400, ['n-e2e-a', 'n-e2e-c'], '由甲与丙共同导致（跨距 100 年）。'),
];
/* `LK_SEED_N=<n>`：加压夹具 —— 播 n 个节点、每个都带 causes（~1.2n 条弧线），
   用来量"弧线一多，缩放时每帧的重建成本"（4 个节点的夹具量不出卡顿）。 */
const HEAVY = Number(process.env.LK_SEED_N || 0);
if (HEAVY > 0) {
  nodes.length = 0;
  for (let i = 0; i < HEAVY; i++) {
    const id = 'n-h-' + i;
    const causes = [];
    if (i > 0) causes.push('n-h-' + (i - 1));
    if (i >= 5) causes.push('n-h-' + (i - 5));
    nodes.push(node(id, '节点' + String(i).padStart(3, '0'), 300 + i * 15, causes, '加压夹具节点 ' + i));
  }
}
for (const n of nodes) fs.writeFileSync(n.file, n.text, 'utf8');

/* 世界/时间线先在 JSON 里留个形状（与 src/store/actions.ts 的 addWorld 一致），
   免得第二遍启动扫描之前读不到；**同时清掉上一轮留下的空时间线**（见上面那段注释）。 */
const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
if (!d.worldsets[WS]) d.worldsets[WS] = { name: WS, timelines: {}, order: [], docs: {} };
const w = d.worldsets[WS];
w.timelines = {};
w.entities = {};
delete w.storylines;
fs.writeFileSync(DATA, JSON.stringify(d, null, 2), 'utf8');

console.log(`已播种 4 个带因果线的节点（甲300 / 乙340 / 丙341 / 丁400）`);
console.log('  ' + dir);
