# Rolling out the auth send-email hook (dev → staging → prod)

`EMAIL_URL` unified email delivery in the API (PR #6585). Auth email — magic
link, signup confirmation, password recovery, email change — only joins that
path once **Supabase Auth is told to stop sending it itself** and post each
message to `POST /v1/webhooks/auth/send-email` instead.

That switch is per-environment configuration, not code, and it is NOT applied by
deploying. This runbook applies it.

## What is true before you start

- **Product email already works and is untouched.** Invites and project
  access-requests send through the pre-`EMAIL_URL` chain (`AWS_SES_*` →
  `RESEND_API_KEY`), which is set in `kortix-{dev,staging,prod}-env`.
- **Auth email is still sent by Supabase**, using whatever that project's Auth
  settings say (built-in service or custom SMTP).
- `AUTH_EMAIL_HOOK_SECRET` is unset in all three environments, so the route
  answers `503 {"error":"Auth email hook is not configured"}`. It is inert, not
  broken.

## Order matters — read this before touching anything

The hook makes GoTrue depend on `kortix-api` for every auth email. Enable it in
the wrong order and signup/reset mail stops for real users:

1. The API carrying `POST /v1/webhooks/auth/send-email` **must already be
   deployed** to that environment. Verify with the probe in step 0.
2. `AUTH_EMAIL_HOOK_SECRET` must be live in the running task **before** the hook
   is enabled in Supabase. A hook enabled against a `503` endpoint means no auth
   email at all.
3. Only then flip `hook_send_email_enabled`.

Rollback is one call — set `hook_send_email_enabled=false` (step 4) — and
Supabase resumes sending auth email itself immediately.

## Step 0 — prove the route is deployed

```sh
# Expect 503 (route exists, secret not set yet). 404 = the API predates the
# route; do NOT continue.
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://dev-api.kortix.com/v1/webhooks/auth/send-email \
  -H 'content-type: application/json' -d '{}'
```

Per environment: `dev-api.kortix.com`, `staging-api.kortix.com`, `api.kortix.com`.

## Step 1 — put the secret in the environment's blob

Deployed env is ONE JSON blob in AWS Secrets Manager (`kortix-<env>-env`),
delivered to the ECS task as `KORTIX_ENV_JSON`. Git `apps/api/.env.<env>` is for
local runs only and syncs nowhere. Requires an MFA-authenticated session
(`kortix-mfa-required` denies otherwise).

```sh
ENVNAME=dev                      # dev | staging | prod
SECRET="kortix-${ENVNAME}-env"
REGION=us-west-2                 # prod is eu-west-2
HOOK_SECRET="v1,whsec_$(openssl rand -base64 32)"   # keep it, step 3 needs it

aws secretsmanager get-secret-value --secret-id "$SECRET" --region "$REGION" \
  --query SecretString --output text > /tmp/env.json
jq --arg s "$HOOK_SECRET" '. + {AUTH_EMAIL_HOOK_SECRET: $s}' /tmp/env.json > /tmp/env.new.json
jq -e 'has("AUTH_EMAIL_HOOK_SECRET")' /tmp/env.new.json >/dev/null   # sanity
aws secretsmanager put-secret-value --secret-id "$SECRET" --region "$REGION" \
  --secret-string file:///tmp/env.new.json
rm -f /tmp/env.json /tmp/env.new.json
```

`put-secret-value` preserves every other key and makes the old version
`AWSPREVIOUS`, so this is reversible.

Optional, same edit: set `EMAIL_FROM` (e.g. `Kortix <noreply@kortix.com>`).
Without it the sender falls back to `MAILTRAP_FROM_EMAIL` / `MAILTRAP_FROM_NAME`,
which already default to `noreply@kortix.com` / `Kortix`.

## Step 2 — restart the API so the task reads the new blob

ECS resolves `secrets` at task start; an in-place secret edit does nothing until
a new task rolls.

```sh
aws ecs update-service --cluster "kortix-${ENVNAME}" --service "kortix-${ENVNAME}" \
  --region "$REGION" --force-new-deployment
aws ecs wait services-stable --cluster "kortix-${ENVNAME}" --service "kortix-${ENVNAME}" --region "$REGION"
```

Prove it landed — the route must now answer `401` (secret present, signature
missing) instead of `503`:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://dev-api.kortix.com/v1/webhooks/auth/send-email \
  -H 'content-type: application/json' -d '{}'
```

## Step 3 — point Supabase Auth at the hook

Project refs (verified 2026-08-19 — prod's `supa.kortix.com` CNAMEs to the
**eu-west-2** project, NOT the us-east-2 migration target):

| env | project ref | API host |
| --- | --- | --- |
| dev | `heprlhlltebrxydgtsjs` | `dev-api.kortix.com` |
| staging | `ujzsbwvurfyeuerxxeaz` | `staging-api.kortix.com` |
| prod | `jbriwassebxdwoieikga` | `api.kortix.com` |

Read the current config first — it tells you what auth email uses TODAY, which
is what you are replacing:

```sh
export SUPABASE_ACCESS_TOKEN=sbp_...        # personal access token
REF=heprlhlltebrxydgtsjs
curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/$REF/config/auth" \
  | jq '{smtp_host, smtp_sender_name, smtp_admin_email, mailer_autoconfirm,
         hook_send_email_enabled, hook_send_email_uri}'
```

Then enable it:

```sh
curl -s -X PATCH -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  "https://api.supabase.com/v1/projects/$REF/config/auth" \
  -d "$(jq -nc --arg uri "https://dev-api.kortix.com/v1/webhooks/auth/send-email" \
                --arg sec "$HOOK_SECRET" \
        '{hook_send_email_enabled:true, hook_send_email_uri:$uri, hook_send_email_secrets:$sec}')" \
  | jq '{hook_send_email_enabled, hook_send_email_uri}'
```

The same three fields exist in the dashboard under Authentication → Hooks →
Send Email, if you prefer clicking.

## Step 4 — verify with a real email, and know the rollback

```sh
# Request a magic link for a mailbox you control.
curl -s -X POST "https://<project-ref>.supabase.co/auth/v1/otp" \
  -H "apikey: <anon key>" -H 'content-type: application/json' \
  -d '{"email":"you@example.com","create_user":false}' -w '\n%{http_code}\n'
```

The mail must arrive with the Kortix template (wordmark, "Sign in to Kortix",
a plain-text part) rather than Supabase's default. If it does not arrive:

```sh
curl -s -X PATCH -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  "https://api.supabase.com/v1/projects/$REF/config/auth" \
  -d '{"hook_send_email_enabled": false}'
```

Supabase resumes sending auth email itself the moment that returns.

## What changes for users

- **Sender.** Auth email starts coming from `EMAIL_FROM` (or
  `noreply@kortix.com`) via SES, instead of the project's current Auth sender.
  Confirm SPF/DKIM covers that address before prod.
- **Templates.** Auth email gets the Kortix shell used by invites, HTML + text.
- **New dependency.** `kortix-api` being down now means auth email is not sent.
  The API answering non-2xx surfaces to the user as a failed sign-in rather than
  a silently missing mail, which is the intended behaviour.
- **Rate limits.** Supabase's own per-hour auth-email cap stops applying;
  delivery is bounded by SES instead.
