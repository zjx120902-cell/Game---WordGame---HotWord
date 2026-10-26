# Hot Word

A minimal daily word-guessing game. One secret English word, no clues — every guess shows how close its *meaning* is to the answer.

- **Stack:** plain Node.js (≥ 18) with zero npm dependencies, and a static HTML/CSS/JS front end.
- **Semantic model:** [GloVe](https://nlp.stanford.edu/projects/glove/) 100-dimensional word embeddings (Stanford NLP, trained on Wikipedia + Gigaword, 6B tokens). It runs locally inside the server — no API keys, no external calls while playing.

## Quick start

```bash
npm run setup-model   # one-time: downloads GloVe (~130 MB) and builds ./data (~33 MB)
npm start             # http://localhost:3000
```

If `./data` already contains `vectors.f32`, `vocab.txt` and `model.json`, skip the first step.

### Semantic model setup, in detail

`npm run setup-model` downloads `glove-wiki-gigaword-100.gz` from the gensim-data GitHub release and writes:

| file | contents |
|---|---|
| `data/vocab.txt` | the 80,000 most frequent lowercase alphabetic words (this is also the list of accepted guesses) |
| `data/vectors.f32` | one unit-length Float32 vector per word |
| `data/model.json` | metadata (dimensions, word count) |

Options:

- Already have the file (or the original `glove.6B.100d.txt` from Stanford)? `npm run setup-model -- /path/to/file.gz`
- Different vocabulary size: `VOCAB_SIZE=120000 npm run setup-model`
- Model stored elsewhere: `MODEL_DIR=/path/to/data npm start`

**If the model is missing**, the server still starts but prints `Semantic model is not configured (missing data/…)` and every guess returns a 503 explaining exactly what to run. The page shows that message and does not count the guess. There is no fallback or fake scoring.

## Deploying publicly (Render)

1. Put this folder in a GitHub repository. Leave out `data/` and `.puzzle-secret`, because the deploy builds the model itself.
2. On render.com, choose **New → Blueprint** and select the repository. `render.yaml` sets everything up: the build downloads the model, the start command runs the server, and a random `PUZZLE_SECRET` is created once and kept.
3. Every push to GitHub redeploys the game automatically.

On the free plan, the server sleeps after about 15 minutes with no visitors, so the first visit after that takes about a minute to load. A paid instance stays awake.

Guesses are limited to `RATE_LIMIT_PER_MIN` per visitor (default 60).

## Hints

After 50 guesses, the player is offered a hint, which they can take or decline with “No thanks”. Declining is remembered for the day, and a small “Get a hint” link stays available. A hint reveals a common word that scores higher than the player's best guess. It's never the answer or an obvious variant of it, it counts as a guess, and it's marked 💡 in the share text.

## Play statistics

Each browser gets a random anonymous ID in localStorage. The server stores no IP addresses and no guessed words. Per puzzle day it keeps visitors, players, winners, guesses, hint use, and whether a visitor came back the next day.

- **View them:** `https://<your-site>/stats?key=<STATS_KEY>` (JSON at `/api/stats?key=…`). With no `STATS_KEY`, the page is disabled.
- **Storage:** set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to use a free [Upstash](https://upstash.com) Redis database. Stats are saved every 30 s and on shutdown. Without these, stats go to `./stats/` files, which are fine locally but wiped on every restart on Render's free plan. The stats page warns about this.

### Setting up Upstash (free)

1. Sign up at upstash.com → **Create Database** (Redis, any region near your server, free plan).
2. On the database page, under **REST API**, copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
3. In Render → your service → **Environment**, add both, then save. Render restarts the game automatically.

## Configuration

| variable | default | purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `PUZZLE_SECRET` | auto-generated into `.puzzle-secret` | seeds the secret answer order. Keep it private and stable — changing it changes the schedule |
| `MODEL_DIR` | `./data` | where the model files live |
| `STATS_KEY` | – | password for `/stats`; page disabled if unset |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | – | permanent stats storage |
| `STATS_DIR` | `./stats` | stats files when Upstash isn't configured |
| `RATE_LIMIT_PER_MIN` | `60` | guesses + hints per visitor per minute |
| `CLOCK_OFFSET_MS` | `0` | **testing only** — shifts the server clock (e.g. to just before midnight) |

## How it works

**Daily puzzle.** Puzzle #1 was 1 October 2026 (UTC). The number is days since then; it changes at 00:00 UTC. The answer is looked up in a secret, HMAC-seeded shuffle of the curated pool in `server/answers.js` (481 everyday words). Each word is used once per cycle through the pool. The answer and schedule never leave the server — `/api/puzzle` only returns the puzzle number and the reset time.

**Scoring** (`server/scoring.js`). The server takes the cosine similarity between the guess vector and the precomputed answer vector, then maps it to 0–100 with a piecewise-linear curve calibrated on sample pairs (`npm run calibrate`):

| example pair | cosine | score |
|---|---|---|
| ocean / sea | 0.84 | 94 Burning |
| ocean / water | 0.63 | 77 Hot |
| ocean / mountain | 0.46 | 55 Warm |
| ocean / car | 0.28 | 30 Cold |
| ocean / pencil | 0.01 | 1 Freezing |

Of the 50,000 most common words, typically a handful are Burning, ~100 Hot, ~1,000 Warm and the rest Cold or Freezing. Non-answers are capped at 99. **100 only comes from an exact string match** with the answer, checked before scoring, so a near-synonym can never win. Scores are pure functions of the two vectors and are cached in memory.

**Client.** Progress is stored in `localStorage`, keyed by puzzle number. The countdown uses the server's clock, compensating for device clock drift. At zero it refetches the puzzle and resets the board, even if the tab stayed open. It also rechecks when the tab becomes visible. A guess sent for an old puzzle gets a 409 and triggers the same reset without counting.

## API

- `GET /api/puzzle` → `{ puzzle, serverNow, nextReset, modelReady }`
- `POST /api/guess` `{ guess, puzzle }` → `{ word, score, label, correct }`
  - 400 invalid input · 422 unknown word · 409 new puzzle started · 503 model missing or scoring failed
- `GET /api/health` → model status

## Tests

```bash
npm test          # API + scoring: consistency, exact-answer, near-miss words, invalid input,
                  # stale puzzle, restart determinism, midnight rollover, missing model, schedule
npm run test:e2e  # browser, mobile viewport (needs: npm i -D playwright && npx playwright install chromium)
```

The end-to-end script covers guessing, sorting, duplicates, invalid words, scoring failure + Retry, refresh persistence, winning, the share text (checked for spoilers), and a live midnight rollover with the page open.

## Project layout

```
server/index.js     HTTP server + API
server/model.js     loads embeddings, cosine similarity
server/scoring.js   cosine → 0–100 mapping + labels
server/puzzle.js    daily number, secret schedule
server/answers.js   curated answer pool
scripts/            setup-model.js, calibrate.js
public/             index.html, style.css, app.js
test/               api.test.js, e2e.js
```

GloVe embeddings: Jeffrey Pennington, Richard Socher, Christopher D. Manning (2014), released under the Open Data Commons Public Domain Dedication and License.
