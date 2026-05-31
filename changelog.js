const CHANGELOG_PATH = "./status-data/changelog.json";

let allEntries = [];

function fmtDate(iso) {
  if (!iso) return "--";
  const raw = String(iso).trim();
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(raw);
  if (!Number.isFinite(d.getTime())) return raw;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isCommitLink(link) {
  const url = String(link?.url || "");
  const label = String(link?.label || "");
  if (/\/commit\/[a-f0-9]{7,40}/i.test(url)) return true;
  if (/^commit\s+[a-f0-9]{7,40}\b/i.test(label.trim())) return true;
  return false;
}

function publicLinks(links) {
  return (links || []).filter((l) => l?.url && !isCommitLink(l));
}

function stripCommitLinksFromEntry(entry) {
  return { ...entry, links: publicLinks(entry.links) };
}

function isCommitLedgerEntry(entry) {
  return String(entry?.id || "").startsWith("git-");
}

function isMajorEntry(entry) {
  return entry?.major === true || entry?.prominence === "major";
}

function typeLabel(type) {
  return (
    {
      feature: "new capabilities",
      improvement: "quality-of-life improvements",
      fix: "fixes and stability",
      security: "security improvements",
      ops: "operations",
      docs: "documentation",
      domain: "platform routing"
    }
  )[type] || "product updates";
}

function releaseImpact(entries) {
  const hasSecurity = entries.some((e) => e.type === "security");
  const featureCount = entries.filter((e) => ["feature", "improvement"].includes(e.type)).length;
  if (hasSecurity) return "Important";
  if (featureCount >= 3) return "Major";
  if (featureCount >= 1) return "New";
  return "Improved";
}

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
    if (isMajorEntry(raw)) continue;
    const entry = stripCommitLinksFromEntry(raw);
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
    const tags = [...new Set(sorted.flatMap((e) => e.tags || []))].slice(0, 8);
    const links = sorted
      .flatMap((e) => publicLinks(e.links || []))
      .filter((l, i, arr) => l?.url && arr.findIndex((x) => x.url === l.url) === i)
      .slice(0, 6);

    const previewTitles = sorted
      .slice(0, 5)
      .map((e) => e.title)
      .filter(Boolean);
    const titlePreview =
      previewTitles.length > 0
        ? `${previewTitles.join(" · ")}${sorted.length > previewTitles.length ? " · …" : ""}`
        : "Updates across brief.pk";

    let cardSummary;
    if (sorted.length === 1 && sorted[0].summary) {
      cardSummary = sorted[0].summary;
    } else {
      cardSummary = `This week we published ${sorted.length} ${
        sorted.length === 1 ? "note" : "notes"
      } focused on ${typeLabel(dominantType)}. Included: ${titlePreview}`;
    }

    const why =
      "Each item below is written for readers: what changed, why we cared about it, and how it might affect your routine on the site.";

    releaseNotes.push({
      id: `release-${weekKey}`,
      weekKey,
      date: sorted[0]?.date,
      type: dominantType,
      impact: releaseImpact(sorted),
      title: `${weekRangeLabel(weekKey)} · Weekly release notes`,
      summary: cardSummary,
      whyItMatters: why,
      tags,
      links,
      totalUpdates: sorted.length,
      items: sorted
    });
  }

  return releaseNotes.sort((a, b) => new Date(b.date) - new Date(a.date));
}

function formatVerboseEntryBody(item, opts = {}) {
  const omitTitle = opts.omitTitle === true;
  const titleHtml = omitTitle
    ? ""
    : `<h4 class="release-item-title">${escapeHtml(item.title || "Update")}</h4>`;
  const summary = item.summary ? `<p class="release-item-summary">${escapeHtml(item.summary)}</p>` : "";
  const detailParts = String(item.detail || "")
    .trim()
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const detailHtml = detailParts.map((p) => `<p class="release-item-detail">${escapeHtml(p)}</p>`).join("");
  return `
    <section class="release-item">
      ${titleHtml}
      ${summary}
      ${detailHtml}
    </section>`;
}

function renderMajorMilestones(entries) {
  const root = document.getElementById("majorMilestones");
  const panel = document.getElementById("majorMilestonesPanel");
  if (!root) return;

  if (!entries.length) {
    root.innerHTML = `<p class="major-empty">No major milestones match your filters. Try clearing search or setting the type filter to “All types.”</p>`;
    if (panel) panel.classList.remove("hidden");
    return;
  }

  root.innerHTML = entries
    .map((item) => {
      const display = stripCommitLinksFromEntry(item);
      const tags = (display.tags || []).map((t) => `<span class="release-tag">${escapeHtml(t)}</span>`).join("");
      const links = (publicLinks(display.links) || [])
        .map((l) => `<a href="${escapeHtml(l.url)}" target="_blank" rel="noreferrer">${escapeHtml(l.label || "Link")}</a>`)
        .join("");
      const body = formatVerboseEntryBody(display, { omitTitle: true });
      return `
      <article class="major-card" id="${escapeHtml(display.id || "")}">
        <div class="major-card-top">
          <div>
            <div class="major-eyebrow">Major release</div>
            <h3 class="major-card-title">${escapeHtml(display.title)}</h3>
            <div class="major-card-meta">${fmtDate(display.date)}</div>
          </div>
          <span class="type-pill-major type-${escapeHtml(display.type)}">${escapeHtml(display.type)}</span>
        </div>
        <div class="major-card-body">${body}</div>
        <div class="release-tags">${tags}</div>
        ${links ? `<div class="release-links">${links}</div>` : ""}
      </article>`;
    })
    .join("");

  if (panel) panel.classList.remove("hidden");
}

function renderHighlights(all, majorCount) {
  const root = document.getElementById("highlights");
  if (!root) return;
  const routine = all.filter((e) => !isMajorEntry(e));
  const releases = buildReleaseNotes(routine);
  const recent = releases[0];
  root.innerHTML = `
      <article class="highlight-card"><div class="k">Major milestones</div><div class="v">${majorCount}</div></article>
      <article class="highlight-card"><div class="k">All release notes</div><div class="v">${all.length}</div></article>
      <article class="highlight-card"><div class="k">Weeks with notes</div><div class="v">${releases.length}</div></article>
      <article class="highlight-card"><div class="k">Latest week starts</div><div class="v">${escapeHtml(recent ? weekRangeLabel(recent.weekKey).split("–")[0]?.trim() || "--" : "--")}</div></article>
    `;
}

function entryMatches(entry, q, type) {
  if (type !== "all" && entry.type !== type) return false;
  if (!q) return true;
  const haystack = [entry.title, entry.summary, entry.detail, ...(entry.tags || [])].join(" ").toLowerCase();
  return haystack.includes(q);
}

function renderReleaseTimeline(entries) {
  const root = document.getElementById("releaseTimeline");
  if (!root) return;
  const releases = buildReleaseNotes(entries);
  root.innerHTML = releases
    .map((release) => {
      const tags = (release.tags || []).map((t) => `<span class="release-tag">${escapeHtml(t)}</span>`).join("");
      const links = (release.links || [])
        .map((l) => `<a href="${escapeHtml(l.url)}" target="_blank" rel="noreferrer">${escapeHtml(l.label || "Reference")}</a>`)
        .join("");
      const itemsHtml = (release.items || []).map((item) => formatVerboseEntryBody(stripCommitLinksFromEntry(item))).join("");
      return `
      <article class="release-card">
        <div class="release-top">
          <div>
            <h3 class="release-title">${escapeHtml(release.title)}</h3>
            <div class="release-meta">${fmtDate(release.date)} · ${release.totalUpdates} ${
        release.totalUpdates === 1 ? "item" : "items"}</div>
          </div>
          <span class="release-impact">${escapeHtml(release.impact)}</span>
        </div>
        <p class="release-summary">${escapeHtml(release.summary)}</p>
        <p class="release-why"><strong>For readers:</strong> ${escapeHtml(release.whyItMatters)}</p>
        <div class="release-items-verbose">${itemsHtml}</div>
        <div class="release-tags">${tags}</div>
        ${links ? `<div class="release-links">${links}</div>` : ""}
      </article>
    `;
    })
    .join("");
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
  const majors = filtered.filter(isMajorEntry).sort((a, b) => new Date(b.date) - new Date(a.date));
  const routine = filtered.filter((e) => !isMajorEntry(e));

  renderMajorMilestones(majors);
  renderHighlights(filtered, majors.length);
  renderReleaseTimeline(routine);
  const weeks = buildReleaseNotes(routine);
  renderEmptyState(weeks.length === 0 && majors.length === 0);
}

async function loadChangelog() {
  const res = await fetch(`${CHANGELOG_PATH}?t=${Date.now()}`);
  if (!res.ok) throw new Error("Unable to load changelog data");
  const body = await res.json();
  const raw = Array.isArray(body.entries) ? body.entries : [];
  allEntries = raw
    .filter((e) => !isCommitLedgerEntry(e))
    .map((e) => stripCommitLinksFromEntry(e))
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const heroMeta = document.getElementById("heroMeta");
  const majorN = allEntries.filter(isMajorEntry).length;
  if (heroMeta) {
    heroMeta.textContent = `${majorN} major milestone${majorN === 1 ? "" : "s"} · ${
      allEntries.length
    } release notes · Last updated ${fmtDate(body.lastPublished || allEntries[0]?.date)}`;
  }

  applyFilters();
}

document.getElementById("searchInput")?.addEventListener("input", applyFilters);
document.getElementById("typeFilter")?.addEventListener("change", applyFilters);

loadChangelog().catch((err) => {
  const heroMeta = document.getElementById("heroMeta");
  if (heroMeta) heroMeta.textContent = `Failed to load changelog: ${err.message}`;
});
