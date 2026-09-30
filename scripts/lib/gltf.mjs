// Operazioni sul modello glTF con @gltf-transform: I/O con i codec (Draco, Meshopt),
// preparazione dei materiali, orientamento/centratura/scala "cotti" nei vertici,
// statistiche per i report.

import { ImageUtils, Logger, NodeIO, Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsSpecular, KHRMaterialsUnlit } from '@gltf-transform/extensions';
import { clearNodeTransform, flatten, getBounds, transformMesh } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

/** NodeIO con tutte le estensioni e i codec registrati (lettura e scrittura). */
export async function creaIO() {
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  return new NodeIO()
    .setLogger(new Logger(Logger.Verbosity.WARN))
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.encoder': await draco3d.createEncoderModule(),
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'meshopt.encoder': MeshoptEncoder,
      'meshopt.decoder': MeshoptDecoder,
    });
}

export function scenaPrincipale(doc) {
  const root = doc.getRoot();
  const scena = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scena) throw new Error('il modello non contiene nessuna scena');
  return scena;
}

/**
 * Tipi di materiale per un rilievo fotogrammetrico, in cui luci e ombre sono già
 * "cotte" nelle texture: illuminarlo di nuovo le raddoppierebbe (facciate scurite,
 * riflessi finti). Tre varianti:
 *
 *  - 'emissivo' (predefinito): colore nero, texture come emissiva, riflessione speculare
 *    azzerata (KHR_materials_specular = 0). Resta un materiale PBR standard; con
 *    tone-mapping="none" su <model-viewer> il risultato è identico pixel per pixel a un
 *    unlit (model-viewer non applica il tone mapping agli unlit, all'emissiva sì). Motivo:
 *    su iPhone, se manca un file USDZ, model-viewer converte il GLB al volo con
 *    l'USDZExporter di three.js, che esporta SOLO i MeshStandardMaterial: un materiale
 *    KHR_materials_unlit (MeshBasicMaterial) viene scartato e Quick Look mostrerebbe
 *    una scena vuota. L'emissiva invece viene esportata (UsdPreviewSurface.emissiveColor).
 *  - 'unlit': KHR_materials_unlit puro. Colori fedeli su web e (a quanto documentato)
 *    in Scene Viewer, ma su iOS serve un USDZ fatto a parte (campo "usdz" dell'opera).
 *  - 'pbr': materiale PBR opaco (metallic 0, roughness 1) illuminato dalla scena.
 */
/**
 * Colore delle parti senza texture (facce senza coordinate UV, materiali non definiti nel MTL):
 * il bianco del MTL di WebODM (Kd 1 1 1) come luce propria sembrerebbe una macchia luminosa.
 */
const GRIGIO_NEUTRO = [0.52, 0.5, 0.47];

export function preparaMateriali(doc, tipo) {
  const root = doc.getRoot();
  const unlit = tipo === 'unlit' ? doc.createExtension(KHRMaterialsUnlit).createUnlit() : null;
  const estensioneSpeculare = tipo === 'emissivo' ? doc.createExtension(KHRMaterialsSpecular) : null;
  const note = [];

  for (const materiale of root.listMaterials()) {
    // Un rilievo è opaco: se il MTL dichiara trasparenze (d < 1) sono quasi sempre un
    // residuo dell'esportazione, e in BLEND le texture non si potrebbero convertire in JPEG.
    if (materiale.getAlphaMode() !== 'OPAQUE') {
      note.push(`materiale "${materiale.getName()}": trasparenza ignorata (reso opaco)`);
    }
    let [r, g, b] = materiale.getBaseColorFactor();
    if (!materiale.getBaseColorTexture() && r > 0.9 && g > 0.9 && b > 0.9) {
      [r, g, b] = GRIGIO_NEUTRO;
      note.push(`materiale "${materiale.getName()}" senza texture: colorato di grigio neutro`);
    }
    materiale
      .setAlphaMode('OPAQUE')
      .setBaseColorFactor([r, g, b, 1])
      .setMetallicFactor(0)
      .setRoughnessFactor(1)
      .setMetallicRoughnessTexture(null);

    if (tipo === 'unlit') {
      materiale.setExtension('KHR_materials_unlit', unlit);
    } else if (tipo === 'emissivo') {
      const texture = materiale.getBaseColorTexture();
      if (texture) {
        const origine = materiale.getBaseColorTextureInfo();
        materiale.setEmissiveTexture(texture);
        const destinazione = materiale.getEmissiveTextureInfo();
        destinazione
          .setTexCoord(origine.getTexCoord())
          .setWrapS(origine.getWrapS())
          .setWrapT(origine.getWrapT())
          .setMagFilter(origine.getMagFilter())
          .setMinFilter(origine.getMinFilter());
        materiale.setEmissiveFactor([1, 1, 1]).setBaseColorTexture(null);
      } else {
        materiale.setEmissiveFactor([r, g, b]);
      }
      materiale
        .setBaseColorFactor([0, 0, 0, 1])
        .setExtension('KHR_materials_specular', estensioneSpeculare.createSpecular().setSpecularFactor(0));
    }
  }
  return note;
}

/** true se almeno una primitiva triangolare non ha le normali. */
export function mancanoNormali(doc) {
  return doc
    .getRoot()
    .listMeshes()
    .some((mesh) => mesh.listPrimitives().some((p) => p.getMode() === Primitive.Mode.TRIANGLES && !p.getAttribute('NORMAL')));
}

/**
 * Normali "morbide" (media delle facce adiacenti, pesata sull'area) per le primitive che
 * non le hanno. Non usiamo normals() di glTF-Transform perché separa tutti i vertici
 * (normali piatte): i vertici triplicano e la compressione peggiora. I vertici con la
 * stessa posizione (le cuciture fra isole UV) condividono la normale, così non si vedono
 * spigoli di luce lungo le cuciture.
 */
export function calcolaNormaliMorbide(doc) {
  let calcolate = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitiva of mesh.listPrimitives()) {
      if (primitiva.getMode() !== Primitive.Mode.TRIANGLES || primitiva.getAttribute('NORMAL')) continue;
      const accessorPosizioni = primitiva.getAttribute('POSITION');
      const posizioni = accessorPosizioni.getArray();
      if (!(posizioni instanceof Float32Array)) throw new Error('posizioni quantizzate: calcolare le normali prima della compressione');
      const n = accessorPosizioni.getCount();
      const indici = primitiva.getIndices()?.getArray() ?? Uint32Array.from({ length: n }, (_, i) => i);

      // Raggruppa i vertici per posizione identica (confronto sui bit dei float32).
      const bit = new Uint32Array(posizioni.buffer, posizioni.byteOffset, n * 3);
      const gruppi = new Int32Array(n);
      const chiavi = new Map();
      for (let i = 0; i < n; i++) {
        const chiave = `${bit[3 * i]},${bit[3 * i + 1]},${bit[3 * i + 2]}`;
        let g = chiavi.get(chiave);
        if (g === undefined) chiavi.set(chiave, (g = chiavi.size));
        gruppi[i] = g;
      }
      const somma = new Float64Array(chiavi.size * 3);
      for (let t = 0; t + 2 < indici.length; t += 3) {
        const a = 3 * indici[t];
        const b = 3 * indici[t + 1];
        const c = 3 * indici[t + 2];
        const ux = posizioni[b] - posizioni[a], uy = posizioni[b + 1] - posizioni[a + 1], uz = posizioni[b + 2] - posizioni[a + 2];
        const vx = posizioni[c] - posizioni[a], vy = posizioni[c + 1] - posizioni[a + 1], vz = posizioni[c + 2] - posizioni[a + 2];
        // Prodotto vettoriale non normalizzato: il modulo è il doppio dell'area (peso).
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const v of [indici[t], indici[t + 1], indici[t + 2]]) {
          const g = 3 * gruppi[v];
          somma[g] += nx;
          somma[g + 1] += ny;
          somma[g + 2] += nz;
        }
      }
      const normali = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const g = 3 * gruppi[i];
        const lunghezza = Math.hypot(somma[g], somma[g + 1], somma[g + 2]);
        if (lunghezza > 0) {
          normali[3 * i] = somma[g] / lunghezza;
          normali[3 * i + 1] = somma[g + 1] / lunghezza;
          normali[3 * i + 2] = somma[g + 2] / lunghezza;
        } else {
          normali[3 * i + 1] = 1; // vertice isolato o triangoli degeneri
        }
      }
      primitiva.setAttribute(
        'NORMAL',
        doc.createAccessor().setType('VEC3').setArray(normali).setBuffer(accessorPosizioni.getBuffer()),
      );
      calcolate++;
    }
  }
  return calcolate;
}

function matriceRotazioneY(gradi) {
  const a = (gradi * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // Colonna per colonna (gl-matrix / glTF): rotazione antioraria vista dall'alto (+Y).
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

function matriceScalaTraslazione(scala, [tx, ty, tz]) {
  // v' = scala · (v + t)
  return [scala, 0, 0, 0, 0, scala, 0, 0, 0, 0, scala, 0, scala * tx, scala * ty, scala * tz, 1];
}

/**
 * Porta nei vertici tutte le trasformazioni: quelle dei nodi, la rotazione attorno a Y,
 * la centratura (centro in X/Z, base a Y = 0) e la SCALA DA PLASTICO, in modo che il lato
 * maggiore della base (max fra ampiezza X e Z) misuri `latoBaseMetri`.
 *
 * Perché "cuocere" la scala nel file: in AR model-viewer usa la scala reale del GLB;
 * Scene Viewer (Android) riceve solo l'URL del file e ignora qualunque scala impostata
 * nella pagina; Quick Look (iOS) usa l'USDZ, generato dallo stesso GLB. Solo se la scala
 * è nel file le tre modalità mostrano lo stesso plastico da tavolo.
 */
export async function orientaCentraScala(doc, { rotazioneGradi = 0, latoBaseMetri }) {
  // flatten(): ogni nodo con mesh diventa figlio diretto della scena, con la sua
  // trasformazione del mondo; clearNodeTransform() la porta poi dentro i vertici.
  await doc.transform(flatten());
  const scena = scenaPrincipale(doc);
  const nodi = [];
  scena.traverse((nodo) => {
    if (nodo.getMesh()) nodi.push(nodo);
  });
  if (nodi.length === 0) throw new Error('il modello non contiene geometria');

  // Una mesh condivisa da più nodi verrebbe trasformata più volte: la duplichiamo.
  const viste = new Set();
  for (const nodo of nodi) {
    const mesh = nodo.getMesh();
    if (viste.has(mesh)) nodo.setMesh(mesh.clone());
    viste.add(nodo.getMesh());
  }
  for (const nodo of nodi) clearNodeTransform(nodo);
  const mesh = [...new Set(nodi.map((n) => n.getMesh()))];

  const rotazione = ((rotazioneGradi % 360) + 360) % 360;
  if (rotazione !== 0) for (const m of mesh) transformMesh(m, matriceRotazioneY(rotazione));

  const prima = getBounds(scena);
  const ampiezza = [0, 1, 2].map((i) => prima.max[i] - prima.min[i]);
  const latoBase = Math.max(ampiezza[0], ampiezza[2]);
  if (!(latoBase > 0)) throw new Error('il modello ha base nulla (tutti i vertici allineati?)');
  const scala = latoBaseMetri / latoBase;
  const traslazione = [-(prima.min[0] + prima.max[0]) / 2, -prima.min[1], -(prima.min[2] + prima.max[2]) / 2];
  for (const m of mesh) transformMesh(m, matriceScalaTraslazione(scala, traslazione));

  return { scala, ampiezzaOriginale: ampiezza, latoBaseOriginale: latoBase, bounds: getBounds(scena) };
}

/** Conteggi e texture di un documento (dopo la rilettura del GLB: geometria già decompressa). */
export function statistiche(doc) {
  const root = doc.getRoot();
  let vertici = 0;
  let triangoli = 0;
  let primitive = 0;
  const attributi = new Set();
  for (const mesh of root.listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      primitive++;
      const posizioni = p.getAttribute('POSITION');
      if (!posizioni) continue;
      for (const s of p.listSemantics()) attributi.add(s);
      vertici += posizioni.getCount();
      if (p.getMode() === Primitive.Mode.TRIANGLES) {
        const indici = p.getIndices();
        triangoli += (indici ? indici.getCount() : posizioni.getCount()) / 3;
      }
    }
  }
  const texture = root.listTextures().map((t) => {
    const immagine = t.getImage();
    const dimensioni = immagine ? ImageUtils.getSize(immagine, t.getMimeType()) : null;
    return {
      nome: t.getName() || t.getURI() || '(senza nome)',
      mime: t.getMimeType(),
      larghezza: dimensioni?.[0] ?? 0,
      altezza: dimensioni?.[1] ?? 0,
      byte: immagine?.byteLength ?? 0,
    };
  });
  const scena = scenaPrincipale(doc);
  return {
    vertici,
    triangoli,
    primitive,
    mesh: root.listMeshes().length,
    materiali: root.listMaterials().length,
    attributi: [...attributi].sort(),
    texture,
    byteTexture: texture.reduce((somma, t) => somma + t.byte, 0),
    bounds: getBounds(scena),
  };
}

/** Legge il blocco JSON di un GLB (per controllare estensioni e accessor senza decodificare). */
export function leggiJsonGlb(glb) {
  const vista = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (vista.getUint32(0, true) !== 0x46546c67) throw new Error('non è un file GLB (manca l\'intestazione "glTF")');
  const lunghezza = vista.getUint32(12, true);
  if (vista.getUint32(16, true) !== 0x4e4f534a) throw new Error('GLB senza blocco JSON');
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + lunghezza)));
}
