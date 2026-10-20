#!/usr/bin/env node
/**
 * 生成 RSA 密钥对，供 MatrixID JWT (RS256) 使用。
 *
 * 用法：node scripts/gen-keys.mjs
 *
 * 输出：
 *   services/matrix-core/keys/private.pem  ← 🔴 绝不提交（已在 .gitignore）
 *   services/matrix-core/keys/public.pem   ← 可提交
 *
 * 密钥长度 2048 位，够 JWT 签名用，且签发/校验速度快。
 */
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEYS_DIR = join(ROOT, 'services', 'matrix-core', 'keys');
const PRIVATE = join(KEYS_DIR, 'private.pem');
const PUBLIC = join(KEYS_DIR, 'public.pem');

if (existsSync(PRIVATE)) {
  console.error('✗ 私钥已存在，拒绝覆盖：');
  console.error(`  ${PRIVATE}`);
  console.error('');
  console.error('  如需重新生成，先手动删除以下两个文件：');
  console.error(`  ${PRIVATE}`);
  console.error(`  ${PUBLIC}`);
  console.error('');
  console.error('  ⚠️ 重新生成会让所有已签发的 token 立即失效。');
  process.exit(1);
}

mkdirSync(KEYS_DIR, { recursive: true });

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

writeFileSync(PRIVATE, privateKey, { encoding: 'utf8', mode: 0o600 });
writeFileSync(PUBLIC, publicKey, { encoding: 'utf8' });

console.log('✓ RSA 密钥对已生成');
console.log(`  私钥: ${PRIVATE}   (600 权限，已 gitignore)`);
console.log(`  公钥: ${PUBLIC}`);
console.log('');
console.log('⚠️ 私钥绝不提交。确认 .gitignore 含 services/matrix-core/keys/private.pem');
