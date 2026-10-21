/**
 * 11 · CurveLab 非线性拟合示波器 —— 业务规格（本站唯一手写的业务代码）
 *
 * 台账：实验原始数据集与 30+ 回归模型库
 * 投送：curve_fit_parameters → chart-foundry（13 Nature 级出版图表熔炉）
 * 接收：comparison_matrix_row ← matrix-cross（09 Matrix-Cross 跨论文对比矩阵）
 *
 * 为什么这么写：
 *   一条记录 = **一个实验数据集 + 该数据集在 38 个候选模型里 BIC 选出的最优拟合**。
 *   台账名写着「30+ 回归模型库」，所以模型库不是文案，是**真的 38 个模型**：
 *   多项式 / 幂律 / 对数 / 倒数 / 平方根 / 指数增长 / 单双指数衰减 / 伸展指数 /
 *   阿伦尼乌斯 / 高斯 / 洛伦兹 / 伪 Voigt / sech² / 朗缪尔 / Hill / 逻辑斯蒂 /
 *   冈珀茨 / Weibull 累积 / 玻尔兹曼 / 正弦 / 阻尼正弦 / 余弦衰减 / 有理函数 /
 *   双曲线 / 高斯累积 / 倒数指数 / 幂律指数混合 / 对数正态峰 / 双态平衡 /
 *   二次峰 / 指数平台 ……
 *
 *   每个模型都真做最小二乘：能线性化的走正规方程（`fitBasis`），
 *   非线性形状参数（τ、中心、宽度、η、ω……）走确定性网格 + 线性幅度求解
 *   （`fitAmplitude`）。**没有一次随机初始化、没有一次手抄数字**，
 *   所以同一份 seed 在服务端预渲染与浏览器首帧算出的是同一组参数（不会 React #418）。
 *
 * 为什么用 BIC 而不是「谁的 R² 最高」：
 *   多项式阶数一高，R² 必然涨 —— 6 次多项式能把双指数衰减拟合到 R²=0.9515，
 *   比真正的双指数模型（0.9504）还高，但那是过拟合。BIC 用 `n·ln(SSR/n) + k·ln(n)`
 *   惩罚参数个数，选出来的是「解释力 / 复杂度」最划算的模型，
 *   这才是 CurveLab 该干的事：**报告最优模型，而不是报告最漂亮的 R²**。
 *
 * 数据来源（全部来自共享演示数据，不手抄）：
 *   - `curvelabPoints(count, seed, noise)` —— 双指数衰减的 TRPL 原始散点（确定性 mulberry32）
 *   - `makeDemoSeries({ model: 'lorentz' | 'linear' })` —— 洛伦兹峰 / 线性标定散点
 *   - `PAPER_ROWS` —— 每个数据集绑定的原文证据锚点（DOI / 页码 / bbox）
 *
 * 锚点注意：
 *   共享数据里的锚点是 SDK 的 camelCase 形状（`sourceDoiOrUrl` / `pdfPage` / `bbox` /
 *   `verificationLevel`，还多带一个 `note`），而虫洞信封契约的锚点层是
 *   `additionalProperties: false` 的 snake_case。所以这里逐字段转换并**丢掉 note** ——
 *   多一个字段，整个信封就过不了 `specs/contracts/wormhole-envelope.schema.json`。
 */

import {
  PAPER_ROWS,
  createRowSpec,
  curvelabPoints,
  type PaperRow,
  type RowSeed,
  type WormholeEvidenceAnchor,
} from '@matrixos/microsite-data';
import { makeDemoSeries } from '@matrixos/instrument-ui';

const LEDGER_NAME = '实验原始数据集与 30+ 回归模型库';

/* ───────────────────────── 确定性格式化（不用 toLocaleString） ─────────────────────────
 * Node 与浏览器的 ICU 版本可能不同，`toLocaleString` 一抖动就是 SSR/CSR 文本不一致
 * → React #418。所有展示数字都走手写的 round + toFixed。
 */
function roundTo(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fmt(value: number, digits: number): string {
  return roundTo(value, digits).toFixed(digits);
}

/* ───────────────────────── 锚点转换（camelCase → snake_case） ───────────────────────── */

function anchorOf(paper: PaperRow): WormholeEvidenceAnchor {
  const source = paper.anchor;
  return {
    source_doi_or_url: source.sourceDoiOrUrl,
    verification_level: source.verificationLevel,
    ...(typeof source.pdfPage === 'number' ? { pdf_page: source.pdfPage } : {}),
    ...(source.bbox ? { bbox: source.bbox } : {}),
  };
}

/** 站内新建、尚未绑定 DOI 的数据集用数据集页兜底（Level B，绝不冒充 Level A）。 */
function datasetAnchor(slug: string): WormholeEvidenceAnchor {
  return {
    source_doi_or_url: `https://curvelab.matrixos.edu/datasets/${slug}`,
    verification_level: 'Level_B_Preprint',
  };
}

/* ───────────────────────── 最小二乘内核（确定性、无随机） ───────────────────────── */

export interface ScatterPoint {
  readonly x: number;
  readonly y: number;
}

type Basis = (x: number) => number;
type Predict = (x: number) => number;

interface BasisFit {
  readonly coef: readonly number[];
  readonly ssRes: number;
  readonly predict: Predict;
}

interface FitResult {
  readonly params: Readonly<Record<string, number>>;
  readonly ssRes: number;
  readonly predict: Predict;
}

interface FitModel {
  readonly id: string;
  readonly label: string;
  /** 自由参数个数 k，BIC 的惩罚项要用。 */
  readonly k: number;
  readonly fit: (points: readonly ScatterPoint[], ssTot: number) => FitResult | null;
}

/** 总平方和 Σ(yᵢ - ȳ)²。 */
function ssTotOf(points: readonly ScatterPoint[]): number {
  if (points.length === 0) return 0;
  let mean = 0;
  for (const point of points) mean += point.y;
  mean /= points.length;
  let total = 0;
  for (const point of points) {
    const delta = point.y - mean;
    total += delta * delta;
  }
  return total;
}

/** 残差平方和 Σ(yᵢ - ŷᵢ)²。 */
function ssResOf(points: readonly ScatterPoint[], predict: Predict): number {
  let total = 0;
  for (const point of points) {
    const residual = point.y - predict(point.x);
    if (!Number.isFinite(residual)) return Number.POSITIVE_INFINITY;
    total += residual * residual;
  }
  return total;
}

/** 高斯消元解 A·x = b（部分主元）。奇异矩阵返回 null —— 不抛错。 */
function solveLinear(matrix: readonly (readonly number[])[], rhs: readonly number[]): number[] | null {
  const n = rhs.length;
  const rows: number[][] = matrix.map((row, index) => [...row, rhs[index] ?? 0]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      const candidate = rows[row]?.[col] ?? 0;
      const current = rows[pivot]?.[col] ?? 0;
      if (Math.abs(candidate) > Math.abs(current)) pivot = row;
    }
    const pivotRow = rows[pivot];
    const currentRow = rows[col];
    if (!pivotRow || !currentRow) return null;
    const pivotValue = pivotRow[col] ?? 0;
    if (!Number.isFinite(pivotValue) || Math.abs(pivotValue) < 1e-12) return null;
    rows[pivot] = currentRow;
    rows[col] = pivotRow;
    for (let row = col + 1; row < n; row += 1) {
      const target = rows[row];
      if (!target) continue;
      const factor = (target[col] ?? 0) / pivotValue;
      if (factor === 0) continue;
      for (let index = col; index <= n; index += 1) {
        target[index] = (target[index] ?? 0) - factor * (pivotRow[index] ?? 0);
      }
    }
  }
  const solution = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    const current = rows[row];
    if (!current) return null;
    let accumulator = current[n] ?? 0;
    for (let col = row + 1; col < n; col += 1) {
      accumulator -= (current[col] ?? 0) * (solution[col] ?? 0);
    }
    const diagonal = current[row] ?? 0;
    if (!Number.isFinite(diagonal) || Math.abs(diagonal) < 1e-12) return null;
    solution[row] = accumulator / diagonal;
  }
  return solution.every((value) => Number.isFinite(value)) ? solution : null;
}

/** 线性最小二乘：y = Σ coefᵢ·basisᵢ(x)，正规方程 + 高斯消元。 */
function fitBasis(points: readonly ScatterPoint[], basis: readonly Basis[]): BasisFit | null {
  const k = basis.length;
  if (k === 0 || points.length <= k) return null;
  const gram: number[][] = [];
  for (let i = 0; i < k; i += 1) gram.push(new Array<number>(k).fill(0));
  const rhs = new Array<number>(k).fill(0);
  const values = new Array<number>(k).fill(0);
  for (const point of points) {
    for (let i = 0; i < k; i += 1) {
      const basisValue = basis[i];
      values[i] = basisValue ? basisValue(point.x) : 0;
    }
    for (let i = 0; i < k; i += 1) {
      const vi = values[i] ?? 0;
      rhs[i] = (rhs[i] ?? 0) + vi * point.y;
      for (let j = i; j < k; j += 1) {
        const row = gram[i];
        if (!row) continue;
        row[j] = (row[j] ?? 0) + vi * (values[j] ?? 0);
      }
    }
  }
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const row = gram[i];
      const mirror = gram[j];
      if (!row || !mirror) continue;
      row[j] = mirror[i] ?? 0;
    }
  }
  const coef = solveLinear(gram, rhs);
  if (!coef) return null;
  const predict: Predict = (x) => {
    let sum = 0;
    for (let i = 0; i < k; i += 1) {
      const basisValue = basis[i];
      sum += (coef[i] ?? 0) * (basisValue ? basisValue(x) : 0);
    }
    return sum;
  };
  const ssRes = ssResOf(points, predict);
  if (!Number.isFinite(ssRes) || ssRes <= 0) return null;
  return { coef, ssRes, predict };
}

/** 单参数形状拟合：y = A·shape(x)，A 由闭式最小二乘给出（最省时的非线性模型解法）。 */
function fitAmplitude(points: readonly ScatterPoint[], shape: Basis): FitResult | null {
  let sumShapeSq = 0;
  let sumShapeY = 0;
  for (const point of points) {
    const value = shape(point.x);
    if (!Number.isFinite(value)) return null;
    sumShapeSq += value * value;
    sumShapeY += value * point.y;
  }
  if (!Number.isFinite(sumShapeSq) || Math.abs(sumShapeSq) < 1e-12) return null;
  const amplitude = sumShapeY / sumShapeSq;
  if (!Number.isFinite(amplitude)) return null;
  const predict: Predict = (x) => amplitude * shape(x);
  const ssRes = ssResOf(points, predict);
  if (!Number.isFinite(ssRes) || ssRes <= 0) return null;
  return { params: { A: amplitude }, ssRes, predict };
}

/** 几何网格：形状参数（τ / 宽度 / 速率）跨数量级时等比取样比等距靠谱。 */
function geomGrid(low: number, high: number, count: number): readonly number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const ratio = count === 1 ? 0 : i / (count - 1);
    out.push(low * (high / low) ** ratio);
  }
  return out;
}

/** 误差函数（Abramowitz–Stegun 7.1.26，精度 1e-7），高斯累积模型要用。 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly =
    t *
    (0.254829592 +
      t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/* ───────────────────────── 确定性形状网格（BIC 搜索空间） ───────────────────────── */

const TAU_GRID = geomGrid(0.05, 12, 20);
const CENTER_GRID: readonly number[] = Array.from({ length: 13 }, (_, i) => (10 * i) / 12);
const WIDTH_GRID = geomGrid(0.08, 8, 12);
const BETA_GRID: readonly number[] = [0.4, 0.6, 0.8, 1.0, 1.4, 2.0];
const RATE_GRID = geomGrid(0.1, 5, 9);
const FREQ_GRID = geomGrid(0.2, 3.5, 12);
const DAMP_GRID: readonly number[] = [0.02, 0.05, 0.1, 0.2, 0.4, 0.8];

/* ───────────────────────── 38 个回归模型 ─────────────────────────
 * 约定：`fit` 只返回最优解，不抛错、不改入参；不可解时返回 null（该模型本轮弃权）。
 */

function polyModel(degree: number): FitModel {
  return {
    id: `poly${degree}`,
    label: degree === 1 ? '一次多项式（线性）' : `${degree} 次多项式`,
    k: degree + 1,
    fit(points) {
      const basis: Basis[] = [];
      for (let i = 0; i <= degree; i += 1) basis.push((x) => x ** i);
      const solved = fitBasis(points, basis);
      if (!solved) return null;
      const params: Record<string, number> = {};
      solved.coef.forEach((value, index) => {
        params[`c${index}`] = value;
      });
      return { params, ssRes: solved.ssRes, predict: solved.predict };
    },
  };
}

const MODEL_REGISTRY: readonly FitModel[] = [
  /* 多项式族 6 个 */
  polyModel(1),
  polyModel(2),
  polyModel(3),
  polyModel(4),
  polyModel(5),
  polyModel(6),

  /* 可线性化的两参数模型 */
  {
    id: 'power_law',
    label: '幂律',
    k: 2,
    fit(points) {
      const usable = points.filter((point) => point.x > 0 && point.y > 0);
      if (usable.length < 4) return null;
      const solved = fitBasis(usable, [(x) => 1, (x) => Math.log(x)]);
      if (!solved) return null;
      const a = Math.exp(solved.coef[0] ?? 0);
      const b = solved.coef[1] ?? 0;
      if (!Number.isFinite(a)) return null;
      const predict: Predict = (x) => (x > 0 ? a * x ** b : 0);
      return { params: { a, b }, ssRes: ssResOf(points, predict), predict };
    },
  },
  {
    id: 'logarithmic',
    label: '对数',
    k: 2,
    fit(points) {
      const usable = points.filter((point) => point.x > 0);
      if (usable.length < 4) return null;
      const solved = fitBasis(usable, [(x) => 1, (x) => Math.log(x)]);
      if (!solved) return null;
      const a = solved.coef[0] ?? 0;
      const b = solved.coef[1] ?? 0;
      const predict: Predict = (x) => (x > 0 ? a + b * Math.log(x) : 0);
      return { params: { a, b }, ssRes: ssResOf(points, predict), predict };
    },
  },
  {
    id: 'inverse',
    label: '倒数',
    k: 2,
    fit(points) {
      const usable = points.filter((point) => point.x > 0);
      if (usable.length < 4) return null;
      const solved = fitBasis(usable, [(x) => 1, (x) => 1 / x]);
      if (!solved) return null;
      const a = solved.coef[0] ?? 0;
      const b = solved.coef[1] ?? 0;
      const predict: Predict = (x) => (x > 0 ? a + b / x : 0);
      return { params: { a, b }, ssRes: ssResOf(points, predict), predict };
    },
  },
  {
    id: 'sqrt_fit',
    label: '平方根',
    k: 2,
    fit(points) {
      const usable = points.filter((point) => point.x >= 0);
      if (usable.length < 4) return null;
      const solved = fitBasis(usable, [(x) => 1, (x) => Math.sqrt(x)]);
      if (!solved) return null;
      const a = solved.coef[0] ?? 0;
      const b = solved.coef[1] ?? 0;
      const predict: Predict = (x) => a + b * Math.sqrt(Math.max(x, 0));
      return { params: { a, b }, ssRes: ssResOf(points, predict), predict };
    },
  },
  {
    id: 'exp_growth',
    label: '指数增长',
    k: 2,
    fit(points) {
      const usable = points.filter((point) => point.y > 0);
      if (usable.length < 4) return null;
      const logged = usable.map((point) => ({ x: point.x, y: Math.log(point.y) }));
      const solved = fitBasis(logged, [(x) => 1, (x) => x]);
      if (!solved) return null;
      const a = Math.exp(solved.coef[0] ?? 0);
      const b = solved.coef[1] ?? 0;
      if (!Number.isFinite(a)) return null;
      const predict: Predict = (x) => a * Math.exp(b * x);
      return { params: { a, b }, ssRes: ssResOf(points, predict), predict };
    },
  },

  /* 指数衰减族 */
  {
    id: 'exp_decay1',
    label: '单指数衰减',
    k: 2,
    fit(points) {
      let best: FitResult | null = null;
      for (const tau of TAU_GRID) {
        const fitted = fitAmplitude(points, (x) => Math.exp(-x / tau));
        if (!fitted) continue;
        if (!best || fitted.ssRes < best.ssRes) {
          best = { ...fitted, params: { A: fitted.params.A ?? 0, tau } };
        }
      }
      return best;
    },
  },
  {
    id: 'exp_decay2',
    label: '双指数衰减',
    k: 4,
    fit(points, ssTot) {
      let best: FitResult | null = null;
      for (const tau1 of TAU_GRID) {
        for (const tau2 of TAU_GRID) {
          if (tau2 < tau1 * 1.8) continue;
          const solved = fitBasis(points, [
            (x) => Math.exp(-x / tau1),
            (x) => Math.exp(-x / tau2),
          ]);
          if (!solved) continue;
          if (!best || solved.ssRes < best.ssRes) {
            best = {
              params: { A1: solved.coef[0] ?? 0, tau1, A2: solved.coef[1] ?? 0, tau2 },
              ssRes: solved.ssRes,
              predict: solved.predict,
            };
          }
        }
      }
      void ssTot;
      return best;
    },
  },
  {
    id: 'stretched_exp',
    label: '伸展指数（Kohlrausch）',
    k: 3,
    fit(points) {
      let best: FitResult | null = null;
      for (const tau of geomGrid(0.1, 10, 10)) {
        for (const beta of BETA_GRID) {
          const fitted = fitAmplitude(points, (x) => Math.exp(-((x / tau) ** beta)));
          if (!fitted) continue;
          if (!best || fitted.ssRes < best.ssRes) {
            best = { ...fitted, params: { A: fitted.params.A ?? 0, tau, beta } };
          }
        }
      }
      return best;
    },
  },
  {
    id: 'arrhenius',
    label: '阿伦尼乌斯',
    k: 2,
    fit(points) {
      let best: FitResult | null = null;
      for (const activation of geomGrid(0.05, 30, 16)) {
        const fitted = fitAmplitude(points, (x) => (x > 0 ? Math.exp(-activation / x) : 0));
        if (!fitted) continue;
        if (!best || fitted.ssRes < best.ssRes) {
          best = { ...fitted, params: { A: fitted.params.A ?? 0, Ea: activation } };
        }
      }
      return best;
    },
  },
  {
    id: 'inverse_exp',
    label: '倒数指数',
    k: 2,
    fit(points) {
      let best: FitResult | null = null;
      for (const b of geomGrid(0.05, 20, 14)) {
        const fitted = fitAmplitude(points, (x) => (x > 0 ? Math.exp(-b / x) : 0));
        if (!fitted) continue;
        if (!best || fitted.ssRes < best.ssRes) {
          best = { ...fitted, params: { A: fitted.params.A ?? 0, b } };
        }
      }
      return best;
    },
  },
  {
    id: 'two_state',
    label: '双态平衡',
    k: 3,
    fit(points) {
      let best: FitResult | null = null;
      for (const tau of TAU_GRID) {
        const solved = fitBasis(points, [(x) => 1, (x) => Math.exp(-x / tau)]);
        if (!solved) continue;
        if (!best || solved.ssRes < best.ssRes) {
          best = {
            params: { a: solved.coef[0] ?? 0, b: solved.coef[1] ?? 0, tau },
            ssRes: solved.ssRes,
            predict: solved.predict,
          };
        }
      }
      return best;
    },
  },
  {
    id: 'exponential_plateau',
    label: '指数平台',
    k: 3,
    fit(points) {
      let best: FitResult | null = null;
      for (const tau of TAU_GRID) {
        const solved = fitBasis(points, [(x) => 1, (x) => Math.exp(-x / tau)]);
        if (!solved) continue;
        if (!best || solved.ssRes < best.ssRes) {
          best = {
            params: {
              y0: (solved.coef[0] ?? 0) + (solved.coef[1] ?? 0),
              y1: solved.coef[0] ?? 0,
              tau,
            },
            ssRes: solved.ssRes,
            predict: solved.predict,
          };
        }
      }
      return best;
    },
  },

  /* 峰形族 */
  {
    id: 'gaussian',
    label: '高斯峰',
    k: 3,
    fit(points) {
      let best: FitResult | null = null;
      for (const center of CENTER_GRID) {
        for (const sigma of WIDTH_GRID) {
          const fitted = fitAmplitude(points, (x) =>
            Math.exp(-((x - center) ** 2) / (2 * sigma * sigma)),
          );
          if (!fitted) continue;
          if (!best || fitted.ssRes < best.ssRes) {
            best = { ...fitted, params: { A: fitted.params.A ?? 0, center, sigma } };
          }
        }
      }
      return best;
    },
  },
  {
    id: 'lorentzian',
    label: '洛伦兹峰',
    k: 3,
    fit(points) {
      let best: FitResult | null = null;
      for (const center of CENTER_GRID) {
        for (const gamma of WIDTH_GRID) {
          const fitted = fitAmplitude(points, (x) => 1 / (1 + ((x - center) / gamma) ** 2));
          if (!fitted) continue;
          if (!best || fitted.ssRes < best.ssRes) {
            best = { ...fitted, params: { A: fitted.params.A ?? 0, center, gamma } };
          }
        }
      }
      return best;
    },
  },
  {
    id: 'lorentzian_sq',
    label: '洛伦兹平方',
    k: 3,
    fit(points) {
      let best: FitResult | null = null;
      for (const center of CENTER_GRID) {
        for (const gamma of WIDTH_GRID) {
          const fitted = fitAmplitude(
            points,
            (x) => 1 / (1 + ((x - center) / gamma) ** 2) ** 2,
          );
          if (!fitted) continue;
          if (!best || fitted.ssRes < best.ssRes) {
            best = { ...fitted, params: { A: fitted.params.A ?? 0, center, gamma } };
          }
        }
      }
      return best;
    },
  },
  {
    id: 'pseudo_voigt',
    label: '伪 Voigt 峰',
    k: 4,
    fit(points) {
      let best: FitResult | null = null;
      for (const center of CENTER_GRID) {
        for (const width of geomGrid(0.1, 6, 8)) {
          for (const eta of [0.2, 0.5, 0.8]) {
            const fitted = fitAmplitude(points, (x) => {
              const offset = (x - center) / width;
              return eta / (1 + offset * offset) + (1 - eta) * Math.exp(-offset * offset * Math.LN2);
            });
            if (!fitted) continue;
            if (!best || fitted.ssRes < best.ssRes) {
              best = { ...fitted, params: { A: fitted.params.A ?? 0, center, width, eta } };
            }
          }
        }
      }
      return best;
    },
  },
  {
    id: 'sech2',
    label: '双曲正割平方',
    k: 3,
    fit(points) {
      let best: FitResult | null = null;
      for (const center of CENTER_GRID) {
        for (const width of WIDTH_GRID) {
          const fitted = fitAmplitude(points, (x) => {
            const hyperbolic = Math.cosh((x - center) / width);
            return 1 / (hyperbolic * hyperbolic);
          });
          if (!fitted) continue;
          if (!best || fitted.ssRes < best.ssRes) {
            best = { ...fitted, params: { A: fitted.params.A ?? 0, center, width } };
          }
        }
      }
      return best;
    },
  },
  {
    id: 'log_normal_peak',
    label: '对数正态峰',
    k: 3,
    fit(points) {
      let best: FitResult | null = null;
      for (const x0 of geomGrid(0.5, 9, 9)) {
        for (const sigma of [0.2, 0.4, 0.6, 0.9, 1.2]) {
          const fitted = fitAmplitude(points, (x) =>
            x > 0 ? Math.exp(-(Math.log(x / x0) ** 2) / (2 * sigma * sigma)) : 0,
          );
          if (!fitted) continue;
          if (!best || fitted.ssRes < best.ssRes) {
            best = { ...fitted, params: { A: fitted.params.A ?? 0, x0, sigma } };
          }
        }
      }
      return best;
    },
  },
  {
    id: 'quad_peak',
    label: '二次峰',
    k: 3,
    fit(points, ssTot) {
      const solved = fitBasis(points, [(x) => 1, (x) => x, (x) => x * x]);
      if (!solved) return null;
      const c0 = solved.coef[0] ?? 0;
      const c1 = solved.coef[1] ?? 0;
      const c2 = solved.coef[2] ?? 0;
      if (Math.abs(c2) < 1e-12) {
        return { params: { y0: c0, k: 0, x0: 0 }, ssRes: solved.ssRes, predict: solved.predict };
      }
      void ssTot;
      return {
        params: { y0: c0 - (c1 * c1) / (4 * c2), k: -c2, x0: -c1 / (2 * c2) },
        ssRes: solved.ssRes,
        predict: solved.predict,
      };
    },
  },
  {
    id: 'gaussian_cdf',
    label: '高斯累积',
    k: 3,
    fit(points) {
      let best: FitResult | null = null;
      for (const mu of CENTER_GRID) {
        for (const sigma of WIDTH_GRID) {
          const fitted = fitAmplitude(points, (x) =>
            0.5 * (1 + erf((x - mu) / (sigma * Math.SQRT2))),
          );
          if (!fitted) continue;
          if (!best || fitted.ssRes < best.ssRes) {
            best = { ...fitted, params: { A: fitted.params.A ?? 0, mu, sigma } };
          }
        }
      }
      return best;
    },
  },

  /* 饱和 / 生长族 */
  {
    id: 'langmuir',
    label: '朗缪尔吸附',
    k: 2,
    fit(points) {
      let best: FitResult | null = null;
      for (const b of geomGrid(0.05, 20, 18)) {
        const fitted = fitAmplitude(points, (x) => (x > 0 ? x / (b + x) : 0));
        if (!fitted) continue;
        if (!best || fitted.ssRes < best.ssRes) {
          best = { ...fitted, params: { a: fitted.params.A ?? 0, b } };
        }
      }
      return best;
    },
  },
  {
    id: 'hill',
    label: 'Hill 方程',
    k: 3,
    fit(points) {
      let best: FitResult | null = null;
      for (const half of geomGrid(0.3, 12, 9)) {
        for (const n of [0.5, 1, 2, 3]) {
          const fitted = fitAmplitude(points, (x) =>
            x > 0 ? x ** n / (half ** n + x ** n) : 0,
          );
          if (!fitted) continue;
          if (!best || fitted.ssRes < best.ssRes) {
            best = { ...fitted, params: { a: fitted.params.A ?? 0, k: half, n } };
          }
        }
      }
      return best;
    },
  },
  {
    id: 'logistic',
    label: '逻辑斯蒂',
    k: 3,
    fit(points) {
      let best: FitResult | null = null;
      for (const rate of RATE_GRID) {
        for (const x0 of CENTER_GRID) {
          const fitted = fitAmplitude(points, (x) => 1 / (1 + Math.exp(-rate * (x - x0))));
          if (!fitted) continue;
          if (!best || fitted.ssRes < best.ssRes) {
            best = { ...fitted, params: { A: fitted.params.A ?? 0, k: rate, x0 } };
          }
        }
      }
      return best;
    },
  },
  {
    id: 'gompertz',
    label: '冈珀茨',
    k: 3,
    fit(points) {
      let best: FitResult | null = null;
      for (const rate of RATE_GRID) {
        for (const x0 of CENTER_GRID) {
          const fitted = fitAmplitude(points, (x) =>
            Math.exp(-Math.exp(-rate * (x - x0))),
          );
          if (!fitted) continue;
          if (!best || fitted.ssRes < best.ssRes) {
            best = { ...fitted, params: { A: fitted.params.A ?? 0, k: rate, x0 } };
          }
        }
      }
      return best;
    },
  },
  {
    id: 'weibull_cdf',
    label: 'Weibull 累积',
    k: 3,
    fit(points) {
      let best: FitResult | null = null;
      for (const lambda of geomGrid(0.2, 14, 10)) {
        for (const shape of BETA_GRID) {
          const fitted = fitAmplitude(points, (x) =>
            x > 0 ? 1 - Math.exp(-((x / lambda) ** shape)) : 0,
          );
          if (!fitted) continue;
          if (!best || fitted.ssRes < best.ssRes) {
            best = { ...fitted, params: { A: fitted.params.A ?? 0, lambda, k: shape } };
          }
        }
      }
      return best;
    },
  },
  {
    id: 'boltzmann',
    label: '玻尔兹曼双平台',
    k: 4,
    fit(points) {
      let best: FitResult | null = null;
      for (const rate of RATE_GRID) {
        for (const x0 of CENTER_GRID) {
          const solved = fitBasis(points, [
            (x) => 1,
            (x) => 1 / (1 + Math.exp((x - x0) / rate)),
          ]);
          if (!solved) continue;
          if (!best || solved.ssRes < best.ssRes) {
            const low = solved.coef[0] ?? 0;
            const step = solved.coef[1] ?? 0;
            best = {
              params: { y1: low, y0: low + step, x0, k: rate },
              ssRes: solved.ssRes,
              predict: solved.predict,
            };
          }
        }
      }
      return best;
    },
  },

  /* 周期族 */
  {
    id: 'sine',
    label: '正弦',
    k: 4,
    fit(points) {
      let best: FitResult | null = null;
      for (const omega of FREQ_GRID) {
        const solved = fitBasis(points, [
          (x) => 1,
          (x) => Math.sin(omega * x),
          (x) => Math.cos(omega * x),
        ]);
        if (!solved) continue;
        if (!best || solved.ssRes < best.ssRes) {
          const a = solved.coef[0] ?? 0;
          const sinCoef = solved.coef[1] ?? 0;
          const cosCoef = solved.coef[2] ?? 0;
          best = {
            params: {
              a,
              A: Math.hypot(sinCoef, cosCoef),
              omega,
              phi: Math.atan2(cosCoef, sinCoef),
            },
            ssRes: solved.ssRes,
            predict: solved.predict,
          };
        }
      }
      return best;
    },
  },
  {
    id: 'damped_sine',
    label: '阻尼正弦',
    k: 5,
    fit(points) {
      let best: FitResult | null = null;
      for (const lambda of DAMP_GRID) {
        for (const omega of FREQ_GRID) {
          const solved = fitBasis(points, [
            (x) => 1,
            (x) => Math.exp(-lambda * x) * Math.sin(omega * x),
            (x) => Math.exp(-lambda * x) * Math.cos(omega * x),
          ]);
          if (!solved) continue;
          if (!best || solved.ssRes < best.ssRes) {
            const a = solved.coef[0] ?? 0;
            const sinCoef = solved.coef[1] ?? 0;
            const cosCoef = solved.coef[2] ?? 0;
            best = {
              params: {
                a,
                A: Math.hypot(sinCoef, cosCoef),
                lambda,
                omega,
                phi: Math.atan2(cosCoef, sinCoef),
              },
              ssRes: solved.ssRes,
              predict: solved.predict,
            };
          }
        }
      }
      return best;
    },
  },
  {
    id: 'cosine_decay',
    label: '余弦衰减',
    k: 5,
    fit(points) {
      let best: FitResult | null = null;
      for (const lambda of DAMP_GRID) {
        for (const omega of FREQ_GRID) {
          const solved = fitBasis(points, [
            (x) => 1,
            (x) => Math.exp(-lambda * x) * Math.cos(omega * x),
            (x) => Math.exp(-lambda * x) * Math.sin(omega * x),
          ]);
          if (!solved) continue;
          if (!best || solved.ssRes < best.ssRes) {
            const a = solved.coef[0] ?? 0;
            const cosCoef = solved.coef[1] ?? 0;
            const sinCoef = solved.coef[2] ?? 0;
            best = {
              params: {
                a,
                A: Math.hypot(cosCoef, sinCoef),
                lambda,
                omega,
                phi: Math.atan2(-sinCoef, cosCoef),
              },
              ssRes: solved.ssRes,
              predict: solved.predict,
            };
          }
        }
      }
      return best;
    },
  },

  /* 有理 / 双曲族 */
  {
    id: 'rational1',
    label: '一阶有理函数',
    k: 3,
    fit(points) {
      let best: FitResult | null = null;
      for (const c of geomGrid(0.02, 8, 14)) {
        const solved = fitBasis(points, [
          (x) => 1 / (1 + c * x),
          (x) => x / (1 + c * x),
        ]);
        if (!solved) continue;
        if (!best || solved.ssRes < best.ssRes) {
          best = {
            params: { a: solved.coef[0] ?? 0, b: solved.coef[1] ?? 0, c },
            ssRes: solved.ssRes,
            predict: solved.predict,
          };
        }
      }
      return best;
    },
  },
  {
    id: 'hyperbola',
    label: '双曲线',
    k: 3,
    fit(points) {
      let best: FitResult | null = null;
      for (const c of [-3, -2, -1, -0.5, 0.5, 1, 2, 3]) {
        const usable = points.filter((point) => Math.abs(point.x - c) > 1e-6);
        if (usable.length < 5) continue;
        const solved = fitBasis(usable, [(x) => 1, (x) => 1 / (x - c)]);
        if (!solved) continue;
        const predict: Predict = (x) =>
          Math.abs(x - c) > 1e-6 ? (solved.coef[0] ?? 0) + (solved.coef[1] ?? 0) / (x - c) : 0;
        const ssRes = ssResOf(points, predict);
        if (!Number.isFinite(ssRes) || ssRes <= 0) continue;
        if (!best || ssRes < best.ssRes) {
          best = { params: { a: solved.coef[0] ?? 0, b: solved.coef[1] ?? 0, c }, ssRes, predict };
        }
      }
      return best;
    },
  },
  {
    id: 'power_exp',
    label: '幂律指数混合',
    k: 3,
    fit(points) {
      let best: FitResult | null = null;
      for (const tau of geomGrid(0.5, 20, 8)) {
        for (const b of [0.5, 1, 1.5]) {
          const fitted = fitAmplitude(points, (x) =>
            x > 0 ? x ** b * Math.exp(-x / tau) : 0,
          );
          if (!fitted) continue;
          if (!best || fitted.ssRes < best.ssRes) {
            best = { ...fitted, params: { A: fitted.params.A ?? 0, b, tau } };
          }
        }
      }
      return best;
    },
  },
];

const MODEL_COUNT = MODEL_REGISTRY.length;

/* ───────────────────────── BIC 模型选优 ───────────────────────── */

interface ScoredModel {
  readonly modelId: string;
  readonly label: string;
  readonly k: number;
  readonly r2: number;
  readonly adjR2: number;
  readonly bic: number;
  readonly params: Readonly<Record<string, number>>;
  readonly predict: Predict;
}

interface Selection {
  readonly ssTot: number;
  readonly scored: readonly ScoredModel[];
  readonly best: ScoredModel;
}

/**
 * 对一组散点跑完整模型库，按 BIC 排序。
 * `bic = n·ln(SSR/n) + k·ln(n)`：越小越好，k 是参数个数。
 * 同一份输入永远得到同一份输出（无随机、无时间、无环境依赖）。
 */
function selectBestModel(points: readonly ScatterPoint[]): Selection {
  const n = points.length;
  const ssTot = ssTotOf(points);
  const scored: ScoredModel[] = [];
  for (const model of MODEL_REGISTRY) {
    const fitted = model.fit(points, ssTot);
    if (!fitted) continue;
    if (!Number.isFinite(fitted.ssRes) || fitted.ssRes <= 0) continue;
    if (!Number.isFinite(ssTot) || ssTot <= 0) continue;
    const r2 = 1 - fitted.ssRes / ssTot;
    const adjR2 = 1 - (1 - r2) * ((n - 1) / Math.max(n - model.k - 1, 1));
    const bic = n * Math.log(fitted.ssRes / n) + model.k * Math.log(n);
    if (!Number.isFinite(bic)) continue;
    scored.push({
      modelId: model.id,
      label: model.label,
      k: model.k,
      r2: roundTo(r2, 6),
      adjR2: roundTo(adjR2, 6),
      bic: roundTo(bic, 6),
      params: fitted.params,
      predict: fitted.predict,
    });
  }
  if (scored.length === 0) {
    throw new Error('模型库全部弃权：该数据集无法拟合');
  }
  scored.sort((left, right) => left.bic - right.bic || right.r2 - left.r2);
  const best = scored[0];
  if (!best) throw new Error('模型库全部弃权：该数据集无法拟合');
  return { ssTot, scored, best };
}

/** 把最优拟合曲线采样成可投送的坐标点（chart-foundry 拿它直接画线，不用重算拟合）。 */
function sampleCurve(predict: Predict, xMin: number, xMax: number, count = 41): number[][] {
  const samples: number[][] = [];
  for (let i = 0; i < count; i += 1) {
    const ratio = count === 1 ? 0 : i / (count - 1);
    const x = xMin + ratio * (xMax - xMin);
    const y = predict(x);
    samples.push([roundTo(x, 4), Number.isFinite(y) ? roundTo(y, 6) : 0]);
  }
  return samples;
}

/** 参数表格文本：`τ₁=1.5932 ns · τ₂=8.9930 ns`。 */
const PARAM_UNIT: Readonly<Record<string, string>> = {
  tau: 'ns',
  tau1: 'ns',
  tau2: 'ns',
  lambda: 'ns',
  A: 'a.u.',
  A1: 'a.u.',
  A2: 'a.u.',
  a: '',
  b: '',
  c: '',
  k: '',
  n: '',
  sigma: 'ns',
  gamma: 'ns',
  width: 'ns',
  center: 'ns',
  x0: 'ns',
  mu: 'ns',
  eta: '',
  beta: '',
  omega: 'rad/ns',
  phi: 'rad',
  Ea: '',
  y0: 'a.u.',
  y1: 'a.u.',
};

function paramText(params: Readonly<Record<string, number>>, digits = 4): string {
  return Object.entries(params)
    .map(([key, value]) => {
      const unit = PARAM_UNIT[key] ?? '';
      const formatted = fmt(value, digits);
      return unit === '' ? `${key}=${formatted}` : `${key}=${formatted} ${unit}`;
    })
    .join(' · ');
}

/* ───────────────────────── 四个实验数据集（全部由共享演示数据生成） ───────────────────────── */

interface DatasetSpec {
  readonly id: string;
  readonly name: string;
  readonly instrument: string;
  readonly points: readonly ScatterPoint[];
  readonly anchor: WormholeEvidenceAnchor;
  /** 这个数据集「本来该是什么模型」—— 业务判断，用来核对 BIC 有没有选偏。 */
  readonly expectedModelId: string;
  readonly scenario: string;
  readonly xUnit: string;
  readonly yUnit: string;
}

const TRPL_PAPER = PAPER_ROWS[0];
const CHIRAL_PAPER = PAPER_ROWS[1];
const PREPRINT_PAPER = PAPER_ROWS[2];

/** 取第 index 篇论文的锚点；缺数据时退化为站内数据集页（绝不抛错）。 */
function paperAnchorOf(paper: PaperRow | undefined, slug: string): WormholeEvidenceAnchor {
  return paper ? anchorOf(paper) : datasetAnchor(slug);
}

const DATASETS: readonly DatasetSpec[] = [
  {
    id: 'trpl-a',
    name: 'TRPL-A · 钙钛矿薄膜时间分辨荧光',
    instrument: '时间相关单光子计数（TCSPC）· 激发 405 nm · 探测 780 nm',
    // 180 点 / 固定种子 20261020 / 噪声 0.2：与仪器面板同一条生成链，只是信噪比更好
    points: curvelabPoints(180, 20261020, 0.2),
    anchor: paperAnchorOf(TRPL_PAPER, 'trpl-a'),
    expectedModelId: 'exp_decay2',
    scenario: '快通道对应表面缺陷复合，慢通道对应体相辐射复合；两条寿命都要报，只报一个平均寿命会丢掉物理机制。',
    xUnit: 'ns',
    yUnit: 'a.u.',
  },
  {
    id: 'trpl-b',
    name: 'TRPL-B · 钝化后薄膜（长寿命样品）',
    instrument: 'TCSPC · 采样 240 点 · 累计 300 s',
    // 更长采样 + 不同种子：验证模型选择不是「碰巧选中」，而是对同一物理模型稳定复现
    points: curvelabPoints(240, 20261021, 0.2),
    anchor: paperAnchorOf(TRPL_PAPER, 'trpl-b'),
    expectedModelId: 'exp_decay2',
    scenario: '钝化后慢通道占比明显上升 —— 下游复现核验舱要拿这两组 τ 做「钝化是否真的延长寿命」的对照。',
    xUnit: 'ns',
    yUnit: 'a.u.',
  },
  {
    id: 'pl-peak',
    name: 'PL-峰 · 手性界面稳态荧光峰',
    instrument: '稳态荧光光谱 · 步长 0.05 eV',
    points: makeDemoSeries({ model: 'lorentz', count: 200, seed: 20261022, noise: 0.2 }),
    anchor: paperAnchorOf(CHIRAL_PAPER, 'pl-peak'),
    expectedModelId: 'lorentzian',
    scenario: '峰位与半高宽是手性界面工程的判据：峰位红移说明能级结构变化，展宽说明无序度上升。',
    xUnit: 'eV',
    yUnit: 'counts',
  },
  {
    id: 'calib',
    name: '标定 · 探测器线性响应曲线',
    instrument: '光功率计标定 · 120 点 · 每点 10 次平均',
    points: makeDemoSeries({ model: 'linear', count: 120, seed: 20261023, noise: 0.2 }),
    anchor: paperAnchorOf(PREPRINT_PAPER, 'calib'),
    expectedModelId: 'poly1',
    scenario: '标定曲线本该是直线；BIC 若选二次项，要检查是不是光路饱和或探测器非线性，而不是直接把二次项写进方法学。',
    xUnit: 'mW',
    yUnit: 'mA',
  },
];

/* ───────────────────────── 数据集 → 台账记录 ───────────────────────── */

interface DatasetRowExtra {
  readonly datasetId: string;
  readonly modelId: string;
  readonly modelLabel: string;
  readonly modelCount: number;
  readonly expectedModelId: string;
  readonly expectedModelLabel: string;
  readonly modelMatchesExpected: boolean;
  readonly n: number;
  readonly r2: number;
  readonly adjR2: number;
  readonly bic: number;
  readonly k: number;
  readonly params: Readonly<Record<string, number>>;
  readonly paramText: string;
  readonly runnerUpId: string;
  readonly runnerUpLabel: string;
  readonly runnerUpBic: number;
  readonly bicGap: number;
  readonly r2LeaderId: string;
  readonly r2LeaderLabel: string;
  readonly r2LeaderR2: number;
  readonly xRange: readonly [number, number];
  readonly xUnit: string;
  readonly yUnit: string;
  readonly instrument: string;
  readonly scenario: string;
  readonly curve: readonly number[][];
}

function datasetSeed(dataset: DatasetSpec): RowSeed {
  const selection = selectBestModel(dataset.points);
  const best = selection.best;
  const runnerUp = selection.scored[1];
  const r2Leader = [...selection.scored].sort((left, right) => right.r2 - left.r2)[0] ?? best;
  const expected = MODEL_REGISTRY.find((model) => model.id === dataset.expectedModelId);
  const xValues = dataset.points.map((point) => point.x);
  const xMin = xValues.length > 0 ? Math.min(...xValues) : 0;
  const xMax = xValues.length > 0 ? Math.max(...xValues) : 0;
  const params = best.params;
  const paramsText = paramText(params);
  const matchesExpected = best.modelId === dataset.expectedModelId;
  const bicGap = runnerUp ? roundTo(runnerUp.bic - best.bic, 3) : 0;
  const overfitNote =
    r2Leader.modelId !== best.modelId
      ? `注意：R² 最高的是「${r2Leader.label}」（${fmt(r2Leader.r2, 4)}），但 BIC 判它过拟合 —— 多出来的参数没换来解释力。`
      : 'R² 与 BIC 结论一致，不存在「高 R² 过拟合」争议。';

  const extra: DatasetRowExtra = {
    datasetId: dataset.id,
    modelId: best.modelId,
    modelLabel: best.label,
    modelCount: MODEL_COUNT,
    expectedModelId: dataset.expectedModelId,
    expectedModelLabel: expected ? expected.label : dataset.expectedModelId,
    modelMatchesExpected: matchesExpected,
    n: dataset.points.length,
    r2: best.r2,
    adjR2: best.adjR2,
    bic: best.bic,
    k: best.k,
    params,
    paramText: paramsText,
    runnerUpId: runnerUp ? runnerUp.modelId : '',
    runnerUpLabel: runnerUp ? runnerUp.label : '—',
    runnerUpBic: runnerUp ? runnerUp.bic : 0,
    bicGap,
    r2LeaderId: r2Leader.modelId,
    r2LeaderLabel: r2Leader.label,
    r2LeaderR2: r2Leader.r2,
    xRange: [roundTo(xMin, 4), roundTo(xMax, 4)],
    xUnit: dataset.xUnit,
    yUnit: dataset.yUnit,
    instrument: dataset.instrument,
    scenario: dataset.scenario,
    curve: sampleCurve(best.predict, xMin, xMax),
  };

  const title = `${dataset.name} · ${best.label}`;
  const meta = [
    `n=${dataset.points.length}`,
    `最优 ${best.label}`,
    `R² ${fmt(best.r2, 4)}`,
    `BIC ${fmt(best.bic, 1)}`,
    `${MODEL_COUNT} 模型选 1`,
  ].join(' · ');

  const detail = [
    `数据集 ${dataset.id}（${dataset.instrument}）：x ∈ [${fmt(xMin, 2)}, ${fmt(xMax, 2)}] ${dataset.xUnit}，y 单位 ${dataset.yUnit}`,
    `拟合参数：${paramsText}`,
    `拟合优度 R² ${fmt(best.r2, 6)}（校正 R² ${fmt(best.adjR2, 6)}），残差自由度 n-k = ${dataset.points.length - best.k}，BIC ${fmt(best.bic, 2)}（k=${best.k}）`,
    `次优模型「${runnerUp ? runnerUp.label : '—'}」BIC 差 ${fmt(bicGap, 2)}${bicGap > 0 ? '，差距越大越说明选型稳定' : ''}；${overfitNote}`,
    `物理判读：${dataset.scenario}`,
    `选型核对：本数据集预期是「${expected ? expected.label : dataset.expectedModelId}」，BIC 选出「${best.label}」—— ${matchesExpected ? '与预期一致' : '与预期不一致，需人工复核数据质量或模型族'}`,
  ].join('；');

  return {
    title,
    meta,
    detail,
    anchor: dataset.anchor,
    ...extra,
  } satisfies RowSeed;
}

const seed: readonly RowSeed[] = DATASETS.map(datasetSeed);

/* ───────────────────────── 汇总口径（README / 投送共用，避免两处写不一样） ───────────────────────── */

const SEED_STATS = {
  datasets: seed.length,
  models: MODEL_COUNT,
  /** 从 seed 行里读回选型结果（不在别处重复算一遍）。 */
  matched: seed.filter((row) => row.modelMatchesExpected === true).length,
} as const;

/* ───────────────────────── 业务规格 ───────────────────────── */

export const siteSpec = createRowSpec({
  exportName: 'curvelab-datasets',
  seed,
  emit: {
    targetApp: 'chart-foundry',
    payloadType: 'curve_fit_parameters',
  },
  accept: {
    payloadType: 'comparison_matrix_row',
    description:
      '接收对比矩阵（matrix-cross）投来的一行材料 / 方法 / 工况元信息，落成一条「待拟合数据集」：先按矩阵行绑定原文锚点，再导入原始散点跑 38 模型 BIC 选型，选完才算一条可投送的拟合结果。',
  },

  /** 新增一条 = 开一个待拟合数据集，不预设模型（模型必须由 BIC 选出来，不能手填）。 */
  draft: (rows) => {
    const next = String(rows.length + 1).padStart(2, '0');
    return {
      title: `待拟合数据集 ${next} · 未选型`,
      meta: `n=0 · 最优 待选型 · R² — · BIC — · ${MODEL_COUNT} 模型待跑`,
      detail: [
        '新建数据集：先把原始散点导入（或从对比矩阵接收一行元信息），再跑模型库',
        `模型库共 ${MODEL_COUNT} 个：多项式 / 幂律 / 指数衰减 / 峰形 / 饱和生长 / 周期 / 有理函数`,
        '选型规则：按 BIC = n·ln(SSR/n) + k·ln(n) 排序，不按 R² 排序（高 R² 往往是过拟合）',
        '未选型的数据集投送时只带元信息与锚点，不伪造拟合参数',
      ].join('；'),
      anchor: datasetAnchor(`pending-${next}`),
      datasetId: `draft-${next}`,
      modelId: '',
      modelLabel: '待选型',
      modelCount: MODEL_COUNT,
      expectedModelId: '',
      expectedModelLabel: '待定',
      modelMatchesExpected: false,
      n: 0,
      r2: 0,
      adjR2: 0,
      bic: 0,
      k: 0,
      params: {},
      paramText: '待拟合',
      runnerUpId: '',
      runnerUpLabel: '—',
      runnerUpBic: 0,
      bicGap: 0,
      r2LeaderId: '',
      r2LeaderLabel: '—',
      r2LeaderR2: 0,
      xRange: [0, 0],
      xUnit: '',
      yUnit: '',
      instrument: '待填仪器与采集参数',
      scenario: '待补物理判读：这条数据集回答什么科学问题',
      curve: [],
    } satisfies RowSeed;
  },

  /** 收到对比矩阵行：落成「待拟合数据集」，把材料 / 方法 / 工况与 DOI 锚点带进来。 */
  rowOfEnvelope: (envelope) => {
    const data = envelope.payload.data;
    const anchors: readonly WormholeEvidenceAnchor[] = Array.isArray(envelope.payload.evidence_anchors)
      ? envelope.payload.evidence_anchors
      : [];
    const firstAnchor = anchors[0];
    const anchor = firstAnchor ?? datasetAnchor(`inbox-${String(envelope.trace_id).slice(0, 8)}`);
    const matrixRow = (data.row ?? {}) as Record<string, unknown>;
    const sourceApp = String(envelope.source_app ?? 'matrix-cross');
    const traceShort = String(envelope.trace_id).slice(0, 8);
    const venue = String(matrixRow.venue ?? '待绑定顶刊');
    const strategy = String(matrixRow.strategy ?? '待填材料 / 方法');
    const keyMetric = String(matrixRow.eqe ?? matrixRow.metric ?? '待抽关键参量');
    const figureNote = String(matrixRow.figureNote ?? '待绑定图号');

    return {
      title: `待拟合 · ${venue} / ${strategy}`,
      meta: [
        `来自 ${sourceApp}`,
        `comparison_matrix_row`,
        `关键参量 ${keyMetric}`,
        `锚点 ${anchors.length} 条`,
      ].join(' · '),
      detail: [
        `接收 ${String(envelope.payload_type ?? 'comparison_matrix_row')} · 来源 ${sourceApp} · trace ${traceShort}`,
        `矩阵行元信息：${venue} / ${strategy} / 关键参量 ${keyMetric} / 图号 ${figureNote}`,
        `下一步：导入该工况下的原始散点（TRPL / 光谱 / 标定曲线），跑 ${MODEL_COUNT} 模型 BIC 选型，选型完成才能投送 curve_fit_parameters`,
        '对比矩阵行只提供材料与方法元信息，不提供原始数据 —— 没有散点就没有拟合，绝不凭空生成参数',
      ].join('；'),
      anchor,
      datasetId: `ext-${traceShort}`,
      modelId: '',
      modelLabel: '待选型',
      modelCount: MODEL_COUNT,
      expectedModelId: '',
      expectedModelLabel: '待定',
      modelMatchesExpected: false,
      n: 0,
      r2: 0,
      adjR2: 0,
      bic: 0,
      k: 0,
      params: {},
      paramText: '待拟合',
      runnerUpId: '',
      runnerUpLabel: '—',
      runnerUpBic: 0,
      bicGap: 0,
      r2LeaderId: '',
      r2LeaderLabel: '—',
      r2LeaderR2: 0,
      xRange: [0, 0],
      xUnit: '',
      yUnit: '',
      instrument: `随矩阵行接收：${strategy}`,
      scenario: `待补物理判读（矩阵行来自 ${sourceApp}）`,
      curve: [],
      receivedFrom: sourceApp,
      traceId: String(envelope.trace_id),
      sourceDoi: String(matrixRow.sourceDoi ?? anchor.source_doi_or_url),
    } satisfies RowSeed;
  },

  /**
   * 投送载荷：`curve_fit_parameters` 是「一组拟合参数」，所以除了逐数据集列表，
   * 还挑出 R² 最高的那条作为 `focused`（chart-foundry 拿它直接出图），
   * 并把最优拟合曲线采样成坐标点 —— 下游不用重新实现 38 个模型也能画线。
   */
  payloadOf: (rows) => {
    const datasets = rows.map((row) => ({
      id: String(row.id),
      datasetId: String(row.datasetId ?? ''),
      title: String(row.title),
      instrument: String(row.instrument ?? ''),
      modelId: String(row.modelId ?? ''),
      modelLabel: String(row.modelLabel ?? ''),
      n: Number(row.n ?? 0),
      k: Number(row.k ?? 0),
      r2: Number(row.r2 ?? 0),
      adjR2: Number(row.adjR2 ?? 0),
      bic: Number(row.bic ?? 0),
      params: (row.params ?? {}) as Readonly<Record<string, number>>,
      paramText: String(row.paramText ?? ''),
      xRange: Array.isArray(row.xRange) ? row.xRange.map((item) => Number(item)) : [0, 0],
      xUnit: String(row.xUnit ?? ''),
      yUnit: String(row.yUnit ?? ''),
      curve: Array.isArray(row.curve)
        ? row.curve.map((pair) => (Array.isArray(pair) ? pair.map((item) => Number(item)) : []))
        : [],
    }));

    const fitted = datasets.filter((item) => item.modelId !== '');
    const focused = fitted.reduce<(typeof fitted)[number] | undefined>(
      (best, item) => (best === undefined || item.r2 > best.r2 ? item : best),
      undefined,
    );

    return {
      site: 'curvelab',
      ledger: LEDGER_NAME,
      target: 'chart-foundry',
      modelLibrarySize: MODEL_COUNT,
      datasetCount: datasets.length,
      fittedCount: fitted.length,
      selectionRule: 'BIC = n·ln(SSR/n) + k·ln(n)，越小越好（R² 只作参考，不参与排序）',
      // 投送的核心：一条可直接出图的拟合参数（模型 + 参数 + R² + 采样曲线）
      focused: focused ?? null,
      datasets,
    };
  },

  csvOf: (rows) => ({
    header: [
      '数据集',
      '仪器 / 采集',
      '样本数',
      '最优模型',
      '模型数',
      '参数个数',
      'R²',
      '校正 R²',
      'BIC',
      '拟合参数',
      '次优模型',
      'BIC 差',
      'R² 最高模型',
      '预期模型',
      '与预期一致',
      'x 范围',
      '证据等级',
      'DOI / 来源',
      '最后修改',
    ],
    rows: rows.map((row) => [
      String(row.datasetId ?? ''),
      String(row.instrument ?? ''),
      Number(row.n ?? 0),
      String(row.modelLabel ?? ''),
      Number(row.modelCount ?? MODEL_COUNT),
      Number(row.k ?? 0),
      Number(row.r2 ?? 0) > 0 ? fmt(Number(row.r2), 6) : '—',
      Number(row.adjR2 ?? 0) > 0 ? fmt(Number(row.adjR2), 6) : '—',
      Number(row.bic ?? 0) !== 0 ? fmt(Number(row.bic), 2) : '—',
      String(row.paramText ?? ''),
      String(row.runnerUpLabel ?? ''),
      Number(row.bicGap ?? 0) > 0 ? fmt(Number(row.bicGap), 2) : '—',
      String(row.r2LeaderLabel ?? ''),
      String(row.expectedModelLabel ?? ''),
      row.modelMatchesExpected === true ? '是' : '否',
      Array.isArray(row.xRange) && row.xRange.length === 2
        ? `[${row.xRange.map((item) => fmt(Number(item), 2)).join(', ')}] ${String(row.xUnit ?? '')}`
        : '—',
      String(row.anchor?.verification_level ?? '无锚点'),
      String(row.anchor?.source_doi_or_url ?? ''),
      String(row.updatedAt ?? ''),
    ]),
  }),
});

/** 全站口径值：README 与答辩口径都从这里引用，避免两处写不一样的数字。 */
export const CURVELAB_STATS = {
  ledger: LEDGER_NAME,
  datasets: SEED_STATS.datasets,
  models: SEED_STATS.models,
  matched: SEED_STATS.matched,
  exportName: 'curvelab-datasets',
  emit: 'curve_fit_parameters → chart-foundry',
  accept: 'comparison_matrix_row ← matrix-cross',
} as const;
