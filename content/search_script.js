// Ricerche (Google / Bing / DuckDuckGo)
// Estrae query, titoli/URL dei primi risultati, ricerche correlate e parole chiave.
// Si attiva solo se master ON + consenso + toggle "search" ON (verificato anche dal service worker).

(() => {
  const STOP = new Set(("il lo la i gli le un uno una di a da in con su per tra fra e o ma che come cosa quale quali del della dei delle " +
    "the a an of to in on for and or with from by is are how what which best vs com www https http it en").split(" "));

  const engine = location.hostname.includes("google") ? "google"
              : location.hostname.includes("bing") ? "bing" : "duckduckgo";

  const getQuery = () => new URLSearchParams(location.search).get("q")?.trim() || "";

  function extractResults() {
    const out = [];
    const sel = engine === "google" ? "a:has(h3)"
              : engine === "bing" ? "li.b_algo h2 a"
              : "a[data-testid='result-title-a'], a.result__a";
    document.querySelectorAll(sel).forEach((a) => {
      const title = (a.querySelector("h3")?.innerText || a.innerText || "").trim();
      let url = a.href;
      try { const u = new URL(url); url = u.origin + u.pathname; } catch { return; }
      if (title && /^https?:/.test(url)) out.push({ title: title.slice(0, 140), url });
    });
    return out.slice(0, 8);
  }

  function extractRelated() {
    const sel = engine === "google" ? "#botstuff a, div[data-initq], div[jsname='Cpkphb'] span"
              : engine === "bing" ? ".b_rs a, .b_ans .b_algoheader a"
              : ".related-searches__link, a[data-testid='related-searches-link']";
    const set = new Set();
    document.querySelectorAll(sel).forEach((el) => {
      const t = (el.innerText || "").trim();
      if (t && t.length > 3 && t.length < 90) set.add(t);
    });
    return [...set].slice(0, 10);
  }

  function keywords(query, results, related) {
    const score = new Map();
    const add = (text, w) => text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}\-+#.]{2,}/gu)?.forEach((t) => {
      if (!STOP.has(t)) score.set(t, (score.get(t) || 0) + w);
    });
    add(query, 5);
    results.forEach((r) => add(r.title, 2));
    related.forEach((r) => add(r, 1));
    return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
  }

  let lastSent = "";
  async function capture() {
    const query = getQuery();
    if (!query || query === lastSent) return;

    const { settings } = await chrome.storage.local.get("settings");
    if (!settings?.enabled || !settings?.consentGiven || settings?.toggles?.search === false) return;

    lastSent = query;
    const results = extractResults();
    const related = extractRelated();
    chrome.runtime.sendMessage({
      type: "INGEST", source: "search",
      data: { engine, query, results, related_searches: related, keywords: keywords(query, results, related) }
    }).catch(() => {});
  }

  // Aspetta che i risultati siano renderizzati, poi controlla i cambi di query (ricerche SPA).
  setTimeout(capture, 1500);
  setInterval(capture, 2000);
})();
