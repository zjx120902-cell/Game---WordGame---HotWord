(() => {
  'use strict';

  const STORAGE_KEY = 'gettingWarmer:v1';
  const $ = (id) => document.getElementById(id);
  const el = {
    puzzleNo: $('puzzleNo'), form: $('guessForm'), input: $('guessInput'), btn: $('guessBtn'),
    message: $('message'), stats: $('stats'), count: $('guessCount'), best: $('bestScore'),
    latestWrap: $('latestWrap'), latestList: $('latestList'), historyWrap: $('historyWrap'), list: $('guessList'),
    win: $('winPanel'), winTitle: $('winTitle'), winWord: $('winWord'), share: $('shareBtn'),
    help: $('helpBtn'), dialog: $('helpDialog'), toast: $('toast'),
    hintOffer: $('hintOffer'), hintYes: $('hintYes'), hintNo: $('hintNo'), hintBtn: $('hintBtn'),
  };

  // ---------- state ----------
  let state = blankState(null);
  let clockOffset = 0;   // serverNow - Date.now()
  let nextReset = 0;     // server timestamp of next 00:00 UTC
  let pending = false;
  let lastFailed = null; // word whose scoring failed, for Retry
  let rolloverCheck = false;
  let hintAfter = 50;    // from the server

  // Anonymous random ID for play statistics (no personal data).
  const playerId = (() => {
    const KEY = 'gettingWarmer:pid';
    try {
      let id = localStorage.getItem(KEY);
      if (!id) {
        const bytes = crypto.getRandomValues(new Uint8Array(12));
        id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem(KEY, id);
      }
      return id;
    } catch {
      return '';
    }
  })();
  const apiHeaders = (json) => ({ ...(json ? { 'Content-Type': 'application/json' } : {}), 'X-Player-Id': playerId });
  const postJson = (url, body) => fetch(url, { method: 'POST', headers: apiHeaders(true), body: JSON.stringify(body) });

  function blankState(puzzle) {
    return { puzzle, guesses: [], latest: null, won: false, hintOffer: null };
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
  }
  function loadSaved() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (s && Array.isArray(s.guesses)) return s;
    } catch { /* ignore */ }
    return null;
  }

  // ---------- helpers ----------
  const normalize = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();

  const LABELS = [[100, 'Found it'], [85, 'Burning'], [65, 'Hot'], [45, 'Warm'], [20, 'Cold'], [0, 'Freezing']];
  const labelFor = (score) => LABELS.find(([min]) => score >= min)[1];
  const EMOJI = { Freezing: '🧊', Cold: '🌬️', Warm: '🌤️', Hot: '🔥', Burning: '🌋', 'Found it': '🎯' };

  // cool → warm colour scale
  const STOPS = [[0, [91, 143, 214]], [25, [79, 179, 191]], [50, [233, 185, 73]], [70, [236, 138, 58]], [88, [220, 74, 50]], [100, [184, 50, 107]]];
  function colorFor(score) {
    for (let i = 1; i < STOPS.length; i++) {
      const [x1, c1] = STOPS[i];
      if (score <= x1) {
        const [x0, c0] = STOPS[i - 1];
        const t = (score - x0) / (x1 - x0);
        return `rgb(${c0.map((v, k) => Math.round(v + (c1[k] - v) * t)).join(',')})`;
      }
    }
    return 'rgb(184,50,107)';
  }

  function setMessage(text, { error = false, retry = false } = {}) {
    el.message.textContent = text;
    el.message.classList.toggle('error', error);
    if (retry) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'retry-btn';
      b.textContent = 'Retry';
      b.addEventListener('click', () => lastFailed && submit(lastFailed));
      el.message.append(b);
    }
  }

  let toastTimer;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
  }

  // ---------- rendering ----------
  function rowFor(g, { latest = false } = {}) {
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.word = g.word;
    if (latest) li.classList.add('is-latest');
    if (g.score === 100) li.classList.add('is-found');
    const label = labelFor(g.score);
    li.setAttribute('aria-label', `${g.word}${g.hint ? ' (hint)' : ''}: ${g.score} out of 100, ${label}`);
    li.innerHTML = `
      <span class="word"><span class="text"></span></span>
      <span class="meta"><span class="label"></span><span class="score"></span></span>
      <span class="bar" aria-hidden="true"><span class="fill"></span></span>`;
    li.querySelector('.word .text').textContent = g.word;
    if (g.hint) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'hint';
      li.querySelector('.word').append(tag);
    }
    li.querySelector('.label').textContent = label;
    li.querySelector('.score').textContent = g.score;
    const fill = li.querySelector('.fill');
    fill.style.setProperty('--w', `${Math.max(g.score, 2)}%`);
    fill.style.setProperty('--c', colorFor(g.score));
    return li;
  }

  function sortedGuesses() {
    return state.guesses.slice().sort((a, b) => b.score - a.score || a.n - b.n);
  }

  function render({ animateWord = null } = {}) {
    el.puzzleNo.textContent = state.puzzle ? `#${state.puzzle}` : '';
    const has = state.guesses.length > 0;
    el.stats.hidden = !has;
    el.count.textContent = state.guesses.length;
    el.best.textContent = has ? Math.max(...state.guesses.map((g) => g.score)) : '–';

    // latest guess, pinned above the list (hidden once won — the win panel takes over)
    el.latestList.replaceChildren();
    const latest = state.guesses.find((g) => g.word === state.latest);
    el.latestWrap.hidden = !latest || state.won || state.guesses.length < 2;
    if (latest && !el.latestWrap.hidden) el.latestList.append(rowFor(latest, { latest: true }));

    el.historyWrap.hidden = !has;
    el.list.replaceChildren(
      ...sortedGuesses().map((g) => {
        const li = rowFor(g, { latest: g.word === state.latest });
        if (g.word === animateWord) li.classList.add('enter');
        return li;
      })
    );

    // hints: a one-time offer after N guesses, then an unobtrusive link
    const hintUnlocked = !state.won && state.guesses.length >= hintAfter;
    el.hintOffer.hidden = !hintUnlocked || !!state.hintOffer;
    el.hintBtn.hidden = !hintUnlocked || !state.hintOffer;

    // win state
    document.body.classList.toggle('is-won', state.won);
    el.win.hidden = !state.won;
    el.form.hidden = state.won;
    if (state.won) {
      const n = state.guesses.length;
      el.winTitle.textContent = `You found it in ${n} ${n === 1 ? 'guess' : 'guesses'}!`;
      el.winWord.textContent = state.guesses.find((g) => g.score === 100)?.word ?? '';
    }
  }

  function flashRow(word) {
    const row = el.list.querySelector(`[data-word="${CSS.escape(word)}"]`);
    if (!row) return;
    row.classList.remove('flash');
    void row.offsetWidth; // restart animation
    row.classList.add('flash');
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---------- puzzle / clock ----------
  async function fetchPuzzle() {
    const res = await fetch('/api/puzzle', { cache: 'no-store', headers: apiHeaders(false) });
    if (!res.ok) throw new Error('puzzle');
    const info = await res.json();
    applyPuzzleInfo(info);
    return info;
  }

  function applyPuzzleInfo(info) {
    clockOffset = info.serverNow - Date.now();
    if (info.hintAfter) hintAfter = info.hintAfter;
    nextReset = info.nextReset;
    if (state.puzzle !== info.puzzle) {
      const isRollover = state.puzzle !== null;
      state = blankState(info.puzzle);
      lastFailed = null;
      save();
      setMessage('');
      el.input.value = '';
      render();
      if (isRollover) toast('A new puzzle is ready!');
    }
    tick();
  }

  const serverNow = () => Date.now() + clockOffset;

  function tick() {
    const left = nextReset - serverNow();
    const text = left > 0 ? formatDuration(left) : '00:00:00';
    document.querySelectorAll('[data-countdown]').forEach((n) => (n.textContent = text));
    if (left <= 0 && nextReset && !rolloverCheck) checkRollover();
  }

  async function checkRollover() {
    rolloverCheck = true;
    try {
      await fetchPuzzle();
    } catch { /* offline — try again shortly */ }
    // if the server hasn't flipped yet (small clock skew), the next tick retries
    setTimeout(() => (rolloverCheck = false), 2000);
  }

  function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  }

  // ---------- guessing ----------
  async function submit(raw) {
    if (pending || state.won) return;
    const word = normalize(raw);
    if (!word) return setMessage('Type a word first.', { error: true });
    if (word.includes(' ')) return setMessage('Just one word at a time, please.', { error: true });
    if (!/^[a-z]+$/.test(word)) return setMessage('Letters only — no numbers or symbols.', { error: true });

    const existing = state.guesses.find((g) => g.word === word);
    if (existing) {
      el.input.value = '';
      setMessage(`You already guessed “${word}” — it scored ${existing.score}.`);
      state.latest = word;
      save();
      render();
      flashRow(word);
      return;
    }

    pending = true;
    el.btn.disabled = true;
    el.btn.textContent = '…';
    setMessage('');

    let res, data;
    try {
      res = await postJson('/api/guess', { guess: word, puzzle: state.puzzle });
      data = await res.json().catch(() => ({}));
    } catch {
      res = null;
    } finally {
      pending = false;
      el.btn.disabled = false;
      el.btn.textContent = 'Guess';
    }

    if (!res) {
      lastFailed = word;
      return setMessage('Couldn’t reach the server. That guess wasn’t counted.', { error: true, retry: true });
    }
    if (res.status === 409 && data.puzzle) {
      applyPuzzleInfo(data);
      return setMessage('A new puzzle started — your guess wasn’t counted. Try again!');
    }
    if (res.status === 503) {
      lastFailed = word;
      const detail = data.error === 'model_not_configured' ? ` (${data.message})` : '';
      return setMessage(`Scoring is unavailable right now. That guess wasn’t counted.${detail}`, { error: true, retry: true });
    }
    if (!res.ok) {
      return setMessage(data.message || 'That didn’t work. Try another word.', { error: true });
    }

    lastFailed = null;
    // A slow request could land after a duplicate was added in another tab/press.
    if (state.guesses.some((g) => g.word === data.word)) return;

    state.guesses.push({ word: data.word, score: data.score, n: state.guesses.length + 1 });
    state.latest = data.word;
    if (data.correct) state.won = true;
    save();
    el.input.value = '';
    render({ animateWord: data.word });
    if (!data.correct) el.input.focus();
  }

  // ---------- hints ----------
  async function requestHint() {
    if (pending || state.won) return;
    pending = true;
    el.hintYes.disabled = el.hintBtn.disabled = true;
    setMessage('Finding a hint…');
    let res, data;
    try {
      res = await postJson('/api/hint', { puzzle: state.puzzle, guessed: state.guesses.map((g) => g.word) });
      data = await res.json().catch(() => ({}));
    } catch {
      res = null;
    } finally {
      pending = false;
      el.hintYes.disabled = el.hintBtn.disabled = false;
    }
    if (!res) return setMessage('Couldn’t reach the server. Try the hint again in a moment.', { error: true });
    if (res.status === 409 && data.puzzle) return applyPuzzleInfo(data);
    if (!res.ok) return setMessage(data.message || 'No hint available right now.', { error: !(res.status === 404) });
    if (state.guesses.some((g) => g.word === data.word)) return;

    state.guesses.push({ word: data.word, score: data.score, n: state.guesses.length + 1, hint: true });
    state.latest = data.word;
    state.hintOffer = 'used';
    save();
    setMessage(`Hint: “${data.word}” scores ${data.score}. Keep going!`);
    render({ animateWord: data.word });
  }

  function declineHint() {
    state.hintOffer = 'declined';
    save();
    render();
    postJson('/api/event', { type: 'hint_declined', puzzle: state.puzzle }).catch(() => {});
    el.input.focus();
  }

  // ---------- sharing ----------
  function shareText() {
    const n = state.guesses.length;
    const ordered = state.guesses.slice().sort((a, b) => a.n - b.n);
    const hints = state.guesses.filter((g) => g.hint).length;
    const hintNote = hints ? ` (${hints} ${hints === 1 ? 'hint' : 'hints'})` : '';
    const lines = [`Hot Word #${state.puzzle}`, `Found it in ${n} ${n === 1 ? 'guess' : 'guesses'}${hintNote}`];
    const icon = (g) => (g.hint ? '💡' : EMOJI[labelFor(g.score)]);
    if (n <= 30) {
      lines.push(ordered.map(icon).join(''));
    } else {
      const counts = {};
      for (const g of ordered) if (!g.hint && g.score < 100) counts[labelFor(g.score)] = (counts[labelFor(g.score)] || 0) + 1;
      const parts = ['Freezing', 'Cold', 'Warm', 'Hot', 'Burning'].filter((l) => counts[l]).map((l) => `${EMOJI[l]}${counts[l]}`);
      if (hints) parts.push(`💡${hints}`);
      lines.push(parts.join(' ') + ' 🎯');
    }
    if (!/^(localhost|127\.)/.test(location.hostname)) lines.push(location.origin);
    return lines.join('\n');
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      return ok;
    }
  }

  // ---------- events ----------
  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(el.input.value);
  });
  el.input.addEventListener('input', () => {
    if (el.message.classList.contains('error')) setMessage('');
  });
  el.share.addEventListener('click', async () => {
    const ok = await copy(shareText());
    toast(ok ? 'Copied to clipboard' : 'Couldn’t copy — try again');
  });
  el.hintYes.addEventListener('click', requestHint);
  el.hintBtn.addEventListener('click', requestHint);
  el.hintNo.addEventListener('click', declineHint);
  el.help.addEventListener('click', () => el.dialog.showModal());
  el.dialog.addEventListener('click', (e) => { if (e.target === el.dialog) el.dialog.close(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) fetchPuzzle().catch(() => {});
  });

  // ---------- boot ----------
  async function boot() {
    const saved = loadSaved();
    if (saved) state = saved;
    try {
      await fetchPuzzle(); // resets state if the saved puzzle is from another day
    } catch {
      setMessage('Couldn’t load today’s puzzle. Check your connection and refresh.', { error: true });
    }
    render();
    tick();
    setInterval(tick, 1000);
    let firstVisit = false;
    try {
      firstVisit = !localStorage.getItem('gettingWarmer:seenHelp');
      localStorage.setItem('gettingWarmer:seenHelp', '1');
    } catch { /* ignore */ }
    if (firstVisit && !state.guesses.length) el.dialog.showModal();
    else if (!state.won) el.input.focus({ preventScroll: true });
  }

  window.__gw = { shareText, getState: () => state }; // used by the automated tests
  boot();
})();
