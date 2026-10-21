/**
 * 学职平台内容浏览器 —— 把 xz.chsi.com.cn 的职业人物 / 专业目录 / 职业分类
 * 接进本站的「期望决策树」，让路径推演有真实参照系。
 *
 * 为什么是客户端筛选：本微站要能静态导出（output: export，见 docs/02-engineering/
 * 05-static-export-notes.md），而 searchParams 在静态导出下不可用。数据量
 * 1778 + 722 条、1.37MB JSON，全量进浏览器后本地筛选比多一轮网络往返更快，
 * 也让「筛选态」能进 URL 之外的交互（如键盘翻页）。
 *
 * 合规：数据来自教育部学职平台公开接口。职业案例正文受原站登录墙保护，
 * 此处只展示公开列表里的一句话履历摘要；专业介绍为原站长文本，
 * 故每个条目都带「原站查看」回链，并在页脚标注来源。
 */
'use client';

import './xz-explorer.css';
import { useCallback, useMemo, useState } from 'react';
import { useSpecHeavyDetail } from '../lib/use-heavy-detail';
import {
  filterCases,
  filterSpecialities,
  fmtNum,
  facultyIndex,
  occupationGroupsWithCounts,
  paginate,
  sortSpecialities,
  XZ_CASES,
  XZ_CASES_HOME,
  XZ_META,
  XZ_SPECIALITIES_HOME,
  xzSpecialityUrl,
  type SpecSort,
  type XzCase,
  type XzSpeciality,
} from '../lib/xz-data';

const PER_PAGE = 12;

type Tab = 'cases' | 'specs' | 'occupations';

const TABS: readonly { id: Tab; label: string; hint: string }[] = [
  { id: 'cases', label: '职业人物', hint: '真实从业者的院校·专业·现职' },
  { id: 'specs', label: '专业目录', hint: '门类 → 专业类 → 专业，含满意度' },
  { id: 'occupations', label: '职业分类', hint: '28 大类下的具体职业' },
];

export function XzExplorer() {
  const [tab, setTab] = useState<Tab>('cases');

  return (
    <section className="xz-explorer" aria-label="学职平台内容">
      <header className="xz-explorer-head">
        <div className="xz-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className="xz-tab"
              data-active={tab === t.id ? 'true' : 'false'}
              onClick={() => setTab(t.id)}
              title={t.hint}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="xz-src mono">
          数据源 · 学职平台 {XZ_META.cases.total} 案例 / {XZ_META.specialities.total} 专业
        </span>
      </header>

      {tab === 'cases' ? <CaseBrowser /> : null}
      {tab === 'specs' ? <SpecBrowser /> : null}
      {tab === 'occupations' ? <OccupationBrowser /> : null}
    </section>
  );
}

/* ── 职业人物 ─────────────────────────────────────────────────────────── */

function CaseBrowser() {
  const [industry, setIndustry] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  const industries = useMemo(() => caseIndustries(), []);
  const filtered = useMemo(
    () => filterCases({ industry, q }),
    [industry, q],
  );
  const paged = useMemo(() => paginate(filtered, page, PER_PAGE), [filtered, page]);

  const reset = useCallback((fn: () => void) => {
    fn();
    setPage(1);
  }, []);

  return (
    <div className="xz-panel">
      <div className="xz-controls">
        <input
          className="xz-input"
          type="search"
          placeholder="搜索院校 / 专业 / 岗位…"
          value={q}
          onChange={(e) =>
            reset(() => {
              setQ(e.target.value);
            })
          }
          aria-label="搜索职业人物"
        />
        <select
          className="xz-select"
          value={industry ?? ''}
          aria-label="按行业筛选"
          onChange={(e) =>
            reset(() => {
              setIndustry(e.target.value || null);
            })
          }
        >
          <option value="">全部行业</option>
          {industries.map((i) => (
            <option key={i.name} value={i.name}>
              {i.name}（{i.count}）
            </option>
          ))}
        </select>
        <span className="xz-count mono">
          {fmtNum(paged.total)} 例
        </span>
      </div>

      <ul className="xz-case-list">
        {paged.items.map((c) => (
          <CaseCard
            key={c.id}
            c={c}
            open={openId === c.id}
            onToggle={() => setOpenId(openId === c.id ? null : c.id)}
          />
        ))}
      </ul>

      {paged.total === 0 ? (
        <p className="xz-empty">没有匹配的职业人物。换个关键词或清掉行业筛选。</p>
      ) : null}

      <Pager paged={paged} onPage={setPage} />

      <p className="xz-note">
        原站职业案例正文需学信网账号登录，本站仅收录公开列表中的一句话履历摘要，未绕过登录墙。
        <a className="xz-link" href={XZ_CASES_HOME} target="_blank" rel="noopener noreferrer">
          到原站查看全部
        </a>
      </p>
    </div>
  );
}

function CaseCard({
  c,
  open,
  onToggle,
}: {
  readonly c: XzCase;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <li className="xz-case" data-open={open ? 'true' : 'false'}>
      <button type="button" className="xz-case-main" onClick={onToggle} aria-expanded={open}>
        <span className="xz-case-summary">{c.summary}</span>
        <span className="xz-case-tags">
          {c.industry ? <span className="xz-tag">{c.industry}</span> : null}
          {c.province ? <span className="xz-tag xz-tag-geo">{c.province}</span> : null}
          {c.recommended ? <span className="xz-tag xz-tag-star">推荐</span> : null}
        </span>
      </button>
      {open ? (
        <div className="xz-case-detail">
          <dl className="xz-kv">
            <div>
              <dt>现职岗位</dt>
              <dd>{c.role || '—'}</dd>
            </div>
            <div>
              <dt>职业大类</dt>
              <dd>{c.group || '—'}</dd>
            </div>
            <div>
              <dt>所在行业</dt>
              <dd>{c.industry || '—'}</dd>
            </div>
            <div>
              <dt>点赞 / 收藏</dt>
              <dd className="mono">
                {fmtNum(c.likes)} / {fmtNum(c.collects)}
              </dd>
            </div>
          </dl>
          <p className="xz-faint mono">
            原站未公开该案例正文（需登录）。案例 ID {c.id}
          </p>
        </div>
      ) : null}
    </li>
  );
}

function caseIndustries(): readonly { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const c of XZ_CASES) {
    if (c.industry) m.set(c.industry, (m.get(c.industry) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/* ── 专业目录 ─────────────────────────────────────────────────────────── */

function SpecBrowser() {
  const [faculty, setFaculty] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SpecSort>('popularity');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  const tree = useMemo(() => facultyIndex(), []);
  const categories = useMemo(() => {
    const node = tree.find((f) => f.faculty === faculty);
    return node?.categories ?? [];
  }, [tree, faculty]);

  const filtered = useMemo(() => {
    const list = filterSpecialities({ faculty, category, q });
    return sortSpecialities(list, sort);
  }, [faculty, category, q, sort]);

  const paged = useMemo(() => paginate(filtered, page, PER_PAGE), [filtered, page]);

  return (
    <div className="xz-panel">
      <div className="xz-controls">
        <input
          className="xz-input"
          type="search"
          placeholder="搜索专业名 / 代码…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          aria-label="搜索专业"
        />
        <select
          className="xz-select"
          value={faculty ?? ''}
          aria-label="按门类筛选"
          onChange={(e) => {
            setFaculty(e.target.value || null);
            setCategory(null);
            setPage(1);
          }}
        >
          <option value="">全部门类</option>
          {tree.map((f) => (
            <option key={f.faculty} value={f.faculty}>
              {f.faculty}（{f.total}）
            </option>
          ))}
        </select>
        <select
          className="xz-select"
          value={category ?? ''}
          aria-label="按专业类筛选"
          disabled={!faculty}
          onChange={(e) => {
            setCategory(e.target.value || null);
            setPage(1);
          }}
        >
          <option value="">{faculty ? '全部专业类' : '先选门类'}</option>
          {categories.map((c) => (
            <option key={c.category} value={c.category}>
              {c.category}（{c.specs.length}）
            </option>
          ))}
        </select>
        <select
          className="xz-select"
          value={sort}
          aria-label="排序方式"
          onChange={(e) => setSort(e.target.value as SpecSort)}
        >
          <option value="popularity">按评价人数</option>
          <option value="recommended">按推荐指数榜</option>
          <option value="score">按满意度</option>
          <option value="code">按专业代码</option>
        </select>
        <span className="xz-count mono">{fmtNum(paged.total)} 个</span>
      </div>

      <ul className="xz-spec-list">
        {paged.items.map((s) => (
          <SpecRow
            key={s.specId}
            s={s}
            open={openId === s.specId}
            onToggle={() => setOpenId(openId === s.specId ? null : s.specId)}
          />
        ))}
      </ul>

      {paged.total === 0 ? <p className="xz-empty">没有匹配的专业。</p> : null}

      <Pager paged={paged} onPage={setPage} />

      <p className="xz-note">
        专业介绍、满意度与课程体系数据来自学职平台「专业洞察」，
        统计截止 {XZ_META.specialities.statYear} 年，采集于 {XZ_META.collectedAt.slice(0, 10)}。
        <a
          className="xz-link"
          href={XZ_SPECIALITIES_HOME}
          target="_blank"
          rel="noopener noreferrer"
        >
          原站数据说明
        </a>
        。{XZ_META.specialities.total} 个专业已全部采得详情，但字段级覆盖不均：
        专业介绍 {XZ_META.specialities.fieldCoverage.intro}%、课程投票 {XZ_META.specialities.fieldCoverage.courses}%、
        学长建议 {XZ_META.specialities.fieldCoverage.juniorAdvice}%（冷门专业无人投票或无人留言属正常）。
        男女比例原站未登录不返回（覆盖 {XZ_META.specialities.fieldCoverage.gender}%），本站不展示。
      </p>
    </div>
  );
}

function SpecRow({
  s,
  open,
  onToggle,
}: {
  readonly s: XzSpeciality;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const d = s.detail;
  /*
   * 重字段（长文本/课程/建议）走独立异步 chunk，只在展开这一行时才下载。
   * hook 必须无条件调用，所以用参数传 null 表示「收起状态不需要」。
   */
  const { detail: hd, loading: hdLoading } = useSpecHeavyDetail(open ? s.specId : null);
  return (
    <li className="xz-spec" data-open={open ? 'true' : 'false'}>
      <button type="button" className="xz-spec-main" onClick={onToggle} aria-expanded={open}>
        <span className="xz-spec-rank mono">
          {s.rankRecommended != null ? '#' + s.rankRecommended : '—'}
        </span>
        <span className="xz-spec-name">{s.name}</span>
        <span className="xz-spec-code mono">{s.code}</span>
        <span className="xz-spec-cat">
          {s.faculty} · {s.category}
        </span>
        <span className="xz-spec-score mono" title="综合满意度">
          {s.evlScore != null ? s.evlScore.toFixed(1) : '—'}
        </span>
        <span className="xz-spec-evl mono" title="评价人数">
          {fmtNum(s.evlCount)}
        </span>
        {d ? <span className="xz-tag xz-tag-deep">详情</span> : null}
      </button>

      {open ? (
        <div className="xz-spec-detail">
          {hd?.intro ? <p className="xz-intro">{hd.intro}</p> : null}

          {/*
            三分支必须分清：chunk 未到达（hdLoading）≠ 该专业没有详情。
            若只写 d && hd，首次展开会闪一下「无详情」的错误结论。
          */}
          {d && hdLoading ? (
            <p className="xz-faint mono">正在载入该专业的详细数据（首次展开需下载一次，之后即时）…</p>
          ) : d && hd ? (
            <>
              <dl className="xz-kv xz-kv-4">
                <div>
                  <dt>毕业规模</dt>
                  <dd>{d.gradScale ?? '—'}</dd>
                </div>
                <div>
                  <dt>培养层次</dt>
                  <dd>{s.level}</dd>
                </div>
                <div>
                  <dt>热度榜</dt>
                  <dd className="mono">#{s.rankPopularity}</dd>
                </div>
                <div>
                  <dt>统计年度</dt>
                  <dd className="mono">{d.year ?? '—'}</dd>
                </div>
              </dl>

              <div className="xz-sat">
                {(
                  [
                    ['综合', d.satisfaction.overall],
                    ['办学条件', d.satisfaction.condition],
                    ['教学质量', d.satisfaction.teaching],
                    ['就业', d.satisfaction.employment],
                  ] as const
                ).map(([label, v]) => (
                  <div key={label} className="xz-sat-row">
                    <span className="xz-sat-label">{label}</span>
                    <span className="xz-sat-bar" aria-hidden="true">
                      <span
                        className="xz-sat-fill"
                        style={{ width: v ? `${(v.rank / 5) * 100}%` : '0%' }}
                      />
                    </span>
                    <span className="xz-sat-num mono">
                      {v ? `${v.rank.toFixed(1)} · ${fmtNum(v.count)}人` : '—'}
                    </span>
                  </div>
                ))}
              </div>

              {hd.courses.length > 0 ? (
                <div className="xz-courses">
                  <h3 className="xz-sub-h">核心课程（按讨论热度）</h3>
                  <ul>
                    {hd.courses.map((c) => (
                      /*
                       * key 含 type：同名不同 type 是两条真实记录（实测 6 个专业有，
                       * 如「现代汉语」type 1 与 19，votes 分别 229 / 130）。
                       * type 的语义原站未文档化，故不显示也不翻译 —— 但两行的
                       * 票数本就不同，用户看到的是可区分的数据，不是重复行。
                       */
                       <li key={c.name + "#t" + (c.type ?? "-")} className="xz-course">
                         <span className="xz-course-name">{c.name}</span>
                        <span className="xz-course-metric mono" title="难度">
                          难 {c.difficulty ?? '—'}
                        </span>
                        <span className="xz-course-metric mono" title="实用度">
                          用 {c.practicality ?? '—'}
                        </span>
                        <span className="xz-course-metric mono" title="讨论热度（难度票+实用票）">
                          {fmtNum(c.votes)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {hd.related.length > 0 ? (
                <p className="xz-related">
                  <span className="xz-sub-h">同专业类专业</span>{' '}
                  {hd.related.map((r) => (
                    <span key={r} className="xz-tag">
                      {r}
                    </span>
                  ))}
                </p>
              ) : null}

              {hd.juniorAdvice.length > 0 ? (
                <div className="xz-advice">
                  <h3 className="xz-sub-h">学长学姐说</h3>
                  <ul>
                    {hd.juniorAdvice.map((a) => (
                      /*
                       * key 用 advice+school+year：同一段话可能出自不同院校
                       * 的不同学生（实测同专业内有 2 处文本重复，分属
                       * 河北农业大学 / 广州商学院），都是真实记录不能去重。
                       * 该复合键已实测在 1778 条全量里零冲突。
                       */
                      <li
                        key={a.advice + '#' + (a.school ?? '-') + '#' + (a.year ?? '-')}
                        className="xz-advice-item"
                      >
                        <span className="xz-advice-text">「{a.advice}」</span>
                        <span className="xz-advice-meta mono">
                          {a.school ?? '匿名院校'}
                          {a.year ? ` · ${a.year} 级` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : (
            <p className="xz-faint">
              该专业的详情字段在原站即为空（专业级详情已全量采集，
              但介绍 {XZ_META.specialities.fieldCoverage.intro}%、
              课程 {XZ_META.specialities.fieldCoverage.courses}%、
              建议 {XZ_META.specialities.fieldCoverage.juniorAdvice}% 是字段级覆盖率）。
            </p>
          )}

          <a
            className="xz-link"
            href={xzSpecialityUrl(s.specId)}
            target="_blank"
            rel="noopener noreferrer"
          >
            在原站查看「{s.name}」完整洞察 →
          </a>
        </div>
      ) : null}
    </li>
  );
}

/* ── 职业分类 ─────────────────────────────────────────────────────────── */

function OccupationBrowser() {
  const groups = useMemo(() => occupationGroupsWithCounts(), []);
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="xz-panel">
      <p className="xz-faint">
        学职平台「职业人物」栏目按 {XZ_META.occupations.groups} 个职业大类组织，其下共 {XZ_META.occupations.total} 个具体职业。
        案例数是本站已采集到的真实从业者样本量 —— 样本越厚，该方向的参照越可靠。
      </p>
      <ul className="xz-group-list">
        {groups.map(({ group, caseCount }) => {
          const open = openId === group.ktId;
          return (
            <li key={group.ktId} className="xz-group" data-open={open ? 'true' : 'false'}>
              <button
                type="button"
                className="xz-group-main"
                onClick={() => setOpenId(open ? null : group.ktId)}
                aria-expanded={open}
              >
                <span className="xz-group-name">{group.ktName}</span>
                <span className="xz-group-count mono">
                  {group.occupations.length} 职业 · {caseCount} 案例
                </span>
              </button>
              {open ? (
                <div className="xz-group-detail">
                  <div className="xz-occ-pills">
                    {group.occupations.map((o) => (
                      <span key={o.id} className="xz-tag">
                        {o.name}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ── 共用 ─────────────────────────────────────────────────────────────── */

interface Paged<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly totalPages: number;
  readonly total: number;
}

function Pager<T>({
  paged,
  onPage,
}: {
  readonly paged: Paged<T>;
  readonly onPage: (n: number) => void;
}) {
  if (paged.totalPages <= 1) return null;
  return (
    <nav className="xz-pager" aria-label="分页">
      <button
        type="button"
        className="xz-page-btn"
        disabled={paged.page <= 1}
        onClick={() => onPage(paged.page - 1)}
      >
        ← 上一页
      </button>
      <span className="xz-page-info mono">
        {paged.page} / {paged.totalPages}
      </span>
      <button
        type="button"
        className="xz-page-btn"
        disabled={paged.page >= paged.totalPages}
        onClick={() => onPage(paged.page + 1)}
      >
        下一页 →
      </button>
    </nav>
  );
}
