// API + scoring tests. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DAY = 86400000;
const spawned = new Set();
process.on('exit', () => spawned.forEach((p) => p.kill()));
test.after(() => spawned.forEach((p) => p.kill()));
let nextPort = 4100 + Math.floor(Math.random() * 500);

async function startServer(env = {}) {
  const port = nextPort++;
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), RATE_LIMIT_PER_MIN: '100000', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.add(proc);
  proc.once('exit', () => spawned.delete(proc));
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/api/puzzle`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const api = {
    base,
    log: () => log,
    stop: () => new Promise((r) => { proc.once('exit', r); proc.kill(); }),
    puzzle: () => fetch(`${base}/api/puzzle`).then((r) => r.json()),
    guess: async (guess, puzzle) => {
      if (puzzle === undefined) puzzle = (await api.puzzle()).puzzle;
      const res = await fetch(`${base}/api/guess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guess, puzzle }),
      });
      return { status: res.status, body: await res.json() };
    },
  };
  return api;
}

// Reads the same secret schedule as the server (tests only).
function todaysAnswer(offset = 0) {
  delete require.cache[require.resolve('../server/puzzle')];
  const p = require('../server/puzzle');
  return p.answerFor(p.puzzleNumber(Date.now() + offset));
}

function nearestNeighbours(answer, n) {
  const model = require('../server/model');
  model.load();
  const fs = require('node:fs');
  const words = fs.readFileSync(path.join(ROOT, 'data/vocab.txt'), 'utf8').split('\n').slice(0, 30000);
  const va = model.vector(answer);
  return words
    .filter((w) => w && w !== answer)
    .map((w) => [w, model.cosine(va, model.vector(w))])
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}

test('API', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  const answer = todaysAnswer();

  await t.test('puzzle info has number and next reset at midnight UTC', async () => {
    const info = await s.puzzle();
    assert.ok(Number.isInteger(info.puzzle) && info.puzzle > 0);
    assert.equal(info.nextReset % DAY, 0);
    assert.ok(info.nextReset > info.serverNow && info.nextReset - info.serverNow <= DAY);
    assert.equal(info.modelReady, true);
    assert.ok(!JSON.stringify(info).includes(answer), 'puzzle endpoint must not leak the answer');
  });

  await t.test('scoring is consistent across repeated requests', async () => {
    for (const w of ['music', 'river', 'happy', 'machine']) {
      const a = await s.guess(w);
      const b = await s.guess(w);
      assert.equal(a.status, 200);
      assert.equal(a.body.score, b.body.score);
    }
  });

  await t.test('capitalisation and whitespace are normalised', async () => {
    const a = await s.guess('music');
    const b = await s.guess('   MuSiC  ');
    assert.equal(b.status, 200);
    assert.equal(b.body.word, 'music');
    assert.equal(a.body.score, b.body.score);
  });

  await t.test('exact answer scores 100 and wins (any case)', async () => {
    const r = await s.guess(`  ${answer.toUpperCase()} `);
    assert.equal(r.status, 200);
    assert.equal(r.body.correct, true);
    assert.equal(r.body.score, 100);
  });

  await t.test('closely related words never win and stay below 100', async () => {
    const near = nearestNeighbours(answer, 25);
    near.push(answer + 's', answer + 'ing', answer + 'ed'); // inflections, if in vocabulary
    for (const w of near) {
      const r = await s.guess(w);
      if (r.status === 422) continue; // not a known word
      assert.equal(r.status, 200, w);
      assert.equal(r.body.correct, false, `${w} must not win`);
      assert.ok(r.body.score >= 0 && r.body.score <= 99, `${w} → ${r.body.score}`);
    }
  });

  await t.test('scores are semantic (related > unrelated)', async () => {
    const [closest] = nearestNeighbours(answer, 1);
    const near = await s.guess(closest);
    const far = (await Promise.all(['pencil', 'tax', 'keyboard', 'sandwich', 'democracy'].map((w) => s.guess(w))))
      .map((r) => r.body.score);
    assert.ok(near.body.score > Math.max(...far), `${closest}=${near.body.score} vs ${far}`);
  });

  await t.test('invalid entries are rejected with a friendly message', async () => {
    for (const bad of ['', '   ', 'two words', 'abc123', 'héllo', 'well-done']) {
      const r = await s.guess(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.ok(r.body.message);
    }
    const unknown = await s.guess('zzqxvbn');
    assert.equal(unknown.status, 422);
    assert.match(unknown.body.message, /don't know/);
  });

  await t.test('a guess for a stale puzzle number is refused (409) with the new puzzle', async () => {
    const info = await s.puzzle();
    const r = await s.guess('music', info.puzzle - 1);
    assert.equal(r.status, 409);
    assert.equal(r.body.puzzle, info.puzzle);
  });
});

test('scores are identical after a server restart (no hidden randomness)', async () => {
  const words = ['coffee', 'storm', 'castle', 'friend', 'ladder'];
  const s1 = await startServer();
  const a = await Promise.all(words.map((w) => s1.guess(w)));
  await s1.stop();
  const s2 = await startServer();
  const b = await Promise.all(words.map((w) => s2.guess(w)));
  await s2.stop();
  assert.deepEqual(a.map((r) => r.body.score), b.map((r) => r.body.score));
});

test('daily rollover at midnight UTC changes puzzle and answer', async () => {
  // Put the server clock 1.5s before the next UTC midnight.
  const now = Date.now();
  const offset = Math.ceil(now / DAY) * DAY - now - 1500;
  const s = await startServer({ CLOCK_OFFSET_MS: String(offset) });
  try {
    const before = await s.puzzle();
    const answerBefore = todaysAnswer(offset);
    assert.equal((await s.guess(answerBefore, before.puzzle)).body.correct, true);

    await new Promise((r) => setTimeout(r, 2000));
    const after = await s.puzzle();
    assert.equal(after.puzzle, before.puzzle + 1);
    assert.equal(after.nextReset, before.nextReset + DAY);

    // yesterday's puzzle number is refused; yesterday's answer no longer wins
    assert.equal((await s.guess(answerBefore, before.puzzle)).status, 409);
    const r = await s.guess(answerBefore, after.puzzle);
    assert.equal(r.body.correct, false);
  } finally {
    await s.stop();
  }
});

test('missing model is reported clearly, never faked', async () => {
  const s = await startServer({ MODEL_DIR: '/nonexistent-model-dir' });
  try {
    const info = await s.puzzle();
    assert.equal(info.modelReady, false);
    const r = await s.guess('music');
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'model_not_configured');
    assert.match(r.body.message, /npm run setup-model/);
    assert.match(s.log(), /Semantic model is not configured/);
  } finally {
    await s.stop();
  }
});

test('schedule: deterministic, no repeats within the pool, server-side only', () => {
  const p = require('../server/puzzle');
  const n = p.ANSWERS.length;
  const seen = new Set();
  for (let i = 1; i <= n; i++) seen.add(p.answerFor(i));
  assert.equal(seen.size, n, 'every answer used exactly once per cycle');
  assert.equal(p.answerFor(42), p.answerFor(42));
  assert.equal(p.puzzleNumber(Date.UTC(2026, 9, 1, 0, 0, 0)), 1);
  assert.equal(p.puzzleNumber(Date.UTC(2026, 9, 1, 23, 59, 59)), 1);
  assert.equal(p.puzzleNumber(Date.UTC(2026, 9, 2, 0, 0, 0)), 2);
});

test('score mapping: monotonic, 0–99 for non-answers', () => {
  const { cosineToScore } = require('../server/scoring');
  let prev = -1;
  for (let c = -1; c <= 1.0001; c += 0.001) {
    const s = cosineToScore(c);
    assert.ok(s >= prev && s >= 0 && s <= 99);
    prev = s;
  }
  assert.equal(cosineToScore(1), 99);
});

// ---------------- hints + stats ----------------
const os = require('node:os');
const fsx = require('node:fs');

function commonWords(from, n) {
  return fsx.readFileSync(path.join(ROOT, 'data/vocab.txt'), 'utf8').split('\n').slice(from, from + n);
}

async function post(s, url, body, pid) {
  const res = await fetch(s.base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(pid ? { 'X-Player-Id': pid } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('hints', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  const answer = todaysAnswer();
  const { puzzle, hintAfter } = await s.puzzle();
  assert.equal(hintAfter, 50);
  const base = commonWords(5000, 60).filter((w) => w !== answer);

  await t.test('locked before 50 guesses', async () => {
    const r = await post(s, '/api/hint', { puzzle, guessed: base.slice(0, 49) });
    assert.equal(r.status, 403);
  });

  await t.test('each hint beats the best guess, is new, and is never the answer', async () => {
    const guessed = base.slice(0, 50);
    let best = Math.max(...(await Promise.all(guessed.map((w) => s.guess(w, puzzle)))).map((r) => r.body.score || 0));
    for (let i = 0; i < 5; i++) {
      const r = await post(s, '/api/hint', { puzzle, guessed });
      if (r.status === 404) break; // already closer than every hint
      assert.equal(r.status, 200);
      assert.notEqual(r.body.word, answer);
      assert.ok(!guessed.includes(r.body.word));
      assert.ok(r.body.score > best && r.body.score < 100, `${r.body.word} ${r.body.score} vs best ${best}`);
      assert.equal(r.body.score, (await s.guess(r.body.word, puzzle)).body.score, 'hint score matches normal scoring');
      guessed.push(r.body.word);
      best = r.body.score;
    }
  });

  await t.test('same inputs give the same hint', async () => {
    const guessed = base.slice(0, 50);
    const a = await post(s, '/api/hint', { puzzle, guessed });
    const b = await post(s, '/api/hint', { puzzle, guessed });
    assert.equal(a.body.word, b.body.word);
  });

  await t.test('refused once the answer is guessed', async () => {
    const r = await post(s, '/api/hint', { puzzle, guessed: [...base.slice(0, 50), answer] });
    assert.equal(r.status, 400);
  });
});

test('stats: recorded anonymously, private, and kept across restarts', async () => {
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'gw-stats-'));
  const env = { STATS_DIR: dir, STATS_KEY: 'secret-key', STATS_FLUSH_MS: '200' };
  const answer = todaysAnswer();
  const A = 'aaaaaaaaaaaa0001', B = 'bbbbbbbbbbbb0002', C = 'cccccccccccc0003';

  let s = await startServer(env);
  const pz = (await s.puzzle()).puzzle;
  const visit = (pid) => fetch(`${s.base}/api/puzzle`, { headers: { 'X-Player-Id': pid } });
  await visit(A); await visit(B); await visit(C);
  // A: 3 guesses then wins. B: 50 guesses + 1 hint. C: declines a hint, only visits.
  for (const w of ['music', 'river']) await post(s, '/api/guess', { guess: w, puzzle: pz }, A);
  await post(s, '/api/guess', { guess: answer, puzzle: pz }, A);
  const fifty = commonWords(6000, 51).filter((w) => w !== answer).slice(0, 50);
  for (const w of fifty) await post(s, '/api/guess', { guess: w, puzzle: pz }, B);
  await post(s, '/api/hint', { puzzle: pz, guessed: fifty }, B);
  await post(s, '/api/event', { type: 'hint_declined', puzzle: pz }, C);
  await post(s, '/api/guess', { guess: 'music', puzzle: pz }, 'bad id!'); // ignored

  assert.equal((await fetch(`${s.base}/api/stats`)).status, 404, 'needs key');
  assert.equal((await fetch(`${s.base}/api/stats?key=wrong`)).status, 404);
  await new Promise((r) => setTimeout(r, 400));
  await s.stop(); // SIGTERM → flush

  s = await startServer(env); // fresh process, stats come back from disk
  const rep = await (await fetch(`${s.base}/api/stats?key=secret-key`)).json();
  const today = rep.rows[0];
  assert.equal(today.puzzle, pz);
  assert.equal(today.visitors, 3);
  assert.equal(today.played, 2);
  assert.equal(today.winners, 1);
  assert.equal(today.medianGuessesToWin, 3);
  assert.equal(today.reached50, 1);
  assert.equal(today.usedHint, 1);
  assert.equal(today.declinedHint, 1);
  const html = await (await fetch(`${s.base}/stats?key=secret-key`)).text();
  assert.match(html, /Hot Word · Stats/);
  const files = fsx.readdirSync(dir).map((f) => fsx.readFileSync(path.join(dir, f), 'utf8')).join('');
  assert.ok(!files.includes('127.0.0.1') && !files.includes(answer), 'no IPs or words stored');
  await s.stop();
});

test('stats: next-day retention is computed across puzzles', () => {
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'gw-ret-'));
  fsx.writeFileSync(path.join(dir, 'day-10.json'), JSON.stringify({ players: { p1: { v: 1 }, p2: { v: 1 }, p3: { v: 1 }, p4: { v: 1 } } }));
  fsx.writeFileSync(path.join(dir, 'day-11.json'), JSON.stringify({ players: { p1: { v: 1 }, p5: { v: 1 } } }));
  process.env.STATS_DIR = dir;
  const { createStats } = require('../server/stats');
  return createStats()
    .report(11, 2)
    .then((r) => {
      const [d11, d10] = r.rows;
      assert.equal(d10.cameBackNextDay, 1); // 1 of 4 came back
      assert.equal(d11.returningFromYesterday, 1);
      assert.equal(d11.cameBackNextDay, null); // today: unknown yet
    });
});

test('rate limit: too many guesses per minute get 429 and are not scored', async () => {
  const s = await startServer({ RATE_LIMIT_PER_MIN: '5' });
  try {
    const { puzzle } = await s.puzzle();
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await s.guess('music', puzzle)).status);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  } finally {
    await s.stop();
  }
});
