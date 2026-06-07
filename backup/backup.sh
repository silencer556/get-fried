#!/bin/sh
# Backs up Get Fried to Backblaze B2: a consistent SQLite snapshot + the uploaded
# photos. Both live in the same volume, mounted read-only at /data.
set -eu
. /etc/backup.env 2>/dev/null || true

: "${B2_BUCKET:?B2_BUCKET not set}"

APP="get_fried"
TS="$(date -u +%F)"                 # YYYY-MM-DD (one snapshot per day)
DB_SRC="/data/airfry.db"
WORK="$(mktemp -d)"
DB_OUT="${WORK}/${APP}_${TS}.db"
trap 'rm -rf "$WORK"' EXIT

log() { echo "[backup] $(date -u +%FT%TZ) $*"; }
log "starting -> b2:${B2_BUCKET}/backups/"

# 1) SQLite hot backup. ".backup" is consistent even under live writes and folds
#    the WAL into a single self-contained file (no -wal/-shm needed to restore).
if [ -f "$DB_SRC" ]; then
  sqlite3 "$DB_SRC" ".backup '${DB_OUT}'"
  rclone copyto "$DB_OUT" "b2:${B2_BUCKET}/backups/db/${APP}_${TS}.db"
  log "db ok ($(du -h "$DB_OUT" | cut -f1)) -> backups/db/${APP}_${TS}.db"
else
  log "WARNING: ${DB_SRC} not found — skipping db"
fi

# 2) Photos. Filenames are immutable UUIDs, so an additive copy de-dupes: only new
#    photos upload, and photos referenced by older db snapshots are kept for restore.
if [ -d /data/uploads ]; then
  rclone copy /data/uploads "b2:${B2_BUCKET}/backups/uploads/" --transfers 4
  log "uploads ok ($(find /data/uploads -type f | wc -l) files present) -> backups/uploads/"
else
  log "no uploads/ dir — skipping photos"
fi

# 3) Optional retention: prune old db snapshots (uploads are kept since they de-dupe).
if [ -n "${RETENTION_DAYS:-}" ] && [ "${RETENTION_DAYS}" -gt 0 ] 2>/dev/null; then
  rclone delete "b2:${B2_BUCKET}/backups/db/" --min-age "${RETENTION_DAYS}d" || true
  log "pruned db snapshots older than ${RETENTION_DAYS}d"
fi

log "done"
