import { Chess } from './vendor/chess.js';
import { Chessground } from './vendor/chessground.min.js';
import { PUZZLES } from './puzzles.js';
import { STRATEGIC } from './strategic.js';
import * as review from './strategic_review.js';

const SET_SIZE = 10;
const MODE_KEY = 'drills-mode';
const MODES = {
  mate: { pool: PUZZLES, key: 'mate-drills-v1', title: 'Mate Drills' },
  strategy: { pool: STRATEGIC, key: 'strategy-drills-v1', title: 'Strategy Drills' },
  // Everything the current miner settings keep for the last 30 days, with each check's values.
  // browse: the whole pool as a numbered, filterable list instead of random sets of 10.
  review: { pool: review.STRATEGIC_REVIEW, config: review.STRATEGIC_REVIEW_CONFIG, key: 'review-drills-v3', title: 'Review: mined problems', browse: true },
};
let mode = (() => {
  try { const m = localStorage.getItem(MODE_KEY); return MODES[m] ? m : 'mate'; } catch { return 'mate'; }
})();
const pool = () => MODES[mode].pool;
const isStrategy = () => mode !== 'mate'; // strategy and review share the one-move flow

// Strategy problems: grade the first move from precomputed centipawn losses.
const LABELS = [[10, 'Best'], [30, 'Good'], [75, 'Inaccuracy'], [150, 'Mistake']];
const labelFor = (cp) => (LABELS.find(([lim]) => cp <= lim) || [0, 'Blunder'])[1];
const STRATEGY_OK = 30; // Best or Good counts as solved
const SOLUTION_PLIES = 10; // how much of the engine line Solution plays out

const $ = (id) => document.getElementById(id);
const boardEl = $('board');

// ---------- mate solver (small depths only) ----------
function canMate(game, n) {
  for (const m of game.moves({ verbose: true })) {
    game.move(m);
    const ok = game.isCheckmate() || (n > 1 && !game.isGameOver() && allRepliesLose(game, n - 1));
    game.undo();
    if (ok) return m;
  }
  return null;
}
function allRepliesLose(game, n) {
  for (const r of game.moves({ verbose: true })) {
    game.move(r);
    const lost = !!canMate(game, n);
    game.undo();
    if (!lost) return false;
  }
  return true;
}
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

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function newSet() {
  if (isBrowse()) return browseState();
  const ids = shuffle(pool().map((p) => p.id)).slice(0, SET_SIZE);
  return { ids, results: Array(ids.length).fill(null), index: 0 };
}
function loadState() {
  if (isBrowse()) return browseState();
  try {
    const s = JSON.parse(localStorage.getItem(MODES[mode].key));
    const n = Math.min(SET_SIZE, pool().length);
    if (s && Array.isArray(s.ids) && s.ids.length === n &&
        s.ids.every((id) => pool().some((p) => p.id === id))) return s;
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
  try { localStorage.setItem(MODES[mode].key, JSON.stringify(state)); } catch {}
}

// ---------- browse mode (Review): numbered list + filters ----------
const isBrowse = () => !!MODES[mode].browse;
// Permanent numbers: position in the exported file (#1..#N). A re-export renumbers.
const numOf = new Map();
for (const m of Object.values(MODES)) if (m.browse) m.pool.forEach((p, i) => numOf.set(p.id, i + 1));
const KIND_LABEL = { single: 'regular', typical: 'typical', easy_miss: 'easy miss', drift: 'drift' };
const NATURE_LABEL = { positional: 'positional', positional_then_material: 'positional → material', concrete: 'concrete', marginal: 'marginal' };
const STATUS_LABEL = { clean: '✓ clean', helped: '✓ with help', revealed: 'revealed' };
const FILTERS = {
  cat: { label: 'all categories', of: (p) => p.kind, name: (v) => KIND_LABEL[v] || v },
  nature: { label: 'all verdicts', of: (p) => p.nature && p.nature.kind, name: (v) => NATURE_LABEL[v] || v },
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
};
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
function refreshStatusCounts() {
  const sel = $('f-status');
  for (const o of sel.options) {
    if (!o.value) continue;
    const n = pool().filter((p) => FILTERS.status.match(p, o.value)).length;
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
      p.nature ? NATURE_LABEL[p.nature.kind] : ''].filter(Boolean).join(' · ');
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
const MAX_PLIES = Math.max(...PUZZLES.map((p) => p.line.length)) + 3;
const maxPlies = () => (isStrategy() && !busy ? 1 : MAX_PLIES);
const plies = () => game.history().length;
const solved = () => verdict && verdict.ok;

function loadPuzzle(i) {
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
  setDetail('');
  cg.setShapes([]);
  usedHelp = false;
  $('title').textContent = isBrowse() ? `Problem #${numOf.get(puzzle.id)}` : `Puzzle ${i + 1}`;
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
  if (state.results[i] && isStrategy()) showGameDetail();
  else { showWhy(false); $('wrong').hidden = true; }
  // Snap to the new puzzle instead of animating from the previous position.
  cg.set({ animation: { enabled: false } });
  render();
  cg.set({ animation: { enabled: true } });
}

const side = (c) => (c === 'w' ? 'White' : 'Black');

function enterMove(from, to) {
  if (busy || solved() || plies() >= maxPlies()) return false;
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
  el.hidden = false;
  showWhy(true);
  showWrong();
}

// ---------- "What went wrong": punishment line + shallow-eval trace ----------
// Kind is decided by material (does the punishment actually win material vs the best line?);
// the eval trace only says when a quick look starts to see the damage.
const pawns = (k) => `${k} pawn${k > 1 ? 's' : ''}`;
const NATURE_TEXT = {
  positional: () => `Positional: the punishment wins no material in the next ${puzzle.trace.punish.length} turns. The engine's verdict is about the position itself: structure, piece activity, king safety.`,
  positional_then_material: (n) => `Positional first, material later: nothing is lost at once, but the worse position eventually costs material. From ${n.matMove} you stay ${pawns(n.matGap)} down compared with the best line.`,
  concrete: (n) => `Concrete: the punishment wins material quickly. From ${n.matMove} you stay ${pawns(n.matGap)} down compared with the best line.`,
  marginal: () => `Marginal: the fresh engine score rates your move only ${puzzle.scores[puzzle.played]}cp worse than the best, so this may not be a real mistake.`,
};

function showWrong() {
  const box = $('wrong');
  if (!isStrategy() || !puzzle.trace || !puzzle.nature) { box.hidden = true; return; }
  const n = puzzle.nature;
  let text = NATURE_TEXT[n.kind] ? NATURE_TEXT[n.kind](n) : n.kind;
  if (n.kind !== 'marginal') {
    text += n.turn == null
      ? ' A quick look (depth 1–' + puzzle.trace.depth + ') never sees the difference within the line.'
      : n.turn === 0
        ? ` A quick look already sees the damage on your very next turn, after ${n.move}.`
        : ` A quick look only sees the damage after ${n.move}, ${n.turn + 1} of your turns later.`;
  }
  $('wrong-text').textContent = text + whatChanged();
  drawTrace();
  $('wrong-note').textContent = `Red: your move then the engine's punishment. Green: the best line. Solid: quick-look eval (median of depths 1–${puzzle.trace.depth}) at each of your turns. Dashed: deep eval. Ring: a quick look first sees the damage. Dotted square: from here material stays lost. Click a point to see that position.`;
  box.hidden = false;
}

// Classical (non-NNUE) eval terms: which positional factors the move gave away.
// Only shown when that eval agrees and accounts for a real share of the loss: on a sample it
// contradicted the main engine about a third of the time.
const TERM_NAMES = { 'King safety': 'king safety', Mobility: 'piece mobility', Threats: 'threats', Passed: 'passed pawns', Pawns: 'pawn structure', Bishops: 'bishops', Knights: 'knights', Rooks: 'rooks', Queens: 'queen', Space: 'space' };
function whatChanged() {
  const c = puzzle.changed;
  if (!c || puzzle.nature.kind === 'marginal') return '';
  if (!c.turns.length) return ' What changed: no quiet position to compare in your turns 2–4.';
  if (!c.explains || !c.terms.length) {
    return ' What changed: Stockfish\'s old hand-written evaluation doesn\'t clearly explain this one'
      + (c.total <= 0 ? ' (it even prefers your move there).' : '.');
  }
  const list = c.terms.slice(0, 3).map(([k, v]) => `${TERM_NAMES[k] || k} −${v.toFixed(2)}`).join(', ');
  return ` What changed (old hand-written Stockfish eval, your turns ${c.turns.join(', ')}): ${list}.`;
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
  const all = [...T.punish, ...T.best, T.deepPunish, T.deepBest].map(clamp);
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
    { vals: T.best, deep: T.deepBest, color: green, line: puzzle.line, name: 'best line' },
    { vals: T.punish, deep: T.deepPunish, color: red, line: puzzle.punish, name: 'punishment' },
  ];
  for (const s of series) {
    svg.append(svgEl('line', { x1: L, x2: W - R, y1: y(s.deep), y2: y(s.deep), stroke: s.color, 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.7 }));
    svg.append(svgEl('polyline', { points: s.vals.map((v, t) => `${x(t)},${y(v)}`).join(' '), fill: 'none', stroke: s.color, 'stroke-width': 1.8 }));
    s.vals.forEach((v, t) => {
      const c = svgEl('circle', { cx: x(t), cy: y(v), r: 3.5, fill: s.color, class: 'pt' });
      const tip = svgEl('title', {});
      tip.textContent = `${s.name}, your turn ${t + 1}: ${fmtEval(v)}`;
      c.append(tip);
      c.addEventListener('click', () => showLine(s.line, T.plies[t] ?? 2 * t + 1, false, s.name));
      svg.append(c);
    });
  }
  // Ring: where a quick look first sees the damage. Square: from where material stays lost.
  const crit = puzzle.nature.turn;
  if (crit != null && puzzle.nature.kind !== 'marginal') {
    svg.append(svgEl('circle', { cx: x(crit), cy: y(T.punish[crit]), r: 7, fill: 'none', stroke: red, 'stroke-width': 1.5 }));
  }
  const mt = puzzle.nature.matTurn;
  if (mt != null) {
    svg.append(svgEl('rect', { x: x(mt) - 6, y: y(T.punish[mt]) - 6, width: 12, height: 12, fill: 'none', stroke: red, 'stroke-width': 1.2, 'stroke-dasharray': '2 2' }));
  }
  host.append(svg);
}

// Show a line on the board (view only): up to and including index `upto`.
function showLine(line, upto, animate, name) {
  if (busy || !line) return;
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
  add('ok', `cp loss ${K.cpLoss}`, `(allowed ${C.cp_min}–${C.cp_max})`);
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
  add('ok', `Maia p(best) at +${C.elo_delta} Elo: ${pct(puzzle.pBestPlus)}`, `(min ${100 * C.p_best_strong_min}%)`);
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
  if (busy || solved()) return;
  const moves = game.history({ verbose: true });
  if (!moves.length) { setStatus('Make a move first.', 'bad'); return; }
  verdict = evaluate(moves);
  const i = state.index;
  if (isStrategy()) {
    if (verdict.ok) {
      if (!state.results[i]) state.results[i] = mistakes || usedHelp ? 'helped' : 'clean';
      saveState();
      const extra = verdict.loss <= 10 ? "the engine's choice." : `only ${verdict.loss}cp worse than the best.`;
      setStatus(`${verdict.label}! ${verdict.san} \u2014 ${extra}`, 'good');
      showGameDetail();
      if (state.results.every(Boolean)) showSummary();
    } else {
      mistakes++;
      setStatus(`${verdict.label}: ${verdict.san} loses ${verdict.loss}cp. Undo and try again.`, 'bad');
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
  if (busy || solved() || !plies()) return;
  game.undo();
  hints = []; verdict = null;
  setStatus(`${side(game.turn())} to play.`);
  render();
}
function clearLine() {
  if (busy || solved()) return;
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
  if (busy || solved() || shownSolution) return;
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
  if (busy || solved() || shownSolution) return;
  const i = state.index;
  if (!state.results[i]) state.results[i] = 'revealed';
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

function legalDests() {
  const dests = new Map();
  for (const m of game.moves({ verbose: true })) {
    if (!dests.has(m.from)) dests.set(m.from, []);
    dests.get(m.from).push(m.to);
  }
  return dests;
}

function render() {
  const hist = game.history({ verbose: true });
  const last = hist[hist.length - 1];
  const locked = busy || solved() || shownSolution;
  const canMove = !locked && plies() < maxPlies() && !game.isGameOver();
  const fen = game.fen();
  const cfg = {
    orientation: COLOR[player],
    turnColor: COLOR[game.turn()],
    lastMove: last ? [last.from, last.to] : undefined,
    check: game.inCheck(),
    movable: { color: canMove ? COLOR[game.turn()] : undefined, dests: canMove ? legalDests() : new Map() },
  };
  // Only push a new position when it changed (setting fen also clears drawn shapes).
  if (fen !== shownFen) { cfg.fen = fen; shownFen = fen; }
  cg.set(cfg);
  cg.setAutoShapes(hints);

  renderMoves(hist);
  renderProgress();
  $('prev').disabled = state.index === 0;
  $('next').disabled = state.index === state.ids.length - 1;
  $('hint').disabled = locked;
  $('solution').disabled = locked;
  $('undo').disabled = locked || !plies();
  $('clear').disabled = locked || !plies();
  $('submit').disabled = locked || !plies();
}

function renderMoves(hist) {
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
    const c = cell(m.san, i === hist.length - 1 ? 'cur' : '');
    const mark = verdict ? verdict.marks[i] : null;
    if (mark === true) c.classList.add('ok');
    if (mark === false) c.classList.add('no');
    row.appendChild(c);
    if (!white) { num++; row = null; }
  });
  $('moves-count').textContent = !isStrategy() && hist.length >= maxPlies() ? 'max moves' : '';
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
      b.lastChild.textContent = r ? STATUS_LABEL[r] : '';
    });
    return;
  }
  ol.textContent = '';
  state.ids.forEach((_, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = i + 1;
    b.className = [state.results[i] || '', i === state.index ? 'current' : ''].join(' ').trim();
    b.setAttribute('aria-label', `Puzzle ${i + 1}${state.results[i] ? `, ${state.results[i]}` : ''}`);
    b.addEventListener('click', () => !busy && loadPuzzle(i));
    li.appendChild(b);
    ol.appendChild(li);
  });
}

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
$('new-set').addEventListener('click', startNewSet);
$('summary-new').addEventListener('click', startNewSet);

function setMode(m) {
  if (busy || !MODES[m]) return;
  mode = m;
  try { localStorage.setItem(MODE_KEY, m); } catch {}
  $('app-title').textContent = MODES[m].title;
  document.title = MODES[m].title;
  for (const k of Object.keys(MODES)) $(`mode-${k}`).setAttribute('aria-pressed', String(m === k));
  $('new-set').hidden = isBrowse();
  document.querySelector('.app').classList.toggle('browsing', isBrowse());
  if (isBrowse()) { loadStore(); fillFilters(); }
  state = loadState() || newSet();
  saveState();
  if (isBrowse()) buildList();
  loadPuzzle(state.index || 0);
  if (isBrowse()) rowEls[state.index]?.scrollIntoView({ block: 'nearest' });
  if (state.results.every(Boolean)) showSummary();
}
for (const k of Object.keys(MODES)) $(`mode-${k}`).addEventListener('click', () => mode !== k && setMode(k));

document.addEventListener('keydown', (e) => {
  if (e.target.closest('button')) return;
  if (e.key === 'ArrowLeft') $('prev').click();
  if (e.key === 'ArrowRight') $('next').click();
  if (e.key === 'Backspace') undo();
  if (e.key === 'Enter') submit();
});

setMode(mode);

// ---------- offline ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
