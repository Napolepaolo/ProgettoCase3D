// Lettura dell'intestazione JSON di un file GLB (senza caricare geometria e texture)
// e regole condivise fra la pagina (ModelloDigitale.astro) e il generatore di poster,
// così il sito e il poster mostrano il modello con la stessa resa.

import fs from 'node:fs';

/**
 * Restituisce il JSON glTF contenuto in un GLB, leggendo solo i primi byte del file.
 * @param {string} file percorso del GLB
 * @returns {Record<string, any> | null} null se il file non esiste o non è un GLB valido
 */
export function leggiIntestazioneGlb(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const testata = Buffer.alloc(20);
    fs.readSync(fd, testata, 0, 20, 0);
    // "glTF", versione, lunghezza totale, poi il primo blocco: lunghezza + tipo "JSON".
    if (testata.toString('latin1', 0, 4) !== 'glTF' || testata.toString('latin1', 16, 20) !== 'JSON') return null;
    const json = Buffer.alloc(testata.readUInt32LE(12));
    fs.readSync(fd, json, 0, json.length, 20);
    return JSON.parse(json.toString('utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * true se tutti i materiali hanno "la luce cotta nella texture" come li produce
 * converti-modello.mjs per la fotogrammetria: colore base nero e colore emissivo (di solito
 * una texture; un colore fisso per le eventuali parti senza coordinate UV).
 * Per questi modelli il tone mapping va spento, altrimenti i colori escono leggermente
 * slavati rispetto alle foto (con "none" la resa è identica a un materiale unlit).
 */
export function haLuceCottaNellaTexture(gltf) {
  const materiali = gltf?.materials ?? [];
  if (materiali.length === 0) return false;
  return materiali.every((m) => {
    const base = m.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
    const emissivo = m.emissiveTexture !== undefined || (m.emissiveFactor ?? [0, 0, 0]).some((c) => c > 0);
    return emissivo && base[0] === 0 && base[1] === 0 && base[2] === 0;
  });
}

/**
 * Valore dell'attributo tone-mapping di <model-viewer> per questo modello,
 * oppure null per lasciare il default della libreria.
 */
export function toneMappingPerGlb(gltf) {
  return haLuceCottaNellaTexture(gltf) ? 'none' : null;
}
