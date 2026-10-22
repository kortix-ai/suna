---
recorded: 2026-09-28T17:07:37Z
incident_date: 2026-09-28
---
# Test the first session on a newly created project, not only the create call

**Rule:** A project-creation fix is verified only when a session on the new project starts and runs a prompt. Set `managed: true` on a git connection only for a repository in the Kortix managed-git backend: that flag selects the managed-org PAT, and a repository in the account's own GitHub is invisible to it. A forced mirror read runs its own refresh; it never inherits another caller's clone failure.

**Trigger surface:** any route that registers a project (`registerGitHubLinkedProject`, `provision-core.ts`); any change to `getProjectGitRemote`, `resolveProjectGitAuth`, or the mirror refresh lock in `projects/git/mirror.ts`.

**Incident:** 2026-09-28, PR #7445. `POST /projects/create-repo` succeeded after two rounds of fixes, and the first session on the new project failed with `503 git_mirror_unavailable`. create-repo wrote `managed: true`; production sets `MANAGED_GIT_GITHUB_TOKEN`; the mirror cloned the account's repository with the managed-org PAT and GitHub answered `Repository not found`. Every create-repo project, organization or personal, was affected, and project deletion targeted the user's repository. Separately, a forced session read rethrew the failure of the create-time template prebuild's in-flight clone.

**Enforcement:** `git-remote-managed.test.ts`; `e2e-create-repo-starter.test.ts` asserts `managed: false`; `mirror-forced-own-attempt.test.ts`. None yet for create-then-session end to end: a local flow needs a GitHub App, which the local profile excludes.
