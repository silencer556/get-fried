#!/bin/sh
# Cron jobs do NOT inherit the container's environment, so dump the vars we need
# into a file that backup.sh sources. (Classic crond gotcha.)
set -e

printenv | grep -E '^(B2_|RCLONE_|RETENTION_DAYS|TZ)=' | while read -r line; do
  printf "export %s='%s'\n" "${line%%=*}" "${line#*=}"
done > /etc/backup.env

SCHEDULE="${CRON_SCHEDULE:-0 2 * * *}"
# Send each run's output to crond's stdout/stderr (PID 1) so `docker logs` shows it.
echo "$SCHEDULE /usr/local/bin/backup.sh > /proc/1/fd/1 2>/proc/1/fd/2" > /etc/crontabs/root

echo "[backup] sidecar up — schedule '$SCHEDULE' (TZ=${TZ:-UTC}), bucket '${B2_BUCKET:-<unset>}'"

# Handy for first-run verification: BACKUP_RUN_ON_START=1 runs one backup now.
if [ "${RUN_ON_START:-0}" = "1" ]; then
  echo "[backup] RUN_ON_START set — running an initial backup..."
  /usr/local/bin/backup.sh || echo "[backup] initial backup failed (see above)"
fi

exec crond -f -l 2
