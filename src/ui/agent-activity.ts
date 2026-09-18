/** 灵框 · 创作者的操作流水（助手据此知道「他刚才在忙什么」）。
 *
 *  用户 2026-09-18：「能不能让这个 ai 能读到我的过去操作行为」。
 *
 *  为什么用**差分**而不是在动作点埋点：全仓写入都走 `store.update`，但它只收一个 mutator、
 *  没有语义标签（工作台里直改字段、tiptap 失焦提交、回收站恢复全在里面），埋点必然漏；
 *  差分只认「数据真的变了」，改哪儿都收得到，也不会因为将来新增一个写入口就失忆。
 *
 *  为什么独立于助手面板：面板没开的时候他的操作也是操作，助手下次打开要能看到。
 *  为什么只留最近 80 条：这是给模型看的「近况」，不是审计日志。
 */
import type { Store } from '../store/store';
import type { PropValue, WorldData, Worldset } from '../store/types';

export interface Act {
  at: number;      // epoch 毫秒
  text: string;    // 「把事件「王国的建立」挪到了 320 年」
}

const MAX = 80;          // 留这么多条（落盘也是这么多）
const SHOW = 12;         // 塞进上下文的最多条数
const BATCH_MS = 500;    // 一次操作会连着改好几刀 store，攒一攒再算
const SAVE_MS = 1500;    // 流水自己的落盘节流（走 agent:save 的 activity 键）
const MAX_LINES = 6;     // 一次 flush 最多记几行，其余折成「还有 N 处改动」

let log: Act[] = [];
let saveTimer = 0;
/** 助手代劳窗口：这段时间里落下的改动算「它自己干的」，跟创作者的手动操作区分开 */
let tagUntil = 0;

/** 流水自己的落盘（防抖 SAVE_MS）：面板没开也要存 —— 他下次叫出助手时该看得到自己刚才干了什么。
 *  `agent:save` 是「给了才写」，只带 activity 不会碰 chat.json / memory.json。 */
function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try { void (window as any).lingkuangAPI?.agentSave?.({ activity: recentActivity() }); } catch { /* 存不下不影响他干活 */ }
  }, SAVE_MS);
}

/** 盘上读回来的流水（`agent:load` 的 activity）——只认形状对得上的 */export function loadActivity(list: unknown): void {
  if (!Array.isArray(list)) return;
  log = list
    .filter((x): x is Act => !!x && typeof (x as Act).text === 'string' && typeof (x as Act).at === 'number')
    .slice(-MAX);
}

export function recentActivity(n = MAX): Act[] { return log.slice(-n); }

/** 接下来 ms 内的改动标成「灵框助手代劳」（助手执行写动作前调它） */
export function agentActing(ms = 2000): void { tagUntil = Date.now() + ms; }

function push(text: string): void {
  const last = log[log.length - 1];
  /* 同一句话连着来（比如反复拖同一个滑块）不重复记，免得把流水撑满 */
  if (last && last.text === text && Date.now() - last.at < 1500) return;
  log.push({ at: Date.now(), text });
  if (log.length > MAX) log.splice(0, log.length - MAX);
  scheduleSave();
}

/* ── 快照与差分 ──────────────────────────────────────────────── */

interface EntSnap { name: string; typeId: string; props: string; doc: string; frames: number }
interface NodeSnap { title: string; year: number; kind: string; props: string; doc: string }
interface TlSnap { name: string; nodes: Map<string, NodeSnap> }
interface WsSnap { name: string; tls: Map<string, TlSnap>; ents: Map<string, EntSnap> }
type Snap = Map<string, WsSnap>;

function sig(props?: Record<string, PropValue>): string {
  if (!props) return '';
  return JSON.stringify(Object.keys(props).sort().map((k) => [k, props[k]]));
}

/** 正文只留「长度 + 指纹」：正文可能很长，快照里不能存原文（每次 flush 都要重建整张快照） */
function docSig(s?: string): string {
  if (!s) return '';
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

function snapOf(data: WorldData): Snap {
  const out: Snap = new Map();
  for (const [wid, ws] of Object.entries(data.worldsets ?? {})) {
    const tls = new Map<string, TlSnap>();
    for (const [tid, tl] of Object.entries(ws.timelines ?? {})) {
      const nodes = new Map<string, NodeSnap>();
      for (const n of tl.nodes ?? []) {
        nodes.set(n.id, {
          title: n.title, year: n.year, kind: n.kind || '',
          props: sig(n.properties), doc: docSig(n.doc),
        });
      }
      tls.set(tid, { name: tl.name, nodes });
    }
    const ents = new Map<string, EntSnap>();
    for (const [eid, e] of Object.entries(ws.entities ?? {})) {
      ents.set(eid, {
        name: e.name, typeId: e.typeId, props: sig(e.properties),
        doc: docSig(e.doc), frames: (e.frames ?? []).length,
      });
    }
    out.set(wid, { name: ws.name, tls, ents });
  }
  return out;
}

/** 改了哪几个字段（只报名字，最多 3 个） */
function changedKeys(a: string, b: string): string[] {
  let pa: Record<string, PropValue> = {}, pb: Record<string, PropValue> = {};
  try { pa = Object.fromEntries(JSON.parse(a || '[]')); } catch { /* 坏签名当空 */ }
  try { pb = Object.fromEntries(JSON.parse(b || '[]')); } catch { /* 同上 */ }
  const keys: string[] = [];
  for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
    if (JSON.stringify(pa[k]) !== JSON.stringify(pb[k])) keys.push(k);
    if (keys.length >= 3) break;
  }
  return keys;
}

function typeName(ws: Worldset, typeId: string): string {
  return ws.entityTypes?.[typeId]?.name || '未分类';
}

/** 两帧自建快照之间发生了什么（返回值：人话句子） */
function diff(prev: Snap, next: Snap, data: WorldData): string[] {
  const lines: string[] = [];
  for (const [wid, nw] of next) {
    const pw = prev.get(wid);
    if (!pw) { lines.push(`新建了世界「${nw.name}」`); continue; }
    if (pw.name !== nw.name) lines.push(`把世界「${pw.name}」改名成「${nw.name}」`);
    const ws = data.worldsets[wid];
    if (!ws) continue;

    for (const [tid, nt] of nw.tls) {
      const pt = pw.tls.get(tid);
      if (!pt) { lines.push(`新建了时间线「${nt.name}」`); continue; }
      if (pt.name !== nt.name) lines.push(`把时间线「${pt.name}」改名成「${nt.name}」`);
      for (const [nid, nn] of nt.nodes) {
        const pn = pt.nodes.get(nid);
        if (!pn) { lines.push(`在「${nt.name}」新建了事件「${nn.year} 年 ${nn.title}」`); continue; }
        const where = `事件「${nn.title}」`;
        if (pn.title !== nn.title) lines.push(`把事件「${pn.title}」改名成「${nn.title}」`);
        if (pn.year !== nn.year) lines.push(`把${where}挪到了 ${nn.year} 年`);
        if (pn.kind !== nn.kind && nn.kind) lines.push(`把${where}的种类改成「${nn.kind}」`);
        if (pn.props !== nn.props) {
          const ks = changedKeys(pn.props, nn.props);
          lines.push(ks.length ? `改了${where}的字段「${ks.join('、')}」` : `改了${where}的字段`);
        }
        if (pn.doc !== nn.doc) lines.push(`写了${where}的正文`);
      }
      for (const [nid, pn] of pt.nodes) if (!nt.nodes.has(nid)) lines.push(`删掉了事件「${pn.title}」`);
    }
    for (const [tid, pt] of pw.tls) if (!nw.tls.has(tid)) lines.push(`删掉了时间线「${pt.name}」`);

    for (const [eid, ne] of nw.ents) {
      const pe = pw.ents.get(eid);
      if (!pe) { lines.push(`新建了设定「${ne.name}」（${typeName(ws, ne.typeId)}）`); continue; }
      const who = `设定「${ne.name}」`;
      if (pe.name !== ne.name) lines.push(`把设定「${pe.name}」改名成「${ne.name}」`);
      if (pe.typeId !== ne.typeId) lines.push(`把${who}换成了「${typeName(ws, ne.typeId)}」`);
      if (pe.props !== ne.props) {
        const ks = changedKeys(pe.props, ne.props);
        lines.push(ks.length ? `改了${who}的字段「${ks.join('、')}」` : `改了${who}的字段`);
      }
      if (pe.doc !== ne.doc) lines.push(`写了${who}的正文`);
      if (ne.frames > pe.frames) lines.push(`给${who}记了一版演变`);
    }
    for (const [eid, pe] of pw.ents) if (!nw.ents.has(eid)) lines.push(`删掉了设定「${pe.name}」`);
  }
  for (const [wid, pw] of prev) if (!next.has(wid)) lines.push(`删掉了世界「${pw.name}」`);
  return lines;
}

/** 挂上监听：从这一刻起，store 的任何实际改动都会被记成人话（防抖 BATCH_MS 合并一次操作的多刀更新） */
export function watchActivity(store: Store): void {
  let prev = snapOf(store.data);
  let timer = 0;
  store.subscribe(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const next = snapOf(store.data);
      const lines = diff(prev, next, store.data);
      prev = next;
      if (!lines.length) return;
      const byAgent = Date.now() < tagUntil;
      /* 一次操作改了很多处时只留前几行，剩下的折成一句，别把流水顶爆 */
      const head = lines.slice(0, MAX_LINES);
      if (lines.length > head.length) head.push(`还有 ${lines.length - head.length} 处改动`);
      for (const l of head) push(byAgent ? `${l}（灵框助手代劳）` : l);
    }, BATCH_MS);
  });
}

/* ── 给模型看的那一块 ────────────────────────────────────────── */

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 拼进上下文的「他最近做过的事」；没有流水返回 ''（调用方自己决定兜什么） */
export function activityBlock(n = SHOW): string {
  if (!log.length) return '';
  const items = log.slice(-n);
  const head = `【他最近做过的事】界面自动记的 ${log.length} 条操作流水，旧 → 新（最后 ${items.length} 条）：`;
  const body = items.map((a) => `  ${hhmm(a.at)} ${a.text}`).join('\n');
  const tail = '\n  （这些是他自己动手改的；标着「灵框助手代劳」的才是你改的。）';
  return head + '\n' + body + tail;
}
