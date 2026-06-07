FROM alpine:3.20

# rclone (B2 upload), sqlite (hot backup), tzdata (local-time cron schedules)
RUN apk add --no-cache rclone sqlite tzdata

COPY backup.sh /usr/local/bin/backup.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/entrypoint.sh

# entrypoint writes the crontab + exports env for cron, then runs crond in foreground
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
