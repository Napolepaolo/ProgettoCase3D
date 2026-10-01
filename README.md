# 3D Building — by FareLAB

Galleria di edifici rilevati con fotogrammetria da drone. Ogni opera ha una pagina con:

- il **modello digitale** texturizzato, navigabile (`<model-viewer>` di Google);
- il **plastico stampato** in un visualizzatore a 360° (sequenza di foto su piatto girevole);
- il pulsante **"Vedi nella tua stanza"** per la realtà aumentata (su computer: un QR code che
  apre la pagina sul telefono).

Sito statico (Astro), senza backend. Aggiungere un edificio non richiede di toccare il codice:
basta un file di dati e le cartelle con i file dell'opera.

> Le quattro opere presenti ora (masseria, trullo, chiesetta, palazzetto) sono **segnaposto**
> generati al computer per provare il sito. Vedi [Togliere i segnaposto](#togliere-i-segnaposto).

---

## Indice

1. [Avvio in locale](#avvio-in-locale)
2. [Come è fatto il progetto](#come-è-fatto-il-progetto)
3. [Aggiungere un nuovo edificio (checklist)](#aggiungere-un-nuovo-edificio-checklist)
4. [Gli script](#gli-script)
5. [Realtà aumentata: come funziona e come provarla](#realtà-aumentata-come-funziona-e-come-provarla)
6. [Pubblicazione](#pubblicazione)
7. [Scelte tecniche e limiti noti](#scelte-tecniche-e-limiti-noti)

---

## Avvio in locale

### Node.js

Serve Node.js 22.12 o più recente. Su questo Mac è installato **Node 24 LTS in `~/.local/node`**
(scaricato da nodejs.org, senza toccare il sistema). Per averlo nel terminale aggiungi questa
riga a `~/.zshrc` e apri un nuovo terminale:

```sh
export PATH="$HOME/.local/node/bin:$PATH"
```

In alternativa puoi installare Node con il pacchetto ufficiale da <https://nodejs.org>.

### Comandi

```sh
cd 3d-building
npm install          # la prima volta (rete lenta? le impostazioni in .npmrc aiutano)
npm run dev          # sito in sviluppo su http://localhost:4321/
```

| Comando | Cosa fa |
|---|---|
| `npm run dev` | server di sviluppo con ricarica automatica |
| `npm run build` | crea il sito pubblicabile in `dist/` |
| `npm run preview` | serve `dist/` come in produzione, su http://localhost:4321/ |
| `npm run check` | controllo dei tipi (TypeScript) di pagine e script |
| `npm run dev:rete` / `preview:rete` | come sopra, raggiungibili anche dagli altri dispositivi della rete |
| `npm run ispeziona -- <cartella>` | analizza un export di WebODM |
| `npm run converti -- <slug>` | OBJ → GLB ottimizzato + poster |
| `npm run poster -- <slug>` | rifà solo poster e anteprima social |
| `npm run frame -- <video> <slug>` | estrae i frame del plastico da un video |
| `npm run segnaposto` | rigenera le opere dimostrative |
| `npm run anteprima-sito` | rifà l'anteprima WhatsApp delle pagine che non sono un'opera |
| `npm run browser:installa` | scarica il Chrome headless usato per i poster |

Nota su `npm run …`: le opzioni per lo script vanno dopo `--`, es.
`npm run converti -- masseria-san-domenico --rotazione -90`.

---

## Come è fatto il progetto

```
3d-building/
├── data/opere.json              ← l'elenco delle opere (l'unico file da modificare)
├── public/opere/<slug>/
│   ├── modello/                 ← modello.glb, modello.usdz (facoltativo), poster.jpg, anteprima-social.jpg
│   └── plastico/                ← frame/001.webp … oppure foto.jpg
├── sorgenti/<slug>/             ← export di WebODM (NON va nel repository)
├── scripts/                     ← conversione, poster, frame, ispezione, segnaposto
└── src/
    ├── pages/                   ← galleria, /opere/<slug>/, chi-siamo, a-cosa-serve, contatti, 404
    ├── components/              ← ModelloDigitale, Turntable, PulsanteAR, CardOpera, …
    ├── scripts/                 ← JavaScript del browser (turntable, model-viewer, AR)
    ├── lib/opere.ts             ← lettura e controllo di data/opere.json
    └── styles/global.css        ← colori, font e stili comuni (variabili CSS in :root)
```

### Il file `data/opere.json`

Un array di opere, nell'ordine in cui compaiono in galleria. I percorsi dei file sono
**relativi alla cartella dell'opera** `public/opere/<slug>/`.

```json
{
  "slug": "masseria-san-domenico",
  "nome": "Masseria San Domenico",
  "localita": "Monopoli (BA)",
  "anno": 2026,
  "descrizione": "Una riga o due che descrivono l'edificio.",
  "glb": "modello/modello.glb",
  "usdz": null,
  "poster": "modello/poster.jpg",
  "anteprimaSocial": "modello/anteprima-social.jpg",
  "turntable": { "cartella": "plastico/frame", "numeroFrame": 36, "estensione": "webp" },
  "fotoPlastico": null,
  "scalaAR": 35,
  "pubblicato": false
}
```

| Campo | Significato |
|---|---|
| `slug` | nome nell'indirizzo: la pagina sarà `/opere/<slug>/`. Solo minuscole, numeri e trattini. **Non cambiarlo dopo aver stampato il QR** sul plastico. |
| `nome`, `localita`, `anno`, `descrizione` | testi della pagina e delle anteprime (`anno` può essere `null`) |
| `glb` | modello per web e Android |
| `usdz` | modello per iPhone/iPad (facoltativo, vedi [USDZ](#iphone-e-il-file-usdz)) |
| `poster` | immagine mostrata finché il modello non è caricato, e nella galleria |
| `anteprimaSocial` | immagine per WhatsApp e social (facoltativa: altrimenti si usa il poster) |
| `turntable` | frame del plastico: `001.webp`, `002.webp`, … nella `cartella`. `"inverti": true` se il giro va al contrario; `"allineamento": 90` (gradi, facoltativo) se il frame 001 non mostra la stessa facciata del modello, vedi [Modello e plastico girano insieme](#modello-e-plastico-girano-insieme). `null` se non ci sono ancora. |
| `fotoPlastico` | una sola foto del plastico, usata se `turntable` è `null` |
| `scalaAR` | lato maggiore della base del modello in AR, in **centimetri** (es. 35). Viene "cotto" nel GLB dallo script di conversione. |
| `pubblicato` | `false` = l'opera non compare e la sua pagina non viene creata |

Il file viene controllato a ogni build: un campo sbagliato o mancante blocca la build con un
messaggio chiaro. Se invece manca un **file** (il modello non è ancora pronto, mancano dei frame),
la pagina mostra un segnaposto elegante ("Modello in lavorazione", "Plastico in lavorazione") e
la build stampa un avviso `[opere] …`.

---

## Aggiungere un nuovo edificio (checklist)

Esempio con lo slug `masseria-san-domenico`.

1. **Scarica da WebODM** il *Textured Model* ed estrailo in `sorgenti/masseria-san-domenico/`,
   lasciando insieme OBJ, MTL e tutte le texture (dettagli in `sorgenti/LEGGIMI.md`).
   **Attenzione al terreno:** la mesh di WebODM comprende anche il terreno rilevato attorno
   all'edificio, e la scala da plastico si calcola sull'ingombro totale. Se non vuoi il terreno
   nel plastico, ritaglialo prima: in WebODM con un *boundary* (poligono di ritaglio) prima
   dell'elaborazione, oppure in Blender cancellando le facce del terreno e riesportando l'OBJ
   (con le texture).
2. **Ispeziona** il dataset:
   ```sh
   npm run ispeziona -- sorgenti/masseria-san-domenico
   ```
   Ti dice numero di triangoli, texture (e se ne manca qualcuna), coordinate, peso stimato del GLB.
3. **Aggiungi l'opera** in `data/opere.json` con `"pubblicato": false` (se non la aggiungi, lo
   script di conversione stampa lo snippet già pronto da incollare).
4. **Converti** il modello:
   ```sh
   npm run converti -- masseria-san-domenico
   ```
   Crea `modello.glb`, `poster.jpg` e `anteprima-social.jpg` in `public/opere/masseria-san-domenico/modello/`
   e stampa un resoconto (peso, triangoli, dimensioni in cm, scala).
   - La facciata "di fronte" di default è quella a **sud**. Per cambiarla: `--rotazione 90` (ovest),
     `-90` (est), `180` (nord), o qualsiasi angolo.
   - **Obiettivo: GLB sotto 10–15 MB.** Oltre, lo script avvisa e propone una decimazione
     (es. *Decimate* in Blender con un rapporto indicato), poi riesporti l'OBJ e rilanci.
5. **iPhone (consigliato per i rilievi veri):** crea `modello.usdz` e indica `"usdz": "modello/modello.usdz"`
   (vedi [USDZ](#iphone-e-il-file-usdz)).
6. **Plastico:** gira un video del plastico sul piatto girevole ed estrai i frame:
   ```sh
   npm run frame -- ~/Movies/giro.mov masseria-san-domenico -i 2.5 -d 24 -n 36
   ```
   `-i` = secondo in cui il plastico è di fronte, `-d` = durata di **un** giro. I frame vengono
   ritagliati a un quadrato centrato (così riempiono il riquadro della pagina): tieni il plastico
   al centro dell'inquadratura. Serve `ffmpeg` (vedi [Gli script](#estrai-framesh)). Poi in `data/opere.json`:
   `"turntable": { "cartella": "plastico/frame", "numeroFrame": 36, "estensione": "webp" }`.
   In alternativa: una sola foto in `plastico/foto.jpg` e `"fotoPlastico": "plastico/foto.jpg"`.
   Gira il modello e controlla che il plastico mostri **la stessa facciata**: se è sfasato, aggiungi
   `"allineamento"` (vedi [Modello e plastico girano insieme](#modello-e-plastico-girano-insieme)).
7. **Controlla** con `npm run dev` la pagina `http://localhost:4321/opere/masseria-san-domenico/`
   (le opere non pubblicate non hanno pagina: per vederla metti temporaneamente `"pubblicato": true`).
8. **Pubblica:** `"pubblicato": true`, poi build e pubblicazione (vedi [Pubblicazione](#pubblicazione)).
9. **QR sul plastico:** punta a `https://napolepaolo.github.io/ProgettoCase3D/opere/masseria-san-domenico/`
   (vedi [Prima di stampare i QR sui plastici](#prima-di-stampare-i-qr-sui-plastici)).
   Il QR della pagina (su computer) usa lo stesso indirizzo.

### Togliere i segnaposto

Quando c'è la prima opera vera: cancella da `data/opere.json` le voci `masseria-del-segnaposto`,
`trullo-di-prova`, `chiesetta-rurale`, `palazzetto-sul-porto` e `bozza-non-pubblicata`, e le
rispettive cartelle in `public/opere/`. Lo script `genera-segnaposto.mjs` e i file
`scripts/lib/segnaposto-*.mjs` si possono tenere (non finiscono nel sito) o cancellare.
Il generatore non tocca mai una cartella di opera senza il suo file marcatore `.segnaposto`,
quindi non può sovrascrivere un rilievo vero.

### Modello e plastico girano insieme

Nella pagina di un'opera che ha sia il modello 3D sia il giro a 360° del plastico, le due viste
sono collegate: girando il modello (col dito, col mouse o con le frecce) il plastico mostra la foto
presa dallo stesso lato, e girando il plastico si sposta la vista del modello. Anche la rotazione
automatica del plastico, all'apertura della pagina, fa girare il modello.

Perché le due viste coincidano, il **frame 001** deve mostrare la stessa facciata che il modello ha
"di fronte" (quella scelta con `--rotazione` nella conversione; senza rotazione è la facciata a sud).
Se il video del plastico parte da un'altra facciata, invece di rifare i frame basta indicare di
quanti gradi correggere:

```json
"turntable": { "cartella": "plastico/frame", "numeroFrame": 36, "estensione": "webp", "allineamento": 90 }
```

Prova 90, 180 o -90 (o valori intermedi) finché, girando il modello, il plastico mostra la stessa
facciata. Il collegamento si attiva da solo quando ci sono entrambi (con una sola foto del plastico
no).

---

## Gli script

Tutti hanno l'aiuto completo con `--help` (es. `node scripts/converti-modello.mjs --help`).

### `ispeziona-dataset.mjs`
`npm run ispeziona -- <cartella-o-file.obj> [--json]` — elenco dei file, vertici e triangoli
dell'OBJ (letto in streaming, anche file da GB), texture referenziate e mancanti, risoluzione
delle immagini, coordinate georeferenziate, stima del peso finale.

### `converti-modello.mjs`
`npm run converti -- <slug> [opzioni]` — la pipeline riproducibile:

1. riduce le texture alla misura finale e toglie il canale alfa **prima** della conversione
   (gli atlanti di WebODM arrivano a 8192 px: così la memoria resta bassa);
   se le coordinate sono UTM (valori enormi) le trasla attorno all'origine: in float32 un rilievo
   a 4.500.000 m di nord perderebbe precisione a passi di 0,5 m;
2. OBJ → GLB con `obj2gltf`, asse Z (WebODM) → Y (glTF);
3. ottimizzazione con `glTF-Transform`: deduplica, pulizia, saldatura dei vertici, normali,
   texture ridimensionate (max 2048 px, `--texture 4096` su richiesta) in JPEG (o WebP);
4. orientamento, centratura, base appoggiata a terra e **scala da plastico** (`scalaAR`);
5. compressione **Draco** (o Meshopt con `--compressione meshopt`);
6. poster e anteprima social (Chrome headless);
7. resoconto con dimensione finale e avvisi.

Opzioni principali: `--obj <file>`, `--rotazione <gradi>`, `--scala-cm <n>`, `--texture 1024|2048|4096`,
`--formato-texture jpeg|webp`, `--qualita <1-100>`, `--compressione draco|meshopt`,
`--materiale emissivo|unlit|pbr`, `--uscita <cartella>` (per prove), `--senza-poster`.

Memoria: circa 0,5 GB per milione di triangoli (le texture sono già ridotte). Oltre i 5–6 milioni
di triangoli conviene decimare prima in Blender o ridurre `mesh-size` in WebODM: lo script avvisa
all'inizio se il modello sembra troppo grande per la RAM del computer. Ctrl-C interrompe in
sicurezza (i file temporanei vengono cancellati). Le facce senza coordinate texture, se ci sono,
vengono segnalate e colorate di grigio neutro.

### `poster.mjs`
`npm run poster -- <slug>` — rifà `poster.jpg` (1600×1600) e `anteprima-social.jpg` (1200×630,
con nome e località) fotografando il modello con `<model-viewer>` in un Chrome headless, con la
stessa inquadratura e la stessa luce della pagina. Il browser è in `.cache/browsers/` (se manca:
`npm run browser:installa`, ~100 MB).

### `estrai-frame.sh`
`npm run frame -- <video> <slug> [opzioni]` — estrae N frame equidistanti da **un** giro
completo e li salva in `public/opere/<slug>/plastico/frame/` (WebP, lato lungo max 1600 px),
ritagliati a un quadrato centrato. I video HDR dell'iPhone vengono riportati in SDR (altrimenti i
frame uscirebbero slavati).

| Opzione | |
|---|---|
| `-n 36` | numero di frame (72 per una rotazione più fluida) |
| `-i <s>` / `-d <s>` | inizio del giro (plastico di fronte) e durata di un giro |
| `-c w:h:x:y` | ritaglio personalizzato prima del ridimensionamento (al posto del quadrato centrato) |
| `-p` | nessun ritaglio: tiene il fotogramma intero |
| `-r` | inverte il senso (se il piatto girava in senso orario) |
| `-l 1600` / `-q 82` | lato massimo e qualità WebP |
| `-y` | sostituisce i frame esistenti senza chiedere |
| `--prova` | stampa i comandi senza eseguirli |

Richiede **ffmpeg** (non è installato su questo Mac). Opzioni: `brew install ffmpeg` (su macOS 13
Intel Homebrew potrebbe compilarlo da sorgente, lentamente), oppure i binari statici per Mac da
<https://evermeet.cx/ffmpeg/> (`ffmpeg` e `ffprobe`, da mettere per esempio in `~/.local/bin`).

**Convenzione dei frame:** `001` = vista frontale; indici crescenti = piatto che gira in senso
**antiorario** visto dall'alto (l'oggetto ruota verso la destra di chi guarda). Se hai foto già
scattate invece di un video: rinominale `001.webp`, `002.webp`, … con le stesse regole.

### `genera-segnaposto.mjs`
`npm run segnaposto` — rigenera le opere dimostrative (modelli procedurali, poster, frame). Non
serve per le opere vere.

---

## Realtà aumentata: come funziona e come provarla

| Dispositivo | Modalità | Cosa serve |
|---|---|---|
| Android con Chrome | **Scene Viewer** (app Google) o WebXR | il GLB |
| iPhone/iPad con Safari | **AR Quick Look** | l'USDZ (`usdz`), oppure la conversione automatica |
| iPhone con Chrome/Firefox/Edge | AR Quick Look | solo con un USDZ vero |
| Computer | — | al posto del pulsante compare il QR code |

- La scala è quella **da plastico**: il GLB esce dalla conversione già alla misura `scalaAR`
  (es. base di 35 cm). È l'unico modo coerente fra le tre modalità: Scene Viewer riceve solo
  l'indirizzo del file e ignorerebbe qualsiasi scala impostata nella pagina. Nella stanza si
  può comunque ingrandire o rimpicciolire con due dita. **Se cambi `scalaAR` devi rilanciare la
  conversione** (e rifare l'USDZ).
- Il modello compare dritto, centrato e appoggiato al pavimento.
- Su un telefono senza AR (per esempio Chrome su iPhone senza USDZ) il pulsante lascia il posto
  a una nota che spiega cosa fare ("apri la pagina con Safari").

### iPhone e il file USDZ

**Domanda: meglio l'USDZ fatto a mano (`ios-src`) o la generazione automatica di model-viewer?**
Per i rilievi veri, **l'USDZ fatto a mano** (campo `usdz`). Motivi, verificati sul codice di
model-viewer 4.3.1:

- la conversione automatica avviene **sul telefono**: scarica e decodifica tutto il GLB, poi
  riscrive la geometria come testo e le texture come PNG. Nella prova un GLB di 0,7 MB è diventato
  un USDZ di 17,5 MB: con un rilievo vero rischia di essere lenta o di esaurire la memoria di Safari;
- funziona **solo in Safari**: Chrome, Firefox ed Edge su iPhone aprono Quick Look solo con un USDZ vero;
- i materiali "unlit" vengono scartati (il modello sparirebbe). Per questo la conversione usa di
  default un materiale **emissivo** (la texture come luce propria, colori identici alle foto),
  che resta compatibile con la conversione automatica.

La generazione automatica resta il **ripiego** (funziona già con i segnaposto e con modelli leggeri).

**Come creare l'USDZ**, partendo dal GLB già convertito (quindi già in scala da plastico):

- **Blender** (4.x): *File → Import → glTF 2.0* di `modello.glb`, poi *File → Export → Universal Scene
  Description*, estensione `.usdz`. Controlla in Quick Look che la base misuri `scalaAR` cm.
- **Reality Converter** (Apple, gratuito): trascina il GLB e *Export*. Non è verificato che accetti
  GLB compressi con Draco: se lo rifiuta, usa Blender.

Salva il file in `public/opere/<slug>/modello/modello.usdz` e metti `"usdz": "modello/modello.usdz"`.

### Provare l'AR dal telefono (serve HTTPS)

L'AR funziona solo da una pagina **HTTPS** e il telefono deve poter scaricare il modello. La via
più semplice è un tunnel gratuito di Cloudflare, senza account:

```sh
# terminale 1: il sito come in produzione
npm run build && npm run preview

# terminale 2 (la prima volta scarica cloudflared; su Mac Apple Silicon usa …-darwin-arm64.tgz)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz | tar -xz
./cloudflared tunnel --url http://localhost:4321
```

`cloudflared` stampa un indirizzo `https://….trycloudflare.com`. Aprilo sul Mac: il **QR code della
pagina si aggiorna da solo** su quell'indirizzo, quindi basta inquadrarlo col telefono.

- **Android:** Chrome → "Vedi nella tua stanza" → si apre Scene Viewer (serve *Google Play Services
  for AR*, di solito già presente).
- **iPhone/iPad:** **Safari** → "Vedi nella tua stanza" → si apre AR Quick Look.

In alternativa: pubblica un'anteprima su Netlify (ogni pubblicazione ha il suo indirizzo HTTPS).
Il server di sviluppo accetta già gli indirizzi dei tunnel (`*.trycloudflare.com`, `*.ngrok-free.app`,
vedi `astro.config.mjs`).

---

## Pubblicazione

Il sito è pubblicato con **GitHub Pages** dal repository
<https://github.com/Napolepaolo/ProgettoCase3D>, all'indirizzo
**<https://napolepaolo.github.io/ProgettoCase3D/>**.

### Come funziona

Ogni `git push` sul ramo `main` avvia il workflow `.github/workflows/pubblica.yml`: GitHub installa le
dipendenze, fa la build con l'indirizzo pubblico giusto e pubblica `dist/`. In 2–3 minuti il sito è
aggiornato (l'avanzamento si vede nella scheda **Actions** del repository). Si può rilanciare a mano
da *Actions → Pubblica il sito → Run workflow*.

Nel workflow sono impostati:

```yaml
SITE_URL: https://napolepaolo.github.io   # dominio: QR code, anteprime WhatsApp, canonical
BASE_PATH: /ProgettoCase3D/               # sottocartella del sito su GitHub Pages
```

**Prima pubblicazione (una volta sola):** nel repository, *Settings → Pages → Build and deployment →
Source: **GitHub Actions***.

Per provare in locale la build esattamente come online:

```sh
SITE_URL=https://napolepaolo.github.io BASE_PATH=/ProgettoCase3D/ npm run build
```

(Senza `SITE_URL` la build avvisa: gli indirizzi puntano a un dominio d'esempio.)

### Aggiornare il sito

```sh
git add -A
git commit -m "Aggiunta la Masseria San Domenico"
git push
```

### Prima di stampare i QR sui plastici

Il QR sulla base del plastico contiene l'indirizzo della pagina, per esempio
`https://napolepaolo.github.io/ProgettoCase3D/opere/<slug>/`. Se pensi di passare a un **dominio
proprio** (es. `3dbuilding.farelab.it`), fallo **prima** di stampare i QR: GitHub Pages reindirizza
i vecchi indirizzi `github.io` al dominio nuovo, ma è meglio che il QR punti direttamente a quello
definitivo. Per il dominio proprio: *Settings → Pages → Custom domain*, poi nel workflow
`SITE_URL: https://3dbuilding.farelab.it` e `BASE_PATH: /`.

### Limiti di GitHub Pages

- Non permette intestazioni HTTP personalizzate: `public/_headers` viene ignorato (serve solo su
  Netlify/Cloudflare). GitHub serve comunque GLB e USDZ con i tipi MIME corretti.
- `public/.nojekyll` è già presente: senza, la pubblicazione da un ramo ignorerebbe `_astro/`.

### In alternativa: Netlify o Cloudflare Pages

Collegando lo stesso repository: comando di build `npm run build`, cartella `dist`, variabile
d'ambiente `SITE_URL` (senza `BASE_PATH`, il sito sta alla radice del dominio). Qui funziona anche
`public/_headers`, e ogni pubblicazione ha un indirizzo di anteprima HTTPS utile per provare l'AR.
Se un giorno cambi uno slug già stampato su un plastico, su questi servizi basta una riga in
`public/_redirects`: `/opere/vecchio-slug/  /opere/nuovo-slug/  301`.

### Limiti sui file grandi

| Servizio | Limite per file |
|---|---|
| Cloudflare Pages | 25 MiB (e max 20.000 file) |
| GitHub (repository) | 100 MB (avviso sopra 50 MB) |
| Netlify | nessun limite stretto per i siti statici, ma i file grossi rallentano le pubblicazioni |

Con l'obiettivo di **GLB sotto 15 MB** e frame WebP da ~100–200 KB si sta ampiamente dentro tutti i
limiti (un'opera completa pesa circa 20 MB). Se un giorno servissero modelli più pesanti, la strada
è ospitarli su uno storage a parte (per esempio Cloudflare R2 con un dominio proprio e CORS
abilitato): richiederebbe una piccola modifica a `src/lib/opere.ts` per accettare URL assoluti.

---

## Scelte tecniche e limiti noti

- **Astro** genera una pagina HTML per opera partendo da `data/opere.json`, con titolo, descrizione
  e anteprima Open Graph proprie; il JavaScript arriva solo dove serve (il pacchetto di
  model-viewer, ~290 KB compresso, solo nelle pagine delle opere con un modello).
- **Prestazioni:** il modello 3D si carica quando il riquadro è visibile (prima si vede il poster);
  i frame del plastico partono dopo il modello, 4 alla volta, prima uno ogni quattro così si può
  già ruotare.
- **Anteprime WhatsApp:** ogni opera usa la sua `anteprima-social.jpg`; la galleria e le altre
  pagine `public/anteprima-sito.jpg` (rifatta con `npm run anteprima-sito`).
- **Font** Fraunces, Instrument Sans e IBM Plex Mono ospitati dal sito stesso (niente richieste a
  Google Fonts: più veloce e senza problemi di privacy). Anche i decoder Draco sono locali.
- **Rotella del mouse:** sopra il modello fa scorrere la pagina come altrove; si ingrandisce con
  Ctrl/⌘ + rotella, col pizzico sul trackpad o dopo aver cliccato il modello (sul telefono: pizzico).
- **Accessibilità:** testi alternativi, contrasti AA, navigazione da tastiera (il plastico ruota con
  le frecce, Maiusc per passi grandi, Inizio/Fine; la rotazione automatica si ferma quando ci si
  arriva con la tastiera), rispetto di "riduci movimento".
- **Browser:** CSS e JavaScript compilati anche per Safari 15 / iOS 15.
- I segnaposto usano un materiale illuminato normale; i rilievi veri il materiale emissivo con
  `tone-mapping="none"` (impostato in automatico leggendo il GLB), così i colori a schermo sono
  quelli delle foto.
- Da verificare su dispositivi veri: apertura di Scene Viewer e Quick Look, memoria dei telefoni
  con 72 frame, resa di materiali emissivi in Scene Viewer.
