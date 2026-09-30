#!/usr/bin/env bash
# Estrae N frame EQUIDISTANTI dal video di un giro del plastico sul piatto girevole e li
# scrive in public/opere/<slug>/plastico/frame/001.webp … NNN.webp per il turntable del sito.
#
#   scripts/estrai-frame.sh <video> <slug> [opzioni]      (-h per l'aiuto)
#
# Compatibile con bash 3.2 (quello di macOS): niente array associativi né ${var,,}.

set -euo pipefail
# Numeri col punto decimale anche con la lingua italiana del Mac (awk printf "%.6f" seguirebbe
# LC_NUMERIC e scriverebbe "2,500000", che ffmpeg -ss rifiuta).
export LC_ALL=C

NUMERO=36
LATO=1600
QUALITA=82
INIZIO=0
DURATA=""
RITAGLIO=""
PIENO=0
INVERTI=0
SI=0
PROVA=0
USCITA=""

RADICE="$(cd "$(dirname "$0")/.." && pwd)"

aiuto() {
  cat <<'FINE'

Uso: scripts/estrai-frame.sh <video> <slug> [opzioni]

Estrae N frame equidistanti da UN giro completo del plastico e li salva in
public/opere/<slug>/plastico/frame/001.webp, 002.webp, …

Opzioni:
  -n <numero>     numero di frame (predefinito 36; 72 per una rotazione più fluida)
  -l <pixel>      lato lungo massimo (predefinito 1600; mai ingrandito)
  -q <qualità>    qualità WebP 0-100 (predefinito 82)
  -i <secondi>    istante in cui inizia il giro, col plastico di FRONTE (predefinito 0)
  -d <secondi>    durata esatta di un giro completo (predefinito: dal punto -i alla fine del video)
  -c <w:h:x:y>    ritaglio in pixel prima del ridimensionamento (filtro crop di ffmpeg).
                  Senza -c il fotogramma viene ritagliato a un QUADRATO centrato: il plastico,
                  al centro del piatto, riempie così il riquadro della pagina
  -p              nessun ritaglio: tiene il fotogramma intero (es. 16:9)
  -r              inverte il senso di rotazione (se il piatto girava in senso orario)
  -o <cartella>   cartella di uscita diversa (predefinito public/opere/<slug>/plastico/frame)
  -y              sostituisce i frame esistenti senza chiedere conferma
  --prova         stampa i comandi ffmpeg senza eseguirli (non serve ffmpeg installato,
                  ma senza ffprobe bisogna indicare -d)
  -h, --help      questo aiuto

Frame: il k-esimo (k = 0 … N-1) è preso all'istante  inizio + k · durata / N.
L'ultimo NON coincide col primo: il giro si chiude tornando al frame 001.
Il frame 001 deve essere la vista frontale; indici crescenti = piatto che gira in senso
ANTIORARIO visto dall'alto. Con -r l'ordine viene invertito tenendo 001 come fronte.

Esempio (il giro comincia a 2,5 s e dura 24 s):
  scripts/estrai-frame.sh ~/Movies/giro.mov masseria-san-domenico -i 2.5 -d 24 -n 72

FINE
}

errore() {
  printf '\nERRORE  %s\n\n' "$1" >&2
  exit "${2:-1}"
}

# --- Argomenti (in qualunque ordine) ----------------------------------------------------
POSIZIONALI=()
richiedi_valore() {
  [ "$#" -ge 2 ] && [ -n "$2" ] || errore "l'opzione $1 richiede un valore (vedi -h)"
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) aiuto; exit 0 ;;
    -n) richiedi_valore "$@"; NUMERO="$2"; shift 2 ;;
    -l) richiedi_valore "$@"; LATO="$2"; shift 2 ;;
    -q) richiedi_valore "$@"; QUALITA="$2"; shift 2 ;;
    -i) richiedi_valore "$@"; INIZIO="$2"; shift 2 ;;
    -d) richiedi_valore "$@"; DURATA="$2"; shift 2 ;;
    -c) richiedi_valore "$@"; RITAGLIO="$2"; shift 2 ;;
    -o) richiedi_valore "$@"; USCITA="$2"; shift 2 ;;
    -p) PIENO=1; shift ;;
    -r) INVERTI=1; shift ;;
    -y) SI=1; shift ;;
    --prova) PROVA=1; shift ;;
    --) shift; while [ "$#" -gt 0 ]; do POSIZIONALI+=("$1"); shift; done ;;
    -*) errore "opzione sconosciuta: $1 (vedi -h)" ;;
    *) POSIZIONALI+=("$1"); shift ;;
  esac
done

[ "${#POSIZIONALI[@]}" -eq 2 ] || { aiuto; errore "servono due argomenti: <video> <slug>"; }
VIDEO="${POSIZIONALI[0]}"
SLUG="${POSIZIONALI[1]}"

# --- Validazione --------------------------------------------------------------------------
REGEX_SLUG='^[a-z0-9]+(-[a-z0-9]+)*$'
REGEX_INTERO='^[0-9]+$'
REGEX_DECIMALE='^[0-9]+([.][0-9]+)?$'
REGEX_RITAGLIO='^[0-9]+:[0-9]+:[0-9]+:[0-9]+$'

[[ "$SLUG" =~ $REGEX_SLUG ]] || errore "slug non valido: \"$SLUG\" (solo minuscole, numeri e trattini, es. masseria-san-domenico)"
[[ "$NUMERO" =~ $REGEX_INTERO ]] || errore "-n deve essere un intero fra 2 e 720 (ricevuto \"$NUMERO\")"
[[ "$LATO" =~ $REGEX_INTERO ]] || errore "-l deve essere un intero fra 64 e 8192 (ricevuto \"$LATO\")"
[[ "$QUALITA" =~ $REGEX_INTERO ]] || errore "-q deve essere un intero fra 0 e 100 (ricevuto \"$QUALITA\")"
# In base 10 anche con zeri iniziali ("036"): per bash un numero che comincia con 0 è ottale.
NUMERO=$((10#$NUMERO)); LATO=$((10#$LATO)); QUALITA=$((10#$QUALITA))
[ "$NUMERO" -ge 2 ] && [ "$NUMERO" -le 720 ] || errore "-n deve essere un intero fra 2 e 720 (ricevuto \"$NUMERO\")"
[[ "$LATO" =~ $REGEX_INTERO ]] && [ "$LATO" -ge 64 ] && [ "$LATO" -le 8192 ] || errore "-l deve essere un intero fra 64 e 8192 (ricevuto \"$LATO\")"
[[ "$QUALITA" =~ $REGEX_INTERO ]] && [ "$QUALITA" -le 100 ] || errore "-q deve essere un intero fra 0 e 100 (ricevuto \"$QUALITA\")"
[[ "$INIZIO" =~ $REGEX_DECIMALE ]] || errore "-i deve essere un numero di secondi, es. 2.5 (ricevuto \"$INIZIO\")"
if [ -n "$DURATA" ]; then
  [[ "$DURATA" =~ $REGEX_DECIMALE ]] || errore "-d deve essere un numero di secondi, es. 24 (ricevuto \"$DURATA\")"
fi
if [ -n "$RITAGLIO" ]; then
  [[ "$RITAGLIO" =~ $REGEX_RITAGLIO ]] || errore "-c deve avere la forma larghezza:altezza:x:y, es. 1080:1080:420:0 (ricevuto \"$RITAGLIO\")"
fi
if [ "$PROVA" -eq 0 ] && [ ! -f "$VIDEO" ]; then
  errore "video non trovato: $VIDEO"
fi
[ -n "$USCITA" ] || USCITA="$RADICE/public/opere/$SLUG/plastico/frame"

# --- ffmpeg / ffprobe ----------------------------------------------------------------------
suggerimento_ffmpeg() {
  cat >&2 <<'FINE'
ffmpeg non è installato. Alternative:
  - con Homebrew:        brew install ffmpeg
  - binari già pronti:   https://evermeet.cx/ffmpeg/ (scarica ffmpeg e ffprobe, rendili
                         eseguibili con chmod +x e mettili in una cartella del PATH)
Per vedere i comandi senza eseguirli: aggiungi --prova (con -d, se manca ffprobe).
FINE
}

if [ "$PROVA" -eq 0 ]; then
  command -v ffmpeg >/dev/null 2>&1 || { suggerimento_ffmpeg; errore "manca ffmpeg" 3; }
  # Serve l'encoder "libwebp" (non basta "libwebp_anim").
  # Output letto per intero prima del grep: con pipefail, "grep -q" che esce al primo risultato
  # può far morire ffmpeg di SIGPIPE e dare un falso "encoder mancante".
  CODIFICATORI="$(ffmpeg -hide_banner -encoders 2>/dev/null || true)"
  if ! printf '%s\n' "$CODIFICATORI" | grep -E '^ *V[^ ]* +libwebp( |$)' >/dev/null; then
    errore "questo ffmpeg non ha l'encoder libwebp: installa una build completa (brew install ffmpeg o evermeet.cx)" 3
  fi
fi

if [ -z "$DURATA" ]; then
  if command -v ffprobe >/dev/null 2>&1 && [ -f "$VIDEO" ]; then
    TOTALE="$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$VIDEO" | head -n 1)"
    [[ "$TOTALE" =~ $REGEX_DECIMALE ]] || errore "ffprobe non riesce a leggere la durata del video (\"$TOTALE\"): indica -d"
    DURATA="$(awk -v t="$TOTALE" -v i="$INIZIO" 'BEGIN { printf "%.6f", t - i }')"
    printf 'Durata non indicata: considero un giro da %s s fino alla fine del video.\n' "$DURATA"
    printf 'Se il video contiene più di un giro o parti ferme, indica -i e -d.\n'
  else
    [ "$PROVA" -eq 1 ] || { suggerimento_ffmpeg; errore "manca ffprobe per leggere la durata: indica -d" 3; }
    errore "in modalità --prova senza ffprobe serve -d <durata di un giro in secondi>"
  fi
fi
awk -v d="$DURATA" 'BEGIN { exit !(d > 0) }' || errore "la durata del giro deve essere maggiore di zero (ricevuto $DURATA)"

# --- Video HDR (iPhone: HLG / Dolby Vision) -------------------------------------------------
# Convertiti in WebP senza tone mapping escono slavati: se ffmpeg ha zscale li riportiamo in SDR.
TONEMAP=""
if command -v ffprobe >/dev/null 2>&1 && [ -f "$VIDEO" ]; then
  TRASFERIMENTO="$(ffprobe -v error -select_streams v:0 -show_entries stream=color_transfer -of default=noprint_wrappers=1:nokey=1 "$VIDEO" | head -n 1 || true)"
  case "$TRASFERIMENTO" in
    arib-std-b67|smpte2084)
      FILTRI_DISPONIBILI="$(ffmpeg -hide_banner -filters 2>/dev/null || true)"
      if printf '%s\n' "$FILTRI_DISPONIBILI" | grep -E ' zscale ' >/dev/null && printf '%s\n' "$FILTRI_DISPONIBILI" | grep -E ' tonemap ' >/dev/null; then
        TONEMAP="zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,"
        printf 'Nota: video HDR (%s), convertito in SDR per i frame.\n' "$TRASFERIMENTO"
      else
        printf 'ATTENZIONE: video HDR (%s) e questo ffmpeg non ha zscale: i frame potrebbero uscire slavati.\n' "$TRASFERIMENTO" >&2
        printf '  Su iPhone registra in SDR (Impostazioni > Fotocamera > Registra video > Video HDR: off)\n' >&2
        printf '  oppure esporta il video come "Più compatibile".\n' >&2
      fi
      ;;
  esac
fi

# --- Filtri --------------------------------------------------------------------------------
# Lato lungo = min(originale, LATO); l'altro proporzionale e pari (-2). Le virgole delle
# espressioni sono protette dagli apici (livello del filtergraph di ffmpeg).
SCALA="scale=w='if(gte(iw,ih),min(iw,$LATO),-2)':h='if(gte(iw,ih),-2,min(ih,$LATO))':flags=lanczos"
# Senza -c né -p: quadrato centrato, lato = lato corto del video (pari, per la codifica).
QUADRATO="crop=w='trunc(min(iw,ih)/2)*2':h='trunc(min(iw,ih)/2)*2'"
if [ -n "$RITAGLIO" ]; then
  FILTRO="${TONEMAP}crop=$RITAGLIO,$SCALA"
elif [ "$PIENO" -eq 1 ]; then
  FILTRO="${TONEMAP}$SCALA"
else
  FILTRO="${TONEMAP}$QUADRATO,$SCALA"
fi

# --- Istanti dei frame ---------------------------------------------------------------------
# Un comando ffmpeg per frame con -ss PRIMA di -i: ricerca veloce al keyframe precedente
# e poi decodifica fino all'istante esatto (preciso al frame da ffmpeg 2.1). Rispetto a
# fps=N/durata o select, il frame scelto è evidente e indipendente dal PTS iniziale e dal
# frame rate variabile dei telefoni: è sempre il primo frame con tempo >= istante.
ISTANTI="$(awk -v i="$INIZIO" -v d="$DURATA" -v n="$NUMERO" 'BEGIN { for (k = 0; k < n; k++) printf "%.6f\n", i + k * d / n }')"

indice_uscita() {
  # k parte da 0. Con -r: 001 resta il fronte, poi l'ordine si inverte (N, N-1, …).
  local k="$1"
  if [ "$INVERTI" -eq 1 ] && [ "$k" -gt 0 ]; then
    echo $(( NUMERO - k + 1 ))
  else
    echo $(( k + 1 ))
  fi
}

printf '\nVideo:     %s\n' "$VIDEO"
printf 'Opera:     %s\n' "$SLUG"
printf 'Frame:     %s, da %s s per %s s (passo %s s)%s\n' "$NUMERO" "$INIZIO" "$DURATA" \
  "$(awk -v d="$DURATA" -v n="$NUMERO" 'BEGIN { printf "%.4f", d / n }')" "$([ "$INVERTI" -eq 1 ] && echo ', ordine invertito')"
printf 'Formato:   WebP qualità %s, lato lungo max %s px, %s\n' "$QUALITA" "$LATO" \
  "$(if [ -n "$RITAGLIO" ]; then echo "ritaglio $RITAGLIO"; elif [ "$PIENO" -eq 1 ]; then echo 'fotogramma intero'; else echo 'ritaglio quadrato centrato'; fi)"
printf 'Uscita:    %s\n\n' "$USCITA"

# Argomenti di ffmpeg per un frame (istante, file di uscita).
ffmpeg_frame() {
  ffmpeg -hide_banner -loglevel error -nostdin -y -ss "$1" -i "$VIDEO" -frames:v 1 -an -sn \
    -vf "$FILTRO" -c:v libwebp -quality "$QUALITA" -compression_level 6 -map_metadata -1 "$2"
}

if [ "$PROVA" -eq 1 ]; then
  echo "Modalità prova: comandi che verrebbero eseguiti"
  k=0
  for t in $ISTANTI; do
    nome="$(printf '%03d' "$(indice_uscita "$k")").webp"
    printf '  [%s <- %s s]  ' "$nome" "$t"
    printf '%q ' ffmpeg -hide_banner -loglevel error -nostdin -y -ss "$t" -i "$VIDEO" -frames:v 1 -an -sn \
      -vf "$FILTRO" -c:v libwebp -quality "$QUALITA" -compression_level 6 -map_metadata -1 "$USCITA/$nome"
    printf '\n'
    k=$((k + 1))
  done
else
  # Conferma prima di toccare i frame esistenti.
  if [ -d "$USCITA" ] && ls "$USCITA" 2>/dev/null | grep -Eq '^[0-9]{3}[.](webp|jpg|jpeg|png)$'; then
    if [ "$SI" -ne 1 ]; then
      [ -t 0 ] || errore "in $USCITA ci sono già dei frame: rilancia con -y per sostituirli"
      printf 'In %s ci sono già dei frame: li sostituisco? [s/N] ' "$USCITA"
      read -r risposta
      case "$risposta" in
        s|S|si|SI|sì|Sì|y|Y) ;;
        *) printf 'Annullato: nessun file modificato.\n'; exit 0 ;;
      esac
    fi
  fi

  # Estrazione in una cartella temporanea: i vecchi frame si toccano solo se tutto riesce.
  mkdir -p "$(dirname "$USCITA")"
  TEMP="$(mktemp -d "$(dirname "$USCITA")/.frame-nuovi.XXXXXX")"
  trap 'rm -rf "$TEMP"' EXIT
  k=0
  for t in $ISTANTI; do
    nome="$(printf '%03d' "$(indice_uscita "$k")").webp"
    printf '\r  frame %s/%s (%s s)   ' "$((k + 1))" "$NUMERO" "$t"
    ffmpeg_frame "$t" "$TEMP/$nome" || errore "ffmpeg non è riuscito a estrarre il frame a $t s"
    [ -s "$TEMP/$nome" ] || errore "nessun frame a $t s: il video finisce prima? Controlla -i e -d"
    k=$((k + 1))
  done
  printf '\n'

  mkdir -p "$USCITA"
  find "$USCITA" -maxdepth 1 -type f \( -name '[0-9][0-9][0-9].webp' -o -name '[0-9][0-9][0-9].jpg' \
    -o -name '[0-9][0-9][0-9].jpeg' -o -name '[0-9][0-9][0-9].png' \) -delete
  mv "$TEMP"/*.webp "$USCITA"/
  PESO="$(du -sk "$USCITA" | awk '{ printf "%.1f", $1 / 1024 }')"
  printf 'Fatto: %s frame in %s (%s MB)\n' "$NUMERO" "$USCITA" "$PESO"
fi

printf '\nIn data/opere.json, nell'"'"'opera "%s":\n\n' "$SLUG"
if [ "$INVERTI" -eq 1 ]; then
  printf '  "turntable": { "cartella": "plastico/frame", "numeroFrame": %s, "estensione": "webp" }\n' "$NUMERO"
  printf '\n(l'"'"'ordine è già invertito nei file: NON aggiungere "inverti": true)\n\n'
else
  printf '  "turntable": { "cartella": "plastico/frame", "numeroFrame": %s, "estensione": "webp" }\n\n' "$NUMERO"
fi
