---
recorded: 2026-08-25T18:41:46Z
commit: 952e400c54
---
# A refresh never converges a booting runtime; a stub launcher is never spawned

*Incident (2026-08-25, SampleCo):* the session-open refresh (env-sync) ran the
runtime-assets pass during a resume, installing OpenCode 1.18.23 and
restarting it under the boot; and the PATH launcher on two boxes was the
479-byte pnpm postinstall stub, one restart away from a dead session.

**Rules.**
1. `refreshMayConvergeRuntime`: the refresh route schedules a reconcile only
   when OpenCode is serving (`ok`); main.ts owns the post-boot pass.
2. `isStubOpencodeLauncher`: the PATH launcher is skipped when it is (or shims
   to) the postinstall stub; resolution falls through to the managed links.
   Conservative: anything unreadable is not a stub.

*Automation:* `refresh-route.test.ts` (runtime-assets convergence only for a
serving runtime), `opencode-binary.test.ts`.
