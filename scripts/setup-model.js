#!/usr/bin/env node
/**
 * Builds the semantic model files used by the server.
 *
 * Source model: GloVe (Stanford NLP) 100-dimensional word embeddings trained
 * on Wikipedia 2014 + Gigaword 5 (6B tokens, 400k vocabulary), distributed via
 * the gensim-data GitHub release.
 *
 * Output (in ./data):
 *   vocab.txt    – one lowercase word per line (most frequent first)
 *   vectors.f32  – Float32 unit-length vectors, row i = vocab line i
 *   model.json   – metadata (dims, count, source)
 *
 * Usage:
 *   npm run setup-model                       # downloads (~130 MB) then builds
 *   npm run setup-model -- /path/to/file.gz   # use an already-downloaded file
 *     (accepts gensim-data .gz or the original glove.6B.100d.txt[.gz])
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { Readable } = require('stream');

const SOURCE_URL =
  'https://github.com/RaRe-Technologies/gensim-data/releases/download/glove-wiki-gigaword-100/glove-wiki-gigaword-100.gz';
const MAX_WORDS = Number(process.env.VOCAB_SIZE || 80000);
const DATA_DIR = path.join(__dirname, '..', 'data');
const WORD_RE = /^[a-z]+$/;

// Returns the decompressed text stream plus a way to stop reading early.
// Every stream gets an error handler: once we have enough words we abort the
// download on purpose, and that abort must not crash the process.
async function openSource(localPath) {
  const state = { finished: false, error: null };
  const track = (stream) => {
    stream.on('error', (err) => {
      if (!state.finished && !state.error) state.error = err;
    });
    return stream;
  };

  if (localPath) {
    console.log(`Reading local file ${localPath}`);
    const raw = track(fs.createReadStream(localPath));
    const input = localPath.endsWith('.gz') ? track(raw.pipe(zlib.createGunzip())) : raw;
    raw.on('error', (err) => input !== raw && input.destroy(err));
    return { input, state, stop: () => raw.destroy() };
  }

  console.log(`Downloading ${SOURCE_URL}\n(about 130 MB; this may take a minute)`);
  const controller = new AbortController();
  const res = await fetch(SOURCE_URL, { signal: controller.signal });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const raw = track(Readable.fromWeb(res.body));
  const input = track(raw.pipe(zlib.createGunzip()));
  raw.on('error', (err) => input.destroy(err)); // a broken download fails the build
  return {
    input,
    state,
    stop: () => {
      try {
        controller.abort();
      } catch {
        /* already finished */
      }
    },
  };
}

async function main() {
  const { input, state, stop } = await openSource(process.argv[2]);
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const words = [];
  let dims = 0;
  let buf = null;

  for await (const line of rl) {
    const parts = line.trim().split(' ');
    if (parts.length === 2 && /^\d+$/.test(parts[0])) continue; // gensim header
    const word = parts[0];
    if (!WORD_RE.test(word)) continue;
    if (word.length < 2 && word !== 'a' && word !== 'i') continue;
    if (!dims) {
      dims = parts.length - 1;
      buf = new Float32Array(MAX_WORDS * dims);
    }
    if (parts.length - 1 !== dims) continue;
    const off = words.length * dims;
    let norm = 0;
    for (let d = 0; d < dims; d++) {
      const v = parseFloat(parts[d + 1]);
      buf[off + d] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dims; d++) buf[off + d] /= norm;
    words.push(word);
    if (words.length >= MAX_WORDS) break;
  }
  // Stop reading the rest of the file; errors from here on are expected.
  state.finished = true;
  if (state.error) throw new Error(`Reading the model failed: ${state.error.message}`);
  rl.close();
  stop();
  input.destroy();

  if (!words.length) throw new Error('No vectors parsed — is this a GloVe file?');

  const vectors = buf.subarray(0, words.length * dims);
  fs.writeFileSync(path.join(DATA_DIR, 'vectors.f32'), Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));
  fs.writeFileSync(path.join(DATA_DIR, 'vocab.txt'), words.join('\n') + '\n');
  fs.writeFileSync(
    path.join(DATA_DIR, 'model.json'),
    JSON.stringify({ name: 'glove-wiki-gigaword-100', dims, count: words.length, normalized: true }, null, 2)
  );
  console.log(`Done: ${words.length} words × ${dims} dims written to ${DATA_DIR}`);
}

main()
  .then(() => process.exit(0)) // don't wait for the aborted download to wind down
  .catch((err) => {
  console.error(`\nModel setup failed: ${err.message}`);
  process.exit(1);
});
