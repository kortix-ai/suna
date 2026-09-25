---
recorded: 2026-08-23T14:25:56Z
incident_date: 2026-08-23
commit: 5dc9cb132a
---
# Give reviewed infrastructure rollbacks an explicit delete path

**When:** a rollback removes Terraform-managed resources. Keep automatic pushes
delete-safe. Expose a manual `allow_deletes` input, review the exact plan, and
apply the same plan through the guarded workflow. *Incident:* the `kortixd`
rollback planned four relay-only deletes; the dev deploy correctly stopped and
left the stable API image undeployed. *Enforcer:* `terraform-apply.yml` blocks
deletes unless the caller passes `allow_deletes=true`.
