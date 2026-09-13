/* 换「种类」之后，旧文件夹里那份 .md 必须被清掉（同一条时间线内、同一个 id 只能有一份）。
 *
 * 为什么这会变成「改动自己变回去」：scanTimelineDir 按**文件夹名**给节点回填 kind，
 * 且同 id 是**后来者覆盖**（`nodesById.set(n.id, n)`）。旧文件还在时，只要它所在的文件夹
 * 排在后面，重扫就会把种类和字段一起打回旧值 —— 用户看到的是「我改的东西自己变回去了」。
 * 设定库的条目（实体）先前有同样的毛病，已用 entityFiles() 全树清理修掉；节点侧是同一段形状的坑。
 *
 * 前置：node tools/e2e/seed-kind-change.cjs（同一个 data/vault 目录）。 */
const fs = require('fs');
const path = require('path');

const DATA = process.env.LINGKUANG_TEST_DATA;
const VAULT = process.env.LINGKUANG_VAULT;
const PORT = process.env.LK_CDP_PORT || '9334';
const WS = '测试世界观';
const TL = '主线';
const OLD_KIND = '战斗';
const NEW_KIND = '事件';
const TITLE = '王国的建立';
const ID = 'n-kind-1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, extra) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);
}

/** 这条时间线下、所有 .md 里 id 命中该节点的文件（相对路径）——按**内容**找，不看文件名 */
function filesWithId() {
  const tlDir = path.join(VAULT, WS, TL);
  const out = [];
  const walk = (dir, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(path.join(dir, e.name), rel + e.name + '/'); continue; }
      if (!e.name.endsWith('.md')) continue;
      let txt = '';
      try { txt = fs.readFileSync(path.join(dir, e.name), 'utf8'); } catch { continue; }
      if (new RegExp(`^id:\\s*${ID}\\s*$`, 'm').test(txt)) out.push(rel + e.name);
    }
  };
  walk(tlDir, '');
  return out;
}

async function main() {
  if (!DATA || !VAULT) { console.log('FAIL 需要 LINGKUANG_TEST_DATA / LINGKUANG_VAULT'); process.exit(1); }

  let target = null;
  for (let i = 0; i < 120; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  if (!target) { console.log('FAIL 无法连接 CDP'); process.exit(1); }
  const w = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; });
  let id = 0; const pending = new Map();
  w.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); w.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  const click = (sel) => ev(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return false; el.click(); return true; })()`);
  const clickText = (sel, text) => ev(`(() => { const el=[...document.querySelectorAll(${JSON.stringify(sel)})].find((x)=>(x.textContent||'').includes(${JSON.stringify(text)})); if(!el) return false; el.click(); return true; })()`);
  /** 属性面板里「种类」那一行的控件（是个 select，选项来自 formats） */
  const KIND_SEL = `[...document.querySelectorAll('#cx-props .ed-props > div')].find((r) => r.firstElementChild?.textContent === '种类')?.querySelector('select,input')`;
  const kindNow = () => ev(`(${KIND_SEL})?.value`);
  /** 「标题」那一行（断言「界面说的就是盘上活下来那份」时要读它） */
  const TITLE_SEL = `[...document.querySelectorAll('#cx-props .ed-props > div')].find((r) => r.firstElementChild?.textContent === '标题')?.querySelector('input,textarea')`;
  /** 「描述」那一行（改一下触发落盘用） */
  const DESC_SEL = `[...document.querySelectorAll('#cx-props .ed-props > div')].find((r) => r.firstElementChild?.textContent === '描述')?.querySelector('input,textarea')`;
  async function waitFor(fn, ms = 10000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(200); } return false; }

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);

  /* ① 进工作台，筛到「时间线节点」→ 列表里直接点那条。
     左栏 2026-09-13 重做后没有页签、列表也不再分世界/时间线层级（平铺），所以不必再逐层展开。 */
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  await sleep(1200);
  await click('#cx-chips [data-cx-chip="@node"]'); await sleep(600);
  await clickText('#cx-list .ed-tnode-item', TITLE);
  await sleep(900);

  check('1 选中节点后「种类」显示为旧种类（文件夹名当权威）', (await kindNow()) === OLD_KIND, await kindNow());
  check('2 动手前这条时间线下只有一份该节点 .md', filesWithId().length === 1, filesWithId());

  /* ② 把种类改成「事件」—— 会触发：store 改 → 400ms 防抖 → vault:write 写到新文件夹 */
  await ev(`(() => { const sel = ${KIND_SEL}; sel.value = ${JSON.stringify(NEW_KIND)}; sel.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
  const moved = await waitFor(() => fs.existsSync(path.join(VAULT, WS, TL, NEW_KIND, TITLE + '.md')));
  check('3 新文件夹里写出了文件', moved, filesWithId());

  /* ③ 核心：同 id 只能剩一份。旧文件夹那份该被清掉。 */
  await sleep(1200);
  const files = filesWithId();
  check('★4 同 id 只剩一份 .md（旧文件夹那份被清掉）', files.length === 1, files);
  check('★5 残留的旧文件不在了', !fs.existsSync(path.join(VAULT, WS, TL, OLD_KIND, TITLE + '.md')),
    fs.existsSync(path.join(VAULT, WS, TL, OLD_KIND)) ? fs.readdirSync(path.join(VAULT, WS, TL, OLD_KIND)) : '(目录都没了)');

  /* ④ 症状级：等一轮回扫（自家写盘也会触发 watcher）→ 种类不能被打回旧值。
     旧文件排在后面对，重扫时它就是「后来者」——修复前这里会被打回「战斗」。 */
  await sleep(3500);
  check('★6 回扫之后种类仍是新种类（改动没被打回去）', (await kindNow()) === NEW_KIND, await kindNow());
  check('7 回扫之后同 id 依然只有一份', filesWithId().length === 1, filesWithId());

  /* ⑤ 自愈：**升级之前**就留在盘上的旧残留（同名、在别的种类文件夹、同 id）。
     这时目标路径已经存在，走的是便宜层（①）—— 不解析全树也能把它认出来删掉。
     这一条同时说明：已经中了这个 bug 的 vault 不用手工收拾。 */
  const staleBack = path.join(VAULT, WS, TL, OLD_KIND, TITLE + '.md');
  fs.mkdirSync(path.dirname(staleBack), { recursive: true });
  fs.writeFileSync(staleBack, `---
id: ${ID}
title: ${TITLE}
year: 312
precision: year
type: world_event
参战方: 早就过时的旧字段
---
#正文：
王国在灰烬上建立起来。
`, 'utf8');
  const healed = await waitFor(() => filesWithId().length === 1, 12000);
  const left = filesWithId();
  check('★8 盘上的旧残留被自愈清掉（同名兜底层，目标路径已存在也生效）', healed, left);
  /* 收敛后必须自洽：活 UI 说的「种类 + 标题」就是活下来的那个文件（谁赢都行，但不能两边不一致） */
  const kind = await kindNow();
  const title = await ev(`(${TITLE_SEL})?.value`);
  check('9 收敛后界面（种类 + 标题）与活下来的文件一致', left.length === 1 && left[0] === `${kind}/${title}.md`, { kind, title, left });

  /* ⑥ 同目录里「改了名」的旧残留 —— 同名那层筛子抓不到它，靠**扫描索引**认出来。
     这正是修复前每次写盘「把目标文件夹整个读一遍」负责的形状，也是 A/B 里那个脏目录暴露的形状；
     现在改成扫描期登记 → 写盘时按 id 一步删（不再扫目录，见 main.js 的 vaultFileIndex）。
     ⚠️ 清理是**挂在写盘上**的（既有语义，修复前也一样）：这份残留是「输家」，
     不改变回扫赢家 ⇒ 界面没变化 ⇒ 不会自己触发写盘。所以要像真人那样**动一下这个节点**，
     下一趟落盘顺手把它清掉。 */
  fs.writeFileSync(path.join(VAULT, WS, TL, NEW_KIND, TITLE + '（改）.md'), `---
id: ${ID}
title: ${TITLE}（改）
year: 312
precision: year
type: world_event
参战方: 旧名字那一份
---
#正文：
王国在灰烬上建立起来。
`, 'utf8');
  await sleep(1500);   /* 让 watcher 回扫一趟，索引里登记上这份残留 */
  await ev(`(() => { const el = ${DESC_SEL}; if (!el) return false; el.value = '顺手改一下描述（触发落盘）。'; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const healed2 = await waitFor(() => filesWithId().length === 1, 12000);
  const left2 = filesWithId();
  const kind2 = await kindNow();
  const title2 = await ev(`(${TITLE_SEL})?.value`);
  check('★11 同目录里改了名的旧残留在下一次落盘时被清掉，且界面与文件仍一致',
    healed2 && left2.length === 1 && left2[0] === `${kind2}/${title2}.md`, { kind2, title2, left2 });

  const errs = await ev(`window.__errs`);
  check('12 全程无未捕获异常', Array.isArray(errs) && errs.length === 0, errs);

  const ok = results.filter(Boolean).length;
  console.log(`\n==== ${ok}/${results.length} PASS ====`);
  process.exit(ok === results.length ? 0 : 1);
}
main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.message)); process.exit(2); });
