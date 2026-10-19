---
recorded: 2026-10-17T19:05:55Z
incident_date: 2026-10-17
---
# Set the handoff assignee to null with Linear's run_query_or_mutation issueUpdate, not update_issue

**Rule:** The factory handoff for an issue whose creator is the agent user sets the assignee to null (software-factory step 5a). The `linear.update_issue` connector action cannot express it: `assigneeId` is a string field and the upstream rejects a null with "No update fields provided". Use the `linear.run_query_or_mutation` action instead with the skill's own mutation shape: `mutation($id: String!, $assigneeId: String) { issueUpdate(id: $id, input: { assigneeId: $assigneeId }) { success issue { identifier assignee { id } } } }`, passing `{"id": "<uuid>", "assigneeId": null}`. The result reports `assignee: null` — done.

**Trigger surface:** Every factory worker handoff of an agent-created issue (the normal case: sources file issues under the agent user), and any other connector need a dedicated action cannot express.

**Incident:** 2026-10-17, KRTX-2481 handoff: `update_issue` with `assignee_id: null` → `action_not_found` (the schema names it `assigneeId`); `update_issue` with `assigneeId: null` → `upstream_502` "No update fields provided". Two denials, then the schema read. The constraint is invisible in the handoff step's text.

**Enforcement:** none yet: the `linear.update_issue` input schema carries the string-only `assigneeId` field; a note in the software-factory skill's step 5a naming the `run_query_or_mutation` path would make the how explicit. Nothing can gate a null-assignee write mechanically today.
