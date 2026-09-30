// Lettura in streaming di file OBJ/MTL (anche da diversi GB) senza caricarli in memoria.
//
// Serve a due cose: l'ispezione del dataset (conteggi, bounding box, materiali) e la
// traslazione preventiva delle coordinate georeferenziate. Gli export di WebODM possono
// avere coordinate UTM (es. x ≈ 650.000, y ≈ 4.500.000 metri): obj2gltf le converte in
// float32, che a quattro milioni ha un passo di 0,5 m. Traslando prima, in doppia
// precisione, il modello resta preciso al micrometro.

import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/** Oltre questo valore assoluto consideriamo le coordinate "georeferenziate" (per i report). */
export const SOGLIA_GEOREFERENZIATE = 1e5;

/**
 * Oltre questo valore assoluto la conversione trasla comunque i vertici: in float32 a 10.000
 * il passo è già di circa 1 mm, sotto è trascurabile per un edificio.
 */
export const SOGLIA_TRASLAZIONE = 1e4;

/**
 * Chiama `gestisci(riga)` per ogni riga del file, leggendo a blocchi da 4 MB.
 * `dopoBlocco` (facoltativa, async) viene attesa dopo ogni blocco: permette di
 * rispettare la contropressione quando si scrive un altro file.
 */
export async function perOgniRiga(percorso, gestisci, { suAvanzamento, dopoBlocco } = {}) {
  const totale = (await fs.promises.stat(percorso)).size || 1;
  const flusso = fs.createReadStream(percorso, { highWaterMark: 4 * 1024 * 1024 });
  const decodificatore = new StringDecoder('utf8');
  let resto = '';
  let letti = 0;
  for await (const blocco of flusso) {
    letti += blocco.length;
    const testo = resto + decodificatore.write(blocco);
    let inizio = 0;
    let fine;
    while ((fine = testo.indexOf('\n', inizio)) !== -1) {
      gestisci(testo.charCodeAt(fine - 1) === 13 ? testo.slice(inizio, fine - 1) : testo.slice(inizio, fine));
      inizio = fine + 1;
    }
    resto = testo.slice(inizio);
    if (dopoBlocco) await dopoBlocco();
    if (suAvanzamento) suAvanzamento(letti / totale);
  }
  resto += decodificatore.end();
  if (resto.length > 0) gestisci(resto.endsWith('\r') ? resto.slice(0, -1) : resto);
}

const SPAZI = /\s+/;

function eSpazio(codice) {
  return codice === 32 || codice === 9;
}

/** Come obj2gltf: "mtllib a b.mtl c.mtl" → ["a b.mtl", "c.mtl"] (nomi con spazi ammessi). */
export function percorsiMtllib(resto) {
  const valore = resto.trim().replace(/^"(.+)"$/, '$1');
  const pezzi = valore.split(' ');
  const percorsi = [];
  let inizio = 0;
  for (let i = 0; i < pezzi.length; i++) {
    if (path.extname(pezzi[i]).toLowerCase() !== '.mtl') continue;
    percorsi.push(pezzi.slice(inizio, i + 1).join(' '));
    inizio = i + 1;
  }
  return percorsi;
}

/** Risolve un riferimento mtllib come fa obj2gltf (con ripiego nella cartella dell'OBJ). */
export function risolviMtl(riferimento, cartellaObj) {
  const normalizzato = path.resolve(cartellaObj, riferimento.replace(/\\/g, '/'));
  if (fs.existsSync(normalizzato)) return normalizzato;
  const vicino = path.join(cartellaObj, path.basename(normalizzato));
  return fs.existsSync(vicino) ? vicino : normalizzato;
}

/**
 * Analizza un OBJ in streaming. Restituisce conteggi, materiali usati, librerie MTL
 * e bounding box in doppia precisione (coordinate originali, senza cambi d'asse).
 */
export async function analizzaObj(percorso, { suAvanzamento } = {}) {
  const esito = {
    percorso,
    byte: (await fs.promises.stat(percorso)).size,
    vertici: 0,
    verticiConColore: 0,
    coordinateTexture: 0,
    normali: 0,
    facce: 0,
    /** Facce senza coordinate texture ("f 1 2 3" o "f 1//1 2//2 3//3"): resterebbero senza colore. */
    facceSenzaUv: 0,
    triangoli: 0,
    gruppi: 0,
    mtllib: [],
    materiali: new Map(), // nome → numero di facce
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    righeIllegibili: 0,
  };
  let materialeCorrente = null;
  const { min, max } = esito;

  await perOgniRiga(
    percorso,
    (riga) => {
      let c0 = riga.charCodeAt(0);
      if (eSpazio(c0)) {
        riga = riga.trimStart();
        c0 = riga.charCodeAt(0);
      }
      const c1 = riga.charCodeAt(1);
      if (c0 === 118 /* v */) {
        if (eSpazio(c1)) {
          const t = riga.split(SPAZI);
          const x = Number(t[1]);
          const y = Number(t[2]);
          const z = Number(t[3]);
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            esito.righeIllegibili++;
            return;
          }
          esito.vertici++;
          if (t.length >= 7 && t[6] !== '') esito.verticiConColore++;
          if (x < min[0]) min[0] = x;
          if (x > max[0]) max[0] = x;
          if (y < min[1]) min[1] = y;
          if (y > max[1]) max[1] = y;
          if (z < min[2]) min[2] = z;
          if (z > max[2]) max[2] = z;
        } else if (c1 === 116 /* t */) {
          esito.coordinateTexture++;
        } else if (c1 === 110 /* n */) {
          esito.normali++;
        }
      } else if (c0 === 102 /* f */ && eSpazio(c1)) {
        let angoli = 0;
        let inToken = false;
        for (let i = 2; i < riga.length; i++) {
          const spazio = eSpazio(riga.charCodeAt(i));
          if (!spazio && !inToken) angoli++;
          inToken = !spazio;
        }
        if (angoli >= 3) {
          esito.facce++;
          esito.triangoli += angoli - 2;
          // Basta il primo vertice: "v", "v//n" → senza vt; "v/t" e "v/t/n" → con vt.
          let inizio = 2;
          while (inizio < riga.length && eSpazio(riga.charCodeAt(inizio))) inizio++;
          const barra = riga.indexOf('/', inizio);
          const fineToken = riga.slice(inizio).search(/\s/);
          const dentroToken = barra !== -1 && (fineToken === -1 || barra < inizio + fineToken);
          if (!dentroToken || riga.charCodeAt(barra + 1) === 47 /* / */ || eSpazio(riga.charCodeAt(barra + 1)) || barra + 1 >= riga.length) {
            esito.facceSenzaUv++;
          }
          if (materialeCorrente !== null) {
            esito.materiali.set(materialeCorrente, (esito.materiali.get(materialeCorrente) ?? 0) + 1);
          }
        }
      } else if (c0 === 117 /* u */ && riga.startsWith('usemtl')) {
        materialeCorrente = riga.slice(6).trim();
        if (!esito.materiali.has(materialeCorrente)) esito.materiali.set(materialeCorrente, 0);
      } else if (c0 === 109 /* m */ && riga.startsWith('mtllib')) {
        for (const p of percorsiMtllib(riga.slice(6))) if (!esito.mtllib.includes(p)) esito.mtllib.push(p);
      } else if ((c0 === 111 /* o */ || c0 === 103) /* g */ && eSpazio(c1)) {
        esito.gruppi++;
      }
    },
    { suAvanzamento },
  );

  if (esito.vertici === 0) {
    esito.min = [0, 0, 0];
    esito.max = [0, 0, 0];
  }
  esito.dimensioni = [0, 1, 2].map((i) => esito.max[i] - esito.min[i]);
  esito.centro = [0, 1, 2].map((i) => (esito.max[i] + esito.min[i]) / 2);
  esito.massimoAssoluto = Math.max(...esito.min.map(Math.abs), ...esito.max.map(Math.abs));
  esito.georeferenziate = esito.massimoAssoluto > SOGLIA_GEOREFERENZIATE;
  return esito;
}

/** Arrotonda al micrometro: basta e avanza, e tiene corte le righe del file temporaneo. */
function formatta(valore) {
  return String(Math.round(valore * 1e6) / 1e6);
}

/**
 * Scrive una copia dell'OBJ con i vertici traslati di -offset (calcolo in doppia precisione).
 * Le righe `mtllib` vengono riscritte con percorsi assoluti, così il file temporaneo può
 * stare in un'altra cartella e continuare a trovare MTL e texture originali; con
 * `mtlSostitutivi` (percorso assoluto originale → nuovo) puntano invece ai MTL riscritti.
 */
export async function traslaObj(sorgente, destinazione, offset, { suAvanzamento, mtlSostitutivi } = {}) {
  const cartellaObj = path.dirname(sorgente);
  const [ox, oy, oz] = offset;
  const uscita = fs.createWriteStream(destinazione, { highWaterMark: 4 * 1024 * 1024 });
  const erroreUscita = new Promise((_, rifiuta) => uscita.once('error', rifiuta));
  erroreUscita.catch(() => {});
  let pezzi = [];

  const svuota = async () => {
    if (pezzi.length === 0) return;
    const testo = pezzi.join('\n') + '\n';
    pezzi = [];
    if (!uscita.write(testo)) {
      await Promise.race([new Promise((risolvi) => uscita.once('drain', risolvi)), erroreUscita]);
    }
  };

  await perOgniRiga(
    sorgente,
    (riga) => {
      const pulita = eSpazio(riga.charCodeAt(0)) ? riga.trimStart() : riga;
      if (pulita.charCodeAt(0) === 118 /* v */ && eSpazio(pulita.charCodeAt(1))) {
        const t = pulita.split(SPAZI);
        const x = Number(t[1]);
        const y = Number(t[2]);
        const z = Number(t[3]);
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
          const extra = t.slice(4).filter(Boolean);
          pezzi.push(
            `v ${formatta(x - ox)} ${formatta(y - oy)} ${formatta(z - oz)}${extra.length ? ` ${extra.join(' ')}` : ''}`,
          );
          return;
        }
      } else if (pulita.startsWith('mtllib')) {
        const assoluti = percorsiMtllib(pulita.slice(6))
          .map((p) => risolviMtl(p, cartellaObj))
          .map((p) => mtlSostitutivi?.get(p) ?? p);
        pezzi.push(`mtllib ${assoluti.join(' ')}`);
        return;
      }
      pezzi.push(riga);
    },
    { suAvanzamento, dopoBlocco: svuota },
  );
  await svuota();
  await Promise.race([new Promise((risolvi) => uscita.end(risolvi)), erroreUscita]);
}

const CHIAVI_TEXTURE = new Set([
  'map_kd', 'map_ka', 'map_ks', 'map_ke', 'map_ns', 'map_d', 'map_bump', 'bump', 'norm', 'disp', 'refl',
]);
const OPZIONI_TEXTURE = /-(bm|t|s|o|blendu|blendv|boost|mm|texres|clamp|imfchan|type)/;

/** Risolve il nome di una texture come fa obj2gltf (opzioni "-o …" tolte, backslash → slash). */
function risolviTexture(valore, cartellaMtl) {
  let riferimento = valore.trim().replace(/^"(.+)"$/, '$1');
  if (OPZIONI_TEXTURE.test(riferimento)) riferimento = riferimento.split(/\s+/).pop();
  riferimento = riferimento.replace(/\\/g, '/');
  return { riferimento, percorso: path.normalize(path.resolve(cartellaMtl, riferimento)) };
}

/**
 * Copia di un MTL in cui ogni texture punta al file indicato da `textureSostitutive`
 * (percorso assoluto originale → nuovo percorso assoluto); le altre diventano assolute.
 * Serve a far leggere a obj2gltf le texture già ridotte, invece degli atlanti originali.
 */
export async function riscriviMtl(percorso, destinazione, textureSostitutive) {
  const cartella = path.dirname(percorso);
  const righe = (await fs.promises.readFile(percorso, 'utf8')).split(/\r?\n/).map((grezza) => {
    const riga = grezza.trim();
    const spazio = riga.search(/\s/);
    if (spazio === -1) return grezza;
    const chiave = riga.slice(0, spazio);
    if (!CHIAVI_TEXTURE.has(chiave.toLowerCase())) return grezza;
    const { percorso: originale } = risolviTexture(riga.slice(spazio + 1), cartella);
    return `${chiave} ${textureSostitutive.get(originale) ?? originale}`;
  });
  await fs.promises.writeFile(destinazione, righe.join('\n'));
}

/** Legge un MTL: materiali, opacità e texture referenziate (con verifica di esistenza). */
export async function analizzaMtl(percorso) {
  const cartella = path.dirname(percorso);
  const materiali = [];
  let corrente = null;
  const testo = await fs.promises.readFile(percorso, 'utf8');
  for (const grezza of testo.split(/\r?\n/)) {
    const riga = grezza.trim();
    if (!riga || riga.startsWith('#')) continue;
    const spazio = riga.search(/\s/);
    const chiave = (spazio === -1 ? riga : riga.slice(0, spazio)).toLowerCase();
    const valore = spazio === -1 ? '' : riga.slice(spazio + 1).trim();
    if (chiave === 'newmtl') {
      corrente = { nome: valore, opacita: 1, texture: [] };
      materiali.push(corrente);
    } else if (!corrente) {
      continue;
    } else if (chiave === 'd') {
      corrente.opacita = Number(valore);
    } else if (chiave === 'tr') {
      corrente.opacita = 1 - Number(valore);
    } else if (CHIAVI_TEXTURE.has(chiave) && valore) {
      const { riferimento, percorso: percorsoTexture } = risolviTexture(valore, cartella);
      corrente.texture.push({
        chiave,
        riferimento,
        percorso: percorsoTexture,
        esiste: fs.existsSync(percorsoTexture),
      });
    }
  }
  const tutte = new Map();
  for (const m of materiali) for (const t of m.texture) tutte.set(t.percorso, t);
  return { percorso, materiali, texture: [...tutte.values()], mancanti: [...tutte.values()].filter((t) => !t.esiste) };
}
