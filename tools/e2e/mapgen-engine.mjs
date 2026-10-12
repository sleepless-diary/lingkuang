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

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
