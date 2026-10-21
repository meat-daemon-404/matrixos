// 探针：调噪声参数 / 检查 BIC 选型与参数恢复
import { curvelabPoints, PAPER_ROWS } from '@matrixos/microsite-data';
import { makeDemoSeries } from '@matrixos/instrument-ui';

const TAU_GRID = Array.from({ length: 20 }, (_, i) => 0.05 * (12 / 0.05) ** (i / 19));
const CENTER_GRID = Array.from({ length: 13 }, (_, i) => (10 * i) / 12);

function ssTot(points) {
  const mean = points.reduce((s, p) => s + p.y, 0) / points.length;
  return points.reduce((s, p) => s + (p.y - mean) ** 2, 0);
}
function ssRes(points, predict) {
  return points.reduce((s, p) => {
    const r = p.y - predict(p.x);
    return s + (Number.isFinite(r) ? r * r : Infinity);
  }, 0);
}
function solve(matrix, rhs) {
  const n = rhs.length;
  const rows = matrix.map((r, i) => [...r, rhs[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(rows[r][c]) > Math.abs(rows[p][c])) p = r;
    [rows[p], rows[c]] = [rows[c], rows[p]];
    const pv = rows[c][c];
    if (!Number.isFinite(pv) || Math.abs(pv) < 1e-12) return null;
    for (let r = c + 1; r < n; r++) {
      const f = rows[r][c] / pv;
      for (let i = c; i <= n; i++) rows[r][i] -= f * rows[c][i];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let acc = rows[r][n];
    for (let c = r + 1; c < n; c++) acc -= rows[r][c] * x[c];
    x[r] = acc / rows[r][r];
  }
  return x.every(Number.isFinite) ? x : null;
}
function fitBasis(points, basis) {
  const k = basis.length;
  if (points.length <= k) return null;
  const gram = Array.from({ length: k }, () => new Array(k).fill(0));
  const rhs = new Array(k).fill(0);
  for (const p of points) {
    const v = basis.map((b) => b(p.x));
    for (let i = 0; i < k; i++) {
      rhs[i] += v[i] * p.y;
      for (let j = i; j < k; j++) gram[i][j] += v[i] * v[j];
    }
  }
  for (let i = 0; i < k; i++) for (let j = 0; j < i; j++) gram[i][j] = gram[j][i];
  const coef = solve(gram, rhs);
  if (!coef) return null;
  const predict = (x) => basis.reduce((s, b, i) => s + coef[i] * b(x), 0);
  const res = ssRes(points, predict);
  if (!Number.isFinite(res) || res <= 0) return null;
  return { coef, ssRes: res, predict };
}
function fitAmp(points, shape) {
  let sq = 0, sy = 0;
  for (const p of points) { const v = shape(p.x); if (!Number.isFinite(v)) return null; sq += v * v; sy += v * p.y; }
  if (Math.abs(sq) < 1e-12) return null;
  const A = sy / sq;
  const predict = (x) => A * shape(x);
  const res = ssRes(points, predict);
  if (!Number.isFinite(res) || res <= 0) return null;
  return { A, ssRes: res, predict };
}
function geom(lo, hi, n) { return Array.from({ length: n }, (_, i) => lo * (hi / lo) ** (i / (n - 1))); }
function erf(x) {
  const s = x < 0 ? -1 : 1, ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return s * (1 - poly * Math.exp(-ax * ax));
}

function polyModel(d) {
  return { id: `poly${d}`, label: d === 1 ? '一次多项式（线性）' : `${d} 次多项式`, k: d + 1, fit(points) {
    const basis = Array.from({ length: d + 1 }, (_, i) => (x) => x ** i);
    const s = fitBasis(points, basis);
    if (!s) return null;
    const params = {}; s.coef.forEach((v, i) => (params[`c${i}`] = v));
    return { params, ssRes: s.ssRes, predict: s.predict };
  } };
}

// 峰形 + 基线（线性基线 y0 + slope*x）
function peakWithBaseline(id, label, shapeOf) {
  return { id, label, k: 4, fit(points) {
    let best = null;
    for (const center of CENTER_GRID) {
      for (const width of geom(0.08, 8, 12)) {
        const s = fitBasis(points, [(x) => 1, (x) => x, (x) => shapeOf(x, center, width)]);
        if (!s) continue;
        if (!best || s.ssRes < best.ssRes) best = { params: { y0: s.coef[0], slope: s.coef[1], A: s.coef[2], center, width }, ssRes: s.ssRes, predict: s.predict };
      }
    }
    return best;
  } };
}

const MODELS = [
  polyModel(1), polyModel(2), polyModel(3), polyModel(4), polyModel(5), polyModel(6),
  { id: 'exp_decay1', label: '单指数衰减', k: 2, fit(points) {
    let best = null;
    for (const tau of TAU_GRID) {
      const f = fitAmp(points, (x) => Math.exp(-x / tau));
      if (!f) continue;
      if (!best || f.ssRes < best.ssRes) best = { params: { A: f.A, tau }, ssRes: f.ssRes, predict: f.predict };
    }
    return best;
  } },
  { id: 'exp_decay2', label: '双指数衰减', k: 4, fit(points) {
    let best = null;
    for (const t1 of TAU_GRID) for (const t2 of TAU_GRID) {
      if (t2 < t1 * 1.8) continue;
      const s = fitBasis(points, [(x) => Math.exp(-x / t1), (x) => Math.exp(-x / t2)]);
      if (!s) continue;
      if (!best || s.ssRes < best.ssRes) best = { params: { A1: s.coef[0], tau1: t1, A2: s.coef[1], tau2: t2 }, ssRes: s.ssRes, predict: s.predict };
    }
    return best;
  } },
  { id: 'exp_decay2_base', label: '双指数衰减+基线', k: 5, fit(points) {
    let best = null;
    for (const t1 of TAU_GRID) for (const t2 of TAU_GRID) {
      if (t2 < t1 * 1.8) continue;
      const s = fitBasis(points, [(x) => 1, (x) => Math.exp(-x / t1), (x) => Math.exp(-x / t2)]);
      if (!s) continue;
      if (!best || s.ssRes < best.ssRes) best = { params: { y0: s.coef[0], A1: s.coef[1], tau1: t1, A2: s.coef[2], tau2: t2 }, ssRes: s.ssRes, predict: s.predict };
    }
    return best;
  } },
  { id: 'lorentzian', label: '洛伦兹峰', k: 3, fit(points) {
    let best = null;
    for (const c of CENTER_GRID) for (const g of geom(0.08, 8, 12)) {
      const f = fitAmp(points, (x) => 1 / (1 + ((x - c) / g) ** 2));
      if (!f) continue;
      if (!best || f.ssRes < best.ssRes) best = { params: { A: f.A, center: c, gamma: g }, ssRes: f.ssRes, predict: f.predict };
    }
    return best;
  } },
  peakWithBaseline('lorentzian_base', '洛伦兹峰+基线', (x, c, w) => 1 / (1 + ((x - c) / w) ** 2)),
  { id: 'gaussian', label: '高斯峰', k: 3, fit(points) {
    let best = null;
    for (const c of CENTER_GRID) for (const s0 of geom(0.08, 8, 12)) {
      const f = fitAmp(points, (x) => Math.exp(-((x - c) ** 2) / (2 * s0 * s0)));
      if (!f) continue;
      if (!best || f.ssRes < best.ssRes) best = { params: { A: f.A, center: c, sigma: s0 }, ssRes: f.ssRes, predict: f.predict };
    }
    return best;
  } },
  peakWithBaseline('gaussian_base', '高斯峰+基线', (x, c, w) => Math.exp(-((x - c) ** 2) / (2 * w * w))),
  { id: 'linear', label: '线性(直)', k: 2, fit(points) {
    const s = fitBasis(points, [(x) => 1, (x) => x]);
    if (!s) return null;
    return { params: { c0: s.coef[0], c1: s.coef[1] }, ssRes: s.ssRes, predict: s.predict };
  } },
];

function select(points) {
  const n = points.length;
  const tot = ssTot(points);
  const scored = [];
  for (const m of MODELS) {
    const f = m.fit(points);
    if (!f || !Number.isFinite(f.ssRes) || f.ssRes <= 0) continue;
    const r2 = 1 - f.ssRes / tot;
    const bic = n * Math.log(f.ssRes / n) + m.k * Math.log(n);
    scored.push({ id: m.id, label: m.label, k: m.k, r2, bic, params: f.params });
  }
  scored.sort((a, b) => a.bic - b.bic);
  return scored;
}

function report(name, points) {
  const s = select(points);
  console.log(`\n### ${name} (n=${points.length})`);
  s.slice(0, 3).forEach((m, i) => {
    console.log(`  ${i === 0 ? '★' : ' '} ${m.label.padEnd(14)} k=${m.k} R²=${m.r2.toFixed(4)} BIC=${m.bic.toFixed(2)}  ${JSON.stringify(Object.fromEntries(Object.entries(m.params).map(([k, v]) => [k, +v.toFixed(4)])))}`);
  });
}

console.log('=== TRPL noise sweep ===');
for (const noise of [0.05, 0.1, 0.2]) {
  report(`TRPL noise=${noise} n=180`, curvelabPoints(180, 20261020, noise));
}

console.log('\n=== PL peak: xMin=1.45 xMax=3.25, noise sweep ===');
for (const noise of [0.05, 0.1, 0.2]) {
  report(`PL peak noise=${noise}`, makeDemoSeries({ model: 'lorentz', count: 200, seed: 20261022, noise, xMin: 1.45, xMax: 3.25 }));
}

console.log('\n=== calibration linear: noise sweep ===');
for (const noise of [0.02, 0.05, 0.1, 0.2]) {
  report(`calib noise=${noise} n=120`, makeDemoSeries({ model: 'linear', count: 120, seed: 20261023, noise }));
}
