/* 冒烟测试：拉起 server.js -> 打全部 API -> 写 UTF-8 结果文件 -> 杀进程 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 7799;
const BASE = 'http://127.0.0.1:' + PORT;
const log = [];
const rec = (s) => log.push(s);

function run(name, fn) {
  return fn().then((r) => rec('PASS  ' + name + '  ' + r)).catch((e) => rec('FAIL  ' + name + '  ' + e.message));
}

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { KB_PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => rec('[server] ' + String(d).trim()));
  child.stderr.on('data', (d) => rec('[stderr] ' + String(d).trim()));

  await new Promise((r) => setTimeout(r, 1200));
  rec('--- API 测试 ---');

  await run('GET /api/health', async () => {
    const j = await (await fetch(BASE + '/api/health')).json();
    return 'ok=' + j.ok + ' root=' + j.root + ' md=' + j.md;
  });
  await run('GET /api/stats', async () => {
    const j = await (await fetch(BASE + '/api/stats')).json();
    return 'files=' + j.files + ' bytes=' + j.bytes + ' tops=' + Object.keys(j.byTop).slice(0, 6).join(',');
  });
  await run('GET /api/tree', async () => {
    const j = await (await fetch(BASE + '/api/tree?depth=1')).json();
    return 'topNodes=' + (j.nodes || []).map((n) => n.name + (n.type === 'dir' ? '/' : '')).join(' ');
  });
  await run('GET /api/recent', async () => {
    const j = await (await fetch(BASE + '/api/recent?limit=3')).json();
    return j.length + ' items; first=' + (j[0] ? j[0].path : '-');
  });
  await run('GET /api/file README.md', async () => {
    const j = await (await fetch(BASE + '/api/file?path=' + encodeURIComponent('README.md'))).json();
    if (j.error) throw new Error(j.error);
    return 'size=' + j.size + ' htmlLen=' + (j.html || '').length + ' head=' + String(j.text).slice(0, 60).replace(/\n/g, ' ');
  });
  await run('GET /api/search 记账', async () => {
    const j = await (await fetch(BASE + '/api/search?q=' + encodeURIComponent('记账') + '&limit=5')).json();
    return 'hits=' + j.hits.length + '; first=' + (j.hits[0] ? j.hits[0].path + ':' + j.hits[0].line : '-');
  });
  await run('GET / (index.html)', async () => {
    const r = await fetch(BASE + '/');
    const t = await r.text();
    return 'status=' + r.status + ' bytes=' + t.length + ' hasApp=' + t.includes('/app.js');
  });
  await run('GET /style.css', async () => {
    const r = await fetch(BASE + '/style.css');
    return 'status=' + r.status + ' type=' + r.headers.get('content-type');
  });
  await run('GET /app.js', async () => {
    const r = await fetch(BASE + '/app.js');
    return 'status=' + r.status + ' bytes=' + (await r.text()).length;
  });
  await run('GET /manifest.webmanifest', async () => {
    const r = await fetch(BASE + '/manifest.webmanifest');
    return 'status=' + r.status + ' type=' + r.headers.get('content-type');
  });
  await run('GET /icons/icon-192.png', async () => {
    const r = await fetch(BASE + '/icons/icon-192.png');
    return 'status=' + r.status + ' bytes=' + (await r.arrayBuffer()).byteLength;
  });
  await run('路径穿越防护 (../../Windows/win.ini)', async () => {
    const r = await fetch(BASE + '/api/file?path=' + encodeURIComponent('../../Windows/win.ini'));
    const j = await r.json();
    if (j.text || j.html) throw new Error('LEAK! 读到了 ROOT 外的文件');
    return 'blocked (' + (j.error || r.status) + ')';
  });
  await run('404 未知 API', async () => {
    const r = await fetch(BASE + '/api/nope');
    return 'status=' + r.status;
  });

  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(path.join(__dirname, 'smoke-result.txt'), log.join('\n'), 'utf8');
  process.exit(0);
})();
