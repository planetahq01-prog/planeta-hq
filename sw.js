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

  v5: adicionado o worker do pdf.js (pdf.worker.min.js) à casca — sem ele
  em cache, ler PDF (mesmo um já baixado offline) falhava sem internet.

  Sempre que você editar o index.html, aumente o número da versão abaixo
  (v1 -> v2 -> v3...) para forçar os dispositivos a buscarem a versão nova.

  v10: a navegação (abrir/recarregar a tela do app) usava fetch(req) puro,
  sem 'cache: no-store'. Isso significa que o pedido de rede respeitava o
  cache HTTP nativo do navegador — então, dependendo de como o servidor
  onde o app está hospedado configura os cabeçalhos de cache, o navegador
  podia devolver uma cópia antiga do index.html já guardada em disco SEM
  nem chegar a perguntar pro servidor se havia versão nova, mesmo com
  internet disponível e mesmo depois do arquivo ter sido substituído no
  servidor. Isso explicava a sensação de "troquei o arquivo mas o app
  continua exatamente igual, com as logos antigas e tudo". Agora a
  navegação sempre ignora esse cache nativo e busca o index.html direto
  da rede.
*/
/*
  v12: as logos das seções "Coleção Homem-Aranha" e "Coleção X-Men" (ver
  HOME_LOGOS no index.html) agora entram na casca do app, do mesmo jeito
  que as fontes e as bibliotecas de leitura (cache primeiro, rede como
  respaldo). Antes elas eram baixadas via fetch() de dentro do JavaScript
  do app pra guardar convertidas no IndexedDB — mas vários serviços
  gratuitos de imagem (postimg.cc incluso) bloqueiam esse tipo de
  requisição por proteção contra "hotlinking", mesmo liberando a mesma
  imagem numa <img> comum. Isso fazia a logo nunca aparecer, mesmo depois
  de muito tempo de uso. Uma <img> comum servida por aqui (o service
  worker faz uma requisição de imagem de verdade, não um fetch() de
  JavaScript) não tem esse problema, e de quebra já fica disponível
  offline e instantânea desde a primeira vez que o app é instalado.
  IMPORTANTE: se você adicionar uma logo nova em HOME_LOGOS no
  index.html, adicione a URL dela aqui também (e suba a CACHE_VERSION),
  senão essa logo nova nunca vai ficar instantânea/offline.
*/
/*
  v14: adicionada a logo da seção "Coleção Batman" (ver HOME_LOGOS no
  index.html) à casca do app, do mesmo jeito que Homem-Aranha e X-Men
  acima — mesma lógica, mesmo motivo.
*/
const CACHE_VERSION = 'v14';
const CACHE_NAME = `planeta-hq-shell-${CACHE_VERSION}`;

const APP_SHELL = [
  './index.html',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  // O worker do pdf.js — sem ele em cache, ler qualquer PDF (inclusive um já
  // baixado na aba "Baixados") falha assim que o aparelho está offline, com
  // o erro "Setting up fake worker failed: Cannot load script at: ...".
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700;800&display=swap',
  // Logos das seções da Home — precisam ser EXATAMENTE as mesmas URLs de
  // HOME_LOGOS no index.html.
  'https://i.postimg.cc/x1cRhdkq/XRecorder-17092024-211205-removebg-preview.png',
  'https://i.postimg.cc/cJzP2j41/x-men-seeklogo.png',
  'https://i.postimg.cc/bJBSv7pv/batman-1-logo-png-transparent.png'
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
      // 'cache: no-store' evita que esta busca inicial já traga uma cópia
      // antiga do cache HTTP nativo do navegador.
      return Promise.all(
        APP_SHELL.map((url) =>
          fetch(url, { mode: url.startsWith('http') ? 'no-cors' : 'same-origin', cache: 'no-store' })
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
  // 'cache: no-store' é essencial aqui: sem isso, esse fetch ainda
  // respeitava o cache HTTP nativo do navegador, que podia devolver uma
  // cópia antiga do arquivo sem nem perguntar pro servidor se havia
  // versão nova — fazendo parecer que o app "não atualizou" mesmo com o
  // arquivo já trocado no servidor e internet disponível.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req, { cache: 'no-store' }).catch(() => caches.match('./index.html'))
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
