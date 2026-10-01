# Osservare una verifica Quick

Questa procedura legge soltanto diagnostica locale e usa fixture sintetiche.
Non invia comandi HID, non avvia una calibrazione e non scrive NVS. I risultati
dei test sono **model-verified**: non dimostrano la causa di un residuo estremo
né il comportamento di un controller fisico.

1. Per una sessione già presente, apri il pannello log e leggi il riepilogo
   locale restituito da `window.__senseCalibSessions()`. Non eseguire una nuova
   calibrazione per raccogliere questa prova. Mantieni gli eventuali dati reali
   fuori dal repository e dai suoi test.
2. Nel Quick confronta `passes` e `after` con `verification.attempts`, in ordine
   di `pass` e `attempt`. La diagnostica contiene al massimo due tentativi per
   passata, otto passate e sedici record. Una vecchia sessione può non averla.
3. Controlla `off` e `noise` per entrambi gli stick, `stableFraction`, `rawNoise`,
   `hold`, `accepted` e `criterion`. `rawNoise` è il massimo del rumore grezzo
   dei due stick; `noise` è il rumore della misura filtrata per stick. Il wrapper
   conserva `baselineNoise` e `baselineRawNoise` per interpretare il confronto.
4. `stable-fraction` indica che la frazione originale supera la soglia vigente;
   `baseline-noise` indica il criterio esistente di rumore relativo alla
   baseline; `legacy` conserva il comportamento di un sampler che non fornisce
   la frazione. `none` indica che la misura non soddisfa un criterio di stabilità
   o non è disponibile. Un valore `null` non è rumore zero e non distingue da
   solo un buco nei report dall'assenza di report.
5. `accepted` significa misura scelta per la verifica ordinaria, stabile e sotto
   il tetto Quick. Una lettura estrema resta `false` anche se stabile; se non
   arriva una verifica valida, il risultato conserva il blocco conservativo
   `catastrophic` e Write resta disabilitato. Una rimisura valida può sostituire
   la prima lettura estrema, come prima di questa diagnostica.
6. `hold` descrive soltanto l'attesa prima della rimisura: `not-required` al primo
   tentativo, poi `released` o `not-released`. Non prova che la mano sia stata
   fisicamente rilasciata e non introduce un nuovo criterio di accettazione.

Offset e rumore sono in punti percentuali, arrotondati a 0,01 e limitati a
0–200; la frazione è arrotondata a 0,001 e limitata a 0–1. La decisione usa sempre
i valori originali: un offset arrotondato a 15 può essere stato appena sotto
il tetto, e una frazione arrotondata a 0,4 può essere stata appena sotto soglia.

Per verificare le classi sintetiche e il numero invariato di comandi e attese:

```sh
~/.local/bin/codex-log -- node --test test/quick-diagnostics.test.js
```

Il test distingue estremi stabili e instabili, estremo seguito da misura valida
o mancante, criteri di accettazione e limiti, preflight e annullamento. Non usa
controller fisici, rete o attese di tempo reale.
