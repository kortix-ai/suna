#!/usr/bin/env bash
# One-time human step: create the Ed25519 key that signs capture-update.json.
#
#   apps/capture/scripts/create_update_key.sh            # first key
#   apps/capture/scripts/create_update_key.sh --rotate   # step 1 of a rotation: trust a second key
#   apps/capture/scripts/create_update_key.sh --promote  # step 2: sign with the second key, drop the first
#
# - Stores the private key (PKCS#8 PEM) in AWS Secrets Manager kortix-ci-env as
#   CAPTURE_UPDATE_SIGNING_KEY (us-east-2). The only reader is .github/actions/aws-env.
#   --rotate stores the new key as CAPTURE_UPDATE_SIGNING_KEY_NEXT; releases keep
#   signing with the first key until every device runs a build that trusts both.
# - Writes the public key to apps/capture/update-public-key.txt. Commit that file:
#   the builds compile it in (KORTIX_CAPTURE_UPDATE_PUBLIC_KEY, comma separated when
#   two keys are trusted). Public, safe to commit.
# Needs: openssl, aws (admin on kortix-ci-env), jq. The private key never touches the repo.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pubfile="$here/../update-public-key.txt"
region=us-east-2; blob=kortix-ci-env
rotate=0; promote=0
[ "${1:-}" = "--rotate" ] && rotate=1
[ "${1:-}" = "--promote" ] && promote=1
for c in openssl aws jq; do command -v "$c" > /dev/null || { echo "$c is required" >&2; exit 1; }; done

current="$(aws secretsmanager get-secret-value --region "$region" --secret-id "$blob" --query SecretString --output text)"
if [ "$promote" = 1 ]; then
  [ "$(jq -r 'has("CAPTURE_UPDATE_SIGNING_KEY_NEXT")' <<< "$current")" = "true" ] || { echo "no CAPTURE_UPDATE_SIGNING_KEY_NEXT: run --rotate first" >&2; exit 1; }
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  jq '. + {CAPTURE_UPDATE_SIGNING_KEY: .CAPTURE_UPDATE_SIGNING_KEY_NEXT} | del(.CAPTURE_UPDATE_SIGNING_KEY_NEXT)' <<< "$current" > "$tmp/blob.json"
  aws secretsmanager put-secret-value --region "$region" --secret-id "$blob" --secret-string "file://$tmp/blob.json" > /dev/null
  cut -d, -f2 "$pubfile" > "$pubfile.new" && mv "$pubfile.new" "$pubfile"
  echo "Releases now sign with the new key. $pubfile keeps only its public key: commit it."
  exit 0
fi
if [ "$(jq -r 'has("CAPTURE_UPDATE_SIGNING_KEY")' <<< "$current")" = "true" ] && [ "$rotate" = 0 ]; then
  echo "CAPTURE_UPDATE_SIGNING_KEY already exists in $blob. Use --rotate to replace it (read the runbook first)." >&2
  exit 1
fi
if [ "$rotate" = 1 ] && [ ! -s "$pubfile" ]; then echo "--rotate needs the current $pubfile" >&2; exit 1; fi

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
openssl genpkey -algorithm ed25519 -out "$tmp/key.pem"
pub="$(openssl pkey -in "$tmp/key.pem" -pubout -outform DER | tail -c 32 | base64 | tr -d '\n')"

name=CAPTURE_UPDATE_SIGNING_KEY; [ "$rotate" = 1 ] && name=CAPTURE_UPDATE_SIGNING_KEY_NEXT
jq --arg n "$name" --arg k "$(cat "$tmp/key.pem")" '. + {($n): $k}' <<< "$current" > "$tmp/blob.json"
aws secretsmanager put-secret-value --region "$region" --secret-id "$blob" --secret-string "file://$tmp/blob.json" > /dev/null
if [ "$rotate" = 1 ]; then
  # Old key first, new key second: builds trust both until --promote drops the old one.
  printf '%s,%s\n' "$(tr -d '\n' < "$pubfile")" "$pub" > "$pubfile"
else
  printf '%s\n' "$pub" > "$pubfile"
fi
echo "Private key stored in $blob as $name."
echo "Public key written to $pubfile: commit it."
cat "$pubfile"
