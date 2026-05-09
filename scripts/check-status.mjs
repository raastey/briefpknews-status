import { readFile, writeFile } from "node:fs/promises";

const OUTPUT_LATEST = "status-data/latest.json";
const OUTPUT_HISTORY = "status-data/history.json";
const OUTPUT_INCIDENTS = "status-data/incidents.json";
const HISTORY_LIMIT = 2016; // one week at 5-minute intervals
const TIMEOUT_MS = 12000;
const BASE = "https://www.briefpknews.xyz";

const services = [
  {
    key: "site",
    name: "Main Website",
    url: `${BASE}/`,
    expectedStatuses: [200, 301, 302]
  },
  {
    key: "health",
    name: "Public Health API",
    url: `${BASE}/api/health`,
    expectedStatuses: [200]
  },
  {
    key: "auth",
    name: "Auth Endpoint",
    url: `${BASE}/api/auth/me`,
    expectedStatuses: [200, 401]
  },
  {
    key: "news",
    name: "News API",
    url: `${BASE}/api/news`,
    expectedStatuses: [200, 401]
  },
  {
    key: "search",
    name: "Search API",
    url: `${BASE}/api/search?q=test&limit=3`,
    expectedStatuses: [200, 401]
  },
  {
    key: "intel",
    name: "Intelligence API",
    url: `${BASE}/api/intelligence`,
    expectedStatuses: [200, 401, 503]
  },
  {
    key: "market",
    name: "Market API",
    url: `${BASE}/api/market`,
    expectedStatuses: [200, 401]
  },
  {
    key: "map",
    name: "Pakistan Map API",
    url: `${BASE}/api/pakistan-map`,
    expectedStatuses: [200, 401]
  },
  {
    key: "security",
    name: "Security Economy API",
    url: `${BASE}/api/security-economy`,
    expectedStatuses: [200, 401]
  },
  {
    key: "securityInsight",
    name: "Security Insight API",
    url: `${BASE}/api/security-economy-insight`,
    expectedStatuses: [200, 401]
  },
  {
    key: "macro",
    name: "Pakistan Macro API",
    url: `${BASE}/api/pakistan-macro`,
    expectedStatuses: [200, 401]
  },
  {
    key: "macroInsight",
    name: "Macro Insight API",
    url: `${BASE}/api/pakistan-macro-insight`,
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

async function fetchHealthSnapshot() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/api/health`, {
      method: "GET",
      signal: ctrl.signal,
      headers: { "cache-control": "no-cache" }
    });
    if (!res.ok) return null;
    const body = await res.json();
    return {
      loginHealth: body?.login_health ?? null
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** When production /api/health has no login_health yet, infer what we can from public probes. */
async function inferLoginHealthFallback(journeys) {
  const guest = journeys.find((j) => j.key === "guest-landing");
  const loginStep = guest?.steps?.find((s) => s.label === "Reach login page");
  const loginPageOk = Boolean(loginStep?.ok);

  const googleRes = await probeUrl(`${BASE}/api/auth/google`, [302, 301, 303, 307, 503]);
  const googleConfigured = [302, 301, 303, 307].includes(googleRes.statusCode);

  return {
    login_page: { configured: loginPageOk },
    magic_link: { configured: null },
    google_oauth: { configured: googleConfigured }
  };
}

function mergeLoginHealth(fromApi, fallback) {
  const pick = (v, fb) => (v === undefined || v === null ? fb : v);
  return {
    login_page: { configured: pick(fromApi?.login_page?.configured, fallback.login_page.configured) },
    magic_link: { configured: pick(fromApi?.magic_link?.configured, fallback.magic_link.configured) },
    google_oauth: { configured: pick(fromApi?.google_oauth?.configured, fallback.google_oauth.configured) }
  };
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
        { label: "Load home shell", url: `${BASE}/`, expected: [200, 301, 302] },
        { label: "Reach login page", url: `${BASE}/login.html`, expected: [200] }
      ]
    },
    {
      key: "auth-gate",
      name: "Auth Gate Integrity",
      steps: [
        { label: "Protected /api/news blocks guest", url: `${BASE}/api/news`, expected: [401] },
        { label: "Session probe returns auth state", url: `${BASE}/api/auth/me`, expected: [200, 401] }
      ]
    },
    {
      key: "reader-path",
      name: "Reader Core Journey",
      steps: [
        { label: "Public health endpoint", url: `${BASE}/api/health`, expected: [200] },
        { label: "Intelligence endpoint reachable", url: `${BASE}/api/intelligence`, expected: [200, 401, 503] }
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

function loginHealthToServices(loginHealth) {
  if (!loginHealth) return [];

  const checks = [
    {
      key: "loginPage",
      name: "Login Page Health",
      url: `${BASE}/login.html`,
      configured: loginHealth.login_page?.configured
    },
    {
      key: "magicLink",
      name: "Magic Link Health",
      url: `${BASE}/api/auth/login`,
      configured: loginHealth.magic_link?.configured
    },
    {
      key: "googleOAuth",
      name: "Google OAuth Health",
      url: `${BASE}/api/auth/google`,
      configured: loginHealth.google_oauth?.configured
    }
  ];

  return checks.map((check) => {
    let state;
    let statusCode;
    if (check.configured === true) {
      state = "operational";
      statusCode = 200;
    } else if (check.configured === false) {
      state = "outage";
      statusCode = 503;
    } else {
      state = "degraded";
      statusCode = 102;
    }
    return {
      key: check.key,
      name: check.name,
      url: check.url,
      state,
      statusCode,
      latencyMs: null
    };
  });
}

async function main() {
  const checkedAt = new Date().toISOString();
  const baseResults = await Promise.all(services.map((svc) => probe(svc)));
  const healthSnapshot = await fetchHealthSnapshot();
  const userJourneys = await probeUserJourneys();
  const inferredLoginHealth = await inferLoginHealthFallback(userJourneys);
  const loginHealth = mergeLoginHealth(healthSnapshot?.loginHealth, inferredLoginHealth);
  const loginHealthServices = loginHealthToServices(loginHealth);
  const results = [...baseResults, ...loginHealthServices];
  const overall = aggregateOverall(baseResults);
  const latest = {
    checkedAt,
    overall,
    region: "github-actions",
    services: results,
    loginHealth,
    userJourneys
  };

  let history = { runs: [] };
  try {
    history = JSON.parse(await readFile(OUTPUT_HISTORY, "utf8"));
  } catch {
    history = { runs: [] };
  }
  history.runs = (history.runs || []).map((run) => {
    const { aiRouter, ...safeRun } = run || {};
    return safeRun;
  });
  history.runs.push(latest);
  history.runs = history.runs.slice(-HISTORY_LIMIT);

  // Auto-incident detection: open a new incident if we just flipped to outage/degraded
  let incidents = { items: [] };
  try {
    incidents = JSON.parse(await readFile(OUTPUT_INCIDENTS, "utf8"));
  } catch {
    incidents = { items: [] };
  }
  const prevOverall = history.runs.at(-2)?.overall ?? "operational";
  const isNewOutage = overall !== "operational" && prevOverall === "operational";
  const isResolved = overall === "operational" && prevOverall !== "operational";
  if (isNewOutage) {
    incidents.items.unshift({
      id: `auto-${Date.now()}`,
      title: overall === "outage" ? "Service Outage Detected" : "Service Degradation Detected",
      state: overall,
      startedAt: checkedAt,
      resolvedAt: null,
      affectedServices: baseResults.filter((r) => r.state !== "operational").map((r) => r.name),
      updates: [{ at: checkedAt, message: `Automatic detection: overall status flipped to ${overall}.` }]
    });
    console.log(`[INCIDENT OPENED] overall=${overall}`);
  }
  if (isResolved) {
    const open = incidents.items.find((i) => !i.resolvedAt);
    if (open) {
      open.resolvedAt = checkedAt;
      open.state = "resolved";
      open.updates.push({ at: checkedAt, message: "Automatic resolution: all services operational." });
      console.log(`[INCIDENT RESOLVED] id=${open.id}`);
    }
  }

  await writeFile(OUTPUT_LATEST, `${JSON.stringify(latest, null, 2)}\n`, "utf8");
  await writeFile(OUTPUT_HISTORY, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  await writeFile(OUTPUT_INCIDENTS, `${JSON.stringify(incidents, null, 2)}\n`, "utf8");
  console.log(`updated status at ${checkedAt} (${overall})`);

  // Exit with code 1 to fail the workflow step visibly on outage
  if (overall === "outage") {
    console.error(`[ALERT] briefpknews is DOWN — ${results.filter(r=>r.state==="outage").map(r=>r.name).join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
