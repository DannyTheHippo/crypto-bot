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

# Perp lane (Push 3 P3): own Postgres (postgres-perp, profile "perp") — dump it too when it's
# actually running. Silent skip when absent: the perp profile is optional/gated, and a bare
# `docker compose up -d` (no --profile perp) never creates the container, so an unconditional
# `exec` here would fail every default-profile run.
PERP_CID="$(docker compose --project-directory "$REPO_ROOT" --profile perp ps -q postgres-perp)"
if [ -n "$PERP_CID" ]; then
  PERP_OUT="$BACKUP_DIR/cryptobot-perp-$STAMP.sql.gz"
  docker compose --project-directory "$REPO_ROOT" --profile perp exec -T postgres-perp pg_dump -U cryptobot cryptobot | gzip > "$PERP_OUT"
  ls -1t "$BACKUP_DIR"/cryptobot-perp-*.sql.gz 2>/dev/null | tail -n +15 | while IFS= read -r f; do
    rm -f "$f"
  done
  echo "backup written: $PERP_OUT ($(du -h "$PERP_OUT" | cut -f1))"
fi
