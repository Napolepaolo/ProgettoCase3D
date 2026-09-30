// @ts-check
import { defineConfig } from 'astro/config';

// URL pubblico del sito: serve per gli URL assoluti (Open Graph, QR code, canonical).
// In produzione impostalo con la variabile d'ambiente SITE_URL, es.:
//   SITE_URL=https://3dbuilding.farelab.it npm run build
const site = process.env.SITE_URL ?? 'https://3dbuilding.example.com';
if (!process.env.SITE_URL && process.argv.includes('build')) {
  console.warn(
    '\n[3D Building] SITE_URL non impostato: QR code, anteprime WhatsApp e canonical puntano a ' +
      `${site}. Per la pubblicazione: SITE_URL=https://tuodominio npm run build\n`,
  );
}

// Sottocartella di pubblicazione: '/' per dominio proprio, Netlify e Cloudflare Pages;
// '/nome-repo/' solo per GitHub Pages senza dominio personalizzato.
const base = process.env.BASE_PATH ?? '/';

// Host dei tunnel HTTPS usati per provare l'AR dal telefono (vedi README).
const hostTunnel = ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.app', '.loca.lt'];

export default defineConfig({
  site,
  base,
  // URL stabili nella forma /opere/<slug>/ (il QR sul plastico punta qui).
  trailingSlash: 'always',
  build: { format: 'directory' },
  server: { allowedHosts: hostTunnel },
  vite: {
    // Vite di default punta a Safari 16.4 e riscrive le media query come (width>=48rem),
    // sintassi che iPhone con iOS 15–16.3 non capiscono: allarghiamo il supporto.
    build: {
      target: ['chrome100', 'edge100', 'firefox100', 'safari15', 'ios15'],
      cssTarget: ['chrome100', 'edge100', 'firefox100', 'safari15', 'ios15'],
      // model-viewer 4.3.1 lascia nel pacchetto dei console.log di debug
      // ("BAILING OUT EARLY!", "IntersectionObserver fired!"): li togliamo dalla build.
      rolldownOptions: {
        treeshake: { manualPureFunctions: ['console.log'] },
      },
      // Il chunk di model-viewer (three.js incluso) pesa ~1 MB, ~290 KB compresso:
      // è atteso, e viene scaricato solo nelle pagine delle opere con un modello.
      chunkSizeWarningLimit: 1200,
    },
    server: { allowedHosts: hostTunnel },
    preview: { allowedHosts: hostTunnel },
  },
});
