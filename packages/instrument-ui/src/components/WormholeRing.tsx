import { useCallback, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../lib/cx';
import { accentStyle } from '../lib/accent';
import type { InstrumentAccent } from '../lib/accent';
import { usePrefersReducedMotion, useUid } from '../lib/hooks';
import { clamp, formatFixed, polarToCartesian } from '../lib/math';
import '../styles/components/wormhole.css';

/** 环上的目标微站节点。 */
export interface WormholeTarget {
  /** 唯一 id。 */
  id: string;
  /** 站名，如「Xingmen Mentor」。 */
  name: string;
  /** 域名。 */
  domain?: string;
  /** 强调色。 */
  accent?: InstrumentAccent;
  /** 该站声明可接收的 payload_type（契约 W3 校验用）。 */
  accepts?: readonly string[];
  /** 是否禁用（不接受本次投送）。 */
  disabled?: boolean;
}

/**
 * 虫洞环状态机。与 `specs/contracts/wormhole-envelope.schema.json` 的校验流程对齐：
 *   idle → armed（开始拖拽）→ dragging（环张开）→ valid | invalid（本地 schema 校验结果）
 *        → committing（已发收据，等 mx_idt）→ idle
 */
export type WormholeRingState =
  | 'idle'
  | 'armed'
  | 'dragging'
  | 'valid'
  | 'invalid'
  | 'committing';

export interface WormholeRingProps {
  /** 是否张开（受控）。 */
  open?: boolean;
  /** 状态机（受控）。 */
  state?: WormholeRingState;
  /** 环上分布的目标站。 */
  targets?: readonly WormholeTarget[];
  /** 当前选中的目标 id。 */
  selectedTargetId?: string;
  /** 悬停目标（null 表示离开）。 */
  onTargetHover?: (id: string | null) => void;
  /** 选中目标。 */
  onTargetSelect?: (target: WormholeTarget) => void;
  /** 取消（Esc / 点环外）。 */
  onCancel?: () => void;
  /** 投送（松手落在目标上）。 */
  onCommit?: (target: WormholeTarget) => void;

  /** 环直径（px），默认 420。 */
  size?: number;
  /** 载荷摘要（环中心显示），如「curve_fit_parameters」。 */
  payloadSummary?: string;
  /** 载荷类型（契约枚举）。 */
  payloadType?: string;
  /** 证据锚点数量（契约要求 ≥ 1）。 */
  evidenceCount?: number;
  /** 校验失败文案（环体转红）。 */
  errorMessage?: string;
  /** 已在途的收据 id（committing 态显示）。 */
  receiptId?: string;
  /** 环中心自定义内容。 */
  children?: ReactNode;
  /** 强调色，默认 violet（开放生态/SDK 插槽的语义色）。 */
  accent?: InstrumentAccent;
  /** 是否渲染等价数据（无障碍列表），默认 true。 */
  accessibleList?: boolean;
  className?: string;
  style?: CSSProperties;
  'data-testid'?: string;
}

const STATE_TEXT: Record<WormholeRingState, string> = {
  idle: '待命',
  armed: '已武装',
  dragging: '拖拽中 · 环体张开',
  valid: '校验通过 · 可投送',
  invalid: '校验失败 · 已阻断',
  committing: '投送中 · 等待收据',
};

/**
 * `<WormholeRing>` 跨站虫洞环。
 *
 * 业务背景（架构文档 §5 / ADR-08）：Q3 核心交互「拖拽即张开虫洞环」在原 bundle 里
 * **未实现**（只有点击弹窗 + 文案）。本组件把它落成真交互：
 * - 环张合：`process: scale()` + `opacity`，纯 CSS transition，无逐帧 JS；
 * - 环体旋转：CSS `rotate` 无限动画（全息 `conic-gradient`），reduced-motion 下停；
 * - 目标节点沿椭圆分布，hover 放大（transform），选中时高亮 + 连线到中心；
 * - 校验失败（`state="invalid"`）时环体整体转 rose + 抖动 1 次后静止（不无限抖，
 *   无限抖动是前庭敏感用户的天敌）。
 *
 * 关键取舍：环的**视觉反馈在本地完成**（架构文档 ADR-08 的缓解措施：
 * 「拖拽过程中的视觉反馈全部在 hub 层完成，只在松手瞬间发一次消息」）。
 */
export function WormholeRing({
  open,
  state = 'idle',
  targets = [],
  selectedTargetId,
  onTargetHover,
  onTargetSelect,
  onCancel,
  onCommit,
  size = 420,
  payloadSummary,
  payloadType,
  evidenceCount,
  errorMessage,
  receiptId,
  children,
  accent = 'violet',
  accessibleList = true,
  className,
  style,
  ...rest
}: WormholeRingProps) {
  const uid = useUid('iu-wormhole');
  const reducedMotion = usePrefersReducedMotion();
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const isOpen = open ?? (state !== 'idle' && state !== 'invalid');
  const isInvalid = state === 'invalid';
  const isCommitting = state === 'committing';

  // 环直径的 1/2 作为坐标基准
  const radiusPx = size / 2;
  const viewBox = 200;
  const center = viewBox / 2;
  const nodeRadius = center - 14;

  const placedTargets = useMemo(
    () =>
      targets.map((target, index) => {
        // 从 12 点开始顺时针均分
        const angle = (360 / Math.max(1, targets.length)) * index;
        const point = polarToCartesian(center, center, nodeRadius, angle);
        return { target, angle, point };
      }),
    [nodeRadius, targets],
  );

  const hovered = useMemo(
    () => targets.find((t) => t.id === hoveredId) ?? null,
    [hoveredId, targets],
  );

  const handleEnter = useCallback(
    (target: WormholeTarget) => {
      setHoveredId(target.id);
      onTargetHover?.(target.id);
    },
    [onTargetHover],
  );

  const handleLeave = useCallback(() => {
    setHoveredId(null);
    onTargetHover?.(null);
  }, [onTargetHover]);

  const validTargets = placedTargets.filter((p) => !p.target.disabled);

  return (
    <div
      className={cx(
        'iu-root',
        'iu-wormhole',
        isOpen && 'is-open',
        isInvalid && 'is-invalid',
        isCommitting && 'is-committing',
        className,
      )}
      style={accentStyle(accent, {
        ...style,
        width: `${size}px`,
        height: `${size}px`,
      })}
      data-state={state}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      role="dialog"
      aria-modal={false}
      aria-label="跨站虫洞环"
      aria-hidden={isOpen ? undefined : true}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel?.();
        }
      }}
      {...rest}
    >
      {/* 全息环体（conic-gradient 旋转，纯 CSS） */}
      <div className="iu-wormhole__aperture" aria-hidden="true">
        <span className="iu-wormhole__halo" />
        <span className="iu-wormhole__conic" />
        <span className="iu-wormhole__ring-outer" />
        <span className="iu-wormhole__ring-inner" />
        <span className="iu-wormhole__iris" />
      </div>

      {/* SVG：节点环 + 连线 */}
      <svg
        className="iu-wormhole__svg"
        viewBox={`0 0 ${viewBox} ${viewBox}`}
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <radialGradient id={`${uid}-nodeglow`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgb(var(--iu-accent-rgb) / 0.7)" />
            <stop offset="100%" stopColor="rgb(var(--iu-accent-rgb) / 0)" />
          </radialGradient>
          <linearGradient id={`${uid}-link`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="rgb(var(--iu-accent-rgb) / 0.1)" />
            <stop offset="50%" stopColor="rgb(var(--iu-accent-rgb) / 0.65)" />
            <stop offset="100%" stopColor="rgb(var(--iu-accent-rgb) / 0.1)" />
          </linearGradient>
        </defs>

        {/* 节点分布圆（虚线） */}
        <circle
          cx={center}
          cy={center}
          r={nodeRadius}
          fill="none"
          stroke="rgb(var(--iu-accent-rgb) / 0.2)"
          strokeWidth="0.4"
          strokeDasharray="1 2"
        />

        {/* 目标到中心的连线（选中/悬停时亮起） */}
        {placedTargets.map(({ target, point }) => {
          const active = selectedTargetId === target.id || hoveredId === target.id;
          return (
            <line
              key={`link-${target.id}`}
              x1={point.x}
              y1={point.y}
              x2={center}
              y2={center}
              stroke={active ? `url(#${uid}-link)` : `rgb(var(--iu-accent-rgb) / 0.08)`}
              strokeWidth={active ? 0.9 : 0.3}
              strokeDasharray={active ? undefined : '1 2'}
            />
          );
        })}
      </svg>

      {/* 目标节点（DOM，便于文字与无障碍） */}
      {placedTargets.map(({ target, point }) => {
        const isSelected = selectedTargetId === target.id;
        const isHovered = hoveredId === target.id;
        const targetAccent = target.accent;
        return (
          <button
            key={target.id}
            type="button"
            className={cx(
              'iu-wormhole__node',
              'iu-focus',
              isSelected && 'is-selected',
              isHovered && 'is-hovered',
              target.disabled && 'is-disabled',
            )}
            style={
              {
                left: `${(point.x / viewBox) * 100}%`,
                top: `${(point.y / viewBox) * 100}%`,
                ...(targetAccent
                  ? {
                      '--iu-accent': `var(--iu-${targetAccent})`,
                      '--iu-accent-bright': `var(--iu-${targetAccent}-bright)`,
                      '--iu-accent-rgb': `var(--iu-${targetAccent}-rgb)`,
                    }
                  : {}),
              } as CSSProperties
            }
            disabled={target.disabled}
            tabIndex={isOpen ? 0 : -1}
            aria-pressed={isSelected}
            aria-label={`投送到 ${target.name}${target.domain ? ` · ${target.domain}` : ''}${
              target.disabled ? '（不可接收）' : ''
            }`}
            onMouseEnter={() => handleEnter(target)}
            onMouseLeave={handleLeave}
            onFocus={() => handleEnter(target)}
            onBlur={handleLeave}
            onClick={() => onTargetSelect?.(target)}
            onDoubleClick={() => onCommit?.(target)}
          >
            <span className="iu-wormhole__node-orb" aria-hidden="true" />
            <span className="iu-wormhole__node-name">{target.name}</span>
            {target.accepts && target.accepts.length > 0 ? (
              <span className="iu-wormhole__node-accepts iu-num">
                {target.accepts.length} accepts
              </span>
            ) : null}
          </button>
        );
      })}

      {/* 环中心面板 */}
      <div className="iu-wormhole__core">
        {children ?? (
          <>
            <span className="iu-wormhole__core-state" data-state={state}>
              {STATE_TEXT[state]}
            </span>

            {payloadType ? (
              <span className="iu-wormhole__core-payload">
                <span className="iu-label">payload_type</span>
                <span className="iu-num iu-wormhole__core-value">{payloadType}</span>
              </span>
            ) : payloadSummary ? (
              <span className="iu-wormhole__core-payload">
                <span className="iu-num iu-wormhole__core-value">{payloadSummary}</span>
              </span>
            ) : null}

            {/* 证据锚点计数：契约强制 ≥ 1，这里用红色警示体现「合规红线」 */}
            {evidenceCount !== undefined ? (
              <span
                className={cx(
                  'iu-wormhole__core-evidence',
                  evidenceCount === 0 && 'is-empty',
                )}
              >
                <span className="iu-label">evidence</span>
                <span className="iu-num iu-wormhole__core-value">
                  {evidenceCount === 0 ? '缺失（禁止投送）' : `${evidenceCount} anchors`}
                </span>
              </span>
            ) : null}

            {isCommitting && receiptId ? (
              <span className="iu-wormhole__core-receipt iu-num">
                receipt {receiptId.slice(0, 12)}…
              </span>
            ) : null}

            {isInvalid && errorMessage ? (
              <span className="iu-wormhole__core-error" role="alert">
                {errorMessage}
              </span>
            ) : null}
          </>
        )}
      </div>

      {/* 悬停目标详情 */}
      {hovered && isOpen ? (
        <div className="iu-wormhole__tip" role="status" aria-live="polite">
          <span className="iu-wormhole__tip-title">{hovered.name}</span>
          {hovered.domain ? (
            <span className="iu-wormhole__tip-domain iu-num">{hovered.domain}</span>
          ) : null}
          {hovered.accepts && hovered.accepts.length > 0 ? (
            <span className="iu-wormhole__tip-accepts">
              {hovered.accepts.map((type) => (
                <span key={type} className="iu-wormhole__tip-chip iu-num">
                  {type}
                </span>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* 状态条 */}
      <div className="iu-wormhole__status" aria-hidden="true">
        <span className="iu-wormhole__status-dot" data-state={state} />
        <span className="iu-wormhole__status-text">{STATE_TEXT[state]}</span>
        <span className="iu-wormhole__status-count iu-num">
          {validTargets.length}/{targets.length} 可投送
        </span>
      </div>

      {/* 取消按钮 */}
      {isOpen ? (
        <button
          type="button"
          className="iu-wormhole__cancel iu-focus"
          onClick={() => onCancel?.()}
          aria-label="关闭虫洞环"
          tabIndex={0}
        >
          ✕
        </button>
      ) : null}

      {accessibleList ? (
        <ul className="iu-sr-only">
          <li>虫洞环状态：{STATE_TEXT[state]}</li>
          {payloadType ? <li>载荷类型：{payloadType}</li> : null}
          {evidenceCount !== undefined ? <li>证据锚点：{evidenceCount} 条</li> : null}
          {targets.map((target) => (
            <li key={target.id}>
              {target.name}
              {target.domain ? `（${target.domain}）` : ''}
              {target.disabled ? '｜不可接收' : '｜可投送'}
              {target.accepts && target.accepts.length > 0
                ? `｜接受 ${target.accepts.join('、')}`
                : ''}
            </li>
          ))}
        </ul>
      ) : null}

      {/* 环体旋转周期与尺寸的 CSS 变量 */}
      <span
        className="iu-sr-only"
        aria-hidden="true"
        style={
          {
            '--iu-wormhole-radius': `${radiusPx}px`,
          } as CSSProperties
        }
      >
        {formatFixed(size, 0)}
      </span>
    </div>
  );
}

export { STATE_TEXT as WORMHOLE_STATE_TEXT };
