// Daily puzzle schedule. Everything here stays on the server.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ANSWERS = require('./answers');

const DAY_MS = 86400000;
// Puzzle #1 was played on this UTC date.
const LAUNCH_UTC = Date.UTC(2026, 9, 1); // 2026-10-01

// Testing hook only: shifts the server clock (e.g. to simulate midnight).
const CLOCK_OFFSET_MS = Number(process.env.CLOCK_OFFSET_MS || 0);
const now = () => Date.now() + CLOCK_OFFSET_MS;

function loadSecret() {
  if (process.env.PUZZLE_SECRET) return process.env.PUZZLE_SECRET;
  if (process.env.NODE_ENV === 'production') {
    console.warn(
      '\n⚠️  PUZZLE_SECRET is not set. On most hosts the generated .puzzle-secret file is wiped on every\n' +
        '   redeploy, which would change the daily answers mid-day. Set PUZZLE_SECRET in your host settings.\n'
    );
  }
  const file = path.join(__dirname, '..', '.puzzle-secret');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}
const SECRET = loadSecret();

/** Puzzle number for a given timestamp (changes at 00:00 UTC). */
function puzzleNumber(t = now()) {
  return Math.floor((t - LAUNCH_UTC) / DAY_MS) + 1;
}

function nextResetAt(t = now()) {
  return (Math.floor(t / DAY_MS) + 1) * DAY_MS;
}

// Deterministic, secret shuffle of the answer pool. Each full pass through
// the pool ("cycle") gets its own order, so the sequence never visibly repeats.
const cycleCache = new Map();
function cycleOrder(cycle) {
  if (cycleCache.has(cycle)) return cycleCache.get(cycle);
  const seed = crypto.createHmac('sha256', SECRET).update(`cycle:${cycle}`).digest();
  let counter = 0;
  const rand = () => {
    const h = crypto.createHmac('sha256', seed).update(String(counter++)).digest();
    return h.readUInt32BE(0) / 2 ** 32;
  };
  const order = ANSWERS.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  cycleCache.set(cycle, order);
  return order;
}

function answerFor(number) {
  const n = Math.max(1, number) - 1;
  const cycle = Math.floor(n / ANSWERS.length);
  return cycleOrder(cycle)[n % ANSWERS.length];
}

module.exports = { now, puzzleNumber, nextResetAt, answerFor, ANSWERS, DAY_MS };
