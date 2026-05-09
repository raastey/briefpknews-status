# BriefPK News Status

Independent status page for BriefPK News, designed to match the BriefPK visual system and hosted on GitHub Pages.

## What this includes

- Branded status dashboard (`index.html`, `styles.css`, `app.js`)
- Dedicated changelog page (`changelog.html`, `changelog.css`, `changelog.js`)
- Component-level health display
- 24h uptime bars per component
- Incident timeline from `status-data/incidents.json`
- Synthetic monitoring workflow every 5 minutes

## Monitored endpoints

The GitHub Actions workflow probes production `GET` routes (see `scripts/check-status.mjs`), including:

| Key | Surface |
|-----|---------|
| `site` | Main website HTML |
| `health` | `/api/health` |
| `auth` | `/api/auth/me` (expects 200 or 401) |
| `news` | `/api/news` — merged RSS + Google News corpus |
| `search` | `/api/search` — headline search over the same merged pool + supplemental Google News per query |
| `intel` | `/api/intelligence` — Brief’s Pulse (uses merged headlines + AI) |
| `market`, `map`, `macro`, `macroInsight`, `security`, `securityInsight` | Domain feeds |

All authenticated APIs may return **401** when the probe has no session cookie; that still counts as “endpoint reachable.”

## Login health telemetry

`/api/health` exposes `login_health` when the main app is on the latest deploy. The status pipeline merges that payload with **synthetic fallbacks** so the dashboard stays usable even before deploy:

- `login_page`: from monitoring journeys (`Reach login page` step)
- `google_oauth`: from probing `/api/auth/google` (redirect vs `503`)
- `magic_link`: only reliable once `/api/health` includes `login_health.magic_link` (`RESEND_API_KEY`). Until then it appears as **Unknown**, not “Unavailable”.

Schema when fully wired:

- `login_page.configured`: bundle ships `public/login.html`
- `magic_link.configured`: `RESEND_API_KEY` is present
- `google_oauth.configured`: Google OAuth credentials are present

The **Login Health** panel and the three supplementary service rows reflect merged telemetry plus explicit Unknown states where probes cannot infer config safely.

Overall uptime banner aggregates **core API probes only**; supplementary login rows do not flip the global outage state.

## Product note (news stack)

The dashboard news rail, Pulse intelligence, and `/api/search` share one server-side **merged article pool** (Pakistani RSS feeds plus international outlets via Google News `Pakistan site:` scopes). The news endpoint returns up to **250** rows per response; Pulse samples headline titles from the full merged list.

## Incident management

Edit `status-data/incidents.json`:

```json
{
  "items": [
    {
      "title": "Partial outage in intelligence API",
      "detail": "OpenRouter saturation is causing elevated latency for some users.",
      "status": "investigating",
      "updatedAt": "2026-04-29T02:00:00.000Z"
    }
  ]
}
```

## Changelog workflow

- Public changelog route: `./changelog.html`
- Data source: `status-data/changelog.json`
- To publish a new release note:
  1. Append an entry object to `entries` (newest-first preferred for editing convenience).
  2. Bump `lastPublished`.
  3. Commit and deploy via GitHub Pages.

## GitHub Pages setup

1. Go to repository **Settings -> Pages**.
2. Source: **Deploy from a branch**.
3. Branch: **main** / **root**.
4. Save.

The page will be available at:

`https://raastey.github.io/briefpknews-status/`

## Local preview

Open `index.html` in any static file server (or directly in browser).  
To run one monitor cycle locally:

```bash
node scripts/check-status.mjs
```
