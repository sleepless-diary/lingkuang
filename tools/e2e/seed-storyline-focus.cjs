/* 前置：给「聚焦 = 线外截断 + 多段拼接」套件造确定起点。
 *
 * 为什么自己造一份：现有夹具（seed-node.cjs）只有一条**单段**剧情线，测不出「连接两段时间」。
 * 这里的形状是**两段式**剧情线 + 线内/线外都各留节点：
 *   · 段 A = 100~200 年 → 线内节点「甲段起点」100、「甲段中点」150
 *   · 段 B = 4000~4100 年 → 线内节点「乙段起点」4000、「乙段中点」4050
 *   · 空隙里「空隙里的事件」2000（聚焦时必须消失）
 *   · 末段之后「末段之后」5000（聚焦时必须消失）
 * 于是「两段直接相邻」可以量化：同一个算式（屏幕距离 ÷ 段内 px/年）在
 * 全览下算出来 ≈3850 年，聚焦后必须 ≈50 年（段 A 尾到段 B 首在压缩轴上正好 50 年）。
 *
 * ⚠️ 剧情线存在 `worldbuilding.json` 的时间线里（vault 的 .md 承载不了它），
 * 而节点以 vault 的 .md 为源 ⇒ 两边都要写，且 JSON 里时间线的 key 必须是 `tl-主线`
 * （`src/main.ts` 的 `vaultToWorldData()` 按 `'tl-' + 时间线名` 生成 id，并用它回头取 storylines）。
 *
 * 用法：
 *   $env:LINGKUANG_TEST_DATA="...\lk-story\worldbuilding.json"
 *   $env:LINGKUANG_VAULT="...\lk-story\vault"
 *   node tools/e2e/seed-storyline-focus.cjs
 */
const fs = require('fs');
const path = require('path');
const DATA = process.env.LINGKUANG_TEST_DATA;
const VAULT = process.env.LINGKUANG_VAULT;
const WS = '测试世界观';
const TL = '主线';
const KIND = '事件';
if (!DATA || !VAULT) { console.log('FAIL 需要 LINGKUANG_TEST_DATA / LINGKUANG_VAULT'); process.exit(1); }

/* 种类模板（节点必须有 kind，否则会被归到「事件」——这里显式写一份） */
fs.writeFileSync(path.join(path.dirname(DATA), 'formats.json'), JSON.stringify({
  [KIND]: { id: KIND, name: KIND, fields: [{ name: '地点', type: 'text' }] },
}, null, 2), 'utf8');

/* 先清空这条时间线（同 id 残留会让回扫赢家随 readdir 顺序变，断言会假挂） */
const dir = path.join(VAULT, WS, TL, KIND);
fs.rmSync(path.join(VAULT, WS, TL), { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const NODES = [
  ['n-a1', '甲段起点', 100],
  ['n-a2', '甲段中点', 150],
  ['n-gap', '空隙里的事件', 2000],
  ['n-b1', '乙段起点', 4000],
  ['n-b2', '乙段中点', 4050],
  ['n-tail', '末段之后', 5000],
];
for (const [id, title, year] of NODES) {
  fs.writeFileSync(path.join(dir, `${title}.md`), `---
id: ${id}
title: ${title}
year: ${year}
precision: year
type: world_event
---
#描述：
${title}（year ${year}）
`, 'utf8');
}

/* JSON：时间线骨架 + 两段式剧情线 + 时间指针（放在段 A 里，启动时的指针位置也就确定了） */
const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
if (!d.worldsets[WS]) d.worldsets[WS] = { name: WS, timelines: {}, order: [], docs: {} };
const ws = d.worldsets[WS];
ws.timelines = ws.timelines ?? {};
ws.timelines['tl-主线'] = {
  id: 'tl-主线',
  name: TL,
  absOffset: 0,
  nodes: [],
  loops: [],
  storylines: [{ id: 'sl-1', name: '两段线', segments: [{ start: 100, end: 200 }, { start: 4000, end: 4100 }] }],
};
ws.order = ['tl-主线'];
ws.entities = ws.entities ?? {};
/* 公历换算与 src/calendar.ts 的 toEpoch 同一套（365*y + 闰日数）——只为了指针落在段内 */
const leaps = (y) => Math.floor((y + 3) / 4) - Math.floor((y + 99) / 100) + Math.floor((y + 399) / 400);
ws.timeCursor = (365 * 120 + leaps(120)) * 86400;
fs.writeFileSync(DATA, JSON.stringify(d, null, 2), 'utf8');

console.log(`已播种两段式剧情线「两段线」（A 100~200 / B 4000~4100）+ ${NODES.length} 个节点（线内 4 / 线外 2）`);
console.log('  ' + dir);
