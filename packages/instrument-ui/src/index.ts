/**
 * @matrixos/instrument-ui · 统一导出
 *
 * 全部组件都是**受控展示组件**（ADR-07）：props in / events out，
 * 不含数据获取、不订阅全局状态。数据与持久化由调用方负责。
 *
 * 分族（对齐 WBS S3-01~04 的四大仪器族）：
 *   旋钮族  DampedKnob
 *   图表族  OscilloscopeCanvas
 *   雷达族  SonarDisc · StarOrbit · WormholeRing
 *   天平族  PrecisionBalance · FluidGaugeBank
 *   其他    EvidenceLink · CopilotWaveDock · TaskKanban
 */

/* ---------------- 旋钮族 ---------------- */
export { DampedKnob } from './components/DampedKnob';
export type { DampedKnobProps } from './components/DampedKnob';

/* ---------------- 图表族 ---------------- */
export { OscilloscopeCanvas } from './components/OscilloscopeCanvas';
export type {
  OscilloscopeCanvasProps,
  ScatterPoint,
  FitModelKind,
} from './components/OscilloscopeCanvas';

/* ---------------- 雷达族 ---------------- */
export { SonarDisc, SONAR_RISK_LABEL } from './components/SonarDisc';
export type { SonarDiscProps, SonarBlip, SonarRiskLevel } from './components/SonarDisc';

export {
  StarOrbit,
  SEMANTIC_ZOOM_TIERS,
  ORBIT_STATE_LABEL,
} from './components/StarOrbit';
export type {
  StarOrbitProps,
  StarOrbitStation,
  OrbitStationState,
  OrbitStationPreview,
} from './components/StarOrbit';

export { WormholeRing, WORMHOLE_STATE_TEXT } from './components/WormholeRing';
export type {
  WormholeRingProps,
  WormholeTarget,
  WormholeRingState,
} from './components/WormholeRing';

/* ---------------- 天平族 ---------------- */
export { PrecisionBalance, BALANCE_PAN_ACCENTS } from './components/PrecisionBalance';
export type {
  PrecisionBalanceProps,
  BalancePan,
  BalanceWeight,
} from './components/PrecisionBalance';

export { FluidGaugeBank } from './components/FluidGaugeBank';
export type { FluidGaugeBankProps, GaugeColumn } from './components/FluidGaugeBank';

/* ---------------- 其他仪器 ---------------- */
export { EvidenceLink, EVIDENCE_VERIFICATION_TONE } from './components/EvidenceLink';
export type {
  EvidenceLinkProps,
  EvidenceAnchor,
  EvidenceBbox,
  EvidenceLinkSize,
  VerificationLevel,
} from './components/EvidenceLink';

export { CopilotWaveDock, COPILOT_STATE_TEXT } from './components/CopilotWaveDock';
export type { CopilotWaveDockProps, CopilotState } from './components/CopilotWaveDock';

export { TaskKanban } from './components/TaskKanban';
export type {
  TaskKanbanProps,
  KanbanColumn,
  KanbanTask,
} from './components/TaskKanban';

/* ---------------- 设计令牌与工具 ---------------- */
export {
  ACCENTS,
  TONE_TO_ACCENT,
  accentStyle,
  toneAccent,
  resolveAccent,
} from './lib/accent';
export type {
  InstrumentAccent,
  InstrumentTone,
  InstrumentSize,
} from './lib/accent';

export {
  contrastRatio,
  relativeLuminance,
  wcagLevel,
  worstContrast,
  pickReadable,
  hexToRgb,
  SURFACES,
  SURFACE_LIST,
} from './lib/contrast';
export type { HexColor, WcagLevel } from './lib/contrast';

export {
  usePrefersReducedMotion,
  useControllableState,
  useElementSize,
  useDevicePixelRatio,
  useMounted,
  useUid,
} from './lib/hooks';

export { useDialDrag } from './lib/useDialDrag';
export type { UseDialDragOptions, DialDragHandlers, DragState } from './lib/useDialDrag';

export {
  clamp,
  normalize,
  mapRange,
  linearMap,
  lerp,
  roundTo,
  decimalsOf,
  snapToStep,
  formatFixed,
  formatSigned,
  formatCompact,
  polarToCartesian,
  ellipsePoint,
  arcPath,
  niceTicks,
  niceDomain,
  normalizeAngle,
  distributeEvenly,
  downsample,
  isFiniteNumber,
} from './lib/math';

export {
  linearRegression,
  confidenceHalfWidth,
  tQuantile,
  inverseNormalCdf,
  meanAndSxx,
  residuals,
  createRandom,
  gaussian,
  biExponential,
  lorentzian,
  makeDemoSeries,
} from './lib/stats';
export type { LinearFit } from './lib/stats';

export { cx } from './lib/cx';
export type { ClassValue } from './lib/cx';

/* ---------------- 版本 ---------------- */
export const INSTRUMENT_UI_VERSION = '0.5.0';
