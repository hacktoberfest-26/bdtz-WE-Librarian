# WE-Librarian
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> Sviluppato per la sfida di H-FARM hacktoberfest 2026.

---

## 🚀 Che cos'è H-OS Librarian?
**H-OS Librarian** è un'estensione Chrome in Manifest V3 accompagnata da un backend FastAPI che funge da "bibliotecario personale" per il tuo sistema operativo aziendale. 

Mentre navighi, l'estensione raccoglie in modo silenzioso e trasparente il contesto di cui hai bisogno (ricerche web, file scaricati, trascrizioni di riunioni su Google Meet e navigazione di lavoro) e lo invia a un backend centrale ("The Brain"), dove un agente basato su LLM analizza i dati per generare **suggerimenti proattivi** e insight aziendali in tempo reale.

---

## 🛡️ Privacy First & Guardrail
La privacy non è un'aggiunta, è il cuore dell'architettura:
* **Consenso Esplicito:** Banner interattivo su Google Meet per autorizzare la registrazione di ogni singola riunione.
* **Master Switch & Toggle granulari:** L'utente può accendere/spegnere o revocare totalmente i permessi e cancellare i dati locali in un click.
* **Nessun tracciamento invasivo:** Gli URL vengono puliti (mantenendo solo origin e path, senza query string o token) e non vengono tracciati siti sensibili (banche, mail, login).

---

## 🏗️ Architettura del Sistema
Il sistema adotta una struttura disaccoppiata basata su un bus di stato locale (`chrome.storage.local`):

```text
[Browser Pages] ──(Content Scripts)──▶ [Service Worker (Background)] ──(POST /api/ingest)──▶ [FastAPI Backend] 
       │                                         │                                                      │
       └── chrome.downloads / chrome.tabs ───────┘                                                      ▼
                                                                                               [LLM Company Brain]
                                                                                               (memory.jsonl + Agent Hints)