// Every position below was checked with a mate solver: the side to move
// can force checkmate in exactly `mate` moves. `line` is one solution in
// UCI notation (player move, reply, player move, ...). The app also accepts
// any other move that keeps a forced mate within the remaining moves.
export const PUZZLES = [
  { id: 'back-rank',     title: 'Back Rank',            mate: 1, fen: '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', line: ['d1d8'] },
  { id: 'scholar',       title: "Scholar's Mate",       mate: 1, fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', line: ['h5f7'] },
  { id: 'fool',          title: "Fool's Mate",          mate: 1, fen: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2', line: ['d8h4'] },
  { id: 'smothered',     title: 'Smothered Mate',       mate: 2, fen: '3r3k/6pp/7N/8/2Q5/8/8/7K w - - 0 1', line: ['c4g8', 'd8g8', 'h6f7'] },
  { id: 'philidor',      title: "Philidor's Legacy",    mate: 2, fen: 'r6k/6pp/7N/8/8/1Q6/8/6K1 w - - 0 1', line: ['b3g8', 'a8g8', 'h6f7'] },
  { id: 'arabian',       title: 'Arabian Mate',         mate: 1, fen: '7k/R7/5N2/8/8/8/8/6K1 w - - 0 1', line: ['a7h7'] },
  { id: 'black-back',    title: 'Back Rank (Black)',    mate: 1, fen: '1r4k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1', line: ['b8b1'] },
  { id: 'epaulette',     title: 'Epaulette Mate',       mate: 1, fen: '3rkr2/8/8/8/8/7Q/8/4K3 w - - 0 1', line: ['h3e6'] },
  { id: 'morphy',        title: 'Queen Deflection',     mate: 2, fen: 'r1b2k1r/ppp1bppp/8/1B1Q4/5q2/2P5/PPP2PPP/R3R1K1 w - - 1 1', line: ['d5d8', 'e7d8', 'e1e8'] },
  { id: 'opera',         title: 'The Opera Game',       mate: 2, fen: '4kb1r/p2n1ppp/4q3/4p1B1/4P3/1Q6/PPP2PPP/2KR4 w k - 1 1', line: ['b3b8', 'd7b8', 'd1d8'] },
  { id: 'legal',         title: "Légal's Mate",         mate: 2, fen: 'rn1qkbnr/ppp2p1p/3p2p1/4N3/2B1P3/2N5/PPPP1PPP/R1BbK2R w KQkq - 0 6', line: ['c4f7', 'e8e7', 'c3d5'] },
  { id: 'ladder',        title: 'Rook Roller',          mate: 2, fen: '6k1/8/8/8/8/8/R7/1R4K1 w - - 0 1', line: ['a2a7', 'g8h8', 'b1b8'] },
  { id: 'promotion',     title: 'Promote to Mate',      mate: 1, fen: '6k1/4P3/6K1/8/8/8/8/8 w - - 0 1', line: ['e7e8q'] },
  { id: 'lolli',         title: "Lolli's Mate",         mate: 1, fen: 'r4rk1/5p1p/5PpQ/8/8/8/5PPP/6K1 w - - 0 1', line: ['h6g7'] },
  { id: 'anastasia',     title: "Anastasia's Mate",     mate: 1, fen: '5r1k/4Npp1/8/8/8/R7/8/6K1 w - - 0 1', line: ['a3h3'] },
  { id: 'black-queen',   title: 'Queen Strike (Black)', mate: 1, fen: '6k1/5ppp/8/8/8/2q5/5PPP/6K1 b - - 0 1', line: ['c3e1'] },
  { id: 'damiano',       title: "Damiano's Mate",       mate: 1, fen: '5rk1/7p/6PQ/8/8/8/8/6K1 w - - 0 1', line: ['h6h7'] },
  { id: 'rook-king',     title: 'Rook & King',          mate: 1, fen: 'k7/8/1K6/8/8/8/8/7R w - - 0 1', line: ['h1h8'] },
  { id: 'queen-king',    title: 'Queen & King',         mate: 1, fen: 'k7/8/1K6/8/8/8/8/7Q w - - 0 1', line: ['h1h8'] },
  { id: 'quiet-queen',   title: 'Back Rank II',         mate: 1, fen: '6k1/5ppp/8/6N1/8/8/5PPP/3Q2K1 w - - 0 1', line: ['d1d8'] },
  { id: 'hook',          title: 'Bishop Support',       mate: 1, fen: '6k1/5p1p/5Bp1/8/8/8/5PPP/3R2K1 w - - 0 1', line: ['d1d8'] },
  { id: 'two-bishops',   title: 'Two Bishops',          mate: 3, fen: '7k/8/6K1/8/8/8/8/2BB4 w - - 0 1', line: ['g6f7', 'h8h7', 'd1c2', 'h7h8', 'c1b2'] },
];
