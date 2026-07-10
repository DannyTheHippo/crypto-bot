#!/usr/bin/env sh
# Timestamped pg_dump of the production database into backups/ (gitignored), keeping the newest
# 14 dumps. Motivation: the 2026-07-10 schema-drop incident was unrecoverable because no backup
# existed. Run manually or as a loop §5 duty: `sh scripts/db-backup.sh`.
set -eu
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$REPO_ROOT/backups"
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/cryptobot-$STAMP.sql.gz"
docker compose --project-directory "$REPO_ROOT" exec -T postgres pg_dump -U cryptobot cryptobot | gzip > "$OUT"
# POSIX-portable retention: newest 14 kept, older removed.
ls -1t "$BACKUP_DIR"/cryptobot-*.sql.gz 2>/dev/null | tail -n +15 | while IFS= read -r f; do
  rm -f "$f"
done
echo "backup written: $OUT ($(du -h "$OUT" | cut -f1))"
