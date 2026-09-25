---
recorded: 2026-09-18T01:17:37Z
incident_date: 2026-09-17
commit: fc512f8d2c
---
# A control-required alarm comes back with a threshold the workload cannot cross in steady state

**When:** an external control (Drata DCF-86 / test 294) requires an alarm the
team retired as noise. Drata checks existence + SNS delivery, not the
threshold: restore `TargetResponseTime` at Average > 30 s for 3×5 min — above
the worst 14-day sustained average (~25 s, dev API ALB; normal 5–11 s) — so
the control passes without resurrecting the 2026-08-26 ~300-email flap
(entry below). Terraform and the reconciler `ALARM_SPECS` must carry the
identical spec, or the Lambda rewrites Terraform's alarms every tick.
*Enforcer:* `infra/terraform/scripts/test_alb_target_response_time_alarms.py`
pins metric/statistic/threshold/evaluations per region, the reconciler spec
parity, and the us-east-2 alert-topic subscription.
