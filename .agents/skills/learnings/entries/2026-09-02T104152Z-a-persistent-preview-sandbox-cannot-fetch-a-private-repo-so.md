---
recorded: 2026-09-02T10:41:52Z
incident_date: 2026-09-02
commit: 996c5342a6
---
# A persistent preview sandbox cannot fetch a PRIVATE repo, so the branch env silently freezes on an old commit

**When:** relying on a persistent branch environment (`preview` label,
`deploy-preview.yml`) to reflect what you just pushed.
`tests/src/core/sandbox-preview.ts:97-99` does
`git remote set-url origin https://github.com/<repo>.git` and then
`git fetch --depth=1 origin <ref>` — with NO credential. That only works while
the sandbox happens to hold one, and `kortix-ai/suna` is private: an anonymous
`git ls-remote` inside the box answers
`could not read Username for 'https://github.com'`. Verified in the live pi
sandbox that it has no credential at all — no repo config, no
`~/.gitconfig`, no `~/.git-credentials`, no `GIT_ASKPASS`.
**The failure is SILENT in the worst way.** The deploy step is
`continue-on-error: true`, so the job keeps going, "Point the stable hostname"
never runs, and the environment keeps serving the LAST commit that fetched.
`/v1/health` reports `status: ok` the whole time — it is healthy, just old. Five
consecutive deploys failed this way before it was noticed, and two rounds of
"live verification" in between were actually testing stale code and reported
the OLD behaviour as the current one.
**Rules:** (1) after any preview deploy, assert `/v1/health`'s `commit` EQUALS
the SHA you pushed — a 200 proves the environment is alive, never that it is
current, and this is the same class as the deploy-dev rule about a green
`/health` not being deployment proof; (2) treat a `continue-on-error` deploy
step as a step that WILL fail unnoticed — the run's conclusion is not the
environment's state; (3) a persistent sandbox needs a durable credential, not
whatever it was created with.
**Diagnostic:** the deploy log shows `HEAD is now at <older sha>` followed by
`fatal: could not read Username`, four retries, exit 128 — and the environment
answers healthy on that older sha.
*Incident:* pi.kortix.com frozen on `ef2163ba` while seven later commits sat
pushed and undeployed. Unblocking needs `PREVIEW_MANAGED_GIT_GITHUB_TOKEN` (or
any repo-scoped credential in the box), which requires repo admin.
*Enforcer:* none. A post-deploy assertion that health's `commit` equals the
pushed SHA would have caught it on the first failure instead of the fifth.
