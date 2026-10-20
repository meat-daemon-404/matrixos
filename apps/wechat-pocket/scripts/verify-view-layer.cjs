/**
 * 视图层验收（开发期工具，不打进小程序包）。
 *
 * 本机没有微信开发者工具，所以「小程序能启动」只能靠间接证据。本脚本产出三条：
 *   1. `app.json` 声明的每个页面路径 × 4 件套（.ts/.wxml/.wxss/.json）全部存在；
 *   2. `tabBar` 引用的 8 个 PNG 路径全部存在，且能解码：
 *      签名合法 + IHDR 宽高都是 81x81 + 非 0 字节 + 有实际落墨像素（不是空白图）；
 *   3. 组件被页面 `usingComponents` 引用的路径真实存在，`app.json` 的
 *      `sitemapLocation` 指向的文件存在。
 *
 * PNG 解码只做了本仓库产物需要的最小子集：非交错、bit depth 8、color type 6/2、
 * filter 0-4（含 Paeth）。用 node 内置 zlib 解 IDAT，不依赖任何 npm 包。
 *
 * 用法： node scripts/verify-view-layer.cjs
 * 退出码：0 = 全部通过；1 = 有缺项（逐条打印）。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');

const problems = [];
const notes = [];

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

/* ------------------------------------------------------------------ */
/* 最小 PNG 解码器                                                     */
/* ------------------------------------------------------------------ */

function pngDecode(buf, file) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i += 1) {
    if (buf[i] !== SIG[i]) throw new Error(`${rel(file)}：PNG 签名不合法`);
  }
  let off = 8;
  let ihdr = null;
  const idatParts = [];
  let sawIend = false;

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    if (dataStart + len + 4 > buf.length) throw new Error(`${rel(file)}：块长度越界 @${off}`);
    const data = buf.subarray(dataStart, dataStart + len);

    // CRC 校验：真实解码器不做这件事会漏掉截断/损坏
    const crcBuf = buf.subarray(dataStart + len, dataStart + len + 4);
    const expect = crcBuf.readUInt32BE(0);
    const got = crc32(Buffer.concat([Buffer.from(type, 'ascii'), data]));
    if (expect !== got) throw new Error(`${rel(file)}：${type} 块 CRC 不匹配`);

    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      sawIend = true;
    }
    off = dataStart + len + 4;
  }

  if (!ihdr) throw new Error(`${rel(file)}：缺 IHDR`);
  if (!sawIend) throw new Error(`${rel(file)}：缺 IEND`);
  if (ihdr.interlace !== 0) throw new Error(`${rel(file)}：不支持隔行扫描（interlace=${ihdr.interlace}）`);
  if (ihdr.bitDepth !== 8) throw new Error(`${rel(file)}：要求 bit depth 8，实际 ${ihdr.bitDepth}`);
  if (ihdr.colorType !== 6 && ihdr.colorType !== 2) {
    throw new Error(`${rel(file)}：要求 color type 6(RGBA) 或 2(RGB)，实际 ${ihdr.colorType}`);
  }

  const channels = ihdr.colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const stride = ihdr.width * channels;
  if (raw.length !== (stride + 1) * ihdr.height) {
    throw new Error(`${rel(file)}：IDAT 解压长度 ${raw.length} ≠ ${(stride + 1) * ihdr.height}`);
  }

  const out = Buffer.alloc(ihdr.height * stride);
  const prevRow = Buffer.alloc(stride);
  for (let y = 0; y < ihdr.height; y += 1) {
    const ft = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const row = out.subarray(y * stride, (y + 1) * stride);
    const above = y === 0 ? prevRow : out.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = above[x];
      const c = x >= channels ? above[x - channels] : 0;
      const v = src[x];
      let val;
      switch (ft) {
        case 0:
          val = v;
          break;
        case 1:
          val = v + a;
          break;
        case 2:
          val = v + b;
          break;
        case 3:
          val = v + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          val = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`${rel(file)}：未知 filter type ${ft} @行 ${y}`);
      }
      row[x] = val & 0xff;
    }
  }

  return { ...ihdr, channels, pixels: out };
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ */
/* 1. app.json 页面四件套                                              */
/* ------------------------------------------------------------------ */

const appJsonPath = path.join(MP, 'app.json');
if (!fs.existsSync(appJsonPath)) {
  problems.push(`miniprogram/app.json 不存在`);
}
const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));

/** 收集全部页面绝对路径（主包 + 分包 root 拼接）。 */
const pagePaths = [];
for (const p of appJson.pages || []) pagePaths.push({ page: p, label: `pages[] ${p}` });
for (const sub of appJson.subPackages || []) {
  for (const p of sub.pages || []) pagePaths.push({ page: `${sub.root}/${p}`, label: `subPackage(${sub.root}) ${p}` });
}

const SUF = ['ts', 'wxml', 'wxss', 'json'];
const fileRows = [];
for (const { page, label } of pagePaths) {
  const missing = [];
  const found = [];
  for (const s of SUF) {
    const f = path.join(MP, `${page}.${s}`);
    if (fs.existsSync(f) && fs.statSync(f).size > 0) found.push(`index.${s}`);
    else missing.push(`.${s}`);
  }
  if (missing.length) problems.push(`${label}：缺 ${missing.join(' ')}`);
  fileRows.push({ page, found: found.length, missing });
  notes.push(`  ${page}  →  ${found.length}/4 件套${missing.length ? '  缺 ' + missing.join(',') : ''}`);
}
const totalFiles = fileRows.reduce((n, r) => n + r.found, 0);

/* ------------------------------------------------------------------ */
/* 2. 应用入口 + sitemap                                              */
/* ------------------------------------------------------------------ */

for (const f of ['app.ts', 'app.wxss']) {
  const p = path.join(MP, f);
  if (!fs.existsSync(p) || fs.statSync(p).size === 0) problems.push(`miniprogram/${f} 缺失或为空`);
}
if (appJson.sitemapLocation) {
  const p = path.join(MP, appJson.sitemapLocation);
  if (!fs.existsSync(p)) problems.push(`sitemapLocation 指向的 ${appJson.sitemapLocation} 不存在`);
}

/* ------------------------------------------------------------------ */
/* 3. tabBar 图标                                                     */
/* ------------------------------------------------------------------ */

const EXPECT_ICON = 81;
const iconRows = [];
const tabList = (appJson.tabBar && appJson.tabBar.list) || [];
for (const item of tabList) {
  for (const key of ['iconPath', 'selectedIconPath']) {
    const declared = item[key];
    if (!declared) {
      problems.push(`tabBar ${item.pagePath} 缺 ${key}`);
      continue;
    }
    const file = path.join(MP, declared);
    const row = { declared, size: 0, dims: '-', alpha: 0, colored: false };
    if (!fs.existsSync(file)) {
      problems.push(`tabBar 图标不存在：${declared}`);
      iconRows.push(row);
      continue;
    }
    const buf = fs.readFileSync(file);
    row.size = buf.length;
    if (buf.length === 0) problems.push(`${declared} 是 0 字节文件`);
    try {
      const img = pngDecode(buf, file);
      row.dims = `${img.width}x${img.height}`;
      if (img.width !== EXPECT_ICON || img.height !== EXPECT_ICON) {
        problems.push(`${declared} 尺寸 ${img.dims} ≠ ${EXPECT_ICON}x${EXPECT_ICON}`);
      }
      let opaque = 0;
      let colorSum = [0, 0, 0];
      for (let i = 0; i < img.pixels.length; i += img.channels) {
        const a = img.channels === 4 ? img.pixels[i + 3] : 255;
        if (a > 8) {
          opaque += 1;
          colorSum[0] += img.pixels[i];
          colorSum[1] += img.pixels[i + 1];
          colorSum[2] += img.pixels[i + 2];
        }
      }
      row.alpha = opaque;
      if (opaque === 0) problems.push(`${declared} 解出来一个落墨像素都没有（空白图）`);
      if (img.channels === 4 && opaque > 0) {
        const avg = colorSum.map((v) => Math.round(v / opaque));
        row.color = `#${avg.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
        row.colored = true;
      }
    } catch (e) {
      problems.push(`${declared} 解码失败：${e.message}`);
    }
    iconRows.push(row);
  }
}

/* ------------------------------------------------------------------ */
/* 4. usingComponents 引用完整性                                       */
/* ------------------------------------------------------------------ */

let compRefs = 0;
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules') continue;
      walk(full);
      continue;
    }
    // 扩展名是 ".json" 不是 "json"——`ent.name !== 'json'` 永远为真，会让整个
    // usingComponents 校验空转（"0 引用"却"全部通过"，是典型的假绿灯）。
    if (!ent.name.endsWith('.json') || ent.name === 'app.json' || full === appJsonPath) continue;
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      problems.push(`${rel(full)} 不是合法 JSON：${e.message}`);
      continue;
    }
    const uc = cfg.usingComponents || {};
    for (const [tag, target] of Object.entries(uc)) {
      compRefs += 1;
      if (typeof target !== 'string') {
        problems.push(`${rel(full)} 组件 ${tag} 的值不是字符串`);
        continue;
      }
      // 分包页面里 `/components/...` 是「绝对路径 = 相对 miniprogramRoot」
      const base = target.startsWith('/')
        ? path.join(MP, target.slice(1))
        : path.resolve(path.dirname(full), target);
      for (const s of ['json', 'wxml', 'wxss', 'ts']) {
        if (!fs.existsSync(`${base}.${s}`)) {
          problems.push(`${rel(full)} 引用组件 ${tag} → ${target} 缺 ${s}（${rel(base)}.${s} 不存在）`);
        }
      }
    }
  }
}
walk(MP);

/* ------------------------------------------------------------------ */
/* 5. WXML 语法红线：不得出现 React/Vue/HTML 写法                       */
/* ------------------------------------------------------------------ */

const BAD_PATTERNS = [
  { re: /\bclassName=/, why: 'React 的 className（小程序用 class）' },
  { re: /\bonClick=/, why: 'React 的 onClick（小程序用 bindtap）' },
  { re: /\bv-(if|for|else|bind|on)=/, why: 'Vue 指令' },
  { re: /\b(v-if|v-for)=/, why: 'Vue 指令' },
  // 注意 button 不在此列：它是小程序原生组件（<button>），误列入会让每个正常页面都"红"。
  // img 用 \b 精确匹配，`<image>` 不会被误伤（image 的 e 使 \b 不成立）。
  { re: /<\/?(div|span|ul|li|p|h[1-6]|section|header|footer|img|a)\b/, why: 'HTML 标签' },
  { re: /\bkey=\{/, why: 'JSX key' },
];
let wxmlCount = 0;
function walkWxml(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkWxml(full);
      continue;
    }
    if (!ent.name.endsWith('.wxml')) continue;
    wxmlCount += 1;
    const text = fs.readFileSync(full, 'utf8');
    for (const { re, why } of BAD_PATTERNS) {
      if (re.test(text)) problems.push(`${rel(full)}：出现非小程序原生语法（${why}）`);
    }
  }
}
walkWxml(MP);

/* ------------------------------------------------------------------ */
/* 6. 编码门禁：不允许 U+FFFD                                          */
/* ------------------------------------------------------------------ */

function walkAll(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkAll(full);
      continue;
    }
    if (!/\.(ts|wxml|wxss|json|cjs)$/.test(ent.name)) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (text.indexOf('\uFFFD') >= 0) problems.push(`${rel(full)}：含 U+FFFD 替换字符（编码门禁）`);
  }
}
walkAll(MP);
walkAll(path.join(ROOT, 'scripts'));

/* ------------------------------------------------------------------ */
/* 输出                                                              */
/* ------------------------------------------------------------------ */

console.log('=== 1. app.json 页面四件套 ===');
console.log(notes.join('\n'));
console.log(`页面 ${pagePaths.length} 个，存在文件 ${totalFiles} 个（应 ${pagePaths.length * 4} 个）`);

console.log('\n=== 2. tabBar 图标 ===');
for (const r of iconRows) {
  console.log(
    `  ${r.declared}  ${r.dims}  ${r.size}B  落墨像素 ${r.alpha}${r.color ? '  均色 ' + r.color : ''}`,
  );
}
console.log(`图标引用 ${iconRows.length} 个（tab ${tabList.length} × 2）`);

console.log(`\n=== 3. 组件引用 / WXML / 编码 ===`);
console.log(`  usingComponents 引用 ${compRefs} 处，WXML 文件 ${wxmlCount} 个`);

console.log('\n=== 结论 ===');
if (problems.length) {
  for (const p of problems) console.log(`  ✗ ${p}`);
  console.log(`不通过：${problems.length} 项`);
  process.exitCode = 1;
} else {
  console.log('  ✓ 全部通过');
}
