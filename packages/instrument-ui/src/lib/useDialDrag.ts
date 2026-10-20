import { useCallback, useEffect, useRef, useState } from 'react';
import { clamp } from './math';

export interface DragState {
  /** 是否正在拖动（pointer 按下后为 true）。 */
  dragging: boolean;
  /** 本次拖动的累计角度增量（度）。用于旋钮的「无限旋转」手感。 */
  angleDelta: number;
}

export interface UseDialDragOptions {
  /** 拖动 1px 对应的数值增量（像素→数值的灵敏度）。 */
  sensitivity?: number;
  /** 数值步进（拖动结束时吸附）。 */
  step?: number;
  min: number;
  max: number;
  value: number;
  /** 数值变化回调（拖动过程中高频调用）。 */
  onChange: (next: number) => void;
  /** 拖动开始/结束（外部可用来暂停昂贵的重算）。 */
  onDragStart?: () => void;
  onDragEnd?: () => void;
  disabled?: boolean;
}

export interface DialDragHandlers {
  dragging: boolean;
  angle: number;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (event: React.PointerEvent<HTMLElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  /** 聚焦态（键盘提示环）。 */
  focused: boolean;
  onFocus: () => void;
  onBlur: () => void;
}

interface DragOrigin {
  pointerId: number;
  x: number;
  y: number;
  startValue: number;
  lastAngle: number;
  accumulated: number;
}

/**
 * 阻尼旋钮的拖拽内核。
 *
 * 设计取舍（性能铁律：不用 JS 逐帧驱动动画）：
 * - 拖动过程中**只算值**，不写 DOM 样式；视觉位移全部交给 CSS transition。
 * - 指针位移用「位移向量与初始方向」的叉积/点积算角度增量，实现**无限旋转**
 *   （鼠标绕过屏幕边缘还能继续加），而不是简单的上下拖动——这是「精密阻尼
 *   旋钮」的手感关键。
 * - `pointerId` 严格匹配，避免多指/误触导致状态卡死。
 * - 键盘：方向键 = step，PageUp/PageDown = 10×step，Home/End = 极值。
 */
export function useDialDrag(options: UseDialDragOptions): DialDragHandlers {
  const {
    sensitivity = 0.6,
    step = 1,
    min,
    max,
    value,
    onChange,
    onDragStart,
    onDragEnd,
    disabled = false,
  } = options;

  const [dragging, setDragging] = useState(false);
  const [angle, setAngle] = useState(0);
  const [focused, setFocused] = useState(false);
  const originRef = useRef<DragOrigin | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const finish = useCallback((pointerId?: number) => {
    const origin = originRef.current;
    if (!origin) return;
    if (pointerId !== undefined && origin.pointerId !== pointerId) return;
    originRef.current = null;
    setDragging(false);
    optionsRef.current.onDragEnd?.();
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (disabled || event.button !== 0) return;
      const target = event.currentTarget;
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // 部分浏览器在合成事件下拒绝捕获，降级为不捕获（仍可拖，只是出边界会停）
      }
      originRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startValue: valueRef.current,
        lastAngle: Math.atan2(event.clientY, event.clientX),
        accumulated: 0,
      };
      setDragging(true);
      optionsRef.current.onDragStart?.();
      event.preventDefault();
    },
    [disabled],
  );

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const origin = originRef.current;
    if (!origin || origin.pointerId !== event.pointerId) return;

    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;

    // 主通道：垂直位移（向上增大），符合「推子/旋钮」直觉
    const linear = -dy * sensitivity;
    // 辅助通道：角度增量（无限旋转），在指针绕圈时提供额外增益
    const currentAngle = Math.atan2(event.clientY, event.clientX);
    let deltaAngle = currentAngle - origin.lastAngle;
    if (deltaAngle > Math.PI) deltaAngle -= Math.PI * 2;
    if (deltaAngle < -Math.PI) deltaAngle += Math.PI * 2;
    origin.lastAngle = currentAngle;
    origin.accumulated += (deltaAngle * 180) / Math.PI;
    const angular = origin.accumulated * sensitivity * 0.12;

    const next = clamp(
      origin.startValue + linear + angular,
      optionsRef.current.min,
      optionsRef.current.max,
    );
    setAngle(origin.accumulated);
    if (next !== valueRef.current) {
      valueRef.current = next;
      optionsRef.current.onChange(next);
    }
    // 防止拖动时选中页面文字
    if (Math.abs(dx) + Math.abs(dy) > 2) event.preventDefault();
  }, [sensitivity]);

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      finish(event.pointerId);
    },
    [finish],
  );

  const onPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      finish(event.pointerId);
    },
    [finish],
  );

  const onLostPointerCapture = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      finish(event.pointerId);
    },
    [finish],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (disabled) return;
      const opts = optionsRef.current;
      const current = valueRef.current;
      const big = step * 10;
      let next: number | null = null;

      switch (event.key) {
        case 'ArrowUp':
        case 'ArrowRight':
          next = clamp(current + (event.shiftKey ? big : step), min, max);
          break;
        case 'ArrowDown':
        case 'ArrowLeft':
          next = clamp(current - (event.shiftKey ? big : step), min, max);
          break;
        case 'PageUp':
          next = clamp(current + big, min, max);
          break;
        case 'PageDown':
          next = clamp(current - big, min, max);
          break;
        case 'Home':
          next = opts.min;
          break;
        case 'End':
          next = opts.max;
          break;
        default:
          return;
      }

      event.preventDefault();
      if (next !== null && next !== current) {
        valueRef.current = next;
        opts.onChange(next);
        opts.onDragEnd?.();
      }
    },
    [disabled, max, min, step],
  );

  // 卸载时若仍在拖动，清理状态，避免 onDragEnd 永不触发
  useEffect(
    () => () => {
      if (originRef.current) {
        originRef.current = null;
        optionsRef.current.onDragEnd?.();
      }
    },
    [],
  );

  return {
    dragging,
    angle,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture,
    onKeyDown,
    focused,
    onFocus: useCallback(() => setFocused(true), []),
    onBlur: useCallback(() => setFocused(false), []),
  };
}
