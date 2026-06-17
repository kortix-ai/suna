# DAST — OWASP ZAP baseline + Schemathesis

Dynamic application security testing against a **running** target. Docker-only.
Unlike every other lane here, these checks send live traffic, so they require a
deployed instance to point at.

## ⚠️ Run only against a dedicated target

DAST and fuzzing are **active**: ZAP probes for live vulnerabilities and
Schemathesis sends large volumes of malformed requests. Point `TARGET_URL` at a
**dedicated, staging, or local** instance you control.

**NEVER run these against shared production or shared dev environments.** They
can create/mutate/delete data, trip rate limits and alerting, and degrade
service for others. The script refuses any `TARGET_URL` containing
`prod`/`production`, but that is a guardrail, not a guarantee — you are
responsible for the target.

## Tools

- [OWASP ZAP](https://www.zaproxy.org) baseline scan (Apache-2.0,
  `ghcr.io/zaproxy/zaproxy`) — passive + light active spider of the web target.
  Reports: `test-results/security/zap-baseline.{html,json}`.
- [Schemathesis](https://schemathesis.readthedocs.io) (OSS, MIT,
  `schemathesis/schemathesis`) — property-based fuzzing driven by the API's
  OpenAPI spec at `/v1/openapi.json` (`--checks all`).
  Report: `test-results/security/schemathesis-junit.xml` (JUnit).

## Run

```bash
# local API (Hono, default config.PORT) + web (default 3000)
TARGET_URL=http://host.docker.internal:8000 tests/security/dast/run.sh

# only one tool:
WANT_ZAP=0 TARGET_URL=http://host.docker.internal:8000 tests/security/dast/run.sh

# authenticated fuzzing:
SCHEMATHESIS_HEADER="Authorization: Bearer <token>" \
  TARGET_URL=http://host.docker.internal:8000 tests/security/dast/run.sh

# or via the orchestrator:
TARGET_URL=http://host.docker.internal:8000 tests/security/run.sh --dast
```

`host.docker.internal` (wired via `--add-host=...:host-gateway`) lets the
containerized scanners reach a target running on the host.

## Knobs

- `TARGET_URL` (required) — base URL of the running target.
- `OPENAPI_URL` — defaults to `${TARGET_URL}/v1/openapi.json`.
- `SCHEMATHESIS_MAX_EXAMPLES` — examples per operation (default 50).
- `SCHEMATHESIS_HEADER` / `SCHEMATHESIS_HEADER` — auth header for fuzzing.
- `ZAP_IMAGE` / `SCHEMATHESIS_IMAGE` — pin versions.

## Quality gate

Non-zero exit if ZAP reports findings above its threshold or Schemathesis finds
a failing check.
