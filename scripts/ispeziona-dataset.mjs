#!/usr/bin/env node
// Primo passo di ogni nuovo rilievo: "ispeziona il dataset".
// Elenca i file, legge gli OBJ in streaming (anche da diversi GB), controlla MTL e
// texture, stima il peso del GLB finale e dà consigli (decimazione, texture).
//
//   node scripts/ispeziona-dataset.mjs <cartella-o-file> [--json]

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { analizzaMtl, analizzaObj, risolviMtl, SOGLIA_GEOREFERENZIATE, SOGLIA_TRASLAZIONE } from './lib/obj.mjs';
import { relativo } from './lib/progetto.mjs';
import {
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
  problema,
  stile,
  titolo,
  voce,
} from './lib/terminale.mjs';

// Coefficienti della stima (grossolana, ±50%): geometria Draco con UV e normali,
// texture JPEG qualità 85 di contenuto fotografico.
const BYTE_PER_TRIANGOLO = 4.5;
const BYTE_PER_PIXEL_JPEG = 0.25;
const TRIANGOLI_CONSIGLIATI = 800_000;
const TRIANGOLI_MOLTI = 1_500_000;

const FORMATI = {
  '.obj': 'mesh OBJ',
  '.mtl': 'materiali MTL',
  '.png': 'immagine PNG',
  '.jpg': 'immagine JPEG',
  '.jpeg': 'immagine JPEG',
  '.webp': 'immagine WebP',
  '.tif': 'immagine TIFF',
  '.tiff': 'immagine TIFF',
  '.glb': 'glTF binario',
  '.gltf': 'glTF',
  '.bin': 'dati binari glTF',
  '.ply': 'mesh/nuvola PLY',
  '.las': 'nuvola di punti LAS',
  '.laz': 'nuvola di punti LAZ',
  '.zip': 'archivio ZIP',
  '.json': 'JSON',
  '.geojson': 'GeoJSON',
  '.txt': 'testo',
  '.csv': 'CSV',
  '.usdz': 'USDZ',
  '.mp4': 'video',
  '.mov': 'video',
};
const IMMAGINI = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff']);
const MAX_PER_CARTELLA = 25;

function elencaFile(radice) {
  const file = [];
  const visita = (dir) => {
    let voci;
    try {
      voci = fs.readdirSync(dir, { withFileTypes: true });
    } catch (errore) {
      console.error(`cartella non leggibile: ${dir} (${errore.code})`);
      return;
    }
    for (const v of voci.sort((a, b) => a.name.localeCompare(b.name, 'it', { numeric: true }))) {
      if (v.name.startsWith('.') || v.name === 'node_modules') continue;
      const completo = path.join(dir, v.name);
      if (v.isDirectory()) visita(completo);
      else if (v.isFile()) file.push(completo);
    }
  };
  visita(radice);
  return file;
}

async function metadatiImmagine(percorso) {
  try {
    const m = await sharp(percorso, { limitInputPixels: false }).metadata();
    return { larghezza: m.width, altezza: m.height, canali: m.channels, alfa: Boolean(m.hasAlpha), formato: m.format };
  } catch (errore) {
    return { errore: errore.message };
  }
}

function stimaTexture(texture, lato) {
  return texture.reduce((somma, t) => {
    if (!t.larghezza || !t.altezza) return somma;
    const riduzione = Math.min(1, lato / Math.max(t.larghezza, t.altezza));
    return somma + t.larghezza * riduzione * t.altezza * riduzione * BYTE_PER_PIXEL_JPEG;
  }, 0);
}

async function ispeziona(bersaglio) {
  const stat = fs.statSync(bersaglio);
  const radice = stat.isDirectory() ? bersaglio : path.dirname(bersaglio);
  const fileBase = stat.isDirectory() ? elencaFile(bersaglio) : [bersaglio];

  // Per un singolo OBJ includiamo anche i suoi MTL e le texture (anche fuori cartella).
  const insieme = new Set(fileBase);
  const risultato = { bersaglio, file: [], obj: [], mtl: [], consigli: [] };
  const metadati = new Map();

  const analisiObj = [];
  for (const f of fileBase.filter((f) => f.toLowerCase().endsWith('.obj'))) {
    const avanzamento = creaAvanzamento(`Lettura ${path.basename(f)}`);
    const a = await analizzaObj(f, { suAvanzamento: (x) => avanzamento.aggiorna(x) });
    avanzamento.fine();
    a.percorsiMtl = a.mtllib.map((r) => ({ riferimento: r, percorso: risolviMtl(r, path.dirname(f)) }));
    for (const m of a.percorsiMtl) if (fs.existsSync(m.percorso)) insieme.add(m.percorso);
    analisiObj.push(a);
  }
  const analisiMtl = new Map();
  for (const f of [...insieme].filter((f) => f.toLowerCase().endsWith('.mtl'))) {
    const m = await analizzaMtl(f);
    analisiMtl.set(f, m);
    for (const t of m.texture) if (t.esiste) insieme.add(t.percorso);
  }

  for (const f of insieme) {
    const est = path.extname(f).toLowerCase();
    const voceFile = { percorso: f, relativo: path.relative(radice, f) || path.basename(f), byte: fs.statSync(f).size, formato: FORMATI[est] ?? (est ? est.slice(1).toUpperCase() : 'senza estensione') };
    if (IMMAGINI.has(est)) {
      voceFile.immagine = await metadatiImmagine(f);
      metadati.set(f, voceFile.immagine);
    }
    risultato.file.push(voceFile);
  }

  for (const [percorso, m] of analisiMtl) {
    risultato.mtl.push({
      percorso,
      materiali: m.materiali.length,
      texture: m.texture.map((t) => ({ riferimento: t.riferimento, percorso: t.percorso, esiste: t.esiste, chiave: t.chiave, ...(metadati.get(t.percorso) ?? {}) })),
      mancanti: m.mancanti.map((t) => t.riferimento),
      trasparenti: m.materiali.filter((x) => x.opacita < 1).map((x) => x.nome),
    });
  }

  for (const a of analisiObj) {
    const mtlDiObj = a.percorsiMtl.map((m) => ({ ...m, esiste: fs.existsSync(m.percorso) }));
    const texture = mtlDiObj
      .filter((m) => m.esiste)
      .flatMap((m) => analisiMtl.get(m.percorso)?.texture ?? [])
      .filter((t) => t.chiave === 'map_kd')
      .map((t) => ({ percorso: t.percorso, esiste: t.esiste, ...(metadati.get(t.percorso) ?? {}) }));
    const geometria = a.triangoli * BYTE_PER_TRIANGOLO;
    risultato.obj.push({
      percorso: a.percorso,
      byte: a.byte,
      vertici: a.vertici,
      facce: a.facce,
      facceSenzaUv: a.facceSenzaUv,
      triangoli: a.triangoli,
      coordinateTexture: a.coordinateTexture,
      normali: a.normali,
      coloriVertice: a.verticiConColore,
      gruppi: a.gruppi,
      materiali: Object.fromEntries(a.materiali),
      mtl: mtlDiObj,
      bbox: { min: a.min, max: a.max, dimensioni: a.dimensioni, centro: a.centro },
      massimoAssoluto: a.massimoAssoluto,
      georeferenziate: a.georeferenziate,
      traslazioneInConversione: a.massimoAssoluto > SOGLIA_TRASLAZIONE,
      righeIllegibili: a.righeIllegibili,
      textureDiffuse: texture,
      stimaGlb: {
        geometria,
        texture2048: stimaTexture(texture, 2048),
        texture4096: stimaTexture(texture, 4096),
        totale2048: geometria + stimaTexture(texture, 2048),
        totale4096: geometria + stimaTexture(texture, 4096),
      },
    });
  }

  risultato.consigli = consigli(risultato);
  return risultato;
}

function consigli(r) {
  const lista = [];
  const aggiungi = (livello, testo) => lista.push({ livello, testo });
  if (r.obj.length === 0) {
    if (r.file.some((f) => f.percorso.toLowerCase().endsWith('.zip'))) {
      aggiungi('rosso', 'nessun OBJ ma c\'è un archivio ZIP: estrailo (serve la cartella odm_texturing/).');
    } else {
      aggiungi('rosso', 'nessun file OBJ: in WebODM scarica "Textured Model" (o all.zip) e cerca odm_texturing/.');
    }
  }
  if (r.obj.length > 1) {
    const geo = r.obj.find((o) => o.percorso.toLowerCase().endsWith('_geo.obj'));
    aggiungi('info', `ci sono ${r.obj.length} OBJ: la conversione userà ${geo ? path.basename(geo.percorso) : 'il primo trovato'} (cambia con --obj).`);
  }
  for (const o of r.obj) {
    const nome = path.basename(o.percorso);
    if (o.coordinateTexture === 0) aggiungi('rosso', `${nome}: niente coordinate texture (vt): non è un modello texturizzato.`);
    else if (o.facceSenzaUv > 0) {
      aggiungi('giallo', `${nome}: ${intero(o.facceSenzaUv)} facce su ${intero(o.facce)} senza coordinate texture: nel sito resteranno di un grigio neutro.`);
    }
    if (o.mtl.length === 0) aggiungi('rosso', `${nome}: nessuna riga mtllib, mancherebbero i materiali.`);
    for (const m of o.mtl) if (!m.esiste) aggiungi('rosso', `${nome}: MTL "${m.riferimento}" non trovato.`);
    if (o.georeferenziate) {
      aggiungi('info', `${nome}: coordinate georeferenziate (fino a ${intero(o.massimoAssoluto)}): la conversione le trasla prima di obj2gltf, senza perdita di precisione.`);
    }
    if (o.triangoli > TRIANGOLI_MOLTI) {
      const rapporto = Math.max(0.05, Math.floor((TRIANGOLI_CONSIGLIATI / o.triangoli) * 20) / 20);
      aggiungi(
        'giallo',
        `${nome}: ${compatto(o.triangoli)} triangoli sono tanti per un telefono. Decima in Blender (Decimate, Ratio ${decimale(rapporto)} → circa ${compatto(Math.round(o.triangoli * rapporto))}) o riduci "mesh-size" in WebODM.`,
      );
    }
    const t = o.stimaGlb.totale2048;
    if (t > 15e6) aggiungi('rosso', `${nome}: GLB stimato ~${mb(t)} con texture a 2048 px: sopra i 15 MB, serve alleggerire.`);
    else if (t > 10e6) aggiungi('giallo', `${nome}: GLB stimato ~${mb(t)} con texture a 2048 px: sopra i 10 MB.`);
    const grandi = o.textureDiffuse.filter((x) => Math.max(x.larghezza ?? 0, x.altezza ?? 0) > 2048).length;
    if (grandi > 0) {
      const testo = grandi === 1 ? '1 texture oltre 2048 px verrà ridotta' : `${grandi} texture oltre 2048 px verranno ridotte`;
      aggiungi('info', `${nome}: ${testo} (--texture 4096 per conservare più dettaglio).`);
    }
    if (o.textureDiffuse.length > 8) {
      aggiungi('giallo', `${nome}: ${o.textureDiffuse.length} atlanti di texture: ognuno pesa ~1 MB a 2048 px e aggiunge una chiamata di disegno.`);
    }
  }
  for (const m of r.mtl) {
    if (m.mancanti.length) aggiungi('rosso', `${path.basename(m.percorso)}: ${m.mancanti.length === 1 ? 'manca 1 texture' : `mancano ${m.mancanti.length} texture`} (${m.mancanti.slice(0, 3).join(', ')}${m.mancanti.length > 3 ? ', …' : ''}).`);
  }
  if (lista.every((c) => c.livello !== 'rosso') && r.obj.length > 0) aggiungi('ok', 'il dataset è convertibile.');
  return lista;
}

function stampa(r) {
  titolo(`Dataset: ${relativo(r.bersaglio)}`);
  const perCartella = new Map();
  for (const f of r.file) {
    const cartella = path.dirname(f.relativo);
    if (!perCartella.has(cartella)) perCartella.set(cartella, []);
    perCartella.get(cartella).push(f);
  }
  const totale = r.file.reduce((s, f) => s + f.byte, 0);
  info(`${intero(r.file.length)} file, ${mb(totale)} in totale`);
  for (const [cartella, file] of perCartella) {
    console.log(`\n  ${stile.grassetto(cartella === '.' ? './' : `${cartella}/`)}`);
    const visibili = file.length > MAX_PER_CARTELLA ? file.slice(0, 10) : file;
    for (const f of visibili) {
      const img = f.immagine;
      const dettaglio = img?.errore ? stile.rosso(`illeggibile: ${img.errore}`) : img ? `${img.larghezza}×${img.altezza}${img.alfa ? ' +alfa' : ''}` : '';
      console.log(`    ${path.basename(f.relativo).padEnd(44)} ${mb(f.byte).padStart(10)}  ${stile.tenue(f.formato.padEnd(18))} ${dettaglio}`);
    }
    if (file.length > visibili.length) {
      const resto = file.slice(visibili.length);
      console.log(stile.tenue(`    … altri ${resto.length} file (${mb(resto.reduce((s, f) => s + f.byte, 0))})`));
    }
  }

  for (const o of r.obj) {
    titolo(`OBJ: ${path.basename(o.percorso)}`);
    voce('Dimensione', mb(o.byte));
    voce('Vertici (v)', intero(o.vertici));
    voce('Facce (f)', `${intero(o.facce)} → ${intero(o.triangoli)} triangoli`);
    voce('Coordinate texture (vt)', o.coordinateTexture ? intero(o.coordinateTexture) : stile.rosso('assenti'));
    voce('Normali (vn)', o.normali ? intero(o.normali) : 'assenti (non servono al materiale predefinito)');
    if (o.coloriVertice) voce('Colori per vertice', intero(o.coloriVertice));
    const materiali = Object.entries(o.materiali);
    voce('Materiali (usemtl)', materiali.length ? `${materiali.length}: ${materiali.slice(0, 6).map(([n, f]) => `${n} (${compatto(f)} facce)`).join(', ')}${materiali.length > 6 ? ', …' : ''}` : 'nessuno');
    voce('MTL', o.mtl.map((m) => `${m.riferimento}${m.esiste ? '' : stile.rosso(' (MANCANTE)')}`).join(', ') || stile.rosso('nessuno'));
    const { min, max, dimensioni } = o.bbox;
    voce('Bounding box min', min.map((x) => decimale(x, 3)).join('   '));
    voce('Bounding box max', max.map((x) => decimale(x, 3)).join('   '));
    voce('Ampiezza X × Y × Z', `${dimensioni.map((x) => decimale(x, 2)).join(' × ')} (unità dell'OBJ, di solito metri)`);
    if (o.georeferenziate) {
      avviso(`coordinate georeferenziate (valori fino a ${intero(o.massimoAssoluto)} > ${intero(SOGLIA_GEOREFERENZIATE)}): in float32 si perde precisione.`);
      info('La conversione trasla automaticamente i vertici (in doppia precisione) prima di obj2gltf.');
    }
    if (o.righeIllegibili) avviso(`${intero(o.righeIllegibili)} righe "v" illeggibili`);
    voce('Texture diffuse', o.textureDiffuse.length ? o.textureDiffuse.map((t) => (t.larghezza ? `${t.larghezza}×${t.altezza}` : '?')).join(', ') : 'nessuna');
    const s = o.stimaGlb;
    voce('Stima GLB (texture 2048)', `~${mb(s.totale2048)}  (geometria ~${mb(s.geometria)}, texture ~${mb(s.texture2048)})`);
    voce('Stima GLB (texture 4096)', `~${mb(s.totale4096)}`);
    info(stile.tenue('Stima grossolana (±50%): Draco con UV e normali, JPEG qualità 85.'));
  }

  for (const m of r.mtl) {
    titolo(`MTL: ${path.basename(m.percorso)}`);
    voce('Materiali', intero(m.materiali));
    for (const t of m.texture) {
      const stato = t.esiste ? stile.verde('ok') : stile.rosso('MANCANTE');
      const dim = t.larghezza ? `${t.larghezza}×${t.altezza}` : '';
      info(`${stato.padEnd(t.esiste ? 2 : 8)}  ${t.chiave.padEnd(9)} ${t.riferimento}  ${stile.tenue(dim)}`);
    }
    if (m.trasparenti.length) avviso(`materiali con trasparenza (d < 1): ${m.trasparenti.join(', ')} — la conversione li rende opachi.`);
  }

  titolo('Consigli');
  for (const c of r.consigli) {
    if (c.livello === 'rosso') problema(c.testo);
    else if (c.livello === 'giallo') avviso(c.testo);
    else if (c.livello === 'ok') ok(c.testo);
    else info(`- ${c.testo}`);
  }
  console.log('');
}

async function principale() {
  let letti;
  try {
    letti = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: { json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false } },
    });
  } catch (errore) {
    throw erroreArgomenti(errore);
  }
  const { values, positionals } = letti;
  if (values.help || positionals.length !== 1) {
    console.log('\nUso: node scripts/ispeziona-dataset.mjs <cartella-o-file> [--json]\n\nEsempio: node scripts/ispeziona-dataset.mjs sorgenti/masseria-san-domenico\n');
    return values.help ? 0 : 1;
  }
  const bersaglio = path.resolve(positionals[0]);
  if (!fs.existsSync(bersaglio)) throw new ErroreUtente(`non esiste: ${bersaglio}`);
  const risultato = await ispeziona(bersaglio);
  if (values.json) console.log(JSON.stringify(risultato, null, 2));
  else stampa(risultato);
  return risultato.consigli.some((c) => c.livello === 'rosso') ? 2 : 0;
}

avvia(principale);
