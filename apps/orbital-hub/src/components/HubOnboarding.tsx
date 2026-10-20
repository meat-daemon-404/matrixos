'use client';

/**
 * 总控台首次引导（spotlight 式分步导览）。
 *
 * 设计约束（来自 UI 图谱 Q1 的"双态合体"叙事）：
 *   - 引导必须能被**跳过**，且跳过与完成同样持久化 —— 否则老用户每次刷新都被打断；
 *   - 必须支持键盘（Esc 退出、←/→ 翻步、Enter 下一步），且焦点锁在引导卡片内；
 *   - `prefers-reduced-motion` 下不做位移与缩放，只保留透明度变化；
 *   - 聚光框用 `box-shadow` 挖洞而不是再叠一层遮罩 + 挖洞元素：
 *     前者只需一个元素且圆角随目标走，后者要算 clip-path，尺寸一变就错位。
 *
 * 与 hub 的耦合面收窄到：目标元素用 `data-onboard="<step.target>"` 标记，
 * 本组件只按属性查询 —— 这样引导步骤可以纯数据驱动，改步骤不用改组件。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** 引导完成标记的 localStorage key。改动它等于让所有人重新看一遍引导。 */
const STORAGE_KEY = 'matrixos:hub:onboarded:v1';

export interface OnboardStep {
  /** 对应 hub 里 `data-onboard="..."` 的元素；缺省则该步居中显示、无聚光框 */
  readonly target?: string;
  readonly title: string;
  readonly body: string;
}

export const ONBOARD_STEPS: readonly OnboardStep[] = [
  {
    target: 'orbit',
    title: '星轨引力场',
    body: '18 个旗舰微站按 7 条轨道分布。点任意胶囊即可把它的仪器挂到右侧架子上；同屏可挂 2~3 台。',
  },
  {
    target: 'rack',
    title: '仪器架',
    body: '挂上来的微站以 iframe 形式入驻。性能探针会按设备档位自动分配「几个面板同时存活」，其余降级为静态快照。',
  },
  {
    target: 'wormhole',
    title: '虫洞投送',
    body: '把下面的数据卡片拖到星轨上的目标站，就会张开虫洞环 —— 跨站的数据流转不需要离开总控台。',
  },
  {
    target: 'dock',
    title: '全局 Copilot',
    body: '底部的声波坞接受自然语言指令，会按复杂度自动路由到不同档位的模型。',
  },
];

/** 读取「是否已看过引导」。SSR 期间一律返回 true，避免水合时闪出引导层。 */
export function readOnboarded(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'done';
  } catch {
    // 隐私模式 / 禁用存储：当作看过，不要因为存储失败就反复弹
    return true;
  }
}

export function markOnboarded(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, 'done');
  } catch {
    /* 存储不可用时静默失败：引导本次关掉就够了 */
  }
}

/** 清除标记，让引导下次重新出现（给「?」按钮用）。 */
export function resetOnboarded(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
}

interface SpotlightRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

interface HubOnboardingProps {
  /** 受控的可见性。false 时组件不渲染任何东西。 */
  readonly open: boolean;
  readonly onClose: () => void;
}

const SPOTLIGHT_PAD = 10;

export function HubOnboarding({ open, onClose }: HubOnboardingProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<SpotlightRect | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const step = ONBOARD_STEPS[stepIndex];
  const isLast = stepIndex >= ONBOARD_STEPS.length - 1;

  const finish = useCallback(() => {
    markOnboarded();
    onClose();
  }, [onClose]);

  const next = useCallback(() => {
    setStepIndex((prev) => {
      if (prev >= ONBOARD_STEPS.length - 1) {
        finish();
        return prev;
      }
      return prev + 1;
    });
  }, [finish]);

  const prev = useCallback(() => {
    setStepIndex((current) => Math.max(0, current - 1));
  }, []);

  /**
   * 量目标盒子。用 useLayoutEffect 而非 useEffect：必须在浏览器绘制前拿到
   * 位置，否则第一帧的聚光框会出现在 (0,0) 再跳过去，看得见的闪。
   */
  useLayoutEffect(() => {
    if (!open) return;

    const measure = () => {
      const target = step?.target;
      if (!target) {
        setRect(null);
        return;
      }
      const el = document.querySelector<HTMLElement>(`[data-onboard="${target}"]`);
      if (!el) {
        // 目标不在（例如窄屏下某个区块被隐藏）：退化为居中卡片，不中断引导
        setRect(null);
        return;
      }
      const box = el.getBoundingClientRect();
      setRect({
        top: box.top - SPOTLIGHT_PAD,
        left: box.left - SPOTLIGHT_PAD,
        width: box.width + SPOTLIGHT_PAD * 2,
        height: box.height + SPOTLIGHT_PAD * 2,
      });
    };

    measure();

    // 窗口尺寸变化 / 滚动都会让绝对定位的聚光框脱离目标
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, step]);

  // 每次重新打开都从第一步开始（用「?」重看引导时不应停在上次退出那一步）
  useEffect(() => {
    if (open) setStepIndex(0);
  }, [open]);

  // 翻步时重置焦点，否则焦点停在上一张卡片里
  useEffect(() => {
    if (!open) return;
    cardRef.current?.focus();
  }, [open, stepIndex]);

  // 键盘：Esc 跳过、←/→ 翻步、Enter 前进
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish();
      } else if (event.key === 'ArrowRight' || event.key === 'Enter') {
        event.preventDefault();
        next();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        prev();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, finish, next, prev]);

  if (!open) return null;

  // step 理论上恒存在（stepIndex 被 next/prev 夹在合法区间内），
  // 这里只是给 TS 的兜底，不做渲染期 setState（那是反模式）。
  if (!step) return null;

  /*
   * 卡片定位：把候选位置**先夹进视口，再算重叠面积**，取重叠最小者。
   *
   * 走过的弯路（两次）：
   *   第一版「下方放不下就放上方」的二选一 —— 星轨占满视口高度（实测 798px），
   *   上下都放不下，退化成贴左上角，正好压住要高亮的星轨。
   *
   *   第二版改成 6 候选位 + 打分，但**先打分、最后才夹取**：出屏的候选位在打分
   *   时看起来「不重叠」（它落在屏幕外），夹回来却正好砸进高亮区。
   *   实测第 2 步重叠 63920 px²（= 整张卡片面积，完全糊住仪器架）、第 3 步 1336 px²。
   *
   * 所以顺序必须是：夹取 → 算重叠 → 比较。这样「打分时看到的」就是
   * 「最终画出来的」那个位置。候选位也扩到 16 个（目标四条边 × 三种对齐 +
   * 四个视口角），密集到几乎总能找到不遮挡的落点。
   */
  let cardStyle: React.CSSProperties;
  if (rect) {
    const CARD_W = 340;
    const CARD_H = 200; // 估算高度，只用于夹取；实测 167~188，偏保守
    const GAP = 16;
    const viewportW = typeof window === 'undefined' ? 1200 : window.innerWidth;
    const viewportH = typeof window === 'undefined' ? 800 : window.innerHeight;

    const spotRight = rect.left + rect.width;
    const spotBottom = rect.top + rect.height;
    const centerX = rect.left + rect.width / 2 - CARD_W / 2;
    const centerY = rect.top + rect.height / 2 - CARD_H / 2;

    // 目标四条边 × 三种对齐 + 四个视口角
    const rawCandidates: { left: number; top: number }[] = [
      { left: rect.left, top: spotBottom + GAP },
      { left: centerX, top: spotBottom + GAP },
      { left: spotRight - CARD_W, top: spotBottom + GAP },
      { left: rect.left, top: rect.top - CARD_H - GAP },
      { left: centerX, top: rect.top - CARD_H - GAP },
      { left: spotRight - CARD_W, top: rect.top - CARD_H - GAP },
      { left: spotRight + GAP, top: rect.top },
      { left: spotRight + GAP, top: centerY },
      { left: spotRight + GAP, top: spotBottom - CARD_H },
      { left: rect.left - CARD_W - GAP, top: rect.top },
      { left: rect.left - CARD_W - GAP, top: centerY },
      { left: rect.left - CARD_W - GAP, top: spotBottom - CARD_H },
      { left: GAP, top: GAP },
      { left: viewportW - CARD_W - GAP, top: GAP },
      { left: GAP, top: viewportH - CARD_H - GAP },
      { left: viewportW - CARD_W - GAP, top: viewportH - CARD_H - GAP },
    ];

    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
    const maxLeft = viewportW - CARD_W - GAP;
    const maxTop = viewportH - CARD_H - GAP;

    const scored = rawCandidates
      .map((candidate) => ({
        left: clamp(candidate.left, GAP, maxLeft),
        top: clamp(candidate.top, GAP, maxTop),
      }))
      // 夹取后会有重复（多个候选被压到同一个边角），去重省得重复评分
      .filter((pos, index, arr) => arr.findIndex((o) => o.left === pos.left && o.top === pos.top) === index)
      .map((pos) => {
        // 重叠面积：唯一主项 —— 遮住高亮目标就失去了引导的意义
        const ox = Math.min(pos.left + CARD_W, spotRight) - Math.max(pos.left, rect.left);
        const oy = Math.min(pos.top + CARD_H, spotBottom) - Math.max(pos.top, rect.top);
        const overlap = ox > 0 && oy > 0 ? ox * oy : 0;
        // 同样不遮挡时，选离目标近的（眼睛不用跑太远）
        const distance =
          Math.abs(pos.left + CARD_W / 2 - (rect.left + rect.width / 2)) +
          Math.abs(pos.top + CARD_H / 2 - (rect.top + rect.height / 2));
        return { pos, overlap, distance };
      })
      .sort((a, b) => a.overlap - b.overlap || a.distance - b.distance);

    const best = scored[0]!.pos;
    cardStyle = {
      left: best.left + 'px',
      top: best.top + 'px',
      width: CARD_W + 'px',
    };
  } else {
    cardStyle = {
      left: '50%',
      top: '50%',
      width: '380px',
      transform: 'translate(-50%, -50%)',
    };
  }

  return (
    <div className="onb-layer" role="dialog" aria-modal="true" aria-label="总控台使用引导">
      {/*
        遮罩：整体压暗，再用一个巨大的 box-shadow 在聚光框位置「挖洞」。
        比「遮罩 + 反向 clip-path」简单，且圆角跟着目标走。
      */}
      {rect ? (
        <div
          className="onb-spotlight"
          style={{
            top: rect.top + 'px',
            left: rect.left + 'px',
            width: rect.width + 'px',
            height: rect.height + 'px',
          }}
          aria-hidden="true"
        />
      ) : (
        <div className="onb-scrim" aria-hidden="true" />
      )}

      <div
        className="onb-card"
        style={cardStyle}
        ref={cardRef}
        tabIndex={-1}
        // 点击卡片内不应穿透到遮罩的关闭逻辑
        onClick={(event) => event.stopPropagation()}
      >
        <div className="onb-card-head">
          <span className="onb-step">
            {stepIndex + 1} / {ONBOARD_STEPS.length}
          </span>
          <span className="onb-card-spacer" />
          <button type="button" className="onb-skip" onClick={finish} title="跳过引导（Esc）">
            跳过
          </button>
        </div>

        <h3 className="onb-title">{step?.title ?? ''}</h3>
        <p className="onb-body">{step?.body ?? ''}</p>

        <div className="onb-foot">
          {/* 进度点：也给个"还有几步"的预期 */}
          <span className="onb-dots" aria-hidden="true">
            {ONBOARD_STEPS.map((item, index) => (
              <span key={item.target ?? item.title} data-active={index === stepIndex ? 'true' : 'false'} />
            ))}
          </span>
          <span className="onb-card-spacer" />
          {stepIndex > 0 ? (
            <button type="button" className="btn" onClick={prev} title="上一步（←）">
              上一步
            </button>
          ) : null}
          <button type="button" className="btn" data-tone="ok" onClick={next} title={isLast ? '完成（Enter）' : '下一步（Enter）'}>
            {isLast ? '开始使用' : '下一步'}
          </button>
        </div>
      </div>
    </div>
  );
}
