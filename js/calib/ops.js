'use strict';

// Una operazione HID alla volta (calibrazioni, range, flash). È il vecchio flag
// `busy` di app.js, incapsulato con un'epoca: `reset()` (teardown, controller
// scollegato) apre un'epoca nuova, e ogni `beginOp()` restituisce un token con
// l'epoca in cui è partita.
//
// `endOp` con un token di un'epoca chiusa non tocca il flag: un ciclo di
// calibrazione orfano (controller scollegato a metà, `teardown` ha già fatto
// `reset()`) esce più tardi dal suo finally, e prima liberava il `busy` di
// un'operazione nuova partita nel frattempo sul controller ricollegato.
// Restituisce false per il token scaduto, così chi chiama può saperlo.
//
// Il flag va alzato PRIMA di qualunque await lungo, non dopo: la finestra tra
// il click e l'alzata basta ad avviare una seconda operazione.
//
// Il flag appartiene all'ULTIMO token emesso: anche nella stessa epoca, un
// token vecchio (un'operazione già chiusa che ripassa da un catch) non può
// liberare quello di un'operazione successiva.
export function createOpGate() {
  let busy = false;
  let epoch = 0;
  let owner = null;
  return {
    get busy() { return busy; },
    get epoch() { return epoch; },
    beginOp() {
      busy = true;
      owner = { epoch };
      return owner;
    },
    // Ritorna true se il token possedeva il flag (e l'ha liberato); un token
    // scaduto, già usato o assente non cambia nulla.
    endOp(token) {
      if (!token || token !== owner || token.epoch !== epoch) return false;
      busy = false;
      owner = null;
      return true;
    },
    isCurrent(token) {
      return token?.epoch === epoch;
    },
    reset() {
      busy = false;
      owner = null;
      epoch += 1;
    },
  };
}
