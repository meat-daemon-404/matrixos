#!/usr/bin/env node
/**
 * 串行化 turbo 构建，避免并发写坏 .next 目录。
 *
 * 背景（2026-10-20 实测）：
 * 多个 turbo / pnpm build 进程同时跑时，同一个包的 `.next` 目录会被
 * 并发地删建，导致 `_not-found/page.js.nft.json` 之类的 ENOENT。
 * 表现为「build 22 个包只过 3 个」的假红，但单独串行跑同一包完全成功。
 *
 * 这不是代码 bug，是构建互斥问题。这个脚本用文件锁把并发请求排成队。
 *
 * 用法：
 *   node scripts/safe-build.mjs                 # 构建全部
 *   node scripts/safe-build.mjs --filter=@matrixos/sdk
 *   node scripts/safe-build.mjs --wait=900      # 最长等 900 秒拿锁
 *
 * 锁文件：.turbo/build.lock（已在 .gitignore）
 * 陈旧锁（持有者进程已死）会被自动清理。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_DIR = join(ROOT, '.turbo');
const LOCK = join(LOCK_DIR, 'build.lock');

const args = process.argv.slice(2);
const waitArg = args.find((a) => a.startsWith('--wait='));
const MAX_WAIT_S = waitArg ? Number(waitArg.split('=')[1]) : 600;
const turboArgs = args.filter((a) => !a.startsWith('--wait='));

// 并发上限：19 个 Next.js 应用同时读写各自 .next/ 会在 Windows 上互相删除
// 对方的中间产物（ENOENT 假红灯）。仓库文档把 --concurrency=2 定为约定，
// 但**只写在文档里就等于没写**——`pnpm build` 走的是这个脚本，
// 以前它照样把默认并发传下去，于是"按文档做了还是一片红"。
// 现在在这里兜底：调用方没显式指定就补 2，显式指定（含 --concurrency=1）则尊重。
if (!turboArgs.some((a) => a === '--concurrency' || a.startsWith('--concurrency='))) {
  turboArgs.push('--concurrency=2');
}

mkdirSync(LOCK_DIR, { recursive: true });

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
    const raw = readFileSync(LOCK, 'utf8').trim();
    const [pid, startedAt, host] = raw.split('|');
    return { pid: Number(pid), startedAt: Number(startedAt), host };
  } catch {
    return null;
  }
}

function acquire() {
  if (existsSync(LOCK)) {
    const info = readLock();
    if (info && Number.isFinite(info.pid)) {
      const stale = !isAlive(info.pid);
      const ageS = Number.isFinite(info.startedAt) ? (Date.now() - info.startedAt) / 1000 : 0;
      // 进程已死，或锁超过 30 分钟（构建不可能这么久）都视为陈旧
      if (stale || ageS > 1800) {
        console.log(`  清理陈旧锁（pid=${info.pid}, 已存活 ${Math.round(ageS)}s）`);
        try { unlinkSync(LOCK); } catch { /* ignore */ }
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

function release() {
  const info = readLock();
  if (info && info.pid === process.pid) {
    try { unlinkSync(LOCK); } catch { /* ignore */ }
  }
}

// ─────────────────────────── 拿锁 ───────────────────────────
const deadline = Date.now() + MAX_WAIT_S * 1000;
let waited = 0;
let announced = false;

while (!acquire()) {
  if (Date.now() > deadline) {
    const info = readLock();
    console.error(`\n✗ 等待构建锁超时（${MAX_WAIT_S}s）`);
    if (info) {
      console.error(`  当前持有者: pid=${info.pid}`);
      console.error('  若确认该进程已卡死，可手动删除: .turbo/build.lock');
    }
    process.exit(1);
  }
  if (!announced) {
    const info = readLock();
    console.log(`⏳ 另一个构建正在进行（pid=${info?.pid ?? '?'}），排队等待...`);
    announced = true;
  }
  const start = Date.now();
  // 同步 sleep，保持脚本简单（这是个短命 CLI，不需要事件循环）
  while (Date.now() - start < 1000) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    } catch {
      // 极少数环境不支持 SharedArrayBuffer，退化为忙等
    }
  }
  waited += 1;
}

if (waited > 0) console.log(`✓ 拿到构建锁（等了约 ${waited}s）\n`);

// 确保退出时释放
const cleanup = () => release();
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });
process.on('uncaughtException', (e) => { cleanup(); console.error(e); process.exit(1); });

// ─────────────────────────── 构建 ───────────────────────────
try {
  execFileSync('npx', ['turbo', 'run', 'build', '--continue', ...turboArgs], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    timeout: 1800000,
  });
  release();
  process.exit(0);
} catch (e) {
  release();
  // turbo 的退出码交给调用方判断
  process.exit(typeof e.status === 'number' ? e.status : 1);
}
