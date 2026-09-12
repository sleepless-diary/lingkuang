/* 前置：造出「换种类会留下旧文件」的场景。
   节点的**种类由所在文件夹名承载**（不在 frontmatter 里，见 main.js 的 nodePath/scanTimelineDir），
   所以「换种类」在磁盘上= 文件从 `主线/战斗/` 挪到 `主线/事件/`：
   - 新文件由 writeVaultNodeSync 写到新文件夹；
   - **旧文件夹里那份该被删掉** —— 这就是被测的点。
   两份同时在，重扫时同 id **后来者覆盖**（scanTimelineDir 里 `nodesById.set(n.id, n)`），
   kind 与字段会被旧文件打回去。
   读 LINGKUANG_TEST_DATA / LINGKUANG_VAULT（与测试实例同一组）。 */
const fs = require('fs');
const path = require('path');

const DATA = process.env.LINGKUANG_TEST_DATA;
const VAULT = process.env.LINGKUANG_VAULT;
if (!DATA || !VAULT) { console.log('FAIL 需要 LINGKUANG_TEST_DATA / LINGKUANG_VAULT'); process.exit(1); }
const WS = '测试世界观';
const TL = '主线';
const OLD_KIND = '战斗';   /* 旧文件夹。名字要排在「事件」之后（NTFS 按 UTF-16 序：事 U+4E8B < 战 U+6218），
                              这样旧文件在重扫时是「后来者」—— 复现症状时不靠运气。 */
const NEW_KIND = '事件';
const TITLE = '王国的建立';
const ID = 'n-kind-1';

/* 数据文件：确保有这个世界与这条时间线 */
const d = fs.existsSync(DATA)
  ? JSON.parse(fs.readFileSync(DATA, 'utf8'))
  : { worldsets: {} };
if (!d.worldsets) d.worldsets = {};
d.worldsets[WS] = d.worldsets[WS] || { name: WS, timelines: {}, order: [], docs: {} };
d.worldsets[WS].timelines = d.worldsets[WS].timelines || {};
d.worldsets[WS].timelines['tl-' + TL] = d.worldsets[WS].timelines['tl-' + TL] || { id: 'tl-' + TL, name: TL, nodes: [] };
d.worldsets[WS].order = ['tl-' + TL];
d.worldsets[WS].entities = {};
d.active = WS;
fs.mkdirSync(path.dirname(DATA), { recursive: true });
fs.writeFileSync(DATA, JSON.stringify(d, null, 2), 'utf8');

/* 两种种类的模板（种类下拉的选项来自 formats）—— 只用来让 UI 里能选到「事件」 */
const FORMATS = path.join(path.dirname(DATA), 'formats.json');
fs.writeFileSync(FORMATS, JSON.stringify({
  [NEW_KIND]: { id: NEW_KIND, name: NEW_KIND, fields: [{ name: '地点', type: 'text' }] },
  [OLD_KIND]: { id: OLD_KIND, name: OLD_KIND, fields: [{ name: '参战方', type: 'text' }] },
}, null, 2), 'utf8');

/* 清掉整条时间线目录（上一轮残留会让断言全乱），再播旧种类那一份 */
const tlDir = path.join(VAULT, WS, TL);
fs.rmSync(tlDir, { recursive: true, force: true });
for (const p of [path.join(VAULT, WS, '_设定'), path.join(VAULT, '.trash')]) fs.rmSync(p, { recursive: true, force: true });
const oldDir = path.join(tlDir, OLD_KIND);
fs.mkdirSync(oldDir, { recursive: true });
fs.writeFileSync(path.join(oldDir, TITLE + '.md'), `---
id: ${ID}
title: ${TITLE}
year: 312
precision: year
type: world_event
参战方: 七城同盟
---
#描述：
旧都陷落后的第三年，第一块基石落地。

#正文：
王国在灰烬上建立起来。
`, 'utf8');

console.log(`已播种：${path.join(WS, TL, OLD_KIND, TITLE + '.md')}（id=${ID}，种类=文件夹名「${OLD_KIND}」）`);
console.log(`  formats 里有「${NEW_KIND}」与「${OLD_KIND}」两种，UI 里可把种类改成「${NEW_KIND}」`);
console.log(`  期望：改完之后 \`${TL}/\` 下同 id 的 .md **只剩一份**（在「${NEW_KIND}」里）`);
