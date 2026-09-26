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
/*
  v15: index.html mudou (correção do botão "Atualizar" não limpar o cache
  em memória da biblioteca, e novo aviso de erro na Home) — subindo a
  versão pra forçar os aparelhos a buscarem o arquivo novo.
*/
/*
  v16: index.html mudou de novo — "Atualizar" agora só redesenha as
  seções da Home (o que faz as capas recarregarem) quando os dados que
  vieram do Drive são realmente diferentes do que já está na tela. Antes,
  mesmo sem nenhuma mudança real na biblioteca, toda vez que a varredura
  forçada terminava, TODOS os cards eram recriados do zero — fazendo as
  capas já certas piscarem e recarregarem à toa.
*/
/*
  v17: index.html mudou — a chamada que lista pastas/HQs no Google Drive
  (driveFetchJson) agora usa cache:'no-store', igual as outras chamadas de
  rede do app. Sem isso, o navegador podia reaproveitar pra sempre uma
  resposta antiga (até vazia) pra mesma URL de consulta, fazendo a
  biblioteca "sumir" e nem "Atualizar" trazer de volta — só reinstalar o
  app (que limpa esse cache) resolvia.
*/
/*
  v18: index.html mudou — HOME_CACHE_MAX_AGE voltou de 72h pra 6h (valor
  original), a pedido do usuário. O restante da v17 (cache:'no-store' na
  listagem do Drive) continua valendo.
*/
/*
  v19: index.html mudou, duas correções:
  1) Uma varredura da Home cancelada no meio (por outro "Atualizar" ter
     sido clicado antes dela terminar) devolvia listas vazias tratadas
     como resultado válido, e essas listas vazias eram GRAVADAS por cima
     do cache bom que já existia — bastava clicar em "Atualizar" umas duas
     vezes seguidas pra a biblioteca inteira "sumir" até uma varredura
     completa terminar sem ser interrompida. Agora varredura cancelada
     nunca escreve no cache.
  2) "Atualizar" apagava a gaveta 'folderCovers' (qual arquivo é a capa de
     cada pasta) INTEIRA a cada clique, obrigando relistar na rede toda
     pasta visível só pra re-escolher a mesma capa de novo — daí a demora
     enorme das capas depois de atualizar. Agora essa gaveta só perde a
     entrada de uma pasta específica se a capa dela realmente sumiu
     (checagem de graça, sem rede extra, feita ao fim de cada varredura).
*/
/*
  v20: index.html mudou — as páginas de PDF no leitor agora são
  desenhadas na resolução real da tela do aparelho (largura × densidade
  de pixels), em vez de um "scale" fixo de 2 igual pra qualquer celular,
  e a compressão JPEG ficou um pouco mais leve (0.9 → 0.95). Antes disso,
  páginas de PDF apareciam nitidamente mais borradas/granuladas no app do
  que no visualizador do Google Drive, principalmente em telas de alta
  densidade e em gibis antigos com traço fino e trama de pontos.
*/
/*
  v21: index.html mudou — a logo "Coleção Batman" estava com 100px de
  altura (bem acima das outras: Aranha 52px, X-Men 28px), o que deixava a
  barra de título dessa seção bem mais alta e parecia um espaçamento
  grande até as subpastas. Reduzida pra 48px.
*/
/*
  v22: index.html mudou — logo do Homem-Aranha e do Batman trocadas por
  novas imagens (URLs fornecidas pelo usuário), ambas fixadas em 52px de
  altura (revertendo o ajuste pontual de 48px da v21, que não era mais
  necessário).
*/
/*
  v23: index.html mudou — nova seção "Coleção Graphic Novels Marvel
  (Salvat)" na Home, com as subpastas de dentro de "Graphic Novels
  Marvel" (mesma lógica de X-Men/Mangás/Batman). As capas dessas 15
  primeiras subpastas (001 a 015) foram fixadas manualmente por número de
  3 dígitos no início do nome da pasta (novo mapa
  SALVAT_NUMBERED_COVER_OVERRIDES), sem precisar bater o nome inteiro.
*/
/*
  v24: index.html mudou — childrenOfNamedFolder (usada por X-Men, Mangás,
  Batman e Graphic Novels Marvel) agora junta o conteúdo de TODAS as
  pastas que encontrar com aquele nome, em vez de só a primeira. Essa
  biblioteca tem pastas duplicadas confirmadas (ex.: "Aranha-Geddon" já
  tratada à parte) — se a primeira pasta "Graphic Novels Marvel"
  encontrada fosse uma cópia vazia, a seção inteira saía vazia mesmo com
  o nome certo, e foi isso que aconteceu.
*/
/*
  v25: index.html mudou — revertida a mudança da v24 (juntar todas as
  pastas com o mesmo nome). childrenOfNamedFolder voltou a pegar só a
  primeira pasta encontrada com aquele nome, como era antes.
*/
/*
  v26: index.html mudou — "Coleção Homem-Aranha" deixou de juntar toda
  pasta com "aranha"/"spider" no nome (espalhadas pela biblioteca) e
  passou a mostrar só o que está DENTRO da pasta "Coleção Homem-Aranha",
  igual X-Men/Mangás/Batman/Graphic Novels Marvel. Cache dessa seção
  também foi resetado (v2 → v3) pra não reaproveitar a lista antiga.
*/
/*
  v27: index.html mudou — corrigido um vazamento de memória real no
  carregamento preguiçoso das capas: cards de capa que ainda não tinham
  entrado na tela (ex.: mais abaixo numa pasta grande, ou em qualquer
  seção da Home) ficavam presos pra sempre em coverObserver +
  pendingCoverNodes sempre que a pessoa trocava de pasta, buscava algo ou
  clicava em "Atualizar" — o grid antigo era substituído sem ninguém
  liberar essas observações. Isso acumulava a cada navegação (uso normal
  do app) até esgotar a memória e travar/derrubar a aba. Agora todo lugar
  que substitui um grid/seção libera primeiro (releaseCoverObservers) os
  cards ainda pendentes.
*/
/*
  v28: as URLs da logo "Homem-Aranha" e "Batman" na casca do app
  (APP_SHELL, abaixo) estavam desatualizadas — ficaram apontando pras
  imagens antigas de antes de serem trocadas no index.html (ver HOME_LOGOS
  lá). Como a URL nova nunca batia com nada guardado em cache, essas duas
  logos caíam sempre no caminho lento (buscar na rede, do zero, toda vez
  que o app abria) — daí aparecerem em branco por um tempo antes de
  carregar. A logo do X-Men não teve esse problema porque a URL dela nunca
  mudou desde que entrou na casca. Agora as três URLs abaixo batem
  exatamente com o HOME_LOGOS atual do index.html.
*/
/*
  v29: index.html trocou o suporte a CBR de libarchive.js pra node-unrar-js
  — a lib antiga carregava um Worker de um arquivo separado hospedado no
  CDN (worker-bundle.js), e criar um Worker a partir de um script de outra
  origem é bloqueado/instável em vários navegadores por causa de CORS. Era
  por isso que CBR nunca funcionava de verdade (o app chegava a esconder
  esses arquivos da biblioteca inteira por causa disso). A lib nova roda o
  unrar (compilado pra WebAssembly) direto no código principal, sem
  precisar de um Worker de outra origem — só um arquivo .wasm, que entra
  no cache abaixo pra funcionar offline também.
*/
/*
  v30: index.html mudou — corrigida uma recursão infinita real na
  varredura da biblioteca (crawlLibrarySections/walk): uma pasta
  compartilhada em mais de um lugar (formando um ciclo, ex.: A contém B
  que contém A de volta) fazia a varredura nunca terminar, travando a
  barra de carregamento pra sempre e, depois de um tempo, derrubando a
  aba por consumo de memória. Agora cada pasta só é visitada (recursada)
  uma única vez em toda a varredura, não importa quantos "pais"
  diferentes apontem pra ela.
*/
/*
  v31: index.html mudou — adicionado um vigia de travamento na tela de
  carregamento inicial: se ficar 12s+ sem nenhum pedido ao Drive
  terminar, a própria tela passa a mostrar quantas pastas já foram
  visitadas e o NOME da(s) pasta(s) especificamente penduradas (não só
  travar em silêncio). Serve pra identificar com certeza onde um
  travamento acontece, já que o painel de Diagnóstico fica inacessível
  atrás da tela de carregamento enquanto ela trava.
*/
/*
  v32: index.html mudou — corrigido o "Baixando... X%" ficando bugado
  (misturando números) quando a pessoa sai de uma HQ em CBR/CBZ antes do
  download terminar e abre outra logo em seguida. O download antigo
  continuava rodando sozinho em segundo plano e escrevendo por cima da
  porcentagem da HQ nova (mesmo <span> de ID fixo na tela). Agora o
  download antigo é cancelado de verdade assim que uma HQ nova é aberta
  (ou o leitor é fechado), e mesmo que ainda tente atualizar a tela antes
  de perceber o cancelamento, um token de controle impede.
*/
/*
  v34: index.html mudou — o menu do leitor (barra de cima/baixo), que já
  ficava escondido por padrão e voltava com um toque, agora também some
  sozinho depois de alguns segundos parado, sem precisar tocar de novo
  pra escondê-lo. Pausa enquanto o painel de configurações do leitor está
  aberto.
*/
/*
  v39: index.html mudou — nova seção "Clássico [logo Avengers]" na Home, do
  tipo "edições conjuntas" (carrossel de HQs, com o botão de baixar no canto
  da capa, em vez de subpastas). A logo dela vem direto do postimg.cc (não
  passa pelo proxy/R2, que só conhece as logos antigas) e por isso entra na
  casca do app abaixo pela URL original — precisa bater EXATAMENTE com
  HOME_LOGOS.avengers no index.html. O boot também deixou de forçar o
  carregamento das capas dessa seção na tela de carregamento inicial (são
  muitas HQs; elas carregam conforme a pessoa rola o carrossel).
*/
/*
  v40: index.html mudou — correção da lentidão progressiva (HQs abrindo e
  baixando devagar até fechar o app e abrir de novo). A geração de capas
  pesadas em segundo plano (PDF/CBZ sem miniatura) desistia depois de 20s
  mas não cancelava o trabalho: download/pdf.js seguiam rodando escondidos
  (às vezes centenas de MB) e se acumulavam, disputando banda, conexões e
  memória com a HQ que a pessoa abria. Agora essas tarefas são canceladas
  de verdade no timeout, pausam enquanto o leitor está aberto (e ficam
  limitadas a 1 durante um download), não se repetem a cada redesenho da
  pasta, e o leitor libera o PDF/worker de HQs abandonadas no meio do
  carregamento. Este arquivo não mudou de comportamento — só a versão sobe
  pra os aparelhos buscarem o index.html novo.
*/
/*
  v41: index.html mudou — três seções novas na Home: "Coleção Thanos" e
  "Coleção Darkseid" (subpastas das pastas de mesmo nome) e "Clássico
  [logo DC]" (edições conjuntas, HQs da pasta "Liga da Justiça da
  América"), além de uma nova ordem das seções (lista HOME_SECTION_ORDER
  no index.html). A logo nova entra na casca do app abaixo, pela URL
  original, do mesmo jeito da logo do Clássico Avengers.
*/
/*
  v42: index.html mudou — ao entrar numa seção de subpasta (ou em qualquer
  pasta) a partir da Home e voltar, a Home agora volta exatamente para onde
  a pessoa estava: mesma posição vertical (ancorada na seção que estava no
  topo da tela) e mesma posição horizontal de cada carrossel. Antes ela era
  repintada do zero, sempre no topo.
*/
/*
  v44: index.html voltou ao estado anterior às "estantes" (Todas / Marvel /
  DC), que foram removidas por completo: a Home é a de sempre, com todas as
  seções na ordem definida em HOME_SECTION_ORDER e o tema de cores único.
  Mantém a restauração da posição da Home (v42). A versão sobe (em vez de
  voltar para v42) pra todo aparelho que já recebeu a v43 buscar este
  index.html de novo.
*/
/*
  v45: index.html mudou — três seções novas na Home: "Edições especiais
  [Homem-Aranha]" e "A Saga da [Liga da Justiça]" (edição única, HQs das
  pastas de mesmo nome) e "Coleção [Quarteto Fantástico]" (seção mista:
  subpastas + HQs soltas na raiz da pasta), com as três logos novas na
  casca do app.
*/
/*
  v46: index.html mudou — títulos das seções da Home: "Coleção" virou
  "Coleção:" e "Clássico" virou "Clássicos:".
*/
/*
  v48: index.html mudou — (1) a estante Mangás agora tem uma logo de imagem
  (antes era só o nome "Mangás" estilizado em CSS), que entra na casca do
  app abaixo pra abrir instantânea/offline, do mesmo jeito das logos de
  Marvel e DC; (2) 22 seções novas do tipo "edição única" na estante
  Mangás, uma por subpasta de "MANGÁS" (ver MANGA_SECTIONS no index.html),
  e o cache das HQs da Home subiu de v1 pra v2 (cada HQ agora guarda a
  qual mangá pertence), então a primeira abertura depois desta versão faz
  uma varredura completa da biblioteca.
*/
/*
  v49: index.html mudou — removida a seção "🎌 Coleção: Mangás" (carrossel
  de subpastas) da estante Mangás; ficam só as seções "edição única", uma
  por subpasta de "MANGÁS".
*/
/*
  v50: index.html mudou — a seção "Recomendados" agora só recomenda HQs da
  estante atual (Marvel só Marvel, DC só DC; ver comicShelfOf no
  index.html), em vez de misturar a biblioteca inteira.
*/
/*
  v52: index.html mudou — desfeitos os temas visuais por estante da v51
  (fundo, texturas, tipografia, logo "HQ" do topo, molduras, tela de
  transição): a aparência voltou a ser a de antes, só com a cor de destaque
  de cada estante. A versão sobe (em vez de voltar pra v50) pra todo
  aparelho que já recebeu a v51 buscar este index.html de novo.
*/
/*
  v53: index.html mudou — nova estante PADRÃO "Marvel + DC" (todas as seções
  das duas, sem mangás, com as cores originais do app); o app agora sempre
  abre nela (a última estante escolhida deixou de ser lembrada). As logos
  usadas são as mesmas da Marvel e da DC, que já estão na casca abaixo.
*/
/*
  v54: index.html mudou — nova logo da estante Mangás (a URL antiga saiu da
  casca do app acima e a nova entrou no lugar; precisa bater EXATAMENTE com
  SHELVES.manga.logo no index.html) e o tema dessa estante passou de
  vermelho pra laranja.
*/
/*
  v55: index.html mudou — (1) ao trocar de estante, a Home nova abre lá do
  começo (primeira seção da estante), e se a pessoa estava dentro de uma
  pasta, volta pra Home; (2) toda pasta aberta (entrando nela ou voltando
  pra ela) aparece lá do início, nas primeiras HQs/subpastas, em vez de
  herdar a rolagem da tela anterior.
*/
/*
  v56: index.html mudou — a pasta só abre lá do início quando a pessoa ENTRA
  nela; ao VOLTAR pra uma pasta anterior (seta, breadcrumb ou botão de
  voltar) a rolagem não é mais zerada.
*/
/*
  v57: index.html mudou — nova ordem das seções da estante "Marvel + DC"
  (Homem-Aranha, Batman, Homem de Ferro, Superman, Hulk, Doomsday, ...),
  ver SHELVES.todas.sections no index.html.
*/
/*
  v58: index.html mudou — leitor: com a página já ampliada (zoom), arrastar
  com UM dedo passeia pela imagem em qualquer direção, sem precisar da
  pinça de dois dedos de novo (antes só funcionava se um dos dedos da
  pinça continuasse na tela). Ao chegar na borda da imagem ampliada, o
  arrasto deixa a lista rolar pra próxima/anterior página.
*/
/*
  v59: index.html e worker.js mudaram — a chave de API do Google
  (CONFIG.apiKey) parou de ser embutida no código do app e de ser mandada
  pelo navegador em toda chamada ao Drive (listagem de pastas/busca por
  nome, além do que já passava pelo proxy). Ela agora mora só como secret
  do Worker (env.GOOGLE_API_KEY) — o app manda pro Worker só o que
  precisa (pasta/nome pra listar, id do arquivo pra baixar), sem chave
  nenhuma, e é o Worker quem completa a chave antes de falar com o
  Google. O modo "sem proxy" continua existindo como opção avançada
  (exige preencher a chave manualmente na tela de configuração, com o
  mesmo risco de exposição de antes). worker.js também passou a exigir a
  chave real (não mais qualquer texto) nos endpoints administrativos
  (list_cache, purge_logos, forget, warm), que só você aciona manualmente
  — o app nunca chama esses.
*/
/*
  v60: index.html mudou — no boot() (caminho rápido, quando já existe cache
  local), a revalidação da Home em segundo plano passou a rodar com
  forceRefresh=true. Antes ela chamava renderHomeSections() sem esse
  parâmetro: a tela pintava rápido com o cache (isso não mudou), mas a busca
  de verdade no Drive só rodava se o cache de 6h já tivesse vencido — então
  fechar e reabrir o app não trazia HQ nova nenhuma antes das 6h, e só
  limpar os dados do app (ou reinstalar) resolvia. Subindo a versão pra
  forçar os aparelhos a buscarem o index.html novo.
*/
/*
  v61: index.html mudou — novo pop-up "Conteúdo novo adicionado ⭐" (ver
  detectAndQueueNewFolders/showNextNewFolderPopup): toda vez que uma
  varredura da biblioteca termina limpa (ao abrir o app ou clicar em
  "Atualizar"), compara as pastas encontradas com as da varredura anterior;
  quem for pasta/subpasta nova aparece num cartão central com capa, nome e
  botão "Ler agora" que leva direto pra dentro dela. Subindo a versão pra
  forçar os aparelhos a buscarem o index.html novo.
*/
/*
  v62: index.html mudou — o pop-up "Conteúdo novo adicionado" ficou bem
  mais estiloso: aura brilhante pulsante ao redor do card, faixa "Novo" na
  capa, brilho passando pela capa e pelo botão, confete colorido ao
  aparecer e estrelinhas piscando no textinho de cima. Subindo a versão pra
  forçar os aparelhos a buscarem o index.html novo.
  v64: ícone do app trocado pelo logo de verdade do Planeta HQ (arquivos
  achatados na raiz — icon-192.png/icon-512.png/icon-512-maskable.png/
  favicon-32.png — pra bater exatamente com os nomes que o manifest.json
  original já usava, sem pasta icons/ nova).
*/
const CACHE_VERSION = 'v64';
const CACHE_NAME = `planeta-hq-shell-${CACHE_VERSION}`;

const APP_SHELL = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './favicon-32.png',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  // O worker do pdf.js — sem ele em cache, ler qualquer PDF (inclusive um já
  // baixado na aba "Baixados") falha assim que o aparelho está offline, com
  // o erro "Setting up fake worker failed: Cannot load script at: ...".
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  // Suporte a CBR (ver ensureRarLib no index.html) — precisam ser
  // EXATAMENTE as mesmas URLs da primeira fonte ali.
  'https://cdn.jsdelivr.net/npm/node-unrar-js@2.0.2/esm/index.esm.js',
  'https://cdn.jsdelivr.net/npm/node-unrar-js@2.0.2/esm/js/unrar.wasm',
  'https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700;800&display=swap',
  // Logos das seções da Home — desde a v37, vêm do proxy/R2 (mesmo cache
  // compartilhado das capas), não mais direto do postimg.cc: precisam ser
  // EXATAMENTE as mesmas URLs que logoSrc() monta no index.html (uma por
  // id de HOME_LOGOS — se adicionar uma logo lá, adicione a URL
  // equivalente aqui também, e suba a CACHE_VERSION).
  'https://proxy1.planetahq01.workers.dev/?logo=aranha',
  'https://proxy1.planetahq01.workers.dev/?logo=xmen',
  'https://proxy1.planetahq01.workers.dev/?logo=batman',
  'https://proxy1.planetahq01.workers.dev/?logo=hulk',
  'https://proxy1.planetahq01.workers.dev/?logo=lanterna',
  'https://proxy1.planetahq01.workers.dev/?logo=ironman',
  'https://proxy1.planetahq01.workers.dev/?logo=superman',
  'https://proxy1.planetahq01.workers.dev/?logo=dc',
  'https://proxy1.planetahq01.workers.dev/?logo=mulhermaravilha',
  'https://proxy1.planetahq01.workers.dev/?logo=doomsday',
  // Logo "Clássico Avengers" (v39) — direto do postimg.cc, ver HOME_LOGOS
  // e LOGO_IDS_DIRECT no index.html.
  'https://i.postimg.cc/4dMsT0k3/Avengers(1963-1996)-1-png.webp',
  // Logo "Clássico Liga da Justiça" (v41) — também direto do postimg.cc,
  // precisa bater EXATAMENTE com HOME_LOGOS.liga no index.html.
  'https://i.postimg.cc/50M063xv/Nice-Png-dc-comics-logo-png-832571-(1).png',
  // Logos das seções novas (v45) — precisam bater EXATAMENTE com HOME_LOGOS
  // no index.html (aranhaespecial, ligasaga, quarteto).
  'https://i.postimg.cc/G2MpJDRx/who-was-the-most-nostalgic-spiderman-artwork-used-for-v0-vse6zzup5ih91.png',
  'https://i.postimg.cc/pL2X7kdz/logo-liga-da-justica-novo.png',
  'https://i.postimg.cc/cLHGwzCJ/fantastic-four-1985-1992-seeklogo.png',
  // Logos das ESTANTES (v47/v48) — botão/painel/tela de transição do
  // seletor Marvel/DC/Mangás (ver SHELVES no index.html). Precisam bater
  // EXATAMENTE com o `logo` de cada estante lá.
  'https://i.postimg.cc/vBNJsJVq/Marvel-Logo.jpg',
  'https://i.postimg.cc/P550CfQJ/DC-Comics-logo.png',
  'https://i.postimg.cc/SRVMTbts/Manga-21-09-2026-(1).png'
];
// URLs absolutas resolvidas uma única vez, pra comparar por igualdade exata
// (nunca mais por sufixo/heurística) na hora de decidir o que é "casca".
const APP_SHELL_URLS = new Set(APP_SHELL.map((u) => new URL(u, self.location.href).href));

// Buscados com CORS de verdade (não 'no-cors') porque um import() de
// módulo JS rejeita resposta "opaca" mesmo vinda do cache, e o .wasm
// ficaria com 0 bytes do mesmo jeito se servido opaco — o jsDelivr manda
// os cabeçalhos CORS certos pra isso funcionar.
const CORS_URLS = new Set([
  'https://cdn.jsdelivr.net/npm/node-unrar-js@2.0.2/esm/index.esm.js',
  'https://cdn.jsdelivr.net/npm/node-unrar-js@2.0.2/esm/js/unrar.wasm'
]);

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
          fetch(url, { mode: CORS_URLS.has(url) ? 'cors' : (url.startsWith('http') ? 'no-cors' : 'same-origin'), cache: 'no-store' })
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
