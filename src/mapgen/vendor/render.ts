// @ts-nocheck
/*
 * From https://www.redblobgames.com/maps/mapgen4/
 * Copyright 2018, 2025 Red Blob Games <redblobgames@gmail.com>
 * @license Apache-2.0 <https://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * This module uses webgl to render the generated maps
 */

import {vec2, vec4, mat4} from 'gl-matrix';
import colormap from "./colormap";
import Geometry from "./geometry";
import type {Mesh} from "./types";

//////////////////////////////////////////////////////////////////////
// WebGL wrappers

type Buffer = {
    bind(): void;
    vertexAttribPointer(index: GLuint, size: GLint, type: GLenum, normalized: GLboolean, stride: GLsizei, offset: GLintptr): void;
    subdata(offset: number, data: AllowSharedBufferSource): void;
}

type Program = {
    run(body: () => void): void;
    [name: `a_${string}`]: GLint;
    [name: `u_${string}`]: WebGLUniformLocation;
}

type Texture = {
    id: WebGLTexture;
    width: number;
    height: number;
    bind(): void;
    activate(register: GLint, uniform: WebGLUniformLocation): void;
}

type Framebuffer = {
    id: WebGLFramebuffer;
    texture: Texture | null;
    depth: boolean;
    bind(): void;
    viewport(): void;
    clear(r: number, g: number, b: number, a: number): void;
}

class WebGLWrapper {
    gl: WebGL2RenderingContext;

    constructor (canvas: HTMLCanvasElement) {
        this.gl = canvas.getContext('webgl2') as WebGL2RenderingContext;
        if (!this.gl) { throw new Error("mapgen4: 这块画布拿不到 WebGL 2"); }
        canvas.addEventListener('webglcontextlost', () => console.error("This project not handle WebGL context loss"));
        const ext_color_buffer_float = this.gl.getExtension('EXT_color_buffer_float'); // 99.93% support
        if (!ext_color_buffer_float) { throw new Error("mapgen4: 这块画布没有 WebGL2 EXT_color_buffer_float"); }
    }

    createBuffer(options: {indices?: boolean, update: 'static' | 'dynamic', data: AllowSharedBufferSource}): Buffer {
        const {gl} = this;
        const target = options.indices ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER;
        const buffer = gl.createBuffer();
        gl.bindBuffer(target, buffer);
        gl.bufferData(target, options.data, options.update === 'static'? gl.STATIC_DRAW : gl.DYNAMIC_DRAW);
        return {
            bind() {
                gl.bindBuffer(target, buffer);
            },
            vertexAttribPointer(index, size, type, normalized, stride, offset) {
                this.bind();
                gl.enableVertexAttribArray(index);
                gl.vertexAttribPointer(index, size, type, normalized, stride, offset);
            },
            subdata(offset: number, data: AllowSharedBufferSource) {
                this.bind();
                gl.bufferSubData(target, offset, data);
            },
        };
    }

    createTexture(options: {width?: number, height?: number, mipmap?: boolean, image?: HTMLCanvasElement, data?: Uint8Array, internalFormat?: GLenum, format?: GLenum, filter: 'linear'|'nearest'}): Texture {
        const {gl} = this;
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);

        if (options.image) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, options.image);
        } else if (options.width && options.height) {
            gl.texStorage2D(gl.TEXTURE_2D, 1, options.internalFormat ?? gl.RGBA8, options.width, options.height);
            if (options.data) {
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, options.width, options.height, options.format ?? gl.RGBA, gl.UNSIGNED_BYTE, options.data);
            }
        } else {
            throw "createTexture needs either an image or a width✕height";
        }

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, options.filter === 'linear'? gl.LINEAR : gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, options.filter === 'linear'? gl.LINEAR : gl.NEAREST);
        if (options.mipmap) {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, options.filter === 'linear'? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST);
            gl.generateMipmap(gl.TEXTURE_2D);
        }

        gl.bindTexture(gl.TEXTURE_2D, null);
        return {
            id: texture,
            width: options.width ?? options.image.width,
            height: options.height ?? options.image.height,
            bind() {
                gl.bindTexture(gl.TEXTURE_2D, texture);
            },
            activate(register: GLint, uniform: WebGLUniformLocation) {
                if (register < gl.TEXTURE0 || register >= gl.TEXTURE7) throw "invalid texture register";
                gl.uniform1i(uniform, register - gl.TEXTURE0);
                gl.activeTexture(register);
                this.bind();
            }
        };
    }

    _createFramebufferWrapper(framebuffer: WebGLFramebuffer | null, texture: Texture | null, depth: boolean): Framebuffer {
        const {gl} = this;
        return {
            id: framebuffer,
            texture,
            depth,
            bind() {
                gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
            },
            viewport() {
                this.bind();
                const image = this.texture ?? gl.canvas;
                gl.viewport(0, 0, image.width, image.height);
            },
            clear(r, g, b, a) {
                this.bind();
                gl.clearColor(r, g, b, a);
                gl.clear(gl.COLOR_BUFFER_BIT | (this.depth? gl.DEPTH_BUFFER_BIT : 0));
            },
        };
    }

    drawToScreen(): Framebuffer {
        return this._createFramebufferWrapper(null, null, true);
    }

    createFramebuffer(width: number, height: number, options: {depth?: boolean, internalFormat?: GLenum, format?: GLenum, filter: 'linear'|'nearest'}): Framebuffer {
        const {gl} = this;
        const texture = this.createTexture({width, height, internalFormat: options.internalFormat, format: options.format, filter: options.filter});
        const framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture.id, 0);

        if (options.depth) {
            const depthBuffer = gl.createRenderbuffer();
            gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, texture.width, texture.height);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer);
        }

        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            console.error("Framebuffer is not complete:", status.toString(16));
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return this._createFramebufferWrapper(framebuffer, texture, options.depth ?? false);
    }

    createProgram(name: string, vert: string, frag: string, setup: (gl: WebGL2RenderingContext, program: Program) => void): Program {
        const {gl} = this;

        function createShader(type, source): WebGLShader {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, "#version 300 es\n" + source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                console.error(`Error compiling shader for program ${name}`);
                console.error(gl.getShaderInfoLog(shader));
            }
            return shader;
        }

        const vs = createShader(gl.VERTEX_SHADER, vert);
        const fs = createShader(gl.FRAGMENT_SHADER, frag);
        const pr = gl.createProgram();
        gl.attachShader(pr, vs);
        gl.attachShader(pr, fs);
        gl.linkProgram(pr);

        if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) {
            console.error(`Error linking shaders for program ${name}`);
            console.error(gl.getProgramInfoLog(pr));
        }

        gl.validateProgram(pr);
        if (!gl.getProgramParameter(pr, gl.VALIDATE_STATUS)) {
            console.warn(`Warning while validating shaders for program ${name}`);
            console.warn(gl.getProgramInfoLog(pr));
        }

        gl.deleteShader(vs);
        gl.deleteShader(fs);

        const vao = gl.createVertexArray();

        let program: Program = {
            run(body) {
                gl.bindVertexArray(vao);
                gl.useProgram(pr);
                body();
                gl.bindVertexArray(null);
            },
        };

        for (let i = 0; i < gl.getProgramParameter(pr, gl.ACTIVE_ATTRIBUTES); i++) {
            let name = gl.getActiveAttrib(pr, i).name;
            program[name] = gl.getAttribLocation(pr, name);
        }
        for (let i = 0; i < gl.getProgramParameter(pr, gl.ACTIVE_UNIFORMS); i++) {
            let name = gl.getActiveUniform(pr, i).name;
            program[name] = gl.getUniformLocation(pr, name);
        }

        gl.bindVertexArray(vao);
        setup(gl, program);
        gl.bindVertexArray(null);

        return program;
    }
}


//////////////////////////////////////////////////////////////////////
// Shaders

const vert_river = `
    precision highp float;
    uniform mat4 u_projection;
    in vec4 a_xyww; // x, y, width1, width2 (widths are constant across vertices)
    out vec2 v_riverwidth;
    out vec3 v_barycentric;
    void main() {
        v_riverwidth = a_xyww.ba;
        int index = gl_VertexID % 3;
        v_barycentric = vec3(index == 0, index == 1, index == 2);
        gl_Position = u_projection * vec4(a_xyww.xy, 0, 1);
    }`;

const frag_river = `
    precision mediump float;
    in vec2 v_riverwidth;
    in vec3 v_barycentric;
    out vec4 out_fragcolor;
    const vec3 blue = vec3(0.2, 0.5, 0.7);
    void main() {
        float xt = v_barycentric.r / (v_barycentric.b + v_barycentric.r);
        float dist = sqrt(v_barycentric.b*v_barycentric.b + v_barycentric.r*v_barycentric.r + v_barycentric.b*v_barycentric.r);
        float pos = 0.5;
        float width = 0.35 * mix(v_riverwidth.x, v_riverwidth.y, xt); // variable width from r side to b side
        // NOTE: I've tried using screen space derivatives to make widths consistent between adjacent triangles,
        // but it ended up looking worse, so I reverted it. I multiplied the width by 2.0 * fwidth(v_barycentric.g)
        // and removed the divide by / s_length[s] in setRiverGeometry().
        // NOTE: the smoothstep is from w + minwidth to w - antialias thickness, but antialias thickness should
        // be calculated based on the matrix transform because we want it to be roughly 1 pixel; the min width should
        // probably also be 1 pixel
        float in_river = smoothstep(width + 0.025, max(0.0, width - 0.05), abs(dist - pos));
        vec4 river_color = in_river * vec4(blue, 1);
        // HACK: for debugging - if (min(v_barycentric.r, min(v_barycentric.g, v_barycentric.b)) < 0.05) river_color = vec4(0, 0, 0, 1);
        out_fragcolor = river_color;
    }`;

const vert_land = `
    precision highp float;
    uniform mat4 u_projection;
    in vec2 a_xy;
    in vec2 a_em; // NOTE: moisture channel unused
    out float v_e;
    out vec2 v_xy;
    void main() {
        vec4 pos = u_projection * vec4(a_xy, 0, 1);
        v_xy = (1.0 + pos.xy) * 0.5;
        v_e = a_em.x;
        gl_Position = pos;
    }`;

 const frag_land = `
    precision highp float;
    uniform sampler2D u_water;
    uniform float u_outline_water;
    in float v_e;
    in vec2 v_xy;
    out vec4 out_elevation;
    void main() {
        float e = 0.5 * (1.0 + v_e);
        float river = texture(u_water, v_xy).a;
        if (e >= 0.5) {
            float bump = u_outline_water / 256.0;
            float L1 = e + bump;
            float L2 = (e - 0.5) * (bump * 100.0) + 0.5;
            // TODO: simplify equation
            e = min(L1, mix(L1, L2, river));
        }
        out_elevation = vec4(e, 0, 0, 1);
    }`;

const vert_depth = `
    precision highp float;
    uniform mat4 u_projection;
    in vec2 a_xy;
    in vec2 a_em;
    out float v_z;
    void main() {
        vec4 pos = u_projection * vec4(a_xy, max(0.0, a_em.x), 1);
        v_z = a_em.x;
        gl_Position = pos;
    }`;

const frag_depth = `
    precision highp float;
    in float v_z;
    out vec4 out_depth;
    void main() {
        out_depth = vec4(v_z, 0, 0, 1);
    }`;

const vert_drape = `
    precision highp float;
    uniform mat4 u_projection;
    in vec2 a_xy;
    in vec2 a_em;
    out vec2 v_em, v_uv, v_xy;
    out float v_z;
    void main() {
        v_em = a_em;
        vec2 xy_clamped = clamp(a_xy, vec2(0, 0), vec2(1000, 1000));
        v_z = max(0.0, a_em.x); // oceans with e<0 still rendered at z=0
        if (xy_clamped != a_xy) { // boundary points
            v_z = -0.5;
            v_em = vec2(0.0, 0.0);
        }
        vec4 pos = vec4(u_projection * vec4(xy_clamped, v_z, 1));
        v_uv = a_xy / 1000.0;
        v_xy = (1.0 + pos.xy) * 0.5;
        gl_Position = pos;
    }`;

const frag_drape = `
    precision highp float;
    uniform sampler2D u_colormap;
    uniform sampler2D u_elevation;
    uniform sampler2D u_water;
    uniform sampler2D u_depth;
    uniform vec2 u_light_angle, u_inverse_texture_size;
    uniform float u_slope, u_flat,
                  u_ambient, u_overhead,
                  u_outline_strength, u_outline_coast, u_outline_water,
                  u_outline_depth, u_outline_threshold,
                  u_biome_colors,
                  /* ⭐ 灵框追加（第九十七轮）：渲染风格三件套 —— 见 NOTICE.md */
                  u_shade, u_contour, u_contour_scale, u_bands,
                  /* ⭐ 灵框追加（第一百零三轮）：真实感旋钮 —— 见 NOTICE.md */
                  u_grade, u_detail, u_coast, u_water_noise, u_hatch, u_paper, u_grain, u_vignette, u_moist;
    /* ⭐ 灵框追加（第一百零三轮）：风格色带（陆地 8 个等距采样点、海 6 个；JS 侧 「styles.ts」 生成） */
    uniform vec3 u_land_ramp[8];
    uniform vec3 u_sea_ramp[6];
    uniform vec3 u_line_color, u_river_color;
    in vec2 v_uv, v_xy, v_em;
    in float v_z;
    out vec4 out_fragcolor;

    const vec3 neutral_land_biome = vec3(0.9, 0.8, 0.7);
    const vec3 neutral_water_biome = 0.8 * neutral_land_biome;

    /* ⭐ 灵框追加（第九十七轮）：给"画线/上色带"用的**平滑**高度（五抽头盒滤，±12 个纹素）。
       内核的高度场是网格插值来的、逐格带细尺度噪声 ⇒ 直接拿它画等高线会抖成锯齿。
       只在真的要用（等高线 / 分层设色）时调它 —— 默认档（立体）一次都不多采。 */
    float smoothLandHeight(sampler2D tex, vec2 pos, vec2 inv, float z0) {
        vec2 zs = inv * 4.0;
        return 0.2 * (z0
            + texture(tex, pos + vec2(zs.x, 0.0)).x
            + texture(tex, pos - vec2(zs.x, 0.0)).x
            + texture(tex, pos + vec2(0.0, zs.y)).x
            + texture(tex, pos - vec2(0.0, zs.y)).x);
    }

    /* ⭐ 灵框追加（第一百零三轮）：程序化噪声（值噪声 + 3 octave fbm）。
       上游在 frag_drape 里自己留了一句 「// TODO: add noise texture based on biome」 ——
       这就是那一行：不给它贴图（省一张 2K 纹理与一次采样带宽），直接在片元里算。
       坐标用**世界 uv**（v_uv，0..1000 归一）⇒ 纹理跟着地形走，缩放时不会"在屏幕上滑动"。 */
    float hash21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
    }
    float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash21(i),               b = hash21(i + vec2(1.0, 0.0)),
              c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
    float fbm3(vec2 p) {
        return 0.5 * vnoise(p) + 0.25 * vnoise(p * 2.03) + 0.125 * vnoise(p * 4.01);
    }

    void main() {
        vec2 sample_offset = 0.5 * u_inverse_texture_size;
        vec2 pos = v_uv + sample_offset;
        vec2 dx = vec2(u_inverse_texture_size.x, 0),
             dy = vec2(0, u_inverse_texture_size.y);

        float z  = texture(u_elevation, pos).x;
        float zE = texture(u_elevation, pos + dx).x;
        float zN = texture(u_elevation, pos - dy).x;
        float zW = texture(u_elevation, pos - dx).x;
        float zS = texture(u_elevation, pos + dy).x;
        /* ⭐ 灵框追加（第九十七轮）：风格用的**原始**高度 —— 下面第 386 行会给河流压低 z，
           等高线要是用被压低过的 z，河两边就会长出一圈假等高线。 */
        float z0 = z;
        bool styleLand = (u_bands > 1.0 || u_contour > 0.0) && z0 >= 0.5;
        float zLand = styleLand ? smoothLandHeight(u_elevation, pos, u_inverse_texture_size, z0) : z0;
        vec3 slope_vector = normalize(vec3(zS-zN, zE-zW, u_overhead * (u_inverse_texture_size.x + u_inverse_texture_size.y)));
        /* ⭐ 灵框追加（第一百零三轮）：山体细节 —— 用噪声扰动法线，让山不是"光滑的灰团"。
           只在陆地、且档位开启时算（fbm3 是三次取噪，海里不需要）。
           权重随高度上升：山脚平缓（不该长毛刺），山脊/坡面才需要细碎起伏。 */
        float detailN = 0.0;
        if (u_detail > 0.0 && z0 >= 0.5) {
            vec2 duv = v_uv * 300.0;
            float d0 = fbm3(duv);
            float ddx = fbm3(duv + vec2(1.8, 0.0)) - d0;
            float ddy = fbm3(duv + vec2(0.0, 1.8)) - d0;
            float amt = u_detail * smoothstep(0.5, 0.62, z0);
            slope_vector = normalize(slope_vector + vec3(ddx, ddy, 0.0) * 3.5 * amt);
            detailN = d0 - 0.5;
        }
        vec3 light_vector = normalize(vec3(u_light_angle, mix(u_slope, u_flat, slope_vector.z)));
        float light = u_ambient + max(0.0, dot(light_vector, slope_vector));
        vec3 neutral_biome_color = neutral_land_biome;
        vec4 water_color = texture(u_water, pos);
        if (z >= 0.5 && v_z >= 0.0) {
            // on land, lower the elevation around rivers
            z -= u_outline_water / 256.0 * (1.0 - water_color.a);
        } else {
            // in the ocean, or underground, don't draw rivers
            water_color.a = 0.0; neutral_biome_color = neutral_water_biome;
        }
        /* ⭐ 灵框追加（第九十七轮）：分层设色（等高线风格的底）—— 把"取色用的高度"量化成 u_bands 档。
           档内留 0.35 的渐变，免得平得像色卡；关着时（u_bands ≤ 1）与上游逐字一致。
           ⚠️ **只量化陆地**（z0 ≥ 0.5）：海里也量化的话，深浅海的渐变会被切成几块死色
           （第九十七轮真机截图逮到的）。同一条平滑高度 zLand 也给等高线用 ⇒ 色带的边与线正好吻合。 */
        float zc = z;
        if (u_bands > 1.0 && z0 >= 0.5) {
            float lv = zLand * u_bands;
            zc = (floor(lv) + 0.35 * (lv - floor(lv))) / u_bands;
        }
        vec3 biome_color = texture(u_colormap, vec2(zc, v_em.y)).rgb;
        water_color = mix(vec4(neutral_water_biome * (1.2 - water_color.a), water_color.a), water_color, u_biome_colors);
        biome_color = mix(neutral_biome_color, biome_color, u_biome_colors);
        if (v_z < 0.0) {
            // at the exterior boundary, we'll draw soil or water underground
            float land_or_water = smoothstep(0.0, -0.001, v_em.x - v_z);
            vec3 soil_color = vec3(0.4, 0.3, 0.2);
            vec3 underground_color = mix(soil_color, mix(neutral_water_biome, vec3(0.1, 0.1, 0.2), u_biome_colors), land_or_water) * smoothstep(-0.7, -0.1, v_z);
            vec3 highlight_color = mix(vec3(0, 0, 0), mix(vec3(0.8, 0.8, 0.8), vec3(0.4, 0.5, 0.7), u_biome_colors), land_or_water);
            biome_color = mix(underground_color, highlight_color, 0.5 * smoothstep(-0.025, 0.0, v_z));
            light = 1.0 - 0.3 * smoothstep(0.8, 1.0, fract((v_em.x - v_z) * 20.0)); // add horizontal lines
        }
        /* ⭐ 灵框追加（第一百零三轮）：风格色带 —— 用两条等距色带取代上游"高程 × 湿度"的贴图取色。
           · 陆地 t = 高度（0 = 海平面，1 = 最高峰；纹理值 0.5..0.925 对应高度 0..0.85）；
           · 海里 t = 深浅（0 = 岸边 → 1 = 最深；纹理值 0.5..0.225）；
           · 河单独一色（上游 river 的 rgb 也是拿色带算的，风格档里统一成河色）。
           u_grade = 0 ⇒ 整段跳过：旧调用方（离线脚本 / 没设风格的测试）拿到的还是上游逐字结果。 */
        if (u_grade > 0.0) {
            float landT = clamp((zLand - 0.5) / 0.425, 0.0, 1.0);
            float seaT  = clamp((0.5 - z0) / 0.275, 0.0, 1.0);
            float f8 = landT * 7.0;
            int i8 = int(floor(f8));
            vec3 landC = mix(u_land_ramp[i8], u_land_ramp[min(i8 + 1, 7)], fract(f8));
            float f6 = seaT * 5.0;
            int i6 = int(floor(f6));
            vec3 seaC = mix(u_sea_ramp[i6], u_sea_ramp[min(i6 + 1, 5)], fract(f6));
            /* 湿度：湿的地方偏绿、干的地方偏暖（只有自然/卫星档给大权重） */
            landC *= mix(vec3(1.03, 0.99, 0.94), vec3(0.96, 1.04, 0.97), clamp(v_em.y, 0.0, 1.0) * u_moist);
            /* 细节噪声给陆地加一层斑驳（幅度小，不把色带打乱） */
            landC *= 1.0 + detailN * 0.04 * u_detail;
            biome_color = mix(biome_color, mix(seaC, landC, step(0.5, z0)), u_grade);
            water_color.rgb = mix(water_color.rgb, u_river_color, u_grade);

            /* 海岸带：陆地一侧压一层湿沙，水线上一道极细的亮边（浪花）。
               上游只有一条 1px 的暗描边，放大像"贴纸边缘"；真实地图上陆海之间是渐变 + 浪花。 */
            if (u_coast > 0.0) {
                float wet = (1.0 - smoothstep(0.0, 0.028, z0 - 0.5)) * step(0.5, z0);
                biome_color = mix(biome_color, mix(biome_color, vec3(0.90, 0.86, 0.74), 0.45), wet * u_coast);
                float foam = 1.0 - smoothstep(0.0, 0.004, abs(z0 - 0.5));
                biome_color = mix(biome_color, vec3(0.95, 0.96, 0.94), foam * u_coast * 0.22);
            }
            /* 水面细纹：只在海里（河有自己的一色），给深浅色带一点"水"的质感 */
            if (u_water_noise > 0.0 && z0 < 0.5) {
                float wn = fbm3(v_uv * 70.0) - 0.5;
                biome_color *= 1.0 + u_water_noise * wn * 0.05;
            }
            /* 坡面排线（水墨 / 羊皮纸 / 蓝图）：按坡向排线、按坡度遮罩 —— 越陡越密 */
            if (u_hatch > 0.0) {
                float steep = clamp(1.0 - slope_vector.z, 0.0, 1.0);
                float ang = atan(slope_vector.y, slope_vector.x);
                float sv = dot(v_uv * 700.0, vec2(cos(ang), sin(ang)));
                float hline = smoothstep(0.62, 0.96, abs(sin(sv * 1.2)));
                float hmask = smoothstep(0.08, 0.40, steep) * step(0.5, z0);
                biome_color = mix(biome_color, u_line_color, hline * hmask * u_hatch);
            }
        }

        /* ⭐ 灵框追加（第九十七轮）：等高线 —— 上游那句原注释就写着 contour lines，是注释掉的，
           这里放开并做成可调（u_contour 开关 / u_contour_scale 每格几条）：
             · 只画陆地（z0 ≥ 0.5）：这个尺度下海里的等深线只会糊成一片；
             · 用原始高度 z0，不用被河流压低过的 z；
             · 线宽按屏幕导数 fwidth 归一 ⇒ 约 1.5 像素，缩放不变粗。
           ⚠️ 线宽既然用 fwidth 归一，而 GLSL 对"在非一致分支里求导"是**未定义行为**
           ⇒ 这里无条件算好，开关（u_contour）与"是否陆地"乘进结果里。
           算术很便宜，取纹理才贵 —— 真正贵的 zLand 上面已经按需算过了。 */
        float cInterval = 1.0 / max(u_contour_scale, 1.0);
        float cFrac = fract(zLand / cInterval);
        float cDist = min(cFrac, 1.0 - cFrac) * cInterval;   /* 到最近档线的"高度距离" */
        float cPx = max(fwidth(zLand), 1e-6);
        float cLine = (1.0 - smoothstep(1.0, 2.2, cDist / cPx)) * u_contour * step(0.5, z0);
        /* 线色跟着风格走（地形图是褐色、蓝图是青色、极简档压根不画）：以前只会"把底色调暗一半"，
           在深色色带（蓝图）上就完全看不见线。 */
        biome_color = mix(biome_color, mix(biome_color * 0.5, u_line_color, 0.65), cLine);

        // TODO: add noise texture based on biome

        float depth0 = texture(u_depth, v_xy).x,
              depth1 = max(max(texture(u_depth, v_xy + u_outline_depth*(-dy-dx)).x,
                               texture(u_depth, v_xy + u_outline_depth*(-dy+dx)).x),
                           texture(u_depth, v_xy + u_outline_depth*(-dy)).x),
              depth2 = max(max(texture(u_depth, v_xy + u_outline_depth*(dy-dx)).x,
                               texture(u_depth, v_xy + u_outline_depth*(dy+dx)).x),
                           texture(u_depth, v_xy + u_outline_depth*(dy)).x);
        float outline = 1.0 + u_outline_strength * (max(u_outline_threshold, depth1-depth0) - u_outline_threshold);

        // Add coast outline, but avoid it if there's a river nearby
        float neighboring_river = max(
            max(
                texture(u_water, pos + u_outline_depth * dx).a,
                texture(u_water, pos - u_outline_depth * dx).a
            ),
            max(
                texture(u_water, pos + u_outline_depth * dy).a,
                texture(u_water, pos - u_outline_depth * dy).a
            )
        );
        if (z <= 0.5 && max(depth1, depth2) > 1.0/256.0 && neighboring_river <= 0.2) { outline += u_outline_coast * 256.0 * (max(depth1, depth2) - 2.0*(z - 0.5)); }

        /* ⭐ 灵框追加（第九十七轮）：u_shade = 0 ⇒ 完全平面（light 恒 1），1 ⇒ 上游原样的山体阴影 */
        float shade = mix(1.0, light, u_shade);
        vec3 col = mix(biome_color, water_color.rgb, water_color.a) * shade / outline;
        /* ⭐ 灵框追加（第一百零三轮）：屏幕空间的收尾三层 —— 纸面做旧 / 颗粒 / 暗角。
           用 v_xy（屏幕 0..1）而不是世界 uv：纸纹和颗粒是"盖在这张图上"的，不该随地形缩放而游动。 */
        if (u_paper > 0.0) {
            float stain = fbm3(v_xy * 7.0);
            col *= mix(1.0, 0.90 + 0.20 * stain, u_paper);
            col = mix(col, col * vec3(1.05, 0.98, 0.90), u_paper * 0.5);
        }
        if (u_grain > 0.0) {
            col *= 1.0 + (hash21(floor(v_xy * 1600.0)) - 0.5) * u_grain * 0.35;
        }
        if (u_vignette > 0.0) {
            col *= 1.0 - u_vignette * smoothstep(0.40, 0.92, length(v_xy - 0.5));
        }
        out_fragcolor = vec4(col, 1);
    }`;

const vert_final = `
    precision highp float;
    in vec2 a_uv;
    out vec2 v_uv;
    void main() {
        v_uv = a_uv;
        gl_Position = vec4(2.0 * v_uv - 1.0, 0.0, 1.0);
    }`;

const frag_final = `
    precision mediump float;
    uniform sampler2D u_texture;
    uniform vec2 u_offset;
    in vec2 v_uv;
    out vec4 out_fragcolor;
    void main() {
         out_fragcolor = texture(u_texture, v_uv + u_offset);
    }`;

//////////////////////////////////////////////////////////////////////
// Mapgen4 renderer

const fbo_texture_size: number = 2048;

/* ⭐ 灵框追加（第一百零三轮）：风格色带的零值兜底（`grade = 0` 时着色器不读它们，
   但 uniform 数组仍必须被赋一个合法长度，否则有些驱动会警告）。 */
const ZERO_LAND_RAMP = new Float32Array(8 * 3);
const ZERO_SEA_RAMP = new Float32Array(6 * 3);
const ZERO_RGB = new Float32Array([0, 0, 0]);

export default class Renderer {
    numRiverTriangles: number = 0;

    topdown: mat4;
    projection: mat4;
    inverse_projection: mat4;

    a_quad_xy: Float32Array;
    a_quad_em: Float32Array;
    quad_elements_length: number; // have to store the original size because the worker thread borrows the actual array
    quad_elements: Int32Array;
    a_river_xyww: Float32Array;

    screenshotCanvas: HTMLCanvasElement;
    screenshotCallback: () => void;
    renderParam: any;

    /* ⭐ 灵框追加（见 src/mapgen/NOTICE.md）：把画布握在手里 —— 上游构造函数里现查 `#mapgen4`、
       `resizeCanvas()` 里再查一次；我们要在沙盘地图栏与生成面板里各放一块画布 ⇒ 改成构造参数。 */
    canvas: HTMLCanvasElement;

    /* ⭐ 灵框追加（见 src/mapgen/NOTICE.md）：能停下来 —— 上游的 rAF 循环一旦开就不再结束，
       而灵框要能销毁视图（关面板 / 换世界 / 关掉地图栏）。 */
    stopped: boolean = false;

    webgl: WebGLWrapper;

    texture_colormap: Texture;

    fbo_river: Framebuffer;
    fbo_land: Framebuffer;
    fbo_depth: Framebuffer;
    fbo_drape: Framebuffer;

    program_river: Program;
    program_land: Program;
    program_depth: Program;
    program_drape: Program;
    program_final: Program;

    buffer_fullscreen: Buffer;
    buffer_quad_xy: Buffer;
    buffer_quad_em: Buffer;
    buffer_quad_elements: Buffer;
    buffer_river_xyww: Buffer;

    constructor (mesh: Mesh, canvas?: HTMLCanvasElement) {
        /* ⭐ 灵框追加：允许外部传画布（不传才退回上游那个 `#mapgen4`）。 */
        canvas = canvas ?? document.getElementById('mapgen4') as HTMLCanvasElement;
        if (!canvas) throw new Error('mapgen4: 需要一个 canvas（没传，页面里也没有 #mapgen4）');
        this.canvas = canvas;
        this.webgl = new WebGLWrapper(canvas);

        this.resizeCanvas();

        this.topdown = mat4.create();
        mat4.translate(this.topdown, this.topdown, [-1, -1, 0]);
        mat4.scale(this.topdown, this.topdown, [1/500, 1/500, 1]);

        this.projection = mat4.create();
        this.inverse_projection = mat4.create();

        this.a_quad_xy = new Float32Array(2 * (mesh.numRegions + mesh.numTriangles));
        this.a_quad_em = new Float32Array(2 * (mesh.numRegions + mesh.numTriangles));
        this.quad_elements_length = 3 * mesh.numSolidSides;
        this.quad_elements = new Int32Array(this.quad_elements_length);
        /* NOTE: The maximum number of river triangles will be when
         * there's a single binary tree that has every node filled.
         * Each of the N/2 leaves will produce 1 output triangle and
         * each of the N/2 nodes will produce 2 triangles. On average
         * there will be 1.5 output triangles per input triangle. */
        const numRiverVertices = 1.5 /* river triangles per input triangle */ * 3 /* vertices per triangle */ * mesh.numSolidTriangles;
        this.a_river_xyww = new Float32Array(numRiverVertices * 4);

        Geometry.setMeshGeometry(mesh, this.a_quad_xy);

        this.buffer_quad_xy = this.webgl.createBuffer({update: 'static', data: this.a_quad_xy});
        this.buffer_quad_em = this.webgl.createBuffer({update: 'dynamic', data: this.a_quad_em});
        this.buffer_quad_elements = this.webgl.createBuffer({indices: true, update: 'dynamic', data: this.quad_elements});

        this.buffer_fullscreen = this.webgl.createBuffer({update: 'static', data: new Float32Array([-2, 0, 0, -2, 2, 2])});
        this.buffer_river_xyww = this.webgl.createBuffer({update: 'dynamic', data: this.a_river_xyww});

        this.texture_colormap = this.webgl.createTexture({data: colormap.data, width: colormap.width, height: colormap.height, filter: 'nearest'});

        this.fbo_land  = this.webgl.createFramebuffer(fbo_texture_size, fbo_texture_size, {depth: false, internalFormat: this.webgl.gl.R16F, filter: 'linear'});
        this.fbo_depth = this.webgl.createFramebuffer(fbo_texture_size, fbo_texture_size, {depth: true, internalFormat: this.webgl.gl.R16F, filter: 'nearest'}); // NOTE: linear requires adjusting parameters
        this.fbo_river = this.webgl.createFramebuffer(fbo_texture_size, fbo_texture_size, {depth: false, filter: 'linear'}); // linear makes rivers look better
        this.fbo_drape = this.webgl.createFramebuffer(fbo_texture_size, fbo_texture_size, {depth: true, filter: 'linear'}); // linear to smooth out edges

        this.program_river = this.webgl.createProgram('river', vert_river, frag_river, (gl, program) => {
            this.buffer_river_xyww.vertexAttribPointer(program.a_xyww, 4, gl.FLOAT, false, 0, 0);
        });
        this.program_land  = this.webgl.createProgram('land', vert_land,  frag_land, (gl, program) => {
            this.buffer_quad_xy.vertexAttribPointer(program.a_xy, 2, gl.FLOAT, false, 0, 0);
            this.buffer_quad_em.vertexAttribPointer(program.a_em, 2, gl.FLOAT, false, 0, 0);
            this.buffer_quad_elements.bind();
        });
        this.program_depth = this.webgl.createProgram('depth', vert_depth, frag_depth, (gl, program) => {
            this.buffer_quad_xy.vertexAttribPointer(program.a_xy, 2, gl.FLOAT, false, 0, 0);
            this.buffer_quad_em.vertexAttribPointer(program.a_em, 2, gl.FLOAT, false, 0, 0);
            this.buffer_quad_elements.bind();
        });
        this.program_drape = this.webgl.createProgram('drape', vert_drape, frag_drape, (gl, program) => {
            this.buffer_quad_xy.vertexAttribPointer(program.a_xy, 2, gl.FLOAT, false, 0, 0);
            this.buffer_quad_em.vertexAttribPointer(program.a_em, 2, gl.FLOAT, false, 0, 0);
            this.buffer_quad_elements.bind();
        });
        this.program_final = this.webgl.createProgram('final', vert_final, frag_final, (gl, program) => {
            this.buffer_fullscreen.vertexAttribPointer(program.a_uv, 2, gl.FLOAT, false, 0, 0);
        });

        this.screenshotCanvas = document.createElement('canvas');
        this.screenshotCanvas.width = fbo_texture_size;
        this.screenshotCanvas.height = fbo_texture_size;
        this.screenshotCallback = null;

        this.renderParam = undefined;
        this.startDrawingLoop();
    }

    screenToWorld(coords: [number, number]): vec2 {
        /* convert from screen 2d (inverted y) to 4d for matrix multiply */
        let glCoords = vec4.fromValues(
            coords[0] * 2 - 1,
            1 - coords[1] * 2,
            /* TODO: z should be 0 only when tilt_deg is 0;
             * need to figure out the proper z value here */
            0,
            1
        );
        /* it returns vec4 but we only need vec2; they're compatible */
        let transformed = vec4.transformMat4(vec4.create(), glCoords, this.inverse_projection);
        return [transformed[0], transformed[1]];
    }

    /* Update the buffers with the latest map data */
    updateMap() {
        this.buffer_quad_em.subdata(0, this.a_quad_em);
        this.buffer_quad_elements.subdata(0, this.quad_elements);
        this.buffer_river_xyww.subdata(0, this.a_river_xyww.subarray(0, 4 * 3 * this.numRiverTriangles));
    }

    /* Allow drawing at a different resolution than the internal texture size */
    resizeCanvas() {
        /* ⭐ 灵框追加：上游这里写死 `#mapgen4` + 写死 2048；改成用手里那块画布。
           （尺寸仍是 2048 —— 内部 4 张 FBO 就是 2048²，画布与之同大最省一次重采样。） */
        let canvas = this.canvas;
        if (!canvas) return;
        let size = 2048; /* could be smaller to increase performance */
        if (canvas.width !== size || canvas.height !== size) {
            console.log(`Resizing canvas from ${canvas.width}x${canvas.height} to ${size}x${size}`);
            canvas.width = canvas.height = size;
            this.webgl.gl.viewport(0, 0, canvas.width, canvas.height);
        }
    }

    /* wrapper function to make the other drawing functions more convenient */
    drawGeneric(program: Program, fb: Framebuffer | null, draw: (gl: WebGL2RenderingContext, program: Program) => void) {
        const {gl} = this.webgl;
        fb = fb ?? this.webgl.drawToScreen();
        fb.viewport();
        program.run(() => {
            if (fb.depth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
            draw(gl, program);
            if (fb.depth) gl.disable(gl.DEPTH_TEST);
        });
    }

    drawRivers() {
        this.drawGeneric(this.program_river, this.fbo_river, (gl, program) => {
            gl.uniformMatrix4fv(program.u_projection, false, this.topdown);

            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.blendEquation(gl.FUNC_ADD);

            gl.drawArrays(gl.TRIANGLES, 0, 3 * this.numRiverTriangles);
        });
    }

    drawLand(outline_water: number) {
        this.drawGeneric(this.program_land, this.fbo_land, (gl, program) => {
            gl.uniformMatrix4fv(program.u_projection, false, this.topdown);
            gl.uniform1f(program.u_outline_water, outline_water);
            this.fbo_river.texture.activate(gl.TEXTURE0, program.u_water);

            gl.drawElements(gl.TRIANGLES, this.quad_elements_length, gl.UNSIGNED_INT, 0);
        });
    }

    drawDepth() {
        this.drawGeneric(this.program_depth, this.fbo_depth, (gl, program) => {
            gl.uniformMatrix4fv(program.u_projection, false, this.projection);

            gl.drawElements(gl.TRIANGLES, this.quad_elements_length, gl.UNSIGNED_INT, 0);
        });
    }

    drawDrape(renderParam: any) {
        const light_angle_rad = Math.PI / 180 * (renderParam.light_angle_deg + renderParam.rotate_deg);
        this.drawGeneric(this.program_drape, this.fbo_drape, (gl, program) => {
            gl.uniformMatrix4fv(program.u_projection, false, this.projection);
            gl.uniform2fv(program.u_light_angle, [Math.cos(light_angle_rad), Math.sin(light_angle_rad)]);
            gl.uniform2fv(program.u_inverse_texture_size, [1.5 / this.fbo_drape.texture.width, 1.5 / this.fbo_drape.texture.height]);
            gl.uniform1f(program.u_slope, renderParam.slope);
            gl.uniform1f(program.u_flat, renderParam.flat);
            gl.uniform1f(program.u_ambient, renderParam.ambient);
            gl.uniform1f(program.u_overhead, renderParam.overhead);
            gl.uniform1f(program.u_outline_depth, renderParam.outline_depth * 5 * renderParam.zoom);
            gl.uniform1f(program.u_outline_coast, renderParam.outline_coast);
            gl.uniform1f(program.u_outline_water, renderParam.outline_water);
            gl.uniform1f(program.u_outline_strength, renderParam.outline_strength);
            gl.uniform1f(program.u_outline_threshold, renderParam.outline_threshold / 1000);
            gl.uniform1f(program.u_biome_colors, renderParam.biome_colors);
            /* ⭐ 灵框追加（第九十七轮）：风格三件套。缺省值 = 上游原样（全晕渲、无等高线、无分层设色）*/
            gl.uniform1f(program.u_shade, renderParam.shade ?? 1);
            gl.uniform1f(program.u_contour, renderParam.contour ?? 0);
            gl.uniform1f(program.u_contour_scale, renderParam.contour_scale ?? 10);
            gl.uniform1f(program.u_bands, renderParam.bands ?? 0);
            /* ⭐ 灵框追加（第一百零三轮）：真实感旋钮 + 风格色带
               ⚠️ 数组 uniform 的 location 名带 `[0]`（WebGL 的 getActiveUniform 就这么报），
               `program.u_land_ramp` 是 undefined ⇒ 得走 `uniformLoc()` 兜一下。 */
            gl.uniform1f(program.u_grade, renderParam.grade ?? 0);
            gl.uniform1f(program.u_detail, renderParam.detail ?? 0);
            gl.uniform1f(program.u_coast, renderParam.coast ?? 0);
            gl.uniform1f(program.u_water_noise, renderParam.water_noise ?? 0);
            gl.uniform1f(program.u_hatch, renderParam.hatch ?? 0);
            gl.uniform1f(program.u_paper, renderParam.paper ?? 0);
            gl.uniform1f(program.u_grain, renderParam.grain ?? 0);
            gl.uniform1f(program.u_vignette, renderParam.vignette ?? 0);
            gl.uniform1f(program.u_moist, renderParam.moist ?? 0);
            const uniformLoc = (name: string) => program[name] ?? program[`${name}[0]`];
            gl.uniform3fv(uniformLoc('u_land_ramp'), renderParam.land_ramp ?? ZERO_LAND_RAMP);
            gl.uniform3fv(uniformLoc('u_sea_ramp'), renderParam.sea_ramp ?? ZERO_SEA_RAMP);
            gl.uniform3fv(uniformLoc('u_line_color'), renderParam.line_color ?? ZERO_RGB);
            gl.uniform3fv(uniformLoc('u_river_color'), renderParam.river_color ?? ZERO_RGB);

            this.texture_colormap.activate(gl.TEXTURE0, program.u_colormap);
            this.fbo_land.texture.activate(gl.TEXTURE1, program.u_elevation);
            this.fbo_river.texture.activate(gl.TEXTURE2, program.u_water);
            this.fbo_depth.texture.activate(gl.TEXTURE3, program.u_depth);

            gl.drawElements(gl.TRIANGLES, this.quad_elements_length, gl.UNSIGNED_INT, 0);
        });
    }

    drawFinal(offset: [number, number]) {
        this.drawGeneric(this.program_final, null, (gl, program) => {
            gl.uniform2fv(program.u_offset, offset);
            this.fbo_drape.texture.activate(gl.TEXTURE0, program.u_texture);

            gl.drawArrays(gl.TRIANGLES, 0, 3);
        });
    }

    startDrawingLoop() {
        const {gl} = this.webgl;

        const clearBuffers = () => {
            this.fbo_river.clear(0, 0, 0, 0);
            this.fbo_depth.clear(0, 0, 0, 1);
            this.fbo_drape.clear(0.3, 0.3, 0.35, 1);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        };

        /* Only draw when render parameters have been passed in;
         * otherwise skip the render and wait for the next tick */
        clearBuffers();
        const renderLoop = () => {
            requestAnimationFrame(renderLoop);
            if (this.stopped) { return; }
            const renderParam = this.renderParam;
            if (!renderParam) { return; }
            this.renderParam = undefined;

            if (this.numRiverTriangles > 0) {
                this.drawRivers();
            }

            this.drawLand(renderParam.outline_water);

            /* Standard rotation for orthographic view */
            mat4.identity(this.projection);
            mat4.rotateX(this.projection, this.projection, (180 + renderParam.tilt_deg) * Math.PI/180);
            mat4.rotateZ(this.projection, this.projection, renderParam.rotate_deg * Math.PI/180);

            /* Top-down oblique copies column 2 (y input) to row 3 (z
             * output). Typical matrix libraries such as glm's mat4 or
             * Unity's Matrix4x4 or Unreal's FMatrix don't have this
             * this.projection built-in. For mapgen4 I merge orthographic
             * (which will *move* part of y-input to z-output) and
             * top-down oblique (which will *copy* y-input to z-output).
             * <https://en.wikipedia.org/wiki/Oblique_projection> */
            this.projection[9] = 1;

            /* Scale and translate works on the hybrid this.projection */
            mat4.scale(this.projection, this.projection, [renderParam.zoom/100, renderParam.zoom/100, renderParam.mountain_height * renderParam.zoom/100]);
            mat4.translate(this.projection, this.projection, [-renderParam.x, -renderParam.y, 0]);

            /* Keep track of the inverse matrix for mapping mouse to world coordinates */
            mat4.invert(this.inverse_projection, this.projection);

            if (renderParam.outline_depth > 0) {
                this.drawDepth();
            }

            this.drawDrape(renderParam);

            /* Draw the final texture to the canvas; this slightly blurs the outlines */
            this.drawFinal([0.5 / fbo_texture_size, 0.5 / fbo_texture_size]);

            if (this.screenshotCallback) {
                const ctx = this.screenshotCanvas.getContext('2d');
                const imageData = ctx.getImageData(0, 0, this.screenshotCanvas.width, this.screenshotCanvas.height);
                const bytesPerRow = 4 * this.screenshotCanvas.width;
                const buffer = new Uint8Array(bytesPerRow * this.screenshotCanvas.height);
                gl.readPixels(0, 0, this.screenshotCanvas.width, this.screenshotCanvas.height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);

                /* Flip row order from WebGL to Canvas */
                for (let y = 0; y < this.screenshotCanvas.height; y++) {
                    const rowBuffer = new Uint8Array(buffer.buffer, y * bytesPerRow, bytesPerRow);
                    imageData.data.set(rowBuffer, (this.screenshotCanvas.height-y-1) * bytesPerRow);
                }
                ctx.putImageData(imageData, 0, 0);

                this.screenshotCallback();
                this.screenshotCallback = null;
            }

            clearBuffers();
        };

        renderLoop();
    }

    updateView(renderParam: any) {
        this.renderParam = renderParam;
    }

    /* ⭐ 灵框追加：停止渲染循环（见 NOTICE.md） */
    stopDrawingLoop() {
        this.stopped = true;
    }
}
