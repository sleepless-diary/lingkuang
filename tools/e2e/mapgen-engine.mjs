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

/* ★0 参数表：默认值必须是上游那套（抄错了下面全会歪） */
{
  const d = E.DEFAULT_PARAMS;
  check('★0 默认参数与上游一致', d.spacing === 5.5 && d.mountainSpacing === 35 && d.mesh.seed === 12345
    && d.elevation.seed === 187 && d.elevation.island === 0.5 && d.elevation.mountain_sharpness === 9.8
    && d.biomes.rain_shadow === 0.5 && d.rivers.lg_min_flow === 2.7 && d.render.tilt_deg === 0,
    { spacing: d.spacing, meshSeed: d.mesh.seed, elevSeed: d.elevation.seed });
}

/* ★1 网格建得出来（规模对得上上游：spacing 5.5 ⇒ 约 2.5 万区域 / 5 万三角形） */
const base = run('灵框测试', 'continent', { landRatio: 0.34, ridges: 4, rivers: 1 });
{
  const m = base.eng.mesh;
  check('★1 网格规模', m.numSolidRegions > 20000 && m.numSolidTriangles > 40000
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

/* ★14 「看的方式」三档（第九十七轮）：它只是**一组渲染参数**（纯函数），与"生成什么地形"无关
   ⇒ 缺省/认不出的值都必须落回「立体」（= 上游原样），这是"不传就什么都不变"的保证。 */
{
  const r = E.styleRenderParams('relief');
  const c = E.styleRenderParams('contour');
  const f = E.styleRenderParams('flat');
  const unknown = E.styleRenderParams('不认识的东西');
  const none = E.styleRenderParams(undefined);
  const d = E.DEFAULT_PARAMS.render;
  const ok = E.TERRAIN_STYLES.length === 3
    && E.TERRAIN_STYLES.map((s) => s.id).join(',') === 'relief,contour,flat'
    && E.TERRAIN_STYLES.every((s) => s.label && s.hint)
    && d.shade === 1 && d.contour === 0 && d.contour_scale === 10 && d.bands === 0
    && r.shade === 1 && r.contour === 0 && r.bands === 0
    && c.shade > 0 && c.shade < 1 && c.contour === 1 && c.contour_scale > 1 && c.bands > 1
    && f.shade === 0 && f.contour === 0 && f.bands === 0
    && JSON.stringify(unknown) === JSON.stringify(r) && JSON.stringify(none) === JSON.stringify(r)
    && E.isTerrainStyle('contour') && !E.isTerrainStyle('x') && !E.isTerrainStyle(null)
    && E.terrainStyleOf('flat') === 'flat' && E.terrainStyleOf('乱写') === 'relief'
    && E.terrainStyleLabel('contour') === '等高线' && E.terrainStyleLabel(undefined) === '立体';
  check('★14 风格三档是一组渲染参数（缺省/认不出都落回立体）', ok,
    { relief: r, contour: c, flat: f, unknownFallsBack: JSON.stringify(unknown) === JSON.stringify(r) });
}

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
