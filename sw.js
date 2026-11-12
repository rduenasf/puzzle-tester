// Bump VERSION whenever any cached file changes.
const VERSION = 'v55';
const CACHE = `mate-drills-${VERSION}`;
// Engine files (Stockfish, ONNX Runtime: ~14 MB, plus the 46 MB Maia model from GitHub and the
// 99 MB full Stockfish wasm from unpkg) are
// fetched only when first used and never change under the same URL, so they are served
// cache-first from a cache of their own that survives VERSION bumps. Give a changed file a new name.
const ENGINES = 'mate-drills-engines-v1';
// The Maia model and the full Stockfish wasm are not in this repo (see MAIA_MODEL_URL and
// SF_WASM_URL in engines.js): a commit-pinned file on raw.githubusercontent.com and a
// version-pinned npm file on unpkg, so their URLs are immutable too.
const isEngineFile = (url) => (url.origin === location.origin
  ? url.pathname.includes('/vendor/engines/')
  : (url.hostname === 'raw.githubusercontent.com' && url.pathname.endsWith('.onnx'))
    || (url.hostname === 'unpkg.com' && url.pathname.startsWith('/stockfish@') && url.pathname.endsWith('.wasm')));

// Cross-origin isolation, which multi-threaded Stockfish needs (SharedArrayBuffer). GitHub Pages
// can't send these headers, so every same-origin response gets them here (the coi-serviceworker
// trick). It takes effect from the first load this worker controls; engines.js falls back to the
// single-threaded build until then. Cross-origin files must then be CORS or CORP: the Maia model
// and the Stockfish wasm are fetched with CORS.
const pending = new Map(); // engine downloads in flight, by URL
const isolate = (res) => {
  if (!res || res.type === 'opaque' || res.type === 'opaqueredirect' || res.status === 0) return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
};
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './puzzles.js',
  './polgar.js',
  './matesolver.js',
  './engines.js',
  './maia-worker.js',
  './strategic.js',
  './strategic_review.js',
  './vendor/chess.js',
  './vendor/chessground.min.js',
  './vendor/chessground.base.css',
  './vendor/chessground.brown.css',
  './vendor/chessground.cburnett.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('mate-drills-') && k !== CACHE && k !== ENGINES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first: always fresh when online, cached copy when offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (e.request.cache === 'only-if-cached' && e.request.mode !== 'same-origin') return;
  const same = url.origin === location.origin;
  if (isEngineFile(url)) {
    e.respondWith((async () => {
      const c = await caches.open(ENGINES);
      let res = await c.match(e.request, { ignoreSearch: true });
      if (!res) {
        // The opponent and the eval bar each run a Stockfish: download its 99 MB wasm only once.
        // A second request waits for the first one's copy to be cached, then reads that.
        const key = url.origin + url.pathname;
        const first = pending.get(key);
        if (first) {
          await first;
          res = (await c.match(e.request, { ignoreSearch: true })) || await fetch(e.request);
        } else {
          let done;
          pending.set(key, new Promise((r) => { done = () => { pending.delete(key); r(); }; }));
          try {
            res = await fetch(e.request);
          } catch (err) { done(); throw err; }
          if (res.status === 200) e.waitUntil(c.put(e.request, res.clone()).catch(() => {}).then(done));
          else done();
        }
      }
      return same ? isolate(res) : res;
    })());
    return;
  }
  if (!same) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
      .then(isolate)
  );
});
