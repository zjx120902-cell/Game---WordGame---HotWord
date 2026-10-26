// Loads the GloVe embedding model (built by scripts/setup-model.js) and
// computes semantic similarity between two words.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.MODEL_DIR || path.join(__dirname, '..', 'data');

class ModelNotConfigured extends Error {
  constructor(detail) {
    super(
      `Semantic model is not configured (${detail}). ` +
        `Run "npm run setup-model" to download and build the GloVe embeddings into ./data.`
    );
    this.code = 'MODEL_NOT_CONFIGURED';
  }
}

let model = null;
let loadError = null;

function load() {
  try {
    const metaPath = path.join(DATA_DIR, 'model.json');
    const vecPath = path.join(DATA_DIR, 'vectors.f32');
    const vocabPath = path.join(DATA_DIR, 'vocab.txt');
    for (const p of [metaPath, vecPath, vocabPath]) {
      if (!fs.existsSync(p)) throw new ModelNotConfigured(`missing ${path.relative(process.cwd(), p)}`);
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const words = fs.readFileSync(vocabPath, 'utf8').split('\n').filter(Boolean);
    const buf = fs.readFileSync(vecPath);
    const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (words.length !== meta.count || vectors.length !== meta.count * meta.dims) {
      throw new ModelNotConfigured('model files are inconsistent; rebuild them');
    }
    const index = new Map(words.map((w, i) => [w, i]));
    model = { meta, words, vectors, index, dims: meta.dims };
    loadError = null;
  } catch (err) {
    model = null;
    loadError = err instanceof ModelNotConfigured ? err : new ModelNotConfigured(err.message);
  }
  return status();
}

function status() {
  return model
    ? { ready: true, name: model.meta.name, words: model.meta.count, dims: model.dims }
    : { ready: false, error: loadError ? loadError.message : 'not loaded' };
}

function requireModel() {
  if (!model) throw loadError || new ModelNotConfigured('not loaded');
  return model;
}

function has(word) {
  return requireModel().index.has(word);
}

function rank(word) {
  const i = requireModel().index.get(word);
  return i === undefined ? -1 : i;
}

/** Returns the stored unit vector for a word (a view, no copy). */
function vector(word) {
  const m = requireModel();
  const i = m.index.get(word);
  if (i === undefined) return null;
  return m.vectors.subarray(i * m.dims, (i + 1) * m.dims);
}

/** Cosine similarity of two unit vectors. */
function cosine(a, b) {
  let s = 0;
  for (let k = 0; k < a.length; k++) s += a[k] * b[k];
  return s;
}

/** The `limit` most frequent words in the vocabulary. */
function commonWords(limit) {
  return requireModel().words.slice(0, limit);
}

module.exports = { load, status, has, rank, vector, cosine, commonWords, ModelNotConfigured };
