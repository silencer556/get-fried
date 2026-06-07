# 🍟 Get Fried

A searchable, filterable, taggable database of air-fryer timings, with built-in
step-aware timers. Runs as a PWA (installable on Android/iOS/desktop) backed by a
small Node + SQLite server in a single Docker container.

> User-facing name is **Get Fried**; the package/folder/volume slug stays
> `air-fry-timing` (changing it would orphan the existing Docker volume).

## Status — Phase 1 (MVP)

- ✅ Entries: name, brand, category, temp/unit, preheat, servings note, notes, rating, appliance
- ✅ **Steps** model — a single time, or multiple steps with flip/shake/toss alerts at any point (not just 50%) and optional per-step temp
- ✅ Tags (taggable) + search across name/brand/notes/tags + category/tag filters
- ✅ Photo upload
- ✅ Editor / viewer roles (viewers can browse **and run timers**, but not edit)
- ✅ Client-side step-aware timer: countdown, beeps, vibration, screen wake-lock
- ✅ Docker + SQLite on a single volume; seeded with one example entry

### Planned

- ✅ **Phase 2a:** deployed on Umbrel via docker-compose (see runbook below).
- **Phase 2b:** Cloudflare Tunnel + Access for an HTTPS URL (enables PWA install + push).
- **Phase 2c:** server-driven Web Push so timers alert when the phone is
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

## Production deployment & update runbook (Umbrel)

The app is hosted on the user's **Umbrel server** (umbrelOS = Debian + Docker),
deployed as plain docker-compose (not yet a formal Umbrel app). Code is delivered
via GitHub; data stays on the server.

- **Repo:** `https://github.com/silencer556/get-fried` (public, no secrets — `.env` is gitignored)
- **On Umbrel:** project lives at `~/get-fried`; reachable at `http://umbrel.local:3000`
- **Dev machine:** Windows PC at `C:\Users\JC\Documents\Air Fry Timing` (Docker is *not* installed there — local testing uses `npm start`)

### The golden rule

**Edit code only on the Windows dev machine. Treat Umbrel as receive-only**
(`git pull`, never edit files there) or `git pull` will hit merge conflicts.

### Update loop

On Windows (develop + test with `npm start`, then):

```bash
git add -A
git commit -m "describe the change"
git push
```

On Umbrel (over SSH — `ssh umbrel@umbrel.local`):

```bash
cd ~/get-fried
git pull
sudo docker compose up -d --build   # --build applies the new code; a plain pull does NOT
```

### Code vs. data (they flow separately)

- **Code** syncs via git: Windows → GitHub → Umbrel.
- **Data** (entries/photos) does **not** sync. Umbrel entries live only in the
  Umbrel `airfry-data` volume; local Windows test entries live only on the PC.
  So you can hack on dev with throwaway entries without touching production.

### Data persistence

Entries/photos survive: `compose restart`, `compose down` + `up`, image rebuilds
(`up -d --build`), and Umbrel reboots. The **only** things that wipe data:
`docker compose down -v` (the `-v` deletes volumes) or deleting the volume manually.
**Never use `-v`** unless you intend to erase everything.

### Offsite backups (Backblaze B2)

A `backup` sidecar (Alpine + rclone + sqlite, defined in `docker-compose.yml`,
built from `backup/`) shares the data volume **read-only** and runs nightly via
BusyBox cron. Each run:

1. Takes a consistent SQLite hot backup (`.backup`, safe under live writes) and
   uploads it datestamped to `b2:<bucket>/backups/db/get_fried_<YYYY-MM-DD>.db`.
2. Copies `/data/uploads/` photos to `b2:<bucket>/backups/uploads/`. Filenames are
   immutable UUIDs, so it's additive/de-duped — only new photos transfer, and photos
   for older db snapshots stay available for restore.
3. Prunes db snapshots older than `BACKUP_RETENTION_DAYS` (uploads are kept).

Setup: create a B2 **bucket-scoped** application key (least privilege; bucket names
are **case-sensitive**), then fill `B2_KEY_ID` / `B2_APP_KEY` / `B2_BUCKET` in `.env`
(see `.env.example` for optional schedule/retention/TZ tuning) and
`docker compose up -d --build`. Leave `B2_BUCKET` blank to disable (jobs no-op).

```bash
# Test it immediately instead of waiting for 2 AM:
BACKUP_RUN_ON_START=1 docker compose up -d --build backup
docker compose logs -f backup        # watch the run

# Restore a snapshot locally:
rclone copyto b2:<bucket>/backups/db/get_fried_<date>.db ./airfry.db
rclone copy   b2:<bucket>/backups/uploads/ ./uploads/
```

> Scripts in `backup/` are LF-only (enforced by `.gitattributes`) — a CRLF shebang
> silently breaks Alpine's shell.

### Handy ops commands (run on Umbrel with `sudo`)

```bash
docker compose ps                 # is it Up?
docker compose logs --tail=50 app # recent logs
docker compose logs -f app        # follow logs (Ctrl-C to exit)
docker compose restart            # restart without rebuild
docker compose up -d --build      # rebuild + restart after a git pull
docker compose down               # stop & remove container (data SAFE — no -v)
```

### First-time deploy (already done — for reference)

```bash
git clone https://github.com/silencer556/get-fried.git
cd get-fried
cat > .env <<EOF
HOST_PORT=3000
EDITOR_PASSWORD=<strong>
VIEWER_PASSWORD=<strong>
SESSION_SECRET=$(openssl rand -hex 32)
CLOUDFLARE_TUNNEL_TOKEN=
EOF
sudo docker compose up -d --build
```

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
