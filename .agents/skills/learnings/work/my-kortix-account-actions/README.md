---
title: My Kortix account-level actions through server-side approvals
status: planned (not built). My Kortix v2 (branch my-kortix-v2) keeps the project-only boundary.
owner: unassigned
updated: 2026-10-30
---

# My Kortix account-level actions

## The problem

The founder wants My Kortix to hold "identical permissions to the human", everything the person may do. Inside the project it does: the session token carries the launching person's project role (`authorize.ts` step 10, grant `all` ∩ role). Account routes refuse every session token at the path gate: `/v1/accounts/*`, the projects list/create, `/v1/billing` (`apps/api/src/middleware/auth-scope.ts` 165-215, `iam/authorize.ts` `tokenScopeAllows`). So My Kortix cannot invite someone to the account, change an account role, read billing, or act in another project. Today it tells the person where to click.

## Why it is not a flag flip

- The token is `KORTIX_TOKEN` in the sandbox env, with no expiry. A leak would be an account-admin credential.
- The sandbox reads the web. Any page or document can try to steer the agent. A confirmation in the model is not a boundary: the agent can call the API with the token directly. The confirmation must be enforced by the server.
- `user_id` on a session token follows the person who prompts each turn (`projects/lib/on-behalf-of.ts` 221-243). In a shared session another member's prompt would swap the authority.
- The MFA gate skips every token (`authorize.ts` 133-139), and the super-admin bypass (232) would hand an account creator's session every account action.
- Some account routes check membership without `authorize` (`authorize.ts` 180-184). Opening the path gate exposes them.

## The design to build

1. Reads first: an `account_reads` flag on the My Kortix grant allows a short list of GETs on the session's own account (members, roles, usage), keyed on `on_behalf_of_user_id`, refused when it is null.
2. Writes as held actions: an account write from a session token is never executed. The API stores it as a pending action and answers `202 { approval_id }`. The person approves it in the web app with their own JWT and their MFA. The pattern exists for connector calls (`connectors/held-call-run.ts`, `rebuildHeldCallPrincipal`).
3. A deny list before the super-admin bypass: tokens, project credentials, account delete, super-admin roles, SSO and MFA settings.
4. The My Kortix card for a held action is "needs you" with an Approve button. `kortix_people` and `kortix_usage` (apps/kortix-sandbox-agent-server/src/services/tools/platform/) extend to account scope.

## How to pick it up

Read `auth-scope.ts`, `iam/authorize.ts`, `projects/lib/session-token-grant.ts` and the connector held-call path first. Write the threat model in the PR body. A security review is required before merge.
