import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

/** SSR 安全的「是否已挂载」标记（Canvas/ResizeObserver 只在挂载后启用）。 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return mounted;
}

/**
 * 受控 / 非受控双模式状态。
 *
 * 仪器组件库的硬约束是「受控组件，props in / events out」（ADR-07），
 * 但 demo 与单测里希望不传 value 也能玩，故提供受控可选、非受控兜底的写法。
 * 受控判定用 `value !== undefined` 而非 prop 存在性，允许显式传 undefined 切回受控。
 */
export function useControllableState<T>(
  value: T | undefined,
  defaultValue: T,
  onChange?: (next: T) => void,
): [T, (next: T) => void] {
  const isControlled = value !== undefined;
  const [internal, setInternal] = useState<T>(defaultValue);
  const current = isControlled ? (value as T) : internal;

  const set = useCallback(
    (next: T) => {
      if (!isControlled) setInternal(next);
      onChange?.(next);
    },
    [isControlled, onChange],
  );

  return [current, set];
}

/**
 * 受控 setter 的稳定引用版本。
 *
 * 拖动旋钮时每一帧都会调用 setter；若 setter 身份每帧变化，
 * 下游 memo 全部失效。这里用 ref 持有最新 onChange，保证 setter 恒定。
 */
export function useStableSetter<T>(
  value: T | undefined,
  setValue: Dispatch<SetStateAction<T>>,
  onChange?: (next: T) => void,
): (next: T) => void {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const isControlled = value !== undefined;
  return useCallback(
    (next: T) => {
      if (!isControlled) setValue(next);
      onChangeRef.current?.(next);
    },
    [isControlled, setValue],
  );
}

/**
 * `prefers-reduced-motion` 订阅。
 *
 * 视觉体系文档 §6.4 明确指出原设计 0 处覆盖，且 `pulse-orb` 是无限循环动画。
 * 所有组件的装饰性动画都必须走这个 hook —— CSS 侧还有一层媒体查询兜底，
 * 双层保险是因为 Canvas 绘制无法被 CSS 关掉。
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const listener = (event: MediaQueryListEvent) => setReduced(event.matches);
    // Safari < 14 只有 addListener
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', listener);
      return () => query.removeEventListener('change', listener);
    }
    query.addListener(listener);
    return () => query.removeListener(listener);
  }, []);

  return reduced;
}

/**
 * 元素尺寸观测（Canvas 高分屏适配的输入）。
 * 返回 ref 与尺寸；SSR 首帧给 fallback，避免 0 宽高导致画布空白。
 */
export function useElementSize<T extends HTMLElement>(
  fallback: { width: number; height: number },
): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState(fallback);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const box = entry.contentRect;
      setSize((prev) =>
        prev.width === box.width && prev.height === box.height
          ? prev
          : { width: box.width, height: box.height },
      );
    });
    observer.observe(node);
    return () => observer.disconnect();
    // fallback 有意不进依赖：它是常量对象，进依赖会每帧重建 observer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [ref, size];
}

/** 设备像素比（封顶 2，4K 屏上 canvas 面积不会失控）。 */
export function useDevicePixelRatio(max = 2): number {
  const [dpr, setDpr] = useState(1);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const read = () => setDpr(Math.min(max, window.devicePixelRatio || 1));
    read();
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', read);
      return () => query.removeEventListener('change', read);
    }
    return undefined;
  }, [max]);
  return dpr;
}

/** 上次渲染值（动画过渡的起点计算）。 */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref.current;
}

/** 稳定的唯一 id 前缀（SSR 与客户端一致，不依赖随机数）。 */
let uidCounter = 0;
export function useUid(prefix = 'iu'): string {
  const ref = useRef<string | null>(null);
  if (ref.current === null) {
    uidCounter += 1;
    ref.current = `${prefix}-${uidCounter}`;
  }
  return ref.current;
}

/** 数值变化时的 CSS 过渡开关（首帧不要过渡，否则从 0 跳变）。 */
export function useHasValue<T>(value: T): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    setHas(true);
  }, [value]);
  return has;
}

/** 把 ref 列表折叠为数组（键盘导航用）。 */
export function useStableCallback<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useMemo(() => (...args: A) => ref.current(...args), []);
}
