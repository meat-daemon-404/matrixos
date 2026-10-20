/**
 * 星轨引力场几何计算（纯函数，无 React、无 DOM）
 *
 * 设计约束（性能是最大风险 R-T03）：
 *  - 布局在**构建期/挂载时算一次**，结果以静态 CSS 变量 + transform 输出；
 *  - 运行时动画**只用 CSS transform**（旋转/缩放走合成器），不写 requestAnimationFrame 逐帧布局；
 *  - 所以这个文件里没有任何"每帧重算"的东西，只有"每次配置变化重算一次"。
 *
 * 2.5D 的实现方式（对齐 UI_01 / UI_04 两张概念图的观感）：
 *  每个轨道是一个椭圆（不是圆），用 `squash` 压扁 Y 轴模拟俯视角；
 *  再用 `tilt` 给整个星轨平面一个轻微旋转，避免正中对称的死板。
 *  胶囊位置用**椭圆参数方程**算，角度以度为单位，0° 在正右（3 点钟方向）。
 */

import type { MicrositeStation } from './microsites.generated';

export interface OrbitRingSpec {
  /** 轨道编号 1..7 */
  readonly index: number;
  readonly label: string;
  readonly accent: string;
  /** 该轨道半径，单位 %（相对星轨容器短边的一半） */
  readonly radiusPct: number;
  /** 该轨道上挂载的微站 */
  readonly stations: readonly MicrositeStation[];
  /** 自转一圈的秒数；0 = 停转 */
  readonly rotationSeconds: number;
  /** 自转方向：1 顺时针，-1 逆时针（交错方向让画面有"引力场"感） */
  readonly direction: 1 | -1;
}

export interface CapsulePlacement {
  readonly station: MicrositeStation;
  readonly orbitIndex: number;
  /** 在父容器中的百分比坐标（左、上），已含 2.5D 压扁 */
  readonly leftPct: number;
  readonly topPct: number;
  /** 初始角度（度），0° = 正右 */
  readonly angleDeg: number;
  /** 该胶囊相对容器中心的单位方向向量，供虫洞环定位/贝塞尔连线使用 */
  readonly dir: { readonly x: number; readonly y: number };
}

/**
 * 轨道半径阶梯。内圈小、外圈大，但**不是等差**——
 * 等差会让外圈胶囊挤在边缘、内圈空荡。这里用手调的近似对数分布，
 * 并给最外层（轨道 7）留出足够边距，避免 10x 变焦时胶囊被裁切。
 */
const ORBIT_RADII_PCT = [0, 13, 21, 29.5, 38.5, 48.5, 60.5, 73] as const;

/** 自转速度阶梯：内圈快、外圈慢（开普勒式的观感，不是物理精确） */
const ORBIT_ROTATION_SECONDS = [0, 96, 122, 150, 180, 214, 250, 292] as const;

/** 2.5D 压扁系数：Y 方向的缩放比。0.44 ≈ 俯视 ~26° 的观感 */
export const ORBIT_SQUASH = 0.44;

/** 整个星轨平面的轻微倾斜（度）。正值 = 右侧下沉，模仿 UI_01 的构图 */
export const ORBIT_TILT_DEG = -7;

/**
 * 给每条轨道的首个胶囊一个相位偏移，避免所有轨道都在 0° 排成一条直线。
 * 用质数倍数生成，看起来足够"随机"但完全确定（SSR/CSR 一致，不会有 hydration 警告）。
 */
function phaseForOrbit(orbitIndex: number, stationIndex: number, total: number): number {
  const base = (orbitIndex * 37) % 360;
  const spread = total > 0 ? (360 / total) * stationIndex : 0;
  return (base + spread) % 360;
}

/** 极坐标 → 容器百分比坐标（含 2.5D 压扁） */
function polarToPercent(
  angleDeg: number,
  radiusPct: number,
): { leftPct: number; topPct: number; dir: { x: number; y: number } } {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    // 半径是相对"短边一半"的百分比；容器用 aspect-ratio 保证接近正方形，
    // 所以宽高都直接按 50% + radius 算，压扁只作用在 Y 上。
    leftPct: 50 + radiusPct * cos,
    topPct: 50 + radiusPct * sin * ORBIT_SQUASH,
    dir: { x: cos, y: sin * ORBIT_SQUASH },
  };
}

/**
 * 计算 7 条轨道与其上 18 个胶囊的静态布局。
 *
 * 传入的 stations 必须已按轨道分组（STATIONS_BY_ORBIT 的结果再摊平即可）。
 * 空轨道（没有微站）仍然返回 ring 规格 —— 视觉上保留那圈光轨，
 * 因为"7 条轨道"是产品叙事的一部分（7 站生涯闭环），不能因为某轨道暂时没站就消失。
 */
export function buildOrbitLayout(
  stations: readonly MicrositeStation[],
  orbits: readonly { readonly index: number; readonly label: string; readonly accent: string }[],
): { rings: OrbitRingSpec[]; capsules: CapsulePlacement[] } {
  const capsules: CapsulePlacement[] = [];

  const rings = orbits.map((orbit) => {
    const onThisOrbit = stations.filter((station) => station.orbitIndex === orbit.index);
    const radiusPct = ORBIT_RADII_PCT[orbit.index] ?? 20;
    const rotationSeconds = ORBIT_ROTATION_SECONDS[orbit.index] ?? 200;
    const direction: 1 | -1 = orbit.index % 2 === 0 ? -1 : 1;

    onThisOrbit.forEach((station, stationIndex) => {
      const angleDeg = phaseForOrbit(orbit.index, stationIndex, onThisOrbit.length);
      const { leftPct, topPct, dir } = polarToPercent(angleDeg, radiusPct);
      capsules.push({
        station,
        orbitIndex: orbit.index,
        leftPct,
        topPct,
        angleDeg,
        dir,
      });
    });

    return {
      index: orbit.index,
      label: orbit.label,
      accent: orbit.accent,
      radiusPct,
      stations: onThisOrbit,
      rotationSeconds,
      direction,
    };
  });

  return { rings, capsules };
}

/**
 * 语义变焦档位（Semantic Zoom 1.0x → 10.0x）。
 *
 * 每一档决定「胶囊上显示什么信息」，由 CSS 变量 `--iu-zoom` + `data-tier` 共同驱动：
 *   1.0x  只显光点（星图观感，18 个亮点）
 *   2.5x  显站名
 *   5.0x  显 UI 形态（uiStyle）
 *   7.0x+ 显实况微缩图 + 轨道名
 *
 * 档位是**离散**的：只在 zoom 跨档时改一次 data-tier，不逐帧写 DOM。
 */
export type SemanticTier = 1 | 2 | 3 | 4;

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 10;

export function semanticTier(zoom: number): SemanticTier {
  if (zoom >= 7) return 4;
  if (zoom >= 5) return 3;
  if (zoom >= 2.5) return 2;
  return 1;
}

export const SEMANTIC_TIER_LABEL: Readonly<Record<SemanticTier, string>> = {
  1: '仅光点',
  2: '站名',
  3: '站名 + UI 形态',
  4: '全信息 + 实况微缩',
};

/** 把 zoom 夹到合法区间并保留两位小数，避免浮点噪声导致重渲染。 */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return ZOOM_MIN;
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
  return Math.round(clamped * 100) / 100;
}

/**
 * 缩放要映射成**视觉**缩放，而不是直接 scale(zoom)。
 * 从 1x 到 10x 直接 scale 会让胶囊变成巨块；这里用亚线性映射：
 *   visual = 0.72 + 0.28 * zoom^0.62
 * 1x → 1.0；2.5x → 1.27；5x → 1.53；7x → 1.71；10x → 1.92
 */
export function visualScaleForZoom(zoom: number): number {
  const z = clampZoom(zoom);
  return Math.round((0.72 + 0.28 * Math.pow(z, 0.62)) * 1000) / 1000;
}
