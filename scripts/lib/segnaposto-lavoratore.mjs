// Thread di render per i frame del giro: riceve la scena del plastico una volta,
// poi un angolo alla volta, e restituisce i pixel RGB (trasferiti, non copiati).

import { parentPort, workerData } from 'node:worker_threads';
import { renderFoto } from './segnaposto-scene.mjs';

const { plastico } = workerData;

parentPort.on('message', ({ indice, angolo, larghezza, altezza }) => {
  try {
    const pixel = renderFoto(plastico, angolo, { larghezza, altezza });
    parentPort.postMessage({ indice, pixel }, [pixel.buffer]);
  } catch (errore) {
    parentPort.postMessage({ indice, errore: errore.stack ?? String(errore) });
  }
});
