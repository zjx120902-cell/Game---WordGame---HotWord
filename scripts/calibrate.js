#!/usr/bin/env node
// Prints raw cosine + mapped score for sample word pairs, plus the score
// distribution for a few answers. Used to tune server/scoring.js.
const model = require('../server/model');
const { cosineToScore, label } = require('../server/scoring');
const { ANSWERS } = require('../server/puzzle');

const st = model.load();
if (!st.ready) {
  console.error(st.error);
  process.exit(1);
}

const PAIRS = [
  ['ocean', 'sea'], ['ocean', 'beach'], ['ocean', 'water'], ['ocean', 'wave'], ['ocean', 'mountain'],
  ['ocean', 'salt'], ['ocean', 'car'], ['ocean', 'democracy'], ['ocean', 'pencil'],
  ['coffee', 'tea'], ['coffee', 'sugar'], ['coffee', 'bean'], ['coffee', 'morning'], ['coffee', 'keyboard'],
  ['dog', 'cat'], ['dog', 'puppy'], ['dog', 'wolf'], ['dog', 'leash'], ['dog', 'bone'], ['dog', 'tax'],
  ['happy', 'glad'], ['happy', 'smile'], ['happy', 'birthday'], ['happy', 'brick'],
  ['king', 'queen'], ['king', 'crown'], ['king', 'castle'], ['king', 'banana'],
];

console.log('pair                      cos    score  label');
for (const [a, b] of PAIRS) {
  const c = model.cosine(model.vector(a), model.vector(b));
  const s = cosineToScore(c);
  console.log(`${(a + ' / ' + b).padEnd(24)} ${c.toFixed(3).padStart(6)}  ${String(s).padStart(4)}   ${label(s)}`);
}

// How many vocabulary words land in each band, per answer (top 50k words).
console.log('\nwords per band (of 50k most common) for sample answers');
const bands = ['Freezing', 'Cold', 'Warm', 'Hot', 'Burning'];
console.log('answer       ' + bands.map((b) => b.padStart(9)).join(''));
const sample = ['ocean', 'coffee', 'bridge', 'happy', 'music', 'ghost'];
const words = require('fs')
  .readFileSync(require('path').join(__dirname, '..', 'data', 'vocab.txt'), 'utf8')
  .split('\n')
  .slice(0, 50000);
for (const a of sample) {
  const va = model.vector(a);
  const counts = Object.fromEntries(bands.map((b) => [b, 0]));
  for (const w of words) {
    if (!w || w === a) continue;
    counts[label(cosineToScore(model.cosine(va, model.vector(w))))]++;
  }
  console.log(a.padEnd(13) + bands.map((b) => String(counts[b]).padStart(9)).join(''));
}

const missing = ANSWERS.filter((a) => !model.has(a));
const ranks = ANSWERS.map((a) => model.rank(a)).filter((r) => r >= 0);
console.log(`\nanswer pool: ${ANSWERS.length} words, missing from model: ${missing.length ? missing.join(', ') : 'none'}, rarest rank: ${Math.max(...ranks)}`);
