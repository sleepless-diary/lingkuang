/** 设置模块——AI 引擎（本地 Ollama / OpenAI 兼容 API）+ 偏好项；存 localStorage */
import type { Store } from '../store/store';
import { currentWorld } from '../store/store';

/** 演变（设定库的版本历史）的三种模式，用户 2026-09-13 选「都做，把模式放到设置里面」 */
export type EvolveMode = 'manual' | 'auto' | 'locked';

interface Settings {
  aiMode: 'ollama' | 'api';
  baseUrl: string;
  apiKey: string;
  model: string;
  glide: number;      // 平移惯性（0-1）
  sensitivity: number; // 平移敏感度
  rulerDensity: number; // 标尺密度
  evolveMode: EvolveMode;   // 改动什么时候变成"一版"（见设置面板里的说明）
  evolveLock: { world: string; tlId: string; nodeId: string } | null;   // 锁定模式锁在哪一格
  /** 设定库（工作台）左栏的**默认形态**（用户 2026-09-13：「设定库和编辑器是不是可以做成同一
   *  工具的两种不同形式啊（在设置里面切换）」）：`'list'` = 扁平列表（两个页签 + 类型筛选），
   *  `'tree'` = 文件夹树（节点与设定条目同框，跟硬盘目录一一对应）。
   *  面板左上角那个开关会**顺手改写这个值** ⇒ 它记的是"最后一次用的形态"。 */
  workbenchView: 'list' | 'tree';
}

const DEFAULTS: Settings = {
  aiMode: 'ollama',
  baseUrl: 'http://localhost:11434',
  apiKey: '',
  model: 'qwen2.5:7b',
  glide: 0.55,
  sensitivity: 1,
  rulerDensity: 1,
  evolveMode: 'manual',
  evolveLock: null,
  workbenchView: 'list',
};

export function loadSettings(): Settings {
  let s: Settings;
  try {
    s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('lingkuang-settings') || '{}') };
  } catch {
    s = { ...DEFAULTS };
  }
  /* 默认用 qwen2.5:7b（content 正常输出）；qwen3:14b 内容全进 thinking 联想解析不了，回退 */
  if (s.model === 'qwen3:14b' || s.model === 'qwen2.5:14b') s.model = 'qwen2.5:7b';
  return s;
}
export function saveSettings(s: Settings) {
  localStorage.setItem('lingkuang-settings', JSON.stringify(s));
}

export function renderSettings(store: Store, host: HTMLElement): void {
  const s = loadSettings();
  /* 锁定模式下要选"锁在哪一格"：列出当前世界的时间线节点（按时间排） */
  const lockWorld = store.activeWorld || '';
  const lockNodes: { id: string; tlId: string; label: string }[] = [];
  const ws: any = currentWorld(store);
  for (const tlId of ws.order ?? []) {
    const tl = ws.timelines?.[tlId];
    for (const n of tl?.nodes ?? []) {
      lockNodes.push({ id: n.id, tlId, label: `${n.year ?? ''}${n.month ? '-' + String(n.month).padStart(2, '0') : ''} ${n.title ?? ''}`.trim() });
    }
  }
  const lockId = s.evolveLock && s.evolveLock.world === lockWorld ? s.evolveLock.nodeId : '';
  host.style.overflow = 'auto';
  host.innerHTML = `
    <div style="max-width:520px;margin:0 auto;padding:20px 16px;display:flex;flex-direction:column;gap:14px;">
      <div style="font-size:17px;font-weight:600;color:var(--fg);">设置</div>
      <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;display:flex;flex-direction:column;gap:8px;">
        <div style="font-size:var(--text-sm);font-weight:600;color:var(--fg);">联想引擎</div>
        <div style="display:flex;gap:8px;">
          <label style="font-size:var(--text-xs);color:var(--fg-2);display:flex;align-items:center;gap:4px;"><input type="radio" name="aiMode" value="ollama"${s.aiMode === 'ollama' ? ' checked' : ''}/>本地 Ollama（免费 · 需自部署）</label>
          <label style="font-size:var(--text-xs);color:var(--fg-2);display:flex;align-items:center;gap:4px;"><input type="radio" name="aiMode" value="api"${s.aiMode === 'api' ? ' checked' : ''}/>OpenAI 兼容 API（按量付费）</label>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          <label style="font-size:var(--text-xs);color:var(--fg-2);">Base URL</label>
          <input id="set-baseurl" type="text" value="${s.baseUrl}" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:5px 8px;font-size:var(--text-sm);outline:none;"/>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          <label style="font-size:var(--text-xs);color:var(--fg-2);">API Key（本地模式可留空）</label>
          <input id="set-apikey" type="password" value="${s.apiKey}" placeholder="sk-..." style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:5px 8px;font-size:var(--text-sm);outline:none;"/>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          <label style="font-size:var(--text-xs);color:var(--fg-2);">模型</label>
          <input id="set-model" type="text" value="${s.model}" placeholder="qwen2.5:7b / gpt-4o-mini" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:5px 8px;font-size:var(--text-sm);outline:none;"/>
        </div>
      </div>
      <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;display:flex;flex-direction:column;gap:10px;">
        <div style="font-size:var(--text-sm);font-weight:600;color:var(--fg);">画布偏好</div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:var(--text-xs);color:var(--fg-2);width:90px;">平移惯性</span>
          <input id="set-glide" type="range" min="0" max="1" step="0.05" value="${s.glide}" style="flex:1;"/>
          <span id="set-glide-v" style="font-size:var(--text-xs);color:var(--fg-2);width:30px;text-align:right;">${s.glide}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:var(--text-xs);color:var(--fg-2);width:90px;">平移敏感度</span>
          <input id="set-sens" type="range" min="0.2" max="3" step="0.1" value="${s.sensitivity}" style="flex:1;"/>
          <span id="set-sens-v" style="font-size:var(--text-xs);color:var(--fg-2);width:30px;text-align:right;">${s.sensitivity}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:var(--text-xs);color:var(--fg-2);width:90px;">标尺密度</span>
          <input id="set-ruler" type="range" min="0.5" max="2" step="0.1" value="${s.rulerDensity}" style="flex:1;"/>
          <span id="set-ruler-v" style="font-size:var(--text-xs);color:var(--fg-2);width:30px;text-align:right;">${s.rulerDensity}</span>
        </div>
      </div>
      <div style="font-size:var(--text-xs);color:var(--fg-2);">⚠️ 灵框本体免费开源。AI 联想为可选能力——本地部署（自付电费）或第三方 API（费用由提供商收取），均与灵框无关。</div>
      <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;display:flex;flex-direction:column;gap:8px;">
        <div style="font-size:var(--text-sm);font-weight:600;color:var(--fg);">设定演变（版本历史）</div>
        <div style="font-size:var(--text-xs);color:var(--fg-2);">设定库右侧那条竖线叫「演变」：每一格是时间线上的一个事件节点。同一格可以在不同事件上长成不同的样子，这里决定<b>改动什么时候变成"一版"</b>。改完立刻生效。</div>
        <label style="font-size:var(--text-xs);color:var(--fg-2);display:flex;align-items:flex-start;gap:6px;"><input type="radio" name="evolveMode" value="manual"${s.evolveMode === 'manual' ? ' checked' : ''}/><span><b>手动</b>（默认）：只有点「＋ 在这一格记一帧」才会留一版；平时改动改的是<b>你现在看的这一版</b>，不随手产生历史。</span></label>
        <label style="font-size:var(--text-xs);color:var(--fg-2);display:flex;align-items:flex-start;gap:6px;"><input type="radio" name="evolveMode" value="auto"${s.evolveMode === 'auto' ? ' checked' : ''}/><span><b>自动</b>：改动直接落在你选中的那一格上；这一格还没有版本就自动开一个 —— 事件之间自然长出差异。</span></label>
        <label style="font-size:var(--text-xs);color:var(--fg-2);display:flex;align-items:flex-start;gap:6px;"><input type="radio" name="evolveMode" value="locked"${s.evolveMode === 'locked' ? ' checked' : ''}/><span><b>锁定</b>：改动永远记到下面选定的那一格上（右侧竖线也钉在它上面），适合"往后所有变化都算在这个事件之后"。</span></label>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:var(--text-xs);color:var(--fg-2);width:90px;">锁定在哪一格</span>
          <select id="set-evolve-lock" style="flex:1;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);padding:4px 6px;font-size:var(--text-xs);outline:none;">
            <option value="">（未选）</option>
            ${lockNodes.map((n) => `<option value="${n.id}"${n.id === lockId ? ' selected' : ''}>${n.label}</option>`).join('')}
          </select>
        </div>
        <div style="font-size:var(--text-xs);color:var(--fg-2);">「${lockWorld || '（未选世界）'}」有 ${lockNodes.length} 个事件节点可选。</div>
      </div>
      <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;display:flex;flex-direction:column;gap:8px;">
        <div style="font-size:var(--text-sm);font-weight:600;color:var(--fg);">设定库（工作台）</div>
        <div style="font-size:var(--text-xs);color:var(--fg-2);">设定库和编辑器已经并成<b>同一个工作台</b>：左栏、中栏字段、右栏正文都是同一套，只是左栏长什么样可以选。这里选的是<b>打开时默认用哪种</b>；面板左栏那个「视图」按钮随时能换，换完这里也会跟着变。</div>
        <label style="font-size:var(--text-xs);color:var(--fg-2);display:flex;align-items:flex-start;gap:6px;"><input type="radio" name="wbView" value="list"${s.workbenchView === 'list' ? ' checked' : ''}/><span><b>列表</b>（默认）：一列平铺的条目（设定 / 时间线节点两组），配一排筛选（全部 / 某个类型 / 时间线节点）与一个搜索框。条目多、想按名字快速找时顺手。</span></label>
        <label style="font-size:var(--text-xs);color:var(--fg-2);display:flex;align-items:flex-start;gap:6px;"><input type="radio" name="wbView" value="tree"${s.workbenchView === 'tree' ? ' checked' : ''}/><span><b>文件夹</b>：世界 → 时间线 → 种类 → 节点，以及世界 → <code>_设定</code> → 类型 → 实体，一棵树跟硬盘上的目录一一对应，看得见"东西放在哪"。</span></label>
      </div>
      <button id="set-save" style="background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-sm);padding:8px;font-size:var(--text-sm);cursor:pointer;">保存设置</button>
      <div id="set-msg" style="font-size:var(--text-xs);color:var(--accent);"></div>
    </div>`;

  const msg = host.querySelector('#set-msg') as HTMLElement;
  const bind = (id: string, fn: (v: string) => void) => {
    const el = host.querySelector(id) as HTMLInputElement;
    el.addEventListener('input', () => fn(el.value));
    el.addEventListener('change', () => fn(el.value));
    return el;
  };
  bind('#set-baseurl', (v) => (s.baseUrl = v));
  bind('#set-apikey', (v) => (s.apiKey = v));
  bind('#set-model', (v) => (s.model = v));
  bind('#set-glide', (v) => { s.glide = parseFloat(v); (host.querySelector('#set-glide-v') as HTMLElement).textContent = v; });
  bind('#set-sens', (v) => { s.sensitivity = parseFloat(v); (host.querySelector('#set-sens-v') as HTMLElement).textContent = v; });
  bind('#set-ruler', (v) => { s.rulerDensity = parseFloat(v); (host.querySelector('#set-ruler-v') as HTMLElement).textContent = v; });
  host.querySelectorAll('input[name="aiMode"]').forEach((el) => {
    (el as HTMLInputElement).addEventListener('change', () => {
      s.aiMode = (el as HTMLInputElement).value as Settings['aiMode'];
    });
  });
  /* 演变模式与锁定点：**立刻存盘并广播**（不用等"保存设置"）——
     设定库的右栏要在用户切回去时就已经是新规则了。 */
  const saveNow = (msgText: string) => {
    saveSettings(s);
    window.dispatchEvent(new CustomEvent('lingkuang-settings'));
    msg.textContent = msgText;
    setTimeout(() => (msg.textContent = ''), 1500);
  };
  host.querySelectorAll('input[name="evolveMode"]').forEach((el) => {
    (el as HTMLInputElement).addEventListener('change', () => {
      s.evolveMode = (el as HTMLInputElement).value as EvolveMode;
      /* 选锁定却没选过格子 → 自动落到第一个事件上，免得"锁了个空" */
      if (s.evolveMode === 'locked' && !lockId && lockNodes.length) {
        s.evolveLock = { world: lockWorld, tlId: lockNodes[0].tlId, nodeId: lockNodes[0].id };
        const sel = host.querySelector('#set-evolve-lock') as HTMLSelectElement | null;
        if (sel) sel.value = lockNodes[0].id;   /* 面板上的下拉当场显示出来 */
      }
      saveNow('已保存 ✓');
    });
  });
  host.querySelector('#set-evolve-lock')?.addEventListener('change', (ev) => {
    const id = (ev.target as HTMLSelectElement).value;
    const hit = lockNodes.find((n) => n.id === id);
    s.evolveLock = hit ? { world: lockWorld, tlId: hit.tlId, nodeId: hit.id } : null;
    saveNow(hit ? '已锁定到这一格 ✓' : '已取消锁定 ✓');
  });
  /* 工作台默认形态：同样立刻存盘 + 广播（工作台若开着，当场换左栏形态） */
  host.querySelectorAll('input[name="wbView"]').forEach((el) => {
    (el as HTMLInputElement).addEventListener('change', () => {
      s.workbenchView = (el as HTMLInputElement).value === 'tree' ? 'tree' : 'list';
      saveNow('已保存 ✓');
    });
  });
  host.querySelector('#set-save')?.addEventListener('click', () => {
    saveSettings(s);
    msg.textContent = '已保存 ✓';
    setTimeout(() => (msg.textContent = ''), 1500);
  });
}
