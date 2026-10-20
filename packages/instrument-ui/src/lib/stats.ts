/**
 * 纯统计实现（无第三方依赖）。
 *
 * 为什么自己写而不引 d3-scale / simple-statistics：
 * 1. `instrument-ui` 是 L3 契约层的纯展示包，ADR-07 要求「受控组件，无数据获取」；
 *    多一个运行时依赖就让 18 个微站的依赖树各胖一圈。
 * 2. 这块逻辑量很小（最小二乘 + t 分位近似），但**必须可测试**，
 *    所以全部写成纯函数，不碰 DOM。
 *
 * 拟合计算本身应由调用方（如 CurveLab）在 Web Worker 里完成并把结果传进来；
 * 这里的实现用于 ① demo 造数 ② 无 Worker 时的降级路径 ③ 单测。
 */

export interface LinearFit {
  /** 斜率 */
  slope: number;
  /** 截距 */
  intercept: number;
  /** 决定系数 */
  r2: number;
  /** 残差标准差（自由度 n-2） */
  residualStdError: number;
  /** 样本数 */
  n: number;
  /** 预测值 y = slope * x + intercept */
  predict: (x: number) => number;
}

/** 最小二乘直线拟合。样本不足 2 个或 x 全等时返回退化结果。 */
export function linearRegression(points: readonly (readonly [number, number])[]): LinearFit {
  const n = points.length;
  const degenerate: LinearFit = {
    slope: 0,
    intercept: n > 0 ? (points[0]?.[1] ?? 0) : 0,
    r2: 0,
    residualStdError: 0,
    n,
    predict: (x: number) => x * 0 + (points[0]?.[1] ?? 0),
  };
  if (n < 2) return degenerate;

  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of points) {
    const dx = x - meanX;
    const dy = y - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return degenerate;

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  const ssRes = Math.max(0, syy - slope * sxy);
  const residualStdError = n > 2 ? Math.sqrt(ssRes / (n - 2)) : 0;

  return {
    slope,
    intercept,
    r2,
    residualStdError,
    n,
    predict: (x: number) => slope * x + intercept,
  };
}

/**
 * 95% 置信带半宽（mean response）。
 *
 * 公式：t(0.975, n-2) * s * sqrt(1/n + (x - x̄)² / Sxx)
 * t 分位用 Cornish–Fisher 展开近似，n ≥ 8 时误差 < 0.5%，足够画图；
 * n < 8 时退回保守常数，避免小样本给出过窄的带（比过宽更危险）。
 */
export function confidenceHalfWidth(
  fit: LinearFit,
  x: number,
  meanX: number,
  sxx: number,
  level = 0.95,
): number {
  const { n, residualStdError } = fit;
  if (n < 3 || sxx <= 0) return 0;
  const t = tQuantile(level, n - 2);
  const dx = x - meanX;
  return t * residualStdError * Math.sqrt(1 / n + (dx * dx) / sxx);
}

/** 双尾 t 分位近似（Cornish–Fisher）。df 越大越接近正态。 */
export function tQuantile(level: number, df: number): number {
  const p = (1 + clamp01(level)) / 2; // 双尾 → 单尾
  const z = inverseNormalCdf(p);
  if (df <= 0) return z;
  if (df < 8) {
    // 小样本保守放大，宁宽勿窄
    const table: Record<number, number> = {
      1: 12.706,
      2: 4.303,
      3: 3.182,
      4: 2.776,
      5: 2.571,
      6: 2.447,
      7: 2.365,
    };
    return table[Math.round(df)] ?? z * 1.15;
  }
  // Cornish–Fisher: t ≈ z + (z³+z)/(4df) + (5z⁵+16z³+3z)/(96df²)
  const z2 = z * z;
  const z3 = z2 * z;
  const z5 = z3 * z2;
  return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df * df);
}

/** Acklam 有理近似，误差 < 1.15e-9。 */
export function inverseNormalCdf(p: number): number {
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  const q = clamp01(p);

  if (q < pLow) {
    const t = Math.sqrt(-2 * Math.log(q));
    return (
      (((((c[0] ?? 0) * t + (c[1] ?? 0)) * t + (c[2] ?? 0)) * t + (c[3] ?? 0)) * t + (c[4] ?? 0)) *
        t +
        (c[5] ?? 0)) /
      (((((d[0] ?? 0) * t + (d[1] ?? 0)) * t + (d[2] ?? 0)) * t + (d[3] ?? 0)) * t + 1)
    );
  }
  if (q > pHigh) {
    const t = Math.sqrt(-2 * Math.log(1 - q));
    return (
      -(((((c[0] ?? 0) * t + (c[1] ?? 0)) * t + (c[2] ?? 0)) * t + (c[3] ?? 0)) * t + (c[4] ?? 0)) *
        t +
        (c[5] ?? 0)) /
      (((((d[0] ?? 0) * t + (d[1] ?? 0)) * t + (d[2] ?? 0)) * t + (d[3] ?? 0)) * t + 1)
    );
  }
  const r = q - 0.5;
  const s = r * r;
  return (
    ((((((a[0] ?? 0) * s + (a[1] ?? 0)) * s + (a[2] ?? 0)) * s + (a[3] ?? 0)) * s + (a[4] ?? 0)) *
      s +
      (a[5] ?? 0)) *
      r) /
    ((((((b[0] ?? 0) * s + (b[1] ?? 0)) * s + (b[2] ?? 0)) * s + (b[3] ?? 0)) * s + (b[4] ?? 0)) *
      s +
      1)
  );
}

/** x 的均值与离差平方和（置信带计算的中间量）。 */
export function meanAndSxx(xs: readonly number[]): { meanX: number; sxx: number } {
  if (xs.length === 0) return { meanX: 0, sxx: 0 };
  let sum = 0;
  for (const x of xs) sum += x;
  const meanX = sum / xs.length;
  let sxx = 0;
  for (const x of xs) sxx += (x - meanX) ** 2;
  return { meanX, sxx };
}

/** 残差序列。 */
export function residuals(
  points: readonly (readonly [number, number])[],
  fit: LinearFit,
): { x: number; r: number }[] {
  return points.map(([x, y]) => ({ x, r: y - fit.predict(x) }));
}

/**
 * 确定性伪随机（mulberry32）。
 * demo 数据必须可复现——每次刷新散点乱跳会让视觉评审无法对比。
 */
export function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller 正态噪声（造散点用）。 */
export function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 双指数衰减（CurveLab 的核心模型之一）。 */
export function biExponential(
  x: number,
  a1: number,
  tau1: number,
  a2: number,
  tau2: number,
): number {
  return a1 * Math.exp(-x / Math.max(tau1, 1e-9)) + a2 * Math.exp(-x / Math.max(tau2, 1e-9));
}

/** 洛伦兹峰。 */
export function lorentzian(x: number, center: number, gamma: number, amplitude: number): number {
  const d = (x - center) / Math.max(gamma, 1e-9);
  return amplitude / (1 + d * d);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/** 生成一族示波器 demo 数据（散点 + 真实曲线）。 */
export function makeDemoSeries(options: {
  count?: number;
  noise?: number;
  seed?: number;
  slope?: number;
  intercept?: number;
  /** 'linear' | 'exp' | 'lorentz' */
  model?: 'linear' | 'exp' | 'lorentz';
  xMin?: number;
  xMax?: number;
}): { x: number; y: number }[] {
  const {
    count = 180,
    noise = 1.2,
    seed = 20261020,
    slope = 0.42,
    intercept = 1.6,
    model = 'linear',
    xMin = 0,
    xMax = 10,
  } = options;

  const random = createRandom(seed);
  const out: { x: number; y: number }[] = [];
  const n = Math.max(2, Math.round(count));

  for (let i = 0; i < n; i += 1) {
    const t = n === 1 ? 0 : i / (n - 1);
    const x = xMin + t * (xMax - xMin);
    let base: number;
    if (model === 'exp') {
      base = biExponential(x, 3.2, 1.4, 1.1, 5.5);
    } else if (model === 'lorentz') {
      base = lorentzian(x, (xMin + xMax) / 2, (xMax - xMin) / 12, 4.2) + 0.6;
    } else {
      base = intercept + slope * x;
    }
    // 噪声随 x 轻微增大，模拟真实测量
    const scale = noise * (0.6 + 0.4 * t);
    out.push({ x, y: base + gaussian(random) * scale });
  }
  return out;
}
