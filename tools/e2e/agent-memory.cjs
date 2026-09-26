/* 不变量：**助手的长期记忆是"看得见、改得动、忘得掉"的创作者资产**，而权限档位真的会落到提示词与闸门上。
 *
 * 用户 2026-09-15 的原话：「我想让我们灵框的 ai 真的工作，类 agent…有记忆，能总结创作者的偏好等」，
 * 以及「和真 agent 软件一样，有禁止，部分执行和 YOLO 什么的」。片 2 落地的是这里测的四件事：
 *   ① 记忆可见可改：面板里一块「长期记忆（N 条偏好）」，条目就地可改、可忘掉；
 *   ② 记忆落盘：`<userData>/agent/memory.json`（**裸数组**，和 `chat.json` 同一层）——
 *      放文件不放 localStorage：这是创作者资产，要能备份/查看/手改；
 *   ③ 从对话里总结：让模型读最近对话吐出几条稳定偏好，**去重**（记过的不再记）；
 *   ④ 三档权限：只读 / 逐项确认 / YOLO，存进设置、写进系统提示、面板根上挂 `data-gate`
 *      （片 3 的写工具执行前问 `gateWrite()`；e2e 直接读这个属性）。
 *
 * ⭐ 最要紧的一条断言是 ★12：「**记忆真的进了系统提示**」。清单好看没用 ——
 *    记忆是喂进**每一次提问的 system**（`memoryPrompt()`），不是塞进会被 `HISTORY_SEND` 截断的历史。
 *    所以这里用**假引擎后门** `window.__lkAgentMock = (m) => { window.__lkSeen = m; … }` 把喂进去的消息抓下来看。
 * ⭐ ★11 顺带守「权限也进了提示词」：档位是只读时，系统提示必须写明"你改不了东西"，
 *    否则模型会一口答应"我帮你改好了"（用户会以为稿子被改了）。
 *
 * 用法（`%TEMP%\lk-evault2` 那套 codex 夹具）：
 *   node tools/e2e/reset-entity-vault.cjs; node tools/e2e/seed-node.cjs; node tools/e2e/seed-agent-memory.cjs
 *   → 起应用 → LK_CDP_PORT=NNNN node tools/e2e/agent-memory.cjs
 */
const fs = require('fs');
const path = require('path');
const PORT = process.env.LK_CDP_PORT || '9346';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(n, ok, extra) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`); }

/** agent/ 的位置 = `main.js` 的 `AGENT_DIR()`（测试时跟着 LINGKUANG_TEST_DATA 走） */
function agentDir() {
  if (process.env.LK_AGENT_DIR) return process.env.LK_AGENT_DIR;
  if (process.env.LINGKUANG_TEST_DATA) return path.join(path.dirname(process.env.LINGKUANG_TEST_DATA), 'agent');
  return path.join(require('os').tmpdir(), 'lk-evault2', 'agent');
}
function diskMemory() {
  try {
    const raw = fs.readFileSync(path.join(agentDir(), 'memory.json'), 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : null;
  } catch { return null; }
}

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
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  const agentBtn = `[...document.querySelectorAll('#lk-toolbar .lk-tool-btn')].find((b) => b.dataset.tool === 'agent')`;
  const ctrlK = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`;
  /** 面板里的记忆清单快照（列表会整体重画，所以每次断言都重新读） */
  const memSnap = `(() => {
    const rows = [...document.querySelectorAll('#lk-agent-mem-list .lk-agent__mem-item')];
    return {
      n: rows.length,
      rows: rows.map((r) => ({ id: r.dataset.memId || '', src: r.dataset.src || '', text: r.querySelector('.lk-agent__mem-input')?.value ?? '' })),
      summary: document.querySelector('#lk-agent-mem-summary')?.textContent ?? '',
      note: document.querySelector('#lk-agent-note')?.textContent ?? '',
      gate: document.getElementById('lk-agent-panel')?.dataset.gate ?? '',
    };
  })()`;

  await sleep(1500);
  await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); true`);
  /* 前置：打开工作台（助手要有个 store 才能问东西） */
  await ev(`document.querySelector('[data-tool="codex"]').click(); true`);
  await sleep(1200);

  const pre = await ev(`(() => ({
    works: !!document.querySelector('#cx-root'),
    btn: !!${agentBtn},
    panel: !!document.getElementById('lk-agent-panel'),
  }))()`);
  check('★0 前置：工作台开着、左栏有「助手」按钮、此刻没有面板',
    pre.works === true && pre.btn === true && pre.panel === false, pre);

  /* ── ① 开面板：记忆区与权限档都在 ── */
  await ev(ctrlK);
  await sleep(700);   // 等 ensureLoaded()（读 chat.json / memory.json）落地
  const opened = await ev(`(() => {
    const p = document.getElementById('lk-agent-panel');
    const sel = p?.querySelector('#lk-agent-perm');
    return {
      exists: !!p,
      mem: !!p?.querySelector('.lk-agent__mem'), list: !!p?.querySelector('#lk-agent-mem-list'),
      sumBtn: !!p?.querySelector('#lk-agent-mem-sum'), addBtn: !!p?.querySelector('#lk-agent-mem-add'),
      sel: !!sel,
      opts: sel ? [...sel.options].map((o) => o.value) : [],
      cur: sel ? sel.value : '',
      hint: (p?.querySelector('#lk-agent-perm-hint')?.textContent ?? '').slice(0, 12),
      gate: p?.dataset.gate ?? '',
    };
  })()`);
  check('★1 Ctrl+K 开出来的面板里有「长期记忆」区（清单/总结/手动加）与权限下拉，三档齐全、默认「逐项确认」',
    opened.exists === true && opened.mem === true && opened.list === true && opened.sumBtn === true && opened.addBtn === true
      && opened.sel === true && opened.opts.join(',') === 'readonly,confirm,yolo' && opened.cur === 'confirm'
      && opened.hint.length > 0 && opened.gate === 'propose',
    { opts: opened.opts, cur: opened.cur, gate: opened.gate, hint: opened.hint });

  /* ── ② 盘上那条记忆进了面板（＝"关掉应用也还在"） ── */
  const seeded = await ev(memSnap);
  check('★5 启动时从磁盘读回来的那条偏好进了清单（id 与 content 都对，src=manual）',
    seeded.n === 1 && seeded.rows[0].id === 'm-seed-1' && seeded.rows[0].text === '人名喜欢两三个字'
      && seeded.rows[0].src === 'manual' && seeded.summary.indexOf('1 条') >= 0,
    { n: seeded.n, rows: seeded.rows, summary: seeded.summary });

  /* ── ③ 手动加一条（点「＋ 手动加一条」→ 空行 → 填字 → 落盘） ── */
  await ev(`document.querySelector('#lk-agent-mem-add').click(); true`);
  await sleep(150);
  const draft = await ev(`(() => {
    const rows = [...document.querySelectorAll('#lk-agent-mem-list .lk-agent__mem-item')];
    const d = rows.find((r) => !r.dataset.memId);
    return { n: rows.length, hasDraft: !!d };
  })()`);
  await ev(`(() => {
    const rows = [...document.querySelectorAll('#lk-agent-mem-list .lk-agent__mem-item')];
    const d = rows.find((r) => !r.dataset.memId);
    const inp = d?.querySelector('.lk-agent__mem-input');
    if (!inp) return false;
    inp.value = '章节标题偏短句';
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  const added = await ev(memSnap);
  const addedDisk = diskMemory();
  check('★2 手动加一条：清单多出一条、手写（src=manual）、磁盘 memory.json 里也有了',
    draft.hasDraft === true && added.n === 2 && added.rows.some((r) => r.text === '章节标题偏短句' && r.src === 'manual')
      && Array.isArray(addedDisk) && addedDisk.length === 2 && addedDisk.some((x) => x.text === '章节标题偏短句'),
    { n: added.n, disk: addedDisk ? addedDisk.map((x) => x.text) : null });

  /* ── ④ 就地改（input change 即存） ── */
  await ev(`(() => {
    const r = document.querySelector('#lk-agent-mem-list .lk-agent__mem-item[data-mem-id="m-seed-1"]');
    const inp = r?.querySelector('.lk-agent__mem-input');
    if (!inp) return false;
    inp.value = '人名就用两三个字';
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  const edited = await ev(memSnap);
  const editedDisk = diskMemory();
  check('★3 就地改一条：面板与磁盘同时变成新文字（旧文字没了）',
    edited.rows.some((r) => r.text === '人名就用两三个字')
      && Array.isArray(editedDisk) && editedDisk.some((x) => x.id === 'm-seed-1' && x.text === '人名就用两三个字')
      && !editedDisk.some((x) => x.text === '人名喜欢两三个字'),
    { 面板: edited.rows.map((r) => r.text), disk: editedDisk ? editedDisk.map((x) => x.text) : null });

  /* ── ⑤ 忘掉一条 ── */
  await ev(`document.querySelector('#lk-agent-mem-list .lk-agent__mem-item[data-mem-id="m-seed-1"] [data-mem-del]').click(); true`);
  await sleep(400);
  const removed = await ev(memSnap);
  const removedDisk = diskMemory();
  check('★4 点 × 忘掉：面板里没了、磁盘里也没了（另一条不受影响）',
    removed.n === 1 && !removed.rows.some((r) => r.id === 'm-seed-1')
      && Array.isArray(removedDisk) && removedDisk.length === 1 && removedDisk[0].text === '章节标题偏短句',
    { 面板: removed.rows.map((r) => r.text), disk: removedDisk ? removedDisk.map((x) => x.text) : null });

  /* ── ⑥ 权限：切到只读 → 闸门 deny + 系统提示里写明"你改不了" ──
     ⭐ 先切到 **Agent 模式**（片 4，2026-09-26）：权限是"能动手"时的长期设定，
     聊天模式下那行是禁用的、提示文案也不一样（聊天模式本身就不动手，见 `agent-mode.cjs`）。 */
  await ev(`document.getElementById('lk-agent-mode-agent').click(); true`);
  await sleep(300);
  await ev(`(() => { const s = document.querySelector('#lk-agent-perm'); s.value = 'readonly'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(300);
  const ro = await ev(`(() => {
    const p = document.getElementById('lk-agent-panel');
    let stored = '';
    try { stored = (JSON.parse(localStorage.getItem('lingkuang-settings')) || {}).agentPerm || ''; } catch {}
    return { gate: p.dataset.gate, cur: p.querySelector('#lk-agent-perm').value, stored, hint: (p.querySelector('#lk-agent-perm-hint')?.textContent ?? '').slice(0, 20) };
  })()`);
  check('★9 切成「只读」：面板记住、设置里存下（localStorage）、提示文案跟着换',
    ro.cur === 'readonly' && ro.stored === 'readonly' && ro.hint.indexOf('只能看') >= 0,
    { cur: ro.cur, stored: ro.stored, hint: ro.hint });
  check('★11 只读档 → 闸门变 deny（片 3 的写工具照这个拦）',
    ro.gate === 'deny', { gate: ro.gate });

  /* 假引擎：把喂进去的消息抓下来（这正是"记忆与权限到底有没有进提示词"的第一现场） */
  await ev(`window.__lkSeen = null; window.__lkAgentMock = (m) => { window.__lkSeen = m; return '收到。'; }; true`);
  await ev(`(() => { const t = document.querySelector('#lk-agent-input'); t.value = '我该注意什么？'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await ev(`document.querySelector('#lk-agent-send').click(); true`);
  await sleep(900);
  const prompt = await ev(`(() => {
    const m = window.__lkSeen || [];
    const s = (m[0] && m[0].content) || '';
    return {
      n: m.length, sysRole: m[0] && m[0].role, chars: s.length,
      hasMemBlock: s.indexOf('【创作者偏好（长期记忆）】') >= 0,
      memText: s.indexOf('章节标题偏短句') >= 0,
      ro: s.indexOf('只读') >= 0, ctx: s.indexOf('【工作区现状】') >= 0,
      lastRole: m[m.length - 1] && m[m.length - 1].role, lastText: (m[m.length - 1] && m[m.length - 1].content) || '',
    };
  })()`);
  check('★12 记忆真的进了系统提示（不是塞进会被截断的历史）：system 里有偏好块，且是**记得的那条**',
    prompt.sysRole === 'system' && prompt.hasMemBlock === true && prompt.memText === true && prompt.ctx === true,
    { n: prompt.n, chars: prompt.chars, hasMemBlock: prompt.hasMemBlock, memText: prompt.memText });
  check('★10 只读档的系统提示写明"你改不了东西"（否则模型会一口答应"我帮你改好了"）',
    prompt.ro === true && prompt.lastRole === 'user' && prompt.lastText === '我该注意什么？',
    { ro: prompt.ro, lastRole: prompt.lastRole });

  /* ── ⑦ 切到 YOLO → 闸门 allow ── */
  await ev(`(() => { const s = document.querySelector('#lk-agent-perm'); s.value = 'yolo'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(250);
  const yolo = await ev(`(() => {
    const p = document.getElementById('lk-agent-panel');
    let stored = '';
    try { stored = (JSON.parse(localStorage.getItem('lingkuang-settings')) || {}).agentPerm || ''; } catch {}
    return { gate: p.dataset.gate, stored, cur: p.querySelector('#lk-agent-perm').value };
  })()`);
  check('★13 切成 YOLO：闸门变 allow、设置里存下',
    yolo.gate === 'allow' && yolo.stored === 'yolo' && yolo.cur === 'yolo', yolo);

  /* ── ⑧ 从对话里总结（假引擎吐一段"带代码栏与废话"的输出，顺带验容错） ── */
  const fenced = '好的，我读完了你们的对话：\n```json\n["不喜欢大段说明", "命名爱用两三个字"]\n```\n希望对你有用。';
  await ev(`window.__lkAgentMock = ${JSON.stringify(fenced)}; true`);
  await ev(`document.querySelector('#lk-agent-mem-sum').click(); true`);
  await sleep(900);
  const summed = await ev(memSnap);
  const sumDisk = diskMemory();
  check('★6 点「从对话里总结」：模型输出带代码栏与前后废话也能抠出两条，进清单（src=auto）并落盘',
    summed.n === 3 && summed.rows.filter((r) => r.src === 'auto').length === 2
      && summed.rows.some((r) => r.text === '不喜欢大段说明' && r.src === 'auto')
      && Array.isArray(sumDisk) && sumDisk.length === 3 && sumDisk.filter((x) => x.src === 'auto').length === 2
      && summed.note.indexOf('记下 2 条') >= 0,
    { n: summed.n, note: summed.note, disk: sumDisk ? sumDisk.map((x) => x.text) : null });

  /* ── ⑨ 再总结一遍同样的内容：去重，不重复记 ── */
  await ev(`window.__lkAgentMock = ${JSON.stringify('```json\n["不喜欢大段说明", "命名爱用两三个字"]\n```')}; true`);
  await ev(`document.querySelector('#lk-agent-mem-sum').click(); true`);
  await sleep(900);
  const again = await ev(memSnap);
  const againDisk = diskMemory();
  check('★7 同样的偏好再总结一遍：不重复记（条数不变、提示"已经记过了"）',
    again.n === 3 && Array.isArray(againDisk) && againDisk.length === 3 && again.note.indexOf('已经记过') >= 0,
    { n: again.n, note: again.note, disk: againDisk ? againDisk.length : null });

  /* ── ⑩ 模型没吐出数组（或者吐了一堆废话）：提示而不是乱记 ── */
  await ev(`window.__lkAgentMock = ${JSON.stringify('这段对话里我没看出什么稳定的偏好。')}; true`);
  await ev(`document.querySelector('#lk-agent-mem-sum').click(); true`);
  await sleep(900);
  const junk = await ev(memSnap);
  const junkDisk = diskMemory();
  check('★8 模型没给出数组：只提示、不新增（清单与磁盘都不动）',
    junk.n === 3 && Array.isArray(junkDisk) && junkDisk.length === 3 && junk.note.indexOf('没看出') >= 0,
    { n: junk.n, note: junk.note });

  const errs = await ev(`window.__errs || []`);
  check('★14 全程没有未捕获异常', Array.isArray(errs) && errs.length === 0, { errs });

  const pass = results.filter(Boolean).length;
  console.log(`==== ${pass}/${results.length} PASS ====`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.log('FAIL 脚本异常: ' + ((e && e.stack) || e)); process.exit(2); });
