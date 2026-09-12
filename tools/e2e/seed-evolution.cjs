/* 前置：给「演变（版本历史）」套件（entity-evolution.cjs）播一份**确定起点**的测试数据。
 *
 * 需要什么：
 *  ① 3 个事件节点，**年份不同**（315 / 327 / 350）—— 帧要按锚点时间排序，年份一样就看不出顺序；
 *  ② 1 个实体（角色·银发少女），字段齐全 + 一段够长的正文（正文差异按行存，要有行可改）；
 *  ③ 第 2 个实体（物品·霜纹剑）—— 验证"每一版历史是**每条实体自己**的，不串台"；
 *  ④ JSON 里把 `timeCursor` 设到一个**远超所有节点**的 epoch 上：套件要断言
 *     「选中实例时默认进入离指针最近的那一帧」，而这是**唯一不依赖历法换算**的写法
 *     （历法锚年/年长都不用知道，只要知道 epoch 随年份单调递增）。
 *
 * ⚠️ 只许跑在测试目录上（LINGKUANG_TEST_DATA / LINGKUANG_VAULT 指向 %TEMP% 的副本）。
 */
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
  [KIND]: { id: KIND, name: KIND, fields: [{ name: '地点', type: 'text' }, { name: '规模', type: 'text' }] },
}, null, 2), 'utf8');

/* 确定起点：清掉上一轮残留（同 id 两份 .md 会互相覆盖 —— README 铁律 4） */
for (const p of [path.join(VAULT, WS, '_设定'), path.join(VAULT, WS, TL), path.join(VAULT, '.trash')]) {
  fs.rmSync(p, { recursive: true, force: true });
}

const ent = (rel, lines, doc) => {
  const p = path.join(VAULT, WS, '_设定', rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `---\n${lines.join('\n')}\n---\n#正文：\n${doc}\n`, 'utf8');
  return p;
};
const LINES = (arr) => arr.join('\n\n');

/* 正文 16 段：① 够长（正文差异按行存，改中间一行才看得出 hunk）② 有独立的一段可以删掉 */
const DOC = LINES([
  '雪原独行：她一个人走了很多天。',
  '雪没到膝盖，风从北边来。',
  '第一天她还数着脚印，第二天就不数了。',
  '她记得每一个被她留在身后的人。',
  '风把她的头发吹成了雪的颜色。',
  '夜里她靠着石壁睡，剑放在手边。',
  '她从不生火 —— 火会把人引来。',
  '第九天，她看见了远处的灯。',
  '那盏灯在驿站的窗户里，黄得很旧。',
  '她在离驿站半里的地方停了下来。',
  '她先摸了摸剑柄，确认它还在。',
  '然后她想起来，自己已经有三天没吃东西了。',
  '雪一直在下，没有要停的意思。',
  '她往前走了一步。',
  '又一步。',
  '她敲了门。',
]);
const DOC2 = LINES([
  '剑柄缠着一段旧皮绳。',
  '出鞘的时候，空气里会浮起细小的冰晶。',
  '它不认主人，只认血。',
  '剑鞘是后配的，比剑晚了很多年。',
  '握久了，手心也会变凉。',
  '有人说这把剑的前一任主人死在了北境。',
  '剑身上的霜纹，其实是裂纹。',
  '它已经很久没有真正出过鞘了。',
]);

const A = ent('角色/银发少女.md', [
  'id: e-evo-a', 'name: 银发少女', 'type: 角色',
  '性别: 女', '种族: 人类', '年龄: 17', '发色: 银白', '瞳色: 冰蓝', '身高: 162',
  '外貌: 银发垂到腰际，眼尾有一颗小痣。', '性格: 话少，认死理。', '能力: 霜。', '所属: 守夜人',
  '别名: [银发, 雪女]',
], DOC);
const B = ent('物品/霜纹剑.md', [
  'id: e-evo-b', 'name: 霜纹剑', 'type: 物品',
  '种类: 单手剑', '持有者: 银发少女', '能力: 出鞘结霜。', '说明: 剑身有霜的花纹。',
], DOC2);

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

/* JSON 侧：文件是源，实体与节点清空（残留会被「没有 _设定 目录就保留 base」那条例外复活）。
   `timeCursor` 设成远超所有节点的值 —— 套件据此断言"默认落在最近的那一帧"。 */
const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const w = d.worldsets[WS];
if (!w) { console.log(`FAIL ${WS} 不存在于 ${DATA}`); process.exit(1); }
w.entities = {};
w.frames = undefined;
const tl = w.timelines['tl-主线'];
if (tl) { tl.nodes = []; tl.loops = []; tl.storylines = []; }
w.timeCursor = 3.1e10;   /* ≈ 公元 1000 年量级（默认历法 360 天/年）→ 一定在所有节点之后 */
fs.writeFileSync(DATA, JSON.stringify(d, null, 2), 'utf8');

console.log('实体  ' + A);
console.log('实体  ' + B);
console.log('节点  ×3（315 / 327 / 350）  ' + kindDir);
console.log(`已播种：实体 2 · 节点 3 · timeCursor=3.1e10（指针在所有节点之后）`);
