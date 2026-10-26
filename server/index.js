// Hot Word — zero-dependency Node.js server.
const http = require('http');
const fs = require('fs');
const path = require('path');
const model = require('./model');
const { cosineToScore, label } = require('./scoring');
const puzzle = require('./puzzle');
const { createStats } = require('./stats');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const HINT_AFTER = 50; // guesses before a hint is offered
const STATS_KEY = process.env.STATS_KEY || '';
const stats = createStats();

// ---------- model + precomputed answer embeddings ----------
const answerVectors = new Map();

function initModel() {
  const st = model.load();
  answerVectors.clear();
  if (!st.ready) {
    console.error(`\n⚠️  ${st.error}\n   The game will load, but guesses will return a configuration error.\n`);
    return st;
  }
  const missing = [];
  for (const a of puzzle.ANSWERS) {
    const v = model.vector(a);
    if (v) answerVectors.set(a, Float32Array.from(v));
    else missing.push(a);
  }
  if (missing.length) console.warn(`Answers missing from the model vocabulary: ${missing.join(', ')}`);
  console.log(`Model ready: ${st.name}, ${st.words} words, ${st.dims} dims; ${answerVectors.size} answers precomputed.`);
  return st;
}

// ---------- scoring with a bounded cache ----------
const scoreCache = new Map();
const CACHE_MAX = 50000;

function scoreGuess(answer, word) {
  const key = `${answer}|${word}`;
  if (scoreCache.has(key)) return scoreCache.get(key);
  const target = answerVectors.get(answer);
  if (!target) throw new Error(`No embedding for today's answer`);
  const guessVec = model.vector(word);
  const result = cosineToScore(model.cosine(guessVec, target));
  if (scoreCache.size >= CACHE_MAX) scoreCache.delete(scoreCache.keys().next().value);
  scoreCache.set(key, result);
  return result;
}

function normalize(input) {
  return String(input ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// ---------- HTTP helpers ----------
function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ---------- rate limiting (per IP, in memory) ----------
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN || 60);
const hits = new Map();
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0] : req.socket.remoteAddress || '').trim();
}
function rateLimited(req) {
  const ip = clientIp(req);
  const t = Date.now();
  const entry = hits.get(ip);
  if (!entry || t - entry.start >= 60000) {
    hits.set(ip, { start: t, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}
setInterval(() => {
  const t = Date.now();
  for (const [ip, e] of hits) if (t - e.start >= 60000) hits.delete(ip);
}, 60000).unref();

// ---------- hints ----------
// A hint reveals a familiar word that is closer to the answer than the
// player's best guess so far (never the answer, never an obvious inflection).
const HINT_POOL = 20000; // only suggest reasonably common words
const neighbourCache = new Map();

function neighboursOf(answer) {
  if (neighbourCache.has(answer)) return neighbourCache.get(answer);
  const target = answerVectors.get(answer);
  const list = [];
  for (const w of model.commonWords(HINT_POOL)) {
    if (w.length < 3 || w === answer || w.startsWith(answer) || answer.startsWith(w)) continue;
    const cos = model.cosine(model.vector(w), target);
    if (cos > 0.3) list.push([w, cosineToScore(cos)]);
  }
  list.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const top = list.slice(0, 400);
  neighbourCache.set(answer, top);
  if (neighbourCache.size > 10) neighbourCache.delete(neighbourCache.keys().next().value);
  return top;
}

function pickHint(answer, best, guessed) {
  const candidates = neighboursOf(answer).filter(([w, s]) => s > best && !guessed.has(w));
  if (!candidates.length) return null;
  const top = candidates[0][1];
  const target = Math.min(top, best + Math.max(6, (top - best) / 2));
  let pick = candidates[0];
  for (const c of candidates) if (Math.abs(c[1] - target) < Math.abs(pick[1] - target)) pick = c;
  return { word: pick[0], score: pick[1] };
}

// ---------- API ----------
function puzzleInfo() {
  const t = puzzle.now();
  return {
    puzzle: puzzle.puzzleNumber(t),
    serverNow: t,
    nextReset: puzzle.nextResetAt(t),
    modelReady: model.status().ready,
    hintAfter: HINT_AFTER,
  };
}

const playerId = (req) => String(req.headers['x-player-id'] || '');

async function readJson(req, res) {
  try {
    return JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: 'bad_request', message: 'Something went wrong sending that. Please try again.' });
    return null;
  }
}

async function handleGuess(req, res) {
  if (rateLimited(req)) {
    return sendJson(res, 429, { error: 'rate_limited', message: 'Whoa, slow down a little! Try again in a minute.' });
  }
  const body = await readJson(req, res);
  if (!body) return;

  const info = puzzleInfo();
  if (body.puzzle !== info.puzzle) {
    return sendJson(res, 409, { error: 'stale_puzzle', message: 'A new puzzle has started!', ...info });
  }

  const word = normalize(body.guess);
  if (!word) return sendJson(res, 400, { error: 'invalid', message: 'Type a word first.' });
  if (word.includes(' ')) return sendJson(res, 400, { error: 'invalid', message: 'Just one word at a time, please.' });
  if (!/^[a-z]+$/.test(word)) return sendJson(res, 400, { error: 'invalid', message: 'Letters only — no numbers or symbols.' });
  if (word.length > 30) return sendJson(res, 400, { error: 'invalid', message: 'That word is a bit too long.' });

  const answer = puzzle.answerFor(info.puzzle);

  // Exact match is the only way to win. Checked by string equality, never by score.
  if (word === answer) {
    stats.record(info.puzzle, playerId(req), 'guess', { won: true });
    return sendJson(res, 200, { word, score: 100, label: label(100), correct: true, puzzle: info.puzzle });
  }

  if (!model.status().ready) {
    return sendJson(res, 503, { error: 'model_not_configured', message: model.status().error });
  }
  if (!model.has(word)) {
    return sendJson(res, 422, { error: 'unknown_word', message: `We don't know “${word}”. Try another English word.` });
  }

  try {
    const score = scoreGuess(answer, word);
    stats.record(info.puzzle, playerId(req), 'guess');
    return sendJson(res, 200, { word, score, label: label(score), correct: false, puzzle: info.puzzle });
  } catch (err) {
    console.error('Scoring failed:', err);
    return sendJson(res, 503, { error: 'scoring_failed', message: 'Scoring is unavailable right now.' });
  }
}

async function handleHint(req, res) {
  if (rateLimited(req)) {
    return sendJson(res, 429, { error: 'rate_limited', message: 'Whoa, slow down a little! Try again in a minute.' });
  }
  const body = await readJson(req, res);
  if (!body) return;
  const info = puzzleInfo();
  if (body.puzzle !== info.puzzle) {
    return sendJson(res, 409, { error: 'stale_puzzle', message: 'A new puzzle has started!', ...info });
  }
  const guessed = Array.isArray(body.guessed) ? body.guessed.map(normalize).filter((w) => /^[a-z]+$/.test(w)) : [];
  if (guessed.length < HINT_AFTER) {
    return sendJson(res, 403, { error: 'too_early', message: `Hints unlock after ${HINT_AFTER} guesses.` });
  }
  if (!model.status().ready) {
    return sendJson(res, 503, { error: 'model_not_configured', message: model.status().error });
  }
  const answer = puzzle.answerFor(info.puzzle);
  if (guessed.includes(answer)) return sendJson(res, 400, { error: 'already_won', message: 'You already found it!' });

  // Best score is recomputed on the server from the guessed words.
  let best = 0;
  try {
    for (const w of guessed) if (model.has(w)) best = Math.max(best, scoreGuess(answer, w));
    const hint = pickHint(answer, best, new Set(guessed));
    if (!hint) {
      return sendJson(res, 404, { error: 'no_hint', message: 'You’re already closer than any hint we have. Keep going!' });
    }
    stats.record(info.puzzle, playerId(req), 'hint');
    return sendJson(res, 200, { word: hint.word, score: hint.score, label: label(hint.score), correct: false, hint: true, puzzle: info.puzzle });
  } catch (err) {
    console.error('Hint failed:', err);
    return sendJson(res, 503, { error: 'scoring_failed', message: 'Hints are unavailable right now.' });
  }
}

async function handleEvent(req, res) {
  const body = await readJson(req, res);
  if (!body) return;
  const info = puzzleInfo();
  if (body.type === 'hint_declined' && body.puzzle === info.puzzle) {
    stats.record(info.puzzle, playerId(req), 'declined');
  }
  sendJson(res, 200, { ok: true });
}

// ---------- private stats page ----------
function statsAuthorized(url) {
  return STATS_KEY && url.searchParams.get('key') === STATS_KEY;
}

function pct(n, d) {
  return d ? `${Math.round((n / d) * 100)}%` : '–';
}

function renderStatsPage(r) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const v = (x) => (x === null || x === undefined ? '–' : x);
  const rows = r.rows
    .map(
      (d) => `<tr>
      <td>#${d.puzzle}</td><td>${d.visitors}</td><td>${d.played}</td><td>${d.winners} <small>${pct(d.winners, d.played)}</small></td>
      <td>${v(d.medianGuessesToWin)}</td><td>${d.avgGuesses === null ? '–' : d.avgGuesses.toFixed(1)}</td>
      <td>${d.reached50}</td><td>${d.usedHint}</td><td>${d.declinedHint}</td>
      <td>${v(d.returningFromYesterday)}</td>
      <td>${d.cameBackNextDay === null ? '–' : `${d.cameBackNextDay} <small>${pct(d.cameBackNextDay, d.visitors)}</small>`}</td></tr>`
    )
    .join('');
  const warn = !r.persistent
    ? `<p class="warn">⚠️ Stats are stored in temporary files and will be lost when the server restarts. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to keep them (see README).</p>`
    : '';
  const err = r.lastError ? `<p class="warn">⚠️ Last storage error: ${esc(r.lastError)}</p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Hot Word · Stats</title>
<style>
:root{--bg:#f6f3ee;--s:#fff;--t:#1d1f24;--m:#6d6a64;--l:#e5e0d8;--w:#b3402c}
@media (prefers-color-scheme:dark){:root{--bg:#16181c;--s:#1f2228;--t:#ecebe8;--m:#9a978f;--l:#2d3038;--w:#f08a74}}
body{margin:0;background:var(--bg);color:var(--t);font:14px/1.45 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px 16px}
h1{font:600 1.2rem ui-serif,Georgia,serif;margin:0 0 4px}.sub{color:var(--m);margin:0 0 16px}
.wrap{overflow-x:auto;background:var(--s);border:1px solid var(--l);border-radius:12px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;white-space:nowrap}
th,td{padding:8px 12px;text-align:right;border-bottom:1px solid var(--l)}th:first-child,td:first-child{text-align:left}
th{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--m);font-weight:600}
small{color:var(--m)}.warn{color:var(--w)}dl{color:var(--m);font-size:.85rem;margin-top:18px}dt{font-weight:600;color:var(--t);display:inline}dd{display:inline;margin:0 0 0 4px}dd::after{content:"";display:block;margin-bottom:4px}
</style></head><body>
<h1>Hot Word · Stats</h1><p class="sub">Anonymous counts per puzzle (UTC days). Storage: ${esc(r.storage)}.</p>${warn}${err}
<div class="wrap"><table><thead><tr><th>Puzzle</th><th>Visitors</th><th>Played</th><th>Found it</th><th>Median guesses</th><th>Avg guesses</th><th>Reached 50</th><th>Used hint</th><th>Declined hint</th><th>Back from yesterday</th><th>Came back next day</th></tr></thead>
<tbody>${rows}</tbody></table></div>
<dl><dt>Visitors</dt><dd>opened the page that day</dd><dt>Played</dt><dd>made at least one guess</dd>
<dt>Median guesses</dt><dd>among players who found it</dd><dt>Avg guesses</dt><dd>among everyone who played, finished or not</dd>
<dt>Came back next day</dt><dd>visitors who also opened the next puzzle — the key retention number</dd></dl>
</body></html>`;
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const { pathname } = url;
  try {
    if (pathname === '/api/puzzle' && req.method === 'GET') {
      const info = puzzleInfo();
      stats.record(info.puzzle, playerId(req), 'visit');
      return sendJson(res, 200, info);
    }
    if (pathname === '/api/guess' && req.method === 'POST') return await handleGuess(req, res);
    if (pathname === '/api/hint' && req.method === 'POST') return await handleHint(req, res);
    if (pathname === '/api/event' && req.method === 'POST') return await handleEvent(req, res);
    if (pathname === '/api/health') return sendJson(res, 200, { model: model.status(), ...puzzleInfo() });
    if (pathname === '/stats' || pathname === '/api/stats') {
      if (!statsAuthorized(url)) return sendJson(res, 404, { error: 'not_found' });
      const report = await stats.report(puzzleInfo().puzzle, Math.min(90, Number(url.searchParams.get('days')) || 30));
      if (pathname === '/api/stats') return sendJson(res, 200, report);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(renderStatsPage(report));
    }
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not_found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });
    return serveStatic(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'server_error', message: 'Something went wrong.' });
  }
});

async function shutdown() {
  await stats.flush().catch(() => {});
  process.exit(0);
}

if (require.main === module) {
  initModel();
  console.log(`Stats storage: ${stats.storageName}${stats.persistent ? '' : ' (temporary — set UPSTASH_REDIS_REST_URL/TOKEN to keep stats)'}`);
  if (!STATS_KEY) console.log('Stats page disabled: set STATS_KEY to enable /stats?key=…');
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  server.listen(PORT, () => console.log(`Hot Word running at http://localhost:${PORT}`));
}

module.exports = { server, initModel, scoreGuess, normalize };
