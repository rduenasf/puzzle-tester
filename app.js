import { Chess } from './vendor/chess.js';
import { Chessground } from './vendor/chessground.min.js';
import { PUZZLES } from './puzzles.js';

const SET_SIZE = 10;
const STORE_KEY = 'mate-drills-v1';

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
let state = loadState() || newSet();
let game, puzzle, player, busy, hints, verdict, mistakes, usedHelp, shownFen;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function newSet() {
  const ids = shuffle(PUZZLES.map((p) => p.id)).slice(0, SET_SIZE);
  return { ids, results: Array(SET_SIZE).fill(null), index: 0 };
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.ids) && s.ids.length === SET_SIZE &&
        s.ids.every((id) => PUZZLES.some((p) => p.id === id))) return s;
  } catch {}
  return null;
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
}

// ---------- puzzle flow ----------
// Same cap for every puzzle so it doesn't reveal the solution length:
// the longest solution in the pool plus 3 extra moves.
const MAX_PLIES = Math.max(...PUZZLES.map((p) => p.line.length)) + 3;
const maxPlies = () => MAX_PLIES;
const plies = () => game.history().length;
const solved = () => verdict && verdict.ok;

function loadPuzzle(i) {
  state.index = i;
  saveState();
  puzzle = PUZZLES.find((p) => p.id === state.ids[i]);
  game = new Chess(puzzle.fen);
  player = game.turn();
  busy = false;
  hints = [];
  verdict = null;
  mistakes = 0;
  shownFen = null;
  cg.setShapes([]);
  usedHelp = false;
  $('title').textContent = `Puzzle ${i + 1}`;
  $('subtitle').textContent = `${side(player)} to move`;
  $('turn').className = `turn ${player}`;
  setStatus(state.results[i]
    ? 'Already done — play it again or move on.'
    : 'Find the best line. Play both sides, then Submit.');
  $('summary').hidden = true;
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

function submit() {
  if (busy || solved()) return;
  const moves = game.history({ verbose: true });
  if (!moves.length) { setStatus('Make a move first.', 'bad'); return; }
  verdict = evaluate(moves);
  const i = state.index;
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
  if (busy || solved()) return;
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
  if (busy || solved()) return;
  const i = state.index;
  if (!state.results[i]) state.results[i] = 'revealed';
  saveState();
  while (game.undo());
  busy = true; hints = []; verdict = null;
  let k = 0;
  const step = () => {
    if (k < puzzle.line.length) {
      const mv = puzzle.line[k++];
      game.move({ from: mv.slice(0, 2), to: mv.slice(2, 4), promotion: mv[4] });
      render();
      setTimeout(step, 600);
    } else {
      busy = false;
      verdict = evaluate(game.history({ verbose: true }));
      setStatus('Solution shown.', 'bad');
      render();
      if (state.results.every(Boolean)) showSummary();
    }
  };
  render();
  setTimeout(step, 250);
}

function showSummary() {
  const r = state.results;
  const clean = r.filter((x) => x === 'clean').length;
  const helped = r.filter((x) => x === 'helped').length;
  const revealed = r.filter((x) => x === 'revealed').length;
  $('summary-text').textContent = `${clean} clean · ${helped} with help · ${revealed} revealed — out of ${SET_SIZE}.`;
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
  const locked = busy || solved();
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
  $('next').disabled = state.index === SET_SIZE - 1;
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
  $('moves-count').textContent = hist.length >= maxPlies() ? 'max moves' : '';
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
$('next').addEventListener('click', () => !busy && state.index < SET_SIZE - 1 && loadPuzzle(state.index + 1));
$('undo').addEventListener('click', undo);
$('clear').addEventListener('click', clearLine);
$('submit').addEventListener('click', submit);
$('hint').addEventListener('click', hint);
$('solution').addEventListener('click', showSolution);
const startNewSet = () => { if (busy) return; state = newSet(); saveState(); loadPuzzle(0); };
$('new-set').addEventListener('click', startNewSet);
$('summary-new').addEventListener('click', startNewSet);

document.addEventListener('keydown', (e) => {
  if (e.target.closest('button')) return;
  if (e.key === 'ArrowLeft') $('prev').click();
  if (e.key === 'ArrowRight') $('next').click();
  if (e.key === 'Backspace') undo();
  if (e.key === 'Enter') submit();
});

loadPuzzle(state.index || 0);
if (state.results.every(Boolean)) showSummary();

// ---------- offline ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
