/* 沙盘"密集区时间组"（第一百二十七轮）：
 *   ① 没有方案文件时：按像素自动分组，列头是年份区间；
 *   ② AI（MCP）写入方案后：列头变成 AI 起的名字，**不用重启**就跟随；
 *   ③ 删掉文件后：退回自动分组；
 *   ④ 方案里写了不存在的节点 id：不炸、也不多出空列。
 * 用法：node tools/e2e/timeline-groups.cjs [端口] [方案文件路径]
 *   方案文件默认取 %APPDATA%\lingkuang\sandbox-groups.json；测试实例请传临时目录里的那个。
 */
const fs = require('fs');
const path = require('path');
const PORT = process.argv[2] || process.env.LK_CDP_PORT || '9334';
const FILE = process.argv[3] || path.join(process.env.APPDATA || '.', 'lingkuang', 'sandbox-groups.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (n, v, extra) => console.log(`${v ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) { console.log('FAIL 连不上 CDP'); process.exit(1); }
  const w = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; });
  let id = 0; const pending = new Map();
  w.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (m, p) => new Promise((res) => { const i = ++id; pending.set(i, res); w.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  const heads = () => ev(`[...document.querySelectorAll('.tl-grp__head')].map((h) => h.textContent.replace(/\\d+$/, ''))`);
  const cols = () => ev(`(() => {
    const wrap = document.querySelector('.tl-wrap').getBoundingClientRect();
    const groups = [...document.querySelectorAll('.tl-grp')].map((g) => {
      const r = g.getBoundingClientRect();
      const lr = [...g.querySelectorAll('.tl-grp__head, .tl-grp__row, .tl-grp__more')].map((e) => e.getBoundingClientRect());
      const top = Math.min(...lr.map((x) => x.top)), bottom = Math.max(...lr.map((x) => x.bottom));
      const left = Math.min(...lr.map((x) => x.left)), right = Math.max(...lr.map((x) => x.right));
      return { head: g.querySelector('.tl-grp__head')?.textContent || '', top, bottom, left, right };
    });
    let overlap = 0;
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i], b = groups[j];
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 2 && oy > 2) overlap++;
    }
    return { n: groups.length, overlap, insideWrap: groups.every((g) => g.top >= wrap.top - 1 && g.bottom <= wrap.bottom + 1) };
  })()`);

  await sleep(1200);
  await ev(`document.querySelector('[data-tool="sandbox"]')?.click(); true`);
  await sleep(500);
  await ev(`(() => {
    const tabs = [...document.querySelectorAll('.lk-tl-tab[data-tl]')];
    let best = null, bn = -1;
    for (const t of tabs) { const n = Number(t.querySelector('.cnt')?.textContent || 0); if (n > bn) { bn = n; best = t; } }
    if (best && !best.classList.contains('is-active')) best.click();
    return bn;
  })()`);
  await sleep(700);

  /* ① 无方案：自动分组（列头是年份区间） */
  const backup = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null;
  if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
  await ev(`location.reload(); true`).catch(() => {});
  await sleep(2600);
  await ev(`document.querySelector('[data-tool="sandbox"]')?.click(); true`);
  await sleep(400);
  await ev(`(() => { const tabs=[...document.querySelectorAll('.lk-tl-tab[data-tl]')]; let b=null,bn=-1; for(const t of tabs){const n=Number(t.querySelector('.cnt')?.textContent||0); if(n>bn){bn=n;b=t;}} if(b&&!b.classList.contains('is-active')) b.click(); return bn; })()`);
  await sleep(900);
  const auto = await heads();
  console.log('auto heads =', JSON.stringify(auto));
  ok('没有方案时按年份区间自动分组', auto.length > 0 && auto.every((h) => /年/.test(h)), auto);
  const c1 = await cols();
  ok('自动分组：列之间不重叠且都在画布内', c1.overlap === 0 && c1.insideWrap, c1);

  /* ② AI 写方案 → 界面自己跟随（不重启、不刷新） */
  const ids = await ev(`(() => {
    const n = [...document.querySelectorAll('.tl__n')];
    return n.slice(0, 3).map((x) => x.dataset.id);
  })()`);
  const tree = {
    version: 1,
    worlds: {
      [await ev(`document.querySelector('#lk-world-tabs .is-active, #lk-world-tabs button')?.textContent?.trim() || ''`)]: {
        [await ev(`(() => {
          const tabs=[...document.querySelectorAll('.lk-tl-tab[data-tl]')];
          let b=null,bn=-1; for(const t of tabs){const n=Number(t.querySelector('.cnt')?.textContent||0); if(n>bn){bn=n;b=t;}}
          return b?.dataset.tl || '';
        })()`)]: {
          source: 'ai',
          updatedAt: new Date().toISOString(),
          groups: [{ id: 'g-ai', title: 'AI 起的名字', nodes: ids }],
        },
      },
    },
  };
  /* 用页面里真实的"世界名/时间线 id"更稳：直接问 preload 的 loadData 里那份 */
  const real = await ev(`(async () => {
    const res = await window.lingkuangAPI.loadData();
    const d = res?.data || {};
    const wsName = Object.keys(d.worldsets || {})[0];
    const ws = (d.worldsets || {})[wsName] || {};
    const tid = (ws.order || []).find((i) => (ws.timelines?.[i]?.nodes || []).length > 0) || Object.keys(ws.timelines || {})[0];
    const nodeIds = (ws.timelines?.[tid]?.nodes || []).slice(0, 3).map((n) => n.id);
    return { wsName, tid, nodeIds };
  })()`);
  const plan = {
    version: 1,
    worlds: {
      [real.wsName]: {
        [real.tid]: {
          source: 'ai',
          updatedAt: new Date().toISOString(),
          groups: [
            { id: 'g-ai', title: 'AI 起的名字', nodes: real.nodeIds, note: '探针' },
            { id: 'g-bad', title: '不存在的节点', nodes: ['no-such-node'] },
          ],
        },
      },
    },
  };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(plan, null, 2), 'utf8');
  await sleep(2200);   /* 等 fs.watchFile（700ms 轮询）推过来 */
  const aiHeads = await heads();
  console.log('ai heads =', JSON.stringify(aiHeads));
  ok('AI 方案写入后界面自动跟随（列头变成 AI 名字）', aiHeads.some((h) => h.includes('AI 起的名字')), aiHeads);
  const c2 = await cols();
  ok('AI 方案：无效 id 不产生空列、列不重叠', c2.overlap === 0 && !aiHeads.some((h) => h.includes('不存在的节点')), { c2, aiHeads });

  /* ③ 删掉方案 → 退回自动 */
  fs.unlinkSync(FILE);
  await sleep(2200);
  const back = await heads();
  console.log('back heads =', JSON.stringify(back));
  ok('删掉方案后回到自动分组', back.length > 0 && back.every((h) => /年/.test(h)), back);

  /* 还原用户原来的方案文件（如果之前有） */
  if (backup !== null) fs.writeFileSync(FILE, backup, 'utf8');
  w.close();
}

main().catch((e) => { console.log('FAIL 探针异常:', e.message); process.exit(1); });
