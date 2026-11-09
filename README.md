# Mate Drills

A small installable PWA with a chessboard and random sets of 10 checkmate puzzles. Mate mode has four sections, each with its own set and progress: **Patterns** (22 classic mating patterns) and **Mate in 1 / 2 / 3** from László Polgár's *Chess: 5334 Problems, Combinations and Games*.

- Play the whole line on the board (your moves and the defence), shown in the move list, then hit **Submit**. Any of your moves that still forces mate counts as correct; each is marked ✓ or ✗.
- Hint highlights the piece to move, then the target square. Solution plays it out.
- Progress is saved in the browser; **New set** draws another 10.
- Works offline after the first visit (service worker).

## Strategy mode

The **Strategy** toggle switches to quiet positional problems mined from my own games by the tool in [`miner/`](miner/) (Stockfish + Maia-3). **Review** lists every mined problem with filters and an explanation of each one. You play one move; it is graded from Stockfish's precomputed scores for every legal move (Best ≤10cp, Good ≤30cp count as solved). After solving or revealing, the page shows the move from the original game and links to it. `strategic.js` and `strategic_review.js` are generated data; don't edit them by hand. Game downloads and mining outputs (PGN, CSV, the engine cache) stay in `miner/work/`, which is git-ignored. The criteria and their reasoning are in [MINING-DECISIONS.md](MINING-DECISIONS.md).

## Play it out vs engine

The **Play it out vs engine** box plays the other side from whatever is on the board, in any mode. Play a move (a wrong one, say), then **Play from here** to see how the engine punishes it; **Switch sides** lets the engine take your side instead. Opponents:

- **Stockfish** 18 (lite, single-threaded WASM, ~7 MB): full strength or a set Elo. Each reply shows its eval and expected line.
- **Maia-3** (ONNX, 46 MB, downloaded on first use): picks moves by how likely a human at the chosen rating is to play them, and shows the top choices with their percentages.

Both run in the browser and work offline once loaded. Sources and licenses: [`vendor/engines/README.md`](vendor/engines/README.md).

## Run locally

```bash
npx http-server -p 8137 -c-1 .
```

## Adding puzzles

Append to `puzzles.js`: a FEN, the mate length, and one solution line in UCI. Positions should be a forced mate for the side to move.
`polgar.js` is generated: download `problems.json` from [denialromeo/4462-chess-problems](https://github.com/denialromeo/4462-chess-problems) and run `node tools/import_polgar.mjs path/to/problems.json`. It checks every problem with the app's solver (`matesolver.js`) and drops any whose book line doesn't force mate in the stated number of moves.
When you change any cached file, bump `VERSION` in `sw.js`.

## Drawing

Like Lichess: right-click a square for a circle, right-drag for an arrow. Shift or Ctrl = red, Alt = blue, Shift+Alt = yellow. Left-click clears them.

## Credits

- Board: [Chessground](https://github.com/lichess-org/chessground) by lichess (GPL-3.0, see `vendor/chessground.LICENSE`), including the "cburnett" pieces by Colin M.L. Burnett (CC BY-SA 3.0).

- Mate-in-N problems: László Polgár, *Chess: 5334 Problems, Combinations and Games* (1994), via [denialromeo/4462-chess-problems](https://github.com/denialromeo/4462-chess-problems).

- Engines: [Stockfish.js](https://github.com/nmrugg/stockfish.js) (GPL-3.0), Maia-3 from the [Maia platform](https://github.com/CSSLab/maia-platform-frontend) (GPL-3.0; the Maia worker is adapted from theirs), [ONNX Runtime Web](https://onnxruntime.ai/) (MIT).

- Move generation: [chess.js](https://github.com/jhlywa/chess.js) (BSD-2-Clause, see `vendor/chess.js.LICENSE`).

## License

GPL-3.0 (required by Chessground). See `LICENSE`.
