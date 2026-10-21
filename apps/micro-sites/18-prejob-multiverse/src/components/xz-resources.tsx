/**
 * 原站专题与职业测评目录。
 *
 * 为什么单独成组件：这两批数据（xz-topics.json 9 条、xz-assessments.json 14 项）
 * 早已随 build-dataset 落盘，却**没有任何地方渲染** —— 属于「数据采到了但没人消费」。
 * 专题卡片正是学职平台首页最显眼的内容块，对正在纠结升学的学生是低门槛入口。
 *
 * 体积：两者合计 11KB，可静态 import（不像 539KB 的重 detail 必须懒加载）。
 *
 * 合规：
 *  - 专题摘要与测评简介都是**原站创作文本**，故每条都带原站回链，
 *    且摘要已在 build-dataset 阶段截断到 200 字，不整篇搬运。
 *  - 测评只列名称、分类与一句话简介。**题目、选项、计分规则、常模一律未采集**
 *    （量表由平台联合北大 / 北师大 / 南师大编制，属受保护的心理测量工具），
 *    所以这里也不可能有「在线做题」—— 想测只能回原站。
 */
'use client';

/*
 * 'use client' 不只是因为交互：本组件从 xz-data.ts 取数据，而该模块顶层
 * import 了 918KB 的专业集。AnchorPanel / XzExplorer 已是 client 并共享同一模块，
 * 浏览器那个 chunk 本来就要下载；若本组件留在 server 端，
 * 同一份数据会被再打进 server bundle 渲染一遍，白白多占服务端内存与构建产物。
 * 标成 client 后直接复用浏览器已加载的模块实例。
 */
import './xz-resources.css';

import { XZ_ASSESSMENTS, XZ_META, XZ_TOPICS, type XzAssessment } from '../lib/xz-data';

/** 按分类分组，保持原站给出的分类顺序（首次出现序）。 */
function groupByCatalog(
  list: readonly XzAssessment[],
): readonly { catalog: string; items: readonly XzAssessment[] }[] {
  const order: string[] = [];
  const map = new Map<string, XzAssessment[]>();
  for (const a of list) {
    const key = a.catalog ?? '未分类';
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key)!.push(a);
  }
  return order.map((catalog) => ({ catalog, items: map.get(catalog) ?? [] }));
}

export function XzResources() {
  const groups = groupByCatalog(XZ_ASSESSMENTS);

  return (
    <section className="xzres" aria-label="原站专题与测评">
      <header className="xzres-head">
        <h2 className="xzres-h2">原站专题</h2>
        <span className="xzres-meta mono">
          {XZ_TOPICS.length} 个 · 学职平台编辑整理 · 全文在原站
        </span>
      </header>

      {XZ_TOPICS.length ? (
        <ul className="xzres-topics">
          {XZ_TOPICS.map((t) => (
            <li key={t.url ?? t.title} className="xzres-topic">
              <a
                className="xzres-topic-link"
                href={t.url ?? XZ_META.homeUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t.imageUrl ? (
                  <img
                    className="xzres-topic-img"
                    src={t.imageUrl}
                    alt=""
                    loading="lazy"
                    width={160}
                    height={90}
                  />
                ) : (
                  <span className="xzres-topic-img xzres-topic-img-none" aria-hidden="true" />
                )}
                <span className="xzres-topic-body">
                  <span className="xzres-topic-title">
                    {t.title}
                    {t.top ? <span className="xzres-badge">置顶</span> : null}
                  </span>
                  {t.summary ? <span className="xzres-topic-sum">{t.summary}</span> : null}
                  <span className="xzres-topic-meta mono">
                    {t.date ?? '日期未提供'} · 原站阅读
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="xzres-empty mono">未取到专题数据。</p>
      )}

      <header className="xzres-head xzres-head-gap">
        <h2 className="xzres-h2">职业测评目录</h2>
        <span className="xzres-meta mono">
          {XZ_ASSESSMENTS.length} 项 · 仅目录，题目与计分未采集
        </span>
      </header>

      <div className="xzres-catalog">
        {groups.map((g) => (
          <div key={g.catalog} className="xzres-group">
            <h3 className="xzres-group-h">
              {g.catalog}
              <span className="mono xzres-group-n">{g.items.length}</span>
            </h3>
            <ul className="xzres-items">
              {g.items.map((a) => (
                <li key={a.title} className="xzres-item">
                  <a href={a.url} target="_blank" rel="noopener noreferrer" className="xzres-item-a">
                    <span className="xzres-item-t">{a.title}</span>
                    {a.desc ? <span className="xzres-item-d">{a.desc}</span> : null}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="xzres-note">
        测评量表由学职平台联合北大、北师大、南师大等高校专家编制，题目、选项、计分规则与常模
        属受著作权保护的心理测量内容，本站<b>未采集也不提供在线作答</b>，
        仅列名称与简介作为索引。想做测评请
        <a
          className="xzres-link"
          href="https://xz.chsi.com.cn/survey/index.action"
          target="_blank"
          rel="noopener noreferrer"
        >
          前往原站
        </a>
        。
      </p>
    </section>
  );
}
