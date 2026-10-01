// Modello digitale: carica <model-viewer> (@google/model-viewer 4.3.1) e collega gli eventi.
//
// Il pacchetto (con three.js dentro, circa 1 MB) viene importato dinamicamente e solo se
// nella pagina c'è davvero un <model-viewer>: le opere con il segnaposto "Modello in
// lavorazione" e il resto del sito non lo scaricano.
//
// Contratto con il turntable del plastico: al primo modello caricato si imposta
// window.__3dbModelloCaricato e si emette l'evento globale '3db:modello-caricato',
// così i frame del plastico si precaricano senza rubare banda al modello.
// Contratto con il pulsante AR (ar.ts): se il modello o il pacchetto non si caricano si imposta
// window.__3dbModelloErrore e si emette '3db:modello-errore' (l'AR non potrebbe partire).

import urlWrapperDraco from 'three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js?url';
import urlWasmDraco from 'three/examples/jsm/libs/draco/gltf/draco_decoder.wasm?url';

declare global {
  interface Window {
    /** true quando il primo modello 3D della pagina ha finito di caricarsi. */
    __3dbModelloCaricato?: boolean;
    /** true se il modello 3D (o il pacchetto di model-viewer) non si è potuto caricare. */
    __3dbModelloErrore?: boolean;
    /** Configurazione globale letta da model-viewer quando crea il primo elemento. */
    ModelViewerElement?: { dracoDecoderLocation?: string; meshoptDecoderLocation?: string };
  }
}

const MESSAGGIO_ERRORE = 'Non è stato possibile caricare il modello 3D.';

function segnalaModelloCaricato() {
  if (window.__3dbModelloCaricato) return;
  window.__3dbModelloCaricato = true;
  window.dispatchEvent(new CustomEvent('3db:modello-caricato'));
}

function segnalaErrore(visore: HTMLElement) {
  const avviso = visore.parentElement?.querySelector<HTMLElement>('[data-modello-errore]');
  if (avviso) avviso.textContent = MESSAGGIO_ERRORE;
  if (window.__3dbModelloErrore) return;
  window.__3dbModelloErrore = true;
  window.dispatchEvent(new CustomEvent('3db:modello-errore'));
}

/**
 * Su un computer senza schermo touch la realtà aumentata non esiste: togliamo "webxr" dalle
 * modalità PRIMA che model-viewer si avvii. Così non chiama navigator.xr.isSessionSupported(),
 * che in Chrome esclude la pagina dalla cache avanti/indietro (tornando indietro si ricaricherebbe
 * tutto). Restano i visori (Quest e simili), che non hanno il touch ma hanno l'AR.
 */
function togliWebXrSuComputer(visore: HTMLElement) {
  const conTouch = matchMedia('(any-pointer: coarse)').matches;
  const visoreXR = /OculusBrowser|Pico|Wolvic/i.test(navigator.userAgent);
  if (conTouch || visoreXR) return;
  const modi = (visore.getAttribute('ar-modes') ?? '').split(/\s+/).filter((m) => m && m !== 'webxr');
  visore.setAttribute('ar-modes', modi.join(' '));
}

/**
 * La rotella del mouse sopra il modello scorre la pagina, come nel resto del sito: model-viewer
 * la userebbe sempre per lo zoom, "intrappolando" chi scorre. Si ingrandisce con Ctrl/⌘ + rotella,
 * con il pizzico sul trackpad (arriva come rotella + ctrlKey) o dopo aver cliccato il modello.
 * Il gestore è in fase di cattura sul contenitore: fermando la propagazione l'evento non arriva a
 * model-viewer, e senza preventDefault il browser fa scorrere la pagina.
 */
function rotellaPerLaPagina(visore: HTMLElement) {
  visore.parentElement?.addEventListener(
    'wheel',
    (evento) => {
      if (evento.ctrlKey || evento.metaKey || document.activeElement === visore) return;
      evento.stopPropagation();
    },
    { capture: true, passive: true },
  );
}

/**
 * Decoder serviti dal nostro sito invece che dai CDN di default.
 *
 * Draco: di default model-viewer lo scarica da www.gstatic.com. Qui Vite emette in /_astro/ i due
 * file di three.js con un hash nel nome, ma DRACOLoader chiede nomi fissi ("<cartella>/draco_wasm_wrapper.js"
 * e "<cartella>/draco_decoder.wasm"): indichiamo la cartella e rimappiamo i due nomi con mapURLs(),
 * che agisce sul LoadingManager di three usato sia dal GLTFLoader sia dal DRACOLoader.
 *
 * Meshopt: in model-viewer 4.3.1 il decoder è già nel pacchetto (lo importa da three.js), ma resta
 * spento finché non si imposta meshoptDecoderLocation; a quel punto la libreria carica quello
 * script con un <script> classico e poi usa comunque la copia interna. Lo attiviamo solo per i
 * modelli che lo dichiarano (data-meshopt, rilevato in build) con uno script vuoto: nessun download.
 */
function configuraDecoder(serveMeshopt: boolean) {
  const cartellaDraco = urlWrapperDraco.slice(0, urlWrapperDraco.lastIndexOf('/') + 1);
  window.ModelViewerElement = {
    ...window.ModelViewerElement,
    dracoDecoderLocation: cartellaDraco,
    ...(serveMeshopt ? { meshoptDecoderLocation: 'data:text/javascript,' } : {}),
  };
  return new Map([
    [`${cartellaDraco}draco_wasm_wrapper.js`, urlWrapperDraco],
    [`${cartellaDraco}draco_decoder.wasm`, urlWasmDraco],
  ]);
}

/**
 * Contorno di focus nello stile del sito. Il focus da tastiera va a un <div class="userInput">
 * dentro l'ombra di model-viewer: l'elemento <model-viewer> non corrisponde mai a :focus-visible
 * (verificato in Chrome), quindi il CSS della pagina non basta. Aggiungiamo una regola nella
 * shadow root (aperta, creata una volta sola nel costruttore); se in una versione futura la
 * classe cambia, resta il contorno predefinito del browser.
 */
function stileFocus(visore: HTMLElement) {
  const radice = visore.shadowRoot;
  if (!radice || radice.querySelector('style[data-focus-3db]')) return;
  const stile = document.createElement('style');
  stile.dataset.focus3db = '';
  // Safari prima della 15.4 non conosce :focus-visible: lì il contorno compare con :focus.
  stile.textContent =
    '.userInput:focus-visible { outline: 2px solid var(--petrolio); outline-offset: -2px; }' +
    '@supports not selector(:focus-visible) { .userInput:focus { outline: 2px solid var(--petrolio); outline-offset: -2px; } }';
  radice.append(stile);
}

// --- Comandi della vista (alza/abbassa, zoom, vista iniziale) ----------------------

/** Passo di un tocco su ↑/↓ (gradi di elevazione) e dello zoom (unità di model-viewer.zoom()). */
const PASSO_ELEVAZIONE = 10;
const PASSO_ZOOM = 2;
/** Tenendo premuto un tasto il comando si ripete: attesa iniziale e intervallo (ms). */
const RITARDO_RIPETIZIONE = 380;
const INTERVALLO_RIPETIZIONE = 110;

type Visore = HTMLElement & {
  loaded: boolean;
  cameraOrbit: string;
  fieldOfView: string;
  getCameraOrbit(): { theta: number; phi: number; radius: number };
  zoom(passi: number): void;
};

/**
 * Collega i pulsanti sotto il modello. L'elevazione si cambia sul "punto d'arrivo" dell'ultimo
 * comando (se recente), non sulla posizione attuale ancora in movimento: tenendo premuto il tasto
 * il movimento è continuo invece di rallentare a ogni passo.
 * Ogni comando emette '3db:comando-camera' sul visore: src/scripts/sincronia.ts lo usa per
 * fermare la rotazione automatica del plastico e, per la vista iniziale, per riallinearlo.
 */
function collegaComandi(visore: Visore) {
  const comandi = visore.parentElement?.querySelector<HTMLElement>('[data-comandi]');
  if (!comandi) return;
  const orbitaIniziale = visore.getAttribute('camera-orbit') ?? 'auto auto auto';
  let obiettivo: { phi: number; istante: number } | null = null;

  const segnala = (azimutGradi?: number) =>
    visore.dispatchEvent(new CustomEvent('3db:comando-camera', { detail: { azimutGradi } }));

  const esegui = (comando: string) => {
    if (!visore.loaded) return;
    const orbita = visore.getCameraOrbit();
    switch (comando) {
      case 'su':
      case 'giu': {
        const recente = obiettivo && performance.now() - obiettivo.istante < 600;
        const phi = (recente ? obiettivo!.phi : orbita.phi) + ((comando === 'su' ? -1 : 1) * PASSO_ELEVAZIONE * Math.PI) / 180;
        // I limiti (min/max-camera-orbit) li applica model-viewer; qui si tiene l'obiettivo dentro.
        const limitato = Math.min(Math.max(phi, (10 * Math.PI) / 180), (88 * Math.PI) / 180);
        obiettivo = { phi: limitato, istante: performance.now() };
        visore.cameraOrbit = `${orbita.theta}rad ${limitato}rad ${orbita.radius}m`;
        segnala();
        break;
      }
      case 'avvicina':
      case 'allontana':
        visore.zoom(comando === 'avvicina' ? PASSO_ZOOM : -PASSO_ZOOM);
        segnala();
        break;
      case 'iniziale':
        obiettivo = null;
        visore.cameraOrbit = orbitaIniziale;
        visore.fieldOfView = 'auto';
        segnala(parseFloat(orbitaIniziale));
        break;
    }
  };

  let attesa = 0;
  let ripetizione = 0;
  let ripetuto = false;
  const ferma = () => {
    clearTimeout(attesa);
    clearInterval(ripetizione);
  };

  comandi.addEventListener('pointerdown', (e) => {
    const tasto = (e.target as Element).closest<HTMLElement>('[data-comando]');
    const comando = tasto?.dataset.comando;
    if (!comando || comando === 'iniziale' || (e.pointerType === 'mouse' && e.button !== 0)) return;
    ripetuto = false;
    ferma();
    attesa = window.setTimeout(() => {
      ripetuto = true;
      esegui(comando);
      ripetizione = window.setInterval(() => esegui(comando), INTERVALLO_RIPETIZIONE);
    }, RITARDO_RIPETIZIONE);
  });
  for (const tipo of ['pointerup', 'pointercancel', 'pointerleave'] as const) comandi.addEventListener(tipo, ferma);

  // Un tocco (o Invio/Spazio da tastiera) = un passo; dopo una pressione lunga il click finale non conta.
  comandi.addEventListener('click', (e) => {
    const comando = (e.target as Element).closest<HTMLElement>('[data-comando]')?.dataset.comando;
    if (!comando) return;
    if (ripetuto) {
      ripetuto = false;
      return;
    }
    esegui(comando);
  });

  const mostra = () => (comandi.hidden = false);
  if (visore.loaded) mostra();
  else visore.addEventListener('load', mostra, { once: true });
}

const visori = Array.from(document.querySelectorAll<HTMLElement>('model-viewer[data-modello]'));

for (const visore of visori) {
  // Gli ascoltatori si possono aggiungere prima che l'elemento sia definito: gli eventi
  // arriveranno allo stesso nodo dopo l'upgrade.
  togliWebXrSuComputer(visore);
  rotellaPerLaPagina(visore);
  visore.addEventListener('load', segnalaModelloCaricato);
  visore.addEventListener('error', (evento) => {
    // Dopo il caricamento può arrivare 'webglcontextlost' (memoria del telefono): il poster o il
    // modello restano visibili e non è un errore di caricamento, quindi non lo segnaliamo.
    const tipo = (evento as unknown as CustomEvent<{ type?: string }>).detail?.type;
    if (tipo === 'loadfailure') segnalaErrore(visore);
  });
}

if (visori.length > 0) {
  // La configurazione globale va scritta PRIMA dell'import: model-viewer la legge nel costruttore.
  const decoderLocali = configuraDecoder(visori.some((v) => v.hasAttribute('data-meshopt')));

  import('@google/model-viewer')
    .then(({ ModelViewerElement }) => {
      // Il modello comincia a scaricarsi solo dopo l'upgrade (IntersectionObserver, asincrono) e il
      // decoder Draco solo dopo il GLB: la mappa è già attiva quando serve.
      ModelViewerElement.mapURLs((indirizzo) => decoderLocali.get(indirizzo) ?? indirizzo);
      // customElements.define() ha già fatto l'upgrade degli elementi presenti.
      visori.forEach(stileFocus);
      visori.forEach((visore) => collegaComandi(visore as Visore));
    })
    .catch(() => {
      // Pacchetto non scaricato (rete assente, blocco): resta il poster con l'avviso.
      visori.forEach(segnalaErrore);
    });
}
