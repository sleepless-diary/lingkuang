// @ts-nocheck
/*
 * 从 mapgen4 的依赖里搬进来的伪随机数（vendored）：
 *   · `@redblobgames/prng` 1.0.0 —— Copyright 2017 Red Blob Games <redblobgames@gmail.com>
 *     License: Apache v2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 *   · 它内部依赖的 `hash-int` 1.0.0 —— Copyright 2013 Mikola Lysenko，MIT
 *
 * ⚠️ 灵框改动（见 `src/mapgen/NOTICE.md`）：上游 prng 是 CommonJS（`exports.` + `require('hash-int')`），
 *    而 `@redblobgames/prng` 与 `hash-int` **都没有发到 npm**（前者靠 package.json 里的 git URL 装）
 *    ⇒ 不能 `npm i`。这里把两个文件合成一个 ESM 模块，顺手去掉 `module.exports`/`require`，
 *    算法逐字保留（同种子逐位一致，和上游出的图相同）。
 */

/** hash-int 1.0.0（MIT，Mikola Lysenko）—— 原样搬过来，只把 `module.exports` 去掉 */
const A = new Uint32Array(1);

function hashInt(x: number): number {
    A[0] = x | 0;
    A[0] -= (A[0] << 6);
    A[0] ^= (A[0] >>> 17);
    A[0] -= (A[0] << 9);
    A[0] ^= (A[0] << 4);
    A[0] -= (A[0] << 3);
    A[0] ^= (A[0] << 10);
    A[0] ^= (A[0] >>> 15);
    return A[0];
}

/** @redblobgames/prng 1.0.0 —— `makeRandInt(seed)` 逐字保留 */
export function makeRandInt(seed: number): (N: number) => number {
    let i = 0;
    return function (N: number): number {
        i++;
        return hashInt(seed + i) % N;
    };
}

/** @redblobgames/prng 1.0.0 —— `makeRandFloat(seed)` 逐字保留（0..1） */
export function makeRandFloat(seed: number): () => number {
    const randInt = makeRandInt(seed);
    const divisor = 0x10000000;
    return function (): number {
        return randInt(divisor) / divisor;
    };
}
