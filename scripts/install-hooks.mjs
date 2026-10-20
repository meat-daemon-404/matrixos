#!/usr/bin/env node
/**
 * 安装本地 git 钩子，替代原先的 GitHub Actions 工作流。
 *
 * 背景：.github/workflows/validate.yml 因账户计费无法启动（6 次运行全部 0 秒失败），
 * 已移除。改用 pre-commit 钩子在本机做同样的事 —— 而且是即时的，不用等 CI。
 *
 * 安装的钩子：
 *   pre-commit → 跑 node scripts/verify.mjs，不过则拒绝提交
 *
 * 用法：
 *   node scripts/install-hooks.mjs
 *   git commit --no-verify   # 需要时跳过
 */
import { writeFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 确认在 git 仓库里
try {
  execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, stdio: 'ignore' });
} catch {
  console.error('✗ 当前目录不是 git 仓库，无法安装钩子');
  process.exit(1);
}

// 用 git 自己解析 hooks 路径，兼容 core.hooksPath 等配置
let hooksDir;
try {
  hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
} catch {
  hooksDir = join(ROOT, '.git', 'hooks');
}
if (!join(hooksDir).startsWith('/') && !/^[A-Za-z]:/.test(hooksDir)) {
  hooksDir = join(ROOT, hooksDir);
}

if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

const hookPath = join(hooksDir, 'pre-commit');

const HOOK = `#!/bin/sh
# MatrixOS pre-commit 钩子 —— 由 scripts/install-hooks.mjs 生成
#
# 替代已移除的 GitHub Actions 工作流（因账户计费无法启动）。
# 检查内容与原来的 CI 完全一致：
#   1. 契约 Schema 与 18 微站花名册
#   2. Markdown 内部链接断链
#   3. 中文编码完整性（U+FFFD + BOM）
#
# 需要跳过时：git commit --no-verify

echo ""
echo "运行提交前校验..."

if ! command -v node >/dev/null 2>&1; then
  echo "⚠ 未找到 node，跳过校验"
  exit 0
fi

node "$(git rev-parse --show-toplevel)/scripts/verify.mjs" --staged
STATUS=$?

if [ $STATUS -ne 0 ]; then
  echo ""
  echo "✗ 校验未通过，提交已中止"
  echo "  修复后重试，或用 git commit --no-verify 强制提交"
  exit 1
fi

exit 0
`;

writeFileSync(hookPath, HOOK, { encoding: 'utf8' });
try {
  chmodSync(hookPath, 0o755);
} catch {
  // Windows 上 chmod 可能无效，git 自己会处理可执行位
}

console.log('✓ 已安装 pre-commit 钩子');
console.log(`  路径: ${hookPath}`);
console.log('');
console.log('现在每次 git commit 都会自动跑校验。');
console.log('需要跳过时：git commit --no-verify');
