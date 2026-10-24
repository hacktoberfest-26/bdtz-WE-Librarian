// Google Meet (v3)
// Guardrail: la cattura parte solo se master switch + consenso globale + toggle Meet sono attivi in storage,
// e il banner resta SEMPRE visibile (attivo / in pausa) con i controlli Ferma / Riprendi.
//
// Novità v3
//  - Attiva di default all'ingresso nella riunione (se consentito in storage).
//  - "Ferma" = PAUSA: i timer si fermano ma lo stato (roster, turni, sessione) resta intatto.
//    "Riprendi" riparte senza duplicare ciò che era già a schermo e senza inviare ciò che è stato detto in pausa.
//    La chiusura vera della sessione (meeting_ended) avviene solo a fine riunione / chiusura pagina / disattivazione.
//  - Conteggio partecipanti riscritto: pannello Persone (se aperto) -> riquadri della griglia
//    (div[data-participant-id], div[data-self-name]) -> <video> visibili come ultimo ripiego.
//    Se il DOM non restituisce nulla, nel banner c'è un contatore manuale (− / +) con ritorno ad "Auto".
//
// Cattura sottotitoli (senza dipendere dai nomi di classe CSS, che Google cambia spesso):
//  1. trova la regione dei sottotitoli: [role="region"][aria-label ~ "Captions/Sottotitoli/..."]
//  2. individua i "turni di parola" ancorandosi agli avatar (<img>) e risalendo fino al blocco nome + testo
//  3. Meet riscrive i sottotitoli mentre si parla: un turno è "confermato" solo quando il testo è stabile
//     per STABLE_MS oppure quando il suo elemento sparisce dal DOM -> niente duplicati o testo a metà.
//  Debug: sessionStorage.setItem("hos-debug","1") nella console della pagina Meet, poi ricarica.

(() => {
  // accetta sia /abc-defg-hij sia /meet/abc-defg-hij
  const MEETING_RE = /^(?:\/meet)?\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/;
  const m = location.pathname.match(MEETING_RE);
  if (!m) return; // lobby/landing: nessuna azione
  const meetingCode = m[1];

  const T = Object.assign(
    { FLUSH_MS: 15000, POLL_MS: 1000, STABLE_MS: 2500, REGION_WARN_MS: 20000, PEOPLE_WARN_MS: 8000, DEMO_MS: 5000, ROSTER_MS: 3000 },
    globalThis.__HOS_TIMING || {}
  );
  const DEBUG = (() => { try { return sessionStorage.getItem("hos-debug") === "1"; } catch { return false; } })();
  const log = (...a) => DEBUG && console.debug("[H-OS Meet]", ...a);

  const REGION_LABEL = /aption|ottotitol|ubtitle|ubt[ií]tulo|sous-titre|untertitel|legenda/i;
  const INLINE = new Set(["SPAN", "A", "B", "I", "EM", "STRONG", "SMALL", "MARK", "U"]);
  const SKIP = new Set(["BUTTON", "SVG", "IMG", "STYLE", "SCRIPT", "NOSCRIPT", "SELECT", "OPTION", "INPUT"]);
  const UI_NOISE = /^(jump to bottom|vai in fondo|scorri verso il basso|captions?|sottotitoli|format_size|settings|impostazioni|language|lingua|arrow_downward)$/i;
  // ligature delle Material Icons che compaiono come testo nei riquadri (mic_off, more_vert, push_pin, ...)
  const ICON_TXT = /^(?:[a-z]+(?:_[a-z]+)+|mic|videocam|keep|devices|pinned|call_end|person|visibility)$/;
  const DEMO_LINES = [
    ["Marco", "Ok, per il Q4 dobbiamo chiudere la migrazione al nuovo CRM entro fine novembre."],
    ["Giulia", "Serve un owner per l'integrazione con il Company Brain: propongo Marco."],
    ["Marco", "Il cliente ha chiesto un report sui costi cloud, lo mandiamo venerdì."],
    ["Giulia", "Action item: preparo la demo per l'hackathon di H-FARM."]
  ];

  let settings = {};
  // idle (spento/non consentito) | active | paused
  let state = "idle";
  let sessionOpen = false; // true tra meeting_joined e meeting_ended
  let startedAt = new Date().toISOString();
  let warn = "", warnPeople = "";
  let pollTimer = null, flushTimer = null, rosterTimer = null, demoIdx = 0, demoRosterTicks = 0;
  let startedAtMs = 0, regionSeen = false, regionWarned = false;

  // ---------- Estrazione testo (indipendente da innerText, funziona anche in jsdom) ----------
  function linesOf(root) {
    const lines = [];
    let cur = "";
    const flushLine = () => { const t = cur.replace(/\s+/g, " ").trim(); if (t) lines.push(t); cur = ""; };
    (function walk(node) {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) { cur += n.nodeValue; continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName.toUpperCase();
        if (SKIP.has(tag) || n.getAttribute("role") === "button" || n.getAttribute("aria-hidden") === "true") continue;
        const inline = INLINE.has(tag);
        if (!inline) flushLine(); else cur += " ";
        walk(n);
        if (!inline) flushLine(); else cur += " ";
      }
    })(root);
    flushLine();
    return lines.filter((l) => !UI_NOISE.test(l));
  }

  function findRegion() {
    for (const el of document.querySelectorAll('[role="region"][aria-label]')) {
      if (REGION_LABEL.test(el.getAttribute("aria-label"))) return el;
    }
    return null;
  }

  function rowFor(img, region) {
    let el = img, best = null;
    while (el && el !== region) {
      if (el.querySelectorAll("img").length > 1) break; // conterrebbe più turni
      best = el;
      if (linesOf(el).length >= 2) return el;
      el = el.parentElement;
    }
    return best && linesOf(best).length ? best : null;
  }

  function toTurn(el) {
    const lines = linesOf(el);
    if (!lines.length) return null;
    if (lines.length >= 2 && lines[0].length <= 60) return { el, speaker: lines[0], text: lines.slice(1).join(" ") };
    return { el, speaker: "", text: lines.join(" ") };
  }

  function readTurns(region) {
    const rows = new Set();
    region.querySelectorAll("img").forEach((img) => { const r = rowFor(img, region); if (r) rows.add(r); });
    // elimina righe annidate dentro altre righe
    let list = [...rows].filter((r) => ![...rows].some((o) => o !== r && r.contains(o)));
    if (!list.length) {
      // ripiego senza avatar: figli diretti del contenitore ramificato più profondo
      let c = region;
      let kids = [...c.children].filter((k) => linesOf(k).length);
      while (kids.length === 1 && kids[0].children.length > 1) { c = kids[0]; kids = [...c.children].filter((k) => linesOf(k).length); }
      list = kids.length >= 2 ? kids : (linesOf(region).length ? [region] : []);
    }
    return list.map(toTurn).filter(Boolean);
  }

  // ---------- Motore di stabilizzazione ----------
  const turns = new Map();         // elemento -> stato del turno
  const lastBySpeaker = new Map(); // speaker -> ultimo testo confermato (per ri-render con nuovo nodo)
  let segments = [];

  function commit(t, now) {
    if (!t.text || t.text === t.committed) return;
    let delta;
    if (t.committed && t.text.startsWith(t.committed)) {
      delta = t.text.slice(t.committed.length).trim();
    } else {
      const last = lastBySpeaker.get(t.speaker);
      delta = (!t.committed && last && now - last.t < 20000 && t.text.startsWith(last.text))
        ? t.text.slice(last.text.length).trim() : t.text;
    }
    delta = delta.replace(/^[\s.,;:!?\-–]+/, ""); // niente punteggiatura orfana a inizio delta
    t.committed = t.text;
    lastBySpeaker.set(t.speaker, { text: t.text, t: now });
    if (delta) segments.push({ speaker: t.speaker, text: delta, at: new Date().toISOString() });
  }

  function tick(now = Date.now()) {
    const region = findRegion();
    if (!region) {
      if (!regionWarned && now - startedAtMs > T.REGION_WARN_MS) {
        regionWarned = true;
        warn = "Non vedo i sottotitoli: attivali in Meet (tasto C).";
        log("regione sottotitoli non trovata");
        render();
      }
      return;
    }
    if (!regionSeen) { regionSeen = true; if (warn) { warn = ""; render(); } log("regione trovata"); }

    const rows = readTurns(region);
    const present = new Set(rows.map((r) => r.el));
    for (const r of rows) {
      let t = turns.get(r.el);
      if (!t) { t = { speaker: r.speaker, text: "", committed: "", changedAt: now }; turns.set(r.el, t); }
      if (t.text !== r.text || t.speaker !== r.speaker) { t.text = r.text; t.speaker = r.speaker; t.changedAt = now; }
      if (now - t.changedAt >= T.STABLE_MS) commit(t, now);
    }
    for (const [el, t] of turns) if (!present.has(el)) { commit(t, now); turns.delete(el); }
  }

  function commitAll() { const now = Date.now(); for (const t of turns.values()) commit(t, now); }

  // Dopo una pausa: ciò che è già a schermo viene considerato "già visto" (non reinviato),
  // e ciò che è stato detto durante la pausa non viene mai raccolto.
  function baselineCaptions() {
    turns.clear(); lastBySpeaker.clear();
    const region = findRegion();
    if (!region) return;
    const now = Date.now();
    for (const r of readTurns(region)) turns.set(r.el, { speaker: r.speaker, text: r.text, committed: r.text, changedAt: now });
  }

  function demoTick() {
    const [speaker, text] = DEMO_LINES[demoIdx++ % DEMO_LINES.length];
    segments.push({ speaker, text, at: new Date().toISOString() });
  }

  // ---------- Partecipanti ----------
  // Strategia a cascata (le email NON sono nel DOM di Meet: si raccolgono solo i nomi visualizzati):
  //  1) pannello "Persone" aperto (role=list + aria-label): elenco completo e autorevole
  //  2) riquadri della griglia: [data-participant-id] / [data-self-name] (solo chi è visibile in griglia)
  //  3) ripiego generico: <video> visibili (nomi "Partecipante N" se non si riesce a leggere il nome)
  //  4) inserimento manuale dal banner (− / +), sempre disponibile e prioritario sul valore automatico
  // "Uscito" viene dichiarato solo con il pannello Persone aperto (la griglia mostra un sottoinsieme).
  const PEOPLE_LABEL = /participant|partecipant|people|persone|personas|personnes|teilnehmer/i;
  const SELF_SUFFIX = /\s*\((you|tu|io|vous|du)\)\s*$/i;
  const SELF_RE = /^(you|tu|io|vous|du)$/i;
  const roster = new Map();
  let rosterPending = [], rosterReady = false, rosterSentInitial = false, peopleWarned = false;
  let domCount = 0, domVia = "none", lastSentCount = null, lastSig = "";
  let manualCount = null; // null = automatico

  const manualKey = `hos-meet-manual-${meetingCode}`;
  const loadManual = () => { try { const v = sessionStorage.getItem(manualKey); return v === null ? null : Math.max(0, parseInt(v, 10) || 0); } catch { return null; } };
  const saveManual = () => { try { manualCount === null ? sessionStorage.removeItem(manualKey) : sessionStorage.setItem(manualKey, String(manualCount)); } catch {} };

  const displayCount = () => (manualCount !== null ? manualCount : domCount);
  const countSource = () => (manualCount !== null ? "manual" : domVia);

  function addPerson(map, raw, fromPanel) {
    let name = (raw || "").replace(/\s+/g, " ").trim();
    const isSelf = SELF_SUFFIX.test(name) || SELF_RE.test(name);
    name = name.replace(SELF_SUFFIX, "").trim();
    if (!name || name.length > 80 || UI_NOISE.test(name) || ICON_TXT.test(name)) return;
    const k = name.toLowerCase(), prev = map.get(k);
    map.set(k, { name, is_self: isSelf || !!prev?.is_self, panel: fromPanel || !!prev?.panel });
  }

  function inExcluded(el) {
    const reg = el.closest('[role="region"][aria-label]');
    if (reg && REGION_LABEL.test(reg.getAttribute("aria-label"))) return true; // sottotitoli
    const list = el.closest('[role="list"][aria-label]');
    return !!(list && PEOPLE_LABEL.test(list.getAttribute("aria-label"))); // pannello Persone
  }

  function isVisible(el) {
    if (!el.isConnected || el.closest("[hidden]")) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && !/jsdom/i.test(navigator.userAgent)) return false;
    return true;
  }

  function tileId(el) {
    return el.getAttribute("data-participant-id") || el.closest("[data-participant-id]")?.getAttribute("data-participant-id") || "";
  }

  function tileName(el) {
    const scope = el.closest("[data-participant-id]") || el;
    for (const root of [el, scope]) {
      for (const l of linesOf(root)) {
        if (l.length <= 60 && !ICON_TXT.test(l) && !UI_NOISE.test(l)) return l;
      }
    }
    const attr = (el.getAttribute("data-self-name") || el.querySelector("[data-self-name]")?.getAttribute("data-self-name") || "").trim();
    return attr;
  }

  function readPanel() {
    const map = new Map();
    let found = false;
    document.querySelectorAll('[role="list"][aria-label]').forEach((list) => {
      if (!PEOPLE_LABEL.test(list.getAttribute("aria-label"))) return;
      found = true;
      list.querySelectorAll('[role="listitem"]').forEach((li) => addPerson(map, linesOf(li)[0], true));
    });
    return { people: [...map.values()], found };
  }

  function readTiles() {
    const cand = [...new Set(document.querySelectorAll("[data-participant-id], [data-self-name]"))]
      .filter((e) => !inExcluded(e) && isVisible(e));
    // solo riquadri "foglia": scarta i contenitori che ne racchiudono altri
    let tiles = cand.filter((e) => !cand.some((o) => o !== e && e.contains(o)));
    let via = "grid";
    if (!tiles.length) {
      // ripiego generico: <video> visibili di dimensione ragionevole
      tiles = [...document.querySelectorAll("video")].filter((v) => {
        if (inExcluded(v) || !isVisible(v)) return false;
        const r = v.getBoundingClientRect();
        return (r.width >= 40 && r.height >= 30) || /jsdom/i.test(navigator.userAgent);
      });
      via = "video";
    }
    const seenIds = new Set(), used = new Set(), out = [];
    let anon = 0;
    for (const el of tiles) {
      const id = tileId(el);
      if (id) { if (seenIds.has(id)) continue; seenIds.add(id); }
      let raw = tileName(el);
      let isSelf = SELF_SUFFIX.test(raw) || SELF_RE.test(raw);
      let name = raw.replace(SELF_SUFFIX, "").trim();
      if (!name || name.length > 80 || ICON_TXT.test(name) || UI_NOISE.test(name)) { name = `Partecipante ${++anon}`; }
      // nomi duplicati (due omonimi): disambigua, così il conteggio non li fonde
      let uniq = name, n = 2;
      while (used.has(uniq.toLowerCase())) uniq = `${name} (${n++})`;
      used.add(uniq.toLowerCase());
      out.push({ name: uniq, is_self: isSelf, panel: false });
    }
    return { people: out, via };
  }

  function readParticipants() {
    const panel = readPanel();
    if (panel.found && panel.people.length) return { people: panel.people, panelOpen: true, via: "panel" };
    const { people, via } = readTiles();
    if (DEBUG) log("partecipanti", { via, names: people.map((p) => p.name), panelFound: panel.found });
    return { people, panelOpen: panel.found, via: people.length ? via : "none" };
  }

  function demoPeople() {
    demoRosterTicks++;
    const people = [{ name: "Marco Bianchi", is_self: true }, { name: "Giulia Verdi" }];
    if (demoRosterTicks >= 3) people.push({ name: "Paolo Neri" }); // simula un ingresso
    return { people, panelOpen: true, via: "panel" };
  }

  const snapshot = () => [...roster.values()].map(({ miss, ...r }) => r);

  function flushRoster(force = false) {
    if (!roster.size && manualCount === null && !force) return;
    const countChanged = lastSentCount !== displayCount();
    if (!force && !rosterPending.length && rosterSentInitial && !countChanged) return;
    send("participants_update", {
      simulated: !!settings.simulateMeet,
      participants: snapshot(),
      changes: rosterPending,
      participant_count: displayCount(),
      count_source: countSource()
    });
    rosterPending = []; rosterSentInitial = true; lastSentCount = displayCount();
  }

  function updateRoster() {
    const { people, panelOpen, via } = settings.simulateMeet ? demoPeople() : readParticipants();
    const at = new Date().toISOString();
    const seen = new Set();
    domCount = people.length; domVia = via;
    for (const p of people) {
      const k = p.name.toLowerCase(); seen.add(k);
      let r = roster.get(k);
      if (!r) {
        r = { name: p.name, is_self: !!p.is_self, joined_at: at, left_at: null, observed_at_start: !rosterReady, miss: 0 };
        roster.set(k, r);
        if (rosterReady) rosterPending.push({ type: "joined", name: r.name, at });
      } else {
        r.miss = 0; r.is_self = r.is_self || !!p.is_self;
        if (r.left_at) { r.left_at = null; rosterPending.push({ type: "rejoined", name: r.name, at }); }
      }
    }
    if (panelOpen && via === "panel") {
      for (const [k, r] of roster) {
        if (!seen.has(k) && !r.left_at && ++r.miss >= 2) { r.left_at = at; rosterPending.push({ type: "left", name: r.name, at }); }
      }
    }
    if (people.length) rosterReady = true;
    if (!people.length && manualCount === null && !peopleWarned && Date.now() - startedAtMs > T.PEOPLE_WARN_MS) {
      peopleWarned = true;
      warnPeople = "Non rilevo i partecipanti: imposta il numero con − / + oppure apri il pannello Persone.";
    }
    if ((people.length || manualCount !== null) && warnPeople) warnPeople = "";
    flushRoster();
    const sig = `${displayCount()}|${countSource()}|${warnPeople}`;
    if (sig !== lastSig) render();
  }

  function setManual(v) {
    manualCount = v === null ? null : Math.max(0, v);
    saveManual();
    warnPeople = "";
    flushRoster(true);
    render();
  }

  // ---------- Impostazioni ----------
  const load = async () => {
    const { settings: s } = await chrome.storage.local.get("settings");
    settings = s || {};
    return settings;
  };
  const isAllowed = () => settings.enabled && settings.consentGiven && settings.toggles?.meet !== false;

  chrome.storage.onChanged.addListener(async (c, area) => {
    if (area === "local" && c.settings) {
      await load();
      if (!isAllowed() && state !== "idle") shutdown();   // master switch / toggle spento: chiusura vera
      else if (isAllowed() && state === "idle") init();   // riacceso: riparte (o resta in pausa se l'utente aveva fermato)
    }
  });

  // ---------- Banner (Shadow DOM) ----------
  let host, root;
  function ensureBanner() {
    if (host) return;
    host = document.createElement("div");
    host.style.cssText = "position:fixed;left:16px;bottom:96px;z-index:2147483647;";
    root = host.attachShadow({ mode: "closed" });
    document.documentElement.appendChild(host);
  }

  function peopleRow() {
    const src = countSource();
    const label = src === "manual" ? "manuale" : src === "none" ? "non rilevati" : "auto";
    return `<p class="pr">Partecipanti: <span class="n">${displayCount()}</span> <span class="t">(${label})</span>
      <button class="m" id="dec" title="Meno">−</button><button class="m" id="inc" title="Più">+</button>
      ${manualCount !== null ? '<button class="m a" id="auto" title="Torna al conteggio automatico">Auto</button>' : ""}</p>`;
  }

  function render() {
    ensureBanner();
    lastSig = `${displayCount()}|${countSource()}|${warnPeople}`;
    const css = `
      .b{font:13px/1.4 system-ui,sans-serif;background:#14213D;color:#F5F7FA;border-radius:10px;
         padding:12px 14px;width:290px;box-shadow:0 6px 24px rgba(0,0,0,.35);border-left:4px solid #E9A23B}
      .b.on{border-left-color:#0E8A7D}
      b{display:block;margin-bottom:4px}
      p{margin:0 0 10px;color:#C9D1E0}
      .w{color:#F3C77A}
      .n{font-weight:700;color:#F5F7FA}.t{font-size:11px;opacity:.75}
      .pr{display:flex;align-items:center;flex-wrap:wrap;gap:4px}
      button{font:inherit;border:0;border-radius:6px;padding:6px 10px;margin-right:6px;cursor:pointer}
      .m{padding:1px 8px;margin:0;background:#33415f;color:#F5F7FA;line-height:1.4}.m.a{font-size:11px}
      .p{background:#0E8A7D;color:#fff}.s{background:#33415f;color:#F5F7FA}
      .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#37d6c3;margin-right:6px}
      .dot.off{background:#E9A23B}
    `;
    let html = "";
    if (state === "active") {
      const src = settings.simulateMeet ? "trascrizione simulata (demo)" : "sottotitoli di Meet";
      html = `<div class="b on"><b><span class="dot"></span>Trasmissione attiva</b>
        <p>Invio ${src} e partecipanti al Company Brain.</p>
        ${peopleRow()}
        ${warn ? `<p class="w">${warn}</p>` : ""}${warnPeople ? `<p class="w">${warnPeople}</p>` : ""}
        <button class="s" id="stop">Ferma</button></div>`;
    } else if (state === "paused") {
      html = `<div class="b"><b><span class="dot off"></span>Registrazione in pausa</b>
        <p>Nulla viene raccolto né inviato finché non riprendi.</p>
        <button class="p" id="resume">Riprendi</button></div>`;
    }
    root.innerHTML = `<style>${css}</style>${html}`;
    root.getElementById("stop")?.addEventListener("click", pause);
    root.getElementById("resume")?.addEventListener("click", resume);
    root.getElementById("dec")?.addEventListener("click", () => setManual((manualCount ?? domCount) - 1));
    root.getElementById("inc")?.addEventListener("click", () => setManual((manualCount ?? domCount) + 1));
    root.getElementById("auto")?.addEventListener("click", () => setManual(null));
  }

  // Stato per-riunione (sopravvive al reload della scheda): "paused" se l'utente ha premuto Ferma.
  const key = `hos-meet-${meetingCode}`;
  const remember = (v) => { try { sessionStorage.setItem(key, v); } catch {} };
  const recall = () => { try { return sessionStorage.getItem(key); } catch { return null; } };

  // ---------- Invio ----------
  function send(event, extra = {}) {
    chrome.runtime.sendMessage({
      type: "INGEST", source: "meet",
      data: {
        event, meeting_code: meetingCode,
        meeting_title: document.title.replace(/^Meet\s*[-–]\s*/, ""),
        url: location.origin + location.pathname, ...extra
      }
    }).catch(() => {});
  }

  function mergeSpeakers(segs) {
    const out = [];
    for (const s of segs) {
      const last = out[out.length - 1];
      if (last && last.speaker === s.speaker) last.text += " " + s.text;
      else out.push({ speaker: s.speaker, text: s.text, at: s.at });
    }
    return out;
  }

  function flush(final = false) {
    if (!settings.simulateMeet) commitAll();
    if (!segments.length && !final) return;
    const segs = mergeSpeakers(segments);
    segments = [];
    send(final ? "meeting_ended" : "transcript_chunk", {
      started_at: startedAt, simulated: !!settings.simulateMeet, captions_detected: regionSeen,
      segments: segs,
      ...(final ? { participants: snapshot(), participant_count: displayCount(), count_source: countSource() } : {}),
      transcript: segs.map((s) => (s.speaker ? `${s.speaker}: ` : "") + s.text).join("\n")
    });
  }

  // ---------- Ciclo di vita ----------
  function clearTimers() {
    clearInterval(pollTimer); clearInterval(flushTimer); clearInterval(rosterTimer);
    pollTimer = flushTimer = rosterTimer = null;
  }

  function resetSession() {
    turns.clear(); lastBySpeaker.clear(); segments = [];
    roster.clear(); rosterPending = []; rosterReady = false; rosterSentInitial = false;
    lastSentCount = null; demoIdx = 0; demoRosterTicks = 0; regionSeen = false;
  }

  function startTimers() {
    pollTimer = setInterval(settings.simulateMeet ? demoTick : () => tick(), settings.simulateMeet ? T.DEMO_MS : T.POLL_MS);
    flushTimer = setInterval(() => flush(false), T.FLUSH_MS);
    updateRoster();
    rosterTimer = setInterval(updateRoster, T.ROSTER_MS);
  }

  // Avvio (o primo avvio di una nuova sessione) — di default all'ingresso in riunione.
  function start() {
    if (state === "active") return;
    state = "active"; startedAtMs = Date.now(); warn = ""; warnPeople = ""; regionWarned = false; peopleWarned = false;
    manualCount = loadManual();
    if (!sessionOpen) {
      resetSession();
      sessionOpen = true; startedAt = new Date().toISOString();
      send("meeting_joined", { started_at: startedAt });
    }
    remember("active");
    render();
    startTimers();
  }

  // "Ferma" = pausa: invia quanto già confermato, poi sospende i timer SENZA toccare roster/turni/sessione.
  function pause() {
    if (state !== "active") return;
    clearTimers();
    if (!settings.simulateMeet) commitAll();
    flush(false);
    state = "paused"; remember("paused"); render();
  }

  // "Riprendi": riparte dalla stessa sessione; ciò che è già a schermo non viene reinviato.
  function resume() {
    if (state !== "paused") return;
    if (!sessionOpen) return start(); // la sessione era stata chiusa (es. reload): ne apre una nuova
    state = "active"; startedAtMs = Date.now(); regionWarned = false; peopleWarned = false; warn = ""; warnPeople = "";
    if (!settings.simulateMeet) baselineCaptions();
    remember("active");
    render();
    startTimers();
  }

  // Chiusura vera: fine riunione, chiusura pagina o disattivazione da impostazioni.
  function shutdown() {
    clearTimers();
    if (sessionOpen) { flush(true); sessionOpen = false; }
    state = "idle"; render();
  }

  async function init() {
    await load();
    if (!isAllowed()) { state = "idle"; render(); return; }
    manualCount = loadManual();
    if (recall() === "paused") { state = "paused"; render(); }
    else start(); // attiva di default
  }

  window.addEventListener("pagehide", () => {
    if (state === "active" || state === "paused") { clearTimers(); if (sessionOpen) { flush(true); sessionOpen = false; } }
  });
  init();
})();