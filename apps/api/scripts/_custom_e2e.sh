#!/usr/bin/env bash
# Full Kortix CUSTOM-TEMPLATE flow e2e (prod Platinum + local comp):
# register custom template -> create session(provider=platinum) which BUILDS it on
# Platinum + spawns a sandbox -> verify it's the custom base + daemon serving -> cleanup.
set -uo pipefail
cd /Users/vukasinkubet/dev/comp/apps/api
PID="${PID:-9ebbfc1f-8c57-4882-be8d-db3058c5e7a1}"
PK=$(grep '^PLATINUM_API_KEY=' .env.local|head -1|cut -d= -f2-)
PURL=$(grep '^PLATINUM_API_URL=' .env.local|head -1|cut -d= -f2-); PURL="${PURL:-https://api.platinum.dev}"
COMP=http://localhost:8008
SLUG="e2e-custom-$(date +%s)"
psql(){ docker exec supabase_db_kortix-local psql -U postgres -tA -c "$1" 2>/dev/null; }

echo "=== mint JWT ==="
MINT_EMAIL='vukasinkubet@gmail.com' bun run scripts/_mint_jwt.ts >/dev/null 2>&1
JWT=$(cat /tmp/userjwt 2>/dev/null); [ -z "$JWT" ] && { echo "FATAL: no JWT"; exit 1; }; echo "  jwt ok (${#JWT} chars)"

echo "=== 1. register custom template slug=$SLUG (FROM python:3.12-slim + kortix runtime) ==="
reg=$(curl -s -m20 "$COMP/v1/projects/$PID/sandbox-templates" -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' -d "{\"slug\":\"$SLUG\",\"name\":\"e2e custom\",\"image\":\"python:3.12-slim\",\"cpu\":2,\"memory_gb\":4,\"disk_gb\":10}")
echo "  -> $(echo "$reg"|head -c 240)"
TID=$(echo "$reg"|python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('template_id') or d.get('templateId') or d.get('id') or '')" 2>/dev/null)
echo "  template_id=$TID"

echo "=== 2. create session on $SLUG, provider=platinum (triggers build+spawn ON PLATINUM) ==="
ses=$(curl -s -m30 "$COMP/v1/projects/$PID/sessions" -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' -d "{\"sandbox_slug\":\"$SLUG\",\"provider\":\"platinum\",\"branch_already_created\":false}")
echo "  -> $(echo "$ses"|head -c 240)"
SID=$(echo "$ses"|python3 -c "import sys,json;print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)
echo "  session_id=$SID"

echo "=== 3. poll session_sandboxes -> active (build+spawn, up to ~8m) ==="
ext=""; st=""
for i in $(seq 1 120); do
  row=$(psql "select external_id||'|'||status from kortix.session_sandboxes where session_id='$SID' order by created_at desc limit 1;")
  ext=${row%%|*}; st=${row##*|}
  [ $((i%4)) -eq 0 ] && echo "    [$((i*4))s] status=${st:-?} ext=${ext:-?}"
  [ "$st" = active ] && [ -n "$ext" ] && { echo "    ACTIVE ~$((i*4))s ext=$ext"; break; }
  case "$st" in error|failed) echo "    PROVISION $st"; break;; esac
  sleep 4
done
prov=$(psql "select provider from kortix.session_sandboxes where session_id='$SID' order by created_at desc limit 1;")
echo "  session_sandbox provider=$prov"

echo "=== 4. did the custom template build ON PLATINUM? ==="
curl -s -m12 "$PURL/v1/templates" -H "Authorization: Bearer $PK"|python3 -c "import sys,json;d=json.load(sys.stdin);t=d if isinstance(d,list) else d.get('templates',[]);m=[(x.get('name'),x.get('state')) for x in t if '$SLUG' in str(x.get('name',''))];print('   platinum templates matching slug:', m or 'NONE')"

if [ "$st" = active ] && [ -n "$ext" ]; then
  echo "=== 5. runtimeReady via comp FE proxy ==="
  for i in $(seq 1 45); do h=$(curl -s -m5 "$COMP/v1/p/$ext/8000/kortix/health" -H "Authorization: Bearer $JWT" 2>/dev/null); echo "$h"|grep -q '"runtimeReady":true' && { echo "    runtimeReady ~$((i*2))s"; break; }; [ $((i%10)) -eq 0 ] && echo "    waiting health ~$((i*2))s: $(echo "$h"|head -c 80)"; sleep 2; done
  echo "=== 6. in-guest proof: custom python base + kortix daemon serving :8000 ==="
  cat > /tmp/eb1.json <<'EJSON'
{"cmd":["sh","-c","python3 --version 2>&1; grep PRETTY /etc/os-release 2>/dev/null; ss -ltn 2>/dev/null | grep -q :8000 && echo PORT8000_BOUND || echo PORT_DEAD"],"timeout_ms":12000}
EJSON
  curl -s -m20 "$PURL/v1/sandboxes/$ext/exec" -H "Authorization: Bearer $PK" -H 'Content-Type: application/json' --data @/tmp/eb1.json | python3 -c "import sys,json;r=json.load(sys.stdin).get('result',{});print('   stdout:',repr(r.get('stdout','')),'exit:',r.get('exitCode'))" 2>/dev/null
  echo "=== 7. cleanup sandbox ==="
  curl -s -m15 -o /dev/null -w "  del sandbox %{http_code}\n" -X DELETE "$PURL/v1/sandboxes/$ext" -H "Authorization: Bearer $PK"
fi

psql "delete from kortix.session_sandboxes where session_id='$SID';" >/dev/null 2>&1
echo "=== 8. cleanup template (comp + platinum) ==="
[ -n "$TID" ] && curl -s -m15 -o /dev/null -w "  comp del template %{http_code}\n" -X DELETE "$COMP/v1/projects/$PID/sandbox-templates/$TID" -H "Authorization: Bearer $JWT"
ptpl=$(curl -s -m12 "$PURL/v1/templates" -H "Authorization: Bearer $PK"|python3 -c "import sys,json;d=json.load(sys.stdin);t=d if isinstance(d,list) else d.get('templates',[]);print(next((x.get('id') for x in t if '$SLUG' in str(x.get('name',''))),''))" 2>/dev/null)
[ -n "$ptpl" ] && curl -s -m20 -o /dev/null -w "  platinum del template %{http_code}\n" -X DELETE "$PURL/v1/templates/$ptpl" -H "Authorization: Bearer $PK"
echo DONE
