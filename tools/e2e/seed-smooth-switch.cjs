/* 前置：给「设定库平滑切换」套件（codex-smooth-switch.cjs）播一份**确定起点**的测试数据。
 *
 * 为什么播种要这么麻烦：
 *  ① 同页签内换条目要能看出「内容变了、骨架没变」，所以至少要 3 个**不同类型**的实体
 *     （字段集合不同 → 换条目真的会换控件，而不只是换几个字）；
 *  ② 断言「滚动位置没回到顶部」要求面板真的可滚（实体字段多 + 正文长）；
 *  ③ 文件是源：实体与节点都直接写成 vault 的 .md（frontmatter + `#正文：`），
 *     顺手也就覆盖了扫描路径 —— 与被测代码自己写出来的格式逐字节一致
 *     （对照真机上由应用写出的 `_设定/角色/新实体.md`）。
 *
 * ⚠️ 本脚本会**清空**「测试世界观」的 `_设定`、`主线`、`.trash` —— 只许跑在测试目录上
 * （LINGKUANG_TEST_DATA / LINGKUANG_VAULT 指向 %TEMP% 的副本），别对着真实数据跑。
 */
const fs = require('fs');
const path = require('path');
const DATA = process.env.LINGKUANG_TEST_DATA;
const VAULT = process.env.LINGKUANG_VAULT;
const WS = '测试世界观';
const TL = '主线';
const KIND = '事件';
if (!DATA || !VAULT) { console.log('FAIL 需要 LINGKUANG_TEST_DATA / LINGKUANG_VAULT'); process.exit(1); }

/* 节点种类模板（决定节点属性面板有哪些字段），走 formats.json —— 与 seed-node.cjs 同格式 */
const FORMATS = path.join(path.dirname(DATA), 'formats.json');
fs.writeFileSync(FORMATS, JSON.stringify({
  [KIND]: { id: KIND, name: KIND, fields: [{ name: '地点', type: 'text' }, { name: '规模', type: 'text' }] },
}, null, 2), 'utf8');

/* 确定起点：清掉上一轮残留（同 id 的两份 .md 会互相覆盖，断言就会随机挂 —— 见 README 铁律 4） */
for (const p of [path.join(VAULT, WS, '_设定'), path.join(VAULT, WS, TL), path.join(VAULT, '.trash')]) {
  fs.rmSync(p, { recursive: true, force: true });
}

/** 写一个实体 .md：frontmatter（id/name/type + 全部字段）+ `#正文：` 标签 + 正文。
 *  ⚠️ 正文必须在**闭合的 `---` 之后** —— 第一版把 `#正文：` 也塞进了 frontmatter 里，
 *  结果主进程按标签找不到正文，实体 doc 全是空串，断言一片 FAIL（白查一轮）。 */
const ent = (rel, lines, doc) => {
  const p = path.join(VAULT, WS, '_设定', rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `---\n${lines.join('\n')}\n---\n#正文：\n${doc}\n`, 'utf8');
  return p;
};

/* 正文都要够长：断言「滚动位置不回顶」要求面板真的能滚。实测（窗口 1180×780，面板可视高 741px）：
   8 段正文 + 4 个字段的实体 scrollHeight 只有 741（刚好不滚），11 个字段的角色才 846。
   所以正文统一给足（约 16 行），让三条实体都稳在 1000px 以上。 */
const PARA = (a, b = '') => `${a}\n\n${b}`.trim();
const LINES = (arr) => arr.join('\n\n');
const D = {
  a: LINES([
    '雪原独行：她一个人走了很多天。',
    '雪没到膝盖。',
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
  ]),
  b: LINES([
    '驿站里只有一盏灯还亮着。',
    '炉火烧到后半夜。',
    '掌柜不问来客的名字，只问要不要热水。',
    '马厩里三匹马，两匹是别人的。',
    '墙上钉着一张旧地图，北边的角被撕掉了。',
    '有人说再往北就没有路了。',
    '天亮之前，风会停一小会儿。',
    '那是最适合出发的时候。',
    '二楼一共四个房间，只有两间还能住人。',
    '走廊的地板会在第三个位置响一声。',
    '掌柜说，那是老房子在认人。',
    '地窖里存着够烧一个冬天的柴。',
    '厨房的锅是补过的，补了三次。',
    '每年春天，都会有人从这里出发再也没回来。',
    '每年冬天，也会有新的人敲开这扇门。',
    '灯一直亮着，等的是谁都说不清。',
  ]),
  c: LINES([
    '剑柄缠着一段旧皮绳。',
    '出鞘的时候，空气里会浮起细小的冰晶。',
    '它不认主人，只认血。',
    '剑鞘是后配的，比剑晚了很多年。',
    '握久了，手心也会变凉。',
    '有人说这把剑的前一任主人死在了北境。',
    '剑身上的霜纹，其实是裂纹。',
    '它已经很久没有真正出过鞘了。',
    '剑的重量比看上去要轻。',
    '有人说它轻，是因为里面已经空了。',
    '磨剑的人不肯接这把剑的活。',
    '他说，磨完这把剑，他会做一整夜的噩梦。',
    '剑刃上有一道很浅的缺口。',
    '那道缺口是挡下另一把剑时留下的。',
    '另一把剑的主人现在还活着。',
    '剑在等一个能把它拔出来的人。',
  ]),
};

/* 三个实体：类型不同 ⇒ 中栏字段集合不同（换条目时"该变的东西"真的会变） */
const ENTITIES = [
  ['角色/银发少女.md', [
    'id: e-e2e-a', 'name: 银发少女', 'type: 角色',
    '性别: 女', '种族: 人类', '年龄: 17', '发色: 银白', '瞳色: 冰蓝', '身高: 162',
    '外貌: 银发垂到腰际，眼尾有一颗小痣。', '性格: 话少，认死理。', '能力: 霜。', '所属: 守夜人',
    '别名: [银发, 雪女]',
  ], D.a],
  ['地点/雪原驿站.md', [
    'id: e-e2e-b', 'name: 雪原驿站', 'type: 地点',
    '所属区域: 北境', '规模: 小镇', '气候: 常年风雪', '描述: 最后一处能补给的地方。', '别名: [北站]',
  ], D.b],
  ['物品/霜纹剑.md', [
    'id: e-e2e-c', 'name: 霜纹剑', 'type: 物品',
    '种类: 单手剑', '持有者: 银发少女', '能力: 出鞘结霜。', '说明: 剑身有霜的花纹。',
  ], D.c],
];

/* 两个节点：用来验证「节点页签内换节点也是就地换内容」 */
const NODES = [
  ['王国的建立.md', ['id: n-e2e-1', 'title: 王国的建立', 'year: 327', 'precision: day', 'type: world_event'],
    '安德希亚王国正式建国。', PARA('第一块基石落地。', '那天没有下雨。')],
  ['第一次魔潮.md', ['id: n-e2e-2', 'title: 第一次魔潮', 'year: 315', 'precision: month', 'type: world_event'],
    '魔潮从北境涌来。', PARA('整片森林被冻住了。', '幸存者说，风里带着铁锈味。')],
];

for (const [rel, fm, doc] of ENTITIES) {
  const p = ent(rel, fm, doc);
  console.log('实体  ' + p);
}

/* 再播一批「配角」：一是让左列**自己就撑得比可视区高**（断言"换条目后滚动位置不回顶"要面板真的能滚，
   而中栏的高度随字段数变，靠正文撑高度既费字又不稳），二是顺便当"一点测试数据"用。
   它们都是 角色 类型（模板字段齐全），正文短 —— 高度差异全部来自左列，换条目时几乎不变。
   ⚠️ 这个数字是**算出来的**，不是随手写的：列表行改成 `.ed-tnode` 的样式（行高 21-24px）之后，
   20 个配角撑不到中栏那么高（实测 `#cx-root` over = 0 ⇒ 面板不可滚 ⇒ ★6 没有可滚的余地而假挂）。
   算法：行高 ~22px × 行数 > 中栏高度（1440×900 下 11 字段的角色 ≈ 743px）。34 行 ≈ 750px 起。 */
const FILLER = 34;
for (let i = 1; i <= FILLER; i++) {
  const n = String(i).padStart(2, '0');
  ent(`角色/配角${n}.md`, [
    `id: e-fill-${n}`, `name: 配角${n}`, 'type: 角色',
    '性别: 男', '种族: 人类', '年龄: 30', '发色: 黑', '瞳色: 棕', '身高: 175',
    '外貌: 普通。', '性格: 谨慎。', '能力: 无。', '所属: 守夜人', '别名: []',
  ], `配角${n}的正文。`);
}
console.log(`实体  ×${FILLER} 配角（撑高左列，兼作测试数据）`);
const kindDir = path.join(VAULT, WS, TL, KIND);
fs.mkdirSync(kindDir, { recursive: true });
for (const [name, fm, desc, doc] of NODES) {
  const p = path.join(kindDir, name);
  fs.writeFileSync(p, `---\n${fm.join('\n')}\n---\n#描述：\n${desc}\n\n#正文：\n${doc}\n`, 'utf8');
  console.log('节点  ' + p);
}

/* JSON 侧清空实体与节点（文件是源，回扫会重建）—— 留下"上一轮的同 id 实体"会被
   「vault 里没有 _设定 目录就保留 base」那条例外复活，断言就乱了 */
const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const w = d.worldsets[WS];
if (!w) { console.log(`FAIL 测试世界观不存在于 ${DATA}`); process.exit(1); }
w.entities = {};
const tl = w.timelines['tl-主线'];
if (tl) tl.nodes = [];
fs.writeFileSync(DATA, JSON.stringify(d, null, 2), 'utf8');
console.log('已播种：实体 3（角色/地点/物品）· 节点 2（事件）· formats.json（事件：地点/规模）');
