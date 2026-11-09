// Maia-3 in a Web Worker: downloads the ONNX model once (the service worker keeps it
// for offline use) and runs ONNX Runtime off the main thread.
// Adapted from the Maia platform's worker (CSSLab/maia-platform-frontend, GPL-3.0).
//
// From the page: { type: 'init', ortUrl, modelUrl } then { type: 'run', id, tokens, eloSelf, eloOppo }
// To the page:   { type: 'progress', loaded, total } · { type: 'ready' } · { type: 'error', message, id? }
//                { type: 'result', id, logitsMove, logitsValue }

// ONNX Runtime's WebAssembly asks for a memory that may grow to 4 GB, reserved up front.
// iPhones refuse that after a few reloads; Maia needs well under 268 MB for one position.
const MAX_MEMORY_PAGES = 4096; // of 64 KiB
const NativeMemory = WebAssembly.Memory;
WebAssembly.Memory = function Memory(d) {
  return new NativeMemory(d && d.shared && d.maximum > MAX_MEMORY_PAGES ? { ...d, maximum: MAX_MEMORY_PAGES } : d);
};
WebAssembly.Memory.prototype = NativeMemory.prototype;

let session = null;

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model download failed (${res.status})`);
  const total = +res.headers.get('content-length') || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0, last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    const now = Date.now();
    if (now - last > 200) { last = now; postMessage({ type: 'progress', loaded, total }); }
  }
  const buf = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.length; }
  return buf;
}

onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      importScripts(msg.ortUrl + 'ort.wasm.min.js');
      ort.env.wasm.wasmPaths = msg.ortUrl;
      ort.env.wasm.numThreads = 1; // no cross-origin isolation on GitHub Pages
      ort.env.logLevel = 'error'; // skip "Unknown CPU vendor" warnings
      const model = await download(msg.modelUrl);
      session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
      postMessage({ type: 'ready' });
    } else if (msg.type === 'run') {
      if (!session) throw new Error('Maia is not loaded');
      const feeds = {
        tokens: new ort.Tensor('float32', new Float32Array(msg.tokens), [1, 64, 12]),
        elo_self: new ort.Tensor('float32', Float32Array.from([msg.eloSelf]), [1]),
        elo_oppo: new ort.Tensor('float32', Float32Array.from([msg.eloOppo]), [1]),
      };
      const out = await session.run(feeds);
      const logitsMove = new Float32Array(out.logits_move.data);
      const logitsValue = new Float32Array(out.logits_value.data);
      postMessage({ type: 'result', id: msg.id, logitsMove, logitsValue }, [logitsMove.buffer, logitsValue.buffer]);
    }
  } catch (err) {
    postMessage({ type: 'error', message: err && err.message ? err.message : String(err), id: msg.id });
  }
};
