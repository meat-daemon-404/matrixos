import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
// workspace 包未就位时，next.config.ts 会把这条 specifier 别名到本地 shim（同样是一次全局样式）
import '@matrixos/instrument-ui/styles.css';
import './globals.css';
import './hub-components.css';

export const metadata: Metadata = {
  /*
   * 生产入口是 matrixos.cc.cd（2026-10-21 账号迁移后）。
   * 旧值 orbital.matrixos.edu 是**已废弃**的愿景域名，实测 NXDOMAIN：
   * canonical / og:url 指向一个解析不到的主机，等于向爬虫自报死链，
   * 比不写 canonical 更糟。可用 MATRIXOS_HUB_ORIGIN 覆盖（预览/本地）。
   */
  metadataBase: new URL(process.env.NEXT_PUBLIC_HUB_ORIGIN ?? 'https://matrixos.cc.cd'),
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    locale: 'zh_CN',
    url: '/',
    siteName: 'MatrixOS',
  },
  title: 'MatrixOS · 双态合体总控台',
  description:
    '左 32% 2.5D 星轨引力场 · 右 68% 折射仪器架 · 底部声波脉冲坞 —— 18 个官方旗舰微站的统一入口',
  applicationName: 'MatrixOS orbital-hub',
  other: {
    'matrixos:role': 'orbital-hub',
    'matrixos:station-count': '18',
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
      <body>{children}</body>
    </html>
  );
}
