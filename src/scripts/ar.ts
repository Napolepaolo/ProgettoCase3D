// Realtà aumentata: sotto il riquadro della pagina di dettaglio mostra O il pulsante
// "Vedi nella tua stanza" (dispositivi con AR) O il codice QR che apre la stessa pagina
// sul telefono (computer e browser senza AR).
//
// Il pulsante AR interno di <model-viewer> è soppresso (slot "ar-button" vuoto in
// ModelloDigitale.astro): il nostro pulsante, fuori dal riquadro, chiama activateAR().
//
// Chi decide, in ordine:
//  1. il CSS, senza JavaScript e senza sfarfallio: (pointer: coarse) → pulsante, altrimenti QR;
//  2. una stima immediata qui sotto, che ripete le condizioni di model-viewer 4.3.1
//     (src/constants.ts e $selectARMode in src/features/ar.ts), così lo stato giusto compare
//     prima che arrivi il pacchetto di model-viewer (circa 1 MB);
//  3. modelViewer.canActivateAR, l'autorità. Attenzione: model-viewer lo calcola in modo
//     asincrono (su Android può dipendere da isSessionSupported di WebXR) e non emette eventi
//     quando è pronto; dopo un ar-status "failed" si aggiorna solo DOPO l'evento. Per questo
//     non lo si legge mai una volta sola: si aspetta un po' prima di smentire una stima positiva.
//  4. se il modello non si carica (modello.ts emette '3db:modello-errore'), l'AR non può partire:
//     niente pulsante, solo un messaggio.

import type { ModelViewerElement } from '@google/model-viewer';

type Stato = 'pulsante' | 'qr' | 'assente';

/** Opzioni del pacchetto qrcode: arrivano dalla build (data-qr) per avere lo stesso codice. */
type OpzioniQr = Record<string, unknown>;
interface ModuloQr {
  toString(testo: string, opzioni: OpzioniQr): Promise<string>;
}

interface NavigatorConXR extends Navigator {
  xr?: { isSessionSupported(modalita: string): Promise<boolean> };
}

const TESTO_ATTESA = 'Caricamento del modello…';
const MESSAGGIO_FALLITO = 'Non è stato possibile avviare la realtà aumentata su questo dispositivo.';
const MESSAGGIO_SENZA_MODELLO = 'La realtà aumentata non è disponibile: il modello 3D non si è caricato.';
/** Oltre questo tempo il pulsante torna comunque disponibile. */
const ATTESA_MASSIMA_MS = 60_000;
/** Attesa massima del pacchetto di model-viewer dopo un tocco sul pulsante. */
const ATTESA_PACCHETTO_MS = 20_000;
/** Prima di smentire una stima positiva, si aspetta che canActivateAR si assesti. */
const ASSESTAMENTO_AL_CARICAMENTO_MS = 5000;
const ASSESTAMENTO_AL_TOCCO_MS = 2000;
/** Dopo un'attivazione il pulsante ignora altri tocchi per questo tempo (niente doppie aperture). */
const PAUSA_DOPO_ATTIVAZIONE_MS = 1500;

// --- Stima rapida del supporto AR (stesse regole di model-viewer 4.3.1) ----------------------

const ua = navigator.userAgent;
const IOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/** Chrome, Edge, Firefox, app Google e DuckDuckGo su iOS: Quick Look solo con un USDZ vero (ios-src). */
const IOS_ALTRO_BROWSER = IOS && /CriOS\/|EdgiOS\/|FxiOS\/|GSA\/|DuckDuckGo\//.test(ua);
/** Nell'app Google per iOS model-viewer non attiva mai Quick Look. */
const IOS_APP_GOOGLE = IOS && /GSA\//.test(ua);
const ANDROID = /android/i.test(ua);
const SCENE_VIEWER = ANDROID && !/firefox/i.test(ua) && !/OculusBrowser/.test(ua);
/** Chrome "vero" su Android (non Samsung Internet, Edge, Opera, …). */
const CHROME_ANDROID =
  ANDROID && /Chrome\//.test(ua) && !/SamsungBrowser|EdgA|OPR|YaBrowser|Firefox|UCBrowser|MiuiBrowser|HuaweiBrowser/i.test(ua);
/** Dispositivi su cui l'AR può esistere: touch o visori. Sui computer non si interroga WebXR. */
const PUO_AVERE_AR = matchMedia('(any-pointer: coarse)').matches || /OculusBrowser|Pico|Wolvic/i.test(ua);

/**
 * Quick Look è fra le modalità possibili se è in ar-modes oppure se c'è un USDZ vero (ios-src):
 * ModelloDigitale.astro lo toglie da ar-modes per i GLB unlit senza USDZ.
 */
function quickLookPrevisto(visore: HTMLElement): boolean {
  return visore.hasAttribute('ios-src') || /\bquick-look\b/.test(visore.getAttribute('ar-modes') ?? '');
}

async function stimaSupportoAR(visore: HTMLElement): Promise<boolean> {
  if (IOS && !IOS_APP_GOOGLE && quickLookPrevisto(visore)) {
    const haUsdz = visore.hasAttribute('ios-src');
    const quickLook = IOS_ALTRO_BROWSER ? haUsdz : document.createElement('a').relList.supports('ar');
    if (quickLook) return true;
  }
  if (SCENE_VIEWER) return true;

  // WebXR (visori, browser Android particolari): serve anche l'API di hit test.
  const xr = (navigator as NavigatorConXR).xr;
  const sessione = (window as Window & { XRSession?: { prototype: object } }).XRSession;
  if (PUO_AVERE_AR && xr && sessione && 'requestHitTestSource' in sessione.prototype) {
    try {
      return await xr.isSessionSupported('immersive-ar');
    } catch {
      return false;
    }
  }
  return false;
}

/** Suggerimento per chi è su un telefono senza AR in questo browser. */
function notaSenzaAR(visore: HTMLElement): string {
  if (IOS && !quickLookPrevisto(visore)) {
    return 'Su iPhone e iPad la realtà aumentata di quest’opera non è ancora disponibile.';
  }
  if (IOS) return 'La realtà aumentata non è disponibile in questo browser: apri la pagina con Safari.';
  if (CHROME_ANDROID) {
    return 'Su questo telefono la realtà aumentata non è disponibile (serve «Google Play Services per AR»).';
  }
  if (ANDROID) return 'La realtà aumentata non è disponibile in questo browser: apri la pagina con Chrome.';
  return 'La realtà aumentata non è disponibile su questo browser.';
}

const attendi = (ms: number) => new Promise<void>((risolvi) => setTimeout(risolvi, ms));

/** Risolve true appena `condizione()` è vera, false allo scadere di `ms` (controlla ogni 100 ms). */
async function aspettaChe(condizione: () => boolean, ms: number): Promise<boolean> {
  const fine = performance.now() + ms;
  while (!condizione()) {
    if (performance.now() >= fine) return false;
    await attendi(100);
  }
  return true;
}

/** Scrive l'indirizzo sotto il QR con un punto di a capo (<wbr>) dopo ogni "/", come in PulsanteAR.astro. */
function scriviIndirizzo(elemento: HTMLElement, testo: string) {
  elemento.replaceChildren();
  // Niente lookbehind nelle regex: Safari lo supporta solo dalla 16.4.
  testo
    .replace(/\//g, '/\n')
    .split('\n')
    .filter(Boolean)
    .forEach((parte, i) => {
      if (i > 0) elemento.append(document.createElement('wbr'));
      elemento.append(parte);
    });
}

// --- Una sezione AR -------------------------------------------------------------------------

function inizializza(sezione: HTMLElement) {
  const visore = document.getElementById(sezione.dataset.modello ?? '') as ModelViewerElement | null;
  const pulsante = sezione.querySelector<HTMLButtonElement>('[data-ar-pulsante]');
  const testoPulsante = sezione.querySelector<HTMLElement>('[data-ar-testo]');
  const messaggio = sezione.querySelector<HTMLElement>('[data-ar-messaggio]');
  const codice = sezione.querySelector<HTMLElement>('[data-ar-codice]');
  const indirizzoQr = sezione.querySelector<HTMLElement>('[data-ar-indirizzo]');
  if (!visore || !pulsante || !testoPulsante || !messaggio || !codice || !indirizzoQr) return;

  const testoIniziale = testoPulsante.textContent ?? '';
  const touch = matchMedia('(pointer: coarse)').matches;
  let statoConfermato = false;
  let stimaPositiva = false;
  let notaMostrata = false;
  let qrVerificato = false;
  /** Un'attivazione è in corso (o appena avvenuta): i tocchi successivi vengono ignorati. */
  let occupato = false;
  let chiudiAttesa: (() => void) | null = null;

  const scriviMessaggio = (testo: string, nota = false) => {
    messaggio.textContent = testo;
    notaMostrata = nota && testo !== '';
  };

  /**
   * Il QR generato in build punta all'URL pubblico (SITE_URL). In sviluppo, in un tunnel o in
   * un'anteprima di Netlify l'origine è un'altra: lo rigeneriamo con l'indirizzo corrente,
   * scaricando il pacchetto qrcode solo in questo caso.
   */
  const rigeneraQrSeServe = async () => {
    if (qrVerificato) return;
    qrVerificato = true;
    const pubblico = sezione.dataset.pagina;
    if (!pubblico || new URL(pubblico).origin === location.origin) return;

    const indirizzo = location.href.split('#')[0];
    const leggibile = indirizzo.replace(/^https?:\/\//, '');
    try {
      const modulo = (await import('qrcode')) as unknown as ModuloQr & { default?: ModuloQr };
      const qrcode = modulo.default ?? modulo;
      const opzioni = JSON.parse(sezione.dataset.qr ?? '{}') as OpzioniQr;
      codice.innerHTML = await qrcode.toString(indirizzo, opzioni);
      codice.setAttribute('aria-label', `Codice QR che apre questa pagina sul telefono: ${leggibile}`);
      scriviIndirizzo(indirizzoQr, leggibile);
    } catch {
      // Resta il QR della build: punta comunque alla pagina pubblicata.
    }
  };

  const imposta = (stato: Stato) => {
    sezione.dataset.stato = stato;
    if (stato === 'qr') {
      // Su un telefono il QR è nascosto dal CSS (PulsanteAR.astro): spieghiamo perché non c'è il pulsante.
      if (touch && messaggio.textContent === '') scriviMessaggio(notaSenzaAR(visore), true);
      void rigeneraQrSeServe();
    } else if (stato === 'pulsante' && notaMostrata) {
      scriviMessaggio('');
    }
  };

  const conferma = (stato: Stato) => {
    statoConfermato = true;
    imposta(stato);
  };

  /**
   * Pulsante "in attesa" finché model-viewer lavora. Si usa aria-disabled invece di disabled:
   * un pulsante disabilitato perderebbe il focus della tastiera.
   */
  const apriAttesa = () => {
    if (chiudiAttesa) return;
    pulsante.setAttribute('aria-disabled', 'true');
    pulsante.setAttribute('aria-busy', 'true');
    testoPulsante.textContent = TESTO_ATTESA;

    const controllo = new AbortController();
    const { signal } = controllo;
    const timer = setTimeout(() => chiudiAttesa?.(), ATTESA_MASSIMA_MS);
    chiudiAttesa = () => {
      controllo.abort();
      clearTimeout(timer);
      chiudiAttesa = null;
      pulsante.removeAttribute('aria-disabled');
      pulsante.removeAttribute('aria-busy');
      testoPulsante.textContent = testoIniziale;
    };
    // Fine del lavoro di model-viewer (modello e, su iPhone senza USDZ, conversione) o avvio dell'AR.
    visore.addEventListener(
      'progress',
      (e) => {
        if ((e as unknown as CustomEvent<{ totalProgress: number }>).detail.totalProgress >= 1) chiudiAttesa?.();
      },
      { signal },
    );
    visore.addEventListener('ar-status', () => chiudiAttesa?.(), { signal });
    visore.addEventListener('error', () => chiudiAttesa?.(), { signal });
    // Scene Viewer apre un'altra app: la pagina passa in secondo piano.
    document.addEventListener('visibilitychange', () => document.hidden && chiudiAttesa?.(), { signal });
  };

  /** Il modello non si è caricato: l'AR non può partire (activateAR resterebbe appeso). */
  const senzaModello = () => {
    chiudiAttesa?.();
    conferma('assente');
    scriviMessaggio(MESSAGGIO_SENZA_MODELLO);
  };

  const avviaAR = async () => {
    scriviMessaggio('');
    if (window.__3dbModelloErrore) return senzaModello();

    // Caso normale: tutto pronto. activateAR() va chiamato SUBITO, senza await prima, perché
    // Scene Viewer e Quick Look con ios-src richiedono il gesto dell'utente ancora "fresco".
    if (!customElements.get('model-viewer') || !visore.canActivateAR) {
      // Pacchetto di model-viewer non ancora arrivato (rete lenta) o canActivateAR non ancora
      // assestato: si aspetta, ma non all'infinito, e si esce se il modello fallisce.
      apriAttesa();
      const definito = await Promise.race([
        customElements.whenDefined('model-viewer').then(() => true),
        attendi(ATTESA_PACCHETTO_MS).then(() => false),
      ]);
      if (window.__3dbModelloErrore) return senzaModello();
      if (!definito) {
        chiudiAttesa?.();
        scriviMessaggio(MESSAGGIO_FALLITO);
        return;
      }
      await visore.updateComplete;
      if (!(await aspettaChe(() => visore.canActivateAR, ASSESTAMENTO_AL_TOCCO_MS))) {
        chiudiAttesa?.();
        conferma('qr');
        return;
      }
    }

    // Con WebXR e con la conversione USDZ automatica è model-viewer stesso a caricare il modello
    // prima di proseguire (activateAR → $triggerLoad): intanto resta l'attesa.
    if (visore.loaded) chiudiAttesa?.();
    else apriAttesa();
    await visore.activateAR();
  };

  pulsante.addEventListener('click', () => {
    if (occupato || pulsante.getAttribute('aria-disabled') === 'true') return;
    occupato = true;
    avviaAR()
      .catch(() => {
        chiudiAttesa?.();
        scriviMessaggio(MESSAGGIO_FALLITO);
      })
      .finally(() => setTimeout(() => (occupato = false), PAUSA_DOPO_ATTIVAZIONE_MS));
  });

  visore.addEventListener('ar-status', (e) => {
    if ((e as CustomEvent<{ status: string }>).detail.status !== 'failed') return;
    scriviMessaggio(MESSAGGIO_FALLITO);
    // model-viewer passa alla modalità successiva, ma aggiorna canActivateAR solo DOPO questo
    // evento: lo rileggiamo al giro successivo. Se non resta nessuna modalità, niente pulsante.
    setTimeout(() => {
      if (!visore.canActivateAR) conferma('qr');
    }, 0);
  });

  visore.addEventListener('load', async () => {
    if (visore.canActivateAR) return conferma('pulsante');
    // canActivateAR può assestarsi dopo il caricamento (WebXR su Android): se la stima diceva
    // "sì", gli diamo tempo prima di passare al QR.
    const ok = await aspettaChe(() => visore.canActivateAR, stimaPositiva ? ASSESTAMENTO_AL_CARICAMENTO_MS : 1000);
    conferma(ok ? 'pulsante' : 'qr');
  });

  window.addEventListener('3db:modello-errore', senzaModello);
  if (window.__3dbModelloErrore) senzaModello();

  void stimaSupportoAR(visore).then((supportato) => {
    stimaPositiva = supportato;
    if (!statoConfermato) imposta(supportato ? 'pulsante' : 'qr');
  });
}

document.querySelectorAll<HTMLElement>('[data-ar]').forEach(inizializza);
