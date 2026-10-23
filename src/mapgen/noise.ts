/** 地形细节噪声 —— 给「山很平、地块像一块块布」的地形补上**多尺度**起伏（第一百零四轮，第一百零六轮加强）。
 *
 *  用户 2026-10-21：「还有一件事，能不能用多重噪声增加复杂度」。
 *  用户 2026-10-23：「这个地图还是太简单了。山很少，而且看不出不同地形之间有什么区别」。
 *  上游地图的形貌来自**网格插值 + 泊松盘撒点**：点与点之间是平滑过渡，所以山体是"光滑的包"，
 *  平原是一整片均匀面 —— 缺的正是 self-similar 的细节。这里补三层叠加（都是确定性 value noise）：
 *    ① `detail`：4 octave 的 fBm，把大片坡面敲出中小尺度起伏（±halfAmp）；
 *    ② `ridge`：**山脊多重分形**（第一百零六轮加强）——`1 - |2n-1|` 再平方，并用上一层的强弱给
 *       下一层加权（`weight`）⇒ 脊线成串、支脉分叉，而不是一堆各向同性的鼓包；
 *    ③ 权重按高度做掩码：海平面附近权重 → 0（海岸线保持平滑，守卫 ★15~★17 管这条），
 *       越高越放开 ⇒ 平原不至于变成麻点，山脊却拿到最多细节。
 *
 *  ⭐ 第一百零六轮还加了**域扭曲**（domain warp）：采样前把坐标朝两个独立低频噪声推一下。
 *  这是"像不像自然地形"的分界 —— 没有它，fBm 的团块边界一眼就看得出是噪声。
 *
 *  ⚠️ 只动**高度场**（`elevation_t` / `elevation_r`），不动降雨 / 河流 / 海平面重排的那几步；
 *  调用点在 `runGeneration()` 里、`reseatSeaLevel()` 之前 ⇒ 陆地占比仍被精确钉在目标值上。
 *  确定性：全部是整数哈希 + 定点插值，同种子同参数 ⇒ 逐位相同（守卫 ★3 管这条）。 */

/** 32 位整数哈希 → [0,1)（与着色器里那套 hash21 一个路子，但用 Math.imul 保证跨平台一致） */
function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * (3 - 2 * t);

/** 2D 值噪声（双线性 + smoothstep 插值），返回 0..1 */
export function valueNoise2D(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = fade(x - ix), fy = fade(y - iy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** fBm：octave 层数递增、频率 ×2.03、幅度 ×0.5，归一化到 0..1 */
export function fbm2D(x: number, y: number, octaves: number, seed: number): number {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2D(x * freq, y * freq, seed + o * 1013);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/** 山脊噪声：`1 - |2·noise - 1|` —— 在噪声的中间值处取 1，形成连成串的脊线 */
export function ridgeNoise2D(x: number, y: number, octaves: number, seed: number): number {
  return 1 - Math.abs(2 * fbm2D(x, y, octaves, seed) - 1);
}

/** 山系带（第一百零六轮）：低频噪声的**零交叉带** —— 一条条细长的"链"。
 *
 *  为什么需要它：上游的高度场是"泊松盘山峰 + 值噪声丘陵"，形状天然是**圆包**；
 *  只往上叠各向同性的脊噪声，结果是一张长满同心年轮的图（topo 档一眼就看得出来）。
 *  真实山脉是**线状**的：山沿一条带抬升、支脉从主脊分叉。
 *  `1 - |n| / width` 在 n 过零处取 1 ⇒ 过零线是一条**细带**（不是闭合环），
 *  再平方把带宽收窄。频率很低（1/260）⇒ 全图三五条主山系。 */
export function rangeMask(x: number, y: number, seed: number, freq: number, width: number): number {
  const n = fbm2D(x * freq + 7.7, y * freq + 19.3, 2, seed) - 0.5;
  const band = 1 - Math.abs(n) / width;
  if (band <= 0) return 0;
  return band * band;
}

/** 山脊**多重分形**（第一百零六轮）：取**有符号**噪声的零交叉线当脊 ——
 *  `1 - |signed|` 在噪声过零处取 1，过零线是一条条**细长的线**（山脊是线，不是鼓包）；
 *  再平方让脊更细、并用上一层的强度给下一层加权 ⇒ 主脊上长出分叉支脉。
 *
 *  ⚠️ 不能写成 `1 - |2v - 1|`（v 为 0..1 的值噪声）：那个式子的峰值在 v = 0.5 的**等值线**上，
 *  而值噪声的 0.5 等值线是一圈圈绕极值点的**闭合环** ⇒ 整张地图长满"靶心年轮"
 *  （第一百零六轮第一版就是这个毛病，topo 档一眼看出同心圆）。
 *
 *  `weight` 的下限 0.15 是必要的：纯乘性加权会把没有脊的区域彻底饿死，
 *  山脚于是出现一块块"没有细节的死板坡"（试过 0）。 */
export function ridgedMultifractal2D(x: number, y: number, octaves: number, seed: number): number {
  let amp = 1, freq = 1, sum = 0, norm = 0, weight = 1;
  for (let o = 0; o < octaves; o++) {
    const s = 2 * valueNoise2D(x * freq + o * 71.3, y * freq - o * 37.9, seed + o * 1013) - 1;
    let n = 1 - Math.abs(s);
    n *= n;
    sum += n * amp * weight;
    norm += amp;
    weight = Math.min(1, Math.max(0.15, n * 1.6));
    amp *= 0.55;
    freq *= 2.11;
  }
  return sum / norm;   /* 0..1 */
}

export interface TerrainNoiseParams {
  /** 基础频率（世界坐标 0..1000 的倒数）：1/95 ⇒ 全图约 10 个大尺度起伏 */
  frequency: number;
  /** fBm 起伏幅度（高度场单位，陆地总高 0.85 的量级） */
  detailAmp: number;
  /** 山脊幅度（只在已抬高的地方生效） */
  ridgeAmp: number;
  /** fBm octave 数 */
  octaves: number;
  seed: number;
  /** 域扭曲幅度（已归一化到频率空间；0 = 关）*/
  warpAmp?: number;
  /** 山脊 octave 数（越多，主脊上的支脉越细碎）*/
  ridgeOctaves?: number;
  /** 山系带的抬升幅度（高度场单位；0 = 只有圆包，不出链状山系）*/
  chainAmp?: number;
  /** 山系带频率（1/世界坐标；越小，主山系越少越粗）*/
  chainFreq?: number;
  /** 山系带宽度（低频噪声的过零带半宽）*/
  chainWidth?: number;
}

/** 域扭曲：把采样点朝两个独立低频噪声推一下（同一套哈希、确定性）*/
function warpPoint(x: number, y: number, amp: number, seed: number): [number, number] {
  const wx = valueNoise2D(x * 0.9 + 17.3, y * 0.9 + 4.1, seed) - 0.5;
  const wy = valueNoise2D(x * 0.9 - 8.7, y * 0.9 + 31.9, (seed ^ 0x9e3779b9) | 0) - 0.5;
  return [x + wx * 2 * amp, y + wy * 2 * amp];
}

/** 高度场的一个采样点 → 细节偏移（世界坐标 x,y + 当前高度 e） */
export function terrainOffset(x: number, y: number, e: number, p: TerrainNoiseParams): number {
  /* 海平面附近不放细节：海岸线要保持平滑（守卫 ★15「海岸一样平滑」） */
  const coast = e <= 0 ? 0 : Math.min(1, e / 0.05);
  if (coast <= 0) return 0;
  /* 越高越碎：山脚（0.05）拿 35%，山腰以上（0.35）拿满 */
  const hi = e <= 0.05 ? 0 : Math.min(1, (e - 0.05) / 0.30);
  const weight = coast * (0.35 + 0.65 * hi);
  /* 采样前先扭曲（第一百零六轮）：团块边界因此不成"圆斑" */
  const [wx, wy] = warpPoint(x * p.frequency, y * p.frequency, p.warpAmp ?? 0.5, p.seed);
  const n = fbm2D(wx, wy, p.octaves, p.seed) - 0.5;
  const ridge = ridgedMultifractal2D(wx * 0.85 + 11.7, wy * 0.85 + 3.1, p.ridgeOctaves ?? 5, (p.seed ^ 0x5f5f5f5f) | 0) - 0.5;
  const base = (n * p.detailAmp + ridge * p.ridgeAmp * (0.30 + 0.70 * hi)) * weight;
  /* 山系带：沿低频噪声的过零线抬升，并在带上叠脊线细节 ⇒ 长条状山脉 + 分叉支脉 */
  const chainAmp = p.chainAmp ?? 0.20;
  if (chainAmp <= 0) return base;
  const chain = rangeMask(x, y, p.seed ^ 0x3c6ef372, p.chainFreq ?? 1 / 260, p.chainWidth ?? 0.055);
  if (chain <= 0) return base;
  const lift = chain * chainAmp * (0.45 + 0.55 * ridge) * weight;
  return base + lift;
}
