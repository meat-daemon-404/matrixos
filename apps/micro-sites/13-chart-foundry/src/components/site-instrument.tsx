/**
 * 微站仪器渲染器。
 *
 * 按站点 id 从共享数据包取出对应的仪器类型与 demo 数据，
 * 渲染为 instrument-ui 的真实组件。未实现的站点回落到占位 UI。
 *
 * 为什么集中在一处：18 个站的页面结构完全一致，只有仪器不同。
 * 写成一份比复制 18 份好维护——加一个仪器只改这里。
 *
 * 注意：本文件是 client component（仪器含交互与 canvas）。
 */
'use client';

import { useMemo, useState } from 'react';
import {
  DampedKnob,
  OscilloscopeCanvas,
  SonarDisc,
  FluidGaugeBank,
  PrecisionBalance,
  EvidenceLink,
  TaskKanban,
} from '@matrixos/instrument-ui';
import {
  SITE_INSTRUMENT,
  IMPLEMENTED_SITES,
  GRANT_COLUMNS,
  GRANT_TOTAL,
  PAT_HOT_ITEMS,
  MENTORS,
  KANBAN_COLUMNS,
  KANBAN_TASKS,
  PAPER_ROWS,
  curvelabPoints,
  REPRO_CHECKS,
  RETRACT_BLIPS,
  YUNHENG_PANS,
  YUNHENG_TOTAL,
  CV_ENTRIES,
  GPA_COURSES,
  weightedGpa,
  // 后 7 站
  TEAMMATES,
  SELF_SKILLS,
  SKILL_LABELS,
  CITATION_NODES,
  CITATION_EDGES,
  CITATION_SOURCES,
  EMAIL_DRAFTS,
  EMAIL_TIPS,
  FORMULAS,
  PDF_SNIPPETS,
  CHART_STYLES,
  REVIEW_CLUSTERS,
  REVIEW_OUTLINE,
  CAREER_PATHS,
  type InstrumentKind,
} from '@matrixos/microsite-data';

export interface SiteInstrumentProps {
  readonly siteId: string;
  /** 站点强调色（语义名，与 instrument-ui 的 accent 枚举一致） */
  readonly accent?: 'indigo' | 'cyan' | 'emerald' | 'amber' | 'rose' | 'violet';
}

/** 未实现站点的占位块：明确标注状态，不假装有功能。 */
function Placeholder({ siteId }: SiteInstrumentProps) {
  return (
    <div className="instrument-placeholder">
      <p>
        <strong>仪器开发中</strong>
      </p>
      <p className="mono">
        站点 {siteId} 的仪器尚未接入。骨架已就绪（SSO / 虫洞接收器 / 面板容器可用），
        等待实现专属仪器。
      </p>
    </div>
  );
}

/* ─────────────────────────── 各仪器实现 ─────────────────────────── */

function GpaPusher({ accent = 'indigo' }: SiteInstrumentProps) {
  const [courses, setCourses] = useState(GPA_COURSES);
  const current = weightedGpa(courses, false);
  const target = weightedGpa(courses, true);

  return (
    <div className="instrument gpa-pusher">
      <div className="instrument-head">
        <h2>学分绩点动态配重台</h2>
        <p>拖动推子模拟成绩变化，看对保研核心 GPA 的边际贡献。</p>
      </div>

      <div className="gpa-summary">
        <div className="gpa-stat">
          <span className="gpa-label">当前 GPA</span>
          <span className="gpa-value">{current.toFixed(2)}</span>
        </div>
        <div className="gpa-stat">
          <span className="gpa-label">目标 GPA</span>
          <span className="gpa-value accent">{target.toFixed(2)}</span>
        </div>
        <div className="gpa-stat">
          <span className="gpa-label">提升空间</span>
          <span className="gpa-value">+{(target - current).toFixed(2)}</span>
        </div>
      </div>

      <ul className="gpa-course-list">
        {courses.map((c, index) => (
          <li key={c.id} className="gpa-course">
            <div className="gpa-course-meta">
              <span className="gpa-course-name">
                {c.name}
                {c.core ? <span className="badge-core">核心</span> : null}
              </span>
              <span className="gpa-course-credits mono">{c.credits} 学分</span>
            </div>
            <div className="gpa-knobs">
              <DampedKnob
                label="当前"
                value={c.currentGrade}
                min={60}
                max={100}
                step={1}
                unit="分"
                size="sm"
                accent={accent}
                onChange={(v) => {
                  setCourses((prev) =>
                    prev.map((x, i) => (i === index ? { ...x, currentGrade: v } : x)),
                  );
                }}
              />
              <DampedKnob
                label="目标"
                value={c.targetGrade}
                min={60}
                max={100}
                step={1}
                unit="分"
                size="sm"
                accent="emerald"
                onChange={(v) => {
                  setCourses((prev) =>
                    prev.map((x, i) => (i === index ? { ...x, targetGrade: v } : x)),
                  );
                }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GrantGauge({ accent = 'amber' }: SiteInstrumentProps) {
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <div className="instrument grant-gauge">
      <div className="instrument-head">
        <h2>大创五科目经费液位仪</h2>
        <p>
          国创 ¥{GRANT_TOTAL.toLocaleString('zh-CN')} 专款专用监控 ·
          第五柱内置劳务费 ≤20% 强制限位阀
        </p>
      </div>
      <FluidGaugeBank
        columns={GRANT_COLUMNS}
        accent={accent}
        blockOnBreach
        onColumnHover={(col) => setHovered(col ? col.id : null)}
        formatValue={(v, col) => `${col.unit ?? ''}${v.toLocaleString('zh-CN')}`}
      />
      {hovered ? (
        <p className="instrument-hint mono">
          当前查看：{GRANT_COLUMNS.find((c) => c.id === hovered)?.label}
        </p>
      ) : (
        <p className="instrument-hint mono">悬停柱体查看明细 · 红线柱超标会自动阻断</p>
      )}
    </div>
  );
}

function PatRadar() {
  const [selected, setSelected] = useState<string | null>(PAT_HOT_ITEMS[0]?.id ?? null);
  const active = PAT_HOT_ITEMS.find((i) => i.id === selected) ?? PAT_HOT_ITEMS[0];

  return (
    <div className="instrument pat-radar">
      <div className="instrument-head">
        <h2>PAT-HOT 学科脉冲雷达</h2>
        <p>物理 · 天文 · 光电 24h 前沿监听 · 每日 08:00 三卡早报</p>
      </div>
      <ul className="pat-list">
        {PAT_HOT_ITEMS.map((item) => (
          <li
            key={item.id}
            className={'pat-item' + (item.id === selected ? ' active' : '')}
            onClick={() => setSelected(item.id)}
          >
            <div className="pat-item-head">
              <span className="pat-heat mono">🔥 {item.heat}</span>
              <span className="pat-source">{item.source}</span>
            </div>
            <p className="pat-title">{item.title}</p>
            <div className="pat-tags">
              {item.tags.map((t) => (
                <span key={t} className="tag">
                  {t}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {active ? (
        <div className="pat-detail">
          <p>{active.summary}</p>
          <EvidenceLink
            anchor={{
              sourceDoiOrUrl: active.doi,
              verificationLevel: 'Level_A_Verified',
            }}
            showDoi
          />
        </div>
      ) : null}
    </div>
  );
}

function MentorRadar({ accent = 'violet' }: SiteInstrumentProps) {
  const [selected, setSelected] = useState(MENTORS[0]?.id ?? '');
  const m = MENTORS.find((x) => x.id === selected) ?? MENTORS[0];
  const dims = m ? Object.entries(m.dimensions) : [];
  const DIM_LABEL: Record<string, string> = {
    activity: '近3年活跃度',
    hIndexSlope: 'H-index 斜率',
    funding: '经费充足度',
    undergradFriendly: '本科生友好度',
    directionFit: '方向契合度',
  };

  return (
    <div className="instrument mentor-radar">
      <div className="instrument-head">
        <h2>星门 · 导师五维星象仪</h2>
        <p>基于 OpenAlex 学术图谱量化画像 · 五维加权匹配</p>
      </div>
      <div className="mentor-tabs">
        {MENTORS.map((x) => (
          <button
            key={x.id}
            type="button"
            className={'mentor-tab' + (x.id === selected ? ' active' : '')}
            onClick={() => setSelected(x.id)}
          >
            <span className="mentor-name">{x.name}</span>
            <span className="mentor-score mono">{x.matchScore}%</span>
          </button>
        ))}
      </div>
      {m ? (
        <div className="mentor-body">
          <p className="mentor-affil">{m.affiliation}</p>
          <ul className="mentor-dims">
            {dims.map(([key, val]) => (
              <li key={key} className="mentor-dim">
                <span className="mentor-dim-label">{DIM_LABEL[key] ?? key}</span>
                <span className="mentor-dim-bar">
                  <span className="mentor-dim-fill" style={{ width: `${val}%` }} />
                </span>
                <span className="mentor-dim-val mono">{val}</span>
              </li>
            ))}
          </ul>
          <p className="instrument-hint mono">
            综合匹配 <strong>{m.matchScore}%</strong> · 各维置信度加权后得出
          </p>
        </div>
      ) : null}
      <DampedKnob label="匹配阈值" defaultValue={80} min={50} max={99} unit="%" size="sm" accent={accent} />
    </div>
  );
}

function LabKanban() {
  const [tasks, setTasks] = useState(KANBAN_TASKS);

  return (
    <div className="instrument lab-kanban">
      <div className="instrument-head">
        <h2>太空任务式进组跟进台账</h2>
        <p>已建档 → 已发信 → 已读待复 → 待面试 → 已进组 · 全周期追踪</p>
      </div>
      <TaskKanban
        columns={KANBAN_COLUMNS}
        tasks={tasks}
        missionCode="XINGMEN-2026"
        draggable
        onTaskMove={(task, toColumnId, fromColumnId) => {
          setTasks((prev) =>
            prev.map((t) => (t.id === task.id ? { ...t, columnId: toColumnId } : t)),
          );
          void fromColumnId;
        }}
      />
    </div>
  );
}

function MatrixCross() {
  const [selected, setSelected] = useState<string | null>(PAPER_ROWS[0]?.id ?? null);

  return (
    <div className="instrument matrix-cross">
      <div className="instrument-head">
        <h2>Matrix-Cross 跨论文对比矩阵</h2>
        <p>点击行触发 PDF 原文激光溯源 · 每个数值绑定页码与坐标</p>
      </div>
      <table className="cross-table">
        <thead>
          <tr>
            <th>顶刊文献</th>
            <th>钝化界面工程</th>
            <th>EQE 峰值</th>
            <th>PDF 证据锚点</th>
          </tr>
        </thead>
        <tbody>
          {PAPER_ROWS.map((row) => (
            <tr
              key={row.id}
              className={row.id === selected ? 'active' : ''}
              onClick={() => setSelected(row.id)}
            >
              <td className="mono">{row.venue}</td>
              <td>{row.strategy}</td>
              <td className="mono accent">{row.eqe}</td>
              <td>
                <EvidenceLink anchor={row.anchor} showDoi showBbox size="sm" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="instrument-hint mono">
        激光溯源已锁定 · 数值单元格与 PDF 坐标一一对应，杜绝大模型幻觉
      </p>
    </div>
  );
}

function CurveLab({ accent = 'emerald' }: SiteInstrumentProps) {
  const [noise, setNoise] = useState(1.2);
  const [tau1, setTau1] = useState(14.2);
  const [tau2, setTau2] = useState(89.5);
  const points = useMemo(() => curvelabPoints(180, 20261020, noise), [noise]);

  return (
    <div className="instrument curvelab">
      <div className="instrument-head">
        <h2>CurveLab 非线性拟合示波器</h2>
        <p>
          双指数衰减模型 · R² 随信噪比实时变化 · τ₁ = {tau1.toFixed(1)}ns / τ₂ ={' '}
          {tau2.toFixed(1)}ns
        </p>
      </div>

      <OscilloscopeCanvas
        points={points}
        phosphor
        showResiduals
        showConfidence
        confidenceLevel={0.95}
        xLabel="时间 t (ns)"
        yLabel="强度 I (a.u.)"
        title="TRPL 双指数衰减"
      />

      <div className="curvelab-knobs">
        <DampedKnob
          label="快衰减寿命 τ₁"
          value={tau1}
          min={1}
          max={50}
          step={0.1}
          unit="ns"
          accent={accent}
          onChange={setTau1}
        />
        <DampedKnob
          label="慢衰减寿命 τ₂"
          value={tau2}
          min={20}
          max={200}
          step={0.5}
          unit="ns"
          accent="cyan"
          onChange={setTau2}
        />
        <DampedKnob
          label="信噪比调控"
          value={noise}
          min={0.1}
          max={5}
          step={0.05}
          accent="amber"
          onChange={setNoise}
        />
      </div>
    </div>
  );
}

function ReproChecklist() {
  const TONE: Record<string, string> = { pass: 'ok', warn: 'warn', fail: 'bad' };
  const LABEL: Record<string, string> = { pass: '通过', warn: '警告', fail: '失败' };
  const passCount = REPRO_CHECKS.filter((c) => c.status === 'pass').length;

  return (
    <div className="instrument repro-checklist">
      <div className="instrument-head">
        <h2>顶刊代码复现核验舱</h2>
        <p>
          飞行前机械检查单 · {passCount}/{REPRO_CHECKS.length} 项通过
        </p>
      </div>
      <ul className="checklist">
        {REPRO_CHECKS.map((c) => (
          <li key={c.id} className="check-item" data-tone={TONE[c.status]}>
            <span className="check-icon" aria-hidden>
              {c.status === 'pass' ? '✓' : c.status === 'warn' ? '!' : '✗'}
            </span>
            <div className="check-body">
              <span className="check-name">{c.item}</span>
              <span className="check-detail">{c.detail}</span>
            </div>
            <span className="check-status mono">{LABEL[c.status]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RetractSonar({ accent = 'rose' }: SiteInstrumentProps) {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="instrument retract-sonar">
      <div className="instrument-head">
        <h2>撤稿深海声呐与伦理合规仪</h2>
        <p>Crossref + PubPeer 实时扫描 · 三级风险标注</p>
      </div>
      <SonarDisc
        blips={RETRACT_BLIPS}
        accent={accent}
        sweep
        accessibleTable
        onBlipClick={(b) => setSelected(b.id)}
      />
      <p className="instrument-hint mono">
        {selected
          ? RETRACT_BLIPS.find((b) => b.id === selected)?.label
          : '扫描中 · 点击声呐点查看详情'}
      </p>
    </div>
  );
}

function YunhengBalance({ accent = 'emerald' }: SiteInstrumentProps) {
  return (
    <div className="instrument yunheng-balance">
      <div className="instrument-head">
        <h2>云衡 · 数字天平综测核算器</h2>
        <p>自动对齐高校综测细则 · 满分上限强制配重</p>
      </div>
      <PrecisionBalance
        pans={YUNHENG_PANS}
        total={YUNHENG_TOTAL}
        totalLabel="总加分"
        accent={accent}
        animate
      />
      <p className="instrument-hint mono">
        综合评分 94.85（TOP 2%）· 科研成果已自动折算为配重砝码
      </p>
    </div>
  );
}

function EvidenceCv() {
  return (
    <div className="instrument evidence-cv">
      <div className="instrument-head">
        <h2>区块链级学术证据简历工坊</h2>
        <p>每条经历嵌入可点击验真的 DOI 锚点与仓库哈希</p>
      </div>
      <ul className="cv-list">
        {CV_ENTRIES.map((e) => (
          <li key={e.id} className="cv-entry">
            <div className="cv-entry-head">
              <span className="cv-title">{e.title}</span>
              <span className="cv-role">{e.role}</span>
            </div>
            <span className="cv-period mono">{e.period}</span>
            <div className="cv-anchors">
              {e.anchors.map((a, i) => (
                <EvidenceLink key={i} anchor={a} showDoi showBbox size="sm" />
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ────────────────── 后 7 站仪器 ────────────────── */

/** 02 · 双创互补组队雷达 —— 技能极坐标互补盘 */
function SparkRadar() {
  const [selected, setSelected] = useState(TEAMMATES[0]?.id ?? '');
  const tm = TEAMMATES.find((x) => x.id === selected) ?? TEAMMATES[0];
  const skillKeys = Object.keys(SELF_SKILLS) as Array<keyof typeof SELF_SKILLS>;

  return (
    <div className="instrument spark-radar">
      <div className="instrument-head">
        <h2>双创互补组队雷达</h2>
        <p>匹配跨院系互补队友 · 自动生成大创申报书初稿</p>
      </div>

      <div className="spark-self">
        <h3>我的技能画像</h3>
        <ul className="skill-bars">
          {skillKeys.map((k) => (
            <li key={k} className="skill-row">
              <span className="skill-label">{SKILL_LABELS[k]}</span>
              <span className="skill-track">
                <span className="skill-fill" style={{ width: `${SELF_SKILLS[k]}%` }} />
              </span>
              <span className="skill-val mono">{SELF_SKILLS[k]}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mentor-tabs">
        {TEAMMATES.map((x) => (
          <button
            key={x.id}
            type="button"
            className={'mentor-tab' + (x.id === selected ? ' active' : '')}
            onClick={() => setSelected(x.id)}
          >
            <span className="mentor-name">{x.name}</span>
            <span className="mentor-score mono">{x.complementScore}%</span>
          </button>
        ))}
      </div>

      {tm ? (
        <div className="spark-detail">
          <p className="mentor-affil">{tm.major}</p>
          <ul className="skill-bars">
            {skillKeys.map((k) => {
              const mine = SELF_SKILLS[k];
              const theirs = tm.skills[k];
              // 互补度 = 对方强于我 的差额
              const gain = Math.max(0, theirs - mine);
              return (
                <li key={k} className="skill-row">
                  <span className="skill-label">{SKILL_LABELS[k]}</span>
                  <span className="skill-track">
                    <span className="skill-fill theirs" style={{ width: `${theirs}%` }} />
                  </span>
                  <span className="skill-val mono">
                    {theirs}
                    {gain > 0 ? <em className="gain"> +{gain}</em> : null}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="instrument-hint mono">
            互补度 {tm.complementScore}% · 绿色差额表示对方能补足你的短板
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** 05 · 五源跨库引文声呐站 —— 引力透镜拓扑图 */
function CitationSonar() {
  const [selected, setSelected] = useState<string | null>(null);
  const node = CITATION_NODES.find((n) => n.id === selected);

  return (
    <div className="instrument citation-sonar">
      <div className="instrument-head">
        <h2>五源跨库引文声呐站</h2>
        <p>聚合 OpenAlex / arXiv / PubMed / Crossref / Semantic Scholar</p>
      </div>

      <div className="citation-sources">
        {CITATION_SOURCES.map((s) => (
          <span key={s.id} className="source-chip mono">
            {s.label} · {s.count}
          </span>
        ))}
      </div>

      {/* 用 SVG 画拓扑：节点按 x/y 归一化定位，边用直线 */}
      <svg className="citation-graph" viewBox="0 0 100 100" role="img" aria-label="引文网络拓扑">
        {CITATION_EDGES.map((e, i) => {
          const a = CITATION_NODES.find((n) => n.id === e.from);
          const b = CITATION_NODES.find((n) => n.id === e.to);
          if (!a || !b) return null;
          return (
            <line
              key={i}
              x1={a.x * 100}
              y1={a.y * 100}
              x2={b.x * 100}
              y2={b.y * 100}
              className={'cite-edge ' + e.kind}
            />
          );
        })}
        {CITATION_NODES.map((n) => (
          <g key={n.id} onClick={() => setSelected(n.id)} style={{ cursor: 'pointer' }}>
            <circle
              cx={n.x * 100}
              cy={n.y * 100}
              r={n.seminal ? 3.2 : 2.2}
              className={'cite-node' + (n.seminal ? ' seminal' : '') + (n.id === selected ? ' active' : '')}
            />
            <text x={n.x * 100} y={n.y * 100 - 4.5} className="cite-label" textAnchor="middle">
              {n.label}
            </text>
          </g>
        ))}
      </svg>

      <p className="instrument-hint mono">
        {node
          ? `${node.label} · ${node.year} · 被引 ${node.citations}${node.seminal ? ' · 开山工作' : ''}`
          : '点击节点查看详情 · 大圆点为开山鼻祖'}
      </p>
    </div>
  );
}

/** 07 · 证据内嵌式套磁信推演器 —— 双栏红蓝对抗 */
function ColdEmailLab() {
  const [idx, setIdx] = useState(0);
  const draft = EMAIL_DRAFTS[idx];

  return (
    <div className="instrument cold-email">
      <div className="instrument-head">
        <h2>证据内嵌式套磁信推演器</h2>
        <p>红队（导师视角）审阅 + 蓝队（学生视角）改写 · 双栏对照</p>
      </div>

      <div className="mentor-tabs">
        {EMAIL_DRAFTS.map((d, i) => (
          <button
            key={d.id}
            type="button"
            className={'mentor-tab' + (i === idx ? ' active' : '')}
            onClick={() => setIdx(i)}
          >
            <span className="mentor-name">{d.version}</span>
            <span className="mentor-score mono">{d.redTeamScore}</span>
          </button>
        ))}
      </div>

      {draft ? (
        <div className="email-dual">
          <div className="email-pane blue">
            <h3>蓝队 · 草稿</h3>
            <p className="email-subject mono">主题：{draft.subject}</p>
            <pre className="email-body">{draft.body}</pre>
          </div>
          <div className="email-pane red">
            <h3>红队 · 审阅意见</h3>
            {draft.redTeamIssues.length > 0 ? (
              <ul className="email-issues">
                {draft.redTeamIssues.map((iss, i) => (
                  <li key={i}>{iss}</li>
                ))}
              </ul>
            ) : (
              <p className="email-pass">✓ 无重大问题 · 证据完整、定位清晰</p>
            )}
            <div className="email-tips">
              <h4>写作要点</h4>
              <ul>
                {EMAIL_TIPS.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 10 · PDF 公式与参量狙击镜 —— 双栏光学瞄准 */
function PdfSniper() {
  const [sel, setSel] = useState(FORMULAS[0]?.id ?? '');
  const formula = FORMULAS.find((f) => f.id === sel) ?? FORMULAS[0];

  return (
    <div className="instrument pdf-sniper">
      <div className="instrument-head">
        <h2>PDF 公式与参量狙击镜</h2>
        <p>点击文中公式 · 右侧展开量纲解释与 Python 求解代码</p>
      </div>

      <div className="sniper-dual">
        <div className="sniper-pane pdf">
          <h3>原文（模拟 PDF）</h3>
          {PDF_SNIPPETS.map((s) => (
            <div
              key={s.id}
              className={'pdf-snippet' + (s.formulaId === sel ? ' active' : '')}
              onClick={() => setSel(s.formulaId)}
            >
              <span className="pdf-page mono">P.{s.page}</span>
              <p>{s.text}</p>
            </div>
          ))}
        </div>

        <div className="sniper-pane scope">
          <h3>瞄准镜 · 公式解析</h3>
          {formula ? (
            <>
              <div className="formula-block mono">{formula.plain}</div>
              <dl className="formula-meta">
                <dt>量纲</dt>
                <dd>{formula.dimension}</dd>
                <dt>解释</dt>
                <dd>{formula.explanation}</dd>
              </dl>
              <pre className="formula-code">
                <code>{formula.python}</code>
              </pre>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** 13 · Nature 级出版图表熔炉 —— 光学暗房调色台 */
function ChartFoundry() {
  const [sel, setSel] = useState(CHART_STYLES[0]?.id ?? '');
  const style = CHART_STYLES.find((s) => s.id === sel) ?? CHART_STYLES[0];

  return (
    <div className="instrument chart-foundry">
      <div className="instrument-head">
        <h2>Nature 级出版图表熔炉</h2>
        <p>一键转换为符合期刊规范与色盲友好的矢量图</p>
      </div>

      <div className="mentor-tabs">
        {CHART_STYLES.map((s) => (
          <button
            key={s.id}
            type="button"
            className={'mentor-tab' + (s.id === sel ? ' active' : '')}
            onClick={() => setSel(s.id)}
          >
            <span className="mentor-name">{s.name}</span>
          </button>
        ))}
      </div>

      {style ? (
        <div className="chart-spec">
          <dl className="spec-grid">
            <div>
              <dt>适用期刊</dt>
              <dd>{style.journal}</dd>
            </div>
            <div>
              <dt>栏宽</dt>
              <dd className="mono">{style.columnWidth}</dd>
            </div>
            <div>
              <dt>字号</dt>
              <dd className="mono">{style.fontSize}</dd>
            </div>
            <div>
              <dt>导出 DPI</dt>
              <dd className="mono">{style.dpi}</dd>
            </div>
            <div>
              <dt>色盲友好</dt>
              <dd>{style.colorBlindSafe ? '✓ 已通过' : '未验证'}</dd>
            </div>
          </dl>

          <div className="palette-row">
            <span className="palette-label">配色方案</span>
            <div className="palette-swatches">
              {style.palette.map((c) => (
                <span key={c} className="swatch" style={{ background: c }} title={c} />
              ))}
            </div>
          </div>

          {/* 用当前配色画一组示例柱状图 */}
          <svg className="chart-preview" viewBox="0 0 200 80" role="img" aria-label="配色预览">
            {[0.45, 0.62, 0.78, 0.91, 0.55].map((h, i) => (
              <rect
                key={i}
                x={20 + i * 36}
                y={70 - h * 60}
                width={24}
                height={h * 60}
                fill={style.palette[i % style.palette.length]}
              />
            ))}
          </svg>
          <p className="instrument-hint mono">
            预览使用当前配色 · 实际导出为 PDF/EPS 矢量格式
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** 14 · 综述拓扑推演与写作舱 —— 章节逻辑流建筑台 */
function ReviewLab() {
  const [sel, setSel] = useState(REVIEW_CLUSTERS[0]?.id ?? '');
  const cluster = REVIEW_CLUSTERS.find((c) => c.id === sel);

  return (
    <div className="instrument review-lab">
      <div className="instrument-head">
        <h2>综述拓扑推演与写作舱</h2>
        <p>文献按技术流派聚类 · 自动生成带精准引文的综述初稿</p>
      </div>

      <div className="cluster-cards">
        {REVIEW_CLUSTERS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={'cluster-card' + (c.id === sel ? ' active' : '')}
            onClick={() => setSel(c.id)}
          >
            <span className="cluster-name">{c.school}</span>
            <span className="cluster-meta mono">
              {c.papers} 篇 · 被引 {c.citations}
            </span>
          </button>
        ))}
      </div>

      {cluster ? (
        <div className="cluster-detail">
          <p className="cluster-claim">{cluster.keyClaim}</p>
          <EvidenceLink
            anchor={{ sourceDoiOrUrl: cluster.representativeDoi, verificationLevel: 'Level_A_Verified' }}
            showDoi
            size="sm"
          />
        </div>
      ) : null}

      <div className="outline-tree">
        <h3>综述大纲</h3>
        <ul>
          {REVIEW_OUTLINE.map((o) => (
            <li key={o.id} className={'outline-l' + o.level} data-cluster={'clusterId' in o ? o.clusterId : undefined}>
              {o.text}
            </li>
          ))}
        </ul>
      </div>
      <p className="instrument-hint mono">
        点击流派查看代表文献 · 大纲节点与聚类自动关联
      </p>
    </div>
  );
}

/** 18 · 生涯多重宇宙期望决策树 —— 量子分岔概率光轨沙盘 */
function PrejobTree() {
  const [sel, setSel] = useState(CAREER_PATHS[0]?.id ?? '');
  const path = CAREER_PATHS.find((p) => p.id === sel) ?? CAREER_PATHS[0];
  const RISK_LABEL: Record<string, string> = { low: '低风险', medium: '中风险', high: '高风险' };
  const maxGain = Math.max(...CAREER_PATHS.map((p) => p.expectedGain));

  return (
    <div className="instrument prejob-tree">
      <div className="instrument-head">
        <h2>生涯多重宇宙期望决策树</h2>
        <p>量化推演不同路径未来 5 年期望收益与风险</p>
      </div>

      <div className="path-cards">
        {CAREER_PATHS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={'path-card' + (p.id === sel ? ' active' : '')}
            data-risk={p.risk}
            onClick={() => setSel(p.id)}
          >
            <span className="path-name">{p.name}</span>
            <span className="path-gain mono">{p.expectedGain} 万</span>
            <span className="path-risk">{RISK_LABEL[p.risk]}</span>
            <span className="path-bar">
              <span className="path-fill" style={{ width: `${(p.expectedGain / maxGain) * 100}%` }} />
            </span>
          </button>
        ))}
      </div>

      {path ? (
        <div className="path-detail">
          <p className="path-desc">{path.description}</p>

          <div className="prob-row">
            <div className="prob-item">
              <span className="prob-label">成功</span>
              <span className="prob-val mono">{Math.round(path.probabilities.success * 100)}%</span>
            </div>
            <div className="prob-item">
              <span className="prob-label">平稳</span>
              <span className="prob-val mono">{Math.round(path.probabilities.neutral * 100)}%</span>
            </div>
            <div className="prob-item">
              <span className="prob-label">受挫</span>
              <span className="prob-val mono">{Math.round(path.probabilities.fail * 100)}%</span>
            </div>
          </div>

          {/* 五年轨迹折线 */}
          <svg className="trajectory" viewBox="0 0 240 70" role="img" aria-label="五年收益轨迹">
            {(() => {
              const max = Math.max(...path.trajectory);
              const pts = path.trajectory
                .map((v, i) => {
                  const x = 20 + (i / (path.trajectory.length - 1)) * 200;
                  const y = 60 - (v / max) * 50;
                  return `${x},${y}`;
                })
                .join(' ');
              return (
                <>
                  <polyline points={pts} className="traj-line" fill="none" />
                  {path.trajectory.map((v, i) => {
                    const x = 20 + (i / (path.trajectory.length - 1)) * 200;
                    const y = 60 - (v / max) * 50;
                    return <circle key={i} cx={x} cy={y} r={2.5} className="traj-dot" />;
                  })}
                </>
              );
            })()}
          </svg>
          <p className="instrument-hint mono">
            五年累计 {path.expectedGain} 万 · 逐年轨迹：{path.trajectory.join(' → ')} 万
          </p>
        </div>
      ) : null}
    </div>
  );
}

/* ─────────────────────────── 分发 ─────────────────────────── */

export function SiteInstrument({ siteId, accent }: SiteInstrumentProps) {
  const kind: InstrumentKind | undefined = SITE_INSTRUMENT[siteId];

  if (!IMPLEMENTED_SITES.includes(siteId) || !kind) {
    return <Placeholder siteId={siteId} />;
  }

  switch (kind) {
    case 'gpa-pusher':
      return <GpaPusher siteId={siteId} accent={accent} />;
    case 'spark-radar':
      return <SparkRadar />;
    case 'grant-gauge':
      return <GrantGauge siteId={siteId} accent="amber" />;
    case 'pat-radar':
      return <PatRadar />;
    case 'citation-sonar':
      return <CitationSonar />;
    case 'mentor-radar':
      return <MentorRadar siteId={siteId} accent="violet" />;
    case 'cold-email':
      return <ColdEmailLab />;
    case 'lab-kanban':
      return <LabKanban />;
    case 'matrix-cross':
      return <MatrixCross />;
    case 'pdf-sniper':
      return <PdfSniper />;
    case 'curvelab':
      return <CurveLab siteId={siteId} accent="emerald" />;
    case 'repro-checklist':
      return <ReproChecklist />;
    case 'chart-foundry':
      return <ChartFoundry />;
    case 'review-lab':
      return <ReviewLab />;
    case 'retract-sonar':
      return <RetractSonar siteId={siteId} accent="rose" />;
    case 'yunheng-balance':
      return <YunhengBalance siteId={siteId} accent="emerald" />;
    case 'evidence-cv':
      return <EvidenceCv />;
    case 'prejob-tree':
      return <PrejobTree />;
    default:
      return <Placeholder siteId={siteId} />;
  }
}
