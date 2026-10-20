import { defineConfig } from 'vitest/config';

/**
 * twin-schema 的测试配置。
 *
 * 没有使用 `globals: true`：显式 `import { describe, it } from 'vitest'`
 * 让测试文件在 `tsc --noEmit` 下也能独立通过，不依赖全局类型注入。
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});
