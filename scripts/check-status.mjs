import { readFile, writeFile } from "node:fs/promises";

const OUTPUT_LATEST = "status-data/latest.json";
const OUTPUT_HISTORY = "status-data/history.json";
const HISTORY_LIMIT = 2016; // one week at 5-minute intervals
const TIMEOUT_MS = 12000;

const services = [
  {
    key: "site",
    name: "Main Website",
    url: "https://brief-pk-newsfeed-original-production.up.railway.app/",
    expectedStatuses: [200, 301, 302]
  },
  {
    key: "health",
    name: "Public Health API",
    url: "https://brief-pk-newsfeed-original-production.up.railway.app/api/health",
    expectedStatuses: [200]
  },
  {
    key: "auth",
    name: "Auth Endpoint",
    url: "https://brief-pk-newsfeed-original-production.up.railway.app/api/auth/me",
    expectedStatuses: [200, 401]
  },
  {
    key: "news",
    name: "News API",
    url: "https://brief-pk-newsfeed-original-production.up.railway.app/api/news",
    expectedStatuses: [200, 401]
  },
  {
    key: "intel",
    name: "Intelligence API",
    url: "https://brief-pk-newsfeed-original-production.up.railway.app/api/intelligence",
    expectedStatuses: [200, 401, 503]
  },
  {
    key: "macroInsight",
    name: "Macro Insight API",
    url: "https://brief-pk-newsfeed-original-production.up.railway.app/api/pakistan-macro-insight",
    expectedStatuses: [200, 401]
  }
];

function serviceState(ok, latencyMs) {
  if (!ok) return "outage";
  if (latencyMs > 3000) return "degraded";
  return "operational";
}

async function probe(service) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(service.url, {
      method: "GET",
      signal: ctrl.signal,
      headers: { "cache-control": "no-cache" }
    });
    const latencyMs = Date.now() - start;
    const ok = service.expectedStatuses.includes(res.status);
    return {
      key: service.key,
      name: service.name,
      url: service.url,
      state: serviceState(ok, latencyMs),
      statusCode: res.status,
      latencyMs
    };
  } catch {
    return {
      key: service.key,
      name: service.name,
      url: service.url,
      state: "outage",
      statusCode: 0,
      latencyMs: null
    };
  } finally {
    clearTimeout(timer);
  }
}

function aggregateOverall(results) {
  if (results.some((r) => r.state === "outage")) return "outage";
  if (results.some((r) => r.state === "degraded")) return "degraded";
  return "operational";
}

async function main() {
  const checkedAt = new Date().toISOString();
  const results = await Promise.all(services.map((svc) => probe(svc)));
  const latest = {
    checkedAt,
    overall: aggregateOverall(results),
    region: "github-actions",
    services: results
  };

  let history = { runs: [] };
  try {
    history = JSON.parse(await readFile(OUTPUT_HISTORY, "utf8"));
  } catch {
    history = { runs: [] };
  }
  history.runs.push(latest);
  history.runs = history.runs.slice(-HISTORY_LIMIT);

  await writeFile(OUTPUT_LATEST, `${JSON.stringify(latest, null, 2)}\n`, "utf8");
  await writeFile(OUTPUT_HISTORY, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  console.log(`updated status at ${checkedAt} (${latest.overall})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
