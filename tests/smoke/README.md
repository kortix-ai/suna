# Smoke tests

The fastest "is it alive?" check for a running Kortix API. No fixtures, no auth,
no data creation — just a handful of unauthenticated GETs against critical
endpoints. Designed to run in a couple of seconds and exit non-zero the moment
anything is unreachable or misbehaving.

## What it checks

| Check | Endpoint | Asserts |
|-------|----------|---------|
| Service health (unversioned) | `GET /health` | `200` and `status: "ok"` |
| Service health (versioned) | `GET /v1/health` | `200` |
| OpenAPI document served | `GET /v1/openapi.json` | `200` and looks like an OpenAPI doc |
| Public maintenance route | `GET /v1/system/maintenance` | `200` |

## Run

```bash
cd tests

# default target: http://localhost:8008/v1
bun smoke/smoke.ts

# point at another environment
API_BASE_URL=https://dev-api.kortix.com/v1 bun smoke/smoke.ts
```

`API_BASE_URL` is the `/v1`-suffixed base (default `http://localhost:8008/v1`).
The unversioned `/health` check is derived by stripping the trailing `/v1`.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_BASE_URL` | `http://localhost:8008/v1` | `/v1`-suffixed API base |
| `SMOKE_TIMEOUT_MS` | `10000` | Per-request timeout |
| `SMOKE_JUNIT` | `tests/test-results/smoke/junit.xml` | JUnit output path |

## Output

- Human-readable PASS/FAIL lines to stdout.
- JUnit XML to `test-results/smoke/junit.xml` for CI consumption.
- Exit code `0` if all checks pass, `1` on any failure, `2` on a harness error.

## Relationship to ke2e

This standalone script is intentionally dependency-free so it can run anywhere
(including before the full suite is installed). The canonical suite also exposes
a smoke profile that runs the subset of flows tagged `smoke`:

```bash
cd tests
bun bin/ke2e.ts run --tag smoke
```

Use `smoke.ts` for a near-instant liveness gate; use `ke2e run --tag smoke` for
a broader smoke pass that exercises real flows (auth role, etc.).
