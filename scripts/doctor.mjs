#!/usr/bin/env node
/**
 * MatrixOS 一键自检与环境诊断。
 *
 * 用法：
 *   node scripts/doctor.mjs            # 完整诊断
 *   node scripts/doctor.mjs --brief    # 省略模块明细表
 *   node scripts/doctor.mjs --json     # 机器可读输出
 *
 * 检查：工具链版本、依赖、密钥、目录完整性、**逐模块就绪度**、校验用例。
 * 目的：新成员克隆仓库后先跑这个，一次看清缺什么。
 *
 * 就绪度判定（不只看目录存不存在——那是上一版的错误）：
 *   目录存在 → 有源码 → 有测试文件 → 能跑测试 → 有构建脚本
 * 每一项按权重折算成百分比，并给出"还缺什么"的具体建议。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = new Set(process.argv.slice(2));
const BRIEF = ARGS.has('--brief');
const JSON_OUT = ARGS.has('--json');

const results = [];

const ok = (label, detail = '') => results.push({ level: 'ok', label, detail });
const warn = (label, detail = '') => results.push({ level: 'warn', label, detail });
const bad = (label, detail = '') => results.push({ level: 'bad', label, detail });

function run(cmd, args = [], opts = {}) {
  // Windows 上 pnpm / python 等是 .cmd / .exe 包装，execFileSync 直接调不到，
  // 这里逐个尝试常见后缀。
  //
  // 注意：调用 node 自身时**不要**加 shell:true。Windows 下 execFileSync 传
  // shell 选项会触发 DEP0190（参数不转义），且当子进程有 stderr 输出时
  // 会被误判为失败 —— 这正是上一版 doctor 把 verify.mjs 报成"未通过"的原因。
  const isNode = cmd === process.execPath;
  const useShell = process.platform === 'win32' && !isNode;
  const candidates = useShell ? [cmd, `${cmd}.cmd`, `${cmd}.exe`, `${cmd}.bat`] : [cmd];
  for (const c of candidates) {
    try {
      return execFileSync(c, args, {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: opts.timeout ?? 20000,
        shell: useShell,
        ...opts,
      }).trim();
    } catch {
      // 试下一个
    }
  }
  return null;
}

/** 执行命令并返回 { code, out }，用于区分"命令失败"与"命令有 stderr 输出"。 */
function runStatus(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout ?? 120000,
      shell: false,
      ...opts,
    });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
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

existsSync(join(ROOT, 'turbo.json')) ? ok('turbo 配置', '存在') : bad('turbo 配置', 'turbo.json 缺失');

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

// ─────────────────────────── 模块盘点 ───────────────────────────
/**
 * 每个模块的盘点配置。
 *  - name  显示名
 *  - path  相对仓库根的路径
 *  - kind  'ts' | 'py' —— 决定用什么方式跑测试
 *  - key   需要额外检查的阻塞性文件（缺失则视为骨架不完整）
 */
const MODULES = [
  { name: 'twin-schema', path: 'packages/twin-schema', kind: 'ts' },
  { name: 'matrix-sdk', path: 'packages/matrix-sdk', kind: 'ts' },
  { name: 'instrument-ui', path: 'packages/instrument-ui', kind: 'ts' },
  { name: 'matrix-core', path: 'services/matrix-core', kind: 'py', pyTests: true },
  { name: 'copilot-router', path: 'services/copilot-router', kind: 'py', pyTests: true },
  { name: 'openalex-pat-worker', path: 'services/openalex-pat-worker', kind: 'py', pyTests: true },
  { name: 'orbital-hub', path: 'apps/orbital-hub', kind: 'ts' },
  { name: 'wechat-pocket', path: 'apps/wechat-pocket', kind: 'ts' },
  { name: 'micro-sites', path: 'apps/micro-sites', kind: 'ts', aggregated: true },
];

const SKIP_DIRS = new Set([
  'node_modules', '.next', 'dist', 'build', '.turbo', '.venv', 'venv',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'coverage',
  '.git', '.qr-selftest', '.pnpm-store',
]);

const TEST_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^test_.*\.py$)|(_test\.py$)/;
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.css', '.json']);

/** 递归遍历，跳过构建产物与缓存目录。 */
function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, acc);
    } else if (e.isFile()) {
      if (e.name.endsWith('.tsbuildinfo') || e.name.endsWith('.pyc')) continue;
      if (e.name === '.coverage') continue;
      acc.push(full);
    }
  }
  return acc;
}

/** 判断模块是否为"聚合型"（如 micro-sites 下 18 个同构子站）。 */
function subPackages(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && existsSync(join(dir, e.name, 'package.json')))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

function inspect(mod) {
  const abs = join(ROOT, mod.path);
  const info = {
    name: mod.name,
    path: mod.path,
    exists: existsSync(abs),
    srcFiles: 0,
    codeFiles: 0,
    testFiles: 0,
    subPackages: 0,
    hasBuildScript: false,
    hasTestScript: false,
    notes: [],
    score: 0,
  };
  if (!info.exists) return info;

  // 聚合型模块（micro-sites）：统计全部子站
  const roots = mod.aggregated ? subPackages(abs) : [abs];
  if (mod.aggregated) info.subPackages = roots.length;

  for (const root of roots) {
    for (const f of walk(root)) {
      if (TEST_RE.test(basename(f))) {
        info.testFiles += 1;
        continue;
      }
      info.srcFiles += 1;
      if (CODE_EXT.has(extname(f))) info.codeFiles += 1;
    }
  }

  // package.json 里的 scripts
  const pkgPath = join(abs, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      info.hasBuildScript = Boolean(pkg.scripts && pkg.scripts.build);
      info.hasTestScript = Boolean(pkg.scripts && pkg.scripts.test);
    } catch {
      info.notes.push('package.json 解析失败');
    }
  } else if (mod.kind === 'py') {
    // Python 服务用 pyproject.toml 判断
    const pyproj = join(abs, 'pyproject.toml');
    info.notes.push(existsSync(pyproj) ? 'pyproject.toml 存在' : '缺 pyproject.toml');
  }

  // 就绪度打分（满分 100）
  if (info.srcFiles > 0) info.score += 30;            // 有源码
  if (info.codeFiles >= 5) info.score += 10;          // 有一定体量
  if (info.testFiles > 0) info.score += 30;           // 有测试文件
  if (info.hasBuildScript) info.score += 20;          // 能构建
  if (info.hasTestScript) info.score += 10;           // 测试可一键跑
  return info;
}

const inspected = MODULES.map(inspect);

function grade(score) {
  if (score >= 90) return { icon: '✓', level: 'ok', text: '已实现' };
  if (score >= 60) return { icon: '~', level: 'warn', text: '部分实现' };
  if (score >= 30) return { icon: '~', level: 'warn', text: '仅骨架' };
  return { icon: '✗', level: 'bad', text: '未开始' };
}

if (!JSON_OUT) {
  const present = inspected.filter((m) => m.exists).length;
  present === MODULES.length
    ? ok('模块目录', `${present}/${MODULES.length} 就位`)
    : warn('模块目录', `${present}/${MODULES.length} 就位（其余在开发中）`);
}

// ─────────────────────────── 测试执行 ───────────────────────────
/**
 * 实际跑一遍测试，拿到真实数量。
 * 注意：`pnpm test` 只覆盖声明了 test 脚本的包，Python 服务完全不在其中
 * —— 所以这里逐个模块直跑，不依赖 turbo。
 */
function countTests(info) {
  if (!info.exists || info.testFiles === 0) return null;
  const abs = join(ROOT, info.path);
  const mod = MODULES.find((m) => m.name === info.name);

  if (mod.kind === 'py') {
    if (!existsSync(join(abs, 'tests'))) return { count: 0, detail: 'tests/ 目录不存在' };
    const r = runStatus('python', ['-m', 'pytest', 'tests', '-q', '--no-header', '-p', 'no:cacheprovider'], {
      cwd: abs,
      timeout: 180000,
    });
    const m = /(\d+) passed/.exec(r.out);
    const failed = /(\d+) failed/.exec(r.out);
    if (r.code !== 0 && !m) return { count: 0, detail: 'pytest 未通过或未安装' };
    return {
      count: m ? Number(m[1]) : 0,
      detail: failed ? `${failed[1]} failed` : '',
    };
  }

  // TS：优先 vitest，其次 node --test
  const vitestCfg = ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts'].find((f) =>
    existsSync(join(abs, f)),
  );
  if (vitestCfg) {
    const r = runStatus('npx', ['vitest', 'run', '--reporter=dot'], { cwd: abs, timeout: 180000, shell: true });
    const m = /Tests\s+(\d+) passed/.exec(r.out);
    if (m) return { count: Number(m[1]), detail: '' };
    return { count: 0, detail: 'vitest 未通过' };
  }

  const r = runStatus(process.execPath, ['--test', 'test/**/*.test.ts'], { cwd: abs, timeout: 120000 });
  const m = /^# pass (\d+)$/m.exec(r.out) || /ℹ pass (\d+)/.exec(r.out);
  if (m) return { count: Number(m[1]), detail: '' };
  return { count: 0, detail: 'node --test 未通过' };
}

const testCounts = new Map();
if (!BRIEF) {
  for (const info of inspected) {
    if (info.testFiles === 0) continue;
    const r = countTests(info);
    if (r) testCounts.set(info.name, r);
  }
}

const totalTests = [...testCounts.values()].reduce((a, r) => a + r.count, 0);
if (testCounts.size > 0) {
  const covered = [...testCounts.entries()].filter(([, r]) => r.count > 0).length;
  const detail = [...testCounts.entries()]
    .filter(([, r]) => r.count > 0)
    .map(([n, r]) => `${n} ${r.count}`)
    .join(' · ');
  covered >= 4
    ? ok('测试总数', `${totalTests} passed（${covered}/${MODULES.length} 模块有测试）｜${detail}`)
    : warn('测试总数', `${totalTests} passed（仅 ${covered}/${MODULES.length} 模块有测试）｜${detail}`);
  const broken = [...testCounts.entries()].filter(([, r]) => r.count === 0 && r.detail);
  for (const [n, r] of broken) warn(`测试异常 · ${n}`, r.detail);
}

// 没有测试的模块单独提醒（这是最容易被"能构建"掩盖的短板）
const noTests = inspected.filter((m) => m.exists && m.testFiles === 0).map((m) => m.name);
if (noTests.length) {
  warn('无测试模块', `${noTests.length} 个：${noTests.join(', ')}`);
}

// ─────────────────────────── 校验 ───────────────────────────
// 直接跑 node，不加 shell —— 避免 DEP0190 与 stderr 误判。
const verify = runStatus(process.execPath, [join(ROOT, 'scripts', 'verify.mjs')], { timeout: 120000 });
if (verify.code === 0) {
  ok('校验套件', '全部通过');
} else {
  bad('校验套件', '未通过 —— 运行 pnpm check 看详情');
}

// ─────────────────────────── 输出 ───────────────────────────
if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        results,
        modules: inspected.map((m) => {
          const t = testCounts.get(m.name);
          return {
            name: m.name,
            path: m.path,
            exists: m.exists,
            srcFiles: m.srcFiles,
            codeFiles: m.codeFiles,
            testFiles: m.testFiles,
            subPackages: m.subPackages,
            testsPassed: t ? t.count : 0,
            testsNote: t ? t.detail : '无测试',
            buildable: m.hasBuildScript,
            score: m.score,
            grade: grade(m.score).text,
          };
        }),
        summary: {
          modules: inspected.length,
          withTests: inspected.filter((m) => m.testFiles > 0).length,
          totalTests,
        },
      },
      null,
      2,
    ),
  );
  process.exit(results.some((r) => r.level === 'bad') ? 1 : 0);
}

const icon = { ok: '\u2713', warn: '!', bad: '\u2717' };
const color = { ok: '\x1b[32m', warn: '\x1b[33m', bad: '\x1b[31m' };
const dim = '\x1b[2m';
const reset = '\x1b[0m';

console.log('\nMatrixOS 环境诊断\n' + '─'.repeat(78) + '\n');
for (const r of results) {
  const c = color[r.level];
  console.log(`${c}${icon[r.level]}${reset} ${r.label.padEnd(24)} ${r.detail}`);
}

// ────────── 模块就绪度表 ──────────
console.log('\n' + '─'.repeat(78));
console.log('模块就绪度（源码 / 测试 / 构建）');
console.log('─'.repeat(78));
console.log(
  dim +
    '模块'.padEnd(22) +
    '状态'.padEnd(10) +
    '源文件'.padStart(7) +
    '测试'.padStart(7) +
    '通过'.padStart(8) +
    ' 构建' +
    reset,
);

for (const m of inspected) {
  const g = grade(m.score);
  const t = testCounts.get(m.name);
  const testStr = m.testFiles === 0 ? '—' : String(t ? t.count : '?');
  const buildStr = m.hasBuildScript ? '✓' : m.exists ? '✗' : '—';
  const nameStr = m.subPackages ? `${m.name}(${m.subPackages})` : m.name;
  const filesStr = m.exists ? String(m.srcFiles) : '—';
  console.log(
    `${color[g.level]}${g.icon}${reset} ` +
      nameStr.padEnd(20) +
      g.text.padEnd(10) +
      filesStr.padStart(7) +
      String(m.testFiles || (m.exists ? 0 : '—')).padStart(7) +
      testStr.padStart(8) +
      '  ' +
      buildStr,
  );
}

const notStarted = inspected.filter((m) => !m.exists).map((m) => m.name);
const skeleton = inspected.filter((m) => m.exists && m.score < 60).map((m) => m.name);
if (skeleton.length) {
  console.log(`\n${dim}骨架/部分实现：${skeleton.join(', ')}${reset}`);
}
if (notStarted.length) {
  console.log(`${color.bad}未开始：${notStarted.join(', ')}${reset}`);
}
console.log(
  `\n${dim}就绪度 = 有源码(30) + 有体量(10) + 有测试文件(30) + 能构建(20) + 测试可一键跑(10)${reset}`,
);

const counts = results.reduce((a, r) => ((a[r.level] = (a[r.level] || 0) + 1), a), {});
console.log('\n' + '─'.repeat(78));
console.log(
  `${color.ok}${counts.ok || 0} 项正常${reset}  ` +
    `${color.warn}${counts.warn || 0} 项提醒${reset}  ` +
    `${color.bad}${counts.bad || 0} 项问题${reset}`,
);

if (counts.bad) {
  console.log('\n有阻塞项需要处理。');
  process.exit(1);
}
console.log('\n环境就绪，可以开工。');
