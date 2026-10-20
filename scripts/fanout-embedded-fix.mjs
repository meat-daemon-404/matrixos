#!/usr/bin/env node
/**
 * scripts/fanout-embedded-fix.mjs
 *
 * 幂等扇出：把微站「iframe 内降级模式」（ADR-08）的全部修复扇出到 18 站。
 *
 *   P1  嵌入模式取消视口高度 + sr-only 等价数据表压制
 *       锚点：`.mono { font-family: var(--font-mono)` 之前
 *   P3  ADR-08：iframe 内彻底不可滚（html + body 双层 overflow/height）
 *       锚点：`body[data-embedded='true'] { min-height: 0; }` 之后（该行由 P1 引入）
 *   P2  嵌入模式紧凑布局（min-height / margin / footer 留白三行）
 *       锚点：`.site-root { padding: …; gap: 10px; }` 之后
 *   P4  ADR-08 紧凑布局：隐藏嵌入态无意义的介绍性区块（.meta-grid / .site-footer）
 *       锚点：P2 的 footer 留白行之后；同时把 .site-root 的底部 padding 归零（与既有行合并，不留两条冲突规则）
 *
 * 设计约束：
 *   - 只写 apps/micro-sites/<site>/src/app/globals.css；不碰 layout.tsx / services / docs。
 *   - 幂等：每补丁有自己的标记；已落则跳过，重复执行零写入、字节级不变。
 *   - 按锚点**整行**定位，绝不按行号；每插一次都重新定位，天然免疫索引漂移。
 *   - 锚点找不到 / 锚点不唯一 / 半落状态 => FAIL 并跳过该站，绝不静默写错位置。
 *   - 前置自检：脚本内补丁常量必须与 scripts/gen-site.mjs 模板逐字一致，否则拒绝扇出。
 *   - --dry-run 只报告不写盘；有 FAIL 时退出码 1。
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

/* ── 锚点 ──────────────────────────────────────────────────────────────────── */
const ANCHOR_MONO_PREFIX = '.mono { font-family: var(--font-mono)';
const ANCHOR_EMBED_MINHEIGHT = "body[data-embedded='true'] { min-height: 0; }";
const ANCHOR_P2_FOOTER = "body[data-embedded='true'] .site-footer { margin-top: 8px; padding: 8px 0; }";

/* `.site-root { padding: …; gap: 10px; }` 在 P4 前后有两种合法形态：
 *   P4 前：padding: 10px;
 *   P4 后：padding: 10px 10px 0;
 * P2 的锚点必须两种都认，否则重跑会「找不到锚点」。 */
const RE_PADDING_LINE = /^body\[data-embedded='true'\] \.site-root \{ padding: 10px( 10px 0)?; gap: 10px; \}$/;

const OLD_PADDING_LINE = "body[data-embedded='true'] .site-root { padding: 10px; gap: 10px; }";
const NEW_PADDING_LINE = "body[data-embedded='true'] .site-root { padding: 10px 10px 0; gap: 10px; }";

/* ── 幂等标记 ──────────────────────────────────────────────────────────────── */
const MARKER_P1 = 'max-height: 1px';
const MARKER_P3_HTML = "html:has(body[data-embedded='true']) { overflow: hidden; height: 100%; }";
const MARKER_P3_BODY = "body[data-embedded='true'] { overflow: hidden; height: 100%; }";
const MARKER_P2 = ANCHOR_P2_FOOTER;
const MARKER_P4_META = "body[data-embedded='true'] .meta-grid { display: none; }";
const MARKER_P4_FOOTER = "body[data-embedded='true'] .site-footer { display: none; }";

/* ── 补丁原文（逐字；首/末空串 = 与相邻段落的空行分隔） ───────────────────── */
const P1_HEAD = [
  '/* 仅嵌入模式取消视口高度（ADR-08：iframe 内不滚，高度跟着 hub 走） */',
  ANCHOR_EMBED_MINHEIGHT,
  '',
];
const P1_TAIL = [
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
/** P1 在 P3 落地后会被「劈开」：头部 + P3 + 尾部。故 block 由两段组成。 */
const P1_BLOCK = [...P1_HEAD, ...P1_TAIL];

const P3_BLOCK = [
  '',
  '/* ADR-08：iframe 内不滚 —— 必须同时压掉 html 与 body 两层滚动容器。',
  ' * 只写 body{overflow:hidden} 不够：实测 <html> 的 overflow:visible 才是真正的',
  ' * 滚动容器，maxScroll 仍为 142px（虽然滚轮动不了，但可滚空间仍在，',
  ' * 触控/键盘/scrollIntoView 仍能滚）。加上 html 的 overflow 与 height 才彻底归零。 */',
  MARKER_P3_HTML,
  MARKER_P3_BODY,
  '',
];

const P2_BLOCK = [
  '',
  '/* 嵌入模式紧凑布局：不留视口高度、不留 auto 外边距、不收尾留白。',
  ' * 三条都是「按 iframe 高度自适应」的必要项 —— 只要留一条，内容就会被撑出',
  ' * iframe 可视区，从而出现内层滚动条（ADR-08 明令禁止的双滚动条）。 */',
  "body[data-embedded='true'] .site-root { min-height: 0; }",
  "body[data-embedded='true'] .site-root { margin: 0 auto; }",
  ANCHOR_P2_FOOTER,
  '',
];

const P4_BLOCK = [
  '',
  '/* ADR-08 原文要求「iframe 内降级模式（隐藏自身导航，适配紧凑布局）」。',
  ' * 嵌入时对用户无意义的介绍性内容一并收起：',
  ' *   .meta-grid  = 「UI 形态 / 独立台账 / 原型来源」三张身份卡（60px）',
  ' *   .site-footer = 域名 + 生成器署名（34px）',
  ' * 这两块纯说明性质，嵌入态占 94px 却把仪器挤出可视区。',
  ' * 注意：不隐藏 .instrument-slot（那是核心）与 .status-row（那是运行态指示）。 */',
  MARKER_P4_META,
  MARKER_P4_FOOTER,
  '',
];

/**
 * 补丁表。**数组顺序即应用顺序**：
 *   P1 必须先于 P3（P3 的锚点行由 P1 引入）
 *   P2 必须先于 P4（P4 的锚点行由 P2 引入）
 */
const PATCHES = [
  {
    id: 'P1',
    name: 'sr-only 压制 + 取消视口高度',
    block: P1_BLOCK,
    /** P3 会把 P1 从中间劈开，故一致性自检要按两段（有序）比对。 */
    runs: [P1_HEAD, P1_TAIL],
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
    runs: [P3_BLOCK],
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
    runs: [P2_BLOCK],
    mode: 'after',
    anchor: (l) => RE_PADDING_LINE.test(l),
    anchorLabel: 'P2 锚点 embedded padding/gap',
    present: (t) => t.includes(MARKER_P2),
    markers: [MARKER_P2],
  },
  {
    id: 'P4',
    name: 'ADR-08 紧凑布局（隐藏 .meta-grid / .site-footer）',
    block: P4_BLOCK,
    runs: [P4_BLOCK],
    mode: 'after',
    anchor: (l) => l === ANCHOR_P2_FOOTER,
    anchorLabel: 'P4 锚点 P2 footer 留白行',
    /**
     * P4 是二段式：① 把 padding 行就地改写（合并，不留两条冲突规则）；② 追加隐藏规则。
     * present 必须两段都满足，否则视为「半落」→ FAIL。
     */
    present: (t) =>
      t.includes(MARKER_P4_META) && t.includes(MARKER_P4_FOOTER) && t.includes(NEW_PADDING_LINE),
    markers: [MARKER_P4_META, MARKER_P4_FOOTER, NEW_PADDING_LINE],
    /** 就地替换（要求唯一命中）。已替换过则跳过。 */
    replaceLine: { from: OLD_PADDING_LINE, to: NEW_PADDING_LINE },
  },
];

function rel(p) {
  const r = path.relative(process.cwd(), p);
  return r === '' ? '.' : r;
}

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function toLines(text, eol) {
  return text.split(eol);
}

/** 整行定位：要求唯一命中。 */
function findUniqueLine(lines, match, label) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (match(lines[i])) hits.push(i);
  if (hits.length === 0) return { ok: false, reason: `锚点未找到：${label}` };
  if (hits.length > 1) return { ok: false, reason: `锚点不唯一（整行命中 ${hits.length} 次）：${label}` };
  return { ok: true, index: hits[0] };
}

/** 判断 lines 中是否按顺序包含若干连续行段（每段内部必须连续）。 */
function hasRunsInOrder(lines, runs) {
  let cursor = 0;
  for (const run of runs) {
    let found = -1;
    for (let i = cursor; i + run.length <= lines.length; i++) {
      let hit = true;
      for (let k = 0; k < run.length; k++) if (lines[i + k] !== run[k]) { hit = false; break; }
      if (hit) { found = i; break; }
    }
    if (found === -1) return false;
    cursor = found + run.length;
  }
  return true;
}

/** 在 lines 上就地插入补丁块。 */
function insertPatch(lines, patch) {
  const a = findUniqueLine(lines, patch.anchor, patch.anchorLabel);
  if (!a.ok) return { ok: false, reason: a.reason };

  if (patch.mode === 'before') {
    lines.splice(a.index, 0, ...patch.block);
    return { ok: true };
  }
  const after = a.index + 1;
  // 块自带前导空行：锚点行下紧邻空行时用它替换，保持段落间距稳定。
  if (lines[after] === '') lines.splice(after, 1, ...patch.block);
  else lines.splice(after, 0, ...patch.block.slice(1));
  return { ok: true };
}

/** 就地替换一行（要求唯一命中）。 */
function replaceUniqueLine(lines, from, to, label) {
  const a = findUniqueLine(lines, (l) => l === from, label);
  if (!a.ok) return { ok: false, reason: a.reason };
  lines[a.index] = to;
  return { ok: true };
}

/**
 * 前置自检：脚本内四处补丁常量必须与 scripts/gen-site.mjs 模板逐字一致。
 * 生成器是漂移的**上游**，它一旦不同步，下次 `gen:site --force` 就会冲掉全部修复。
 */
function verifyAgainstGenerator(messages) {
  if (!existsSync(GEN_SITE)) {
    messages.push('  ! scripts/gen-site.mjs 不存在，跳过生成器模板自检');
    return true;
  }
  const gen = readFileSync(GEN_SITE, 'utf8');
  const genLines = toLines(gen, detectEol(gen));

  let ok = true;
  for (const patch of PATCHES) {
    if (!hasRunsInOrder(genLines, patch.runs)) {
      messages.push(`  ✗ 脚本内 ${patch.id} 与 scripts/gen-site.mjs 模板不一致（两侧需同步）`);
      ok = false;
    }
  }
  // P4 的就地改写结果也必须出现在模板里
  if (!genLines.includes(NEW_PADDING_LINE)) {
    messages.push('  ✗ 生成器模板缺少 P4 的 padding 归零行（.site-root { padding: 10px 10px 0; gap: 10px; }）');
    ok = false;
  }
  if (ok) messages.push('  ✓ 生成器模板自检：gen-site.mjs 的 P1/P2/P3/P4 与脚本常量逐字相同');
  return ok;
}

/** 参考站形态自检：只作提示，不阻断（权威是生成器模板 + verify-fanout 逐字节比对）。 */
function describeReference(messages) {
  const refPath = path.join(SITES_DIR, REFERENCE_SITE, 'src', 'app', 'globals.css');
  if (!existsSync(refPath)) {
    messages.push(`  · 参考站文件不存在（${rel(refPath)}），跳过参考站形态提示`);
    return;
  }
  const ref = readFileSync(refPath, 'utf8');
  const have = PATCHES.filter((p) => p.present(ref)).map((p) => p.id);
  const miss = PATCHES.filter((p) => !p.present(ref)).map((p) => p.id);
  messages.push(`  · 参考站 ${REFERENCE_SITE} 已含 [${have.join(',') || '无'}]，缺 [${miss.join(',') || '无'}]`);
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
  const constantsOk = verifyAgainstGenerator(messages);
  describeReference(messages);

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
    console.error('[前置校验失败] 脚本内补丁常量与 scripts/gen-site.mjs 模板不一致，拒绝扇出。');
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
      console.log(`  ${label} skip    已处于目标状态（P1+P2+P3+P4 全落），零写入`);
      continue;
    }

    // 半落状态守卫：依赖关系不成立说明被人为手改过，宁可 FAIL 交人核对。
    const anomalies = [];
    if (PATCHES[1].present(text0) && !PATCHES[0].present(text0)) anomalies.push('P3 已落但 P1 未落');
    if (PATCHES[3].present(text0) && !PATCHES[2].present(text0)) anomalies.push('P4 已落但 P2 未落');
    if (anomalies.length) {
      failed.push(site);
      console.log(`  ${label} FAIL    状态异常：${anomalies.join('；')}，需人工核对`);
      continue;
    }

    const lines = toLines(text0, eol);
    const applied = [];
    let failure = null;
    for (const patch of missing) {
      // P4 的二段式：先就地改写 padding 行（已改过则跳过），再追加隐藏规则。
      if (patch.replaceLine) {
        const already = lines.includes(patch.replaceLine.to);
        if (!already) {
          const r = replaceUniqueLine(lines, patch.replaceLine.from, patch.replaceLine.to, `${patch.id} 就地改写 padding 行`);
          if (!r.ok) { failure = `${patch.id} ${r.reason}`; break; }
        }
      }
      const r = insertPatch(lines, patch);
      if (!r.ok) { failure = `${patch.id} ${r.reason}`; break; }
      applied.push(patch.id);
    }
    if (failure) {
      failed.push(site);
      console.log(`  ${label} FAIL    ${failure}`);
      continue;
    }

    const text = lines.join(eol);
    const allMarkers = PATCHES.every((p) => p.markers.every((m) => text.includes(m)));
    if (!allMarkers || text.length <= text0.length) {
      failed.push(site);
      console.log(`  ${label} FAIL    写前自检未通过（全部标记=${allMarkers}）`);
      continue;
    }

    const delta = text.length - text0.length;
    if (dryRun) {
      changed.push(site);
      console.log(`  ${label} would-write  ${applied.join('+')}（${text0.length} → ${text.length} 字节，+${delta}）`);
      continue;
    }

    writeFileSync(file, text, 'utf8');
    if (readFileSync(file, 'utf8') !== text) {
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
