// Ricerca di un Chrome/Chromium locale per il rendering headless (poster e anteprime).
// Ordine: variabile CHROME_PATH → .cache/browsers/ del progetto → percorsi standard.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getInstalledBrowsers } from '@puppeteer/browsers';
import { RADICE } from './progetto.mjs';
import { ErroreUtente } from './terminale.mjs';

export const CARTELLA_BROWSER = path.join(RADICE, '.cache', 'browsers');
export const COMANDO_INSTALLA =
  'npx @puppeteer/browsers install chrome-headless-shell@stable --path .cache/browsers';

function eseguibile(percorso) {
  try {
    fs.accessSync(percorso, fs.constants.X_OK);
    return fs.statSync(percorso).isFile();
  } catch {
    return false;
  }
}

function percorsiStandard() {
  const casa = os.homedir();
  if (process.platform === 'darwin') {
    const app = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Chromium.app/Contents/MacOS/Chromium',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
      'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ];
    return app.flatMap((a) => [path.join('/Applications', a), path.join(casa, 'Applications', a)]);
  }
  if (process.platform === 'win32') {
    const radici = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    return radici.flatMap((r) => [
      path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(r, 'Chromium', 'Application', 'chrome.exe'),
      path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]);
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
  ];
}

async function browserInCache() {
  if (!fs.existsSync(CARTELLA_BROWSER)) return [];
  try {
    const installati = await getInstalledBrowsers({ cacheDir: CARTELLA_BROWSER });
    // Preferiamo chrome-headless-shell (più leggero), poi Chrome completo; versioni più recenti prima.
    const priorita = (b) => (b.browser === 'chrome-headless-shell' ? 0 : b.browser === 'chrome' ? 1 : 2);
    return installati
      .filter((b) => priorita(b) < 2)
      .sort((a, b) => priorita(a) - priorita(b) || b.buildId.localeCompare(a.buildId, undefined, { numeric: true }))
      .map((b) => ({ percorso: b.executablePath, origine: `.cache/browsers (${b.browser} ${b.buildId})` }));
  } catch {
    return [];
  }
}

/**
 * Restituisce { percorso, origine, headless } del primo browser utilizzabile,
 * oppure lancia un ErroreUtente con le istruzioni per installarlo.
 */
export async function trovaChrome({ esplicito } = {}) {
  const candidati = [];
  if (esplicito) candidati.push({ percorso: esplicito, origine: 'opzione --chrome', obbligatorio: true });
  if (process.env.CHROME_PATH) {
    candidati.push({ percorso: process.env.CHROME_PATH, origine: 'variabile CHROME_PATH', obbligatorio: true });
  }
  candidati.push(...(await browserInCache()));
  candidati.push(...percorsiStandard().map((percorso) => ({ percorso, origine: 'installazione di sistema' })));

  for (const c of candidati) {
    if (eseguibile(c.percorso)) {
      // chrome-headless-shell va lanciato in modalità "shell" (--headless), Chrome completo con --headless=new.
      const headless = /headless[-_]shell/i.test(path.basename(c.percorso)) ? 'shell' : true;
      return { percorso: c.percorso, origine: c.origine, headless };
    }
    if (c.obbligatorio) {
      throw new ErroreUtente(`il browser indicato da ${c.origine} non esiste o non è eseguibile: ${c.percorso}`);
    }
  }

  throw new ErroreUtente('nessun Chrome/Chromium trovato per il rendering del poster.', {
    codice: 3,
    suggerimento:
      'Installa chrome-headless-shell nella cache del progetto (circa 100 MB, una volta sola):\n\n' +
      `    ${COMANDO_INSTALLA}\n\n` +
      'oppure indica un Chrome già installato con la variabile CHROME_PATH, es.:\n\n' +
      '    CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run poster -- <slug>',
  });
}
