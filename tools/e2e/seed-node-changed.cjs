/* 前置：给「这件事改变了谁」（节点侧的反向视图）套件播一份**确定起点**的测试数据。
 *
 * 与 `seed-evolution.cjs` 的差别只有一处：**帧是播种时就写在 `.md` 里的**（不是靠界面点出来）。
 * 为什么要这样：本套件要断言"站在某个事件上，看到它改动了哪几条设定"，所以需要一份**已知的**
 * 帧分布 —— 界面点出来的帧依赖上一轮套件跑没跑、跑了几遍（脏状态），断言会飘。
 *
 * 帧的落点（`Entity.frames[].nodeId`）就是本套件的被测关系：
 *   银发少女  → n-evo-1（第 1 版）· n-evo-2（第 2 版）   ← 两个事件都改过它
 *   霜纹剑    → n-evo-2（第 1 版）
 *   守夜人队长 → 没有帧                                ← **不该出现在任何"改变了谁"里**
 *   n-evo-3（霜冠加冕）一个帧都没有                     ← 空态的断言对象
 *
 * ⚠️ 帧是写在 `.md` 的 `#演变：` 段里的（vault 是"文件为源"：JSON 里的 frames 会被文件覆盖成空），
 *    格式与 `main.js` 的 `framesToMd()` 一模一样 —— `parseFrames()` 只要求每帧有 `nodeId`+`patch`。
 * ⚠️ 只许跑在测试目录上（LINGKUANG_TEST_DATA / LINGKUANG_VAULT 指向 %TEMP% 的副本）。
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
  [KIND]: { id: KIND, name: KIND, fields: [{ name: '地点', type: 'text' }, { name: '规模', type: 'text' }] },
}, null, 2), 'utf8');

/* 确定起点：清掉上一轮残留（同 id 两份 .md 会互相覆盖 —— README 铁律 4） */
for (const p of [path.join(VAULT, WS, '_设定'), path.join(VAULT, WS, TL), path.join(VAULT, '.trash')]) {
  fs.rmSync(p, { recursive: true, force: true });
}

/** 一帧 = 挂在某个事件节点上的一次改动（与 `frameDiff` 产出的形状一致） */
const frame = (nodeId, set, note) => ({ nodeId, world: WS, tlId: TLID, note, patch: { set } });

/** 实体 .md：frontmatter + `#正文：` + `#演变：`（后者与 main.js 的 framesToMd 同格式） */
const ent = (rel, lines, doc, frames) => {
  const p = path.join(VAULT, WS, '_设定', rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const evo = frames && frames.length
    ? '\n#演变：\n每帧只记与上一帧的区别（叠加在上面 frontmatter 的初稿上）；锚点是时间线上的事件节点。\n\n```json\n'
      + JSON.stringify(frames, null, 2) + '\n```\n'
    : '';
  fs.writeFileSync(p, `---\n${lines.join('\n')}\n---\n#正文：\n${doc}\n${evo}`, 'utf8');
  return p;
};

const DOC_A = ['雪原独行：她一个人走了很多天。', '雪没到膝盖，风从北边来。', '她敲了门。'].join('\n\n');
const DOC_B = ['剑柄缠着一段旧皮绳。', '它已经很久没有真正出过鞘了。'].join('\n\n');
const DOC_C = ['守夜人队长的名册上，记着每一个没回来的人。'].join('\n\n');

const A = ent('角色/银发少女.md', [
  'id: e-evo-a', 'name: 银发少女', 'type: 角色',
  '性别: 女', '种族: 人类', '年龄: 17', '发色: 银白', '瞳色: 冰蓝', '身高: 162',
  '外貌: 银发垂到腰际，眼尾有一颗小痣。', '性格: 话少，认死理。', '能力: 霜。', '所属: 守夜人',
  '别名: [银发, 雪女]',
], DOC_A, [
  frame('n-evo-1', { 年龄: '18' }, '建国那年她刚出北境'),
  frame('n-evo-2', { 年龄: '21', 发色: '雪白' }, '魔潮之后'),
]);
const B = ent('物品/霜纹剑.md', [
  'id: e-evo-b', 'name: 霜纹剑', 'type: 物品',
  '种类: 单手剑', '持有者: 银发少女', '能力: 出鞘结霜。', '说明: 剑身有霜的花纹。',
], DOC_B, [
  frame('n-evo-2', { 持有者: '北境女王' }, '易主'),
]);
const C = ent('角色/守夜人队长.md', [
  'id: e-evo-c', 'name: 守夜人队长', 'type: 角色',
  '性别: 男', '种族: 人类', '年龄: 44', '发色: 灰', '瞳色: 褐', '身高: 178',
  '外貌: 脸上有旧疤。', '性格: 寡言。', '能力: 无。', '所属: 守夜人',
  '别名: [队长]',
], DOC_C, []);   /* ← 一条帧都没有：不该出现在"这件事改变了谁"里 */

const NODES = [
  ['王国的建立.md', ['id: n-evo-1', 'title: 王国的建立', 'year: 315', 'precision: day', 'type: world_event'],
    '安德希亚王国正式建国。', '第一块基石落地。'],
  ['第一次魔潮.md', ['id: n-evo-2', 'title: 第一次魔潮', 'year: 327', 'precision: month', 'type: world_event'],
    '魔潮从北境涌来。', '整片森林被冻住了。'],
  ['霜冠加冕.md', ['id: n-evo-3', 'title: 霜冠加冕', 'year: 350', 'precision: day', 'type: world_event'],
    '她在霜冠之下加冕。', '北境第一次有了女王。'],
];
const kindDir = path.join(VAULT, WS, TL, KIND);
fs.mkdirSync(kindDir, { recursive: true });
for (const [name, fm, desc, doc] of NODES) {
  fs.writeFileSync(path.join(kindDir, name), `---\n${fm.join('\n')}\n---\n#描述：\n${desc}\n\n#正文：\n${doc}\n`, 'utf8');
}

/* JSON 侧：世界/时间线/类型模板都自己写全（别指望继承来的测试目录 —— 字段模板缺字段会让断言假挂） */
const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
let w = d.worldsets[WS];
if (!w) {
  w = { name: WS, order: [], timelines: {}, docs: {}, timeCursor: null, entities: {}, entityTypes: {}, maps: {} };
  d.worldsets[WS] = w;
}
if (!w.timelines[TLID]) {
  w.timelines[TLID] = { id: TLID, name: TL, absOffset: null, nodes: [], loops: [], storylines: [] };
  w.order = [...(w.order ?? []).filter((x) => x !== TLID), TLID];
}
const ROLE_FIELDS = [
  { name: '性别', type: 'text' }, { name: '种族', type: 'text' }, { name: '年龄', type: 'text' },
  { name: '发色', type: 'text' }, { name: '瞳色', type: 'text' }, { name: '身高', type: 'text' },
  { name: '外貌', type: 'longtext' }, { name: '性格', type: 'longtext' }, { name: '能力', type: 'longtext' },
  { name: '所属', type: 'text' }, { name: '别名', type: 'list' },
];
w.entityTypes = {
  角色: { id: '角色', name: '角色', fields: ROLE_FIELDS },
  物品: { id: '物品', name: '物品', fields: [
    { name: '种类', type: 'text' }, { name: '持有者', type: 'text' },
    { name: '能力', type: 'text' }, { name: '说明', type: 'longtext' },
  ] },
};
w.entities = {};
const tl = w.timelines[TLID];
if (tl) { tl.nodes = []; tl.loops = []; tl.storylines = []; }
w.timeCursor = 3.1e10;   /* 远超所有节点 ⇒ "离指针最近的一版"不会有歧义 */
fs.writeFileSync(DATA, JSON.stringify(d, null, 2), 'utf8');

console.log('实体  ' + A + '   （n-evo-1 → 第 1 版，n-evo-2 → 第 2 版）');
console.log('实体  ' + B + '   （n-evo-2 → 第 1 版）');
console.log('实体  ' + C + '   （没有帧 —— 负例）');
console.log('节点  ×3   ' + kindDir + '   （n-evo-3 没有任何帧 —— 空态）');
console.log('已播种：银发少女 2 帧 · 霜纹剑 1 帧 · 守夜人队长 0 帧 · timeCursor=3.1e10');
