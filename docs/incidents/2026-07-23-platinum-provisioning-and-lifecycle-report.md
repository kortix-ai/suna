# Platinum provisioning and lifecycle incident report

Date: 2026-07-23

Audience: Platinum engineering

Status: Open

## Incident summary

Kortix observes high latency and failure rates in Platinum sandbox creation and template builds.

The measurements below exclude Kortix database queries and application request processing.
They measure Platinum provider operations and persisted provider outcomes.

The highest-priority failure is `sandbox_not_found` during sandbox lifecycle calls.
Platinum returned this error `35,112` times during the seven-day provider-log window.

## Customer impact

- A new Platinum sandbox can take up to `43.117 s` to create.
- `18` Platinum sessions entered a failed provisioning state during seven days.
- `20` additional stopped sessions report that the original sandbox is unavailable.
- `82` Platinum template builds failed during seven days.
- A successful template build reached `3,497.7 s`.
- A failed template build remained unresolved for up to `75,365.0 s`.

These failures block session startup, restart, terminal access, and OpenCode access.

## Sandbox create latency

The data covers direct provider-create calls. It excludes snapshot preparation and Kortix queue time.

### Rolling 24-hour window ending 2026-07-23

| Attempts |        p50 |         p90 |         p95 |     Maximum |
| -------: | ---------: | ----------: | ----------: | ----------: |
|       26 | `2,922 ms` | `27,383 ms` | `33,475 ms` | `43,117 ms` |

### Rolling seven-day window ending 2026-07-23

| Attempts |        p50 |         p90 |         p95 |     Maximum |
| -------: | ---------: | ----------: | ----------: | ----------: |
|      303 | `2,903 ms` | `12,592 ms` | `15,304 ms` | `43,117 ms` |

The p90 is `4.34` times the p50 in the seven-day window.
The p95 is `5.27` times the p50 in the seven-day window.

## Session outcomes

The seven-day session sample contains these terminal states:

| Outcome               | Count |
| --------------------- | ----: |
| Stopped               |   298 |
| Running at query time |     9 |
| Failed                |    18 |

All `18` failed sessions contain `Provisioning failed via platinum`.

Another `20` stopped sessions contain this message:

```text
The original sandbox is unavailable. Its identity was preserved and no replacement sandbox was created.
```

Kortix preserves the original provider identity in this state.
Kortix does not silently create a replacement sandbox.

## Template build outcomes

The seven-day sample contains `263` Platinum template builds.

| Outcome | Count |       p50 |         p95 |      Maximum |
| ------- | ----: | --------: | ----------: | -----------: |
| Ready   |   181 | `589.3 s` | `1,482.0 s` |  `3,497.7 s` |
| Failed  |    82 | `284.8 s` | `2,941.3 s` | `75,365.0 s` |

The observed build success rate is `68.8%`.
The observed build failure rate is `31.2%`.

### Failure classification

| Failure message                                           | Count |
| --------------------------------------------------------- | ----: |
| `Platinum template <template> build failed`               |    54 |
| `Build did not finish — provider state: platinum=missing` |    14 |
| `did not become ready (last state: building)`             |     9 |
| `did not become ready (last state: missing)`              |     3 |
| Socket closed unexpectedly                                |     1 |
| Provider state `build_failed`                             |     1 |

### Affected Kortix project

The reported project has `34` recorded Platinum template builds.

| Outcome | Count |       p50 |            p95 |        Maximum |
| ------- | ----: | --------: | -------------: | -------------: |
| Ready   |    25 | `541.5 s` |    `1,483.6 s` |    `3,497.7 s` |
| Failed  |     9 | `911.1 s` | Not calculated | Not calculated |

## Platinum API error distribution

The rolling seven-day Platinum log query matched `41,984` error events.
These counts represent events, not distinct sandboxes.

| Method       |       Status | Error code            | Events |
| ------------ | -----------: | --------------------- | -----: |
| `POST`       |          404 | `sandbox_not_found`   | 35,112 |
| `POST`       |          409 | `sandbox_not_running` |  2,988 |
| `POST`       |          409 | `conflict`            |  2,612 |
| `POST`       |          503 | `capacity`            |    671 |
| `POST`       |          404 | `not_found`           |    490 |
| `DELETE`     |          409 | `template_in_use`     |     46 |
| `POST`       |          409 | `in_progress`         |     37 |
| `POST`       |          503 | `shutting_down`       |     13 |
| Unclassified | Unclassified | Unclassified          |      8 |
| `POST`       |          503 | `unavailable`         |      3 |
| `POST`       |          413 | `payload_too_large`   |      2 |
| `DELETE`     |          404 | `not_found`           |      1 |
| `DELETE`     |          409 | `build_in_progress`   |      1 |

## Confirmed response contracts

Kortix observed these live Platinum responses:

```text
POST /v1/sandboxes/:id/start -> 404 sandbox_not_found
POST /v1/sandboxes/:id/start -> 409 conflict
POST /v1/sandboxes/:id/expose -> 409 sandbox_not_running
POST /v1/sandboxes/:id/expose -> 404 sandbox_not_found
DELETE /v1/templates/:id -> 409 template_in_use
```

The `start` conflict response occurred while the sandbox state was `starting` or `running`.

## Requested Platinum actions

1. Trace the `35,112` `sandbox_not_found` events to sandbox deletion or metadata-loss events.
2. Identify every automatic deletion path that can remove a persistent Kortix sandbox.
3. Return a durable deletion reason and deletion timestamp for missing sandboxes.
4. Make `POST /sandboxes/:id/start` idempotent for `starting` and `running` states.
5. Investigate the `671` capacity failures by region, host pool, and template.
6. Add a terminal failure deadline for template builds that remain `building` or `missing`.
7. Explain the `75,365.0 s` failed-build duration and the missing stale-build transition.
8. Provide a provider incident identifier for the `82` failed template builds.
9. Provide per-request trace identifiers in every non-2xx response.

## Requested response data

Please return these items for closure:

- Root cause for `sandbox_not_found`.
- Root cause for the template failure rate.
- Affected hosts, regions, and time ranges.
- Repair status for missing persistent sandboxes.
- Capacity remediation and completion date.
- Template-build timeout remediation and completion date.
- An idempotent lifecycle API contract or migration plan.
- A queryable audit record for sandbox deletion and host migration.

## Kortix-side facts

- Kortix retains established Platinum sandbox identities after provider loss.
- Kortix does not replace a missing established sandbox automatically.
- The current API deployment has two ready pods and zero pod restarts.
- API CPU usage was approximately `28%` during investigation.
- API memory usage was approximately `66%` during investigation.
- No API `5xx` responses appeared in the last-ten-minute infrastructure sample.
- The database query that lists sessions executed in `0.333 ms`.

These facts rule out current Kortix compute saturation and session-list SQL execution as causes of the provider outcomes above.
