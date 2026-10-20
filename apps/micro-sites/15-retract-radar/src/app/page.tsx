/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：15 撤稿深海声呐与伦理合规仪
 * 轨道：轨道 5 · 工坊 · 域名：retract-radar.matrixos.edu
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=15 --force
 */
import { SiteShell } from '../components/site-shell';
import { SITE } from '../site.config';

/**
 * 微站入口页（骨架 / 占位）。
 *
 * 服务端只负责吐静态骨架；身份状态、iframe 握手、虫洞接收器都在
 * <SiteShell />（client component）里挂载。
 */
export default function Page() {
  return (
    <main className="site-root">
      <SiteShell />
      <footer className="site-footer">
        <span className="mono">{SITE.domain}</span>
        <span>骨架由 scripts/gen-site.mjs 生成 · ADR-001</span>
      </footer>
    </main>
  );
}
