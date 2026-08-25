/* 灵框 v3 · MCP Server
 * 暴露世界观查询工具给 Reasonix / Claude Code / CodeGraph 等 agent。
 * 数据源：%APPDATA%\lingkuang\worldbuilding.json（用户数据），
 * 无文件时回退到 data/worldbuilding.js 的种子（window.__SEED_TIMELINES__）。
 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const path = require('path');
const fs = require('fs');

/* ── 数据加载 ─────────────────────────────────────────────── */
function loadData() {
  /* 1) user data file (Electron app writes here) */
  const userFile = path.join(process.env.APPDATA || process.env.HOME || '.', 'lingkuang', 'worldbuilding.json');
  if (fs.existsSync(userFile)) {
    try {
      const d = JSON.parse(fs.readFileSync(userFile, 'utf8'));
      if (d && d.timelines) return d;
    } catch (e) { /* fall through to seed */ }
  }
  /* 2) seed data */
  global.window = {};
  require(path.join(__dirname, 'data', 'worldbuilding.js'));
  return { timelines: global.window.__SEED_TIMELINES__ || {} };
}

/* helper: 收集某时间线的全部可查节点（普通 + 循环展开） */
function collectNodes(tl) {
  return (tl.nodes || []).map((n) => ({ ...n, __source: 'plain' }));
}

function fmtYear(n) {
  const y = n.year;
  let out = y < 0 ? '公元前 ' + (-y) + ' 年' : '公元 ' + y + ' 年';
  if (n.month) out += n.month + ' 月';
  if (n.day) out += n.day + ' 日';
  if (n.hour !== undefined) out += n.hour + ' 时';
  return out;
}

const server = new McpServer({
  name: 'lingkuang-worldbuilding',
  version: '3.0.0'
});

/* ── query_timeline: 列出时间线 + 节点概览 ─────────────────── */
server.tool(
  'query_timeline',
  '查询世界观时间线：列出所有世界线及节点摘要',
  { worldId: z.string().optional().describe('世界线 id，缺省列出全部') },
  async ({ worldId }) => {
    const { timelines } = loadData();
    const ids = worldId ? [worldId] : Object.keys(timelines);
    const lines = ids.map((id) => {
      const tl = timelines[id];
      if (!tl) return `⚠️ 世界线「${id}」不存在`;
      const nodes = collectNodes(tl);
      return `【${tl.name}】(id=${id}, absOffset=${tl.absOffset || 0}, 节点 ${nodes.length} 个)\n` +
        nodes.map((n) => `  - ${fmtYear(n)} ${n.title}${n.desc ? '：' + n.desc : ''}`).join('\n');
    });
    return { content: [{ type: 'text', text: lines.join('\n\n') || '(空)' }] };
  }
);

/* ── query_node: 按年份查节点 ──────────────────────────────── */
server.tool(
  'query_node',
  '按年份查询某世界线的节点（可精确到年月日小数年）',
  { year: z.number().describe('年份，如 672 或 1832.5'), worldId: z.string().optional() },
  async ({ year, worldId }) => {
    const { timelines } = loadData();
    const ids = worldId ? [worldId] : Object.keys(timelines);
    const hits = [];
    ids.forEach((id) => {
      const tl = timelines[id];
      if (!tl) return;
      collectNodes(tl).forEach((n) => {
        const abs = n.__source === 'loop' ? n.__absoluteYear : n.year;
        if (Math.abs(Number(abs) - year) < 1) {
          hits.push(`【${tl.name}】${fmtYear(n)} ${n.title}${n.desc ? '：' + n.desc : ''}${n.__source === 'loop' ? '（轮回周期 ' + ((n.__cycle || 0) + 1) + '）' : ''}`);
        }
      });
    });
    return { content: [{ type: 'text', text: hits.length ? hits.join('\n') : `公元 ${year} 年没有找到节点` }] };
  }
);

/* ── search_world: 全文搜索人物/地点/事件 ──────────────────── */
server.tool(
  'search_world',
  '在世界观中全文搜索：匹配标题/描述/关联人物/关联地点',
  { query: z.string().describe('关键词，如 蚀渊、雅缇娜、生命木棺') },
  async ({ query }) => {
    const { timelines } = loadData();
    const q = query.toLowerCase();
    const hits = [];
    Object.keys(timelines).forEach((id) => {
      const tl = timelines[id];
      if (!tl) return;
      collectNodes(tl).forEach((n) => {
        const hay = [n.title, n.desc, ...(n.people || []), ...(n.places || [])].join(' ').toLowerCase();
        if (hay.includes(q)) {
          hits.push(`【${tl.name}】${fmtYear(n)} ${n.title}（人物：${(n.people || []).join('/') || '—'}，地点：${(n.places || []).join('/') || '—'}）`);
        }
      });
    });
    return { content: [{ type: 'text', text: hits.length ? hits.join('\n') : `没找到与「${query}」相关的内容` }] };
  }
);

/* ── query_loop: 查询循环周期 ──────────────────────────────── */
server.tool(
  'query_loop',
  '查询世界线的循环周期（轮回）设置',
  { worldId: z.string().optional() },
  async ({ worldId }) => {
    const { timelines } = loadData();
    const ids = worldId ? [worldId] : Object.keys(timelines);
    const lines = ids.map((id) => {
      const tl = timelines[id];
      if (!tl) return `⚠️ 世界线「${id}」不存在`;
      const loops = Array.isArray(tl.loops) ? tl.loops : [];
      if (!loops.length) return `【${tl.name}】无循环`;
      return loops.map((L) => {
        const startN = (tl.nodes || []).find((n) => n.id === L.startNodeId);
        const endN = (tl.nodes || []).find((n) => n.id === L.endNodeId);
        return `【${tl.name}】${L.name || '循环'}：${startN ? startN.title : '?'} → ${endN ? endN.title : '?'}`;
      }).join('\n');
    });
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  }
);

/* ── 启动 ──────────────────────────────────────────────────── */
const transport = new StdioServerTransport();
server.connect(transport);
