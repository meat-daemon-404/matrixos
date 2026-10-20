/**
 * `lib/stats.ts` 纯函数单测。
 *
 * CurveLab 的拟合与置信带全靠这里。测试重点放在**退化输入**上：
 * 样本不足、x 全等、单点、零方差——这些是 18 个微站里最容易让 UI 崩或画出
 * 误导图形的地方。数值断言用 `approx`（浮点比较一律带容差，不用 ===）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  biExponential,
  confidenceHalfWidth,
  createRandom,
  gaussian,
  inverseNormalCdf,
  linearRegression,
  lorentzian,
  makeDemoSeries,
  meanAndSxx,
  residuals,
  tQuantile,
} from '../src/lib/stats.ts';

function approx(actual: number, expected: number, tol = 1e-9, msg = ''): void {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg || 'approx'}: expected ${expected} ± ${tol}, got ${actual}`,
  );
}

/* ------------------------------------------------------ linearRegression */

test('精确直线拟合出 slope=2 intercept=1 r2=1', () => {
  const pts: [number, number][] = [[0, 1], [1, 3], [2, 5], [3, 7]];
  const fit = linearRegression(pts);
  approx(fit.slope, 2);
  approx(fit.intercept, 1);
  approx(fit.r2, 1);
  approx(fit.residualStdError, 0);
  assert.equal(fit.n, 4);
  approx(fit.predict(10), 21);
});

test('样本不足 2 个 → 退化结果（slope 0，截距取首点 y）', () => {
  const fit = linearRegression([[2, 5]]);
  assert.equal(fit.slope, 0);
  assert.equal(fit.intercept, 5);
  assert.equal(fit.r2, 0);
  assert.equal(fit.residualStdError, 0);
  assert.equal(fit.n, 1);
  approx(fit.predict(3), 5);

  const empty = linearRegression([]);
  assert.equal(empty.n, 0);
  assert.equal(empty.intercept, 0);
});

test('x 全等（sxx=0）→ 退化而不是除零', () => {
  const fit = linearRegression([[1, 2], [1, 3], [1, 4]]);
  assert.equal(fit.slope, 0);
  assert.equal(fit.r2, 0);
});

test('y 全等（syy=0）→ r2=1（无残差可解释，定义为完全拟合）', () => {
  const fit = linearRegression([[0, 5], [10, 5]]);
  approx(fit.slope, 0);
  approx(fit.r2, 1);
});

test('负相关斜率为负', () => {
  const fit = linearRegression([[0, 10], [1, 8], [2, 6], [3, 4]]);
  approx(fit.slope, -2);
  approx(fit.intercept, 10);
  approx(fit.r2, 1);
});

/* ---------------------------------------------------------- confidence */

test('置信带在均值处最窄、离均值越远越宽', () => {
  const pts: [number, number][] = [[0, 1], [1, 3.2], [2, 4.9], [3, 7.1], [4, 8.8]];
  const fit = linearRegression(pts);
  const { meanX, sxx } = meanAndSxx(pts.map(([x]) => x));
  const atMean = confidenceHalfWidth(fit, meanX, meanX, sxx);
  const far = confidenceHalfWidth(fit, meanX + 4, meanX, sxx);
  assert.ok(atMean > 0, 'n≥3 且有离散度时应给出正宽度');
  assert.ok(far > atMean, '远离均值的置信带必须更宽');
});

test('n<3 或 sxx<=0 → 置信带 0（小样本不给假精确的窄带）', () => {
  const fit = linearRegression([[0, 1], [1, 2]]); // n=2
  approx(confidenceHalfWidth(fit, 0.5, 0.5, 0.5), 0);
  const fit3 = linearRegression([[0, 1], [1, 3], [2, 5]]);
  approx(confidenceHalfWidth(fit3, 1, 1, 0), 0); // sxx=0
});

/* ------------------------------------------------------------ tQuantile */

test('小样本 t 分位查表', () => {
  assert.equal(tQuantile(0.95, 1), 12.706);
  assert.equal(tQuantile(0.95, 4), 2.776);
});

test('df 越大越接近正态（1.96）', () => {
  assert.ok(tQuantile(0.95, 1) > tQuantile(0.95, 30));
  approx(tQuantile(0.95, 1e6), 1.959964, 0.01);
});

test('df<=0 退化成 z', () => {
  approx(tQuantile(0.95, 0), inverseNormalCdf(0.975), 1e-6);
});

/* ------------------------------------------------------ inverseNormalCdf */

test('中心 0.5 → 0，且关于 0.5 反对称', () => {
  approx(inverseNormalCdf(0.5), 0, 1e-6);
  approx(inverseNormalCdf(0.025), -inverseNormalCdf(0.975), 1e-6);
});

test('下尾 0.001 给出负值上尾给正', () => {
  assert.ok(inverseNormalCdf(0.001) < -3);
  assert.ok(inverseNormalCdf(0.999) > 3);
});

test('非有限/越界被夹进 [0,1]，不返回 NaN', () => {
  assert.ok(Number.isFinite(inverseNormalCdf(Number.NaN)));
  assert.ok(Number.isFinite(inverseNormalCdf(2)));
  assert.ok(Number.isFinite(inverseNormalCdf(-1)));
});

/* -------------------------------------------------------------- meanAndSxx */

test('空数组返回 0/0', () => {
  const r = meanAndSxx([]);
  assert.equal(r.meanX, 0);
  assert.equal(r.sxx, 0);
});

test('均匀分布 [0,2,4] mean=2 sxx=8', () => {
  const r = meanAndSxx([0, 2, 4]);
  approx(r.meanX, 2);
  approx(r.sxx, 8);
});

/* ------------------------------------------------------------- residuals */

test('残差 = 观测 - 预测', () => {
  const pts: [number, number][] = [[0, 1], [1, 3], [2, 6]];
  const fit = linearRegression(pts);
  const res = residuals(pts, fit);
  assert.equal(res.length, 3);
  approx(res[0].r, 1 - fit.predict(0));
  approx(res.reduce((a, b) => a + b.r, 0), 0, 1e-9, 'OLS 残差和为 0');
});

/* ------------------------------------------------------------- 伪随机 */

test('createRandom 同 seed 可复现，异 seed 不同', () => {
  const a = createRandom(42);
  const b = createRandom(42);
  const c = createRandom(43);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB, '同 seed 必须逐值相同');
  assert.notDeepEqual(seqA, [c(), c(), c()]);
});

test('mulberry32 落在 [0,1)', () => {
  const rand = createRandom(7);
  for (let i = 0; i < 2000; i += 1) {
    const v = rand();
    assert.ok(v >= 0 && v < 1, `越界：${v}`);
  }
});

test('gaussian 大致正态（均值近 0，不产生 NaN）', () => {
  const rand = createRandom(123);
  const sample = Array.from({ length: 4000 }, () => gaussian(rand));
  const mean = sample.reduce((s, v) => s + v, 0) / sample.length;
  assert.ok(Math.abs(mean) < 0.1, `均值应近 0，实际 ${mean}`);
  assert.ok(sample.every(Number.isFinite), '不得出现 NaN/Inf');
});

/* ------------------------------------------------------------- 物理模型 */

test('biExponential：x=0 等于两振幅之和，快速分量先衰减', () => {
  approx(biExponential(0, 3, 1, 2, 5), 5);
  assert.ok(biExponential(2, 3, 1, 2, 5) < biExponential(0, 3, 1, 2, 5));
});

test('biExponential：tau<=0 用 1e-9 兜底，不出现除零 Inf', () => {
  assert.ok(Number.isFinite(biExponential(1, 1, 0, 1, 1)));
  assert.ok(Number.isFinite(biExponential(1, 1, -5, 1, 1)));
});

test('lorentzian：峰心 = 振幅，半高宽处 ≈ 振幅/2', () => {
  approx(lorentzian(5, 5, 2, 10), 10);
  approx(lorentzian(7, 5, 2, 10), 5); // x-center = gamma → 幅度减半
  approx(lorentzian(3, 5, 2, 10), 5);
});

test('lorentzian：gamma<=0 用 1e-9 兜底', () => {
  assert.ok(Number.isFinite(lorentzian(1, 0, 0, 1)));
});

/* --------------------------------------------------------- makeDemoSeries */

test('makeDemoSeries 同参数 → 完全一致（视觉评审可复现）', () => {
  const s1 = makeDemoSeries({ count: 20, seed: 99 });
  const s2 = makeDemoSeries({ count: 20, seed: 99 });
  assert.deepEqual(s1, s2);
});

test('makeDemoSeries 三种模型都能出有限点', () => {
  for (const model of ['linear', 'exp', 'lorentz'] as const) {
    const series = makeDemoSeries({ count: 30, model });
    assert.equal(series.length, 30);
    assert.ok(series.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  }
});

test('makeDemoSeries 的 x 在 [xMin,xMax] 且单调不减', () => {
  const series = makeDemoSeries({ count: 25, xMin: 2, xMax: 8 });
  for (let i = 0; i < series.length; i += 1) {
    assert.ok(series[i].x >= 2 && series[i].x <= 8);
    if (i > 0) assert.ok(series[i].x >= series[i - 1].x);
  }
});
