# 🍟 Air Fry Timing

A searchable, filterable, taggable database of air-fryer timings, with built-in
step-aware timers. Runs as a PWA (installable on Android/iOS/desktop) backed by a
small Node + SQLite server in a single Docker container.

## Status — Phase 1 (MVP)

- ✅ Entries: name, brand, category, temp/unit, preheat, servings note, notes, rating, appliance
- ✅ **Steps** model — a single time, or multiple steps with flip/shake/toss alerts at any point (not just 50%) and optional per-step temp
- ✅ Tags (taggable) + search across name/brand/notes/tags + category/tag filters
- ✅ Photo upload
- ✅ Editor / viewer roles (viewers can browse **and run timers**, but not edit)
- ✅ Client-side step-aware timer: countdown, beeps, vibration, screen wake-lock
- ✅ Docker + SQLite on a single volume; seeded with one example entry

### Planned

- **Phase 2:** server-driven Web Push so timers alert when the phone is
  backgrounded/locked; PWA offline app-shell; iOS "Add to Home Screen" onboarding.
- **Phase 3:** ratings/last-cooked sorting, spreadsheet (CSV/XLSX) import, backup/export.

## Run locally (no Docker)

```bash
npm install
npm start
# open http://localhost:3000
```

Default passwords are `editor` and `viewer` (override with env vars below).

## Run with Docker

```bash
docker compose up --build
# open http://localhost:3000
```

Set real secrets first (e.g. in a `.env` file next to `docker-compose.yml`):

```
EDITOR_PASSWORD=...
VIEWER_PASSWORD=...
SESSION_SECRET=<long random string>
```

All data (SQLite DB + photos) lives in the `airfry-data` volume — back it up by
copying that volume, or point `DATA_DIR` at a host folder.

## Exposing over HTTPS (for PWA install + background push)

Service workers and Web Push require HTTPS. Easiest path: **Cloudflare Tunnel**.

1. Create a tunnel in the Cloudflare Zero Trust dashboard, route a hostname
   (e.g. `airfry.example.com`) to `http://app:3000`.
2. Put the tunnel token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN` and uncomment the
   `cloudflared` service in `docker-compose.yml`.
3. Add a **Cloudflare Access** policy scoped to your and your wife's emails so the
   app isn't publicly open.

## Project layout

```
src/server.js   Express API + static hosting
src/db.js       SQLite schema + seed
src/auth.js     Password → role, signed cookie
public/         PWA (index.html, app.js, styles.css, sw.js, manifest.json)
```
