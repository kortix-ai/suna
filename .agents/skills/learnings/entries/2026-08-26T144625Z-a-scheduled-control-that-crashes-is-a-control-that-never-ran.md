---
recorded: 2026-08-26T14:46:25Z
incident_date: 2026-08-26
commit: 50cfda6338
---
# A scheduled control that crashes is a control that never ran — alarm on the reconciler itself

**When:** adding a boto3 call to any compliance Lambda
(`infra/terraform/compliance-monitoring/functions/*`), or trusting that a
scheduled reconciler "has been running". `fcf779ffb3` (2026-08-06) taught the
ALB alarm reconciler to call `describe_target_groups`; its role only allowed
`DescribeLoadBalancers`. Every 5-minute tick in 3 regions raised `AccessDenied`
for 20 days. The schedule was ENABLED, the function Active, the apply green —
and the alarms the reconciler exists to maintain silently stopped being
maintained. It surfaced only because #6919 needed the reconciler to delete
alarms and nothing was deleted. Rules: **(1) every AWS API a Lambda calls is
asserted against its IAM policy in CI, not discovered in prod.** **(2) a
scheduled control gets an `AWS/Lambda Errors ≥ 1` alarm to the same topic as
the alarms it maintains; a control's own failure is the loudest alarm in the
family.** **(3) "the apply succeeded" proves the code shipped, not that it ran
— read the function's log group or its result payload before calling the
change verified.** *Enforcer:*
`infra/terraform/scripts/test_reconciler_iam_coverage.py` (terraform-ci) and
`reconciler-health.tf` (`kortix-compliance-<function>-errors` alarms, 3
regions).
