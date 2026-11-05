# Workspaces — decisions

## 2026-11-05

**D1 (decided, Marko).** Workspace = the Slack model. 1 workspace = 1 company,
each independent, everything per workspace, billing per workspace. "Project"
leaves the UI, CLI and docs. API and SDK get `workspace` names; `project`
names stay as `@deprecated` aliases. No org layer above workspaces for now.

**D2 (open). The public workspace id.** Proposed: `project_id`.

- `project_id` keys every session URL, SDK call (`useSession(projectId, …)`),
  `KORTIX_PROJECT_ID` in every sandbox (436 references) and the manifest.
  With 1:1, `project_id` names the workspace without ambiguity, and every
  existing link keeps working. The account is reached through
  `projects.account_id`, which is always unique.
- `account_id` would make the id exist before a repo is provisioned, but it
  re-keys the runtime and is ambiguous for the 401 legacy accounts until they
  are split.

**D3 (open). Personal workspace at signup.** Proposed: none, like Slack.
Signup asks "Create a workspace or join one". Today signup bootstraps a
personal account (`apps/api/src/accounts/core/accounts.ts`); 40,618 of them
never got a project.

**D4 (open). The 401 accounts with several projects.** Proposed:

1. Block new second projects (stage 9) first.
2. Split each extra project into its own workspace: a new account with a copy
   of the memberships and roles; the project row and every row that
   denormalizes its `account_id` move to the new account.
3. The most recently opened project keeps the original account, its credits,
   Stripe customer and plan. The split workspaces start on the free plan.
4. The 36 accounts that ever purchased credits are split only after their
   owner chooses the workspace that keeps billing. 0 have an enterprise
   contract.

**D3 (decided, Marko 2026-11-05).** No auto-created account at signup. A new
user sees the existing chooser as "Create a workspace or join one".

**D2, D4 defaults (Marko: "go execute", 2026-11-05).** Workspace id =
`project_id`. Legacy multi-project accounts are grandfathered in PR 1; the
split comes later.

**D5 (open). Does joining a workspace grant access to it?** Today account
membership and project access are separate grants (the account hub's
"Projects" tab manages project access). In a Slack workspace, joining is
access. Proposed: a workspace invite always carries the project grant (role
chosen at invite), and Members shows one list with each person's project role;
a member without a grant shows "No access" with "Grant access". No IAM engine
change, so the 11 accounts with several members and several projects keep
their per-project privacy.

## 2026-11-05 (evening)

**D6 (decided, Marko).** PR #11857 unifies everything end to end, not only the
product: data, API, SDK, CLI and IAM all become "workspace" ("this pr should
fully address it properly e2e").

**D7 (decided, Marko).** Backward compatibility stays permanently: old routes
(`/v1/projects/*`, `/v1/accounts/*`), SDK `Project*`/`Account*` exports, the CLI
`projects` command, `KORTIX_PROJECT_ID` and the old DB names. There is no later
drop step ("all compatibility & backwards comp should stay").

**Constraint (measured 2026-11-05, prod estimates).** 205 tables carry
`account_id` and/or `project_id`; `audit_events` is ~400 GB, `gateway_request_logs`
48 GB, `credit_ledger` 8.6M rows. Rewriting id values on those tables is not
feasible in one release; the identity design must avoid it.

**Defaults taken (Marko may veto).** Project name wins in the account-name
backfill (old names kept in a backup table). The 401 multi-project accounts are
split automatically: the most recently opened project keeps the account, its
credits and subscription; every move is logged and reversible. The 40,618 empty
accounts stay as dormant records.
