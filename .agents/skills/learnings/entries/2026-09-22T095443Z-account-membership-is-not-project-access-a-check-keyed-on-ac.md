---
recorded: 2026-09-22T09:54:43Z
incident_date: 2026-09-22
commit: a682092ea9
---
# Account membership is not project access — a check keyed on account ownership skips project roles

**When:** writing any credential check that compares a token's account with a
resource's account. `authorizeGitProxy` (`apps/api/src/projects/lib/git.ts`)
evaluated the project role only when a personal token came from a DIFFERENT
account. A token minted in the project's own account skipped the role for clone
and push, so account membership stood in for project access. Once members could
mint their own tokens (#7455, `token.personal.create`), a member with no role on
a project could write its default branch. A unit test pinned the shortcut as
intended ("allowed without an IAM round-trip").

**Rule:** a personal credential is checked against the resource's own role
every time. Account ownership may select WHICH check runs; it never replaces it.
Ask of every early `return ok`: which principal reaches it without a role check?

*Enforcer:* flow `GH-19` (real `git` processes: an account member with no
project role is refused clone and push; a project `member` reads but cannot push
the default branch; `ls-remote` proves the branch unchanged). It fails on the
old code. `unit-git-proxy-authz.test.ts` pins the role check for same-account
tokens.
