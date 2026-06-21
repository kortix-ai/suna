# Chaos / Failover / DR Tests

Resilience experiments for Kortix using OSS chaos tooling, all invoked through
Docker (no local installs):

- **[Toxiproxy](https://github.com/Shopify/toxiproxy)** (MIT) — inject latency
  and network partitions on a *dependency* (Postgres, Redis, or an upstream).
- **[pumba](https://github.com/alexei-led/pumba)** (Apache-2.0) — kill, pause,
  or stop *containers* to test instance-loss resilience.

## ⚠️ Where this applies (read first)

These are **not** unit tests and **must not** run in normal unit CI. Chaos
engineering validates a *running system*, so every script here needs a
**deployed / staging target** that is actually reachable:

- the API up and serving `GET /health`,
- its real dependencies (DB/Redis/upstream) reachable, and
- for pumba, the workloads running as **Docker containers on the host** where
  you run the script (pumba drives the local Docker daemon).

Run these on demand against staging (or a prod-like env during a drill), gated
behind a manual/scheduled job — never as a blocking PR check. Each experiment
starts by verifying a **steady-state baseline** and aborts if the system is
already unhealthy, so failures are attributable to the injected fault.

## Files

| File | What it is |
|------|-----------|
| `docker-compose.toxiproxy.yml` | Brings up Toxiproxy with proxies for Postgres/Redis/an upstream. |
| `toxiproxy.json` | Proxy definitions loaded at boot (edit upstreams for your env). |
| `resilience-toxiproxy.sh` | Latency + partition experiment with steady-state hypothesis + recovery check. |
| `container-chaos-pumba.sh` | Kill/pause/stop an API container and assert recovery. |
| `dr-runbook.md` | Manual + automatable DR/failover drill checklist (RTO/RPO, AZ outage, backup restore). |

## 1. Dependency chaos with Toxiproxy

Toxiproxy sits **between the API and a dependency**. Point your API at the
Toxiproxy listen port for that dependency (e.g. set the app's `DATABASE_URL`
host/port to the Toxiproxy `postgres` proxy `…:15432`), then disrupt it.

Start Toxiproxy (edit `toxiproxy.json` so `upstream` points at your real
dependency host):

```bash
docker compose -f tests/chaos/docker-compose.toxiproxy.yml up -d
```

Run the experiment:

```bash
# disrupt the DB dependency; assert the API degrades gracefully + recovers
BASE_URL=http://localhost:8008/v1 PROXY=postgres \
  tests/chaos/resilience-toxiproxy.sh

# or disrupt Redis with a custom latency
PROXY=redis LATENCY_MS=3000 tests/chaos/resilience-toxiproxy.sh
```

The script:

1. confirms baseline steady state (`/health` 2xx),
2. injects **latency** and asserts responses stay **bounded** (no hang),
3. **partitions** the dependency and asserts the API **stays up / fails fast**,
4. **heals** the fault and asserts **recovery** to steady state.

Tear down:

```bash
docker compose -f tests/chaos/docker-compose.toxiproxy.yml down
```

### Toxiproxy env vars

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `http://localhost:8008/v1` | API base url to probe. |
| `HEALTH_PATH` | `/health` | Health endpoint. |
| `TOXIPROXY` | `http://localhost:8474` | Toxiproxy admin API. |
| `PROXY` | `postgres` | Which proxy/dependency to disrupt (`postgres`/`redis`/`api_upstream`). |
| `LATENCY_MS` | `4000` | Injected latency in ms. |

## 2. Container chaos with pumba

Run on the host where the Kortix containers live:

```bash
# hard-kill one API container, assert the service recovers
TARGET=kortix-api ACTION=kill tests/chaos/container-chaos-pumba.sh

# pause a container for 20s (simulates a stuck/GC'd instance)
TARGET=kortix-api ACTION=pause DURATION=20s tests/chaos/container-chaos-pumba.sh
```

`TARGET` is a regex matched via pumba's `re2:` selector. The script verifies
baseline steady state, injects the fault, then polls `/health` until the service
returns to steady state (or fails after 60s).

### pumba env vars

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `http://localhost:8008/v1` | API base url to probe. |
| `TARGET` | `kortix-api` | Container name/regex to disrupt. |
| `ACTION` | `kill` | `kill` / `pause` / `stop`. |
| `DURATION` | `15s` | Window for `pause`/`stop`. |
| `SIGNAL` | `SIGKILL` | Signal for `kill`. |

## 3. DR / failover runbook

See **[dr-runbook.md](./dr-runbook.md)** for the broader drill: DB failover,
AZ/region outage, cache loss, and backup-restore (RPO) checks — with notes on
which steps the scripts above automate and which stay manual.

## OSS tools & pinned images

| Tool | Image | Invocation |
|------|-------|-----------|
| Toxiproxy | `ghcr.io/shopify/toxiproxy:2.11.0` | `docker compose -f docker-compose.toxiproxy.yml up -d` |
| pumba | `gaiaadm/pumba:0.11.6` | `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock gaiaadm/pumba …` |

## Output / results

Both scripts write machine-readable JSON to `test-results/chaos/`:

```
test-results/chaos/
  resilience-postgres.json      # (or resilience-redis.json …)
  container-chaos-kill.json     # (or -pause / -stop)
```

Each report contains the proxy/action, per-step `passed` booleans, and totals,
so a runner can gate on `failed == 0`.
