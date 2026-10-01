// Rotazione collegata fra modello 3D e plastico: girando il modello (dito, mouse, tastiera)
// il plastico mostra la foto presa dallo stesso lato, e girando il plastico si sposta la
// camera del modello. Anche la rotazione automatica del plastico trascina il modello.
//
// Convenzioni (verificate sul codice di model-viewer 4.3.1 e sui frame dei segnaposto):
// - model-viewer: l'azimut θ della camera cresce in senso antiorario visto dall'alto;
//   θ = 0 è la camera di fronte al modello (sull'asse +Z, la facciata "di fronte").
// - turntable: l'angolo a cresce quando l'oggetto gira in senso antiorario visto dall'alto;
//   a = 0 è il frame 001, la vista frontale.
// Girare l'oggetto di a con la camera ferma equivale a spostare la camera di −a: a = −θ.
// "allineamento" (per opera, in data/opere.json) corregge un frame 001 che non mostra
// esattamente la stessa facciata del modello.
//
// Niente rimbalzi: model-viewer segnala come 'user-interaction' solo i gesti dell'utente
// (i cambi di camera fatti da qui arrivano come 'none'), e impostaAngolo() del turntable
// non riemette 'turntable-rotazione'.

import type { ModelViewerElement } from '@google/model-viewer';

/** L'interfaccia pubblica di <turntable-plastico> (src/scripts/turntable.ts) usata qui. */
interface TurntableCollegabile extends HTMLElement {
  readonly angoloAttuale: number;
  readonly toccato: boolean;
  impostaAngolo(gradi: number, opzioni?: { interazione?: boolean }): void;
}

const GRADI_PER_RADIANTE = 180 / Math.PI;

async function collega(tavola: HTMLElement) {
  const visore = tavola.querySelector<ModelViewerElement>('model-viewer');
  const plastico = tavola.querySelector<TurntableCollegabile>('turntable-plastico');
  if (!visore || !plastico) return;
  const allineamento = Number(plastico.dataset.allineamento ?? 0) || 0;

  await Promise.all([customElements.whenDefined('model-viewer'), customElements.whenDefined('turntable-plastico')]);

  const angoloDalModello = () => -visore.getCameraOrbit().theta * GRADI_PER_RADIANTE + allineamento;

  /** Porta la camera del modello all'azimut corrispondente all'angolo del plastico. */
  const giraModello = (angolo: number) => {
    if (!visore.loaded) return;
    const { phi, radius } = visore.getCameraOrbit();
    // model-viewer sceglie da solo la strada più breve fra l'azimut attuale e quello nuovo.
    const theta = -(angolo - allineamento) / GRADI_PER_RADIANTE;
    visore.cameraOrbit = `${theta}rad ${phi}rad ${radius}m`;
  };

  // Modello → plastico: solo i gesti dell'utente (anche l'inerzia che segue il rilascio).
  visore.addEventListener('camera-change', (evento) => {
    const { source } = (evento as unknown as CustomEvent<{ source: string }>).detail;
    if (source === 'user-interaction') plastico.impostaAngolo(angoloDalModello());
  });

  // Pulsanti della vista (src/scripts/modello.ts): contano come un gesto dell'utente. La vista
  // iniziale cambia anche l'azimut: il plastico la segue.
  visore.addEventListener('3db:comando-camera', (evento) => {
    const { azimutGradi } = (evento as CustomEvent<{ azimutGradi?: number }>).detail;
    plastico.impostaAngolo(
      azimutGradi === undefined || Number.isNaN(azimutGradi) ? plastico.angoloAttuale : -azimutGradi + allineamento,
    );
  });

  // Plastico → modello: trascinamento, inerzia, tastiera e rotazione automatica.
  plastico.addEventListener('turntable-rotazione', (evento) => {
    giraModello((evento as CustomEvent<{ angolo: number }>).detail.angolo);
  });

  // Al caricamento del modello si parte allineati: se l'utente ha già girato il plastico
  // segue il modello, altrimenti il plastico si porta sulla vista iniziale del modello.
  const allinea = () => {
    if (plastico.toccato) giraModello(plastico.angoloAttuale);
    else plastico.impostaAngolo(angoloDalModello(), { interazione: false });
  };
  if (visore.loaded) allinea();
  else visore.addEventListener('load', allinea, { once: true });
}

document.querySelectorAll<HTMLElement>('[data-rotazione-collegata]').forEach((tavola) => void collega(tavola));
