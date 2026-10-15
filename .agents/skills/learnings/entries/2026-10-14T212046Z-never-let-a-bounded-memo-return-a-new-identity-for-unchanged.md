---
recorded: 2026-10-14T21:20:46Z
incident_date: 2026-10-14
---
# Never let a bounded memo return a new identity for unchanged inputs that a subscribed selector reads

**Rule:** A memo read by a `useSyncExternalStore`/zustand selector returns the same object while its inputs are unchanged. A size bound (LRU) on such a memo must not be the only path to that object: key the identity by the input itself (a `WeakMap` by the store array), and keep any LRU for reuse only.

**Trigger surface:** adding a cache or memo under a store selector (`packages/sdk/src/browser/stores/`, `react/session-transcript-subscription.ts`), or a screen that reads many sessions in one render (sub-agent lists, dashboards).

**Incident:** 2026-10-14, on `dev` since PR #9887. The session context modal reads every sub-agent's thread. With 20+ sub-agents, `buildSessionMessages`' 20-entry LRU evicted the root's rows between reads; the subscribed root selector got a new array each read and React threw "Maximum update depth exceeded". The session page showed "Something went wrong" on opening the modal. Fixed in the PR from `session-log-p5-cli-errors`.

**Enforcement:** `packages/sdk/src/browser/stores/sync-store.test.ts` ("unchanged arrays keep their rows past 20 sessions") and `apps/web/src/features/session/session-context-sub-sessions.test.tsx` (40 sub-agents render and settle).
