#!/usr/bin/env node
// Poster (1600×1600) e anteprima social (1200×630) di un'opera, renderizzati con
// <model-viewer> in un Chrome headless: stessa luce e stessa inquadratura della pagina,
// così il passaggio dal poster al modello 3D non "salta".
//
//   node scripts/poster.mjs <slug> [--glb <file>] [--uscita <cartella>] [--nome "…"]
//
// Esporta anche generaPoster(), usata da converti-modello.mjs.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { trovaChrome } from './lib/chrome.mjs';
import { leggiIntestazioneGlb, toneMappingPerGlb } from './lib/intestazione-glb.mjs';
import { cartellaModello, CARTELLA_PUBLIC, controllaSlug, nomeDaSlug, RADICE, relativo, scriviAtomico, trovaOpera } from './lib/progetto.mjs';
import { avvia, avviso, ErroreUtente, erroreArgomenti, info, mb, ok, stile, titolo, voce } from './lib/terminale.mjs';

/** Colori dai token di src/styles/global.css (qui servono come valori letterali). */
const COLORI = {
  cartaChiara: '#f8f5ee', // --carta-chiara: sfondo del poster (riquadro del modello)
  carta: '#f3eee4', // --carta: sfondo dell'anteprima social
  inchiostro: '#1c2b31',
  testoSecondario: '#4f5b5c',
  petrolio: '#1f5c68',
  filetto: '#cfc6b5',
};

/**
 * Parametri di <model-viewer> che decidono l'aspetto del poster. Devono essere gli stessi
 * della pagina, altrimenti al caricamento del modello l'immagine "salta": per questo li
 * leggiamo da src/components/ModelloDigitale.astro (solo valori letterali) e usiamo questi
 * valori predefiniti solo se il file manca o non li contiene.
 */
export const VISTA_PREDEFINITA = {
  'camera-orbit': '-30deg 65deg auto', // 3/4 dall'alto: 30° a sinistra del fronte, 25° sopra l'orizzonte
  'environment-image': 'neutral',
  exposure: '1',
  'shadow-intensity': '1',
  'shadow-softness': '1',
};
const ATTRIBUTI_VISTA = [
  'camera-orbit', 'camera-target', 'field-of-view', 'environment-image', 'skybox-image',
  'exposure', 'tone-mapping', 'shadow-intensity', 'shadow-softness',
];
const FILE_COMPONENTE_MODELLO = path.join(RADICE, 'src', 'components', 'ModelloDigitale.astro');

export function leggiVistaDellaPagina() {
  try {
    const testo = fs.readFileSync(FILE_COMPONENTE_MODELLO, 'utf8');
    const inizio = testo.indexOf('<model-viewer');
    if (inizio === -1) throw new Error('nessun <model-viewer>');
    const fine = testo.indexOf('</model-viewer>', inizio);
    const blocco = testo.slice(inizio, fine === -1 ? inizio + 5000 : fine);
    const vista = {};
    for (const nome of ATTRIBUTI_VISTA) {
      const trovato = blocco.match(new RegExp(`\\s${nome}="([^"{}]*)"`));
      if (trovato) vista[nome] = trovato[1];
    }
    if (!vista['camera-orbit']) throw new Error('camera-orbit non trovato');
    return { vista, origine: relativo(FILE_COMPONENTE_MODELLO) };
  } catch {
    return { vista: VISTA_PREDEFINITA, origine: 'valori predefiniti di poster.mjs' };
  }
}

const LATO_POSTER = 1600;
const SOCIALE = { larghezza: 1200, altezza: 630 };
const QUALITA_JPEG = 85;

const MODULI = path.join(RADICE, 'node_modules');
const RISORSE = {
  '/model-viewer.min.js': path.join(MODULI, '@google/model-viewer/dist/model-viewer.min.js'),
  // Decodificatori serviti in locale: di default model-viewer scarica Draco da gstatic.com.
  '/draco/draco_decoder.js': path.join(MODULI, 'three/examples/jsm/libs/draco/gltf/draco_decoder.js'),
  '/draco/draco_decoder.wasm': path.join(MODULI, 'three/examples/jsm/libs/draco/gltf/draco_decoder.wasm'),
  '/draco/draco_wasm_wrapper.js': path.join(MODULI, 'three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js'),
  '/meshopt_decoder.js': path.join(MODULI, 'meshoptimizer/meshopt_decoder.cjs'),
  '/font/fraunces.woff2': path.join(MODULI, '@fontsource-variable/fraunces/files/fraunces-latin-wght-normal.woff2'),
  '/font/plex-mono-500.woff2': path.join(MODULI, '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2'),
};

const TIPI = {
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.html': 'text/html; charset=utf-8',
};

const ARGOMENTI_CHROME = [
  // WebGL senza GPU: rendering software con SwiftShader tramite ANGLE.
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--enable-webgl',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-dev-shm-usage',
];

function escapeHtml(testo) {
  return String(testo).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function paginaRender(vista) {
  const attributi = {
    src: '/modello.glb',
    ...vista,
    'interaction-prompt': 'none',
    loading: 'eager',
    reveal: 'auto',
  };
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; background: transparent; overflow: hidden; }
  model-viewer { display: block; width: 100vw; height: 100vh; background-color: transparent;
    --poster-color: transparent; --progress-bar-height: 0px; }
</style>
<script>
  // Letta da model-viewer al primo elemento creato: decodificatori in locale, niente CDN.
  self.ModelViewerElement = { dracoDecoderLocation: '/draco/', meshoptDecoderLocation: '/meshopt_decoder.js' };
  window.__stato = { fase: 'attesa' };
</script>
<script type="module">
  const prova = document.createElement('canvas');
  if (!(prova.getContext('webgl2') || prova.getContext('webgl'))) {
    window.__stato = { fase: 'errore', messaggio: 'WebGL non disponibile nel browser headless' };
  } else {
    const { ModelViewerElement } = await import('/model-viewer.min.js');
    ModelViewerElement.minimumRenderScale = 1; // niente riduzione di risoluzione se il rendering è lento
    const mv = document.createElement('model-viewer');
    for (const [nome, valore] of Object.entries(${JSON.stringify(attributi)})) mv.setAttribute(nome, valore);
    mv.addEventListener('load', () => { window.__stato = { fase: 'caricato' }; });
    mv.addEventListener('error', (e) => {
      const d = e.detail || {};
      window.__stato = { fase: 'errore', messaggio: String((d.sourceError && d.sourceError.message) || d.type || 'errore di caricamento del modello') };
    });
    window.__mv = mv;
    document.body.append(mv);
  }
</script>
</head><body></body></html>`;
}

function paginaSocial({ nome, localita }) {
  const lunghezza = nome.length;
  const corpoTitolo = lunghezza > 40 ? 50 : lunghezza > 24 ? 58 : 68;
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8">
<style>
  @font-face { font-family: 'Fraunces Variable'; src: url('/font/fraunces.woff2') format('woff2'); font-weight: 100 900; }
  @font-face { font-family: 'IBM Plex Mono'; src: url('/font/plex-mono-500.woff2') format('woff2'); font-weight: 500; }
  html, body { margin: 0; }
  body { width: ${SOCIALE.larghezza}px; height: ${SOCIALE.altezza}px; background: ${COLORI.carta}; position: relative; overflow: hidden; }
  .modello { position: absolute; left: 48px; top: 40px; width: 600px; height: 550px;
    display: flex; align-items: center; justify-content: center; }
  .modello img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .testo { position: absolute; left: 700px; right: 64px; top: 0; bottom: 0;
    display: flex; flex-direction: column; justify-content: center; }
  .mono { font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-weight: 500;
    text-transform: uppercase; letter-spacing: 0.1em; font-size: 16px; line-height: 1.4; }
  .luogo { color: ${COLORI.petrolio}; margin: 0 0 20px; }
  h1 { font-family: 'Fraunces Variable', Georgia, 'Times New Roman', serif; font-weight: 600;
    font-size: ${corpoTitolo}px; line-height: 1.06; letter-spacing: -0.02em; color: ${COLORI.inchiostro}; margin: 0; }
  .filetto { width: 56px; height: 1px; background: ${COLORI.filetto}; margin: 32px 0 18px; }
  .marchio { color: ${COLORI.testoSecondario}; font-size: 14px; text-transform: none; } /* "FareLAB" si scrive così */
</style></head>
<body>
  <div class="modello"><img src="/render.png" alt=""></div>
  <div class="testo">
    ${localita ? `<p class="mono luogo">${escapeHtml(localita)}</p>` : ''}
    <h1>${escapeHtml(nome)}</h1>
    <div class="filetto"></div>
    <p class="mono marchio">3D Building by FareLAB</p>
  </div>
</body></html>`;
}

/** Mini server locale su porta casuale: serve solo le risorse elencate, il GLB e le pagine generate. */
function avviaServer({ glb, pagine }) {
  const server = http.createServer((richiesta, risposta) => {
    const percorso = decodeURIComponent(new URL(richiesta.url, 'http://localhost').pathname);
    if (pagine.has(percorso)) {
      const { tipo, contenuto } = pagine.get(percorso);
      risposta.writeHead(200, { 'Content-Type': tipo, 'Cache-Control': 'no-store' });
      risposta.end(contenuto);
      return;
    }
    const file = percorso === '/modello.glb' ? glb : RISORSE[percorso];
    if (!file || !fs.existsSync(file)) {
      risposta.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      risposta.end('non trovato');
      return;
    }
    risposta.writeHead(200, {
      'Content-Type': TIPI[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': fs.statSync(file).size,
    });
    fs.createReadStream(file).pipe(risposta);
  });
  return new Promise((risolvi, rifiuta) => {
    server.once('error', rifiuta);
    server.listen(0, '127.0.0.1', () => risolvi(server));
  });
}

async function avviaBrowser(chrome) {
  const { default: puppeteer } = await import('puppeteer-core');
  const argomenti = [...ARGOMENTI_CHROME];
  if (process.platform === 'linux' && process.getuid?.() === 0) argomenti.push('--no-sandbox');
  try {
    return await puppeteer.launch({
      executablePath: chrome.percorso,
      headless: chrome.headless,
      args: argomenti,
      timeout: 60_000,
      protocolTimeout: 300_000,
    });
  } catch (errore) {
    throw new ErroreUtente(`impossibile avviare il browser (${chrome.percorso}): ${errore.message}`, {
      codice: 3,
      suggerimento:
        'Su macOS, se il sistema blocca il file scaricato, prova:\n' +
        `    xattr -dr com.apple.quarantine "${path.dirname(chrome.percorso)}"`,
    });
  }
}

/** Carica il modello in <model-viewer> e restituisce il render PNG (sfondo trasparente). */
async function renderModello(browser, base, { timeoutMs, messaggi }) {
  const pagina = await browser.newPage();
  pagina.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warn' || m.type() === 'warning') messaggi.push(`${m.type()}: ${m.text()}`);
  });
  pagina.on('pageerror', (e) => messaggi.push(`errore JS: ${e.message}`));
  pagina.on('requestfailed', (r) => messaggi.push(`richiesta fallita: ${r.url()} (${r.failure()?.errorText})`));

  // 800×800 CSS px con densità 2 → 1600×1600 pixel reali.
  await pagina.setViewport({ width: LATO_POSTER / 2, height: LATO_POSTER / 2, deviceScaleFactor: 2 });
  await pagina.goto(`${base}/render.html`, { waitUntil: 'load', timeout: 60_000 });
  try {
    await pagina.waitForFunction(() => window.__stato.fase !== 'attesa', { timeout: timeoutMs, polling: 250 });
  } catch {
    throw new ErroreUtente(`il modello non si è caricato entro ${Math.round(timeoutMs / 1000)} s nel browser headless.`);
  }
  const stato = await pagina.evaluate(() => window.__stato);
  if (stato.fase === 'errore') throw new ErroreUtente(`rendering non riuscito: ${stato.messaggio}`);

  const dataUrl = await pagina.evaluate(async () => {
    const mv = window.__mv;
    await mv.updateComplete;
    // Qualche frame per shader, ombra e ambiente; poi model-viewer, fermo, rende a piena scala.
    for (let i = 0; i < 30; i++) await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 800));
    const blob = await mv.toBlob({ mimeType: 'image/png' });
    return await new Promise((risolvi, rifiuta) => {
      const lettore = new FileReader();
      lettore.onload = () => risolvi(lettore.result);
      lettore.onerror = () => rifiuta(lettore.error);
      lettore.readAsDataURL(blob);
    });
  });
  await pagina.close();
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');

  const { channels } = await sharp(png).stats();
  if (channels.length < 4 || channels[3].max === 0) {
    throw new ErroreUtente('il render è vuoto (nessun pixel visibile): WebGL probabilmente non funziona nel browser headless.');
  }
  return png;
}

async function renderSocial(browser, base) {
  const pagina = await browser.newPage();
  await pagina.setViewport({ width: SOCIALE.larghezza, height: SOCIALE.altezza, deviceScaleFactor: 1 });
  await pagina.goto(`${base}/social.html`, { waitUntil: 'load', timeout: 60_000 });
  const fontOk = await pagina.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check("600 40px 'Fraunces Variable'") && document.fonts.check("500 16px 'IBM Plex Mono'");
  });
  const png = await pagina.screenshot({ type: 'png', clip: { x: 0, y: 0, width: SOCIALE.larghezza, height: SOCIALE.altezza } });
  await pagina.close();
  return { png: Buffer.from(png), fontOk };
}

/**
 * Genera poster.jpg e anteprima-social.jpg in `cartellaUscita`.
 * Scrive i file solo se entrambi i render riescono (niente file a metà).
 */
export async function generaPoster({
  glb,
  cartellaUscita,
  nome,
  localita = null,
  vista = null,
  chrome: chromeEsplicito = null,
  timeoutMs = 180_000,
}) {
  if (!fs.existsSync(glb)) throw new ErroreUtente(`modello non trovato: ${relativo(glb)}`);
  for (const [url, file] of Object.entries(RISORSE)) {
    if (!fs.existsSync(file) && !url.startsWith('/font/')) {
      throw new ErroreUtente(`risorsa mancante in node_modules: ${relativo(file)} (hai lanciato "npm install"?)`);
    }
  }
  const chrome = await trovaChrome({ esplicito: chromeEsplicito });
  let origineVista = 'opzioni';
  if (!vista) ({ vista, origine: origineVista } = leggiVistaDellaPagina());
  // Stessa regola della pagina: per la fotogrammetria con luce cotta nella texture il tone mapping è spento.
  const toneMapping = toneMappingPerGlb(leggiIntestazioneGlb(glb));
  if (toneMapping && !vista['tone-mapping']) vista = { ...vista, 'tone-mapping': toneMapping };
  voce('Browser', `${chrome.origine}`);
  voce('Inquadratura e luce', `${Object.entries(vista).map(([k, v]) => `${k}="${v}"`).join(' ')} (da ${origineVista})`);
  voce('Modello', `${relativo(glb)} (${mb(fs.statSync(glb).size)})`);

  const pagine = new Map([
    ['/render.html', { tipo: TIPI['.html'], contenuto: paginaRender(vista) }],
    ['/social.html', { tipo: TIPI['.html'], contenuto: paginaSocial({ nome, localita }) }],
  ]);
  const server = await avviaServer({ glb, pagine });
  const base = `http://127.0.0.1:${server.address().port}`;
  const messaggi = [];
  let browser;
  const t0 = Date.now();
  try {
    browser = await avviaBrowser(chrome);
    info('rendering del modello (WebGL software: può richiedere fino a un minuto)…');
    const render = await renderModello(browser, base, { timeoutMs, messaggi });

    const poster = await sharp({
      create: { width: LATO_POSTER, height: LATO_POSTER, channels: 3, background: COLORI.cartaChiara },
    })
      .composite([{ input: await sharp(render).resize(LATO_POSTER, LATO_POSTER, { fit: 'contain', background: '#0000' }).png().toBuffer() }])
      .jpeg({ quality: QUALITA_JPEG, mozjpeg: true })
      .toBuffer();

    // Per l'anteprima social il modello va ritagliato ai bordi (niente margini vuoti).
    const ritagliato = await sharp(render).trim({ threshold: 1 }).png().toBuffer();
    pagine.set('/render.png', { tipo: TIPI['.png'], contenuto: ritagliato });
    const social = await renderSocial(browser, base);
    if (!social.fontOk) avviso('font del sito non disponibili: l\'anteprima usa un serif e un monospaziato di sistema.');
    const anteprima = await sharp(social.png)
      .flatten({ background: COLORI.carta })
      .jpeg({ quality: QUALITA_JPEG, mozjpeg: true })
      .toBuffer();

    const filePoster = path.join(cartellaUscita, 'poster.jpg');
    const fileSocial = path.join(cartellaUscita, 'anteprima-social.jpg');
    await scriviAtomico(filePoster, poster);
    await scriviAtomico(fileSocial, anteprima);
    ok(`${relativo(filePoster)} (${LATO_POSTER}×${LATO_POSTER}, ${mb(poster.length)})`);
    ok(`${relativo(fileSocial)} (${SOCIALE.larghezza}×${SOCIALE.altezza}, ${mb(anteprima.length)})`);
    info(stile.tenue(`completato in ${Math.round((Date.now() - t0) / 100) / 10} s`));
    return { poster: filePoster, social: fileSocial };
  } catch (errore) {
    if (messaggi.length) {
      console.log(stile.tenue('  Messaggi del browser:'));
      for (const m of messaggi.slice(-15)) console.log(stile.tenue(`    ${m}`));
    }
    throw errore;
  } finally {
    await browser?.close().catch(() => {});
    server.closeAllConnections?.();
    server.close();
  }
}

const AIUTO = `
Uso: node scripts/poster.mjs <slug> [opzioni]

Genera public/opere/<slug>/modello/poster.jpg (1600×1600) e anteprima-social.jpg (1200×630)
renderizzando modello.glb con <model-viewer> in un Chrome headless.

Opzioni:
  --glb <file>          modello da usare (predefinito: modello.glb della cartella di uscita)
  --uscita <cartella>   dove scrivere le immagini (predefinito: public/opere/<slug>/modello/)
  --nome "<nome>"       titolo dell'anteprima social (predefinito: "nome" in data/opere.json)
  --localita "<testo>"  riga sopra il titolo (predefinito: "localita" in data/opere.json)
  --orbita "<t> <p> <r>" inquadratura, come camera-orbit (predefinito: quella della pagina,
                        letta da src/components/ModelloDigitale.astro)
  --chrome <eseguibile> browser da usare (in alternativa: variabile CHROME_PATH)
  -h, --help

Browser cercato in: CHROME_PATH, .cache/browsers/ del progetto, installazioni standard.
Per installarlo nel progetto: npx @puppeteer/browsers install chrome-headless-shell@stable --path .cache/browsers
`;

async function principale() {
  let letti;
  try {
    letti = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: {
        glb: { type: 'string' },
        uscita: { type: 'string' },
        nome: { type: 'string' },
        localita: { type: 'string' },
        orbita: { type: 'string' },
        chrome: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (errore) {
    throw erroreArgomenti(errore);
  }
  const { values: v, positionals } = letti;
  if (v.help) {
    console.log(AIUTO);
    return 0;
  }
  if (positionals.length !== 1) throw new ErroreUtente('indica lo slug dell\'opera, es.: node scripts/poster.mjs masseria-san-domenico');
  const slug = controllaSlug(positionals[0]);
  const opera = trovaOpera(slug);
  const cartellaUscita = v.uscita ? path.resolve(v.uscita) : cartellaModello(slug);
  const glb = v.glb
    ? path.resolve(v.glb)
    : !v.uscita && opera?.glb
      ? path.join(CARTELLA_PUBLIC, 'opere', slug, opera.glb)
      : path.join(cartellaUscita, 'modello.glb');

  titolo(`Poster di "${slug}"`);
  if (!v.uscita && opera) {
    if (opera.poster !== 'modello/poster.jpg') avviso(`in data/opere.json "poster" è "${opera.poster}", ma lo script scrive modello/poster.jpg.`);
    if (opera.anteprimaSocial && opera.anteprimaSocial !== 'modello/anteprima-social.jpg') {
      avviso(`in data/opere.json "anteprimaSocial" è "${opera.anteprimaSocial}", ma lo script scrive modello/anteprima-social.jpg.`);
    }
  }
  await generaPoster({
    glb,
    cartellaUscita,
    nome: v.nome ?? opera?.nome ?? nomeDaSlug(slug),
    localita: v.localita ?? opera?.localita ?? null,
    vista: v.orbita ? { ...leggiVistaDellaPagina().vista, 'camera-orbit': v.orbita } : null,
    chrome: v.chrome ? path.resolve(v.chrome) : null,
  });
  return 0;
}

// Eseguito come script (non importato da converti-modello.mjs).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  avvia(principale);
}
