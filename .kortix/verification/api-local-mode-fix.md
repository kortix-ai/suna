# API local mode fix

## What marks the API as cloud mode

- In `apps/api/src/config.ts:272-276`, missing `KORTIX_URL` is only fatal when `ENV_MODE === 'cloud'`.
- The exact cloud-mode trigger is therefore `ENV_MODE=cloud` in the API process env.
- `KORTIX_BILLING_INTERNAL_ENABLED` can also enable billing-related validation, but it does **not** trigger the `KORTIX_URL Required in cloud mode` error by itself.

## What I found

Current `apps/api/.env` had copied cloud values at the top:

- `ENV_MODE=cloud`
- `KORTIX_BILLING_INTERNAL_ENABLED=true`

But the local env generator `scripts/setup-env.sh` intentionally writes the API env as:

- `ENV_MODE=local`
- `KORTIX_BILLING_INTERNAL_ENABLED=false`
- `ALLOWED_SANDBOX_PROVIDERS=local_docker`

Root `.env` is currently staging-oriented (`ENV_MODE=staging`, `KORTIX_BILLING_INTERNAL_ENABLED=true`), but `scripts/setup-env.sh` overrides those for local API dev. The problem is that `apps/api/.env` had drifted from the generated local values.

## Minimal correct local-only fix

Update `apps/api/.env`:

- `ENV_MODE=cloud` → `ENV_MODE=local`
- `KORTIX_BILLING_INTERNAL_ENABLED=true` → `KORTIX_BILLING_INTERNAL_ENABLED=false`

With `ENV_MODE=local`, `config.ts` auto-derives `KORTIX_URL` to `http://localhost:8008/v1/router` if it is unset, so startup no longer fails on that validation.

## Applied change

I applied the two-line fix above in:

- `/Users/vukasinkubet/dev/comp/apps/api/.env`

## Next step

Restart `apps/api` so it reloads the corrected env file.
