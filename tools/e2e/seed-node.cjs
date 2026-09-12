/* 前置：给测试世界播一个时间线节点（含种类模板），用来验证设定库的「时间线节点」页签。
   为什么要文件式播种：节点的「种类」由**所在文件夹名**承载（不在 frontmatter 里），
   种类模板在独立的 formats.json —— 直接建文件比点一串界面更确定，也顺带覆盖扫描路径。 */
const fs = require('fs');
const path = require('path');
const DATA = process.env.LINGKUANG_TEST_DATA;
const VAULT = process.env.LINGKUANG_VAULT;
const WS = '测试世界观';
const TL = '主线';
const KIND = '事件';
if (!DATA || !VAULT) { console.log('FAIL 需要 LINGKUANG_TEST_DATA / LINGKUANG_VAULT'); process.exit(1); }

/* 节点种类 = 模板（决定节点该有哪些属性字段），走 formats.json */
const FORMATS = path.join(path.dirname(DATA), 'formats.json');
fs.writeFileSync(FORMATS, JSON.stringify({
  [KIND]: { id: KIND, name: KIND, fields: [{ name: '地点', type: 'text' }, { name: '规模', type: 'text' }] },
}, null, 2), 'utf8');

/* 节点 .md（frontmatter 存元数据；描述/正文各一个 tag —— 与 main.js 的 nodeToMd 同格式） */
const dir = path.join(VAULT, WS, TL, KIND);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, '王国的建立.md'), `---
id: n-e2e-1
title: 王国的建立
year: 312
precision: year
type: world_event
---
#描述：
旧都陷落后的第三年，第一块基石落地。

#正文：
王国在灰烬上建立起来。
`, 'utf8');

console.log('已播种节点「王国的建立」（种类=事件，模板字段 地点/规模）');
console.log('  ' + path.join(dir, '王国的建立.md'));
console.log('  ' + FORMATS);

/* 顺带播一条**有正文的实体**：用来验证「节点页签 → 实体页签」切换时正文框不会串文档
   （两个页签各有一份不同的正文，才测得出来） */
const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const w = d.worldsets[WS];
w.entities = {
  'e-e2e-1': { id: 'e-e2e-1', name: '银发少女', typeId: '角色', properties: { 发色: '银白' }, doc: '实体自己的正文。' },
};
fs.writeFileSync(DATA, JSON.stringify(d, null, 2), 'utf8');
console.log('已播种实体「银发少女」（正文与节点正文不同，用于跨页签不串文档的断言）');
