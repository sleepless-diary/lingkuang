/* 测试前置：把「测试世界观」清成干净状态（前端 store 的实体清空 + vault 的 _设定/.trash 删掉）。
   不这样做的话，上一轮残留的 .md 会被回扫捞回来（文件为源），断言全乱。 */
const fs = require('fs');
const path = require('path');
const DATA = process.env.LINGKUANG_TEST_DATA;
const VAULT = process.env.LINGKUANG_VAULT;
const WS = '测试世界观';
const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
if (!d.worldsets[WS]) { console.log('FAIL 测试世界观不存在'); process.exit(1); }
d.worldsets[WS].entities = {};
fs.writeFileSync(DATA, JSON.stringify(d, null, 2), 'utf8');
for (const p of [path.join(VAULT, WS, '_设定'), path.join(VAULT, '.trash')]) {
  fs.rmSync(p, { recursive: true, force: true });
  console.log('rm', p);
}
console.log('entities =', Object.keys(d.worldsets[WS].entities).length, '| entityTypes =', Object.keys(d.worldsets[WS].entityTypes ?? {}).join(','));
