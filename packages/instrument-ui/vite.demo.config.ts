import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

/**
 * Demo 站：`pnpm --filter @matrixos/instrument-ui dev`
 *
 * 端口 3060（遵守 docs/02-engineering/01-dev-setup.md 的端口约定：
 * hub 3000、微站 3010~3027、不占用这些范围）。
 *
 * demo 直接消费 `src/index.ts`（源码直出），不依赖先跑 build，
 * 这样改组件 → HMR 立即生效，是组件库开发最快的内循环。
 */
export default defineConfig({
  root: resolve(__dirname, 'demo'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@matrixos/instrument-ui': resolve(__dirname, 'src/index.ts'),
      '@matrixos/instrument-ui/styles.css': resolve(__dirname, 'src/styles.css'),
      '@matrixos/instrument-ui/tokens.css': resolve(__dirname, 'src/tokens.css'),
      '@matrixos/instrument-ui/tailwind.css': resolve(__dirname, 'src/theme.tailwind4.css'),
    },
  },
  server: {
    port: 3060,
    strictPort: false,
    open: false,
  },
  build: {
    outDir: resolve(__dirname, 'dist-demo'),
    emptyOutDir: true,
    sourcemap: true,
  },
});
