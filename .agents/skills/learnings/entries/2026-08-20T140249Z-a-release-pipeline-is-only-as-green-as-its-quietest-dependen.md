---
recorded: 2026-08-20T14:02:49Z
commit: 0c247496b6
---
# A release pipeline is only as green as its quietest dependency

Rules paid for during the v0.13.1 release-gate campaign, 2026-08-19/20 (the
gate had passed 0 of 18 runs in its history; 13 instrumented staging dry-runs
converted every hidden cause into a named fix; v0.13.1 then shipped through
the genuinely green gate — PRs #6622–#6648, release PR #6654):

**1. A failing job in a `needs:` chain silently freezes every dependent
deploy — probe credentials, and never let a janitor gate the payload.** The
`wire-cloudflare` job's Cloudflare key died on 2026-08-18 (403). Three jobs
`needs:`-depended on it, so every staging WEB deploy was skipped for a week —
the release gate drove an Aug-12 frontend against the current API, and the
resulting browser failures read as product bugs. Fix (#6626, #6639): the
non-essential job is `continue-on-error`, and the deploy step probes each
credential with a cheap authenticated read and uses the first one that works.
Rule: when a job fails REPEATEDLY and everything still "works", find out what
its `needs:` dependents silently stopped doing.

**2. Never replay a non-idempotent POST through an edge-laundered 5xx — the
origin may have committed.** The edge Worker turns any origin 5xx into a
synthetic 503 with no `x-request-id`. The ke2e client retried creates through
it, and the second send collided with the first send's committed row: 10
distinct gate failures reading `409 already exists` were the client fighting
itself (run 32306385663). Fix (#6628): POST is never replayed through an
ambiguous 5xx; bounded retries stay for reads; world-bootstrap creates retry
only with per-attempt-fresh identities (#6636, attempt-scoped run ids #6638).
*Automation:* `tests/unit/create-replay-safety.test.ts` injects the exact
laundered 503 and pins POST to one send while GET still retries.

**3. Never put a credential in a browser's global header set.** The Vercel
deployment-protection bypass secret sat in Playwright `use.extraHTTPHeaders`,
which Chromium attaches to EVERY request: it was transmitted to 16 third-party
hosts (Google, Facebook, DoubleClick…) on every run, persisted inside public
workflow trace artifacts, AND its presence in cross-origin preflights made the
API's CORS allow-list reject every browser API call — one line caused both a
credential leak and the entire 11-spec browser failure class (#6632). Fix: the
bypass is exchanged ONCE for a scoped `_vercel_jwt` cookie against the
deployment origin. Rule: scope every credential to the one origin that needs
it; treat `extraHTTPHeaders`/default-header config as a broadcast channel.

*Incident:* no production outage — the cost was ~22 hours of release paralysis
and one leaked secret (rotated). The meta-rule: a gate that has NEVER been
green is not protecting anything; each red must convert one hidden cause into
a named, enforced fix until green is the steady state.
