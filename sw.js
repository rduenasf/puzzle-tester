// Bump VERSION whenever any cached file changes.
const VERSION = 'v22';
const CACHE = `mate-drills-${VERSION}`;
// Engine files (Stockfish, ONNX Runtime: ~19 MB, plus the 46 MB Maia model from GitHub) are
// fetched only when first used and never change under the same URL, so they are served
// cache-first from a cache of their own that survives VERSION bumps. Give a changed file a new name.
const ENGINES = 'mate-drills-engines-v1';
// The Maia model is not in this repo (see MAIA_MODEL_URL in engines.js): a commit-pinned file
// on raw.githubusercontent.com, so its URL is immutable too.
const isEngineFile = (url) => (url.origin === location.origin
  ? url.pathname.includes('/vendor/engines/')
  : url.hostname === 'raw.githubusercontent.com' && url.pathname.endsWith('.onnx'));
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
  if (isEngineFile(url)) {
    e.respondWith(caches.open(ENGINES).then((c) => c.match(e.request, { ignoreSearch: true }).then((hit) => hit
      || fetch(e.request).then((res) => {
        if (res.status === 200) c.put(e.request, res.clone());
        return res;
      }))));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
