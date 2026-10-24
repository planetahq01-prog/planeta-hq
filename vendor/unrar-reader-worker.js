importScripts('./node-unrar-js.worker.js?v=115');
const createBlobExtractor = self.PlanetaHQUnrar.createExtractorFromBlob;
let extractor = null;
let pageNames = [];
let sequentialOpen = false;
let sequentialFinished = false;
let sequentialSeen = new Set();

function resetSequentialArchive() {
  try { if (sequentialOpen && extractor && extractor._archive) extractor.closeArc(); } catch (error) {}
  sequentialOpen = false;
  sequentialFinished = false;
  sequentialSeen = new Set();
}

function naturalSort(a, b) {
  return a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' });
}

function sendError(id, error) {
  self.postMessage({
    id,
    ok: false,
    error: {
      name: error && error.name || 'Error',
      message: error && error.message || String(error),
      reason: error && error.reason || null,
      file: error && error.file || null
    }
  });
}

function mimeForName(name) {
  if (/\.png$/i.test(name)) return 'image/png';
  if (/\.webp$/i.test(name)) return 'image/webp';
  if (/\.gif$/i.test(name)) return 'image/gif';
  return 'image/jpeg';
}

self.addEventListener('message', async event => {
  const message = event.data || {};
  const { id, command } = message;
  try {
    if (command === 'init') {
      const sourceSize = Number(message.size);
      if (typeof message.sourceUrl !== 'string' || !message.sourceUrl.startsWith('blob:') || !Number.isSafeInteger(sourceSize) || sourceSize <= 0) throw new Error('O CBR não chegou ao worker como um Blob local completo.');
      const rangeProbe = await fetch(message.sourceUrl, { headers: { Range: 'bytes=0-0' } });
      if (rangeProbe.status !== 206) {
        if (rangeProbe.body) await rangeProbe.body.cancel().catch(() => {});
        throw new Error('Este navegador não conseguiu ler o Blob local do CBR com segurança.');
      }
      const probeBytes = await rangeProbe.arrayBuffer();
      if (probeBytes.byteLength !== 1) throw new Error('A verificação do Blob local do CBR retornou um tamanho inesperado.');
      self.__PlanetaHQBlobUrl = message.sourceUrl;
      const wasmUrl = new URL('./unrar.wasm', self.location.href);
      const wasmResponse = await fetch(wasmUrl, { cache: 'no-store' });
      if (!wasmResponse.ok) throw new Error(`Não foi possível carregar o decoder RAR (${wasmResponse.status}).`);
      const wasmBinary = await wasmResponse.arrayBuffer();
      const blobSource = { size: sourceSize, slice: () => null };
      extractor = await createBlobExtractor({ blob: blobSource, wasmBinary });
      resetSequentialArchive();
      const fileList = extractor.getFileList();
      pageNames = [...fileList.fileHeaders]
        .filter(header => !header.flags.directory && /\.(jpe?g|png|webp|gif)$/i.test(header.name))
        .map(header => header.name)
        .sort(naturalSort);
      if (!pageNames.length) throw new Error('Nenhuma imagem encontrada dentro do CBR.');
      self.postMessage({ id, ok: true, pageCount: pageNames.length });
      return;
    }

    if (command === 'page') {
      if (!extractor) throw new Error('O leitor CBR no worker não está inicializado.');
      const index = Number(message.index);
      if (!Number.isInteger(index) || index < 0 || index >= pageNames.length) {
        throw new RangeError('Índice de página CBR inválido.');
      }
      const name = pageNames[index];
      const result = extractor.extract({ files: [name] });
      const entry = [...result.files][0];
      if (!entry || !entry.extraction || entry.extraction === 'skipped') {
        throw new Error(`Falha ao extrair página do CBR: ${name}`);
      }
      let bytes = entry.extraction;
      if (bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) bytes = bytes.slice();
      const payload = bytes.buffer;
      entry.extraction = null;
      self.postMessage({ id, ok: true, index, name, mime: mimeForName(name), bytes: payload }, [payload]);
      return;
    }

    if (command === 'pages') {
      if (!extractor) throw new Error('O leitor CBR no worker não está inicializado.');
      const indices = [...new Set((message.indices || []).map(Number))]
        .filter(index => Number.isInteger(index) && index >= 0 && index < pageNames.length);
      if (!indices.length) throw new RangeError('Nenhuma página CBR válida foi solicitada.');
      const wantedNames = indices.map(index => pageNames[index]);
      // Mantém o arquivo RAR aberto e avança a partir do ponto anterior.
      // Isso é especialmente importante em arquivos sólidos: reabrir o RAR
      // para cada lote obrigava o decoder a refazer todo o trabalho anterior.
      if (sequentialFinished || wantedNames.some(name => sequentialSeen.has(name))) resetSequentialArchive();
      if (!sequentialOpen) {
        extractor.openArc(false);
        sequentialOpen = true;
      }
      const wanted = new Set(wantedNames);
      const extractedByName = new Map();
      while (extractedByName.size < wanted.size && !sequentialFinished) {
        const arcFile = extractor.processNextFile(header => !wanted.has(header.name));
        if (arcFile === 'ERAR_END_ARCHIVE') {
          sequentialFinished = true;
          try { extractor.closeArc(); } catch (error) {}
          sequentialOpen = false;
          break;
        }
        const name = arcFile && arcFile.fileHeader && arcFile.fileHeader.name;
        if (!name) continue;
        sequentialSeen.add(name);
        if (!wanted.has(name) || !arcFile.extraction || arcFile.extraction === 'skipped') continue;
        let bytes = arcFile.extraction;
        if (bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) bytes = bytes.slice();
        extractedByName.set(name, { name, mime: mimeForName(name), bytes: bytes.buffer });
        arcFile.extraction = null;
      }
      const pages = [];
      const transfers = [];
      for (const index of indices) {
        const page = extractedByName.get(pageNames[index]);
        if (!page) throw new Error(`Falha ao extrair página do CBR: ${pageNames[index]}`);
        pages.push({ index, name: page.name, mime: page.mime, bytes: page.bytes });
        transfers.push(page.bytes);
      }
      self.postMessage({ id, ok: true, pages }, transfers);
      return;
    }

    if (command === 'dispose') {
      if (extractor) {
        try { if (extractor._archive) extractor.closeArc(); } catch (error) {}
        try { extractor.dataFiles = Object.create(null); } catch (error) {}
        try { extractor.dataFileMap = Object.create(null); } catch (error) {}
      }
      extractor = null;
      pageNames = [];
      self.__PlanetaHQBlobUrl = null;
      self.postMessage({ id, ok: true });
      self.close();
      return;
    }

    throw new Error(`Comando desconhecido para o worker CBR: ${command}`);
  } catch (error) {
    sendError(id, error);
  }
});
