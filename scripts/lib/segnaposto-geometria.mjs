// Geometria procedurale dei modelli segnaposto: poche primitive con normali piatte
// (parallelepipedi, solidi a sezioni rettangolari, estrusioni, solidi di rivoluzione)
// e l'esportazione in GLB con @gltf-transform/core.
//
// Convenzioni: metri, Y in alto, facciata principale verso +Z (è il lato che
// model-viewer inquadra per primo). Ogni faccia è un poligono piano con la propria
// normale: i vertici non sono condivisi fra facce, così l'ombreggiatura resta piatta.

import { Document } from '@gltf-transform/core';

/** Colori della pietra pugliese (sRGB). */
export const PALETTE = Object.freeze({
  calce: '#ECE6D8',
  pietra: '#CDBFA6',
  chiancarelle: '#8C8A83',
  legno: '#4A3B30',
  base: '#D8D0C0',
});

export function hexInSrgb(hex) {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function srgbInLineare(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function hexInLineare(hex) {
  return hexInSrgb(hex).map(srgbInLineare);
}

// --- Vettori e matrici minime ------------------------------------------------------

const scalare = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vettoriale = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lunghezza = (a) => Math.hypot(a[0], a[1], a[2]);

// Matrice affine 3×4 per righe: [r00 r01 r02 tx, r10 r11 r12 ty, r20 r21 r22 tz].
const IDENTITA = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);

function moltiplica(a, b) {
  const m = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let v = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c];
      if (c === 3) v += a[r * 4 + 3];
      m[r * 4 + c] = v;
    }
  }
  return m;
}

function applicaPunto(m, p) {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

function applicaDirezione(m, d) {
  return [m[0] * d[0] + m[1] * d[1] + m[2] * d[2], m[4] * d[0] + m[5] * d[1] + m[6] * d[2], m[8] * d[0] + m[9] * d[1] + m[10] * d[2]];
}

function rotazione(asse, angolo) {
  const c = Math.cos(angolo);
  const s = Math.sin(angolo);
  if (asse === 'x') return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0];
  if (asse === 'y') return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0];
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0];
}

// --- Poligoni -------------------------------------------------------------------

/** Normale di un poligono piano col metodo di Newell (non normalizzata). */
function normaleNewell(punti) {
  const n = [0, 0, 0];
  for (let i = 0; i < punti.length; i++) {
    const a = punti[i];
    const b = punti[(i + 1) % punti.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

/** Toglie i vertici doppi consecutivi (capita nei coni e nei colmi dei tetti). */
function senzaDoppi(punti) {
  const out = [];
  for (const p of punti) {
    const q = out[out.length - 1];
    if (!q || Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 1e-9) out.push(p);
  }
  while (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 1e-9) break;
    out.pop();
  }
  return out;
}

/**
 * Triangolazione "a orecchie" di un poligono semplice (anche concavo) già orientato
 * in senso antiorario rispetto alla normale n. Restituisce terne di indici.
 */
function triangola(punti, n) {
  if (punti.length === 3) return [[0, 1, 2]];
  // Base del piano del poligono: e1, e2 = n × e1, così (e1, e2) conserva il verso.
  const nn = lunghezza(n);
  const nu = [n[0] / nn, n[1] / nn, n[2] / nn];
  let e1 = Math.abs(nu[1]) < 0.9 ? vettoriale([0, 1, 0], nu) : vettoriale([1, 0, 0], nu);
  const l1 = lunghezza(e1);
  e1 = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
  const e2 = vettoriale(nu, e1);
  const p2 = punti.map((p) => [scalare(p, e1), scalare(p, e2)]);

  const indici = punti.map((_, i) => i);
  const tri = [];
  const croce = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const dentro = (p, a, b, c) => croce(a, b, p) >= -1e-12 && croce(b, c, p) >= -1e-12 && croce(c, a, p) >= -1e-12;
  let guardia = 0;
  while (indici.length > 3 && guardia++ < 10000) {
    let tagliato = false;
    for (let k = 0; k < indici.length; k++) {
      const ia = indici[(k + indici.length - 1) % indici.length];
      const ib = indici[k];
      const ic = indici[(k + 1) % indici.length];
      const a = p2[ia];
      const b = p2[ib];
      const c = p2[ic];
      if (croce(a, b, c) <= 1e-12) continue; // vertice riflesso o allineato
      let libero = true;
      for (const j of indici) {
        if (j === ia || j === ib || j === ic) continue;
        if (dentro(p2[j], a, b, c)) {
          libero = false;
          break;
        }
      }
      if (!libero) continue;
      tri.push([ia, ib, ic]);
      indici.splice(k, 1);
      tagliato = true;
      break;
    }
    if (!tagliato) break; // poligono degenere: chiudo a ventaglio
  }
  if (indici.length === 3) tri.push([indici[0], indici[1], indici[2]]);
  else for (let k = 1; k < indici.length - 1; k++) tri.push([indici[0], indici[k], indici[k + 1]]);
  return tri;
}

// --- Modello ------------------------------------------------------------------------

/**
 * Raccolta di facce piane con materiale. Le primitive accettano misure in metri
 * e rispettano la trasformazione corrente (vedi `con`).
 */
export class Modello {
  constructor() {
    /** @type {{materiale: string, punti: number[][], normale: number[], triangoli: number[][]}[]} */
    this.facce = [];
    this._pila = [IDENTITA];
  }

  get _matrice() {
    return this._pila[this._pila.length - 1];
  }

  /**
   * Disegna dentro un sistema di riferimento locale: traslazione (x, y, z) e rotazioni
   * in radianti (applicate nell'ordine Y, X, Z).
   */
  con({ x = 0, y = 0, z = 0, rotX = 0, rotY = 0, rotZ = 0 }, disegna) {
    let m = [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
    if (rotY) m = moltiplica(m, rotazione('y', rotY));
    if (rotX) m = moltiplica(m, rotazione('x', rotX));
    if (rotZ) m = moltiplica(m, rotazione('z', rotZ));
    this._pila.push(moltiplica(this._matrice, m));
    try {
      disegna();
    } finally {
      this._pila.pop();
    }
    return this;
  }

  /**
   * Aggiunge un poligono piano. `verso` è la direzione verso cui la faccia deve
   * guardare (grossomodo): se l'ordine dei vertici dà la normale opposta, lo inverto.
   */
  faccia(materiale, punti, verso) {
    let p = senzaDoppi(punti);
    if (p.length < 3) return this;
    let n = normaleNewell(p);
    const area = lunghezza(n) / 2;
    if (area < 1e-10) return this;
    if (verso && scalare(n, verso) < 0) {
      p = p.slice().reverse();
      n = [-n[0], -n[1], -n[2]];
    }
    const triangoli = triangola(p, n);
    const m = this._matrice;
    const nm = applicaDirezione(m, n);
    const ln = lunghezza(nm);
    this.facce.push({
      materiale,
      punti: p.map((q) => applicaPunto(m, q)),
      normale: [nm[0] / ln, nm[1] / ln, nm[2] / ln],
      triangoli,
    });
    return this;
  }

  /**
   * Solido a sezioni rettangolari orizzontali centrate in (x, z): ogni sezione è
   * [larghezza lungo X, profondità lungo Z, quota]. Due sezioni uguali fanno un
   * parallelepipedo; sezioni che si restringono fanno smussi, zoccoli, piramidi.
   */
  sezioni(materiale, sezioni, { x = 0, z = 0, fondo = true, cima = true } = {}) {
    const anello = ([l, p, y]) => [
      [x - l / 2, y, z + p / 2],
      [x + l / 2, y, z + p / 2],
      [x + l / 2, y, z - p / 2],
      [x - l / 2, y, z - p / 2],
    ];
    const anelli = sezioni.map(anello);
    const lati = [
      [0, 0, 1],
      [1, 0, 0],
      [0, 0, -1],
      [-1, 0, 0],
    ];
    for (let s = 0; s < anelli.length - 1; s++) {
      const a = anelli[s];
      const b = anelli[s + 1];
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4;
        // Verso: fuori dal lato, con la componente verticale data dal restringimento.
        const dentroA = k % 2 === 0 ? sezioni[s][1] : sezioni[s][0];
        const dentroB = k % 2 === 0 ? sezioni[s + 1][1] : sezioni[s + 1][0];
        const salita = sezioni[s + 1][2] - sezioni[s][2];
        const rientro = (dentroA - dentroB) / 2;
        const verso = [lati[k][0] * salita, rientro, lati[k][2] * salita];
        this.faccia(materiale, [a[k], a[k2], b[k2], b[k]], verso);
      }
    }
    if (fondo) this.faccia(materiale, anelli[0], [0, -1, 0]);
    if (cima) this.faccia(materiale, anelli[anelli.length - 1], [0, 1, 0]);
    return this;
  }

  /** Parallelepipedo: (x, z) è il centro della pianta, y la quota del piano d'appoggio. */
  parallelepipedo(materiale, { x = 0, y = 0, z = 0, l, p, h, fondo = true }) {
    return this.sezioni(
      materiale,
      [
        [l, p, y],
        [l, p, y + h],
      ],
      { x, z, fondo },
    );
  }

  /**
   * Estrusione di un profilo piano [[u, y], …]. Con asse 'z' il profilo sta nel piano
   * XY (u = x) ed è estruso da z = da a z = a; con asse 'x' sta nel piano ZY (u = z).
   */
  estrusione(materiale, profilo, { asse = 'z', da, a }) {
    const punto = asse === 'z' ? (u, y, w) => [u, y, w] : (u, y, w) => [w, y, u];
    const direzione = asse === 'z' ? (du, dy) => [du, dy, 0] : (du, dy) => [0, dy, du];
    // Orientamento del profilo (area con segno) per sapere da che parte è l'esterno.
    let area = 0;
    for (let i = 0; i < profilo.length; i++) {
      const [u1, y1] = profilo[i];
      const [u2, y2] = profilo[(i + 1) % profilo.length];
      area += u1 * y2 - u2 * y1;
    }
    const segno = area >= 0 ? 1 : -1;
    for (let i = 0; i < profilo.length; i++) {
      const [u1, y1] = profilo[i];
      const [u2, y2] = profilo[(i + 1) % profilo.length];
      // Normale esterna di un lato di un poligono antiorario: (dy, -du).
      const verso = direzione(segno * (y2 - y1), -segno * (u2 - u1));
      this.faccia(materiale, [punto(u1, y1, da), punto(u2, y2, da), punto(u2, y2, a), punto(u1, y1, a)], verso);
    }
    const asseVerso = asse === 'z' ? [0, 0, 1] : [1, 0, 0];
    const segnoAsse = a >= da ? 1 : -1;
    const fine = asseVerso.map((c) => c * segnoAsse);
    this.faccia(
      materiale,
      profilo.map(([u, y]) => punto(u, y, a)),
      fine,
    );
    this.faccia(
      materiale,
      profilo.map(([u, y]) => punto(u, y, da)),
      fine.map((c) => -c),
    );
    return this;
  }

  /**
   * Solido di rivoluzione attorno all'asse verticale per (x, z). Il profilo è una lista
   * [[raggio, quota], …] dal basso verso l'alto, sul lato esterno. L'angolo parte da +Z
   * (0) e gira verso +X; `da`/`a` permettono solidi parziali (es. un'abside).
   */
  rivoluzione(
    materiale,
    profilo,
    { x = 0, z = 0, segmenti = 24, da = 0, a = Math.PI * 2, fondo = true, cima = true, tagli = true } = {},
  ) {
    const completo = Math.abs(a - da - Math.PI * 2) < 1e-9;
    const angoli = Array.from({ length: segmenti + 1 }, (_, j) => da + ((a - da) * j) / segmenti);
    const punto = (r, y, phi) => [x + r * Math.sin(phi), y, z + r * Math.cos(phi)];
    for (let i = 0; i < profilo.length - 1; i++) {
      const [r1, y1] = profilo[i];
      const [r2, y2] = profilo[i + 1];
      const nr = y2 - y1; // normale esterna del lato del profilo: (dy, -dr)
      const ny = -(r2 - r1);
      for (let j = 0; j < segmenti; j++) {
        const f1 = angoli[j];
        const f2 = angoli[j + 1];
        const fm = (f1 + f2) / 2;
        const verso = [nr * Math.sin(fm), ny, nr * Math.cos(fm)];
        this.faccia(materiale, [punto(r1, y1, f1), punto(r1, y1, f2), punto(r2, y2, f2), punto(r2, y2, f1)], verso);
      }
    }
    const tappo = (r, y, verso) => {
      if (r <= 1e-9) return;
      const giro = angoli.slice(0, completo ? segmenti : segmenti + 1).map((f) => punto(r, y, f));
      if (!completo) giro.push([x, y, z]);
      this.faccia(materiale, giro, verso);
    };
    if (fondo) tappo(profilo[0][0], profilo[0][1], [0, -1, 0]);
    if (cima) tappo(profilo[profilo.length - 1][0], profilo[profilo.length - 1][1], [0, 1, 0]);
    if (!completo && tagli) {
      for (const [phi, segno] of [
        [da, -1],
        [a, 1],
      ]) {
        const tangente = [Math.cos(phi) * segno, 0, -Math.sin(phi) * segno];
        const poligono = [
          [x, profilo[0][1], z],
          ...profilo.map(([r, y]) => punto(r, y, phi)),
          [x, profilo[profilo.length - 1][1], z],
        ];
        this.faccia(materiale, poligono, tangente);
      }
    }
    return this;
  }

  // --- Misure e normalizzazione ---------------------------------------------------

  limiti() {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const f of this.facce) {
      for (const p of f.punti) {
        for (let k = 0; k < 3; k++) {
          if (p[k] < min[k]) min[k] = p[k];
          if (p[k] > max[k]) max[k] = p[k];
        }
      }
    }
    return { min, max };
  }

  numeroTriangoli() {
    return this.facce.reduce((s, f) => s + f.triangoli.length, 0);
  }

  /**
   * Porta il modello in scala da plastico: lato maggiore della pianta = `latoMetri`,
   * centrato in X/Z, appoggiato a Y = 0. Restituisce il fattore di scala applicato.
   */
  inScala(latoMetri) {
    const { min, max } = this.limiti();
    const lato = Math.max(max[0] - min[0], max[2] - min[2]);
    const s = latoMetri / lato;
    const cx = (min[0] + max[0]) / 2;
    const cz = (min[2] + max[2]) / 2;
    for (const f of this.facce) {
      f.punti = f.punti.map((p) => [(p[0] - cx) * s, (p[1] - min[1]) * s, (p[2] - cz) * s]);
    }
    return s;
  }
}

// --- Esportazione GLB -----------------------------------------------------------------

/**
 * Crea un Document glTF con un nodo, una mesh e una primitiva per materiale.
 * `materiali` associa ai nomi usati nel modello un colore esadecimale sRGB.
 */
export function documentoGLTF(modello, { nome, materiali }) {
  const doc = new Document();
  const radice = doc.getRoot();
  radice.getAsset().generator = '3D Building by FareLAB — genera-segnaposto (modello dimostrativo)';
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh(nome);

  const perMateriale = new Map();
  for (const f of modello.facce) {
    if (!perMateriale.has(f.materiale)) perMateriale.set(f.materiale, []);
    perMateriale.get(f.materiale).push(f);
  }

  for (const [nomeMateriale, facce] of perMateriale) {
    const hex = materiali[nomeMateriale];
    if (!hex) throw new Error(`Materiale senza colore: "${nomeMateriale}"`);
    const vertici = facce.reduce((s, f) => s + f.punti.length, 0);
    const triangoli = facce.reduce((s, f) => s + f.triangoli.length, 0);
    const posizioni = new Float32Array(vertici * 3);
    const normali = new Float32Array(vertici * 3);
    const indici = vertici > 65535 ? new Uint32Array(triangoli * 3) : new Uint16Array(triangoli * 3);
    let v = 0;
    let t = 0;
    for (const f of facce) {
      const base = v;
      for (const p of f.punti) {
        posizioni.set(p, v * 3);
        normali.set(f.normale, v * 3);
        v++;
      }
      for (const tri of f.triangoli) {
        indici[t++] = base + tri[0];
        indici[t++] = base + tri[1];
        indici[t++] = base + tri[2];
      }
    }
    const materiale = doc
      .createMaterial(nomeMateriale)
      .setBaseColorFactor([...hexInLineare(hex), 1])
      .setMetallicFactor(0)
      .setRoughnessFactor(0.9);
    const primitiva = doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(posizioni).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(normali).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(indici).setBuffer(buffer))
      .setMaterial(materiale);
    mesh.addPrimitive(primitiva);
  }

  const nodo = doc.createNode(nome).setMesh(mesh);
  const scena = doc.createScene(nome).addChild(nodo);
  radice.setDefaultScene(scena);
  return doc;
}
