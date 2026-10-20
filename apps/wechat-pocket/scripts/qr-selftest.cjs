/**
 * QR 编码器自测（开发期工具，不打进小程序包）。
 *
 * 做两件事：
 *   1. 生成若干真实载荷的模块矩阵，写成 `.pbm`（P4 位图）交给 Python 侧用 OpenCV 解码，
 *      验证「不是画出来就算，而是真的能被扫码器读出来」。
 *   2. 把期望的元信息（version / mask / ecLevel）写入 JSON，便于人工核对。
 *
 * 用法： node scripts/qr-selftest.cjs
 * 依赖： 仅 TypeScript（仓库根 node_modules 已有）+ Python 的 opencv（可选，用于解码回验）
 */

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'miniprogram', 'utils', 'qr.ts');
const OUT_DIR = path.join(ROOT, '.qr-selftest');

function transpile() {
  const source = fs.readFileSync(SRC, 'utf8');
  const out = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      removeComments: true,
    },
    fileName: SRC,
  });
  if (out.diagnostics && out.diagnostics.length) {
    throw new Error(
      '转译失败：' +
        out.diagnostics
          .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
          .join('; '),
    );
  }
  return out.outputText;
}

const CASES = [
  // 名片落地 URL（真实长度，含 trace_id）
  'https://card.matrixos.edu/c/MX-2026-8842?src=wechat-pocket&v=1',
  // 长一点：带 trace
  'https://card.matrixos.edu/c/MX-2026-8842?src=wechat-pocket&v=1&trace=0b8f0c1e-6a1d-4b2e-9c33-7f1a2d4e5f60',
  // DOI 串
  'https://doi.org/10.1038/s41566-025-01688-2',
  // 中文（UTF-8 多字节路径）
  'matrixos://card/MX-2026-8842?name=%E5%AD%99%E5%90%8C%E5%AD%A6',
  // 短串（版本 1 边界）
  'MX-2026-8842',
  // 接近版本上限的长串（版本 ~9~10）
  'https://card.matrixos.edu/c/MX-2026-8842?src=wechat-pocket&v=1&ev=' +
    encodeURIComponent(
      'doi:10.1038/s41566-025-01688-2,doi:10.1002/adma.202407731,gh:mx-lab/trpl-biexp-fit,gh:mx-lab/pvk-eqe-clean',
    ),
];

const EC_LEVELS = ['L', 'M', 'Q', 'H'];

function writePbm(file, modules, quiet, scale) {
  const n = modules.length;
  const total = (n + quiet * 2) * scale;
  const bytesPerRow = Math.ceil(total / 8);
  const header = Buffer.from(`P4\n${total} ${total}\n`, 'ascii');
  // PBM P4：位值 1 = 黑（= 深色模块），0 = 白。所以从全 0（白）开始置黑。
  const body = Buffer.alloc(bytesPerRow * total, 0x00);

  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (!modules[r][c]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        const y = (r + quiet) * scale + dy;
        for (let dx = 0; dx < scale; dx += 1) {
          const x = (c + quiet) * scale + dx;
          const byteIndex = y * bytesPerRow + (x >> 3);
          const bit = 7 - (x & 7);
          body[byteIndex] |= 1 << bit;
        }
      }
    }
  }
  fs.writeFileSync(file, Buffer.concat([header, body]));
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const js = transpile();
  const jsPath = path.join(OUT_DIR, 'qr.cjs');
  fs.writeFileSync(jsPath, js, 'utf8');

  // eslint-disable-next-line import/no-dynamic-require
  const qr = require(jsPath);
  if (typeof qr.encodeQr !== 'function') throw new Error('encodeQr 未导出');

  const manifest = [];
  let idx = 0;
  for (const text of CASES) {
    for (const ec of EC_LEVELS) {
      idx += 1;
      const name = `case-${String(idx).padStart(2, '0')}-${ec}-v`;
      let matrix;
      try {
        matrix = qr.encodeQr(text, ec);
      } catch (e) {
        manifest.push({ name, ec, text, error: String(e.message) });
        continue;
      }
      const file = path.join(OUT_DIR, `${name}${matrix.version}.pbm`);
      writePbm(file, matrix.modules, 4, 8);
      manifest.push({
        name,
        ec,
        text,
        file: path.relative(ROOT, file),
        version: matrix.version,
        mask: matrix.mask,
        size: matrix.size,
        bytes: Buffer.byteLength(text, 'utf8'),
      });
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // 同时输出一份 ASCII 版本，便于肉眼快速确认图形结构
  const demo = qr.encodeQr(CASES[0], 'M');
  const ascii = demo.modules
    .map((row) => row.map((v) => (v ? '██' : '  ')).join(''))
    .join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'demo-ascii.txt'), ascii, 'utf8');

  console.log(`已生成 ${manifest.filter((m) => !m.error).length} 个二维码位图 → ${path.relative(ROOT, OUT_DIR)}`);
  console.log(`首例：version=${demo.version} mask=${demo.mask} size=${demo.size}x${demo.size}`);
}

main();
