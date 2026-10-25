/* 地图生成内核（vendored mapgen4）的**无头**回归测试 —— 不需要 Electron、不需要 CDP 实例。
 *
 *  为什么有这个文件：地形算法的 bug 靠看截图是猜、靠数字是定论（第九十一轮的老办法）。
 *  渲染那一层要 WebGL（`tools/e2e/map-gen.cjs` / `map-studio.cjs` 在真实例里管），
 *  但**生成**这一层是纯计算 ⇒ 就在这里把数字钉死：确定性、陆地占比、档位形态、河流密度、耗时。
 *
 *  用法：`node tools/e2e/mapgen-engine.mjs`（自己用 vite 的 lib 模式把 `src/mapgen/index.ts`
 *  打成 CJS 再 require；全局 esbuild/vite 配置都不依赖）。退出码 0 = 全过。
 */
import { build } from 'vite';
import { createRequire } from 'module';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.resolve(HERE, '..', '..');
const outDir = path.join(os.tmpdir(), 'lk-mapgen-engine-test');

const results = [];
function check(name, ok, extra) {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '   ' + JSON.stringify(extra) : ''}`);
}

await build({
  configFile: false,
  logLevel: 'error',
  build: {
    lib: { entry: path.join(PROJ, 'src/mapgen/index.ts'), formats: ['cjs'], fileName: () => 'engine.cjs' },
    outDir,
    emptyOutDir: true,
    minify: false,
    target: 'node18',
  },
});
const require = createRequire(import.meta.url);
const E = require(path.join(outDir, 'engine.cjs'));

/* 星球形态（`src/mapgen/planet.ts`）也在这里量 —— 它同样**纯计算**，不用起实例。
   ⚠️ 同一个 outDir ⇒ `emptyOutDir: false`，否则会把刚打好的 engine.cjs 删掉。 */
await build({
  configFile: false,
  logLevel: 'error',
  build: {
    lib: { entry: path.join(PROJ, 'src/mapgen/planet.ts'), formats: ['cjs'], fileName: () => 'planet.cjs' },
    outDir,
    emptyOutDir: false,
    minify: false,
    target: 'node18',
  },
});
const P = require(path.join(outDir, 'planet.cjs'));

function run(seed, style, spec, opts) {
  const t0 = Date.now();
  const eng = E.createEngineFor(seed, style, spec);
  const tMesh = Date.now() - t0;
  const t1 = Date.now();
  E.runGeneration(eng, opts);
  const tGen = Date.now() - t1;
  return { tMesh, tGen, stats: E.statsOf(eng), eng };
}
/* 比"同种子一致"时把耗时剔掉（那是机器状态，不是确定性） */
const core = (r) => JSON.stringify(r.stats);

/* ★0 参数表：**上游的骨架值不能动**（抄错了下面全会歪）；灵框刻意改过的三项单独钉住。
   第一百零四轮（用户：「山很少」「只能看出山脉和平原两种地形」）改了三处：
     · `elevation.hill_height` 0.02 → 0.07（上游一半陆地是平地）
     · `elevation.mountain_folds` 0.05 → 0.18（只改渲染的脊谷对比）
     · `spacing` 5.5 → 4.8（三角边在屏幕上 8.6px → 7.5px：海岸/山脊的波长下限）
     · `noisy_coastlines` 大陆 0.012→0.028 / 群岛 0.05→0.055 / 盘古 0.02→0.032（海岸更碎）
     · `biomes.raininess` 0.9 → 0.55 / `rain_shadow` 0.5 → 0.7（降雨挤在湿区 ⇒ 气候表只能上一色绿） */
{
  const d = E.DEFAULT_PARAMS;
  check('★0 参数表：上游骨架 + 灵框刻意偏离的几处', d.spacing === 4.8 && d.mountainSpacing === 35 && d.mesh.seed === 12345
    && d.elevation.seed === 187 && d.elevation.island === 0.5 && d.elevation.mountain_sharpness === 9.8
    && d.elevation.hill_height === 0.07 && d.elevation.mountain_folds === 0.18
    && d.biomes.raininess === 0.55 && d.biomes.rain_shadow === 0.7
    && d.rivers.lg_min_flow === 2.7 && d.render.tilt_deg === 0,
    { spacing: d.spacing, meshSeed: d.mesh.seed, elevSeed: d.elevation.seed, hill: d.elevation.hill_height, folds: d.elevation.mountain_folds, rain: d.biomes.raininess });
}

/* ★1 网格建得出来（规模对得上上游：spacing 4.8 ⇒ 约 3.3 万区域 / 6.6 万三角形） */
const base = run('灵框测试', 'continent', { landRatio: 0.34, ridges: 4, rivers: 1 });
{
  const m = base.eng.mesh;
  check('★1 网格规模', m.numSolidRegions > 28000 && m.numSolidTriangles > 55000
    && base.eng.t_peaks.length > 200,
    { regions: m.numSolidRegions, triangles: m.numSolidTriangles, peaks: base.eng.t_peaks.length });
}

/* ★2 陆地占比精确命中（灵框自己加的重定海平面那一步） */
{
  const out = [];
  let ok = true;
  for (const target of [0.2, 0.35, 0.55]) {
    const r = run('占比' + target, 'continent', { landRatio: target, ridges: 4, rivers: 1 });
    const got = r.stats.landRatio;
    out.push({ target, got: +got.toFixed(3) });
    if (Math.abs(got - target) > 0.012) ok = false;
  }
  check('★2 陆地占比命中目标 ±0.012', ok, out);
}

/* ★3 确定性：同种子逐位一致；换种子必须不同 */
{
  const a = run('维斯莱特', 'continent', { landRatio: 0.34 });
  const b = run('维斯莱特', 'continent', { landRatio: 0.34 });
  const c = run('维斯莱特2', 'continent', { landRatio: 0.34 });
  check('★3 同种子一致 + 换种子不同', core(a) === core(b) && core(a) !== core(c),
    { same: core(a) === core(b), diff: core(a) !== core(c) });
}

/* ★22 局部（三角网）海岸够碎 —— 第一百零七轮加的 `addCoastDetail()`。
   用户 2026-10-23：「陆地边缘还是看起来太顺滑了」。星球栅格那条线由 ★15~17 守，
   局部那条（WebGL 网格 + `frag_drape`）只能在这里量几何：
   `岸线三角 ÷ 陆地三角`（一个陆地三角只要有水邻边就算岸线）。
   旧版（没有 addCoastDetail）实测 0.164~0.242，加完之后 0.219~0.287 ⇒ 门槛取 0.19。
   ⚠️ 这个数**跨种子漂**，别贴着实测值往紧里调。 */
{
  const eng = base.eng;
  const mesh = eng.mesh;
  const n = mesh.numSolidTriangles;
  const e = eng.map.elevation_t;
  const land = new Uint8Array(n);
  let landN = 0, edge = 0;
  for (let t = 0; t < n; t++) if (e[t] >= 0) { land[t] = 1; landN++; }
  for (let t = 0; t < n; t++) {
    for (let j = 0; j < 3; j++) {
      const u = mesh.t_outer_s(3 * t + j);
      if (u >= 0 && u < n && u !== t && land[u] !== land[t]) { edge++; break; }
    }
  }
  const ratio = edge / Math.max(1, landN);
  check('★22 局部网格海岸够碎（岸线三角 ÷ 陆地三角 ≥ 0.19）', ratio >= 0.19,
    { ratio: +ratio.toFixed(3), landN, edge });
}

/* ★4 三档位形态分化：群岛的岛必须比盘古多（同一颗种子、同一目标占比） */
{
  const spec = { landRatio: 0.34, ridges: 4, rivers: 1 };
  const cont = run('档位', 'continent', spec).stats;
  const arch = run('档位', 'archipelago', spec).stats;
  const pan = run('档位', 'pangaea', spec).stats;
  check('★4 档位形态分化', arch.islands > cont.islands && arch.islands > pan.islands && pan.lands <= cont.lands,
    { cont: { l: cont.lands, i: cont.islands }, arch: { l: arch.lands, i: arch.islands }, pan: { l: pan.lands, i: pan.islands } });
}

/* ★5 河流密度随档位单调增（阈值是分位数自校准的，所以这条同时钉住了校准逻辑） */
{
  const rs = [0, 1, 2, 3].map((rivers) => run('水', 'continent', { landRatio: 0.34, ridges: 4, rivers }).stats.rivers);
  check('★5 河数随档位单调增', rs[0] < rs[1] && rs[1] < rs[2] && rs[2] < rs[3], { rivers: rs });
}

/* ★6 山脊密度：旋钮越小 ⇒ 山峰间距越大 */
{
  const sp = [2, 4, 6].map((ridges) => run('密度', 'continent', { landRatio: 0.34, ridges }).eng.params.mountainSpacing);
  check('★6 山脊密度→山峰间距递减', sp[0] > sp[1] && sp[1] > sp[2], { spacings: sp });
}

/* ★7 统计字段齐、都在合理范围（面板/助手回执直接读它） */
{
  const s = base.stats;
  const keys = ['lands', 'islands', 'zones', 'rivers', 'lakes', 'peak', 'landRatio', 'regions', 'longestRiver'];
  const finite = keys.every((k) => typeof s[k] === 'number' && Number.isFinite(s[k]));
  check('★7 统计字段完整且合理', finite && s.lands >= 1 && s.zones >= 1 && s.peak > 3000 && s.peak <= 9000
    && s.landRatio > 0 && s.landRatio < 1,
    { lands: s.lands, islands: s.islands, zones: s.zones, rivers: s.rivers, lakes: s.lakes, peak: s.peak, longestRiver: s.longestRiver });
}

/* ★8 shape:false（画笔那条路，不重定海平面）也能跑，且确实更快 */
{
  const t0 = Date.now();
  const eng = E.createEngineFor('画笔', 'continent', { landRatio: 0.34 });
  E.runGeneration(eng, { shape: false });
  const t1 = Date.now();
  const s = E.statsOf(eng);
  const slow = base.tGen;
  check('★8 shape:false 可用', s.landRatio > 0 && t1 - t0 < Math.max(slow * 2, 400),
    { ms: t1 - t0, withShape: slow, landRatio: +s.landRatio.toFixed(3) });
}

/* ★9 耗时预算：建网格 + 生成 < 3s（面板上点一下就得出来） */
check('★9 建网格+生成 < 3000ms', base.tMesh + base.tGen < 3000, { tMesh: base.tMesh, tGen: base.tGen });

/* ── 手刷地形（画笔）：数据里只存**笔划**，生成时重放 ──────────────────────────
   ⚠️ 内核的高度约束场是**模块级单例**（128×128）：换种子才会重新生成。
   所以这一组测试的写法必须守两条：① 同种子的"没刷"那一跑必须排在"刷了"之前；
   ② 要测"重放"就得先拿另一颗种子把场冲干净。 */
const spec = { landRatio: 0.34, ridges: 4, rivers: 1 };
/** 横着扫一遍的一条宽带（25 个点）：不赌"刷的那一点是海还是陆"，直接跨过去 */
const band = (tool, y) => ({ tool, size: 'medium', points: Array.from({ length: 25 }, (_, i) => ({ x: 0.05 + i * 0.0375, y })) });
/* ⚠️ 判据不能用 `landRatio`：**它被 `reseatSeaLevel()` 钉在目标值上**（重新定海平面 ⇒ 永远是 0.34）。
   全局平均海拔也钝（水下被压成很窄一段）。看"刷的那一片变成什么了"最准 —— 取一条纬度窗口里的
   水域占比：造山 ⇒ 那片变陆地（水域占比降），深海 ⇒ 那片变海（升）。 */
const areaWater = (eng, y0, y1) => {
  const e = eng.map.elevation_t, mesh = eng.mesh;
  let w = 0, n = 0;
  for (let t = 0; t < e.length; t++) {
    const y = mesh.y_of_t(t) / 1000;
    if (y < y0 || y > y1) continue;
    n++;
    if (e[t] < 0) w++;
  }
  return n ? w / n : 0;
};

/* ★10 造山 / 深海真的改地形（同种子、只差笔迹） */
{
  const a0 = run('笔迹A', 'continent', spec);
  const wa0 = areaWater(a0.eng, 0.25, 0.35);
  const a1 = run('笔迹A', 'continent', spec, { strokes: [band('mountain', 0.3)] });
  const wa1 = areaWater(a1.eng, 0.25, 0.35);
  const wb0 = areaWater(run('笔迹B', 'continent', spec).eng, 0.6, 0.7);
  const wb1 = areaWater(run('笔迹B', 'continent', spec, { strokes: [band('ocean', 0.65)] }).eng, 0.6, 0.7);
  check('★10 造山把那一带变陆地 / 深海把它淹掉', wa1 < wa0 - 0.1 && wb1 > wb0 + 0.1,
    { mountain: { before: +wa0.toFixed(3), after: +wa1.toFixed(3) },
      ocean: { before: +wb0.toFixed(3), after: +wb1.toFixed(3) } });
}

/* ★11 重放确定性：同一份笔迹 ⇒ 同一片地（这是"关掉重开还是这张图"的根据） */
{
  const strokes = [band('mountain', 0.4), { tool: 'shallow', size: 'small', points: [{ x: 0.2, y: 0.2 }, { x: 0.22, y: 0.21 }] }];
  const s1 = run('笔迹R', 'continent', spec, { strokes });
  run('冲干净', 'continent', spec);                       /* 换种子 ⇒ 约束场被重新生成 */
  const s2 = run('笔迹R', 'continent', spec, { strokes }); /* 再重放一遍 */
  const painted = E.paintedSoFar();
  check('★11 笔迹重放逐位一致', core(s1) === core(s2) && painted,
    { same: core(s1) === core(s2), painted, land: +s2.stats.landRatio.toFixed(3) });
}

/* ★12 同一块场里连跑两遍不能叠加（护栏 `paintedSoFar()`：场里已有笔迹就跳过重放） */
{
  const eng = E.createEngineFor('双刷', 'continent', spec);
  const strokes = [band('mountain', 0.5)];
  E.runGeneration(eng, { strokes });
  const once = E.statsOf(eng);
  E.runGeneration(eng, { strokes });
  const twice = E.statsOf(eng);
  check('★12 二次生成不叠笔迹', JSON.stringify(once) === JSON.stringify(twice),
    { lands: once.lands, peak: once.peak, second: twice.peak });
}

/* ★13 清空笔迹：`resetPaint()` 之后回到没刷过的样子 */
{
  const strokes = [band('ocean', 0.5)];
  const dirtyEng = run('笔迹C', 'continent', spec, { strokes });
  const dirty = E.paintedSoFar();
  const wDirty = areaWater(dirtyEng.eng, 0.45, 0.55);
  E.resetPaint();                             /* = 界面上「清空笔迹」 */
  const eng = E.createEngineFor('笔迹C', 'continent', spec);
  E.runGeneration(eng);                       /* 场刚被 resetPaint 重新生成过 ⇒ 干净，不重放 */
  const wClean = areaWater(eng, 0.45, 0.55);
  check('★13 清空笔迹后回到干净地形', dirty && !E.paintedSoFar() && wDirty > wClean + 0.1,
    { dirty, after: E.paintedSoFar(), painted: +wDirty.toFixed(3), cleared: +wClean.toFixed(3) });
}

/* ★14 「看的方式」九档（第九十七轮三档 → 第一百零三轮八档 → 第一百三十轮加「等高线地形图」）：
   它只是**一组渲染参数**（纯函数），与"生成什么地形"无关 ⇒ 缺省/认不出的值都必须落回默认档（自然），
   这是"不传就什么都不变"的保证。另外几条新契约：
     · 每档都带**色带**（陆地 8 个等距采样点 ×3、海 6×3）与线/河色 —— 缺一项那一档就只剩"调亮度"；
     · 旧 id（relief/contour/flat）必须仍能归一化（老数据不炸）；
     · 新增的 `atlas`（等高线地形图）必须**真的分层设色 + 等高线**（bands > 1 且 contour = 1），
       色带要比 `topo` 更鲜艳（色度更高）—— 用户 2026-10-25：「现在的颜色几乎看不出分层设色，
       可以做成课本里面那样鲜艳颜色的形式吗」。 */
{
  const r = E.styleRenderParams('natural');
  const t = E.styleRenderParams('topo');
  const a = E.styleRenderParams('atlas');
  const m = E.styleRenderParams('minimal');
  const legacy = E.styleRenderParams('relief');
  const unknown = E.styleRenderParams('不认识的东西');
  const none = E.styleRenderParams(undefined);
  const d = E.DEFAULT_PARAMS.render;
  const ids = E.TERRAIN_STYLES.map((s) => s.id).join(',');
  const rampOk = (p) => Array.isArray(p.land_ramp) && p.land_ramp.length === 24
    && Array.isArray(p.sea_ramp) && p.sea_ramp.length === 18
    && Array.isArray(p.line_color) && p.line_color.length === 3
    && Array.isArray(p.river_color) && p.river_color.length === 3
    && p.land_ramp.every((v) => v >= 0 && v <= 1);
  /* 色带着色度（max-min）的均值：`atlas` 要比 `topo` 的浅淡色带明显鲜艳 */
  const chroma = (p) => {
    let s = 0;
    for (let i = 0; i < p.land_ramp.length; i += 3) {
      const r0 = p.land_ramp[i], g0 = p.land_ramp[i + 1], b0 = p.land_ramp[i + 2];
      s += Math.max(r0, g0, b0) - Math.min(r0, g0, b0);
    }
    return s / (p.land_ramp.length / 3);
  };
  const ok = E.TERRAIN_STYLES.length === 9
    && ids === 'natural,topo,atlas,paper,ink,blueprint,dreamcore,satellite,minimal'
    && E.TERRAIN_STYLES.every((s) => s.label && s.hint)
    && d.shade === 1 && d.contour === 0 && d.contour_scale === 10 && d.bands === 0
    && E.TERRAIN_STYLE_DEFS.every((def) => rampOk(E.styleRenderParams(def.id)))
    && r.shade === 1 && r.contour === 0 && r.bands === 0 && r.grade === 1
    && t.shade > 0 && t.shade < 1 && t.contour === 1 && t.contour_scale > 1 && t.bands > 1
    && a.shade > 0 && a.shade < 1 && a.contour === 1 && a.contour_scale > 1 && a.bands > 1
    && chroma(a) > chroma(t) * 1.15
    && m.shade === 0 && m.detail === 0 && m.contour === 0 && m.bands === 0
    && JSON.stringify(unknown) === JSON.stringify(r) && JSON.stringify(none) === JSON.stringify(r)
    && JSON.stringify(legacy) === JSON.stringify(r)
    && E.isTerrainStyle('topo') && E.isTerrainStyle('atlas') && !E.isTerrainStyle('contour') && !E.isTerrainStyle(null)
    && E.terrainStyleOf('contour') === 'topo' && E.terrainStyleOf('flat') === 'minimal'
    && E.terrainStyleOf('乱写') === 'natural'
    && E.terrainStyleLabel('topo') === '地形图' && E.terrainStyleLabel('atlas') === '等高线地形图'
    && E.terrainStyleLabel(undefined) === '自然';
  check('★14 风格九档是一组渲染参数（每档带色带；atlas 分层设色更鲜艳；旧 id 走别名；缺省/认不出落回自然）', ok,
    { ids, chroma: { atlas: +chroma(a).toFixed(3), topo: +chroma(t).toFixed(3) },
      natural: r, topo: t, atlas: a, minimal: m, legacyFallsBack: JSON.stringify(legacy) === JSON.stringify(r) });
}

/* ── 星球形态：**大陆感**（第九十九轮）──────────────────────────────────────────
   用户原话「**大陆没有大陆的感觉**」。判据全是"像不像大陆"里可量化那部分：
   · 陆块数 + 最大陆块占比 ⇒ 少数大而连续的陆块 vs 一堆大小相近的碎块（旧版 = 后者）；
   · 海岸碎度（与海相邻的格 ÷ 陆地格）⇒ **下限**守"海岸够碎"、**上限**守"不碎成满边毛刺"；
     ⚠️ 第一百零七轮换了口径：用户 2026-10-23 说「陆地边缘还是看起来太顺滑了」⇒ 以前只守上限
     （海岸不许比基准更碎），现在同时守下限（海岸必须碎到看得见）。实测（3 种子 × 3 档，@256）：
     大陆 0.144~0.159、盘古 0.096~0.128、群岛 0.166~0.192（旧版分别是 0.051~0.064 / 0.035~0.039 / 0.11~0.127）。
   · 极区陆地占比 ⇒ 开放极海（有极地陆地时，等距圆柱投影会把它拉成**横贯全图的条带**）；
   · 主峰集中度（峰值 ÷ 陆地平均海拔）⇒ 有主山体 vs 满地山包。
   ⚠️ 这些数字**跨种子漂**（5 种子实测大陆档：lands 1~3、largest 0.41~0.94、coast 0.05~0.07），
   所以阈值取的是"**新构建必过、旧构建必挂**"，不是贴着实测均值 —— 别按某一颗种子的读数往紧里调。 */
function planetComps(w, h, mask) {
  const n = w * h, seen = new Uint8Array(n), st = new Int32Array(n), out = [];
  for (let s = 0; s < n; s++) {
    if (seen[s] || !mask[s]) continue;
    let top = 0; st[top++] = s; seen[s] = 1; let size = 0;
    while (top) {
      const i = st[--top]; size++;
      const y = (i / w) | 0, x = i - y * w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const j = yy * w + ((x + dx + w) % w);
          if (!seen[j] && mask[j]) { seen[j] = 1; st[top++] = j; }
        }
      }
    }
    out.push(size);
  }
  return out.sort((a, b) => b - a);
}
function planetMetrics(f) {
  const cs = planetComps(f.w, f.h, f.land);
  const tot = cs.reduce((a, b) => a + b, 0);
  const big = Math.max(60, Math.round(tot * 0.03));
  let edge = 0, peak = 0, sum = 0, landN = 0, polar = 0, pn = 0;
  for (let i = 0; i < f.h; i++) for (let j = 0; j < f.w; j++) {
    const k = i * f.w + j;
    if (i < 3 || i >= f.h - 3) { pn++; if (f.land[k]) polar++; }
    if (!f.land[k]) continue;
    landN++; sum += f.elev[k]; if (f.elev[k] > peak) peak = f.elev[k];
    let hit = false;
    for (let dy = -1; dy <= 1 && !hit; dy++) {
      const yy = i + dy; if (yy < 0 || yy >= f.h) { hit = true; break; }
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        if (!f.land[yy * f.w + ((j + dx + f.w) % f.w)]) { hit = true; break; }
      }
    }
    if (hit) edge++;
  }
  return {
    lands: cs.filter((s) => s >= big).length,
    largest: tot ? cs[0] / tot : 0,
    coast: edge / Math.max(1, landN),
    peakRatio: peak / Math.max(1, sum / Math.max(1, landN)),
    polar: polar / Math.max(1, pn),
  };
}
{
  const m = {};
  for (const style of ['continent', 'archipelago', 'pangaea']) {
    m[style] = planetMetrics(P.buildPlanetField('lk-大陆感', style, undefined, 256));
  }
  const brief = (s) => ({
    lands: m[s].lands, largest: +m[s].largest.toFixed(3),
    coast: +m[s].coast.toFixed(3), peakRatio: +m[s].peakRatio.toFixed(2), polar: +m[s].polar.toFixed(3),
  });
  check('★15 大陆档：少数大而连续的陆块（碎块守 lands/largest，海岸必须够碎）',
    m.continent.lands <= 4 && m.continent.largest >= 0.36
      && m.continent.coast >= 0.10 && m.continent.coast <= 0.30, brief('continent'));
  check('★16 盘古档：连成一整块（碎块守 lands，海岸必须够碎）',
    m.pangaea.lands <= 3 && m.pangaea.coast >= 0.06 && m.pangaea.coast <= 0.26, brief('pangaea'));
  check('★17 群岛档：多而小，海岸最碎',
    m.archipelago.lands >= 4 && m.archipelago.coast >= 0.13 && m.archipelago.coast <= 0.36, brief('archipelago'));
  check('★18 极区是海（三档都查：防极地陆地被投影拉成横贯全图的条带）',
    ['continent', 'archipelago', 'pangaea'].every((s) => m[s].polar <= 0.02),
    { continent: +m.continent.polar.toFixed(3), archipelago: +m.archipelago.polar.toFixed(3), pangaea: +m.pangaea.polar.toFixed(3) });
  check('★19 主峰集中：峰值 ÷ 陆地平均海拔 ≥ 5.9（有主山体，不是满地山包）',
    ['continent', 'archipelago', 'pangaea'].every((s) => m[s].peakRatio >= 5.9),
    { continent: +m.continent.peakRatio.toFixed(2), archipelago: +m.archipelago.peakRatio.toFixed(2), pangaea: +m.pangaea.peakRatio.toFixed(2) });
}

{
  /* ★20 / ★21（2026-10-13 用户「**分辨率和细节都不够**」）：
     河网要像河（细线），不能糊成一片蓝须；等高线要真画得出来（低地也得有线）。
     ⚠️ 两条都是**比例阀值**，与分辨率无关 —— 换 `PLANET_H` 不用改它们。 */
  const f = P.buildPlanetField('lk-detail', 'continent', { landRatio: 0.34, ridges: 4, rivers: 4 }, 256);
  let landN = 0, riverN = 0;
  for (let k = 0; k < f.w * f.h; k++) if (f.land[k]) { landN++; if (f.river[k]) riverN++; }
  const dens = riverN / Math.max(1, landN);
  check('★20 河网是线不是草：河格 ≤ 2% 陆地格（旧版 2.4% ⇒ 铺满全陆地的蓝色短须）',
    dens > 0.0004 && dens <= 0.02, { riverCells: riverN, landCells: landN, density: +dens.toFixed(4) });

  /* ★21 用**视口分辨率的一半**（512）量，并且与「10 档」那条老口径**现场比** ——
     只有这样才钉得住「线比从前细、低地也有线」，而不是把一个绝对密度写死。 */
  const f512 = P.buildPlanetField('lk-detail', 'continent', { landRatio: 0.34, ridges: 4, rivers: 4 }, 512);
  const cl = (v, a, b) => (v < a ? a : v > b ? b : v);
  let cross10 = 0, landPx = 0;
  for (let i = 0; i < f512.h; i++) for (let j = 0; j < f512.w; j++) {
    const k = i * f512.w + j;
    if (!f512.land[k]) continue;
    landPx++;
    const b = cl((f512.e01[k] * 10) | 0, 0, 9);
    const kl = i * f512.w + (j + f512.w - 1) % f512.w;
    const ku = (i > 0 ? i - 1 : 0) * f512.w + j;
    if (b !== cl((f512.e01[kl] * 10) | 0, 0, 9) || b !== cl((f512.e01[ku] * 10) | 0, 0, 9)) cross10++;
  }
  const darkOf = (rgba) => {
    let d = 0;
    for (let k = 0; k < f512.w * f512.h; k++) {
      if (!f512.land[k]) continue;
      const o = k * 4;
      if (rgba[o] < 150 && rgba[o + 1] < 150) d++;   /* 两种线色（#777a62 / #4a4e3a）都远深于十档浅色底 */
    }
    return d;
  };
  /* ⭐ 第一百一十轮：自动档从「跳线」改成「淡出」（跳线会断线，小图上一片虚线）。
     ⇒ ★21 的口径拆成两条：手选「全部」仍要 ≥1.3× 老 10 档口径；自动档要比「全部」**浅**
     （淡出生效）但仍有足够多的线（不是把等高线整个淡没了）。 */
  const darkAll = darkOf(P.renderPlanet(f512, 'contour', 1));
  const dark = darkOf(P.renderPlanet(f512, 'contour'));
  check('★21 等高线真画出来了（手选「全部」≥1.3× 老 10 档口径，且不是糊成一片）',
    landPx > 0 && darkAll >= cross10 * 1.3 && darkAll / landPx >= 0.02 && darkAll / landPx <= 0.45,
    { darkPct: +(darkAll / landPx * 100).toFixed(1), cross10, vs10: +(darkAll / Math.max(1, cross10)).toFixed(2) });
  check('★21b 自动档是「淡出」而不是「跳线」：比全部浅、但不是没有线',
    dark < darkAll && dark >= darkAll * 0.45 && dark / landPx >= 0.015,
    { darkAuto: dark, darkAll, ratio: +(dark / Math.max(1, darkAll)).toFixed(2) });
}

/* ── 等高线抽稀档位（第一百零八轮）──────────────────────────────────────────
   用户原话：「有些地方因为地形陡峭导致等高线有点密集，能不能加一个等高线绘制方式，
   是全部显示还是省略部分」。口径 = 自动 + 手选三档：
   · auto = 0（着色器按屏幕线距现算）、all = 1、half = 2、fifth = 5；
   · 认不出的值一律落回自动（老数据/脏数据不炸）。 */
{
  const map = { auto: 0, all: 1, half: 2, fifth: 5 };
  const ok = Object.entries(map).every(([k, v]) => E.contourEveryOf(k) === v)
    && E.contourEveryOf(undefined) === 0
    && E.contourEveryOf('乱写') === 0
    && E.contourModeOf('fifth') === 'fifth'
    && E.contourModeOf(null) === 'auto'
    && E.CONTOUR_MODES.length === 4
    && E.CONTOUR_MODES.map((m) => m.id).join(',') === 'auto,all,half,fifth'
    && E.contourModeLabel('half') === '减半';
  check('★22 等高线方式四档（auto=0 / all=1 / half=2 / fifth=5）且脏值落回自动', ok,
    { modes: E.CONTOUR_MODES.map((m) => m.id) });
}

/* ── 手绘海陆掩膜（第一百零八轮）──────────────────────────────────────────────
   用户原话：「做一个简易的编辑器，能让用户自行绘制大陆和地形，并在此之上生成对应地形」。
   判据（不看图）：同样种子/档位，只换掩膜 ⇒
     · 全陆地掩膜 → 陆地占比趋近 1，全海洋掩膜 → 趋近 0（剪影优先于噪声）；
     · 掩膜只画东半球一块 → 陆地占比落在剪影那一块附近、且与"不画掩膜"那张明显不同。
   掩膜格式 = 每格 2bit、低位在前的 base64（与画板 encodeMask 同一口径）。 */
{
  const pack = (cells) => {
    const bytes = new Uint8Array(Math.ceil(cells.length * 2 / 8));
    for (let i = 0; i < cells.length; i++) {
      const bit = i * 2;
      bytes[bit >> 3] |= (cells[i] & 3) << (bit & 7);
    }
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };
  const W = 160, H = 80, N = W * H;
  const all = (v) => new Uint8Array(N).fill(v);
  const landRatioOf = (f) => {
    let n = 0;
    for (let k = 0; k < f.land.length; k++) n += f.land[k];
    return n / f.land.length;
  };
  const spec = { landRatio: 0.34, ridges: 4, rivers: 2 };
  const base = landRatioOf(P.buildPlanetField('lk-mask', 'continent', spec, 256, null));
  const allLand = landRatioOf(P.buildPlanetField('lk-mask', 'continent', spec, 256, { w: W, h: H, bits: pack(all(1)) }));
  const allSea = landRatioOf(P.buildPlanetField('lk-mask', 'continent', spec, 256, { w: W, h: H, bits: pack(all(2)) }));
  /* 只画东半球（列 80..159）一块陆地，其余留白 = 海洋 */
  const east = new Uint8Array(N).fill(2);
  for (let y = 20; y < 60; y++) for (let x = 80; x < 150; x++) east[y * W + x] = 1;
  const eastRatio = landRatioOf(P.buildPlanetField('lk-mask', 'continent', spec, 256, { w: W, h: H, bits: pack(east) }));
  const eastWant = (40 * 70) / N;
  check('★23 剪影优先：全陆地掩膜 ⇒ 陆地≈1、全海洋 ⇒ ≈0、画一块 ⇒ 只争那块',
    base > 0.2 && base < 0.6 && allLand > 0.97 && allSea < 0.03
    && eastRatio > eastWant * 0.6 && eastRatio < eastWant * 2.2,
    { noMask: +base.toFixed(3), allLand: +allLand.toFixed(3), allSea: +allSea.toFixed(3), east: +eastRatio.toFixed(3), eastWant: +eastWant.toFixed(3) });
}

/* ── 海底生成（第一百三十二轮）────────────────────────────────────────────────
   用户原话：「给地图生成加上海底生成的功能，顺便匹配各个风格」。
   以前的海洋高度只有一条 `dist/9` 的坡 + 一点噪声 ⇒ 海面是一片平的蓝色渐变。
   这一轮在海里补了陆架 / 陆坡 / 深海盆 / 洋中脊 / 海沟 / 海山，判据全离线、不看图：
    · 参数：缺省 2、夹 0..4、脏值落回 2（老图没有这个字段时也真的在跑）；
    · 只换 seabed ⇒ 陆地掩膜**一格不变**（海底不参与海陆判定），海底高度标准差与最深海沟随档单调增；
    · 海底永远不冒出水面（非陆格 elev 必须 < 0，否则渲染/汇流/统计会各说各话）；
    · 极点收敛：海底也是**单位球上的 3D 噪声** ⇒ 极地整行的起伏远小于赤道行；
    · 确定性：同参数两次逐字节一致；
    · 九档风格各带一套海底画法（自然/卫星晕渲、地形图/等高线/蓝图等深线、极简只分档）；
    · 晕渲真的画出来了：自然档海面的亮度标准差明显大于极简档（极简是平色的）。 */
{
  const spec = { landRatio: 0.34, ridges: 4, rivers: 1 };
  const sbOf = (v) => P.planetSpec('continent', { ...spec, seabed: v }).seabed;
  check('★24 海底起伏参数：缺省 2 / 夹在 0..4 / 脏值落回 2',
    sbOf(undefined) === 2 && sbOf(0) === 0 && sbOf(4) === 4 && sbOf(99) === 4 && sbOf(-3) === 0
    && sbOf(NaN) === 2 && sbOf('乱写') === 2,
    { def: sbOf(undefined), max: sbOf(99), min: sbOf(-3) });
}
{
  const spec = { landRatio: 0.34, ridges: 4, rivers: 1 };
  const f = (v) => P.buildPlanetField('lk-seabed', 'continent', { ...spec, seabed: v }, 256);
  const f0 = f(0), f2 = f(2), f4 = f(4);
  const seaStat = (x) => {
    let n = 0, deepest = 0, breach = 0, rough = 0, roughN = 0;
    for (let k = 0; k < x.w * x.h; k++) {
      if (x.land[k]) continue;
      const d = -x.elev[k];
      if (!(d > 0)) breach++;
      n++;
      if (d > deepest) deepest = d;
      /* 局部起伏（"海底有没有细节"）：与 4 邻居均值之差 —— 陆架→深海盆那条大坡本身
         也在起伏里，所以在 0 档也不为 0；换 seabed 只影响构造地形那部分。 */
      const y = (k / x.w) | 0, xx = k - y * x.w;
      if (y === 0 || y === x.h - 1) continue;
      const l = y * x.w + ((xx + x.w - 1) % x.w), r = y * x.w + ((xx + 1) % x.w);
      const u = (y - 1) * x.w + xx, dn = (y + 1) * x.w + xx;
      if (x.land[l] || x.land[r] || x.land[u] || x.land[dn]) continue;
      rough += Math.abs(x.elev[k] - (x.elev[l] + x.elev[r] + x.elev[u] + x.elev[dn]) / 4);
      roughN++;
    }
    return { rough: rough / Math.max(1, roughN), deepest, breach, n };
  };
  const s0 = seaStat(f0), s2 = seaStat(f2), s4 = seaStat(f4);
  let landSame = f0.land.length === f4.land.length;
  for (let k = 0; landSame && k < f0.land.length; k++) if (f0.land[k] !== f4.land[k]) landSame = false;
  check('★25 海底起伏旋钮：陆地一格不变，海底局部起伏与最深海沟随档单调增、海底不漏出水面',
    landSame && s0.rough < s2.rough && s2.rough < s4.rough && s0.deepest < s2.deepest && s2.deepest < s4.deepest
    && s0.breach === 0 && s2.breach === 0 && s4.breach === 0,
    { landSame, roughM: [Math.round(s0.rough * 1000), Math.round(s2.rough * 1000), Math.round(s4.rough * 1000)],
      deepestKm: [+s0.deepest.toFixed(2), +s2.deepest.toFixed(2), +s4.deepest.toFixed(2)], breach: s4.breach });
}
{
  /* ★26 统计与极点：`stats.deepest` 与逐格最深处一致；极地那行的海底起伏必须收敛
     （用"整行离均值最大偏差"，与 map-planet.cjs ★6 的判据同源）。 */
  const spec = { landRatio: 0.34, ridges: 4, rivers: 1, seabed: 4 };
  const f = P.buildPlanetField('lk-seabed', 'continent', spec, 256);
  let deepest = 0;
  for (let k = 0; k < f.w * f.h; k++) if (!f.land[k] && -f.elev[k] > deepest) deepest = -f.elev[k];
  const rowSpread = (y) => {
    let n = 0, sum = 0;
    for (let x = 0; x < f.w; x++) { const k = y * f.w + x; if (f.land[k]) continue; sum += f.elev[k]; n++; }
    if (!n) return null;
    const mean = sum / n;
    let hi = 0;
    for (let x = 0; x < f.w; x++) { const k = y * f.w + x; if (f.land[k]) continue; const v = Math.abs(f.elev[k] - mean); if (v > hi) hi = v; }
    return hi;
  };
  const pole = rowSpread(0), poleS = rowSpread(f.h - 1), eq = rowSpread(f.h >> 1);
  check('★26 最深海沟进统计、极地的海底也收敛（3D 噪声：极地行起伏 ≪ 赤道行）',
    Math.abs(f.stats.deepest - Math.round(deepest * 1000)) <= 1 && f.stats.deepest > 0
    && pole !== null && poleS !== null && eq !== null
    && pole < eq * 0.5 && poleS < eq * 0.5,
    { statDeepest: f.stats.deepest, deepest: Math.round(deepest * 1000),
      spread: { pole: +(pole || 0).toFixed(2), poleS: +(poleS || 0).toFixed(2), equator: +(eq || 0).toFixed(2) } });
}
{
  /* ★27 确定性：同参数两次逐字节一致（海底也是纯函数，不吃时间/随机） */
  const spec = { landRatio: 0.34, ridges: 4, rivers: 1, seabed: 3 };
  const a = P.buildPlanetField('lk-seabed-det', 'continent', spec, 256);
  const b = P.buildPlanetField('lk-seabed-det', 'continent', spec, 256);
  let same = a.elev.length === b.elev.length && a.elev.length > 0;
  for (let k = 0; same && k < a.elev.length; k++) if (a.elev[k] !== b.elev[k]) same = false;
  check('★27 海底确定性：同种子/档位/海底档两次逐字节一致', same, { cells: a.elev.length });
}
{
  /* ★28 九档都带海底画法（纯参数）：这是"顺便匹配各个风格"的契约 ——
     自然/卫星靠晕渲、地形图/等高线/蓝图靠等深线 + 分层设色、极简只分档不晕渲。 */
  const ids = E.TERRAIN_STYLES.map((s) => s.id);
  const sb = {};
  for (const id of ids) sb[id] = E.styleSeabed(id);
  const ok = ids.length === 9
    && ids.every((id) => sb[id] && sb[id].shade >= 0 && sb[id].bathy >= 0 && sb[id].bands >= 0)
    && sb.natural.shade > 0.5 && sb.natural.bathy === 0
    && sb.topo.bathy > 0.5 && sb.topo.bands > 1
    && sb.atlas.bathy > 0.5 && sb.atlas.bands > 1
    && sb.paper.bathy > 0 && sb.paper.bathy < sb.topo.bathy
    && sb.ink.bathy > 0 && sb.ink.shade > 0
    && sb.blueprint.bathy > 0.5
    && sb.satellite.shade >= sb.natural.shade && sb.satellite.bathy === 0
    && sb.minimal.shade === 0 && sb.minimal.bands > 1 && sb.minimal.bathy === 0
    && E.styleSeabed('relief').shade === sb.natural.shade
    && E.styleSeabed('乱写').shade === sb.natural.shade;
  check('★28 九档风格各带海底画法（自然/卫星晕渲、地形图/等高线/蓝图等深线、极简只分档）', ok, sb);
}
{
  /* ★29 晕渲真的进了像素：同一片海，自然档（连续色带 + 晕渲）的海面亮度标准差
     必须明显大于极简档（只有几档纯色）。只看海格，陆地的山不参与比较。 */
  const spec = { landRatio: 0.34, ridges: 4, rivers: 1, seabed: 4 };
  const f = P.buildPlanetField('lk-seabed', 'continent', spec, 256);
  const seaSd = (view) => {
    const rgba = P.renderPlanet(f, view);
    let n = 0, sum = 0, sum2 = 0;
    for (let k = 0; k < f.w * f.h; k++) {
      if (f.land[k]) continue;
      const o = k * 4;
      const l = rgba[o] * 0.299 + rgba[o + 1] * 0.587 + rgba[o + 2] * 0.114;
      n++; sum += l; sum2 += l * l;
    }
    const mean = sum / n;
    return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  };
  const sdNat = seaSd('natural'), sdMin = seaSd('minimal');
  check('★29 海底晕渲真画了：自然档海面亮度标准差明显大于极简档', sdNat > sdMin * 1.5,
    { natural: +sdNat.toFixed(2), minimal: +sdMin.toFixed(2), ratio: +(sdNat / Math.max(1e-6, sdMin)).toFixed(2) });
}

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
