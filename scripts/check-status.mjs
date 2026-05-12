import { readFile, writeFile } from "node:fs/promises";

const OUTPUT_LATEST = "status-data/latest.json";
const OUTPUT_HISTORY = "status-data/history.json";
const OUTPUT_INCIDENTS = "status-data/incidents.json";
const HISTORY_LIMIT = 2016; // one week at 5-minute intervals
const TIMEOUT_MS = 12000;
const BASE = "https://www.briefpknews.xyz";

/**
 * DOM contract probes: catch client-side regressions that HTTP-level probes
 * cannot see (e.g. an inline `getElementById('x').textContent = …` that throws
 * because `x` was removed from the markup, taking the rest of the script — and
 * thus the auth flow — with it).
 *
 * Each contract lists the IDs that MUST exist for the page's wiring to work.
 * The probe also scans inline <script> blocks for unguarded chained access
 * like `getElementById('foo').something` and fails if `id="foo"` is missing.
 */
const domContracts = [
  {
    key: "loginContract",
    name: "Login Page Wiring",
    url: `${BASE}/login.html`,
    requiredIds: ["googleBtn", "form", "email", "submit", "err", "card"]
  },
  {
    key: "paidAccessContract",
    name: "Paid Access Page Wiring",
    url: `${BASE}/paid-access-coming.html`,
    requiredIds: ["form", "email", "submit", "card"]
  }
];

/**
 * Upstream data-source contracts: catch *feed-side* regressions before they
 * manifest as silent staleness on the dashboard. HTTP-level service probes
 * pass even when the underlying source feed has changed shape or stopped
 * updating, because our app serves the last cached value indefinitely.
 *
 * Each contract probes a third-party feed the dashboard depends on, checks
 * the page still contains the markers our parser relies on, and validates
 * basic freshness from any embedded "as of" stamp.
 */
const dataSourceContracts = [
  {
    key: "psxDpsKse100",
    name: "PSX DPS — KSE-100 Upstream Feed",
    url: "https://dps.psx.com.pk/indices",
    // Match our backend parsePsxIndicesFromHtml: page must contain the
    // indicesTable container, a KSE100 row, and at least 3 numeric data-order
    // attributes (high / low / current / change / % — we treat ≥3 as the
    // floor that lets us still recover a current price).
    requiredMarkers: ["indicesTable", "KSE100"],
    minDataOrderCount: 3,
    // PSX trades Mon–Fri. 72h covers the worst case (Fri close → Mon morning
    // before the next session opens). Anything older signals a stalled feed.
    maxAgeHours: 72,
    fetchHeaders: {
      referer: "https://dps.psx.com.pk/",
      origin: "https://dps.psx.com.pk",
      "user-agent": "briefpk-status/0.1 (+https://status.briefpknews.xyz; contact: team@brief.pk)",
      "cache-control": "no-cache"
    }
  }
];

/**
 * Redirect-target contracts: catch redirect handlers that 302 successfully
 * but to the wrong destination. The canonical example is /api/auth/google:
 * if GOOGLE_CLIENT_ID is unset or wrong, the route can still respond with a
 * non-302 (503 "OAuth not configured" or a 302 to /login.html?error=…), and
 * a pure status-code probe would either flag it as a 503 with no detail or
 * miss the fact that the redirect doesn't actually point at Google.
 *
 * Each contract probes a URL with `redirect: manual`, asserts the response
 * status equals `expectedStatusCode`, and asserts the `Location` header host
 * matches `expectedLocationHost` (a substring check; `expectedLocationHost`
 * can list multiple acceptable hosts).
 */
const redirectContracts = [
  {
    key: "googleOAuthStart",
    name: "Google OAuth Start Route",
    url: `${BASE}/api/auth/google`,
    expectedStatusCode: 302,
    expectedLocationHost: ["accounts.google.com"]
  }
];

/**
 * JSON-asset contracts: catch shape regressions inside a publicly served
 * JSON file that an HTTP 200 probe would miss. An empty array, a missing
 * top-level key, or a malformed structure would all return 200 but render
 * a broken page on the client.
 *
 * Each contract declares: a publicly reachable URL, the top-level keys that
 * must exist, optional minLengths to enforce non-empty collections, and
 * optional nested presence checks.
 */
const jsonAssetContracts = [
  {
    key: "policiesFixture",
    name: "Policy Tracker Fixture Shape",
    url: `${BASE}/data/pakistan-policies.fixture.json`,
    requiredTopLevel: ["policies", "filterPresets", "domains"],
    minLengths: { policies: 1 },
    requiredNested: {
      filterPresets: ["investor", "researcher", "policyPro"]
    }
  }
];

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
  },
  {
    // Policy Tracker page is auth-gated (requirePage middleware) so an
    // unauthenticated probe must see a redirect to /login.html. A 200 here
    // would mean the gate has regressed and an anon user can read the
    // page chrome; a 5xx means the route handler crashed. Both are bad.
    key: "policies",
    name: "Policy Tracker Page",
    url: `${BASE}/policies`,
    expectedStatuses: [301, 302, 303, 307]
  },
  {
    // Public fixture JSON powering the Policy Tracker page. The page is
    // gated but the data is open-source posture by design, so this asset
    // must be reachable without auth. A 404 here means the deploy is
    // missing a file; a 5xx means express.static is misconfigured.
    key: "policiesData",
    name: "Policy Tracker Fixture Data",
    url: `${BASE}/data/pakistan-policies.fixture.json`,
    expectedStatuses: [200]
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
    // Use manual redirect handling so probes can assert on the *first* response
    // status. Default `fetch` follows 30x redirects and reports the final
    // status, which makes auth-gated pages (e.g. /policies → /login.html)
    // appear to return 200 even though the gate is working correctly.
    const res = await fetch(service.url, {
      method: "GET",
      signal: ctrl.signal,
      headers: { "cache-control": "no-cache" },
      redirect: "manual"
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

/** True if the HTML contains an element with this id attribute. */
function htmlHasId(html, id) {
  const re = new RegExp(`\\bid\\s*=\\s*(?:"${id}"|'${id}')`);
  return re.test(html);
}

/** Extract inline <script> bodies (skip external <script src=…>). */
function extractInlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || "";
    if (/\bsrc\s*=/i.test(attrs)) continue;
    out.push(m[2] || "");
  }
  return out;
}

/**
 * Detect unguarded `document.getElementById('foo').something` patterns inside
 * inline scripts (these throw immediately if the element is missing and abort
 * the rest of the script — exactly the auth-flow regression class).
 */
function findChainedGetElementByIdIds(scripts) {
  const ids = new Set();
  const re = /document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*[A-Za-z_$]/g;
  for (const body of scripts) {
    let m;
    while ((m = re.exec(body))) {
      ids.add(m[1]);
    }
  }
  return [...ids];
}

/**
 * Parse a PSX "As of Month DD, YYYY H:MM AM/PM" stamp (which is PKT, UTC+5)
 * into an ISO timestamp. Returns null if the page format has drifted.
 */
function parsePsxAsOf(html) {
  if (!html) return null;
  const m = html.match(/As of\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))/i);
  if (!m) return null;
  // Build the same wall-clock instant in UTC, then subtract 5h to land in true UTC.
  const utcWallClock = new Date(`${m[1]} UTC`);
  if (Number.isNaN(utcWallClock.getTime())) return null;
  return new Date(utcWallClock.getTime() - 5 * 60 * 60 * 1000).toISOString();
}

/**
 * Find the row in PSX `indicesTable` for a given symbol code (e.g. "KSE100")
 * and return the count of numeric `data-order` cells in it. Returns 0 if the
 * row is missing or the markup has drifted.
 */
function countDataOrderCells(html, code) {
  if (!html || !code) return 0;
  const tbody = html.match(/id="indicesTable"[\s\S]*?<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbody) return 0;
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(tbody[1])) !== null) {
    if (new RegExp(`data-code=["']${code}["']`, "i").test(m[1])) {
      const orders = [...m[1].matchAll(/<td[^>]*data-order=["']([^"']+)["'][^>]*>/gi)]
        .map((x) => parseFloat(x[1]))
        .filter((v) => Number.isFinite(v));
      return orders.length;
    }
  }
  return 0;
}

async function probeDataSource(contract) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = Date.now();
  const baseResult = (state, statusCode, latencyMs, reason, extras = {}) => ({
    key: contract.key,
    name: contract.name,
    url: contract.url,
    state,
    statusCode,
    latencyMs,
    dataSource: { reason, ...extras }
  });
  try {
    const res = await fetch(contract.url, {
      method: "GET",
      signal: ctrl.signal,
      headers: contract.fetchHeaders || { "cache-control": "no-cache" }
    });
    const latencyMs = Date.now() - start;
    if (res.status !== 200) {
      return baseResult("outage", res.status, latencyMs, `upstream returned status ${res.status}`);
    }
    const html = await res.text();
    if (html.length < 500) {
      return baseResult("outage", res.status, latencyMs, `upstream body suspiciously small (${html.length} bytes)`);
    }
    const missingMarkers = (contract.requiredMarkers || []).filter((mk) => !html.includes(mk));
    if (missingMarkers.length) {
      return baseResult("outage", res.status, latencyMs,
        `required markers missing from upstream HTML: [${missingMarkers.join(", ")}]`);
    }

    // Symbol-row data-order count check (schema regression detector)
    const symbol = (contract.requiredMarkers || []).find((mk) => /^[A-Z0-9]+$/.test(mk)) || "KSE100";
    const dataOrderCount = countDataOrderCells(html, symbol);
    const cellsOk = dataOrderCount >= (contract.minDataOrderCount || 3);

    // Freshness check (PSX wall-clock → UTC)
    const asOfIso = parsePsxAsOf(html);
    const ageHours = asOfIso ? Math.round((Date.now() - new Date(asOfIso).getTime()) / 3.6e6) : null;
    const freshOk = ageHours === null
      ? true // can't parse the stamp; don't fail on it — markers already passed
      : ageHours <= (contract.maxAgeHours || 72);

    if (!cellsOk && !freshOk) {
      return baseResult("degraded", res.status, latencyMs,
        `schema regression (data-order count ${dataOrderCount}<${contract.minDataOrderCount}) AND stale feed (${ageHours}h old)`,
        { symbol, dataOrderCount, asOfIso, ageHours });
    }
    if (!cellsOk) {
      return baseResult("degraded", res.status, latencyMs,
        `partial schema match: ${symbol} row has ${dataOrderCount} numeric cells (need ${contract.minDataOrderCount})`,
        { symbol, dataOrderCount, asOfIso, ageHours });
    }
    if (!freshOk) {
      return baseResult("degraded", res.status, latencyMs,
        `upstream feed stale: last update ${ageHours}h ago (threshold ${contract.maxAgeHours}h)`,
        { symbol, dataOrderCount, asOfIso, ageHours });
    }
    return baseResult(serviceState(true, latencyMs), res.status, latencyMs,
      `upstream healthy: ${symbol} present with ${dataOrderCount} numeric cells; last update ${ageHours ?? "?"}h ago`,
      { symbol, dataOrderCount, asOfIso, ageHours });
  } catch (err) {
    return baseResult("outage", 0, null, `fetch failed: ${err?.message || "unknown"}`);
  } finally {
    clearTimeout(timer);
  }
}

async function probeRedirectContract(contract) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = Date.now();
  const result = (state, statusCode, latencyMs, reason, extras = {}) => ({
    key: contract.key,
    name: contract.name,
    url: contract.url,
    state,
    statusCode,
    latencyMs,
    redirect: { reason, ...extras }
  });
  try {
    const res = await fetch(contract.url, {
      method: "GET",
      signal: ctrl.signal,
      redirect: "manual",
      headers: { "cache-control": "no-cache" }
    });
    const latencyMs = Date.now() - start;
    const expectedStatus = contract.expectedStatusCode ?? 302;
    if (res.status !== expectedStatus) {
      return result("outage", res.status, latencyMs,
        `expected status ${expectedStatus}, got ${res.status}`);
    }
    const location = res.headers.get("location") || "";
    if (!location) {
      return result("outage", res.status, latencyMs,
        "missing Location header on redirect");
    }
    const acceptable = (contract.expectedLocationHost || []).some((h) =>
      location.includes(h));
    if (!acceptable) {
      // Truncate the location so we never log a full OAuth state in case it
      // shows up in a future redirect target. The host check is what matters.
      const safeSnippet = location.slice(0, 80);
      return result("outage", res.status, latencyMs,
        `Location host not in expected list [${contract.expectedLocationHost.join(", ")}]; got '${safeSnippet}…'`);
    }
    return result(serviceState(true, latencyMs), res.status, latencyMs,
      "redirect target OK", { locationHost: contract.expectedLocationHost.find((h) => location.includes(h)) });
  } catch (err) {
    return result("outage", 0, null, `fetch failed: ${err?.message || "unknown"}`);
  } finally {
    clearTimeout(timer);
  }
}

async function probeJsonAsset(contract) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = Date.now();
  const result = (state, statusCode, latencyMs, reason, extras = {}) => ({
    key: contract.key,
    name: contract.name,
    url: contract.url,
    state,
    statusCode,
    latencyMs,
    asset: { reason, ...extras }
  });
  try {
    const res = await fetch(contract.url, {
      method: "GET",
      signal: ctrl.signal,
      headers: { "cache-control": "no-cache", accept: "application/json" }
    });
    const latencyMs = Date.now() - start;
    if (res.status !== 200) {
      return result("outage", res.status, latencyMs, `non-200 status ${res.status}`);
    }
    let body;
    try {
      body = await res.json();
    } catch (err) {
      return result("outage", res.status, latencyMs, `JSON parse failed: ${err?.message || "unknown"}`);
    }

    const missingTop = (contract.requiredTopLevel || []).filter((k) => body[k] === undefined);
    if (missingTop.length) {
      return result("outage", res.status, latencyMs,
        `missing required top-level keys: [${missingTop.join(", ")}]`);
    }

    const lengthBreaches = [];
    for (const [key, minLen] of Object.entries(contract.minLengths || {})) {
      const v = body[key];
      const len = Array.isArray(v) ? v.length : (v && typeof v === "object" ? Object.keys(v).length : 0);
      if (len < minLen) lengthBreaches.push(`${key} has ${len}, need ${minLen}`);
    }
    if (lengthBreaches.length) {
      return result("degraded", res.status, latencyMs,
        `collection min-length breaches: [${lengthBreaches.join("; ")}]`);
    }

    const missingNested = [];
    for (const [parent, requiredChildren] of Object.entries(contract.requiredNested || {})) {
      const node = body[parent] || {};
      for (const child of requiredChildren) {
        if (node[child] === undefined) missingNested.push(`${parent}.${child}`);
      }
    }
    if (missingNested.length) {
      return result("degraded", res.status, latencyMs,
        `missing required nested keys: [${missingNested.join(", ")}]`);
    }

    return result(serviceState(true, latencyMs), res.status, latencyMs,
      "shape OK", { topLevelKeys: Object.keys(body) });
  } catch (err) {
    return result("outage", 0, null, `fetch failed: ${err?.message || "unknown"}`);
  } finally {
    clearTimeout(timer);
  }
}

async function probeDomContract(contract) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(contract.url, {
      method: "GET",
      signal: ctrl.signal,
      headers: { "cache-control": "no-cache" }
    });
    const latencyMs = Date.now() - start;
    if (res.status !== 200) {
      return {
        key: contract.key,
        name: contract.name,
        url: contract.url,
        state: "outage",
        statusCode: res.status,
        latencyMs,
        contract: { missing: [], chainedMissing: [], reason: `status ${res.status}` }
      };
    }
    const html = await res.text();
    const missing = contract.requiredIds.filter((id) => !htmlHasId(html, id));
    const chainedIds = findChainedGetElementByIdIds(extractInlineScripts(html));
    const chainedMissing = chainedIds.filter((id) => !htmlHasId(html, id));
    const ok = missing.length === 0 && chainedMissing.length === 0;
    const state = ok ? serviceState(true, latencyMs) : "outage";
    return {
      key: contract.key,
      name: contract.name,
      url: contract.url,
      state,
      statusCode: res.status,
      latencyMs,
      contract: {
        missing,
        chainedMissing,
        reason: ok
          ? "all required ids and inline-script references resolved"
          : `missing required ids: [${missing.join(", ")}]; unguarded script references missing in DOM: [${chainedMissing.join(", ")}]`
      }
    };
  } catch (err) {
    return {
      key: contract.key,
      name: contract.name,
      url: contract.url,
      state: "outage",
      statusCode: 0,
      latencyMs: null,
      contract: { missing: [], chainedMissing: [], reason: `fetch failed: ${err?.message || "unknown"}` }
    };
  } finally {
    clearTimeout(timer);
  }
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
  const httpResults = await Promise.all(services.map((svc) => probe(svc)));
  const contractResults = await Promise.all(domContracts.map((c) => probeDomContract(c)));
  const dataSourceResults = await Promise.all(dataSourceContracts.map((c) => probeDataSource(c)));
  const jsonAssetResults = await Promise.all(jsonAssetContracts.map((c) => probeJsonAsset(c)));
  const redirectResults = await Promise.all(redirectContracts.map((c) => probeRedirectContract(c)));
  // Contract, data-source, JSON-asset and redirect-target failures are all
  // treated as core service problems (they directly break user-visible flows
  // like sign-in, the live KSE-100 tile, the Policy Tracker page, or the
  // Google OAuth start route), so they count toward overall state.
  const baseResults = [
    ...httpResults,
    ...contractResults,
    ...dataSourceResults,
    ...jsonAssetResults,
    ...redirectResults
  ];
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
