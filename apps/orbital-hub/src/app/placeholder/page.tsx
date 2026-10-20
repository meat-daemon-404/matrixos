/**
 * 微站占位页 · /placeholder
 * =====================================================================
 * 这是任务 A1 的落点：**微站未部署时，iframe 里不能是白屏。**
 *
 * 为什么需要一个真实路由，而不是在 hub 侧渲染一段 HTML 字符串：
 *  1. hub 面板里的 iframe 是**跨源沙箱**语境。若把占位内容塞进 iframe 的
 *     srcdoc 或 blob:，它会继承 hub 的源，于是「跨源 iframe」这条最需要被
 *     持续验证的路径在开发期从来跑不到 —— 等接真微站时才发现问题。
 *     走同源的一条真实路由（/placeholder），至少保留了「独立文档 + 独立
 *     JS 运行时 + 真实 URL」这三件与生产一致的事。
 *  2. 它是**可分享、可独立打开**的：面板的 [↗ 全屏独立打开] 指向同一个 URL，
 *     点开看到的是同一张说明页，而不是 404。
 *  3. 答疑场景下可直接把 URL 发给同学：「这块还没做，进度看这里」。
 *
 * 内容取向（重要）：占位页**不伪造仪器**。
 *   画一堆假曲线/假读数会让人误以为该站已经能用，进而在验收时误判进度。
 *   这里只画「该站设计成什么样」的**线框示意**（骨架框 + 标注），
 *   并明确写明"这是占位页，不是该站的真实界面"。
 *
 * 技术约束：
 *  - 必须是 **server component**：零客户端 JS，iframe 里不跑 React 运行时。
 *    这恰好也是 R-T03 想要的方向 —— 占位页本身不该成为性能负担。
 *  - searchParams 在 Next 15 是 Promise，必须 await（15 的破坏性变更之一）。
 */

import type { Metadata } from 'next';
import { STATION_BY_ID, ORBITS, type MicrositeStation } from '../../lib/microsites.generated';

export const metadata: Metadata = {
  title: '微站占位页 · MatrixOS',
  description: '该微站尚未部署，此页说明站点身份与设计形态',
  robots: { index: false, follow: false },
};

/** 参数取值做了防御：URL 是用户可控输入，不能直接信。 */
function resolveStation(params: Record<string, string | string[] | undefined>): {
  station: MicrositeStation | null;
  /** 未匹配到花名册时用的原始参数（仍要显示出来，便于排查拼错的链接） */
  raw: Record<string, string>;
} {
  const single = (key: string): string => {
    const value = params[key];
    if (Array.isArray(value)) return value[0] ?? '';
    return value ?? '';
  };

  const raw = {
    id: single('id'),
    name: single('name'),
    orbit: single('orbit'),
    style: single('style'),
    ledger: single('ledger'),
  };

  // 只用 id 去花名册查 —— 其余字段一律以花名册为准，不接受 URL 覆盖。
  // 否则任何人都能构造一个「看起来是 01 站、内容却是别的站」的页面来钓鱼。
  const station = raw.id ? (STATION_BY_ID[raw.id] ?? null) : null;
  return { station, raw };
}

export default async function PlaceholderPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { station, raw } = resolveStation(params);

  const accent = station?.accent ?? 'var(--color-instrument)';
  const orbit = station
    ? (ORBITS.find((item) => item.index === station.orbitIndex) ?? null)
    : null;

  return (
    <main className="placeholder-root" style={{ ['--ph-accent' as string]: accent }}>
      <header className="ph-head">
        <span className="ph-id mono">{station?.id ?? raw.id ?? '??'}</span>
        <div className="ph-titles">
          <h1 className="ph-name">{station?.name ?? raw.name ?? '未知微站'}</h1>
          <span className="ph-domain mono">
            {station?.domain ?? (raw.name ? raw.name + '（未登记）' : '未登记域名')}
          </span>
        </div>
        <span className="ph-badge">占位页 · 未部署</span>
      </header>

      {/*
        诚实声明放在最显眼的位置。占位页最大的风险不是"不好看"，
        而是被人当成"这个站已经做好了"。
      */}
      <section className="ph-notice" role="note">
        <b>这不是该微站的真实界面。</b>
        <span>
          该站的开发尚未开始或尚未部署到此环境。本页只用于让总控台的仪器面板
          不出现白屏，并说明该站已登记的身份与设计形态。
        </span>
      </section>

      {station ? (
        <>
          <dl className="ph-grid">
            <div className="ph-card">
              <dt>轨道</dt>
              <dd>
                {station.orbitName}
                {orbit ? <span className="ph-sub"> · 共 {orbit.stationCount} 站</span> : null}
              </dd>
            </div>
            <div className="ph-card">
              <dt>UI 形态（设计目标）</dt>
              <dd>{station.uiStyle}</dd>
            </div>
            <div className="ph-card">
              <dt>独立台账</dt>
              <dd>{station.ledger}</dd>
            </div>
            <div className="ph-card">
              <dt>原型来源</dt>
              <dd>{station.source}</dd>
            </div>
            <div className="ph-card">
              <dt>开发端口</dt>
              <dd className="mono">localhost:{station.devPort}</dd>
            </div>
            <div className="ph-card">
              <dt>目录（ADR-001）</dt>
              <dd className="mono">apps/micro-sites/{station.dirName}</dd>
            </div>
            <div className="ph-card ph-card-wide">
              <dt>虫洞契约</dt>
              <dd className="mono">
                接收：{station.accepts.length > 0 ? station.accepts.join(' / ') : '（未声明）'}
                <br />
                投送：{station.emits.length > 0 ? station.emits.join(' / ') : '（未声明）'}
              </dd>
            </div>
          </dl>

          <p className="ph-desc">{station.desc}</p>

          {/* 设计形态线框示意：刻意画成"未完成的骨架"，不画假数据 */}
          <section className="ph-wire" aria-label="该站仪器形态的线框示意（非真实界面）">
            <div className="ph-wire-head">
              <span className="mono">{station.uiStyle}</span>
              <span className="ph-wire-tag">线框示意 · 非真实界面</span>
            </div>
            <div className="ph-wire-body" aria-hidden="true">
              <div className="ph-wire-col">
                <span className="ph-wire-block" style={{ height: '38%' }} />
                <span className="ph-wire-block" style={{ height: '62%' }} />
                <span className="ph-wire-block" style={{ height: '47%' }} />
              </div>
              <div className="ph-wire-main">
                <span className="ph-wire-line" />
                <span className="ph-wire-line" style={{ width: '72%' }} />
                <span className="ph-wire-line" style={{ width: '86%' }} />
                <span className="ph-wire-line" style={{ width: '54%' }} />
              </div>
            </div>
          </section>

          <section className="ph-run">
            <h2>本地跑起来看</h2>
            <pre className="ph-code mono">
              {[
                '# 在该站目录下启动 dev server',
                'pnpm --filter ' + station.pkgName + ' dev',
                '',
                '# 然后访问 http://localhost:' + station.devPort,
                '',
                '# 让总控台指向本地 dev server 而不是占位页：',
                '#   NEXT_PUBLIC_MICROSITE_LOCAL_MODE=true',
                '#   NEXT_PUBLIC_MICROSITE_PLACEHOLDER=false',
              ].join('\n')}
            </pre>
          </section>
        </>
      ) : (
        <section className="ph-run">
          <h2>未匹配到花名册条目</h2>
          <p className="ph-desc">
            URL 里的 <code className="mono">id</code> 参数
            {raw.id ? <span className="mono"> 「{raw.id}」</span> : '（缺失）'}
            不在 <code className="mono">specs/microsites.json</code> 登记的 18 个微站里。
            请检查链接是否拼错，或该站是否尚未登记。
          </p>
          <pre className="ph-code mono">
            {'# 已登记站点 id：01 ~ 18\npnpm gen:site --emit-registry'}
          </pre>
        </section>
      )}

      <footer className="ph-foot">
        <span className="mono">orbital-hub · 占位页路由</span>
        <span>
          接真实微站：设 <span className="mono">NEXT_PUBLIC_MICROSITE_PLACEHOLDER=false</span>
        </span>
      </footer>
    </main>
  );
}