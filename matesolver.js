// Forced-mate search for small depths (mate in 1–3), shared by the app and tools/.
// canMate(game, n): a move that forces mate in at most n moves, or null.
// allRepliesLose(game, n): every reply of the side to move leaves a forced mate in n.
// Both restore `game` to the position they were given.
//
// Speed-ups over plain search, all exact:
// - mate in 1 reads chess.js's SAN ('#') instead of playing every move;
// - checks, then captures, are tried first, so a mate is usually found early;
// - results are cached per position and depth for the duration of one top-level call.

let cache = null;
const key = (game, n, who) => `${who}${n} ${game.fen().split(' ').slice(0, 4).join(' ')}`;
const rank = (m) => (m.san.endsWith('+') ? 0 : m.captured ? 1 : 2);

function withCache(fn) {
  if (cache) return fn();
  cache = new Map();
  try { return fn(); } finally { cache = null; }
}

function mateSearch(game, n) {
  const moves = game.moves({ verbose: true });
  const mate1 = moves.find((m) => m.san.endsWith('#'));
  if (mate1 || n <= 1) return mate1 || null;
  const k = key(game, n, 'a');
  if (cache.has(k)) {
    const san = cache.get(k);
    return san ? moves.find((m) => m.san === san) : null;
  }
  moves.sort((a, b) => rank(a) - rank(b));
  let found = null;
  for (const m of moves) {
    game.move(m);
    const ok = !game.isGameOver() && repliesLose(game, n - 1);
    game.undo();
    if (ok) { found = m; break; }
  }
  cache.set(k, found ? found.san : null);
  return found;
}

function repliesLose(game, n) {
  const k = key(game, n, 'd');
  if (cache.has(k)) return cache.get(k);
  let lost = true;
  for (const r of game.moves({ verbose: true })) {
    game.move(r);
    const mated = !!mateSearch(game, n);
    game.undo();
    if (!mated) { lost = false; break; }
  }
  cache.set(k, lost);
  return lost;
}

export const canMate = (game, n) => withCache(() => mateSearch(game, n));
export const allRepliesLose = (game, n) => withCache(() => repliesLose(game, n));
