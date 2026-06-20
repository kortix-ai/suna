#!/usr/bin/env bash
set -euo pipefail

INSTANCE="${KORTIX_SELF_HOST_INSTANCE:-${KORTIX_E2E_INSTANCE:-default}}"
CONTAINER_NAME="${SUPABASE_DB_CONTAINER:-kortix-${INSTANCE}-supabase-db-1}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "Container '$CONTAINER_NAME' is not running."
  echo "Start the local stack first with: kortix self-host start --local --yes"
  exit 1
fi

echo "Resetting auth users in $CONTAINER_NAME ..."
docker exec "$CONTAINER_NAME" psql -U postgres -d postgres -c "delete from auth.users;"
echo "Done. install-status should now report installed=false."
