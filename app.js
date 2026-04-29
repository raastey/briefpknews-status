const STATUS_PATH = "./status-data/latest.json";
const HISTORY_PATH = "./status-data/history.json";
const INCIDENTS_PATH = "./status-data/incidents.json";

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

function renderOverall(latest) {
  const overall = latest.overall || "outage";
  const stateEl = document.getElementById("overallState");
  const metaEl = document.getElementById("overallMeta");
  stateEl.textContent = normalizeState(overall);
  stateEl.style.color = overall === "operational" ? "var(--ok)" : (overall === "degraded" ? "var(--warn)" : "var(--bad)");
  metaEl.textContent = `Last synthetic check: ${fmtTime(latest.checkedAt)} · Region: ${latest.region || "global"}`;
  document.getElementById("lastUpdated").textContent = `Last update: ${fmtTime(latest.checkedAt)}`;
}

function renderServices(latest) {
  const root = document.getElementById("serviceGrid");
  root.innerHTML = "";
  for (const svc of latest.services || []) {
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
    `;
    root.appendChild(card);
  }
}

function computeUptime(history, key) {
  const window = history.slice(-288);
  if (!window.length) return { pct: 0, bars: [] };
  const bars = window.map((run) => {
    const svc = (run.services || []).find((x) => x.key === key);
    return svc?.state === "operational";
  });
  const okCount = bars.filter(Boolean).length;
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
      <div class="uptime-bars">${data.bars.map((ok) => `<span class="${ok ? "ok" : "bad"}"></span>`).join("")}</div>
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
  renderOverall(latest);
  renderServices(latest);
  renderUptime(latest, history.runs || []);
  renderIncidents(incidents.items || []);
  renderHistory(history.runs || []);
}

document.getElementById("refreshBtn").addEventListener("click", () => loadStatus().catch(console.error));
loadStatus().catch((err) => {
  const overall = document.getElementById("overallState");
  const meta = document.getElementById("overallMeta");
  overall.textContent = "Data Unavailable";
  overall.style.color = "var(--bad)";
  meta.textContent = `Unable to read status artifacts: ${err.message}`;
});
