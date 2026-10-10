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
  v59: index.html mudou — a chave de API do Google Drive saiu do app. Toda
  listagem/busca/download no Drive agora passa pelo Worker proxy, que guarda
  a chave como segredo (DRIVE_API_KEY). O app também apaga a chave antiga que
  estava salva no aparelho (localStorage). Este arquivo não mudou de
  comportamento — só a versão sobe pra os aparelhos buscarem o index.html novo.
*/
/*
  v60: index.html mudou de novo — agora existe uma tela de bloqueio pedindo
  um código de acesso (enviado por e-mail após a compra no ggcheckout).
  Sem código válido, o Worker recusa listagem/download. Este arquivo em si
  não mudou de comportamento — só a versão sobe pra os aparelhos buscarem
  o index.html novo.
*/
/*
  v61: index.html mudou de novo — cada aparelho agora manda um ID próprio
  junto com o código de acesso, e o Worker limita quantos aparelhos
  diferentes um mesmo código pode ativar (evita que um código comprado seja
  divulgado e usado por qualquer quantidade de gente). Este arquivo em si
  não mudou de comportamento — só a versão sobe pra os aparelhos buscarem
  o index.html novo.
*/
/*
  v62: index.html mudou de novo — limite de aparelhos por código subiu pra
  4, a evicção do aparelho mais antigo virou automática (LRU), e tem uma
  tela nova em Configurações → "Seus aparelhos conectados", onde dá pra ver
  e remover aparelhos manualmente. Este arquivo em si não mudou de
  comportamento — só a versão sobe pra os aparelhos buscarem o index.html
  novo.
*/
/*
  v63: index.html mudou de novo — removido o botão/painel de diagnóstico
  (o inseto), o link "Abrir aquecedor de capas" mudou de lugar (agora fica
  dentro de Configurações), e a tela "Seus aparelhos conectados" passou a
  mostrar 💻 pra computador e 📱 pra celular/tablet. Este arquivo em si não
  mudou de comportamento — só a versão sobe pra os aparelhos buscarem o
  index.html novo.
*/
/*
  v64: index.html mudou de novo — o link "Abrir aquecedor de capas" saiu
  totalmente do app (a ferramenta continua existindo à parte, só não fica
  mais acessível daqui de dentro). O botão de Configurações agora abre
  direto a tela "Seus aparelhos conectados", sem menu intermediário. Este
  arquivo em si não mudou de comportamento — só a versão sobe pra os
  aparelhos buscarem o index.html novo.
*/
/*
  v65: index.html mudou de novo — corrigido o bug das capinhas ficando em
  branco pra sempre (a geração de capa podia usar um código de acesso já
  vencido, sem tentar de novo). Também corrigido: a listagem de pastas
  reutilizava a URL antiga ao renovar o código, fazendo pedir o código de
  novo à toa. Este arquivo em si não mudou de comportamento — só a versão
  sobe pra os aparelhos buscarem o index.html novo.
*/
/*
  v66: index.html mudou de novo — corrigido outro motivo das capinhas
  ficando em branco: quando várias capas descobriam ao mesmo tempo que o
  código de acesso precisava ser renovado, cada uma abria "sua própria"
  tela de código por cima da mesma, e todas menos a última ficavam
  esperando pra sempre (mesmo depois de digitar o código certo). Agora
  chamadas concorrentes compartilham a mesma tela/verificação. Este
  arquivo em si não mudou de comportamento — só a versão sobe pra os
  aparelhos buscarem o index.html novo.
*/
/*
  v67: index.html mudou — corrigida a causa mais provável das capas
  ficando em branco pra sempre, principalmente da segunda vez que o app é
  aberto em diante: as chamadas de rede do código de acesso e da checagem
  de capa em cache (auth_check, cover_check, cover_put) não tinham NENHUM
  tempo-limite, diferente da listagem de pastas (que já tinha 15s com
  repetição automática). Se uma dessas travava — comum ao reabrir o app
  com a internet ainda se restabelecendo, ou a conexão ainda "acordando"
  depois de um tempo em segundo plano — ela ficava pendurada pra sempre, e
  como a verificação do código é COMPARTILHADA por todas as capas da tela
  ao mesmo tempo, essa única trava travava a biblioteca inteira de capas
  junto. Agora todas essas chamadas têm 15-20s de tempo-limite (e a
  própria <img> da capa também, como rede de segurança extra) — se
  travarem, o app desiste de esperar e segue tentando gerar/carregar a
  capa normalmente, em vez de ficar parado pra sempre. Este arquivo em si
  não mudou de comportamento — só a versão sobe pra os aparelhos buscarem
  o index.html novo.
*/
/*
  v68: index.html mudou — segunda correção pras capas em branco (a v67
  cobriu conexões travadas; esta cobre falhas passageiras de verdade). O
  card só pedia a capa UMA vez (o IntersectionObserver para de observar o
  card assim que ele chega perto da tela, com sucesso ou não) — e, se essa
  tentativa única esbarrasse em qualquer soluço de rede, o arquivo ainda
  entrava numa "quarentena" de 10 minutos antes de poder tentar de novo.
  Isso combinado explicava capas específicas ficando em branco enquanto
  as vizinhas carregavam normalmente, sem jeito de se recuperar sozinhas
  a não ser apertando "Atualizar" ou saindo/voltando da tela bem depois.
  Agora: 1) cada capa ganha uma segunda tentativa automática, poucos
  segundos depois da primeira falhar, furando a quarentena só pra ela
  mesma; 2) a quarentena em si caiu de 10 minutos pra 90 segundos. Este
  arquivo em si não mudou de comportamento — só a versão sobe pra os
  aparelhos buscarem o index.html novo.
*/
/*
  v69: index.html mudou — corrigidos os cliques com mouse não abrindo HQs/
  pastas nos carrosséis da Home e o arrasto do carrossel não funcionando no
  navegador do computador. Subindo a versão pra os aparelhos buscarem o
  index.html novo.
*/
/*
  v70: index.html mudou — novo modo de leitura "Página Dupla" (pensado pra
  tela de computador): mostra duas páginas coladas, cada uma 100% visível
  (nunca cortada), mesmo que sobre espaço vazio na tela.
*/
/*
  v71: index.html mudou — novo modo de leitura "Rolagem (Computador)":
  igual à Rolagem normal, mas a HQ fica numa faixa central de ~4:3 em vez
  de esticar pela largura toda da janela, e as setas de cima/baixo do
  teclado rolam a página.
*/
/*
  v72: index.html mudou — a Página Dupla agora tem uma transição de
  "página virando" (leve giro 3D) ao avançar/voltar, pra ficar mais
  imersivo.
*/
/*
  v73: index.html mudou — corrigido erro "NotReadableError" ao abrir PDFs
  grandes (baixados ou já em memória como Blob): antes o app lia o arquivo
  inteiro de uma vez (source.arrayBuffer()), o que falha em PDFs grandes
  em alguns aparelhos com menos RAM. Agora usa uma URL de objeto e deixa o
  pdf.js ler por pedacinhos, igual já fazia com PDF vindo direto da rede.
*/
/*
  v74: index.html mudou — terceira rodada na saga das capas em branco.
  A correção da v68 dava só UMA retentativa, 2s depois da primeira falha —
  mas em wi-fi fraco ou dado móvel instável (o cenário mais comum de quem
  relata isso), a instabilidade às vezes dura mais que isso, e a capa
  desistia de vez até a pessoa apertar "Atualizar" ou reabrir o app. Agora
  são até 3 retentativas, com espaço crescente entre elas (1.5s, 4s, 9s) —
  quase 15s de janela total antes de desistir de verdade, o que cobre a
  grande maioria das instabilidades passageiras sem precisar de nenhuma
  ação manual. Este arquivo em si não mudou de comportamento — só a
  versão sobe pra os aparelhos buscarem o index.html novo.
*/
/*
  v75: index.html mudou — a causa mais provável de as capas terem ficado
  mais frágeis DEPOIS do código de acesso entrar no app: toda capa que
  precisava ser gerada do zero fazia sua PRÓPRIA chamada de rede extra só
  pra confirmar que o código ainda era válido (ensureFreshAccessCode),
  antes mesmo de chegar perto de checar/gerar a capa em si — uma viagem de
  ida-e-volta a mais, por capa, que o app nunca precisou fazer antes desse
  recurso existir. Numa tela com várias capas chegando em momentos
  diferentes (rolando a biblioteca, por exemplo), isso virava várias
  chamadas de rede extras seguidas, cada uma um novo jeito de falhar numa
  conexão ruim. Agora essa checagem só roda de verdade no máximo 1 vez a
  cada 5 minutos — o resto do tempo, a capa pula direto pra checar/gerar
  normalmente, sem esse passo a mais. Este arquivo em si não mudou de
  comportamento — só a versão sobe pra os aparelhos buscarem o index.html
  novo.
*/
/*
  v76: index.html mudou — removida de vez a checagem extra de código de
  acesso que rodava a cada capa gerada do zero (ensureFreshAccessCode, que
  a v75 já tinha limitado a 1x/5min). Ela era redundante: o código já é
  confirmado uma vez no boot do app (ensureAccessCode), e o Worker valida
  de novo em toda chamada real de qualquer jeito — então essa reconferência
  por capa só custava uma ida-e-volta extra sem proteger contra nada de
  novo. Agora a geração de capa vai direto pra cover_check/cover, do
  jeito que era antes do código de acesso existir. Este arquivo em si não
  mudou de comportamento — só a versão sobe pra os aparelhos buscarem o
  index.html novo.
*/
/*
  v77: index.html mudou — quarta rodada nas capas em branco, e desta vez
  mirando especificamente nos cards de PASTA (coleções), que é o que
  aparecia em branco nos últimos prints: attachFolderCoverAsync precisa de
  uma etapa A MAIS antes mesmo de chegar na capa em si (resolveFolderCoverFile,
  que lista a pasta pra descobrir qual arquivo usar como capa) — e essa
  etapa não tinha NENHUMA retentativa, então as retentativas já existentes
  (desde a v74) na capa em si não ajudavam em nada se fosse essa listagem
  que falhasse. Agora essa etapa também tenta de novo, com o mesmo
  espaçamento crescente. Além disso, a fila geral de capas (que cobre toda
  capa visível na tela, pasta ou HQ) tinha um teto de 20s por tarefa que
  não cancelava o trabalho de verdade — só "desistia" da vaga e deixava
  a tarefa seguir rodando escondida, competindo por rede com as novas
  tarefas que entravam no lugar dela. Com as retentativas novas, uma
  tarefa legítima passou a poder levar bem mais que 20s, então esse teto
  virou uma armadilha (soltava a vaga cedo demais, piorando a mesma
  instabilidade que as retentativas tentam curar) — agora essa fila tem
  seu próprio teto, bem mais folgado (45s), só como rede de segurança
  pra tarefa travada de verdade. Este arquivo em si não mudou de
  comportamento — só a versão sobe pra os aparelhos buscarem o index.html
  novo.
*/
/*
  v78: index.html mudou — a causa raiz (não só mais uma rodada de
  retentativa) da demora/travamento em capas que JÁ estavam prontas no R2,
  principalmente na Home. resolveCoverSrc, quando o Drive devolvia um
  thumbnailLink na listagem (o caso comum), usava ele DIRETO — sem checar
  se já existia uma capa pronta e rápida no R2. Só depois desse
  thumbnailLink falhar OU travar por 15s (timeout de segurança do
  buildCoverNode) é que o fallback finalmente consultava o R2. Só que o
  thumbnailLink do Drive é conhecido por ser lento ou travar sem soltar
  erro nenhum nesse tipo de acesso (API key, sem OAuth/sessão logada — ver
  issuetracker.google.com/issues/229184403 e /issues/188567656) — daí a
  demora em capas que já estavam 100% prontas no R2 o tempo todo. Isso
  também explicava por que "Atualizar" ou fechar/reabrir o app resolvia na
  hora: a primeira resolução (lenta) já tinha salvo o valor do R2 em
  memória/IndexedDB, então a segunda vez nem chegava a tentar o
  thumbnailLink de novo. Agora o R2 é consultado ANTES do thumbnailLink
  (nova função checkCoverInR2, com timeout próprio de 4s — bem mais curto,
  já que isso roda antes de mostrar qualquer coisa, então precisa ser
  rápido ou desistir logo). Este arquivo em si não mudou de comportamento
  — só a versão sobe pra os aparelhos buscarem o index.html novo.
*/
/*
  v79: index.html mudou — correção em cima da própria correção da v78.
  checkCoverInR2 (nova na v78, roda pra CADA capa) chamava
  ensureFreshAccessCode() antes de perguntar pro R2, e essa função não
  tinha nenhuma memória de "já confirmei isso há pouco" — cada chamada
  disparava uma ida-e-volta de rede de verdade (auth_check). Com dezenas
  de capas na Home, isso empilhava uma rodada de rede extra ANTES de cada
  cover_check, deixando tudo mais lento que a versão anterior à v78, não
  mais rápido. Agora ensureFreshAccessCode só toca a rede se a última
  confirmação bem-sucedida foi há mais de 5 minutos (accessCodeVerifiedAt)
  — dentro desse prazo, devolve na hora sem nenhuma chamada de rede. Este
  arquivo em si não mudou de comportamento — só a versão sobe pra os
  aparelhos buscarem o index.html novo.
*/
/*
  v80: index.html mudou — removida a transição em 3D (o giro rotateY) do
  modo de leitura "Página Dupla": trocar de par de páginas agora é
  direto, sem o efeito de página virando.
*/
/*
  v81: index.html mudou — três seções novas na Home (todas MISTAS, no mesmo
  molde de "Coleção: Quarteto Fantástico": subpastas + HQs soltas na raiz
  da pasta): "Coleção: Deadpool", "Coleção: Wolverine" e "Coleção:
  Motoqueiro Fantasma", cada uma com a logo no lugar do nome. As três
  logos (HOME_LOGOS/LOGO_IDS_DIRECT no index.html) entraram na casca do
  app aqui embaixo, pra ficarem instantâneas e disponíveis offline.
*/
/*
  v82: index.html e sw.js mudaram — a causa raiz da lentidão das capas. O
  "resto" das requisições (inclusive as capas do Worker/R2) ia pra rede com
  `cache: 'no-store'`, então NENHUMA capa ficava guardada no aparelho: toda
  vez que o app abria, todas eram baixadas de novo, cada uma passando pela
  checagem de código do Worker. Agora as capas (?cover=1&id=...) têm cache
  próprio (COVERS_CACHE), servidas na hora quando já vistas, com chave só
  pelo id da HQ (ignora code/device/type, que mudam). Esse cache NÃO é
  apagado quando a versão sobe; pra forçar refazer todas as capas, troque
  COVERS_CACHE por -v2. No index.html, também saiu a consulta cover_check
  que rodava antes de CADA capa (1 ida-e-volta a menos por capa).
*/
/*
  v83: index.html mudou — dois botões novos na topbar, ao lado de
  Configurações: Instagram (@planeta_hq33) e WhatsApp (55 88 99731-4614),
  cada um abrindo o link correspondente numa aba nova. Este arquivo em si
  não mudou de comportamento — só a versão sobe pra os aparelhos buscarem
  o index.html novo.
*/
/*
  v84: index.html mudou — voltou o aviso visível (toast) em erros não
  tratados, que tinha se perdido numa atualização anterior. Sem isso, uma
  falha silenciosa (como a biblioteca não carregando no app instalado) não
  dava nenhum sinal na tela, e no APK não tem como abrir o console pra ver
  o erro real. Este arquivo em si não mudou de comportamento — só a versão
  sobe pra os aparelhos buscarem o index.html novo.
*/
/* v85: index.html agora monta as seções como mistas e inclui a logo Flash; o cache da Home também reconstrói o índice pai/filho. */
const CACHE_VERSION = 'v102';
// Cache das capas: separado do da casca do app e mantido entre versões.
const COVERS_CACHE = 'planeta-hq-covers-v1';
const CACHE_NAME = `planeta-hq-shell-${CACHE_VERSION}`;

const PDF_CMAP_FILES = [
  '78-EUC-H.bcmap',
  '78-EUC-V.bcmap',
  '78-H.bcmap',
  '78-RKSJ-H.bcmap',
  '78-RKSJ-V.bcmap',
  '78-V.bcmap',
  '78ms-RKSJ-H.bcmap',
  '78ms-RKSJ-V.bcmap',
  '83pv-RKSJ-H.bcmap',
  '90ms-RKSJ-H.bcmap',
  '90ms-RKSJ-V.bcmap',
  '90msp-RKSJ-H.bcmap',
  '90msp-RKSJ-V.bcmap',
  '90pv-RKSJ-H.bcmap',
  '90pv-RKSJ-V.bcmap',
  'Add-H.bcmap',
  'Add-RKSJ-H.bcmap',
  'Add-RKSJ-V.bcmap',
  'Add-V.bcmap',
  'Adobe-CNS1-0.bcmap',
  'Adobe-CNS1-1.bcmap',
  'Adobe-CNS1-2.bcmap',
  'Adobe-CNS1-3.bcmap',
  'Adobe-CNS1-4.bcmap',
  'Adobe-CNS1-5.bcmap',
  'Adobe-CNS1-6.bcmap',
  'Adobe-CNS1-UCS2.bcmap',
  'Adobe-GB1-0.bcmap',
  'Adobe-GB1-1.bcmap',
  'Adobe-GB1-2.bcmap',
  'Adobe-GB1-3.bcmap',
  'Adobe-GB1-4.bcmap',
  'Adobe-GB1-5.bcmap',
  'Adobe-GB1-UCS2.bcmap',
  'Adobe-Japan1-0.bcmap',
  'Adobe-Japan1-1.bcmap',
  'Adobe-Japan1-2.bcmap',
  'Adobe-Japan1-3.bcmap',
  'Adobe-Japan1-4.bcmap',
  'Adobe-Japan1-5.bcmap',
  'Adobe-Japan1-6.bcmap',
  'Adobe-Japan1-UCS2.bcmap',
  'Adobe-Korea1-0.bcmap',
  'Adobe-Korea1-1.bcmap',
  'Adobe-Korea1-2.bcmap',
  'Adobe-Korea1-UCS2.bcmap',
  'B5-H.bcmap',
  'B5-V.bcmap',
  'B5pc-H.bcmap',
  'B5pc-V.bcmap',
  'CNS-EUC-H.bcmap',
  'CNS-EUC-V.bcmap',
  'CNS1-H.bcmap',
  'CNS1-V.bcmap',
  'CNS2-H.bcmap',
  'CNS2-V.bcmap',
  'ETHK-B5-H.bcmap',
  'ETHK-B5-V.bcmap',
  'ETen-B5-H.bcmap',
  'ETen-B5-V.bcmap',
  'ETenms-B5-H.bcmap',
  'ETenms-B5-V.bcmap',
  'EUC-H.bcmap',
  'EUC-V.bcmap',
  'Ext-H.bcmap',
  'Ext-RKSJ-H.bcmap',
  'Ext-RKSJ-V.bcmap',
  'Ext-V.bcmap',
  'GB-EUC-H.bcmap',
  'GB-EUC-V.bcmap',
  'GB-H.bcmap',
  'GB-V.bcmap',
  'GBK-EUC-H.bcmap',
  'GBK-EUC-V.bcmap',
  'GBK2K-H.bcmap',
  'GBK2K-V.bcmap',
  'GBKp-EUC-H.bcmap',
  'GBKp-EUC-V.bcmap',
  'GBT-EUC-H.bcmap',
  'GBT-EUC-V.bcmap',
  'GBT-H.bcmap',
  'GBT-V.bcmap',
  'GBTpc-EUC-H.bcmap',
  'GBTpc-EUC-V.bcmap',
  'GBpc-EUC-H.bcmap',
  'GBpc-EUC-V.bcmap',
  'H.bcmap',
  'HKdla-B5-H.bcmap',
  'HKdla-B5-V.bcmap',
  'HKdlb-B5-H.bcmap',
  'HKdlb-B5-V.bcmap',
  'HKgccs-B5-H.bcmap',
  'HKgccs-B5-V.bcmap',
  'HKm314-B5-H.bcmap',
  'HKm314-B5-V.bcmap',
  'HKm471-B5-H.bcmap',
  'HKm471-B5-V.bcmap',
  'HKscs-B5-H.bcmap',
  'HKscs-B5-V.bcmap',
  'Hankaku.bcmap',
  'Hiragana.bcmap',
  'KSC-EUC-H.bcmap',
  'KSC-EUC-V.bcmap',
  'KSC-H.bcmap',
  'KSC-Johab-H.bcmap',
  'KSC-Johab-V.bcmap',
  'KSC-V.bcmap',
  'KSCms-UHC-H.bcmap',
  'KSCms-UHC-HW-H.bcmap',
  'KSCms-UHC-HW-V.bcmap',
  'KSCms-UHC-V.bcmap',
  'KSCpc-EUC-H.bcmap',
  'KSCpc-EUC-V.bcmap',
  'Katakana.bcmap',
  'NWP-H.bcmap',
  'NWP-V.bcmap',
  'RKSJ-H.bcmap',
  'RKSJ-V.bcmap',
  'Roman.bcmap',
  'UniCNS-UCS2-H.bcmap',
  'UniCNS-UCS2-V.bcmap',
  'UniCNS-UTF16-H.bcmap',
  'UniCNS-UTF16-V.bcmap',
  'UniCNS-UTF32-H.bcmap',
  'UniCNS-UTF32-V.bcmap',
  'UniCNS-UTF8-H.bcmap',
  'UniCNS-UTF8-V.bcmap',
  'UniGB-UCS2-H.bcmap',
  'UniGB-UCS2-V.bcmap',
  'UniGB-UTF16-H.bcmap',
  'UniGB-UTF16-V.bcmap',
  'UniGB-UTF32-H.bcmap',
  'UniGB-UTF32-V.bcmap',
  'UniGB-UTF8-H.bcmap',
  'UniGB-UTF8-V.bcmap',
  'UniJIS-UCS2-H.bcmap',
  'UniJIS-UCS2-HW-H.bcmap',
  'UniJIS-UCS2-HW-V.bcmap',
  'UniJIS-UCS2-V.bcmap',
  'UniJIS-UTF16-H.bcmap',
  'UniJIS-UTF16-V.bcmap',
  'UniJIS-UTF32-H.bcmap',
  'UniJIS-UTF32-V.bcmap',
  'UniJIS-UTF8-H.bcmap',
  'UniJIS-UTF8-V.bcmap',
  'UniJIS2004-UTF16-H.bcmap',
  'UniJIS2004-UTF16-V.bcmap',
  'UniJIS2004-UTF32-H.bcmap',
  'UniJIS2004-UTF32-V.bcmap',
  'UniJIS2004-UTF8-H.bcmap',
  'UniJIS2004-UTF8-V.bcmap',
  'UniJISPro-UCS2-HW-V.bcmap',
  'UniJISPro-UCS2-V.bcmap',
  'UniJISPro-UTF8-V.bcmap',
  'UniJISX0213-UTF32-H.bcmap',
  'UniJISX0213-UTF32-V.bcmap',
  'UniJISX02132004-UTF32-H.bcmap',
  'UniJISX02132004-UTF32-V.bcmap',
  'UniKS-UCS2-H.bcmap',
  'UniKS-UCS2-V.bcmap',
  'UniKS-UTF16-H.bcmap',
  'UniKS-UTF16-V.bcmap',
  'UniKS-UTF32-H.bcmap',
  'UniKS-UTF32-V.bcmap',
  'UniKS-UTF8-H.bcmap',
  'UniKS-UTF8-V.bcmap',
  'V.bcmap',
  'WP-Symbol.bcmap'
];

const APP_SHELL = [
  './index.html',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  // O worker do pdf.js — sem ele em cache, ler qualquer PDF (inclusive um já
  // baixado na aba "Baixados") falha assim que o aparelho está offline, com
  // o erro "Setting up fake worker failed: Cannot load script at: ...".
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  // Suporte a CBR local (bundle ESM + WASM): indispensáveis para abrir
  // HQs .cbr totalmente offline, sem buscar código em CDN.
  './vendor/node-unrar-js.bundle.js',
  './vendor/unrar.wasm',
  ...PDF_CMAP_FILES.map((name) => `./vendor/pdfjs/cmaps/${name}`),
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
  // Logos das seções "Coleção: Deadpool / Wolverine / Motoqueiro Fantasma"
  // (v81) — precisam bater EXATAMENTE com HOME_LOGOS no index.html.
  'https://i.postimg.cc/j59jC0D5/pngaaa-com-153784.png',
  'https://i.postimg.cc/rpwx7r3J/pngaaa-com-979580.png',
  'https://i.postimg.cc/gkKwd0vg/175900-ghost-rider-download-hd.png',
  // Logo da nova seção Coleção: Flash.
  'https://i.postimg.cc/HsXMK065/the-flash-seeklogo.png',
  // Logo da nova seção Coleção: Demolidor.
  'https://i.postimg.cc/zv1NH4Nf/daredevil-seeklogo.png',
  // Logo da nova seção Coleção: Capitão América — direta do postimg.cc.
  'https://i.postimg.cc/Y9zqd0Ph/captain-america-seeklogo.png',
  // Logos das estantes atuais Marvel/DC (ver SHELVES no index.html).
  'https://i.postimg.cc/vBNJsJVq/Marvel-Logo.jpg',
  'https://i.postimg.cc/P550CfQJ/DC-Comics-logo.png'
];
// URLs absolutas resolvidas uma única vez, pra comparar por igualdade exata
// (nunca mais por sufixo/heurística) na hora de decidir o que é "casca".
const APP_SHELL_URLS = new Set(APP_SHELL.map((u) => new URL(u, self.location.href).href));
const REQUIRED_LOCAL_ASSETS = new Set(
  APP_SHELL.filter((u) => u.startsWith('./vendor/')).map((u) => new URL(u, self.location.href).href)
);

// Os assets do CBR agora são locais/same-origin: não precisam de fetch
// CORS nem de CDN e são armazenados como respostas normais do app.
const CORS_URLS = new Set();

async function precacheAppShell(cache){
  // Limita as conexões paralelas: o shell inclui 168 mapas PDF e não deve
  // abrir centenas de downloads simultâneos no celular.
  const batchSize=8;
  for(let i=0;i<APP_SHELL.length;i+=batchSize){
    const batch=APP_SHELL.slice(i,i+batchSize);
    await Promise.all(batch.map(async(url)=>{
      const absolute=new URL(url,self.location.href).href;
      try{
        const res=await fetch(url,{mode:CORS_URLS.has(url)?'cors':(url.startsWith('http')?'no-cors':'same-origin'),cache:'no-store'});
        if(REQUIRED_LOCAL_ASSETS.has(absolute)&&!res.ok)throw new Error('Asset offline obrigatório indisponível: '+url+' ('+res.status+')');
        await cache.put(url,res);
      }catch(err){
        // A nova versão só assume quando todos os assets locais obrigatórios
        // de CBR/PDF foram armazenados. Recursos externos opcionais podem falhar.
        if(REQUIRED_LOCAL_ASSETS.has(absolute))throw err;
      }
    }));
  }
}
self.addEventListener('install',(event)=>{
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache)=>precacheAppShell(cache)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME && k !== COVERS_CACHE).map((k) => caches.delete(k))
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

  // Capas do Worker (?cover=1&id=...): cache primeiro, chave só pelo id.
  // Só guarda resposta ok e do tipo imagem (um 404 nunca fica gravado). Se o
  // fetch com CORS falhar (Worker sem cabeçalho CORS na imagem), repassa a
  // requisição original sem cachear — o app segue funcionando, só sem o cache.
  if (req.method === 'GET') {
    const u = new URL(req.url);
    if (u.origin === 'https://proxy1.planetahq01.workers.dev' && u.searchParams.get('cover') === '1' && u.searchParams.get('id')) {
      const key = new Request(`${u.origin}/?cover=1&id=${encodeURIComponent(u.searchParams.get('id'))}`);
      event.respondWith((async () => {
        const cache = await caches.open(COVERS_CACHE);
        const hit = await cache.match(key);
        if (hit) return hit;
        try {
          const res = await fetch(u.href, { mode: 'cors', cache: 'no-store' });
          if (res.ok && (res.headers.get('content-type') || '').startsWith('image/')) {
            cache.put(key, res.clone()).catch(() => {});
          }
          return res;
        } catch (e) {
          return fetch(req, { cache: 'no-store' });
        }
      })());
      return;
    }
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
