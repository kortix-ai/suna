# DR / Failover Runbook Test Stub

> **Scope:** This is a *stub* describing disaster-recovery and failover checks
> for a **deployed** Kortix environment (staging or prod-like). It mixes manual
> steps with notes on how each could be automated. It is **not** a unit-CI test
> and must never be run against a live production tenant without a maintenance
> window and approval.

## Steady-state definition

Before any DR drill, capture the baseline so "recovered" is objective:

- `GET ${BASE_URL}/health` returns 2xx.
- p95 latency of the load profile (`tests/performance/run.sh load`) within SLO.
- No 5xx in API logs for the last 5 minutes.

Record these numbers; they are the acceptance bar for "service restored".

## Recovery objectives

| Objective | Target | How measured |
|-----------|--------|--------------|
| RTO (time to restore service) | _e.g._ ≤ 15 min | wall-clock from fault → steady state |
| RPO (acceptable data loss) | _e.g._ ≤ 5 min | newest restorable backup vs fault time |

Fill in the org's agreed targets above.

## Scenarios

Each scenario lists: **fault → expected behaviour → manual check → automation hook.**

### 1. API instance / pod loss

- **Fault:** kill one API container/pod.
- **Expected:** remaining replicas keep serving; orchestrator restarts the
  instance; no sustained error spike.
- **Manual check:** kill one instance, watch `/health` stay green and the
  instance count return to desired.
- **Automatable:** `tests/chaos/container-chaos-pumba.sh` with
  `ACTION=kill TARGET=<api-container>`. Assert steady-state recovery.

### 2. Database failover (primary → replica)

- **Fault:** promote replica / fail the primary.
- **Expected:** writes pause briefly, then resume against the new primary;
  reads stay available; no data loss beyond RPO.
- **Manual check:** trigger failover in the managed DB console; time the write
  outage; verify the app reconnects without a deploy.
- **Automatable:** partition the DB with
  `tests/chaos/resilience-toxiproxy.sh PROXY=postgres` to prove the app fails
  fast and recovers; full promotion drill stays manual/provider-scripted.

### 3. Cache / Redis loss

- **Fault:** stop Redis.
- **Expected:** API degrades gracefully (slower, not down) — cache misses fall
  through to the source of truth; no hard 5xx storm.
- **Manual check:** stop Redis, confirm endpoints still respond (higher latency
  acceptable), restart, confirm recovery.
- **Automatable:** `tests/chaos/resilience-toxiproxy.sh PROXY=redis`.

### 4. Availability-zone / region outage

- **Fault:** remove an AZ/region from rotation.
- **Expected:** traffic shifts to healthy AZ/region within RTO; no data loss
  beyond RPO.
- **Manual check:** drain one zone at the load balancer / DNS; verify failover
  and capacity headroom in the surviving zone.
- **Automatable:** partially — synthetic checks from multiple regions + alerting
  assertions; the actual zone drain is provider/infra tooling.

### 5. Backup restore (RPO validation)

- **Fault:** simulate data corruption / loss.
- **Expected:** latest backup restores cleanly within RTO, losing ≤ RPO data.
- **Manual check:** restore the most recent snapshot into an isolated env,
  run smoke tests, confirm the newest restorable timestamp vs the fault time.
- **Automatable:** scheduled restore-and-smoke-test job in staging.

## Drill checklist

- [ ] Announce window / get approval (non-prod or controlled prod).
- [ ] Capture steady-state baseline.
- [ ] Start a load profile to generate realistic traffic during the drill.
- [ ] Inject the fault (manual or via the chaos scripts above).
- [ ] Observe blast radius; record time-to-detect and time-to-recover.
- [ ] Confirm return to steady state (health + latency + error rate).
- [ ] Compare RTO/RPO achieved vs targets.
- [ ] Write up findings and file follow-ups for any gaps.

## Outputs

The automatable scenarios write JSON to `test-results/chaos/`
(`resilience-<proxy>.json`, `container-chaos-<action>.json`). Attach those plus
the manually recorded RTO/RPO numbers to the drill report.
