---
recorded: 2026-09-10T14:45:18Z
incident_date: 2026-09-10
commit: c6b9685e30
---
# Intersect session Git ref grants with the effective IAM role

**When:** exposing agent grants to the Git receive-pack ref gate. An explicit
`project.gitops.ref.any` or `.ref.delete` grant narrows the effective identity;
it never replaces that identity's role. Carry the session token and launcher
into `actorForToken` so activated service accounts retain their own ceiling.
*Near-miss:* staging PR #7186 blocked promotion of #7185, which exposed raw
grants and let member-launched sessions request manager ref authority.
*Enforcers:* `ref-scopes.test.ts`, `unit-git-proxy-authz.test.ts`, and real Git
push assertions in `receive-pack-gate.test.ts`.
