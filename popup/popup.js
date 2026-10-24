// H-OS Librarian — Popup
const ENDPOINT = "http://localhost:8000/api/ingest";
const HEALTH = "http://localhost:8000/health";
const $ = (id) => document.getElementById(id);
const DEFAULTS = {
  enabled: false, consentGiven: false, role: "developer", clientId: null, simulateMeet: false,
  toggles: { meet: true, search: true, downloads: true, navigation: false }
};

let settings = { ...DEFAULTS };
let backendOnline = null;

async function load() {
  const { settings: s = {} } = await chrome.storage.local.get("settings");
  settings = { ...DEFAULTS, ...s, toggles: { ...DEFAULTS.toggles, ...(s.toggles || {}) } };
}
const save = () => chrome.storage.local.set({ settings });

function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return s + "s fa";
  if (s < 3600) return Math.round(s / 60) + "m fa";
  return Math.round(s / 3600) + "h fa";
}

async function render() {
  $("master").checked = settings.enabled && settings.consentGiven;
  document.querySelectorAll("[data-toggle]").forEach((el) => {
    el.checked = !!settings.toggles[el.dataset.toggle];
    el.disabled = !settings.enabled;
  });
  $("simulate").checked = settings.simulateMeet;
  $("simulate").disabled = !settings.enabled;
  $("role").value = settings.role;

  const on = settings.enabled && settings.consentGiven;
  const { stats = { sent: 0, failed: 0, lastSent: null }, queue = [], activity = [] } =
    await chrome.storage.local.get(["stats", "queue", "activity"]);

  $("status").classList.toggle("on", on);
  if (!on) {
    $("statusTitle").textContent = "Librarian spento";
    $("statusSub").textContent = "Nessun dato lascia il browser.";
  } else {
    const active = Object.keys(settings.toggles).filter((k) => settings.toggles[k]).length;
    $("statusTitle").textContent = `Trasmissione attiva · ${active} fonti`;
    const be = backendOnline === null ? "" : backendOnline ? "Backend raggiungibile. " : "Backend non raggiungibile: eventi in coda. ";
    $("statusSub").textContent = `${be}Inviati: ${stats.sent}${queue.length ? ` · in coda: ${queue.length}` : ""}` +
      (stats.lastSent ? ` · ultimo ${ago(stats.lastSent)}` : "");
  }

  const log = $("log");
  log.innerHTML = "";
  if (!activity.length) {
    log.innerHTML = '<li class="empty">Niente ancora. Ogni invio comparirà qui.</li>';
  } else {
    activity.slice(0, 12).forEach((a) => {
      const li = document.createElement("li");
      const t = document.createElement("span"); t.className = "t"; t.textContent = ago(a.t);
      const s = document.createElement("span");
      s.textContent = a.summary + (a.status === "queued" ? " (in coda)" : "");
      if (a.status === "queued") s.className = "q";
      li.append(t, s); log.appendChild(li);
    });
  }
}

async function ping() {
  try { backendOnline = (await fetch(HEALTH, { cache: "no-store" })).ok; }
  catch { backendOnline = false; }
  render();
}

// ----- Eventi -----
$("master").addEventListener("change", async (e) => {
  if (e.target.checked && !settings.consentGiven) {
    e.target.checked = false;
    $("consent").classList.add("show");  // serve il consenso informato
    return;
  }
  settings.enabled = e.target.checked;
  await save(); render();
});

$("accept").addEventListener("click", async () => {
  settings.consentGiven = true; settings.enabled = true;
  $("consent").classList.remove("show");
  await save(); ping();
});
$("decline").addEventListener("click", () => $("consent").classList.remove("show"));

document.querySelectorAll("[data-toggle]").forEach((el) =>
  el.addEventListener("change", async () => { settings.toggles[el.dataset.toggle] = el.checked; await save(); render(); }));

$("simulate").addEventListener("change", async (e) => { settings.simulateMeet = e.target.checked; await save(); });
$("role").addEventListener("change", async (e) => { settings.role = e.target.value; await save(); });
$("ping").addEventListener("click", ping);

$("revoke").addEventListener("click", async () => {
  settings.enabled = false; settings.consentGiven = false;
  await save();
  await chrome.storage.local.set({ queue: [], activity: [], stats: { sent: 0, failed: 0, lastSent: null } });
  render();
});

chrome.storage.onChanged.addListener(async () => { await load(); render(); });

(async () => { await load(); await render(); ping(); })();
