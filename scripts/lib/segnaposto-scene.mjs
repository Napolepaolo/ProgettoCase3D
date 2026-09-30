// Direzione artistica delle immagini segnaposto: colori, luci, inquadrature e le due
// scene (modello a colori per poster e anteprima; plastico in PLA su piatto girevole
// per le "foto"). Solo calcolo, niente file: lo usano lo script e i thread di render.

import { Modello } from './segnaposto-geometria.mjs';
import { MATERIALI } from './segnaposto-forme.mjs';
import {
  creaScena,
  cuociCielo,
  illumina,
  creaCamera,
  inquadra,
  proietta,
  renderizza,
  direzione,
  ruotaY,
  hexLineare,
  preparaFondale,
} from './segnaposto-render.mjs';

export const COLORI = Object.freeze({
  cartaChiara: '#f8f5ee', // fondo del poster = riquadro del modello
  carta: '#f3eee4', // fondo dell'anteprima social
  inchiostro: '#1c2b31',
  testoSecondario: '#4f5b5c',
  petrolio: '#1f5c68',
  filetto: '#cfc6b5',
  pla: '#EDEAE2', // PLA avorio del plastico stampato
  piatto: '#57544f', // disco del giradischi, grigio antracite satinato
  limboAlto: '#ebe6dd', // fondale da studio
  limboBasso: '#dbd4c9',
});

// Luce "da visualizzatore": ambiente morbido e una luce principale ampia, vicina a
// quella neutra di model-viewer. Luce "da studio" per le foto: softbox caldo in alto a
// sinistra. Gli azimut delle luci sono relativi alla camera.
const LUCE_MODELLO = {
  cielo: { colore: [1, 1, 1], intensita: 0.55 },
  chiave: { colore: [1, 0.97, 0.93], intensita: 1.0, cono: 14, campioni: 24 },
  rimbalzo: { colore: [1, 0.97, 0.92], intensita: 0.25 },
  azimutChiave: -8, // facciata ben illuminata, fianco più morbido
  elevazioneChiave: 48,
  esposizione: 0.92,
};
const LUCE_STUDIO = {
  cielo: { colore: [0.97, 0.985, 1], intensita: 0.5 },
  chiave: { colore: [1, 0.95, 0.88], intensita: 1.05, cono: 13, campioni: 16 },
  rimbalzo: { colore: [0.95, 0.92, 0.87], intensita: 0.14 },
  azimutChiave: -48,
  elevazioneChiave: 54,
  esposizione: 0.86,
};

// Inquadrature. Azimut come in model-viewer: 0 = fronte (+Z), negativo = camera a sinistra.
export const POSTER = Object.freeze({ lato: 1600, azimut: -30, elevazione: 25, fov: 30, margine: 0.1 }); // = camera-orbit "-30deg 65deg"
export const GIRO = Object.freeze({ lato: 1200, elevazione: 22, fov: 24 });
export const FOTO = Object.freeze({ larghezza: 1600, altezza: 1600, azimut: -32, elevazione: 22, fov: 24 });

// --- Scene -----------------------------------------------------------------------------

/** Scena a colori (materiali della pietra) appoggiata al pavimento: poster e anteprima. */
export function scenaModello(modello) {
  const { min, max } = modello.limiti();
  const lato = Math.max(max[0] - min[0], max[2] - min[2]);
  const albedo = Object.fromEntries(Object.entries(MATERIALI).map(([k, hex]) => [k, hexLineare(hex)]));
  const scena = creaScena(modello.facce, (f) => ({ albedo: albedo[f.materiale] }), {
    texel: lato / 190,
    pavimento: { y: 0, lato: lato * 3.2, risoluzione: 360 },
  });
  return cuociCielo(scena, { direzioni: 160, risoluzione: 320 });
}

/**
 * Il plastico stampato (PLA avorio, materiale unico) su un piatto girevole scuro.
 * Restituisce un oggetto clonabile (va passato ai thread di render).
 */
export function scenaPlastico(modello) {
  const { min, max } = modello.limiti();
  const semidiagonale = Math.hypot(max[0] - min[0], max[2] - min[2]) / 2;
  const raggioPiatto = semidiagonale * 1.03;
  const hPiatto = 0.02;
  const smusso = 0.004;

  const piatto = new Modello();
  piatto.rivoluzione(
    'piatto',
    [
      [raggioPiatto - 0.004, 0],
      [raggioPiatto, 0.004],
      [raggioPiatto, hPiatto - smusso],
      [raggioPiatto - smusso, hPiatto],
    ],
    { segmenti: 160 },
  );
  const facce = [
    ...piatto.facce,
    ...modello.facce.map((f) => ({ ...f, materiale: 'pla', punti: f.punti.map((p) => [p[0], p[1] + hPiatto, p[2]]) })),
  ];
  const pla = hexLineare(COLORI.pla);
  const scuro = hexLineare(COLORI.piatto);
  const aspetto = (f) =>
    f.materiale === 'pla' ? { albedo: pla, lucido: 0.05, esponente: 24 } : { albedo: scuro, lucido: 0.45, esponente: 10 };
  const scena = creaScena(facce, aspetto, {
    texel: (raggioPiatto * 2) / 240,
    pavimento: { y: 0, lato: raggioPiatto * 6, risoluzione: 360 },
  });
  cuociCielo(scena, { direzioni: 160, risoluzione: 320 });

  // Ingombro per l'inquadratura, uguale per tutti i frame: bordo del piatto e vertici
  // del modello ruotati su tutto il giro (la camera resta ferma).
  const vertici = modello.facce.flatMap((f) => f.punti);
  const giri = 24;
  const ingombro = new Float64Array((96 + vertici.length * giri) * 3);
  let k = 0;
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    ingombro.set([raggioPiatto * Math.sin(a), 0, raggioPiatto * Math.cos(a)], k);
    k += 3;
  }
  for (let i = 0; i < giri; i++) {
    const a = (i / giri) * Math.PI * 2;
    for (const p of vertici) {
      ingombro.set(ruotaY([p[0], p[1] + hPiatto, p[2]], a), k);
      k += 3;
    }
  }
  return { scena, ingombro, altezza: max[1] + hPiatto };
}

// --- Fondali --------------------------------------------------------------------------

const smussa = (t) => t * t * (3 - 2 * t);
const LIMBO_ALTO = hexLineare(COLORI.limboAlto);
const LIMBO_BASSO = hexLineare(COLORI.limboBasso);

/** Fondale da studio: grigio caldo con sfumatura verticale e angoli appena più scuri. */
function limbo(u, v, aspetto) {
  const t = smussa(Math.min(1, Math.max(0, (v - 0.12) / 0.88)));
  const dx = (u - 0.5) * aspetto;
  const dy = v - 0.4;
  const luce = 1 - 0.05 * Math.min(1, (dx * dx + dy * dy) / 0.55) ** 1.4;
  return [0, 1, 2].map((k) => (LIMBO_ALTO[k] + (LIMBO_BASSO[k] - LIMBO_ALTO[k]) * t) * luce);
}

const fondali = new Map();
/** Fondale "limbo" o tinta unita "#rrggbb", calcolato una volta per dimensione. */
function fondale(tipo, larghezza, altezza) {
  const chiave = `${tipo} ${larghezza}×${altezza}`;
  if (!fondali.has(chiave)) {
    const tinta = tipo.startsWith('#') ? hexLineare(tipo) : null;
    const sfondo = tinta ? () => tinta : (u, v) => limbo(u, v, larghezza / altezza);
    fondali.set(chiave, preparaFondale(larghezza, altezza, sfondo));
  }
  return fondali.get(chiave);
}

// --- Camere e luci ----------------------------------------------------------------------

/** Camera orbitale attorno a `bersaglio` (azimut/elevazione in gradi, come model-viewer). */
function cameraOrbitale({ azimut, elevazione, distanza, bersaglio, larghezza, altezza, fov }) {
  const d = direzione(azimut, elevazione);
  const posizione = [bersaglio[0] + d[0] * distanza, bersaglio[1] + d[1] * distanza, bersaglio[2] + d[2] * distanza];
  return creaCamera({ posizione, bersaglio, larghezza, altezza, fovY: fov });
}

function luceDa(config, scena, azimutCamera) {
  return illumina(scena, {
    cielo: config.cielo,
    chiave: {
      ...config.chiave,
      direzione: direzione(azimutCamera + config.azimutChiave, config.elevazioneChiave),
      apertura: config.chiave.cono,
    },
    rimbalzo: config.rimbalzo,
  });
}

// --- Render ------------------------------------------------------------------------------

/** Il modello a colori di 3/4 dall'alto, su fondo in tinta unita con una lieve ombra a terra. */
export function renderPoster(scena, modello, { larghezza, altezza, fondo, margine = POSTER.margine }) {
  const { min, max } = modello.limiti();
  const lato = Math.max(max[0] - min[0], max[2] - min[2]);
  const bersaglio = [0, (max[1] - min[1]) * 0.4, 0];
  let cam = cameraOrbitale({ ...POSTER, distanza: lato * 2.6, bersaglio, larghezza, altezza });
  cam = inquadra(
    cam,
    modello.facce.flatMap((f) => f.punti),
    { margineX: margine, margineY: margine },
  );
  const luce = luceDa(LUCE_MODELLO, scena, POSTER.azimut);
  return renderizza(scena, luce, cam, {
    fondale: fondale(fondo, larghezza, altezza),
    forzaOmbraPavimento: 0.55,
    esposizione: LUCE_MODELLO.esposizione,
  });
}

/**
 * Camera e luce della "foto" con l'oggetto ruotato di `angolo` gradi attorno a Y
 * (positivo = antiorario visto dall'alto: la facciata gira verso destra di chi guarda).
 * Equivale a ruotare camera e luci di -angolo attorno al modello fermo, così
 * l'occlusione del cielo, calcolata una volta, resta valida.
 */
export function vistaGiro(plastico, angolo, { larghezza, altezza, azimut = 0, elevazione = GIRO.elevazione, fov = GIRO.fov }) {
  plastico.camere ??= new Map();
  const chiave = [larghezza, altezza, azimut, elevazione, fov].join(' ');
  if (!plastico.camere.has(chiave)) {
    const bersaglio = [0, plastico.altezza * 0.3, 0];
    const cam = cameraOrbitale({ azimut, elevazione, distanza: 1.6, bersaglio, larghezza, altezza, fov });
    plastico.camere.set(chiave, inquadra(cam, plastico.ingombro, { margineX: 0.07, margineY: 0.11, centro: [0.5, 0.53] }));
  }
  const cam = plastico.camere.get(chiave);
  const rad = (-angolo * Math.PI) / 180;
  const ruota = (p) => ruotaY(p, rad);
  return {
    cam: { ...cam, posizione: ruota(cam.posizione), avanti: ruota(cam.avanti), destra: ruota(cam.destra), su: ruota(cam.su) },
    azimutLuce: azimut - angolo,
  };
}

/** "Foto" del plastico sul piatto, con l'oggetto ruotato di `angolo` gradi. */
export function renderFoto(plastico, angolo, opzioni) {
  const { cam, azimutLuce } = vistaGiro(plastico, angolo, opzioni);
  const luce = luceDa(LUCE_STUDIO, plastico.scena, azimutLuce);
  return renderizza(plastico.scena, luce, cam, {
    fondale: fondale('limbo', opzioni.larghezza, opzioni.altezza),
    forzaOmbraPavimento: 0.85,
    esposizione: LUCE_STUDIO.esposizione,
  });
}

/**
 * Controllo del verso: fra il primo e il secondo frame un punto sulla facciata (+Z)
 * deve spostarsi verso destra nell'immagine (verso sinistra se `inverti`).
 */
export function controllaVerso(plastico, passoGradi, inverti) {
  const punto = [0, plastico.altezza * 0.5, 0.1];
  const opzioni = { larghezza: 100, altezza: 100 };
  const x1 = proietta(vistaGiro(plastico, 0, opzioni).cam, punto)[0];
  const x2 = proietta(vistaGiro(plastico, (inverti ? -1 : 1) * passoGradi, opzioni).cam, punto)[0];
  if (x2 > x1 === Boolean(inverti)) throw new Error('verso di rotazione dei frame sbagliato: controlla vistaGiro()');
}
