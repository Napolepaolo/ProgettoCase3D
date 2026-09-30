// Piccolo rasterizzatore software per poster, anteprime e "foto" dei plastici segnaposto.
//
// Come funziona, in breve:
// 1. La luce viene calcolata in object space su una griglia di texel appoggiata a ogni
//    faccia (lightmap). Per ogni direzione di luce si rasterizza una mappa di profondità
//    ortografica e si controlla quali texel sono in vista: con ~150 direzioni sulla volta
//    del cielo si ottiene un'occlusione ambientale morbida, con ~24 direzioni raccolte in
//    un cono una luce principale "ad area" con ombre sfumate. Il pavimento (y costante,
//    infinito) ha la sua griglia e riceve le ombre.
// 2. L'immagine si rasterizza a risoluzione doppia con uno z-buffer che memorizza solo
//    l'indice del triangolo; il punto 3D di ogni campione si ricava intersecando il raggio
//    della camera col piano del triangolo, e la luce si legge dalla lightmap (bilineare).
// 3. Tone mapping "neutral" (lo stesso di model-viewer), media dei campioni 2×2 in
//    spazio lineare, codifica sRGB.
// Il cielo è simmetrico attorno all'asse Y, quindi per un giradischi basta far ruotare
// camera e luce principale attorno al modello: l'occlusione del cielo si calcola una volta.

// Codifica sRGB con 4 bit frazionari (valore × 16): serve al dithering finale.
const LUT_SRGB = (() => {
  const n = 65536;
  const lut = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const c = i / (n - 1);
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
    lut[i] = Math.max(0, Math.min(255 * 16, Math.round(s * 255 * 16)));
  }
  return lut;
})();

// Soglie di dithering (0…15) da un rumore bianco fisso 64×64: stesso schema in ogni
// immagine, quindi niente sfarfallio fra i frame; rompe le bande dei gradienti a 8 bit.
const DITHER = (() => {
  const d = new Uint8Array(64 * 64);
  let a = 0x9e3779b9;
  for (let i = 0; i < d.length; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    d[i] = ((t ^ (t >>> 14)) >>> 0) % 16;
  }
  return d;
})();

export function srgbInLineare(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** "#rrggbb" → [r, g, b] lineari. */
export function hexLineare(hex) {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => srgbInLineare(v / 255));
}

const normalizza = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const vettoriale = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Base ortonormale (a, b) perpendicolare a d. */
function basePerpendicolare(d) {
  const a = normalizza(Math.abs(d[1]) < 0.9 ? vettoriale([0, 1, 0], d) : vettoriale([1, 0, 0], d));
  const b = vettoriale(d, a);
  return [a, b];
}

/** Ruota un vettore attorno a Y (angolo in radianti, positivo = antiorario visto dall'alto). */
export function ruotaY(v, angolo) {
  const c = Math.cos(angolo);
  const s = Math.sin(angolo);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

/** Direzione da azimut/elevazione in gradi (azimut 0 = +Z, positivo verso +X). */
export function direzione(azimutGradi, elevazioneGradi) {
  const a = (azimutGradi * Math.PI) / 180;
  const e = (elevazioneGradi * Math.PI) / 180;
  return [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)];
}

/** Direzioni quasi uniformi sulla semisfera superiore (spirale di Fibonacci), deterministiche. */
export function direzioniCielo(n, elevazioneMinima = 3) {
  const out = [];
  const sinMin = Math.sin((elevazioneMinima * Math.PI) / 180);
  const aureo = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = sinMin + (1 - sinMin) * ((i + 0.5) / n);
    const r = Math.sqrt(1 - y * y);
    const phi = i * aureo;
    out.push([r * Math.sin(phi), y, r * Math.cos(phi)]);
  }
  return out;
}

/** n direzioni distribuite in un cono di semiapertura `gradi` attorno ad asse (luce ad area). */
export function direzioniCono(asse, gradi, n) {
  const [a, b] = basePerpendicolare(asse);
  const t = Math.tan((gradi * Math.PI) / 180);
  const aureo = Math.PI * (3 - Math.sqrt(5));
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n) * t;
    const phi = i * aureo;
    const u = r * Math.cos(phi);
    const v = r * Math.sin(phi);
    out.push(normalizza([asse[0] + a[0] * u + b[0] * v, asse[1] + a[1] * u + b[1] * v, asse[2] + a[2] * u + b[2] * v]));
  }
  return out;
}

// --- Scena --------------------------------------------------------------------------

/**
 * Prepara la scena da un elenco di facce piane ({punti, normale, triangoli}).
 * `aspetto(faccia)` restituisce { albedo: [r,g,b] lineare, lucido: 0…1, esponente }
 * (intensità ed esponente del riflesso della luce principale).
 * `texel` è il lato dei texel di luce in metri; `pavimento` ({ y, lato, risoluzione })
 * aggiunge un piano orizzontale infinito che riceve ombre ma non ne proietta.
 */
export function creaScena(facce, aspetto, { texel, pavimento = null }) {
  const F = facce.length + (pavimento ? 1 : 0);
  const fN = new Float64Array(F * 3);
  const fD = new Float64Array(F);
  const fE1 = new Float64Array(F * 3);
  const fE2 = new Float64Array(F * 3);
  const fS0 = new Float64Array(F);
  const fT0 = new Float64Array(F);
  const fDu = new Float64Array(F);
  const fDv = new Float64Array(F);
  const fNu = new Int32Array(F);
  const fNv = new Int32Array(F);
  const fOff = new Int32Array(F);
  const fAlb = new Float64Array(F * 3);
  const fLuc = new Float64Array(F);
  const fEsp = new Float64Array(F);

  let T = 0;
  for (const f of facce) T += f.triangoli.length;
  const tPos = new Float64Array(T * 9);
  const tFac = new Int32Array(T);

  let texel0 = 0;
  let t = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  const registraGriglia = (i, n, e1, punti, passo) => {
    const e2 = vettoriale(n, e1);
    let s0 = Infinity;
    let s1 = -Infinity;
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const p of punti) {
      const s = p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2];
      const tt = p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2];
      if (s < s0) s0 = s;
      if (s > s1) s1 = s;
      if (tt < t0) t0 = tt;
      if (tt > t1) t1 = tt;
    }
    const nu = Math.max(2, Math.ceil((s1 - s0) / passo));
    const nv = Math.max(2, Math.ceil((t1 - t0) / passo));
    fN.set(n, i * 3);
    fE1.set(e1, i * 3);
    fE2.set(e2, i * 3);
    fD[i] = punti[0][0] * n[0] + punti[0][1] * n[1] + punti[0][2] * n[2];
    fS0[i] = s0;
    fT0[i] = t0;
    fDu[i] = (s1 - s0) / nu;
    fDv[i] = (t1 - t0) / nv;
    fNu[i] = nu;
    fNv[i] = nv;
    fOff[i] = texel0;
    texel0 += nu * nv;
  };

  facce.forEach((f, i) => {
    const n = f.normale;
    const e1 = normalizza(Math.abs(n[1]) < 0.9 ? vettoriale([0, 1, 0], n) : vettoriale([1, 0, 0], n));
    registraGriglia(i, n, e1, f.punti, texel);
    const { albedo, lucido = 0, esponente = 30 } = aspetto(f);
    fAlb.set(albedo, i * 3);
    fLuc[i] = lucido;
    fEsp[i] = esponente;
    for (const tri of f.triangoli) {
      for (let k = 0; k < 3; k++) {
        const p = f.punti[tri[k]];
        tPos[t * 9 + k * 3] = p[0];
        tPos[t * 9 + k * 3 + 1] = p[1];
        tPos[t * 9 + k * 3 + 2] = p[2];
        for (let c = 0; c < 3; c++) {
          if (p[c] < min[c]) min[c] = p[c];
          if (p[c] > max[c]) max[c] = p[c];
        }
      }
      tFac[t++] = i;
    }
  });

  let indicePavimento = -1;
  if (pavimento) {
    indicePavimento = facce.length;
    const { y, lato, risoluzione } = pavimento;
    const h = lato / 2;
    registraGriglia(
      indicePavimento,
      [0, 1, 0],
      [1, 0, 0],
      [
        [-h, y, -h],
        [h, y, h],
      ],
      lato / risoluzione,
    );
  }

  const centro = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let raggio = 0;
  for (let i = 0; i < tPos.length; i += 3) {
    raggio = Math.max(raggio, Math.hypot(tPos[i] - centro[0], tPos[i + 1] - centro[1], tPos[i + 2] - centro[2]));
  }

  return {
    F,
    T,
    K: texel0,
    fN,
    fD,
    fE1,
    fE2,
    fS0,
    fT0,
    fDu,
    fDv,
    fNu,
    fNv,
    fOff,
    fAlb,
    fLuc,
    fEsp,
    tPos,
    tFac,
    indicePavimento,
    yPavimento: pavimento ? pavimento.y : 0,
    centro,
    raggio: raggio * 1.01,
    min,
    max,
    cielo: null,
  };
}

// Intervallo [da, a] di colonne di una riga in cui le tre funzioni di spigolo (valutate
// a x = x0 e con incrementi a0, a1, a2 per colonna) sono tutte ≥ 0: evita di scorrere
// l'intero rettangolo che contiene i triangoli lunghi e sottili. Il risultato sta sempre
// dentro [x0, xmax]; una riga vuota (o calcoli non finiti) dà da > a.
// Attenzione: i limiti intermedi possono essere enormi (spigoli quasi paralleli alla riga),
// per questo si confrontano in doppia precisione e non si salvano mai in interi a 32 bit.
const SPAN = new Float64Array(2);
function intervallo(x0, xmax, e0, e1, e2, a0, a1, a2) {
  let da = x0;
  let a = xmax;
  for (let s = 0; s < 3; s++) {
    const e = s === 0 ? e0 : s === 1 ? e1 : e2;
    const inc = s === 0 ? a0 : s === 1 ? a1 : a2;
    if (inc > 0) {
      const k = x0 + Math.ceil(-e / inc - 1e-7);
      if (k > da) da = k;
    } else if (inc < 0) {
      const k = x0 + Math.floor(e / -inc + 1e-7);
      if (k < a) a = k;
    } else if (!(e >= 0)) {
      a = x0 - 1;
    }
  }
  if (!(da <= a)) {
    SPAN[0] = 1;
    SPAN[1] = 0;
  } else {
    SPAN[0] = da;
    SPAN[1] = a;
  }
  return SPAN;
}

const finito = Number.isFinite;

// --- Mappe di profondità direzionali -------------------------------------------------

/**
 * Rasterizza la scena vista dalla direzione d (verso la luce), in proiezione ortografica:
 * per ogni pixel tiene la quota massima lungo d, cioè l'occlusore più vicino alla luce.
 */
function mappaProfondita(scena, d, ris, buffer) {
  const [a, b] = basePerpendicolare(d);
  const { tPos, centro, raggio } = scena;
  const k = ris / (2 * raggio);
  const mappa = buffer ?? new Float32Array(ris * ris);
  mappa.fill(-Infinity);
  const n = tPos.length / 9;
  const px = new Float64Array(3);
  const py = new Float64Array(3);
  const pw = new Float64Array(3);
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    for (let v = 0; v < 3; v++) {
      const x = tPos[o + v * 3] - centro[0];
      const y = tPos[o + v * 3 + 1] - centro[1];
      const z = tPos[o + v * 3 + 2] - centro[2];
      px[v] = (x * a[0] + y * a[1] + z * a[2] + raggio) * k;
      py[v] = (x * b[0] + y * b[1] + z * b[2] + raggio) * k;
      pw[v] = x * d[0] + y * d[1] + z * d[2];
    }
    let area = (px[1] - px[0]) * (py[2] - py[0]) - (py[1] - py[0]) * (px[2] - px[0]);
    if (!(Math.abs(area) >= 1e-12) || !finito(area)) continue; // degenere o non finito
    let i1 = 1;
    let i2 = 2;
    if (area < 0) {
      i1 = 2;
      i2 = 1;
      area = -area;
    }
    const x0 = px[0];
    const y0 = py[0];
    const x1 = px[i1];
    const y1 = py[i1];
    const x2 = px[i2];
    const y2 = py[i2];
    const w0 = pw[0];
    const w1 = pw[i1];
    const w2 = pw[i2];
    const xmin = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const xmax = Math.min(ris - 1, Math.ceil(Math.max(x0, x1, x2)));
    const ymin = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const ymax = Math.min(ris - 1, Math.ceil(Math.max(y0, y1, y2)));
    const inv = 1 / area;
    const a0 = -(y2 - y1);
    const a1 = -(y0 - y2);
    const a2 = -(y1 - y0);
    for (let yy = ymin; yy <= ymax; yy++) {
      const cy = yy + 0.5;
      const cx = xmin + 0.5;
      const e0r = (x2 - x1) * (cy - y1) - (y2 - y1) * (cx - x1);
      const e1r = (x0 - x2) * (cy - y2) - (y0 - y2) * (cx - x2);
      const e2r = (x1 - x0) * (cy - y0) - (y1 - y0) * (cx - x0);
      const [da, a] = intervallo(xmin, xmax, e0r, e1r, e2r, a0, a1, a2);
      for (let xx = da; xx <= a; xx++) {
        const k = xx - xmin;
        const e0 = e0r + a0 * k;
        const e1 = e1r + a1 * k;
        const e2 = e2r + a2 * k;
        if (e0 < 0 || e1 < 0 || e2 < 0) continue;
        const w = (e0 * w0 + e1 * w1 + e2 * w2) * inv;
        const i = yy * ris + xx;
        if (w > mappa[i]) mappa[i] = w;
      }
    }
  }
  return { mappa, a, b, d, k, ris };
}

/**
 * Per ogni texel di ogni faccia rivolta verso d accumula peso · cos · visibilità in `uscita`
 * (e, se richiesto, peso · visibilità in `uscitaVis`). Il test è bilineare fra 4 pixel della mappa.
 */
function accumulaDirezione(scena, m, peso, uscita, uscitaVis) {
  const { F, fN, fD, fE1, fE2, fS0, fT0, fDu, fDv, fNu, fNv, fOff, centro, raggio } = scena;
  const { mappa, a, b, d, k, ris } = m;
  const passoMappa = 1 / k;
  const scosta = passoMappa * 1.6; // spostamento lungo la normale contro l'acne
  const bias = passoMappa * 0.9;
  for (let f = 0; f < F; f++) {
    const nx = fN[f * 3];
    const ny = fN[f * 3 + 1];
    const nz = fN[f * 3 + 2];
    const cos = nx * d[0] + ny * d[1] + nz * d[2];
    if (cos <= 0) continue;
    // Origine della griglia (centro del primo texel), spostata lungo la normale.
    const e1x = fE1[f * 3];
    const e1y = fE1[f * 3 + 1];
    const e1z = fE1[f * 3 + 2];
    const e2x = fE2[f * 3];
    const e2y = fE2[f * 3 + 1];
    const e2z = fE2[f * 3 + 2];
    const du = fDu[f];
    const dv = fDv[f];
    const s = fS0[f] + du / 2;
    const tt = fT0[f] + dv / 2;
    const ox = e1x * s + e2x * tt + nx * (fD[f] + scosta) - centro[0];
    const oy = e1y * s + e2y * tt + ny * (fD[f] + scosta) - centro[1];
    const oz = e1z * s + e2z * tt + nz * (fD[f] + scosta) - centro[2];
    // Coordinate in mappa: lineari negli indici del texel.
    const u0 = (ox * a[0] + oy * a[1] + oz * a[2] + raggio) * k - 0.5;
    const v0 = (ox * b[0] + oy * b[1] + oz * b[2] + raggio) * k - 0.5;
    const w0 = ox * d[0] + oy * d[1] + oz * d[2] + bias;
    const uI = (e1x * a[0] + e1y * a[1] + e1z * a[2]) * du * k;
    const vI = (e1x * b[0] + e1y * b[1] + e1z * b[2]) * du * k;
    const wI = (e1x * d[0] + e1y * d[1] + e1z * d[2]) * du;
    const uJ = (e2x * a[0] + e2y * a[1] + e2z * a[2]) * dv * k;
    const vJ = (e2x * b[0] + e2y * b[1] + e2z * b[2]) * dv * k;
    const wJ = (e2x * d[0] + e2y * d[1] + e2z * d[2]) * dv;
    const nu = fNu[f];
    const nv = fNv[f];
    const off = fOff[f];
    const pc = peso * cos;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const fu = u0 + i * uI + j * uJ;
        const fv = v0 + i * vI + j * vJ;
        const w = w0 + i * wI + j * wJ;
        const iu = Math.floor(fu);
        const iv = Math.floor(fv);
        const au = fu - iu;
        const av = fv - iv;
        let vis;
        if (iu < 0 || iv < 0 || iu >= ris - 1 || iv >= ris - 1) {
          vis = 1;
        } else {
          const r0 = iv * ris + iu;
          const l00 = mappa[r0] > w ? 0 : 1;
          const l10 = mappa[r0 + 1] > w ? 0 : 1;
          const l01 = mappa[r0 + ris] > w ? 0 : 1;
          const l11 = mappa[r0 + ris + 1] > w ? 0 : 1;
          vis = (l00 * (1 - au) + l10 * au) * (1 - av) + (l01 * (1 - au) + l11 * au) * av;
        }
        if (vis > 0) {
          const q = off + j * nu + i;
          uscita[q] += pc * vis;
          if (uscitaVis) uscitaVis[q] += peso * vis;
        }
      }
    }
  }
}

/**
 * Luce dal cielo (una volta per scena): irradianza normalizzata, 1 = faccia orizzontale
 * rivolta in alto e libera. `apertura[f]` è il valore per la stessa faccia senza occlusori.
 */
export function cuociCielo(scena, { direzioni = 160, risoluzione = 320 } = {}) {
  const dirs = direzioniCielo(direzioni);
  const somma = dirs.reduce((s, d) => s + d[1], 0);
  const cielo = new Float32Array(scena.K);
  const buffer = new Float32Array(risoluzione * risoluzione);
  for (const d of dirs) {
    const m = mappaProfondita(scena, d, risoluzione, buffer);
    accumulaDirezione(scena, m, 1 / somma, cielo);
  }
  const apertura = new Float64Array(scena.F);
  for (let f = 0; f < scena.F; f++) {
    let s = 0;
    for (const d of dirs) s += Math.max(0, scena.fN[f * 3] * d[0] + scena.fN[f * 3 + 1] * d[1] + scena.fN[f * 3 + 2] * d[2]);
    apertura[f] = s / somma;
  }
  scena.cielo = { valori: cielo, apertura };
  return scena;
}

/**
 * Combina cielo, luce principale ad area (con ombre) e un rimbalzo dal basso in una
 * lightmap RGB. Restituisce anche la visibilità della luce principale (per i riflessi)
 * e, per il pavimento, il fattore d'ombra (1 = nessuna ombra).
 */
export function illumina(scena, { cielo, chiave, rimbalzo, risoluzioneChiave = 512 }) {
  if (!scena.cielo) throw new Error('Serve prima cuociCielo(scena)');
  const { K, F, fN, fOff, fNu, fNv, indicePavimento } = scena;
  const dirs = direzioniCono(chiave.direzione, chiave.apertura ?? 10, chiave.campioni ?? 24);
  const diretta = new Float32Array(K);
  const vis = new Float32Array(K);
  const buffer = new Float32Array(risoluzioneChiave * risoluzioneChiave);
  for (const d of dirs) {
    const m = mappaProfondita(scena, d, risoluzioneChiave, buffer);
    accumulaDirezione(scena, m, 1 / dirs.length, diretta, vis);
  }
  const irr = new Float32Array(K * 3);
  const valoriCielo = scena.cielo.valori;
  const apertura = scena.cielo.apertura;
  const cc = cielo.colore.map((c) => c * cielo.intensita);
  const ck = chiave.colore.map((c) => c * chiave.intensita);
  const cr = rimbalzo.colore.map((c) => c * rimbalzo.intensita);
  for (let f = 0; f < F; f++) {
    const ny = fN[f * 3 + 1];
    const quotaRimbalzo = (1 - ny) / 2;
    const off = fOff[f];
    const n = fNu[f] * fNv[f];
    for (let q = off; q < off + n; q++) {
      const c = valoriCielo[q];
      // Il rimbalzo subisce la stessa occlusione del cielo (in proporzione).
      const occl = apertura[f] > 0.05 ? Math.min(1, c / apertura[f]) : 1;
      const r = quotaRimbalzo * (0.35 + 0.65 * occl);
      irr[q * 3] = cc[0] * c + ck[0] * diretta[q] + cr[0] * r;
      irr[q * 3 + 1] = cc[1] * c + ck[1] * diretta[q] + cr[1] * r;
      irr[q * 3 + 2] = cc[2] * c + ck[2] * diretta[q] + cr[2] * r;
    }
  }
  let ombraPavimento = null;
  if (indicePavimento >= 0) {
    // Valori del pavimento libero, per normalizzare: cielo = 1, chiave = media dei coseni.
    const liberoChiave = dirs.reduce((s, d) => s + Math.max(0, d[1]), 0) / dirs.length;
    const wc = cielo.intensita;
    const wk = chiave.intensita;
    const off = fOff[indicePavimento];
    const n = fNu[indicePavimento] * fNv[indicePavimento];
    ombraPavimento = new Float32Array(n);
    for (let q = 0; q < n; q++) {
      ombraPavimento[q] = Math.min(1, (wc * valoriCielo[off + q] + wk * diretta[off + q]) / (wc + wk * liberoChiave));
    }
  }
  return { irr, vis, ombraPavimento, direzioneChiave: normalizza(chiave.direzione), coloreChiave: ck };
}

// --- Camera -------------------------------------------------------------------------------

/**
 * Camera prospettica. `f` è la focale in pixel, (cx, cy) il punto principale: impostati
 * da `inquadra` perché l'oggetto riempia l'immagine con il margine voluto.
 */
export function creaCamera({ posizione, bersaglio, larghezza, altezza, fovY = 30 }) {
  const avanti = normalizza([bersaglio[0] - posizione[0], bersaglio[1] - posizione[1], bersaglio[2] - posizione[2]]);
  const destra = normalizza(vettoriale(avanti, [0, 1, 0]));
  const su = vettoriale(destra, avanti);
  const f = altezza / 2 / Math.tan((fovY * Math.PI) / 360);
  return { posizione, avanti, destra, su, larghezza, altezza, f, cx: larghezza / 2, cy: altezza / 2 };
}

/** Proietta un punto: [x pixel, y pixel, profondità]. */
export function proietta(cam, p) {
  const dx = p[0] - cam.posizione[0];
  const dy = p[1] - cam.posizione[1];
  const dz = p[2] - cam.posizione[2];
  const z = dx * cam.avanti[0] + dy * cam.avanti[1] + dz * cam.avanti[2];
  const x = dx * cam.destra[0] + dy * cam.destra[1] + dz * cam.destra[2];
  const y = dx * cam.su[0] + dy * cam.su[1] + dz * cam.su[2];
  return [cam.cx + (cam.f * x) / z, cam.cy - (cam.f * y) / z, z];
}

/**
 * Regola focale e punto principale perché i punti dati (array di [x, y, z] oppure
 * Float64Array piatto) occupino il riquadro [margine…1-margine] dell'immagine, con il
 * centro dell'ingombro in `centro` (frazioni di larghezza e altezza).
 */
export function inquadra(cam, punti, { margineX = 0.1, margineY = 0.1, centro = [0.5, 0.5] } = {}) {
  let xmin = Infinity;
  let xmax = -Infinity;
  let ymin = Infinity;
  let ymax = -Infinity;
  const piatto = punti instanceof Float64Array;
  const n = piatto ? punti.length / 3 : punti.length;
  for (let i = 0; i < n; i++) {
    const p = piatto ? punti.subarray(i * 3, i * 3 + 3) : punti[i];
    const dx = p[0] - cam.posizione[0];
    const dy = p[1] - cam.posizione[1];
    const dz = p[2] - cam.posizione[2];
    const z = dx * cam.avanti[0] + dy * cam.avanti[1] + dz * cam.avanti[2];
    const x = (dx * cam.destra[0] + dy * cam.destra[1] + dz * cam.destra[2]) / z;
    const y = (dx * cam.su[0] + dy * cam.su[1] + dz * cam.su[2]) / z;
    xmin = Math.min(xmin, x);
    xmax = Math.max(xmax, x);
    ymin = Math.min(ymin, y);
    ymax = Math.max(ymax, y);
  }
  const W = cam.larghezza;
  const H = cam.altezza;
  const f = Math.min((W * (1 - 2 * margineX)) / (xmax - xmin), (H * (1 - 2 * margineY)) / (ymax - ymin));
  return {
    ...cam,
    f,
    cx: W * centro[0] - (f * (xmin + xmax)) / 2,
    cy: H * centro[1] + (f * (ymin + ymax)) / 2,
  };
}

/** Stessa camera a una risoluzione diversa (per il supercampionamento). */
function scalaCamera(cam, s) {
  return { ...cam, larghezza: cam.larghezza * s, altezza: cam.altezza * s, f: cam.f * s, cx: cam.cx * s, cy: cam.cy * s };
}

// --- Rasterizzazione dell'immagine ---------------------------------------------------------

// Buffer riusati fra un'immagine e l'altra (ogni thread ha i suoi).
let bufferId = new Int32Array(0);
let bufferZ = new Float32Array(0);

function rasterizza(scena, cam) {
  const W = cam.larghezza;
  const H = cam.altezza;
  if (bufferId.length !== W * H) {
    bufferId = new Int32Array(W * H);
    bufferZ = new Float32Array(W * H);
  }
  const id = bufferId.fill(-1);
  const iz = bufferZ.fill(0); // 1/z: più grande = più vicino
  const { tPos, tFac, fN, T } = scena;
  const C = cam.posizione;
  const px = new Float64Array(3);
  const py = new Float64Array(3);
  const pz = new Float64Array(3);
  for (let t = 0; t < T; t++) {
    const o = t * 9;
    const f = tFac[t];
    // Scarto le facce girate dall'altra parte rispetto alla camera.
    if (fN[f * 3] * (tPos[o] - C[0]) + fN[f * 3 + 1] * (tPos[o + 1] - C[1]) + fN[f * 3 + 2] * (tPos[o + 2] - C[2]) >= 0) continue;
    let dietro = false;
    for (let v = 0; v < 3; v++) {
      const dx = tPos[o + v * 3] - C[0];
      const dy = tPos[o + v * 3 + 1] - C[1];
      const dz = tPos[o + v * 3 + 2] - C[2];
      const z = dx * cam.avanti[0] + dy * cam.avanti[1] + dz * cam.avanti[2];
      if (z <= 1e-6) dietro = true;
      px[v] = cam.cx + (cam.f * (dx * cam.destra[0] + dy * cam.destra[1] + dz * cam.destra[2])) / z;
      py[v] = cam.cy - (cam.f * (dx * cam.su[0] + dy * cam.su[1] + dz * cam.su[2])) / z;
      pz[v] = 1 / z;
    }
    if (dietro) continue;
    let area = (px[1] - px[0]) * (py[2] - py[0]) - (py[1] - py[0]) * (px[2] - px[0]);
    if (!(Math.abs(area) >= 1e-12) || !finito(area)) continue; // degenere o non finito
    let i1 = 1;
    let i2 = 2;
    if (area < 0) {
      i1 = 2;
      i2 = 1;
      area = -area;
    }
    const x0 = px[0];
    const y0 = py[0];
    const x1 = px[i1];
    const y1 = py[i1];
    const x2 = px[i2];
    const y2 = py[i2];
    const z0 = pz[0];
    const z1 = pz[i1];
    const z2 = pz[i2];
    const xmin = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const xmax = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
    const ymin = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const ymax = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
    if (xmin > xmax || ymin > ymax) continue;
    const inv = 1 / area;
    // Funzioni di spigolo incrementali lungo x.
    const a0 = -(y2 - y1);
    const a1 = -(y0 - y2);
    const a2 = -(y1 - y0);
    for (let yy = ymin; yy <= ymax; yy++) {
      const cy = yy + 0.5;
      const cx = xmin + 0.5;
      const e0r = (x2 - x1) * (cy - y1) - (y2 - y1) * (cx - x1);
      const e1r = (x0 - x2) * (cy - y2) - (y0 - y2) * (cx - x2);
      const e2r = (x1 - x0) * (cy - y0) - (y1 - y0) * (cx - x0);
      const [da, a] = intervallo(xmin, xmax, e0r, e1r, e2r, a0, a1, a2);
      for (let xx = da; xx <= a; xx++) {
        const k = xx - xmin;
        const e0 = e0r + a0 * k;
        const e1 = e1r + a1 * k;
        const e2 = e2r + a2 * k;
        if (e0 < 0 || e1 < 0 || e2 < 0) continue;
        const z = (e0 * z0 + e1 * z1 + e2 * z2) * inv;
        const i = yy * W + xx;
        if (z > iz[i]) {
          iz[i] = z;
          id[i] = t;
        }
      }
    }
  }
  return id;
}

// --- Tone mapping --------------------------------------------------------------------------

/** Khronos PBR Neutral, come in three.js/model-viewer. Modifica `c` sul posto. */
function toneMappingNeutral(c) {
  const inizio = 0.8 - 0.04;
  const desaturazione = 0.15;
  const x = Math.min(c[0], c[1], c[2]);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  c[0] -= offset;
  c[1] -= offset;
  c[2] -= offset;
  const picco = Math.max(c[0], c[1], c[2]);
  if (picco < inizio) return c;
  const d = 1 - inizio;
  const nuovo = 1 - (d * d) / (picco + d - inizio);
  const s = nuovo / picco;
  const g = 1 - 1 / (desaturazione * (picco - nuovo) + 1);
  for (let k = 0; k < 3; k++) c[k] = c[k] * s * (1 - g) + nuovo * g;
  return c;
}

// --- Render --------------------------------------------------------------------------------

/**
 * Fondale precalcolato (RGB lineari per pixel d'uscita): per i frame di un giro è sempre
 * lo stesso, conviene calcolarlo una volta sola.
 */
export function preparaFondale(larghezza, altezza, sfondo) {
  const fondale = new Float32Array(larghezza * altezza * 3);
  for (let y = 0; y < altezza; y++) {
    for (let x = 0; x < larghezza; x++) {
      const c = sfondo((x + 0.5) / larghezza, (y + 0.5) / altezza);
      const o = (y * larghezza + x) * 3;
      fondale[o] = c[0];
      fondale[o + 1] = c[1];
      fondale[o + 2] = c[2];
    }
  }
  return fondale;
}

/**
 * Renderizza la scena e restituisce i pixel RGB (Uint8Array, larghezza × altezza × 3).
 * - `fondale`: RGB lineari del fondale per pixel d'uscita (vedi preparaFondale);
 * - `forzaOmbraPavimento` scurisce il fondale dove il pavimento è in ombra (0 = mai);
 */
export function renderizza(scena, luce, camera, { fondale, forzaOmbraPavimento = 1, esposizione = 1, supercampionamento = 2, dithering = true }) {
  const ss = supercampionamento;
  const W = camera.larghezza;
  const H = camera.altezza;
  if (fondale.length !== W * H * 3) throw new Error('fondale di dimensioni diverse dall\'immagine');
  const cam = scalaCamera(camera, ss);
  const Ws = W * ss;
  const id = rasterizza(scena, cam);
  const { tFac, fN, fD, fE1, fE2, fS0, fT0, fDu, fDv, fNu, fNv, fOff, fAlb, fLuc, fEsp, indicePavimento, yPavimento } = scena;
  const { irr, vis, ombraPavimento, direzioneChiave: L, coloreChiave } = luce;
  const C = cam.posizione;
  const Fw = cam.avanti;
  const R = cam.destra;
  const U = cam.su;
  const out = new Uint8Array(W * H * 3);
  const col = [0, 0, 0];
  const nCampioni = ss * ss;

  // Pavimento: griglia centrata nell'origine, e1 = +X, e2 = n × e1 = -Z.
  const pav = indicePavimento >= 0;
  const pS0 = pav ? fS0[indicePavimento] : 0;
  const pT0 = pav ? fT0[indicePavimento] : 0;
  const pDu = pav ? fDu[indicePavimento] : 1;
  const pDv = pav ? fDv[indicePavimento] : 1;
  const pNu = pav ? fNu[indicePavimento] : 0;
  const pNv = pav ? fNv[indicePavimento] : 0;

  const codifica = (v, soglia) => {
    const q = LUT_SRGB[Math.max(0, Math.min(65535, Math.round(v * 65535)))];
    return Math.min(255, (q + soglia) >> 4);
  };

  for (let oy = 0; oy < H; oy++) {
    for (let ox = 0; ox < W; ox++) {
      // Fondale e pavimento, valutati al centro del pixel d'uscita.
      const of = (oy * W + ox) * 3;
      const fondoR = fondale[of];
      const fondoG = fondale[of + 1];
      const fondoB = fondale[of + 2];
      let ombra = 1;
      if (pav && forzaOmbraPavimento > 0) {
        const sx = ((ox + 0.5) * ss - cam.cx) / cam.f;
        const sy = ((oy + 0.5) * ss - cam.cy) / cam.f;
        const dy = Fw[1] + sx * R[1] - sy * U[1];
        if (dy < -1e-9) {
          const tp = (yPavimento - C[1]) / dy;
          const x = C[0] + tp * (Fw[0] + sx * R[0] - sy * U[0]);
          const z = C[2] + tp * (Fw[2] + sx * R[2] - sy * U[2]);
          // e1 = (1,0,0), e2 = (0,0,-1)
          const fu = (x - pS0) / pDu - 0.5;
          const fv = (-z - pT0) / pDv - 0.5;
          const iu = Math.floor(fu);
          const iv = Math.floor(fv);
          if (iu >= 0 && iv >= 0 && iu < pNu - 1 && iv < pNv - 1) {
            const au = fu - iu;
            const av = fv - iv;
            const q = iv * pNu + iu;
            const o = (ombraPavimento[q] * (1 - au) + ombraPavimento[q + 1] * au) * (1 - av) + (ombraPavimento[q + pNu] * (1 - au) + ombraPavimento[q + pNu + 1] * au) * av;
            ombra = 1 - forzaOmbraPavimento * (1 - o);
          }
        }
      }
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy_ = 0; sy_ < ss; sy_++) {
        for (let sx_ = 0; sx_ < ss; sx_++) {
          const px = ox * ss + sx_;
          const py = oy * ss + sy_;
          const t = id[py * Ws + px];
          if (t < 0) {
            r += fondoR * ombra;
            g += fondoG * ombra;
            b += fondoB * ombra;
            continue;
          }
          const f = tFac[t];
          const nx = fN[f * 3];
          const ny = fN[f * 3 + 1];
          const nz = fN[f * 3 + 2];
          const sx = (px + 0.5 - cam.cx) / cam.f;
          const sy = (py + 0.5 - cam.cy) / cam.f;
          const dx = Fw[0] + sx * R[0] - sy * U[0];
          const dy = Fw[1] + sx * R[1] - sy * U[1];
          const dz = Fw[2] + sx * R[2] - sy * U[2];
          const den = nx * dx + ny * dy + nz * dz;
          const tp = (fD[f] - (nx * C[0] + ny * C[1] + nz * C[2])) / den;
          const X = C[0] + tp * dx;
          const Y = C[1] + tp * dy;
          const Z = C[2] + tp * dz;
          // Lightmap: coordinate nella griglia della faccia, lettura bilineare.
          const nu = fNu[f];
          const nv = fNv[f];
          let fu = (X * fE1[f * 3] + Y * fE1[f * 3 + 1] + Z * fE1[f * 3 + 2] - fS0[f]) / fDu[f] - 0.5;
          let fv = (X * fE2[f * 3] + Y * fE2[f * 3 + 1] + Z * fE2[f * 3 + 2] - fT0[f]) / fDv[f] - 0.5;
          fu = fu < 0 ? 0 : fu > nu - 1 ? nu - 1 : fu;
          fv = fv < 0 ? 0 : fv > nv - 1 ? nv - 1 : fv;
          let iu = Math.floor(fu);
          let iv = Math.floor(fv);
          if (iu > nu - 2) iu = nu - 2;
          if (iv > nv - 2) iv = nv - 2;
          const au = fu - iu;
          const av = fv - iv;
          const q00 = fOff[f] + iv * nu + iu;
          const q10 = q00 + 1;
          const q01 = q00 + nu;
          const q11 = q01 + 1;
          const w00 = (1 - au) * (1 - av);
          const w10 = au * (1 - av);
          const w01 = (1 - au) * av;
          const w11 = au * av;
          col[0] = fAlb[f * 3] * (irr[q00 * 3] * w00 + irr[q10 * 3] * w10 + irr[q01 * 3] * w01 + irr[q11 * 3] * w11);
          col[1] = fAlb[f * 3 + 1] * (irr[q00 * 3 + 1] * w00 + irr[q10 * 3 + 1] * w10 + irr[q01 * 3 + 1] * w01 + irr[q11 * 3 + 1] * w11);
          col[2] = fAlb[f * 3 + 2] * (irr[q00 * 3 + 2] * w00 + irr[q10 * 3 + 2] * w10 + irr[q01 * 3 + 2] * w01 + irr[q11 * 3 + 2] * w11);
          const lucido = fLuc[f];
          if (lucido > 0) {
            const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
            let hx = L[0] - dx * inv;
            let hy = L[1] - dy * inv;
            let hz = L[2] - dz * inv;
            const hl = 1 / Math.sqrt(hx * hx + hy * hy + hz * hz);
            hx *= hl;
            hy *= hl;
            hz *= hl;
            const nh = nx * hx + ny * hy + nz * hz;
            if (nh > 0) {
              const v = vis[q00] * w00 + vis[q10] * w10 + vis[q01] * w01 + vis[q11] * w11;
              const sp = lucido * v * nh ** fEsp[f];
              col[0] += sp * coloreChiave[0];
              col[1] += sp * coloreChiave[1];
              col[2] += sp * coloreChiave[2];
            }
          }
          col[0] *= esposizione;
          col[1] *= esposizione;
          col[2] *= esposizione;
          toneMappingNeutral(col);
          r += col[0];
          g += col[1];
          b += col[2];
        }
      }
      const o = (oy * W + ox) * 3;
      const soglia = dithering ? DITHER[(oy & 63) * 64 + (ox & 63)] : 8;
      out[o] = codifica(r / nCampioni, soglia);
      out[o + 1] = codifica(g / nCampioni, soglia);
      out[o + 2] = codifica(b / nCampioni, soglia);
    }
  }
  return out;
}
