/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：05 五源跨库引文声呐站
 * 轨道：轨道 3 · 情报 · 域名：lit-sonar.matrixos.edu
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=05 --force
 */
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
// workspace 包未就位时，next.config.ts 会把这条 specifier 别名到本地 shim（同样是一次全局样式）
import "@matrixos/instrument-ui/styles.css";
import { SITE } from '../site.config';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://' + SITE.domain),
  title: SITE.name + ' · MatrixOS',
  description: SITE.desc,
  applicationName: 'MatrixOS',
  other: {
    'matrixos:station-id': SITE.id,
    'matrixos:orbit': SITE.orbitName,
  },
};

export const viewport: Viewport = {
  themeColor: '#050814',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body data-matrixos-station={SITE.id}>{children}</body>
    </html>
  );
}
