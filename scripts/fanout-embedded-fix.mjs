#!/usr/bin/env node
/**
 * scripts/fanout-embedded-fix.mjs
 *
 * 幂等扇出：把微站的嵌入模式（ADR-08）修复扇出到 18 站。
 *
 *   补丁 1（P1）  sr-only 等价数据表压制 + 嵌入模式取消视口高度
 *                锚点：`.mono { font-family: var(--font-mono)` 之前
 *   补丁 2（P2）  嵌入模式紧凑布局（min-height / margin / footer 留白三行）
 *                锚点：`body[data-embedded='true'] .site-root { padding: 10px; gap: 10px; }` 之后
 *   补丁 3（P3）  ADR-08：iframe 内彻底不可滚（压掉 html 与 body 两层滚动容器）
 *                锚点：`body[data-embedded='true'] { min-height: 0; }` 之后
 *
 * 设计约束：
 *   - 只遍历 apps/micro-sites/<site>/src/app/globals.css；不碰 layout.tsx / services / docs。
 *   - 幂等：每个补丁有自己的标记；已落标记的补丁跳过，重复执行零写入、字节级不变。
 *   - 按锚点**整行**定位插入，绝不按行号（各站行数不同）；每插一次都重新定位锚点，天然免疫索引漂移。
 *   - 锚点找不到 / 锚点不唯一 / 状态异常 => 记 FAIL 并跳过该站，绝不静默写错位置。
 *   - P1 必须先于 P3：P3 的锚点行正是 P1 引入的（已落则跳过，顺序仍成立）。
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
const GEN_SITE = path.join(REPO_ROOT, 'scripts', 'gen-site.mjs');

/* ── 锚点（整行匹配；取自各站 globals.css 的实际文本） ─────────────────────── */
const ANCHOR_MONO_PREFIX = '.mono { font-family: var(--font-mono)';
const ANCHOR_EMBED_PADDING = "body[data-embedded='true'] .site-root { padding: 10px; gap: 10px; }";
const ANCHOR_EMBED_MINHEIGHT = "body[data-embedded='true'] { min-height: 0; }";

/* ── 幂等标记（各自只可能来自对应补丁） ───────────────────────────────────── */
const MARKER_P1 = 'max-height: 1px';

/* ── 补丁原文（逐字；首/末空串=与相邻段落之间的空行分隔） ─────────────────── */
const P1_BLOCK = [
  '/* 仅嵌入模式取消视口高度（ADR-08：iframe 内不滚，高度跟着 hub 走） */',
  ANCHOR_EMBED_MINHEIGHT,
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

/** P2 以「前导空行」开头，正好对位参考站里锚点行与规则之间的那个空行。 */
const P2_BLOCK = [
  '',
  '/* 嵌入模式紧凑布局：不留视口高度、不留 auto 外边距、不收尾留白。',
  ' * 三条都是「按 iframe 高度自适应」的必要项 —— 只要留一条，内容就会被撑出',
  ' * iframe 可视区，从而出现内层滚动条（ADR-08 明令禁止的双滚动条）。 */',
  "body[data-embedded='true'] .site-root { min-height: 0; }",
  "body[data-embedded='true'] .site-root { margin: 0 auto; }",
  "body[data-embedded='true'] .site-footer { margin-top: 8px; padding: 8px 0; }",
  '',
];

/** P3 同样以「前导空行」开头，插在 min-height 行之后、`.iu-sr-only` 注释之前。 */
const P3_BLOCK = [
  '',
  '/* ADR-08：iframe 内不滚 —— 必须同时压掉 html 与 body 两层滚动容器。',
  ' * 只写 body{overflow:hidden} 不够：实测 <html> 的 overflow:visible 才是真正的',
  ' * 滚动容器，maxScroll 仍为 142px（虽然滚轮动不了，但可滚空间仍在，',
  ' * 触控/键盘/scrollIntoView 仍能滚）。加上 html 的 overflow 与 height 才彻底归零。 */',
  "html:has(body[data-embedded='true']) { overflow: hidden; height: 100%; }",
  "body[data-embedded='true'] { overflow: hidden; height: 100%; }",
  '',
];

const MARKER_P3_HTML = "html:has(body[data-embedded='true']) { overflow: hidden; height: 100%; }";
const MARKER_P3_BODY = "body[data-embedded='true'] { overflow: hidden; height: 100%; }";
const MARKER_P2_FOOTER = "body[data-embedded='true'] .site-footer { margin-top: 8px; padding: 8px 0; }";

/**
 * 补丁表。**顺序即应用顺序**：P1 必须先于 P3（P3 的锚点行由 P1 引入）。
 * present(text) 判定该补丁是否已落；block 为插入原文；marker 用于写后自检。
 */
const PATCHES = [
  {
    id: 'P1',
    name: 'sr-only 压制 + 取消视口高度',
    block: P1_BLOCK,
    mode: 'before',
    anchor: (l) => l.startsWith(ANCHOR_MONO_PREFIX),
    anchorLabel: 'P1 锚点 .mono',
    present: (t) => t.includes(MARKER_P1),
    markers: [MARKER_P1],
  },
  {
    id: 'P3',
    name: 'ADR-08 iframe 内不可滚',
    block: P3_BLOCK,
    mode: 'after',
    anchor: (l) => l === ANCHOR_EMBED_MINHEIGHT,
    anchorLabel: 'P3 锚点 embedded min-height',
    present: (t) => t.includes(MARKER_P3_HTML) && t.includes(MARKER_P3_BODY),
    markers: [MARKER_P3_HTML, MARKER_P3_BODY],
  },
  {
    id: 'P2',
    name: '嵌入模式紧凑布局',
    block: P2_BLOCK,
    mode: 'after',
    anchor: (l) => l === ANCHOR_EMBED_PADDING,
    anchorLabel: 'P2 锚点 embedded padding',
    present: (t) => t.includes(MARKER_P2_FOOTER),
    markers: [MARKER_P2_FOOTER],
  },
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

/** 在 lines 上就地插入一个补丁块（'before' 锚点行之前 / 'after' 锚点行之后）。 */
function insertPatch(lines, patch) {
  const a = findUniqueLine(lines, patch.anchor, patch.anchorLabel);
  if (!a.ok) return { ok: false, reason: a.reason };
  if (patch.mode === 'before') {
    lines.splice(a.index, 0, ...patch.block);
    return { ok: true };
  }
  const after = a.index + 1;
  // 块自带前导空行：锚点行下紧邻空行时用它替换，保证段落间距与参考站同构。
  if (lines[after] === '') lines.splice(after, 1, ...patch.block);
  else lines.splice(after, 0, ...patch.block.slice(1));
  return { ok: true };
}

/**
 * 嵌入模式区域的两种合法形态（逐字）。
 * P3 插在 P1 的 min-height 行之后，因此会把 P1 块**从中间劈开**：
 *   无 P3：[c1, min-height, '', srOnly 注释 ... '}', '']
 *   有 P3：[c1, min-height, '', P3 正文, srOnly 注释 ... '}', '']
 * 前置校验按这两种形态整段比对，而不是假设 P1 永远连续。
 */
const P1_HEAD = P1_BLOCK.slice(0, 2);
const P1_TAIL = P1_BLOCK.slice(3);
const REGION_NO_P3 = [...P1_BLOCK];
const REGION_WITH_P3 = [...P1_HEAD, '', ...P3_BLOCK.slice(1), ...P1_TAIL];

/** 抽出「嵌入模式区域」：从 P1 首行到 `.mono` 行之前。 */
function embeddedRegion(lines) {
  const start = findUniqueLine(lines, (l) => l === P1_BLOCK[0], 'P1 首行（嵌入模式区域起点）');
  if (!start.ok) return { ok: false, reason: start.reason };
  const end = findUniqueLine(lines, (l) => l.startsWith(ANCHOR_MONO_PREFIX), '区域终点 .mono 锚点');
  if (!end.ok) return { ok: false, reason: end.reason };
  if (end.index <= start.index) return { ok: false, reason: '区域终点在起点之前' };
  return { ok: true, region: lines.slice(start.index, end.index) };
}

/** 比较两个行数组是否逐字相同。 */
function sameLines(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * 前置自检：脚本内补丁常量必须与**权威副本**逐字一致，否则拒绝扇出。
 * 权威副本 = scripts/gen-site.mjs 的 renderGlobalsCss 模板（漂移的上游）。
 * 参考站 11-curvelab-fit 另做一次形态校验（允许「无 P3」或「有 P3」两种合法形态）。
 */
function verifyConstants(messages) {
  let ok = true;

  // (a) 生成器模板：嵌入区域必须等于「有 P3」形态；P2 段落逐字比对。
  if (!existsSync(GEN_SITE)) {
    messages.push('  ! scripts/gen-site.mjs 不存在，跳过生成器模板自检');
  } else {
    const gen = readFileSync(GEN_SITE, 'utf8');
    const genLines = toLines(gen, detectEol(gen));

    const r = embeddedRegion(genLines);
    if (!r.ok) {
      messages.push(`  ✗ 生成器模板嵌入区域定位失败：${r.reason}`);
      ok = false;
    } else if (!sameLines(r.region, REGION_WITH_P3)) {
      messages.push('  ✗ 生成器模板的嵌入区域与脚本内 P1+P3 常量不一致（两侧需同步）');
      ok = false;
    }

    const a2 = findUniqueLine(genLines, (l) => l === ANCHOR_EMBED_PADDING, '生成器模板 P2 锚点');
    if (!a2.ok) {
      messages.push(`  ✗ 生成器模板 P2 锚点异常：${a2.reason}`);
      ok = false;
    } else if (!sameLines(genLines.slice(a2.index + 1, a2.index + 1 + P2_BLOCK.length), P2_BLOCK)) {
      messages.push('  ✗ 生成器模板的 P2 段落与脚本内 P2 常量不一致（两侧需同步）');
      ok = false;
    }

    if (ok) messages.push('  ✓ 生成器模板自检：gen-site.mjs 的嵌入区域(P1+P3) 与 P2 段落均与脚本常量逐字相同');
  }

  // (b) 参考站：必须是两种合法形态之一（扇出前=无 P3，扇出后=有 P3）。
  const refPath = path.join(SITES_DIR, REFERENCE_SITE, 'src', 'app', 'globals.css');
  if (!existsSync(refPath)) {
    messages.push(`  ! 参考站文件不存在（${rel(refPath)}），跳过参考站自检`);
  } else {
    const ref = readFileSync(refPath, 'utf8');
    const refLines = toLines(ref, detectEol(ref));
    const r = embeddedRegion(refLines);
    if (!r.ok) {
      messages.push(`  ✗ 参考站嵌入区域定位失败：${r.reason}`);
      ok = false;
    } else if (sameLines(r.region, REGION_WITH_P3)) {
      messages.push(`  ✓ 参考站自检：${REFERENCE_SITE} 嵌入区域已含 P3，与脚本常量逐字相同`);
    } else if (sameLines(r.region, REGION_NO_P3)) {
      messages.push(`  ✓ 参考站自检：${REFERENCE_SITE} 嵌入区域尚未含 P3（扇出前状态），P1 与脚本常量逐字相同`);
    } else {
      messages.push(`  ✗ 参考站嵌入区域既不等于「含 P3」也不等于「不含 P3」形态（常量已漂移）`);
      ok = false;
    }
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
  const constantsOk = verifyConstants(messages);

  const sites = readdirSync(SITES_DIR)
    .filter((n) => /^\d\d-/.test(n))
    .filter((n) => statSync(path.join(SITES_DIR, n)).isDirectory())
    .sort();

  const changed = [];
  const skipped = [];
  const failed = [];

  console.log(`[扇出 embedded-fix]${dryRun ? ' DRY-RUN（不写盘）' : ''} 扫描站点数: ${sites.length}`);
  for (const m of messages) console.log(m);
  if (!constantsOk) {
    console.log('');
    console.error('[前置校验失败] 脚本内补丁常量与权威副本（参考站 / 生成器模板）不一致，拒绝扇出。');
    return 1;
  }
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
    const missing = PATCHES.filter((p) => !p.present(text0));

    if (missing.length === 0) {
      skipped.push(site);
      console.log(`  ${label} skip    已处于目标状态（P1+P2+P3 全落），零写入`);
      continue;
    }

    // 状态异常守卫：P3 已落却 P1 未落，说明曾被人为手改；此时再插 P1 会引入
    // 第二条 min-height 行，令 P3 锚点失去唯一性 —— 宁可 FAIL 交人核对。
    if (PATCHES[1].present(text0) && !PATCHES[0].present(text0)) {
      failed.push(site);
      console.log(`  ${label} FAIL    状态异常：P3 已落但 P1 未落（会重复引入 min-height 行），需人工核对`);
      continue;
    }

    const lines = toLines(text0, eol);
    const applied = [];
    for (const patch of missing) {
      const r = insertPatch(lines, patch);
      if (!r.ok) {
        failed.push(site);
        console.log(`  ${label} FAIL    ${patch.id} ${r.reason}`);
        break;
      }
      applied.push(patch.id);
    }
    if (failed.includes(site)) continue;

    const text = lines.join(eol);
    const selfCheck = {
      allMarkers: PATCHES.every((p) => p.markers.every((m) => text.includes(m))),
      grew: text.length > text0.length,
    };
    if (!selfCheck.allMarkers || !selfCheck.grew) {
      failed.push(site);
      console.log(`  ${label} FAIL    写前自检未通过（全部标记=${selfCheck.allMarkers} 变长=${selfCheck.grew}）`);
      continue;
    }

    const delta = text.length - text0.length;
    if (dryRun) {
      changed.push(site);
      console.log(`  ${label} would-write  ${applied.join('+')}（${text0.length} → ${text.length} 字节，+${delta}）`);
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
    console.log(`  ${label} write   ${applied.join('+')}（${text0.length} → ${text.length} 字节，+${delta}）`);
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
