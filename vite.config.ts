import { defineConfig } from 'vite';

export default defineConfig({
  base: './',                       // Electron file:// 兼容
  build: {
    /* 渲染层产物目录。刻意与 electron-builder 的输出目录（dist/，见 package.json
       build.directories.output）分开：
       1) electron-builder 会把自己 output 目录从 app files 里强制排除
          （见 app-builder-lib fileMatcher：会往排除列表 push 一条 outDir 全目录通配），同目录会导致
          渲染层永远进不了 asar → 装完白屏；
       2) emptyOutDir 在同目录时会把已打好的安装包删掉。 */
    outDir: 'app-dist',
    emptyOutDir: true,
    target: 'chrome120',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
