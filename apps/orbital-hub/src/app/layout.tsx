import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
// workspace 包未就位时，next.config.ts 会把这条 specifier 别名到本地 shim（同样是一次全局样式）
import '@matrixos/instrument-ui/styles.css';
import './globals.css';
import './hub-components.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://orbital.matrixos.edu'),
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
