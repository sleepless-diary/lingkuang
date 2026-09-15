/* 前置：给「帧条（演变）展开/收起的错峰顺序」套件播一份**确定起点**的数据。
 *
 * 为什么需要专门一份：那条需求是「**离已有帧节点越近的越先出现**；退场则**越远的越先退场**」——
 * 要断言顺序，就必须让"已有帧"和"还没帧"的行程**交错**，而且每一格到最近版本的距离各不相同。
 *
 * 落点（6 个事件节点，只有第 1、6 个有版本 ⇒ 四个虚化格**离"最近的一版"的距离有两个档**）：
 *   初稿   ← 永远在的那一行（也算"已有的"，其余格子以它为一端）
 *   n-ro-1 起点之年   有版本   距离 0
 *   n-ro-2 北境霜降   没版本   距离 1   （挨着 n-ro-1）
 *   n-ro-3 王国的建立 没版本   距离 2
 *   n-ro-4 第一次魔潮 没版本   距离 2
 *   n-ro-5 霜冠加冕   没版本   距离 1   （挨着 n-ro-6）
 *   n-ro-6 北境的黄昏 有版本   距离 0
 *  ⇒ 展开（近的先）：n-ro-2 → n-ro-5 → n-ro-3 → n-ro-4（延迟 0/14/28/42ms）
 *     收起（远的先）：n-ro-3 → n-ro-4 → n-ro-2 → n-ro-5
 *  ⚠️ 为什么**两端都放版本**（而不是"前两个有版本"）：两端夹着的时候，距离顺序与 DOM 顺序**不一样**
 *     （DOM 是 n-ro-2/3/4/5），"按距离排"这件事才**证得出来** —— 单端排列时距离恰好随 DOM 递增，
 *     顺序对了也可能是"根本没排序、只是照着 DOM 走"（第一版就踩了这个：A/B 在旧代码上也全绿）。
 *  ⚠️ 同距离的两格靠 DOM 顺序定先后（`Array.prototype.sort` 稳定）—— 断言里因此只要求
 *     "距离单调"，不要求"同距离谁先"。
 *
 * ⚠️ 帧写在 `.md` 的 `#演变：` 段里（vault 是"文件为源"，JSON 里的 frames 会被文件覆盖成空），
 *    格式与 `main.js` 的 `framesToMd()` 一致 —— `parseFrames()` 只要求每帧有 `nodeId`+`patch`。
 * ⚠️ 只许跑在测试目录上（LINGKUANG_TEST_DATA / LINGKUANG_VAULT 指向 %TEMP% 的副本）。
 * ⚠️ 全新目录要**先起一次应用**写出 worldbuilding.json，再跑本脚本（第一步 readFileSync 会 ENOENT）。
 */
const fs = require('fs');
const path = require('path');
const DATA = process.env.LINGKUANG_TEST_DATA;
const VAULT = process.env.LINGKUANG_VAULT;
const WS = '测试世界观';
const TL = '主线';
const KIND = '事件';
const TLID = 'tl-主线';
if (!DATA || !VAULT) { console.log('FAIL 需要 LINGKUANG_TEST_DATA / LINGKUANG_VAULT'); process.exit(1); }

const FORMATS = path.join(path.dirname(DATA), 'formats.json');
fs.writeFileSync(FORMATS, JSON.stringify({
  [KIND]: { id: KIND, name: KIND, fields: [{ name: '地点', type: 'text' }] },
}, null, 2), 'utf8');

/* 确定起点：清掉上一轮残留（同 id 两份 .md 会互相覆盖 —— README 铁律 4） */
for (const p of [path.join(VAULT, WS, '_设定'), path.join(VAULT, WS, TL), path.join(VAULT, '.trash')]) {
  fs.rmSync(p, { recursive: true, force: true });
}

const NODES = [
  ['n-ro-1', '起点之年', 100],
  ['n-ro-2', '北境霜降', 200],
  ['n-ro-3', '王国的建立', 300],
  ['n-ro-4', '第一次魔潮', 400],
  ['n-ro-5', '霜冠加冕', 500],
  ['n-ro-6', '北境的黄昏', 600],
];
const kindDir = path.join(VAULT, WS, TL, KIND);
fs.mkdirSync(kindDir, { recursive: true });
for (const [id, title, year] of NODES) {
  fs.writeFileSync(path.join(kindDir, `${title}.md`),
    `---\nid: ${id}\ntitle: ${title}\nyear: ${year}\nprecision: day\ntype: world_event\n---\n#描述：\n${title}。\n`,
    'utf8');
}

/** 一帧 = 挂在某个事件节点上的一次改动（形状与 `frameDiff` 产出一致） */
const frame = (nodeId, set, note) => ({ nodeId, world: WS, tlId: TLID, note, patch: { set } });
const FRAMES = [frame('n-ro-1', { 年龄: '18' }, '起点之年'), frame('n-ro-6', { 年龄: '30' }, '黄昏之前')];
const entPath = path.join(VAULT, WS, '_设定', '角色', '银发少女.md');
fs.mkdirSync(path.dirname(entPath), { recursive: true });
fs.writeFileSync(entPath, `---\nid: e-ro-a\nname: 银发少女\ntype: 角色\n性别: 女\n种族: 人类\n年龄: 17\n发色: 银白\n`
  + `---\n#正文：\n雪原独行。\n\n#演变：\n每帧只记与上一帧的区别（叠加在上面 frontmatter 的初稿上）；锚点是时间线上的事件节点。\n\n`
  + '```json\n' + JSON.stringify(FRAMES, null, 2) + '\n```\n', 'utf8');

/* JSON 侧：世界/时间线/类型模板自己写全（节点交给 vault 扫描，别指望继承来的测试目录） */
const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
let w = d.worldsets[WS];
if (!w) {
  w = { name: WS, order: [], timelines: {}, docs: {}, timeCursor: null, entities: {}, entityTypes: {}, maps: {} };
  d.worldsets[WS] = w;
}
w.timelines = { [TLID]: { id: TLID, name: TL, absOffset: null, nodes: [], loops: [], storylines: [] } };
w.order = [TLID];
w.entityTypes = {
  角色: { id: '角色', name: '角色', fields: [
    { name: '性别', type: 'text' }, { name: '种族', type: 'text' }, { name: '年龄', type: 'text' },
    { name: '发色', type: 'text' },
  ] },
};
w.entities = {};
w.timeCursor = 3.1e10;   /* 远超所有节点 ⇒ "离指针最近的版本"不会有歧义 */
fs.writeFileSync(DATA, JSON.stringify(d, null, 2), 'utf8');

console.log(`节点 ×${NODES.length}  ${kindDir}`);
console.log(`实体  ${entPath}   （n-ro-1 第 1 版 · n-ro-6 第 2 版 —— 中间 4 格离"最近的一版"分别是 1/2/2/1 行）`);
console.log('已播种：6 节点 / 1 实体 2 帧 / timeCursor=3.1e10');
