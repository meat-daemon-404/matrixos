/**
 * `lib/contrast.ts` 单测 + **设计 token 对比度守卫**。
 *
 * 为什么这里要带一个守卫：`src/tokens.css` 每个色值注释都写了「实测比值」
 * （`--iu-instrument: #06b6d4; /* cyan-500（7.35 ✓ AAA） *\/`），而 `contrast.ts`
 * 的头注释自己点明了痛点——「视觉体系文档给出了实测表，但没有**可执行的守卫**」。
 * 也就是说：那张表一旦与代码脱节，没人会发现，V6 那类回归会静默重演。
 *
 * 本文件把承诺变成断言：
 *   1. 注释里声称的比值 == `worstContrast(hex, SURFACE_LIST)` 的真实计算值；
 *   2. 凡注释标了 `✓ AA` / `✓ AAA` 的，真实比值必须站得住该档；
 *   3. 凡注释标了 `✗` 的（只允许做图形/大字），必须确实**不达** 4.5:1——
 *      这条防止有人「顺手把 ✗ 改成 ✓」而没真的调色值。
 *
 * **基准为什么是 worstContrast 而不是某个固定背景**：组件会出现在全部五种表面上，
 * 项目策略是按最坏情况验收。实测校验下来，tokens.css 的注释值恰好等于
 * 对 `SURFACE_LIST` 取最小值的结果（五种表面里最亮的是 `#0f172a`，即最坏情况）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  contrastRatio,
  hexToRgb,
  pickReadable,
  relativeLuminance,
  SURFACES,
  SURFACE_LIST,
  wcagLevel,
  worstContrast,
} from '../src/lib/contrast.ts';

const TOKENS_CSS = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'tokens.css');

/* ------------------------------------------------------ hexToRgb */

test('hexToRgb 支持 #rgb / #rrggbb / #rrggbbaa', () => {
  assert.deepEqual(hexToRgb('#fff'), [255, 255, 255]);
  assert.deepEqual(hexToRgb('#050814'), [5, 8, 20]);
  assert.deepEqual(hexToRgb('#050814ff'), [5, 8, 20]); // alpha 被丢弃
  assert.deepEqual(hexToRgb('ffffff'), [255, 255, 255]); // 可不带 #
  assert.deepEqual(hexToRgb('  #ABC  '), [170, 187, 204]); // 大小写与空白容错：A=10→170
});

test('hexToRgb 非法输入返回 null 而不是崩', () => {
  assert.equal(hexToRgb('#12'), null);
  assert.equal(hexToRgb('#gggggg'), null);
  assert.equal(hexToRgb('not-a-color'), null);
  assert.equal(hexToRgb(''), null);
});

/* ------------------------------------------------------ 亮度与比值 */

test('relativeLuminance：纯黑 0、纯白 1', () => {
  approx(relativeLuminance('#000000'), 0, 1e-9);
  approx(relativeLuminance('#ffffff'), 1, 1e-9);
});

test('非法色值的亮度按 0 处理（不返回 NaN 污染下游）', () => {
  assert.equal(relativeLuminance('#zzzzzz'), 0);
});

test('contrastRatio：黑白 21:1、同色 1:1，且参数顺序无关', () => {
  approx(contrastRatio('#000000', '#ffffff'), 21, 0.01);
  approx(contrastRatio('#0f172a', '#0f172a'), 1, 1e-9);
  assert.equal(contrastRatio('#fff', '#000'), contrastRatio('#000', '#fff'));
});

test('wcagLevel 四档边界', () => {
  assert.equal(wcagLevel(7), 'AAA');
  assert.equal(wcagLevel(6.999), 'AA');
  assert.equal(wcagLevel(4.5), 'AA');
  assert.equal(wcagLevel(4.499), 'AA-large');
  assert.equal(wcagLevel(3), 'AA-large');
  assert.equal(wcagLevel(2.999), 'FAIL');
});

/* ------------------------------------------------------ worst / pick */

test('worstContrast 取一组底色里的最差值', () => {
  const single = contrastRatio('#ffffff', '#0f172a');
  const worst = worstContrast('#ffffff', ['#000000', '#0f172a']);
  approx(worst, single, 1e-9, '最坏情况应落在最亮的那块表面');
});

test('worstContrast 空背景数组退化到纯黑（不返回 Infinity）', () => {
  approx(worstContrast('#ffffff', []), contrastRatio('#ffffff', '#000000'), 1e-9);
});

test('pickReadable 选出比值最高的候选，空候选给出安全默认', () => {
  const pick = pickReadable('#050814', ['#1e293b', '#ffffff', '#94a3b8']);
  assert.equal(pick.color, '#ffffff');
  assert.ok(pick.ratio >= 16);

  const fallback = pickReadable('#050814', []);
  assert.equal(fallback.color, '#ffffff');
  assert.equal(fallback.ratio, 0, '没有候选时比值无从计算，如实给 0');
});

test('SURFACES 与 SURFACE_LIST 同源', () => {
  assert.deepEqual([...SURFACE_LIST].sort(), Object.values(SURFACES).slice().sort());
  assert.equal(SURFACES.obsidian, '#050814');
});

/* ============================================ 设计 token 对比度守卫 */

/** tokens.css 里带比值注释的色值 token。 */
interface TokenClaim {
  name: string;
  hex: string;
  claimed: number;
  mark: 'AAA' | 'AA' | 'fail' | null;
}

function parseTokenClaims(css: string): TokenClaim[] {
  const rows: TokenClaim[] = [];
  // 形如：--iu-danger-bright: #fb7185;   /* rose-400（6.63 ✓ AA） */
  // 只认带小数的比值，避开 slate-950 / indigo-400 这类色号数字。
  const re = /--(iu-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;([^\n]*)/g;
  for (const match of css.matchAll(re)) {
    const [, name, hex, tail] = match;
    const ratioMatch = tail.match(/(\d+\.\d{2})/);
    if (!ratioMatch) continue;
    const mark = tail.includes('✓ AAA')
      ? 'AAA'
      : tail.includes('✓ AA')
        ? 'AA'
        : tail.includes('✗')
          ? 'fail'
          : null;
    rows.push({ name: `--${name}`, hex: hex as string, claimed: Number(ratioMatch[1]), mark });
  }
  return rows;
}

const claims = parseTokenClaims(readFileSync(TOKENS_CSS, 'utf8'));

test('tokens.css 的对比度注释确实存在（守卫本身不能空跑）', () => {
  assert.ok(
    claims.length >= 15,
    `只解析到 ${claims.length} 条带比值的 token 注释，守卫可能已与 tokens.css 格式脱节`,
  );
});

test('注释里声称的比值 == worstContrast 的真实计算值', () => {
  const drift: string[] = [];
  for (const row of claims) {
    const actual = worstContrast(row.hex, SURFACE_LIST);
    if (Math.abs(actual - row.claimed) > 0.02) {
      drift.push(`${row.name} ${row.hex} 注释写 ${row.claimed}，实际 ${actual.toFixed(2)}`);
    }
  }
  assert.deepEqual(drift, [], `\n以下 token 的注释与真实比值脱节：\n${drift.join('\n')}`);
});

test('标了 ✓ AA / ✓ AAA 的文本色，真实比值必须站得住', () => {
  const broken: string[] = [];
  for (const row of claims) {
    if (!row.mark || row.mark === 'fail') continue;
    const actual = worstContrast(row.hex, SURFACE_LIST);
    const bar = row.mark === 'AAA' ? 7 : 4.5;
    if (actual < bar) broken.push(`${row.name} 标 ${row.mark} 但只有 ${actual.toFixed(2)}`);
  }
  assert.deepEqual(broken, [], broken.join('\n'));
});

test('标了 ✗（仅图形/大字）的色，确实不达 4.5:1 —— 防止顺手改成 ✓ 却没调色值', () => {
  const wrongfullyMarked: string[] = [];
  for (const row of claims) {
    if (row.mark !== 'fail') continue;
    const actual = worstContrast(row.hex, SURFACE_LIST);
    if (actual >= 4.5) wrongfullyMarked.push(`${row.name} 标 ✗ 但实际 ${actual.toFixed(2)} 已过 AA`);
  }
  assert.deepEqual(
    wrongfullyMarked,
    [],
    `${wrongfullyMarked.join('\n')}\n—— 色值变亮了却还标着仅图形，请复核注释或该色是否被改动`,
  );
});

test('正文与主数值色在全部表面上都过 AAA', () => {
  for (const name of ['--iu-text', '--iu-text-strong', '--iu-text-secondary']) {
    const row = claims.find((c) => c.name === name);
    assert.ok(row, `tokens.css 里找不到 ${name}`);
    assert.ok(
      wcagLevel(worstContrast(row!.hex, SURFACE_LIST)) === 'AAA',
      `${name} 作为正文主力色必须 AAA`,
    );
  }
});

/* -------------------------------------------------------- 已知值参照 */

test('黑白与常见组合对照 WCAG 官方值', () => {
  // #767676 on white 是业界常用的「刚好过 AA」临界灰，官方值 4.54:1
  approx(contrastRatio('#767676', '#ffffff'), 4.54, 0.02);
  // 纯白压 obsidian 底色：19.98:1（#f1f5f9 才是 18.23，别记混）
  approx(contrastRatio('#ffffff', '#050814'), 19.98, 0.05);
  approx(contrastRatio('#f1f5f9', '#050814'), 18.23, 0.05);
});

function approx(actual: number, expected: number, tol: number, msg = ''): void {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg || 'approx'}: expected ${expected} ± ${tol}, got ${actual}`,
  );
}
