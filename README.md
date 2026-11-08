# Mate Drills

A small installable PWA with a chessboard and a random set of 10 checkmate puzzles, drawn from a pool of 22.

- Play the whole line on the board (your moves and the defence), shown in the move list, then hit **Submit**. Any of your moves that still forces mate counts as correct; each is marked ✓ or ✗.
- Hint highlights the piece to move, then the target square. Solution plays it out.
- Progress is saved in the browser; **New set** draws another 10.
- Works offline after the first visit (service worker).

## Run locally

```bash
npx http-server -p 8137 -c-1 .
```

## Adding puzzles

Append to `puzzles.js`: a FEN, the mate length, and one solution line in UCI. Positions should be a forced mate for the side to move.
When you change any cached file, bump `VERSION` in `sw.js`.

## Credits

Move generation by [chess.js](https://github.com/jhlywa/chess.js) (BSD-2-Clause, see `vendor/chess.js.LICENSE`).
