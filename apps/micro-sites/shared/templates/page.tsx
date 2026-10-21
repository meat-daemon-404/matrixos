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
