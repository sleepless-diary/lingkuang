/* 前置：给「动效（切换类）」那条套件造一个确定起点。
 *
 * 为什么自己造一份数据而不复用 lk-evault2：动效套件需要一个**两条时间线**的世界
 * （页签错峰至少要两个 tab 才测得出来），而共用目录会把这个额外时间线留给其它套件，
 * 影响它们的树/计数断言。独立目录 + 独立播种 = 互不干扰。
 *
 * 用法：
 *   $env:LINGKUANG_TEST_DATA="...\lk-motion\worldbuilding.json"
 *   $env:LINGKUANG_VAULT="...\lk-motion\vault"
 *   node tools\e2e\seed-motion.cjs
 */
const fs = require('fs');
const path = require('path');
const DATA = process.env.LINGKUANG_TEST_DATA;
const VAULT = process.env.LINGKUANG_VAULT;
const WS = '测试世界观';
if (!DATA || !VAULT) { console.log('FAIL 需要 LINGKUANG_TEST_DATA / LINGKUANG_VAULT'); process.exit(1); }

/* 确定起点：整份数据与 vault 都由本脚本重写（同 id 残留会让回扫赢家随机，见 README 铁律 4） */
fs.mkdirSync(path.dirname(DATA), { recursive: true });
fs.rmSync(VAULT, { recursive: true, force: true });
fs.mkdirSync(VAULT, { recursive: true });

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
        'tl-main': tl('tl-main', '主线', [node('n-motion-1', '王国的建立', 312)]),
        /* 第二条时间线也放一个节点：**空时间线在 vault 里没有目录**，回扫重建会把它丢掉
           （vaultToWorldData 只按 vault 目录重建 timelines —— 已单独记档，见 docs/BUGS.md）。
           动效套件要的是「两个页签」，不该被那条缺陷影响，所以两边都给节点。 */
        'tl-side': tl('tl-side', '支线', [node('n-motion-2', '雪夜的告别', 315)]),
      },
      order: ['tl-main', 'tl-side'],
      docs: {},
      timeCursor: null,
      entities: {
        'e-motion-1': { id: 'e-motion-1', name: '银发少女', typeId: '角色', properties: { 发色: '银白' }, doc: '实体自己的正文。' },
      },
      entityTypes: {
        角色: { id: '角色', name: '角色', fields: [{ name: '发色', type: 'text' }] },
      },
      maps: {},
    },
  },
};
fs.writeFileSync(DATA, JSON.stringify(data, null, 2), 'utf8');

/* 节点种类模板（决定节点有哪些字段）；与 worldbuilding.json 分开存，见 main.js FORMATS_FILE */
fs.writeFileSync(path.join(path.dirname(DATA), 'formats.json'), JSON.stringify({
  事件: { id: '事件', name: '事件', fields: [{ name: '地点', type: 'text' }, { name: '规模', type: 'text' }] },
}, null, 2), 'utf8');

console.log('已播种动效套件的起点：2 条时间线（主线/支线）+ 1 个节点 + 1 个实体');
console.log('  ' + DATA);
console.log('  ' + VAULT);
