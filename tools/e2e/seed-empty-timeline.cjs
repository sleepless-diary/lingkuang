/* 前置：给「空时间线不该被 vault 重建抹掉」那条套件造确定起点。
 *
 * 三条时间线各有用处：
 *   · 主线 = 有节点、vault 里有目录 → 后面**从外部删掉它的目录**，验证「文件为源」没被破坏（不复活）
 *   · 支线 = **0 节点、vault 里没有任何目录** → 这条就是被测对象（修复前它启动即消失）
 *   · 副线 = 有节点、vault 里有目录 → 对照组：删掉主线目录时它不该受牵连
 *
 * 用法：
 *   $env:LINGKUANG_TEST_DATA="...\lk-tl\worldbuilding.json"
 *   $env:LINGKUANG_VAULT="...\lk-tl\vault"
 *   node tools\e2e\seed-empty-timeline.cjs
 */
const fs = require('fs');
const path = require('path');
const DATA = process.env.LINGKUANG_TEST_DATA;
const VAULT = process.env.LINGKUANG_VAULT;
const WS = '测试世界观';
if (!DATA || !VAULT) { console.log('FAIL 需要 LINGKUANG_TEST_DATA / LINGKUANG_VAULT'); process.exit(1); }

fs.mkdirSync(path.dirname(DATA), { recursive: true });
/* 确定起点：数据与 vault 整份重写（同 id 残留会让回扫赢家随机，见 tools/e2e/README.md 铁律 4） */
fs.rmSync(VAULT, { recursive: true, force: true });

const node = (id, title, year) => ({
  id, title, precision: 'year', type: 'world_event', year,
  properties: { 地点: '', 规模: '' }, kind: '事件',
});
const tl = (id, name, nodes) => ({ id, name, absOffset: 0, nodes, loops: [], storylines: [] });

const data = {
  worldsets: {
    [WS]: {
      name: WS,
      timelines: {
        'tl-main': tl('tl-main', '主线', [node('n-main-1', '王国的建立', 312)]),
        'tl-side': tl('tl-side', '支线', []),
        'tl-sub': tl('tl-sub', '副线', [node('n-sub-1', '北境的雪', 315)]),
      },
      order: ['tl-main', 'tl-side', 'tl-sub'],
      docs: {},
      timeCursor: null,
      entities: {},
      entityTypes: { 角色: { id: '角色', name: '角色', fields: [{ name: '发色', type: 'text' }] } },
      maps: {},
    },
  },
};
fs.writeFileSync(DATA, JSON.stringify(data, null, 2), 'utf8');

fs.writeFileSync(path.join(path.dirname(DATA), 'formats.json'), JSON.stringify({
  事件: { id: '事件', name: '事件', fields: [{ name: '地点', type: 'text' }, { name: '规模', type: 'text' }] },
}, null, 2), 'utf8');

/* 只给**有节点**的两条时间线写目录 —— 支线故意不建目录，这正是被测场景（vault 是源，
   而"一条时间线"在 vault 里就是一个目录；没节点的自然没有目录） */
const writeNode = (tlName, file, id, title, year) => {
  const dir = path.join(VAULT, WS, tlName, '事件');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), `---
id: ${id}
title: ${title}
year: ${year}
precision: year
type: world_event
---
#描述：
播种的描述。

#正文：
播种的正文。
`, 'utf8');
};
writeNode('主线', '王国的建立.md', 'n-main-1', '王国的建立', 312);
writeNode('副线', '北境的雪.md', 'n-sub-1', '北境的雪', 315);

console.log('已播种：主线(1 节点) / 支线(0 节点，无目录) / 副线(1 节点)，vault 里只有主线与副线的目录');
console.log('  ' + DATA);
