---
name: ke2e-tests
description: "How Kortix end-to-end API tests work and the mandatory test-as-source-of-truth workflow. Load WHENEVER you add, change, or remove an API route, status code, auth gate, request/response shape, or status enum under apps/api/src/** — and whenever you touch anything under tests/ (the ke2e suite) or are asked to add test coverage, run the e2e suite, or understand why CI's coverage gate failed. The suite (tests/) is one clean black-box HTTP suite that runs against a LIVE deployed API with real services; spec/end-to-end.md + the route manifest are the source of truth, enforced by a coverage gate."
---

# ke2e — test as source of truth

Kortix has **one** end-to-end test suite at `suna/tests/` (the `ke2e` runner). It is
black-box: it hits a **real, deployed API over HTTP** (`dev-api.kortix.com`, local
`localhost:8008/v1`, or prod) with **live services** (real Daytona, Freestyle, Stripe
test-mode, LLM) — no mocking, no in-process app. Every test maps **1:1** to a stable
flow ID in `tests/spec/end-to-end.md`. A coverage gate makes that mapping enforceable,
so the spec + tests stay the source of truth for what the API does.

> **WIP — NOT yet enforced.** The suite is still being built out and does not gate PRs,
> promotes, or deploys yet. The workflow below is the **intended** end-state; follow it
> when convenient, but it is not mandatory until coverage is complete and the gates are
> turned back on (re-add the `pull_request` trigger in `e2e.yml` + the `e2e_gate` job in
> `promote.yml`). Until then, do not block your own work on it.

## The intended workflow (once enforced)

When you add, change, or remove anything in `apps/api/src/**` that affects an HTTP
contract — a route, status code, auth gate, request/response shape, or status enum —
the goal is, in the same change:

1. **Update `tests/spec/end-to-end.md`** — add/modify the flow line in the existing
   `METHOD /path → expected` format, with a stable ID (e.g. `PROJ-12`). Negatives
   (`→ 4xx`) are part of the flow, not optional.
2. **Regenerate the route manifest** if you added/removed/renamed a route:
   `bun run apps/api/scripts/dump-routes.ts` (writes `tests/spec/routes.generated.json`).
3. **Add or adjust the flow** in the matching `tests/src/flows/<domain>.flow.ts`, and
   list the routes it exercises in `meta.routes`.
4. **`cd tests && bun bin/ke2e.ts coverage`** must pass (no orphan flow, no unknown
   route, uncovered count within baseline).
5. **Run the touched flow live** before opening the change request:
   `cd tests && KE2E_API_URL=https://dev-api.kortix.com/v1 KE2E_OWNER_EMAIL=… KE2E_OWNER_PASSWORD=… KE2E_LIVE_CONFIRM=1 bun bin/ke2e.ts run --id PROJ-12` and confirm green.

**Never weaken an assertion to make a test pass.** If a test goes red, the code or the
spec is wrong — fix that. If a route is genuinely impossible to test (truly un-automatable),
add it to `tests/src/coverage/allowlist.ts` **with a reason** — never silently.

## Writing a flow

A flow is ~a few lines. Each `ctx.step` is one capture/timing/assertion unit, rendered
individually in the HTML report.

```ts
// tests/src/flows/secrets.flow.ts
import { flow } from "../core/flow";

flow("SEC-2b", {
  domain: "secrets",
  tags: ["secrets"],
  routes: ["POST /v1/projects/:id/secrets"],
}, async (ctx) => {
  const p = await ctx.fixtures.project();              // run-scoped, auto-torn-down
  await ctx.step("reserved name rejected", async () => {
    const r = await ctx.client.as(ctx.P.M_MANAGER)
      .post("/v1/projects/:id/secrets", { name: "KORTIX_X", value: "v" }, { params: { id: p.id } });
    r.status(400);
  });
});
```

- **Auth** is principal-driven: `ctx.client.as(ctx.P.OWNER)`, `ctx.P.M_VIEWER`, `ctx.P.ANON`, etc.
  (the principal matrix is provisioned per run; see `tests/spec/end-to-end.md` §0).
- **Paths are templates** with `/v1/...` and `:param` placeholders + `{ params }` — the
  template is the coverage key, so it must match a manifest route exactly.
- **Assertions** record into the report: `.status(200|[200,201])`, `.body().has("$.a.b", v)`,
  `.body().exists("$.id")`, `.headerEquals(...)`. Negatives are ordinary assertions.
- **Resources** created outside `ctx.fixtures` must be `ctx.track(kind, id, meta)`-ed so
  teardown reclaims them (we run against live infra — leaks cost money; the GC sweep is a backstop).
- **Async resources** (sandbox boot, snapshot build): use `waitFor`/poll helpers from
  `core/poll`. Timeouts are infra-retryable, not assertion failures.
- **Capability-gated** routes (billing off, no Stripe, etc.): set `requires: ["stripe"]`
  so the flow self-skips with a reason instead of failing.
- **Everything is programmatic** — no browser, no human. CLI flows spawn the `kortix`
  binary; OAuth/signed-callback flows forge the valid signed state and POST the callback.

## Running

```
cd suna/tests
bun bin/ke2e.ts list                       # all flows + domains
bun bin/ke2e.ts run --domain system,access # public — no creds needed
bun bin/ke2e.ts run --domain projects      # needs KE2E_OWNER_* + KE2E_LIVE_CONFIRM
bun bin/ke2e.ts run --id GOLD-1            # one flow
bun bin/ke2e.ts coverage                   # the source-of-truth gate
bun bin/ke2e.ts gc --older-than 2h         # reclaim leaked e2e- resources
```

Open `test-results/<runId>/report.html` for the request/response of every step (the
report doubles as living API docs). Secrets are redacted at capture; never un-redact.

## CI

- **Pre-promote gate** (`promote.yml`): the full suite runs against `dev-api.kortix.com`
  (which is the commit being promoted) and must be GREEN before prod gets the tag.
- **Post-deploy smoke** (`deploy-prod.yml`): `--smoke` subset against prod.
- **On PRs**: the suite's typecheck + `ke2e coverage` are required checks; the suite also
  runs against dev-api as an advisory health check.
- The coverage gate is the enforcement of this skill. If it fails, you skipped a step above.
