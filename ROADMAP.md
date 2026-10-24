# 🗺️ Roadmap H-OS Librarian Extension

Stato dello sviluppo, problemi aperti e prossimi passi per la sfida **H-OS (The AI Operating System)** — Hacktoberfest 2026 @ H-FARM.
*Ultimo aggiornamento: 24 ottobre 2026*

**Legenda**: ✅ fatto e verificato · 🧪 implementato, testato solo in simulazione (da provare dal vivo) · ⬜ da fare · ⚠️ limite noto

---

## 🟢 1. Stato Attuale

### Architettura & Core (Manifest V3)
- ✅ **Manifest V3**: permessi (`downloads`, `storage`, `activeTab`, `scripting`, `tabs`, `alarms`), match pattern per Meet e motori di ricerca.
- ✅ **Service Worker (`background.js`)**: unico punto di uscita `ingest()` con controllo di master switch, consenso e toggle per sorgente; badge `ON` / `↑`; coda offline con retry ogni minuto; la coda si svuota quando l'utente spegne il Librarian.
- ✅ **Navigazione & Ricerca** (confermato dal vivo: i siti visitati vengono registrati):
  - query, primi risultati e ricerche correlate su Google / Bing / DuckDuckGo, keyword pesate;
  - navigazione solo come host + path + titolo, senza query string; esclusi banche, mail, login e pagine sensibili (filtro su host **e** path); deduplica 30 min.
- ✅ **Popup (`popup.html` / `popup.js`)**: master ON/OFF con consenso informato, toggle per fonte, ruolo aziendale, log degli ultimi invii, verifica backend, revoca consenso + cancellazione dati locali. Il toggle "Demo Meet" è ora etichettato "(dati finti)".
- ✅ **Backend (`server/main.py`)**: FastAPI con `/api/ingest`, `/health`, `/api/memory`; salvataggio in `memory.jsonl`; i dati simulati sono marcati `[SIMULATO]`; `agent_hint` basato su regole fisse.
- ✅ **Banner di consenso su Meet** (confermato dal vivo): consenso richiesto per ogni riunione, banner sempre visibile durante la cattura, pulsante "Ferma".

### Corretti dall'ultimo giro di test
- ✅ **Bug download**: la sorgente `download` non corrispondeva al toggle `downloads`, quindi nessun download veniva mai inviato. Corretto con una mappa sorgente → toggle.
- ✅ **Bug filtro navigazione**: controllava solo l'host (`acme.com/login` passava). Ora controlla anche il path.
- ✅ **URL Meet con prefisso `/meet/`** (es. `meet.google.com/meet/abc-defg-hij`): prima lo script non si attivava.
- ✅ **Test automatici** in `tests/`: 13/13 end-to-end (`background.js` reale ↔ FastAPI reale: gating, privacy dei payload, coda offline) e 21/21 sul DOM Meet simulato.

---

## 🟡 2. In Corso & Da Verificare dal Vivo

- 🧪 **Tracciamento download**: logica corretta e testata (nessun percorso locale né token nei payload, deduplica, esclusione incognito). **Da fare**: scaricare un file vero con l'estensione attiva e controllare `/api/memory`.
- 🧪 **Sottotitoli Google Meet (`meet_script.js` v2)**: riscritta la cattura per turni (Meet riscrive i sottotitoli e li rimuove dopo il silenzio: ora un turno viene registrato solo quando è stabile o sparisce). Non dipende dai nomi di classe CSS.
  - ⬜ Prova su una **riunione reale con sottotitoli attivi (tasto C)**.
  - ⬜ Se non cattura: `sessionStorage.setItem("hos-debug","1")`, ricarica, e analizza le righe `[H-OS Meet]` per correggere `findRegion()` / `rowFor()`.
  - ⚠️ Il DOM di Meet non è un'API pubblica: i selettori possono cambiare senza preavviso.
- 🧪 **Cattura partecipanti** (nuova): nomi dai riquadri video (`div[data-self-name]`) e dal pannello "Persone"; eventi `participants_update` con `joined` / `left` / `rejoined`; contatore nel banner.
  - ⬜ Prova dal vivo con almeno un'altra persona nella riunione, con e senza pannello Persone aperto.
  - ⚠️ Senza pannello aperto si vedono solo i riquadri visibili; le **uscite** sono dichiarate solo a pannello aperto.
- ✅/⬜ **Test end-to-end**: automatizzato in simulazione; la parte dal vivo è confermata per navigazione e consenso Meet, mancano download, sottotitoli e partecipanti.

---

## 🔵 3. Funzionalità da Implementare

### A. Aziende dei partecipanti (da ripensare)
- ⚠️ **Le email non sono presenti nel DOM di Meet**: nel pannello Persone compaiono solo i nomi visualizzati. L'obiettivo "email → dominio → azienda" non è raggiungibile con il solo scraping, e il codice **non inventa** campi `email` / `company` (c'è un test che lo verifica).
- Opzioni per ottenerle (da scegliere):
  - ⬜ **Google Calendar API / Meet REST API** con login OAuth: gli invitati dell'evento hanno l'email. Richiede un client OAuth e il permesso dell'utente.
  - ⬜ **Inserimento manuale** nel popup (dominio dell'azienda incontrata) come ripiego per la demo.
  - ⬜ Una volta ottenute le email: parsing del dominio, distinzione domini generici (`gmail.com`, `yahoo.com`…) da domini aziendali, payload `participants[].{name, email, company}`.

### B. Agente proattivo (backend)
- ⚠️ **Oggi non c'è nessuna AI**: `agent_hint` è un insieme di `if` con frasi fisse; le keyword delle ricerche sono un conteggio di parole. Va detto chiaramente nella demo.
- ⬜ **Agente vero**: collegare un LLM nel backend per generare riepilogo della riunione, action item e suggerimenti partendo da `memory.jsonl` (chiave API in `.env`, mai nel repo).
- ✅ Hint su nuovo partecipante già presente nel server (basato sul nome, non sull'azienda).
- ⬜ Hint su "nuova azienda" (es. *"Incontrato contatto da tech.it: creo una scheda Lead?"*): dipende dal punto A.
- ⬜ **Trascrizione audio (stretch goal)**: `chrome.tabCapture` + offscreen document + speech-to-text, per quando i sottotitoli di Meet non sono attivi.

### C. Pulizia tecnica
- ⬜ Rimuovere i permessi non usati (`activeTab`, `scripting`) o motivarli.
- ⬜ Endpoint backend configurabile dal popup (oggi fisso su `localhost:8000`, anche in `host_permissions`).
- ⬜ Icone dell'estensione (oggi usa quella di default di Chrome).
- ⚠️ Selettori delle ricerche correlate (Google/Bing/DDG) fragili; autenticazione e HTTPS verso il backend assenti (accettabile per mock locale).

---

## 🔴 4. Preparazione della Demo (Ultimo Miglio)

- ⬜ **Script della demo live (senza slide)**:
  1. Mostrare il toggle e il consenso informato nel popup.
  2. Aprire Google Meet con almeno un altro partecipante: banner di consenso → "Consenti"; mostrare il contatore partecipanti e i sottotitoli catturati.
  3. Scaricare un CSV/PDF e fare una ricerca: l'evento compare nel log del popup.
  4. Mostrare il terminale FastAPI e `/api/memory` che si aggiornano in tempo reale.
  5. Evidenziare la risposta proattiva dell'agente (`agent_hint`, o l'LLM se implementato).
  - ℹ️ Adattamento rispetto alla bozza: il riconoscimento aziendale da email **non è disponibile** finché non si sceglie un'opzione del punto A; dichiarare i nomi, non le aziende.
  - 🛟 **Piano B**: se Meet non collabora in diretta, attivare "Demo Meet" (dati finti, dichiarati come tali) per mostrare il flusso completo.
- ⬜ **Repository**:
  - setup repo con `.gitignore` (`node_modules/`, `.venv/`, `server/memory.jsonl` — contiene dati reali delle riunioni, non va mai su Git), `.env.example`;
  - branch per modulo (`feat/meet-participants`, `feat/brain-agent`, …).
- ⬜ **Documentazione**: `ARCHITECTURE.md` con diagramma di flusso e schema del payload; `README.md` con "Avvio rapido" in 5 comandi (backend, caricamento estensione, test).
- ⬜ **Licenza Open Source** (MIT / Apache-2.0).

---

## 🧭 Prossimi 3 passi consigliati
1. **Prova dal vivo su Meet** (sottotitoli + partecipanti + un download) e, se serve, mandare i log `[H-OS Meet]` per sistemare i selettori.
2. **Decidere come ottenere le aziende** (Calendar API vs inserimento manuale).
3. **Collegare un LLM** al backend per avere un agente vero da mostrare, invece delle regole fisse.
