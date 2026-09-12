/* 前置：造出 docs/BUGS.md 记的那个数据损失场景 ——
   一个**截断的 worldbuilding.json**（真解析不了，不是格式问题）+ 一个**空 vault**。
   空 vault 是关键：vault 里若有世界，loadData 会以 .md 为源兜住，看不到「界面变成空世界」；
   只有 vault 也空时，旧行为才会拿 emptyData() 顶上、400ms 后把它写回磁盘。
   读 `LINGKUANG_TEST_DATA` / `LINGKUANG_VAULT`（与测试实例用同一组，见 tools/e2e/README.md）。 */
const fs = require('fs');
const path = require('path');

const DATA = process.env.LINGKUANG_TEST_DATA;
const VAULT = process.env.LINGKUANG_VAULT;
if (!DATA) { console.log('FAIL 需要 LINGKUANG_TEST_DATA'); process.exit(1); }
if (!VAULT) { console.log('FAIL 需要 LINGKUANG_VAULT'); process.exit(1); }

/* 内容要「值得抢救」：截断前是一份有世界/时间线/节点的正常数据，
   这样「文件被覆盖」的代价是肉眼可感的，而不是空对象被空对象覆盖。 */
const good = JSON.stringify({
  worldsets: {
    测试世界观: {
      name: '测试世界观',
      timelines: {
        'tl-主线': {
          id: 'tl-主线', name: '主线', nodes: [
            { id: 'n1', title: '大陆初生', year: 1, kind: '事件', properties: { 简述: '第一块陆地浮出海面' } },
            { id: 'n2', title: '王国的建立', year: 312, kind: '事件', properties: { 简述: '七城同盟' } },
          ],
        },
      },
      order: ['tl-主线'],
      docs: {},
    },
  },
  active: '测试世界观',
}, null, 2);

/* 砍掉尾巴 → 真损坏：JSON.parse 必然报 Unexpected end of JSON input。
   不用「塞个非法字符」那种假损坏 —— 真事故是写到一半，形状要对得上。 */
const bad = good.slice(0, Math.floor(good.length * 0.62));

fs.mkdirSync(path.dirname(DATA), { recursive: true });
fs.writeFileSync(DATA, bad, 'utf8');

/* 清掉上一轮的残留：备份/副本/旧 vault。不清的话「文件没被覆盖」可能是因为
   上一轮的副本还在，测试会假过。 */
const dir = path.dirname(DATA);
for (const f of fs.readdirSync(dir)) {
  if (/^worldbuilding\.(backup-|bak-)/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
}
fs.rmSync(VAULT, { recursive: true, force: true });

console.log(`OK 已播种损坏数据：${DATA}`);
console.log(`   ${Buffer.byteLength(bad, 'utf8')} 字节（完整版 ${Buffer.byteLength(good, 'utf8')} 字节，只留前 62%）`);
console.log(`   末尾：${JSON.stringify(bad.slice(-40))}`);
console.log(`   vault：${VAULT}（不存在 = 空，世界只能靠 JSON 兜底）`);
