---
recorded: 2026-08-22T17:07:43Z
incident_date: 2026-08-22
commit: 6894b448c7
---
# Validate a config offline before applying it, and never trust a probe whose SNI you did not choose

**When:** enabling a wildcard site block, or writing any "did it come back up?"
check against a server doing on-demand TLS.

Enabling preview origins on SampleCo crash-looped Caddy for ~4 minutes:
`subject does not qualify for certificate: '*.'`. A wildcard site address and the
env var it interpolates are **two separate writes** — the Caddyfile gained
`*.{$KORTIX_PREVIEW_BASE_DOMAIN}` while the running container's baked env still
had that var empty, and Caddy refuses to adapt a config containing a bare `*.`.

**Rules.**
1. Render the target config and run `caddy validate --config … --adapter caddyfile`
   in a throwaway container with the exact env **before** touching the live stack.
   The failing and passing cases both reproduce in seconds, with no blast radius.
2. After a config write, `--force-recreate` the container so its env is rebuilt
   from `.env`. A plain restart reuses the env baked at creation time.
3. **A probe to `https://localhost` is not a health check** against on-demand TLS:
   it presents SNI `localhost`, the issuance `ask` gate correctly rejects it, and
   TLS fails — so the probe returns `000` whether the service is healthy or not.
   It fired a needless rollback here. Use `--resolve <real-host>:443:127.0.0.1`.
   Prove any guard by running it against the *known-good* state first.
4. **Never infer "no DNS" from a bare-label lookup when the record is a wildcard.**
   `dig apps.sampleco.kortix.cloud` returns nothing while `*.apps.sampleco…`
   exists and serves live traffic. That inference led to clearing a live
   `KORTIX_APPS_BASE_DOMAIN` and taking deployed Apps down for ~25 min. Confirm
   with the *authoritative* NS and a synthesized name, and prefer an empirical
   before/after test to any reasoning about config intent.
5. Querying a name before its record exists poisons public resolvers for the
   SOA negative TTL (1800s here). Create the record first, then resolve.

*Incident:* SampleCo self-host, 2026-08-22. Two self-inflicted outages (~4 min
API, ~25 min Apps), both caused by the operator's own verification, not by the
change. Enforcer: `kortix self-host doctor` now fails on a domain-mode instance
with no preview base domain (PR #6732).
