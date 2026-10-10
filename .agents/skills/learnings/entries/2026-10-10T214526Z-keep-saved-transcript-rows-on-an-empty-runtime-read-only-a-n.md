---
recorded: 2026-10-10T21:45:26Z
incident_date: 2026-10-10
supersedes: 2026-09-26T202929Z-keep-only-a-server-captured-transcript-on-a-device-never-the.md
---
# Keep saved transcript rows on an empty runtime read; only a non-empty read settles them

**Rule:** A runtime read that returns no messages for the saved root settles nothing: keep every provisional saved row (`source: 'cache'`) and its parts, still provisional. Only a non-empty runtime read settles them, by value: it confirms the ids it contains and drops the ones it covers but lacks. This changes the superseded entry's "let the first runtime read drop what it covers and lacks" for the empty read only. Its other rules stay: keep only server envelopes on a device, never the live store, and a stopped turn never paints as running.

**Trigger surface:** Changing `hydrate` in `packages/sdk/src/browser/stores/sync-store.ts` (the `cacheSourcedIds` settle), the saved-copy paint in `useSessionSync`, or any code that treats an empty runtime transcript as proof of an empty conversation.

**Incident:** Found 2026-10-10 in the Session Log Plan review (P0.4). An empty runtime read is evidence that the box lost its state (a recreated sandbox, a wiped harness store), not that the conversation is empty. `hydrate` dropped every provisional saved row on it, so a session with a saved transcript showed an empty conversation. Mobile renders through the same SDK store, so both hosts blanked.

**Enforcement:** `packages/sdk/src/browser/session-sync/server-transcript-mirror.test.ts` ("an empty live transcript keeps every provisional saved message": rows kept, `time.completed` kept, still provisional) and `packages/sdk/src/browser/stores/sync-store.test.ts` ("an empty runtime page keeps cached rows and their parts, still provisional": kept, then settled by a non-empty read). The superseded entry's three SDK enforcers stay green; its mobile test was deleted with mobile's own store in PR #8699.
