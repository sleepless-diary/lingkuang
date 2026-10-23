# 地图待办：从「看着像噪声」到「像真的」+ 星球性能

> 来源：2026-10-23 用户反馈「感觉边缘还是很平滑，是不是细节度不够的问题，而且性能开销好像有点大，
> 要不要讨论一下方案」。本轮只做了「快修」（见 `docs/ARCHITECTURE.md` 第一百零五轮），
> 下面这些是量过、但**这一轮没做**的项。按收益/成本排，动手前先回到本文件量一遍数字。

## 一、为什么「假」：先看诊断

用真实数据副本、真实内核渲染像素（钩 `WebGL2RenderingContext.drawElements`，在画到默认帧缓冲那一步
`readPixels` 取整张位图）看到的现状：

| 层 | 现状 | 数字 |
|---|---|---|
| 位图 → 屏幕 | 已从 2048 降到 1536 | 双窗格时屏幕 606px、放大到 1.66× 时 1502px |
| 海岸线 | `noisy_coastlines` + 网格分辨率共同决定波长下限 | 4.8 spacing ⇒ 屏幕上每个三角边约 7.5px |
| 山脊 / 谷地 | 单频 fBm + 坡面法线扰动，**没有结构** | 山看着是「贴着苔藓的团块」，不是山脉 |
| 像素细节 | 主要是 `u_detail` 法线 + 纸纹 | 放大像毛皮 / 苔藓，不像地形 |

结论：**细节的类型错了** —— 像素纹理多、结构特征少。单纯再加网格/再加噪声只会让它更"毛"。

## 二、B 档：结构级真实感（1~2 天）

1. **山脊用 ridged 噪声主导 + 域扭曲**（生成层，`src/mapgen/noise.ts` 已有 `ridgeNoise2D`）
   - 现状：`applyTerrainNoise()` 里 `ridgeAmp = 0.10`，主山体靠 `mountainSpacing` 的点集；
   - 目标：主脉（3~6 条）走 ridged fBm 的**零交叉线**，次级山脊按主脉法向偏移；
   - 代价：只改 `elevation_t`，生成耗时 +10~20ms。
2. **坡度侵蚀一次迭代**（谷地成网）
   - 做法：一次 `h -= k * |∇h|^2` 迭代（或简化的沟蚀），再把水汇到河网；
   - 收益：山坡出现沟线，山脊变锐；风险：侵蚀过度会让山"溶掉"，要拿 `map-stats.mjs` 盯高度分位。
3. **地表材质分层**（渲染层，零网格成本）
   - 现在整片陆地共用一层 `u_detail` 噪声；改成按 `材料 = f(坡度, 海拔, 湿度)` 混合：
     岩 / 草 / 沙 / 雪 + 岩层条带（沿等高线的横向纹理）；
   - 验据：`.review/png-hist.cjs` 数陆地颜色桶（现在自然档只有约 2~3 个主要色）。
4. **海岸分带**：浅滩 → 湿沙 → 浪线（现在只有一根深色描边 + 一条极细亮边）。

## 三、C 档：性能（1 天）

实测（真实数据副本）：

| 路径 | 现状 | 说明 |
|---|---|---|
| 星球首次（切形态 / 首次打开） | **2054ms 单次长任务** | `buildPlanetField` 1376ms + `renderPlanet` 480ms，1536×768 = 1.18M 像素 |
| 星球换「看的方式」 | 约 **700ms**/未缓存的档 | 只重新上色（`renderPlanet`），缓存后 4ms |
| 局部手刷每步 | 20.9ms 中位 | spacing 4.8 的代价（5.5 时 15.3ms） |
| 局部松手 | 64ms + 97ms（后者在空闲） | 已从 154ms 拆开 |

要做的事：

1. **星球场分帧或进 Worker**（收益最大）
   - 现在 `buildPlanetField()` 是纯同步的大循环（`src/mapgen/planet.ts:348` 起，行循环 + 后处理）。
   - 方案 A（推荐）：拆成 `planetFieldBegin / planetFieldRows(n) / planetFieldFinish`，
     主线程每帧算 ~12ms，配一个「正在算…」进度；输出必须**逐位一致**（拿改前/改后的
     `renderPlanet` 字节哈希对比）。
   - 方案 B：Web Worker（`new Worker(new URL('./planet-worker.ts', import.meta.url), {type:'module'})`），
     typed array 传回；`planetStats` 改成异步。
2. **上色也分帧**：`renderPlanet` 0.48s，按行切 8~16 片。
3. **FBO 按显示尺寸动态**：现在固定 1536；双窗格时屏幕只有 606px（等于 2.5× 降采样），
   放大到 2× 时又需要 1800。理想是 FBO = clamp(显示宽 × dpr, 768, 2048)，
   在 `Renderer` 构造时传尺寸（`resizeCanvas()` 已支持，FBO 需要跟着重建）。
4. **视图池化**：每个 `TerrainView` 占 4 张 FBO；工作室抽卡与预览目前复用单个 thumb 视图，
   如果以后要并行出图，注意别变成 N×47MB。

## 四、验证工具（都在 `.review/`）

- `mesh-density.mjs`：spacing / 海岸噪声的代价表；
- `planet-perf.mjs`：星球场 / 上色的分辨率-耗时曲线；
- `native-shot2.cjs [port] [outdir]`：真入口触发重画 + 钩 GL 抓原生像素 + long task；
- `png-crop.cjs`：原生像素裁剪（对照世界坐标同一块地）；
- `perf-planet.cjs`：切形态 / 换档的长任务；
- `window-shot.cjs`：不经任何 DOM 改动截一张地图栏。
