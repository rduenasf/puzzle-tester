import { Chess } from './vendor/chess.js';
import { PUZZLES } from './puzzles.js';

const SET_SIZE = 10;
const STORE_KEY = 'mate-drills-v1';
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const VS = '︎'; // force text (not emoji) presentation
const FILES = 'abcdefgh';

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
let game, puzzle, player, onLine, busy, selected, hintLevel, mistakes, lastMove, usedHint = false;

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
function loadPuzzle(i) {
  state.index = i;
  saveState();
  puzzle = PUZZLES.find((p) => p.id === state.ids[i]);
  game = new Chess(puzzle.fen);
  player = game.turn();
  onLine = true;
  busy = false;
  selected = null;
  hintLevel = 0;
  mistakes = 0;
  usedHint = false;
  lastMove = null;
  $('title').textContent = `${i + 1}. ${puzzle.title}`;
  $('subtitle').textContent = `${player === 'w' ? 'White' : 'Black'} to move · mate in ${puzzle.mate}`;
  $('turn').className = `turn ${player}`;
  setStatus(state.results[i] ? 'Already solved — play it again or move on.' : 'Find the best move.');
  $('summary').hidden = true;
  render();
}

function movesPlayed() { return game.history({ verbose: true }).length; }
function movesLeft() { return puzzle.mate - Math.floor(movesPlayed() / 2); }

function expectedMove() {
  // Next player move: from the stored line if we're still on it, else from the solver.
  if (onLine) return puzzle.line[movesPlayed()];
  const s = shortestMate(game, movesLeft());
  return s ? uci(s.move) : null;
}

function tryPlayerMove(from, to) {
  if (busy || game.turn() !== player || isDone()) return false;
  const legal = game.moves({ square: from, verbose: true }).filter((m) => m.to === to);
  if (!legal.length) return false;

  // Promotion: use the line's piece if it matches, otherwise a queen.
  const want = expectedMove();
  let promo;
  if (legal[0].promotion) {
    promo = want && want.slice(0, 4) === from + to && want[4] ? want[4] : 'q';
  }
  const m = game.move({ from, to, promotion: promo });
  selected = null;

  const remaining = puzzle.mate - Math.floor((movesPlayed() - 1) / 2) - 1;
  const correct = game.isCheckmate() || (remaining > 0 && !game.isGameOver() && allRepliesLose(game, remaining));

  if (!correct) {
    mistakes++;
    lastMove = m;
    render();
    setStatus('Not the move — try again.', 'bad');
    boardEl.classList.remove('shake'); void boardEl.offsetWidth; boardEl.classList.add('shake');
    busy = true;
    setTimeout(() => { game.undo(); lastMove = prevMove(); busy = false; render(); }, 650);
    return true;
  }

  if (onLine && uci(m) !== puzzle.line[movesPlayed() - 1]) onLine = false;
  lastMove = m;
  hintLevel = 0;

  if (game.isCheckmate()) { finish(); return true; }

  setStatus('Good move! Keep going…', 'good');
  render();
  busy = true;
  setTimeout(() => {
    const idx = movesPlayed();
    let reply = onLine ? puzzle.line[idx] : null;
    let r = reply ? game.move(reply) : null;
    if (!r) { onLine = false; r = game.move(stubbornReply(game, remaining)); }
    lastMove = r;
    busy = false;
    setStatus('Your move.');
    render();
  }, 450);
  return true;
}

function prevMove() {
  const h = game.history({ verbose: true });
  return h[h.length - 1] || null;
}

function isDone() { return game.isCheckmate(); }

function finish() {
  const i = state.index;
  if (!state.results[i]) {
    state.results[i] = hintLevel === 'revealed' ? 'revealed' : (mistakes || usedHint ? 'helped' : 'clean');
  }
  usedHint = false;
  saveState();
  const msg = { clean: 'Checkmate! Solved cleanly.', helped: 'Checkmate! Solved with help.', revealed: 'Checkmate — solution shown.' }[state.results[i]];
  setStatus(msg, state.results[i] === 'revealed' ? 'bad' : 'good');
  render();
  if (state.results.every(Boolean)) showSummary();
}


function hint() {
  if (busy || isDone() || game.turn() !== player) return;
  const mv = expectedMove();
  if (!mv) return;
  usedHint = true;
  if (hintLevel === 0) {
    hintLevel = 1;
    render([mv.slice(0, 2)]);
    setStatus('Hint: move the highlighted piece.');
  } else {
    hintLevel = 2;
    render([mv.slice(0, 2), mv.slice(2, 4)]);
    setStatus('Hint: from → to is highlighted.');
  }
}

function showSolution() {
  if (busy || isDone()) return;
  if (!state.results[state.index]) state.results[state.index] = 'revealed';
  saveState();
  hintLevel = 'revealed';
  const step = () => {
    if (isDone()) { finish(); return; }
    const mv = game.turn() === player ? expectedMove() : (onLine ? puzzle.line[movesPlayed()] : uci(stubbornReply(game, movesLeft())));
    const r = game.move({ from: mv.slice(0, 2), to: mv.slice(2, 4), promotion: mv[4] });
    lastMove = r;
    render();
    setTimeout(step, 650);
  };
  busy = true;
  setTimeout(() => { busy = false; step(); }, 0);
}

function showSummary() {
  const r = state.results;
  const clean = r.filter((x) => x === 'clean').length;
  const helped = r.filter((x) => x === 'helped').length;
  const revealed = r.filter((x) => x === 'revealed').length;
  $('summary-text').textContent = `${clean} clean · ${helped} with help · ${revealed} revealed — out of ${SET_SIZE}.`;
  $('summary').hidden = false;
}

// ---------- rendering ----------
function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${kind}`;
}

function squareOrder() {
  const sq = [];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const rank = player === 'w' ? 8 - r : r + 1;
    const file = player === 'w' ? f : 7 - f;
    sq.push(FILES[file] + rank);
  }
  return sq;
}

function render(hints = []) {
  const targets = selected ? game.moves({ square: selected, verbose: true }) : [];
  const checkSq = game.inCheck() ? findKing(game.turn()) : null;
  boardEl.textContent = '';
  squareOrder().forEach((s, i) => {
    const el = document.createElement('div');
    const f = FILES.indexOf(s[0]), r = +s[1];
    el.className = `sq ${(f + r) % 2 ? 'dark' : 'light'}`;
    el.dataset.square = s;
    el.setAttribute('role', 'gridcell');
    if (lastMove && (lastMove.from === s || lastMove.to === s)) el.classList.add('last');
    if (selected === s) el.classList.add('sel');
    if (hints.includes(s)) el.classList.add('hint');
    if (checkSq === s) el.classList.add('check');
    const t = targets.find((m) => m.to === s);
    if (t) { el.classList.add('target'); if (t.captured) el.classList.add('capture'); }

    const p = game.get(s);
    if (p) {
      const span = document.createElement('span');
      span.className = `piece ${p.color}`;
      span.textContent = GLYPH[p.type] + VS;
      el.appendChild(span);
      el.setAttribute('aria-label', `${s} ${p.color === 'w' ? 'white' : 'black'} ${pieceName(p.type)}`);
    } else {
      el.setAttribute('aria-label', s);
    }
    if (i % 8 === 0) el.appendChild(coord('rank', s[1]));
    if (i >= 56) el.appendChild(coord('file', s[0]));
    boardEl.appendChild(el);
  });
  renderProgress();
  $('prev').disabled = state.index === 0;
  $('next').disabled = state.index === SET_SIZE - 1;
  $('hint').disabled = isDone();
  $('solution').disabled = isDone();
}

function coord(kind, text) {
  const c = document.createElement('span');
  c.className = `coord ${kind}`;
  c.textContent = text;
  return c;
}
function pieceName(t) { return { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' }[t]; }
function findKing(color) {
  for (const row of game.board()) for (const p of row) if (p && p.type === 'k' && p.color === color) return p.square;
  return null;
}

function renderProgress() {
  const ol = $('progress');
  ol.textContent = '';
  state.ids.forEach((_, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = i + 1;
    b.className = [state.results[i] || '', i === state.index ? 'current' : ''].join(' ');
    b.setAttribute('aria-label', `Puzzle ${i + 1}${state.results[i] ? `, ${state.results[i]}` : ''}`);
    b.addEventListener('click', () => loadPuzzle(i));
    li.appendChild(b);
    ol.appendChild(li);
  });
}

// ---------- input: tap and drag ----------
let drag = null;

function squareAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const sq = el && el.closest('.sq');
  return sq && boardEl.contains(sq) ? sq.dataset.square : null;
}
function ownPiece(s) {
  const p = s && game.get(s);
  return p && p.color === player && game.turn() === player;
}

boardEl.addEventListener('pointerdown', (e) => {
  if (busy || isDone()) return;
  const s = squareAt(e.clientX, e.clientY);
  if (!s) return;

  if (selected && selected !== s && !ownPiece(s)) {
    if (!tryPlayerMove(selected, s)) { selected = null; render(); }
    return;
  }
  if (!ownPiece(s)) { selected = null; render(); return; }

  const wasSelected = selected === s;
  selected = s;
  render();
  const pieceEl = boardEl.querySelector(`[data-square="${s}"] .piece`);
  const ghost = pieceEl.cloneNode(true);
  ghost.classList.add('drag-ghost');
  ghost.style.left = e.clientX + 'px';
  ghost.style.top = e.clientY + 'px';
  ghost.style.fontSize = getComputedStyle(pieceEl).fontSize;
  ghost.hidden = true;
  document.body.appendChild(ghost);
  drag = { from: s, ghost, pieceEl, x0: e.clientX, y0: e.clientY, moved: false, wasSelected };
  try { boardEl.setPointerCapture(e.pointerId); } catch {}
});

boardEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
  drag.moved = true;
  drag.ghost.hidden = false;
  drag.pieceEl.classList.add('dragging-origin');
  drag.ghost.style.left = e.clientX + 'px';
  drag.ghost.style.top = e.clientY + 'px';
});

function endDrag(e, cancel) {
  if (!drag) return;
  const d = drag;
  drag = null;
  d.ghost.remove();
  if (cancel) { render(); return; }
  if (d.moved) {
    const to = squareAt(e.clientX, e.clientY);
    if (!to || to === d.from || !tryPlayerMove(d.from, to)) render();
  } else if (d.wasSelected) {
    selected = null;
    render();
  }
}
boardEl.addEventListener('pointerup', (e) => endDrag(e, false));
boardEl.addEventListener('pointercancel', (e) => endDrag(e, true));

// ---------- buttons ----------
$('prev').addEventListener('click', () => state.index > 0 && loadPuzzle(state.index - 1));
$('next').addEventListener('click', () => state.index < SET_SIZE - 1 && loadPuzzle(state.index + 1));
$('retry').addEventListener('click', () => { if (!busy) loadPuzzle(state.index); });
$('hint').addEventListener('click', hint);
$('solution').addEventListener('click', showSolution);
const startNewSet = () => { state = newSet(); saveState(); loadPuzzle(0); };
$('new-set').addEventListener('click', startNewSet);
$('summary-new').addEventListener('click', startNewSet);

document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') $('prev').click();
  if (e.key === 'ArrowRight') $('next').click();
});

loadPuzzle(state.index || 0);
if (state.results.every(Boolean)) showSummary();

// ---------- offline ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
