---
recorded: 2026-11-03T13:55:47Z
incident_date: 2026-11-03
---
# A rotated callback URL strands every box spawned before it: stamp each box with its URL and refuse it after a rotation

**Rule:** A box keeps the callback URL it was created with. When a stack can change that URL (a quick tunnel per `pnpm dev` start, or a watchdog rotation), record the URL on the box row and refuse a delivery to a box of another URL. A box that takes a prompt but cannot reach the API must not look like a box that answered.

**Trigger surface:** Debugging a local session that goes silent after a dev stack restart or tunnel rotation. Adding a value the box reads once at create (an env var, a URL) that a later stack may change. Reading a turn that ended `completed` with a null `message_id`.

**Incident:** 2026-11-03, local stack with cloud sandboxes, found while live-testing the Discord channel (kortix-ai/suna#11572).
- A Discord DM follow-up into a session from an earlier stack run was delivered on the fast path (`open-ready-fast`, `delivered`): the API reaches a box through the provider.
- The box still had the old tunnel in `KORTIX_API_URL`. `platinum.ts` `provisionFromTemplate` sets it once. A start sends no env, and the prompt env sync refreshes only the LLM gateway URL.
- Its connector reply and its turn reports went to the dead tunnel: no reply, `message_id` null, and the reaper settled the turn `completed` about 3.5 min later.
- The person heard nothing. Reproduced after 35 min idle, so idle time is not the cause. A `/new` session answered in 10 s.
- Deployed environments have one stable URL and cannot hit this.

**Enforcement:** `apps/api/src/__tests__/integration-follow-up-delivery.test.ts` ("a box an earlier dev stack created under another quick tunnel"):
- A follow-up to a stamped box of another quick tunnel answers `no-session`.
- A box of the same tunnel, and any box on a stable URL, still take it.

The stamp is `session_sandboxes.config.devTunnelUrl`, from `apps/api/src/platform/dev-tunnel-stamp.ts`. The guard is in `continueSession`. A channel then starts the conversation over in a new session on a new box.
