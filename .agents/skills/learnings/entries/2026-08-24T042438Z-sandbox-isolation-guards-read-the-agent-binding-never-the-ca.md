---
recorded: 2026-08-24T04:24:38Z
commit: 83c3bc6936
---
# Sandbox-isolation guards read the agent binding, never the caller's session id

2026-08-24. 43 `backend`-origin sessions in one project were listed in the
sidebar and every `/start` answered 404. `isSessionTargetVisibleToCaller`
narrowed on `callerSessionId`, which `resolveSupabaseAuth` sets to the
Supabase LOGIN session id for every signed-in human — non-null, and never a
Kortix session id — so every human failed the sibling check meant for sandbox
credentials. The same regression had already been fixed for the
manager-override gate and documented in its test; the remedy was not carried
to this guard.

**The rule.** A guard that asks "is this caller a session-bound credential"
reads `boundCredentialSessionId` (`callerKortixSessionId(c)`: null for a
browser JWT, the real id for anything bound). `callerSessionId` cannot answer
that question.

**The enforcement.** `apps/api/src/__tests__/unit-connector-share.test.ts`
pins a human with a login session id passing, a sibling sandbox credential
still blocked, and the own-session credential still allowed.

*Incident:* sampleco project `e7170bf8`, origin counts user 568 / backend 43.
PR #6828.
