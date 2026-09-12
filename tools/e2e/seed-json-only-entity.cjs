/* 前置：造出「升级前就存在的 JSON-only 实体」场景 —— 实体只在 worldbuilding.json 里，
   vault 里还没有 `_设定` 目录。用来验证启动时会不会把它补写成文件。 */
const fs = require('fs');
const path = require('path');
const DATA = process.env.LINGKUANG_TEST_DATA;
const VAULT = process.env.LINGKUANG_VAULT;
const WS = '测试世界观';
const ID = 'e-upgrade-1';
const NAME = '只存在 JSON 的实体';
const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
if (!d.worldsets[WS]) { console.log('FAIL 测试世界观不存在'); process.exit(1); }
d.worldsets[WS].entities = {
  [ID]: { id: ID, name: NAME, typeId: '角色', properties: { 发色: '银白' }, doc: '我是升级前就有的实体。' },
};
fs.writeFileSync(DATA, JSON.stringify(d, null, 2), 'utf8');
for (const p of [path.join(VAULT, WS, '_设定'), path.join(VAULT, '.trash')]) {
  fs.rmSync(p, { recursive: true, force: true });
}
console.log(`已播种 JSON-only 实体「${NAME}」，并删掉 _设定 / .trash`);
console.log('  期望：应用启动后（**用户什么都不点**）自动写出 `_设定/角色/' + NAME + '.md`');
