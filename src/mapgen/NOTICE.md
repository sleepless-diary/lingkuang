# 这里是什么

`src/mapgen/vendor/` 里的代码**不是灵框写的**，是从开源项目 **mapgen4** 搬进来的
（vendored），用来当地图生成的**内核**。灵框自己的适配层在上一级 `src/mapgen/index.ts`。

## 上游与许可证

| 上游 | 版本/来源 | 许可证 | 我们搬了哪些文件 |
|---|---|---|---|
| [mapgen4](https://github.com/redblobgames/mapgen4) | `main`（2026-03-29 最后推送） | **Apache-2.0**（Copyright 2017–2025 Red Blob Games <redblobgames@gmail.com>） | `map.ts` `geometry.ts` `colormap.ts` `render.ts` `painting.ts` `generate-points.ts` `types.d.ts` `LICENSE-mapgen4.txt` |
| [dual-mesh](https://github.com/redblobgames/dual-mesh) | 3.0.0（随 mapgen4 以 git-subrepo 同步） | **Apache-2.0** | `dual-mesh/index.ts` `dual-mesh/create.ts` `dual-mesh/LICENSE.txt` |
| [@redblobgames/prng](https://github.com/redblobgames/prng) | 1.0.0 | **Apache-2.0** | `prng.ts` 的前半（`makeRandInt` / `makeRandFloat`） |
| [hash-int](https://www.npmjs.com/package/hash-int) | 1.0.0（prng 的依赖） | **MIT**（Copyright 2013 Mikola Lysenko） | `prng.ts` 里的 `hashInt` |

完整许可证原文就在同目录：`LICENSE-mapgen4.txt`、`dual-mesh/LICENSE.txt`、`LICENSE-prng.txt`。

## 依赖（走 npm，装在本仓库的 devDependencies 里；渲染层由 vite 打进 app-dist）

`delaunator`(ISC) · `fast-2d-poisson-disk-sampling`(MIT) · `flatqueue`(ISC) · `gl-matrix`(MIT) · `simplex-noise`(MIT)

> `@redblobgames/dual-mesh` 与 `@redblobgames/prng` **都没有发布到 npm**（后者上游是拿 git URL 装的），
> 所以只能把源码搬进来 —— 见上表。

## ⚠️ 灵框改了什么（Apache-2.0 第 4 条要求「声明修改」）

搬进来时只做了**接线**改动，**没有改任何算法**（地形/降雨/河流的数学一字未改；渲染的
**明暗强度与等高线**在第九十七轮被做成了可调开关，见第 8 条 —— 缺省值仍是上游原样）：

1. **导入路径规范化**：去掉 `.ts` / `.d.ts` 后缀（`./geometry.ts` → `./geometry`、`./types.d.ts` → `./types`、
   `./dual-mesh/index.ts` → `./dual-mesh/index`），`@redblobgames/prng` → `./prng`（本目录的 vendored 版本）。
2. **`render.ts`：画布从参数来**。上游构造函数里现查 `document.getElementById('mapgen4')`、`resizeCanvas()`
   里再查一次；灵框要在沙盘地图栏与生成面板里各放一块画布 ⇒ 改成 `constructor(mesh, canvas?)`、
   `resizeCanvas()` 用 `this.canvas`。找不到画布、拿不到 WebGL2 / `EXT_color_buffer_float` 时
   由 `alert()` 改成 **throw**（灵框自己兜）。
3. **`render.ts`：能停下来**。上游的 `requestAnimationFrame` 循环一开就不再结束；新增
   `stopped` + `stopDrawingLoop()`，销毁时不再空转。
4. **`painting.ts`：DOM 解耦**。上游有 4 处**模块顶层**的 DOM 副作用（`#button-reset` 监听、快捷键、
   工具按钮、`setUpPaintEventHandling()`），且画布写死 `#mapgen4` —— 灵框一 import 就会抛。
   改为：逐个加存在性判断 + `setUpPaintEventHandling()` 找不到画布就跳过；
   **快捷键（1-4 / q w e r）与工具按钮整段收进 `setUpPaintKeys()`，默认不装**
   （上游是 import 就全局抢键 —— 在灵框里打字按到 w/e/r 会静默换笔刷，不能要）；
   并在文件末尾补具名导出 `paintTools` / `paintSizes` / `beginStroke()` / `paintAt()` /
   `resetPainting()` / `userHasPainted()`，好让灵框用自己的指针事件驱动同一套笔刷
   （笔刷算法仍走 `heightMap.paintAt`，一字未改）。
5. **`prng.js`（CommonJS，`require('hash-int')`）→ `prng.ts`（ESM）**：两个文件合成一个模块，
   函数体逐字保留（同种子逐位一致）。
6. **删掉了 3 个不用的上游文件**：`mesh.ts`（它的取点走浏览器相对 `fetch('build/points-*.data')`，
   灵框改用 `generate-points.ts` 的 `choosePoints()` 在运行时算）、`serialize-points.ts`、
   `config.js`（默认参数搬进了 `src/mapgen/index.ts` 的 `DEFAULT_PARAMS`，字段与上游
   `mapgen4.ts` 的 `initialParams` 一致）。
7. **`// @ts-nocheck`**：上游是「用 esbuild 打包、不做类型检查」（它自己的 `tsconfig.json` 里
   `"module": "bundler"` 其实是非法值，`tsc` 直接报 TS5110）。灵框的 `tsc --noEmit` 要留给我们自己的代码，
   所以在这批文件顶部加了 `// @ts-nocheck`（`tsconfig.json` 里也把 `src/mapgen/vendor` 排除了）。
   ⇒ **它们是"一个装配进来的第三方库"**：语法错会暴露，类型错不拦。
8. **`render.ts`：渲染风格三件套（第九十七轮灵框追加 —— 唯一一处动过着色器的地方）**。
   起因：用户问「这个山怎么是立体的，不应该是等高线那一种的吗」⇒ 做成「立体 / 等高线 / 平面」开关。
   新增 4 个 uniform（`drawDrape()` 里给值，缺省即上游原样）：
   · `u_shade` —— 最后一步由 `* light` 改成 `* mix(1.0, light, u_shade)`（0 = 完全平面，1 = 上游原样）；
   · `u_contour` + `u_contour_scale` —— 等高线。**上游本来就写了这一行、只是注释着**
     （`// if (fract(z * 10.0) < 10.0 * fwidth(z)) { biome_color = vec3(0,0,0); } // contour lines`），
     这里放开并改成：每 `1/u_contour_scale` 一条、按 `fwidth` 归一成约 1.5 像素（缩放不变粗）、
     **只画陆地**（这个尺度下海里的等深线只会糊成一片）；
   · `u_bands` —— 分层设色：把"取色用的高度"量化成 N 档（档内留 0.35 渐变，免得平得像色卡）。
   另加一行 `float z0 = z;`（在河流压低 `z` 之前留一份原始高度）：等高线用 `z0`，
   否则河的浅槽两边会长出一圈假等高线。**地形/降雨/河流的数学仍然一字未改。**

9. **`render.ts`：八档风格 + 真实感着色（第一百零三轮灵框追加）**。
   用户 2026-10-20：「我们的地图生成系统还是很假，而且不像真实地图，显示风格也很少而且不好看」
   ⇒ 三档扩成八档（自然 / 地形图 / 羊皮纸 / 水墨 / 蓝图 / 梦核 / 卫星 / 极简），
   并把上游自己在 `frag_drape` 里留的那行 `// TODO: add noise texture based on biome` 补上。
   新增 uniform（**缺省值全是"上游原样"**，`u_grade = 0` 时下面整段是死代码）：
   · `u_grade` + `u_land_ramp[8]` + `u_sea_ramp[6]` + `u_line_color` + `u_river_color`
     —— 用**等距色带**取代"高程 × 湿度"的 colormap 取色（色带的唯一来源是
     `src/mapgen/styles.ts`；改色只改那边，别在这一层写第二份表）；
   · `u_detail` —— 程序化值噪声（hash + 3 octave fbm）扰动法线：山不是"光滑的灰团"；
   · `u_coast` —— 陆地一侧湿沙 + 水线一道极细亮边（浪花）；
   · `u_water_noise` —— 海面细纹；`u_hatch` —— 按坡向排线（水墨/羊皮纸）；
   · `u_paper` / `u_grain` / `u_vignette` —— 屏幕空间的纸纹 / 颗粒 / 暗角；
   · `u_moist` —— 湿度偏色权重（湿偏绿、干偏暖）。
   ⚠️ 数组 uniform 的 location 名带 `[0]`（`getActiveUniform` 就这么报）⇒
   `drawDrape()` 里走 `uniformLoc()` 兜一层，直接写 `program.u_land_ramp` 会拿到 undefined。
   **地形/降雨/河流的数学仍然一字未改**（只动"怎么看"）。

10. **地形复杂度 + 生物群系 + 立体度开关（第一百零四轮灵框追加）**。
    用户 2026-10-21：「这个地图还是太简单了。山很少，而且看不出不同地形之间有什么区别，
    只能看出山脉和平原两种地形」+「还有一件事，能不能用多重噪声增加复杂度」+「山好像有顶部边缘，
    能不能做成开关，一种是顶视图，一种是现在这种有一点立体感的」。
    · **新文件 `src/mapgen/noise.ts`（不是上游文件）**：32 位整数哈希 → 2D 值噪声 → 4 octave fBm，
      另有 `1 - |2fbm-1|` 山脊噪声；全部确定性（`Math.imul`，跨平台逐位一致）。
    · **`index.ts`**（生成层，改的都是灵框自己的参数/步骤，上游数学没动）：
      - `DEFAULT_PARAMS.elevation.hill_height` 0.02 → 0.07、`elevation.mountain_folds` 0.05 → 0.18
        （folds 只进 `geometry.ts` 的**渲染**高度，不改 `elevation_t` 统计）；
      - `biomes.raininess` 0.9 → 0.55、`rain_shadow` 0.5 → 0.7（上游降雨挤在 0.47..0.94、
        一半以上 > 0.8 ⇒ 整张图一个气候，生物群系只能上一种绿）；
      - `render.mountain_height` 50 → 72、`slope` 2 → 2.6（小尺寸缩略图里山要看得见）；
      - `paramsFromSeed()`：`mountainSpacing = round(50 - ridges*5)`（ridge 4 → 30，上游 35）、
        `hill_height = 0.05 + ridges*0.0055`；
      - **新步骤 `applyTerrainNoise()`**（`assignElevation` 之后、`reseatSeaLevel` 之前）：
        按高度加权叠 fBm + 山脊噪声（海平面附近权重 0 ⇒ 海岸线仍平滑；山脚 35%、山腰以上满幅）；
      - **新步骤 `normalizeRainfall()`**（`assignRivers` 之后）：陆地降雨换成**分位数排名** 0..1
        （`0.7*rank + 0.3*line`），着色器的湿度轴才能铺满四个湿度档；
      - 重定海平面 / 河流 / 降雨的**数学一字未改**（只是多了两个后处理步骤）。
    · **`render.ts`**：`frag_drape` 新增 `uniform sampler2D u_biome` + `uniform float u_biome_amt`。
      气候表是 **4×3 纹理**（x = 湿度、y = 温度，`styles.ts` 的 `climateFloats()` 生成，线性过滤），
      `drawDrape()` 里 48 字节 `texSubImage2D` 按 `biomeKey` 比对后重传（换风格不重建纹理）。
      温度 = 世界 y 的纬度（乘 3.8 让可见横带上下缘正好落到寒带）+ 海拔递减；湿度 = `v_em.y`
      （归一化降雨，再向两端拉 1.35 倍）。低地按气候上色、`landT > 0.42` 起渐回高程色带（岩/雪）、
      陡坡再压一层岩色。采样点取**纹素中心**（`0.125 + m*0.75` / `0.1667 + t*0.6667`）。
    · **立体度开关**（顶视 / 立体）落在 `MapTerrainSpec.lift`（`solid` 缺省 / `flat`），
      映射为 `mountain_height = 0`（顶视）——纯渲染参数，不重算地形；由 `src/ui/map-terrain.ts`
      的 `terrainRenderParams()` 合进 `setStyle()`。

## 怎么用

只看 `src/mapgen/index.ts`（`createEngine` / `runGeneration` / `statsOf` / `TerrainView`）。
不要在业务代码里直接 import `vendor/` 里的东西。

11. **`render.ts` 的位图尺寸 2048 → 1536（第一百零五轮灵框追加）**。
    用户 2026-10-23：「感觉边缘还是很平滑……性能开销好像有点大」。量下来地图栏把这张位图
    缩到地图格子再按 `viewScale`（≤2）铺到屏幕，实测屏幕宽 **606px（双窗格）/ 1502px（占满）**
    ⇒ 2048 在常用放大档是 **1.36× 双线性降采样**：既不加可见细节、又把海岸/山脊的锐边磨软，
    还多付 44% 显存与填充率（4 张 FBO，约 20 B/px ⇒ 84MB → 47MB）。
    改：`const fbo_texture_size = 1536`；`resizeCanvas()` 里写死的 2048 改用这个常量
    （上游注释本来就是 "could be smaller to increase performance"）。
    ⚠️ 同步改的地方：`src/ui/map-terrain.ts` 的 `TERRAIN_BITMAP`（`bandLayout()` 是**按比例**
    算的，CSS 尺寸不变）、`tools/e2e/map-gen.cjs` ★3 的断言、`src/mapgen/index.ts` 与
    `src/ui/map.ts` 里描述位图尺寸的注释。**地形数学一字未改**。

12. **`render.ts`：地表材质分层 + 浅滩带 + 位图边长参数化（第一百零六轮灵框追加）**。
    - `frag_drape` 新增 4 个 uniform：`u_rock`（高处/陡坡露岩）、`u_strata`（岩层条带）、
      `u_snow`（雪线）、`u_shelf`（水侧浅滩带）。缺省全是 0 ⇒ 不设风格的调用方（离线脚本、
      没传 `grade` 的旧路径）拿到的仍是逐字旧结果。
    - 陡度**必须用宽基线**（±6 纹素）求：1 纹素差分把细节噪声也当坡度，整块陆地会糊成岩色
      （第一版真机就是这样）；`macro = length(vec2(mE-mW, mS-mN)) / 12.0`。
    - 海岸带从"一条湿沙 + 一道浪花"扩成**四段**：干沙（0.020 宽）→ 湿沙（0.007）→ 浪线（0.0025）
      → 水侧浅滩线；配合 `u_shelf` 的深浅色带，岸线不再是"贴纸边缘"。
    - 位图边长：`const fbo_texture_size = 1536` 仍是**缺省值**，但 `Renderer(mesh, canvas, textureSize?)`
      与 `TerrainView(canvas, engine, textureSize?)` 现在接第三参数（`texture_size` 字段），
      4 张 FBO、截图画布、`drawFinal` 的纹素偏移全用它。灵框侧：地图栏 1536、
      缩略图/抽卡 768（`src/ui/map-terrain.ts` 的 `THUMB_BITMAP`，`bandSource(size)` 跟着参数化）。
    ⚠️ 光栅化尺寸一变，`bandSource()` 的源矩形必须同步（否则 `drawImage` 会从错的位置裁一条带）。

13. **`render.ts`：海岸描边改成"到海岸线的距离带" + 山体描边只在陆地画（第一百零七轮灵框追加）**。
    用户 2026-10-23：「陆地边缘还是看起来太顺滑了」。海岸在 `src/mapgen/index.ts` 的
    `addCoastDetail()` 里被真正打碎之后，上游那条描边判据暴露了它的性质问题：
    - 旧写法：`if (z <= 0.5 && max(depth1, depth2) > 1.0/256.0 && neighboring_river <= 0.2)
      outline += u_outline_coast * 256.0 * (max(depth1, depth2) - 2.0*(z - 0.5));`
      它量的是 **`u_depth` 的几何台阶**（相邻像素的深度差），与"离海岸线多远"无关 ⇒ 岸坡一陡
      就整片变黑（海岸平滑时表现为"1px 贴纸边上的黑点"，碎开之后是一圈黑渣）。
    - 新写法：`coastLine = 1.0 - smoothstep(0.55, 1.85, |z0 - 0.5| / fwidth(z0))`，
      再乘 `1.0 - smoothstep(0.15, 0.45, neighboring_river)`（河口不留硬边），
      `outline += u_outline_coast * 1.5 * coastLine`。**约 1.5 像素宽、缩放不变粗**，
      与 `u_contour` 同一套 `fwidth` 归一写法。
    - 同时把山体描边夹上限、只在陆地画：
      `reliefAmt = min(max(u_outline_threshold, depth1 - depth0) - u_outline_threshold, 0.12)
       * smoothstep(0.495, 0.545, z0)`，`outline = 1.0 + u_outline_strength * reliefAmt` ——
      海岸线交给上面那条距离带，陡崖不再"一整片死黑"。
    ⚠️ **这个文件的着色器是 TS 模板字符串：注释里绝对不能出现反引号**（本轮在注释里写了
    `` `u_depth` ``，`tsc` 一片 TS1005、`vite build` 失败但旧 `app-dist` 照跑 ⇒ 看起来"改了没用"）。

14. **`render.ts`：等高线抽稀 `u_contour_every` + 位图上限 4096（第一百零八轮灵框追加）**。
    用户 2026-10-24：「有些地方因为地形陡峭导致等高线有点密集，能不能加一个等高线绘制方式，
    是全部显示还是省略部分」。
    - `frag_drape` 新增 `uniform float u_contour_every`：0 = 自动、n>1 = 每 n 条画一条。
      自动档用 `spacingPx = cInterval / fwidth(zLand)` 现算（线距 < 10px 就按整数倍跳线），
      跳线按**档号取模**（`mod(floor(zLand / cInterval + 0.5), every)`），不会出现半条线；
      每 5 条一条主等高线（`cMajor`）仍加深。缺省 0（= 老调用方的行为仍由 `u_contour` 决定）。
    - `drawDrape()` 里 `gl.uniform1f(program.u_contour_every, renderParam.contour_every ?? 0)`。
    - `Renderer` 的 `texture_size` 上限 2048 → **4096**（全窗口高清图要 3072²；
      否则被静默夹回 2048，看起来"高清没生效"）。
    ⚠️ 这个文件的着色器是 TS 模板字符串：注释里不能出现反引号（`tsc` 会一片 TS1005）。

15. **`render.ts`：等高线自动档从「跳线」改「淡出」（第一百一十轮灵框追加）**。
    用户 2026-10-24：「小图情况下出现了一条非常突兀的尖角，像是等高线出问题了」。
    - 旧自动档（第一百零八轮）按 `spacingPx = cInterval / fwidth(zLand)` 取整数倍跳线，
      倍数随像素跳变 ⇒ **同一条等高线一会儿画一会儿不画**，小图上是一片虚线。
    - 现在：`autoAlpha = clamp((spacingPx - 2.0) / 5.0, 0.18, 1.0)` —— 平地（线距 ≥7 位图像素）满强度、
      陡坡线性淡出到 18%，**不再跳线**（所以不会断）。`u_contour_every` 仍只管手选三档
      （全部 = 1 / 每 2 条 / 每 5 条，按档号取模跳线），`cMajor` 计曲线照旧加深。
    - `src/mapgen/planet.ts` 的 `renderPlanetGen` 用同一套三档常量（`CONTOUR_FADE_MIN_PX=2 /
      FULL=7 / FLOOR=0.18`），两处注释互相指了；改一处要同步另一处。
