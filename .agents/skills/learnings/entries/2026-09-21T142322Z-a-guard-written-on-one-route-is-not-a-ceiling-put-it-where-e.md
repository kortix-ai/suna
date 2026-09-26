---
recorded: 2026-09-21T14:23:22Z
incident_date: 2026-09-21
commit: d193cb4350
---
# A guard written on ONE route is not a ceiling; put it where every write path passes

**When:** adding or reviewing an authorization rule for a role, especially
`owner`. `PATCH /accounts/:id/members/:userId` refused a non-owner who assigns
or changes `owner` (`member.super_admin.grant`). `POST/DELETE/PATCH
/iam/assignments` reach the same `assignRole` / `revokeAssignment` /
`updateAssignment` writes and asserted only `member.update`, which admins hold.
Reproduced on a local API: an account admin `POST`ed `role_key: owner` for
themselves and got `201`. An admin could also revoke an owner's row (after
adding a second row, to pass the last-membership guard). A second hole was in
the same function: an account-scope system role granted to a GROUP returned
`201`. The engine (`resolvePrincipal`) gives every group member that tier, but
`accountRoleFor` reads only user rows. A plain member in that group read
`GET /iam/policies` (`200`, admin-only) while every list and badge still said
"member". Found while building a UI, not by an alert. The code was live on
`prod`, `staging`, and `main`.

**Rules.** (1) A role ceiling lives in the one function that every grant,
update, and revoke passes through (`assertWriterMayAssign`), never in a route
handler. (2) Before adding a new write route, grep for route-level guards on
the same resource and move them down. (3) Two read models of one fact (the
engine versus `accountRoleFor`) must accept the same principals. Refuse writes
that only one of them can see.

*Enforcer:* `integration-iam-assignments-http.test.ts`, block "the account-role
ceiling" (5 cases). Flows `IAM-35` and `IAM-36` fail on the unfixed code
(`expected 403, got 201` and `got 409`) and pass on the fix.
