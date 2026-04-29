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
    key: "market",
    name: "Market API",
    url: "https://brief-pk-newsfeed-original-production.up.railway.app/api/market",
    expectedStatuses: [200, 401]
  },
  {
    key: "map",
    name: "Pakistan Map API",
    url: "https://brief-pk-newsfeed-original-production.up.railway.app/api/pakistan-map",
    expectedStatuses: [200, 401]
  },
  {
    key: "security",
    name: "Security Economy API",
    url: "https://brief-pk-newsfeed-original-production.up.railway.app/api/security-economy",
    expectedStatuses: [200, 401]
  },
  {
    key: "securityInsight",
    name: "Security Insight API",
    url: "https://brief-pk-newsfeed-original-production.up.railway.app/api/security-economy-insight",
    expectedStatuses: [200, 401]
  },
  {
    key: "macro",
    name: "Pakistan Macro API",
    url: "https://brief-pk-newsfeed-original-production.up.railway.app/api/pakistan-macro",
    expectedStatuses: [200, 401]
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

async function fetchAiRouterSnapshot() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://brief-pk-newsfeed-original-production.up.railway.app/api/health", {
      method: "GET",
      signal: ctrl.signal,
      headers: { "cache-control": "no-cache" }
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.ai_router || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function probeUrl(url, expectedStatuses) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: ctrl.signal,
      headers: { "cache-control": "no-cache" },
      redirect: "manual"
    });
    const latencyMs = Date.now() - start;
    const ok = expectedStatuses.includes(res.status);
    return { ok, statusCode: res.status, latencyMs };
  } catch {
    return { ok: false, statusCode: 0, latencyMs: null };
  } finally {
    clearTimeout(timer);
  }
}

async function probeUserJourneys() {
  const checks = [
    {
      key: "guest-landing",
      name: "Guest Landing Flow",
      steps: [
        { label: "Load home shell", url: "https://brief-pk-newsfeed-original-production.up.railway.app/", expected: [200, 301, 302] },
        { label: "Reach login page", url: "https://brief-pk-newsfeed-original-production.up.railway.app/login.html", expected: [200] }
      ]
    },
    {
      key: "auth-gate",
      name: "Auth Gate Integrity",
      steps: [
        { label: "Protected /api/news blocks guest", url: "https://brief-pk-newsfeed-original-production.up.railway.app/api/news", expected: [401] },
        { label: "Session probe returns auth state", url: "https://brief-pk-newsfeed-original-production.up.railway.app/api/auth/me", expected: [200, 401] }
      ]
    },
    {
      key: "reader-path",
      name: "Reader Core Journey",
      steps: [
        { label: "Public health endpoint", url: "https://brief-pk-newsfeed-original-production.up.railway.app/api/health", expected: [200] },
        { label: "Intelligence endpoint reachable", url: "https://brief-pk-newsfeed-original-production.up.railway.app/api/intelligence", expected: [200, 401, 503] }
      ]
    }
  ];

  const out = [];
  for (const journey of checks) {
    const stepResults = [];
    for (const step of journey.steps) {
      const r = await probeUrl(step.url, step.expected);
      stepResults.push({
        label: step.label,
        statusCode: r.statusCode,
        latencyMs: r.latencyMs,
        ok: r.ok
      });
    }
    const pass = stepResults.filter((s) => s.ok).length;
    const avg = stepResults
      .map((s) => Number(s.latencyMs))
      .filter(Number.isFinite);
    const avgLatencyMs = avg.length ? Math.round(avg.reduce((a, b) => a + b, 0) / avg.length) : null;
    out.push({
      key: journey.key,
      name: journey.name,
      state: pass === stepResults.length ? "operational" : (pass > 0 ? "degraded" : "outage"),
      score: Math.round((pass / stepResults.length) * 100),
      avgLatencyMs,
      steps: stepResults
    });
  }
  return out;
}

function aggregateOverall(results) {
  if (results.some((r) => r.state === "outage")) return "outage";
  if (results.some((r) => r.state === "degraded")) return "degraded";
  return "operational";
}

async function main() {
  const checkedAt = new Date().toISOString();
  const results = await Promise.all(services.map((svc) => probe(svc)));
  const aiRouter = await fetchAiRouterSnapshot();
  const userJourneys = await probeUserJourneys();
  const latest = {
    checkedAt,
    overall: aggregateOverall(results),
    region: "github-actions",
    services: results,
    aiRouter,
    userJourneys
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
