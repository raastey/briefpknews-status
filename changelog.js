const CHANGELOG_PATH = "./status-data/changelog.json";
const HISTORY_PATH = "./status-data/changelog-history.json";

let allEntries = [];
let currentMode = "release";

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

function toSentenceCase(text) {
  const t = String(text || "").trim();
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function friendlyCommitCopy(entry) {
  const raw = String(entry?.title || "").trim();
  const lower = raw.toLowerCase();

  if (!raw) {
    return {
      title: "Repository update",
      summary: "A change was recorded in the project history."
    };
  }

  if (lower.includes("chore(status): update synthetic status snapshot")) {
    return {
      title: "Automated status monitoring snapshot updated",
      summary: "Routine monitoring refreshed the public status data and health artifacts."
    };
  }

  if (lower.startsWith("merge pull request")) {
    return {
      title: "Code updates merged into main",
      summary: "A pull request was merged, bringing reviewed updates into production history."
    };
  }

  if (lower === "create cname") {
    return {
      title: "Custom domain mapping was added",
      summary: "Domain configuration for the status site was set up via CNAME."
    };
  }

  if (lower === "update cname") {
    return {
      title: "Custom domain mapping was updated",
      summary: "Domain routing for the status site was adjusted."
    };
  }

  const stripped = raw.replace(/^[a-z]+(\([^)]+\))?:\s*/i, "");
  const cleaned = stripped.replace(/\s+/g, " ").trim();
  const title = toSentenceCase(cleaned || raw);
  return {
    title,
    summary: "This update was delivered in the repository and recorded in the release timeline."
  };
}

function isCommitLedgerEntry(entry) {
  return String(entry?.id || "").startsWith("git-");
}

function normalizeEntryForDisplay(entry) {
  return isCommitLedgerEntry(entry)
    ? { ...entry, ...friendlyCommitCopy(entry) }
    : entry;
}

function typeLabel(type) {
  return ({
    feature: "feature delivery",
    improvement: "product improvements",
    fix: "stability fixes",
    security: "security hardening",
    ops: "operations",
    docs: "documentation",
    domain: "platform routing"
  })[type] || "platform updates";
}

function releaseImpact(entries) {
  const hasSecurity = entries.some((e) => e.type === "security");
  const featureCount = entries.filter((e) => ["feature", "improvement"].includes(e.type)).length;
  if (hasSecurity) return "Important";
  if (featureCount >= 3) return "Major";
  if (featureCount >= 1) return "New";
  return "Improved";
}

/** Sunday YYYY-MM-DD (local) — stable sort key for a week bucket. */
function sundayKeyFromDate(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const sun = new Date(t);
  sun.setDate(t.getDate() - t.getDay());
  const y = sun.getFullYear();
  const m = String(sun.getMonth() + 1).padStart(2, "0");
  const day = String(sun.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function weekRangeLabel(sundayKey) {
  const [ys, ms, ds] = sundayKey.split("-");
  const start = new Date(Number(ys), Number(ms) - 1, Number(ds));
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const o = { month: "short", day: "numeric" };
  const a = start.toLocaleDateString(undefined, { ...o, year: "numeric" });
  const b = end.toLocaleDateString(undefined, { ...o, year: "numeric" });
  return `${a}–${b}`;
}

function buildReleaseNotes(entries) {
  const grouped = new Map();
  for (const raw of entries) {
    const entry = normalizeEntryForDisplay(raw);
    const d = new Date(entry.date);
    if (!Number.isFinite(d.getTime())) continue;
    const key = sundayKeyFromDate(d);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(entry);
  }

  const releaseNotes = [];
  for (const [weekKey, items] of grouped.entries()) {
    const sorted = items.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    const typeCounts = sorted.reduce((acc, item) => {
      acc[item.type] = (acc[item.type] || 0) + 1;
      return acc;
    }, {});
    const dominantType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "improvement";
    const uniqueTitles = [];
    for (const item of sorted) {
      const display = normalizeEntryForDisplay(item);
      if (display.title && !uniqueTitles.includes(display.title)) uniqueTitles.push(display.title);
      if (uniqueTitles.length >= 10) break;
    }
    const tags = [...new Set(sorted.flatMap((e) => e.tags || []))]
      .filter((t) => t !== "git-history")
      .slice(0, 8);
    const links = sorted
      .flatMap((e) => e.links || [])
      .filter((l, i, arr) => l?.url && arr.findIndex((x) => x.url === l.url) === i)
      .slice(0, 6);

    releaseNotes.push({
      id: `release-${weekKey}`,
      weekKey,
      date: sorted[0]?.date,
      type: dominantType,
      impact: releaseImpact(sorted),
      title: `${weekRangeLabel(weekKey)} · Release notes`,
      summary: `Delivered ${sorted.length} updates focused on ${typeLabel(dominantType)} across the briefpk experience (status surface and news app history).`,
      whyItMatters: `This cycle improves reliability, product clarity, and day-to-day trust for briefpk readers.`,
      highlights: uniqueTitles,
      tags,
      links,
      totalUpdates: sorted.length,
      items: sorted
    });
  }

  return releaseNotes.sort((a, b) => new Date(b.date) - new Date(a.date));
}

function renderHighlights(entries, mode = "release") {
  const root = document.getElementById("highlights");
  if (!root) return;
  if (mode === "release") {
    const releases = buildReleaseNotes(entries);
    const major = releases.filter((r) => r.impact === "Major").length;
    const recent = releases[0];
    root.innerHTML = `
      <article class="highlight-card"><div class="k">Release weeks</div><div class="v">${releases.length}</div></article>
      <article class="highlight-card"><div class="k">Historical updates</div><div class="v">${entries.length}</div></article>
      <article class="highlight-card"><div class="k">Major releases</div><div class="v">${major}</div></article>
      <article class="highlight-card"><div class="k">Latest week</div><div class="v">${escapeHtml(recent ? weekRangeLabel(recent.weekKey).split("–")[0]?.trim() || "--" : "--")}</div></article>
    `;
    return;
  }

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

function formatReleaseDetails(items) {
  const counts = new Map();
  for (const item of items) {
    const t = normalizeEntryForDisplay(item).title || "Update";
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  const pairs = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  const max = 150;
  const shown = pairs.slice(0, max);
  const more = pairs.length - shown.length;
  const lis = shown
    .map(([t, c]) => {
      const label = c > 1 ? `${escapeHtml(t)} · ×${c}` : escapeHtml(t);
      return `<li>${label}</li>`;
    })
    .join("");
  const moreLine =
    more > 0 ? `<li class="rollup-more"><em>…and ${more} more distinct change titles</em></li>` : "";
  return `<details class="release-details"><summary class="release-details-summary">Full change list (${items.length} updates)</summary><ul class="release-full-list">${lis}${moreLine}</ul></details>`;
}

function renderTimeline(entries) {
  const root = document.getElementById("timeline");
  if (!root) return;
  root.innerHTML = entries.map((entry) => {
    const display = normalizeEntryForDisplay(entry);
    const tags = (entry.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
    const links = (entry.links || []).map((l) => `<a href="${escapeHtml(l.url)}" target="_blank" rel="noreferrer">${escapeHtml(l.label || "Reference")}</a>`).join("");
    return `
      <article class="entry">
        <div class="entry-top">
          <div>
            <h3 class="entry-title">${escapeHtml(display.title)}</h3>
            <div class="entry-meta">${fmtDate(entry.date)} · ${escapeHtml(entry.id)}</div>
          </div>
          <span class="type-pill type-${escapeHtml(entry.type)}">${escapeHtml(entry.type)}</span>
        </div>
        <p class="entry-summary">${escapeHtml(display.summary || entry.summary)}</p>
        <div class="tag-list">${tags}</div>
        ${links ? `<div class="entry-links">${links}</div>` : ""}
      </article>
    `;
  }).join("");
}

function renderReleaseTimeline(entries) {
  const root = document.getElementById("releaseTimeline");
  if (!root) return;
  const releases = buildReleaseNotes(entries);
  root.innerHTML = releases.map((release) => {
    const tags = (release.tags || []).map((t) => `<span class="release-tag">${escapeHtml(t)}</span>`).join("");
    const highlights = (release.highlights || []).map((h) => `<li>${escapeHtml(h)}</li>`).join("");
    const links = (release.links || []).map((l) => `<a href="${escapeHtml(l.url)}" target="_blank" rel="noreferrer">${escapeHtml(l.label || "Reference")}</a>`).join("");
    return `
      <article class="release-card">
        <div class="release-top">
          <div>
            <h3 class="release-title">${escapeHtml(release.title)}</h3>
            <div class="release-meta">${fmtDate(release.date)} · ${release.totalUpdates} updates</div>
          </div>
          <span class="release-impact">${escapeHtml(release.impact)}</span>
        </div>
        <p class="release-summary">${escapeHtml(release.summary)}</p>
        <p class="release-why"><strong>Why it matters:</strong> ${escapeHtml(release.whyItMatters)}</p>
        <ul class="release-list">${highlights}</ul>
        ${formatReleaseDetails(release.items || [])}
        <div class="release-tags">${tags}</div>
        ${links ? `<div class="release-links">${links}</div>` : ""}
      </article>
    `;
  }).join("");
}

function setMode(mode) {
  currentMode = mode;
  const releaseTab = document.getElementById("releaseNotesTab");
  const technicalTab = document.getElementById("technicalTab");
  const releaseTimeline = document.getElementById("releaseTimeline");
  const timeline = document.getElementById("timeline");
  const heading = document.getElementById("timelineHeading");
  const subhead = document.getElementById("timelineSubhead");
  const viewCopy = document.getElementById("viewCopy");
  if (!releaseTab || !technicalTab || !releaseTimeline || !timeline) return;

  const isRelease = mode === "release";
  releaseTab.classList.toggle("active", isRelease);
  releaseTab.setAttribute("aria-selected", String(isRelease));
  technicalTab.classList.toggle("active", !isRelease);
  technicalTab.setAttribute("aria-selected", String(!isRelease));
  releaseTimeline.classList.toggle("hidden", !isRelease);
  timeline.classList.toggle("hidden", isRelease);

  if (heading) heading.textContent = isRelease ? "Release timeline" : "Technical timeline";
  if (subhead) {
    subhead.textContent = isRelease
      ? "Human-readable weekly releases synthesized from curated notes plus merged git history (status site + news app)."
      : "Detailed engineering timeline with raw implementation history and references.";
  }
  if (viewCopy) {
    viewCopy.textContent = isRelease
      ? "Release Notes are written for customers in plain language. Switch to Technical Changelog for raw implementation history."
      : "Technical Changelog exposes implementation-level details, commit IDs, and platform signals for deep transparency.";
  }
}

function renderEmptyState(isEmpty) {
  const empty = document.getElementById("emptyState");
  if (!empty) return;
  empty.classList.toggle("hidden", !isEmpty);
}

function applyFilters() {
  const q = (document.getElementById("searchInput")?.value || "").trim().toLowerCase();
  const type = document.getElementById("typeFilter")?.value || "all";
  const filtered = allEntries.filter((e) => entryMatches(e, q, type));
  renderHighlights(filtered, currentMode);
  if (currentMode === "release") {
    renderReleaseTimeline(filtered);
    renderTimeline(filtered);
    renderEmptyState(!buildReleaseNotes(filtered).length);
  } else {
    renderReleaseTimeline(filtered);
    renderTimeline(filtered);
    renderEmptyState(!filtered.length);
  }
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
    heroMeta.textContent = `${allEntries.length} historical updates · Last publication ${fmtDate(body.lastPublished || allEntries[0]?.date)}`;
  }
  if (lastPublished) {
    lastPublished.textContent = `Last published: ${fmtDate(body.lastPublished || allEntries[0]?.date)}`;
  }

  setMode("release");
  renderHighlights(allEntries, "release");
  renderReleaseTimeline(allEntries);
  renderTimeline(allEntries);
  renderEmptyState(!buildReleaseNotes(allEntries).length);
}

document.getElementById("searchInput")?.addEventListener("input", applyFilters);
document.getElementById("typeFilter")?.addEventListener("change", applyFilters);
document.getElementById("releaseNotesTab")?.addEventListener("click", () => {
  setMode("release");
  applyFilters();
});
document.getElementById("technicalTab")?.addEventListener("click", () => {
  setMode("technical");
  applyFilters();
});

loadChangelog().catch((err) => {
  const heroMeta = document.getElementById("heroMeta");
  if (heroMeta) heroMeta.textContent = `Failed to load changelog: ${err.message}`;
});
