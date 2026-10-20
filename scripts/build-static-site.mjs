/**
 * 为 Cloudflare Pages 静态导出构建一个微站。
 *
 * 为什么不能直接用 `next build`：
 *   微站的 next.config.ts 里有 `headers()`（用于设置 CSP frame-ancestors），
 *   而 `output: 'export'`（静态导出）**不支持 headers()** —— Next 会直接报错。
 *
 * 做法（注意：Next 15 **没有** NEXT_CONFIG_FILE 环境变量，这是实测踩坑）：
 *   1. 备份原 next.config.ts
 *   2. 用 templates/next.config.static-export.ts 覆盖它
 *   3. `npx next build` → 产物 out/
 *   4. 生成 Cloudflare Pages 的 _headers / _redirects
 *   5. **无论成功失败都恢复**原配置（finally 保证），并逐字节校验
 *
 * 用法：
 *   node scripts/build-static-site.mjs --site=11-curvelab-fit
 *   node scripts/build-static-site.mjs --all
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 共享 _headers 生成器
import { pagesHeaders } from './lib/pages-headers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MICRO = join(ROOT, 'apps', 'micro-sites');
const TEMPLATE = join(ROOT, 'scripts', 'templates', 'next.config.static-export.ts');

const args = process.argv.slice(2);
const all = args.includes('--all');
const siteArg = args.find((a) => a.startsWith('--site='))?.slice(7);

const sites = all
  ? readdirSync(MICRO, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d\d-/.test(d.name))
      .map((d) => d.name)
  : siteArg
    ? [siteArg]
    : [];

if (!sites.length) {
  console.error('用法: node scripts/build-static-site.mjs --all | --site=<dirName>');
  process.exit(1);
}

if (!existsSync(TEMPLATE)) {
  console.error(`✗ 配置模板不存在: ${TEMPLATE}`);
  process.exit(1);
}

const templateSrc = readFileSync(TEMPLATE, 'utf8');

/** _headers 生成器在 scripts/lib/pages-headers.mjs（单一事实源） */

let ok = 0;
let fail = 0;
const restored = [];

for (const site of sites) {
  const dir = join(MICRO, site);
  const cfgPath = join(dir, 'next.config.ts');
  const bakPath = join(dir, 'next.config.ts.deploybak');

  if (!existsSync(dir) || !existsSync(cfgPath)) {
    console.error(`✗ 站点或配置不存在: ${site}`);
    fail += 1;
    continue;
  }

  // 若上次异常退出留下备份，先恢复，避免叠加
  if (existsSync(bakPath)) {
    writeFileSync(cfgPath, readFileSync(bakPath));
    rmSync(bakPath, { force: true });
    console.log(`  （${site}：恢复上次遗留的备份）`);
  }

  const original = readFileSync(cfgPath);
  writeFileSync(bakPath, original);

  try {
    console.log(`\n▶ ${site}`);
    writeFileSync(cfgPath, templateSrc, 'utf8');

    // 确认写入真的生效（避免"以为写了其实没写"的静默失败）
    const written = readFileSync(cfgPath, 'utf8');
    if (!written.includes("output: 'export'")) {
      throw new Error('配置写入未生效：next.config.ts 里没有 output:export');
    }

    // 构建命令：优先用微站自己的 next CLI（pnpm workspace 下每个包有自己的
    // node_modules/next 软链），找不到再退回 npx。
    // 注意 next 的 bin 是 `dist/bin/next`（**无 .js 扩展名**），
    // package.json 的 bin 字段就是这么写的，别自作聪明加后缀。
    // 不用 shell:true —— Windows 下 cmd.exe 会让 cwd 与引号处理不一致，
    // 实测出现「config 已写好但 next build 读到旧配置」。
    const binField = (() => {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'node_modules', 'next', 'package.json'), 'utf8'));
        const b = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.next;
        return b ? join(dir, 'node_modules', 'next', b) : null;
      } catch {
        return null;
      }
    })();
    const useCli = binField !== null && existsSync(binField);
    const cmd = useCli ? process.execPath : 'npx';
    const cmdArgs = useCli ? [binField, 'build'] : ['next', 'build'];

    // Next 15.5.28 的 output:'export' 在本仓库里**不稳定**：
    // 同一份代码连续构建三次，实测第 1 次报 `Invariant: no direct app page
    // entry found for /_not-found`，第 2、3 次成功。
    // 判据是 tsconfig.tsbuildinfo 与 .next 残留的增量状态。
    //
    // 策略：先彻底清理增量产物，再构建；失败则重试（最多 3 次）。
    // 这不是掩盖问题——真失败会连报 3 次，错误照样抛出。
    const MAX_ATTEMPTS = 3;
    let attempt = 0;
    let lastErr = '';

    while (attempt < MAX_ATTEMPTS) {
      attempt += 1;
      // 每轮都清掉增量状态（tsbuildinfo 会让 tsc 跳过类型检查，
      // 也可能让 Next 的页面收集阶段读到过期 manifest）
      rmSync(join(dir, '.next'), { recursive: true, force: true });
      rmSync(join(dir, 'out'), { recursive: true, force: true });
      rmSync(join(dir, 'tsconfig.tsbuildinfo'), { force: true });

      try {
        execFileSync(cmd, cmdArgs, {
          cwd: dir,
          stdio: 'inherit',
          shell: !useCli && process.platform === 'win32',
          env: {
            ...process.env,
            NODE_ENV: 'production',
            NEXT_PUBLIC_MICROSITE_ORIGIN_TEMPLATE: 'https://{appId}.pages.dev',
            // 关掉 Next 自带的类型检查：tsc 有独立步骤，且它会引入
            // tsbuildinfo 增量状态，是上面那个不稳定 bug 的诱因之一。
            NEXT_TELEMETRY_DISABLED: '1',
          },
          timeout: 900000,
        });
        lastErr = '';

        // 即使命令成功，也要确认产物真的齐了（上面记录过"报成功但没产物"）
        if (existsSync(join(dir, 'out', 'index.html'))) break;

        // 产物不齐：尝试从 .next/server/app 补齐
        console.log('  （out/index.html 缺失，尝试 fixup 补齐）');
        try {
          execFileSync(
            process.execPath,
            [join(ROOT, 'scripts', 'fixup-static-export.mjs'), `--site=${site}`],
            { cwd: ROOT, stdio: 'inherit' },
          );
        } catch (e) {
          lastErr = String(e.message).split('\n')[0];
        }
        if (existsSync(join(dir, 'out', 'index.html'))) break;
      } catch (e) {
        lastErr = String(e.message).split('\n')[0];
        const out = `${e.stdout || ''}${e.stderr || ''}`;
        const invariant = out.includes('Invariant: no direct app page entry');
        if (invariant && attempt < MAX_ATTEMPTS) {
          console.log(`  （第 ${attempt} 次遇到 Next export 已知不稳定问题，清理后重试）`);
          continue;
        }
        throw e;
      }
    }

    if (!existsSync(join(dir, 'out', 'index.html'))) {
      throw new Error(`out/index.html 缺失（尝试 ${attempt} 次）${lastErr ? '：' + lastErr : ''}`);
    }
    if (attempt > 1) {
      console.log(`  （第 ${attempt} 次构建成功）`);
    }

    // Cloudflare Pages 专用文件：重建原 headers() 的 CSP，加静态资源缓存
    const outDir = join(dir, 'out');
    writeFileSync(join(outDir, '_headers'), pagesHeaders(site), 'utf8');
    writeFileSync(join(outDir, '_redirects'), '/* /index.html 200\n', 'utf8');

    const count = readdirSync(outDir, { recursive: true }).length;
    console.log(`✓ ${site} → out/（${count} 项，含 _headers）`);
    ok += 1;
  } catch (e) {
    fail += 1;
    console.error(`✗ ${site} 构建失败：${String(e.message).split('\n')[0]}`);
  } finally {
    // 关键：无论成败都恢复原配置，并逐字节校验
    writeFileSync(cfgPath, original);
    const now = readFileSync(cfgPath);
    const same = Buffer.compare(original, now) === 0;
    restored.push({ site, same });
    if (same) rmSync(bakPath, { force: true });
    else console.error(`  ⚠ ${site}：配置恢复校验失败，备份保留在 ${bakPath}`);
  }
}

console.log(`\n成功 ${ok}，失败 ${fail}`);
const badRestore = restored.filter((r) => !r.same);
if (badRestore.length) {
  console.error(`⚠ ${badRestore.length} 个站点的 next.config.ts 恢复异常：${badRestore.map((r) => r.site).join(', ')}`);
  process.exit(1);
}
console.log(`✓ 全部 ${restored.length} 个站点的 next.config.ts 已逐字节恢复`);
process.exit(fail > 0 ? 1 : 0);
