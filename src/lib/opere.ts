// Caricamento, validazione e "risoluzione" delle opere descritte in data/opere.json.
//
// Tutti i percorsi del file dati sono RELATIVI alla cartella dell'opera, cioè a
// public/opere/<slug>/ (es. "modello/modello.glb"). Qui vengono trasformati in URL
// e viene controllato che i file esistano davvero: se manca il modello o mancano
// dei frame del plastico, la pagina mostra un segnaposto invece di rompersi,
// e la build stampa un avviso.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'astro/zod';
import { url, urlAssoluto } from './url';

const FILE_DATI = path.resolve(process.cwd(), 'data/opere.json');
const CARTELLA_PUBLIC = path.resolve(process.cwd(), 'public');

const percorsoRelativo = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), {
    message: 'deve essere un percorso relativo alla cartella dell\'opera, es. "modello/modello.glb"',
  });

const SchemaOpera = z
  .object({
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
      message: 'lo slug può contenere solo lettere minuscole, numeri e trattini (es. "masseria-san-domenico")',
    }),
    nome: z.string().min(1),
    localita: z.string().min(1),
    anno: z.number().int().min(1000).max(2100).nullish(),
    descrizione: z.string().min(1),
    glb: percorsoRelativo,
    usdz: percorsoRelativo.nullish(),
    poster: percorsoRelativo,
    anteprimaSocial: percorsoRelativo.nullish(),
    turntable: z
      .object({
        cartella: percorsoRelativo,
        numeroFrame: z.number().int().min(2).max(720),
        estensione: z.string().regex(/^[a-z0-9]+$/i, { message: 'estensione senza punto, es. "webp"' }),
        inverti: z.boolean().optional(),
        /** Gradi da aggiungere perché il plastico mostri la stessa facciata del modello 3D (vedi README). */
        allineamento: z.number().min(-360).max(360).optional(),
      })
      .strict()
      .nullish(),
    fotoPlastico: percorsoRelativo.nullish(),
    scalaAR: z.number().positive(),
    pubblicato: z.boolean(),
  })
  .strict();

export type DatiOpera = z.infer<typeof SchemaOpera>;

/** Come appare il plastico nella pagina: giro a 360°, singola foto, oppure segnaposto. */
export type Plastico =
  | { tipo: 'turntable'; frame: string[]; inverti: boolean; allineamento: number }
  | { tipo: 'foto'; src: string }
  | { tipo: 'segnaposto' };

export interface Opera {
  slug: string;
  nome: string;
  localita: string;
  anno: number | null;
  descrizione: string;
  /** Posizione (1, 2, …) fra le opere pubblicate, nell'ordine del file dati. */
  numero: number;
  /** Numero totale di opere pubblicate. */
  totale: number;
  /** Numero a due cifre per le didascalie: "01". */
  numeroEtichetta: string;
  /** Percorso della pagina, es. "/opere/<slug>/". */
  pagina: string;
  /** URL assoluto della pagina (canonical, QR code). */
  paginaAssoluta: string;
  /** null se il file GLB non esiste ancora. */
  modello: { glb: string; usdz: string | null } | null;
  /** URL del poster, oppure null se il file non esiste ancora. */
  poster: string | null;
  /** URL ASSOLUTO dell'immagine per Open Graph (anteprimaSocial, altrimenti il poster). */
  immagineSocial: string | null;
  plastico: Plastico;
  /** Lato maggiore della base del modello in AR, in centimetri. */
  scalaAR: number;
}

const avvisiGiaStampati = new Set<string>();
function avvisa(messaggio: string) {
  if (avvisiGiaStampati.has(messaggio)) return;
  avvisiGiaStampati.add(messaggio);
  console.warn(`[opere] ${messaggio}`);
}

/** Apostrofo tipografico fra due lettere ("quest'opera" → "quest’opera"): nel file dati si può scrivere quello della tastiera. */
function tipografico(testo: string): string {
  return testo.replace(/(\p{L})'(?=\p{L})/gu, '$1’');
}

function esiste(percorsoPublic: string): boolean {
  return fs.existsSync(path.join(CARTELLA_PUBLIC, percorsoPublic));
}

function leggiDati(): DatiOpera[] {
  let grezzi: unknown;
  try {
    grezzi = JSON.parse(fs.readFileSync(FILE_DATI, 'utf8'));
  } catch (errore) {
    throw new Error(`Impossibile leggere ${FILE_DATI}: ${(errore as Error).message}`);
  }
  if (!Array.isArray(grezzi)) throw new Error('data/opere.json deve contenere un array di opere: [ { ... }, { ... } ]');

  const problemi: string[] = [];
  const opere: DatiOpera[] = [];
  grezzi.forEach((voce, i) => {
    const esito = SchemaOpera.safeParse(voce);
    const etichetta = (voce as { slug?: string })?.slug ?? `#${i + 1}`;
    if (!esito.success) {
      for (const issue of esito.error.issues) {
        problemi.push(`  • opera "${etichetta}" → ${issue.path.join('.') || '(radice)'}: ${issue.message}`);
      }
    } else {
      opere.push(esito.data);
    }
  });
  const visti = new Set<string>();
  for (const o of opere) {
    if (visti.has(o.slug)) problemi.push(`  • slug duplicato: "${o.slug}"`);
    visti.add(o.slug);
  }
  if (problemi.length) throw new Error(`Errori in data/opere.json:\n${problemi.join('\n')}`);
  return opere;
}

function risolviPlastico(d: DatiOpera, cartella: string): Plastico {
  if (d.turntable) {
    const { cartella: sotto, numeroFrame, estensione, inverti, allineamento } = d.turntable;
    const relativi = Array.from(
      { length: numeroFrame },
      (_, i) => `${cartella}/${sotto}/${String(i + 1).padStart(3, '0')}.${estensione.toLowerCase()}`,
    );
    const mancanti = relativi.filter((p) => !esiste(p));
    if (mancanti.length === 0) {
      return {
        tipo: 'turntable',
        frame: relativi.map((p) => url(p)),
        inverti: Boolean(inverti),
        allineamento: allineamento ?? 0,
      };
    }
    avvisa(
      `"${d.slug}": mancano ${mancanti.length} frame su ${numeroFrame} (es. public/${mancanti[0]}). ` +
        'Mostro la foto del plastico o il segnaposto.',
    );
  }
  if (d.fotoPlastico) {
    const p = `${cartella}/${d.fotoPlastico}`;
    if (esiste(p)) return { tipo: 'foto', src: url(p) };
    avvisa(`"${d.slug}": fotoPlastico non trovata (public/${p}).`);
  }
  return { tipo: 'segnaposto' };
}

function risolvi(d: DatiOpera, indice: number, totale: number): Opera {
  const cartella = `opere/${d.slug}`;
  const glb = `${cartella}/${d.glb}`;
  const usdz = d.usdz ? `${cartella}/${d.usdz}` : null;
  const poster = `${cartella}/${d.poster}`;
  const social = d.anteprimaSocial ? `${cartella}/${d.anteprimaSocial}` : null;

  if (!esiste(glb)) avvisa(`"${d.slug}": modello GLB non trovato (public/${glb}). Mostro il segnaposto.`);
  if (usdz && !esiste(usdz)) avvisa(`"${d.slug}": USDZ non trovato (public/${usdz}). Uso la conversione automatica per iOS.`);
  if (!esiste(poster)) avvisa(`"${d.slug}": poster non trovato (public/${poster}).`);
  if (social && !esiste(social)) avvisa(`"${d.slug}": anteprimaSocial non trovata (public/${social}). Uso il poster.`);

  const immagineSocialPercorso = social && esiste(social) ? social : esiste(poster) ? poster : null;

  return {
    slug: d.slug,
    nome: tipografico(d.nome),
    localita: tipografico(d.localita),
    anno: d.anno ?? null,
    descrizione: tipografico(d.descrizione),
    numero: indice + 1,
    totale,
    numeroEtichetta: String(indice + 1).padStart(2, '0'),
    pagina: url(`${cartella}/`),
    paginaAssoluta: urlAssoluto(`${cartella}/`),
    modello: esiste(glb) ? { glb: url(glb), usdz: usdz && esiste(usdz) ? url(usdz) : null } : null,
    poster: esiste(poster) ? url(poster) : null,
    immagineSocial: immagineSocialPercorso ? urlAssoluto(immagineSocialPercorso) : null,
    plastico: risolviPlastico(d, cartella),
    scalaAR: d.scalaAR,
  };
}

let cache: Opera[] | null = null;

/** Opere pubblicate, nell'ordine del file dati. In sviluppo il file viene riletto a ogni richiesta. */
export function getOpere(): Opera[] {
  if (cache && import.meta.env.PROD) return cache;
  const pubblicate = leggiDati().filter((d) => d.pubblicato);
  cache = pubblicate.map((d, i) => risolvi(d, i, pubblicate.length));
  return cache;
}

export function getOpera(slug: string): Opera | undefined {
  return getOpere().find((o) => o.slug === slug);
}
