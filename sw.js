const CACHE = 'planeta-hq-shell-v2';
const RUNTIME_CACHE = 'planeta-hq-runtime-v2';
const SHELL = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png'];

// Hosts de onde vem a biblioteca de leitura de CBR (libarchive.js + seu .wasm).
// Guardamos em cache a primeira vez que carregarem com sucesso, pra HQs em CBR
// já baixadas continuarem abrindo mesmo sem internet depois disso.
const RUNTIME_CACHE_HOSTS = ['cdn.jsdelivr.net', 'unpkg.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE && k !== RUNTIME_CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  if (RUNTIME_CACHE_HOSTS.includes(url.hostname)) {
    // Cache-first: se já carregou uma vez, abre na hora e funciona offline.
    // Se ainda não tem em cache, busca na rede e guarda pra próxima.
    e.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(e.request);
        if (cached) return cached;
        try {
          const res = await fetch(e.request);
          if (res && res.ok) cache.put(e.request, res.clone());
          return res;
        } catch (err) {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // Resto do app (casca): tenta a rede primeiro, cai pro cache se estiver offline.
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
