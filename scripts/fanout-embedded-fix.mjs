#!/usr/bin/env node
/**
 * scripts/fanout-embedded-fix.mjs
 *
 * 幂等扇出：把 apps/micro-sites/11-curvelab-fit 上已验证的两处 P0 修复
 * 复制到其余微站的 src/app/globals.css。
 *
 *   补丁 1  嵌入模式取消视口高度 + 压制 instrument-ui 的 .iu-sr-only 表格撑高
 *           （锚点：`.mono { font-family: var(--font-mono)` 之前）
 *   补丁 2  嵌入模式紧凑布局（min-height / margin / footer 留白三行）
 *           （锚点：`body[data-embedded='true'] .site-root { padding: 10px; gap: 10px; }` 之后）
 *
 * 设计约束（与任务书一致）：
 *   - 只遍历 apps/micro-sites/<site>/src/app/globals.css，不碰 layout.tsx / gen-site.mjs / services / docs。
 *   - 幂等：两个补丁标记都在 => skip，重复执行零写入、字节级不变。
 *   - 按锚点**整行**定位插入，绝不按行号（各站行数不同）。
 *   - 锚点找不到 / 锚点不唯一 / 两个补丁只落了一个 => 记 FAIL 并跳过该站，绝不静默写错位置。
 *   - --dry-run 只报告不写盘。
 *   - 末尾汇总「改了 N 站 / 跳过 M 站 / 失败 K 站」；有 FAIL 时退出码 1。
 *
 * 用法：
 *   node scripts/fanout-embedded-fix.mjs --dry-run
 *   node scripts/fanout-embedded-fix.mjs
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const SITES_DIR = path.join(REPO_ROOT, 'apps', 'micro-sites');
const REFERENCE_SITE = '11-curvelab-fit';

/* ── 锚点（整行匹配；取自各站 globals.css 的实际文本） ─────────────────────── */
const ANCHOR_MONO_PREFIX = '.mono { font-family: var(--font-mono)';
const ANCHOR_EMBED_PADDING = "body[data-embedded='true'] .site-root { padding: 10px; gap: 10px; }";

/* ── 幂等标记（只可能分别来自补丁 1 / 补丁 2） ─────────────────────────────── */
const MARKER_PATCH1 = 'max-height: 1px';
const MARKER_PATCH2 = "body[data-embedded='true'] .site-footer { margin-top: 8px; padding: 8px 0; }";

/* ── 补丁原文（逐字；末尾空串=两侧各留一个空行的分隔） ─────────────────────── */
const PATCH1_BLOCK = [
  '/* 仅嵌入模式取消视口高度（ADR-08：iframe 内不滚，高度跟着 hub 走） */',
  "body[data-embedded='true'] { min-height: 0; }",
  '',
  '/*',
  ' * 无障碍等价数据表（instrument-ui 的 .iu-sr-only）压制。',
  ' *',
  ' * 为什么必须在这里补：库里的 .iu-sr-only 只给了 width/height: 1px，',
  ' * 而 <table> 的 display 是 table，1px 对表格是「最小宽度」不是上限 ——',
  ' * 表格按内容撑成 196 × 4164 px（CurveLab 180 行数据点），虽然被 clip 掉看不见，',
  ' * 却照样计入文档的可滚动溢出区，把页面顶到 4410 px。',
  ' * 这些表只服务于读屏软件（position: absolute 已脱离文档流），',
  ' * 所以这里把宽高压成硬上限并改用 block，打断表格布局算法；语义不变，读屏照读。',
  ' */',
  '.iu-sr-only {',
  '  display: block;',
  '  max-width: 1px;',
  '  max-height: 1px;',
  '  overflow: hidden;',
  '}',
  '',
];

/** 补丁 2 以「前导空行」开头，正好对位参考站里锚点行与规则之间的那个空行。 */
const PATCH2_BLOCK = [
  '',
  '/* 嵌入模式紧凑布局：不留视口高度、不留 auto 外边距、不收尾留白。',
  ' * 三条都是「按 iframe 高度自适应」的必要项 —— 只要留一条，内容就会被撑出',
  ' * iframe 可视区，从而出现内层滚动条（ADR-08 明令禁止的双滚动条）。 */',
  "body[data-embedded='true'] .site-root { min-height: 0; }",
  "body[data-embedded='true'] .site-root { margin: 0 auto; }",
  "body[data-embedded='true'] .site-footer { margin-top: 8px; padding: 8px 0; }",
  '',
];

function rel(p) {
  const r = path.relative(process.cwd(), p);
  return r === '' ? '.' : r;
}

/** 行尾风格：CRLF 与 LF 都支持，写回时保持原样。 */
function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function toLines(text, eol) {
  return text.split(eol);
}

/** 整行锚点定位：要求唯一命中。返回 {ok, index, reason}。 */
function findUniqueLine(lines, match, label) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (match(lines[i])) hits.push(i);
  if (hits.length === 0) return { ok: false, reason: `锚点未找到：${label}` };
  if (hits.length > 1) return { ok: false, reason: `锚点不唯一（整行命中 ${hits.length} 次）：${label}` };
  return { ok: true, index: hits[0] };
}

/**
 * 对参考站做前置校验：脚本内的两处补丁常量必须与 11-curvelab-fit 现网文件逐字一致，
 * 否则拒绝扇出（防止「自创写法」悄悄漂移）。
 */
function verifyAgainstReference(messages) {
  const refPath = path.join(SITES_DIR, REFERENCE_SITE, 'src', 'app', 'globals.css');
  if (!existsSync(refPath)) {
    messages.push(`  ! 参考站文件不存在（${rel(refPath)}），跳过逐字一致性自检`);
    return true;
  }
  const ref = readFileSync(refPath, 'utf8');
  if (!ref.includes(MARKER_PATCH1) || !ref.includes(MARKER_PATCH2)) {
    messages.push(`  ! 参考站 ${REFERENCE_SITE} 尚未打补丁，跳过逐字一致性自检`);
    return true;
  }

  const lines = toLines(ref, detectEol(ref));
  const a1 = findUniqueLine(lines, (l) => l.startsWith(ANCHOR_MONO_PREFIX), '参考站补丁1锚点 .mono');
  const a2 = findUniqueLine(lines, (l) => l === ANCHOR_EMBED_PADDING, '参考站补丁2锚点 embedded padding');
  if (!a1.ok || !a2.ok) {
    messages.push(`  ✗ 参考站锚点异常：${[a1.reason, a2.reason].filter(Boolean).join(' / ')}`);
    return false;
  }

  const refBlock1 = lines.slice(a1.index - PATCH1_BLOCK.length, a1.index);
  const refBlock2 = lines.slice(a2.index + 1, a2.index + 1 + PATCH2_BLOCK.length);
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  let ok = true;
  if (!same(refBlock1, PATCH1_BLOCK)) {
    messages.push('  ✗ 脚本内补丁 1 与参考站 11-curvelab-fit 原文不一致（常量已漂移）');
    ok = false;
  }
  if (!same(refBlock2, PATCH2_BLOCK)) {
    messages.push('  ✗ 脚本内补丁 2 与参考站 11-curvelab-fit 原文不一致（常量已漂移）');
    ok = false;
  }
  if (ok) {
    messages.push(`  ✓ 逐字一致性自检通过：脚本内两处补丁与 ${REFERENCE_SITE} 现网原文逐字相同`);
  }
  return ok;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法: node scripts/fanout-embedded-fix.mjs [--dry-run]');
    return 0;
  }
  const unknown = argv.filter((a) => a !== '--dry-run');
  if (unknown.length) {
    console.error(`未知参数: ${unknown.join(' ')}（仅支持 --dry-run）`);
    return 2;
  }
  const dryRun = argv.includes('--dry-run');

  const messages = [];
  if (!verifyAgainstReference(messages)) {
    console.error('[前置校验失败] 脚本内补丁常量与参考站不一致，拒绝扇出。');
    for (const m of messages) console.error(m);
    return 1;
  }

  const sites = readdirSync(SITES_DIR)
    .filter((n) => /^\d\d-/.test(n))
    .filter((n) => statSync(path.join(SITES_DIR, n)).isDirectory())
    .sort();

  const changed = [];
  const skipped = [];
  const failed = [];

  console.log(`[扇出 embedded-fix]${dryRun ? ' DRY-RUN（不写盘）' : ''} 扫描站点数: ${sites.length}`);
  for (const m of messages) console.log(m);
  console.log('');

  for (const site of sites) {
    const file = path.join(SITES_DIR, site, 'src', 'app', 'globals.css');
    const label = site.padEnd(20);

    if (!existsSync(file)) {
      failed.push(site);
      console.log(`  ${label} FAIL    globals.css 不存在：${rel(file)}`);
      continue;
    }

    const text0 = readFileSync(file, 'utf8');
    const eol = detectEol(text0);
    const hasPatch1 = text0.includes(MARKER_PATCH1);
    const hasPatch2 = text0.includes(MARKER_PATCH2);

    if (hasPatch1 && hasPatch2) {
      skipped.push(site);
      console.log(`  ${label} skip    已处于目标状态（含 ${MARKER_PATCH1} + footer 紧凑规则），零写入`);
      continue;
    }
    if (hasPatch1 !== hasPatch2) {
      failed.push(site);
      console.log(
        `  ${label} FAIL    补丁状态不一致（patch1=${hasPatch1 ? '已落' : '未落'} / patch2=${hasPatch2 ? '已落' : '未落'}），需人工核对`,
      );
      continue;
    }

    const lines = toLines(text0, eol);
    const a1 = findUniqueLine(lines, (l) => l.startsWith(ANCHOR_MONO_PREFIX), '补丁1 锚点 .mono');
    const a2 = findUniqueLine(lines, (l) => l === ANCHOR_EMBED_PADDING, '补丁2 锚点 embedded padding');
    if (!a1.ok || !a2.ok) {
      failed.push(site);
      console.log(`  ${label} FAIL    ${[a1.reason, a2.reason].filter(Boolean).join(' ; ')}`);
      continue;
    }

    // 先插靠后的补丁 2，再插靠前的补丁 1，避免索引漂移。
    // 补丁 2 插在锚点行**之后**：若锚点行下面紧邻一个空行，则用补丁块自带的前导空行替换它，
    // 保证结果与参考站逐字同构（锚点行 / 空行 / 6 行规则 / 空行 / 下一段）。
    let out = lines.slice();
    const after = a2.index + 1;
    if (out[after] === '') {
      out.splice(after, 1, ...PATCH2_BLOCK);
    } else {
      out.splice(after, 0, ...PATCH2_BLOCK.slice(1));
    }
    const a1b = findUniqueLine(out, (l) => l.startsWith(ANCHOR_MONO_PREFIX), '补丁1 锚点 .mono（补丁2 之后）');
    if (!a1b.ok) {
      failed.push(site);
      console.log(`  ${label} FAIL    补丁2 插入后补丁1锚点异常：${a1b.reason}`);
      continue;
    }
    out.splice(a1b.index, 0, ...PATCH1_BLOCK);

    const text = out.join(eol);
    const selfCheck = {
      p1: text.includes(MARKER_PATCH1),
      p2: text.includes(MARKER_PATCH2),
      grew: text.length > text0.length,
    };
    if (!selfCheck.p1 || !selfCheck.p2 || !selfCheck.grew) {
      failed.push(site);
      console.log(
        `  ${label} FAIL    写前自检未通过（patch1=${selfCheck.p1} patch2=${selfCheck.p2} 变长=${selfCheck.grew}）`,
      );
      continue;
    }

    if (dryRun) {
      changed.push(site);
      console.log(`  ${label} would-write  patch1+patch2（${text0.length} → ${text.length} 字节，+${text.length - text0.length}）`);
      continue;
    }

    writeFileSync(file, text, 'utf8');
    const back = readFileSync(file, 'utf8');
    if (back !== text) {
      failed.push(site);
      console.log(`  ${label} FAIL    写盘后回读与预期不一致：${rel(file)}`);
      continue;
    }
    changed.push(site);
    console.log(`  ${label} write   patch1+patch2（${text0.length} → ${text.length} 字节，+${text.length - text0.length}）`);
  }

  console.log('');
  console.log(
    `汇总：改了 ${changed.length} 站 / 跳过 ${skipped.length} 站 / 失败 ${failed.length} 站  （扫描 ${sites.length} 站）`,
  );
  if (changed.length) console.log(`  改了：${changed.join(', ')}`);
  if (skipped.length) console.log(`  跳过：${skipped.join(', ')}`);
  if (failed.length) console.log(`  失败：${failed.join(', ')}`);

  return failed.length ? 1 : 0;
}

process.exitCode = main();
