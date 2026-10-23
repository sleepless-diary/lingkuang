/** 加载提示（第一百零六轮）。
 *
 *  用户原话：「给加载做一点提示，不然别人以为会卡了」。
 *  起因：星球形态第一次生成是 **~2s 的同步长任务**（`buildPlanetField` 1.4s + 上色 0.5s），
 *  期间窗口连"正在算"都不会画出来（主线程被占），用户看到的就是"点了没反应"。
 *  这一层只负责**把话说出来**：一个盖在目标区域上的遮罩 + 转圈 + 一句在做什么，
 *  有确定进度时再给一条进度条（分帧改造见 `src/mapgen/planet.ts` 的 `*Gen` 生成器）。
 *
 *  ⚠️ 用法上只有一条规矩：**先让浏览器画一帧，再干重活**（`await nextFrame()`）。
 *  不先画帧的话，遮罩刚插进 DOM 就被同一个长任务挡住，等于没插。 */

export interface BusyHandle {
  /** 改文案 / 进度（pct = 0..1；给 undefined 就是不确定进度，只转圈） */
  set: (text: string, pct?: number, sub?: string) => void;
  /** 收掉遮罩（幂等；元素已被别处移除时也不会炸） */
  done: () => void;
}

/** 让浏览器把当前 DOM 画出来（两次 rAF + 一次 setTimeout，覆盖合成器的慢帧） */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
  });
}

const HOSTS = new WeakMap<HTMLElement, BusyHandle>();

/** 在 `host` 上盖一层"正在算"。host 必须是 `position: relative` 的盒子（否则遮罩会跑到页面外）。 */
export function showBusy(host: HTMLElement, text: string, opts?: { pct?: number; sub?: string }): BusyHandle {
  /* 同一个盒子上重复 show ⇒ 复用那一层（避免快速连点叠出好几层遮罩） */
  const old = HOSTS.get(host);
  if (old) { old.done(); }

  const root = document.createElement('div');
  root.className = 'lk-busy';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.innerHTML = `
    <div class="lk-busy__box">
      <span class="lk-busy__spin" aria-hidden="true"></span>
      <div class="lk-busy__text"></div>
      <div class="lk-busy__bar" hidden><i></i></div>
      <div class="lk-busy__sub"></div>
    </div>`;
  const textEl = root.querySelector('.lk-busy__text') as HTMLElement;
  const subEl = root.querySelector('.lk-busy__sub') as HTMLElement;
  const barEl = root.querySelector('.lk-busy__bar') as HTMLElement;
  const fillEl = barEl.querySelector('i') as HTMLElement;
  host.appendChild(root);

  let closed = false;
  const apply = (t: string, pct?: number, sub?: string) => {
    textEl.textContent = t;
    subEl.textContent = sub ?? '';
    subEl.hidden = !sub;
    if (typeof pct === 'number' && Number.isFinite(pct)) {
      barEl.hidden = false;
      fillEl.style.width = Math.max(0, Math.min(1, pct)) * 100 + '%';
    } else {
      barEl.hidden = true;
    }
  };
  apply(text, opts?.pct, opts?.sub);

  const handle: BusyHandle = {
    set: (t, pct, sub) => { if (!closed) apply(t, pct, sub); },
    done: () => {
      if (closed) return;
      closed = true;
      root.classList.add('is-out');
      /* 淡出 160ms（`.lk-busy` 的 transition）; 万一被提前重画也自然消失 */
      window.setTimeout(() => root.remove(), 220);
      if (HOSTS.get(host) === handle) HOSTS.delete(host);
    },
  };
  HOSTS.set(host, handle);
  return handle;
}

/** 包一段**同步**重活：先画遮罩 → 让出两帧 → 干活 → 收遮罩。 */
export async function withBusy<T>(host: HTMLElement, text: string, work: () => T): Promise<T> {
  const h = showBusy(host, text);
  await nextFrame();
  try {
    return work();
  } finally {
    h.done();
  }
}
