/**
 * 12 · 顶刊代码复现核验舱 —— 业务规格（本站唯一手写的业务代码）
 *
 * 台账：依赖环境、随机种子与超参复现清单
 * 投送：paper_doi_bundle → retract-radar（15 撤稿深海声呐 · 引文合规体检）
 * 接收：paper_doi_bundle / curve_fit_parameters ← curvelab（11 CurveLab 拟合台）
 *
 * 为什么这么写：
 *   一条记录 = 一篇论文的复现核验清单。检查项不是本站编的 —— 来自共享标准清单
 *   REPRO_CHECKS（依赖环境 / 数据可得性 / 随机种子 / 超参完整性 / 硬件要求），
 *   状态按论文的证据等级用确定性规则推导（见 statusFor）：预印本在标准清单上
 *   整体降一档（pass→warn、warn→fail），撤稿引文全项 fail。
 *   这样「核验结论」是证据等级的函数，不是手抄的三行故事。
 *
 *   核验结论随 DOI 包投给撤稿声呐：声呐把 pass/fail 分布作为引文风险评分的输入，
 *   形成「代码可复现 → 才值得引用」的链路。
 *
 * 锚点注意：共享数据里的锚点是 SDK 的 camelCase 形状（sourceDoiOrUrl/pdfPage/
 * verificationLevel，还多带一个 note），虫洞信封契约的锚点层是
 * additionalProperties: false 的 snake_case —— 逐字段转换并丢掉 note。
 */

import {
  PAPER_ROWS,
  REPRO_CHECKS,
  createRowSpec,
  type PaperRow,
  type ReproCheck,
  type RowSeed,
  type WormholeEvidenceAnchor,
} from '@matrixos/microsite-data';

const LEDGER_NAME = '依赖环境、随机种子与超参复现清单';

type Level = WormholeEvidenceAnchor['verification_level'];
type Status = ReproCheck['status'];

const STATUS_LABEL: Record<Status, string> = {
  pass: '通过',
  warn: '警告',
  fail: '失败',
};

/** 证据等级越弱，检查结论整体降一档（确定性规则，不逐条手抄状态）。 */
function downgrade(status: Status): Status {
  return status === 'pass' ? 'warn' : 'fail';
}

function statusFor(check: ReproCheck, level: Level): Status {
  if (level === 'Retracted_Warning') return 'fail';
  if (level === 'Level_B_Preprint') return downgrade(check.status);
  return check.status;
}

/** 依赖环境检查项 —— Docker 模板的 Python 版本与安装说明都从它的 detail 来。 */
const DEPENDENCY_CHECK: ReproCheck | undefined = REPRO_CHECKS.find((check) => check.id === 'k1');
const PYTHON_VERSION =
  /Python\s*([\d.]+)/.exec(String(DEPENDENCY_CHECK?.detail ?? ''))?.[1] ?? '3.11';
const SEED_CHECK: ReproCheck | undefined = REPRO_CHECKS.find((check) => check.id === 'k3');

/** 复现 Dockerfile：版本与依赖说明引用共享检查项，改数据这段跟着变，不手抄。 */
function dockerfileOf(label: string): string {
  return [
    `# ${label} 复现环境（repro-check 生成）`,
    `FROM python:${PYTHON_VERSION}-slim`,
    'RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*',
    'WORKDIR /repro',
    'COPY requirements.txt .',
    `RUN pip install --no-cache-dir -r requirements.txt   # ${String(DEPENDENCY_CHECK?.detail ?? '')}`,
    'COPY . .',
    `# 随机种子：${String(SEED_CHECK?.detail ?? '需固定 seed 后重跑消融')} —— reproduce.py 强制接收 --seed`,
    'ENTRYPOINT ["python", "reproduce.py", "--seed", "20261020"]',
  ].join('\n');
}

/** camelCase（instrument-ui）→ snake_case（虫洞契约），并丢掉契约外的 note。 */
function anchorOf(paper: PaperRow): WormholeEvidenceAnchor {
  const source = paper.anchor;
  return {
    source_doi_or_url: source.sourceDoiOrUrl,
    verification_level: source.verificationLevel,
    ...(typeof source.pdfPage === 'number' ? { pdf_page: source.pdfPage } : {}),
    ...(source.bbox ? { bbox: source.bbox } : {}),
  };
}

/** 站内新建、尚未绑定 DOI 的清单用站内页兜底（Level B，绝不冒充 Level A）。 */
function checklistAnchor(slug: string): WormholeEvidenceAnchor {
  return {
    source_doi_or_url: `https://repro-check.matrixos.cc.cd/checklists/${slug}`,
    verification_level: 'Level_B_Preprint',
  };
}

interface CheckOutcome {
  readonly id: string;
  readonly item: string;
  readonly status: Status;
  readonly detail: string;
}

function outcomeOf(paper: PaperRow): {
  readonly checks: readonly CheckOutcome[];
  readonly passCount: number;
  readonly warnCount: number;
  readonly failCount: number;
  readonly verdict: string;
} {
  const level = paper.anchor.verificationLevel as Level;
  const checks: readonly CheckOutcome[] = REPRO_CHECKS.map((check) => ({
    id: check.id,
    item: check.item,
    status: statusFor(check, level),
    detail: check.detail,
  }));
  const passCount = checks.filter((check) => check.status === 'pass').length;
  const warnCount = checks.filter((check) => check.status === 'warn').length;
  const failCount = checks.filter((check) => check.status === 'fail').length;
  const blockers = checks.filter((check) => check.status === 'fail');
  const verdict =
    failCount > 0
      ? `不可复现 · ${blockers.map((check) => check.item).join('、')}缺失`
      : warnCount > 0
        ? '有条件复现 · 需人工确认'
        : '可复现';
  return { checks, passCount, warnCount, failCount, verdict };
}

function checklistSeed(paper: PaperRow): RowSeed {
  const anchor = anchorOf(paper);
  const { checks, passCount, warnCount, failCount, verdict } = outcomeOf(paper);
  const blockers = checks.filter((check) => check.status === 'fail');

  return {
    title: `复现核验 · ${paper.venue}`,
    meta: `通过 ${passCount}/${checks.length} · 警告 ${warnCount} · 失败 ${failCount} · ${verdict}`,
    detail: [
      `对象：${paper.strategy}（关键指标 ${paper.eqe}，原文 p.${String(paper.anchor.pdfPage ?? '—')} ${String(paper.anchor.note ?? '')}）`,
      `清单：${checks.map((check) => `${check.item}=${STATUS_LABEL[check.status]}`).join(' · ')}`,
      ...blockers.map((check) => `阻塞项：${check.item} —— ${check.detail}`),
      '避坑：先补 training_config.yaml（学习率 / batch size），再固定 seed 重跑消融；数据可向通讯作者走 Figshare DOI 申请。',
    ].join('；'),
    anchor,
    paperId: paper.id,
    venue: paper.venue,
    strategy: paper.strategy,
    keyMetric: paper.eqe,
    sourceDoi: anchor.source_doi_or_url,
    verificationLevel: anchor.verification_level,
    passCount,
    warnCount,
    failCount,
    verdict,
    checks,
    dockerfile: dockerfileOf(`${paper.venue} · ${paper.strategy}`),
  } satisfies RowSeed;
}

const seed: readonly RowSeed[] = PAPER_ROWS.map(checklistSeed);

/* ───────────────────────── 业务规格 ───────────────────────── */

export const siteSpec = createRowSpec({
  exportName: 'repro-checklists',
  seed,
  emit: {
    targetApp: 'retract-radar',
    payloadType: 'paper_doi_bundle',
  },
  accept: {
    payloadType: 'paper_doi_bundle',
    description:
      '接收论文 DOI 包（含 CurveLab 回传的拟合参量补充）：DOI 包落成「待核验清单」，拟合参量用于把「超参完整性」项从 fail 复核升级。',
  },

  /** 新增一条 = 开一篇待核验论文，五项标准检查未跑，结论未出。 */
  draft: (rows) => {
    const next = String(rows.length + 1).padStart(2, '0');
    return {
      title: `待核验论文 ${next}`,
      meta: `通过 0/${REPRO_CHECKS.length} · 未开检`,
      detail: `新论文：clone 仓库并导入 requirements.txt 后跑 ${REPRO_CHECKS.length} 项标准检查；出结论前不投送 —— 核验舱不发没验过的包。`,
      anchor: checklistAnchor(`draft-${next}`),
      paperId: `draft-${next}`,
      venue: '待填',
      strategy: '待填',
      keyMetric: '—',
      sourceDoi: `https://repro-check.matrixos.cc.cd/checklists/draft-${next}`,
      verificationLevel: 'Level_B_Preprint',
      passCount: 0,
      warnCount: 0,
      failCount: 0,
      verdict: '未开检',
      checks: [],
      dockerfile: dockerfileOf(`待核验论文 ${next}`),
    } satisfies RowSeed;
  },

  /**
   * 投送载荷：paper_doi_bundle 带上**核验结论**（不只是 DOI 列表），
   * 撤稿声呐据此给引文风险评分加权：不可复现的引用风险更高。
   */
  payloadOf: (rows) => {
    const papers = rows.map((row) => ({
      id: String(row.paperId ?? row.id),
      venue: String(row.venue ?? ''),
      strategy: String(row.strategy ?? ''),
      keyMetric: String(row.keyMetric ?? ''),
      sourceDoi: String(row.sourceDoi ?? ''),
      verificationLevel: String(row.verificationLevel ?? ''),
      passCount: Number(row.passCount ?? 0),
      warnCount: Number(row.warnCount ?? 0),
      failCount: Number(row.failCount ?? 0),
      verdict: String(row.verdict ?? ''),
    }));
    const doiBundle = Array.from(
      new Set(papers.map((paper) => paper.sourceDoi).filter((doi) => doi !== '')),
    );
    return {
      site: 'repro-check',
      ledger: LEDGER_NAME,
      target: 'retract-radar',
      rule: '核验结论随 DOI 包投送：pass/fail 分布作为引文风险评分的输入权重',
      checkTemplate: REPRO_CHECKS.map((check) => ({ id: check.id, item: check.item })),
      paperCount: papers.length,
      doiCount: doiBundle.length,
      doiBundle,
      papers,
    };
  },

  /**
   * 接收：两种 payload 分流。
   *   curve_fit_parameters —— CurveLab 的拟合参数补件，用来复核「超参完整性」；
   *   paper_doi_bundle     —— 上游论文包，落成「待核验」清单。
   */
  rowOfEnvelope: (envelope, nowIso) => {
    const data = (envelope.payload?.data ?? {}) as Record<string, unknown>;
    const anchors: readonly WormholeEvidenceAnchor[] = Array.isArray(
      envelope.payload?.evidence_anchors,
    )
      ? (envelope.payload.evidence_anchors as readonly WormholeEvidenceAnchor[])
      : [];
    const firstAnchor = anchors[0];
    const sourceApp = String(envelope.source_app ?? 'curvelab');
    const traceShort = String(envelope.trace_id ?? 'unknown').slice(0, 8);
    const type = String(envelope.payload_type ?? 'paper_doi_bundle');
    const base = {
      anchor: firstAnchor ?? checklistAnchor(`inbox-${traceShort}`),
      paperId: `inbox-${traceShort}`,
      passCount: 0,
      warnCount: 0,
      failCount: 0,
      checks: [],
      receivedFrom: sourceApp,
      traceId: String(envelope.trace_id ?? 'unknown'),
    };

    if (type === 'curve_fit_parameters') {
      const focused = (data.focused ?? data) as Record<string, unknown>;
      const params = (focused.params ?? {}) as Record<string, unknown>;
      const paramKeys = Object.keys(params);
      return {
        ...base,
        title: `拟合参量补件 · ${String(focused.datasetId ?? '未知数据集')}`,
        meta: `来自 ${sourceApp} · curve_fit_parameters · ${String(paramKeys.length)} 参数 · k4 待复核`,
        detail: [
          `CurveLab 投来拟合参数（${paramKeys.join(' / ') || '未带参数'}），「超参完整性」项据此复核后可从 fail 升级`,
          `模型：${String(focused.modelLabel ?? '未标')} · R²=${String(focused.r2 ?? '—')} · trace ${traceShort}`,
          `接收于 ${nowIso.slice(0, 19).replace('T', ' ')}；复核前不改判 —— 补件也要对得上原始散点。`,
        ].join('；'),
        venue: '拟合参量补件',
        strategy: String(focused.modelLabel ?? '待填'),
        keyMetric: focused.r2 !== undefined ? `R²=${String(focused.r2)}` : '—',
        sourceDoi: base.anchor.source_doi_or_url,
        verificationLevel: base.anchor.verification_level,
        verdict: '待复核',
        dockerfile: dockerfileOf(`拟合参量补件 · ${String(focused.datasetId ?? '未知数据集')}`),
      } satisfies RowSeed;
    }

    const doiList = Array.isArray(data.doiBundle) ? data.doiBundle.map(String) : [];
    const first = doiList[0] ?? base.anchor.source_doi_or_url;
    return {
      ...base,
      title: `待核验 · ${String(data.title ?? data.venue ?? first)}`,
      meta: `来自 ${sourceApp} · paper_doi_bundle · ${String(doiList.length)} DOI · 未开检`,
      detail: [
        `收到 ${String(doiList.length)} 条 DOI${doiList.length === 0 ? '（未带 DOI，仅凭锚点定位）' : `（首条 ${first}）`}`,
        `下一步：clone 仓库 → 生成 Docker 环境 → 跑 ${REPRO_CHECKS.length} 项标准检查；trace ${traceShort}`,
        `接收于 ${nowIso.slice(0, 19).replace('T', ' ')}`,
      ].join('；'),
      venue: String(data.venue ?? '待填期刊'),
      strategy: String(data.strategy ?? '待填方法'),
      keyMetric: String(data.keyMetric ?? '—'),
      sourceDoi: first,
      verificationLevel: base.anchor.verification_level,
      verdict: '未开检',
      dockerfile: dockerfileOf(`待核验 · ${String(data.venue ?? first)}`),
    } satisfies RowSeed;
  },

  csvOf: (rows) => ({
    header: [
      '论文',
      '期刊/预印本',
      '方法',
      '关键指标',
      '通过',
      '警告',
      '失败',
      '结论',
      'DOI',
      '证据等级',
      '最后修改',
    ],
    rows: rows.map((row) => [
      String(row.paperId ?? row.id),
      String(row.venue ?? ''),
      String(row.strategy ?? ''),
      String(row.keyMetric ?? ''),
      Number(row.passCount ?? 0),
      Number(row.warnCount ?? 0),
      Number(row.failCount ?? 0),
      String(row.verdict ?? ''),
      String(row.sourceDoi ?? ''),
      String(row.verificationLevel ?? ''),
      String(row.updatedAt ?? ''),
    ]),
  }),
});
