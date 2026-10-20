/**
 * 极简 QR Code 编码器（纯 TypeScript，零依赖）。
 *
 * 为什么自己实现：学术名片要离线可扫，二维码必须端侧生成。
 * 引第三方库（qrcode / qrcode-generator）会让主包多 20–40 KB，
 * 与冷启动 < 800ms 的目标冲突；而本端只需 byte 模式 + 版本 1..10，
 * 代码量不到 400 行，gzip 后约 4 KB。
 *
 * 支持范围（够用且明确边界，不假装通用）：
 *   - 模式：Byte（UTF-8），不做数字/字母数字/汉字模式
 *   - 版本：1..10（最多 ~271 字节 @M），名片 URL 与 DOI 串都远小于此
 *   - 纠错：L / M / Q / H，默认 M
 *   - 自动选版本（最小可容纳版本）与自动选掩码（按标准罚分规则）
 *
 * 算法依据 ISO/IEC 18004。结构与 `qrcode.base` 的 RS 块表逐项核对过
 * （见 `scripts/qr-selftest` 的期望值来源说明）。
 */

export type EcLevel = 'L' | 'M' | 'Q' | 'H';

interface BlockSpec {
  /** 每个块的纠错码字数 */
  ecc: number;
  /** [块数, 每块数据码字数]，按「小块在前」排列 */
  groups: Array<[number, number]>;
}

/**
 * 版本 → 纠错级别 → 块结构。
 * 数据来自 ISO/IEC 18004 Table 9，与 Python `qrcode` 库的 RS_BLOCK_TABLE 对齐校验。
 */
const BLOCKS: Record<number, Record<EcLevel, BlockSpec>> = {
  1: {
    L: { ecc: 7, groups: [[1, 19]] },
    M: { ecc: 10, groups: [[1, 16]] },
    Q: { ecc: 13, groups: [[1, 13]] },
    H: { ecc: 17, groups: [[1, 9]] },
  },
  2: {
    L: { ecc: 10, groups: [[1, 34]] },
    M: { ecc: 16, groups: [[1, 28]] },
    Q: { ecc: 22, groups: [[1, 22]] },
    H: { ecc: 28, groups: [[1, 16]] },
  },
  3: {
    L: { ecc: 15, groups: [[1, 55]] },
    M: { ecc: 26, groups: [[1, 44]] },
    Q: { ecc: 18, groups: [[2, 17]] },
    H: { ecc: 22, groups: [[2, 13]] },
  },
  4: {
    L: { ecc: 20, groups: [[1, 80]] },
    M: { ecc: 18, groups: [[2, 32]] },
    Q: { ecc: 26, groups: [[2, 24]] },
    H: { ecc: 16, groups: [[4, 9]] },
  },
  5: {
    L: { ecc: 26, groups: [[1, 108]] },
    M: { ecc: 24, groups: [[2, 43]] },
    Q: { ecc: 18, groups: [[2, 15], [2, 16]] },
    H: { ecc: 22, groups: [[2, 11], [2, 12]] },
  },
  6: {
    L: { ecc: 18, groups: [[2, 68]] },
    M: { ecc: 16, groups: [[4, 27]] },
    Q: { ecc: 24, groups: [[4, 19]] },
    H: { ecc: 28, groups: [[4, 15]] },
  },
  7: {
    L: { ecc: 20, groups: [[2, 78]] },
    M: { ecc: 18, groups: [[4, 31]] },
    Q: { ecc: 18, groups: [[2, 14], [4, 15]] },
    H: { ecc: 26, groups: [[4, 13], [1, 14]] },
  },
  8: {
    L: { ecc: 24, groups: [[2, 97]] },
    M: { ecc: 22, groups: [[2, 38], [2, 39]] },
    Q: { ecc: 22, groups: [[4, 18], [2, 19]] },
    H: { ecc: 26, groups: [[4, 14], [2, 15]] },
  },
  9: {
    L: { ecc: 30, groups: [[2, 116]] },
    M: { ecc: 22, groups: [[3, 36], [2, 37]] },
    Q: { ecc: 20, groups: [[4, 16], [4, 17]] },
    H: { ecc: 24, groups: [[4, 12], [4, 13]] },
  },
  10: {
    L: { ecc: 18, groups: [[2, 68], [2, 69]] },
    M: { ecc: 26, groups: [[4, 43], [1, 44]] },
    Q: { ecc: 24, groups: [[6, 19], [2, 20]] },
    H: { ecc: 28, groups: [[6, 15], [2, 16]] },
  },
};

/** 各版本对齐图形中心坐标（ISO/IEC 18004 Annex E）。 */
const ALIGN: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const MAX_VERSION = 10;
const EC_BITS: Record<EcLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

/* ------------------------------------------------------------------ */
/* 位缓冲                                                              */
/* ------------------------------------------------------------------ */

class BitBuffer {
  private bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }

  toBytes(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j += 1) {
        byte = (byte << 1) | (this.bits[i + j] ?? 0);
      }
      out.push(byte);
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Reed-Solomon                                                        */
/* ------------------------------------------------------------------ */

/** GF(256) 的指数/对数表，本原多项式 0x11D。 */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGf(): void {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255]!;
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/** 生成多项式 ∏(x - α^i)，i = 0..degree-1。 */
function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next: number[] = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]!;
      next[j + 1] ^= gfMul(poly[j]!, GF_EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** 对一个数据块计算 ecc 个纠错码字。 */
function rsEncode(data: number[], ecc: number): number[] {
  const gen = rsGenerator(ecc);
  const rem: number[] = new Array(ecc).fill(0);

  for (const byte of data) {
    const factor = byte ^ rem[0]!;
    rem.shift();
    rem.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecc; i += 1) {
        rem[i] = rem[i]! ^ gfMul(gen[i + 1]!, factor);
      }
    }
  }
  return rem;
}

/* ------------------------------------------------------------------ */
/* 矩阵                                                                */
/* ------------------------------------------------------------------ */

type Matrix = boolean[][];
type Reserved = boolean[][];

function makeMatrix(size: number): Matrix {
  const m: Matrix = [];
  for (let i = 0; i < size; i += 1) m.push(new Array(size).fill(false));
  return m;
}

function makeReserved(size: number): Reserved {
  const r: Reserved = [];
  for (let i = 0; i < size; i += 1) r.push(new Array(size).fill(false));
  return r;
}

/** 功能图形：定位、分隔、校正、定时、暗模块。 */
function placeFunctionPatterns(m: Matrix, res: Reserved, version: number): void {
  const size = m.length;

  const finder = (row: number, col: number): void => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const isDark =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        m[rr]![cc] = isDark;
        res[rr]![cc] = true;
      }
    }
  };

  // 1) 三个定位图形（含 1 模块宽的分隔带）
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // 2) 校正图形 —— **必须早于定时图形**。
  // 二者在 (row=6 / col=6) 的位置会重叠，标准规定校正图形优先，
  // 因此这里只跳过与三个定位图形重叠的位置，其余全部绘制。
  const centers = ALIGN[version] ?? [];
  const last = centers.length - 1;
  for (let a = 0; a < centers.length; a += 1) {
    for (let b = 0; b < centers.length; b += 1) {
      const isFinderCorner = (a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0);
      if (isFinderCorner) continue;

      const row = centers[a]!;
      const col = centers[b]!;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const isDark = Math.max(Math.abs(r), Math.abs(c)) !== 1; // 外圈深、中圈浅、中心深
          m[row + r]![col + c] = isDark;
          res[row + r]![col + c] = true;
        }
      }
    }
  }

  // 3) 定时图形 —— 只填充尚未被占用的格子（校正图形优先）
  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    if (!res[6]![i]) {
      m[6]![i] = dark;
      res[6]![i] = true;
    }
    if (!res[i]![6]) {
      m[i]![6] = dark;
      res[i]![6] = true;
    }
  }

  // 4) 暗模块（固定为深，位置在左下定位图形上方一格）
  m[size - 8]![8] = true;
  res[size - 8]![8] = true;
}

/** 预留格式信息区（真正取值在 applyFormatInfo 里写）。 */
function reserveFormatArea(res: Reserved): void {
  const size = res.length;
  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) {
      res[8]![i] = true;
      res[i]![8] = true;
    }
  }
  res[8]![6] = true;
  res[6]![8] = true;
  for (let i = 0; i < 8; i += 1) {
    res[8]![size - 1 - i] = true;
    res[size - 1 - i]![8] = true;
  }
}

/** 版本 ≥ 7 时的版本信息区（6×3 两块）。 */
function placeVersionInfo(m: Matrix, res: Reserved, version: number): void {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  }
  const bits = (version << 12) | rem;
  const size = m.length;

  for (let i = 0; i < 18; i += 1) {
    const bit = ((bits >>> i) & 1) === 1;
    const row = Math.floor(i / 3);
    const col = i % 3;
    m[size - 11 + col]![row] = bit;
    res[size - 11 + col]![row] = true;
    m[row]![size - 11 + col] = bit;
    res[row]![size - 11 + col] = true;
  }
}

/** 数据位按之字形填充。 */
function placeData(m: Matrix, res: Reserved, bits: number[]): void {
  const size = m.length;
  let index = 0;
  let upward = true;

  // 列对从右往左：(size-1,size-2)、(size-3,size-4)……
  // 关键细节：第 6 列是定时图形，必须**整列跳过**。
  // 正确做法是把右列指针从 6 跳到 5（而不是减一），否则会重复填充第 4 列。
  let right = size - 1;
  while (right >= 1) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      const row = upward ? size - 1 - vert : vert;
      for (let k = 0; k < 2; k += 1) {
        const cc = right - k;
        if (cc < 0) continue;
        if (res[row]![cc]) continue;
        m[row]![cc] = index < bits.length ? bits[index] === 1 : false;
        index += 1;
      }
    }
    upward = !upward;
    right -= 2;
  }
}

/* ------------------------------------------------------------------ */
/* 掩码                                                                */
/* ------------------------------------------------------------------ */

const MASKS: Array<(row: number, col: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(m: Matrix, res: Reserved, mask: number): Matrix {
  const size = m.length;
  const out = makeMatrix(size);
  const fn = MASKS[mask]!;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      const v = m[r]![c]!;
      out[r]![c] = res[r]![c] ? v : v !== fn(r, c);
    }
  }
  return out;
}

/** 罚分规则（ISO/IEC 18004 §8.8.2），越低越好。 */
function penalty(m: Matrix): number {
  const size = m.length;
  let score = 0;

  // 规则 1：行/列中连续同色 ≥ 5
  const runScore = (line: boolean[]): number => {
    let total = 0;
    let run = 1;
    for (let i = 1; i < line.length; i += 1) {
      if (line[i] === line[i - 1]) {
        run += 1;
      } else {
        if (run >= 5) total += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) total += 3 + (run - 5);
    return total;
  };

  for (let r = 0; r < size; r += 1) score += runScore(m[r]!);
  for (let c = 0; c < size; c += 1) {
    const col: boolean[] = [];
    for (let r = 0; r < size; r += 1) col.push(m[r]![c]!);
    score += runScore(col);
  }

  // 规则 2：2×2 同色块
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = m[r]![c]!;
      if (v === m[r]![c + 1] && v === m[r + 1]![c] && v === m[r + 1]![c + 1]) score += 3;
    }
  }

  // 规则 3：1:1:3:1:1 类定位图形
  const pattern = [true, false, true, true, true, false, true];
  const check = (line: boolean[], start: number): boolean => {
    for (let i = 0; i < 7; i += 1) {
      if (line[start + i] !== pattern[i]) return false;
    }
    // 前后需要 4 个浅色（越界视为浅色）
    let before = 0;
    for (let i = start - 1; i >= 0 && before < 4; i -= 1) {
      if (line[i]) break;
      before += 1;
    }
    let after = 0;
    for (let i = start + 7; i < line.length && after < 4; i += 1) {
      if (line[i]) break;
      after += 1;
    }
    return before === 4 || after === 4;
  };

  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c + 7 <= size; c += 1) {
      if (check(m[r]!, c)) score += 40;
    }
  }
  for (let c = 0; c < size; c += 1) {
    const col: boolean[] = [];
    for (let r = 0; r < size; r += 1) col.push(m[r]![c]!);
    for (let r = 0; r + 7 <= size; r += 1) {
      if (check(col, r)) score += 40;
    }
  }

  // 规则 4：深色比例偏离 50%
  let dark = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (m[r]![c]) dark += 1;
    }
  }
  const ratio = (dark * 100) / (size * size);
  const deviation = Math.abs(Math.ceil(ratio / 5) * 5 - 50) / 5;
  score += deviation * 10;

  return score;
}

/** 写格式信息（纠错级别 + 掩码号 + BCH）。 */
function applyFormatInfo(m: Matrix, ec: EcLevel, mask: number): void {
  const size = m.length;
  const data = (EC_BITS[ec] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  const bits = ((data << 10) | rem) ^ 0x5412;

  const bitAt = (i: number): boolean => ((bits >>> i) & 1) === 1;

  // 第一份：左上角，沿第 8 列向下 + 沿第 8 行向右（注意行列不要搞反）
  for (let i = 0; i <= 5; i += 1) m[i]![8] = bitAt(i);
  m[7]![8] = bitAt(6);
  m[8]![8] = bitAt(7);
  m[8]![7] = bitAt(8);
  for (let i = 9; i <= 14; i += 1) m[8]![14 - i] = bitAt(i);

  // 第二份：右上角一行 8 个 + 左下角一列 7 个
  for (let i = 0; i <= 7; i += 1) m[8]![size - 1 - i] = bitAt(i);
  for (let i = 8; i <= 14; i += 1) m[size - 15 + i]![8] = bitAt(i);

  // 固定的暗模块
  m[size - 8]![8] = true;
}

/* ------------------------------------------------------------------ */
/* 编码主流程                                                          */
/* ------------------------------------------------------------------ */

function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let cp = text.charCodeAt(i);
    // 处理代理对
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = ((cp - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
        i += 1;
      }
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
}

function totalDataCodewords(version: number, ec: EcLevel): number {
  const spec = BLOCKS[version]![ec];
  let n = 0;
  for (const [count, dataLen] of spec.groups) n += count * dataLen;
  return n;
}

/** 给定内容，选出能容纳的最小版本。返回 null 表示超出支持范围。 */
export function chooseVersion(text: string, ec: EcLevel): number | null {
  const bytes = utf8Bytes(text).length;
  for (let v = 1; v <= MAX_VERSION; v += 1) {
    const countBits = v <= 9 ? 8 : 16;
    const capacityBits = totalDataCodewords(v, ec) * 8;
    // 4 bit 模式 + countBits + 内容
    if (capacityBits >= 4 + countBits + bytes * 8) return v;
  }
  return null;
}

function buildDataCodewords(text: string, version: number, ec: EcLevel): number[] {
  const bytes = utf8Bytes(text);
  const countBits = version <= 9 ? 8 : 16;
  const capacityBits = totalDataCodewords(version, ec) * 8;

  const buf = new BitBuffer();
  buf.push(0b0100, 4); // Byte 模式
  buf.push(bytes.length, countBits);
  for (const b of bytes) buf.push(b, 8);

  // 终止符（最多 4 bit）
  const terminator = Math.min(4, capacityBits - buf.length);
  if (terminator > 0) buf.push(0, terminator);

  // 补齐到字节边界
  while (buf.length % 8 !== 0) buf.push(0, 1);

  const codewords = buf.toBytes();

  // 填充字节 0xEC / 0x11 交替
  const target = capacityBits / 8;
  let pad = 0;
  while (codewords.length < target) {
    codewords.push(pad % 2 === 0 ? 0xec : 0x11);
    pad += 1;
  }
  return codewords;
}

function interleave(dataCodewords: number[], version: number, ec: EcLevel): number[] {
  const spec = BLOCKS[version]![ec];

  // 按 groups 切块
  const dataBlocks: number[][] = [];
  let offset = 0;
  for (const [count, dataLen] of spec.groups) {
    for (let i = 0; i < count; i += 1) {
      dataBlocks.push(dataCodewords.slice(offset, offset + dataLen));
      offset += dataLen;
    }
  }

  const eccBlocks = dataBlocks.map((d) => rsEncode(d, spec.ecc));

  const out: number[] = [];
  // 数据码字：按列交错
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) out.push(block[i]!);
    }
  }
  // 纠错码字：定长，直接按列交错
  for (let i = 0; i < spec.ecc; i += 1) {
    for (const block of eccBlocks) {
      out.push(block[i]!);
    }
  }
  return out;
}

function bytesToBits(bytes: number[]): number[] {
  const bits: number[] = [];
  for (const b of bytes) {
    for (let i = 7; i >= 0; i -= 1) bits.push((b >>> i) & 1);
  }
  return bits;
}

export interface QrMatrix {
  /** 边长（模块数） */
  size: number;
  /** `modules[row][col]`，true = 深色 */
  modules: boolean[][];
  version: number;
  ecLevel: EcLevel;
  mask: number;
}

/**
 * 编码字符串为 QR 模块矩阵。
 * @throws Error 当内容超出支持范围（版本 > 10）
 */
export function encodeQr(text: string, ec: EcLevel = 'M'): QrMatrix {
  if (!text) throw new Error('QR 内容不能为空');

  const version = chooseVersion(text, ec);
  if (version === null) {
    throw new Error(`内容过长（${utf8Bytes(text).length} 字节），超出本编码器支持的版本 ${MAX_VERSION}`);
  }

  const size = version * 4 + 17;
  const base = makeMatrix(size);
  const reserved = makeReserved(size);

  placeFunctionPatterns(base, reserved, version);
  reserveFormatArea(reserved);
  placeVersionInfo(base, reserved, version);

  const dataCodewords = buildDataCodewords(text, version, ec);
  const finalCodewords = interleave(dataCodewords, version, ec);
  // 末尾填充位（remainder bits）在 placeData 中按 0 处理
  placeData(base, reserved, bytesToBits(finalCodewords));

  // 选最优掩码
  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestMatrix: Matrix | null = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = applyMask(base, reserved, mask);
    applyFormatInfo(candidate, ec, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      bestMatrix = candidate;
    }
  }

  return {
    size,
    modules: bestMatrix ?? base,
    version,
    ecLevel: ec,
    mask: bestMask,
  };
}

/**
 * 在 Canvas 2D 上下文里绘制二维码。
 *
 * 静区（quiet zone）必须留 4 个模块，否则扫码器识别率显著下降 ——
 * 这是最常见的"能画出来但扫不动"的原因，所以单独开参数并给默认值 4。
 */
export function drawQrToCanvas(
  ctx: {
    fillStyle: string;
    fillRect: (x: number, y: number, w: number, h: number) => void;
    clearRect?: (x: number, y: number, w: number, h: number) => void;
  },
  matrix: QrMatrix,
  opts: {
    /** 目标边长（CSS px） */
    size: number;
    /** 深色模块颜色，默认近黑（不用纯黑，减少屏幕炫光） */
    dark?: string;
    /** 浅色模块颜色，默认纯白（保证对比度） */
    light?: string;
    /** 静区宽度（模块数），默认 4 */
    quietZone?: number;
  },
): { moduleSize: number; totalSize: number } {
  const quiet = opts.quietZone ?? 4;
  const totalModules = matrix.size + quiet * 2;
  const moduleSize = opts.size / totalModules;
  const dark = opts.dark ?? '#0b1124';
  const light = opts.light ?? '#ffffff';

  if (ctx.clearRect) ctx.clearRect(0, 0, opts.size, opts.size);

  // 底色（含静区）
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, opts.size, opts.size);

  ctx.fillStyle = dark;
  for (let r = 0; r < matrix.size; r += 1) {
    const row = matrix.modules[r]!;
    for (let c = 0; c < matrix.size; c += 1) {
      if (!row[c]) continue;
      // 用 ceil 保证相邻模块之间没有亚像素缝隙（否则扫码器会看到细白线）
      const x = Math.floor((c + quiet) * moduleSize);
      const y = Math.floor((r + quiet) * moduleSize);
      const w = Math.ceil(moduleSize);
      const h = Math.ceil(moduleSize);
      ctx.fillRect(x, y, w, h);
    }
  }

  return { moduleSize, totalSize: opts.size };
}
