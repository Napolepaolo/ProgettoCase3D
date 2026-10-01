// <turntable-plastico>: visualizzatore a 360° del plastico stampato.
//
// Una sequenza di foto del plastico scattate su un piatto girevole (frame 001 = vista
// frontale; indici crescenti = l'oggetto gira verso destra di chi guarda) che l'utente
// fa ruotare trascinando o con la tastiera.
//
// Scelta di rendering: un solo <canvas> su cui si disegna, di volta in volta, uno degli
// HTMLImageElement già caricati. Rispetto a cambiare la `src` di un'unica <img>:
// - drawImage è sincrono: nessun lampeggio fra un frame e l'altro (con la sostituzione
//   della src alcuni browser mostrano per un istante il vuoto o il frame precedente);
// - il ridimensionamento (riempi o contieni, vedi rettangoloAdattato) e la densità di pixel
//   sono sotto controllo;
// - la memoria resta al browser: teniamo solo gli HTMLImageElement (i byte compressi,
//   ~100–200 KB a frame), mentre le bitmap decodificate stanno nella cache delle immagini
//   del browser, che le scarta quando serve. Niente ImageBitmap per tutti i frame, che
//   con 72 frame da 1600 px occuperebbero centinaia di MB su un telefono.
//
// La logica "pura" (angoli, ordine di caricamento, inerzia) è esportata come funzioni
// indipendenti dal DOM, così si può provare anche con node.
//
// Rotazione collegata al modello 3D (src/scripts/sincronia.ts): a ogni cambio d'angolo
// l'elemento emette 'turntable-rotazione' (detail: { angolo, automatica }); impostaAngolo()
// lo porta a un angolo deciso da fuori senza riemettere l'evento (niente rimbalzi).

// --- Parametri ------------------------------------------------------------

/** Richieste di frame contemporanee. */
const CONCORRENZA = 4;
/** Se il modello 3D non segnala il caricamento entro questo tempo dal `load` della finestra, si parte comunque. */
const ATTESA_MODELLO_MS = 6000;
/** Si precarica solo quando l'elemento è entro questa distanza dalla viewport. */
const MARGINE_VICINANZA = '300px 0px';
/** Un giro completo corrisponde a un trascinamento di 1,5 volte la larghezza del riquadro. */
const LARGHEZZE_PER_GIRO = 1.5;
/** Col dito (o la penna) la rotazione parte solo dopo questo spostamento orizzontale, prevalente sul verticale. */
const SOGLIA_AGGANCIO_PX = 6;
/** Rotazione automatica: un giro in 30 s (gradi al millisecondo). */
const VELOCITA_AUTO = 360 / 30_000;
/** Finestra su cui si stima la velocità al rilascio. */
const FINESTRA_VELOCITA_MS = 80;
/** Costante di tempo dell'attrito: la velocità si riduce a ~37% ogni TAU ms. */
const TAU_INERZIA_MS = 220;
/** Sotto questa velocità (gradi/ms) l'inerzia non parte o si ferma. */
const SOGLIA_INERZIA = 0.01;
/** Limite alla velocità iniziale dell'inerzia (gradi/ms): un lancio vale al massimo ~220°. */
const VELOCITA_MASSIMA = 1;
/** Passo massimo di simulazione, per non saltare dopo una pausa del browser. */
const DT_MASSIMO_MS = 64;
/** Densità di pixel massima del canvas. */
const DPR_MASSIMO = 2;
/**
 * Le foto riempiono il riquadro ("cover") se per farlo basta tagliare al massimo questa
 * frazione del lato che eccede (es. frame quadrati nella metà 8:9 della tavola: 11%);
 * altrimenti si vedono intere ("contain"), così un plastico largo non viene mai tagliato.
 */
const TAGLIO_MASSIMO = 0.15;

// --- Logica pura ------------------------------------------------------------

/** Modulo sempre non negativo, anche per valori negativi: modulo(-1, 36) === 35. */
export function modulo(a: number, n: number): number {
  const r = a % n;
  // `+ 0` trasforma un eventuale -0 in 0.
  return (r < 0 ? r + n : r) + 0;
}

/** Porta un angolo qualsiasi (anche negativo) nell'intervallo [0, 360). */
export function normalizzaAngolo(angolo: number): number {
  return modulo(angolo, 360);
}

/** Indice logico (0-based) del frame che corrisponde a un angolo: round(angolo / (360/n)) mod n. */
export function indiceFrame(angolo: number, n: number): number {
  return modulo(Math.round(angolo / (360 / n)), n);
}

/** Indice del file da mostrare per un indice logico, tenendo conto di una ripresa nel verso opposto. */
export function indiceFile(indiceLogico: number, n: number, inverti: boolean): number {
  return inverti ? modulo(-indiceLogico, n) : modulo(indiceLogico, n);
}

/** Gradi interi (0–359) del frame logico, per aria-valuenow. */
export function gradiDelFrame(indiceLogico: number, n: number): number {
  return Math.round((modulo(indiceLogico, n) * 360) / n) % 360;
}

/** Gradi di rotazione per pixel di trascinamento, data la larghezza del riquadro. */
export function gradiPerPixel(larghezza: number): number {
  return 360 / (LARGHEZZE_PER_GIRO * Math.max(larghezza, 1));
}

/**
 * Ordine di caricamento dei frame: prima uno ogni `passo` (si può già ruotare a scatti),
 * poi si dimezza il passo riempiendo i vuoti a metà, fino a tutti i frame.
 * Per n = 12: 0 4 8 · 2 6 10 · 1 3 5 7 9 11.
 */
export function ordineCaricamento(n: number, passo = 4): number[] {
  const ordine: number[] = [];
  const visti = new Set<number>();
  for (let s = Math.max(1, Math.floor(passo)); ; s = Math.max(1, Math.floor(s / 2))) {
    for (let i = 0; i < n; i += s) {
      if (!visti.has(i)) {
        visti.add(i);
        ordine.push(i);
      }
    }
    if (s === 1) return ordine;
  }
}

/**
 * Il frame già disponibile più vicino (in senso circolare) a quello desiderato,
 * oppure -1 se non ce n'è nessuno. A parità di distanza vince quello "dopo".
 */
export function frameVicinoCaricato(desiderato: number, n: number, disponibile: (i: number) => boolean): number {
  for (let d = 0; d <= Math.floor(n / 2); d++) {
    const dopo = modulo(desiderato + d, n);
    if (disponibile(dopo)) return dopo;
    const prima = modulo(desiderato - d, n);
    if (disponibile(prima)) return prima;
  }
  return -1;
}

export interface Campione {
  /** Istante in ms (timeStamp dell'evento). */
  t: number;
  /** Angolo in gradi. */
  a: number;
}

/**
 * Velocità angolare (gradi/ms) al rilascio, stimata sui campioni degli ultimi `finestra` ms.
 * Se il dito si è fermato prima di staccarsi, nella finestra resta un solo campione e la velocità è 0.
 */
export function stimaVelocita(campioni: readonly Campione[], istanteFine: number, finestra = FINESTRA_VELOCITA_MS): number {
  const recenti = campioni.filter((c) => c.t >= istanteFine - finestra && c.t <= istanteFine);
  if (recenti.length < 2) return 0;
  const primo = recenti[0];
  const ultimo = recenti[recenti.length - 1];
  // Almeno un fotogramma di intervallo: due eventi quasi simultanei darebbero velocità assurde.
  return (ultimo.a - primo.a) / Math.max(ultimo.t - primo.t, 16);
}

/** Velocità iniziale dell'inerzia: 0 se troppo lenta, limitata se troppo alta. */
export function velocitaIniziale(v: number): number {
  if (!Number.isFinite(v) || Math.abs(v) < SOGLIA_INERZIA) return 0;
  return Math.sign(v) * Math.min(Math.abs(v), VELOCITA_MASSIMA);
}

/**
 * Un passo di inerzia con attrito esponenziale nel tempo (indipendente dalla frequenza dei fotogrammi):
 * v(t) = v0·e^(−t/τ). Restituisce l'angolo percorso nel passo e la nuova velocità (0 sotto soglia).
 */
export function passoInerzia(v: number, dt: number, tau = TAU_INERZIA_MS): { delta: number; v: number } {
  const smorzamento = Math.exp(-dt / tau);
  const delta = v * tau * (1 - smorzamento);
  const nuova = v * smorzamento;
  return { delta, v: Math.abs(nuova) < SOGLIA_INERZIA ? 0 : nuova };
}

/** Rettangolo in cui disegnare un'immagine "contain", centrata, dentro una superficie. */
export function rettangoloContain(
  larghezzaImmagine: number,
  altezzaImmagine: number,
  larghezza: number,
  altezza: number,
): { x: number; y: number; w: number; h: number } {
  const scala = Math.min(larghezza / larghezzaImmagine, altezza / altezzaImmagine);
  const w = larghezzaImmagine * scala;
  const h = altezzaImmagine * scala;
  return { x: (larghezza - w) / 2, y: (altezza - h) / 2, w, h };
}

/**
 * Rettangolo in cui disegnare un'immagine centrata: riempie la superficie ("cover") se il taglio
 * resta entro `taglioMassimo` del lato che eccede, altrimenti la contiene intera ("contain").
 */
export function rettangoloAdattato(
  larghezzaImmagine: number,
  altezzaImmagine: number,
  larghezza: number,
  altezza: number,
  taglioMassimo = TAGLIO_MASSIMO,
): { x: number; y: number; w: number; h: number } {
  const scala = Math.max(larghezza / larghezzaImmagine, altezza / altezzaImmagine);
  const w = larghezzaImmagine * scala;
  const h = altezzaImmagine * scala;
  const taglio = Math.max(1 - larghezza / w, 1 - altezza / h);
  if (taglio > taglioMassimo) return rettangoloContain(larghezzaImmagine, altezzaImmagine, larghezza, altezza);
  return { x: (larghezza - w) / 2, y: (altezza - h) / 2, w, h };
}

/** Stessa regola di rettangoloAdattato per un'<img> in CSS: "cover" o "contain". */
export function adattamentoCss(larghezzaImmagine: number, altezzaImmagine: number, larghezza: number, altezza: number) {
  const r = rettangoloAdattato(larghezzaImmagine, altezzaImmagine, larghezza, altezza);
  return r.w > larghezza + 0.5 || r.h > altezza + 0.5 ? 'cover' : 'contain';
}

/**
 * Nuovo angolo per un tasto (pattern "slider" WAI-ARIA), oppure null se il tasto non è gestito.
 * Frecce (su = destra, giù = sinistra): un frame; con Maiusc (e con PagSu/PagGiù): 1/8 di giro,
 * arrotondato a frame interi.
 * Home: frame 001; Fine: ultimo frame. L'angolo risultante cade sempre esattamente su un frame.
 */
export function angoloDaTasto(tasto: string, maiusc: boolean, angolo: number, n: number): number | null {
  const passo = 360 / n;
  const k = Math.round(angolo / passo);
  const ottavo = Math.max(1, Math.round(n / 8));
  switch (tasto) {
    case 'ArrowRight':
    case 'ArrowUp':
      return normalizzaAngolo((k + (maiusc ? ottavo : 1)) * passo);
    case 'ArrowLeft':
    case 'ArrowDown':
      return normalizzaAngolo((k - (maiusc ? ottavo : 1)) * passo);
    case 'PageUp':
      return normalizzaAngolo((k + ottavo) * passo);
    case 'PageDown':
      return normalizzaAngolo((k - ottavo) * passo);
    case 'Home':
      return 0;
    case 'End':
      return (n - 1) * passo;
    default:
      return null;
  }
}

// --- Elemento ----------------------------------------------------------------

type FinestraConModello = Window & { __3dbModelloCaricato?: boolean };

let mqMovimentoRidotto: MediaQueryList | undefined;
function movimentoRidotto(): boolean {
  mqMovimentoRidotto ??= window.matchMedia('(prefers-reduced-motion: reduce)');
  return mqMovimentoRidotto.matches;
}

/** Tempo trascorso dall'evento `load` della finestra (0 se non è ancora avvenuto). */
function msDalLoad(): number {
  const navigazione = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const fineLoad = navigazione?.loadEventEnd ?? 0;
  return fineLoad > 0 ? performance.now() - fineLoad : 0;
}

class TurntablePlastico extends HTMLElement {
  private frame: string[] = [];
  private n = 0;
  private inverti = false;

  /** Frame pronti da disegnare (indice = file). Il frame 0 è l'<img> già nella pagina. */
  private immagini: (HTMLImageElement | null)[] = [];
  private inCorso = new Set<HTMLImageElement>();
  private caricati = 0;

  private tela: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private immagineIniziale: HTMLImageElement | null = null;
  private conteggio: HTMLElement | null = null;
  private barra: HTMLElement | null = null;

  /** Angolo reale, in gradi: cresce quando l'oggetto gira verso destra. */
  private angolo = 0;
  private velocita = 0;
  /** Ultimo angolo comunicato con 'turntable-rotazione' (o ricevuto da fuori). */
  private angoloComunicato = Number.NaN;
  private autoRotazione = false;
  private interagito = false;
  private trascinamento: {
    id: number;
    x0: number;
    y0: number;
    angolo0: number;
    gpp: number;
    /** false finché non è chiaro che il gesto è orizzontale (tocco) e non uno scorrimento della pagina. */
    agganciato: boolean;
  } | null = null;
  private campioni: Campione[] = [];

  private larghezzaCss = 0;
  private altezzaCss = 0;
  private ultimoDisegnato = -1;
  private ultimoIndiceLogico = -1;

  private rafId = 0;
  private ultimoIstante = 0;
  private visibile = false;
  private vicino = false;
  private modelloPronto = false;
  private precaricamentoAvviato = false;
  private timerModello = 0;
  /** Cambia a ogni disconnessione: le operazioni asincrone di una "vita" precedente si fermano. */
  private generazione = 0;

  private controllore: AbortController | null = null;
  private osservatoreVicinanza: IntersectionObserver | null = null;
  private osservatoreVisibilita: IntersectionObserver | null = null;
  private osservatoreDimensioni: ResizeObserver | null = null;

  connectedCallback() {
    let frame: unknown;
    try {
      frame = JSON.parse(this.dataset.frame ?? '[]');
    } catch {
      return;
    }
    if (!Array.isArray(frame) || frame.length < 2) return;

    const tela = this.querySelector<HTMLCanvasElement>('.turntable__tela');
    const ctx = tela?.getContext('2d');
    if (!tela || !ctx) return; // senza canvas resta l'immagine statica

    this.frame = frame.map(String);
    this.n = this.frame.length;
    this.inverti = this.hasAttribute('data-inverti');
    this.tela = tela;
    this.ctx = ctx;
    this.immagineIniziale = this.querySelector<HTMLImageElement>('.turntable__immagine');
    this.conteggio = this.querySelector<HTMLElement>('.turntable__conteggio');
    this.barra = this.querySelector<HTMLElement>('.turntable__barra');
    this.immagini = new Array<HTMLImageElement | null>(this.n).fill(null);
    this.caricati = 0;
    this.ultimoDisegnato = -1;
    this.ultimoIndiceLogico = -1;
    this.autoRotazione = false;
    this.precaricamentoAvviato = false;
    this.modelloPronto = false;
    this.vicino = false;
    this.visibile = false;

    // Accessibilità: si comporta come uno slider da 0 a 359 gradi.
    this.tabIndex = 0;
    this.setAttribute('role', 'slider');
    this.setAttribute('aria-label', this.dataset.etichetta ?? 'Plastico stampato, vista a 360°');
    this.setAttribute('aria-valuemin', '0');
    this.setAttribute('aria-valuemax', '359');
    this.setAttribute('aria-orientation', 'horizontal');
    this.aggiornaAria();
    this.toggleAttribute('data-attivo', true);

    const signal = (this.controllore = new AbortController()).signal;
    this.addEventListener('pointerdown', this.suPointerDown, { signal });
    this.addEventListener('pointermove', this.suPointerMove, { signal });
    this.addEventListener('pointerup', this.suPointerUp, { signal });
    this.addEventListener('pointercancel', this.suPointerCancel, { signal });
    this.addEventListener('lostpointercapture', this.suPointerCancel, { signal });
    this.addEventListener('keydown', this.suTasto, { signal });
    // Arrivando con la tastiera la rotazione automatica si ferma: il valore dello slider non deve
    // cambiare da solo sotto il focus (gli screen reader lo annuncerebbero di continuo). Un tocco
    // col dito non conta: dà il focus anche solo scorrendo la pagina.
    this.addEventListener('focus', () => focusDaTastiera(this) && this.primaInterazione(), { signal });
    document.addEventListener('visibilitychange', this.suVisibilitaPagina, { signal });

    this.predisponiFrameIniziale(signal);

    this.osservatoreDimensioni = new ResizeObserver(this.suRidimensionamento);
    this.osservatoreDimensioni.observe(this);

    this.osservatoreVisibilita = new IntersectionObserver((voci) => {
      this.visibile = voci[voci.length - 1].isIntersecting;
      if (this.visibile) this.pianifica();
    });
    this.osservatoreVisibilita.observe(this);

    this.osservatoreVicinanza = new IntersectionObserver(
      (voci) => {
        this.vicino = voci[voci.length - 1].isIntersecting;
        this.valutaPrecaricamento();
      },
      { rootMargin: MARGINE_VICINANZA },
    );
    this.osservatoreVicinanza.observe(this);

    this.attendiModello(signal);
  }

  disconnectedCallback() {
    this.generazione++;
    this.controllore?.abort();
    this.controllore = null;
    this.osservatoreVicinanza?.disconnect();
    this.osservatoreVisibilita?.disconnect();
    this.osservatoreDimensioni?.disconnect();
    this.osservatoreVicinanza = this.osservatoreVisibilita = null;
    this.osservatoreDimensioni = null;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.ultimoIstante = 0;
    clearTimeout(this.timerModello);
    // Interrompe i download in corso e lascia al garbage collector i frame caricati.
    for (const img of this.inCorso) img.removeAttribute('src');
    this.inCorso.clear();
    this.immagini = [];
    this.caricati = 0;
    this.trascinamento = null;
    this.velocita = 0;
    this.toggleAttribute('data-caricamento', false);
    this.toggleAttribute('data-trascinamento', false);
  }

  // --- Caricamento -----------------------------------------------------------

  /** Il frame 001 è già nella pagina come <img>: lo si usa direttamente come primo frame. */
  private predisponiFrameIniziale(signal: AbortSignal) {
    const img = this.immagineIniziale;
    if (!img) return;
    const pronto = () => {
      if (img.naturalWidth === 0 || this.immagini[0]) return;
      this.immagini[0] = img;
      this.caricati++;
      this.aggiornaAvanzamento();
      this.pianifica();
    };
    if (img.complete) pronto();
    else img.addEventListener('load', pronto, { once: true, signal });
  }

  /** I frame si scaricano dopo il modello 3D, che ha la precedenza sulla banda. */
  private attendiModello(signal: AbortSignal) {
    const sblocca = () => {
      clearTimeout(this.timerModello);
      this.modelloPronto = true;
      this.valutaPrecaricamento();
    };
    if ((window as FinestraConModello).__3dbModelloCaricato || !document.querySelector('model-viewer')) {
      sblocca();
      return;
    }
    window.addEventListener('3db:modello-caricato', sblocca, { once: true, signal });
    // Ripiego: se il modello non segnala nulla (errore, caricamento lentissimo) si parte comunque.
    const avviaTimer = () => {
      this.timerModello = window.setTimeout(sblocca, Math.max(0, ATTESA_MODELLO_MS - msDalLoad()));
    };
    if (document.readyState === 'complete') avviaTimer();
    else window.addEventListener('load', avviaTimer, { once: true, signal });
  }

  private valutaPrecaricamento() {
    if (this.modelloPronto && this.vicino) this.avviaPrecaricamento();
  }

  private avviaPrecaricamento() {
    if (this.precaricamentoAvviato || !this.controllore) return;
    this.precaricamentoAvviato = true;
    clearTimeout(this.timerModello);
    void this.precarica();
  }

  private async precarica() {
    const generazione = this.generazione;
    const coda = ordineCaricamento(this.n).filter((i) => i !== 0 || !this.immagineIniziale);
    let prossimo = 0;
    this.toggleAttribute('data-caricamento', true);
    this.aggiornaAvanzamento();

    const lavoratore = async () => {
      while (prossimo < coda.length && generazione === this.generazione) {
        const i = coda[prossimo++];
        if (this.immagini[i]) continue;
        const img = new Image();
        img.decoding = 'async';
        img.fetchPriority = 'low';
        img.src = this.frame[i];
        this.inCorso.add(img);
        try {
          await img.decode();
        } catch {
          continue; // frame mancante o illeggibile: si mostrerà il più vicino disponibile
        } finally {
          this.inCorso.delete(img);
        }
        if (generazione !== this.generazione || this.immagini[i]) continue;
        this.immagini[i] = img;
        this.caricati++;
        this.aggiornaAvanzamento();
        this.pianifica();
      }
    };
    await Promise.all(Array.from({ length: CONCORRENZA }, lavoratore));
    if (generazione !== this.generazione) return;

    this.toggleAttribute('data-caricamento', false);
    // La rotazione automatica parte a caricamento finito, quando il giro è fluido.
    if (!this.interagito && !movimentoRidotto()) {
      this.autoRotazione = true;
      this.pianifica();
    }
  }

  private aggiornaAvanzamento() {
    if (this.conteggio) this.conteggio.textContent = `Caricamento ${this.caricati} / ${this.n}`;
    if (this.barra) this.barra.style.transform = `scaleX(${this.caricati / this.n})`;
  }

  // --- Rotazione collegata (API pubblica) -------------------------------------------

  /** Angolo attuale in gradi [0, 360): cresce quando l'oggetto gira verso destra. */
  get angoloAttuale(): number {
    return normalizzaAngolo(this.angolo);
  }

  /** true se l'utente ha già ruotato il plastico (o l'ha fatto girare il modello collegato). */
  get toccato(): boolean {
    return this.interagito;
  }

  /**
   * Porta il plastico a un angolo deciso da fuori (es. dal modello 3D) senza emettere
   * 'turntable-rotazione'. Con `interazione` (predefinito) conta come un gesto dell'utente:
   * ferma la rotazione automatica e fa partire il caricamento dei frame. Se l'utente sta
   * trascinando proprio il plastico, vince il trascinamento.
   */
  impostaAngolo(gradi: number, { interazione = true }: { interazione?: boolean } = {}) {
    if (!Number.isFinite(gradi) || !this.controllore) return;
    if (interazione) {
      this.primaInterazione();
      this.avviaPrecaricamento();
    }
    if (this.trascinamento) return;
    this.velocita = 0;
    this.angolo = normalizzaAngolo(gradi);
    this.angoloComunicato = this.angolo;
    this.pianifica();
  }

  /** Comunica il nuovo angolo, se è cambiato (al più una volta per fotogramma). */
  private comunicaAngolo() {
    if (this.angolo === this.angoloComunicato) return;
    this.angoloComunicato = this.angolo;
    const automatica = this.autoRotazione && !this.trascinamento && this.velocita === 0;
    this.dispatchEvent(new CustomEvent('turntable-rotazione', { detail: { angolo: this.angolo, automatica } }));
  }

  // --- Interazione ----------------------------------------------------------------

  /** Prima interazione vera: ferma per sempre la rotazione automatica e nasconde il suggerimento. */
  private primaInterazione() {
    if (this.interagito) return;
    this.interagito = true;
    this.autoRotazione = false;
    this.toggleAttribute('data-interagito', true);
  }

  private suPointerDown = (e: PointerEvent) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    // Anche un tocco che poi diventa uno scorrimento dice che l'utente è lì: si scaricano i frame.
    this.avviaPrecaricamento();
    this.velocita = 0;
    this.angolo = normalizzaAngolo(this.angolo);
    const agganciato = e.pointerType === 'mouse';
    if (agganciato) this.primaInterazione();
    this.trascinamento = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      angolo0: this.angolo,
      gpp: gradiPerPixel(this.clientWidth),
      agganciato,
    };
    this.campioni = [{ t: e.timeStamp, a: this.angolo }];
    try {
      this.setPointerCapture(e.pointerId);
    } catch {
      // puntatore già rilasciato: il trascinamento finirà con pointerup/pointercancel
    }
    this.toggleAttribute('data-trascinamento', true);
  };

  private suPointerMove = (e: PointerEvent) => {
    const t = this.trascinamento;
    if (!t || e.pointerId !== t.id) return;
    if (!t.agganciato) {
      // Col dito: finché il gesto non è chiaramente orizzontale potrebbe essere uno scorrimento
      // verticale della pagina (touch-action: pan-y), che il browser annuncerà con pointercancel.
      const dx = e.clientX - t.x0;
      if (Math.abs(dx) < SOGLIA_AGGANCIO_PX || Math.abs(dx) <= Math.abs(e.clientY - t.y0)) return;
      t.agganciato = true;
      t.x0 = e.clientX; // niente scatto: la rotazione parte da qui
      this.primaInterazione();
      this.campioni = [{ t: e.timeStamp, a: this.angolo }];
      return;
    }
    this.angolo = t.angolo0 + (e.clientX - t.x0) * t.gpp;
    this.campioni.push({ t: e.timeStamp, a: this.angolo });
    // Bastano i campioni recenti per stimare la velocità al rilascio.
    while (this.campioni.length > 2 && this.campioni[0].t < e.timeStamp - 2 * FINESTRA_VELOCITA_MS) this.campioni.shift();
    this.pianifica();
  };

  private suPointerUp = (e: PointerEvent) => {
    const t = this.trascinamento;
    if (!t || e.pointerId !== t.id) return;
    if (!t.agganciato) {
      this.fineTrascinamento(); // un semplice tocco: nessuna rotazione
      return;
    }
    this.angolo = t.angolo0 + (e.clientX - t.x0) * t.gpp;
    this.campioni.push({ t: e.timeStamp, a: this.angolo });
    this.velocita = movimentoRidotto() ? 0 : velocitaIniziale(stimaVelocita(this.campioni, e.timeStamp));
    this.fineTrascinamento();
  };

  /** Il browser si è preso il gesto (es. scorrimento verticale) o la cattura è stata persa: niente inerzia. */
  private suPointerCancel = (e: PointerEvent) => {
    if (!this.trascinamento || e.pointerId !== this.trascinamento.id) return;
    this.velocita = 0;
    this.fineTrascinamento();
  };

  private fineTrascinamento() {
    this.trascinamento = null;
    this.campioni = [];
    this.toggleAttribute('data-trascinamento', false);
    this.pianifica();
  }

  private suTasto = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const nuovo = angoloDaTasto(e.key, e.shiftKey, this.angolo, this.n);
    if (nuovo === null) return;
    e.preventDefault();
    this.primaInterazione();
    this.avviaPrecaricamento();
    this.velocita = 0;
    this.angolo = nuovo;
    this.pianifica();
  };

  private suVisibilitaPagina = () => {
    if (!document.hidden) this.pianifica();
  };

  // --- Animazione e disegno --------------------------------------------------------

  private pianifica() {
    if (this.rafId === 0 && this.controllore) this.rafId = requestAnimationFrame(this.passo);
  }

  private passo = (ora: number) => {
    this.rafId = 0;
    const dt = this.ultimoIstante ? Math.min(ora - this.ultimoIstante, DT_MASSIMO_MS) : 0;
    let inMovimento = false;

    if (!this.trascinamento) {
      if (this.velocita !== 0) {
        const { delta, v } = passoInerzia(this.velocita, dt);
        this.angolo += delta;
        this.velocita = v;
        inMovimento = v !== 0;
      } else if (this.autoRotazione) {
        if (movimentoRidotto()) this.autoRotazione = false;
        else {
          this.angolo += VELOCITA_AUTO * dt;
          inMovimento = true;
        }
      }
      this.angolo = normalizzaAngolo(this.angolo);
    }

    this.comunicaAngolo();
    this.disegna();

    // Fuori schermo o a pagina nascosta l'animazione resta sospesa; riparte da IntersectionObserver
    // o da visibilitychange senza "recuperare" il tempo perso.
    if (inMovimento && this.visibile && !document.hidden) {
      this.ultimoIstante = ora;
      this.pianifica();
    } else {
      this.ultimoIstante = 0;
    }
  };

  private suRidimensionamento = (voci: ResizeObserverEntry[]) => {
    const { width, height } = voci[voci.length - 1].contentRect;
    this.larghezzaCss = width;
    this.altezzaCss = height;
    // Subito, non al prossimo fotogramma: ridimensionare il canvas lo svuota.
    this.disegna(true);
  };

  /** Disegna il frame corrispondente all'angolo (o il più vicino già caricato), solo se cambia. */
  private disegna(forza = false) {
    const { tela, ctx } = this;
    if (!tela || !ctx) return;

    const logico = indiceFrame(this.angolo, this.n);
    if (logico !== this.ultimoIndiceLogico) {
      this.ultimoIndiceLogico = logico;
      this.aggiornaAria();
    }

    const dpr = Math.min(window.devicePixelRatio || 1, DPR_MASSIMO);
    const w = Math.round(this.larghezzaCss * dpr);
    const h = Math.round(this.altezzaCss * dpr);
    if (w === 0 || h === 0) return;
    if (tela.width !== w || tela.height !== h) {
      tela.width = w;
      tela.height = h;
      forza = true;
    }

    const i = frameVicinoCaricato(indiceFile(logico, this.n, this.inverti), this.n, (j) => this.immagini[j] != null);
    if (i < 0 || (i === this.ultimoDisegnato && !forza)) return;

    const img = this.immagini[i]!;
    const r = rettangoloAdattato(img.naturalWidth, img.naturalHeight, w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, r.x, r.y, r.w, r.h);
    this.ultimoDisegnato = i;
    // Da qui in poi si vede il canvas: l'<img> statica sotto viene nascosta.
    this.toggleAttribute('data-disegnato', true);
  }

  private aggiornaAria() {
    const gradi = gradiDelFrame(indiceFrame(this.angolo, this.n), this.n);
    this.setAttribute('aria-valuenow', String(gradi));
    this.setAttribute('aria-valuetext', `Rotazione ${gradi} ${gradi === 1 ? 'grado' : 'gradi'}`);
  }
}

if (!customElements.get('turntable-plastico')) {
  customElements.define('turntable-plastico', TurntablePlastico);
}

/** true se l'elemento ha il focus visibile (tastiera). Su Safari < 15.4 manca :focus-visible. */
function focusDaTastiera(elemento: Element): boolean {
  try {
    return elemento.matches(':focus-visible');
  } catch {
    return true;
  }
}

// --- Immagini statiche del plastico (foto singola e primo frame) ------------------
// Stessa regola del canvas: riempiono il riquadro se il taglio è piccolo, altrimenti restano intere.

function adattaImmagine(img: HTMLImageElement) {
  const { clientWidth: w, clientHeight: h, naturalWidth: wi, naturalHeight: hi } = img;
  if (!w || !h || !wi || !hi) return;
  img.style.objectFit = adattamentoCss(wi, hi, w, h);
}

const immaginiDaAdattare = document.querySelectorAll<HTMLImageElement>('img[data-adatta]');
if (immaginiDaAdattare.length > 0) {
  const osservatore = new ResizeObserver((voci) => voci.forEach((v) => adattaImmagine(v.target as HTMLImageElement)));
  immaginiDaAdattare.forEach((img) => {
    osservatore.observe(img);
    if (img.complete) adattaImmagine(img);
    else img.addEventListener('load', () => adattaImmagine(img), { once: true });
  });
}
