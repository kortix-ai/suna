---
recorded: 2026-09-29T09:47:47Z
incident_date: 2026-09-29
---
# Let a newer saved copy replace an earlier one; only a runtime read or a live event is final

**Rule:** Never skip a saved-copy paint because the store "already has messages". Ask what painted them: `hasOnlyCacheSourcedMessages` true means only a saved copy did, and a newer saved copy reconciles into it. Refuse only messages a runtime read, a live event, or an optimistic send produced.

**Trigger surface:** The paint effect in `packages/sdk/src/react/use-session-sync.ts`, `apps/mobile/lib/session/saved-copy.ts`, or any path that hydrates the sync store with `source: 'cache'`, including a copy that arrives in a later effect run (the `mirror` prop going from null to an envelope).

**Incident:** 2026-09-29, dev. A hard reload painted the copy this device kept from an earlier open, and its last message was a prompt several turns old. The saved-history read then answered with the full thread as the `mirror` prop. The effect re-ran, returned early because the store held the kept copy, and the thread stayed stale until the computer woke.

**Enforcement:** `packages/sdk/src/react/use-session-sync-local-copy.test.ts` ("the host's saved copy reconciles into the local one when it arrives after the first paint", "the host's saved copy never replaces a runtime read"), and browser journey 34 ("a reload shows the server's newer saved copy, not only the one this device kept").
