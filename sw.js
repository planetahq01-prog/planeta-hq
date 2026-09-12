/*
  Service worker do Planeta HQ.
  Objetivo único: garantir que a "casca" do app (HTML/CSS/JS + bibliotecas
  externas) abra mesmo sem internet. A leitura das HQs baixadas continua
  sendo resolvida pelo próprio app via IndexedDB — este arquivo não mexe
  nisso, só cuida de fazer a tela inicial carregar offline.

  Sempre que você editar o index.html, aumente o número da versão abaixo
  (v1 -> v2 -> v3...) para forçar os dispositivos a buscarem a versão nova.
*/
const CACHE_VERSION = 'v1';
const CACHE_NAME = `planeta-hq-shell-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700;800&display=swap'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // 'no-cors' é necessário pros recursos de outro domínio (cdnjs, google fonts);
      // a resposta fica "opaca", mas ainda é cacheada e servida normalmente offline.
      return Promise.all(
        APP_SHELL.map((url) =>
          fetch(url, { mode: url.startsWith('http') ? 'no-cors' : 'same-origin' })
            .then((res) => cache.put(url, res))
            .catch(() => {})
        )
      );
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Navegação (abrir/atualizar a tela do app): tenta a rede primeiro
  // (pra sempre pegar a versão mais nova quando tem internet) e, se
  // falhar por falta de conexão, cai pro index.html salvo em cache.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }

  const isAppShellAsset = APP_SHELL.some((u) => req.url === u || req.url.endsWith(u.replace('./', '')));

  if (isAppShellAsset) {
    // Bibliotecas e fontes mudam raramente: cache primeiro, rede como respaldo.
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, clone));
          return res;
        });
      })
    );
    return;
  }

  // Tudo o mais (chamadas à API do Google Drive, capas, etc.) segue direto
  // pra rede sem passar pelo service worker — não queremos servir dados
  // antigos da sua biblioteca a partir de um cache.
});
