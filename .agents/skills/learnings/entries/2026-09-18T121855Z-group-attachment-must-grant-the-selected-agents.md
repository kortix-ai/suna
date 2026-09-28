---
recorded: 2026-09-18T12:18:55Z
incident_date: 2026-09-18
commit: bd94c429a4
---
# Group attachment must grant the selected agents

**Rule:** when attaching an IAM group to a project, load that project's agents
and save the selected object assignments with the project role. Block submission
while inventory is unavailable. **Incident:** real Azure SCIM sync succeeded on
dev, but the attached member could not send messages because no agent grants
existed. **Enforcer:** `22-resource-grant-multiselect.spec.ts` checks attachment,
agent assignment persistence, partial-save retry, and the member composer.
