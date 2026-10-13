/** 球体预览：把星球的等距圆柱贴图贴到**一颗真球**上 —— 这就是"能放在真实球体上"的当场证明。
 *
 *  ⭐ 2026-10-16（第九十八轮，用户：「我们的算法不是能放在真实球体上的地图」→ 选 A）：
 *  自写一份最小 WebGL（不引三方渲染库）：UV 球面网格 + 球体贴图 + 一盏固定的光 + 拖动旋转/滚轮缩放。
 *  为什么贴上去一定是对的：星球图是**等距圆柱 2:1**（`src/mapgen/planet.ts` 的 `buildPlanetField`），
 *  uv 的 u 直接对应经度、v 对应纬度 ⇒ `wrapS = REPEAT` 时 ±180° 自然接上，
 *  两极收到球面的两个顶点。⚠️ 别用 `CLAMP_TO_EDGE`（接缝会露出来），也别把 uv 反过来（南北极会倒）。
 *
 *  ⚠️ 一块画布一个上下文：`dispose()` 里 `loseContext()` 之后那块画布**永久作废**
 *  （第九十三轮缩略图踩过：复用死画布会静默画出空白）⇒ 调用方换参数时要连画布一起换。 */

import { mat3, mat4 } from 'gl-matrix';
import type { PlanetField } from '../mapgen/planet';

export interface GlobeHandle { dispose: () => void }

const VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
attribute vec2 aUv;
uniform mat4 uMvp;
uniform mat3 uNrm;
varying vec3 vNrm;
varying vec2 vUv;
void main() {
  vNrm = uNrm * aNrm;
  vUv = aUv;
  gl_Position = uMvp * vec4(aPos, 1.0);
}`;

const FS = `
precision mediump float;
uniform sampler2D uTex;
uniform vec3 uLight;
varying vec3 vNrm;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb;
  vec3 n = normalize(vNrm);
  float lam = max(0.0, dot(n, normalize(uLight)));
  /* 光只做"这是颗球"的暗示：0.62 底光 + 0.5 漫反射，别把贴图本身的层次压掉 */
  gl_FragColor = vec4(c * (0.62 + 0.5 * lam), 1.0);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn('[globe] 着色器编译失败：', gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

/** 球面网格：经度 96 段、纬度 48 段。uv 的 u = 经度比例（0..1 对应 −180°..180°）、v = 1 − 纬度比例。 */
function sphereMesh(seg = 96, rings = 48) {
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const v = i / rings;
    const phi = v * Math.PI;                 /* 0 = 北极 */
    for (let j = 0; j <= seg; j++) {
      const u = j / seg;
      const theta = u * Math.PI * 2;
      const x = Math.sin(phi) * Math.cos(theta);
      const y = Math.cos(phi);
      const z = Math.sin(phi) * Math.sin(theta);
      pos.push(x, y, z); nrm.push(x, y, z);
      uv.push(u, 1 - v);                     /* ⚠️ v 要翻过来：图像第 0 行是北极 */
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j, b = a + seg + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv), idx: new Uint16Array(idx) };
}

/** 把一颗星球挂到画布上。返回句柄；失败（没 WebGL）时返回 `null`，调用方退化成只显示平面图。 */
export function mountGlobe(canvas: HTMLCanvasElement, field: PlanetField, rgba: Uint8ClampedArray): GlobeHandle | null {
  const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | null;
  if (!gl) return null;
  const vs = compile(gl, gl.VERTEX_SHADER, VS);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FS);
  const prog = vs && fs ? gl.createProgram() : null;
  if (!prog || !vs || !fs) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('[globe] 链接失败：', gl.getProgramInfoLog(prog));
    return null;
  }
  gl.useProgram(prog);

  const mesh = sphereMesh();
  const mkBuf = (data: Float32Array, loc: number, size: number) => {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    return b;
  };
  const aPos = gl.getAttribLocation(prog, 'aPos');
  const aNrm = gl.getAttribLocation(prog, 'aNrm');
  const aUv = gl.getAttribLocation(prog, 'aUv');
  const bPos = mkBuf(mesh.pos, aPos, 3);
  const bNrm = mkBuf(mesh.nrm, aNrm, 3);
  const bUv = mkBuf(mesh.uv, aUv, 2);
  const bIdx = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bIdx);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.idx, gl.STATIC_DRAW);

  /* 贴图：等距圆柱原图（w = 2h）。POT 尺寸 ⇒ 可以开 mipmap + REPEAT（WebGL1 也吃得下）。 */
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, field.w, field.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba.buffer));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);          /* ⭐ 经度必须环绕 */
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.generateMipmap(gl.TEXTURE_2D);

  const uMvp = gl.getUniformLocation(prog, 'uMvp');
  const uNrm = gl.getUniformLocation(prog, 'uNrm');
  const uLight = gl.getUniformLocation(prog, 'uLight');
  const uTex = gl.getUniformLocation(prog, 'uTex');
  gl.uniform3f(uLight, -0.45, 0.55, 0.7);
  gl.uniform1i(uTex, 0);

  let yaw = -0.6, pitch = 0.32, dist = 2.6;
  const proj = mat4.create(), view = mat4.create(), model = mat4.create(), mvp = mat4.create();
  const nrm3 = mat3.create();
  let disposed = false;

  const draw = () => {
    if (disposed) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.max(64, Math.round((canvas.clientWidth || 320) * dpr));
    const ch = Math.max(64, Math.round((canvas.clientHeight || 320) * dpr));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);              /* 两面都画：拖动看背面时不出洞 */
    mat4.perspective(proj, 0.7, cw / ch, 0.1, 50);
    mat4.lookAt(view, [0, 0, dist], [0, 0, 0], [0, 1, 0]);
    mat4.identity(model);
    mat4.rotateX(model, model, pitch);
    mat4.rotateY(model, model, yaw);
    mat4.multiply(mvp, view, model);
    mat4.multiply(mvp, proj, mvp);
    mat3.fromMat4(nrm3, model);          /* ⚠️ 用 model（纯旋转）而不是 mvp：投影矩阵会把法线带歪 */
    gl.uniformMatrix4fv(uMvp, false, mvp);
    gl.uniformMatrix3fv(uNrm, false, nrm3);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.drawElements(gl.TRIANGLES, mesh.idx.length, gl.UNSIGNED_SHORT, 0);
  };

  /* 拖动旋转 + 滚轮缩放（自己算，不依赖全局指针事件 —— 卸载时要摘干净） */
  let dragging = false, lastX = 0, lastY = 0;
  const onDown = (e: PointerEvent) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    /* ⚠️ `setPointerCapture` 对**合成事件**（e2e 里 dispatch 的 PointerEvent）会抛
       `NotFoundError`（没有真实活跃指针）⇒ 必须兜住：异常穿出监听器会被记成"未捕获错误"，
       拖动也白拖（`preventDefault` 没跑到）。 */
    try { canvas.setPointerCapture?.(e.pointerId); } catch { /* 合成事件：不需要捕获 */ }
    e.preventDefault();
  };
  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    yaw += (e.clientX - lastX) * 0.008;
    pitch = Math.max(-1.4, Math.min(1.4, pitch + (e.clientY - lastY) * 0.008));
    lastX = e.clientX; lastY = e.clientY;
    draw();
  };
  const onUp = (e: PointerEvent) => {
    dragging = false;
    try { canvas.releasePointerCapture?.(e.pointerId); } catch { /* 同上 */ }
  };
  const onWheel = (e: WheelEvent) => {
    dist = Math.max(1.35, Math.min(6, dist + Math.sign(e.deltaY) * 0.18));
    draw();
    e.preventDefault();
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  draw();
  return {
    dispose: () => {
      disposed = true;
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      gl.deleteTexture(tex);
      gl.deleteBuffer(bPos); gl.deleteBuffer(bNrm); gl.deleteBuffer(bUv); gl.deleteBuffer(bIdx);
      gl.deleteProgram(prog);
      gl.deleteShader(vs); gl.deleteShader(fs);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
