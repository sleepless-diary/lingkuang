/** 暂存词 → 设定条目（2026-10-19 工作流评审的落地）
 *
 *  用户原话：「联想不是剔除已有设定，是**选择部分设定变成实体**，除此之外**还可以自主添加词条**，
 *  再加一个 **AI 总结**的功能，能把已选择的设定提炼成一个**完整角色**」。
 *
 *  所以这里只管三件事，别把别的判断塞进来：
 *    ① 把选中的词条列出来（可删、可自己补词）——选择权在人，不替人过滤
 *    ② 「建为设定」：原样落成一条实体（词条进字段 + 正文给骨架）
 *    ③ 「AI 提炼成角色」：把这一把词交给当前 AI 供应商，收成 {名字 / 分段字段 / 正文}，先给预览再采用
 *
 *  ⚠️ 不在这里"剔除已存在的设定"：那是上一版理解的错（用户当场纠正）。要在词库里查重的语义
 *  只属于「导出暂存词 → 词库」（`assoc.ts` 的导出按钮），与"变成实体"是两件事。
 */
import type { Store } from '../store/store';
import { addEntity } from '../store/actions';
import { aiChat, type ChatMsg } from './ai';
import { activeProviderProfile } from './settings';
import { providerProblem } from './ai-providers';
import { escapeHtml } from './html';
import { currentWorld } from '../store/store';
import type { PropValue } from '../store/types';

/** 暂存词住在 localStorage（`assoc.ts` 那一套键，别改：老数据要认） */
export const STAGED_KEY = 'lingkuang-char-staged';

export function readStaged(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STAGED_KEY) || '[]') || [];
    return Array.isArray(raw) ? raw.filter((w: unknown): w is string => typeof w === 'string' && w.length > 0) : [];
  } catch { return []; }
}

export function writeStaged(list: string[]): void {
  try { localStorage.setItem(STAGED_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

/** 往暂存词里加（去重，返回真正加进去的条数）；加完广播一声，联想画布那边会重读 */
export function pushStaged(words: string[]): number {
  const list = readStaged();
  let added = 0;
  for (const raw of words) {
    const w = String(raw ?? '').trim();
    if (!w) continue;
    if (list.indexOf(w) !== -1) continue;
    list.push(w);
    added++;
  }
  if (added) { writeStaged(list); notifyStaged(); }
  return added;
}

export function notifyStaged(): void {
  window.dispatchEvent(new CustomEvent('lingkuang-staged'));
}

/** 挑一个类型装新实体：优先名字里带「角色/人物」的类型，否则第一个；一个类型都没有就返回空串（交给 addEntity 兜底） */
export function pickTypeId(store: Store): string {
  const types = (currentWorld(store)?.entityTypes ?? {}) as Record<string, { name?: string }>;
  const ids = Object.keys(types);
  const prefer = ids.find((id) => /角色|人物/.test(types[id]?.name ?? id));
  return prefer ?? ids[0] ?? '';
}

/** 名字唯一：同名会写进同一个 `.md` 路径互相覆盖（与 `codex.ts` 的 `uniqueName()` 同一套规则） */
export function uniqueEntityName(store: Store, base: string): string {
  const taken = new Set(Object.values(currentWorld(store)?.entities ?? {}).map((e: any) => String(e?.name ?? '')));
  const seed = (base || '未命名角色').trim().slice(0, 40) || '未命名角色';
  if (!taken.has(seed)) return seed;
  for (let i = 2; i < 9999; i++) {
    const n = seed + ' ' + i;
    if (!taken.has(n)) return n;
  }
  return seed + ' ' + Date.now();
}

/** 一组词条 → 实体。`properties` 由调用方给（抽卡那张卡有词条名可当字段名，联想词没有）。
 *  正文给一份 Markdown 骨架：让「存档」这一步顺手把「正文」也开个头，而不是再造一条空稿。 */
export function createEntityFromWords(
  store: Store,
  words: string[],
  opts: { name?: string; properties?: Record<string, PropValue>; doc?: string; typeId?: string } = {},
): string | null {
  const ws = currentWorld(store);
  if (!ws) return null;
  const list = words.map((w) => String(w ?? '').trim()).filter(Boolean);
  const name = uniqueEntityName(store, opts.name || list[0] || '未命名角色');
  const doc = opts.doc ?? [
    '# ' + name,
    '',
    list.length ? '> 来自联想的 ' + list.length + ' 个词条：' + list.join('、') : '> 来自联想的词条',
    '',
    '## 梗概',
    '',
    '',
  ].join('\n');
  const properties: Record<string, PropValue> = { ...(opts.properties ?? {}) };
  if (list.length && properties['联想词条'] === undefined) properties['联想词条'] = list;
  const id = addEntity(store, {
    name,
    typeId: opts.typeId || pickTypeId(store) || undefined,
    properties,
    doc,
  });
  return id;
}

/** 灵感触发器那张卡 → 实体：词条名直接当字段名（发色/职业/秘密…本来就跟结构体字段同一套口径），
 *  正文按分组给一节，等于"把卡翻成了初稿"。 */
export function createEntityFromCard(store: Store, combo: Record<string, Record<string, string>>): string | null {
  const words: string[] = [];
  const properties: Record<string, PropValue> = {};
  const sections: string[] = [];
  for (const [group, picks] of Object.entries(combo ?? {})) {
    const rows: string[] = [];
    for (const [key, val] of Object.entries(picks ?? {})) {
      const v = String(val ?? '').trim();
      if (!v) continue;
      words.push(v);
      if (properties[key] === undefined) properties[key] = v;
      rows.push('- ' + key + '：' + v);
    }
    if (rows.length) sections.push('## ' + group + '\n\n' + rows.join('\n'));
  }
  if (!words.length) return null;
  const name = String(properties['职业'] ?? properties['身份地位'] ?? properties['气质'] ?? properties['种族'] ?? '').trim()
    || words[0];
  const doc = [
    '# ' + uniqueEntityName(store, name),
    '',
    '> 由「灵感触发器」的一组词条生成，' + words.length + ' 个词条。',
    '',
    ...sections,
    '',
  ].join('\n');
  return createEntityFromWords(store, words, { name, properties, doc });
}

/* ── AI 提炼：把选中的词条收成一个完整角色 ─────────────────────────────── */

export interface Distilled {
  name: string;
  one: string;
  fields: Record<string, string>;
  doc: string;
}

const DISTILL_SYS = [
  '你是世界观设定助手。用户会给你一组零散的创作词条（可能互相矛盾、可能只是碎片）。',
  '请把它们整合成**一个完整、自洽的角色**：可以合理补全，但不要引入与词条冲突的设定。',
  '只输出一个 JSON 对象，不要解释、不要代码围栏、不要前后缀。格式：',
  `{"name":"角色名","one":"一句话人设（30 字内）","fields":{"气质":"","职业":"","种族":"","外形":"","能力":"","弱点":"","秘密":"","目标":""},"doc":"Markdown 正文，600 字以内，用 ## 小标题分节，写清外貌、性格、来历、钩子"}`,
].join('\n');

/** 从模型回复里抠出 JSON：容忍 ```json 围栏、前后散文、尾逗号 */
export function parseDistilled(text: string, fallbackName: string): Distilled {
  let s = String(text ?? '').trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  const body = a >= 0 && b > a ? s.slice(a, b + 1) : s;
  const tryParse = (raw: string): any => {
    try { return JSON.parse(raw); } catch { /* 再试去掉尾逗号 */ }
    try { return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
  };
  const obj = tryParse(body);
  if (obj && typeof obj === 'object') {
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj.fields ?? {})) {
      if (v !== null && v !== undefined && String(v).trim()) fields[String(k)] = String(v).trim();
    }
    return {
      name: String(obj.name ?? '').trim() || fallbackName,
      one: String(obj.one ?? '').trim(),
      fields,
      doc: String(obj.doc ?? '').trim(),
    };
  }
  /* 解析不出来：整段当正文，字段留空 —— 至少别把模型的话扔掉 */
  return { name: fallbackName, one: '', fields: {}, doc: String(text ?? '').trim() };
}

export interface IntakeOpts {
  words(): string[];
  addWord(w: string): void;
  removeWord(w: string): void;
}

export interface IntakeHandle { refresh(): void }

/** 挂在联想画布工具条下面的一条「选中词条」工作栏 */
export function mountIntake(host: HTMLElement, store: Store, opts: IntakeOpts): IntakeHandle {
  host.innerHTML = `
    <div class="lk-intake">
      <div class="lk-intake__head">
        <span class="lk-intake__title">选中词条</span>
        <span class="lk-intake__cnt" id="ik-cnt">0</span>
        <span style="flex:1;"></span>
        <button id="ik-entity" class="lk-btn lk-btn--sm">建为设定</button>
        <button id="ik-ai" class="lk-btn lk-btn--sm lk-btn--primary">AI 提炼成角色</button>
      </div>
      <div class="lk-intake__chips" id="ik-chips"></div>
      <input id="ik-add" class="lk-input lk-intake__add" placeholder="补一个词条，回车加入（比如：断了一只角）" />
      <div id="ik-msg" class="lk-intake__msg"></div>
      <div id="ik-preview" class="lk-intake__preview" hidden></div>
    </div>`;

  const chips = host.querySelector('#ik-chips') as HTMLElement;
  const cnt = host.querySelector('#ik-cnt') as HTMLElement;
  const msg = host.querySelector('#ik-msg') as HTMLElement;
  const preview = host.querySelector('#ik-preview') as HTMLElement;
  const addInput = host.querySelector('#ik-add') as HTMLInputElement;
  const aiBtn = host.querySelector('#ik-ai') as HTMLButtonElement;

  const say = (t: string, bad = false): void => {
    msg.textContent = t;
    msg.style.color = bad ? 'var(--danger)' : 'var(--fg-2)';
  };

  function draw(): void {
    const words = opts.words();
    cnt.textContent = String(words.length);
    chips.innerHTML = words.length
      ? words.map((w, i) => `<span class="lk-intake__chip">${escapeHtml(w)}<button class="lk-intake__x" data-i="${i}" title="移出这一条">×</button></span>`).join('')
      : '<span class="lk-intake__empty">还没选词条：在画布上点词的「存」，或抽卡后点「→ 暂存词」。</span>';
    chips.querySelectorAll<HTMLElement>('.lk-intake__x').forEach((b) => {
      b.addEventListener('click', () => {
        const list = opts.words();
        const i = Number(b.dataset.i ?? -1);
        if (i >= 0 && i < list.length) opts.removeWord(list[i]);
        draw();
      });
    });
  }

  addInput.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    const v = addInput.value.trim();
    if (!v) return;
    opts.addWord(v);
    addInput.value = '';
    draw();
  });

  host.querySelector('#ik-entity')?.addEventListener('click', () => {
    const words = opts.words();
    if (!words.length) { say('先选几条词条，或在下面自己补一条。', true); return; }
    const id = createEntityFromWords(store, words);
    const name = id ? currentWorld(store)?.entities?.[id]?.name : '';
    say(name ? `已建为设定：${name}（在「设定库」里能看到，正文已给骨架）` : '没建成：当前没有打开的世界。', !name);
  });

  aiBtn.addEventListener('click', () => { void distill(); });

  async function distill(): Promise<void> {
    const words = opts.words();
    if (!words.length) { say('先选几条词条，或自己补一条，再让 AI 提炼。', true); return; }
    const p = activeProviderProfile();
    const bad = providerProblem(p);
    if (bad) { say('AI 不可用：' + bad + '（在 设置 → AI 供应商 里配）', true); return; }
    if (!readStaged().length) writeStaged(words);

    aiBtn.disabled = true;
    say('AI 正在把 ' + words.length + ' 个词条提炼成一个角色…');
    preview.hidden = true;
    try {
      const messages: ChatMsg[] = [
        { role: 'system', content: DISTILL_SYS },
        { role: 'user', content: '词条：\n' + words.map((w, i) => `${i + 1}. ${w}`).join('\n') },
      ];
      const reply = await aiChat(messages, { temperature: 0.5, numPredict: 1200 });
      const d = parseDistilled(reply.text, words[0]);
      renderPreview(d);
      say('提炼好了，看清楚再「采用」。');
    } catch (err) {
      say('提炼失败：' + (err instanceof Error ? err.message : String(err)), true);
    } finally {
      aiBtn.disabled = false;
    }
  }

  function renderPreview(d: Distilled): void {
    const fields = Object.entries(d.fields);
    preview.hidden = false;
    preview.innerHTML = `
      <div class="lk-intake__pv">
        <div class="lk-intake__pv-h"><b>${escapeHtml(d.name)}</b>${d.one ? `<span>${escapeHtml(d.one)}</span>` : ''}</div>
        ${fields.length ? `<div class="lk-intake__pv-fields">${fields.map(([k, v]) => `<span class="lk-chip">${escapeHtml(k)}·${escapeHtml(v)}</span>`).join('')}</div>` : ''}
        <pre class="lk-intake__pv-doc">${escapeHtml(d.doc.slice(0, 900))}${d.doc.length > 900 ? '\n…' : ''}</pre>
        <div class="lk-intake__pv-btns">
          <button id="ik-take" class="lk-btn lk-btn--sm lk-btn--primary">采用，建为设定</button>
          <button id="ik-redo" class="lk-btn lk-btn--sm lk-btn--ghost">再提炼一次</button>
          <button id="ik-drop" class="lk-btn lk-btn--sm lk-btn--ghost">弃掉</button>
        </div>
      </div>`;
    preview.querySelector('#ik-take')?.addEventListener('click', () => {
      const properties: Record<string, PropValue> = { ...d.fields };
      properties['类型'] = '人物';
      const id = createEntityFromWords(store, opts.words(), {
        name: d.name,
        properties,
        doc: d.doc ? `# ${d.name}\n\n${d.one ? '> ' + d.one + '\n\n' : ''}${d.doc}\n` : undefined,
      });
      const name = id ? currentWorld(store)?.entities?.[id]?.name : '';
      preview.hidden = true;
      say(name ? `已采用：${name}（正文与字段都写进去了）` : '没建成：当前没有打开的世界。', !name);
    });
    preview.querySelector('#ik-redo')?.addEventListener('click', () => { void distill(); });
    preview.querySelector('#ik-drop')?.addEventListener('click', () => { preview.hidden = true; say('已弃掉这次提炼结果。'); });
  }

  draw();
  return { refresh: draw };
}
