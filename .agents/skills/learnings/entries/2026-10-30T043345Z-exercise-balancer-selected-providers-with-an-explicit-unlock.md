---
recorded: 2026-10-30T04:33:45Z
incident_date: 2026-10-30
---
# Exercise balancer-selected providers with an explicit unlocked flag

**Rule:** Test automatic provider failover with both the selected provider and `providerLocked: false`, as project-session creation supplies them.

**Trigger surface:** Provisioning tests or changes to provider-lock precedence.

**Incident:** The v0.14.11 release gate failed on a source tripwire whose fixed-size window no longer included the fallback setting after legitimate Platinum-only constraints were added. The existing runtime test omitted the selected provider and therefore did not cover the original explicit-versus-balanced regression.

**Enforcement:** `session-sandbox.test.ts` exercises the real provisioner with a selected but unlocked provider. Removing the explicit lock override fails this case. The wiring tripwire also retains the drive, volume and residential constraints.
