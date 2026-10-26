// Turns cosine similarity into a 0–100 proximity score.
//
// Calibrated on the GloVe-100 model with sample pairs (see
// scripts/calibrate.js). Reference points for a typical answer:
//   unrelated words (median of vocabulary)  cos ≈ 0.03 → ~2
//   loosely related (top 10% of vocabulary) cos ≈ 0.23 → ~24
//   top 1,000 neighbours                    cos ≈ 0.37 → ~43
//   top 100 neighbours                      cos ≈ 0.52 → ~64
//   top 10 neighbours                       cos ≈ 0.67 → ~82
//   near-synonyms (ocean/sea, dog/cat)      cos ≈ 0.84 → ~95
// 100 is reserved for the exact answer; everything else is capped at 99.
const ANCHORS = [
  [0.0, 0],
  [0.1, 8],
  [0.2, 20],
  [0.35, 40],
  [0.5, 62],
  [0.65, 80],
  [0.8, 93],
  [0.92, 99],
];

function cosineToScore(cos) {
  if (!Number.isFinite(cos)) throw new Error('invalid similarity');
  if (cos <= ANCHORS[0][0]) return 0;
  for (let i = 1; i < ANCHORS.length; i++) {
    const [x1, y1] = ANCHORS[i];
    if (cos <= x1) {
      const [x0, y0] = ANCHORS[i - 1];
      const y = y0 + ((cos - x0) / (x1 - x0)) * (y1 - y0);
      return Math.min(99, Math.floor(y));
    }
  }
  return 99;
}

const LABELS = [
  [100, 'Found it'],
  [85, 'Burning'],
  [65, 'Hot'],
  [45, 'Warm'],
  [20, 'Cold'],
  [0, 'Freezing'],
];

function label(score) {
  for (const [min, name] of LABELS) if (score >= min) return name;
  return 'Freezing';
}

module.exports = { cosineToScore, label, ANCHORS };
