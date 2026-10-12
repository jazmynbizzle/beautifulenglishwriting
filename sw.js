const CACHE = 'beautiful-english-writing-v7';
const ASSETS = ['./', './styles.css', './app.js', './favicon.svg', './manifest.webmanifest', './vendor/tesseract.min.js', './vendor/worker.min.js', './vendor/tesseract-core-simd-lstm.wasm.js', './vendor/tesseract-core-simd-lstm.wasm', './vendor/eng.traineddata.gz'].map(path => new URL(path, self.registration.scope).href);
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then(r => r || caches.match(new URL('./', self.registration.scope).href))));
});
