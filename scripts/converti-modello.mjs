#!/usr/bin/env node
// Conversione riproducibile di un rilievo WebODM (OBJ + MTL + texture) nel GLB del sito:
// asse Y in alto, centrato, appoggiato a Y = 0, in SCALA DA PLASTICO, texture
// ridimensionate e geometria compressa (Draco o Meshopt). Poi genera il poster.
//
//   node scripts/converti-modello.mjs <slug> [opzioni]      (--help per l'elenco)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import obj2gltf from 'obj2gltf';
import sharp from 'sharp';
import { dedup, draco, join, meshopt, prune, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import {
  analizzaMtl,
  analizzaObj,
  riscriviMtl,
  risolviMtl,
  SOGLIA_TRASLAZIONE,
  traslaObj,
} from './lib/obj.mjs';
import {
  calcolaNormaliMorbide,
  creaIO,
  leggiJsonGlb,
  mancanoNormali,
  orientaCentraScala,
  preparaMateriali,
  statistiche,
} from './lib/gltf.mjs';
import {
  cartellaModello,
  CARTELLA_SORGENTI,
  controllaSlug,
  nomeDaSlug,
  registraPulizia,
  relativo,
  SCALA_AR_PREDEFINITA,
  scriviAtomico,
  trovaOpera,
} from './lib/progetto.mjs';
import {
  allarme,
  avvia,
  avviso,
  compatto,
  creaAvanzamento,
  decimale,
  ErroreUtente,
  erroreArgomenti,
  info,
  intero,
  mb,
  ok,
  stile,
  titolo,
  voce,
} from './lib/terminale.mjs';

// Soglie di peso del GLB (MB decimali) e limiti delle piattaforme.
const SOGLIA_GIALLA = 10e6;
const SOGLIA_ROSSA = 15e6;
const LIMITE_CLOUDFLARE = 25 * 1024 * 1024; // 25 MiB per file su Cloudflare Pages
const LIMITE_GITHUB = 100 * 1024 * 1024; // GitHub rifiuta i file oltre 100 MiB

// Quantizzazione Draco/Meshopt. Posizioni: 14 bit sull'intera scena = 1/16384 del lato
// maggiore (per un edificio di 60 m: 3,7 mm; per il plastico da 35 cm: 0,02 mm), ben sotto
// il rumore della fotogrammetria. La griglia è unica per tutta la scena, così le mesh dei
// diversi atlanti restano saldate lungo i bordi (con una griglia per mesh si aprono fessure).
const BIT_POSIZIONI = 14;
const BIT_NORMALI = 10;

const AIUTO = `
Uso: node scripts/converti-modello.mjs <slug> [opzioni]

Converte l'export di WebODM (OBJ + MTL + texture) in public/opere/<slug>/modello/modello.glb
e genera poster.jpg e anteprima-social.jpg.

Opzioni:
  --obj <percorso>              OBJ da convertire (predefinito: il primo *_geo.obj in sorgenti/<slug>/)
  --texture <1024|2048|4096>    lato massimo delle texture in pixel (predefinito 2048)
  --formato-texture <jpeg|webp> formato delle texture (predefinito jpeg, il più compatibile)
  --qualita <1-100>             qualità di compressione delle texture (predefinito 85)
  --compressione <draco|meshopt> compressione della geometria (predefinito draco)
  --asse-su <z|y>               asse verticale dell'OBJ (predefinito z, come WebODM)
  --rotazione <gradi>           rotazione attorno alla verticale, antioraria vista dall'alto.
                                Senza rotazione è "di fronte" la facciata rivolta a SUD
                                (OBJ georeferenziato di WebODM: X = est, Y = nord).
                                90 → fronte a OVEST, -90 → EST, 180 → NORD.
  --scala-cm <n>                lato maggiore della base in AR, in cm (predefinito: "scalaAR"
                                dell'opera in data/opere.json, altrimenti ${SCALA_AR_PREDEFINITA})
  --materiale <tipo>            emissivo (predefinito) | unlit | pbr — vedi sotto
  --unlit                       come --materiale unlit
  --illuminato                  come --materiale pbr
  --uscita <cartella>           scrive lì modello.glb e i poster, invece che in public/opere/<slug>/modello/
  --nome "<nome>"               nome dell'opera (se non è ancora in data/opere.json)
  --senza-poster                non generare poster e anteprima social
  -h, --help                    mostra questo aiuto

Materiali (le luci del rilievo sono già nelle texture, non vanno illuminate di nuovo):
  emissivo  aspetto "unlit" (con tone-mapping="none" nella pagina: pixel = texture) ma
            compatibile con AR Quick Look su iPhone quando manca un USDZ: model-viewer
            converte il GLB al volo e il convertitore scarta i materiali unlit
            (il modello sparirebbe).
  unlit     KHR_materials_unlit puro: usalo solo se fornisci anche un file USDZ.
  pbr       materiale illuminato dalla scena (ombre e luci si sommano a quelle cotte).

Esempi:
  node scripts/converti-modello.mjs masseria-san-domenico
  node scripts/converti-modello.mjs masseria-san-domenico --rotazione -90 --scala-cm 40
  node scripts/converti-modello.mjs prova --obj ~/Scaricati/odm_texturing/odm_textured_model_geo.obj --senza-poster

Modelli molto grandi: le texture vengono ridotte PRIMA della conversione, quindi la memoria
dipende soprattutto dai triangoli (circa 0,5 GB ogni milione). Oltre i 5–6 milioni di triangoli
conviene decimare prima in Blender (o ridurre "mesh-size" in WebODM): il GLB finale, per stare
sotto i 15 MB, ne conterrà comunque molti meno.
`;

function leggiOpzioni(grezzi) {
  // parseArgs scambierebbe "-90" per un'opzione: "--rotazione -90" diventa "--rotazione=-90".
  const argomenti = [];
  for (let i = 0; i < grezzi.length; i++) {
    if (grezzi[i] === '--rotazione' && /^-\d/.test(grezzi[i + 1] ?? '')) argomenti.push(`--rotazione=${grezzi[++i]}`);
    else argomenti.push(grezzi[i]);
  }
  let letti;
  try {
    letti = parseArgs({
      args: argomenti,
      allowPositionals: true,
      strict: true,
      options: {
        obj: { type: 'string' },
        texture: { type: 'string', default: '2048' },
        'formato-texture': { type: 'string', default: 'jpeg' },
        qualita: { type: 'string', default: '85' },
        compressione: { type: 'string', default: 'draco' },
        'asse-su': { type: 'string', default: 'z' },
        rotazione: { type: 'string', default: '0' },
        'scala-cm': { type: 'string' },
        materiale: { type: 'string' },
        unlit: { type: 'boolean', default: false },
        illuminato: { type: 'boolean', default: false },
        uscita: { type: 'string' },
        nome: { type: 'string' },
        'senza-poster': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (errore) {
    throw erroreArgomenti(errore);
  }
  const { values: v, positionals } = letti;
  if (v.help) return { aiuto: true };
  if (positionals.length !== 1) {
    throw new ErroreUtente('indica uno (e un solo) slug, es.: node scripts/converti-modello.mjs masseria-san-domenico', {
      suggerimento: AIUTO,
    });
  }

  const scegli = (nome, valore, ammessi) => {
    const minuscolo = String(valore).toLowerCase();
    if (!ammessi.includes(minuscolo)) {
      throw new ErroreUtente(`--${nome} accetta solo: ${ammessi.join(', ')} (ricevuto "${valore}")`);
    }
    return minuscolo;
  };
  const numero = (nome, valore, { min, max, intero: soloInteri = false }) => {
    const n = Number(valore);
    if (!Number.isFinite(n) || n < min || n > max || (soloInteri && !Number.isInteger(n))) {
      throw new ErroreUtente(`--${nome} deve essere un numero${soloInteri ? ' intero' : ''} fra ${min} e ${max} (ricevuto "${valore}")`);
    }
    return n;
  };

  if ([v.unlit, v.illuminato, v.materiale !== undefined].filter(Boolean).length > 1) {
    throw new ErroreUtente('usa una sola fra --materiale, --unlit e --illuminato');
  }
  const materiale = v.unlit ? 'unlit' : v.illuminato ? 'pbr' : scegli('materiale', v.materiale ?? 'emissivo', ['emissivo', 'unlit', 'pbr']);

  return {
    slug: controllaSlug(positionals[0]),
    obj: v.obj ? path.resolve(v.obj) : null,
    lato: Number(scegli('texture', v.texture, ['1024', '2048', '4096'])),
    formatoTexture: scegli('formato-texture', v['formato-texture'], ['jpeg', 'webp']),
    qualita: numero('qualita', v.qualita, { min: 1, max: 100, intero: true }),
    compressione: scegli('compressione', v.compressione, ['draco', 'meshopt']),
    asseSu: scegli('asse-su', v['asse-su'], ['z', 'y']),
    rotazione: numero('rotazione', v.rotazione, { min: -360, max: 360 }),
    scalaCm: v['scala-cm'] === undefined ? null : numero('scala-cm', v['scala-cm'], { min: 1, max: 500 }),
    materiale,
    uscita: v.uscita ? path.resolve(v.uscita) : null,
    nome: v.nome ?? null,
    senzaPoster: v['senza-poster'],
  };
}

/** Elenca ricorsivamente i file .obj di una cartella (salta le cartelle nascoste). */
function elencaObj(cartella) {
  const trovati = [];
  const visita = (dir) => {
    for (const voceDir of fs.readdirSync(dir, { withFileTypes: true })) {
      if (voceDir.name.startsWith('.')) continue;
      const completo = path.join(dir, voceDir.name);
      if (voceDir.isDirectory()) visita(completo);
      else if (voceDir.isFile() && voceDir.name.toLowerCase().endsWith('.obj')) trovati.push(completo);
    }
  };
  visita(cartella);
  return trovati;
}

/** Sceglie l'OBJ: preferisce *_geo.obj (georeferenziato, orientato a nord), poi odm_texturing/. */
function scegliObj(slug, esplicito) {
  if (esplicito) {
    if (!fs.existsSync(esplicito) || !fs.statSync(esplicito).isFile()) {
      throw new ErroreUtente(`file OBJ non trovato: ${esplicito}`);
    }
    return { scelto: esplicito, alternative: [] };
  }
  const cartella = path.join(CARTELLA_SORGENTI, slug);
  if (!fs.existsSync(cartella)) {
    throw new ErroreUtente(`cartella dei sorgenti non trovata: ${relativo(cartella)}/`, {
      suggerimento:
        `Scarica da WebODM il "Textured Model" (o all.zip), estrailo in sorgenti/${slug}/\n` +
        'oppure indica il file con --obj <percorso>. Istruzioni: sorgenti/LEGGIMI.md',
    });
  }
  const tutti = elencaObj(cartella);
  if (tutti.length === 0) throw new ErroreUtente(`nessun file .obj in ${relativo(cartella)}/ (anche nelle sottocartelle)`);
  const punteggio = (p) => {
    const nome = path.basename(p).toLowerCase();
    return (nome.endsWith('_geo.obj') ? 0 : 2) + (p.split(path.sep).includes('odm_texturing') ? 0 : 1);
  };
  const ordinati = [...tutti].sort((a, b) => punteggio(a) - punteggio(b) || a.length - b.length || a.localeCompare(b));
  return { scelto: ordinati[0], alternative: ordinati.slice(1) };
}

/** Controlli preliminari su OBJ, MTL e texture. Restituisce l'analisi e l'elenco dei file del dataset. */
async function controllaSorgenti(percorsoObj) {
  const avanzamento = creaAvanzamento('Lettura OBJ');
  const analisi = await analizzaObj(percorsoObj, { suAvanzamento: (f) => avanzamento.aggiorna(f) });
  avanzamento.fine();

  if (analisi.vertici === 0 || analisi.facce === 0) {
    throw new ErroreUtente(`l'OBJ non contiene geometria (vertici: ${analisi.vertici}, facce: ${analisi.facce}): ${percorsoObj}`);
  }
  if (analisi.coordinateTexture === 0) {
    throw new ErroreUtente('l\'OBJ non ha coordinate texture (righe "vt"): il modello sarebbe senza colori. Serve il "Textured Model" di WebODM.');
  }
  if (analisi.mtllib.length === 0) {
    throw new ErroreUtente('l\'OBJ non dichiara nessun file di materiali (riga "mtllib"): mancherebbero le texture.');
  }

  const cartellaObj = path.dirname(percorsoObj);
  const mtl = [];
  for (const riferimento of analisi.mtllib) {
    const percorso = risolviMtl(riferimento, cartellaObj);
    if (!fs.existsSync(percorso)) {
      throw new ErroreUtente(`file dei materiali "${riferimento}" non trovato (cercato in ${percorso}).`);
    }
    mtl.push(await analizzaMtl(percorso));
  }
  const mancanti = mtl.flatMap((m) => m.mancanti);
  if (mancanti.length > 0) {
    const elenco = mancanti.slice(0, 10).map((t) => `    - ${t.riferimento}  (${t.percorso})`).join('\n');
    throw new ErroreUtente(
      `${mancanti.length === 1 ? 'manca 1 texture referenziata' : `mancano ${mancanti.length} texture referenziate`} dai materiali:\n${elenco}` +
        (mancanti.length > 10 ? `\n    … e altre ${mancanti.length - 10}` : ''),
      { suggerimento: 'Estrai TUTTO il contenuto dell\'archivio di WebODM mantenendo la cartella odm_texturing/ intatta.' },
    );
  }
  const definiti = new Set(mtl.flatMap((m) => m.materiali.map((x) => x.nome)));
  const nonDefiniti = [...analisi.materiali.keys()].filter((nome) => !definiti.has(nome));
  const texture = mtl.flatMap((m) => m.texture);
  const byteSorgenti =
    analisi.byte +
    mtl.reduce((s, m) => s + fs.statSync(m.percorso).size, 0) +
    texture.reduce((s, t) => s + fs.statSync(t.percorso).size, 0);
  return { analisi, mtl, texture, nonDefiniti, byteSorgenti };
}

function arrotondaRapporto(n) {
  if (n < 10) return decimale(n, 1);
  const cifre = Math.pow(10, Math.floor(Math.log10(n)) - 1);
  return intero(Math.round(n / cifre) * cifre);
}

function tempo(ms) {
  return ms < 1000 ? `${ms} ms` : `${decimale(ms / 1000, 1)} s`;
}

async function principale() {
  const opzioni = leggiOpzioni(process.argv.slice(2));
  if (opzioni.aiuto) {
    console.log(AIUTO);
    return 0;
  }
  const { slug } = opzioni;
  const inizio = Date.now();
  const opera = trovaOpera(slug);
  const scalaCm = opzioni.scalaCm ?? opera?.scalaAR ?? SCALA_AR_PREDEFINITA;
  const cartellaUscita = opzioni.uscita ?? cartellaModello(slug);
  const fileGlb = path.join(cartellaUscita, 'modello.glb');
  const nome = opera?.nome ?? opzioni.nome ?? nomeDaSlug(slug);

  titolo(`Conversione di "${slug}"`);
  voce('Opera in data/opere.json', opera ? `sì ("${opera.nome}")` : 'no (a fine lavoro stampo lo snippet da aggiungere)');
  voce('Scala AR (lato base)', `${decimale(scalaCm)} cm${opzioni.scalaCm ? ' (da --scala-cm)' : opera ? ' (scalaAR dell\'opera)' : ' (predefinita)'}`);
  voce('Materiale', opzioni.materiale);
  voce('Texture', `max ${opzioni.lato} px, ${opzioni.formatoTexture.toUpperCase()} qualità ${opzioni.qualita}`);
  voce('Compressione geometria', opzioni.compressione === 'draco' ? 'Draco (KHR_draco_mesh_compression)' : 'Meshopt (EXT_meshopt_compression)');
  voce('Uscita', relativo(fileGlb));
  if (opzioni.lato === 4096) avviso('texture a 4096 px: il GLB pesa circa 4 volte di più in texture. Usala solo se serve davvero.');
  if (opzioni.formatoTexture === 'webp') {
    avviso('texture WebP (EXT_texture_webp): ok per model-viewer e iOS, supporto in Scene Viewer (Android) non documentato.');
  }
  if (opzioni.compressione === 'meshopt') {
    avviso(
      'Meshopt: model-viewer lo decodifica solo se la pagina imposta ModelViewerElement.meshoptDecoderLocation; ' +
        'supporto in Scene Viewer (Android) non documentato. Draco è la scelta sicura.',
    );
  }

  // 1. Controlli preliminari -------------------------------------------------------------
  titolo('1. Controllo dei sorgenti');
  const { scelto: percorsoObj, alternative } = scegliObj(slug, opzioni.obj);
  voce('OBJ', relativo(percorsoObj));
  if (alternative.length) info(stile.tenue(`(altri OBJ ignorati: ${alternative.map((a) => path.basename(a)).join(', ')})`));
  const { analisi, mtl, texture, nonDefiniti, byteSorgenti } = await controllaSorgenti(percorsoObj);
  voce('Vertici / triangoli', `${compatto(analisi.vertici)} / ${compatto(analisi.triangoli)}`);
  voce('Normali nell\'OBJ', analisi.normali > 0 ? 'sì' : 'no');
  voce('Materiali (usemtl)', intero(analisi.materiali.size));
  voce('MTL', mtl.map((m) => path.basename(m.percorso)).join(', '));
  voce('Texture', `${texture.length} file, tutti presenti`);
  voce('Peso dei sorgenti', mb(byteSorgenti));
  const d = analisi.dimensioni;
  voce('Ingombro originale', `${decimale(d[0])} × ${decimale(d[1])} × ${decimale(d[2])} (unità dell'OBJ, di solito metri)`);
  if (nonDefiniti.length) avviso(`materiali usati ma non definiti nel MTL (resteranno grigi): ${nonDefiniti.join(', ')}`);
  if (analisi.facceSenzaUv > 0) {
    const quota = (analisi.facceSenzaUv / analisi.facce) * 100;
    avviso(
      `${intero(analisi.facceSenzaUv)} facce su ${intero(analisi.facce)} (${decimale(quota, quota < 1 ? 2 : 1)}%) senza coordinate texture: ` +
        'resteranno di un grigio neutro. Se sono molte, controlla l\'export di WebODM.',
    );
  }
  // Memoria: misurata ~0,5 GB per milione di triangoli (texture già ridotte, vedi passo 2).
  const memoriaStimata = analisi.triangoli * 550;
  if (memoriaStimata > os.totalmem() * 0.6) {
    avviso(
      `${compatto(analisi.triangoli)} triangoli: la conversione può richiedere circa ${decimale(memoriaStimata / 1e9, 1)} GB di memoria, ` +
        `molti per questo computer (${decimale(os.totalmem() / 1e9, 0)} GB). Se si blocca o è lentissima, decima prima in Blender.`,
    );
  }
  const latoOriginale = Math.max(...d);
  if (latoOriginale > 2000 || latoOriginale < 0.5) {
    avviso(`l'ingombro (${decimale(latoOriginale)}) non sembra un edificio in metri: il rapporto di scala stampato alla fine potrebbe non avere senso.`);
  }
  ok('sorgenti completi');

  const temporanea = await fs.promises.mkdtemp(path.join(os.tmpdir(), '3db-conversione-'));
  // Anche con Ctrl-C: l'OBJ traslato può pesare GB.
  const togliPulizia = registraPulizia(() => fs.rmSync(temporanea, { recursive: true, force: true }));
  try {
    // 2. Texture: ridotte e senza alfa PRIMA di obj2gltf ---------------------------------------
    // obj2gltf carica in memoria ogni texture a piena risoluzione (gli atlanti di WebODM arrivano
    // a 8192 px): ridurle qui abbassa di molto la memoria. Il canale alfa va tolto adesso perché
    // la conversione in JPEG lo appiattirebbe sul nero (bordi delle isole UV scuri), mentre il
    // materiale del sito è opaco e deve mostrare il colore così com'è.
    titolo('2. Texture');
    const mtlSostitutivi = await preparaTexture({ texture, mtl, temporanea, lato: opzioni.lato });

    // Traslazione delle coordinate georeferenziate ---------------------------------------------
    let objDaConvertire = percorsoObj;
    let offset = [0, 0, 0];
    if (analisi.massimoAssoluto > SOGLIA_TRASLAZIONE) {
      titolo('2b. Traslazione delle coordinate (in doppia precisione)');
      offset = analisi.centro;
      info(`Coordinate fino a ${intero(analisi.massimoAssoluto)}: in float32 perderebbero precisione`);
      info(`(passo di ${decimale(Math.pow(2, Math.floor(Math.log2(analisi.massimoAssoluto)) - 23) * 100, 1)} cm). Sottraggo il centro del modello:`);
      voce('Offset', offset.map((x) => decimale(x, 3)).join(', '));
      objDaConvertire = path.join(temporanea, 'traslato.obj');
      const t0 = Date.now();
      const avanzamento = creaAvanzamento('Traslazione');
      await traslaObj(percorsoObj, objDaConvertire, offset, { suAvanzamento: (f) => avanzamento.aggiorna(f), mtlSostitutivi });
      avanzamento.fine();
      ok(`OBJ temporaneo scritto in ${tempo(Date.now() - t0)} (verrà cancellato alla fine)`);
    } else {
      titolo('2b. Traslazione delle coordinate');
      info(`non serve: coordinate entro ±${intero(SOGLIA_TRASLAZIONE)} (massimo ${decimale(analisi.massimoAssoluto)}).`);
      if (mtlSostitutivi.size > 0) {
        // Serve comunque una copia dell'OBJ che punti ai MTL con le texture ridotte.
        objDaConvertire = path.join(temporanea, 'riferimenti.obj');
        const avanzamento = creaAvanzamento('Copia OBJ');
        await traslaObj(percorsoObj, objDaConvertire, [0, 0, 0], { suAvanzamento: (f) => avanzamento.aggiorna(f), mtlSostitutivi });
        avanzamento.fine();
      }
    }

    // 3. OBJ → GLB con obj2gltf ---------------------------------------------------------------
    titolo('3. OBJ → glTF (obj2gltf)');
    info(`asse verticale dell'OBJ: ${opzioni.asseSu.toUpperCase()} → Y del glTF. Può richiedere qualche minuto sui modelli grandi…`);
    const messaggi = [];
    const t1 = Date.now();
    let glbGrezzo;
    try {
      glbGrezzo = await obj2gltf(objDaConvertire, {
        binary: true,
        inputUpAxis: opzioni.asseSu.toUpperCase(),
        outputUpAxis: 'Y',
        checkTransparency: false,
        logger: (m) => messaggi.push(m),
      });
    } catch (errore) {
      throw new ErroreUtente(`obj2gltf non è riuscito a convertire l'OBJ: ${errore.message}`);
    }
    for (const m of messaggi) avviso(`obj2gltf: ${m}`);
    ok(`glTF intermedio: ${mb(glbGrezzo.byteLength)} in ${tempo(Date.now() - t1)}`);

    // 4. Ottimizzazione con glTF-Transform ------------------------------------------------------
    titolo('4. Ottimizzazione (glTF-Transform)');
    const t2 = Date.now();
    const io = await creaIO();
    const doc = await io.readBinary(new Uint8Array(glbGrezzo.buffer, glbGrezzo.byteOffset, glbGrezzo.byteLength));
    glbGrezzo = null; // libera memoria

    for (const nota of preparaMateriali(doc, opzioni.materiale)) avviso(nota);
    await doc.transform(dedup());
    const trasformazione = await orientaCentraScala(doc, { rotazioneGradi: opzioni.rotazione, latoBaseMetri: scalaCm / 100 });
    await doc.transform(join({ keepNamed: false }), weld(), prune());
    if (opzioni.materiale !== 'unlit' && mancanoNormali(doc)) {
      info('l\'OBJ non ha normali: le calcolo (servono ai materiali illuminati e all\'USDZ di iOS).');
      calcolaNormaliMorbide(doc);
    }
    ok(`materiali "${opzioni.materiale}", orientamento, centratura e scala applicati`);

    info(`texture: ridimensiono a max ${opzioni.lato} px e converto in ${opzioni.formatoTexture.toUpperCase()}…`);
    try {
      await doc.transform(
        textureCompress({
          encoder: sharp,
          targetFormat: opzioni.formatoTexture,
          resize: [opzioni.lato, opzioni.lato],
          quality: opzioni.qualita,
          limitInputPixels: false,
        }),
      );
    } catch (errore) {
      throw new ErroreUtente(`compressione delle texture non riuscita: ${errore.message}`);
    }

    // UV: bit = log2(lato) + 2 → errore massimo 1/8 di texel. Con meno bit, sugli atlanti
    // grandi le coordinate "scivolano" oltre i bordi delle isole e compaiono cuciture.
    const bitUV = Math.round(Math.log2(opzioni.lato)) + 2;
    if (opzioni.compressione === 'draco') {
      await doc.transform(
        draco({
          method: 'edgebreaker',
          encodeSpeed: 5,
          decodeSpeed: 5,
          quantizePosition: BIT_POSIZIONI,
          quantizeNormal: BIT_NORMALI,
          quantizeTexcoord: bitUV,
          quantizationVolume: 'scene',
        }),
      );
    } else {
      await MeshoptEncoder.ready;
      await doc.transform(
        meshopt({
          encoder: MeshoptEncoder,
          level: 'high',
          quantizePosition: BIT_POSIZIONI,
          quantizeNormal: BIT_NORMALI,
          quantizeTexcoord: bitUV,
          quantizationVolume: 'scene',
        }),
      );
    }
    info(`quantizzazione: posizioni ${BIT_POSIZIONI} bit (griglia unica sulla scena), UV ${bitUV} bit, normali ${BIT_NORMALI} bit`);

    const glb = await io.writeBinary(doc);
    await scriviAtomico(fileGlb, glb);
    ok(`scritto ${relativo(fileGlb)} in ${tempo(Date.now() - t2)}`);

    // 5. Verifica rileggendo il file -----------------------------------------------------------
    titolo('5. Verifica del GLB (riletto da disco)');
    const riletto = await io.read(fileGlb);
    const s = statistiche(riletto);
    const json = leggiJsonGlb(new Uint8Array(fs.readFileSync(fileGlb)));
    const [min, max] = [s.bounds.min, s.bounds.max];
    const ampiezza = [0, 1, 2].map((i) => max[i] - min[i]);
    const latoBase = Math.max(ampiezza[0], ampiezza[2]);
    const byteGlb = fs.statSync(fileGlb).size;

    voce('Peso', `${mb(byteSorgenti)} (sorgenti) → ${stile.grassetto(mb(byteGlb))} (GLB)`);
    voce('Triangoli / vertici', `${compatto(s.triangoli)} / ${compatto(s.vertici)}`);
    voce('Texture', s.texture.map((t) => `${t.larghezza}×${t.altezza} ${t.mime.replace('image/', '')}`).join(', ') || 'nessuna');
    voce('Peso texture', mb(s.byteTexture));
    voce('Dimensioni in AR (L×P×H)', `${decimale(ampiezza[0] * 100, 1)} × ${decimale(ampiezza[2] * 100, 1)} × ${decimale(ampiezza[1] * 100, 1)} cm`);
    voce('Rapporto di scala', `≈ 1:${arrotondaRapporto(1 / trasformazione.scala)} (se l'OBJ è in metri)`);
    voce('Estensioni', (json.extensionsUsed ?? []).join(', ') || 'nessuna');

    const tolleranza = Math.max(latoBase * 2e-3, 1e-4);
    const controlli = [
      ['base appoggiata a Y = 0', Math.abs(min[1]) <= tolleranza, `min Y = ${decimale(min[1] * 1000, 3)} mm`],
      ['centrato in X', Math.abs((min[0] + max[0]) / 2) <= tolleranza, `centro X = ${decimale(((min[0] + max[0]) / 2) * 1000, 3)} mm`],
      ['centrato in Z', Math.abs((min[2] + max[2]) / 2) <= tolleranza, `centro Z = ${decimale(((min[2] + max[2]) / 2) * 1000, 3)} mm`],
      [`lato base = ${decimale(scalaCm)} cm`, Math.abs(latoBase - scalaCm / 100) <= tolleranza, `${decimale(latoBase * 100, 3)} cm`],
    ];
    for (const [descrizione, riuscito, dettaglio] of controlli) {
      if (riuscito) ok(`${descrizione} (${dettaglio})`);
      else avviso(`${descrizione}: NON verificato (${dettaglio})`);
    }

    // Peso: avvisi e proposta di decimazione.
    if (byteGlb > SOGLIA_ROSSA) {
      allarme(`il GLB pesa ${mb(byteGlb)}: sopra i 15 MB il caricamento su telefono è lento.`);
      consigliaDecimazione(s, byteGlb);
    } else if (byteGlb > SOGLIA_GIALLA) {
      avviso(`il GLB pesa ${mb(byteGlb)}: sopra i 10 MB. Accettabile, ma valuta una decimazione.`);
      consigliaDecimazione(s, byteGlb);
    } else {
      ok(`peso sotto i 10 MB`);
    }
    if (byteGlb > LIMITE_CLOUDFLARE) allarme(`supera il limite di 25 MiB per file di Cloudflare Pages: il deploy fallirebbe.`);
    if (byteGlb > LIMITE_GITHUB) allarme(`supera il limite di 100 MiB per file di GitHub: il push verrebbe rifiutato.`);

    // 6. Poster --------------------------------------------------------------------------------
    let esitoPoster = 0;
    if (!opzioni.senzaPoster) {
      titolo('6. Poster e anteprima social');
      try {
        const { generaPoster } = await import('./poster.mjs');
        await generaPoster({ glb: fileGlb, cartellaUscita, nome, localita: opera?.localita ?? null });
      } catch (errore) {
        // Il GLB è già scritto: un problema del browser non deve far perdere il resto del lavoro.
        avviso(`poster non generato: ${errore instanceof ErroreUtente ? errore.message : `il browser si è interrotto durante il rendering (${errore.message})`}`);
        if (errore.suggerimento) console.log(`\n${errore.suggerimento}\n`);
        info(`Il modello è pronto; quando il browser è disponibile lancia: node scripts/poster.mjs ${slug}${opzioni.uscita ? ` --uscita ${opzioni.uscita}` : ''}`);
        esitoPoster = errore.codice || 1;
      }
    }

    // 7. Dati dell'opera -----------------------------------------------------------------------
    titolo(opzioni.senzaPoster ? '6. data/opere.json' : '7. data/opere.json');
    stampaDatiOpera({ slug, opera, nome, scalaCm, opzioni });

    console.log(`\n${stile.verde(stile.grassetto('Fatto'))} in ${tempo(Date.now() - inizio)}.`);
    return esitoPoster;
  } finally {
    togliPulizia();
    await fs.promises.rm(temporanea, { recursive: true, force: true });
  }
}

/**
 * Riduce a `lato` px le texture più grandi e toglie il canale alfa, scrivendo PNG (senza
 * perdita) nella cartella temporanea, e riscrive i MTL perché puntino a queste copie.
 * Restituisce la mappa MTL originale → MTL riscritto (vuota se non serviva niente).
 */
async function preparaTexture({ texture, mtl, temporanea, lato }) {
  const uniche = [...new Map(texture.map((t) => [t.percorso, t])).values()];
  const daPreparare = [];
  for (const t of uniche) {
    const m = await sharp(t.percorso, { limitInputPixels: false }).metadata();
    const grande = Math.max(m.width ?? 0, m.height ?? 0) > lato;
    if (grande || m.hasAlpha) daPreparare.push({ ...t, grande, alfa: Boolean(m.hasAlpha), lato: Math.max(m.width, m.height) });
  }
  const mtlSostitutivi = new Map();
  if (daPreparare.length === 0) {
    info(`${uniche.length} texture già entro ${lato} px e senza alfa: nessuna preparazione.`);
    return mtlSostitutivi;
  }

  const cartella = path.join(temporanea, 'texture');
  await fs.promises.mkdir(cartella, { recursive: true });
  const sostituite = new Map();
  const t0 = Date.now();
  for (const [i, t] of daPreparare.entries()) {
    process.stdout.write(`\r  texture ${i + 1}/${daPreparare.length}…`);
    const nome = `${String(i + 1).padStart(3, '0')}-${path.basename(t.percorso).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_')}.png`;
    const uscita = path.join(cartella, nome);
    // Due passaggi separati: in un'unica pipeline sharp ridimensiona PRIMA di togliere l'alfa
    // (l'ordine delle chiamate non conta) e, per ridimensionare, moltiplica il colore per l'alfa:
    // i texel trasparenti diventerebbero neri.
    let sorgente = sharp(t.percorso, { limitInputPixels: false });
    if (t.alfa) {
      const opaca = await sorgente.removeAlpha().raw().toBuffer({ resolveWithObject: true });
      sorgente = sharp(opaca.data, { raw: opaca.info, limitInputPixels: false });
    }
    await sorgente
      .resize({ width: lato, height: lato, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
      .png({ compressionLevel: 1 })
      .toFile(uscita);
    sostituite.set(t.percorso, uscita);
  }
  process.stdout.write('\r');
  const ridotte = daPreparare.filter((t) => t.grande);
  const conAlfa = daPreparare.filter((t) => t.alfa);
  if (ridotte.length) {
    const massimo = Math.max(...ridotte.map((t) => t.lato));
    ok(`${ridotte.length} texture ridotte (fino a ${massimo} → ${lato} px) in ${tempo(Date.now() - t0)}`);
  }
  if (conAlfa.length) ok(`canale alfa tolto da ${conAlfa.length} texture (il modello è opaco)`);

  for (const [i, m] of mtl.entries()) {
    const nuovo = path.join(temporanea, `${String(i + 1).padStart(2, '0')}-${path.basename(m.percorso)}`);
    await riscriviMtl(m.percorso, nuovo, sostituite);
    mtlSostitutivi.set(m.percorso, nuovo);
  }
  return mtlSostitutivi;
}

/** Stima quanti triangoli tenere per stare sotto ~10 MB, dato il peso misurato per triangolo. */
function consigliaDecimazione(s, byteGlb) {
  const byteGeometria = Math.max(byteGlb - s.byteTexture, 1);
  const bytePerTriangolo = byteGeometria / Math.max(s.triangoli, 1);
  const budget = 9.5e6 - s.byteTexture;
  if (budget < 1e6) {
    info(
      `Le texture da sole pesano ${mb(s.byteTexture)}: prima di decimare riduci le texture ` +
        '(--texture 2048 o 1024, --qualita 80) o il numero di atlanti in WebODM.',
    );
    return;
  }
  const obiettivo = Math.floor(budget / bytePerTriangolo);
  if (obiettivo >= s.triangoli) return;
  const rapporto = Math.max(0.05, Math.floor((obiettivo / s.triangoli) * 20) / 20);
  info(
    `Proposta: in Blender, modificatore Decimate (Collapse) con Ratio ${decimale(rapporto)} ` +
      `porta i triangoli da ${compatto(s.triangoli)} a circa ${compatto(Math.round(s.triangoli * rapporto))} ` +
      `(qui la geometria compressa pesa ~${decimale(bytePerTriangolo, 1)} byte per triangolo).`,
  );
  info('In alternativa, in WebODM riduci l\'opzione "mesh-size" e rielabora.');
  info('Limiti per file: Cloudflare Pages 25 MiB, GitHub 100 MiB.');
}

function stampaDatiOpera({ slug, opera, nome, scalaCm, opzioni }) {
  if (opera) {
    ok(`l'opera "${slug}" è già in data/opere.json.`);
    if (opera.glb !== 'modello/modello.glb') {
      avviso(`nel file dati "glb" è "${opera.glb}", ma lo script scrive "modello/modello.glb": allinea il campo.`);
    }
    if (opera.scalaAR !== scalaCm) {
      avviso(`"scalaAR" nel file dati è ${opera.scalaAR}, il GLB è stato scalato a ${scalaCm} cm: aggiorna "scalaAR" a ${scalaCm}.`);
    }
    if (opzioni.materiale === 'unlit' && !opera.usdz) {
      avviso('materiale unlit senza "usdz": su iPhone il modello in AR risulterebbe vuoto. Riconverti senza --unlit o fornisci un USDZ.');
    }
    return;
  }
  const snippet = {
    slug,
    nome,
    localita: 'DA COMPILARE',
    anno: null,
    descrizione: 'DA COMPILARE',
    glb: 'modello/modello.glb',
    usdz: null,
    poster: 'modello/poster.jpg',
    anteprimaSocial: 'modello/anteprima-social.jpg',
    turntable: null,
    fotoPlastico: null,
    scalaAR: scalaCm,
    pubblicato: false,
  };
  info('L\'opera non è ancora in data/opere.json. Aggiungi questo oggetto all\'array (compila i campi');
  info('"DA COMPILARE" e metti "pubblicato": true quando è pronta):');
  console.log(`\n${JSON.stringify(snippet, null, 2).replace(/^/gm, '    ')}\n`);
}

avvia(principale);
