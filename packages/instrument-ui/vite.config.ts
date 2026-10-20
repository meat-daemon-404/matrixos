import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';
import { resolve } from 'node:path';

/**
 * 库构建：Vite library mode + 自动生成 .d.ts。
 *
 * 输出 `dist/matrixos-instrument-ui.{js,mjs}` + `dist/*.d.ts`，
 * React / ReactDOM 为外部依赖（peer）。
 *
 * 注意：`pnpm build` 不是日常开发必需 —— package.json 的 exports 指向
 * `src/index.ts`（源码直出），下游用 `transpilePackages` 消费即可。
 * 构建产物用于：① 发布私有包 ② 类型快照 ③ 视觉回归基线。
 */
export default defineConfig({
  plugins: [
    react(),
    dts({
      // 只从 src 出类型，且把 CSS import 排除（它们没有类型）
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'demo/**'],
      rollupTypes: false,
      tsconfigPath: './tsconfig.build.json',
      insertTypesEntry: true,
      // CSS 模块由 side-effect import 引入，dts 插件默认会报找不到声明
      // 通过 copyDtsFiles + 手动 index 避免
      compilerOptions: {
        noEmit: false,
        emitDeclarationOnly: true,
        declaration: true,
        declarationMap: true,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'MatrixOSInstrumentUI',
      formats: ['es'],
      fileName: () => 'matrixos-instrument-ui.mjs',
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
      output: {
        // 保留 CSS 为独立文件，便于宿主控制加载时机
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === 'style.css') return 'styles.css';
          return assetInfo.name ?? '[name][extname]';
        },
      },
    },
    cssCodeSplit: false,
    sourcemap: true,
    target: 'es2022',
    minify: false, // 库产物不压缩，便于下游 tree-shake 与调试
  },
});
