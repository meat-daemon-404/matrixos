/**
 * 404 页 —— 静态导出（Cloudflare Pages）必需。
 *
 * App Router 在 output:'export' 下，若缺本文件，Next 15.5 自动生成的
 * _not-found 会抛 "Invariant: no direct app page entry found for /_not-found"。
 * 见 docs/02-engineering/05-static-export-notes.md。
 *
 * 生成：scripts/gen-not-found.mjs（内容按站点定制，勿手改后忘记同步脚本）
 */
import Link from 'next/link';
import { SITE } from '../site.config';

export default function NotFound() {
  return (
    <main className="site-root" style={{ padding: '4rem 1.5rem', textAlign: 'center' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>404 · 该路径不存在</h1>
      <p className="mono" style={{ opacity: 0.6, marginBottom: '1.5rem' }}>
        {SITE.domain}
      </p>
      <p style={{ marginBottom: '2rem' }}>
        微站「{SITE.name}」没有这个页面。
      </p>
      <Link
        href="/"
        style={{
          display: 'inline-block',
          padding: '0.6rem 1.2rem',
          border: '1px solid currentColor',
          borderRadius: '0.5rem',
        }}
      >
        ← 返回首页
      </Link>
    </main>
  );
}
