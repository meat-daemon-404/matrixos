/**
 * ⚠️ 由 scripts/wire-workbench.mjs 从 apps/micro-sites/shared/templates/ 分发，请勿直接修改本文件。
 * 模板：apps/micro-sites/shared/templates/page.tsx
 * 作用：页面装配（外壳 + 完工台 + 页脚）
 * 站点：18 生涯多重宇宙期望决策树
 * 轨道：轨道 7 · 预职 · 域名：prejob.matrixos.cc.cd
 * 改法：改模板 → 跑 `node scripts/wire-workbench.mjs` 重新分发（18 站会一起更新）。
 */
import { SiteShell } from '../components/site-shell';
import { SiteWorkbench } from '../components/site-workbench';
import { SITE } from '../site.config';

export default function Page() {
  return (
    <main className="site-root">
      <SiteShell />
      <SiteWorkbench />
      <footer className="site-footer">
        <span className="mono">{SITE.domain}</span>
        <span>本地持久化台账 · 可增改删导出 · 虫洞投送见面板 · ADR-001</span>
      </footer>
    </main>
  );
}
