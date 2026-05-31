// services/forecasting/featureEngineering/selection.js
//
// Forecast Platform — Feature Engineering Framework. Feature selection &
// dimensionality reduction (pure).
//
//   pearson           — linear dependence
//   mutualInformation — non-linear dependence (binned estimator)
//   pca               — decorrelation / dimensionality reduction (covariance +
//                       power-iteration eigenvectors with deflation)
//   selectFeatures    — rank features against the target by MI or |corr|
//
// SHAP-based selection is delegated to the Python worker (model-specific Shapley
// values); `selectFeatures` is the in-process fallback used until that lands.
//
'use strict';

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const r4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);

/** Pearson correlation coefficient. */
function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const mx = mean(x.slice(0, n)); const my = mean(y.slice(0, n));
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx; const dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return (sxx > 0 && syy > 0) ? r4(sxy / Math.sqrt(sxx * syy)) : 0;
}

/** Equal-width bin index for a value within [min,max]. */
function _bin(v, min, max, bins) {
  if (max === min) return 0;
  let b = Math.floor(((v - min) / (max - min)) * bins);
  if (b < 0) b = 0; if (b >= bins) b = bins - 1;
  return b;
}

/** Mutual information I(X;Y) via a binned joint histogram (nats). */
function mutualInformation(x, y, bins = 5) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  const xs = x.slice(0, n); const ys = y.slice(0, n);
  const [xmin, xmax] = [Math.min(...xs), Math.max(...xs)];
  const [ymin, ymax] = [Math.min(...ys), Math.max(...ys)];
  const joint = Array.from({ length: bins }, () => Array(bins).fill(0));
  const px = Array(bins).fill(0); const py = Array(bins).fill(0);
  for (let i = 0; i < n; i++) {
    const bx = _bin(xs[i], xmin, xmax, bins); const by = _bin(ys[i], ymin, ymax, bins);
    joint[bx][by] += 1; px[bx] += 1; py[by] += 1;
  }
  let mi = 0;
  for (let i = 0; i < bins; i++) for (let j = 0; j < bins; j++) {
    if (!joint[i][j]) continue;
    const pxy = joint[i][j] / n;
    mi += pxy * Math.log(pxy / ((px[i] / n) * (py[j] / n)));
  }
  return r4(Math.max(0, mi));
}

/* ── PCA (covariance + power iteration) ──────────────────────────────────── */
function _centered(matrix) {
  const cols = matrix[0].length;
  const means = Array(cols).fill(0);
  for (const row of matrix) for (let j = 0; j < cols; j++) means[j] += row[j];
  for (let j = 0; j < cols; j++) means[j] /= matrix.length;
  return { centered: matrix.map((row) => row.map((v, j) => v - means[j])), means };
}
function _covariance(centered) {
  const n = centered.length; const d = centered[0].length;
  const C = Array.from({ length: d }, () => Array(d).fill(0));
  for (const row of centered) for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) C[i][j] += row[i] * row[j];
  const denom = Math.max(1, n - 1);
  for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) C[i][j] /= denom;
  return C;
}
function _matVec(M, v) { return M.map((row) => row.reduce((s, x, j) => s + x * v[j], 0)); }
function _norm(v) { return Math.sqrt(v.reduce((s, x) => s + x * x, 0)); }

/**
 * PCA: top-k principal components + explained variance.
 * @param {number[][]} matrix  rows = samples, cols = features
 */
function pca(matrix, k = 2, iterations = 100) {
  if (!matrix.length || !matrix[0].length) return { components: [], explainedVariance: [], means: [] };
  const d = matrix[0].length;
  const { centered, means } = _centered(matrix);
  let C = _covariance(centered);
  const totalVar = C.reduce((s, row, i) => s + row[i], 0) || 1;
  const components = []; const explained = [];
  const kk = Math.min(k, d);
  for (let c = 0; c < kk; c++) {
    let v = Array.from({ length: d }, (_, i) => (i === c ? 1 : 0.01));
    let lambda = 0;
    for (let it = 0; it < iterations; it++) {
      const Cv = _matVec(C, v);
      const nrm = _norm(Cv) || 1;
      v = Cv.map((x) => x / nrm);
      lambda = v.reduce((s, x, i) => s + x * _matVec(C, v)[i], 0);
    }
    components.push(v.map((x) => r4(x)));
    explained.push(r4(lambda / totalVar));
    // deflate: C = C − λ v vᵀ
    C = C.map((row, i) => row.map((val, j) => val - lambda * v[i] * v[j]));
  }
  return { components, explainedVariance: explained, means: means.map((m) => r4(m)) };
}

/**
 * Rank features against the target.
 * @param {Object<string,number[]>} featureColumns  name → column values
 * @param {number[]} target
 * @param {Object} opts { method: 'mi'|'correlation', topK, bins }
 */
function selectFeatures(featureColumns, target, { method = 'mi', topK = 10, bins = 5 } = {}) {
  const scored = Object.entries(featureColumns).map(([name, col]) => {
    const clean = col.map((v) => (v == null ? 0 : v));
    const score = method === 'correlation' ? Math.abs(pearson(clean, target)) : mutualInformation(clean, target, bins);
    return { name, score: r4(score), method };
  });
  scored.sort((a, b) => b.score - a.score);
  return { selected: scored.slice(0, topK), ranking: scored };
}

module.exports = { pearson, mutualInformation, pca, selectFeatures };
