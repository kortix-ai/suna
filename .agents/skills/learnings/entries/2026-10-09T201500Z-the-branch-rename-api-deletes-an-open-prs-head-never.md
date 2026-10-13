---
recorded: 2026-10-09T20:15:00Z
incident_date: 2026-10-09
---
# The branch-rename REST API deletes an open PR's head ref — never rename a branch that is an open PR's head

**Rule:** Never call `POST /repos/{owner}/{repo}/branches/{name}/rename` on a branch that is the head of an open pull request. The endpoint moves the ref but does not re-point the PR: GitHub records `closed` + `head_ref_deleted` on the PR within a second and auto-closes it. Rename before opening the PR, or leave the branch name as-is (the PR's own title/body carry the issue identifier).

**Trigger surface:** Any GitHub REST call of `branches/<name>/rename`, in scripts or sessions, on a repo where PRs are open against working branches.

**Incident:** 2026-10-09, kortix-ai/suna PR #9442. Renaming `supabase-pool-ceiling` to `supabase-pool-ceiling-KRTX-2020` while the PR was open closed it instantly (`closed` and `head_ref_deleted` events, both authored by the API identity, 20:03:23Z). Recovery was three steps: re-create the old ref at the pre-rename SHA (`POST /repos/{o}/{r}/git/refs` — the SHA must be one GitHub already knows; a local-only commit answers "Object does not exist"), then `PATCH /pulls/<n>` `state=open`. The PR reopened with its comments, labels, and attachment intact. The renamed branch was left in place as a duplicate of the same commit.

**Enforcement:** None mechanical. The rename endpoint returns `201` with the new branch name — nothing in the response hints at the PR damage. Check `GET /pulls/<n>` `state` immediately after any branch mutation on a PR head branch.
