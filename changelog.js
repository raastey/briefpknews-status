const CHANGELOG_PATH = "./status-data/changelog.json";
const HISTORY_PATH = "./status-data/changelog-history.json";

let allEntries = [];

function fmtDate(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso || "--";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderHighlights(entries) {
  const root = document.getElementById("highlights");
  if (!root) return;
  const featureCount = entries.filter((e) => ["feature", "improvement"].includes(e.type)).length;
  const fixCount = entries.filter((e) => ["fix", "security"].includes(e.type)).length;
  const opsCount = entries.filter((e) => ["ops", "domain", "docs"].includes(e.type)).length;

  root.innerHTML = `
    <article class="highlight-card"><div class="k">Total entries</div><div class="v">${entries.length}</div></article>
    <article class="highlight-card"><div class="k">Product updates</div><div class="v">${featureCount}</div></article>
    <article class="highlight-card"><div class="k">Fixes + security</div><div class="v">${fixCount}</div></article>
    <article class="highlight-card"><div class="k">Ops + docs</div><div class="v">${opsCount}</div></article>
  `;
}

function entryMatches(entry, q, type) {
  if (type !== "all" && entry.type !== type) return false;
  if (!q) return true;
  const haystack = [
    entry.title,
    entry.summary,
    ...(entry.tags || [])
  ].join(" ").toLowerCase();
  return haystack.includes(q);
}

function renderTimeline(entries) {
  const root = document.getElementById("timeline");
  const empty = document.getElementById("emptyState");
  if (!root || !empty) return;

  if (!entries.length) {
    root.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  root.innerHTML = entries.map((entry) => {
    const tags = (entry.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
    const links = (entry.links || []).map((l) => `<a href="${escapeHtml(l.url)}" target="_blank" rel="noreferrer">${escapeHtml(l.label || "Reference")}</a>`).join("");
    return `
      <article class="entry">
        <div class="entry-top">
          <div>
            <h3 class="entry-title">${escapeHtml(entry.title)}</h3>
            <div class="entry-meta">${fmtDate(entry.date)} · ${escapeHtml(entry.id)}</div>
          </div>
          <span class="type-pill type-${escapeHtml(entry.type)}">${escapeHtml(entry.type)}</span>
        </div>
        <p class="entry-summary">${escapeHtml(entry.summary)}</p>
        <div class="tag-list">${tags}</div>
        ${links ? `<div class="entry-links">${links}</div>` : ""}
      </article>
    `;
  }).join("");
}

function applyFilters() {
  const q = (document.getElementById("searchInput")?.value || "").trim().toLowerCase();
  const type = document.getElementById("typeFilter")?.value || "all";
  const filtered = allEntries.filter((e) => entryMatches(e, q, type));
  renderTimeline(filtered);
}

function commitHashFromEntry(entry) {
  const url = entry?.links?.[0]?.url || "";
  const m = url.match(/\/commit\/([a-f0-9]{7,40})$/i);
  return m ? m[1].toLowerCase() : null;
}

function mergeEntries(curatedEntries, historyEntries) {
  const seenHashes = new Set();
  for (const e of curatedEntries) {
    const h = commitHashFromEntry(e);
    if (h) seenHashes.add(h);
  }

  const historyOnly = (historyEntries || []).filter((e) => {
    const h = commitHashFromEntry(e);
    return h ? !seenHashes.has(h) : true;
  });

  return [...curatedEntries, ...historyOnly];
}

async function loadChangelog() {
  const [curatedRes, historyRes] = await Promise.all([
    fetch(`${CHANGELOG_PATH}?t=${Date.now()}`),
    fetch(`${HISTORY_PATH}?t=${Date.now()}`)
  ]);
  if (!curatedRes.ok) throw new Error("Unable to load changelog data");
  const body = await curatedRes.json();
  const historyBody = historyRes.ok ? await historyRes.json() : { entries: [] };
  const curated = Array.isArray(body.entries) ? body.entries : [];
  const history = Array.isArray(historyBody.entries) ? historyBody.entries : [];
  allEntries = mergeEntries(curated, history).sort((a, b) => new Date(b.date) - new Date(a.date));

  const heroMeta = document.getElementById("heroMeta");
  const lastPublished = document.getElementById("lastPublished");
  if (heroMeta) {
    heroMeta.textContent = `${allEntries.length} entries · Last update ${fmtDate(body.lastPublished || allEntries[0]?.date)}`;
  }
  if (lastPublished) {
    lastPublished.textContent = `Last published: ${fmtDate(body.lastPublished || allEntries[0]?.date)}`;
  }

  renderHighlights(allEntries);
  renderTimeline(allEntries);
}

document.getElementById("searchInput")?.addEventListener("input", applyFilters);
document.getElementById("typeFilter")?.addEventListener("change", applyFilters);

loadChangelog().catch((err) => {
  const heroMeta = document.getElementById("heroMeta");
  if (heroMeta) heroMeta.textContent = `Failed to load changelog: ${err.message}`;
});
