/**
 * 生成 tabBar 的 8 张图标（开发期工具，不打进小程序包）。
 *
 * 为什么自己写而不是找素材：
 *   - 铁律「不新增 npm 依赖、不联网」，不能装 sharp / pngjs / iconfont 拉图；
 *   - `miniprogram/assets/tabbar/*.png` 是 `app.json` 里 tabBar 的硬引用，缺一个
 *     微信开发者工具就整条启动失败；
 *   - 手写 PNG 只需要 node 内置 `zlib` + `Buffer`：IHDR / IDAT / IEND + CRC32，
 *     约 200 行，完全可复现、幂等（内容只由几何决定，不含时间戳）。
 *
 * 输出规格（与 app.json 的 `tabBar` 对齐）：
 *   - 81x81 RGBA（color type 6，bit depth 8），透明背景；
 *   - 普通态 #64748b（slate-500），选中态 #22d3ee（cyan-400）——
 *     取自 docs/00-analysis/04-visual-system.md 的实测 token 表，
 *     与 app.json 的 `tabBar.color` / `selectedColor` 逐字一致；
 *   - 深色底 #050814 上两个色的对比度分别是 4.20:1 与 11.05:1（同文件 §2.5），
 *     图标级尺寸可用；故线宽刻意取粗（≥4px），避免细线在暗底上被吃掉。
 *
 * 抗锯齿：对每个像素做 5x5 子采样，覆盖率写进 alpha。
 * 图形用「到轮廓的距离」判定（distance-to-segment / distance-to-circle），
 * 端点自然是圆头，不需要额外画帽。
 *
 * 用法： node scripts/gen-tabbar-icons.cjs
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'miniprogram', 'assets', 'tabbar');
const SIZE = 81;
const SS = 5; // 每边子采样数（SS*SS 个采样点/像素）

const COLOR_IDLE = [0x64, 0x74, 0x8b]; // #64748b —— app.json tabBar.color
const COLOR_ACTIVE = [0x22, 0xd3, 0xee]; // #22d3ee —— app.json tabBar.selectedColor

/* ------------------------------------------------------------------ */
/* PNG 编码（仅本任务所需子集：单幅、非交错、RGBA、filter 0）              */
/* ------------------------------------------------------------------ */

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

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * rgba: 长度 SIZE*SIZE*4 的字节数组。
 * 每行前加 1 字节 filter type（0 = None），整体走 zlib deflate。
 */
function encodePng(rgba, width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: 一套可定义过滤器，行前缀字节
  ihdr[12] = 0; // interlace: none

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ------------------------------------------------------------------ */
/* 几何：返回「该浮点坐标是否落墨」的判定函数                            */
/* ------------------------------------------------------------------ */

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 === 0 ? 0 : (wx * vx + wy * vy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = wx - t * vx;
  const dy = wy - t * vy;
  return Math.sqrt(dx * dx + dy * dy);
}

function strokePolyline(points, width) {
  const half = width / 2;
  return (x, y) => {
    for (let i = 0; i + 1 < points.length; i += 1) {
      if (distToSegment(x, y, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]) <= half) {
        return true;
      }
    }
    return false;
  };
}

function strokeCircle(cx, cy, r, width) {
  const half = width / 2;
  return (x, y) => {
    const d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
    return Math.abs(d - r) <= half;
  };
}

function disc(cx, cy, r) {
  return (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
}

/**
 * 圆角矩形轮廓的符号距离：`length(max(q,0)) + min(max(q.x,q.y),0) - r`。
 * 取绝对值与 half 比较即为「描边带」。
 */
function strokeRoundRect(x0, y0, x1, y1, radius, width) {
  const half = width / 2;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hw = (x1 - x0) / 2 - radius;
  const hh = (y1 - y0) / 2 - radius;
  return (x, y) => {
    const qx = Math.abs(x - cx) - hw;
    const qy = Math.abs(y - cy) - hh;
    const ax = qx > 0 ? qx : 0;
    const ay = qy > 0 ? qy : 0;
    const sd = Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - radius;
    return sd <= half && sd >= -half;
  };
}

/** 圆弧折线采样（角度制）。小程序端没有 Path2D，直接密采样成折线。 */
function arcPoints(cx, cy, r, a0Deg, a1Deg, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = ((a0Deg + ((a1Deg - a0Deg) * i) / steps) * Math.PI) / 180;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** 复合判定：任一子形状落墨即落墨。 */
function anyOf(...fns) {
  return (x, y) => {
    for (const f of fns) if (f(x, y)) return true;
    return false;
  };
}

/* ------------------------------------------------------------------ */
/* 四个语义图形（中心 40.5,40.5，四周留白 ≥8px）                        */
/* ------------------------------------------------------------------ */

const C = SIZE / 2; // 40.5

/** 早报 = 圆日 + 8 道射线（08:00 批次的热度信号）。 */
function glyphMorning() {
  const parts = [strokeCircle(C, C, 13, 5.2)];
  for (let i = 0; i < 8; i += 1) {
    const a = (i * Math.PI) / 4;
    const r0 = 20;
    const r1 = 29;
    parts.push(
      strokePolyline(
        [
          [C + r0 * Math.cos(a), C + r0 * Math.sin(a)],
          [C + r1 * Math.cos(a), C + r1 * Math.sin(a)],
        ],
        4.6,
      ),
    );
  }
  return anyOf(...parts);
}

/** 打卡 = 对勾环（环是「今日」，勾是「已打卡」）。 */
function glyphCheckin() {
  return anyOf(
    strokeCircle(C, C, 26, 4.6),
    strokePolyline(
      [
        [C - 12, C + 1],
        [C - 4, C + 9.5],
        [C + 13.5, C - 10],
      ],
      6,
    ),
  );
}

/** 星门 = 拱门（进组的门）+ 门内四角星（导师匹配度的星象仪）。 */
function glyphMentor() {
  const doorW = 16;
  const doorTop = C - 6;
  const doorBottom = C + 22;
  const arch = arcPoints(C, doorTop, doorW, 180, 360, 26);
  const door = [
    [C - doorW, doorBottom],
    [C - doorW, doorTop],
    ...arch,
    [C + doorW, doorTop],
    [C + doorW, doorBottom],
  ];
  const parts = [strokePolyline(door, 4.4), strokePolyline([[C - doorW, doorBottom], [C + doorW, doorBottom]], 4.4)];

  // 四角星：外点上下左右，内点 45° 方向，填充成小实心（用细笔画交叉近似，保持线稿质感）
  const starOuter = 9;
  const starInner = 3.2;
  const sx = C;
  const sy = C - 4;
  parts.push(
    strokePolyline(
      [
        [sx, sy - starOuter],
        [sx - starInner, sy],
        [sx, sy + starOuter],
        [sx + starInner, sy],
        [sx, sy - starOuter],
      ],
      4,
    ),
  );
  return anyOf(...parts);
}

/** 名片 = 卡片矩形 + 头像块 + 两行信息条。 */
function glyphCard() {
  return anyOf(
    strokeRoundRect(9, 21, 72, 60, 8, 4.4),
    disc(23, 36.5, 6),
    strokePolyline(
      [
        [35, 33.5],
        [62, 33.5],
      ],
      4,
    ),
    strokePolyline(
      [
        [17, 52],
        [58, 52],
      ],
      4,
    ),
  );
}

const GLYPHS = {
  morning: glyphMorning,
  checkin: glyphCheckin,
  mentor: glyphMentor,
  card: glyphCard,
};

/* ------------------------------------------------------------------ */
/* 栅格化                                                             */
/* ------------------------------------------------------------------ */

function rasterize(predicate, rgb) {
  const buf = Buffer.alloc(SIZE * SIZE * 4, 0);
  const step = 1 / SS;
  for (let py = 0; py < SIZE; py += 1) {
    for (let px = 0; px < SIZE; px += 1) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        const fy = py + (sy + 0.5) * step;
        for (let sx = 0; sx < SS; sx += 1) {
          if (predicate(px + (sx + 0.5) * step, fy)) hit += 1;
        }
      }
      if (hit === 0) continue;
      const i = (py * SIZE + px) * 4;
      buf[i] = rgb[0];
      buf[i + 1] = rgb[1];
      buf[i + 2] = rgb[2];
      // 覆盖率 → alpha；单通道 PNG 无预乘问题，小程序按 src-over 合成
      buf[i + 3] = Math.round((hit / (SS * SS)) * 255);
    }
  }
  return buf;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const written = [];
  for (const [name, make] of Object.entries(GLYPHS)) {
    for (const [variant, rgb] of [
      ['', COLOR_IDLE],
      ['-active', COLOR_ACTIVE],
    ]) {
      const file = path.join(OUT_DIR, `${name}${variant}.png`);
      const png = encodePng(rasterize(make(), rgb), SIZE, SIZE);
      // 幂等：内容一致就不重写，避免无谓的 mtime 抖动
      const prev = fs.existsSync(file) ? fs.readFileSync(file) : null;
      if (!prev || !prev.equals(png)) fs.writeFileSync(file, png);
      written.push({
        file: path.relative(ROOT, file),
        bytes: png.length,
        changed: !prev || !prev.equals(png),
      });
    }
  }
  console.log(`已生成 ${written.length} 张 tabBar 图标（${SIZE}x${SIZE} RGBA）→ ${path.relative(ROOT, OUT_DIR)}`);
  for (const w of written) {
    console.log(`  ${w.file}  ${w.bytes}B${w.changed ? '  (written)' : '  (unchanged)'}`);
  }
}

main();
