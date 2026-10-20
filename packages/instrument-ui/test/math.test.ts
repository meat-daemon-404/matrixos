/**
 * `lib/math.ts` 纯函数单测（node:test + 类型剥离，无需构建）。
 *
 * 这批测试补的是 P2「给 instrument-ui 的纯函数补测试，成本极低」这一项。
 * 断言瞄准的是**边界语义**而不是随手一测：区间退化、非有限值、min>max 自动交换、
 * 浮点噪声不进显示层——这些正是 18 个微站共用时会静默出错的地方。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  arcPath,
  clamp,
  decimalsOf,
  distributeEvenly,
  downsample,
  ellipsePoint,
  formatCompact,
  formatFixed,
  formatSigned,
  isFiniteNumber,
  lerp,
  linearMap,
  mapRange,
  niceDomain,
  niceTicks,
  normalize,
  normalizeAngle,
  polarToCartesian,
  roundTo,
  snapToStep,
} from '../src/lib/math.ts';

/* ------------------------------------------------------------ clamp */

test('clamp 夹在区间内', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-5, 0, 3), 0);
  assert.equal(clamp(2, 0, 3), 2);
});

test('clamp 在 min > max 时自动交换（调用方写反不该产生 NaN 或越界）', () => {
  assert.equal(clamp(5, 3, 0), 3);
  assert.equal(clamp(-1, 3, 0), 0);
  assert.equal(clamp(1.5, 3, 0), 1.5);
});

test('clamp 非有限值返回 min（脏数据落到安全端，不是 NaN）', () => {
  assert.equal(clamp(Number.NaN, 1, 5), 1);
  assert.equal(clamp(Number.POSITIVE_INFINITY, 1, 5), 1);
  assert.equal(clamp(Number.NEGATIVE_INFINITY, 1, 5), 1);
});

/* -------------------------------------------------------- normalize */

test('normalize 归一到 0..1', () => {
  assert.equal(normalize(5, 0, 10), 0.5);
  assert.equal(normalize(-5, 0, 10), 0);
  assert.equal(normalize(15, 0, 10), 1);
});

test('normalize 区间退化返回 0（0/0 不允许泄漏成 NaN）', () => {
  assert.equal(normalize(7, 3, 3), 0);
});

/* -------------------------------------------------- linearMap/mapRange */

test('linearMap 不裁剪——Canvas 比例尺需要能出界', () => {
  assert.equal(linearMap(12, 0, 10, 0, 100), 120);
  assert.equal(linearMap(-2, 0, 10, 0, 100), -20);
});

test('linearMap 区间退化返回 outMin', () => {
  assert.equal(linearMap(5, 2, 2, 42, 100), 42);
});

test('mapRange 裁剪到输出区间', () => {
  assert.equal(mapRange(12, 0, 10, 0, 100), 100);
  assert.equal(mapRange(-1, 0, 10, 0, 100), 0);
});

test('lerp 端点与中点', () => {
  assert.equal(lerp(10, 20, 0), 10);
  assert.equal(lerp(10, 20, 1), 20);
  assert.equal(lerp(10, 20, 0.5), 15);
});

/* ------------------------------------------------------------ roundTo */

test('roundTo 保留指定位数', () => {
  assert.equal(roundTo(3.14159, 2), 3.14);
  assert.equal(roundTo(3.14159, 0), 3);
  assert.equal(roundTo(1234.5, -1), 1235); // 负位数被夹到 0 位 → 取整，而不是原样返回
});

test('roundTo 压掉 0.1+0.2 的浮点噪声', () => {
  assert.equal(roundTo(0.1 + 0.2, 1), 0.3);
});

test('roundTo 的位数被夹在 0..12（防止 10**n 溢出）', () => {
  assert.equal(roundTo(1.2345678901234, 99), 1.234567890123);
  assert.equal(roundTo(1.5, 0.4), 2); // decimals 先取整
});

/* --------------------------------------------------------- decimalsOf */

test('decimalsOf 由 step 推断显示位数', () => {
  assert.equal(decimalsOf(1), 0);
  assert.equal(decimalsOf(0.05), 2);
  assert.equal(decimalsOf(0.001), 3);
});

test('decimalsOf 处理科学计数法', () => {
  assert.equal(decimalsOf(1e-4), 4);
});

test('decimalsOf 对非正数与非有限值返回 0', () => {
  assert.equal(decimalsOf(0), 0);
  assert.equal(decimalsOf(-0.5), 0);
  assert.equal(decimalsOf(Number.NaN), 0);
});

/* ---------------------------------------------------------- snapToStep */

test('snapToStep 吸附到网格', () => {
  assert.equal(snapToStep(0.48, 0.5), 0.5);
  assert.equal(snapToStep(0.21, 0.5), 0);
  assert.equal(snapToStep(1.3, 0.5, 0.3), 1.3); // 以 0.3 为原点恰在格上
});

test('snapToStep 以 min 为原点避免出现半格', () => {
  assert.equal(snapToStep(1.0, 0.5, 0.25), 1.25);
  assert.equal(snapToStep(1.0, 0.5, 0), 1);
});

test('snapToStep 非法 step 原样返回（不做无意义的取整）', () => {
  assert.equal(snapToStep(1.234, 0), 1.234);
  assert.equal(snapToStep(1.234, Number.NaN), 1.234);
});

/* --------------------------------------------------------- 格式化三兄弟 */

test('formatFixed 定点且吞掉非有限值', () => {
  assert.equal(formatFixed(3.14159, 2), '3.14');
  assert.equal(formatFixed(Number.NaN, 2), '0.00');
  assert.equal(formatFixed(5, 0), '5');
});

test('formatSigned 正数带 + 号', () => {
  assert.equal(formatSigned(0.5, 1), '+0.5');
  assert.equal(formatSigned(-0.5, 1), '-0.5');
  assert.equal(formatSigned(0, 1), '0.0'); // 0 不算正数
});

test('formatCompact 用中文万亿单位', () => {
  assert.equal(formatCompact(12345), '1.2万');
  assert.equal(formatCompact(123456789), '1.2亿');
  // 阈值是 1e4：五千不到「万」，原样取整；负号单独前置
  assert.equal(formatCompact(-5000), '-5000');
  assert.equal(formatCompact(-25000), '-2.5万');
  assert.equal(formatCompact(9999), '9999');
});

/* ------------------------------------------------------------ 几何 */

test('polarToCartesian 以 12 点方向为 0°、顺时针为正', () => {
  const top = polarToCartesian(100, 100, 50, 0);
  assert.ok(Math.abs(top.x - 100) < 1e-9, '0° 应在正上方');
  assert.ok(Math.abs(top.y - 50) < 1e-9);

  const right = polarToCartesian(100, 100, 50, 90);
  assert.ok(Math.abs(right.x - 150) < 1e-9, '90° 应在正右方');
  assert.ok(Math.abs(right.y - 100) < 1e-9);

  const bottom = polarToCartesian(100, 100, 50, 180);
  assert.ok(Math.abs(bottom.y - 150) < 1e-9);
});

test('ellipsePoint 在 0°/90° 上退化到 rx/ry 端点', () => {
  const top = ellipsePoint(0, 0, 120, 50, 0);
  assert.ok(Math.abs(top.x) < 1e-9 && Math.abs(top.y + 50) < 1e-9);
  const right = ellipsePoint(0, 0, 120, 50, 90);
  assert.ok(Math.abs(right.x - 120) < 1e-9 && Math.abs(right.y) < 1e-9);
});

test('arcPath 非整圆输出单段圆弧指令', () => {
  const path = arcPath(50, 50, 40, 0, 90);
  const matches = path.match(/A/g) ?? [];
  assert.equal(matches.length, 1, '单段弧应只有一个 A 指令');
  assert.match(path, /^M [\d.+-]+ [\d.+-]+ A/);
});

test('arcPath 整圆必须拆成两段（SVG 单段 A 画不出整圆）', () => {
  const path = arcPath(50, 50, 40, 0, 360);
  const matches = path.match(/A/g) ?? [];
  assert.equal(matches.length, 2, '整圆要两段半弧');
});

test('normalizeAngle 归一到 [0,360)', () => {
  assert.equal(normalizeAngle(0), 0);
  assert.equal(normalizeAngle(360), 0);
  assert.equal(normalizeAngle(-90), 270);
  assert.equal(normalizeAngle(450), 90);
});

test('distributeEvenly 把 18 个胶囊均匀铺满一周', () => {
  assert.equal(distributeEvenly(18, 0), 0);
  assert.ok(Math.abs(distributeEvenly(18, 1) - 20) < 1e-9);
  assert.equal(distributeEvenly(0, 5), 0, 'count=0 不该除零');
});

/* ------------------------------------------------------------ 刻度 */

test('niceTicks 产出 1/2/5×10^n 的整齐刻度', () => {
  const ticks = niceTicks(0, 10, 5);
  assert.ok(ticks.length >= 2);
  assert.equal(ticks[0], 0);
  const steps = new Set(ticks.slice(1).map((t, i) => roundTo(t - ticks[i], 6)));
  assert.equal(steps.size, 1, `步长必须唯一，实际 ${[...steps]}`);
  assert.ok([1, 2, 5, 10].includes(Number([...steps][0])), '步长应落在 1/2/5×10^n');
});

test('niceTicks 退化区间只返回一个点（不返回空数组让调用方崩）', () => {
  assert.deepEqual(niceTicks(5, 5, 5), [5]);
  assert.deepEqual(niceTicks(Number.NaN, 5, 5), [Number.NaN]);
});

test('niceTicks 对极端区间有 200 条上限保护', () => {
  assert.ok(niceTicks(1e-9, 1e9, 50).length <= 200);
});

test('niceDomain 把区间扩到整齐边界，且 min===max 时对称外扩', () => {
  const [lo, hi] = niceDomain(0.3, 9.7);
  assert.ok(lo <= 0.3 && hi >= 9.7);
  assert.deepEqual(niceDomain(5, 5), [4, 6]);
});

/* ------------------------------------------------------------ 采样 */

test('downsample 均匀降采样且保序', () => {
  const src = Array.from({ length: 100 }, (_, i) => i);
  const out = downsample(src, 10);
  assert.equal(out.length, 10);
  assert.equal(out[0], 0);
  assert.ok(out.every((v, i, arr) => i === 0 || v > arr[i - 1]), '必须保序递增');
});

test('downsample 在长度不超时原样返回（不多一次拷贝）', () => {
  const src = [1, 2, 3];
  assert.equal(downsample(src, 10), src);
});

test('downsample 的 maxCount<=0 原样返回（不让除零产生 Infinity 步长）', () => {
  const src = [1, 2, 3];
  assert.equal(downsample(src, 0), src);
});

/* -------------------------------------------------------- isFiniteNumber */

test('isFiniteNumber 挡掉 NaN / Infinity / 非数字', () => {
  assert.equal(isFiniteNumber(1.5), true);
  assert.equal(isFiniteNumber(Number.NaN), false);
  assert.equal(isFiniteNumber(Number.POSITIVE_INFINITY), false);
  assert.equal(isFiniteNumber('3' as unknown), false);
  assert.equal(isFiniteNumber(null as unknown), false);
});
