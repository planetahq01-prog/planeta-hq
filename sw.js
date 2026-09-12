/*
  Service worker do Planeta HQ.
  Objetivo único: garantir que a "casca" do app (HTML/CSS/JS + bibliotecas
  externas) abra mesmo sem internet. A leitura das HQs baixadas continua
  sendo resolvida pelo próprio app via IndexedDB — este arquivo não mexe
  nisso, só cuida de fazer a tela inicial carregar offline.

  IMPORTANTE (v4) — causa raiz real do armazenamento disparado:
  a verificação "isAppShellAsset" comparava `req.url.endsWith(u.replace('./',''))`.
  Para o item './' da lista, isso virava `req.url.endsWith('')` — e QUALQUER
  string termina com uma string vazia. Ou seja, TODA requisição (cada HQ
  aberta, cada capa, cada chamada à API do Drive) era tratada como "parte da
  casca do app" e caía no branch que guarda a resposta pra sempre no Cache
  Storage, sem nenhum limite. Isso explica o crescimento rápido mesmo com a
  aba "Baixados" vazia, e também por que a correção da v2/v3 (usar
  `cache: 'no-store'` pra tudo que não é casca) nunca chegava a rodar de
  verdade — o código dela era inalcançável por causa desse bug.
  Agora a lista de assets da casca é comparada por URL absoluta exata (sem
  heurística de sufixo), então só os poucos arquivos realmente listados
  entram nesse cache — tudo o mais (Drive, HQs, capas) vai com
  `cache: 'no-store'`, sem deixar resíduo em disco.

  Sempre que você editar o index.html, aumente o número da versão abaixo
  (v1 -> v2 -> v3...) para forçar os dispositivos a buscarem a versão nova.
*/
const CACHE_VERSION = 'v4';
const CACHE_NAME = `planeta-hq-shell-${CACHE_VERSION}`;

const APP_SHELL = [
  './index.html',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700;800&display=swap'
];
// URLs absolutas resolvidas uma única vez, pra comparar por igualdade exata
// (nunca mais por sufixo/heurística) na hora de decidir o que é "casca".
const APP_SHELL_URLS = new Set(APP_SHELL.map((u) => new URL(u, self.location.href).href));

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

  // Comparação por URL absoluta EXATA — nunca mais por sufixo/heurística
  // (foi justamente uma heurística de sufixo mal feita que causava o bug
  // de armazenamento descrito no comentário lá em cima).
  if (APP_SHELL_URLS.has(req.url)) {
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

  // Tudo o mais (chamadas à API do Google Drive, conteúdo de HQs, capas,
  // etc.): vai pra rede com `cache: 'no-store'`, garantindo que o navegador
  // nunca grave esses bytes em disco — nem no cache HTTP nativo, nem em
  // Cache Storage. Isso é o que impede HQs abertas (não baixadas) de
  // ficarem ocupando espaço pra sempre.
  event.respondWith(
    fetch(req, { cache: 'no-store' }).catch((err) => {
      throw err;
    })
  );
});
