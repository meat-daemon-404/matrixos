'use client';

/**
 * WormholeRing · 虫洞投送环
 * ==========================================================================
 * 交互（架构 §5.2 时序）：按住数据卡片拖拽 → 张开环体 → 松手投送到目标微站。
 *
 * 三条**必须在 UI 层落实**的契约规则（不是服务端的事）：
 *   W1 证据不可为空：evidenceCount === 0 时环体转红 + 禁止投送（schema 的 minItems:1）
 *   W3 只投给声明过的目标：target 的 accepts 不含本 payload_type 时该目标不可选
 *   W2 数据不过服务端：环里只显示摘要与证据条数，**不显示 payload 正文**（那是内存里的东西）
 *
 * 性能（ADR-08 负面清单："拖拽过程中的视觉反馈全部在 hub 层完成，只在松手瞬间发一次消息"）：
 *   - 拖拽期间只更新一个 ghost 的 CSS transform（跟随指针），不发 postMessage；
 *   - 环的张合是 transform scale + opacity；
 *   - **松手瞬间才**调一次 onCommit。
 *
 * 与 ui-library 的 WormholeRing 同签名，库就位后由适配器替换。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MicrositeStation, PayloadType } from '../lib/microsites.generated';
import { WORMHOLE_TARGET_ATTR } from '../lib/wormhole-contract';

export type WormholeRingState = 'idle' | 'armed' | 'dragging' | 'valid' | 'invalid' | 'committing';

export interface WormholeTarget {
  readonly station: MicrositeStation;
  /** 该目标是否声明可接收当前 payload_type（契约 W3） */
  readonly accepts: boolean;
}

export interface WormholeRingProps {
  readonly open: boolean;
  readonly state: WormholeRingState;
  /** 候选目标（已按 accepts 过滤或标注，由调用方决定；这里再兜一道） */
  readonly targets: readonly WormholeTarget[];
  readonly selectedTargetId: string | null;
  /** 投送的 payload 类型（来自源站 emit 声明） */
  readonly payloadType: PayloadType;
  /** 证据锚点条数 —— 为 0 时环体转红（契约 W1） */
  readonly evidenceCount: number;
  /** 载荷摘要（**只放摘要，不放正文**：W2 数据不过服务端，也不在 UI 里外泄） */
  readonly payloadSummary: string;
  readonly errorMessage?: string;
  readonly onTargetHover: (stationId: string | null) => void;
  readonly onCommit: (target: WormholeTarget) => void;
  readonly onCancel: () => void;
}

const RING_SIZE = 420;

/** 目标节点在环上的角度分布：从 -90°（正上）开始均分一圈 */
function targetAngle(index: number, total: number): number {
  return -90 + (360 / Math.max(total, 1)) * index;
}

export function WormholeRing({
  open,
  state,
  targets,
  selectedTargetId,
  payloadType,
  evidenceCount,
  payloadSummary,
  errorMessage,
  onTargetHover,
  onCommit,
  onCancel,
}: WormholeRingProps) {
  const ringRef = useRef<HTMLDivElement | null>(null);

  // Esc 取消：虫洞是个"会挡住全屏"的模态操作，必须有键盘退路
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  /** 环体状态：证据为空 / 有错误 → invalid，优先于外部传入的 state（W1 是红线） */
  const effectiveState: WormholeRingState = useMemo(() => {
    if (evidenceCount <= 0) return 'invalid';
    if (errorMessage) return 'invalid';
    return state;
  }, [evidenceCount, errorMessage, state]);

  const selectableTargets = useMemo(
    () => targets.filter((target) => target.accepts),
    [targets],
  );

  if (!open) return null;

  const blocked = effectiveState === 'invalid';

  return (
    <div className="wormhole-layer" role="dialog" aria-modal="true" aria-label="虫洞投送环">
      <div
        className="wormhole-ring"
        ref={ringRef}
        data-state={effectiveState}
        style={{ ['--ring-size' as string]: RING_SIZE + 'px' } as React.CSSProperties}
      >
        {/* 环心：摘要 + 证据 + 错误 */}
        <div className="wormhole-core">
          <span className="wormhole-title">虫洞投送 · {payloadType}</span>
          <span className="wormhole-summary">{payloadSummary}</span>
          <span className="wormhole-evidence">
            证据锚点 {evidenceCount} 条
            {evidenceCount > 0 ? ' · 可投送' : ' · 阻断'}
          </span>
          {evidenceCount <= 0 ? (
            <span className="wormhole-error">
              证据为空，禁止投送。契约要求 evidence_anchors 至少 1 条且含
              source_doi_or_url + verification_level（W1 红线）。
            </span>
          ) : null}
          {errorMessage ? <span className="wormhole-error">{errorMessage}</span> : null}
        </div>

        {/* 目标站节点 */}
        {targets.map((target, index) => {
          const angle = targetAngle(index, targets.length);
          const rad = (angle * Math.PI) / 180;
          const radius = RING_SIZE * 0.44;
          const left = 50 + (Math.cos(rad) * radius * 100) / RING_SIZE;
          const top = 50 + (Math.sin(rad) * radius * 100) / RING_SIZE;

          return (
            <button
              key={target.station.id}
              type="button"
              className="wormhole-target"
              /*
               * 松手落点命中标记：OrbitalHub 在 pointerup 时用 elementFromPoint
               * 反查这个属性来决定投给谁。放在 DOM 上而不是在 JS 里复算圆心，
               * 是为了让"命中判定"与"用户看到的布局"永远是同一份事实（见 onDragEnd 注释）。
               */
              {...{ [WORMHOLE_TARGET_ATTR]: target.station.id }}
              data-selected={selectedTargetId === target.station.id ? 'true' : 'false'}
              style={
                {
                  left: left + '%',
                  top: top + '%',
                  ['--target-accent' as string]: target.station.accent,
                } as React.CSSProperties
              }
              disabled={!target.accepts || blocked}
              title={
                !target.accepts
                  ? target.station.name + ' 未声明接收 ' + payloadType + '（契约 W3 拒绝）'
                  : blocked
                    ? '证据为空，无法投送'
                    : '投送到 ' + target.station.name
              }
              onPointerEnter={() => onTargetHover(target.station.id)}
              onPointerLeave={() => onTargetHover(null)}
              onClick={() => {
                if (target.accepts && !blocked) onCommit(target);
              }}
            >
              <b>{target.station.id}</b>
              <span>{target.station.name}</span>
            </button>
          );
        })}

        <div className="wormhole-cancel">
          <button type="button" className="btn" onClick={onCancel}>
            Esc 取消
          </button>
        </div>
      </div>

      {/* 可投送目标数提示 */}
      <span
        className="orbit-badge"
        style={{ position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)' }}
      >
        可投送目标 {selectableTargets.length} / {targets.length} · 松手或点击目标完成投送
      </span>
    </div>
  );
}

/** ── 拖拽源：数据卡片 ───────────────────────────────────────────────────── */

export interface DraggableCardProps {
  readonly label: string;
  readonly payloadType: PayloadType;
  readonly evidenceCount: number;
  /** 拖拽开始回调：交出 payload 摘要与证据数，供环体渲染 */
  readonly onDragStart: (payload: {
    readonly payloadType: PayloadType;
    readonly summary: string;
    readonly evidenceCount: number;
  }) => void;
  /** 松手时回调，带屏幕坐标（环体已过滤合法目标，这里坐标用于落点判定） */
  readonly onDragEnd: (position: { readonly x: number; readonly y: number }) => void;
  readonly onDragCancel: () => void;
}

/**
 * 拖拽数据卡。
 *
 * 用 pointer events 而不是 HTML5 drag-and-drop：后者在 iframe 里跨源会有
 * 数据传递限制，而且拖影样式不可控。pointer 事件在 hub 层完全自主。
 */
export function DraggableCard({
  label,
  payloadType,
  evidenceCount,
  onDragStart,
  onDragEnd,
  onDragCancel,
}: DraggableCardProps) {
  const [dragging, setDragging] = useState(false);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const pointerIdRef = useRef<number | null>(null);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // 只响应主键/触摸，忽略右键与中键
      if (event.button !== 0) return;
      pointerIdRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
      setGhost({ x: event.clientX, y: event.clientY });
      onDragStart({ payloadType, summary: label, evidenceCount });
    },
    [evidenceCount, label, onDragStart, payloadType],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      // 只更新 ghost 位置（一个 React state + 一个 transform），不发任何消息
      setGhost({ x: event.clientX, y: event.clientY });
    },
    [dragging],
  );

  const finish = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
      if (!dragging) return;
      const pointerId = pointerIdRef.current;
      if (pointerId !== null && event.currentTarget.hasPointerCapture(pointerId)) {
        event.currentTarget.releasePointerCapture(pointerId);
      }
      pointerIdRef.current = null;
      setDragging(false);
      setGhost(null);
      if (cancelled) {
        onDragCancel();
      } else {
        // 松手瞬间才发一次消息（ADR-08 的缓解措施）
        onDragEnd({ x: event.clientX, y: event.clientY });
      }
    },
    [dragging, onDragCancel, onDragEnd],
  );

  return (
    <>
      <div
        className="draggable-card"
        data-dragging={dragging ? 'true' : 'false'}
        role="button"
        tabIndex={0}
        aria-label={'拖拽投送：' + label}
        aria-grabbed={dragging}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finish(event, false)}
        onPointerCancel={(event) => finish(event, true)}
        onKeyDown={(event) => {
          // 键盘可达：Enter/Space 直接打开虫洞环（不拖拽）
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onDragStart({ payloadType, summary: label, evidenceCount });
          }
        }}
      >
        <span className="draggable-card-grip" aria-hidden="true">
          ⠿
        </span>
        <span>{label}</span>
        <span className="draggable-card-badge mono">证据 {evidenceCount}</span>
      </div>

      {dragging && ghost ? (
        <div className="drag-ghost" style={{ left: ghost.x, top: ghost.y }} aria-hidden="true">
          {label} → 虫洞
        </div>
      ) : null}
    </>
  );
}
