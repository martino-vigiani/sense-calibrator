'use strict';

// Una operazione HID alla volta (calibrazioni, range, flash). È il vecchio flag
// `busy` di app.js, incapsulato con un'epoca: `reset()` (teardown, controller
// scollegato) apre un'epoca nuova, e ogni `beginOp()` restituisce un token con
// l'epoca in cui è partita.
//
// Semantica di OGGI, invariata: `endOp` libera sempre il flag, anche se il
// token appartiene a un'epoca chiusa. È esattamente il difetto noto per cui un
// ciclo di calibrazione orfano (controller scollegato a metà) può liberare il
// `busy` di un'operazione nuova. Il token serve già a riconoscerlo
// (`endOp` restituisce false per un token scaduto) ma nessuno lo fa ancora
// valere: il passo successivo è ignorare i token scaduti, senza cambiare API.
//
// Il flag va alzato PRIMA di qualunque await lungo, non dopo: la finestra tra
// il click e l'alzata basta ad avviare una seconda operazione.
export function createOpGate() {
  let busy = false;
  let epoch = 0;
  return {
    get busy() { return busy; },
    get epoch() { return epoch; },
    beginOp() {
      busy = true;
      return { epoch };
    },
    // Ritorna true se il token era dell'epoca corrente.
    endOp(token) {
      busy = false;
      return token?.epoch === epoch;
    },
    isCurrent(token) {
      return token?.epoch === epoch;
    },
    reset() {
      busy = false;
      epoch += 1;
    },
  };
}
