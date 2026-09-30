// Utilità per gli script da riga di comando: colori, formattazione di numeri e
// dimensioni, errori "da utente" (stampati senza stack trace) e avvio del main.

const usaColori = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

function colora(codice) {
  return (testo) => (usaColori ? `\x1b[${codice}m${testo}\x1b[0m` : String(testo));
}

export const stile = {
  grassetto: colora('1'),
  tenue: colora('2'),
  rosso: colora('31'),
  verde: colora('32'),
  giallo: colora('33'),
  ciano: colora('36'),
};

/** Errore previsto (file mancante, opzione sbagliata…): si stampa il messaggio, senza stack. */
export class ErroreUtente extends Error {
  constructor(messaggio, { codice = 1, suggerimento } = {}) {
    super(messaggio);
    this.name = 'ErroreUtente';
    this.codice = codice;
    this.suggerimento = suggerimento;
  }
}

/** Traduce gli errori di util.parseArgs (che sono in inglese) in un ErroreUtente. */
export function erroreArgomenti(errore) {
  const opzione = errore.message.match(/'(-[^' ]+)/)?.[1] ?? '';
  const messaggi = {
    ERR_PARSE_ARGS_UNKNOWN_OPTION: `opzione sconosciuta: ${opzione}`,
    ERR_PARSE_ARGS_INVALID_OPTION_VALUE: `l'opzione ${opzione} richiede un valore (per un numero negativo scrivi ${opzione}=-90)`,
    ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL: 'troppi argomenti',
  };
  return new ErroreUtente(`${messaggi[errore.code] ?? errore.message}\nUsa --help per l'elenco delle opzioni.`);
}

export function titolo(testo) {
  console.log(`\n${stile.grassetto(stile.ciano(`== ${testo} `.padEnd(72, '=')))}`);
}

export function voce(etichetta, valore) {
  console.log(`  ${stile.tenue(`${etichetta}:`.padEnd(26))} ${valore}`);
}

export function info(testo) {
  console.log(`  ${testo}`);
}

export function ok(testo) {
  console.log(`  ${stile.verde('OK')}  ${testo}`);
}

export function avviso(testo) {
  console.log(`  ${stile.giallo(stile.grassetto('ATTENZIONE'))}  ${stile.giallo(testo)}`);
}

export function problema(testo) {
  console.log(`  ${stile.rosso(stile.grassetto('PROBLEMA'))}  ${stile.rosso(testo)}`);
}

export function allarme(testo) {
  console.log(`  ${stile.rosso(stile.grassetto('TROPPO PESANTE'))}  ${stile.rosso(testo)}`);
}

const formatoIntero = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0 });
const formatoDecimale = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2 });

/** 1234567 → "1.234.567" */
export function intero(n) {
  return formatoIntero.format(n);
}

/** Numero con al massimo `cifre` decimali, separatore italiano. */
export function decimale(n, cifre = 2) {
  if (cifre === 2) return formatoDecimale.format(n);
  return new Intl.NumberFormat('it-IT', { maximumFractionDigits: cifre }).format(n);
}

/** 2400000 → "2,4 M", 600000 → "600 k" (per i conteggi di triangoli e vertici). */
export function compatto(n) {
  if (n >= 1e6) return `${decimale(n / 1e6, 1)} M`;
  if (n >= 1e4) return `${intero(Math.round(n / 1e3))} k`;
  return intero(n);
}

/** Dimensione in MB decimali (1 MB = 1.000.000 byte), come la mostrano Finder e GitHub. */
export function mb(byte) {
  if (byte < 1e5) return `${decimale(byte / 1e3, 1)} kB`;
  return `${decimale(byte / 1e6, byte < 1e7 ? 2 : 1)} MB`;
}

/**
 * Esegue la funzione principale di uno script gestendo gli errori in modo uniforme:
 * ErroreUtente → messaggio rosso e codice d'uscita; altro → stack completo (è un bug).
 */
export async function avvia(principale) {
  try {
    const codice = await principale();
    if (typeof codice === 'number') process.exitCode = codice;
  } catch (errore) {
    if (errore instanceof ErroreUtente) {
      console.error(`\n${stile.rosso(stile.grassetto('ERRORE'))}  ${errore.message}`);
      if (errore.suggerimento) console.error(`\n${errore.suggerimento}`);
      process.exitCode = errore.codice;
    } else {
      console.error(`\n${stile.rosso(stile.grassetto('ERRORE IMPREVISTO'))}`);
      console.error(errore?.stack ?? errore);
      process.exitCode = 1;
    }
  }
}

/** Avanzamento su una sola riga (solo se il terminale è interattivo). */
export function creaAvanzamento(etichetta) {
  const attivo = Boolean(process.stderr.isTTY);
  let ultimo = -1;
  return {
    aggiorna(frazione) {
      if (!attivo) return;
      const percento = Math.floor(frazione * 100);
      if (percento === ultimo) return;
      ultimo = percento;
      process.stderr.write(`\r  ${stile.tenue(`${etichetta}… ${percento}%`)}   `);
    },
    fine() {
      if (attivo && ultimo >= 0) process.stderr.write('\r\x1b[2K');
    },
  };
}
