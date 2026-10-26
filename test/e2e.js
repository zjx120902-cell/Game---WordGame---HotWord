// Browser end-to-end check (mobile viewport) using Playwright.
// Run: npm run test:e2e   (requires `npm i -D playwright && npx playwright install chromium`)
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || path.join(ROOT, 'test', 'screenshots');
const DAY = 86400000;

function startServer(port, env = {}) {
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), RATE_LIMIT_PER_MIN: '100000', STATS_DIR: require('node:os').tmpdir() + '/gw-e2e-stats', ...env }, stdio: 'ignore',
  });
  return new Promise(async (resolve) => {
    for (let i = 0; i < 100; i++) {
      try { await fetch(`http://127.0.0.1:${port}/api/puzzle`); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    const s = { url: `http://127.0.0.1:${port}/`, stop: () => proc.kill() };
    servers.push(s);
    resolve(s);
  });
}

function answerFor(offset) {
  delete require.cache[require.resolve('../server/puzzle')];
  const p = require('../server/puzzle');
  return p.answerFor(p.puzzleNumber(Date.now() + offset));
}

const count = (page) => page.locator('#historyWrap .row').count();
const step = (msg) => console.log(`  ✓ ${msg}`);
const servers = [];
process.on('exit', () => servers.forEach((s) => s.stop()));

(async () => {
  require('node:fs').mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const ctxOpts = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

  // ---------------- main flow ----------------
  const srv = await startServer(4701);
  const ctx = await browser.newContext({ ...ctxOpts, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  await page.goto(srv.url);

  await page.waitForSelector('#helpDialog[open]');
  await page.screenshot({ path: `${SHOTS}/1-how-to-play.png` });
  await page.click('.close-btn');
  step('How to play dialog opens on first visit');
  const puzzleNo = (await page.textContent('#puzzleNo')).replace('#', '');
  await page.screenshot({ path: `${SHOTS}/2-empty.png` });

  // Submits a word; waits for the server round-trip unless the client handles it locally.
  const guess = async (w, { local = false } = {}) => {
    await page.fill('#guessInput', w);
    const done = local ? Promise.resolve() : page.waitForEvent('requestfinished', (r) => r.url().includes('/api/guess')).catch(() => {});
    const failed = local ? null : page.waitForEvent('requestfailed', (r) => r.url().includes('/api/guess')).catch(() => {});
    await page.press('#guessInput', 'Enter');
    if (!local) await Promise.race([done, failed]);
    await page.waitForFunction(() => document.querySelector('#guessBtn').textContent === 'Guess');
  };

  for (const w of ['music', '  River ', 'tree', 'happy', 'cloud', 'water', 'journey']) await guess(w);
  assert.equal(await count(page), 7);
  const scores = await page.$$eval('#historyWrap .score', (n) => n.map((x) => +x.textContent));
  assert.deepEqual(scores, scores.slice().sort((a, b) => b - a));
  assert.equal(await page.locator('#historyWrap .row.is-latest .word').textContent(), 'journey');
  assert.equal(await page.locator('#latestWrap .word').textContent(), 'journey');
  step('guesses scored, sorted closest-first, latest highlighted and pinned');

  // Guess button (click) also works; input normalised
  await page.fill('#guessInput', 'MOUNTAIN');
  await page.click('#guessBtn');
  await page.waitForFunction(() => document.querySelectorAll('#historyWrap .row').length === 8);
  step('Guess button submits; capitalisation normalised');

  await guess('MUSIC', { local: true });
  assert.equal(await count(page), 8);
  assert.match(await page.textContent('#message'), /already guessed “music”/);
  assert.equal(await page.locator('#historyWrap .row.is-latest .word').textContent(), 'music');
  assert.equal(await page.textContent('#guessCount'), '8');
  await page.screenshot({ path: `${SHOTS}/3-duplicate.png` });
  step('duplicate highlights existing result without counting');

  await guess('abc123', { local: true });
  assert.match(await page.textContent('#message'), /Letters only/);
  await guess('zzqxvbn');
  assert.match(await page.textContent('#message'), /don't know/);
  assert.equal(await count(page), 8);
  step('invalid and unknown words rejected with friendly messages');

  // scoring failure → retry, no guess consumed
  await page.route('**/api/guess', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"scoring_failed"}' }));
  await guess('sunset');
  assert.match(await page.textContent('#message'), /wasn’t counted/);
  assert.equal(await count(page), 8);
  await page.unroute('**/api/guess');
  await page.route('**/api/guess', (r) => r.abort());
  await guess('sunset');
  assert.match(await page.textContent('#message'), /Couldn’t reach the server/);
  assert.equal(await count(page), 8);
  await page.screenshot({ path: `${SHOTS}/4-retry.png` });
  await page.unroute('**/api/guess');
  await page.click('.retry-btn');
  await page.waitForFunction(() => document.querySelectorAll('#historyWrap .row').length === 9);
  step('scoring failure shows Retry without consuming a guess; Retry works');

  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#historyWrap .row').length === 9);
  assert.equal(await page.textContent('#guessCount'), '9');
  assert.equal(await page.textContent('#puzzleNo'), `#${puzzleNo}`);
  step('progress survives refresh');

  // win
  const answer = answerFor(0);
  await guess(` ${answer.toUpperCase()}`);
  await page.waitForSelector('#winPanel:not([hidden])');
  assert.equal(await page.textContent('#winTitle'), 'You found it in 10 guesses!');
  assert.equal(await page.isHidden('#guessForm'), true);
  assert.match(await page.textContent('#winPanel .countdown'), /^\d\d:\d\d:\d\d$/);
  await page.screenshot({ path: `${SHOTS}/5-won.png`, fullPage: true });
  step('exact answer wins; celebration + countdown shown');

  await page.click('#shareBtn');
  const shared = await page.evaluate(() => navigator.clipboard.readText());
  console.log('    share text:\n' + shared.split('\n').map((l) => '      ' + l).join('\n'));
  assert.match(shared, new RegExp(`Hot Word #${puzzleNo}`));
  assert.match(shared, /Found it in 10 guesses/);
  for (const w of [answer, 'music', 'river', 'journey', 'sunset']) assert.ok(!shared.toLowerCase().includes(w), `leaks ${w}`);
  step('share text copied, spoiler-free');

  await page.reload();
  await page.waitForSelector('#winPanel:not([hidden])');
  assert.equal(await count(page), 10);
  step('win state persists after refresh');
  srv.stop();
  await ctx.close();

  // ---------------- hint offer after 50 guesses ----------------
  {
    const srvH = await startServer(4703);
    const ctxH = await browser.newContext({ ...ctxOpts, permissions: ['clipboard-read', 'clipboard-write'] });
    await ctxH.addInitScript(() => localStorage.setItem('gettingWarmer:seenHelp', '1'));
    const ph = await ctxH.newPage();
    await ph.goto(srvH.url);
    await ph.waitForFunction(() => document.querySelector('#puzzleNo').textContent);
    const ans = answerFor(0);
    const words = require('node:fs').readFileSync(path.join(ROOT, 'data/vocab.txt'), 'utf8').split('\n')
      .slice(4000, 4060).filter((w) => w !== ans).slice(0, 50);
    for (const [i, w] of words.entries()) {
      await ph.fill('#guessInput', w);
      await ph.press('#guessInput', 'Enter');
      await ph.waitForFunction((n) => document.querySelectorAll('#historyWrap .row').length === n, i + 1);
      if (i === 48) assert.equal(await ph.isHidden('#hintOffer'), true, 'no offer before 50');
    }
    await ph.waitForSelector('#hintOffer:not([hidden])');
    assert.equal(await ph.isHidden('#hintBtn'), true);
    await ph.screenshot({ path: `${SHOTS}/8-hint-offer.png` });
    step('hint offer appears after 50 guesses');

    await ph.click('#hintNo');
    assert.equal(await ph.isHidden('#hintOffer'), true);
    assert.equal(await ph.isVisible('#hintBtn'), true);
    assert.equal(await ph.locator('#historyWrap .row').count(), 50);
    await ph.reload();
    await ph.waitForFunction(() => document.querySelectorAll('#historyWrap .row').length === 50);
    assert.equal(await ph.isHidden('#hintOffer'), true, 'declining is remembered');
    step('“No thanks” hides the offer (remembered), small “Get a hint” link stays');

    const best = +(await ph.textContent('#bestScore'));
    await ph.click('#hintBtn');
    await ph.waitForFunction(() => document.querySelectorAll('#historyWrap .row').length === 51);
    const hintRow = ph.locator('#historyWrap .row', { has: ph.locator('.tag') });
    assert.equal(await hintRow.count(), 1);
    const hintScore = +(await hintRow.locator('.score').textContent());
    assert.ok(hintScore > best, `hint ${hintScore} > best ${best}`);
    assert.match(await ph.textContent('#message'), /^Hint: “[a-z]+” scores \d+/);
    await ph.screenshot({ path: `${SHOTS}/9-hint-used.png` });
    step(`hint revealed a closer word (${best} → ${hintScore}), tagged and counted`);

    await ph.fill('#guessInput', ans);
    await ph.press('#guessInput', 'Enter');
    await ph.waitForSelector('#winPanel:not([hidden])');
    const text = await ph.evaluate(() => window.__gw.shareText());
    assert.match(text, /Found it in 52 guesses \(1 hint\)/);
    assert.ok(text.includes('💡1'));
    assert.ok(!text.includes(ans));
    step('share text notes the hint, still spoiler-free');
    await ctxH.close();
    srvH.stop();
  }

  // ---------------- rollover while page stays open ----------------
  const now = Date.now();
  const offset = Math.ceil(now / DAY) * DAY - now - 12000; // 12s before midnight UTC
  const srv2 = await startServer(4702, { CLOCK_OFFSET_MS: String(offset) });
  const ctx2 = await browser.newContext(ctxOpts);
  await ctx2.addInitScript(() => localStorage.setItem('gettingWarmer:seenHelp', '1'));
  const p2 = await ctx2.newPage();
  await p2.goto(srv2.url);
  await p2.waitForFunction(() => document.querySelector('#puzzleNo').textContent);
  const before = +(await p2.textContent('#puzzleNo')).slice(1);
  const oldAnswer = answerFor(offset);
  const t0 = Date.now();
  for (const [i, w] of ['music', oldAnswer].entries()) {
    await p2.fill('#guessInput', w);
    await p2.press('#guessInput', 'Enter');
    await p2.waitForFunction((n) => document.querySelectorAll('#historyWrap .row').length === n, i + 1);
  }
  console.log(`    (won ${Date.now() - t0} ms after load; waiting for midnight)`);
  await p2.waitForSelector('#winPanel:not([hidden])', { timeout: 5000 });
  await p2.waitForFunction((b) => document.querySelector('#puzzleNo').textContent === `#${b + 1}`, before, { timeout: 20000 });
  assert.equal(await p2.locator('#historyWrap .row').count(), 0);
  assert.equal(await p2.isVisible('#guessForm'), true);
  assert.equal(await p2.isHidden('#winPanel'), true);
  const stored = await p2.evaluate(() => JSON.parse(localStorage.getItem('gettingWarmer:v1')));
  assert.equal(stored.puzzle, before + 1);
  assert.equal(stored.guesses.length, 0);
  await p2.screenshot({ path: `${SHOTS}/6-after-rollover.png` });
  step(`midnight rollover with page open: #${before} → #${before + 1}, board reset`);
  srv2.stop();

  await browser.close();
  console.log('\nAll browser checks passed.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
