---
recorded: 2026-08-26T22:36:14Z
incident_date: 2026-08-26
commit: 248ebd2b9d
---
# The dev edge WAF 403s any query string carrying a bare `localhost` / `127.0.0.1` host

**When:** pointing a locally-running app at `dev-api.kortix.com` with a
`redirect_uri`, `callback`, or `return_to` on `localhost`. Cloudflare answers
403 before the API sees the request (cf-ray, no `x-kortix-*` headers). Use a
`*.localhost` name (`demo.localhost:8792` — browsers resolve it to loopback
and the OAuth registry accepts the suffix).
*Near-miss:* the dev sign-in demo hit 403 on `/v1/oauth/authorize`; read as an
API regression until curl with `app.example.test` returned the API's own 400.
*Enforcer:* none — docs note in `/docs/sdk/sign-in` is the TODO.
