const STATUS_PATH = "./status-data/latest.json";
const HISTORY_PATH = "./status-data/history.json";
const INCIDENTS_PATH = "./status-data/incidents.json";
let _latest = null;
let _historyRuns = [];

function fmtTime(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "--";
  return d.toLocaleString();
}

function badgeClass(state) {
  if (state === "operational") return "ok";
  if (state === "degraded") return "warn";
  return "bad";
}

function normalizeState(state) {
  if (state === "operational") return "Operational";
  if (state === "degraded") return "Degraded";
  return "Outage";
}

function healthScore(svc) {
  const latency = Number(svc.latencyMs);
  if (svc.state === "outage") return 5;
  if (svc.state === "degraded") return 45;
  if (!Number.isFinite(latency)) return 65;
  if (latency <= 600) return 96;
  if (latency <= 1200) return 82;
  if (latency <= 2500) return 64;
  return 48;
}

function scoreClass(score) {
  if (score >= 75) return "ok";
  if (score >= 40) return "warn";
  return "bad";
}

function percentile(sortedVals, p) {
  if (!sortedVals.length) return null;
  const idx = (p / 100) * (sortedVals.length - 1);
  const low = Math.floor(idx);
  const high = Math.ceil(idx);
  if (low === high) return sortedVals[low];
  const ratio = idx - low;
  return sortedVals[low] + (sortedVals[high] - sortedVals[low]) * ratio;
}

function renderOverall(latest) {
  const overall = latest.overall || "outage";
  const stateEl = document.getElementById("overallState");
  const metaEl = document.getElementById("overallMeta");
  stateEl.textContent = normalizeState(overall);
  stateEl.style.color = overall === "operational" ? "var(--ok)" : (overall === "degraded" ? "var(--warn)" : "var(--bad)");
  metaEl.textContent = `Last synthetic check: ${fmtTime(latest.checkedAt)} · Region: ${latest.region || "global"}`;
  document.getElementById("lastUpdated").textContent = `Last update: ${fmtTime(latest.checkedAt)}`;

  const services = latest.services || [];
  const ops = services.filter((s) => s.state === "operational").length;
  const degraded = services.filter((s) => s.state === "degraded").length;
  const outages = services.filter((s) => s.state === "outage").length;
  const latencies = services.map((s) => Number(s.latencyMs)).filter(Number.isFinite);
  const avgLatency = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
  document.getElementById("kpiOps").textContent = `${ops}/${services.length}`;
  document.getElementById("kpiDegraded").textContent = String(degraded);
  document.getElementById("kpiOutages").textContent = String(outages);
  document.getElementById("kpiLatency").textContent = avgLatency == null ? "n/a" : `${avgLatency}ms`;
}

function renderServices(latest) {
  const root = document.getElementById("serviceGrid");
  root.innerHTML = "";
  for (const svc of latest.services || []) {
    const score = healthScore(svc);
    const railClass = scoreClass(score);
    const card = document.createElement("article");
    card.className = "service-card";
    card.innerHTML = `
      <div class="service-top">
        <div class="service-name">${svc.name}</div>
        <span class="badge ${badgeClass(svc.state)}">${normalizeState(svc.state)}</span>
      </div>
      <div class="service-meta">
        HTTP ${svc.statusCode ?? "n/a"} · ${svc.latencyMs ?? "n/a"}ms
      </div>
      <div class="service-meta">${svc.url}</div>
      <div class="health-rail"><div class="health-fill ${railClass}" style="width:${score}%"></div></div>
      <div class="health-caption">Health score: ${score}/100</div>
    `;
    root.appendChild(card);
  }
}

function computeUptime(history, key) {
  const window = history.slice(-288);
  if (!window.length) return { pct: 0, bars: [] };
  const bars = window.map((run) => {
    const svc = (run.services || []).find((x) => x.key === key);
    return svc?.state || "outage";
  });
  const okCount = bars.filter((state) => state === "operational").length;
  return { pct: (okCount / bars.length) * 100, bars };
}

function renderUptime(latest, history) {
  const root = document.getElementById("uptimeGrid");
  root.innerHTML = "";
  for (const svc of latest.services || []) {
    const data = computeUptime(history, svc.key);
    const item = document.createElement("article");
    item.className = "uptime-item";
    item.innerHTML = `
      <div class="service-name">${svc.name}</div>
      <div class="uptime-value">${data.pct.toFixed(2)}%</div>
      <div class="uptime-bars">${data.bars.map((state) => `<span class="${badgeClass(state)}"></span>`).join("")}</div>
    `;
    root.appendChild(item);
  }
}

function renderIncidents(items) {
  const root = document.getElementById("incidentList");
  root.innerHTML = "";
  if (!items.length) {
    root.innerHTML = '<div class="incident"><h3>No active incidents</h3><p>All systems have been stable recently.</p></div>';
    return;
  }
  for (const incident of items) {
    const node = document.createElement("article");
    node.className = "incident";
    node.innerHTML = `
      <h3>${incident.title}</h3>
      <p>${incident.detail}</p>
      <div class="when">${incident.status.toUpperCase()} · ${fmtTime(incident.updatedAt)}</div>
    `;
    root.appendChild(node);
  }
}

function renderHistory(history) {
  const root = document.getElementById("historyTableWrap");
  const rows = history.slice(-15).reverse().map((run) => {
    const ops = (run.services || []).filter((x) => x.state === "operational").length;
    return `<tr>
      <td>${fmtTime(run.checkedAt)}</td>
      <td>${normalizeState(run.overall)}</td>
      <td>${ops}/${(run.services || []).length}</td>
      <td>${run.region || "global"}</td>
    </tr>`;
  }).join("");
  root.innerHTML = `
    <table>
      <thead>
        <tr><th>Checked</th><th>Overall</th><th>Operational</th><th>Region</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderHeatmap(latest, history) {
  const root = document.getElementById("heatmapWrap");
  const recent = history.slice(-24);
  const labels = recent.map((run) => new Date(run.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  const head = labels.map((x) => `<th title="${x}">${x}</th>`).join("");
  const rows = (latest.services || []).map((svc) => {
    const boxes = recent.map((run) => {
      const state = (run.services || []).find((s) => s.key === svc.key)?.state || "outage";
      return `<td><span class="hm-box ${badgeClass(state)}" title="${normalizeState(state)}"></span></td>`;
    }).join("");
    return `<tr><td class="hm-service">${svc.name}</td>${boxes}</tr>`;
  }).join("");
  root.innerHTML = `
    <div class="heatmap">
      <table>
        <thead><tr><th class="hm-service">Service</th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function serviceSeries(history, key) {
  return history
    .map((run) => ({ t: run.checkedAt, svc: (run.services || []).find((s) => s.key === key) }))
    .filter((x) => x.svc);
}

function outageStreak(series) {
  let current = 0;
  let max = 0;
  for (const pt of series) {
    if (pt.svc.state === "outage") {
      current += 1;
      max = Math.max(max, current);
    } else {
      current = 0;
    }
  }
  return { current, max };
}

function buildPath(values, width, height) {
  if (!values.length) return "";
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = Math.max(max - min, 1);
  return values.map((v, i) => {
    const x = (i / (values.length - 1 || 1)) * width;
    const y = height - ((v - min) / span) * height;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function renderDeepDive(latest, history) {
  const select = document.getElementById("serviceSelect");
  const root = document.getElementById("deepKpis");
  const svg = document.getElementById("latencySpark");
  const services = latest.services || [];
  if (!services.length) return;

  if (!select.dataset.bound) {
    select.innerHTML = services.map((s) => `<option value="${s.key}">${s.name}</option>`).join("");
    select.dataset.bound = "1";
    select.addEventListener("change", () => renderDeepDive(_latest, _historyRuns));
  }
  const activeKey = select.value || services[0].key;
  if (!select.value) select.value = activeKey;
  const activeService = services.find((s) => s.key === activeKey) || services[0];
  const series = serviceSeries(history, activeService.key);
  const lats = series.map((x) => Number(x.svc.latencyMs)).filter(Number.isFinite).sort((a, b) => a - b);
  const p50 = percentile(lats, 50);
  const p95 = percentile(lats, 95);
  const p99 = percentile(lats, 99);
  const maxLat = lats.length ? lats[lats.length - 1] : null;
  const ops = series.filter((x) => x.svc.state === "operational").length;
  const avail = series.length ? (ops / series.length) * 100 : 0;
  const streak = outageStreak(series);
  const errorBudget = Math.max(0, 99.9 - avail);
  const risk = errorBudget > 0.4 ? "High" : errorBudget > 0.15 ? "Medium" : "Low";
  root.innerHTML = `
    <article class="deep-card"><div class="k">24h Availability</div><div class="v">${avail.toFixed(2)}%</div></article>
    <article class="deep-card"><div class="k">P50 Latency</div><div class="v">${p50 == null ? "n/a" : `${Math.round(p50)}ms`}</div></article>
    <article class="deep-card"><div class="k">P95 Latency</div><div class="v">${p95 == null ? "n/a" : `${Math.round(p95)}ms`}</div></article>
    <article class="deep-card"><div class="k">P99 Latency</div><div class="v">${p99 == null ? "n/a" : `${Math.round(p99)}ms`}</div></article>
    <article class="deep-card"><div class="k">Max Latency</div><div class="v">${maxLat == null ? "n/a" : `${Math.round(maxLat)}ms`}</div></article>
    <article class="deep-card"><div class="k">Outage Streak</div><div class="v">${streak.current} now / ${streak.max} max</div></article>
    <article class="deep-card"><div class="k">Error Budget Burn</div><div class="v">${errorBudget.toFixed(3)}%</div></article>
    <article class="deep-card"><div class="k">SLO Risk</div><div class="v">${risk}</div></article>
  `;

  const latSeq = series.map((x) => Number(x.svc.latencyMs)).filter(Number.isFinite).slice(-96);
  const path = buildPath(latSeq, 900, 150);
  svg.innerHTML = `
    <line x1="0" y1="150" x2="900" y2="150" stroke="#cbd5e1" stroke-width="1"></line>
    <path d="${path}" fill="none" stroke="#0369a1" stroke-width="3" stroke-linecap="round"></path>
    <text x="8" y="16" fill="#64748b" font-size="12" font-family="JetBrains Mono">${activeService.name} latency trend</text>
  `;
}

async function loadStatus() {
  const [latestRes, historyRes, incidentsRes] = await Promise.all([
    fetch(`${STATUS_PATH}?t=${Date.now()}`),
    fetch(`${HISTORY_PATH}?t=${Date.now()}`),
    fetch(`${INCIDENTS_PATH}?t=${Date.now()}`)
  ]);
  if (!latestRes.ok || !historyRes.ok || !incidentsRes.ok) throw new Error("status data unavailable");
  const latest = await latestRes.json();
  const history = await historyRes.json();
  const incidents = await incidentsRes.json();
  _latest = latest;
  _historyRuns = history.runs || [];
  renderOverall(latest);
  renderServices(latest);
  renderUptime(latest, _historyRuns);
  renderHeatmap(latest, _historyRuns);
  renderDeepDive(latest, _historyRuns);
  renderIncidents(incidents.items || []);
  renderHistory(_historyRuns);
}

document.getElementById("refreshBtn").addEventListener("click", () => loadStatus().catch(console.error));
loadStatus().catch((err) => {
  const overall = document.getElementById("overallState");
  const meta = document.getElementById("overallMeta");
  overall.textContent = "Data Unavailable";
  overall.style.color = "var(--bad)";
  meta.textContent = `Unable to read status artifacts: ${err.message}`;
});
