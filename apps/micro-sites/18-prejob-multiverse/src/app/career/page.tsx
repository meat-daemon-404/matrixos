/**
 * 学职平台数据浏览与生涯对照 —— 独立路由 /career
 *
 * 为什么不挂在 page.tsx 上：
 * 那两个面板（专业锚定 + 内容浏览器）原本挂在首页，但首页现由
 * `scripts/wire-workbench.mjs` 从 `shared/templates/page.tsx` 统一分发，
 * 文件头明写「请勿直接修改本文件」，改法要求「改模板 → 重新分发，18 站一起更新」。
 * 把学职平台专属组件塞进 18 站共用模板显然不对；直接改 page.tsx 又违反新约定，
 * 且会与并行会话的重新分发互相覆盖。
 *
 * 所以走独立路由：零冲突、不动任何生成物，且符合本站已有的
 * 「一个站多个页面」结构（layout 已就位）。
 *
 * 数据来源与合规声明见组件内部与 docs/03-xz-integration/02-compliance.md。
 */
import type { Metadata } from 'next';

import { AnchorPanel } from '../../components/anchor-panel';
import { XzExplorer } from '../../components/xz-explorer';
import { XzResources } from '../../components/xz-resources';
import { SITE } from '../../site.config';

export const metadata: Metadata = {
  title: `${SITE.name} · 职业与专业数据`,
  description: '基于学职平台公开数据的职业人物、专业目录与毕业去向对照。',
};

export default function CareerPage() {
  return (
    <main className="site-root">
      <header className="site-header">
        <span className="site-id">{SITE.id}</span>
        <h1 className="site-title">职业与专业数据</h1>
        <span className="site-orbit">{SITE.orbitName}</span>
        <a className="site-domain mono" href="/">
          ← 返回{SITE.name}
        </a>
      </header>

      <AnchorPanel />
      <XzExplorer />
      <XzResources />

      <footer className="site-footer">
        <span className="mono">{SITE.domain}/career</span>
        <span>
          职业与专业内容源自{' '}
          <a
            href="https://xz.chsi.com.cn/"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'inherit' }}
          >
            学职平台
          </a>
          （教育部学生服务与素质发展中心）· 结构化索引，著作权归原站
        </span>
      </footer>
    </main>
  );
}
