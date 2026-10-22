/** 地形细节噪声 —— 给「山很平、地块像一块块布」的地形补上**多尺度**起伏（第一百零四轮）。
 *
 *  用户 2026-10-21：「还有一件事，能不能用多重噪声增加复杂度」。
 *  上游地图的形貌来自**网格插值 + 泊松盘撒点**：点与点之间是平滑过渡，所以山体是"光滑的包"，
 *  平原是一整片均匀面 —— 缺的正是 self-similar 的细节。这里补三层叠加（都是确定性 value noise）：
 *    ① `detail`：4 octave 的 fBm，把大片坡面敲出中小尺度起伏（±halfAmp）；
 *    ② `ridge`：`1 - |2·fBm - 1|` 山脊噪声，在**已有高地**上叠出成串的小脊与支脉
 *       （真实山脉的支脉本来就是这种"脊状、分叉"的形态，而不是一堆鼓包）；
 *    ③ 权重按高度做掩码：海平面附近权重 → 0（海岸线保持平滑，守卫 ★15~★17 管这条），
 *       越高越放开 ⇒ 平原不至于变成麻点，山脊却拿到最多细节。
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
}

/** 高度场的一个采样点 → 细节偏移（世界坐标 x,y + 当前高度 e） */
export function terrainOffset(x: number, y: number, e: number, p: TerrainNoiseParams): number {
  /* 海平面附近不放细节：海岸线要保持平滑（守卫 ★15「海岸一样平滑」） */
  const coast = e <= 0 ? 0 : Math.min(1, e / 0.05);
  if (coast <= 0) return 0;
  /* 越高越碎：山脚（0.05）拿 35%，山腰以上（0.35）拿满 */
  const hi = e <= 0.05 ? 0 : Math.min(1, (e - 0.05) / 0.30);
  const weight = coast * (0.35 + 0.65 * hi);
  const n = fbm2D(x * p.frequency, y * p.frequency, p.octaves, p.seed) - 0.5;
  const ridge = ridgeNoise2D(x * p.frequency * 0.62 + 11.7, y * p.frequency * 0.62 + 3.1, 3, (p.seed ^ 0x5f5f5f5f) | 0);
  return (n * p.detailAmp + (ridge - 0.5) * p.ridgeAmp * (0.35 + 0.65 * hi)) * weight;
}
