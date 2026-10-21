/**
 * 微站图标与 metadata 的唯一事实源。
 *
 * 为什么单独成模块：
 *   `src/app/icon.svg` 与 `src/app/layout.tsx` 的 metadata 必须成对演进——
 *   图标有了却没人引用，或者 canonical 指回一个不存在的域名，都是线上事故。
 *   两者都从这里生成，`scripts/gen-site.mjs`（脚手架）与
 *   `scripts/gen-site-assets.mjs`（补丁器）共用同一份实现，不会各写一套然后漂移。
 *
 * 设计约束（见 docs/00-analysis/04-visual-system.md）：
 *   - 底色统一 #050814（与 orbital-hub 的 icon.svg 同源）
 *   - 只用该站 `accent`（Tailwind 500 档），靠 opacity 做层次，不发明新色
 *   - 64×64 viewBox + rx=14 圆角，与 hub 图标同规格
 *   - 每站的抽象几何草图对应它自己的 UI 形态（推子/极坐标盘/五柱/瀑布/透镜/雷达/
 *     对抗栏/看板/网格/瞄准镜/示波器/检查单/曲线坐标/章节流/声呐/天平/徽章/分岔树）
 */

/** 保留两位小数，避免生成的坐标出现一长串浮点尾巴。 */
function n(value) {
  return Math.round(value * 100) / 100;
}

/** 极坐标 → 直角坐标。angle 用度数，0° 指向右侧，顺时针为正（SVG 的 y 轴朝下）。 */
function polar(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return [n(cx + r * Math.cos(rad)), n(cy + r * Math.sin(rad))];
}

/** 把点序列拼成 path 的 d，首点 M、其余 L。 */
function polyline(points) {
  return points.map(([x, y], i) => (i === 0 ? 'M' + x + ' ' + y : 'L' + x + ' ' + y)).join(' ');
}

/** 同心多边形顶点（雷达类共用）。 */
function polygonPoints(cx, cy, r, count, startDeg) {
  const pts = [];
  for (let i = 0; i < count; i += 1) {
    pts.push(polar(cx, cy, r, startDeg + (360 / count) * i));
  }
  return pts;
}

/**
 * 11 号站的阻尼振荡波形：y = 32 - A·e^(-t/τ)·sin(ωt)。
 * 示波器的灵魂就是「一条正在衰减的荧光轨迹」，比任何图标形状都更像它自己。
 */
function dampedWave() {
  const pts = [];
  for (let x = 10; x <= 54.0001; x += 1.5) {
    const t = x - 10;
    const y = 32 - 13 * Math.exp(-t / 16) * Math.sin(t * 0.55);
    pts.push([n(x), n(y)]);
  }
  return polyline(pts);
}

/** 06 号站的五维雷达：外五边形 + 中轴 + 实测数据多边形（每维长度不同，才像“真的量过”）。 */
function radarPentagon() {
  const cx = 32;
  const cy = 33;
  const outer = polygonPoints(cx, cy, 20, 5, -90);
  const spokes = outer.map(([x, y]) => 'M' + cx + ' ' + cy + 'L' + x + ' ' + y).join(' ');
  // 五维实测值，非对称：活跃度 / H-index 斜率 / 经费 / 本科学历友好度 / 产出
  const ratios = [0.72, 0.48, 0.86, 0.5, 0.64];
  const data = ratios.map((ratio, i) => polar(cx, cy, 20 * ratio, -90 + 72 * i));
  return {
    outer: polyline([...outer, outer[0]]),
    spokes,
    data: polyline([...data, data[0]]),
    dot: data[2],
  };
}

/** 15 号站的声呐扫掠扇区：从圆心张开 58°，指示“正在扫”的方向。 */
function sonarWedge() {
  const cx = 32;
  const cy = 32;
  const r = 20;
  const [x1, y1] = polar(cx, cy, r, -90);
  const [x2, y2] = polar(cx, cy, r, -32);
  return { d: 'M' + cx + ' ' + cy + ' L' + x1 + ' ' + y1 + ' A' + r + ' ' + r + ' 0 0 1 ' + x2 + ' ' + y2 + ' Z', tip: [x2, y2] };
}

/**
 * 每站的图形定义。`body(a)` 里的 a 就是该站 accent，只允许改透明度，不允许换色。
 * `note` 是给人读的设计说明，会写进 SVG 注释——将来有人想改图标，先看到“为什么长这样”。
 */
const GLYPHS = {
  '01': {
    note: '三条推子轨 + 三个档位手柄：手柄高度差 = 不同选修课对核心 GPA 的边际贡献，底部一条配重基线。',
    body: (a) => `  <g stroke="${a}" stroke-opacity="0.32" stroke-width="1.6" stroke-linecap="round">
    <path d="M20 13V51"/>
    <path d="M32 13V51"/>
    <path d="M44 13V51"/>
  </g>
  <rect x="14.5" y="17" width="11" height="6" rx="3" fill="${a}" fill-opacity="0.9"/>
  <rect x="26.5" y="29" width="11" height="6" rx="3" fill="${a}" fill-opacity="0.62"/>
  <rect x="38.5" y="39" width="11" height="6" rx="3" fill="${a}" fill-opacity="0.4"/>
  <path d="M13 54H51" stroke="${a}" stroke-opacity="0.5" stroke-width="1.6" stroke-linecap="round"/>`,
  },

  '02': {
    note: '极坐标互补盘：两个 120° 扇区互为补角，一亮一暗 = 硬件/算法/商业的互补配对，圆心是契约交点。',
    body: (a) => `  <circle cx="32" cy="32" r="21" fill="none" stroke="${a}" stroke-opacity="0.28" stroke-width="1.4"/>
  <path d="M32 32 L32 12 A20 20 0 0 1 49.32 42 Z" fill="${a}" fill-opacity="0.62"/>
  <path d="M32 32 L32 12 A20 20 0 0 1 49.32 42 Z" fill="${a}" fill-opacity="0.14" stroke="${a}" stroke-opacity="0.8" stroke-width="1.3" transform="rotate(180 32 32)"/>
  <circle cx="32" cy="12" r="1.9" fill="${a}"/>
  <circle cx="32" cy="52" r="1.9" fill="${a}" fill-opacity="0.6"/>
  <circle cx="32" cy="32" r="3" fill="${a}"/>`,
  },

  '03': {
    note: '五柱流体压差计：五根液柱液位高低不一，上方一道虚线是劳务费红线限位阀，看得见“离超限还有多少”。',
    body: (a) => {
      const levels = [16, 25, 33, 20, 29];
      const xs = [13, 21.5, 30, 38.5, 47];
      const tracks = xs
        .map((x) => `  <rect x="${x}" y="15" width="5.5" height="37" rx="2.75" fill="${a}" fill-opacity="0.12"/>`)
        .join('\n');
      const fills = xs
        .map(
          (x, i) =>
            `  <rect x="${x}" y="${n(52 - levels[i])}" width="5.5" height="${levels[i]}" rx="2.75" fill="${a}" fill-opacity="${n(0.45 + i * 0.12)}"/>`,
        )
        .join('\n');
      return `${tracks}\n${fills}\n  <path d="M10 24H54" stroke="${a}" stroke-opacity="0.55" stroke-width="1.2" stroke-dasharray="2 3" stroke-linecap="round"/>`;
    },
  },

  '04': {
    note: '频谱瀑布流：横向频带逐层堆叠，亮度=强弱，长度=该时段能量；最亮那条是当天推送的“热卡”。',
    body: (a) => {
      const rows = [
        [14, 33, 0.3],
        [21.5, 40, 0.9],
        [29, 24, 0.45],
        [36.5, 37, 0.6],
        [44, 20, 0.32],
      ];
      return rows
        .map(
          ([y, w, op]) =>
            `  <rect x="12" y="${y}" width="${w}" height="4.6" rx="2.3" fill="${a}" fill-opacity="${op}"/>`,
        )
        .join('\n');
    },
  },

  '05': {
    note: '引力透镜：中央质量体把两条本应直行的光路掰弯，外侧虚线环是等光程圈——引文树里“开山鼻祖”对后世文献的弯折。',
    body: (a) => `  <circle cx="32" cy="32" r="17" fill="none" stroke="${a}" stroke-opacity="0.16" stroke-width="1.2" stroke-dasharray="2 3"/>
  <path d="M9 41 Q32 17 55 41" fill="none" stroke="${a}" stroke-opacity="0.7" stroke-width="1.7" stroke-linecap="round"/>
  <path d="M9 23 Q32 47 55 23" fill="none" stroke="${a}" stroke-opacity="0.45" stroke-width="1.7" stroke-linecap="round"/>
  <circle cx="32" cy="32" r="4.6" fill="${a}"/>
  <circle cx="32" cy="32" r="8" fill="none" stroke="${a}" stroke-opacity="0.35" stroke-width="1"/>
  <circle cx="49" cy="20" r="1.7" fill="${a}" fill-opacity="0.85"/>`,
  },

  '06': {
    note: '五维星象雷达：外五边形定标，五根中轴伸到顶点，内部多边形是实测画像——五个方向长度不齐才叫“画像”。',
    body: (a) => {
      const g = radarPentagon();
      return `  <path d="${g.outer}" fill="none" stroke="${a}" stroke-opacity="0.3" stroke-width="1.3"/>
  <path d="${g.spokes}" stroke="${a}" stroke-opacity="0.18" stroke-width="1"/>
  <path d="${g.data}" fill="${a}" fill-opacity="0.26" stroke="${a}" stroke-opacity="0.92" stroke-width="1.6" stroke-linejoin="round"/>
  <circle cx="${g.dot[0]}" cy="${g.dot[1]}" r="2.1" fill="${a}"/>`;
    },
  },

  '07': {
    note: '双栏对抗：左右两栏一实一虚，中间两支箭头对撞——红蓝推演就是让两种叙事在同一封套磁信里正面相撞。',
    body: (a) => `  <rect x="11" y="14" width="14" height="36" rx="2.5" fill="${a}" fill-opacity="0.22" stroke="${a}" stroke-opacity="0.5" stroke-width="1.2"/>
  <rect x="39" y="14" width="14" height="36" rx="2.5" fill="${a}" fill-opacity="0.08" stroke="${a}" stroke-opacity="0.42" stroke-width="1.2" stroke-dasharray="3 2.5"/>
  <path d="M25 25 L32 32 L25 39" fill="none" stroke="${a}" stroke-opacity="0.95" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M39 25 L32 32 L39 39" fill="none" stroke="${a}" stroke-opacity="0.95" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="32" cy="32" r="1.6" fill="${a}"/>`,
  },

  '08': {
    note: '任务控制看板：三条泳道（已发信→已读→待面试），卡片亮暗表示状态推进，顶部导轨是任务时间线。',
    body: (a) => {
      const lanes = [11, 26, 41];
      const cards = [
        [14, 18, 0.85],
        [14, 29, 0.5],
        [29, 18, 0.5],
        [29, 29, 0.85],
        [44, 18, 0.32],
      ];
      return (
        `  <path d="M11 11.5H53" stroke="${a}" stroke-opacity="0.3" stroke-width="1.2" stroke-linecap="round"/>\n` +
        `  <circle cx="50" cy="11.5" r="1.6" fill="${a}"/>\n` +
        lanes
          .map(
            (x) =>
              `  <rect x="${x}" y="16" width="12" height="36" rx="2.4" fill="${a}" fill-opacity="0.06" stroke="${a}" stroke-opacity="0.22" stroke-width="1"/>`,
          )
          .join('\n') +
        '\n' +
        cards
          .map(
            ([x, y, op]) =>
              `  <rect x="${x + 3}" y="${y}" width="6" height="7" rx="1.4" fill="${a}" fill-opacity="${op}"/>`,
          )
          .join('\n')
      );
    },
  },

  '09': {
    note: '对比网格：3×3 矩阵里一格被点亮（正在对比的参量），一束激光从这一格射向右上角，指回 PDF 原文坐标。',
    body: (a) => `  <g stroke="${a}" stroke-opacity="0.3" stroke-width="1.2">
    <rect x="13" y="13" width="38" height="38" rx="2.5" fill="none"/>
    <path d="M25.67 13V51"/>
    <path d="M38.33 13V51"/>
    <path d="M13 25.67H51"/>
    <path d="M13 38.33H51"/>
  </g>
  <rect x="25.67" y="25.67" width="12.66" height="12.66" fill="${a}" fill-opacity="0.5"/>
  <path d="M32 32 L55 17" stroke="${a}" stroke-opacity="0.95" stroke-width="1.8" stroke-linecap="round"/>
  <circle cx="55" cy="17" r="2.3" fill="${a}"/>`,
  },

  '10': {
    note: '光学瞄准：双栏页面做底（虚影），十字分划与同心环压在中间——锁定的是文内那一行公式，不是整页。',
    body: (a) => `  <rect x="11" y="15" width="14" height="34" rx="1.6" fill="${a}" fill-opacity="0.1"/>
  <rect x="39" y="15" width="14" height="34" rx="1.6" fill="${a}" fill-opacity="0.06"/>
  <circle cx="32" cy="32" r="14" fill="none" stroke="${a}" stroke-opacity="0.55" stroke-width="1.4"/>
  <circle cx="32" cy="32" r="6" fill="none" stroke="${a}" stroke-opacity="0.32" stroke-width="1.1"/>
  <path d="M32 12V26M32 38V52M12 32H26M38 32H52" stroke="${a}" stroke-opacity="0.9" stroke-width="1.5" stroke-linecap="round"/>
  <circle cx="32" cy="32" r="1.9" fill="${a}"/>`,
  },

  '11': {
    note: '荧光示波器：一条双指数衰减的阻尼振荡轨迹（y=32−13e^(−t/16)sin0.55t），外面套一层低透明度同形描边做荧光余辉。',
    body: (a) => {
      const d = dampedWave();
      return `  <g stroke="${a}" stroke-opacity="0.12" stroke-width="1">
    <path d="M14 14V50"/>
    <path d="M26 14V50"/>
    <path d="M38 14V50"/>
    <path d="M50 14V50"/>
    <path d="M10 20H54"/>
    <path d="M10 32H54"/>
    <path d="M10 44H54"/>
  </g>
  <path d="${d}" fill="none" stroke="${a}" stroke-opacity="0.18" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="${d}" fill="none" stroke="${a}" stroke-opacity="0.95" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>`;
    },
  },

  '12': {
    note: '飞行前检查单：一张清单纸，四行条目，前两项已打勾（环境/种子过了），后两项待核——复现核验就是这个动作。',
    body: (a) => `  <rect x="14" y="11" width="36" height="42" rx="3" fill="${a}" fill-opacity="0.07" stroke="${a}" stroke-opacity="0.35" stroke-width="1.2"/>
  <rect x="19" y="17" width="4.6" height="4.6" rx="1.1" fill="${a}" fill-opacity="0.9"/>
  <rect x="19" y="26" width="4.6" height="4.6" rx="1.1" fill="${a}" fill-opacity="0.9"/>
  <rect x="19" y="35" width="4.6" height="4.6" rx="1.1" fill="none" stroke="${a}" stroke-opacity="0.5" stroke-width="1.1"/>
  <rect x="19" y="44" width="4.6" height="4.6" rx="1.1" fill="none" stroke="${a}" stroke-opacity="0.5" stroke-width="1.1"/>
  <path d="M19.9 19.3 L21.5 21.1 L23.1 17.9" fill="none" stroke="#050814" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M19.9 28.3 L21.5 30.1 L23.1 26.9" fill="none" stroke="#050814" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
  <g stroke="${a}" stroke-linecap="round">
    <path d="M28 19.3H44" stroke-opacity="0.7" stroke-width="1.7"/>
    <path d="M28 28.3H41" stroke-opacity="0.6" stroke-width="1.7"/>
    <path d="M28 37.3H44" stroke-opacity="0.3" stroke-width="1.7"/>
    <path d="M28 46.3H38" stroke-opacity="0.3" stroke-width="1.7"/>
  </g>`,
  },

  '13': {
    note: '暗房调色台：坐标轴 + 三条叠放的曲线（主线亮、两条参考线暗）= 同一组数据按出版规范调成不同矢量图层。',
    body: (a) => `  <path d="M13 15V51H53" fill="none" stroke="${a}" stroke-opacity="0.4" stroke-width="1.4" stroke-linecap="round"/>
  <path d="M15 45 C24 20 33 42 51 19" fill="none" stroke="${a}" stroke-opacity="0.28" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M15 48 C26 35 34 47 51 33" fill="none" stroke="${a}" stroke-opacity="0.18" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M15 41 C25 28 32 37 51 25" fill="none" stroke="${a}" stroke-opacity="0.95" stroke-width="2" stroke-linecap="round"/>
  <circle cx="51" cy="25" r="2" fill="${a}"/>`,
  },

  '14': {
    note: '章节逻辑流：一根竖向主轴（综述主线），三个宽度递减的章节块挂在轴上，宽度=该章承担的篇幅权重。',
    body: (a) => `  <path d="M19 11V53" stroke="${a}" stroke-opacity="0.55" stroke-width="1.5" stroke-linecap="round"/>
  <circle cx="19" cy="18" r="2" fill="${a}"/>
  <circle cx="19" cy="31" r="2" fill="${a}" fill-opacity="0.7"/>
  <circle cx="19" cy="44" r="2" fill="${a}" fill-opacity="0.5"/>
  <rect x="24" y="14.5" width="27" height="7" rx="2" fill="${a}" fill-opacity="0.42"/>
  <rect x="24" y="27.5" width="21" height="7" rx="2" fill="${a}" fill-opacity="0.28"/>
  <rect x="24" y="40.5" width="15" height="7" rx="2" fill="${a}" fill-opacity="0.18"/>`,
  },

  '15': {
    note: '360° 声呐盘：三层同心测距环 + 八向方位线，亮扇区是正在扫掠的那一格，最亮的点=命中的撤稿/勘误引文。',
    body: (a) => {
      const w = sonarWedge();
      return `  <g fill="none" stroke="${a}" stroke-opacity="0.2" stroke-width="1.1">
    <circle cx="32" cy="32" r="9"/>
    <circle cx="32" cy="32" r="14.5"/>
    <circle cx="32" cy="32" r="20"/>
  </g>
  <path d="${w.d}" fill="${a}" fill-opacity="0.28"/>
  <path d="M32 12V20M32 44V52M12 32H20M44 32H52" stroke="${a}" stroke-opacity="0.35" stroke-width="1.2" stroke-linecap="round"/>
  <circle cx="${w.tip[0]}" cy="${w.tip[1]}" r="1.7" fill="${a}" fill-opacity="0.9"/>
  <circle cx="41" cy="24" r="2.4" fill="${a}"/>
  <circle cx="32" cy="32" r="1.5" fill="${a}" fill-opacity="0.8"/>`;
    },
  },

  '16': {
    note: '三盘电子天平：顶部三角支点 + 横梁，三只盘挂在梁上、深浅不同=论文/软著/竞赛三类加分项的配重。',
    body: (a) => `  <path d="M32 11 L36.5 20.5 L27.5 20.5 Z" fill="${a}" fill-opacity="0.6"/>
  <path d="M22 21.5H42" stroke="${a}" stroke-opacity="0.35" stroke-width="0"/>
  <path d="M12 22H52" stroke="${a}" stroke-opacity="0.8" stroke-width="1.9" stroke-linecap="round"/>
  <g stroke="${a}" stroke-opacity="0.4" stroke-width="1.1">
    <path d="M18 22.5V31"/>
    <path d="M32 22.5V37"/>
    <path d="M46 22.5V31"/>
  </g>
  <path d="M12 31 Q18 39 24 31" fill="${a}" fill-opacity="0.28" stroke="${a}" stroke-opacity="0.85" stroke-width="1.4" stroke-linejoin="round"/>
  <path d="M26 37 Q32 45 38 37" fill="${a}" fill-opacity="0.42" stroke="${a}" stroke-opacity="0.95" stroke-width="1.4" stroke-linejoin="round"/>
  <path d="M40 31 Q46 39 52 31" fill="${a}" fill-opacity="0.2" stroke="${a}" stroke-opacity="0.7" stroke-width="1.4" stroke-linejoin="round"/>`,
  },

  '17': {
    note: '验真徽章：盾形徽章 + 对勾（每条简历证据可点开验真），盾的缺口暗示“锚点非空才能结案”。',
    body: (a) => `  <path d="M32 10 L48 16.5 V31 C48 41 40.5 49 32 53.5 C23.5 49 16 41 16 31 V16.5 Z" fill="${a}" fill-opacity="0.14" stroke="${a}" stroke-opacity="0.8" stroke-width="1.6" stroke-linejoin="round"/>
  <path d="M23.5 31.5 L29.5 37.5 L41 24.5" fill="none" stroke="${a}" stroke-opacity="0.98" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="32" cy="10" r="1.9" fill="${a}"/>`,
  },

  '18': {
    note: '分岔概率树：从根部一分二、二分四，节点越深越淡=概率越低；叶子端点=保研直博/选调/大厂三条路的期望值。',
    body: (a) => `  <g fill="none" stroke="${a}" stroke-linecap="round">
    <path d="M32 53V42" stroke-opacity="0.85" stroke-width="2"/>
    <path d="M32 42 L20 33" stroke-opacity="0.7" stroke-width="1.8"/>
    <path d="M32 42 L44 33" stroke-opacity="0.7" stroke-width="1.8"/>
    <path d="M20 33 L13 24" stroke-opacity="0.5" stroke-width="1.5"/>
    <path d="M20 33 L27 24" stroke-opacity="0.5" stroke-width="1.5"/>
    <path d="M44 33 L37 24" stroke-opacity="0.5" stroke-width="1.5"/>
    <path d="M44 33 L51 24" stroke-opacity="0.5" stroke-width="1.5"/>
  </g>
  <circle cx="32" cy="42" r="2.6" fill="${a}"/>
  <circle cx="20" cy="33" r="2.1" fill="${a}" fill-opacity="0.85"/>
  <circle cx="44" cy="33" r="2.1" fill="${a}" fill-opacity="0.85"/>
  <circle cx="13" cy="24" r="1.6" fill="${a}" fill-opacity="0.6"/>
  <circle cx="27" cy="24" r="1.6" fill="${a}" fill-opacity="0.5"/>
  <circle cx="37" cy="24" r="1.6" fill="${a}" fill-opacity="0.5"/>
  <circle cx="51" cy="24" r="1.6" fill="${a}" fill-opacity="0.6"/>
  <circle cx="32" cy="53" r="2.2" fill="none" stroke="${a}" stroke-opacity="0.8" stroke-width="1.4"/>`,
  },
};

/** 有图形定义的站号（用于生成前自检，防止花名册加了站而图标漏掉）。 */
export const ICON_IDS = Object.keys(GLYPHS).sort();

/**
 * 生成单站的 `src/app/icon.svg`。
 * @param {{ id: string, name: string, accent: string, uiStyle: string, domain: string }} station
 */
export function renderIconSvg(station) {
  const glyph = GLYPHS[station.id];
  if (!glyph) throw new Error('缺少图标定义：id=' + station.id + '（在 scripts/site-icons.mjs 的 GLYPHS 里补一条）');
  const accent = station.accent;
  if (!/^#[0-9a-f]{6}$/i.test(accent)) throw new Error('accent 不是 6 位十六进制：' + accent);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <!-- MatrixOS 站点图标 · ${station.id} ${station.name} -->
  <!-- ${station.domain} · UI 形态：${station.uiStyle} -->
  <!-- 设计说明：${glyph.note} -->
  <!-- 由 scripts/site-icons.mjs 生成，勿手改（改这里 → node scripts/gen-site-assets.mjs） -->
  <rect width="64" height="64" rx="14" fill="#050814"/>
${glyph.body(accent)}
</svg>
`;
}

/**
 * `src/app/layout.tsx` 的 metadata 段（含 SITE_ORIGIN 常量）。
 *
 * canonical 为什么用 `mx-<appId>.matrixos.cc.cd`：
 *   2026-10-21 账号迁移完成后，18 个微站的生产入口是自有域名的二级域名
 *   `https://mx-<appId>.matrixos.cc.cd`（19/19 实测 HTTP 200）。
 *   旧的 `mx-<appId>.pages.dev` 仍属于**旧账号**，新账号里同名项目被 Cloudflare
 *   自动改名成 `mx-<appId>-<hash>.pages.dev`，那个 hash 不可预测、也不该写进产物。
 *
 *   canonical 的作用是告诉爬虫「这个内容的正式地址」，必须指向真实可解析的生产入口，
 *   否则等于自报死链。域名若再变，只改这里一行 + 重跑 gen-site。
 */
export const PROD_SITE_ORIGIN_TEMPLATE =
  process.env.MATRIXOS_SITE_ORIGIN_TEMPLATE ?? "https://mx-' + SITE.appId + '.matrixos.cc.cd";

export function renderMetadataBlock() {
  return `const SITE_ORIGIN = '${PROD_SITE_ORIGIN_TEMPLATE}';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: SITE.name + ' · MatrixOS',
  description: SITE.desc,
  applicationName: 'MatrixOS',
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml', sizes: 'any' }],
  },
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    locale: 'zh_CN',
    url: SITE_ORIGIN,
    siteName: SITE.name,
    title: SITE.name + ' · MatrixOS',
    description: SITE.desc,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  other: {
    'matrixos:station-id': SITE.id,
    'matrixos:orbit': SITE.orbitName,
  },
};`;
}

/** 补丁定位锚点：metadata 段从这里开始（已打过补丁的文件则从 SITE_ORIGIN 开始）。 */
export const ORIGIN_ANCHOR = 'const SITE_ORIGIN = ';
export const METADATA_ANCHOR = 'export const metadata: Metadata = {';

/**
 * 遗留生成器 `scripts/upgrade-metadata.mjs`（已删除，被本模块取代）
 * 曾在 layout.tsx 里留下的行。补丁必须能吃掉它们，否则残留永远清不掉。
 */
const LEGACY_LINE_RES = [
  /^\/\/ MATRIXOS_METADATA_V2/,
  /^\/\/ 生产 URL 通过 MATRIXOS_PUBLIC_BASE 控制/,
  /^const PUBLIC_URL = ['"][^'"]*['"];$/,
];

/**
 * 从 metadata 段的起点向上回溯，吃掉紧邻其上的遗留残留行及其间空行。
 * 返回新的起点；没有残留时原样返回——对已规范的文件是无操作。
 *
 * 为什么必须回溯：遗留生成器把 `const PUBLIC_URL = ...;` 插在
 * `const SITE_ORIGIN = ...;` **之上**，而补丁的起点锚正是 SITE_ORIGIN。
 * 只从锚点开始替换就永远够不到上一行，残留会一直留在盘上，
 * `gen-site-assets.mjs --check` 于是报「已就位」= 假绿。
 */
function absorbLegacyRemnantAbove(source, startIdx) {
  let idx = startIdx;
  for (;;) {
    // 跳过起点前的换行（含残留行之间的空行），再看上一行究竟是什么
    let lineEnd = idx;
    while (lineEnd > 0 && source[lineEnd - 1] === '\n') lineEnd -= 1;
    const lineStart = source.lastIndexOf('\n', lineEnd - 1) + 1;
    const line = source.slice(lineStart, lineEnd).trim();
    if (line !== '' && LEGACY_LINE_RES.some((re) => re.test(line))) {
      idx = lineStart;
      continue;
    }
    return idx; // 上一行不是残留（或已到文件头），到此为止
  }
}

/**
 * 从 `export const metadata: Metadata = {` 的 `{` 起做括号配对，返回对象真正
 * 结束的 `}` 的下标；找不到时返回 -1。
 *
 * 为什么不能再用 `source.indexOf('\n};', metaIdx)`：那是**文本前缀**匹配，
 * 任何嵌套对象只要其闭合花括号落在第 0 列，就会出现一个更早的 `\n};`，
 * 于是 metadata 被从中间截断——后半段（title 等）被留在文件里变成悬空代码。
 * 括号配对不受缩进/排版影响，是这里唯一可靠的边界判定。
 */
function findMetadataObjectEnd(source, metaIdx) {
  const braceStart = source.indexOf('{', metaIdx);
  if (braceStart === -1) return -1;
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1; // `}` 之后一位（不含分号）
    }
  }
  return -1;
}

/**
 * 把 layout.tsx 源码里的 metadata 段整体替换为最新版本。
 * 只动这一段，文件头注释 / import / viewport / 组件体一律不碰。
 *
 * 三处必须成立，否则 `gen-site-assets.mjs --check` 会假绿：
 *   1. 起点要**上溯**吃掉遗留残留（`PUBLIC_URL` 行 + `MATRIXOS_METADATA_V2` 注释）；
 *   2. 结束边界要用**括号配对**而非文本前缀——`'\n};'` 是 `'\n};;'` 的前缀，
 *      只吃掉前三字符时替换后仍剩一个孤立 `;`，文本与原文逐字节相同，
 *      于是 `changed` 为 false，补丁对瑕疵完全无感；
 *   3. `}` 后若还挂着多余分号（`};;`）一并吃掉，输出恒为规范的 `};`。
 * @returns {{ source: string, changed: boolean, error?: string }}
 */
export function patchLayoutMetadata(source) {
  const block = renderMetadataBlock();
  const metaIdx = source.indexOf(METADATA_ANCHOR);
  if (metaIdx === -1) {
    return { source, changed: false, error: '找不到 `' + METADATA_ANCHOR + '`' };
  }
  const objEnd = findMetadataObjectEnd(source, metaIdx);
  if (objEnd === -1) {
    return { source, changed: false, error: 'metadata 对象的括号未闭合' };
  }
  // `}` 之后若还挂着多余分号（`};` 一个 / `};;` 两个）全部吃掉，
  // 后接的换行原样保留——输出恒为规范 `};`，且不扰动文件其余排版
  let end = objEnd;
  while (source[end] === ';') end += 1;

  const originIdx = source.indexOf(ORIGIN_ANCHOR);
  const anchorIdx = originIdx !== -1 && originIdx < metaIdx ? originIdx : metaIdx;
  const startIdx = absorbLegacyRemnantAbove(source, anchorIdx);

  const next = source.slice(0, startIdx) + block + source.slice(end);
  return { source: next, changed: next !== source };
}
