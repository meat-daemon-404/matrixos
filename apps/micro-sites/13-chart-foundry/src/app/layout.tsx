/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：13 Nature 级出版图表熔炉
 * 轨道：轨道 5 · 工坊 · 域名：chart-foundry.matrixos.edu
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=13 --force
 */
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
// workspace 包未就位时，next.config.ts 会把这条 specifier 别名到本地 shim（同样是一次全局样式）
import "@matrixos/instrument-ui/styles.css";
import { SITE } from '../site.config';
import './globals.css';

// MATRIXOS_METADATA_V2 —— 由 scripts/upgrade-metadata.mjs 生成
// 生产 URL 通过 MATRIXOS_PUBLIC_BASE 控制（绑自定义域名时改这一个）
const PUBLIC_URL = 'https://mx-chart-foundry.pages.dev';

const SITE_ORIGIN = 'https://mx-' + SITE.appId + '.pages.dev';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: SITE.name + ' · MatrixOS',
  description: SITE.desc,
  applicationName: 'MatrixOS',
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml', sizes: 'any' }],
  },
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    locale: 'zh_CN',
    url: SITE_ORIGIN,
    siteName: SITE.name,
    title: SITE.name + ' · MatrixOS',
    description: SITE.desc,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  other: {
    'matrixos:station-id': SITE.id,
    'matrixos:orbit': SITE.orbitName,
  },
};;

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
