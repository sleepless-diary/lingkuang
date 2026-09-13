/* 前置：给「编辑器文件树」套件（editor-tree.cjs）播一份**确定起点**的测试数据。
 *
 * 用户 2026-09-13 的原话：「就是编辑器的树现在只能显示事件节点，其他结构体的文件夹没有在树里面」
 * ⇒ 树要跟**硬盘上的文件夹**一一对应，所以这份种子必须让「有内容的」和「空着的」两类都在场：
 *   ① 节点结构体（formats.json）：`事件`（有 2 个节点）+ `战斗`（**一个节点都没有**）；
 *   ② 实体类型（entityTypes）：`角色`（1 个实体）+ `地点`（**一个实体都没有**）；
 *   ③ 两个节点放在同一个种类文件夹里（`<世界>/主线/事件/`），战斗文件夹**不建**（没节点就不该有目录）。
 *
 * ⚠️ 只许跑在测试目录上（LINGKUANG_TEST_DATA / LINGKUANG_VAULT 指向 %TEMP% 的副本）。
 * ⚠️ 全新目录要**先起一次应用**写出 worldbuilding.json 再来播种（否则第一步 readFileSync 就 ENOENT）。
 */
const fs = require('fs');
const path = require('path');
const DATA = process.env.LINGKUANG_TEST_DATA;
const VAULT = process.env.LINGKUANG_VAULT;
const WS = '测试世界观';
const TL = '主线';
const TLID = 'tl-主线';
const KIND = '事件';
if (!DATA || !VAULT) { console.log('FAIL 需要 LINGKUANG_TEST_DATA / LINGKUANG_VAULT'); process.exit(1); }

/* 节点结构体：整份写出（main.js 的 loadFormatsRaw 只要文件能解析就**直接用**，不跟内建合并）
   ⇒ 「战斗」这个空种类能不能出现在树里，完全取决于这份文件里有没有它。 */
const FORMATS = path.join(path.dirname(DATA), 'formats.json');
fs.writeFileSync(FORMATS, JSON.stringify({
  [KIND]: { id: KIND, name: KIND, fields: [{ name: '地点', type: 'text' }, { name: '规模', type: 'text' }] },
  '战斗': { id: '战斗', name: '战斗', fields: [{ name: '交战方', type: 'text' }] },
}, null, 2), 'utf8');

/* 确定起点：清掉上一轮残留（同 id 两份 .md 会互相覆盖 —— README 铁律 4） */
for (const p of [path.join(VAULT, WS, '_设定'), path.join(VAULT, WS, TL), path.join(VAULT, '.trash')]) {
  fs.rmSync(p, { recursive: true, force: true });
}

/* ① 实体：角色 · 银发少女（地点类型故意留空） */
const entDir = path.join(VAULT, WS, '_设定', '角色');
fs.mkdirSync(entDir, { recursive: true });
const ENT = path.join(entDir, '银发少女.md');
fs.writeFileSync(ENT, [
  '---', 'id: e-tree-a', 'name: 银发少女', 'type: 角色',
  '性别: 女', '发色: 银白', '年龄: 17', '---',
  '#正文：', '雪原独行：她一个人走了很多天。', '',
].join('\n'), 'utf8');

/* ② 节点：两个都在「事件」文件夹里；「战斗」文件夹**不建** */
const kindDir = path.join(VAULT, WS, TL, KIND);
fs.mkdirSync(kindDir, { recursive: true });
const NODES = [
  ['王国的建立.md', ['id: n-tree-1', 'title: 王国的建立', 'year: 315', 'precision: day', 'type: world_event'],
    '安德希亚王国正式建国。', '第一块基石落地。'],
  ['第一次魔潮.md', ['id: n-tree-2', 'title: 第一次魔潮', 'year: 327', 'precision: month', 'type: world_event'],
    '魔潮从北境涌来。', '整片森林被冻住了。'],
];
for (const [name, fm, desc, doc] of NODES) {
  fs.writeFileSync(path.join(kindDir, name), `---\n${fm.join('\n')}\n---\n#描述：\n${desc}\n\n#正文：\n${doc}\n`, 'utf8');
}

/* ③ JSON 侧：文件是源 ⇒ 实体清空（残留会被「没有 _设定 目录就保留 base」那条例外复活）；
   世界 / 时间线 / 实体类型**自己写全**（别假设继承来的测试目录里有）—— 见 README 铁律 4。 */
const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
let w = d.worldsets[WS];
if (!w) {
  w = { name: WS, order: [], timelines: {}, docs: {}, timeCursor: null, entities: {}, entityTypes: {}, maps: {} };
  d.worldsets[WS] = w;
}
if (!w.timelines[TLID]) {
  w.timelines[TLID] = { id: TLID, name: TL, absOffset: null, nodes: [], loops: [], storylines: [] };
}
w.order = [...(w.order ?? []).filter((x) => x !== TLID), TLID];
w.entityTypes = {
  角色: { id: '角色', name: '角色', fields: [
    { name: '性别', type: 'text' }, { name: '发色', type: 'text' }, { name: '年龄', type: 'text' },
  ] },
  地点: { id: '地点', name: '地点', fields: [
    { name: '气候', type: 'text' }, { name: '人口', type: 'text' },
  ] },
};
w.entities = {};
const tl = w.timelines[TLID];
tl.nodes = [];
tl.loops = [];
tl.storylines = [];
d.activeWorld = WS;
fs.writeFileSync(DATA, JSON.stringify(d, null, 2), 'utf8');

console.log('结构体  ' + FORMATS + '  （事件 ✓ 有节点 / 战斗 ✓ 空）');
console.log('实体    ' + ENT);
console.log('节点    ×2  ' + kindDir);
console.log('已播种：节点结构体 2（其中 战斗 为空）· 实体类型 2（其中 地点 为空）· 实体 1 · 节点 2');
