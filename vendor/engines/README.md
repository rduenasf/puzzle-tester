# Engines for "Play it out vs engine"

Loaded only when first used. The service worker serves everything in this folder
cache-first, so a changed file needs a new name.

| Files | Source | License |
| --- | --- | --- |
| `stockfish/stockfish-18-lite-single.{js,wasm}` | npm `stockfish@18.0.8` (Stockfish.js by Nathan Rugg / Chess.com), `bin/` | GPL-3.0 (`stockfish/LICENSE.txt`) |
| `ort/ort.wasm.min.js`, `ort/ort-wasm-simd-threaded.{mjs,wasm}` | npm `onnxruntime-web@1.23.2`, `dist/` | MIT |
| `maia/all_moves_maia3.json` | [CSSLab/maia-platform-frontend](https://github.com/CSSLab/maia-platform-frontend) (`src/lib/engine/data/`) | GPL-3.0 |

The Maia-3 model itself (`maia3_simplified.onnx`, 46 MB) is not in this repo. Each browser
downloads it, the first time Maia is picked, from the Maia platform's repo at a pinned commit:
see `MAIA_MODEL_URL` in `engines.js`. `sw.js` then keeps it for offline use.

The single-threaded builds are used because GitHub Pages can't send the
cross-origin isolation headers that threads need.
