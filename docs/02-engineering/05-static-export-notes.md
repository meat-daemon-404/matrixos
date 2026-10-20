# 静态导出（Cloudflare Pages）与开发构建的差异

> 本文档记录把 Next.js 微站部署到 Cloudflare Pages 时踩过的坑。
> 脚本：`scripts/build-static-site.mjs`

---

## 一、为什么需要单独的构建脚本

微站的 `next.config.ts` 里有 `headers()`，用来设置：

```ts
Content-Security-Policy: frame-ancestors 'self' https://orbital.matrixos.edu ...
```

这条 CSP 限制**只有 hub 能把微站嵌进 iframe**，是安全边界。

但 Next.js 的 `output: 'export'`（静态导出）**不支持 `headers()`** —— 有它会直接构建失败。

所以部署时不能直接用 `next build`，需要：

1. 临时把 `next.config.ts` 换成静态导出专用版本（去掉 `headers()`，加 `output: 'export'`）
2. `next build` → 产物在 `out/`
3. 用 Cloudflare Pages 的 `_headers` 文件**重建**那条 CSP
4. 恢复原 `next.config.ts`（逐字节校验）

脚本自动做这四步，`finally` 保证恢复。

---

## 二、踩过的坑

### 坑 1：`NEXT_CONFIG_FILE` 环境变量不存在

第一版脚本想用 `NEXT_CONFIG_FILE=next.config.deploy.mjs npx next build` 指定配置文件。

**这是错的。** Next.js 15 没有这个环境变量（我记混了）。实测结果是构建成功但 `out/` 不生成——因为 Next 读的仍是原配置，走的是非导出构建。

正确做法是备份/替换/恢复 `next.config.ts` 本身。

### 坑 2：`_not-found` 的 invariant 错误

```
[Error: Invariant: no direct app page entry found for /_not-found]
```

App Router 在 `output: 'export'` 下，如果项目没有显式的 `not-found.tsx`，
Next 15.5 自动生成的 `_not-found` 会触发这个 invariant。

**修法**：每个微站加一个 `src/app/not-found.tsx`（见下方模板）。

### 坑 3：Windows 下 `shell: true` 让 cwd 行为不一致

`execFileSync('npx', [...], { shell: true })` 在 Windows 下会经由 `cmd.exe`，
cwd 与引号处理有差异，出现过「配置文件已写好但 next build 读到旧配置」。

**修法**：优先直接用 Node 跑 Next 的 CLI 入口（`node node_modules/next/dist/bin/next build`），
找不到再退回 `npx`。仓库根有 `node_modules/next`，但 pnpm 的 workspace 结构下
微站自己的 `node_modules/next` 是软链，需要从微站目录解析。

---

## 三、`not-found.tsx` 模板

每个微站都需要加上（脚本不自动生成，因为文案要按站定制）：

```tsx
import Link from 'next/link';
import { SITE } from '../site.config';

export default function NotFound() {
  return (
    <main style={{ padding: '3rem', textAlign: 'center' }}>
      <h1>404 · 该路径不存在</h1>
      <p className="mono">{SITE.domain}</p>
      <p>微站 {SITE.name} 没有这个页面。</p>
      <Link href="/">← 返回首页</Link>
    </main>
  );
}
```

---

## 四、Cloudflare Pages 配置

### 构建命令

```bash
node scripts/build-static-site.mjs --site=11-curvelab-fit
```

### 输出目录

`apps/micro-sites/<site>/out`

### `_headers`（脚本自动生成）

```
/*
  Content-Security-Policy: frame-ancestors 'self' https://orbital.pages.dev ... 
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff

/_next/static/*
  Cache-Control: public, max-age=31536000, immutable
```

---

## 五、orbital-hub 的特殊处理

hub 有一个 `/placeholder` 路由用了 `searchParams`，**是动态路由，不能静态导出**。

所以 hub 不走这套流程，改用 `@opennextjs/cloudflare` 部署到 Workers。
两个方案的边界：

| | 微站（18 个） | orbital-hub |
| :--- | :--- | :--- |
| 渲染方式 | 纯静态（SSG） | 混合（SSG + 1 个动态路由） |
| 部署目标 | Cloudflare Pages | Cloudflare Workers |
| 构建 | `output: 'export'` | `@opennextjs/cloudflare` |
| 产物 | `out/` | `.open-next/` |
