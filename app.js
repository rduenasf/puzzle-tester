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
let game, puzzle, player, busy, selected, hints, verdict, mistakes, usedHelp;

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
const maxPlies = () => puzzle.mate * 2 - 1;
const plies = () => game.history().length;
const solved = () => verdict && verdict.ok;

function loadPuzzle(i) {
  state.index = i;
  saveState();
  puzzle = PUZZLES.find((p) => p.id === state.ids[i]);
  game = new Chess(puzzle.fen);
  player = game.turn();
  busy = false;
  selected = null;
  hints = [];
  verdict = null;
  mistakes = 0;
  usedHelp = false;
  $('title').textContent = `${i + 1}. ${puzzle.title}`;
  $('subtitle').textContent = `${side(player)} to move · mate in ${puzzle.mate}`;
  $('turn').className = `turn ${player}`;
  setStatus(state.results[i]
    ? 'Already done — play it again or move on.'
    : `Enter the full line (both sides, ${maxPlies()} move${maxPlies() > 1 ? 's' : ''}), then Submit.`);
  $('summary').hidden = true;
  render();
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
  selected = null;
  hints = [];
  verdict = null; // editing the line clears an old verdict
  if (plies() >= maxPlies() || game.isGameOver()) setStatus('Line complete — hit Submit.');
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
    const good = g.isCheckmate() || (remaining > 0 && !g.isGameOver() && allRepliesLose(g, remaining));
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
    setStatus(`Not quite — your move ${n} doesn't force mate. Undo and try again.`, 'bad');
    shake();
  }
  render();
}

function undo() {
  if (busy || solved() || !plies()) return;
  game.undo();
  selected = null; hints = []; verdict = null;
  setStatus(`${side(game.turn())} to play.`);
  render();
}
function clearLine() {
  if (busy || solved()) return;
  while (game.undo());
  selected = null; hints = []; verdict = null;
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
  if (plies() >= maxPlies()) return;
  usedHelp = true;
  const remaining = puzzle.mate - Math.floor(plies() / 2);
  let mv;
  if (game.turn() === player) {
    mv = plies() === 0 ? puzzle.line[0] : uci(shortestMate(game, remaining).move);
    hints = hints.length ? [mv.slice(0, 2), mv.slice(2, 4)] : [mv.slice(0, 2)];
    setStatus(hints.length === 1 ? 'Hint: move the highlighted piece.' : 'Hint: from → to is highlighted.');
  } else {
    mv = uci(stubbornReply(game, remaining));
    hints = [mv.slice(0, 2), mv.slice(2, 4)];
    setStatus(`Hint: ${side(game.turn())}'s toughest defence is highlighted.`);
  }
  render();
}

function showSolution() {
  if (busy || solved()) return;
  const i = state.index;
  if (!state.results[i]) state.results[i] = 'revealed';
  saveState();
  while (game.undo());
  busy = true; selected = null; hints = []; verdict = null;
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

function squareOrder() {
  const sq = [];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const rank = player === 'w' ? 8 - r : r + 1;
    const file = player === 'w' ? f : 7 - f;
    sq.push(FILES[file] + rank);
  }
  return sq;
}

function render() {
  const targets = selected ? game.moves({ square: selected, verbose: true }) : [];
  const checkSq = game.inCheck() ? findKing(game.turn()) : null;
  const hist = game.history({ verbose: true });
  const last = hist[hist.length - 1];
  boardEl.textContent = '';
  squareOrder().forEach((s, i) => {
    const el = document.createElement('div');
    const f = FILES.indexOf(s[0]), r = +s[1];
    el.className = `sq ${(f + r) % 2 ? 'dark' : 'light'}`;
    el.dataset.square = s;
    el.setAttribute('role', 'gridcell');
    if (last && (last.from === s || last.to === s)) el.classList.add('last');
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
  renderMoves(hist);
  renderProgress();
  const locked = busy || solved();
  $('prev').disabled = state.index === 0;
  $('next').disabled = state.index === SET_SIZE - 1;
  $('hint').disabled = locked || plies() >= maxPlies();
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
  const left = maxPlies() - hist.length;
  $('moves-count').textContent = solved() ? '' : left > 0 ? `${left} to go` : 'ready';
  $('moves-empty').hidden = hist.length > 0;
}
function cell(text, cls) {
  const s = document.createElement('span');
  s.className = `mv ${cls}`.trim();
  s.textContent = text;
  return s;
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
    b.className = [state.results[i] || '', i === state.index ? 'current' : ''].join(' ').trim();
    b.setAttribute('aria-label', `Puzzle ${i + 1}${state.results[i] ? `, ${state.results[i]}` : ''}`);
    b.addEventListener('click', () => !busy && loadPuzzle(i));
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
function movable(s) {
  const p = s && game.get(s);
  return p && p.color === game.turn() && !busy && !solved() && plies() < maxPlies();
}

boardEl.addEventListener('pointerdown', (e) => {
  const s = squareAt(e.clientX, e.clientY);
  if (!s) return;

  if (selected && selected !== s && !movable(s)) {
    if (!enterMove(selected, s)) { selected = null; render(); }
    return;
  }
  if (!movable(s)) { if (selected) { selected = null; render(); } return; }

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
    if (!to || to === d.from || !enterMove(d.from, to)) render();
  } else if (d.wasSelected) {
    selected = null;
    render();
  }
}
boardEl.addEventListener('pointerup', (e) => endDrag(e, false));
boardEl.addEventListener('pointercancel', (e) => endDrag(e, true));

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
