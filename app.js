import { Chess } from './vendor/chess.js';
import { Chessground } from './vendor/chessground.min.js';
import { PUZZLES } from './puzzles.js';
import { POLGAR } from './polgar.js';
import { canMate, allRepliesLose } from './matesolver.js';
import { STRATEGIC } from './strategic.js';
import * as review from './strategic_review.js';
import { Stockfish, Maia, MAIA_MB, SF_MB, sfFull, sampleMove } from './engines.js';

const SET_SIZE = 10;
const MODE_KEY = 'drills-mode';
const MODES = {
  mate: { pool: PUZZLES, key: 'mate-drills-v1', title: 'Mates' },
  strategy: { pool: STRATEGIC, key: 'strategy-drills-v1', title: 'Strategy Puzzles' },
  // Everything the current miner settings keep for the last 30 days, with each check's values.
  // browse: the whole pool as a numbered, filterable list instead of random sets of 10.
  review: { pool: review.STRATEGIC_REVIEW, config: review.STRATEGIC_REVIEW_CONFIG, key: 'review-drills-v4', title: 'Review: mined problems', browse: true },
};
let mode = (() => {
  try { const m = localStorage.getItem(MODE_KEY); return MODES[m] ? m : 'mate'; } catch { return 'mate'; }
})();
// Mate mode is split into sections, each with its own progress.
// Patterns: random sets of 10. Polgár (ordered): every problem, in book order, as one numbered list.
const SECTION_KEY = 'mate-section';
const polgar = (n) => POLGAR.filter((p) => p.mate === n);
const SECTIONS = {
  classic: { pool: PUZZLES, key: 'mate-drills-v1', label: 'Patterns', about: 'Classic mating patterns' },
  m1: { pool: polgar(1), key: 'mate-polgar-m1-v2', label: 'Mate in 1', about: 'Polgár: mate in one', ordered: true },
  m2: { pool: polgar(2), key: 'mate-polgar-m2-v2', label: 'Mate in 2', about: 'Polgár: mate in two', ordered: true },
  m3: { pool: polgar(3), key: 'mate-polgar-m3-v2', label: 'Mate in 3', about: 'Polgár: mate in three', ordered: true },
};
const isOrdered = () => mode === 'mate' && !!SECTIONS[section].ordered;
let section = (() => {
  try { const s = localStorage.getItem(SECTION_KEY); return SECTIONS[s] ? s : 'classic'; } catch { return 'classic'; }
})();
const pool = () => (mode === 'mate' ? SECTIONS[section].pool : MODES[mode].pool);
const setKey = () => (mode === 'mate' ? SECTIONS[section].key : MODES[mode].key);
const isStrategy = () => mode !== 'mate'; // strategy and review share the one-move flow

// Strategy problems: grade the first move from precomputed centipawn losses.
const LABELS = [[10, 'Best'], [30, 'Good'], [75, 'Inaccuracy'], [150, 'Mistake']];
const labelFor = (cp) => (LABELS.find(([lim]) => cp <= lim) || [0, 'Blunder'])[1];
const STRATEGY_OK = 30; // Best or Good counts as solved
const SOLUTION_PLIES = 10; // how much of the engine line Solution plays out

const $ = (id) => document.getElementById(id);

// ---------- solve timer (strategy): your thinking time here vs. in the game ----------
// Counts only while the page is visible. Saved per problem id the first time it's finished.
const TIMES_KEY = 'strategy-times-v1';
const times = (() => { try { return JSON.parse(localStorage.getItem(TIMES_KEY)) || {}; } catch { return {}; } })();
let timing = false, thinkMs = 0, since = 0;
function timerStart() { timing = true; thinkMs = 0; since = performance.now(); }
document.addEventListener('visibilitychange', () => {
  if (!timing) return;
  if (document.hidden) thinkMs += performance.now() - since; else since = performance.now();
});
function recordTime(how) {
  if (!timing) return;
  if (!document.hidden) thinkMs += performance.now() - since;
  timing = false;
  times[puzzle.id] = { ms: Math.round(thinkMs), how, tries: mistakes };
  try { localStorage.setItem(TIMES_KEY, JSON.stringify(times)); } catch {}
}
// 1.4s, 21s, 1:12
function fmtSecs(s) {
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const r = Math.round(s);
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`;
}
const fmtClock = (s) => { const r = Math.floor(s); return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`; };
const boardEl = $('board');

// ---------- mate solver (small depths only) ----------
function shortestMate(game, max) {
  for (let k = 1; k <= max; k++) {
    const m = canMate(game, k);
    if (m) return { k, move: m };
  }
  return null;
}
function stubbornReply(game, max) {
  let best = null, bestK = -1;
  for (const r of game.moves({ verbose: true })) {
    game.move(r);
    const s = shortestMate(game, max);
    game.undo();
    const k = s ? s.k : 99;
    if (k > bestK) { bestK = k; best = r; }
  }
  return best;
}
const uci = (m) => m.from + m.to + (m.promotion || '');

// ---------- state ----------
let state; // built by setMode() at startup
let game, puzzle, player, busy, hints, verdict, mistakes, usedHelp, shownFen, shownSolution;
// Stepping back through the line: { ply, fen } shows the position after `ply` moves while
// the line itself stays as entered. `fen` is the live position when the view was set, so any
// change to the line (a move, Undo, a new puzzle…) drops back to the live position.
let view = null;
// Board seen from the other side (X / F or the flip button). Each new puzzle starts unflipped,
// with the side to move at the bottom.
let flipped = false;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function newSet() {
  if (isBrowse()) return browseState();
  const all = pool().map((p) => p.id);
  const ids = isOrdered() ? all : shuffle(all).slice(0, SET_SIZE);
  return { ids, results: Array(ids.length).fill(null), index: 0 };
}
function loadState() {
  if (isBrowse()) return browseState();
  try {
    const s = JSON.parse(localStorage.getItem(setKey()));
    const n = isOrdered() ? pool().length : Math.min(SET_SIZE, pool().length);
    const known = new Set(pool().map((p) => p.id));
    if (s && Array.isArray(s.ids) && s.ids.length === n && s.ids.every((id) => known.has(id))) return s;
  } catch {}
  return null;
}
function saveState() {
  if (isBrowse()) {
    state.ids.forEach((id, i) => { if (state.results[i]) store.done[id] = state.results[i]; });
    store.current = state.ids[state.index];
    try { localStorage.setItem(MODES[mode].key, JSON.stringify(store)); } catch {}
    refreshStatusCounts();
    return;
  }
  try { localStorage.setItem(setKey(), JSON.stringify(state)); } catch {}
}

// ---------- browse mode (Review): numbered list + filters ----------
const isBrowse = () => !!MODES[mode].browse;
// Permanent numbers: position in the exported file (#1..#N). A re-export renumbers.
const numOf = new Map();
for (const m of Object.values(MODES)) if (m.browse) m.pool.forEach((p, i) => numOf.set(p.id, i + 1));
const KIND_LABEL = { single: 'regular', typical: 'typical', easy_miss: 'easy miss', blunder_check: 'blunder check', drift: 'drift' };
// Rating-trend flags from the miner (stratmine/flags.py): how p(best) changes with Elo.
const TREND_LABEL = { rating_sensitive: 'rating-sensitive', engine_move: 'engine move?', none: 'no trend' };
const TREND_TEXT = {
  rating_sensitive: 'Rating-sensitive: stronger players find the best move much more often (a learnable skill, not taste).',
  engine_move: 'Engine move?: stronger players find the best move less often; strong humans may avoid it.',
};
const trendOf = (p) => (p.flags && p.flags[0]) || 'none';
const NATURE_LABEL = { positional: 'positional', positional_then_material: 'positional → material', concrete: 'concrete', marginal: 'marginal' };
const STATUS_LABEL = { clean: '✓ clean', helped: '✓ with help', revealed: 'revealed' };
const FILTERS = {
  cat: { label: 'all categories', of: (p) => p.kind, name: (v) => KIND_LABEL[v] || v },
  nature: { label: 'all verdicts', of: (p) => p.nature && p.nature.kind, name: (v) => NATURE_LABEL[v] || v },
  trend: { label: 'any trend', of: trendOf, name: (v) => TREND_LABEL[v] || v },
  changed: {
    label: 'any',
    of: (p) => (!p.changed || p.nature.kind === 'marginal' ? 'n/a'
      : p.changed.explains && p.changed.terms.length ? p.changed.terms[0][0] : 'not explained'),
    name: (v) => (TERM_NAMES[v] || v),
  },
  tc: {
    label: 'all time formats',
    // "bullet" or "bullet 2+1": a class matches all its time controls
    of: (p) => `${p.timeClass} ${fmtTimeControl(p.timeControl)}`.trim(),
    match: (p, v) => (v.includes(' ') ? FILTERS.tc.of(p) === v : p.timeClass === v),
  },
  status: {
    label: 'any status',
    of: (p) => store.done[p.id] || 'todo',
    match: (p, v) => (v === 'done' ? !!store.done[p.id] : (store.done[p.id] || 'todo') === v),
  },
  fb: {
    label: 'any feedback',
    of: (p) => fbOf(p)?.rating || 'unrated',
    name: (v) => FB_RATING[v] || 'not rated',
  },
  fav: {
    label: 'all problems',
    of: (p) => (isFav(p) ? 'yes' : 'no'),
    name: (v) => (v === 'yes' ? '★ favorites' : 'not favorited'),
  },
};

// ---------- favorites (Review): problems starred for later analysis ----------
// Keyed like feedback (game link + FEN) so stars survive a re-export.
const FAV_KEY = 'review-favorites-v1';
let favorites = (() => { try { return JSON.parse(localStorage.getItem(FAV_KEY)) || {}; } catch { return {}; } })();
const isFav = (p) => !!favorites[fbKey(p)];
function renderFav() {
  const b = $('fav');
  b.hidden = !isBrowse();
  if (!isBrowse()) return;
  const on = isFav(puzzle);
  b.setAttribute('aria-pressed', String(on));
  b.textContent = on ? '★ Favorited' : '☆ Favorite';
  b.title = on ? 'Remove from favorites' : 'Favorite this problem for later analysis';
}
$('fav').addEventListener('click', () => {
  const k = fbKey(puzzle);
  if (favorites[k]) delete favorites[k];
  else favorites[k] = { at: new Date().toISOString(), id: puzzle.id, num: numOf.get(puzzle.id), fen: puzzle.fen, link: puzzle.link };
  try { localStorage.setItem(FAV_KEY, JSON.stringify(favorites)); } catch {}
  renderFav();
  refreshCounts('fav');
  renderProgress();
});

// ---------- feedback on Review problems (for tuning the miner: miner/feedback.py) ----------
// Keyed by game link + FEN, not the #number or id, so ratings survive a re-export.
// Each entry keeps a snapshot of the problem's mining values, so the file stands on its own.
const FB_KEY = 'review-feedback-v1';
const FB_RATING = { good: '👍 good', meh: '🤷 meh', bad: '👎 bad' };
// Tag keys are read by miner/feedback.py; keep them stable.
const FB_TAGS = [
  ['instructive', 'Instructive'],
  ['habit', 'A habit of mine'],
  ['tactical', 'Tactic, not strategy'],
  ['noise', 'My move was fine'],
  ['deep', 'Needs deep calculation'],
  ['obvious', 'Too obvious'],
  ['unclear', "Can't see why best is better"],
  ['engine_move', 'Engine-only move'],
  ['decided', 'Game already decided'],
  ['time', 'Time scramble'],
  ['wrong_verdict', 'Verdict/category wrong'],
  ['duplicate', 'Seen this one'],
];
const fbKey = (p) => `${p.link || ''}#${p.fen}`;
let feedback = (() => { try { return JSON.parse(localStorage.getItem(FB_KEY)) || {}; } catch { return {}; } })();
const fbOf = (p) => feedback[fbKey(p)];
function fbSave() { try { localStorage.setItem(FB_KEY, JSON.stringify(feedback)); } catch {} }
function fbSnapshot(p) {
  return {
    id: p.id, num: numOf.get(p.id), fen: p.fen, link: p.link, date: p.date,
    played: p.played, minedBest: p.minedBest, best: p.line[0],
    kind: p.kind, timeClass: p.timeClass, timeControl: p.timeControl, maiaElo: p.maiaElo,
    pPlayed: p.pPlayed, pBest: p.pBest, pBestPlus: p.pBestPlus, pBestTop: p.pBestTop ?? null, flags: p.flags ?? null, checks: p.checks,
    playedLossNow: p.scores[p.played] ?? null,
    nature: p.nature?.kind ?? null,
    changedTop: p.changed?.explains && p.changed.terms.length ? p.changed.terms[0][0] : null,
    gameClock: p.gameClock ?? null,
  };
}
function fbUpdate(change, p = puzzle) {
  const k = fbKey(p);
  const cur = feedback[k] || { rating: null, tags: [], note: '' };
  const next = { ...cur, ...change, at: new Date().toISOString(), problem: fbSnapshot(p) };
  if (!next.rating && !next.tags.length && !next.note.trim()) delete feedback[k];
  else feedback[k] = next;
  fbSave();
  renderFeedback();
  refreshCounts('fb');
  renderProgress();
  if (p === puzzle) $('fb-saved').textContent = feedback[k] ? '· saved' : '';
}
function renderFeedback() {
  const box = $('fb');
  box.hidden = !isBrowse();
  if (!isBrowse()) return;
  const f = fbOf(puzzle) || { rating: null, tags: [], note: '' };
  for (const b of box.querySelectorAll('.fb-verdict button')) b.setAttribute('aria-pressed', String(f.rating === b.dataset.v));
  for (const b of $('fb-tags').children) b.setAttribute('aria-pressed', String(f.tags.includes(b.dataset.t)));
  if (document.activeElement !== $('fb-note')) $('fb-note').value = f.note || '';
  const n = Object.keys(feedback).length;
  $('fb-count').textContent = n ? `${n} rated` : 'No feedback yet';
  $('fb-export').disabled = !n;
}
for (const [t, text] of FB_TAGS) {
  const b = document.createElement('button');
  b.type = 'button'; b.dataset.t = t; b.textContent = text; b.setAttribute('aria-pressed', 'false');
  b.addEventListener('click', () => {
    const tags = (fbOf(puzzle)?.tags || []).slice();
    const i = tags.indexOf(t);
    if (i >= 0) tags.splice(i, 1); else tags.push(t);
    fbUpdate({ tags });
  });
  $('fb-tags').append(b);
}
for (const b of document.querySelectorAll('.fb-verdict button')) {
  b.addEventListener('click', () => fbUpdate({ rating: fbOf(puzzle)?.rating === b.dataset.v ? null : b.dataset.v }));
}
let noteTimer;
$('fb-note').addEventListener('input', () => {
  clearTimeout(noteTimer);
  const p = puzzle, note = $('fb-note').value;
  noteTimer = setTimeout(() => fbUpdate({ note }, p), 400);
});
$('fb-note').addEventListener('blur', () => { clearTimeout(noteTimer); if (($('fb-note').value) !== (fbOf(puzzle)?.note || '')) fbUpdate({ note: $('fb-note').value }); });
$('fb-note').addEventListener('keydown', (e) => e.stopPropagation()); // don't trigger board shortcuts
$('fb-export').addEventListener('click', () => {
  const data = {
    format: 'review-feedback', version: 1, exported: new Date().toISOString(),
    config: MODES.review.config || null, entries: feedback,
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  a.download = `review-feedback-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('fb-import').addEventListener('click', () => $('fb-file').click());
$('fb-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.format !== 'review-feedback' || !data.entries) throw new Error('not a feedback export');
    let added = 0;
    for (const [k, v] of Object.entries(data.entries)) {  // newer rating wins
      if (!feedback[k] || (v.at || '') > (feedback[k].at || '')) { feedback[k] = v; added++; }
    }
    fbSave();
    renderFeedback(); refreshCounts('fb'); renderProgress();
    setStatus(`Imported ${added} rating(s) from ${file.name}.`, 'good');
  } catch (err) {
    setStatus(`Couldn't import ${file.name}: ${err.message}.`, 'bad');
  }
});
let store = { done: {}, filters: {}, current: null };
function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(MODES[mode].key));
    if (s && s.done) store = { done: s.done, filters: s.filters || {}, current: s.current || null };
  } catch {}
}
function filtered() {
  return pool().filter((p) => Object.entries(store.filters).every(([k, v]) =>
    !v || (FILTERS[k].match ? FILTERS[k].match(p, v) : FILTERS[k].of(p) === v)));
}
function browseState() {
  let list = filtered();
  if (!list.length) { store.filters = {}; list = pool(); }
  const ids = list.map((p) => p.id);
  const index = Math.max(0, ids.indexOf(store.current));
  return { ids, results: ids.map((id) => store.done[id] || null), index };
}
function fillFilters() {
  for (const [k, f] of Object.entries(FILTERS)) {
    const sel = $(`f-${k}`);
    sel.textContent = '';
    const add = (value, text) => {
      const o = document.createElement('option');
      o.value = value; o.textContent = text;
      sel.append(o);
    };
    add('', f.label);
    if (k === 'status') {
      const n = (v) => pool().filter((p) => FILTERS.status.match(p, v)).length;
      for (const v of ['todo', 'done', 'clean', 'helped', 'revealed']) {
        add(v, `${v === 'todo' ? 'not done' : v === 'done' ? 'done (any)' : STATUS_LABEL[v]} (${n(v)})`);
      }
    } else if (k === 'fb') {
      const n = (v) => pool().filter((p) => f.of(p) === v).length;
      for (const v of ['unrated', 'good', 'meh', 'bad']) add(v, `${f.name(v)} (${n(v)})`);
    } else if (k === 'fav') {
      const n = (v) => pool().filter((p) => f.of(p) === v).length;
      for (const v of ['yes', 'no']) add(v, `${f.name(v)} (${n(v)})`);
    } else if (k === 'tc') {
      const byClass = {};
      for (const p of pool()) {
        byClass[p.timeClass] ??= {};
        const t = f.of(p);
        byClass[p.timeClass][t] = (byClass[p.timeClass][t] || 0) + 1;
      }
      for (const [cls, tcs] of Object.entries(byClass)) {
        const total = Object.values(tcs).reduce((x, y) => x + y, 0);
        add(cls, `${cls}, all (${total})`);
        for (const [t, c] of Object.entries(tcs).sort((x, y) => y[1] - x[1])) add(t, `  ${t} (${c})`);
      }
    } else {
      const counts = {};
      for (const p of pool()) { const v = f.of(p); counts[v] = (counts[v] || 0) + 1; }
      for (const [v, c] of Object.entries(counts).sort((x, y) => y[1] - x[1])) add(v, `${f.name(v)} (${c})`);
    }
    sel.value = store.filters[k] || '';
  }
}
function refreshStatusCounts() { refreshCounts('status'); }
function refreshCounts(k) {
  const f = FILTERS[k];
  const sel = $(`f-${k}`);
  for (const o of sel.options) {
    if (!o.value) continue;
    const n = pool().filter((p) => (f.match ? f.match(p, o.value) : f.of(p) === o.value)).length;
    o.textContent = o.textContent.replace(/\(\d+\)$/, `(${n})`);
  }
}
let rowEls = [];
function buildList() {
  const ol = $('browser-list');
  ol.textContent = '';
  rowEls = state.ids.map((id, i) => {
    const p = pool().find((x) => x.id === id);
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    const n = document.createElement('span'); n.className = 'n'; n.textContent = `#${numOf.get(id)}`;
    const meta = document.createElement('span'); meta.className = 'meta';
    meta.textContent = [p.date, FILTERS.tc.of(p), KIND_LABEL[p.kind] || p.kind,
      p.nature ? NATURE_LABEL[p.nature.kind] : '', trendOf(p) !== 'none' ? TREND_LABEL[trendOf(p)] : '']
      .filter(Boolean).join(' · ');
    const st = document.createElement('span'); st.className = 'st';
    b.append(n, meta, st);
    b.addEventListener('click', () => !busy && loadPuzzle(i));
    li.append(b);
    ol.append(li);
    return b;
  });
  const total = pool().length;
  $('browser-summary').textContent = state.ids.length === total
    ? `Problems (${total})` : `Problems (${state.ids.length} of ${total} match)`;
}
function applyFilters() {
  saveState();
  for (const k of Object.keys(FILTERS)) store.filters[k] = $(`f-${k}`).value;
  if (!filtered().length) {
    $('browser-summary').textContent = 'No problems match these filters';
    return;
  }
  state = browseState();
  saveState();
  buildList();
  loadPuzzle(state.index);
}
for (const k of Object.keys(FILTERS)) $(`f-${k}`).addEventListener('change', () => !busy && applyFilters());
$('f-reset').addEventListener('click', () => {
  if (busy) return;
  for (const k of Object.keys(FILTERS)) $(`f-${k}`).value = '';
  applyFilters();
});
$('f-go').addEventListener('submit', (e) => {
  e.preventDefault();
  if (busy) return;
  const n = +$('f-num').value;
  const p = pool()[n - 1];
  if (!p) { setStatus(`There is no problem #${n} (1–${pool().length}).`, 'bad'); return; }
  if (!state.ids.includes(p.id)) {  // outside the current filters: clear them
    for (const k of Object.keys(FILTERS)) $(`f-${k}`).value = '';
    store.current = p.id;
    applyFilters();
  }
  loadPuzzle(state.ids.indexOf(p.id));
  rowEls[state.index]?.scrollIntoView({ block: 'nearest' });
});

// ---------- puzzle flow ----------
// Same cap for every puzzle so it doesn't reveal the solution length:
// the longest solution in the pool plus 3 extra moves.
// Strategy problems take one move: the decision itself (Solution may play more).
const MAX_PLIES = Math.max(...[...PUZZLES, ...POLGAR].map((p) => p.line.length)) + 3;
const maxPlies = () => (isStrategy() && !busy ? 1 : MAX_PLIES);
const plies = () => game.history().length;
const solved = () => verdict && verdict.ok;

function loadPuzzle(i) {
  endSpar();
  state.index = i;
  saveState();
  puzzle = pool().find((p) => p.id === state.ids[i]);
  game = new Chess(puzzle.fen);
  player = game.turn();
  busy = false;
  hints = [];
  verdict = null;
  mistakes = 0;
  shownFen = null;
  shownSolution = false;
  flipped = false;
  setDetail('');
  cg.setShapes([]);
  usedHelp = false;
  timing = false;
  if (isStrategy() && !state.results[i]) timerStart();
  $('title').textContent = isBrowse() ? `Problem #${numOf.get(puzzle.id)}`
    : isOrdered() ? `Puzzle ${i + 1} of ${state.ids.length} · ${puzzle.title}` : `Puzzle ${i + 1}`;
  // Category badge next to the title; its description is the hover tooltip.
  const kindText = isStrategy() && puzzle.kind ? KIND_TEXT[puzzle.kind] || puzzle.kind : '';
  $('kind').hidden = !kindText;
  $('kind').textContent = kindText ? KIND_LABEL[puzzle.kind] || puzzle.kind : '';
  const tip = kindText.replace(/^[^:]+:\s*/, '');
  $('kind').title = tip.charAt(0).toUpperCase() + tip.slice(1);
  $('kind').setAttribute('aria-label', kindText);
  const trend = isStrategy() ? trendOf(puzzle) : 'none';
  const trendText = TREND_TEXT[trend] || '';
  $('trend').hidden = !trendText;
  $('trend').textContent = trendText ? TREND_LABEL[trend] : '';
  const trendTip = trendText.replace(/^[^:]+:\s*/, '');
  $('trend').title = trendTip.charAt(0).toUpperCase() + trendTip.slice(1);
  $('trend').setAttribute('aria-label', trendText);
  const tc = puzzle.timeControl ? fmtTimeControl(puzzle.timeControl) : '';
  $('subtitle').textContent = `${side(player)} to move`
    + (puzzle.timeClass ? ` · ${puzzle.timeClass}${tc && tc !== 'daily' ? ` ${tc}` : ''}` : '');
  $('turn').className = `turn ${player}`;
  setStatus(state.results[i]
    ? 'Already done — play it again or move on.'
    : isStrategy()
      ? 'No tactics here: find the best plan. Play your move, then Submit.'
      : 'Find the best line. Play both sides, then Submit.');
  $('summary').hidden = true;
  // A finished strategy problem keeps showing its game info and checks when revisited.
  $('fb-saved').textContent = '';
  renderFeedback();
  renderFav();
  if (state.results[i] && isStrategy()) showGameDetail();
  else { showWhy(false); $('wrong').hidden = true; }
  // Snap to the new puzzle instead of animating from the previous position.
  cg.set({ animation: { enabled: false } });
  render();
  cg.set({ animation: { enabled: true } });
  renderSpar();
}

const side = (c) => (c === 'w' ? 'White' : 'Black');

function enterMove(from, to) {
  if (spar) return sparMove(from, to);
  if (busy || solved()) return false;
  // A move played while looking at an earlier position replaces the rest of the line.
  const at = viewPly();
  if (at < plies()) {
    const tail = game.history({ verbose: true }).slice(at);
    while (plies() > at) game.undo();
    if (!game.moves({ square: from, verbose: true }).some((m) => m.to === to)) {
      tail.forEach((m) => game.move(m));
      return false;
    }
    view = null;
  }
  if (plies() >= maxPlies()) return false;
  const legal = game.moves({ square: from, verbose: true }).filter((m) => m.to === to);
  if (!legal.length) return false;
  let promotion;
  if (legal[0].promotion) {
    const want = puzzle.line[plies()];
    promotion = want && want.slice(0, 4) === from + to && want[4] ? want[4] : 'q';
  }
  game.move({ from, to, promotion });
  hints = [];
  verdict = null; // editing the line clears an old verdict
  if (plies() >= maxPlies() || game.isGameOver()) setStatus('Ready — hit Submit.');
  else setStatus(`${side(game.turn())} to play.`);
  render();
  return true;
}

// Judge the entered line. Each of the solver's moves must keep a forced mate
// within the moves remaining; the defender's moves are free choices.
function evaluate(moves) {
  if (isStrategy()) return evaluateStrategy(moves);
  const g = new Chess(puzzle.fen);
  const marks = [];
  let ok = true, failAt = -1;
  moves.forEach((m, i) => {
    g.move(m);
    if (i % 2 === 1) { marks.push(null); return; }
    const remaining = puzzle.mate - (i / 2 + 1);
    // A mate that takes longer than the shortest forced mate doesn't count.
    const good = remaining >= 0 && (g.isCheckmate() || (remaining > 0 && !g.isGameOver() && allRepliesLose(g, remaining)));
    marks.push(good);
    if (!good && ok) { ok = false; failAt = i; }
  });
  const mated = g.isCheckmate();
  return { ok: ok && mated, incomplete: ok && !mated, failAt, marks };
}

// Strategy: only the first move is judged, against Stockfish's scores for every legal move.
function evaluateStrategy(moves) {
  const first = moves[0];
  const loss = puzzle.scores[uci(first)] ?? 1000;
  const good = loss <= STRATEGY_OK;
  const marks = moves.map((_, i) => (i === 0 ? good : null));
  return { ok: good, incomplete: false, failAt: good ? -1 : 0, marks, loss, label: labelFor(loss), san: first.san };
}

// Review: did the user just repeat the move they played in the original game?
const repeatsGameMove = (m) => mode === 'review' && !!puzzle.played && uci(m) === puzzle.played;
const RETHINK_TIPS = [
  'Your first instinct is the one that cost you. Take longer this time.',
  'Same idea as in the game. Look for a different plan, not just a different square.',
  "Before moving, ask: what does my opponent want here, and how does this move help them?",
  'Slow down: list every check, capture and threat for both sides, then compare candidates.',
  'Try ruling this move out first, then see what else the position offers.',
];
const rethinkTip = () => RETHINK_TIPS[mistakes % RETHINK_TIPS.length];

const sanOf = (fen, u) => {
  try { return new Chess(fen).move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san; } catch { return u; }
};
const fmtEval = (cp) => (cp >= 0 ? '+' : '\u2212') + (Math.abs(cp) / 100).toFixed(2);

// After a strategy problem is solved or revealed: the game move and a link to the game.
function showGameDetail() {
  const el = $('detail');
  el.textContent = '';
  const played = puzzle.played;
  const loss = puzzle.scores[played] ?? 1000;
  const best = sanOf(puzzle.fen, puzzle.line[0]);
  const whiteEval = player === 'w' ? puzzle.eval : -puzzle.eval;
  el.append(`Engine: ${best} (${fmtEval(whiteEval)}). In your ${puzzle.timeClass} game (${puzzle.date}) you played ${sanOf(puzzle.fen, played)}, \u2212${loss}cp. `);
  if (puzzle.link) {
    const a = document.createElement('a');
    a.href = puzzle.link; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = 'Open game';
    el.append(a);
  }
  const t = timeLine();
  if (t) el.append(document.createElement('br'), t);
  el.hidden = false;
  showWhy(true);
  showWrong();
}

// "In the game: 21s on this move (1:45 on the clock). Here: 1:12 to find it, 2 wrong tries."
function timeLine() {
  const g = puzzle.gameClock, t = times[puzzle.id];
  const parts = [];
  if (g) parts.push(`In the game: ${fmtSecs(g.spent)} on this move (${fmtClock(g.left)} on the clock).`);
  if (t) {
    const took = fmtSecs(t.ms / 1000);
    const tries = t.tries ? `, ${t.tries} wrong tr${t.tries > 1 ? 'ies' : 'y'}` : '';
    parts.push(t.how === 'revealed' ? `Here: revealed after ${took}${tries}.` : `Here: ${took} to find it${tries}.`);
  }
  return parts.join(' ');
}

// ---------- "What went wrong": punishment line + shallow-eval trace ----------
// Kind is decided by material (does the punishment actually win material vs the best line?);
// the eval trace only says when a quick look starts to see the damage.
const pawns = (k) => `${k} pawn${k > 1 ? 's' : ''}`;
const moves = (k) => `${k} move${k > 1 ? 's' : ''}`;

// Three short answers: what it costs, how hard it is to spot, what got worse.
function wrongRows() {
  const n = puzzle.nature, T = puzzle.trace;
  if (n.kind === 'marginal') {
    return [['Cost', `Barely a mistake: the engine rates your move only ${puzzle.scores[puzzle.played]}cp worse than the best.`]];
  }
  const cost = {
    positional: `No material lost in the next ${moves(T.punish.length)}. Your position just got worse.`,
    positional_then_material: `Nothing at first, but from ${n.matMove} you are ${pawns(n.matGap)} down compared with the best line.`,
    concrete: `Material, quickly: from ${n.matMove} you are ${pawns(n.matGap)} down compared with the best line.`,
  }[n.kind] || n.kind;
  // When a quick engine search (not a human) starts to see it; Maia p(best) is the human measure.
  const shows = n.turn == null
    ? `Deep: a quick engine search (depth 1–${T.depth}) never sees it in the next ${moves(T.punish.length)}.`
    : n.turn === 0
      ? `Right away: a quick engine search already sees it after ${n.move}.`
      : `Later: a quick engine search only sees it after ${n.move}, ${moves(n.turn)} later.`;
  const rows = [['Cost', cost], ['Shows up', shows]];
  const w = worsened();
  if (w) rows.push(['Got worse', w]);
  return rows;
}

// Classical (non-NNUE) eval terms: which positional factors the move gave away.
// Only shown when that eval agrees and accounts for a real share of the loss: on a sample it
// contradicted the main engine about a third of the time.
const TERM_NAMES = { 'King safety': 'king safety', Mobility: 'piece mobility', Threats: 'threats', Passed: 'passed pawns', Pawns: 'pawn structure', Bishops: 'bishops', Knights: 'knights', Rooks: 'rooks', Queens: 'queen', Space: 'space' };
function worsened() {
  const c = puzzle.changed;
  if (!c || !c.turns.length || !c.explains || !c.terms.length) return '';
  const names = c.terms.slice(0, 3).map(([k]) => TERM_NAMES[k] || k);
  return names.join(', ').replace(/^./, (s) => s.toUpperCase()) + '.';
}

function showWrong() {
  const box = $('wrong');
  if (!isStrategy() || !puzzle.trace || !puzzle.nature) { box.hidden = true; return; }
  const dl = $('wrong-text');
  dl.textContent = '';
  for (const [k, v] of wrongRows()) {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = k; dd.textContent = v;
    dl.append(dt, dd);
  }
  const c = puzzle.changed;
  if (c && c.explains && c.terms.length) {
    dl.lastChild.title = `Stockfish's classical eval, your moves ${c.turns.join(', ')}: `
      + c.terms.slice(0, 3).map(([k, v]) => `${TERM_NAMES[k] || k} −${v.toFixed(2)}`).join(', ');
  }
  drawTrace();
  $('wrong-note').textContent = `Quick-search eval after each of your next moves. Red: after your move. Green: after the best move. Ring: where a quick search first notices. Click a dot to see that position. Quick searches are noisy mid-exchange, so spikes can mislead.`;
  box.hidden = false;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
function drawTrace() {
  const T = puzzle.trace;
  const host = $('wrong-chart');
  host.textContent = '';
  const W = 260, H = 130, L = 30, R = 6, TOP = 8, B = 18;
  const n = Math.max(T.punish.length, T.best.length);
  const clamp = (v) => Math.max(-600, Math.min(600, v));
  const all = [...T.punish, ...T.best].map(clamp);
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 100) { hi += 50; lo -= 50; }
  const x = (t) => L + (n <= 1 ? 0 : (t * (W - L - R)) / (n - 1));
  const y = (v) => TOP + ((hi - clamp(v)) * (H - TOP - B)) / (hi - lo);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Eval at each of your turns' });
  const css = getComputedStyle(document.documentElement);
  const red = css.getPropertyValue('--bad').trim() || '#b9473d';
  const green = css.getPropertyValue('--accent').trim() || '#3f7d58';
  const muted = css.getPropertyValue('--muted').trim() || '#7a6f66';
  // zero line and labels
  if (lo < 0 && hi > 0) svg.append(svgEl('line', { x1: L, x2: W - R, y1: y(0), y2: y(0), stroke: muted, 'stroke-width': 0.5 }));
  for (const v of [hi, lo]) {
    const t = svgEl('text', { x: L - 4, y: y(v) + 3, 'text-anchor': 'end', 'font-size': 8, fill: muted });
    t.textContent = fmtEval(v);
    svg.append(t);
  }
  for (let t = 0; t < n; t++) {
    const lab = svgEl('text', { x: x(t), y: H - 4, 'text-anchor': 'middle', 'font-size': 8, fill: muted });
    lab.textContent = t + 1;
    svg.append(lab);
  }
  const series = [
    { vals: T.best, color: green, line: puzzle.line, name: 'best line' },
    { vals: T.punish, color: red, line: puzzle.punish, name: 'punishment' },
  ];
  for (const s of series) {
    svg.append(svgEl('polyline', { points: s.vals.map((v, t) => `${x(t)},${y(v)}`).join(' '), fill: 'none', stroke: s.color, 'stroke-width': 1.8 }));
    s.vals.forEach((v, t) => {
      const c = svgEl('circle', { cx: x(t), cy: y(v), r: 3.5, fill: s.color, class: 'pt' });
      const tip = svgEl('title', {});
      tip.textContent = `${s.name}, your move ${t + 1}: ${fmtEval(v)}`;
      c.append(tip);
      c.addEventListener('click', () => showLine(s.line, T.plies[t] ?? 2 * t + 1, false, s.name));
      svg.append(c);
    });
  }
  // Ring: where a quick search first notices.
  const crit = puzzle.nature.turn;
  if (crit != null && puzzle.nature.kind !== 'marginal') {
    svg.append(svgEl('circle', { cx: x(crit), cy: y(T.punish[crit]), r: 7, fill: 'none', stroke: red, 'stroke-width': 1.5 }));
  }
  host.append(svg);
}

// Show a line on the board (view only): up to and including index `upto`.
function showLine(line, upto, animate, name) {
  if (busy || !line) return;
  stopSpar();
  const end = Math.min(upto, line.length - 1);
  while (game.undo());
  hints = []; verdict = null; shownSolution = true;
  const push = (u) => game.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
  const mark = () => {
    const last = line[game.history().length - 1];
    const n = game.history().length - 1;
    const crit = puzzle.nature && line === puzzle.punish && (n === puzzle.nature.ply || n === puzzle.nature.matPly);
    hints = last ? [{ orig: last.slice(0, 2), dest: last.slice(2, 4), brush: crit ? 'red' : (game.turn() === player ? 'red' : 'green') }] : [];
  };
  if (!animate) {
    for (let k = 0; k <= end; k++) push(line[k]);
    mark();
    setStatus(`Showing the ${name} (${end + 1} plies).`);
    render();
    return;
  }
  busy = true;
  let k = 0;
  const step = () => {
    if (k <= end) {
      push(line[k++]);
      mark();
      render();
      setTimeout(step, 700);
    } else {
      busy = false;
      setStatus(`Shown: the ${name}.`);
      render();
    }
  };
  render();
  setTimeout(step, 250);
}
function setDetail(text) {
  const el = $('detail');
  el.textContent = text;
  el.hidden = !text;
}

// "Why this problem": every mining check with its value and threshold.
const KIND_TEXT = {
  single: 'Regular: the best move is findable at your level (Maia p between the limits).',
  typical: "Typical: your move was Maia's #1 prediction at your rating, so the minimum p(best) is waived.",
  easy_miss: 'Easy miss: most players at your rating find the best move (p above the upper limit).',
  blunder_check: 'Blunder check: a big loss (above the normal cp range) that still passes every other check, including the material rule.',
  drift: 'Drift: the worst move of four in a row that slowly lost ground.',
};
// Shown for every problem that has check data; move names only once it's finished.
function showWhy(finished) {
  const box = $('why');
  const C = MODES[mode].config;
  const K = puzzle && puzzle.checks;
  if (!isStrategy() || !C || !K) { box.hidden = true; return; }
  const list = $('why-list');
  list.textContent = '';
  const pct = (x) => `${x.toFixed(1)}%`; // exported as percentages already
  const add = (state, label, value) => {
    const li = document.createElement('li');
    const mark = document.createElement('span');
    mark.className = state === 'na' ? 'na' : 'ok';
    mark.textContent = state === 'na' ? '–' : '✓';
    const text = document.createElement('span');
    text.append(label + ' ');
    const sm = document.createElement('small');
    sm.textContent = value;
    text.append(sm);
    li.append(mark, text);
    list.append(li);
  };
  const plies = C.forcing_plies;
  add('ok', 'Category:', KIND_TEXT[puzzle.kind] || puzzle.kind);
  add('ok', `cp loss ${K.cpLoss}`, C.blunder && C.blunder_max > C.cp_max
    ? `(normal ${C.cp_min}–${C.cp_max}; blunder check up to ${C.blunder_max})`
    : `(allowed ${C.cp_min}–${C.cp_max})`);
  add('ok', `Position was balanced: eval ${fmtEval(K.evalBefore)} for you`, `(limit ±${(C.max_eval / 100).toFixed(2)})`);
  add('ok', `Best line is quiet: ${K.forcing} checks/captures in its first ${plies} plies`, `(max ${C.max_forcing})`);
  if (K.cpLoss > C.quiet_above) {
    add('ok', `Not just dropped material: down ${Math.max(0, K.materialLost)} pawn(s) after ${plies} plies of the punishment`, `(max ${C.max_material_lost}; applies above ${C.quiet_above}cp)`);
  } else {
    add('na', 'Material rule not needed', `(only for losses above ${C.quiet_above}cp)`);
  }
  add('ok', `No deep calculation: a depth-${C.shallow_depth} search ranks the best move #${K.shallowRank}`, `(needs top ${C.shallow_multipv})`);
  const lo = 100 * C.p_best_min, hi = 100 * C.p_best_max;
  const why = puzzle.pBest > hi ? 'above the range: easy miss'
    : puzzle.pBest < lo ? 'below the range: allowed because your move was Maia\'s #1'
    : 'in range';
  add('ok', `Maia p(best) at your Elo (${puzzle.maiaElo}): ${pct(puzzle.pBest)}`, `(range ${lo}–${hi}%, ${why})`);
  add('ok', `Maia p(best) at +${C.elo_delta} Elo (${puzzle.maiaElo + C.elo_delta}): ${pct(puzzle.pBestPlus)}`, `(min ${100 * C.p_best_strong_min}%)`);
  if (puzzle.pBestTop != null) {
    add('na', `Maia p(best) at ${C.elo_top || 2600} Elo: ${pct(puzzle.pBestTop)}`, '(info, not a check)');
  }
  if (puzzle.flags) {
    const pts = (x) => Math.round(100 * x);
    const gap = (x) => (x == null ? '?' : `${x >= puzzle.pBest ? '+' : '−'}${Math.abs(x - puzzle.pBest).toFixed(1)}`);
    const top = C.elo_top || 2600;
    const t = trendOf(puzzle);
    const rule = t === 'engine_move' ? `(flag: −${pts(C.engine_drop_top)} at ${top} or −${pts(C.engine_drop_plus)} at +${C.elo_delta})`
      : `(rating-sensitive needs +${pts(C.sensitive_plus)} at +${C.elo_delta} and +${pts(C.sensitive_top)} at ${top})`;
    add('na', `Rating trend: ${TREND_LABEL[t]}, p(best) ${gap(puzzle.pBestPlus)} points at +${C.elo_delta}, ${gap(puzzle.pBestTop)} at ${top}`, rule);
  }
  add('na', `Your move: Maia ${pct(puzzle.pPlayed)}, #${K.myRank} at your Elo`, '(info, not a check)');
  const off = [];
  if (!C.natural) off.push('p(your move) ≥ p(best)');
  if (C.p_gain_min == null) off.push(`p(best) rises at +${C.elo_delta}`);
  const differs = finished && puzzle.minedBest && puzzle.minedBest !== puzzle.line[0]
    ? ` The mining run's best move was ${sanOf(puzzle.fen, puzzle.minedBest)}; grading uses a fresh depth-${C.depth} score, which picked ${sanOf(puzzle.fen, puzzle.line[0])}.`
    : '';
  $('why-note').textContent = `Values from the mining run (Stockfish depth ${C.depth}, Maia ${C.maia_model}).`
    + (off.length ? ` Turned off: ${off.join('; ')}.` : '') + differs;
  box.hidden = false;
}

// "120+1" -> "2+1", "600" -> "10+0", "1/86400" -> "daily"
function fmtTimeControl(tc) {
  if (!tc || tc === '-') return '';
  if (tc.includes('/')) return 'daily';
  const [base, inc = '0'] = tc.split('+');
  const m = +base / 60;
  return `${Number.isInteger(m) ? m : m.toFixed(1)}+${inc}`;
}

function submit() {
  if (busy || solved() || spar) return;
  view = null;
  const moves = game.history({ verbose: true });
  if (!moves.length) { setStatus('Make a move first.', 'bad'); return; }
  verdict = evaluate(moves);
  const i = state.index;
  if (isStrategy()) {
    if (verdict.ok) {
      if (!state.results[i]) {
        state.results[i] = mistakes || usedHelp ? 'helped' : 'clean';
        recordTime(state.results[i]);
      }
      saveState();
      const extra = verdict.loss <= 10 ? "the engine's choice." : `only ${verdict.loss}cp worse than the best.`;
      setStatus(`${verdict.label}! ${verdict.san} \u2014 ${extra}`, 'good');
      showGameDetail();
      if (state.results.every(Boolean)) showSummary();
    } else {
      mistakes++;
      if (repeatsGameMove(moves[0])) {
        setStatus(`${verdict.san} again — that's the move you played in the game (−${verdict.loss}cp). ${rethinkTip()} Undo and try again.`, 'bad');
      } else {
        setStatus(`${verdict.label}: ${verdict.san} loses ${verdict.loss}cp. Undo and try again.`, 'bad');
      }
      shake();
    }
    render();
    return;
  }
  if (verdict.ok) {
    if (!state.results[i]) state.results[i] = mistakes || usedHelp ? 'helped' : 'clean';
    saveState();
    setStatus(state.results[i] === 'clean' ? 'Correct — checkmate! Solved cleanly.' : 'Correct — checkmate!', 'good');
    if (state.results.every(Boolean)) showSummary();
  } else if (verdict.incomplete) {
    setStatus('So far so good, but it isn\'t mate yet — keep going.', 'bad');
  } else {
    mistakes++;
    const n = Math.floor(verdict.failAt / 2) + 1;
    setStatus(`Not quite — your move ${n} isn't the strongest. Undo and try again.`, 'bad');
    shake();
  }
  render();
}

function undo() {
  if (spar) { sparUndo(); return; }
  if (busy || solved() || !plies()) return;
  game.undo();
  hints = []; verdict = null;
  setStatus(`${side(game.turn())} to play.`);
  render();
}
function clearLine() {
  if (busy || solved() || spar) return;
  while (game.undo());
  hints = []; verdict = null;
  setStatus('Line cleared.');
  render();
}

// Is the current entered line still on track (every solver move so far good)?
function lineOnTrack() {
  const v = evaluate(game.history({ verbose: true }));
  return v.failAt === -1;
}

function hint() {
  if (busy || solved() || shownSolution || spar) return;
  view = null;
  if (isStrategy()) {
    if (plies()) { setStatus('Undo your move to get a hint.', 'bad'); return; }
    usedHelp = true;
    const mv = puzzle.line[0];
    const first = !hints.length;
    hints = first
      ? [{ orig: mv.slice(0, 2), brush: 'green' }]
      : [{ orig: mv.slice(0, 2), dest: mv.slice(2, 4), brush: 'green' }];
    setStatus(first ? 'Hint: move the circled piece.' : 'Hint: the arrow shows the move.');
    render();
    return;
  }
  if (!lineOnTrack()) { setStatus('An earlier move doesn\'t work — undo back to it.', 'bad'); return; }
  const remaining = puzzle.mate - Math.floor(plies() / 2);
  if (remaining < 1 || game.isGameOver()) { setStatus('This line runs too long — undo some moves.', 'bad'); return; }
  usedHelp = true;
  let mv;
  if (game.turn() === player) {
    mv = plies() === 0 ? puzzle.line[0] : uci(shortestMate(game, remaining).move);
    const first = !hints.length;
    hints = first
      ? [{ orig: mv.slice(0, 2), brush: 'green' }]
      : [{ orig: mv.slice(0, 2), dest: mv.slice(2, 4), brush: 'green' }];
    setStatus(first ? 'Hint: move the circled piece.' : 'Hint: the arrow shows the move.');
  } else {
    mv = uci(stubbornReply(game, remaining));
    hints = [{ orig: mv.slice(0, 2), dest: mv.slice(2, 4), brush: 'blue' }];
    setStatus(`Hint: the arrow shows ${side(game.turn())}'s toughest defence.`);
  }
  render();
}

function showSolution() {
  if (busy || solved() || shownSolution || spar) return;
  const i = state.index;
  if (!state.results[i]) {
    state.results[i] = 'revealed';
    if (isStrategy()) recordTime('revealed');
  }
  saveState();
  while (game.undo());
  busy = true; hints = []; verdict = null;
  const line = isStrategy() ? puzzle.line.slice(0, SOLUTION_PLIES) : puzzle.line;
  let k = 0;
  const step = () => {
    if (k < line.length) {
      const mv = line[k++];
      game.move({ from: mv.slice(0, 2), to: mv.slice(2, 4), promotion: mv[4] });
      render();
      setTimeout(step, 600);
    } else {
      busy = false;
      verdict = evaluate(game.history({ verbose: true }));
      if (isStrategy()) {
        shownSolution = true;
        setStatus("Solution shown: the engine's line.", 'bad');
        showGameDetail();
      } else {
        setStatus('Solution shown.', 'bad');
      }
      render();
      if (state.results.every(Boolean)) showSummary();
    }
  };
  render();
  setTimeout(step, 250);
}

function showSummary() {
  if (isBrowse()) return; // no "set complete" in the full list
  const r = state.results;
  const clean = r.filter((x) => x === 'clean').length;
  const helped = r.filter((x) => x === 'helped').length;
  const revealed = r.filter((x) => x === 'revealed').length;
  $('summary-text').textContent = `${clean} clean · ${helped} with help · ${revealed} revealed — out of ${r.length}.`;
  $('summary-new').textContent = isOrdered() ? 'Start over from #1' : 'Play a new set';
  $('summary').hidden = false;
}

function shake() {
  boardEl.classList.remove('shake'); void boardEl.offsetWidth; boardEl.classList.add('shake');
}

// ---------- rendering ----------
function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${kind}`;
}

const COLOR = { w: 'white', b: 'black' };

function legalDests(pos = game) {
  const dests = new Map();
  for (const m of pos.moves({ verbose: true })) {
    if (!dests.has(m.from)) dests.set(m.from, []);
    dests.get(m.from).push(m.to);
  }
  return dests;
}

// ---------- stepping through the line ----------
function viewPly() {
  if (view && (view.fen !== game.fen() || view.ply >= plies())) view = null;
  return view ? view.ply : plies();
}
function goTo(ply) {
  if (busy || !game) return;
  const n = plies();
  ply = Math.max(0, Math.min(n, ply));
  if (ply === viewPly()) return;
  view = ply < n ? { ply, fen: game.fen() } : null;
  render();
}
// The position after the first `ply` moves of the line.
function positionAt(ply, hist) {
  if (ply === hist.length) return game;
  const g = new Chess(puzzle.fen);
  for (let k = 0; k < ply; k++) g.move(hist[k]);
  return g;
}

function render() {
  const hist = game.history({ verbose: true });
  const at = viewPly();
  const back = at < hist.length;
  const pos = positionAt(at, hist);
  const last = hist[at - 1];
  // Looking back in a game vs the engine is view only; in a puzzle a move there replaces the rest.
  const locked = spar ? spar.thinking || pos.turn() !== spar.me || back : busy || solved() || shownSolution;
  const canMove = !locked && (spar || at < maxPlies()) && !pos.isGameOver();
  const fen = pos.fen();
  const cfg = {
    orientation: COLOR[flipped ? (player === 'w' ? 'b' : 'w') : player],
    turnColor: COLOR[pos.turn()],
    lastMove: last ? [last.from, last.to] : undefined,
    check: pos.inCheck(),
    movable: { color: canMove ? COLOR[pos.turn()] : undefined, dests: canMove ? legalDests(pos) : new Map() },
  };
  // Only push a new position when it changed (setting fen also clears drawn shapes).
  if (fen !== shownFen) { cfg.fen = fen; shownFen = fen; }
  // Arrows first: a flip in cg.set rebuilds the board at once with whatever arrows are set,
  // and a redraw already queued for the old board then makes Chessground skip clearing them.
  cg.setAutoShapes(back ? [] : hints);
  cg.set(cfg);
  renderEvalBar(pos, cfg.orientation);

  renderMoves(hist, at);
  $('nav-first').disabled = $('nav-back').disabled = busy || at === 0;
  $('nav-fwd').disabled = $('nav-last').disabled = busy || !back;
  $('nav-pos').textContent = !back ? '' : at ? `${at} / ${hist.length}` : 'Start';
  $('flip').setAttribute('aria-pressed', String(flipped));
  renderProgress();
  $('prev').disabled = state.index === 0;
  $('next').disabled = state.index === state.ids.length - 1;
  $('hint').disabled = locked || !!spar;
  $('solution').disabled = locked || !!spar;
  $('undo').disabled = spar ? plies() <= spar.start : locked || !plies();
  $('clear').disabled = locked || !!spar || !plies();
  $('submit').disabled = locked || !!spar || !plies();
}

function renderMoves(hist, at) {
  const ol = $('moves');
  ol.textContent = '';
  const fen = puzzle.fen.split(' ');
  let num = +fen[5] || 1;
  let row = null;
  hist.forEach((m, i) => {
    const white = m.color === 'w';
    if (white || !row) {
      row = document.createElement('li');
      const n = document.createElement('span');
      n.className = 'num';
      n.textContent = `${num}.`;
      row.appendChild(n);
      if (!white) row.appendChild(cell('…', 'skip'));
      ol.appendChild(row);
    }
    const c = cell(m.san, i === at - 1 ? 'cur' : '');
    c.dataset.ply = i + 1;
    c.title = 'Show this position';
    const mark = verdict ? verdict.marks[i] : null;
    if (mark === true) c.classList.add('ok');
    if (mark === false) c.classList.add('no');
    row.appendChild(c);
    if (!white) { num++; row = null; }
  });
  $('moves-count').textContent = spar ? 'vs engine' : !isStrategy() && hist.length >= maxPlies() ? 'max moves' : '';
  $('moves-empty').textContent = isStrategy()
    ? 'Play your move on the board.'
    : 'Play the moves for both sides on the board.';
  $('moves-empty').hidden = hist.length > 0;
}
function cell(text, cls) {
  const s = document.createElement('span');
  s.className = `mv ${cls}`.trim();
  s.textContent = text;
  return s;
}

function renderProgress() {
  const ol = $('progress');
  ol.hidden = isBrowse();
  $('browser').hidden = !isBrowse();
  if (isBrowse()) {
    rowEls.forEach((b, i) => {
      const r = state.results[i];
      b.className = [r || '', i === state.index ? 'current' : ''].join(' ').trim();
      const p = pool().find((x) => x.id === state.ids[i]);
      const fb = fbOf(p);
      b.lastChild.textContent = (isFav(p) ? '★ ' : '') + (fb?.rating ? `${FB_RATING[fb.rating].split(' ')[0]} ` : '') + (r ? STATUS_LABEL[r] : '');
    });
    $('progress-meta').hidden = true; // Polgár-only row; don't leave it up from Mates
    return;
  }
  ol.classList.toggle('long', isOrdered());
  // Build the buttons once per set (Polgár sections have thousands), then only update classes.
  if (progIds !== state.ids) {
    progIds = state.ids;
    progIndex = -1;
    ol.textContent = '';
    progEls = state.ids.map((_, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = i + 1;
      b.addEventListener('click', () => !busy && loadPuzzle(i));
      li.appendChild(b);
      ol.appendChild(li);
      return b;
    });
  }
  progEls.forEach((b, i) => {
    const r = state.results[i];
    const cls = [r || '', i === state.index ? 'current' : ''].join(' ').trim();
    if (b.className !== cls) b.className = cls;
    b.setAttribute('aria-label', `Puzzle ${i + 1}${r ? `, ${r}` : ''}`);
  });
  if (progIndex !== state.index) {  // keep the current number visible inside the scrolling grid
    progIndex = state.index;
    const b = progEls[state.index];
    if (b && ol.scrollHeight > ol.clientHeight) {
      const top = b.offsetTop, h = b.offsetHeight; // .progress.long is positioned, so this is relative to it
      if (top < ol.scrollTop || top + h > ol.scrollTop + ol.clientHeight) ol.scrollTop = top - (ol.clientHeight - h) / 2;
    }
  }
  const meta = $('progress-meta');
  meta.hidden = !isOrdered();
  if (isOrdered()) {
    const done = state.results.filter(Boolean).length;
    $('progress-count').textContent = `${done} / ${state.results.length} done`;
    $('next-unsolved').disabled = done === state.results.length;
  }
}
let progEls = [], progIds = null, progIndex = -1;
$('next-unsolved').addEventListener('click', () => {
  if (busy) return;
  const n = state.results.length;
  for (let k = 1; k <= n; k++) {  // first unsolved after the current one, wrapping around
    const i = (state.index + k) % n;
    if (!state.results[i]) { loadPuzzle(i); return; }
  }
});

// ---------- board (Chessground: drag/tap moves, right-click arrows & circles) ----------
const cg = Chessground(boardEl, {
  fen: '8/8/8/8/8/8/8/8',
  coordinates: true,
  animation: { enabled: true, duration: 200 },
  highlight: { lastMove: true, check: true },
  movable: { free: false, showDests: true, events: { after: (orig, dest) => { if (!enterMove(orig, dest)) render(); } } },
  premovable: { enabled: false },
  draggable: { enabled: true, showGhost: true },
  drawable: { enabled: true, visible: true, eraseOnClick: true },
});
new ResizeObserver(() => cg.redrawAll()).observe(boardEl);
// Size the board ourselves to a whole number of device pixels per 8 squares. Chessground
// rounds its squares down to that anyway, and a board any wider shows a strip of empty frame
// on the right and bottom. The eval bar, when shown, takes its width from the same column.
const boardCol = boardEl.closest('.board-col');
const frameEl = boardEl.closest('.board-frame');
function fitBoard() {
  const bar = $('evalbar');
  const avail = boardCol.clientWidth - (bar.hidden ? 0 : bar.offsetWidth);
  const dpr = window.devicePixelRatio || 1;
  const px = Math.floor((avail * dpr) / 8) * 8;
  if (px <= 0) return;
  // The board gets half a device pixel extra so layout rounding can't push Chessground's own
  // floor() down a whole step; the frame clips it to the exact size.
  frameEl.style.width = frameEl.style.height = `${px / dpr}px`;
  boardEl.style.width = boardEl.style.height = `${(px + 0.5) / dpr}px`;
}
new ResizeObserver(fitBoard).observe(boardCol);
fitBoard();
// Chessground caches where the board is on screen and only refreshes that on resize or
// scroll. Content above the board (e.g. the long number grid of a Polgár section) can move
// it without either, and then clicks land on the wrong squares: re-measure on every press.
for (const ev of ['mousedown', 'touchstart']) {
  boardEl.addEventListener(ev, () => cg.state.dom.bounds.clear(), { capture: true, passive: true });
}

// ---------- play it out vs an engine (Stockfish or Maia) ----------
// From whatever is on the board, you play one side and the engine the other.
// "Back to the puzzle" restores the line you had entered.
const SPAR_KEY = 'spar-settings-v1';
const sparCfg = (() => {
  const d = { engine: 'sf', sf: '', maia: '', evalbar: false };
  try { return { ...d, ...JSON.parse(localStorage.getItem(SPAR_KEY)) }; } catch { return d; }
})();
let spar = null; // { me: 'w'|'b', start: ply count, saved: { line, verdict, hints }, thinking, token, note }
let sparToken = 0;
const engines = {};
const sf = () => (engines.sf ??= new Stockfish());
const maia = () => (engines.maia ??= new Maia());
const maiaElo = () => +sparCfg.maia || puzzle?.maiaElo || 1500;
const sparName = () => (sparCfg.engine === 'maia' ? `Maia ${maiaElo()}` : `Stockfish${sparCfg.sf ? ` ${sparCfg.sf}` : ''}`);
const pushUci = (u) => game.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });

// Score for the side to move -> White's view: "+1.20", "#3", "#-2".
function fmtScore(score, turn) {
  if (!score) return '?';
  const s = turn === 'w' ? 1 : -1;
  return score.mate != null ? `#${s * score.mate}` : fmtEval(s * score.cp);
}

// ---------- eval bar (while playing the engine) ----------
// Its own full-strength Stockfish, so a weakened opponent doesn't weaken the evals.
// One search at a time; when it ends, the latest position asked for is searched next.
const evalSf = () => (engines.evalSf ??= new Stockfish());
const evalState = { want: null, running: false, shown: null };
// Lichess' cp -> win chance curve, as White's share of the bar (0..100).
const whiteShare = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
function setEvalBar(share, label) {
  const bar = $('evalbar');
  bar.querySelector('.evalbar-fill').style.height = `${share}%`;
  const num = bar.querySelector('.evalbar-num');
  num.textContent = label;
  num.className = `evalbar-num ${share >= 50 ? 'w' : 'b'}`;
  bar.title = `Eval ${label} (+ White is better, − Black is better)`;
}
function renderEvalBar(pos, orientation) {
  const bar = $('evalbar');
  const on = !!spar && sparCfg.evalbar;
  if (bar.hidden === on) { bar.hidden = !on; fitBoard(); }
  if (!on) { evalState.want = null; return; }
  bar.classList.toggle('flipped', orientation === 'black');
  const fen = pos.fen();
  if (evalState.shown === fen) return;
  const over = (share, label) => { evalState.want = null; evalState.shown = fen; bar.classList.remove('stale'); setEvalBar(share, label); };
  if (pos.isCheckmate()) { over(pos.turn() === 'w' ? 0 : 100, pos.turn() === 'w' ? '0-1' : '1-0'); return; }
  if (pos.isGameOver()) { over(50, '½'); return; }
  bar.classList.add('stale');
  if (evalState.want === fen) return;
  evalState.want = fen;
  if (!evalState.running) runEval();
}
async function runEval() {
  const fen = evalState.want;
  if (!fen) return;
  evalState.running = true;
  let r = null;
  try { r = await evalSf().search(fen, { movetime: 1000 }); } catch {}
  evalState.running = false;
  if (evalState.want !== fen) { runEval(); return; } // moved on meanwhile: search the newest
  evalState.want = null;
  if (!r?.score) return;
  const s = fen.split(' ')[1] === 'w' ? 1 : -1;
  const { cp, mate } = r.score;
  const share = mate != null ? (s * mate > 0 ? 100 : 0) : whiteShare(s * cp);
  // Signed from White's side: + White is better, − Black is better.
  const v = mate != null ? s * mate : s * cp;
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  const label = mate != null ? `${sign}M${Math.abs(mate)}` : `${sign}${(Math.abs(v) / 100).toFixed(1)}`;
  evalState.shown = fen;
  $('evalbar').classList.remove('stale');
  setEvalBar(share, label);
}

function startSpar(me) {
  if (busy) return;
  const at = viewPly();
  const saved = { line: game.history({ verbose: true }).map(uci), verdict, hints };
  // Play from the position being looked at, not the end of the line; Stop puts the whole line back.
  while (plies() > at) game.undo();
  view = null;
  spar = { me, start: plies(), thinking: false, token: ++sparToken, note: '', saved };
  verdict = null; hints = [];
  setDetail('');
  renderSpar();
  engineTurn();
}
// Leave without touching the board (a new puzzle is being loaded).
function endSpar() {
  if (!spar) return;
  spar = null; sparToken++;
  engines.sf?.stop();
  evalState.want = null; evalState.shown = null; engines.evalSf?.stop();
  $('evalbar').hidden = true;
  fitBoard();
}
// Leave and put back the line that was on the board before.
function stopSpar() {
  if (!spar) return;
  const s = spar.saved;
  endSpar();
  while (game.undo());
  s.line.forEach(pushUci);
  verdict = s.verdict; hints = s.hints;
  setStatus('Back to the puzzle.');
  renderSpar();
  render();
}

function sparMove(from, to) {
  if (spar.thinking || game.turn() !== spar.me || game.isGameOver()) return false;
  const legal = game.moves({ square: from, verbose: true }).filter((m) => m.to === to);
  if (!legal.length) return false;
  game.move({ from, to, promotion: legal[0].promotion ? 'q' : undefined });
  hints = [];
  engineTurn();
  return true;
}

function sparUndo() {
  if (plies() <= spar.start) return;
  spar.token = ++sparToken; spar.thinking = false;
  engines.sf?.stop();
  do game.undo(); while (plies() > spar.start && game.turn() !== spar.me);
  hints = []; spar.note = '';
  engineTurn();
}

async function think(fen) {
  const turn = fen.split(' ')[1];
  if (sparCfg.engine === 'maia') {
    const m = maia();
    m.onProgress = (got, total) => setStatus(`Downloading Maia… ${total ? Math.min(99, Math.round((100 * got) / total)) + '%' : `${Math.round(got / 1e6)} MB`}`);
    if (!m.ready) setStatus(`Loading Maia (${MAIA_MB} MB the first time)…`);
    const elo = maiaElo();
    const { policy, win } = await m.evaluate(fen, elo, elo);
    const [move, p] = sampleMove(policy);
    const top = policy.slice(0, 3).map(([u, q]) => `${sanOf(fen, u)} ${Math.round(100 * q)}%`).join(', ');
    return { move, note: `Maia ${elo} played ${sanOf(fen, move)} (${Math.round(100 * p)}% of players at this level). Most likely: ${top}. White's expected score ${Math.round(100 * win)}%.` };
  }
  const elo = +sparCfg.sf || null;
  if (!engines.sf?.ready) {
    sf().onProgress = (got, total) => setStatus(`Downloading Stockfish… ${Math.min(99, Math.round((100 * got) / total))}%`);
    setStatus(sfFull() ? `Loading Stockfish (${SF_MB} MB the first time)…` : 'Loading Stockfish…');
  }
  const r = await sf().search(fen, { movetime: elo ? 500 : 1500, elo });
  if (!r.move) return { move: null, note: '' };
  const pv = r.pv.length > 1 ? ` Expected line: ${pvSan(fen, r.pv.slice(0, 8))}.` : '';
  return { move: r.move, note: `${sparName()} played ${sanOf(fen, r.move)}, eval ${fmtScore(r.score, turn)}.${pv}` };
}
function pvSan(fen, pv) {
  const g = new Chess(fen), out = [];
  for (const u of pv) {
    try { out.push(g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san); } catch { break; }
  }
  return out.join(' ');
}

async function engineTurn() {
  if (!spar) return;
  if (game.isGameOver() || game.turn() === spar.me) { sparStatus(); render(); return; }
  const token = spar.token, fen = game.fen();
  spar.thinking = true;
  setStatus(`${sparName()} is thinking…`);
  render();
  let r;
  try {
    r = await think(fen);
  } catch (err) {
    if (spar && spar.token === token) {
      spar.thinking = false;
      setStatus(`The engine failed: ${err.message}`, 'bad');
      render();
    }
    return;
  }
  if (!spar || spar.token !== token || game.fen() !== fen) return;
  spar.thinking = false;
  if (r.move) pushUci(r.move);
  spar.note = r.note;
  hints = [];
  sparStatus();
  render();
}

function sparStatus() {
  if (!spar) return;
  if (game.isCheckmate()) setStatus(`Checkmate: ${side(game.turn() === 'w' ? 'b' : 'w')} wins.`, game.turn() === spar.me ? 'bad' : 'good');
  else if (game.isGameOver()) setStatus('Draw.');
  else setStatus(`Your move (${side(spar.me)}) against ${sparName()}.`);
  $('spar-info').textContent = spar.note || `You play ${side(spar.me)}. Undo takes back your last move.`;
}

function renderSpar() {
  const on = !!spar;
  $('spar-start').hidden = on;
  $('spar-stop').hidden = !on;
  $('spar-engine').value = sparCfg.engine;
  $('spar-sf').value = sparCfg.sf;
  $('spar-sf-wrap').hidden = sparCfg.engine !== 'sf';
  $('spar-maia-wrap').hidden = sparCfg.engine !== 'maia';
  const auto = $('spar-maia').options[0];
  auto.textContent = puzzle?.maiaElo ? `Your rating (${puzzle.maiaElo})` : 'Default (1500)';
  $('spar-maia').value = sparCfg.maia;
  $('spar-eval').checked = sparCfg.evalbar;
  if (!on) {
    $('spar-info').textContent = sparCfg.engine === 'maia' && !engines.maia?.ready
      ? `Maia plays like a human at the chosen rating. The first game downloads it (${MAIA_MB} MB); after that it works offline.`
      : 'You play the side the puzzle gives you and the engine the other, from the position on the board. Play a move first to see how the engine answers it.';
  }
}

{
  const sel = $('spar-maia');
  const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.append(o); };
  add('', 'Your rating');
  for (let r = 600; r <= 2600; r += 100) add(String(r), String(r));
}
const saveSparCfg = () => { try { localStorage.setItem(SPAR_KEY, JSON.stringify(sparCfg)); } catch {} };
$('spar-engine').addEventListener('change', (e) => { sparCfg.engine = e.target.value; saveSparCfg(); renderSpar(); });
$('spar-sf').addEventListener('change', (e) => { sparCfg.sf = e.target.value; saveSparCfg(); });
$('spar-maia').addEventListener('change', (e) => { sparCfg.maia = e.target.value; saveSparCfg(); });
$('spar-eval').addEventListener('change', (e) => {
  sparCfg.evalbar = e.target.checked; saveSparCfg();
  if (!sparCfg.evalbar) { evalState.want = null; engines.evalSf?.stop(); }
  render();
});
$('spar-start').addEventListener('click', () => startSpar(player));
$('spar-swap').addEventListener('click', () => {
  if (!spar) { startSpar(player === 'w' ? 'b' : 'w'); return; }
  spar.me = spar.me === 'w' ? 'b' : 'w';
  spar.token = ++sparToken; spar.thinking = false;
  engines.sf?.stop();
  engineTurn();
});
$('spar-stop').addEventListener('click', stopSpar);

// ---------- buttons ----------
$('prev').addEventListener('click', () => !busy && state.index > 0 && loadPuzzle(state.index - 1));
$('next').addEventListener('click', () => !busy && state.index < state.ids.length - 1 && loadPuzzle(state.index + 1));
$('undo').addEventListener('click', undo);
$('clear').addEventListener('click', clearLine);
$('submit').addEventListener('click', submit);
$('hint').addEventListener('click', hint);
$('solution').addEventListener('click', showSolution);
$('show-punish').addEventListener('click', () => showLine(puzzle.punish, 99, true, 'punishment of your game move'));
$('show-best').addEventListener('click', () => showLine(puzzle.line, (puzzle.punish || []).length - 1, true, 'best line'));
const startNewSet = () => { if (busy) return; state = newSet(); saveState(); loadPuzzle(0); };
$('copy-fen').addEventListener('click', async () => {
  const b = $('copy-fen');
  try {
    await navigator.clipboard.writeText(puzzle.fen);
    b.textContent = 'Copied!';
    setTimeout(() => { b.textContent = 'Copy FEN'; }, 1500);
  } catch {
    window.prompt('FEN for this puzzle:', puzzle.fen); // clipboard blocked: let the user copy it by hand
  }
});
$('new-set').addEventListener('click', startNewSet);
$('summary-new').addEventListener('click', startNewSet);

function setMode(m) {
  if (busy || !MODES[m]) return;
  mode = m;
  try { localStorage.setItem(MODE_KEY, m); } catch {}
  $('app-title').textContent = MODES[m].title;
  document.title = `${MODES[m].title} · ChessHub`;
  for (const k of Object.keys(MODES)) {
    if (m === k) $(`mode-${k}`).setAttribute('aria-current', 'page');
    else $(`mode-${k}`).removeAttribute('aria-current');
  }
  $('new-set').hidden = isBrowse() || isOrdered();
  document.querySelector('.app').classList.toggle('browsing', isBrowse());
  if (isBrowse()) { loadStore(); fillFilters(); }
  state = loadState() || newSet();
  saveState();
  if (isBrowse()) buildList();
  loadPuzzle(state.index || 0);
  if (isBrowse()) rowEls[state.index]?.scrollIntoView({ block: 'nearest' });
  if (state.results.every(Boolean)) showSummary();
}
for (const k of Object.keys(MODES)) $(`mode-${k}`).addEventListener('click', () => { closeNav(); if (mode !== k) setMode(k); });

// ---------- left menu: collapse to icons (desktop), drawer (phones) ----------
const NAV_KEY = 'nav-collapsed';
const root = document.documentElement;
function syncCollapse() {
  const c = root.classList.contains('nav-collapsed');
  const b = $('nav-collapse');
  b.setAttribute('aria-expanded', String(!c));
  b.title = c ? 'Expand menu' : 'Collapse menu';
  b.querySelector('.nav-label').textContent = c ? 'Expand' : 'Collapse';
}
$('nav-collapse').addEventListener('click', () => {
  const c = root.classList.toggle('nav-collapsed');
  try { localStorage.setItem(NAV_KEY, c ? '1' : '0'); } catch {}
  syncCollapse();
  window.dispatchEvent(new Event('resize')); // the board's width changed: let Chessground re-measure
});
syncCollapse();
function closeNav() {
  root.classList.remove('nav-open');
  $('nav-backdrop').hidden = true;
  $('nav-open').setAttribute('aria-expanded', 'false');
}
$('nav-open').addEventListener('click', () => {
  root.classList.add('nav-open');
  $('nav-backdrop').hidden = false;
  $('nav-open').setAttribute('aria-expanded', 'true');
});
$('nav-backdrop').addEventListener('click', closeNav);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && root.classList.contains('nav-open')) closeNav(); });

// Section buttons (mate mode only).
for (const [k, sec] of Object.entries(SECTIONS)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.id = `section-${k}`;
  b.textContent = sec.label;
  b.title = `${sec.about} (${sec.pool.length} puzzles)`;
  b.setAttribute('aria-pressed', String(k === section));
  b.addEventListener('click', () => {
    closeNav();
    if (busy || (k === section && mode === 'mate')) return;
    section = k;
    try { localStorage.setItem(SECTION_KEY, k); } catch {}
    for (const j of Object.keys(SECTIONS)) $(`section-${j}`).setAttribute('aria-pressed', String(j === k));
    setMode('mate');
  });
  $('sections').appendChild(b);
}

// Step through the line: buttons, clicking a move, the mouse wheel over the move list.
$('moves').addEventListener('click', (e) => {
  const c = e.target.closest('.mv[data-ply]');
  if (c) goTo(+c.dataset.ply);
});
$('moves').addEventListener('wheel', (e) => {
  if (!plies() || Math.abs(e.deltaY) < 1) return;
  e.preventDefault();
  goTo(viewPly() + Math.sign(e.deltaY));
}, { passive: false });
$('nav-first').addEventListener('click', () => goTo(0));
$('nav-back').addEventListener('click', () => goTo(viewPly() - 1));
$('nav-fwd').addEventListener('click', () => goTo(viewPly() + 1));
$('nav-last').addEventListener('click', () => goTo(plies()));
function flip() {
  if (!game) return;
  flipped = !flipped;
  render();
}
$('flip').addEventListener('click', flip);

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  // ←/→ step through the moves, ↑/Home and ↓/End jump to the start and end,
  // Shift+←/→ change puzzle. Arrows don't press buttons, so they work with one focused.
  const arrows = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -Infinity, ArrowDown: Infinity, Home: -Infinity, End: Infinity };
  if (e.key in arrows && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    if (e.shiftKey) { if (e.key === 'ArrowLeft') $('prev').click(); if (e.key === 'ArrowRight') $('next').click(); }
    else goTo(viewPly() + arrows[e.key]);
    return;
  }
  if ((e.key === 'x' || e.key === 'f' || e.key === 'X' || e.key === 'F') && !e.altKey && !e.ctrlKey && !e.metaKey) { flip(); return; }
  if (e.target.closest('button')) return;
  if (e.key === 'Backspace') undo();
  if (e.key === 'Enter') submit();
});

setMode(mode);

// ---------- offline ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
