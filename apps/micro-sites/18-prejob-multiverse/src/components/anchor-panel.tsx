/**
 * 专业锚定面板 —— 把学职平台真实数据接进「期望决策树」的对照面。
 *
 * 为什么放在页面层而不是改 site-instrument.tsx：那个渲染器是 18 站共享的，
 * 为一个站的数据接入去动它，等于让 18 号站的需求污染公共文件。
 *
 * 为什么这不是「数据驱动改造」：学职平台**没有薪资数据**。
 * 若把满意度乘进 CAREER_PATHS 的期望收益，就把假的 85 万伪装成了数据驱动 ——
 * 那是编造。所以真实数据在这里只做三件事：
 *   1. 呈现该专业的真实满意度 / 毕业规模 / 课程难度 / 开设院校数；
 *   2. 用原站真实文本（学长学姐建议）给定性参考；
 *   3. 明确标注「收益数字是模型假设，不含薪资数据」，把边界说破。
 */
'use client';

import './anchor-panel.css';

import { useMemo, useState } from 'react';

import { useSpecHeavyDetail } from '../lib/use-heavy-detail';
import {
  filterSpecialities,
  fmtNum,
  occupationVideo,
  sortSpecialities,
  XZ_META,
  xzSpecialityUrl,
  xzVideoUrl,
  type XzFlow,
  type XzSatisfaction,
  type XzSpeciality,
} from '../lib/xz-data';

/**
 * 毕业生去向对照面板。
 *
 * 为什么放在锚定面板里：决策树三条路径的 `probabilities.success`
 * （如「推免直博 62%」）是 **MatrixOS 模型假设**，此前没有任何真实参照。
 * 这里补上原站的实际去向占比，让用户能自己对照 —— 但两者**不做任何算术合并**：
 * 「7% 的毕业生选择考研」是去向占比，「62%」是模型估的成功概率，
 * 量纲不同，相乘或平均都是编造。所以下方诚实边界块仍独立说明这一点。
 *
 * 数据来源：`byfzVo.expOccList` / `occList` / `advances` / `byfzCyfxList`，
 * 实测 741/1778 个专业有；冷门专业原站就没有，此时显示缺口而不是补零。
 */
function FlowBlock({ flow }: { readonly flow: XzFlow | undefined }) {
  if (!flow) {
    return (
      <p className="anchor-note mono">
        原站没有该专业的毕业去向统计（冷门专业常缺失）。本站不推测、不补零 ——
        上方路径概率是 MatrixOS 模型假设，与真实去向无关。
      </p>
    );
  }

  const paths = flow.paths ? Object.entries(flow.paths) : [];
  const occ = flow.occTop ?? [];
  const maxPct = occ.length ? Math.max(...occ.map((o) => o.pct)) : 0;

  return (
    <div className="anchor-flow">
      <h3 className="anchor-h">原站真实毕业去向（非本站推算）</h3>

      {paths.length ? (
        <ul className="anchor-flow-paths">
          {paths.map(([k, v]) => (
            <li key={k} className="anchor-flow-path">
              <span className="anchor-flow-name">{k}</span>
              <span className="mono anchor-flow-pct">{v}%</span>
              <span className="anchor-flow-cap mono">该专业毕业生选此项的比例</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="anchor-flow-none mono">
          原站未给出考研／公务员等路径型占比（该专业只有职业流向数据）。
        </p>
      )}

      {occ.length ? (
        <div className="anchor-flow-occ">
          <span className="anchor-flow-sub mono">
            主要职业流向 top{occ.length}（占比之和不足 100%，原站只列头部）
          </span>
          {occ.map((o) => {
            /*
             * 视频按原站 zhiyId 查，不按职业名 —— 视频「中学教师」与流向里的
             * 「初中教师」名字不同但共享原站同一个 id，按名字匹配会漏掉这类
             * （实测 id 口径 60.6%，名字口径仅 12.7%）。
             * 查不到就不渲染，不放占位、不猜最近似的视频。
             */
            const vid = occupationVideo(o.zhiyId);
            return (
              <div key={o.name} className="anchor-flow-row">
                <span className="anchor-flow-name">
                  {o.name}
                  {vid ? (
                    <a
                      className="anchor-flow-video"
                      href={xzVideoUrl(vid.videoId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`原站视频《${vid.title}》${vid.duration ? ' · ' + vid.duration : ''}`}
                    >
                      视频{vid.duration ? ` ${vid.duration}` : ''}
                    </a>
                  ) : null}
                </span>
                <span className="anchor-flow-bar" aria-hidden="true">
                  <span
                    className="anchor-flow-fill"
                    style={{ width: maxPct ? `${(o.pct / maxPct) * 100}%` : '0%' }}
                  />
                </span>
                <span className="mono anchor-flow-pct">{o.pct.toFixed(1)}%</span>
              </div>
            );
          })}
        </div>
      ) : null}

      {flow.advances?.length ? (
        <p className="anchor-flow-inline">
          <span className="anchor-flow-sub mono">升学可报学科</span>{' '}
          {flow.advances.map((a) => (
            /*
             * 同名不同 code 是**两个不同的研究生学科**（实测 31 个专业有），
             * 例如「临床医学」100200 学术型 与 105100 专业型。
             * 所以 key 用 name+code，且把 code 显示出来 —— 只显示名字会渲染出
             * 两个一模一样的标签，用户无法区分，也看不出这是两个学科。
             */
            <span key={a.name + '#' + (a.code ?? '-')} className="xz-tag">
              {a.name}
              {a.code ? <span className="xz-tag-code mono">{a.code}</span> : null}
            </span>
          ))}
        </p>
      ) : null}

      {flow.industries?.length ? (
        <p className="anchor-flow-inline">
          <span className="anchor-flow-sub mono">从业行业</span>{' '}
          {flow.industries.map((i) => (
            <span key={i} className="xz-tag">
              {i}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

export function AnchorPanel() {
  const [spec, setSpec] = useState<XzSpeciality | null>(null);
  const [q, setQ] = useState('');

  // 热门专业取评价人数前 8 —— 从数据派生，不硬编码专业名单。
  // 显式排序而非依赖 filterSpecialities 的返回顺序：那个顺序是 phb1 榜单序，
  // 属于数据集实现细节，不该被 UI 隐式依赖。
  const popular = useMemo(() => sortSpecialities(filterSpecialities({}), 'popularity').slice(0, 8), []);
  const matched = useMemo(() => (q.trim() ? filterSpecialities({ q }) : []), [q]);

  const d = spec?.detail;
  /*
   * 重字段（长文本/课程/建议）走独立异步 chunk，选中某专业时才下载。
   * hook 无条件调用，用参数传 null 表达「还没选专业」。
   */
  const { detail: hd, loading: hdLoading } = useSpecHeavyDetail(spec ? spec.specId : null);
  // 显式过滤掉 null 维度，比类型谓词写法更清楚（谓词要复刻元组字面量类型，易错）。
  const satRows: readonly { label: string; v: XzSatisfaction }[] = d
    ? [
        { label: '综合', v: d.satisfaction.overall },
        { label: '办学条件', v: d.satisfaction.condition },
        { label: '教学质量', v: d.satisfaction.teaching },
        { label: '就业', v: d.satisfaction.employment },
      ].filter((r): r is { label: string; v: XzSatisfaction } => r.v != null)
    : [];

  return (
    <section className="anchor glass-panel" aria-label="专业锚定参考">
      <header className="anchor-head">
        <h2 className="anchor-title">先锚定你的专业，再对照路径推演</h2>
        <p className="anchor-sub mono">
          真实数据源 学职平台 · {fmtNum(XZ_META.specialities.total)} 个专业 ·{' '}
          统计截止 {XZ_META.specialities.statYear ?? '—'} 年
        </p>
      </header>

      {!spec ? (
        <div className="anchor-pick">
          <input
            className="anchor-input"
            type="search"
            placeholder="搜索专业名或代码（如 会计学 / 120203）"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="搜索专业以锚定参考面板"
          />
          <div className="anchor-chips">
            <span className="anchor-chips-label mono">热门</span>
            {popular.map((s) => (
              <button key={s.specId} type="button" className="anchor-chip" onClick={() => setSpec(s)}>
                {s.name}
              </button>
            ))}
          </div>
          {q.trim() ? (
            <ul className="anchor-results">
              {matched.slice(0, 10).map((s) => (
                <li key={s.specId}>
                  <button type="button" className="anchor-result" onClick={() => setSpec(s)}>
                    <span>{s.name}</span>
                    <span className="mono anchor-result-meta">
                      {s.code} · {s.faculty ?? '—'} · {fmtNum(s.evlCount)} 人评价
                    </span>
                  </button>
                </li>
              ))}
              {matched.length === 0 ? <li className="anchor-empty mono">没找到匹配的专业</li> : null}
            </ul>
          ) : null}
        </div>
      ) : (
        <div className="anchor-body">
          <div className="anchor-spec-head">
            <div>
              <span className="anchor-spec-name">{spec.name}</span>
              <span className="mono anchor-spec-meta">
                {spec.code} · {spec.faculty ?? '—'} / {spec.category ?? '—'} · {spec.level ?? '—'}
              </span>
            </div>
            <button type="button" className="anchor-change" onClick={() => { setSpec(null); setQ(''); }}>
              换专业
            </button>
          </div>

          {!d ? (
            <p className="anchor-note mono">
              该专业缺目录级统计（原站数据本身有缺口，非本站未采集）。
              满意度 {spec.evlScore ?? '—'} · {fmtNum(spec.evlCount)} 人评价。
            </p>
          ) : null}

          {satRows.length ? (
            <div className="anchor-sat">
              {satRows.map(({ label, v }) => (
                <div key={label} className="anchor-sat-row">
                  <span className="anchor-sat-label">{label}</span>
                  <span className="anchor-sat-bar" aria-hidden="true">
                    <span className="anchor-sat-fill" style={{ width: `${(v.rank / 5) * 100}%` }} />
                  </span>
                  <span className="mono anchor-sat-num">
                    {v.rank.toFixed(1)} · {fmtNum(v.count)} 人
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {d ? (
            <dl className="anchor-facts">
              <div>
                <dt>毕业规模</dt>
                <dd>{d.gradScale ?? '—'}</dd>
              </div>
              <div>
                <dt>开设院校</dt>
                <dd>{d.offerCount != null ? `${d.offerCount} 所` : '—'}</dd>
              </div>
              <div>
                <dt>统计年度</dt>
                <dd className="mono">{d.year ?? '—'}</dd>
              </div>
              <div>
                <dt>热度榜</dt>
                <dd className="mono">#{spec.rankPopularity}</dd>
              </div>
            </dl>
          ) : null}

          {hdLoading ? (
            <p className="anchor-note mono">正在载入长文本与课程数据（首次选择需下载一次）…</p>
          ) : null}

          {hd?.courses.length ? (
            <div className="anchor-courses">
              <h3 className="anchor-h">最难的课（原站学生投票）</h3>
              <ul>
                {hd.courses.slice(0, 3).map((c) => (
                  /* key 含 type：同名不同 type 是两条真实记录（见 xz-explorer 同处注释） */
                  <li key={c.name + '#t' + (c.type ?? '-')} className="anchor-course">
                    <span>{c.name}</span>
                    <span className="mono anchor-course-m">
                      难度 {c.difficulty ?? '—'} · 实用 {c.practicality ?? '—'} · {fmtNum(c.votes)} 票
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {hd?.juniorAdvice.length ? (
            <div className="anchor-advice">
              <h3 className="anchor-h">学长学姐怎么说（原站真实文本）</h3>
              <ul>
                {hd.juniorAdvice.slice(0, 3).map((a) => (
                  /* 复合键，理由同 xz-explorer：同话可能出自不同院校学生 */
                  <li key={a.advice + '#' + (a.school ?? '-') + '#' + (a.year ?? '-')}>
                    「{a.advice}」
                    <span className="mono anchor-advice-meta">
                      {a.school ?? '匿名'}
                      {a.year ? ` · ${a.year} 级` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* 毕业去向：原站真实统计，与下方模型假设并排但不合并 */}
          {hdLoading ? null : <FlowBlock flow={hd?.flow} />}

          <div className="anchor-bridge">
            <span className="anchor-bridge-tag mono">对照推演</span>
            <p>
              上方决策树的三条路径（保研直博 / 头部光企研发 / 选调考公）是{' '}
              <b>MatrixOS 模型假设，不是原站数据</b>。学职平台的薪资仅以图片渲染、
              接口不返回可解析数值，本站不做 OCR 或推算，
              所以期望收益不能声称由真实数据算出。
              把本面板当<b>参考</b>：毕业规模越大通常竞争越激烈、就业满意度偏低要留意、
              课程难度高意味着投入产出要自己权衡。
            </p>
            <a
              className="anchor-link"
              href={xzSpecialityUrl(spec.specId)}
              target="_blank"
              rel="noopener noreferrer"
            >
              在原站查看「{spec.name}」完整洞察 →
            </a>
          </div>
        </div>
      )}
    </section>
  );
}
