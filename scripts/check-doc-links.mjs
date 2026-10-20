#!/usr/bin/env node
/**
 * 检查 Markdown 文档里的相对链接是否有断链。
 *
 * 只校验仓库内部的相对路径链接，跳过：
 *  - http(s):// 外链
 *  - 锚点链接 (#xxx)
 *  - mailto:
 *  - 代码块内的内容
 *
 * 无第三方依赖：node scripts/check-doc-links.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.turbo', 'coverage']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
    } else if (/\.md$/i.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** 去掉围栏代码块，避免把代码里的路径当链接 */
function stripFences(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

const files = walk(ROOT);
const broken = [];
let checked = 0;

for (const file of files) {
  const text = stripFences(readFileSync(file, 'utf8'));
  // [label](target)
  const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = linkRe.exec(text)) !== null) {
    const target = m[1].trim();
    if (!target) continue;
    if (/^(https?:|mailto:|tel:|#)/i.test(target)) continue;
    if (target.startsWith('data:')) continue;

    // GitHub 页面相对链接（如 ../../issues、../../projects）在 GitHub 网页上有效，
    // 但不对应本地文件，跳过。
    if (/^(\.\.\/)+[a-z-]+$/i.test(target)) continue;

    const clean = target.split('#')[0].split('?')[0];
    if (!clean) continue;

    checked++;
    const abs = clean.startsWith('/')
      ? join(ROOT, clean.slice(1))
      : resolve(dirname(file), clean);

    if (!existsSync(abs)) {
      broken.push({
        file: relative(ROOT, file),
        target,
      });
    }
  }
}

console.log(`扫描 ${files.length} 个 Markdown 文件，检查 ${checked} 个内部链接`);
if (broken.length) {
  console.log(`\n\u2717 断链 ${broken.length} 个:`);
  for (const b of broken) console.log(`  - ${b.file}  ->  ${b.target}`);
  process.exit(1);
}
console.log('\u2713 无断链');
