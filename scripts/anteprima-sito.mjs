// Genera public/anteprima-sito.jpg (1200×630): l'anteprima per WhatsApp e social delle pagine
// che non sono un'opera (galleria, Chi siamo, …), con i font veri del sito.
//   node scripts/anteprima-sito.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { trovaChrome } from './lib/chrome.mjs';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const f = (p) => 'data:font/woff2;base64,' + fs.readFileSync(path.join(PROJ, 'node_modules', p)).toString('base64');
const html = `<!doctype html><html><head><style>
@font-face{font-family:F;src:url(${f('@fontsource-variable/fraunces/files/fraunces-latin-wght-normal.woff2')});font-weight:100 900}
@font-face{font-family:M;src:url(${f('@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2')});font-weight:500}
@font-face{font-family:S;src:url(${f('@fontsource/instrument-sans/files/instrument-sans-latin-400-normal.woff2')});font-weight:400}
html,body{margin:0;width:1200px;height:630px;background:#f3eee4;color:#1c2b31;overflow:hidden}
.t{position:absolute;left:84px;top:78px;right:84px;bottom:66px;display:flex;flex-direction:column}
.eti{font:500 17px/1.4 M;letter-spacing:.12em;text-transform:uppercase;color:#1f5c68}
h1{font:600 128px/1 F;letter-spacing:-.03em;margin:34px 0 0}
.firma{font:500 26px/1 M;letter-spacing:.1em;color:#1f5c68;margin-top:22px}
.txt{font:400 30px/1.35 F;color:#3e4a4b;max-width:620px;margin-top:auto}
.piede{display:flex;justify-content:space-between;border-top:1px solid #cfc6b5;padding-top:20px;margin-top:34px;font:500 15px/1 M;letter-spacing:.12em;text-transform:uppercase;color:#4f5b5c}
svg{position:absolute;right:92px;top:120px}
</style></head><body>
<svg width="300" height="300" viewBox="0 0 32 32" fill="none" stroke="#1f5c68" stroke-width=".22" stroke-linejoin="round">
<path d="M16 5 26 10.5v11L16 27 6 21.5v-11Z"/><path d="M6 10.5 16 16l10-5.5M16 16v11"/>
<path d="M6 10.5 16 5l10 5.5" stroke="#cfc6b5"/><ellipse cx="16" cy="27.6" rx="12" ry="2.6" stroke="#cfc6b5"/></svg>
<div class="t"><div class="eti">Galleria di edifici · modello 3D · plastico · AR</div>
<h1>3D Building</h1><div class="firma">by FareLAB</div>
<p class="txt">Edifici rilevati dal cielo con il drone, stampati in scala.</p>
<div class="piede"><span>Monopoli · Valle d’Itria · Sud-Est barese</span><span style="text-transform:none">FareLAB</span></div></div>
</body></html>`;
const chrome = await trovaChrome({});
const b = await puppeteer.launch({ executablePath: chrome.percorso, headless: chrome.headless });
const p = await b.newPage();
await p.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
await p.setContent(html, { waitUntil: 'load' });
await p.evaluate(() => document.fonts.ready);
const png = await p.screenshot({ type: 'png' });
await b.close();
await sharp(png).jpeg({ quality: 88, mozjpeg: true }).toFile(path.join(PROJ, 'public/anteprima-sito.jpg'));
console.log('ok', fs.statSync(path.join(PROJ, 'public/anteprima-sito.jpg')).size);
