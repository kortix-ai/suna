# API tests

The canonical API test engine for this repo is **ke2e** — a black-box REST E2E
suite of 283 flows that runs against a live API. This directory does **not**
duplicate it. It exists for two things:

1. Pointing you at ke2e for all real API coverage.
2. One tiny, self-contained example (`example.api.test.ts`) showing the minimal
   `bun:test` + `fetch` pattern, so contributors have something to copy without
   pulling in the ke2e harness.

## Use ke2e for real API coverage

ke2e is the source of truth. Flows live in `tests/src/flows/*.flow.ts` and each
maps 1:1 to a spec ID. It has a coverage gate (every `/v1` route must be hit) and
an Allure reporter.

```bash
cd tests

# list every flow (id, domain, tags)
bun bin/ke2e.ts list

# run everything against the default local API (http://localhost:8008/v1)
bun bin/ke2e.ts run

# run one domain (e.g. auth, billing, iam, sandboxes, projects, audit, scim)
bun bin/ke2e.ts run --domain auth

# run the smoke subset, or a single flow by id, or a substring
bun bin/ke2e.ts run --tag smoke
bun bin/ke2e.ts run --id SYS-3
bun bin/ke2e.ts run --grep logout

# point at another environment
KE2E_API_URL=https://dev-api.kortix.com/v1 bun bin/ke2e.ts run --domain auth
```

`KE2E_API_URL` selects the target (default `http://localhost:8008/v1`). See
`tests/README.md` and `tests/src/core/env.ts` for the full env matrix
(`KE2E_OWNER_*`, `KE2E_ADMIN_TOKEN`, capabilities, destructive-run guards).

### Adding a flow

Create or extend a `tests/src/flows/<domain>.flow.ts` and register with
`flow(id, meta, fn)`:

```ts
import { flow } from "../core/flow";

flow(
  "SYS-3",
  { domain: "auth", tags: ["smoke"], routes: ["GET /v1/user-roles"] },
  async (ctx) => {
    await ctx.step("OWNER sees platform role", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/user-roles");
      r.status(200).body().exists("$.isAdmin").exists("$.role");
    });
  },
);
```

Keep `meta.routes` in sync with what the flow calls — the coverage gate fails on
unknown or uncovered routes. Use `ctx.fixtures` for run-scoped projects,
sessions, teams, and PATs (auto torn down). See any file under `tests/src/flows/`
for patterns.

## The standalone example

`example.api.test.ts` is a minimal pattern, independent of ke2e: plain
`bun:test` + `fetch` against `process.env.API_BASE_URL` (default
`http://localhost:8008/v1`), hitting `GET /health`.

```bash
cd tests

# run it (needs a live API)
bun test api/example.api.test.ts

# with JUnit output for CI
bun test api/example.api.test.ts \
  --reporter=junit --reporter-outfile=test-results/api/junit.xml

# against another environment
API_BASE_URL=https://dev-api.kortix.com/v1 bun test api/example.api.test.ts
```

| Variable | Default | Description |
|----------|---------|-------------|
| `API_BASE_URL` | `http://localhost:8008/v1` | `/v1`-suffixed API base |

JUnit XML is written to `test-results/api/junit.xml` via Bun's built-in `junit`
reporter (`--reporter=junit --reporter-outfile=...`).

Reach for this pattern only for a quick one-off probe. For anything that needs
auth, fixtures, multiple principals, or route coverage, add a ke2e flow instead.
