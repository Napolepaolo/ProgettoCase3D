// Costruzione degli URL tenendo conto di `base` (sottocartella su GitHub Pages)
// e di `site` (dominio pubblico, per Open Graph, canonical e QR code).

/** Percorso interno al sito, con la base di pubblicazione davanti. Es. url('opere/x/') → '/opere/x/'. */
export function url(percorso = ''): string {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
  return `${base}/${percorso.replace(/^\/+/, '')}`;
}

/** URL assoluto (https://dominio/...) di un percorso interno al sito. */
export function urlAssoluto(percorso = ''): string {
  return new URL(url(percorso), import.meta.env.SITE).href;
}
