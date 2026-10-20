#!/usr/bin/env node
/**
 * 校验 specs/ 下的 JSON Schema 与微站花名册的一致性。
 *
 * 检查项：
 *  1. 所有 *.schema.json 是合法 JSON，且带 $schema / title / type
 *  2. microsites.json 恰好 18 条，id 连续 01..18
 *  3. 域名唯一，且都以 .matrixos.edu 结尾
 *  4. 每条必须有 orbit / orbitName / name / domain / source / uiStyle / ledger / desc
 *  5. 轨道值必须落在 1-2 / 3-4 / 5 / 6-7 之内
 *  6. matrix-app-manifest / wormhole / dispatch 三个契约里的 orbit_station 枚举一致
 *
 * 无第三方依赖，CI 与本地都能直接跑：node scripts/validate-specs.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPECS = join(ROOT, 'specs');
const CONTRACTS = join(SPECS, 'contracts');

const errors = [];
const warnings = [];
const ok = (msg) => console.log(`  \u2713 ${msg}`);
const fail = (msg) => { errors.push(msg); console.log(`  \u2717 ${msg}`); };
const warn = (msg) => { warnings.push(msg); console.log(`  ! ${msg}`); };

// ---------------------------------------------------------------- schemas
console.log('\n[1/5] JSON Schema 基本校验');
if (!existsSync(CONTRACTS)) {
  fail('specs/contracts/ 目录不存在');
} else {
  const files = readdirSync(CONTRACTS).filter((f) => f.endsWith('.schema.json'));
  if (files.length === 0) fail('specs/contracts/ 下没有 *.schema.json');
  for (const f of files) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(CONTRACTS, f), 'utf8'));
    } catch (e) {
      fail(`${f}: JSON 解析失败 — ${e.message}`);
      continue;
    }
    const missing = ['$schema', 'title', 'type'].filter((k) => !(k in doc));
    if (missing.length) fail(`${f}: 缺少字段 ${missing.join(', ')}`);
    else ok(`${f} 结构合法`);
  }
}

// ------------------------------------------------------------ microsites
console.log('\n[2/5] 微站花名册校验');
const microPath = join(SPECS, 'microsites.json');
let micros = [];
if (!existsSync(microPath)) {
  fail('specs/microsites.json 不存在');
} else {
  try {
    micros = JSON.parse(readFileSync(microPath, 'utf8'));
  } catch (e) {
    fail(`microsites.json 解析失败 — ${e.message}`);
  }
  if (Array.isArray(micros)) {
    if (micros.length !== 18) fail(`微站数量应为 18，实际 ${micros.length}`);
    else ok('微站数量 = 18');

    const REQUIRED = ['id', 'orbit', 'orbitName', 'name', 'domain', 'source', 'uiStyle', 'ledger', 'desc'];
    const VALID_ORBITS = new Set(['1-2', '3-4', '5', '6-7']);
    const seenIds = new Set();
    const seenDomains = new Set();

    micros.forEach((m, i) => {
      const label = m && m.id ? `#${m.id}` : `[index ${i}]`;
      if (!m || typeof m !== 'object') { fail(`${label} 不是对象`); return; }

      const missing = REQUIRED.filter((k) => !m[k]);
      if (missing.length) fail(`${label} 缺少字段: ${missing.join(', ')}`);

      if (m.id && !/^\d{2}$/.test(m.id)) fail(`${label} id 应为两位数字字符串`);
      if (m.id) {
        if (seenIds.has(m.id)) fail(`${label} id 重复`);
        seenIds.add(m.id);
      }
      if (m.domain) {
        if (seenDomains.has(m.domain)) fail(`${label} 域名重复: ${m.domain}`);
        seenDomains.add(m.domain);
        if (!m.domain.endsWith('.matrixos.edu')) fail(`${label} 域名应以 .matrixos.edu 结尾: ${m.domain}`);
      }
      if (m.orbit && !VALID_ORBITS.has(m.orbit)) fail(`${label} orbit 值非法: ${m.orbit}`);
    });

    // id 连续性
    const expected = Array.from({ length: 18 }, (_, i) => String(i + 1).padStart(2, '0'));
    const missingIds = expected.filter((id) => !seenIds.has(id));
    if (missingIds.length) fail(`缺失 id: ${missingIds.join(', ')}`);
    else ok('id 连续 01..18 无缺口');

    if (seenDomains.size === 18) ok('18 个域名唯一且合规');
  }
}

// -------------------------------------------------- orbit_station 枚举一致
console.log('\n[3/5] orbit_station 枚举一致性');
const STATIONS = ['study', 'spark', 'pat_hot', 'xingmen', 'workshop', 'cloud_balance', 'pre_job'];
for (const f of ['matrix-app-manifest.schema.json', 'dispatch-contract.schema.json']) {
  const p = join(CONTRACTS, f);
  if (!existsSync(p)) continue;
  let doc;
  try { doc = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
  const node =
    doc?.properties?.orbit_station ??
    doc?.properties?.station_id ??
    null;
  if (!node) { warn(`${f}: 未找到 orbit_station / station_id 定义`); continue; }
  const en = node.enum ?? [];
  const same = en.length === STATIONS.length && STATIONS.every((s) => en.includes(s));
  if (same) ok(`${f}: orbit_station 枚举与 7 站一致`);
  else fail(`${f}: 枚举不一致 — 期望 ${STATIONS.join('|')}，实际 ${en.join('|')}`);
}

// ------------------------------------------------------- wormhole 必填字段
console.log('\n[4/5] 虫洞契约必填字段');
const whPath = join(CONTRACTS, 'wormhole-envelope.schema.json');
if (existsSync(whPath)) {
  const wh = JSON.parse(readFileSync(whPath, 'utf8'));
  const need = ['trace_id', 'matrix_uid', 'source_app', 'target_app', 'payload_type', 'payload'];
  const req = wh.required ?? [];
  const missing = need.filter((k) => !req.includes(k));
  if (missing.length) fail(`wormhole 必填字段缺失: ${missing.join(', ')}`);
  else ok('wormhole 顶层必填字段完整');

  const anchors = wh?.properties?.payload?.properties?.evidence_anchors;
  if (!anchors) fail('wormhole 缺少 evidence_anchors 定义（合规红线）');
  else if (!Array.isArray(anchors.items?.required) ||
           !anchors.items.required.includes('verification_level') ||
           !anchors.items.required.includes('source_doi_or_url')) {
    fail('evidence_anchors 必须强制 source_doi_or_url + verification_level');
  } else ok('evidence_anchors 强制证据字段（合规红线守住）');

  const levels = anchors?.items?.properties?.verification_level?.enum ?? [];
  const needLevels = ['Level_A_Verified', 'Level_B_Preprint', 'Retracted_Warning'];
  if (needLevels.every((l) => levels.includes(l))) ok('verification_level 三档完整');
  else fail(`verification_level 枚举缺档: ${needLevels.filter((l) => !levels.includes(l)).join(', ')}`);
}

// --------------------------------------------------------------- bundle 存在
console.log('\n[5/6] 交付物归档完整性');
const bundleChecks = [
  ['bundle/MatrixOS_v3_完整交互规范与UI图谱_高清版.html', 'HTML 交互规范图谱'],
  ['bundle/matrix_os_agent_execution_spec.md', 'Agent 执行规范'],
];
for (const [rel, label] of bundleChecks) {
  if (existsSync(join(ROOT, rel))) ok(`${label} 已归档`);
  else fail(`${label} 缺失: ${rel}`);
}
const rendersDir = join(ROOT, 'bundle', 'UI_Renders');
if (existsSync(rendersDir)) {
  const jpgs = readdirSync(rendersDir).filter((f) => /\.(jpg|jpeg|png)$/i.test(f));
  if (jpgs.length === 4) ok('4 张 UI 渲染图已归档');
  else fail(`UI 渲染图应为 4 张，实际 ${jpgs.length}`);
} else fail('bundle/UI_Renders/ 不存在');

// --------------------------------------------------------------- bundle 存在
console.log('\n[6/6] 中文编码完整性（U+FFFD + BOM 扫描）');
/**
 * 双重编码检查：
 *  1. U+FFFD —— PowerShell 5.1 在 GBK 代码页下处理 UTF-8 中文会静默损坏内容，
 *     表现为 U+FFFD 替换字符。损坏是静默的：文件能打开、链接能解析，
 *     只有逐字节检查才能发现。
 *  2. BOM —— Windows PowerShell 的 `Set-Content -Encoding UTF8` 会写入 BOM，
 *     导致 JSON.parse 报 "Unexpected token '\ufeff'"。
 *
 * 参见 .github/CONTRIBUTING.md 与 Issue「中文文档禁用 PowerShell 文本管道」。
 */
{
  const SCAN_DIRS = ['docs', 'specs', 'bundle', 'scripts', '.github'];
  const SCAN_EXT = /\.(md|json|mjs|js|txt|yml|yaml)$/i;
  let scanned = 0;
  let badCount = 0;

  const walkScan = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'UI_Renders'].includes(entry.name)) continue;
        walkScan(p);
      } else if (SCAN_EXT.test(entry.name)) {
        scanned++;
        const buf = readFileSync(p);
        if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
          badCount++;
          fail(`${relative(ROOT, p)} 含 UTF-8 BOM（会导致 JSON.parse 失败）`);
        }
        const n = (buf.toString('utf8').match(/\uFFFD/g) || []).length;
        if (n > 0) {
          badCount++;
          fail(`${relative(ROOT, p)} 含 ${n} 处 U+FFFD（中文已损坏）`);
        }
      }
    }
  };

  for (const d of SCAN_DIRS) walkScan(join(ROOT, d));

  if (badCount === 0) ok(`扫描 ${scanned} 个文件，无 U+FFFD、无 BOM`);
}

// ------------------------------------------------------------------ 汇总
console.log('\n' + '─'.repeat(56));
if (warnings.length) {
  console.log(`警告 ${warnings.length} 条:`);
  warnings.forEach((w) => console.log(`  ! ${w}`));
}
if (errors.length) {
  console.log(`\n\u2717 校验失败，共 ${errors.length} 个错误:`);
  errors.forEach((e) => console.log(`  - ${e}`));
  process.exit(1);
}
console.log('\u2713 全部规范校验通过');