---
recorded: 2026-10-04T18:05:50Z
incident_date: 2026-10-04
---
# Change AWS config that a Terraform root owns only in that root, never by CLI

**Rule:** Before you change an AWS setting with the CLI or console, `grep -rn` the attribute under `infra/terraform/`. If a root manages it, edit the `.tf` and let CI apply it. A CLI change to a managed attribute is reverted by the next apply of that root.

**Trigger surface:** Quieting alerts, changing GuardDuty, EventBridge, SNS, IAM, or alarm settings by hand during an incident.

**Incident:** 2026-10-01: all 17 GuardDuty detectors moved to `SIX_HOURS` by CLI to stop a re-notify email flood. `aws_guardduty_detector.*` in `infra/terraform/security-baseline/main.tf` still said `FIFTEEN_MINUTES`. 2026-10-04: the `Terraform Apply Global` run for #9133 set all 17 back to `FIFTEEN_MINUTES`. #9135 moved `SIX_HOURS` into Terraform. Near-miss: the email flood would have resumed.

**Enforcement:** none yet: a scheduled `terraform plan -detailed-exitcode` per root that reports drift before the next apply reverts it.
