import { useId, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../lib/cx';
import { clamp } from '../lib/math';

/**
 * 证据校验等级 —— 与 `specs/contracts/wormhole-envelope.schema.json` 的
 * `verification_level` 枚举**逐字一致**（三档，不可擅自扩展）。
 * 这是组件库与契约层唯一的硬耦合点，故意做成 union type 让 TS 在编译期挡住非法值。
 */
export type VerificationLevel = 'Level_A_Verified' | 'Level_B_Preprint' | 'Retracted_Warning';

/** 三档的语义色：绿 / 黄 / 红（与视觉体系文档 §2.5 的实测对比度对齐）。 */
export const VERIFICATION_TONE: Readonly<
  Record<VerificationLevel, { tone: 'positive' | 'warning' | 'danger'; label: string; short: string }>
> = {
  Level_A_Verified: { tone: 'positive', label: 'Level A · 已双验', short: 'A' },
  Level_B_Preprint: { tone: 'warning', label: 'Level B · 仅预印本', short: 'B' },
  Retracted_Warning: { tone: 'danger', label: '已命中撤稿/勘误库', short: '!' },
};

/**
 * PDF 坐标框：`[x0, y0, x1, y1]`，单位 pt（PDF 用户空间）。
 * 与虫洞契约 `evidence_anchors[].bbox` 同构。
 */
export type EvidenceBbox = readonly [number, number, number, number];

export interface EvidenceAnchor {
  /** DOI 或 URL（契约必填）。 */
  sourceDoiOrUrl: string;
  /** PDF 页码（1-based）。 */
  pdfPage?: number;
  /** PDF 坐标框，悬停时展示。 */
  bbox?: EvidenceBbox;
  /** 校验等级（契约必填）。 */
  verificationLevel: VerificationLevel;
  /** 可选补充说明（如「Fig. 3b」「人工复核 2026-10-12」）。 */
  note?: string;
}

export type EvidenceLinkSize = 'sm' | 'md' | 'lg';

export interface EvidenceLinkProps {
  /** 单条证据。与 `anchors` 二选一。 */
  anchor?: EvidenceAnchor;
  /** 多条证据（如一个数值由 3 篇论文共同支撑）；聚合显示。 */
  anchors?: EvidenceAnchor[];
  /** 点击锚点（打开 PDF / 复制 DOI），由调用方决定行为。 */
  onActivate?: (anchor: EvidenceAnchor, event: React.MouseEvent) => void;
  /** 徽章尺寸，默认 sm（表格单元格里放得下）。 */
  size?: EvidenceLinkSize;
  /** 是否常显 DOI（否则只显等级与页码，DOI 在悬停卡里）。 */
  showDoi?: boolean;
  /** 是否显示 bbox 悬停卡，默认 true。 */
  showBbox?: boolean;

  className?: string;
  style?: CSSProperties;
  'data-testid'?: string;
}

const SIZE_CLASS: Record<EvidenceLinkSize, string> = { sm: 'is-sm', md: 'is-md', lg: 'is-lg' };

/**
 * `<EvidenceLink>` 证据锚点徽章。
 *
 * 它解决的合规问题（WBS 验收项 S3-MS09）：Matrix-Cross 的每个实验参量都必须能
 * 悬停激射到 PDF 原文坐标，「缺锚点的单元格标灰不可用」。因此本组件有两种
 * **必须都实现**的视觉状态：
 *   - 有证据：三档色（绿/黄/红）+ 可点击
 *   - 无证据：灰色 + `aria-disabled` + 不可点击（正向的诚实降级）
 *
 * 无障碍要点：颜色**不是唯一通道**——每档还带一个字母标记（A / B / !），
 * 供色觉障碍用户与灰度打印识别（WCAG 1.4.1）。
 */
export function EvidenceLink({
  anchor,
  anchors,
  onActivate,
  size = 'sm',
  showDoi = false,
  showBbox = true,
  className,
  style,
  ...rest
}: EvidenceLinkProps) {
  const uid = useId();
  const [hovered, setHovered] = useState(false);

  const list = useMemo<EvidenceAnchor[]>(() => {
    if (anchors && anchors.length > 0) return anchors;
    if (anchor) return [anchor];
    return [];
  }, [anchor, anchors]);

  const primary = list[0];
  const satisfied = list.length > 0;

  const tone = primary ? VERIFICATION_TONE[primary.verificationLevel] : null;

  // 聚合时取「最严重」的一档作为整体状态：只要有一条被撤稿，整体就是红
  const aggregateLevel = useMemo<VerificationLevel>(() => {
    if (list.some((a) => a.verificationLevel === 'Retracted_Warning')) return 'Retracted_Warning';
    if (list.some((a) => a.verificationLevel === 'Level_B_Preprint')) return 'Level_B_Preprint';
    return 'Level_A_Verified';
  }, [list]);

  const aggregateTone = VERIFICATION_TONE[aggregateLevel];

  const handleClick = (event: React.MouseEvent) => {
    if (!primary || !onActivate) return;
    onActivate(primary, event);
  };

  const bboxText = primary?.bbox
    ? `[${primary.bbox.map((v) => clamp(v, -1e6, 1e6).toFixed(1)).join(', ')}]`
    : null;

  const pageText = primary?.pdfPage !== undefined ? `p.${primary.pdfPage}` : null;

  return (
    <span
      className={cx(
        'iu-root',
        'iu-evidence',
        SIZE_CLASS[size],
        satisfied ? 'is-linked' : 'is-empty',
        onActivate && satisfied && 'is-clickable',
        className,
      )}
      style={style}
      data-level={primary?.verificationLevel ?? 'none'}
      {...rest}
    >
      <button
        type="button"
        className={cx('iu-evidence__badge', 'iu-focus')}
        data-tone={satisfied ? aggregateTone.tone : 'neutral'}
        disabled={!satisfied || !onActivate}
        aria-disabled={!satisfied || !onActivate || undefined}
        aria-describedby={showBbox && (bboxText || pageText) ? `${uid}-tip` : undefined}
        onClick={handleClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        title={satisfied ? undefined : '缺证据锚点 · 不可引用'}
      >
        <span className="iu-evidence__glyph" aria-hidden="true">
          {satisfied ? aggregateTone.short : '—'}
        </span>
        <span className="iu-evidence__text">
          <span className="iu-evidence__level">
            {satisfied ? aggregateLevel.replace(/_/g, ' ') : 'No anchor'}
          </span>
          {pageText ? <span className="iu-evidence__page">{pageText}</span> : null}
        </span>
        {list.length > 1 ? <span className="iu-evidence__count">×{list.length}</span> : null}
      </button>

      {showDoi && primary ? (
        <span className="iu-evidence__doi iu-num" title={primary.sourceDoiOrUrl}>
          {primary.sourceDoiOrUrl}
        </span>
      ) : null}

      {showBbox && hovered && satisfied && primary ? (
        <span className="iu-evidence__tip" id={`${uid}-tip`} role="tooltip">
          <span className="iu-evidence__tip-row">
            <span className="iu-label">Source</span>
            <span className="iu-num iu-evidence__tip-value">{primary.sourceDoiOrUrl}</span>
          </span>
          {primary.pdfPage !== undefined ? (
            <span className="iu-evidence__tip-row">
              <span className="iu-label">Page</span>
              <span className="iu-num iu-evidence__tip-value">{primary.pdfPage}</span>
            </span>
          ) : null}
          {bboxText ? (
            <span className="iu-evidence__tip-row">
              <span className="iu-label">bbox (pt)</span>
              <span className="iu-num iu-evidence__tip-value">{bboxText}</span>
            </span>
          ) : null}
          <span className="iu-evidence__tip-row">
            <span className="iu-label">Level</span>
            <span className="iu-evidence__tip-value">{VERIFICATION_TONE[primary.verificationLevel].label}</span>
          </span>
          {primary.note ? (
            <span className="iu-evidence__tip-note">{primary.note}</span>
          ) : null}
          {primary.bbox ? <BboxPreview bbox={primary.bbox} /> : null}
        </span>
      ) : null}
    </span>
  );
}

/** bbox 的可视化预览：把坐标框画在归一化的「纸页」上。 */
function BboxPreview({ bbox }: { bbox: EvidenceBbox }): ReactNode {
  const [x0, y0, x1, y1] = bbox;
  // 假设标准 A4 页面（595 × 842 pt），宽高比固定，不用真实页面尺寸
  const pageW = 595;
  const pageH = 842;
  const left = clamp(Math.min(x0, x1) / pageW, 0, 1) * 100;
  const top = clamp(1 - Math.max(y0, y1) / pageH, 0, 1) * 100;
  const width = clamp(Math.abs(x1 - x0) / pageW, 0.02, 1) * 100;
  const height = clamp(Math.abs(y1 - y0) / pageH, 0.01, 1) * 100;

  return (
    <span className="iu-evidence__bbox" aria-hidden="true">
      <span className="iu-evidence__bbox-page" />
      <span
        className="iu-evidence__bbox-mark"
        style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
      />
    </span>
  );
}

export { VERIFICATION_TONE as EVIDENCE_VERIFICATION_TONE };
