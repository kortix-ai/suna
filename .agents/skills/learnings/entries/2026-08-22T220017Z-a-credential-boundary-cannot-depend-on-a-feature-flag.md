---
recorded: 2026-08-22T22:00:17Z
commit: 06db826026
---
# A credential boundary cannot depend on a feature flag

2026-08-22. Session provisioning could advertise a direct upstream Git origin
when `KORTIX_GIT_PROXY` was false. The sandbox daemon then called
`/projects/:id/git/clone-credential`, which returned the raw upstream token.
The proxy path was secure, but an environment flag could restore credential
delivery into every sandbox.

**The rule.** A server-side credential boundary is unconditional. Runtime
clients receive one session credential and a Kortix proxy URL. No feature flag,
compatibility endpoint, or generic authorization-header helper may expose or
attach an upstream credential inside the sandbox.

**The enforcement.** Session provisioning and project serialization always use
`/v1/git/:project.git`. The clone-credential route no longer exists. The daemon
rejects direct network Git origins and builds auth headers only for `/v1/git/`.
Route coverage pins the endpoint removal. Daemon tests pin direct-origin denial.

*Incident:* a sandbox environment audit found four Kortix token aliases and
provider credentials. The Git compatibility path could also return a raw Git
provider token to the sandbox.
