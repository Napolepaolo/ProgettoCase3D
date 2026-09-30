#!/usr/bin/env node
// Genera le opere dimostrative della galleria, in attesa dei rilievi reali:
// modello GLB procedurale in scala da plastico, poster, anteprima social e le
// "foto" del plastico (giro a 360° o foto singola), secondo data/opere.json.
//
//   node scripts/genera-segnaposto.mjs                  tutte le opere del catalogo
//   node scripts/genera-segnaposto.mjs trullo-di-prova  solo quelle indicate
//   node scripts/genera-segnaposto.mjs --forza          sovrascrive anche i file modificati
//
// Sicurezza: scrive solo in public/opere/<slug>/, e solo se la cartella non esiste o
// contiene il marcatore ".segnaposto" (elenco dei file generati con la loro impronta).
// Una cartella senza marcatore contiene asset reali e viene saltata, anche con --forza.
// Senza --forza si salta anche un'opera in cui un file da rigenerare è stato modificato
// o sostituito (impronta diversa, o file non registrato nel marcatore).

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { documentoGLTF } from './lib/segnaposto-geometria.mjs';
import { FORME, MATERIALI } from './lib/segnaposto-forme.mjs';
import {
  COLORI,
  POSTER,
  GIRO,
  FOTO,
  scenaModello,
  scenaPlastico,
  renderPoster,
  renderFoto,
  controllaVerso,
} from './lib/segnaposto-scene.mjs';

const RADICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE_DATI = path.join(RADICE, 'data', 'opere.json');
const CARTELLA_OPERE = path.join(RADICE, 'public', 'opere');
const MARCATORE = '.segnaposto';
const SOCIALE = { larghezza: 1200, altezza: 630 };
const QUALITA_WEBP = 80;
// Thread di render per i frame: lascio respiro alla codifica (sharp) e al resto del sistema.
const LAVORATORI = Math.max(1, Math.min(3, os.availableParallelism() - 2));

// --- Utilità -------------------------------------------------------------------------

const kb = (byte) => `${(byte / 1024).toFixed(byte < 10240 ? 1 : 0)} KB`;
const secondi = (ms) => `${(ms / 1000).toFixed(1)} s`;
const impronta = (dati) => crypto.createHash('sha256').update(dati).digest('hex');
const nomeFrame = (tt, i) => `${tt.cartella}/${String(i).padStart(3, '0')}.${tt.estensione.toLowerCase()}`;

/** Errore dovuto agli argomenti o ai dati: si stampa senza traccia dello stack. */
class ErroreUso extends Error {}

function avviso(messaggio) {
  console.warn(`  ! ${messaggio}`);
}

/** Percorso assoluto di un file dell'opera, controllando che resti dentro la sua cartella. */
function dentroOpera(cartella, relativo) {
  const p = path.resolve(cartella, relativo);
  if (!p.startsWith(cartella + path.sep)) throw new ErroreUso(`percorso fuori dalla cartella dell'opera: ${relativo}`);
  return p;
}

/** Codifica i pixel RGB nel formato indicato dall'estensione. */
function codifica(pixel, larghezza, altezza, estensione) {
  const img = sharp(pixel, { raw: { width: larghezza, height: altezza, channels: 3 } });
  switch (estensione.toLowerCase()) {
    case 'webp':
      return img.webp({ quality: QUALITA_WEBP, effort: 5, smartSubsample: true }).toBuffer();
    case 'jpg':
    case 'jpeg':
      return img.jpeg({ quality: 86, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();
    case 'png':
      return img.png({ compressionLevel: 9 }).toBuffer();
    default:
      throw new ErroreUso(`estensione non supportata per le immagini: "${estensione}"`);
  }
}

// --- Marcatore ----------------------------------------------------------------------------

async function leggiMarcatore(cartella) {
  const file = path.join(cartella, MARCATORE);
  if (!existsSync(file)) return null;
  try {
    const dati = JSON.parse(await fs.readFile(file, 'utf8'));
    return { file: dati && typeof dati.file === 'object' && dati.file ? dati.file : {} };
  } catch {
    return { file: {} }; // marcatore illeggibile: vale come cartella segnaposto senza file noti
  }
}

/**
 * Registro dei file generati in una cartella: viene riscritto (in modo atomico) dopo
 * ogni file, così anche una generazione interrotta a metà resta riconoscibile.
 */
function registro(cartella, iniziale) {
  const file = { ...iniziale };
  let coda = Promise.resolve();
  const salva = () => {
    coda = coda.then(async () => {
      const destinazione = path.join(cartella, MARCATORE);
      const provvisorio = `${destinazione}.tmp`;
      const contenuto = {
        nota:
          'Cartella generata da scripts/genera-segnaposto.mjs (opera dimostrativa). ' +
          "Quando metti gli asset reali cancella questo file, o l'intera cartella: lo script non la toccherà più.",
        file: Object.fromEntries(Object.entries(file).sort(([a], [b]) => a.localeCompare(b))),
      };
      await fs.writeFile(provvisorio, `${JSON.stringify(contenuto, null, 2)}\n`);
      await fs.rename(provvisorio, destinazione);
    });
    return coda;
  };
  return { file, salva };
}

// --- Anteprima social ------------------------------------------------------------------------

/** Testo in Pango markup reso da sharp (font di sistema: Georgia e Menlo, con ripieghi). */
async function testo(markup, { font, larghezza, interlinea = 0 }) {
  const { data, info } = await sharp({
    text: { text: markup, font, width: larghezza, wrap: 'word', dpi: 72, rgba: true, spacing: interlinea },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { input: data, altezza: info.height };
}

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 1200×630: modello a sinistra, a destra marchio, nome dell'opera e località, come una targhetta. */
async function anteprimaSociale(scena, modello, opera) {
  const { larghezza: W, altezza: H } = SOCIALE;
  const lato = H;
  const pixel = renderPoster(scena, modello, { larghezza: lato, altezza: lato, fondo: COLORI.carta, margine: 0.1 });
  const immagine = await sharp(pixel, { raw: { width: lato, height: lato, channels: 3 } }).png().toBuffer();

  const x0 = lato + 56;
  const colonna = W - x0 - 64;
  const alto = 58;
  const marchio = await testo(`<span foreground="${COLORI.petrolio}" letter_spacing="1100">3D Building by fareLAB</span>`, {
    font: 'Menlo 17',
    larghezza: colonna,
  });
  const nome = await testo(`<span foreground="${COLORI.inchiostro}" letter_spacing="-900">${escapeXml(opera.nome)}</span>`, {
    font: 'Georgia Bold 60',
    larghezza: colonna,
    interlinea: -4,
  });
  const luogo = [opera.localita, opera.anno].filter(Boolean).join(' · ').toUpperCase();
  const localita = await testo(`<span foreground="${COLORI.testoSecondario}" letter_spacing="1500">${escapeXml(luogo)}</span>`, {
    font: 'Menlo 17',
    larghezza: colonna,
  });
  const piede = await testo(
    `<span foreground="${COLORI.testoSecondario}" letter_spacing="1100">MODELLO 3D · PLASTICO · REALTÀ AUMENTATA</span>`,
    { font: 'Menlo 13', larghezza: colonna },
  );

  // Nome e località centrati in verticale; marchio in alto, piede in basso; filetti da 1px.
  const yNome = Math.round((H - (nome.altezza + 30 + localita.altezza)) / 2);
  const yPiede = H - alto - piede.altezza;
  const filetti = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect x="${lato}" y="0" width="1" height="${H}" fill="${COLORI.filetto}"/>
    <rect x="${x0}" y="${yNome + nome.altezza + 14}" width="40" height="1" fill="${COLORI.filetto}"/>
    <rect x="${x0}" y="${yPiede - 17}" width="${colonna}" height="1" fill="${COLORI.filetto}"/>
  </svg>`;
  return sharp({ create: { width: W, height: H, channels: 3, background: COLORI.carta } })
    .composite([
      { input: immagine, left: 0, top: 0 },
      { input: Buffer.from(filetti), left: 0, top: 0 },
      { input: marchio.input, left: x0, top: alto },
      { input: nome.input, left: x0 - 2, top: yNome },
      { input: localita.input, left: x0, top: yNome + nome.altezza + 30 },
      { input: piede.input, left: x0, top: yPiede },
    ])
    .jpeg({ quality: 88, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

// --- Frame del giro, in parallelo ----------------------------------------------------------------

/**
 * Renderizza i frame con alcuni thread (ognuno riceve una copia della scena) e chiama
 * `suFrame(indice, pixel)` man mano che arrivano; la codifica avviene qui, in sharp.
 */
async function renderGiro(plastico, angoli, suFrame) {
  const lavori = angoli.map((angolo, i) => ({ indice: i + 1, angolo, larghezza: GIRO.lato, altezza: GIRO.lato }));
  const n = Math.min(LAVORATORI, lavori.length);
  const url = new URL('./lib/segnaposto-lavoratore.mjs', import.meta.url);
  const inCorso = [];
  let prossimo = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      const lavoratore = new Worker(url, { workerData: { plastico } });
      try {
        while (prossimo < lavori.length) {
          const lavoro = lavori[prossimo++];
          const risposta = await new Promise((risolvi, rifiuta) => {
            lavoratore.once('message', risolvi);
            lavoratore.once('error', rifiuta);
            lavoratore.postMessage(lavoro);
          });
          lavoratore.removeAllListeners('error');
          if (risposta.errore) throw new Error(`render del frame ${lavoro.indice}: ${risposta.errore}`);
          const scrittura = suFrame(risposta.indice, risposta.pixel);
          scrittura.catch(() => {}); // l'errore arriva comunque da Promise.all qui sotto
          inCorso.push(scrittura);
        }
      } finally {
        await lavoratore.terminate();
      }
    }),
  );
  await Promise.all(inCorso);
}

// --- Opera -----------------------------------------------------------------------------------

async function generaOpera(opera, { forza }) {
  const t0 = performance.now();
  const cartella = path.join(CARTELLA_OPERE, opera.slug);
  const marcatore = await leggiMarcatore(cartella);
  const vuota = !existsSync(cartella) || (await fs.readdir(cartella)).every((f) => f === '.DS_Store');
  if (!vuota && !marcatore) {
    avviso(`public/opere/${opera.slug}/ esiste ma non ha il marcatore ${MARCATORE}: contiene asset reali, la salto.`);
    return null;
  }

  // File da produrre, con i percorsi del file dati.
  const tt = opera.turntable ?? null;
  const daScrivere = [opera.glb, opera.poster];
  if (opera.anteprimaSocial) daScrivere.push(opera.anteprimaSocial);
  if (tt) for (let i = 1; i <= tt.numeroFrame; i++) daScrivere.push(nomeFrame(tt, i));
  else if (opera.fotoPlastico) daScrivere.push(opera.fotoPlastico);
  const assoluti = new Map(daScrivere.map((rel) => [rel, dentroOpera(cartella, rel)]));

  // File modificati o estranei al posto di quelli da generare: senza --forza non tocco niente.
  const noti = marcatore?.file ?? {};
  const sospetti = [];
  for (const [rel, abs] of assoluti) {
    if (existsSync(abs) && noti[rel] !== impronta(await fs.readFile(abs))) sospetti.push(rel);
  }
  if (sospetti.length && !forza) {
    avviso(
      `${opera.slug}: ${sospetti.length} file modificati o non generati da questo script ` +
        `(es. ${sospetti[0]}). La salto; con --forza li sovrascrivo.`,
    );
    return null;
  }

  await fs.mkdir(cartella, { recursive: true });
  const reg = registro(cartella, noti);
  await reg.salva(); // il marcatore esiste da subito, anche se la generazione si interrompe
  const dimensioni = {};
  const scrivi = async (rel, dati) => {
    const abs = assoluti.get(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, dati);
    reg.file[rel] = impronta(dati);
    dimensioni[rel] = dati.length;
    await reg.salva();
  };
  const estensione = (rel) => path.extname(rel).slice(1);

  // 1. Modello in scala da plastico (metri, Y in alto, centrato, base a Y = 0).
  const modello = FORME[opera.slug]();
  modello.inScala(opera.scalaAR / 100);
  const glb = await new NodeIO().writeBinary(documentoGLTF(modello, { nome: opera.nome, materiali: MATERIALI }));
  await scrivi(opera.glb, Buffer.from(glb));

  // 2. Poster e anteprima social.
  const scenaColori = scenaModello(modello);
  const poster = renderPoster(scenaColori, modello, { larghezza: POSTER.lato, altezza: POSTER.lato, fondo: COLORI.cartaChiara });
  await scrivi(opera.poster, await codifica(poster, POSTER.lato, POSTER.lato, estensione(opera.poster)));
  if (opera.anteprimaSocial) await scrivi(opera.anteprimaSocial, await anteprimaSociale(scenaColori, modello, opera));

  // 3. Il plastico: giro a 360° oppure una foto singola.
  if (tt) {
    const plastico = scenaPlastico(modello);
    const passo = 360 / tt.numeroFrame;
    controllaVerso(plastico, passo, tt.inverti);
    // Frame i: oggetto ruotato di (i-1)·passo gradi, antiorario visto dall'alto
    // (orario se il file dati chiede `inverti`, per provare anche quel caso).
    const angoli = Array.from({ length: tt.numeroFrame }, (_, i) => i * passo * (tt.inverti ? -1 : 1));
    let fatti = 0;
    await renderGiro(plastico, angoli, async (indice, pixel) => {
      await scrivi(nomeFrame(tt, indice), await codifica(pixel, GIRO.lato, GIRO.lato, tt.estensione));
      fatti++;
      if (process.stdout.isTTY) process.stdout.write(`\r  frame ${fatti}/${tt.numeroFrame}`);
    });
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
  } else if (opera.fotoPlastico) {
    const plastico = scenaPlastico(modello);
    const pixel = renderFoto(plastico, 0, { ...FOTO });
    await scrivi(opera.fotoPlastico, await codifica(pixel, FOTO.larghezza, FOTO.altezza, estensione(opera.fotoPlastico)));
  }

  // 4. Pulizia: file generati in passato e non più previsti (solo se intatti).
  for (const [rel, hash] of Object.entries(noti)) {
    if (assoluti.has(rel)) continue;
    const abs = dentroOpera(cartella, rel);
    if (existsSync(abs) && impronta(await fs.readFile(abs)) === hash) {
      await fs.rm(abs);
      console.log(`  - rimosso ${rel} (non più previsto dal file dati)`);
    }
    delete reg.file[rel];
  }
  await reg.salva();
  await rimuoviCartelleVuote(cartella);

  return { modello, dimensioni, ms: performance.now() - t0 };
}

async function rimuoviCartelleVuote(cartella) {
  for (const voce of await fs.readdir(cartella, { withFileTypes: true })) {
    if (!voce.isDirectory()) continue;
    const sotto = path.join(cartella, voce.name);
    await rimuoviCartelleVuote(sotto);
    if ((await fs.readdir(sotto)).length === 0) await fs.rmdir(sotto);
  }
}

function riepilogo(opera, { dimensioni, modello, ms }) {
  const { min, max } = modello.limiti();
  const cm = (v) => (v * 100).toFixed(1);
  console.log(
    `  modello: ${modello.numeroTriangoli()} triangoli, ` +
      `${cm(max[0] - min[0])} × ${cm(max[2] - min[2])} cm di base, alto ${cm(max[1] - min[1])} cm`,
  );
  const cartellaFrame = opera.turntable ? `${opera.turntable.cartella}/` : null;
  const frame = Object.entries(dimensioni).filter(([rel]) => cartellaFrame && rel.startsWith(cartellaFrame));
  for (const [rel, byte] of Object.entries(dimensioni)) {
    if (!cartellaFrame || !rel.startsWith(cartellaFrame)) console.log(`  ${rel.padEnd(36)}${kb(byte).padStart(9)}`);
  }
  if (frame.length) {
    const totale = frame.reduce((s, [, b]) => s + b, 0);
    console.log(`  ${`${cartellaFrame} (${frame.length} frame)`.padEnd(36)}${kb(totale).padStart(9)}  (${kb(totale / frame.length)} l'uno)`);
  }
  console.log(`  tempo: ${secondi(ms)}`);
}

// --- Avvio ------------------------------------------------------------------------------------

async function main() {
  const argomenti = process.argv.slice(2);
  if (argomenti.some((a) => ['--aiuto', '--help', '-h'].includes(a))) {
    console.log(
      'Uso: node scripts/genera-segnaposto.mjs [slug…] [--forza]\n' + `Opere dimostrative: ${Object.keys(FORME).join(', ')}`,
    );
    return;
  }
  const forza = argomenti.includes('--forza');
  const sconosciute = argomenti.filter((a) => a.startsWith('-') && a !== '--forza');
  if (sconosciute.length) throw new ErroreUso(`opzione sconosciuta: ${sconosciute.join(' ')} (vedi --aiuto)`);
  const richiesti = argomenti.filter((a) => !a.startsWith('-'));

  const dati = JSON.parse(await fs.readFile(FILE_DATI, 'utf8'));
  const perSlug = new Map(dati.map((o) => [o.slug, o]));
  for (const slug of richiesti) {
    if (!FORME[slug]) throw new ErroreUso(`"${slug}" non è un'opera dimostrativa. Disponibili: ${Object.keys(FORME).join(', ')}`);
    if (!perSlug.has(slug)) throw new ErroreUso(`"${slug}" non compare in data/opere.json`);
  }
  const slugs = richiesti.length ? richiesti : Object.keys(FORME).filter((s) => perSlug.has(s));

  const t0 = performance.now();
  let generate = 0;
  for (const slug of slugs) {
    const opera = perSlug.get(slug);
    console.log(`\n${opera.nome} (${slug})`);
    const esito = await generaOpera(opera, { forza });
    if (!esito) continue;
    generate++;
    riepilogo(opera, esito);
  }
  console.log(`\n${generate} opere su ${slugs.length} generate in ${secondi(performance.now() - t0)}.`);
}

main().catch((errore) => {
  console.error(`\nErrore: ${errore instanceof ErroreUso ? errore.message : (errore.stack ?? errore)}`);
  process.exitCode = 1;
});
