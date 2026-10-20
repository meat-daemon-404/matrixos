import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import {
  CopilotWaveDock,
  DampedKnob,
  EvidenceLink,
  FluidGaugeBank,
  INSTRUMENT_UI_VERSION,
  OscilloscopeCanvas,
  PrecisionBalance,
  SonarDisc,
  StarOrbit,
  TaskKanban,
  WormholeRing,
  SURFACE_LIST,
  contrastRatio,
  formatFixed,
  usePrefersReducedMotion,
  wcagLevel,
} from '../src/index';
import type {
  EvidenceAnchor,
  KanbanTask,
  SonarBlip,
  StarOrbitStation,
  WormholeRingState,
  WormholeTarget,
} from '../src/index';

import {
  BALANCE_PANS,
  EVIDENCE_ANCHORS,
  GAUGE_COLUMNS,
  KANBAN_COLUMNS,
  KANBAN_TASKS,
  ORBIT_STATIONS,
  SONAR_BLIPS,
  WORMHOLE_TARGETS,
} from './fixtures';

/* -------------------------------------------------------------------------- */
/* 小组件：分节                                                                */
/* -------------------------------------------------------------------------- */

interface SectionProps {
  index: string;
  title: string;
  note?: string;
  children: ReactNode;
}

function Section({ index, title, note, children }: SectionProps): ReactNode {
  return (
    <section className="dz-section">
      <div className="dz-section-head">
        <span className="dz-section-index">{index}</span>
        <h2 className="dz-section-title">{title}</h2>
        {note ? <p className="dz-section-note">{note}</p> : null}
      </div>
      <div className="dz-stage dz-stage--split">{children}</div>
    </section>
  );
}

interface CardProps {
  title: string;
  sub?: string;
  center?: boolean;
  wide?: boolean;
  children: ReactNode;
}

function Card({ title, sub, center, wide, children }: CardProps): ReactNode {
  return (
    <div
      className={[
        'iu-panel',
        'dz-card',
        center ? 'dz-card--center' : '',
        wide ? 'dz-card--wide' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="dz-card-head">
        <span className="dz-card-title">{title}</span>
        {sub ? <span className="dz-card-sub">{sub}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** 事件回显：证明「props in / events out」真的通了。 */
function Echo({ items }: { items: readonly { k: string; v: string }[] }): ReactNode {
  return (
    <div className="dz-echo" role="status" aria-live="polite">
      {items.map((item) => (
        <span key={item.k}>
          {item.k} <b>{item.v}</b>
        </span>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* App                                                                        */
/* -------------------------------------------------------------------------- */

export function App(): ReactNode {
  const reducedMotion = usePrefersReducedMotion();

  /* ---- 1. DampedKnob ---- */
  const [tau, setTau] = useState(1.24);
  const [gain, setGain] = useState(42);
  const [commits, setCommits] = useState(0);
  const [lastSnr, setLastSnr] = useState(12.5);

  const handleTauCommit = useCallback((value: number) => {
    setCommits((n) => n + 1);
    // 演示「commit 才触发昂贵重算」：拖动中不重拟合，松手才算 SNR
    setLastSnr(Math.round((18 - value * 1.6) * 10) / 10);
  }, []);

  /* ---- 2. SonarDisc ---- */
  const [selectedBlip, setSelectedBlip] = useState<SonarBlip | null>(null);
  const [sweepHits, setSweepHits] = useState(0);

  const handleSweepHit = useCallback(() => {
    setSweepHits((n) => n + 1);
  }, []);

  /* ---- 3. PrecisionBalance ---- */
  const [activePan, setActivePan] = useState<string | null>(null);

  /* ---- 4. FluidGaugeBank ---- */
  const [gaugeMode, setGaugeMode] = useState<'breach' | 'compliant'>('breach');
  const [activeColumn, setActiveColumn] = useState<string | null>(null);

  const gaugeColumns = useMemo(() => {
    if (gaugeMode === 'breach') return GAUGE_COLUMNS;
    // 合规态：把劳务费压回红线以内，验证阻断横幅会消失
    return GAUGE_COLUMNS.map((column) =>
      column.id === 'col-labor' ? { ...column, value: 3200 } : column,
    );
  }, [gaugeMode]);

  /* ---- 5. EvidenceLink ---- */
  const [activated, setActivated] = useState<string>('—');

  const handleEvidenceActivate = useCallback((anchor: EvidenceAnchor) => {
    setActivated(anchor.sourceDoiOrUrl);
  }, []);

  /* ---- 6. StarOrbit ---- */
  const [orbitZoom, setOrbitZoom] = useState(1);
  const [orbitStation, setOrbitStation] = useState<string | null>(null);

  /* ---- 7. WormholeRing ---- */
  const [wormholeState, setWormholeState] = useState<WormholeRingState>('valid');
  const [wormholeTarget, setWormholeTarget] = useState<WormholeTarget | null>(null);

  /* ---- 8. OscilloscopeCanvas ---- */
  const [drawMs, setDrawMs] = useState<number | null>(null);

  const handleDraw = useCallback((info: { ms: number; pointCount: number }) => {
    setDrawMs(Math.round(info.ms * 10) / 10);
  }, []);

  /* ---- 9. TaskKanban ---- */
  const [tasks, setTasks] = useState<readonly KanbanTask[]>(KANBAN_TASKS);
  const [moveNote, setMoveNote] = useState('—');

  const handleTaskMove = useCallback(
    (task: KanbanTask, toColumnId: string, fromColumnId: string): boolean => {
      // 状态机守卫：已进组是终态，不允许回退（演示受控组件如何拒绝非法跃迁）
      if (fromColumnId === 'joined') {
        setMoveNote(`拒绝 ${task.id}：已进组为终态`);
        return false;
      }
      setTasks((prev) =>
        prev.map((item) => (item.id === task.id ? { ...item, columnId: toColumnId } : item)),
      );
      setMoveNote(`${task.id} ${fromColumnId} → ${toColumnId}`);
      return true;
    },
    [],
  );

  /* ---- 10. CopilotWaveDock ---- */
  const [copilotState, setCopilotState] = useState<'idle' | 'listening' | 'thinking' | 'speaking'>(
    'idle',
  );
  const [lastQuery, setLastQuery] = useState('—');

  const handleQuery = useCallback((query: string) => {
    setLastQuery(query);
    setCopilotState('thinking');
    window.setTimeout(() => setCopilotState('speaking'), 900);
    window.setTimeout(() => setCopilotState('idle'), 2600);
  }, []);

  /* ---- 对比度面板 ---- */
  /**
   * 全部**被当作文字色使用**的令牌清单（与 tokens.css 的 Text / Accent 段一一对应）。
   *
   * V7 教训：这里原本只列了 7 个前景色，恰好漏掉 `--iu-text-faint`，
   * 而它当时是 3.75:1 且被 18 处当正文用 —— 守卫漏项 = 守卫失效。
   * 现在按令牌全量登记，新增文字色必须同步加进来。
   */
  const TEXT_TOKENS = [
    { name: 'text', color: '#f1f5f9' },
    { name: 'text-strong', color: '#ffffff' },
    { name: 'text-secondary', color: '#cbd5e1' },
    { name: 'text-muted', color: '#94a3b8' },
    { name: 'text-faint', color: '#7d8ba1' },
    { name: 'instrument', color: '#06b6d4' },
    { name: 'instrument-text', color: '#22d3ee' },
    { name: 'positive', color: '#10b981' },
    { name: 'positive-text', color: '#34d399' },
    { name: 'warning', color: '#f59e0b' },
    { name: 'warning-text', color: '#fbbf24' },
    { name: 'danger-text', color: '#fb7185' },
    { name: 'action-text', color: '#818cf8' },
  ] as const;

  const contrastRows = useMemo(() => {
    return TEXT_TOKENS.map((fg) => {
      const ratio = Math.min(...SURFACE_LIST.map((bg) => contrastRatio(fg.color, bg)));
      return { ...fg, ratio, level: wcagLevel(ratio) };
    });
  }, []);

  /** 有多少个令牌没有达到 AA 正文线（4.5:1）。0 才算通过。 */
  const failingTokens = contrastRows.filter((row) => row.ratio < 4.5).length;


  return (
    <div className="dz-page">
      <header className="dz-header">
        <h1 className="dz-title">
          MatrixOS 精密仪器组件库
          <small>
            @matrixos/instrument-ui · v{INSTRUMENT_UI_VERSION} · react 19 + tailwind 4
          </small>
        </h1>
        <div className="dz-toolbar">
          <span className="dz-btn" aria-live="polite">
            reduced-motion: {reducedMotion ? 'on' : 'off'}
          </span>
          <button
            type="button"
            className="dz-btn"
            aria-pressed={gaugeMode === 'breach'}
            onClick={() => setGaugeMode((m) => (m === 'breach' ? 'compliant' : 'breach'))}
          >
            经费：{gaugeMode === 'breach' ? '超红线' : '合规'}
          </button>
          <button
            type="button"
            className="dz-btn"
            aria-pressed={wormholeState === 'invalid'}
            onClick={() => setWormholeState((s) => (s === 'invalid' ? 'valid' : 'invalid'))}
          >
            虫洞：{wormholeState === 'invalid' ? '校验失败' : '校验通过'}
          </button>
        </div>
      </header>

      {/* ------------------------------------------------------------------ */}
      <Section index="01" title="DampedKnob · 精密阻尼旋钮" note="拖动连续调节（垂直位移 + 角度累积）、金属倒角、方向键微调、双击读入精确值。onChange 高频、onCommit 只在松手时触发。">
        <Card title="拟合时间常数 τ" sub="step 0.01 · 键盘 ↑↓ / Shift+↑↓" center>
          <div className="dz-knobs">
            <DampedKnob
              label="τ₁"
              unit="ns"
              value={tau}
              min={0}
              max={5}
              step={0.01}
              onChange={setTau}
              onCommit={handleTauCommit}
              accent="cyan"
              hint="荧光衰减时间常数"
              data-testid="knob-tau"
            />
            <DampedKnob
              label="增益"
              unit="dB"
              value={gain}
              defaultValue={42}
              min={-20}
              max={80}
              step={1}
              onChange={setGain}
              accent="amber"
              size="lg"
              hint="信号增益（非受控）"
            />
            <DampedKnob label="锁定" value={63} min={0} max={100} step={1} disabled accent="rose" hint="disabled 态" />
          </div>
          <Echo
            items={[
              { k: 'τ₁', v: `${formatFixed(tau, 2)} ns` },
              { k: '增益', v: `${formatFixed(gain, 0)} dB` },
              { k: 'commits', v: String(commits) },
              { k: '重算 SNR', v: `${formatFixed(lastSnr, 1)} dB` },
            ]}
          />
        </Card>

        <Card title="OscilloscopeCanvas · 荧光示波器" sub="Canvas + 降采样 + 置信带" center>
          <OscilloscopeCanvas
            demo={{ count: 220, noise: 0.16, seed: 7, model: 'linear' }}
            height={260}
            accent="cyan"
            title="CurveLab · 线性拟合"
            xLabel="t (ns)"
            yLabel="I (a.u.)"
            onDraw={handleDraw}
          />
          <Echo items={[{ k: 'draw', v: drawMs === null ? '—' : `${drawMs} ms` }]} />
        </Card>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section index="02" title="SonarDisc · 360° 极坐标声呐盘" note="纯 CSS 扫描（非 rAF）；红/黄/绿三级风险点用「颜色 + 形状」双通道编码，色觉障碍下仍可区分；内置等价数据表格。">
        <Card title="撤稿深海声呐" sub="15 站 · 点击风险点" center>
          <SonarDisc
            blips={SONAR_BLIPS}
            size={360}
            sweepDuration={6}
            selectedId={selectedBlip?.id}
            onBlipClick={(blip) => setSelectedBlip(blip)}
            onSweepHit={handleSweepHit}
            title="RETRACTION RADAR"
            accent="cyan"
          />
          <Echo
            items={[
              { k: '选中', v: selectedBlip ? selectedBlip.label : '—' },
              { k: '风险', v: selectedBlip ? selectedBlip.risk : '—' },
              { k: '回波', v: String(sweepHits) },
            ]}
          />
        </Card>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section index="03" title="PrecisionBalance · 精密三盘电子天平" note="砝码堆叠可视化「这一分怎么来的」；总分用**一次 480ms 的 rAF 缓动**推进（有界、跑完即断，非常驻逐帧），reduced-motion 下直接显示终值。盘体浮沉/液面/砝码落位全是 CSS。" >
        <Card title="云衡 · 综测核算" sub="16 站 · 三盘配重" center wide>
          <PrecisionBalance
            pans={BALANCE_PANS}
            capacity={100}
            totalLabel="综测总分"
            accent="amber"
            onPanHover={(pan) => setActivePan(pan ? pan.id : null)}
            onPanClick={(pan) => setActivePan(pan.id)}
          />
          <Echo items={[{ k: '焦点盘', v: activePan ?? '—' }]} />
        </Card>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section index="04" title="FluidGaugeBank · 多柱流体液位压差计" note="红线是一等公民：始终可见，越线即转 rose + 危险纹 + 阻断横幅（role=alert），并挂 aria-live 断言。点上方「经费」按钮切合规态。">
        <Card title="大创五科目经费" sub="03 站 · 劳务费 ≤20% 硬红线" wide>
          <FluidGaugeBank
            columns={gaugeColumns}
            height={220}
            accent="cyan"
            blockOnBreach
            onColumnHover={(column) => setActiveColumn(column ? column.id : null)}
            onColumnClick={(column) => setActiveColumn(column.id)}
          />
          <Echo items={[{ k: '焦点柱', v: activeColumn ?? '—' }, { k: '模式', v: gaugeMode }]} />
        </Card>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section index="05" title="EvidenceLink · 证据锚点徽章" note="三档（Level_A_Verified / Level_B_Preprint / Retracted_Warning）逐字对齐 wormhole-envelope 契约枚举；悬停显示 DOI、页码与 bbox，并在 A4 纸页缩略图上标出坐标框。">
        <Card title="证据锚点三态" sub="悬停看 bbox" wide>
          <div className="dz-evidence-row">
            <div className="dz-evidence-cell">
              <span className="dz-evidence-name">Level A · 已双验</span>
              <EvidenceLink anchor={EVIDENCE_ANCHORS[0]} size="md" onActivate={handleEvidenceActivate} />
            </div>
            <div className="dz-evidence-cell">
              <span className="dz-evidence-name">Level B · 仅预印本</span>
              <EvidenceLink anchor={EVIDENCE_ANCHORS[1]} size="md" onActivate={handleEvidenceActivate} />
            </div>
            <div className="dz-evidence-cell">
              <span className="dz-evidence-name">已命中撤稿库</span>
              <EvidenceLink anchor={EVIDENCE_ANCHORS[2]} size="md" onActivate={handleEvidenceActivate} />
            </div>
            <div className="dz-evidence-cell">
              <span className="dz-evidence-name">多源聚合（取最严重）</span>
              <EvidenceLink anchors={[...EVIDENCE_ANCHORS]} size="md" showDoi onActivate={handleEvidenceActivate} />
            </div>
            <div className="dz-evidence-cell">
              <span className="dz-evidence-name">无锚点（诚实降级）</span>
              <EvidenceLink size="md" />
            </div>
          </div>
          <Echo items={[{ k: 'onActivate', v: activated }]} />
        </Card>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section index="06" title="StarOrbit · 2.5D 星轨引力场" note="语义缩放 1.0x → 10.0x：缩放值写进 CSS 变量 --iu-zoom，胶囊尺寸/字号/层级全由 CSS calc() 派生，无 JS 逐帧。滚轮或角标按钮缩放。">
        <Card title="18 微站轨道" sub="真实花名册（specs/microsites.json）" wide>
          <div className="dz-full">
            <StarOrbit
              stations={ORBIT_STATIONS}
              orbitCount={7}
              zoom={orbitZoom}
              onZoomChange={setOrbitZoom}
              onCapsuleClick={(station) => setOrbitStation(station.id)}
              rotationSpeed={0}
              height={520}
            />
          </div>
          <Echo
            items={[
              { k: 'zoom', v: `${formatFixed(orbitZoom, 2)}x` },
              { k: '选中站', v: orbitStation ?? '—' },
            ]}
          />
        </Card>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section index="07" title="WormholeRing · 跨站虫洞环" note="环张合走 CSS scale/opacity；校验失败时整环转 rose 并抖动一次后静止（不做无限抖动）。点上方「虫洞」按钮切换校验态。">
        <Card title="投送 curve_fit_parameters" sub={wormholeState} center wide>
          <WormholeRing
            open
            state={wormholeState}
            targets={WORMHOLE_TARGETS}
            selectedTargetId={wormholeTarget?.id}
            onTargetSelect={setWormholeTarget}
            payloadSummary="curve_fit_parameters · τ₁ = 1.24 ns"
            payloadType="curve_fit_parameters"
            evidenceCount={3}
            receiptId={wormholeState === 'valid' ? 'mx_idt_9f3a' : undefined}
            errorMessage={wormholeState === 'invalid' ? 'evidence_count 必须 ≥ 1，且需绑定 DOI 锚点' : undefined}
          />
          <Echo items={[{ k: '目标', v: wormholeTarget ? wormholeTarget.name : '—' }, { k: 'state', v: wormholeState }]} />
        </Card>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section index="08" title="TaskKanban · 航天任务控制看板" note="受控组件：拖拽/键盘只发 onTaskMove，是否真移动由调用方决定。这里演示「已进组为终态」被拒绝。">
        <Card title="进组跟进台账" sub="08 站 · MISSION SG-07" wide>
          <TaskKanban
            columns={KANBAN_COLUMNS}
            tasks={tasks}
            onTaskMove={handleTaskMove}
            missionCode="MISSION SG-07"
            accent="emerald"
            height={420}
          />
          <Echo items={[{ k: 'move', v: moveNote }]} />
        </Card>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section index="09" title="WCAG AA 守卫" note="对 tokens.css 的 5 种表面取最差对比度，逐个验全部文字令牌（13 个）。任何新增文字色只要不达 4.5:1 就会在这里标红 —— V7 曾漏掉 --iu-text-faint 导致 3.75:1 长期隐形，现已全量登记。" >
        <Card title="Contrast audit" sub={failingTokens === 0 ? '全部通过 AA 4.5:1' : `⚠ ${failingTokens} 项未达 AA`} wide>
          <div className="dz-contrast">
            {contrastRows.map((row) => (
              <div className="dz-contrast-row" key={row.name}>
                <span className="dz-contrast-swatch" style={{ background: row.color }} />
                <span>{row.name}</span>
                <span className="dz-contrast-value">{formatFixed(row.ratio, 2)}:1</span>
                <span className="dz-badge" data-level={row.level}>
                  {row.level}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </Section>

      <p className="dz-footnote">
        本页只消费 <code>src/index.ts</code> 的公开导出（源码直出，无构建依赖）。颜色全部取自{' '}
        <code>tokens.css</code> 的 <code>--iu-*</code> 令牌；底色 <code>#050814</code>，面板{' '}
        <code>#0B1021</code>。动效一律 CSS transform / keyframes，无 JS 逐帧驱动；全库支持{' '}
        <code>prefers-reduced-motion</code>。
      </p>

      <CopilotWaveDock
        state={copilotState}
        contextLabel="当前在组件库 demo"
        onQuery={handleQuery}
        fixed
        accent="indigo"
        statusText={lastQuery === '—' ? undefined : `上次提问：${lastQuery}`}
      />
    </div>
  );
}
