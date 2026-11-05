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
