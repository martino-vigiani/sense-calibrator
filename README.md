# Sense Calibrator

Diagnostica e ricalibrazione hardware degli stick analogici del **DualSense (PS5)** affetti da stick drift, direttamente dal browser via WebHID. Nessuna installazione, nessun driver.

![piattaforma](https://img.shields.io/badge/browser-Chrome%20%7C%20Edge-black) ![controller](https://img.shields.io/badge/controller-DualSense-black)

## Cosa fa

- **Test drift automatico** alla connessione: misura l'offset di riposo degli stick e classifica il drift (centrato / lieve / marcato), con rilevazione del rumore di segnale (potenziometro usurato).
- **Calibrazione rapida**: ricentra gli stick in automatico in pochi secondi, senza toccare il controller.
- **Calibrazione guidata**: procedura in 4 passaggi (stick agli angoli) per drift più ostinati.
- **Calibrazione range**: ricalibra l'escursione massima ruotando gli stick, con indicatore di copertura in tempo reale.
- **Scrittura permanente**: la calibrazione è temporanea (si perde a controller spento) finché non la scrivi esplicitamente nella memoria NVS del controller. Una volta scritta vale ovunque: PS5, PC, Mac.
- Visualizzazione live degli stick, log dei comandi HID, riconnessione automatica.

## Come si usa

1. Avvia un server locale nella cartella del progetto (WebHID richiede un contesto sicuro, `file://` non funziona):

   ```sh
   python3 -m http.server 8000
   ```

2. Apri `http://localhost:8000` in **Chrome** o **Edge** (Safari e Firefox non supportano WebHID).
3. Collega il DualSense via **cavo USB** (il Bluetooth non è supportato per la calibrazione).
4. Premi **Collega il controller** e segui le indicazioni: il test drift parte da solo.
5. Se serve, calibra; quando sei soddisfatto, premi **Scrivi in memoria** per rendere il fix permanente.

## Note tecniche

- Protocollo di calibrazione (feature report `0x82`/`0x83`, gestione NVS via `0x80`/`0x81`) derivato da [dualshock-tools](https://github.com/dualshock-tools/dualshock-tools.github.io) (GPL-3.0), il tool open source di riferimento per la calibrazione dei controller Sony.
- La calibrazione applicata resta in RAM finché non viene scritta in NVS (ciclo unlock → lock): spegnere il controller prima della scrittura annulla tutto. È la rete di sicurezza del flusso.
- Solo DualSense standard (`054C:0CE6`). DualSense Edge e DualShock 4 non sono supportati.

## Avvertenze

Strumento non ufficiale, non affiliato a Sony. La scrittura in NVS usa comandi reverse-engineered ampiamente collaudati, ma resta a tuo rischio.
