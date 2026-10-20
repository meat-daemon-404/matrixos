#!/usr/bin/env node
/**
 * MatrixOS 一键自检与环境诊断。
 *
 * 用法：node scripts/doctor.mjs
 *
 * 检查：工具链版本、依赖安装状态、密钥、数据库、目录完整性、校验用例。
 * 目的：新成员克隆仓库后先跑这个，一次看清缺什么。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];

const ok = (label, detail = '') => results.push({ level: 'ok', label, detail });
const warn = (label, detail = '') => results.push({ level: 'warn', label, detail });
const bad = (label, detail = '') => results.push({ level: 'bad', label, detail });

function run(cmd, args = [], opts = {}) {
  // Windows 上 pnpm / python 等是 .cmd / .exe 包装，execFileSync 直接调不到，
  // 这里逐个尝试常见后缀。
  const candidates =
    process.platform === 'win32' ? [cmd, `${cmd}.cmd`, `${cmd}.exe`, `${cmd}.bat`] : [cmd];
  for (const c of candidates) {
    try {
      return execFileSync(c, args, {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 20000,
        shell: process.platform === 'win32',
        ...opts,
      }).trim();
    } catch {
      // 试下一个
    }
  }
  return null;
}

// ─────────────────────────── 工具链 ───────────────────────────
const nodeVer = process.versions.node;
const nodeMajor = Number(nodeVer.split('.')[0]);
nodeMajor >= 20 ? ok('Node.js', `v${nodeVer}`) : bad('Node.js', `v${nodeVer}，需要 ≥ 20`);

const pnpmVer = run('pnpm', ['--version']);
pnpmVer ? ok('pnpm', `v${pnpmVer}`) : bad('pnpm', '未安装 —— npm i -g pnpm@9');

const gitVer = run('git', ['--version']);
gitVer ? ok('git', gitVer.replace('git version ', '')) : bad('git', '未安装');

const pyVer = run('python', ['--version']) || run('python3', ['--version']);
pyVer ? ok('Python', pyVer.replace('Python ', '')) : warn('Python', '未安装（后端服务需要 ≥ 3.11）');

const dockerVer = run('docker', ['--version']);
dockerVer ? ok('Docker', dockerVer.replace('Docker version ', '').split(',')[0]) : warn('Docker', '未安装（本地数据库需要）');

// ─────────────────────────── 依赖 ───────────────────────────
existsSync(join(ROOT, 'node_modules'))
  ? ok('根依赖', '已安装')
  : warn('根依赖', '未安装 —— 运行 pnpm install');

existsSync(join(ROOT, 'turbo.json'))
  ? ok('turbo 配置', '存在')
  : bad('turbo 配置', 'turbo.json 缺失');

// ─────────────────────────── 配置 ───────────────────────────
existsSync(join(ROOT, '.env.example')) ? ok('.env.example', '存在') : bad('.env.example', '缺失');
if (existsSync(join(ROOT, '.env.local'))) {
  const env = readFileSync(join(ROOT, '.env.local'), 'utf8');
  const hasKey = /DEEPSEEK_API_KEY=\S+/.test(env);
  hasKey ? ok('.env.local', '已配置（含模型 Key）') : warn('.env.local', '存在但 DEEPSEEK_API_KEY 为空');
} else {
  warn('.env.local', '未创建 —— cp .env.example .env.local');
}

// ─────────────────────────── 密钥 ───────────────────────────
const keysDir = join(ROOT, 'services', 'matrix-core', 'keys');
if (existsSync(keysDir)) {
  const hasPair = existsSync(join(keysDir, 'public.pem')) && existsSync(join(keysDir, 'private.pem'));
  hasPair ? ok('MatrixID 密钥', '已生成') : warn('MatrixID 密钥', '不完整 —— node scripts/gen-keys.mjs');
} else {
  warn('MatrixID 密钥', '未生成 —— node scripts/gen-keys.mjs');
}

// ─────────────────────────── git 钩子 ───────────────────────────
const hooksPath = run('git', ['rev-parse', '--git-path', 'hooks']);
const hookFile = hooksPath ? join(ROOT, hooksPath, 'pre-commit') : null;
hookFile && existsSync(hookFile)
  ? ok('pre-commit 钩子', '已安装')
  : warn('pre-commit 钩子', '未安装 —— node scripts/install-hooks.mjs');

// ─────────────────────────── 目录结构 ───────────────────────────
const expected = [
  ['specs/contracts', '契约'],
  ['specs/microsites.json', '18 微站花名册'],
  ['scripts/verify.mjs', '校验入口'],
  ['docs/01-plan', '规划文档'],
  ['bundle', '设计归档'],
];
for (const [rel, label] of expected) {
  existsSync(join(ROOT, rel)) ? ok(label, rel) : bad(label, `缺失: ${rel}`);
}

// ─────────────────────────── 代码模块（渐进） ───────────────────────────
const modules = [
  ['packages/twin-schema', 'twin-schema'],
  ['packages/matrix-sdk', 'matrix-sdk'],
  ['packages/instrument-ui', 'instrument-ui'],
  ['services/matrix-core', 'matrix-core'],
  ['services/copilot-router', 'copilot-router'],
  ['services/openalex-pat-worker', 'pat-worker'],
  ['apps/orbital-hub', 'orbital-hub'],
  ['apps/wechat-pocket', 'wechat-pocket'],
];
const present = modules.filter(([p]) => existsSync(join(ROOT, p)));
present.length === modules.length
  ? ok('代码模块', `${present.length}/${modules.length} 全部就位`)
  : warn('代码模块', `${present.length}/${modules.length} 就位（其余在开发中）`);

// ─────────────────────────── 校验 ───────────────────────────
const verify = run(process.execPath, [join(ROOT, 'scripts', 'verify.mjs')], { timeout: 60000 });
if (verify !== null) {
  ok('校验套件', '全部通过');
} else {
  bad('校验套件', '未通过 —— 运行 pnpm check 看详情');
}

// ─────────────────────────── 输出 ───────────────────────────
const icon = { ok: '\u2713', warn: '!', bad: '\u2717' };
const color = { ok: '\x1b[32m', warn: '\x1b[33m', bad: '\x1b[31m' };
const reset = '\x1b[0m';

console.log('\nMatrixOS 环境诊断\n' + '─'.repeat(62) + '\n');
for (const r of results) {
  const c = color[r.level];
  console.log(`${c}${icon[r.level]}${reset} ${r.label.padEnd(22)} ${r.detail}`);
}

const counts = results.reduce((a, r) => ((a[r.level] = (a[r.level] || 0) + 1), a), {});
console.log('\n' + '─'.repeat(62));
console.log(
  `${color.ok}${counts.ok || 0} 项正常${reset}  ` +
    `${color.warn}${counts.warn || 0} 项提醒${reset}  ` +
    `${color.bad}${counts.bad || 0} 项问题${reset}`
);

if (counts.bad) {
  console.log('\n有阻塞项需要处理。');
  process.exit(1);
}
console.log('\n环境就绪，可以开工。');
