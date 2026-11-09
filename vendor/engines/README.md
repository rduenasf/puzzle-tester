# Engines for "Play it out vs engine"

Loaded only when first used. The service worker serves everything in this folder
cache-first, so a changed file needs a new name.

| Files | Source | License |
| --- | --- | --- |
| `stockfish/stockfish-18-lite-single.{js,wasm}` | npm `stockfish@18.0.8` (Stockfish.js by Nathan Rugg / Chess.com), `bin/` | GPL-3.0 (`stockfish/LICENSE.txt`) |
| `ort/ort.wasm.min.js`, `ort/ort-wasm-simd-threaded.{mjs,wasm}` | npm `onnxruntime-web@1.23.2`, `dist/` | MIT |
| `maia/maia3_simplified.onnx`, `maia/all_moves_maia3.json` | [CSSLab/maia-platform-frontend](https://github.com/CSSLab/maia-platform-frontend) (`public/maia3/`, `src/lib/engine/data/`) | GPL-3.0 |

The single-threaded builds are used because GitHub Pages can't send the
cross-origin isolation headers that threads need.
