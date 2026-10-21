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

import { execFileSync, spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  readdirSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 共享 _headers 生成器 + 宿主来源唯一事实源
import { pagesHeaders, HUB_ORIGINS_FOR_SDK } from './lib/pages-headers.mjs';

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

// ─────────────────────────── 构建互斥锁 ───────────────────────────
//
// 为什么需要：本脚本对每个站做一套「读原 config → 备份 → 覆盖成 export 模板 →
// next build → finally 恢复」的读改写。这套状态机**没有跨进程互斥**，两个实例
// 并发跑时必然互相踩：
//
//   A 读到干净 config，备份；B 在 A 覆盖后读到 **export 版**，把它备份成 .deploybak；
//   B 结束时用自己的 .deploybak（export 版）恢复 → 污染被**持久化**，
//   且 A 的 finally 恢复会被 B 的覆盖写回。
//
// 实测症状（2026-10-21）：污染在站点间轮转，09 → 10 → 12 → 04 …，每修好一个
// 另一个被抢；`assert-config-restored.mjs` 反复报 `仍是 output:'export' 模板` +
// `.deploybak` 残留 + `out/index.html` 缺失，看起来像"构建不稳定"，实际是互斥缺失。
//
// 这与 `scripts/safe-build.mjs` 解决的是同一类问题（那边是 turbo 并发写坏 .next）。
// 这里复用它同一把锁 `.turbo/build.lock`，于是「safe-build 串行化」与
// 「静态导出串行化」共享同一条队列 —— 两者也会互相抢 .next，必须同锁。
//
// 陈旧锁（持有者进程已死 / 超过 30 分钟）会被自动清理，不会卡死。
const LOCK_DIR = join(ROOT, '.turbo');
const LOCK = join(LOCK_DIR, 'build.lock');
const LOCK_MAX_WAIT_S = Number(
  (process.argv.find((a) => a.startsWith('--wait=')) ?? '--wait=1800').split('=')[1],
);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 存在但无权限信号 = 还活着
  }
}

function readLock() {
  try {
    const [pid, startedAt, host] = readFileSync(LOCK, 'utf8').trim().split('|');
    return { pid: Number(pid), startedAt: Number(startedAt), host };
  } catch {
    return null;
  }
}

function tryAcquire() {
  if (existsSync(LOCK)) {
    const info = readLock();
    if (info && Number.isFinite(info.pid)) {
      const stale = !isAlive(info.pid);
      const ageS = Number.isFinite(info.startedAt) ? (Date.now() - info.startedAt) / 1000 : 0;
      if (stale || ageS > 1800) {
        console.log(`  清理陈旧构建锁（pid=${info.pid}, 已存活 ${Math.round(ageS)}s）`);
        try {
          unlinkSync(LOCK);
        } catch {
          /* ignore */
        }
      }
    }
  }
  try {
    writeFileSync(LOCK, `${process.pid}|${Date.now()}|${process.platform}`, { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  const info = readLock();
  if (info && info.pid === process.pid) {
    try {
      unlinkSync(LOCK);
    } catch {
      /* ignore */
    }
  }
}

mkdirSync(LOCK_DIR, { recursive: true });

{
  const deadline = Date.now() + LOCK_MAX_WAIT_S * 1000;
  let announced = false;
  while (!tryAcquire()) {
    if (Date.now() > deadline) {
      const info = readLock();
      console.error(`\n✗ 等待构建锁超时（${LOCK_MAX_WAIT_S}s）`);
      if (info) console.error(`  当前持有者: pid=${info.pid}（疑似卡死可手动删除 ${LOCK}）`);
      process.exit(1);
    }
    if (!announced) {
      console.log(`⏳ 另一构建进程正在持有锁（pid=${readLock()?.pid ?? '?'}），排队等待...`);
      announced = true;
    }
    // 同步 sleep：本脚本是短命 CLI，不需要事件循环
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    } catch {
      /* 不支持 SharedArrayBuffer 时退化为忙等 */
    }
  }
}

// 无论正常结束、异常、还是被信号打断，都要释放锁
process.on('exit', releaseLock);
process.on('SIGINT', () => {
  releaseLock();
  process.exit(130);
});
process.on('SIGTERM', () => {
  releaseLock();
  process.exit(143);
});
process.on('uncaughtException', (e) => {
  releaseLock();
  console.error(e);
  process.exit(1);
});

/**
 * 把「宿主来源清单」注入构建环境。
 *
 * 为什么必须在这里注入：微站的 `sdk-facade` 构造 SDK 时要显式传 `allowedOrigins`
 * （SDK 默认只信任 `*.matrixos.edu`，而线上真实部署在 `*.pages.dev`，不传就一条
 * 消息都发不出去 —— 表现为 MatrixID 恒 offline、`layout.resize` 永不生效）。
 *
 * 清单本身**不在这里维护**：它来自 `pages-headers.mjs` 的 `HUB_ORIGINS`，
 * 与 `_headers` 的 CSP `frame-ancestors` 同源派生。这样「谁能嵌我」与
 * 「我信谁的跨源消息」是同一个答案，不会一处改了另一处忘了。
 *
 * 变量名要带 `NEXT_PUBLIC_` 前缀：Next 在**构建期**把带该前缀的环境变量静态
 * 内联进客户端产物，静态站没有服务端可查询，这是唯一能让浏览器端读到的方式。
 */
const BUILD_ENV_BASE = {
  NODE_ENV: 'production',
  NEXT_TELEMETRY_DISABLED: '1',
  NEXT_PUBLIC_MATRIXOS_HUB_ORIGINS: HUB_ORIGINS_FOR_SDK,
  /*
   * 后端 API 基址。
   *
   * 为什么必须可注入：`api.matrixos.edu` 当前 **NXDOMAIN**（域名未注册/未配置），
   * 而后端可能实际跑在别的地址（例如 Cloudflare Tunnel 的临时域名）。
   * 若不注入，微站的 `/v1/auth/exchange` 会打到一个不可解析的主机 ——
   * 表现是 `AUTH_SERVICE_UNAVAILABLE: ... Failed to fetch`，而且**看起来像网络问题**，
   * 很难定位到「地址本身就不存在」。
   *
   * 优先级：调用方 env > 默认（保持正式域名不变）。
   * 与 `packages/matrix-sdk/src/http/client.ts` 的 `resolveDefaultApiBase()` 同名。
   */
  ...(process.env.NEXT_PUBLIC_MATRIXOS_API_BASE_URL
    ? { NEXT_PUBLIC_MATRIXOS_API_BASE_URL: process.env.NEXT_PUBLIC_MATRIXOS_API_BASE_URL }
    : {}),
};

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
    // 「构建成功」的判据不能只看 out/index.html：
    // Next 15.5.28 的 output:'export' 偶发报
    // `Invariant: no direct app page entry found for /icon.svg`（与 /_not-found 同族），
    // 此时命令退出码是 0，out/ 里也有 index.html，但缺 icon.svg / index.txt ——
    // 半成品被当成成功，下游验收器会报 /icon.svg 404。实测同一份代码 8 次构建 4 成 4 败。
    // 因此判据改为三个关键产物同时存在，缺一个就继续重试。
    const REQUIRED_ARTIFACTS = ['index.html', 'icon.svg', 'index.txt'];
    const missingArtifacts = () =>
      REQUIRED_ARTIFACTS.filter((name) => !existsSync(join(dir, 'out', name)));
    const exportComplete = () => missingArtifacts().length === 0;

    /**
     * Next 15.5.28 的 `output: 'export'` 在本仓库里**成族地不稳定**：
     * 同一份代码连续构建，报错会在下面这几种之间随机切换，且都是「构建过程中读不到
     * 自己刚写的中间产物」，重跑就好：
     *
     *   Invariant: no direct app page entry found for /xxx   ← app 页面收集
     *   ENOENT ... .nft.json                                 ← build traces
     *   ENOENT ... pages-manifest.json                       ← pages 路由清单
     *   ENOENT ... build-manifest.json                       ← 增量清单
     *   ENOENT ... _ssgManifest.js
     *   ENOENT ... prerender-manifest.json
     *   Could not find a production build in the '.next' directory   ← 收尾阶段
     *
     * 判据必须覆盖整族，只认 `Invariant:` 会漏掉实测最常见的 ENOENT / production build 两类
     * （本轮 14/15/16/17/18 五站连挂就是被这个窄判据拦在重试之外的）。
     * 这不是掩盖问题：真失败会连报 3 次，错误照样抛出。
     */
    const FLAKY_BUILD_MARKERS = [
      'Invariant: no direct app page entry',
      'Could not find a production build',
      '.nft.json',
      'pages-manifest.json',
      'build-manifest.json',
      '_ssgManifest.js',
      'prerender-manifest.json',
    ];
    const isFlakyBuildError = (output) =>
      FLAKY_BUILD_MARKERS.some((needle) => output.includes(needle));

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
        /**
         * 关键：这里必须 `stdio: 'pipe'` 而不是 `'inherit'`。
         *
         * 之前用 inherit，构建日志直接进终端、**但 execFileSync 抛错时 e.stdout/e.stderr 是
         * undefined** —— 于是下面的 `isFlakyBuildError(out)` 永远拿到空串、恒为 false，
         * 不稳定族错误一次都不会被重试，全部当硬失败抛出（实测 09/10/11/16 就是这么连挂的）。
         *
         * 改 pipe 后自己把输出原样转发到终端，既保留可读日志，又能真正拿到文本做判据。
         * 失败时 e.stdout/e.stderr 仍可能为空，所以额外累积本轮的 combinedOutput 兜底。
         */
        const result = spawnSync(cmd, cmdArgs, {
          cwd: dir,
          encoding: 'utf8',
          shell: !useCli && process.platform === 'win32',
          env: {
            ...process.env,
            ...BUILD_ENV_BASE,
            // 历史遗留：微站侧实际不读它（只有 hub 的 hub-config.ts 读），
            // 保留是为了不改变既有构建环境，避免与本轮目标无关的行为漂移。
            // 2026-10-21 账号迁移后生产微站入口是 mx-<appId>.matrixos.cc.cd，
            // 同步改掉，免得将来有人误把 pages.dev 当成生产地址。
            NEXT_PUBLIC_MICROSITE_ORIGIN_TEMPLATE:
              process.env.MATRIXOS_MICROSITE_TEMPLATE ?? 'https://mx-{appId}.matrixos.cc.cd',
            // 关掉 Next 自带的类型检查：tsc 有独立步骤，且它会引入
            // tsbuildinfo 增量状态，是上面那个不稳定 bug 的诱因之一。
          },
          timeout: 900000,
          maxBuffer: 64 * 1024 * 1024,
        });

        const combinedOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        // 把构建日志转发到终端（只打尾部，避免淹没输出）
        const logLines = combinedOutput.split('\n').filter((line) => line.trim() !== '');
        for (const line of logLines.slice(-40)) console.log('    ' + line);

        if (result.status !== 0) {
          lastErr = `next build 退出码 ${result.status}`;
          if (isFlakyBuildError(combinedOutput) && attempt < MAX_ATTEMPTS) {
            console.log(`  （第 ${attempt} 次遇到 Next export 已知不稳定族，清理后重试）`);
            continue;
          }
          throw new Error(
            `next build 失败（退出码 ${result.status}）：${logLines.slice(-3).join(' | ')}`,
          );
        }

        lastErr = '';

        // 即使命令成功，也要确认产物真的齐了（上面记录过"报成功但产物不全"）
        if (exportComplete()) break;

        // 产物不齐：尝试从 .next/server/app 补齐
        const missing = missingArtifacts();
        console.log(`  （out/ 缺 ${missing.join(' / ')}，尝试 fixup 补齐）`);
        try {
          execFileSync(
            process.execPath,
            [join(ROOT, 'scripts', 'fixup-static-export.mjs'), `--site=${site}`],
            { cwd: ROOT, stdio: 'inherit' },
          );
        } catch (e) {
          lastErr = String(e.message).split('\n')[0];
        }
        if (exportComplete()) break;

        // 补齐仍失败 → 当作可重试失败，不要静默放行半成品
        lastErr = `out/ 缺少 ${missingArtifacts().join(' / ')}`;
        if (attempt < MAX_ATTEMPTS) {
          console.log(`  （第 ${attempt} 次产物不完整，清理后重试）`);
          continue;
        }
      } catch (e) {
        lastErr = String(e.message).split('\n')[0];
        const out = `${e.stdout || ''}${e.stderr || ''}`;
        if (isFlakyBuildError(out) && attempt < MAX_ATTEMPTS) {
          console.log(`  （第 ${attempt} 次遇到 Next export 已知不稳定族，清理后重试）`);
          continue;
        }
        throw e;
      }
    }

    const stillMissing = missingArtifacts();
    if (stillMissing.length > 0) {
      throw new Error(
        `out/ 产物不完整（尝试 ${attempt} 次），缺少 ${stillMissing.join(' / ')}${
          lastErr ? '：' + lastErr : ''
        }`,
      );
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
