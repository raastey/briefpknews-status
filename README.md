# BriefPK News Status

Independent status page for BriefPK News, designed to match the BriefPK visual system and hosted on GitHub Pages.

## What this includes

- Branded status dashboard (`index.html`, `styles.css`, `app.js`)
- Component-level health display
- 24h uptime bars per component
- Incident timeline from `status-data/incidents.json`
- Synthetic monitoring workflow every 5 minutes

## Monitored endpoints

- Main website
- Public health API
- Auth endpoint
- News API
- Intelligence API
- Pakistan macro insight API

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
