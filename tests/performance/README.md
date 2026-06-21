# Performance Tests (k6)

Load, stress, spike, and soak tests for the Kortix API, written for
[Grafana k6](https://k6.io) (OSS, Apache-2.0). Everything runs through the
official `grafana/k6` Docker image — no local k6 install is required.

## Profiles

| Profile | Script | Purpose | Shape | SLO gate (thresholds) |
|---------|--------|---------|-------|-----------------------|
| **load** | `load.js` | Verify behaviour at expected/normal traffic. | Ramp to 20 VUs, hold 3m. | `p95 < 500ms`, `p99 < 1s`, errors `< 1%` |
| **stress** | `stress.js` | Find the breaking point above normal capacity. | Ramp 50→100→200→300 VUs. | `p95 < 1.5s`, errors `< 5%` |
| **spike** | `spike.js` | Sudden surge then recovery (e.g. launch/cron burst). | 10→500 VUs in 20s, hold, drop back. | `p95 < 2s`, errors `< 10%` |
| **soak** | `soak.js` | Sustained load over an hour to surface leaks/degradation. | 30 VUs held ~56m. | `p95 < 500ms`, errors `< 1%` |

Each script targets `__ENV.BASE_URL` (default `http://localhost:8008/v1`) and
exercises `GET /health` plus any extra paths in `ENDPOINTS`.

## Run locally

```bash
# default target (http://localhost:8008/v1)
tests/performance/run.sh load

# custom target
BASE_URL=https://staging.kortix.example/v1 tests/performance/run.sh stress

# authenticated endpoints + extra paths to browse
AUTH_TOKEN=eyJ... ENDPOINTS=/health,/agents,/threads tests/performance/run.sh load
```

`run.sh` invokes:

```bash
docker run --rm --add-host=host.docker.internal:host-gateway \
  -e BASE_URL=... -e RESULTS_DIR=/results \
  -v "$PWD/tests/performance:/scripts:ro" \
  -v "$PWD/test-results/performance:/results" \
  grafana/k6:0.54.0 run /scripts/load.js
```

When `BASE_URL` points at `localhost`/`127.0.0.1`, the wrapper rewrites the host
to `host.docker.internal` so the container can reach a service on your machine.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `http://localhost:8008/v1` | Target API base url. |
| `AUTH_TOKEN` | _(empty)_ | Optional bearer token; sent as `Authorization: Bearer ...`. |
| `ENDPOINTS` | `/health` | Comma-separated paths to batch-GET each iteration. |
| `K6_IMAGE` | `grafana/k6:0.54.0` | Pinned k6 Docker image. |
| `K6_PROMETHEUS_RW_SERVER_URL` | _(unset)_ | If set, also streams metrics via Prometheus remote-write. |

## Thresholds as quality gates

Every script defines a `thresholds` block encoding the SLOs (see the table
above). k6 exits **non-zero** when any threshold is breached, and `run.sh`
propagates that exit code. That makes the profiles drop-in CI quality gates:

```yaml
# example CI step (illustrative — do not commit into .github here)
- name: k6 load gate
  run: BASE_URL=${{ env.STAGING_API }} tests/performance/run.sh load
```

A failed threshold fails the job. The machine-readable artifacts are written
regardless, so you always get a report.

## Output / results

After each run, `handleSummary` writes to `test-results/performance/`:

- `<profile>-summary.json` — the full k6 end-of-test summary (metrics,
  threshold pass/fail, checks).
- `<profile>-junit.xml` — JUnit report where each threshold is a test case;
  breached thresholds become failures. Consumable by most CI test reporters.

```
test-results/performance/
  load-summary.json     load-junit.xml
  stress-summary.json   stress-junit.xml
  spike-summary.json    spike-junit.xml
  soak-summary.json     soak-junit.xml
```

## Feeding results into Grafana

k6 has **native Prometheus remote-write** output. Point it at a Prometheus
(or Grafana Cloud / Mimir) endpoint and visualise live with the official
[k6 Prometheus dashboard](https://grafana.com/grafana/dashboards/19665):

```bash
K6_PROMETHEUS_RW_SERVER_URL=http://prometheus:9090/api/v1/write \
  tests/performance/run.sh load
```

`run.sh` detects that variable, adds `--out experimental-prometheus-rw`, and
sets `K6_PROMETHEUS_RW_TREND_STATS=p(95),p(99),avg,max` so percentile trends are
exported. For post-hoc analysis instead of live streaming, the
`<profile>-summary.json` files can be loaded by any JSON panel/datasource.
