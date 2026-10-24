// H-OS Librarian — Service Worker (MV3)
// Raccoglie eventi dai content script + chrome.downloads + navigazione,
// li invia al Company Brain. Nulla parte se: master OFF, consenso mancante, sorgente OFF.

const ENDPOINT = "http://localhost:8000/api/ingest";
const SCHEMA_VERSION = "1.0";
const MAX_QUEUE = 100;
const MAX_LOG = 30;

const DEFAULTS = {
  enabled: false,          // master switch
  consentGiven: false,     // consenso informato (dato dal popup)
  role: "developer",
  clientId: null,
  toggles: { meet: true, search: true, downloads: true, navigation: false },
  simulateMeet: false      // demo: trascrizione simulata
};

// ---------- Settings ----------
async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const s = { ...DEFAULTS, ...settings, toggles: { ...DEFAULTS.toggles, ...(settings.toggles || {}) } };
  if (!s.clientId) {
    s.clientId = crypto.randomUUID(); // ID anonimo, nessun dato personale
    await chrome.storage.local.set({ settings: s });
  }
  return s;
}

async function updateBadge() {
  const { enabled, consentGiven } = await getSettings();
  const on = enabled && consentGiven;
  chrome.action.setBadgeText({ text: on ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#0E8A7D" });
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.settings) return;
  updateBadge();
  const s = changes.settings.newValue || {};
  // Se l'utente spegne il Librarian: scarta tutto ciò che era in coda.
  if (!s.enabled || !s.consentGiven) await chrome.storage.local.set({ queue: [] });
});

chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
  chrome.alarms.create("flush", { periodInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
  chrome.alarms.create("flush", { periodInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener((a) => a.name === "flush" && flushQueue());

// ---------- Utility ----------
function sanitizeUrl(raw) {
  try {
    const u = new URL(raw);
    return u.origin + u.pathname; // niente query/hash (token, sessioni, ecc.)
  } catch { return null; }
}

function basename(p = "") { return p.split(/[\\/]/).pop(); }

function categorize(ext, mime = "") {
  const e = (ext || "").toLowerCase();
  const map = {
    document: ["pdf", "doc", "docx", "txt", "md", "rtf", "odt"],
    spreadsheet: ["xls", "xlsx", "csv", "ods"],
    presentation: ["ppt", "pptx", "key", "odp"],
    code: ["py", "js", "ts", "json", "html", "css", "java", "go", "rs", "ipynb"],
    image: ["png", "jpg", "jpeg", "gif", "svg", "webp"],
    archive: ["zip", "rar", "7z", "tar", "gz"]
  };
  for (const [cat, list] of Object.entries(map)) if (list.includes(e)) return cat;
  if (mime.startsWith("image/")) return "image";
  return "other";
}

function summarize(source, data) {
  switch (source) {
    case "meet": return `Meet ${data.meeting_code || ""} · ${data.event}`;
    case "search": return `Ricerca: "${data.query}"`;
    case "download": return `Download: ${data.filename}`;
    case "navigation": return `Pagina: ${data.host}${data.path}`;
    default: return source;
  }
}

async function logActivity(payload, status, error = null) {
  const { activity = [] } = await chrome.storage.local.get("activity");
  activity.unshift({
    t: Date.now(), source: payload.source, status,
    summary: summarize(payload.source, payload.data), error
  });
  await chrome.storage.local.set({ activity: activity.slice(0, MAX_LOG) });
}

async function bumpStats(ok) {
  const { stats = { sent: 0, failed: 0, lastSent: null } } = await chrome.storage.local.get("stats");
  if (ok) { stats.sent++; stats.lastSent = Date.now(); } else { stats.failed++; }
  await chrome.storage.local.set({ stats });
}

// ---------- Invio verso il Brain ----------
async function postPayload(payload) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json().catch(() => ({}));
}

async function enqueue(payload) {
  const { queue = [] } = await chrome.storage.local.get("queue");
  queue.push(payload);
  await chrome.storage.local.set({ queue: queue.slice(-MAX_QUEUE) });
}

async function flushQueue() {
  const s = await getSettings();
  if (!s.enabled || !s.consentGiven) return;
  const { queue = [] } = await chrome.storage.local.get("queue");
  if (!queue.length) return;
  const remaining = [];
  for (const p of queue) {
    try { await postPayload(p); await bumpStats(true); await logActivity(p, "sent"); }
    catch { remaining.push(p); }
  }
  await chrome.storage.local.set({ queue: remaining });
}

// la sorgente "download" corrisponde al toggle "downloads" del popup
const TOGGLE_KEY = { meet: "meet", search: "search", download: "downloads", navigation: "navigation" };

async function ingest(source, data) {
  const s = await getSettings();
  if (!s.enabled || !s.consentGiven) return { ok: false, reason: "disabled" };
  if (!s.toggles[TOGGLE_KEY[source]]) return { ok: false, reason: "source_off" };

  const payload = {
    schema_version: SCHEMA_VERSION,
    event_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    source,
    user: { client_id: s.clientId, role: s.role },
    consent: { granted: true, active_sources: Object.keys(s.toggles).filter((k) => s.toggles[k]) },
    data
  };

  chrome.action.setBadgeText({ text: "↑" }); // feedback visivo: sto trasmettendo
  try {
    const ack = await postPayload(payload);
    await bumpStats(true);
    await logActivity(payload, "sent");
    return { ok: true, ack };
  } catch (e) {
    await enqueue(payload);
    await bumpStats(false);
    await logActivity(payload, "queued", e.message);
    return { ok: false, reason: "backend_unreachable" };
  } finally {
    setTimeout(updateBadge, 800);
  }
}

// ---------- Messaggi dai content script ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "INGEST") {
    ingest(msg.source, msg.data).then(sendResponse);
    return true; // risposta asincrona
  }
});

// ---------- Download completati ----------
const seenDownloads = new Set(); // evita doppi invii se onChanged scatta più volte per lo stesso id

chrome.downloads.onChanged.addListener(async (delta) => {
  if (delta.state?.current !== "complete" || seenDownloads.has(delta.id)) return;
  seenDownloads.add(delta.id);
  if (seenDownloads.size > 500) seenDownloads.delete(seenDownloads.values().next().value);

  const [item] = await chrome.downloads.search({ id: delta.id });
  if (!item || item.incognito) return;
  const filename = basename(item.filename); // solo il nome file, mai il percorso locale
  if (!filename) return;
  const ext = filename.includes(".") ? filename.split(".").pop() : "";
  ingest("download", {
    filename,
    extension: ext,
    category: categorize(ext, item.mime),
    mime: item.mime || null,
    file_size_bytes: item.fileSize > 0 ? item.fileSize : null,
    source_url: sanitizeUrl(item.finalUrl || item.url),
    referrer: sanitizeUrl(item.referrer),
    completed_at: item.endTime || new Date().toISOString()
  });
});

// ---------- Navigazione (opt-in, solo host + path + titolo) ----------
const BLOCKED_HOSTS = /(^|\.)(accounts\.google\.com|mail\.google\.com|paypal\.com|localhost|127\.0\.0\.1)$|bank|banca|login|signin|auth/i;
const BLOCKED_PATHS = /(login|signin|sign-in|logout|auth|oauth|account|checkout|payment|billing|password|admin)/i;
const SKIP_HOSTS = /^(meet\.google\.com|www\.google\.com|www\.bing\.com|duckduckgo\.com)$/; // già coperti da script dedicati
const recentNav = new Map();

chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.status !== "complete" || !tab.url || tab.incognito) return;
  let u;
  try { u = new URL(tab.url); } catch { return; }
  if (!/^https?:$/.test(u.protocol)) return;
  if (BLOCKED_HOSTS.test(u.hostname) || SKIP_HOSTS.test(u.hostname) || BLOCKED_PATHS.test(u.pathname)) return;

  const key = u.hostname + u.pathname;
  const last = recentNav.get(key);
  if (last && Date.now() - last < 30 * 60 * 1000) return; // dedupe 30 min
  recentNav.set(key, Date.now());

  ingest("navigation", { host: u.hostname, path: u.pathname, title: (tab.title || "").slice(0, 160) });
});