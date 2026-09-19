/* 看一眼「新建节点面板」长什么样（CDP 截图，给人看的，不是断言）。
 * 用法：起干净实例（reset-entity-vault + seed-node）后
 *   LK_CDP_PORT=9350 node tools/e2e/probe-create-panel-shot.cjs [输出png路径]
 * 默认写到 %TEMP%\lk-create-panel.png；同时截一张「填完还没提交」和一张「建完」的。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const PORT = process.env.LK_CDP_PORT || '9350';
const OUT = process.argv[2] || path.join(os.tmpdir(), 'lk-create-panel.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let target = null;
  for (let i = 0; i < 120; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (target) break; } catch {}
    await sleep(200);
  }
  if (!target) { console.log(`FAIL 无法连接 CDP ${PORT}`); process.exit(1); }
  const w = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; });
  let id = 0; const pending = new Map();
  w.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); w.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    console.log('已写 ' + file);
  };

  await sleep(1500);
  await ev(`document.querySelector('[data-tool="sandbox"]').click(); true`);
  await sleep(600);
  await ev(`document.getElementById('lk-node-new').click(); true`);
  await sleep(200);
  /* 填上内容再截：空面板看不出模板字段那几行长什么样 */
  await ev(`(() => {
    document.getElementById('nf-title').value = '霜落之战';
    const setField = (label, val) => {
      const row = [...document.querySelectorAll('#nf-props > div')].find((d) => d.querySelector('span')?.textContent === label);
      const ctrl = row && row.querySelector('input,textarea');
      if (ctrl) { ctrl.value = val; ctrl.dispatchEvent(new Event('change', { bubbles: true })); }
    };
    setField('地点', '北境');
    setField('规模', '大战');
    return true;
  })()`);
  await sleep(900);
  const panelBox = await ev(`(() => {
    const h = document.getElementById('lk-tool-host');
    const p = h.querySelector('#nf-ok');
    return { hostScroll: h.scrollHeight, hostClient: h.clientHeight, okVisible: !!p && p.getBoundingClientRect().bottom <= window.innerHeight };
  })()`);
  console.log('面板量一下：' + JSON.stringify(panelBox));
  await shot(OUT);

  const out2 = OUT.replace(/\.png$/, '-created.png');
  await ev(`document.getElementById('nf-ok').click(); true`);
  await sleep(900);
  await shot(out2);
  w.close();
  process.exit(0);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
