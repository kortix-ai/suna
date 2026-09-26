---
recorded: 2026-08-26T13:31:13Z
incident_date: 2026-08-26
commit: 042dbda966
---
# An alarm on a metric the workload violates by design is noise, and noise trains you to delete the real page

**When:** adding or reviewing any CloudWatch/SNS alarm, especially compliance
alarms that exist to satisfy a control (Drata DCF-86) rather than an incident.
`TargetResponseTime` Average ≥ 2 s on the gateway and API ALBs fired on 6–11 s
averages — normal, because the gateway streams LLM completions and the API
holds SSE `/event` streams for minutes. The alarm flapped ALARM/OK every 5–10
min; each flap fanned out through **two** alarm sets on the same ALB (a
hand-made `compliance-*` set from the 2026-07-27 evidence pass, never in
Terraform, plus the `kortix-alb-*` set) × **three** email subscriptions on the
same person = ~300 emails in one day and zero incidents. The 5xx alarms in the
same inbox — the ones that page a real outage — had 3 messages each and were
being trashed with the rest. Rules: **(1) before adding a threshold alarm, name
the request shape that violates it in steady state; if streaming, long-poll or
SSE traffic crosses it by design, alarm on errors and host health instead.
(2) One alarm set per resource, and it lives in code — a console-made duplicate
is drift, and the reconciler that owns the family deletes it. (3) A reconciler
that can only create is half a reconciler: it must also delete what it retires,
or a deleted alarm is resurrected on the next tick and Terraform's forget/destroy
is undone.** `removed { lifecycle { destroy = false } }` lets the automatic
apply pass its no-delete guard while the Lambda does the real deletion.
*Enforcer:* `functions/test_alb_alarm_reconciler.py` — `ALARM_SPECS` contains no
`TargetResponseTime`; retired `kortix-alb-*-target-response-time` (including the
per-target-group variants Terraform never managed) and `compliance-*` alarms in
`AWS/ApplicationELB` are deleted; `compliance-*-cpu-high` and every desired
alarm survive.
