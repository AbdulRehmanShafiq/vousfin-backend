// services/isolationForest.service.js
// Pure JavaScript Isolation Forest implementation.
// Reference: Liu, Fei Tony, Ting, Kai Ming, and Zhou, Zhi-Hua. "Isolation forest." (2008).

/**
 * Single node in an isolation tree.
 */
class IsolationNode {
  constructor({ isLeaf, size = 0, featureIdx = -1, splitVal = 0, left = null, right = null } = {}) {
    this.isLeaf = isLeaf;
    this.size = size;
    this.featureIdx = featureIdx;
    this.splitVal = splitVal;
    this.left = left;
    this.right = right;
  }
}

/**
 * A single isolation tree built from a subsample.
 */
class IsolationTree {
  constructor(maxDepth) {
    this.maxDepth = maxDepth;
    this.root = null;
  }

  fit(data) {
    this.root = this._build(data, 0);
    return this;
  }

  _build(data, depth) {
    if (depth >= this.maxDepth || data.length <= 1) {
      return new IsolationNode({ isLeaf: true, size: data.length });
    }

    const numFeatures = data[0].length;
    const featureIdx = Math.floor(Math.random() * numFeatures);

    let min = Infinity;
    let max = -Infinity;
    for (const point of data) {
      const v = point[featureIdx];
      if (v < min) min = v;
      if (v > max) max = v;
    }

    // All values identical on this feature — can't split
    if (min >= max) {
      return new IsolationNode({ isLeaf: true, size: data.length });
    }

    const splitVal = min + Math.random() * (max - min);
    const left = [];
    const right = [];
    for (const point of data) {
      (point[featureIdx] < splitVal ? left : right).push(point);
    }

    return new IsolationNode({
      isLeaf: false,
      featureIdx,
      splitVal,
      left: this._build(left, depth + 1),
      right: this._build(right, depth + 1),
    });
  }

  /**
   * Compute path length for a single point.
   * Shorter path = more isolated = more anomalous.
   */
  pathLength(point) {
    return this._traverse(point, this.root, 0);
  }

  _traverse(point, node, depth) {
    if (node === null) return depth;
    if (node.isLeaf) {
      // Add expected additional path length for the remaining subspace
      return depth + _avgPathLength(node.size);
    }
    if (point[node.featureIdx] < node.splitVal) {
      return this._traverse(point, node.left, depth + 1);
    }
    return this._traverse(point, node.right, depth + 1);
  }
}

/**
 * Expected path length of unsuccessful BST search (harmonic approximation).
 * c(n) from the original paper.
 * @param {number} n - number of samples
 */
function _avgPathLength(n) {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  // Euler-Mascheroni constant ≈ 0.5772156649
  return 2.0 * (Math.log(n - 1) + 0.5772156649) - (2.0 * (n - 1) / n);
}

/**
 * Isolation Forest anomaly detector.
 *
 * Usage:
 *   const forest = new IsolationForest({ numTrees: 100, sampleSize: 256 });
 *   forest.fit(featureMatrix);       // Array<Array<number>>
 *   const scores = forest.predict(featureMatrix); // Array<number> in [0,1]
 *   // score > 0.5 → anomalous; closer to 1.0 → more anomalous
 */
class IsolationForest {
  constructor({ numTrees = 100, sampleSize = 256 } = {}) {
    this.numTrees = numTrees;
    this.sampleSize = sampleSize;
    this.trees = [];
    this._n = 0;
  }

  /**
   * Train the forest on a feature matrix.
   * @param {Array<Array<number>>} data - each row is a feature vector
   */
  fit(data) {
    if (!data || data.length === 0) throw new Error('IsolationForest.fit: empty dataset');

    this._n = data.length;
    const effectiveSampleSize = Math.min(this.sampleSize, data.length);
    const maxDepth = Math.ceil(Math.log2(effectiveSampleSize));

    this.trees = [];
    for (let i = 0; i < this.numTrees; i++) {
      const sample = this._subsample(data, effectiveSampleSize);
      const tree = new IsolationTree(maxDepth);
      tree.fit(sample);
      this.trees.push(tree);
    }
    return this;
  }

  /**
   * Compute anomaly score for a single point.
   * @param {Array<number>} point - feature vector
   * @returns {number} score in [0, 1]; higher = more anomalous
   */
  scorePoint(point) {
    const avgPathLen =
      this.trees.reduce((sum, tree) => sum + tree.pathLength(point), 0) / this.trees.length;
    const c = _avgPathLength(this._n);
    if (c === 0) return 0.5;
    return Math.pow(2, -avgPathLen / c);
  }

  /**
   * Compute anomaly scores for all points.
   * @param {Array<Array<number>>} data
   * @returns {Array<number>}
   */
  predict(data) {
    return data.map((point) => this.scorePoint(point));
  }

  _subsample(data, size) {
    if (size >= data.length) return [...data];
    const result = new Array(size);
    // Fisher-Yates partial shuffle
    const indices = Array.from({ length: data.length }, (_, i) => i);
    for (let i = 0; i < size; i++) {
      const j = i + Math.floor(Math.random() * (data.length - i));
      [indices[i], indices[j]] = [indices[j], indices[i]];
      result[i] = data[indices[i]];
    }
    return result;
  }
}

module.exports = { IsolationForest };
