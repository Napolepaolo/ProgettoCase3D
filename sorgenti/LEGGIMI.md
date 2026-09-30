# Sorgenti dei rilievi (non si committano)

Qui vanno gli export di WebODM, **una cartella per opera**, con lo stesso slug usato in
`data/opere.json` e nell'indirizzo della pagina:

```
sorgenti/
  masseria-san-domenico/
    odm_texturing/
      odm_textured_model_geo.obj
      odm_textured_model_geo.mtl
      odm_textured_model_geo_material0000_map_Kd.png
      odm_textured_model_geo_material0001_map_Kd.png
      …
```

Tutto il contenuto di `sorgenti/` è escluso da git (`.gitignore`): sono file pesanti,
restano solo sul tuo computer. Nel repository finiscono solo i file prodotti dagli script
in `public/opere/<slug>/`.

## Cosa scaricare da WebODM

1. Apri il task finito e premi **Download Assets**.
2. Scegli **Textured Model** (basta questo). In alternativa **All Assets** (`all.zip`):
   contiene anche ortofoto, DEM e nuvola di punti, che qui non servono.
3. Estrai l'archivio in `sorgenti/<slug>/` lasciando intatta la cartella `odm_texturing/`:
   l'OBJ, il file `.mtl` e **tutte** le texture `*_map_Kd.*` devono restare insieme.

Si usa `odm_textured_model_geo.obj` (georeferenziato: X = est, Y = nord, Z = quota).
Le coordinate UTM molto grandi non sono un problema: la conversione le trasla da sola.

Per alleggerire alla fonte, in WebODM puoi ridurre `mesh-size` (numero di triangoli)
prima dell'elaborazione.

**Il terreno attorno all'edificio** fa parte della mesh e conta per la scala da plastico (il lato
maggiore della base diventa `scalaAR` cm). Se nel plastico vuoi solo l'edificio, ritaglia prima:
in WebODM con un poligono di ritaglio (*boundary*) prima dell'elaborazione, oppure in Blender
cancellando il terreno e riesportando l'OBJ con le texture.

## I passi

```
npm run ispeziona -- sorgenti/masseria-san-domenico     # controlla file, triangoli, texture, peso stimato
npm run converti -- masseria-san-domenico                # GLB + poster in public/opere/<slug>/modello/
npm run poster -- masseria-san-domenico                  # solo per rifare poster e anteprima
npm run frame -- ~/Movies/giro.mov masseria-san-domenico -i 2.5 -d 24   # frame del plastico
```

Opzioni utili di `converti`: `--rotazione <gradi>` per scegliere la facciata in primo piano
(senza rotazione è quella a sud; 90 = ovest, -90 = est, 180 = nord), `--scala-cm <n>` per il
lato del plastico in AR. Tutte le opzioni: `node scripts/converti-modello.mjs --help`.
