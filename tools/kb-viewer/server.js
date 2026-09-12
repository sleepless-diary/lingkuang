#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────
 * 灵框 · 知识库日志查看器 (kb-viewer)  v0.1.0
 * 灵框 LingKuang 的新工具分支 —— 让手机 / 平板也能翻知识库
 *
 * 零依赖 Node HTTP 服务（markdown-it 可选复用灵框自己的依赖）。
 * 启动:  node tools/kb-viewer/server.js
 * 环境:  KB_PORT(默认7717) KB_HOST(默认0.0.0.0) KB_ROOT(默认F:/knowledge-base)
 * ─────────────────────────────────────────────────────────────────── */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VERSION = '0.1.0';
const PORT = Number(process.env.KB_PORT || 7717);
const HOST = process.env.KB_HOST || '0.0.0.0';
const ROOT = path.resolve(process.env.KB_ROOT || 'F:/knowledge-base');
const PUBLIC = path.join(__dirname, 'public');
const MAX_FILE = 4 * 1024 * 1024;   /* 单文件读取上限 4MB */

/* 可选：复用灵框的 markdown-it（从上级 node_modules 解析） */
let md = null;
let mdEngine = 'builtin';
try {
  const MarkdownIt = require('markdown-it');
  md = new MarkdownIt({ html: false, linkify: true, breaks: false });
  mdEngine = 'markdown-it';
} catch (e) { /* 降级到内置迷你渲染器 */ }

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.js', '.ts', '.css', '.html', '.yml', '.yaml', '.csv', '.log', '.py', '.sh', '.bat', '.xml']);
const IGNORE_DIRS = new Set(['.git', 'node_modules', '.obsidian', '.trash', '__pycache__', '.cache', '$RECYCLE.BIN']);

/* ── 路径安全：把请求路径夹死在 ROOT 内 ── */
function safeJoin(rel) {
  const clean = String(rel || '').replace(/^[\\/]+/, '');
  const abs = path.resolve(ROOT, clean);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}
function relOf(abs) { return path.relative(ROOT, abs).split(path.sep).join('/'); }
function isText(p) { return TEXT_EXT.has(path.extname(p).toLowerCase()); }

/* ── 目录树 ── */
function buildTree(dir, depth, maxDepth) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory() && IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const node = { name: e.name, path: relOf(full), type: 'dir' };
      if (depth < maxDepth) node.children = buildTree(full, depth + 1, maxDepth);
      out.push(node);
    } else {
      if (!isText(full)) continue;
      let st = null; try { st = fs.statSync(full); } catch (x) {}
      out.push({ name: e.name, path: relOf(full), type: 'file', size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 });
    }
  }
  out.sort((a, b) => (a.type === b.type) ? a.name.localeCompare(b.name, 'zh') : (a.type === 'dir' ? -1 : 1));
  return out;
}

/* ── 全文搜索 ── */
function walkFiles(dir, acc, cap) {
  if (acc.length >= cap) return acc;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const e of entries) {
    if (acc.length >= cap) return acc;
    if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, acc, cap);
    else if (isText(full)) acc.push(full);
  }
  return acc;
}
function search(q, limit) {
  const needle = String(q || '').toLowerCase().trim();
  if (!needle) return [];
  const hits = [];
  const files = walkFiles(ROOT, [], 4000);
  for (const f of files) {
    if (hits.length >= limit) break;
    let st; try { st = fs.statSync(f); } catch (e) { continue; }
    if (st.size > MAX_FILE) continue;
    if (path.basename(f).toLowerCase().includes(needle)) {
      hits.push({ path: relOf(f), line: 0, text: '（文件名匹配）', mtime: st.mtimeMs });
      if (hits.length >= limit) break;
    }
    let text; try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        hits.push({ path: relOf(f), line: i + 1, text: lines[i].trim().slice(0, 200), mtime: st.mtimeMs });
        break;
      }
    }
  }
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits.slice(0, limit);
}

/* ── 最近修改 ── */
function recent(limit, dir) {
  const base = dir ? safeJoin(dir) : ROOT;
  if (!base) return [];
  const files = walkFiles(base, [], 6000);
  return files.map((f) => {
    let st; try { st = fs.statSync(f); } catch (e) { return null; }
    return { path: relOf(f), name: path.basename(f), size: st.size, mtime: st.mtimeMs };
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/* ── 统计 ── */
function stats() {
  const files = walkFiles(ROOT, [], 20000);
  let bytes = 0;
  const byTop = {};
  for (const f of files) {
    try { bytes += fs.statSync(f).size; } catch (e) {}
    const top = relOf(f).includes('/') ? relOf(f).split('/')[0] : '(根目录)';
    byTop[top] = (byTop[top] || 0) + 1;
  }
  return { files: files.length, bytes, byTop };
}

/* ── 内置迷你 Markdown 渲染（markdown-it 不可用时降级） ── */
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function miniMarkdown(src) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  let html = '', inCode = false, inList = false, inTable = false;
  const closeAll = () => { if (inList) { html += '</ul>'; inList = false; } if (inTable) { html += '</tbody></table>'; inTable = false; } };
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (!inCode) { closeAll(); html += '<pre><code>'; inCode = true; }
      else { html += '</code></pre>'; inCode = false; }
      continue;
    }
    if (inCode) { html += esc(line) + '\n'; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { closeAll(); html += '<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { closeAll(); html += '<hr>'; continue; }
    if (/^\s*[-*+]\s+/.test(line)) {
      if (!inList) { closeAll(); html += '<ul>'; inList = true; }
      html += '<li>' + inline(line.replace(/^\s*[-*+]\s+/, '')) + '</li>';
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
      if (!inTable) { if (inList) { html += '</ul>'; inList = false; } html += '<table><tbody>'; inTable = true; }
      html += '<tr>' + cells.map((c) => '<td>' + inline(c.trim()) + '</td>').join('') + '</tr>';
      continue;
    }
    if (/^\s*>\s?/.test(line)) { closeAll(); html += '<blockquote>' + inline(line.replace(/^\s*>\s?/, '')) + '</blockquote>'; continue; }
    if (!line.trim()) { closeAll(); continue; }
    closeAll();
    html += '<p>' + inline(line) + '</p>';
  }
  closeAll();
  if (inCode) html += '</code></pre>';
  return html;
}
function renderMarkdown(text) { return md ? md.render(text) : miniMarkdown(text); }

/* ── HTTP ── */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function send(res, code, body, type) {
  const headers = { 'Cache-Control': 'no-cache' };
  if (type) headers['Content-Type'] = type;
  res.writeHead(code, headers);
  res.end(body);
}
function json(res, obj, code) { send(res, code || 200, JSON.stringify(obj), 'application/json; charset=utf-8'); }

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = decodeURIComponent(parsed.pathname);

  if (p === '/api/health') return json(res, { ok: true, name: 'lingkuang-kb-viewer', version: VERSION, root: ROOT, md: mdEngine, port: PORT });
  if (p === '/api/stats') return json(res, stats());
  if (p === '/api/tree') return json(res, { root: ROOT, nodes: buildTree(ROOT, 0, Number(parsed.searchParams.get('depth') || 3)) });
  if (p === '/api/recent') return json(res, recent(Number(parsed.searchParams.get('limit') || 30), parsed.searchParams.get('dir')));
  if (p === '/api/search') return json(res, { q: parsed.searchParams.get('q') || '', hits: search(parsed.searchParams.get('q'), Number(parsed.searchParams.get('limit') || 50)) });
  if (p === '/api/file') {
    const abs = safeJoin(parsed.searchParams.get('path'));
    if (!abs) return json(res, { error: 'bad path' }, 400);
    let st; try { st = fs.statSync(abs); } catch (e) { return json(res, { error: 'not found' }, 404); }
    if (st.isDirectory()) return json(res, { error: 'is a directory' }, 400);
    if (st.size > MAX_FILE) return json(res, { error: 'too large' }, 413);
    let text; try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { return json(res, { error: 'read failed' }, 500); }
    let html = ''; try { html = renderMarkdown(text); } catch (e) { html = '<pre>' + esc(text) + '</pre>'; }
    return json(res, { path: relOf(abs), name: path.basename(abs), size: st.size, mtime: st.mtimeMs, text, html, mode: mdEngine });
  }
  if (p === '/api/save' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > MAX_FILE) req.destroy(); });
    req.on('end', () => {
      let payload; try { payload = JSON.parse(body); } catch (e) { return json(res, { error: 'bad json' }, 400); }
      const abs = safeJoin(payload.path);
      if (!abs || !isText(abs)) return json(res, { error: 'bad path' }, 400);
      try { fs.writeFileSync(abs, String(payload.text === undefined ? '' : payload.text), 'utf8'); } catch (e) { return json(res, { error: 'write failed: ' + e.message }, 500); }
      json(res, { ok: true, path: relOf(abs) });
    });
    return;
  }
  if (p.startsWith('/api/')) return json(res, { error: 'unknown endpoint' }, 404);

  const rel = p === '/' ? 'index.html' : p.replace(/^\//, '');
  const fp = path.join(PUBLIC, rel);
  if (!fp.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
  fs.readFile(fp, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
    send(res, 200, data, MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream');
  });
});

function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const k of Object.keys(ifs)) for (const i of ifs[k] || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}

server.listen(PORT, HOST, () => {
  const ips = lanIPs();
  console.log('\n  灵框 · 知识库日志查看器  v' + VERSION);
  console.log('  root   ' + ROOT);
  console.log('  md     ' + mdEngine);
  console.log('  本机   http://localhost:' + PORT);
  ips.forEach((ip) => console.log('  手机   http://' + ip + ':' + PORT + '   <- 同一WiFi下用这个'));
  console.log('');
});
