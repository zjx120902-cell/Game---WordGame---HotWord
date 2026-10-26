// Anonymous play statistics.
//
// Each browser gets a random ID (stored in its localStorage). No IP addresses,
// names or other personal data are stored. Per puzzle day we keep, for each ID:
//   v  opened the page        g  counted guesses (incl. hints)
//   w  found the answer       h  hints used        d  declined the hint offer
//
// Storage backends (chosen automatically):
//   * Upstash Redis (REST) when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set.
//     Use this on hosts with a temporary filesystem (e.g. Render's free plan).
//   * Otherwise a JSON file per day in STATS_DIR (default ./stats).
const fs = require('fs');
const path = require('path');

const FLUSH_MS = Number(process.env.STATS_FLUSH_MS || 30000);
const PID_RE = /^[a-z0-9]{12,40}$/i;
const KEY = (puzzle) => `gw:stats:${puzzle}`;

// ---------- storage backends ----------
function upstashStore(url, token) {
  async function cmd(args) {
    const res = await fetch(url.replace(/\/$/, ''), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(`Upstash: ${body.error || res.status}`);
    return body.result;
  }
  return {
    name: 'Upstash Redis',
    persistent: true,
    async getMany(puzzles) {
      if (!puzzles.length) return [];
      const raw = await cmd(['MGET', ...puzzles.map(KEY)]);
      return raw.map((r) => (r ? JSON.parse(r) : null));
    },
    async put(puzzle, data) {
      await cmd(['SET', KEY(puzzle), JSON.stringify(data)]);
    },
  };
}

function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (p) => path.join(dir, `day-${p}.json`);
  return {
    name: `files in ${dir}`,
    persistent: !process.env.RENDER, // Render free instances wipe local files
    async getMany(puzzles) {
      return puzzles.map((p) => {
        try {
          return JSON.parse(fs.readFileSync(file(p), 'utf8'));
        } catch {
          return null;
        }
      });
    },
    async put(puzzle, data) {
      const tmp = file(puzzle) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file(puzzle));
    },
  };
}

function createStats() {
  const { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token } = process.env;
  const store = url && token ? upstashStore(url, token) : fileStore(process.env.STATS_DIR || path.join(__dirname, '..', 'stats'));

  const days = new Map(); // puzzle -> { players: { pid: {...} } }
  const loading = new Map();
  const dirty = new Set();
  let lastError = null;

  async function day(puzzle) {
    if (days.has(puzzle)) return days.get(puzzle);
    if (!loading.has(puzzle)) {
      loading.set(
        puzzle,
        store
          .getMany([puzzle])
          .then(([d]) => d)
          .catch((err) => {
            lastError = err.message;
            console.error('Stats load failed:', err.message);
            return null;
          })
          .then((d) => {
            const value = d && d.players ? d : { players: {} };
            if (!days.has(puzzle)) days.set(puzzle, value);
            loading.delete(puzzle);
            return days.get(puzzle);
          })
      );
    }
    return loading.get(puzzle);
  }

  /** Records an event. Never throws: stats must not break the game. */
  async function record(puzzle, pid, event, extra = {}) {
    if (!PID_RE.test(pid || '') || !Number.isInteger(puzzle)) return;
    try {
      const d = await day(puzzle);
      const p = d.players[pid] || (d.players[pid] = {});
      p.v = 1;
      if (event === 'guess') p.g = (p.g || 0) + 1;
      if (event === 'hint') {
        p.g = (p.g || 0) + 1;
        p.h = (p.h || 0) + 1;
      }
      if (event === 'declined') p.d = 1;
      if (extra.won) p.w = 1;
      dirty.add(puzzle);
      // Keep only recent days in memory.
      for (const k of days.keys()) if (k < puzzle - 2 && !dirty.has(k)) days.delete(k);
    } catch (err) {
      console.error('Stats record failed:', err.message);
    }
  }

  async function flush() {
    for (const puzzle of [...dirty]) {
      dirty.delete(puzzle);
      try {
        await store.put(puzzle, days.get(puzzle));
        lastError = null;
      } catch (err) {
        dirty.add(puzzle); // retry next time
        lastError = err.message;
        console.error('Stats save failed:', err.message);
        return;
      }
    }
  }

  const timer = setInterval(flush, FLUSH_MS);
  timer.unref();

  /** Summary rows for the last `n` puzzles, newest first. */
  async function report(currentPuzzle, n = 30) {
    await flush();
    const nums = [];
    for (let p = currentPuzzle; p > currentPuzzle - n - 1 && p >= 1; p--) nums.push(p);
    const missing = nums.filter((p) => !days.has(p));
    let loaded = [];
    try {
      loaded = await store.getMany(missing);
    } catch (err) {
      lastError = err.message;
    }
    const data = new Map(nums.map((p) => [p, days.get(p)]));
    missing.forEach((p, i) => data.set(p, loaded[i] || null));

    const rows = nums.slice(0, n).map((p) => {
      const players = Object.entries((data.get(p) || {}).players || {});
      const played = players.filter(([, s]) => s.g > 0);
      const winners = played.filter(([, s]) => s.w);
      const winGuesses = winners.map(([, s]) => s.g).sort((a, b) => a - b);
      const next = (data.get(p + 1) || {}).players;
      const prev = (data.get(p - 1) || {}).players;
      return {
        puzzle: p,
        visitors: players.length,
        played: played.length,
        winners: winners.length,
        winRate: played.length ? winners.length / played.length : null,
        medianGuessesToWin: winGuesses.length ? winGuesses[Math.floor((winGuesses.length - 1) / 2)] : null,
        avgGuesses: played.length ? played.reduce((s, [, x]) => s + x.g, 0) / played.length : null,
        reached50: played.filter(([, s]) => s.g >= 50).length,
        usedHint: played.filter(([, s]) => s.h > 0).length,
        declinedHint: players.filter(([, s]) => s.d).length,
        returningFromYesterday: prev ? players.filter(([id]) => prev[id]).length : null,
        cameBackNextDay: p < currentPuzzle && next ? players.filter(([id]) => next[id]).length : null,
      };
    });
    return { storage: store.name, persistent: store.persistent, lastError, rows };
  }

  return { record, flush, report, storageName: store.name, persistent: store.persistent };
}

module.exports = { createStats, PID_RE };
