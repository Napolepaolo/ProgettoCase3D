// Le quattro architetture dimostrative, disegnate in metri "veri" con la facciata
// principale verso +Z. Lo script le porta poi in scala da plastico (scalaAR).
// Ogni forma poggia su una base-plinto sottile con lo spigolo superiore smussato.

import { Modello, PALETTE } from './segnaposto-geometria.mjs';

/** Materiali usati dalle forme → colore sRGB (vedi PALETTE). */
export const MATERIALI = PALETTE;

// Generatore pseudo-casuale con seme: stessi input → stessi file.
function casuale(seme) {
  let a = seme >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Aiuti di disegno ---------------------------------------------------------------

/** Parallelepipedo dato per estremi: [x1, x2], [y1, y2], [z1, z2]. */
function scatola(m, materiale, [x1, x2], [y1, y2], [z1, z2], { fondo = false } = {}) {
  m.parallelepipedo(materiale, { x: (x1 + x2) / 2, z: (z1 + z2) / 2, y: y1, l: x2 - x1, p: z2 - z1, h: y2 - y1, fondo });
}

/**
 * Pannello sottile appoggiato a una parete (porta, finestra, feritoia).
 * `lato` è la direzione verso cui guarda la parete, `piano` la sua coordinata,
 * [u1, u2] l'estensione lungo la parete, [y1, y2] in altezza.
 */
function apertura(m, materiale, lato, piano, [u1, u2], [y1, y2], sporgenza = 0.08) {
  const affondo = 0.03;
  if (lato === '+z') scatola(m, materiale, [u1, u2], [y1, y2], [piano - affondo, piano + sporgenza]);
  else if (lato === '-z') scatola(m, materiale, [u1, u2], [y1, y2], [piano - sporgenza, piano + affondo]);
  else if (lato === '+x') scatola(m, materiale, [piano - affondo, piano + sporgenza], [y1, y2], [u1, u2]);
  else scatola(m, materiale, [piano - sporgenza, piano + affondo], [y1, y2], [u1, u2]);
}

/**
 * Pannello sul fronte (+Z) di una parete cilindrica [cx, cz, raggio]: [u1, u2] è
 * relativo al centro. Il retro affonda fin dove la curva arretra ai bordi.
 */
function aperturaCurva(m, materiale, [cx, cz, raggio], [u1, u2], [y1, y2], sporgenza) {
  const bordo = Math.max(Math.abs(u1), Math.abs(u2));
  const zBordo = cz + Math.sqrt(raggio * raggio - bordo * bordo);
  scatola(m, materiale, [cx + u1, cx + u2], [y1, y2], [zBordo - 0.08, cz + raggio + sporgenza]);
}

/** Finestra con davanzale in pietra. */
function finestra(m, lato, piano, centro, y, larghezza, altezza) {
  const u = [centro - larghezza / 2, centro + larghezza / 2];
  apertura(m, 'legno', lato, piano, u, [y, y + altezza], 0.07);
  apertura(m, 'pietra', lato, piano, [u[0] - 0.12, u[1] + 0.12], [y - 0.14, y], 0.16);
}

/** Base del plastico: spessore 2% del lato maggiore, spigolo superiore smussato. */
function plinto(m, l, p) {
  const s = 0.02 * Math.max(l, p);
  const c = s * 0.35;
  m.sezioni('base', [
    [l, p, 0],
    [l, p, s - c],
    [l - 2 * c, p - 2 * c, s],
  ]);
  return s;
}

// --- Masseria fortificata ------------------------------------------------------------

function masseria() {
  const m = new Modello();
  const y0 = plinto(m, 38, 32);

  m.con({ y: y0 }, () => {
    // Corte lastricata (poco più alta della base, per staccare il colore).
    scatola(m, 'pietra', [-14.3, 14.3], [0, 0.05], [-4, 11.3]);

    // Muro di cinta con copertina in pietra; la porta carraia sta al centro del lato frontale.
    const hMuro = 3.4;
    const tratti = [
      [[-15, -2.8], [11.3, 12]],
      [[2.8, 15], [11.3, 12]],
      [[-15, -14.3], [-11.3, 11.3]],
      [[14.3, 15], [-11.3, 11.3]],
      [[-15, -9], [-12, -11.3]],
      [[12.5, 15], [-12, -11.3]],
    ];
    for (const [x, z] of tratti) {
      scatola(m, 'calce', x, [0, hMuro], [Math.min(...z), Math.max(...z)]);
      scatola(m, 'pietra', [x[0] - 0.1, x[1] + 0.1], [hMuro, hMuro + 0.18], [Math.min(...z) - 0.1, Math.max(...z) + 0.1]);
    }

    // Portale d'ingresso: massa più alta, cornice e portone in legno sui due lati.
    scatola(m, 'calce', [-2.8, 2.8], [0, 4.7], [11.15, 12.15]);
    scatola(m, 'pietra', [-3.0, 3.0], [4.7, 4.95], [11.05, 12.25]);
    m.sezioni(
      'calce',
      [
        [2.4, 0.9, 4.95],
        [2.4, 0.9, 5.45],
        [0.0, 0.9, 5.95],
      ],
      { z: 11.65, fondo: false },
    );
    apertura(m, 'legno', '+z', 12.15, [-1.5, 1.5], [0, 3.4], 0.06);
    apertura(m, 'legno', '-z', 11.15, [-1.5, 1.5], [0, 3.4], 0.06);

    // Corpo principale a due piani, tetto piano con parapetto.
    const [cx1, cx2, cz1, cz2] = [-9, 7, -12, -4];
    scatola(m, 'calce', [cx1, cx2], [0, 7.4], [cz1, cz2]);
    scatola(m, 'pietra', [cx1 - 0.12, cx2 + 0.12], [3.8, 4.0], [cz1 - 0.12, cz2 + 0.12]); // marcapiano
    scatola(m, 'pietra', [cx1 - 0.15, cx2 + 0.15], [7.4, 7.6], [cz1 - 0.15, cz2 + 0.15]); // cornice e lastrico
    const par = 0.35;
    const hPar = 8.4;
    scatola(m, 'calce', [cx1, cx2], [7.6, hPar], [cz2 - par, cz2]);
    scatola(m, 'calce', [cx1, cx2], [7.6, hPar], [cz1, cz1 + par]);
    scatola(m, 'calce', [cx1, cx1 + par], [7.6, hPar], [cz1 + par, cz2 - par]);

    // Scala esterna addossata alla facciata: gradini, pianerottolo e parapetto rampante.
    const gradini = 13;
    const alzata = 3.9 / gradini;
    const pedata = 0.4;
    const xs = -8.6;
    for (let k = 0; k < gradini; k++) {
      scatola(m, 'calce', [xs + k * pedata, xs + (k + 1) * pedata], [0, (k + 1) * alzata], [-4, -2.85]);
    }
    const xp = xs + gradini * pedata; // inizio pianerottolo
    scatola(m, 'calce', [xp, xp + 2], [0, 3.9], [-4, -2.85]);
    m.estrusione(
      'calce',
      [
        [xs, 0],
        [xp + 2, 0],
        [xp + 2, 4.8],
        [xp, 4.8],
        [xs, 0.9],
      ],
      { asse: 'z', da: -2.85, a: -2.6 },
    );
    scatola(m, 'calce', [xp + 1.75, xp + 2], [3.9, 4.8], [-4, -2.85]);

    // Aperture del corpo principale.
    apertura(m, 'legno', '+z', cz2, [xp + 0.4, xp + 1.5], [3.9, 6.3]); // porta al piano nobile
    apertura(m, 'legno', '+z', cz2, [0.6, 2.0], [0, 2.5]);
    apertura(m, 'legno', '+z', cz2, [3.6, 5.0], [0, 2.5]);
    finestra(m, '+z', cz2, 1.3, 5.0, 1.0, 1.4);
    finestra(m, '+z', cz2, 4.3, 5.0, 1.0, 1.4);
    finestra(m, '-x', cx1, -9.5, 5.0, 1.0, 1.4);
    finestra(m, '-x', cx1, -6.5, 5.0, 1.0, 1.4);
    finestra(m, '-z', cz1, -5, 5.0, 1.0, 1.4);
    finestra(m, '-z', cz1, 0, 5.0, 1.0, 1.4);
    finestra(m, '-z', cz1, 4, 5.0, 1.0, 1.4);

    // Torre colombaia: base a scarpa, cornice, merli e fori per i colombi.
    const [tx1, tx2, tz1, tz2] = [7, 12.5, -12, -6.5];
    const tcx = (tx1 + tx2) / 2;
    const tcz = (tz1 + tz2) / 2;
    const lt = tx2 - tx1;
    m.sezioni(
      'calce',
      [
        [lt + 0.6, lt + 0.6, 0],
        [lt, lt, 2.4],
        [lt, lt, 10.6],
      ],
      { x: tcx, z: tcz, fondo: false, cima: false },
    );
    m.sezioni(
      'pietra',
      [
        [lt, lt, 10.6],
        [lt + 0.35, lt + 0.35, 10.6],
        [lt + 0.35, lt + 0.35, 10.85],
      ],
      { x: tcx, z: tcz, fondo: false },
    );
    const merlo = 0.9;
    for (const [fx, fz] of [
      [0, 0],
      [0.5, 0],
      [1, 0],
      [1, 0.5],
      [1, 1],
      [0.5, 1],
      [0, 1],
      [0, 0.5],
    ]) {
      const mx = tx1 + merlo / 2 + fx * (lt - merlo);
      const mz = tz1 + merlo / 2 + fz * (lt - merlo);
      scatola(m, 'calce', [mx - merlo / 2, mx + merlo / 2], [10.85, 11.75], [mz - merlo / 2, mz + merlo / 2]);
    }
    const foro = 0.3;
    for (let riga = 0; riga < 3; riga++) {
      const y = 8.7 + riga * 0.55;
      const sfasa = riga % 2 ? 0.35 : 0;
      for (let k = -2; k <= 2; k++) {
        const u = k * 0.75 + sfasa;
        if (Math.abs(u) > 2.0) continue;
        apertura(m, 'legno', '+z', tz2, [tcx + u - foro / 2, tcx + u + foro / 2], [y, y + foro], 0.05);
        apertura(m, 'legno', '+x', tx2, [tcz + u - foro / 2, tcz + u + foro / 2], [y, y + foro], 0.05);
        apertura(m, 'legno', '-x', tx1, [tcz + u - foro / 2, tcz + u + foro / 2], [y, y + foro], 0.05);
      }
    }
    finestra(m, '+z', tz2, tcx, 5.4, 0.8, 1.2);

    // Rimessa addossata al muro di cinta, con tetto a una falda in chiancarelle.
    const [rx1, rx2, rz1, rz2] = [-14.3, -10.3, -2, 9];
    const falda = (x) => 3.35 + ((rx2 - x) * 0.95) / (rx2 - rx1);
    m.estrusione(
      'calce',
      [
        [-15, 0],
        [rx2, 0],
        [rx2, falda(rx2)],
        [-15, falda(-15)],
      ],
      { asse: 'z', da: rz1, a: rz2 },
    );
    m.estrusione(
      'chiancarelle',
      [
        [-15, falda(-15)],
        [rx2 + 0.35, falda(rx2 + 0.35)],
        [rx2 + 0.35, falda(rx2 + 0.35) + 0.22],
        [-15, falda(-15) + 0.22],
      ],
      { asse: 'z', da: rz1 - 0.35, a: rz2 + 0.35 },
    );
    apertura(m, 'legno', '+x', rx2, [0.2, 1.9], [0, 2.4]);
    apertura(m, 'legno', '+x', rx2, [5.2, 6.9], [0, 2.4]);

    // Pozzo nella corte.
    m.rivoluzione(
      'pietra',
      [
        [0.9, 0],
        [0.9, 0.9],
        [1.02, 0.9],
        [1.02, 1.08],
      ],
      { x: -4.5, z: 4, segmenti: 20, fondo: false },
    );
    m.rivoluzione(
      'legno',
      [
        [0.8, 1.08],
        [0.8, 1.13],
      ],
      { x: -4.5, z: 4, segmenti: 20, fondo: false },
    );
  });
  return m;
}

// --- Trullo a tre coni ---------------------------------------------------------------

function trullo() {
  const m = new Modello();
  const y0 = plinto(m, 20, 16);
  const caso = casuale(20260929);

  const cono = ({ x, z, raggio, hMuro, hCono, segmenti }) => {
    // Base cilindrica imbiancata e cordolo di gronda.
    m.rivoluzione(
      'calce',
      [
        [raggio, 0],
        [raggio, hMuro],
      ],
      { x, z, segmenti, fondo: false },
    );
    m.rivoluzione(
      'calce',
      [
        [raggio + 0.12, hMuro],
        [raggio + 0.12, hMuro + 0.22],
      ],
      { x, z, segmenti },
    );
    // Cono in pietra a secco, leggermente bombato.
    const base = hMuro + 0.22;
    const r0 = raggio - 0.12;
    const bande = 8;
    const profilo = [];
    for (let i = 0; i <= bande; i++) {
      const t = (i / bande) * 0.93;
      profilo.push([Math.max(0.3, r0 * (1 - t) * (1 + 0.22 * t)), base + t * hCono]);
    }
    m.rivoluzione('chiancarelle', profilo, { x, z, segmenti, fondo: false });
    // Pinnacolo in calce.
    const yt = profilo[profilo.length - 1][1];
    const pinnacolo = [
      [0.42, 0],
      [0.42, 0.3],
      [0.2, 0.4],
      [0.2, 0.55],
      [0.5, 0.62],
      [0.5, 0.72],
      [0.22, 0.8],
      [0.3, 0.92],
      [0.3, 1.06],
      [0.16, 1.2],
      [0, 1.24],
    ].map(([r, y]) => [r * (raggio / 3.1) ** 0.5, yt + y * (raggio / 3.1) ** 0.5]);
    m.rivoluzione('calce', pinnacolo, { x, z, segmenti: 12, fondo: false });
  };

  m.con({ y: y0 }, () => {
    // Vialetto dal varco del muretto alla porta.
    scatola(m, 'pietra', [-0.9, 0.9], [0, 0.05], [1.6, 7.2]);

    cono({ x: 0, z: -1.2, raggio: 3.1, hMuro: 2.6, hCono: 5.4, segmenti: 24 });
    cono({ x: -4.5, z: 0.2, raggio: 2.3, hMuro: 2.4, hCono: 4.0, segmenti: 20 });
    cono({ x: 4.3, z: 0.6, raggio: 2.0, hMuro: 2.3, hCono: 3.6, segmenti: 20 });

    // Porta con architrave e due finestrelle, appoggiate alle pareti curve.
    aperturaCurva(m, 'legno', [0, -1.2, 3.1], [-0.55, 0.55], [0, 2.0], 0.07);
    aperturaCurva(m, 'pietra', [0, -1.2, 3.1], [-0.75, 0.75], [2.0, 2.22], 0.1);
    aperturaCurva(m, 'legno', [-4.5, 0.2, 2.3], [-0.3, 0.3], [1.2, 1.75], 0.05);
    aperturaCurva(m, 'legno', [4.3, 0.6, 2.0], [-0.25, 0.25], [1.2, 1.7], 0.05);

    // Muretto a secco: tratti di altezza irregolare, più larghi alla base.
    const [mx, mz, sp] = [9.2, 7.2, 0.62];
    const varco = 1.3;
    const tratto = (asse, fisso, da, a) => {
      let u = da;
      while (u < a - 1e-6) {
        const lung = Math.min(a - u, 1.2 + caso() * 0.6);
        const h = 0.95 + (caso() - 0.5) * 0.28;
        const centro = u + lung / 2;
        const sezioni =
          asse === 'x'
            ? [
                [lung, sp, 0],
                [lung, sp * 0.72, h],
              ]
            : [
                [sp, lung, 0],
                [sp * 0.72, lung, h],
              ];
        m.sezioni('pietra', sezioni, asse === 'x' ? { x: centro, z: fisso, fondo: false } : { x: fisso, z: centro, fondo: false });
        u += lung;
      }
    };
    tratto('x', -mz, -mx, mx);
    tratto('x', mz, -mx, -varco);
    tratto('x', mz, varco, mx);
    tratto('z', -mx, -mz + sp / 2, mz - sp / 2);
    tratto('z', mx, -mz + sp / 2, mz - sp / 2);
  });
  return m;
}

// --- Chiesetta rurale ------------------------------------------------------------------

function chiesetta() {
  const m = new Modello();
  const y0 = plinto(m, 13, 22);

  m.con({ y: y0, z: 0.1 }, () => {
    const [x1, x2, zf, zr] = [-3.6, 3.6, 6.0, -7.0];
    const gronda = 5.4;
    const colmo = 7.4;
    const pendenza = (colmo - gronda) / x2;

    // Navata con timpano posteriore.
    m.estrusione(
      'calce',
      [
        [x1, 0],
        [x2, 0],
        [x2, gronda],
        [0, colmo],
        [x1, gronda],
      ],
      { asse: 'z', da: zr, a: zf },
    );
    // Tetto a due falde con sporto di gronda.
    const sporto = 0.45;
    const sp = 0.22;
    const yg = gronda - sporto * pendenza;
    m.estrusione(
      'chiancarelle',
      [
        [x1 - sporto, yg],
        [0, colmo],
        [x2 + sporto, yg],
        [x2 + sporto, yg + sp],
        [0, colmo + sp],
        [x1 - sporto, yg + sp],
      ],
      { asse: 'z', da: zr - 0.35, a: zf },
    );

    // Facciata a capanna, più larga e più alta della navata, con lesene d'angolo.
    const zF = zf + 0.6;
    m.estrusione(
      'calce',
      [
        [-4.0, 0],
        [4.0, 0],
        [4.0, 5.75],
        [0, 8.1],
        [-4.0, 5.75],
      ],
      { asse: 'z', da: zf, a: zF },
    );
    for (const s of [-1, 1]) {
      scatola(m, 'pietra', s < 0 ? [-4.1, -3.45] : [3.45, 4.1], [0, 5.75], [zF - 0.1, zF + 0.1]);
    }
    // Cornice inclinata del timpano.
    for (const s of [-1, 1]) {
      m.estrusione(
        'pietra',
        [
          [s * 4.15, 5.66],
          [0, 8.08],
          [0, 8.3],
          [s * 4.15, 5.88],
        ],
        { asse: 'z', da: zf - 0.05, a: zF + 0.12 },
      );
    }

    // Portale: stipiti e architrave in pietra, porta in legno arretrata.
    apertura(m, 'legno', '+z', zF, [-0.8, 0.8], [0, 2.9], 0.05);
    scatola(m, 'pietra', [-1.15, -0.8], [0, 2.9], [zF - 0.03, zF + 0.16]);
    scatola(m, 'pietra', [0.8, 1.15], [0, 2.9], [zF - 0.03, zF + 0.16]);
    scatola(m, 'pietra', [-1.3, 1.3], [2.9, 3.35], [zF - 0.03, zF + 0.2]);

    // Rosone.
    m.con({ y: 5.3, z: zF - 0.03, rotX: Math.PI / 2 }, () => {
      m.rivoluzione(
        'pietra',
        [
          [0.72, 0],
          [0.72, 0.1],
        ],
        { segmenti: 20 },
      );
      m.rivoluzione(
        'legno',
        [
          [0.5, 0],
          [0.5, 0.14],
        ],
        { segmenti: 20 },
      );
    });

    // Campanile a vela sul colmo della facciata, con campana e croce.
    const [vz1, vz2] = [zf + 0.05, zF - 0.05];
    scatola(m, 'calce', [-1.0, 1.0], [7.2, 8.6], [vz1, vz2]);
    scatola(m, 'calce', [-1.0, -0.5], [8.6, 9.8], [vz1, vz2]);
    scatola(m, 'calce', [0.5, 1.0], [8.6, 9.8], [vz1, vz2]);
    scatola(m, 'pietra', [-1.12, 1.12], [9.8, 10.05], [vz1 - 0.08, vz2 + 0.08]);
    m.estrusione(
      'calce',
      [
        [-1.0, 10.05],
        [1.0, 10.05],
        [0, 10.55],
      ],
      { asse: 'z', da: vz1, a: vz2 },
    );
    m.rivoluzione(
      'legno',
      [
        [0.3, 8.85],
        [0.27, 8.95],
        [0.19, 9.3],
        [0.1, 9.45],
        [0, 9.5],
      ],
      { z: (vz1 + vz2) / 2, segmenti: 12 },
    );
    const zc = (vz1 + vz2) / 2;
    scatola(m, 'legno', [-0.05, 0.05], [10.45, 11.25], [zc - 0.05, zc + 0.05]);
    scatola(m, 'legno', [-0.25, 0.25], [10.93, 11.03], [zc - 0.05, zc + 0.05]);

    // Abside semicircolare con copertura a mezzo cono.
    m.rivoluzione(
      'calce',
      [
        [2.6, 0],
        [2.6, 4.4],
      ],
      { z: zr, segmenti: 12, da: Math.PI / 2, a: (Math.PI * 3) / 2, fondo: false, cima: false, tagli: false },
    );
    m.rivoluzione(
      'chiancarelle',
      [
        [2.85, 4.25],
        [2.85, 4.45],
        [0.0, 6.1],
      ],
      { z: zr, segmenti: 12, da: Math.PI / 2, a: (Math.PI * 3) / 2, tagli: false },
    );

    // Monofore sui fianchi.
    for (const zz of [-4.2, -0.6, 3.0]) {
      apertura(m, 'legno', '+x', x2, [zz - 0.25, zz + 0.25], [3.1, 4.5], 0.06);
      apertura(m, 'legno', '-x', x1, [zz - 0.25, zz + 0.25], [3.1, 4.5], 0.06);
    }

    // Sagrato a due gradini.
    scatola(m, 'pietra', [-4.6, 4.6], [0, 0.3], [zF, 9.0]);
    scatola(m, 'pietra', [-2.4, 2.4], [0, 0.15], [9.0, 9.8]);
  });
  return m;
}

// --- Palazzetto sul porto ----------------------------------------------------------------

function palazzetto() {
  const m = new Modello();
  const y0 = plinto(m, 17, 15);

  m.con({ y: y0, z: -1 }, () => {
    const [x1, x2, z1, z2] = [-6.5, 6.5, -5, 4];

    // Banchina lastricata con due bitte.
    scatola(m, 'pietra', [-8.2, 8.2], [0, 0.05], [z2, 8.3]);
    for (const bx of [-4.6, 4.6]) {
      m.rivoluzione(
        'legno',
        [
          [0.2, 0],
          [0.2, 0.42],
          [0.3, 0.5],
          [0.3, 0.6],
          [0.0, 0.64],
        ],
        { x: bx, z: 7.4, segmenti: 12, fondo: false },
      );
    }

    // Piano terra in pietra, marcapiano, piano nobile in calce, cornicione modanato.
    scatola(m, 'pietra', [x1, x2], [0, 4.0], [z1, z2]);
    scatola(m, 'pietra', [x1 - 0.12, x2 + 0.12], [4.0, 4.25], [z1 - 0.12, z2 + 0.12]);
    scatola(m, 'calce', [x1, x2], [4.25, 8.3], [z1, z2]);
    const L = x2 - x1;
    const P = z2 - z1;
    m.sezioni(
      'pietra',
      [
        [L + 0.1, P + 0.1, 8.3],
        [L + 0.1, P + 0.1, 8.45],
        [L + 0.8, P + 0.8, 8.62],
        [L + 0.8, P + 0.8, 8.85],
      ],
      { x: 0, z: (z1 + z2) / 2 },
    );
    // Parapetto del terrazzo.
    const sp = 0.3;
    const [yp1, yp2] = [8.85, 9.55];
    scatola(m, 'calce', [x1, x2], [yp1, yp2], [z2 - sp, z2]);
    scatola(m, 'calce', [x1, x2], [yp1, yp2], [z1, z1 + sp]);
    scatola(m, 'calce', [x1, x1 + sp], [yp1, yp2], [z1 + sp, z2 - sp]);
    scatola(m, 'calce', [x2 - sp, x2], [yp1, yp2], [z1 + sp, z2 - sp]);
    // Torretta della scala e comignolo.
    scatola(m, 'calce', [-5.2, -2.6], [yp1, 11.1], [-4.4, -1.8]);
    scatola(m, 'pietra', [-5.35, -2.45], [11.1, 11.3], [-4.55, -1.65]);
    apertura(m, 'legno', '+z', -1.8, [-4.4, -3.4], [yp1, yp1 + 2.0], 0.06);
    scatola(m, 'pietra', [3.4, 4.1], [yp1, 10.6], [-3.6, -2.9]);
    scatola(m, 'pietra', [3.25, 4.25], [10.6, 10.8], [-3.75, -2.75]);

    // Facciata sul porto: portale, finestre, porte-finestre con cornici, balcone.
    apertura(m, 'legno', '+z', z2, [-0.9, 0.9], [0, 3.0], 0.05);
    scatola(m, 'pietra', [-1.25, -0.9], [0, 3.0], [z2 - 0.03, z2 + 0.16]);
    scatola(m, 'pietra', [0.9, 1.25], [0, 3.0], [z2 - 0.03, z2 + 0.16]);
    scatola(m, 'pietra', [-1.4, 1.4], [3.0, 3.4], [z2 - 0.03, z2 + 0.2]);
    for (const fx of [-3.9, 3.9]) finestra(m, '+z', z2, fx, 1.2, 0.95, 1.5);
    for (const fx of [-3.9, 0, 3.9]) {
      apertura(m, 'legno', '+z', z2, [fx - 0.55, fx + 0.55], [4.55, 7.05], 0.06);
      scatola(m, 'pietra', [fx - 0.8, fx + 0.8], [7.15, 7.4], [z2 - 0.03, z2 + 0.18]);
    }
    for (const fx of [-3.9, 3.9]) {
      // Balconcini con ringhiera piena.
      scatola(m, 'pietra', [fx - 0.75, fx + 0.75], [4.35, 4.5], [z2, z2 + 0.45], { fondo: true });
      scatola(m, 'legno', [fx - 0.7, fx + 0.7], [4.5, 5.3], [z2 + 0.36, z2 + 0.41]);
    }
    // Balcone centrale con mensole e ringhiera.
    const [bx1, bx2, bz] = [-1.6, 1.6, z2 + 1.1];
    scatola(m, 'pietra', [bx1, bx2], [4.3, 4.48], [z2, bz], { fondo: true });
    for (const mx of [-1.25, 1.25]) {
      m.sezioni(
        'pietra',
        [
          [0.25, 0.25, 3.95],
          [0.25, 0.9, 4.3],
        ],
        { x: mx, z: z2 + 0.12, fondo: true, cima: false },
      );
    }
    const hr = 5.4;
    scatola(m, 'legno', [bx1, bx2], [hr, hr + 0.08], [bz - 0.1, bz - 0.02]);
    scatola(m, 'legno', [bx1, bx1 + 0.08], [hr, hr + 0.08], [z2, bz - 0.1]);
    scatola(m, 'legno', [bx2 - 0.08, bx2], [hr, hr + 0.08], [z2, bz - 0.1]);
    for (let k = 0; k <= 12; k++) {
      const bx = bx1 + 0.04 + (k * (bx2 - bx1 - 0.08)) / 12;
      scatola(m, 'legno', [bx - 0.025, bx + 0.025], [4.48, hr], [bz - 0.08, bz - 0.04]);
    }
    for (const bx of [bx1 + 0.04, bx2 - 0.04]) {
      for (const bz2 of [z2 + 0.35, z2 + 0.7]) {
        scatola(m, 'legno', [bx - 0.025, bx + 0.025], [4.48, hr], [bz2 - 0.025, bz2 + 0.025]);
      }
    }

    // Fianchi e retro.
    for (const zz of [-2.6, 1.6]) {
      finestra(m, '-x', x1, zz, 1.3, 0.9, 1.4);
      finestra(m, '+x', x2, zz, 1.3, 0.9, 1.4);
      finestra(m, '-x', x1, zz, 5.0, 0.95, 1.8);
      finestra(m, '+x', x2, zz, 5.0, 0.95, 1.8);
    }
    for (const fx of [-3.9, 0, 3.9]) finestra(m, '-z', z1, fx, 5.0, 0.95, 1.8);
    apertura(m, 'legno', '-z', z1, [-0.7, 0.7], [0, 2.6], 0.06);
  });
  return m;
}

/** Catalogo interno: slug → funzione che disegna la forma (in metri reali). */
export const FORME = Object.freeze({
  'masseria-del-segnaposto': masseria,
  'trullo-di-prova': trullo,
  'chiesetta-rurale': chiesetta,
  'palazzetto-sul-porto': palazzetto,
});
