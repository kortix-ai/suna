---
recorded: 2026-08-22T15:28:14Z
incident_date: 2026-08-22
commit: 65c05bb108
---
# A browser retry must wait for the result it is retrying

**When:** retrying a client-rendered page after an eventually consistent write.
`domcontentloaded` does not mean that React consumed the API response. Wait for
the exact response and the final DOM state before the next navigation. A poll
that reloads immediately can abort every successful render itself.
*Near-miss:* PR #6724 failed browser-1 twice while every repeated account read
returned `200`. *Enforcer:* `08-accounts-project-access.spec.ts` waits for the
exact account response and the visible `Members` heading on each attempt.
