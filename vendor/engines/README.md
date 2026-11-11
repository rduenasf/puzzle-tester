# Engines for "Play it out vs engine"

Loaded only when first used. The service worker serves everything in this folder
cache-first, so a changed file needs a new name.

| Files | Source | License |
| --- | --- | --- |
| `stockfish/stockfish-19.js`, `stockfish/stockfish-19-lite-single.{js,wasm}` | npm `stockfish@19.0.1` (Stockfish.js by Nathan Rugg / Chess.com), `bin/` | GPL-3.0 (`stockfish/LICENSE.txt`) |
| `ort/ort.wasm.min.js`, `ort/ort-wasm-simd-threaded.{mjs,wasm}` | npm `onnxruntime-web@1.23.2`, `dist/` | MIT |
| `maia/all_moves_maia3.json` | [CSSLab/maia-platform-frontend](https://github.com/CSSLab/maia-platform-frontend) (`src/lib/engine/data/`) | GPL-3.0 |

The Maia-3 model itself (`maia3_simplified.onnx`, 46 MB) is not in this repo. Each browser
downloads it, the first time Maia is picked, from the Maia platform's repo at a pinned commit:
see `MAIA_MODEL_URL` in `engines.js`. `sw.js` then keeps it for offline use.

The full multi-threaded Stockfish's wasm (`stockfish-19.wasm`, 99 MB, too big to keep in git
comfortably) is not in this repo either: it comes from unpkg, pinned to `stockfish@19.0.1`
(see `SF_WASM_URL` in `engines.js`), and `sw.js` keeps it too.

Threads need a cross-origin isolated page. GitHub Pages can't send those headers, so `sw.js`
adds them to every response it serves. Until it controls the page (on the very first visit),
the lite single-threaded Stockfish is used. Maia's ONNX Runtime still runs on one thread.
