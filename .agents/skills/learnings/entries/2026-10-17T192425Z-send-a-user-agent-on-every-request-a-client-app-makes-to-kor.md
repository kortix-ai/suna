---
recorded: 2026-10-17T19:24:25Z
incident_date: 2026-10-17
---
# Send a User-Agent on every request a client app makes to Kortix

**Rule:** Every HTTP client in a shipped app (Kortix Capture, the desktop app,
the CLI) sets a User-Agent naming the app and version. Cloudflare in front of
`dev-api.kortix.com` (and the other Kortix hosts) answers a request without
one with an HTML `403 Forbidden`. A smoke test from curl or Python never sees
it, because both send a User-Agent by default.

**Trigger surface:** building a `reqwest` (or any) HTTP client in
`apps/capture`; any client-side code that talks to the Kortix API.

**Incident:** 2026-10-17, Kortix Capture `0.14.1-dev` on dev. "Sign in with
Kortix" always failed with "Kortix would not start sign-in."
`POST /v1/capture/device/authorize` got `403` from Cloudflare, because the
app's `reqwest` clients sent no User-Agent. CI never saw it: the CI stand-in
issuer is local, and the dev E2E script used Python.

**Enforcement:** `sync::user_agent()` is set on every client in
`apps/capture` (issuer, S3, updater, favicons, privacy model).
`every_issuer_request_names_the_app_in_its_user_agent` (`issuer.rs`)
asserts the header on the wire.
