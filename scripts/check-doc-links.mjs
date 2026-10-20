#!/usr/bin/env node
/**
 * 检查 Markdown 文档里的相对链接是否有断链。
 *
 * 只校验仓库内部的相对路径链接，跳过：
 *  - http(s):// 外链、file: 之外的协议
 *  - 锚点链接 (#xxx)
 *  - mailto: / tel: / data:
 *  - 代码块内的内容
 *
 * **文件范围来自 git，而不是裸 walk。** 这一点重要：工作目录里会散落其它并行
 * 会话与其它工具的产物（`.tmp/` 里的上游仓库副本、`.worktrees/` 里嵌套的完整
 * 仓库副本、`.blank-tmp/`、`pentest/` 等）。改用
 * `git ls-files` + `git ls-files --others --exclude-standard` 后，范围天然等于
 * 「本版本库认识的文件 + 尚未提交但没被 .gitignore 排除的文件」：跟着 `.gitignore`
 * 走，也不会去校验别人 worktree 里的文档。
 *
 * 原实现维护一份手写 SKIP_DIRS，必然与 `.gitignore` 漂移——实测已被这一点坑到：
 * 扫描数从 52 涨到 202，其中 150 个是别人目录，还报出 3 条指向
 * `file:///D:/jet/code/...` 的假断链（那是另一个项目的文档，与 MatrixOS 无关）。
 *
 * 无第三方依赖：node scripts/check-doc-links.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** git 输出用 -z（NUL 分隔），路径里含空格/换行也不会错位。 */
function gitLines(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .split('\0')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * 列 Markdown 文件。任何 git 失败（不在仓库、git 不在 PATH）都**回落到裸 walk**，
 * 并在输出里如实标注来源——宁可多扫，也绝不让门禁静默罢工冒充「全绿」。
 */
function listMarkdownFiles() {
  try {
    const tracked = gitLines(['ls-files', '-z', '--', '*.md']);
    const pending = gitLines(['ls-files', '-z', '--others', '--exclude-standard', '--', '*.md']);
    const rel = [...new Set([...tracked, ...pending])];
    return { files: rel.map((p) => join(ROOT, p)), via: 'git' };
  } catch {
    return { files: walk(ROOT), via: 'fs-walk（git 不可用，已回落到目录遍历）' };
  }
}

// 回落路径专用的跳过名单：git 不可用时也要躲开这些必然不属于本仓的目录。
// .tmp / scratch：gitignore 的一次性目录（脚本与子代理的暂存产物）。它们的内容随时出现又消失，
//   不该参与文档门禁。实测教训：#28 期间生成的 .tmp/pr-body.md 被扫出一条「断链」，
//   而它根本不是仓库文档——扫它只会让正常提交被无关文件拦下。
// .worktrees：claim.mjs branch 创建的并行工作区，属于另一个检出，不是本检出的引用对象。
// .pnpm-store / .venv / __pycache__ / .pytest_cache：包管理与 Python 运行时目录。
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.turbo', 'coverage',
  '.pnpm-store', '.venv', '__pycache__', '.pytest_cache', '.tmp', '.worktrees', 'scratch',
]);

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

const listed = listMarkdownFiles();
const files = listed.files;
const broken = [];
let checked = 0;
let unreadable = 0;

for (const file of files) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    // 在索引里但读不到（例如别人刚 rm 尚未提交）——如实计数，不冒充断链
    unreadable += 1;
    continue;
  }
  const text = stripFences(raw);
  // [label](target)
  const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = linkRe.exec(text)) !== null) {
    const target = m[1].trim();
    if (!target) continue;
    if (/^(https?:|mailto:|tel:|#|data:)/i.test(target)) continue;

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
      broken.push({ file: relative(ROOT, file), target });
    }
  }
}

console.log(
  `扫描 ${files.length} 个 Markdown 文件（范围来源：${listed.via}），检查 ${checked} 个内部链接`,
);
if (broken.length) {
  console.log(`\n✗ 断链 ${broken.length} 个:`);
  for (const b of broken) console.log(`  - ${b.file}  ->  ${b.target}`);
  process.exit(1);
}
if (unreadable) console.log(`（另有 ${unreadable} 个文件在索引里但读不到，已跳过）`);
console.log('✓ 无断链');
