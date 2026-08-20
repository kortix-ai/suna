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

**A bare enable PATCH CLEARS the project's custom SMTP settings.** Verified on
dev 2026-08-19: patching only the three `hook_send_email_*` fields left
`smtp_host` / `smtp_port` / `smtp_user` / `smtp_admin_email` /
`smtp_sender_name` all `null`. With the hook on that changes nothing — GoTrue
no longer uses SMTP — but it silently removes the thing you would fall back TO,
so a later `hook_send_email_enabled=false` lands on Supabase's built-in sender
and its much lower rate limit instead of Resend.

Send both halves in ONE patch so the fallback survives. `smtp_pass` for the
Resend relay is that environment's `RESEND_API_KEY` (username is literally
`resend`); read it from the env blob rather than retyping it:


```sh
RESEND="$(aws secretsmanager get-secret-value --secret-id "kortix-${ENVNAME}-env" \
  --region "$REGION" --query SecretString --output text | jq -r .RESEND_API_KEY)"

curl -s -X PATCH -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  "https://api.supabase.com/v1/projects/$REF/config/auth" \
  -d "$(jq -nc --arg uri "https://dev-api.kortix.com/v1/webhooks/auth/send-email" \
                --arg sec "$HOOK_SECRET" --arg pass "$RESEND" \
        '{hook_send_email_enabled:true, hook_send_email_uri:$uri, hook_send_email_secrets:$sec,
          smtp_host:"smtp.resend.com", smtp_port:"465", smtp_user:"resend", smtp_pass:$pass,
          smtp_admin_email:"noreply@kortix.cloud", smtp_sender_name:"Kortix"}')" >/dev/null

# Read back BOTH halves — the enable and the surviving fallback.
curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/$REF/config/auth" \
  | jq '{hook_send_email_enabled, hook_send_email_uri, smtp_host, smtp_admin_email}'
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

## Why a promote does not undo any of this (verified 2026-08-19)

Three mechanisms could plausibly drop `AUTH_EMAIL_HOOK_SECRET` on the next
release. None of them does:

- **`deploy-staging.yml`'s `sync-secret` job rewrites `kortix-staging-env` on
  every deploy** — but it builds the payload from the EXISTING staging bundle
  (`base="$(aws secretsmanager get-secret-value --secret-id kortix-staging-env …)"`)
  and only overlays a fixed list of data-plane keys. It falls back to
  `kortix-dev-env` solely when the staging secret does not exist yet. Operator-
  added keys survive by design — the job comment says so explicitly.
- **`deploy-prod.yml` never writes the API secret at all.** `sync-web-env.sh`
  writes a DIFFERENT secret, `kortix-<env>-web-env` (the frontend bundle).
- **Terraform only reads it** (`data "aws_secretsmanager_secret"`); there is no
  `aws_secretsmanager_secret_version` resource anywhere in `infra/terraform`.

And each task definition references the blob as a single `KORTIX_ENV_JSON`
secret whose `valueFrom` is the bare secret ARN — no `:AWSCURRENT` stage and no
version-id suffix. Check it for any environment with:

```sh
aws ecs describe-task-definition --task-definition "$(aws ecs describe-services \
  --cluster "kortix-${ENVNAME}" --services "kortix-${ENVNAME}" --region "$REGION" \
  --query 'services[0].taskDefinition' --output text)" --region "$REGION" \
  --query 'taskDefinition.containerDefinitions[0].secrets'
```

Because the ARN carries no version pin, every new task resolves `AWSCURRENT` at start and picks the key up with no
task-def change. That is why staging and prod need no rollout now — their
release performs one anyway.

## Do NOT enable the hook before that environment's release

The secret being present is harmless on its own. Enabling the hook while the
environment still runs an API without the route points GoTrue at a `404` and
auth email stops entirely. Gate it on step 0 returning `401`, never on the
secret being set.
