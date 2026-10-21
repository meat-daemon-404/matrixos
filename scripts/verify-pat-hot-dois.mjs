/**
 * 核验 04 站（pat-hot）前沿条目的 DOI 是否真实存在。
 *
 * 为什么需要这个脚本：04 站把这些 DOI 作为 `evidence_anchors.source_doi_or_url`
 * 经虫洞投送给 05 站（文献声呐）。「证据锚点」一旦指向不存在的论文，整条
 * 跨站链路就是假的 —— 下游站会把它当真引文引用。所以 DOI 必须是可核验的。
 *
 * 做法：从 `@matrixos/microsite-data` 的构建产物里读 PAT_HOT_ITEMS，
 * 逐条查 Crossref `/works/{doi}`，比对返回的标题是否与本站标题相关。
 * 不做「标题完全相等」的硬判据 —— 中文标题是译写，只需确认 DOI 存在且
 * Crossref 记录不是无关条目（比较首作者/期刊/年份可人工复核）。
 *
 * 用法：
 *   node scripts/verify-pat-hot-dois.mjs            # 核验全部
 *   node scripts/verify-pat-hot-dois.mjs --offline  # 只做形状检查，不联网
 *
 * 退出码：有 DOI 不存在 → 1。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DIST = join(ROOT, 'apps/micro-sites/shared/dist/index.js');
const OFFLINE = process.argv.includes('--offline');

if (!existsSync(DIST)) {
  console.error(`✗ 找不到 ${DIST}\n  先构建共享包：npx tsc -p apps/micro-sites/shared/tsconfig.build.json`);
  process.exit(1);
}

const mod = await import(`file://${DIST.replace(/\\/g, '/')}`);

/**
 * 从所有含 DOI 的数据集里收集待核验项。
 *
 * 为什么不止 PAT_HOT_ITEMS：2026-10-21 实测发现**同一个假 DOI 撒在 5 个数据集**里
 * （PAPER_ROWS 的 anchor、RETRACT_BLIPS 的 b4、CV_ENTRIES 的 anchor、
 * EMAIL_DRAFTS 的正文、REVIEW_CLUSTERS 的 representativeDoi）。
 * 只核验 04 站那一处，等于把其余四处留在原地。
 *
 * 这里按「数据形状」而非「数据来源」收集：凡是值形如 DOI 的字符串都收，
 * 这样以后新增数据集不需要改本脚本。
 */
const DOI_LIKE = /^10\.\d{4,9}\/\S+$/;
/**
 * 从任意文本里抽出 DOI。为什么要这一步：
 * 撤稿声呐（15 站）把 DOI 写在 label 里（形如 `DOI:10.1155/2022/4989248`），
 * 它是 UI 文案而不是独立字段，纯值匹配会漏掉 —— 而撤稿类 DOI 恰恰最需要是真的：
 * 标错一个 DOI，等于对一篇论文做了莫须有的学术不端指控。
 */
const DOI_IN_TEXT = /10\.\d{4,9}\/[^\s，。、）)"']+/g;

function collectDois(node, path, out, seen) {
  if (typeof node === 'string') {
    const trimmed = node.trim();
    const found = DOI_LIKE.test(trimmed)
      ? [trimmed]
      : [...trimmed.matchAll(DOI_IN_TEXT)].map((m) => m[0].replace(/[.。]+$/, ''));
    for (const doi of found) {
      if (seen.has(doi)) continue;
      seen.add(doi);
      out.push({ doi, where: path });
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectDois(v, `${path}[${i}]`, out, seen));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      collectDois(v, path === '' ? k : `${path}.${k}`, out, seen);
    }
  }
}

const targets = [];
const seenDoi = new Set();
collectDois(mod, '', targets, seenDoi);

if (targets.length === 0) {
  console.error('✗ 共享数据里没有找到任何 DOI');
  process.exit(1);
}

console.log(`共享数据 DOI 全量核验：共 ${targets.length} 个唯一 DOI\n`);

let bad = 0;
let ok = 0;

for (const item of targets) {
  const where = item.where;
  if (OFFLINE) {
    console.log(`· ${item.doi}  (${where})（形状通过，未联网）`);
    ok += 1;
    continue;
  }
  try {
    const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(item.doi)}`, {
      headers: { 'user-agent': 'MatrixOS-doi-check/1.0 (mailto:noreply@matrixos.cc.cd)' },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 404) {
      console.error(`✗ ${item.doi}  → Crossref 404 不存在`);
      console.error(`     出现位置：${where}`);
      bad += 1;
      continue;
    }
    if (!res.ok) {
      console.warn(`⚠ ${item.doi}  → HTTP ${res.status}（无法判定）  位置：${where}`);
      continue;
    }
    const body = await res.json();
    const msg = body?.message ?? {};
    const title = (msg.title ?? [''])[0];
    const journal = (msg['container-title'] ?? [''])[0];
    console.log(`✓ ${item.doi}`);
    console.log(`    ${(title || '(无标题)').slice(0, 92)}`);
    console.log(`    ${journal || '(无期刊)'} · 位置 ${where}`);
    ok += 1;
  } catch (error) {
    console.warn(
      `⚠ ${item.doi}：请求失败 ${error instanceof Error ? error.message : String(error)}（无法判定）`,
    );
  }
}

if (bad > 0) {
  console.error(`\n✗ ${bad} 个 DOI 不存在。共享数据里的 DOI 会作为证据锚点投送给下游微站，`);
  console.error('  编造的 DOI 等于编造证据。请换成真实可核验的论文。');
  process.exit(1);
}
console.log(`\n✓ ${ok}/${targets.length} 个 DOI 可核验（或无法判定但未证伪）`);
