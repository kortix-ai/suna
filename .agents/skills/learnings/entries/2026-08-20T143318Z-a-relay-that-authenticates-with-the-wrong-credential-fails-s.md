---
recorded: 2026-08-20T14:33:18Z
commit: 33619d49b6
---
# A relay that authenticates with the wrong credential fails silently, forever

Follow-up rule from the same 2026-08-20 turn-truth work (PR #6664), found only
because the merged fix was verified on deployed dev:

**A non-2xx that the caller merely retries-and-gives-up is indistinguishable
from a feature that was never built.** The new `turn_begin` relay used the
daemon's default token chain (`sandboxRelayContext()`), which prefers
`KORTIX_CLI_TOKEN` — a user/agent PAT — while the route it calls is
sandbox-identity-only. Every relay 403'd, twice, then gave up. On dev the
symptoms were a perfect alibi: opencode emitted the frames, the deployed
binary carried the new symbols, the env was complete, the root check passed,
and a hand-made POST with the sandbox credential returned
`{ok:true,outcome:'adopted'}` — while the ledger held zero rows. This is the
same failure class as the SampleCo turn-end 403s that `r4.ts`'s kind-gate
comment already records; the sibling relay (`relayInitialTurnAcceptedToApi`)
had already established the correct pattern.

**Rules.**
1. When adding a sandbox→API relay, copy the CREDENTIAL choice from the
   nearest sibling of the same kind class, not the generic context helper.
   Sandbox-identity kinds (`turn_accepted`, `turn_abandoned`, `turn_begin`)
   resolve `KORTIX_SANDBOX_TOKEN || KORTIX_TOKEN` explicitly.
2. Never relay a credential you know the route will refuse — skip instead. A
   guaranteed 403 loop is worse than an absent feature: it looks like traffic.
3. **Test the wire, not the call count.** The tests that shipped this asserted
   "a POST happened" against a stubbed server. The test that catches it asserts
   the `Authorization` header. Any test that stubs HTTP must assert the
   credential and the URL, or it is only testing itself.
4. Pin the EVENT WIRING separately from the handler's behavior. A unit test
   that calls the relay directly proves nothing about whether the event that
   should trigger it is dispatched — capture a real frame from the deployed
   runtime and feed it through the real dispatcher.

*Incident:* no outage — the fix was simply inert in production for ~25 minutes
between merge and detection, which is exactly what dev verification is for.
