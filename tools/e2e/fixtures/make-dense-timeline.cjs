/* 生成"密集节点"夹具（第一百二十三轮）：5 年内挤 8 个事件、同年 5 个，用来验标签分层/引线。
 *
 * 用法（先造夹具，再带着它起实例）：
 *   node tools/e2e/fixtures/make-dense-timeline.cjs %TEMP%\lk-dense\data.json
 *   $env:LINGKUANG_TEST_DATA="%TEMP%\lk-dense\data.json"
 *   $env:LINGKUANG_TEST_USERDATA="%TEMP%\lk-dense\ud"     # 别省，见 tools/e2e/README.md 开头
 *   $env:LINGKUANG_VAULT="%TEMP%\lk-dense\vault"
 *   Start-Process ...electron.exe -ArgumentList @(项目路径,"--remote-debugging-port=9334")
 *   node tools/e2e/timeline-labels-dense.cjs
 *
 * ⚠️ 别把夹具直接写进仓库目录：应用会**回写**数据文件，仓库会变脏。
 */
const fs = require('fs');
const path = require('path');

const target = process.argv[2];
if (!target) {
  console.log('用法: node tools/e2e/fixtures/make-dense-timeline.cjs <目标 data.json 路径>');
  process.exit(1);
}

const nodes = [];
let id = 1000;
const push = (title, year, type = 'world_event') => {
  nodes.push({ id: 'n' + id++, title, year, precision: 'year', type, desc: '' });
};
/* 簇 A：100~104 年（6 个） */
push('火种', 100); push('第一次迁徙', 101, 'story_event'); push('断桥', 102); push('契约', 103, 'story_event');
push('盐路开通', 104); push('旧神出走', 104, 'story_event');
/* 簇 B：300~305 年（8 个） */
push('铸钟', 300); push('冬临', 301); push('瘟疫', 301, 'story_event'); push('围城', 302);
push('谈判', 302, 'story_event'); push('割据', 303); push('盟誓', 304, 'story_event'); push('退位', 305);
/* 簇 C：500 年（5 个，全同年） */
push('长子', 500); push('远征', 500, 'story_event'); push('沉船', 500); push('灯塔', 500, 'story_event'); push('旱季', 500);
/* 散布：700 以后（每个都隔开） */
push('井变', 720); push('税制', 760, 'story_event'); push('起义', 800); push('灰烬', 840, 'story_event');
push('暗港', 900); push('星图', 960); push('长子归来', 1020, 'story_event'); push('新契约', 1080);
push('海线', 1140, 'story_event'); push('北境', 1200); push('雾隐', 1260, 'story_event'); push('终局', 1320);

const data = {
  worldsets: {
    密集测试: {
      name: '密集测试',
      timelines: {
        'tl-dense': {
          id: 'tl-dense',
          name: '密集线',
          absOffset: 0,
          nodes,
          loops: [],
          storylines: [{ id: 's1', name: '北境线', segments: [{ startId: 'n1000', endId: 'n1010' }, { startId: 'n1020', endId: 'n1033' }] }],
        },
      },
      order: ['tl-dense'],
      docs: {},
      entityTypes: {},
      maps: [{ id: 'm1', name: '默认地图', width: 900, height: 500, regions: [], markers: [], paths: [] }],
      timeCursor: null,
    },
  },
  formats: {},
  activeWorldset: '密集测试',
};

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf8');
console.log('wrote', target, nodes.length, 'nodes');
