#!/usr/bin/env bash
# Quarterly restore drill (RUNBOOK §4): a backup you haven't restored is a
# rumour. Restores the latest nightly D1 export into a throwaway database,
# sanity-checks row counts, and loads a ProfileDO NDJSON dump into a
# server-side scratch DO (drill: prefix — can never touch a real profile).
#
# Usage: scripts/restore-drill.sh [YYYY-MM-DD] [uid]
#   date defaults to today (UTC); uid defaults to the migrated main user.
set -euo pipefail
cd "$(dirname "$0")/.."

DATE="${1:-$(date -u +%F)}"
UID_ARG="${2:-apple:000568.f45981241ef64b63b087507e6430278f.2254}"
BASE="${WIRE_BASE:-https://wire.databased.business}"

echo "== Restore drill for ${DATE} =="

# --- 1. D1 -------------------------------------------------------------------
echo "-- D1: fetching d1/${DATE}.sql.gz"
npx wrangler r2 object get "wire-backups/d1/${DATE}.sql.gz" --file=/tmp/drill-d1.sql.gz --remote
gunzip -f /tmp/drill-d1.sql.gz

echo "-- D1: restoring into throwaway DB wire-restore-test"
npx wrangler d1 create wire-restore-test >/dev/null 2>&1 || true
npx wrangler d1 execute wire-restore-test --remote --file=/tmp/drill-d1.sql -y >/dev/null

fail=0
for t in read_ledger users; do
  prod=$(npx wrangler d1 execute wire --remote --json --command "SELECT COUNT(*) AS n FROM $t" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['results'][0]['n'])")
  rest=$(npx wrangler d1 execute wire-restore-test --remote --json --command "SELECT COUNT(*) AS n FROM $t" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['results'][0]['n'])")
  echo "   $t: prod=$prod restored=$rest"
  if [ "$prod" -gt 0 ] && [ "$rest" -eq 0 ]; then
    echo "   !! $t restored EMPTY while prod has rows"
    fail=1
  fi
done

echo "-- D1: dropping throwaway DB"
npx wrangler d1 delete wire-restore-test -y >/dev/null

# --- 2. ProfileDO ------------------------------------------------------------
SECRET="${INGEST_SECRET:-$(grep -m1 INGEST_SECRET .dev.vars | sed 's/.*= *"\(.*\)"/\1/')}"
SAFE_UID=$(printf '%s' "$UID_ARG" | tr -c 'A-Za-z0-9._:-' '_')
echo "-- DO: fetching do/ProfileDO/${SAFE_UID}/${DATE}.ndjson.gz"
npx wrangler r2 object get "wire-backups/do/ProfileDO/${SAFE_UID}/${DATE}.ndjson.gz" --file=/tmp/drill-do.ndjson.gz --remote
gunzip -f /tmp/drill-do.ndjson.gz

echo "-- DO: importing into scratch DO drill:${DATE}"
python3 - "$BASE" "$SECRET" "$DATE" <<'EOF'
import json, sys, urllib.request
base, secret, date = sys.argv[1:4]
ndjson = open("/tmp/drill-do.ndjson").read()
req = urllib.request.Request(
    f"{base}/api/admin/restore-drill",
    data=json.dumps({"target": date, "ndjson": ndjson}).encode(),
    headers={"content-type": "application/json", "authorization": f"Bearer {secret}"},
    method="POST",
)
body = json.load(urllib.request.urlopen(req, timeout=30))
counts = body["counts"]
print(f"   restored into {body['target']}: {counts}")
if counts["traits"] == 0 and counts["meta"] == 0:
    print("   !! ProfileDO dump restored EMPTY")
    sys.exit(1)
EOF

if [ "$fail" -ne 0 ]; then
  echo "== DRILL FAILED — see mismatches above =="
  exit 1
fi
echo "== Drill complete: backups are restorable =="
