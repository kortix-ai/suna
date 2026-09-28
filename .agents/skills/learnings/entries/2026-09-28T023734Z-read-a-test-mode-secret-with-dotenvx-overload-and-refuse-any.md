---
recorded: 2026-09-28T02:37:34Z
incident_date: 2026-09-28
---
# Read a test-mode secret with dotenvx --overload and refuse any live key in demo tooling

**Rule:** Read a secret from a dotenvx file with `dotenvx get KEY --overload -f <file>` whenever the caller's environment may already set `KEY`. A script that must only touch Stripe test mode checks the key prefix (`sk_test_`/`rk_test_`, `whsec_`) and refuses anything else before the first request.

**Trigger surface:** Writing demo, seed, or test tooling that reads a secret from `apps/api/.env.*` and may run inside a Kortix session sandbox, CI, or a developer shell where the same variable name is already exported.

**Incident:** 2026-09-28. `preview-subscribe.sh` (#7879) read `STRIPE_SECRET_KEY` with plain `dotenvx get`, which returns an already-set environment variable before decrypting the file. In a factory worker sandbox the project exports a LIVE `STRIPE_SECRET_KEY`, so the demo subscribe step called Stripe with a live key. Stripe answered `404 resource_missing` (test-mode PaymentIntent, live key); no object was created and nothing was charged.

**Enforcement:** `preview-subscribe.sh` and `preview-subscribe.ts` refuse a non-test key before any request; `PREVIEW_STRIPE_TEST_SECRET_KEY` / `PREVIEW_STRIPE_TEST_WEBHOOK_SECRET` take precedence. No repo-wide lint for plain `dotenvx get` yet: none yet: a check that flags `dotenvx get` without `--overload` in scripts.
