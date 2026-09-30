// Percorsi del progetto e accesso (in sola lettura) a data/opere.json.
// Le regole sullo slug sono le stesse di src/lib/opere.ts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ErroreUtente } from './terminale.mjs';

export const RADICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CARTELLA_PUBLIC = path.join(RADICE, 'public');
export const CARTELLA_SORGENTI = path.join(RADICE, 'sorgenti');
export const FILE_OPERE = path.join(RADICE, 'data', 'opere.json');

export const REGEX_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Scala AR di ripiego (cm) se l'opera non è ancora in data/opere.json. */
export const SCALA_AR_PREDEFINITA = 35;

export function controllaSlug(slug) {
  if (!slug) {
    throw new ErroreUtente('manca lo slug dell\'opera (es. "masseria-san-domenico").');
  }
  if (!REGEX_SLUG.test(slug)) {
    throw new ErroreUtente(
      `slug non valido: "${slug}". Usa solo lettere minuscole, numeri e trattini, ` +
        'senza accenti né spazi (es. "masseria-san-domenico"): diventa l\'indirizzo della pagina.',
    );
  }
  return slug;
}

/** Cartella del modello di un'opera nel sito: public/opere/<slug>/modello */
export function cartellaModello(slug) {
  return path.join(CARTELLA_PUBLIC, 'opere', slug, 'modello');
}

/** Legge data/opere.json; restituisce [] se il file non esiste. */
export function leggiOpere() {
  if (!fs.existsSync(FILE_OPERE)) return [];
  try {
    const dati = JSON.parse(fs.readFileSync(FILE_OPERE, 'utf8'));
    return Array.isArray(dati) ? dati : [];
  } catch (errore) {
    throw new ErroreUtente(`data/opere.json non è un JSON valido: ${errore.message}`);
  }
}

export function trovaOpera(slug) {
  return leggiOpere().find((o) => o && o.slug === slug) ?? null;
}

/** "masseria-san-domenico" → "Masseria San Domenico" (solo come proposta per il nome). */
export function nomeDaSlug(slug) {
  return slug
    .split('-')
    .map((parola) => parola.charAt(0).toUpperCase() + parola.slice(1))
    .join(' ');
}

/** Percorso relativo alla radice del progetto, per messaggi più leggibili. */
export function relativo(percorso) {
  const rel = path.relative(RADICE, percorso);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : percorso;
}

// --- Pulizia anche con Ctrl-C -------------------------------------------------------------
// Con SIGINT/SIGTERM Node esce subito e i blocchi finally non vengono eseguiti: qui si
// registrano le pulizie (cartelle temporanee, file .tmp) da fare comunque prima di uscire.
const pulizie = new Set();
let gestoriInstallati = false;

/** Registra una pulizia sincrona da eseguire se il processo viene interrotto. Restituisce la funzione per toglierla. */
export function registraPulizia(pulizia) {
  if (!gestoriInstallati) {
    gestoriInstallati = true;
    for (const segnale of ['SIGINT', 'SIGTERM']) {
      process.once(segnale, () => {
        for (const p of pulizie) {
          try {
            p();
          } catch {
            // si esce comunque
          }
        }
        console.error(`\ninterrotto (${segnale}): file temporanei rimossi.`);
        process.exit(segnale === 'SIGINT' ? 130 : 143);
      });
    }
  }
  pulizie.add(pulizia);
  return () => pulizie.delete(pulizia);
}

/** Scrive un file in modo atomico (prima un file temporaneo, poi rename): mai file a metà. */
export async function scriviAtomico(destinazione, dati) {
  await fs.promises.mkdir(path.dirname(destinazione), { recursive: true });
  const temporaneo = `${destinazione}.tmp-${process.pid}`;
  const togli = registraPulizia(() => fs.rmSync(temporaneo, { force: true }));
  try {
    await fs.promises.writeFile(temporaneo, dati);
    await fs.promises.rename(temporaneo, destinazione);
  } catch (errore) {
    await fs.promises.rm(temporaneo, { force: true });
    throw errore;
  } finally {
    togli();
  }
}
